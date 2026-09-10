import type { HarnessRun } from '../../shared/harness';
import type { HistoryEntry, Need, Session } from '../../shared/types';
import { api } from '../api';

export interface RunReference {
  id: string;
  taskId: string | null;
  sessionId: string | null;
}

/** Every lookup remains project scoped; names and chronology are not identities. */
export async function loadHarnessEvidence(
  projectId: string,
  session: Pick<Session, 'id' | 'taskId'>,
  signal: AbortSignal,
): Promise<HarnessRun | null> {
  const base = `/projects/${encodeURIComponent(projectId)}/harness/runs`;
  const list = await api<{ runs: RunReference[] }>(base, 'GET', undefined, signal);
  const matches = list.runs.filter(
    (run) => run.sessionId === session.id && run.taskId === session.taskId,
  );
  if (!matches.length) return null;
  if (matches.length !== 1)
    throw new Error('More than one run is linked to this session. Refresh the task record.');
  const run = await api<HarnessRun>(
    `${base}/${encodeURIComponent(matches[0].id)}`,
    'GET',
    undefined,
    signal,
  );
  if (
    run.projectId !== projectId ||
    run.taskId !== session.taskId ||
    run.sessionId !== session.id ||
    run.id !== matches[0].id
  )
    throw new Error('The run record no longer matches this session. Refresh the task record.');
  return run;
}

export function sessionEvidence(
  session: Session,
  needs: readonly Need[],
  history: readonly HistoryEntry[],
) {
  const ownNeeds = needs.filter(
    (need) => need.sessionId === session.id && need.taskId === session.taskId,
  );
  // Session snapshots are written session-scoped with a null taskId
  // (server/work.ts calls snapshot(projectId, null, session.id)); a non-null
  // taskId that disagrees is a different task's record and stays excluded.
  const ownHistory = history.filter(
    (entry) =>
      entry.sessionId === session.id && (entry.taskId === null || entry.taskId === session.taskId),
  );
  const sources: { path: string; sha: string; basis: 'Proposal source' | 'Saved source' }[] = [];
  const seen = new Set<string>();
  const add = (path: string, sha: string, basis: (typeof sources)[number]['basis']) => {
    const key = JSON.stringify([path, sha]);
    if (!seen.has(key)) {
      sources.push({ path, sha, basis });
      seen.add(key);
    }
  };
  for (const need of ownNeeds) {
    for (const source of need.approval?.sources ?? [])
      add(source.path, source.sha, 'Proposal source');
  }
  for (const entry of ownHistory) {
    if (entry.kind !== 'saved-version') continue;
    for (const file of entry.files) {
      if (file.recorded && file.before !== null && file.before === file.after)
        add(file.path, file.before, 'Saved source');
    }
  }
  return { needs: ownNeeds, history: ownHistory, sources };
}
