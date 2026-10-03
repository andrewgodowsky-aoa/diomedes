/**
 * Worker rows in the Console (plan section 4.8, S1): one project's rows, read once from
 * `GET /api/projects/:id/work/rows` and then kept current by the small `work-rows` event on
 * the existing stream. Never derived from the `state` event, and reading or refreshing rows
 * calls no model (A38): the server projects them from its records.
 *
 * Every hook on the page shares one event stream, opened while any of them listens.
 */
import { useEffect, useState } from 'react';
import type { WorkRowsSnapshot } from '../shared/work-rows';
import { api } from './api';

type Listener = { rows(snapshot: WorkRowsSnapshot): void; reconnected(): void };
const listeners = new Set<Listener>();
let source: EventSource | null = null;

function onRows(event: Event) {
  let snapshot: WorkRowsSnapshot;
  try {
    snapshot = JSON.parse((event as MessageEvent).data) as WorkRowsSnapshot;
  } catch {
    return;
  }
  for (const listener of listeners) listener.rows(snapshot);
}

// A reconnect replays nothing, so each listener reads its rows again.
function onReady() {
  for (const listener of listeners) listener.reconnected();
}

function listen(listener: Listener): () => void {
  listeners.add(listener);
  if (!source && typeof EventSource !== 'undefined') {
    source = new EventSource('/api/events');
    source.addEventListener('work-rows', onRows);
    source.addEventListener('ready', onReady);
  }
  return () => {
    listeners.delete(listener);
    if (!listeners.size && source) {
      source.close();
      source = null;
    }
  };
}

export function readWorkRows(projectId: string, signal?: AbortSignal): Promise<WorkRowsSnapshot> {
  return api<WorkRowsSnapshot>(`/projects/${encodeURIComponent(projectId)}/work/rows`, 'GET', undefined, signal);
}

/** The rows for one project, or null until the first read lands. A newer snapshot always wins. */
export function useWorkRows(projectId: string | null): WorkRowsSnapshot | null {
  const [snapshot, setSnapshot] = useState<WorkRowsSnapshot | null>(null);
  useEffect(() => {
    setSnapshot(null);
    if (!projectId) return;
    const control = new AbortController();
    let latest = '';
    const take = (next: WorkRowsSnapshot) => {
      if (control.signal.aborted || next.projectId !== projectId || next.at < latest) return;
      latest = next.at;
      setSnapshot(next);
    };
    const read = () => void readWorkRows(projectId, control.signal).then(take, () => undefined);
    const off = listen({ rows: take, reconnected: read });
    read();
    return () => {
      control.abort();
      off();
    };
  }, [projectId]);
  return snapshot;
}
