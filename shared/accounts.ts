/**
 * What the desktop's `GET /api/account` answers: who is signed in to this
 * computer, which businesses they belong to and in what role, and which
 * accounts this computer remembers.
 *
 * Account records live in the account service (the control plane). This
 * install keeps only a remembered list and, when a person chose "Keep me
 * signed in" and the operating system can protect it, their sealed sign-in.
 * It never keeps a password.
 */
import type { AccessView, AgentPlanState, RoleCapabilities } from './access.js';
import type { MemberRole } from './workspaces.js';

export const ACCOUNT_VIEW_VERSION = 1 as const;

/** Where accounts come from. `faux` is the local test service, and every screen that shows it says so. */
export interface AccountBackendView {
  kind: 'faux' | 'cloud' | 'unavailable';
  label: string;
  url: string | null;
  /** Why the service cannot be reached, when it cannot. */
  reason: string | null;
  /** How this service signs people in. `browser` is WorkOS AuthKit, in the system browser. */
  signIn: 'password' | 'browser';
  /** The faux service's demo customers, so a tester can sign in as each role. Never set for the cloud. */
  demo?: { password: string; accounts: { email: string; name: string; label: string }[] } | null;
}

export interface RememberedAccountView {
  personId: string;
  name: string;
  email: string;
  /** True when this computer holds a sealed sign-in that can resume without a password. */
  canResume: boolean;
  lastSignedInAt: string;
}

export interface AccountWorkspaceView {
  organization: { id: string; name: string };
  role: MemberRole;
  roleLabel: string;
  capabilities: RoleCapabilities;
  /** The last access the service answered for this business, or null when it could not be read. */
  access: AccessView | null;
}

/** Where a sign-in through the system browser stands, for a service that signs people in that way. */
export interface BrowserSignInView {
  /**
   * `ready`: nothing has started. `waiting`: the browser is open at the sign-in page. `accepting`: the
   * browser step is done and the app is asking the account service to accept the sign-in. `failed`:
   * the last attempt ended without a sign-in. `unavailable`: this installation cannot open one.
   */
  status: 'ready' | 'waiting' | 'accepting' | 'failed' | 'unavailable';
  /** What to tell the person; empty when there is nothing to say. */
  message: string;
}

/** Whether the sign-in screen should keep asking: a sign-in is under way and its end is not drawn yet. */
export function browserSignInPending(browser: BrowserSignInView | null): boolean {
  return browser?.status === 'waiting' || browser?.status === 'accepting';
}

/** The person's plan, as far as the free-version notice needs it. */
export interface AccountPlanView {
  agent: AgentPlanState;
  /** Where "Sign up for a plan" opens. */
  plansUrl: string;
  /** Show the free-version notice now: on the free version, and not put off or turned off. */
  notice: boolean;
}

export interface AccountStateView {
  v: typeof ACCOUNT_VIEW_VERSION;
  backend: AccountBackendView;
  /** Null when the service signs people in with a password. */
  browser: BrowserSignInView | null;
  signedIn: boolean;
  person: { id: string; name: string; email: string } | null;
  /** This sign-in is kept on this computer across restarts. */
  remember: boolean;
  /** Whether this computer can keep a sign-in at all. False on the plain development server. */
  protectedStorage: boolean;
  workspaces: AccountWorkspaceView[];
  plan: AccountPlanView;
  remembered: RememberedAccountView[];
  signedInAt: string | null;
}

/**
 * What `GET /api/account` answers from a host running without accounts. Only an embedded test
 * server does: the desktop app and the local service always turn them on. Its other routes ask
 * for no sign-in, so the app opens without one.
 */
export interface AccountsOffView {
  v: typeof ACCOUNT_VIEW_VERSION;
  off: true;
}

/** The refusal code every `/api` route answers with before anyone has signed in. */
export const SIGN_IN_REQUIRED = 'sign_in_required';
