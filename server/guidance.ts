/**
 * H10 on the server: guidance proposals from recorded evidence, their bounded
 * evaluation, and the signed revision chain with one-step rollback.
 *
 * Nothing here writes on its own. `proposals` only reads: the project's
 * Changes, H15 supervision records, P06 review comments and the H11
 * instruction records. A file changes only when a person approves a proposal
 * or rolls a revision back, and then through `Store.writeRecorded` with the
 * base hash the person was shown, so an instruction file that moved on since
 * refuses rather than being overwritten. After every write H11 discovery runs
 * again, so the instruction record, its sha and its rule's provenance name the
 * new bytes and the next run is sent them. A conversation that is already
 * open keeps going as it was (DIO-102): conversation lineages bind their mode's
 * text, never a project instruction file, and nothing here touches them.
 *
 * Every method is called with the store lock held (the route helper takes it).
 */
import { createHash } from 'node:crypto';
import type express from 'express';
import type { Request, Response } from 'express';
import { ApiError } from './paths.js';
import { hash, identifier, now, type Store } from './store.js';
import { discoverInstructionFiles } from './capability-packs.js';
import { driftInputFor } from './supervision/records.js';
import { detectInstructionDrift, machineRules, within } from './supervision/detectors.js';
import {
  activeInstructionFiles,
  compareInstructionPrecedence,
  instructionScope,
  type InstructionFileRecord,
} from '../shared/capability-packs.js';
import {
  appendGuidanceLine,
  canonicalJson,
  commentKind,
  emptyGuidanceLedger,
  GUIDANCE_EVALUATION_MAX_CASES,
  GUIDANCE_THRESHOLDS,
  guidanceVerdict,
  isSuppressed,
  MAX_GUIDANCE_DECLINES,
  MAX_GUIDANCE_REVISIONS,
  oneLine,
  type ChainCheck,
  type GuidanceCase,
  type GuidanceDecline,
  type GuidanceEvaluation,
  type GuidanceEvidence,
  type GuidanceEvidenceKind,
  type GuidanceLedger,
  type GuidanceProposal,
  type GuidanceRevision,
} from '../shared/guidance.js';
import type { ProjectState } from '../shared/types.js';

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');

/** The digest a revision carries: SHA-256 over the canonical form of every other field. */
export function revisionDigest(record: Omit<GuidanceRevision, 'digest'>): string {
  const { digest: _digest, ...rest } = record as GuidanceRevision;
  return sha256(canonicalJson(rest));
}

/**
 * Walk the chain from the first record. Any edit to a record, a dropped or
 * reordered record, or a text that no longer matches its digest breaks it, and
 * the check says where. Nothing is repaired: a broken chain is evidence.
 */
export function verifyGuidanceChain(revisions: readonly GuidanceRevision[]): ChainCheck {
  let previous: string | null = null;
  for (const [index, record] of revisions.entries()) {
    const at = index + 1;
    const broken = (reason: string): ChainCheck => ({
      ok: false,
      length: revisions.length,
      brokenAt: at,
      reason,
    });
    if (record.protocolVersion !== 1 || record.scheme !== 'sha256-chain-v1')
      return broken(`Revision ${at} is in a format this build does not read.`);
    if (record.seq !== at) return broken(`Revision ${at} is out of order.`);
    if (record.prevDigest !== previous)
      return broken(`Revision ${at} does not follow the revision before it.`);
    if (revisionDigest(record) !== record.digest)
      return broken(`Revision ${at} was changed after it was recorded.`);
    if (hash(record.newText) !== record.newSha || hash(record.previousText) !== record.previousSha)
      return broken(`Revision ${at}'s text does not match its digest.`);
    previous = record.digest;
  }
  return { ok: true, length: revisions.length, head: previous };
}

// --- evidence ---------------------------------------------------------------------

interface Candidate {
  readonly kind: GuidanceEvidenceKind;
  /** A path for a write or a folder (ending in `/`); a comment kind for a comment. */
  readonly target: string;
  readonly paths: readonly string[];
  readonly evidence: GuidanceEvidence[];
  /** Distinct occurrences counted against the threshold. */
  readonly occurrences: Set<string>;
  /** The first comment's own words, for a comment. */
  text?: string;
}

const realSession = (state: ProjectState, sessionId: string | null) => {
  const session = sessionId ? state.sessions.find((item) => item.id === sessionId) : undefined;
  return session && !session.sample ? session : null;
};
const entryTime = (state: ProjectState, entryId: string) =>
  state.history.find((entry) => entry.id === entryId)?.time ?? '';

/** Every repeated correction on the record, grouped by kind and what it is about. */
export function collectGuidanceEvidence(state: ProjectState): Candidate[] {
  const groups = new Map<string, Candidate>();
  const group = (kind: GuidanceEvidenceKind, target: string) => {
    const key = `${kind}:${target}`;
    let found = groups.get(key);
    if (!found) {
      found = { kind, target, paths: [], evidence: [], occurrences: new Set() };
      groups.set(key, found);
    }
    return found;
  };

  // (a) A run's write you undid. A sample run is a fixture, not a correction.
  for (const change of state.changes) {
    if (change.state !== 'undone') continue;
    const session = realSession(state, change.sessionId);
    if (!session) continue;
    const item = group('undone-write', change.path);
    (item.paths as string[]).push(change.path);
    item.occurrences.add(session.id);
    item.evidence.push({
      kind: 'undone-write',
      ref: change.id,
      sessionId: session.id,
      taskId: change.taskId,
      path: change.path,
      at: entryTime(state, change.entryId),
      detail: `You undid this run's change to ${change.path}.`,
    });
  }

  // (b) A run H15 paused for writing outside its folder, that you then stopped or redirected.
  for (const record of state.supervision ?? []) {
    if (record.action !== 'answer' || record.code !== 'scope-drift') continue;
    if (record.answer !== 'stop' && record.answer !== 'redirect') continue;
    const folder = /^scope:(.+)$/.exec(record.issueKey)?.[1];
    if (!folder || folder === '/' || folder === 'outside-project' || folder.startsWith('destination:'))
      continue;
    if (!realSession(state, record.sessionId)) continue;
    const target = `${folder}/`;
    const item = group('scope-drift', target);
    (item.paths as string[]).push(target);
    item.occurrences.add(record.sessionId);
    item.evidence.push({
      kind: 'scope-drift',
      ref: record.id,
      sessionId: record.sessionId,
      taskId: record.taskId,
      path: target,
      at: record.at,
      detail: `You ${record.answer === 'stop' ? 'stopped' : 'redirected'} a run H15 paused for writing in ${target}.`,
    });
  }

  // (c) The same review comment, on different changes or file versions.
  for (const comment of state.reviewComments ?? []) {
    const kind = commentKind(comment.text);
    if (!kind) continue;
    const item = group('review-comment', kind);
    item.text ??= comment.text;
    (item.paths as string[]).push(comment.target.path);
    item.occurrences.add(
      comment.target.kind === 'change'
        ? `change:${comment.target.changeId}`
        : `version:${comment.target.path}@${comment.target.sha}`,
    );
    const change =
      comment.target.kind === 'change'
        ? state.changes.find((c) => c.id === (comment.target as { changeId: string }).changeId)
        : undefined;
    item.evidence.push({
      kind: 'review-comment',
      ref: comment.id,
      sessionId: change?.sessionId ?? null,
      taskId: comment.taskId,
      path: comment.target.path,
      at: comment.at,
      detail: `You commented on ${comment.target.path} line ${comment.anchor.line}: “${oneLine(comment.text)}”`,
    });
  }
  return [...groups.values()];
}

// --- the file a line goes into ----------------------------------------------------

const covers = (scope: string, target: string) => within(target.replace(/\/$/, ''), scope);

/** The nearest loaded instruction file whose folder holds every path, AGENTS.md first. */
export function governingFile(
  state: ProjectState,
  paths: readonly string[],
): InstructionFileRecord | null {
  const loaded = activeInstructionFiles(state.project.packs, state.instructionFiles)
    .filter((record) => record.state === 'loaded' && record.sha)
    .sort((a, b) => compareInstructionPrecedence(a.path, b.path));
  return (
    loaded.find((record) => paths.every((item) => covers(instructionScope(record.path), item))) ??
    null
  );
}

const relativeTo = (scope: string, target: string) =>
  scope && target.startsWith(`${scope}/`) ? target.slice(scope.length + 1) : target;

function lineFor(candidate: Candidate, scope: string): string | null {
  if (candidate.kind === 'undone-write')
    return `Do not edit \`${relativeTo(scope, candidate.target)}\`.`;
  if (candidate.kind === 'scope-drift')
    return `Do not write to \`${relativeTo(scope, candidate.target)}\`.`;
  const line = oneLine(candidate.text ?? '');
  return line || null;
}

/** Whether a rule in this text already forbids writing to the target. */
function forbidsAlready(text: string, file: { path: string; sha: string }, scope: string, target: string) {
  const bare = target.replace(/\/$/, '');
  return machineRules(text, file, scope).some((rule) =>
    rule.forbids.endsWith('/')
      ? within(bare, rule.forbids)
      : bare === rule.forbids.replace(/\/$/, '') || within(bare, `${rule.forbids}/`),
  );
}

// --- evaluation -------------------------------------------------------------------

/**
 * Replay the recorded runs the line is about through H15's instruction check,
 * under the file as it is and as it would be. A targeted run is one whose
 * write was the correction; a control run is one that wrote to the same place
 * and whose change you kept. Bounded, deterministic, and no model is called.
 */
async function evaluate(
  state: ProjectState,
  candidate: Candidate,
  file: { path: string; sha: string; scope: string },
  before: string,
  after: string,
): Promise<GuidanceEvaluation> {
  const revisedRules = machineRules(after, { path: file.path, sha: 'revised' }, file.scope);
  const currentRules = machineRules(before, { path: file.path, sha: file.sha }, file.scope);
  const newRules = revisedRules.filter(
    (rule) => !currentRules.some((current) => current.forbids === rule.forbids),
  );
  const notEvaluable = (summary: string): GuidanceEvaluation => ({
    verdict: 'not-evaluable',
    route: 'recorded-replay',
    cases: [],
    gained: 0,
    lost: 0,
    summary,
  });
  if (!newRules.length)
    return notEvaluable(
      'This line is guidance for the model to read, not a rule a check can hold a run to, so no recorded run can be replayed against it.',
    );
  const touched = (target: string) => newRules.some((rule) => within(target, rule.forbids));
  const targeted = [
    ...new Set(candidate.evidence.map((item) => item.sessionId).filter((id): id is string => !!id)),
  ].slice(0, GUIDANCE_EVALUATION_MAX_CASES);
  const control = [
    ...new Set(
      state.changes
        .filter(
          (change) =>
            change.state === 'kept' &&
            change.sessionId &&
            !targeted.includes(change.sessionId) &&
            realSession(state, change.sessionId) &&
            touched(change.path),
        )
        .map((change) => change.sessionId as string),
    ),
  ].slice(0, GUIDANCE_EVALUATION_MAX_CASES);
  const cases: GuidanceCase[] = [];
  for (const [role, ids] of [
    ['targeted', targeted],
    ['control', control],
  ] as const) {
    for (const sessionId of ids) {
      const session = state.sessions.find((item) => item.id === sessionId);
      if (!session) continue;
      const input = await driftInputFor({ state, session, harness: null, instructions: async () => null });
      const flags = (text: string, sha: string) =>
        detectInstructionDrift({
          ...input,
          rules: machineRules(text, { path: file.path, sha }, file.scope),
        }).some((finding) =>
          finding.evidence.some(
            (item) => item.kind !== 'rule' && item.path !== undefined && touched(item.path),
          ),
        );
      cases.push({
        sessionId,
        role,
        without: flags(before, file.sha),
        with: flags(after, 'revised'),
      });
    }
  }
  const { verdict, gained, lost } = guidanceVerdict(cases);
  const targetedCount = cases.filter((item) => item.role === 'targeted').length;
  const controlCount = cases.length - targetedCount;
  const summary =
    verdict === 'not-evaluable'
      ? 'None of the runs this is about is on the record any more, so there was nothing to replay.'
      : `Replayed ${cases.length} recorded ${cases.length === 1 ? 'run' : 'runs'} through the instruction check: with this line it flags ${gained} of the ${targetedCount} you corrected${
          controlCount ? ` and ${lost} of the ${controlCount} you kept` : ''
        }; without it, ${cases.filter((item) => item.without).length}.`;
  return { verdict, route: 'recorded-replay', cases, gained, lost, summary };
}

// --- the service ------------------------------------------------------------------

export interface GuidanceView {
  readonly proposals: readonly GuidanceProposal[];
  readonly revisions: readonly GuidanceRevision[];
  readonly declines: readonly GuidanceDecline[];
  readonly chain: ChainCheck;
  readonly thresholds: typeof GUIDANCE_THRESHOLDS;
}

export class GuidanceMaintenance {
  constructor(private readonly store: Store) {}

  ledger(projectId: string): GuidanceLedger {
    return this.store.state(projectId).guidance ?? emptyGuidanceLedger();
  }

  /** What would be offered now. Reads only; a file changed on disk is re-discovered first. */
  async proposals(projectId: string): Promise<GuidanceProposal[]> {
    await discoverInstructionFiles(this.store, projectId);
    const state = this.store.state(projectId);
    const ledger = this.ledger(projectId);
    const found: GuidanceProposal[] = [];
    for (const candidate of collectGuidanceEvidence(state)) {
      const threshold = GUIDANCE_THRESHOLDS[candidate.kind];
      if (candidate.occurrences.size < threshold) continue;
      const record = governingFile(state, candidate.paths);
      if (!record?.sha) continue;
      const before = await this.store.current(projectId, record.path);
      if (before === null || hash(before) !== record.sha) continue;
      const scope = instructionScope(record.path);
      const file = { path: record.path, sha: record.sha, scope };
      const line = lineFor(candidate, scope);
      if (!line) continue;
      if (candidate.kind !== 'review-comment' && forbidsAlready(before, file, scope, candidate.target))
        continue;
      if (candidate.kind === 'review-comment' && before.includes(line)) continue;
      const pattern = `${candidate.kind}:${candidate.target}`;
      const evidence = [...candidate.evidence].sort((a, b) =>
        a.at < b.at ? -1 : a.at > b.at ? 1 : a.ref < b.ref ? -1 : 1,
      );
      const refs = evidence.map((item) => item.ref);
      if (isSuppressed(ledger.declines, pattern, refs)) continue;
      const evidenceDigest = sha256(canonicalJson([...refs].sort()));
      const after = appendGuidanceLine(before, line);
      found.push({
        id: sha256(canonicalJson({ pattern, evidenceDigest, file: file.sha, line })).slice(0, 24),
        pattern,
        kind: candidate.kind,
        target: candidate.target,
        file,
        line,
        before,
        after,
        evidence,
        evidenceDigest,
        threshold,
        occurrences: candidate.occurrences.size,
        evaluation: await evaluate(state, candidate, file, before, after),
        proposedBy: 'diomedes',
      });
    }
    return found.sort((a, b) => (a.pattern < b.pattern ? -1 : 1));
  }

  async view(projectId: string): Promise<GuidanceView> {
    const proposals = await this.proposals(projectId);
    const ledger = this.ledger(projectId);
    return {
      proposals,
      revisions: ledger.revisions,
      declines: ledger.declines,
      chain: verifyGuidanceChain(ledger.revisions),
      thresholds: GUIDANCE_THRESHOLDS,
    };
  }

  private assertChain(projectId: string) {
    const check = verifyGuidanceChain(this.ledger(projectId).revisions);
    if (!check.ok)
      throw new ApiError(
        409,
        `The revision record for this project's instructions is broken: ${check.reason} Nothing was written.`,
        { code: 'guidance_chain_broken', brokenAt: check.brokenAt },
      );
    if (check.length >= MAX_GUIDANCE_REVISIONS)
      throw new ApiError(409, 'This project has reached the limit on recorded instruction revisions.');
    return check;
  }

  private async offered(projectId: string, proposalId: string) {
    const proposal = (await this.proposals(projectId)).find((item) => item.id === proposalId);
    if (!proposal)
      throw new ApiError(
        409,
        'This proposal changed or is no longer offered, so nothing was written. Review it again.',
        { code: 'proposal_moved' },
      );
    return proposal;
  }

  /** Append one record to the chain, after its write landed. */
  private async append(
    projectId: string,
    record: Omit<GuidanceRevision, 'seq' | 'prevDigest' | 'digest' | 'protocolVersion' | 'scheme'>,
    decline?: GuidanceDecline,
  ): Promise<GuidanceRevision> {
    const state = this.store.state(projectId);
    const ledger: Mutable<GuidanceLedger> = structuredClone(state.guidance ?? emptyGuidanceLedger());
    const last = ledger.revisions.at(-1);
    const unsigned: Omit<GuidanceRevision, 'digest'> = {
      protocolVersion: 1,
      seq: ledger.revisions.length + 1,
      ...record,
      prevDigest: last?.digest ?? null,
      scheme: 'sha256-chain-v1',
    };
    const revision: GuidanceRevision = { ...unsigned, digest: revisionDigest(unsigned) };
    ledger.revisions = [...ledger.revisions, revision];
    if (decline && ledger.declines.length < MAX_GUIDANCE_DECLINES)
      ledger.declines = [...ledger.declines, decline];
    state.guidance = ledger;
    await this.store.persist(state);
    // H11: the record, its sha and its rule now name the new bytes, so the next run is sent them.
    await discoverInstructionFiles(this.store, projectId);
    return revision;
  }

  /** A person approves a proposal: the exact text they were shown, against the sha they were shown. */
  async approve(projectId: string, proposalId: string, expectedSha: unknown): Promise<GuidanceRevision> {
    this.assertChain(projectId);
    const proposal = await this.offered(projectId, proposalId);
    if (expectedSha !== undefined && expectedSha !== proposal.file.sha)
      throw new ApiError(
        409,
        `${proposal.file.path} changed since this proposal was shown, so nothing was written. Review it again.`,
        { code: 'proposal_moved', path: proposal.file.path, currentSha: proposal.file.sha },
      );
    const entry = await this.store.writeRecorded(
      projectId,
      [{ path: proposal.file.path, text: proposal.after, expected: proposal.file.sha }],
      {
        actor: 'you',
        kind: 'guidance-revision',
        sentence: `You approved Diomedes' proposed revision to ${proposal.file.path}: “${proposal.line}”`,
        sessionId: null,
        taskId: null,
        merge: false,
      },
    );
    return this.append(projectId, {
      id: `GR-${identifier()}`,
      action: 'apply',
      path: proposal.file.path,
      previousSha: proposal.file.sha,
      newSha: hash(proposal.after)!,
      previousText: proposal.before,
      newText: proposal.after,
      author: { kind: 'proposal', proposalId: proposal.id, proposedBy: 'diomedes', approvedBy: 'you' },
      at: now(),
      evidence: proposal.evidence,
      evaluation: proposal.evaluation,
      pattern: proposal.pattern,
      rollbackOf: null,
      historyEntryId: entry.id,
    });
  }

  /** A person declines: the pattern is suppressed until evidence it does not hold arrives. */
  async decline(projectId: string, proposalId: string): Promise<GuidanceDecline> {
    const proposal = await this.offered(projectId, proposalId);
    const state = this.store.state(projectId);
    const ledger: Mutable<GuidanceLedger> = structuredClone(state.guidance ?? emptyGuidanceLedger());
    if (ledger.declines.length >= MAX_GUIDANCE_DECLINES)
      throw new ApiError(409, 'This project has reached the limit on recorded declines.');
    const decline: GuidanceDecline = {
      pattern: proposal.pattern,
      proposalId: proposal.id,
      evidenceRefs: proposal.evidence.map((item) => item.ref),
      at: now(),
      by: 'you',
      via: 'decline',
    };
    ledger.declines = [...ledger.declines, decline];
    state.guidance = ledger;
    await this.store.persist(state);
    return decline;
  }

  /**
   * Restore the text a revision replaced, in one step, as a new record. The
   * base hash is the file as it is now, so a file edited since is refused
   * rather than overwritten; the chain itself is never edited.
   */
  async rollback(projectId: string, revisionId: string, expectedSha: unknown): Promise<GuidanceRevision> {
    this.assertChain(projectId);
    const target = this.ledger(projectId).revisions.find((item) => item.id === revisionId);
    if (!target) throw new ApiError(404, 'This revision was not found.');
    if (target.previousText === null)
      throw new ApiError(409, `${target.path} did not exist before this revision, so there is nothing to restore.`);
    const current = await this.store.current(projectId, target.path);
    const currentSha = hash(current);
    if (expectedSha !== undefined && expectedSha !== currentSha)
      throw new ApiError(
        409,
        `${target.path} changed since you opened it, so nothing was written. Review it again.`,
        { code: 'rollback_moved', path: target.path, currentSha },
      );
    if (currentSha === target.previousSha)
      throw new ApiError(409, `${target.path} already reads as it did before this revision.`);
    const entry = await this.store.writeRecorded(
      projectId,
      [{ path: target.path, text: target.previousText, expected: currentSha }],
      {
        actor: 'you',
        kind: 'guidance-rollback',
        sentence: `You rolled ${target.path} back to before revision ${target.seq}`,
        sessionId: null,
        taskId: null,
        merge: false,
      },
    );
    const decline: GuidanceDecline | undefined =
      target.author.kind === 'proposal' && target.pattern
        ? {
            pattern: target.pattern,
            proposalId: target.author.proposalId,
            evidenceRefs: target.evidence.map((item) => item.ref),
            at: now(),
            by: 'you',
            via: 'rollback',
          }
        : undefined;
    return this.append(
      projectId,
      {
        id: `GR-${identifier()}`,
        action: 'rollback',
        path: target.path,
        previousSha: currentSha,
        newSha: target.previousSha!,
        previousText: current,
        newText: target.previousText,
        author: { kind: 'person', who: 'you' },
        at: now(),
        evidence: target.evidence,
        evaluation: null,
        pattern: target.pattern,
        rollbackOf: target.id,
        historyEntryId: entry.id,
      },
      decline,
    );
  }
}

type Route = (
  action: (req: Request, res: Response) => Promise<unknown>,
  locked?: boolean,
) => express.RequestHandler;

export function mountGuidanceRoutes(
  app: express.Express,
  input: { store: Store; route: Route; body: (req: Request) => Record<string, unknown> },
): GuidanceMaintenance {
  const { store, route, body } = input;
  const guidance = new GuidanceMaintenance(store);
  const projectId = (req: Request) => String(req.params.id);
  app.get('/api/projects/:id/guidance', route(async (req) => guidance.view(projectId(req))));
  app.post(
    '/api/projects/:id/guidance/proposals/:proposalId/approve',
    route(async (req) => ({
      revision: await guidance.approve(projectId(req), String(req.params.proposalId), body(req).expectedSha),
    })),
  );
  app.post(
    '/api/projects/:id/guidance/proposals/:proposalId/decline',
    route(async (req) => ({
      decline: await guidance.decline(projectId(req), String(req.params.proposalId)),
    })),
  );
  app.post(
    '/api/projects/:id/guidance/revisions/:revisionId/rollback',
    route(async (req) => ({
      revision: await guidance.rollback(projectId(req), String(req.params.revisionId), body(req).expectedSha),
    })),
  );
  return guidance;
}
