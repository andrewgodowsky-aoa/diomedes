import { defineConfig } from '@playwright/test';
import base from './playwright.config';

export default defineConfig({ ...base, webServer: undefined, testMatch: ['bonsai-ui.spec.ts', 'local-read-progress.spec.ts'] });
