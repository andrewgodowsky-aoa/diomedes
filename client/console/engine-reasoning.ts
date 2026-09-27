import { reasoningPreviewSchema } from '../../shared/adapter-contract';
import type { PreviewCursor, PreviewPosition } from './engine-text-preview';

/** The thinking shown while a reply is on its way. Display state only; never saved. */
export interface LiveThinking {
  text: string;
  position: PreviewPosition;
  /** When the reply started, for "Thought for 14s". */
  since: number;
  /** When the first answer text arrived, or null while thinking continues. */
  endedAt: number | null;
}

/** The longest live thinking a page keeps; the saved record is the authority. */
export const MAX_LIVE_THINKING_CHARS = 64 * 1024;

type Decision =
  | { kind: 'append'; cursor: PreviewCursor; text: string }
  | { kind: 'ignore' }
  | { kind: 'discard' };

/** The same attribution and gap rules as `acceptPreview`, for `reasoning-delta` frames. */
export function acceptReasoning(position: PreviewPosition, frame: unknown): Decision {
  if (position === 'lost') return { kind: 'ignore' };
  const parsed = reasoningPreviewSchema.safeParse(frame);
  if (!parsed.success) return { kind: 'discard' };
  const { stepId, attempt, fence, seq, text } = parsed.data;
  if (position) {
    if (stepId !== position.stepId || attempt !== position.attempt || fence !== position.fence)
      return { kind: 'discard' };
    if (seq <= position.seq) return { kind: 'ignore' };
  }
  if (seq !== (position?.seq ?? 0) + 1) return { kind: 'discard' };
  return { kind: 'append', cursor: { stepId, attempt, fence, seq }, text };
}

/** One thinking frame applied. A gap loses the live thinking; the saved record replaces it. */
export function stepThinking(state: LiveThinking | null, frame: unknown, since: number): LiveThinking | null {
  const accepted = acceptReasoning(state?.position ?? null, frame);
  if (accepted.kind === 'ignore') return state;
  if (accepted.kind === 'discard')
    return { text: '', position: 'lost', since: state?.since ?? since, endedAt: state?.endedAt ?? null };
  return {
    text: ((state?.text ?? '') + accepted.text).slice(0, MAX_LIVE_THINKING_CHARS),
    position: accepted.cursor,
    since: state?.since ?? since,
    endedAt: state?.endedAt ?? null,
  };
}

/** The answer started: thinking folds. Only the first call counts. */
export function endThinking(state: LiveThinking | null, now: number): LiveThinking | null {
  return state && state.endedAt === null ? { ...state, endedAt: now } : state;
}

/** The fold line a person reads. */
export function thoughtFor(ms: number): string {
  return ms < 1_500 ? 'Thought for a moment' : `Thought for ${Math.round(ms / 1_000)}s`;
}
