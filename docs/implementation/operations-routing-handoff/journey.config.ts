import { defineConfig } from '@playwright/test';

// Both apps must be built from this candidate before this serialized, disposable journey.
// The spec starts its own loopback servers. It uses no production identity or provider.
export default defineConfig({
  testDir: '../../../tests', testMatch: 'operations-routing-journey.spec.ts',
  workers: 1, fullyParallel: false, timeout: 90_000,
  expect: { timeout: 15_000 },
  outputDir: '../../../test-results/operations-routing-browser',
  reporter: [['list']],
  use: { browserName: 'chromium', headless: true, viewport: { width: 1440, height: 1000 }, trace: 'retain-on-failure' },
});
