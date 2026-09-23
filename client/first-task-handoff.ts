/**
 * What becomes of a first-task handover between the click that made it and the
 * Console that would carry it out.
 *
 * `firstTaskHandoff()` draws the offer in Settings from four facts of the
 * host's: a receipt against this binding revision, a next action of `ready`, a
 * receipt model that is still what this route is set to use, and a receipt
 * account route that is still the connection's. Those were checked once, at the
 * moment the button was drawn. Applying the answer later without asking any of
 * them again is how a route and model chosen once came to be written over
 * whatever thread happened to be selected, hours afterwards, over a run in
 * flight and over somebody's own explicit choice.
 *
 * So the offer expires, it is re-derived from a fresh reading of the host
 * before it is applied, and a thread that is running or has a choice of its own
 * is never taken: a new thread is opened instead. This function decides all of
 * that and nothing else executes it; the components only carry out the answer.
 */
import type { EngineConnection } from '../shared/engines';
import type { ExternalEngine } from '../shared/types';
import { firstTaskHandoff } from './ai-setup-state';

/**
 * How long an offer stays good. Five minutes is the span in which a person who
 * pressed Start a first task is still doing the thing they pressed it for; past
 * it, they went somewhere else, and a route quietly chosen for a thread they
 * open later is a surprise rather than a convenience.
 */
export const FIRST_TASK_TTL_MS = 5 * 60_000;

/** The offer, as it waits for a Console with a project to carry it into. */
export interface PendingFirstTask {
  readonly route: ExternalEngine;
  readonly model: string;
  readonly effort: string | null;
  /** When the person took the offer, on the app's own clock. */
  readonly madeAtMs: number;
  /** One handover, taken at most once. */
  readonly n: number;
}

/** The thread this would land in, as the Console currently sees it. */
export interface ThreadFacts {
  /** A run of this thread's task is queued, working or waiting. */
  readonly live: boolean;
  /** The Console is in the middle of a write of its own. */
  readonly busy: boolean;
  /** What this thread already asks for, which may be nobody's choice at all. */
  readonly requested: { model?: string | null; effort?: string | null; agent?: string | null } | null;
}

/** Why a thread of its own was opened rather than an existing one taken. */
export type NewThreadReason = 'no-thread' | 'thread-running' | 'thread-chosen';
/** Why the offer was let go. */
export type DropReason = 'expired' | 'route-changed' | 'unreadable';

export type FirstTaskDecision =
  | {
      readonly kind: 'apply';
      readonly route: ExternalEngine;
      readonly model: string;
      readonly effort: string | null;
    }
  | { readonly kind: 'new-thread'; readonly reason: NewThreadReason }
  | { readonly kind: 'wait' }
  | { readonly kind: 'drop'; readonly reason: DropReason; readonly sentence: string };

/**
 * What the person is told when an offer is let go, in the Console's own voice.
 * An expired offer says nothing: it was a convenience nobody was promised, and
 * a message about a button pressed five minutes ago explains nothing.
 */
const SENTENCES: Record<DropReason, string> = {
  expired: '',
  'route-changed':
    'That route changed since you chose it, so nothing was selected for this thread.',
  unreadable:
    'Nectovia could not check that route just now, so nothing was selected for this thread.',
};

const drop = (reason: DropReason): FirstTaskDecision => ({
  kind: 'drop',
  reason,
  sentence: SENTENCES[reason],
});

/**
 * The one decision, from the offer and a fresh reading of the host.
 *
 * `connection` is the row `GET /ai/status` answered with for this route, and
 * `storedModel` is what the saved settings say the route is set to use, both
 * read at this moment rather than carried from the click. `null` for the
 * connection is a host that could not be read or no longer reports this route,
 * which is not a reason to apply anything.
 */
export function decideFirstTask(input: {
  pending: PendingFirstTask;
  now: number;
  connection: EngineConnection | null;
  storedModel: string;
  thread: ThreadFacts | null;
}): FirstTaskDecision {
  const { pending, now, connection, storedModel, thread } = input;
  // Time first: an offer past its window is let go whatever else is true, so
  // nothing below can revive one by waiting.
  if (now - pending.madeAtMs >= FIRST_TASK_TTL_MS) return drop('expired');
  if (connection === null || connection.engine !== pending.route) return drop('unreadable');
  // The same four facts the offer was drawn from, asked again of what the host
  // says now. A route that has moved offers a different handoff or none, and
  // either way this one is no longer what the person was shown.
  const offer = firstTaskHandoff(connection, storedModel);
  if (!offer || offer.route !== pending.route || offer.model !== pending.model)
    return drop('route-changed');
  // A project with nothing open gets a thread to land in rather than a choice
  // with nowhere to go.
  if (thread === null) return { kind: 'new-thread', reason: 'no-thread' };
  // A write of the Console's own is in flight, so what this would be deciding
  // against is about to change. Nothing is claimed and nothing is said.
  if (thread.busy) return { kind: 'wait' };
  // Never over a run. The person watching an answer arrive did not ask for the
  // route under it to change.
  if (thread.live) return { kind: 'new-thread', reason: 'thread-running' };
  // Never over somebody's own explicit model. A thread that asks for this very
  // model is not overwritten by being confirmed, and a thread that asked for an
  // agent and no model chose no model.
  const chosen = thread.requested?.model ?? null;
  if (chosen !== null && chosen !== pending.model)
    return { kind: 'new-thread', reason: 'thread-chosen' };
  return { kind: 'apply', route: offer.route, model: offer.model, effort: pending.effort };
}
