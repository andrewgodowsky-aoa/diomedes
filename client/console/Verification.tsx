import { useState } from 'react';
import type { HistoryEntry, Session, Task } from '../../shared/types';
import {
  checkLabel,
  verificationOf,
  type AcceptanceCheck,
  type CheckIndependence,
  type VerificationCheckView,
  type VerificationView,
} from '../../shared/verification';
import { formatOrigin } from '../attribution-display';
import { declareAcceptance, runVerification } from './verification-api';
import './verification.css';

// H17: a run's four-state result, wherever a run's outcome is shown. Everything
// here is read from the projection in shared/verification.ts; nothing is kept.
// "Not verified" is always shown, in the same place as the other three states.

const FINISHED = new Set<Session['state']>(['done', 'failed', 'stopped']);

/** The result of a finished run, or null while it is still running. */
export function verificationFor(
  session: Session | null | undefined,
  task: Task | null | undefined,
  history: readonly HistoryEntry[] | undefined,
): VerificationView | null {
  if (!session || !FINISHED.has(session.state) || !history) return null;
  return verificationOf({ session, task: task ?? null, history });
}

const INDEPENDENCE: Readonly<Record<CheckIndependence, string>> = {
  deterministic: 'deterministic check',
  independent: 'independent of the worker',
  'same-model': 'same model as the worker',
  unknown: 'independence not shown',
};

const OUTCOME = { passed: 'Passed', failed: 'Failed', incomplete: 'Not complete' } as const;

const short = (sha: string | null) => (sha ? sha.slice(0, 12) : 'absent');
const when = (at: string) => new Date(at).toLocaleString();

/** The compact form: the state word and its dot. The sentence rides in the title. */
export function VerificationBadge({ view }: { view: VerificationView }) {
  return (
    <span className={`verif-badge ${view.state}`} data-verification={view.state} title={view.sentence}>
      {view.label}
    </span>
  );
}

function CheckRow({ check }: { check: VerificationCheckView }) {
  const by = formatOrigin(check.origin);
  return (
    <li className={`verif-check ${check.outcome}`} data-check={check.id}>
      <span className="verif-check-state">{OUTCOME[check.outcome]}</span>
      <span className="verif-check-text">
        <span className="verif-check-label">{check.label}</span>
        <span className="verif-check-sentence">{check.sentence}</span>
        <span className="verif-check-meta">
          <span title={by.detail}>{by.label}</span>
          <span>{INDEPENDENCE[check.independence]}</span>
          <time dateTime={check.ranAt}>{when(check.ranAt)}</time>
        </span>
        {check.evidence.length > 0 && (
          <span className="verif-bytes">
            {check.evidence.map((file) => (
              <span key={file.path} className="verif-sha" title={`${file.path} · ${file.sha ?? 'absent'}`}>
                {file.path} @ {short(file.sha)}
              </span>
            ))}
          </span>
        )}
      </span>
    </li>
  );
}

type Kind = 'file-exists' | 'text-contains' | 'review';

function DeclareForm({
  projectId,
  task,
  listed,
  onError,
}: {
  projectId: string;
  task: Task;
  /** False when the evidence rows above already name every declared check. */
  listed: boolean;
  onError?(error: Error): void;
}) {
  const [kind, setKind] = useState<Kind>('file-exists');
  const [path, setPath] = useState('');
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const existing = task.acceptance?.checks ?? [];
  const ready = kind === 'review' ? text.trim() !== '' : path.trim() !== '' && (kind !== 'text-contains' || text !== '');

  async function save(checks: readonly AcceptanceCheck[]) {
    setBusy(true);
    try {
      await declareAcceptance(projectId, task.id, checks);
      setPath('');
      setText('');
    } catch (error) {
      onError?.(error instanceof Error ? error : new Error(String(error)));
    } finally {
      setBusy(false);
    }
  }
  function add() {
    const taken = new Set(existing.map((check) => check.id));
    let n = existing.length + 1;
    while (taken.has(`check-${n}`)) n++;
    const id = `check-${n}`;
    const check: AcceptanceCheck =
      kind === 'review'
        ? { id, kind, instruction: text.trim() }
        : kind === 'text-contains'
          ? { id, kind, path: path.trim(), text }
          : { id, kind, path: path.trim() };
    void save([...existing, check]);
  }
  return (
    <div className="verif-declare">
      {listed && existing.length > 0 && (
        <ul className="verif-declared">
          {existing.map((check) => (
            <li key={check.id}>{checkLabel(check)}</li>
          ))}
        </ul>
      )}
      <div className="verif-declare-row">
        <select aria-label="Check kind" value={kind} onChange={(e) => setKind(e.target.value as Kind)}>
          <option value="file-exists">File exists</option>
          <option value="text-contains">File contains text</option>
          <option value="review">Reviewer pass</option>
        </select>
        {kind !== 'review' && (
          <input aria-label="File" placeholder="File in this project" value={path} onChange={(e) => setPath(e.target.value)} />
        )}
        {kind !== 'file-exists' && (
          <input
            aria-label={kind === 'review' ? 'What the reviewer checks' : 'Text'}
            placeholder={kind === 'review' ? 'What the output must satisfy' : 'Text it must contain'}
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
        )}
        <button type="button" disabled={busy || !ready} onClick={add}>
          Add check
        </button>
        {existing.length > 0 && (
          <button type="button" disabled={busy} onClick={() => void save([])}>
            Clear checks
          </button>
        )}
      </div>
    </div>
  );
}

/**
 * The full form under a finished run: the state, what was checked, against
 * which bytes, when, and by whom, one click deeper than the state itself.
 */
export function VerificationPanel({
  view,
  task,
  projectId,
  onError,
}: {
  view: VerificationView;
  task: Task | null;
  projectId?: string;
  onError?(error: Error): void;
}) {
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);
  const record = view.record;
  const canRun = Boolean(projectId && task && view.declared > 0);

  async function verify() {
    if (!projectId) return;
    setBusy(true);
    try {
      await runVerification(projectId, view.sessionId);
    } catch (error) {
      onError?.(error instanceof Error ? error : new Error(String(error)));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={`verif ${view.state}`} data-verification-panel={view.sessionId}>
      <div className="verif-head">
        <VerificationBadge view={view} />
        <span className="verif-sentence">{view.sentence}</span>
      </div>
      {view.changed.length > 0 && (
        <ul className="verif-changed">
          {view.changed.map((file) => (
            <li key={file.path} className="verif-sha" title={`${file.path}: verified ${file.verified ?? 'absent'}, now ${file.current ?? 'absent'}`}>
              {file.path}: verified {short(file.verified)}, now {short(file.current)}
            </li>
          ))}
        </ul>
      )}
      <div className="verif-acts">
        {canRun && (
          <button type="button" disabled={busy} onClick={() => void verify()}>
            {busy ? 'Checking…' : record ? 'Verify again' : 'Run checks'}
          </button>
        )}
        {(record || (projectId && task)) && (
          <button type="button" aria-expanded={open} onClick={() => setOpen(!open)}>
            {open ? 'Hide evidence' : record ? 'Evidence' : 'Checks'}
          </button>
        )}
      </div>
      {open && record && (
        <div className="verif-evidence">
          <div className="verif-meta">
            <span>
              Checked <time dateTime={record.endedAt}>{when(record.endedAt)}</time>,{' '}
              {record.requestedBy === 'diomedes-loop' ? 'your checks, run when its loop finished' : 'at your request'}
            </span>
            {record.producer && <span>Output by {formatOrigin(record.producer).label}</span>}
          </div>
          <ul className="verif-checks">
            {view.checks.map((check) => (
              <CheckRow key={check.id} check={check} />
            ))}
          </ul>
        </div>
      )}
      {open && projectId && task && <DeclareForm
          projectId={projectId}
          task={task}
          listed={!record || view.rule === 'checks-changed'}
          onError={onError}
        />}
    </div>
  );
}
