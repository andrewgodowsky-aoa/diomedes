/**
 * The presentation boundary. A harness run is shown with the words the
 * Workbook and the Console already use for a Session and a Task: nothing new
 * reaches a person, and nothing here grants or changes authority. These are
 * pure functions; the host decides when to write a Session or create a Need.
 */
import type { Need } from '../../shared/types.js';
import type { OriginSnapshot } from '../../shared/attribution.js';
import type { HarnessRun, RunPresentation, StepRecord } from '../../shared/harness.js';

const describeIntent = (step: StepRecord): string =>
  step.intent.name ?? step.intent.permission ?? step.intent.stepId;

export function presentRun(run: HarnessRun): RunPresentation {
  const waitingStep = run.steps.find((s) => s.state === 'waiting_approval') ?? null;
  const uncertainStep = run.steps.find((s) => s.state === 'reconcile_required') ?? null;
  const base = {
    waiting: waitingStep
      ? {
          stepId: waitingStep.intent.stepId,
          intentHash: waitingStep.intentHash,
          what: describeIntent(waitingStep),
        }
      : null,
    uncertain: uncertainStep
      ? {
          stepId: uncertainStep.intent.stepId,
          intentHash: uncertainStep.intentHash,
          attempt: uncertainStep.attempt,
        }
      : null,
    evidence: { steps: run.steps.length, events: run.events.length, lastSeq: run.lastSeq },
    lineage: run.parentRunId ? { parentRunId: run.parentRunId, forkPoint: run.forkPoint } : null,
  };
  switch (run.state) {
    case 'queued':
      return {
        ...base,
        taskState: 'todo',
        reason: null,
        sessionState: 'queued',
        sentence: 'Waiting to start.',
      };
    case 'running':
      return {
        ...base,
        taskState: 'working',
        reason: null,
        sessionState: 'working',
        sentence: 'Working.',
      };
    case 'waiting':
      return waitingStep
        ? {
            ...base,
            taskState: 'waiting',
            reason: 'needs-ok',
            sessionState: 'waiting',
            sentence: `Waiting for your OK: ${describeIntent(waitingStep)}.`,
          }
        : {
            ...base,
            taskState: 'waiting',
            reason: null,
            sessionState: 'waiting',
            sentence: 'Waiting for something outside Diomedes.',
          };
    case 'reconcile_required':
      return {
        ...base,
        taskState: 'waiting',
        reason: 'went-wrong',
        sessionState: 'waiting',
        sentence:
          'Something may have happened outside Diomedes that it could not confirm. Check before starting again; nothing will be repeated on its own.',
      };
    case 'completed':
      return {
        ...base,
        taskState: 'done',
        reason: null,
        sessionState: 'done',
        sentence: 'Finished.',
      };
    case 'failed':
      // The error text stays on the run record for the Console's technical
      // lines; a person-facing sentence never carries a raw message.
      return {
        ...base,
        taskState: 'waiting',
        reason: 'went-wrong',
        sessionState: 'failed',
        sentence: 'Stopped because something went wrong. Nothing will be repeated on its own.',
      };
    case 'cancelled':
      return uncertainStep
        ? {
            ...base,
            taskState: 'waiting',
            reason: 'went-wrong',
            sessionState: 'stopped',
            sentence:
              'Stopped. One action may have happened outside Diomedes that it could not confirm. Check before starting again.',
          }
        : {
            ...base,
            taskState: 'todo',
            reason: null,
            sessionState: 'stopped',
            sentence: `Stopped${run.cancelReason ? `: ${run.cancelReason}` : ''}.`,
          };
  }
}

/**
 * The fields a host needs to create a Need for a step waiting for approval.
 * The intent hash is what Astra's approval receipts call the action digest:
 * the Need binds to it, and answering the Need is what calls `decide`.
 * The saved step origin travels with the Need when present; legacy steps
 * without one stay unknown rather than inventing provenance. Generated prose
 * and later picker changes never set it here.
 */
export function needFromWaitingStep(
  run: HarnessRun,
  step: StepRecord,
): Pick<Need, 'what' | 'why' | 'consequence' | 'files'> & {
  intentHash: string;
  runId: string;
  origin?: OriginSnapshot;
} {
  const input = step.intent.input;
  const files =
    input && typeof input === 'object' && !Array.isArray(input) && Array.isArray(input.files)
      ? input.files.filter((f): f is string => typeof f === 'string')
      : [];
  const consequence =
    step.intent.destination === 'external'
      ? 'This sends information outside this computer. Diomedes cannot take it back afterwards.'
      : step.intent.effect === 'non-idempotent'
        ? 'This changes something. Diomedes records the before and after so you can undo it.'
        : step.intent.effect === 'idempotent'
          ? 'This makes a change that is safe to repeat. Diomedes records it.'
          : 'This only reads. Nothing changes.';
  return {
    runId: run.id,
    intentHash: step.intentHash,
    ...(step.origin === undefined ? {} : { origin: step.origin }),
    what: `Go ahead with ${describeIntent(step)}?`,
    why: 'This step asks for your OK before it runs. Nothing happens until you say go ahead, and your OK covers exactly this step and nothing else.',
    consequence,
    files,
  };
}

/**
 * The saved origin a Session should show for a harness run, when the run has
 * one. Prefers the first succeeded model authorship, then the first succeeded
 * step with provenance. Legacy runs without snapshots return undefined:
 * unknown stays unknown, never a current picker value or generated prose.
 * Pure presentation; the host decides when to write a Session.
 */
export function sessionOriginFromRun(run: HarnessRun): OriginSnapshot | undefined {
  const model = run.steps.find(
    (s) => s.state === 'succeeded' && s.origin !== undefined && s.intent.kind === 'model',
  );
  if (model?.origin) return model.origin;
  return run.steps.find((s) => s.state === 'succeeded' && s.origin !== undefined)?.origin;
}
