/**
 * Subscription workers at the host (subscription-aware orchestration S3).
 *
 * The preference lives in this computer's settings (`Settings.subscriptionWorkers`) and is
 * written only through `save`, never by `PUT /api/settings`. For one start, `choice` reads it
 * together with the signed-in person and the project's owner. It admits nothing and sends
 * nothing: each tool's own admission happens at the start route, the same one a worker the
 * person names goes through.
 *
 * Off unless the build turns it on (`DIOMEDES_SUBSCRIPTION_WORKERS=1`) and the engine port is
 * attached (`DIOMEDES_EXTERNAL_WORKERS=1`). It stays off until Andrew approves the Pillar 07
 * amendment (D1).
 */
import type { AgentGatePort } from './accounts/agent-gate.js';
import { routeName } from './harness/external-worker.js';
import { ApiError } from './paths.js';
import type { Store } from './store.js';
import { NECTOVIA_ROUTE } from '../shared/model-api.js';
import {
  SUBSCRIPTION_WORKERS_CONSENT,
  SUBSCRIPTION_WORKERS_CONSENT_REVISION,
  SUBSCRIPTION_WORKERS_VERSION,
  subscriptionWorkersPreferenceSchema,
  subscriptionWorkersWriteSchema,
  type SubscriptionWorkerStartView,
  type SubscriptionWorkersPreference,
  type SubscriptionWorkersView,
} from '../shared/subscription-workers.js';
import { EXTERNAL_WORKER_ROUTES, type ExternalWorkerRoute } from '../shared/team-delegation.js';

/** What one start may use: nothing, these tools in this order, or nothing for a reason the preference gives. */
export type SubscriptionWorkerChoice =
  | { readonly kind: 'off' }
  | { readonly kind: 'candidates'; readonly preference: SubscriptionWorkersPreference; readonly engines: readonly ExternalWorkerRoute[] }
  | { readonly kind: 'unavailable'; readonly preference: SubscriptionWorkersPreference; readonly reason: string };

export interface SubscriptionWorkersDeps {
  readonly store: Store;
  /** The launch gate and the engine port, both. False: every choice is off and nothing can be saved. */
  readonly available: () => boolean;
  /** The signed-in person, or null. */
  readonly personId: () => string | null;
  /** The business that owns the project, or null for Personal work. */
  readonly projectOwner: (projectId: string) => string | null;
  readonly now?: () => number;
}

export const SUBSCRIPTION_WORKERS_UNAVAILABLE = 'Handing tasks to your own coding tools isn’t available in this build.';
const CONFIRM_AGAIN =
  'What handing tasks to your coding tools sends has changed. Confirm it again in Settings before Nectovia hands anything off.';
const NO_TOOLS = 'No coding tool is chosen for Nectovia to hand tasks to. Choose one in Settings.';

export class SubscriptionWorkers {
  constructor(private readonly deps: SubscriptionWorkersDeps) {}

  /** The stored preference, whoever saved it, or null when none is stored or it doesn't parse. */
  private stored(): SubscriptionWorkersPreference | null {
    const raw = (this.deps.store.settings as { subscriptionWorkers?: unknown }).subscriptionWorkers;
    if (raw === null || raw === undefined) return null;
    const parsed = subscriptionWorkersPreferenceSchema.safeParse(raw);
    return parsed.success ? parsed.data : null;
  }

  /** The signed-in person's own preference. Someone else's reads as none. */
  preference(): SubscriptionWorkersPreference | null {
    const person = this.deps.personId();
    const stored = this.stored();
    return person && stored?.personId === person ? stored : null;
  }

  /** What a Nectovia start in this project may use. Read only: nothing is admitted or sent. */
  choice(projectId: string): SubscriptionWorkerChoice {
    if (!this.deps.available()) return { kind: 'off' };
    const preference = this.preference();
    if (!preference?.enabled) return { kind: 'off' };
    // Personal work only (D13): a project a business owns keeps the business's own path.
    if (this.deps.projectOwner(projectId) !== null) return { kind: 'off' };
    if (preference.consentRevision !== SUBSCRIPTION_WORKERS_CONSENT_REVISION)
      return { kind: 'unavailable', preference, reason: CONFIRM_AGAIN };
    if (preference.engines.length === 0) return { kind: 'unavailable', preference, reason: NO_TOOLS };
    return { kind: 'candidates', preference, engines: preference.engines };
  }

  /**
   * What the person's own Nectovia start in this project would do, for its start dialog: the tools
   * by name in the person's order and the consent revision to echo. Read only, like `choice`, so
   * another person's preference reads as off here too.
   */
  startView(projectId: string): SubscriptionWorkerStartView {
    const choice = this.choice(projectId);
    if (choice.kind === 'off') return { kind: 'off' };
    if (choice.kind === 'unavailable') return { kind: 'unavailable', reason: choice.reason };
    return {
      kind: 'candidates',
      engines: [...choice.engines],
      names: choice.engines.map(routeName),
      consentRevision: choice.preference.consentRevision,
    };
  }

  /** The Settings view: the person's preference, what they'd agree to, the tools by name and whether this build offers it. */
  view(): SubscriptionWorkersView {
    return {
      available: this.deps.available(),
      signedIn: this.deps.personId() !== null,
      preference: this.preference(),
      consent: { revision: SUBSCRIPTION_WORKERS_CONSENT_REVISION, text: SUBSCRIPTION_WORKERS_CONSENT },
      tools: EXTERNAL_WORKER_ROUTES.map((route) => ({ route, name: routeName(route) })),
    };
  }

  /**
   * Saves the person's choice. Turning it on needs the current consent and at least one tool;
   * turning it off always works. The caller holds the store lock.
   */
  async save(body: unknown): Promise<SubscriptionWorkersPreference> {
    if (!this.deps.available()) throw new ApiError(409, SUBSCRIPTION_WORKERS_UNAVAILABLE, { code: 'subscription_workers_unavailable' });
    const person = this.deps.personId();
    if (!person) throw new ApiError(401, 'Sign in to choose how Nectovia works with your coding tools.', { code: 'sign_in_required' });
    const parsed = subscriptionWorkersWriteSchema.safeParse(body ?? {});
    if (!parsed.success)
      throw new ApiError(400, 'Choose whether it’s on, which tools to use, what to keep for yourself and what happens when none is ready.', {
        code: 'invalid_subscription_workers',
      });
    const write = parsed.data;
    if (write.enabled && write.consentRevision !== SUBSCRIPTION_WORKERS_CONSENT_REVISION)
      throw new ApiError(409, CONFIRM_AGAIN, { code: 'subscription_consent_changed', consentRevision: SUBSCRIPTION_WORKERS_CONSENT_REVISION });
    if (write.enabled && write.engines.length === 0) throw new ApiError(400, NO_TOOLS, { code: 'invalid_subscription_workers' });
    const preference: SubscriptionWorkersPreference = {
      version: SUBSCRIPTION_WORKERS_VERSION,
      personId: person,
      scope: { kind: 'personal' },
      enabled: write.enabled,
      engines: [...write.engines],
      reserve: write.reserve,
      whenUnavailable: write.whenUnavailable,
      consentRevision: write.consentRevision,
      updatedAt: new Date(this.deps.now?.() ?? Date.now()).toISOString(),
    };
    await this.deps.store.saveSettings({ ...this.deps.store.settings, subscriptionWorkers: preference });
    return preference;
  }
}

/**
 * The paid record a worker under a Nectovia lead carries (S3): an Agent admission with route kind
 * `external-engine` under the lead's job. The account service records it with no managed hold, so
 * no credit is set aside for the worker's turn. A refusal fails the worker before anything is sent:
 * a plan that ended, or one the account service can't confirm right now.
 */
export function paidWorkerAdmission(gate: AgentGatePort) {
  return async (root: { readonly route: string; readonly projectId: string; readonly rootJobId: string }) => {
    if (root.route !== NECTOVIA_ROUTE) return;
    await gate.check({ phase: 'admit', surface: 'loop', projectId: root.projectId, rootJobId: root.rootJobId, routeKind: 'external-engine' });
  };
}
