import { describe, expect, test, vi } from 'vitest';
import {
  COVERAGE_ROUTE_KINDS,
  coverageMatrix,
  type CoverageCandidate,
  type CoverageFieldRow,
  type CoverageMatrix,
  type CoverageRoute,
  type CoverageWorkflow,
} from '../shared/data-coverage.js';
import {
  MONTH_END_ROUTES,
  MONTH_END_WORKFLOW,
  QBO_WEEKLY_EXPORT,
} from './fixtures/data-coverage/month-end-close.js';
import {
  NO_ACCESS_ROUTES,
  PARTIAL_ACCESS_ROUTES,
  RESTAURANT_ROUTES,
  RESTAURANT_WORKFLOW,
  SALES_SUMMARY_EMAIL,
  TOAST_STANDARD_API,
} from './fixtures/data-coverage/restaurant.js';

const NOW = '2026-09-26T12:00:00.000Z';
const TOAST_DOCUMENTATION_READ = '2026-09-09T00:00:00.000Z';
const UNKNOWN_FRESHNESS = { state: 'unknown', observedAt: null, staleAfterMs: null };

const matrixOf = (workflow: CoverageWorkflow, routes: readonly CoverageRoute[], now = NOW) =>
  coverageMatrix(workflow, routes, { now });

function row(matrix: CoverageMatrix, field: string): CoverageFieldRow {
  const found = matrix.fields.find((entry) => entry.field === field);
  if (!found) throw new Error(`No row for ${field}`);
  return found;
}

function candidate(matrix: CoverageMatrix, field: string, route: string): CoverageCandidate {
  const found = row(matrix, field).candidates.find((entry) => entry.route === route);
  if (!found) throw new Error(`${route} is not a candidate for ${field}`);
  return found;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

describe('DATA-01: the authorized data-coverage matrix', () => {
  test('Toast read-only customer route is considered before partner-only rejection.', () => {
    expect(COVERAGE_ROUTE_KINDS.indexOf('customer-api')).toBeLessThan(
      COVERAGE_ROUTE_KINDS.indexOf('partner-api'),
    );
    // The fixture declares the partner route first; reversing it changes nothing.
    for (const routes of [RESTAURANT_ROUTES, [...RESTAURANT_ROUTES].reverse()]) {
      const matrix = matrixOf(RESTAURANT_WORKFLOW, routes);
      expect(matrix.routes.map((entry) => entry.route)).toEqual([
        'toast-standard-api',
        'sales-summary-email',
        'toast-partner-integration',
        'toast-web-browser-export',
      ]);
      for (const field of ['daily-net-sales', 'menu-availability']) {
        expect(row(matrix, field).candidates[0]).toMatchObject({
          route: 'toast-standard-api',
          kind: 'customer-api',
          verdict: 'chosen',
          evidence: 'pending',
        });
        expect(row(matrix, field)).toMatchObject({
          route: 'toast-standard-api',
          evidence: 'pending',
          freshness: 'fresh',
        });
        const partner = candidate(matrix, field, 'toast-partner-integration');
        expect(partner).toMatchObject({ verdict: 'rejected', evidence: 'unavailable', refusedBy: ['access'] });
        expect(partner.reason).toBe(
          'Not available to this business. It needs a Toast partner or custom integration agreement, which this restaurant does not hold.',
        );
      }
      // The unavailable partner route rejects nothing the customer route covers.
      expect(matrix.status).toBe('pending');
      expect(matrix.missing).toEqual([]);
      expect(matrix.awaitingVerification).toEqual(['toast-standard-api']);
    }
  });

  test('A weekly export is rejected for a real-time requirement.', () => {
    const matrix = matrixOf(MONTH_END_WORKFLOW, MONTH_END_ROUTES);
    const weekly = candidate(matrix, 'cash-now', 'qbo-weekly-export');
    expect(weekly).toMatchObject({
      verdict: 'rejected',
      evidence: 'verified',
      freshness: 'stale',
      refusedBy: ['freshness'],
    });
    expect(weekly.reason).toBe('It refreshes every 7 days, but this field may be at most 15 minutes old.');
    expect(row(matrix, 'cash-now').route).toBeNull();
    // The same verified export meets the month-end needs and is chosen for them.
    for (const field of ['month-profit-and-loss', 'month-transactions']) {
      expect(row(matrix, field)).toMatchObject({
        route: 'qbo-weekly-export',
        evidence: 'verified',
        freshness: 'fresh',
      });
      expect(candidate(matrix, field, 'qbo-weekly-export')).toMatchObject({
        verdict: 'chosen',
        freshness: 'fresh',
        refusedBy: [],
      });
    }
  });

  test('Missing required field makes coverage incomplete.', () => {
    const matrix = matrixOf(MONTH_END_WORKFLOW, MONTH_END_ROUTES);
    expect(matrix.status).toBe('incomplete');
    expect(matrix.missing).toEqual([
      {
        field: 'cash-now',
        label: 'Cash in the operating account right now',
        howToProvide:
          'check the balance in your bank and type it, with the time you checked, into your message.',
      },
    ]);
    expect(matrix.missingOptional).toEqual([]);
    // Every other required field is verified: one missing required field is enough.
    expect(row(matrix, 'month-profit-and-loss').evidence).toBe('verified');
    expect(row(matrix, 'month-transactions').evidence).toBe('verified');

    // The same gap on an optional field does not change the status.
    const optional = matrixOf(
      {
        ...MONTH_END_WORKFLOW,
        fields: MONTH_END_WORKFLOW.fields.map((field) =>
          field.id === 'cash-now' ? { ...field, required: false } : field,
        ),
      },
      MONTH_END_ROUTES,
    );
    expect(optional.status).toBe('complete');
    expect(optional.missing).toEqual([]);
    expect(optional.missingOptional.map((gap) => gap.field)).toEqual(['cash-now']);
    const restaurant = matrixOf(RESTAURANT_WORKFLOW, RESTAURANT_ROUTES);
    expect(restaurant.missingOptional.map((gap) => gap.field)).toEqual(['ingredient-counts']);
    expect(restaurant.status).toBe('pending');
  });

  test('Fallback route does not expand data processing or permissions.', () => {
    const restaurant = matrixOf(RESTAURANT_WORKFLOW, RESTAURANT_ROUTES);
    // Permissions: the owner's back-office session reaches more than the approved read-only route.
    expect(candidate(restaurant, 'daily-net-sales', 'toast-web-browser-export')).toMatchObject({
      verdict: 'rejected',
      freshness: 'fresh',
      refusedBy: ['fallback-scope'],
      reason:
        "As a fallback for Toast Standard API access (read-only), it would add labour and guest contacts, beyond that route's approved scope. A fallback never widens what is read or where data goes.",
    });
    expect(candidate(restaurant, 'menu-availability', 'toast-web-browser-export').refusedBy).toEqual([
      'fallback-scope',
      'freshness',
    ]);
    // A fallback inside the primary's approved scope stays usable.
    expect(candidate(restaurant, 'daily-net-sales', 'sales-summary-email')).toMatchObject({
      verdict: 'usable',
      refusedBy: [],
      reason: 'Usable, but Toast Standard API access (read-only) comes first in the order.',
    });

    // Processing: a live balance that hands data to an aggregator is refused, although it is fresh enough.
    const monthEnd = matrixOf(MONTH_END_WORKFLOW, MONTH_END_ROUTES);
    expect(candidate(monthEnd, 'cash-now', 'bank-aggregator-feed')).toMatchObject({
      verdict: 'rejected',
      freshness: 'fresh',
      refusedBy: ['fallback-scope'],
      reason:
        "As a fallback for Weekly QuickBooks Online report exports, it would add every linked bank and card account and a bank-data aggregator, beyond that route's approved scope. A fallback never widens what is read or where data goes.",
    });
    expect(row(monthEnd, 'cash-now').route).toBeNull();

    // With the primary down, the in-scope fallback serves what it reads and nothing more.
    const primaryDown = matrixOf(RESTAURANT_WORKFLOW, [
      { ...TOAST_STANDARD_API, access: { status: 'unavailable', detail: 'Its credentials were revoked.' } },
      SALES_SUMMARY_EMAIL,
    ]);
    expect(row(primaryDown, 'daily-net-sales')).toMatchObject({ route: 'sales-summary-email', evidence: 'pending' });
    expect(row(primaryDown, 'menu-availability').route).toBeNull();

    // A fallback whose primary is not declared has nothing to bound it.
    const orphan = matrixOf(RESTAURANT_WORKFLOW, [SALES_SUMMARY_EMAIL]);
    expect(candidate(orphan, 'daily-net-sales', 'sales-summary-email')).toMatchObject({
      verdict: 'rejected',
      refusedBy: ['fallback-scope'],
      reason:
        'It is declared as a fallback for toast-standard-api, which is not declared, so nothing bounds what it may reach.',
    });
  });

  test('unknown stays unknown', () => {
    const restaurant = matrixOf(RESTAURANT_WORKFLOW, RESTAURANT_ROUTES);
    const counts = row(restaurant, 'ingredient-counts');
    // Toast reads the same kind of data (menu stock) but not this field, so it is not a candidate.
    expect(row(restaurant, 'menu-availability').need).toBe(counts.need);
    expect(counts).toMatchObject({
      route: null,
      evidence: 'unavailable',
      evidenceAgeMs: null,
      freshness: 'unknown',
      candidates: [],
      cost: 'None: no route is chosen.',
      detail:
        'Unknown. No usable route reads this field, so nothing is filled in and no record is assumed to exist or to be missing.',
    });
    expect(counts.evidenceFreshness).toEqual(UNKNOWN_FRESHNESS);

    // With every route inaccessible, nothing is borrowed from them.
    const none = matrixOf(RESTAURANT_WORKFLOW, NO_ACCESS_ROUTES);
    for (const entry of none.fields) {
      expect(entry).toMatchObject({ route: null, evidence: 'unavailable', evidenceAgeMs: null, freshness: 'unknown' });
      expect(entry.evidenceFreshness).toEqual(UNKNOWN_FRESHNESS);
      expect(entry.candidates.every((option) => option.verdict === 'rejected')).toBe(true);
      // A row describes coverage only; it has nowhere to carry a value or a record count.
      expect(Object.keys(entry).sort()).toEqual([
        'access',
        'candidates',
        'cost',
        'detail',
        'effects',
        'evidence',
        'evidenceAgeMs',
        'evidenceFreshness',
        'field',
        'freshness',
        'label',
        'need',
        'required',
        'route',
        'sourceOfTruth',
        'staleAfterMs',
      ]);
    }
    // The refused Toast route still reports its own documentation age; no field inherits it.
    expect(none.routes.find((entry) => entry.route === 'toast-standard-api')).toMatchObject({
      evidence: 'unavailable',
      evidenceAgeMs: Date.parse(NOW) - Date.parse(TOAST_DOCUMENTATION_READ),
      chosenFor: [],
    });
    expect(none.routes.every((entry) => entry.chosenFor.length === 0)).toBe(true);
  });

  test('a narrower alternative is offered only when fully covered, and a plain decline otherwise', () => {
    // Partial access: the verified sales export covers the narrower version, so it is offered.
    const partial = matrixOf(RESTAURANT_WORKFLOW, PARTIAL_ACCESS_ROUTES);
    expect(partial.status).toBe('incomplete');
    expect(partial.missing.map((gap) => gap.field)).toEqual(['menu-availability']);
    expect(row(partial, 'daily-net-sales')).toMatchObject({ route: 'daily-sales-export', evidence: 'verified' });
    expect(partial.narrower).toEqual({
      id: 'morning-sales-summary',
      title: 'Morning sales summary',
      value: "Yesterday's net sales by location, without the stock check or the reorder draft.",
      requires: ['daily-net-sales'],
      leavesOut: ['menu-availability', 'ingredient-counts'],
      reason:
        'Offered instead of Daily sales and stock check: every field it needs has a verified route. It leaves out Menu items out of stock or running low at each location and On-hand ingredient counts from the last stock count.',
    });
    expect(partial.decline).toBeNull();

    const monthEnd = matrixOf(MONTH_END_WORKFLOW, MONTH_END_ROUTES);
    expect(monthEnd.narrower).toMatchObject({ id: 'close-checklist', leavesOut: ['cash-now'] });
    expect(monthEnd.decline).toBeNull();

    // Covered only by pending evidence is not fully covered: the Toast fixture gets a decline.
    const pending = matrixOf(RESTAURANT_WORKFLOW, RESTAURANT_ROUTES);
    expect(row(pending, 'daily-net-sales').route).toBe('toast-standard-api');
    expect(pending.narrower).toBeNull();
    expect(pending.decline).toBe(
      'Not offered as automated yet: it depends on Toast Standard API access (read-only), which is not verified. No narrower version is fully covered either.',
    );

    // No access: nothing covers even the narrower version.
    const none = matrixOf(RESTAURANT_WORKFLOW, NO_ACCESS_ROUTES);
    expect(none.status).toBe('incomplete');
    expect(none.narrower).toBeNull();
    expect(none.decline).toBe(
      'Not offered as automated: no usable route reads Net sales by location for yesterday and Menu items out of stock or running low at each location, and nothing is filled in for them. No narrower version is fully covered either.',
    );

    // A complete workflow needs neither.
    const complete = matrixOf(
      {
        ...MONTH_END_WORKFLOW,
        fields: MONTH_END_WORKFLOW.fields.filter((field) => field.id !== 'cash-now'),
      },
      MONTH_END_ROUTES,
    );
    expect(complete.status).toBe('complete');
    expect(complete.narrower).toBeNull();
    expect(complete.decline).toBeNull();
  });

  test('brand names in field labels stay as declared in a decline and a narrower offer', () => {
    const workflow: CoverageWorkflow = {
      ...RESTAURANT_WORKFLOW,
      fields: RESTAURANT_WORKFLOW.fields.map((field) => field.id === 'menu-availability'
        ? { ...field, label: 'Toast tips' } : field),
    };
    expect(matrixOf(workflow, NO_ACCESS_ROUTES).decline).toContain('Toast tips');
    expect(matrixOf(workflow, PARTIAL_ACCESS_ROUTES).narrower?.reason).toContain('Toast tips');
  });

  test('a route is verified only on current validated evidence', () => {
    // Documentation never verifies, however recent: the Toast fixture stays pending.
    const restaurant = matrixOf(RESTAURANT_WORKFLOW, RESTAURANT_ROUTES);
    expect(row(restaurant, 'daily-net-sales')).toMatchObject({
      evidence: 'pending',
      evidenceAgeMs: Date.parse(NOW) - Date.parse(TOAST_DOCUMENTATION_READ),
      evidenceFreshness: { state: 'fresh', observedAt: TOAST_DOCUMENTATION_READ },
    });
    // Even once the route is set up, documentation alone does not verify it.
    const setUpButDocumented = matrixOf(RESTAURANT_WORKFLOW, [
      { ...TOAST_STANDARD_API, access: { status: 'granted', detail: 'Read-only credentials exist.' } },
    ]);
    expect(row(setUpButDocumented, 'daily-net-sales')).toMatchObject({
      route: 'toast-standard-api',
      evidence: 'pending',
      evidenceFreshness: { state: 'fresh' },
    });
    expect(setUpButDocumented.status).toBe('pending');

    // The export check counts for 14 days; judged later it is stale, so the route is only pending.
    const later = matrixOf(MONTH_END_WORKFLOW, MONTH_END_ROUTES, '2026-10-20T12:00:00.000Z');
    expect(row(later, 'month-profit-and-loss')).toMatchObject({
      route: 'qbo-weekly-export',
      evidence: 'pending',
      evidenceFreshness: { state: 'stale' },
    });
    expect(later.awaitingVerification).toEqual(['qbo-weekly-export']);
    expect(later.narrower).toBeNull();
    expect(later.decline).toBe(
      'Not offered as automated: no usable route reads Cash in the operating account right now, and nothing is filled in for it; it depends on Weekly QuickBooks Online report exports, which is not verified. No narrower version is fully covered either.',
    );

    // Validated evidence on a route that is not set up for this business does not verify it.
    const notSetUp = matrixOf(MONTH_END_WORKFLOW, [
      { ...QBO_WEEKLY_EXPORT, access: { status: 'available', detail: 'The owner has not started the exports.' } },
    ]);
    expect(row(notSetUp, 'month-profit-and-loss').evidence).toBe('pending');
    // An unparseable time is unknown, never current.
    const badTime = matrixOf(MONTH_END_WORKFLOW, MONTH_END_ROUTES, 'not a time');
    expect(row(badTime, 'month-profit-and-loss')).toMatchObject({
      evidence: 'pending',
      evidenceAgeMs: null,
      evidenceFreshness: { state: 'unknown' },
    });
  });

  test('purity: the same input gives the same output, and the input is not mutated', () => {
    const cases: [CoverageWorkflow, readonly CoverageRoute[]][] = [
      [RESTAURANT_WORKFLOW, RESTAURANT_ROUTES],
      [RESTAURANT_WORKFLOW, NO_ACCESS_ROUTES],
      [RESTAURANT_WORKFLOW, PARTIAL_ACCESS_ROUTES],
      [MONTH_END_WORKFLOW, MONTH_END_ROUTES],
    ];
    for (const [workflow, routes] of cases) {
      const before = JSON.stringify({ workflow, routes });
      const frozenWorkflow = deepFreeze(structuredClone(workflow));
      const frozenRoutes = deepFreeze(structuredClone(routes));
      vi.useFakeTimers();
      try {
        // Different wall clocks, one `now`: the answer depends only on its inputs.
        vi.setSystemTime(new Date('2031-01-01T00:00:00.000Z'));
        const first = matrixOf(frozenWorkflow, frozenRoutes);
        vi.setSystemTime(new Date('2019-06-01T00:00:00.000Z'));
        const second = matrixOf(frozenWorkflow, frozenRoutes);
        expect(second).toEqual(first);
        expect(matrixOf(workflow, routes)).toEqual(first);
      } finally {
        vi.useRealTimers();
      }
      expect(JSON.stringify({ workflow: frozenWorkflow, routes: frozenRoutes })).toBe(before);
      expect(JSON.stringify({ workflow, routes })).toBe(before);
    }
  });

  test('duplicate field or route ids are refused rather than guessed between', () => {
    expect(() =>
      matrixOf({ ...RESTAURANT_WORKFLOW, fields: [...RESTAURANT_WORKFLOW.fields, RESTAURANT_WORKFLOW.fields[0]] }, []),
    ).toThrow('Duplicate field id: daily-net-sales.');
    expect(() => matrixOf(RESTAURANT_WORKFLOW, [TOAST_STANDARD_API, TOAST_STANDARD_API])).toThrow(
      'Duplicate route id: toast-standard-api.',
    );
  });
});
