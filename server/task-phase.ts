/**
 * Bounded task phase approval lane: the native loop's actual enforcement.
 *
 * A task may carry an explicit `Task.workflow` (shared/task-workflow.ts,
 * server/task-workflow.ts): a phase (plan/build/review) and the continuation
 * the person chose — Full approval (the agent proceeds phase to phase within
 * the granted scope and budget) or Stop on phase change (each transition
 * parks for the person's approval). The model layer only records that choice;
 * this module enforces it inside the real native loop, with no second
 * scheduler, no second run and no custom approval authority.
 *
 * The parent owns `server/harness/capabilities/native-loop.ts` and integrates
 * this lane by passing the callback from `createTaskPhaseGate` as
 * `NativeLoopOptions.enterPhase`. The loop calls it after the durable plan
 * record before the first act turn (`build`), and after the durable finish
 * claim before `runtime.complete` (`review`).
 *
 * Each transition is one durable `runs.step` transform/pure record:
 * intent name `continue_task_phase`, unique step id `task-phase:build` or
 * `task-phase:review`, strict input `{projectId, runId, taskId, phase}`.
 * Under Stop on phase change the step carries `approval: true`, so the first
 * call suspends the run and the host's existing Need path asks the person
 * (server/harness/approval.ts, present.ts, bridge.ts — unchanged callers).
 * Under Full approval the step carries `approval: false` and passes through.
 * Legacy tasks without a workflow skip the gate entirely, exactly as before.
 *
 * Ordering: under Stop mode the pending marker (`pendingPhase`,
 * `pendingReason`, revision, `task-handoff-asked` History) is persisted under
 * `store.locked` BEFORE the phase step is awaited, so the Console and the
 * Ready queue already show the wait when the run suspends. The actual advance
 * (phase move, pending clear, one `task-handoff` History entry) happens only
 * inside the step handler — after approval, or at once under Full approval —
 * so a replay appends history once and never duplicates revisions. A pending
 * marker that drifted (cleared or rewritten elsewhere) never skips the gate:
 * the recorded step's `waiting_approval` state is authoritative, and the same
 * task/run/session binding plus the run input identity are re-checked inside
 * the handler. Stop/restart resumes the same run; plan and model steps replay
 * from their records, never as new calls.
 */
import type {
  HarnessPrincipal,
  HarnessRun,
} from '../shared/harness.js';
import { supervisorOrigin } from '../shared/native-loop.js';
import {
  handoffRecord,
  nextPhase,
  workflowOf,
} from '../shared/task-workflow.js';
import type { TaskWorkflowPhase } from '../shared/types.js';
import type { RunService } from './harness/run-service.js';
import type { Store } from './store.js';
import { requestTaskHandoff } from './task-workflow.js';

export { TASK_PHASE_INTENT_NAME, TASK_PHASE_VERSION, TASK_PHASES, taskPhaseInputSchema,
  taskPhaseStepId, isTaskPhaseIntent, taskPhaseOutputSchema } from '../shared/task-phase.js';
export type { TaskPhaseGate, TaskPhaseInput } from '../shared/task-phase.js';
import { TASK_PHASE_INTENT_NAME, TASK_PHASE_VERSION, taskPhaseInputSchema, taskPhaseStepId,
  type TaskPhaseGate, type TaskPhaseInput } from '../shared/task-phase.js';

export interface TaskPhaseGateDeps {
  readonly store: Store;
  readonly runs: RunService;
  readonly run: HarnessRun;
  readonly owner: string;
  readonly principal: HarnessPrincipal;
}

/**
 * Build the `enterPhase` callback for one loop run. The parent passes it as
 * `NativeLoopOptions.enterPhase`; the loop calls it with `build` after the
 * durable plan and `review` after the durable finish claim.
 */
export function createTaskPhaseGate(deps: TaskPhaseGateDeps): (phase: TaskPhaseGate) => Promise<void> {
  const { store, runs, run, owner, principal } = deps;
  const runId = run.id;
  const projectId = run.projectId;
  const taskId = run.taskId;
  const sessionId = run.sessionId;

  return async (phase: TaskPhaseGate): Promise<void> => {
    const recordedRun = await runs.get(runId);
    const recorded = recordedRun.steps.find((step) => step.intent.stepId === taskPhaseStepId(phase));
    if (recorded?.state === 'succeeded') return;
    if (['cancelled', 'failed', 'completed'].includes(recordedRun.state))
      throw new Error('This run has ended and cannot move to another phase.');
    // Legacy tasks carry no workflow: the gate is absent, exactly as before.
    // Read fresh (never from a stale closure) so a replay sees the approval's write.
    const snapshot = store.state(projectId);
    const seen = taskId ? snapshot.tasks.find((item) => item.id === taskId && !item.deletedAt) : undefined;
    if (!seen || !seen.workflow) {
      if (recorded) throw new Error('This waiting run no longer has its task workflow.');
      return;
    }
    const order = ['plan', 'build', 'review'];
    // A new run may continue an already approved phase. An existing waiting
    // step must still be answered even if its display marker has changed.
    if (!recorded && order.indexOf(seen.workflow.phase) >= order.indexOf(phase)) return;
    const stopMode = recorded ? recorded.intent.approval : workflowOf(seen).continuation === 'stop-on-phase-change';

    // Stop mode parks visibly BEFORE the run suspends: pending marker,
    // revision and History land first, so the Console and Ready queue already
    // show the wait. Guarded against replay: an already-parked phase is left
    // alone, so neither revision nor History duplicates.
    if (stopMode) {
      await store.locked(async () => {
        const state = store.state(projectId);
        const task = state.tasks.find((item) => item.id === taskId && !item.deletedAt);
        if (!task || !task.workflow) return;
        if (task.workflow.phase === phase || task.workflow.pendingPhase === phase) return;
        requestTaskHandoff(store, state, task, phase, 'diomedes');
        await store.persist(state);
      });
    }

    const input: TaskPhaseInput = taskPhaseInputSchema.parse({
      projectId,
      runId,
      taskId: taskId ?? '',
      phase,
    });

    // The durable gate. Under stop mode `approval: true` suspends here until
    // the person's exact approval resumes the same run; under full approval
    // the handler runs at once. A replay returns the recorded output without
    // running the handler again — no second run, no repeated plan/model calls.
    await runs.step(
      runId,
      owner,
      {
        id: taskPhaseStepId(phase),
        version: TASK_PHASE_VERSION,
        kind: 'transform',
        effect: 'pure',
        name: TASK_PHASE_INTENT_NAME,
        input,
        cost: 0,
        permission: null,
        approval: stopMode,
        destination: 'local',
        origin: supervisorOrigin(),
      },
      async ({ signal }) => {
        // Read the run outside the Store lock: the binding check needs fresh
        // run state, and the mutation below takes the lock on its own.
        const fresh = await runs.get(runId);
        return store.locked(async () => {
          signal.throwIfAborted();
          const state = store.state(projectId);
          const task = state.tasks.find((item) => item.id === taskId && !item.deletedAt);
          if (!task || !task.workflow)
            throw new Error('This task no longer holds a workflow, so its phase cannot advance.');
          // Authoritative binding: the same task, run, session and project
          // that opened the gate. A stale or foreign approval is refused
          // here even if it reached the handler.
          if (
            fresh.projectId !== projectId ||
            fresh.id !== runId ||
            fresh.taskId !== taskId ||
            fresh.taskId !== task.id ||
            fresh.sessionId !== sessionId
          )
            throw new Error('This phase approval names a different task, run or session.');
          const workflow = workflowOf(task);
          const expected = nextPhase(workflow.phase);
          if (workflow.phase === phase)
            return { v: 1, phase, advanced: false } as const;
          if (expected !== phase)
            throw new Error(
              `This task is in ${workflow.phase}. The next phase is ${expected ?? 'none'}.`,
            );
          const from: TaskWorkflowPhase = workflow.phase;
          const full = workflow.continuation === 'full-approval';
          task.workflow.phase = phase;
          task.workflow.pendingPhase = null;
          task.workflow.pendingReason = null;
          task.workflow.handoffs.push(
            handoffRecord({
              at: new Date().toISOString(),
              by: full ? 'diomedes' : 'you',
              from,
              to: phase,
              reason: full
                ? 'Continued under Full approval, within the existing scope and limits.'
                : 'Approved by you.',
            }),
          );
          task.workflow.revision += 1;
          const need = state.needs.find((item) => item.harness?.runId === runId &&
            item.harness.intent.stepId === taskPhaseStepId(phase) && item.state === 'go-ahead');
          const entry = store.addEntry(state, {
            kind: 'task-handoff',
            sentence:
              full
                ? `Diomedes continued ${task.name} to ${phase}.`
                : `You approved continuing ${task.name} to ${phase}.`,
            actor: full ? 'diomedes' : 'you',
            taskId: task.id,
            sessionId,
            ...(need ? { approvalId: need.id } : {}),
          });
          if (need) need.execution = {
            state: 'applied', eventId: entry.id, completedAt: entry.time,
            reason: null, conflicts: [],
          };
          await store.persist(state);
          return { v: 1, phase, advanced: true } as const;
        });
      },
      principal,
    );
  };
}
