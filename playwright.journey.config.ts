import { defineConfig } from '@playwright/test';

/**
 * The completion journey: fresh install to a reviewed, verified change that survives a restart of
 * the local service. The spec starts, stops and restarts its own service process, so this config
 * has no webServer and never touches the shared suite's ports (5174 and 47632). It is kept out of
 * `playwright.config.ts`, whose explicit testMatch list does not name it.
 *
 * Run with `npm run test:journey` after `npx vite build`: the service serves the built `dist/`.
 */
export default defineConfig({
  testDir: './tests',
  testMatch: ['completion-journey.spec.ts'],
  fullyParallel: false,
  workers: 1,
  timeout: 180_000,
  expect: { timeout: 15_000 },
  reporter: [['list']],
  outputDir: 'test-results/journey',
  use: {
    browserName: 'chromium',
    launchOptions: {
      executablePath:
        process.env.PLAYWRIGHT_EXECUTABLE_PATH ??
        (process.platform === 'win32'
          ? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
          : undefined),
    },
    viewport: { width: 1440, height: 900 },
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
});
