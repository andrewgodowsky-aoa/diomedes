import type { AccountWorkspaceView } from './accounts';
import type { Settings } from './types';

export const SETUP_VERSION = 2 as const;

export const SETUP_ORDER = ['welcome', 'q1', 'q2', 'q3', 'ai', 'ready', 'done'] as const;

export type SetupStep = (typeof SETUP_ORDER)[number];

/** A usable AI service: defaultEngine names a non-sample engine that is switched on. */
export function hasUsableService(settings: Settings): boolean {
  const services = settings.services;
  if (!services) return false;
  const def = services['defaultEngine'];
  if (typeof def !== 'string' || def === '' || def === 'sample') return false;
  return services[def] === true;
}

/** What the ready page says when the business this person is acting in includes the Agent. */
export const AGENT_READY_SENTENCE = 'The Nectovia Agent is ready and included with your plan.';

/**
 * Whether the business this person is acting in includes the Nectovia Agent, as the account
 * service last answered. It reads the active workspace because the Agent gate does
 * (server/accounts/agent-gate.ts): another business's plan answers nothing here. Personal, a
 * business the service has not answered for, and no account service at all are not included,
 * so the page never promises the Agent on a guess.
 */
export function activeBusinessIncludesAgent(
  settings: Settings,
  workspaces: readonly AccountWorkspaceView[] | null | undefined,
): boolean {
  const active = settings.activeWorkspace;
  if (active?.kind !== 'business' || !workspaces) return false;
  const entry = workspaces.find((workspace) => workspace.organization.id === active.organizationId);
  return entry?.access?.agent.included === true;
}

/**
 * What continuing from the AI step actually does. Three different answers, and
 * the label and the sentence say which one this is:
 *
 * - `verified`: the selected route answered one real request through the
 *   binding it still has.
 * - `untested`: a route is selected and switched on, and nothing has been sent
 *   through it. Continuing is allowed and is not a verification.
 * - `sample`: nothing usable is selected, so the app runs scripted local work.
 *
 * `hasUsableService` keeps its meaning for every other caller; this only
 * separates its `true` into the two cases the person should be able to tell
 * apart. `verifiedRoutes` are the engines whose own record carries a result
 * through their current binding revision — the screen reads that from the
 * host's record and passes the answer in, so nothing here inspects the wire.
 */
export type ContinueChoice = 'verified' | 'untested' | 'sample';

export function continueChoice(
  settings: Settings,
  verifiedRoutes: readonly string[] = [],
): ContinueChoice {
  if (!hasUsableService(settings)) return 'sample';
  const def = settings.services?.['defaultEngine'];
  return typeof def === 'string' && verifiedRoutes.includes(def) ? 'verified' : 'untested';
}

export function continueLabel(choice: ContinueChoice): string {
  if (choice === 'verified') return 'Continue';
  return choice === 'untested' ? 'Continue without testing' : 'Continue with the local sample';
}

/** The one sentence beside that control. Never a claim the sample verified anything. */
export function continueNote(choice: ContinueChoice): string {
  if (choice === 'verified') return 'Nectovia will use the service you tested.';
  return choice === 'untested'
    ? 'This connection has not answered a real request yet.'
    : 'Sample work is scripted on this computer. It is not proof that a provider answered.';
}

/**
 * Bring stored settings onto setup version 2 without changing what the
 * person chose. Permissions (especially false), services, work, detail,
 * familiarity, resumeAt and completedAt are preserved verbatim. No discovery
 * is consented to and no permission is increased here.
 */
export function migrateOnboarding(settings: Settings): Settings {
  const onboarding = {
    ...settings.onboarding,
    setupVersion: SETUP_VERSION,
    discoveryConsentAt: settings.onboarding.discoveryConsentAt ?? null,
    aiSkipped: settings.onboarding.aiSkipped ?? false,
  } as Settings['onboarding'];
  return {
    ...settings,
    onboarding,
    permissions: { ...settings.permissions },
    services: settings.services ? { ...settings.services } : settings.services,
  };
}

/**
 * Move one step forward in the decoupled setup flow. Familiarity is retained
 * legacy data and never changes approvals or detail. Permissions, services,
 * surface and everything else are preserved; only the step advances, with
 * narrow explicit defaults:
 * - q1 fills a missing work purpose with 'mix'.
 * - q2 carries an explicit onboarding.detail onto settings.detail.
 * - ai records whether it was skipped.
 * Detail changes only on q2. Approvals change only by explicit user action
 * outside this transition.
 */
export function advanceSetup(settings: Settings, skip = false, at?: string): Settings {
  const current = settings.onboarding.resumeAt as SetupStep;
  const index = (SETUP_ORDER as readonly string[]).indexOf(current);
  if (current === 'done' || index < 0) return settings;
  const next = SETUP_ORDER[index + 1] as SetupStep;

  const onboarding = {
    ...settings.onboarding,
    setupVersion: SETUP_VERSION,
    discoveryConsentAt: settings.onboarding.discoveryConsentAt ?? null,
    aiSkipped: settings.onboarding.aiSkipped ?? false,
  } as Settings['onboarding'];

  if (current === 'q1' && (!onboarding.work || skip)) onboarding.work = 'mix';

  let detail = settings.detail;
  if (current === 'q2') {
    if (onboarding.detail == null) onboarding.detail = settings.detail ?? 'standard';
    if (onboarding.detail != null) detail = onboarding.detail;
  }

  if (current === 'ai') onboarding.aiSkipped = skip;

  onboarding.resumeAt = next;
  // A new person starts in the Conversation view. Only the first finish does
  // this; the Console's view menu and Settings change it afterwards.
  let view = settings.view;
  if (next === 'done' && !onboarding.completedAt) {
    onboarding.completedAt = at ?? new Date().toISOString();
    view = 'conversation';
  }

  return {
    ...settings,
    detail,
    ...(view === settings.view ? {} : { view }),
    onboarding,
    permissions: { ...settings.permissions },
    services: settings.services ? { ...settings.services } : settings.services,
  };
}
