/**
 * The buy flow on the Usage screen (Andrew, 2026-10-01, DIO-161 slice 2).
 *
 * The flow is a plain controller so it can be driven without a browser: it asks the desktop for a
 * quote, starts a purchase, hands the payment page to an opener, then follows the purchase until it is
 * paid, expired or failed. The client never prices an amount: every total here is what a stubbed
 * quote route said, and the tests make the stub say odd figures to prove it. Every figure is invented.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../client/api';
import {
  POLL_SLOW_AFTER_MS,
  POLL_FAST_MS,
  QUOTE_DELAY_MS,
  checkoutOriginFor,
  createPurchaseFlow,
  formatUsd,
  type FlowState,
} from '../client/console/credit-purchase-flow';

const ORG = 'org_a';
const base = `/workspace/organizations/${ORG}/allowance/credit-purchases`;
const STRIPE_URL = 'https://checkout.stripe.com/c/pay/cs_test_a1B2c3';
const FAUX_URL = `http://127.0.0.1:5199/faux/checkout/cs_faux_${'a1b2c3d4'.repeat(3)}`;

type Call = { path: string; method: string; body: unknown };

/** A desktop that quotes `cents` per 100 credits (an invented figure), and walks a purchase through `states`. */
function desktop(options: { centsPer100?: number; checkoutUrl?: string; states?: string[]; failStart?: unknown } = {}) {
  const calls: Call[] = [];
  const states = [...(options.states ?? ['pending', 'paid'])];
  let last = 'pending';
  const read = vi.fn(async (path: string, method = 'GET', body?: unknown) => {
    calls.push({ path, method, body });
    if (method === 'GET' && path.startsWith(`${base}/quote?credits=`)) {
      const credits = Number(path.split('=')[1]);
      return { credits, amountCents: (credits / 100) * (options.centsPer100 ?? 1200), currency: 'usd' };
    }
    if (method === 'POST' && path === base) {
      if (options.failStart) throw options.failStart;
      const credits = (body as { credits: number }).credits;
      return {
        purchaseId: 'cp_0123456789abcdef',
        checkoutUrl: options.checkoutUrl ?? STRIPE_URL,
        credits,
        amountCents: (credits / 100) * (options.centsPer100 ?? 1200),
      };
    }
    if (method === 'GET' && path === `${base}/cp_0123456789abcdef`) {
      last = states.length > 0 ? states.shift()! : last;
      return { purchaseId: 'cp_0123456789abcdef', credits: 1000, amountCents: 12000, state: last };
    }
    throw new Error(`unexpected ${method} ${path}`);
  });
  return { read, calls };
}

function flowFor(d: ReturnType<typeof desktop>) {
  const opened: string[] = [];
  const paid = vi.fn();
  const flow = createPurchaseFlow({
    organizationId: ORG,
    read: d.read as never,
    open: (url) => opened.push(url),
    onPaid: paid,
  });
  const seen: FlowState[] = [];
  flow.subscribe((state) => seen.push(state));
  return { flow, opened, paid, seen };
}

const settle = () => vi.advanceTimersByTimeAsync(0);

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('the quote', () => {
  it('asks for a quote of the starting amount once, and shows exactly what the desktop answered', async () => {
    const d = desktop({ centsPer100: 999 });
    const { flow } = flowFor(d);
    flow.start();
    await settle();
    expect(d.calls.map((c) => `${c.method} ${c.path}`)).toEqual([`GET ${base}/quote?credits=1000`]);
    // 999 cents per hundred is nothing the client could have worked out: it only shows the answer.
    expect(flow.getState().quote).toEqual({ state: 'ready', credits: 1000, amountCents: 9990 });
    expect(flow.getState().input).toBe('1000');
  });

  it('waits out typing: several edits in a row make one request, for the last amount', async () => {
    const d = desktop();
    const { flow } = flowFor(d);
    flow.start();
    await settle();
    d.calls.length = 0;
    for (const text of ['2', '20', '200', '2000', '2500']) {
      flow.setInput(text);
      await vi.advanceTimersByTimeAsync(QUOTE_DELAY_MS / 4);
    }
    expect(d.calls).toEqual([]);
    expect(flow.getState().quote.state).toBe('loading');
    await vi.advanceTimersByTimeAsync(QUOTE_DELAY_MS);
    expect(d.calls.map((c) => c.path)).toEqual([`${base}/quote?credits=2500`]);
    expect(flow.getState().quote).toEqual({ state: 'ready', credits: 2500, amountCents: 30000 });
  });

  it.each(['', '  ', '0', '50', '150', '12x', '1e3', '-100', '100.5', '100100', '1000000000000000000000'])(
    'asks nothing for %j and says what an amount can be',
    async (text) => {
      const d = desktop();
      const { flow } = flowFor(d);
      flow.start();
      await settle();
      d.calls.length = 0;
      flow.setInput(text);
      await vi.advanceTimersByTimeAsync(QUOTE_DELAY_MS * 3);
      expect(d.calls).toEqual([]);
      const quote = flow.getState().quote;
      expect(quote.state).toBe('invalid');
      expect(quote.state === 'invalid' && quote.message).toBe('Enter 100 credits or more, in steps of 100, up to 100,000.');
      // And Buy does nothing without a quote.
      await flow.buy();
      expect(d.calls).toEqual([]);
    },
  );

  it('drops a quote that arrives after the amount has changed', async () => {
    const answers: Array<(value: unknown) => void> = [];
    const read = vi.fn((path: string) => new Promise((resolve) => answers.push((v) => resolve(v))));
    const flow = createPurchaseFlow({ organizationId: ORG, read: read as never, open: () => {}, onPaid: () => {} });
    flow.start(); // quote for 1000, in flight
    flow.setInput('300');
    await vi.advanceTimersByTimeAsync(QUOTE_DELAY_MS); // quote for 300, in flight
    expect(read).toHaveBeenCalledTimes(2);
    answers[1]!({ credits: 300, amountCents: 3600, currency: 'usd' });
    await settle();
    answers[0]!({ credits: 1000, amountCents: 12000, currency: 'usd' });
    await settle();
    expect(flow.getState().quote).toEqual({ state: 'ready', credits: 300, amountCents: 3600 });
  });

  it('refuses a quote for a different amount than the one asked', async () => {
    const read = vi.fn(async () => ({ credits: 900, amountCents: 100, currency: 'usd' }));
    const flow = createPurchaseFlow({ organizationId: ORG, read: read as never, open: () => {}, onPaid: () => {} });
    flow.start();
    await settle();
    expect(flow.getState().quote.state).toBe('unavailable');
    await flow.buy();
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('says plainly when the desktop refuses, and when it cannot be reached', async () => {
    const refused = vi.fn(async () => {
      throw new ApiError('Buying credits isn’t available right now. Try again later.', 503, {});
    });
    const a = createPurchaseFlow({ organizationId: ORG, read: refused as never, open: () => {}, onPaid: () => {} });
    a.start();
    await settle();
    expect(a.getState().quote).toEqual({ state: 'unavailable', message: 'Buying credits isn’t available right now. Try again later.' });

    const down = vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    });
    const b = createPurchaseFlow({ organizationId: ORG, read: down as never, open: () => {}, onPaid: () => {} });
    b.start();
    await settle();
    expect(b.getState().quote).toEqual({ state: 'unavailable', message: 'Buying credits isn’t available right now.' });
  });
});

describe('buying', () => {
  it('starts a purchase with the credits alone, opens the payment page once, and waits', async () => {
    const d = desktop();
    const { flow, opened } = flowFor(d);
    flow.start();
    await settle();
    await Promise.all([flow.buy(), flow.buy()]); // a second press while one is starting does nothing
    const posts = d.calls.filter((c) => c.method === 'POST');
    expect(posts).toEqual([{ path: base, method: 'POST', body: { credits: 1000 } }]);
    expect(opened).toEqual([STRIPE_URL]);
    expect(flow.getState().purchase).toEqual({
      phase: 'waiting',
      purchaseId: 'cp_0123456789abcdef',
      credits: 1000,
      amountCents: 12000,
      checkoutUrl: STRIPE_URL,
    });
  });

  it('opens the local test service payment page when that is the service answering', async () => {
    const d = desktop({ checkoutUrl: FAUX_URL });
    const { flow, opened } = flowFor(d);
    flow.start();
    await settle();
    await flow.buy();
    expect(opened).toEqual([FAUX_URL]);
  });

  it.each([
    'https://evil.example/pay',
    'https://checkout.stripe.com.evil.example/c/pay/x',
    'http://checkout.stripe.com/c/pay/x',
    'https://user:pw@checkout.stripe.com/c/pay/x',
    'javascript:alert(1)',
    'http://127.0.0.1:5199/anything',
    'http://example.com/faux/checkout/cs_faux_' + 'a1b2c3d4'.repeat(3),
    '',
  ])('never opens %j, says so, and does not follow the purchase', async (checkoutUrl) => {
    const d = desktop({ checkoutUrl });
    const { flow, opened } = flowFor(d);
    flow.start();
    await settle();
    await flow.buy();
    expect(opened).toEqual([]);
    const purchase = flow.getState().purchase;
    expect(purchase).toEqual({ phase: 'error', message: 'That payment page can’t be opened from here. Try again in a moment.' });
    d.calls.length = 0;
    await vi.advanceTimersByTimeAsync(POLL_FAST_MS * 5);
    expect(d.calls).toEqual([]);
  });

  it('shows the desktop’s own plain words when starting is refused', async () => {
    const d = desktop({ failStart: new ApiError('Only an owner or an admin can buy credits for this business.', 403, {}) });
    const { flow, opened } = flowFor(d);
    flow.start();
    await settle();
    await flow.buy();
    expect(opened).toEqual([]);
    expect(flow.getState().purchase).toEqual({ phase: 'error', message: 'Only an owner or an admin can buy credits for this business.' });
  });

  it('holds the amount while a purchase is waiting, and lets it be changed after', async () => {
    const d = desktop({ states: ['pending', 'pending', 'pending'] });
    const { flow } = flowFor(d);
    flow.start();
    await settle();
    await flow.buy();
    flow.setInput('500');
    expect(flow.getState().input).toBe('1000');
    flow.reset();
    expect(flow.getState().purchase).toEqual({ phase: 'idle' });
    flow.setInput('500');
    expect(flow.getState().input).toBe('500');
  });
});

describe('following the purchase', () => {
  it('polls until paid, then stops, says so once, and refreshes the balance once', async () => {
    const d = desktop({ states: ['pending', 'pending', 'paid'] });
    const { flow, paid } = flowFor(d);
    flow.start();
    await settle();
    await flow.buy();
    const reads = () => d.calls.filter((c) => c.path === `${base}/cp_0123456789abcdef`).length;
    expect(reads()).toBe(0);
    await vi.advanceTimersByTimeAsync(POLL_FAST_MS);
    expect(reads()).toBe(1);
    expect(flow.getState().purchase.phase).toBe('waiting');
    await vi.advanceTimersByTimeAsync(POLL_FAST_MS * 2);
    expect(reads()).toBe(3);
    expect(flow.getState().purchase).toEqual({ phase: 'paid', credits: 1000, amountCents: 12000 });
    expect(paid).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(POLL_FAST_MS * 20);
    expect(reads()).toBe(3);
    expect(paid).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['expired', 'expired'],
    ['failed', 'failed'],
  ] as const)('stops on %s without refreshing anything', async (state, phase) => {
    const d = desktop({ states: ['pending', state] });
    const { flow, paid } = flowFor(d);
    flow.start();
    await settle();
    await flow.buy();
    await vi.advanceTimersByTimeAsync(POLL_FAST_MS * 2);
    expect(flow.getState().purchase).toEqual({ phase });
    d.calls.length = 0;
    await vi.advanceTimersByTimeAsync(POLL_FAST_MS * 20);
    expect(d.calls).toEqual([]);
    expect(paid).not.toHaveBeenCalled();
  });

  it('slows down after a couple of minutes', async () => {
    const d = desktop({ states: Array(1000).fill('pending') });
    const { flow } = flowFor(d);
    flow.start();
    await settle();
    await flow.buy();
    await vi.advanceTimersByTimeAsync(POLL_SLOW_AFTER_MS + POLL_FAST_MS);
    const before = d.calls.length;
    await vi.advanceTimersByTimeAsync(POLL_FAST_MS * 3);
    expect(d.calls.length - before).toBeLessThanOrEqual(1);
    flow.dispose();
  });

  it('stops asking when the person stops waiting, and after it is disposed', async () => {
    const d = desktop({ states: Array(1000).fill('pending') });
    const { flow } = flowFor(d);
    flow.start();
    await settle();
    await flow.buy();
    flow.reset();
    d.calls.length = 0;
    await vi.advanceTimersByTimeAsync(POLL_FAST_MS * 5);
    expect(d.calls).toEqual([]);

    await flow.buy();
    flow.dispose();
    d.calls.length = 0;
    await vi.advanceTimersByTimeAsync(POLL_FAST_MS * 5);
    expect(d.calls).toEqual([]);
  });

  it('keeps asking through a hiccup and gives up, in plain words, if it keeps failing', async () => {
    let failing = true;
    const read = vi.fn(async (path: string, method = 'GET') => {
      if (path.includes('/quote?')) return { credits: 1000, amountCents: 12000, currency: 'usd' };
      if (method === 'POST') return { purchaseId: 'cp_0123456789abcdef', checkoutUrl: STRIPE_URL, credits: 1000, amountCents: 12000 };
      if (failing) throw new TypeError('Failed to fetch');
      return { purchaseId: 'cp_0123456789abcdef', credits: 1000, amountCents: 12000, state: 'paid' };
    });
    const flow = createPurchaseFlow({ organizationId: ORG, read: read as never, open: () => {}, onPaid: () => {} });
    flow.start();
    await settle();
    await flow.buy();
    await vi.advanceTimersByTimeAsync(POLL_FAST_MS * 2);
    expect(flow.getState().purchase.phase).toBe('waiting');
    failing = false;
    await vi.advanceTimersByTimeAsync(POLL_FAST_MS);
    expect(flow.getState().purchase.phase).toBe('paid');

    failing = true;
    const again = createPurchaseFlow({ organizationId: ORG, read: read as never, open: () => {}, onPaid: () => {} });
    again.start();
    await settle();
    await again.buy();
    await vi.advanceTimersByTimeAsync(POLL_FAST_MS * 10);
    expect(again.getState().purchase).toEqual({ phase: 'error', message: 'The payment can’t be checked right now.' });
  });
});

describe('small helpers', () => {
  it('shows a total as dollars and cents, from cents it was given', () => {
    expect(formatUsd(12000)).toBe('$120.00');
    expect(formatUsd(9990)).toBe('$99.90');
    expect(formatUsd(5)).toBe('$0.05');
    expect(formatUsd(123456789)).toBe('$1,234,567.89');
  });

  it('trusts a local test page only on a loopback address', () => {
    expect(checkoutOriginFor(FAUX_URL)).toBe('http://127.0.0.1:5199');
    expect(checkoutOriginFor('http://localhost:3000/faux/checkout/x')).toBe('http://localhost:3000');
    expect(checkoutOriginFor('https://example.com/faux/checkout/x')).toBeNull();
    expect(checkoutOriginFor('not a url')).toBeNull();
  });
});
