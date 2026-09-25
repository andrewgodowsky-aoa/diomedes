/**
 * Review G finding 7: trigger rules read from disk were never re-validated. A hand-edited
 * `settings.json` or project state bypassed the schema, the pattern grammar and the budget
 * (finding 3's exponential patterns came back), and a pattern that is not a regular
 * expression made `new RegExp` throw inside the watch, failing every loop run with a raw
 * `SyntaxError`. Stored rules are now held to the rules API's own schema wherever they are
 * read, and a layer that fails is refused, never trimmed: dropping a rule would silently
 * loosen what someone wrote. The runs it would watch fail closed and say which rule, and the
 * rules read lists the stored layer with the reason, so the person can fix it.
 *
 * Real host: `createApp`, the real Store and RunService, the scripted loop route.
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
import type { Need, Session } from '../shared/types.js';
import type { HarnessRun } from '../shared/harness.js';
import { STREAM_RULE_LIMITS, type StreamRule } from '../shared/stream-rules.js';

let root: string, projectId: string, taskId: string, url: string;
let app: Awaited<ReturnType<typeof createApp>>, server: Server | undefined;
const headers = { 'Content-Type': 'application/json', 'X-Diomedes-Client': '1' };
const store = (): Store => app.locals.store;
const host = (): HarnessHost => app.locals.harness;
const state = () => store().state(projectId);
const settingsFile = () => path.join(root, 'data', 'settings.json');

async function open() {
  app = await createApp({ dataDir: path.join(root, 'data'), projectRoot: path.join(root, 'projects'), reviewerAdapter: null });
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
const project = <T>(route: string, method = 'GET', body?: unknown) => call<T>(`/projects/${projectId}${route}`, method, body);
const rule = (id: string, extra: Partial<StreamRule> & Pick<StreamRule, 'match' | 'intervention'>): StreamRule => ({
  id,
  version: 1,
  enabled: true,
  text: `Rule ${id}.`,
  ...extra,
});

/** A hand edit: the project's stored rules, written past the rules API, then read back from disk. */
async function editProjectRules(rules: unknown[]) {
  await store().locked(async () => {
    (state() as { streamTriggerRules?: unknown[] }).streamTriggerRules = rules;
    await store().persist(state());
  });
  await close();
  await open();
}
/** A hand edit of `settings.json` while the app is closed. */
async function editOrganizationRules(rules: unknown[]) {
  await close();
  const settings = JSON.parse(await fs.readFile(settingsFile(), 'utf8')) as Record<string, unknown>;
  await fs.writeFile(settingsFile(), JSON.stringify({ ...settings, streamTriggerRules: rules }, null, 2));
  await open();
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
const SETTLE_MS = 45_000;
async function settled(runId: string) {
  return vi.waitFor(
    async () => {
      const run = await host().get(projectId, runId);
      expect(['failed', 'cancelled', 'completed']).toContain(run.state);
      return run;
    },
    { timeout: SETTLE_MS },
  );
}
const noToolRan = (run: HarnessRun) =>
  expect(run.steps.filter((step) => step.intent.stepId.startsWith('tool:') && step.attempt > 0)).toEqual([]);

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'diomedes-h16-disk-'));
  await open();
  const created = await store().locked(() => store().createProject('Linen orders'));
  projectId = created.id;
  await fs.writeFile(path.join(created.folder, 'order.md'), 'Order 1182: 100 napkins, 40 tablecloths.\n');
  await fs.writeFile(path.join(created.folder, 'delivery.md'), 'Delivered 94 napkins. Six napkins short.\n');
  taskId = await store().locked(async () => {
    const task = store().createTask(state(), { name: 'Check the linen delivery' });
    await store().persist(state());
    return task.id;
  });
  // settings.json exists once the app has saved it; make sure it does before a test edits it.
  await call('/stream-rules', 'PUT', { protocolVersion: 1, rules: [] });
});
afterEach(async () => {
  vi.restoreAllMocks();
  await close();
  await fs.rm(root, { recursive: true, force: true });
});

describe('review-g finding 8: a rule that applies says which runs it watches', () => {
  test('the resolution for a task names the runs an applied rule governs, not just the requirement', async () => {
    await call('/stream-rules', 'PUT', {
      protocolVersion: 1,
      rules: [rule('writes-held', { match: { kind: 'tool', tool: 'propose_write' }, intervention: 'hold' })],
    });
    const listed = await project<{
      watches: string[];
      resolution: { decisions: { ruleId: string; outcome: string; reason: string }[] };
    }>(`/stream-rules?taskId=${taskId}`);
    expect(listed.data.watches).toEqual(['diomedes-loop', 'external-work']);
    expect(listed.data.resolution.decisions).toEqual([
      expect.objectContaining({
        ruleId: 'writes-held',
        outcome: 'applied',
        reason: 'Governs trigger:writes-held on the tool calls Nectovia runs itself.',
      }),
    ]);
  });
});

describe('review-g finding 7: rules read from disk are re-validated and fail closed', () => {
  test('a project rule hand-edited into a pattern the grammar refuses stops the run before its model is called, naming the rule', async () => {
    // Finding 3's exponential shape: a valid regular expression, refused by the grammar.
    await editProjectRules([
      rule('hand-edited', { match: { kind: 'pattern', pattern: '(a|a)(a|a)(a|a)b', window: 50 }, intervention: 'annotate' }),
    ]);
    const started = await start();
    const run = await settled(started.runId);
    expect(run.state).toBe('failed');
    expect(run.failure?.message).toMatch(
      /^A project trigger rule \(hand-edited\) on disk is not one Nectovia can run: A pattern varies in one place at most/,
    );
    noToolRan(run);
    expect(state().needs.filter((need: Need) => need.sessionId === started.session.id && need.state === 'open')).toEqual([]);
  });

  test('an organization rule whose pattern is not a regular expression fails closed with the same sentence, never a raw SyntaxError', async () => {
    await editOrganizationRules([
      rule('broken', { match: { kind: 'pattern', pattern: 'secret(', window: 40 }, intervention: 'stop' }),
    ]);
    const started = await start();
    const run = await settled(started.runId);
    expect(run.state).toBe('failed');
    expect(run.failure?.message).toMatch(/^An organization trigger rule \(broken\) on disk is not one Nectovia can run: /);
    expect(run.failure?.message).not.toMatch(/SyntaxError|Invalid regular expression/);
    noToolRan(run);
  });

  test('the rules read lists an unreadable layer as stored and says why; a project write waits; an organization write fixes it', async () => {
    // Over the unbounded-pattern budget (finding 6), which the rules API would have refused.
    const heavy = Array.from({ length: STREAM_RULE_LIMITS.unboundedWindow / STREAM_RULE_LIMITS.window + 1 }, (_, index) =>
      rule(`wide-${index}`, { match: { kind: 'pattern', pattern: '.*!', window: STREAM_RULE_LIMITS.window }, intervention: 'annotate' }),
    );
    await editOrganizationRules(heavy);

    const listed = await project<{
      organization: StreamRule[];
      resolution: unknown;
      unreadable?: { authority: string; ruleId: string | null; message: string }[];
    }>(`/stream-rules?taskId=${taskId}`);
    expect(listed.status).toBe(200);
    expect(listed.data.organization.map((item) => item.id)).toEqual(heavy.map((item) => item.id));
    expect(listed.data.resolution).toBeNull();
    expect(listed.data.unreadable).toEqual([
      {
        authority: 'organization',
        ruleId: null,
        message: expect.stringMatching(
          /^An organization trigger rule on disk is not one Nectovia can run: Patterns with \*, \+ or a long repeat may watch 1024 characters in total/,
        ),
      },
    ]);

    // A project rule is judged against the organization's; it waits until those can be read.
    const write = await project<{ code: string; error: string }>('/stream-rules', 'PUT', {
      protocolVersion: 1,
      rules: [rule('note', { match: { kind: 'text', phrase: 'napkins' }, intervention: 'annotate' })],
    });
    expect(write.status).toBe(409);
    expect(write.data.code).toBe('stream_rules_unreadable');
    expect(state().streamTriggerRules ?? []).toEqual([]);

    const fixed = await call('/stream-rules', 'PUT', { protocolVersion: 1, rules: heavy.slice(0, 2) });
    expect(fixed.status, JSON.stringify(fixed.data)).toBe(200);
    const after = await project<{ unreadable?: unknown; resolution: { active: unknown[] } }>(`/stream-rules?taskId=${taskId}`);
    expect(after.data.unreadable).toBeUndefined();
    expect(after.data.resolution.active).toHaveLength(2);
  });
});
