import type { ThreadSessionView } from '../../shared/session-controls';

/**
 * What the Console says about a thread's open native conversation (H03), from the server's
 * read and nothing else. Pure, so the words are tested without a page.
 */
export interface SessionLine {
  /** A short state word, or null when there is nothing to say (a session not started yet). */
  state: string | null;
  /** The record's own reason, shown only where the state alone would not be enough. */
  detail: string | null;
  /** The engine and the model it reported: who answers here (decision 8). */
  attribution: string | null;
  tone: 'quiet' | 'warn';
}

const ENGINE_NAMES: Record<string, string> = { 'claude-code': 'Claude Code', opencode: 'OpenCode' };

export function sessionLine(view: ThreadSessionView | null): SessionLine | null {
  if (!view?.controls) return null;
  const engine = ENGINE_NAMES[view.controls.engine.id] ?? view.controls.engine.id;
  // Only a model the engine itself reported is named; a requested alias is not attribution.
  const attribution = view.reportedModel ? `${engine} · ${view.reportedModel}` : engine;
  const continuity = view.continuity;
  if (!continuity || continuity.state === 'new') return { state: null, detail: null, attribution, tone: 'quiet' };
  if (continuity.state === 'live') return { state: 'Live session', detail: null, attribution, tone: 'quiet' };
  if (continuity.state === 'resumable')
    return {
      state: view.controls.resume ? 'Resumes on your next message' : 'Not running',
      detail: null,
      attribution,
      tone: 'quiet',
    };
  // The state word says "Couldn't resume"; the record's reason follows it without saying it again.
  const detail = continuity.detail.replace(/^Couldn't resume\.\s*/, '') || null;
  return { state: "Couldn't resume", detail, attribution, tone: 'warn' };
}

/** Whether a message may be queued behind the answer now running. Only where the route queues. */
export function canQueue(view: ThreadSessionView | null, answering: boolean): boolean {
  return view?.controls?.steer === 'queued' && (answering || view.busy);
}

/** One queued message as the list under the composer shows it. */
export function queuedLabel(item: ThreadSessionView['queued'][number]): string {
  if (item.state === 'pending') return 'Queued: sent when the current answer finishes';
  if (item.state === 'delivered') return 'Sent';
  return item.detail;
}
