import { z } from 'zod';
import { configuration, type Configuration } from './config.js';
import { AccountService, organizationInput, invitationInput, changeInput, acceptanceInput, codeInvitationInput, redeemCodeInput } from './account-service.js';
import { AccountError } from './errors.js';
import { readBytes } from './crypto.js';
import { WorkOSIdentityVerifier } from './identity-workos.js';
import { PostgresRepository, neonClientFactory } from './postgres.js';
import { FundingService, UsageService } from './funding.js';
import { PostgresFundingRepository } from './funding-postgres.js';
import { PostgresCommercialRepository } from './commercial-postgres.js';
import {
  CommercialService,
  addFundingInput,
  addStaffInput,
  agentAdmissionInput,
  changeStaffInput,
  issueGrantInput,
  publishPolicyInput,
  revokeGrantInput,
  rollbackPolicyInput,
  saveRouteInput,
} from './commercial.js';
import type { WorkerEnv } from '../worker-configuration.js';
import { accountId } from './domain.js';

async function body<T>(request: Request, schema: z.ZodType<T>): Promise<T> {
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
  if (!parsed.success) throw new AccountError(422, 'The account request contains invalid or unexpected fields.');
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
  { path: /^\/ops\/people$/, keys: { q: (value) => value.length <= 100 } },
  { path: /^\/ops\/audit$/, keys: { organizationId: (value) => accountId.safeParse(value).success, limit: (value) => /^[1-9][0-9]{0,2}$/.test(value) } },
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
}

/** Factory injection is only a test seam; no environment flag enables fake identity/storage. */
export function createHandler(create: (config: Configuration) => AccountService = (config) =>
  new AccountService(new PostgresRepository(neonClientFactory(config.databaseUrl)), new WorkOSIdentityVerifier(config.identity)),
  // The usage read verifies membership first, then reads funding rows under the
  // organization's own tenant. There is no funding write route in this Worker.
  createUsage: (config: Configuration, accounts: AccountService) => Pick<UsageService, 'usage'> = (config, accounts) =>
    new UsageService(accounts, new FundingService(new PostgresFundingRepository(neonClientFactory(config.databaseUrl)))),
  options: HandlerOptions = {}) {
  const readConfiguration = options.configuration ?? configuration;
  const createCommercial = options.createCommercial ?? ((config: Configuration, accounts: AccountService) =>
    new CommercialService(accounts, new PostgresCommercialRepository(neonClientFactory(config.databaseUrl)),
      new FundingService(new PostgresFundingRepository(neonClientFactory(config.databaseUrl)))));
  return async (request: Request, env: Record<string, unknown>): Promise<Response> => {
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
      const accounts = create(config);
      const { pathname } = url;
      const method = request.method;
      let match: RegExpExecArray | null;

      // --- customer account routes (original shapes unchanged) --------------------------
      if (pathname === '/account/session' && method === 'GET') return json(await accounts.workspacePage(token, url.searchParams.get('after') ?? undefined));
      if (pathname === '/account/session/revoke' && method === 'POST') {
        await accounts.revokeLocalSession(token); return new Response(null, { status: 204, headers });
      }
      if (pathname === '/account/organizations' && method === 'POST')
        return json(await accounts.createOrganization(token, (await body(request, organizationInput)).name), 201);
      if ((match = route('/account/organizations/:id/usage').exec(pathname)) && method === 'GET')
        return json(await createUsage(config, accounts).usage(token, match[1]));
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
      if (pathname === '/account/routing-policy' && method === 'GET')
        return json(await createCommercial(config, accounts).routingPolicy(token));

      // --- Diomedes staff (Operations app). Every route checks the staff role itself. -------
      if (pathname.startsWith('/ops/')) {
        const ops = createCommercial(config, accounts);
        if (pathname === '/ops/me' && method === 'GET') return json(await ops.me(token));
        if (pathname === '/ops/customers' && method === 'GET') return json(await ops.customers(token, url.searchParams.get('q') ?? ''));
        if ((match = route('/ops/customers/:id').exec(pathname)) && method === 'GET') return json(await ops.customer(token, match[1]));
        if ((match = route('/ops/customers/:id/grants').exec(pathname)) && method === 'POST')
          return json(await ops.issueGrant(token, match[1], await body(request, issueGrantInput)), 201);
        if ((match = route('/ops/customers/:id/grants/:id/revoke').exec(pathname)) && method === 'POST')
          return json(await ops.revokeGrant(token, match[1], match[2], await body(request, revokeGrantInput)));
        if ((match = route('/ops/customers/:id/funding').exec(pathname)) && method === 'POST')
          return json(await ops.addFunding(token, match[1], await body(request, addFundingInput)), 201);
        if (pathname === '/ops/routing' && method === 'GET') return json(await ops.routes(token));
        if (pathname === '/ops/routes' && method === 'POST') return json(await ops.saveRoute(token, await body(request, saveRouteInput)));
        if (pathname === '/ops/routing/preview' && method === 'POST') return json(await ops.previewPolicy(token, await body(request, publishPolicyInput)));
        if (pathname === '/ops/routing/publish' && method === 'POST') return json(await ops.publishPolicy(token, await body(request, publishPolicyInput)), 201);
        if (pathname === '/ops/routing/rollback' && method === 'POST') return json(await ops.rollbackPolicy(token, await body(request, rollbackPolicyInput)), 201);
        if (pathname === '/ops/staff' && method === 'GET') return json(await ops.staffList(token));
        if (pathname === '/ops/staff' && method === 'POST') return json(await ops.addStaff(token, await body(request, addStaffInput)), 201);
        if ((match = route('/ops/staff/:id').exec(pathname)) && method === 'PATCH') return json(await ops.changeStaff(token, match[1], await body(request, changeStaffInput)));
        if (pathname === '/ops/people' && method === 'GET') return json(await ops.people(token, url.searchParams.get('q') ?? ''));
        if (pathname === '/ops/audit' && method === 'GET') {
          const limit = url.searchParams.get('limit');
          return json(await ops.audit(token, { organizationId: url.searchParams.get('organizationId') ?? undefined, limit: limit ? Number(limit) : undefined }));
        }
      }
      throw new AccountError(404, 'This account action was not found.');
    } catch (error) {
      if (error instanceof AccountError) {
        const code = (error as { code?: unknown }).code;
        return json(typeof code === 'string' ? { error: error.message, code } : { error: error.message }, error.status);
      }
      console.error(JSON.stringify({ event: 'control-plane-unavailable' }));
      headers.set('Retry-After', '5');
      return json({ error: 'Account service is unavailable. Try again later.' }, 503);
    }
  };
}

const fetchHandler = createHandler();
export default {
  fetch(request: Request, env: WorkerEnv) { return fetchHandler(request, { ...env }); },
};
