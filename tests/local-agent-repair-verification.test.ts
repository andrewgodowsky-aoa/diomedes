import { createServer, type Server } from 'node:http';
import { createHash } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ModelMessage } from 'ai';
import { createApp } from '../server/app.js';
import { LocalModelRuntime } from '../server/bonsai/runtime.js';
import { LOCAL_MODEL_CONTRACT, respondLocal } from '../server/engines/bonsai.js';
import { readLocalStream } from '../server/engines/local-stream.js';
import type { LoopModelRoutes } from '../server/harness/capabilities/native-loop.js';
import { createTeamPort } from '../server/harness/capabilities/team-loop.js';
import { handoffEventSchema } from '../server/team/handoff-ledger.js';
import type { HarnessHost } from '../server/harness/host.js';
import type { Store } from '../server/store.js';
import type { HarnessRun, Json, ModelRequest, ModelResponse } from '../shared/harness.js';
import { LOCAL_MODEL_ACCOUNT, LOCAL_MODEL_ROUTE } from '../shared/local-model.js';
import { findLocalProfile, localContextBudget, parseLocalModelDescriptor } from '../shared/local-model.js';
import { BONSAI_DESCRIPTOR, BONSAI_FOLDER } from './fixtures/local-model.js';
import type { LoopRunInput } from '../shared/native-loop.js';
import type { TeamConfig } from '../shared/team-delegation.js';
import { BONSAI_MODEL, FixedLocalModel, fakeLocalHost, localAnswerStream, meadowDescriptor,
  MEADOW_FOLDER, MEADOW_MODEL } from './fixtures/local-model.js';

// DIO-257: exercise a real socket. Mock fetch rejection alone does not show that
// a stopped local request releases the HTTP connection. No model is started.
let server: Server | undefined;
let app: Awaited<ReturnType<typeof createApp>> | undefined;
let folder: string | undefined;

afterEach(async () => {
  vi.restoreAllMocks();
  if (app) { await app.locals.close(); app = undefined; }
  const current = server;
  server = undefined;
  if (current) {
    current.closeAllConnections();
    await new Promise<void>((resolve, reject) => current.close(error => error ? reject(error) : resolve()));
  }
  if (folder) await fs.rm(folder, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  folder = undefined;
});

/** Real host and sandbox, scripted models. Stable APIs allow these to run on the pre-repair tree. */
async function completedTeam(partial = false, late?: 'final' | 'tool') {
  const arrived = deferred(), resume = deferred(), returned = deferred();
  const seen: Record<string, Json> = {};
  const cap = localContextBudget(findLocalProfile(parseLocalModelDescriptor(BONSAI_DESCRIPTOR, BONSAI_FOLDER), 'local:full')!).sourceChars;
  const source = partial ? 'a'.repeat(cap - 3) + '\u00E9\u00E9\u{1F600}' + 'x'.repeat(100) + '\nDECISIVE_TAIL_RECORD: present\n'
    : 'a'.repeat(287_200) + '\nDECISIVE_TAIL_RECORD: present\n';
  const outputs = (request: ModelRequest) => request.messages.filter(message => message.role === 'tool');
  const routes: LoopModelRoutes = {
    admit: async (_route, input) => ({ model: input.model ?? 'local:full', accountRoute: input.accountRoute ?? LOCAL_MODEL_ACCOUNT }),
    adapter: async (route, role) => ({
      id: route, version: 'independent-script-v1', contract: LOCAL_MODEL_CONTRACT, destination: 'local',
      capabilities: () => ({ engineId: route, engineVersion: 'fixture', protocolVersion: 'fixture',
        modelCalls: 'enforced', toolCalls: 'enforced', filesystemWrites: 'unsupported', networkEgress: 'enforced',
        approvals: 'unsupported', resumability: 'observed', cancellability: 'observed', checkpointGranularity: 'step', notes: [] }),
      async complete(request) {
        const done = outputs(request);
        let response: ModelResponse;
        if (role.purpose === 'loop') {
          seen.lead = done.map(message => message.output ?? null);
          const steps: ModelResponse[] = [
            { type: 'tool', name: 'assign_workers', input: { tasks: [{ task: 'Read ledger.txt and report the tail.', files: ['ledger.txt'] }] } },
            { type: 'tool', name: 'consult_advisor', input: { question: 'Read ledger.txt and check its tail.' } },
          ];
          response = !request.tools.length ? { type: 'final', text: '1. Ask the worker.\n2. Ask the advisor.\n3. Answer.' }
            : steps[done.length] ?? { type: 'final', text: 'The tail record is present.' };
        } else {
          if (late && role.purpose === 'worker') {
            arrived.resolve();
            await resume.promise; // Deliberately ignores the request's cancellation signal.
            returned.resolve();
            return { response: late === 'final' ? { type: 'final', text: 'Late completed answer' }
              : { type: 'tool', name: 'read_project_file', input: { path: 'ledger.txt' } } };
          }
          if (done.length) seen[role.purpose] = done[0].output!;
          response = done.length ? { type: 'final', text: partial ? 'There are no tail records.' : 'The tail record is present.' }
            : { type: 'tool', name: 'read_project_file', input: { path: 'ledger.txt' } };
        }
        return { response, transcript: { providerId: route, modelId: 'independent-fixture', lineageId: role.runId,
          opaqueRef: `${role.runId}-${request.messages.length}`, prefixHash: `prefix-${request.messages.length}` } };
      },
    }),
  };
  folder = await fs.mkdtemp(path.join(os.tmpdir(), 'local-agent-independent-'));
  app = await createApp({ dataDir: path.join(folder, 'data'), projectRoot: path.join(folder, 'projects'),
    reviewerAdapter: null, automationTickMs: null, loopModelRoutes: routes,
    localModel: { source: new FixedLocalModel(),
      host: fakeLocalHost({ state: 'ready', mode: 'Full', model: BONSAI_MODEL, contextTokens: 131_072 }).host } });
  server = await new Promise<Server>(resolve => {
    const opened = app!.listen(0, '127.0.0.1', () => resolve(opened));
  });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
  async function call<T>(url: string, method = 'GET', body?: unknown): Promise<T> {
    const response = await fetch(`${base}${url}`, { method,
      headers: { 'Content-Type': 'application/json', 'X-Diomedes-Client': '1' },
      body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await response.text();
    expect(response.ok, `${url}: ${response.status} ${text}`).toBe(true);
    return JSON.parse(text) as T;
  }
  const { id: projectId } = await call<{ id: string }>('/projects', 'POST', { name: 'Independent read verification' });
  const store: Store = app.locals.store;
  const host: HarnessHost = app.locals.harness;
  await fs.writeFile(path.join(store.state(projectId).project.folder, 'order.md'), 'Read the ledger.');
  await fs.writeFile(path.join(store.state(projectId).project.folder, 'ledger.txt'), source);
  const policy = await call<{ version: number }>(`/projects/${projectId}/cloud-sharing`);
  await call(`/projects/${projectId}/cloud-sharing`, 'PUT', { expectedVersion: policy.version, routes: [LOCAL_MODEL_ROUTE],
    documents: ['order.md', 'ledger.txt'], shareConversationHistory: false, shareReviewPackets: false });
  const { id: taskId } = await call<{ id: string }>(`/projects/${projectId}/tasks`, 'POST', { name: 'Check the tail' });
  const { runId, session } = await call<{ runId: string; session: { id: string } }>(`/projects/${projectId}/loop/start`, 'POST', {
    protocolVersion: 1, commandId: 'independent-read', taskId, goal: 'Check the ledger tail.',
    route: LOCAL_MODEL_ROUTE, model: 'local:full', accountRoute: LOCAL_MODEL_ACCOUNT, consent: true,
    sources: ['order.md'], team: { scope: ['order.md', 'ledger.txt'], worker: {}, advisor: {} },
  });
  let stoppedChild: string | undefined;
  if (late) {
    await within(arrived.promise, 20_000);
    const children = (await host.list(projectId)).filter(run =>
      (run.input as { parent?: { runId: string } } | null)?.parent?.runId === runId);
    expect(children).toHaveLength(1);
    stoppedChild = children[0].id;
    await call(`/projects/${projectId}/work/${session.id}/stop`, 'POST', {});
    await vi.waitFor(async () => expect((await host.get(projectId, stoppedChild!)).state).toBe('cancelled'));
    resume.resolve();
    await returned.promise;
    await new Promise<void>(resolve => setImmediate(resolve));
  }
  const lead = await vi.waitFor(async () => {
    const run = await host.get(projectId, runId);
    expect(['completed', 'failed', 'cancelled', 'reconcile_required']).toContain(run.state);
    return run;
  }, { timeout: 30_000, interval: 50 });
  expect(lead.state, JSON.stringify(lead.failure)).toBe(late ? 'cancelled' : 'completed');
  return { seen, source, lead, host, projectId, cap, stoppedChild };
}

function readText(value: Json): string | undefined {
  if (!value || typeof value !== 'object') return;
  if (!Array.isArray(value) && typeof value.text === 'string' && value.path === 'ledger.txt') return value.text;
  for (const child of Object.values(value)) {
    const text = readText(child);
    if (text !== undefined) return text;
  }
}

describe('independent regressions through stable app interfaces', () => {
  it.each(['final', 'tool'] as const)('Runtime rejects a late child %s after parent Stop', async kind => {
    const { host, projectId, stoppedChild } = await completedTeam(false, kind);
    const child = await host.get(projectId, stoppedChild!);
    expect(child.state).toBe('cancelled');
    expect(child.result).toBeNull();
    expect(child.steps.filter(step => step.intent.kind === 'tool')).toHaveLength(0);
    expect(child.steps.some(step => step.intent.kind === 'model' && step.state === 'succeeded')).toBe(false);
  }, 45_000);

  it('carries host partial-read evidence through worker and advisor handoffs despite canned absence claims', async () => {
    const { seen, source, lead, projectId, cap } = await completedTeam(true);
    for (const role of ['worker', 'advisor']) {
      const text = readText(seen[role])!;
      expect(text).toHaveLength(cap - 1); // Never split a UTF-16 surrogate pair.
      expect(text).not.toContain('\uFFFD');
    }
    const handoffs = lead.steps.filter(step => ['assign_workers', 'consult_advisor'].includes(step.intent.name ?? ''));
    const saved = JSON.stringify(handoffs.map(step => step.output));
    expect(saved).toContain('readCoverage');
    expect(saved).toContain('partial');
    expect(saved).toContain(`"totalChars":${source.length}`);
    expect(saved).toContain(`"returnedBytes":${Buffer.byteLength(source.slice(0, cap - 1))}`);
    expect(JSON.stringify(seen.lead)).toContain('does not establish absence');
    const ledger = await fs.readFile(path.join(folder!, 'data', 'projects', projectId, 'handoffs.jsonl'), 'utf8');
    expect(ledger).toContain('readCoverage');
    for (const line of ledger.trim().split('\n')) expect(handoffEventSchema.safeParse(JSON.parse(line)).success).toBe(true);
  }, 45_000);

  it.each(['advisor', 'worker'])('the real $0 reads the decisive record after character 24,000', async role => {
    const { seen, source, lead } = await completedTeam();
    const text = readText(seen[role]);
    expect(text).toHaveLength(source.length);
    expect(createHash('sha256').update(text!).digest('hex')).toBe(createHash('sha256').update(source).digest('hex'));
    const handoffs = JSON.stringify(lead.steps.filter(step => ['assign_workers', 'consult_advisor'].includes(step.intent.name ?? '')).map(step => step.output));
    expect(handoffs).toContain('"status":"complete"');
    expect(handoffs).toContain(createHash('sha256').update(source).digest('hex'));
  }, 45_000);

  it('records a local advisor budget longer than the former two-minute cap', async () => {
    const { lead, host, projectId } = await completedTeam();
    const advice = lead.steps.find(step => step.intent.name === 'consult_advisor')?.output as { childRunId: string } | undefined;
    expect(advice?.childRunId).toBeTruthy();
    const child: HarnessRun = await host.get(projectId, advice!.childRunId);
    expect(child.budget.wallMs).toBeGreaterThan(120_000);
    expect(child.budget.modelCalls).toBe(3);
  }, 45_000);

  it('dispatches the lead after advice when completed reasoning is the only overflow', async () => {
    const descriptor = meadowDescriptor();
    descriptor.profiles.Deep.outputTokens = 8_192;
    const runtime = new LocalModelRuntime(new FixedLocalModel(descriptor, MEADOW_FOLDER),
      fakeLocalHost({ state: 'ready', mode: 'Deep', model: MEADOW_MODEL, contextTokens: 131_072 }).host);
    const ledger = 'a'.repeat(287_246);
    const messages: ModelMessage[] = [
      { role: 'user', content: 'Check the ledger.' },
      { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'read-1', toolName: 'read_project_file', input: { path: 'ledger.txt' } }] },
      { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'read-1', toolName: 'read_project_file',
        output: { type: 'json', value: { path: 'ledger.txt', sha: 'snapshot-1', found: true, text: ledger, bytes: ledger.length, truncated: false } } }] },
      { role: 'assistant', content: [{ type: 'reasoning', text: 'Completed reasoning.' }, { type: 'text', text: 'Draft: tail is present.' },
        { type: 'tool-call', toolCallId: 'advice-1', toolName: 'consult_advisor', input: { question: 'Check the draft.' } }] },
      { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'advice-1', toolName: 'consult_advisor',
        output: { type: 'json', value: { outcome: 'completed', text: 'The tail is present.' } } }] },
    ];
    const original = JSON.stringify(messages);
    const sent: Record<string, unknown>[] = [];
    const transport: typeof fetch = async (input, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      if (String(input).endsWith('/apply-template')) return Response.json({ prompt: JSON.stringify(body.messages) });
      if (String(input).endsWith('/tokenize')) return Response.json({
        tokens: Array(String(body.content).includes('reasoning_content') ? 122_689 : 118_800).fill(1),
      });
      sent.push(body);
      return localAnswerStream({ id: 'final-1', model: MEADOW_MODEL,
        choices: [{ finish_reason: 'stop', message: { content: 'The tail is present.' } }],
        usage: { prompt_tokens: 118_800, completion_tokens: 5, total_tokens: 118_805 } });
    };
    const request = { runtime, model: 'local:deep', effort: 'medium', instructions: 'Check the ledger.',
      messages, tools: [], signal: new AbortController().signal, transport, makeRoom: true };
    await expect(respondLocal(request)).resolves.toBeDefined();
    expect(sent).toHaveLength(1);
    expect(JSON.stringify(sent[0].messages)).toContain(ledger);
    expect(JSON.stringify(sent[0].messages)).toContain('Draft: tail is present.');
    expect(JSON.stringify(sent[0].messages)).not.toContain('reasoning_content');
    expect(JSON.stringify(messages)).toBe(original);
  });
});

describe('admitted child deadline on recovery', () => {
  it.each([{ elapsed: 180_000, stopped: false }, { elapsed: 0, stopped: true }])
   ('refuses an expired or stopped saved advisor before adapter construction: $elapsed/$stopped', async ({ elapsed, stopped }) => {
    const role = { agent: { id: 'diomedes.general', version: '1.0.0', name: 'General Assistant', ceiling: 'review' },
      guidance: '', artifact: 'plan.markdown', route: LOCAL_MODEL_ROUTE, model: 'local:deep',
      accountRoute: LOCAL_MODEL_ACCOUNT, profile: null };
    const team: TeamConfig = { v: 1, scope: ['ledger.txt'], worker: { ...role, budget: { turns: 4, tokens: null, wallMs: 300_000 } },
      advisor: role, limits: { depth: 1, concurrentWorkers: 3, workersPerRun: 4, advicePerRun: 2 } };
    const frozenBudget = { turns: 3, tokens: null, wallMs: 120_000 };
    const parent = { id: 'lead', projectId: 'p', tenantId: null, taskId: 't', principal: { capabilities: [] },
      input: { route: LOCAL_MODEL_ROUTE }, steps: [] } as unknown as HarnessRun;
    // This is a persisted active child from an older admission. Current profile rates may change,
    // but they cannot revive its already spent two-minute budget.
    const child = { id: 'lead-a0', projectId: 'p', tenantId: null, taskId: 't', state: 'queued',
      createdAt: new Date(Date.now() - elapsed).toISOString(), endedAt: null, steps: [],
      used: { units: 0, modelCalls: 0, toolCalls: 0 }, failure: null, cancelReason: null, result: null,
      budget: { units: 6, modelCalls: 3, toolCalls: 3, wallMs: frozenBudget.wallMs },
      input: { route: role.route, model: role.model, accountRoute: role.accountRoute, budget: frozenBudget },
    } as unknown as HarnessRun;
    const cancel = vi.fn(async (_id: string, reason: string) => { child.state = 'cancelled'; child.cancelReason = reason; });
    const adapterFor = vi.fn(async () => { throw new Error('An expired child must never construct this adapter.'); });
    const profile = findLocalProfile(parseLocalModelDescriptor(meadowDescriptor(), MEADOW_FOLDER), 'local:deep');
    const dependencies = {
      store: {}, runs: { get: async () => child, claim: async () => {}, cancel },
      ledger: { append: async () => {} }, localProfile: () => profile,
      registry: () => ({ describe: () => [] }), heartbeat: () => () => {},
      admit: async () => ({ model: role.model, accountRoute: role.accountRoute }), adapterFor,
    } as unknown as Parameters<typeof createTeamPort>[0];
    const port = createTeamPort(dependencies).portFor(parent, { team } as LoopRunInput)!;
    const controller = new AbortController();
    if (stopped) controller.abort();
    const result = await port.advise({ parent, stepId: 'advise:0', turn: 0, question: 'Check the ledger.', signal: controller.signal });
    expect(adapterFor).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledOnce();
    expect(result.outcome).toBe('stopped');
    expect(child.budget.wallMs).toBe(120_000);
  });
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

async function within(promise: Promise<void>, milliseconds = 2_000): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('The cancelled connection did not close.')), milliseconds);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

describe('local request cancellation through the HTTP transport', () => {
  it.each([
    { phase: 'before headers', observed: false },
    { phase: 'before headers', observed: true },
    { phase: 'streaming', observed: false },
    { phase: 'streaming', observed: true },
  ])('closes the socket $phase with recorder=$observed', async ({ phase, observed }) => {
    const arrived = deferred(), closed = deferred(), observing = deferred();
    let active = false;
    server = createServer((request, response) => {
      if (request.url === '/successor') {
        response.writeHead(active ? 503 : 200);
        response.end(active ? 'previous request still active' : 'ready');
        return;
      }
      active = true;
      response.on('close', () => { active = false; closed.resolve(); });
      if (phase === 'streaming') {
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.flushHeaders();
        response.write(': response opened\n\n');
      }
      arrived.resolve();
    });
    await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const stop = new AbortController();
    let observer: Promise<void> | undefined;
    const transport: typeof fetch = async (input, init) => {
      const response = await fetch(input, init);
      if (!observed || !response.body) { observing.resolve(); return response; }
      // Reproduce the proof recorder's tee without running the GPU runner.
      const [recorded, application] = response.body.tee();
      observer = (async () => {
        const reader = recorded.getReader();
        observing.resolve();
        try {
          while (!(await reader.read()).done) { /* Record until completion or abort. */ }
        } catch (error) {
          if (!stop.signal.aborted) throw error;
        } finally {
          reader.releaseLock();
        }
      })();
      return new Response(application, { status: response.status, headers: response.headers });
    };
    const pending = readLocalStream({
      url: `${base}/v1/chat/completions`, body: {}, model: 'fixture-local',
      signal: stop.signal, transport, maxResponseBytes: 1_024,
    });
    // Attach the rejection handler before aborting or advancing the server.
    const outcome = pending.then(() => 'completed', () => 'cancelled');
    await within(arrived.promise);
    if (phase === 'streaming') await within(observing.promise);
    stop.abort(new Error('The child was stopped.'));
    expect(await outcome).toBe('cancelled');
    await within(closed.promise);
    if (observer) await within(observer);
    expect(active).toBe(false);
    const successor = await fetch(`${base}/successor`);
    expect(successor.status).toBe(200);
    expect(await successor.text()).toBe('ready');
  });
});
