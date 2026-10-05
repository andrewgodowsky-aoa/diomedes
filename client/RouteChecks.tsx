import { useCallback, useEffect, useRef, useState } from 'react';
import type { RouteQualificationView } from '../shared/model-api';
import { ApiError, api } from './api';
import {
  qualificationSentence,
  routeCheckLines,
  routeCheckRunState,
  routeChecksCaption,
  routeCheckSummary,
} from './aws-bedrock-view';
import { Button } from './components';

const messageOf = (error: unknown) =>
  error instanceof ApiError || error instanceof Error ? error.message : 'The request could not be completed.';
const isAbort = (error: unknown) => error instanceof DOMException && error.name === 'AbortError';
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The owner's route checks for one connection (AWS) or one deployment (Azure): a few small live
 * requests through the route's own key and spend limit, recorded as a receipt. Every sentence
 * comes from the host's view through `aws-bedrock-view.ts`; Stop closes the request, and the
 * host records what the run saw before it stopped.
 */
export function RouteChecks({
  base,
  model,
  title = 'Route checks',
  revision,
  disabled = false,
  onChanged,
}: {
  /** The route's setup path, e.g. `/ai/model-api/aws-bedrock`. */
  base: string;
  /** The Azure logical model to check; absent for AWS, whose connection names one model. */
  model?: string;
  title?: string;
  /** The connection's revision: a new one reads the checks again. */
  revision: number;
  disabled?: boolean;
  /** After a run or a Stop, so the card can show the spend the run held. */
  onChanged?: () => void;
}) {
  const [view, setView] = useState<RouteQualificationView | null>(null);
  const [error, setError] = useState('');
  const [runningHere, setRunningHere] = useState(false);
  const stopper = useRef<AbortController | null>(null);
  const query = model ? `?model=${encodeURIComponent(model)}` : '';

  const load = useCallback(
    async (signal?: AbortSignal) => {
      try {
        const next = await api<RouteQualificationView>(`${base}/qualification${query}`, 'GET', undefined, signal);
        setView(next);
        return next;
      } catch (reason) {
        if (!signal?.aborted) setError(messageOf(reason));
        return null;
      }
    },
    [base, query],
  );
  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load, revision]);
  useEffect(() => () => stopper.current?.abort(), []);

  const run = async () => {
    const controller = new AbortController();
    stopper.current = controller;
    setRunningHere(true);
    setError('');
    try {
      setView(await api<RouteQualificationView>(`${base}/qualify`, 'POST', { consent: true, ...(model ? { model } : {}) }, controller.signal));
    } catch (reason) {
      if (!isAbort(reason)) setError(messageOf(reason));
      // A stopped run finishes on the host, which records what it saw; wait for that receipt.
      for (let tries = 0; tries < 20; tries += 1) {
        const next = await load();
        if (!next?.running) break;
        await pause(500);
      }
    } finally {
      stopper.current = null;
      setRunningHere(false);
      onChanged?.();
    }
  };

  const state = routeCheckRunState(view, runningHere);
  const sentence = qualificationSentence(view);
  const summary = routeCheckSummary(view?.receipt ?? null);
  const lines = routeCheckLines(view?.receipt ?? null);

  return (
    <div className="ai-route-checks" aria-label={title}>
      <h4>{title}</h4>
      <p className="caption">{routeChecksCaption(view)}</p>
      {sentence && <p className="ai-route-checks-verdict">{sentence}</p>}
      {summary && <p className="caption">{summary}</p>}
      {lines.length > 0 && (
        <ul className="ai-route-check-lines" aria-label={`${title}: last run`}>
          {lines.map((line) => (
            <li key={line.id} data-outcome={line.outcome}>
              <span className="ai-state-label">{line.label}</span>
              <span className="ai-state-value">{line.text}</span>
            </li>
          ))}
        </ul>
      )}
      {error && (
        <p className="ai-note" role="alert">
          {error}
        </p>
      )}
      <div className="actions">
        {runningHere ? (
          <Button tone="quiet" onClick={() => stopper.current?.abort()}>
            Stop
          </Button>
        ) : (
          <Button onClick={() => void run()} disabled={disabled || !state.canRun}>
            Run route checks
          </Button>
        )}
        {state.reason && <span className="caption">{state.reason}</span>}
      </div>
    </div>
  );
}
