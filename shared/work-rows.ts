/**
 * Worker rows: one compact line per piece of work running for a project, the shape the phone relay
 * sends as `work.rows` (relay plan step 3, docs/implementation/2026-09-26-phone-relay-protocol.md).
 *
 * The rows are a projection of the desktop's own records (runs, the H14 handoff ledger, Team
 * members and work sessions), never a second lifecycle. A row carries a title and a state, never
 * a file path, a document's contents, an answer, a mailbox message or a log line.
 */

/** What a row stands for: an H14 worker, an external engine's worker, a Team member, or a work session. */
export type WorkerRowKind = 'h14-worker' | 'external-worker' | 'team-member' | 'session';

/**
 * Where the work is. `stop-requested` holds from the moment a Stop is asked for until the run
 * reaches a terminal state; `unknown` is a state the projection cannot read.
 */
export type WorkerRowState = 'queued' | 'working' | 'waiting' | 'stop-requested' | 'stopped' | 'answered' | 'failed' | 'unknown';

/** Who pays for the work: Nectovia credits, the person's own subscription or key, this computer, or not known. */
export type WorkerRowPayer = 'nectovia-credits' | 'your-subscription' | 'your-key' | 'local' | 'unknown';

/** What H17 verification says of the work. `not-run` until a check has run. */
export type WorkerRowVerification = 'verified' | 'unverified' | 'failed' | 'not-run';

/** One row. `startedAt` lets the phone tick elapsed time itself; `quota` is present only when the provider reports one. */
export interface WorkerRow {
  rowId: string;
  kind: WorkerRowKind;
  label: string;
  title: string;
  state: WorkerRowState;
  startedAt: string | null;
  verification: WorkerRowVerification;
  payer: WorkerRowPayer;
  quota?: { window: string; remainingPercent: number };
}

/** A project's rows at one moment, with the run and task they belong to when there is one. */
export interface WorkRowsSnapshot { projectId: string; rootRunId: string | null; taskTitle: string | null; rows: WorkerRow[]; at: string }

/** The most rows one `work.rows` frame carries. */
export const WORK_ROWS_RELAY_LIMIT = 8;

/** The longest row or task title the relay carries, in characters. */
export const WORK_ROW_TITLE_LIMIT = 80;

/**
 * Where worker rows come from. `snapshot` answers null for a project with nothing to show,
 * `projects` names the projects it can answer for, and `subscribe` calls back with a project id
 * whenever that project's rows may have changed (it answers the unsubscribe).
 */
export interface WorkRowsSource { snapshot(projectId: string): Promise<WorkRowsSnapshot | null>; projects(): Promise<string[]>; subscribe(listener: (projectId: string) => void): () => void }
