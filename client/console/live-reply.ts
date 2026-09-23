import { acceptActivity, type ActivityState } from './engine-activity';
import { acceptPreview, type PreviewPosition } from './engine-text-preview';

/** The one command a page is waiting on: the dispatch identity its send was issued. */
export interface LiveBinding {
  projectId: string;
  threadId: string;
  requestId: string;
}

/** What a page shows while an answer is on its way. Display state only; never saved. */
export interface LiveReply {
  projectId: string;
  threadId: string;
  requestId: string;
  /** Adopted from the started frame: every later frame must carry the same run. */
  runId: string;
  text: string;
  position: PreviewPosition;
  activity: ActivityState | null;
}

export type LiveEvent =
  | { type: 'engine-text' | 'engine-activity'; data: unknown }
  /** The events stream dropped: text frames may have been missed. */
  | { type: 'lost' };

export const MAX_LIVE_CHARS = 256 * 1024;

type Frame = Record<string, unknown>;
const record = (value: unknown): value is Frame =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * One step of a page's live reply. `binding` is the command the page is waiting on now, read
 * when the event arrived, and null once it is waiting on nothing: a frame for any other
 * project, thread, command or run is dropped, and so is whatever was showing for a command the
 * page has moved on from. A missed text frame loses the preview (the durable answer replaces
 * it); tool lines keep going, since they are narration.
 */
export function stepLiveReply(
  state: LiveReply | null,
  binding: LiveBinding | null,
  event: LiveEvent,
): LiveReply | null {
  if (!binding) return null;
  const current =
    state &&
    state.projectId === binding.projectId &&
    state.threadId === binding.threadId &&
    state.requestId === binding.requestId
      ? state
      : null;
  if (event.type === 'lost')
    return current && current.position !== 'lost'
      ? { ...current, position: 'lost', text: '' }
      : current;
  const data = event.data;
  if (
    !record(data) ||
    data.projectId !== binding.projectId ||
    data.threadId !== binding.threadId ||
    data.requestId !== binding.requestId
  )
    return current;
  if (event.type === 'engine-activity') {
    if (!current || data.runId !== current.runId) return current;
    const activity = acceptActivity(current.activity, data);
    return activity === current.activity ? current : { ...current, activity };
  }
  if (data.kind === 'started') {
    // The first run to start owns the reply; a second started frame changes nothing.
    if (current || typeof data.runId !== 'string' || !data.runId) return current;
    return {
      ...binding,
      runId: data.runId,
      text: '',
      position: null,
      activity: null,
    };
  }
  if (!current || data.runId !== current.runId) return current;
  if (data.kind === 'delta') {
    const accepted = acceptPreview(current.position, { ...data, kind: 'text-delta' });
    if (accepted.kind === 'ignore') return current;
    if (accepted.kind === 'discard') return { ...current, position: 'lost', text: '' };
    const text = (current.text + accepted.text).slice(0, MAX_LIVE_CHARS);
    return { ...current, position: accepted.cursor, text };
  }
  // `ended` keeps what streamed on screen until the page reads the recorded answer.
  return current;
}
