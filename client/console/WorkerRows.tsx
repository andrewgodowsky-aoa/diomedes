import type { WorkerRow, WorkerRowPayer, WorkerRowState, WorkerRowVerification } from '../../shared/work-rows';
import { useWorkRows } from '../work-rows';
import './verification.css';
import './worker-rows.css';

/**
 * Who is working (plan section 4.8, S1): the project's worker rows in the Team view, and a
 * compact slot in the Agent conversation that lists only the work still running. Each row
 * says the route by its Console name, the task, its state, who pays for it and, once checked,
 * its verification. Fed by `useWorkRows` alone (client/work-rows.ts).
 *
 * LeadWorkers.tsx was read first and is not reused: it renders one H14 lead in full, with
 * each worker's files, budget and answer, which a worker row must never carry.
 */

export const WORKER_STATE_WORD: Record<WorkerRowState, string> = {
  queued: 'Queued',
  working: 'Working',
  waiting: 'Waiting',
  'stop-requested': 'Stop requested',
  stopped: 'Stopped',
  answered: 'Answered',
  failed: 'Failed',
  unknown: 'Unknown',
};

export const WORKER_PAYER_WORD: Record<WorkerRowPayer, string> = {
  'nectovia-credits': 'Nectovia credits',
  'your-subscription': 'Your subscription',
  'your-key': 'Your key',
  local: 'On this computer',
  unknown: 'Payer not known',
};

const VERIFICATION_WORD: Record<Exclude<WorkerRowVerification, 'not-run'>, string> = {
  verified: 'Verified',
  unverified: 'Not verified',
  failed: 'Failed verification',
};
const VERIFICATION_BADGE: Record<Exclude<WorkerRowVerification, 'not-run'>, string> = {
  verified: 'verified',
  unverified: 'not-verified',
  failed: 'failed',
};

const LIVE: readonly WorkerRowState[] = ['queued', 'working', 'waiting', 'stop-requested'];

export function WorkerRowList({ rows, compact = false }: { rows: readonly WorkerRow[]; compact?: boolean }) {
  const shown = compact ? rows.filter((row) => LIVE.includes(row.state)) : rows;
  if (shown.length === 0) return null;
  return (
    <section className={`worker-rows${compact ? ' compact' : ''}`} aria-label="Workers">
      {!compact && <h2 className="caption">Workers</h2>}
      <ul>
        {shown.map((row) => (
          <li key={row.rowId} data-row-kind={row.kind} data-row-state={row.state}>
            <span className={`wr-pt${LIVE.includes(row.state) ? ' live' : ''}`} aria-hidden="true" />
            <span className="wr-label">{row.label}</span>
            <span className="wr-title" title={row.title}>
              {row.title}
            </span>
            <span className="wr-state">{WORKER_STATE_WORD[row.state]}</span>
            <span className="wr-payer">{WORKER_PAYER_WORD[row.payer]}</span>
            {row.verification !== 'not-run' && (
              <span className={`verif-badge ${VERIFICATION_BADGE[row.verification]}`}>
                {VERIFICATION_WORD[row.verification]}
              </span>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

export function WorkerRows({ projectId, compact = false }: { projectId: string | null; compact?: boolean }) {
  const snapshot = useWorkRows(projectId);
  if (!snapshot) return null;
  return <WorkerRowList rows={snapshot.rows} compact={compact} />;
}
