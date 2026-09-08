import { defineConfig } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

const runRoot = path.resolve('test-results', `app-data-${Date.now()}-${process.pid}`);
const clientPort = 5174;

/**
 * A fixed engine catalogue for the suite. The server reads the engine's own
 * cache from CODEX_HOME, so pointing that at a written fixture gives the same
 * list on every machine without a test branch in the server. The two entries
 * have deliberately different reasoning ladders: the picker must rederive them
 * when the choice changes.
 */
const codexHome = path.join(runRoot, 'codex');
fs.mkdirSync(codexHome, { recursive: true });
fs.writeFileSync(
  path.join(codexHome, 'models_cache.json'),
  JSON.stringify({
    models: [
      {
        slug: 'gpt-6-astra',
        display_name: 'GPT-6-Astra',
        description: 'Our most capable choice for demanding work.',
        default_reasoning_level: 'medium',
        supported_reasoning_levels: [
          { effort: 'low', description: 'Fast' },
          { effort: 'medium', description: 'Balanced' },
          { effort: 'xhigh', description: 'Deeper' },
          { effort: 'ultra', description: 'Deepest' },
        ],
        visibility: 'list',
        priority: 1,
      },
      {
        slug: 'gpt-5.5',
        display_name: 'GPT-5.5',
        description: 'A fast everyday choice.',
        default_reasoning_level: 'low',
        supported_reasoning_levels: [
          { effort: 'low', description: 'Fast' },
          { effort: 'medium', description: 'Balanced' },
        ],
        visibility: 'list',
        priority: 12,
      },
      { slug: 'internal-only', display_name: 'Internal', visibility: 'hidden', priority: 2 },
    ],
  }),
  'utf8',
);

export default defineConfig({
  testDir: './tests',
  testMatch: ['ui.spec.ts', 'native-ui.spec.ts', 'field.spec.ts'],
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
      CODEX_HOME: codexHome,
    },
    stdout: 'pipe',
    stderr: 'pipe',
  },
});
