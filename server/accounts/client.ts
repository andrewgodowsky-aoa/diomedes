/**
 * The desktop's client for the account service (the control plane).
 *
 * One typed class over a fetch-shaped function, so the same client talks to
 * the faux cloud in-process (tests), to the faux cloud over loopback (the
 * desktop app and the Operations app sharing one test service) and, when it
 * is configured, to the deployed Worker. The account service is the authority
 * for every answer here; the desktop caches, it never decides.
 */
import type { AccessView } from '../../shared/access.js';
import type { Membership, MemberRole, Organization, Person } from '../../shared/workspaces.js';
import { RELAY_DEVICE_HEADER } from '../../services/control-plane/src/relay/protocol.js';
import type { DesktopCheckAnswer } from '../../services/control-plane/src/relay/service.js';

export type Fetcher = (request: Request) => Promise<Response>;

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
}

export interface AgentAdmissionAnswer {
  admissionId: string;
  decision:
    | { admitted: true; planId: string | null; revision: number; validUntil: string | null }
    | { admitted: false; code: string; reason: string };
  pins: {
    organizationId: string;
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

  private async call<T>(method: string, path: string, token?: string | null, body?: unknown, extra: Record<string, string> = {}): Promise<T> {
    const headers = new Headers(extra);
    if (token) headers.set('authorization', `Bearer ${token}`);
    if (body !== undefined) headers.set('content-type', 'application/json');
    let response: Response;
    try {
      response = await this.fetcher(new Request(`${this.base}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
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

  /** The faux cloud answers this; a deployed Worker answers 404 and is taken to be the cloud. */
  async status(): Promise<{ backend: 'faux' | 'cloud'; label: string | null }> {
    try {
      const answer = await this.call<{ backend: string; label: string }>('GET', '/faux/status');
      return { backend: answer.backend === 'faux' ? 'faux' : 'cloud', label: answer.label };
    } catch (error) {
      if (error instanceof ControlPlaneError && error.status === 404) return { backend: 'cloud', label: null };
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
  createOrganization(token: string, name: string) {
    return this.call<Organization>('POST', '/account/organizations', token, { name });
  }
  access(token: string, organizationId: string) {
    return this.call<AccessView>('GET', `/account/organizations/${encodeURIComponent(organizationId)}/access`, token);
  }
  admitAgent(token: string, organizationId: string, input: { surface: string; routeKind: string; rootJobId?: string | null }) {
    return this.call<AgentAdmissionAnswer>('POST', `/account/organizations/${encodeURIComponent(organizationId)}/agent-admissions`, token, input);
  }
  routingPolicy(token: string) {
    return this.call<RoutingPolicyAnswer>('GET', '/account/routing-policy', token);
  }
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
