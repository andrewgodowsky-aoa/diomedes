/**
 * Harness contracts, version 1.
 *
 * These are the reconciled shape of the handoff package's `contracts/domain.ts`
 * against what Diomedes actually has in `shared/types.ts`. Names carry the
 * `Harness` prefix where the package's name already means something else here
 * (`Task`, `Event`) or would shadow a global. The existing records stay the
 * authority for what a person sees: a `Task` is still the work contract, a
 * `Need` is still the approval a person answers, a `Session` is still the run
 * the Workbook and Console show. A harness run sits underneath a Session and
 * records the steps, attempts, approvals and events that a Session does not.
 *
 * Nothing here is a wire format for a provider. Provider transcripts are opaque
 * references kept apart from the portable messages a run carries.
 */
import type { TaskState, Task, Session, ThreadPermission } from './types.js';

export const HARNESS_CONTRACT_VERSION = 1 as const;

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

/**
 * What Diomedes can honestly promise about a guarantee on a given route.
 * `enforced`: Diomedes' own code is the boundary. `observed`: the engine reports
 * it and Diomedes checks the report, but could not stop a violation itself.
 * `instructional`: asked for in the prompt only. `unsupported`: not available.
 */
export type Enforcement = 'enforced' | 'observed' | 'instructional' | 'unsupported';
export type Effect = 'pure' | 'read' | 'idempotent' | 'non-idempotent';
export type Destination = 'local' | 'external';

export interface HarnessLabel {
  /** The data folder identity. Diomedes is single-tenant today; the check still runs. */
  tenantId: string;
  projectId: string;
  integrity: 'trusted' | 'untrusted';
  confidentiality: 'public' | 'internal' | 'restricted';
  provenance: string[];
}

export interface HarnessPrincipal {
  id: string;
  tenantId: string;
  projectId: string;
  /** Permission names this principal holds. A tool's `permission` must be one of them. */
  capabilities: string[];
  /** Bumped when grants are revoked; approvals bound to an older generation stop counting. */
  identityGeneration: number;
}

/**
 * What the host can account for today: whole units per step, model and tool
 * call counts, and a wall-clock limit that is recorded but not yet enforced.
 * Tokens, spend and GPU memory are not accounted here; see the integration map.
 */
export interface HarnessBudget {
  units: number;
  modelCalls: number;
  toolCalls: number;
  wallMs: number | null;
}
export interface HarnessUsage {
  units: number;
  modelCalls: number;
  toolCalls: number;
}

export type HarnessRunState =
  | 'queued'
  | 'running'
  | 'waiting'
  | 'reconcile_required'
  | 'completed'
  | 'failed'
  | 'cancelled';
export type StepKind = 'model' | 'tool' | 'transform' | 'approval' | 'wait';
export type StepState =
  | 'pending'
  | 'running'
  | 'succeeded'
  | 'retry_wait'
  | 'waiting_approval'
  | 'waiting_event'
  | 'reconcile_required'
  | 'failed'
  | 'cancelled';

/** Everything that identifies one unit of work. Hashed to `intentHash`; never rewritten. */
export interface StepIntent {
  stepId: string;
  stepVersion: string;
  kind: StepKind;
  effect: Effect;
  /** The tool or provider name, for presentation. Authority never comes from it. */
  name?: string | null;
  input: Json;
  cost: number;
  maxAttempts: number;
  permission: string | null;
  approval: boolean;
  destination: Destination;
  trustedInputRequired: boolean;
  label: HarnessLabel | null;
  policyVersion: string;
}

export interface StepRecord {
  intent: StepIntent;
  intentHash: string;
  attempt: number;
  state: StepState;
  output: Json | null;
  outputHash: string | null;
  /** The run's lease fence when the current attempt started. */
  leaseFence: number;
  startedAt: string | null;
  endedAt: string | null;
  error: { name: string; message: string } | null;
}

/**
 * A decision bound to one exact intent under one identity generation, with an
 * expiry. It is the binding record; the `Need` remains what a person sees and
 * answers. Astra's approval receipts bind the existing Need the same way with
 * `actionDigest`; a harness step surfaces as a Need whose digest is this hash.
 */
export interface HarnessApproval {
  runId: string;
  stepId: string;
  intentHash: string;
  principalId: string;
  identityGeneration: number;
  /** The run's fence when decided. Recorded for the audit trail; not a validity check in v1. */
  executionGeneration: number;
  decision: 'approved' | 'denied';
  decidedBy: string;
  decidedAt: string;
  expiresAt: string;
  consumedAt: string | null;
}

/** A versioned event with a cursor. A client that reconnects asks for events after its last `seq`. */
export interface HarnessEvent {
  v: typeof HARNESS_CONTRACT_VERSION;
  seq: number;
  runId: string;
  at: string;
  type: string;
  stepId?: string;
  attempt?: number;
  attributes: { [key: string]: Json };
}

/** An opaque, provider-owned transcript. Never flattened into portable messages. */
export interface ProviderTranscriptRef {
  providerId: string;
  modelId: string | null;
  lineageId: string;
  opaqueRef: string;
  prefixHash: string;
}

/** The portable context a run carries. Plain text and tool observations only. */
export interface PortableMessage {
  role: 'user' | 'assistant' | 'tool';
  text?: string;
  tool?: string;
  name?: string;
  input?: Json;
  output?: Json;
}

export interface HarnessRun {
  v: typeof HARNESS_CONTRACT_VERSION;
  id: string;
  tenantId: string;
  projectId: string;
  /** The existing `Task.id` this run works for, when it has one. */
  taskId: string | null;
  /** The existing `Session.id` presenting this run, once the host links them. */
  sessionId: string | null;
  capabilityId: string;
  capabilityVersion: string;
  /** The only tool names this run may dispatch, copied from the manifest at start. */
  capabilityTools: string[];
  policyVersion: string;
  principal: HarnessPrincipal;
  state: HarnessRunState;
  budget: HarnessBudget;
  used: HarnessUsage;
  owner: string | null;
  fence: number;
  /** Epoch milliseconds from the service clock. */
  leaseExpiresAt: number | null;
  parentRunId: string | null;
  forkPoint: string | null;
  contextRevision: number;
  transcripts: Record<string, ProviderTranscriptRef>;
  result: Json | null;
  failure: { name: string; message: string } | null;
  cancelReason: string | null;
  createdAt: string;
  updatedAt: string;
  steps: StepRecord[];
  approvals: HarnessApproval[];
  events: HarnessEvent[];
  lastSeq: number;
}

/** A tool as the model sees it: no handler, no authority. */
export interface ToolDescriptor {
  name: string;
  version: string;
  description: string;
  effect: Effect;
  permission: string | null;
  approval: boolean;
  destination: Destination;
  trustedInputRequired: boolean;
  cost: number;
  inputSchema: Json;
}

export interface AdapterCapabilities {
  engineId: string;
  engineVersion: string;
  protocolVersion: string;
  modelCalls: Enforcement;
  toolCalls: Enforcement;
  filesystemWrites: Enforcement;
  networkEgress: Enforcement;
  approvals: Enforcement;
  resumability: Enforcement;
  cancellability: Enforcement;
  checkpointGranularity: 'step' | 'turn' | 'task' | 'none';
  /** Where each label came from. Evidence, not marketing. */
  notes: string[];
}

export interface CapabilityManifest {
  id: string;
  version: string;
  label: string;
  description: string;
  /** Registry tool names. Every name must exist in the host registry at start. */
  tools: string[];
  requestedPermissions: string[];
  /** The existing thread permission modes are the approval policy. */
  approvalPolicy: ThreadPermission;
  maxTurns: number;
  supportedPlatforms: string[];
}

export interface ModelRequest {
  runId: string;
  capabilityId: string;
  messages: PortableMessage[];
  tools: ToolDescriptor[];
  transcript: ProviderTranscriptRef | null;
}
export type ModelResponse =
  | { type: 'final'; text: string }
  | { type: 'tool'; name: string; input: Json };
export interface ModelResult {
  response: ModelResponse;
  transcript?: ProviderTranscriptRef | null;
  usage?: { inputTokens?: number; outputTokens?: number } | null;
}

/** A harness run in the words the Workbook and Console already use. */
export interface RunPresentation {
  taskState: TaskState;
  reason: Task['reason'];
  sessionState: Session['state'];
  sentence: string;
  waiting: { stepId: string; intentHash: string; what: string } | null;
  uncertain: { stepId: string; intentHash: string; attempt: number } | null;
  evidence: { steps: number; events: number; lastSeq: number };
  lineage: { parentRunId: string; forkPoint: string | null } | null;
}
