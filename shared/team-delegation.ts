/**
 * H14: bounded workers, read-only advisors and durable handoffs for a lead loop.
 *
 * A lead is an H13 Diomedes work loop (`shared/native-loop.ts`). When the person
 * admits it with a team, the lead may hand bounded tasks to workers and ask an
 * advisor. Nothing here is a second runtime: every worker and every advisor is
 * an ordinary harness run started through `RunService`, and every rule below is
 * checked by the host before that run exists.
 *
 * - **A worker is bounded.** Its budget (turns, reported tokens, wall time) and
 *   its read scope are explicit. The model may ask for less, never more: a scope
 *   wider than the lead's, or a budget above what the person admitted, is refused
 *   by name and nothing starts.
 * - **A worker never holds more authority than its lead.** Its capabilities are
 *   the lead's, narrowed by its Agent's ceiling. Its tools only read. Any effect
 *   still belongs to the lead, through H12 admission, Trust and a Need.
 * - **An advisor only advises.** It has read tools and nothing else, and what it
 *   says is recorded as evidence under the model that said it. Advice is never a
 *   permission and never verified as if it were work.
 * - **Every handoff is durable.** The host appends each event to an append-only
 *   ledger (`server/team/handoff-ledger.ts`) and the view below is projected from
 *   that ledger and the child runs' own records on every read.
 *
 * Pure: no clock, no disk, no request. Client and server share it.
 */
import type { HarnessBudget, HarnessRun, HarnessRunState, HarnessUsage } from './harness.js';
import { reportedModels, type LoopModel } from './native-loop.js';
import type { VerificationState } from './verification.js';

export const TEAM_CONTRACT_VERSION = 1 as const;
/** The capability a worker run is started under. */
export const TEAM_WORKER_CAPABILITY = 'diomedes-loop-worker';
/** The capability an advisor run is started under. */
export const TEAM_ADVISOR_CAPABILITY = 'diomedes-loop-advisor';
/** The tool the lead is offered to hand bounded tasks to workers. Never a registry tool. */
export const ASSIGN_TOOL = 'assign_workers';
/** The tool the lead is offered to ask its advisor. Never a registry tool. */
export const ADVISE_TOOL = 'consult_advisor';

/**
 * Proposed defaults, recorded for Andrew to confirm (docs/implementation/2026-09-24-h14-teams.md).
 * Conservative on purpose: one level of delegation, at most three workers at once.
 */
export const TEAM_LIMITS = Object.freeze({
  /** A worker is never offered a delegation tool, so work goes one level deep. */
  depth: 1,
  /** How many workers one `assign_workers` call may run at the same time. */
  concurrentWorkers: 3,
  /**
   * How many workers one lead run may start in all, retries included. Four, as for any
   * run's delegates (Andrew, 2026-09-24; shared/sandbox.ts DELEGATION_LIMITS.perRun).
   */
  workersPerRun: 4,
  /** How many times one lead run may ask its advisor. */
  advicePerRun: 2,
  /** The most files one worker's scope may name. */
  scopeFiles: 32,
  taskChars: 2000,
  questionChars: 2000,
  /** Ceilings a person's admitted budget is held to. */
  maxTurns: 8,
  maxTokens: 400_000,
  maxWallMs: 30 * 60_000,
  /** The budget a worker gets when the person names none. */
  worker: { turns: 4, tokens: null, wallMs: 5 * 60_000 },
  /** An advisor reads a little and answers; its budget is fixed. */
  advisor: { turns: 3, tokens: null, wallMs: 2 * 60_000 },
});

/** A worker's budget as the person admitted it. Null tokens or wall time means "not limited here". */
export interface WorkerBudget {
  readonly turns: number;
  /** Reported tokens (input plus output) across the worker's model calls. */
  readonly tokens: number | null;
  readonly wallMs: number | null;
}

/** The run-service budget a worker budget maps to: one model and one tool call per turn. */
export function harnessBudgetOf(budget: WorkerBudget): HarnessBudget {
  return { units: budget.turns * 2, modelCalls: budget.turns, toolCalls: budget.turns, wallMs: budget.wallMs };
}

/** Why an admitted budget is out of bounds, or null. */
export function budgetRefusal(budget: WorkerBudget): string | null {
  if (!Number.isSafeInteger(budget.turns) || budget.turns < 1 || budget.turns > TEAM_LIMITS.maxTurns)
    return `A worker takes between 1 and ${TEAM_LIMITS.maxTurns} turns.`;
  if (budget.tokens !== null && (!Number.isSafeInteger(budget.tokens) || budget.tokens < 1 || budget.tokens > TEAM_LIMITS.maxTokens))
    return `A worker's token budget is between 1 and ${TEAM_LIMITS.maxTokens.toLocaleString('en-US')}.`;
  if (budget.wallMs !== null && (!Number.isSafeInteger(budget.wallMs) || budget.wallMs < 1000 || budget.wallMs > TEAM_LIMITS.maxWallMs))
    return `A worker's time budget is between 1 second and ${TEAM_LIMITS.maxWallMs / 60_000} minutes.`;
  return null;
}

/**
 * The budget one assignment gets: what the model asked for, which may only be
 * smaller than what the person admitted. Asking for more is refused, not clamped,
 * so the lead's record says plainly that it asked.
 */
export function assignedBudget(
  admitted: WorkerBudget,
  asked: { readonly turns?: number | undefined },
): { budget: WorkerBudget; refusal: null } | { budget: null; refusal: string } {
  if (asked.turns === undefined) return { budget: admitted, refusal: null };
  if (asked.turns > admitted.turns)
    return {
      budget: null,
      refusal: `This worker asked for ${asked.turns} turns; its budget allows at most ${admitted.turns}.`,
    };
  return { budget: { ...admitted, turns: asked.turns }, refusal: null };
}

/**
 * Whether a worker's read scope stays inside its lead's. The lead's scope is
 * null when the person gave the lead the whole project (as its route allows);
 * a worker's scope is always an explicit list.
 */
export function scopeRefusal(worker: readonly string[], lead: readonly string[] | null): string | null {
  if (worker.length === 0) return 'A worker needs an explicit list of the files it may read.';
  if (worker.length > TEAM_LIMITS.scopeFiles)
    return `A worker may be given at most ${TEAM_LIMITS.scopeFiles} files.`;
  if (lead === null) return null;
  const allowed = new Set(lead);
  const outside = worker.filter((file) => !allowed.has(file));
  return outside.length
    ? `${outside.join(', ')} ${outside.length === 1 ? 'is' : 'are'} outside what the lead may read, so a worker cannot be given ${outside.length === 1 ? 'it' : 'them'}.`
    : null;
}

/**
 * The capabilities a child run holds: the lead's, narrowed. An Agent whose
 * ceiling is `review` never writes, so it holds none of the lead's write
 * permissions. Nothing is ever added.
 */
export function childCapabilities(lead: readonly string[], ceiling: string): string[] {
  return ceiling === 'review' ? [] : [...lead];
}

// --- what the person admitted -------------------------------------------------------------

/** One role (worker or advisor) as admitted: the Agent it works under and where it runs. */
export interface TeamRole {
  readonly agent: { readonly id: string; readonly version: string; readonly name: string; readonly ceiling: string };
  /** The Agent's role text, carried as guidance in the child's instructions. Never authority. */
  readonly guidance: string;
  /** The artifact the lead hands this role, one both sides declare (`shared/handoff.ts`). */
  readonly artifact: string;
  readonly route: string;
  readonly model: string | null;
  readonly accountRoute: string | null;
  /** The H09 profile revision that named the route and model, or null when the route was chosen directly. */
  readonly profile: {
    readonly profileId: string;
    readonly revision: number;
    readonly name: string;
    readonly digest: string;
    readonly source: string;
    readonly fallback: string | null;
  } | null;
}

/** Pinned in the lead's `LoopRunInput.team` at admission and never recomputed. */
export interface TeamConfig {
  readonly v: 1;
  /** What the lead may read. Null: the whole project, as the lead's route allows. */
  readonly scope: readonly string[] | null;
  readonly worker: TeamRole & { readonly budget: WorkerBudget };
  readonly advisor: TeamRole | null;
  readonly limits: {
    readonly depth: number;
    readonly concurrentWorkers: number;
    readonly workersPerRun: number;
    readonly advicePerRun: number;
  };
}

/** What a worker or advisor child run was admitted with, pinned in its `HarnessRun.input`. */
export interface TeamChildInput {
  readonly v: 1;
  readonly kind: typeof TEAM_WORKER_CAPABILITY | typeof TEAM_ADVISOR_CAPABILITY;
  readonly parent: { readonly runId: string; readonly stepId: string; readonly handoffId: string };
  readonly task: string;
  readonly scope: readonly string[] | null;
  readonly route: string;
  readonly model: string | null;
  readonly accountRoute: string | null;
  readonly budget: WorkerBudget;
}

/** The lead run an H08 Retry continues, pinned on the new attempt. */
export interface TeamRetry {
  readonly runId: string;
  readonly attempt: number;
}

// --- the durable ledger -------------------------------------------------------------------

export type HandoffRole = 'worker' | 'advisor';

interface EventBase {
  readonly v: 1;
  readonly at: string;
  readonly handoffId: string;
  readonly leadRunId: string;
}

/** A worker or advisor was handed a task, and its child run named. */
export interface HandoffOpened extends EventBase {
  readonly kind: 'opened';
  readonly taskId: string | null;
  readonly role: HandoffRole;
  readonly stepId: string;
  readonly childRunId: string;
  readonly envelopeId: string;
  readonly task: string;
  readonly scope: readonly string[];
  readonly budget: WorkerBudget;
  readonly agent: TeamRole['agent'];
  readonly route: string;
  readonly model: string | null;
  readonly profile: TeamRole['profile'];
  /** 1 for a first hand-over; n + 1 when a lead retry runs a failed worker again. */
  readonly attempt: number;
  /** The handoff this one runs again, when it is a retry. */
  readonly retryOf: string | null;
}

/** An assignment the host refused before any run existed. */
export interface HandoffRefused extends EventBase {
  readonly kind: 'refused';
  readonly role: HandoffRole;
  readonly stepId: string;
  readonly task: string;
  readonly scope: readonly string[];
  readonly reason: string;
}

/** A retried lead took a finished worker's answer from its earlier attempt instead of running it again. */
export interface HandoffReused extends EventBase {
  readonly kind: 'reused';
  readonly role: HandoffRole;
  readonly stepId: string;
  readonly from: string;
  readonly task: string;
  readonly scope: readonly string[];
}

/** What a child run ended as, recorded when the lead observed it. */
export interface HandoffSettled extends EventBase {
  readonly kind: 'settled';
  readonly childRunId: string;
  readonly state: HarnessRunState;
  readonly text: string | null;
  readonly reason: string | null;
  readonly models: readonly LoopModel[];
  readonly used: HarnessUsage;
  readonly tokens: number | null;
  readonly wallMs: number | null;
}

export type HandoffEvent = HandoffOpened | HandoffRefused | HandoffReused | HandoffSettled;

// --- what the lead observes ----------------------------------------------------------------

/** One assignment as the lead's `workers:<n>` step records it. */
export interface WorkerResult {
  readonly v: 1;
  readonly handoffId: string;
  readonly role: HandoffRole;
  readonly childRunId: string | null;
  readonly outcome: HandoffOutcome;
  readonly text: string | null;
  readonly reason: string | null;
  readonly models: readonly LoopModel[];
  readonly reusedFrom: string | null;
  /** A worker's sandbox change set, and what became of it (shared/sandbox.ts). */
  readonly changeSet?: import('./sandbox.js').ChangeSetSummary | null;
}

export type HandoffOutcome = 'running' | 'completed' | 'stopped' | 'failed' | 'died' | 'refused';

/** A worker that ended this way stops its lead: the person retries it through H08. */
export const DEAD_OUTCOMES: readonly HandoffOutcome[] = ['failed', 'died'];

const BUDGET_STOP = /budget reached|budget exceeded|turn limit reached/i;

/**
 * What a child run ended as, from its own record. `died` is a run whose last
 * call may have gone out and was never confirmed, or one that is still marked
 * live after its lead stopped driving it.
 */
export function outcomeOf(
  child: Pick<HarnessRun, 'state' | 'cancelReason'> & { readonly failure?: HarnessRun['failure'] },
  leadLive: boolean,
): HandoffOutcome {
  switch (child.state) {
    case 'completed':
      return 'completed';
    case 'cancelled':
      return 'stopped';
    case 'failed':
      // Reaching its own budget is a bounded stop, not a death.
      return budgetStopped(child.failure?.message ?? null) ? 'stopped' : 'failed';
    case 'reconcile_required':
      return 'died';
    default:
      return leadLive ? 'running' : 'died';
  }
}

/** Whether a stop was the worker's own budget rather than its lead. */
export const budgetStopped = (reason: string | null) => Boolean(reason && BUDGET_STOP.test(reason));

/** Reported tokens across a run's succeeded model steps. Null when no step reported any. */
export function reportedTokens(run: Pick<HarnessRun, 'steps'>): number | null {
  let total: number | null = null;
  for (const step of run.steps) {
    if (step.intent.kind !== 'model' || step.state !== 'succeeded') continue;
    const usage = (step.output as { usage?: { inputTokens?: unknown; outputTokens?: unknown } | null } | null)?.usage;
    if (!usage) continue;
    const input = typeof usage.inputTokens === 'number' ? usage.inputTokens : 0;
    const output = typeof usage.outputTokens === 'number' ? usage.outputTokens : 0;
    total = (total ?? 0) + input + output;
  }
  return total;
}

/** Milliseconds between a run's first step start and its last step end, from its own record. */
export function runWallMs(run: Pick<HarnessRun, 'steps' | 'createdAt' | 'updatedAt'>): number | null {
  const start = Date.parse(run.createdAt);
  const end = Date.parse(run.updatedAt);
  return Number.isFinite(start) && Number.isFinite(end) && end >= start ? end - start : null;
}

// --- the view --------------------------------------------------------------------------------

export interface HandoffView {
  readonly handoffId: string;
  readonly role: HandoffRole;
  readonly stepId: string;
  readonly task: string;
  readonly scope: readonly string[];
  readonly outcome: HandoffOutcome | 'reused';
  /** One plain sentence for the outcome. */
  readonly sentence: string;
  readonly attempt: number;
  readonly retryOf: string | null;
  readonly reusedFrom: string | null;
  readonly childRunId: string | null;
  readonly agent: TeamRole['agent'] | null;
  readonly route: string | null;
  readonly profile: TeamRole['profile'];
  readonly budget: WorkerBudget | null;
  readonly used: {
    readonly turns: number;
    readonly toolCalls: number;
    readonly tokens: number | null;
    readonly wallMs: number | null;
  } | null;
  readonly text: string | null;
  readonly reason: string | null;
  /** The runtime-reported models; empty on a fixed local script. */
  readonly models: readonly LoopModel[];
  /** H17 for a worker: the lead's outcome decides. Null for advice, which is never verified. */
  readonly verification: { readonly state: VerificationState; readonly sentence: string } | null;
}

export interface TeamLeadView {
  readonly runId: string;
  readonly taskId: string | null;
  readonly state: HarnessRunState;
  readonly scope: readonly string[] | null;
  readonly limits: TeamConfig['limits'];
  readonly worker: TeamConfig['worker'];
  readonly advisor: TeamConfig['advisor'];
  readonly retryOf: TeamRetry | null;
  readonly workers: readonly HandoffView[];
  readonly advice: readonly HandoffView[];
}

const LIVE: readonly HarnessRunState[] = ['queued', 'running', 'waiting'];

const SENTENCE: Record<HandoffOutcome | 'reused', string> = {
  running: 'Working on its task.',
  completed: 'Answered its task.',
  stopped: 'Stopped before it answered.',
  failed: 'Failed before it answered. Its lead stopped; retry the lead to run it again.',
  died: 'Ended without a confirmed answer. Its lead stopped; retry the lead to run it again.',
  refused: 'Not started.',
  reused: 'Answered in an earlier attempt of this lead, so it was not run again.',
};

/**
 * One lead's workers and advice, from the ledger and the child runs. The child
 * run is the authority on how a child ended; the ledger says what it was handed.
 * `leadVerification` is H17's projection of the lead's declared checks, the only
 * thing that can make a worker's contribution read as verified.
 */
export function teamLeadView(input: {
  readonly lead: Pick<HarnessRun, 'id' | 'taskId' | 'state'>;
  readonly config: TeamConfig;
  readonly retryOf: TeamRetry | null;
  readonly events: readonly HandoffEvent[];
  readonly children: readonly HarnessRun[];
  readonly leadVerification: { readonly state: VerificationState; readonly sentence: string } | null;
}): TeamLeadView {
  const leadLive = LIVE.includes(input.lead.state);
  const mine = input.events.filter((event) => event.leadRunId === input.lead.id);
  const everyone = new Map<string, HandoffEvent[]>();
  for (const event of input.events) {
    const list = everyone.get(event.handoffId) ?? [];
    list.push(event);
    everyone.set(event.handoffId, list);
  }
  const children = new Map(input.children.map((run) => [run.id, run]));
  const order: string[] = [];
  for (const event of mine) if (!order.includes(event.handoffId)) order.push(event.handoffId);

  const project = (handoffId: string, seen: Set<string> = new Set()): HandoffView | null => {
    if (seen.has(handoffId)) return null;
    seen.add(handoffId);
    const events = everyone.get(handoffId) ?? [];
    // The first record of each kind wins: a replayed step may append its event twice.
    const opened = events.find((event): event is HandoffOpened => event.kind === 'opened');
    const refused = events.find((event): event is HandoffRefused => event.kind === 'refused');
    const reused = events.find((event): event is HandoffReused => event.kind === 'reused');
    const settled = events.find((event): event is HandoffSettled => event.kind === 'settled');
    if (reused) {
      const source = project(reused.from, seen);
      return {
        ...(source ?? emptyView(handoffId, reused.role, reused.stepId, reused.task, reused.scope)),
        handoffId,
        stepId: reused.stepId,
        outcome: 'reused',
        sentence: SENTENCE.reused,
        reusedFrom: reused.from,
        verification: reused.role === 'advisor' ? null : verificationFor(input.leadVerification),
      };
    }
    if (refused)
      return {
        ...emptyView(handoffId, refused.role, refused.stepId, refused.task, refused.scope),
        outcome: 'refused',
        sentence: `Not started: ${refused.reason}`,
        reason: refused.reason,
      };
    if (!opened) return null;
    const child = children.get(opened.childRunId) ?? null;
    const outcome: HandoffOutcome = child
      ? outcomeOf(child, leadLive && opened.leadRunId === input.lead.id)
      : settled
        ? outcomeOf(
            {
              state: settled.state,
              cancelReason: settled.reason,
              failure: settled.reason ? { name: 'Error', message: settled.reason } : null,
            },
            false,
          )
        : leadLive
          ? 'running'
          : 'died';
    const reason = child ? (child.cancelReason ?? child.failure?.message ?? null) : (settled?.reason ?? null);
    const resultText = child
      ? typeof (child.result as { text?: unknown } | null)?.text === 'string'
        ? ((child.result as { text: string }).text)
        : null
      : (settled?.text ?? null);
    return {
      handoffId,
      role: opened.role,
      stepId: opened.stepId,
      task: opened.task,
      scope: opened.scope,
      outcome,
      sentence:
        outcome === 'stopped' && budgetStopped(reason)
          ? `Stopped at its budget: ${reason}.`
          : outcome === 'stopped' && reason
            ? `Stopped: ${reason}.`
            : SENTENCE[outcome],
      attempt: opened.attempt,
      retryOf: opened.retryOf,
      reusedFrom: null,
      childRunId: opened.childRunId,
      agent: opened.agent,
      route: opened.route,
      profile: opened.profile,
      budget: opened.budget,
      used: child
        ? {
            // Turns that got an answer, from the record: a call refused before sending is not one.
            turns: child.steps.filter((step) => step.intent.kind === 'model' && step.state === 'succeeded').length,
            toolCalls: child.used.toolCalls,
            tokens: reportedTokens(child),
            wallMs: runWallMs(child),
          }
        : settled
          ? { turns: settled.used.modelCalls, toolCalls: settled.used.toolCalls, tokens: settled.tokens, wallMs: settled.wallMs }
          : null,
      text: resultText,
      reason,
      models: child ? reportedModels(child) : (settled?.models ?? []),
      verification:
        opened.role === 'advisor' ? null : outcome === 'completed' ? verificationFor(input.leadVerification) : null,
    };
  };

  const views = order.map((id) => project(id)).filter((view): view is HandoffView => view !== null);
  return {
    runId: input.lead.id,
    taskId: input.lead.taskId,
    state: input.lead.state,
    scope: input.config.scope,
    limits: input.config.limits,
    worker: input.config.worker,
    advisor: input.config.advisor,
    retryOf: input.retryOf,
    workers: views.filter((view) => view.role === 'worker'),
    advice: views.filter((view) => view.role === 'advisor'),
  };
}

function emptyView(
  handoffId: string,
  role: HandoffRole,
  stepId: string,
  task: string,
  scope: readonly string[],
): HandoffView {
  return {
    handoffId,
    role,
    stepId,
    task,
    scope,
    outcome: 'refused',
    sentence: SENTENCE.refused,
    attempt: 1,
    retryOf: null,
    reusedFrom: null,
    childRunId: null,
    agent: null,
    route: null,
    profile: null,
    budget: null,
    used: null,
    text: null,
    reason: null,
    models: [],
    verification: null,
  };
}

/** A worker's answer is a claim; only the lead's declared checks can verify what it fed into. */
function verificationFor(
  lead: { readonly state: VerificationState; readonly sentence: string } | null,
): { state: VerificationState; sentence: string } {
  if (!lead)
    return {
      state: 'not-verified',
      sentence: 'A worker’s answer is a claim. Only the lead’s declared checks decide whether the outcome it fed is verified.',
    };
  return { state: lead.state, sentence: `Through the lead’s outcome: ${lead.sentence}` };
}

/** The key a retried lead matches an earlier finished assignment by: role, task and scope, exactly. */
export function assignmentKey(role: HandoffRole, task: string, scope: readonly string[]): string {
  return JSON.stringify([role, task, [...scope].sort()]);
}
