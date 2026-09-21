import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  testMatch: ['inventory-receipt-ui.spec.ts'],
  fullyParallel: false,
  workers: 1,
  timeout: 45_000,
  reporter: [['list'], ['json', { outputFile: 'test-results/inventory-receipts/results.json' }]],
  outputDir: 'test-results/inventory-receipts/browser',
  use: {
    browserName: 'chromium',
    launchOptions: {
      executablePath:
        process.env.PLAYWRIGHT_EXECUTABLE_PATH ??
        (process.platform === 'win32'
          ? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
          : undefined),
    },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'iPhone-13-emulation',
      use: { ...devices['iPhone 13'], defaultBrowserType: 'chromium' },
    },
    {
      name: 'iPad-Mini-emulation',
      use: { ...devices['iPad Mini'], defaultBrowserType: 'chromium' },
    },
    { name: 'desktop', use: { viewport: { width: 1440, height: 900 } } },
  ],
});
