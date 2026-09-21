// One conversation message, as the host handles it around the model call. Everything here is
// pure: no store, no clock, no model, no I/O. The host computes the identities before it
// resolves anything else, hands the driver a splitter, and reads the outcome back from the
// phases the driver saved. Nothing in this file grants anything: what a proposal may become
// is decided in interaction-admission.ts, and what actually starts is decided by the
// existing task and work admission.
import { digest } from './harness/policy.js';
import type { Json } from '../shared/harness.js';
import {
  PACKAGE_FIELD_NAMES,
  interactionDecisionSchema,
  isIssuedSourceId,
  type InteractionDecision,
} from '../shared/interaction.js';
import type {
  ActionSelection,
  AdmissionVerdict,
  BlockReason,
  Restriction,
} from './interaction-admission.js';
import type { InteractionPhase, InteractionPhaseName } from './harness/claude-session-run.js';

/** The conversation's Mode control. Build and Fix are work modes and never reach a conversation. */
export type ConversationMode = 'ask' | 'plan' | 'auto';
export type TurnAction = 'start' | 'follow-up' | 'resume' | 'fork';

/** Resolved from the Mode control and from nothing else. Never read from a model or a message. */
export function restrictionOf(mode: ConversationMode): Restriction {
  return mode === 'auto' ? 'automatic' : mode === 'ask' ? 'answer-only' : 'plan-only';
}

/**
 * The issued identity of one message. Computed, so it exists before generation and after any
 * crash, and is never taken from a client or recovered from a model.
 */
export function sourceMessageIdFor(projectId: string, threadId: string, commandId: string) {
  return `sm.${digest({ projectId, threadId, commandId }).slice(0, 32)}`;
}

/**
 * What the person sent, as one digest of the parsed command and nothing else: no setting, no
 * file read and no model is consulted, so it can be computed first and compared on a replay
 * even when the files or the settings have changed since. Source order is part of it, because
 * the order is part of what the model was given.
 */
export function commandBinding(
  action: TurnAction,
  command: {
    text: string;
    mode: ConversationMode;
    sources: readonly { path: string; sha: string }[];
  },
) {
  return digest({
    action,
    text: command.text,
    mode: command.mode,
    sources: command.sources.map((source) => ({ path: source.path, sha: source.sha })),
  });
}

const TRAILER_OPEN = '[[diomedes source_message_id=';
/**
 * An Automatic message carries its issued identity to the model on one last line. The
 * instructions are static so the pinned scope never changes from turn to turn; the identity
 * changes every message, so it travels here. It is part of the saved turn input, and it is
 * never shown: the person's turn is projected from the text they typed.
 */
export function promptFor(mode: ConversationMode, text: string, sourceMessageId: string) {
  return mode === 'auto' ? `${text}\n\n${TRAILER_OPEN}${sourceMessageId}]]` : text;
}

const FENCE_OPEN = '```diomedes-decision';
const RAW_LIMIT = 8000;
const SNAKE_TO_CAMEL = new Map<string, string>(
  Object.entries(PACKAGE_FIELD_NAMES).map(([camel, snake]) => [snake, camel]),
);

/** `absent`: no block, an ordinary answer. `refused`: a block that is not a valid proposal for this message. */
export type DecisionBlock = 'absent' | 'parsed' | 'refused';
export interface DecisionPhaseBody {
  /**
   * What the person typed. It is the instruction any work proposed from this message is
   * started with, and it is read from here on every retry, so a task or a Work command made
   * for this message always carries the same payload and reaches its own receipt.
   */
  text: string;
  restriction: Restriction;
  block: DecisionBlock;
  decision: InteractionDecision;
  /** The block as the model wrote it, when it was refused. The whole answer stays in the turn. */
  raw: string | null;
}

const answerOnly = (sourceMessageId: string): InteractionDecision => ({
  sourceMessageId,
  disposition: 'respond',
  requestedProjectId: null,
  operationClass: 'none',
  sourceRefs: [],
  targetRunId: null,
  question: null,
  publicSummary: '',
});

/**
 * Splits a committed answer into what the person reads and the first phase's body.
 *
 * The last fenced block tagged `diomedes-decision` is the proposal and everything before it is
 * the answer. No block is the common case and means an answer. A block that is not JSON, that
 * the frozen schema refuses, or that names any identity but the one issued for this message is
 * not a proposal: it degrades to an answer, never to anything wider, and is kept as evidence.
 * There is no second model call to repair it.
 *
 * The model writes the package's snake_case field names, which are renamed one for one. A
 * field the package does not name is refused by the strict schema, as any other error is.
 */
export function splitDecision(
  answer: string,
  sourceMessageId: string,
  restriction: Restriction,
  text: string,
): { answerText: string; body: DecisionPhaseBody } {
  const lines = answer.split('\n');
  let open = -1;
  for (let index = lines.length - 1; index >= 0; index--)
    if (lines[index].trim() === FENCE_OPEN) {
      open = index;
      break;
    }
  const fallback = answerOnly(sourceMessageId);
  if (open < 0)
    return {
      answerText: answer.trim(),
      body: { text, restriction, block: 'absent', decision: fallback, raw: null },
    };
  const answerText = lines.slice(0, open).join('\n').trim();
  let close = -1;
  for (let index = open + 1; index < lines.length; index++)
    if (lines[index].trim() === '```') {
      close = index;
      break;
    }
  const inner = lines.slice(open + 1, close < 0 ? lines.length : close).join('\n');
  const refused = {
    answerText,
    body: {
      text,
      restriction,
      block: 'refused' as const,
      decision: fallback,
      raw: inner.slice(0, RAW_LIMIT),
    },
  };
  if (close < 0) return refused;
  let parsed: unknown;
  try {
    parsed = JSON.parse(inner);
  } catch {
    return refused;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return refused;
  const renamed: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(parsed)) {
    // The package fixture allows no other property, so neither does this, camelCase included.
    const name = SNAKE_TO_CAMEL.get(key);
    if (!name) return refused;
    renamed[name] = value;
  }
  const decision = interactionDecisionSchema.safeParse(renamed);
  if (
    !decision.success ||
    !isIssuedSourceId(sourceMessageId) ||
    decision.data.sourceMessageId !== sourceMessageId
  )
    return refused;
  return {
    answerText,
    body: { text, restriction, block: 'parsed', decision: decision.data, raw: null },
  };
}

/** The splitter the driver is handed for one message. Pure, so it gives the same body on every replay. */
export function decideWith(sourceMessageId: string, restriction: Restriction, text: string) {
  return (answer: string): { answerText: string; body: Json } => {
    const split = splitDecision(answer, sourceMessageId, restriction, text);
    return { answerText: split.answerText, body: split.body as unknown as Json };
  };
}

/**
 * Keeps a streaming preview from showing the decision block. Text is held back only while it
 * could still turn out to be the start of the block's opening fence, so an ordinary answer is
 * delayed by at most that many characters, and once the fence is seen nothing more is shown.
 */
export function previewGate() {
  let held = '';
  let shut = false;
  return (delta: string): string => {
    if (shut) return '';
    held += delta;
    const at = held.indexOf(FENCE_OPEN);
    if (at >= 0) {
      shut = true;
      const out = held.slice(0, at);
      held = '';
      return out;
    }
    // The longest tail of what is held that is still a prefix of the fence stays held.
    let keep = Math.min(held.length, FENCE_OPEN.length - 1);
    while (keep > 0 && !FENCE_OPEN.startsWith(held.slice(held.length - keep))) keep--;
    const out = held.slice(0, held.length - keep);
    held = held.slice(held.length - keep);
    return out;
  };
}

/** What the person is told about one message, read from its phases and receipts and never from a copied status. */
export type InteractionOutcome =
  | { status: 'answered' }
  | { status: 'read'; projectId: string }
  | {
      status: 'proposed';
      projectId: string;
      operationClass: 'prepare_artifact' | 'write_internal';
      proposalDigest: string;
      summary: string;
    }
  | { status: 'started'; projectId: string; taskId: string; sessionId: string }
  | { status: 'not-started'; reason: BlockReason | 'refused'; message: string; taskId: string | null }
  | { status: 'unresolved'; message: string };

const BLOCKED: Record<BlockReason, string> = {
  'above-ceiling': 'This conversation is limited, so nothing was started.',
  'needs-target': 'Say which project this is for, and Diomedes can propose it there.',
  'home-is-not-a-target': 'Work starts inside a project, not in this conversation.',
  'unknown-target': 'That project was not found.',
  'cross-project-read': 'This conversation can only read its own project.',
  'build-not-reachable': 'Building a new capability from a conversation is not available yet.',
  'send-not-reachable': 'Sending anything outside the app from a conversation is not available yet.',
  'control-not-reachable': 'Use the run’s own controls to stop or resume it.',
  'stale-selection': 'That choice was for a different proposal. Nothing was started.',
};
export const blockedMessage = (reason: BlockReason) => BLOCKED[reason];

const bodyOf = <T>(phases: readonly InteractionPhase[], name: InteractionPhaseName): T | null => {
  const phase = phases.find((item) => item.phase === name);
  return phase ? (phase.body as unknown as T) : null;
};
export const decisionOf = (phases: readonly InteractionPhase[]) =>
  bodyOf<DecisionPhaseBody>(phases, 'decision');
export const selectionOf = (phases: readonly InteractionPhase[]) =>
  bodyOf<ActionSelection>(phases, 'action-selected');

export interface Receipts {
  /** The project the receipts were looked for in: the one the task input named, else the proposal's. */
  projectId: string | null;
  /** The task created under this message's derived task command, if one exists. */
  taskId: string | null;
  /** The work started under this message's derived work command, if any. */
  sessionId: string | null;
}

/**
 * The outcome, from evidence alone. Receipts found by their derived command ids are
 * authoritative whether or not their phase was ever linked, so a crash between an admission
 * and its phase still reads as started and is never sent twice. A refusal phase is final. An
 * input phase with no receipt and no refusal is unresolved, and says so. Nothing is reported
 * as started that did not start.
 *
 * `verdict` is what admission says about the recorded decision now. It is used only where the
 * phases are silent: to show a proposal, or to say why nothing was proposed.
 */
export function outcomeOf(
  phases: readonly InteractionPhase[],
  receipts: Receipts,
  verdict: AdmissionVerdict | null,
  options: { settled: boolean },
): InteractionOutcome {
  const recorded = decisionOf(phases);
  const refused =
    bodyOf<{ status: number; message: string }>(phases, 'work-refused') ??
    bodyOf<{ status: number; message: string }>(phases, 'task-refused');
  if (receipts.sessionId && receipts.taskId && receipts.projectId)
    return {
      status: 'started',
      projectId: receipts.projectId,
      taskId: receipts.taskId,
      sessionId: receipts.sessionId,
    };
  if (refused)
    return {
      status: 'not-started',
      reason: 'refused',
      message: refused.message,
      taskId: receipts.taskId,
    };
  const began = phases.some((item) => item.phase === 'task-input' || item.phase === 'work-input');
  if (began || receipts.taskId)
    return {
      status: 'unresolved',
      message: options.settled
        ? 'This conversation moved on before this was started. Send it again as a new message if you still want it.'
        : 'This did not finish starting. Send the same message again to finish it.',
    };
  if (!verdict || verdict.outcome === 'inert') return { status: 'answered' };
  if (verdict.outcome === 'read') return { status: 'read', projectId: verdict.projectId };
  if (verdict.outcome === 'blocked')
    return {
      status: 'not-started',
      reason: verdict.reason,
      message: blockedMessage(verdict.reason),
      taskId: null,
    };
  // A proposal on a settled conversation can no longer be started from it, and a selection
  // that never reached admission is unfinished, not started.
  if (options.settled || verdict.outcome === 'escalate')
    return {
      status: 'unresolved',
      message: options.settled
        ? 'This conversation moved on before this was started. Send it again as a new message if you still want it.'
        : 'This did not finish starting. Send the same message again to finish it.',
    };
  return {
    status: 'proposed',
    projectId: verdict.projectId,
    operationClass: verdict.operationClass,
    proposalDigest: verdict.proposalDigest,
    summary: recorded?.decision.publicSummary ?? '',
  };
}
