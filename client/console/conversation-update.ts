// "Update this conversation", the part of the client that is not React (ThreadMenu.tsx draws it).
// Two things live here. The one command id a thread's update is sent under, kept until the server
// answers it, so a press after an answer that never arrived reads back what the first press did.
// And the confirmation's words, taken from the server's decision (GET .../answer-format), because
// only the server knows the route the next message takes: a WorkStyle tier's route is its to
// resolve, and the thread's recorded route may not be it.

import { AGENT_NAME } from '../../shared/agent-name';
import type { ConversationUpdatePreview } from '../../shared/conversation';
import { routeDisplayName } from '../../shared/engines';
import { mintCommandId } from '../work-start';

interface Pending {
  id: string;
  /** Sent, and no answer came back: whether it was carried out is not known yet. */
  unconfirmed: boolean;
}
/** Per thread, for this page's lifetime; a reload reads the thread afresh, note and all. */
const commands = new Map<string, Pending>();
const keyOf = (projectId: string, threadId: string) => JSON.stringify([projectId, threadId]);

/**
 * The command id this thread's update is sent under: the same one until the server answers it, in
 * this confirmation or after it is closed and opened again. The server carries out one command
 * once, so a second press reads back what the first did rather than finding nothing to update.
 */
export function updateCommand(projectId: string, threadId: string, mint: () => string = mintCommandId): string {
  const key = keyOf(projectId, threadId);
  let pending = commands.get(key);
  if (!pending) {
    pending = { id: mint(), unconfirmed: false };
    commands.set(key, pending);
  }
  return pending.id;
}

/** The update went out and no answer came back. The same command is sent again next time. */
export function updateUnanswered(projectId: string, threadId: string, commandId: string): void {
  const pending = commands.get(keyOf(projectId, threadId));
  if (pending?.id === commandId) pending.unconfirmed = true;
}

/** The server answered this command, whatever it said: the next update is a new one. */
export function updateAnswered(projectId: string, threadId: string, commandId: string): void {
  const key = keyOf(projectId, threadId);
  if (commands.get(key)?.id === commandId) commands.delete(key);
}

/** Whether an update of this thread was sent and never answered. */
export function updateUnconfirmed(projectId: string, threadId: string): boolean {
  return commands.get(keyOf(projectId, threadId))?.unconfirmed === true;
}

/**
 * Whether the conversation menu can act: the server says the update would start something fresh,
 * or an update was sent whose answer never came back and can be asked again. Nowhere else.
 */
export function canUpdate(preview: ConversationUpdatePreview | null, unconfirmed: boolean): boolean {
  return unconfirmed || (preview?.retiring ?? 0) > 0;
}

/** The confirmation's sentence about memory: the server's decision, in plain words. */
export function memorySentence(preview: ConversationUpdatePreview): string {
  const route = routeDisplayName(preview.route);
  if (preview.carried)
    return `History sharing is on for ${route}, so ${AGENT_NAME} will carry over your most recent messages.`;
  if (preview.reason === 'history-off')
    return `History sharing is off for ${route}, so your earlier messages stay on screen but ${AGENT_NAME} won't remember them. Updating doesn't turn sharing on.`;
  if (preview.reason === 'other-route')
    return `Your earlier messages were answered on another service, so ${AGENT_NAME} won't carry them over to ${route}. They stay on screen.`;
  return `Your earlier messages stay on screen, but ${AGENT_NAME} won't remember them.`;
}

/** Said when an update went out and its answer never arrived. */
export const UNANSWERED =
  "The update's answer didn't arrive. Press Update again to check whether it went through; it's never done twice.";
/** Said on opening the confirmation again after that, when nothing is left to update. */
export const CHECK_UNANSWERED =
  'Your last update may have gone through already. Press Update to check; nothing is done twice.';
