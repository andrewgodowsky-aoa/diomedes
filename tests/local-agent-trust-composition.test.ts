/**
 * Independent composition acceptance for protected Personal desktop Trust.
 * AccountSessionService, WorkspaceService, OS identity, durable writes, app,
 * Harness and Team composition are real. The HTTPS account view is explicitly
 * an offline cloud-shaped transport over FauxCloud/its WorkOS stand-in. No
 * deployed identity, real account, bought entitlement or live model is proved.
 * No global Trust backend, hosted flag, authority/admission override or provider
 * response is installed. Factory observations always return original objects.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { request as httpRequest, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomBytes } from 'node:crypto';
import { Store } from '../server/store.js';
import { WorkspaceService } from '../server/workspaces.js';
import { AccountSessionService, type AccountProjection } from '../server/accounts/session.js';
import type { AccountBackend } from '../server/accounts/backend.js';
import { ControlPlaneClient } from '../server/accounts/client.js';
import { checkBrowserToken, type BrowserIdentity, type BrowserSession } from '../server/accounts/browser-identity.js';
import { testOnlySecretBox } from '../server/connection-secrets.js';
import { createApp } from '../server/app.js';
import { EngineService } from '../server/engines/service.js';
import * as localTrustModule from '../server/trust/local-backend.js';
import * as harnessModule from '../server/harness/host.js';
import * as teamHostModule from '../server/agent-team-host.js';
import { currentAuthority, disablePrototypeAuthority, isDenial, refOf, requireCapability,
  trustBackendInstalled, type Authority, type Denial } from '../server/trust/index.js';
import { __resetRevocationState } from '../server/trust/revocation.js';
import { createFauxCloud } from '../services/control-plane/src/faux/cloud.js';
import { DEMO_ACCOUNTS, FAUX_DEMO_PASSWORD, seedDemo, type DemoAccount } from '../services/control-plane/src/faux/seed.js';
import { WORKOS_ISSUER, type TokenAnswer } from '../services/control-plane/src/faux/workos-standin.js';
import type { OpenRouterConnectionView } from '../shared/model-api.js';
import type { Task } from '../shared/types.js';
import type { WorkspaceRef, WorkspaceView } from '../shared/workspaces.js';

type LocalBackend = Awaited<ReturnType<typeof localTrustModule.createLocalTrustBackend>>;
type AccountInterceptor = ((request: Request) => Promise<Response> | null) | null;
const ORIGIN = 'https://accounts.fixture.invalid';
const MODEL = 'openai/gpt-6.1-sol';
const KEY = 'sk-or-local-trust-offline-only-0123456789abcdef-never-real';
let directory: string, clock: number;
let backends: LocalBackend[], cleanup: (() => void)[], apps: (() => Promise<void>)[];

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
const settled = <T>(promise: Promise<T>) => promise.then(value => ({ value }), (error: unknown) => ({ error }));
function granted(value: Authority | Denial): Authority {
  if (isDenial(value)) throw new Error(`Authority refused: ${value.code}: ${value.reason}`);
  expect(value.synthetic).toBe(false);
  return value;
}
function denied(value: Authority | Denial): Denial {
  expect(isDenial(value)).toBe(true);
  if (!isDenial(value)) throw new Error('Unproved identity was admitted.');
  return value;
}

/** Below-service transport only; it never opens a socket or selects live providers. */
async function cloudFixture(native = false) {
  const cloud = await createFauxCloud({ file: null, passwordIterations: 1_000, now: () => clock,
    identity: native ? 'workos-standin' : 'password', liveBedrockApiKey: null, liveOpenRouterApiKey: null });
  expect(cloud.provider).toBe('scripted');
  expect(cloud.evaluationProvider).toBe('scripted');
  const seeded = await seedDemo(cloud);
  const requests: { method: string; pathname: string }[] = [];
  let intercept: AccountInterceptor = null;
  let kind: 'cloud' | 'faux' = 'cloud', url: string | null = ORIGIN;
  const backend: AccountBackend = {
    client: new ControlPlaneClient(ORIGIN, request => {
      const destination = new URL(request.url);
      if (destination.origin !== ORIGIN) throw new Error('Unexpected account fixture destination.');
      requests.push({ method: request.method, pathname: destination.pathname });
      return intercept?.(request) ?? cloud.handle(request);
    }),
    view: () => ({ kind, label: 'Offline cloud-shaped composition fixture; not deployed identity',
      url, reason: null, signIn: native ? 'browser' : 'password' }),
    close: async () => {},
  };
  let kept: BrowserSession | null = null, reply: TokenAnswer | null = null;
  const listeners = new Set<() => void>();
  const notify = () => { for (const listener of listeners) listener(); };
  const identity: BrowserIdentity = {
    begin: async () => {}, session: async () => kept,
    signOut: async () => { kept = null; notify(); },
    status: () => ({ status: kept ? 'signed-in' : 'signed-out', message: '' }),
    onChange: listener => { listeners.add(listener); return () => { listeners.delete(listener); }; },
  };
  const browser = native ? { identity, expect: { clientId: cloud.standIn!.clientId,
    issuers: [WORKOS_ISSUER, `${WORKOS_ISSUER}/user_management/${cloud.standIn!.clientId}`],
    audience: cloud.standIn!.audience } } : null;
  const asBrowser = (answer: TokenAnswer): BrowserSession => ({ accessToken: answer.access_token,
    user: { id: answer.user.id, email: answer.user.email, name: 'Offline stand-in person' } });
  return {
    cloud, seeded, backend, requests, browser, notify,
    intercept(action: AccountInterceptor) { intercept = action; },
    backendView(next: { kind: 'cloud' | 'faux'; url: string | null }) { kind = next.kind; url = next.url; },
    kept: () => kept,
    async replaceNative(who: DemoAccount = 'free') {
      reply = await cloud.standIn!.signInDirect(DEMO_ACCOUNTS[who].email);
      kept = asBrowser(reply); return kept;
    },
    async renewNative() {
      if (!reply) throw new Error('No stand-in session to renew.');
      // The same real stand-in SID gets a differently issued token.
      clock += 1_000;
      const response = await cloud.standIn!.handle(new Request(`${WORKOS_ISSUER}/user_management/authenticate`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ client_id: cloud.standIn!.clientId, grant_type: 'refresh_token', refresh_token: reply.refresh_token }),
      }));
      expect(response.status).toBe(200);
      reply = await response.json() as TokenAnswer;
      kept = asBrowser(reply); return kept;
    },
    async issueIndividual(who: DemoAccount = 'free') {
      // seedDemo already created these identities; the password seed helper signs
      // up a new identity. Use their actual public sign-in before issuing a grant.
      const token = native ? (await cloud.standIn!.signInDirect(DEMO_ACCOUNTS[who].email)).access_token
        : (await backend.client.signIn({ email: DEMO_ACCOUNTS[who].email, password: FAUX_DEMO_PASSWORD, remember: false })).accessToken;
      const staff = native ? (await cloud.standIn!.signInDirect(DEMO_ACCOUNTS.staffBilling.email)).access_token
        : (await backend.client.signIn({ email: DEMO_ACCOUNTS.staffBilling.email, password: FAUX_DEMO_PASSWORD, remember: false })).accessToken;
      const personId = (await cloud.accounts.signIn(token)).person.id;
      await cloud.commercial.issuePersonGrant(staff, personId, { planId: 'individual', source: 'internal-test',
        reference: 'Offline composition fixture; nothing bought', note: 'Synthetic entitlement boundary input.' });
      return personId;
    },
  };
}

async function serviceFixture(native = false) {
  const transport = await cloudFixture(native);
  const store = new Store(path.join(directory, 'service-data'), path.join(directory, 'service-projects'));
  await store.init();
  const projectId = (await store.locked(() => store.createProject('Personal composition fixture'))).id;
  const workspace = new WorkspaceService(store);
  await workspace.init();
  const account = new AccountSessionService(transport.backend, store.dataDir, testOnlySecretBox(), () => clock, transport.browser);
  workspace.connectAccounts({ entitlement: id => account.entitlement(id), createOrganization: name => account.createOrganization(name) });
  const project = (projection: AccountProjection | null) => store.locked(() => workspace.project(projection));
  account.onProjection(project);
  await workspace.openPersonalAuthority();
  await account.init();
  const local = await localTrustModule.createLocalTrustBackend({ store, accountFacts: () => account.authorityFacts(),
    personalFacts: id => workspace.personalAuthorityFacts(id), now: () => clock });
  backends.push(local);
  return { ...transport, store, projectId, workspace, account, local, project,
    switch: (ref: WorkspaceRef) => store.locked(() => workspace.switchTo(ref)),
    async signIn(who: DemoAccount = 'free') {
      if (native) { await transport.replaceNative(who); return account.signInWithBrowser(); }
      return account.signIn({ email: DEMO_ACCOUNTS[who].email, password: FAUX_DEMO_PASSWORD, remember: true });
    },
  };
}

/** Hold/fail the real fsync -> rename boundary, after Store already changed memory. */
function holdRename(target: string) {
  const entered = deferred(), release = deferred();
  cleanup.push(release.resolve);
  const original = fs.rename.bind(fs);
  let held = false;
  const spy = vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
    if (!held && path.resolve(String(to)) === path.resolve(target)) {
      held = true; entered.resolve(); await release.promise;
      throw new Error('Owned fixture rejected the final durable rename.');
    }
    return original(from, to);
  });
  return { entered: entered.promise, release: release.resolve, restore: () => spy.mockRestore() };
}

beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'diomedes-local-trust-composition-'));
  clock = Date.now(); backends = []; cleanup = []; apps = [];
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('Only in-process account transport and owned loopback HTTP are allowed.'); }));
});
afterEach(async () => {
  for (const release of cleanup) release();
  for (const close of apps.reverse()) await close();
  for (const backend of backends) backend.close();
  vi.restoreAllMocks(); vi.unstubAllGlobals(); disablePrototypeAuthority(); __resetRevocationState();
  await fs.rm(directory, { recursive: true, force: true });
});

describe('real verified account publication into scoped OS-owner Trust', () => {
  test('sign-out closes facts and old refs before a held release, even with a frozen clock', async () => {
    const fixture = await serviceFixture();
    await fixture.signIn();
    const facts = fixture.account.authorityFacts()!;
    expect(facts).toMatchObject({ backendKind: 'cloud', personId: fixture.account.state().person!.id,
      lifecycle: facts.publishedLifecycle, backendKey: `cloud:${ORIGIN}` });
    expect(facts.sessionId).toMatch(/^host-published:/);
    expect(facts).not.toHaveProperty('accessToken');
    expect(facts).not.toHaveProperty('refreshToken');
    const first = refOf(granted(await fixture.local.ownerAuthority(fixture.projectId)));
    const entered = deferred(), release = deferred(); cleanup.push(release.resolve);
    fixture.account.onRelease(async () => { entered.resolve(); await release.promise; });
    const pending = settled(fixture.account.signOut());
    await entered.promise;
    const calls = fixture.requests.length;
    expect(fixture.account.state().signedIn, 'view is still cleaning up; authority already ended').toBe(true);
    for (let i = 0; i < 3; i++) {
      expect(fixture.account.authorityFacts()).toBeNull();
      denied(await fixture.local.ownerAuthority(fixture.projectId));
      expect(denied(await fixture.local.resolve({ via: 'stored-reference', ref: first })).code).toBe('unknown-principal');
    }
    expect(fixture.requests).toHaveLength(calls);
    expect(fixture.requests.filter(row => row.method === 'POST' && row.pathname.endsWith('/agent-admissions'))).toHaveLength(0);
    release.resolve();
    expect(await pending).toMatchObject({ value: { signedIn: false } });
    expect(fixture.account.authorityFacts()).toBeNull();
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  test('a fresh same-person password sign-in gets a new publication nonce without restoring the old ref', async () => {
    const fixture = await serviceFixture();
    await fixture.signIn();
    const firstFacts = fixture.account.authorityFacts()!, first = refOf(granted(await fixture.local.ownerAuthority(fixture.projectId)));
    const timestamp = clock;
    await fixture.account.signOut();
    await fixture.signIn();
    const nextFacts = fixture.account.authorityFacts()!;
    expect(clock).toBe(timestamp);
    expect(nextFacts.personId).toBe(firstFacts.personId);
    expect(nextFacts.lifecycle).toBeGreaterThan(firstFacts.lifecycle);
    expect(nextFacts.publishedLifecycle).toBe(nextFacts.lifecycle);
    expect(nextFacts.sessionId).not.toBe(firstFacts.sessionId);
    denied(await fixture.local.resolve({ via: 'stored-reference', ref: first }));
    expect(granted(await fixture.local.ownerAuthority(fixture.projectId)).principal.id).not.toBe(first.id);
  });

  test('a pending and then refused account switch cannot publish the old signed-in Current', async () => {
    const fixture = await serviceFixture(); await fixture.signIn();
    const first = refOf(granted(await fixture.local.ownerAuthority(fixture.projectId)));
    const entered = deferred(), release = deferred(); cleanup.push(release.resolve);
    fixture.intercept(request => {
      if (new URL(request.url).pathname !== '/account/session') return null;
      fixture.intercept(null);
      return fixture.cloud.handle(request).then(async answer => {
        expect(answer.status).toBe(200); entered.resolve(); await release.promise;
        return Response.json({ error: 'offline_switch_refused', message: 'Owned fixture refused this new sign-in.' }, { status: 401 });
      });
    });
    const switching = settled(fixture.signIn('owner'));
    await entered.promise;
    expect(fixture.account.state().signedIn).toBe(true);
    expect(fixture.account.authorityFacts()).toBeNull();
    denied(await fixture.local.resolve({ via: 'stored-reference', ref: first }));
    release.resolve();
    expect(await switching).toMatchObject({ error: { status: 401 } });
    expect(fixture.account.authorityFacts()).toBeNull();
    denied(await fixture.local.ownerAuthority(fixture.projectId));
    await fixture.signIn();
    expect(granted(await fixture.local.ownerAuthority(fixture.projectId)).principal.id).not.toBe(first.id);
  });

  test('an actual signed-in faux/HTTP session or expired publication is never promoted to owner authority', async () => {
    const fixture = await serviceFixture(); await fixture.signIn();
    const firstFacts = fixture.account.authorityFacts()!, first = refOf(granted(await fixture.local.ownerAuthority(fixture.projectId)));
    const calls = fixture.requests.length;
    for (const view of [{ kind: 'faux' as const, url: ORIGIN }, { kind: 'cloud' as const, url: 'http://127.0.0.1:8795' }]) {
      fixture.backendView(view);
      expect(fixture.account.state().signedIn).toBe(true);
      expect(fixture.account.authorityFacts()).toBeNull();
      denied(await fixture.local.ownerAuthority(fixture.projectId));
      denied(await fixture.local.resolve({ via: 'stored-reference', ref: first }));
    }
    fixture.backendView({ kind: 'cloud', url: ORIGIN });
    clock = Date.parse(firstFacts.expiresAt);
    expect(fixture.account.authorityFacts()).toBeNull();
    denied(await fixture.local.ownerAuthority(fixture.projectId));
    expect(fixture.requests).toHaveLength(calls);
  });

  test.each([
    { boundary: 'keep', token: 'retained' },
    { boundary: 'projection', token: 'rotated same-session' },
  ] as const)('failed initial $boundary with a $token token repeats complete verification before first publication', async ({ boundary, token }) => {
    const fixture = await serviceFixture(true);
    const entered = deferred(), release = deferred(); cleanup.push(release.resolve);
    let projections = 0;
    fixture.account.onProjection(async projection => {
      projections++;
      if (boundary === 'projection' && projections === 1) throw new Error('Owned projection failed before publication.');
      entered.resolve(); await release.promise; await fixture.project(projection);
    });
    let keepFailure: ReturnType<typeof holdRename> | undefined;
    if (boundary === 'keep') keepFailure = holdRename(path.join(fixture.store.dataDir, 'accounts', 'remembered.json'));
    const firstAttempt = settled(fixture.signIn());
    if (keepFailure) { await keepFailure.entered; keepFailure.release(); }
    expect(await firstAttempt).toHaveProperty('error');
    keepFailure?.restore();
    expect(fixture.account.state().signedIn, 'Current exists after failed keep/projection, but is unissued').toBe(true);
    expect(fixture.account.authorityFacts()).toBeNull();
    denied(await fixture.local.ownerAuthority(fixture.projectId));
    const originalToken = fixture.kept()!.accessToken;
    const originalClaims = checkBrowserToken(originalToken, fixture.browser!.expect, clock)!;
    if (token === 'rotated same-session') {
      const renewed = await fixture.renewNative();
      expect(renewed.accessToken).not.toBe(originalToken);
      expect(checkBrowserToken(renewed.accessToken, fixture.browser!.expect, clock)!.sessionId).toBe(originalClaims.sessionId);
    }
    const previousSessionReads = fixture.requests.filter(row => row.pathname === '/account/session').length;
    fixture.notify();
    expect(fixture.account.authorityFacts()).toBeNull();
    await entered.promise;
    expect(fixture.requests.filter(row => row.pathname === '/account/session')).toHaveLength(previousSessionReads + 1);
    expect(fixture.account.authorityFacts()).toBeNull();
    denied(await fixture.local.ownerAuthority(fixture.projectId));
    release.resolve();
    await vi.waitFor(() => expect(fixture.account.authorityFacts()).not.toBeNull());
    expect(fixture.account.authorityFacts()!.sessionId).toBe(originalClaims.sessionId);
    expect(fixture.account.authorityFacts()!.publishedLifecycle).toBe(fixture.account.authorityFacts()!.lifecycle);
    expect(projections).toBe(boundary === 'keep' ? 1 : 2);
    granted(await fixture.local.ownerAuthority(fixture.projectId));
  });

  test('native same-SID renewal cannot republish while sign-out holds that browser session closed', async () => {
    const fixture = await serviceFixture(true); await fixture.signIn();
    const firstFacts = fixture.account.authorityFacts()!, first = refOf(granted(await fixture.local.ownerAuthority(fixture.projectId)));
    const entered = deferred(), release = deferred(); cleanup.push(release.resolve);
    fixture.account.onRelease(async () => { entered.resolve(); await release.promise; });
    const ending = settled(fixture.account.signOut()); await entered.promise;
    const renewed = await fixture.renewNative();
    expect(checkBrowserToken(renewed.accessToken, fixture.browser!.expect, clock)!.sessionId).toBe(firstFacts.sessionId);
    fixture.notify();
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(fixture.account.authorityFacts()).toBeNull();
    denied(await fixture.local.resolve({ via: 'stored-reference', ref: first }));
    release.resolve();
    expect(await ending).toMatchObject({ value: { signedIn: false } });
    expect(fixture.kept()).toBeNull();
    expect(fixture.account.authorityFacts()).toBeNull();
  });
});

describe('durable workspace scope composes with verified account facts', () => {
  test.each(['Personal to Business', 'Business to Personal'] as const)('%s stays closed while settings rename is pending and after it fails', async direction => {
    const fixture = await serviceFixture(); await fixture.signIn('owner');
    const business: WorkspaceRef = { kind: 'business', organizationId: fixture.seeded.organizations!.juniper };
    await fixture.switch({ kind: 'personal' });
    const first = refOf(granted(await fixture.local.ownerAuthority(fixture.projectId)));
    if (direction === 'Business to Personal') await fixture.switch(business);
    const selected: WorkspaceRef = direction === 'Personal to Business' ? business : { kind: 'personal' };
    const hold = holdRename(path.join(fixture.store.dataDir, 'settings.json'));
    const switching = settled(fixture.switch(selected)); await hold.entered;
    expect(fixture.store.settings.activeWorkspace).toEqual(selected);
    expect(fixture.workspace.personalAuthorityFacts(fixture.projectId)).toBeNull();
    denied(await fixture.local.ownerAuthority(fixture.projectId));
    denied(await fixture.local.resolve({ via: 'stored-reference', ref: first }));
    hold.release(); expect(await switching).toHaveProperty('error'); hold.restore();
    expect(fixture.workspace.personalAuthorityFacts(fixture.projectId)).toBeNull();
    denied(await fixture.local.ownerAuthority(fixture.projectId));
    // A later ordinary settings retry cannot turn a failed durable authority transition back on.
    await fixture.switch({ kind: 'personal' });
    expect(fixture.workspace.personalAuthorityFacts(fixture.projectId)).toBeNull();
    denied(await fixture.local.ownerAuthority(fixture.projectId));
    await fixture.workspace.openPersonalAuthority();
    expect(granted(await fixture.local.ownerAuthority(fixture.projectId)).principal.id).not.toBe(first.id);
  });

  test('a real workspace restart advances the saved epoch and requires a new backend issuance', async () => {
    const fixture = await serviceFixture(); await fixture.signIn();
    const firstFacts = fixture.workspace.personalAuthorityFacts(fixture.projectId)!, first = refOf(granted(await fixture.local.ownerAuthority(fixture.projectId)));
    const registryPath = path.join(fixture.store.dataDir, 'workspaces', 'registry.json');
    const saved = JSON.parse(await fs.readFile(registryPath, 'utf8'));
    expect(saved.access.personalAuthorityGeneration).toBe(firstFacts.generation);
    fixture.local.close();
    const reopenedStore = new Store(fixture.store.dataDir, path.join(directory, 'service-projects'));
    await reopenedStore.init();
    const reopened = new WorkspaceService(reopenedStore); await reopened.init();
    expect(reopened.personalAuthorityFacts(fixture.projectId)).toBeNull();
    await reopened.openPersonalAuthority();
    const facts = reopened.personalAuthorityFacts(fixture.projectId)!;
    expect(facts.generation).toBeGreaterThan(firstFacts.generation);
    expect(JSON.parse(await fs.readFile(registryPath, 'utf8')).access.personalAuthorityGeneration).toBe(facts.generation);
    const next = await localTrustModule.createLocalTrustBackend({ store: reopenedStore, accountFacts: () => fixture.account.authorityFacts(),
      personalFacts: id => reopened.personalAuthorityFacts(id), now: () => clock }); backends.push(next);
    denied(await next.resolve({ via: 'stored-reference', ref: first }));
    expect(granted(await next.ownerAuthority(fixture.projectId)).principal.id).not.toBe(first.id);
  });

  test('the ordinary stale-Business fallback does not confer Personal authority from raw Business settings', async () => {
    const fixture = await serviceFixture(); await fixture.signIn();
    const first = refOf(granted(await fixture.local.ownerAuthority(fixture.projectId)));
    await fixture.store.saveSettings({ ...fixture.store.settings, activeWorkspace: { kind: 'business', organizationId: 'org_missing_owned_fixture' } });
    expect(fixture.workspace.active()).toEqual({ kind: 'personal' });
    expect(fixture.store.settings.activeWorkspace!.kind).toBe('business');
    expect(fixture.workspace.personalAuthorityFacts(fixture.projectId)).toBeNull();
    denied(await fixture.local.ownerAuthority(fixture.projectId));
    denied(await fixture.local.resolve({ via: 'stored-reference', ref: first }));
    await fixture.switch({ kind: 'personal' });
    denied(await fixture.local.resolve({ via: 'stored-reference', ref: first }));
    granted(await fixture.local.ownerAuthority(fixture.projectId));
  });

  test('real Business project links and output ownership remain outside Personal authority after returning Personal', async () => {
    const fixture = await serviceFixture(); await fixture.signIn('owner');
    const organizationId = fixture.seeded.organizations!.juniper;
    const linked = (await fixture.store.locked(() => fixture.store.createProject('Business resource fixture'))).id;
    const output = (await fixture.store.locked(() => fixture.store.createProject('Business output fixture'))).id;
    await fixture.store.locked(() => fixture.workspace.linkProject(organizationId, linked));
    await fixture.store.locked(() => fixture.workspace.bindOutputProject(organizationId, output));
    await fixture.switch({ kind: 'personal' });
    expect(fixture.workspace.projectOwner(linked)?.organizationId).toBe(organizationId);
    expect(fixture.workspace.outputBinding(organizationId)?.projectId).toBe(output);
    for (const projectId of [linked, output]) {
      expect(fixture.workspace.personalAuthorityFacts(projectId)).toBeNull();
      denied(await fixture.local.ownerAuthority(projectId));
    }
    expect(fixture.workspace.personalAuthorityFacts(fixture.projectId)?.projectId).toBe(fixture.projectId);
    granted(await fixture.local.ownerAuthority(fixture.projectId));
  });
});

async function appFixture(protectedHost: boolean) {
  const fixture = await cloudFixture();
  const token = protectedHost ? randomBytes(32).toString('hex') : null;
  const service = new EngineService(path.join(directory, 'app-engines'), { discover: async () => [] });
  const provider = vi.fn(async () => { throw new Error('No provider call is allowed in Trust composition acceptance.'); });
  const app = await createApp({ dataDir: path.join(directory, 'app-data'), projectRoot: path.join(directory, 'app-projects'),
    ...(token ? { loopbackToken: token } : {}), engineService: service, reviewerAdapter: null,
    secretBox: testOnlySecretBox(), modelApiTransport: provider, ownerRoutes: true,
    accounts: { backend: fixture.backend, env: {} }, observation: null, managedJev: false });
  const server: Server = await new Promise(resolve => { const listener = app.listen(0, '127.0.0.1', () => resolve(listener)); });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  let closed = false;
  const close = async () => {
    if (closed) return; closed = true;
    try { await app.locals.close(); }
    finally { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
  };
  apps.push(close);
  // Use owned loopback HTTP through Node directly; the global network blocker stays armed.
  const request = <T = Record<string, unknown>>(route: string, method = 'GET', body?: unknown) => new Promise<{ status: number; data: T }>((resolve, reject) => {
    const bytes = body === undefined ? undefined : JSON.stringify(body);
    const call = httpRequest(new URL(`${base}/api${route}`), { method,
      headers: { 'content-type': 'application/json', 'x-diomedes-client': '1', ...(token ? { 'x-diomedes-session': token } : {}),
        ...(bytes ? { 'content-length': Buffer.byteLength(bytes) } : {}) } }, response => {
      const chunks: Buffer[] = [];
      response.on('data', chunk => chunks.push(Buffer.from(chunk)));
      response.on('error', reject);
      response.on('end', () => {
        try { resolve({ status: response.statusCode!, data: JSON.parse(Buffer.concat(chunks).toString('utf8')) as T }); }
        catch (error) { reject(error); }
      });
    });
    call.on('error', reject); call.end(bytes);
  });
  const api = async <T = Record<string, unknown>>(route: string, method = 'GET', body?: unknown) => {
    const response = await request<T>(route, method, body);
    expect(response.status, `${route}: ${JSON.stringify(response.data)}`).toBe(200);
    return response.data;
  };
  return { ...fixture, app, service, token, request, api, provider, close, store: app.locals.store as Store,
    local: app.locals.personalTrust as LocalBackend | null, account: app.locals.accounts as AccountSessionService };
}

describe('protected app composes its private resolver into existing Runtime and Team', () => {
  test('protected createApp installs private Trust before init and preserves paid/source/profile/budget/Jev gates', async () => {
    const installed = trustBackendInstalled(), events: string[] = [];
    let observed: LocalBackend | null = null;
    const originalTrust = localTrustModule.createLocalTrustBackend;
    const originalHarness = harnessModule.createHarnessHost;
    const originalTeam = teamHostModule.createProductionAgentTeamHost;
    // These observations call the real implementations and return their original
    // services; no authority, grant, adapter, admission or selection is supplied.
    vi.spyOn(localTrustModule, 'createLocalTrustBackend').mockImplementation(async options => {
      observed = await originalTrust(options); events.push('trust-ready'); return observed;
    });
    vi.spyOn(harnessModule, 'createHarnessHost').mockImplementation(options => {
      expect(options.currentAuthority).toBe(observed!.resolve);
      const actual = originalHarness(options), initialize = actual.init.bind(actual);
      vi.spyOn(actual, 'init').mockImplementation(async () => {
        events.push('harness-init'); expect(observed).not.toBeNull(); await initialize();
      });
      return actual;
    });
    vi.spyOn(teamHostModule, 'createProductionAgentTeamHost').mockImplementation(deps => {
      events.push('team-compose'); expect(deps.currentAuthority).toBe(observed!.resolve);
      expect(deps.ownerAuthority).toBe(observed!.ownerAuthority); return originalTeam(deps);
    });
    const fixture = await appFixture(true);
    expect(fixture.local).toBe(observed);
    expect(events.indexOf('trust-ready')).toBeLessThan(events.indexOf('harness-init'));
    expect(events.indexOf('team-compose')).toBeLessThan(events.indexOf('harness-init'));
    // Existing local project data can precede sign-in; use the real Store while
    // public /api projects correctly remain behind the account sign-in gate.
    const projectId = (await fixture.store.locked(() => fixture.store.createProject('Protected Personal fixture'))).id;
    denied(await fixture.local!.ownerAuthority(projectId));
    await fixture.api('/account/sign-in', 'POST', { email: DEMO_ACCOUNTS.free.email, password: FAUX_DEMO_PASSWORD, remember: false });
    expect(fixture.account.authorityFacts()).not.toBeNull();
    const first = granted(await fixture.local!.ownerAuthority(projectId));
    expect(first).toMatchObject({ assurance: 'owner-local', principal: { kind: 'local-owner', tenantId: 'local', projectId } });
    expect(isDenial(requireCapability(first, 'egress.send'))).toBe(false);
    const workspace = await fixture.api<WorkspaceView>('/workspace');
    expect(first.principal.id).not.toBe(workspace.person.id);
    expect(granted(await fixture.local!.resolve({ via: 'stored-reference', ref: refOf(first) })).principal.id).toBe(first.principal.id);
    expect(trustBackendInstalled()).toBe(installed);
    const registry = new WorkspaceService(fixture.store); await registry.init();
    expect(registry.hostedAvailable()).toBe(installed);
    expect(denied(await currentAuthority({ via: 'local-owner', ownerId: first.principal.id }, null)).code).toBe('no-resolver');

    // Synthetic catalog and synthetic key input; no SDK response is permitted.
    const view = await fixture.api<OpenRouterConnectionView>('/ai/model-api/openrouter', 'PUT', { apiKey: KEY, expiresAt: null, consent: true,
      models: [{ reasoning: { supported: ['low', 'medium', 'high'], source: 'Synthetic SDK fixture declaration; not live qualification' }, id: MODEL, upstreams: ['openai'], rates: { inputUsdPerMillion: 1, outputUsdPerMillion: 1,
        cacheReadUsdPerMillion: null, cacheWriteUsdPerMillion: null, source: 'Offline declared fixture rates; not live qualification' } }] });
    const connection = view.connection!; expect(connection).not.toBeNull();
    await fixture.api('/ai/model-api/openrouter/spend-limit', 'PUT', { capUsd: 100, consent: true });
    await fs.writeFile(path.join(fixture.store.state(projectId).project.folder, 'inventory.txt'), 'A: expected 10, counted 9.\n');
    const sharing = (expectedVersion: number, documents: string[]) => fixture.api(`/projects/${projectId}/cloud-sharing`, 'PUT', {
      expectedVersion, routes: ['openrouter'], documents, shareConversationHistory: false, shareReviewPackets: false });
    await sharing(0, ['inventory.txt']);
    const start = async (commandId: string, extra: Record<string, unknown> = {}) => {
      const task = await fixture.api<Task>(`/projects/${projectId}/tasks`, 'POST', { name: `Scope guard ${commandId}` });
      return fixture.request(`/projects/${projectId}/loop/start`, 'POST', { protocolVersion: 1, commandId, taskId: task.id,
        goal: 'Reconcile inventory.txt and prepare the exceptions report.', route: 'openrouter', model: MODEL,
        accountRoute: connection.accountRoute, effort: 'medium', consent: true, sources: ['inventory.txt'], maxTurns: 8, ...extra });
    };
    const unpaid = await start('private-trust-unpaid');
    expect(unpaid.status).toBe(403); expect(unpaid.data.code).toBe('AGENT_NOT_INCLUDED');
    await fixture.issueIndividual();
    await fixture.account.reload();
    granted(await fixture.local!.ownerAuthority(projectId));
    await sharing(1, []);
    const source = await start('private-trust-source');
    expect(source.status).toBe(403); expect(source.data.code).toBe('cloud_sharing_denied');
    await sharing(2, ['inventory.txt']);
    const profile = await start('private-trust-profile', { team: { worker: { profileId: 'profile_not_created_in_owned_fixture' }, advisor: null } });
    expect(profile.status).toBe(409); expect(profile.data.code).toBe('team_profile_refused');
    const budget = await start('private-trust-budget', { team: { worker: { route: 'openrouter', model: MODEL,
      accountRoute: connection.accountRoute, budget: { turns: 99 } }, advisor: null } });
    expect(budget.status).toBe(400); expect(budget.data.code).toBe('team_budget_invalid');
    const review = await start('private-trust-jev', { review: { profileId: 'agent.inventory-reconciliation', connectionId: connection.id } });
    expect(review.status).toBe(409); expect(review.data.code).toBe('review_unqualified');
    expect(review.data.error).toContain('Decisions billing qualification');
    expect(fixture.provider).not.toHaveBeenCalled();
    expect(await fixture.app.locals.harness.list(projectId)).toHaveLength(0);
    expect(fixture.store.state(projectId).sessions).toHaveLength(0);
    expect(fixture.store.state(projectId).needs.filter(need => need.approval)).toHaveLength(0);
    expect(fixture.service.modelApi!.exposure.list(connection.id)).toHaveLength(0);
    expect(globalThis.fetch).not.toHaveBeenCalled();
    const latest = refOf(granted(await fixture.local!.ownerAuthority(projectId)));
    const closeTrust = fixture.local!.close.bind(fixture.local!);
    vi.spyOn(fixture.local!, 'close').mockImplementation(() => { events.push('trust-close'); closeTrust(); });
    const closeHarness = fixture.app.locals.harness.close.bind(fixture.app.locals.harness);
    vi.spyOn(fixture.app.locals.harness, 'close').mockImplementation(async () => {
      events.push('harness-close'); denied(await fixture.local!.resolve({ via: 'stored-reference', ref: latest })); await closeHarness();
    });
    await fixture.close();
    expect(events.indexOf('trust-close')).toBeLessThan(events.indexOf('harness-close'));
    denied(await fixture.local!.ownerAuthority(projectId));
    expect(trustBackendInstalled()).toBe(installed);
  }, 30_000);

  test('a no-token development host cannot promote even a verified cloud-shaped sign-in to private desktop authority', async () => {
    const installed = trustBackendInstalled();
    const fixture = await appFixture(false);
    await fixture.api('/account/sign-in', 'POST', { email: DEMO_ACCOUNTS.free.email, password: FAUX_DEMO_PASSWORD, remember: false });
    expect(fixture.account.authorityFacts()).not.toBeNull();
    expect(fixture.local).toBeNull();
    expect(fixture.app.locals.personalTrust).toBeNull();
    const projectId = (await fixture.api<{ id: string }>('/projects', 'POST', { name: 'Unprotected fixture' })).id;
    const workspace = await fixture.api<WorkspaceView>('/workspace');
    denied(await currentAuthority({ via: 'local-owner', ownerId: workspace.person.id }, null));
    expect(trustBackendInstalled()).toBe(installed);
    expect(await fixture.app.locals.harness.list(projectId)).toHaveLength(0);
    expect(fixture.provider).not.toHaveBeenCalled();
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});
