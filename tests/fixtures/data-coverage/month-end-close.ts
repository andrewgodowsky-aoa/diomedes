/**
 * Synthetic data-coverage fixture (b): a landscaping company's month-end
 * close, backed by QuickBooks Online reports the owner exports once a week.
 *
 * The pair that discriminates the freshness rule: the same weekly export
 * passes the month-end fields and fails the one real-time field. The export
 * route, its evidence and the aggregator route are declarations for the
 * planner, not vendor facts or prices.
 */
import type { CoverageRoute, CoverageWorkflow } from '../../../shared/data-coverage.js';

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const UPLOAD = 'add it to this project in Files (Import)';

export const MONTH_END_WORKFLOW: CoverageWorkflow = {
  id: 'month-end-close-with-cash-check',
  title: 'Month-end close with a same-day cash check',
  fields: [
    {
      id: 'month-profit-and-loss',
      label: 'Profit and loss for the month being closed',
      required: true,
      need: 'read-accounting',
      // A month-end need: the export only has to fall within the month being closed.
      staleAfterMs: 31 * DAY,
      sourceOfTruth: 'QuickBooks Online',
      effects: ['Close checklist', 'Note to the bookkeeper'],
      access: ['accounting reports'],
      howToProvide: `export the month's profit and loss report and ${UPLOAD}.`,
    },
    {
      id: 'month-transactions',
      label: 'Transactions for the month with their categories',
      required: true,
      need: 'read-accounting',
      staleAfterMs: 31 * DAY,
      sourceOfTruth: 'QuickBooks Online',
      effects: ['Uncategorised transactions list'],
      access: ['accounting transactions'],
      howToProvide: `export the month's transaction list and ${UPLOAD}.`,
    },
    {
      id: 'cash-now',
      label: 'Cash in the operating account right now',
      required: true,
      need: 'read-bank',
      // A real-time need: a balance older than fifteen minutes cannot decide what is safe to pay today.
      staleAfterMs: 15 * MINUTE,
      sourceOfTruth: 'The bank',
      effects: ['Bills that are safe to pay today'],
      access: ['account balances'],
      howToProvide: 'check the balance in your bank and type it, with the time you checked, into your message.',
    },
  ],
  narrower: [
    {
      id: 'close-checklist',
      title: 'Month-end close checklist',
      value: "The close checklist and the note to the bookkeeper from the month's reports, without the same-day cash check.",
      requires: ['month-profit-and-loss', 'month-transactions'],
    },
  ],
};

/** The weekly export: verified by a checked Files import five days before the fixture's now. */
export const QBO_WEEKLY_EXPORT: CoverageRoute = {
  id: 'qbo-weekly-export',
  kind: 'report-export',
  name: 'Weekly QuickBooks Online report exports',
  reads: ['month-profit-and-loss', 'month-transactions', 'cash-now'],
  scopes: ['accounting reports', 'accounting transactions', 'account balances'],
  access: {
    status: 'granted',
    detail: 'The owner runs and exports these reports from their own QuickBooks Online company.',
  },
  requirements: [
    'A QuickBooks Online user who can run and export reports.',
    'Each export is added to this project in Files (Import).',
  ],
  refreshEveryMs: 7 * DAY,
  cost: "The owner's time, a few minutes each week. No new subscription or connector.",
  evidence: {
    basis: 'validated',
    evidenceId: 'files-import-2026-09-21-qbo',
    source: 'Files import of the 2026-09-21 QuickBooks Online exports, columns checked (synthetic)',
    observedAt: '2026-09-21T16:00:00.000Z',
    staleAfterMs: 14 * DAY,
  },
};

/**
 * A live fallback for the balance that would widen both permissions and
 * processing: every linked account, and a third party that receives the data.
 */
export const BANK_AGGREGATOR_FEED: CoverageRoute = {
  id: 'bank-aggregator-feed',
  kind: 'partner-api',
  name: 'Live bank balance through a bank-data aggregator',
  reads: ['cash-now'],
  scopes: ['account balances', 'every linked bank and card account', 'a bank-data aggregator'],
  access: { status: 'available', detail: 'The owner could link the bank through an aggregator sign-in.' },
  requirements: [
    "The owner links each bank account through the aggregator's sign-in.",
    "The aggregator's terms cover this business.",
  ],
  refreshEveryMs: 0,
  cost: 'An aggregator subscription. No price is recorded here.',
  evidence: null,
  fallbackFor: 'qbo-weekly-export',
};

export const MONTH_END_ROUTES: readonly CoverageRoute[] = [QBO_WEEKLY_EXPORT, BANK_AGGREGATOR_FEED];
