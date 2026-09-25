# PostHog observation: PH-00 implementation contract

| | |
|---|---|
| Work order | PH-00, handoff NC-PH-2026-09-25.3 |
| Feature | `posthog-observation` |
| Branch | `feature/posthog-observation`, from origin/main `844cf0c` |
| Worktree | `F:/Diomedes/diomedes-wt/posthog-observation` |
| Owner | Andrew |
| Author | Opus 5.5, PH-00 integration architect |
| Status | Contract for review. Nothing here is implemented. PH-01 waits for this review. |

Canonical versions read: Core Pillars 2026-09-22.1, Live Roadmap 2026-09-25.2, Project Memory 2026-09-25.2. Plan and prompt pack: NC-PH-2026-09-25.3.

What this session checked, and what it did not:

- Source: read from this worktree at `844cf0c` only. Every `file:line` below is from that commit.
- PostHog documentation: the manual-capture, capture/batch API and cost-calculation pages were read through Context7 on 2026-09-25. That confirmed `$ai_latency` is in seconds, `/batch/` limits a request body to 20 MB, `$process_person_profile: false` suppresses person profiles, and `$ai_cache_reporting_exclusive` sets how cache tokens are counted.
- Not done: no PostHog account, project or billing readback, no network call to PostHog, no credentials handled, no tests or builds run. The heavy slot was held elsewhere, and this work order needs neither. Credit balance, expiry and product limits remain unverified. That blocks live export, not this contract.
- Active claims and open PRs: no unreleased coordination claim covers any path claimed here. The only open PR, #152 (`feature/ops-company-backend`), touches `services/control-plane/src/commercial.ts` and `faux/seed.ts`. This contract claims neither.

## 1. Source map

HarnessRun identity is not business identity. Every Agent run on the mapped paths uses `localHarnessPrincipal` (`server/harness/bridge.ts:32-38`: tenant `local`, principal `local-client`). That holds for conversation turns (`server/harness/model-session-run.ts:703`), Work turns (`server/harness/text-route.ts:153`) and loops (`server/native-loop-routes.ts:387`). Loop delegates reuse their parent's principal (`server/harness/capabilities/native-loop.ts:837`). The business, the person and the plan come only from the Agent admission. `HarnessRun.tenantId` is never exported as a tenant.

| Observation point | Existing owner (source of the recorded fact) | Fact read | Sole emitter |
|---|---|---|---|
| Agent admission, which becomes the observation scope | `AccountAgentGate.check` `server/accounts/agent-gate.ts:60-74` → `AccountSessionService.admitAgent` `server/accounts/session.ts:465-512` → control plane `CommercialService.admitAgent` `services/control-plane/src/commercial.ts:418-462` (decision `services/control-plane/contract/contract.ts:512-546`) | `admissionId`, `organizationId`, `planId`, `policyRevision`. The gate returns `void` today and drops all four (`agent-gate.ts:72`) | `ObservationScopes.bind`, called at the end of `EngineService.admitModelApi` (`server/engines/service.ts:1985-1991`) after the route, credential and spend checks pass |
| Root job trace (`$ai_trace`) | `RunService.complete/fail/cancel` `server/harness/run-service.ts:1316-1350`, `1223-1256`. Durable write through `ProjectRunStore.write/create` `server/harness/host.ts:314-322`, `361-366`, fanned out by `files.saved` `host.ts:527-533` | `run.completed / run.failed / run.cancelled` event, `createdAt`, step counts, `failure.name` | `ObservationProjector.onRunSaved` |
| Model attempt (`$ai_generation`) | Step commits `run-service.ts:1050-1079` (success) and `1094-1136` (failure). NativeAgent `model:<i>` `server/harness/native-agent.ts:225-281`. H13 loop `model:plan` and `model:<n>` `server/harness/native-loop.ts:402-411`. Work `text:dispatch` `server/harness/text-route.ts:50-51`, `server/engines/service.ts:2113-2129` | Step state, attempt, `startedAt/endedAt`, `origin.model.requested/reported` (`shared/attribution.ts:5-30`), `response.type` in the step output | `ObservationProjector.onRunSaved` |
| Provider usage and cost | `respondStream` settles, releases or marks the hold uncertain before it returns or throws: `server/engines/model-api-core.ts:743-790`, `1005-1028`. Ledger record `ExposureReservation` `server/spend-exposure.ts:121-152`, listed by `SpendExposure.list` `:931` | The `nectovia-usage/1` counts, including reasoning (`shared/usage-contract.ts:11-15`), plus `settledMicroUsd`, `state`, `rateCardVersion`, `jobId`. `ModelResult.usage` in the step output drops `reasoningTokens` and has no cost (`shared/harness.ts:283-288`, `native-agent.ts:269-278`), so it is **not** a source | The projector, by a read-only ledger lookup. It never writes the ledger |
| Registered tool (`$ai_span`) | `ToolRegistry.dispatch` through `RunService.step` with `effectRecord` `run-service.ts:925-947`, `1070-1077`, `1118-1125` | Step state, `intent.name`, `EffectRecord.effectClass/status`, authorization kind (prefix only) | `ObservationProjector.onRunSaved` |
| Child runs | Conversation turn run input `conversationRunId` `server/harness/model-session-run.ts:829-845`. Loop delegate input `parent{runId,stepId}`, `rootRunId` `server/harness/capabilities/native-loop.ts:870-896` | `run.input` (recorded) | The projector resolves a child's trace root. It never parses run ids |
| Verification (H17) | `VerificationService.run` writes the record, then persists: `server/verification/service.ts:300-328`. Loop finish gate `capabilities/native-loop.ts:1176-1210` | `VerificationRecord.id/sessionId/checks/requestedBy`, `verificationOf(...).state/rule` (`shared/verification.ts:145-164`) | A `VerificationService` observer callback, run after persist and forwarded to the projector |
| Parked run (`reconcile_required`) | `run-service.ts:837-846`, `1130-1134` | `step.reconcile_required` event | `ObservationProjector.onRunSaved` (operational event) |
| Late cost reconciliation | `SpendExposure.reconcile / writeOff` `spend-exposure.ts:1165-1210` | `reconciledFrom`, `settledMicroUsd` | PH-02. Frozen in section 4, not built in PH-01 |
| Logout, account switch, revocation | `AccountSessionService.end/begin` `session.ts:357-371`, `277-300`. Cached entitlement `session.ts:437-448`. Active workspace `WorkspaceService.active()` | `personId()`, `entitlement(org)`, active organization | Exporter recheck (pull). `onProjection` is a single slot already taken (`server/app.ts:771`) and is not touched |

Existing code this contract deliberately does not build on:

- `governanceHook`, `installGovernance` and `resolveExecution` (`server/harness/lifecycle.ts`, `server/execution.ts`) are not wired into any production path.
- `shared/execution.ts:503-547` `Telemetry/telemetryOf` is only exercised by `tests/execution.test.ts` and describes Agent evidence, not attempts. Its rule, identifiers, revisions and counts only, is kept. Its `Known<T>` carries prose reasons, so the record below uses coded reasons instead.

Named dependencies that do not exist today:

| # | Missing | Evidence | Effect on this contract |
|---|---|---|---|
| D1 | A server-authoritative customer **telemetry or data-export policy** | `AccessView` (`shared/access.ts:265-283`) and the admission record (`commercial.ts:170-184`) carry none. The pinned `policyRevision` is the **routing tier** policy (`commercial.ts:442`, `routingPolicy` `:468`) | Customer export is denied as `telemetry-policy-absent`. PH-01 ships a port whose production implementation returns `null`, plus a fixture in tests |
| D2 | A control-plane marker that work is company-internal | The admission pins have no grant source. The faux demo business is plan `business` with source `internal-test` (`services/control-plane/src/faux/seed.ts:113`), so `planId` cannot identify internal work | Internal is decided by operator configuration plus an admitted decision (section 3). The stronger marker is follow-up work in the control plane, to be coordinated with PR #152 |
| D3 | A trusted host identity on the desktop | The desktop host is customer-local. Its tenant is `local` (`bridge.ts:32-38`) | Every host observation is `client-reported` unless the operator declares a company host. Source trust is a label, not proof |
| D4 | A read port for the managed (Diomedes-funded) ledger | Nothing on this host is Diomedes-funded yet (`agent-gate.ts:66-68`). The gate hard-codes `routeKind: 'byo'` | Only `byo` routes are observable. Managed-route cost will be `unknown('not-linked')` until the port exists |
| D5 | A company collector that authenticates, validates and rate-limits customer-host events fleet-wide | None under `services/control-plane/src` | Customer export stays off in production configuration even after D1 |
| D6 | A PostHog vendor entry and a funded pilot record | `VENDOR_ALLOWLIST` has no PostHog entry, and its test enforces zero fixed spend (`services/control-plane/contract/vendors.ts`, `tests/b00-control-plane-contract.test.ts:300-303`) | Live export (PH-02) waits for it. PH-01 needs neither |
| D7 | An `isPaid` flag | Does not exist, and is not needed. Entitlement is `AccessView.features ∋ 'nectovia-agent'` plus the admission decision | PH-01 must not add one |

## 2. Signatures

### 2.1 Gate change (the one edit everything else depends on)

```ts
// server/accounts/agent-gate.ts
export interface AdmittedAgentWork {
  readonly admissionId: string;          // control-plane opaque id, `agent_admission_<uuid>`
  readonly organizationId: string;
  readonly personId: string;             // AccountSessionService.personId() at admission
  readonly planId: string | null;
  readonly policyRevision: number;       // routing tier policy revision; NOT a telemetry policy
  readonly routeKind: AgentRouteKind;    // 'byo' on this host today
  readonly surface: AgentSurface;
}
export interface AgentGatePort {
  /** Resolves with the admitted decision; throws an EngineError that sends nothing otherwise. */
  check(work: AgentWork): Promise<AdmittedAgentWork>;
}
```

`EngineService.admitAgent` (`service.ts:1997-2006`) returns `AdmittedAgentWork | null`. It returns `null` when there is no gate or when the call is the host connection test (`HOST_TEST_PROJECT` with `TEST_PROMPT`). `null` means no scope and no capture.

### 2.2 Shared record: `shared/observability.ts` (pure, no Node imports)

```ts
export const OBSERVATION_CONTRACT = 'nectovia-observation/1' as const;

export type ObservationEnvironment = 'test' | 'development' | 'internal' | 'production';
export type ObservationClass = 'internal-synthetic' | 'internal' | 'customer-agent';
export type SourceTrust = 'company-host' | 'client-reported';

/** A closed set, so the reason can leave the machine. Unknown is never zero. */
export type UnknownReason =
  | 'not-reported' | 'not-exposed' | 'customer-named' | 'not-linked'
  | 'usage-refused' | 'cost-pending' | 'cost-uncertain' | 'not-applicable';
export type Observed<T> =
  | { readonly known: true; readonly value: T }
  | { readonly known: false; readonly why: UnknownReason };

export type ObservedCapability =
  | 'model-api-conversation' | 'model-api-turn' | 'model-api-team-work'
  | 'engine-text-turn' | 'diomedes-loop' | 'diomedes-loop-delegate' | 'other';
export type AttemptOutcome =
  | 'answered-final' | 'answered-tool-call'   // step succeeded; response.type
  | 'refused-before-send'                     // step failed and no reservation exists
  | 'not-charged'                             // reservation released
  | 'answer-not-used'                         // reservation settled, step failed
  | 'unknown-outcome'                         // reservation pending or uncertain
  | 'cancelled';
export type CostState = 'settled' | 'released' | 'pending' | 'uncertain' | 'written-off' | 'not-linked';
export type SpanKind = 'tool' | 'delegate' | 'verification' | 'scripted-step' | 'external-worker';

/** Facts copied from the bound scope; host-only fields never appear here. */
export interface ScopeFacts {
  readonly class: ObservationClass;
  readonly synthetic: boolean;
  readonly sourceTrust: SourceTrust;
  readonly environment: ObservationEnvironment;
  readonly organizationKey: string;          // 'oorg_' + 32 hex, keyed pseudonym (4.1)
  readonly admissionId: string;
  readonly surface: 'conversation' | 'work' | 'team' | 'loop' | 'automation' | 'ask' | 'other';
  readonly route: 'aws-bedrock' | 'azure-openai' | 'openrouter' | 'google-vertex';
  readonly payer: 'byo';
  readonly plan: string;                     // a PLAN_TEMPLATES id, else 'other'
  readonly policyRevision: number;
  readonly telemetryRevision: number | null; // null for internal classes
}

export interface ObservationIds {
  readonly uuid: string;            // deterministic UUID, version 8; the PostHog event uuid
  readonly traceId: string;         // 'otr_' + 32 hex
  readonly spanId: string;          // 'osp_' + 32 hex (for a trace: equal to traceId)
  readonly parentId: string | null;
  readonly sessionId: string | null; // 'oss_' + 32 hex; conversation lineage only
}

interface Base {
  readonly contract: typeof OBSERVATION_CONTRACT;
  readonly ids: ObservationIds;
  readonly at: string;              // the recorded event's own `at`, ISO UTC; never export time
  readonly scope: ScopeFacts;
  readonly build: string;           // BuildIdentity version (server/build-identity.ts)
  readonly capability: ObservedCapability;
}
export interface TraceObservation extends Base {
  readonly kind: 'trace';
  readonly outcome: 'completed' | 'failed' | 'cancelled';
  readonly durationMs: Observed<number>;      // createdAt → terminal event `at`
  readonly modelSteps: number; readonly toolSteps: number; readonly childRuns: number;
  readonly errorClass: Observed<string>;      // failure.name if allowlisted; never the message
  readonly loopStop: Observed<'turn-limit' | 'budget' | 'worker'>;
}
export interface GenerationObservation extends Base {
  readonly kind: 'generation';
  readonly step: 'model' | 'model-plan' | 'text-dispatch';
  readonly attempt: number;
  readonly stepState: 'succeeded' | 'retry_wait' | 'reconcile_required' | 'failed' | 'cancelled';
  readonly outcome: AttemptOutcome;
  readonly errorCode: Observed<string>;
  readonly durationMs: Observed<number>;      // step startedAt → endedAt
  readonly requestedModel: Observed<string>;
  readonly reportedModel: Observed<string>;
  readonly usage: Observed<{ inputTokens: number; cacheReadTokens: number; cacheWriteTokens: number;
                             outputTokens: number; reasoningTokens: number }>; // nectovia-usage/1, from the ledger
  readonly cost: Observed<{ microUsd: number; rateCardKey: string }>;          // settled or written-off only
  readonly costState: CostState;
}
export interface SpanObservation extends Base {
  readonly kind: 'span';
  readonly spanKind: SpanKind;
  readonly name: string;                      // tool id from the allowlist, else 'other'; fixed labels otherwise
  readonly attempt: number | null;
  readonly stepState: Observed<string>;
  readonly durationMs: Observed<number>;
  readonly effect: Observed<{ effectClass: string; status: 'applied' | 'failed' | 'uncertain' | 'abandoned' }>;
  readonly authorization: Observed<'approval' | 'permission' | 'host' | 'none'>;
  readonly verification: Observed<{ state: 'verified' | 'not-verified' | 'failed' | 'uncertain';
                                    rule: string; declared: number; passed: number; failed: number;
                                    incomplete: number; requestedBy: 'you' | 'diomedes-loop' }>;
  readonly errorCode: Observed<string>;
}
export interface ParkedObservation extends Base {
  readonly kind: 'parked';
  readonly stepKind: 'model' | 'tool' | 'transform' | 'approval' | 'wait';
}
export type Observation = TraceObservation | GenerationObservation | SpanObservation | ParkedObservation;
```

### 2.3 Eligibility: `server/observability/eligibility.ts`

```ts
export interface ObservationOperatorConfig {
  readonly mode: 'off' | 'memory' | 'posthog';             // NECTOVIA_OBSERVATION, default 'off'
  readonly environment: ObservationEnvironment;             // NECTOVIA_OBSERVATION_ENVIRONMENT, default 'development'
  readonly companyHost: boolean;                            // NECTOVIA_OBSERVATION_COMPANY_HOST === '1'
  readonly internalOrganizations: ReadonlySet<string>;      // NECTOVIA_OBSERVATION_INTERNAL_ORGS, comma list
  readonly pseudonymKey: Uint8Array | null;                 // NECTOVIA_OBSERVATION_PSEUDONYM_KEY (hex, ≥ 32 bytes)
  readonly customerExport: boolean;                         // never read from env; false in production
}
/** Read once at startup. Never from a request, the renderer, settings or a project file. */
export function operatorConfigFromEnv(env: NodeJS.ProcessEnv): ObservationOperatorConfig;

export interface TelemetryPolicy {
  readonly organizationId: string; readonly revision: number;
  readonly export: 'none' | 'metadata'; readonly source: 'account-service';
}
export interface TelemetryPolicyPort { policyFor(organizationId: string): TelemetryPolicy | null }
export const ABSENT_TELEMETRY_POLICY: TelemetryPolicyPort; // production until D1: always null

export type ObservationDenial =
  | 'observation-off' | 'no-admission' | 'route-not-observable' | 'route-kind-not-observable'
  | 'account-service-unavailable' | 'not-company-host' | 'faux-account-not-internal'
  | 'pseudonym-key-missing' | 'customer-export-disabled' | 'telemetry-policy-absent' | 'telemetry-policy-none'
  | 'signed-out' | 'person-changed' | 'workspace-changed' | 'entitlement-inactive' | 'no-longer-internal';

export interface ObservationScope extends ScopeFactsHostOnly {}
interface ScopeFactsHostOnly {
  readonly scopeId: string;                    // 'osc_' + 24 hex of sha256(admissionId)
  readonly facts: ScopeFacts;                  // the exportable part
  readonly organizationId: string;             // host-only from here down
  readonly personId: string;
  readonly activeOrganizationAtBind: string | null;
  readonly runId: string;
  readonly connectionId: string;
  readonly boundAt: number;                    // host epoch ms
}
export type EligibilityDecision =
  | { readonly eligible: true; readonly scope: ObservationScope }
  | { readonly eligible: false; readonly denial: ObservationDenial };

export interface EligibilityInput {
  readonly operator: ObservationOperatorConfig;
  readonly backend: 'faux' | 'cloud' | 'unavailable';      // AccountBackend.view().kind
  readonly admission: AdmittedAgentWork | null;
  readonly work: { readonly runId: string; readonly route: string; readonly connectionId: string };
  readonly activeOrganizationId: string | null;
  readonly telemetry: TelemetryPolicyPort;
  readonly now: number;
}
export function decideObservationEligibility(input: EligibilityInput): EligibilityDecision;

export interface ObservationAuthorityPort {
  personId(): string | null;                                   // AccountSessionService.personId()
  activeOrganizationId(): string | null;                       // WorkspaceService.active()
  entitlement(organizationId: string): { agent: boolean; state: string; revision: number } | null; // session.entitlement()
  readonly telemetry: TelemetryPolicyPort;
}
export type ScopeRecheck = { readonly live: true } | { readonly live: false; readonly denial: ObservationDenial };
export function recheckScope(scope: ObservationScope, authority: ObservationAuthorityPort,
                             operator: ObservationOperatorConfig): ScopeRecheck;
```

No input to either function is derived from an HTTP request, the renderer, a run's `input` or a model message. That is the structural answer to spoofed client flags.

### 2.4 Scopes and projector: `server/observability/scopes.ts`, `projector.ts`

```ts
export class ObservationScopes {
  /** Called by EngineService.admitModelApi after every check passed. No-op when mode is 'off'. */
  bind(input: Omit<EligibilityInput, 'operator' | 'telemetry' | 'now'>): EligibilityDecision;
  /** run.id, else input.conversationRunId (model-api-turn), else input.rootRunId (loop delegate). */
  scopeFor(run: HarnessRun): ObservationScope | null;
  /** Turn run → itself; loop delegate → input.rootRunId; otherwise run.id. */
  traceRootOf(run: HarnessRun): string;
  /** Ends every scope failing recheck; the exporter discards their queued events. */
  sweep(reason: 'recheck'): number;
}
export class ObservationProjector {
  constructor(deps: { scopes: ObservationScopes; ledger: Pick<SpendExposure, 'list'>;
                      exporter: ObservationExporter; build: string; clock: () => number;
                      pseudonym: (organizationId: string) => string });
  /** Synchronous, never throws, never awaits. The ledger read runs detached with its own catch. */
  onRunSaved(run: HarnessRun): void;
  onVerification(record: VerificationRecord, state: VerificationState, rule: VerificationRule): void;
}
```

### 2.5 Exporter port: `server/observability/exporter.ts`, `wire.ts`

```ts
export type DropReason =
  | 'observation-off' | 'oversized' | 'queue-full' | 'scope-ended' | 'expired' | 'rejected'
  | 'retries-exhausted' | 'retry-after-too-long' | 'budget' | 'funding' | 'shutdown' | 'encode-failed';
export interface ObservationHealth {
  readonly state: 'off' | 'memory' | 'exporting' | 'paused' | 'disabled:funding' | 'disabled:budget';
  readonly enqueued: number; readonly exported: number;
  readonly dropped: Readonly<Record<DropReason, number>>;
  readonly denied: Readonly<Partial<Record<ObservationDenial, number>>>;
  readonly queued: number; readonly queuedBytes: number;
  readonly lastFailure: 'network' | 'timeout' | 'http-429' | 'http-4xx' | 'http-5xx' | null;
}
export interface ObservationExporter {
  /** O(1), synchronous; never throws, never awaits I/O, never blocks the caller. */
  enqueue(observation: Observation, scope: ObservationScope): void;
  /** Resolves by the deadline even when the transport hangs. */
  flush(deadlineMs: number): Promise<void>;
  /** Drops queued events whose scope fails the predicate; returns the count. */
  discard(ended: (scope: ObservationScope) => boolean, reason: DropReason): number;
  health(): ObservationHealth;        // local only; never enqueued as an observation
  close(deadlineMs: number): Promise<void>;
}
export class NoopObservationExporter implements ObservationExporter {}   // counts 'observation-off'
export class MemoryObservationExporter implements ObservationExporter {
  /** The exact UTF-8 batch bodies the PostHog transport would send, minus api_key. */
  readonly batches: readonly string[];
}

// wire.ts: the only place PostHog names appear
export interface PostHogWireEvent {
  readonly event: '$ai_trace' | '$ai_generation' | '$ai_span' | 'nectovia_run_parked';
  readonly uuid: string;
  readonly timestamp: string;
  readonly properties: Readonly<Record<string, string | number | boolean | null>>; // flat; no nested objects
}
export function toWireEvent(observation: Observation): PostHogWireEvent; // builds a new object from the allowlist
export function encodeBatch(events: readonly PostHogWireEvent[]): string;  // {"batch":[...]}; api_key added by PH-02 at send
```

## 3. Authorization: where it is verified and rechecked

Observation can start in exactly one place: `ObservationScopes.bind`, called at the end of `EngineService.admitModelApi`. Every other place only reads a scope or ends one.

**Company-internal work.** Verified at bind, in `decideObservationEligibility`. All of the following must hold:

1. An admitted decision came back from the account service. That service verified membership and the `nectovia-agent` feature server-side (`commercial.ts:418-462`).
2. The admission's organization is in the operator's `internalOrganizations`.
3. The operator declared `companyHost`.
4. A pseudonym key is present.

A faux (test) account service yields `internal-synthetic` with `synthetic: true`. A cloud service yields `internal`. Rechecked at `enqueue` and immediately before each send by `recheckScope`: same person, same active workspace as at bind, cached entitlement `agent && state === 'active'`, and the organization still internal. Not verified: that the machine is actually a company machine (D3). That is bounded by the capture credential living only in operator configuration (PH-02) and by labelling `source_trust`.

**Customer Agent work.** Entitlement is verified by the account service at every `admit` phase: each message, Work turn, team turn, loop start and loop resume (`service.ts:2033`, `2113`, `2244`, `2292`). The telemetry policy is read through `TelemetryPolicyPort` at bind, at enqueue and before each send. Its production implementation returns `null`, so every customer bind is denied `telemetry-policy-absent` until D1 exists. `customerExport` is also `false` in production until D5 exists. Tests exercise the customer path with a fixture policy port and a fixture config. Neither ships.

The recheck reads `AccountSessionService.entitlement()`, which is the last cached answer. It is refreshed on sign-in, `reload()` and `setMember()`, not by a live call. A revocation therefore ends optional export at the next reload or the next admission, whichever comes first. The admission itself stays the strongest live signal.

**Free, Personal and direct-engine work.** These produce no admission. The gate refuses Free and no-plan organizations. Personal work throws `AGENT_NOT_INCLUDED` before the service is asked (`agent-gate.ts:62`). Direct engines (Claude, Codex, OpenCode, ACP, `engine-text-turn` on a non-model-API route) never call `admitModelApi`. The host connection test returns `null`. With no admission, `bind` is never reached, `scopeFor` returns `null`, and the projector makes zero exporter calls. With the default `mode: 'off'`, no projector or scopes are constructed at all. A subscriber gets the same result in a Personal workspace or on a direct engine.

**Binding keys, as they actually are.** Scopes bind by the run id each caller passes. The admission's own `rootJobId` stays what it is today, because the admission record belongs to the control plane.

| Surface | Scope bound to | Trace root | Note |
|---|---|---|---|
| Conversation | lineage run id (`service.ts:2033`) | each turn run; `$ai_session_id` = lineage | Turn runs resolve through `input.conversationRunId` |
| Work | `textRunId` (`service.ts:2113`) | the run | |
| Team | `teamWorkRunId(projectId, requestId)` | the run | The admission's `rootJobId` is `input.requestId` (`service.ts:2244`), so binding by `rootJobId` would miss this run |
| Loop | `request.runId` (`service.ts:2292`) | the loop run | A delegate admits under its own child run id; its trace root is `input.rootRunId` |

## 4. Frozen decisions

### 4.1 Identity

Every derived id is `hex32(sha256('nectovia-observation/1|' + kind + '|' + environment + '|' + key))`.

| Id | Key |
|---|---|
| `traceId` (`otr_`) | trace-root run id |
| `spanId` (`osp_`) | `runId|stepId|attempt` |
| `sessionId` (`oss_`) | conversation lineage run id |
| `uuid` | `eventKind|spanOrTraceId|terminalEventSeq`, formatted as a UUID with version nibble 8 and variant `10` |

- **Parent.** A root-run step's `$ai_parent_id` is the `traceId`. A loop delegate's steps are parented to the delegate step span of the attempt whose `step.started` precedes the child's `run.created`, read from the parent run record.
- **`distinct_id`** is `'oorg_' + hex32(HMAC-SHA256(pseudonymKey, organizationId))`, and every event carries `$process_person_profile: false`. Person ids, run ids, project ids, connection ids, rate-card versions, paths and names are never sent raw.
- **Allowed raw values.** Only the control-plane `admissionId` and enumerations from closed sets are sent raw. Rate cards travel as `rateCardKey` = `rc_` + 16 hex, because Azure and OpenRouter versions embed the owner's model id (`server/engines/azure-openai.ts:136`, `server/engines/openrouter.ts:125`).
- **Replays and retries.** A replayed step commits no event (`run-service.ts:817-822`), so it cannot re-emit. A retry is a new attempt, so it gets a new span and a new uuid. The projector keeps a per-run `lastSeq` cursor and a bounded uuid set of 10,000 entries. PostHog deduplication by uuid is best effort. Exactly-once delivery is not promised.
- **After a restart** cursors and scopes are empty. Only attempts whose `step.started.at >= scope.boundAt` are projected. A resumed loop re-admits and rebinds, so earlier steps and pre-upgrade history are never uploaded.

### 4.2 Units and time

- Internally, durations are integer milliseconds from the RunService clock. The wire converts once: `$ai_latency = durationMs / 1000` (seconds, float).
- Event `timestamp` is the recorded event's own `at`. It is preserved across export attempts.
- `$ai_time_to_first_token` is not recorded, so it is never sent.
- Approval waits are outside a step attempt, because an attempt starts after approval (`run-service.ts:859-897`).

### 4.3 Tokens and cost

These come from the ledger reservation only. The join is `(scope.connectionId, attempt.runId === run.id, attempt.stepId)`:

- NativeAgent and loop steps: `stepId = exposureStepId(step.intent.input.request)` = `model@` + first 24 hex of `digest(messages)`. The function is extracted from `server/harness/model-api-adapter.ts:191-200`, so the adapter and the projector share one derivation.
- Work: `stepId = 'text:dispatch'`, with `attempt === step.attempt` (`service.ts:2129`).
- If the input does not parse, or no record matches, the step is `costState: 'not-linked'` and usage and cost are unknown.

| Wire property | Source |
|---|---|
| `$ai_input_tokens` | `inputTokens` (includes cache parts) |
| `$ai_cache_read_input_tokens` | `cacheReadTokens` |
| `$ai_cache_creation_input_tokens` | `cacheWriteTokens` |
| `$ai_cache_reporting_exclusive` | `false` (always) |
| `$ai_output_tokens` | `outputTokens` (includes reasoning) |
| `nectovia_reasoning_tokens` | `reasoningTokens`. It is not sent as `$ai_reasoning_tokens` until PH-02 confirms PostHog does not add it to output and price it twice |
| `nectovia_cost_micro_usd` | `settledMicroUsd` (integer). This is the canonical company cost |
| `$ai_total_cost_usd` | `settledMicroUsd / 1e6`, only when `costState` is `settled` or `written-off` |
| `$ai_input_cost_usd`, `$ai_output_cost_usd` | never in PH-01; no component split is recorded |
| `$ai_provider` | the route id (`aws-bedrock` …), not a vendor name |

PH-04 metrics read only `nectovia_cost_*`, never PostHog's own price estimate. A `settled` value of 0 is a known zero. `pending` and `uncertain` are unknown, and every usage field is then omitted rather than zeroed.

Model identity:

- `$ai_model` is the provider-reported model, sent only if it passes the route's catalog pattern. `nectovia_requested_model` gets the same treatment.
- An Azure logical model or deployment is `customer-named`.
- A Bedrock ARN is refused, because it contains an account id.
- Anything over 80 characters or outside `[a-z0-9._:/@-]` is `customer-named`.

### 4.4 Outcomes and unknown states

`AttemptOutcome` is derived from the step state, the reservation state and `response.type` (the table in 2.2), without any new recorded field.

The step state does not tell a refusal from a lost answer. `needsReconciliation` is true for every `kind: 'model'` step with `destination: 'external'` (`run-service.ts:198-200`), which every model-API step is (`model-api-adapter.ts:205`, `native-agent.ts:238`). So any failed model-API attempt records `step.reconcile_required` and parks its run (`run-service.ts:1126-1132`), even when `ModelApiError.dispatched` is `false`. A spend refusal or a rate-card mismatch that provably sent nothing still parks. PH-01 therefore never asserts `retry_wait` for a model-API step. The outcome comes from the reservation: no record means `refused-before-send`, `released` means `not-charged`, `uncertain` means `unknown-outcome`.

PH-01 adds one additive durable fact: an `errorCode` attribute on the existing `step.<state>` event (`run-service.ts:1134`) when the thrown error carries a `code` matching `^[A-Za-z][A-Za-z0-9_]{0,63}$`. Event attributes are already a free JSON record in the saved-run schema (`host.ts:232`).

- `$ai_is_error` is `stepState !== 'succeeded'`.
- `$ai_error` is the code, else `other`. It is never a message.
- `$ai_http_status` and `$ai_stop_reason` are not recorded, so they are not sent.
- A scripted adapter step (`origin.mode === 'application'`, `native-agent.ts:105-107`) is a `scripted-step` span, never a generation.
- An external engine inside an admitted run would be an `external-worker` span with model, usage and cost `unknown('not-exposed')`. No such path exists in the mapped Agent flows at `844cf0c`.
- A finished model response is not verification. Verification is only the H17 span.

### 4.5 Terminal and late events

- `$ai_trace` is sent once, at `completed | failed | cancelled`.
- `reconcile_required` produces `nectovia_run_parked`, not a trace. It is sent once per parking episode: its uuid is keyed by the first `step.reconcile_required` seq after the run's last `run.recovered` or `run.reconciled`, not by each step event.
- For a run whose model call failed, no `$ai_trace` is the normal case. `fail()` leaves a parked run parked (`run-service.ts:1342-1345`), so a trace is sent only if a person reconciles the run (`run-service.ts:709`, `1307`) and it later reaches `completed`, `failed` or `cancelled`. PH-04's missing-terminal-event metric counts parked runs separately, not as lost traces.
- Late verification is its own `$ai_span` (`spanKind: 'verification'`). Its uuid is keyed by `VerificationRecord.id` and its parent is the trace. It is correlated through `HarnessRun.sessionId` of a scoped root that the projector saw in this process. Otherwise it is dropped and counted.
- Late cost (PH-02) is a custom `nectovia_cost_reconciled` event joined on the generation's `spanId`. It is never a second `$ai_generation`, never additive, and PostHog never re-prices it.

### 4.6 No-export transitions

- **Sign-out, a different person, an active-workspace change since bind, entitlement no longer active, a telemetry policy that is absent or `none`, or an organization removed from the internal set:** `recheckScope` fails. At enqueue, the event is dropped (`scope-ended`). At the next flush or send, `discard` removes every queued event of that scope.
- **Events are never relabelled.** An event carries its bound scope's facts from construction. Nothing is uploaded for the next person.
- **The runtime keeps running under its admission.** Only optional export stops. Local run records, audit and the ledger are untouched.
- **Nothing persists** in PH-01 or PH-02, so nothing is backfilled later.

### 4.7 Exporter limits (PH-01 memory exporter enforces the first three; PH-02 the rest)

| Limit | Value | Over the limit |
|---|---|---|
| One serialized event | 8 KiB | dropped whole (`oversized`), never truncated |
| Queue | 1,000 events and 8 MiB | incoming event tail-dropped (`queue-full`); queued events untouched |
| Queue age | 1 hour from enqueue | dropped at flush (`expired`) |
| Batch | 50 events and 256 KiB | split |
| Transport | `/batch/` over `fetch`; 5 s deadline; concurrency 1; flush every 10 s or at 50 queued; timer unref'd | |
| Attempts | ≤ 3 per batch on network error, timeout, 429 or 5xx; backoff `min(30 s, 1 s·2^(n−1))·U[0.5,1]`; `Retry-After` honoured when ≤ 60 s | other 4xx: `rejected`, no retry; longer `Retry-After`: `retry-after-too-long` |
| Circuit | 3 consecutive failed batches | pause 5 min (`paused`), queue still bounded |
| Shutdown | `close()` flushes for ≤ 2 s | remainder `shutdown` |
| Daily pilot budget | `NECTOVIA_OBSERVATION_DAILY_EVENTS`, default **0** | `budget`; nothing is sent until the funded pilot limit is set |
| Vendor funding | `NECTOVIA_OBSERVATION_FUNDED_UNTIL` required in `posthog` mode | absent or past: `disabled:funding`, queue cleared, no later backfill. Continuing on cash needs a new explicit configuration value; nothing flips automatically |

- **A slow exporter** never slows the runtime. `enqueue` is synchronous and O(1). The caps bound memory, and age expiry bounds staleness.
- **Health** stays local. Exporter failures are counted, never sent as observations.
- **Retries** apply to telemetry only. Model and tool work are never retried because of export.

### 4.8 Failure isolation

`files.saved` runs inside `ProjectRunStore.write`, which runs inside `RunService.commit` under the per-run queue. The call there is `try { projector.onRunSaved(run) } catch { /* counted */ }` placed after `bridge.enqueue` (`host.ts:527-533`).

The projector does no await on that path. The ledger lookup is a detached promise with its own `catch`. The verification observer runs after `store.persist` and is wrapped the same way.

No observation code runs inside the following:

- a model callback;
- `authorizeEgress`;
- a spend `reserve`, `settle`, `release` or `markUncertain` call;
- a gate decision;
- a Store lock held for a write.

## 5. PH-01 file claims and tests

### 5.1 New files

- `shared/observability.ts`
- `server/observability/eligibility.ts`
- `server/observability/scopes.ts`
- `server/observability/projector.ts`
- `server/observability/sanitize.ts`: ids, pseudonyms, the model, tool and code allowlists
- `server/observability/wire.ts`
- `server/observability/exporter.ts`: port, Noop, Memory
- `tests/observability-eligibility.test.ts`
- `tests/observability-record.test.ts`
- `tests/observability-exporter.test.ts`
- `tests/observability-runtime.test.ts`
- `docs/implementation/2026-09-25-posthog-ph01-observation.md`: the slice record

### 5.2 Minimal edits

| File | Edit |
|---|---|
| `server/accounts/agent-gate.ts` | `AdmittedAgentWork`; `check` returns it (2.1) |
| `server/engines/service.ts` | `admitAgent` returns `AdmittedAgentWork \| null`. `admitModelApi` takes `observe?: { runId }` and calls `this.observation?.bind(...)` before its `return` (`:1985`). The four callers pass the run ids in section 3 (`:2033`, `:2113`, `:2244`, `:2292`). New optional field `observation?` beside `agentGate` (`:436`) |
| `server/harness/host.ts` | `createHarnessHost` accepts an optional projector. `files.saved` calls it inside try/catch (`:527-533`) |
| `server/harness/model-api-adapter.ts` | Extract `export function exposureStepId(request: Pick<ModelRequest, 'messages'>): string` and use it in `attemptFor` (`:192-200`); no behaviour change |
| `server/harness/run-service.ts` | Additive `errorCode` on the `step.<state>` note (`:1134`), pattern-checked. This changes a durable record, additively |
| `server/verification/service.ts` | Optional constructor `observe` callback after `persist` (`:328`), in try/catch |
| `server/app.ts` | Construct operator config (default `off`), Noop exporter, scopes and projector. Pass them to `EngineService` (next to `:777`), `createHarnessHost` (`:1013`) and `VerificationService` (`:1293`). Close the exporter in `app.locals.close`. `app.ts` is a Fable-owned hot file, so this edit is returned as a patch for integration |

**Not claimed:**

- `shared/harness.ts`, `shared/types.ts`, `package.json` and the lockfiles: no SDK dependency.
- `client/**` and `desktop/**`.
- `services/control-plane/**`: PR #152's lane and D1, D2, D5.
- `server/spend-exposure.ts` and `server/accounts/session.ts`: read-only use.

**PH-02 claims, frozen here and built later:**

- `server/observability/posthog-transport.ts`
- the queue limits in `exporter.ts`
- `server/observability/vendor-benefit.ts`
- an optional after-resolution callback in `spend-exposure.ts` for `reconcile` and `writeOff`
- the PostHog entry in `services/control-plane/contract/vendors.ts`
- `tests/observability-posthog-transport.test.ts`
- `tests/observability-first-trace.test.ts`

### 5.3 Tests (vitest; run only under the heavy slot)

**`tests/observability-eligibility.test.ts` (pure)**
- Every row of the bind order in 2.3: off, no admission, non-model-API route, non-`byo`, service unavailable, internal without `companyHost`, faux non-internal, missing key, customer with the absent policy port, policy `none`, and the customer fixture eligible.
- `operatorConfigFromEnv`: default `off`; `customerExport` stays `false` for any env; unknown variables are ignored.
- The recheck matrix: signed out, another person, workspace changed, entitlement `revoked`, `expired` or `unknown`, policy tightened to `none`, organization removed from the internal set.
- An admission for organization B while A is internal gives B no internal class.

**`tests/observability-record.test.ts` (pure)**
- Id determinism and the UUID v8 format.
- Every `Observed` field has an unknown path that serializes with no numeric zero.
- Milliseconds to seconds: 0 → 0, 1 → 0.001, 240,000 → 240.
- The token map with cache and reasoning parts, asserting `$ai_input_tokens` includes cache, the exclusive flag is `false`, and reasoning appears only as `nectovia_`.
- `settled` 0 differs from `uncertain`, `pending`, `released` and `not-linked`, none of which carry `$ai_total_cost_usd`.
- Model sanitization: an ARN, an Azure deployment name and a canary.
- A tool name outside the allowlist becomes `other`.
- The rate-card key is a digest.
- Error codes: pattern and fallback.
- An oversized event is dropped, not truncated.
- The wire builder emits only allowlisted keys (snapshot of the key set per event kind).

**`tests/observability-exporter.test.ts`**
- Noop records nothing.
- Memory stores the exact batch bytes.
- 1,001 events: one `queue-full`, the first 1,000 intact.
- The 8 MiB byte cap and the age expiry, with a virtual clock.
- `discard` by scope.
- `enqueue` does not throw when encoding throws (`encode-failed`).
- `health()` is never enqueued.

**`tests/observability-runtime.test.ts` (integrated)**

Uses `createApp` with the faux cloud, a scripted AWS `modelApiTransport` and the memory exporter. This is the pattern of `tests/customer-accounts-app.test.ts:43-80`.

*Positive runs:*

| Run | Signed in as | Expected |
|---|---|---|
| Conversation turn | the Juniper Street Bakery owner, organization internal, `companyHost` | one generation with ledger usage and settled micro-USD, then `$ai_trace` at completion; linked `traceId`, `$ai_session_id` = lineage |
| Work turn | same | generation on `text:dispatch` plus trace |
| Loop | same | a registered tool and a declared check: generation(s), tool span, verification span, all with the same `traceId` |
| Customer fixture | same, with fixture config and policy | class `customer-agent`, `client-reported` |

*Negative controls. Each ends with the memory exporter holding zero events and the transport spy not called:*

- Free account.
- Harbor Hardware owner (no plan).
- The Business owner in the Personal workspace.
- The same owner on a direct engine through `engine-text-turn` on a non-model-API route.
- The `HOST_TEST_PROJECT` connection test.
- `accounts: null`, so there is no gate.
- A request body carrying `internal: true`, `plan: 'business'` and a foreign `organizationId`.
- A faux organization that is not internal.
- The production (absent) telemetry policy.

*Transitions:*

- Sign-out between two turns: the second turn produces nothing and queued events are discarded.
- Sign in as another person: no event carries a new pseudonym for old work.
- Workspace switch.
- Grant withdrawn through the faux staff API, then reload.
- App restart on the same data folder with a resumed loop: the uuid sets before and after are disjoint, and earlier steps are not re-emitted.

*Isolation:*

- A projector that throws in `files.saved`, and an exporter whose `enqueue` throws.
- For both, the Agent answer, `digest(run.events)` and the spend-ledger records equal an observation-off baseline.
- A ledger read failure gives `costState: 'not-linked'` with the run unaffected.

*Canaries:*

- Where they are planted: the prompt, the provider response text, tool arguments and results, a provider 500 body, a `propose_write` path, the project, organization and person names, the email, a Bedrock account id, an Azure deployment name and a registered tool name.
- The check: none appears in any memory batch as raw, lower-case, base64, hex, `encodeURIComponent` or JSON-escaped text.

**Source guard (in the runtime file)**
- Production entries leave `mode` `off`.
- Nothing under `client/` or `desktop/` imports `server/observability` or contains `posthog`.
- No capture key appears in the repository.

**Existing suites that must stay green**
- `tests/customer-accounts-app.test.ts`, because the gate signature changes. No test stubs `AgentGatePort`; `grep` of `tests/` for `agentGate`, `AgentGatePort` and `AccountAgentGate` finds nothing, so the change reaches tests only through `createApp`.
- `tests/native-loop*.test.ts`, `tests/model-session-activity.test.ts`, `tests/spend-exposure.test.ts`, `tests/verification-service.test.ts`.
- The four AGENTS.md gates.

## 6. Open questions for Andrew

1. **Internal marker.** Operator organization allowlist now; later also require a control-plane `grantSource: 'internal-test'` in the admission pins? *Recommend yes.* Add the pin through the PR #152 lane, and keep the allowlist as a second key.
2. **Telemetry policy (D1).** Add `telemetry: { export: 'none' | 'metadata'; revision }` to the access view and the admission pins, owned by the control plane, default `none`, set by Billing staff from the agreement rather than a customer toggle at first? *Recommend yes.*
3. **Transport.** Use the documented `/batch/` HTTP API with this contract's own bounded queue instead of adding `posthog-node`? *Recommend yes.* That means no `package.json` change, byte-exact privacy tests and no SDK enrichment.
4. **Workspace switch.** Should it end optional export for already-admitted work in the other business? *Recommend yes for now.* Revisit when background Automations are customer-live.
5. **Customer events path (D5).** Should customer-host events go only through a company collector on the control plane, with direct Node export reserved for operator-declared company hosts? *Recommend yes.*
6. **Vendor record (D6).** Add PostHog to `VENDOR_ALLOWLIST` under a new `VendorRole` of `'observability'`, with `monthlyFixedMicroUsd: 0` and `accountState: 'unverified'` until billing is read, and keep award amount and expiry in private operator configuration? *Recommend yes.*
7. **Organization pseudonym.** A keyed HMAC with a company-held key (the company alone can join back), rather than an unkeyed hash that anyone holding an organization id could reverse by lookup? *Recommend the keyed HMAC.*
8. **Durable `errorCode`.** Accept the additive `errorCode` attribute on `step.<state>` events? *Recommend yes.* Without it the generation keeps a coarse outcome but loses the exact failure code.

PILLAR IMPACT: this advances 07, 09, 10 and 11 as the plan states. The risk under 09 is contained by D1 and D5: customer export stays off until entitlement, telemetry policy and collector provenance are separate, server-authoritative facts. The intentional absence of Free observation changes no Free functionality.
