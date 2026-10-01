/**
 * Who is signed in to this computer, and what the account service last said
 * about them.
 *
 *   <data>/accounts/remembered.json   the accounts this computer remembers
 *   <data>/accounts/plan-notice.json  each person's answer to the free-version notice
 *
 * A remembered account is a name and an email for the account chooser. When
 * the person chose "Keep me signed in" and the operating system can protect
 * it, the entry also holds their refresh token sealed by the desktop's
 * SecretBox (DPAPI on Windows, Keychain on macOS). Nothing here ever holds a
 * password, and a server started without a SecretBox (plain `npm run dev`)
 * keeps no sign-in at all: the chooser lists the account and asks for the
 * password again. There is no plaintext fallback.
 *
 * A service that signs people in through the browser (the deployed one) keeps
 * no token here at all. The WorkOS sign-in is the desktop's (a BrowserIdentity,
 * sealed in protected storage by native sign-in); its access token is the
 * bearer, renewed and ended through it.
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
  type AccountPlanView,
  type AccountStateView,
  type AccountWorkspaceView,
  type BrowserSignInView,
} from '../../shared/accounts.js';
import {
  AGENT_FEATURE,
  PLAN_NOTICE_SNOOZE_DAYS,
  PLANS_URL,
  ROLE_CAPABILITIES,
  roleLabel,
  type AccessView,
  type AgentPlanState,
  type PlanNoticeChoice,
  type StaffRole,
} from '../../shared/access.js';
import { noIndividualAccess, personIncludes, type PersonAccessView, type PersonalUsageView } from '../../shared/individual-plan.js';
import type { OrganizationSetupWrite, SetupFetchOutcome, SetupWriteOutcome } from '../../shared/organization-setup.js';
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
import { checkBrowserToken, type BrowserIdentity, type BrowserSession } from './browser-identity.js';
import { ControlPlaneError, type ControlPlaneClient, type RoutingPolicyAnswer, type TokenPair } from './client.js';
import type { BrowserSignInConfig } from './deployment.js';

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
  | { admitted: true; admissionId: string; organizationId: string | null; personId: string; planId: string | null; policyRevision: number; validUntil: string }
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

/** `GET /account/access`: the person's own Individual access. Another person's answer is no answer. */
const personAccessSchema = accessAnswerSchema.omit({ organizationId: true }).extend({ personId: z.string() });
function personAccessAnswer(answer: unknown, personId: string): PersonAccessView | null {
  const parsed = personAccessSchema.safeParse(answer);
  return parsed.success && parsed.data.personId === personId ? (answer as PersonAccessView) : null;
}

/**
 * `GET /account/usage`: the person's own Individual credits for the period in force. An answer for
 * another person, a figure for an account other than the one it names, a non-Individual plan, or a
 * period that has already ended (or not begun) is no answer: it is shown as unavailable, never as 0%.
 */
const personalUsageSchema = z.object({
  v: z.literal(1),
  personId: z.string().min(1),
  accountId: z.string().min(1).nullable(),
  usage: z.object({ state: z.enum(['loading', 'not-connected', 'unavailable', 'ready']), organizationId: z.string().min(1) }).passthrough(),
  renewal: z.object({ state: z.enum(['renewed', 'not-renewed']), nextStartsAt: z.iso.datetime(), nextEndsAt: z.iso.datetime() }).nullable(),
  checkedAt: z.iso.datetime(),
});
const personalProjectionSchema = z.object({
  organizationId: z.string().min(1),
  planId: z.enum(['individual', 'individual-agreement']),
  periodStartsAt: z.iso.datetime(),
  resetsAt: z.iso.datetime(),
}).passthrough();
function personalUsageAnswer(answer: unknown, personId: string, now: number): PersonalUsageView | null {
  const parsed = personalUsageSchema.safeParse(answer);
  if (!parsed.success || parsed.data.personId !== personId) return null;
  const view = answer as PersonalUsageView;
  if (view.usage.state !== 'ready') return view;
  const projection = personalProjectionSchema.safeParse(view.usage.projection);
  if (!projection.success || view.accountId === null || view.usage.organizationId !== view.accountId ||
      projection.data.organizationId !== view.accountId || Date.parse(projection.data.periodStartsAt) > now ||
      Date.parse(projection.data.resetsAt) <= now) return null;
  return view;
}
/** A Personal usage answer is reused for at most this long, and never past its period's end. */
const PERSONAL_USAGE_TTL_MS = 15_000;

/**
 * The fields of a `POST /account/organizations/:id/agent-admissions` answer this host reads. A
 * refusal needs its code and the sentence the person reads. An admission needs the record the
 * gateway checks, who and what it was pinned to, and a time it is good until. `{}`, a 200 that is
 * not JSON, an admission without its id or pins, a `validUntil` that is not a time, or another
 * business's admission is no answer, exactly as a failed request is.
 */
const admissionRefusalSchema = z.object({
  decision: z.object({ admitted: z.literal(false), code: z.string().min(1), reason: z.string().min(1) }),
});
const admissionGrantSchema = z.object({
  admissionId: z.string().min(1),
  decision: z.object({ admitted: z.literal(true) }),
  pins: z.object({
    organizationId: z.string().nullable(),
    personId: z.string().min(1),
    planId: z.string().nullable(),
    policyRevision: z.number().int().nonnegative(),
  }),
  validUntil: z.string().refine((value) => Number.isFinite(Date.parse(value))),
});
type AdmissionAnswer =
  | { admitted: false; code: string; reason: string }
  | { admitted: true; admissionId: string; personId: string; planId: string | null; policyRevision: number; validUntil: string };

/** The service's admission decision for this person and workspace, or null when it did not give one. */
function admissionAnswer(answer: unknown, organizationId: string | null, personId: string): AdmissionAnswer | null {
  const refused = admissionRefusalSchema.safeParse(answer);
  if (refused.success) return refused.data.decision;
  const admitted = admissionGrantSchema.safeParse(answer);
  if (!admitted.success || admitted.data.pins.organizationId !== organizationId || admitted.data.pins.personId !== personId) return null;
  const { admissionId, pins, validUntil } = admitted.data;
  return { admitted: true, admissionId, personId: pins.personId, planId: pins.planId, policyRevision: pins.policyRevision, validUntil };
}

/** Admission refusals that say the business is not paid, as opposed to unknown, unreadable or membership. */
const UNPAID_REFUSAL_CODES = new Set(['entitlement_revoked', 'entitlement_expired', 'agent_not_included']);

const UNREADABLE_ADMISSION_REASON =
  'The account service answered in a way this app could not read, so the Nectovia Agent could not confirm this business includes it. Nothing was sent.';

/**
 * The account service's own refusals because the person is not an active member of the business:
 * its `member()` and `membership()` checks (services/control-plane/src/account-service.ts), each a
 * 403 whose JSON body carries the sentence and `code: 'not_a_member'`. The code is what this host
 * reads. The sentences are the fallback for an older service that sends them without a code. Only
 * these are `not_a_member`. Any other 403 or 404 (an edge page, a Worker without the route, a proxy)
 * is the service not answering (PH-07 R3-2).
 */
export const MEMBERSHIP_REFUSALS: ReadonlySet<string> = new Set([
  'This Business workspace is unavailable to this person.',
  'Current membership could not be established.',
]);

/** Whether a failed account service request is the service's own membership refusal. */
export function refusedMembership(error: unknown): boolean {
  if (error instanceof ControlPlaneError)
    return error.status === 403 && (error.code === 'not_a_member' || MEMBERSHIP_REFUSALS.has(error.message));
  if (!(error instanceof ApiError) || error.status !== 403) return false;
  return error.details.code === 'not_a_member' || MEMBERSHIP_REFUSALS.has(error.message);
}

/** A business the service no longer lists as the person's: known, and not included. */
const NOT_A_MEMBER_REASON = 'You are no longer a member of this business, so nothing that needs its plan can start.';

/**
 * The Worker's own answer to a route it does not have. For the business setup routes it means a
 * Worker from before migration 008, which keeps no setups: the setup stays on this computer. Any
 * other 404 (an edge page, a proxy) is the service not answering.
 */
const ROUTE_NOT_FOUND = 'This account action was not found.';

/** What a failed setup read or write was, kept apart from "there is no setup". */
function setupFailure(error: unknown): Exclude<SetupFetchOutcome, { kind: 'answered' }> {
  if (!(error instanceof ApiError) && !(error instanceof ControlPlaneError))
    return { kind: 'unreachable', message: 'The account service could not be reached.' };
  const code = error instanceof ApiError ? error.details.code : error.code;
  if (error.status === 401) return { kind: 'refused', code: SIGN_IN_REQUIRED, message: error.message };
  if (refusedMembership(error)) return { kind: 'refused', code: 'not_a_member', message: error.message };
  if (typeof code === 'string' && (code === 'role_not_allowed' || code.startsWith('setup_') || code === 'invalid_setup'))
    return { kind: 'refused', code, message: error.message };
  if (error.status === 404 && (code === undefined || code === null) && error.message === ROUTE_NOT_FOUND) return { kind: 'unsupported' };
  return { kind: 'unreachable', message: error.message };
}

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
  /** The person's own Individual access. Null: not read yet, or the read failed. */
  personAccess: PersonAccessView | null;
  /** Businesses whose access read the service refused because the person is not a member. */
  notMember: Set<string>;
  policy: RoutingPolicyAnswer | null;
  /** Signed in through the browser: the bearer is the WorkOS access token, and there is no refresh token here. */
  browser: boolean;
  /** The WorkOS user a browser sign-in is for; null for a password sign-in. */
  subject: string | null;
  /** Distinguishes a newer WorkOS sign-in by the same user from a token renewal. */
  browserSessionId: string | null;
}

/** The desktop's WorkOS sign-in, and what its tokens must be for the account service. */
export interface BrowserSignIn {
  identity: BrowserIdentity;
  expect: BrowserSignInConfig;
}

const BROWSER_SENTENCES = {
  notSetUp: "Sign-in through the browser isn't set up on this installation.",
  noSafeStorage: "This computer can't keep a sign-in in protected storage, so you can't sign in here.",
  waiting: 'Finish signing in in your browser.',
  notOpened: "The browser couldn't open for sign-in. Try again.",
  notForUs: "That sign-in isn't for the Nectovia account service. Sign in again.",
  refused: "The Nectovia account service didn't accept that sign-in. Sign in again.",
  unreachable: "You're signed in with WorkOS, but the Nectovia account service didn't answer. Check the connection, then try again.",
  unchecked: "Your sign-in couldn't be checked with WorkOS just now. Check the connection, then try again.",
} as const;

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

/** Each person's answer to the free-version notice, by person id. Local to this computer. */
const planNoticeSchema = z.record(
  z.string().min(1).max(128),
  z.strictObject({ choice: z.enum(['later', 'never']), at: z.string().min(1).max(64) }),
);
type PlanNotices = z.infer<typeof planNoticeSchema>;

export class AccountSessionService {
  /** Where "Sign up for a plan" opens. The host sets it from `NECTOVIA_PLANS_URL` when that is given. */
  plansUrl: string = PLANS_URL;
  private planNotices: PlanNotices = {};
  private remembered: Remembered = empty();
  /** Token rotation replaces a saved entry without creating a different sign-in. */
  private readonly rememberedSignIns = new WeakMap<RememberedEntry, Current>();
  private current: Current | null = null;
  /** The last verified Personal usage read, for the same sign-in and access revision only. */
  private personalUsageCache: { current: Current; revision: number | null; until: number; view: PersonalUsageView } | null = null;
  /** A newer sign-in or sign-out invalidates work that is still awaiting an answer. */
  private lifecycle = 0;
  /** Forget cancels pending sign-ins for that person without cancelling another person's attempt. */
  private forgotten: { lifecycle: number; people: Set<string> } | null = null;
  private saving: Promise<void> = Promise.resolve();
  private rotating: Promise<void> | null = null;
  private readonly admissions = new Map<string, { decision: AgentDecision & { admitted: true }; until: number }>();
  private projector: (projection: AccountProjection | null) => Promise<void> = async () => {};
  private releaser: (personId: string, signedIn: boolean) => Promise<void> = async () => {};
  /** Why the last browser sign-in did not become a session, until the next attempt. */
  private browserFailure: string | null = null;
  /** Native identity changes are separate from password or resume attempts that may fail. */
  private browserChanges = 0;
  private readonly closingBrowserSessions = new Set<{ sessionId: string }>();
  private following: Promise<void> = Promise.resolve();

  constructor(
    readonly backend: AccountBackend,
    private readonly dataDir: string,
    private readonly box: SecretBox | null,
    private readonly now: () => number = Date.now,
    /** The desktop's WorkOS sign-in, for a service that signs people in through the browser. */
    private readonly browser: BrowserSignIn | null = null,
  ) {}

  private get file() {
    return path.join(this.dataDir, 'accounts', 'remembered.json');
  }
  private get planNoticeFile() {
    return path.join(this.dataDir, 'accounts', 'plan-notice.json');
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
    // A damaged answers file only brings the notice back; it never stops a sign-in.
    const notices = planNoticeSchema.safeParse(await readJson<unknown>(this.planNoticeFile, () => ({})).catch(() => ({})));
    this.planNotices = notices.success ? notices.data : {};
    // Resume the last kept sign-in silently. Any failure leaves the person signed out.
    const last = this.remembered.accounts.find((entry) => entry.personId === this.remembered.last && entry.backend === this.backendKey);
    if (last?.sealed && this.protectedStorage()) await this.resume(last.personId).catch(() => {});
    // A browser sign-in is kept by the identity itself. The session follows it from now on.
    if (this.browser) {
      this.browser.identity.onChange(() => {
        this.browserChanges++;
        this.lifecycle++;
        void this.followBrowser().catch(() => {});
      });
      await this.followBrowser().catch(() => {});
    }
  }

  private save(): Promise<void> {
    const bytes = JSON.stringify(this.remembered, null, 2);
    const next = this.saving.then(() => durableWrite(this.file, bytes));
    // A failed write reaches its caller, but must not prevent the next saved state from being written.
    this.saving = next.catch(() => {});
    return next;
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

  private assertCurrent(current: Current) {
    if (this.current !== current) throw this.signedOutError();
  }

  private assertLifecycle(lifecycle: number) {
    if (this.lifecycle !== lifecycle) throw this.signedOutError();
  }

  private assertSignIn(current: Current, lifecycle: number) {
    this.assertLifecycle(lifecycle);
    if (this.forgotten?.lifecycle === lifecycle && this.forgotten.people.has(current.personId)) throw this.signedOutError();
    if (current.browserSessionId && [...this.closingBrowserSessions].some((closing) => closing.sessionId === current.browserSessionId))
      throw this.signedOutError();
  }

  private markBrowserClosing(sessionId: string | null) {
    // Each cleanup owns its marker, even when two cleanups are ending the same native session.
    const closing = sessionId ? { sessionId } : null;
    if (closing) this.closingBrowserSessions.add(closing);
    return () => { if (closing) this.closingBrowserSessions.delete(closing); };
  }

  // --- tokens -----------------------------------------------------------------

  private async rotate(current: Current) {
    if (current.browser) return this.renewBrowser(current);
    let pair: TokenPair;
    try {
      pair = await this.backend.client.refresh(current.refreshToken);
    } catch (error) {
      this.assertCurrent(current);
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

  /** A browser sign-in's bearer, renewed through WorkOS. A session WorkOS no longer has ends here too. */
  private async renewBrowser(current: Current) {
    let session: BrowserSession | null;
    try {
      session = await this.browser!.identity.session({ fresh: true });
    } catch {
      // WorkOS could not be asked just now. The sign-in stands; this call does not go ahead.
      throw new ApiError(503, BROWSER_SENTENCES.unchecked, { code: 'unreachable' });
    }
    this.assertCurrent(current);
    const claims = session ? checkBrowserToken(session.accessToken, this.browser!.expect, this.now()) : null;
    // Ended, no longer for this service, or now a different WorkOS sign-in: this session ends.
    if (!session || !claims || claims.subject !== current.subject || claims.sessionId !== current.browserSessionId) {
      await this.end(current.personId, false, true);
      throw new ApiError(401, 'Your sign-in ended. Sign in again.', { code: SIGN_IN_REQUIRED });
    }
    current.accessToken = session.accessToken;
    current.accessExpiresAt = claims.expiresAt;
    current.refreshExpiresAt = claims.expiresAt;
  }

  /** A live access token, rotated shortly before it expires. One rotation at a time. */
  async token(): Promise<string> {
    const current = this.requireCurrent();
    if (Date.parse(current.accessExpiresAt) - this.now() > REFRESH_MARGIN_MS) return current.accessToken;
    this.rotating ??= this.rotate(current).finally(() => {
      this.rotating = null;
    });
    await this.rotating;
    this.assertCurrent(current);
    return current.accessToken;
  }

  /** Call the service as the signed-in person; one retry after a rotation when the token was refused. */
  async call<T>(action: (token: string) => Promise<T>): Promise<T> {
    const current = this.requireCurrent();
    const perform = async () => {
      const token = await this.token();
      const result = await action(token);
      this.assertCurrent(current);
      return result;
    };
    try {
      return await perform();
    } catch (error) {
      this.assertCurrent(current);
      if (error instanceof ControlPlaneError && error.status === 401) {
        current.accessExpiresAt = new Date(0).toISOString();
        try {
          return await perform();
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
    const entry: RememberedEntry = {
      backend: this.backendKey,
      personId: current.personId,
      name: current.name,
      email: current.email,
      lastSignedInAt: current.signedInAt,
      sealed,
      sealedUntil: sealed ? current.refreshExpiresAt : null,
    };
    this.rememberedSignIns.set(entry, current);
    this.remembered = {
      v: 1,
      last: current.personId,
      accounts: [entry, ...rest].slice(0, MAX_REMEMBERED),
    };
    await this.save();
  }

  // --- signing in and out -----------------------------------------------------

  private async begin(pair: TokenPair, remember: boolean, lifecycle: number) {
    this.assertLifecycle(lifecycle);
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
      personAccess: null,
      notMember: new Set(),
      policy: null,
      browser: false,
      subject: null,
      browserSessionId: null,
    };
    await this.start(current, current.remember ? pair.refreshToken : null, lifecycle);
  }

  /** Make `current` the signed-in person: read their access, remember them, tell the registry. */
  private async start(current: Current, sealedRefreshToken: string | null, lifecycle: number) {
    this.assertSignIn(current, lifecycle);
    await this.loadAccess(current);
    this.assertSignIn(current, lifecycle);
    const previous = this.current;
    if (previous && previous.personId !== current.personId) {
      // Before the previous sign-in is revoked, while the service still answers as that person.
      await this.release(previous.personId, true);
      this.assertSignIn(current, lifecycle);
      await this.revokeQuietly(previous);
    }
    this.assertSignIn(current, lifecycle);
    this.current = current;
    this.admissions.clear();
    await this.keep(current, sealedRefreshToken);
    this.assertSignIn(current, lifecycle);
    this.assertCurrent(current);
    await this.projector(this.projection('sign-in'));
  }

  async signIn(input: { email: string; password: string; remember: boolean }) {
    const lifecycle = ++this.lifecycle;
    const pair = await this.backend.client.signIn(input).catch((error) => this.refusal(error));
    await this.begin(pair, input.remember, lifecycle);
    return this.state();
  }

  async signUp(input: { name: string; email: string; password: string; remember: boolean }) {
    const lifecycle = ++this.lifecycle;
    const pair = await this.backend.client.signUp(input).catch((error) => this.refusal(error));
    await this.begin(pair, input.remember, lifecycle);
    return this.state();
  }

  /** Sign in again from this computer's sealed sign-in, without a password. */
  async resume(personId: string) {
    const lifecycle = ++this.lifecycle;
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
      this.assertLifecycle(lifecycle);
      if (error instanceof ControlPlaneError && (error.status === 401 || error.status === 403)) {
        await this.dropSeal(personId);
        throw new ApiError(409, 'That sign-in has ended. Enter the password.', { code: 'password_required' });
      }
      this.refusal(error);
    }
    await this.begin(pair, true, lifecycle);
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
    // A browser sign-in has no refresh token here: WorkOS ends it, through the identity.
    if (current.browser) return;
    try {
      await this.backend.client.signOut(current.refreshToken);
    } catch {
      // Signing out locally still happens; the service's own expiry ends the token.
    }
  }

  private async end(personId: string, revoke: boolean, deferProjection = false) {
    const current = this.current;
    if (!current || current.personId !== personId) return;
    // A failed sign-in attempt does not replace the session whose cleanup is in progress.
    if (revoke) {
      await this.release(personId, true);
      if (this.current !== current) return;
      await this.revokeQuietly(current);
    }
    if (this.current !== current) return;
    this.current = null;
    this.admissions.clear();
    // Clear this sign-in's saved state before yielding; later work may remember the same person again.
    const entry = this.entry(personId);
    if (entry) {
      entry.sealed = null;
      entry.sealedUntil = null;
    }
    if (this.remembered.last === personId) this.remembered.last = null;
    await this.save();
    const project = async () => {
      if (this.current === null) await this.projector(null);
    };
    if (deferProjection) setImmediate(() => void project().catch(() => {}));
    else await project();
  }

  async signOut() {
    ++this.lifecycle;
    const browserChanges = this.browserChanges;
    const browserSessionId = this.current?.browserSessionId ?? null;
    const finished = this.markBrowserClosing(browserSessionId);
    try {
      if (this.current) await this.end(this.current.personId, true);
      // Signing out of a browser sign-in ends the WorkOS session too, and clears the one this computer
      // keeps. While a sign-in is still in the browser, this cancels it.
      await this.signOutBrowser(browserChanges, browserSessionId);
      return this.state();
    } finally { finished(); }
  }

  private async signOutBrowser(browserChanges: number, sessionId: string | null) {
    const browser = this.browser;
    if (!browser || !this.browserMode() || this.current) return;
    while (this.browserChanges !== browserChanges) {
      // Notifications include failed attempts. Check which session is kept before ending it.
      if (!sessionId || browser.identity.status().status === 'signing-in') return;
      const observedChanges = this.browserChanges;
      const kept = await browser.identity.session();
      if (this.current || browser.identity.status().status === 'signing-in') return;
      // A notification during the read makes its answer stale, even when it kept the same session.
      if (this.browserChanges !== observedChanges) continue;
      const claims = kept ? checkBrowserToken(kept.accessToken, browser.expect, this.now()) : null;
      if (kept && claims?.sessionId !== sessionId) return;
      break;
    }
    this.browserFailure = null;
    await browser.identity.signOut().catch(() => {});
  }

  // --- signing in through the browser ------------------------------------------

  private browserMode(): boolean {
    return this.backend.view().signIn === 'browser';
  }

  /**
   * Sign in through the system browser. A WorkOS sign-in this computer already keeps is used first;
   * one the service would not take is ended, and the browser opens for a new one.
   */
  async signInWithBrowser(): Promise<AccountStateView> {
    const browser = this.browser;
    if (!browser || !this.browserMode()) throw new ApiError(409, BROWSER_SENTENCES.notSetUp, { code: 'browser_sign_in_unavailable' });
    if (this.current) return this.state();
    const lifecycle = ++this.lifecycle;
    await this.followBrowser();
    this.assertLifecycle(lifecycle);
    if (this.current || browser.identity.status().status !== 'signed-out') return this.state();
    this.browserFailure = null;
    try {
      await browser.identity.begin();
    } catch {
      this.browserFailure = BROWSER_SENTENCES.notOpened;
    }
    return this.state();
  }

  /** Follow the WorkOS sign-in, one step at a time: begin the session when it has one, end it when it has none. */
  private followBrowser(): Promise<void> {
    const lifecycle = this.lifecycle;
    const next = this.following.then(() => this.reconcileBrowser(lifecycle));
    this.following = next.catch(() => {});
    return next;
  }

  private async reconcileBrowser(lifecycle: number) {
    this.assertLifecycle(lifecycle);
    const browser = this.browser;
    if (!browser || !this.browserMode()) return;
    let session: BrowserSession | null;
    try {
      session = await browser.identity.session();
    } catch {
      // A kept sign-in that could not be renewed just now is not a sign-out.
      this.assertLifecycle(lifecycle);
      if (!this.current) this.browserFailure = BROWSER_SENTENCES.unchecked;
      return;
    }
    this.assertLifecycle(lifecycle);
    if (!session) {
      // WorkOS keeps no session here: it was signed out, from this screen or the account panel.
      if (this.current?.browser) await this.end(this.current.personId, false);
      return;
    }
    const current = this.current;
    if (current?.browser) {
      if (current.accessToken === session.accessToken) return;
      // A newer token for the same WorkOS session preserves the person and their workspace.
      const claims = checkBrowserToken(session.accessToken, browser.expect, this.now());
      if (claims && claims.subject === current.subject && claims.sessionId === current.browserSessionId) {
        current.accessToken = session.accessToken;
        current.accessExpiresAt = claims.expiresAt;
        current.refreshExpiresAt = claims.expiresAt;
        return;
      }
    }
    await this.beginBrowser(browser, session, lifecycle);
  }

  private async beginBrowser(browser: BrowserSignIn, session: BrowserSession, lifecycle: number) {
    const claims = checkBrowserToken(session.accessToken, browser.expect, this.now());
    if (!claims) {
      // Nothing is sent with a token meant for anything else. Ending it lets the next attempt start clean.
      this.browserFailure = BROWSER_SENTENCES.notForUs;
      if (this.current?.browser) await this.end(this.current.personId, false);
      this.assertLifecycle(lifecycle);
      await browser.identity.signOut().catch(() => {});
      return;
    }
    let page: Awaited<ReturnType<AccountBackend['client']['session']>>;
    try {
      page = await this.backend.client.session(session.accessToken);
    } catch (error) {
      this.assertLifecycle(lifecycle);
      if (error instanceof ControlPlaneError && (error.status === 401 || error.status === 403)) {
        // The service's refusal of this sign-in, in its own words when it has them (an unverified email).
        this.browserFailure = error.status === 403 ? error.message : BROWSER_SENTENCES.refused;
        if (this.current?.browser) await this.end(this.current.personId, false);
        this.assertLifecycle(lifecycle);
        await browser.identity.signOut().catch(() => {});
      } else if (!this.current) this.browserFailure = BROWSER_SENTENCES.unreachable;
      return;
    }
    this.assertLifecycle(lifecycle);
    this.browserFailure = null;
    await this.start(
      {
        personId: page.person.id,
        name: page.person.name,
        email: session.user.email,
        createdAt: page.person.createdAt,
        accessToken: session.accessToken,
        accessExpiresAt: claims.expiresAt,
        refreshToken: '',
        refreshExpiresAt: claims.expiresAt,
        // Kept by the identity, sealed in protected storage; nothing is sealed here.
        remember: true,
        signedInAt: this.at(),
        organizations: page.organizations,
        access: new Map(),
        personAccess: null,
        notMember: new Set(),
        policy: null,
        browser: true,
        subject: claims.subject,
        browserSessionId: claims.sessionId,
      },
      null,
      lifecycle,
    );
  }

  private browserView(): BrowserSignInView | null {
    if (!this.browserMode()) return null;
    const identity = this.browser?.identity;
    if (!identity) return { status: 'unavailable', message: BROWSER_SENTENCES.notSetUp };
    const now = identity.status();
    if (now.status === 'unavailable') return { status: 'unavailable', message: BROWSER_SENTENCES.noSafeStorage };
    if (now.status === 'signing-in') return { status: 'waiting', message: BROWSER_SENTENCES.waiting };
    const failure = this.browserFailure ?? (now.message || null);
    return failure ? { status: 'failed', message: failure } : { status: 'ready', message: '' };
  }

  /** Remove an account from this computer's chooser, signing it out first when it is the current one. */
  async forget(personId: string) {
    const entry = this.entry(personId);
    const rememberedSignIn = entry ? this.rememberedSignIns.get(entry) : undefined;
    const current = this.current?.personId === personId ? this.current : null;
    const browserChanges = this.browserChanges;
    const browserSessionId = current?.browserSessionId ?? null;
    const finished = this.markBrowserClosing(browserSessionId);
    try {
      if (this.forgotten?.lifecycle !== this.lifecycle) this.forgotten = { lifecycle: this.lifecycle, people: new Set() };
      this.forgotten.people.add(personId);
      if (current) await this.end(personId, true);
      else await this.release(personId, false);
      if (current?.browser) await this.signOutBrowser(browserChanges, browserSessionId);
      // Remove refreshes of the affected sign-in, while preserving a later sign-in by the same person.
      this.remembered.accounts = this.remembered.accounts.filter((item) =>
        item !== entry && !(rememberedSignIn && item.backend === entry?.backend && this.rememberedSignIns.get(item) === rememberedSignIn),
      );
      await this.save();
      return this.state();
    } finally { finished(); }
  }

  // --- what the service says --------------------------------------------------

  private async loadAccess(current: Current) {
    const active = current.organizations.filter((row) => row.membership.state === 'active');
    // A read that fails in transport, by status or in parsing leaves the business unanswered (null),
    // never answered as inactive: `entitlement()` reports it as `unknown` (PH-07 R3-1). The one
    // failure that is an answer is the service's own membership refusal (R3-2).
    const notMember = new Set<string>();
    const person = this.readPersonAccess(current);
    const answers = await Promise.all(
      active.map(async (row) => {
        try {
          return [row.organization.id, accessAnswer(await this.backend.client.access(current.accessToken, row.organization.id), row.organization.id)] as const;
        } catch (error) {
          if (refusedMembership(error)) notMember.add(row.organization.id);
          return [row.organization.id, null] as const;
        }
      }),
    );
    current.access = new Map(answers);
    current.personAccess = await person;
    current.notMember = notMember;
    current.policy = await this.backend.client.routingPolicy(current.accessToken).catch(() => current.policy);
    await this.resetNoticeWhilePaid(current);
  }

  /**
   * The free-version notice comes back when paid access lapses. A person who chose "Don't remind me
   * again" (or "later") while free has that answer cleared the moment their plan reads as paid, so
   * the notice is shown again whenever they are back on free, including after a restart. Only a
   * plan read as paid clears it; an unknown read never does.
   */
  private async resetNoticeWhilePaid(current: Current) {
    if (this.planOf(current) !== 'paid' || !this.planNotices[current.personId]) return;
    const { [current.personId]: _dropped, ...rest } = this.planNotices;
    this.planNotices = rest;
    await durableWrite(this.planNoticeFile, JSON.stringify(this.planNotices, null, 2));
  }

  /**
   * A business the service has just refused as not paid (access withdrawn, ended or not including
   * the Agent) is read again, so the cached plan, the account read and the default thread route
   * follow the confirmed downgrade without a manual refresh. A failed read changes nothing: a
   * network error or a 5xx is never a downgrade.
   */
  async confirmDowngrade(organizationId: string, refusalCode: string) {
    const current = this.current;
    if (!current || !UNPAID_REFUSAL_CODES.has(refusalCode)) return;
    try {
      const answer = accessAnswer(await this.backend.client.access(current.accessToken, organizationId), organizationId);
      if (answer && this.current === current) current.access.set(organizationId, answer);
      await this.resetNoticeWhilePaid(current);
    } catch {
      // The cache stays as it was.
    }
  }

  /**
   * The mirror of confirmDowngrade. A business the service has just admitted whose cached access does
   * not read as paid (a downgrade it was confirmed to have, since granted again) is read again, so the
   * cached plan and the live observation recheck follow the re-grant without a manual refresh. A
   * failed read changes nothing.
   */
  async confirmAdmitted(organizationId: string) {
    const current = this.current;
    if (!current || this.includes(organizationId)) return;
    try {
      const answer = accessAnswer(await this.backend.client.access(current.accessToken, organizationId), organizationId);
      if (answer && this.current === current) current.access.set(organizationId, answer);
      await this.resetNoticeWhilePaid(current);
    } catch {
      // The cache stays as it was.
    }
  }

  /**
   * The person's own Individual access, read beside the businesses'. A failed or unreadable read is
   * null (unknown). A service from before Individual plans answers its own "not found": none.
   */
  private async readPersonAccess(current: Current): Promise<PersonAccessView | null> {
    try {
      return personAccessAnswer(await this.backend.client.personAccess(current.accessToken), current.personId);
    } catch (error) {
      const old = (error instanceof ControlPlaneError || error instanceof ApiError) && error.status === 404 && error.message === ROUTE_NOT_FOUND;
      return old ? noIndividualAccess(current.personId, this.at()) : null;
    }
  }

  /**
   * The signed-in person's own Individual credits for the billing period in force (`GET /account/usage`).
   * Read-only, and bound to this sign-in: the service resolves the person's own account and period, and
   * an answer that names anyone or anything else is shown as unavailable. A verified answer is reused
   * briefly, never past its period's end and never across a sign-in or access change.
   */
  async personalUsage(): Promise<PersonalUsageView> {
    const current = this.requireCurrent();
    const revision = current.personAccess?.revision ?? null;
    const cached = this.personalUsageCache;
    if (cached && cached.current === current && cached.revision === revision && this.now() < cached.until) return cached.view;
    const unavailable = (reason: string): PersonalUsageView => ({ v: 1, personId: current.personId, accountId: null,
      usage: { state: 'unavailable', organizationId: current.personId, reason }, renewal: null, checkedAt: this.at() });
    let answer: unknown;
    try {
      answer = await this.call((token) => this.backend.client.personUsage(token));
    } catch (error) {
      if ((error instanceof ControlPlaneError || error instanceof ApiError) && error.status === 404 && error.message === ROUTE_NOT_FOUND)
        return unavailable('This account service does not report Personal usage yet.');
      throw error;
    }
    const view = personalUsageAnswer(answer, current.personId, this.now());
    if (!view) return unavailable('The usage answer could not be verified for your account, so it was not shown.');
    const ends = view.usage.state === 'ready' ? Date.parse(view.usage.projection.resetsAt) : Number.POSITIVE_INFINITY;
    if (this.current === current) this.personalUsageCache = { current, revision, until: Math.min(this.now() + PERSONAL_USAGE_TTL_MS, ends), view };
    return view;
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
    this.assertCurrent(current);
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
   * The signed-in person's standing as active Diomedes staff, asked of the account service now.
   * Not remembered: a person whose staff row was disabled a minute ago must stop being staff on
   * the next decision, not at the next sign-in. It says null whenever it cannot say otherwise:
   * signed out, the service unreachable or answering something unreadable, or naming a different
   * person than the one signed in here. An error never reads as staff.
   */
  async staffRole(): Promise<StaffRole | null> {
    const current = this.current;
    if (!current) return null;
    try {
      const answer = await this.call((token) => this.backend.client.staffMarker(token));
      if (this.current !== current || answer.personId !== current.personId) return null;
      return answer.staff?.role ?? null;
    } catch {
      return null;
    }
  }

  // --- usage the business bought outright (the account service is the only place that keeps it) ---

  /** What the business bought outright and what of it is held or spent, as the person signed in. */
  purchasedBalance(organizationId: string) {
    return this.call((token) => this.backend.client.purchasedBalance(token, organizationId));
  }
  /** This month's included credits for the business, as the person signed in may read them. */
  organizationUsage(organizationId: string) {
    return this.call((token) => this.backend.client.organizationUsage(token, organizationId));
  }
  /** Ask the service to hold some of it for the person signed in. Refusals arrive as ApiErrors with the service's code. */
  holdPurchased(organizationId: string, input: { holdId: string; amountMicroUsd: number; requestDigest: string }) {
    return this.call((token) => this.backend.client.holdPurchasedUsage(token, organizationId, input));
  }
  settlePurchased(organizationId: string, input: { holdId: string; debitMicroUsd: number }) {
    return this.call((token) => this.backend.client.settlePurchasedUsage(token, organizationId, input));
  }
  releasePurchased(organizationId: string, input: { holdId: string }) {
    return this.call((token) => this.backend.client.releasePurchasedUsage(token, organizationId, input));
  }
  /** Keep a hold this person made from lapsing while the work it is for is still running. */
  renewPurchased(organizationId: string, input: { holdId: string }) {
    return this.call((token) => this.backend.client.renewPurchasedUsage(token, organizationId, input));
  }

  // --- buying credits (the account service prices, takes the payment and records it) ---

  /** What an amount of credits costs, as the person signed in. */
  quoteCredits(organizationId: string, credits: number) {
    return this.call((token) => this.backend.client.quoteCredits(token, organizationId, credits));
  }
  /** Start a purchase as the person signed in: where to pay, and what for. */
  startCreditPurchase(organizationId: string, credits: number) {
    return this.call((token) => this.backend.client.startCreditPurchase(token, organizationId, credits));
  }
  readCreditPurchase(organizationId: string, purchaseId: string) {
    return this.call((token) => this.backend.client.readCreditPurchase(token, organizationId, purchaseId));
  }
  /**
   * The origin of the test service's own checkout page, when the account service is the local test one, so
   * that page may be opened too. Null for the deployed service, whose only payment page is Stripe's.
   */
  localCheckoutOrigin(): string | null {
    return this.backend.view().kind === 'faux' ? new URL(this.backend.client.base).origin : null;
  }

  // --- members' monthly credit limits (the account service keeps them; this app asks and shows) ---

  creditLimits(organizationId: string) {
    return this.call((token) => this.backend.client.creditLimits(token, organizationId));
  }
  setCreditLimit(organizationId: string, input: Parameters<ControlPlaneClient['setCreditLimit']>[2]) {
    return this.call((token) => this.backend.client.setCreditLimit(token, organizationId, input));
  }
  setCreditSettings(organizationId: string, input: Parameters<ControlPlaneClient['setCreditSettings']>[2]) {
    return this.call((token) => this.backend.client.setCreditSettings(token, organizationId, input));
  }
  myCreditUsage(organizationId: string) {
    return this.call((token) => this.backend.client.myCreditUsage(token, organizationId));
  }
  creditUsageReport(organizationId: string) {
    return this.call((token) => this.backend.client.creditUsageReport(token, organizationId));
  }
  askCreditLimit(organizationId: string, input: Parameters<ControlPlaneClient['askCreditLimit']>[2]) {
    return this.call((token) => this.backend.client.askCreditLimit(token, organizationId, input));
  }
  creditLimitRequests(organizationId: string) {
    return this.call((token) => this.backend.client.creditLimitRequests(token, organizationId));
  }
  decideCreditLimit(organizationId: string, requestId: string, input: Parameters<ControlPlaneClient['decideCreditLimit']>[3]) {
    return this.call((token) => this.backend.client.decideCreditLimit(token, organizationId, requestId, input));
  }

  /**
   * The last answer for one business. Null when the service knows nothing of it here. State
   * `unknown` only when the service has not answered for a business the person is an active member
   * of. A membership the service lists as not active is an answer, and so is its own membership
   * refusal of the access read; both read as not included.
   */
  entitlement(organizationId: string): EntitlementView | null {
    const current = this.current;
    const row = current?.organizations.find((item) => item.organization.id === organizationId);
    if (!current || !row) return null;
    if (row.membership.state !== 'active' || current.notMember.has(organizationId))
      return { ...NO_ENTITLEMENT_VIEW, source: 'account-service', reason: NOT_A_MEMBER_REASON };
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
    /** Null: Personal work, admitted under the person's own Individual plan. */
    organizationId: string | null;
    surface: AgentSurface;
    routeKind: AgentRouteKind;
    rootJobId: string | null;
    phase: 'admit' | 'dispatch';
  }): Promise<AgentDecision> {
    const current = this.current;
    if (!current) return { admitted: false, code: SIGN_IN_REQUIRED, reason: 'Sign in to use the Nectovia Agent.' };
    // The route kind is part of the key: a managed admission and a BYO one are different records.
    const key = `${current.personId}|${input.organizationId ?? 'personal'}|${input.surface}|${input.routeKind}|${input.rootJobId ?? ''}`;
    const cached = this.admissions.get(key);
    if (input.phase === 'dispatch' && cached && cached.until > this.now()) return cached.decision;
    let reply: unknown;
    try {
      const body = { surface: input.surface, routeKind: input.routeKind, rootJobId: input.rootJobId };
      const organizationId = input.organizationId;
      reply = await this.call((token) =>
        organizationId === null ? this.backend.client.admitPersonalAgent(token, body) : this.backend.client.admitAgent(token, organizationId, body),
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
        reason: input.organizationId === null
          ? 'The account service could not be reached, so the Nectovia Agent could not confirm your plan includes it. Nothing was sent.'
          : 'The account service could not be reached, so the Nectovia Agent could not confirm this business includes it. Nothing was sent.',
      };
    }
    const answer = admissionAnswer(reply, input.organizationId, current.personId);
    // An answer this host cannot read is not a decision: the Agent does not start, nothing is cached,
    // and the next piece of work asks again. It is not a refusal of the business either.
    if (!answer) {
      this.admissions.delete(key);
      return { admitted: false, code: 'entitlement_unknown', reason: UNREADABLE_ADMISSION_REASON };
    }
    if (!answer.admitted) {
      this.admissions.delete(key);
      if (input.organizationId !== null) await this.confirmDowngrade(input.organizationId, answer.code);
      return { admitted: false, code: answer.code, reason: answer.reason };
    }
    if (input.organizationId !== null) await this.confirmAdmitted(input.organizationId);
    const until = Math.min(Date.parse(answer.validUntil), this.now() + ADMISSION_CACHE_MAX_MS);
    const decision = {
      admitted: true as const,
      admissionId: answer.admissionId,
      organizationId: input.organizationId,
      personId: answer.personId,
      planId: answer.planId,
      policyRevision: answer.policyRevision,
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

  // --- the business setup (ORG-01) ------------------------------------------------

  /** The business's setup as the service keeps it. Every failure stays apart from "there is none". */
  async readOrganizationSetup(organizationId: string): Promise<SetupFetchOutcome> {
    if (!this.current) return { kind: 'refused', code: SIGN_IN_REQUIRED, message: 'Sign in to open this business setup.' };
    try {
      return { kind: 'answered', answer: await this.call((token) => this.backend.client.organizationSetup(token, organizationId)) };
    } catch (error) {
      return setupFailure(error);
    }
  }

  /** Save the next revision. A revision someone else saved first is a conflict, never overwritten. */
  async writeOrganizationSetup(organizationId: string, input: OrganizationSetupWrite): Promise<SetupWriteOutcome> {
    if (!this.current) return { kind: 'refused', code: SIGN_IN_REQUIRED, message: 'Sign in to change this business setup.' };
    try {
      return { kind: 'written', answer: await this.call((token) => this.backend.client.saveOrganizationSetup(token, organizationId, input)) };
    } catch (error) {
      const failure = setupFailure(error);
      if (failure.kind === 'refused' && failure.code === 'setup_conflict') return { kind: 'conflict', message: failure.message };
      return failure;
    }
  }

  // --- the business's records, for its owner (OPS-05) -------------------------------

  /** The account service's records of the business. It answers only the Business owner. */
  exportOrganization(organizationId: string) {
    return this.call((token) => this.backend.client.organizationExport(token, organizationId));
  }

  // --- the view ---------------------------------------------------------------

  /**
   * The view, for `GET /api/account`. A service named by address that has not answered is asked
   * again first, so "Try again" can reach it, and a kept browser sign-in is picked up once it does.
   */
  async read(): Promise<AccountStateView> {
    if (this.backend.view().kind === 'unavailable' && this.backend.recheck) {
      await this.backend.recheck();
      if (!this.current) await this.followBrowser().catch(() => {});
    }
    return this.state();
  }

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
      browser: this.browserView(),
      signedIn: current !== null,
      person: current ? { id: current.personId, name: current.name, email: current.email } : null,
      remember: current?.remember ?? false,
      protectedStorage: this.protectedStorage(),
      workspaces,
      plan: this.planView(),
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

  /**
   * Whether the signed-in person holds the Nectovia Agent through any subscription. A business
   * counts while the person is an active member of it and its plan includes the Agent; one whose
   * access has not been read yet makes the answer `unknown`, never `free`. The person's own
   * Individual plan counts too (2026-09-28).
   */
  agentPlan(): AgentPlanState {
    return this.planOf(this.current);
  }

  private planOf(current: Current | null): AgentPlanState {
    if (!current) return 'free';
    if (personIncludes(current.personAccess)) return 'paid';
    // The person's own plan unread is unknown, unless a business already answers paid below.
    let unknown = current.personAccess === null || current.personAccess.state === 'unknown';
    for (const row of current.organizations) {
      if (row.membership.state !== 'active' || current.notMember.has(row.organization.id)) continue;
      const access = current.access.get(row.organization.id);
      if (!access || access.state === 'unknown') unknown = true;
      else if (access.state === 'active' && access.features.includes(AGENT_FEATURE)) return 'paid';
    }
    return unknown ? 'unknown' : 'free';
  }

  /** The plan as the free-version notice reads it. */
  private planView(): AccountPlanView {
    const agent = this.agentPlan();
    const person = this.current?.personId ?? null;
    const answer = person ? this.planNotices[person] : undefined;
    const snoozed =
      answer?.choice === 'later' && Date.parse(answer.at) + PLAN_NOTICE_SNOOZE_DAYS * 86_400_000 > this.now();
    return {
      agent,
      plansUrl: this.plansUrl,
      notice: agent === 'free' && answer?.choice !== 'never' && !snoozed,
    };
  }

  /**
   * Records the signed-in person's answer to the free-version notice. "Remind me later" puts it
   * off for PLAN_NOTICE_SNOOZE_DAYS; "Don't remind me again" keeps it away for this person.
   */
  async answerPlanNotice(choice: PlanNoticeChoice): Promise<AccountStateView> {
    const current = this.requireCurrent();
    this.planNotices = { ...this.planNotices, [current.personId]: { choice, at: this.at() } };
    await durableWrite(this.planNoticeFile, JSON.stringify(this.planNotices, null, 2));
    return this.state();
  }

  /** True when the named feature is in the person's own Individual access (Personal and unlinked work). */
  personalIncludes(feature: string = AGENT_FEATURE): boolean {
    return personIncludes(this.current?.personAccess, feature as never);
  }

  /** Signed in, and the person's own Individual access has no answer yet: the admission decides. */
  personalUnknown(): boolean {
    const current = this.current;
    return current !== null && (current.personAccess === null || current.personAccess.state === 'unknown');
  }

  /**
   * The signed-in person's role in one business, as this computer last read it. Null when nobody is
   * signed in, the person is not an active member of it, or the service has not listed it. Nothing
   * here reaches the service.
   */
  roleIn(organizationId: string): MemberRole | null {
    const row = this.current?.organizations.find((item) => item.organization.id === organizationId);
    return row && row.membership.state === 'active' ? row.membership.role : null;
  }

  /** True when the named feature is in the business's current access. */
  includes(organizationId: string, feature: string = AGENT_FEATURE): boolean {
    const access = this.current?.access.get(organizationId);
    return access?.state === 'active' && access.features.includes(feature as never);
  }
}
