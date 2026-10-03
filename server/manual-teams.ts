/**
 * S1 free manual teams on the Board (DIO-175 lane S1, DIO-176, 2026-10-03): the server half.
 *
 * - The person's assignment of a card to a Team member through the Board's task route.
 * - Manual hand-offs between cards (shared/manual-handoff.ts): create, list and retire,
 *   persisted on the project record with the Store's durable write, and the Work start check
 *   that every file a live hand-off names is among the documents the person consented to send
 *   (N05). The files a card's live hand-offs name must fit one Work start, and a named file
 *   that is no longer in the project doesn't hold a start back: the start goes ahead without
 *   it and History says so.
 *
 * Nothing here starts work, calls a model, consults the Agent gate or touches a managed
 * route: free accounts use manual teams (A01). Starting a manual card stays in `admitWork`
 * (server/app.ts), which sends it to Native Work on the assigned member's engine.
 */
import type { Express, NextFunction, Request, Response } from 'express';
import {
  MANUAL_HANDOFF_LIMITS,
  handoffsInto,
  manualHandoffProblem,
  manualHandoffRequestSchema,
  uncoveredHandoffFiles,
  type ManualHandoff,
} from '../shared/manual-handoff.js';
import { TASK_SOURCE_KINDS } from '../shared/task-sources.js';
import { stoppedMemberRefusal } from '../shared/task-workflow.js';
import type { DocumentInfo, Task, TeamMember } from '../shared/types.js';
import { MAX_BYTES as WORK_SOURCE_BYTES, MAX_FILES as WORK_SOURCE_FILES } from './native-work.js';
import { ApiError, relativeName } from './paths.js';
import { identifier, now, type Store } from './store.js';

type State = ReturnType<Store['state']>;

const ACTIVE = ['queued', 'working', 'waiting'];

export const ASSIGNMENT_REFUSED = {
  invalid: 'Choose a current Team member, or clear the assignment.',
  owned: 'An Agent Team run owns this assignment. It changes only through that run.',
  running: "Stop this work before you change who it's assigned to.",
} as const;

const stoppedMember = (member: TeamMember) => stoppedMemberRefusal(member.name);

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
 * N05: a start that sends documents must include every file a live hand-off into this card
 * names. Applies to every non-sample start of a card that has a live hand-off into it.
 *
 * A named file that is no longer one of the project's documents can't be sent, so it doesn't
 * hold the start back: the answer is the names left out that way, for `recordHandoffFilesGone`
 * once the start has happened. The listing is read only when a name is missing, since it walks
 * the project folder.
 */
export async function requireHandoffCoverage(
  store: Store,
  projectId: string,
  taskId: string,
  sources: readonly string[],
): Promise<string[]> {
  const missing = uncoveredHandoffFiles(store.state(projectId).manualHandoffs, taskId, sources);
  if (!missing.length) return [];
  const listed = new Set(
    (await store.listDocuments(projectId))
      .filter((document) => document.kind !== 'unsupported')
      .map((document) => document.path.toLowerCase()),
  );
  const uncovered = missing.filter((name) => listed.has(name.toLowerCase()));
  if (uncovered.length)
    throw new ApiError(
      409,
      `The hand-off into this card names ${listOf(uncovered)}. Add ${uncovered.length === 1 ? 'it' : 'them'} to the documents you send, then start again.`,
      { code: 'handoff_files_uncovered', files: uncovered },
    );
  return missing;
}

/**
 * The History line for hand-off files a start went ahead without because they are no longer in
 * the project. Written only after the start happened, by the caller that persists it.
 */
export function recordHandoffFilesGone(store: Store, state: State, taskId: string, gone: readonly string[]): void {
  if (!gone.length) return;
  const one = gone.length === 1;
  store.addEntry(state, {
    kind: 'manual-handoff-files-gone',
    sentence: `${listOf(gone)} from the hand-off ${one ? 'is' : 'are'} no longer in this project, so ${one ? "it wasn't" : "they weren't"} sent.`,
    actor: 'diomedes',
    taskId,
  });
}

/**
 * The files a card's live hand-offs name must fit one Work start, since its start has to send
 * them all (N05): Native Work sends at most `WORK_SOURCE_FILES` documents and `WORK_SOURCE_BYTES`
 * of source text. Sizes come from the project's listing, which is the byte count a start reads.
 * A named file no longer listed doesn't count, because a start goes ahead without it. Checked
 * only when this hand-off adds a file; one that adds none can't make the card harder to start.
 */
function requireHandoffFilesFit(
  listed: readonly DocumentInfo[],
  records: readonly ManualHandoff[],
  to: Task,
  adding: readonly string[],
): void {
  const byName = new Map(listed.map((document) => [document.path.toLowerCase(), document.size]));
  const named = new Map<string, number>();
  for (const record of handoffsInto(records, to.id))
    for (const name of record.changedFiles) {
      const size = byName.get(name.toLowerCase());
      if (size !== undefined) named.set(name.toLowerCase(), size);
    }
  const before = named.size;
  for (const name of adding) named.set(name.toLowerCase(), byName.get(name.toLowerCase()) ?? 0);
  if (named.size === before) return;
  const bytes = [...named.values()].reduce((total, size) => total + size, 0);
  if (named.size > WORK_SOURCE_FILES)
    throw new ApiError(
      409,
      `${to.name} would then have ${named.size} files handed into it, and a start sends at most ${WORK_SOURCE_FILES}. Name fewer files, or retire an earlier hand-off.`,
      { code: 'handoff_files_over_limit', files: named.size, limit: WORK_SOURCE_FILES },
    );
  if (bytes > WORK_SOURCE_BYTES)
    throw new ApiError(
      409,
      `The files handed into ${to.name} would then come to ${Math.ceil(bytes / 1000)} KB, and a start sends at most ${WORK_SOURCE_BYTES / 1000} KB. Name fewer files, or retire an earlier hand-off.`,
      { code: 'handoff_files_over_limit', bytes, limit: WORK_SOURCE_BYTES },
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

/**
 * POST and GET /api/projects/:id/handoffs, and DELETE /api/projects/:id/handoffs/:handoffId to
 * retire one. Like every mutating route here they are the person's: the local client's own
 * requests, never a Team member's tools, which have no hand-off tool at all.
 */
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
        if (records.filter((item) => !item.retiredAt).length >= MANUAL_HANDOFF_LIMITS.perProject)
          throw new ApiError(
            409,
            `This project already keeps ${MANUAL_HANDOFF_LIMITS.perProject} live hand-offs, the most it can. Retire one, then hand off again.`,
            { code: 'handoff_limit' },
          );
        // Each changed file is one of this project's documents that the Board's start can send
        // (shared/task-sources.ts), by the name the project's listing gives it.
        const listed = request.changedFiles.length ? await store.listDocuments(projectId) : [];
        const changedFiles = request.changedFiles.map((name) => {
          const relative = relativeName(name);
          const found = listed.find((document) => document.path.toLowerCase() === relative.toLowerCase());
          if (!found || !(TASK_SOURCE_KINDS as readonly string[]).includes(found.kind))
            throw new ApiError(400, `${relative} isn't one of this project's text documents.`, {
              code: 'handoff_file_unknown',
            });
          return found.path;
        });
        if (changedFiles.length) requireHandoffFilesFit(listed, records, to, changedFiles);
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

  // Retiring keeps the record, stamped with `retiredAt`: it stops counting for the card's start,
  // for the files a card's hand-offs may name and for the per-project cap. Retiring one again
  // changes nothing and writes nothing.
  app.delete(
    '/api/projects/:id/handoffs/:handoffId',
    handle((req) =>
      store.locked(async () => {
        const state = store.state(String(req.params.id));
        const record = (state.manualHandoffs ?? []).find((item) => item.id === req.params.handoffId);
        if (!record) throw new ApiError(404, 'This hand-off was not found.', { code: 'handoff_missing' });
        if (record.retiredAt) return structuredClone(record);
        record.retiredAt = now();
        const named = (id: string) => state.tasks.find((task) => task.id === id)?.name ?? 'a removed card';
        store.addEntry(state, {
          kind: 'manual-handoff-retired',
          sentence: `You retired the hand-off from ${named(record.fromTaskId)} to ${named(record.toTaskId)}`,
          taskId: record.toTaskId,
        });
        await store.persist(state);
        return structuredClone(record);
      }),
    ),
  );
}
