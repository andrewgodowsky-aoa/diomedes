/**
 * The allowance HTTP surface.
 *
 * The same division of labour as `server/configuration-routes.ts`, and for the
 * same reason: these routes parse, refuse malformed input, and take the store
 * lock. Every authority question — whether this person is in this company,
 * whether there is an entitlement, whether the work can be afforded — is
 * answered by `ManagedGateway` and `AllowanceLedger`, because a money rule that
 * lives in two places disagrees with itself exactly when it matters.
 *
 * The organization comes from the URL and is re-checked against membership on
 * every request, including replays. A route that trusted a body field, or that
 * skipped the check because the identifier in hand was one it had issued
 * itself, is the cross-tenant leak this product cannot have.
 *
 * There is no route that hands a client a provider key, and no route that takes
 * one. This is an admission surface, not a proxy.
 */
import type { Express, Request, Response } from 'express';
import {
  ALLOWANCE_MEANING,
  RATE_CARD_V1,
  micro,
  periodIdFor,
  type AllowanceView,
  type ChargeKind,
} from '../shared/managed-usage.js';
import type { BillingEvent, BillingEventProcessor } from './billing-events.js';
import type { ManagedGateway } from './managed-gateway.js';
import type { AllowanceLedger } from './managed-usage.js';
import { ApiError } from './paths.js';
import type { Store } from './store.js';
import type { WorkspaceService } from './workspaces.js';

const body = (req: Request): Record<string, unknown> =>
  req.body && typeof req.body === 'object' && !Array.isArray(req.body)
    ? (req.body as Record<string, unknown>)
    : {};

const organizationId = (req: Request) => String(req.params.organizationId ?? '');

const invalid = (message: string, code: string) => new ApiError(400, message, { code });

/** Money crosses this boundary as an integer count of micro-USD, or not at all. */
function amount(value: unknown, field: string) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)
    throw invalid(
      `Provide ${field} as a whole number of micro-USD. A dollar figure is rounded where the decision is made, not here.`,
      'invalid_amount',
    );
  return micro(value);
}

function chargeKind(value: unknown): ChargeKind {
  if (typeof value !== 'string' || !(RATE_CARD_V1.kinds as readonly string[]).includes(value))
    throw invalid(
      'Name what this charge is for, using one of the kinds the rate card classifies.',
      'invalid_charge_kind',
    );
  return value as ChargeKind;
}

const text = (value: unknown, field: string, max = 200) => {
  const candidate = typeof value === 'string' ? value.trim() : '';
  if (!candidate || candidate.length > max) throw invalid(`Provide ${field}.`, 'invalid_request');
  return candidate;
};

export function mountManagedUsageRoutes(
  app: Express,
  store: Store,
  ledger: AllowanceLedger,
  gateway: ManagedGateway,
  billing: BillingEventProcessor,
  workspaces: WorkspaceService,
) {
  const route =
    (action: (req: Request, res: Response) => Promise<unknown>, locked = true) =>
    async (req: Request, res: Response, next: (error?: unknown) => void) => {
      try {
        const result = locked ? await store.locked(() => action(req, res)) : await action(req, res);
        if (!res.headersSent) res.json(result);
      } catch (error) {
        next(error);
      }
    };

  /**
   * Membership, on every request. `assertMine` refuses with the same shape a
   * missing organization would: an outsider must not be able to tell a real
   * company id from an invented one by the status it comes back with.
   */
  const assertMine = (req: Request) => {
    const id = organizationId(req);
    workspaces.assertMine(id);
    return id;
  };

  app.get(
    '/api/workspace/organizations/:organizationId/allowance',
    route(async (req) => {
      const id = assertMine(req);
      const entitlement = workspaces.entitlementOf(id);
      const view: AllowanceView = {
        organizationId: id,
        // No entitlement means no allowance, and no allowance means no numbers.
        // Zeroes here would read as a spent balance rather than an absent one.
        summary: entitlement.managedInference
          ? ledger.summary(id, periodIdFor(new Date().toISOString()))
          : null,
        available: entitlement.managedInference,
        unavailableReason: entitlement.managedInference ? '' : entitlement.reason,
        meaning: ALLOWANCE_MEANING,
        rateCardVersion: RATE_CARD_V1.version,
      };
      return view;
    }, false),
  );

  app.post(
    '/api/workspace/organizations/:organizationId/allowance/admit',
    route(async (req) => {
      const id = assertMine(req);
      const value = body(req);
      const at = new Date().toISOString();
      // Everything authoritative is read from the host: the person, the tenant,
      // the entitlement, the policy. What arrives in the body is the shape of
      // the work, and a `paid` flag in it is just a word.
      return gateway.admit({
        organizationId: id,
        personId: workspaces.currentPerson().id,
        route: text(value.route, 'the route this work runs on', 60),
        kind: chargeKind(value.kind),
        parentTaskId: value.parentTaskId == null ? null : String(value.parentTaskId).slice(0, 100),
        maxMicroUsd: amount(value.maxMicroUsd, 'the most this call may cost'),
        parentEnvelopeMicroUsd:
          value.parentEnvelopeMicroUsd == null
            ? null
            : amount(value.parentEnvelopeMicroUsd, "the parent task's remaining envelope"),
        requestDigest: text(value.requestDigest, 'the digest of the request being authorized', 200),
        reservationId: text(value.reservationId, 'an identifier for this attempt', 120),
        periodId: periodIdFor(at),
        at,
      });
    }),
  );

  app.post(
    '/api/workspace/organizations/:organizationId/allowance/settle',
    route(async (req) => {
      const id = assertMine(req);
      const value = body(req);
      return ledger.settle({
        reservationId: text(value.reservationId, 'the attempt being settled', 120),
        organizationId: id,
        providerCostMicroUsd: amount(value.providerCostMicroUsd, 'what the provider charged'),
        allowanceDebitMicroUsd: amount(
          value.allowanceDebitMicroUsd,
          'what came off the allowance',
        ),
        reconciledFrom: value.reconciledFrom === 'provider-report' ? 'provider-report' : 'response',
        at: new Date().toISOString(),
      });
    }),
  );

  /**
   * Billing events arrive here already authenticated by whatever delivered
   * them; this route is the membership-scoped way to apply one, and it exists
   * so the flow can be exercised without a provider. A production webhook needs
   * signature verification of its own before it reaches this — verifying a
   * signature is not something a membership check can stand in for.
   */
  app.post(
    '/api/workspace/organizations/:organizationId/billing-events',
    route(async (req) => {
      const id = assertMine(req);
      const value = body(req);
      const type = String(value.type ?? '');
      const sequence = Number(value.sequence);
      if (!Number.isSafeInteger(sequence) || sequence < 1)
        throw invalid('Provide the position of this event in the stream.', 'invalid_sequence');
      const common = {
        eventId: text(value.eventId, 'the identifier of this billing event', 120),
        organizationId: id,
        sequence,
        at: typeof value.at === 'string' ? value.at : new Date().toISOString(),
      };
      let event: BillingEvent;
      switch (type) {
        case 'period.allocated':
          event = {
            ...common,
            type,
            periodId: text(value.periodId, 'the billing period', 20),
            planVersion: text(value.planVersion, 'the plan version', 60),
            grantedMicroUsd: amount(value.grantedMicroUsd, 'the allowance granted'),
            startsAt: text(value.startsAt, 'when the period starts', 40),
            endsAt: text(value.endsAt, 'when the period ends', 40),
          };
          break;
        case 'adjustment':
          event = {
            ...common,
            type,
            periodId: text(value.periodId, 'the billing period', 20),
            reason: text(value.reason, 'why this adjustment was made', 40) as never,
            direction: value.direction === 'withdraw' ? 'withdraw' : 'grant',
            amountMicroUsd: amount(value.amountMicroUsd, 'the amount adjusted'),
          };
          break;
        case 'subscription.lapsed':
          event = { ...common, type };
          break;
        case 'security.suspended':
          event = { ...common, type, reason: text(value.reason, 'why access was suspended', 300) };
          break;
        default:
          throw invalid('That is not a billing event this build understands.', 'invalid_event');
      }
      return billing.apply(event);
    }),
  );
}
