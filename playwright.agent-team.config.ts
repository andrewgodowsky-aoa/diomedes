import { defineConfig } from '@playwright/test';

/** The built Team journey starts and closes its own real host with scripted transports. */
export default defineConfig({
  testDir: './tests',
  testMatch: ['agent-collaboration-ui.spec.ts', 'three-model-team-ui.spec.ts'],
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  expect: { timeout: 12_000 },
  reporter: [['list']],
  outputDir: 'test-results/agent-team-browser',
  use: {
    browserName: 'chromium',
    launchOptions: {
      executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH ??
        (process.platform === 'win32' ? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe' : undefined),
    },
    viewport: { width: 1440, height: 900 },
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
});
