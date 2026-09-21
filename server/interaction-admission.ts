// Interaction admission: the deterministic half of "the model proposes, Trust and Runtime decide".
// It narrows an already parsed InteractionDecision to what that proposal may become.
// It grants nothing and starts nothing. Under Automatic, proposed work is shown
// and waits for the person's own selection for that exact proposal before it escalates.
// Modes resolve to Restriction on the server and are never read from a model.
// This module makes no model call, performs no I/O, and reads no clock or randomness.
// Selections arrive as trusted client events carrying the digest of what was shown.
// Any unexpected disposition and operation class pair throws instead of guessing.
import { digest } from './harness/policy.js';
import { OPERATION_CLASSES, type InteractionDecision, type OperationClass } from '../shared/interaction.js';

/** Resolved on the server from the conversation's Mode control. Never read from a model. */
export type Restriction = 'automatic' | 'answer-only' | 'plan-only';

/** The highest operation class each explicit limit admits. Frozen. */
export const RESTRICTION_CEILING: Readonly<Record<'answer-only' | 'plan-only', OperationClass>> =
  Object.freeze({
    'answer-only': 'read',
    'plan-only': 'prepare_artifact',
  });

/** 'conv.' + digest({ family, sourceMessageId }).slice(0, 40) */
export function conversationCommandIds(sourceMessageId: string): {
  taskCommandId: string;
  workCommandId: string;
} {
  // One stable command pair per source message, so a retry reuses the receipt.
  const taskCommandId = 'conv.' + digest({ family: 'task.create', sourceMessageId }).slice(0, 40);
  const workCommandId = 'conv.' + digest({ family: 'work.start', sourceMessageId }).slice(0, 40);
  return { taskCommandId, workCommandId };
}

/** digest({ sourceMessageId, disposition, operationClass, projectId, publicSummary, sourceRefs }) */
export function proposalDigest(decision: InteractionDecision, projectId: string): string {
  // Binds the shown text and refs to one target, so a selection cannot be replayed elsewhere.
  return digest({
    sourceMessageId: decision.sourceMessageId,
    disposition: decision.disposition,
    operationClass: decision.operationClass,
    projectId,
    publicSummary: decision.publicSummary,
    sourceRefs: decision.sourceRefs,
  });
}

/** The person's own choice to start what was shown. Comes from a trusted client event, never a model. */
export interface ActionSelection {
  sourceMessageId: string;
  proposalDigest: string;
  projectId: string;
}

export type BlockReason =
  | 'above-ceiling' | 'needs-target' | 'home-is-not-a-target' | 'unknown-target'
  | 'cross-project-read' | 'build-not-reachable' | 'send-not-reachable'
  | 'control-not-reachable' | 'stale-selection';

export interface AdmissionInput {
  decision: InteractionDecision;
  restriction: Restriction;
  /** The project whose conversation run produced this decision. */
  conversationProjectId: string;
  /** The reserved workspace home Project, or null before it is provisioned. */
  homeProjectId: string | null;
  /** Projects the local owner may target. Never contains homeProjectId. */
  targetableProjectIds: readonly string[];
  /** null until the person chooses to start the shown proposal. */
  selection: ActionSelection | null;
}

type Work = { projectId: string; operationClass: 'prepare_artifact' | 'write_internal'; proposalDigest: string };

export type AdmissionVerdict =
  | { outcome: 'inert' }
  | { outcome: 'read'; projectId: string }
  | ({ outcome: 'proposed' } & Work)
  | ({ outcome: 'escalate'; taskCommandId: string; workCommandId: string } & Work)
  | { outcome: 'blocked'; reason: BlockReason };

export function admitInteraction(input: AdmissionInput): AdmissionVerdict {
  const { decision, restriction, conversationProjectId, homeProjectId, targetableProjectIds, selection } = input;
  const { disposition, operationClass } = decision;

  // 1. Text answers and blocked explanations change nothing.
  if (disposition === 'respond' || disposition === 'clarify' || disposition === 'blocked') {
    return { outcome: 'inert' };
  }
  // 2. Run control is never reachable through this path.
  if (disposition === 'control') {
    return { outcome: 'blocked', reason: 'control-not-reachable' };
  }
  // 3. A limit narrows by rank in OPERATION_CLASSES, lowest first, with no fixed numbers.
  if (restriction === 'answer-only' || restriction === 'plan-only') {
    const ceiling = RESTRICTION_CEILING[restriction];
    if (OPERATION_CLASSES.indexOf(operationClass) > OPERATION_CLASSES.indexOf(ceiling)) {
      return { outcome: 'blocked', reason: 'above-ceiling' };
    }
  }
  // 4. New capabilities need their own bounded task path, not this one.
  if (disposition === 'build_capability') {
    return { outcome: 'blocked', reason: 'build-not-reachable' };
  }
  // 5. External sends are never reachable through this path.
  if (operationClass === 'send_external') {
    return { outcome: 'blocked', reason: 'send-not-reachable' };
  }
  // 6. Reads stay inside the conversation that produced them.
  if (disposition === 'retrieve' || (disposition === 'act' && operationClass === 'read')) {
    const target = decision.requestedProjectId ?? conversationProjectId;
    if (target !== conversationProjectId) {
      return { outcome: 'blocked', reason: 'cross-project-read' };
    }
    return { outcome: 'read', projectId: target };
  }
  // 7. A plan that prepares nothing is text, and the text is the whole result.
  if (disposition === 'plan' && operationClass === 'none') {
    return { outcome: 'inert' };
  }
  // 8a. A limit never starts work, whatever a selection claims. Checked before selection is read.
  if (restriction !== 'automatic') {
    if (disposition === 'plan') {
      return { outcome: 'inert' };
    }
    if (disposition === 'act') {
      return { outcome: 'blocked', reason: 'above-ceiling' };
    }
  } else {
    // 8b. From home with no target named the answer is a question, never a guessed project.
    const target = decision.requestedProjectId ?? (conversationProjectId === homeProjectId ? null : conversationProjectId);
    if (target === null) {
      return { outcome: 'blocked', reason: 'needs-target' };
    }
    if (target === homeProjectId) {
      return { outcome: 'blocked', reason: 'home-is-not-a-target' };
    }
    if (!targetableProjectIds.includes(target)) {
      return { outcome: 'blocked', reason: 'unknown-target' };
    }
    // 8c. Under Automatic the proposal is shown until the exact selection for it arrives.
    if (operationClass === 'prepare_artifact' || operationClass === 'write_internal') {
      const shown = proposalDigest(decision, target);
      if (selection === null) {
        return { outcome: 'proposed', projectId: target, operationClass, proposalDigest: shown };
      }
      if (
        selection.sourceMessageId !== decision.sourceMessageId ||
        selection.proposalDigest !== shown ||
        selection.projectId !== target
      ) {
        return { outcome: 'blocked', reason: 'stale-selection' };
      }
      const ids = conversationCommandIds(decision.sourceMessageId);
      return {
        outcome: 'escalate',
        projectId: target,
        operationClass,
        proposalDigest: shown,
        taskCommandId: ids.taskCommandId,
        workCommandId: ids.workCommandId,
      };
    }
  }
  throw new Error(
    `Unexpected interaction proposal: disposition "${disposition}" with operation class "${operationClass}".`,
  );
}
