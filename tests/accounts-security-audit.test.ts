import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { AccountBackend } from '../server/accounts/backend.js';
import type { BrowserIdentity, BrowserSession } from '../server/accounts/browser-identity.js';
import { ControlPlaneClient } from '../server/accounts/client.js';
import { AccountSessionService } from '../server/accounts/session.js';
import { testOnlySecretBox } from '../server/connection-secrets.js';
import * as accountStorage from '../server/store.js';
import { createFauxCloud, FAUX_BACKEND_LABEL, type FauxCloud } from '../services/control-plane/src/faux/cloud.js';
import { DEMO_ACCOUNTS, FAUX_DEMO_PASSWORD, seedDemo } from '../services/control-plane/src/faux/seed.js';
import { WORKOS_ISSUER, type TokenAnswer } from '../services/control-plane/src/faux/workos-standin.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

let dir: string;
let cloud: FauxCloud;
let session: AccountSessionService;
let juniper: string;
let clock: number;
let intercept: ((request: Request) => Promise<Response> | null) | null;
let requests: { method: string; pathname: string; bearer: string | null }[];

const signIn = (email: string) => session.signIn({ email, password: FAUX_DEMO_PASSWORD, remember: false });

beforeEach(async () => {
  const parent = path.join(os.tmpdir(), 'astra-accounts-security-audit');
  await fs.mkdir(parent, { recursive: true });
  dir = await fs.mkdtemp(path.join(parent, 'session-'));
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('This audit uses in-process fixtures only.'); }));
  clock = Date.now();
  cloud = await createFauxCloud({ file: null, passwordIterations: 1_000, now: () => clock });
  juniper = (await seedDemo(cloud)).organizations!.juniper;
  requests = [];
  intercept = null;
  const backend: AccountBackend = {
    client: new ControlPlaneClient('http://faux.local', (request) => {
      requests.push({ method: request.method, pathname: new URL(request.url).pathname, bearer: request.headers.get('authorization') });
      return intercept?.(request) ?? cloud.handle(request);
    }),
    view: () => ({ kind: 'faux', label: FAUX_BACKEND_LABEL, url: null, reason: null, signIn: 'password' }),
    close: async () => {},
  };
  session = new AccountSessionService(backend, dir, testOnlySecretBox(), () => clock);
  await session.init();
});

describe('sign-in and sign-out lifecycle overlap', () => {
  test('an older password sign-in cannot replace or revoke the newer sign-in', async () => {
    const entered = deferred<void>();
    const resume = deferred<void>();
    intercept = (request) => {
      if (new URL(request.url).pathname !== '/account/session') return null;
      intercept = null;
      return cloud.handle(request).then(async (answer) => { entered.resolve(); await resume.promise; return answer; });
    };
    const pending = signIn(DEMO_ACCOUNTS.owner.email).then((value) => ({ value }), (error: unknown) => ({ error }));
    await entered.promise;
    const replacement = await signIn(DEMO_ACCOUNTS.harborOwner.email);
    resume.resolve();
    await pending;
    expect(session.state().person?.id).toBe(replacement.person!.id);
    expect((await session.call((token) => session.backend.client.session(token))).person.id).toBe(replacement.person!.id);
  });

  test.each(['session', 'access'] as const)('sign-out cancels a password sign-in waiting for its %s response', async (boundary) => {
    const entered = deferred<void>();
    const resume = deferred<void>();
    const projections: (string | null)[] = [];
    session.onProjection(async (projection) => { projections.push(projection?.person.id ?? null); });
    intercept = (request) => {
      const pathname = new URL(request.url).pathname;
      if (boundary === 'session' ? pathname !== '/account/session' : !pathname.endsWith('/access')) return null;
      intercept = null;
      return cloud.handle(request).then(async (answer) => {
        expect(answer.status).toBe(200);
        entered.resolve();
        await resume.promise;
        return answer;
      });
    };
    const pending = session.signIn({ email: DEMO_ACCOUNTS.owner.email, password: FAUX_DEMO_PASSWORD, remember: true })
      .then((value) => ({ value }), (error: unknown) => ({ error }));
    await entered.promise;
    expect((await session.signOut()).signedIn).toBe(false);
    const afterSignOut = [...projections];
    resume.resolve();
    await pending;
    expect(session.signedIn()).toBe(false);
    expect(projections).toEqual(afterSignOut);
    const remembered = await fs.readFile(path.join(dir, 'accounts', 'remembered.json'), 'utf8').then((text) => JSON.parse(text), (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    expect(remembered?.last ?? null).toBeNull();
    expect(remembered?.accounts.some((entry: { sealed: string | null }) => entry.sealed !== null) ?? false).toBe(false);
  });

  test.each(['same person', 'another person'] as const)('a late sign-out preserves a replacement sign-in by the %s and its sealed token', async (replacement) => {
    await session.signIn({ email: DEMO_ACCOUNTS.owner.email, password: FAUX_DEMO_PASSWORD, remember: true });
    const entered = deferred<void>();
    const resume = deferred<void>();
    const projections: (string | null)[] = [];
    session.onProjection(async (projection) => { projections.push(projection?.person.id ?? null); });
    let releases = 0;
    session.onRelease(async () => {
      if (++releases === 1) { entered.resolve(); await resume.promise; }
    });
    const oldSignOut = session.signOut();
    await entered.promise;
    const next = await session.signIn({
      email: replacement === 'same person' ? DEMO_ACCOUNTS.owner.email : DEMO_ACCOUNTS.harborOwner.email,
      password: FAUX_DEMO_PASSWORD, remember: true,
    });
    const token = await session.token();
    const before = await fs.readFile(path.join(dir, 'accounts', 'remembered.json'), 'utf8');
    const projected = [...projections];
    resume.resolve();
    await oldSignOut;
    expect(session.state()).toMatchObject({ signedIn: true, person: { id: next.person!.id } });
    expect(await session.token()).toBe(token);
    expect(await fs.readFile(path.join(dir, 'accounts', 'remembered.json'), 'utf8')).toBe(before);
    expect(projections).toEqual(projected);
  });

  test('sign-out cleanup cannot overwrite or project over a sign-in that starts during its save', async () => {
    const first = await session.signIn({ email: DEMO_ACCOUNTS.owner.email, password: FAUX_DEMO_PASSWORD, remember: true });
    const entered = deferred<void>();
    const resume = deferred<void>();
    const rememberedFile = path.join(dir, 'accounts', 'remembered.json');
    const write = accountStorage.durableWrite;
    let writes = 0;
    vi.spyOn(accountStorage, 'durableWrite').mockImplementation(async (target, bytes, beforeReplace) => {
      if (target === rememberedFile && ++writes === 1) { entered.resolve(); await resume.promise; }
      return write(target, bytes, beforeReplace);
    });
    const projections: (string | null)[] = [];
    session.onProjection(async (projection) => { projections.push(projection?.person.id ?? null); });
    const oldSignOut = session.signOut();
    await entered.promise;
    const next = session.signIn({ email: DEMO_ACCOUNTS.harborOwner.email, password: FAUX_DEMO_PASSWORD, remember: true });
    void next.catch(() => {});
    let overlappingWrites: number;
    try {
      await vi.waitFor(() => {
        expect(session.state().person?.id).toBeDefined();
        expect(session.state().person?.id).not.toBe(first.person!.id);
      });
      overlappingWrites = writes;
    } finally { resume.resolve(); }
    const [replacement] = await Promise.all([next, oldSignOut]);
    expect(overlappingWrites).toBe(1);
    const remembered = JSON.parse(await fs.readFile(rememberedFile, 'utf8'));
    expect(remembered.last).toBe(replacement.person!.id);
    expect(remembered.accounts.find((entry: { personId: string }) => entry.personId === replacement.person!.id).sealed).toBeTruthy();
    expect(projections).toEqual([replacement.person!.id]);
  });

  test('sign-out cancels a browser sign-in waiting for its account-session response', async () => {
    const browserCloud = await createFauxCloud({ file: null, identity: 'workos-standin', now: () => clock });
    await seedDemo(browserCloud);
    const provider = browserCloud.standIn!;
    const reply = await provider.signInDirect(DEMO_ACCOUNTS.owner.email);
    let kept: BrowserSession | null = null;
    const identity: BrowserIdentity = {
      async begin() {},
      async session() { return kept; },
      async signOut() { kept = null; },
      status: () => ({ status: kept ? 'signed-in' : 'signed-out', message: '' }),
      onChange: () => () => {},
    };
    const entered = deferred<void>();
    const resume = deferred<void>();
    const backend: AccountBackend = {
      client: new ControlPlaneClient('https://accounts.example.test', async (request) => {
        const answer = await browserCloud.handle(request);
        if (new URL(request.url).pathname === '/account/session') {
          expect(answer.status).toBe(200);
          entered.resolve();
          await resume.promise;
        }
        return answer;
      }),
      view: () => ({ kind: 'cloud', label: 'Offline browser fixture', url: 'https://accounts.example.test', reason: null, signIn: 'browser' }),
      close: async () => {},
    };
    const browserSession = new AccountSessionService(backend, path.join(dir, 'browser-pending'), null, () => clock, {
      identity, expect: { clientId: provider.clientId, issuers: [WORKOS_ISSUER, `${WORKOS_ISSUER}/user_management/${provider.clientId}`], audience: provider.audience },
    });
    await browserSession.init();
    const projections: (string | null)[] = [];
    browserSession.onProjection(async (projection) => { projections.push(projection?.person.id ?? null); });
    kept = { accessToken: reply.access_token, user: { id: reply.user.id, email: reply.user.email, name: 'Owner' } };
    const pending = browserSession.signInWithBrowser().then((value) => ({ value }), (error: unknown) => ({ error }));
    await entered.promise;
    expect((await browserSession.signOut()).signedIn).toBe(false);
    resume.resolve();
    await pending;
    expect(browserSession.signedIn()).toBe(false);
    expect(projections).toEqual([]);
  });

  test('a late browser sign-out preserves the replacement identity reported by the native port', async () => {
    const browserCloud = await createFauxCloud({ file: null, identity: 'workos-standin', now: () => clock });
    await seedDemo(browserCloud);
    const provider = browserCloud.standIn!;
    const browserToken = async (email: string): Promise<BrowserSession> => {
      const reply = await provider.signInDirect(email);
      return { accessToken: reply.access_token, user: { id: reply.user.id, email: reply.user.email, name: 'Fixture account' } };
    };
    let kept: BrowserSession | null = await browserToken(DEMO_ACCOUNTS.owner.email);
    let changed = () => {};
    const identity: BrowserIdentity = {
      async begin() {},
      async session() { return kept; },
      async signOut() { kept = null; changed(); },
      status: () => ({ status: kept ? 'signed-in' : 'signed-out', message: '' }),
      onChange(listener) { changed = listener; return () => {}; },
    };
    const backend: AccountBackend = {
      client: new ControlPlaneClient('https://accounts.example.test', (request) => browserCloud.handle(request)),
      view: () => ({ kind: 'cloud', label: 'Offline browser fixture', url: 'https://accounts.example.test', reason: null, signIn: 'browser' }),
      close: async () => {},
    };
    const browserSession = new AccountSessionService(backend, path.join(dir, 'browser-overlap'), null, () => clock, {
      identity, expect: { clientId: provider.clientId, issuers: [WORKOS_ISSUER, `${WORKOS_ISSUER}/user_management/${provider.clientId}`], audience: provider.audience },
    });
    await browserSession.init();
    const previous = browserSession.state().person!.id;
    const entered = deferred<void>();
    const resume = deferred<void>();
    const projected = deferred<string>();
    let releases = 0;
    browserSession.onRelease(async () => { if (++releases === 1) { entered.resolve(); await resume.promise; } });
    browserSession.onProjection(async (projection) => {
      if (projection && projection.person.id !== previous) projected.resolve(projection.person.id);
    });
    const oldSignOut = browserSession.signOut();
    await entered.promise;
    const replacementIdentity = await browserToken(DEMO_ACCOUNTS.harborOwner.email);
    kept = replacementIdentity;
    changed();
    const replacement = await projected.promise;
    resume.resolve();
    await oldSignOut;
    // Join any queued signed-out notification through the public browser entry point.
    await browserSession.signInWithBrowser();
    expect(browserSession.state()).toMatchObject({ signedIn: true, person: { id: replacement } });
    expect(kept?.accessToken).toBe(replacementIdentity.accessToken);
  });
});

describe('review follow-up: unsuccessful replacement and Forget', () => {
  test.each(['unknown remembered account', 'wrong password'] as const)('a refused %s attempt cannot cancel an already-started sign-out', async (attempt) => {
    const owner = await session.signIn({ email: DEMO_ACCOUNTS.owner.email, password: FAUX_DEMO_PASSWORD, remember: true });
    const oldToken = await session.token();
    const entered = deferred<void>();
    const resume = deferred<void>();
    const projections: (string | null)[] = [];
    session.onProjection(async (projection) => { projections.push(projection?.person.id ?? null); });
    session.onRelease(async () => { entered.resolve(); await resume.promise; });
    const oldSignOut = session.signOut();
    await entered.promise;
    let refused: unknown;
    try {
      const replacement = attempt === 'unknown remembered account'
        ? session.resume('unknown-account')
        : session.signIn({ email: DEMO_ACCOUNTS.owner.email, password: 'incorrect-audit-password', remember: true });
      refused = await replacement.then((value) => ({ value }), (error: unknown) => ({ error }));
    } finally { resume.resolve(); }
    const ended = await oldSignOut;
    expect(refused).toMatchObject({ error: { status: attempt === 'unknown remembered account' ? 404 : 401 } });
    expect(ended.signedIn).toBe(false);
    expect(session.signedIn()).toBe(false);
    expect(requests.filter((request) => request.pathname === '/auth/sign-out')).toHaveLength(1);
    await expect(session.backend.client.session(oldToken)).rejects.toMatchObject({ status: 401 });
    const remembered = JSON.parse(await fs.readFile(path.join(dir, 'accounts', 'remembered.json'), 'utf8'));
    expect(remembered.last).toBeNull();
    expect(remembered.accounts.find((entry: { personId: string }) => entry.personId === owner.person!.id).sealed).toBeNull();
    expect(projections).toEqual([null]);
  });

  test('Forget prevents an older pending sign-in from restoring the forgotten person and sealed token', async () => {
    const owner = await session.signIn({ email: DEMO_ACCOUNTS.owner.email, password: FAUX_DEMO_PASSWORD, remember: true });
    const entered = deferred<void>();
    const resume = deferred<void>();
    const projections: (string | null)[] = [];
    session.onProjection(async (projection) => { projections.push(projection?.person.id ?? null); });
    intercept = (request) => {
      if (new URL(request.url).pathname !== '/account/session') return null;
      intercept = null;
      return cloud.handle(request).then(async (answer) => {
        expect(answer.status).toBe(200);
        entered.resolve();
        await resume.promise;
        return answer;
      });
    };
    const pending = session.signIn({ email: DEMO_ACCOUNTS.owner.email, password: FAUX_DEMO_PASSWORD, remember: true })
      .then((value) => ({ value }), (error: unknown) => ({ error }));
    await entered.promise;
    const forgotten = await session.forget(owner.person!.id);
    const before = await fs.readFile(path.join(dir, 'accounts', 'remembered.json'), 'utf8');
    const projected = [...projections];
    resume.resolve();
    await pending;
    expect(forgotten.signedIn).toBe(false);
    expect(JSON.parse(before).accounts.some((entry: { personId: string }) => entry.personId === owner.person!.id)).toBe(false);
    expect(session.signedIn()).toBe(false);
    expect(await fs.readFile(path.join(dir, 'accounts', 'remembered.json'), 'utf8')).toBe(before);
    expect(projections).toEqual(projected);
  });

  test('forgetting an unrelated remembered person preserves another pending sign-in', async () => {
    const forgottenPerson = await session.signIn({ email: DEMO_ACCOUNTS.owner.email, password: FAUX_DEMO_PASSWORD, remember: true });
    const current = await session.signIn({ email: DEMO_ACCOUNTS.harborOwner.email, password: FAUX_DEMO_PASSWORD, remember: true });
    const oldToken = await session.token();
    const entered = deferred<void>();
    const resume = deferred<void>();
    intercept = (request) => {
      if (new URL(request.url).pathname !== '/account/session') return null;
      intercept = null;
      return cloud.handle(request).then(async (answer) => {
        expect(answer.status).toBe(200);
        entered.resolve();
        await resume.promise;
        return answer;
      });
    };
    const pending = session.signIn({ email: DEMO_ACCOUNTS.harborOwner.email, password: FAUX_DEMO_PASSWORD, remember: true })
      .then((value) => ({ value }), (error: unknown) => ({ error }));
    await entered.promise;
    const afterForget = await session.forget(forgottenPerson.person!.id);
    resume.resolve();
    expect(await pending).toMatchObject({ value: { signedIn: true, person: { id: current.person!.id } } });
    expect(afterForget).toMatchObject({ signedIn: true, person: { id: current.person!.id } });
    expect(session.state()).toMatchObject({ signedIn: true, person: { id: current.person!.id } });
    expect(await session.token()).not.toBe(oldToken);
    const remembered = JSON.parse(await fs.readFile(path.join(dir, 'accounts', 'remembered.json'), 'utf8'));
    expect(remembered.last).toBe(current.person!.id);
    expect(remembered.accounts.some((entry: { personId: string }) => entry.personId === forgottenPerson.person!.id)).toBe(false);
    expect(remembered.accounts.find((entry: { personId: string }) => entry.personId === current.person!.id).sealed).toBeTruthy();
  });
});

describe('review follow-up: native logout and Forget replacement', () => {
  const nativeId = (identity: BrowserSession) => JSON.parse(Buffer.from(identity.accessToken.split('.')[1], 'base64url').toString('utf8')).sid as string;

  async function browserFixture() {
    const browserCloud = await createFauxCloud({ file: null, identity: 'workos-standin', now: () => clock });
    await seedDemo(browserCloud);
    const provider = browserCloud.standIn!;
    const browserToken = (reply: TokenAnswer): BrowserSession => ({
      accessToken: reply.access_token, user: { id: reply.user.id, email: reply.user.email, name: 'Fixture account' },
    });
    let reply = await provider.signInDirect(DEMO_ACCOUNTS.owner.email);
    let kept: BrowserSession | null = browserToken(reply);
    const listeners = new Set<() => void>();
    const changed = () => { for (const listener of listeners) listener(); };
    let fresh: (() => Promise<BrowserSession | null>) | null = null;
    let identityGate: { entered: ReturnType<typeof deferred<void>>; resume: ReturnType<typeof deferred<void>>; called: boolean; captured: BrowserSession | null } | null = null;
    let accountGate: { entered: ReturnType<typeof deferred<void>>; resume: ReturnType<typeof deferred<void>>; called: boolean } | null = null;
    const pendingResponses = new Set<Promise<Response>>();
    const identity: BrowserIdentity = {
      async begin() {},
      async session(options = {}) {
        if (options.fresh && fresh) return fresh();
        if (!options.fresh && identityGate) {
          const gate = identityGate;
          identityGate = null;
          gate.called = true;
          gate.captured = kept;
          gate.entered.resolve();
          await gate.resume.promise;
          return gate.captured;
        }
        return kept;
      },
      async signOut() { kept = null; changed(); },
      status: () => ({ status: kept ? 'signed-in' : 'signed-out', message: '' }),
      onChange(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    };
    const backend: AccountBackend = {
      client: new ControlPlaneClient('https://accounts.example.test', (request) => {
        const response = browserCloud.handle(request);
        pendingResponses.add(response);
        void response.finally(() => { pendingResponses.delete(response); }).catch(() => {});
        if (accountGate && new URL(request.url).pathname === '/account/session') {
          const gate = accountGate;
          accountGate = null;
          gate.called = true;
          gate.entered.resolve();
          return response.then(async (answer) => {
            expect(answer.status).toBe(200);
            await gate.resume.promise;
            return answer;
          });
        }
        return response;
      }),
      view: () => ({ kind: 'cloud', label: 'Offline browser fixture', url: 'https://accounts.example.test', reason: null, signIn: 'browser' }),
      close: async () => {},
    };
    const browserDir = path.join(dir, 'native-forget');
    return {
      async open() {
        const account = new AccountSessionService(backend, browserDir, null, () => clock, {
          identity, expect: { clientId: provider.clientId, issuers: [WORKOS_ISSUER, `${WORKOS_ISSUER}/user_management/${provider.clientId}`], audience: provider.audience },
        });
        await account.init();
        return account;
      },
      async replaceIdentity(email: string, notify = true) {
        reply = await provider.signInDirect(email);
        kept = browserToken(reply);
        if (notify) changed();
        return kept;
      },
      async renewIdentity(notify = true) {
        const answer = await provider.handle(new Request(`${WORKOS_ISSUER}/user_management/authenticate`, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ client_id: provider.clientId, grant_type: 'refresh_token', refresh_token: reply.refresh_token }),
        }));
        expect(answer.status).toBe(200);
        reply = await answer.json() as TokenAnswer;
        kept = browserToken(reply);
        if (notify) changed();
        return kept;
      },
      notifyRetainedIdentity: changed,
      keptIdentity: () => kept,
      onFreshRead(action: () => Promise<BrowserSession | null>) { fresh = action; },
      holdNextIdentityRead() {
        const gate = { entered: deferred<void>(), resume: deferred<void>(), called: false, captured: null as BrowserSession | null };
        identityGate = gate;
        return gate;
      },
      holdNextAccountSession() {
        const gate = { entered: deferred<void>(), resume: deferred<void>(), called: false };
        accountGate = gate;
        return gate;
      },
      async settleBackend() {
        // Drain real in-process responses and their promise continuations; a held response/save stays held.
        do {
          await new Promise<void>((resolve) => setImmediate(resolve));
          await Promise.all([...pendingResponses]);
          await new Promise<void>((resolve) => setImmediate(resolve));
        } while (pendingResponses.size);
      },
      rememberedFile: path.join(browserDir, 'accounts', 'remembered.json'),
    };
  }

  test.each(['ordinary sign-out', 'failed overlapping resume'] as const)('%s clears browser identity before reopen', async (attempt) => {
    const fixture = await browserFixture();
    const account = await fixture.open();
    expect(account.signedIn()).toBe(true);
    const entered = deferred<void>();
    const resume = deferred<void>();
    account.onRelease(async () => { entered.resolve(); await resume.promise; });
    const oldSignOut = account.signOut();
    await entered.promise;
    let refused: unknown;
    try {
      if (attempt === 'failed overlapping resume')
        refused = await account.resume('unknown-account').then((value) => ({ value }), (error: unknown) => ({ error }));
    } finally { resume.resolve(); }
    const ended = await oldSignOut;
    if (attempt === 'failed overlapping resume') expect(refused).toMatchObject({ error: { status: 404 } });
    expect(ended.signedIn).toBe(false);
    expect(account.signedIn()).toBe(false);
    const reopened = await fixture.open();
    expect(reopened.signedIn()).toBe(false);
    expect(reopened.state().person).toBeNull();
  });

  test.each(['same person', 'another person'] as const)('an older Forget preserves the newer remembered sign-in by the %s', async (replacement) => {
    const first = await session.signIn({ email: DEMO_ACCOUNTS.owner.email, password: FAUX_DEMO_PASSWORD, remember: true });
    const entered = deferred<void>();
    const resume = deferred<void>();
    const projections: (string | null)[] = [];
    session.onProjection(async (projection) => { projections.push(projection?.person.id ?? null); });
    let releases = 0;
    session.onRelease(async () => { if (++releases === 1) { entered.resolve(); await resume.promise; } });
    const oldForget = session.forget(first.person!.id).then((value) => ({ value }), (error: unknown) => ({ error }));
    await entered.promise;
    const replacementState = await (async () => {
      try {
        const next = await session.signIn({
          email: replacement === 'same person' ? DEMO_ACCOUNTS.owner.email : DEMO_ACCOUNTS.harborOwner.email,
          password: FAUX_DEMO_PASSWORD, remember: true,
        });
        return {
          next, token: await session.token(),
          remembered: JSON.parse(await fs.readFile(path.join(dir, 'accounts', 'remembered.json'), 'utf8')),
          projected: [...projections],
        };
      } finally { resume.resolve(); }
    })();
    const personId = replacementState.next.person!.id;
    expect(await oldForget).toMatchObject({ value: { signedIn: true, person: { id: personId } } });
    expect(session.state()).toMatchObject({ signedIn: true, person: { id: personId } });
    expect(await session.token()).toBe(replacementState.token);
    const remembered = JSON.parse(await fs.readFile(path.join(dir, 'accounts', 'remembered.json'), 'utf8'));
    const savedReplacement = replacementState.remembered.accounts.find((entry: { personId: string }) => entry.personId === personId);
    expect(savedReplacement.sealed).toBeTruthy();
    expect(remembered.accounts.find((entry: { personId: string }) => entry.personId === personId)).toEqual(savedReplacement);
    expect(remembered.last).toBe(personId);
    expect(projections).toEqual(replacementState.projected);
    if (replacement === 'another person')
      expect(remembered.accounts.some((entry: { personId: string }) => entry.personId === first.person!.id)).toBe(false);
    const reopened = new AccountSessionService(session.backend, dir, testOnlySecretBox(), () => clock);
    await reopened.init();
    expect(reopened.state()).toMatchObject({ signedIn: true, person: { id: personId } });
    expect((await reopened.backend.client.session(await reopened.token())).person.id).toBe(personId);
  });

  test.each([
    { target: 'current browser person', replace: false, wantSignedIn: false },
    { target: 'unrelated remembered person', replace: true, wantSignedIn: true },
  ])('Forget of the $target preserves the intended state on reopen', async ({ replace, wantSignedIn }) => {
    const fixture = await browserFixture();
    const account = await fixture.open();
    expect(account.signedIn()).toBe(true);
    const forgottenPerson = account.state().person!.id;
    if (replace) {
      const projected = deferred<void>();
      account.onProjection(async (projection) => {
        if (projection && projection.person.id !== forgottenPerson) projected.resolve();
      });
      await fixture.replaceIdentity(DEMO_ACCOUNTS.harborOwner.email);
      await projected.promise;
    }
    const remainingPerson = replace ? account.state().person!.id : null;
    expect((await account.forget(forgottenPerson)).signedIn).toBe(wantSignedIn);
    const reopened = await fixture.open();
    expect(reopened.signedIn()).toBe(wantSignedIn);
    if (remainingPerson) {
      expect(reopened.state().person?.id).toBe(remainingPerson);
      expect((await reopened.backend.client.session(await reopened.token())).person.id).toBe(remainingPerson);
    } else expect(reopened.state().person).toBeNull();
    const remembered = JSON.parse(await fs.readFile(fixture.rememberedFile, 'utf8'));
    expect(remembered.accounts.some((entry: { personId: string }) => entry.personId === forgottenPerson)).toBe(false);
  });

  describe('native identity and token rotation interleavings', () => {
    function pauseFirstSave(file: string) {
      const entered = deferred<void>();
      const resume = deferred<void>();
      const pending = new Set<Promise<void>>();
      const write = accountStorage.durableWrite;
      let writes = 0;
      vi.spyOn(accountStorage, 'durableWrite').mockImplementation((target, bytes, beforeReplace) => {
        const operation = (async () => {
          if (target === file && ++writes === 1) { entered.resolve(); await resume.promise; }
          await write(target, bytes, beforeReplace);
        })();
        pending.add(operation);
        void operation.finally(() => { pending.delete(operation); }).catch(() => {});
        return operation;
      });
      return {
        entered: entered.promise,
        resume: () => resume.resolve(),
        async settled() {
          do {
            await new Promise<void>((resolve) => setImmediate(resolve));
            await Promise.all([...pending]);
            await new Promise<void>((resolve) => setImmediate(resolve));
          } while (pending.size);
        },
      };
    }

    test.each([
      { duringForget: false, timing: 'ordinary renewal' },
      { duringForget: true, timing: 'renewal while Forget is releasing' },
    ])('$timing keeps removal scoped to the affected password sign-in', async ({ duringForget }) => {
      const owner = await session.signIn({ email: DEMO_ACCOUNTS.owner.email, password: FAUX_DEMO_PASSWORD, remember: true });
      const oldToken = await session.token();
      const rememberedFile = path.join(dir, 'accounts', 'remembered.json');
      const before = JSON.parse(await fs.readFile(rememberedFile, 'utf8'));
      const entered = deferred<void>();
      const resume = deferred<void>();
      session.onRelease(async () => { entered.resolve(); await resume.promise; });
      const forgetting = duringForget ? session.forget(owner.person!.id) : null;
      if (forgetting) await entered.promise;
      let renewed = oldToken;
      try {
        clock += 60 * 60_000;
        renewed = await session.token();
        expect(renewed).not.toBe(oldToken);
        expect(requests.filter((request) => request.pathname === '/auth/refresh')).toHaveLength(1);
        const rotated = JSON.parse(await fs.readFile(rememberedFile, 'utf8'));
        const rotatedEntry = rotated.accounts.find((entry: { personId: string }) => entry.personId === owner.person!.id);
        expect(rotatedEntry).toMatchObject({ personId: owner.person!.id, sealed: expect.any(String) });
        expect(rotatedEntry.sealed)
          .not.toBe(before.accounts.find((entry: { personId: string }) => entry.personId === owner.person!.id).sealed);
      } finally { resume.resolve(); }
      if (forgetting) expect((await forgetting).signedIn).toBe(false);
      const remembered = JSON.parse(await fs.readFile(rememberedFile, 'utf8'));
      if (duringForget) {
        expect(session.signedIn()).toBe(false);
        expect(remembered.accounts.some((entry: { personId: string }) => entry.personId === owner.person!.id)).toBe(false);
        expect(remembered.last).toBeNull();
        await expect(session.backend.client.session(renewed)).rejects.toMatchObject({ status: 401 });
      } else {
        expect((await session.backend.client.session(renewed)).person.id).toBe(owner.person!.id);
        expect(remembered.last).toBe(owner.person!.id);
      }
      const reopened = new AccountSessionService(session.backend, dir, testOnlySecretBox(), () => clock);
      await reopened.init();
      expect(reopened.signedIn()).toBe(!duringForget);
      if (!duringForget) expect((await reopened.backend.client.session(await reopened.token())).person.id).toBe(owner.person!.id);
      else expect(reopened.state().person).toBeNull();
    });

    test.each([
      { action: 'sign-out', change: 'failed native notification', keep: false },
      { action: 'Forget', change: 'failed native notification', keep: false },
      { action: 'sign-out', change: 'same-session token renewal', keep: false },
      { action: 'Forget', change: 'same-session token renewal', keep: false },
      { action: 'sign-out', change: 'new same-person native session', keep: true },
      { action: 'Forget', change: 'new same-person native session', keep: true },
    ])('$action preserves only a new session when $change arrives during its save', async ({ action, change, keep }) => {
      const fixture = await browserFixture();
      const account = await fixture.open();
      const personId = account.state().person!.id;
      const original = fixture.keptIdentity()!;
      const projected: (string | null)[] = [];
      account.onProjection(async (projection) => { projected.push(projection?.person.id ?? null); });
      const pause = pauseFirstSave(fixture.rememberedFile);
      const ending = (action === 'Forget' ? account.forget(personId) : account.signOut())
        .then((value) => ({ value }), (error: unknown) => ({ error }));
      await pause.entered;
      let nextIdentity = original;
      try {
        expect(account.signedIn()).toBe(false);
        if (change === 'failed native notification') fixture.notifyRetainedIdentity();
        else if (keep) nextIdentity = await fixture.replaceIdentity(DEMO_ACCOUNTS.owner.email);
        else {
          clock += 1_000;
          nextIdentity = await fixture.renewIdentity();
          expect(nextIdentity.accessToken).not.toBe(original.accessToken);
        }
        expect(nextIdentity.user.id).toBe(original.user.id);
        if (keep) expect(nativeId(nextIdentity)).not.toBe(nativeId(original));
        else expect(nativeId(nextIdentity)).toBe(nativeId(original));
        // Reach either refusal or the queued real save without requiring the buggy reattachment to occur.
        await fixture.settleBackend();
      } finally { pause.resume(); }
      const ended = await ending;
      await pause.settled();
      await fixture.settleBackend();
      expect(ended).toMatchObject({ value: { signedIn: keep } });
      expect(account.signedIn()).toBe(keep);
      const remembered = JSON.parse(await fs.readFile(fixture.rememberedFile, 'utf8'));
      if (keep) {
        expect(fixture.keptIdentity()?.accessToken).toBe(nextIdentity.accessToken);
        expect(await account.token()).toBe(nextIdentity.accessToken);
        expect(remembered.last).toBe(personId);
        expect(remembered.accounts.some((entry: { personId: string }) => entry.personId === personId)).toBe(true);
        expect(projected.at(-1)).toBe(personId);
      } else {
        expect(fixture.keptIdentity()).toBeNull();
        expect(account.state().person).toBeNull();
        await expect(account.token()).rejects.toMatchObject({ status: 401 });
        expect(remembered.last).toBeNull();
        if (action === 'Forget') expect(remembered.accounts.some((entry: { personId: string }) => entry.personId === personId)).toBe(false);
        expect(projected.at(-1)).toBeNull();
      }
      const reopened = await fixture.open();
      expect(reopened.signedIn()).toBe(keep);
      if (keep) expect((await reopened.backend.client.session(await reopened.token())).person.id).toBe(personId);
      else expect(reopened.state().person).toBeNull();
    });

    test.each(['sign-out', 'Forget'] as const)('%s still ends a native session renewed during its release callback', async (action) => {
      const fixture = await browserFixture();
      const account = await fixture.open();
      const personId = account.state().person!.id;
      const original = fixture.keptIdentity()!;
      const entered = deferred<void>();
      const resume = deferred<void>();
      account.onRelease(async () => { entered.resolve(); await resume.promise; });
      const ending = (action === 'Forget' ? account.forget(personId) : account.signOut())
        .then((value) => ({ value }), (error: unknown) => ({ error }));
      await entered.promise;
      try {
        clock += 1_000;
        const renewed = await fixture.renewIdentity();
        expect(renewed.accessToken).not.toBe(original.accessToken);
        expect(nativeId(renewed)).toBe(nativeId(original));
        await fixture.settleBackend();
        expect(account.state().person?.id).toBe(personId);
        expect(await account.token()).toBe(renewed.accessToken);
      } finally { resume.resolve(); }
      expect(await ending).toMatchObject({ value: { signedIn: false } });
      await fixture.settleBackend();
      expect(account.signedIn()).toBe(false);
      expect(fixture.keptIdentity()).toBeNull();
      const remembered = JSON.parse(await fs.readFile(fixture.rememberedFile, 'utf8'));
      expect(remembered.last).toBeNull();
      if (action === 'Forget') expect(remembered.accounts.some((entry: { personId: string }) => entry.personId === personId)).toBe(false);
      const reopened = await fixture.open();
      expect(reopened.state()).toMatchObject({ signedIn: false, person: null });
    });

    test.each(['same person', 'another person'] as const)('sign-out preserves a newer native session for the %s awaiting its account response', async (replacement) => {
      const fixture = await browserFixture();
      const account = await fixture.open();
      const previous = fixture.keptIdentity()!;
      const previousPerson = account.state().person!.id;
      const entered = deferred<void>();
      const resume = deferred<void>();
      const projected = deferred<string>();
      let releases = 0;
      account.onRelease(async () => { if (++releases === 1) { entered.resolve(); await resume.promise; } });
      account.onProjection(async (projection) => { if (projection) projected.resolve(projection.person.id); });
      const oldSignOut = account.signOut().then((value) => ({ value }), (error: unknown) => ({ error }));
      await entered.promise;
      const gate = fixture.holdNextAccountSession();
      let nextIdentity = previous;
      try {
        nextIdentity = await fixture.replaceIdentity(replacement === 'same person' ? DEMO_ACCOUNTS.owner.email : DEMO_ACCOUNTS.harborOwner.email);
        expect(nativeId(nextIdentity)).not.toBe(nativeId(previous));
        await fixture.settleBackend();
        expect(gate.called).toBe(true);
        expect(account.state().person?.id).toBe(previousPerson);
        resume.resolve();
        expect(await oldSignOut).toMatchObject({ value: { signedIn: false } });
        expect(fixture.keptIdentity()?.accessToken).toBe(nextIdentity.accessToken);
      } finally { resume.resolve(); gate.resume.resolve(); }
      const personId = await projected.promise;
      expect(account.state()).toMatchObject({ signedIn: true, person: { id: personId } });
      expect(await account.token()).toBe(nextIdentity.accessToken);
      if (replacement === 'same person') expect(personId).toBe(previousPerson);
      else expect(personId).not.toBe(previousPerson);
      const reopened = await fixture.open();
      expect((await reopened.backend.client.session(await reopened.token())).person.id).toBe(personId);
    });

    test.each(['same-session renewal', 'new same-person session'] as const)('a bearer request remains bound to its original native session after %s', async (renewal) => {
      const fixture = await browserFixture();
      const account = await fixture.open();
      const original = fixture.keptIdentity()!;
      const personId = account.state().person!.id;
      const projections: (string | null)[] = [];
      account.onProjection(async (projection) => { projections.push(projection?.person.id ?? null); });
      fixture.onFreshRead(() => renewal === 'same-session renewal'
        ? fixture.renewIdentity(false)
        : fixture.replaceIdentity(DEMO_ACCOUNTS.owner.email, false));
      clock += 250_000;
      const result = await account.token().then((value) => ({ value }), (error: unknown) => ({ error }));
      await fixture.settleBackend();
      const current = fixture.keptIdentity()!;
      expect(current.user.id).toBe(original.user.id);
      expect(current.accessToken).not.toBe(original.accessToken);
      if (renewal === 'same-session renewal') {
        expect(nativeId(current)).toBe(nativeId(original));
        expect(result).toEqual({ value: current.accessToken });
        expect(account.signedIn()).toBe(true);
        expect(projections).toEqual([]);
      } else {
        expect(nativeId(current)).not.toBe(nativeId(original));
        expect(result).toMatchObject({ error: { status: 401 } });
        expect(account.signedIn()).toBe(false);
        expect(projections).toEqual([null]);
      }
      const reopened = await fixture.open();
      expect(reopened.state()).toMatchObject({ signedIn: true, person: { id: personId } });
      expect((await reopened.backend.client.session(await reopened.token())).person.id).toBe(personId);
    });
  });

  describe('native cleanup identity-read interleavings', () => {
    test.each([
      { action: 'sign-out', change: 'unchanged-session notification', keep: false, pending: false },
      { action: 'Forget', change: 'unchanged-session notification', keep: false, pending: false },
      { action: 'sign-out', change: 'new same-person session', keep: true, pending: false },
      { action: 'Forget', change: 'new same-person session', keep: true, pending: false },
      { action: 'sign-out', change: 'new same-person session awaiting its account response', keep: true, pending: true },
      { action: 'Forget', change: 'new same-person session awaiting its account response', keep: true, pending: true },
    ])('$action preserves only a new session when $change crosses its native identity read', async ({ action, keep, pending }) => {
      const fixture = await browserFixture();
      const account = await fixture.open();
      const personId = account.state().person!.id;
      const original = fixture.keptIdentity()!;
      const projected: (string | null)[] = [];
      account.onProjection(async (projection) => { projected.push(projection?.person.id ?? null); });
      const released = deferred<void>();
      const resumeRelease = deferred<void>();
      let releases = 0;
      account.onRelease(async () => { if (++releases === 1) { released.resolve(); await resumeRelease.promise; } });

      const pendingWrites = new Set<Promise<void>>();
      const write = accountStorage.durableWrite;
      vi.spyOn(accountStorage, 'durableWrite').mockImplementation((target, bytes, beforeReplace) => {
        const operation = write(target, bytes, beforeReplace);
        pendingWrites.add(operation);
        void operation.finally(() => { pendingWrites.delete(operation); }).catch(() => {});
        return operation;
      });
      async function settled() {
        do {
          await fixture.settleBackend();
          await Promise.all([...pendingWrites]);
          await fixture.settleBackend();
        } while (pendingWrites.size);
      }

      const ending = (action === 'Forget' ? account.forget(personId) : account.signOut())
        .then((value) => ({ value }), (error: unknown) => ({ error }));
      let read: ReturnType<typeof fixture.holdNextIdentityRead> | undefined;
      let accountRead: ReturnType<typeof fixture.holdNextAccountSession> | undefined;
      let ended: Awaited<typeof ending> | undefined;
      let nextIdentity = original;
      try {
        await released.promise;
        fixture.notifyRetainedIdentity();
        await settled();
        expect(account.state()).toMatchObject({ signedIn: true, person: { id: personId } });
        expect(fixture.keptIdentity()).toBe(original);

        read = fixture.holdNextIdentityRead();
        resumeRelease.resolve();
        await settled();
        expect(read.called).toBe(true);
        await read.entered.promise;
        expect(read.captured).toBe(original);
        expect(account.state()).toMatchObject({ signedIn: false, person: null });
        expect(fixture.keptIdentity()).toBe(original);

        if (pending) accountRead = fixture.holdNextAccountSession();
        if (keep) nextIdentity = await fixture.replaceIdentity(DEMO_ACCOUNTS.owner.email);
        else fixture.notifyRetainedIdentity();
        expect(nextIdentity.user.id).toBe(original.user.id);
        if (keep) expect(nativeId(nextIdentity)).not.toBe(nativeId(original));
        else expect(fixture.keptIdentity()).toBe(original);
        // Return the captured old S even when the kept identity is now S2. Do not await the follower here.
        read.resume.resolve();
        ended = await ending;
        await settled();
        if (accountRead) {
          expect(accountRead.called).toBe(true);
          expect(ended).toMatchObject({ value: { signedIn: false } });
          expect(account.signedIn()).toBe(false);
          expect(fixture.keptIdentity()?.accessToken).toBe(nextIdentity.accessToken);
        }
      } finally {
        resumeRelease.resolve();
        read?.resume.resolve();
        accountRead?.resume.resolve();
        await ending;
        await settled();
      }

      if (keep) {
        expect(ended).toHaveProperty('value');
        expect(fixture.keptIdentity()?.accessToken).toBe(nextIdentity.accessToken);
        expect(account.state()).toMatchObject({ signedIn: true, person: { id: personId } });
        expect(await account.token()).toBe(nextIdentity.accessToken);
        expect((await account.backend.client.session(await account.token())).person.id).toBe(personId);
        expect(projected.at(-1)).toBe(personId);
      } else {
        expect(fixture.keptIdentity() === null, 'native session must be cleared after cleanup').toBe(true);
        expect(ended).toMatchObject({ value: { signedIn: false, person: null } });
        expect(account.state()).toMatchObject({ signedIn: false, person: null });
        await expect(account.token()).rejects.toMatchObject({ status: 401 });
        expect(projected.at(-1)).toBeNull();
        expect(projected.every((person) => person === null)).toBe(true);
      }
      const remembered = JSON.parse(await fs.readFile(fixture.rememberedFile, 'utf8'));
      expect(remembered.last).toBe(keep ? personId : null);
      if (keep) {
        expect(remembered.accounts.some((entry: { personId: string }) => entry.personId === personId)).toBe(true);
        expect(account.state().remembered.some((entry) => entry.personId === personId)).toBe(true);
      } else if (action === 'Forget') {
        expect(remembered.accounts.some((entry: { personId: string }) => entry.personId === personId)).toBe(false);
        expect(account.state().remembered.some((entry) => entry.personId === personId)).toBe(false);
      } else {
        expect(remembered.accounts.find((entry: { personId: string }) => entry.personId === personId)?.sealed ?? null).toBeNull();
      }
      const reopened = await fixture.open();
      expect(reopened.state()).toMatchObject({ signedIn: keep, person: keep ? { id: personId } : null });
      if (keep) expect((await reopened.backend.client.session(await reopened.token())).person.id).toBe(personId);
      else if (action === 'Forget') expect(reopened.state().remembered.some((entry) => entry.personId === personId)).toBe(false);
    });
  });
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  await fs.rm(dir, { recursive: true, force: true });
});

describe('account requests stay bound to the sign-in that started them', () => {
  test('a delayed refused membership change never retries as the newly signed-in owner', async () => {
    await signIn(DEMO_ACCOUNTS.manager.email);
    const roster = await session.roster(juniper);
    const employee = roster.people.find((person) => person.role === 'member')!;
    const target = `/account/organizations/${juniper}/members/${employee.personId}`;
    const entered = deferred<void>();
    const resume = deferred<void>();
    intercept = (request) => {
      if (request.method !== 'PATCH' || new URL(request.url).pathname !== target) return null;
      intercept = null;
      entered.resolve();
      return resume.promise.then(() => cloud.handle(request));
    };
    const pending = session.setMember(juniper, employee.personId, { role: 'owner', state: 'active' });
    const outcome = pending.then((value) => ({ value }), (error: unknown) => ({ error }));
    await entered.promise;
    // Switching signs the Manager out at the real fixture service. Its delayed request gets 401.
    const owner = await signIn(DEMO_ACCOUNTS.owner.email);
    resume.resolve();
    expect(await outcome).toMatchObject({ error: { status: 401 } });
    expect(requests.filter((request) => request.pathname === target)).toHaveLength(1);
    expect((await session.roster(juniper)).people.find((person) => person.personId === employee.personId)?.role).toBe('member');
    expect(session.state().person?.id).toBe(owner.person?.id);
  });

  test.each(['sign-out', 'another account'] as const)('discards an old account response after %s', async (change) => {
    await signIn(DEMO_ACCOUNTS.owner.email);
    const target = `/account/organizations/${juniper}/roster`;
    const entered = deferred<void>();
    const resume = deferred<void>();
    intercept = (request) => {
      if (new URL(request.url).pathname !== target) return null;
      intercept = null;
      return cloud.handle(request).then(async (answer) => {
        expect(answer.status).toBe(200);
        entered.resolve();
        await resume.promise;
        return answer;
      });
    };
    const outcome = session.roster(juniper).then((value) => ({ value }), (error: unknown) => ({ error }));
    await entered.promise;
    if (change === 'sign-out') await session.signOut();
    else await signIn(DEMO_ACCOUNTS.harborOwner.email);
    resume.resolve();
    expect(await outcome).toMatchObject({ error: { status: 401 } });
  });

  test('still retries one refused token within the same sign-in', async () => {
    await signIn(DEMO_ACCOUNTS.owner.email);
    const target = `/account/organizations/${juniper}/roster`;
    intercept = (request) => {
      if (new URL(request.url).pathname !== target) return null;
      intercept = null;
      return Promise.resolve(Response.json({ error: 'Expired token.' }, { status: 401 }));
    };
    expect(await session.roster(juniper)).toMatchObject({ organizationId: juniper });
    expect(requests.filter((request) => request.pathname === target)).toHaveLength(2);
    expect(requests.filter((request) => request.pathname === '/auth/refresh')).toHaveLength(1);
  });

  test('a token renewal never returns the replacement account bearer to old work', async () => {
    await signIn(DEMO_ACCOUNTS.owner.email);
    clock += 60 * 60_000;
    const entered = deferred<void>();
    const resume = deferred<void>();
    intercept = (request) => {
      if (new URL(request.url).pathname !== '/auth/refresh') return null;
      intercept = null;
      return cloud.handle(request).then(async (answer) => {
        expect(answer.status).toBe(200);
        entered.resolve();
        await resume.promise;
        return answer;
      });
    };
    const outcome = session.token().then((value) => ({ value }), (error: unknown) => ({ error }));
    await entered.promise;
    const replacement = await signIn(DEMO_ACCOUNTS.harborOwner.email);
    resume.resolve();
    expect(await outcome).toMatchObject({ error: { status: 401 } });
    expect(session.state().person?.id).toBe(replacement.person?.id);
  });

  test('an old refresh refusal does not end a new sign-in by the same person', async () => {
    const owner = await signIn(DEMO_ACCOUNTS.owner.email);
    clock += 60 * 60_000;
    const entered = deferred<void>();
    const resume = deferred<void>();
    intercept = (request) => {
      if (new URL(request.url).pathname !== '/auth/refresh') return null;
      intercept = null;
      entered.resolve();
      return resume.promise.then(() => cloud.handle(request));
    };
    const outcome = session.token().then((value) => ({ value }), (error: unknown) => ({ error }));
    await entered.promise;
    await session.signOut();
    await signIn(DEMO_ACCOUNTS.owner.email);
    resume.resolve();
    expect(await outcome).toMatchObject({ error: { status: 401 } });
    expect(session.state()).toMatchObject({ signedIn: true, person: { id: owner.person!.id } });
  });

  test('an old WorkOS renewal cannot end a replacement browser sign-in', async () => {
    const browserCloud = await createFauxCloud({ file: null, identity: 'workos-standin', now: () => clock });
    await seedDemo(browserCloud);
    const provider = browserCloud.standIn!;
    const ownerToken = async (): Promise<BrowserSession> => {
      const reply = await provider.signInDirect(DEMO_ACCOUNTS.owner.email);
      return { accessToken: reply.access_token, user: { id: reply.user.id, email: reply.user.email, name: 'Owner' } };
    };
    let kept: BrowserSession | null = await ownerToken();
    const entered = deferred<void>();
    const resume = deferred<BrowserSession | null>();
    const identity: BrowserIdentity = {
      async begin() {},
      async session(options = {}) {
        if (options.fresh) { entered.resolve(); return resume.promise; }
        return kept;
      },
      async signOut() { kept = null; },
      status: () => ({ status: kept ? 'signed-in' : 'signed-out', message: '' }),
      onChange: () => () => {},
    };
    const backend: AccountBackend = {
      client: new ControlPlaneClient('https://accounts.example.test', (request) => browserCloud.handle(request)),
      view: () => ({ kind: 'cloud', label: 'Offline account fixture', url: 'https://accounts.example.test', reason: null, signIn: 'browser' }),
      close: async () => {},
    };
    const browserSession = new AccountSessionService(backend, path.join(dir, 'browser'), null, () => clock, {
      identity,
      expect: { clientId: provider.clientId, issuers: [WORKOS_ISSUER, `${WORKOS_ISSUER}/user_management/${provider.clientId}`], audience: provider.audience },
    });
    await browserSession.init();
    expect(browserSession.signedIn()).toBe(true);
    const owner = browserSession.state().person!;
    clock += 250_000;
    const outcome = browserSession.token().then((value) => ({ value }), (error: unknown) => ({ error }));
    await entered.promise;
    await browserSession.signOut();
    kept = await ownerToken();
    await browserSession.signInWithBrowser();
    resume.resolve(null);
    expect(await outcome).toMatchObject({ error: { status: 401 } });
    expect(browserSession.state()).toMatchObject({ signedIn: true, person: { id: owner.id } });
  });
});
