/**
 * The included usage a subscription buys, in the unit it is sold in.
 *
 * Andrew's decision of 2026-09-19, recorded in the pricing authority, the
 * roadmap and the project memory: the published unit is a count of requests and
 * never a dollar figure. A buyer can check "how many requests did we send"
 * against their own month; they cannot check a dollar figure against anything.
 * The per-request ceiling and the monthly bound stay internal.
 *
 * That decision only holds if the two halves cannot drift apart, so the
 * arithmetic tying them together is pinned here: the published count multiplied
 * by the internal per-request ceiling is exactly the internal monthly bound. If
 * someone later raises the count without raising the bound, or tightens the
 * ceiling without cutting the count, this test fails rather than the company
 * quietly promising more than it priced.
 *
 * Every figure here is read from the contract, not restated from a document.
 */
import { describe, expect, test } from 'vitest';
import {
  ALLOWANCE_MEANING,
  MANAGED_PLAN_CANDIDATE,
  MICRO_PER_USD,
  dollars,
  formatMoney,
} from '../shared/managed-usage.js';

describe('the candidate plan', () => {
  test('publishes its included usage as a count of requests', () => {
    expect(MANAGED_PLAN_CANDIDATE.includedRequests).toBe(1_000);
  });

  test('bounds a single request internally, so one request cannot spend the month', () => {
    expect(MANAGED_PLAN_CANDIDATE.perRequestCeilingMicroUsd).toBe(dollars(0.1));
  });

  test('cannot let the published count and the internal bound disagree', () => {
    // The pricing authority states the identity outright: 1,000 requests at the
    // ceiling is exactly the monthly bound. Holding it here means a change to
    // either half has to be a deliberate change to both.
    expect(
      MANAGED_PLAN_CANDIDATE.includedRequests * MANAGED_PLAN_CANDIDATE.perRequestCeilingMicroUsd,
    ).toBe(MANAGED_PLAN_CANDIDATE.includedAllowanceMicroUsd);
  });

  test('keeps its internal figures internal by staying unsellable', () => {
    // The dollar figures exist so the ledger has a shape to be built against.
    // They are not an offer, and nothing in this build can turn them into one.
    expect(MANAGED_PLAN_CANDIDATE.sellable).toBe(false);
    expect(MANAGED_PLAN_CANDIDATE.status).toBe('candidate');
  });

  test('still records the internal monthly bound, because the ledger meters money', () => {
    expect(MANAGED_PLAN_CANDIDATE.includedAllowanceMicroUsd).toBe(100 * MICRO_PER_USD);
  });
});

describe('what a customer is told managed access is', () => {
  test('leads with the request count, which is the unit it is sold in', () => {
    expect(ALLOWANCE_MEANING).toMatch(/request/i);
  });

  test('states no dollar amount anywhere, which is the whole of the decision', () => {
    expect(ALLOWANCE_MEANING).not.toMatch(/\$/);
    expect(ALLOWANCE_MEANING).not.toMatch(/\bUSD\b/);
    expect(ALLOWANCE_MEANING).not.toMatch(/\bdollars?\b/i);
  });

  test('says a request counts once however many model calls it takes', () => {
    expect(ALLOWANCE_MEANING).toMatch(/counts once|once however many/i);
  });

  test('keeps every negative, because each one names an assumption that would be wrong', () => {
    for (const negative of [
      /not withdrawable/i,
      /not credit on a provider account/i,
      /not .*token/i,
      /not a guaranteed number of jobs/i,
    ])
      expect(ALLOWANCE_MEANING).toMatch(negative);
  });

  test('does not promise unlimited use', () => {
    expect(ALLOWANCE_MEANING).not.toMatch(/unlimited/i);
  });
});

describe('the internal figures, when something does render one', () => {
  test('still format as money, because the ledger is still denominated in it', () => {
    // Nothing customer-facing publishes this. It is the internal bound, and the
    // formatter that draws it has to keep working for the accounting screens.
    expect(formatMoney(MANAGED_PLAN_CANDIDATE.perRequestCeilingMicroUsd)).toMatch(/0\.10/);
  });
});

/**
 * A helper call is work done inside a request, not another request.
 *
 * This matters more than it looks. If an internal evaluation were counted, the
 * product would be charging a customer for its own decision to consult a second
 * model - the count they were sold would shrink for a reason they cannot see or
 * control, and the cheaper route would look more expensive than the one it
 * replaced. The sentence below is the commitment; nothing counts requests yet,
 * so it is a promise the copy makes and the code cannot break, which is exactly
 * why it is worth pinning before anything starts counting.
 */
describe('a helper consulted inside a request', () => {
  test('is covered by the sentence that says a request counts once', () => {
    expect(ALLOWANCE_MEANING).toMatch(/counts once however many model calls it takes to finish/);
  });

  test('cannot be re-read as per-call billing', () => {
    expect(ALLOWANCE_MEANING).not.toMatch(/per (model )?call/i);
    expect(ALLOWANCE_MEANING).not.toMatch(/each model call/i);
    expect(ALLOWANCE_MEANING).not.toMatch(/\bper request\b/i);
  });

  test('is still one request when the count is what is sold', () => {
    // The unit sold is the request. A plan that sold model calls would have to
    // say so here, and would then be counting the product's own choices.
    expect(MANAGED_PLAN_CANDIDATE.includedRequests).toBeGreaterThan(0);
    expect(ALLOWANCE_MEANING).toMatch(/a set number of requests/);
  });
});
