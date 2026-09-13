import type { StepIntent } from './harness.js';
import type { ReviewerDecision, ScopeGrantRecord, ScopedAuthorization } from './permissions.js';
import type { AgentResolution } from './agents.js';
import type { OriginSnapshot } from './attribution.js';
import type { WorkspaceRef } from './workspaces.js';
import type {
  InstructionDelivery,
  InstructionFileRecord,
  PackActivation,
} from './capability-packs.js';
import type { FollowUpCommand, StopReceipt } from './work-control.js';

export type Detail = 'guided' | 'standard' | 'technical';
/** The two surfaces. The Workbook is one page at a time; the Console is every thread, helper and change at once. */
export type Surface = 'workbook' | 'console';
/** The four things a person can want to do; the Workbook's Home leads with these. */
export type Intent = 'ask' | 'work' | 'plan' | 'review';
export type Page =
  | 'home'
  | 'ask'
  | 'plan'
  | 'work'
  | 'review'
  | 'tasks'
  | 'documents'
  | 'history'
  | 'connections';
export type Mode = 'ask' | 'plan' | 'build' | 'fix';
export type TaskState = 'todo' | 'working' | 'waiting' | 'done';
export type Owner = 'you' | 'diomedes' | 'diomedes-with-ok';
export type ExternalEngine = 'claude-code' | 'opencode' | 'oh-my-pi' | 'cursor';
export type Route = 'sample' | 'codex' | ExternalEngine;
export interface Settings {
  version: 1;
  detail: Detail;
  /** Missing on settings written before 2026-09-06; the server fills it: 'technical' detail becomes the Console. */
  surface?: Surface;
  onboarding: {
    setupVersion?: 2;
    discoveryConsentAt?: string | null;
    aiSkipped?: boolean;
    work: 'business' | 'school' | 'software' | 'personal' | 'mix' | null;
    detail: Detail | null;
    familiarity: 'new' | 'some' | 'comfortable' | null;
    resumeAt: 'welcome' | 'q1' | 'q2' | 'q3' | 'ai' | 'ready' | 'done';
    completedAt: string | null;
  };
  permissions: {
    changingFiles: boolean;
    deleting: boolean;
    sending: boolean;
    workingOutside: boolean;
    spending: boolean;
  };
  explanations: 'persistent' | 'once' | 'off';
  appearance: {
    package: string;
    motion: 'normal' | 'reduced';
    interfaceScale?: number;
    readingScale?: number;
    codeScale?: number;
  };
  seen: {
    onlineServiceNotice: boolean;
    guidedDescriptors: Record<string, number>;
    firstUse: string[];
  };
  openProjects: string[];
  lastPage: Record<string, Page>;
  tasksView: Record<string, 'board' | 'list'>;
  /**
   * Which workspace this person is acting in. Absent means Personal, which is
   * what every settings file written before workspaces existed means too.
   *
   * It is a personal preference, so it lives here — but it is not writable
   * through `PUT /api/settings`: `validateSettings` keeps whatever is stored,
   * and only `POST /api/workspace/switch` changes it, after checking that the
   * membership behind it is real and still active.
   */
  activeWorkspace?: WorkspaceRef;
  /**
   * Which helpers are switched on, by engine id; only engines whose adapter is
   * ready can be on. A few keys are choices rather than switches, and hold a
   * string: `codexModel` and `codexEffort` are the default Codex runs use when
   * a thread has made no choice of its own.
   */
  services?: Record<string, boolean | string>;
}
export interface Project {
  ai?: { engine: Route; model: string | null };
  id: string;
  name: string;
  folder: string;
  createdAt: string;
  lastOpenedAt: string;
  plans: string[];
  references: string[];
  repository: { present: boolean };
  leftOff: { page: Page; document: string | null; scroll: number; at: string } | null;
  counts: { running: number; changesWaiting: number; waitingForYou: number; historyToday: number };
  status: { needsYou: number; working: number; tasksDone: number; tasksTotal: number };
  missing?: boolean;
  /**
   * Capability packs this Project turned on or off, appended in order. Absent
   * on every project written before packs existed, which is the same thing as
   * no pack: activation is opt-in and nothing loads for a project that did not
   * ask (`AGENTS.md` decision 14).
   */
  packs?: PackActivation[];
}
export interface DocumentInfo {
  path: string;
  kind: 'plan' | 'markdown' | 'text' | 'unsupported';
  size: number;
  changedAt: string;
  hasChangesWaiting: boolean;
  recorded: boolean;
}
export interface DocumentContent {
  path: string;
  text: string;
  sha: string;
  outsideChange?: HistoryEntry | null;
}
export interface Task {
  id: string;
  name: string;
  description: string;
  /** Default document for a bounded proposal; selection grants no write authority. */
  sourceDocument?: string;
  from: { plan: string; step: number } | null;
  owner: Owner;
  state: TaskState;
  reason: 'needs-ok' | 'changes-ready' | 'went-wrong' | null;
  needId: string | null;
  sessionIds: string[];
  changeIds: string[];
  /** Append-only record of what each Stop actually did, by scope. Never rewritten. */
  stopReceipts?: StopReceipt[];
  /** Immutable admission evidence; absent on tasks created by legacy/internal callers. */
  creationReceipt?: TaskCreationReceipt;
  createdBy: Owner;
  createdAt: string;
  assignedTo?: Slot | null;
  deletedAt?: string | null;
  moves: {
    at: string;
    by: Owner;
    from: TaskState;
    to: TaskState;
    undoUntil: string;
    undone: boolean;
  }[];
}
export interface TaskCreationInput {
  name: string;
  description: string;
  /** Optional default document; part of the command identity, validated against a fresh listing. */
  sourceDocument?: string;
  owner: Owner;
}
export interface TaskCreationReceipt {
  readonly protocolVersion: 1;
  readonly commandId: string;
  readonly payloadDigest: string;
  readonly projectId: string;
  readonly taskId: string;
  readonly eventId: string;
  readonly admittedAt: string;
  readonly actor: 'local-client';
  readonly scope: 'local-prototype';
}
export interface Need {
  origin?: OriginSnapshot;
  /** Versioned delegated decision; mutually exclusive with exact approvalReceipt. */
  authorization?: ScopedAuthorization;
  /** Host policy explanation when an existing task scope did not cover this proposal. */
  authorizationBoundary?: string;
  id: string;
  sessionId: string;
  taskId: string;
  what: string;
  why: string;
  consequence: string;
  files: string[];
  state: 'open' | 'go-ahead' | 'declined' | 'expired';
  createdAt: string;
  decidedAt: string | null;
  decidedFrom: string;
  allowForTask: boolean;
  preview?: Change[];
  /** Present on new exact native proposals; legacy sample requests stay unversioned. */
  approval?: ApprovalIdentity;
  approvalReceipt?: ApprovalReceipt;
  execution?: ApprovalExecution;
  /** Optional v1 harness binding. The Need remains the single approval record. */
  harness?: { runId: string; intent: StepIntent };
  /**
   * Bounded reviewer decisions for this proposal, newest last. A reviewer
   * decision is evidence, never a person's approval, and a refusal leaves the
   * proposal open for you rather than deciding it.
   */
  reviews?: ReviewerDecision[];
}
export interface ApprovalIdentity {
  readonly protocolVersion: 1;
  readonly proposalDigest: string;
  readonly actionDigest: string;
  readonly baseDigest: string;
  readonly expiresAt: string;
  readonly sources: readonly { readonly path: string; readonly sha: string }[];
}
export interface ApprovalCommand {
  protocolVersion: 1;
  commandId: string;
  resolution: 'go-ahead' | 'declined';
  proposalDigest: string;
  actionDigest: string;
  baseDigest: string;
}
/** The decision never changes. Execution has its own durable outcome. */
export interface ApprovalReceipt {
  readonly protocolVersion: 1;
  readonly commandId: string;
  readonly payloadDigest: string;
  readonly projectId: string;
  readonly approvalId: string;
  readonly taskId: string;
  readonly sessionId: string;
  readonly actor: 'local-client';
  readonly scope: 'local-prototype';
  readonly proposalDigest: string;
  readonly actionDigest: string;
  readonly baseDigest: string;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly decision: 'go-ahead' | 'declined';
  readonly decidedAt: string;
  readonly eventId: string;
}
export interface ApprovalExecution {
  state: 'pending' | 'applied' | 'conflicted' | 'not-applied' | 'declined';
  eventId: string | null;
  completedAt: string | null;
  reason: string | null;
  conflicts: string[];
}
export type ThreadPermission = 'show-first' | 'task';
/** Immutable receipt for one admitted task Work command in the local prototype. */
export interface WorkReceipt {
  readonly protocolVersion: 1;
  readonly commandId: string;
  readonly payloadDigest: string;
  readonly projectId: string;
  readonly taskId: string;
  readonly sessionId: string;
  readonly eventId: string;
  readonly admittedAt: string;
  readonly route: Route;
  /** This is the existing loopback trust boundary, not a device authentication claim. */
  readonly scope: 'local-prototype';
}
export interface Session {
  origin?: OriginSnapshot;
  /**
   * The project instruction files this run put in front of the model, with the
   * sha of the bytes actually sent and anything left out whole. Absent on a
   * project that has no active pack or no discovered instruction file.
   */
  instructions?: InstructionDelivery;
  /**
   * Which Agent this run resolved to, with the model, route and policy state at
   * that moment. It is a record of what was permitted, never a grant, and it is
   * never re-resolved for an old session.
   */
  agent?: AgentResolution;
  route?: Route;
  threadId?: string;
  id: string;
  taskId: string;
  slotId?: Slot;
  permission?: ThreadPermission;
  receipt?: WorkReceipt;
  state: 'queued' | 'working' | 'waiting' | 'done' | 'stopped' | 'failed';
  startedAt: string;
  endedAt: string | null;
  sample: boolean;
  log: { time: string; sentence: string; level: 'plain' | 'technical' }[];
  entryIds: string[];
  needId: string | null;
  /**
   * The scrubbed, capped engine reply kept when the proposal parser refused it
   * or the proposal changed nothing, so a paid turn that produced no proposal
   * still leaves diagnosable evidence. Missing on sessions recorded before
   * 2026-09-12. `rawReplyLength` is the uncut length; `parseError` is set only
   * when the parser refused the reply.
   */
  rawReply?: string;
  rawReplyLength?: number;
  parseError?: string;
  engine: {
    name: string;
    model: string | null;
    worker: number;
    branch: string | null;
    context: number | null;
    events: number;
    /** Runtime-reported protocol version (Codex) or null. Never parsed from answer text. */
    version?: string | null;
    /** True only when model came from the runtime (thread/turn metadata), never from text. */
    verified?: boolean;
  };
}
export interface FileRecord {
  path: string;
  op: 'modified' | 'created' | 'deleted';
  before: string | null;
  after: string | null;
  recorded: boolean;
  reason: string | null;
}
export interface HistoryEntry {
  origin?: OriginSnapshot;
  authorization?: ScopedAuthorization;
  /** Mirrors the reviewer decision this event records, for audit without the Need. */
  review?: ReviewerDecision;
  id: string;
  time: string;
  actor: Owner;
  kind: string;
  sentence: string;
  sessionId: string | null;
  taskId: string | null;
  sample: boolean;
  files: FileRecord[];
  label: string | null;
  restoreOf: string | null;
  replaced: string | null;
  versionId: string;
  commit: string | null;
  /** Links a decision or recorded write to its exact Need. */
  approvalId?: string;
  /**
   * The scrubbed, capped raw engine reply behind a fault or empty proposal,
   * mirroring the session record so History stays the evidence a person can
   * read. Missing on entries recorded before 2026-09-12.
   */
  rawReply?: string;
  rawReplyLength?: number;
  parseError?: string;
}
export interface Change {
  id: string;
  entryId: string;
  sessionId: string | null;
  taskId: string | null;
  path: string;
  op: 'modified' | 'created' | 'deleted';
  summary: string;
  before: string | null;
  after: string | null;
  current: string | null;
  changedSince: { actor: string; at: string } | null;
  hunks: { value: string; added?: boolean; removed?: boolean; count?: number }[];
  state: 'waiting' | 'kept' | 'undone';
}
export interface Turn {
  origin?: OriginSnapshot;
  id: string;
  role: 'you' | 'assistant' | 'diomedes';
  mode: Mode;
  text: string;
  at: string;
  sources: string[];
  route?: Route;
  /** Fix attempts only: which try this turn belongs to. */
  attempt?: { n: number; of: number };
  /**
   * Which helper answered. `verified` is true only when the value came from the
   * runtime (Codex `thread/start` or `turn/completed` metadata), never from the
   * answer text. Missing on turns written before 2026-09-07; the UI shows no
   * caption for those.
   */
  helper?: {
    engine: string;
    model: string | null;
    version?: string | null;
    verified: boolean;
  };
}
/** A thread: a named conversation that belongs to a project and, optionally, to a task. */
export interface Conversation {
  engine?: Route;
  id: string;
  attachedTo: { kind: 'project' | 'document' | 'plan' | 'task' | 'review'; ref: string };
  turns: Turn[];
  /** Fields below are missing on state written before 2026-09-06; the store fills them on load. */
  name?: string;
  createdAt?: string;
  updatedAt?: string;
  taskId?: string | null;
  /** What actually ran, reported by the runtime. Never set from a person's choice. */
  helper?: { engine: string; model: string | null } | null;
  permission?: ThreadPermission;
  /**
   * What the person chose for this thread, which is not the same claim as
   * `helper`: this is the request, that is the runtime's answer. Null means
   * follow the saved default, and the default in turn may be null for the
   * engine's own default. An explicit level here outranks the mode's own.
   */
  /**
   * The thread's own picks. Agent and model are independent axes: changing
   * either changes who works and with what intelligence, never what is allowed.
   * `agent` may be `auto`, which resolves per run and is recorded as automatic.
   */
  requested?: { model: string | null; effort: string | null; agent?: string | null } | null;
  /** The thread's current mode. State written before modes lacks it; the store fills it on load. */
  mode: Mode;
}

/** One model an engine offers, with the reasoning ladder that model supports. */
export interface EngineModel {
  slug: string;
  name: string;
  description: string;
  /** The engine's own default, guaranteed to appear in `efforts` when not null. */
  defaultEffort: string | null;
  efforts: { id: string; description: string }[];
}
export interface EngineCatalog {
  engine: string; // integration id
  models: EngineModel[]; // empty when the engine reports no choices
  detail: string; // one plain sentence for where the list came from, or why it is empty
}
export interface ProjectState {
  /** Absent in v1 projects. Persisted grants alone never restore active authority. */
  scopeGrants?: ScopeGrantRecord[];
  project: Project;
  documents: DocumentInfo[];
  tasks: Task[];
  needs: Need[];
  sessions: Session[];
  history: HistoryEntry[];
  changes: Change[];
  conversations: Conversation[];
  /** Absent in projects written before the follow-up queue existed. */
  followUps?: FollowUpCommand[];
  team?: TeamState;
  /**
   * What pack discovery found in the project folder. Derived, not authored:
   * refreshed on activation and re-read from disk, never edited by hand.
   */
  instructionFiles?: InstructionFileRecord[];
}
/** How Diomedes knows whether an engine is signed in. 'first-use' means the first run reports it. */
export type SignInState = 'signed-in' | 'not-signed-in' | 'unknown' | 'first-use' | 'not-needed';
/** Whether Diomedes can drive this engine: 'ready' has a proven adapter, 'planned' is in the brief, 'none' is observe-only. */
export type AdapterState = 'ready' | 'planned' | 'none';
export interface IntegrationStatus {
  id: string;
  name: string;
  kind: 'online' | 'local' | 'sample';
  /** The binary or loopback service exists on this computer. */
  found: boolean;
  /** Found, and every check an adapter needs has passed. Always false when the adapter is not ready. */
  available: boolean;
  enabled: boolean;
  status: string;
  detail: string;
  capabilities: string[];
  /** @deprecated use installedVersion; kept for the Console's version line. */
  version?: string;
  /** What this computer has. */
  installedVersion?: string;
  /** What Diomedes was verified against, when it uses its own pinned copy. */
  provenVersion?: string;
  signIn: SignInState;
  adapter: AdapterState;
  /** Where the engine was found. Shown on the Console only. */
  location?: string;
  disclosure: string[];
}
export interface TaskCandidate {
  line: number;
  name: string;
  owner: Owner;
}
export interface RestoreConflict {
  path: string;
  actor: string;
  at: string;
}
export type Slot = string;
export interface TeamMember {
  slotId: Slot;
  name: string;
  role: 'lead' | 'member';
  /** Team membership by Agent identity. Absent on members created before Agents. */
  agentId?: string;
  engine: 'codex' | 'claude-code' | 'opencode' | 'oh-my-pi' | 'sample' | 'probe';
  model: string | null;
  status: 'idle' | 'working' | 'waiting' | 'stopped' | 'error';
  threadId: string | null;
  createdAt: string;
  lastSeenAt: string | null;
  /** Count of unread mailbox messages to this slot; filled by TeamService.teamState(). */
  unread?: number;
}
export interface MailboxMessage {
  id: string;
  to: Slot;
  from: Slot;
  type: 'message' | 'idle_notification' | 'shutdown_request';
  content: string;
  summary?: string;
  files?: string[];
  read: boolean;
  createdAt: string;
  threadId: string | null;
  runId: string | null;
  approvalId: string | null;
}
export interface TeamRun {
  id: string;
  slotId: Slot;
  sessionId: string | null;
  status: 'accepted' | 'running' | 'cancelling' | 'completed' | 'cancelled' | 'failed';
  startedAt: string;
  endedAt: string | null;
  summary: string | null;
}
export interface TeamState {
  members: TeamMember[];
  messages: MailboxMessage[];
  runs: TeamRun[];
}
export interface UsageWindow {
  id: string;
  label: string;
  usedPercent: number;
  resetsAt: string | null;
  durationMins: number | null;
}
export interface UsageMeter {
  input: number;
  output: number;
  cached: number;
  total: number;
  contextWindow: number | null;
  costUsd: number | null;
}
export interface UsageSnapshot {
  engine: string; // integration id
  at: string; // ISO time the snapshot was taken
  windows: UsageWindow[]; // empty when the service reports no allowance
  plan?: string | null;
  credits?: { balance: number | null; unlimited: boolean } | null;
  thread?: { id: string; meter: UsageMeter } | null; // the most recent thread's meter
  source: 'push' | 'poll' | 'turn' | 'none';
  detail: string; // one plain sentence for what is not reported, or what the numbers mean
}
