import { toolActivitySchema, type ToolActivity } from '../../shared/adapter-contract';

/** One tool call as a presenter shows it: the latest word on that call. Display state only. */
export interface ToolLine {
  callId: string;
  tool: string;
  phase: ToolActivity['phase'];
  summary: string;
  detail?: string;
}

/** The tool lines of one fenced attempt and the last frame applied to them. */
export interface ActivityState {
  stepId: string;
  attempt: number;
  fence: number;
  seq: number;
  lines: ToolLine[];
}

/** A long run keeps its latest calls; the durable record holds every one. */
export const MAX_TOOL_LINES = 40;

/**
 * Applies one `engine-activity` frame. The caller has already matched project, thread, request
 * and run. Returns the same object when the frame changes nothing, so a caller can skip a
 * repaint. Activity is narration, never the answer: a malformed, duplicate, late or foreign-
 * attempt frame is dropped rather than poisoning anything, and a gap is tolerated.
 */
export function acceptActivity(state: ActivityState | null, frame: unknown): ActivityState | null {
  const parsed = toolActivitySchema.safeParse(frame);
  if (!parsed.success) return state;
  const { stepId, attempt, fence, seq, callId, phase, tool, summary, detail } = parsed.data;
  let base = state;
  if (base && (base.stepId !== stepId || base.attempt !== attempt || base.fence !== fence)) {
    // A retried attempt supersedes the one it replaced; anything older is a late frame.
    const newer = fence > base.fence || (fence === base.fence && attempt > base.attempt);
    if (!newer) return state;
    base = null;
  }
  if (base && seq <= base.seq) return state;
  const lines = base ? [...base.lines] : [];
  const line: ToolLine = { callId, tool, phase, summary, ...(detail ? { detail } : {}) };
  const at = lines.findIndex((item) => item.callId === callId);
  if (at >= 0) {
    // A finish never reverts to started, and a start seen after its finish changes nothing.
    if (lines[at].phase !== 'started' && phase === 'started') return { ...base!, seq };
    lines[at] = { ...line, detail: detail ?? lines[at].detail };
    if (lines[at].detail === undefined) delete lines[at].detail;
  } else lines.push(line);
  return {
    stepId,
    attempt,
    fence,
    seq,
    lines: lines.length > MAX_TOOL_LINES ? lines.slice(-MAX_TOOL_LINES) : lines,
  };
}

/**
 * Who owns an `engine-activity` frame in a project view: the ask on screen, when the frame
 * names its exact request (and then only with its run and thread too), or a work run's card,
 * found by request id, which is that run's session id. Everything else is dropped.
 */
export function activityTarget(
  frame: unknown,
  scope: {
    projectId: string;
    ask: { requestId: string; runId: string; threadId: string } | null;
  },
): { kind: 'ask'; requestId: string } | { kind: 'run'; requestId: string } | { kind: 'drop' } {
  if (typeof frame !== 'object' || frame === null) return { kind: 'drop' };
  const data = frame as Record<string, unknown>;
  if (data.projectId !== scope.projectId || typeof data.requestId !== 'string' || !data.requestId)
    return { kind: 'drop' };
  const { ask } = scope;
  if (ask && data.requestId === ask.requestId)
    return data.runId === ask.runId && data.threadId === ask.threadId
      ? { kind: 'ask', requestId: ask.requestId }
      : { kind: 'drop' };
  return { kind: 'run', requestId: data.requestId };
}

/** How many runs' tool calls a project view keeps at once; older ones are let go. */
export const MAX_RUN_ACTIVITY = 8;

/** Applies a work-run frame to the map of runs' tool calls, keeping the newest runs only. */
export function rememberRunActivity(
  runs: Readonly<Record<string, ActivityState>>,
  frame: unknown,
): Record<string, ActivityState> {
  const requestId = (frame as { requestId?: unknown } | null)?.requestId;
  if (typeof requestId !== 'string') return runs as Record<string, ActivityState>;
  const before = Object.hasOwn(runs, requestId) ? runs[requestId] : null;
  const next = acceptActivity(before, frame);
  if (!next || next === before) return runs as Record<string, ActivityState>;
  const kept = Object.entries(runs).filter(([id]) => id !== requestId);
  return Object.fromEntries([...kept.slice(-(MAX_RUN_ACTIVITY - 1)), [requestId, next]]);
}

/** True while any call on screen has started and not yet finished. */
export const toolRunning = (lines: readonly ToolLine[] | undefined) =>
  Boolean(lines?.some((line) => line.phase === 'started'));

/** The one plain sentence a person reads for a call. */
export function toolSentence(line: ToolLine): string {
  const said = line.summary.replace(/[.…\s]+$/u, '');
  if (line.phase === 'started') return `${said}…`;
  if (line.phase === 'failed') return `${said} (did not finish)`;
  return said;
}
