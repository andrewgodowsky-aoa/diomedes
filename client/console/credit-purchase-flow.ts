import { ApiError } from '../api';
import {
  CREDIT_PURCHASE_MAX_CREDITS,
  isAllowedCheckoutUrl,
  isAskableCredits,
  type CreditPurchaseStarted,
  type CreditPurchaseStatus,
  type CreditQuote,
} from '../../shared/credit-purchases';

/**
 * Buying credits from the Usage screen, as a plain controller the screen draws from.
 *
 * It asks the desktop for a quote of an amount, starts a purchase, hands the payment page to an
 * opener, then follows the purchase until it is paid, expired or failed. It never works out a price:
 * the total it holds is the one the quote route answered, for the amount that was asked. Nor does it
 * know the step credits are bought in: it asks for a quote with no amount, which is one step, and takes
 * the step from that answer (a business with a plan buys in a different step than one without). It never
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
/** What the amount field starts at before the step is known, and the amount it rounds down to a whole step once it is. */
export const START_CREDITS = '1000';

/** One step as the account service quoted it: this many credits for this many cents. */
export interface CreditStep {
  credits: number;
  cents: number;
}

/** The starting amount at a step: about START_CREDITS, in whole steps, and at least one. */
export const startCreditsFor = (step: number): number => Math.max(1, Math.floor(Number(START_CREDITS) / step)) * step;

/** The most credits one purchase can be at a step: whole steps, held under the cap. */
export const maxCreditsFor = (step: number): number => Math.floor(CREDIT_PURCHASE_MAX_CREDITS / step) * step;

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
  /** The step credits are bought in, from the last quote the service answered. Null until there is one. */
  step: CreditStep | null;
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

/** What an amount can be, in the step the service quoted (or, before there is one, only that it is a whole number inside the cap). */
const invalidMessage = (step: number | null) =>
  step === null
    ? `Enter a whole number of credits, up to ${CREDIT_PURCHASE_MAX_CREDITS.toLocaleString('en-US')}.`
    : `Enter ${step.toLocaleString('en-US')} credits or more, in steps of ${step.toLocaleString('en-US')}, up to ${maxCreditsFor(step).toLocaleString('en-US')}.`;
const QUOTE_UNAVAILABLE = 'Buying credits isn’t available right now.';
const START_FAILED = 'The payment couldn’t be started. Try again in a moment.';
const PAGE_REFUSED = 'That payment page can’t be opened from here. Try again in a moment.';
const CANT_CHECK = 'The payment can’t be checked right now.';
const SIGN_IN = 'Sign in to buy credits.';

/**
 * The text of an amount field as an amount of credits, or null when it is not one that can be bought. With a step it must be a whole
 * number of steps; without one (no quote has answered yet) any amount inside the cap is asked for and the service says if it is a step.
 */
export function parseCredits(text: string, step: number | null = null): number | null {
  const trimmed = text.trim();
  if (!/^[0-9]{1,9}$/.test(trimmed)) return null;
  const credits = Number(trimmed);
  if (!isAskableCredits(credits)) return null;
  return step === null || credits % step === 0 ? credits : null;
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

/** A quote for the amount asked (or, asked with no amount, for one step), whose total is whole steps of the step it names. */
const isQuote = (value: unknown, asked: number | null): value is CreditQuote => {
  if (typeof value !== 'object' || value === null) return false;
  const quote = value as CreditQuote;
  const whole = [quote.credits, quote.amountCents, quote.steps, quote.stepCredits, quote.stepCents].every((part) => Number.isSafeInteger(part) && part > 0);
  return (
    whole &&
    (asked === null || quote.credits === asked) &&
    quote.credits === quote.steps * quote.stepCredits &&
    quote.amountCents === quote.steps * quote.stepCents
  );
};

const isStarted = (value: unknown): value is CreditPurchaseStarted =>
  typeof value === 'object' &&
  value !== null &&
  typeof (value as CreditPurchaseStarted).purchaseId === 'string' &&
  typeof (value as CreditPurchaseStarted).checkoutUrl === 'string' &&
  Number.isSafeInteger((value as CreditPurchaseStarted).credits) &&
  Number.isSafeInteger((value as CreditPurchaseStarted).amountCents);

export function createPurchaseFlow(deps: PurchaseFlowDeps) {
  const base = `/workspace/organizations/${encodeURIComponent(deps.organizationId)}/allowance/credit-purchases`;
  let state: FlowState = { input: START_CREDITS, quote: { state: 'loading' }, purchase: { phase: 'idle' }, step: null };
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

  /** A quote of an amount, or, with none, of one step: how a screen learns the step before it asks for more. */
  const askForQuote = async (credits: number | null) => {
    const seq = ++quoteSeq;
    try {
      const answer = await deps.read<unknown>(credits === null ? `${base}/quote` : `${base}/quote?credits=${credits}`);
      if (disposed || seq !== quoteSeq) return;
      if (!isQuote(answer, credits)) {
        set({ quote: { state: 'unavailable', message: QUOTE_UNAVAILABLE } });
        return;
      }
      const step = { credits: answer.stepCredits, cents: answer.stepCents };
      if (credits === null) {
        // The step is known: start at about 1,000 credits, in whole steps.
        const start = startCreditsFor(step.credits);
        if (start === answer.credits) set({ step, input: String(start), quote: { state: 'ready', credits: start, amountCents: answer.amountCents } });
        else {
          set({ step, input: String(start), quote: { state: 'loading' } });
          void askForQuote(start);
        }
        return;
      }
      set({ step, quote: { state: 'ready', credits, amountCents: answer.amountCents } });
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

    /** Asks for one step's quote to learn the step, then for a quote of the starting amount in whole steps. */
    start() {
      void askForQuote(null);
    },

    /** The amount field changed. Held while a payment is starting or waiting. */
    setInput(text: string) {
      if (disposed || state.purchase.phase === 'starting' || state.purchase.phase === 'waiting') return;
      clearTimeout(quoteTimer);
      quoteSeq += 1;
      const credits = parseCredits(text, state.step?.credits ?? null);
      if (credits === null) {
        set({ input: text, quote: { state: 'invalid', message: invalidMessage(state.step?.credits ?? null) } });
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
