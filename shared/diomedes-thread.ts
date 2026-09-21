import type { Conversation } from './types.js';

/**
 * The thread a project's own Diomedes conversation lives on, or null when there is none yet.
 *
 * The same rule the home conversation uses, for the same reason: the oldest qualifying thread,
 * ties broken by id, so every window and every restart agree on one. A thread qualifies when it
 * belongs to the project itself (not to a task, a document or a review) and either has spoken
 * through the conversation routes (it has lineages) or was made for them (its Mode is Automatic,
 * which is what a Diomedes conversation is made with). Adopting before creating is what keeps a
 * crash between making the thread and sending the first message from leaving two.
 *
 * It lives beside the types rather than on a screen because two readers apply it: the page, which
 * loads a project's state and shows the conversation it finds, and `provisionProjectConversation`,
 * which adopts under the Store lock. One rule in one place is what keeps those two from disagreeing
 * about which thread is the project's conversation.
 */
export function diomedesThread(conversations: readonly Conversation[]): Conversation | null {
  const mine = conversations.filter(
    (thread) =>
      thread.attachedTo.kind === 'project' &&
      !thread.taskId &&
      ((thread.lineages?.length ?? 0) > 0 || thread.mode === 'auto'),
  );
  mine.sort(
    (a, b) => (a.createdAt ?? '').localeCompare(b.createdAt ?? '') || a.id.localeCompare(b.id),
  );
  return mine[0] ?? null;
}
