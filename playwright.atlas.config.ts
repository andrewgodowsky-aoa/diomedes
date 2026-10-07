import { defineConfig } from '@playwright/test';
import base from './playwright.config';

/**
 * The reskin atlas (DIO-252): the main config's server and browser, running only
 * `tests/reskin-atlas.spec.ts`. Set RESKIN_ATLAS to the folder the shots go to.
 */
export default defineConfig({
  ...base,
  testMatch: ['reskin-atlas.spec.ts'],
  outputDir: 'test-results/atlas',
  reporter: [['list']],
  // A control the atlas cannot find costs one shot, not the test's whole budget.
  use: { ...base.use, actionTimeout: 8_000, navigationTimeout: 20_000 },
});
