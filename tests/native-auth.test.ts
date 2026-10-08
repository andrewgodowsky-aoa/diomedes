import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import http from 'node:http';
import net from 'node:net';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { AuthKitCore } from '@workos/authkit-session';
import { createPublicWorkOS, IPC_CHANNELS } from '@workos/authkit-electron/internals';

vi.mock('electron', () => ({
  app: {},
  safeStorage: {},
  ipcMain: {},
  BrowserWindow: {},
  shell: {},
}));
import {
  captureNativeAuthCallbacks,
  createNativeAuth,
  NATIVE_AUTH_LOOPBACK_CALLBACK,
  parseNativeCallback,
} from '../desktop/native-auth';
import { createNativeTokenStorage } from '../desktop/native-auth-storage';

const clientId = 'client_native_fixture';
const origin = 'http://127.0.0.1:41371';
const callback = 'diomedes-auth://callback';

// A port this file holds for its whole run. A fixture given it cannot bind the loopback callback,
// so it signs in through diomedes-auth://callback exactly as before. No test touches 47319, which
// the installed app may be using.
let held: net.Server;
let heldPort: number;
beforeAll(async () => {
  held = net.createServer();
  await new Promise<void>((resolve) => held.listen(0, '127.0.0.1', resolve));
  heldPort = (held.address() as net.AddressInfo).port;
});
afterAll(async () => {
  await new Promise<void>((resolve) => held.close(() => resolve()));
});
/** A port nothing listens on just now. */
async function freePort() {
  const probe = net.createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const { port } = probe.address() as net.AddressInfo;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}
type Answer = { status: number; headers: http.IncomingHttpHeaders; body: string; raw: string };
/** One plain HTTP request to the loopback listener, with full control of method, path and Host. */
function request(port: number, target: string, options: { method?: string; host?: string } = {}) {
  return new Promise<Answer>((resolve, reject) => {
    const outgoing = http.request(
      {
        host: '127.0.0.1',
        port,
        method: options.method ?? 'GET',
        path: target,
        headers: { host: options.host ?? `127.0.0.1:${port}` },
        agent: false,
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf8');
          resolve({
            status: response.statusCode!,
            headers: response.headers,
            body,
            raw: JSON.stringify(response.rawHeaders) + body,
          });
        });
      },
    );
    outgoing.on('error', reject);
    outgoing.end();
  });
}
/** Resolves true when nothing accepts a connection on the port. */
function refused(port: number) {
  return new Promise<boolean>((resolve) => {
    const socket = net.connect(port, '127.0.0.1');
    socket.once('connect', () => {
      socket.destroy();
      resolve(false);
    });
    socket.once('error', (error: NodeJS.ErrnoException) => resolve(error.code === 'ECONNREFUSED'));
  });
}
const SIGNED_IN = "You're signed in. You can close this tab.";
const NOT_FINISHED = 'Sign-in could not finish. Try again.';
function jwt(subject = 'user_a') {
  return (
    [
      { alg: 'RS256', typ: 'JWT' },
      {
        iss: 'https://api.workos.com',
        client_id: clientId,
        sub: subject,
        sid: 'session_a',
        exp: Math.floor(Date.now() / 1000) + 300,
      },
    ]
      .map((x) => Buffer.from(JSON.stringify(x)).toString('base64url'))
      .join('.') + '.fixture-signature'
  );
}

function fixture(
  configured = true,
  values = new Map<string, unknown>(),
  callbackPort = heldPort,
  callbackPageLimitMs?: number,
  attemptLimitMs?: number,
) {
  const secure = {
    isEncryptionAvailable: vi.fn(() => true),
    getSelectedStorageBackend: () => 'dpapi',
    encryptString: (s: string) => Buffer.from([...s].reverse().join('')),
    decryptString: (b: Buffer) => [...b.toString()].reverse().join(''),
  };
  const storage = createNativeTokenStorage({
    safeStorage: secure,
    store: {
      get: (k: string) => values.get(k),
      set: (k: string, v: unknown) => {
        values.set(k, v);
      },
      delete: (k: string) => {
        values.delete(k);
      },
    },
  });
  const handlers = new Map<string, (...args: any[]) => any>();
  const ipc = {
    handle: (key: string, fn: (...args: any[]) => any) => {
      handlers.set(key, fn);
    },
    removeHandler: (key: string) => {
      handlers.delete(key);
    },
  };
  const frame = { url: origin + '/' };
  const webContents = {
    mainFrame: frame,
    isDestroyed: () => false,
    getURL: () => frame.url,
    send: vi.fn(),
  };
  const window = { webContents, isDestroyed: () => false };
  const event = { sender: webContents, senderFrame: frame };
  const openExternal = vi.fn(async (_url: string) => {});
  const client = createPublicWorkOS(clientId);
  const user = {
    id: 'user_a',
    firstName: 'A',
    lastName: 'User',
    email: 'same@example.test',
    emailVerified: true,
  };
  // Cryptographic JWKS verification is the injected fixture seam. SDK PKCE
  // generation, sealing, verification, lifecycle and IPC are real in this test.
  vi.spyOn(AuthKitCore.prototype, 'verifyToken').mockResolvedValue(true);
  const exchange = vi
    .spyOn(client.userManagement, 'authenticateWithCode')
    .mockImplementation(async (args) => {
      const challenge = new URL(openExternal.mock.calls[0]![0]).searchParams.get('code_challenge');
      if (createHash('sha256').update(args.codeVerifier!).digest('base64url') !== challenge)
        throw new Error('PKCE mismatch');
      return { accessToken: jwt(user.id), refreshToken: 'refresh-fixture', user } as any;
    });
  const refresh = vi.spyOn(client.userManagement, 'authenticateWithRefreshToken');
  const registerProtocol = vi.fn(() => true);
  const auth = createNativeAuth({
    clientId: configured ? clientId : undefined,
    tokenIssuer: 'https://api.workos.com', // Explicit synthetic fixture issuer.
    origin,
    getWindow: () => window as any,
    storage,
    client,
    ipcMain: ipc,
    shell: { openExternal },
    registerProtocol,
    callbackPort,
    callbackPageLimitMs,
    attemptLimitMs,
  });
  const invoke = (name: keyof typeof IPC_CHANNELS, ...args: unknown[]) =>
    handlers.get(IPC_CHANNELS[name])!(event, ...args);
  const signIn = async () => {
    await invoke('signIn');
    return new URL(openExternal.mock.calls.at(-1)![0]).searchParams.get('state')!;
  };
  return {
    auth,
    invoke,
    signIn,
    handlers,
    event,
    frame,
    webContents,
    openExternal,
    exchange,
    refresh,
    user,
    storage,
    secure,
    registerProtocol,
    values,
    client,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('native callback parser', () => {
  it.each([
    'https://callback?code=x&state=y',
    'diomedes-auth://other?code=x&state=y',
    'diomedes-auth://callback/../?code=x&state=y',
    'diomedes-auth://callback//?code=x&state=y',
    'diomedes-auth://callback/x?code=x&state=y',
    'diomedes-auth://callback/%2e%2e/?code=x&state=y',
    'diomedes-auth://callback/?code=x&state=y#x',
    'diomedes-auth://callback/',
    'diomedes-auth://user@callback?code=x&state=y',
    'diomedes-auth://callback:12?code=x&state=y',
    'diomedes-auth://callback?code=x&state=y#x',
    'diomedes-auth://callback?code=x&code=z&state=y',
    'diomedes-auth://callback?code=x&state=y&state=z',
    'diomedes-auth://callback?code=x',
    'diomedes-auth://callback?code=x&state=y&next=file:///a',
    'diomedes-auth://callback?code=x&error=no&state=y',
    'diomedes-auth://callback?code=x&state=y&error=',
  ])('rejects hostile callback %s', (url) => expect(parseNativeCallback(url)).toBeNull());
  it('accepts only a bounded successful callback or state-bound denial', () => {
    expect(parseNativeCallback(callback + '?code=abc&state=xyz')).toEqual({
      code: 'abc',
      state: 'xyz',
    });
    expect(
      parseNativeCallback(callback + '?error=access_denied&state=xyz&error_description=secret'),
    ).toEqual({ error: true, state: 'xyz' });
  });
  // Windows' shell hands a protocol handler the URL with one slash added before the query,
  // whichever browser launched it: diomedes-auth://callback?code=… arrives as
  // diomedes-auth://callback/?code=… (checked on Windows 11, 2026-10-02).
  it('accepts the Windows shell form, with one slash before the query, as the same callback', () => {
    expect(parseNativeCallback(callback + '/?code=abc&state=xyz')).toEqual({
      code: 'abc',
      state: 'xyz',
    });
    expect(parseNativeCallback(callback + '/?error=access_denied&state=xyz')).toEqual({
      error: true,
      state: 'xyz',
    });
  });
});

describe('official SDK native boundary', () => {
  it('leaves unconfigured Personal startup offline and exposes an honest unavailable state', async () => {
    const f = fixture(false);
    expect((await f.invoke('getUser')).data.status).toBe('unavailable');
    expect((await f.invoke('signIn')).ok).toBe(false);
    expect(f.openExternal).not.toHaveBeenCalled();
    expect(f.registerProtocol).not.toHaveBeenCalled();
    expect(f.exchange).not.toHaveBeenCalled();
  });

  it('binds IPC to exact WebContents, its main frame and this launch origin', async () => {
    const f = fixture();
    const handler = f.handlers.get(IPC_CHANNELS.signIn)!;
    for (const event of [
      {},
      { sender: {}, senderFrame: f.frame },
      { sender: f.webContents, senderFrame: { url: origin } },
    ])
      expect((await handler(event)).ok).toBe(false);
    for (const url of ['https://evil.test', 'http://localhost:41371', 'http://127.0.0.1:41372']) {
      f.frame.url = url;
      expect((await handler(f.event)).ok).toBe(false);
    }
    expect(f.openExternal).not.toHaveBeenCalled();
  });

  it('uses real SDK PKCE, consumes callback once, and returns no tokens or provider grants', async () => {
    const f = fixture();
    const state = await f.signIn();
    const authorization = new URL(f.openExternal.mock.calls[0]![0]);
    expect(authorization.origin).toBe('https://api.workos.com');
    expect(authorization.searchParams.get('code_challenge_method')).toBe('S256');
    expect(authorization.searchParams.get('redirect_uri')).toBe(callback);
    expect(
      await f.auth.handleCallback(callback + '?code=abc&state=' + encodeURIComponent(state)),
    ).toBe(true);
    expect(
      await f.auth.handleCallback(callback + '?code=abc&state=' + encodeURIComponent(state)),
    ).toBe(false);
    expect(f.exchange).toHaveBeenCalledTimes(1);
    const result = await f.invoke('getUser');
    expect(result.data).toMatchObject({
      status: 'signed-in',
      account: { id: 'user_a', name: 'A User' },
    });
    expect(JSON.stringify([result, f.webContents.send.mock.calls])).not.toMatch(
      /refresh-fixture|fixture-signature|accessToken|refreshToken|permissions|entitlements/,
    );
    expect((await f.invoke('getAccessToken')).ok).toBe(false);
    expect((await f.invoke('switchToOrganization', 'org_forged')).ok).toBe(false);
  });

  it('rejects wrong state without replacing the active login, and double delivery exchanges once', async () => {
    const f = fixture();
    const state = await f.signIn();
    expect(await f.auth.handleCallback(callback + '?code=abc&state=wrong')).toBe(false);
    const url = callback + '?code=abc&state=' + encodeURIComponent(state);
    await Promise.all([f.auth.handleCallback(url), f.auth.handleCallback(url)]);
    expect(f.exchange).toHaveBeenCalledTimes(1);
  });

  it('cancels an in-flight callback on logout and refuses a cold replay afterward', async () => {
    const f = fixture();
    const state = await f.signIn();
    let complete!: (value: any) => void;
    f.exchange.mockImplementation(
      () =>
        new Promise((resolve) => {
          complete = resolve;
        }),
    );
    const url = callback + '?code=abc&state=' + encodeURIComponent(state);
    const pending = f.auth.handleCallback(url);
    await vi.waitFor(() => expect(complete).toBeTypeOf('function'));
    expect((await f.invoke('signOut')).ok).toBe(true);
    complete({ accessToken: jwt(), refreshToken: 'refresh-fixture', user: f.user });
    expect(await pending).toBe(false);
    expect((await f.invoke('getUser')).data.status).toBe('signed-out');
    expect(await f.auth.handleCallback(url)).toBe(false);
    expect(await f.storage.run(async () => f.storage.sdk.getSession())).toBeNull();
  });

  it('refuses expired callbacks, caller options, and unavailable secure storage', async () => {
    vi.useFakeTimers();
    const f = fixture();
    expect((await f.invoke('signIn', { organizationId: 'org_injected' })).ok).toBe(false);
    const state = await f.signIn();
    vi.advanceTimersByTime(600_001);
    expect(
      await f.auth.handleCallback(callback + '?code=x&state=' + encodeURIComponent(state)),
    ).toBe(false);
    expect(f.exchange).not.toHaveBeenCalled();
    f.secure.isEncryptionAvailable.mockReturnValue(false);
    expect((await f.invoke('getUser')).data.status).toBe('unavailable');
    expect((await f.invoke('signIn')).ok).toBe(false);
  });

  it('completes a cold-launch callback from an encrypted verifier without a new ceremony', async () => {
    const first = fixture();
    const state = await first.signIn();
    const challenge = new URL(first.openExternal.mock.calls[0]![0]).searchParams.get(
      'code_challenge',
    );
    first.auth.dispose();
    const reopened = fixture(true, first.values);
    reopened.exchange.mockImplementation(async (args) => {
      expect(createHash('sha256').update(args.codeVerifier!).digest('base64url')).toBe(challenge);
      return { accessToken: jwt(), refreshToken: 'refresh-fixture', user: reopened.user } as any;
    });
    expect(
      await reopened.auth.handleCallback(
        callback + '?code=cold&state=' + encodeURIComponent(state),
      ),
    ).toBe(true);
    expect((await reopened.invoke('getUser')).data.account.id).toBe('user_a');
    expect(reopened.openExternal).not.toHaveBeenCalled();
  });

  it('completes sign-in from the URL Windows hands the app after the browser finishes', async () => {
    const f = fixture();
    const state = await f.signIn();
    expect(
      await f.auth.handleCallback(callback + '/?code=windows&state=' + encodeURIComponent(state)),
    ).toBe(true);
    expect(f.exchange).toHaveBeenCalledOnce();
    expect((await f.invoke('getUser')).data.account.id).toBe('user_a');
  });

  it('drops a late refresh result after logout without restoring the stored session', async () => {
    const f = fixture();
    const state = await f.signIn();
    await f.auth.handleCallback(callback + '?code=x&state=' + encodeURIComponent(state));
    vi.mocked(AuthKitCore.prototype.verifyToken).mockResolvedValueOnce(false);
    let finish!: (value: any) => void;
    f.refresh.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const reading = f.invoke('getUser');
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
    await f.invoke('signOut');
    finish({ accessToken: jwt(), refreshToken: 'late-refresh-secret', user: f.user });
    expect((await reading).ok).toBe(false);
    expect((await f.invoke('getUser')).data.status).toBe('signed-out');
    expect(await f.storage.run(async () => f.storage.sdk.getSession())).toBeNull();
  });

  it('uses subject identity when two sequential accounts share the same email', async () => {
    const f = fixture();
    const first = await f.signIn();
    await f.auth.handleCallback(callback + '?code=a&state=' + encodeURIComponent(first));
    await f.invoke('signOut');
    f.user.id = 'user_b';
    f.exchange.mockResolvedValue({
      accessToken: jwt('user_b'),
      refreshToken: 'refresh-b',
      user: f.user,
    } as any);
    const second = await f.signIn();
    await f.auth.handleCallback(callback + '?code=b&state=' + encodeURIComponent(second));
    expect((await f.invoke('getUser')).data.account.id).toBe('user_b');
    expect(
      await f.auth.handleCallback(callback + '?code=a&state=' + encodeURIComponent(first)),
    ).toBe(false);
  });

  it.each(['issuer', 'client', 'algorithm', 'expired', 'subject', 'signature'])(
    'rejects %s mismatch even when the signature seam accepts',
    async (kind) => {
      const f = fixture();
      const state = await f.signIn();
      const parts = jwt().split('.');
      const header = JSON.parse(Buffer.from(parts[0]!, 'base64url').toString());
      const claims = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString());
      if (kind === 'issuer') claims.iss = 'https://evil.example';
      if (kind === 'client') claims.client_id = 'client_other';
      if (kind === 'algorithm') header.alg = 'HS256';
      if (kind === 'expired') claims.exp = 1;
      if (kind === 'subject') claims.sub = 'user_other';
      if (kind === 'signature')
        vi.mocked(AuthKitCore.prototype.verifyToken).mockResolvedValue(false);
      const accessToken =
        [header, claims]
          .map((v) => Buffer.from(JSON.stringify(v)).toString('base64url'))
          .join('.') + '.fixture-signature';
      f.exchange.mockResolvedValue({
        accessToken,
        refreshToken: 'refresh-fixture',
        user: f.user,
      } as any);
      expect(
        await f.auth.handleCallback(callback + '?code=x&state=' + encodeURIComponent(state)),
      ).toBe(false);
      expect((await f.invoke('getUser')).data.status).toBe('signed-out');
      expect(await f.storage.run(async () => f.storage.sdk.getSession())).toBeNull();
    },
  );

  it('redacts provider failure details and refuses a replaced browser destination', async () => {
    const f = fixture();
    const state = await f.signIn();
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    f.exchange.mockRejectedValue(new Error('refresh-fixture and secret-verifier'));
    expect(
      await f.auth.handleCallback(
        callback + '?code=secret-code&state=' + encodeURIComponent(state),
      ),
    ).toBe(false);
    expect(
      JSON.stringify([f.webContents.send.mock.calls, warning.mock.calls, error.mock.calls]),
    ).not.toMatch(/refresh-fixture|secret-code|secret-verifier/);
    f.openExternal.mockClear();
    vi.spyOn(f.client.userManagement, 'getAuthorizationUrl').mockReturnValue(
      'https://evil.example/steal',
    );
    expect((await f.invoke('signIn')).ok).toBe(false);
    expect(f.openExternal).not.toHaveBeenCalled();
  });

  it('fails a wrong PKCE challenge at code exchange and consumes the transaction', async () => {
    const f = fixture();
    vi.spyOn(f.client.pkce, 'generate').mockResolvedValue({
      codeVerifier: 'v'.repeat(43),
      codeChallenge: 'A'.repeat(43),
      codeChallengeMethod: 'S256',
    });
    const state = await f.signIn();
    const url = callback + '?code=pkce&state=' + encodeURIComponent(state);
    expect(await f.auth.handleCallback(url)).toBe(false);
    expect(await f.auth.handleCallback(url)).toBe(false);
    expect(f.exchange).toHaveBeenCalledTimes(1);
    expect((await f.invoke('getUser')).data.status).toBe('signed-out');
  });

  it('buffers cold and early running-process callbacks without a second lock or navigation', async () => {
    const app = new EventEmitter() as any;
    app.requestSingleInstanceLock = vi.fn(() => {
      throw new Error('Already owned by main');
    });
    const cold = callback + '?code=abc&state=cold';
    const capture = captureNativeAuthCallbacks(app, ['app.exe', cold]);
    app.emit('second-instance', {}, ['app.exe', 'diomedes-auth://evil?code=x&state=y']);
    const deliver = vi.fn(async () => true);
    capture.connect(deliver);
    await Promise.resolve();
    expect(deliver).toHaveBeenCalledExactlyOnceWith(cold);
    const preventDefault = vi.fn();
    app.emit('open-url', { preventDefault }, callback + '?code=x&state=warm');
    expect(deliver).toHaveBeenCalledTimes(2);
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(app.requestSingleInstanceLock).not.toHaveBeenCalled();
    capture.dispose();
    expect(app.listenerCount('open-url')).toBe(0);
  });

  it('delivers the Windows shell form from a cold launch and from a second instance', async () => {
    const app = new EventEmitter() as any;
    app.requestSingleInstanceLock = vi.fn(() => {
      throw new Error('Already owned by main');
    });
    const cold = callback + '/?code=abc&state=cold';
    const capture = captureNativeAuthCallbacks(app, ['app.exe', cold]);
    const deliver = vi.fn(async () => true);
    capture.connect(deliver);
    await vi.waitFor(() => expect(deliver).toHaveBeenCalledExactlyOnceWith(cold));
    const warm = callback + '/?code=def&state=warm';
    app.emit('second-instance', {}, ['app.exe', '--allow-file-access-from-files', warm]);
    await vi.waitFor(() => expect(deliver).toHaveBeenLastCalledWith(warm));
    expect(deliver).toHaveBeenCalledTimes(2);
    capture.dispose();
  });
});

describe('loopback callback page', () => {
  const owned: Array<{ dispose(): void }> = [];
  afterEach(() => {
    for (const item of owned.splice(0)) item.dispose();
  });
  /** A launch whose callback port is free, so its attempts take the loopback redirect. */
  async function loopback(pageLimitMs?: number) {
    const port = await freePort();
    const f = fixture(true, new Map(), port, pageLimitMs);
    owned.push(f.auth);
    return { ...f, port, redirect: `http://127.0.0.1:${port}/callback` };
  }
  const at = (state: string, code = 'loopback-code-sentinel') =>
    `/callback?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`;
  const redirectOf = (f: { openExternal: { mock: { calls: string[][] } } }) =>
    new URL(f.openExternal.mock.calls.at(-1)![0]!).searchParams.get('redirect_uri');

  it('pins the production loopback redirect WorkOS accepts', () => {
    expect(NATIVE_AUTH_LOOPBACK_CALLBACK).toBe('http://127.0.0.1:47319/callback');
  });

  it('signs in through the loopback page when the port is free, then closes the port', async () => {
    const f = await loopback();
    const state = await f.signIn();
    expect(redirectOf(f)).toBe(f.redirect);
    expect(await refused(f.port)).toBe(false);
    const answer = await request(f.port, at(state));
    expect(answer.status).toBe(200);
    expect(answer.body).toContain(SIGNED_IN);
    expect(answer.body).not.toContain(NOT_FINISHED);
    for (const secret of ['loopback-code-sentinel', state, encodeURIComponent(state)])
      expect(answer.raw).not.toContain(secret);
    expect(f.exchange).toHaveBeenCalledOnce();
    expect((await f.invoke('getUser')).data).toMatchObject({
      status: 'signed-in',
      account: { id: 'user_a' },
    });
    expect(await refused(f.port)).toBe(true);
  });

  it('falls back to diomedes-auth://callback when the port is already held', async () => {
    const holder = net.createServer();
    await new Promise<void>((resolve) => holder.listen(0, '127.0.0.1', resolve));
    try {
      const port = (holder.address() as net.AddressInfo).port;
      const f = fixture(true, new Map(), port);
      owned.push(f.auth);
      const state = await f.signIn();
      expect(redirectOf(f)).toBe(callback);
      expect(
        await f.auth.handleCallback(callback + '?code=abc&state=' + encodeURIComponent(state)),
      ).toBe(true);
      expect((await f.invoke('getUser')).data.status).toBe('signed-in');
    } finally {
      await new Promise<void>((resolve) => holder.close(() => resolve()));
    }
  });

  it('closes the port when the protocol callback finishes a loopback attempt', async () => {
    const f = await loopback();
    const state = await f.signIn();
    expect(await refused(f.port)).toBe(false);
    expect(
      await f.auth.handleCallback(callback + '?code=abc&state=' + encodeURIComponent(state)),
    ).toBe(true);
    expect(await refused(f.port)).toBe(true);
  });

  it('answers with fixed bytes, no script, and headers that allow only its inline style', async () => {
    const f = await loopback();
    const state = await f.signIn();
    const failed = await request(f.port, at('wrong'));
    expect((await request(f.port, at('other', 'other-code'))).body).toBe(failed.body);
    const done = await request(f.port, at(state));
    for (const [answer, sentence] of [
      [done, SIGNED_IN],
      [failed, NOT_FINISHED],
    ] as const) {
      expect(answer.headers['content-type']).toBe('text/html; charset=utf-8');
      expect(answer.headers['cache-control']).toBe('no-store');
      expect(answer.headers['x-content-type-options']).toBe('nosniff');
      expect(answer.headers['referrer-policy']).toBe('no-referrer');
      expect(answer.headers['content-length']).toBe(String(Buffer.byteLength(answer.body)));
      const style = /<style>([^<]*)<\/style>/.exec(answer.body)![1]!;
      expect(answer.headers['content-security-policy']).toBe(
        `default-src 'none'; style-src 'sha256-${createHash('sha256').update(style).digest('base64')}'; ` +
          "base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
      );
      expect(answer.body).toContain('<title>Nectovia</title>');
      expect(answer.body).toContain('<meta charset="utf-8">');
      expect(answer.body).toMatch(/prefers-color-scheme: ?dark/);
      expect(answer.body).not.toMatch(
        /<script|<link|<img|<iframe|src=|href=|url\(|@import|italic|oblique|<i>|<em>|\u2013|\u2014/i,
      );
      const text = answer.body
        .replace(/<style>[^<]*<\/style>/, '')
        .replace(/<title>[^<]*<\/title>/, '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
      expect(text).toBe(sentence);
    }
  });

  it('gives a callback for another state the failure page, and the attempt still completes', async () => {
    const f = await loopback();
    const state = await f.signIn();
    for (const forged of [
      at('wrong'),
      at(state + 'x'),
      at(state.slice(0, -1)),
      '/callback?error=access_denied&state=wrong',
      '/callback',
      '/callback?code=x',
      `/callback?code=x&state=${encodeURIComponent(state)}&state=y`,
      `/callback?code=x&state=${encodeURIComponent(state)}&next=elsewhere`,
    ]) {
      const answer = await request(f.port, forged);
      expect([answer.status, answer.body.includes(NOT_FINISHED)], forged).toEqual([400, true]);
    }
    expect(f.exchange).not.toHaveBeenCalled();
    expect(f.auth.identity.status().status).toBe('signing-in');
    expect(await refused(f.port)).toBe(false);
    expect((await request(f.port, at(state))).body).toContain(SIGNED_IN);
    expect(f.exchange).toHaveBeenCalledOnce();
  });

  it('answers only GET /callback for its own Host, with an empty body otherwise', async () => {
    const f = await loopback();
    const state = await f.signIn();
    const right = at(state);
    for (const target of [
      '/',
      '/favicon.ico',
      '/callback/',
      '/callback/x',
      '/Callback?code=x&state=y',
      '/callbackx?code=x&state=y',
      '//callback?code=x&state=y',
      `http://127.0.0.1:${f.port}${right}`,
    ]) {
      const answer = await request(f.port, target);
      expect([answer.status, answer.body], target).toEqual([404, '']);
    }
    for (const method of ['POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS']) {
      const answer = await request(f.port, right, { method });
      expect([answer.status, answer.body], method).toEqual([405, '']);
    }
    for (const host of [
      `localhost:${f.port}`,
      '127.0.0.1',
      `127.0.0.1:${f.port + 1}`,
      `[::1]:${f.port}`,
      `127.0.0.1:${f.port}.evil.test`,
      'evil.test',
    ]) {
      const answer = await request(f.port, right, { host });
      expect([answer.status, answer.body], host).toEqual([403, '']);
    }
    expect(f.exchange).not.toHaveBeenCalled();
    expect(f.auth.identity.status().status).toBe('signing-in');
    expect((await request(f.port, right)).body).toContain(SIGNED_IN);
  });

  it('never puts a value from the request into a response', async () => {
    const f = await loopback();
    const state = await f.signIn();
    const payload = '<script>x</script>';
    const answers = [
      await request(f.port, `/callback?code=${encodeURIComponent(payload)}&state=${encodeURIComponent(payload)}`),
      await request(f.port, `/callback?code=${payload}&state=${payload}`),
      await request(f.port, `/callback?error=${encodeURIComponent(payload)}&state=x`),
      await request(f.port, `/callback?code=x&state=y&${encodeURIComponent(payload)}=1`),
      await request(f.port, `/${payload}`),
      await request(f.port, `/callback?code=${payload}&state=y`, { method: 'POST' }),
      await request(f.port, `/callback?code=${payload}&state=y`, { host: payload }),
    ];
    for (const answer of answers) {
      expect(answer.raw).not.toMatch(/<script|script>|%3Cscript|x<\//i);
    }
    expect((await request(f.port, at(state))).body).toContain(SIGNED_IN);
  });

  it('closes the port when the waiting attempt is cancelled', async () => {
    const f = await loopback();
    await f.signIn();
    expect(await refused(f.port)).toBe(false);
    expect((await f.invoke('signOut')).ok).toBe(true);
    await vi.waitFor(async () => expect(await refused(f.port)).toBe(true));
  });

  it('closes the port when the account session signs out of the waiting attempt', async () => {
    const f = await loopback();
    await f.signIn();
    expect(await refused(f.port)).toBe(false);
    await f.auth.identity.signOut();
    await vi.waitFor(async () => expect(await refused(f.port)).toBe(true));
  });

  it('closes the port when the app quits', async () => {
    const f = await loopback();
    await f.signIn();
    expect(await refused(f.port)).toBe(false);
    f.auth.dispose();
    await vi.waitFor(async () => expect(await refused(f.port)).toBe(true));
  });

  it('a new attempt replaces the old listener, and the old state no longer signs in', async () => {
    const f = await loopback();
    f.exchange.mockImplementation(async (args) => {
      const challenge = new URL(f.openExternal.mock.calls.at(-1)![0]).searchParams.get('code_challenge');
      if (createHash('sha256').update(args.codeVerifier!).digest('base64url') !== challenge)
        throw new Error('PKCE mismatch');
      return { accessToken: jwt(f.user.id), refreshToken: 'refresh-fixture', user: f.user } as any;
    });
    const first = await f.signIn();
    expect((await f.invoke('signOut')).ok).toBe(true);
    const second = await f.signIn();
    expect(redirectOf(f)).toBe(f.redirect);
    expect((await request(f.port, at(first))).body).toContain(NOT_FINISHED);
    expect(f.auth.identity.status().status).toBe('signing-in');
    expect((await request(f.port, at(second))).body).toContain(SIGNED_IN);
    expect(f.exchange).toHaveBeenCalledOnce();
    expect(await refused(f.port)).toBe(true);
  });

  it('shows the failure page for a WorkOS error, and the app shows its failure sentence', async () => {
    const f = await loopback();
    const state = await f.signIn();
    const answer = await request(
      f.port,
      `/callback?error=access_denied&error_description=provider-secret&state=${encodeURIComponent(state)}`,
    );
    expect(answer.body).toContain(NOT_FINISHED);
    expect(answer.raw).not.toContain('provider-secret');
    expect(f.exchange).not.toHaveBeenCalled();
    expect(f.auth.identity.status()).toEqual({ status: 'signed-out', message: NOT_FINISHED });
    expect(f.webContents.send.mock.calls.at(-1)![1]).toMatchObject({
      status: 'signed-out',
      message: NOT_FINISHED,
    });
    expect(await refused(f.port)).toBe(true);
  });

  it('shows the failure page when the code exchange fails, and the app its failure sentence', async () => {
    const f = await loopback();
    const state = await f.signIn();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    f.exchange.mockRejectedValue(new Error('provider refused'));
    expect((await request(f.port, at(state))).body).toContain(NOT_FINISHED);
    expect(f.auth.identity.status()).toEqual({ status: 'signed-out', message: NOT_FINISHED });
    expect(await refused(f.port)).toBe(true);
  });

  it('opens an authorize URL only when its redirect is the one this attempt chose', async () => {
    const f = await loopback();
    const real = f.client.userManagement.getAuthorizationUrl.bind(f.client.userManagement);
    vi.spyOn(f.client.userManagement, 'getAuthorizationUrl').mockImplementation((options) =>
      real({ ...options, redirectUri: callback }),
    );
    expect((await f.invoke('signIn')).ok).toBe(false);
    expect(f.openExternal).not.toHaveBeenCalled();
    expect(await refused(f.port)).toBe(true);

    const g = fixture(true, new Map(), heldPort);
    owned.push(g.auth);
    const loopbackUrl = `http://127.0.0.1:${heldPort}/callback`;
    const original = g.client.userManagement.getAuthorizationUrl.bind(g.client.userManagement);
    vi.spyOn(g.client.userManagement, 'getAuthorizationUrl').mockImplementation((options) =>
      original({ ...options, redirectUri: loopbackUrl }),
    );
    expect((await g.invoke('signIn')).ok).toBe(false);
    expect(g.openExternal).not.toHaveBeenCalled();
  });

  it('keeps a callback for another state away from the sign-in entirely', async () => {
    const f = await loopback();
    const state = await f.signIn();
    const take = vi.spyOn(f.storage.sdk, 'takePendingVerifier');
    const swapped = state.slice(0, -1) + (state.endsWith('A') ? 'B' : 'A');
    for (const forged of [
      at('forged-state'),
      at(swapped),
      '/callback?error=access_denied&state=forged-state',
      `/callback?error=access_denied&state=${encodeURIComponent(swapped)}`,
    ]) {
      const answer = await request(f.port, forged);
      expect([answer.status, answer.body.includes(NOT_FINISHED)], forged).toEqual([400, true]);
    }
    // Only the digest of the attempt's own state lets a request reach the SDK's single-use take.
    expect(take).not.toHaveBeenCalled();
    expect(f.auth.identity.status().status).toBe('signing-in');
    expect((await request(f.port, at(state))).body).toContain(SIGNED_IN);
    expect(take).toHaveBeenCalledOnce();
  });

  it('writes one warning, without the code or the state, when the port cannot be had', async () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const free = await loopback();
    await free.signIn();
    expect(redirectOf(free)).toBe(free.redirect);
    expect(warning).not.toHaveBeenCalled();

    const holder = net.createServer();
    await new Promise<void>((resolve) => holder.listen(0, '127.0.0.1', resolve));
    try {
      const port = (holder.address() as net.AddressInfo).port;
      const f = fixture(true, new Map(), port);
      owned.push(f.auth);
      const state = await f.signIn();
      expect(redirectOf(f)).toBe(callback);
      expect(warning).toHaveBeenCalledOnce();
      expect(
        await f.auth.handleCallback(
          callback + '?code=warning-code-sentinel&state=' + encodeURIComponent(state),
        ),
      ).toBe(true);
      expect(warning).toHaveBeenCalledOnce();
      const logged = JSON.stringify(warning.mock.calls);
      for (const secret of [
        'warning-code-sentinel',
        state,
        encodeURIComponent(state),
        'diomedes-auth',
        'http',
        '127.0.0.1',
        String(port),
      ])
        expect(logged).not.toContain(secret);
    } finally {
      await new Promise<void>((resolve) => holder.close(() => resolve()));
    }
  });

  describe('page limit', () => {
    const limit = 500;
    const settle = () => new Promise((resolve) => setTimeout(resolve, 50));
    const issued = (f: { user: { id: string } }) =>
      ({ accessToken: jwt(f.user.id), refreshToken: 'refresh-fixture', user: f.user }) as any;

    it('ends the attempt as failed when the code exchange is slower than the limit', async () => {
      const f = await loopback(limit);
      const state = await f.signIn();
      f.exchange.mockImplementationOnce(() => new Promise(() => {}));
      const answer = await request(f.port, at(state));
      expect(answer.status).toBe(400);
      expect(answer.body).toContain(NOT_FINISHED);
      await vi.waitFor(() => expect(f.exchange).toHaveBeenCalledOnce());
      expect(f.auth.identity.status()).toEqual({ status: 'signed-out', message: NOT_FINISHED });
      expect(f.webContents.send.mock.calls.at(-1)![1]).toMatchObject({
        status: 'signed-out',
        message: NOT_FINISHED,
      });
      await vi.waitFor(async () => expect(await refused(f.port)).toBe(true));
    });

    it('keeps the app signed out when the slow exchange succeeds after the limit', async () => {
      const f = await loopback(limit);
      const state = await f.signIn();
      let release!: (value: unknown) => void;
      f.exchange.mockImplementationOnce(() => new Promise((resolve) => (release = resolve)) as any);
      expect((await request(f.port, at(state))).body).toContain(NOT_FINISHED);
      await vi.waitFor(() => expect(f.exchange).toHaveBeenCalledOnce());
      const sent = f.webContents.send.mock.calls.length;
      release(issued(f));
      await settle();
      expect(f.auth.identity.status()).toEqual({ status: 'signed-out', message: NOT_FINISHED });
      expect(f.webContents.send.mock.calls).toHaveLength(sent);
      expect(f.values.has('session')).toBe(false);
      expect((await f.invoke('getUser')).data.status).toBe('signed-out');
    });

    it('lets a new attempt listen again and sign in while the old exchange is still pending', async () => {
      const f = await loopback(limit);
      let fail!: (error: Error) => void;
      f.exchange.mockImplementationOnce(() => new Promise((_, reject) => (fail = reject)) as any);
      const first = await f.signIn();
      expect((await request(f.port, at(first))).body).toContain(NOT_FINISHED);
      await vi.waitFor(() => expect(f.exchange).toHaveBeenCalledOnce());
      await vi.waitFor(async () => expect(await refused(f.port)).toBe(true));
      // The default exchange checks PKCE against the first authorize URL; this attempt opens a second.
      f.exchange.mockImplementation(async (args) => {
        const challenge = new URL(f.openExternal.mock.calls.at(-1)![0]).searchParams.get('code_challenge');
        if (createHash('sha256').update(args.codeVerifier!).digest('base64url') !== challenge)
          throw new Error('PKCE mismatch');
        return issued(f);
      });
      const second = await f.signIn();
      expect(f.openExternal).toHaveBeenCalledTimes(2);
      expect(redirectOf(f)).toBe(f.redirect);
      expect(await refused(f.port)).toBe(false);
      expect((await request(f.port, at(second))).body).toContain(SIGNED_IN);
      expect(f.exchange).toHaveBeenCalledTimes(2);
      expect(f.auth.identity.status().status).toBe('signed-in');
      fail(new Error('late provider failure'));
      await settle();
      expect(f.auth.identity.status()).toEqual({ status: 'signed-in', message: '' });
      expect((await f.invoke('getUser')).data).toMatchObject({
        status: 'signed-in',
        account: { id: 'user_a' },
      });
    });
  });
});

describe('a sign-in attempt the browser never finishes', () => {
  const owned: Array<{ dispose(): void }> = [];
  afterEach(() => {
    for (const item of owned.splice(0)) item.dispose();
  });
  const limit = 300;

  it('ends at its limit as one that could not finish, closes the port and refuses a late callback', async () => {
    const port = await freePort();
    const f = fixture(true, new Map(), port, undefined, limit);
    owned.push(f.auth);
    const state = await f.signIn();
    expect(f.auth.identity.status().status).toBe('signing-in');
    expect(await refused(port)).toBe(false);
    await vi.waitFor(() => expect(f.auth.identity.status()).toEqual({ status: 'signed-out', message: NOT_FINISHED }));
    expect(f.webContents.send.mock.calls.at(-1)![1]).toMatchObject({ status: 'signed-out', message: NOT_FINISHED });
    await vi.waitFor(async () => expect(await refused(port)).toBe(true));
    expect(await f.auth.handleCallback(callback + '?code=abc&state=' + encodeURIComponent(state))).toBe(false);
    expect(f.exchange).not.toHaveBeenCalled();
    expect(f.values.has('session')).toBe(false);
    // The next attempt begins at once, on the same port.
    await f.signIn();
    expect(f.auth.identity.status().status).toBe('signing-in');
    expect(await refused(port)).toBe(false);
  });

  it('ends an attempt returning through the app protocol at the same limit', async () => {
    const f = fixture(true, new Map(), heldPort, undefined, limit);
    owned.push(f.auth);
    await f.signIn();
    expect(new URL(f.openExternal.mock.calls.at(-1)![0]).searchParams.get('redirect_uri')).toBe(callback);
    await vi.waitFor(() => expect(f.auth.identity.status()).toEqual({ status: 'signed-out', message: NOT_FINISHED }));
  });

  it('does not end an attempt whose callback is being finished, and does not fire after it signed in', async () => {
    const f = fixture(true, new Map(), heldPort, undefined, limit);
    owned.push(f.auth);
    const state = await f.signIn();
    let release!: (value: unknown) => void;
    f.exchange.mockImplementationOnce(() => new Promise((resolve) => (release = resolve)) as any);
    const finishing = f.auth.handleCallback(callback + '?code=abc&state=' + encodeURIComponent(state));
    await vi.waitFor(() => expect(f.exchange).toHaveBeenCalledOnce());
    await new Promise((resolve) => setTimeout(resolve, limit * 2));
    expect(f.auth.identity.status().status).toBe('signing-in');
    release({ accessToken: jwt(f.user.id), refreshToken: 'refresh-fixture', user: f.user });
    expect(await finishing).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, limit * 2));
    expect((await f.invoke('getUser')).data.status).toBe('signed-in');
  });
});
