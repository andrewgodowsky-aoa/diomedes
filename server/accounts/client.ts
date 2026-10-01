/**
 * The desktop's client for the account service (the control plane).
 *
 * One typed class over a fetch-shaped function, so the same client talks to
 * the faux cloud in-process (tests), to the faux cloud over loopback (the
 * desktop app and the Operations app sharing one test service) and, when it
 * is configured, to the deployed Worker. The account service is the authority
 * for every answer here; the desktop caches, it never decides.
 */
import { z } from 'zod';
import { readStaffMarker, type AccessView, type StaffMarker } from '../../shared/access.js';
import type { PersonAccessView } from '../../shared/individual-plan.js';
import type { OrganizationSetupAnswer, OrganizationSetupWrite } from '../../shared/organization-setup.js';
import type { Membership, MemberRole, Organization, Person } from '../../shared/workspaces.js';
import { RELAY_DEVICE_HEADER } from '../../services/control-plane/src/relay/protocol.js';
import type { DesktopCheckAnswer } from '../../services/control-plane/src/relay/service.js';
import { organizationSetupAnswerSchema } from '../../services/control-plane/src/organization-setup/schema.js';
import { organizationAccountExportSchema, type ReadOrganizationExport } from '../../services/control-plane/src/organization-export/schema.js';
import { individualAccountSchema, resolvedRoutingSnapshotSchema, routingPreferenceSchema,
  type AccountScope, type RoutingPreferenceWrite } from '../../shared/routing-policy.js';

export type Fetcher = (request: Request) => Promise<Response>;

const scopedEntitlementSchema = z.object({ plan: z.string(), planLabel: z.string().nullable(),
  state: z.enum(['none', 'active', 'expired', 'revoked', 'unknown']), features: z.array(z.string()).max(100),
  agent: z.boolean(), managedInference: z.boolean(), validFrom: z.iso.datetime().nullable(), validUntil: z.iso.datetime().nullable(),
  revision: z.number().int().nonnegative(), source: z.enum(['none', 'account-service']), reason: z.string(),
});

/**
 * What the account service answers for usage a business bought outright: the recorded top-ups, and
 * what is held or spent against them. Read against this shape, never trusted as it arrives, because
 * money is on it.
 */
const purchasedBalanceSchema = z.strictObject({
  purchasedMicroUsd: z.number().int().nonnegative(), heldMicroUsd: z.number().int().nonnegative(),
  settledMicroUsd: z.number().int().nonnegative(), availableMicroUsd: z.number().int().nonnegative(),
});
const purchasedHoldSchema = z.strictObject({
  holdId: z.string(), state: z.enum(['held', 'settled', 'released']),
  amountMicroUsd: z.number().int().positive(), debitMicroUsd: z.number().int().nonnegative(),
  createdAt: z.string(), resolvedAt: z.string().nullable(), balance: purchasedBalanceSchema,
});
export type PurchasedBalanceAnswer = z.infer<typeof purchasedBalanceSchema>;
export type PurchasedHoldAnswer = z.infer<typeof purchasedHoldSchema>;

export class ControlPlaneError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string | null = null,
  ) {
    super(message);
    this.name = 'ControlPlaneError';
  }
}

export interface TokenPair {
  accessToken: string;
  accessExpiresAt: string;
  refreshToken: string;
  refreshExpiresAt: string;
  remember: boolean;
  user: { subject: string; email: string; name: string };
}

export interface SessionPage {
  person: Person;
  organizations: { organization: Organization; membership: Membership }[];
  nextCursor: string | null;
  /** The service's word on whether this person is active Diomedes staff. An older service leaves it out. */
  staff?: unknown;
}

export interface AgentAdmissionAnswer {
  admissionId: string;
  decision:
    | { admitted: true; planId: string | null; revision: number; validUntil: string | null }
    | { admitted: false; code: string; reason: string };
  pins: {
    scope?: AccountScope;
    /** Null for Personal work admitted under the person's own Individual plan. */
    organizationId: string | null;
    tenantId: string;
    personId: string;
    planId: string | null;
    accessRevision: number;
    policyRevision: number;
    rootJobId: string | null;
  };
  validUntil: string;
}

export interface RoutingPolicyAnswer {
  revision: number;
  publishedAt: string | null;
  tiers: Record<'efficient' | 'focused' | 'thorough', { entryId: string; provider: string; model: string; label: string; entryRevision: number } | null>;
  /**
   * Per tier, whether the gateway accepts reasoning summaries for the upstream serving it. An older
   * gateway leaves it out and is never asked for one.
   */
  reasoningSummaries?: Record<'efficient' | 'focused' | 'thorough', boolean>;
}

/** A computer registered for phone access. The service never answers its key. */
export interface RelayRegistrationAnswer {
  deviceId: string;
  organizationId: string;
  label: string;
  createdAt: string;
}

export interface RosterAnswer {
  organizationId: string;
  you: { personId: string; role: MemberRole };
  people: { personId: string; name: string; role: MemberRole; state: string; joinedAt: string | null; revokedAt: string | null }[];
  invitations: { id: string; role: MemberRole; email: string | null; createdAt: string; expiresAt: string; invitedBy: string }[] | null;
}

export class ControlPlaneClient {
  constructor(
    readonly base: string,
    private readonly fetcher: Fetcher,
    private readonly timeoutMs = 15_000,
  ) {}

  private async call<T>(
    method: string,
    path: string,
    token?: string | null,
    body?: unknown,
    extra: Record<string, string> = {},
    timeoutMs = this.timeoutMs,
  ): Promise<T> {
    const headers = new Headers(extra);
    if (token) headers.set('authorization', `Bearer ${token}`);
    if (body !== undefined) headers.set('content-type', 'application/json');
    let response: Response;
    try {
      response = await this.fetcher(new Request(`${this.base}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      }));
    } catch {
      throw new ControlPlaneError('The account service could not be reached. Check the connection and try again.', 503, 'unreachable');
    }
    const text = await response.text();
    let payload: unknown = null;
    try {
      payload = text ? JSON.parse(text) : null;
    } catch {
      payload = null;
    }
    if (!response.ok) {
      const error = payload as { error?: unknown; code?: unknown } | null;
      throw new ControlPlaneError(
        typeof error?.error === 'string' ? error.error : 'The account service refused the request.',
        response.status,
        typeof error?.code === 'string' ? error.code : null,
      );
    }
    return payload as T;
  }

  /**
   * One request on the account service's own transport, unchanged. The Nectovia route gives
   * this to the AI SDK for the managed gateway, so the gateway is reached exactly as the rest
   * of the account service is, including an in-process test service.
   */
  send(request: Request): Promise<Response> {
    return this.fetcher(request);
  }

  /**
   * The faux cloud answers this. A deployed Worker refuses it, and is taken to be the cloud: it
   * checks the bearer before it routes, so it answers 401 to a request without one (404 once past it).
   */
  async status(): Promise<{ backend: 'faux' | 'cloud'; label: string | null }> {
    try {
      const answer = await this.call<{ backend: string; label: string }>('GET', '/faux/status');
      return { backend: answer.backend === 'faux' ? 'faux' : 'cloud', label: answer.label };
    } catch (error) {
      if (error instanceof ControlPlaneError && (error.status === 401 || error.status === 404)) return { backend: 'cloud', label: null };
      throw error;
    }
  }

  signUp(input: { name: string; email: string; password: string; remember: boolean }) {
    return this.call<TokenPair>('POST', '/auth/sign-up', null, input);
  }
  signIn(input: { email: string; password: string; remember: boolean }) {
    return this.call<TokenPair>('POST', '/auth/sign-in', null, input);
  }
  refresh(refreshToken: string) {
    return this.call<TokenPair>('POST', '/auth/refresh', null, { refreshToken });
  }
  async signOut(refreshToken: string) {
    await this.call<null>('POST', '/auth/sign-out', null, { refreshToken });
  }

  /** Every workspace, following the service's pages to the end. */
  async session(token: string): Promise<Omit<SessionPage, 'nextCursor'>> {
    let page = await this.call<SessionPage>('GET', '/account/session', token);
    const organizations = [...page.organizations];
    for (let guard = 0; page.nextCursor !== null && guard < 20; guard++) {
      page = await this.call<SessionPage>('GET', `/account/session?after=${encodeURIComponent(page.nextCursor)}`, token);
      organizations.push(...page.organizations);
    }
    return { person: page.person, organizations };
  }
  /**
   * Whether the account service says this token's person is active Diomedes staff. One read of the
   * session page's first page, which carries the marker. A service that leaves it out, or sends
   * anything this build does not know, says nobody is staff; the person it names is returned with
   * it so the caller can check it is the person it asked for.
   */
  async staffMarker(token: string): Promise<{ personId: string; staff: StaffMarker | null }> {
    const page = await this.call<SessionPage>('GET', '/account/session', token);
    return { personId: page.person.id, staff: readStaffMarker(page.staff) };
  }
  // --- usage the business bought outright -----------------------------------------------

  private unreadable(): never {
    throw new ControlPlaneError('The account service answered in a way this app could not read.', 502, 'unreadable_answer');
  }
  /** What the business bought outright, and what of it is held or spent. */
  async purchasedBalance(token: string, organizationId: string): Promise<PurchasedBalanceAnswer> {
    const parsed = purchasedBalanceSchema.safeParse(await this.call<unknown>('GET', `/account/organizations/${encodeURIComponent(organizationId)}/purchased-usage`, token));
    return parsed.success ? parsed.data : this.unreadable();
  }
  /** Hold some of it for the signed-in person. The service decides; the amount is a request, never a balance. */
  async holdPurchasedUsage(token: string, organizationId: string, input: { holdId: string; amountMicroUsd: number; requestDigest: string }): Promise<PurchasedHoldAnswer> {
    const parsed = purchasedHoldSchema.safeParse(await this.call<unknown>('POST', `/account/organizations/${encodeURIComponent(organizationId)}/purchased-usage/holds`, token, input));
    return parsed.success ? parsed.data : this.unreadable();
  }
  async settlePurchasedUsage(token: string, organizationId: string, input: { holdId: string; debitMicroUsd: number }): Promise<PurchasedHoldAnswer> {
    const parsed = purchasedHoldSchema.safeParse(await this.call<unknown>('POST', `/account/organizations/${encodeURIComponent(organizationId)}/purchased-usage/settlements`, token, input));
    return parsed.success ? parsed.data : this.unreadable();
  }
  async releasePurchasedUsage(token: string, organizationId: string, input: { holdId: string }): Promise<PurchasedHoldAnswer> {
    const parsed = purchasedHoldSchema.safeParse(await this.call<unknown>('POST', `/account/organizations/${encodeURIComponent(organizationId)}/purchased-usage/releases`, token, input));
    return parsed.success ? parsed.data : this.unreadable();
  }
  createOrganization(token: string, name: string) {
    return this.call<Organization>('POST', '/account/organizations', token, { name });
  }
  access(token: string, organizationId: string) {
    return this.call<AccessView>('GET', `/account/organizations/${encodeURIComponent(organizationId)}/access`, token);
  }
  admitAgent(token: string, organizationId: string, input: { surface: string; routeKind: string; rootJobId?: string | null }) {
    return this.call<AgentAdmissionAnswer>('POST', `/account/organizations/${encodeURIComponent(organizationId)}/agent-admissions`, token, input);
  }
  /** The signed-in person's own Individual access (a person's plan, not a business's). */
  personAccess(token: string) {
    return this.call<PersonAccessView>('GET', '/account/access', token);
  }
  /** Admit Personal work, or work in a project no business owns, under the person's own Individual plan. */
  admitPersonalAgent(token: string, input: { surface: string; routeKind: string; rootJobId?: string | null }) {
    return this.call<AgentAdmissionAnswer>('POST', '/account/agent-admissions', token, input);
  }
  routingPolicy(token: string) {
    return this.call<RoutingPolicyAnswer>('GET', '/account/routing-policy', token);
  }
  async individualAccount(token: string) {
    return individualAccountSchema.parse(await this.call<unknown>('POST', '/account/individual', token, {}));
  }
  async scopedRoutingPolicy(token: string, scope: AccountScope) {
    const answer = resolvedRoutingSnapshotSchema.safeParse(await this.call<unknown>('GET', `${this.scopePath(scope)}/policy`, token));
    if (!answer.success || answer.data.scope.kind !== scope.kind || answer.data.scope.id !== scope.id)
      throw new ControlPlaneError('The account service returned an unreadable routing snapshot.', 502, 'unreadable_answer');
    return answer.data;
  }
  async routingPreference(token: string, scope: AccountScope) {
    const answer = await this.call<unknown>('GET', `${this.scopePath(scope)}/preference`, token);
    return answer === null ? null : routingPreferenceSchema.parse(answer);
  }
  async acceptRoutingPreference(token: string, input: RoutingPreferenceWrite) {
    return routingPreferenceSchema.parse(await this.call<unknown>('POST', `${this.scopePath(input.scope)}/preference`, token, input));
  }
  admitScopedAgent(token: string, scope: AccountScope, input: { surface: string; routeKind: string; rootJobId?: string | null }) {
    return this.call<AgentAdmissionAnswer>('POST', `${this.scopePath(scope)}/admit`, token, input);
  }
  async scopedAccess(token: string, scope: AccountScope) {
    return scopedEntitlementSchema.parse(await this.call<unknown>('GET', `${this.scopePath(scope)}/access`, token));
  }
  private scopePath(scope: AccountScope) { return `/account/routing/${scope.kind}/${encodeURIComponent(scope.id)}`; }
  roster(token: string, organizationId: string) {
    return this.call<RosterAnswer>('GET', `/account/organizations/${encodeURIComponent(organizationId)}/roster`, token);
  }
  createInvitationCode(token: string, organizationId: string, input: { role: MemberRole; email: string | null; ttlMs: number }) {
    return this.call<{ id: string; code: string; role: MemberRole; email: string | null; expiresAt: string }>(
      'POST', `/account/organizations/${encodeURIComponent(organizationId)}/invitation-codes`, token, input);
  }
  async revokeInvitationCode(token: string, organizationId: string, id: string) {
    await this.call<null>('POST', `/account/organizations/${encodeURIComponent(organizationId)}/invitation-codes/${encodeURIComponent(id)}/revoke`, token, {});
  }
  redeemInvitationCode(token: string, code: string) {
    return this.call<{ organization: Organization; membership: Membership }>('POST', '/account/invitation-codes/redeem', token, { code });
  }
  setMember(token: string, organizationId: string, personId: string, change: { role: MemberRole; state: 'active' | 'revoked' }) {
    return this.call<Membership>('PATCH', `/account/organizations/${encodeURIComponent(organizationId)}/members/${encodeURIComponent(personId)}`, token, change);
  }

  // --- the business setup, kept for the organization (ORG-01) --------------------------

  /** The business's current setup revision. An answer this client cannot read is refused, never guessed at. */
  async organizationSetup(token: string, organizationId: string): Promise<OrganizationSetupAnswer> {
    return this.setupAnswer(await this.call<unknown>('GET', `/account/organizations/${encodeURIComponent(organizationId)}/setup`, token));
  }
  /** Save the next revision, made from `expectedRevision`. */
  async saveOrganizationSetup(token: string, organizationId: string, input: OrganizationSetupWrite): Promise<OrganizationSetupAnswer> {
    return this.setupAnswer(await this.call<unknown>('POST', `/account/organizations/${encodeURIComponent(organizationId)}/setup`, token, input));
  }
  private setupAnswer(payload: unknown): OrganizationSetupAnswer {
    const parsed = organizationSetupAnswerSchema.safeParse(payload);
    if (!parsed.success)
      throw new ControlPlaneError('The account service answered in a way this app could not read.', 502, 'unreadable_answer');
    return parsed.data;
  }

  // --- the business's records, for its owner (OPS-05) ------------------------------

  /**
   * Everything the account service keeps for the business, for its owner. Read against the
   * strict schema before anything uses it: an answer with a field this app does not know, or
   * for another business, is refused rather than written anywhere. A long history can take a
   * while to read, so this call waits up to a minute.
   */
  async organizationExport(token: string, organizationId: string): Promise<ReadOrganizationExport> {
    const payload = await this.call<unknown>(
      'GET', `/account/organizations/${encodeURIComponent(organizationId)}/export`, token, undefined, {}, 60_000);
    const parsed = organizationAccountExportSchema.safeParse(payload);
    if (!parsed.success || parsed.data.organization.id !== organizationId)
      throw new ControlPlaneError('The account service answered in a way this app could not read.', 502, 'unreadable_answer');
    return parsed.data;
  }

  // --- the phone relay (services/control-plane/src/relay) ----------------------

  /** Register this computer for phone access with the public half of its key. */
  registerRelayDevice(token: string, organizationId: string, input: { publicKey: string; label: string }) {
    return this.call<RelayRegistrationAnswer>('POST', `/relay/v1/organizations/${encodeURIComponent(organizationId)}/devices`, token, input);
  }
  /** Stop phones reaching a computer: its device record becomes a tombstone that can never connect. */
  async revokeRelayDevice(token: string, organizationId: string, deviceId: string) {
    await this.call<null>('DELETE', `/relay/v1/organizations/${encodeURIComponent(organizationId)}/devices/${encodeURIComponent(deviceId)}`, token);
  }
  /** The checks a desktop's dial runs, without opening anything: why an upgrade was refused. */
  checkRelayDesktop(token: string, organizationId: string, deviceId: string) {
    return this.call<DesktopCheckAnswer>('GET', `/relay/v1/organizations/${encodeURIComponent(organizationId)}/desktop`, token, undefined, {
      [RELAY_DEVICE_HEADER]: deviceId,
    });
  }
}
