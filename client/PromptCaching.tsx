import { useCallback, useEffect, useState } from 'react';
import type { RouteCachePolicyView } from '../shared/model-api';
import type { CachePolicy } from '../shared/route-capabilities';
import { ApiError, api } from './api';
import {
  CACHE_POLICY_CHOICES,
  FACT_SOURCE_WORDS,
  STORE_FALSE_NOTE,
  capabilityRows,
  defaultVerdict,
  offVerdict,
} from './route-cache-view';

const messageOf = (error: unknown) =>
  error instanceof ApiError || error instanceof Error ? error.message : 'The request could not be completed.';

/**
 * DIO-215: the owner's Prompt caching setting for one route, and what each model of its
 * connection can do, with where each fact comes from. The setting is the route's own and is
 * saved only through its route; a whole Settings save never changes it. Every sentence comes
 * from the host's view through `route-cache-view.ts`.
 */
export function PromptCaching({
  route,
  refresh,
  disabled = false,
}: {
  route: 'aws-bedrock' | 'azure-openai';
  /** Anything that changes when the route's setup does (a reconnect, a route check): reads again. */
  refresh?: unknown;
  disabled?: boolean;
}) {
  const base = `/ai/model-api/${route}/cache-policy`;
  const [view, setView] = useState<RouteCachePolicyView | null>(null);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  const load = useCallback(
    async (signal?: AbortSignal) => {
      try {
        setView(await api<RouteCachePolicyView>(base, 'GET', undefined, signal));
      } catch (reason) {
        if (!signal?.aborted) setError(messageOf(reason));
      }
    },
    [base],
  );
  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load, refresh]);

  const choose = async (policy: CachePolicy) => {
    setSaving(true);
    setError('');
    try {
      setView(await api<RouteCachePolicyView>(base, 'PUT', { policy }));
    } catch (reason) {
      setError(messageOf(reason));
    } finally {
      setSaving(false);
    }
  };

  const name = `${route}-cache-policy`;
  return (
    <div className="ai-prompt-caching" aria-label="Prompt caching">
      <h4 id={`${name}-title`}>Prompt caching</h4>
      <div className="radio-list" role="radiogroup" aria-labelledby={`${name}-title`}>
        {CACHE_POLICY_CHOICES.map((choice) => (
          <label key={choice.value} className={`radio-row ${view?.policy === choice.value ? 'selected' : ''}`}>
            <input
              type="radio"
              name={name}
              value={choice.value}
              checked={view?.policy === choice.value}
              disabled={disabled || saving || !view}
              onChange={() => void choose(choice.value)}
            />
            <span>
              <strong>{choice.label}</strong>
              <span className="caption">{choice.detail}</span>
            </span>
          </label>
        ))}
      </div>
      <p className="caption ai-store-note">{STORE_FALSE_NOTE}</p>
      {error && (
        <p className="ai-note" role="alert">
          {error}
        </p>
      )}
      {view?.models.map((entry) => {
        const title = entry.deployment ? `${entry.model} (${entry.deployment})` : entry.model;
        return (
          <section key={`${entry.model}:${entry.deployment ?? ''}`} className="ai-capabilities" aria-label={`What ${title} can do`}>
            <h5>What {title} can do</h5>
            <ul className="ai-capability-facts">
              {capabilityRows(entry.capability).map((row) => (
                <li key={row.id} data-fact={row.id} data-source={row.source}>
                  <span className="ai-state-label">{row.label}</span>
                  <span className="ai-state-value">{row.value}</span>
                  <span className="caption ai-fact-source">
                    {FACT_SOURCE_WORDS[row.source]}. {row.evidence}
                  </span>
                  {row.build && <span className="caption">{row.build}</span>}
                </li>
              ))}
            </ul>
            <p className="caption" data-verdict="off">
              {offVerdict(entry.capability)}
            </p>
            <p className="caption" data-verdict="default">
              {defaultVerdict(entry.capability)}
            </p>
            <p className="caption ai-cache-preview">{entry.preview.note}</p>
          </section>
        );
      })}
    </div>
  );
}
