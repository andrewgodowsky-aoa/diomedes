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
import { INTERVENTION_LABELS, type StreamTriggerView } from '../../shared/stream-rules';
import { AGENT_NAME } from '../../shared/agent-name';
import { api } from '../api';
import './supervision.css';

/**
 * H15 in the Console: what Diomedes supervision noticed on a run, what it asked
 * the run to do, where it paused the run for you, and how you answered. Every
 * row is a supervision record; nothing here is inferred from the transcript.
 * Diomedes is named as the actor only on its own supervision actions, and those
 * are application actions — deterministic checks, not a model (decision 8).
 *
 * H16 stream-time rule firings are rows of the same list, in time order. A
 * steer or stop a firing handed to supervision is shown on the firing's own row
 * (what was done, and the exact message sent), not again as a second row.
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
  const [triggers, setTriggers] = useState<StreamTriggerView[]>([]);
  const [failed, setFailed] = useState<string | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    void api<{ records: SupervisionRecord[]; triggers?: StreamTriggerView[] }>(
      `/projects/${encodeURIComponent(projectId)}/supervision?sessionId=${encodeURIComponent(session.id)}`,
      'GET',
      undefined,
      controller.signal,
    ).then(
      (result) => {
        if (!controller.signal.aborted) {
          setRecords(result.records);
          setTriggers(result.triggers ?? []);
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
      {records?.length === 0 && triggers.length === 0 && <p>Supervision has recorded nothing on this run.</p>}
      {records && records.length + triggers.length > 0 && (
        <ol className="supervision-records">
          {rows(records, triggers).map((row) =>
            row.kind === 'trigger' ? (
              <TriggerRow key={row.view.firing.id} view={row.view} records={records} />
            ) : (
            <li key={row.record.id} data-action={row.record.action} data-code={row.record.code}>
              <span className="supervision-head">
                <b>{RUNG_LABELS[row.record.action]}</b>
                <span> · {DRIFT_LABELS[row.record.code]}</span>
                {row.record.action !== 'answer' && (
                  <span className={`supervision-severity ${row.record.severity}`}>
                    {' '}
                    · {row.record.severity}
                  </span>
                )}
                <span className="mono"> · {time(row.record.at)}</span>
              </span>
              <span className="supervision-by">
                {row.record.actor.kind === 'you'
                  ? 'By you'
                  : `By ${SUPERVISION_ACTOR} · application action, no model`}
              </span>
              <span className="supervision-summary">
                {row.record.action === 'answer'
                  ? `${ANSWER_LABELS[row.record.answer!]}${row.record.text ? `: “${row.record.text}”` : ''}`
                  : `${row.record.summary.charAt(0).toUpperCase()}${row.record.summary.slice(1)}.`}
              </span>
              {row.record.control && (
                <span className="supervision-detail">
                  {controlWord(row.record.control.control)} {outcomeWord(row.record.control.outcome)}:{' '}
                  {row.record.control.detail}
                </span>
              )}
              {row.record.attempt && (
                <span className="supervision-detail">
                  Correction {row.record.attempt.n} of {row.record.attempt.of} for this detector on this
                  run.
                </span>
              )}
              {row.record.message && (
                <span className="supervision-detail supervision-message">{row.record.message}</span>
              )}
              <span className="supervision-detail">{row.record.settled ?? row.record.reason}</span>
              {row.record.evidence.length > 0 && (
                <ul className="supervision-evidence" aria-label="Evidence">
                  {row.record.evidence.map((item) => (
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
            ),
          )}
        </ol>
      )}
    </section>
  );
}

type Row =
  | { readonly kind: 'record'; readonly at: string; readonly record: SupervisionRecord }
  | { readonly kind: 'trigger'; readonly at: string; readonly view: StreamTriggerView };

/**
 * Supervision records and trigger firings in one list, oldest first. A
 * supervision record that only acts on a firing is said on the firing's row;
 * a person's answer to the escalation it raised keeps its own row.
 */
function rows(records: readonly SupervisionRecord[], triggers: readonly StreamTriggerView[]): Row[] {
  const cited = new Set(triggers.map((view) => view.firing.id));
  const folded = (record: SupervisionRecord) =>
    record.code === 'rule-trigger' &&
    record.action !== 'answer' &&
    record.evidence.some((item) => item.kind === 'rule' && cited.has(item.ref));
  return [
    ...records.filter((record) => !folded(record)).map((record): Row => ({ kind: 'record', at: record.at, record })),
    ...triggers.map((view): Row => ({ kind: 'trigger', at: view.firing.at, view })),
  ].sort((a, b) => a.at.localeCompare(b.at));
}

/** One stream-time rule firing: which rule, what it matched, what it asked for and what came of it. */
function TriggerRow({ view, records }: { view: StreamTriggerView; records: readonly SupervisionRecord[] }) {
  const { firing } = view;
  const handled = records.find(
    (record) => record.action !== 'answer' && record.evidence.some((item) => item.kind === 'rule' && item.ref === firing.id),
  );
  const match = firing.match;
  return (
    <li data-action="trigger" data-code="rule-trigger" data-intervention={firing.intervention} data-state={view.state}>
      <span className="supervision-head">
        <b>{INTERVENTION_LABELS[firing.intervention]}</b>
        <span> · Rule trigger</span>
        <span className="mono"> · {time(firing.at)}</span>
      </span>
      <span className="supervision-by">By {SUPERVISION_ACTOR} · application action, no model</span>
      <span className="supervision-summary">
        {firing.rule.authority === 'organization' ? 'Organization' : 'Project'} rule{' '}
        <span className="supervision-rule">{firing.rule.id}</span> v{firing.rule.version}: {firing.rule.text}
      </span>
      <span className="supervision-detail supervision-match">
        {match.kind === 'tool'
          ? `Matched the proposed ${match.tool} call${match.targets.length ? ` on ${match.targets.join(', ')}` : ''}, before it was admitted.`
          : `Matched “${match.excerpt}” at ${match.start}–${match.end} of ${firing.stepId}, ${match.source === 'stream' ? 'while it streamed' : 'in the answer the route sent whole'}.`}
      </span>
      <span className="supervision-detail" data-trigger-outcome>
        {view.outcome}
      </span>
      {handled?.message && <span className="supervision-detail supervision-message">{handled.message}</span>}
      <small className="run-inspector-code" title={firing.rule.digest}>
        rule · {firing.rule.digest}
      </small>
    </li>
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
