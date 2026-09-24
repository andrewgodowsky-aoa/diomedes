import { useEffect, useState } from 'react';
import type { AttentionView } from '../../shared/automations';
import type { ActivityRow } from './activity';
import { projectAttention } from './automation-schedule-api';

/**
 * Automations Milestone B (OPS-10, in-app only): the open attention items for
 * the project on screen, as Needs you rows. One row per underlying issue, as
 * the host deduplicated it; nothing here is pushed, emailed or kept.
 *
 * `refresh` is any value that changes when the project's records do (the
 * Shell passes its History length and view), so a new item or one marked as
 * seen is re-read without a timer.
 */
export function attentionRow(item: AttentionView): ActivityRow {
  return {
    id: `automation:${item.id}`,
    label: `${item.automationName}: ${item.title}`,
    detail: item.count > 1 ? `${item.detail} (${item.count} times)` : item.detail,
    view: 'Automations',
    at: item.lastSeenAt,
  };
}

export function useAutomationAttention(projectId: string, refresh: unknown): ActivityRow[] {
  const [rows, setRows] = useState<ActivityRow[]>([]);
  useEffect(() => {
    const request = new AbortController();
    projectAttention(projectId, request.signal)
      .then((result) => {
        if (!request.signal.aborted) setRows(result.items.map(attentionRow));
      })
      .catch(() => {
        // An unreadable list leaves Needs you as the project's own records say.
        if (!request.signal.aborted) setRows([]);
      });
    return () => request.abort();
  }, [projectId, refresh]);
  return rows;
}
