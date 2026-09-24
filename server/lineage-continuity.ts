/**
 * Whether an open conversation keeps its instructions, and what the thread says when it cannot
 * (owner decisions of 2026-09-23).
 *
 * A lineage keeps the text it started with when this build knows that text and has not revoked
 * it (`instruction-digests.ts`). When a lineage retires for any reason, its next generation starts
 * without the earlier context, so the thread gets one plain note saying so, written with the
 * retirement itself.
 */
import { createHash } from 'node:crypto';
import type { ConversationLineage, Mode, Route, Turn } from '../shared/types.js';
import { AGENT_NAME } from '../shared/agent-name.js';
import { applicationOrigin } from '../shared/attribution.js';
import {
  instructionDigest,
  KNOWN_INSTRUCTION_DIGESTS,
  REVOKED_INSTRUCTION_DIGESTS,
} from './instruction-digests.js';

/** A lineage run's recorded instruction text, judged against the lists in code. */
export type RecordedInstructions =
  | { state: 'known'; text: string }
  | { state: 'revoked'; text: string }
  | { state: 'unknown'; text: string }
  | { state: 'absent' };

/**
 * Reads `instructions` from a lineage run's recorded scope (`run.input`), for a lineage of `mode`.
 * A text is known only for the mode that composed it; another mode's text is unknown here.
 */
export function recordedInstructions(runInput: unknown, mode: ConversationLineage['mode']): RecordedInstructions {
  const text = (runInput as { instructions?: unknown } | null)?.instructions;
  if (typeof text !== 'string') return { state: 'absent' };
  const digest = instructionDigest(text);
  if (REVOKED_INSTRUCTION_DIGESTS.has(digest)) return { state: 'revoked', text };
  return KNOWN_INSTRUCTION_DIGESTS.get(digest)?.mode === mode ? { state: 'known', text } : { state: 'unknown', text };
}

/**
 * Whether a lineage was written before lineages recorded the route, model and level they run on,
 * as every 0.1.7 lineage was. Wave2's checks on those fields leave such a lineage as it is: none of
 * them was recorded, so none of them can have moved. A lineage opened since records its route and
 * model, and its level whenever a style set one.
 */
export function predatesTierFields(lineage: Pick<ConversationLineage, 'effort' | 'route' | 'model'>): boolean {
  return lineage.effort === undefined && lineage.route === undefined && lineage.model === undefined;
}

/**
 * The text a message on an existing lineage is sent with: the recorded one when it is known and
 * not revoked, and the session can take it; otherwise today's composed text, which the scope
 * check then refuses when the two differ, so the lineage retires as it always has.
 *
 * `resumable` is false only for a native Claude Code session whose saved read scope differs from
 * this turn's. That session refuses to resume inside its turn step, which fails the message
 * instead of retiring the lineage, so it keeps today's composed text and retires cleanly first.
 */
export function boundInstructions(input: {
  composed: string;
  recorded: RecordedInstructions | null;
  resumable: boolean;
}): string {
  return input.recorded?.state === 'known' && input.resumable ? input.recorded.text : input.composed;
}

/** Why a lineage retired, in the terms its note uses. */
export type RetirementCause =
  | 'instructions'
  | 'revoked'
  | 'tier'
  | 'route'
  | 'model'
  | 'settings'
  | 'terminated'
  | 'budget'
  | 'format-change'
  | 'unreadable';

/** What a note may name. `carried` is read only for `format-change`: whether history came along. */
export interface RetirementDetail {
  tier?: string;
  route?: string;
  carried?: boolean;
}

function because(cause: RetirementCause, detail: RetirementDetail): string {
  switch (cause) {
    case 'instructions':
    case 'revoked':
      return 'its instructions changed';
    case 'format-change':
      return 'you updated it to the current instructions';
    case 'tier':
      return detail.tier
        ? `this conversation moved to the ${detail.tier} tier`
        : 'this conversation moved to another tier';
    case 'route':
      return detail.route ? `this conversation moved to ${detail.route}` : 'this conversation moved to another service';
    case 'model':
      return 'this conversation now uses a different model';
    case 'settings':
      return 'the settings it runs with changed';
    case 'terminated':
      return 'the earlier conversation stopped and could not be picked up again';
    case 'budget':
      return 'the earlier conversation reached its length limit';
    case 'unreadable':
      return 'an earlier part of it could not be read';
  }
}

/**
 * The note's words. Plain, and the same for every route. Only "Update this conversation" can carry
 * the earlier messages over, and only where history sharing is on; it says which happened.
 */
export function retirementNote(cause: RetirementCause, detail: RetirementDetail = {}): string {
  // A run this build cannot read may belong to a lineage that retired long ago, so nothing
  // necessarily starts fresh; the note says only what is lost.
  if (cause === 'unreadable')
    return `${AGENT_NAME} couldn't read an earlier part of this conversation, so it won't remember that part. Your earlier messages are still here.`;
  const memory =
    cause === 'format-change' && detail.carried
      ? 'and it carried over the most recent ones'
      : "but it won't remember them";
  return `${AGENT_NAME} started this conversation fresh because ${because(cause, detail)}. Your earlier messages are still here, ${memory}.`;
}

/** Names the note for one retirement and the message that caused it, so a retry finds it. */
export function lineageNoteId(retiredRunId: string, commandId: string): string {
  return `Nlineage-${createHash('sha256').update(JSON.stringify([retiredRunId, commandId]), 'utf8').digest('hex').slice(0, 32)}`;
}

/**
 * Names the one note for a run this build cannot read. The run stays unreadable, and every later
 * message meets it again, so the note is named for the run alone: the thread says it once.
 */
export function unreadableNoteId(runId: string): string {
  return `Nunreadable-${createHash('sha256').update(JSON.stringify([runId]), 'utf8').digest('hex').slice(0, 32)}`;
}

/**
 * The note turn. The application wrote it, so it carries the application's origin and no
 * model; its route is the one the conversation continues on, so a reader that takes a thread's
 * route from its last answer (`selectedEngine`) reads the same route with the note in place.
 */
export function lineageNoteTurn(input: {
  retiredRunId: string;
  commandId: string;
  cause: RetirementCause;
  detail?: RetirementDetail;
  mode: Mode;
  route: Route;
  at: string;
}): Turn {
  return {
    id:
      input.cause === 'unreadable'
        ? unreadableNoteId(input.retiredRunId)
        : lineageNoteId(input.retiredRunId, input.commandId),
    role: 'diomedes',
    mode: input.mode,
    text: retirementNote(input.cause, input.detail),
    at: input.at,
    sources: [],
    route: input.route,
    origin: applicationOrigin(),
  };
}
