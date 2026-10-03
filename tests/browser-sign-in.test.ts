/**
 * A packaged build signs a customer in through WorkOS in the system browser, and the WorkOS access
 * token becomes the account session's bearer (task 4).
 *
 *   native sign-in (desktop/native-auth.ts)  ->  BrowserIdentity  ->  AccountSessionService
 *
 * WorkOS is the faux cloud's stand-in (services/control-plane/src/faux/workos-standin.ts). The
 * account service is the Worker's own handler over the faux store, verifying every bearer with the
 * Worker's own WorkOSIdentityVerifier; like the deployed Worker, it refuses /faux/status without a
 * bearer, so the packaged build takes it for the deployed service. The system browser is a fake
 * shell: the test follows the authorize link the way WorkOS would, and hands the diomedes-auth
 * callback to the app the way the operating system would. Protected storage is a synthetic AES-GCM
 * safeStorage. Nothing leaves this process: api.workos.com is the stand-in, and anything else that
 * is not loopback is refused.
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createPublicWorkOS } from '@workos/authkit-electron/internals';

vi.mock('electron', () => ({ app: {}, safeStorage: {}, ipcMain: {}, shell: {}, BrowserWindow: {} }));
import { createNativeAuth } from '../desktop/native-auth';
import { createNativeTokenStorage, type NativeTokenStorage } from '../desktop/native-auth-storage';
import { createApp } from '../server/app';
import { resolveAccountBackend, type AccountBackend } from '../server/accounts/backend';
import { checkBrowserToken, type BrowserIdentity, type BrowserSession } from '../server/accounts/browser-identity';
import { ControlPlaneClient } from '../server/accounts/client';
import { browserSignIn, type BrowserSignInConfig } from '../server/accounts/deployment';
import { AccountSessionService } from '../server/accounts/session';
import { EngineService } from '../server/engines/service';
import { createFauxCloud, FAUX_BACKEND_LABEL, type FauxCloud } from '../services/control-plane/src/faux/cloud';
import { DEMO_ACCOUNTS, seedDemo } from '../services/control-plane/src/faux/seed';
import { createWorkOSStandIn, STANDIN_AUDIENCE, STANDIN_CLIENT_ID, WORKOS_ISSUER } from '../services/control-plane/src/faux/workos-standin';
import { browserSignInPending, type AccountStateView } from '../shared/accounts';

const SERVICE = 'https://accounts.diomedes.net';
const ORIGIN = 'http://127.0.0.1:43611';
/** Where the stand-in sends the browser back to: it redirects to loopback only, so the test reads the code there. */
const LANDING = 'http://127.0.0.1:47319/callback';
const PER_CLIENT_ISSUER = `${WORKOS_ISSUER}/user_management/${STANDIN_CLIENT_ID}`;
const deployment = () => ({ url: SERVICE, workos: { clientId: STANDIN_CLIENT_ID, issuer: WORKOS_ISSUER, audience: STANDIN_AUDIENCE } });
/** What a packaged build accepts, derived exactly as it is from the real deployment. */
const packaged = browserSignIn({ env: {}, packaged: true, deployment })!;
const OWNER = DEMO_ACCOUNTS.owner.email;
const SENTENCES = {
  waiting: 'Finish signing in in your browser.',
  accepting: 'Signing you in.',
  unfinished: 'Sign-in could not finish. Try again.',
  notForUs: "That sign-in isn't for the Nectovia account service. Sign in again.",
  refused: "The Nectovia account service didn't accept that sign-in. Sign in again.",
  unreachable: "You're signed in with WorkOS, but the Nectovia account service didn't answer. Check the connection, then try again.",
  unchecked: "Your sign-in couldn't be checked with WorkOS just now. Check the connection, then try again.",
  notSetUp: "Sign-in through the browser isn't set up on this installation.",
  noSafeStorage: "This computer can't keep a sign-in in protected storage, so you can't sign in here.",
};

let cloud: FauxCloud;
let orgs: { juniper: string; harbor: string };
let dir: string;
/** What the account service was asked, and what WorkOS was asked. */
let calls: string[];
let workos: string[];
/** The account service stops answering (its front door still does). */
let down: boolean;
/** When set, the account service holds its answer to the session call until this settles. */
let holdSession: Promise<void> | null;
const owned: Array<{ dispose(): void }> = [];

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nectovia-browser-sign-in-'));
  calls = [];
  workos = [];
  down = false;
  holdSession = null;
  cloud = await createFauxCloud({ file: null, identity: 'workos-standin' });
  orgs = (await seedDemo(cloud)).organizations!;
  const loopback = globalThis.fetch;
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (url.origin === WORKOS_ISSUER) {
      workos.push(`${request.method} ${url.pathname}`);
      return cloud.standIn!.handle(request);
    }
    if (url.hostname === '127.0.0.1') return loopback(input, init);
    throw new TypeError(`Nothing here leaves this computer: ${url.origin}`);
  });
});
afterEach(async () => {
  for (const item of owned.splice(0)) item.dispose();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  await fs.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

/** The deployed account service, as this test serves it. */
async function deployedService(request: Request): Promise<Response> {
  const { pathname } = new URL(request.url);
  calls.push(`${request.method} ${pathname}`);
  // The faux cloud describes itself here; the deployed Worker checks the bearer first, and refuses.
  if (pathname === '/faux/status') return Response.json({ error: 'A verified bearer session is required.' }, { status: 401 });
  if (down) throw new TypeError('fetch failed');
  if (pathname === '/account/session' && holdSession) await holdSession;
  return cloud.handle(request);
}
const packagedBackend = () =>
  resolveAccountBackend({ dataDir: dir, env: {}, packaged: true, fetch: deployedService, deployment });
/** Every account-service call but the start-up probe. */
const accountCalls = () => calls.filter((call) => call !== 'GET /faux/status');

/** This computer's protected storage: one sealed store that outlives each launch of the app. */
function protectedStorage(available = true) {
  const values = new Map<string, unknown>();
  const key = randomBytes(32);
  return {
    values,
    open: (): NativeTokenStorage =>
      createNativeTokenStorage({
        store: {
          get: (name) => values.get(name),
          set: (name, value) => {
            values.set(name, value);
          },
          delete: (name) => {
            values.delete(name);
          },
        },
        safeStorage: {
          isEncryptionAvailable: () => available,
          getSelectedStorageBackend: () => 'synthetic-aes-gcm',
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
      }),
  };
}

/** One launch of the app's native sign-in, as desktop/main.mjs creates it from `browserSignIn`. */
function launch(storage: NativeTokenStorage, accepts: BrowserSignInConfig = packaged) {
  const opened: string[] = [];
  const auth = createNativeAuth({
    clientId: accepts.clientId,
    tokenIssuer: accepts.issuers,
    audience: accepts.audience,
    origin: ORIGIN,
    // No window: the renderer is not part of this, and never receives a token anyway.
    getWindow: () => undefined,
    storage,
    client: createPublicWorkOS(accepts.clientId),
    ipcMain: { handle: () => {}, removeHandler: () => {} },
    registerProtocol: () => true,
    shell: {
      openExternal: async (url) => {
        opened.push(url);
      },
    },
  });
  owned.push(auth);
  return { auth, opened, storage };
}
const kept = (storage: NativeTokenStorage) => storage.run(async () => storage.sdk.getSession());

/** The person signs in at WorkOS in the browser, which returns to the app's diomedes-auth callback. */
async function signInAtWorkOS(opened: string[], email: string) {
  const authorize = new URL(opened.at(-1)!);
  expect(authorize.origin + authorize.pathname).toBe(`${WORKOS_ISSUER}/user_management/authorize`);
  expect(authorize.searchParams.get('redirect_uri')).toBe('diomedes-auth://callback');
  expect(authorize.searchParams.get('client_id')).toBe(STANDIN_CLIENT_ID);
  // The stand-in has no sign-in page (the person is the login hint) and redirects to loopback only.
  authorize.searchParams.set('login_hint', email);
  authorize.searchParams.set('redirect_uri', LANDING);
  const answer = await cloud.standIn!.handle(new Request(authorize));
  const landed = new URL(answer.headers.get('location')!);
  const code = landed.searchParams.get('code');
  expect(code, landed.href).toBeTruthy();
  return `diomedes-auth://callback?code=${encodeURIComponent(code!)}&state=${encodeURIComponent(landed.searchParams.get('state')!)}`;
}

async function accountSession(identity: BrowserIdentity | null, accepts: BrowserSignInConfig = packaged, now?: () => number, backend?: AccountBackend) {
  const session = new AccountSessionService(
    backend ?? (await packagedBackend()),
    dir,
    null,
    now,
    identity ? { identity, expect: accepts } : null,
  );
  await session.init();
  return session;
}
const deferred = () => {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
};
/** Waits for every reconcile the session has queued, which a held service answer keeps open. */
const settled = (session: AccountSessionService) => (session as unknown as { following: Promise<void> }).following;
const signedIn = (session: AccountSessionService) => vi.waitFor(() => expect(session.state().signedIn).toBe(true));

/** Sign the owner in through the browser, start to finish. */
async function signInThroughBrowser(storage = protectedStorage().open(), now?: () => number) {
  const app = launch(storage);
  const session = await accountSession(app.auth.identity, packaged, now);
  expect((await session.signInWithBrowser()).browser).toEqual({ status: 'waiting', message: SENTENCES.waiting });
  expect(await app.auth.handleCallback(await signInAtWorkOS(app.opened, OWNER))).toBe(true);
  await signedIn(session);
  return { ...app, session };
}

/** A WorkOS sign-in this computer keeps, without the browser: for the session's own checks. */
function identityWith(initial: BrowserSession | null, renew?: () => Promise<BrowserSession | null>) {
  let current = initial;
  let status: ReturnType<BrowserIdentity['status']>['status'] = initial ? 'signed-in' : 'signed-out';
  const listeners = new Set<() => void>();
  const identity = {
    began: 0,
    signedOut: 0,
    async begin() {
      identity.began++;
      status = 'signing-in';
    },
    async session(request: { fresh?: boolean } = {}) {
      if (request.fresh && renew) {
        current = await renew();
        return current;
      }
      return current;
    },
    async signOut() {
      identity.signedOut++;
      current = null;
      status = 'signed-out';
    },
    status: () => ({ status, message: '' }),
    onChange(listener: () => void) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
  } satisfies BrowserIdentity & { began: number; signedOut: number };
  return identity;
}
const ownerToken = async () => {
  const answer = await cloud.standIn!.signInDirect(OWNER);
  return { accessToken: answer.access_token, user: { id: answer.user.id, email: answer.user.email, name: 'Maya Ortiz' } };
};
const claimsOf = (token: string) => JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));

describe('signing in through the browser', () => {
  test('a WorkOS sign-in becomes the account session, and its access token is the bearer', async () => {
    const { auth, opened, storage } = launch(protectedStorage().open());
    const session = await accountSession(auth.identity);
    const before = await session.read();
    expect(before).toMatchObject({
      signedIn: false,
      backend: { kind: 'cloud', url: SERVICE, signIn: 'browser', demo: null },
      browser: { status: 'ready', message: '' },
    });

    const waiting = await session.signInWithBrowser();
    expect(waiting).toMatchObject({ signedIn: false, browser: { status: 'waiting', message: SENTENCES.waiting } });
    expect(opened).toHaveLength(1);
    // Asking again while the browser is open does not open another.
    await session.signInWithBrowser();
    expect(opened).toHaveLength(1);

    expect(await auth.handleCallback(await signInAtWorkOS(opened, OWNER))).toBe(true);
    await signedIn(session);
    const state = await session.read();
    expect(state).toMatchObject({
      signedIn: true,
      person: { email: OWNER, name: DEMO_ACCOUNTS.owner.name },
      remember: true,
      browser: { status: 'ready', message: '' },
    });
    expect(state.workspaces.map((row) => row.organization.name)).toEqual(['Juniper Street Bakery']);

    // The bearer is WorkOS's own access token: the client's issuer and the account service's audience.
    const bearer = await session.token();
    expect(claimsOf(bearer)).toMatchObject({ iss: PER_CLIENT_ISSUER, aud: SERVICE, client_id: STANDIN_CLIENT_ID });
    expect((await auth.identity.session())?.accessToken).toBe(bearer);
    expect(JSON.stringify(state)).not.toContain(bearer);
    // Juniper Street Bakery holds Business: the Agent is admitted, by the service, for this bearer.
    expect(
      await session.admitAgent({ organizationId: orgs.juniper, surface: 'conversation', routeKind: 'byo', rootJobId: 'job-1', phase: 'admit' }),
    ).toMatchObject({ admitted: true });
    // No password route was used; WorkOS traded the code, once.
    expect(accountCalls().some((call) => call.startsWith('POST /auth/'))).toBe(false);
    expect(workos.filter((call) => call === 'POST /user_management/authenticate')).toHaveLength(1);
    // Native sign-in keeps it; the account session holds no refresh token of its own.
    expect((await kept(storage))?.accessToken).toBe(bearer);
  });

  test('the kept sign-in is sealed in protected storage, and the next launch resumes it without the browser', async () => {
    const storage = protectedStorage();
    const first = await signInThroughBrowser(storage.open());
    const bearer = await first.session.token();
    expect(JSON.stringify([...storage.values.values()])).not.toContain(bearer);
    first.auth.dispose();

    const second = launch(storage.open());
    const again = await accountSession(second.auth.identity);
    expect(again.state()).toMatchObject({ signedIn: true, person: { email: OWNER } });
    expect(second.opened).toEqual([]);
    expect(await again.token()).toBe(bearer);
  });

  test('signing out ends the account session and the WorkOS sign-in, and clears the kept one', async () => {
    const storage = protectedStorage();
    const { auth, opened, session, storage: open } = await signInThroughBrowser(storage.open());
    expect(await kept(open)).not.toBeNull();
    const { sid } = claimsOf(await session.token());

    const state = await session.signOut();
    expect(state).toMatchObject({ signedIn: false, person: null, browser: { status: 'ready', message: '' } });
    expect(await kept(open)).toBeNull();
    expect(auth.identity.status().status).toBe('signed-out');
    // WorkOS ends its own session too: its sign-out page, for this session, opens in the browser.
    await vi.waitFor(() => expect(opened.at(-1)).toBe(`${WORKOS_ISSUER}/user_management/sessions/logout?session_id=${sid}`));
    await expect(session.token()).rejects.toMatchObject({ status: 401 });

    // Nothing signs back in: not this launch, and not the next one.
    expect((await session.read()).signedIn).toBe(false);
    const next = launch(storage.open());
    expect((await accountSession(next.auth.identity)).state().signedIn).toBe(false);
  });

  test('signing out of WorkOS elsewhere in the app ends the account session too', async () => {
    const { auth, session } = await signInThroughBrowser();
    await auth.identity.signOut();
    await vi.waitFor(() => expect(session.state().signedIn).toBe(false));
  });
});

describe('a token that is not for the Nectovia account service', () => {
  test.each([
    ['another audience', { ...packaged, audience: 'https://elsewhere.fixture.invalid' }],
    ['only the bare issuer, which this token does not name', { ...packaged, issuers: [WORKOS_ISSUER] }],
  ])('native sign-in refuses one with %s, and the service never sees it', async (_name, accepts) => {
    const storage = protectedStorage().open();
    const { auth, opened } = launch(storage, accepts);
    const session = await accountSession(auth.identity, accepts);
    await session.signInWithBrowser();
    expect(await auth.handleCallback(await signInAtWorkOS(opened, OWNER))).toBe(false);
    expect(session.state().signedIn).toBe(false);
    expect(await kept(storage)).toBeNull();
    expect(accountCalls()).toEqual([]);
  });

  test.each([
    ['another audience', { ...packaged, audience: 'https://elsewhere.fixture.invalid' }],
    ['another issuer', { ...packaged, issuers: [WORKOS_ISSUER, `${PER_CLIENT_ISSUER}/`] }],
    ['another WorkOS client', { ...packaged, clientId: 'client_someone_else' }],
  ])('the account session refuses one for %s itself, ends it, and never sends it', async (_name, accepts) => {
    const identity = identityWith(await ownerToken());
    const session = await accountSession(identity, accepts);
    expect(session.state()).toMatchObject({ signedIn: false, browser: { status: 'failed', message: SENTENCES.notForUs } });
    expect(identity.signedOut).toBe(1);
    expect(accountCalls()).toEqual([]);
  });

  test('the same token, for the service it names, signs in', async () => {
    const session = await accountSession(identityWith(await ownerToken()));
    expect(session.state()).toMatchObject({ signedIn: true, person: { email: OWNER } });
    expect(accountCalls()).toContain('GET /account/session');
  });

  test('checkBrowserToken checks each claim exactly', async () => {
    const good = (await ownerToken()).accessToken;
    const now = Date.now();
    expect(checkBrowserToken(good, packaged, now)).toMatchObject({ subject: expect.stringMatching(/^user_/), sessionId: expect.stringMatching(/^session_/) });
    const forge = (claims: Record<string, unknown>) => {
      const [header, body, signature] = good.split('.');
      const merged = { ...JSON.parse(Buffer.from(body, 'base64url').toString('utf8')), ...claims };
      for (const [name, value] of Object.entries(claims)) if (value === undefined) delete merged[name];
      return [header, Buffer.from(JSON.stringify(merged)).toString('base64url'), signature].join('.');
    };
    expect(checkBrowserToken(forge({ aud: [SERVICE, 'https://other.fixture.invalid'] }), packaged, now)).not.toBeNull();
    expect(checkBrowserToken(forge({ iss: WORKOS_ISSUER }), packaged, now)).not.toBeNull();
    for (const claims of [
      { iss: `${WORKOS_ISSUER}/` },
      { iss: 'https://api.workos.com/user_management/client_someone_else' },
      { iss: undefined },
      { aud: 'https://accounts.diomedes.net/' },
      { aud: undefined },
      { client_id: 'client_someone_else' },
      { sub: 'someone' },
      { sid: 'not-a-session' },
      { exp: Math.floor(now / 1000) - 1 },
      { exp: 'soon' },
    ])
      expect(checkBrowserToken(forge(claims), packaged, now), JSON.stringify(claims)).toBeNull();
    for (const token of ['', 'a.b', 'a.b.c.d', 'a.not-json.c', `${good.split('.')[0]}.${Buffer.from('null').toString('base64url')}.x`])
      expect(checkBrowserToken(token, packaged, now)).toBeNull();
  });
});

describe('what the account service says about a browser sign-in', () => {
  test('its own refusal ends the WorkOS sign-in, and the next attempt starts clean', async () => {
    // Signed by another WorkOS environment's key: the right claims, but not a token the service can verify.
    const elsewhere = await createWorkOSStandIn({ clientId: STANDIN_CLIENT_ID });
    const foreign = await elsewhere.signInDirect(OWNER);
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const identity = identityWith({ accessToken: foreign.access_token, user: { id: foreign.user.id, email: OWNER, name: 'Maya Ortiz' } });
    const session = await accountSession(identity);
    expect(session.state()).toMatchObject({ signedIn: false, browser: { status: 'failed', message: SENTENCES.refused } });
    expect(identity.signedOut).toBe(1);
    expect(JSON.stringify(logged.mock.calls)).toContain('signing-key');
    // The failure stands until the next attempt, which opens the browser again.
    const next = await session.signInWithBrowser();
    expect(identity.began).toBe(1);
    expect(next.browser).toEqual({ status: 'waiting', message: SENTENCES.waiting });
  });

  test('a service that does not answer keeps the WorkOS sign-in, and "Try again" signs in once it does', async () => {
    down = true;
    const identity = identityWith(await ownerToken());
    const session = await accountSession(identity);
    expect(session.state()).toMatchObject({ signedIn: false, browser: { status: 'failed', message: SENTENCES.unreachable } });
    expect(identity.signedOut).toBe(0);
    down = false;
    const state = await session.signInWithBrowser();
    expect(state).toMatchObject({ signedIn: true, person: { email: OWNER } });
    expect(identity.began).toBe(0);
  });

  test('a kept sign-in WorkOS cannot be asked about just now is not a sign-out', async () => {
    const identity = identityWith(null);
    identity.session = async () => {
      throw new Error('The sign-in could not be renewed just now.');
    };
    const session = await accountSession(identity);
    expect(session.state()).toMatchObject({ signedIn: false, browser: { status: 'failed', message: SENTENCES.unchecked } });
    expect(identity.signedOut).toBe(0);
  });
});

describe('between the browser step and the account service accepting the sign-in', () => {
  test('the view says it is signing the person in, not that nothing has started, until the service answers', async () => {
    const { auth, opened } = launch(protectedStorage().open());
    const session = await accountSession(auth.identity);
    await session.signInWithBrowser();
    const gate = deferred();
    holdSession = gate.promise;
    expect(await auth.handleCallback(await signInAtWorkOS(opened, OWNER))).toBe(true);
    // The callback is in, the account service has not answered: signed out, and not "ready".
    expect(session.state()).toMatchObject({ signedIn: false, browser: { status: 'accepting', message: SENTENCES.accepting } });
    await vi.waitFor(() => expect(accountCalls()).toContain('GET /account/session'));
    expect(session.state()).toMatchObject({ signedIn: false, browser: { status: 'accepting', message: SENTENCES.accepting } });
    gate.release();
    await signedIn(session);
    expect(session.state()).toMatchObject({ signedIn: true, browser: { status: 'ready', message: '' } });
  });

  test('a reconcile that fails before the account session exists ends as failed, not ready', async () => {
    const backend = await packagedBackend();
    const real = backend.client.session.bind(backend.client);
    // The service answers, then the app cannot use its answer: nothing has set the session yet.
    vi.spyOn(backend.client, 'session').mockImplementation(async (token) => {
      const page = await real(token);
      return {
        ...page,
        get organizations(): typeof page.organizations {
          throw new Error('The answer could not be read.');
        },
      };
    });
    const identity = identityWith(await ownerToken());
    const session = await accountSession(identity, packaged, undefined, backend);
    expect(session.state()).toMatchObject({ signedIn: false, browser: { status: 'failed', message: SENTENCES.unfinished } });
    // The WorkOS sign-in is kept, as for an unreachable service.
    expect(identity.signedOut).toBe(0);
  });

  test('signing out while the service is still answering leaves no failure and no "signing you in"', async () => {
    const { auth, opened } = launch(protectedStorage().open());
    const session = await accountSession(auth.identity);
    await session.signInWithBrowser();
    const gate = deferred();
    holdSession = gate.promise;
    expect(await auth.handleCallback(await signInAtWorkOS(opened, OWNER))).toBe(true);
    expect(session.state().browser?.status).toBe('accepting');
    const out = await session.signOut();
    expect(out).toMatchObject({ signedIn: false, browser: { status: 'ready', message: '' } });
    gate.release();
    await settled(session);
    expect(session.state()).toMatchObject({ signedIn: false, browser: { status: 'ready', message: '' } });
  });

  test('a cancel followed by a late failure of the superseded reconcile leaves no failure', async () => {
    const { auth, opened } = launch(protectedStorage().open());
    const session = await accountSession(auth.identity);
    await session.signInWithBrowser();
    // The account service answered; the step after it is held, then fails with an error of its own.
    const gate = deferred();
    const loadAccess = vi.spyOn(session as unknown as { loadAccess(): Promise<void> }, 'loadAccess').mockImplementationOnce(async () => {
      await gate.promise;
      throw new Error('The write did not finish.');
    });
    expect(await auth.handleCallback(await signInAtWorkOS(opened, OWNER))).toBe(true);
    await vi.waitFor(() => expect(loadAccess).toHaveBeenCalledTimes(1));
    expect(session.state().browser?.status).toBe('accepting');
    const out = await session.signOut();
    expect(out).toMatchObject({ signedIn: false, browser: { status: 'ready', message: '' } });
    gate.release();
    await settled(session);
    expect(session.state()).toMatchObject({ signedIn: false, browser: { status: 'ready', message: '' } });
  });

  test('a reconcile that a newer attempt superseded sets no failure, though the identity still has a sign-in', async () => {
    const identity = identityWith(null);
    let changed = () => {};
    identity.onChange = (listener: () => void) => {
      changed = listener;
      return () => {};
    };
    const session = await accountSession(identity);
    // The launch reconcile found nothing. Now WorkOS keeps a sign-in for this computer.
    const token = await ownerToken();
    identity.session = async () => token;
    identity.status = () => ({ status: 'signed-in' as const, message: '' });
    const gate = deferred();
    const loadAccess = vi.spyOn(session as unknown as { loadAccess(): Promise<void> }, 'loadAccess').mockImplementationOnce(async () => {
      await gate.promise;
      throw new Error('The write did not finish.');
    });
    changed();
    await vi.waitFor(() => expect(loadAccess).toHaveBeenCalledTimes(1));
    // A newer attempt moves the lifecycle and queues behind the held one; it ends quietly.
    changed();
    identity.session = async () => null;
    gate.release();
    await settled(session);
    expect(identity.status().status).toBe('signed-in');
    expect(session.state()).toMatchObject({ signedIn: false, browser: { status: 'ready', message: '' } });
  });

  test('a reconcile that ends the local session after WorkOS ended its own says nothing, though the end failed', async () => {
    const identity = identityWith(await ownerToken());
    let changed = () => {};
    identity.onChange = (listener: () => void) => {
      changed = listener;
      return () => {};
    };
    const session = await accountSession(identity);
    expect(session.state().signedIn).toBe(true);
    // WorkOS ends the session elsewhere. Ending the local one then fails to write.
    await identity.signOut();
    vi.spyOn(session as unknown as { save(): Promise<void> }, 'save').mockRejectedValueOnce(new Error('The write did not finish.'));
    changed();
    await settled(session);
    expect(session.state()).toMatchObject({ signedIn: false, browser: { status: 'ready', message: '' } });
  });
});

describe('when the gate keeps asking whether the sign-in arrived', () => {
  test('it does while the browser is open or the service is accepting, and not otherwise', () => {
    expect(browserSignInPending({ status: 'waiting', message: SENTENCES.waiting })).toBe(true);
    expect(browserSignInPending({ status: 'accepting', message: SENTENCES.accepting })).toBe(true);
    expect(browserSignInPending({ status: 'ready', message: '' })).toBe(false);
    expect(browserSignInPending({ status: 'failed', message: SENTENCES.unfinished })).toBe(false);
    expect(browserSignInPending({ status: 'unavailable', message: SENTENCES.notSetUp })).toBe(false);
    expect(browserSignInPending(null)).toBe(false);
  });
});

describe('renewing the bearer', () => {
  test('a bearer near its end is renewed through WorkOS, and the kept sign-in follows', async () => {
    let clock = Date.now();
    const { session, storage } = await signInThroughBrowser(undefined, () => clock);
    const first = await session.token();
    // The stand-in's tokens last five minutes; the session renews inside the last minute.
    clock += 250_000;
    const second = await session.token();
    expect(second).not.toBe(first);
    expect(claimsOf(second)).toMatchObject({ iss: PER_CLIENT_ISSUER, aud: SERVICE, sub: claimsOf(first).sub });
    expect(workos.filter((call) => call === 'POST /user_management/authenticate')).toHaveLength(2);
    expect((await kept(storage))?.accessToken).toBe(second);
    expect(session.state()).toMatchObject({ signedIn: true, person: { email: OWNER } });
    expect(await session.admitAgent({ organizationId: orgs.juniper, surface: 'conversation', routeKind: 'byo', rootJobId: 'job-2', phase: 'admit' })).toMatchObject({ admitted: true });
  });

  test('one WorkOS no longer has ends the account session', async () => {
    let clock = Date.now();
    const identity = identityWith(await ownerToken(), async () => null);
    const session = await accountSession(identity, packaged, () => clock);
    expect(session.state().signedIn).toBe(true);
    clock += 250_000;
    await expect(session.token()).rejects.toMatchObject({ status: 401, message: 'Your sign-in ended. Sign in again.' });
    expect(session.state().signedIn).toBe(false);
  });

  test('one WorkOS cannot be asked about just now keeps the session, and this call waits for it', async () => {
    let clock = Date.now();
    const identity = identityWith(await ownerToken(), async () => {
      throw new Error('WorkOS did not answer.');
    });
    const session = await accountSession(identity, packaged, () => clock);
    clock += 250_000;
    await expect(session.token()).rejects.toMatchObject({ status: 503, message: SENTENCES.unchecked });
    expect(session.state().signedIn).toBe(true);
  });

  test('a renewed token for another WorkOS user ends this person’s session', async () => {
    let clock = Date.now();
    const other = await cloud.standIn!.signInDirect(DEMO_ACCOUNTS.manager.email);
    const identity = identityWith(await ownerToken(), async () => ({
      accessToken: other.access_token,
      user: { id: other.user.id, email: other.user.email, name: 'Sam Rivera' },
    }));
    const session = await accountSession(identity, packaged, () => clock);
    clock += 250_000;
    await expect(session.token()).rejects.toMatchObject({ status: 401 });
    expect(session.state().signedIn).toBe(false);
  });
});

describe('where browser sign-in is not on offer', () => {
  test('a password service has no browser sign-in, even with an identity', async () => {
    const password: AccountBackend = {
      client: new ControlPlaneClient('http://faux.local', (request) => cloud.handle(request)),
      view: () => ({ kind: 'faux', label: FAUX_BACKEND_LABEL, url: null, reason: null, signIn: 'password' }),
      close: async () => {},
    };
    const identity = identityWith(await ownerToken());
    const session = await accountSession(identity, packaged, undefined, password);
    expect(session.state()).toMatchObject({ signedIn: false, browser: null });
    await expect(session.signInWithBrowser()).rejects.toMatchObject({ status: 409, message: SENTENCES.notSetUp });
    expect(identity.signedOut).toBe(0);
  });

  test('a packaged build without native sign-in says it is not set up', async () => {
    const session = await accountSession(null);
    expect(session.state().browser).toEqual({ status: 'unavailable', message: SENTENCES.notSetUp });
    await expect(session.signInWithBrowser()).rejects.toMatchObject({ status: 409 });
  });

  test('a computer without protected storage cannot keep a sign-in, so it cannot sign in', async () => {
    const { auth, opened } = launch(protectedStorage(false).open());
    const session = await accountSession(auth.identity);
    expect(session.state().browser).toEqual({ status: 'unavailable', message: SENTENCES.noSafeStorage });
    await session.signInWithBrowser();
    expect(opened).toEqual([]);
    expect(session.state().signedIn).toBe(false);
  });
});

describe('the host API the Console uses', () => {
  let server: Server | undefined;
  let closeApp: (() => Promise<void>) | undefined;
  afterEach(async () => {
    if (server) {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server!.close(() => resolve()));
      server = undefined;
    }
    await closeApp?.();
    closeApp = undefined;
  });

  test('POST /account/browser-sign-in opens the browser, and every other route waits for the sign-in', async () => {
    // Named explicitly, as a developer points a build at a WorkOS environment: that one exact issuer.
    const env = { DIOMEDES_WORKOS_CLIENT_ID: STANDIN_CLIENT_ID, DIOMEDES_WORKOS_TOKEN_ISSUER: PER_CLIENT_ISSUER };
    const accepts = browserSignIn({ env })!;
    expect(accepts).toEqual({ clientId: STANDIN_CLIENT_ID, issuers: [PER_CLIENT_ISSUER], audience: SERVICE });
    const { auth, opened } = launch(protectedStorage().open(), accepts);
    const app = await createApp({
      dataDir: path.join(dir, 'data'),
      projectRoot: path.join(dir, 'projects'),
      engineService: new EngineService(path.join(dir, 'engines'), { discover: async () => [] }),
      reviewerAdapter: null,
      secretBox: null,
      accounts: { env, backend: await packagedBackend(), identity: auth.identity },
    });
    closeApp = () => app.locals.close();
    server = await new Promise<Server>((resolve) => {
      const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
    });
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
    const call = (route: string, method = 'GET') =>
      fetch(`${base}${route}`, {
        method,
        headers: { 'Content-Type': 'application/json', 'X-Diomedes-Client': '1' },
        body: method === 'GET' ? undefined : '{}',
      });
    const view = async (route: string, method = 'GET') => {
      const response = await call(route, method);
      expect(response.status, `${method} ${route}`).toBe(200);
      return (await response.json()) as AccountStateView;
    };

    expect(await view('/account')).toMatchObject({ signedIn: false, browser: { status: 'ready' } });
    expect((await call('/settings')).status).toBe(401);
    expect(await view('/account/browser-sign-in', 'POST')).toMatchObject({ browser: { status: 'waiting', message: SENTENCES.waiting } });
    // The account service answers the session call late: the gate polls GET /account in that gap.
    const gate = deferred();
    holdSession = gate.promise;
    expect(await auth.handleCallback(await signInAtWorkOS(opened, OWNER))).toBe(true);
    const seen: AccountStateView[] = [await view('/account')];
    expect(seen[0]).toMatchObject({ signedIn: false, browser: { status: 'accepting', message: SENTENCES.accepting } });
    gate.release();
    await vi.waitFor(async () => {
      const next = await view('/account');
      seen.push(next);
      expect(next.signedIn).toBe(true);
    });
    // Every answer is a signed-in one, or one the gate keeps polling through: never "ready" and signed out.
    for (const answer of seen) expect(answer.signedIn || browserSignInPending(answer.browser), JSON.stringify(answer.browser)).toBe(true);
    expect((await call('/settings')).status).toBe(200);
    expect(await view('/account/sign-out', 'POST')).toMatchObject({ signedIn: false });
    expect((await call('/settings')).status).toBe(401);
  });
});
