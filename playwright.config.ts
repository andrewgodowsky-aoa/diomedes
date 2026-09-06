import { defineConfig } from '@playwright/test';
import path from 'node:path';

const runRoot = path.resolve('test-results', `app-data-${Date.now()}-${process.pid}`);
const clientPort = 5174;

export default defineConfig({
  testDir: './tests',
  testMatch: ['ui.spec.ts', 'native-ui.spec.ts'],
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  expect: { timeout: 12_000 },
  reporter: [['list'], ['html', { outputFolder: 'test-results/report', open: 'never' }]],
  outputDir: 'test-results/browser',
  use: {
    baseURL: `http://127.0.0.1:${clientPort}`,
    browserName: 'chromium',
    launchOptions: {
      executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH ?? (process.platform === 'win32'
        ? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
        : undefined),
    },
    viewport: { width: 1440, height: 900 },
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  webServer: {
    command: `"${process.execPath}" scripts/dev.mjs`,
    url: `http://127.0.0.1:${clientPort}/api/settings`,
    timeout: 30_000,
    reuseExistingServer: false,
    env: {
      DIOMEDES_PORT: '47632',
      DIOMEDES_CLIENT_PORT: String(clientPort),
      DIOMEDES_DATA_DIR: path.join(runRoot, 'data'),
      DIOMEDES_PROJECTS_DIR: path.join(runRoot, 'projects'),
      DIOMEDES_TEST_MODE: '1',
    },
    stdout: 'pipe',
    stderr: 'pipe',
  },
});
