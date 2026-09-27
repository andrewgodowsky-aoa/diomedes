/**
 * Synthetic data-coverage fixtures for a three-location restaurant that runs
 * Toast: fixture (a), and the no-access and partial-access fixtures (c).
 *
 * The Toast facts here come from docs/connections/RESEARCH.md, which records
 * documentation read on 2026-09-09, and from server/connections/toast.ts.
 * Neither is evidence of an authenticated Toast account, and the manifest
 * says no real vendor access was verified, so every Toast route carries
 * documented evidence and stays pending. That the Standard API route reads
 * yesterday's sales is this fixture's declaration, awaiting that
 * verification: the repository's research covers stock and access
 * requirements only. The other routes, their evidence and their costs are
 * declarations for the planner, not vendor facts or prices.
 */
import type {
  CoverageRoute,
  CoverageRouteAccess,
  CoverageWorkflow,
} from '../../../shared/data-coverage.js';

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const UPLOAD = 'add it to this project in Files (Import)';

export const RESTAURANT_WORKFLOW: CoverageWorkflow = {
  id: 'restaurant-daily-sales-and-stock',
  title: 'Daily sales and stock check',
  fields: [
    {
      id: 'daily-net-sales',
      label: 'Net sales by location for yesterday',
      required: true,
      need: 'read-sales',
      staleAfterMs: DAY,
      sourceOfTruth: 'Toast point of sale',
      effects: ['Morning sales summary'],
      access: ['sales'],
      howToProvide: `export yesterday's sales summary from your point of sale as CSV and ${UPLOAD}.`,
    },
    {
      id: 'menu-availability',
      label: 'Menu items out of stock or running low at each location',
      required: true,
      need: 'read-inventory',
      // The Toast receiver refuses to act on observations older than five minutes (RESEARCH.md).
      staleAfterMs: 5 * MINUTE,
      sourceOfTruth: 'Toast menu stock',
      effects: ['Items to restock or take off the menu today'],
      access: ['menu stock'],
      howToProvide: 'connect a live read of your menu stock; a daily export is too old for this check.',
    },
    {
      id: 'ingredient-counts',
      label: 'On-hand ingredient counts from the last stock count',
      required: false,
      // The same kind of data as menu availability, which is exactly why kind-level matching misleads.
      need: 'read-inventory',
      staleAfterMs: 7 * DAY,
      sourceOfTruth: "The kitchen's weekly stock count",
      effects: ['Reorder quantities in the supplier draft'],
      access: ['ingredient counts'],
      howToProvide: `type your latest count into a spreadsheet and ${UPLOAD}.`,
    },
  ],
  narrower: [
    {
      id: 'morning-sales-summary',
      title: 'Morning sales summary',
      value: "Yesterday's net sales by location, without the stock check or the reorder draft.",
      requires: ['daily-net-sales'],
    },
  ],
};

const TOAST_DOCUMENTATION_READ = '2026-09-09T00:00:00.000Z';

/** Fixture (a): the customer's own read-only route. Documented, not verified (toast.ts: no real vendor access verified). */
export const TOAST_STANDARD_API: CoverageRoute = {
  id: 'toast-standard-api',
  kind: 'customer-api',
  name: 'Toast Standard API access (read-only)',
  reads: ['daily-net-sales', 'menu-availability'],
  scopes: ['sales', 'menu stock'],
  access: {
    status: 'available',
    detail: 'The restaurant can create read-only Standard API credentials for its own approved locations.',
  },
  requirements: [
    'RMS Essentials or above.',
    'An eligible employee with Manage Integrations permission creates the credentials.',
    'Credentials are read only and scoped to approved locations; stock:write is never requested.',
    'Production only: Standard API access has no sandbox.',
  ],
  refreshEveryMs: 0,
  cost: 'No partner agreement is needed. Any Toast charge for this access is not recorded here.',
  evidence: {
    basis: 'documented',
    evidenceId: 'toast-standard-api-documentation',
    source:
      'docs/connections/RESEARCH.md, documentation read 2026-09-09; server/connections/toast.ts records no real vendor access verified',
    observedAt: TOAST_DOCUMENTATION_READ,
    staleAfterMs: 30 * DAY,
  },
};

/** Fixture (a): a partner-only route this restaurant cannot use. */
export const TOAST_PARTNER_INTEGRATION: CoverageRoute = {
  id: 'toast-partner-integration',
  kind: 'partner-api',
  name: 'Toast partner integration',
  reads: ['daily-net-sales', 'menu-availability'],
  scopes: ['sales', 'menu stock'],
  access: {
    status: 'unavailable',
    detail: 'It needs a Toast partner or custom integration agreement, which this restaurant does not hold.',
  },
  requirements: ['A Toast partner or custom integration agreement.'],
  refreshEveryMs: 0,
  cost: 'Partner program terms, not recorded here.',
  evidence: {
    basis: 'documented',
    evidenceId: 'toast-integration-types-documentation',
    source: 'docs/connections/RESEARCH.md, integration types, documentation read 2026-09-09',
    observedAt: TOAST_DOCUMENTATION_READ,
    staleAfterMs: 30 * DAY,
  },
};

/** A fallback inside the Standard API route's approved scope: it reads sales and nothing else. */
export const SALES_SUMMARY_EMAIL: CoverageRoute = {
  id: 'sales-summary-email',
  kind: 'email-files',
  name: 'Nightly sales summary email to the owner',
  reads: ['daily-net-sales'],
  scopes: ['sales'],
  access: { status: 'granted', detail: 'The owner authorized reading messages from this one sender.' },
  requirements: ['The owner keeps receiving the nightly summary at the authorized address.'],
  refreshEveryMs: DAY,
  cost: "No charge. It reads one sender's messages in the owner's mailbox.",
  evidence: null,
  fallbackFor: 'toast-standard-api',
};

/** A fallback that would widen permissions: the owner's back-office session reaches far more than sales. */
export const TOAST_WEB_BROWSER_EXPORT: CoverageRoute = {
  id: 'toast-web-browser-export',
  kind: 'browser-assisted',
  name: 'Browser-assisted export from Toast Web as the owner',
  reads: ['daily-net-sales', 'menu-availability'],
  scopes: ['sales', 'menu stock', 'labour', 'guest contacts'],
  access: {
    status: 'available',
    detail: 'The owner permits browser-assisted work in their own Toast Web session.',
  },
  requirements: ["The owner's signed-in Toast Web session.", 'Someone present to answer sign-in prompts.'],
  refreshEveryMs: DAY,
  cost: "The owner's session time each day. No charge is recorded here.",
  evidence: null,
  fallbackFor: 'toast-standard-api',
};

/**
 * Fixture (a). Declared partner first on purpose: evaluation order is the
 * planner's, not the declaration's.
 */
export const RESTAURANT_ROUTES: readonly CoverageRoute[] = [
  TOAST_PARTNER_INTEGRATION,
  TOAST_WEB_BROWSER_EXPORT,
  SALES_SUMMARY_EMAIL,
  TOAST_STANDARD_API,
];

const BELOW_REQUIRED_PLAN: CoverageRouteAccess = {
  status: 'unavailable',
  detail: "This restaurant's Toast plan is below RMS Essentials, so Standard API credentials cannot be created.",
};

/** Fixture (c), no access: neither Toast route is usable and nothing else is declared. */
export const NO_ACCESS_ROUTES: readonly CoverageRoute[] = [
  { ...TOAST_STANDARD_API, access: BELOW_REQUIRED_PLAN },
  TOAST_PARTNER_INTEGRATION,
];

/** Fixture (c), partial access: a verified daily sales export, and nothing live for menu stock. */
export const DAILY_SALES_EXPORT: CoverageRoute = {
  id: 'daily-sales-export',
  kind: 'report-export',
  name: 'Daily sales CSV added in Files',
  reads: ['daily-net-sales'],
  scopes: ['sales'],
  access: {
    status: 'granted',
    detail: 'The manager exports the sales summary each morning and adds it in Files.',
  },
  requirements: [
    'A manager who can run the sales summary report.',
    'Each export is added to this project in Files (Import).',
  ],
  refreshEveryMs: DAY,
  cost: "The manager's time, a few minutes each morning.",
  evidence: {
    basis: 'validated',
    evidenceId: 'files-import-2026-09-26-sales',
    source: "Files import of this morning's sales CSV, all three locations present (synthetic)",
    observedAt: '2026-09-26T07:30:00.000Z',
    staleAfterMs: 2 * DAY,
  },
};

export const PARTIAL_ACCESS_ROUTES: readonly CoverageRoute[] = [
  { ...TOAST_STANDARD_API, access: BELOW_REQUIRED_PLAN },
  TOAST_PARTNER_INTEGRATION,
  DAILY_SALES_EXPORT,
];
