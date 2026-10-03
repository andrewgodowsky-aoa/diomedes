/**
 * Bounded backend task workflow: the admitting half (Board gaps, decisions 4 and 12).
 *
 * Mounted by the parent (`mountTaskWorkflowRoutes(app, store)` from
 * `server/app.ts`, which owns that wiring): strict validated human endpoints
 * for a task's workflow, plus two trusted service helpers the parent calls
 * from the runtime — never from HTTP.
 *
 * - `GET /api/projects/:id/tasks/:taskId/skills` lists the selectable builtin
 *   skills from the project's active packs only. Read-only; grants nothing.
 * - `PUT /api/projects/:id/tasks/:taskId/workflow` sets the continuation, the
 *   turn budget and the optional skill guidance against `expectedRevision`.
 * - `POST .../accept` accepts an Inbox task.
 * - `POST .../handoff` names `expectedRevision`, the next phase and a reason.
 *   The actor is always the person (`you`); it is never read from the request.
 *   Under Full approval the phase advances at once; under Stop on phase change
 *   it parks as `pendingPhase` for `POST .../approve-phase` to confirm.
 * - `POST .../children` branches separate-output child tasks into the Inbox,
 *   with the parent's continuation and within its turn budget. No permission
 *   grant is copied: a child carries no approval, receipt or grant of its own.
 *
 * Every mutation runs under `Store.locked` and is persisted; everything is
 * validated before anything is mutated; a task with an active run refuses
 * human workflow changes (only the trusted phase request may move it); and
 * nothing here dispatches a start. The parent enforces `taskWorkflowBlocker`
 * in Work and loop admission and wires the trusted agent proposal calls.
 */
import type { Express, NextFunction, Request, Response } from 'express';
import { commandIdSchema, findCommand, payloadDigest } from './command-admission.js';
import { ApiError } from './paths.js';
import { now, type Store } from './store.js';
import {
  TASK_WORKFLOW_DEFAULT_MAX_TURNS,
  WorkflowConflictError,
  WorkflowValidationError,
  checkMaxTurns,
  checkReason,
  checkRevision,
  childBlocker,
  emptyTaskWorkflow,
  handoffRecord,
  hasActiveRun,
  isContinuation,
  isWorkflowPhase,
  nextPhase,
  workflowOf,
} from '../shared/task-workflow.js';
import {
  CAPABILITY_PACK_IDS,
  CAPABILITY_PACKS,
  findSkill,
  isCapabilityPackId,
  isPackActive,
} from '../shared/capability-packs.js';
import type {
  Owner,
  Task,
  TaskOrigin,
  TaskWorkflowPhase,
  TaskWorkflowSkill,
} from '../shared/types.js';

type MutableState = ReturnType<Store['state']>;

/** What `requestTaskHandoff` did: advanced now, or parked for approval. */
export interface TaskHandoffResult {
  readonly advanced: boolean;
  readonly from: TaskWorkflowPhase;
  readonly to: TaskWorkflowPhase;
  readonly pending: boolean;
}

/** Trusted input for a runtime-proposed task. Nothing here is authority. */
export interface ProposeTaskInput {
  name: string;
  description?: string;
  owner?: Owner;
  /** The task this proposal branches from; must exist in this project. */
  parentTaskId?: string;
  /** A child is useful only when it has a separate result. */
  output?: string;
  /** The session proposing; must exist in this project when named. */
  sessionId?: string;
  /** Where the proposal came from; its project must be this project when named. */
  origin?: TaskOrigin;
  /** True only when the person explicitly accepted this task up front. */
  acceptedByPerson?: boolean;
  maxTurns?: number;
}

const OWNERS: readonly Owner[] = ['you', 'diomedes', 'diomedes-with-ok'];

export const workflowApiError = (error: unknown): unknown =>
  error instanceof WorkflowValidationError
    ? new ApiError(400, error.message)
    : error instanceof WorkflowConflictError
      ? new ApiError(409, error.message)
      : error;

const findTask = (state: MutableState, taskId: string): Task => {
  const task = state.tasks.find((item) => item.id === taskId);
  if (!task) throw new ApiError(404, 'This task was not found.');
  return task;
};

const liveTask = (state: MutableState, taskId: string, role: string): Task => {
  const task = findTask(state, taskId);
  if (task.deletedAt)
    throw new ApiError(409, `This ${role} task was deleted. It cannot take a workflow change.`);
  return task;
};

/** Human workflow changes wait for the run to finish; the trusted phase request does not. */
const refuseActiveRun = (state: MutableState, task: Task): void => {
  if (hasActiveRun(state.sessions, task.id))
    throw new ApiError(409, 'Stop this work before changing the task workflow.');
};

const checkedName = (value: unknown): string => {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 200)
    throw new WorkflowValidationError('Give this task a name of up to 200 characters.');
  return value.trim();
};

const checkedDescription = (value: unknown): string => {
  if (value === undefined) return '';
  if (typeof value !== 'string' || value.length > 10_000)
    throw new WorkflowValidationError('Provide a description of up to 10,000 characters.');
  return value;
};

/** Optional playbook guidance: null clears, an object names one exact builtin skill from an active pack. */
const checkedSkill = (state: MutableState, value: unknown): TaskWorkflowSkill | null => {
  if (value === null) return null;
  if (typeof value !== 'object' || Array.isArray(value))
    throw new WorkflowValidationError('Choose a playbook from the list, or None.');
  const record = value as Record<string, unknown>;
  const packId = record.packId;
  const skillId = record.skillId;
  if (!isCapabilityPackId(packId) || typeof skillId !== 'string' || !skillId)
    throw new WorkflowValidationError('Choose a playbook from the list, or None.');
  if (!isPackActive(state.project.packs, packId))
    throw new WorkflowValidationError('That playbook comes from a pack that is not active for this project.');
  if (!findSkill(packId, skillId))
    throw new WorkflowValidationError('Choose a playbook from the list, or None.');
  return { packId, skillId };
};

/** A child's own separate result, named up front. Empty reads as none yet. */
const checkedOutput = (value: unknown): string | null => {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || value.length > 1000)
    throw new WorkflowValidationError('Give a separate result of up to 1,000 characters.');
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
};

/**
 * Trusted service helper for agent phase calls. Applies Full approval at once
 * (the person chose it) or parks the next phase under Stop on phase change.
 * Never grants file or billing permissions: it moves a phase marker and writes
 * a History sentence, nothing more. The caller holds `store.locked()` and
 * persists; this only mutates and records.
 */
export function requestTaskHandoff(
  store: Store,
  state: MutableState,
  task: Task,
  next: TaskWorkflowPhase,
  by: Owner,
): TaskHandoffResult {
  if (!isWorkflowPhase(next)) throw new WorkflowValidationError('Choose a valid next phase.');
  const workflow = workflowOf(task);
  const expected = nextPhase(workflow.phase);
  if (expected === null || expected !== next)
    throw new WorkflowConflictError(
      `This task is in ${workflow.phase}. The next phase is ${expected ?? 'none'}.`,
    );
  const from = workflow.phase;
  if (workflow.pendingPhase === next) return { advanced: false, from, to: next, pending: true };
  task.workflow = workflow;
  if (workflow.continuation === 'full-approval') {
    workflow.phase = next;
    workflow.pendingPhase = null;
    workflow.pendingReason = null;
    workflow.handoffs.push(
      handoffRecord({
        at: now(),
        by,
        from,
        to: next,
        reason: 'Continued under Full approval, within the existing scope and limits.',
      }),
    );
    workflow.revision += 1;
    store.addEntry(state, {
      kind: 'task-handoff',
      sentence: `${by === 'you' ? 'You' : 'Diomedes'} continued ${task.name} to ${next}.`,
      actor: by,
      taskId: task.id,
    });
    return { advanced: true, from, to: next, pending: false };
  }
  workflow.pendingPhase = next;
  workflow.pendingReason = 'Asked for during the run. It waits for your approval.';
  workflow.revision += 1;
  store.addEntry(state, {
    kind: 'task-handoff-asked',
    sentence: `Diomedes asked to continue ${task.name} to ${next}. It waits for your approval.`,
    actor: by,
    taskId: task.id,
  });
  return { advanced: false, from, to: next, pending: true };
}

/**
 * Trusted helper for runtime-generated tasks. The task is `createdBy`
 * diomedes and waits in the Inbox unless the person explicitly accepted it up
 * front. The scoped parent and session references are checked against this
 * project's records; nothing is granted. The caller holds `store.locked()`
 * and persists; this only mutates and records.
 */
export function proposeTask(store: Store, state: MutableState, input: ProposeTaskInput): Task {
  const name = checkedName(input.name);
  const description = checkedDescription(input.description);
  const owner = input.owner ?? 'diomedes';
  if (!OWNERS.includes(owner)) throw new WorkflowValidationError('Choose a valid owner.');
  let parent: Task | null = null;
  if (input.parentTaskId !== undefined) {
    parent =
      state.tasks.find((item) => item.id === input.parentTaskId) ?? null;
    if (!parent || parent.deletedAt)
      throw new WorkflowValidationError('This proposal names a task this project does not hold.');
    const blocker = childBlocker(state.tasks, parent);
    if (blocker) throw new WorkflowConflictError(blocker);
  }
  if (input.sessionId !== undefined && !state.sessions.some((item) =>
    item.id === input.sessionId && (!parent || item.taskId === parent.id)))
    throw new WorkflowValidationError('This proposal names a run this project does not hold.');
  if (input.origin && input.origin.projectId !== state.project.id)
    throw new WorkflowValidationError('This proposal names a project it did not come from.');
  const output = checkedOutput(input.output);
  if (parent && !output) throw new WorkflowValidationError('Name the separate result for this child task.');
  if (parent && input.maxTurns !== undefined && checkMaxTurns(input.maxTurns) > workflowOf(parent).maxTurns)
    throw new WorkflowValidationError('A child cannot exceed its parent turn limit.');
  const maxTurns =
    input.maxTurns === undefined
      ? Math.min(
          TASK_WORKFLOW_DEFAULT_MAX_TURNS,
          parent ? workflowOf(parent).maxTurns : TASK_WORKFLOW_DEFAULT_MAX_TURNS,
        )
      : Math.min(
          checkMaxTurns(input.maxTurns),
          parent ? workflowOf(parent).maxTurns : checkMaxTurns(input.maxTurns),
        );
  const task = store.createTask(state, { name, description, owner });
  task.createdBy = 'diomedes';
  const parentWorkflow = parent ? workflowOf(parent) : emptyTaskWorkflow();
  task.workflow = {
    revision: 1,
    phase: 'plan',
    continuation: parentWorkflow.continuation,
    inbox: !input.acceptedByPerson,
    parentTaskId: parent ? parent.id : null,
    output,
    maxTurns,
    // Guidance may differ by child: a proposed task starts with none.
    skill: null,
    pendingPhase: null,
    pendingReason: null,
    handoffs: [],
  };
  if (input.origin) task.origin = { ...input.origin };
  store.addEntry(state, {
    kind: 'tasks-made',
    sentence: `Diomedes proposed a task: ${task.name}.`,
    actor: 'diomedes',
    taskId: task.id,
    sessionId: input.sessionId ?? null,
  });
  return task;
}

/**
 * A bounded assignment already admitted under an active root, not a new task
 * suggestion or a human acceptance. The owned Team service must hold Store
 * and the root RunService fence and revalidate its recorded grant before this
 * projection. Existing parent/output/depth/turn gates still apply; no writer,
 * billing permission, phase advance or approval is copied to this child.
 */
export function proposeOwnedTaskAssignment(
  store: Store,
  state: MutableState,
  input: Omit<ProposeTaskInput, 'acceptedByPerson'> & {
    parentTaskId: string; rootRunId: string; admissionRef: string;
  },
): Task {
  if (!input.rootRunId || input.rootRunId.length > 160 || !input.admissionRef || input.admissionRef.length > 160)
    throw new WorkflowValidationError('The owned assignment needs its recorded root admission.');
  const parent = liveTask(state, input.parentTaskId, 'parent');
  if (parent.state === 'done' || parent.workflow?.inbox || parent.workflow?.pendingPhase)
    throw new WorkflowConflictError('The root task is not admitted to continue this assignment.');
  const task = proposeTask(store, state, {
    name: input.name, description: input.description, owner: input.owner,
    parentTaskId: input.parentTaskId, output: input.output,
    sessionId: input.sessionId, origin: input.origin, maxTurns: input.maxTurns,
  });
  task.ownedAssignment = {rootTaskId:input.parentTaskId,rootRunId:input.rootRunId,admissionRef:input.admissionRef};
  task.workflow!.inbox = false;
  task.workflow!.phase = workflowOf(parent).phase;
  store.addEntry(state, {
    kind: 'task-owned-assignment-admitted', actor: 'diomedes', taskId: task.id,
    sessionId: input.sessionId ?? null,
    sentence: `Diomedes admitted ${task.name} as a bounded assignment under ${parent.name}.`,
  });
  return task;
}

export function mountTaskWorkflowRoutes(app: Express, store: Store): void {
  const handle =
    (action: (req: Request) => Promise<unknown>) =>
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        res.json(await action(req));
      } catch (error) {
        next(workflowApiError(error));
      }
    };
  const project = (req: Request): MutableState => store.state(String(req.params.id));
  const body = (req: Request): Record<string, unknown> =>
    req.body && typeof req.body === 'object' && !Array.isArray(req.body)
      ? (req.body as Record<string, unknown>)
      : {};
  const mutate = async (req: Request, apply: (state: MutableState, task: Task) => Task) =>
    store.locked(async () => {
      const state = project(req);
      const task = liveTask(state, String(req.params.taskId), 'target');
      const updated = apply(state, task);
      await store.persist(state);
      return updated;
    });

  app.get(
    '/api/projects/:id/tasks/:taskId/skills',
    handle(async (req) => {
      const state = project(req);
      liveTask(state, String(req.params.taskId), 'target');
      const skills = CAPABILITY_PACK_IDS.filter((packId) => isPackActive(state.project.packs, packId)).flatMap(
        (packId) =>
          CAPABILITY_PACKS[packId].skills.map((skill) => ({
            packId,
            skillId: skill.id,
            name: skill.name,
            packName: CAPABILITY_PACKS[packId].name,
            value: skill.value,
          })),
      );
      return { skills };
    }),
  );

  app.put(
    '/api/projects/:id/tasks/:taskId/workflow',
    handle((req) =>
      mutate(req, (state, task) => {
        const b = body(req);
        const workflow = workflowOf(task);
        checkRevision(workflow, b.expectedRevision);
        refuseActiveRun(state, task);
        const continuation = b.continuation === undefined ? workflow.continuation : b.continuation;
        if (!isContinuation(continuation))
          throw new WorkflowValidationError('Choose Full approval or Stop on phase change.');
        const maxTurns = b.maxTurns === undefined ? workflow.maxTurns : checkMaxTurns(b.maxTurns);
        const parent = workflow.parentTaskId ? liveTask(state, workflow.parentTaskId, 'parent') : null;
        if (parent && maxTurns > workflowOf(parent).maxTurns)
          throw new WorkflowValidationError('A child cannot exceed its parent turn limit.');
        if (parent && workflowOf(parent).continuation === 'stop-on-phase-change' && continuation === 'full-approval')
          throw new WorkflowValidationError('This parent requires approval at phase changes. Keep that limit for its child.');
        // Deleted children can be restored, so they retain the parent's limits.
        const children = state.tasks.filter((item) => item.workflow?.parentTaskId === task.id);
        if (children.some((child) => workflowOf(child).maxTurns > maxTurns ||
            (continuation === 'stop-on-phase-change' && workflowOf(child).continuation === 'full-approval')))
          throw new WorkflowConflictError('Update the child task limits before tightening their parent limits.');
        const skill = b.skill === undefined ? (workflow.skill ?? null) : checkedSkill(state, b.skill);
        task.workflow ??= emptyTaskWorkflow();
        task.workflow.continuation = continuation;
        task.workflow.maxTurns = maxTurns;
        task.workflow.skill = skill;
        task.workflow.revision = workflow.revision + 1;
        store.addEntry(state, {
          kind: 'task-workflow',
          sentence: `You set the workflow for ${task.name}: ${continuation}, up to ${maxTurns} turns.`,
          taskId: task.id,
        });
        return task;
      }),
    ),
  );

  app.post(
    '/api/projects/:id/tasks/:taskId/accept',
    handle((req) =>
      mutate(req, (state, task) => {
        const workflow = workflowOf(task);
        checkRevision(workflow, body(req).expectedRevision);
        if (!task.workflow || !task.workflow.inbox)
          throw new WorkflowConflictError('This task is not waiting in the Inbox.');
        task.workflow.inbox = false;
        task.workflow.revision = workflow.revision + 1;
        store.addEntry(state, {
          kind: 'task-workflow',
          sentence: `You accepted ${task.name} from the Inbox.`,
          taskId: task.id,
        });
        return task;
      }),
    ),
  );

  app.post(
    '/api/projects/:id/tasks/:taskId/handoff',
    handle((req) =>
      mutate(req, (state, task) => {
        // The actor is always the person. It is never read from the request:
        // trusting a caller-supplied actor would let anyone sign as Diomedes.
        const by: Owner = 'you';
        const b = body(req);
        const workflow = workflowOf(task);
        checkRevision(workflow, b.expectedRevision);
        refuseActiveRun(state, task);
        if (!isWorkflowPhase(b.phase ?? b.next))
          throw new WorkflowValidationError('Choose a valid next phase.');
        const next = (b.phase ?? b.next) as TaskWorkflowPhase;
        const reason = checkReason(b.reason);
        const expected = nextPhase(workflow.phase);
        if (expected === null || expected !== next)
          throw new WorkflowConflictError(
            `This task is in ${workflow.phase}. The next phase is ${expected ?? 'none'}.`,
          );
        task.workflow = workflow;
        const from = task.workflow.phase;
        if (task.workflow.continuation === 'full-approval') {
          task.workflow.phase = next;
          task.workflow.pendingPhase = null;
          task.workflow.pendingReason = null;
          task.workflow.handoffs.push(handoffRecord({ at: now(), by, from, to: next, reason }));
          task.workflow.revision = workflow.revision + 1;
          store.addEntry(state, {
            kind: 'task-handoff',
            sentence: `You continued ${task.name} to ${next}.`,
            taskId: task.id,
          });
        } else {
          task.workflow.pendingPhase = next;
          task.workflow.pendingReason = reason;
          task.workflow.revision = workflow.revision + 1;
          store.addEntry(state, {
            kind: 'task-handoff-asked',
            sentence: `You asked to continue ${task.name} to ${next}. It waits for approval.`,
            taskId: task.id,
          });
        }
        return task;
      }),
    ),
  );

  app.post(
    '/api/projects/:id/tasks/:taskId/approve-phase',
    handle((req) =>
      mutate(req, (state, task) => {
        const workflow = workflowOf(task);
        checkRevision(workflow, body(req).expectedRevision);
        refuseActiveRun(state, task);
        if (!task.workflow || !task.workflow.pendingPhase)
          throw new WorkflowConflictError('There is no pending phase to approve.');
        const from = task.workflow.phase;
        const to = task.workflow.pendingPhase;
        const reason = task.workflow.pendingReason ?? 'Approved by you.';
        task.workflow.phase = to;
        task.workflow.pendingPhase = null;
        task.workflow.pendingReason = null;
        task.workflow.handoffs.push(handoffRecord({ at: now(), by: 'you', from, to, reason }));
        task.workflow.revision = workflow.revision + 1;
        store.addEntry(state, {
          kind: 'task-handoff',
          sentence: `You approved continuing ${task.name} to ${to}.`,
          taskId: task.id,
        });
        return task;
      }),
    ),
  );

  app.post(
    '/api/projects/:id/tasks/:taskId/children',
    handle((req) =>
      store.locked(async () => {
        const state = project(req);
        const parent = liveTask(state, String(req.params.taskId), 'source');
        const b = body(req);
        const parsed = commandIdSchema.safeParse(b.commandId);
        if (!parsed.success)
          throw new WorkflowValidationError('Give this branching a unique command id.');
        const commandId = parsed.data;
        const name = checkedName(b.name);
        const description = checkedDescription(b.description);
        const output = checkedOutput(b.output);
        if (!output) throw new WorkflowValidationError('Name the separate result for this child task.');
        const parentWorkflow = workflowOf(parent);
        const requestedMax = b.maxTurns === undefined ? undefined : checkMaxTurns(b.maxTurns);
        if (requestedMax !== undefined && requestedMax > parentWorkflow.maxTurns)
          throw new WorkflowValidationError(
            `A branched task keeps within its parent's turn budget of ${parentWorkflow.maxTurns}.`,
          );
        const digest = payloadDigest({
          type: 'task.child',
          protocolVersion: 1,
          parent: parent.id,
          name,
          description,
          output,
          maxTurns: requestedMax ?? null,
        });
        const replay = findCommand(state, commandId);
        if (replay) {
          if (replay.type !== 'task.create' || replay.digest !== digest)
            throw new ApiError(409, 'This command already names a different request.', {
              code: 'task_command_conflict',
            });
          return replay.subject;
        }
        const blocker = childBlocker(state.tasks, parent);
        if (blocker) throw new WorkflowConflictError(blocker);
        const child = store.createTask(state, { name, description, owner: 'you' });
        child.workflow = {
          revision: 1,
          phase: 'plan',
          // Inherited, never widened: the parent's continuation carries over and
          // the turn budget cannot exceed it. The output stays separate: a
          // child names its own result and never sees its parent's. Guidance is
          // never inherited: a child starts with no skill until the person picks one.
          continuation: parentWorkflow.continuation,
          inbox: true,
          parentTaskId: parent.id,
          output,
          maxTurns: requestedMax ?? Math.min(TASK_WORKFLOW_DEFAULT_MAX_TURNS, parentWorkflow.maxTurns),
          skill: null,
          pendingPhase: null,
          pendingReason: null,
          handoffs: [],
        };
        const entry = store.addEntry(state, {
          kind: 'tasks-made',
          sentence: `You branched a task from ${parent.name}: ${child.name}.`,
          taskId: child.id,
        });
        child.creationReceipt = {
          protocolVersion: 1,
          commandId,
          payloadDigest: digest,
          projectId: state.project.id,
          taskId: child.id,
          eventId: entry.id,
          admittedAt: entry.time,
          actor: 'local-client',
          scope: 'local-prototype',
        };
        await store.persist(state);
        return child;
      }),
    ),
  );
}

/** Parent integration contract: what this lane owns and what the parent wires. */
export const TASK_WORKFLOW_PARENT_CONTRACT = Object.freeze({
  routes: [
    'GET /api/projects/:id/tasks/:taskId/skills',
    'PUT /api/projects/:id/tasks/:taskId/workflow',
    'POST /api/projects/:id/tasks/:taskId/accept',
    'POST /api/projects/:id/tasks/:taskId/handoff',
    'POST /api/projects/:id/tasks/:taskId/approve-phase',
    'POST /api/projects/:id/tasks/:taskId/children',
  ],
  trusted: ['requestTaskHandoff', 'proposeTask'],
  /** Enforce in Work start and loop admission; queue exclusion is already in `readyAt`. */
  blockers: ['taskWorkflowBlocker'],
});
