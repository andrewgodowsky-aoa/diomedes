import { defineConfig } from '@playwright/test';
import base from './playwright.config.js';
export default defineConfig({ ...base, testMatch: ['connections-ui.spec.ts'],
  outputDir: 'test-results/connections-browser',
  reporter: [['list'], ['json', { outputFile: 'evidence/windows-release/connections-browser.json' }]],
  webServer: { ...base.webServer, command: process.env.DIOMEDES_BUILT_CLIENT === '1'
    ? `"${process.execPath}" --import tsx scripts/serve-built-client.ts` : `"${process.execPath}" scripts/dev.mjs` },
});
