/**
 * The H15 response ladder: what Diomedes does about one finding, given what it
 * already did about the same issue. Pure; `service.ts` performs the answer.
 *
 * note → ask the run to correct → pause the run and ask you.
 *
 * A finding starts on the rung its severity names. A correction is bounded per
 * detector per run: the declared count, never more than the harness's own
 * correction limit (`CORRECTION_LIMITS` in `server/harness/lifecycle.ts`, read
 * through `correctionWithinBounds`, which also refuses any correction that would
 * change more than the attempt). An issue that persists with new evidence after
 * a correction is corrected again while the bound allows, and escalated when it
 * does not. An escalation is raised once per underlying issue on a task: while
 * it is open nothing more is raised for that issue, and once you answered
 * "continue" the issue is yours, so later evidence of it is only noted.
 */
import {
  type DriftCode,
  type DriftFinding,
  type DriftLadder,
  type SupervisionRecord,
  type SupervisionRung,
} from '../../shared/supervision.js';
import { CORRECTION_LIMITS, correctionWithinBounds } from '../harness/lifecycle.js';
import type { Need } from '../../shared/types.js';

/** Proposed defaults, per detector. */
export const DRIFT_LADDERS: Readonly<Record<DriftCode, DriftLadder>> = Object.freeze({
  'scope-drift': {
    entry: { info: 'note', warning: 'correct', critical: 'escalate' },
    maxCorrections: 1,
  },
  'no-progress': {
    entry: { info: 'note', warning: 'correct', critical: 'escalate' },
    maxCorrections: 2,
  },
  'budget-burn': {
    entry: { info: 'note', warning: 'correct', critical: 'escalate' },
    maxCorrections: 1,
  },
  'instruction-drift': {
    entry: { info: 'note', warning: 'correct', critical: 'escalate' },
    maxCorrections: 1,
  },
  'verification-regression': {
    entry: { info: 'note', warning: 'correct', critical: 'escalate' },
    maxCorrections: 1,
  },
});

/** The bound a detector's corrections run under: its own, capped by the harness limit. */
export function correctionBound(code: DriftCode): number {
  return Math.min(DRIFT_LADDERS[code].maxCorrections, CORRECTION_LIMITS.maxAttempts);
}

export type LadderStep =
  | { readonly rung: null; readonly reason: string }
  | {
      readonly rung: SupervisionRung;
      readonly reason: string;
      readonly attempt?: { readonly n: number; readonly of: number };
      /** Set when a rung was taken for a run that can no longer be corrected or paused. */
      readonly settled?: string;
    };

export interface LadderContext {
  readonly sessionId: string;
  readonly taskId: string;
  readonly live: boolean;
  /** Every supervision record on the project, oldest first. */
  readonly records: readonly SupervisionRecord[];
  /** The project's Needs, to read whether an escalation is still open and how it was answered. */
  readonly needs: readonly Pick<Need, 'id' | 'state' | 'supervision'>[];
}

/** What to do about one finding now. */
export function nextStep(finding: DriftFinding, context: LadderContext): LadderStep {
  const sameIssue = context.records.filter(
    (record) => record.taskId === context.taskId && record.issueKey === finding.issueKey,
  );
  // Raised once per underlying issue: an open escalation for it holds everything.
  const escalations = sameIssue.filter((record) => record.action === 'escalate' && record.needId);
  const open = escalations.find((record) =>
    context.needs.some((need) => need.id === record.needId && need.state === 'open'),
  );
  if (open) return { rung: null, reason: 'An escalation about this is already waiting for you.' };
  const onRun = sameIssue.filter((record) => record.sessionId === context.sessionId);
  const last = onRun.at(-1);
  if (last && last.evidenceDigest === finding.evidenceDigest)
    return { rung: null, reason: 'Nothing new since the last supervision action.' };
  const acknowledged = sameIssue.some(
    (record) =>
      record.action === 'answer' &&
      record.answer === 'continue' &&
      record.control?.outcome !== 'refused',
  );
  const notedOnRun = onRun.some((record) => record.action === 'note');
  if (acknowledged)
    return notedOnRun ? { rung: null, reason: 'Acknowledged and already noted on this run.' } : {
      rung: 'note',
      reason: 'You chose to continue after this was raised, so it is noted, not raised again.',
      settled: 'Acknowledged by your earlier answer.',
    };
  // One escalation per run: an issue already escalated on this run is only noted from here.
  if (onRun.some((record) => record.action === 'escalate'))
    return notedOnRun ? { rung: null, reason: 'Already paused and noted on this run.' } : {
      rung: 'note',
      reason: 'This run was already paused for this.',
      settled: 'Already escalated on this run.',
    };
  const ladder = DRIFT_LADDERS[finding.code];
  const entry = ladder.entry[finding.severity];
  if (!context.live) {
    if (onRun.some((record) => record.action === 'note' && record.severity === finding.severity))
      return { rung: null, reason: 'Already noted; the run has ended.' };
    return {
      rung: 'note',
      reason: 'The run had ended, so there was nothing to correct or pause.',
      settled: 'The run had ended.',
    };
  }
  const bound = correctionBound(finding.code);
  const corrections = context.records.filter(
    (record) =>
      record.sessionId === context.sessionId &&
      record.code === finding.code &&
      record.action === 'correct',
  ).length;
  const correctedThis = onRun.some((record) => record.action === 'correct');
  const tryCorrect = (why: string): LadderStep => {
    const bounds = correctionWithinBounds({
      attempt: corrections,
      changes: [{ target: 'attempt', what: finding.issueKey }],
    });
    if (bounds.allowed && corrections < bound)
      return { rung: 'correct', reason: why, attempt: { n: corrections + 1, of: bound } };
    return {
      rung: 'escalate',
      reason:
        bound === 0
          ? 'This detector declares no correction, so the run is paused for you.'
          : `Diomedes asked the run to correct this ${bound === 1 ? 'once' : `${bound} times`}, which is the bound, and it persists.`,
    };
  };
  if (entry === 'escalate')
    return { rung: 'escalate', reason: 'This is something only you can admit, so the run is paused for you.' };
  if (entry === 'correct')
    return tryCorrect(
      correctedThis
        ? 'It persisted after the last correction, with new evidence.'
        : 'Drift a correction can fix.',
    );
  // Info: a note, once per issue per run, unless it already climbed past one.
  if (correctedThis) {
    if (onRun.some((record) => record.action === 'note' && record.evidenceDigest === finding.evidenceDigest))
      return { rung: null, reason: 'Already noted.' };
    return { rung: null, reason: 'Already corrected; this is below the level that corrects again.' };
  }
  if (onRun.some((record) => record.action === 'note'))
    return { rung: null, reason: 'Already noted on this run.' };
  return { rung: 'note', reason: 'Worth recording; not yet something to act on.' };
}
