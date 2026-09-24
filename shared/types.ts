import type { StepIntent } from './harness.js';
import type {
  RememberedApprovals,
  RememberedAuthorization,
  ReviewerDecision,
  ScopeGrantRecord,
  ScopedAuthorization,
} from './permissions.js';
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
/**
 * The Console's two views. Conversation shows the prompt box and the threads;
 * Architect is the full Console. A view changes what is shown, never what
 * Nectovia can do.
 */
export type ConsoleView = 'conversation' | 'architect';
export type Mode = 'ask' | 'plan' | 'auto' | 'build' | 'fix';
export type TaskState = 'todo' | 'working' | 'waiting' | 'done';
export type Owner = 'you' | 'diomedes' | 'diomedes-with-ok';
export type ExternalEngine = 'claude-code' | 'opencode' | 'oh-my-pi' | 'cursor' | 'devin';
/** A model-API route (`shared/model-api.ts`): a provider API on the company's own credential. */
export type Route = 'sample' | 'codex' | ExternalEngine | import('./model-api.js').ModelApiRoute;
export interface Settings {
  version: 1;
  detail: Detail;
  /** Missing on settings written before 2026-09-23; the server fills it with 'architect'. */
  view?: ConsoleView;
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
    /**
     * The custom ThemePack currently applied, or absent for a built-in scheme.
     *
     * A pointer, never the pack: the pack itself lives under
     * `<data>/themes/<scope>/<id>/pack.json` and is validated on every read.
     * A pointer at a theme that is gone or corrupt is not an error state — the
     * app falls back to last-known-good and then to the base scheme, and says
     * so — so nothing here has to be kept in step with the store.
     *
     * `scope` is the theme storage scope the pointer was written in — the same
     * key `themeScopeKey` derives for the workspace and person who applied it.
     * Settings are one global file while themes are stored per scope, so a
     * pointer without it would name a theme the next workspace cannot read. A
     * pointer whose `scope` is not the current one means "no theme here": the
     * built-in appearance shows, with no notice, and the pointer is left alone
     * so switching back restores the theme. A pointer with no `scope` at all
     * was written before this existed and is accepted as-is.
     */
    activeTheme?: { id: string; revision: number; scope?: string } | null;
    /** Turn decorative texture off for everyone on this install. */
    textureOff?: boolean;
  };
  seen: {
    onlineServiceNotice: boolean;
    guidedDescriptors: Record<string, number>;
    firstUse: string[];
  };
  openProjects: string[];
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
   * The reserved home conversation container: the Project and thread Diomedes'
   * own conversation runs in. Absent on settings written before this field
   * existed, and null until the first message on that conversation provisions
   * it. The server never provisions it at startup.
   *
   * Like `activeWorkspace` it is not writable through `PUT /api/settings`: the
   * server is the only writer. It is a pointer rather than the records, so it
   * is a claim and not evidence: every use re-checks that the project it names
   * is the reserved home Project and the thread it names is that project's
   * designated home thread, and re-establishes it by adoption when it is not.
   */
  home?: { projectId: string; threadId: string; revision: 1 } | null;
  /**
   * Which helpers are switched on, by engine id; only engines whose adapter is
   * ready can be on. A few keys are choices rather than switches, and hold a
   * string: `codexModel` and `codexEffort` are the default Codex runs use when
   * a thread has made no choice of its own. `workStyle` is the WorkStyle a
   * thread follows when it names none.
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
  /**
   * `drawing` is an `.svg` or `.mmd` file: Files previews it in the sandboxed
   * frame, a person may select it as a proposal source, and automatic task
   * source selection never picks it (shared/task-sources.ts reads only
   * markdown and text).
   */
  kind: 'plan' | 'markdown' | 'text' | 'drawing' | 'unsupported';
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
  /** H17: what a finished run must satisfy. Absent means none declared: results read Not verified. */
  acceptance?: import('./verification.js').AcceptanceDeclaration;
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
  authorization?: ScopedAuthorization | RememberedAuthorization;
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
  /**
   * What the server's content checks found in the proposed files, one entry per
   * file a check speaks for, shown with the review. Absent when no file needed
   * one. Derived from the preview's text, which the approval digests already
   * bind, so it is not part of the approval identity.
   */
  checks?: NeedCheck[];
}
/**
 * One proposed file's content check. An `.svg`, or an `.xml` that is SVG,
 * passed svg-check (a file that fails is refused before any Need exists). An
 * `.html` or other `.xml` file has no content check, and says so.
 */
export type NeedCheck =
  | { path: string; check: 'svg'; version: number; outcome: 'passed'; sentence: string }
  | { path: string; check: 'none'; outcome: 'unchecked'; sentence: string };
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
   * The scrubbed, capped engine reply kept when the proposal parser or a
   * content check (svg-check on a drawing the proposal writes) refused it, or
   * the proposal changed nothing, so a paid turn that produced no proposal
   * still leaves diagnosable evidence. Missing on sessions recorded before
   * 2026-09-12. `rawReplyLength` is the uncut length; `parseError` is set when
   * the parser or a content check refused the reply.
   */
  rawReply?: string;
  rawReplyLength?: number;
  parseError?: string;
  engine: {
    name: string;
    model: string | null;
    worker: number;
    branch: string | null;
    /** Bytes of project documents sent with the request; null when none were recorded. */
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
  /** The recorded images are exact bytes (a picture, PDF or workbook), not UTF-8 text. */
  binary?: true;
}
export interface HistoryEntry {
  origin?: OriginSnapshot;
  authorization?: ScopedAuthorization | RememberedAuthorization;
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
  /** H17: a verification's evidence. The four-state result is projected from it, never stored. */
  verification?: import('./verification.js').VerificationRecord;
  /** P06: which hunks of a change a person kept and which they undid (shared/review-comments.ts). */
  hunkReview?: import('./review-comments.js').HunkReviewRecord;
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
  /** P06: kept in part. The History entry that wrote the result, and the hunks on each side. */
  partial?: { entryId: string; kept: number[]; undone: number[] };
}
export interface Turn {
  origin?: OriginSnapshot;
  id: string;
  role: 'you' | 'assistant' | 'diomedes';
  mode: Mode;
  text: string;
  at: string;
  sources: string[];
  /**
   * The exact bytes each source named when this turn was written, as
   * `{ path, sha }` (shared/file-identity.ts). Set by the direct request path;
   * absent on older turns and conversation turns, whose version History's
   * record of the read at or before `at` still names.
   */
  sourceVersions?: { path: string; sha: string }[];
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
/**
 * One native conversation run a thread has used. A thread keeps one current lineage per
 * conversation mode; a new one is admitted, with the next generation, when the current one can
 * no longer take a message. Retired lineages stay, so a message answered on one is still found.
 */
export interface ConversationLineage {
  mode: 'ask' | 'plan' | 'auto';
  /** Counts every lineage the thread ever had, retired ones included. Starts at 1. */
  generation: number;
  runId: string;
  /**
   * Absent means current. The guard that refused a new message names the reason, except
   * `format-change`: the person moved the thread to the current instructions with "Update this
   * conversation".
   */
  retired?: 'scope-change' | 'terminated' | 'budget' | 'format-change';
  /**
   * What "Update this conversation" promised when it retired this lineage: that its recent
   * messages come along to the next generation on `route`, the route the next message was taking.
   * Absent when it promised nothing (history not shared there, another route, or instructions this
   * build does not know); then nothing ever carries from it, whatever changes later.
   */
  carry?: { route: string };
  /**
   * The run of the lineage "Update this conversation" retired just before this one, in this mode,
   * set only when that update promised to carry its messages to the route this lineage opened on.
   * Each send still checks the route's history grant, so this lineage's history starts with that
   * run's recent messages (bounded as any history is) only while history sharing allows it.
   */
  carriedFrom?: string;
  /**
   * The reasoning level a model-API lineage was opened with, when a WorkStyle
   * chose one. That route binds the level into its saved context, so a style
   * change that moves it starts the next generation rather than failing.
   */
  effort?: string;
  /**
   * The model-API route and model a lineage was opened on. A tier moves both at once, and
   * the saved context is bound to them, so a change starts the next generation.
   */
  route?: string;
  model?: string;
}
export interface Conversation {
  engine?: Route;
  /**
   * Present only when the person picked `engine` themselves through the thread's
   * update route. Absent means the route was provisioned, not chosen, so a
   * provisioner may re-pin it to the conversation's current default; a marked
   * choice is preserved across provisioning and restart.
   */
  engineChoice?: 'person';
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
  /**
   * The thread's WorkStyle (`shared/work-style.ts`), or absent/null to follow
   * the Settings default (`services.workStyle`). It only chooses which offered
   * model leads and how hard it reasons; it never changes `mode`, `permission`
   * or the route, and an explicit `requested.model` pin outranks it.
   */
  workStyle?: import('./work-style.js').WorkStyle | null;
  /** The thread's current mode. State written before modes lacks it; the store fills it on load. */
  mode: Mode;
  /** Native conversation lineages, oldest first. Missing on state written before this field. */
  lineages?: ConversationLineage[];
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
/** Project-owned outbound consent. Absent or malformed records deny cloud sends. */
export interface CloudSharingPolicy {
  version: number;
  routes: Exclude<Route, 'sample'>[];
  documents: string[];
  shareConversationHistory: boolean;
  /** Separately permits proposal excerpts, task metadata and scope in model review. */
  shareReviewPackets: boolean;
  /**
   * Present when this policy was first derived, once, from what the project had already sent
   * before default-deny sharing (`server/cloud-sharing.ts`, `upgradeCloudSharing`). It records
   * what the upgrade kept; it is provenance, never authority, and an owner's change keeps it.
   */
  upgrade?: CloudSharingUpgrade;
}
export interface CloudSharingUpgrade {
  at: string;
  from: 'recorded-history';
  routes: Exclude<Route, 'sample'>[];
  documents: string[];
  shareConversationHistory: boolean;
}
export interface ProjectState {
  cloudSharing?: CloudSharingPolicy;
  /** Absent in v1 projects. Persisted grants alone never restore active authority. */
  scopeGrants?: ScopeGrantRecord[];
  /** Remembered approvals (D5). Absent until the first exact approval that could be remembered. */
  rememberedApprovals?: RememberedApprovals;
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
  /**
   * The project's Ready queue: automatic start, its pause and the claims it made (H07,
   * shared/ready-queue.ts). Absent on every project written before it existed, which means off.
   */
  readyQueue?: import('./ready-queue.js').ReadyQueueRecord;
  /** P06 review comments on changes and file versions. Absent until the first one. */
  reviewComments?: import('./review-comments.js').ReviewComment[];
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
  /**
   * The route this member runs on. Any route may be recorded (members saved before
   * 2026-09-23 may name one that cannot carry team tools); only the routes in
   * `shared/team-routes.ts` can run, and the rest are refused by name.
   */
  engine: Exclude<Route, 'sample'> | 'sample' | 'probe';
  /** The model requested for this member, or null for the route's own default. Never a reported model. */
  model: string | null;
  /** How the route and model were chosen. Absent on members created before 2026-09-23. */
  selection?: import('./team-routes.js').TeamMemberSelection;
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
