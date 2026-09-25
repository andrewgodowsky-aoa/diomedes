/**
 * H16 through the real host: `createApp`, the real Store, RunService, bridge,
 * Needs, H08 controls and H15 supervision, on the scripted loop route, which
 * streams its text in five-character chunks the way a provider streams tokens.
 * Rules are written through the API at organization and project authority.
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
import type { HarnessRun } from '../shared/harness.js';
import type { SupervisionRecord } from '../shared/supervision.js';
import type { StreamRule, StreamTriggerView } from '../shared/stream-rules.js';
import { digest } from '../server/harness/policy.js';
import { localHarnessPrincipal } from '../server/harness/bridge.js';

let root: string, projectId: string, taskId: string, url: string;
let app: Awaited<ReturnType<typeof createApp>>, server: Server | undefined;
const headers = { 'Content-Type': 'application/json', 'X-Diomedes-Client': '1' };
const store = (): Store => app.locals.store;
const host = (): HarnessHost => app.locals.harness;
const state = () => store().state(projectId);
const PLAN = '1. Read order.md.\n2. Ask a helper to check delivery.md.\n3. Propose Harness report.md.\n4. Summarise what was done.';

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
async function projectRules(...rules: StreamRule[]) {
  const saved = await project('/stream-rules', 'PUT', { protocolVersion: 1, rules });
  expect(saved.status, JSON.stringify(saved.data)).toBe(200);
}
async function globalRules(...rules: StreamRule[]) {
  const saved = await call('/stream-rules', 'PUT', { protocolVersion: 1, rules });
  expect(saved.status, JSON.stringify(saved.data)).toBe(200);
}

async function start(extra: Record<string, unknown> = {}) {
  const response = await project<{ runId: string; session: Session }>('/loop/start', 'POST', {
    ...extra,
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
async function untilRun(runId: string, expected: HarnessRun['state']) {
  await vi.waitFor(async () => expect((await host().get(projectId, runId)).state).toBe(expected), { timeout: SETTLE_MS });
  await host().bridge.flush();
  return host().get(projectId, runId);
}
const supervision = (sessionId: string) =>
  project<{ records: SupervisionRecord[]; triggers: StreamTriggerView[] }>(`/supervision?sessionId=${sessionId}`);

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'diomedes-h16-'));
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
});
afterEach(async () => {
  vi.restoreAllMocks();
  await close();
  await fs.rm(root, { recursive: true, force: true });
});

describe('H16 stream-time triggers on the scripted loop route', () => {
  test('annotate: a phrase split across streamed chunks is recorded with the rule digest and its exact span, and nothing else happens', async () => {
    const phrase = 'helper to check';
    // Five-character chunks: this phrase starts mid-chunk and spans four of them.
    expect(PLAN.indexOf(phrase) % 5).not.toBe(0);
    const annotate = rule('helper-note', { match: { kind: 'text', phrase }, intervention: 'annotate' });
    await projectRules(annotate);
    const started = await start();
    await answer(await openNeed(started.session.id));
    await untilRun(started.runId, 'completed');

    const { data } = await supervision(started.session.id);
    expect(data.triggers).toHaveLength(1);
    const { firing } = data.triggers[0];
    expect(firing).toMatchObject({
      rule: { id: 'helper-note', version: 1, authority: 'project', digest: digest(annotate), text: 'Rule helper-note.' },
      intervention: 'annotate',
      runId: started.runId,
      stepId: 'model:plan',
      attempt: 1,
      handling: 'recorded',
      match: { kind: 'text', source: 'stream', start: PLAN.indexOf(phrase), end: PLAN.indexOf(phrase) + phrase.length, excerpt: phrase },
      actor: { kind: 'diomedes', role: 'supervision', mode: 'application' },
    });
    expect(data.triggers[0].state).toBe('recorded');
    // Annotate is a record only: supervision acted on nothing, and the plan the model wrote is unchanged.
    expect(data.records.filter((record) => record.code === 'rule-trigger')).toEqual([]);
    const run = await host().get(projectId, started.runId);
    expect((run.steps.find((step) => step.intent.stepId === 'plan')!.intent.input as { text: string }).text).toBe(PLAN);
  });

  test('no false fire across two streams: text that only exists when one stream is joined to the next never matches', async () => {
    // The plan ends "…what was done." and the finish streams "Proposed …": joined they would read "done.Proposed".
    await projectRules(rule('joined', { match: { kind: 'text', phrase: 'done.Proposed' }, intervention: 'annotate' }));
    const started = await start();
    await answer(await openNeed(started.session.id));
    await untilRun(started.runId, 'completed');
    expect((await supervision(started.session.id)).data.triggers).toEqual([]);
  });

  test('hold on a recorded write: it waits at the approval gate with the rule named, and never runs until you answer', async () => {
    await projectRules(
      rule('reports-held', {
        match: { kind: 'tool', tool: 'propose_write', target: 'Harness report.md' },
        intervention: 'hold',
        text: 'Reports are written only after a person reads them.',
      }),
    );
    const started = await start();
    const held = await openNeed(started.session.id);
    expect(held.files).toEqual(['Harness report.md']);
    expect(held.why).toMatch(/^A rule held this before it ran: Reports are written only after a person reads them\./);
    const waiting = await host().get(projectId, started.runId);
    const write = waiting.steps.find((step) => step.intent.name === 'propose_write')!;
    expect(write.state).toBe('waiting_approval');
    expect(write.effects ?? []).toEqual([]);
    const reportPath = path.join(state().project.folder, 'Harness report.md');
    await expect(fs.access(reportPath)).rejects.toThrow();
    let view = (await supervision(started.session.id)).data.triggers;
    expect(view).toHaveLength(1);
    expect(view[0]).toMatchObject({
      state: 'waiting',
      firing: {
        handling: 'held-for-you',
        match: { kind: 'tool', tool: 'propose_write', targets: ['Harness report.md'], intentHash: write.intentHash },
      },
    });

    await answer(held);
    await untilRun(started.runId, 'completed');
    await expect(fs.readFile(reportPath, 'utf8')).resolves.toContain('# Loop report');
    view = (await supervision(started.session.id)).data.triggers;
    // Replays after your answer judged the same intent again and recorded nothing new.
    expect(view).toHaveLength(1);
    expect(view[0].state).toBe('released');
  });

  test('hold on a recorded write, declined: the run is cancelled and nothing was written', async () => {
    await projectRules(rule('reports-held', { match: { kind: 'tool', tool: 'propose_write' }, intervention: 'hold' }));
    const started = await start();
    await answer(await openNeed(started.session.id), 'declined');
    await untilRun(started.runId, 'cancelled');
    await expect(fs.access(path.join(state().project.folder, 'Harness report.md'))).rejects.toThrow();
    expect((await supervision(started.session.id)).data.triggers[0].state).toBe('declined');
  });

  test('hold on an intent the approval gate cannot carry: refused before admission and paused for you, never run', async () => {
    await projectRules(
      rule('orders-held', {
        match: { kind: 'tool', tool: 'read_project_file', target: 'order.md' },
        intervention: 'hold',
        text: 'Order files are read only after a person says so.',
      }),
    );
    const started = await start();
    const run = await untilRun(started.runId, 'cancelled');
    const read = run.steps.find((step) => step.intent.stepId === 'tool:0');
    expect(read?.attempt ?? 0).toBe(0);
    expect(run.steps.some((step) => step.intent.stepId === 'observe:0')).toBe(false);
    const escalation = await openNeed(started.session.id);
    expect(escalation.supervision?.code).toBe('rule-trigger');
    expect(escalation.what).toBe(
      'Diomedes paused this run: a project rule (orders-held) held the proposed read_project_file call: Order files are read only after a person says so',
    );
    const view = (await supervision(started.session.id)).data.triggers;
    expect(view).toHaveLength(1);
    expect(view[0]).toMatchObject({ state: 'acted', firing: { intervention: 'hold', handling: 'handed-to-supervision' } });
    expect(view[0].outcome).toMatch(/^Paused for you before it ran: /);
  });

  test('review-g: a hold on a read the loop hands to a delegate still holds; the helper never reads it', async () => {
    // The parent reads order.md itself and hands delivery.md to a delegate child run, which
    // carries no Session of its own. The rule must reach the child's intent all the same.
    await projectRules(
      rule('delivery-held', {
        match: { kind: 'tool', tool: 'read_project_file', target: 'delivery.md' },
        intervention: 'hold',
        text: 'Delivery notes are read only after a person says so.',
      }),
    );
    const started = await start({ delegate: { route: 'native-fixture' } });
    await vi.waitFor(
      async () => expect(['cancelled', 'waiting', 'completed', 'failed']).toContain((await host().get(projectId, started.runId)).state),
      { timeout: SETTLE_MS },
    );
    await host().bridge.flush();
    const child = await host().get(projectId, `${started.runId}-d1`).catch(() => null);
    // Either the helper never started, or it started and its read was never admitted.
    const read = child?.steps.find((step) => step.intent.kind === 'tool' && step.intent.name === 'read_project_file');
    expect(read?.state ?? 'never', JSON.stringify(read ?? null)).not.toBe('succeeded');
    const firings = state().streamTriggerFirings ?? [];
    expect(firings.map((firing) => [firing.rule.id, firing.runId, firing.sessionId])).toEqual([
      ['delivery-held', `${started.runId}-d1`, started.session.id],
    ]);
    const escalation = await openNeed(started.session.id);
    expect(escalation.supervision?.code).toBe('rule-trigger');
  });

  test('stop on streamed text: supervision pauses the run through H08 Stop and asks you; nothing the plan proposed runs', async () => {
    await globalRules(
      rule('no-summaries', {
        match: { kind: 'text', phrase: 'summarise what' },
        intervention: 'stop',
        text: 'Summaries are written by a person.',
      }),
    );
    const started = await start();
    const run = await untilRun(started.runId, 'cancelled');
    expect(run.steps.some((step) => step.intent.stepId.startsWith('tool:'))).toBe(false);
    const escalation = await openNeed(started.session.id);
    expect(escalation.supervision?.code).toBe('rule-trigger');
    expect(escalation.what).toMatch(/^Diomedes paused this run: an organization rule \(no-summaries\) matched the streamed text “Summarise what”/);
    const { data } = await supervision(started.session.id);
    const firing = data.triggers[0].firing;
    expect(firing).toMatchObject({ intervention: 'stop', handling: 'handed-to-supervision', rule: { authority: 'organization' } });
    const escalated = data.records.find((record) => record.action === 'escalate')!;
    expect(escalated).toMatchObject({ code: 'rule-trigger', control: { control: 'stop', outcome: 'applied' } });
    expect(escalated.evidence.map((item) => item.ref)).toEqual([firing.id]);
    expect(data.triggers[0].state).toBe('acted');
    expect(data.triggers[0].outcome).toMatch(/^Stopped: /);
    const receipt = (state().controlReceipts ?? []).find((item) => item.commandId === escalated.control!.commandId)!;
    expect(receipt.requestedBy).toMatchObject({ actor: 'diomedes', via: 'supervision', recordId: escalated.id });
  });

  test('a stop rule whose escalation is already open on the task still stops the next run before anything it proposed runs', async () => {
    await projectRules(rule('no-summaries', { match: { kind: 'text', phrase: 'Summarise' }, intervention: 'stop' }));
    const first = await start();
    await untilRun(first.runId, 'cancelled');
    await openNeed(first.session.id);
    // The escalation stays open; H15 raises nothing more for this rule on this task while it is.
    const second = await start();
    const run = await vi.waitFor(
      async () => {
        const current = await host().get(projectId, second.runId);
        expect(['failed', 'cancelled']).toContain(current.state);
        return current;
      },
      { timeout: SETTLE_MS },
    );
    expect(run.steps.some((step) => step.intent.stepId.startsWith('tool:'))).toBe(false);
    expect(run.failure?.message ?? run.cancelReason).toMatch(/A rule stopped this run: Rule no-summaries\./);
    expect(state().needs.filter((need) => need.supervision && need.state === 'open')).toHaveLength(1);
  });

  test('review-g: two stop rules firing on one run pause it once and ask the person once', async () => {
    await projectRules(
      rule('no-reading', { match: { kind: 'text', phrase: 'Read order' }, intervention: 'stop' }),
      rule('no-summaries', { match: { kind: 'text', phrase: 'Summarise' }, intervention: 'stop' }),
    );
    const started = await start();
    await untilRun(started.runId, 'cancelled');
    await openNeed(started.session.id);
    await vi.waitFor(() => expect((state().streamTriggerFirings ?? []).length).toBe(2), { timeout: SETTLE_MS });
    await store().locked(async () => undefined);
    const open = state().needs.filter((need) => need.sessionId === started.session.id && need.state === 'open');
    expect(open).toHaveLength(1);
    const stops = (await supervision(started.session.id)).data.records.filter((record) => record.control?.control === 'stop');
    expect(stops).toHaveLength(1);
  });

  test('review-g: a hold on a read an H14 lead hands to a worker still holds; the worker never reads it', async () => {
    await projectRules(
      rule('delivery-held', {
        match: { kind: 'tool', tool: 'read_project_file', target: 'delivery.md' },
        intervention: 'hold',
        text: 'Delivery notes are read only after a person says so.',
      }),
    );
    const started = await start({ team: { worker: {}, advisor: null } });
    await vi.waitFor(
      async () => expect(['cancelled', 'waiting', 'completed', 'failed']).toContain((await host().get(projectId, started.runId)).state),
      { timeout: SETTLE_MS },
    );
    await host().bridge.flush();
    expect((await host().get(projectId, started.runId)).state).toBe('cancelled');
    const firings = state().streamTriggerFirings ?? [];
    expect(firings).toHaveLength(1);
    expect(firings[0]).toMatchObject({ rule: { id: 'delivery-held' }, sessionId: started.session.id });
    expect(firings[0].runId).not.toBe(started.runId);
    const worker = await host().get(projectId, firings[0].runId);
    expect(worker.steps.some((step) => step.intent.name === 'read_project_file' && step.state === 'succeeded')).toBe(false);
  });

  for (const intervention of ['stop', 'hold'] as const)
    test(`review-g: a tool ${intervention} whose escalation is already open on the task still refuses the next run's intent`, async () => {
      await projectRules(
        rule('orders-guarded', { match: { kind: 'tool', tool: 'read_project_file', target: 'order.md' }, intervention }),
      );
      const first = await start();
      await untilRun(first.runId, 'cancelled');
      await openNeed(first.session.id);
      // The escalation stays open, so supervision raises nothing more for this rule on this task.
      const second = await start();
      const run = await vi.waitFor(
        async () => {
          const current = await host().get(projectId, second.runId);
          expect(['failed', 'cancelled']).toContain(current.state);
          return current;
        },
        { timeout: SETTLE_MS },
      );
      const read = run.steps.find((step) => step.intent.stepId === 'tool:0');
      expect(read?.state ?? 'never').not.toBe('succeeded');
      expect(run.steps.some((step) => step.intent.stepId === 'observe:0')).toBe(false);
    });

  test('stop on a proposed tool intent: the intent is refused before admission and the run is paused for you', async () => {
    await projectRules(rule('no-reads', { match: { kind: 'tool', effectClass: ['read'] }, intervention: 'stop' }));
    const started = await start();
    const run = await untilRun(started.runId, 'cancelled');
    const read = run.steps.find((step) => step.intent.stepId === 'tool:0');
    // Never admitted: no attempt was started and nothing was observed.
    expect(read?.attempt ?? 0).toBe(0);
    expect(run.steps.some((step) => step.intent.stepId === 'observe:0')).toBe(false);
    const escalation = await openNeed(started.session.id);
    expect(escalation.supervision?.code).toBe('rule-trigger');
    expect(escalation.what).toMatch(/matched the proposed read_project_file call/);
  });

  test('steer on streamed text: supervision asks the run to correct through H08, with the rule’s exact message, and the run goes on', async () => {
    await projectRules(
      rule('mind-the-count', {
        match: { kind: 'text', phrase: 'read order.md' },
        intervention: 'steer',
        message: 'Count the napkins line by line.',
        text: 'Counts are checked line by line.',
      }),
    );
    const started = await start();
    await answer(await openNeed(started.session.id, (need) => !need.supervision));
    await untilRun(started.runId, 'completed');
    const { data } = await supervision(started.session.id);
    const corrected = data.records.find((record) => record.action === 'correct')!;
    expect(corrected.code).toBe('rule-trigger');
    expect(corrected.message).toBe(
      '[Diomedes supervision] A project rule (mind-the-count) matched the streamed text “Read order.md”: Counts are checked line by line. Count the napkins line by line.',
    );
    // The loop route cannot steer a running turn, so supervision asks H08 to queue the correction,
    // and the route refuses a queued follow-up too. The records say exactly that; nothing claims it was sent.
    expect(corrected.control).toMatchObject({ control: 'queue', outcome: 'refused' });
    const receipt = (state().controlReceipts ?? []).find((item) => item.commandId === corrected.control!.commandId)!;
    expect(receipt).toMatchObject({ control: 'queue', outcome: 'refused', requestedBy: { actor: 'diomedes', via: 'supervision' } });
    expect(data.triggers[0]).toMatchObject({ firing: { intervention: 'steer' }, state: 'refused' });
    expect(data.triggers[0].outcome).toBe(`Correction not sent: ${corrected.control!.detail}`);
  });

  test('authority: a project rule cannot loosen a global rule on the same requirement, and a global rule still fires', async () => {
    await globalRules(
      rule('writes-held', { match: { kind: 'tool', tool: 'propose_write' }, intervention: 'hold', constrains: 'writes' }),
    );
    const loosening = await project<{ error: string; code: string }>('/stream-rules', 'PUT', {
      protocolVersion: 1,
      rules: [rule('writes-noted', { match: { kind: 'tool', tool: 'propose_write' }, intervention: 'annotate', constrains: 'writes' })],
    });
    expect(loosening.status).toBe(409);
    expect(loosening.data).toMatchObject({ code: 'stream_rule_loosens' });
    expect(loosening.data.error).toMatch(/cannot loosen/);
    expect(state().streamTriggerRules ?? []).toEqual([]);
    // Two project rules that contradict on one requirement are refused too.
    const conflicting = await project('/stream-rules', 'PUT', {
      protocolVersion: 1,
      rules: [
        rule('a', { match: { kind: 'text', phrase: 'x' }, intervention: 'annotate', constrains: 'k' }),
        rule('b', { match: { kind: 'text', phrase: 'y' }, intervention: 'stop', constrains: 'k' }),
      ],
    });
    expect(conflicting.status).toBe(409);
    const listed = await project<{ resolution: { active: { authority: string; rule: { id: string } }[] } }>('/stream-rules');
    expect(listed.data.resolution.active.map((item) => `${item.authority}:${item.rule.id}`)).toEqual(['organization:writes-held']);

    const started = await start();
    const need = await openNeed(started.session.id);
    expect(need.why).toMatch(/^A rule held this before it ran/);
    const view = (await supervision(started.session.id)).data.triggers;
    expect(view.map((item) => [item.firing.rule.authority, item.firing.rule.id, item.state])).toEqual([
      ['organization', 'writes-held', 'waiting'],
    ]);
  });

  test('restart: firings and the escalation they raised read back identically from a fresh host on the same data folder', async () => {
    await projectRules(
      rule('helper-note', { match: { kind: 'text', phrase: 'helper' }, intervention: 'annotate' }),
      rule('no-summaries', { match: { kind: 'text', phrase: 'Summarise' }, intervention: 'stop' }),
    );
    const started = await start();
    await untilRun(started.runId, 'cancelled');
    await openNeed(started.session.id);
    const before = (await supervision(started.session.id)).data;
    expect(before.triggers.map((item) => item.firing.rule.id)).toEqual(['helper-note', 'no-summaries']);
    await close();
    await open();
    const after = (await supervision(started.session.id)).data;
    expect(after).toEqual(before);
    expect(state().streamTriggerFirings).toEqual(before.triggers.map((item) => item.firing));
  });
});

describe('H16 holds and remembered approvals', () => {
  /** Start the shipped fixture procedure (format-report) and return its Need once it exists. */
  async function formatReport(): Promise<Need> {
    const session = await host().bridge.startNativeRun(
      projectId,
      null,
      'format-report',
      'Format the shipped fixture.',
      localHarnessPrincipal(projectId),
    );
    await vi.waitFor(() => expect(state().needs.some((need) => need.sessionId === session.id)).toBe(true), {
      timeout: SETTLE_MS,
    });
    return structuredClone(state().needs.find((need) => need.sessionId === session.id)!);
  }

  test('a held write is answered by a person even where a remembered approval would have covered it', async () => {
    const first = await formatReport();
    await answer(first);
    await untilRun(first.harness!.runId, 'completed');
    const remembered = await project('/permissions/remembered', 'POST', { needId: first.id });
    expect(remembered.status, JSON.stringify(remembered.data)).toBe(200);
    // Without a rule, the next identical write is covered by the remembered approval: nobody is asked.
    const covered = await formatReport();
    await untilRun(covered.harness!.runId, 'completed');
    expect(state().needs.find((need) => need.id === covered.id)!.authorization?.kind).toBe('remembered-approval');

    await projectRules(
      rule('reports-held', {
        match: { kind: 'tool', tool: 'propose_write' },
        intervention: 'hold',
        text: 'Every report is read by a person before it is written.',
      }),
    );
    const held = await formatReport();
    const runId = held.harness!.runId;
    // Give a remembered approval every chance to answer it; it must not.
    await host().bridge.flush();
    await new Promise((resolve) => setTimeout(resolve, 250));
    await host().bridge.flush();
    const waiting = state().needs.find((need) => need.id === held.id)!;
    expect(waiting.state).toBe('open');
    expect(waiting.authorization).toBeUndefined();
    expect(waiting.why).toMatch(/^A rule held this before it ran: Every report is read by a person/);
    expect((await host().get(projectId, runId)).state).toBe('waiting');
    await answer(waiting);
    await untilRun(runId, 'completed');
  });
});

describe('H16 organization rules and ordinary settings saves', () => {
  test('a settings save that echoes the whole object is accepted, and cannot change the rules; only the rules route writes them', async () => {
    await globalRules(rule('writes-held', { match: { kind: 'tool', tool: 'propose_write' }, intervention: 'hold' }));
    const current = await call<Record<string, unknown>>('/settings');
    expect(current.data.streamTriggerRules).toHaveLength(1);
    const echoed = await call('/settings', 'PUT', { ...current.data, detail: 'technical' });
    expect(echoed.status, JSON.stringify(echoed.data)).toBe(200);
    const emptied = await call('/settings', 'PUT', { streamTriggerRules: [] });
    expect(emptied.status).toBe(200);
    expect(store().settings.streamTriggerRules?.map((item) => item.id)).toEqual(['writes-held']);
    expect(store().settings.detail).toBe('technical');
  });
});
