import { diomedesThread } from '../shared/diomedes-thread.js';
import type { ProjectState } from '../shared/types.js';

/**
 * Additive, once per project, after the Store normalises legacy conversations.
 * Keep precisely the thread the old reader selected, without rewriting its contents or route.
 * A marker already written by provisioning wins over the legacy rule. Recording the empty
 * case prevents a later ordinary conversation from being adopted on the next restart.
 * The Store persists this revision and the marker together with its existing atomic writer.
 */
export function migrateProjectConversation(state: ProjectState, isHome: boolean): boolean {
  if (state.projectConversationIdentity === 1) return false;
  if (!isHome && !diomedesThread(state.conversations)) {
    const candidates = state.conversations.filter(
      (thread) =>
        thread.attachedTo.kind === 'project' &&
        !thread.taskId &&
        ((thread.lineages?.length ?? 0) > 0 || thread.mode === 'auto'),
    );
    candidates.sort(
      (a, b) => (a.createdAt ?? '').localeCompare(b.createdAt ?? '') || a.id.localeCompare(b.id),
    );
    if (candidates[0]) candidates[0].conversation = 'project';
  }
  state.projectConversationIdentity = 1;
  return true;
}
