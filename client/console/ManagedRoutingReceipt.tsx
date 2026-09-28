import type { HarnessRun } from '../../shared/harness';
import { routingReceiptSchema } from '../../shared/routing-policy';
import { formatCredits, micro } from '../../shared/managed-usage';

const credits = (value: number) => formatCredits(micro(value));

/** Uses durable model-step receipts, never current policy or locally estimated balances. */
export function ManagedRoutingReceipt({ run }: { run: HarnessRun }) {
  const steps = run.steps.flatMap(step => {
    const output = step.output;
    const saved = output && typeof output === 'object' && !Array.isArray(output) ? output.managed : undefined;
    const failed = step.error && 'managed' in step.error ? step.error.managed : undefined;
    const receipt = routingReceiptSchema.safeParse(saved ?? failed);
    return receipt?.success ? [{ id: step.intent.stepId, receipt: receipt.data }] : [];
  });
  if (!steps.length) return null;
  return <section aria-label="Managed AI attempts">
    <h3>Managed AI attempts</h3>
    {steps.map(step => <div key={step.id}>
      <p>{credits(step.receipt.allowanceDebitMicroUsd)} credits used
        {step.receipt.heldMicroUsd > 0 && <>; up to {credits(step.receipt.heldMicroUsd)} credits remain reserved for unresolved attempts</>}.</p>
      <ol>{step.receipt.attempts.map(attempt => <li key={attempt.attemptId} style={{ minWidth: 0, overflowWrap: 'anywhere' }}>
        <strong>{attempt.routing ? `${attempt.routing.provider} / ${attempt.routing.model}` : 'Route not recorded'}</strong>
        <span> - {attempt.state}. {attempt.allowanceDebitMicroUsd === null ? 'Final usage not recorded.' : `${credits(attempt.allowanceDebitMicroUsd)} credits used.`}</span>
        {attempt.routing && <small style={{ display: 'block' }}>
          Policy {attempt.routing.policyRevision}; global {attempt.routing.globalRevision}; account {attempt.routing.scopeRevision}; privacy {attempt.routing.preferenceRevision}.
          {' '}Route {attempt.routing.routeId} revision {attempt.routing.routeRevision}; price {attempt.routing.priceVersion}.
          {attempt.routing.upstreamEndpoint && <> Downstream: {attempt.routing.upstreamEndpoint}.</>}
          {attempt.routing.fallbackReason && <> Backup reason: {attempt.routing.fallbackReason}.</>}
        </small>}
      </li>)}</ol>
    </div>)}
  </section>;
}
