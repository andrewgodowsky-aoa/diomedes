/**
 * Work control: three stop scopes that mean different things, and a durable
 * follow-up queue that is a command in its own right.
 *
 * Brief 02, ENG-09 and ENG-10. The existing `note` on a native session saves a
 * sentence and says plainly that it changes nothing already being prepared; it
 * stays that way. A follow-up is different: it has its own command identity,
 * its own route and source snapshot, a visible place in a queue and a visible
 * outcome, and it starts new work only through the ordinary admission path
 * with the grant the task already has. Nothing in this part is a steering
 * channel into a running provider turn. Steer, in revision 2026-09-24.1 below,
 * is offered only where a route declares one natively and the host has wired it
 * to Work runs; no provider route does yet.
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

// --- revision 2026-09-24.1: six distinct durable controls (H08) -------------------
/**
 * An additive amendment to work-control contract version 1, following the
 * convention `shared/contract-revision.ts` set: the contract version stays 1,
 * every record written under this revision names it in `contractRevision`, and a
 * record without one is read as written before it (`receiptRevision`).
 *
 * Six commands, each distinct, each with its own command identity and a receipt:
 *
 * - `steer` reaches the turn that is running now. Only a route that declares a
 *   native steering channel, wired to Work runs, is offered it. A route that
 *   would only hold the message until the turn ends is not steering; the person
 *   is offered `queue` instead, named as a queue.
 * - `queue` holds a message and sends it after the current turn or the task,
 *   through ordinary Work admission (the follow-up queue above).
 * - `stop` is the three stop scopes above, unchanged.
 * - `resume` continues a stopped run from its durable record. It re-checks the
 *   permission, inputs, route and model it would run with, and never runs with
 *   more authority than the stopped run had.
 * - `retry` is a new attempt of a failed or stopped run with the same recorded
 *   inputs, linked to the original. An effect that may already have happened and
 *   is not confirmed blocks it; nothing is sent twice on a guess.
 * - `fork` starts a new lineage (a task and its thread) from a chosen run. It
 *   refers to the origin's inputs and evidence and never copies or changes the
 *   origin's history.
 *
 * What a route can do is read from its adapter contract (`shared/adapter-contract.ts`)
 * and the drivers wired to Work runs, never from the engine's name, so the server
 * and the Console offer and refuse the same things (`workControlProfile`).
 */
export const WORK_CONTROL_REVISION = '2026-09-24.1' as const;

export const CONTROL_COMMANDS = ['steer', 'queue', 'stop', 'resume', 'retry', 'fork'] as const;
export type ControlCommand = (typeof CONTROL_COMMANDS)[number];
export function isControlCommand(value: unknown): value is ControlCommand {
  return CONTROL_COMMANDS.some((command) => command === value);
}

/**
 * The durable command family each control carries (`COMMAND_FAMILIES` in the
 * contract revision), so a control correlates with the adapter command it maps to.
 */
export const CONTROL_FAMILY = Object.freeze({
  steer: 'steer',
  queue: 'follow-up.queue',
  stop: 'stop',
  resume: 'resume',
  retry: 'retry',
  fork: 'fork',
} as const satisfies Record<ControlCommand, string>);

/**
 * What the route actually did. `applied`: done, and confirmed. `queued`: held by
 * Diomedes to be sent later. `refused`: not done, with the reason. `uncertain`:
 * asked for, and whether it took effect is not known.
 */
export type ControlOutcome = 'applied' | 'queued' | 'refused' | 'uncertain';
/** `native`: the route's own mechanism. `host`: Diomedes composes it from what the route has. */
export type ControlSupport = 'native' | 'host';

export interface ControlAvailability {
  readonly control: ControlCommand;
  /** Null when this route does not offer the control. */
  readonly support: ControlSupport | null;
  /** What the support means on this route, or why it is not offered. Never empty. */
  readonly note: string;
}

/** Which of the six controls one run's route offers, and how. */
export interface RouteControlProfile {
  readonly contractVersion: typeof WORK_CONTROL_CONTRACT_VERSION;
  readonly contractRevision: typeof WORK_CONTROL_REVISION;
  /** The Work route the run was admitted on. */
  readonly workRoute: string;
  /** The adapter contract the answer was read from; null when no contract is registered. */
  readonly contractRouteId: string | null;
  /** The engine and build the contract's evidence covers: the attribution anchor. */
  readonly engine: { readonly id: string; readonly version: string } | null;
  readonly controls: Readonly<Record<ControlCommand, ControlAvailability>>;
  /** The stop scopes this route can honour. `generation` needs an interrupt. */
  readonly stopScopes: readonly StopScope[];
}

/** Why a well-formed control was not done. Stable codes; the reason is the sentence. */
export const CONTROL_REFUSALS = [
  'unsupported',
  'not-applicable',
  'uncertain-effects',
  'permission-widened',
  'inputs-changed',
  'inputs-unrecorded',
  'model-changed',
  'consent-required',
  'admission-refused',
  'route-refused',
  'nothing-to-stop',
] as const;
export type ControlRefusalCode = (typeof CONTROL_REFUSALS)[number];

/**
 * Who performed a control. A host composition is a Diomedes application action;
 * a native one is the route's engine, named by the contract's engine identity.
 * Neither is a model's reasoning, and neither is ever rewritten later.
 */
export type ControlPerformer =
  | { readonly kind: 'diomedes' }
  | { readonly kind: 'engine'; readonly engine: string; readonly version: string };

/** The link between a run and the one it continues, retries or forks from. */
export interface ControlLineage {
  readonly kind: 'resume' | 'retry' | 'fork';
  readonly originTaskId: string;
  readonly originSessionId: string;
  /** Retry only: which attempt this is, the original being attempt 1. */
  readonly attempt?: number;
}

/**
 * One control, asked for once and answered once. Replaying the same
 * `commandId` with the same payload returns this record unchanged; the same id
 * with a different payload is refused (409). Append-only: a receipt is evidence
 * and is never rewritten or pruned (decision 10).
 */
export interface ControlReceipt {
  readonly contractVersion: typeof WORK_CONTROL_CONTRACT_VERSION;
  readonly contractRevision: typeof WORK_CONTROL_REVISION;
  readonly id: string;
  readonly commandId: string;
  readonly family: (typeof CONTROL_FAMILY)[ControlCommand];
  readonly payloadDigest: string;
  readonly control: ControlCommand;
  /** Who asked. The local person through this computer's client; never a model. */
  readonly requestedBy: { readonly actor: 'you'; readonly via: 'local-client' };
  readonly requestedAt: string;
  readonly target: {
    readonly taskId: string;
    readonly sessionId: string | null;
    readonly threadId: string | null;
  };
  /** The route answer the control was judged by, as it stood when it was asked. */
  readonly route: {
    readonly workRoute: string | null;
    readonly contractRouteId: string | null;
    readonly support: ControlSupport | null;
  };
  readonly outcome: ControlOutcome;
  /** One plain sentence: what happened. */
  readonly detail: string;
  readonly refusal: { readonly code: ControlRefusalCode; readonly reason: string } | null;
  /** Null when nothing was performed (a refusal). */
  readonly performedBy: ControlPerformer | null;
  readonly result: {
    /** The run a resume or retry started, or the run a native fork started. */
    readonly sessionId?: string;
    readonly followUpId?: string;
    readonly stop?: StopReceipt;
    readonly taskId?: string;
    readonly threadId?: string;
  };
  readonly lineage: ControlLineage | null;
  /** Effects that may have happened and are not confirmed. A retry refused for them names them. */
  readonly uncertainEffects: readonly string[];
  /** Resume and retry: the checks that were re-run, in plain words. */
  readonly revalidated: readonly string[];
  readonly settledAt: string;
}

/** Longest caller-supplied control id, so the Work command it derives stays a valid id. */
export const MAX_CONTROL_COMMAND_ID = 120;
/** Never evicted: a full project refuses new controls rather than forgetting old ones. */
export const MAX_CONTROL_RECEIPTS = 2048;

const controlCommandId = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/)
  .max(MAX_CONTROL_COMMAND_ID);
const controlBase = {
  protocolVersion: z.literal(1),
  commandId: controlCommandId,
  taskId: id,
};
export const controlRequestSchema = z.discriminatedUnion('control', [
  z.strictObject({
    ...controlBase,
    control: z.literal('steer'),
    sessionId: id,
    text: z.string().trim().min(1).max(MAX_FOLLOW_UP_CHARS),
  }),
  z.strictObject({
    ...controlBase,
    control: z.literal('queue'),
    text: z.string().trim().min(1).max(MAX_FOLLOW_UP_CHARS),
    waitsFor: z.enum(['turn', 'task']),
    route: z.string().trim().min(1).max(40),
    model: z.string().trim().min(1).max(120).nullable().default(null),
    agentId: z.string().trim().min(1).max(80).nullable().default(null),
    sources: z.array(z.string().min(1).max(1000)).max(8).default([]),
  }),
  z.strictObject({
    ...controlBase,
    control: z.literal('stop'),
    scope: z.enum(['generation', 'task', 'queued']),
    sessionId: id.nullable().default(null),
  }),
  z.strictObject({ ...controlBase, control: z.literal('resume'), sessionId: id }),
  z.strictObject({ ...controlBase, control: z.literal('retry'), sessionId: id }),
  z.strictObject({ ...controlBase, control: z.literal('fork'), sessionId: id }),
]);
export type ControlRequest = z.infer<typeof controlRequestSchema>;

/**
 * The canonical payload a control's digest is taken over: fixed keys, explicit
 * defaults, the command id itself left out. Two requests that mean the same
 * thing digest the same however their keys were ordered.
 */
export function controlPayload(request: ControlRequest): Record<string, unknown> {
  const common = { type: `control.${request.control}`, protocolVersion: 1, taskId: request.taskId };
  switch (request.control) {
    case 'steer':
      return { ...common, sessionId: request.sessionId, text: request.text };
    case 'queue':
      return {
        ...common,
        text: request.text,
        waitsFor: request.waitsFor,
        route: request.route,
        model: request.model,
        agentId: request.agentId,
        sources: [...request.sources],
      };
    case 'stop':
      return { ...common, scope: request.scope, sessionId: request.sessionId };
    default:
      return { ...common, sessionId: request.sessionId };
  }
}

/** The Work command identity a control derives for the work it starts or queues. */
export function derivedWorkCommandId(controlCommandId: string): string {
  return `${controlCommandId}:work`;
}

/** Receipts for a task: the ones aimed at it and the forks made from it, oldest first. */
export function controlReceiptsFor(
  receipts: readonly ControlReceipt[] | undefined,
  taskId: string,
): ControlReceipt[] {
  return (receipts ?? [])
    .filter((receipt) => receipt.target.taskId === taskId || receipt.result.taskId === taskId)
    .sort((a, b) => a.requestedAt.localeCompare(b.requestedAt));
}

/** A control's name as a person reads it on a button or a receipt line. */
export const CONTROL_LABELS: Readonly<Record<ControlCommand, string>> = Object.freeze({
  steer: 'Steer',
  queue: 'Queue',
  stop: 'Stop',
  resume: 'Resume',
  retry: 'Retry',
  fork: 'Fork',
});

/**
 * What a Work run was asked to do, recorded when it was admitted so a Resume or
 * a Retry can ask for exactly the same thing. The route, thread and permission
 * are already on the Session. Absent on runs admitted before 2026-09-24, which
 * are therefore neither resumed nor retried: their inputs were never kept.
 */
export interface WorkInputs {
  /** The instruction as it was sent, after the task's own description filled a blank one. */
  readonly instruction: string;
  readonly sources: readonly string[];
  readonly agentId: string | null;
  readonly mode: 'build' | 'fix';
}
