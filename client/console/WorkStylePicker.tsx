import { useEffect, useState } from 'react';
import type { Conversation, Settings } from '../../shared/types';
import { isWorkStyle, type WorkStyle, type WorkStyleResolution } from '../../shared/work-style';
import { routeDisplayName } from '../../shared/engines';
import { api } from '../api';

/** What `GET /projects/:id/threads/:threadId/work-style` answers. */
export interface WorkStyleView {
  route: string;
  style: WorkStyle | null;
  source: 'thread' | 'settings' | 'default' | 'none';
  /** The host's sentence when the next request would be refused before anything is sent. */
  refusal?: string | null;
  resolution: WorkStyleResolution | null;
  expert?: { available: boolean; reason: string | null };
}

/** The style a thread follows: its own, else the Settings default, else none. */
export function threadStyle(thread: Conversation, settings: Settings): WorkStyle | null {
  if (isWorkStyle(thread.workStyle)) return thread.workStyle;
  const saved = settings.services?.workStyle;
  return isWorkStyle(saved) ? saved : null;
}

/**
 * The resolved model and level, as the details line writes them. Only a route
 * whose adapter reads a level shows one: Codex and AWS today.
 */
export function resolvedDetail(view: WorkStyleView | null): string {
  const r = view?.resolution;
  if (!view || !r) return '';
  if (r.outcome === 'ask') return r.reason;
  const model = r.model ?? 'engine default';
  const effort = r.effort && (view.route === 'codex' || view.route === 'aws-bedrock') ? ` ${r.effort}` : '';
  return `${model}${effort} · ${routeDisplayName(view.route)}`;
}

/**
 * Reads what the thread's next request would run with. Refreshed whenever a
 * choice that could move it changes; a failed read leaves the last answer.
 */
export function useWorkStyleView(
  projectId: string | undefined,
  thread: Conversation,
  keys: readonly unknown[],
): WorkStyleView | null {
  const [view, setView] = useState<WorkStyleView | null>(null);
  useEffect(() => {
    if (!projectId) return;
    let alive = true;
    api<WorkStyleView>(
      `/projects/${encodeURIComponent(projectId)}/threads/${encodeURIComponent(thread.id)}/work-style`,
    )
      .then((next) => {
        if (alive) setView(next);
      })
      .catch(() => {
        // Nothing is invented when the read fails.
      });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, thread.id, thread.workStyle, thread.requested?.model, thread.requested?.effort, ...keys]);
  return view;
}
