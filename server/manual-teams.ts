/**
 * S1 free manual teams on the Board (DIO-175 lane S1, DIO-176, 2026-10-03): the server half.
 *
 * - The person's assignment of a card to a Team member through the Board's task route.
 * - Manual hand-offs between cards (shared/manual-handoff.ts): create and list, persisted on
 *   the project record with the Store's durable write, and the Work start check that every
 *   file a hand-off names is among the documents the person consented to send (N05).
 *
 * Nothing here starts work, calls a model, consults the Agent gate or touches a managed
 * route: free accounts use manual teams (A01). Starting a manual card stays in `admitWork`
 * (server/app.ts), which sends it to Native Work on the assigned member's engine.
 */
import type { Express, NextFunction, Request, Response } from 'express';
import {
  MANUAL_HANDOFF_LIMITS,
  manualHandoffProblem,
  manualHandoffRequestSchema,
  uncoveredHandoffFiles,
  type ManualHandoff,
} from '../shared/manual-handoff.js';
import type { Task, TeamMember } from '../shared/types.js';
import { ApiError, relativeName } from './paths.js';
import { identifier, now, type Store } from './store.js';

type State = ReturnType<Store['state']>;

const ACTIVE = ['queued', 'working', 'waiting'];

export const ASSIGNMENT_REFUSED = {
  invalid: 'Choose a current Team member, or clear the assignment.',
  owned: 'An Agent Team run owns this assignment. It changes only through that run.',
  running: "Stop this work before you change who it's assigned to.",
} as const;

const stoppedMember = (member: TeamMember) =>
  `${member.name} was stopped and can't take work. Choose a current member.`;

/**
 * Applies the person's `assignedTo` from the Board's task route. A string must name a current
 * Team member's slot: an unknown slot is a 400 and a stopped member (the Team's only removal;
 * a stopped member never resumes) a 409. `null` clears. The same assignment again changes
 * nothing and writes no History. A card an Agent Team root owns, or one whose work is running,
 * is refused with a 409. The caller holds `store.locked()`, so a refusal leaves the task as
 * it was on disk; the caller persists.
 */
export function applyTaskAssignment(store: Store, state: State, task: Task, value: unknown): void {
  if (value !== null && typeof value !== 'string')
    throw new ApiError(400, ASSIGNMENT_REFUSED.invalid, { code: 'task_assignment_invalid' });
  let member: TeamMember | undefined;
  if (value !== null) {
    member = (state.team?.members ?? []).find((item) => item.slotId === value);
    if (!member) throw new ApiError(400, ASSIGNMENT_REFUSED.invalid, { code: 'task_assignment_invalid' });
    if (member.status === 'stopped')
      throw new ApiError(409, stoppedMember(member), { code: 'task_assignment_removed' });
  }
  if ((task.assignedTo ?? null) === value) return;
  if (task.ownedAssignment) throw new ApiError(409, ASSIGNMENT_REFUSED.owned, { code: 'task_assignment_owned' });
  if (state.sessions.some((session) => session.taskId === task.id && ACTIVE.includes(session.state)))
    throw new ApiError(409, ASSIGNMENT_REFUSED.running, { code: 'task_assignment_running' });
  task.assignedTo = value;
  store.addEntry(state, {
    kind: 'task-assigned',
    sentence: member ? `You assigned ${task.name} to ${member.name}` : `You cleared the assignment of ${task.name}`,
    taskId: task.id,
  });
}

/**
 * N05: a start that sends documents must include every file a hand-off into this card names.
 * Applies to every non-sample start of a card that has a hand-off into it.
 */
export function requireHandoffCoverage(state: State, taskId: string, sources: readonly string[]): void {
  const missing = uncoveredHandoffFiles(state.manualHandoffs, taskId, sources);
  if (!missing.length) return;
  throw new ApiError(
    409,
    `The hand-off into this card names ${listOf(missing)}. Add ${missing.length === 1 ? 'it' : 'them'} to the documents you send, then start again.`,
    { code: 'handoff_files_uncovered', files: missing },
  );
}

function listOf(names: readonly string[]): string {
  if (names.length < 2) return names.join('');
  return `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
}

const liveCard = (state: State, taskId: string): Task => {
  const task = state.tasks.find((item) => item.id === taskId && !item.deletedAt);
  if (!task) throw new ApiError(404, 'This card was not found.', { code: 'handoff_task_missing' });
  return task;
};

/** POST and GET /api/projects/:id/handoffs. */
export function mountManualHandoffRoutes(app: Express, store: Store): void {
  const handle =
    (action: (req: Request) => Promise<unknown>) =>
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        res.json(await action(req));
      } catch (error) {
        next(error);
      }
    };

  app.post(
    '/api/projects/:id/handoffs',
    handle((req) =>
      store.locked(async () => {
        const projectId = String(req.params.id);
        const state = store.state(projectId);
        const parsed = manualHandoffRequestSchema.safeParse(req.body ?? {});
        if (!parsed.success)
          throw new ApiError(400, manualHandoffProblem(parsed.error), { code: 'handoff_invalid' });
        const request = parsed.data;
        const from = liveCard(state, request.fromTaskId);
        const to = liveCard(state, request.toTaskId);
        if (to.ownedAssignment)
          throw new ApiError(409, ASSIGNMENT_REFUSED.owned, { code: 'handoff_task_owned' });
        const members = state.team?.members ?? [];
        const giver = members.find((item) => item.slotId === request.fromSlot);
        const taker = members.find((item) => item.slotId === request.toSlot);
        if (!giver || !taker)
          throw new ApiError(400, 'Choose the member handing off and the member taking over.', {
            code: 'handoff_member_unknown',
          });
        if (taker.status === 'stopped')
          throw new ApiError(409, stoppedMember(taker), { code: 'handoff_member_removed' });
        // The record says who had the work and who takes it over, so it has to agree with the
        // cards: each slot is the one its card is assigned to.
        if (from.assignedTo !== giver.slotId)
          throw new ApiError(409, `${from.name} isn't assigned to ${giver.name}.`, { code: 'handoff_member_mismatch' });
        if (to.assignedTo !== taker.slotId)
          throw new ApiError(409, `Assign ${to.name} to ${taker.name} before you hand it off.`, {
            code: 'handoff_member_mismatch',
          });
        const records = (state.manualHandoffs ??= []);
        if (records.length >= MANUAL_HANDOFF_LIMITS.perProject)
          throw new ApiError(
            409,
            `This project already keeps ${MANUAL_HANDOFF_LIMITS.perProject} hand-offs, the most it can.`,
            { code: 'handoff_limit' },
          );
        // Each changed file is one of this project's documents that a Work start can send, by
        // the name the project's listing gives it.
        const listed = request.changedFiles.length ? await store.listDocuments(projectId) : [];
        const changedFiles = request.changedFiles.map((name) => {
          const relative = relativeName(name);
          const found = listed.find((document) => document.path.toLowerCase() === relative.toLowerCase());
          if (!found || found.kind === 'unsupported')
            throw new ApiError(400, `${relative} isn't one of this project's text documents.`, {
              code: 'handoff_file_unknown',
            });
          return found.path;
        });
        const record: ManualHandoff = {
          id: identifier('H'),
          fromTaskId: from.id,
          toTaskId: to.id,
          fromSlot: giver.slotId,
          toSlot: taker.slotId,
          outcome: request.outcome,
          changedFiles,
          checks: request.checks,
          openIssues: request.openIssues,
          createdBy: 'you',
          createdAt: now(),
        };
        records.push(record);
        store.addEntry(state, {
          kind: 'manual-handoff',
          sentence: `You handed off ${from.name} to ${taker.name} on ${to.name}`,
          taskId: to.id,
        });
        await store.persist(state);
        return structuredClone(record);
      }),
    ),
  );

  app.get(
    '/api/projects/:id/handoffs',
    handle(async (req) => {
      const state = store.state(String(req.params.id));
      const taskId = req.query.taskId;
      if (taskId !== undefined && (typeof taskId !== 'string' || !taskId || taskId.length > MANUAL_HANDOFF_LIMITS.id))
        throw new ApiError(400, 'Name one card.', { code: 'handoff_query_invalid' });
      const records = (state.manualHandoffs ?? []).filter(
        (item) => taskId === undefined || item.toTaskId === taskId || item.fromTaskId === taskId,
      );
      return { handoffs: structuredClone(records).reverse() };
    }),
  );
}
