/** Independent Board projection: actual Store, RunService events and H17 verifier; no provider or alternate lifecycle. */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Store, hash } from '../server/store.js';
import { RunService } from '../server/harness/run-service.js';
import { FileRunStore } from '../server/harness/run-store.js';
import { localHarnessPrincipal } from '../server/harness/bridge.js';
import { NATIVE_LOOP } from '../server/harness/capabilities/native-loop.js';
import { projectBoardProgress } from '../server/harness/board-progress.js';
import { createTaskPhaseGate } from '../server/task-phase.js';
import { mintAutomaticWorkRequest } from '../server/automatic-work-admission.js';
import { VerificationService } from '../server/verification/service.js';
import { applicationOrigin, directOrigin } from '../shared/attribution.js';
import { emptyTaskWorkflow } from '../shared/task-workflow.js';
import { verificationOf } from '../shared/verification.js';
import { digest, HarnessError } from '../server/harness/policy.js';
import { agentTeamGrantSchema, isOwnedTeamRun, type OwnedTeamRun } from '../shared/agent-collaboration.js';
import type { HarnessPrincipal, HarnessRun } from '../shared/harness.js';
import type { Need, ProjectState, Session, Task } from '../shared/types.js';

const RUN = 'RautomaticBoard';
const OWNER = 'independent-board-projector';
const TEXT = 'Write the synthetic inventory exceptions report.';
const REPORT = '# Exceptions\n\nB: 8 expected, 6 counted.\n';
const SECRET = 'sk-fixture-never-a-real-credential';
let dir: string, projectId: string, taskId: string;
let store: Store, runs: RunService, principal: HarnessPrincipal;
const state = () => store.state(projectId);
const task = () => state().tasks.find(item => item.id === taskId)!;
const session = () => state().sessions.find(item => item.id === 'SautomaticBoard')!;
const progress = () => state().history.filter(entry => entry.kind === 'task-progress');
const redact = (text: string) => text.split(SECRET).join('[redacted]');

async function project(run?: HarnessRun) {
  const record = run ?? await runs.get(RUN);
  await store.locked(async () => {
    projectBoardProgress({ store, state: state() as unknown as ProjectState, task: task(), session: session(), run: record, redact });
    await store.persist(state());
  });
}

async function complete() {
  await runs.complete(RUN, OWNER, { text: 'A finish claim is not verification.' });
  session().state = 'done';
  session().endedAt = new Date().toISOString();
}

async function verifiedReport(text = REPORT) {
  await store.locked(() => store.writeRecorded(projectId, [{ path: 'exceptions.md', text, expected: null }], {
    actor: 'diomedes', kind: 'changed', taskId, sessionId: session().id, origin: applicationOrigin(),
  }));
  await complete();
  const verifier = new VerificationService(store, null);
  await store.locked(() => verifier.declare(projectId, taskId, { checks: [
    { id: 'exists', kind: 'file-exists', path: 'exceptions.md' },
    { id: 'row', kind: 'text-contains', path: 'exceptions.md', text: '8 expected, 6 counted' },
  ] }));
  await verifier.verify(projectId, session().id, { requestedBy: 'diomedes-loop' });
  return verifier;
}

function ownedRecord(unknownOutcome: boolean, rootRunId = RUN): OwnedTeamRun {
  // Projection-only fixture of an existing validated Team record. Real child Stop
  // and uncertain provider holds are covered through production HTTP in the host suite.
  const createdAt = new Date().toISOString();
  const grant = agentTeamGrantSchema.parse({ v: 1, id: `team-${rootRunId}`, commandId: 'board-team-request',
    projectId, taskId, rootRunId, sources: [{ path: 'inventory.txt', sha256: 'a'.repeat(64) }], maxModelCalls: 6, maxResponses: 1,
    lead: { slotId: 'SboardLead', role: 'lead', agentId: null, createdAt, threadId: 'CboardLead',
      route: 'openrouter', model: 'openai/gpt-6.1-sol', accountRoute: 'openrouter:board-fixture@r1', effort: 'medium', profile: null },
    member: { slotId: 'SboardMember', role: 'member', agentId: null, createdAt, threadId: 'CboardMember',
      route: 'openrouter', model: 'z-ai/glm-5.3-flash', accountRoute: 'openrouter:board-fixture@r1', effort: 'medium', profile: null },
  });
  const record: OwnedTeamRun = { id: `Rowned-${rootRunId}`, slotId: grant.member.slotId, sessionId: null,
    status: 'cancelled', startedAt: createdAt, endedAt: createdAt, summary: null,
    ownership: 'agent-team-response', grant, rootRunId, rootTaskId: taskId, harnessRunId: `Rchild-${rootRunId}`,
    commandId: `child-${rootRunId}`, assignmentTaskId: 'TboardAssignment', assignmentDigest: 'b'.repeat(64),
    requestMessageId: 'MboardRequest', requestDigest: 'c'.repeat(64), replyMessageId: null, result: null,
    parent: { runId: rootRunId, stepId: 'owned-response-wait' }, rootClosed: true, unknownOutcome };
  expect(isOwnedTeamRun(record), 'the projection consumes an actual contract-valid saved record').toBe(true);
  return record;
}

async function cancelPureWait() {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const pending = runs.step(RUN, OWNER, { id: 'owned-response-wait', version: 'v1', kind: 'wait',
    effect: 'pure', destination: 'local', name: 'owned_team_response' }, async () => { await gate; return { response: 'Late local wait answer' }; }, principal);
  const outcome = pending.then(() => ({ succeeded: true }), error => ({ succeeded: false, error }));
  await vi.waitFor(async () => expect((await runs.get(RUN)).steps.at(-1)?.state).toBe('running'));
  await runs.cancel(RUN, 'The person stopped the root while it waited for its owned response.', principal);
  release();
  expect(await outcome).toMatchObject({ succeeded: false });
  const run = await runs.get(RUN);
  expect(run.state).toBe('cancelled');
  expect(run.steps.some(step => step.state === 'reconcile_required' || step.effects?.some(effect => effect.status === 'uncertain'))).toBe(false);
  return run;
}

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'diomedes-independent-board-'));
  store = new Store(path.join(dir, 'data'), path.join(dir, 'projects'));
  await store.init();
  projectId = (await store.locked(() => store.createProject('Synthetic inventory'))).id;
  taskId = await store.locked(async () => {
    const created = store.createTask(state(), { name: 'Inventory exceptions' });
    created.workflow = { ...emptyTaskWorkflow(), continuation: 'full-approval' };
    created.state = 'working';
    const request = mintAutomaticWorkRequest({ projectId, threadId: 'inventory-thread', commandId: 'inventory-request',
      sourceMessageId: 'sm.' + 'a'.repeat(32), mode: 'auto', text: TEXT, sources: [], homeProjectId: null,
      requestDigest: digest({ action: 'message', text: TEXT, mode: 'auto', sources: [] }),
    });
    expect(request, 'the projection consumes the production request format').not.toBeNull();
    created.automaticWork = { request: request!, rootRunId: RUN, rootJobId: 'job-' + 'a'.repeat(40),
      admissionRef: 'synthetic-existing-admission', policyRevision: 'automatic-work-v1' };
    const item: Session = { id: 'SautomaticBoard', taskId: created.id, state: 'working',
      startedAt: new Date().toISOString(), endedAt: null, sample: false, log: [], entryIds: [], needId: null,
      origin: applicationOrigin(), engine: { name: 'diomedes-loop', model: null, worker: 1, branch: null,
        context: null, events: 0, verified: false } };
    state().sessions.push(item);
    created.sessionIds.push(item.id);
    await store.persist(state());
    return created.id;
  });
  principal = localHarnessPrincipal(projectId);
  runs = new RunService(new FileRunStore(path.join(dir, 'runs')));
  await runs.start({ id: RUN, tenantId: 'local', projectId, taskId, sessionId: session().id,
    principal, capability: NATIVE_LOOP, input: { kind: 'diomedes-loop', goal: TEXT },
    budget: { units: 20, modelCalls: 8, toolCalls: 8, wallMs: null } });
  await runs.claim(RUN, OWNER, 60_000);
});

afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }); });

describe('existing Board and History consume durable runtime evidence', () => {
  test('plan/build/review events keep their phase and dedupe by durable run/event cursor', async () => {
    await project();
    await runs.step(RUN, OWNER, { id: 'plan', version: 'v1', kind: 'transform', origin: applicationOrigin() },
      () => ({ items: ['Compare inventory', 'Write exceptions'] }), principal);
    await project();
    const enterPhase = createTaskPhaseGate({ store, runs, run: await runs.get(RUN), owner: OWNER, principal });
    await enterPhase('build');
    await runs.step(RUN, OWNER, { id: 'tool:0', version: 'v1', kind: 'transform', origin: applicationOrigin() },
      () => ({ text: 'B differs by two.' }), principal);
    await project();
    await enterPhase('review');
    await runs.step(RUN, OWNER, { id: 'verification:0', version: 'v1', kind: 'transform', origin: applicationOrigin() },
      () => ({ claim: 'Please review the exceptions.' }), principal);
    await project();
    const notes = progress().map(entry => entry.progress!);
    expect(notes.find(item => item.stepId === 'plan')).toMatchObject({ phase: 'plan', status: 'succeeded' });
    expect(notes.find(item => item.stepId === 'tool:0')).toMatchObject({ phase: 'build', status: 'succeeded' });
    expect(notes.find(item => item.stepId === 'verification:0')).toMatchObject({ phase: 'review', status: 'succeeded' });
    expect(state().history.filter(entry => entry.kind === 'task-handoff')).toHaveLength(2);
    expect((await runs.get(RUN)).steps.filter(step => step.intent.name === 'continue_task_phase')).toHaveLength(2);
    expect(new Set(notes.map(item => `${item.runId}:${item.seq}`)).size).toBe(notes.length);
    const saved = progress().map(entry => entry.id);
    await project();
    expect(progress().map(entry => entry.id)).toEqual(saved);
    expect(task().runtimeProgress).toEqual({ runId: RUN, lastSeq: (await runs.get(RUN)).lastSeq });
  });

  test('a projection delayed until Review reconstructs earlier Plan and Build from durable phase steps', async () => {
    await runs.step(RUN, OWNER, { id: 'model:plan', version: 'v1', kind: 'transform' }, () => ({ text: 'Plan' }), principal);
    const enterPhase = createTaskPhaseGate({ store, runs, run: await runs.get(RUN), owner: OWNER, principal });
    await enterPhase('build');
    await runs.step(RUN, OWNER, { id: 'tool:0', version: 'v1', kind: 'transform' }, () => ({ text: 'Build' }), principal);
    await enterPhase('review');
    await runs.step(RUN, OWNER, { id: 'verification:0', version: 'v1', kind: 'transform' }, () => ({ text: 'Review' }), principal);
    expect(task().workflow!.phase).toBe('review');
    await project();
    const byStep = (stepId: string) => progress().find(entry => entry.progress!.stepId === stepId)?.progress;
    expect(byStep('model:plan')).toMatchObject({ phase: 'plan', status: 'succeeded' });
    expect(byStep('tool:0')).toMatchObject({ phase: 'build', status: 'succeeded' });
    expect(byStep('verification:0')).toMatchObject({ phase: 'review', status: 'succeeded' });
    const ids = progress().map(entry => entry.id);
    await project();
    expect(progress().map(entry => entry.id)).toEqual(ids);
  });

  test('a restart or interrupted projection adds missing notes once and preserves their IDs', async () => {
    await runs.step(RUN, OWNER, { id: 'plan', version: 'v1', kind: 'transform' }, () => ({ text: 'Plan' }), principal);
    await project();
    const ids = progress().map(entry => entry.id);
    delete task().runtimeProgress;
    await store.persist(state());
    store = new Store(path.join(dir, 'data'), path.join(dir, 'projects'));
    await store.init();
    runs = new RunService(new FileRunStore(path.join(dir, 'runs')));
    await project();
    expect(progress().map(entry => entry.id)).toEqual(ids);
    expect(task().runtimeProgress!.lastSeq).toBe((await runs.get(RUN)).lastSeq);
  });

  test('a failed step records the exact safe error and a failed run never claims success', async () => {
    const failed = new HarnessError('fixture_failed', `Provider refused the request ${SECRET}`);
    await expect(runs.step(RUN, OWNER, { id: 'model:0', version: 'v1', kind: 'transform',
      origin: directOrigin({ engine: 'openrouter', requestedModel: 'synthetic-requested', reportedModel: 'synthetic-reported' }) },
      () => { throw failed; }, principal)).rejects.toMatchObject({ code: 'fixture_failed' });
    await runs.fail(RUN, OWNER, failed);
    await project();
    const note = progress().at(-1)!;
    expect(note.progress!.status).toBe('failed');
    expect(note.progress).toMatchObject({ certainty: 'confirmed', retry: 'new-root-required', error: 'Provider refused the request [redacted]' });
    expect(JSON.stringify(progress())).not.toContain(SECRET);
    expect(progress().some(entry => entry.progress!.status === 'succeeded')).toBe(false);
    expect(task().state).not.toBe('done');
  });

  test('a durable safe retry_wait keeps continue while a terminal failure requires a new root', async () => {
    const definition = { id: 'local-observation:0', version: 'v1', kind: 'transform' as const,
      effect: 'pure' as const, destination: 'local' as const, maxAttempts: 2 };
    await expect(runs.step(RUN, OWNER, definition, () => { throw new HarnessError('local_retry', 'Retry this local observation.'); }, principal))
      .rejects.toMatchObject({ code: 'local_retry' });
    expect((await runs.get(RUN)).steps.at(-1)!.state).toBe('retry_wait');
    await project();
    expect(progress().at(-1)!.progress).toMatchObject({ stepId: 'local-observation:0', status: 'failed',
      certainty: 'confirmed', retry: 'continue', error: 'Retry this local observation.' });
    await runs.step(RUN, OWNER, definition, () => ({ text: 'Local observation succeeded.' }), principal);
    await project();
    expect(progress().at(-1)!.progress).toMatchObject({ status: 'succeeded', certainty: 'confirmed', retry: 'continue' });
    expect((await runs.get(RUN)).steps.at(-1)!.attempt).toBe(2);
  });

  test('a captured unknown event projects reconcile-first and never a confirmed success', async () => {
    // Pure projection fixture, not evidence of provider dispatch. The actual SDK crash/Stop
    // boundary which produces these records is exercised in agent-owned-lifecycle.test.ts.
    const run = await runs.get(RUN), seq = run.lastSeq + 1;
    const snapshot: HarnessRun = { ...run, state: 'reconcile_required', lastSeq: seq,
      events: [...run.events, { v: run.v, runId: RUN, seq, at: new Date().toISOString(),
        type: 'step.reconcile_required', stepId: 'model:0', attributes: { errorCode: 'openrouter_uncertain' } }],
    };
    await project(snapshot);
    const note = progress().find(entry => entry.progress!.seq === seq)!;
    expect(note.progress).toMatchObject({ status: 'uncertain', certainty: 'unknown', retry: 'reconcile-first',
      model: { requested: null, reported: null, source: 'not-recorded' } });
    expect(note.sentence).toContain('unknown outcome');
    expect(note.progress!.status).not.toBe('succeeded');
    expect(task().state).not.toBe('done');
  });

  test('the final real cancellation note keeps a running effect unknown and requires reconciliation', async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const pending = runs.step(RUN, OWNER, { id: 'external-effect:0', version: 'v1', kind: 'tool',
      effect: 'non-idempotent', destination: 'local' }, async () => { await gate; return { text: 'Late claim' }; }, principal);
    // Attach the rejection handler before Stop; there must be no unhandled rejection.
    const outcome = pending.then(() => ({ succeeded: true }), error => ({ succeeded: false, error }));
    await vi.waitFor(async () => expect((await runs.get(RUN)).steps.at(-1)?.state).toBe('running'));
    await runs.cancel(RUN, 'The person stopped the task.', principal);
    await project();
    const stopped = progress().at(-1)!;
    expect(stopped.progress).toMatchObject({ status: 'cancelled', certainty: 'unknown', retry: 'reconcile-first' });
    expect(stopped.sentence).toContain('unknown outcome');
    expect((await runs.get(RUN)).steps.at(-1)).toMatchObject({ state: 'reconcile_required', output: null });
    release();
    expect(await outcome).toMatchObject({ succeeded: false });
    await project();
    expect(progress().at(-1)!.id).toBe(stopped.id);
    expect(progress().at(-1)!.progress!.certainty).toBe('unknown');
    expect(task().state).not.toBe('done');
  });

  test('a cancelled root pure wait keeps an existing validated owned child unknown on its terminal Board note', async () => {
    const run = await cancelPureWait();
    state().team!.runs.push(ownedRecord(true));
    await project(run);
    const terminal = run.events.find(event => event.type === 'run.cancelled')!;
    const note = progress().find(entry => entry.progress!.seq === terminal.seq)!;
    expect(note.progress).toMatchObject({ runId: RUN, status: 'cancelled', certainty: 'unknown', retry: 'reconcile-first' });
    expect(note.sentence).toContain('unknown outcome');
    expect(task().runtimeProgress).toEqual({ runId: RUN, lastSeq: run.lastSeq });
    expect(task().state).not.toBe('done');
  });

  test('late owned-child uncertainty upgrades the same terminal event once without new History or a changed cursor', async () => {
    const run = await cancelPureWait();
    const owned = ownedRecord(false);
    state().team!.runs.push(owned, ownedRecord(true, 'RunrelatedRoot'));
    await project(run);
    const terminal = run.events.find(event => event.type === 'run.cancelled')!;
    const first = structuredClone(progress().find(entry => entry.progress!.seq === terminal.seq)!);
    expect(first.progress).toMatchObject({ status: 'cancelled', certainty: 'confirmed', retry: 'new-root-required' });
    const ids = state().history.map(entry => entry.id);
    const cursor = structuredClone(task().runtimeProgress);
    owned.unknownOutcome = true;
    await store.persist(state());
    await project(run);
    const upgraded = progress().find(entry => entry.progress!.seq === terminal.seq)!;
    expect(upgraded.id).toBe(first.id);
    expect(upgraded.time).toBe(first.time);
    expect(upgraded.progress).toMatchObject({ status: 'cancelled', certainty: 'unknown', retry: 'reconcile-first' });
    expect(upgraded.sentence).toContain('unknown outcome');
    expect(state().history.map(entry => entry.id)).toEqual(ids);
    expect(task().runtimeProgress).toEqual(cursor);
    expect(progress().filter(entry => entry.progress!.seq === terminal.seq)).toHaveLength(1);
    // A remirror may never silently weaken an already recorded unknown note.
    owned.unknownOutcome = false;
    await project(run);
    expect(progress().find(entry => entry.id === first.id)!.progress!.certainty).toBe('unknown');
    expect(state().history.map(entry => entry.id)).toEqual(ids);
    expect(task().runtimeProgress).toEqual(cursor);
  });

  test('unreported models remain unreported; successful application steps do not borrow a model name', async () => {
    await runs.step(RUN, OWNER, { id: 'plan', version: 'v1', kind: 'transform', origin: applicationOrigin() },
      () => ({ text: 'I am GPT 6.1 Sol, and all checks passed.' }), principal);
    await project();
    const note = progress().find(entry => entry.progress!.stepId === 'plan')!;
    expect(note.progress!.model).toEqual({ requested: null, reported: null, source: 'not-recorded' });
    expect(note.origin!.mode).toBe('application');
  });

  test('a different project, task, root or session cannot attach progress to this Board item', async () => {
    const run = await runs.get(RUN);
    for (const wrong of [ { ...run, projectId: 'other-project' }, { ...run, taskId: 'Tother' },
      { ...run, id: 'Rother' }, { ...run, sessionId: 'Sother' } ]) {
      await project(wrong);
      expect(progress()).toHaveLength(0);
      expect(task()).not.toHaveProperty('runtimeProgress');
    }
  });

  test('execution completion with no declared checks remains waiting for Review', async () => {
    await complete();
    await project();
    expect(task()).toMatchObject({ state: 'waiting', reason: 'changes-ready' });
    expect(progress().find(entry => entry.sentence.includes('execution completed'))?.progress!.status).toBe('succeeded');
    expect(verificationOf({ session: session(), task: task(), history: state().history }).state).toBe('not-verified');
  });

  test('H17 failed checks keep the actual task incomplete and carry their evidence', async () => {
    const verifier = await verifiedReport('# Exceptions\n\nAll counts match.\n');
    expect(verifier.view(projectId, session().id).state).toBe('failed');
    await project();
    expect(task().state).toBe('waiting');
    expect(state().history.find(entry => entry.verification)?.verification!.checks.some(check => check.outcome === 'failed')).toBe(true);
  });

  test('Done survives only exact H17-verified bytes; changed current bytes return to Review', async () => {
    const verifier = await verifiedReport();
    expect(verifier.view(projectId, session().id).state).toBe('verified');
    task().state = 'done';
    await project();
    expect(task().state).toBe('done');
    await store.locked(() => store.writeRecorded(projectId, [{ path: 'exceptions.md', text: 'Changed after verification.\n', expected: hash(REPORT) }]));
    expect(verifier.view(projectId, session().id).state).toBe('uncertain');
    await project();
    expect(task()).toMatchObject({ state: 'waiting', reason: 'changes-ready' });
  });

  test.each(['open', 'pending'] as const)('an %s Need blocks Done even on verified exact bytes', async (kind) => {
    const verifier = await verifiedReport();
    expect(verifier.view(projectId, session().id).state).toBe('verified');
    const need: Need = { id: 'Npending', taskId, sessionId: session().id, what: 'An unresolved exact approval',
      why: 'The existing Need remains the authority.', consequence: 'The task must wait.', files: ['exceptions.md'],
      state: kind === 'open' ? 'open' : 'go-ahead', createdAt: new Date().toISOString(), decidedAt: null,
      decidedFrom: 'owner', allowForTask: false, ...(kind === 'pending' ? { execution: { state: 'pending' } as Need['execution'] } : {}) };
    state().needs.push(need);
    task().state = 'done';
    await project();
    expect(task()).toMatchObject({ state: 'waiting', reason: 'needs-ok' });
    expect(state().needs.find(item => item.id === need.id)!.state).toBe(need.state);
  });
});
