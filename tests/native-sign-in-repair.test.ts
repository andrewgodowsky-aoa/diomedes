/** Synthetic provider and OS-event fixtures. No live identity or protocol registration. */
import { EventEmitter } from 'node:events';
import { createHash, createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { exportJWK, generateKeyPair, SignJWT, type JWTPayload } from 'jose';
import { createPublicWorkOS, IPC_CHANNELS } from '@workos/authkit-electron/internals';
import type { BrowserWindow } from 'electron';
import type { NativeAccountState } from '../shared/native-auth';

vi.mock('electron', () => ({ app: {}, safeStorage: {}, ipcMain: {}, shell: {}, BrowserWindow: {} }));
import { captureNativeAuthCallbacks, createNativeAuth } from '../desktop/native-auth';
import { createNativeTokenStorage } from '../desktop/native-auth-storage';

const clientId = 'client_repair_current_application';
const issuer = 'https://api.workos.com/user_management/client_repair_default_application';
const customIssuer = 'https://login.fixture.invalid/user_management/client_repair_default_application/';
const callback = 'diomedes-auth://callback';
const origin = 'http://127.0.0.1:43611';
const owned: Array<{ dispose(): void }> = [];
let keys: Awaited<ReturnType<typeof generateKeyPair>>;
let jwk: Awaited<ReturnType<typeof exportJWK>>;

beforeAll(async () => {
  keys = await generateKeyPair('RS256', { extractable: true });
  jwk = { ...(await exportJWK(keys.publicKey)), kid: 'repair-synthetic', alg: 'RS256', use: 'sig' };
});
afterEach(() => {
  for (const item of owned.splice(0)) item.dispose();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

async function token(claims: JWTPayload = {}) {
  return new SignJWT({ iss: issuer, client_id: clientId, sub: 'user_repair_fixture',
    sid: 'session_repair_fixture', exp: Math.floor(Date.now() / 1000) + 600, ...claims })
    .setProtectedHeader({ alg: 'RS256', kid: 'repair-synthetic' }).sign(keys.privateKey);
}

function fixture(options: { tokenIssuer?: string; claims?: JWTPayload } = { tokenIssuer: issuer }) {
  const values = new Map<string, unknown>();
  const key = randomBytes(32);
  const storage = createNativeTokenStorage({
    store: { get: (name) => values.get(name), set: (name, value) => { values.set(name, value); },
      delete: (name) => { values.delete(name); } },
    safeStorage: {
      isEncryptionAvailable: () => true, getSelectedStorageBackend: () => 'synthetic-aes-gcm',
      encryptString(text) {
        const nonce = randomBytes(12);
        const cipher = createCipheriv('aes-256-gcm', key, nonce);
        const data = Buffer.concat([cipher.update(text), cipher.final()]);
        return Buffer.concat([nonce, cipher.getAuthTag(), data]);
      },
      decryptString(bytes) {
        const decipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12));
        decipher.setAuthTag(bytes.subarray(12, 28));
        return Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString();
      },
    },
  });
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const frame = { url: origin + '/' };
  const webContents = { mainFrame: frame, isDestroyed: () => false, send: vi.fn() };
  const window = { webContents, isDestroyed: () => false };
  const event = { sender: webContents, senderFrame: frame };
  let authorization: URL;
  let claims = options.claims ?? {};
  const opened: string[] = [];
  const requests: string[] = [];
  const grants: string[] = [];
  const transport = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    requests.push(url);
    if (url === `https://api.workos.com/sso/jwks/${clientId}`) return Response.json({ keys: [jwk] });
    if (url !== 'https://api.workos.com/user_management/authenticate') throw new Error('Synthetic transport blocked request');
    const body = JSON.parse(String(init?.body));
    expect(body.client_id).toBe(clientId);
    expect(body.client_secret).toBeUndefined();
    expect(new Headers(init?.headers).has('authorization')).toBe(false);
    grants.push(body.grant_type);
    if (body.grant_type === 'authorization_code')
      expect(createHash('sha256').update(body.code_verifier).digest('base64url'))
        .toBe(authorization.searchParams.get('code_challenge'));
    else expect(body.grant_type).toBe('refresh_token');
    return Response.json({ access_token: await token(claims), refresh_token: 'repair-refresh-synthetic',
      user: { id: 'user_repair_fixture', first_name: 'Repair', last_name: 'Fixture',
        email: 'repair@fixture.invalid', email_verified: true }, authentication_method: 'Password' });
  });
  vi.stubGlobal('fetch', transport);
  const registerProtocol = vi.fn(() => true);
  const auth = createNativeAuth({ clientId, tokenIssuer: options.tokenIssuer, origin,
    getWindow: () => window as unknown as BrowserWindow, storage, client: createPublicWorkOS(clientId),
    ipcMain: { handle: (name, fn) => { handlers.set(name, fn); }, removeHandler: (name) => { handlers.delete(name); } },
    registerProtocol, shell: { openExternal: async (url) => { opened.push(url); authorization = new URL(url); } },
  });
  owned.push(auth);
  const invoke = async (name: keyof typeof IPC_CHANNELS) =>
    await handlers.get(IPC_CHANNELS[name])!(event) as { ok: boolean; data: NativeAccountState };
  const begin = async () => {
    expect((await invoke('signIn')).ok).toBe(true);
    return authorization.searchParams.get('state')!;
  };
  const finish = (state: string) => auth.handleCallback(`${callback}?code=synthetic&state=${encodeURIComponent(state)}`);
  return { auth, storage, values, invoke, begin, finish, opened, requests, grants, registerProtocol,
    setClaims: (value: JWTPayload) => { claims = value; } };
}

describe('trusted exact issuer configuration', () => {
  it.each([undefined, '', 'http://api.workos.com/user_management/client_fixture',
    ' https://api.workos.com', 'https://api.workos.com ', 'https://api.workos.com\n',
    'https://user:pass@api.workos.com', 'https://api.workos.com?query=issuer',
    'https://api.workos.com#fragment', '/user_management/client_fixture',
    'https://', 'https://api.workos.com/' + 'a'.repeat(2048),
  ])('disables sign-in for missing or malformed issuer %s', async (tokenIssuer) => {
    const f = fixture({ tokenIssuer });
    expect((await f.invoke('getUser')).data.status).toBe('unavailable');
    expect((await f.invoke('signIn')).ok).toBe(false);
    expect(await f.finish('untrusted-state')).toBe(false);
    expect(f.registerProtocol).not.toHaveBeenCalled();
    expect(f.opened).toEqual([]);
    expect(f.requests).toEqual([]);
  });

  it('does not infer issuer from the process environment inside the auth module', async () => {
    vi.stubEnv('DIOMEDES_WORKOS_TOKEN_ISSUER', issuer);
    const f = fixture({ tokenIssuer: undefined });
    expect((await f.invoke('getUser')).data.status).toBe('unavailable');
    expect((await f.invoke('signIn')).ok).toBe(false);
  });

  it.each([issuer, issuer + '/', customIssuer])('accepts exact configured issuer %s with a different current application', async (tokenIssuer) => {
    const f = fixture({ tokenIssuer, claims: { iss: tokenIssuer } });
    expect(await f.finish(await f.begin())).toBe(true);
    expect((await f.invoke('getUser')).data.account?.id).toBe('user_repair_fixture');
    expect(f.requests).toContain(`https://api.workos.com/sso/jwks/${clientId}`);
    expect(f.requests.every((url) => new URL(url).origin === 'https://api.workos.com')).toBe(true);
    expect(f.opened.every((url) => new URL(url).origin === 'https://api.workos.com')).toBe(true);
  });

  it.each(['https://api.workos.com', 'https://api.workos.com/', issuer + '/', customIssuer,
    `https://api.workos.com/user_management/${clientId}`, issuer.replace('default_application', 'other_environment'),
  ])('rejects a validly signed token from unconfigured issuer %s', async (actualIssuer) => {
    const f = fixture({ tokenIssuer: issuer, claims: { iss: actualIssuer } });
    expect(await f.finish(await f.begin())).toBe(false);
    expect((await f.invoke('getUser')).data.status).toBe('signed-out');
    expect(await f.storage.run(async () => f.storage.sdk.getSession())).toBeNull();
  });

  it('does not remove a configured trailing slash when comparing a signed issuer', async () => {
    const f = fixture({ tokenIssuer: issuer + '/', claims: { iss: issuer } });
    expect(await f.finish(await f.begin())).toBe(false);
  });

  it('requires the current client ID independently of a matching default-application issuer', async () => {
    const f = fixture({ tokenIssuer: issuer, claims: { client_id: 'client_repair_default_application' } });
    expect(await f.finish(await f.begin())).toBe(false);
    expect(await f.storage.run(async () => f.storage.sdk.getSession())).toBeNull();
  });

  it.each([issuer, 'https://other.fixture.invalid/user_management/client_fixture'])('checks exact issuer on refresh response %s', async (refreshedIssuer) => {
    const f = fixture();
    expect(await f.finish(await f.begin())).toBe(true);
    const session = await f.storage.run(async () => f.storage.sdk.getSession());
    expect(session).not.toBeNull();
    const expired = await token({ exp: 1 });
    await f.storage.run(async () => f.storage.sdk.setSession({ ...session!, accessToken: expired }));
    f.setClaims({ iss: refreshedIssuer });
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const shown = await f.invoke('getUser');
    expect(f.grants).toEqual(['authorization_code', 'refresh_token']);
    if (refreshedIssuer === issuer) {
      expect(shown.ok).toBe(true);
      expect(shown.data.account?.id).toBe('user_repair_fixture');
    } else {
      // The SDK returns an unauthenticated state after a rejected refresh.
      expect(shown.ok).toBe(true);
      expect(shown.data.status).toBe('signed-out');
      expect(shown.data.account).toBeNull();
      const retained = await f.storage.run(async () => f.storage.sdk.getSession());
      expect(retained?.accessToken).toBe(expired);
      expect(JSON.stringify(warning.mock.calls)).not.toContain('repair-refresh-synthetic');
    }
  });
});

function routing() {
  const emitter = new EventEmitter();
  const app = Object.assign(emitter, { requestSingleInstanceLock: vi.fn(), quit: vi.fn(), setAsDefaultProtocolClient: vi.fn() });
  const capture = captureNativeAuthCallbacks(app, ['fixture.exe']);
  owned.push(capture);
  const url = (name: string) => `${callback}?code=synthetic&state=${name}`;
  const emit = (name: string) => emitter.emit('second-instance', {}, ['fixture.exe', url(name)]);
  return { app, capture, url, emit };
}

describe('one bounded callback delivery queue', () => {
  it('keeps warm callbacks serial, deduplicates outstanding events and bounds outstanding work to four', async () => {
    const f = routing();
    const waiting = deferred<boolean>();
    const delivered: string[] = [];
    let active = 0;
    let maxActive = 0;
    f.capture.connect(async (url) => {
      active++;
      maxActive = Math.max(maxActive, active);
      delivered.push(url);
      if (url === f.url('first')) await waiting.promise;
      active--;
      return false;
    });
    f.emit('first');
    f.emit('first');
    f.emit('second');
    f.emit('second');
    for (const name of ['third', 'fourth', 'overflow']) f.emit(name);
    expect(delivered).toEqual([f.url('first')]);
    waiting.resolve(false);
    await vi.waitFor(() => expect(delivered).toHaveLength(4));
    expect(delivered).toEqual(['first', 'second', 'third', 'fourth'].map(f.url));
    expect(maxActive).toBe(1);
    f.emit('later');
    await vi.waitFor(() => expect(delivered).toHaveLength(5));
    expect(delivered.at(-1)).toBe(f.url('later'));
  });

  it('continues after a handler rejects without logging callback data or producing unhandled rejection', async () => {
    const f = routing();
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const delivered: string[] = [];
    f.capture.connect(async (url) => {
      delivered.push(url);
      if (url === f.url('reject')) throw new Error('repair-sensitive-callback-detail');
      return true;
    });
    f.emit('reject');
    f.emit('valid');
    await vi.waitFor(() => expect(delivered).toEqual([f.url('reject'), f.url('valid')]));
    expect(warning).toHaveBeenCalledOnce();
    expect(JSON.stringify(warning.mock.calls)).not.toMatch(/repair-sensitive|diomedes-auth|synthetic|state=/);
  });

  it('does not deliver queued events or accept new events after disposal', async () => {
    const f = routing();
    const waiting = deferred<boolean>();
    const delivered = vi.fn(async () => waiting.promise);
    f.capture.connect(delivered);
    f.emit('first');
    f.emit('queued');
    f.capture.dispose();
    waiting.resolve(false);
    await Promise.resolve();
    f.emit('after-dispose');
    expect(delivered).toHaveBeenCalledExactlyOnceWith(f.url('first'));
    expect(f.app.listenerCount('second-instance')).toBe(0);
    expect(f.app.listenerCount('open-url')).toBe(0);
  });

  it('delivers foreign, valid and replay warm events without extra SDK exchanges', async () => {
    const f = fixture();
    const state = await f.begin();
    const r = routing();
    const results: boolean[] = [];
    r.capture.connect(async (url) => { const value = await f.auth.handleCallback(url); results.push(value); return value; });
    r.emit('foreign');
    const valid = `${callback}?code=synthetic&state=${encodeURIComponent(state)}`;
    r.app.emit('open-url', { preventDefault: vi.fn() }, valid);
    await vi.waitFor(() => expect(results).toEqual([false, true]));
    r.app.emit('second-instance', {}, ['fixture.exe', valid]);
    await vi.waitFor(() => expect(results).toEqual([false, true, false]));
    expect(f.grants).toEqual(['authorization_code']);
    expect((await f.invoke('getUser')).data.status).toBe('signed-in');
  });
});
