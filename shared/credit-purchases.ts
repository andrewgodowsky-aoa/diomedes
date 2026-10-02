/**
 * Buying credits (DIO-161 slice 1): the numbers and answers the account service and the desktop agree on.
 *
 * Credits are bought in whole steps of 100. What they cost is the account service's own setting, never a
 * figure in this repository: a client asks for a quote and shows the total it is given. These bounds only
 * say which amounts can be asked for at all, so a screen can step through them and the service can refuse
 * the rest.
 */

/** Credits are bought in whole steps of this many. */
export const CREDIT_PURCHASE_STEP = 100;
/** The fewest credits one purchase can be. */
export const CREDIT_PURCHASE_MIN_CREDITS = 100;
/** The most credits one purchase can be. An engineering cap, held under what a single card charge can be. */
export const CREDIT_PURCHASE_MAX_CREDITS = 100_000;

/** Whether an amount of credits can be asked for: a whole multiple of the step, inside the bounds. */
export function isPurchasableCredits(credits: unknown): credits is number {
  return (
    typeof credits === 'number' &&
    Number.isSafeInteger(credits) &&
    credits >= CREDIT_PURCHASE_MIN_CREDITS &&
    credits <= CREDIT_PURCHASE_MAX_CREDITS &&
    credits % CREDIT_PURCHASE_STEP === 0
  );
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

/** What an amount of credits costs, as the account service quotes it. The only place a price is shown. */
export interface CreditQuote {
  credits: number;
  /** The total, in US cents. */
  amountCents: number;
  currency: 'usd';
}

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
