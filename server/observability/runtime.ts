/**
 * The one constructor the app calls (PH-00 contract 5.2). With the default configuration,
 * `NECTOVIA_OBSERVATION` unset, it returns null: no scope, projector or exporter exists, and
 * nothing in the runtime changes.
 */
import type { AccountSessionService } from '../accounts/session.js';
import type { WorkspaceService } from '../workspaces.js';
import {
  ABSENT_TELEMETRY_POLICY,
  OBSERVATION_OFF,
  operatorConfigFromEnv,
  type ObservationOperatorConfig,
  type TelemetryPolicyPort,
} from './eligibility.js';
import {
  BoundedObservationExporter,
  MemoryObservationSink,
  type ExporterLimits,
  type ObservationExporter,
  type ObservationSink,
} from './exporter.js';
import { PostHogTransport } from './posthog-transport.js';
import { ObservationProjector } from './projector.js';
import { ObservationScopes } from './scopes.js';

/** What `createApp` accepts. Unset reads the environment once; null is off. */
export interface ObservationOptions {
  readonly operator?: ObservationOperatorConfig;
  /** Production has none (dependency D1). Tests pass a fixture. */
  readonly telemetry?: TelemetryPolicyPort;
  /** Where batches go. Tests pass a memory sink and read its bodies. */
  readonly sink?: ObservationSink;
  readonly limits?: Partial<ExporterLimits>;
  readonly timer?: boolean;
  readonly clock?: () => number;
  /** Tests replace the network under the PostHog transport. Production leaves it unset. */
  readonly fetch?: typeof globalThis.fetch;
  readonly random?: () => number;
}

export interface ObservationRuntime {
  readonly operator: ObservationOperatorConfig;
  readonly scopes: ObservationScopes;
  readonly projector: ObservationProjector;
  readonly exporter: ObservationExporter;
}

export function createObservation(input: {
  readonly options: ObservationOptions | null | undefined;
  readonly env: NodeJS.ProcessEnv;
  readonly build: string;
  readonly session: Pick<AccountSessionService, 'personId' | 'entitlement' | 'backend'>;
  readonly workspaces: Pick<WorkspaceService, 'active' | 'projectOwner'>;
}): ObservationRuntime | null {
  if (input.options === null) return null;
  const operator = input.options?.operator ?? operatorConfigFromEnv(input.env);
  if (operator.mode === 'off' || operator === OBSERVATION_OFF) return null;
  // `posthog` mode needs a well-formed host and capture key; otherwise nothing is constructed.
  const posthog = operator.mode === 'posthog' ? operator.posthog : null;
  if (operator.mode === 'posthog' && !posthog) return null;
  const sink =
    input.options?.sink ??
    (posthog
      ? new PostHogTransport({ host: posthog.host, captureKey: posthog.captureKey, fetch: input.options?.fetch })
      : new MemoryObservationSink());
  const { session, workspaces } = input;
  const activeOrganizationId = () => {
    const active = workspaces.active();
    return active.kind === 'business' ? active.organizationId : null;
  };
  const scopes = new ObservationScopes({
    operator,
    telemetry: input.options?.telemetry ?? ABSENT_TELEMETRY_POLICY,
    backend: () => session.backend.view().kind,
    authority: {
      personId: () => session.personId(),
      activeOrganizationId,
      entitlement: (organizationId) => session.entitlement(organizationId),
      // The Agent gate's own rule (agent-gate.ts `organizationFor`): the project's owner, else the active business.
      organizationFor: (projectId) => (projectId ? workspaces.projectOwner(projectId)?.organizationId : null) ?? activeOrganizationId(),
    },
    now: input.options?.clock,
  });
  const exporter = new BoundedObservationExporter({
    sink,
    scopes,
    clock: input.options?.clock,
    limits: input.options?.limits,
    timer: input.options?.timer,
    // A paid destination spends only inside its funding and today's pilot budget; both default to nothing.
    gate: posthog ? { fundedUntil: posthog.fundedUntil, dailyEvents: posthog.dailyEvents } : null,
    random: input.options?.random,
  });
  const projector = new ObservationProjector({ scopes, exporter, build: input.build });
  return { operator, scopes, projector, exporter };
}
