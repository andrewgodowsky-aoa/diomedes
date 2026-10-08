import type { HarnessRun } from '../shared/harness.js';
import { withoutFraming } from './agent-framing.js';
import { answeredTurns, cutHistory } from './harness/conversation-history.js';
import { withoutTrailer } from './interaction-turn.js';

/** At most this many characters of the other lane's last exchange come along. */
export const RECAP_CHARS = 2_000;
const OPEN = 'Earlier in this thread:\n\n';
const NEW_MESSAGE = '\n\nThe new message:\n\n';

/**
 * What the person said in a message a lane recorded: without the identity line an Automatic
 * message closes with, the marker line a non-default Agent opens with, or a recap the message
 * brought from another lane. So one lane's framing never reaches another lane, and recaps never
 * pile up as Auto moves a thread between lanes.
 */
export function spokenPrompt(prompt: string): string {
  const text = withoutFraming(withoutTrailer(prompt));
  if (!text.startsWith(OPEN)) return text;
  const at = text.indexOf(NEW_MESSAGE);
  return at < 0 ? text : text.slice(at + NEW_MESSAGE.length);
}

/**
 * The last answered exchange of another lane, for a message that moves lanes (DIO-292). Lanes
 * are per kind of run, so when Auto picks Planner after Researcher answered, Planner's lane has
 * not seen that answer. Read from the durable run, as history is, never from the transcript.
 */
export function laneRecap(previous: HarnessRun | null): string | null {
  if (!previous) return null;
  const last = answeredTurns([previous]).at(-1);
  if (!last?.answer) return null;
  const lines = [...(last.prompt === null ? [] : [`Person: ${spokenPrompt(last.prompt)}`]), `Diomedes: ${last.answer}`];
  return `${OPEN}${cutHistory([{ runId: previous.id, text: lines.join('\n\n') }], RECAP_CHARS).text}`;
}

/** The message as the lane receives it: the recap first, then what was asked now. */
export function withRecap(prompt: string, recap: string | null): string {
  return recap ? `${recap}${NEW_MESSAGE}${prompt}` : prompt;
}
