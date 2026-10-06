import { z } from 'zod';
import type { ToolActivity } from '../../shared/adapter-contract.js';
import type { PromptProgress } from './model-api-core.js';

export const LOCAL_READING_TEXT = 'Reading the document.';
type Identity = Pick<ToolActivity, 'projectId' | 'threadId' | 'requestId' | 'runId' | 'stepId' | 'attempt' | 'fence'>;
export interface LocalPromptProgressFrame extends Identity, PromptProgress {
  kind: 'local-prompt-progress';
  seq: number;
  text: typeof LOCAL_READING_TEXT;
}
const progressSchema = z.object({
  total: z.number().int().min(0).max(10_000_000),
  cache: z.number().int().min(0).max(10_000_000),
  processed: z.number().int().min(0).max(10_000_000),
  time_ms: z.number().finite().nonnegative(),
}).refine(value => value.cache <= value.processed && value.processed <= value.total);

/**
 * Only counters and fixed host text enter this channel, so it needs no redaction and never joins
 * the attempt's live order. Text held there for redaction (the tail of an earlier call in the same
 * turn) would otherwise hold back the reading line until the next call's prefill is over. The
 * service fences publication to the active attempt.
 */
export function localPromptProgressSink(options: {
  identity: Identity; signal: AbortSignal;
  publish: (frame: LocalPromptProgressFrame) => void;
}): (progress: PromptProgress) => void {
  let seq = 0;
  return raw => {
    if (options.signal.aborted) return;
    const parsed = progressSchema.safeParse(raw);
    if (!parsed.success) return;
    options.publish({ ...options.identity, ...parsed.data,
      kind: 'local-prompt-progress', seq: ++seq, text: LOCAL_READING_TEXT });
  };
}
