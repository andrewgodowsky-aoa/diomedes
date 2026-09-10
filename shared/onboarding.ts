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
  if (next === 'done' && !onboarding.completedAt) {
    onboarding.completedAt = at ?? new Date().toISOString();
  }

  return {
    ...settings,
    detail,
    onboarding,
    permissions: { ...settings.permissions },
    services: settings.services ? { ...settings.services } : settings.services,
  };
}
