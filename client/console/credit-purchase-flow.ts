import { ApiError } from '../api';
import {
  CREDIT_PURCHASE_MAX_CREDITS,
  CREDIT_PURCHASE_MIN_CREDITS,
  CREDIT_PURCHASE_STEP,
  isAllowedCheckoutUrl,
  isPurchasableCredits,
  type CreditPurchaseStarted,
  type CreditPurchaseStatus,
  type CreditQuote,
} from '../../shared/credit-purchases';

/**
 * Buying credits from the Usage screen, as a plain controller the screen draws from.
 *
 * It asks the desktop for a quote of an amount, starts a purchase, hands the payment page to an
 * opener, then follows the purchase until it is paid, expired or failed. It never works out a price:
 * the total it holds is the one the quote route answered, for the amount that was asked. It never
 * opens an address the desktop has not already vetted: a payment page that is not the processor's own
 * (or, in the test service, the local test one) is refused here as well, and nothing is opened.
 */

/** Typing waits this long before a quote is asked for. */
export const QUOTE_DELAY_MS = 400;
/** A purchase is read this often at first, then less often once it has clearly taken a while. */
export const POLL_FAST_MS = 3_000;
export const POLL_SLOW_MS = 10_000;
export const POLL_SLOW_AFTER_MS = 120_000;
/** Reads in a row that may fail before the flow stops following the purchase. */
const POLL_FAILURES_ALLOWED = 5;
/** What the amount field starts at. */
export const START_CREDITS = '1000';

export type QuoteView =
  | { state: 'loading' }
  | { state: 'ready'; credits: number; amountCents: number }
  | { state: 'invalid'; message: string }
  | { state: 'unavailable'; message: string };

export type PurchaseView =
  | { phase: 'idle' }
  | { phase: 'starting' }
  | { phase: 'waiting'; purchaseId: string; credits: number; amountCents: number; checkoutUrl: string }
  | { phase: 'paid'; credits: number; amountCents: number }
  | { phase: 'expired' }
  | { phase: 'failed' }
  | { phase: 'error'; message: string };

export interface FlowState {
  /** The amount field's text, as typed. */
  input: string;
  quote: QuoteView;
  purchase: PurchaseView;
}

export interface PurchaseFlowDeps {
  organizationId: string;
  /** The app's own `api` call: a path under `/api`, a method and a body. */
  read<T>(path: string, method?: string, body?: unknown): Promise<T>;
  /** Opens a payment page the flow has already checked. */
  open(url: string): void;
  /** The balance has changed: read it again. Called once per paid purchase. */
  onPaid(): void;
}

const INVALID_MESSAGE = `Enter ${CREDIT_PURCHASE_MIN_CREDITS} credits or more, in steps of ${CREDIT_PURCHASE_STEP}, up to ${CREDIT_PURCHASE_MAX_CREDITS.toLocaleString('en-US')}.`;
const QUOTE_UNAVAILABLE = 'Buying credits isn’t available right now.';
const START_FAILED = 'The payment couldn’t be started. Try again in a moment.';
const PAGE_REFUSED = 'That payment page can’t be opened from here. Try again in a moment.';
const CANT_CHECK = 'The payment can’t be checked right now.';
const SIGN_IN = 'Sign in to buy credits.';

/** The text of an amount field as an amount of credits, or null when it is not one that can be bought. */
export function parseCredits(text: string): number | null {
  const trimmed = text.trim();
  if (!/^[0-9]{1,9}$/.test(trimmed)) return null;
  const credits = Number(trimmed);
  return isPurchasableCredits(credits) ? credits : null;
}

/** A total in cents, shown as dollars. Display only: the amount in cents is always the service's. */
export function formatUsd(cents: number): string {
  return (cents / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' });
}

/**
 * Where the account service's own test page can be: on this computer, or at the in-process test address the
 * host's test mode uses. The desktop trusts the same two (it names the origin of the service it is talking to),
 * so a page it answers is never refused here for being somewhere it approved.
 */
const LOCAL_TEST_HOSTS = ['127.0.0.1', 'localhost', '[::1]', 'faux.local'];

/**
 * The origin a payment page may be trusted on when it is the account service's own test page. Anything else
 * has none, and only the processor's own address passes.
 */
export function checkoutOriginFor(value: string): string | null {
  try {
    const url = new URL(value);
    return LOCAL_TEST_HOSTS.includes(url.hostname) ? url.origin : null;
  } catch {
    return null;
  }
}

/** The service's own plain sentence when it gave one; otherwise ours. */
function plain(error: unknown, fallback: string): string {
  if (error instanceof ApiError) {
    if (error.status === 401) return SIGN_IN;
    if (error.message) return error.message;
  }
  return fallback;
}

const isQuote = (value: unknown, asked: number): value is CreditQuote =>
  typeof value === 'object' &&
  value !== null &&
  (value as CreditQuote).credits === asked &&
  Number.isSafeInteger((value as CreditQuote).amountCents) &&
  (value as CreditQuote).amountCents >= 0;

const isStarted = (value: unknown): value is CreditPurchaseStarted =>
  typeof value === 'object' &&
  value !== null &&
  typeof (value as CreditPurchaseStarted).purchaseId === 'string' &&
  typeof (value as CreditPurchaseStarted).checkoutUrl === 'string' &&
  Number.isSafeInteger((value as CreditPurchaseStarted).credits) &&
  Number.isSafeInteger((value as CreditPurchaseStarted).amountCents);

export function createPurchaseFlow(deps: PurchaseFlowDeps) {
  const base = `/workspace/organizations/${encodeURIComponent(deps.organizationId)}/allowance/credit-purchases`;
  let state: FlowState = { input: START_CREDITS, quote: { state: 'loading' }, purchase: { phase: 'idle' } };
  const listeners = new Set<(next: FlowState) => void>();
  let disposed = false;
  let quoteTimer: ReturnType<typeof setTimeout> | undefined;
  let quoteSeq = 0;
  let pollTimer: ReturnType<typeof setTimeout> | undefined;
  let pollSeq = 0;
  let failures = 0;
  let followingSince = 0;

  const set = (patch: Partial<FlowState>) => {
    if (disposed) return;
    state = { ...state, ...patch };
    for (const listener of [...listeners]) listener(state);
  };

  const askForQuote = async (credits: number) => {
    const seq = ++quoteSeq;
    try {
      const answer = await deps.read<unknown>(`${base}/quote?credits=${credits}`);
      if (disposed || seq !== quoteSeq) return;
      if (!isQuote(answer, credits)) {
        set({ quote: { state: 'unavailable', message: QUOTE_UNAVAILABLE } });
        return;
      }
      set({ quote: { state: 'ready', credits, amountCents: answer.amountCents } });
    } catch (error) {
      if (disposed || seq !== quoteSeq) return;
      set({ quote: { state: 'unavailable', message: plain(error, QUOTE_UNAVAILABLE) } });
    }
  };

  const stopPolling = () => {
    pollSeq += 1;
    clearTimeout(pollTimer);
    pollTimer = undefined;
  };

  const schedulePoll = (purchaseId: string) => {
    const seq = pollSeq;
    const wait = Date.now() - followingSince < POLL_SLOW_AFTER_MS ? POLL_FAST_MS : POLL_SLOW_MS;
    pollTimer = setTimeout(() => void poll(purchaseId, seq), wait);
  };

  const giveUp = () => set({ purchase: { phase: 'error', message: CANT_CHECK } });

  const poll = async (purchaseId: string, seq: number) => {
    let status: unknown;
    try {
      status = await deps.read<unknown>(`${base}/${encodeURIComponent(purchaseId)}`);
    } catch (error) {
      if (disposed || seq !== pollSeq) return;
      failures += 1;
      const settled = error instanceof ApiError && [401, 403, 404].includes(error.status);
      if (settled || failures >= POLL_FAILURES_ALLOWED) giveUp();
      else schedulePoll(purchaseId);
      return;
    }
    if (disposed || seq !== pollSeq) return;
    const read = status as Partial<CreditPurchaseStatus> | null;
    if (!read || typeof read !== 'object' || read.purchaseId !== purchaseId) {
      failures += 1;
      if (failures >= POLL_FAILURES_ALLOWED) giveUp();
      else schedulePoll(purchaseId);
      return;
    }
    failures = 0;
    if (read.state === 'paid') {
      const waiting = state.purchase.phase === 'waiting' ? state.purchase : null;
      set({
        purchase: {
          phase: 'paid',
          credits: Number.isSafeInteger(read.credits) ? read.credits! : (waiting?.credits ?? 0),
          amountCents: Number.isSafeInteger(read.amountCents) ? read.amountCents! : (waiting?.amountCents ?? 0),
        },
      });
      deps.onPaid();
    } else if (read.state === 'expired') set({ purchase: { phase: 'expired' } });
    else if (read.state === 'failed') set({ purchase: { phase: 'failed' } });
    else schedulePoll(purchaseId);
  };

  return {
    getState: () => state,
    subscribe(listener: (next: FlowState) => void) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },

    /** Asks for a quote of the starting amount. */
    start() {
      void askForQuote(Number(START_CREDITS));
    },

    /** The amount field changed. Held while a payment is starting or waiting. */
    setInput(text: string) {
      if (disposed || state.purchase.phase === 'starting' || state.purchase.phase === 'waiting') return;
      clearTimeout(quoteTimer);
      quoteSeq += 1;
      const credits = parseCredits(text);
      if (credits === null) {
        set({ input: text, quote: { state: 'invalid', message: INVALID_MESSAGE } });
        return;
      }
      set({ input: text, quote: { state: 'loading' } });
      quoteTimer = setTimeout(() => void askForQuote(credits), QUOTE_DELAY_MS);
    },

    /** Buy what the quote is for. Does nothing without a total, or while another purchase is under way. */
    async buy() {
      if (disposed || state.purchase.phase !== 'idle' || state.quote.state !== 'ready') return;
      const credits = state.quote.credits;
      set({ purchase: { phase: 'starting' } });
      let started: unknown;
      try {
        started = await deps.read<unknown>(base, 'POST', { credits });
      } catch (error) {
        set({ purchase: { phase: 'error', message: plain(error, START_FAILED) } });
        return;
      }
      if (disposed) return;
      if (!isStarted(started)) {
        set({ purchase: { phase: 'error', message: START_FAILED } });
        return;
      }
      // A link in an answer is data. Only the processor's own page, or the test service's on this computer, is opened.
      if (!isAllowedCheckoutUrl(started.checkoutUrl, checkoutOriginFor(started.checkoutUrl))) {
        set({ purchase: { phase: 'error', message: PAGE_REFUSED } });
        return;
      }
      deps.open(started.checkoutUrl);
      failures = 0;
      followingSince = Date.now();
      set({
        purchase: {
          phase: 'waiting',
          purchaseId: started.purchaseId,
          credits: started.credits,
          amountCents: started.amountCents,
          checkoutUrl: started.checkoutUrl,
        },
      });
      stopPolling();
      schedulePoll(started.purchaseId);
    },

    /** Stop waiting, or start over after a purchase has ended. The amount and its total stay. */
    reset() {
      if (disposed) return;
      stopPolling();
      set({ purchase: { phase: 'idle' } });
    },

    dispose() {
      disposed = true;
      clearTimeout(quoteTimer);
      stopPolling();
      listeners.clear();
    },
  };
}

export type PurchaseFlow = ReturnType<typeof createPurchaseFlow>;
