/**
 * Who is signed in to this computer, and what the account service last said
 * about them.
 *
 *   <data>/accounts/remembered.json   the accounts this computer remembers
 *
 * A remembered account is a name and an email for the account chooser. When
 * the person chose "Keep me signed in" and the operating system can protect
 * it, the entry also holds their refresh token sealed by the desktop's
 * SecretBox (DPAPI on Windows, Keychain on macOS). Nothing here ever holds a
 * password, and a server started without a SecretBox (plain `npm run dev`)
 * keeps no sign-in at all: the chooser lists the account and asks for the
 * password again. There is no plaintext fallback.
 *
 * The account service decides every answer. This module caches the last
 * answer for display, and the Agent admission cache holds an admitted
 * decision for at most the minute the service allows.
 */
import path from 'node:path';
import { z } from 'zod';
import {
  ACCOUNT_VIEW_VERSION,
  SIGN_IN_REQUIRED,
  type AccountStateView,
  type AccountWorkspaceView,
} from '../../shared/accounts.js';
import { AGENT_FEATURE, ROLE_CAPABILITIES, roleLabel, type AccessView } from '../../shared/access.js';
import {
  NO_ENTITLEMENT_VIEW,
  type EntitlementView,
  type MemberRole,
  type Membership,
  type Organization,
} from '../../shared/workspaces.js';
import type { SecretBox } from '../connection-secrets.js';
import { ApiError } from '../paths.js';
import { durableWrite, readJson } from '../store.js';
import type { AccountBackend } from './backend.js';
import { ControlPlaneError, type RoutingPolicyAnswer, type TokenPair } from './client.js';

/** What the workspace registry mirrors from the account service. */
export interface AccountProjection {
  backend: 'faux' | 'cloud';
  person: { id: string; name: string; createdAt: string };
  organizations: { organization: Organization; membership: Membership }[];
  /** A sign-in may choose the workspace; a refresh never moves the person. */
  reason: 'sign-in' | 'refresh';
}

export type AgentSurface = 'conversation' | 'work' | 'team' | 'loop' | 'automation' | 'ask' | 'other';
export type AgentRouteKind = 'managed' | 'byo' | 'local' | 'external-engine';

export type AgentDecision =
  | { admitted: true; admissionId: string; organizationId: string; personId: string; planId: string | null; policyRevision: number; validUntil: string }
  | { admitted: false; code: string; reason: string };

const MAX_REMEMBERED = 12;
const REFRESH_MARGIN_MS = 60_000;
const ADMISSION_CACHE_MAX_MS = 60_000;
/** The longest signing out waits for the phone relay to remove this computer's records. */
const RELEASE_WAIT_MS = 5_000;

const rememberedSchema = z.object({
  v: z.literal(1),
  last: z.string().nullable(),
  accounts: z
    .array(
      z.object({
        backend: z.string().max(300),
        personId: z.string().max(128),
        name: z.string().max(200),
        email: z.string().max(320),
        lastSignedInAt: z.string(),
        /** base64 of SecretBox.seal(refreshToken), or null when this computer keeps no sign-in. */
        sealed: z.string().max(90_000).nullable(),
        sealedUntil: z.string().nullable(),
      }),
    )
    .max(MAX_REMEMBERED),
});
type Remembered = z.infer<typeof rememberedSchema>;
type RememberedEntry = Remembered['accounts'][number];

/**
 * The fields of a `GET /account/organizations/:id/access` answer this host reads. A 200 that is not
 * JSON, `{}`, or another business's answer is no answer, exactly as a failed read is (PH-07 R3-1).
 */
const accessAnswerSchema = z.object({
  organizationId: z.string(),
  state: z.enum(['none', 'active', 'expired', 'revoked', 'unknown']),
  planId: z.string().nullable(),
  planLabel: z.string().nullable(),
  features: z.array(z.string()),
  agent: z.object({ included: z.boolean(), reason: z.string() }),
  validFrom: z.string().nullable(),
  validUntil: z.string().nullable(),
  revision: z.number(),
});

/** The service's answer for this business, or null when it did not give one. */
function accessAnswer(answer: unknown, organizationId: string): AccessView | null {
  const parsed = accessAnswerSchema.safeParse(answer);
  return parsed.success && parsed.data.organizationId === organizationId ? (answer as AccessView) : null;
}

/**
 * The account service's own refusals of an Agent admission because the person is not an active
 * member of the business: its `member()` and `membership()` checks
 * (services/control-plane/src/account-service.ts), each a 403 whose JSON body carries the sentence.
 * The service sends no code with them yet; `not_a_member` is accepted when it does. Only these are
 * `not_a_member`. Any other 403 or 404 (an edge page, a Worker without the route, a proxy) is the
 * service not answering (PH-07 R3-2).
 */
export const MEMBERSHIP_REFUSALS: ReadonlySet<string> = new Set([
  'This Business workspace is unavailable to this person.',
  'Current membership could not be established.',
]);

/** Whether a failed admission request is the account service's own membership refusal. */
export function refusedMembership(error: unknown): boolean {
  if (!(error instanceof ApiError) || error.status !== 403) return false;
  return error.details.code === 'not_a_member' || MEMBERSHIP_REFUSALS.has(error.message);
}

/** A business the service no longer lists as the person's: known, and not included. */
const NOT_A_MEMBER_REASON = 'You are no longer a member of this business, so nothing that needs its plan can start.';

interface Current {
  personId: string;
  name: string;
  email: string;
  createdAt: string;
  accessToken: string;
  accessExpiresAt: string;
  refreshToken: string;
  refreshExpiresAt: string;
  remember: boolean;
  signedInAt: string;
  organizations: { organization: Organization; membership: Membership }[];
  access: Map<string, AccessView | null>;
  policy: RoutingPolicyAnswer | null;
}

const empty = (): Remembered => ({ v: 1, last: null, accounts: [] });

/** Map the service's answer onto the one entitlement seam the rest of the host reads. */
export function entitlementFromAccess(access: AccessView): EntitlementView {
  const active = access.state === 'active';
  return {
    plan: access.planId ?? 'none',
    planLabel: access.planLabel,
    state: access.state,
    features: [...access.features],
    agent: access.agent.included,
    managedInference: active && access.features.includes('managed-inference'),
    validFrom: access.validFrom,
    validUntil: access.validUntil,
    revision: access.revision,
    source: 'account-service',
    reason: access.agent.included ? '' : access.agent.reason,
  };
}

export class AccountSessionService {
  private remembered: Remembered = empty();
  private current: Current | null = null;
  private rotating: Promise<void> | null = null;
  private readonly admissions = new Map<string, { decision: AgentDecision & { admitted: true }; until: number }>();
  private projector: (projection: AccountProjection | null) => Promise<void> = async () => {};
  private releaser: (personId: string, signedIn: boolean) => Promise<void> = async () => {};

  constructor(
    readonly backend: AccountBackend,
    private readonly dataDir: string,
    private readonly box: SecretBox | null,
    private readonly now: () => number = Date.now,
  ) {}

  private get file() {
    return path.join(this.dataDir, 'accounts', 'remembered.json');
  }
  private get backendKey() {
    const view = this.backend.view();
    return `${view.kind === 'unavailable' ? 'unavailable' : view.kind}:${view.url ?? 'in-process'}`;
  }
  private at() {
    return new Date(this.now()).toISOString();
  }

  /** The workspace registry's hook. Called outside any store lock. */
  onProjection(projector: (projection: AccountProjection | null) => Promise<void>) {
    this.projector = projector;
  }

  /**
   * The phone relay's hook: a person's sign-in on this computer is ending on purpose (signing out,
   * switching accounts or forgetting the account). With `signedIn` the service can still be called
   * as them. A sign-in the service ended does not call it.
   */
  onRelease(releaser: (personId: string, signedIn: boolean) => Promise<void>) {
    this.releaser = releaser;
  }

  /** Waits for the hook at most RELEASE_WAIT_MS, so a slow service never holds up signing out. */
  private async release(personId: string, signedIn: boolean) {
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([
      this.releaser(personId, signedIn).catch(() => {}),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, RELEASE_WAIT_MS);
      }),
    ]);
    clearTimeout(timer);
  }

  protectedStorage(): boolean {
    try {
      return this.box?.available() === true;
    } catch {
      return false;
    }
  }

  async init(): Promise<void> {
    const saved = await readJson<unknown>(this.file, empty);
    const parsed = rememberedSchema.safeParse(saved);
    this.remembered = parsed.success ? parsed.data : empty();
    // Resume the last kept sign-in silently. Any failure leaves the person signed out.
    const last = this.remembered.accounts.find((entry) => entry.personId === this.remembered.last && entry.backend === this.backendKey);
    if (last?.sealed && this.protectedStorage()) await this.resume(last.personId).catch(() => {});
  }

  private async save() {
    await durableWrite(this.file, JSON.stringify(this.remembered, null, 2));
  }

  // --- errors -----------------------------------------------------------------

  private refusal(error: unknown): never {
    if (error instanceof ApiError) throw error;
    if (error instanceof ControlPlaneError)
      throw new ApiError(error.status === 401 ? 401 : error.status, error.message, error.code ? { code: error.code } : {});
    throw error;
  }

  private signedOutError() {
    return new ApiError(401, 'Sign in to use Nectovia.', { code: SIGN_IN_REQUIRED });
  }

  private requireCurrent(): Current {
    if (!this.current) throw this.signedOutError();
    return this.current;
  }

  // --- tokens -----------------------------------------------------------------

  private async rotate(current: Current) {
    let pair: TokenPair;
    try {
      pair = await this.backend.client.refresh(current.refreshToken);
    } catch (error) {
      if (error instanceof ControlPlaneError && (error.status === 401 || error.status === 403)) {
        // The service ended this sign-in (signed out elsewhere, expired or revoked). A rotation can
        // run inside a locked workspace route, so the registry hears about it after this call returns.
        await this.end(current.personId, false, true);
        throw new ApiError(401, 'Your sign-in ended. Sign in again.', { code: SIGN_IN_REQUIRED });
      }
      this.refusal(error);
    }
    if (this.current !== current) return;
    current.accessToken = pair.accessToken;
    current.accessExpiresAt = pair.accessExpiresAt;
    current.refreshToken = pair.refreshToken;
    current.refreshExpiresAt = pair.refreshExpiresAt;
    // Refresh tokens rotate: the sealed copy must follow, or the next start resumes with a spent one.
    if (current.remember) await this.keep(current, pair.refreshToken);
  }

  /** A live access token, rotated shortly before it expires. One rotation at a time. */
  async token(): Promise<string> {
    const current = this.requireCurrent();
    if (Date.parse(current.accessExpiresAt) - this.now() > REFRESH_MARGIN_MS) return current.accessToken;
    this.rotating ??= this.rotate(current).finally(() => {
      this.rotating = null;
    });
    await this.rotating;
    return this.requireCurrent().accessToken;
  }

  /** Call the service as the signed-in person; one retry after a rotation when the token was refused. */
  async call<T>(action: (token: string) => Promise<T>): Promise<T> {
    const token = await this.token();
    try {
      return await action(token);
    } catch (error) {
      if (error instanceof ControlPlaneError && error.status === 401 && this.current) {
        this.current.accessExpiresAt = new Date(0).toISOString();
        try {
          return await action(await this.token());
        } catch (again) {
          this.refusal(again);
        }
      }
      this.refusal(error);
    }
  }

  // --- remembering ------------------------------------------------------------

  private entry(personId: string): RememberedEntry | undefined {
    return this.remembered.accounts.find((item) => item.personId === personId && item.backend === this.backendKey);
  }

  private async keep(current: Current, refreshToken: string | null) {
    let sealed: string | null = null;
    if (refreshToken && this.protectedStorage()) {
      try {
        sealed = this.box!.seal(refreshToken).toString('base64');
      } catch {
        sealed = null;
      }
    }
    const rest = this.remembered.accounts.filter((item) => !(item.personId === current.personId && item.backend === this.backendKey));
    this.remembered = {
      v: 1,
      last: current.personId,
      accounts: [
        {
          backend: this.backendKey,
          personId: current.personId,
          name: current.name,
          email: current.email,
          lastSignedInAt: current.signedInAt,
          sealed,
          sealedUntil: sealed ? current.refreshExpiresAt : null,
        },
        ...rest,
      ].slice(0, MAX_REMEMBERED),
    };
    await this.save();
  }

  // --- signing in and out -----------------------------------------------------

  private async begin(pair: TokenPair, remember: boolean) {
    const session = await this.backend.client.session(pair.accessToken).catch((error) => this.refusal(error));
    const current: Current = {
      personId: session.person.id,
      name: session.person.name,
      email: pair.user.email,
      createdAt: session.person.createdAt,
      accessToken: pair.accessToken,
      accessExpiresAt: pair.accessExpiresAt,
      refreshToken: pair.refreshToken,
      refreshExpiresAt: pair.refreshExpiresAt,
      remember: remember && this.protectedStorage(),
      signedInAt: this.at(),
      organizations: session.organizations,
      access: new Map(),
      policy: null,
    };
    const previous = this.current;
    if (previous && previous.personId !== current.personId) {
      // Before the previous sign-in is revoked, while the service still answers as that person.
      await this.release(previous.personId, true);
      await this.revokeQuietly(previous);
    }
    this.current = current;
    this.admissions.clear();
    await this.loadAccess(current);
    await this.keep(current, current.remember ? pair.refreshToken : null);
    await this.projector(this.projection('sign-in'));
  }

  async signIn(input: { email: string; password: string; remember: boolean }) {
    const pair = await this.backend.client.signIn(input).catch((error) => this.refusal(error));
    await this.begin(pair, input.remember);
    return this.state();
  }

  async signUp(input: { name: string; email: string; password: string; remember: boolean }) {
    const pair = await this.backend.client.signUp(input).catch((error) => this.refusal(error));
    await this.begin(pair, input.remember);
    return this.state();
  }

  /** Sign in again from this computer's sealed sign-in, without a password. */
  async resume(personId: string) {
    const entry = this.entry(personId);
    if (!entry) throw new ApiError(404, 'This computer does not remember that account.', { code: 'unknown_account' });
    if (!entry.sealed || !this.protectedStorage())
      throw new ApiError(409, 'Enter the password for this account.', { code: 'password_required' });
    let refreshToken: string;
    try {
      refreshToken = this.box!.open(Buffer.from(entry.sealed, 'base64'));
    } catch {
      await this.dropSeal(personId);
      throw new ApiError(409, 'This computer could not open the kept sign-in. Enter the password.', { code: 'password_required' });
    }
    let pair: TokenPair;
    try {
      pair = await this.backend.client.refresh(refreshToken);
    } catch (error) {
      if (error instanceof ControlPlaneError && (error.status === 401 || error.status === 403)) {
        await this.dropSeal(personId);
        throw new ApiError(409, 'That sign-in has ended. Enter the password.', { code: 'password_required' });
      }
      this.refusal(error);
    }
    await this.begin(pair, true);
    return this.state();
  }

  private async dropSeal(personId: string) {
    const entry = this.entry(personId);
    if (!entry?.sealed) return;
    entry.sealed = null;
    entry.sealedUntil = null;
    await this.save();
  }

  private async revokeQuietly(current: Current) {
    try {
      await this.backend.client.signOut(current.refreshToken);
    } catch {
      // Signing out locally still happens; the service's own expiry ends the token.
    }
  }

  private async end(personId: string, revoke: boolean, deferProjection = false) {
    const current = this.current;
    if (current && current.personId === personId) {
      if (revoke) {
        await this.release(personId, true);
        await this.revokeQuietly(current);
      }
      this.current = null;
      this.admissions.clear();
    }
    await this.dropSeal(personId);
    if (this.remembered.last === personId) {
      this.remembered.last = null;
      await this.save();
    }
    if (deferProjection) setImmediate(() => void this.projector(null).catch(() => {}));
    else await this.projector(null);
  }

  async signOut() {
    if (this.current) await this.end(this.current.personId, true);
    return this.state();
  }

  /** Remove an account from this computer's chooser, signing it out first when it is the current one. */
  async forget(personId: string) {
    if (this.current?.personId === personId) await this.end(personId, true);
    else await this.release(personId, false);
    this.remembered.accounts = this.remembered.accounts.filter((item) => !(item.personId === personId && item.backend === this.backendKey));
    await this.save();
    return this.state();
  }

  // --- what the service says --------------------------------------------------

  private async loadAccess(current: Current) {
    const active = current.organizations.filter((row) => row.membership.state === 'active');
    // A read that fails in transport, by status or in parsing leaves the business unanswered (null),
    // never answered as inactive: `entitlement()` reports it as `unknown` (PH-07 R3-1).
    const answers = await Promise.all(
      active.map(async (row) => {
        try {
          return [row.organization.id, accessAnswer(await this.backend.client.access(current.accessToken, row.organization.id), row.organization.id)] as const;
        } catch {
          return [row.organization.id, null] as const;
        }
      }),
    );
    current.access = new Map(answers);
    current.policy = await this.backend.client.routingPolicy(current.accessToken).catch(() => current.policy);
  }

  /** Read the person's businesses and access again. `project: false` leaves the registry to the caller. */
  async reload(options: { project?: boolean } = {}): Promise<AccountProjection> {
    const current = this.requireCurrent();
    const session = await this.call((token) => this.backend.client.session(token));
    if (this.current !== current) throw this.signedOutError();
    current.name = session.person.name;
    current.organizations = session.organizations;
    await this.token();
    await this.loadAccess(current);
    const projection = this.projection('refresh');
    if (options.project !== false) await this.projector(projection);
    return projection;
  }

  private projection(reason: AccountProjection['reason']): AccountProjection {
    const current = this.requireCurrent();
    const kind = this.backend.view().kind;
    return {
      backend: kind === 'cloud' ? 'cloud' : 'faux',
      person: { id: current.personId, name: current.name, createdAt: current.createdAt },
      organizations: current.organizations.map((row) => ({ organization: { ...row.organization }, membership: { ...row.membership } })),
      reason,
    };
  }

  signedIn(): boolean {
    return this.current !== null;
  }

  personId(): string | null {
    return this.current?.personId ?? null;
  }

  /**
   * The last answer for one business. Null when the service knows nothing of it here. State
   * `unknown` only when the service has not answered for a business the person is an active member
   * of; a membership the service lists as not active is an answer, and reads as not included.
   */
  entitlement(organizationId: string): EntitlementView | null {
    const current = this.current;
    const row = current?.organizations.find((item) => item.organization.id === organizationId);
    if (!current || !row) return null;
    if (row.membership.state !== 'active') return { ...NO_ENTITLEMENT_VIEW, source: 'account-service', reason: NOT_A_MEMBER_REASON };
    const access = current.access.get(organizationId);
    if (!access)
      return {
        ...NO_ENTITLEMENT_VIEW,
        state: 'unknown',
        reason: 'The account service has not answered for this business yet. Nothing that needs a plan can start until it does.',
      };
    return entitlementFromAccess(access);
  }

  policy(): RoutingPolicyAnswer | null {
    return this.current?.policy ?? null;
  }

  /**
   * Ask the service for its published tier policy again, once. The last answer stays when the
   * service cannot say; signed out, there is none.
   */
  async refreshPolicy(): Promise<RoutingPolicyAnswer | null> {
    const current = this.current;
    if (!current) return null;
    const answer = await this.call((token) => this.backend.client.routingPolicy(token)).catch(() => null);
    if (answer && this.current === current) current.policy = answer;
    return this.current?.policy ?? null;
  }

  async createOrganization(name: string) {
    const organization = await this.call((token) => this.backend.client.createOrganization(token, name));
    return { organizationId: organization.id, projection: await this.reload({ project: false }) };
  }

  /**
   * One Agent admission. The `admit` phase always asks the service, so every new
   * piece of work is recorded against what it was pinned to. The `dispatch`
   * phase reuses an admitted decision for the same work while it is fresh.
   * With no answer from the service, the Agent does not start.
   */
  async admitAgent(input: {
    organizationId: string;
    surface: AgentSurface;
    routeKind: AgentRouteKind;
    rootJobId: string | null;
    phase: 'admit' | 'dispatch';
  }): Promise<AgentDecision> {
    if (!this.current) return { admitted: false, code: SIGN_IN_REQUIRED, reason: 'Sign in to use the Nectovia Agent.' };
    // The route kind is part of the key: a managed admission and a BYO one are different records.
    const key = `${this.current.personId}|${input.organizationId}|${input.surface}|${input.routeKind}|${input.rootJobId ?? ''}`;
    const cached = this.admissions.get(key);
    if (input.phase === 'dispatch' && cached && cached.until > this.now()) return cached.decision;
    let answer;
    try {
      answer = await this.call((token) =>
        this.backend.client.admitAgent(token, input.organizationId, {
          surface: input.surface,
          routeKind: input.routeKind,
          rootJobId: input.rootJobId,
        }),
      );
    } catch (error) {
      this.admissions.delete(key);
      if (error instanceof ApiError && error.status === 401)
        return { admitted: false, code: SIGN_IN_REQUIRED, reason: error.message };
      // Only the service's own membership refusal says the person is not a member. A bare 403 or 404
      // (an edge page, a Worker without this route) is the service not answering, below (PH-07 R3-2).
      if (refusedMembership(error))
        return { admitted: false, code: 'not_a_member', reason: 'You are not a member of this business, so the Nectovia Agent cannot work for it.' };
      return {
        admitted: false,
        code: 'entitlement_unknown',
        reason: 'The account service could not be reached, so the Nectovia Agent could not confirm this business includes it. Nothing was sent.',
      };
    }
    if (!answer.decision.admitted) {
      this.admissions.delete(key);
      return { admitted: false, code: answer.decision.code, reason: answer.decision.reason };
    }
    const until = Math.min(Date.parse(answer.validUntil), this.now() + ADMISSION_CACHE_MAX_MS);
    const decision = {
      admitted: true as const,
      admissionId: answer.admissionId,
      organizationId: input.organizationId,
      personId: answer.pins.personId,
      planId: answer.pins.planId,
      policyRevision: answer.pins.policyRevision,
      validUntil: new Date(until).toISOString(),
    };
    this.admissions.set(key, { decision, until });
    return decision;
  }

  // --- people -----------------------------------------------------------------

  roster(organizationId: string) {
    return this.call((token) => this.backend.client.roster(token, organizationId));
  }
  createInvitationCode(organizationId: string, input: { role: MemberRole; email: string | null; ttlMs: number }) {
    return this.call((token) => this.backend.client.createInvitationCode(token, organizationId, input));
  }
  revokeInvitationCode(organizationId: string, id: string) {
    return this.call((token) => this.backend.client.revokeInvitationCode(token, organizationId, id));
  }
  async redeemInvitationCode(code: string) {
    const joined = await this.call((token) => this.backend.client.redeemInvitationCode(token, code));
    await this.reload();
    return joined;
  }
  async setMember(organizationId: string, personId: string, change: { role: MemberRole; state: 'active' | 'revoked' }) {
    const membership = await this.call((token) => this.backend.client.setMember(token, organizationId, personId, change));
    if (personId === this.current?.personId) await this.reload();
    return membership;
  }

  // --- the view ---------------------------------------------------------------

  state(): AccountStateView {
    const current = this.current;
    const workspaces: AccountWorkspaceView[] = (current?.organizations ?? [])
      .filter((row) => row.membership.state === 'active')
      .map((row) => ({
        organization: { id: row.organization.id, name: row.organization.name },
        role: row.membership.role,
        roleLabel: roleLabel(row.membership.role),
        capabilities: ROLE_CAPABILITIES[row.membership.role],
        access: current!.access.get(row.organization.id) ?? null,
      }));
    return {
      v: ACCOUNT_VIEW_VERSION,
      backend: this.backend.view(),
      signedIn: current !== null,
      person: current ? { id: current.personId, name: current.name, email: current.email } : null,
      remember: current?.remember ?? false,
      protectedStorage: this.protectedStorage(),
      workspaces,
      remembered: this.remembered.accounts
        .filter((item) => item.backend === this.backendKey)
        .map((item) => ({
          personId: item.personId,
          name: item.name,
          email: item.email,
          canResume:
            item.sealed !== null &&
            this.protectedStorage() &&
            (item.sealedUntil === null || Date.parse(item.sealedUntil) > this.now()),
          lastSignedInAt: item.lastSignedInAt,
        })),
      signedInAt: current?.signedInAt ?? null,
    };
  }

  /** True when the named feature is in the business's current access. */
  includes(organizationId: string, feature: string = AGENT_FEATURE): boolean {
    const access = this.current?.access.get(organizationId);
    return access?.state === 'active' && access.features.includes(feature as never);
  }
}
