/**
 * H14: the durable, append-only record of every handoff a lead makes.
 *
 * One JSON line per event in `<data>/projects/<id>/handoffs.jsonl`, appended and
 * fsynced before the caller goes on. Nothing here rewrites or removes a line
 * (decision 10): a retry, a reuse or a settlement is a new line naming the
 * handoff it concerns, and the Team view is projected from the whole file plus
 * the child runs' own records (`shared/team-delegation.ts`).
 *
 * A process that dies mid-append can leave a torn last line. Reading skips a
 * line that does not parse and says how many it skipped; it never repairs the
 * file, so the bytes stay exactly as they were written.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type { HandoffEvent } from '../../shared/team-delegation.js';

const PROJECT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

const role = z.enum(['worker', 'advisor']);
const base = {
  v: z.literal(1),
  at: z.string().min(1),
  handoffId: z.string().min(1).max(200),
  leadRunId: z.string().min(1).max(128),
};
const budget = z.strictObject({
  turns: z.number().int().positive(),
  tokens: z.number().int().positive().nullable(),
  wallMs: z.number().int().positive().nullable(),
});
const model = z.strictObject({ engine: z.string().nullable(), reported: z.string().nullable(), calls: z.number().int() });
const agent = z.strictObject({ id: z.string(), version: z.string(), name: z.string(), ceiling: z.string() });
const profile = z
  .strictObject({
    profileId: z.string(),
    revision: z.number().int(),
    name: z.string(),
    digest: z.string(),
    source: z.string(),
    fallback: z.string().nullable(),
  })
  .nullable();

/** Every line is checked on read; an unknown shape is skipped and counted, never trusted. */
export const handoffEventSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    ...base,
    kind: z.literal('opened'),
    taskId: z.string().nullable(),
    role,
    stepId: z.string(),
    childRunId: z.string(),
    envelopeId: z.string(),
    task: z.string(),
    scope: z.array(z.string()),
    budget,
    agent,
    route: z.string(),
    model: z.string().nullable(),
    profile,
    attempt: z.number().int().positive(),
    retryOf: z.string().nullable(),
  }),
  z.strictObject({
    ...base,
    kind: z.literal('refused'),
    role,
    stepId: z.string(),
    task: z.string(),
    scope: z.array(z.string()),
    reason: z.string(),
  }),
  z.strictObject({
    ...base,
    kind: z.literal('reused'),
    role,
    stepId: z.string(),
    from: z.string(),
    task: z.string(),
    scope: z.array(z.string()),
  }),
  z.strictObject({
    ...base,
    kind: z.literal('settled'),
    childRunId: z.string(),
    state: z.enum(['queued', 'running', 'waiting', 'completed', 'failed', 'cancelled', 'reconcile_required']),
    text: z.string().nullable(),
    reason: z.string().nullable(),
    models: z.array(model),
    used: z.strictObject({ units: z.number(), modelCalls: z.number(), toolCalls: z.number() }),
    tokens: z.number().nullable(),
    wallMs: z.number().nullable(),
  }),
]);

export interface LedgerRead {
  readonly events: HandoffEvent[];
  /** Lines that did not parse (a torn final append, or a shape this build does not know). */
  readonly skipped: number;
}

export class HandoffLedger {
  /** Appends to one file are serialised so two lines never interleave. */
  private readonly queues = new Map<string, Promise<void>>();

  constructor(private readonly dataDir: string) {}

  file(projectId: string): string {
    if (!PROJECT_ID.test(projectId)) throw new Error('A handoff ledger needs a project id.');
    return path.join(this.dataDir, 'projects', projectId, 'handoffs.jsonl');
  }

  /** Append one event and fsync it. The event is validated first; nothing invalid is written. */
  async append(projectId: string, event: HandoffEvent): Promise<void> {
    const line = `${JSON.stringify(handoffEventSchema.parse(event))}\n`;
    const target = this.file(projectId);
    const previous = this.queues.get(target) ?? Promise.resolve();
    const next = previous.then(async () => {
      await fs.mkdir(path.dirname(target), { recursive: true });
      const handle = await fs.open(target, 'a');
      try {
        await handle.appendFile(line, 'utf8');
        await handle.sync();
      } finally {
        await handle.close();
      }
    });
    this.queues.set(
      target,
      next.catch(() => undefined),
    );
    await next;
  }

  async read(projectId: string): Promise<LedgerRead> {
    let text: string;
    try {
      text = await fs.readFile(this.file(projectId), 'utf8');
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return { events: [], skipped: 0 };
      throw error;
    }
    const events: HandoffEvent[] = [];
    let skipped = 0;
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        const parsed = handoffEventSchema.safeParse(JSON.parse(line));
        if (parsed.success) events.push(parsed.data as HandoffEvent);
        else skipped += 1;
      } catch {
        skipped += 1;
      }
    }
    return { events, skipped };
  }

  /** Every event about one lead run, oldest first. */
  async forLead(projectId: string, leadRunId: string): Promise<HandoffEvent[]> {
    return (await this.read(projectId)).events.filter((event) => event.leadRunId === leadRunId);
  }
}
