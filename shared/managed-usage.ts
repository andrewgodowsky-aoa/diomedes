/**
 * The managed-allowance contract: money, eligibility, payer and the reservation
 * state machine, with no ledger, no service and no network in sight.
 *
 * Everything here is pure so that the four mistakes this area actually makes
 * are impossible rather than merely discouraged.
 *
 * 1. **Money never touches a float.** An amount is an integer count of
 *    micro-USD. `0.1 + 0.2` is not `0.3` in binary floating point, and a
 *    balance that drifts by a millionth per call is a balance nobody can
 *    reconcile against a provider invoice. Dollars enter through `dollars()`,
 *    which refuses anything finer than one micro-USD rather than rounding it
 *    quietly.
 *
 * 2. **Three quantities stay separate.** What a provider charged, what the
 *    allowance was debited, and what a customer is invoiced are three different
 *    numbers that happen to be similar today. A single `amount` field would
 *    make them one number tomorrow, and the first marked-up credit or the first
 *    excluded fee would then be a silent lie. `SettledCharge` carries all three
 *    and the rate-card version that related them.
 *
 * 3. **Eligibility belongs to a versioned rate card, not to a caller.** Whether
 *    an embedding debits the allowance is a commercial fact with a date on it.
 *    Reading it from `RATE_CARD_V1` means a charge settled last month keeps the
 *    classification it was settled under, even after the card changes.
 *
 * 4. **A payer is resolved, never defaulted.** `payerForRoute` returns
 *    `refused` where no honest payer exists, because the failure mode this
 *    prevents — a managed call quietly falling back to somebody's personal
 *    subscription, or a BYO key silently becoming a company charge — is a
 *    change of who pays and whose terms apply, not a retry detail.
 *
 * The plan definition in this file is inactive. It records the shape of a
 * candidate offer so the rest of the system can be built against something
 * concrete; `sellable` is `false`, unapproved limits are `null`, and nothing
 * here is a checkout, a price approval or a commercial commitment.
 */

// --- money --------------------------------------------------------------------

/**
 * An amount of money, as an integer count of micro-USD (1e-6 USD).
 *
 * The brand is not decoration: it stops a raw `number` — a token count, a
 * percentage, a dollar figure someone forgot to convert — from being spent as
 * money. Construct with `micro()` or `dollars()`.
 */
export type MicroUsd = number & { readonly __brand: 'micro-usd' };

export const MICRO_PER_USD = 1_000_000;

/** The largest amount this contract will represent: $1,000,000, well inside
 *  `Number.MAX_SAFE_INTEGER` micro-USD, so integer arithmetic stays exact. */
export const MAX_MONEY_MICRO_USD = 1_000_000 * MICRO_PER_USD;

const MONEY_RANGE = `Amounts run from 0 to ${MAX_MONEY_MICRO_USD} micro-USD.`;

/** An exact micro-USD count. The only way a `MicroUsd` is made from an integer. */
export function micro(count: number): MicroUsd {
  if (!Number.isSafeInteger(count))
    throw new RangeError(`An amount must be a whole number of micro-USD. ${MONEY_RANGE}`);
  if (count < 0)
    throw new RangeError(
      'An amount cannot be negative. A refund, grant or correction is an adjustment event with its own record, never a negative charge.',
    );
  if (count > MAX_MONEY_MICRO_USD) throw new RangeError(`That amount is too large. ${MONEY_RANGE}`);
  return count as MicroUsd;
}

/**
 * A dollar figure as exact money. `dollars(0.4)` is 400000 micro-USD.
 *
 * A value finer than one micro-USD is refused rather than rounded: rounding
 * here would be a silent write-off or a silent overcharge, and the caller is
 * the only one who knows which it meant.
 */
export function dollars(amount: number): MicroUsd {
  if (!Number.isFinite(amount)) throw new RangeError(`That is not an amount. ${MONEY_RANGE}`);
  const scaled = amount * MICRO_PER_USD;
  // Floating multiplication is exact enough to detect the sub-micro remainder,
  // and `Math.round` then removes the representation error 0.1*1e6 carries.
  const whole = Math.round(scaled);
  if (Math.abs(scaled - whole) > 1e-6)
    throw new RangeError(
      `$${amount} is finer than one micro-USD. Round it where the decision is made, not here.`,
    );
  return micro(whole);
}

export function sumMoney(amounts: readonly MicroUsd[]): MicroUsd {
  let total = 0;
  for (const amount of amounts) total += amount;
  return micro(total);
}

/**
 * `left - right`, refusing to go below zero.
 *
 * Clamping is what turns an over-spend into an invisible one. A balance that
 * cannot cover a settlement is a reconciliation problem, and the caller must
 * see it as a throw rather than as a zero.
 */
export function subtractMoney(left: MicroUsd, right: MicroUsd): MicroUsd {
  if (right > left)
    throw new RangeError(
      `${formatMoney(right)} exceeds the ${formatMoney(left)} available. This is a reconciliation problem, not a rounding one.`,
    );
  return micro(left - right);
}

/**
 * Money as text. Two decimal places for ordinary amounts; full micro precision
 * only where the amount actually has it, so a sub-cent figure is never shown
 * as `$0.00`.
 */
export function formatMoney(amount: MicroUsd): string {
  const negative = amount < 0;
  const abs = Math.abs(amount);
  const whole = Math.floor(abs / MICRO_PER_USD);
  const fraction = abs % MICRO_PER_USD;
  const text =
    fraction % 10_000 === 0
      ? `${whole}.${String(fraction / 10_000).padStart(2, '0')}`
      : `${whole}.${String(fraction).padStart(6, '0')}`;
  return `${negative ? '-' : ''}$${text}`;
}

// --- what a charge is for -----------------------------------------------------

/**
 * The kinds of upstream charge this product can incur. Naming them exhaustively
 * is the point: an unnamed kind cannot be classified, and an unclassified kind
 * is exactly the fee that surprises somebody on an invoice.
 */
export type ChargeKind =
  | 'setup'
  | 'generation'
  | 'billed-reasoning'
  | 'cache-write'
  | 'cache-read'
  | 'reviewer'
  | 'advisor'
  | 'correction'
  | 'embedding'
  | 'tool-service'
  | 'support'
  | 'storage';

/**
 * What a charge kind does to the allowance.
 *
 * `included` debits it. `excluded-not-admitted` means this build will not run
 * the work at all under a managed payer, because the charge has no reliable
 * pre-call bound and a route without one cannot promise a hard spending cap.
 * `excluded-billed-separately` is a real cost that is simply not upstream
 * inference, so it never touches the inference allowance.
 */
export type ChargeEligibility = 'included' | 'excluded-not-admitted' | 'excluded-billed-separately';

export interface RateCard {
  /** Recorded on every settlement, so a past charge keeps its own terms. */
  readonly version: string;
  readonly effectiveFrom: string;
  readonly kinds: readonly ChargeKind[];
  readonly eligibility: Readonly<Record<ChargeKind, ChargeEligibility>>;
  /** One sentence per kind, in the words a customer would be told. */
  readonly reason: Readonly<Record<ChargeKind, string>>;
}

const ALL_KINDS: readonly ChargeKind[] = Object.freeze([
  'setup',
  'generation',
  'billed-reasoning',
  'cache-write',
  'cache-read',
  'reviewer',
  'advisor',
  'correction',
  'embedding',
  'tool-service',
  'support',
  'storage',
]);

/**
 * The first rate card.
 *
 * Two classifications are decisions rather than descriptions, and both follow
 * the same rule — an allowance can only bound what can be bounded before the
 * call.
 *
 * Embeddings are *included*: they are upstream inference, priced per token, and
 * bounded by the same input limit as a generation. Excluding them would mean
 * charging a customer for inference outside the allowance they were sold.
 *
 * Provider-billed tool services — hosted search, hosted execution, anything
 * whose price depends on what the provider decides to do after the request
 * leaves — are *not admitted* under a managed payer. There is no honest reserve
 * for a charge whose ceiling is unknown, and a soft cap sold as a hard one is
 * the failure this whole contract exists to prevent. They remain available on a
 * route whose payer is the organization's own key, where the organization holds
 * the risk it can see.
 */
export const RATE_CARD_V1: RateCard = Object.freeze({
  version: 'rate-card-2026-09-10.1',
  effectiveFrom: '2026-09-10T00:00:00.000Z',
  kinds: ALL_KINDS,
  eligibility: Object.freeze({
    setup: 'included',
    generation: 'included',
    'billed-reasoning': 'included',
    'cache-write': 'included',
    'cache-read': 'included',
    reviewer: 'included',
    advisor: 'included',
    correction: 'included',
    embedding: 'included',
    'tool-service': 'excluded-not-admitted',
    support: 'excluded-billed-separately',
    storage: 'excluded-billed-separately',
  }) as Readonly<Record<ChargeKind, ChargeEligibility>>,
  reason: Object.freeze({
    setup: 'Getting a setup ready calls a model, and those calls cost money like any other.',
    generation: 'The answer itself.',
    'billed-reasoning': 'Reasoning the provider bills for separately from the answer.',
    'cache-write': 'Storing context with the provider so later calls cost less.',
    'cache-read': 'Reading that stored context back.',
    reviewer: 'A reviewer reading the work is a call of its own.',
    advisor: 'An advisor asked mid-task is a call of its own.',
    correction: 'A retry after a correction is a new call and is charged as one.',
    embedding: 'Turning your documents into something searchable is priced per token like any other call.',
    'tool-service':
      'Provider-run tools have no price we can know before the call, so they are not run on the included allowance. They remain available on your own provider key.',
    support: 'Support is not model usage and never comes out of the included allowance.',
    storage: 'Storage is not model usage and never comes out of the included allowance.',
  }) as Readonly<Record<ChargeKind, string>>,
});

/**
 * What each kind is called on a screen. Lower case and short, because these are
 * read in a list mid-sentence rather than as headings — the same treatment
 * `PROCESSING_TEXT` and `CONNECTION_STATUS_TEXT` already use.
 */
export const CHARGE_KIND_TEXT: Readonly<Record<ChargeKind, string>> = Object.freeze({
  setup: 'getting a setup ready',
  generation: 'answers',
  'billed-reasoning': 'reasoning the provider bills for',
  'cache-write': 'storing context to make later calls cheaper',
  'cache-read': 'reading stored context back',
  reviewer: 'a reviewer reading the work',
  advisor: 'an advisor asked during a task',
  correction: 'retries after a correction',
  embedding: 'making your documents searchable',
  'tool-service': 'tools the provider runs and prices itself',
  support: 'support',
  storage: 'storage',
});

/** The kinds split by whether they come out of the allowance. */
export function chargeKindsBy(card: RateCard): {
  included: ChargeKind[];
  excluded: ChargeKind[];
} {
  const included: ChargeKind[] = [];
  const excluded: ChargeKind[] = [];
  for (const kind of card.kinds)
    (chargeKindEligibility(card, kind) === 'included' ? included : excluded).push(kind);
  return { included, excluded };
}

export function chargeKindEligibility(card: RateCard, kind: ChargeKind): ChargeEligibility {
  const eligibility = card.eligibility[kind];
  if (!eligibility)
    throw new Error(
      `Rate card ${card.version} does not classify ${kind}. An unclassified charge is never admitted.`,
    );
  return eligibility;
}

/** Whether a managed payer may run work that incurs this kind at all. */
export function isAdmissibleChargeKind(card: RateCard, kind: ChargeKind): boolean {
  return chargeKindEligibility(card, kind) !== 'excluded-not-admitted';
}

/** Whether this kind draws down the included allowance when it settles. */
export function debitsAllowance(card: RateCard, kind: ChargeKind): boolean {
  return chargeKindEligibility(card, kind) === 'included';
}

// --- the inactive plan definition ---------------------------------------------

export interface PlanLimits {
  readonly seats: number | null;
  readonly hosts: number | null;
  readonly locations: number | null;
  readonly supportHours: number | null;
  readonly storageGb: number | null;
}

export interface PlanDefinition {
  readonly id: string;
  readonly version: string;
  /** `candidate` never becomes `active` by editing this file. */
  readonly status: 'candidate';
  readonly sellable: false;
  readonly notSellableReason: string;
  readonly priceMicroUsd: MicroUsd;
  readonly includedAllowanceMicroUsd: MicroUsd;
  readonly rateCardVersion: string;
  readonly period: 'billing-period';
  readonly rollover: false;
  readonly autoOverage: false;
  readonly limits: PlanLimits;
  readonly limitsReason: string;
}

/**
 * The candidate offer, recorded so the ledger has a concrete shape to be built
 * against — and inactive so that having a shape is not mistaken for having an
 * approved price.
 *
 * `sellable: false` is a type-level `false`, not a mutable flag: turning this on
 * is a code change somebody reviews, never a configuration value a deployment
 * can flip.
 */
export const MANAGED_PLAN_CANDIDATE: PlanDefinition = Object.freeze({
  id: 'managed-agent-access',
  version: 'plan-2026-09-10.1',
  status: 'candidate',
  sellable: false,
  notSellableReason:
    'This is an engineering proposal. The price, the included allowance and every limit need commercial approval before anything can be sold, and no checkout exists in this build.',
  priceMicroUsd: dollars(300),
  includedAllowanceMicroUsd: dollars(100),
  rateCardVersion: RATE_CARD_V1.version,
  period: 'billing-period',
  rollover: false,
  autoOverage: false,
  limits: Object.freeze({
    seats: null,
    hosts: null,
    locations: null,
    supportHours: null,
    storageGb: null,
  }),
  limitsReason:
    'Seat, host, location, support and storage limits have no approved value yet. They are absent rather than guessed, because a number written here would be read as a promise.',
});

/**
 * What the included allowance is, in the words it must always be described in.
 *
 * The negatives carry the weight. Each one names something a reasonable person
 * would otherwise assume, and every one of those assumptions would be a
 * misrepresentation.
 */
export const ALLOWANCE_MEANING =
  'The included allowance is a USD allowance for managed model usage, debited by the upstream charges your work actually incurs under a recorded rate card. It is not withdrawable money, not credit on a provider account, not a fixed number of tokens or words, and not a guaranteed number of jobs. What it buys depends on what you ask for.';

// --- who pays -----------------------------------------------------------------

export type Payer = 'managed' | 'byo' | 'local' | 'refused';

/**
 * How an organization has chosen to reach models. `personal-subscription` is
 * accepted as an input because people really do configure it; it is refused as
 * an outcome, which is a different thing and a more useful one — the person is
 * told why rather than finding their work quietly billed elsewhere.
 */
export type OrganizationRoute = 'managed' | 'byo' | 'personal-subscription';

export interface PayerResolution {
  readonly payer: Payer;
  readonly debitsAllowance: boolean;
  readonly reason?: string;
}

/** Routes that run on this computer, and so cost the company nothing upstream. */
export const LOCAL_ROUTES: readonly string[] = Object.freeze([
  'sample',
  'localai',
  'ollama',
  'aioncore',
]);

/**
 * Resolve who pays for one call.
 *
 * A local route short-circuits every other consideration: nothing left the
 * computer, so no allowance is debited and no company key was used, whatever
 * the organization's route says.
 */
export function payerForRoute(input: {
  route: string;
  organizationRoute: OrganizationRoute;
}): PayerResolution {
  if (LOCAL_ROUTES.includes(input.route))
    return {
      payer: 'local',
      debitsAllowance: false,
      reason: 'This ran on your computer, so no managed allowance was used.',
    };
  if (input.organizationRoute === 'personal-subscription')
    return {
      payer: 'refused',
      debitsAllowance: false,
      reason:
        'A personal subscription pays for one person, under that person’s terms. It is not company inventory, so company work is not run on it. Use the included managed allowance, or the company’s own provider key.',
    };
  if (input.organizationRoute === 'byo')
    return {
      payer: 'byo',
      debitsAllowance: false,
      reason:
        'This runs on the company’s own provider key. The provider bills the company directly and the included allowance is untouched.',
    };
  return { payer: 'managed', debitsAllowance: true };
}

// --- the reservation state machine --------------------------------------------

/**
 * Where a hold on money can be.
 *
 * `uncertain` is the state that earns this machine its existence. A request
 * whose response was lost may well have cost money upstream, so releasing its
 * hold and letting the caller retry would spend twice and count once. The hold
 * stays until reconciliation says what actually happened.
 */
export type ReservationState = 'pending' | 'settled' | 'released' | 'uncertain' | 'written-off';

export type ReservationEvent = 'settle' | 'release' | 'lose' | 'reconcile' | 'write-off';

const TERMINAL: readonly ReservationState[] = Object.freeze(['settled', 'released', 'written-off']);

/**
 * The only legal moves. Anything absent from this table is a bug in the caller,
 * and throwing is how it stops being a silent balance change.
 */
const TRANSITIONS: Readonly<Record<string, ReservationState>> = Object.freeze({
  'pending:settle': 'settled',
  'pending:release': 'released',
  'pending:lose': 'uncertain',
  'uncertain:reconcile': 'settled',
  'uncertain:write-off': 'written-off',
});

export function reservationTransition(
  from: ReservationState,
  event: ReservationEvent,
): ReservationState {
  if (TERMINAL.includes(from))
    throw new Error(`This reservation is already ${from}; it cannot be ${event}d again.`);
  const next = TRANSITIONS[`${from}:${event}`];
  if (next) return next;
  if (from === 'uncertain')
    throw new Error(
      'An uncertain reservation is settled or written off by reconciliation only. Releasing it would let a call that may already have cost money be retried for free.',
    );
  throw new Error(`A ${from} reservation cannot be ${event}d.`);
}

export const isTerminalReservation = (state: ReservationState): boolean => TERMINAL.includes(state);

// --- the durable records ------------------------------------------------------

/**
 * The shapes the ledger persists. They live in the contract rather than in the
 * service because the gateway, the routes, the renderer and the tests all read
 * them, and a record whose shape is defined by its writer is a record every
 * reader guesses at.
 *
 * Every record carries `organizationId`. There is no ambient tenant: a query
 * that forgot which company it was for would be the cross-tenant leak this
 * product cannot have, and requiring the field at the type level is cheaper
 * than remembering to check for it.
 */

/** One period's grant of included allowance. Allocated once, however many times
 *  the billing event that caused it arrives. */
export interface AllowancePeriod {
  readonly organizationId: string;
  /** Stable per billing period, e.g. `2026-09`. The allocation key. */
  readonly periodId: string;
  readonly planVersion: string;
  readonly rateCardVersion: string;
  readonly grantedMicroUsd: MicroUsd;
  readonly startsAt: string;
  readonly endsAt: string;
  readonly allocatedAt: string;
  /** The billing event that caused this allocation, so a duplicate is visibly a duplicate. */
  readonly sourceEventId: string;
}

/**
 * A hold placed before a call and resolved after it.
 *
 * `maxMicroUsd` is a conservative ceiling, not an estimate: it is what the
 * organization cannot spend elsewhere while this call is in flight. The whole
 * point of reserving the maximum is that two concurrent calls cannot each
 * assume the other will be cheap.
 */
export interface Reservation {
  readonly id: string;
  readonly organizationId: string;
  readonly periodId: string;
  /** The parent task whose envelope this also draws on. Children and retries
   *  reserve inside the same envelope rather than multiplying credit. */
  readonly parentTaskId: string | null;
  readonly kind: ChargeKind;
  readonly route: string;
  readonly payer: Payer;
  readonly maxMicroUsd: MicroUsd;
  readonly rateCardVersion: string;
  readonly state: ReservationState;
  readonly createdAt: string;
  readonly resolvedAt: string | null;
  /** Set when the state is `uncertain`: what is not yet known. */
  readonly uncertainReason: string | null;
}

/** What a resolved call actually cost, with the three quantities kept apart. */
export interface SettledCharge {
  readonly reservationId: string;
  readonly organizationId: string;
  readonly periodId: string;
  /** What the provider charged. Not necessarily what the allowance was debited. */
  readonly providerCostMicroUsd: MicroUsd;
  /** What came off the included allowance under this rate card. */
  readonly allowanceDebitMicroUsd: MicroUsd;
  readonly rateCardVersion: string;
  readonly eligibility: ChargeEligibility;
  readonly settledAt: string;
  /** Present when the provider reported the charge after the fact. */
  readonly reconciledFrom: 'response' | 'provider-report' | 'write-off';
}

export type AdjustmentReason =
  | 'upgrade'
  | 'refund'
  | 'proration'
  | 'chargeback'
  | 'service-grant'
  | 'correction';

/**
 * A change to a balance that is not a charge. History is never rewritten: an
 * upgrade, a refund and a chargeback each add a record, so the ledger can still
 * answer what the balance was on any past day.
 */
export interface AllowanceAdjustment {
  readonly id: string;
  readonly organizationId: string;
  readonly periodId: string;
  readonly reason: AdjustmentReason;
  readonly direction: 'grant' | 'withdraw';
  readonly amountMicroUsd: MicroUsd;
  readonly at: string;
  readonly note: string;
  readonly sourceEventId: string | null;
}

/** The numbers a person sees, and the three states they must not be shown as one. */
export interface AllowanceSummary {
  readonly organizationId: string;
  readonly periodId: string;
  readonly grantedMicroUsd: MicroUsd;
  /** Held for calls in flight. Not yet spent, and not available either. */
  readonly pendingMicroUsd: MicroUsd;
  /** Held for calls whose outcome is unknown. Deliberately not released. */
  readonly uncertainMicroUsd: MicroUsd;
  readonly settledMicroUsd: MicroUsd;
  /**
   * Grants and withdrawals are two figures rather than one net adjustment.
   * Money is non-negative here, so a net figure could not represent a
   * chargeback larger than the grants against it — and, worse, a single
   * "adjustments" number would let a withdrawal happen without appearing.
   */
  readonly grantsMicroUsd: MicroUsd;
  readonly withdrawalsMicroUsd: MicroUsd;
  /** granted + grants - withdrawals - settled - pending - uncertain. */
  readonly availableMicroUsd: MicroUsd;
  readonly exhausted: boolean;
  readonly rateCardVersion: string;
}

/**
 * What the allowance surface renders.
 *
 * `summary` is null wherever no entitlement exists, which is every build that
 * has not installed an entitlement service. A view carrying zeroes instead
 * would draw a balance, and a drawn balance of zero says "you have spent your
 * allowance" rather than "there is no allowance here" — the exact
 * simulated-paid-readiness this contract exists to prevent.
 */
export interface AllowanceView {
  readonly organizationId: string;
  readonly summary: AllowanceSummary | null;
  readonly available: boolean;
  /** Why not, when `available` is false. Never a guess about a future plan. */
  readonly unavailableReason: string;
  readonly meaning: typeof ALLOWANCE_MEANING;
  readonly rateCardVersion: string;
}

/**
 * The billing period an instant falls in: the calendar month, in UTC.
 *
 * A period id is what a grant is keyed on, so it must be derivable from a date
 * and nothing else. Anything installation-specific — a profile, a device, a
 * first-run timestamp — would let reinstalling mint a fresh period and with it
 * a fresh allowance.
 */
export function periodIdFor(at: string): string {
  const when = new Date(at);
  if (Number.isNaN(when.getTime())) throw new RangeError('That is not a time.');
  return `${when.getUTCFullYear()}-${String(when.getUTCMonth() + 1).padStart(2, '0')}`;
}
