/**
 * The A6 acceptance pass, kept out of the gates on purpose.
 *
 * `tests/a6-acceptance.spec.ts` records a dated walk through the Design Center
 * and measures what it costs on the machine it runs on. Timings and CPU samples
 * are properties of a host, not of the code, so they must not be able to fail a
 * gate on someone else's computer — and its screenshots are evidence of one run
 * rather than an assertion. It reuses the main config entirely, including the
 * dev server, the fresh data directory and the entitlement fixture, and changes
 * only which files are collected.
 *
 *     npx playwright test --config playwright.acceptance.config.ts
 */
import base from './playwright.config';

export default {
  ...base,
  testMatch: ['a6-acceptance.spec.ts'],
};
