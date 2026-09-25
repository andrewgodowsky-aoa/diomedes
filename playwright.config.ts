import { defineConfig } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const runRoot = path.resolve('test-results', `app-data-${Date.now()}-${process.pid}`);
const clientPort = Number(process.env.DIOMEDES_UI_CLIENT_PORT ?? 5174);
const servicePort = Number(process.env.DIOMEDES_UI_SERVICE_PORT ?? 47632);

/**
 * Reclaim this worktree's orphaned dev-server tree before Playwright's own
 * webServer check trips on the port. A config file evaluates before any runner
 * task — including webServer startup and globalSetup — so a synchronous guard
 * here is the only hook early enough. Holders are only killed when the
 * `.dev-server.json` marker plus their live command lines prove they are this
 * worktree's orphan; anything else fails here with a full diagnostic instead
 * of Playwright's bare "already used" error.
 *
 * Worker processes re-evaluate this config while the runner's webServer is
 * legitimately up, so the guard is skipped wherever TEST_WORKER_INDEX is set.
 */
if (process.env.TEST_WORKER_INDEX === undefined) {
  const guard = spawnSync(
    process.execPath,
    [
      path.resolve('scripts/dev-server-guard.mjs'),
      '--ports',
      `${clientPort},${servicePort}`,
      '--root',
      path.resolve('.'),
    ],
    { stdio: 'inherit' },
  );
  if (guard.status !== 0) process.exit(guard.status ?? 1);
}

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
  testMatch: [
    'ui.spec.ts',
    'native-ui.spec.ts',
    'field.spec.ts',
    'design-studio-ui.spec.ts',
    'ai-engines-ui.spec.ts',
    'first-task-handoff.spec.ts',
    'autonomy-ui.spec.ts',
    'change-review-ui.spec.ts',
    'reviewer-ui.spec.ts',
    'agent-ui.spec.ts',
    'agent-profiles-ui.spec.ts',
    'diomedes-home.spec.ts',
    'home-luna.spec.ts',
    'home-history-sharing.spec.ts',
    'home-route-ownership.review-20260921.spec.ts',
    'app-updates-ui.spec.ts',
    'workspace-ui.spec.ts',
    'configuration-ui.spec.ts',
    'file-imports-ui.spec.ts',
    'fd02-discovery.spec.ts',
    'fd03-readiness.spec.ts',
    'automations.spec.ts',
    'files-pane-ux-20260917.spec.ts',
    'h01-preview-repair.spec.ts',
    'independent-h01-final-20260917.spec.ts',
    'allowance-ui.spec.ts',
    'vertex-setup-ui.spec.ts',
    'artifacts-ui.spec.ts',
    'nectovia-skin.spec.ts',
    'drawings-ui.spec.ts',
    'console-view-ui.spec.ts',
    'files-attachments-ui.spec.ts',
    'instructions-inspector.spec.ts',
    'verification-ui.spec.ts',
    'context-used.spec.ts',
    'ready-queue-ui.spec.ts',
    'pack-lifecycle-ui.spec.ts',
    'remembered-approvals-ui.spec.ts',
    'editor-guard-ui.spec.ts',
    'h03-claude-controls.spec.ts',
    'h08-durable-controls.spec.ts',
    'h02-codex-controls.spec.ts',
    'native-loop-ui.spec.ts',
    'h14-team-ui.spec.ts',
    'h15-supervision.spec.ts',
    'review-diffs-ui.spec.ts',
    'guidance-maintenance-ui.spec.ts',
    'cd05-zoom-motion.spec.ts',
    'software-pack-ui.spec.ts',
    'p04-pack-panel.spec.ts',
  ],
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
  webServer: {
    command: `"${process.execPath}" scripts/dev.mjs`,
    url: `http://127.0.0.1:${clientPort}/api/settings`,
    timeout: 30_000,
    reuseExistingServer: false,
    env: {
      DIOMEDES_PORT: process.env.DIOMEDES_UI_SERVICE_PORT ?? '47632',
      DIOMEDES_CLIENT_PORT: String(clientPort),
      DIOMEDES_DATA_DIR: path.join(runRoot, 'data'),
      DIOMEDES_PROJECTS_DIR: path.join(runRoot, 'projects'),
      DIOMEDES_TEST_MODE: '1',
      // A5 gates Design Center authoring on the customization capability. The
      // suite runs one dev server for every spec, so the launch profile is the
      // entitled one and the specs that need a different named state ask for it
      // per test with `X-Diomedes-Entitlement-Fixture`. Both the env var and the
      // header are inert without `DIOMEDES_TEST_MODE=1`.
      DIOMEDES_ENTITLEMENT_FIXTURE: 'paid',
      CODEX_HOME: codexHome,
    },
    stdout: 'pipe',
    stderr: 'pipe',
  },
});
