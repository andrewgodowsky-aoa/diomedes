/**
 * H10: guidance maintenance. Diomedes reads repeated corrections off the
 * record, proposes one line for the instruction file that governs them with
 * the evidence and a replayed evaluation, and never writes on its own. A
 * person's approval is one recorded, base-hash-checked write and one record in
 * an append-only digest chain; a decline suppresses the proposal until new
 * evidence arrives; any revision rolls back in one step as a new record; H11
 * discovery and delivery follow each revision; and an open conversation is
 * never reset by one (DIO-102).
 */
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { Store, hash } from '../server/store.js';
import { activatePack } from '../server/capability-packs.js';
import { assembleInstructions } from '../server/harness/instruction-delivery.js';
import {
  collectGuidanceEvidence,
  GuidanceMaintenance,
  revisionDigest,
  verifyGuidanceChain,
} from '../server/guidance.js';
import { createApp } from '../server/app.js';
import { directOrigin } from '../shared/attribution.js';
import { buildDiff } from '../shared/text-diff.js';
import {
  appendGuidanceLine,
  canonicalJson,
  commentKind,
  GUIDANCE_THRESHOLDS,
  guidanceVerdict,
  isSuppressed,
  type GuidanceRevision,
} from '../shared/guidance.js';
import type { SupervisionRecord } from '../shared/supervision.js';
import type { ReviewComment } from '../shared/review-comments.js';
import type { Conversation, ProjectState, Session, Task } from '../shared/types.js';

const PACK = 'diomedes.software-engineering' as const;
const WORKER = directOrigin({ engine: 'codex', reportedModel: 'gpt-6-astra', version: '0.153.4' });
const AGENTS = '# Kitchen rules\n\nKeep prices in dollars.\n';
const REPORT = 'reports/summary.md';
const ORIGINAL_REPORT = '# Summary\n\nWritten by the manager.\n';

let root: string;
let store: Store;
let id: string;
let folder: string;
let guidance: GuidanceMaintenance;
let runs = 0;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'diomedes-h10-'));
  store = new Store(path.join(root, 'data'), path.join(root, 'projects'));
  await store.init();
  folder = path.join(root, 'repo');
  await fs.mkdir(path.join(folder, 'reports'), { recursive: true });
  await fs.mkdir(path.join(folder, 'drafts'), { recursive: true });
  await fs.writeFile(path.join(folder, 'AGENTS.md'), AGENTS, 'utf8');
  await fs.writeFile(path.join(folder, REPORT), ORIGINAL_REPORT, 'utf8');
  const created = await store.createProject('Kitchen', folder);
  id = created.id;
  await activatePack(store, id, PACK);
  guidance = new GuidanceMaintenance(store);
  runs = 0;
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

const locked = <T>(action: () => Promise<T>) => store.locked(action);
const disk = (name: string) => fs.readFile(path.join(folder, name), 'utf8');

/** One run (task + session) that writes `file`; a person then undoes or keeps it, as the review route does. */
async function run(file: string, decision: 'undo' | 'keep' | 'waiting', options: { sample?: boolean } = {}) {
  runs++;
  const taskId = `T${runs}`;
  const sessionId = `S${runs}`;
  const state = store.state(id);
  const task: Task = {
    id: taskId,
    name: `Run ${runs}`,
    description: '',
    from: null,
    owner: 'diomedes',
    state: 'working',
    reason: null,
    needId: null,
    sessionIds: [sessionId],
    changeIds: [],
    createdBy: 'you',
    createdAt: `2026-09-24T00:0${runs % 10}:00.000Z`,
    moves: [],
  };
  const session: Session = {
    id: sessionId,
    taskId,
    route: 'codex',
    origin: WORKER,
    state: 'working',
    startedAt: `2026-09-24T00:0${runs % 10}:01.000Z`,
    endedAt: null,
    sample: options.sample ?? false,
    log: [],
    entryIds: [],
    needId: null,
    engine: { name: 'codex', model: 'gpt-6-astra', worker: 1, branch: null, context: null, events: 0, verified: true },
  };
  state.tasks.push(task);
  state.sessions.push(session);
  await store.persist(state);
  const before = await store.current(id, file);
  await fs.mkdir(path.dirname(path.join(folder, file)), { recursive: true });
  await locked(() =>
    store.writeRecorded(id, [{ path: file, text: `${before ?? ''}Run ${runs} rewrote this.\n`, expected: hash(before) }], {
      actor: 'diomedes-with-ok',
      kind: 'changed',
      sessionId,
      taskId,
      origin: WORKER,
      review: true,
    }),
  );
  const written = store.state(id);
  const change = written.changes.find((item) => item.sessionId === sessionId)!;
  const stored = written.sessions.find((item) => item.id === sessionId)!;
  stored.state = 'done';
  stored.endedAt = '2026-09-24T01:00:00.000Z';
  await store.persist(written);
  if (decision === 'undo') await locked(() => store.restore(id, change.entryId, [change.path]));
  const after = store.state(id);
  const fresh = after.changes.find((item) => item.id === change.id)!;
  if (decision !== 'waiting') fresh.state = decision === 'undo' ? 'undone' : 'kept';
  await store.persist(after);
  return { sessionId, taskId, changeId: change.id };
}

const proposals = () => locked(() => guidance.proposals(id));

describe('the proposal threshold table', () => {
  test('each kind has the threshold the table names, and nothing below it is proposed', () => {
    expect(GUIDANCE_THRESHOLDS).toEqual({ 'undone-write': 3, 'scope-drift': 3, 'review-comment': 3 });
  });

  test.each([
    [0, false],
    [1, false],
    [2, false],
    [3, true],
    [4, true],
  ])('undone writes by %i distinct runs → proposal %s', async (count, proposed) => {
    for (let i = 0; i < count; i++) await run(REPORT, 'undo');
    const found = (await proposals()).filter((item) => item.pattern === `undone-write:${REPORT}`);
    expect(found.length === 1).toBe(proposed);
    if (proposed) expect(found[0].occurrences).toBe(count);
  });

  test('sample runs and changes still waiting or kept are not corrections', async () => {
    await run(REPORT, 'undo', { sample: true });
    await run(REPORT, 'undo', { sample: true });
    await run(REPORT, 'undo', { sample: true });
    await run(REPORT, 'keep');
    await run(REPORT, 'waiting');
    expect(await proposals()).toEqual([]);
  });

  test('H15 scope drift a person stopped or redirected, three distinct runs, proposes the folder', async () => {
    const answers: SupervisionRecord['answer'][] = ['stop', 'redirect', 'continue', 'stop'];
    for (const answer of answers) {
      const { sessionId, taskId } = await run('drafts/notes.md', 'waiting');
      const state = store.state(id);
      state.supervision = [
        ...(state.supervision ?? []),
        {
          protocolVersion: 1,
          id: `SV-${sessionId}`,
          action: 'answer',
          sessionId,
          taskId,
          code: 'scope-drift',
          issueKey: 'scope:drafts',
          severity: 'critical',
          summary: 'it started writing outside the selected folder',
          evidence: [],
          evidenceDigest: 'x',
          at: '2026-09-24T02:00:00.000Z',
          actor: 'you',
          reason: 'You answered.',
          answer,
        } as unknown as SupervisionRecord,
      ];
      await store.persist(state);
    }
    const found = (await proposals()).find((item) => item.pattern === 'scope-drift:drafts/');
    expect(found).toBeTruthy();
    // "Continue" is not a correction: three of the four answers count.
    expect(found!.occurrences).toBe(3);
    expect(found!.line).toBe('Do not write to `drafts/`.');
    expect(found!.evaluation.verdict).toBe('improved');
  });

  test('the same review comment on three changes proposes it; prose is honestly not evaluable', async () => {
    const changes = [];
    for (let i = 0; i < 3; i++) changes.push(await run(REPORT, 'keep'));
    const state = store.state(id);
    state.reviewComments = changes.map(
      (change, index): ReviewComment => ({
        id: `RC${index}`,
        target: { kind: 'change', changeId: change.changeId, path: REPORT, sha: 'a'.repeat(64) },
        taskId: change.taskId,
        anchor: { hunk: 0, side: 'new', line: 3, quote: 'Run rewrote this.' },
        text: index === 1 ? '  Sign every summary with the date!  ' : 'Sign every summary with the date.',
        by: 'you',
        at: `2026-09-24T03:0${index}:00.000Z`,
        resolved: null,
        sent: null,
      }),
    );
    await store.persist(state);
    expect(commentKind('  Sign every summary with the date!  ')).toBe(commentKind('Sign every summary with the date.'));
    const found = (await proposals()).find((item) => item.kind === 'review-comment');
    expect(found?.line).toBe('Sign every summary with the date.');
    expect(found?.evidence.map((item) => item.ref)).toEqual(['RC0', 'RC1', 'RC2']);
    expect(found?.evaluation.verdict).toBe('not-evaluable');
    expect(found?.evaluation.cases).toEqual([]);
  });
});

describe('a proposal', () => {
  test('carries its evidence, a P06 diff and a replayed evaluation, and writes nothing', async () => {
    const seeded = [await run(REPORT, 'undo'), await run(REPORT, 'undo'), await run(REPORT, 'undo')];
    const historyBefore = store.state(id).history.length;
    const [proposal] = await proposals();
    expect(proposal.file).toMatchObject({ path: 'AGENTS.md', sha: hash(AGENTS), scope: '' });
    expect(proposal.line).toBe(`Do not edit \`${REPORT}\`.`);
    expect(proposal.after).toBe(appendGuidanceLine(AGENTS, proposal.line));
    expect(proposal.evidence.map((item) => item.ref).sort()).toEqual(seeded.map((item) => item.changeId).sort());
    expect(proposal.evidence.every((item) => item.kind === 'undone-write' && item.path === REPORT)).toBe(true);
    expect(proposal.proposedBy).toBe('diomedes');
    const diff = buildDiff({ path: 'AGENTS.md', before: proposal.before, after: proposal.after });
    expect(diff.header).toBe('1 line added in AGENTS.md');
    // Replayed through the H15 instruction check: every corrected run is flagged with it, none without.
    expect(proposal.evaluation).toMatchObject({ verdict: 'improved', route: 'recorded-replay', gained: 3, lost: 0 });
    expect(proposal.evaluation.cases.map((item) => [item.role, item.without, item.with])).toEqual([
      ['targeted', false, true],
      ['targeted', false, true],
      ['targeted', false, true],
    ]);
    // Proposing wrote nothing.
    expect(await disk('AGENTS.md')).toBe(AGENTS);
    expect(store.state(id).history.length).toBe(historyBefore);
    expect(store.state(id).guidance).toBeUndefined();
    // The same evidence is the same proposal.
    expect((await proposals())[0].id).toBe(proposal.id);
  });

  test('the evaluation is worse when the line would also flag a run whose write you kept', async () => {
    await run(REPORT, 'undo');
    await run(REPORT, 'undo');
    await run(REPORT, 'keep');
    await run(REPORT, 'undo');
    const [proposal] = await proposals();
    expect(proposal.evaluation).toMatchObject({ verdict: 'worse', gained: 3, lost: 1 });
    expect(proposal.evaluation.summary).toContain('1 of the 1 you kept');
  });

  test('the verdict table', () => {
    const t = (without: boolean, withIt: boolean) => ({ sessionId: 's', role: 'targeted' as const, without, with: withIt });
    const c = (without: boolean, withIt: boolean) => ({ sessionId: 'c', role: 'control' as const, without, with: withIt });
    expect(guidanceVerdict([]).verdict).toBe('not-evaluable');
    expect(guidanceVerdict([c(false, true)]).verdict).toBe('not-evaluable');
    expect(guidanceVerdict([t(false, true)]).verdict).toBe('improved');
    expect(guidanceVerdict([t(false, false)]).verdict).toBe('unchanged');
    expect(guidanceVerdict([t(true, true)]).verdict).toBe('unchanged');
    expect(guidanceVerdict([t(false, true), t(false, true), c(false, true)]).verdict).toBe('worse');
    expect(guidanceVerdict([t(false, true), c(true, true)]).verdict).toBe('improved');
  });

  test('a file that already forbids the target is not proposed again', async () => {
    await fs.writeFile(path.join(folder, 'AGENTS.md'), `${AGENTS}- Never edit \`reports/\`.\n`, 'utf8');
    for (let i = 0; i < 3; i++) await run(REPORT, 'undo');
    expect(await proposals()).toEqual([]);
  });

  test('the nearest instruction file whose folder holds the target is the one revised, path relative to it', async () => {
    await fs.mkdir(path.join(folder, 'kitchen'), { recursive: true });
    await fs.writeFile(path.join(folder, 'kitchen', 'AGENTS.md'), '# Kitchen folder\n', 'utf8');
    for (let i = 0; i < 3; i++) await run('kitchen/prep.md', 'undo');
    const [proposal] = await proposals();
    expect(proposal.file).toMatchObject({ path: 'kitchen/AGENTS.md', scope: 'kitchen' });
    expect(proposal.line).toBe('Do not edit `prep.md`.');
    expect(proposal.evaluation.verdict).toBe('improved');
  });

  test('with no instruction file loaded there is nothing to revise, so nothing is proposed', async () => {
    await fs.rm(path.join(folder, 'AGENTS.md'));
    for (let i = 0; i < 3; i++) await run(REPORT, 'undo');
    expect(collectGuidanceEvidence(store.state(id))[0].occurrences.size).toBe(3);
    expect(await proposals()).toEqual([]);
  });
});

describe('the decline-suppression rule', () => {
  test('a decline suppresses the same proposal until new evidence arrives, across a restart', async () => {
    for (let i = 0; i < 3; i++) await run(REPORT, 'undo');
    const [proposal] = await proposals();
    const decline = await locked(() => guidance.decline(id, proposal.id));
    expect(decline).toMatchObject({ pattern: proposal.pattern, by: 'you', via: 'decline' });
    expect(decline.evidenceRefs).toEqual(proposal.evidence.map((item) => item.ref));
    expect(await proposals()).toEqual([]);
    expect(await disk('AGENTS.md')).toBe(AGENTS);

    // A restart keeps the decline.
    store = new Store(path.join(root, 'data'), path.join(root, 'projects'));
    await store.init();
    guidance = new GuidanceMaintenance(store);
    expect(await proposals()).toEqual([]);

    // New evidence: a fourth run undone. The proposal returns with all four.
    await run(REPORT, 'undo');
    const [again] = await proposals();
    expect(again.pattern).toBe(proposal.pattern);
    expect(again.occurrences).toBe(4);
    expect(again.id).not.toBe(proposal.id);
  });

  test('suppression is exact: a subset of declined refs is suppressed, one new ref is not', () => {
    const declines = [
      { pattern: 'p', proposalId: 'x', evidenceRefs: ['a', 'b', 'c'], at: '', by: 'you' as const, via: 'decline' as const },
    ];
    expect(isSuppressed(declines, 'p', ['a', 'b'])).toBe(true);
    expect(isSuppressed(declines, 'p', ['a', 'b', 'c'])).toBe(true);
    expect(isSuppressed(declines, 'p', ['a', 'b', 'c', 'd'])).toBe(false);
    expect(isSuppressed(declines, 'q', ['a'])).toBe(false);
    expect(isSuppressed([], 'p', ['a'])).toBe(false);
  });

  test('declining a proposal that has changed refuses and records nothing', async () => {
    for (let i = 0; i < 3; i++) await run(REPORT, 'undo');
    await expect(locked(() => guidance.decline(id, 'not-a-proposal'))).rejects.toMatchObject({ status: 409 });
    expect(store.state(id).guidance).toBeUndefined();
  });
});

describe('approval and the signed revision chain', () => {
  async function approveOne() {
    for (let i = 0; i < 3; i++) await run(REPORT, 'undo');
    const [proposal] = await proposals();
    const revision = await locked(() => guidance.approve(id, proposal.id, proposal.file.sha));
    return { proposal, revision };
  }

  test('approval writes exactly the shown text, attributed truthfully, and H11 follows it', async () => {
    const { proposal, revision } = await approveOne();
    expect(await disk('AGENTS.md')).toBe(proposal.after);
    expect(revision).toMatchObject({
      seq: 1,
      action: 'apply',
      path: 'AGENTS.md',
      previousSha: hash(AGENTS),
      newSha: hash(proposal.after),
      author: { kind: 'proposal', proposalId: proposal.id, proposedBy: 'diomedes', approvedBy: 'you' },
      prevDigest: null,
      scheme: 'sha256-chain-v1',
      pattern: proposal.pattern,
      rollbackOf: null,
    });
    expect(revision.evidence).toEqual(proposal.evidence);
    expect(revision.evaluation?.verdict).toBe('improved');
    const state = store.state(id);
    const entry = state.history.find((item) => item.id === revision.historyEntryId)!;
    expect(entry).toMatchObject({ actor: 'you', kind: 'guidance-revision', sessionId: null, taskId: null });
    expect(entry.sentence).toBe(`You approved Diomedes' proposed revision to AGENTS.md: “Do not edit \`${REPORT}\`.”`);
    // H11: the record and its rule now name the new bytes, and the next run is sent them.
    const record = state.instructionFiles!.find((item) => item.path === 'AGENTS.md')!;
    expect(record.sha).toBe(revision.newSha);
    const delivery = await assembleInstructions({
      state,
      routeId: 'codex',
      agentRole: 'Diomedes build file proposal writer',
      budgetBytes: 32 * 1024,
      workPaths: [],
      at: '2026-09-24T05:00:00.000Z',
    });
    expect(delivery.delivery?.files[0]).toMatchObject({ path: 'AGENTS.md', sha: revision.newSha, state: 'sent' });
    // Applied, the pattern is covered by the file and is not proposed again.
    expect(await proposals()).toEqual([]);
  });

  test('a file changed after the proposal was shown refuses, and nothing is written or recorded', async () => {
    for (let i = 0; i < 3; i++) await run(REPORT, 'undo');
    const [proposal] = await proposals();
    await fs.writeFile(path.join(folder, 'AGENTS.md'), `${AGENTS}Someone else's line.\n`, 'utf8');
    await expect(locked(() => guidance.approve(id, proposal.id, proposal.file.sha))).rejects.toMatchObject({
      status: 409,
    });
    expect(await disk('AGENTS.md')).toBe(`${AGENTS}Someone else's line.\n`);
    expect(store.state(id).guidance).toBeUndefined();
  });

  test('tampering is detected, wherever it is, and blocks further revisions', async () => {
    const { revision } = await approveOne();
    const second = await locked(() => guidance.rollback(id, revision.id, undefined));
    const chain = store.state(id).guidance!.revisions;
    expect(verifyGuidanceChain(chain)).toEqual({ ok: true, length: 2, head: second.digest });
    expect(second.prevDigest).toBe(revision.digest);
    expect(revisionDigest(second)).toBe(second.digest);

    const cases: [string, (list: GuidanceRevision[]) => GuidanceRevision[], string][] = [
      ['an edited text', (l) => [{ ...l[0], newText: `${l[0].newText}x` }, l[1]], 'changed after it was recorded'],
      [
        'an edited text re-digested',
        (l) => {
          const edited = { ...l[0], newText: `${l[0].newText}x` };
          return [{ ...edited, digest: revisionDigest(edited) }, l[1]];
        },
        'text does not match its digest',
      ],
      ['a changed author', (l) => [{ ...l[0], author: { kind: 'person', who: 'you' } }, l[1]], 'changed after'],
      ['a dropped first record', (l) => [l[1]], 'out of order'],
      ['a reordered chain', (l) => [l[1], l[0]], 'out of order'],
      [
        'a renumbered drop',
        (l) => {
          const moved = { ...l[1], seq: 1 };
          return [{ ...moved, digest: revisionDigest(moved) }];
        },
        'does not follow',
      ],
      ['a forged digest', (l) => [l[0], { ...l[1], digest: 'f'.repeat(64) }], 'changed after'],
    ];
    for (const [name, tamper, reason] of cases) {
      const result = verifyGuidanceChain(tamper(structuredClone(chain) as GuidanceRevision[]));
      expect(result.ok, name).toBe(false);
      if (!result.ok) expect(result.reason, name).toContain(reason);
    }
    // A text re-digested alone breaks at its own sha check.
    const shaOnly = structuredClone(chain) as GuidanceRevision[];
    const edited = { ...shaOnly[1], newText: 'forged\n' };
    const lone = verifyGuidanceChain([shaOnly[0], { ...edited, digest: revisionDigest(edited) }]);
    expect(lone.ok).toBe(false);
    if (!lone.ok) expect(lone.reason).toContain("text does not match its digest");

    // Tampered on disk and reloaded: detected, and every further write refuses.
    const state = store.state(id);
    state.guidance = { ...state.guidance!, revisions: cases[0][1](structuredClone(chain) as GuidanceRevision[]) };
    await store.persist(state);
    store = new Store(path.join(root, 'data'), path.join(root, 'projects'));
    await store.init();
    guidance = new GuidanceMaintenance(store);
    const view = await locked(() => guidance.view(id));
    expect(view.chain).toMatchObject({ ok: false, brokenAt: 1 });
    const onDisk = await disk('AGENTS.md');
    await expect(locked(() => guidance.rollback(id, revision.id, undefined))).rejects.toMatchObject({
      status: 409,
      details: { code: 'guidance_chain_broken', brokenAt: 1 },
    });
    expect(await disk('AGENTS.md')).toBe(onDisk);
  });

  test('canonical form does not depend on key order', () => {
    expect(canonicalJson({ b: 1, a: [{ d: 2, c: null }] })).toBe(canonicalJson({ a: [{ c: null, d: 2 }], b: 1 }));
  });
});

describe('rollback', () => {
  test('rolls any revision back in one step, as a new record, and H11 follows', async () => {
    for (let i = 0; i < 3; i++) await run(REPORT, 'undo');
    const [first] = await proposals();
    const applied = await locked(() => guidance.approve(id, first.id, first.file.sha));
    for (let i = 0; i < 3; i++) await run('drafts/menu.md', 'undo');
    const [second] = await proposals();
    const appliedTwo = await locked(() => guidance.approve(id, second.id, second.file.sha));
    expect(await disk('AGENTS.md')).toBe(`${AGENTS}- Do not edit \`${REPORT}\`.\n- Do not edit \`drafts/menu.md\`.\n`);

    // Roll the first revision back: the file returns to before it, in one step.
    const current = hash(await disk('AGENTS.md'));
    const rolled = await locked(() => guidance.rollback(id, applied.id, current));
    expect(await disk('AGENTS.md')).toBe(AGENTS);
    expect(rolled).toMatchObject({
      seq: 3,
      action: 'rollback',
      rollbackOf: applied.id,
      previousSha: appliedTwo.newSha,
      newSha: hash(AGENTS),
      author: { kind: 'person', who: 'you' },
      evaluation: null,
      prevDigest: appliedTwo.digest,
    });
    const state = store.state(id);
    expect(state.history.find((item) => item.id === rolled.historyEntryId)).toMatchObject({
      actor: 'you',
      kind: 'guidance-rollback',
      sentence: 'You rolled AGENTS.md back to before revision 1',
    });
    expect(verifyGuidanceChain(state.guidance!.revisions)).toMatchObject({ ok: true, length: 3 });
    expect(state.instructionFiles!.find((item) => item.path === 'AGENTS.md')!.sha).toBe(hash(AGENTS));
    // Nothing earlier in the chain was edited.
    expect(state.guidance!.revisions.slice(0, 2)).toEqual([applied, appliedTwo]);
    // A rollback of an applied proposal holds it back like a decline; the other returns.
    expect(state.guidance!.declines).toMatchObject([{ pattern: first.pattern, via: 'rollback' }]);
    expect((await proposals()).map((item) => item.pattern)).toEqual([second.pattern]);

    // And the rollback itself rolls back.
    const undoRollback = await locked(() => guidance.rollback(id, rolled.id, undefined));
    expect(await disk('AGENTS.md')).toBe(appliedTwo.newText);
    expect(undoRollback.rollbackOf).toBe(rolled.id);
  });

  test('a rollback to what the file already reads, or against a stale sha, refuses', async () => {
    for (let i = 0; i < 3; i++) await run(REPORT, 'undo');
    const [proposal] = await proposals();
    const applied = await locked(() => guidance.approve(id, proposal.id, proposal.file.sha));
    await expect(locked(() => guidance.rollback(id, applied.id, hash(AGENTS)))).rejects.toMatchObject({
      status: 409,
      details: { code: 'rollback_moved' },
    });
    await fs.writeFile(path.join(folder, 'AGENTS.md'), AGENTS, 'utf8');
    await expect(locked(() => guidance.rollback(id, applied.id, undefined))).rejects.toMatchObject({ status: 409 });
    expect(store.state(id).guidance!.revisions).toHaveLength(1);
  });
});

describe('the no-reset invariant (DIO-102)', () => {
  test('a revision and its rollback leave open conversations and past delivery records exactly as they were', async () => {
    for (let i = 0; i < 3; i++) await run(REPORT, 'undo');
    const state = store.state(id);
    const oldDelivery = (
      await assembleInstructions({
        state,
        routeId: 'codex',
        agentRole: 'Diomedes build file proposal writer',
        budgetBytes: 32 * 1024,
        workPaths: [],
        at: '2026-09-24T04:00:00.000Z',
      })
    ).delivery!;
    state.sessions.find((item) => item.id === 'S1')!.instructions = oldDelivery;
    const conversation: Conversation = {
      id: 'C-open',
      attachedTo: { kind: 'project', ref: id },
      turns: [
        { id: 'turn-1', role: 'you', mode: 'ask', text: 'What is on the menu?', at: '2026-09-24T04:00:00.000Z', sources: [] },
      ],
      mode: 'ask',
      lineages: [{ mode: 'ask', generation: 1, runId: 'model-run-1' }],
    } as Conversation;
    state.conversations.push(conversation);
    await store.persist(state);
    // Read back through a restart, so the comparison is against the conversation as stored.
    store = new Store(path.join(root, 'data'), path.join(root, 'projects'));
    await store.init();
    guidance = new GuidanceMaintenance(store);
    const before = structuredClone(store.state(id).conversations);

    const [proposal] = await proposals();
    const applied = await locked(() => guidance.approve(id, proposal.id, proposal.file.sha));
    expect(store.state(id).conversations).toEqual(before);
    await locked(() => guidance.rollback(id, applied.id, undefined));
    expect(store.state(id).conversations).toEqual(before);
    expect(store.state(id).conversations.find((item) => item.id === 'C-open')!.lineages![0].retired).toBeUndefined();
    // The past run's record still names the bytes it was sent.
    expect(store.state(id).sessions.find((item) => item.id === 'S1')!.instructions).toEqual(oldDelivery);

    // After a restart, too.
    const reloaded = new Store(path.join(root, 'data'), path.join(root, 'projects'));
    await reloaded.init();
    expect(reloaded.state(id).conversations).toEqual(before);
  });
});

describe('the routes', () => {
  let app: Awaited<ReturnType<typeof createApp>>;
  let server: Server;
  let url: string;
  const request = async (route: string, method = 'GET', body?: unknown) => {
    const response = await fetch(`${url}/api${route}`, {
      method,
      headers: { 'Content-Type': 'application/json', 'X-Diomedes-Client': '1' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, data: await response.json() };
  };
  let temp: string;
  beforeEach(async () => {
    temp = await fs.mkdtemp(path.join(os.tmpdir(), 'diomedes-h10-routes-'));
    app = await createApp({ dataDir: path.join(temp, 'data'), projectRoot: path.join(temp, 'projects'), stepMs: 20 });
    server = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterEach(async () => {
    await app.locals.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(temp, { recursive: true, force: true });
  });

  test('view, approve, decline and roll back over HTTP', async () => {
    const created = await request('/projects', 'POST', { name: 'Routes' });
    expect(created.status).toBe(200);
    const projectId = created.data.id as string;
    const state = (await request(`/projects/${projectId}/state`)).data as ProjectState;
    await fs.writeFile(path.join(state.project.folder, 'AGENTS.md'), AGENTS, 'utf8');
    expect((await request(`/projects/${projectId}/packs/${PACK}/activate`, 'POST')).status).toBe(200);
    const empty = await request(`/projects/${projectId}/guidance`);
    expect(empty.data).toMatchObject({ proposals: [], revisions: [], declines: [], chain: { ok: true, length: 0 } });
    expect((await request(`/projects/${projectId}/guidance/proposals/nope/approve`, 'POST', {})).status).toBe(409);
    expect((await request(`/projects/${projectId}/guidance/revisions/nope/rollback`, 'POST', {})).status).toBe(404);
  });
});
