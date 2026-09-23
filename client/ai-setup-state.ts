/**
 * What the AI setup screen says about one route, derived from the host's own
 * record and from nothing else.
 *
 * Every function here is pure. The screen renders these answers; it never
 * decides a next action, never computes its own freshness boundary, and never
 * infers an account, a version or a payment state. `EngineConnection` carries
 * the host's `nextAction`, and the one expiry rule lives in
 * `shared/connection-policy.ts`.
 *
 * Fields added with candidate binding are optional on the wire, so an older
 * status payload still renders: an absent field is read as its empty value and
 * an absent `nextAction` is read as `check-connection`, the action that asks
 * the host what is true.
 */
import type { CandidateSource, SetupAction } from '../shared/connection-policy';
import { freshness } from '../shared/connection-policy';
import type {
  EngineCandidate,
  EngineConnection,
  InstallationContext,
  SetupStage,
} from '../shared/engines';
import { SETUP_STAGES } from '../shared/engines';
import type { ExternalEngine } from '../shared/types';

/** A state the screen shows as words, never as a colour alone. */
export type StateValue = 'yes' | 'no' | 'unknown';

export interface SetupState {
  key: 'installation' | 'account' | 'models' | 'test';
  label: string;
  value: StateValue;
  text: string;
}

/** The revision this record's own verification would have to match. */
const revisionOf = (c: EngineConnection): number => c.revision ?? 0;

/**
 * A real result through this exact binding revision. A receipt for an older
 * revision is history, not proof of what is selected now.
 */
export function verified(c: EngineConnection): boolean {
  return !!c.verification && c.verification.revision === revisionOf(c);
}

/**
 * Found, compatible, signed in, holding the one account route this adapter
 * accepts, and carrying models the engine itself listed. No time enters this:
 * how old the check is governs what the screen says, not whether the account
 * exists, and `EngineService.generate()` rechecks anyway.
 *
 * A reported route issue fails this. An account on another route is a real
 * account, and offering it a default model and a paid test would be the
 * ambiguous ready presentation this screen exists to remove.
 */
export function connected(c: EngineConnection): boolean {
  return (
    c.installation === 'found' &&
    c.compatibility === 'supported' &&
    c.authentication === 'signed-in' &&
    c.models.length > 0 &&
    !c.repair &&
    !c.routeIssue
  );
}

/** The four states the audit asks for, each said in its own words. */
export function setupStates(c: EngineConnection): SetupState[] {
  // Found is not usable. A wrong-version, changed or corrupt copy is present
  // and still cannot run, and the strip says which of those it is.
  const usableInstallation =
    c.installation === 'found' && c.compatibility !== 'unsupported' && !c.repair;
  const installation: StateValue =
    c.installation === 'not-checked' ? 'unknown' : usableInstallation ? 'yes' : 'no';
  const account: StateValue =
    c.authentication === 'signed-in' ? 'yes' : c.authentication === 'signed-out' ? 'no' : 'unknown';
  const models: StateValue = c.models.length > 0 ? 'yes' : c.checkedAt === null ? 'unknown' : 'no';
  return [
    {
      key: 'installation',
      label: 'Installation',
      value: installation,
      text:
        c.installation === 'corrupt'
          ? 'Found, failed its integrity check'
          : c.installation === 'missing'
            ? 'Not found'
            : c.installation === 'not-checked'
              ? 'Not checked'
              : c.compatibility === 'unsupported'
                ? 'Found, unsupported version'
                : c.repair
                  ? 'Found, needs repair'
                  : 'Found',
    },
    {
      key: 'account',
      label: 'Account',
      value: account,
      text: account === 'yes' ? 'Detected' : account === 'no' ? 'Not detected' : 'Not checked',
    },
    {
      key: 'models',
      label: 'Models',
      value: models,
      text:
        models === 'yes'
          ? `${c.models.length} listed`
          : models === 'no'
            ? 'None listed'
            : 'Not checked',
    },
    {
      key: 'test',
      label: 'Test',
      value: verified(c) ? 'yes' : 'no',
      text: verified(c) ? 'Succeeded' : 'Not tested',
    },
  ];
}

/** The route and model a first task would be started on. */
export interface FirstTaskHandoff {
  readonly route: ExternalEngine;
  readonly model: string;
}

/**
 * Whether this route may carry the person straight into a first real task, and
 * on what.
 *
 * Every term is the host's. `verified` is its receipt against its own binding
 * revision, `ready` is the next action it derived, and `storedModel` is what
 * settings says this route is set to use — the same string the test request had
 * to name. A click that succeeded a moment ago is not consulted: reopening
 * Settings on a route the host still calls ready offers the same handoff, and a
 * binding, account route or model that has changed since the receipt offers
 * none.
 */
export function firstTaskHandoff(
  c: EngineConnection,
  storedModel: string,
): FirstTaskHandoff | null {
  if (!verified(c) || c.nextAction !== 'ready') return null;
  const receipt = c.verification!;
  if (receipt.model === '' || receipt.model !== storedModel) return null;
  if (receipt.accountRoute !== c.accountRoute) return null;
  return { route: c.engine, model: receipt.model };
}

/** What the one primary control on this card does. */
export type PrimaryIntent =
  | 'install'
  | 'choose'
  | 'check'
  | 'sign-in'
  | 'enable'
  | 'test'
  | 'none';

export interface PrimaryControl {
  action: SetupAction;
  intent: PrimaryIntent;
  label: string;
}

/**
 * The host's `nextAction`, rendered. A wrong-version, changed or corrupt
 * installation reaches `repair`, which is the same private compatible copy
 * said as the repair it is.
 */
export function primaryControl(c: EngineConnection, name: string): PrimaryControl {
  const action: SetupAction = c.nextAction ?? 'check-connection';
  switch (action) {
    case 'install':
      return { action, intent: 'install', label: 'Install compatible copy for Nectovia' };
    case 'repair':
      return { action, intent: 'install', label: 'Repair with a compatible copy for Nectovia' };
    case 'choose-installation':
      return { action, intent: 'choose', label: 'Choose an installation' };
    case 'sign-in':
      return {
        action,
        intent: 'sign-in',
        label:
          c.engine === 'oh-my-pi' ? 'Configure OpenAI API access' : `Sign in with ${name}`,
      };
    case 'enable':
      return { action, intent: 'enable', label: 'Turn on for Nectovia' };
    case 'test-connection':
      return { action, intent: 'test', label: 'Test this connection' };
    case 'ready':
      return { action, intent: 'none', label: '' };
    // An account that answered with no models, and an account on another route,
    // are both resolved in the provider's own account. What Diomedes can do is
    // look again.
    default:
      return { action, intent: 'check', label: 'Check sign-in and models' };
  }
}

/**
 * Why this route needs repair, naming the installation that changed or
 * disappeared. Diomedes never moves to another executable on its own.
 */
export function repairText(c: EngineConnection): string {
  const where = c.binding?.path ?? c.location ?? '';
  const at = where ? ` at ${where}` : '';
  switch (c.repair) {
    case 'selected-missing':
      return `The installation you chose${at} is no longer there. Nectovia will not switch to another copy on its own.`;
    case 'selected-changed':
      return `The installation you chose${at} has changed since you chose it. Nectovia will not run it until you choose again or install a compatible copy.`;
    case 'selected-unverified':
      return `The installation you chose${at} no longer passes its version and integrity checks.`;
    case 'no-reviewed-candidate':
      return 'No installation on this computer matches the version Nectovia supports.';
    case 'record-unreadable':
      return 'Nectovia cannot read which installation you chose for this service, so it will not use one. Choose an installation again. The record it could not read is kept.';
    default:
      return c.installation === 'corrupt'
        ? `The installation${at} failed its integrity check. Nectovia will not run it.`
        : '';
  }
}

/**
 * The sentence the card shows for a route that needs repair.
 *
 * `repairText` answers for the reasons this build has words for, and nothing
 * for one it does not know: a host newer than this build can name a reason
 * written after it. An empty sentence under a route that says it needs repair
 * is a card showing a problem and saying nothing about it, so this is what the
 * screen renders. It claims no knowledge of the reason — only that Diomedes
 * cannot explain this one, and what the person can do regardless.
 */
export function repairNote(c: EngineConnection): string {
  const said = repairText(c);
  if (said !== '') return said;
  return c.repair
    ? 'This installation needs attention for a reason this version of Nectovia cannot put into words. Choose an installation again, or install the compatible copy.'
    : '';
}

/** Where in a connection attempt a failure happened, in plain words. */
export function stageText(stage: SetupStage): string {
  switch (stage) {
    case 'discovery':
      return 'looking for the installation';
    case 'runtime-verification':
      return 'checking the version and integrity of the installation';
    case 'launch':
      return 'starting the tool';
    case 'local-handshake':
      return "connecting to the tool's own service on this computer";
    case 'provider-auth':
      return 'the provider checking the account';
    case 'model-list':
      return 'reading the model list';
    case 'dispatch':
      return 'sending the request';
    case 'stream':
      return 'reading the answer';
    case 'cleanup':
      return 'stopping the tool';
  }
}

/** The action that belongs to that stage. Never a blanket "sign in again". */
export function stageAction(stage: SetupStage): string {
  switch (stage) {
    case 'discovery':
    case 'runtime-verification':
      return 'Check the installation, or install the compatible copy.';
    case 'launch':
      return 'Check the installation and try again.';
    case 'local-handshake':
      return 'This is the local service the tool runs on this computer, not your provider account.';
    case 'provider-auth':
      return 'The provider refused this account for this route. Check the account this route uses.';
    case 'model-list':
      return 'Check which models this account can use, then look again.';
    case 'dispatch':
    case 'stream':
      return 'The request reached the provider and did not finish.';
    case 'cleanup':
      return 'The tool may still be running. Wait before trying this route again.';
  }
}

/**
 * How current the observation is, by the one shared rule. Exactly the TTL old
 * is stale; an unreadable or future timestamp needs a fresh check.
 */
export function checkedSentence(
  c: EngineConnection,
  nowMs: number,
  time: (value: string) => string,
): string {
  const state = freshness(c.checkedAt, nowMs);
  if (state === 'fresh') return `Checked ${time(c.checkedAt!)}`;
  if (state === 'stale') return `Checked ${time(c.checkedAt!)}. That check is no longer current.`;
  return c.checkedAt === null
    ? 'Not checked yet'
    : 'The last check carries no usable time. Check again.';
}

/**
 * The last real result through this route, kept apart from what it can do now.
 * A receipt is history and authorises nothing.
 */
export function verifiedSentence(
  c: EngineConnection,
  time: (value: string) => string,
): string {
  if (!c.verification) return 'Never verified by a real request';
  const at = time(c.verification.verifiedAt);
  return verified(c)
    ? `Last verified ${at} on ${c.verification.model}`
    : `Last verified ${at} on ${c.verification.model}, before this route changed`;
}

/** Whose installation this is. */
export function sourceText(source: CandidateSource): string {
  if (source === 'managed') return "Nectovia's private copy";
  if (source === 'manual') return 'An installation you pointed Nectovia at';
  return 'Your own installation';
}

/** Publisher provenance, said plainly and without implying a verdict on the tool. */
export function provenanceText(provenance: EngineCandidate['provenance']): string {
  return provenance === 'reviewed-release'
    ? 'Nectovia verified these bytes against the release it pinned.'
    : 'Your own copy; Nectovia did not verify its publisher.';
}

/** A WSL copy and a desktop application are named as what they are. */
export function contextText(context: InstallationContext): string {
  if (context === 'wsl') return 'WSL';
  if (context === 'desktop-app') return 'Desktop application';
  if (context === 'posix-native') return 'Command line';
  return 'Windows command line';
}

export function compatibilityText(value: EngineCandidate['compatibility']): string {
  if (value === 'supported') return 'Supported version';
  if (value === 'unsupported') return 'Unsupported version';
  return 'Version not confirmed';
}

/**
 * Show the installations when there is a choice to make: more than one, a
 * recommendation nothing has bound yet, or a binding that needs repair.
 */
export function showsCandidates(c: EngineConnection): boolean {
  const candidates = c.candidates ?? [];
  if (candidates.length > 1) return true;
  if (c.repair) return candidates.length > 0;
  return candidates.length > 0 && !c.binding && !!c.recommendedCandidateId;
}

/**
 * What a route issue means: the tool answered and reported accounts, and this
 * adapter accepts exactly one of them. It never says the person is signed out
 * and never tells them to buy anything.
 */
export function routeIssueSentences(c: EngineConnection, name: string): string[] {
  if (!c.routeIssue) return [];
  const connected = c.routeIssue.connected;
  return [
    connected.length > 0
      ? `${name} reported ${connected.join(', ')}.`
      : `${name} reported no account this adapter accepts.`,
    `This route uses ${c.routeIssue.required} only. Other accounts you hold are not used here, and Nectovia does not switch to one of them.`,
  ];
}

/**
 * A native sign-in window Diomedes opened, from this screen's side.
 *
 * The host owns the window and runs its own sign-in and model check when the
 * window ends, so the screen only waits. A window that closed is never read as
 * an account: `'checking'` lasts until the host's check has written a newer
 * `checkedAt` than the moment this wait began, or until the wait times out, and
 * only then does the card go back to saying what the record says.
 *
 * `'unconfirmed'` is a wait that spent its budget without an answer. It is not
 * `'idle'`: the card takes its controls back, and it also says so, because a
 * wait that simply vanished would leave the person to guess whether the
 * sign-in worked. It is kept per route so the same window that is still open
 * cannot start the wait over on the next poll; the person's own next sign-in
 * clears it, and so does any check that answers after the wait began.
 */
export type SignInState = 'idle' | 'open' | 'checking' | 'unconfirmed';

export interface SignInWatch {
  readonly state: SignInState;
  /** When this screen first saw the window open, on its own clock. */
  readonly startedAtMs: number;
  /** When the window ended. `null` while it is still open. */
  readonly endedAtMs: number | null;
}

/** How often status is read while a window is open or its check is landing. */
export const SIGN_IN_POLL_MS = 1_000;
/**
 * How long the host's own re-check is waited for after the window ends. Time,
 * not a tick count, so an unrelated status read cannot spend the budget.
 */
export const SIGN_IN_SETTLE_MS = 4_000;
/**
 * How long a window the host reports open is waited on before the card takes
 * its controls back. A sign-in the person walked away from, a window they left
 * sitting behind another, a host that stopped answering: none of them may hide
 * this route's next action for the rest of the session.
 */
export const SIGN_IN_WINDOW_MS = 10 * 60_000;

export const NOT_SIGNING_IN: SignInWatch = { state: 'idle', startedAtMs: 0, endedAtMs: null };

/**
 * The clock's own answer, owing nothing to a payload. Every wait here is
 * bounded by time, so a status read that never succeeds — the host busy, the
 * loopback port taken, the machine asleep — spends the same budget a successful
 * one would. This is what the card folds on its timer as well as on an answer.
 */
function timedOut(watch: SignInWatch, nowMs: number): SignInWatch {
  if (watch.state === 'open')
    return nowMs - watch.startedAtMs >= SIGN_IN_WINDOW_MS
      ? { state: 'unconfirmed', startedAtMs: watch.startedAtMs, endedAtMs: watch.endedAtMs }
      : watch;
  if (watch.state !== 'checking') return watch;
  const endedAtMs = watch.endedAtMs ?? watch.startedAtMs;
  return nowMs - endedAtMs >= SIGN_IN_SETTLE_MS
    ? { state: 'unconfirmed', startedAtMs: watch.startedAtMs, endedAtMs }
    : watch;
}

/** One status answer, folded into what this route is waiting on. */
export function advanceSignIn(
  watch: SignInWatch | undefined,
  c: EngineConnection,
  nowMs: number,
): SignInWatch {
  const current = watch ?? NOT_SIGNING_IN;
  // A payload from before sign-in windows were reported says nothing about one,
  // so it neither starts nor ends a wait. It cannot hold one open either: the
  // budget is time, and the time passed whether or not this row described it.
  if (c.signInWindow === undefined) return timedOut(current, nowMs);
  if (c.signInWindow === 'running') {
    // A wait already given up on is not begun again by the same window still
    // being open. Starting over here would hide this card's next action for
    // another whole budget without the person asking for anything.
    if (current.state === 'unconfirmed') return current;
    // One start while one window stays open. A second window opened before
    // the first one's check landed begins its own wait, so that check cannot
    // settle this one and answer for a sign-in it never saw.
    const startedAtMs = current.state === 'open' ? current.startedAtMs : nowMs;
    return timedOut({ state: 'open', startedAtMs, endedAtMs: null }, nowMs);
  }
  if (current.state === 'idle') return NOT_SIGNING_IN;
  const endedAtMs = current.endedAtMs ?? nowMs;
  const observed = c.checkedAt === null ? Number.NaN : Date.parse(c.checkedAt);
  // The host's check answered after this wait began: whatever it says is now
  // what the card shows, signed in or not. This is also the one thing that
  // clears a wait that was given up on, so the line about it goes when the
  // record moves on.
  if (Number.isFinite(observed) && observed > current.startedAtMs) return NOT_SIGNING_IN;
  if (current.state === 'unconfirmed') return current;
  return timedOut({ state: 'checking', startedAtMs: current.startedAtMs, endedAtMs }, nowMs);
}

/**
 * The same fold across a whole status payload. Settled routes leave the map.
 *
 * A route the payload does not mention — and every route, when the payload is
 * the empty one a failed read leaves behind — still has the clock applied to
 * it. That is what makes this safe to run on the card's own timer: the wait
 * ends on time whether or not `GET /ai/status` ever answers again.
 */
export function advanceWatches(
  previous: Readonly<Record<string, SignInWatch>>,
  connections: readonly EngineConnection[],
  nowMs: number,
): Record<string, SignInWatch> {
  const next: Record<string, SignInWatch> = {};
  for (const [engine, watch] of Object.entries(previous))
    if (watch.state !== 'idle') next[engine] = timedOut(watch, nowMs);
  for (const c of connections) {
    const value = advanceSignIn(next[c.engine], c, nowMs);
    if (value.state === 'idle') delete next[c.engine];
    else next[c.engine] = value;
  }
  return next;
}

/**
 * A window in play suspends this card's own next action. A wait that spent its
 * budget does not: the controls come back, and the sentence below says why.
 */
export function signingIn(watch: SignInWatch | undefined): boolean {
  return watch !== undefined && (watch.state === 'open' || watch.state === 'checking');
}

/** What the card says while a window is open, while its check lands, and after. */
export function signInSentence(watch: SignInWatch | undefined, name: string): string {
  if (!watch || watch.state === 'idle') return '';
  if (watch.state === 'unconfirmed')
    return `Nectovia could not confirm the ${name} sign-in. Check it again.`;
  return watch.state === 'open'
    ? `The ${name} sign-in window is open on this computer. Finish it there, or close it.`
    : `The ${name} sign-in window closed. Nectovia is checking this service again.`;
}

/** One failed action, read from the payload the host sent with it. */
export interface AttemptFailure {
  readonly message: string;
  readonly code: string;
  readonly stage: SetupStage | null;
  readonly ambiguous: boolean;
}

export function attemptFailure(
  message: string,
  payload?: Record<string, unknown> | null,
): AttemptFailure {
  const code = typeof payload?.code === 'string' ? payload.code : '';
  const stage = payload?.stage;
  return {
    message,
    code,
    stage:
      typeof stage === 'string' && (SETUP_STAGES as readonly string[]).includes(stage)
        ? (stage as SetupStage)
        : null,
    ambiguous: payload?.ambiguous === true,
  };
}

/**
 * A check that collided with the one the host started for itself. Nothing
 * failed, so nothing is reported.
 */
export function benignConflict(failure: AttemptFailure): boolean {
  return failure.code === 'REQUEST_ACTIVE';
}

/**
 * The bound installation is not the one that was bound. That is answered among
 * the installations, never by signing in again.
 */
export function installationConflict(failure: AttemptFailure | undefined): boolean {
  return failure?.code === 'BINDING_CHANGED';
}

/**
 * Where the last attempt stopped: the stage that travelled with the error
 * first, and only then the stage the host recorded on the connection.
 */
export function attemptStage(
  failure: AttemptFailure | undefined,
  c: EngineConnection,
): { stage: SetupStage; code: string } | null {
  if (failure?.stage) return { stage: failure.stage, code: failure.code };
  return c.diagnostic ? { stage: c.diagnostic.stage, code: c.diagnostic.code } : null;
}

/** That stage, in plain words, with the action that belongs to it. */
export function attemptSentence(at: { stage: SetupStage; code: string }): string {
  const code = at.code ? ` (${at.code})` : '';
  return `The last attempt stopped while ${stageText(at.stage)}${code}. ${stageAction(at.stage)}`;
}

/** The engine ids a status payload did not mention still get a card. */
export function placeholderConnection(engine: ExternalEngine): EngineConnection {
  return {
    engine,
    installation: 'not-checked',
    compatibility: 'unknown',
    authentication: 'unknown',
    accountRoute: null,
    models: [],
    checkedAt: null,
    detail: 'Not checked yet.',
    usage: { state: 'unknown', checkedAt: null },
  };
}
