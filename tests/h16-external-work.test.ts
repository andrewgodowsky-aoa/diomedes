/**
 * H16 on an external engine: trigger rules watch the text a Work request streams back, not
 * only work loop runs. Real HTTP through `createApp`, the real EngineService, text route,
 * RunService, Store, H15 supervision and H08 controls; only the Claude Code provider is a
 * fake adapter, which streams its answer in five-character deltas as the CLI streams them
 * and, where the answer says HOLD, keeps the request open until it is stopped.
 *
 * Proven: a phrase is matched while it streams, with its exact span, on the text route's
 * own run and dispatch step; a stop rule stops the Work request mid-stream through H08, in
 * supervision's name, and no proposal is made from it; an answer that streamed nothing is
 * judged whole before it can become a proposal; an Ask is not task work and is not watched.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../server/app.js';
import { EngineService, TESTED_VERSIONS } from '../server/engines/service.js';
import { EngineError } from '../server/engines/process.js';
import type { TextEngineAdapter, TextRequest } from '../server/engines/contract.js';
import { routeContractFor } from '../server/harness/route-contract.js';
import { textRunId } from '../server/harness/text-route.js';
import type { Store } from '../server/store.js';
import type { Need, Session } from '../shared/types.js';
import type { SupervisionRecord } from '../shared/supervision.js';
import type { StreamRule, StreamTriggerView } from '../shared/stream-rules.js';

const model = 'claude-fixture';
const accountRoute = 'claude-code:claude.ai';
const headers = { 'Content-Type': 'application/json', 'X-Diomedes-Client': '1' };
const SETTLE_MS = 45_000;

let root: string, url: string, projectId: string, taskId: string;
let app: Awaited<ReturnType<typeof createApp>>, server: Server | undefined;
/** What the fake provider answers next, and whether it streams it. */
let reply: { text: string; stream: boolean };
/** Set when a held request saw its signal abort. */
let aborted: boolean;
let dispatched: TextRequest[];

const store = (): Store => app.locals.store;
const state = () => store().state(projectId);

function adapter(): TextEngineAdapter {
  return {
    id: 'claude-code',
    contract: routeContractFor('claude-code'),
    inspect: async () => ({
      authentication: 'signed-in',
      accountRoute,
      detail: 'Fixture only',
      models: [{ slug: model, name: model, description: '', efforts: [], defaultEffort: null }],
    }),
    generate: async (input) => {
      dispatched.push(input);
      const { text, stream } = reply;
      const held = text.indexOf('HOLD');
      const streamed = held === -1 ? text : text.slice(0, held);
      if (stream)
        for (let at = 0; at < streamed.length; at += 5) {
          input.onDelta?.(streamed.slice(at, at + 5));
          await new Promise((resolve) => setTimeout(resolve, 1));
        }
      if (held !== -1) {
        await new Promise<void>((resolve) => {
          if (input.signal?.aborted) return resolve();
          input.signal?.addEventListener('abort', () => resolve(), { once: true });
        });
        aborted = true;
        throw new EngineError('CANCELLED', 'The request was stopped.', true);
      }
      return {
        text,
        model,
        version: TESTED_VERSIONS['claude-code'],
        projectId: input.projectId,
        threadId: input.threadId,
        requestId: input.requestId,
      };
    },
  };
}

async function call<T>(route: string, method = 'GET', body?: unknown) {
  const response = await fetch(`${url}/api${route}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, data: (await response.json()) as T };
}
const project = <T>(route: string, method = 'GET', body?: unknown) => call<T>(`/projects/${projectId}${route}`, method, body);
const rule = (id: string, extra: Partial<StreamRule> & Pick<StreamRule, 'match' | 'intervention'>): StreamRule => ({
  id,
  version: 1,
  enabled: true,
  text: `Rule ${id}.`,
  ...extra,
});
async function projectRules(...rules: StreamRule[]) {
  const saved = await project('/stream-rules', 'PUT', { protocolVersion: 1, rules });
  expect(saved.status, JSON.stringify(saved.data)).toBe(200);
}
async function startWork() {
  const started = await project<Session>('/work/start', 'POST', {
    protocolVersion: 1,
    commandId: `work-${Math.random().toString(36).slice(2)}`,
    taskId,
    route: 'claude-code',
    sources: [],
    consent: true,
  });
  expect(started.status, JSON.stringify(started.data)).toBe(200);
  return started.data;
}
const session = (id: string) => state().sessions.find((item) => item.id === id)!;
async function settled(id: string) {
  await vi.waitFor(() => expect(['queued', 'working']).not.toContain(session(id).state), { timeout: SETTLE_MS });
  await store().locked(async () => undefined);
  return structuredClone(session(id));
}
const openNeeds = (sessionId: string) =>
  state().needs.filter((need: Need) => need.sessionId === sessionId && need.state === 'open');
const supervision = (sessionId: string) =>
  project<{ records: SupervisionRecord[]; triggers: StreamTriggerView[] }>(`/supervision?sessionId=${sessionId}`);

const proposal = (summary: string) =>
  JSON.stringify({
    summary,
    changes: [{ path: 'linen-report.md', text: 'Six napkins short.\n', summary: 'The report.' }],
  });

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'diomedes-h16-external-'));
  reply = { text: proposal('Checked the linen order against the delivery.'), stream: true };
  aborted = false;
  dispatched = [];
  const fake = adapter();
  const service = new EngineService(path.join(root, 'engines'), {
    discover: async () => [
      {
        id: 'claude-code',
        name: 'Fixture',
        kind: 'online',
        found: true,
        available: false,
        enabled: false,
        status: 'Installed',
        detail: 'Fixture',
        capabilities: [],
        signIn: 'unknown',
        adapter: 'planned',
        installedVersion: TESTED_VERSIONS['claude-code'],
        location: process.execPath,
        disclosure: [],
      },
    ],
    version: async () => TESTED_VERSIONS['claude-code'],
    adapter: () => fake,
  });
  app = await createApp({
    dataDir: path.join(root, 'data'),
    projectRoot: path.join(root, 'projects'),
    engineService: service,
    reviewerAdapter: null,
  });
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server!.once('listening', resolve));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  expect((await call('/ai/discover', 'POST', { consent: true })).status).toBe(200);
  expect((await call('/ai/check/claude-code', 'POST', {})).status).toBe(200);
  expect((await call('/ai/select', 'POST', { engine: 'claude-code', model })).status).toBe(200);
  projectId = (await call<{ id: string }>('/projects', 'POST', { name: 'Linen orders' })).data.id;
  const shared = await project('/cloud-sharing', 'PUT', {
    expectedVersion: 0,
    routes: ['claude-code'],
    documents: [],
    shareConversationHistory: false,
    shareReviewPackets: false,
  });
  expect(shared.status, JSON.stringify(shared.data)).toBe(200);
  taskId = (await project<{ id: string }>('/tasks', 'POST', { name: 'Check the linen delivery' })).data.id;
});
afterEach(async () => {
  if (server) {
    const closing = server;
    server = undefined;
    try {
      await app.locals.close();
    } finally {
      closing.closeAllConnections();
      await new Promise<void>((resolve, reject) => closing.close((error) => (error ? reject(error) : resolve())));
    }
  }
  await fs.rm(root, { recursive: true, force: true });
});

describe('H16 trigger rules on Work sent to an external engine (Claude Code)', () => {
  test('annotate: a phrase is matched while the answer streams, with its exact span, on the text route’s own run and step', async () => {
    const phrase = 'linen order';
    expect(reply.text.indexOf(phrase) % 5).not.toBe(0);
    await projectRules(rule('linen-note', { match: { kind: 'text', phrase }, intervention: 'annotate' }));
    const started = await startWork();
    await vi.waitFor(() => expect(openNeeds(started.id)).toHaveLength(1), { timeout: SETTLE_MS });

    const { data } = await supervision(started.id);
    expect(data.triggers).toHaveLength(1);
    expect(data.triggers[0]).toMatchObject({
      state: 'recorded',
      firing: {
        rule: { id: 'linen-note', authority: 'project' },
        intervention: 'annotate',
        sessionId: started.id,
        taskId,
        runId: textRunId(projectId, started.id),
        stepId: 'text:dispatch',
        attempt: 1,
        handling: 'recorded',
        match: {
          kind: 'text',
          source: 'stream',
          start: reply.text.indexOf(phrase),
          end: reply.text.indexOf(phrase) + phrase.length,
          excerpt: phrase,
        },
        actor: { kind: 'diomedes', role: 'supervision', mode: 'application' },
      },
    });
    // The run the firing names is the text route's durable run for this Work request.
    const run = await app.locals.harness.get(projectId, textRunId(projectId, started.id));
    expect(run.steps.some((step: { intent: { stepId: string } }) => step.intent.stepId === 'text:dispatch')).toBe(true);
    // Annotate is a record only: the proposal is made and waits for you, unchanged.
    expect(openNeeds(started.id)[0].files).toEqual(['linen-report.md']);
    expect(data.records.filter((record) => record.code === 'rule-trigger')).toEqual([]);
  });

  test('stop: a phrase streamed mid-answer stops the Work request through H08 in supervision’s name, and no proposal is made', async () => {
    reply = {
      text: `${proposal('First I will drop the ledger and then')}HOLD`,
      stream: true,
    };
    await projectRules(
      rule('no-ledger-drops', {
        match: { kind: 'text', phrase: 'drop the ledger' },
        intervention: 'stop',
        text: 'Ledgers are never dropped.',
      }),
    );
    const started = await startWork();
    const after = await settled(started.id);
    expect(after.state).toBe('stopped');
    // The provider's request was held open and saw its signal abort: stopped mid-stream.
    await vi.waitFor(() => expect(aborted).toBe(true), { timeout: SETTLE_MS });
    const needs = openNeeds(started.id);
    expect(needs).toHaveLength(1);
    expect(needs[0].supervision?.code).toBe('rule-trigger');
    expect(needs[0].what).toMatch(
      /^Diomedes paused this run: a project rule \(no-ledger-drops\) matched the streamed text “drop the ledger”/,
    );
    expect(needs.some((need) => need.approval)).toBe(false);
    const { data } = await supervision(started.id);
    const escalated = data.records.find((record) => record.action === 'escalate')!;
    expect(escalated).toMatchObject({ code: 'rule-trigger', control: { control: 'stop', outcome: 'applied' } });
    expect(data.triggers[0]).toMatchObject({ state: 'acted', firing: { intervention: 'stop', runId: textRunId(projectId, started.id) } });
    const receipt = (state().controlReceipts ?? []).find((item) => item.commandId === escalated.control!.commandId)!;
    expect(receipt.requestedBy).toMatchObject({ actor: 'diomedes', via: 'supervision', recordId: escalated.id });
  });

  test('an answer that streamed nothing is judged whole before it can become a proposal', async () => {
    reply = { text: proposal('Checked the linen order against the delivery.'), stream: false };
    await projectRules(rule('linen-note', { match: { kind: 'text', phrase: 'linen order' }, intervention: 'annotate' }));
    const started = await startWork();
    await vi.waitFor(() => expect(openNeeds(started.id)).toHaveLength(1), { timeout: SETTLE_MS });
    const firings = state().streamTriggerFirings ?? [];
    expect(firings).toHaveLength(1);
    expect(firings[0].match).toMatchObject({ kind: 'text', source: 'final-text', excerpt: 'linen order' });
  });

  test('a stop on an answer that streamed nothing refuses it: no proposal is made from it', async () => {
    reply = { text: proposal('I will drop the ledger.'), stream: false };
    await projectRules(rule('no-ledger-drops', { match: { kind: 'text', phrase: 'drop the ledger' }, intervention: 'stop' }));
    const started = await startWork();
    const after = await settled(started.id);
    expect(['stopped', 'failed']).toContain(after.state);
    expect(openNeeds(started.id).some((need) => need.approval)).toBe(false);
    expect(state().needs.some((need) => need.sessionId === started.id && need.approval)).toBe(false);
  });

  test('the resolution says which runs a text rule and a tool rule govern', async () => {
    await projectRules(
      rule('linen-note', { match: { kind: 'text', phrase: 'linen order' }, intervention: 'annotate' }),
      rule('writes-held', { match: { kind: 'tool', tool: 'propose_write' }, intervention: 'hold' }),
    );
    const listed = await project<{ watches: string[]; resolution: { decisions: { ruleId: string; reason: string }[] } }>(
      `/stream-rules?taskId=${taskId}`,
    );
    expect(listed.data.watches).toEqual(['diomedes-loop', 'external-work']);
    expect(Object.fromEntries(listed.data.resolution.decisions.map((item) => [item.ruleId, item.reason]))).toEqual({
      'linen-note':
        'Governs trigger:linen-note on what the model writes in Nectovia work loop runs and in task work on every engine.',
      'writes-held': 'Governs trigger:writes-held on the tool calls Nectovia runs itself.',
    });
  });

  test('an Ask is not task work: its answer is not watched', async () => {
    await projectRules(rule('linen-note', { match: { kind: 'text', phrase: 'linen order' }, intervention: 'annotate' }));
    const thread = await project<{ id: string }>('/threads', 'POST', {});
    expect(thread.status).toBe(201);
    const asked = await project('/ask', 'POST', {
      text: 'What did the linen order say?',
      mode: 'ask',
      route: 'claude-code',
      threadId: thread.data.id,
      consent: true,
    });
    expect(asked.status, JSON.stringify(asked.data)).toBe(200);
    expect(dispatched).toHaveLength(1);
    expect(state().streamTriggerFirings ?? []).toEqual([]);
  });
});
