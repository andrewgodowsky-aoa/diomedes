/**
 * Work control: three stop scopes that mean different things, and a durable
 * follow-up queue that is a command in its own right.
 *
 * Brief 02, ENG-09 and ENG-10. The existing `note` on a native session saves a
 * sentence and says plainly that it changes nothing already being prepared; it
 * stays that way. A follow-up is different: it has its own command identity,
 * its own route and source snapshot, a visible place in a queue and a visible
 * outcome, and it starts new work only through the ordinary admission path
 * with the grant the task already has. Nothing here is a steering channel into
 * a running provider turn, because no supported route has proven one.
 *
 * Stop scopes:
 * - `generation` interrupts the current provider request. The session stays
 *   what it was (`waiting` for a proposal that will not now arrive, or ended),
 *   and queued follow-ups stay queued.
 * - `task` is today's Stop: the session ends `stopped`, open Needs expire, the
 *   task returns to Ready, and every follow-up queued for that task is
 *   cancelled, because delivering one would restart work the person just
 *   stopped. The receipt lists what it cancelled.
 * - `queued` cancels queued follow-ups only, and touches no live session.
 *
 * Provider work already dispatched can finish and be charged after any Stop.
 * That sentence appears on the receipt; it is not something a scope can fix.
 */
import { z } from 'zod';
import type { Route } from './types.js';

export const WORK_CONTROL_CONTRACT_VERSION = 1 as const;

export type StopScope = 'generation' | 'task' | 'queued';
export const STOP_SCOPES: readonly StopScope[] = Object.freeze(['generation', 'task', 'queued']);
export function isStopScope(value: unknown): value is StopScope {
  return STOP_SCOPES.some((scope) => scope === value);
}

/** What a Stop actually did, recorded on the task and shown in the thread. */
export interface StopReceipt {
  readonly contractVersion: typeof WORK_CONTROL_CONTRACT_VERSION;
  readonly scope: StopScope;
  readonly taskId: string;
  readonly sessionId: string | null;
  readonly at: string;
  /** True once the runtime confirmed the interrupt reached the owned process or request. */
  readonly acknowledged: boolean;
  /** Effects that may still land: provider work already sent, an unconfirmed external write. */
  readonly uncertainEffects: readonly string[];
  readonly cancelledFollowUpIds: readonly string[];
}

/** Whether a follow-up starts after the current turn or after the whole task is done. */
export type FollowUpWaitsFor = 'turn' | 'task';
export type FollowUpState = 'queued' | 'delivered' | 'cancelled' | 'rejected';

export const MAX_FOLLOW_UPS_PER_TASK = 20;
export const MAX_FOLLOW_UP_CHARS = 16_000;

/**
 * One queued follow-up. `commandId` is the Work-protocol identity the delivery
 * will use, minted when the follow-up is queued, so a reconnect, a double click
 * or a restart cannot deliver it twice. The route, model, Agent and sources are
 * a snapshot taken at queue time and shown as such; delivery re-validates them
 * against what is available then and rejects visibly rather than substituting.
 */
export interface FollowUpCommand {
  readonly id: string;
  readonly commandId: string;
  readonly taskId: string;
  /** The session that was live when it was queued, for display. Delivery does not depend on it. */
  readonly queuedDuringSessionId: string | null;
  readonly text: string;
  readonly waitsFor: FollowUpWaitsFor;
  readonly route: Route;
  readonly model: string | null;
  readonly agentId: string | null;
  readonly sources: readonly string[];
  /** Position among this task's queued follow-ups. Reorder rewrites these, nothing else. */
  readonly order: number;
  readonly queuedAt: string;
  readonly state: FollowUpState;
  readonly deliveredAt?: string;
  /** The session the delivery started. */
  readonly deliveredSessionId?: string;
  readonly cancelledAt?: string;
  readonly cancelledBy?: 'you' | `stop:${StopScope}`;
  readonly rejectedAt?: string;
  /** Why delivery could not proceed: route gone, model no longer advertised, grant expired. */
  readonly rejectedReason?: string;
}

const id = z.string().trim().min(1).max(100);

export const queueFollowUpSchema = z.strictObject({
  protocolVersion: z.literal(1),
  commandId: id,
  taskId: id,
  text: z.string().trim().min(1).max(MAX_FOLLOW_UP_CHARS),
  waitsFor: z.enum(['turn', 'task']),
  route: z.string().trim().min(1).max(40),
  model: z.string().trim().min(1).max(120).nullable().default(null),
  agentId: z.string().trim().min(1).max(80).nullable().default(null),
  sources: z.array(z.string().min(1).max(1000)).max(8).default([]),
});
export type QueueFollowUpRequest = z.infer<typeof queueFollowUpSchema>;

export const editFollowUpSchema = z.strictObject({
  text: z.string().trim().min(1).max(MAX_FOLLOW_UP_CHARS).optional(),
  waitsFor: z.enum(['turn', 'task']).optional(),
});

export const reorderFollowUpsSchema = z.strictObject({
  taskId: id,
  /** Every queued follow-up id for the task, in the new order. Missing or extra ids reject. */
  order: z.array(id).min(1).max(MAX_FOLLOW_UPS_PER_TASK),
});

export const stopSchema = z.strictObject({
  scope: z.enum(['generation', 'task', 'queued']),
  taskId: id,
  sessionId: id.nullable().default(null),
});

/** Queued follow-ups for a task, in delivery order. */
export function queuedFollowUps(
  followUps: readonly FollowUpCommand[] | undefined,
  taskId: string,
): FollowUpCommand[] {
  return (followUps ?? [])
    .filter((item) => item.taskId === taskId && item.state === 'queued')
    .sort((a, b) => a.order - b.order || a.queuedAt.localeCompare(b.queuedAt));
}

/**
 * The next follow-up that may start now. `turnEnded` is true when the session
 * the task was running just reached a terminal state; `taskDone` when the task
 * itself is done. A `turn` follow-up needs the first; a `task` follow-up needs
 * the second. Pure: the caller decides whether admission allows a start.
 */
export function nextDeliverable(
  followUps: readonly FollowUpCommand[] | undefined,
  taskId: string,
  moment: { turnEnded: boolean; taskDone: boolean },
): FollowUpCommand | null {
  for (const item of queuedFollowUps(followUps, taskId)) {
    if (item.waitsFor === 'turn' && moment.turnEnded) return item;
    if (item.waitsFor === 'task' && moment.taskDone) return item;
  }
  return null;
}

/** Plain words for the queue row. */
export function followUpWaitLabel(waitsFor: FollowUpWaitsFor): string {
  return waitsFor === 'turn' ? 'after this turn' : 'after the task is done';
}
