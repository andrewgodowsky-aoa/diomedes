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
  readonly workspaces: Pick<WorkspaceService, 'active'>;
}): ObservationRuntime | null {
  if (input.options === null) return null;
  const operator = input.options?.operator ?? operatorConfigFromEnv(input.env);
  if (operator.mode === 'off' || operator === OBSERVATION_OFF) return null;
  // PH-01 has no network transport: `posthog` mode stays off until PH-02 wires it.
  const sink = input.options?.sink ?? (operator.mode === 'memory' ? new MemoryObservationSink() : null);
  if (!sink) return null;
  const { session, workspaces } = input;
  const scopes = new ObservationScopes({
    operator,
    telemetry: input.options?.telemetry ?? ABSENT_TELEMETRY_POLICY,
    backend: () => session.backend.view().kind,
    authority: {
      personId: () => session.personId(),
      activeOrganizationId: () => {
        const active = workspaces.active();
        return active.kind === 'business' ? active.organizationId : null;
      },
      entitlement: (organizationId) => session.entitlement(organizationId),
    },
    now: input.options?.clock,
  });
  const exporter = new BoundedObservationExporter({
    sink,
    scopes,
    clock: input.options?.clock,
    limits: input.options?.limits,
    timer: input.options?.timer,
  });
  const projector = new ObservationProjector({ scopes, exporter, build: input.build });
  return { operator, scopes, projector, exporter };
}
