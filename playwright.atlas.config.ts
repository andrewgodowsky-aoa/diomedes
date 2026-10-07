import { defineConfig } from '@playwright/test';
import base from './playwright.config';

/**
 * The reskin atlas (DIO-252): the main config's server and browser, running only
 * `tests/reskin-atlas.spec.ts`. Set RESKIN_ATLAS to the folder the shots go to.
 *
 * RESKIN_BOARD_SCALE=1 shoots each screen as the round 2 boards draw it: a window 1280 wide at
 * 1.125 device pixels, the boards' 18px root to the app's 16px. Each picture is then 1440 by 900,
 * the size of its board, and the two line up pixel for pixel.
 */
const boardScale = process.env.RESKIN_BOARD_SCALE
  ? { viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1.125 }
  : {};

export default defineConfig({
  ...base,
  testMatch: ['reskin-atlas.spec.ts'],
  outputDir: 'test-results/atlas',
  reporter: [['list']],
  // A control the atlas cannot find costs one shot, not the test's whole budget.
  use: { ...base.use, ...boardScale, actionTimeout: 8_000, navigationTimeout: 20_000 },
});
