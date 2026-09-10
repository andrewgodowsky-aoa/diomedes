import type { HarnessRun } from '../../shared/harness';
import type { HistoryEntry, Need, Session } from '../../shared/types';
import type { EvidenceView } from '../../shared/execution';
import { originForSession } from '../../shared/attribution';
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

/**
 * The evidence a session can honestly show right now.
 *
 * A session already records its Agent snapshot, its route and the permission
 * that snapshot resolved to — none of which the inspector has ever displayed.
 * Everything else the harness contract asks for (which business, which setup,
 * which rules, who paid) is not yet written down beside a session, so each of
 * those comes back unknown with the reason.
 *
 * The alternative was to leave the rows out until the whole record exists. That
 * would have been worse: the point of naming a gap is that somebody can see it
 * is a gap, and a screen that quietly omits "nobody reviewed this" is telling a
 * person the opposite of the truth.
 */
export function sessionEvidenceView(session: Session): EvidenceView {
  const agent = session.agent ?? null;
  const origin = originForSession(session);
  const notRecorded = (what: string) => `Nothing records ${what} for this session yet.` as const;
  return {
    ids: {
      agentId: agent?.agentId ?? 'unknown',
      agentVersion: agent?.agentVersion ?? 'unknown',
      routeId: session.route ?? session.receipt?.route ?? 'unknown',
      configurationRevision: null,
      payerKind: 'person',
    },
    person: { known: false, why: notRecorded('who started it') },
    organization: { known: false, why: notRecorded('which business it ran under') },
    agent: agent
      ? { known: true, value: `${agent.agentName} ${agent.agentVersion}` }
      : { known: false, why: 'This work ran before Agent snapshots were recorded.' },
    team: { known: false, why: 'This job did not run as part of a team.' },
    handoff: { known: false, why: 'Nothing was handed to this job.' },
    // `reported` is what actually ran. `requested` is what was asked for, and
    // showing it here would relabel a run with a model that may never have seen it.
    model:
      origin?.model.source === 'runtime' && origin.model.reported
        ? { known: true, value: origin.model.reported }
        : { known: false, why: 'The runtime did not report which model answered.' },
    runtime: origin?.engine?.id
      ? { known: true, value: origin.engine.id }
      : { known: false, why: 'The runtime did not identify itself.' },
    choice: {
      agent: agent?.agentSelection ?? 'automatic',
      model: agent?.modelSelection ?? 'runtime-default',
    },
    configuration: { known: false, why: notRecorded('which business setup was active') },
    rules: { known: false, why: notRecorded('which rules governed it') },
    governing: [],
    authority: agent
      ? { known: true, value: agent.policy.effective }
      : { known: false, why: notRecorded('what it was permitted to do') },
    payer: { known: false, why: notRecorded('who paid') },
    reservation: { known: false, why: 'Nothing was reserved for this work.' },
    effect: { known: false, why: 'See the recorded authorization below.' },
    verification: { known: false, why: 'This has not been checked yet.' },
    roles: {
      proposer: agent
        ? { known: true, value: agent.agentName }
        : { known: false, why: 'Nobody is recorded as having proposed this.' },
      reviewer: { known: false, why: 'Nobody reviewed this.' },
      writer: { known: false, why: 'See the recorded authorization below.' },
      verifier: { known: false, why: 'Nobody has checked the result.' },
    },
  };
}
