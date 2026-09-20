import { z } from 'zod';
import type { Organization } from '../../shared/workspaces.js';
import { ApiError } from '../paths.js';
import {
  currentAuthority,
  generationFor,
  isDenial,
  isRevoked,
  refOf,
  requireCapability,
  type Authority,
  type Capability,
  type PrincipalRef,
} from '../trust/index.js';
import { accountId, type AccountMembershipSnapshot } from './account-contract.js';
import type { AccountService } from './account-service.js';

export interface AccountTransportPolicy {
  allowedOrigins: readonly string[];
}
export interface AccountProjectBinding {
  organizationId: string;
  tenantId: string;
  projectId: string;
}
export interface AccountHostContext {
  scope: AccountProjectBinding;
  actorPersonId: string;
  sessionId: string;
  principalRef: PrincipalRef;
  validUntil: string;
}

function origins(policy: AccountTransportPolicy): ReadonlySet<string> {
  if (policy.allowedOrigins.length === 0)
    throw new Error('Configure an explicit account origin allowlist.');
  for (const origin of policy.allowedOrigins) {
    const url = new URL(origin);
    if (
      url.origin !== origin ||
      url.username ||
      url.password ||
      (url.protocol !== 'https:' &&
        !(url.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(url.hostname)))
    )
      throw new Error('Account origins must be exact HTTPS origins or owned loopback origins.');
  }
  return new Set(policy.allowedOrigins);
}

function checkOrigin(request: Request, allowed: ReadonlySet<string>) {
  const origin = request.headers.get('origin');
  if (origin !== null && !allowed.has(origin))
    throw new ApiError(403, 'This origin cannot access the account service.');
  // No cookie authentication: a missing Origin is permitted for native bearer
  // clients, and cannot make an ambient browser cookie into an account session.
}

function bearer(request: Request, allowed: ReadonlySet<string>): string {
  checkOrigin(request, allowed);
  const value = request.headers.get('authorization') ?? '';
  const match = /^Bearer ([A-Za-z0-9._-]{1,16384})$/.exec(value);
  if (!match) throw new ApiError(401, 'A verified bearer access token is required.');
  return match[1];
}

/**
 * Bridge into the existing Trust resolver, never an installer of a new backend
 * or a grant table. Remote admission stays unavailable until that backend
 * resolves this verified session to an explicitly bound project principal.
 */
export class AccountHost {
  private readonly allowed: ReadonlySet<string>;
  private readonly now: () => number;
  constructor(
    private readonly accounts: AccountService,
    private readonly options: AccountTransportPolicy & {
      /** Host-owned explicit output binding. Read-only, and safe while Store is locked. */
      resolveProject(organization: Organization): Promise<AccountProjectBinding | null>;
      now?: () => number;
    },
  ) {
    this.allowed = origins(options);
    this.now = options.now ?? Date.now;
  }

  private checkBinding(
    binding: AccountProjectBinding | null,
    account: AccountMembershipSnapshot,
    projectId: string,
  ): asserts binding is AccountProjectBinding {
    if (
      !binding ||
      binding.organizationId !== account.organization.id ||
      binding.tenantId !== account.organization.tenantId ||
      binding.projectId !== projectId
    )
      throw new ApiError(403, 'This project is not the authorized Business work target.');
  }

  private checkAuthority(
    authority: Authority,
    account: AccountMembershipSnapshot,
    projectId: string,
    capability: Capability,
  ) {
    const principal = authority.principal;
    if (
      authority.synthetic ||
      principal.kind !== 'session' ||
      principal.id !== account.principalId ||
      principal.sessionId !== account.sessionId ||
      principal.tenantId !== account.organization.tenantId ||
      principal.projectId !== projectId ||
      (authority.expiresAt !== null &&
        (!Number.isFinite(Date.parse(authority.expiresAt)) ||
          Date.parse(authority.expiresAt) <= this.now()))
    )
      throw new ApiError(
        403,
        'Trust did not authorize this session for the selected tenant and project.',
      );
    const required = requireCapability(authority, capability);
    if (isDenial(required)) throw new ApiError(required.status, required.reason);
  }

  async withProjectAccess<T>(
    request: Request,
    target: { organizationId: string; projectId: string },
    capability: Capability,
    action: (context: AccountHostContext) => T | Promise<T>,
  ): Promise<T> {
    if (
      !accountId.safeParse(target.organizationId).success ||
      !accountId.safeParse(target.projectId).success
    )
      throw new ApiError(422, 'A valid organization and project are required.');
    const account = await this.accounts.membership(
      bearer(request, this.allowed),
      target.organizationId,
    );
    this.checkBinding(
      await this.options.resolveProject(account.organization),
      account,
      target.projectId,
    );
    const reference: PrincipalRef = {
      kind: 'session',
      id: account.principalId,
      tenantId: account.organization.tenantId,
      mintedAt: generationFor({
        kind: 'session',
        id: account.principalId,
        tenantId: account.organization.tenantId,
      }),
    };
    const authority = await currentAuthority({ via: 'stored-reference', ref: reference });
    if (isDenial(authority)) throw new ApiError(authority.status, authority.reason);
    this.checkAuthority(authority, account, target.projectId, capability);
    return this.accounts.withCurrentMembership(account, async (current) => {
      const binding = await this.options.resolveProject(current.organization);
      this.checkBinding(binding, current, target.projectId);
      this.checkAuthority(authority, current, target.projectId, capability);
      const revoked = await isRevoked(authority.principal);
      const live = generationFor(authority.principal);
      if (
        revoked ||
        live.identity !== authority.generation.identity ||
        live.principal !== authority.generation.principal
      )
        throw new ApiError(403, 'Trust changed before access; resolve current authority again.');
      if (Date.parse(current.validUntil) <= this.now())
        throw new ApiError(401, 'The membership snapshot expired.');
      return action({
        scope: { ...binding },
        actorPersonId: current.person.id,
        sessionId: current.sessionId,
        principalRef: refOf(authority),
        validUntil: current.validUntil,
      });
    });
  }
}

const organizationBody = z.strictObject({ name: z.string().trim().min(1).max(200) });
const invitationBody = z.strictObject({
  subject: accountId,
  role: z.enum(['owner', 'admin', 'member']),
  ttlMs: z
    .number()
    .int()
    .min(1000)
    .max(7 * 24 * 60 * 60 * 1000),
});
const acceptanceBody = z.strictObject({ token: z.string().regex(/^[A-Za-z0-9_-]{43}$/) });
const membershipBody = z.strictObject({
  role: z.enum(['owner', 'admin', 'member']),
  state: z.enum(['active', 'revoked']),
});

async function body<T>(request: Request, schema: z.ZodType<T>): Promise<T> {
  if (
    request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json'
  )
    throw new ApiError(415, 'Use a JSON request body.');
  const reader = request.body?.getReader();
  if (!reader) throw new ApiError(422, 'A request body is required.');
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      length += part.value.byteLength;
      if (length > 16_384) {
        await reader.cancel();
        throw new ApiError(413, 'The account request is too large.');
      }
      chunks.push(part.value);
    }
  } finally {
    reader.releaseLock();
  }
  let input: unknown;
  try {
    input = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
  } catch (error) {
    if (!(error instanceof SyntaxError) && !(error instanceof TypeError)) throw error;
    throw new ApiError(422, 'The JSON request body is invalid.');
  }
  const parsed = schema.safeParse(input);
  if (!parsed.success)
    throw new ApiError(422, 'The account request contains invalid or unexpected fields.');
  return parsed.data;
}

/** Fetch-compatible account API; no listener, deployment or desktop loopback changes. */
export function createAccountHandler(accounts: AccountService, policy: AccountTransportPolicy) {
  const allowed = origins(policy);
  return async (request: Request): Promise<Response> => {
    const headers = new Headers({
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      Vary: 'Origin',
    });
    const json = (value: unknown, status = 200) => Response.json(value, { status, headers });
    try {
      checkOrigin(request, allowed);
      const origin = request.headers.get('origin');
      if (origin) headers.set('Access-Control-Allow-Origin', origin);
      const url = new URL(request.url);
      if (url.search) throw new ApiError(422, 'Account requests do not accept query parameters.');
      if (request.method === 'OPTIONS') {
        if (
          !origin ||
          !['GET', 'POST', 'PATCH'].includes(
            request.headers.get('access-control-request-method') ?? '',
          )
        )
          throw new ApiError(403, 'This preflight is not allowed.');
        const requested = (request.headers.get('access-control-request-headers') ?? '')
          .toLowerCase()
          .split(',')
          .map((value) => value.trim())
          .filter(Boolean);
        if (requested.some((header) => !['authorization', 'content-type'].includes(header)))
          throw new ApiError(403, 'This preflight header is not allowed.');
        headers.set('Access-Control-Allow-Methods', 'GET,POST,PATCH');
        headers.set('Access-Control-Allow-Headers', 'Authorization,Content-Type');
        return new Response(null, { status: 204, headers });
      }
      const token = bearer(request, allowed);
      if (url.pathname === '/account/session' && request.method === 'GET')
        return json(await accounts.listWorkspaces(token));
      if (url.pathname === '/account/session/revoke' && request.method === 'POST') {
        await accounts.revokeLocalSession(token);
        return new Response(null, { status: 204, headers });
      }
      if (url.pathname === '/account/organizations' && request.method === 'POST')
        return json(
          await accounts.createOrganization(token, (await body(request, organizationBody)).name),
          201,
        );
      const invite = /^\/account\/organizations\/([A-Za-z0-9._-]{1,128})\/invitations$/.exec(
        url.pathname,
      );
      if (invite && request.method === 'POST')
        return json(
          await accounts.invite(token, invite[1], await body(request, invitationBody)),
          201,
        );
      const accept =
        /^\/account\/organizations\/([A-Za-z0-9._-]{1,128})\/invitations\/accept$/.exec(
          url.pathname,
        );
      if (accept && request.method === 'POST')
        return json(
          await accounts.acceptInvitation(
            token,
            accept[1],
            (await body(request, acceptanceBody)).token,
          ),
        );
      const member =
        /^\/account\/organizations\/([A-Za-z0-9._-]{1,128})\/members\/([A-Za-z0-9._-]{1,128})$/.exec(
          url.pathname,
        );
      if (member && request.method === 'PATCH')
        return json(
          await accounts.setMembership(
            token,
            member[1],
            member[2],
            await body(request, membershipBody),
          ),
        );
      throw new ApiError(404, 'This account action was not found.');
    } catch (error) {
      if (!(error instanceof ApiError)) throw error;
      return json({ error: error.message }, error.status);
    }
  };
}
