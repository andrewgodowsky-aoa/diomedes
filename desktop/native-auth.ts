import { app, ipcMain, shell, type BrowserWindow, type IpcMainInvokeEvent } from 'electron';
import {
  AuthKitCore,
  AuthOperations,
  sessionEncryption,
  type WorkOS,
  type AuthenticationResponse,
  type AuthResult,
} from '@workos/authkit-session';
import {
  createPublicWorkOS,
  toAuthKitConfig,
  createSessionManager,
  createCeremony,
  registerIpcHandlers,
  registerProtocol,
  wireDeepLinks,
  IPC_CHANNELS,
  type AppLike,
  type IpcMainLike,
  type ShellLike,
} from '@workos/authkit-electron/internals';
import type { NativeAccountState } from '../shared/native-auth.js';
import type { BrowserIdentity, BrowserSession } from '../server/accounts/browser-identity.js';
import { createNativeTokenStorage, type NativeTokenStorage } from './native-auth-storage.js';

export const NATIVE_AUTH_CALLBACK = 'diomedes-auth://callback';
const SCHEME = 'diomedes-auth';
const API_ORIGIN = 'https://api.workos.com';
const failure = () => ({
  ok: false as const,
  error: { code: 'NativeSignInUnavailable', message: 'Sign-in could not finish. Try again.' },
});
const signedOut = (): NativeAccountState => ({ status: 'signed-out', account: null, message: '' });
/** The WorkOS user as the account session shows them. */
const personOf = (user: { id: string; email: string; firstName?: string | null; lastName?: string | null }) => ({
  id: user.id,
  email: user.email,
  name:
    [user.firstName, user.lastName]
      .filter((part) => typeof part === 'string' && part)
      .join(' ')
      .slice(0, 200)
      .trim() || user.email,
});
type Callback = { state: string; code: string } | { state: string; error: true };

function isTrustedIssuer(value: unknown): value is string {
  if (
    typeof value !== 'string' ||
    value.length > 2048 ||
    !value.startsWith('https://') ||
    /[\x00-\x20\x7f\\?#]/.test(value)
  )
    return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !!url.hostname && !url.username && !url.password;
  } catch {
    return false;
  }
}

export function parseNativeCallback(input: unknown): Callback | null {
  if (
    typeof input !== 'string' ||
    input.length > 8192 ||
    !input.startsWith(NATIVE_AUTH_CALLBACK + '?')
  )
    return null;
  try {
    const url = new URL(input);
    if (
      url.protocol !== SCHEME + ':' ||
      url.host !== 'callback' ||
      url.pathname ||
      url.username ||
      url.password ||
      url.hash
    )
      return null;
    const query = url.searchParams;
    for (const key of query.keys())
      if (
        !['code', 'state', 'error', 'error_description'].includes(key) ||
        query.getAll(key).length !== 1
      )
        return null;
    const state = query.get('state');
    const code = query.get('code');
    const error = query.get('error');
    if (!state || state.length > 3800 || /[\x00-\x20\x7f]/.test(state)) return null;
    if (
      code &&
      !query.has('error') &&
      !query.has('error_description') &&
      code.length <= 2048 &&
      !/[\x00-\x20\x7f]/.test(code)
    )
      return { code, state };
    if (error && !query.has('code') && error.length <= 128) return { error: true, state };
    return null;
  } catch {
    return null;
  }
}

/** Install before app.ready, after main has acquired its existing instance lock. */
export function captureNativeAuthCallbacks(application: AppLike, argv: string[]) {
  let deliver: ((url: string) => Promise<boolean>) | undefined;
  const queued: string[] = [];
  let disposed = false;
  let draining = false;
  let active: string | undefined;
  async function drain() {
    const handler = deliver;
    if (disposed || draining || !handler) return;
    draining = true;
    try {
      while (!disposed && queued.length) {
        active = queued.shift()!;
        try {
          await handler(active);
        } catch {
          // Do not expose the callback or provider error through native logs.
          console.warn('Native sign-in callback could not be delivered.');
        } finally {
          active = undefined;
        }
      }
    } finally {
      draining = false;
    }
  }
  const accept = (url: string) => {
    if (
      disposed ||
      !parseNativeCallback(url) ||
      active === url ||
      queued.includes(url) ||
      queued.length + (active === undefined ? 0 : 1) >= 4
    )
      return;
    queued.push(url);
    void drain();
  };
  const cleanup = wireDeepLinks(SCHEME, accept, {
    app: {
      requestSingleInstanceLock: () => true, // main owns it; never acquire a second lock
      quit: () => application.quit(),
      setAsDefaultProtocolClient: (...args) => application.setAsDefaultProtocolClient(...args),
      on: application.on.bind(application),
      removeListener: application.removeListener.bind(application),
    },
    process: { argv, execPath: process.execPath },
  });
  return {
    connect(handler: (url: string) => Promise<boolean>) {
      if (deliver || disposed) return;
      deliver = handler;
      // Cold and warm events share one bounded queue. SDK state validation and
      // single-use verifier consumption still decide whether each is accepted.
      void drain();
    },
    dispose() {
      disposed = true;
      cleanup();
      deliver = undefined;
      queued.length = 0;
    },
  };
}

/**
 * Tokens and SDK state stay here. No control-plane policy or workspace mutation: the account
 * session reads this sign-in through `identity`, in this process, and the renderer never sees a token.
 */
export function createNativeAuth(options: {
  clientId?: string;
  /**
   * Exact issuer from trusted main-process configuration, independent of clientId. Several are each
   * exact too: the deployed service accepts WorkOS's bare issuer and the client's own.
   */
  tokenIssuer?: string | readonly string[];
  /** When set, a token must also name this audience (the account service's, which the JWT template adds). */
  audience?: string;
  origin: string;
  getWindow(): BrowserWindow | undefined;
  storage?: NativeTokenStorage;
  client?: WorkOS;
  ipcMain?: IpcMainLike;
  shell?: ShellLike;
  registerProtocol?: () => boolean;
}) {
  const ipc = options.ipcMain ?? (ipcMain as unknown as IpcMainLike);
  let state = signedOut();
  let disposed = false;
  let handling: number | null = null;
  let reading: Promise<AuthResult> | undefined;
  const tokenIssuers: readonly unknown[] =
    typeof options.tokenIssuer === 'string' ? [options.tokenIssuer] : Array.isArray(options.tokenIssuer) ? options.tokenIssuer : [];
  const audience = options.audience;
  const listeners = new Set<() => void>();
  let renew: (() => Promise<BrowserSession | null>) | undefined;
  const configured =
    typeof options.clientId === 'string' &&
    /^client_[A-Za-z0-9_-]{1,120}$/.test(options.clientId) &&
    tokenIssuers.length > 0 &&
    tokenIssuers.every(isTrustedIssuer) &&
    (audience === undefined || isTrustedIssuer(audience));
  const rendererOrigin = new URL(options.origin);
  if (
    rendererOrigin.protocol !== 'http:' ||
    rendererOrigin.hostname !== '127.0.0.1' ||
    !rendererOrigin.port ||
    rendererOrigin.origin !== options.origin
  )
    throw new Error("Native sign-in requires this launch's loopback origin.");
  let storage: NativeTokenStorage | undefined;
  let manager: ReturnType<typeof createSessionManager> | undefined;
  const unavailable = (message: string) => {
    state = { status: 'unavailable', account: null, message };
  };
  const trustedWindow = () => {
    const win = options.getWindow();
    if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return undefined;
    try {
      if (new URL(win.webContents.mainFrame.url).origin !== options.origin) return undefined;
    } catch {
      return undefined;
    }
    return win;
  };
  const notify = () => {
    for (const listener of listeners)
      try {
        listener();
      } catch {
        // A listener's failure never changes the sign-in.
      }
    trustedWindow()?.webContents.send(IPC_CHANNELS.authChanged, state);
  };
  const ensure = () => {
    if (disposed || !manager || !storage) throw new Error('Native sign-in is not configured.');
    storage.assertAvailable();
    return { manager, storage };
  };
  function display(auth: AuthResult) {
    if (!auth.user) {
      state = signedOut();
      return;
    }
    if (auth.claims.sub !== auth.user.id) throw new Error('The account session changed.');
    const name = [auth.user.firstName, auth.user.lastName]
      .filter((s) => typeof s === 'string')
      .join(' ')
      .slice(0, 200)
      .trim();
    state = {
      status: 'signed-in',
      account: { id: auth.user.id, name: name || 'WorkOS account' },
      message: '',
    };
  }
  if (!configured) unavailable('Account sign-in is not configured on this installation.');
  else {
    try {
      storage =
        options.storage ??
        createNativeTokenStorage({ name: `diomedes-native-auth-${options.clientId}` });
      storage.assertAvailable();
      const clientId = options.clientId!;
      const rawClient = options.client ?? createPublicWorkOS(clientId);
      let core: AuthKitCore;
      const providerError = () => new Error('The identity provider could not verify the session.');
      // The SDK logs refresh errors. Strip provider response/request details at
      // this boundary so tokens, code, verifier and raw messages cannot be logged.
      const userManagement = new Proxy(rawClient.userManagement, {
        get(target, key) {
          const member = Reflect.get(target, key);
          if (key === 'authenticateWithCode' || key === 'authenticateWithRefreshToken')
            return async (...args: unknown[]) => {
              try {
                const response: AuthenticationResponse = await member.apply(target, args);
                if (
                  !(await core.verifyToken(response.accessToken)) ||
                  core.parseTokenClaims(response.accessToken).sub !== response.user.id
                )
                  throw providerError();
                return response;
              } catch {
                throw providerError();
              }
            };
          return typeof member === 'function' ? member.bind(target) : member;
        },
      });
      const client = new Proxy(rawClient, {
        get: (target, key) =>
          key === 'userManagement' ? userManagement : Reflect.get(target, key),
      });
      const config = toAuthKitConfig({ clientId, redirectUri: NATIVE_AUTH_CALLBACK }, () =>
        storage!.sdk.getOrCreateCookiePassword(),
      );
      core = new AuthKitCore(config, client, sessionEncryption);
      const verify = core.verifyToken.bind(core);
      core.verifyToken = async (token) => {
        if (!(await verify(token))) return false;
        try {
          const claims = core.parseTokenClaims(token);
          const header = JSON.parse(
            Buffer.from(token.split('.')[0]!, 'base64url').toString('utf8'),
          );
          const audiences = typeof claims.aud === 'string' ? [claims.aud] : Array.isArray(claims.aud) ? claims.aud : [];
          return (
            header.alg === 'RS256' &&
            typeof claims.iss === 'string' &&
            tokenIssuers.includes(claims.iss) &&
            (audience === undefined || audiences.includes(audience)) &&
            claims.client_id === clientId &&
            typeof claims.sub === 'string' &&
            /^user_[A-Za-z0-9_-]+$/.test(claims.sub) &&
            typeof claims.sid === 'string' &&
            /^session_[A-Za-z0-9_-]+$/.test(claims.sid) &&
            typeof claims.exp === 'number' &&
            Number.isInteger(claims.exp) &&
            claims.exp * 1000 > Date.now()
          );
        } catch {
          return false;
        }
      };
      // A new access token now, whatever the old one's lifetime: the account service refused it, or
      // it is about to expire. The refreshed token is verified like any other (the proxy above).
      renew = async () => {
        const kept = storage!.sdk.getSession();
        if (!kept) return null;
        const refreshed = await core.validateAndRefresh(kept, { force: true });
        storage!.sdk.setSession(refreshed.session);
        return refreshed.session.user
          ? { accessToken: refreshed.session.accessToken, user: personOf(refreshed.session.user) }
          : null;
      };
      const browser = options.shell ?? shell;
      const safeBrowser: ShellLike = {
        async openExternal(destination) {
          const url = new URL(destination);
          for (const key of url.searchParams.keys())
            if (url.searchParams.getAll(key).length !== 1) throw providerError();
          if (
            url.origin !== API_ORIGIN ||
            url.username ||
            url.password ||
            url.hash ||
            !['/user_management/authorize', '/user_management/sessions/logout'].includes(
              url.pathname,
            )
          )
            throw providerError();
          if (
            url.pathname.endsWith('/authorize') &&
            (url.searchParams.get('redirect_uri') !== NATIVE_AUTH_CALLBACK ||
              url.searchParams.get('client_id') !== clientId ||
              url.searchParams.get('code_challenge_method') !== 'S256')
          )
            throw providerError();
          if (
            url.pathname.endsWith('/logout') &&
            (url.searchParams.size !== 1 ||
              !/^session_[A-Za-z0-9_-]+$/.test(url.searchParams.get('session_id') ?? ''))
          )
            throw providerError();
          try {
            await browser.openExternal(destination);
          } catch {
            throw new Error('The system browser could not open.');
          }
        },
      };
      manager = createSessionManager({
        core,
        client,
        clientId,
        storage: storage.sdk,
        operations: new AuthOperations(core, client, config, sessionEncryption),
        ceremony: createCeremony(
          { clientId, redirectUri: NATIVE_AUTH_CALLBACK, ceremony: { mode: 'system-browser' } },
          { shell: safeBrowser },
        ),
      });
    } catch {
      unavailable('Secure account storage is unavailable. Personal is ready to use.');
    }
  }

  const getUser = async (): Promise<AuthResult> => {
    if (!manager || !storage || disposed) return { user: null };
    try {
      storage.assertAvailable();
    } catch {
      unavailable('Secure account storage is unavailable. Personal is ready to use.');
      return { user: null };
    }
    if (state.status === 'signing-in' || handling !== null) return { user: null };
    if (!reading) {
      const epoch = storage.generation;
      const operation = storage
        .run(async () => {
          const auth = await manager!.getUser();
          return auth;
        })
        .then((auth) => {
          if (storage!.generation !== epoch || disposed)
            throw new Error('The account session changed.');
          display(auth);
          return auth;
        });
      reading = operation;
      void operation
        .finally(() => {
          if (reading === operation) reading = undefined;
        })
        .catch(() => {});
    }
    return reading;
  };
  async function signOut() {
    if (!storage || !manager || disposed) throw new Error('Sign-in is unavailable.');
    storage.invalidate();
    handling = null;
    reading = undefined;
    state = signedOut();
    notify();
    // SDK clears local session synchronously before its best-effort hosted logout.
    try {
      await storage.run(() => manager!.signOut());
    } finally {
      await storage.run(async () => storage!.sdk.clearSession());
    }
    return { logoutUrl: '' };
  }
  async function beginSignIn() {
    const current = ensure();
    if (state.status === 'signing-in' || handling !== null || state.status === 'signed-in')
      throw new Error('Finish or cancel the current sign-in first.');
    if (!(options.registerProtocol ?? (() => registerProtocol(SCHEME, { app })))())
      throw new Error('The callback could not be registered.');
    current.storage.invalidate();
    const epoch = current.storage.generation;
    reading = undefined;
    state = { status: 'signing-in', account: null, message: 'Finish sign-in in your browser.' };
    notify();
    try {
      await current.storage.run(async () => {
        current.storage.sdk.clearSession();
        await current.manager.beginSignIn();
      });
    } catch (error) {
      if (current.storage.generation === epoch) {
        current.storage.invalidate();
        state = signedOut();
        notify();
      }
      throw error;
    }
  }
  const guardedIpc: IpcMainLike = {
    handle(channel, handler) {
      ipc.handle(channel, async (...args: unknown[]) => {
        const event = args[0] as IpcMainInvokeEvent | undefined;
        const win = trustedWindow();
        if (
          disposed ||
          !win ||
          event?.sender !== win.webContents ||
          event.senderFrame !== win.webContents.mainFrame ||
          args.slice(1).some((arg) => arg !== undefined) ||
          ![IPC_CHANNELS.getUser, IPC_CHANNELS.signIn, IPC_CHANNELS.signOut].includes(
            channel as never,
          )
        )
          return failure();
        try {
          const result = (await handler(...args)) as { ok: boolean };
          if (trustedWindow() !== win || event.senderFrame !== win.webContents.mainFrame)
            return failure();
          if (!result.ok) return failure();
          return { ok: true, data: channel === IPC_CHANNELS.getUser ? state : null };
        } catch {
          return failure();
        }
      });
    },
    removeHandler: (channel) => ipc.removeHandler(channel),
  };
  const cleanup = registerIpcHandlers(
    {
      getUser,
      beginSignIn,
      signOut,
      getAccessToken: async () => null,
      switchToOrganization: async () => ({ user: null }),
      completeCallback: async () => {
        throw new Error('OS callback only.');
      },
    },
    { ipcMain: guardedIpc, broadcast: notify, broadcastError: () => notify() },
  );

  /** The account session's view of this sign-in (server/accounts/browser-identity.ts). Main process only. */
  const identity: BrowserIdentity = {
    begin: beginSignIn,
    async session(request = {}) {
      if (!manager || !storage || disposed) return null;
      if (request.fresh) {
        const epoch = storage.generation;
        const renewed = await storage.run(() => renew!());
        if (storage.generation !== epoch || disposed) throw new Error('The account session changed.');
        if (!renewed && state.status === 'signed-in') state = signedOut();
        return renewed;
      }
      const auth = await getUser();
      if (auth.user) return { accessToken: auth.accessToken, user: personOf(auth.user) };
      if (state.status === 'unavailable' || state.status === 'signing-in' || handling !== null) return null;
      // The SDK keeps a session whose renewal failed for a reason other than its token: WorkOS
      // could not be asked just now. That is not a sign-out.
      if (await storage.run(async () => storage!.sdk.getSession() !== null))
        throw new Error('The sign-in could not be renewed just now.');
      return null;
    },
    signOut: async () => {
      await signOut();
    },
    status: () => ({ status: state.status, message: state.message }),
    onChange(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };

  return {
    identity,
    async handleCallback(url: string): Promise<boolean> {
      const parsed = parseNativeCallback(url);
      if (!parsed || !storage || !manager || disposed || handling !== null) return false;
      const epoch = storage.generation;
      const consumed = storage.consumed;
      handling = epoch;
      try {
        const auth = await storage.run(async () => {
          if ('error' in parsed) {
            const verifier = storage!.sdk.takePendingVerifier(parsed.state);
            if (!verifier) return null;
            return { user: null } as AuthResult;
          }
          return manager!.completeCallback(parsed.code, parsed.state);
        });
        if (!auth || storage.generation !== epoch || disposed) return false;
        display(auth);
        notify();
        return true;
      } catch {
        // Invalid/replayed/foreign callbacks never overwrite an active ceremony.
        if (storage.generation === epoch && storage.consumed !== consumed) {
          state = { ...signedOut(), message: 'Sign-in could not finish. Try again.' };
          notify();
        }
        return false;
      } finally {
        if (handling === epoch) handling = null;
      }
    },
    dispose() {
      disposed = true;
      listeners.clear();
      cleanup();
      storage?.dispose();
    },
  };
}
