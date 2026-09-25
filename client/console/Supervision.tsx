import { useEffect, useState } from 'react';
import type { Need, Session } from '../../shared/types';
import {
  ANSWER_LABELS,
  DRIFT_LABELS,
  RUNG_LABELS,
  type EscalationAnswer,
  type SupervisionRecord,
} from '../../shared/supervision';
import type { ControlReceipt } from '../../shared/work-control';
import { AGENT_NAME } from '../../shared/agent-name';
import { api } from '../api';
import './supervision.css';

/**
 * H15 in the Console: what Diomedes supervision noticed on a run, what it asked
 * the run to do, where it paused the run for you, and how you answered. Every
 * row is a supervision record; nothing here is inferred from the transcript.
 * Diomedes is named as the actor only on its own supervision actions, and those
 * are application actions — deterministic checks, not a model (decision 8).
 */

const SUPERVISION_ACTOR = `${AGENT_NAME} supervision`;
const time = (at: string) => new Date(at).toTimeString().slice(0, 5);

/** The run inspector's Supervision section. Loads its records when the inspector is open. */
export function SupervisionSection({
  projectId,
  session,
  refreshKey,
}: {
  projectId: string;
  session: Session;
  /** Changes whenever the records may have: the run's state and its Needs. */
  refreshKey: string;
}) {
  const [records, setRecords] = useState<SupervisionRecord[] | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    void api<{ records: SupervisionRecord[] }>(
      `/projects/${encodeURIComponent(projectId)}/supervision?sessionId=${encodeURIComponent(session.id)}`,
      'GET',
      undefined,
      controller.signal,
    ).then(
      (result) => {
        if (!controller.signal.aborted) {
          setRecords(result.records);
          setFailed(null);
        }
      },
      (error: unknown) => {
        if (!controller.signal.aborted)
          setFailed(
            error instanceof Error ? error.message : 'Supervision records could not be loaded.',
          );
      },
    );
    return () => controller.abort();
  }, [projectId, session.id, refreshKey]);
  return (
    <section aria-label="Supervision" className="supervision">
      <h3>Supervision</h3>
      {failed && <p role="alert">{failed}</p>}
      {!failed && records === null && <p role="status">Loading supervision records...</p>}
      {records?.length === 0 && <p>Supervision has recorded nothing on this run.</p>}
      {records && records.length > 0 && (
        <ol className="supervision-records">
          {records.map((record) => (
            <li key={record.id} data-action={record.action} data-code={record.code}>
              <span className="supervision-head">
                <b>{RUNG_LABELS[record.action]}</b>
                <span> · {DRIFT_LABELS[record.code]}</span>
                {record.action !== 'answer' && (
                  <span className={`supervision-severity ${record.severity}`}>
                    {' '}
                    · {record.severity}
                  </span>
                )}
                <span className="mono"> · {time(record.at)}</span>
              </span>
              <span className="supervision-by">
                {record.actor.kind === 'you'
                  ? 'By you'
                  : `By ${SUPERVISION_ACTOR} · application action, no model`}
              </span>
              <span className="supervision-summary">
                {record.action === 'answer'
                  ? `${ANSWER_LABELS[record.answer!]}${record.text ? `: “${record.text}”` : ''}`
                  : `${record.summary.charAt(0).toUpperCase()}${record.summary.slice(1)}.`}
              </span>
              {record.control && (
                <span className="supervision-detail">
                  {controlWord(record.control.control)} {outcomeWord(record.control.outcome)}:{' '}
                  {record.control.detail}
                </span>
              )}
              {record.attempt && (
                <span className="supervision-detail">
                  Correction {record.attempt.n} of {record.attempt.of} for this detector on this
                  run.
                </span>
              )}
              {record.message && (
                <span className="supervision-detail supervision-message">{record.message}</span>
              )}
              <span className="supervision-detail">{record.settled ?? record.reason}</span>
              {record.evidence.length > 0 && (
                <ul className="supervision-evidence" aria-label="Evidence">
                  {record.evidence.map((item) => (
                    <li key={`${item.kind}:${item.ref}:${item.detail}`}>
                      <span>{item.detail}</span>
                      <small className="run-inspector-code" title={item.ref}>
                        {item.kind} · {item.ref}
                      </small>
                    </li>
                  ))}
                </ul>
              )}
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

const controlWord = (control: NonNullable<SupervisionRecord['control']>['control']) =>
  ({ steer: 'Steer', queue: 'Queue', stop: 'Stop', resume: 'Resume' })[control];
const outcomeWord = (outcome: NonNullable<SupervisionRecord['control']>['outcome']) =>
  ({ applied: 'done', queued: 'queued', refused: 'not done', uncertain: 'not confirmed' })[outcome];

/**
 * An escalation in the thread, where a Need sits: Diomedes paused the run and
 * asks you to continue, redirect or stop. Only you answer it; no answer grants
 * anything, and Continue is refused, with the reason, where the route cannot
 * resume or the run's permission, inputs or route changed.
 */
export function EscalationBlock({
  projectId,
  need,
}: {
  projectId: string;
  need: Need;
  session?: Session;
}) {
  const [busy, setBusy] = useState(false);
  const [redirecting, setRedirecting] = useState(false);
  const [text, setText] = useState('');
  const [said, setSaid] = useState<string | null>(null);
  // The server records its own name in `what`; the Console says the product's name (decision 8).
  const finding = need.what.slice(need.what.indexOf(':') + 1).trim();
  const send = async (answer: EscalationAnswer) => {
    setBusy(true);
    setSaid(null);
    try {
      const result = await api<{ need: Need; receipt: ControlReceipt | null }>(
        `/projects/${encodeURIComponent(projectId)}/supervision/escalations/${encodeURIComponent(need.id)}/answer`,
        'POST',
        {
          protocolVersion: 1,
          commandId: crypto.randomUUID(),
          answer,
          ...(answer === 'redirect' ? { text } : {}),
        },
      );
      if (result.need.state === 'open')
        setSaid(`Not done: ${result.receipt?.detail ?? 'the route did not accept it.'}`);
    } catch (error) {
      setSaid(error instanceof Error ? error.message : 'The answer could not be sent.');
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="need escalation" aria-label={`${AGENT_NAME} paused this run`}>
      <div className="who">
        <b>{AGENT_NAME}</b>
        <span>supervision · application action · needs you</span>
      </div>
      <p className="ask">
        {AGENT_NAME} paused this run: {finding} — continue, redirect, or stop?
      </p>
      {need.why && <p className="why">{need.why}</p>}
      <p className="why">{need.consequence}</p>
      {redirecting ? (
        <form
          className="escalation-redirect"
          onSubmit={(event) => {
            event.preventDefault();
            if (text.trim()) void send('redirect');
          }}
        >
          <label>
            <span>Where should it go instead?</span>
            <textarea value={text} rows={2} onChange={(event) => setText(event.target.value)} />
          </label>
          <div className="verbs">
            <button type="submit" className="verb go" disabled={busy || !text.trim()}>
              Send as the next run
            </button>
            <button type="button" className="verb" onClick={() => setRedirecting(false)}>
              Cancel
            </button>
          </div>
        </form>
      ) : (
        <div className="verbs">
          <button
            type="button"
            className="verb go"
            disabled={busy}
            onClick={() => void send('continue')}
          >
            Continue
          </button>
          <button
            type="button"
            className="verb"
            disabled={busy}
            onClick={() => setRedirecting(true)}
          >
            Redirect
          </button>
          <button type="button" className="verb" disabled={busy} onClick={() => void send('stop')}>
            Stop
          </button>
        </div>
      )}
      {said && (
        <p className="why" role="status">
          {said}
        </p>
      )}
    </section>
  );
}
