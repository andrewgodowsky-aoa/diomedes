/**
 * H20: the scenario set the headless runner drives through the production Core.
 *
 * Every scenario opens its own Core in its own folder and speaks to it only
 * over HTTP. Providers are replaced at the transport boundary by fixtures that
 * already exist in this repository, named on each result:
 *
 *   - the staged sample worker (`sample`), which is Core itself;
 *   - the scripted Codex Work call (`nativeGenerator`), as the H08, H12 and
 *     approval tests use it;
 *   - the Diomedes loop's fixed local script (`native-fixture`, H13);
 *   - the captured-shape AWS Responses stream (`tests/fixtures/model-api-streams.ts`)
 *     below the AI SDK (`modelApiTransport`);
 *   - the approval crash child (`tests/approval-crash-child.ts`), a real Core
 *     process that exits at a durable write boundary.
 *
 * A scenario records `checks` (one route, one capability, performs or
 * refuses) and `assertions` (invariants that are not one cell). It never
 * decides a cell: `server/evaluation/route-matrix.ts` does, from these.
 */
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { MatrixCapability, ScenarioAssertion, ScenarioCheck } from '../../server/evaluation/route-matrix.js';
import type { NativeGenerator } from '../../server/native-work.js';
import { EngineService } from '../../server/engines/service.js';
import { AWS_LUNA_MODEL } from '../../server/engines/aws-bedrock.js';
import { testOnlySecretBox } from '../../server/connection-secrets.js';
import { responsesEvents, sseResponse } from '../../tests/fixtures/model-api-streams.js';
import { Core, until, type CoreOptions } from './core.js';

export const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

type Json = any;
type Proposal = Awaited<ReturnType<NativeGenerator>>;

/** What the runner lets a caller replace: only the fixtures, never Core. */
export interface ScenarioFixtures {
  /** The scripted Codex proposal. A broken one (not the proposal shape) is how a mismatch is shown on purpose. */
  codexProposal?: (changes: { path: string; text: string; summary: string }[]) => Proposal;
}

export interface ScenarioContext {
  /** A fresh folder for this scenario's Core. */
  root: string;
  fixtures: ScenarioFixtures;
  check(route: string, capability: MatrixCapability, expect: ScenarioCheck['expect'], passed: boolean, detail: string): void;
  assert(name: string, passed: boolean, detail: string): void;
  evidence: Record<string, unknown>;
  /** Opens a Core on `root` with these seams; closed for the scenario when it ends. */
  core(options?: () => CoreOptions): Promise<Core>;
}

export interface Scenario {
  id: string;
  title: string;
  fixture: string;
  run(context: ScenarioContext): Promise<void>;
}

const defaultProposal = (changes: { path: string; text: string; summary: string }[]): Proposal => ({
  text: JSON.stringify({ summary: 'Update the selected work', changes }),
  model: 'scripted-codex',
});

// --- shared steps -----------------------------------------------------------------------

async function sampleProject(core: Core) {
  const project = await core.api<{ id: string; folder?: string }>('/projects/sample', 'POST', {});
  return project.id;
}
const state = (core: Core, projectId: string) => core.api<Json>(`/projects/${projectId}/state`);
const sessionOf = (value: Json, sessionId: string) => value.sessions.find((item: Json) => item.id === sessionId);
const openNeedOf = (value: Json, sessionId: string) =>
  value.needs.find((need: Json) => need.sessionId === sessionId && need.state === 'open' && !need.supervision);
const control = (core: Core, projectId: string, body: Record<string, unknown>) =>
  core.request<{ receipt: Json }>(`/projects/${projectId}/controls`, 'POST', {
    protocolVersion: 1,
    commandId: randomUUID(),
    ...body,
  });
const versioned = (need: Json, resolution: 'go-ahead' | 'declined') => ({
  protocolVersion: 1,
  commandId: randomUUID(),
  resolution,
  allowForTask: false,
  proposalDigest: need.approval.proposalDigest,
  actionDigest: need.approval.actionDigest,
  baseDigest: need.approval.baseDigest,
});
async function codexOn(core: Core, projectId: string, documents: string[]) {
  await core.api('/settings', 'PUT', { services: { codex: true } });
  await core.api(`/projects/${projectId}/cloud-sharing`, 'PUT', {
    expectedVersion: 0,
    routes: ['codex'],
    documents,
    shareConversationHistory: false,
    shareReviewPackets: false,
  });
}
const codexStart = (core: Core, projectId: string, taskId: string, sources: string[]) =>
  core.api<Json>(`/projects/${projectId}/work/start`, 'POST', {
    protocolVersion: 1,
    commandId: randomUUID(),
    taskId,
    route: 'codex',
    consent: true,
    sources,
  });
const settled = (core: Core, projectId: string, sessionId: string) =>
  until(
    () => state(core, projectId),
    (value) => !['queued', 'working', 'waiting'].includes(sessionOf(value, sessionId)?.state ?? 'queued'),
    `run ${sessionId} to settle`,
  );

// --- the scenarios ------------------------------------------------------------------------

const sampleProposal: Scenario = {
  id: 'sample-proposal-approve-decline',
  title: 'A proposal needing approval: approve, and decline',
  fixture: 'sample: the staged worker inside Core',
  async run(ctx) {
    const core = await ctx.core();
    const projectId = await sampleProject(core);
    const folder = (await state(core, projectId)).project.folder as string;
    const notes = path.join(folder, 'Sample work notes.md');
    const exists = () => fs.access(notes).then(() => true, () => false);

    // Decline: the run asks before it adds its notes file; declining leaves no file.
    const first = await core.api<Json>(`/projects/${projectId}/tasks`, 'POST', { name: 'Decline the notes file' });
    const declinedRun = await core.api<Json>(`/projects/${projectId}/work/start`, 'POST', { taskId: first.id });
    let declinedNeed: Json = null;
    for (let guard = 0; guard < 6; guard++) {
      const current = await until(
        () => state(core, projectId),
        (value) => Boolean(openNeedOf(value, declinedRun.id)) || sessionOf(value, declinedRun.id)?.state === 'done',
        'the sample run to ask or finish',
      );
      const need = openNeedOf(current, declinedRun.id);
      if (!need) break;
      const isNotes = need.files.length === 1 && need.files[0] === 'Sample work notes.md';
      if (isNotes) declinedNeed = need;
      await core.api(`/projects/${projectId}/needs/${need.id}/resolve`, 'POST', { resolution: isNotes ? 'declined' : 'go-ahead' });
    }
    const afterDecline = await settled(core, projectId, declinedRun.id);
    const declinedFile = await exists();
    ctx.check(
      'sample',
      'approval',
      'performs',
      declinedNeed !== null && !declinedFile && afterDecline.needs.find((n: Json) => n.id === declinedNeed.id)?.state === 'declined',
      declinedNeed
        ? `declining “${declinedNeed.what}” left Sample work notes.md unwritten (exists: ${declinedFile}).`
        : 'the run never asked about its notes file.',
    );

    // Approve: the same proposal, said yes to, is written and recorded.
    const second = await core.api<Json>(`/projects/${projectId}/tasks`, 'POST', { name: 'Approve the notes file' });
    const run = await core.api<Json>(`/projects/${projectId}/work/start`, 'POST', { taskId: second.id });
    let proposed: Json = null;
    let existedBefore = false;
    for (let guard = 0; guard < 6; guard++) {
      const current = await until(
        () => state(core, projectId),
        (value) => Boolean(openNeedOf(value, run.id)) || sessionOf(value, run.id)?.state === 'done',
        'the sample run to ask or finish',
      );
      const need = openNeedOf(current, run.id);
      if (!need) break;
      if (need.files.includes('Sample work notes.md') && need.files.length === 1) {
        proposed = need;
        existedBefore = await exists();
      }
      await core.api(`/projects/${projectId}/needs/${need.id}/resolve`, 'POST', { resolution: 'go-ahead' });
    }
    const done = await settled(core, projectId, run.id);
    const session = sessionOf(done, run.id);
    const changed = done.history.filter((entry: Json) => entry.sessionId === run.id && entry.kind === 'changed');
    const written = await exists();
    ctx.check('sample', 'turn', 'performs', session.state === 'done', `the staged run started and finished (${session.state}).`);
    ctx.check(
      'sample',
      'tool-proposal',
      'performs',
      proposed !== null && !existedBefore,
      proposed ? `the run proposed “${proposed.what}” as a Need before the file existed.` : 'no proposal was made.',
    );
    ctx.check(
      'sample',
      'approval',
      'performs',
      proposed !== null && written && changed.some((entry: Json) => entry.files.some((file: Json) => file.path === 'Sample work notes.md')),
      `after go-ahead the file was written (${written}) and History recorded it.`,
    );
    ctx.evidence.approvedSession = run.id;
    ctx.evidence.declinedSession = declinedRun.id;
  },
};

const sampleRefusals: Scenario = {
  id: 'sample-controls-refused',
  title: 'Controls the staged worker declares unsupported are refused, with the contract’s reason',
  fixture: 'sample: the staged worker inside Core',
  async run(ctx) {
    const core = await ctx.core();
    const projectId = await sampleProject(core);
    const task = await core.api<Json>(`/projects/${projectId}/tasks`, 'POST', { name: 'Refusals' });
    const live = await core.api<Json>(`/projects/${projectId}/work/start`, 'POST', { taskId: task.id });
    const refusedWith = async (body: Record<string, unknown>, capability: MatrixCapability) => {
      const reply = await control(core, projectId, { taskId: task.id, ...body });
      const receipt = reply.data.receipt;
      ctx.check(
        'sample',
        capability,
        'refuses',
        reply.status === 200 && receipt?.outcome === 'refused' && receipt.performedBy === null,
        `${String(body.control)} was ${receipt?.outcome ?? `answered ${reply.status}`}: ${receipt?.refusal?.reason ?? JSON.stringify(reply.data).slice(0, 200)}`,
      );
    };
    await refusedWith({ control: 'steer', sessionId: live.id, text: 'Faster, please.' }, 'steer');
    await refusedWith({ control: 'stop', scope: 'generation', sessionId: live.id }, 'stop');
    const stop = await control(core, projectId, { taskId: task.id, control: 'stop', scope: 'task', sessionId: live.id });
    ctx.assert(
      'the task-level Stop, which Diomedes composes on every route, applies',
      stop.data.receipt?.outcome === 'applied',
      `stop task: ${stop.data.receipt?.outcome}`,
    );
    await settled(core, projectId, live.id);
    await refusedWith({ control: 'resume', sessionId: live.id }, 'resume');
    await refusedWith({ control: 'retry', sessionId: live.id }, 'retry');
    await refusedWith({ control: 'fork', sessionId: live.id }, 'fork');
    const queued = await control(core, projectId, {
      taskId: task.id,
      control: 'queue',
      text: 'Also list the desserts.',
      waitsFor: 'task',
      route: 'sample',
    });
    ctx.assert(
      'Diomedes’ own follow-up queue holds a message on a route whose contract declares no follow-up (it is not the route’s follow-up)',
      queued.data.receipt?.outcome === 'queued' && queued.data.receipt?.performedBy?.kind === 'diomedes',
      `queue: ${queued.data.receipt?.outcome}, performed by ${queued.data.receipt?.performedBy?.kind}`,
    );
    const receipts = (await state(core, projectId)).controlReceipts ?? [];
    ctx.assert('every control, refused or not, left a receipt', receipts.length === 7, `${receipts.length} receipts`);
  },
};

const codexStop: Scenario = {
  id: 'codex-stop-mid-turn',
  title: 'Stop mid-turn on the Codex route',
  fixture: 'codex: scripted Work call (nativeGenerator) that holds until its signal aborts',
  async run(ctx) {
    let called = false,
      aborted = false;
    const core = await ctx.core(() => ({
      nativeGenerator: (input) =>
        new Promise<Proposal>((_resolve, reject) => {
          called = true;
          input.signal?.addEventListener(
            'abort',
            () => {
              aborted = true;
              reject(new Error('The request was stopped.'));
            },
            { once: true },
          );
        }),
    }));
    const projectId = await sampleProject(core);
    await codexOn(core, projectId, ['Fall menu.md']);
    const task = await core.api<Json>(`/projects/${projectId}/tasks`, 'POST', { name: 'Hold the turn' });
    const live = await codexStart(core, projectId, task.id, ['Fall menu.md']);
    await until(async () => called, Boolean, 'the Codex call to start');
    const steer = await control(core, projectId, { taskId: task.id, control: 'steer', sessionId: live.id, text: 'Shorter.' });
    ctx.check(
      'codex',
      'steer',
      'refuses',
      steer.data.receipt?.outcome === 'refused' && steer.data.receipt?.refusal?.code === 'unsupported',
      `steer on a running Codex turn with no recorded thread: ${steer.data.receipt?.outcome} (${steer.data.receipt?.refusal?.code ?? '-'})`,
    );
    const stop = await control(core, projectId, { taskId: task.id, control: 'stop', scope: 'generation', sessionId: live.id });
    await until(async () => aborted, Boolean, 'the in-flight call to see its abort', 5_000).catch(() => false);
    // A generation Stop ends the request, not the run (server/native-work.ts `interrupt`): the run
    // writes no proposal and waits until a task Stop ends it.
    const interrupted = await state(core, projectId);
    const session = sessionOf(interrupted, live.id);
    const noProposal = !interrupted.needs.some((need: Json) => need.sessionId === live.id);
    ctx.check(
      'codex',
      'stop',
      'performs',
      stop.data.receipt?.outcome === 'applied' && stop.data.receipt?.result?.stop?.acknowledged === true && aborted && noProposal,
      `Stop (generation) was ${stop.data.receipt?.outcome} and acknowledged; the in-flight call saw its abort (${aborted}); no proposal was written (${noProposal}); the run is ${session.state}.`,
    );
    const ended = await control(core, projectId, { taskId: task.id, control: 'stop', scope: 'task', sessionId: live.id });
    const after = await settled(core, projectId, live.id);
    ctx.assert(
      'the task Stop then ends the interrupted run',
      ended.data.receipt?.outcome === 'applied' && sessionOf(after, live.id).state === 'stopped',
      `stop task ${ended.data.receipt?.outcome}; run ${sessionOf(after, live.id).state}`,
    );
    ctx.evidence.stopReceipt = stop.data.receipt?.commandId;
    ctx.evidence.session = live.id;
  },
};

const codexRetry: Scenario = {
  id: 'codex-retry-after-failure',
  title: 'Retry after failure on the Codex route, then approve and verify the retried run',
  fixture: 'codex: scripted Work call (nativeGenerator) that fails once, then proposes',
  async run(ctx) {
    let fail = true,
      calls = 0;
    const menu = '# Fall menu\n\nSquash soup, apple tart.\n';
    const propose = ctx.fixtures.codexProposal ?? defaultProposal;
    const core = await ctx.core(() => ({
      nativeGenerator: async () => {
        calls++;
        if (fail) throw new Error('The engine went away.');
        return propose([{ path: 'Fall menu.md', text: menu, summary: 'Rewrite the menu' }]);
      },
    }));
    const projectId = await sampleProject(core);
    await codexOn(core, projectId, ['Fall menu.md']);
    const task = await core.api<Json>(`/projects/${projectId}/tasks`, 'POST', { name: 'Rewrite the menu' });
    const original = await codexStart(core, projectId, task.id, ['Fall menu.md']);
    const failed = await settled(core, projectId, original.id);
    ctx.assert('the first attempt failed', sessionOf(failed, original.id).state === 'failed', sessionOf(failed, original.id).state);
    fail = false;
    const retry = await control(core, projectId, { taskId: task.id, control: 'retry', sessionId: original.id });
    const receipt = retry.data.receipt;
    const nextId = receipt?.result?.sessionId as string | undefined;
    ctx.check(
      'codex',
      'retry',
      'performs',
      receipt?.outcome === 'applied' && receipt?.lineage?.attempt === 2 && Boolean(nextId),
      `retry was ${receipt?.outcome}, attempt ${receipt?.lineage?.attempt}, as ${nextId ?? 'no run'}.`,
    );
    if (!nextId) return;
    const asked = await until(
      () => state(core, projectId),
      (value) => Boolean(openNeedOf(value, nextId)) || !['queued', 'working', 'waiting'].includes(sessionOf(value, nextId)?.state),
      'the retried run to propose',
    );
    const need = openNeedOf(asked, nextId);
    ctx.check(
      'codex',
      'turn',
      'performs',
      Boolean(need),
      need ? `the retried turn answered with a proposal for ${need.files.join(', ')}.` : `the retried run ended ${sessionOf(asked, nextId).state} with no proposal.`,
    );
    ctx.check(
      'codex',
      'tool-proposal',
      'performs',
      Boolean(need?.approval) && need.files.includes('Fall menu.md'),
      need ? `an exact proposal waits on a Need with digests (${Boolean(need.approval)}).` : 'no proposal was recorded.',
    );
    if (!need) return;
    const decided = await core.request(`/projects/${projectId}/needs/${need.id}/resolve`, 'POST', versioned(need, 'go-ahead'));
    const done = await settled(core, projectId, nextId);
    const bytes = await fs.readFile(path.join(done.project.folder, 'Fall menu.md'), 'utf8');
    ctx.check(
      'codex',
      'approval',
      'performs',
      decided.status === 200 && bytes === menu,
      `the exact approval was ${decided.status === 200 ? 'recorded' : `refused (${decided.status})`} and the file holds the approved bytes (${bytes === menu}).`,
    );
    await core.api(`/projects/${projectId}/tasks/${task.id}/acceptance`, 'PUT', {
      checks: [
        { id: 'menu', kind: 'file-exists', path: 'Fall menu.md' },
        { id: 'tart', kind: 'text-contains', path: 'Fall menu.md', text: 'apple tart' },
      ],
    });
    const verified = await core.api<Json>(`/projects/${projectId}/sessions/${nextId}/verification`, 'POST', {});
    ctx.check(
      'codex',
      'verification',
      'performs',
      verified.state === 'verified',
      `H17 on the retried run: ${verified.label} — ${verified.sentence}`,
    );
    const origin = sessionOf(await state(core, projectId), original.id);
    ctx.assert('the failed original is kept as evidence, still failed', origin.state === 'failed', origin.state);
    ctx.assert('the scripted Codex call ran exactly twice: once failed, once retried', calls === 2, `${calls} calls`);
    ctx.evidence.retryReceipt = receipt.commandId;
    ctx.evidence.verificationEntry = verified.entryId;
  },
};

const loopRestart: Scenario = {
  id: 'h13-loop-restart-verified',
  title: 'H13 loop: restart while it waits for approval, resume from the record, finish Verified (H17)',
  fixture: 'native-fixture: the Diomedes loop’s fixed local script (loopFixtureAdapter, delegateFixtureAdapter)',
  async run(ctx) {
    const core = await ctx.core();
    const project = await core.api<Json>('/projects', 'POST', { name: 'Linen orders' });
    const projectId = project.id as string;
    for (const [name, text] of [
      ['order.md', 'Order 1182: 100 napkins, 40 tablecloths.\n'],
      ['delivery.md', 'Delivered 94 napkins and 40 tablecloths. Six napkins short.\n'],
    ])
      await core.api(`/projects/${projectId}/documents/create`, 'POST', { path: name, text });
    const task = await core.api<Json>(`/projects/${projectId}/tasks`, 'POST', { name: 'Check the linen delivery' });
    await core.api(`/projects/${projectId}/tasks/${task.id}/acceptance`, 'PUT', {
      checks: [
        { id: 'report', kind: 'file-exists', path: 'Harness report.md' },
        { id: 'order', kind: 'text-contains', path: 'Harness report.md', text: 'Order 1182' },
      ],
    });
    const started = await core.api<Json>(`/projects/${projectId}/loop/start`, 'POST', {
      protocolVersion: 1,
      commandId: 'h20-loop',
      taskId: task.id,
      goal: 'Compare the order with the delivery and write the report.',
      route: 'native-fixture',
      sources: ['order.md', 'delivery.md'],
      delegate: { route: 'native-fixture' },
    });
    const sessionId = started.session.id as string;
    const asked = await until(() => state(core, projectId), (value) => Boolean(openNeedOf(value, sessionId)), 'the loop to propose its report');
    const need = openNeedOf(asked, sessionId);
    const before = await core.api<Json>(`/projects/${projectId}/loop/runs/${started.runId}`);
    await core.restart();
    const decided = await core.request(`/projects/${projectId}/needs/${need.id}/resolve`, 'POST', versioned(need, 'go-ahead'));
    const finished = await until(
      () => core.api<Json>(`/projects/${projectId}/loop/runs/${started.runId}`),
      // "Not verified" with the checks not yet run is the moment between the finish and the verifier.
      (value) =>
        ['verified', 'failed-verification', 'uncertain', 'stopped', 'failed'].includes(value.outcome?.state) ||
        (value.outcome?.state === 'not-verified' && value.verification?.rule !== 'checks-not-run'),
      'the loop to finish and be checked',
      30_000,
    );
    const turns = finished.view.turns as Json[];
    ctx.check(
      'native-fixture',
      'turn',
      'performs',
      Boolean(finished.view.plan) && finished.view.finish !== null,
      `planned ${finished.view.plan?.items?.length ?? 0} items, took ${turns.length} turns, finished with “${finished.view.finish?.claim ?? '-'}”.`,
    );
    ctx.check(
      'native-fixture',
      'tool-proposal',
      'performs',
      turns.some((turn) => turn.tool === 'propose_write') && need.files.includes('Harness report.md'),
      `the propose_write tool step asked for ${need.files.join(', ')} through a Need.`,
    );
    ctx.check(
      'native-fixture',
      'approval',
      'performs',
      decided.status === 200,
      `the exact approval, given after the restart, was ${decided.status === 200 ? 'recorded' : `refused (${decided.status})`}.`,
    );
    // A turn observed before the restart must read the same after it: replayed, never re-run.
    const observed = (before.view.turns as Json[]).filter((turn) => turn.observation);
    const replayed =
      observed.length > 0 &&
      observed.every((turn) => JSON.stringify(turns[before.view.turns.indexOf(turn)]?.observation) === JSON.stringify(turn.observation));
    ctx.check(
      'native-fixture',
      'resume',
      'performs',
      decided.status === 200 && finished.view.finish !== null && replayed,
      `after a restart the reopened Core continued the run from its record; the ${observed.length} turns observed before it read the same after it (${replayed}).`,
    );
    ctx.check(
      'native-fixture',
      'verification',
      'performs',
      finished.outcome.state === 'verified' && finished.verification?.record?.requestedBy === 'diomedes-loop',
      `H17 at the finish: ${finished.outcome.label} — ${finished.outcome.sentence}`,
    );
    const account = finished.view.account;
    ctx.check(
      'native-fixture',
      'context-accounting',
      'performs',
      Boolean(account) && account.sections.length > 0 && account.estimatedTokens > 0,
      account
        ? `H18 account: ${account.sections.length} sections, ${account.estimatedTokens} estimated tokens (${account.estimator}).`
        : 'no context account was recorded.',
    );
    const bound = finished.verification?.record?.bound ?? [];
    ctx.assert(
      'H17 evidence binds the exact bytes it judged',
      bound.length > 0 && bound.every((item: Json) => /^[a-f0-9]{64}$/.test(item.sha ?? item.digest ?? '')),
      `${bound.length} bound file versions`,
    );
    ctx.evidence.runId = started.runId;
    ctx.evidence.verificationEntry = finished.verification?.entryId;
  },
};

const driftEscalation: Scenario = {
  id: 'h15-drift-escalation',
  title: 'H15: a run writing outside its selected folder is paused and escalated to a person',
  fixture: 'sample: the staged worker inside Core',
  async run(ctx) {
    const core = await ctx.core();
    // Every change asks for its own OK; the sample worker then writes its plan without asking.
    await core.api('/settings', 'PUT', {
      permissions: { changingFiles: false, deleting: true, sending: false, workingOutside: true, spending: true },
    });
    const projectId = await sampleProject(core);
    const folder = (await state(core, projectId)).project.folder as string;
    await fs.mkdir(path.join(folder, 'Menu'), { recursive: true });
    await fs.writeFile(path.join(folder, 'Menu', 'Fall menu draft.md'), '# Draft\n\nSquash soup.\n');
    const task = await core.api<Json>(`/projects/${projectId}/tasks`, 'POST', {
      name: 'Tidy the menu draft',
      sourceDocument: 'Menu/Fall menu draft.md',
    });
    const thread = await core.api<Json>(`/projects/${projectId}/threads`, 'POST', { attachedTo: { kind: 'task', ref: task.id } });
    const run = await core.api<Json>(`/projects/${projectId}/work/start`, 'POST', {
      protocolVersion: 1,
      commandId: randomUUID(),
      taskId: task.id,
      route: 'sample',
      threadId: thread.id,
    });
    const asked = await until(() => state(core, projectId), (value) => Boolean(openNeedOf(value, run.id)), 'the notes proposal');
    await core.api(`/projects/${projectId}/needs/${openNeedOf(asked, run.id).id}/resolve`, 'POST', { resolution: 'go-ahead' });
    const escalated = await until(
      () => state(core, projectId),
      (value) => value.needs.some((need: Json) => need.supervision && need.sessionId === run.id),
      'the supervision escalation',
    );
    const need = escalated.needs.find((item: Json) => item.supervision && item.sessionId === run.id);
    const session = sessionOf(escalated, run.id);
    const records = (await core.api<Json>(`/projects/${projectId}/supervision?sessionId=${run.id}`)).records as Json[];
    const escalation = records.find((record) => record.action === 'escalate');
    const receipt = (escalated.controlReceipts ?? []).find((item: Json) => item.commandId === escalation?.control?.commandId);
    ctx.assert(
      'scope drift is detected from the durable records and escalated as an ordinary Need',
      need?.supervision?.code === 'scope-drift' && need.state === 'open' && need.allowForTask === false,
      `${need?.supervision?.code ?? 'none'}: ${need?.what ?? '-'}`,
    );
    ctx.assert(
      'the run was paused through an H08 Stop asked in supervision’s name and performed by Diomedes',
      session.state === 'stopped' && receipt?.requestedBy?.via === 'supervision' && receipt?.performedBy?.kind === 'diomedes',
      `run ${session.state}; stop requested via ${receipt?.requestedBy?.via ?? '-'}`,
    );
    ctx.assert(
      'the escalation names the evidence it rests on',
      Array.isArray(escalation?.evidence) && escalation.evidence.some((item: Json) => typeof item.path === 'string'),
      (escalation?.evidence ?? []).map((item: Json) => item.path).join(', ') || 'no evidence',
    );
    const again = (await core.api<Json>(`/projects/${projectId}/supervision/evaluate`, 'POST', { sessionId: run.id })).records as Json[];
    const after = (await state(core, projectId)).needs.filter((item: Json) => item.supervision).length;
    ctx.assert('re-evaluating raises nothing new for the same issue', after === 1, `${after} escalations after re-evaluating (${again.length} records)`);
    ctx.evidence.escalationNeed = need?.id;
  },
};

const verificationEvidence: Scenario = {
  id: 'h17-verification-evidence',
  title: 'H17: declared checks verify a finished run against exact bytes; an outside edit makes it uncertain',
  fixture: 'sample: the staged worker inside Core',
  async run(ctx) {
    const core = await ctx.core();
    const projectId = await sampleProject(core);
    const task = await core.api<Json>(`/projects/${projectId}/tasks`, 'POST', { name: 'Update the menu' });
    const run = await core.api<Json>(`/projects/${projectId}/work/start`, 'POST', { taskId: task.id });
    const asked = await until(() => state(core, projectId), (value) => Boolean(openNeedOf(value, run.id)), 'the start proposal');
    await core.api(`/projects/${projectId}/needs/${openNeedOf(asked, run.id).id}/resolve`, 'POST', { resolution: 'go-ahead', allowForTask: true });
    const done = await settled(core, projectId, run.id);
    const output = done.history.find((entry: Json) => entry.sessionId === run.id && entry.files.length)?.files[0];
    const before = await core.api<Json>(`/projects/${projectId}/sessions/${run.id}/verification`);
    ctx.assert('with no checks declared the run reads Not verified', before.state === 'not-verified', `${before.label}: ${before.sentence}`);
    await core.api(`/projects/${projectId}/tasks/${task.id}/acceptance`, 'PUT', {
      checks: [{ id: 'exists', kind: 'file-exists', path: output.path }],
    });
    const verified = await core.api<Json>(`/projects/${projectId}/sessions/${run.id}/verification`, 'POST', {});
    ctx.check('sample', 'verification', 'performs', verified.state === 'verified', `${verified.label}: ${verified.sentence}`);
    const entry = (await state(core, projectId)).history.find((item: Json) => item.id === verified.entryId);
    ctx.assert(
      'the verification is a History entry that binds the digest it judged',
      entry?.kind === 'verified' && (entry.verification?.bound ?? []).some((item: Json) => item.path === output.path),
      `entry ${verified.entryId}: ${entry?.kind}`,
    );
    await fs.writeFile(path.join(done.project.folder, output.path), 'hand edit\n', 'utf8');
    const after = await core.api<Json>(`/projects/${projectId}/sessions/${run.id}/verification`);
    ctx.assert(
      'an outside edit to a verified file turns the result uncertain on the next read',
      after.state === 'uncertain' && after.rule === 'outputs-changed',
      `${after.label}: ${after.sentence}`,
    );
    ctx.evidence.verificationEntry = verified.entryId;
  },
};

const uncertainRetry: Scenario = {
  id: 'h12-uncertain-effect-blocks-retry',
  title: 'H12: a write whose outcome is uncertain after a crash blocks Retry, and nothing is sent',
  fixture: 'codex: tests/approval-crash-child.ts, a real Core process that exits after the first file of an approved write; then an outside edit',
  async run(ctx) {
    let calls = 0;
    const core = await ctx.core(() => ({
      nativeGenerator: async () => {
        calls++;
        throw new Error('A retry must never reach the engine while an effect is uncertain.');
      },
    }));
    const project = await core.api<Json>('/projects', 'POST', { name: 'Approval fixture' });
    const projectId = project.id as string;
    for (const [name, text] of [
      ['Brief.md', '﻿# Brief\r\n\r\nSynthetic before bytes.\r\n'],
      ['Reference.md', 'Selected read-only reference.\n'],
    ])
      await core.api(`/projects/${projectId}/documents/create`, 'POST', { path: name, text });
    const task = await core.api<Json>(`/projects/${projectId}/tasks`, 'POST', { name: 'Append a sentence', owner: 'diomedes-with-ok' });
    await codexOn(core, projectId, ['Brief.md', 'Reference.md']);
    const folder = (await state(core, projectId)).project.folder as string;
    await core.close();
    const exit = await new Promise<{ code: number | null; output: string }>((resolve, reject) => {
      const chunks: string[] = [];
      const child = spawn(
        process.execPath,
        ['--import', 'tsx', path.join('tests', 'approval-crash-child.ts'), ctx.root, projectId, task.id, 'first-file'],
        { cwd: REPO, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
      );
      child.stdout.on('data', (chunk) => chunks.push(String(chunk)));
      child.stderr.on('data', (chunk) => chunks.push(String(chunk)));
      child.on('error', reject);
      child.on('close', (code) => resolve({ code, output: chunks.join('') }));
    });
    ctx.assert(
      'the Core process exited at the durable boundary after the first approved file',
      exit.code === 83,
      `exit ${exit.code}${exit.code === 83 ? '' : `: ${exit.output.slice(-300)}`}`,
    );
    // The person edits the file the interrupted write had not reached yet.
    await fs.writeFile(path.join(folder, 'Draft.md'), 'Newer user work.\n', 'utf8');
    await core.open();
    const recovered = await state(core, projectId);
    const need = recovered.needs[0];
    const session = recovered.sessions[0];
    ctx.assert(
      'recovery kept the outside edit and recorded the write as conflicted, the run as failed',
      need?.execution?.state === 'conflicted' && session?.state === 'failed',
      `execution ${need?.execution?.state}, run ${session?.state}`,
    );
    const retry = await control(core, projectId, { taskId: task.id, control: 'retry', sessionId: session.id });
    const receipt = retry.data.receipt;
    const after = await state(core, projectId);
    ctx.assert(
      'Retry is refused as uncertain-effects and names the effect',
      receipt?.outcome === 'refused' && receipt?.refusal?.code === 'uncertain-effects' && receipt.uncertainEffects.length > 0,
      `${receipt?.outcome} (${receipt?.refusal?.code ?? '-'}): ${(receipt?.uncertainEffects ?? []).join(' ')}`,
    );
    ctx.assert(
      'nothing was sent and no run was started',
      calls === 0 && after.sessions.length === 1,
      `${calls} engine calls, ${after.sessions.length} runs`,
    );
    ctx.evidence.retryReceipt = receipt?.commandId;
  },
};

// --- the model-API route, below the SDK ------------------------------------------------

const SECRET = 'test-only-bedrock-key-0123456789abcdef-never-real';

const modelApiTurn: Scenario = {
  id: 'aws-ask-answer-stream',
  title: 'Ask and answer on AWS Bedrock: a streamed turn, a follow-up with history, Stop mid-turn, and its context account',
  fixture: 'aws-bedrock: captured-shape Responses stream (tests/fixtures/model-api-streams.ts) below the AI SDK',
  async run(ctx) {
    const seen: { input: Json[] }[] = [];
    const hang = { waiting: false };
    const said = (body: { input: Json[] }) => {
      const user = [...body.input].reverse().find((item) => item.role === 'user');
      const content = user?.content;
      const text =
        typeof content === 'string' ? content : Array.isArray(content) ? content.map((part: Json) => String(part.text ?? '')).join('') : '';
      return (text.split("The person's message:\n\n")[1] ?? text).split('\n\n[[diomedes')[0];
    };
    const transport = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { input: Json[] };
      seen.push(body);
      const message = said(body);
      if (message.includes('SLOW')) {
        hang.waiting = true;
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal!.reason ?? new Error('aborted')), { once: true });
        });
      }
      const token = /H20-[A-Z0-9-]+/.exec(message)?.[0] ?? 'none';
      return sseResponse(
        responsesEvents({
          id: `resp_${seen.length}`,
          object: 'response',
          created_at: 1_790_000_000,
          status: 'completed',
          model: AWS_LUNA_MODEL,
          output: [
            {
              type: 'message',
              id: `msg_${seen.length}`,
              role: 'assistant',
              status: 'completed',
              content: [{ type: 'output_text', text: `Answered ${token}.`, annotations: [] }],
            },
          ],
          usage: { input_tokens: 900, input_tokens_details: { cached_tokens: 0 }, output_tokens: 40, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 940 },
          incomplete_details: null,
          error: null,
        }),
        { 'x-amzn-requestid': `req-${seen.length}` },
      );
    }) as typeof globalThis.fetch;
    const core = await ctx.core(() => ({
      engineService: new EngineService(path.join(ctx.root, 'engines'), { discover: async () => [] }),
      secretBox: testOnlySecretBox(),
      modelApiTransport: transport,
    }));
    const project = await core.api<Json>('/projects', 'POST', { name: 'Linen service' });
    const projectId = project.id as string;
    const thread = await core.api<Json>(`/projects/${projectId}/threads`, 'POST', {});
    await core.api('/ai/model-api/aws-bedrock', 'PUT', {
      accountId: '123456789012',
      region: 'us-east-1',
      model: AWS_LUNA_MODEL,
      apiKey: SECRET,
      expiresAt: null,
      consent: true,
    });
    await core.api('/ai/model-api/aws-bedrock/spend-limit', 'PUT', { capUsd: 1, consent: true });
    await core.api(`/projects/${projectId}/threads/${thread.id}`, 'PUT', { engine: 'aws-bedrock' });
    await core.api(`/projects/${projectId}/cloud-sharing`, 'PUT', {
      expectedVersion: 0,
      routes: ['aws-bedrock'],
      documents: [],
      shareConversationHistory: true,
      shareReviewPackets: false,
    });
    const messages = `/projects/${projectId}/threads/${thread.id}/messages`;
    const send = (commandId: string, text: string) =>
      core.request<Json>(messages, 'POST', { commandId, text, mode: 'ask', sources: [], consent: true });
    const events = await core.events();
    try {
      const first = await send('h20-first', 'How many napkins came? H20-FIRST');
      await new Promise((resolve) => setTimeout(resolve, 100));
      const deltas = events.seen.filter((item) => item.event === 'engine-text' && item.data.threadId === thread.id && item.data.kind === 'delta');
      ctx.check(
        'aws-bedrock',
        'turn',
        'performs',
        first.status === 200 && String(first.data.answerText ?? '').includes('H20-FIRST'),
        `the turn answered ${first.status}: “${String(first.data.answerText ?? JSON.stringify(first.data)).slice(0, 120)}”.`,
      );
      ctx.check(
        'aws-bedrock',
        'stream',
        'performs',
        deltas.length > 0 && deltas.every((item) => typeof item.data.text === 'string'),
        `${deltas.length} transient text deltas reached the Console’s event stream for this thread.`,
      );
      const turns = (await state(core, projectId)).conversations.find((item: Json) => item.id === thread.id).turns as Json[];
      const account = turns.filter((turn) => turn.role === 'assistant').at(-1)?.context;
      ctx.check(
        'aws-bedrock',
        'context-accounting',
        'performs',
        Boolean(account) && account.sections.length > 0 && account.estimatedTokens > 0 && account.provider?.reportedCalls >= 1,
        account
          ? `H18 account on the answered turn: ${account.sections.length} sections, ${account.estimatedTokens} estimated tokens, provider reported ${account.provider?.inputTokens} input tokens.`
          : 'no context account was recorded on the turn.',
      );
      const second = await send('h20-second', 'And the tablecloths? H20-SECOND');
      const carried = JSON.stringify(seen.at(-1)?.input ?? []).includes('H20-FIRST');
      ctx.check(
        'aws-bedrock',
        'queue',
        'performs',
        second.status === 200 && String(second.data.answerText ?? '').includes('H20-SECOND') && carried,
        `a follow-up message was answered (${second.status}) as a new bounded turn whose request carried the earlier message (${carried}).`,
      );
      const slow = send('h20-slow', 'SLOW H20-SLOW');
      await until(async () => hang.waiting, Boolean, 'the slow call to reach the provider');
      const interrupted = await core.request(`${messages}/h20-slow/interrupt`, 'POST', {});
      const ended = await slow;
      ctx.check(
        'aws-bedrock',
        'stop',
        'performs',
        interrupted.status < 300 && (ended.data.interrupted === true || ended.status >= 400),
        `interrupt answered ${interrupted.status}; the turn ended ${ended.status} with interrupted=${ended.data.interrupted}.`,
      );
    } finally {
      events.stop();
    }
    ctx.assert('every provider request stayed below the SDK fixture', seen.length >= 3, `${seen.length} captured requests`);
  },
};

export const SCENARIOS: readonly Scenario[] = [
  modelApiTurn,
  sampleProposal,
  sampleRefusals,
  codexStop,
  codexRetry,
  loopRestart,
  uncertainRetry,
  driftEscalation,
  verificationEvidence,
];
