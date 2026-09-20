import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
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
  parseNativeCallback,
} from '../desktop/native-auth';
import { createNativeTokenStorage } from '../desktop/native-auth-storage';

const clientId = 'client_native_fixture';
const origin = 'http://127.0.0.1:41371';
const callback = 'diomedes-auth://callback';
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

function fixture(configured = true, values = new Map<string, unknown>()) {
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
    'diomedes-auth://callback/?code=x&state=y',
    'diomedes-auth://callback/../?code=x&state=y',
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
});
