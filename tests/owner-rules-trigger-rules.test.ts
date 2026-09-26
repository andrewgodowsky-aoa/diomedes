/**
 * 'owner-rules' on H16 (Andrew, 2026-09-25): trigger rules are the owner's, so
 * without the feature they are not evaluated — a watch opens on nothing, a
 * proposed tool step is judged by nothing, and no firing is ever recorded. The
 * rules themselves are kept and listed, with the plan's sentence on the view.
 * A Personal workspace has no business to hold the feature; an embedded host
 * with no accounts passes everything through, exactly like the Agent gate.
 *
 * Real host, scripted loop route, faux cloud: Juniper Street Bakery holds the
 * Business plan (which includes 'owner-rules'), Harbor Hardware holds no plan,
 * and the free account is Personal.
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
import type { ApprovalCommand, Need, Session } from '../shared/types.js';
import type { StreamRule } from '../shared/stream-rules.js';
import { OWNER_RULES_NOT_INCLUDED_REASON } from '../shared/access.js';
import { ControlPlaneClient } from '../server/accounts/client.js';
import type { AccountBackend } from '../server/accounts/backend.js';
import {
  createFauxCloud,
  FAUX_BACKEND_LABEL,
  type FauxCloud,
} from '../services/control-plane/src/faux/cloud.js';
import { FAUX_DEMO_PASSWORD, seedDemo } from '../services/control-plane/src/faux/seed.js';

let root: string, projectId: string, taskId: string, url: string;
let cloud: FauxCloud;
let app: Awaited<ReturnType<typeof createApp>>, server: Server | undefined;
const headers = { 'Content-Type': 'application/json', 'X-Diomedes-Client': '1' };
const store = (): Store => app.locals.store;
const host = (): HarnessHost => app.locals.harness;
const state = () => store().state(projectId);
const PLAN = '1. Read order.md.\n2. Ask a helper to check delivery.md.\n3. Propose Harness report.md.\n4. Summarise what was done.';

async function open(accounts: { backend: AccountBackend } | null) {
  app = await createApp({
    dataDir: path.join(root, 'data'),
    projectRoot: path.join(root, 'projects'),
    reviewerAdapter: null,
    accounts,
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
async function call<T>(route: string, method = 'GET', body?: unknown) {
  const response = await fetch(`${url}/api${route}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, data: (await response.json()) as T };
}
const project = <T>(route: string, method = 'GET', body?: unknown) =>
  call<T>(`/projects/${projectId}${route}`, method, body);

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

interface RulesView {
  organization: StreamRule[];
  project: StreamRule[];
  resolution: { active: unknown[] } | null;
  notIncludedReason: string | null;
}

async function start() {
  const response = await project<{ runId: string; session: Session }>('/loop/start', 'POST', {
    protocolVersion: 1,
    commandId: `loop-${Math.random().toString(36).slice(2)}`,
    taskId,
    goal: 'Compare the order with the delivery and write the report.',
    route: 'native-fixture',
    sources: ['order.md', 'delivery.md'],
  });
  expect(response.status, JSON.stringify(response.data)).toBe(200);
  return response.data;
}
function command(need: Need, resolution: 'go-ahead' | 'declined' = 'go-ahead'): ApprovalCommand {
  return {
    protocolVersion: 1,
    commandId: `decision-${need.id}`,
    resolution,
    proposalDigest: need.approval!.proposalDigest,
    actionDigest: need.approval!.actionDigest,
    baseDigest: need.approval!.baseDigest,
  };
}
// Each wait ends on the run's own record; the bound is a hang guard a loaded Windows runner can meet.
const SETTLE_MS = 45_000;
async function openNeed(sessionId: string, which: (need: Need) => boolean = () => true) {
  await vi.waitFor(
    () => expect(state().needs.some((need) => need.sessionId === sessionId && need.state === 'open' && which(need))).toBe(true),
    { timeout: SETTLE_MS },
  );
  return structuredClone(state().needs.find((need) => need.sessionId === sessionId && need.state === 'open' && which(need))!);
}
async function answer(need: Need, resolution: 'go-ahead' | 'declined' = 'go-ahead') {
  const decided = await project<Need>(`/needs/${need.id}/resolve`, 'POST', command(need, resolution));
  expect(decided.status, JSON.stringify(decided.data)).toBe(200);
}
async function untilRun(runId: string, expected: 'completed' | 'cancelled' | 'failed') {
  await vi.waitFor(async () => expect((await host().get(projectId, runId)).state).toBe(expected), { timeout: SETTLE_MS });
  await host().bridge.flush();
  return host().get(projectId, runId);
}

async function workspace() {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'diomedes-owner-triggers-'));
  cloud = await createFauxCloud({ file: null, passwordIterations: 1_000 });
  await seedDemo(cloud);
  const backend: AccountBackend = {
    client: new ControlPlaneClient('http://faux.local', (req) => cloud.handle(req)),
    view: () => ({ kind: 'faux', label: FAUX_BACKEND_LABEL, url: null, reason: null, signIn: 'password' }),
    close: async () => {},
  };
  await open({ backend });
  const created = await store().locked(() => store().createProject('Linen orders'));
  projectId = created.id;
  await fs.writeFile(path.join(created.folder, 'order.md'), 'Order 1182: 100 napkins, 40 tablecloths.\n');
  await fs.writeFile(path.join(created.folder, 'delivery.md'), 'Delivered 94 napkins. Six napkins short.\n');
  taskId = await store().locked(async () => {
    const task = store().createTask(state(), { name: 'Check the linen delivery' });
    await store().persist(state());
    return task.id;
  });
}
const signIn = (email: string) =>
  call('/account/sign-in', 'POST', { email, password: FAUX_DEMO_PASSWORD, remember: false });

afterEach(async () => {
  vi.restoreAllMocks();
  await close();
  await fs.rm(root, { recursive: true, force: true });
});

describe('trigger rules are the owner’s, so the feature decides whether they run', () => {
  test('Juniper Street Bakery holds the plan: its rule watches the run and fires', async () => {
    await workspace();
    expect((await signIn('owner@juniper.test')).status).toBe(200);
    await projectRules(rule('helper-note', { match: { kind: 'text', phrase: 'helper to check' }, intervention: 'annotate' }));
    const listed = await project<RulesView>(`/stream-rules?taskId=${taskId}`);
    expect(listed.data.notIncludedReason).toBeNull();
    expect(listed.data.resolution!.active).toHaveLength(1);

    const started = await start();
    await answer(await openNeed(started.session.id));
    await untilRun(started.runId, 'completed');
    await vi.waitFor(() => expect((state().streamTriggerFirings ?? []).length).toBe(1), { timeout: SETTLE_MS });
    expect(state().streamTriggerFirings![0].rule.id).toBe('helper-note');
  });

  test('Harbor Hardware holds no plan: the rule stays written, is never evaluated, and the view says why', async () => {
    await workspace();
    expect((await signIn('owner@harbor.test')).status).toBe(200);
    await projectRules(
      rule('helper-note', { match: { kind: 'text', phrase: 'helper to check' }, intervention: 'annotate' }),
      rule('writes-held', {
        match: { kind: 'tool', tool: 'propose_write' },
        intervention: 'hold',
        text: 'Reports are written only after a person reads them.',
      }),
    );
    // The rules are still listed — they are the owner's data — but the view
    // carries the one reason and no resolution claims they watch anything.
    const listed = await project<RulesView>(`/stream-rules?taskId=${taskId}`);
    expect(listed.data.notIncludedReason).toBe(OWNER_RULES_NOT_INCLUDED_REASON);
    expect(listed.data.resolution).toBeNull();
    expect(listed.data.project.map((item) => item.id)).toEqual(['helper-note', 'writes-held']);
    expect(host().streamRules.resolution(projectId, taskId).active).toEqual([]);

    const started = await start();
    // No watch opened on the run's text, and no hold came from the tool rule.
    expect(
      await host().streamRules.watchWork(projectId, started.session.id, { runId: 'w', stepId: 's' }, () => false),
    ).toBeNull();
    await answer(await openNeed(started.session.id));
    await untilRun(started.runId, 'completed');
    expect(state().streamTriggerFirings ?? []).toEqual([]);
    // The write approval a person would always see still asked and was still answered.
    const listedAgain = await project<RulesView>(`/stream-rules?taskId=${taskId}`);
    expect(listedAgain.data.project).toHaveLength(2);
  });

  test('a Personal workspace has no business to hold the feature: same kept rules, same sentence', async () => {
    await workspace();
    expect((await signIn('free@example.test')).status).toBe(200);
    await projectRules(rule('helper-note', { match: { kind: 'text', phrase: 'helper to check' }, intervention: 'annotate' }));
    const listed = await project<RulesView>(`/stream-rules?taskId=${taskId}`);
    expect(listed.data.notIncludedReason).toBe(OWNER_RULES_NOT_INCLUDED_REASON);
    expect(listed.data.resolution).toBeNull();
    // The organization's list answers for the active workspace the same way.
    const globalListed = await call<RulesView>('/stream-rules');
    expect(globalListed.data.notIncludedReason).toBe(OWNER_RULES_NOT_INCLUDED_REASON);
  });

  test('with accounts off nothing is gated: the view resolves and the watch opens', async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'diomedes-owner-triggers-off-'));
    await open(null);
    const created = await store().locked(() => store().createProject('Linen orders'));
    projectId = created.id;
    await fs.writeFile(path.join(created.folder, 'order.md'), 'Order 1182.\n');
    await fs.writeFile(path.join(created.folder, 'delivery.md'), 'Delivered 94.\n');
    taskId = await store().locked(async () => {
      const task = store().createTask(state(), { name: 'Check the linen delivery' });
      await store().persist(state());
      return task.id;
    });
    await projectRules(rule('helper-note', { match: { kind: 'text', phrase: 'helper to check' }, intervention: 'annotate' }));
    const listed = await project<RulesView>(`/stream-rules?taskId=${taskId}`);
    expect(listed.data.notIncludedReason).toBeNull();
    expect(listed.data.resolution!.active).toHaveLength(1);
    const started = await start();
    expect(
      await host().streamRules.watchWork(projectId, started.session.id, { runId: 'w', stepId: 's' }, () => false),
    ).not.toBeNull();
  });
});
