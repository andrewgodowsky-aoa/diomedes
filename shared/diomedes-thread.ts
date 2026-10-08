import type { Conversation } from './types.js';

/**
 * The thread a project's own Diomedes conversation lives on, or null when there is none yet.
 *
 * Only the persisted marker identifies it. Agent, mode, route, lineages and the last task it
 * started may all change without changing identity. Legacy selection runs once in the Store
 * migration; readers never infer identity from an ordinary thread's activity.
 *
 * It lives beside the types rather than on a screen because two readers apply it: the page, which
 * loads a project's state and shows the conversation it finds, and `provisionProjectConversation`,
 * which provisions under the Store lock. One rule in one place keeps those two from disagreeing
 * about which thread is the project's conversation.
 */
export function diomedesThread(conversations: readonly Conversation[]): Conversation | null {
  const mine = conversations.filter(
    (thread) => thread.attachedTo.kind === 'project' && thread.conversation === 'project',
  );
  mine.sort(
    (a, b) => (a.createdAt ?? '').localeCompare(b.createdAt ?? '') || a.id.localeCompare(b.id),
  );
  return mine[0] ?? null;
}
