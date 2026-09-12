import type {
  DocumentInfo,
  MailboxMessage,
  Project,
  ProjectState,
  Slot,
  Task,
  TeamMember,
  TeamRun,
  UsageSnapshot,
} from '../../shared/types';

export type ShellView = 'Thread' | 'Board' | 'Team' | 'Connections';
export type BoardProps = { project: Project; state: ProjectState; tasks: Task[]; policy: 'first' | 'go'; focusTaskId?: string; busy: boolean; onPolicyChange?(policy: 'first' | 'go'): void;
  onStart(task: Task): Promise<void>; onPause(task: Task): Promise<void>; onReview(task: Task): void; onRoute(task: Task, to: Slot): Promise<void>; onReopen(task: Task): Promise<void>; onOpenTeam(task: Task): void; onOpenThread(task: Task): void;
  /** Rejects when the task was not made, so the board keeps the typed words. */
  onCreateTask(input: { name: string; description: string }): Promise<void>; };
export type TeamProps = { project: Project; state: ProjectState; members: TeamMember[]; mail: MailboxMessage[]; runs: TeamRun[]; focusTaskId?: string; usage: UsageSnapshot[]; busy: boolean;
  onMessage(to: Slot | 'diomedes', text: string): Promise<void>; onStop(m: TeamMember): Promise<void>; onWake(m: TeamMember): Promise<void>; onOpenThread(m: TeamMember): void; onAddMember?(): void; };
export type FilesPaneProps = { projectId: string; documents: DocumentInfo[]; loading: boolean; failure: string | null; openPath: string | null; width: number;
  onOpen(path: string | null): void; onWidth(width: number): void; onClose(): void; };
export type PalettePoint = '' | 'live' | 'attn' | 'fail' | 'done';
export type PaletteAction = { label: string; run(): void | Promise<void>; light?: boolean; stay?: boolean };
export type PaletteEntry = { group: 'Recent' | 'Tasks' | 'Files' | 'Workers' | 'Models' | 'Projects' | 'Views'; id: string; name: string; sub: string; point: PalettePoint; actions: PaletteAction[];
  /** Extra text the verb search matches but the row does not print: a document's full path, so a folder name finds a file whose row shows only its name. */
  search?: string };
export type PaletteProps = { open: boolean; entries(query: string): PaletteEntry[]; onClose(): void; query?: string; onQuery?(query: string): void };
