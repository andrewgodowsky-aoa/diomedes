/**
 * Worker rows in the Console (plan section 4.8, S1): one project's rows, read from
 * `GET /api/projects/:id/work/rows` when they're shown and again every few seconds while they
 * are. Never derived from the `state` event, and reading or refreshing rows calls no model (A38):
 * the server projects them from its records.
 *
 * The rows hold no stream of their own. The page already keeps its event streams open, and a
 * browser keeps at most six connections to one host, so two windows that each held one more left
 * none for an ordinary request (CD05-R-10). `/api/events?topics=work-rows` stays for other readers.
 */
import { useEffect, useState } from 'react';
import type { WorkRowsSnapshot } from '../shared/work-rows';
import { api } from './api';

/** How often rows on screen are read again. */
export const WORK_ROWS_REFRESH_MS = 3_000;

export function readWorkRows(projectId: string, signal?: AbortSignal): Promise<WorkRowsSnapshot> {
  return api<WorkRowsSnapshot>(`/projects/${encodeURIComponent(projectId)}/work/rows`, 'GET', undefined, signal);
}

const hidden = () => typeof document !== 'undefined' && document.visibilityState === 'hidden';

/** The rows for one project, or null until the first read lands. A newer snapshot always wins. */
export function useWorkRows(projectId: string | null): WorkRowsSnapshot | null {
  const [snapshot, setSnapshot] = useState<WorkRowsSnapshot | null>(null);
  useEffect(() => {
    setSnapshot(null);
    if (!projectId) return;
    const control = new AbortController();
    let latest = '';
    let reading = false;
    const take = (next: WorkRowsSnapshot) => {
      if (control.signal.aborted || next.projectId !== projectId || next.at < latest) return;
      latest = next.at;
      setSnapshot(next);
    };
    // One read at a time, and none while the window is hidden; showing it reads at once.
    const read = () => {
      if (reading || control.signal.aborted) return;
      reading = true;
      void readWorkRows(projectId, control.signal)
        .then(take, () => undefined)
        .finally(() => { reading = false; });
    };
    const timer = setInterval(() => { if (!hidden()) read(); }, WORK_ROWS_REFRESH_MS);
    const shown = () => { if (!hidden()) read(); };
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', shown);
    read();
    return () => {
      control.abort();
      clearInterval(timer);
      if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', shown);
    };
  }, [projectId]);
  return snapshot;
}
