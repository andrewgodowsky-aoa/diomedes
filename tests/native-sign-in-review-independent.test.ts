/** Independent review of the frozen B02.NATIVE candidate.
 * All provider responses, keys, tokens, transport, windows and storage below are
 * synthetic. No WorkOS service is contacted. Real supported SDK code performs
 * PKCE, sealing, HTTP serialization, JWT/JWKS verification and session lifecycle.
 * OS safeStorage and real IPC are covered separately by the hidden smoke driver.
 */
import { EventEmitter } from 'node:events';
import { createHash, createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { exportJWK, generateKeyPair, SignJWT, type JWTPayload } from 'jose';
import { AuthKitCore, sessionEncryption } from '@workos/authkit-session';
import { createPublicWorkOS, IPC_CHANNELS, toAuthKitConfig } from '@workos/authkit-electron/internals';
import type { BrowserWindow } from 'electron';

vi.mock('electron', () => ({ app: {}, safeStorage: {}, ipcMain: {}, shell: {}, BrowserWindow: {} }));
import { captureNativeAuthCallbacks, createNativeAuth, parseNativeCallback } from '../desktop/native-auth';
import { createNativeTokenStorage } from '../desktop/native-auth-storage';

const clientId = 'client_independent_fixture';
const origin = 'http://127.0.0.1:43591';
const callback = 'diomedes-auth://callback';
let keys: Awaited<ReturnType<typeof generateKeyPair>>;
let jwk: Awaited<ReturnType<typeof exportJWK>>;
const owned: Array<{ dispose(): void }> = [];
beforeAll(async () => {
  keys = await generateKeyPair('RS256', { extractable: true });
  jwk = { ...(await exportJWK(keys.publicKey)), kid: 'independent-synthetic-key', alg: 'RS256', use: 'sig' };
});
afterEach(() => {
  for (const item of owned.splice(0)) item.dispose();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function memoryVault() {
  const values = new Map<string, unknown>();
  const key = randomBytes(32);
  const secure = {
    isEncryptionAvailable: vi.fn(() => true),
    getSelectedStorageBackend: vi.fn(() => 'dpapi-fixture'),
    encryptString(text: string) {
      const nonce = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', key, nonce);
      const data = Buffer.concat([cipher.update(text), cipher.final()]);
      return Buffer.concat([nonce, cipher.getAuthTag(), data]);
    },
    decryptString(bytes: Buffer) {
      const decipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12));
      decipher.setAuthTag(bytes.subarray(12, 28));
      return Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString();
    },
  };
  const store = {
    get: (key: string) => values.get(key),
    set: vi.fn((key: string, value: unknown) => { values.set(key, value); }),
    delete: vi.fn((key: string) => { values.delete(key); }),
  };
  return { values, secure, store };
}

async function token(subject = 'user_fixture_a', extra: JWTPayload = {}) {
  return new SignJWT({
    iss: 'https://api.workos.com', client_id: clientId, sub: subject,
    sid: 'session_fixture_a', exp: Math.floor(Date.now() / 1000) + 600,
    org_id: 'org_fixture', permissions: ['fixture:admin'], entitlements: ['fixture:paid'],
    ...extra,
  }).setProtectedHeader({ alg: 'RS256', kid: 'independent-synthetic-key' }).sign(keys.privateKey);
}

async function response(subject = 'user_fixture_a', extra: JWTPayload = {}) {
  return {
    access_token: await token(subject, extra), refresh_token: 'native-smoke-refresh-sentinel',
    user: { object: 'user', id: subject, first_name: subject, last_name: 'Fixture',
      email: 'same@fixture.invalid', email_verified: true,
      created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z' },
    authentication_method: 'Password', organization_id: 'org_fixture',
  };
}
type ProviderResponse = Awaited<ReturnType<typeof response>>;

function fixture(options: { vault?: ReturnType<typeof memoryVault>; configured?: boolean; tokenIssuer?: string } = {}) {
  const vault = options.vault ?? memoryVault();
  const storage = createNativeTokenStorage({ store: vault.store, safeStorage: vault.secure });
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const frame = { url: origin + '/' };
  const webContents = { mainFrame: frame, isDestroyed: vi.fn(() => false), send: vi.fn() };
  const win = { webContents, isDestroyed: vi.fn(() => false) };
  const event = { sender: webContents, senderFrame: frame };
  const requests: Array<{ url: string; body: Record<string, string>; headers: Headers }> = [];
  const unknownRequests: string[] = [];
  const opened: string[] = [];
  let challenge = '';
  let exchange = async (_body: Record<string, string>): Promise<ProviderResponse> => response();
  let refresh = async (_body: Record<string, string>): Promise<ProviderResponse> => response();
  const openExternal = vi.fn(async (url: string) => {
    opened.push(url);
    if (new URL(url).pathname.endsWith('/authorize'))
      challenge = new URL(url).searchParams.get('code_challenge')!;
  });
  const transport = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url === `https://api.workos.com/sso/jwks/${clientId}`)
      return Response.json({ keys: [jwk] });
    if (url === 'https://api.workos.com/user_management/authenticate') {
      const body = JSON.parse(String(init?.body)) as Record<string, string>;
      requests.push({ url, body, headers: new Headers(init?.headers) });
      expect(body.client_id).toBe(clientId);
      expect(body).not.toHaveProperty('client_secret');
      expect(new Headers(init?.headers).get('authorization')).toBeNull();
      if (body.grant_type === 'authorization_code') {
        expect(createHash('sha256').update(body.code_verifier!).digest('base64url')).toBe(challenge);
        return Response.json(await exchange(body));
      }
      if (body.grant_type === 'refresh_token') return Response.json(await refresh(body));
    }
    unknownRequests.push(url);
    throw new Error('Unapproved network request blocked by independent fixture');
  });
  vi.stubGlobal('fetch', transport);
  const client = createPublicWorkOS(clientId);
  const registerProtocol = vi.fn(() => true);
  const auth = createNativeAuth({
    clientId: options.configured === false ? undefined : clientId,
    tokenIssuer: options.tokenIssuer ?? 'https://api.workos.com', // Explicit synthetic fixture issuer.
    origin, getWindow: () => win as unknown as BrowserWindow, storage, client,
    ipcMain: { handle: (name, fn) => { handlers.set(name, fn); }, removeHandler: (name) => { handlers.delete(name); } },
    shell: { openExternal }, registerProtocol,
  });
  owned.push(auth);
  const invoke = async (name: keyof typeof IPC_CHANNELS, ...args: unknown[]) =>
    await handlers.get(IPC_CHANNELS[name])!(event, ...args) as any;
  async function begin() {
    expect((await invoke('signIn')).ok).toBe(true);
    return new URL(opened.at(-1)!).searchParams.get('state')!;
  }
  const finish = (state: string, code = 'independent-fixture-code') => auth.handleCallback(`${callback}?code=${code}&state=${encodeURIComponent(state)}`);
  const readSession = () => storage.run(async () => storage.sdk.getSession());
  return { auth, storage, vault, handlers, frame, webContents, win, event, requests, unknownRequests,
    opened, transport, openExternal, registerProtocol, client, invoke, begin, finish, readSession,
    setExchange: (fn: typeof exchange) => { exchange = fn; },
    setRefresh: (fn: typeof refresh) => { refresh = fn; },
    setChallenge: (value: string) => { challenge = value; },
  };
}

describe('independent SDK and synthetic provider boundary', () => {
  it('uses real public SDK HTTP + RSA JWKS validation and exposes display-only IPC', async () => {
    const f = fixture();
    const state = await f.begin();
    expect(await f.finish(state)).toBe(true);
    const shown = await f.invoke('getUser');
    expect(shown.data.account.id).toBe('user_fixture_a');
    expect(f.requests).toHaveLength(1);
    expect(f.transport.mock.calls.some(([url]) => String(url).includes('/sso/jwks/'))).toBe(true);
    const visible = JSON.stringify([shown, f.webContents.send.mock.calls]);
    for (const secret of ['accessToken', 'refreshToken', 'native-smoke-', 'fixture:admin', 'fixture:paid', 'org_fixture'])
      expect(visible).not.toContain(secret);
    expect(f.unknownRequests).toEqual([]);
    expect((await f.invoke('getAccessToken')).ok).toBe(false);
    expect((await f.invoke('switchToOrganization', 'org_fixture')).ok).toBe(false);
    expect(await f.finish(state)).toBe(false);
    expect(f.requests).toHaveLength(1);
  });

  it.each(['', '/'])('accepts the documented client-scoped AuthKit issuer with suffix "%s"', async (suffix) => {
    // Primary WorkOS docs /docs/cli/emulate describe actual AuthKit issuance as
    // {issuer}/user_management/{client_id}; /docs/authkit/applications explains
    // that iss refers to the default application, not the current API origin.
    // This fixture chooses the default application. It is NOT a live token.
    const f = fixture({ tokenIssuer: `https://api.workos.com/user_management/${clientId}${suffix}` });
    const value = await response('user_fixture_a', { iss: `https://api.workos.com/user_management/${clientId}${suffix}` });
    const rawSdk = new AuthKitCore(toAuthKitConfig({ clientId, redirectUri: callback }, 'synthetic-cookie-password'.repeat(3)), f.client, sessionEncryption);
    expect(await rawSdk.verifyToken(value.access_token)).toBe(true);
    f.setExchange(async () => value);
    expect(await f.finish(await f.begin())).toBe(true);
    expect((await f.invoke('getUser')).data.account.id).toBe('user_fixture_a');
  });

  it.each([
    ['issuer', { iss: 'https://wrong.invalid' }],
    ['client', { client_id: 'client_wrong' }],
    ['subject', { sub: 'user_wrong' }],
    ['session', { sid: 'wrong' }],
    ['expiry', { exp: 1 }],
    ['future nbf', { nbf: 4_000_000_000 }],
  ] as Array<[string, JWTPayload]>)('refuses actually signed synthetic %s mismatch', async (_name, claims) => {
    const f = fixture();
    f.setExchange(async () => response('user_fixture_a', claims));
    const state = await f.begin();
    expect(await f.finish(state)).toBe(false);
    expect(await f.readSession()).toBeNull();
    expect((await f.invoke('getUser')).data.status).toBe('signed-out');
  });

  it('refuses a JWT whose signature bytes were modified', async () => {
    const f = fixture();
    const value = await response();
    const parts = value.access_token.split('.');
    parts[2] = (parts[2]![0] === 'A' ? 'B' : 'A') + parts[2]!.slice(1);
    f.setExchange(async () => ({ ...value, access_token: parts.join('.') }));
    expect(await f.finish(await f.begin())).toBe(false);
    expect(await f.readSession()).toBeNull();
  });

  it('cancels delayed exchange A then keeps newly completed account B', async () => {
    const f = fixture();
    const waiting = deferred<ProviderResponse>();
    const entered = deferred<void>();
    f.setExchange(async () => { entered.resolve(); return waiting.promise; });
    const stateA = await f.begin();
    const callbackA = f.finish(stateA);
    await entered.promise;
    await f.invoke('signOut');
    f.setExchange(async () => response('user_fixture_b'));
    const stateB = await f.begin();
    expect(await f.finish(stateB)).toBe(true);
    waiting.resolve(await response('user_fixture_a'));
    expect(await callbackA).toBe(false);
    expect((await f.readSession())!.user.id).toBe('user_fixture_b');
    expect((await f.invoke('getUser')).data.account.id).toBe('user_fixture_b');
    expect(await f.finish(stateA)).toBe(false);
  });

  it('cancels delayed refresh A without overwriting new account B', async () => {
    const f = fixture();
    const initial = await response();
    await f.storage.run(async () => f.storage.sdk.setSession({
      accessToken: await token('user_fixture_a', { exp: 1 }),
      refreshToken: initial.refresh_token, user: initial.user as any,
    }));
    const waiting = deferred<ProviderResponse>();
    const entered = deferred<void>();
    f.setRefresh(async () => { entered.resolve(); return waiting.promise; });
    const reading = f.invoke('getUser');
    await entered.promise;
    await f.invoke('signOut');
    f.setExchange(async () => response('user_fixture_b'));
    expect(await f.finish(await f.begin())).toBe(true);
    waiting.resolve(await response());
    expect((await reading).ok).toBe(false);
    expect((await f.readSession())!.user.id).toBe('user_fixture_b');
    expect((await f.invoke('getUser')).data.account.id).toBe('user_fixture_b');
  });

  it('invalidates an authorization still sealing when cancellation arrives', async () => {
    const f = fixture();
    const entered = deferred<void>();
    const release = deferred<void>();
    const generate = f.client.pkce.generate.bind(f.client.pkce);
    vi.spyOn(f.client.pkce, 'generate').mockImplementation(async () => {
      entered.resolve(); await release.promise; return generate();
    });
    const beginning = f.invoke('signIn');
    await entered.promise;
    await f.invoke('signOut');
    release.resolve();
    expect((await beginning).ok).toBe(false);
    expect(f.opened).toEqual([]);
    expect(f.vault.values.has('pendingVerifiers')).toBe(false);
    expect((await f.invoke('getUser')).data.status).toBe('signed-out');
  });

  it('coalesces concurrent expired-session reads into one refresh', async () => {
    const f = fixture();
    await f.storage.run(async () => f.storage.sdk.setSession({
      accessToken: await token('user_fixture_a', { exp: 1 }),
      refreshToken: 'native-smoke-refresh-sentinel', user: { id: 'user_fixture_a' } as any,
    }));
    const wait = deferred<ProviderResponse>();
    const entered = deferred<void>();
    f.setRefresh(async () => { entered.resolve(); return wait.promise; });
    const reads = [f.invoke('getUser'), f.invoke('getUser'), f.invoke('getUser')];
    await entered.promise;
    wait.resolve(await response());
    expect((await Promise.all(reads)).map((v) => v.data.account.id)).toEqual(Array(3).fill('user_fixture_a'));
    expect(f.requests).toHaveLength(1);
  });

  it('retains encrypted session after transient refresh failure and retries without exposing errors', async () => {
    const f = fixture();
    await f.storage.run(async () => f.storage.sdk.setSession({
      accessToken: await token('user_fixture_a', { exp: 1 }), refreshToken: 'native-smoke-refresh-sentinel',
      user: { id: 'user_fixture_a' } as any,
    }));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    f.setRefresh(async () => { throw new Error('provider-secret native-smoke-refresh-sentinel'); });
    expect((await f.invoke('getUser')).data.status).toBe('signed-out');
    expect(await f.readSession()).not.toBeNull();
    f.setRefresh(async () => response());
    expect((await f.invoke('getUser')).data.status).toBe('signed-in');
    expect(JSON.stringify([warn.mock.calls, f.webContents.send.mock.calls])).not.toMatch(/provider-secret|native-smoke-refresh-sentinel/);
  });

  it('refuses a response after the requesting frame navigates to another origin', async () => {
    const f = fixture();
    const wait = deferred<ProviderResponse>();
    const entered = deferred<void>();
    await f.storage.run(async () => f.storage.sdk.setSession({ accessToken: await token('user_fixture_a', { exp: 1 }),
      refreshToken: 'native-smoke-refresh-sentinel', user: { id: 'user_fixture_a' } as any }));
    f.setRefresh(async () => { entered.resolve(); return wait.promise; });
    const reading = f.invoke('getUser');
    await entered.promise;
    f.frame.url = 'https://foreign.invalid/';
    wait.resolve(await response());
    expect((await reading).ok).toBe(false);
    expect(f.webContents.send).not.toHaveBeenCalled();
  });

  it('rejects same-origin foreign WebContents, subframes, every caller option and disabled channels', async () => {
    const f = fixture();
    for (const channel of ['getUser', 'signIn', 'signOut'] as const) {
      const handler = f.handlers.get(IPC_CHANNELS[channel])!;
      for (const event of [undefined, { ...f.event, sender: {} }, { ...f.event, senderFrame: { url: origin } }])
        expect(await handler(event)).toMatchObject({ ok: false });
      for (const argument of [null, {}, '', 0, false, ['fixture']])
        expect((await f.invoke(channel, argument)).ok).toBe(false);
    }
    expect((await f.invoke('getAccessToken')).ok).toBe(false);
    expect((await f.invoke('switchToOrganization')).ok).toBe(false);
    expect(f.opened).toEqual([]);
    expect(f.transport).not.toHaveBeenCalled();
  });

  it('keeps unconfigured Personal startup entirely offline', async () => {
    const f = fixture({ configured: false });
    expect((await f.invoke('getUser')).data.status).toBe('unavailable');
    expect((await f.invoke('signIn')).ok).toBe(false);
    expect(f.transport).not.toHaveBeenCalled();
    expect(f.openExternal).not.toHaveBeenCalled();
    expect(f.registerProtocol).not.toHaveBeenCalled();
  });

  it('clears local session without waiting for hosted browser logout', async () => {
    const f = fixture();
    expect(await f.finish(await f.begin())).toBe(true);
    const wait = deferred<void>();
    f.openExternal.mockImplementation(async () => wait.promise);
    expect((await f.invoke('signOut')).ok).toBe(true);
    expect(await f.readSession()).toBeNull();
    wait.resolve();
  });

  it('fails closed for a durable session write error and sanitizes the exception', async () => {
    const f = fixture();
    const state = await f.begin();
    const original = f.vault.store.set.getMockImplementation()!;
    f.vault.store.set.mockImplementation((key, value) => {
      if (key === 'session') throw new Error('disk detail native-smoke-refresh-sentinel');
      original(key, value);
    });
    expect(await f.finish(state)).toBe(false);
    expect((await f.invoke('getUser')).data.status).toBe('unavailable');
    expect((await f.invoke('signIn')).ok).toBe(false);
    expect(f.vault.values.has('session')).toBe(false);
    expect(JSON.stringify(f.webContents.send.mock.calls)).not.toMatch(/disk detail|native-smoke-refresh-sentinel/);
  });

  it('reopens encrypted pending state, completes cold callback once, and preserves cookie password', async () => {
    const a = fixture();
    const state = await a.begin();
    const challenge = new URL(a.opened[0]!).searchParams.get('code_challenge')!;
    const password = a.vault.values.get('cookiePassword');
    const serialized = JSON.stringify([...a.vault.values]);
    expect(serialized).not.toContain(state);
    a.auth.dispose();
    const b = fixture({ vault: a.vault });
    b.setChallenge(challenge);
    expect(await b.finish(state)).toBe(true);
    expect(await b.finish(state)).toBe(false);
    expect(b.vault.values.get('cookiePassword')).toBe(password);
    expect(b.opened).toEqual([]);
    expect((await b.invoke('getUser')).data.account.id).toBe('user_fixture_a');
  });

  it('honors a state-bound denial and refuses its replay without a token exchange', async () => {
    const f = fixture();
    const state = await f.begin();
    const url = `${callback}?error=access_denied&state=${encodeURIComponent(state)}&error_description=provider-secret`;
    expect(await f.auth.handleCallback(url)).toBe(true);
    expect(await f.auth.handleCallback(url)).toBe(false);
    expect(f.requests).toEqual([]);
    expect((await f.invoke('getUser')).data.status).toBe('signed-out');
    expect(JSON.stringify(f.webContents.send.mock.calls)).not.toContain('provider-secret');
  });

  it('drops state at the exact ten-minute TTL without provider traffic', async () => {
    const f = fixture();
    const start = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(start);
    const state = await f.begin();
    vi.mocked(Date.now).mockReturnValue(start + 600_000);
    expect(await f.finish(state)).toBe(false);
    expect(f.requests).toEqual([]);
    expect(f.vault.values.has('pendingVerifiers')).toBe(false);
  });
});

describe('independent callback routing', () => {
  it.each([
    'diomedes-auth://callback?state=x&code=y&%73tate=z',
    'diomedes-auth://callback?state=x&code=y&code%00=z',
    'diomedes-auth://callback?state=x%00&code=y',
    'diomedes-auth://callback?state=x&code=y%20z',
    'diomedes-auth://callback?state=x&error=no&code=',
    'diomedes-auth://callback?state=x&code=y&error_description=',
    'diomedes-auth://callback?state=' + 'x'.repeat(3801) + '&code=y',
  ])('rejects malformed callback %s', (url) => expect(parseNativeCallback(url)).toBeNull());

  it('serializes a foreign then valid cold callback through the production queue', async () => {
    const f = fixture();
    const state = await f.begin();
    const emitter = new EventEmitter();
    const app = Object.assign(emitter, { requestSingleInstanceLock: vi.fn(), quit: vi.fn(), setAsDefaultProtocolClient: vi.fn() });
    const capture = captureNativeAuthCallbacks(app as any, ['fixture.exe', callback + '?code=foreign&state=foreign']);
    owned.push(capture);
    const valid = `${callback}?code=valid&state=${encodeURIComponent(state)}`;
    emitter.emit('second-instance', {}, ['fixture.exe', valid]);
    const results: boolean[] = [];
    capture.connect(async (url) => { const result = await f.auth.handleCallback(url); results.push(result); return result; });
    await vi.waitFor(() => expect(results).toHaveLength(2));
    expect(results).toEqual([false, true]);
    expect((await f.invoke('getUser')).data.status).toBe('signed-in');
    expect(app.requestSingleInstanceLock).not.toHaveBeenCalled();
  });

  it('serializes a foreign then valid warm callback without dropping the valid event', async () => {
    const f = fixture();
    const state = await f.begin();
    const emitter = new EventEmitter();
    const app = Object.assign(emitter, { requestSingleInstanceLock: vi.fn(), quit: vi.fn(), setAsDefaultProtocolClient: vi.fn() });
    const capture = captureNativeAuthCallbacks(app as any, ['fixture.exe']);
    owned.push(capture);
    const results: boolean[] = [];
    capture.connect(async (url) => { const result = await f.auth.handleCallback(url); results.push(result); return result; });
    emitter.emit('second-instance', {}, ['fixture.exe', callback + '?code=foreign&state=foreign']);
    emitter.emit('second-instance', {}, ['fixture.exe', `${callback}?code=valid&state=${encodeURIComponent(state)}`]);
    await vi.waitFor(() => expect(results).toHaveLength(2));
    expect(results).toContain(true);
    expect((await f.invoke('getUser')).data.status).toBe('signed-in');
  });
});

describe('independent packaging provenance', () => {
  it('fingerprints every auth source and the bundler using the actual packaging snapshot function', async () => {
    const repo = path.resolve(import.meta.dirname, '..');
    const source = await fs.readFile(path.join(repo, 'scripts/package-desktop.mjs'), 'utf8');
    const start = source.indexOf('async function sourceSnapshot()');
    const end = source.indexOf('const source = await sourceSnapshot();', start);
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    const hashDefinition = source.match(/const sha256 = [^\n]+/)?.[0];
    expect(hashDefinition).toBeDefined();
    const body = `${hashDefinition}\n${source.slice(start, end)}`;
    expect(body).toContain('async function sourceSnapshot()');
    const stage = await fs.mkdtemp(path.join(repo, '.desktop-stage-native-auth-review-fingerprint-'));
    for (const dir of ['client', 'server', 'shared', 'desktop', 'fixtures', 'licenses', 'resources', 'dist', 'scripts'])
      await fs.mkdir(path.join(stage, dir));
    const inputs = ['desktop/native-auth.ts', 'desktop/native-auth-storage.ts', 'desktop/native-auth-preload.ts',
      'shared/native-auth.ts', 'client/console/NativeAccount.tsx', 'scripts/build-desktop-auth.mjs',
      'scripts/package-desktop.mjs', 'package.json', 'package-lock.json', 'LICENSE'];
    for (const file of inputs) {
      await fs.mkdir(path.dirname(path.join(stage, file)), { recursive: true });
      await fs.copyFile(path.join(repo, file), path.join(stage, file));
    }
    const snapshot = new vm.Script(`(async () => { ${body}; return sourceSnapshot(); })()`);
    const run = () => snapshot.runInNewContext({ fs, path, createHash, root: stage }) as Promise<Array<{path: string; sha256: string}>>;
    const before = await run();
    expect(before.map((item) => item.path).sort()).toEqual([...inputs].sort());
    for (const file of inputs.filter((name) => name.includes('native-auth') || name.includes('build-desktop-auth'))) {
      await fs.appendFile(path.join(stage, file), '\n// independent fingerprint mutation in owned copy\n');
      const after = await run();
      expect(after.find((item) => item.path === file)!.sha256).not.toBe(before.find((item) => item.path === file)!.sha256);
    }
  });
});
