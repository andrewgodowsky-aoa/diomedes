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
 *
 * A person cannot reserve or settle included usage through this surface (owner
 * rule, 2026-09-30). Diomedes staff, and usage a business bought outright, are
 * the only kinds allowed (owner rule, 2026-10-01). This app can identify staff, by
 * asking the account service at the time (an active staff row, never anything in
 * the request). Its local ledger keeps one pool and no purchased line, so staff
 * hold and settle there, and everyone else's reservation is held by the account
 * service against the business's recorded top-ups, never against the included
 * month. The route marks a reservation as direct and passes the host's own answer
 * on staff; the gateway sends a non-staff hold to the service, or refuses it when
 * the service holds nothing. A non-staff settle goes to the service too, which
 * knows only the holds that person made; a hold on the included month is not one,
 * and is refused. The ledger itself stays open to an in-process caller.
 *
 * A hold on bought usage is a lease the service times on its own clock. A non-staff person
 * renews the hold they made through the renew route, as that person; staff hold on the local
 * ledger, which keeps no lease, so there is nothing for them to renew.
 */
import type { Express, Request, Response } from 'express';
import type { StaffRole } from '../shared/access.js';
import { SIGN_IN_REQUIRED } from '../shared/accounts.js';
import {
  CREDIT_PURCHASE_MAX_CREDITS,
  CREDIT_PURCHASE_MIN_CREDITS,
  CREDIT_PURCHASE_STEP,
  isAllowedCheckoutUrl,
  isPurchasableCredits,
  type CreditPurchaseStarted,
  type CreditPurchaseStatus,
  type CreditQuote,
} from '../shared/credit-purchases.js';
import type { PurchasedUsageState } from '../shared/managed-usage.js';
import {
  ALLOWANCE_MEANING,
  RATE_CARD_V1,
  micro,
  periodIdFor,
  type AllowanceView,
  type ChargeKind,
  type UsageState,
} from '../shared/managed-usage.js';
import type { BillingEvent, BillingEventProcessor } from './billing-events.js';
import type { ManagedGateway } from './managed-gateway.js';
import type { AllowanceLedger } from './managed-usage.js';
import {
  DIRECT_RENEW_REASON,
  DIRECT_RENEW_REFUSED,
  DIRECT_RESERVATION_REFUSED,
  DIRECT_SETTLE_REASON,
  DIRECT_SETTLE_REFUSED,
  PURCHASED_REFUSAL_STATUS,
  STAFF_RENEW_REASON,
  STAFF_RENEW_REFUSED,
  type PurchasedUsage,
} from './managed-gateway.js';
import { ApiError } from './paths.js';
import type { Store } from './store.js';
import type { WorkspaceService } from './workspaces.js';

const body = (req: Request): Record<string, unknown> =>
  req.body && typeof req.body === 'object' && !Array.isArray(req.body)
    ? (req.body as Record<string, unknown>)
    : {};

const organizationId = (req: Request) => String(req.params.organizationId ?? '');

export const NOT_CONNECTED_REASON =
  'This app is not signed in to a Nectovia account, so it cannot read this business’s credit usage. Nothing is estimated in its place.';

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

/**
 * The host's own answer on whether the signed-in person is active Diomedes staff, asked of the
 * account service when it is needed. Not a request field, and not remembered.
 */
export interface StaffReader {
  staffRole(): Promise<StaffRole | null>;
}

/**
 * Buying credits, as the account service does it: it prices an amount, makes the purchase and says where to
 * pay, takes the payment and records the credits. This app asks and shows what comes back; it never prices
 * anything, takes a payment or opens the payment page itself.
 */
export interface CreditPurchasing {
  quoteCredits(organizationId: string, credits: number): Promise<CreditQuote>;
  startCreditPurchase(organizationId: string, credits: number): Promise<CreditPurchaseStarted>;
  readCreditPurchase(organizationId: string, purchaseId: string): Promise<CreditPurchaseStatus>;
  /** The origin of the test service's own checkout page when the account service is the test one, else null. */
  localCheckoutOrigin(): string | null;
}

const CREDITS_REASON = `Credits are bought in steps of ${CREDIT_PURCHASE_STEP}, from ${CREDIT_PURCHASE_MIN_CREDITS} up to ${CREDIT_PURCHASE_MAX_CREDITS.toLocaleString('en-US')}.`;
const PURCHASE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export function mountManagedUsageRoutes(
  app: Express,
  store: Store,
  ledger: AllowanceLedger,
  gateway: ManagedGateway,
  billing: BillingEventProcessor,
  workspaces: WorkspaceService,
  /** Left out, nobody is staff here: an install without accounts has no one to say so. */
  staff: StaffReader | null = null,
  /** Left out, a person who is not staff holds nothing: there is no account service to hold bought usage. */
  purchased: PurchasedUsage | null = null,
  /** Left out, nobody can buy credits here: there is no account service to sell them. */
  credits: CreditPurchasing | null = null,
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

  /**
   * A route that needs to know whether the signed-in person is staff. The account service is a
   * network call and the store lock is everyone's, so it is asked first and the lock is taken
   * after. Membership is checked before it, so a stranger reads as absent without the service
   * being asked. An error, a sign-out, or no reader at all says nobody is staff.
   *
   * Staff act on the local ledger, so they run under the store lock. Everyone else acts on the
   * account service and never writes the ledger, so they run without it: a network call must not
   * hold everyone's lock while it waits.
   */
  const withStaff =
    (action: (req: Request, res: Response, asker: StaffRole | null) => Promise<unknown>) =>
    async (req: Request, res: Response, next: (error?: unknown) => void) => {
      let asker: StaffRole | null = null;
      try {
        assertMine(req);
        asker = staff ? await staff.staffRole() : null;
      } catch (error) {
        if (error instanceof ApiError) return next(error);
        asker = null;
      }
      return route((inner, out) => action(inner, out, asker), asker !== null)(req, res, next);
    };

  /**
   * A non-staff renewal, sent to the account service as that person. The service finds only a hold this
   * person made; someone else's and one that does not exist read the same, and that is a 403. The new
   * lease is the service's: this app asks, and shows what came back.
   */
  const renewPurchasedHold = async (id: string, req: Request) => {
    if (!purchased) throw new ApiError(403, DIRECT_RENEW_REASON, { code: DIRECT_RENEW_REFUSED });
    const holdId = text(body(req).reservationId, 'the attempt being renewed', 120);
    let answer;
    try {
      answer = await purchased.renewPurchased(id, { holdId });
    } catch (error) {
      if (error instanceof ApiError) {
        const code = String((error.details as { code?: unknown }).code ?? '');
        if (error.status === 404 && code === 'unknown_hold')
          throw new ApiError(403, DIRECT_RENEW_REASON, { code: DIRECT_RENEW_REFUSED });
        if (code === 'hold_not_held') throw new ApiError(409, error.message, { code });
        if (error.status === 401) throw error;
      }
      throw new ApiError(503, 'The account service couldn’t be reached, so this wasn’t renewed.', {
        code: 'purchased_renew_unavailable',
      });
    }
    return {
      reservationId: answer.holdId,
      organizationId: id,
      source: 'purchased' as const,
      state: answer.state,
      leaseUntil: answer.leaseUntil,
      balance: answer.balance,
    };
  };

  /**
   * A non-staff settle, sent to the account service as that person. The service finds only a hold
   * this person made against bought usage; a hold on the included month, someone else's hold and a
   * hold that does not exist all come back unknown, and that is the 403 a non-staff settle always
   * had. The debit is what the person says came off the bought balance: never more than was held,
   * which the service refuses. What the provider charged is checked as an amount and not kept here.
   */
  const settlePurchasedHold = async (id: string, req: Request) => {
    if (!purchased) throw new ApiError(403, DIRECT_SETTLE_REASON, { code: DIRECT_SETTLE_REFUSED });
    const value = body(req);
    const holdId = text(value.reservationId, 'the attempt being settled', 120);
    amount(value.providerCostMicroUsd, 'what the provider charged');
    const debit = amount(value.allowanceDebitMicroUsd, 'what came off the allowance');
    let answer;
    try {
      answer = await purchased.settlePurchased(id, { holdId, debitMicroUsd: debit });
    } catch (error) {
      if (error instanceof ApiError) {
        const code = String((error.details as { code?: unknown }).code ?? '');
        if (error.status === 404 && code === 'unknown_hold')
          throw new ApiError(403, DIRECT_SETTLE_REASON, { code: DIRECT_SETTLE_REFUSED });
        if (['settlement_exceeds_hold', 'settlement_conflict', 'invalid_transition'].includes(code))
          throw new ApiError(409, error.message, { code });
        if (error.status === 401) throw error;
      }
      throw new ApiError(503, 'The account service couldn’t be reached, so this wasn’t settled.', {
        code: 'purchased_settle_unavailable',
      });
    }
    return {
      reservationId: answer.holdId,
      organizationId: id,
      source: 'purchased' as const,
      state: answer.state,
      debitMicroUsd: answer.debitMicroUsd,
      balance: answer.balance,
    };
  };

  /**
   * The usage this business bought outright, read from the account service as the person signed
   * in. It is a read and writes nothing, so it does not take the store lock. Signed out, or with no
   * account service, it says not connected; a service that cannot answer says unavailable.
   */
  app.get(
    '/api/workspace/organizations/:organizationId/allowance/purchased',
    route(async (req) => {
      const id = assertMine(req);
      // Owners and admins only. A plain member is refused here, not just left without the section.
      workspaces.assertCanSeePurchasedUsage(id);
      if (!purchased) return { state: 'not-connected', organizationId: id, reason: NOT_CONNECTED_REASON } satisfies PurchasedUsageState;
      try {
        return { state: 'ready', organizationId: id, balance: await purchased.purchasedBalance(id) } satisfies PurchasedUsageState;
      } catch (error) {
        if (error instanceof ApiError && error.status === 401)
          return { state: 'not-connected', organizationId: id, reason: NOT_CONNECTED_REASON } satisfies PurchasedUsageState;
        return {
          state: 'unavailable',
          organizationId: id,
          reason: 'The account service couldn’t say what this business has bought, so nothing is shown. Nothing is estimated in its place.',
        } satisfies PurchasedUsageState;
      }
    }, false),
  );

  /**
   * Buying credits: owner or admin only, which is checked here after membership and again by the account
   * service. Nothing here prices an amount or opens a page. The quote is the service's total for an amount,
   * a started purchase answers the payment page for the client to open, and a read follows a purchase to paid.
   */
  const buyer = (req: Request) => {
    const id = assertMine(req);
    workspaces.assertCanBuyCredits(id);
    if (!credits) throw new ApiError(401, 'Sign in to use Nectovia.', { code: SIGN_IN_REQUIRED });
    return { id, credits };
  };
  /** A whole multiple of 100 in the bounds, or a 422 in plain words. */
  const askedCredits = (value: unknown) => {
    if (!isPurchasableCredits(value)) throw new ApiError(422, CREDITS_REASON, { code: 'invalid_credits' });
    return value;
  };

  app.get(
    '/api/workspace/organizations/:organizationId/allowance/credit-purchases/quote',
    route(async (req) => {
      const { id, credits: buying } = buyer(req);
      // A query value is text: a plain run of digits, or it is not an amount at all.
      const text = req.query.credits;
      return buying.quoteCredits(id, askedCredits(typeof text === 'string' && /^[1-9][0-9]{0,9}$/.test(text) ? Number(text) : undefined));
    }, false),
  );

  app.post(
    '/api/workspace/organizations/:organizationId/allowance/credit-purchases',
    route(async (req, res) => {
      const { id, credits: buying } = buyer(req);
      // The credits, and nothing else: an amount, a price or a payment page named in the request is refused, not ignored.
      const value = req.body as unknown;
      if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some((key) => key !== 'credits'))
        throw invalid('Send only the credits to buy.', 'invalid_request');
      const started = await buying.startCreditPurchase(id, askedCredits((value as { credits?: unknown }).credits));
      // A link in an answer is data. Only Stripe's own page, or the test service's own, is ever passed to a client to open.
      if (!isAllowedCheckoutUrl(started.checkoutUrl, buying.localCheckoutOrigin()))
        throw new ApiError(502, 'The payment page the account service sent isn’t one this app will open.', { code: 'checkout_url_refused' });
      res.status(201);
      return started;
    }, false),
  );

  app.get(
    '/api/workspace/organizations/:organizationId/allowance/credit-purchases/:purchaseId',
    route(async (req) => {
      const { id, credits: buying } = buyer(req);
      const purchaseId = String(req.params.purchaseId ?? '');
      if (!PURCHASE_ID.test(purchaseId))
        throw new ApiError(404, 'That purchase was not found for this business.', { code: 'unknown_purchase' });
      return buying.readCreditPurchase(id, purchaseId);
    }, false),
  );

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

  /**
   * Nectovia usage, as this host can honestly report it. Tenant credit usage
   * is owned by the control plane and read with an authenticated account
   * session. This desktop host holds no control-plane session and no client
   * for one, so it says so rather than drawing numbers. The local allowance
   * ledger above is not the tenant allowance and is never relabelled as it.
   */
  app.get(
    '/api/workspace/organizations/:organizationId/usage',
    route(async (req) => {
      const id = assertMine(req);
      const state: UsageState = {
        state: 'not-connected',
        organizationId: id,
        reason: NOT_CONNECTED_REASON,
      };
      return state;
    }, false),
  );

  app.post(
    '/api/workspace/organizations/:organizationId/allowance/admit',
    withStaff(async (req, _res, asker) => {
      const id = assertMine(req);
      const value = body(req);
      const at = new Date().toISOString();
      // A job's cap comes from the host's tier map. A body that names its own envelope is
      // refused outright rather than ignored, so a caller relying on it learns it never applied.
      if ('parentEnvelopeMicroUsd' in value)
        throw new ApiError(400, "A job's cap comes from its tier on this computer. Remove parentEnvelopeMicroUsd.", {
          code: 'client_envelope_refused',
        });
      // Everything authoritative is read from the host: the person, the tenant,
      // the entitlement, the policy, the job's cap, and whether this person is staff.
      // What arrives in the body is the shape of the work, and a `paid` flag or a
      // `staff` role in it is just a word.
      // A person is asking, so this is a direct reservation, and the host says so. A body
      // cannot: the flag is set here and nowhere reads it from the request.
      const decision = await gateway.admit({
        organizationId: id,
        personId: workspaces.currentPerson().id,
        route: text(value.route, 'the route this work runs on', 60),
        kind: chargeKind(value.kind),
        parentTaskId: value.parentTaskId == null ? null : String(value.parentTaskId).slice(0, 100),
        maxMicroUsd: amount(value.maxMicroUsd, 'the most this call may cost'),
        requestDigest: text(value.requestDigest, 'the digest of the request being authorized', 200),
        reservationId: text(value.reservationId, 'an identifier for this attempt', 120),
        periodId: periodIdFor(at),
        at,
        directReservation: true,
        staffRole: asker,
      });
      // Owner rule (2026-09-30): a person who is not staff cannot hold included usage by asking for
      // it. This is a refusal of the person, so it is a 403, not an admission that happens to say no.
      if (!decision.admitted && decision.code === DIRECT_RESERVATION_REFUSED)
        throw new ApiError(403, decision.message, { code: decision.code });
      // A person who is not staff may hold only usage the business bought outright, and the account
      // service says whether there is any. When it holds nothing, that is a refusal of the person.
      if (!decision.admitted && decision.code in PURCHASED_REFUSAL_STATUS)
        throw new ApiError(PURCHASED_REFUSAL_STATUS[decision.code], decision.message, { code: decision.code });
      return decision;
    }),
  );

  app.post(
    '/api/workspace/organizations/:organizationId/allowance/settle',
    withStaff(async (req, _res, asker) => {
      const id = assertMine(req);
      // Settling takes a caller-supplied debit against an existing hold. On the local ledger, which
      // is the included month, that is for staff only. Anyone else may settle only a hold they made
      // against usage the business bought, and the account service is the one that knows them.
      if (!asker) return settlePurchasedHold(id, req);
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

  app.post(
    '/api/workspace/organizations/:organizationId/allowance/renew',
    withStaff(async (req, _res, asker) => {
      const id = assertMine(req);
      // Staff hold on this computer's ledger, which keeps no lease. Only a person who holds bought usage has one.
      if (asker) throw new ApiError(409, STAFF_RENEW_REASON, { code: STAFF_RENEW_REFUSED });
      return renewPurchasedHold(id, req);
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
      workspaces.assertCanManageBilling(id);
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
