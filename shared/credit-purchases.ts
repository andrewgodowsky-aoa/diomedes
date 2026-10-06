/**
 * Buying credits (DIO-161 slice 1): the numbers and answers the account service and the desktop agree on.
 *
 * Credits are bought in whole steps. What a step is, and what it costs, is the account service's own setting for the
 * business's plan, never a figure in this repository: a client asks for a quote and shows the total and the step it is given. The
 * desktop takes the step from the quote (asking with no amount quotes one step), so it never works a price or a step out. The only
 * bound shared here is the most one purchase can be, so a screen can refuse an amount no service would take.
 */

/** The most credits one purchase can be. An engineering cap, held under what a single card charge can be. */
export const CREDIT_PURCHASE_MAX_CREDITS = 100_000;

/**
 * Whether an amount of credits can be asked for at all: a positive whole number inside the cap. Whether it is a whole number of the
 * business's steps is the account service's to say, from the step in its quote.
 */
export function isAskableCredits(credits: unknown): credits is number {
  return typeof credits === 'number' && Number.isSafeInteger(credits) && credits >= 1 && credits <= CREDIT_PURCHASE_MAX_CREDITS;
}

/**
 * Whether a payment page is one this app may open. Only Stripe's own hosted checkout, over https, and, when the
 * account service is the local test one, that service's own checkout page on its own origin. A link in an answer
 * is data, not an instruction: anything else, a look-alike host or a credential in the address included, is refused.
 */
export function isAllowedCheckoutUrl(value: unknown, localCheckoutOrigin: string | null): boolean {
  if (typeof value !== 'string' || value.length > 4096) return false;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.username !== '' || url.password !== '') return false;
  if (url.protocol === 'https:' && url.hostname === 'checkout.stripe.com' && url.port === '') return true;
  return localCheckoutOrigin !== null && url.origin === localCheckoutOrigin && /^\/faux\/checkout\/cs_faux_[a-z0-9]{24}$/.test(url.pathname);
}

/** What an amount of credits costs, as the account service quotes it, and the step it is bought in. The only place a price is shown. */
export interface CreditQuote {
  credits: number;
  /** The total, in US cents. */
  amountCents: number;
  currency: 'usd';
  /** How many whole steps the amount is. */
  steps: number;
  /** One step: `stepCredits` credits for `stepCents` cents. The amount is a whole number of these, and the next amount up is one more. */
  stepCredits: number;
  stepCents: number;
  /** Whether the payer buys at the plan rate: a business on a plan, or a person with an Individual plan of their own. */
  onPlan: boolean;
  /**
   * For a payer without a plan, one step at the plan rate, a public price, so a screen can say what the same money buys on a
   * plan. Null on a plan, and when the service has no usable plan rate.
   */
  planStep: { credits: number; cents: number } | null;
}

/** The buy box's headline is this many steps: at the published rates, "$130 buys 1,000 credits" and "$100 buys 1,100 credits". */
export const HEADLINE_STEPS = 10;

/** A purchase just started: where to pay, which the client opens, and what it is for. */
export interface CreditPurchaseStarted {
  purchaseId: string;
  /** Stripe's own checkout page, or the local test one in the test service. Nothing else is ever sent. */
  checkoutUrl: string;
  credits: number;
  amountCents: number;
}

export type CreditPurchaseState = 'pending' | 'paid' | 'expired' | 'failed';

/** A purchase as it stands: the buyer reads it until it is paid. */
export interface CreditPurchaseStatus {
  purchaseId: string;
  credits: number;
  amountCents: number;
  state: CreditPurchaseState;
}
