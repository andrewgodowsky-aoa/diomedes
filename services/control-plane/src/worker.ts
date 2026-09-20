import { z } from 'zod';
import { configuration, type Configuration } from './config.js';
import { AccountService, organizationInput, invitationInput, changeInput, acceptanceInput } from './account-service.js';
import { AccountError } from './errors.js';
import { readBytes } from './crypto.js';
import { WorkOSIdentityVerifier } from './identity-workos.js';
import { PostgresRepository, neonClientFactory } from './postgres.js';
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

/** Factory injection is only a test seam; no environment flag enables fake identity/storage. */
export function createHandler(create: (config: Configuration) => AccountService = (config) =>
  new AccountService(new PostgresRepository(neonClientFactory(config.databaseUrl)), new WorkOSIdentityVerifier(config.identity))) {
  return async (request: Request, env: Record<string, unknown>): Promise<Response> => {
    const headers = new Headers({ 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', Vary: 'Origin' });
    const json = (value: unknown, status = 200) => Response.json(value, { status, headers });
    try {
      const config = configuration(env);
      const origin = request.headers.get('origin');
      if (origin !== null && !config.origins.includes(origin)) throw new AccountError(403, 'This origin is not allowed.');
      if (origin === null && ['cross-site','same-site'].includes(request.headers.get('sec-fetch-site') ?? ''))
        throw new AccountError(403, 'This browser request needs an allowed origin.');
      if (origin !== null) headers.set('Access-Control-Allow-Origin', origin);
      const url = new URL(request.url);
      const after = url.searchParams.get('after');
      const queryMethod = request.method === 'OPTIONS' ? request.headers.get('access-control-request-method') : request.method;
      if (url.search && !(url.pathname === '/account/session' && queryMethod === 'GET' &&
        [...url.searchParams.keys()].every(key => key === 'after') && url.searchParams.getAll('after').length === 1 && accountId.safeParse(after).success))
        throw new AccountError(422, 'The account query contains invalid or unexpected fields.');
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
      if (url.pathname === '/account/session' && request.method === 'GET') return json(await accounts.workspacePage(token, after ?? undefined));
      if (url.pathname === '/account/session/revoke' && request.method === 'POST') {
        await accounts.revokeLocalSession(token); return new Response(null, { status: 204, headers });
      }
      if (url.pathname === '/account/organizations' && request.method === 'POST')
        return json(await accounts.createOrganization(token, (await body(request, organizationInput)).name), 201);
      const invite = /^\/account\/organizations\/([A-Za-z0-9][A-Za-z0-9._-]{0,127})\/invitations$/.exec(url.pathname);
      if (invite && request.method === 'POST') return json(await accounts.invite(token, invite[1], await body(request, invitationInput)), 201);
      const accept = /^\/account\/organizations\/([A-Za-z0-9][A-Za-z0-9._-]{0,127})\/invitations\/accept$/.exec(url.pathname);
      if (accept && request.method === 'POST') return json(await accounts.acceptInvitation(token, accept[1], (await body(request, acceptanceInput)).token));
      const member = /^\/account\/organizations\/([A-Za-z0-9][A-Za-z0-9._-]{0,127})\/members\/([A-Za-z0-9][A-Za-z0-9._-]{0,127})$/.exec(url.pathname);
      if (member && request.method === 'PATCH') return json(await accounts.setMembership(token, member[1], member[2], await body(request, changeInput)));
      throw new AccountError(404, 'This account action was not found.');
    } catch (error) {
      if (error instanceof AccountError) return json({ error: error.message }, error.status);
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
