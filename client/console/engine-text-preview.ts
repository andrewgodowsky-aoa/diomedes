import { transientPreviewSchema, type TransientPreview } from '../../shared/adapter-contract';

/** Presentation state only; durable run and attempt authority stays on the host. */
export type PreviewCursor = Pick<TransientPreview, 'stepId' | 'attempt' | 'fence' | 'seq'>;
export type PreviewPosition = PreviewCursor | 'lost' | null;
type PreviewDecision =
  | { kind: 'append'; cursor: PreviewCursor; text: string }
  | { kind: 'ignore' }
  | { kind: 'discard' };

/** The caller has already matched project, thread, request and run. */
export function acceptPreview(position: PreviewPosition, frame: unknown): PreviewDecision {
  if (position === 'lost') return { kind: 'ignore' };
  const parsed = transientPreviewSchema.safeParse(frame);
  if (!parsed.success || parsed.data.seq < 1) return { kind: 'discard' };
  const { stepId, attempt, fence, seq, text } = parsed.data;
  if (position) {
    if (stepId !== position.stepId || attempt !== position.attempt || fence !== position.fence)
      return { kind: 'discard' };
    if (seq <= position.seq) return { kind: 'ignore' };
  }
  if (seq !== (position?.seq ?? 0) + 1) return { kind: 'discard' };
  return { kind: 'append', cursor: { stepId, attempt, fence, seq }, text };
}
