/**
 * `nectovia-observation/1`: what may leave this machine as an observation of
 * admitted Nectovia Agent work (docs/implementation/2026-09-25-posthog-ph00-contract.md).
 *
 * Identifiers, revisions, counts and closed enumerations only. Nothing here can
 * hold a prompt, an answer, a tool argument or result, a path, a person's or a
 * business's name, a customer-chosen model name or an error message: the record
 * has no field that could carry one, and the wire builder
 * (`server/observability/wire.ts`) constructs a new object from this record's
 * named fields rather than copying anything whole.
 *
 * Unknown is a state, never a number. A value the provider, the runtime or an
 * external engine did not give is `{ known: false, why }`, and the serializer
 * leaves its property out instead of writing zero.
 *
 * Pure: no Node imports. The server derives identifiers and pseudonyms.
 */

export const OBSERVATION_CONTRACT = 'nectovia-observation/1' as const;

export type ObservationEnvironment = 'test' | 'development' | 'internal' | 'production';
export const OBSERVATION_ENVIRONMENTS: readonly ObservationEnvironment[] = Object.freeze([
  'test',
  'development',
  'internal',
  'production',
]);

/** Who the work belongs to, from the admission and the operator's configuration, never a request. */
export type ObservationClass = 'internal-synthetic' | 'internal' | 'customer-agent';
/** A label, not proof: a desktop host is customer-local unless the operator declared otherwise. */
export type SourceTrust = 'company-host' | 'client-reported';

/**
 * The model-API routes whose Agent work can be observed. `nectovia` is the
 * company-managed route through the account service's gateway
 * (docs/implementation/2026-09-25-managed-inference-gateway.md); the others run
 * on the business's own connection.
 */
export const OBSERVED_ROUTES = Object.freeze([
  'aws-bedrock',
  'azure-openai',
  'openrouter',
  'google-vertex',
  'nectovia',
] as const);
export type ObservedRoute = (typeof OBSERVED_ROUTES)[number];
export const MANAGED_ROUTE: ObservedRoute = 'nectovia';
export const isObservedRoute = (value: unknown): value is ObservedRoute =>
  typeof value === 'string' && (OBSERVED_ROUTES as readonly string[]).includes(value);

/** Who pays the provider. The managed gateway's ledger is authoritative for `managed`. */
export type ObservedPayer = 'managed' | 'byo';

export type ObservedSurface = 'conversation' | 'work' | 'team' | 'loop' | 'automation' | 'ask' | 'other';

/** A closed set, so the reason itself can leave the machine. */
export type UnknownReason =
  | 'not-reported'
  | 'not-exposed'
  | 'customer-named'
  | 'not-linked'
  | 'usage-refused'
  | 'cost-pending'
  | 'cost-uncertain'
  | 'not-applicable';

export type Observed<T> =
  | { readonly known: true; readonly value: T }
  | { readonly known: false; readonly why: UnknownReason };

export const known = <T>(value: T): Observed<T> => ({ known: true, value });
export const unknown = <T = never>(why: UnknownReason): Observed<T> => ({ known: false, why });

export type ObservedCapability =
  | 'model-api-conversation'
  | 'model-api-turn'
  | 'model-api-team-work'
  | 'engine-text-turn'
  | 'diomedes-loop'
  | 'diomedes-loop-delegate'
  | 'diomedes-loop-worker'
  | 'diomedes-loop-advisor'
  | 'other';
export const OBSERVED_CAPABILITIES: readonly ObservedCapability[] = Object.freeze([
  'model-api-conversation',
  'model-api-turn',
  'model-api-team-work',
  'engine-text-turn',
  'diomedes-loop',
  'diomedes-loop-delegate',
  'diomedes-loop-worker',
  'diomedes-loop-advisor',
]);

/**
 * What one model attempt came to, read from the step state, the spend
 * reservation and the recorded response type. Every failed model-API step parks
 * as `reconcile_required` whatever was sent (`run-service.ts:198-200`), so the
 * step state alone never tells a refusal from a lost answer; the reservation does.
 */
export type AttemptOutcome =
  | 'answered-final'
  | 'answered-tool-call'
  | 'refused-before-send'
  | 'not-charged'
  | 'answer-not-used'
  | 'unknown-outcome'
  | 'cancelled';

/**
 * Where the attempt's cost stands. `gateway-pending`: a managed call, whose
 * authoritative cost is the gateway's settlement, not this machine's ledger.
 */
export type CostState =
  | 'settled'
  | 'released'
  | 'pending'
  | 'uncertain'
  | 'written-off'
  | 'not-linked'
  | 'gateway-pending';

export type SpanKind = 'tool' | 'delegate' | 'verification' | 'scripted-step' | 'external-worker';

export type ObservedStepState =
  | 'succeeded'
  | 'retry_wait'
  | 'reconcile_required'
  | 'waiting_event'
  | 'failed'
  | 'cancelled';

export interface UsageCountsObserved {
  readonly inputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  readonly outputTokens: number;
  readonly reasoningTokens: number;
}

/** The exportable facts of one bound scope. Host-only facts (ids, person, connection) are not here. */
export interface ScopeFacts {
  readonly class: ObservationClass;
  readonly synthetic: boolean;
  readonly sourceTrust: SourceTrust;
  readonly environment: ObservationEnvironment;
  /** `oorg_` + 32 hex: a keyed pseudonym of the organization. */
  readonly organizationKey: string;
  /** The control plane's opaque admission id. */
  readonly admissionId: string;
  readonly surface: ObservedSurface;
  readonly route: ObservedRoute;
  readonly payer: ObservedPayer;
  /** A `PLAN_TEMPLATES` id, else `other`, else `none`. */
  readonly plan: string;
  /** The routing tier policy revision the admission pinned. Not a telemetry policy. */
  readonly policyRevision: number;
  /** The customer telemetry policy revision; null for internal classes. */
  readonly telemetryRevision: number | null;
}

export interface ObservationIds {
  /** A deterministic UUID (version 8): the PostHog event uuid. */
  readonly uuid: string;
  /** `otr_` + 32 hex. */
  readonly traceId: string;
  /** `osp_` + 32 hex; a trace's own span id equals its trace id. */
  readonly spanId: string;
  readonly parentId: string | null;
  /** `oss_` + 32 hex; a conversation's lineage. */
  readonly sessionId: string | null;
}

interface ObservationBase {
  readonly contract: typeof OBSERVATION_CONTRACT;
  readonly ids: ObservationIds;
  /** The recorded event's own time, ISO UTC. Never the time of export. */
  readonly at: string;
  readonly scope: ScopeFacts;
  /** The app version. */
  readonly build: string;
  readonly capability: ObservedCapability;
}

export interface TraceObservation extends ObservationBase {
  readonly kind: 'trace';
  readonly outcome: 'completed' | 'failed' | 'cancelled';
  readonly durationMs: Observed<number>;
  readonly modelSteps: number;
  readonly toolSteps: number;
  readonly childRuns: number;
  readonly errorClass: Observed<string>;
  readonly loopStop: Observed<'turn-limit' | 'budget' | 'worker'>;
}

export interface GenerationObservation extends ObservationBase {
  readonly kind: 'generation';
  readonly step: 'model' | 'model-plan' | 'text-dispatch';
  readonly attempt: number;
  readonly stepState: ObservedStepState;
  readonly outcome: AttemptOutcome;
  readonly errorCode: Observed<string>;
  readonly durationMs: Observed<number>;
  readonly requestedModel: Observed<string>;
  readonly reportedModel: Observed<string>;
  readonly usage: Observed<UsageCountsObserved>;
  /** Settled or written-off only; `rateCardKey` is `rc_` + 16 hex. */
  readonly cost: Observed<{ readonly microUsd: number; readonly rateCardKey: string }>;
  readonly costState: CostState;
}

export interface VerificationFacts {
  readonly state: 'verified' | 'not-verified' | 'failed' | 'uncertain';
  readonly rule: string;
  readonly declared: number;
  readonly passed: number;
  readonly failed: number;
  readonly incomplete: number;
  readonly requestedBy: 'you' | 'diomedes-loop';
}

export interface SpanObservation extends ObservationBase {
  readonly kind: 'span';
  readonly spanKind: SpanKind;
  /** A tool id from the allowlist, else `other`; fixed labels for every other kind. */
  readonly name: string;
  readonly attempt: number | null;
  readonly stepState: Observed<ObservedStepState>;
  readonly durationMs: Observed<number>;
  readonly effect: Observed<{
    readonly effectClass: string;
    readonly status: 'applied' | 'failed' | 'uncertain' | 'abandoned' | 'intended';
  }>;
  readonly authorization: Observed<'approval' | 'permission' | 'host' | 'none'>;
  readonly verification: Observed<VerificationFacts>;
  readonly errorCode: Observed<string>;
}

export interface ParkedObservation extends ObservationBase {
  readonly kind: 'parked';
  readonly stepKind: 'model' | 'tool' | 'transform' | 'approval' | 'wait';
}

/** A late settlement of an attempt whose cost was unknown when its generation was sent. */
export interface CostReconciledObservation extends ObservationBase {
  readonly kind: 'cost-reconciled';
  /** The generation's own span id: the join key. */
  readonly generationSpanId: string;
  readonly reconciledFrom: 'response' | 'owner-entry' | 'write-off';
  readonly costState: 'settled' | 'written-off';
  readonly cost: Observed<{ readonly microUsd: number; readonly rateCardKey: string }>;
}

export type Observation =
  | TraceObservation
  | GenerationObservation
  | SpanObservation
  | ParkedObservation
  | CostReconciledObservation;
