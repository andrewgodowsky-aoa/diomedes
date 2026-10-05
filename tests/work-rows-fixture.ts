/**
 * A WorkRowsSource over snapshots a test sets (shared/work-rows.ts), for the phone relay's tests.
 * The production source projects the desktop's own records (server/relay/work-rows.ts); this one
 * answers whatever the test last set and tells subscribers, exactly as a source must.
 */
import type { WorkRowsSnapshot, WorkRowsSource } from '../shared/work-rows';

export function fixtureWorkRows(initial: readonly WorkRowsSnapshot[] = []) {
  const snapshots = new Map(initial.map((snapshot) => [snapshot.projectId, snapshot]));
  const listeners = new Set<(projectId: string) => void>();
  const source: WorkRowsSource = {
    snapshot: async (projectId) => snapshots.get(projectId) ?? null,
    projects: async () => [...snapshots.keys()],
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
  return {
    source,
    /** Replaces a project's rows and tells every subscriber. */
    set(snapshot: WorkRowsSnapshot) {
      snapshots.set(snapshot.projectId, snapshot);
      for (const listener of [...listeners]) listener(snapshot.projectId);
    },
    /** Takes a project's rows away and tells every subscriber. */
    clear(projectId: string) {
      snapshots.delete(projectId);
      for (const listener of [...listeners]) listener(projectId);
    },
    /** How many subscribers are listening now. */
    listeners: () => listeners.size,
  };
}
