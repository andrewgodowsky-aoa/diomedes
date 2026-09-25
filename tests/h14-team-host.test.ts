/**
 * H14 through the real host: a lead Diomedes loop hands bounded tasks to
 * workers and asks a read-only advisor, with `createApp`, the real Store,
 * RunService, bridge, Needs, recorded writer, H17 verifier, H08 controls and
 * the append-only handoff ledger. The lead runs on the scripted fixture route
 * or on a stub model-API route (`fixtures/team-loop-stub.ts`); nothing here
 * reaches a provider.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../server/app.js';
import type { Store } from '../server/store.js';
import type { HarnessHost } from '../server/harness/host.js';
import type { LoopModelRoutes } from '../server/harness/capabilities/native-loop.js';
import type { ApprovalCommand, Need, Session } from '../shared/types.js';
import type { HarnessRun } from '../shared/harness.js';
import type { LoopOutcome, LoopView } from '../shared/native-loop.js';
import type { TeamLeadView } from '../shared/team-delegation.js';
import type { ControlReceipt } from '../shared/work-control.js';
import { TEAM_STUB_ACCOUNT_ROUTE, TEAM_STUB_REPORTED, pause, teamRoutes, toolResults, type StubLog } from './fixtures/team-loop-stub.js';

let root: string, projectId: string, taskId: string, url: string;
let app: Awaited<ReturnType<typeof createApp>>, server: Server | undefined;
const headers = { 'Content-Type': 'application/json', 'X-Diomedes-Client': '1' };
const store = (): Store => app.locals.store;
const host = (): HarnessHost => app.locals.harness;
const state = () => store().state(projectId);
const ORDER = 'Order 1182: 100 napkins, 40 tablecloths.\n';
const DELIVERY = 'Delivered 94 napkins and 40 tablecloths. Six napkins short.\n';
const INVOICE = 'Invoice 77: 100 napkins billed.\n';

async function open(routes?: LoopModelRoutes) {
  app = await createApp({
    dataDir: path.join(root, 'data'),
    projectRoot: path.join(root, 'projects'),
    reviewerAdapter: null,
    ...(routes ? { loopModelRoutes: routes } : {}),
  });
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server!.once('listening', resolve));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
async function close() {
  if (!server) return;
  const closingApp = app,
    closingServer = server;
  server = undefined;
  try {
    await closingApp.locals.close();
  } finally {
    closingServer.closeAllConnections();
    await new Promise<void>((resolve, reject) => closingServer.close((error) => (error ? reject(error) : resolve())));
  }
}
async function call<T>(route: string, method = 'GET', body?: unknown, base = `/api/projects/${projectId}`) {
  const response = await fetch(`${url}${base}${route}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, data: (await response.json()) as T };
}
const startBody = (overrides: Record<string, unknown> = {}) => ({
  protocolVersion: 1,
  commandId: `team-${Math.random().toString(36).slice(2)}`,
  taskId,
  goal: 'Compare the order with the delivery and the invoice, and write the report.',
  route: 'native-fixture',
  sources: ['order.md', 'delivery.md', 'invoice.md'],
  team: { worker: {}, advisor: {} },
  ...overrides,
});
async function start(overrides: Record<string, unknown> = {}) {
  const response = await call<{ runId: string; session: Session; replayed: boolean }>('/loop/start', 'POST', startBody(overrides));
  expect(response.status, JSON.stringify(response.data)).toBe(200);
  return response.data;
}
function command(need: Need): ApprovalCommand {
  return {
    protocolVersion: 1,
    commandId: `decision-${need.id}`,
    resolution: 'go-ahead',
    proposalDigest: need.approval!.proposalDigest,
    actionDigest: need.approval!.actionDigest,
    baseDigest: need.approval!.baseDigest,
  };
}
async function approve(sessionId: string) {
  await vi.waitFor(() => expect(state().needs.some((need) => need.sessionId === sessionId && need.state === 'open')).toBe(true), {
    timeout: 15_000,
  });
  const need = structuredClone(state().needs.find((item) => item.sessionId === sessionId && item.state === 'open')!);
  const decided = await call<Need>(`/needs/${need.id}/resolve`, 'POST', command(need));
  expect(decided.status, JSON.stringify(decided.data)).toBe(200);
  return need;
}
async function untilRun(runId: string, expected: HarnessRun['state']) {
  await vi.waitFor(async () => expect((await host().get(projectId, runId)).state).toBe(expected), { timeout: 15_000 });
  await host().bridge.flush();
  return host().get(projectId, runId);
}
const loop = (runId: string) =>
  call<{ view: LoopView; outcome: LoopOutcome; team: TeamLeadView | null }>(`/loop/runs/${runId}`);
async function declare(checks: unknown[]) {
  const response = await call(`/tasks/${taskId}/acceptance`, 'PUT', { checks });
  expect(response.status, JSON.stringify(response.data)).toBe(200);
}
async function vertexOn(documents = ['order.md', 'delivery.md', 'invoice.md']) {
  await store().saveSettings({
    ...store().settings,
    services: { ...(store().settings.services ?? {}), 'google-vertex': true, 'google-vertexAccountRoute': TEAM_STUB_ACCOUNT_ROUTE },
  });
  const shared = await call('/cloud-sharing', 'PUT', {
    expectedVersion: state().cloudSharing?.version ?? 0,
    routes: ['google-vertex'],
    documents,
    shareConversationHistory: false,
    shareReviewPackets: false,
  });
  expect(shared.status, JSON.stringify(shared.data)).toBe(200);
}
const ledgerLines = async () =>
  (await fs.readFile(path.join(root, 'data', 'projects', projectId, 'handoffs.jsonl'), 'utf8').catch(() => ''))
    .split('\n')
    .filter(Boolean);

/** A lead on the stub route: plan, then the given tool calls in order, then a final claim. */
function leadScript(steps: { name: string; input: unknown }[]) {
  return (request: Parameters<NonNullable<Parameters<typeof teamRoutes>[0]['loop']>>[0]) => {
    if (!request.tools.length) return { response: { type: 'final' as const, text: '1. Hand the reading to workers.\n2. Summarise.' } };
    const done = toolResults(request).length;
    if (done < steps.length) return { response: { type: 'tool' as const, ...steps[done] } as never };
    return { response: { type: 'final' as const, text: 'Done with what the workers said.' } };
  };
}
/** The feedback the lead's model was sent for each of its tool calls, in order. */
const observed = (view: LoopView) => view.turns.map((turn) => turn.observation);

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'diomedes-h14-team-host-'));
  await open();
  const project = await store().locked(() => store().createProject('Linen orders'));
  projectId = project.id;
  await fs.writeFile(path.join(project.folder, 'order.md'), ORDER);
  await fs.writeFile(path.join(project.folder, 'delivery.md'), DELIVERY);
  await fs.writeFile(path.join(project.folder, 'invoice.md'), INVOICE);
  await fs.writeFile(path.join(project.folder, 'secret.md'), 'Not for workers.\n');
  taskId = await store().locked(async () => {
    const task = store().createTask(state(), { name: 'Check the linen delivery' });
    await store().persist(state());
    return task.id;
  });
});
afterEach(async () => {
  vi.restoreAllMocks();
  await close();
  await fs.rm(root, { recursive: true, force: true });
});

describe('a lead with workers and an advisor on the fixture route', () => {
  test('workers run as their own bounded runs, the advisor advises, and the lead verifies the outcome', async () => {
    await declare([{ id: 'order', kind: 'text-contains', path: 'Harness report.md', text: 'Order 1182' }]);
    const started = await start();
    const need = await approve(started.session.id);
    // Any effect is still the lead's own, through the existing Need.
    expect(need.files).toEqual(['Harness report.md']);
    await untilRun(started.runId, 'completed');
    await vi.waitFor(async () => expect((await loop(started.runId)).data.outcome.state).toBe('verified'), { timeout: 15_000 });
    const { data } = await loop(started.runId);
    expect(data.view.turns.map((turn) => [turn.decision, turn.tool])).toEqual([
      ['tool', 'read_project_file'],
      ['workers', 'assign_workers'],
      ['advice', 'consult_advisor'],
      ['tool', 'propose_write'],
      ['finish', null],
    ]);
    const team = data.team!;
    // Four workers per run, as for any run's delegates (Andrew, 2026-09-24).
    expect(team.limits).toEqual({ depth: 1, concurrentWorkers: 3, workersPerRun: 4, advicePerRun: 2 });
    expect(team.scope).toEqual(['order.md', 'delivery.md', 'invoice.md']);
    expect(team.workers.map((worker) => [worker.scope, worker.outcome, worker.text])).toEqual([
      [['delivery.md'], 'completed', 'delivery.md: Delivered 94 napkins and 40 tablecloths. Six napkins short.'],
      [['invoice.md'], 'completed', 'invoice.md: Invoice 77: 100 napkins billed.'],
    ]);
    for (const worker of team.workers) {
      expect(worker.budget).toEqual({ turns: 4, tokens: null, wallMs: 300_000 });
      expect(worker.used).toMatchObject({ turns: 2, toolCalls: 1, tokens: null });
      expect(worker.agent).toMatchObject({ id: 'diomedes.general' });
      expect(worker.attempt).toBe(1);
      // A worker's answer is a claim: only the lead's declared checks made it verified.
      expect(worker.verification).toEqual({
        state: 'verified',
        sentence: 'Through the lead’s outcome: 1 declared check passed against 1 exact file version.',
      });
      // A fixed local script is no model.
      expect(worker.models).toEqual([]);
    }
    expect(team.advice).toHaveLength(1);
    expect(team.advice[0]).toMatchObject({
      outcome: 'completed',
      agent: { id: 'diomedes.architect', ceiling: 'review' },
      verification: null,
      models: [],
    });
    expect(team.advice[0].text).toContain('Check every figure in the report against order.md');
    const report = await fs.readFile(path.join(state().project.folder, 'Harness report.md'), 'utf8');
    expect(report).toContain('Six napkins short');
    expect(report).toContain('Invoice 77');
    expect(report).toContain('## Advice (not a permission)');

    // Each child is its own harness run: no Session, a budget carved from the lead's, and
    // (Andrew, 2026-09-24) its own sandbox's tools: it reads and writes only its copy.
    const lead = await host().get(projectId, started.runId);
    for (const worker of team.workers) {
      const child = await host().get(projectId, worker.childRunId!);
      expect(child).toMatchObject({ capabilityId: 'diomedes-loop-worker', sessionId: null, taskId });
      expect(child.budget).toEqual({ units: 8, modelCalls: 4, toolCalls: 4, wallMs: 300_000 });
      expect(child.capabilityTools).toEqual(['list_project_files', 'read_project_file', 'write_file', 'propose_file']);
      // Never more authority than the lead.
      expect(child.principal.capabilities.every((item) => lead.principal.capabilities.includes(item))).toBe(true);
    }
    const advisor = await host().get(projectId, team.advice[0].childRunId!);
    expect(advisor.capabilityId).toBe('diomedes-loop-advisor');
    expect(advisor.principal.capabilities).toEqual([]);

    // The ledger holds one opened and one settled line per child, appended.
    const lines = (await ledgerLines()).map((line) => JSON.parse(line) as { kind: string; role: string });
    expect(lines.filter((line) => line.kind === 'opened')).toHaveLength(3);
    expect(lines.filter((line) => line.kind === 'settled')).toHaveLength(3);

    // The Team view lists this lead with the same projection.
    const listed = await call<{ leads: { runId: string; taskName: string; team: TeamLeadView }[] }>('/loop/team');
    expect(listed.data.leads.map((item) => item.runId)).toEqual([started.runId]);
    expect(listed.data.leads[0].team.workers).toHaveLength(2);
  });

  test('scope: a worker cannot be given a file outside the lead’s scope, and a worker reads nothing outside its own', async () => {
    const started = await start({
      sources: ['order.md', 'delivery.md', 'secret.md'],
      team: { scope: ['order.md', 'delivery.md'], worker: {}, advisor: null },
    });
    await approve(started.session.id);
    await untilRun(started.runId, 'completed');
    const { data } = await loop(started.runId);
    const team = data.team!;
    expect(team.workers.map((worker) => [worker.scope, worker.outcome])).toEqual([
      [['delivery.md'], 'completed'],
      [['secret.md'], 'refused'],
    ]);
    expect(team.workers[1].reason).toBe('secret.md is outside what the lead may read, so a worker cannot be given it.');
    expect(team.workers[1].childRunId).toBeNull();
    // The refused assignment never became a run.
    await expect(host().get(projectId, `${started.runId}-w1-1`)).rejects.toThrow();

    // A worker's own readers are bound to its scope.
    const { delegateRegistry } = await import('../server/harness/capabilities/native-loop.js');
    const registry = delegateRegistry(store(), projectId, 'native-fixture', ['delivery.md']);
    const read = registry.get('read_project_file');
    const outside = await read.execute({ input: { path: 'order.md' } } as never);
    expect(outside).toEqual({ path: 'order.md', refused: 'This file is outside what this run may read, so it was not read.' });
    const inside = (await read.execute({ input: { path: 'delivery.md' } } as never)) as { found: boolean };
    expect(inside.found).toBe(true);
    const listed = (await registry.get('list_project_files').execute({ input: {} } as never)) as { files: string[] };
    expect(listed.files).toEqual(['delivery.md']);
  });

  test('scope: a worker under a cloud lead reads only what the project shares with the lead’s route', async () => {
    const { delegateRegistry } = await import('../server/harness/capabilities/native-loop.js');
    const { childReadRoutes } = await import('../server/harness/capabilities/team-loop.js');
    // The worker's answer goes back to its lead, so a local worker under a Google lead is bound to both.
    const routes = childReadRoutes({ input: { route: 'google-vertex' } } as never, 'native-fixture');
    expect(routes).toEqual(['native-fixture', 'google-vertex']);
    expect(childReadRoutes({ input: { route: 'native-fixture' } } as never, 'native-fixture')).toEqual(['native-fixture']);
    await vertexOn(['delivery.md']);
    const registry = delegateRegistry(store(), projectId, routes, null);
    const read = registry.get('read_project_file');
    expect(await read.execute({ input: { path: 'order.md' } } as never)).toEqual({
      path: 'order.md',
      refused: 'This file is not shared with google-vertex, so it was not read.',
    });
    expect(((await read.execute({ input: { path: 'delivery.md' } } as never)) as { found: boolean }).found).toBe(true);
    const listed = (await registry.get('list_project_files').execute({ input: {} } as never)) as { files: string[] };
    expect(listed.files).toEqual(['delivery.md']);
  });

  test('admission: an advisor must be an Agent that never writes, and a budget above the ceiling is refused', async () => {
    const advisor = await call<{ error: string; code: string }>(
      '/loop/start',
      'POST',
      startBody({ team: { worker: {}, advisor: { agentId: 'diomedes.builder' } } }),
    );
    expect(advisor.status).toBe(409);
    expect(advisor.data.error).toBe('Change Builder may change things, so it cannot be an advisor. An advisor only reads.');
    const budget = await call<{ error: string }>('/loop/start', 'POST', startBody({ team: { worker: { budget: { turns: 99 } } } }));
    expect(budget.status).toBe(400);
    expect(budget.data.error).toBe('A worker takes between 1 and 8 turns.');
    expect(state().sessions).toHaveLength(0);
  });
});

describe('budgets, fan-out and authority on a stub model-API route', () => {
  test('a worker cannot ask for more turns than admitted, and one that keeps going is stopped at its budget', async () => {
    await close();
    const log: StubLog = { calls: [] };
    await open(
      teamRoutes(
        {
          loop: leadScript([
            { name: 'assign_workers', input: { tasks: [{ task: 'Read delivery.md', files: ['delivery.md'], turns: 5 }] } },
            { name: 'assign_workers', input: { tasks: [{ task: 'Keep reading delivery.md', files: ['delivery.md'] }] } },
          ]),
          // Never finishes on its own: reads again and again.
          worker: () => ({ response: { type: 'tool', name: 'read_project_file', input: { path: 'delivery.md' } } }),
        },
        log,
      ),
    );
    await vertexOn();
    const started = await start({ route: 'google-vertex', consent: true, team: { worker: { budget: { turns: 3 } } } });
    await untilRun(started.runId, 'completed');
    const { data } = await loop(started.runId);
    const [asked, ran] = observed(data.view);
    // Red on the request: asking for more than the person admitted starts nothing.
    expect(asked).toMatchObject({ action: 'refused', detail: 'This worker asked for 5 turns; its budget allows at most 3.' });
    // Green on the run: the worker that kept going stopped at its own budget; the lead went on.
    expect(ran).toMatchObject({ action: 'workers', ok: false });
    const worker = data.team!.workers.find((item) => item.outcome !== 'refused')!;
    expect(worker.outcome).toBe('stopped');
    expect(worker.sentence).toMatch(/^Stopped at its budget/);
    expect(worker.used?.turns).toBe(3);
    expect(log.calls.filter((entry) => entry.purpose === 'worker')).toHaveLength(3);
  });

  test('a worker is stopped before the call that would pass its reported-token budget', async () => {
    await close();
    await open(
      teamRoutes({
        loop: leadScript([{ name: 'assign_workers', input: { tasks: [{ task: 'Read delivery.md', files: ['delivery.md'] }] } }]),
        worker: () => ({
          response: { type: 'tool', name: 'read_project_file', input: { path: 'delivery.md' } },
          usage: { inputTokens: 500, outputTokens: 100 },
        }),
      }),
    );
    await vertexOn();
    const started = await start({ route: 'google-vertex', consent: true, team: { worker: { budget: { turns: 8, tokens: 1000 } } } });
    await untilRun(started.runId, 'completed');
    const worker = (await loop(started.runId)).data.team!.workers[0];
    expect(worker.outcome).toBe('stopped');
    expect(worker.reason).toBe('budget reached (tokens 1200 of 1000)');
    expect(worker.used).toMatchObject({ turns: 2, tokens: 1200 });
  });

  test('fan-out: at most three workers at once, and they run at the same time; a worker is never offered delegation', async () => {
    await close();
    const log: StubLog = { calls: [] };
    const task = (file: string) => ({ task: `Read ${file}`, files: [file] });
    await open(
      teamRoutes(
        {
          loop: leadScript([
            { name: 'assign_workers', input: { tasks: ['order.md', 'delivery.md', 'invoice.md', 'order.md'].map(task) } },
            { name: 'assign_workers', input: { tasks: ['order.md', 'delivery.md', 'invoice.md'].map(task) } },
          ]),
          worker: async (request, { signal }) => {
            if (!toolResults(request).length) {
              const named = request.messages[0]?.text?.match(/Read (\S+)/)?.[1] ?? 'order.md';
              return { response: { type: 'tool', name: 'read_project_file', input: { path: named } } };
            }
            // Long enough that three calls started together overlap even on a slow runner.
            await pause(1_000, signal);
            return { response: { type: 'final', text: 'read' } };
          },
        },
        log,
      ),
    );
    await vertexOn();
    const started = await start({ route: 'google-vertex', consent: true, team: { worker: {} } });
    await untilRun(started.runId, 'completed');
    const { data } = await loop(started.runId);
    expect(observed(data.view)[0]).toMatchObject({
      action: 'refused',
      detail: 'That asks for 4 workers at once; a lead may run at most 3 at the same time.',
    });
    expect(data.team!.workers.map((worker) => worker.outcome)).toEqual(['completed', 'completed', 'completed']);
    // The three finishing calls overlapped: they ran at once, not one after another.
    const finals = log.calls.filter((entry) => entry.purpose === 'worker' && entry.done !== null && entry.done - entry.at >= 900);
    expect(finals).toHaveLength(3);
    const overlap = Math.min(...finals.map((entry) => entry.done!)) - Math.max(...finals.map((entry) => entry.at));
    expect(overlap).toBeGreaterThan(0);
    for (const worker of data.team!.workers) {
      const child = await host().get(projectId, worker.childRunId!);
      expect(child.capabilityTools).not.toContain('assign_workers');
      expect(child.capabilityTools).not.toContain('delegate');
    }
  });

  test('authority: a worker that tries to write is refused, nothing is written, and its lead stops for a retry', async () => {
    await close();
    await open(
      teamRoutes({
        loop: leadScript([{ name: 'assign_workers', input: { tasks: [{ task: 'Read delivery.md', files: ['delivery.md'] }] } }]),
        worker: () => ({ response: { type: 'tool', name: 'propose_write', input: { text: 'written by a worker' } } }),
      }),
    );
    await vertexOn();
    const started = await start({ route: 'google-vertex', consent: true, team: { worker: {} } });
    const lead = await untilRun(started.runId, 'cancelled');
    const { data } = await loop(started.runId);
    const worker = data.team!.workers[0];
    expect(worker.outcome).toBe('failed');
    expect(worker.reason).toMatch(/Unknown tool for this final model context: propose_write/);
    expect(state().needs).toHaveLength(0);
    await expect(fs.access(path.join(state().project.folder, 'Harness report.md'))).rejects.toThrow();
    expect(data.outcome.label).toBe('Stopped: a worker did not answer');
    expect(lead.steps.some((step) => step.intent.stepId === 'stop:worker' && step.state === 'succeeded')).toBe(true);
  });

  test('advisor: read-only by construction; one that tries to write is refused and the lead goes on', async () => {
    await close();
    await open(
      teamRoutes({
        loop: leadScript([{ name: 'consult_advisor', input: { question: 'Should the report be written now?' } }]),
        advisor: () => ({ response: { type: 'tool', name: 'propose_write', input: { text: 'written by an advisor' } } }),
      }),
    );
    await vertexOn();
    const started = await start({ route: 'google-vertex', consent: true, team: { worker: {}, advisor: {} } });
    await untilRun(started.runId, 'completed');
    const { data } = await loop(started.runId);
    const advice = data.team!.advice[0];
    expect(advice.outcome).toBe('failed');
    expect(advice.reason).toMatch(/Unknown tool for this final model context: propose_write/);
    expect(advice.verification).toBeNull();
    expect(state().needs).toHaveLength(0);
    const child = await host().get(projectId, advice.childRunId!);
    expect(child.capabilityTools).toEqual(['list_project_files', 'read_project_file']);
    expect(child.principal.capabilities).toEqual([]);

    const { assertReadOnly } = await import('../server/harness/capabilities/team-loop.js');
    // A registry that held anything but readers is refused before an advisor run exists.
    const writer = {
      describe: () => [
        { name: 'read_project_file', effect: 'read', permission: null, approval: false, destination: 'local' },
        { name: 'write_something', effect: 'non-idempotent', permission: 'write-project-file', approval: true, destination: 'local' },
      ],
    } as never;
    expect(() => assertReadOnly(writer)).toThrow('An advisor may only read; write_something can do more than that.');
  });

  test('an advisor’s advice is attributed to the model the runtime reported', async () => {
    await close();
    await open(
      teamRoutes({
        loop: leadScript([{ name: 'consult_advisor', input: { question: 'Anything to check?' } }]),
        advisor: () => ({ response: { type: 'final', text: 'Check the napkin count.' } }),
      }),
    );
    await vertexOn();
    const started = await start({ route: 'google-vertex', consent: true, team: { worker: {}, advisor: {} } });
    await untilRun(started.runId, 'completed');
    const advice = (await loop(started.runId)).data.team!.advice[0];
    expect(advice).toMatchObject({ outcome: 'completed', text: 'Check the napkin count.' });
    expect(advice.models).toEqual([{ engine: 'google-vertex', reported: TEAM_STUB_REPORTED, calls: 1 }]);
  });
});

describe('profiles, durability and retry', () => {
  test('a worker runs under its own H09 profile, pinned by revision; a profile that cannot run refuses by name', async () => {
    await close();
    await open(
      teamRoutes({
        worker: (request) =>
          toolResults(request).length
            ? { response: { type: 'final', text: 'delivery.md is six napkins short.' } }
            : { response: { type: 'tool', name: 'read_project_file', input: { path: 'delivery.md' } } },
      }),
    );
    await vertexOn();
    const created = await call<{ profileId: string; revision: number }>(
      '',
      'POST',
      { name: 'Vertex reader', engine: 'google-vertex', model: 'stub-gemini', effort: null, agentId: 'auto', rules: [] },
      '/api/agent-profiles',
    );
    expect(created.status, JSON.stringify(created.data)).toBe(200);
    const profileId = created.data.profileId;
    const started = await start({
      sources: ['order.md', 'delivery.md'],
      consent: true,
      team: { worker: { profileId }, advisor: null },
    });
    await approve(started.session.id);
    await untilRun(started.runId, 'completed');
    const team = (await loop(started.runId)).data.team!;
    expect(team.worker).toMatchObject({ route: 'google-vertex', model: 'stub-gemini', profile: { profileId, revision: 1, name: 'Vertex reader' } });
    expect(team.workers[0]).toMatchObject({
      outcome: 'completed',
      route: 'google-vertex',
      profile: { profileId, revision: 1 },
      text: 'delivery.md is six napkins short.',
    });
    expect(team.workers[0].models).toEqual([{ engine: 'google-vertex', reported: TEAM_STUB_REPORTED, calls: 2 }]);

    await store().saveSettings({ ...store().settings, services: { ...(store().settings.services ?? {}), 'google-vertex': false } });
    const refused = await call<{ error: string; code: string }>(
      '/loop/start',
      'POST',
      startBody({ sources: ['order.md', 'delivery.md'], consent: true, team: { worker: { profileId } } }),
    );
    expect(refused.status).toBe(409);
    expect(refused.data.code).toBe('team_profile_refused');
    expect(refused.data.error).toBe(
      'Vertex reader cannot run: Google Vertex AI is off in Settings > Engines. Fallback is off for this project, so no other profile was tried.',
    );
  });

  test('a worker that fails stops its lead; the record survives a restart; H08 Retry reruns only that worker', async () => {
    await fs.rm(path.join(state().project.folder, 'invoice.md'));
    await declare([{ id: 'invoice', kind: 'text-contains', path: 'Harness report.md', text: 'Invoice 77' }]);
    const first = await start();
    await untilRun(first.runId, 'cancelled');
    await vi.waitFor(() => expect(state().sessions.find((item) => item.id === first.session.id)?.state).toBe('stopped'));
    let { data } = await loop(first.runId);
    expect(data.outcome).toMatchObject({ state: 'stopped-limit', label: 'Stopped: a worker did not answer' });
    expect(data.team!.workers.map((worker) => [worker.scope[0], worker.outcome])).toEqual([
      ['delivery.md', 'completed'],
      ['invoice.md', 'failed'],
    ]);
    expect(data.team!.workers[1].reason).toBe('invoice.md is not in the project.');
    const before = await ledgerLines();

    // A restart: a new host over the same data folder reads the same record back.
    await close();
    await open();
    ({ data } = await loop(first.runId));
    expect(data.team!.workers.map((worker) => [worker.outcome, worker.text])).toEqual([
      ['completed', 'delivery.md: Delivered 94 napkins and 40 tablecloths. Six napkins short.'],
      ['failed', null],
    ]);
    expect(await ledgerLines()).toEqual(before);

    // The person fixes the input and retries the lead through H08.
    await fs.writeFile(path.join(state().project.folder, 'invoice.md'), INVOICE);
    const retried = await call<{ receipt: ControlReceipt }>('/controls', 'POST', {
      protocolVersion: 1,
      commandId: 'retry-team-lead',
      taskId,
      control: 'retry',
      sessionId: first.session.id,
    });
    expect(retried.status, JSON.stringify(retried.data)).toBe(200);
    expect(retried.data.receipt).toMatchObject({
      control: 'retry',
      outcome: 'applied',
      requestedBy: { actor: 'you' },
      performedBy: { kind: 'diomedes' },
      lineage: { kind: 'retry', originSessionId: first.session.id, attempt: 2 },
    });
    expect(retried.data.receipt.detail).toMatch(/Workers that already answered are not run again\.$/);
    const nextSession = retried.data.receipt.result.sessionId!;
    await approve(nextSession);
    const nextRun = (await host().list(projectId)).find((run) => run.sessionId === nextSession)!;
    await untilRun(nextRun.id, 'completed');
    await vi.waitFor(async () => expect((await loop(nextRun.id)).data.outcome.state).toBe('verified'), { timeout: 15_000 });
    const team = (await loop(nextRun.id)).data.team!;
    expect(team.retryOf).toEqual({ runId: first.runId, attempt: 2 });
    const [delivery, invoice] = team.workers;
    // The worker that answered was not run twice; its answer came from attempt 1.
    expect(delivery).toMatchObject({ outcome: 'reused', reusedFrom: `${first.runId}-t1-0` });
    expect(delivery.text).toBe('delivery.md: Delivered 94 napkins and 40 tablecloths. Six napkins short.');
    // The worker that failed ran again, as attempt 2 of the same handoff.
    expect(invoice).toMatchObject({ outcome: 'completed', attempt: 2, retryOf: `${first.runId}-t1-1` });
    expect(invoice.text).toBe('invoice.md: Invoice 77: 100 napkins billed.');
    await expect(host().get(projectId, `${nextRun.id}-w1-0`)).rejects.toThrow();

    // Append-only: every earlier line is still there, byte for byte, ahead of the new ones.
    const after = await ledgerLines();
    expect(after.slice(0, before.length)).toEqual(before);
    expect(after.length).toBeGreaterThan(before.length);
  });

  test('Stop on the lead stops every worker it is waiting for', async () => {
    await close();
    await open(
      teamRoutes({
        loop: leadScript([
          {
            name: 'assign_workers',
            input: { tasks: [{ task: 'Read delivery.md', files: ['delivery.md'] }, { task: 'Read invoice.md', files: ['invoice.md'] }] },
          },
        ]),
        worker: async (_request, { signal }) => {
          await pause(60_000, signal);
          return { response: { type: 'final', text: 'never' } };
        },
      }),
    );
    await vertexOn();
    const started = await start({ route: 'google-vertex', consent: true, team: { worker: {} } });
    // The stub lead assigns on its first turn (turn 0).
    const ids = [`${started.runId}-w0-0`, `${started.runId}-w0-1`];
    await vi.waitFor(
      async () => {
        for (const id of ids)
          expect((await host().get(projectId, id)).steps.some((step) => step.intent.stepId === 'model:0' && step.state === 'running')).toBe(true);
      },
      { timeout: 15_000 },
    );
    const stopped = await call<Session>(`/work/${started.session.id}/stop`, 'POST', {});
    expect(stopped.status, JSON.stringify(stopped.data)).toBe(200);
    for (const id of ids) expect((await untilRun(id, 'cancelled')).cancelReason).toBe('the lead that handed it this task was stopped');
    await untilRun(started.runId, 'cancelled');
    const team = (await loop(started.runId)).data.team!;
    expect(team.workers.map((worker) => worker.outcome)).toEqual(['stopped', 'stopped']);
  });
});
