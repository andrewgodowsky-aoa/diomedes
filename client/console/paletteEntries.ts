import type {
  Change,
  Conversation,
  EngineCatalog,
  IntegrationStatus,
  Need,
  Project,
  Session,
  Slot,
  Task,
  TeamMember,
} from '../../shared/types';
import type { PaletteEntry, PalettePoint, ShellView } from './types';

/**
 * Ctrl+K entries: 1:1 with the "Ctrl+K: find a thing and act on it in its
 * current state" script section of 05-instrumented-density-prototype.html.
 *
 * `buildEntries` returns every row unfiltered (Tasks, Workers, Models,
 * Projects, Views). `applyQuery` adds the verb search (`rows()` in the
 * prototype) and the Recent group. Recent names live in module memory for
 * the session; `noteRecent` records one after a non-stay action runs.
 */

export type BoardLike = 'ready' | 'working' | 'review' | 'blocked' | 'done';

export interface PaletteHandlers {
  startTask(task: Task): void | Promise<void>;
  pauseTask(task: Task): void | Promise<void>;
  reviewTask(task: Task): void;
  routeTask(task: Task, to: Slot): void | Promise<void>;
  reopenTask(task: Task): void | Promise<void>;
  openBoard(task: Task): void;
  openTeam(task: Task): void;
  setRequested(requested: Conversation['requested']): void;
  messageMember(member: TeamMember): void;
  stopMember(member: TeamMember): void | Promise<void>;
  wakeMember(member: TeamMember): void | Promise<void>;
  selectThread(threadId: string): void;
  setView(view: ShellView): void;
  openProject(project: Project): void;
}

export interface PaletteContext {
  tasks: Task[];
  sessions: Session[];
  needs: Need[];
  changes: Change[];
  members: TeamMember[];
  /** engine id -> live catalogue (GET /engines/:id/models), as the Picker reads it. */
  catalogs: Record<string, EngineCatalog>;
  integrations: IntegrationStatus[];
  /** Open projects, from App. */
  projects: Project[];
  currentProjectId: string;
  currentThread: Conversation | null;
  policy: 'first' | 'go';
  view: ShellView;
  focusTaskId?: string;
  focusTaskName?: string;
  /** Palette UI state owned by the Shell so entries and the input stay in sync. */
  pendingTaskId: string | null;
  routingTaskId: string | null;
  onPendingTask(id: string | null): void;
  onRoutingTask(id: string | null): void;
  /** Pivot the palette to the model list without closing (the Model verb). */
  onPivotModels(): void;
  handlers: PaletteHandlers;
}

/** Board mapping: todo->ready; working; waiting with needs-ok or
 * changes-ready->review; waiting otherwise->blocked; done. */
export function taskBoardState(task: Task): BoardLike {
  if (task.state === 'todo') return 'ready';
  if (task.state === 'working') return 'working';
  if (task.state === 'done') return 'done';
  if (task.reason === 'needs-ok' || task.reason === 'changes-ready') return 'review';
  return 'blocked';
}

function taskPoint(state: BoardLike): PalettePoint {
  if (state === 'working') return 'live';
  if (state === 'review') return 'attn';
  if (state === 'blocked') return 'fail';
  if (state === 'done') return 'done';
  return '';
}

function workerPoint(status: TeamMember['status']): PalettePoint {
  if (status === 'working') return 'live';
  if (status === 'error') return 'attn';
  if (status === 'stopped') return 'done';
  return '';
}

function liveSession(sessions: Session[], taskId: string): Session | null {
  return (
    sessions.find(
      (s) => s.taskId === taskId && ['queued', 'working', 'waiting'].includes(s.state),
    ) ?? null
  );
}

function taskWorker(task: Task, ctx: PaletteContext): string {
  const live = liveSession(ctx.sessions, task.id);
  if (live) return live.engine.name;
  if (task.assignedTo) {
    const member = ctx.members.find((m) => m.slotId === task.assignedTo);
    return member ? member.name : task.assignedTo;
  }
  return task.owner === 'you' ? 'You' : 'Diomedes';
}

function ageOf(iso: string | undefined): string {
  if (!iso) return 'new';
  const at = new Date(iso).getTime();
  const ms = Date.now() - at;
  if (!Number.isFinite(ms) || ms < 0) return 'new';
  const mins = Math.floor(ms / 60000);
  if (mins < 1) return 'now';
  if (mins < 60) return `${mins} m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} h`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days} d`;
  return new Date(at).toLocaleDateString([], { weekday: 'short' }).toLowerCase();
}

function engineName(ctx: PaletteContext, engine: string): string {
  return ctx.integrations.find((i) => i.id === engine)?.name ?? engine;
}

function taskEntries(ctx: PaletteContext): PaletteEntry[] {
  return ctx.tasks.map((task) => {
    const state = taskBoardState(task);
    const worker = taskWorker(task, ctx);
    const sub = `${state} on ${worker}, ${ageOf(task.createdAt)}`;
    const h = ctx.handlers;
    // Blocked + routing open: the member list is the second step (stay),
    // then one action per member routes the task.
    if (state === 'blocked' && ctx.routingTaskId === task.id) {
      return {
        group: 'Tasks',
        id: `task:${task.id}`,
        name: task.name,
        sub,
        point: taskPoint(state),
        actions: [
          ...ctx.members.map((m) => ({
            label: m.name,
            run: () => {
              ctx.onRoutingTask(null);
              void h.routeTask(task, m.slotId);
            },
          })),
          {
            label: 'Cancel',
            stay: true,
            run: () => ctx.onRoutingTask(null),
          },
        ],
      } satisfies PaletteEntry;
    }
    // Ready under "Show me first" confirms inside the palette.
    if (state === 'ready' && ctx.policy === 'first' && ctx.pendingTaskId === task.id) {
      return {
        group: 'Tasks',
        id: `task:${task.id}`,
        name: task.name,
        sub,
        point: taskPoint(state),
        actions: [
          {
            label: 'Start now',
            light: true,
            run: () => {
              ctx.onPendingTask(null);
              void h.startTask(task);
            },
          },
          { label: 'Not now', stay: true, run: () => ctx.onPendingTask(null) },
          { label: 'Board', run: () => h.openBoard(task) },
          { label: 'Model', stay: true, run: () => ctx.onPivotModels() },
        ],
      } satisfies PaletteEntry;
    }
    const actions: PaletteEntry['actions'] = [];
    if (state === 'ready') {
      if (ctx.policy === 'first') {
        actions.push({
          label: 'Start',
          light: true,
          stay: true,
          run: () => ctx.onPendingTask(task.id),
        });
      } else {
        actions.push({ label: 'Start', light: true, run: () => void h.startTask(task) });
      }
    }
    if (state === 'working') {
      actions.push({ label: 'Stop', run: () => void h.pauseTask(task) });
      actions.push({ label: 'Team', run: () => h.openTeam(task) });
    }
    if (state === 'review') {
      actions.push({ label: 'Review', light: true, run: () => h.reviewTask(task) });
    }
    if (state === 'blocked') {
      actions.push({
        label: 'Route to',
        light: true,
        stay: true,
        run: () => ctx.onRoutingTask(task.id),
      });
    }
    if (state === 'done') {
      actions.push({ label: 'Reopen', run: () => void h.reopenTask(task) });
    }
    if (state !== 'done') {
      actions.push({ label: 'Board', run: () => h.openBoard(task) });
      actions.push({ label: 'Model', stay: true, run: () => ctx.onPivotModels() });
    }
    return {
      group: 'Tasks',
      id: `task:${task.id}`,
      name: task.name,
      sub,
      point: taskPoint(state),
      actions,
    } satisfies PaletteEntry;
  });
}

function workerEntries(ctx: PaletteContext): PaletteEntry[] {
  return ctx.members.map((m) => {
    const sub = `${m.role}, ${m.engine}${m.status === 'error' ? ', blocked' : ''}`;
    const h = ctx.handlers;
    const actions: PaletteEntry['actions'] = [
      { label: 'Message', light: true, run: () => h.messageMember(m) },
    ];
    if (m.status !== 'stopped') {
      actions.push({ label: 'Stop', run: () => void h.stopMember(m) });
    }
    if (m.status === 'waiting' && (m.unread ?? 0) > 0) {
      actions.push({ label: 'Start', run: () => void h.wakeMember(m) });
    }
    actions.push({ label: 'Lane', run: () => h.setView('Team') });
    if (m.threadId) {
      actions.push({ label: 'Thread', run: () => h.selectThread(m.threadId!) });
    }
    return {
      group: 'Workers',
      id: `worker:${m.slotId}`,
      name: m.name,
      sub,
      point: workerPoint(m.status),
      actions,
    } satisfies PaletteEntry;
  });
}

function modelEntries(ctx: PaletteContext): PaletteEntry[] {
  if (!ctx.currentThread) return [];
  const requested = ctx.currentThread.requested?.model ?? null;
  const out: PaletteEntry[] = [];
  for (const [engine, catalog] of Object.entries(ctx.catalogs)) {
    const name = engineName(ctx, engine);
    for (const m of catalog.models ?? []) {
      out.push({
        group: 'Models',
        id: `model:${engine}:${m.slug}`,
        name: m.name,
        sub: `${m.slug}, ${name}`,
        point: m.slug === requested ? 'live' : '',
        actions: [
          {
            label: 'Use here',
            light: true,
            run: () => ctx.handlers.setRequested({ model: m.slug, effort: m.defaultEffort }),
          },
        ],
      });
    }
    out.push({
      group: 'Models',
      id: `model:${engine}:default`,
      name: 'Default',
      sub: `default, ${name}`,
      point: requested === null ? 'live' : '',
      actions: [
        { label: 'Use here', light: true, run: () => ctx.handlers.setRequested(null) },
      ],
    });
  }
  return out;
}

function projectEntries(ctx: PaletteContext): PaletteEntry[] {
  return ctx.projects.map((p) => ({
    group: 'Projects',
    id: `project:${p.id}`,
    name: p.name,
    sub: p.id === ctx.currentProjectId ? 'open now' : 'project',
    point: p.id === ctx.currentProjectId ? 'done' : '',
    actions: [{ label: 'Open', run: () => ctx.handlers.openProject(p) }],
  }));
}

function viewEntries(ctx: PaletteContext): PaletteEntry[] {
  const focus = ctx.focusTaskName ?? 'no open task';
  return (['Thread', 'Board', 'Team'] as ShellView[]).map((v) => ({
    group: 'Views',
    id: `view:${v}`,
    name: v,
    sub: `${focus}, from here`,
    point: '',
    actions: [{ label: 'Open', run: () => ctx.handlers.setView(v) }],
  }));
}

export function buildEntries(ctx: PaletteContext): PaletteEntry[] {
  return [
    ...taskEntries(ctx),
    ...workerEntries(ctx),
    ...modelEntries(ctx),
    ...projectEntries(ctx),
    ...viewEntries(ctx),
  ];
}

/** Verb search: every whitespace-separated word must match the name, the
 * sub, or the start of one of the row's action labels. */
export function filterPalette(entries: PaletteEntry[], query: string): PaletteEntry[] {
  const q = query.trim().toLowerCase();
  if (!q) return entries;
  const words = q.split(/\s+/);
  return entries.filter((e) =>
    words.every(
      (w) =>
        e.name.toLowerCase().includes(w) ||
        e.sub.toLowerCase().includes(w) ||
        e.actions.some((a) => a.label.toLowerCase().startsWith(w)),
    ),
  );
}

const recent: string[] = [];

export function noteRecent(name: string): void {
  const at = recent.indexOf(name);
  if (at >= 0) recent.splice(at, 1);
  recent.unshift(name);
  if (recent.length > 3) recent.pop();
}

export function peekRecent(): string[] {
  return [...recent];
}

export function clearRecent(): void {
  recent.length = 0;
}

/** With an empty query, the last three names acted on come first, in their
 * current state. */
export function applyQuery(all: PaletteEntry[], query: string): PaletteEntry[] {
  const rows = filterPalette(all, query);
  if (query.trim() || !recent.length) return rows;
  const heads = recent
    .map((name) => all.find((e) => e.name === name))
    .filter((e): e is PaletteEntry => !!e)
    .map((e) => ({ ...e, group: 'Recent' as const }));
  return [...heads, ...rows];
}
