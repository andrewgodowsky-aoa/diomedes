/**
 * Worker rows (plan section 4.8, S1 of DIO-175, 2026-10-03): the production `WorkRowsSource`.
 *
 * One row per unit of work a person can see working, read from records this app already
 * keeps and nothing else:
 * - `session`: a Native Work, sample or loop Session;
 * - `team-member`: a Team member's work, either its wake (a Session with its slot) or a manual
 *   Team card it was assigned (shared/task-workflow.ts), or, while a member works with no
 *   Session yet, the member's own status;
 * - `h14-worker` and `external-worker`: the children of the live H14 lead, from its run and
 *   the handoff ledger (`harness.loop.teamView`). A child on an external engine route
 *   (`codex`, `claude-code`, `opencode`, `cursor`, `devin`, `oh-my-pi`) is an external worker;
 *   none exist before S2/S3, and they are mapped by route now.
 *
 * Which runs: every active one, then the three that ended last. Rows carry labels, titles,
 * states, verification and payer only, and never anything read from the full `state` event.
 * A title is the name of the card the work is on, as the Board shows it, capped at
 * `WORK_ROW_TITLE_LIMIT`; a member working with no card is titled by its own name. Nothing else
 * from a card or a run reaches a row: no document text or file list, no answer, no hand-off
 * text, no mailbox message and no log line. A card's name is the person's words or a proposal
 * the person sees on the Board, with one exception: a card a member's wake made from the mail
 * it answered (`Task.createdFrom` `team-mail`) is named by the mail's words, so its rows are
 * titled by whose wake it is ("Bram is answering Team mail") and it never becomes the
 * snapshot's `taskTitle`. A managed row is named Nectovia and never by its model or vendor.
 * Reading rows writes nothing, admits nothing and calls no model (A38): verification is read
 * from History with the pure H17 reader.
 */
import { LOCAL_MODEL_ROUTE } from '../shared/local-model.js';
import { routeDisplayName, isExternalEngine } from '../shared/engines.js';
import type { HarnessRun } from '../shared/harness.js';
import { isModelApiRoute, NECTOVIA_ROUTE } from '../shared/model-api.js';
import { NATIVE_LOOP_ENGINE } from '../shared/native-loop.js';
import { workerRowPayerOf } from '../shared/funding-source.js';
import type { HandoffView, TeamLeadView } from '../shared/team-delegation.js';
import { isManualCard } from '../shared/task-workflow.js';
import type { ProjectState, Session, Task, TeamMember } from '../shared/types.js';
import { latestVerification, verificationOf, type VerificationState } from '../shared/verification.js';
import {
  WORK_ROW_TITLE_LIMIT,
  type WorkerRow,
  type WorkerRowKind,
  type WorkerRowPayer,
  type WorkerRowState,
  type WorkerRowVerification,
  type WorkRowsSnapshot,
  type WorkRowsSource,
} from '../shared/work-rows.js';
import type { Store } from './store.js';

/** How many ended runs a snapshot keeps after the active ones. */
export const WORK_ROWS_RECENT_ENDED = 3;

/** Routes that run on this computer and bill nobody (shared/execution.ts `LOCAL_ROUTES`, plus fixtures). */
const LOCAL_ROUTES: readonly string[] = ['sample', 'native-fixture', 'fixture', 'harness-runtime', 'probe'];
const ACTIVE: readonly Session['state'][] = ['queued', 'working', 'waiting'];
const TERMINAL_RUN: readonly HarnessRun['state'][] = ['completed', 'failed', 'cancelled'];

/** Who pays for a row's work, from the route its run recorded. */
export function payerForRoute(route: string | null | undefined): WorkerRowPayer {
  if (!route) return 'unknown';
  if (route === NECTOVIA_ROUTE) return 'nectovia-credits';
  // The local model is a model-API route that runs on this computer and bills nobody.
  if (route === LOCAL_MODEL_ROUTE) return 'local';
  if (isModelApiRoute(route)) return 'your-key';
  if (route === 'codex' || isExternalEngine(route)) return 'your-subscription';
  if (LOCAL_ROUTES.includes(route)) return 'local';
  return 'unknown';
}

/** The name the Console already gives a route. A fixture reads as the Sample it stands for. */
export function labelForRoute(route: string | null | undefined): string {
  if (!route) return 'Not reported';
  if (LOCAL_ROUTES.includes(route)) return routeDisplayName('sample');
  return routeDisplayName(route);
}

/** True for a route whose engine is the person's own external tool. */
function externalRoute(route: string | null | undefined): boolean {
  return route === 'codex' || isExternalEngine(route);
}

export function rowTitle(text: string): string {
  const title = text.replace(/\s+/g, ' ').trim();
  return title.length > WORK_ROW_TITLE_LIMIT ? `${title.slice(0, WORK_ROW_TITLE_LIMIT - 1).trimEnd()}…` : title;
}

/** True for a card a member's wake made from Team mail: its name is the mail's words. */
function namedByMail(task: Task | undefined): boolean {
  return task?.createdFrom === 'team-mail';
}

/**
 * A row's title from its card: the card's name, or, for a card made from Team mail, only whose
 * wake it is. `fallback` titles a row with no card.
 */
function cardTitle(task: Task | undefined, member: TeamMember | undefined, fallback = ''): string {
  if (namedByMail(task)) return rowTitle(member ? `${member.name} is answering Team mail` : 'Answering Team mail');
  return rowTitle(task?.name ?? fallback);
}

const VERIFICATION: Record<VerificationState, WorkerRowVerification> = {
  verified: 'verified',
  'not-verified': 'unverified',
  failed: 'failed',
  // An uncertain result was checked and could not be confirmed: it is not verified.
  uncertain: 'unverified',
};

const SESSION_STATE: Record<Session['state'], WorkerRowState> = {
  queued: 'queued',
  working: 'working',
  waiting: 'waiting',
  done: 'answered',
  stopped: 'stopped',
  failed: 'failed',
};

const CHILD_STATE: Record<HandoffView['outcome'], WorkerRowState> = {
  running: 'working',
  completed: 'answered',
  reused: 'answered',
  stopped: 'stopped',
  failed: 'failed',
  refused: 'failed',
  // The child ended and nobody confirmed how.
  died: 'unknown',
};

const MEMBER_STATE: Partial<Record<TeamMember['status'], WorkerRowState>> = {
  working: 'working',
  waiting: 'waiting',
};

/** The route a Session ran on, from its own record. */
function sessionRoute(session: Session): string | null {
  if (session.route) return session.route;
  if (session.sample) return 'sample';
  if (session.engine.name === 'native-fixture') return 'native-fixture';
  if (session.engine.name === 'codex-harness') return 'codex';
  return null;
}

function sessionState(session: Session, task: Task | undefined): WorkerRowState {
  if (
    ACTIVE.includes(session.state) &&
    (task?.stopReceipts ?? []).some((receipt) => receipt.sessionId === session.id && !receipt.acknowledged)
  )
    return 'stop-requested';
  return SESSION_STATE[session.state] ?? 'unknown';
}

function sessionVerification(state: ProjectState, session: Session, task: Task | undefined): WorkerRowVerification {
  if (ACTIVE.includes(session.state) || !latestVerification(state.history, session.id)) return 'not-run';
  return VERIFICATION[verificationOf({ session, task: task ?? null, history: state.history }).state];
}

/** The member a Session is the work of: its wake slot, or the manual card it ran. */
function memberOf(state: ProjectState, session: Session, task: Task | undefined): TeamMember | undefined {
  const members = state.team?.members ?? [];
  if (session.slotId) return members.find((member) => member.slotId === session.slotId);
  if (task && isManualCard(task) && task.assignedTo) return members.find((member) => member.slotId === task.assignedTo);
  return undefined;
}

/** What reads the H14 lead of a loop Session: the host's harness, or nothing in a host without one. */
export interface WorkRowsHarness {
  /** The id of the loop run presenting this Session, or null. Asked once per Session. */
  runIdFor(projectId: string, sessionId: string): Promise<string | null>;
  run(projectId: string, runId: string): Promise<HarnessRun | null>;
  /** The run's H14 team view, or null when it was admitted without a team. */
  teamView(run: HarnessRun): Promise<TeamLeadView | null>;
}

export interface WorkRowsOptions {
  store: Store;
  harness?: WorkRowsHarness;
  now?: () => string;
}

export class ProductionWorkRows implements WorkRowsSource {
  private readonly store: Store;
  private readonly harness: WorkRowsHarness | undefined;
  private readonly now: () => string;
  /** Session id to its loop run id. A Session is presented by one run, forever. */
  private readonly loopRuns = new Map<string, string | null>();
  /** H14 children of runs that have ended, which cannot change again. */
  private readonly settled = new Map<string, { workers: readonly HandoffView[] } | null>();

  constructor(options: WorkRowsOptions) {
    this.store = options.store;
    this.harness = options.harness;
    this.now = options.now ?? (() => new Date().toISOString());
  }

  async projects(): Promise<string[]> {
    return this.store.projectIds().filter((id) => !this.store.isHomeProject(id));
  }

  subscribe(listener: (projectId: string) => void): () => void {
    this.store.on('change', listener);
    return () => {
      this.store.off('change', listener);
    };
  }

  /**
   * Reads started in this turn of the event loop, by project. Every listener of one change
   * runs in the same turn and shares one read; a later change always starts its own.
   */
  private readonly reading = new Map<string, Promise<WorkRowsSnapshot | null>>();

  snapshot(projectId: string): Promise<WorkRowsSnapshot | null> {
    const shared = this.reading.get(projectId);
    if (shared) return shared;
    const read = this.read(projectId);
    this.reading.set(projectId, read);
    queueMicrotask(() => this.reading.delete(projectId));
    return read;
  }

  private async read(projectId: string): Promise<WorkRowsSnapshot | null> {
    let state: ProjectState;
    try {
      state = this.store.state(projectId);
    } catch {
      return null;
    }
    const taskOf = (id: string) => state.tasks.find((task) => task.id === id);
    const active = state.sessions
      .filter((session) => ACTIVE.includes(session.state))
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt) || b.id.localeCompare(a.id));
    const ended = state.sessions
      .filter((session) => !ACTIVE.includes(session.state))
      .sort(
        (a, b) =>
          (b.endedAt ?? b.startedAt).localeCompare(a.endedAt ?? a.startedAt) || b.id.localeCompare(a.id),
      )
      .slice(0, WORK_ROWS_RECENT_ENDED);
    const shown = [...active, ...ended];

    const rows: WorkerRow[] = [];
    let rootRunId: string | null = null;
    let taskTitle: string | null = null;
    const working = new Set<string>();
    for (const session of shown) {
      const task = taskOf(session.taskId);
      const member = memberOf(state, session, task);
      const route = sessionRoute(session);
      if (member && ACTIVE.includes(session.state)) working.add(member.slotId);
      const kind: WorkerRowKind = member ? 'team-member' : 'session';
      rows.push({
        rowId: `session:${session.id}`,
        kind,
        label: labelForRoute(route),
        title: cardTitle(task, member),
        state: sessionState(session, task),
        startedAt: session.startedAt,
        verification: sessionVerification(state, session, task),
        payer: payerForRoute(route),
      });
      if (taskTitle === null && ACTIVE.includes(session.state) && task && !namedByMail(task))
        taskTitle = rowTitle(task.name);
      // The live (or last) H14 lead's children follow its own row.
      if (session.engine.name === NATIVE_LOOP_ENGINE && rootRunId === null) {
        const lead = await this.lead(projectId, session);
        if (lead) {
          rootRunId = lead.runId;
          if (ACTIVE.includes(session.state) && task && !namedByMail(task)) taskTitle = rowTitle(task.name);
          for (const child of lead.workers)
            rows.push({
              rowId: `h14:${child.handoffId}`,
              kind: externalRoute(child.route) ? 'external-worker' : 'h14-worker',
              label: labelForRoute(child.route),
              // The lead's task, never the handed text: that is model-written and may name files.
              title: cardTitle(task, member),
              state: CHILD_STATE[child.outcome] ?? 'unknown',
              startedAt: null,
              verification: child.verification ? VERIFICATION[child.verification.state] : 'not-run',
              // The funding the hand-off recorded for an external worker's turn (S2), since one
              // engine can run on a subscription or on a key; the route, for a record without it.
              payer: child.payer ? workerRowPayerOf(child.payer) : payerForRoute(child.route),
            });
        }
      }
    }
    // A member that works with no Session of its own yet still has a row.
    for (const member of state.team?.members ?? []) {
      const memberState = MEMBER_STATE[member.status];
      if (!memberState || working.has(member.slotId)) continue;
      const task = state.tasks.find(
        (item) => item.assignedTo === member.slotId && !item.deletedAt && item.state !== 'done',
      );
      rows.push({
        rowId: `member:${member.slotId}`,
        kind: 'team-member',
        label: labelForRoute(member.engine),
        title: cardTitle(task, member, member.name),
        state: memberState,
        startedAt: null,
        verification: 'not-run',
        payer: payerForRoute(member.engine),
      });
    }
    return { projectId, rootRunId, taskTitle, rows, at: this.now() };
  }

  /** The H14 lead presenting a loop Session, with its workers; null when it has no team. */
  private async lead(projectId: string, session: Session): Promise<{ runId: string; workers: readonly HandoffView[] } | null> {
    if (!this.harness) return null;
    try {
      let runId = this.loopRuns.get(session.id);
      if (runId === undefined) {
        runId = await this.harness.runIdFor(projectId, session.id);
        // A run can be written just after its Session, so only a found run, or an ended
        // Session's missing one, is final; a live Session without one is asked again.
        if (runId !== null || !ACTIVE.includes(session.state)) this.loopRuns.set(session.id, runId);
      }
      if (runId === null) return null;
      const settled = this.settled.get(runId);
      if (settled !== undefined) return settled ? { runId, workers: settled.workers } : null;
      const run = await this.harness.run(projectId, runId);
      if (!run) return null;
      const view = await this.harness.teamView(run);
      const result = view ? { workers: view.workers } : null;
      if (TERMINAL_RUN.includes(run.state) && view?.workers.every((child) => child.outcome !== 'running'))
        this.settled.set(runId, result);
      return result ? { runId, workers: result.workers } : null;
    } catch {
      // A run that cannot be read leaves its lead's row standing on its own.
      return null;
    }
  }
}
