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
import type { PersonAccessView, PersonalUsageView } from '../../shared/individual-plan.js';
import type { OrganizationSetupAnswer, OrganizationSetupWrite } from '../../shared/organization-setup.js';
import type { UsageState } from '../../shared/managed-usage.js';
import type { Membership, MemberRole, Organization, Person } from '../../shared/workspaces.js';
import {
  CREDIT_PURCHASE_MAX_CREDITS,
  CREDIT_PURCHASE_MIN_CREDITS,
  type CreditPurchaseStarted,
  type CreditPurchaseStatus,
  type CreditQuote,
} from '../../shared/credit-purchases.js';
import { RELAY_DEVICE_HEADER } from '../../services/control-plane/src/relay/protocol.js';
import type { DesktopCheckAnswer } from '../../services/control-plane/src/relay/service.js';
import { organizationSetupAnswerSchema } from '../../services/control-plane/src/organization-setup/schema.js';
import { organizationAccountExportSchema, type ReadOrganizationExport } from '../../services/control-plane/src/organization-export/schema.js';
import { individualAccountSchema, resolvedRoutingSnapshotSchema, routingPreferenceSchema,
  type AccountScope, type RoutingPreferenceWrite } from '../../shared/routing-policy.js';
import { escalationViewSchema } from '../../shared/escalation-controls.js';
import { checkInSettingsView, checkInView, keepGoingAnswer, type SetCheckInOverrideInput } from '../../shared/job-check-ins.js';

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
  createdAt: z.string(), resolvedAt: z.string().nullable(),
  // When the hold lets go on its own unless it is renewed. The service's clock, never this app's.
  leaseUntil: z.iso.datetime(),
  balance: purchasedBalanceSchema,
});
export type PurchasedBalanceAnswer = z.infer<typeof purchasedBalanceSchema>;

/**
 * What the account service answers for a business's included month: the usage projection, or a plain
 * state that carries no figures. The figures are read against their shape, because a bar is drawn from them.
 */
const usageMicro = z.number().int().nonnegative();
const usageProjectionSchema = z.object({
  v: z.literal(1), organizationId: z.string().min(1), periodId: z.string().min(1), planId: z.string().min(1),
  periodStartsAt: z.iso.datetime(), resetsAt: z.iso.datetime(),
  grantedMicroUsd: usageMicro, settledMicroUsd: usageMicro, pendingMicroUsd: usageMicro, uncertainMicroUsd: usageMicro,
  correctionsMicroUsd: usageMicro, correctionWithdrawalsMicroUsd: usageMicro, availableMicroUsd: usageMicro, overspentMicroUsd: usageMicro,
  reconciliation: z.string().nullable(), usedPercent: z.number().finite().nullable(),
  topUp: z.object({ availableMicroUsd: usageMicro, heldMicroUsd: usageMicro, settledThisPeriodMicroUsd: usageMicro }),
  lastReceipt: z.object({}).passthrough().nullable(), observedAt: z.iso.datetime(), rateCardVersion: z.string(),
}).passthrough();
const organizationUsageSchema = z.union([
  z.object({ state: z.literal('loading'), organizationId: z.string().min(1) }),
  z.object({ state: z.enum(['not-connected', 'unavailable']), organizationId: z.string().min(1), reason: z.string() }),
  z.object({ state: z.literal('ready'), organizationId: z.string().min(1), projection: usageProjectionSchema }),
]);
export type PurchasedHoldAnswer = z.infer<typeof purchasedHoldSchema>;

/**
 * Buying credits. A quote, a purchase just started and a purchase as it stands, each read against its exact
 * shape: money is on them, and a link the person's machine may be sent to open. The link itself is judged
 * where it is used (shared/credit-purchases.ts), never trusted for arriving in a well-formed answer.
 */
const purchaseIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);
const creditsSchema = z.number().int().min(CREDIT_PURCHASE_MIN_CREDITS).max(CREDIT_PURCHASE_MAX_CREDITS);
const centsSchema = z.number().int().positive().max(99_999_999);
const creditQuoteSchema = z.strictObject({ credits: creditsSchema, amountCents: centsSchema, currency: z.literal('usd') });
const creditPurchaseStartedSchema = z.strictObject({
  purchaseId: purchaseIdSchema, checkoutUrl: z.string().min(1).max(4096), credits: creditsSchema, amountCents: centsSchema,
});
const creditPurchaseStatusSchema = z.strictObject({
  purchaseId: purchaseIdSchema, credits: creditsSchema, amountCents: centsSchema, state: z.enum(['pending', 'paid', 'expired', 'failed']),
});

/**
 * What the account service answers about members' monthly credit limits (migration 014): the limits an
 * owner or admin set, a member's own usage against their own limit, who used what, and the asks for
 * more. Money is whole micro-USD, said as credits wherever a person reads it. Read against these
 * shapes, never trusted as they arrive.
 */
const microUsd = z.number().int().nonnegative();
const memberUsageSchema = z.strictObject({ usedMicroUsd: microUsd, includedMicroUsd: microUsd, purchasedMicroUsd: microUsd, heldMicroUsd: microUsd });
const limitModeSchema = z.enum(['limit', 'unlimited', 'inherit']);
const limitRequestSchema = z.strictObject({
  requestId: z.string(), personId: z.string(), kind: z.enum(['job', 'month']), jobId: z.string().nullable(),
  state: z.enum(['pending', 'approved', 'denied']), requestedAt: z.string(), decidedAt: z.string().nullable(), decidedBy: z.string().nullable(),
  extraMicroUsd: microUsd.nullable(), allowPurchased: z.boolean(), periodId: z.string().nullable(),
});
const myCreditUsageSchema = z.discriminatedUnion('state', [
  z.strictObject({ state: z.literal('hidden'), organizationId: z.string(), reason: z.string() }),
  z.strictObject({ state: z.literal('unavailable'), organizationId: z.string(), reason: z.string() }),
  z.strictObject({
    state: z.literal('ready'), organizationId: z.string(), periodId: z.string(), resetsAt: z.string(), usage: memberUsageSchema,
    limitMicroUsd: microUsd.nullable(), raisedByMicroUsd: microUsd, requests: z.array(limitRequestSchema),
  }),
]);
const creditLimitsSchema = z.strictObject({
  organizationId: z.string(), periodId: z.string(), planId: z.string().nullable(), defaultMemberLimitMicroUsd: microUsd.nullable(),
  roles: z.array(z.strictObject({ role: z.enum(['member', 'admin']), mode: limitModeSchema, limitMicroUsd: microUsd.nullable(), effectiveMicroUsd: microUsd.nullable(), source: z.enum(['role', 'default']) })),
  people: z.array(z.strictObject({ personId: z.string(), mode: limitModeSchema, limitMicroUsd: microUsd.nullable() })),
  settings: z.strictObject({ membersSeeOwnUsage: z.boolean(), adminsSeeMemberUsage: z.boolean() }),
});
const creditUsageReportSchema = z.union([
  z.strictObject({ state: z.literal('unavailable'), reason: z.string() }),
  z.strictObject({
    organizationId: z.string(), periodId: z.string(), startsAt: z.string(), resetsAt: z.string(),
    members: z.array(z.strictObject({
      personId: z.string(), role: z.enum(['owner', 'admin', 'member']).nullable(), usage: memberUsageSchema, limitMicroUsd: microUsd.nullable(),
      limitSource: z.enum(['person', 'role', 'default']), raisedByMicroUsd: microUsd,
    })),
  }),
]);
const savedLimitSchema = z.strictObject({
  tenantId: z.string(), organizationId: z.string(), subjectKind: z.enum(['role', 'person']), subjectId: z.string(), mode: limitModeSchema,
  limitMicroUsd: microUsd.nullable(), updatedBy: z.string(), updatedAt: z.string(),
});
const savedSettingsSchema = z.strictObject({
  tenantId: z.string(), organizationId: z.string(), membersSeeOwnUsage: z.boolean(), adminsSeeMemberUsage: z.boolean(), updatedBy: z.string(), updatedAt: z.string(),
});
const limitRequestsSchema = z.strictObject({ organizationId: z.string(), requests: z.array(limitRequestSchema) });
export type MemberUsageAnswer = z.infer<typeof memberUsageSchema>;
export type LimitRequestAnswer = z.infer<typeof limitRequestSchema>;
export type MyCreditUsageAnswer = z.infer<typeof myCreditUsageSchema>;
export type CreditLimitsAnswer = z.infer<typeof creditLimitsSchema>;
export type CreditUsageReportAnswer = z.infer<typeof creditUsageReportSchema>;
export type CreditLimitSubject = { kind: 'role'; role: 'member' | 'admin' } | { kind: 'person'; personId: string };

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
  /** This month's included credits for the business: what the account service says, or its plain `unavailable`. */
  async organizationUsage(token: string, organizationId: string): Promise<UsageState> {
    const parsed = organizationUsageSchema.safeParse(await this.call<unknown>('GET', `/account/organizations/${encodeURIComponent(organizationId)}/usage`, token));
    return parsed.success ? (parsed.data as unknown as UsageState) : this.unreadable();
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
  // --- members' monthly credit limits ---------------------------------------------------------
  private creditPath(organizationId: string, tail: string) {
    return `/account/organizations/${encodeURIComponent(organizationId)}/${tail}`;
  }
  /** Owners and admins: the limits set, the default under them, and who sees what. */
  async creditLimits(token: string, organizationId: string): Promise<CreditLimitsAnswer> {
    const parsed = creditLimitsSchema.safeParse(await this.call<unknown>('GET', this.creditPath(organizationId, 'credit-limits'), token));
    return parsed.success ? parsed.data : this.unreadable();
  }
  /** Set, or clear, one limit for a role or a person. The service decides who may; a figure here is the approver's, never a balance. */
  async setCreditLimit(token: string, organizationId: string, input: { subject: CreditLimitSubject; mode: 'limit' | 'unlimited' | 'inherit'; limitMicroUsd: number | null }) {
    const parsed = savedLimitSchema.safeParse(await this.call<unknown>('POST', this.creditPath(organizationId, 'credit-limits'), token, input));
    return parsed.success ? parsed.data : this.unreadable();
  }
  /** An owner: who sees what. */
  async setCreditSettings(token: string, organizationId: string, input: { membersSeeOwnUsage?: boolean; adminsSeeMemberUsage?: boolean }) {
    const parsed = savedSettingsSchema.safeParse(await this.call<unknown>('POST', this.creditPath(organizationId, 'credit-limits/settings'), token, input));
    return parsed.success ? parsed.data : this.unreadable();
  }
  /** The signed-in person's own usage against their own limit. Never the pool and never anyone else. */
  async myCreditUsage(token: string, organizationId: string): Promise<MyCreditUsageAnswer> {
    const parsed = myCreditUsageSchema.safeParse(await this.call<unknown>('GET', this.creditPath(organizationId, 'credit-usage/mine'), token));
    return parsed.success ? parsed.data : this.unreadable();
  }
  /** Owners and admins: who used what this month, by member, in micro-USD. */
  async creditUsageReport(token: string, organizationId: string): Promise<CreditUsageReportAnswer> {
    const parsed = creditUsageReportSchema.safeParse(await this.call<unknown>('GET', this.creditPath(organizationId, 'credit-usage/members'), token));
    return parsed.success ? parsed.data : this.unreadable();
  }
  /** A member asks for more, for one job or for the month. The service sizes nothing from this. */
  async askCreditLimit(token: string, organizationId: string, input: { requestId: string; kind: 'job' | 'month'; jobId: string | null }): Promise<LimitRequestAnswer> {
    const parsed = limitRequestSchema.safeParse(await this.call<unknown>('POST', this.creditPath(organizationId, 'credit-limit-requests'), token, input));
    return parsed.success ? parsed.data : this.unreadable();
  }
  /** Owners and admins see every ask; anyone else sees their own. */
  async creditLimitRequests(token: string, organizationId: string) {
    const parsed = limitRequestsSchema.safeParse(await this.call<unknown>('GET', this.creditPath(organizationId, 'credit-limit-requests'), token));
    return parsed.success ? parsed.data : this.unreadable();
  }
  /** An owner or admin approves or denies. An approval names the credits to add for a month, and may allow bought credits. */
  async decideCreditLimit(token: string, organizationId: string, requestId: string, input: { approve: boolean; extraMicroUsd?: number; allowPurchased?: boolean }): Promise<LimitRequestAnswer> {
    const parsed = limitRequestSchema.safeParse(await this.call<unknown>('POST', this.creditPath(organizationId, `credit-limit-requests/${encodeURIComponent(requestId)}/decision`), token, input));
    return parsed.success ? parsed.data : this.unreadable();
  }
  /** Keep a hold this person made: the service moves its lease forward from its own clock. */
  async renewPurchasedUsage(token: string, organizationId: string, input: { holdId: string }): Promise<PurchasedHoldAnswer> {
    const parsed = purchasedHoldSchema.safeParse(await this.call<unknown>('POST', `/account/organizations/${encodeURIComponent(organizationId)}/purchased-usage/renewals`, token, input));
    return parsed.success ? parsed.data : this.unreadable();
  }
  // --- buying credits (owner or admin; the service checks) -------------------------------

  /** What an amount of credits costs. The service prices it; this app never does. */
  async quoteCredits(token: string, organizationId: string, credits: number): Promise<CreditQuote> {
    const parsed = creditQuoteSchema.safeParse(await this.call<unknown>('GET', `/account/organizations/${encodeURIComponent(organizationId)}/credit-purchases/quote?credits=${credits}`, token));
    return parsed.success && parsed.data.credits === credits ? parsed.data : this.unreadable();
  }
  /** Start a purchase. The answer carries the payment page; whether this app may open it is for the caller to judge. */
  async startCreditPurchase(token: string, organizationId: string, credits: number): Promise<CreditPurchaseStarted> {
    const parsed = creditPurchaseStartedSchema.safeParse(await this.call<unknown>('POST', `/account/organizations/${encodeURIComponent(organizationId)}/credit-purchases`, token, { credits }));
    return parsed.success && parsed.data.credits === credits ? parsed.data : this.unreadable();
  }
  async readCreditPurchase(token: string, organizationId: string, purchaseId: string): Promise<CreditPurchaseStatus> {
    const parsed = creditPurchaseStatusSchema.safeParse(await this.call<unknown>('GET', `/account/organizations/${encodeURIComponent(organizationId)}/credit-purchases/${encodeURIComponent(purchaseId)}`, token));
    return parsed.success && parsed.data.purchaseId === purchaseId ? parsed.data : this.unreadable();
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
  /** The signed-in person's own Individual credits for the period in force. Read-only. */
  personUsage(token: string) {
    return this.call<PersonalUsageView>('GET', '/account/usage', token);
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
  /**
   * Whether work led by another model may hand work to Nectovia's tiers in this scope, and to which
   * (`shared/escalation-controls.ts`). Its own read: the routing snapshot does not carry it.
   */
  async scopedEscalation(token: string, scope: AccountScope) {
    const answer = escalationViewSchema.safeParse(await this.call<unknown>('GET', `${this.scopePath(scope)}/escalation`, token));
    if (!answer.success)
      throw new ControlPlaneError('The account service returned an unreadable escalation control.', 502, 'unreadable_answer');
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
  /** The amounts this account's jobs check in at (any member), as the account service resolved them. */
  async scopedCheckIns(token: string, scope: AccountScope) {
    const parsed = checkInView.safeParse(await this.call<unknown>('GET', `${this.scopePath(scope)}/check-ins`, token));
    return parsed.success ? parsed.data : this.unreadable();
  }
  /**
   * The person chose Keep going on a job that stopped at its check-in. The service raises that one job by
   * one more amount, for the tier it was opened under; the request names the job and the cap it stopped at.
   */
  async keepJobGoing(token: string, scope: AccountScope, input: { jobId: string; atCapMicroUsd: number }) {
    const parsed = keepGoingAnswer.safeParse(await this.call<unknown>('POST', `${this.scopePath(scope)}/check-ins/keep-going`, token, input));
    return parsed.success ? parsed.data : this.unreadable();
  }
  /** An owner or admin: the business's own check-in amounts beside what it would get without them. */
  async jobCheckInSettings(token: string, organizationId: string) {
    const parsed = checkInSettingsView.safeParse(await this.call<unknown>('GET', `/account/organizations/${encodeURIComponent(organizationId)}/job-check-ins`, token));
    return parsed.success ? parsed.data : this.unreadable();
  }
  /** An owner or admin sets the business's own amounts: a number replaces a tier's, null goes back to the default. */
  async setJobCheckIns(token: string, organizationId: string, input: SetCheckInOverrideInput) {
    const parsed = checkInSettingsView.safeParse(await this.call<unknown>('POST', `/account/organizations/${encodeURIComponent(organizationId)}/job-check-ins`, token, input));
    return parsed.success ? parsed.data : this.unreadable();
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
