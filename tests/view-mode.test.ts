import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../server/app.js';
import { defaults, migrateSettings } from '../server/store.js';
import { advanceSetup } from '../shared/onboarding.js';
import type { Settings } from '../shared/types.js';

/**
 * The Console has two views (Andrew, 2026-09-23). Conversation shows the
 * prompt box and the threads; Architect is the full Console. A view changes
 * what is shown, never what Nectovia can do. A new person who finishes setup
 * starts in Conversation; a profile from before the views existed keeps the
 * Console it knows, as Architect.
 */
describe('the stored view', () => {
  it('is Architect for a profile written before the views existed', () => {
    const settings = defaults() as Settings;
    delete (settings as { view?: unknown }).view;
    migrateSettings(settings);
    expect(settings.view).toBe('architect');
  });

  it('keeps a chosen view across a launch', () => {
    for (const view of ['conversation', 'architect'] as const) {
      const settings = { ...defaults(), view } as Settings;
      migrateSettings(settings);
      expect(settings.view).toBe(view);
    }
  });

  it('turns a value it does not know into Architect', () => {
    const settings = defaults() as Settings;
    (settings as { view?: unknown }).view = 'workbook';
    migrateSettings(settings);
    expect(settings.view).toBe('architect');
  });
});

describe('finishing setup', () => {
  const atReady = (): Settings => {
    const settings = defaults();
    settings.onboarding = { ...settings.onboarding, resumeAt: 'ready' };
    return settings;
  };

  it('starts a new person in Conversation', () => {
    const done = advanceSetup(atReady(), false, '2026-09-23T21:00:00.000Z');
    expect(done.onboarding.resumeAt).toBe('done');
    expect(done.view).toBe('conversation');
  });

  it('leaves the view alone on every earlier step', () => {
    const settings = defaults();
    settings.onboarding = { ...settings.onboarding, resumeAt: 'q1' };
    expect(advanceSetup(settings).view).toBe(settings.view);
  });

  it('never moves a person who had already finished', () => {
    const settings = { ...defaults(), view: 'architect' as const };
    settings.onboarding = { ...settings.onboarding, resumeAt: 'done', completedAt: 'x' };
    expect(advanceSetup(settings).view).toBe('architect');
  });
});

describe('the settings API', () => {
  let server: Server, app: Awaited<ReturnType<typeof createApp>>, temp: string, url: string;
  const put = (body: unknown) =>
    fetch(`${url}/api/settings`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'X-Diomedes-Client': '1' },
      body: JSON.stringify(body),
    });

  beforeEach(async () => {
    await fs.mkdir(path.join(process.cwd(), 'test-results'), { recursive: true });
    temp = await fs.mkdtemp(path.join(process.cwd(), 'test-results', 'view-mode-'));
    app = await createApp({ dataDir: path.join(temp, 'data'), projectRoot: path.join(temp, 'projects') });
    server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', resolve));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterEach(async () => {
    const closingApp = app, closingServer = server;
    try {
      await closingApp?.locals.close();
    } finally {
      closingServer?.closeAllConnections();
      await new Promise((resolve) => closingServer?.close(resolve));
      await fs.rm(temp, { recursive: true, force: true });
    }
  });

  it('stores either view and reads it back', async () => {
    for (const view of ['conversation', 'architect']) {
      const response = await put({ view });
      expect(response.status).toBe(200);
      expect((await response.json()).view).toBe(view);
    }
  });

  it('refuses a view it does not know', async () => {
    expect((await put({ view: 'workbook' })).status).toBe(400);
  });
});
