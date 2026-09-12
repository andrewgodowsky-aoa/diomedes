import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../server/app.js';
import { EngineService, TESTED_VERSIONS } from '../server/engines/service.js';
import type { TextEngineAdapter } from '../server/engines/contract.js';
import type { EngineModel, IntegrationStatus, Settings } from '../shared/types.js';
import type { EngineConnection } from '../shared/engines.js';
import { connectionState, signedIn } from '../client/console/Picker.js';

/**
 * What the thread picker reads, and what two AI-setup controls write.
 *
 * The picker gap measured in journey B was not that OpenCode reported nothing:
 * it was that the Console asked the wrong question. `IntegrationStatus.available`
 * is installed *and* supported *and* signed in *and* checked in the last five
 * minutes, and the Console reads that roster once at start, before Settings has
 * run any check. So the first group here pins the shape the picker now reads —
 * `GET /ai/status` — against the same signed-in account AI setup shows, and
 * pins what it says before anything has been checked, so an empty menu can only
 * ever mean an empty account.
 *
 * The second group pins the write ordering: turning an engine on and choosing
 * its default model must both survive, in either order, at any speed.
 */

const OPENCODE_ACCOUNT = 'opencode:opencode-go';
const MODELS: EngineModel[] = [
  {
    slug: 'opencode-go/glm-5.2',
    name: 'GLM 5.2',
    description: 'A fixture model reported by the account.',
    defaultEffort: null,
    efforts: [],
  },
  {
    slug: 'opencode-go/mimo-v2.5-pro',
    name: 'MiMo v2.5 Pro',
    description: 'A second fixture model reported by the account.',
    defaultEffort: null,
    efforts: [],
  },
];

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function fixture() {
  const version = TESTED_VERSIONS.opencode;
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'diomedes-picker-'));
  const inspect = vi.fn<TextEngineAdapter['inspect']>(async () => ({
    authentication: 'signed-in' as const,
    accountRoute: OPENCODE_ACCOUNT,
    models: MODELS,
    detail: 'Native OpenCode Go account connected. Choose an explicit provider/model.',
  }));
  const found: IntegrationStatus = {
    id: 'opencode',
    name: 'OpenCode',
    kind: 'online',
    found: true,
    // Discovery is right to say false: finding a binary proves nothing about an
    // account. Readiness is decided by the check, not by the inventory.
    available: false,
    enabled: false,
    status: 'Installed',
    detail: 'Found',
    capabilities: [],
    signIn: 'unknown',
    adapter: 'planned',
    installedVersion: version,
    location: 'fixture-opencode.exe',
    disclosure: [],
  };
  const service = new EngineService(path.join(root, 'engines'), {
    discover: async () => [found],
    version: async () => version,
    adapter: () => ({
      id: 'opencode',
      inspect,
      generate: async (input) => ({ ...input, text: 'unused', version }),
    }),
  });
  const app = await createApp({
    dataDir: path.join(root, 'data'),
    projectRoot: path.join(root, 'projects'),
    engineService: service,
  });
  const server: Server = await new Promise((resolve) => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
  cleanups.push(async () => {
    await app.locals.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await fs.rm(root, { recursive: true, force: true });
  });
  const call = async (endpoint: string, method = 'GET', body?: unknown, etag?: string) => {
    const response = await fetch(base + endpoint, {
      method,
      headers: {
        'Content-Type': 'application/json',
        'X-Diomedes-Client': '1',
        ...(etag ? { 'If-Match': etag } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return {
      status: response.status,
      etag: response.headers.get('ETag'),
      data: (await response.json()) as Record<string, unknown>,
    };
  };
  const connection = async (): Promise<EngineConnection> =>
    (
      (await call('/ai/status')).data as unknown as { connections: EngineConnection[] }
    ).connections.find((row) => row.engine === 'opencode')!;
  const integration = async (): Promise<IntegrationStatus> =>
    (
      (await call('/integrations')).data as unknown as { integrations: IntegrationStatus[] }
    ).integrations.find((row) => row.id === 'opencode')!;
  const connect = async () => {
    expect((await call('/ai/discover', 'POST', { consent: true })).status).toBe(200);
    expect((await call('/ai/check/opencode', 'POST', {})).status).toBe(200);
  };
  return { call, connection, integration, connect, inspect };
}

describe('the model list a signed-in engine offers the thread', () => {
  it('says nothing has been checked before anything has, and invents no models', async () => {
    const { call, connection, integration } = await fixture();
    expect(await connection()).toMatchObject({
      installation: 'not-checked',
      authentication: 'unknown',
      accountRoute: null,
      models: [],
      checkedAt: null,
    });
    expect(await integration()).toMatchObject({ found: false, available: false });
    expect((await call('/engines/opencode/models')).data).toMatchObject({
      engine: 'opencode',
      models: [],
    });
  });

  it('reports the account route and the engine-reported models on /ai/status', async () => {
    const { connection, connect, inspect } = await fixture();
    await connect();
    const value = await connection();
    expect(value).toMatchObject({
      installation: 'found',
      compatibility: 'supported',
      authentication: 'signed-in',
      accountRoute: OPENCODE_ACCOUNT,
      detail: 'Native OpenCode Go account connected. Choose an explicit provider/model.',
    });
    // Every model the account reported, with the provider-qualified slug the
    // adapter requires, and nothing the engine did not name.
    expect(value.models.map((model) => model.slug)).toEqual([
      'opencode-go/glm-5.2',
      'opencode-go/mimo-v2.5-pro',
    ]);
    expect(value.models.map((model) => model.name)).toEqual(['GLM 5.2', 'MiMo v2.5 Pro']);
    expect(value.checkedAt).not.toBeNull();
    expect(inspect).toHaveBeenCalledTimes(1);
  });

  it('offers the same list on /engines/opencode/models and marks the integration ready', async () => {
    const { call, connect, integration } = await fixture();
    await connect();
    expect((await call('/engines/opencode/models')).data).toMatchObject({
      engine: 'opencode',
      models: MODELS,
    });
    expect(await integration()).toMatchObject({
      id: 'opencode',
      found: true,
      available: true,
      signIn: 'signed-in',
      status: 'Ready',
    });
  });

  it('empties the offered list when the account signs out, rather than keeping a stale one', async () => {
    const { call, connection, connect, inspect } = await fixture();
    await connect();
    expect((await connection()).models).toHaveLength(2);
    inspect.mockResolvedValueOnce({
      authentication: 'signed-out',
      accountRoute: null,
      models: [],
      detail: 'Sign in to the native OpenCode Go account before using this route.',
    });
    expect((await call('/ai/check/opencode', 'POST', {})).status).toBe(200);
    expect(await connection()).toMatchObject({ authentication: 'signed-out', models: [] });
    expect((await call('/engines/opencode/models')).data).toMatchObject({ models: [] });
  });
});

describe('AI setup writes cannot lose each other', () => {
  it('keeps both the switch and the default model, whichever lands first', async () => {
    for (const switchFirst of [true, false]) {
      const { call, connect } = await fixture();
      await connect();
      // Off first, so the switch has real work to do in both orders.
      expect((await call('/ai/enabled', 'POST', { engine: 'opencode', on: false })).status).toBe(
        200,
      );
      const enable = () => call('/ai/enabled', 'POST', { engine: 'opencode', on: true });
      const choose = () =>
        call('/ai/select', 'POST', { engine: 'opencode', model: 'opencode-go/glm-5.2' });
      const [a, b] = switchFirst ? [enable(), choose()] : [choose(), enable()];
      expect((await a).status).toBe(200);
      expect((await b).status).toBe(200);
      const saved = (await call('/settings')).data as unknown as Settings;
      expect(saved.services).toMatchObject({
        opencode: true,
        defaultEngine: 'opencode',
        opencodeModel: 'opencode-go/glm-5.2',
        opencodeAccountRoute: OPENCODE_ACCOUNT,
      });
      for (const cleanup of cleanups.splice(0)) await cleanup();
    }
  });

  it('reverts the later write when an earlier response is echoed back with the current hash', async () => {
    // Why AI setup writes nothing back after the two switch/select routes.
    // Each route answers with the whole settings object and its hash. When both
    // answers land in the same tick, a screen that keeps one hash keeps the
    // later one — and a PUT of the *earlier* body then measures as current and
    // is accepted, silently undoing the write that came second. The hash guard
    // cannot see this, because the hash is honest and the body is old. So the
    // screen must not echo; the server publishes what it saved and the app
    // re-reads that.
    const { call, connect } = await fixture();
    await connect();
    expect((await call('/ai/enabled', 'POST', { engine: 'opencode', on: false })).status).toBe(200);
    const enabled = await call('/ai/enabled', 'POST', { engine: 'opencode', on: true });
    const chosen = await call('/ai/select', 'POST', {
      engine: 'opencode',
      model: 'opencode-go/glm-5.2',
    });
    expect(enabled.status).toBe(200);
    expect(chosen.status).toBe(200);
    const echo = await call(
      '/settings',
      'PUT',
      enabled.data as unknown as Settings,
      chosen.etag ?? undefined,
    );
    expect(echo.status).toBe(200);
    // Proof of the loss the client no longer risks: the chosen model is gone.
    expect(((await call('/settings')).data as unknown as Settings).services?.opencodeModel).toBe(
      undefined,
    );
  });

  it('turns an engine off without discarding the default model it was given', async () => {
    const { call, connect } = await fixture();
    await connect();
    expect(
      (await call('/ai/select', 'POST', { engine: 'opencode', model: 'opencode-go/glm-5.2' }))
        .status,
    ).toBe(200);
    expect((await call('/ai/enabled', 'POST', { engine: 'opencode', on: false })).status).toBe(200);
    const saved = (await call('/settings')).data as unknown as Settings;
    expect(saved.services).toMatchObject({
      opencode: false,
      opencodeModel: 'opencode-go/glm-5.2',
      opencodeAccountRoute: OPENCODE_ACCOUNT,
    });
  });

  it('refuses a whole-object write measured against settings that have since moved', async () => {
    const { call, connect } = await fixture();
    await connect();
    const first = await call('/settings');
    const stale = first.etag!;
    expect(stale).toMatch(/^"[a-f0-9]{64}"$/);
    // Another route writes. This is exactly the "Use as default" a screen does
    // not know about yet.
    expect(
      (await call('/ai/select', 'POST', { engine: 'opencode', model: 'opencode-go/glm-5.2' }))
        .status,
    ).toBe(200);
    const optimistic = {
      ...(first.data as unknown as Settings),
      services: { opencode: true },
    };
    const refused = await call('/settings', 'PUT', optimistic, stale);
    expect(refused.status).toBe(409);
    expect(refused.data.code).toBe('settings_conflict');
    // The refusal hands back what was stored, so a screen can re-apply its one
    // change to the truth rather than to its own stale copy.
    expect((refused.data.settings as Settings).services).toMatchObject({
      defaultEngine: 'opencode',
      opencodeModel: 'opencode-go/glm-5.2',
    });
    expect(refused.data.etag).toBe((await call('/settings')).etag);
    const saved = (await call('/settings')).data as unknown as Settings;
    expect(saved.services?.opencodeModel).toBe('opencode-go/glm-5.2');
  });

  it('accepts the same write once it is measured against the current settings', async () => {
    const { call, connect } = await fixture();
    await connect();
    expect(
      (await call('/ai/select', 'POST', { engine: 'opencode', model: 'opencode-go/glm-5.2' }))
        .status,
    ).toBe(200);
    const current = await call('/settings');
    const accepted = await call(
      '/settings',
      'PUT',
      { detail: 'technical' },
      current.etag ?? undefined,
    );
    expect(accepted.status).toBe(200);
    expect(accepted.etag).not.toBe(current.etag);
    const saved = (await call('/settings')).data as unknown as Settings;
    expect(saved.detail).toBe('technical');
    expect(saved.services?.opencodeModel).toBe('opencode-go/glm-5.2');
  });

  it('leaves an unguarded write exactly as it was, and refuses a nonsense switch', async () => {
    const { call, connect } = await fixture();
    await connect();
    // No If-Match: the older callers that own one field keep working.
    expect((await call('/settings', 'PUT', { detail: 'standard' })).status).toBe(200);
    expect(((await call('/settings')).data as unknown as Settings).detail).toBe('standard');
    expect((await call('/ai/enabled', 'POST', { engine: 'opencode', on: 'yes' })).status).toBe(400);
    expect((await call('/ai/enabled', 'POST', { engine: 'codex', on: true })).status).toBe(400);
  });
});

/**
 * The gate the thread picker applies to `GET /ai/status`. It is the four facts
 * AI setup shows, and deliberately not `IntegrationStatus.available`, which
 * also folds in "checked in the last five minutes" — a working account read
 * six minutes after its check is still the same account, and the send path
 * rechecks it anyway. What the freshness window governs is the heading.
 */
describe('what the thread picker treats as a usable account', () => {
  const base: EngineConnection = {
    engine: 'opencode',
    installation: 'found',
    compatibility: 'supported',
    authentication: 'signed-in',
    accountRoute: OPENCODE_ACCOUNT,
    models: MODELS,
    checkedAt: new Date().toISOString(),
    detail: 'Native OpenCode Go account connected. Choose an explicit provider/model.',
    usage: { state: 'unknown', checkedAt: null },
  };
  it('offers a signed-in account whose check has gone stale', () => {
    expect(signedIn(base)).toBe(true);
    const stale = { ...base, checkedAt: new Date(Date.now() - 3_600_000).toISOString() };
    expect(signedIn(stale)).toBe(true);
    expect(connectionState(base)).toBe('Signed in · Ready');
    expect(connectionState(stale)).toContain('rechecked before sending');
  });
  it('offers nothing for an account that is missing, unsupported, signed out or empty', () => {
    expect(signedIn(undefined)).toBe(false);
    expect(signedIn({ ...base, installation: 'missing' })).toBe(false);
    expect(signedIn({ ...base, installation: 'not-checked' })).toBe(false);
    expect(signedIn({ ...base, compatibility: 'unsupported' })).toBe(false);
    expect(signedIn({ ...base, authentication: 'signed-out' })).toBe(false);
    expect(signedIn({ ...base, authentication: 'unknown' })).toBe(false);
    expect(signedIn({ ...base, models: [] })).toBe(false);
  });
});
