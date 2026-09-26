/**
 * PH-01: the observation record and its wire form. Pure: hand-built run records go through the
 * real projector, sanitizers and wire builder; the exporter is a recorder.
 */
import { describe, expect, test } from 'vitest';
import type { AdmittedAgentWork } from '../server/accounts/agent-gate.js';
import { AWS_LUNA_MODEL } from '../server/engines/aws-bedrock.js';
import { VERTEX_GEMINI_MODEL } from '../server/engines/google-vertex.js';
import { exposureStepId } from '../server/harness/model-api-adapter.js';
import type { ObservationOperatorConfig, ObservationScope } from '../server/observability/eligibility.js';
import type { ObservationExporter } from '../server/observability/exporter.js';
import { ObservationProjector, type ObservationLedgerPort } from '../server/observability/projector.js';
import {
  CATALOG_MODELS,
  errorCode,
  rateCardKeyFor,
  reportedModel,
  requestedModel,
  sessionIdFor,
  spanIdFor,
  toolName,
  traceIdFor,
  uuidFor,
} from '../server/observability/sanitize.js';
import { ObservationScopes } from '../server/observability/scopes.js';
import { WIRE_KEYS, WireRefused, encodeBatch, toWireEvent, type PostHogWireEvent } from '../server/observability/wire.js';
import type { ExposureReservation } from '../server/spend-exposure.js';
import type { HarnessEvent, HarnessRun, StepRecord } from '../shared/harness.js';
import { known, unknown, type GenerationObservation, type Observation } from '../shared/observability.js';
import type { VerificationRecord, VerificationView } from '../shared/verification.js';
import { applicationOrigin } from '../shared/attribution.js';
import { supervisorOrigin } from '../shared/native-loop.js';

const ENV = 'test';
const KEY = new Uint8Array(32).fill(9);
const ORG = 'org_internal_a';
const ZERO = Date.UTC(2026, 8, 25, 12, 0, 0);
const T = (ms: number) => new Date(ZERO + ms).toISOString();
const CANARY = 'CANARYq7Zx41';

const operator: ObservationOperatorConfig = {
  mode: 'memory',
  environment: ENV,
  companyHost: true,
  internalOrganizations: new Set([ORG]),
  pseudonymKey: KEY,
  customerExport: false,
  posthog: null,
};
const admission = (overrides: Partial<AdmittedAgentWork> = {}): AdmittedAgentWork => ({
  admissionId: 'adm_0123456789abcdef',
  organizationId: ORG,
  personId: 'person_1',
  planId: 'business',
  policyRevision: 3,
  routeKind: 'byo',
  surface: 'loop',
  validUntil: T(3_600_000),
  ...overrides,
});

class Recorder implements ObservationExporter {
  readonly seen: { observation: Observation; scope: ObservationScope }[] = [];
  enqueue(observation: Observation, scope: ObservationScope) {
    this.seen.push({ observation, scope });
  }
  async flush() {}
  discard() {
    return 0;
  }
  health() {
    return {} as never;
  }
  async close() {}
  wire(): PostHogWireEvent[] {
    return this.seen.map((item) => toWireEvent(item.observation));
  }
}

function harness(options: { now?: number; route?: string; routeKind?: AdmittedAgentWork['routeKind']; ledger?: ObservationLedgerPort | null } = {}) {
  const scopes = new ObservationScopes({
    operator,
    backend: () => 'faux',
    authority: { personId: () => 'person_1', activeOrganizationId: () => ORG, entitlement: () => ({ agent: true, state: 'active' }) },
    now: () => options.now ?? ZERO,
  });
  const exporter = new Recorder();
  const projector = new ObservationProjector({ scopes, exporter, build: '0.1.12', ledger: options.ledger ?? null });
  const bind = (surface: AdmittedAgentWork['surface'], rootJobId: string, model: string | null = AWS_LUNA_MODEL) =>
    scopes.decide({
      admission: admission({ surface, routeKind: options.routeKind ?? 'byo' }),
      rootJobId,
      route: options.route ?? 'aws-bedrock',
      connectionId: 'conn-1',
      model,
    });
  return { scopes, exporter, projector, bind };
}

let seq = 0;
const event = (type: string, at: number, stepId?: string, attempt?: number, attributes: HarnessEvent['attributes'] = {}): HarnessEvent => ({
  v: 1,
  seq: ++seq,
  runId: 'r',
  at: T(at),
  type,
  ...(stepId === undefined ? {} : { stepId }),
  ...(attempt === undefined ? {} : { attempt }),
  attributes,
});
const request = (text: string) => ({ runId: 'loop-root', capabilityId: 'diomedes-loop', messages: [{ role: 'user', text }], tools: [], transcript: null });
const modelStep = (stepId: string, overrides: Partial<StepRecord> = {}): StepRecord =>
  ({
    intent: { stepId, stepVersion: '1', kind: 'model', effect: 'read', name: 'aws-bedrock', input: { provider: 'aws-bedrock', request: request(`${CANARY} prompt`) } },
    intentHash: 'h',
    attempt: 1,
    state: 'succeeded',
    output: { response: { type: 'final', text: `${CANARY} answer` }, transcript: { modelId: AWS_LUNA_MODEL } },
    origin: { protocolVersion: 1, mode: 'direct', engine: { id: 'aws-bedrock', version: '1' }, model: { requested: AWS_LUNA_MODEL, reported: AWS_LUNA_MODEL, source: 'runtime' } },
    leaseFence: 1,
    startedAt: null,
    endedAt: null,
    error: null,
    ...overrides,
  }) as StepRecord;
const toolStep = (stepId: string, name: string, overrides: Partial<StepRecord> = {}): StepRecord =>
  ({
    intent: { stepId, stepVersion: '1', kind: 'tool', effect: 'read', name, input: { path: `${CANARY}/secret.md` } },
    intentHash: 'h',
    attempt: 1,
    state: 'succeeded',
    output: { text: `${CANARY} file body` },
    // What the host records on every registry dispatch (native-loop.ts, native-agent.ts).
    origin: applicationOrigin(),
    leaseFence: 1,
    startedAt: null,
    endedAt: null,
    error: null,
    ...overrides,
  }) as StepRecord;
const run = (overrides: Partial<HarnessRun>): HarnessRun => {
  const events = overrides.events ?? [];
  return {
    v: 1,
    id: 'loop-root',
    tenantId: 't',
    projectId: `${CANARY}-project`,
    taskId: null,
    sessionId: null,
    capabilityId: 'diomedes-loop',
    capabilityVersion: '1',
    capabilityTools: [],
    policyVersion: '1',
    principal: {} as never,
    input: {},
    state: 'running',
    budget: {} as never,
    used: {} as never,
    owner: null,
    fence: 1,
    leaseExpiresAt: null,
    parentRunId: null,
    forkPoint: null,
    contextRevision: 0,
    transcripts: {},
    result: null,
    failure: null,
    cancelReason: null,
    createdAt: T(-5),
    updatedAt: T(0),
    steps: [],
    approvals: [],
    lastSeq: events.at(-1)?.seq ?? 0,
    ...overrides,
    events,
  } as HarnessRun;
};
const hold = (overrides: Partial<ExposureReservation> & { attempt: ExposureReservation['attempt'] }): ExposureReservation =>
  ({
    id: 'exp-1',
    connectionId: 'conn-1',
    route: 'aws-bedrock',
    modelId: AWS_LUNA_MODEL,
    rateCardVersion: `aws-bedrock-2026-09|${CANARY}-deployment`,
    jobId: null,
    maxMicroUsd: 1000,
    state: 'settled',
    createdAt: T(0),
    resolvedAt: T(1),
    uncertainAt: null,
    uncertainReason: null,
    settledMicroUsd: 123,
    usage: { inputTokens: 100, cacheReadTokens: 20, cacheWriteTokens: 5, outputTokens: 30, reasoningTokens: 8 },
    band: 'short',
    overCeiling: false,
    providerRequestId: `req-${CANARY}`,
    reconciledFrom: 'response',
    note: `${CANARY} note`,
    ...overrides,
  }) as ExposureReservation;

const byEvent = (events: PostHogWireEvent[], name: string) => events.filter((item) => item.event === name);

describe('identifiers', () => {
  test('deterministic, scoped by environment, never the raw id; event uuids are version 8', () => {
    expect(traceIdFor(ENV, 'loop-root')).toBe(traceIdFor(ENV, 'loop-root'));
    expect(traceIdFor(ENV, 'loop-root')).toMatch(/^otr_[0-9a-f]{32}$/);
    expect(traceIdFor('production', 'loop-root')).not.toBe(traceIdFor(ENV, 'loop-root'));
    expect(spanIdFor(ENV, 'a|b|1')).toMatch(/^osp_[0-9a-f]{32}$/);
    expect(sessionIdFor(ENV, 'lineage')).toMatch(/^oss_[0-9a-f]{32}$/);
    const uuid = uuidFor(ENV, 'x');
    expect(uuid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(uuidFor(ENV, 'x')).toBe(uuid);
    expect(uuidFor(ENV, 'y')).not.toBe(uuid);
  });

  test('the rate card leaves as a keyed digest, never its version', () => {
    const version = `azure-openai-2026-09|${CANARY}-deployment`;
    expect(rateCardKeyFor(KEY, version)).toMatch(/^rc_[0-9a-f]{16}$/);
    expect(rateCardKeyFor(KEY, version)).not.toContain(CANARY);
    expect(rateCardKeyFor(new Uint8Array(32).fill(1), version)).not.toBe(rateCardKeyFor(KEY, version));
  });
});

describe('sanitizers', () => {
  test('the built-in catalog equals the engines’ own constants', () => {
    expect(CATALOG_MODELS['aws-bedrock']).toEqual([AWS_LUNA_MODEL]);
    expect(CATALOG_MODELS['google-vertex']).toEqual([VERTEX_GEMINI_MODEL]);
  });

  test('models: a catalog pick is an identifier; an owner-typed name, an ARN or a deployment is customer-named', () => {
    expect(requestedModel('aws-bedrock', AWS_LUNA_MODEL)).toEqual(known(AWS_LUNA_MODEL));
    expect(requestedModel('aws-bedrock', 'arn:aws:bedrock:us-east-1:123456789012:inference-profile/x')).toEqual(unknown('customer-named'));
    expect(requestedModel('azure-openai', `${CANARY}-deployment`)).toEqual(unknown('customer-named'));
    expect(requestedModel('openrouter', 'anthropic/claude-sonnet-4.5')).toEqual(unknown('customer-named'));
    expect(requestedModel('aws-bedrock', null)).toEqual(unknown('not-reported'));
    expect(reportedModel('azure-openai', 'gpt-5')).toEqual(unknown('customer-named'));
    expect(reportedModel('aws-bedrock', 'arn:aws:bedrock:us-east-1:123456789012:foundation-model/x')).toEqual(unknown('customer-named'));
    expect(reportedModel('aws-bedrock', 'model 123456789012 x')).toEqual(unknown('customer-named'));
    expect(reportedModel('openrouter', 'anthropic/claude-sonnet-4.5')).toEqual(known('anthropic/claude-sonnet-4.5'));
    expect(reportedModel('openrouter', 'just-a-name')).toEqual(unknown('customer-named'));
    expect(reportedModel('google-vertex', 'Gemini With Spaces')).toEqual(unknown('customer-named'));
    expect(reportedModel('aws-bedrock', 'x'.repeat(81))).toEqual(unknown('customer-named'));
  });

  test('a tool outside the host’s allowlist is other; error codes are identifiers or nothing', () => {
    expect(toolName('read_source')).toBe('read_source');
    expect(toolName(`${CANARY}_connector_tool`)).toBe('other');
    expect(toolName(null)).toBe('other');
    expect(errorCode('aws_bedrock_http_500')).toEqual(known('aws_bedrock_http_500'));
    expect(errorCode('The provider said no')).toEqual(unknown('not-reported'));
    expect(errorCode('x'.repeat(65))).toEqual(unknown('not-reported'));
    expect(errorCode(42)).toEqual(unknown('not-reported'));
  });
});

describe('the wire form', () => {
  const scope = (() => {
    const { bind } = harness();
    const decision = bind('loop', 'loop-root');
    if (!decision.eligible) throw new Error('expected eligible');
    return decision.scope;
  })();
  const generation = (overrides: Partial<GenerationObservation> = {}): GenerationObservation => ({
    kind: 'generation',
    contract: 'nectovia-observation/1',
    ids: { uuid: uuidFor(ENV, 'g'), traceId: traceIdFor(ENV, 'r'), spanId: spanIdFor(ENV, 'r|model:0|1'), parentId: traceIdFor(ENV, 'r'), sessionId: null },
    at: T(1000),
    scope: scope.facts,
    build: '0.1.12',
    capability: 'diomedes-loop',
    step: 'model',
    attempt: 1,
    stepState: 'succeeded',
    outcome: 'answered-final',
    errorCode: unknown('not-applicable'),
    durationMs: known(240_000),
    requestedModel: known(AWS_LUNA_MODEL),
    reportedModel: known(AWS_LUNA_MODEL),
    usage: known({ inputTokens: 100, cacheReadTokens: 20, cacheWriteTokens: 5, outputTokens: 30, reasoningTokens: 8 }),
    cost: known({ microUsd: 123, rateCardKey: 'rc_0123456789abcdef' }),
    costState: 'settled',
    ...overrides,
  });

  test('tokens: input includes cache, the exclusive flag is false, reasoning leaves only as nectovia_', () => {
    const wire = toWireEvent(generation());
    expect(wire.properties).toMatchObject({
      $ai_input_tokens: 100,
      $ai_cache_read_input_tokens: 20,
      $ai_cache_creation_input_tokens: 5,
      $ai_cache_reporting_exclusive: false,
      $ai_output_tokens: 30,
      nectovia_reasoning_tokens: 8,
      nectovia_cost_micro_usd: 123,
      $ai_total_cost_usd: 0.000123,
      $ai_provider: 'aws-bedrock',
      $ai_model: AWS_LUNA_MODEL,
      distinct_id: scope.facts.organizationKey,
      $process_person_profile: false,
      $geoip_disable: true,
    });
    expect(wire.properties).not.toHaveProperty('$ai_reasoning_tokens');
    expect(wire.properties).not.toHaveProperty('$ai_input_cost_usd');
    expect(wire.properties).not.toHaveProperty('$ai_output_cost_usd');
  });

  test('milliseconds leave as seconds: 0 → 0, 1 → 0.001, 240,000 → 240', () => {
    expect(toWireEvent(generation({ durationMs: known(0) })).properties.$ai_latency).toBe(0);
    expect(toWireEvent(generation({ durationMs: known(1) })).properties.$ai_latency).toBe(0.001);
    expect(toWireEvent(generation({ durationMs: known(240_000) })).properties.$ai_latency).toBe(240);
  });

  test('unknown is left out, never zero; settled 0 is a known zero; only settled and written-off carry $ai_total_cost_usd', () => {
    const blank = toWireEvent(
      generation({
        durationMs: unknown('not-reported'),
        requestedModel: unknown('customer-named'),
        reportedModel: unknown('not-reported'),
        usage: unknown('not-linked'),
        cost: unknown('not-linked'),
        costState: 'not-linked',
      }),
    ).properties;
    for (const key of ['$ai_latency', '$ai_model', 'nectovia_requested_model', '$ai_input_tokens', '$ai_output_tokens', 'nectovia_cost_micro_usd', '$ai_total_cost_usd'])
      expect(blank, key).not.toHaveProperty(key);
    expect(Object.values(blank)).not.toContain(0);
    const zero = toWireEvent(generation({ cost: known({ microUsd: 0, rateCardKey: 'rc_0123456789abcdef' }) })).properties;
    expect(zero).toMatchObject({ nectovia_cost_micro_usd: 0, $ai_total_cost_usd: 0, nectovia_cost_state: 'settled' });
    for (const [costState, why] of [
      ['uncertain', 'cost-uncertain'],
      ['pending', 'cost-pending'],
      ['released', 'not-applicable'],
      ['not-linked', 'not-linked'],
      ['gateway-pending', 'cost-pending'],
    ] as const) {
      const properties = toWireEvent(generation({ costState, cost: unknown(why) })).properties;
      expect(properties, costState).not.toHaveProperty('$ai_total_cost_usd');
      expect(properties.nectovia_cost_state).toBe(costState);
    }
  });

  test('an error leaves as its code, else other; never a message', () => {
    const coded = toWireEvent(generation({ stepState: 'reconcile_required', outcome: 'unknown-outcome', errorCode: known('aws_bedrock_http_500') })).properties;
    expect(coded).toMatchObject({ $ai_is_error: true, $ai_error: 'aws_bedrock_http_500', nectovia_error_code: 'aws_bedrock_http_500' });
    const bare = toWireEvent(generation({ stepState: 'failed', outcome: 'not-charged', errorCode: unknown('not-reported') })).properties;
    expect(bare).toMatchObject({ $ai_is_error: true, $ai_error: 'other' });
  });

  test('the guard refuses a sentence and any key outside the allowlist', () => {
    expect(() => toWireEvent(generation({ requestedModel: known(`a ${CANARY} sentence`) }))).toThrow(WireRefused);
    expect(() => toWireEvent({ ...generation(), ids: { ...generation().ids, uuid: 'not-a-uuid' } })).toThrow(WireRefused);
    expect(() => toWireEvent({ ...generation(), build: '{"x":1}' })).toThrow(WireRefused);
  });

  test('the key set per event kind is pinned', () => {
    expect([...WIRE_KEYS.$ai_generation].sort()).toEqual([
      '$ai_cache_creation_input_tokens',
      '$ai_cache_read_input_tokens',
      '$ai_cache_reporting_exclusive',
      '$ai_error',
      '$ai_input_tokens',
      '$ai_is_error',
      '$ai_latency',
      '$ai_model',
      '$ai_output_tokens',
      '$ai_parent_id',
      '$ai_provider',
      '$ai_session_id',
      '$ai_span_id',
      '$ai_span_name',
      '$ai_total_cost_usd',
      '$ai_trace_id',
      '$geoip_disable',
      '$process_person_profile',
      'distinct_id',
      'nectovia_admission_id',
      'nectovia_attempt',
      'nectovia_build',
      'nectovia_capability',
      'nectovia_class',
      'nectovia_contract',
      'nectovia_cost_micro_usd',
      'nectovia_cost_state',
      'nectovia_environment',
      'nectovia_error_code',
      'nectovia_outcome',
      'nectovia_payer',
      'nectovia_plan',
      'nectovia_policy_revision',
      'nectovia_rate_card_key',
      'nectovia_reasoning_tokens',
      'nectovia_requested_model',
      'nectovia_route',
      'nectovia_source_trust',
      'nectovia_step',
      'nectovia_step_state',
      'nectovia_surface',
      'nectovia_synthetic',
      'nectovia_telemetry_revision',
    ]);
    expect(Object.keys(WIRE_KEYS).sort()).toEqual(['$ai_generation', '$ai_span', '$ai_trace', 'nectovia_cost_reconciled', 'nectovia_run_parked']);
    for (const keys of Object.values(WIRE_KEYS))
      for (const key of keys) expect(key, key).toMatch(/^(\$ai_[a-z_]+|\$process_person_profile|\$geoip_disable|distinct_id|nectovia_[a-z_]+)$/);
  });

  test('a batch is {"batch":[...]} with no api_key', () => {
    const wire = toWireEvent(generation());
    expect(encodeBatch([wire])).toBe(`{"batch":[${JSON.stringify(wire)}]}`);
    expect(encodeBatch([wire])).not.toContain('api_key');
  });
});

describe('the projector over a loop with a delegate, a tool, and a verification', () => {
  function loopScenario(ledger: ObservationLedgerPort | null) {
    seq = 0;
    const h = harness({ ledger });
    h.bind('loop', 'loop-root');
    const rootSteps = [
      modelStep('model:0', { output: { response: { type: 'tool', name: 'read_source', input: { path: CANARY } }, transcript: { modelId: AWS_LUNA_MODEL } } as never }),
      toolStep('tool:1', 'read_source', {
        effects: [
          {
            v: 1,
            tool: 'read_source',
            effectClass: 'read',
            attempt: 1,
            inputsDigest: 'd',
            targets: [`${CANARY}/secret.md`],
            idempotencyKey: 'k',
            principalId: 'p',
            identityGeneration: 1,
            authorization: 'permission:read',
            status: 'applied',
            intendedAt: T(1100),
            outcomeAt: T(1200),
            outputHash: 'o',
            error: null,
            reconciliation: null,
          },
        ],
      }),
      toolStep('tool:2', 'delegate', { origin: supervisorOrigin() }),
    ];
    const rootEvents = [
      event('run.created', -5),
      event('step.started', 10, 'model:0', 1),
      event('step.succeeded', 1010, 'model:0', 1),
      event('step.started', 1100, 'tool:1', 1),
      event('effect.intended', 1100, 'tool:1', 1, { tool: 'read_source', targets: [`${CANARY}/secret.md`] }),
      event('effect.applied', 1200, 'tool:1', 1),
      event('step.succeeded', 1200, 'tool:1', 1),
      event('step.started', 1300, 'tool:2', 1),
      event('step.succeeded', 5000, 'tool:2', 1),
    ];
    const childEvents = [
      event('run.created', 1350),
      event('step.started', 1400, 'model:0', 1),
      event('step.succeeded', 2400, 'model:0', 1),
      event('run.completed', 2500),
    ];
    const child = run({
      id: 'child-1',
      capabilityId: 'diomedes-loop-delegate',
      input: { kind: 'diomedes-loop-delegate', parent: { runId: 'loop-root', stepId: 'delegate' }, rootRunId: 'loop-root', task: `${CANARY} sub-task` },
      steps: [modelStep('model:0')],
      events: childEvents,
      state: 'completed',
      createdAt: T(1350),
    });
    const done = event('run.completed', 6000);
    const root = (complete: boolean) =>
      run({ sessionId: 'S1', steps: rootSteps, events: complete ? [...rootEvents, done] : rootEvents, state: complete ? 'completed' : 'running' });
    h.projector.onRunSaved(root(false));
    h.projector.onRunSaved(child);
    h.projector.onRunSaved(root(true));
    return { ...h, root, child };
  }

  test('one trace: generations, tool spans and the delegate share the trace id and hang from the right parents', () => {
    const request0 = (modelStep('model:0').intent.input as { request: { messages: unknown[] } }).request;
    const ledger: ObservationLedgerPort = {
      list: () => [hold({ attempt: { runId: 'loop-root', stepId: exposureStepId(request0 as never), attempt: 1, requestDigest: 'x' } })],
    };
    const { exporter } = loopScenario(ledger);
    const wire = exporter.wire();
    const traceId = traceIdFor(ENV, 'loop-root');
    const childSpan = spanIdFor(ENV, 'child-1|run');
    expect(wire.every((item) => item.properties.$ai_trace_id === traceId)).toBe(true);

    const generations = byEvent(wire, '$ai_generation');
    expect(generations).toHaveLength(2);
    const [rootGeneration, childGeneration] = generations;
    expect(rootGeneration.properties).toMatchObject({
      $ai_parent_id: traceId,
      $ai_span_id: spanIdFor(ENV, 'loop-root|model:0|1'),
      $ai_latency: 1,
      $ai_input_tokens: 100,
      $ai_output_tokens: 30,
      nectovia_cost_micro_usd: 123,
      nectovia_cost_state: 'settled',
      nectovia_outcome: 'answered-tool-call',
      nectovia_requested_model: AWS_LUNA_MODEL,
      $ai_model: AWS_LUNA_MODEL,
      nectovia_capability: 'diomedes-loop',
    });
    expect(String(rootGeneration.properties.nectovia_rate_card_key)).toMatch(/^rc_[0-9a-f]{16}$/);
    // The child inherited its root's scope, so it claims no requested model and no hold of the root's connection.
    expect(childGeneration.properties).toMatchObject({ $ai_parent_id: childSpan, nectovia_cost_state: 'not-linked', nectovia_outcome: 'answered-final' });
    expect(childGeneration.properties).not.toHaveProperty('nectovia_requested_model');
    expect(childGeneration.properties).not.toHaveProperty('$ai_input_tokens');

    const spans = byEvent(wire, '$ai_span');
    expect(spans.map((item) => [item.properties.nectovia_span_kind, item.properties.$ai_span_name, item.properties.$ai_parent_id])).toEqual([
      ['tool', 'read_source', traceId],
      ['tool', 'delegate', traceId],
      ['delegate', 'diomedes-loop-delegate', traceId],
    ]);
    expect(spans[0].properties).toMatchObject({ nectovia_effect_class: 'read', nectovia_effect_status: 'applied', nectovia_authorization: 'permission' });
    expect(spans[2].properties.$ai_span_id).toBe(childSpan);

    const traces = byEvent(wire, '$ai_trace');
    expect(traces).toHaveLength(1);
    expect(traces[0].properties).toMatchObject({
      nectovia_outcome: 'completed',
      $ai_is_error: false,
      nectovia_model_steps: 1,
      nectovia_tool_steps: 2,
      nectovia_child_runs: 1,
      $ai_latency: 6.005,
    });
    expect(traces[0].timestamp).toBe(T(6000));
    // Prompt, answer, tool input and output, a path, the sub-task, the project and the rate card all carried the canary.
    expect(encodeBatch(wire).toLowerCase()).not.toContain(CANARY.toLowerCase());
  });

  test('a late verification is its own span under the trace; one with no scoped run is dropped and counted', () => {
    const { exporter, projector } = loopScenario(null);
    const record = {
      id: 'Vabc123',
      sessionId: 'S1',
      startedAt: T(6100),
      endedAt: T(6600),
      declaredChecks: 2,
      requestedBy: 'diomedes-loop',
      checks: [
        { id: 'order', kind: 'file-exists', outcome: 'passed' },
        { id: 'count', kind: 'text-contains', outcome: 'failed', sentence: `${CANARY} evidence` },
        { id: 'outputs-intact', kind: 'outputs-intact', outcome: 'passed' },
      ],
    } as unknown as VerificationRecord;
    projector.onVerification(record, { state: 'failed', rule: 'check-failed', sentence: `${CANARY}` } as unknown as VerificationView);
    const span = byEvent(exporter.wire(), '$ai_span').find((item) => item.properties.nectovia_span_kind === 'verification')!;
    expect(span.properties).toMatchObject({
      $ai_parent_id: traceIdFor(ENV, 'loop-root'),
      $ai_trace_id: traceIdFor(ENV, 'loop-root'),
      nectovia_verification_state: 'failed',
      nectovia_verification_rule: 'check-failed',
      nectovia_checks_declared: 2,
      // The tallies count the declared checks only, so they add up to `declared` (PH-07 F-6).
      nectovia_checks_passed: 1,
      nectovia_checks_failed: 1,
      nectovia_checks_incomplete: 0,
      nectovia_verification_requested_by: 'diomedes-loop',
      $ai_is_error: true,
      $ai_latency: 0.5,
    });
    expect(encodeBatch(exporter.wire()).toLowerCase()).not.toContain(CANARY.toLowerCase());
    projector.onVerification({ ...record, id: 'Vother', sessionId: 'S-unknown' }, {} as VerificationView);
    expect(projector.stats().unlinkedVerifications).toBe(1);
  });

  test('saving the same run again sends nothing twice; a restart sends nothing from before its new binding', () => {
    const { exporter, projector, root, child } = loopScenario(null);
    const count = exporter.seen.length;
    projector.onRunSaved(root(true));
    projector.onRunSaved(child);
    expect(exporter.seen).toHaveLength(count);
    const later = harness({ now: ZERO + 60_000 });
    later.bind('loop', 'loop-root');
    later.projector.onRunSaved(root(true));
    later.projector.onRunSaved(child);
    expect(later.exporter.seen).toHaveLength(0);
  });

  test('a ledger that throws leaves the attempt not-linked and the run unaffected', () => {
    const { exporter, projector } = loopScenario({
      list: () => {
        throw new Error('ledger not ready');
      },
    });
    const generation = byEvent(exporter.wire(), '$ai_generation')[0];
    expect(generation.properties).toMatchObject({ nectovia_cost_state: 'not-linked', nectovia_outcome: 'answered-tool-call' });
    expect(projector.stats().failures).toBe(0);
  });
});

describe('failed attempts, parking and the managed route', () => {
  const turn = (step: StepRecord, events: HarnessEvent[], state: HarnessRun['state'] = 'reconcile_required') =>
    run({ id: 'turn-1', capabilityId: 'model-api-turn', input: { conversationRunId: 'lineage-1' }, steps: [step], events, state });
  const failing = (holds: ExposureReservation[]) => {
    seq = 0;
    const h = harness({ ledger: { list: () => holds } });
    h.bind('conversation', 'turn-1');
    const step = modelStep('model:0', { state: 'reconcile_required', output: null, origin: undefined });
    const events = [
      event('run.created', 1),
      event('step.started', 10, 'model:0', 1),
      event('step.reconcile_required', 20, 'model:0', 1, { errorType: 'ModelApiError', errorCode: 'aws_bedrock_http_500' }),
    ];
    h.projector.onRunSaved(turn(step, events));
    return { ...h, step, events };
  };
  const stepKey = exposureStepId((modelStep('model:0').intent.input as { request: never }).request);
  const attempt = { runId: 'turn-1', stepId: stepKey, attempt: 1, requestDigest: 'x' };

  test('the outcome comes from the hold: none, released, settled, uncertain', () => {
    const outcome = (holds: ExposureReservation[]) => byEvent(failing(holds).exporter.wire(), '$ai_generation')[0].properties;
    expect(outcome([])).toMatchObject({ nectovia_outcome: 'refused-before-send', nectovia_cost_state: 'not-linked', $ai_error: 'aws_bedrock_http_500' });
    expect(outcome([hold({ attempt, state: 'released', settledMicroUsd: null, usage: null })])).toMatchObject({ nectovia_outcome: 'not-charged', nectovia_cost_state: 'released' });
    expect(outcome([hold({ attempt })])).toMatchObject({ nectovia_outcome: 'answer-not-used', nectovia_cost_state: 'settled', nectovia_cost_micro_usd: 123 });
    const uncertain = outcome([hold({ attempt, state: 'uncertain', settledMicroUsd: null, usage: null })]);
    expect(uncertain).toMatchObject({ nectovia_outcome: 'unknown-outcome', nectovia_cost_state: 'uncertain' });
    expect(uncertain).not.toHaveProperty('nectovia_cost_micro_usd');
    expect(uncertain).not.toHaveProperty('$ai_input_tokens');
  });

  test('parked once per episode; a recovery and a new parking is a new episode; the reconcile cancel is not a second generation', () => {
    const { exporter, projector, step, events } = failing([]);
    const parked = () => byEvent(exporter.wire(), 'nectovia_run_parked');
    expect(parked()).toHaveLength(1);
    expect(parked()[0].properties).toMatchObject({ nectovia_step_kind: 'model', $ai_parent_id: traceIdFor(ENV, 'turn-1') });
    projector.onRunSaved(turn(step, events));
    expect(parked()).toHaveLength(1);
    // A person reconciles: the parked attempt is cancelled and the run recovers, then parks again.
    const recovered = [...events, event('step.cancelled', 30, 'model:0', 1), event('run.recovered', 31)];
    projector.onRunSaved(turn({ ...step, state: 'cancelled' }, recovered, 'queued'));
    expect(byEvent(exporter.wire(), '$ai_generation')).toHaveLength(1);
    const again = [...recovered, event('step.started', 40, 'model:0', 2), event('step.reconcile_required', 50, 'model:0', 2)];
    projector.onRunSaved(turn({ ...step, attempt: 2 }, again));
    expect(parked()).toHaveLength(2);
    expect(byEvent(exporter.wire(), '$ai_generation')).toHaveLength(2);
  });

  test('an attempt that started before the binding is never sent', () => {
    seq = 0;
    const h = harness({ now: ZERO + 100 });
    h.bind('conversation', 'turn-1');
    h.projector.onRunSaved(
      turn(modelStep('model:0'), [event('run.created', 1), event('step.started', 50, 'model:0', 1), event('step.succeeded', 200, 'model:0', 1)], 'running'),
    );
    expect(h.exporter.seen).toHaveLength(0);
  });

  test('a scripted adapter step is an application span, never a generation', () => {
    seq = 0;
    const h = harness();
    h.bind('conversation', 'turn-1');
    const scripted = modelStep('model:0', { intent: { ...modelStep('model:0').intent, name: 'native-fixture' }, origin: undefined });
    h.projector.onRunSaved(turn(scripted, [event('step.started', 10, 'model:0', 1), event('step.succeeded', 20, 'model:0', 1)], 'running'));
    const wire = h.exporter.wire();
    expect(byEvent(wire, '$ai_generation')).toHaveLength(0);
    expect(byEvent(wire, '$ai_span')[0].properties).toMatchObject({ nectovia_span_kind: 'scripted-step', $ai_span_name: 'scripted-step' });
  });

  test('host shapes: a registered tool with an application origin is a tool span; a model step reported as application is scripted (PH-07 F-1)', () => {
    seq = 0;
    const h = harness();
    h.bind('conversation', 'turn-1');
    const scripted = modelStep('model:0', { intent: { ...modelStep('model:0').intent, name: 'native-fixture' }, origin: applicationOrigin() });
    const direct = modelStep('model:1', { intent: { ...modelStep('model:1').intent, stepId: 'model:1' } });
    const tool = toolStep('tool:0', 'read_project_file');
    const unregistered = toolStep('tool:1', `${CANARY}_tool`);
    const events = [
      event('run.created', 1),
      event('step.started', 10, 'model:0', 1),
      event('step.succeeded', 20, 'model:0', 1),
      event('step.started', 30, 'tool:0', 1),
      event('step.succeeded', 40, 'tool:0', 1),
      event('step.started', 50, 'tool:1', 1),
      event('step.failed', 60, 'tool:1', 1),
      event('step.started', 70, 'model:1', 1),
      event('step.succeeded', 80, 'model:1', 1),
    ];
    h.projector.onRunSaved(
      run({ id: 'turn-1', capabilityId: 'model-api-turn', input: { conversationRunId: 'lineage-1' }, steps: [scripted, tool, unregistered, direct], events, state: 'running' }),
    );
    const wire = h.exporter.wire();
    expect(byEvent(wire, '$ai_span').map((item) => [item.properties.nectovia_span_kind, item.properties.$ai_span_name, item.properties.nectovia_step_state])).toEqual([
      ['scripted-step', 'scripted-step', 'succeeded'],
      ['tool', 'read_project_file', 'succeeded'],
      ['tool', 'other', 'failed'],
    ]);
    expect(byEvent(wire, '$ai_generation').map((item) => item.properties.nectovia_step)).toEqual(['model']);
    expect(encodeBatch(wire).toLowerCase()).not.toContain(CANARY.toLowerCase());
  });

  test('the plan call of a work loop is labelled model-plan; its act turns are model (PH-07 F-7)', () => {
    seq = 0;
    const h = harness();
    h.bind('loop', 'loop-root');
    const events = [
      event('run.created', 1),
      event('step.started', 10, 'model:plan', 1),
      event('step.succeeded', 20, 'model:plan', 1),
      event('step.started', 30, 'model:0', 1),
      event('step.succeeded', 40, 'model:0', 1),
    ];
    h.projector.onRunSaved(run({ steps: [modelStep('model:plan'), modelStep('model:0')], events }));
    expect(byEvent(h.exporter.wire(), '$ai_generation').map((item) => item.properties.nectovia_step)).toEqual(['model-plan', 'model']);
  });

  test('managed: the gateway’s settlement is the cost, so the desktop sends it as cost-pending', () => {
    seq = 0;
    const h = harness({ route: 'nectovia', routeKind: 'managed', ledger: { list: () => [hold({ attempt: { ...attempt } })] } });
    expect(h.bind('conversation', 'turn-1', 'nectovia-standard-1').eligible).toBe(true);
    h.projector.onRunSaved(turn(modelStep('model:0'), [event('step.started', 10, 'model:0', 1), event('step.succeeded', 20, 'model:0', 1)], 'running'));
    const properties = byEvent(h.exporter.wire(), '$ai_generation')[0].properties;
    expect(properties).toMatchObject({ nectovia_payer: 'managed', nectovia_route: 'nectovia', $ai_provider: 'nectovia', nectovia_cost_state: 'gateway-pending', $ai_input_tokens: 100 });
    expect(properties).not.toHaveProperty('$ai_total_cost_usd');
    expect(properties).not.toHaveProperty('nectovia_cost_micro_usd');
    expect(properties.nectovia_requested_model).toBe('nectovia-standard-1');
  });

  test('no canary reaches any event the projector built', () => {
    const { exporter } = failing([hold({ attempt })]);
    const body = encodeBatch(exporter.wire());
    expect(body).not.toContain(CANARY);
    expect(body.toLowerCase()).not.toContain(CANARY.toLowerCase());
  });
});
