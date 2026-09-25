import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import { TriggerRules } from './TriggerRules';
import type { StreamRulesView } from './trigger-rules-model';

/**
 * One line in the thread head, under Project instructions, saying how many
 * trigger rules watch this task's Diomedes loop runs, and a panel that lists
 * and edits the project's rules beside the organization's. The count is the
 * server's H11 resolution for this task, never a count of its own.
 */
export function ProjectTriggerRules({
  projectId,
  taskId,
  tasks,
}: {
  projectId: string;
  taskId: string | null;
  tasks: readonly { id: string; name: string }[];
}) {
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<StreamRulesView | null>(null);
  const read = `/projects/${projectId}/stream-rules${taskId ? `?taskId=${encodeURIComponent(taskId)}` : ''}`;
  const load = useCallback(() => {
    api<StreamRulesView>(read).then(setView, () => setView(null));
  }, [read]);
  useEffect(load, [load]);

  const watching = view?.resolution?.active.length ?? 0;
  const written = view ? view.organization.length + view.project.length : 0;
  const summary = !view
    ? ''
    : written === 0
      ? 'none'
      : `${watching} ${taskId ? `watch${watching === 1 ? 'es' : ''} this task` : `in force`} · ${view.project.length} project · ${view.organization.length} organization`;
  return (
    <div className="instructions trigger-rules-head">
      <button
        type="button"
        className="instructions-line"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        title={summary}
      >
        <span className="instructions-lead">Trigger rules ·</span> <span>{summary}</span>
      </button>
      {open && (
        <div className="instructions-panel">
          <TriggerRules authority="project" projectId={projectId} taskId={taskId} tasks={tasks} onChange={load} />
        </div>
      )}
    </div>
  );
}
