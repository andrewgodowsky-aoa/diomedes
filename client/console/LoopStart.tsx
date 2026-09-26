import { useEffect, useState } from 'react';
import { api, listDocuments } from '../api';
import { Modal } from '../components';
import { AGENT_NAME } from '../../shared/agent-name';
import { LOOP_LIMITS, type LoopRouteOffer } from '../../shared/native-loop';
import { selectTaskSources } from '../../shared/task-sources';
import type { DocumentInfo, Session, Task } from '../../shared/types';
import { defaultLoopGoal, loopStartCommand, newLoopCommandId } from './loop-start-model';
import './trigger-rules.css';

/**
 * Start a Diomedes loop run (H13) on a task, from the task's own work panel.
 *
 * It offers only the routes the server says it would admit now
 * (`GET /api/projects/:id/loop/routes`, the start route's own admission), and
 * lists every other route with the server's reason. The start is H13's
 * versioned command, unchanged: the goal defaults to the task's statement, the
 * turns to H13's default, and a refusal — consent, a file the project does not
 * share with the route, the route's own admission — is shown as the server
 * said it. The run then appears in this thread's run inspector.
 */
export function LoopStart({
  projectId,
  task,
  onClose,
  onStarted,
}: {
  projectId: string;
  task: Task;
  onClose(): void;
  onStarted(session: Session | null): void;
}) {
  // One dialog, one command: a second click or a resend names the same run.
  const [commandId] = useState(newLoopCommandId);
  const [offers, setOffers] = useState<LoopRouteOffer[] | null>(null);
  // Set when the business does not hold 'owner-rules' (Andrew, 2026-09-25): the
  // run still starts, but the project's instruction files do not reach it.
  const [notIncluded, setNotIncluded] = useState<string | null>(null);
  const [documents, setDocuments] = useState<DocumentInfo[]>([]);
  const [route, setRoute] = useState('');
  const [goal, setGoal] = useState(() => defaultLoopGoal(task));
  const [sources, setSources] = useState<string[]>([]);
  const [turns, setTurns] = useState<number | null>(null);
  const [consent, setConsent] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    api<{ routes: LoopRouteOffer[]; notIncludedReason?: string | null }>(
      `/projects/${projectId}/loop/routes`,
    ).then(
      ({ routes, notIncludedReason }) => {
        if (!live) return;
        setOffers(routes);
        setNotIncluded(notIncludedReason ?? null);
        setRoute((current) => current || routes.find((offer) => offer.admitted)?.route || '');
      },
      (failure) => live && setError(failure instanceof Error ? failure.message : 'The routes could not be read.'),
    );
    listDocuments(projectId).then(
      ({ documents: listed }) => {
        if (!live) return;
        const readable = listed.filter((item) => item.kind === 'markdown' || item.kind === 'text' || item.kind === 'plan');
        setDocuments(readable);
        try {
          setSources(selectTaskSources(task, listed).slice(0, 32));
        } catch {
          setSources([]);
        }
      },
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [projectId, task]);

  const admitted = (offers ?? []).filter((offer) => offer.admitted);
  const refused = (offers ?? []).filter((offer) => !offer.admitted);
  const chosen = admitted.find((offer) => offer.route === route) ?? null;

  async function start() {
    if (!chosen) return;
    setBusy(true);
    setError('');
    try {
      const started = await api<{ runId: string; session: Session | null }>(
        `/projects/${projectId}/loop/start`,
        'POST',
        loopStartCommand({ commandId, taskId: task.id, goal, route: chosen.route, sources, consent, maxTurns: turns }),
      );
      onStarted(started.session);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'The loop could not be started.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title={`Start a ${AGENT_NAME} work loop`} onClose={onClose}>
      <form
        className="loop-start trigger-rule-form"
        aria-label={`Start a ${AGENT_NAME} work loop`}
        onSubmit={(event) => {
          event.preventDefault();
          void start();
        }}
      >
        <p className="loop-start-task" title={task.name}>
          {task.name}
        </p>
        {notIncluded && <p className="trigger-rules-reach">{notIncluded}</p>}
        {offers && admitted.length === 0 && (
          <p className="trigger-rules-reach">No route can run a work loop here yet.</p>
        )}
        {admitted.length > 0 && (
          <label className="field">
            <span>Route</span>
            <select
              value={route}
              onChange={(event) => {
                setRoute(event.target.value);
                setConsent(false);
              }}
            >
              {admitted.map((offer) => (
                <option key={offer.route} value={offer.route}>
                  {offer.label}
                  {offer.model ? ` · ${offer.model}` : ''}
                </option>
              ))}
            </select>
          </label>
        )}
        {refused.length > 0 && (
          <details className="loop-start-refused">
            <summary>Not offered ({refused.length})</summary>
            <ul>
              {refused.map((offer) => (
                <li key={offer.route} data-route={offer.route}>
                  <span className="loop-start-route">{offer.label}</span> {offer.reason}
                </li>
              ))}
            </ul>
          </details>
        )}
        <label className="field">
          <span>Goal</span>
          <textarea value={goal} onChange={(event) => setGoal(event.target.value)} rows={3} maxLength={16_000} />
        </label>
        {documents.length > 0 && (
          <fieldset className="trigger-rule-kinds">
            <legend>Files it reads</legend>
            {documents.map((item) => (
              <label className="trigger-rule-choice" key={item.path} title={item.path}>
                <input
                  type="checkbox"
                  checked={sources.includes(item.path)}
                  disabled={!sources.includes(item.path) && sources.length >= 32}
                  onChange={(event) =>
                    setSources(
                      event.target.checked
                        ? [...sources, item.path]
                        : sources.filter((path) => path !== item.path),
                    )
                  }
                />
                <span>{item.path}</span>
              </label>
            ))}
          </fieldset>
        )}
        <label className="field">
          <span>Turns (up to {LOOP_LIMITS.maxTurns})</span>
          <input
            type="number"
            min={1}
            max={LOOP_LIMITS.maxTurns}
            value={turns ?? LOOP_LIMITS.defaultTurns}
            onChange={(event) => setTurns(event.target.value === '' ? null : Number(event.target.value))}
          />
        </label>
        {chosen?.sends && (
          <label className="trigger-rule-choice">
            <input type="checkbox" checked={consent} onChange={(event) => setConsent(event.target.checked)} />
            <span>Send the goal and the files it reads to {chosen.label}.</span>
          </label>
        )}
        {error && (
          <p className="trigger-rules-error" role="alert">
            {error}
          </p>
        )}
        <div className="trigger-rule-form-acts">
          <button type="submit" className="button primary" disabled={busy || !chosen}>
            {busy ? 'Starting…' : 'Start loop run'}
          </button>
          <button type="button" className="button quiet" onClick={onClose}>
            Cancel
          </button>
        </div>
      </form>
    </Modal>
  );
}
