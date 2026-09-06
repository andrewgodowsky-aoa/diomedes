export type Detail = 'guided' | 'standard' | 'technical';
/** The two surfaces. The Book is one page at a time; the Desk is every thread, helper and change at once. */
export type Surface = 'book' | 'desk';
/** The four things a person can want to do; the Book's Home leads with these. */
export type Intent = 'ask' | 'work' | 'plan' | 'review';
export type Page = 'home' | 'ask' | 'plan' | 'work' | 'review' | 'tasks' | 'documents' | 'history';
export type Mode = 'ask' | 'plan' | 'work';
export type TaskState = 'todo' | 'working' | 'waiting' | 'done';
export type Owner = 'you' | 'diomedes' | 'diomedes-with-ok';
export type Route = 'sample' | 'codex';
export interface Settings {
  version: 1;
  detail: Detail;
  /** Missing on settings written before 2026-09-06; the server fills it: 'technical' detail becomes the Desk. */
  surface?: Surface;
  onboarding: {
    work: 'business' | 'school' | 'software' | 'personal' | 'mix' | null;
    detail: Detail | null;
    familiarity: 'new' | 'some' | 'comfortable' | null;
    resumeAt: 'welcome' | 'q1' | 'q2' | 'q3' | 'ready' | 'done';
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
  history: { keepDays: number; maxBytesPerProject: number };
  seen: {
    onlineServiceNotice: boolean;
    guidedDescriptors: Record<string, number>;
    firstUse: string[];
  };
  openProjects: string[];
  lastPage: Record<string, Page>;
  tasksView: Record<string, 'board' | 'list'>;
  services?: { codex: boolean };
}
export interface Project {
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
  from: { plan: string; step: number } | null;
  owner: Owner;
  state: TaskState;
  reason: 'needs-ok' | 'changes-ready' | 'went-wrong' | null;
  needId: string | null;
  sessionIds: string[];
  changeIds: string[];
  createdBy: Owner;
  createdAt: string;
  moves: {
    at: string;
    by: Owner;
    from: TaskState;
    to: TaskState;
    undoUntil: string;
    undone: boolean;
  }[];
}
export interface Need {
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
}
export interface Session {
  id: string;
  taskId: string;
  state: 'queued' | 'working' | 'waiting' | 'done' | 'stopped' | 'failed';
  startedAt: string;
  endedAt: string | null;
  sample: boolean;
  log: { time: string; sentence: string; level: 'plain' | 'technical' }[];
  entryIds: string[];
  needId: string | null;
  engine: {
    name: string;
    model: string | null;
    worker: number;
    branch: string | null;
    context: number | null;
    events: number;
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
  id: string;
  role: 'you' | 'diomedes';
  mode: Mode;
  text: string;
  at: string;
  sources: string[];
  route?: Route;
}
/** A thread: a named conversation that belongs to a project and, optionally, to a task. */
export interface Conversation {
  id: string;
  attachedTo: { kind: 'project' | 'document' | 'plan' | 'task' | 'review'; ref: string };
  turns: Turn[];
  /** Fields below are missing on state written before 2026-09-06; the store fills them on load. */
  name?: string;
  createdAt?: string;
  updatedAt?: string;
  taskId?: string | null;
  helper?: { engine: string; model: string | null } | null;
}
export interface ProjectState {
  project: Project;
  documents: DocumentInfo[];
  tasks: Task[];
  needs: Need[];
  sessions: Session[];
  history: HistoryEntry[];
  changes: Change[];
  conversations: Conversation[];
}
export interface IntegrationStatus {
  id: string;
  name: string;
  kind: 'online' | 'local' | 'sample';
  available: boolean;
  enabled: boolean;
  status: string;
  detail: string;
  capabilities: string[];
  version?: string;
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
