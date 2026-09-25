/**
 * The faux cloud: the real control-plane Worker handler, run locally over the
 * faux store and the faux identity provider.
 *
 *   /auth/sign-up, /auth/sign-in, /auth/refresh, /auth/sign-out   faux identity
 *   /faux/status                                                    what this is
 *   everything else                                                 createHandler()
 *
 * Only the two seams differ from production: the repositories (a JSON file for
 * Neon) and the identity verifier (local passwords for WorkOS). Every account,
 * access, admission, routing and staff rule is the Worker's own code.
 *
 * The managed gateway (`/managed/v1/*`) is the Worker's own handler too. Its one
 * extra seam is the provider transport: a scripted Responses stream with exact
 * usage by default, so the desktop's loop runs offline. Bedrock is called for
 * real only when `liveBedrockApiKey` is given (NECTOVIA_FAUX_BEDROCK_API_KEY,
 * which needs Andrew's separate spend approval before it is ever set).
 */
import { z } from 'zod';
import type { Configuration } from '../config.js';
import { AccountService } from '../account-service.js';
import { CommercialService } from '../commercial.js';
import { AccountError } from '../errors.js';
import { FundingService, UsageService } from '../funding.js';
import { ManagedInferenceService } from '../managed-inference.js';
import { FAUX_SCRIPTED_CREDENTIAL, bedrockResponsesCaller, scriptedResponsesFetch } from '../managed-providers.js';
import { createHandler } from '../worker.js';
import { readBytes } from '../crypto.js';
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

export const FAUX_BACKEND_LABEL = 'Test account service (local, faux data)';

export interface FauxCloudOptions {
  /** The JSON store. Null keeps everything in memory. */
  file: string | null;
  now?: () => number;
  /** PBKDF2 iterations; tests lower it. */
  passwordIterations?: number;
  /** Exact origins allowed to call from a browser. Native clients send none. */
  allowedOrigins?: readonly string[];
  /** The managed gateway's provider seam. Omitted: the scripted provider, with a placeholder key. */
  managed?: {
    /** The transport the Bedrock caller uses. Default: `scriptedResponsesFetch`. */
    transport?: typeof globalThis.fetch;
    /** What the gateway reads as BEDROCK_API_KEY. Null: no key is configured. */
    credential?: string | null;
    idleTimeoutMs?: number;
  };
  /** An owner-approved live test only: the gateway calls Bedrock for real with this key. */
  liveBedrockApiKey?: string | null;
}

export interface FauxCloud {
  readonly store: FauxCloudStore;
  readonly identity: FauxIdentityProvider;
  readonly accounts: AccountService;
  readonly commercial: CommercialService;
  readonly funding: FundingService;
  readonly managed: ManagedInferenceService;
  /** Which provider answers managed calls. */
  readonly provider: 'scripted' | 'live';
  handle(request: Request): Promise<Response>;
  /** Resolves once every managed settlement started so far has finished. */
  idle(): Promise<void>;
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
  const verifier = new FauxIdentityVerifier(identity, () => store.identity());
  const directory = new FauxIdentityDirectory(() => store.identity());
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
    identity: { clientId: 'faux', issuer: FAUX_ISSUER, audience: 'faux', apiKey: 'faux' },
  };
  const live = typeof options.liveBedrockApiKey === 'string' && options.liveBedrockApiKey.length > 0;
  const credential = live ? options.liveBedrockApiKey! : options.managed?.credential === undefined ? FAUX_SCRIPTED_CREDENTIAL : options.managed.credential;
  // The environment the gateway reads its key from, as the Worker's would be.
  const managedEnv: Record<string, unknown> = credential === null ? {} : { BEDROCK_API_KEY: credential };
  const managed = new ManagedInferenceService({
    accounts,
    commercial: store.commercial,
    funding,
    fundingReads: store.funding,
    caller: bedrockResponsesCaller(options.managed?.transport ?? (live ? undefined : scriptedResponsesFetch({ now }))),
    now,
    idleTimeoutMs: options.managed?.idleTimeoutMs,
  });
  const worker = createHandler(
    () => accounts,
    () => new UsageService(accounts, funding),
    { configuration: () => config, createCommercial: () => commercial, createManaged: () => managed },
  );

  const headers = () => new Headers({ 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'X-Nectovia-Backend': 'faux' });
  const json = (value: unknown, status = 200) => Response.json(value, { status, headers: headers() });

  async function auth(request: Request, pathname: string): Promise<Response> {
    const origin = request.headers.get('origin');
    if (origin !== null && !origins.includes(origin)) throw new AccountError(403, 'This origin is not allowed.');
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

  return {
    store,
    identity,
    accounts,
    commercial,
    funding,
    managed,
    provider: live ? 'live' : 'scripted',
    idle: () => managed.idle(),
    async handle(request: Request) {
      const { pathname } = new URL(request.url);
      try {
        if (pathname === '/faux/status' && request.method === 'GET')
          return json({ backend: 'faux', label: FAUX_BACKEND_LABEL, issuer: FAUX_ISSUER, seeded: store.snapshot().seeded });
        if (pathname.startsWith('/auth/')) return await auth(request, pathname);
      } catch (error) {
        if (error instanceof AccountError) return json({ error: error.message }, error.status);
        return json({ error: 'The test account service failed. Try again.' }, 503);
      }
      const response = await worker(request, managedEnv);
      response.headers.set('X-Nectovia-Backend', 'faux');
      return response;
    },
  };
}
