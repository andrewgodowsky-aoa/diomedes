/**
 * The faux cloud: the real control-plane Worker handler, run locally over the
 * faux store and the faux identity provider.
 *
 *   /auth/sign-up, /auth/sign-in, /auth/refresh, /auth/sign-out   faux identity (password mode)
 *   /workos/...                                                     the WorkOS stand-in (workos-standin mode)
 *   /faux/status                                                    what this is
 *   /faux/bootstrap-admin                                           make the first admin (workos-standin mode)
 *   everything else                                                 createHandler()
 *
 * Only the two seams differ from production: the repositories (a JSON file for
 * Neon) and the identity. In password mode that is local passwords. In
 * workos-standin mode it is the Worker's own WorkOSIdentityVerifier, talking to
 * a local WorkOS stand-in instead of api.workos.com. Every account, access,
 * admission, routing and staff rule is the Worker's own code.
 */
import { z } from 'zod';
import type { Configuration } from '../config.js';
import { AccountService } from '../account-service.js';
import { bootstrapFirstAdmin, CommercialService } from '../commercial.js';
import { AccountError } from '../errors.js';
import { FundingService, UsageService } from '../funding.js';
import { createHandler } from '../worker.js';
import { readBytes } from '../crypto.js';
import { accountId } from '../domain.js';
import { WorkOSIdentityVerifier } from '../identity-workos.js';
import {
  FAUX_ISSUER,
  FauxIdentityDirectory,
  FauxIdentityProvider,
  FauxIdentityVerifier,
  refreshInput,
  signInInput,
  signUpInput,
} from './identity.js';
import { FauxCloudStore } from './store.js';
import { createWorkOSStandIn, WORKOS_ISSUER, type WorkOSStandIn } from './workos-standin.js';

export const FAUX_BACKEND_LABEL = 'Test account service (local, faux data)';

export interface FauxCloudOptions {
  /** The JSON store. Null keeps everything in memory. */
  file: string | null;
  now?: () => number;
  /** PBKDF2 iterations; tests lower it. */
  passwordIterations?: number;
  /** Exact origins allowed to call from a browser. Native clients send none. */
  allowedOrigins?: readonly string[];
  /** How people sign in: local passwords (the default), or a local WorkOS stand-in. */
  identity?: FauxIdentityMode;
}

export type FauxIdentityMode = 'password' | 'workos-standin';

export interface FauxCloud {
  readonly store: FauxCloudStore;
  readonly identity: FauxIdentityProvider;
  readonly identityMode: FauxIdentityMode;
  /** The WorkOS stand-in, in workos-standin mode. */
  readonly standIn: WorkOSStandIn | null;
  readonly accounts: AccountService;
  readonly commercial: CommercialService;
  readonly funding: FundingService;
  handle(request: Request): Promise<Response>;
  /** Sign a person in without a browser, for the seed and tests. Makes the person on first use. */
  seedSignIn(account: { email: string; name: string; password: string }): Promise<string>;
  /** Issuer and subject of a person's sign-in identity, by email. */
  subjectFor(email: string): Promise<{ issuer: string; subject: string } | null>;
}

async function jsonBody<T>(request: Request, schema: z.ZodType<T>): Promise<T> {
  if (request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json')
    throw new AccountError(415, 'Use a JSON request body.');
  let bytes;
  try { bytes = await readBytes(request, 16_384); }
  catch { throw new AccountError(413, 'The sign-in request is too large.'); }
  let input: unknown;
  try { input = JSON.parse(new TextDecoder().decode(bytes)); }
  catch { throw new AccountError(422, 'The JSON request body is invalid.'); }
  const parsed = schema.safeParse(input);
  if (!parsed.success) throw new AccountError(422, 'The sign-in request contains invalid or unexpected fields.');
  return parsed.data;
}

export async function createFauxCloud(options: FauxCloudOptions): Promise<FauxCloud> {
  const now = options.now ?? Date.now;
  const store = await FauxCloudStore.open(options.file, new Date(now()).toISOString());
  const identity = new FauxIdentityProvider({ now, iterations: options.passwordIterations });
  const identityMode = options.identity ?? 'password';
  const standIn = identityMode === 'workos-standin' ? await createWorkOSStandIn({ now }) : null;
  const verifier = standIn
    ? new WorkOSIdentityVerifier({ clientId: standIn.clientId, issuer: WORKOS_ISSUER, audience: standIn.audience, apiKey: standIn.apiKey, fetch: standIn.fetch, now })
    : new FauxIdentityVerifier(identity, () => store.identity());
  const directory = standIn ? standIn.directory : new FauxIdentityDirectory(() => store.identity());
  const accounts = new AccountService(store.accounts, verifier, { now });
  const funding = new FundingService(store.funding, { now });
  const commercial = new CommercialService(accounts, store.commercial, funding, { now, directory, backend: 'faux' });
  const origins = [...(options.allowedOrigins ?? [])];
  // The Worker's configuration shape, filled with what the faux cloud actually is.
  // No database URL or WorkOS key exists here, and none is ever read.
  const config: Configuration = {
    environment: 'local',
    origins,
    databaseUrl: 'faux://local-store',
    identity: standIn
      ? { clientId: standIn.clientId, issuer: WORKOS_ISSUER, audience: standIn.audience, apiKey: standIn.apiKey }
      : { clientId: 'faux', issuer: FAUX_ISSUER, audience: 'faux', apiKey: 'faux' },
  };
  const worker = createHandler(
    () => accounts,
    () => new UsageService(accounts, funding),
    { configuration: () => config, createCommercial: () => commercial },
  );

  const headers = () => new Headers({ 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'X-Nectovia-Backend': 'faux' });
  const json = (value: unknown, status = 200) => Response.json(value, { status, headers: headers() });

  const refuseOrigin = (request: Request) => {
    const origin = request.headers.get('origin');
    if (origin !== null && !origins.includes(origin)) throw new AccountError(403, 'This origin is not allowed.');
  };

  async function auth(request: Request, pathname: string): Promise<Response> {
    refuseOrigin(request);
    if (standIn) throw new AccountError(404, 'This test service signs people in through its WorkOS stand-in, at /workos.');
    if (request.method !== 'POST') throw new AccountError(405, 'Use POST.');
    if (pathname === '/auth/sign-up') {
      const input = await jsonBody(request, signUpInput);
      return json(await store.run((draft) => identity.signUp(draft.identity, input)), 201);
    }
    if (pathname === '/auth/sign-in') {
      const input = await jsonBody(request, signInInput);
      // A failed attempt still commits its counter, so the lockout holds.
      // The refusal leaves the transaction as plain data: the store clones results.
      const outcome = await store.run(async (draft) => {
        try { return { ok: true as const, pair: await identity.signIn(draft.identity, input) }; }
        catch (error) { if (error instanceof AccountError) return { ok: false as const, status: error.status, message: error.message }; throw error; }
      });
      if (!outcome.ok) throw new AccountError(outcome.status, outcome.message);
      return json(outcome.pair);
    }
    if (pathname === '/auth/refresh') {
      const input = await jsonBody(request, refreshInput);
      return json(await store.run((draft) => identity.refresh(draft.identity, input)));
    }
    if (pathname === '/auth/sign-out') {
      const input = await jsonBody(request, refreshInput);
      await store.run((draft) => identity.signOut(draft.identity, input));
      return new Response(null, { status: 204, headers: headers() });
    }
    throw new AccountError(404, 'This sign-in action was not found.');
  }

  async function subjectFor(email: string) {
    if (standIn) return { issuer: WORKOS_ISSUER, subject: await standIn.userIdFor(email) };
    const user = store.snapshot().identity.users.find((row) => row.email === email.trim().toLowerCase());
    return user ? { issuer: FAUX_ISSUER, subject: user.subject } : null;
  }

  /**
   * POST /faux/bootstrap-admin { subject }: what scripts/bootstrap-admin.ts does
   * against Postgres, for a stand-in store. The person signs in once first.
   */
  async function bootstrap(request: Request): Promise<Response> {
    refuseOrigin(request);
    if (!standIn) throw new AccountError(404, 'This test service seeds its own admin.');
    const { subject } = await jsonBody(request, z.strictObject({ subject: accountId }));
    const mapping = await store.accounts.transaction((tx) => tx.subject(WORKOS_ISSUER, subject));
    if (!mapping) throw new AccountError(404, 'That person has no account yet. They sign in once first.');
    const at = new Date(now()).toISOString();
    return json(await bootstrapFirstAdmin(store.commercial, mapping.personId, at), 201);
  }

  return {
    store,
    identity,
    identityMode,
    standIn,
    accounts,
    commercial,
    funding,
    async seedSignIn(account) {
      if (standIn) return (await standIn.signInDirect(account.email, account.name)).access_token;
      const pair = await store.run((draft) => identity.signUp(draft.identity, account));
      return pair.accessToken;
    },
    subjectFor,
    async handle(request: Request) {
      const url = new URL(request.url);
      const { pathname } = url;
      try {
        if (pathname === '/faux/status' && request.method === 'GET')
          return json({
            backend: 'faux',
            label: FAUX_BACKEND_LABEL,
            issuer: standIn ? WORKOS_ISSUER : FAUX_ISSUER,
            seeded: store.snapshot().seeded,
            identity: identityMode,
            ...(standIn ? { workos: { apiBase: `${url.origin}/workos`, clientId: standIn.clientId } } : {}),
          });
        if (pathname === '/faux/bootstrap-admin' && request.method === 'POST') return await bootstrap(request);
        if (standIn && pathname.startsWith('/workos/')) {
          refuseOrigin(request);
          const inner = new URL(pathname.slice('/workos'.length) + url.search, url.origin);
          const body = ['GET', 'HEAD'].includes(request.method) ? undefined : await request.arrayBuffer();
          return await standIn.handle(new Request(inner, { method: request.method, headers: request.headers, body }));
        }
        if (pathname.startsWith('/auth/')) return await auth(request, pathname);
      } catch (error) {
        if (error instanceof AccountError) return json({ error: error.message }, error.status);
        return json({ error: 'The test account service failed. Try again.' }, 503);
      }
      const response = await worker(request, {});
      response.headers.set('X-Nectovia-Backend', 'faux');
      return response;
    },
  };
}
