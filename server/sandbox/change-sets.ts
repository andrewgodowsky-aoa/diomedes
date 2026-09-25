/**
 * The change sets delegates and workers hand back (H13 slice 2, H14; decision
 * of 2026-09-24), and every decision made about them.
 *
 * When a child finishes, its copy is compared with its snapshot and recorded
 * once as a change set: one JSON line in `<data>/projects/<id>/change-sets.jsonl`,
 * with the texts on both sides kept by sha beside it. Every decision about an
 * entry is another line; nothing is rewritten or removed (decision 10).
 *
 * Settling a change set into the project:
 *
 * - an entry inside what the parent may apply (the scope the person gave the
 *   loop at start, and a grant that holds `write-project-file`) is written
 *   through the one recorded writer, `Store.writeRecorded`, with the snapshot's
 *   sha as the expected base. It lands as an ordinary waiting Change of the
 *   loop's Session, attributed to the model that wrote it (decision 8), so P06's
 *   readable diff, per-hunk keep and Undo work on it as on any run's change;
 * - an entry whose file changed in the project after the snapshot is a
 *   conflict. The recorded writer refuses it and nothing is overwritten;
 * - every other entry (outside the scope, a deletion, or one the child only
 *   proposed) waits for a person under one ordinary Need. The person keeps or
 *   discards each entry, or keeps some of its hunks; a kept entry is written
 *   through the same recorded writer, as the person's, base-checked the same way.
 *
 * A depth-2 child's change set settles into its parent delegate's copy instead,
 * through the containment funnel rooted there; what the delegate itself returns
 * then carries it on, and anything the depth-2 child proposed stays proposed.
 *
 * The callers hold the store lock for a person's decision; settling takes it.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { OriginSnapshot } from '../../shared/attribution.js';
import type { Need } from '../../shared/types.js';
import {
  changeSetView,
  inScope,
  summaryOf,
  undecided,
  type ChangeSetDecision,
  type ChangeSetRecord,
  type ChangeSetSummary,
  type ChangeSetView,
  type SandboxManifest,
} from '../../shared/sandbox.js';
import { applyHunkSelection, buildDiff } from '../../shared/text-diff.js';
import { ApiError } from '../paths.js';
import { durableWrite, identifier, now, type Store } from '../store.js';
import type { SandboxStore } from './sandbox.js';

const PROJECT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const SHA = /^[a-f0-9]{64}$/;
const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');

type Line = { kind: 'recorded'; record: ChangeSetRecord } | { kind: 'decision'; decision: ChangeSetDecision };

const decideSchema = z.strictObject({
  protocolVersion: z.literal(1),
  commandId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/),
  decisions: z
    .array(
      z.strictObject({
        index: z.number().int().nonnegative(),
        decision: z.enum(['keep', 'discard']),
        hunks: z.array(z.number().int().nonnegative()).max(10_000).optional(),
      }),
    )
    .min(1)
    .max(200),
});

/** Who wrote a change set's text, in words for a sentence. */
function writer(origin: OriginSnapshot): string {
  if (origin.mode === 'direct' && origin.model.reported) return origin.model.reported;
  if (origin.mode === 'direct' && origin.engine) return origin.engine.id;
  return 'a sub-task';
}

export class ChangeSetLedger {
  constructor(private readonly dataDir: string) {}
  private dir(projectId: string) {
    if (!PROJECT_ID.test(projectId)) throw new ApiError(400, 'This project cannot be found.');
    return path.join(this.dataDir, 'projects', projectId);
  }
  private file(projectId: string) {
    return path.join(this.dir(projectId), 'change-sets.jsonl');
  }
  async append(projectId: string, line: Line) {
    await fs.mkdir(this.dir(projectId), { recursive: true });
    const handle = await fs.open(this.file(projectId), 'a');
    try {
      await handle.writeFile(`${JSON.stringify(line)}\n`, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
  }
  /** Every record and decision, oldest first. A torn last line is skipped, never repaired. */
  async read(projectId: string): Promise<{ records: ChangeSetRecord[]; decisions: ChangeSetDecision[] }> {
    const text = await fs.readFile(this.file(projectId), 'utf8').catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return '';
      throw error;
    });
    const records: ChangeSetRecord[] = [];
    const decisions: ChangeSetDecision[] = [];
    for (const raw of text.split('\n')) {
      if (!raw.trim()) continue;
      try {
        const line = JSON.parse(raw) as Line;
        if (line.kind === 'recorded' && line.record?.v === 1) records.push(line.record);
        else if (line.kind === 'decision' && line.decision?.v === 1) decisions.push(line.decision);
      } catch {
        // A torn line is left exactly as it was written.
      }
    }
    return { records, decisions };
  }
  /** The texts on both sides of every entry, kept by sha so the diff a person reads is the bytes recorded. */
  async saveText(projectId: string, text: string) {
    const sha = sha256(text);
    const target = path.join(this.dir(projectId), 'change-sets', 'objects', sha);
    if (!(await fs.lstat(target).catch(() => null))) await durableWrite(target, text);
    return sha;
  }
  async text(projectId: string, sha: string | null): Promise<string | null> {
    if (sha === null) return null;
    if (!SHA.test(sha)) throw new ApiError(409, 'A recorded version identifier is invalid.');
    const text = await fs.readFile(path.join(this.dir(projectId), 'change-sets', 'objects', sha), 'utf8');
    if (sha256(text) !== sha) throw new ApiError(409, 'A recorded version is damaged. Its contents were not applied.');
    return text;
  }
}

export interface RecordInput {
  readonly manifest: SandboxManifest;
  readonly handoffId: string;
  readonly taskId: string | null;
  readonly sessionId: string | null;
  readonly origin: OriginSnapshot;
  readonly models: ChangeSetRecord['models'];
  readonly applyScope: readonly string[] | null;
}

export class ChangeSetService {
  readonly ledger: ChangeSetLedger;
  constructor(
    private readonly store: Store,
    private readonly sandboxes: SandboxStore,
  ) {
    this.ledger = new ChangeSetLedger(store.dataDir);
  }

  static idFor(childRunId: string) {
    return `${childRunId}.cs`;
  }

  /** Record what the child's copy holds, once. A replay finds the record already made. */
  async record(input: RecordInput): Promise<ChangeSetRecord> {
    const { manifest } = input;
    const id = ChangeSetService.idFor(manifest.runId);
    const existing = (await this.ledger.read(manifest.projectId)).records.find((item) => item.id === id);
    if (existing) return existing;
    const collected = await this.sandboxes.collect(manifest);
    for (const entry of collected.entries) {
      if (entry.beforeText !== null) await this.ledger.saveText(manifest.projectId, entry.beforeText);
      if (entry.text !== null) await this.ledger.saveText(manifest.projectId, entry.text);
    }
    const record: ChangeSetRecord = {
      v: 1,
      id,
      projectId: manifest.projectId,
      rootRunId: manifest.rootRunId,
      parentRunId: manifest.parentRunId,
      childRunId: manifest.runId,
      handoffId: input.handoffId,
      role: manifest.role,
      depth: manifest.depth,
      taskId: input.taskId,
      sessionId: input.sessionId,
      recordedAt: now(),
      origin: structuredClone(input.origin),
      models: structuredClone(input.models),
      scope: manifest.scope,
      applyScope: input.applyScope === null ? null : [...input.applyScope],
      entries: collected.entries.map((entry, index) => ({
        index,
        path: entry.path,
        op: entry.op,
        before: entry.before,
        after: entry.after,
        bytes: entry.bytes,
        proposed: entry.proposed,
      })),
      dropped: collected.dropped,
    };
    await this.ledger.append(manifest.projectId, { kind: 'recorded', record });
    await this.sandboxes.collected(manifest);
    return record;
  }

  private async decision(projectId: string, fields: Omit<ChangeSetDecision, 'v' | 'at'>) {
    const decision: ChangeSetDecision = { v: 1, at: now(), ...fields };
    await this.ledger.append(projectId, { kind: 'decision', decision });
    return decision;
  }

  async view(projectId: string, changeSetId: string): Promise<ChangeSetView> {
    const { records, decisions } = await this.ledger.read(projectId);
    const record = records.find((item) => item.id === changeSetId);
    if (!record) throw new ApiError(404, 'This change set was not found.');
    return changeSetView(record, decisions);
  }
  async views(projectId: string, filter: { rootRunId?: string } = {}): Promise<ChangeSetView[]> {
    const { records, decisions } = await this.ledger.read(projectId);
    return records
      .filter((record) => !filter.rootRunId || record.rootRunId === filter.rootRunId)
      .map((record) => changeSetView(record, decisions));
  }
  private async recordOf(projectId: string, changeSetId: string) {
    const { records, decisions } = await this.ledger.read(projectId);
    const record = records.find((item) => item.id === changeSetId);
    if (!record) throw new ApiError(404, 'This change set was not found.');
    return { record, view: changeSetView(record, decisions) };
  }

  /** Both sides of one entry, and P06's readable diff between them. */
  async diff(projectId: string, changeSetId: string, index: number) {
    const { record } = await this.recordOf(projectId, changeSetId);
    const entry = record.entries.find((item) => item.index === index);
    if (!entry) throw new ApiError(404, 'This change was not found in the change set.');
    const before = await this.ledger.text(projectId, entry.before);
    const after = await this.ledger.text(projectId, entry.after);
    return { path: entry.path, op: entry.op, before, after, diff: buildDiff({ path: entry.path, before, after }) };
  }

  /** Who moved a file on since the snapshot, in words, for a conflict. */
  private movedBy(projectId: string, path: string, currentSha: string | null) {
    const latest = this.store.latestFile(this.store.state(projectId), path);
    if (latest && latest.file.after === currentSha) return latest.entry.actor === 'you' ? 'you' : 'Diomedes';
    return 'someone outside Diomedes';
  }

  /**
   * Settle a root-level change set into the project: apply what the parent
   * may, raise one Need for the rest. Idempotent: an entry already decided is
   * left as it is, and one whose write landed before its decision was recorded
   * is recognised by its bytes.
   */
  async settleIntoProject(record: ChangeSetRecord, options: { canWrite: boolean }): Promise<ChangeSetSummary> {
    const projectId = record.projectId;
    return this.store.locked(async () => {
      let view = (await this.recordOf(projectId, record.id)).view;
      const waiting: { index: number; reason: string }[] = [];
      for (const entry of view.entries) {
        if (entry.state !== 'pending') continue;
        const reason = entry.proposed
          ? entry.op === 'deleted'
            ? 'a deletion always waits for a person'
            : 'the sub-task asked for a person to decide it'
          : !options.canWrite
            ? 'this loop may not write project files'
            : record.applyScope === null
              ? 'this loop was not given a scope it may apply changes in'
              : !inScope(entry.path, record.applyScope)
                ? `it is outside what this loop may apply (${record.applyScope.join(', ')})`
                : null;
        if (reason) {
          waiting.push({ index: entry.index, reason });
          continue;
        }
        const text = await this.ledger.text(projectId, entry.after);
        try {
          const written = await this.store.writeRecorded(projectId, [{ path: entry.path, text, expected: entry.before }], {
            actor: 'diomedes',
            kind: 'delegate-change',
            sessionId: record.sessionId,
            taskId: record.taskId,
            origin: record.origin,
            merge: false,
            sentence: `Diomedes applied a sub-task's change to ${entry.path}, written by ${writer(record.origin)}, inside the scope you gave this loop`,
          });
          await this.decision(projectId, {
            changeSetId: record.id,
            index: entry.index,
            kind: 'applied',
            by: 'diomedes',
            entryId: written.id,
            needId: null,
            hunks: null,
            currentSha: entry.after,
            reason: null,
            commandId: null,
          });
        } catch (error) {
          if (!(error instanceof ApiError)) throw error;
          const currentSha = (error.details as { currentSha?: string | null } | undefined)?.currentSha ?? null;
          if (error.status === 409 && currentSha === entry.after) {
            // The write landed before its decision was recorded: the bytes say so.
            await this.decision(projectId, {
              changeSetId: record.id,
              index: entry.index,
              kind: 'applied',
              by: 'diomedes',
              entryId: this.store.latestFile(this.store.state(projectId), entry.path)?.entry.id ?? null,
              needId: null,
              hunks: null,
              currentSha,
              reason: 'Recognised on replay by its bytes.',
              commandId: null,
            });
          } else if (error.status === 409)
            await this.decision(projectId, {
              changeSetId: record.id,
              index: entry.index,
              kind: 'conflict',
              by: 'diomedes',
              entryId: null,
              needId: null,
              hunks: null,
              currentSha,
              reason: `${entry.path} was changed by ${this.movedBy(projectId, entry.path, currentSha)} after the sub-task's copy was taken, so nothing was written over it.`,
              commandId: null,
            });
          else waiting.push({ index: entry.index, reason: error.message });
        }
      }
      if (waiting.length) await this.raise(record, waiting);
      view = (await this.recordOf(projectId, record.id)).view;
      return summaryOf(view);
    });
  }

  /** One ordinary Need for the entries a person decides. Raised once per change set. */
  private async raise(record: ChangeSetRecord, waiting: { index: number; reason: string }[]) {
    const projectId = record.projectId;
    const state = this.store.state(projectId);
    let need = state.needs.find((item) => item.changeSet?.changeSetId === record.id);
    if (!need && record.sessionId && record.taskId) {
      const paths = waiting.map((item) => record.entries[item.index].path);
      const reasons = [...new Set(waiting.map((item) => item.reason))];
      need = {
        id: identifier('N'),
        sessionId: record.sessionId,
        taskId: record.taskId,
        what: `A sub-task's ${paths.length === 1 ? 'change' : `${paths.length} changes`} to ${paths.slice(0, 3).join(', ')}${paths.length > 3 ? ` and ${paths.length - 3} more` : ''} ${paths.length === 1 ? 'waits' : 'wait'} for you`,
        why: `${writer(record.origin)} wrote ${paths.length === 1 ? 'it' : 'them'} in its own sandbox, and this loop did not apply ${paths.length === 1 ? 'it' : 'them'}: ${reasons.join('; ')}.`,
        consequence:
          'Keep writes a change to the project as yours, checked against the version the sub-task started from. Discard leaves the project as it is. Nothing changes until you decide.',
        files: paths,
        state: 'open',
        createdAt: now(),
        decidedAt: null,
        decidedFrom: 'desktop',
        allowForTask: false,
        origin: structuredClone(record.origin),
        changeSet: { protocolVersion: 1, changeSetId: record.id, indexes: waiting.map((item) => item.index) },
      };
      state.needs.push(need);
      this.store.addEntry(state, {
        kind: 'change-set',
        actor: 'diomedes',
        sentence: `A sub-task returned ${paths.length === 1 ? 'a change' : `${paths.length} changes`} for you to review: ${paths.slice(0, 3).join(', ')}`,
        taskId: record.taskId,
        origin: structuredClone(record.origin),
      });
      await this.store.persist(state);
    }
    for (const item of waiting)
      await this.decision(projectId, {
        changeSetId: record.id,
        index: item.index,
        kind: 'waiting',
        by: 'diomedes',
        entryId: null,
        needId: need?.id ?? null,
        hunks: null,
        currentSha: null,
        reason: item.reason,
        commandId: null,
      });
  }

  /**
   * Settle a depth-2 child's change set into its parent delegate's copy. Nothing
   * reaches the project: the delegate's own change set carries these on, and
   * what the depth-2 child proposed stays proposed.
   */
  async settleIntoSandbox(record: ChangeSetRecord, parent: SandboxManifest): Promise<ChangeSetSummary> {
    const projectId = record.projectId;
    const view = (await this.recordOf(projectId, record.id)).view;
    for (const entry of view.entries) {
      if (entry.state !== 'pending') continue;
      const base = { changeSetId: record.id, index: entry.index, by: 'delegate' as const, needId: null, hunks: null, commandId: null };
      let current: string | null;
      try {
        current = await this.sandboxes.shaIn(parent, entry.path);
      } catch (error) {
        await this.decision(projectId, { ...base, kind: 'discarded', entryId: null, currentSha: null, reason: error instanceof Error ? error.message : 'Refused.' });
        continue;
      }
      if (current === entry.after) {
        await this.decision(projectId, { ...base, kind: 'applied', entryId: null, currentSha: current, reason: 'Already in the delegate’s copy.' });
        continue;
      }
      if (current !== entry.before) {
        await this.decision(projectId, {
          ...base,
          kind: 'conflict',
          entryId: null,
          currentSha: current,
          reason: `${entry.path} changed in the delegate's own copy after this copy was taken, so nothing was written over it.`,
        });
        continue;
      }
      try {
        await this.sandboxes.writeInto(parent, entry.path, await this.ledger.text(projectId, entry.after));
        if (entry.proposed) await this.sandboxes.markProposed(projectId, parent.runId, [entry.path]);
        await this.decision(projectId, { ...base, kind: 'applied', entryId: null, currentSha: entry.after, reason: null });
      } catch (error) {
        await this.decision(projectId, { ...base, kind: 'discarded', entryId: null, currentSha: current, reason: error instanceof Error ? error.message : 'Refused.' });
      }
    }
    return summaryOf((await this.recordOf(projectId, record.id)).view);
  }

  /**
   * A person's decisions on a change set's waiting entries. Called with the
   * store lock held. Replaying a command id returns the change set as it is.
   */
  async decide(projectId: string, changeSetId: string, body: unknown): Promise<ChangeSetView> {
    const parsed = decideSchema.safeParse(body);
    if (!parsed.success)
      throw new ApiError(400, 'Send a versioned decision with a command id, and keep or discard for each change.', {
        code: 'invalid_change_set_decision',
      });
    const request = parsed.data;
    let { record, view } = await this.recordOf(projectId, changeSetId);
    const { decisions } = await this.ledger.read(projectId);
    if (decisions.some((item) => item.commandId === request.commandId)) return view;
    if (new Set(request.decisions.map((item) => item.index)).size !== request.decisions.length)
      throw new ApiError(400, 'Decide each change once.');
    for (const item of request.decisions) {
      const entry = view.entries.find((candidate) => candidate.index === item.index);
      if (!entry) throw new ApiError(404, 'This change was not found in the change set.');
      if (!undecided(entry)) throw new ApiError(409, `The change to ${entry.path} has already been decided.`, { code: 'change_decided' });
    }
    for (const item of request.decisions) {
      const entry = view.entries.find((candidate) => candidate.index === item.index)!;
      const base = {
        changeSetId,
        index: entry.index,
        by: 'you' as const,
        needId: entry.decision?.needId ?? null,
        commandId: request.commandId,
      };
      if (item.decision === 'discard') {
        await this.decision(projectId, { ...base, kind: 'discarded', entryId: null, hunks: null, currentSha: null, reason: null });
        continue;
      }
      const before = await this.ledger.text(projectId, entry.before);
      const after = await this.ledger.text(projectId, entry.after);
      let text = after;
      let hunks: number[] | null = null;
      if (item.hunks) {
        if (entry.op !== 'modified' || before === null || after === null)
          throw new ApiError(409, 'Only a change to an existing text file can be kept in part. Keep or discard it whole.');
        const diff = buildDiff({ path: entry.path, before, after });
        const all = diff.hunks.map((hunk) => hunk.index);
        if (!diff.selectable || !item.hunks.length || item.hunks.some((index) => !all.includes(index)))
          throw new ApiError(400, `Name at least one of the ${all.length} parts of ${entry.path} to keep.`);
        hunks = [...new Set(item.hunks)].sort((a, b) => a - b);
        text = hunks.length === all.length ? after : applyHunkSelection(before, after, hunks);
      }
      try {
        const written = await this.store.writeRecorded(projectId, [{ path: entry.path, text, expected: entry.before }], {
          actor: 'you',
          kind: 'delegate-change-kept',
          taskId: record.taskId,
          origin: record.origin,
          merge: false,
          sentence: `You kept ${hunks ? `${hunks.length} of the parts of ` : ''}a sub-task's change to ${entry.path}, written by ${writer(record.origin)}`,
        });
        await this.decision(projectId, { ...base, kind: 'kept', entryId: written.id, hunks, currentSha: sha256(text ?? ''), reason: null });
      } catch (error) {
        if (!(error instanceof ApiError) || error.status !== 409) throw error;
        const currentSha = (error.details as { currentSha?: string | null } | undefined)?.currentSha ?? null;
        await this.decision(projectId, {
          ...base,
          kind: 'conflict',
          entryId: null,
          hunks,
          currentSha,
          reason: `${entry.path} was changed by ${this.movedBy(projectId, entry.path, currentSha)} after the sub-task's copy was taken, so nothing was written over it.`,
        });
      }
    }
    ({ record, view } = await this.recordOf(projectId, changeSetId));
    await this.settleNeed(projectId, view);
    return view;
  }

  /** The generic Need answer: go ahead keeps every waiting entry whole, decline discards them. */
  async resolveNeed(projectId: string, need: Need, resolution: 'go-ahead' | 'declined', commandId: string) {
    if (!need.changeSet) throw new ApiError(400, 'This request is not a change set.');
    if (need.state !== 'open') throw new ApiError(409, 'This request has already been decided.');
    const view = await this.view(projectId, need.changeSet.changeSetId);
    const open = view.entries.filter(undecided);
    if (!open.length) {
      await this.settleNeed(projectId, view);
      return this.view(projectId, view.id);
    }
    return this.decide(projectId, view.id, {
      protocolVersion: 1,
      commandId,
      decisions: open.map((entry) => ({ index: entry.index, decision: resolution === 'go-ahead' ? 'keep' : 'discard' })),
    });
  }

  /** Once nothing under a Need waits, it is answered: go ahead if anything was kept, declined if not. */
  private async settleNeed(projectId: string, view: ChangeSetView) {
    const state = this.store.state(projectId);
    const need = state.needs.find((item) => item.changeSet?.changeSetId === view.id);
    if (!need || need.state !== 'open') return;
    const mine = view.entries.filter((entry) => need.changeSet!.indexes.includes(entry.index));
    if (mine.some(undecided)) return;
    need.state = mine.some((entry) => entry.state === 'kept') ? 'go-ahead' : 'declined';
    need.decidedAt = now();
    need.decidedFrom = 'desktop';
    const task = state.tasks.find((item) => item.id === need.taskId);
    if (task?.needId === need.id) task.needId = null;
    await this.store.persist(state);
  }
}
