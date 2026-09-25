/**
 * H16 on Codex Work: trigger rules read the raw deltas the Codex app-server streams. Real
 * HTTP through `createApp`, the real Codex adapter (`createIntegrations`) and a real child
 * process speaking the app-server's JSON-RPC (`tests/fixtures/codex-app-server.mjs`), whose
 * turn streams a preamble and then holds open, as a long turn does.
 *
 * Proven: a steer rule's correction reaches the running Codex turn natively through H08
 * Steer, in supervision's name and with the rule's exact message; a stop rule stops the
 * running turn through H08 Stop before any proposal. Codex Work is not a harness run, so
 * its firings name the Work run's Session (`codex-work-<session>`).
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { ProjectState, Session } from '../shared/types.js';
import type { SupervisionRecord } from '../shared/supervision.js';
import type { StreamRule, StreamTriggerView } from '../shared/stream-rules.js';
import { createApp } from '../server/app.js';
import { createIntegrations, createRpcClient } from '../server/integrations.js';

const FIXTURE = path.resolve('tests/fixtures/codex-app-server.mjs');
const PREAMBLE = 'Reading the menu. I will delete the old prices first.';
const headers = { 'Content-Type': 'application/json', 'X-Diomedes-Client': '1' };
const SETTLE_MS = 45_000;

let server: Server | undefined, app: Awaited<ReturnType<typeof createApp>>;
let temp: string, codexDir: string, url: string, projectId: string, taskId: string;

async function request<T = any>(route: string, method = 'GET', body?: unknown) {
  const response = await fetch(`${url}/api${route}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, data: (await response.json()) as T };
}
const state = async () => (await request<ProjectState>(`/projects/${projectId}/state`)).data;
const sessionOf = async (id: string) => (await state()).sessions.find((item) => item.id === id)!;
/** What the fixture was asked, in order. A capability probe carries no parameters. */
async function calls(): Promise<{ method: string; params: Record<string, unknown> }[]> {
  const text = await fs.readFile(path.join(codexDir, 'calls.jsonl'), 'utf8').catch(() => '');
  return text.split('\n').filter(Boolean).map((line) => JSON.parse(line));
}
const rule = (id: string, extra: Partial<StreamRule> & Pick<StreamRule, 'match' | 'intervention'>): StreamRule => ({
  id,
  version: 1,
  enabled: true,
  text: `Rule ${id}.`,
  ...extra,
});
async function projectRules(...rules: StreamRule[]) {
  const saved = await request(`/projects/${projectId}/stream-rules`, 'PUT', { protocolVersion: 1, rules });
  expect(saved.status, JSON.stringify(saved.data)).toBe(200);
}
async function codexStart() {
  const started = await request<Session>(`/projects/${projectId}/work/start`, 'POST', {
    protocolVersion: 1,
    commandId: crypto.randomUUID(),
    taskId,
    route: 'codex',
    consent: true,
    sources: ['Fall menu.md'],
  });
  expect(started.status, JSON.stringify(started.data)).toBe(200);
  return started.data;
}
const supervision = (sessionId: string) =>
  request<{ records: SupervisionRecord[]; triggers: StreamTriggerView[] }>(
    `/projects/${projectId}/supervision?sessionId=${sessionId}`,
  );

beforeEach(async () => {
  await fs.mkdir(path.join(process.cwd(), 'test-results'), { recursive: true });
  temp = await fs.mkdtemp(path.join(process.cwd(), 'test-results', 'h16-codex-'));
  codexDir = path.join(temp, 'codex');
  await fs.mkdir(codexDir, { recursive: true });
  await fs.writeFile(path.join(codexDir, 'control.json'), JSON.stringify({ hold: true, stream: PREAMBLE }));
  const codex = createIntegrations({
    platform: 'win32',
    verifySandbox: async () => {},
    turnTimeoutMs: 20_000,
    createClient: async () =>
      createRpcClient(
        spawn(process.execPath, [FIXTURE], {
          env: { PATH: process.env.PATH, CODEX_FIXTURE_DIR: codexDir },
          stdio: ['pipe', 'pipe', 'pipe'],
          detached: process.platform !== 'win32',
          windowsHide: true,
        }),
      ),
  });
  app = await createApp({
    dataDir: path.join(temp, 'data'),
    projectRoot: path.join(temp, 'projects'),
    stepMs: 20,
    codexIntegration: codex,
  });
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server!.once('listening', resolve));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  projectId = (await request<{ id: string }>('/projects/sample', 'POST', {})).data.id;
  taskId = (
    await request<{ id: string }>(`/projects/${projectId}/tasks`, 'POST', {
      name: 'Prepare the reopening',
      description: 'Update the menu and write an announcement',
    })
  ).data.id;
  await request('/settings', 'PUT', { services: { codex: true } });
  const shared = await request(`/projects/${projectId}/cloud-sharing`, 'PUT', {
    expectedVersion: 0,
    routes: ['codex'],
    documents: ['Fall menu.md'],
    shareConversationHistory: false,
    shareReviewPackets: false,
  });
  expect(shared.status, JSON.stringify(shared.data)).toBe(200);
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
});

describe('H16 trigger rules on Codex Work', () => {
  test('steer: the correction reaches the running Codex turn natively, with the rule’s exact message, and the run goes on', async () => {
    await projectRules(
      rule('keep-prices', {
        match: { kind: 'text', phrase: 'delete the old prices' },
        intervention: 'steer',
        message: 'Keep the old prices; mark them as previous instead.',
        text: 'Prices are never deleted.',
      }),
    );
    const run = await codexStart();
    const steer = await vi.waitFor(
      async () => {
        const found = (await calls()).find((item) => item.method === 'turn/steer' && item.params.threadId);
        expect(found).toBeDefined();
        return found!;
      },
      { timeout: SETTLE_MS },
    );
    const sent = JSON.stringify(steer.params.input);
    expect(sent).toContain('[Diomedes supervision]');
    expect(sent).toContain('Keep the old prices; mark them as previous instead.');

    const { data } = await supervision(run.id);
    const firing = data.triggers[0].firing;
    expect(firing).toMatchObject({
      rule: { id: 'keep-prices' },
      intervention: 'steer',
      handling: 'handed-to-supervision',
      sessionId: run.id,
      runId: `codex-work-${run.id}`,
      stepId: 'codex:turn',
      match: { kind: 'text', source: 'stream', start: PREAMBLE.indexOf('delete'), excerpt: 'delete the old prices' },
    });
    const corrected = data.records.find((record) => record.action === 'correct')!;
    expect(corrected.control).toMatchObject({ control: 'steer', outcome: 'applied' });
    expect(corrected.evidence.map((item) => item.ref)).toEqual([firing.id]);
    // Steered, the turn completes and the run goes on to its proposal.
    await vi.waitFor(async () => expect(['working', 'queued']).not.toContain((await sessionOf(run.id)).state), {
      timeout: SETTLE_MS,
    });
    expect((await sessionOf(run.id)).state).not.toBe('stopped');
  });

  test('stop: the running Codex turn is stopped through H08 before any proposal, and you are asked', async () => {
    await projectRules(
      rule('keep-prices', { match: { kind: 'text', phrase: 'delete the old prices' }, intervention: 'stop' }),
    );
    const run = await codexStart();
    await vi.waitFor(async () => expect((await sessionOf(run.id)).state).toBe('stopped'), { timeout: SETTLE_MS });
    const current = await state();
    const needs = current.needs.filter((need) => need.sessionId === run.id);
    expect(needs.filter((need) => need.approval)).toEqual([]);
    const open = needs.filter((need) => need.state === 'open');
    expect(open).toHaveLength(1);
    expect(open[0].supervision?.code).toBe('rule-trigger');
    const { data } = await supervision(run.id);
    expect(data.records.find((record) => record.action === 'escalate')?.control).toMatchObject({
      control: 'stop',
      outcome: 'applied',
    });
    expect((await calls()).some((item) => item.method === 'turn/steer' && item.params.threadId)).toBe(false);
  });
});
