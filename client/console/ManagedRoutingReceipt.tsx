import { useEffect, useState } from 'react';
import type { HarnessRun } from '../../shared/harness';
import { routingReceiptPageSchema, routingReceiptSchema, type RoutingReceipt, type RoutingReceiptPage } from '../../shared/routing-policy';
import { formatCredits, micro } from '../../shared/managed-usage';
import { api } from '../api';

const credits = (value: number) => formatCredits(micro(value));

/** Uses durable model-step receipts, never current policy or locally estimated balances. */
export function ManagedRoutingReceipt({ run }: { run: HarnessRun }) {
  const steps = run.steps.flatMap(step => {
    if (step.intent.kind !== 'model') return [];
    const output = step.output;
    const saved = output && typeof output === 'object' && !Array.isArray(output) ? output.managed : undefined;
    const failed = step.error && 'managed' in step.error ? step.error.managed : undefined;
    const receipt = routingReceiptSchema.safeParse(saved ?? failed);
    return receipt?.success ? [{ id: step.intent.stepId, receipt: receipt.data }] : [];
  });
  if (!steps.length) return null;
  return <section aria-label="Managed AI attempts">
    <h3>Managed AI attempts</h3>
    {steps.map(step => <Receipt key={step.id} receipt={step.receipt} />)}
  </section>;
}

function Receipt({ receipt }: { receipt: RoutingReceipt }) {
  return <div>
      <p>{credits(receipt.allowanceDebitMicroUsd)} credits used
        {receipt.heldMicroUsd > 0 && <>; up to {credits(receipt.heldMicroUsd)} credits were still reserved when this result was recorded</>}.</p>
      <ol>{receipt.attempts.map(attempt => <li key={attempt.attemptId} style={{ minWidth: 0, overflowWrap: 'anywhere' }}>
        <strong>{attempt.routing ? `${attempt.routing.provider} / ${attempt.routing.model}` : 'Connection not recorded'}</strong>
        <span> - {attempt.state}. {attempt.state === 'written-off' ? 'No charge. Closed using provider records.'
          : attempt.allowanceDebitMicroUsd === null ? 'Final usage not recorded.' : `${credits(attempt.allowanceDebitMicroUsd)} credits used.`}</span>
        {attempt.routing && <small style={{ display: 'block' }}>
          Policy {attempt.routing.policyRevision}; global {attempt.routing.globalRevision}; account {attempt.routing.scopeRevision}; privacy {attempt.routing.preferenceRevision}.
          {' '}Route {attempt.routing.routeId} revision {attempt.routing.routeRevision}; price {attempt.routing.priceVersion}.
          {attempt.routing.upstreamEndpoint && <> Service address: {attempt.routing.upstreamEndpoint}.</>}
          {attempt.routing.fallbackReason === 'ranked_by_profile' ? <> Chosen by the routing preference.</>
            : attempt.routing.fallbackReason && <> Reason for using a backup: {attempt.routing.fallbackReason}.</>}
        </small>}
      </li>)}</ol>
    </div>;
}

/** Ordinary conversations have durable child runs, separate from task sessions. */
export function ThreadManagedRoutingDetails({ projectId, threadId, refreshKey }: {
  projectId: string; threadId: string; refreshKey: string;
}) {
  const [open, setOpen] = useState(false), [before, setBefore] = useState<string | null>(null);
  const [page, setPage] = useState<RoutingReceiptPage | null>(null), [error, setError] = useState('');
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    setPage(null); setError('');
    const endpoint = `/projects/${encodeURIComponent(projectId)}/threads/${encodeURIComponent(threadId)}/routing-attempts`;
    void api<unknown>(`${endpoint}${before ? `?before=${encodeURIComponent(before)}` : ''}`, 'GET', undefined, controller.signal)
      .then(value => { if (!controller.signal.aborted) setPage(routingReceiptPageSchema.parse(value)); })
      .catch(cause => { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "Job details couldn't be read."); });
    return () => controller.abort();
  }, [open, projectId, threadId, before, refreshKey, refresh]);
  return <details className="run-inspector" onToggle={event => setOpen(event.currentTarget.open)}>
    <summary>AI run details</summary>
    {open && <section aria-label="Conversation managed AI attempts">
      {error && <p role="alert">{error}</p>}
      {!page && !error && <p>Reading recorded attempts...</p>}
      {page?.entries.map(entry => <Receipt key={`${entry.runId}/${entry.stepId}`} receipt={entry.receipt} />)}
      {page && page.entries.length === 0 && <p>No managed AI attempts were recorded for these messages.</p>}
      <div className="button-row">
        {page?.nextBefore && <button type="button" onClick={() => setBefore(page.nextBefore)}>Earlier messages</button>}
        {before && <button type="button" onClick={() => setBefore(null)}>Latest messages</button>}
        <button type="button" onClick={() => setRefresh(value => value + 1)}>Refresh run details</button>
      </div>
    </section>}
  </details>;
}
