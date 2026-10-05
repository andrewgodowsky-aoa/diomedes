import { z } from 'zod';
import { ConfigurationError, configuration, identityFor, type AccountPool, type Configuration } from './config.js';
import { AccountService, IDENTITY_RECHECK, organizationInput, invitationInput, changeInput, acceptanceInput, codeInvitationInput, redeemCodeInput } from './account-service.js';
import { AccountError } from './errors.js';
import { readBytes } from './crypto.js';
import { WorkOSIdentityVerifier, signingKeyCache, type SigningKeyCache } from './identity-workos.js';
import { StaffKeyVerifier, postgresStaffKeys } from './identity-staff-key.js';
import { PostgresRepository, neonClientFactory } from './postgres.js';
import { FundingService, PurchasedUsageService, UsageService, purchasedHoldInput, purchasedReleaseInput, purchasedRenewInput, purchasedSettleInput } from './funding.js';
import { CREDIT_PURCHASES_UNAVAILABLE, CreditPurchaseService, StripeWebhookService, creditPurchaseInput, readBillingSettings, returnPage } from './credit-purchases.js';
import { PostgresFundingRepository } from './funding-postgres.js';
import { MemberLimits, MemberLimitsService, askRaiseInput, decideRaiseInput, setLimitInput, setSettingsInput } from './member-limits.js';
import { PostgresCommercialRepository } from './commercial-postgres.js';
import {
  CommercialService,
  addFundingInput,
  addStaffInput,
  agentAdmissionInput,
  changeStaffInput,
  issueGrantInput,
  issuePersonGrantInput,
  publishPolicyInput,
  revokeGrantInput,
  rollbackPolicyInput,
  saveRouteInput,
} from './commercial.js';
import type { WorkerEnv } from '../worker-configuration.js';
import { accountId } from './domain.js';
import { ManagedError, ManagedInferenceService, ROUTE_UNAVAILABLE, managedErrorResponse, managedHeaders, type ManagedContext } from './managed-inference.js';
import { bedrockResponsesCaller } from './managed-providers.js';
import { RelayService, registerDeviceInput } from './relay/service.js';
import { PostgresRelayRepository } from './relay/postgres.js';
import { durableObjectHubs } from './relay/durable-object.js';
import { OrganizationSetupService } from './organization-setup/service.js';
import { PostgresOrganizationSetupRepository } from './organization-setup/postgres.js';
import { organizationSetupWriteSchema } from './organization-setup/schema.js';
import { OrganizationExportService } from './organization-export/service.js';
import { RoutingService, preferenceInputSchema, individualAgreementInput } from './routing.js';
import { scopedPublicationSchema, scopedRollbackSchema, type AccountScope } from '../../../shared/routing-policy.js';
import { approvedConnections, discoverConnectionModels } from './managed-bindings.js';
import { PostgresOrganizationExportRepository } from './organization-export/postgres.js';
import { RouteChecksService, postgresRouteCheckSpend, workerFetch } from './route-checks.js';
import { routeChecksInputSchema } from '../../../shared/gateway-route-checks.js';
import { routeInputRefusal } from './route-field-refusals.js';

/** The phone relay's per-business hub, bound as RELAY_HUB (both wrangler.jsonc files). */
export { RelayHub } from './relay/durable-object.js';

/**
 * The JSON body of an account request, parsed by its schema. A body the schema refuses gets the
 * generic sentence, or the refusal `refuse` builds from the schema's issues (route saving names fields).
 */
async function body<T>(request: Request, schema: z.ZodType<T>, refuse?: (issues: readonly z.core.$ZodIssue[], input: unknown) => AccountError): Promise<T> {
  if (request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json')
    throw new AccountError(415, 'Use a JSON request body.');
  let bytes;
  try { bytes = await readBytes(request, 16_384); }
  catch (error) {
    if (error instanceof RangeError) throw new AccountError(413, 'The account request is too large.');
    if (error instanceof TypeError) throw new AccountError(422, 'A readable request body is required.');
    throw error;
  }
  let input: unknown;
  try { input = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch (error) {
    if (error instanceof SyntaxError || error instanceof TypeError) throw new AccountError(422, 'The JSON request body is invalid.');
    throw error;
  }
  const parsed = schema.safeParse(input);
  if (!parsed.success) throw refuse?.(parsed.error.issues, input) ?? new AccountError(422, 'The account request contains invalid or unexpected fields.');
  return parsed.data;
}

const ID = '([A-Za-z0-9][A-Za-z0-9._-]{0,127})';
const route = (pattern: string) => new RegExp(`^${pattern.replace(/:id/g, ID)}$`);

/**
 * The query parameters each GET may carry. Anything else is refused, as the
 * original account routes always did; `after` keeps its original rule.
 */
const QUERY_RULES: { path: RegExp; keys: Record<string, (value: string) => boolean> }[] = [
  { path: /^\/account\/session$/, keys: { after: (value) => accountId.safeParse(value).success } },
  { path: /^\/ops\/customers$/, keys: { q: (value) => value.length <= 100 } },
  { path: /^\/ops\/individuals$/, keys: { q: (value) => value.length <= 100 } },
  { path: /^\/ops\/people$/, keys: { q: (value) => value.length <= 100 } },
  { path: /^\/ops\/audit$/, keys: { organizationId: (value) => accountId.safeParse(value).success, limit: (value) => /^[1-9][0-9]{0,2}$/.test(value) } },
  // The amount is checked by the quote itself, which answers a plain 422 for anything that is not a step of 100.
  { path: /^\/account\/organizations\/[^/]+\/credit-purchases\/quote$/, keys: { credits: (value) => value.length <= 40 } },
];

function checkQuery(url: URL, method: string) {
  if (!url.search) return;
  const rule = method === 'GET' ? QUERY_RULES.find((item) => item.path.test(url.pathname)) : undefined;
  const keys = [...url.searchParams.keys()];
  if (!rule || keys.some((key) => !rule.keys[key] || url.searchParams.getAll(key).length !== 1 || !rule.keys[key](url.searchParams.get(key)!)))
    throw new AccountError(422, 'The account query contains invalid or unexpected fields.');
}

export interface HandlerOptions {
  /** Test and faux-cloud seam. The Worker entry always reads its own environment. */
  configuration?: (env: Record<string, unknown>) => Configuration;
  createCommercial?: (config: Configuration, accounts: AccountService) => CommercialService;
  /** Test and faux-cloud seam for purchased-usage holds. The Worker entry always uses the funding login. */
  createPurchased?: (config: Configuration, accounts: AccountService) => Pick<PurchasedUsageService, 'balance' | 'hold' | 'settle' | 'release' | 'renew'>;
  /** Test and faux-cloud seam for buying credits: the faux Stripe and the faux store. The Worker entry always uses the funding login and Stripe. */
  createCreditPurchases?: (config: Configuration, accounts: AccountService, env: Record<string, unknown>) => Pick<CreditPurchaseService, 'quote' | 'create' | 'read'>;
  /** Test and faux-cloud seam for Stripe's events, over the same store. */
  createStripeWebhook?: (config: Configuration, env: Record<string, unknown>) => Pick<StripeWebhookService, 'handle'>;
  /** Test and faux-cloud seam for per-member credit limits. The Worker entry always uses the funding login. */
  createLimits?: (config: Configuration, accounts: AccountService) => Pick<MemberLimitsService, 'limits' | 'setLimit' | 'setSettings' | 'mine' | 'report' | 'ask' | 'requests' | 'decide'>;
  createRouting?: (config: Configuration, accounts: AccountService) => RoutingService;
  /** Test and faux-cloud seam for the managed gateway: the scripted provider instead of Bedrock. */
  createManaged?: (config: Configuration, accounts: AccountService) => ManagedInferenceService;
  /** Test and faux-cloud seam for the phone relay: the faux store and an in-process hub. */
  createRelay?: (config: Configuration, accounts: AccountService, env: Record<string, unknown>) => RelayService;
  /** Test and faux-cloud seam for business setups: the faux store instead of Neon. */
  createOrganizationSetup?: (config: Configuration, accounts: AccountService) => OrganizationSetupService;
  /** Test and faux-cloud seam for the owner's export (OPS-05): the faux store and the faux services' views. */
  createOrganizationExport?: (config: Configuration, accounts: AccountService, env: Record<string, unknown>) => OrganizationExportService;
  /** Test and faux-cloud seam for the gateway route checks (DIO-217): the faux store and a scripted provider. */
  createRouteChecks?: (config: Configuration, accounts: AccountService) => RouteChecksService;
}

/**
 * The customer signing keys, kept for the life of the isolate so their five-minute cache outlives a
 * request. Only the keys and their fetch time are kept, for one client id at a time, since the key URL
 * depends on the client id alone. Each request still builds its own verifier: a key fetch belongs to
 * the request that started it and is cancelled when that request ends, so no request may wait on
 * another's. Every session and user check is made again on every request.
 */
let customerKeys: { clientId: string; cache: SigningKeyCache } | null = null;
export function customerSigningKeys(clientId: string): SigningKeyCache {
  if (customerKeys?.clientId !== clientId) customerKeys = { clientId, cache: signingKeyCache() };
  return customerKeys.cache;
}

const MANAGED_ATTEMPT = /^\/managed\/v1\/attempts\/([A-Za-z0-9][A-Za-z0-9._:-]{0,127})$/;
/** A route id as routeChecksPath encodes it. The service decodes it and holds it to the route id rule. */
const ROUTE_CHECKS = /^\/ops\/routes\/([^/]{1,400})\/checks$/;

/**
 * Factory injection is only a test seam; no environment flag enables fake identity/storage.
 * `pool` names who the route's bearer must be: /ops/* is staff, who sign in with a personal
 * staff key (src/identity-staff-key.ts); everything else is customer (Nectovia), who sign in
 * through WorkOS. A customer token is not a staff key and a staff key is not a WorkOS token,
 * so neither pool's sign-in reaches the other's routes.
 */
export function createHandler(create: (config: Configuration, pool: AccountPool) => AccountService = (config, pool) => {
  const repository = new PostgresRepository(neonClientFactory(config.databaseUrl));
  if (pool === 'staff') return new AccountService(repository, new StaffKeyVerifier(postgresStaffKeys(neonClientFactory(config.databaseUrl))));
  const identity = identityFor(config, pool);
  return new AccountService(repository, new WorkOSIdentityVerifier({ ...identity, signingKeys: customerSigningKeys(identity.clientId) }));
},
  // The usage read verifies membership first, then reads funding rows under the
  // organization's own tenant, as the Worker login, which may only read them.
  createUsage: (config: Configuration, accounts: AccountService) => Pick<UsageService, 'usage'> = (config, accounts) =>
    new UsageService(accounts, new FundingService(new PostgresFundingRepository(neonClientFactory(config.databaseUrl)))),
  options: HandlerOptions = {}) {
  const readConfiguration = options.configuration ?? configuration;
  const createCommercial = options.createCommercial ?? ((config: Configuration, accounts: AccountService) =>
    new CommercialService(accounts, new PostgresCommercialRepository(neonClientFactory(config.databaseUrl)),
      new FundingService(new PostgresFundingRepository(neonClientFactory(config.databaseUrl))),
      config.individual ? { coverage: config.individual } : {}));
  // Holds write funding rows, so they run as the funding login (FUNDING_DATABASE_URL), never as the
  // Worker login, which may only read them. Without that login nothing is held or read.
  const createPurchased = options.createPurchased ?? ((config: Configuration, accounts: AccountService) => {
    if (config.fundingDatabaseUrl === null) {
      console.error(JSON.stringify({ event: 'purchased-usage-funding-database-unavailable', setting: 'FUNDING_DATABASE_URL', rule: config.fundingProblem ?? 'not-set' }));
      throw new AccountError(503, 'Account service is unavailable. Try again later.');
    }
    return new PurchasedUsageService(accounts, new FundingService(new PostgresFundingRepository(neonClientFactory(config.fundingDatabaseUrl))));
  });
  // Buying credits writes funding rows (the purchase, and the top-up its payment records), so it runs as the
  // funding login too. Without that login nothing is quoted, bought or recorded.
  const fundingFor = (config: Configuration, event: string) => {
    if (config.fundingDatabaseUrl === null) {
      console.error(JSON.stringify({ event, setting: 'FUNDING_DATABASE_URL', rule: config.fundingProblem ?? 'not-set' }));
      throw new AccountError(503, CREDIT_PURCHASES_UNAVAILABLE);
    }
    return new FundingService(new PostgresFundingRepository(neonClientFactory(config.fundingDatabaseUrl)));
  };
  // The business's Stripe customer and the verified events its payments arrive in (billing_customers and webhook_inbox) are the
  // receiver's records, written on the Worker login (DATABASE_URL), never on the funding login: a top-up names a stored event,
  // so the funding login alone cannot make bought credits.
  const ledgerFor = (config: Configuration) => new PostgresRepository(neonClientFactory(config.databaseUrl));
  const createCreditPurchases = options.createCreditPurchases ?? ((config: Configuration, accounts: AccountService, env: Record<string, unknown>) =>
    new CreditPurchaseService(accounts, fundingFor(config, 'credit-purchases-funding-database-unavailable'), { settings: readBillingSettings(env), ledger: ledgerFor(config) }));
  const createStripeWebhook = options.createStripeWebhook ?? ((config: Configuration, env: Record<string, unknown>) =>
    new StripeWebhookService(fundingFor(config, 'credit-purchases-webhook-funding-database-unavailable'), { settings: readBillingSettings(env), ledger: ledgerFor(config) }));

  // Limits and raise requests write funding rows too, so they run as the funding login as well.
  const createLimits = options.createLimits ?? ((config: Configuration, accounts: AccountService) => {
    if (config.fundingDatabaseUrl === null) {
      console.error(JSON.stringify({ event: 'member-limits-funding-database-unavailable', setting: 'FUNDING_DATABASE_URL', rule: config.fundingProblem ?? 'not-set' }));
      throw new AccountError(503, 'Account service is unavailable. Try again later.');
    }
    return new MemberLimitsService(accounts, new MemberLimits(new PostgresFundingRepository(neonClientFactory(config.fundingDatabaseUrl))));
  });
  const createRouting = options.createRouting ?? ((config: Configuration, accounts: AccountService) =>
    new RoutingService(accounts, new PostgresCommercialRepository(neonClientFactory(config.databaseUrl)), Date.now,
      config.fundingDatabaseUrl ? new FundingService(new PostgresFundingRepository(neonClientFactory(config.fundingDatabaseUrl))) : null));
  const createManaged = options.createManaged ?? ((config: Configuration, accounts: AccountService) => {
    // Every funding read and write the gateway makes runs as cp_funding
    // (FUNDING_DATABASE_URL), never as the Worker login, which may only read
    // funding rows. Without that login the gateway refuses before it reads,
    // holds or sends anything; the account routes are unaffected.
    if (config.fundingDatabaseUrl === null) {
      console.error(JSON.stringify({ event: 'managed-funding-database-unavailable', setting: 'FUNDING_DATABASE_URL', rule: config.fundingProblem ?? 'not-set' }));
      throw new ManagedError(503, 'route_unavailable', ROUTE_UNAVAILABLE);
    }
    const funding = new PostgresFundingRepository(neonClientFactory(config.fundingDatabaseUrl));
    return new ManagedInferenceService({
      accounts,
      commercial: new PostgresCommercialRepository(neonClientFactory(config.databaseUrl)),
      funding: new FundingService(funding),
      fundingReads: funding,
      caller: bedrockResponsesCaller(),
    });
  });
  // The phone relay's device records run as the Worker login (cp_runtime); each business's
  // hub is a Durable Object. Without the RELAY_HUB binding no computer can connect.
  const createRelay = options.createRelay ?? ((config: Configuration, accounts: AccountService, env: Record<string, unknown>) =>
    new RelayService(accounts, new PostgresRelayRepository(neonClientFactory(config.databaseUrl)), durableObjectHubs(env.RELAY_HUB)));
  // Each business's setup revisions (migration 008) run as the Worker login, which may only read and append them.
  const createOrganizationSetup = options.createOrganizationSetup ?? ((config: Configuration, accounts: AccountService) =>
    new OrganizationSetupService(accounts, new PostgresOrganizationSetupRepository(neonClientFactory(config.databaseUrl))));
  // The owner's export reads as the Worker login too, SELECT only. Its plan and phones are the
  // owner's own access and device views, so it shows nothing those views don't.
  const createOrganizationExport = options.createOrganizationExport ?? ((config: Configuration, accounts: AccountService, env: Record<string, unknown>) => {
    const commercial = createCommercial(config, accounts);
    const relay = createRelay(config, accounts, env);
    return new OrganizationExportService(accounts, {
      access: (token, organizationId) => commercial.access(token, organizationId),
      devices: (token, organizationId) => relay.devices(token, organizationId),
    }, new PostgresOrganizationExportRepository(neonClientFactory(config.databaseUrl)));
  });
  // The gateway route checks (DIO-217) read routes, staff and earlier runs, and append their audit row,
  // on the Worker login. Its company spend read is the funding ceiling's own query, which that login may run.
  // The transport is the global fetch behind a wrapper: workerd refuses fetch called as a stored member.
  const createRouteChecks = options.createRouteChecks ?? ((config: Configuration, accounts: AccountService) =>
    new RouteChecksService({
      accounts,
      commercial: new PostgresCommercialRepository(neonClientFactory(config.databaseUrl)),
      spend: postgresRouteCheckSpend(neonClientFactory(config.databaseUrl)),
      transport: workerFetch,
    }));

  /**
   * The managed gateway (contract nectovia-managed/1). Its own header rules, a
   * 2,000,000-byte body, a streamed answer and the `{ error: { code, message } }`
   * shape, so it is routed before the account API's bearer and body handling.
   * The provider key is read from `env` by the gateway at call time; the funding
   * login's URL comes from the configuration read here, on every call.
   */
  async function managed(request: Request, env: Record<string, unknown>, ctx?: ManagedContext): Promise<Response> {
    const headers = managedHeaders();
    try {
      const config = readConfiguration(env);
      const origin = request.headers.get('origin');
      if ((origin !== null && !config.origins.includes(origin)) ||
          (origin === null && ['cross-site','same-site'].includes(request.headers.get('sec-fetch-site') ?? '')))
        throw new ManagedError(403, 'origin_refused', 'This origin is not allowed.');
      const url = new URL(request.url);
      if (url.search) throw new ManagedError(400, 'invalid_request', 'The managed model service takes no query parameters.');
      let match: RegExpExecArray | null;
      if (url.pathname === '/managed/v1/responses') {
        if (request.method !== 'POST') throw new ManagedError(405, 'method_not_allowed', 'Send this request as a POST.', { Allow: 'POST' });
        return await createManaged(config, create(config, 'customer')).respond(request, env, ctx);
      }
      if (url.pathname === '/managed/v1/evaluations') {
        if (request.method !== 'POST') throw new ManagedError(405, 'method_not_allowed', 'Send this request as a POST.', { Allow: 'POST' });
        return await createManaged(config, create(config, 'customer')).evaluate(request, env);
      }
      if ((match = MANAGED_ATTEMPT.exec(url.pathname))) {
        if (request.method !== 'GET') throw new ManagedError(405, 'method_not_allowed', 'Read an attempt with a GET.', { Allow: 'GET' });
        return await createManaged(config, create(config, 'customer')).attempt(request, match[1]);
      }
      throw new ManagedError(404, 'not_found', 'This managed model action was not found.');
    } catch (error) {
      if (error instanceof ConfigurationError) console.error(JSON.stringify({ event: 'managed-configuration-unavailable', ...error.problem }));
      return managedErrorResponse(error, headers);
    }
  }

  /**
   * What Stripe and the buyer's browser reach without a Nectovia sign-in. The webhook is Stripe's, and
   * proves itself by its signature over the raw body, so it is routed before the bearer, the origin and
   * the body rules. The return page is plain text for a person sent back from Stripe's own page.
   */
  async function billing(request: Request, env: Record<string, unknown>, pathname: string): Promise<Response> {
    const headers = new Headers({ 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' });
    const refuse = (message: string, status: number, allow: string) => {
      headers.set('Allow', allow);
      return Response.json({ error: message }, { status, headers });
    };
    try {
      if (pathname === '/billing/return') {
        if (request.method !== 'GET') return refuse('Open this page with a GET.', 405, 'GET');
        const page = returnPage(new URL(request.url).searchParams.get('canceled') === '1');
        return new Response(page.body, { status: page.status, headers: page.headers });
      }
      if (request.method !== 'POST') return refuse('Send this request as a POST.', 405, 'POST');
      const answer = await createStripeWebhook(readConfiguration(env), env).handle(request);
      return Response.json(answer.body, { status: answer.status, headers });
    } catch (error) {
      if (error instanceof AccountError) return Response.json({ error: error.message }, { status: error.status, headers });
      console.error(JSON.stringify({ event: 'billing-unavailable', ...(error instanceof ConfigurationError ? error.problem : {}) }));
      headers.set('Retry-After', '5');
      return Response.json({ error: 'Payments are not set up here yet.' }, { status: 503, headers });
    }
  }

  return async (request: Request, env: Record<string, unknown>, ctx?: ManagedContext): Promise<Response> => {
    const entry = new URL(request.url).pathname;
    if (entry.startsWith('/managed/')) return managed(request, env, ctx);
    if (entry === '/billing/stripe/webhook' || entry === '/billing/return') return billing(request, env, entry);
    const headers = new Headers({ 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', Vary: 'Origin' });
    const json = (value: unknown, status = 200) => Response.json(value, { status, headers });
    try {
      const config = readConfiguration(env);
      const origin = request.headers.get('origin');
      if (origin !== null && !config.origins.includes(origin)) throw new AccountError(403, 'This origin is not allowed.');
      if (origin === null && ['cross-site','same-site'].includes(request.headers.get('sec-fetch-site') ?? ''))
        throw new AccountError(403, 'This browser request needs an allowed origin.');
      if (origin !== null) headers.set('Access-Control-Allow-Origin', origin);
      const url = new URL(request.url);
      const queryMethod = request.method === 'OPTIONS' ? request.headers.get('access-control-request-method') ?? '' : request.method;
      checkQuery(url, queryMethod);
      if (request.method === 'OPTIONS') {
        const requested = (request.headers.get('access-control-request-headers') ?? '').toLowerCase().split(',').map((value) => value.trim()).filter(Boolean);
        if (!origin || !['GET','POST','PATCH'].includes(request.headers.get('access-control-request-method') ?? '') ||
          requested.some((header) => !['authorization','content-type'].includes(header))) throw new AccountError(403, 'This preflight is not allowed.');
        headers.set('Access-Control-Allow-Methods', 'GET,POST,PATCH');
        headers.set('Access-Control-Allow-Headers', 'Authorization,Content-Type');
        return new Response(null, { status: 204, headers });
      }
      const authorization = request.headers.get('authorization');
      if (!authorization || authorization.length > 16_391 || !/^Bearer [A-Za-z0-9._~-]+$/.test(authorization))
        throw new AccountError(401, 'A verified bearer session is required.');
      const token = authorization.slice(7);
      const { pathname } = url;
      const method = request.method;
      const accounts = create(config, pathname.startsWith('/ops/') ? 'staff' : 'customer');
      let match: RegExpExecArray | null;

      // --- customer account routes (original shapes unchanged) --------------------------
      if (pathname === '/account/session' && method === 'GET') {
        const page = await accounts.workspacePage(token, url.searchParams.get('after') ?? undefined);
        // Beside the person: whether they are active Diomedes staff, from the staff table alone
        // (never an email domain, a plan, or anything in this request). A read that fails says
        // null, so signing in never depends on it and nobody is taken for staff by an error.
        let staff: Awaited<ReturnType<CommercialService['staffMarkerFor']>> = null;
        try {
          staff = await createCommercial(config, accounts).staffMarkerFor(page.person.id);
        } catch {
          staff = null;
        }
        return json({ ...page, staff });
      }
      if (pathname === '/account/session/revoke' && method === 'POST') {
        await accounts.revokeLocalSession(token); return new Response(null, { status: 204, headers });
      }
      if (pathname === '/account/organizations' && method === 'POST')
        return json(await accounts.createOrganization(token, (await body(request, organizationInput)).name), 201);
      if ((match = route('/account/organizations/:id/usage').exec(pathname)) && method === 'GET')
        return json(await createUsage(config, accounts).usage(token, match[1]));
      // --- usage the business bought outright: a member may hold it, never the included month ---
      if ((match = route('/account/organizations/:id/purchased-usage').exec(pathname)) && method === 'GET')
        return json(await createPurchased(config, accounts).balance(token, match[1]));
      if ((match = route('/account/organizations/:id/purchased-usage/holds').exec(pathname)) && method === 'POST')
        return json(await createPurchased(config, accounts).hold(token, match[1], await body(request, purchasedHoldInput)));
      if ((match = route('/account/organizations/:id/purchased-usage/settlements').exec(pathname)) && method === 'POST')
        return json(await createPurchased(config, accounts).settle(token, match[1], await body(request, purchasedSettleInput)));
      if ((match = route('/account/organizations/:id/purchased-usage/releases').exec(pathname)) && method === 'POST')
        return json(await createPurchased(config, accounts).release(token, match[1], await body(request, purchasedReleaseInput)));
      // --- per-member monthly credit limits: owners and admins set them and decide asks; a member asks and reads their own ---
      if ((match = route('/account/organizations/:id/credit-limits').exec(pathname)) && method === 'GET')
        return json(await createLimits(config, accounts).limits(token, match[1]));
      if ((match = route('/account/organizations/:id/credit-limits').exec(pathname)) && method === 'POST')
        return json(await createLimits(config, accounts).setLimit(token, match[1], await body(request, setLimitInput)));
      if ((match = route('/account/organizations/:id/credit-limits/settings').exec(pathname)) && method === 'POST')
        return json(await createLimits(config, accounts).setSettings(token, match[1], await body(request, setSettingsInput)));
      if ((match = route('/account/organizations/:id/credit-usage/mine').exec(pathname)) && method === 'GET')
        return json(await createLimits(config, accounts).mine(token, match[1]));
      if ((match = route('/account/organizations/:id/credit-usage/members').exec(pathname)) && method === 'GET')
        return json(await createLimits(config, accounts).report(token, match[1]));
      if ((match = route('/account/organizations/:id/credit-limit-requests').exec(pathname)) && method === 'GET')
        return json(await createLimits(config, accounts).requests(token, match[1]));
      if ((match = route('/account/organizations/:id/credit-limit-requests').exec(pathname)) && method === 'POST')
        return json(await createLimits(config, accounts).ask(token, match[1], await body(request, askRaiseInput)));
      if ((match = route('/account/organizations/:id/credit-limit-requests/:id/decision').exec(pathname)) && method === 'POST')
        return json(await createLimits(config, accounts).decide(token, match[1], match[2], await body(request, decideRaiseInput)));
      if ((match = route('/account/organizations/:id/purchased-usage/renewals').exec(pathname)) && method === 'POST')
        return json(await createPurchased(config, accounts).renew(token, match[1], await body(request, purchasedRenewInput)));
      // --- buying more credits: an owner or an admin, through Stripe Checkout ---
      if ((match = route('/account/organizations/:id/credit-purchases/quote').exec(pathname)) && method === 'GET')
        return json(await createCreditPurchases(config, accounts, env).quote(token, match[1], url.searchParams.get('credits')));
      if ((match = route('/account/organizations/:id/credit-purchases').exec(pathname)) && method === 'POST')
        return json(await createCreditPurchases(config, accounts, env).create(token, match[1], await body(request, creditPurchaseInput), url.origin), 201);
      if ((match = route('/account/organizations/:id/credit-purchases/:id').exec(pathname)) && method === 'GET')
        return json(await createCreditPurchases(config, accounts, env).read(token, match[1], match[2]));
      if ((match = route('/account/organizations/:id/invitations').exec(pathname)) && method === 'POST')
        return json(await accounts.invite(token, match[1], await body(request, invitationInput)), 201);
      if ((match = route('/account/organizations/:id/invitations/accept').exec(pathname)) && method === 'POST')
        return json(await accounts.acceptInvitation(token, match[1], (await body(request, acceptanceInput)).token));
      if ((match = route('/account/organizations/:id/members/:id').exec(pathname)) && method === 'PATCH')
        return json(await accounts.setMembership(token, match[1], match[2], await body(request, changeInput)));

      // --- customer access, people and the Agent -----------------------------------------
      if ((match = route('/account/organizations/:id/roster').exec(pathname)) && method === 'GET')
        return json(await accounts.roster(token, match[1]));
      if ((match = route('/account/organizations/:id/invitation-codes').exec(pathname)) && method === 'POST')
        return json(await accounts.createInvitationCode(token, match[1], await body(request, codeInvitationInput)), 201);
      if ((match = /^\/account\/organizations\/([A-Za-z0-9][A-Za-z0-9._-]{0,127})\/invitation-codes\/([a-f0-9]{16})\/revoke$/.exec(pathname)) && method === 'POST') {
        await accounts.revokeInvitationCode(token, match[1], match[2]); return new Response(null, { status: 204, headers });
      }
      if (pathname === '/account/invitation-codes/redeem' && method === 'POST')
        return json(await accounts.redeemInvitationCode(token, (await body(request, redeemCodeInput)).code));
      if ((match = route('/account/organizations/:id/access').exec(pathname)) && method === 'GET')
        return json(await createCommercial(config, accounts).access(token, match[1]));
      if ((match = route('/account/organizations/:id/agent-admissions').exec(pathname)) && method === 'POST')
        return json(await createCommercial(config, accounts).admitAgent(token, match[1], await body(request, agentAdmissionInput)));
      // --- the person's own Individual plan -------------------------------------------------
      if (pathname === '/account/access' && method === 'GET')
        return json(await createCommercial(config, accounts).personAccess(token));
      // Read-only: the person's own current Individual period. No query or body selects a scope.
      if (pathname === '/account/usage' && method === 'GET')
        return json(await createCommercial(config, accounts).personUsage(token));
      if (pathname === '/account/agent-admissions' && method === 'POST')
        return json(await createCommercial(config, accounts).admitPersonalAgent(token, await body(request, agentAdmissionInput)));

      // --- the business setup, kept for the organization (ORG-01) --------------------------
      if ((match = route('/account/organizations/:id/setup').exec(pathname)) && method === 'GET')
        return json(await createOrganizationSetup(config, accounts).read(token, match[1]));
      if ((match = route('/account/organizations/:id/setup').exec(pathname)) && method === 'POST')
        return json(await createOrganizationSetup(config, accounts).write(token, match[1], await body(request, organizationSetupWriteSchema)));

      // --- the business's records, for its owner (OPS-05) ----------------------------------
      if ((match = route('/account/organizations/:id/export').exec(pathname)) && method === 'GET')
        return json(await createOrganizationExport(config, accounts, env).export(token, match[1]));

      // --- the phone relay: the computers a business's phones may reach ------------------
      if ((match = route('/relay/v1/organizations/:id/devices').exec(pathname)) && method === 'POST')
        return json(await createRelay(config, accounts, env).register(token, match[1], await body(request, registerDeviceInput)), 201);
      if ((match = route('/relay/v1/organizations/:id/devices').exec(pathname)) && method === 'GET')
        return json(await createRelay(config, accounts, env).devices(token, match[1]));
      if ((match = route('/relay/v1/organizations/:id/devices/:id').exec(pathname)) && method === 'DELETE') {
        await createRelay(config, accounts, env).revoke(token, match[1], match[2]); return new Response(null, { status: 204, headers });
      }
      if ((match = route('/relay/v1/organizations/:id/presence').exec(pathname)) && method === 'GET')
        return json(await createRelay(config, accounts, env).presence(token, match[1]));
      // A desktop dials out here. The hub answers the WebSocket upgrade itself; a plain GET runs the same checks.
      if ((match = route('/relay/v1/organizations/:id/desktop').exec(pathname)) && method === 'GET') {
        const answer = await createRelay(config, accounts, env).desktop(token, match[1], request);
        return answer instanceof Response ? answer : json(answer);
      }
      // A phone dials here (relay plan step 3): the same front checks as presence, no device key.
      if ((match = route('/relay/v1/organizations/:id/phone').exec(pathname)) && method === 'GET') {
        const answer = await createRelay(config, accounts, env).phone(token, match[1], request);
        return answer instanceof Response ? answer : json(answer);
      }

      if (pathname === '/account/routing-policy' && method === 'GET')
        return json(await createCommercial(config, accounts).routingPolicy(token));
      if (pathname === '/account/individual' && method === 'POST') return json(await createRouting(config, accounts).individual(token));
      if ((match = new RegExp(`^/account/routing/(organization|individual)/${ID}/(policy|preference|admit|access)$`).exec(pathname))) {
        const scope: AccountScope = { kind: match[1] as AccountScope['kind'], id: match[2] }, routing = createRouting(config, accounts);
        if (match[3] === 'policy' && method === 'GET') return json(await routing.snapshot(token, scope, env));
        if (match[3] === 'access' && method === 'GET') return json(await routing.access(token, scope));
        if (match[3] === 'preference' && method === 'GET') return json(await routing.preference(token, scope));
        if (match[3] === 'preference' && method === 'POST') {
          const input = await body(request, preferenceInputSchema);
          if (input.scope.kind !== scope.kind || input.scope.id !== scope.id) throw new AccountError(422, 'The scope in this request does not match the address.');
          return json(await routing.acceptPreference(token, input));
        }
        if (match[3] === 'admit' && method === 'POST') return json(await routing.admit(token, scope, await body(request, agentAdmissionInput)));
      }

      // --- Diomedes staff (Operations app). The bearer is a registered staff key. ---------
      // Every route but sign-out checks the staff role itself. Sign-out retires the key's
      // session for good; the app forgets a key locally instead of calling it.
      if (pathname.startsWith('/ops/')) {
        if (pathname === '/ops/session/revoke' && method === 'POST') {
          await accounts.revokeLocalSession(token); return new Response(null, { status: 204, headers });
        }
        const ops = createCommercial(config, accounts);
        const routing = createRouting(config, accounts);
        if (pathname === '/ops/me' && method === 'GET') return json(await ops.me(token));
        if (pathname === '/ops/individuals' && method === 'GET') return json(await routing.individuals(token, url.searchParams.get('q') ?? ''));
        if ((match = route('/ops/individuals/:id').exec(pathname)) && method === 'GET') return json(await routing.individualDetail(token, match[1]));
        if ((match = route('/ops/individuals/:id/grants').exec(pathname)) && method === 'POST') return json(await routing.issueIndividualAgreement(token, match[1], await body(request, individualAgreementInput)), 201);
        if ((match = route('/ops/individuals/:id/grants/:id/revoke').exec(pathname)) && method === 'POST')
          return json(await routing.revokeIndividualAgreement(token, match[1], match[2], await body(request, revokeGrantInput)));
        if (pathname === '/ops/routing/scopes/global' && method === 'GET') return json(await routing.view(token, { kind: 'global' }, env));
        if ((match = new RegExp(`^/ops/routing/scopes/(organization|individual)/${ID}$`).exec(pathname)) && method === 'GET')
          return json(await routing.view(token, { kind: match[1] as AccountScope['kind'], id: match[2] }, env));
        if (pathname === '/ops/routing/scopes/preview' && method === 'POST') return json(await routing.preview(token, await body(request, scopedPublicationSchema), env));
        if (pathname === '/ops/routing/scopes/publish' && method === 'POST') return json(await routing.publish(token, await body(request, scopedPublicationSchema), env), 201);
        if (pathname === '/ops/routing/scopes/rollback' && method === 'POST') return json(await routing.publish(token, await body(request, scopedRollbackSchema), env, true), 201);
        if ((match = route('/ops/connections/:id/models').exec(pathname)) && method === 'GET') {
          const staff = await ops.me(token);
          if (!staff.permissions.includes('routes.write')) throw new AccountError(403, 'Routing permission is required.');
          const connection = approvedConnections(env).find(c => c.id === match![1]);
          if (!connection) throw new AccountError(404, 'That approved connection was not found.');
          return json(await discoverConnectionModels(connection, env));
        }
        if (pathname === '/ops/customers' && method === 'GET') return json(await ops.customers(token, url.searchParams.get('q') ?? ''));
        if ((match = route('/ops/customers/:id').exec(pathname)) && method === 'GET') return json(await ops.customer(token, match[1]));
        if ((match = route('/ops/customers/:id/grants').exec(pathname)) && method === 'POST')
          return json(await ops.issueGrant(token, match[1], await body(request, issueGrantInput)), 201);
        if ((match = route('/ops/customers/:id/grants/:id/revoke').exec(pathname)) && method === 'POST')
          return json(await ops.revokeGrant(token, match[1], match[2], await body(request, revokeGrantInput)));
        if ((match = route('/ops/customers/:id/funding').exec(pathname)) && method === 'POST')
          return json(await ops.addFunding(token, match[1], await body(request, addFundingInput)), 201);
        if (pathname === '/ops/routing' && method === 'GET') return json(await ops.routes(token));
        if (pathname === '/ops/routes' && method === 'POST') return json(await ops.saveRoute(token, await body(request, saveRouteInput, routeInputRefusal), env));
        if ((match = ROUTE_CHECKS.exec(pathname)) && method === 'POST')
          return json(await createRouteChecks(config, accounts).run(token, match[1], await body(request, routeChecksInputSchema), env));
        if (pathname === '/ops/routing/preview' && method === 'POST') return json(await ops.previewPolicy(token, await body(request, publishPolicyInput)));
        if (pathname === '/ops/routing/publish' && method === 'POST') return json(await ops.publishPolicy(token, await body(request, publishPolicyInput)), 201);
        if (pathname === '/ops/routing/rollback' && method === 'POST') return json(await ops.rollbackPolicy(token, await body(request, rollbackPolicyInput)), 201);
        if (pathname === '/ops/staff' && method === 'GET') return json(await ops.staffList(token));
        if (pathname === '/ops/staff' && method === 'POST') return json(await ops.addStaff(token, await body(request, addStaffInput)), 201);
        if ((match = route('/ops/staff/:id').exec(pathname)) && method === 'PATCH') return json(await ops.changeStaff(token, match[1], await body(request, changeStaffInput)));
        if (pathname === '/ops/people' && method === 'GET') return json(await ops.people(token, url.searchParams.get('q') ?? ''));
        if ((match = route('/ops/people/:id').exec(pathname)) && method === 'GET') return json(await ops.person(token, match[1]));
        if ((match = route('/ops/people/:id/grants').exec(pathname)) && method === 'POST')
          return json(await ops.issuePersonGrant(token, match[1], await body(request, issuePersonGrantInput)), 201);
        if ((match = route('/ops/people/:id/grants/:id/revoke').exec(pathname)) && method === 'POST')
          return json(await ops.revokePersonGrant(token, match[1], match[2], await body(request, revokeGrantInput)));
        if (pathname === '/ops/audit' && method === 'GET') {
          const limit = url.searchParams.get('limit');
          return json(await ops.audit(token, { organizationId: url.searchParams.get('organizationId') ?? undefined, limit: limit ? Number(limit) : undefined }));
        }
      }
      throw new AccountError(404, 'This account action was not found.');
    } catch (error) {
      if (error instanceof AccountError) {
        const code = (error as { code?: unknown }).code;
        // The proof aged inside this service. The header tells a client it may ask again; the desktop
        // keeps the sign-in and the person can try again.
        if (code === IDENTITY_RECHECK) headers.set('Retry-After', '1');
        // Every refusal of a route save names its fields, an empty list when it is about none (DIO-198).
        const fields = error.fields ?? (entry === '/ops/routes' && request.method === 'POST' ? [] : undefined);
        return json({ error: error.message, ...(typeof code === 'string' ? { code } : {}), ...(fields ? { fields } : {}) }, error.status);
      }
      // Names the setting and rule a configuration refusal broke, never its value.
      console.error(JSON.stringify({ event: 'control-plane-unavailable', ...(error instanceof ConfigurationError ? error.problem : {}) }));
      headers.set('Retry-After', '5');
      return json({ error: 'Account service is unavailable. Try again later.' }, 503);
    }
  };
}

/**
 * The Worker's bindings, plus the managed gateway's three secrets and its two
 * optional spend settings (see src/managed-inference.ts):
 * - BEDROCK_API_KEY, a Bedrock long-term API key set by the owner and read by the
 *   gateway at call time. It is never in wrangler.jsonc, a log, a response or a row.
 * - FUNDING_DATABASE_URL, the login cp_funding for the gateway's funding rows
 *   (scripts/funding-permissions.sql), on the same database as DATABASE_URL.
 *   Unset, blank or unreadable: every managed call answers 503 route_unavailable.
 * - OPENROUTER_API_KEY, the key /managed/v1/evaluations sends to OpenRouter's
 *   Decisions endpoint; without it that route alone answers 503.
 * Each approved connection in MANAGED_CONNECTIONS names one more secret by secretRef and is read
 * as env[secretRef] (src/managed-bindings.ts): BEDROCK_API_KEY and OPENROUTER_API_KEY above,
 * AZURE_OPENAI_API_KEY for the Azure AI Foundry resource, and VERTEX_API_KEY (or a short-lived
 * VERTEX_ACCESS_TOKEN) for Vertex. A connection whose secret is unset serves nothing.
 * STAFF_WORKOS_API_KEY and STAFF_WORKOS_CLIENT_ID (src/config.ts) are no longer read by
 * /ops/*: staff sign in with staff keys since 2026-09-26. They go with the staff WorkOS
 * environment.
 */
export type GatewayEnv = WorkerEnv & {
  BEDROCK_API_KEY?: string;
  OPENROUTER_API_KEY?: string;
  FUNDING_DATABASE_URL?: string;
  /** Whole cents for 100 credits. A setting, never a default: unset, every quote and purchase answers 503. */
  CREDIT_PRICE_CENTS_PER_100?: string | number;
  /** Stripe secret key, and the endpoint secret for /billing/stripe/webhook. Both Worker secrets. */
  STRIPE_SECRET_KEY?: string;
  STRIPE_WEBHOOK_SECRET?: string;
  STAFF_WORKOS_API_KEY?: string;
  MANAGED_SPEND_CEILING_MICRO_USD?: string | number;
  MANAGED_MAX_OUTPUT_TOKENS?: string | number;
  /** Legacy configuration only. Individual never covers a Business, at any member count. */
  INDIVIDUAL_MAX_ACTIVE_MEMBERS?: string | number;
};

const fetchHandler = createHandler();
export default {
  fetch(request: Request, env: GatewayEnv, ctx: ManagedContext) { return fetchHandler(request, { ...env }, ctx); },
};
