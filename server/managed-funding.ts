/**
 * The seam between a managed model call and the customer's credits.
 *
 * A managed call spends two things that are kept apart: the company's own
 * provider money, held on the local `SpendExposure` cap exactly as the founder
 * route does, and the customer's included credits, held on the control plane's
 * funded parent job. This ledger holds both for one call and resolves both from
 * the same provider evidence:
 *
 *   reserve         entitlement check, local hold, then the funded hold on the
 *                   customer's root job (the month first, then top-ups)
 *   beforeDispatch  entitlement check again (a revocation between queue and send
 *                   stops the send), then the funded dispatch commit; nothing
 *                   leaves unless that commit lands
 *   settle          the funded settlement first, from validated provider usage
 *                   under the rate snapshot the hold was reserved with; the
 *                   local hold only after it
 *   release         unsent: both released. Sent and refused with a readable
 *                   error: Google charges only for HTTP 200, so the funded hold
 *                   settles at zero usage from that provider report
 *   markUncertain   both held as uncertain; nothing is refunded by a restart,
 *                   a retry or a new month
 *
 * Every child call of the job (lead, worker, reviewer, advisor, correction,
 * retry) names the same root job, so all of them spend inside one cap. Provider
 * gross cost, the credit debit and the customer's invoice remain separate
 * records: this module writes the first two and never the third.
 *
 * `FundingPort` is the control plane's `FundingService` surface, not an import
 * of it: the desktop runtime reaches it through whatever authenticated boundary
 * hosts it. No customer build carries a company Google credential; see
 * docs/implementation/2026-09-23-vertex-managed-inference.md.
 */
import type { ChargeKind, FundedAttempt, MicroUsd, RateSnapshot } from '../shared/managed-usage.js';
import type { CallExposure } from './engines/model-api-core.js';
import {
  SpendExposureError,
  type ExposureReservation,
  type ModelRateCard,
  type ProviderUsage,
  type SpendExposure,
} from './spend-exposure.js';

export interface FundingAttemptRef {
  tenantId: string;
  organizationId: string;
  attemptId: string;
}

/** The part of the control plane's `FundingService` a managed call uses. */
export interface FundingPort {
  reserve(input: {
    tenantId: string;
    organizationId: string;
    attemptId: string;
    rootJobId: string;
    parentAttemptId: string | null;
    kind: ChargeKind;
    route: string;
    requestDigest: string;
    rateSnapshot: RateSnapshot;
    maxMicroUsd: MicroUsd;
  }): Promise<FundedAttempt>;
  markDispatched(ref: FundingAttemptRef): Promise<FundedAttempt>;
  release(ref: FundingAttemptRef): Promise<FundedAttempt>;
  markUncertain(ref: FundingAttemptRef & { reason: string }): Promise<FundedAttempt>;
  settle(
    ref: FundingAttemptRef & { receiptRef: string; usage: unknown; reconciledFrom: 'response' | 'provider-report' },
  ): Promise<{ outcome: 'settled' } | { outcome: 'held'; reason: string }>;
}

/**
 * Whether this organization may spend managed credits on this route right now:
 * an active subscription entitlement, the route and model allowed for it, and
 * nothing revoked. Null allows; a sentence refuses. Asked before the hold and
 * again immediately before the bytes leave.
 */
export type ManagedEntitlement = (question: { route: string; modelId: string; phase: 'reserve' | 'dispatch' }) => Promise<string | null>;

export interface ManagedJob {
  tenantId: string;
  organizationId: string;
  /** The parent user job every call of this work spends inside. */
  rootJobId: string;
  /** The attempt this call is a child or retry of, under the same root job. */
  parentAttemptId: string | null;
  kind: ChargeKind;
}

export class ManagedFundingError extends SpendExposureError {}

/** The rate a funded hold is priced under: the dearer of the card's two bands, so it can only overstate. */
export function rateSnapshotOf(card: ModelRateCard): RateSnapshot {
  return {
    version: card.version,
    inputMicroUsdPerMillion: Math.max(card.short.input, card.long.input),
    outputMicroUsdPerMillion: Math.max(card.short.output, card.long.output),
    cacheReadMicroUsdPerMillion: Math.max(card.short.cacheRead, card.long.cacheRead),
    cacheWriteMicroUsdPerMillion: Math.max(card.short.cacheWrite, card.long.cacheWrite),
  };
}

/**
 * Provider usage in the funded ledger's terms. The local ledger counts cache
 * reads and writes inside `inputTokens`; the funded ledger prices `inputTokens`
 * at the full input rate beside the cache counts, so it receives fresh input
 * only. Charging a cached token twice would be a guess against the customer.
 */
export function fundedUsage(usage: ProviderUsage) {
  return {
    inputTokens: usage.inputTokens - usage.cacheReadTokens - usage.cacheWriteTokens,
    outputTokens: usage.outputTokens,
    cacheReadTokens: usage.cacheReadTokens,
    cacheWriteTokens: usage.cacheWriteTokens,
    reasoningTokens: usage.reasoningTokens,
  };
}

const refused = (code: string, message: string, status = 402) => new ManagedFundingError(code, message, status);

/** A funded ledger for the calls of one managed job. */
export function fundedExposure(options: {
  local: SpendExposure;
  funding: FundingPort;
  entitlement: ManagedEntitlement;
  job: ManagedJob;
}): CallExposure {
  const { local, funding, entitlement, job } = options;
  const refs = new Map<string, FundingAttemptRef & { dispatched: boolean }>();
  const ref = (reservationId: string) => {
    const found = refs.get(reservationId);
    if (!found) throw refused('funding_unknown_hold', 'This call has no funded hold.', 409);
    return found;
  };
  const allowed = async (route: string, modelId: string, phase: 'reserve' | 'dispatch') => {
    const reason = await entitlement({ route, modelId, phase });
    if (reason) throw refused(phase === 'dispatch' ? 'entitlement_revoked' : 'entitlement_refused', reason, 403);
  };
  return {
    async reserve(input) {
      await allowed(input.route, input.modelId, 'reserve');
      const reservation = await local.reserve(input);
      const attemptRef = { tenantId: job.tenantId, organizationId: job.organizationId, attemptId: reservation.id };
      try {
        await funding.reserve({
          ...attemptRef,
          rootJobId: job.rootJobId,
          parentAttemptId: job.parentAttemptId,
          kind: job.kind,
          route: input.route,
          requestDigest: input.attempt.requestDigest,
          rateSnapshot: rateSnapshotOf(input.card),
          maxMicroUsd: reservation.maxMicroUsd,
        });
      } catch (error) {
        await local.release(reservation.id, 'The customer’s credits refused this call before it was sent.').catch(() => undefined);
        const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : 'funding_refused';
        throw refused(code, error instanceof Error ? error.message : 'The customer’s credits refused this call.');
      }
      refs.set(reservation.id, { ...attemptRef, dispatched: false });
      return reservation;
    },
    async beforeDispatch(reservation: ExposureReservation) {
      const attemptRef = ref(reservation.id);
      await allowed(reservation.route, reservation.modelId, 'dispatch');
      await funding.markDispatched(attemptRef);
      attemptRef.dispatched = true;
    },
    async settle(reservationId, settlement) {
      const attemptRef = ref(reservationId);
      const result = await funding.settle({
        ...attemptRef,
        receiptRef: (settlement.providerRequestId ?? reservationId).replace(/[^A-Za-z0-9._:-]/g, '_').slice(0, 128),
        usage: fundedUsage(settlement.usage),
        reconciledFrom: 'response',
      });
      if (result.outcome !== 'settled') throw refused('funding_held', result.reason, 409);
      return local.settle(reservationId, settlement);
    },
    async release(reservationId, reason) {
      const attemptRef = ref(reservationId);
      if (!attemptRef.dispatched) await funding.release(attemptRef);
      else {
        // Either sent and refused with a readable error (Google bills only HTTP 200), or stopped
        // in the instant between the funded dispatch commit and the send. Both cost nothing; the
        // receipt says which.
        const result = await funding.settle({
          ...attemptRef,
          receiptRef: `${reason.startsWith('Not sent') ? 'unsent' : 'refused'}_${reservationId}`,
          usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 },
          reconciledFrom: 'provider-report',
        });
        if (result.outcome !== 'settled') {
          await funding.markUncertain({ ...attemptRef, reason: `${reason} ${result.reason}` }).catch(() => undefined);
          return local.markUncertain(reservationId, reason);
        }
      }
      return local.release(reservationId, reason);
    },
    async markUncertain(reservationId, reason) {
      const attemptRef = ref(reservationId);
      if (attemptRef.dispatched) await funding.markUncertain({ ...attemptRef, reason });
      else await funding.release(attemptRef);
      return local.markUncertain(reservationId, reason);
    },
  };
}
