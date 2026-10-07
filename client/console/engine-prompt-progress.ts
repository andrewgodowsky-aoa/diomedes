import { z } from 'zod';

/**
 * A local model's read of a long prompt, as the thread shows it while it moves. Display state
 * only; never saved. The counters are the local server's own: `processed` includes the `cache`
 * it reused, and reaches `total` when the read ends.
 */
export interface ReadingProgress {
  stepId: string;
  attempt: number;
  fence: number;
  seq: number;
  /** The host's fixed sentence, shown as sent. */
  text: string;
  total: number;
  cache: number;
  processed: number;
  /** False once the read reached its end or answer text followed it. */
  open: boolean;
}

/**
 * The smallest read the thread shows, counted in the part the server did not take from its
 * cache. A plain message, with the app's instructions and the longest history a thread keeps,
 * stays under it in practice, so the line appears for a long document and a short prompt never
 * flashes it.
 */
export const READING_LINE_MIN_TOKENS = 16_384;

const frameSchema = z
  .object({
    kind: z.literal('local-prompt-progress'),
    stepId: z.string().min(1).max(200),
    attempt: z.number().int().positive(),
    fence: z.number().int().positive(),
    seq: z.number().int().positive(),
    text: z.string().min(1).max(200),
    total: z.number().int().min(0).max(10_000_000),
    cache: z.number().int().min(0).max(10_000_000),
    processed: z.number().int().min(0).max(10_000_000),
  })
  .refine((frame) => frame.cache <= frame.processed && frame.processed <= frame.total);

/**
 * Applies one `engine-prompt-progress` frame. The caller has already matched project, thread,
 * request and run. Every model call in a turn shares the turn's step, attempt and fence, and the
 * sequence runs on across them, so a later call's read arrives as the next frame. As with tool
 * activity, a malformed, duplicate, late or foreign-attempt frame is dropped, and a newer attempt
 * starts over. Returns the same object when the frame changes nothing.
 */
export function acceptReading(state: ReadingProgress | null, frame: unknown): ReadingProgress | null {
  const parsed = frameSchema.safeParse(frame);
  if (!parsed.success) return state;
  const { stepId, attempt, fence, seq, text, total, cache, processed } = parsed.data;
  if (state) {
    const same = state.stepId === stepId && state.attempt === attempt && state.fence === fence;
    if (same && seq <= state.seq) return state;
    if (!same && !(fence > state.fence || (fence === state.fence && attempt > state.attempt)))
      return state;
  }
  return {
    stepId,
    attempt,
    fence,
    seq,
    text,
    total,
    cache,
    processed,
    open: processed < total && total - cache >= READING_LINE_MIN_TOKENS,
  };
}

/** Answer text arrived: the read before it is over. */
export function closeReading(state: ReadingProgress | null): ReadingProgress | null {
  return state && state.open ? { ...state, open: false } : state;
}

/**
 * A run card's read (DIO-256): the call that last sent counters for that run, and its read. The key
 * names the run, or the loop's child run, and the step, so a new call starts the read over.
 */
export interface RunReading {
  key: string;
  reading: ReadingProgress;
}

/** How many runs' reads a project view keeps at once; older ones are let go. */
export const MAX_RUN_READINGS = 8;

/**
 * Applies a Work run's or an Agent loop's `engine-prompt-progress` frame to the map of runs' reads,
 * by the frame's request, which is the run's session id. The caller has already matched the project
 * and found the frame is not the ask's. A frame from another call (another child run or step)
 * starts that run's read over, gated as it may be, so a read the next call took over never lingers;
 * within one call, `acceptReading` orders the frames as it does for the ask.
 */
export function rememberRunReading(
  runs: Readonly<Record<string, RunReading>>,
  frame: unknown,
): Record<string, RunReading> {
  const data = frame as { requestId?: unknown; runId?: unknown; childRunId?: unknown; stepId?: unknown } | null;
  if (typeof data?.requestId !== 'string' || typeof data.runId !== 'string' || typeof data.stepId !== 'string')
    return runs as Record<string, RunReading>;
  const requestId = data.requestId;
  const key = `${typeof data.childRunId === 'string' ? data.childRunId : data.runId}:${data.stepId}`;
  const before = Object.hasOwn(runs, requestId) ? runs[requestId] : null;
  const reading = acceptReading(before?.key === key ? before.reading : null, frame);
  if (!reading || reading === before?.reading) return runs as Record<string, RunReading>;
  const kept = Object.entries(runs).filter(([id]) => id !== requestId);
  return Object.fromEntries([...kept.slice(-(MAX_RUN_READINGS - 1)), [requestId, { key, reading }]]);
}

/** The counts as the server sent them, "45,312 of 117,536". Technical detail names the unit. */
export function readingDetail(state: ReadingProgress, technical = false): string {
  const counts = `${state.processed.toLocaleString('en-US')} of ${state.total.toLocaleString('en-US')}`;
  return technical ? `${counts} tokens` : counts;
}

/**
 * The share of the prompt the server has in hand, cache included, as a whole percent: the number
 * the bar fills to, the line says and a screen reader hears. Floored, so a read still open never
 * says 100%.
 */
export function readingPercent(state: ReadingProgress): number {
  return state.total > 0 ? Math.floor((state.processed / state.total) * 100) : 0;
}

/**
 * The line under the bar, "Reading the document. 38% so far." Technical detail adds the server's
 * counts. The default line leaves them out: a count of tokens means nothing to an owner, and a
 * local read has no credits to show in its place.
 */
export function readingCaption(state: ReadingProgress, technical = false): string {
  const line = `${state.text} ${readingPercent(state)}% so far`;
  return technical ? `${line}, ${readingDetail(state, true)}.` : `${line}.`;
}
