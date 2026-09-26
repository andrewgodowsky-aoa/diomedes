/**
 * The PostHog event shape, and the only place PostHog property names appear (PH-00 contract 2.5, 4.3).
 *
 * `toWireEvent` builds a new flat object from the observation's named fields. Nothing is copied
 * whole, so a field added to a record later cannot leave by accident: it has no property here.
 * A final guard refuses any key outside the event's allowlist and any string that is not an
 * identifier-shaped value, so a sentence cannot pass even if a builder above were wrong.
 *
 * Unknown values are left out, never written as zero. Durations leave as seconds.
 */
import type { Observation, Observed, ScopeFacts } from '../../shared/observability.js';

export type PostHogEventName =
  | '$ai_trace'
  | '$ai_generation'
  | '$ai_span'
  | 'nectovia_run_parked'
  | 'nectovia_cost_reconciled';

export type WireValue = string | number | boolean;

export interface PostHogWireEvent {
  readonly event: PostHogEventName;
  readonly uuid: string;
  /** The recorded event's own time, ISO UTC. */
  readonly timestamp: string;
  /** Flat: no nested objects, no arrays, no nulls. */
  readonly properties: Readonly<Record<string, WireValue>>;
}

const COMMON = [
  'distinct_id',
  '$process_person_profile',
  '$geoip_disable',
  '$ai_trace_id',
  '$ai_session_id',
  'nectovia_contract',
  'nectovia_class',
  'nectovia_synthetic',
  'nectovia_source_trust',
  'nectovia_environment',
  'nectovia_admission_id',
  'nectovia_surface',
  'nectovia_route',
  'nectovia_payer',
  'nectovia_plan',
  'nectovia_policy_revision',
  'nectovia_telemetry_revision',
  'nectovia_build',
  'nectovia_capability',
] as const;

/** Every key each event may carry. A snapshot test pins these sets. */
export const WIRE_KEYS: Readonly<Record<PostHogEventName, ReadonlySet<string>>> = Object.freeze({
  $ai_trace: new Set([
    ...COMMON,
    '$ai_span_name',
    '$ai_latency',
    '$ai_is_error',
    '$ai_error',
    'nectovia_outcome',
    'nectovia_model_steps',
    'nectovia_tool_steps',
    'nectovia_child_runs',
    'nectovia_loop_stop',
  ]),
  $ai_generation: new Set([
    ...COMMON,
    '$ai_span_id',
    '$ai_parent_id',
    '$ai_span_name',
    '$ai_provider',
    '$ai_model',
    '$ai_latency',
    '$ai_is_error',
    '$ai_error',
    '$ai_input_tokens',
    '$ai_output_tokens',
    '$ai_cache_read_input_tokens',
    '$ai_cache_creation_input_tokens',
    '$ai_cache_reporting_exclusive',
    '$ai_total_cost_usd',
    'nectovia_reasoning_tokens',
    'nectovia_cost_micro_usd',
    'nectovia_rate_card_key',
    'nectovia_cost_state',
    'nectovia_requested_model',
    'nectovia_outcome',
    'nectovia_step',
    'nectovia_attempt',
    'nectovia_step_state',
    'nectovia_error_code',
  ]),
  $ai_span: new Set([
    ...COMMON,
    '$ai_span_id',
    '$ai_parent_id',
    '$ai_span_name',
    '$ai_latency',
    '$ai_is_error',
    '$ai_error',
    'nectovia_span_kind',
    'nectovia_attempt',
    'nectovia_step_state',
    'nectovia_effect_class',
    'nectovia_effect_status',
    'nectovia_authorization',
    'nectovia_verification_state',
    'nectovia_verification_rule',
    'nectovia_checks_declared',
    'nectovia_checks_passed',
    'nectovia_checks_failed',
    'nectovia_checks_incomplete',
    'nectovia_verification_requested_by',
    'nectovia_error_code',
  ]),
  nectovia_run_parked: new Set([...COMMON, '$ai_span_id', '$ai_parent_id', 'nectovia_step_kind']),
  nectovia_cost_reconciled: new Set([
    ...COMMON,
    'nectovia_generation_span_id',
    'nectovia_reconciled_from',
    'nectovia_cost_state',
    'nectovia_cost_micro_usd',
    '$ai_total_cost_usd',
    'nectovia_rate_card_key',
  ]),
});

/** Identifier-shaped: no spaces, quotes, braces, newlines or percent signs. */
const SAFE_VALUE = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,199}$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export class WireRefused extends Error {
  constructor(readonly key: string) {
    super('An observation property is outside the allowlist.');
    this.name = 'WireRefused';
  }
}

const seconds = (ms: number) => ms / 1000;

function scopeProperties(scope: ScopeFacts, build: string, capability: string): Record<string, WireValue> {
  return {
    distinct_id: scope.organizationKey,
    $process_person_profile: false,
    $geoip_disable: true,
    nectovia_contract: 'nectovia-observation/1',
    nectovia_class: scope.class,
    nectovia_synthetic: scope.synthetic,
    nectovia_source_trust: scope.sourceTrust,
    nectovia_environment: scope.environment,
    nectovia_admission_id: scope.admissionId,
    nectovia_surface: scope.surface,
    nectovia_route: scope.route,
    nectovia_payer: scope.payer,
    nectovia_plan: scope.plan,
    nectovia_policy_revision: scope.policyRevision,
    ...(scope.telemetryRevision === null ? {} : { nectovia_telemetry_revision: scope.telemetryRevision }),
    nectovia_build: build,
    nectovia_capability: capability,
  };
}

const put = <T>(target: Record<string, WireValue>, key: string, value: Observed<T>, map: (value: T) => WireValue) => {
  if (value.known) target[key] = map(value.value);
};

export function toWireEvent(observation: Observation): PostHogWireEvent {
  const properties: Record<string, WireValue> = {
    ...scopeProperties(observation.scope, observation.build, observation.capability),
    $ai_trace_id: observation.ids.traceId,
    ...(observation.ids.sessionId ? { $ai_session_id: observation.ids.sessionId } : {}),
  };
  let event: PostHogEventName;
  switch (observation.kind) {
    case 'trace': {
      event = '$ai_trace';
      properties.$ai_span_name = observation.capability;
      put(properties, '$ai_latency', observation.durationMs, seconds);
      properties.$ai_is_error = observation.outcome === 'failed';
      if (observation.outcome === 'failed')
        properties.$ai_error = observation.errorClass.known ? observation.errorClass.value : 'other';
      properties.nectovia_outcome = observation.outcome;
      properties.nectovia_model_steps = observation.modelSteps;
      properties.nectovia_tool_steps = observation.toolSteps;
      properties.nectovia_child_runs = observation.childRuns;
      put(properties, 'nectovia_loop_stop', observation.loopStop, (value) => value);
      break;
    }
    case 'generation': {
      event = '$ai_generation';
      properties.$ai_span_id = observation.ids.spanId;
      if (observation.ids.parentId) properties.$ai_parent_id = observation.ids.parentId;
      properties.$ai_span_name = observation.step;
      properties.$ai_provider = observation.scope.route;
      put(properties, '$ai_model', observation.reportedModel, (value) => value);
      put(properties, 'nectovia_requested_model', observation.requestedModel, (value) => value);
      put(properties, '$ai_latency', observation.durationMs, seconds);
      properties.$ai_is_error = observation.stepState !== 'succeeded';
      if (observation.stepState !== 'succeeded')
        properties.$ai_error = observation.errorCode.known ? observation.errorCode.value : 'other';
      if (observation.usage.known) {
        const usage = observation.usage.value;
        properties.$ai_input_tokens = usage.inputTokens;
        properties.$ai_output_tokens = usage.outputTokens;
        properties.$ai_cache_read_input_tokens = usage.cacheReadTokens;
        properties.$ai_cache_creation_input_tokens = usage.cacheWriteTokens;
        properties.$ai_cache_reporting_exclusive = false;
        properties.nectovia_reasoning_tokens = usage.reasoningTokens;
      }
      if (observation.cost.known) {
        properties.nectovia_cost_micro_usd = observation.cost.value.microUsd;
        properties.nectovia_rate_card_key = observation.cost.value.rateCardKey;
        if (observation.costState === 'settled' || observation.costState === 'written-off')
          properties.$ai_total_cost_usd = observation.cost.value.microUsd / 1e6;
      }
      properties.nectovia_cost_state = observation.costState;
      properties.nectovia_outcome = observation.outcome;
      properties.nectovia_step = observation.step;
      properties.nectovia_attempt = observation.attempt;
      properties.nectovia_step_state = observation.stepState;
      put(properties, 'nectovia_error_code', observation.errorCode, (value) => value);
      break;
    }
    case 'span': {
      event = '$ai_span';
      properties.$ai_span_id = observation.ids.spanId;
      if (observation.ids.parentId) properties.$ai_parent_id = observation.ids.parentId;
      properties.$ai_span_name = observation.name;
      put(properties, '$ai_latency', observation.durationMs, seconds);
      const failed =
        (observation.stepState.known && observation.stepState.value !== 'succeeded') ||
        (observation.verification.known && observation.verification.value.state === 'failed');
      properties.$ai_is_error = failed;
      if (failed) properties.$ai_error = observation.errorCode.known ? observation.errorCode.value : 'other';
      properties.nectovia_span_kind = observation.spanKind;
      if (observation.attempt !== null) properties.nectovia_attempt = observation.attempt;
      put(properties, 'nectovia_step_state', observation.stepState, (value) => value);
      if (observation.effect.known) {
        properties.nectovia_effect_class = observation.effect.value.effectClass;
        properties.nectovia_effect_status = observation.effect.value.status;
      }
      put(properties, 'nectovia_authorization', observation.authorization, (value) => value);
      if (observation.verification.known) {
        const facts = observation.verification.value;
        properties.nectovia_verification_state = facts.state;
        properties.nectovia_verification_rule = facts.rule;
        properties.nectovia_checks_declared = facts.declared;
        properties.nectovia_checks_passed = facts.passed;
        properties.nectovia_checks_failed = facts.failed;
        properties.nectovia_checks_incomplete = facts.incomplete;
        properties.nectovia_verification_requested_by = facts.requestedBy;
      }
      put(properties, 'nectovia_error_code', observation.errorCode, (value) => value);
      break;
    }
    case 'parked': {
      event = 'nectovia_run_parked';
      properties.$ai_span_id = observation.ids.spanId;
      if (observation.ids.parentId) properties.$ai_parent_id = observation.ids.parentId;
      properties.nectovia_step_kind = observation.stepKind;
      break;
    }
    case 'cost-reconciled': {
      event = 'nectovia_cost_reconciled';
      properties.nectovia_generation_span_id = observation.generationSpanId;
      properties.nectovia_reconciled_from = observation.reconciledFrom;
      properties.nectovia_cost_state = observation.costState;
      if (observation.cost.known) {
        properties.nectovia_cost_micro_usd = observation.cost.value.microUsd;
        properties.nectovia_rate_card_key = observation.cost.value.rateCardKey;
        properties.$ai_total_cost_usd = observation.cost.value.microUsd / 1e6;
      }
      break;
    }
  }
  return guard({ event, uuid: observation.ids.uuid, timestamp: observation.at, properties });
}

/** The last line: every key allowlisted, every value a flat primitive of an allowed shape. */
function guard(wire: PostHogWireEvent): PostHogWireEvent {
  if (!UUID.test(wire.uuid)) throw new WireRefused('uuid');
  if (!ISO.test(wire.timestamp)) throw new WireRefused('timestamp');
  const allowed = WIRE_KEYS[wire.event];
  for (const [key, value] of Object.entries(wire.properties)) {
    if (!allowed.has(key)) throw new WireRefused(key);
    if (typeof value === 'number' ? !Number.isFinite(value) : typeof value === 'string' ? !SAFE_VALUE.test(value) : typeof value !== 'boolean')
      throw new WireRefused(key);
  }
  return Object.freeze({ ...wire, properties: Object.freeze({ ...wire.properties }) });
}

/** One serialized event, as it sits in a batch. */
export const encodeEvent = (event: PostHogWireEvent) => JSON.stringify(event);

/** `{"batch":[...]}`. The transport adds `api_key` at send; nothing else is added. */
export function encodeBatch(events: readonly PostHogWireEvent[]): string {
  return JSON.stringify({ batch: events });
}
