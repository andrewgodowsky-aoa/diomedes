import { defineConfig } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

// Alternative launcher for the three required specs already registered in playwright.config.ts.
// Do not import that config: evaluating it invokes dev-server-guard and orphan reclamation.
const runRoot = path.resolve('test-results', `agent-repair-${Date.now()}-${process.pid}`);
const clientPort = Number(process.env.DIOMEDES_UI_CLIENT_PORT ?? 52762);
const servicePort = Number(process.env.DIOMEDES_UI_SERVICE_PORT ?? 48762);
const nativePort = Number(process.env.DIOMEDES_UI_NATIVE_PORT ?? 48763);
const codexHome = path.join(runRoot, 'codex');
fs.mkdirSync(codexHome, { recursive: true });
fs.writeFileSync(path.join(codexHome, 'models_cache.json'), JSON.stringify({ models: [
  { slug: 'gpt-6-astra', display_name: 'GPT-6-Astra', description: 'Our most capable choice for demanding work.',
    default_reasoning_level: 'medium', supported_reasoning_levels: [
      { effort: 'low', description: 'Fast' }, { effort: 'medium', description: 'Balanced' },
      { effort: 'xhigh', description: 'Deeper' }, { effort: 'ultra', description: 'Deepest' },
    ], visibility: 'list', priority: 1 },
  { slug: 'gpt-5.5', display_name: 'GPT-5.5', description: 'A fast everyday choice.',
    default_reasoning_level: 'low', supported_reasoning_levels: [
      { effort: 'low', description: 'Fast' }, { effort: 'medium', description: 'Balanced' },
    ], visibility: 'list', priority: 12 },
  { slug: 'internal-only', display_name: 'Internal', visibility: 'hidden', priority: 2 },
] }), 'utf8');

export default defineConfig({
  testDir: './tests', testMatch: ['ui.spec.ts', 'native-ui.spec.ts', 'field.spec.ts'],
  fullyParallel: false, workers: 1, timeout: 60_000, expect: { timeout: 12_000 },
  reporter: [['list'], ['json', { outputFile: 'test-results/agent-repair-required.json' }]],
  outputDir: 'test-results/agent-repair-browser',
  globalSetup: './scripts/agent-repair-test-host.ts',
  metadata: { agentRepairHost: {
    port: servicePort, clientPort, nativePort, dataDir: path.join(runRoot, 'data'), projectRoot: path.join(runRoot, 'projects'), codexHome,
  } },
  use: {
    baseURL: `http://127.0.0.1:${clientPort}`, browserName: 'chromium',
    launchOptions: { executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH ??
      (process.platform === 'win32' ? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe' : undefined) },
    viewport: { width: 1440, height: 900 }, screenshot: 'only-on-failure', trace: 'retain-on-failure',
  },
});
