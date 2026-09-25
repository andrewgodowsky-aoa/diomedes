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
import { spawn as spawnChild, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { EngineService, TESTED_VERSIONS } from '../../server/engines/service.js';
import { CursorAdapter } from '../../server/engines/cursor.js';
import { OpenCodeAdapter } from '../../server/engines/opencode.js';
import { opencodeSessionRunId } from '../../server/harness/opencode-session-run.js';
import { ClaudeAdapter } from '../../server/engines/claude.js';
import type { ClaudeSessionCheckpoint } from '../../server/engines/claude-session.js';
import type { PersistentTextAdapter } from '../../server/engines/contract.js';
import { openProcess, type ProcessFactory } from '../../server/engines/process.js';
import { routeContractFor } from '../../server/harness/route-contract.js';
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
const CHECKLIST = 'Linen checklist.md';
const CHECKLIST_TEXT = '# Linen checklist\n\n- [ ] Count napkins against the order\n';
const decisionBlock = (sourceMessageId: string, summary: string) =>
  '```diomedes-decision\n' +
  JSON.stringify({
    source_message_id: sourceMessageId,
    disposition: 'act',
    requested_project_id: null,
    operation_class: 'write_internal',
    source_refs: [],
    target_run_id: null,
    question: null,
    public_summary: summary,
  }) +
  '\n```';

const modelApiTurn: Scenario = {
  id: 'aws-ask-answer-stream',
  title: 'Ask and answer on AWS Bedrock: a streamed turn and its context account, a follow-up, Stop mid-turn, a proposal approved and verified, and resume after a restart',
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
      const whole = JSON.stringify(body.input);
      const reply = (text: string) => ({
        type: 'message',
        id: `msg_${seen.length}`,
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_text', text, annotations: [] }],
      });
      // Work's single call asks for the strict file proposal (as in tests/aws-conversation-seam.test.ts).
      const work = whole.includes('Return STRICT JSON only');
      const issued = /\[\[diomedes source_message_id=(sm\.[0-9a-f]{32})\]\]/.exec(whole)?.[1];
      const output = work
        ? reply(JSON.stringify({ summary: 'Draft a linen checklist', changes: [{ path: CHECKLIST, text: CHECKLIST_TEXT, summary: 'A new checklist.' }] }))
        : message.startsWith('ACT') && issued
          ? reply(`I can draft that checklist.\n\n${decisionBlock(issued, 'Draft a linen checklist')}`)
          : null;
      if (output)
        return sseResponse(
          responsesEvents({
            id: `resp_${seen.length}`,
            object: 'response',
            created_at: 1_790_000_000,
            status: 'completed',
            model: AWS_LUNA_MODEL,
            output: [output],
            usage: { input_tokens: 900, input_tokens_details: { cached_tokens: 0 }, output_tokens: 40, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 940 },
            incomplete_details: null,
            error: null,
          }),
          { 'x-amzn-requestid': `req-${seen.length}` },
        );
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
    // A proposal: the conversation decides to act, the person selects it, and Work on this route
    // proposes an exact file change that waits on a Need.
    const settings = await core.api<Json>('/settings');
    await core.api('/settings', 'PUT', { ...settings, services: { ...settings.services, defaultEngine: 'aws-bedrock' } });
    const folder = (await state(core, projectId)).project.folder as string;
    const acted = await core.request<Json>(messages, 'POST', { commandId: 'h20-act', text: 'ACT draft a linen checklist', mode: 'auto', sources: [], consent: true });
    const selected =
      acted.data?.outcome?.status === 'proposed'
        ? await core.request<Json>(`${messages}/h20-act/select`, 'POST', { proposalDigest: acted.data.outcome.proposalDigest, projectId, consent: true })
        : null;
    const asked = await until(() => state(core, projectId), (value) => value.needs.some((need: Json) => need.state === 'open'), 'the Work proposal', 10_000).catch(() => null);
    const need = asked?.needs.find((item: Json) => item.state === 'open');
    const before = await fs.access(path.join(folder, CHECKLIST)).then(() => true, () => false);
    const work = asked?.sessions.find((session: Json) => session.id === need?.sessionId);
    ctx.check(
      'aws-bedrock',
      'tool-proposal',
      'performs',
      selected?.status === 200 && work?.route === 'aws-bedrock' && Boolean(need?.approval) && need.files.includes(CHECKLIST) && !before,
      need
        ? `the conversation proposed acting (${acted.data.outcome.status}); selected, Work on ${work?.route} proposed ${need.files.join(', ')} as an exact Need before the file existed.`
        : `no Work proposal appeared (message ${acted.status} ${acted.data?.outcome?.status ?? ''}, select ${selected?.status ?? '-'}).`,
    );
    if (need) {
      const decided = await core.request(`/projects/${projectId}/needs/${need.id}/resolve`, 'POST', versioned(need, 'go-ahead'));
      const done = await settled(core, projectId, need.sessionId);
      const written = await fs.readFile(path.join(folder, CHECKLIST), 'utf8').catch(() => null);
      ctx.check(
        'aws-bedrock',
        'approval',
        'performs',
        decided.status === 200 && written === CHECKLIST_TEXT,
        `the exact approval was ${decided.status === 200 ? 'recorded' : `refused (${decided.status})`}; the file holds the approved bytes (${written === CHECKLIST_TEXT}); the run ended ${sessionOf(done, need.sessionId).state}.`,
      );
      await core.api(`/projects/${projectId}/tasks/${need.taskId}/acceptance`, 'PUT', {
        checks: [{ id: 'napkins', kind: 'text-contains', path: CHECKLIST, text: 'Count napkins' }],
      });
      const verified = await core.api<Json>(`/projects/${projectId}/sessions/${need.sessionId}/verification`, 'POST', {});
      ctx.check('aws-bedrock', 'verification', 'performs', verified.state === 'verified', `H17 on the Work run: ${verified.label} — ${verified.sentence}`);
    }
    // Resume: after a restart the conversation continues from the durable record, not from any provider state.
    await core.restart();
    const later = await send('h20-after-restart', 'Anything else? H20-LATER');
    const carriedAfter = JSON.stringify(seen.at(-1)?.input ?? []).includes('H20-FIRST');
    ctx.check(
      'aws-bedrock',
      'resume',
      'performs',
      later.status === 200 && String(later.data.answerText ?? '').includes('H20-LATER') && carriedAfter,
      `after a restart the next message was answered (${later.status}) and its request carried the conversation from the durable record (${carriedAfter}).`,
    );
    ctx.assert('every provider request stayed below the SDK fixture', seen.length >= 3, `${seen.length} captured requests`);
  },
};

// --- a kept ACP conversation, over the fixture agent process ---------------------------

const ACP_FIXTURE = path.join(REPO, 'tests', 'fixtures', 'acp-agent.mjs');

/** Which installations exist: one Cursor CLI, whose process is the fixture ACP agent (tests/fixtures/acp-agent.mjs). */
const cursorService = (root: string) =>
  new EngineService(path.join(root, 'engines'), {
    discover: async () => [
      {
        id: 'cursor',
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
        installedVersion: TESTED_VERSIONS.cursor,
        location: process.execPath,
        disclosure: [],
      },
    ],
    version: async () => TESTED_VERSIONS.cursor,
    adapter: (_engine, _location, cwd) =>
      new CursorAdapter(path.join(root, 'agent'), cwd, {
        spawn: (_file, _args, options) => spawnChild(process.execPath, [ACP_FIXTURE], options) as ChildProcessWithoutNullStreams,
        capture: (async (options: { args: string[] }) =>
          options.args.includes('--version')
            ? { code: 0, stdout: '2026.08.11-e8db854' }
            : { code: 0, stdout: JSON.stringify({ status: 'authenticated', isAuthenticated: true }) }) as never,
        startupTimeoutMs: 5_000,
        requestTimeoutMs: 10_000,
      }),
  });

const cursorSession: Scenario = {
  id: 'cursor-acp-session',
  title: 'A kept Cursor conversation: turns, a follow-up, a plan approved and declined, Stop mid-turn, and resume after a restart',
  fixture: 'cursor: tests/fixtures/acp-agent.mjs, a real ACP v1 agent process standing in for the Cursor CLI',
  async run(ctx) {
    const core = await ctx.core(() => ({ engineService: cursorService(ctx.root) }));
    await core.api('/ai/discover', 'POST', { consent: true });
    await core.api('/ai/check/cursor', 'POST', {});
    await core.api('/ai/select', 'POST', { engine: 'cursor', model: 'fixture-model' });
    const project = await core.api<Json>('/projects', 'POST', { name: 'Cursor session' });
    const projectId = project.id as string;
    await core.api(`/projects/${projectId}/cloud-sharing`, 'PUT', {
      expectedVersion: 0,
      routes: ['cursor'],
      documents: [],
      shareConversationHistory: true,
      shareReviewPackets: false,
    });
    const thread = await core.api<Json>(`/projects/${projectId}/threads`, 'POST', {});
    const endpoint = `/projects/${projectId}/cursor-sessions`;
    const command = (commandId: string, text = commandId) => ({ commandId, threadId: thread.id, text, mode: 'ask', sources: [], consent: true });
    const openAsk = async () =>
      ((await core.api<Json>(`/projects/${projectId}/needs`)).needs as Json[]).find((need) => need.engineAsk && need.state === 'open');
    const events = await core.events();
    let runId = '';
    try {
      const first = await core.request<Json>(endpoint, 'POST', command('first'));
      runId = first.data.runId;
      ctx.check(
        'cursor-session',
        'turn',
        'performs',
        first.status === 200 && first.data.response?.text === 'answer after 0 earlier turns',
        `the first turn answered ${first.status}: “${first.data.response?.text ?? JSON.stringify(first.data).slice(0, 160)}”.`,
      );
      await new Promise((resolve) => setTimeout(resolve, 100));
      const deltas = events.seen.filter((item) => item.event === 'engine-text' && item.data.threadId === thread.id && item.data.kind === 'delta');
      ctx.check('cursor-session', 'stream', 'performs', deltas.length > 0, `${deltas.length} transient text deltas reached the event stream.`);
    } finally {
      events.stop();
    }
    if (!runId) return;
    const second = await core.request<Json>(`${endpoint}/${runId}/turn`, 'POST', command('second'));
    ctx.check(
      'cursor-session',
      'queue',
      'performs',
      second.status === 200 && second.data.response?.text === 'answer after 1 earlier turns',
      `a follow-up continued the same ACP session: “${second.data.response?.text ?? second.status}”.`,
    );
    const steer = await core.request(`${endpoint}/${runId}/steer`, 'POST', { commandId: 'steer-1', text: 'Faster.' });
    ctx.check('cursor-session', 'steer', 'refuses', steer.status === 404, `no steer route is mounted for a contract that declares none (${steer.status}).`);
    const fork = await core.request<Json>(`${endpoint}/${runId}/fork`, 'POST', command('forked'));
    ctx.check('cursor-session', 'fork', 'refuses', fork.status === 409, `fork answered ${fork.status}: ${String(fork.data?.error ?? '').slice(0, 160)}`);

    const planned = core.request<Json>(`${endpoint}/${runId}/turn`, 'POST', command('plan-yes', 'make a plan'));
    const ask = await until<Json>(openAsk, Boolean, 'Cursor’s plan to reach a Need', 10_000);
    const yes = await core.request(`/projects/${projectId}/needs/${ask.id}/resolve`, 'POST', { resolution: 'go-ahead' });
    const accepted = await planned;
    ctx.check(
      'cursor-session',
      'approval',
      'performs',
      yes.status === 200 && accepted.data.response?.text === 'plan accepted; outlined',
      `the plan Cursor presented mid-turn became a Need (“${ask.what}”); go-ahead reached the agent: “${accepted.data.response?.text}”.`,
    );
    const declinedTurn = core.request<Json>(`${endpoint}/${runId}/turn`, 'POST', command('plan-no', 'make a plan'));
    const second_ask = await until<Json>(openAsk, Boolean, 'the second plan to reach a Need', 10_000);
    await core.api(`/projects/${projectId}/needs/${second_ask.id}/resolve`, 'POST', { resolution: 'declined' });
    const rejected = await declinedTurn;
    ctx.assert('a declined plan tells the agent no', rejected.data.response?.text === 'plan rejected', `“${rejected.data.response?.text}”`);

    // The single-turn Cursor text route, as the Console's direct Ask sends it: one fresh ACP
    // process per request, answered and gone.
    const directEvents = await core.events();
    const direct = await core.request<Json>(`/projects/${projectId}/ask`, 'POST', {
      mode: 'ask',
      text: 'How many napkins came?',
      route: 'cursor',
      consent: true,
      threadId: thread.id,
      attachedTo: thread.attachedTo ?? null,
    });
    const answered = direct.data?.turn?.text ?? direct.data?.conversation?.turns?.at(-1)?.text;
    ctx.check(
      'cursor',
      'turn',
      'performs',
      direct.status === 200 && answered === 'answer after 0 earlier turns',
      `a direct Ask on the text route answered ${direct.status}: “${answered ?? JSON.stringify(direct.data).slice(0, 200)}” — a fresh session, no history.`,
    );
    await new Promise((resolve) => setTimeout(resolve, 100));
    directEvents.stop();
    const directDeltas = directEvents.seen.filter((item) => item.event === 'engine-text' && item.data.kind === 'delta');
    ctx.check('cursor', 'stream', 'performs', directDeltas.length > 0, `${directDeltas.length} transient text deltas reached the event stream for the direct Ask.`);
    const busyOn = (run: string) => async () => (await core.api<Json>(`${endpoint}/${run}`)).busy === true;
    const stopTurn = async (run: string, commandId: string, settleMs: number) => {
      const started = Date.now();
      const turn = core.request<Json>(`${endpoint}/${run}/turn`, 'POST', command(commandId, 'hang'));
      await until(busyOn(run), Boolean, `turn ${commandId} to be live`, 10_000);
      // settleMs 0: Stop as soon as the conversation reads busy, as a person pressing Stop right after Send.
      if (settleMs) await new Promise((resolve) => setTimeout(resolve, settleMs));
      const stop = await core.request<Json>(`${endpoint}/${run}/interrupt`, 'POST', { commandId: `stop-${commandId}` });
      const stopAt = Date.now() - started;
      const ended = await turn;
      return { stop, ended, stopAt, endedAt: Date.now() - started };
    };
    const stopDetail = (label: string, result: Awaited<ReturnType<typeof stopTurn>>) =>
      `${label}: Stop at ${result.stopAt} ms answered ${result.stop.status} (acknowledged ${result.stop.data.acknowledged}); the turn ended at ${result.endedAt} ms, ${result.ended.status}${
        result.ended.status === 200 ? ` interrupted=${result.ended.data.interrupted}` : ` ${result.ended.data?.code ?? ''} (“${result.ended.data?.error ?? ''}”)`
      }.`;
    const stopped = (result: Awaited<ReturnType<typeof stopTurn>>) =>
      result.stop.status === 200 && result.stop.data.acknowledged === true && result.ended.status === 200 && result.ended.data.interrupted === true;

    const late = await stopTurn(runId, 'hang-late', 300);
    ctx.check('cursor-session', 'stop', 'performs', stopped(late), stopDetail('Stop once the prompt is running', late));

    // Resume after a restart with the conversation idle.
    await core.restart();
    const resumed = await core.request<Json>(`${endpoint}/${runId}/resume`, 'POST', command('after-restart'));
    const earlier = /answer after (\d+) earlier turns/.exec(resumed.data.response?.text ?? '')?.[1];
    ctx.check(
      'cursor-session',
      'resume',
      'performs',
      resumed.status === 200 && Number(earlier) >= 2 && !resumed.data.continuity,
      `restart while idle, then resume: the saved ACP session was loaded (“${resumed.data.response?.text ?? JSON.stringify(resumed.data).slice(0, 160)}”).`,
    );

    // Resume after a restart that happened while a turn was running. The contract's reconcile note:
    // "A turn a restart interrupted is recorded as not completed and never resent; a loadable session
    // stays resumable". The fixture agent advertises loadSession.
    const lost = core.request<Json>(`${endpoint}/${runId}/turn`, 'POST', command('hang-restart', 'hang')).catch(() => null);
    await until(busyOn(runId), Boolean, 'the turn to be live before the restart', 10_000);
    await new Promise((resolve) => setTimeout(resolve, 300));
    await core.restart();
    await lost;
    const view = await core.api<Json>(`${endpoint}/${runId}`);
    const again = await core.request<Json>(`${endpoint}/${runId}/resume`, 'POST', command('after-live-restart'));
    ctx.check(
      'cursor-session',
      'resume',
      'performs',
      again.status === 200 && Boolean(again.data.response?.text),
      again.status === 200
        ? `restart while a turn ran, then resume: the loadable session was resumed (“${again.data.response?.text}”).`
        : `restart while a turn ran, then resume: refused ${again.status} ${again.data?.code ?? ''} (“${again.data?.error ?? ''}”); the conversation reads ${view.continuity?.state}: “${view.continuity?.detail}” — though the agent advertises loadSession.`,
    );
    ctx.evidence.afterLiveRestart = { status: again.status, code: again.data?.code ?? null, continuity: view.continuity?.state ?? null };

    // Stop pressed as soon as the turn reads busy, on a fresh conversation in the same thread.
    const fresh = await core.request<Json>(endpoint, 'POST', command('fresh'));
    if (fresh.status === 200) {
      const early = await stopTurn(fresh.data.runId, 'hang-early', 0);
      ctx.check('cursor-session', 'stop', 'performs', stopped(early), stopDetail('Stop as soon as the turn reads busy', early));
      ctx.evidence.earlyStop = { stopAt: early.stopAt, endedAt: early.endedAt, status: early.ended.status, code: early.ended.data?.code ?? null };
    } else ctx.assert('a fresh conversation starts in the same thread', false, `${fresh.status}: ${JSON.stringify(fresh.data).slice(0, 200)}`);
    ctx.evidence.runId = runId;
    ctx.evidence.nativeSession = second.data.nativeSession?.id ?? null;
  },
};

// --- a kept OpenCode session, over the fixture `opencode serve` -----------------------

const OPENCODE_FIXTURE = path.join(REPO, 'tests', 'fixtures', 'opencode-session-server.mjs');
const OPENCODE_MODEL = 'opencode-go/go-model';

const opencodeSession: Scenario = {
  id: 'opencode-kept-session',
  title: 'A kept OpenCode session: turns, a message held and sent after the running turn, resume after a restart, fork, and Stop mid-turn',
  fixture: 'opencode: tests/fixtures/opencode-session-server.mjs, a real HTTP+SSE server standing in for `opencode serve`',
  async run(ctx) {
    // Where the fixture keeps its sessions, as OpenCode does under XDG_DATA_HOME; restored afterwards.
    const saved = { cache: process.env.XDG_CACHE_HOME, data: process.env.XDG_DATA_HOME };
    process.env.XDG_CACHE_HOME = path.join(ctx.root, 'no-opencode-cache');
    process.env.XDG_DATA_HOME = path.join(ctx.root, 'opencode-data');
    try {
      let mode = 'delayed';
      const service = () =>
        new EngineService(path.join(ctx.root, 'engines'), {
          discover: async () => [
            {
              id: 'opencode',
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
              installedVersion: TESTED_VERSIONS.opencode,
              location: process.execPath,
              disclosure: [],
            },
          ],
          version: async () => TESTED_VERSIONS.opencode,
          adapter: (_engine, _location, cwd) =>
            new OpenCodeAdapter('opencode', cwd, {
              spawn: (_command, args, options) =>
                spawnChild(process.execPath, [OPENCODE_FIXTURE, args[args.indexOf('--port') + 1], mode], options) as ChildProcessWithoutNullStreams,
              startupTimeoutMs: 5_000,
              requestTimeoutMs: 5_000,
            }),
        });
      const core = await ctx.core(() => ({ engineService: service() }));
      await core.api('/ai/discover', 'POST', { consent: true });
      await core.api('/ai/check/opencode', 'POST', {});
      await core.api('/ai/select', 'POST', { engine: 'opencode', model: OPENCODE_MODEL });
      const project = await core.api<Json>('/projects', 'POST', { name: 'OpenCode session' });
      const projectId = project.id as string;
      await core.api(`/projects/${projectId}/cloud-sharing`, 'PUT', {
        expectedVersion: 0,
        routes: ['opencode'],
        documents: [],
        shareConversationHistory: true,
        shareReviewPackets: false,
      });
      const thread = await core.api<Json>(`/projects/${projectId}/threads`, 'POST', {});
      const endpoint = `/projects/${projectId}/opencode-sessions`;
      const command = (commandId: string, text = commandId) => ({ commandId, threadId: thread.id, text, mode: 'ask', sources: [], consent: true });
      const events = await core.events();
      let runId = '',
        sessionRef = '';
      try {
        const first = await core.request<Json>(endpoint, 'POST', command('first'));
        runId = first.data.runId;
        sessionRef = first.data.nativeSession?.opaqueRef ?? '';
        ctx.check(
          'opencode-session',
          'turn',
          'performs',
          first.status === 200 && first.data.response?.text === `answer:first (turn 1 of ${sessionRef})`,
          `the first turn answered ${first.status}: “${first.data.response?.text ?? JSON.stringify(first.data).slice(0, 160)}”.`,
        );
        await new Promise((resolve) => setTimeout(resolve, 100));
        const deltas = events.seen.filter((item) => item.event === 'engine-text' && item.data.threadId === thread.id && item.data.kind === 'delta');
        ctx.check('opencode-session', 'stream', 'performs', deltas.length > 0, `${deltas.length} transient text deltas reached the event stream.`);
      } finally {
        events.stop();
      }
      if (!runId) return;
      const second = await core.request<Json>(`${endpoint}/${runId}/turn`, 'POST', command('second'));
      ctx.check(
        'opencode-session',
        'queue',
        'performs',
        second.status === 200 && second.data.response?.text === `answer:second (turn 2 of ${sessionRef})`,
        `a follow-up went to the same OpenCode session: “${second.data.response?.text ?? second.status}”.`,
      );
      // Steer is declared `host`: held while a turn runs, then sent as the next turn of the same session.
      const running = core.request<Json>(`${endpoint}/${runId}/turn`, 'POST', command('third'));
      const held = await until(
        () => core.api<Json>(`${endpoint}/${runId}/steer`, 'POST', { commandId: 'steer-1', text: 'also this' }),
        (ack) => ack.state === 'pending' || ack.state === 'delivered',
        'the steer to be held behind the running turn',
        5_000,
      ).catch((error: unknown) => ({ state: String(error) }));
      await running;
      const delivered = await until(
        () => core.api<Json>(`${endpoint}/${runId}`),
        (status) => (status.steering ?? []).some((ack: Json) => ack.commandId === 'steer-1' && ack.state !== 'pending'),
        'the held message to be sent',
        10_000,
      ).catch(() => null);
      const ack = (delivered?.steering ?? []).find((item: Json) => item.commandId === 'steer-1');
      const turns = ((await state(core, projectId)).conversations.find((item: Json) => item.id === thread.id)?.turns ?? []) as Json[];
      ctx.check(
        'opencode-session',
        'steer',
        'performs',
        held.state === 'pending' && ack?.state === 'delivered' && turns.some((turn) => turn.text === 'also this'),
        `a message sent while a turn ran was ${held.state}, then ${ack?.state ?? 'never sent'}; the thread shows it as its own turn (${turns.some((turn) => turn.text === 'also this')}).`,
      );

      await core.api(`${endpoint}/${runId}/close`, 'POST', { commandId: 'close-1' });
      mode = 'ok';
      await core.restart();
      const resumed = await core.request<Json>(`${endpoint}/${runId}/resume`, 'POST', command('resumed'));
      ctx.check(
        'opencode-session',
        'resume',
        'performs',
        resumed.status === 200 && resumed.data.nativeSession?.opaqueRef === sessionRef && /answer:resumed \(turn \d+ of /.test(resumed.data.response?.text ?? ''),
        `closed, restarted, then resumed the same OpenCode session: “${resumed.data.response?.text ?? JSON.stringify(resumed.data).slice(0, 160)}”.`,
      );
      const fork = await core.request<Json>(`${endpoint}/${runId}/fork`, 'POST', command('forked'));
      ctx.check(
        'opencode-session',
        'fork',
        'performs',
        fork.status === 200 && fork.data.runId !== runId && fork.data.nativeSession?.opaqueRef !== sessionRef && fork.data.nativeSession?.lineageId === resumed.data.nativeSession?.lineageId,
        `fork started ${fork.data.runId ?? 'nothing'} on a new OpenCode session in the same lineage: “${fork.data.response?.text ?? JSON.stringify(fork.data).slice(0, 160)}”.`,
      );

      mode = 'slow';
      await core.restart();
      // In slow mode a turn streams part of its answer and then waits to be aborted. Two Stops:
      // one once the session reads connected, and one pressed while it still reads busy but is
      // still opening (the kept `opencode serve` starting), as a person pressing Stop right after Send.
      const stopTurn = async (commandId: string, when: 'connected' | 'opening') => {
        const slowId = opencodeSessionRunId(projectId, commandId);
        const started = Date.now();
        const turn = core.request<Json>(endpoint, 'POST', command(commandId));
        const seen = await until(
          async () => (await core.request<Json>(`${endpoint}/${slowId}`)).data,
          (status) => status?.busy === true && (when === 'opening' || status.connected === true),
          `turn ${commandId} to be ${when === 'opening' ? 'live' : 'connected'}`,
          10_000,
        );
        const stop = await core.request<Json>(`${endpoint}/${slowId}/interrupt`, 'POST', { commandId: `stop-${commandId}` });
        const stopAt = Date.now() - started;
        const ended = await turn;
        const passed = stop.status === 200 && stop.data.acknowledged === true && ended.status === 200 && ended.data.interrupted === true;
        const detail = `Stop while the session reads busy and ${seen.connected ? 'connected' : 'not yet connected'}, at ${stopAt} ms: ${stop.status} (${
          stop.status === 200 ? `acknowledged ${stop.data.acknowledged}` : `${stop.data?.code ?? ''}: ${stop.data?.error ?? ''}`
        }); the turn ended at ${Date.now() - started} ms, ${ended.status}${
          ended.status === 200 ? ` interrupted=${ended.data.interrupted}` : ` ${ended.data?.code ?? ''} (“${ended.data?.error ?? ''}”)`
        }.`;
        ctx.check('opencode-session', 'stop', 'performs', passed, detail);
        return { stopAt, status: ended.status, code: ended.data?.code ?? null };
      };
      ctx.evidence.stopConnected = await stopTurn('slow-connected', 'connected');
      ctx.evidence.stopOpening = await stopTurn('slow-opening', 'opening');
      ctx.evidence.runId = runId;
      ctx.evidence.forkRunId = fork.data.runId ?? null;
    } finally {
      if (saved.cache === undefined) delete process.env.XDG_CACHE_HOME;
      else process.env.XDG_CACHE_HOME = saved.cache;
      if (saved.data === undefined) delete process.env.XDG_DATA_HOME;
      else process.env.XDG_DATA_HOME = saved.data;
    }
  },
};

// --- the Claude Code native session, over a scripted stream-json child ------------------

const CLAUDE_FIXTURE = path.join(REPO, 'tests', 'fixtures', 'claude-stream-json.mjs');

const claudeSession: Scenario = {
  id: 'claude-code-native-session',
  title: 'A Claude Code thread: a turn, a follow-up in the same process, a message queued behind a running answer, Stop mid-turn, and resume after a restart',
  fixture: 'claude-code: tests/fixtures/claude-stream-json.mjs, a stream-json child standing in for the Claude Code CLI (the H03 route tests’ script)',
  async run(ctx) {
    const known = path.join(ctx.root, 'known.txt');
    const log = path.join(ctx.root, 'log.jsonl');
    const launches: string[][] = [];
    const launch: ProcessFactory = (options) => {
      launches.push(options.args);
      // A fork is a new session Claude names itself (as in tests/claude-session.test.ts's launcher).
      const fork = options.args.includes('--fork-session');
      const resume = options.args.includes('--resume') && !fork;
      const session = fork ? randomUUID() : options.args[options.args.indexOf(resume ? '--resume' : '--session-id') + 1];
      return openProcess({ ...options, file: process.execPath, args: [CLAUDE_FIXTURE, session, known, log, resume ? 'resume' : 'new'], timeoutMs: 10_000 });
    };
    await fs.mkdir(path.join(ctx.root, 'transport'), { recursive: true });
    const service = () => {
      const transport = new ClaudeAdapter('claude.exe', path.join(ctx.root, 'transport'), {
        launch,
        account: async () => ({ loggedIn: true, authMethod: 'claude.ai', email: 'owner@example.com' }),
      });
      const adapter: PersistentTextAdapter<ClaudeSessionCheckpoint> = {
        id: 'claude-code',
        contract: routeContractFor('claude-code'),
        sessionContract: routeContractFor('claude-code-session'),
        inspect: async () => ({
          authentication: 'signed-in',
          accountRoute: 'claude-code:claude.ai',
          detail: 'Fixture only',
          models: [{ slug: 'sonnet', name: 'sonnet', description: '', efforts: [], defaultEffort: null }],
        }),
        generate: async () => {
          throw new Error('Conversation requests must use the native transport.');
        },
        openSession: (input, options) => transport.openSession(input, options),
      };
      return new EngineService(path.join(ctx.root, 'engines'), {
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
        adapter: () => adapter,
      });
    };
    const core = await ctx.core(() => ({ engineService: service() }));
    await core.api('/ai/discover', 'POST', { consent: true });
    await core.api('/ai/check/claude-code', 'POST', {});
    await core.api('/ai/select', 'POST', { engine: 'claude-code', model: 'sonnet' });
    const project = await core.api<Json>('/projects', 'POST', { name: 'Linen service' });
    const projectId = project.id as string;
    await core.api(`/projects/${projectId}/cloud-sharing`, 'PUT', {
      expectedVersion: 0,
      routes: ['claude-code'],
      documents: [],
      shareConversationHistory: true,
      shareReviewPackets: false,
    });
    const thread = await core.api<Json>(`/projects/${projectId}/threads`, 'POST', {});
    await core.api(`/projects/${projectId}/threads/${thread.id}`, 'PUT', { engine: 'claude-code' });
    const messages = `/projects/${projectId}/threads/${thread.id}/messages`;
    const send = (commandId: string, text: string, extra: Record<string, unknown> = {}) =>
      core.request<Json>(messages, 'POST', { commandId, text, mode: 'auto', sources: [], consent: true, ...extra });
    const view = () => core.api<Json>(`/projects/${projectId}/threads/${thread.id}/native-session`);
    const said = async () =>
      (await fs.readFile(log, 'utf8').catch(() => ''))
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as { pid: number; turn: string; resumed: string });

    const first = await send('m-one', 'Good morning');
    ctx.check(
      'claude-code-session',
      'turn',
      'performs',
      first.status === 200 && first.data.answerText === 'Answer to Good morning',
      `the first turn answered ${first.status}: “${first.data.answerText ?? JSON.stringify(first.data).slice(0, 160)}”.`,
    );
    const second = await send('m-two', 'Where is the linen?');
    const pids = new Set((await said()).map((line) => line.pid));
    ctx.check(
      'claude-code-session',
      'queue',
      'performs',
      second.status === 200 && second.data.answerText === 'Answer to Where is the linen?' && pids.size === 1,
      `a follow-up was answered by the same live process (${pids.size} process): “${second.data.answerText ?? second.status}”.`,
    );
    const running = send('m-three', 'Plan the week [slow]');
    await until(async () => (await view()).busy === true, Boolean, 'the slow answer to be running', 10_000);
    const queued = send('m-four', 'Also check linen', { queued: true });
    await until(async () => (await view()).queued.length === 1, Boolean, 'the message to be queued', 10_000);
    const [ranFirst, ranNext] = await Promise.all([running, queued]);
    const order = (await said()).map((line) => line.turn);
    ctx.check(
      'claude-code-session',
      'steer',
      'performs',
      ranFirst.data.answerText === 'Answer to Plan the week [slow]' &&
        ranNext.data.answerText === 'Answer to Also check linen' &&
        order.indexOf('Also check linen') === order.indexOf('Plan the week [slow]') + 1,
      `a message sent while an answer ran was held and sent as the next turn of the same process (${(await view()).queued.map((item: Json) => item.state).join(', ')}).`,
    );
    const hanging = send('m-five', 'Think hard [hang]');
    await until(async () => (await said()).some((line) => line.turn === 'Think hard [hang]'), Boolean, 'the turn to reach Claude Code', 10_000);
    const stop = await core.request<Json>(`${messages}/m-five/interrupt`, 'POST', {});
    const stopped = await hanging;
    ctx.check(
      'claude-code-session',
      'stop',
      'performs',
      stop.status === 200 && stop.data.stop === 'interrupted' && stopped.data.interrupted === true && (await view()).continuity?.state === 'live',
      `Stop answered ${stop.status} (${stop.data.stop}); the turn ended interrupted=${stopped.data.interrupted}; the session stayed ${(await view()).continuity?.state}.`,
    );
    await core.restart();
    const before = await view();
    const resumed = await send('m-six', 'Where were we?');
    const last = (await said()).at(-1);
    ctx.check(
      'claude-code-session',
      'resume',
      'performs',
      before.continuity?.state === 'resumable' && resumed.data.answerText === 'Answer to Where were we?' && last?.resumed === 'resume' && (launches.at(-1) ?? []).includes('--resume'),
      `after a restart the thread read ${before.continuity?.state}; the next message resumed the session by id (--resume: ${(launches.at(-1) ?? []).includes('--resume')}).`,
    );
    // Fork is declared native: --resume plus --fork-session starts a child run. The session route
    // takes ask or plan, and a fork keeps its origin's instructions, so the lineage forked is an Ask one.
    const sessionCommand = (commandId: string, text: string) => ({ commandId, threadId: thread.id, text, mode: 'ask', sources: [], consent: true });
    const asked = await core.request<Json>(`/projects/${projectId}/claude-sessions`, 'POST', sessionCommand('s-ask', 'A quick question'));
    const fromMessages = await core.request<Json>(`/projects/${projectId}/claude-sessions/${second.data.runId}/fork`, 'POST', sessionCommand('m-fork-auto', 'Fork the auto conversation'));
    ctx.evidence.forkOfAutoLineage = { status: fromMessages.status, code: fromMessages.data?.code ?? null, error: fromMessages.data?.error ?? null };
    const fork = await core.request<Json>(`/projects/${projectId}/claude-sessions/${asked.data.runId}/fork`, 'POST', {
      commandId: 'm-fork',
      threadId: thread.id,
      text: 'Try another way',
      mode: 'ask',
      sources: [],
      consent: true,
    });
    const forkLaunch = launches.at(-1) ?? [];
    ctx.check(
      'claude-code-session',
      'fork',
      'performs',
      fork.status === 200 && fork.data.runId !== asked.data.runId && forkLaunch.includes('--fork-session') && fork.data.response?.text === 'Answer to Try another way',
      fork.status === 200
        ? `fork started ${fork.data.runId} with --resume and --fork-session (${forkLaunch.includes('--fork-session')}): “${fork.data.response?.text}”.`
        : `fork answered ${fork.status}: ${fork.data?.code ?? ''} “${fork.data?.error ?? JSON.stringify(fork.data).slice(0, 200)}”.`,
    );
    ctx.evidence.launches = launches.length;
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
  cursorSession,
  opencodeSession,
  claudeSession,
];
