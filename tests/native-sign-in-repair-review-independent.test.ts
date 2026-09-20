/** Independent v2 tests. Synthetic provider/JWKS/OS events only; no network
 * passthrough. Production modules and public WorkOS SDK are not mocked.
 */
import { EventEmitter } from 'node:events';
import { createHash, createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { generateKeyPair, exportJWK, SignJWT, type JWTPayload } from 'jose';
import { AuthKitCore, sessionEncryption } from '@workos/authkit-session';
import { createPublicWorkOS, IPC_CHANNELS, toAuthKitConfig } from '@workos/authkit-electron/internals';
import type { BrowserWindow } from 'electron';
vi.mock('electron', () => ({ app: {}, safeStorage: {}, ipcMain: {}, shell: {}, BrowserWindow: {} }));
import { createNativeAuth, captureNativeAuthCallbacks } from '../desktop/native-auth';
import { createNativeTokenStorage } from '../desktop/native-auth-storage';

const clientId = 'client_review_v2_current';
const issuer = 'https://login.review-v2.invalid/user_management/client_review_v2_default/';
const origin = 'http://127.0.0.1:45291';
const callback = 'diomedes-auth://callback';
const owned: Array<{ dispose(): void }> = [];
let key: Awaited<ReturnType<typeof generateKeyPair>>;
let jwk: Awaited<ReturnType<typeof exportJWK>>;
beforeAll(async () => {
  key = await generateKeyPair('RS256', { extractable: true });
  jwk = { ...(await exportJWK(key.publicKey)), kid: 'review-v2', use: 'sig', alg: 'RS256' };
});
afterEach(() => {
  for (const resource of owned.splice(0)) resource.dispose();
  vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs();
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
async function jwt(sub = 'user_v2_a', claims: JWTPayload = {}) {
  return new SignJWT({ iss: issuer, client_id: clientId, sub, sid: 'session_v2',
    exp: Math.floor(Date.now() / 1000) + 600, ...claims })
    .setProtectedHeader({ alg: 'RS256', kid: 'review-v2' }).sign(key.privateKey);
}
async function response(sub = 'user_v2_a', claims: JWTPayload = {}) {
  return { access_token: await jwt(sub, claims), refresh_token: 'native-smoke-refresh-sentinel',
    user: { id: sub, first_name: sub, last_name: 'Synthetic', email: 'same@review-v2.invalid', email_verified: true },
    authentication_method: 'Password' };
}
type ResponseBody = Awaited<ReturnType<typeof response>>;
function fixture(expectedIssuer: string | undefined = issuer) {
  const values = new Map<string, unknown>();
  const encryptionKey = randomBytes(32);
  const storage = createNativeTokenStorage({
    store: { get: (k) => values.get(k), set: (k, v) => { values.set(k, v); }, delete: (k) => { values.delete(k); } },
    safeStorage: {
      isEncryptionAvailable: () => true, getSelectedStorageBackend: () => 'synthetic-aes-gcm',
      encryptString(text) {
        const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', encryptionKey, iv);
        const encrypted = Buffer.concat([cipher.update(text), cipher.final()]);
        return Buffer.concat([iv, cipher.getAuthTag(), encrypted]);
      },
      decryptString(bytes) {
        const decipher = createDecipheriv('aes-256-gcm', encryptionKey, bytes.subarray(0, 12));
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
  const opened: URL[] = [];
  const challenges = new Set<string>();
  const requests: Array<{ url: string; body?: Record<string, string> }> = [];
  let exchange = async (_body: Record<string, string>): Promise<ResponseBody> => response();
  let refresh = async (_body: Record<string, string>): Promise<ResponseBody> => response();
  const transport = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url === `https://api.workos.com/sso/jwks/${clientId}`) {
      requests.push({ url }); return Response.json({ keys: [jwk] });
    }
    if (url !== 'https://api.workos.com/user_management/authenticate') throw new Error('No network passthrough');
    const body = JSON.parse(String(init?.body)) as Record<string, string>;
    requests.push({ url, body });
    expect(body.client_id).toBe(clientId);
    expect(body.client_secret).toBeUndefined();
    expect(new Headers(init?.headers).has('authorization')).toBe(false);
    if (body.grant_type === 'authorization_code') {
      expect(challenges.has(createHash('sha256').update(body.code_verifier!).digest('base64url'))).toBe(true);
      return Response.json(await exchange(body));
    }
    expect(body.grant_type).toBe('refresh_token');
    return Response.json(await refresh(body));
  });
  vi.stubGlobal('fetch', transport);
  const client = createPublicWorkOS(clientId);
  const registerProtocol = vi.fn(() => true);
  const options = { clientId, tokenIssuer: expectedIssuer, origin, storage, client, registerProtocol,
    getWindow: () => window as unknown as BrowserWindow,
    ipcMain: { handle: (k: string, fn: (...args: unknown[]) => unknown) => { handlers.set(k, fn); }, removeHandler: (k: string) => { handlers.delete(k); } },
    shell: { openExternal: async (destination: string) => {
      const url = new URL(destination); opened.push(url);
      const challenge = url.searchParams.get('code_challenge'); if (challenge) challenges.add(challenge);
    } },
  };
  const auth = createNativeAuth(options);
  owned.push(auth);
  const invoke = async (name: keyof typeof IPC_CHANNELS, ...args: unknown[]) =>
    await handlers.get(IPC_CHANNELS[name])!(event, ...args) as any;
  const begin = async () => {
    expect((await invoke('signIn')).ok).toBe(true);
    return opened.at(-1)!.searchParams.get('state')!;
  };
  const url = (state: string, code = 'synthetic') => `${callback}?code=${code}&state=${encodeURIComponent(state)}`;
  const finish = (state: string, code?: string) => auth.handleCallback(url(state, code));
  return { auth, storage, invoke, begin, url, finish, options, client, values, requests, transport, opened, registerProtocol, webContents,
    setExchange: (fn: typeof exchange) => { exchange = fn; }, setRefresh: (fn: typeof refresh) => { refresh = fn; },
    session: () => storage.run(async () => storage.sdk.getSession()),
  };
}
function routing(argv: string[] = ['review-fixture.exe']) {
  const emitter = new EventEmitter();
  const app = Object.assign(emitter, { quit: vi.fn(), requestSingleInstanceLock: vi.fn(), setAsDefaultProtocolClient: vi.fn() });
  const capture = captureNativeAuthCallbacks(app, argv);
  owned.push(capture);
  const emit = (url: string, kind: 'warm' | 'open-url' = 'warm') => {
    if (kind === 'warm') emitter.emit('second-instance', {}, ['review-fixture.exe', url]);
    else emitter.emit('open-url', { preventDefault: vi.fn() }, url);
  };
  const url = (state: string) => `${callback}?code=synthetic&state=${state}`;
  return { app, capture, emit, url };
}

describe('v2 independent exact issuer trust', () => {
  it('captures the configured issuer before later caller-object or environment changes', async () => {
    const f = fixture();
    f.options.tokenIssuer = 'https://changed.invalid/untrusted';
    vi.stubEnv('DIOMEDES_WORKOS_TOKEN_ISSUER', 'https://environment.invalid/untrusted');
    expect(await f.finish(await f.begin())).toBe(true);
    expect((await f.invoke('getUser')).data.account.id).toBe('user_v2_a');
    expect(f.requests.every(({ url }) => new URL(url).origin === 'https://api.workos.com')).toBe(true);
    expect(f.opened.every((url) => url.origin === 'https://api.workos.com')).toBe(true);
    expect(JSON.stringify(f.webContents.send.mock.calls)).not.toMatch(/review-v2\.invalid|accessToken|refreshToken|native-smoke-/);
  });

  it.each([
    issuer.replace('login.', 'LOGIN.'),
    issuer.replace('.invalid/', '.invalid:443/'),
    issuer.replace('user_management', '%75ser_management'),
    issuer.replace('/user_management/', '/unused/../user_management/'),
  ])('does not normalize a signed issuer into a configured issuer: %s', async (actualIssuer) => {
    const f = fixture();
    const value = await response('user_v2_a', { iss: actualIssuer });
    const rawSdk = new AuthKitCore(toAuthKitConfig({ clientId, redirectUri: callback }, 'fixture-password'.repeat(3)), f.client, sessionEncryption);
    expect(await rawSdk.verifyToken(value.access_token)).toBe(true);
    f.setExchange(async () => value);
    expect(await f.finish(await f.begin())).toBe(false);
    expect(await f.session()).toBeNull();
  });

  it('cannot supply a missing trusted issuer through IPC options or a callback parameter', async () => {
    const f = fixture('');
    expect((await f.invoke('signIn', { tokenIssuer: issuer, clientId })).ok).toBe(false);
    expect((await f.invoke('getUser', { tokenIssuer: issuer })).ok).toBe(false);
    expect(await f.auth.handleCallback(`${callback}?code=synthetic&state=x&issuer=${encodeURIComponent(issuer)}`)).toBe(false);
    expect((await f.invoke('getUser')).data.status).toBe('unavailable');
    expect(f.transport).not.toHaveBeenCalled();
    expect(f.registerProtocol).not.toHaveBeenCalled();
    expect(f.values.size).toBe(0);
  });

  it('checks current client on a refreshed token even when issuer and signature match', async () => {
    const f = fixture();
    expect(await f.finish(await f.begin())).toBe(true);
    const session = (await f.session())!;
    const expired = await jwt('user_v2_a', { exp: 1 });
    await f.storage.run(async () => f.storage.sdk.setSession({ ...session, accessToken: expired }));
    f.setRefresh(async () => response('user_v2_a', { client_id: 'client_review_v2_default' }));
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const shown = await f.invoke('getUser');
    expect(shown.data.account).toBeNull();
    expect((await f.session())!.accessToken).toBe(expired);
    expect(f.requests.filter((r) => r.body?.grant_type === 'refresh_token')).toHaveLength(1);
  });
});

describe('v2 independent admitted callback work', () => {
  it('preserves the first four cold admissions across mixed warm events and allows a dropped event to retry', async () => {
    const initial = `${callback}?code=synthetic&state=cold`;
    const r = routing(['review-fixture.exe', initial]);
    for (const name of ['b', 'c', 'd']) r.emit(r.url(name), 'open-url');
    r.emit(r.url('overflow'));
    const gate = deferred<boolean>();
    const delivered: string[] = [];
    r.capture.connect(async (url) => {
      delivered.push(url);
      if (url === initial) return gate.promise;
      return false;
    });
    r.emit(initial); // Duplicate in progress consumes no extra capacity.
    r.emit(r.url('overflow'));
    expect(delivered).toEqual([initial]);
    gate.resolve(false);
    await vi.waitFor(() => expect(delivered).toHaveLength(4));
    expect(delivered).toEqual([initial, r.url('b'), r.url('c'), r.url('d')]);
    r.emit(r.url('overflow'));
    await vi.waitFor(() => expect(delivered).toHaveLength(5));
    expect(delivered[4]).toBe(r.url('overflow'));
    expect(r.app.requestSingleInstanceLock).not.toHaveBeenCalled();
  });

  it('does not let malformed URLs consume the last admitted queue slot', async () => {
    const r = routing();
    const gate = deferred<boolean>();
    const delivered: string[] = [];
    r.capture.connect(async (url) => { delivered.push(url); return url === r.url('a') ? gate.promise : false; });
    for (const name of ['a', 'b', 'c']) r.emit(r.url(name));
    for (const bad of [callback + '/?code=x&state=y', callback + '?code=x&state=y&state=z',
      'https://callback?code=x&state=y', callback + '?code=x&state=y#fragment']) r.emit(bad, 'open-url');
    r.emit(r.url('d'));
    gate.resolve(false);
    await vi.waitFor(() => expect(delivered).toEqual(['a', 'b', 'c', 'd'].map(r.url)));
  });

  it('keeps reentrant arrivals after a synchronous handler throw and ignores a second connect', async () => {
    const r = routing();
    const delivered: string[] = [];
    const replacement = vi.fn(async () => true);
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    r.capture.connect((url) => {
      delivered.push(url);
      if (url === r.url('first')) {
        r.emit(r.url('second'), 'open-url');
        throw new Error('sensitive callback detail');
      }
      if (url === r.url('second')) r.emit(r.url('third'));
      return Promise.resolve(false);
    });
    r.capture.connect(replacement);
    r.emit(r.url('first'));
    await vi.waitFor(() => expect(delivered).toEqual(['first', 'second', 'third'].map(r.url)));
    expect(replacement).not.toHaveBeenCalled();
    expect(warning.mock.calls).toEqual([['Native sign-in callback could not be delivered.']]);
  });

  it('keeps newly admitted login B after canceling a delayed exchange A through the serial queue', async () => {
    const f = fixture();
    const r = routing();
    const results: boolean[] = [];
    r.capture.connect(async (url) => { const value = await f.auth.handleCallback(url); results.push(value); return value; });
    const exchange = deferred<ResponseBody>();
    const entered = deferred<void>();
    f.setExchange(async () => { entered.resolve(); return exchange.promise; });
    const stateA = await f.begin();
    r.emit(f.url(stateA));
    await entered.promise;
    expect((await f.invoke('signOut')).ok).toBe(true);
    f.setExchange(async () => response('user_v2_b'));
    const stateB = await f.begin();
    r.emit(f.url(stateB), 'open-url');
    exchange.resolve(await response('user_v2_a'));
    await vi.waitFor(() => expect(results).toEqual([false, true]));
    expect((await f.session())!.user.id).toBe('user_v2_b');
    expect((await f.invoke('getUser')).data.account.id).toBe('user_v2_b');
  });

  it('rejects canceled queued state A but still delivers following valid state B', async () => {
    const f = fixture();
    const r = routing();
    const gate = deferred<void>();
    const results: boolean[] = [];
    r.capture.connect(async (url) => {
      if (url === r.url('foreign')) await gate.promise;
      const value = await f.auth.handleCallback(url); results.push(value); return value;
    });
    const stateA = await f.begin();
    r.emit(r.url('foreign'));
    r.emit(f.url(stateA));
    await f.invoke('signOut');
    f.setExchange(async () => response('user_v2_b'));
    const stateB = await f.begin();
    r.emit(f.url(stateB));
    gate.resolve();
    await vi.waitFor(() => expect(results).toEqual([false, false, true]));
    expect(f.requests.filter((item) => item.body?.grant_type === 'authorization_code')).toHaveLength(1);
    expect((await f.session())!.user.id).toBe('user_v2_b');
  });

  it('expires a state while it waits in the queue without exchanging a code', async () => {
    const f = fixture();
    const start = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(start);
    const state = await f.begin();
    const r = routing();
    const gate = deferred<void>();
    const results: boolean[] = [];
    r.capture.connect(async (url) => {
      if (url === r.url('foreign')) await gate.promise;
      const value = await f.auth.handleCallback(url); results.push(value); return value;
    });
    r.emit(r.url('foreign'));
    r.emit(f.url(state));
    vi.mocked(Date.now).mockReturnValue(start + 600_000);
    gate.resolve();
    await vi.waitFor(() => expect(results).toEqual([false, false]));
    expect(f.requests).toEqual([]);
    expect(f.values.has('pendingVerifiers')).toBe(false);
  });

  it('serializes differently spelled callbacks for the same state but exchanges only once', async () => {
    const f = fixture();
    const r = routing();
    const results: boolean[] = [];
    r.capture.connect(async (url) => { const value = await f.auth.handleCallback(url); results.push(value); return value; });
    const state = await f.begin();
    r.emit(f.url(state));
    r.emit(`${callback}?state=${encodeURIComponent(state)}&code=synthetic`, 'open-url');
    r.emit(f.url(state)); // Same spelling coalesces while still outstanding.
    await vi.waitFor(() => expect(results).toEqual([true, false]));
    expect(f.requests.filter((item) => item.body?.grant_type === 'authorization_code')).toHaveLength(1);
    expect((await f.invoke('getUser')).data.status).toBe('signed-in');
  });

  it('does not deliver accepted queued work after disposal during a handler', async () => {
    const r = routing();
    const seen: string[] = [];
    r.capture.connect(async (url) => {
      seen.push(url);
      r.emit(r.url('queued'));
      r.capture.dispose();
      return true;
    });
    r.emit(r.url('active'));
    await Promise.resolve();
    r.emit(r.url('after'));
    expect(seen).toEqual([r.url('active')]);
    expect(r.app.listenerCount('open-url')).toBe(0);
    expect(r.app.listenerCount('second-instance')).toBe(0);
  });
});
