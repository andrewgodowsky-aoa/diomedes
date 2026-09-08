import type {
  MailboxMessage,
  Project,
  ProjectState,
  Slot,
  Task,
  TeamMember,
  TeamRun,
  UsageSnapshot,
} from '../../shared/types';

export type ShellView = 'Thread' | 'Board' | 'Team';
export type BoardProps = { project: Project; state: ProjectState; tasks: Task[]; policy: 'first' | 'go'; focusTaskId?: string; busy: boolean; onPolicyChange?(policy: 'first' | 'go'): void;
  onStart(task: Task): Promise<void>; onPause(task: Task): Promise<void>; onReview(task: Task): void; onRoute(task: Task, to: Slot): Promise<void>; onReopen(task: Task): Promise<void>; onOpenTeam(task: Task): void; onOpenThread(task: Task): void; };
export type TeamProps = { project: Project; state: ProjectState; members: TeamMember[]; mail: MailboxMessage[]; runs: TeamRun[]; focusTaskId?: string; usage: UsageSnapshot[]; busy: boolean;
  onMessage(to: Slot | 'diomedes', text: string): Promise<void>; onStop(m: TeamMember): Promise<void>; onWake(m: TeamMember): Promise<void>; onOpenThread(m: TeamMember): void; onAddMember?(): void; };
export type PalettePoint = '' | 'live' | 'attn' | 'fail' | 'done';
export type PaletteAction = { label: string; run(): void | Promise<void>; light?: boolean; stay?: boolean };
export type PaletteEntry = { group: 'Recent' | 'Tasks' | 'Workers' | 'Models' | 'Projects' | 'Views'; id: string; name: string; sub: string; point: PalettePoint; actions: PaletteAction[] };
export type PaletteProps = { open: boolean; entries(query: string): PaletteEntry[]; onClose(): void; query?: string; onQuery?(query: string): void };
