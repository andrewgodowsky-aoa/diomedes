import { api } from './api';
import type { QueuePause, ReadyQueueView } from '../shared/ready-queue';

// The Board's reads and writes for the Ready queue (H07). The view is derived by the local service
// from the task, session, Need and claim records on every request; nothing here keeps its own copy.

const queuePath = (projectId: string) => `/projects/${encodeURIComponent(projectId)}/ready-queue`;

export const readReadyQueue = (projectId: string, signal?: AbortSignal) =>
  api<ReadyQueueView>(queuePath(projectId), 'GET', undefined, signal);

export const configureReadyQueue = (
  projectId: string,
  change: { autoStart?: boolean; paused?: boolean; reason?: string },
) => api<ReadyQueueView>(queuePath(projectId), 'PUT', change);

export const pauseAllReadyQueues = (paused: boolean, reason?: string) =>
  api<{ allPaused: QueuePause | null }>('/ready-queue', 'PUT', {
    paused,
    ...(reason ? { reason } : {}),
  });

/** The one line the Board's header says about the queue. */
export function queueStatus(view: ReadyQueueView): string {
  if (view.allPaused) return `All queues paused · ${view.allPaused.reason}`;
  if (view.paused) return `Queue paused · ${view.paused.reason}`;
  if (!view.autoStart) return 'You start Ready work';
  return `Starts automatically · ${view.running} of ${view.limits.global} running across projects`;
}
