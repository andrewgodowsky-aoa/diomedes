/**
 * What one Agent hands to another, and what the receiver has to prove first.
 *
 * A Team is a composition of Agents, and the thing that composes them is this
 * envelope rather than a conversation. Everything in it is a durable identity:
 * versioned Agent ids on both sides, a named artifact from `AGENT_ARTIFACTS`,
 * the parent run it came out of, the evidence that was scoped to it, and the
 * constraints nobody resolved. A prompt string would have been easier and would
 * have made every one of those a matter of interpretation.
 *
 * The rule that shapes the file is that **a Team member list is not an access
 * control list**. Being handed something is not permission to do it, so
 * `acceptHandoff` asks the *child's own* live authority — its tenant, its
 * membership, its capabilities, whether its grant still stands — and a parent
 * that holds `write.apply` cannot lend it. Without that, delegation is a
 * permission laundry: name a second worker and the check you failed goes away.
 *
 * Three smaller constraints live here for the same reason they live together:
 * they are all about work that has stopped being one person's request.
 * Delegation is bounded, because an unbounded chain is a bill nobody approved.
 * A waiting member releases its model, because a Team that pins six runtimes
 * while five of them wait is why the interactive request is slow. And
 * interactive work is admitted before background work, always, because the
 * person is sitting there.
 *
 * What this is not: a scheduler. `admissionOrder` sorts a list. Whatever runs
 * the work still runs it — `server/harness/run-service.ts` and
 * `server/team/service.ts` keep that job.
 */
import type { AgentArtifact } from './agents.js';
import type { UnresolvedIssue } from './configuration.js';
import type { Payer } from './execution.js';
import type { MembershipState } from './workspaces.js';

export const HANDOFF_CONTRACT_VERSION = 1 as const;

/**
 * How deep a chain of delegation may go, and how wide one step may be.
 *
 * Both are small on purpose. A team that needs more than three levels is not
 * being modelled, it is recursing, and the cost of that lands on a parent
 * budget somebody approved for one job.
 */
export const MAX_DELEGATION_DEPTH = 3;
export const MAX_CHILDREN_PER_HANDOFF = 4;

/** A versioned Agent identity, as a handoff refers to one. */
export interface HandoffParty {
  readonly agentId: string;
  readonly agentVersion: string;
  readonly agentDigest: string;
}

export interface HandoffEvidence {
  readonly id: string;
  readonly artifact: AgentArtifact;
  /** One line. Never the content, which stays where it was written. */
  readonly summary: string;
}

export interface HandoffEnvelope {
  readonly v: 1;
  readonly id: string;
  /** null is local-only work. It still binds: a null tenant is not a wildcard. */
  readonly tenantId: string | null;
  readonly from: HandoffParty;
  readonly to: HandoffParty;
  readonly artifact: AgentArtifact;
  readonly parentWork: {
    readonly runId: string;
    readonly taskId: string;
    readonly summary: string;
  };
  readonly evidence: readonly HandoffEvidence[];
  readonly unresolved: readonly UnresolvedIssue[];
  readonly depth: number;
  /** Inherited from the parent. A child cannot name a different payer. */
  readonly payer: Payer;
  /** What the receiver has to hold in its own right before it may start. */
  readonly requiredAuthority: readonly string[];
  readonly createdAt: string;
}

export type OpenResult =
  | { readonly ok: true; readonly envelope: HandoffEnvelope }
  | { readonly ok: false; readonly reason: string };

/**
 * Build the envelope, or say why there is not one.
 *
 * The artifact check is the interesting one: both sides have to already declare
 * the artifact in their own definition. That is what stops a Team wiring being
 * a place where new capability appears — the composition can only use what the
 * Agents were built to produce and accept.
 */
export function openHandoff(input: {
  readonly id: string;
  readonly tenantId: string | null;
  readonly from: HandoffParty & { readonly produces: readonly AgentArtifact[] };
  readonly to: HandoffParty & { readonly accepts: readonly AgentArtifact[] };
  readonly artifact: AgentArtifact;
  readonly parentWork: HandoffEnvelope['parentWork'];
  readonly evidence: readonly HandoffEvidence[];
  readonly unresolved: readonly UnresolvedIssue[];
  readonly depth: number;
  /** How many children this step already opened. */
  readonly siblings: number;
  readonly payer: Payer;
  readonly requiredAuthority: readonly string[];
  readonly createdAt: string;
}): OpenResult {
  if (input.depth >= MAX_DELEGATION_DEPTH)
    return {
      ok: false,
      reason: `This work has already been passed on far enough. Diomedes stops after ${MAX_DELEGATION_DEPTH} steps so a job cannot keep starting more of itself.`,
    };
  if (input.siblings >= MAX_CHILDREN_PER_HANDOFF)
    return {
      ok: false,
      reason: `This step already has ${MAX_CHILDREN_PER_HANDOFF} workers, which is as many as Diomedes runs at once.`,
    };
  if (!input.from.produces.includes(input.artifact))
    return {
      ok: false,
      reason: `${input.from.agentId} does not produce ${input.artifact}, so it has nothing of that kind to hand over.`,
    };
  if (!input.to.accepts.includes(input.artifact))
    return {
      ok: false,
      reason: `${input.to.agentId} does not accept ${input.artifact}.`,
    };
  return {
    ok: true,
    envelope: {
      v: 1,
      id: input.id,
      tenantId: input.tenantId,
      from: {
        agentId: input.from.agentId,
        agentVersion: input.from.agentVersion,
        agentDigest: input.from.agentDigest,
      },
      to: {
        agentId: input.to.agentId,
        agentVersion: input.to.agentVersion,
        agentDigest: input.to.agentDigest,
      },
      artifact: input.artifact,
      parentWork: input.parentWork,
      evidence: Object.freeze([...input.evidence]),
      unresolved: Object.freeze([...input.unresolved]),
      depth: input.depth,
      payer: input.payer,
      requiredAuthority: Object.freeze([...input.requiredAuthority]),
      createdAt: input.createdAt,
    },
  };
}

export interface AcceptResult {
  readonly ok: boolean;
  readonly reason: string;
}

/**
 * Whether the receiving Agent may actually start.
 *
 * Note whose values these are. Nothing from the envelope decides this except
 * what was *required*; the tenant, membership, capabilities and grant all come
 * from the child's own live resolution. A handoff carries work, never rights.
 */
export function acceptHandoff(
  envelope: HandoffEnvelope,
  child: {
    readonly tenantId: string | null;
    readonly capabilities: readonly string[];
    readonly membershipState: MembershipState | null;
    readonly grantRevoked: boolean;
  },
): AcceptResult {
  if (child.tenantId !== envelope.tenantId)
    return {
      ok: false,
      reason:
        'This work belongs to a different business than the worker being asked to continue it. Nothing was shared.',
    };
  if (envelope.tenantId !== null && child.membershipState !== 'active')
    return {
      ok: false,
      reason: 'That worker is not running under an active membership of this business.',
    };
  if (child.grantRevoked)
    return { ok: false, reason: 'The permission this work needs has been withdrawn.' };
  const missing = envelope.requiredAuthority.filter((item) => !child.capabilities.includes(item));
  if (missing.length > 0)
    return {
      ok: false,
      reason: `This step needs ${missing.join(', ')}, which that worker does not hold. Being on the team is not permission.`,
    };
  return { ok: true, reason: 'Ready to continue.' };
}

// --- after a restart ----------------------------------------------------------

export type HandoffState = 'completed' | 'running' | 'failed';

export interface Reconciliation {
  /** Finished before the restart. Running it again would repeat real work. */
  readonly skip: readonly string[];
  readonly resume: readonly string[];
  readonly start: readonly string[];
  /** Recorded, but the replay does not mention it. Reported, never assumed done. */
  readonly missing: readonly string[];
}

/**
 * Line the durable record up against what a replay proposes.
 *
 * The point is `skip`. Replay exists so a restart can rebuild the plan, and a
 * rebuilt plan naturally proposes every step again — including the one that
 * already sent something. Anything that completed stays completed.
 */
export function reconcileAfterReplay(
  recorded: readonly { readonly handoffId: string; readonly state: HandoffState }[],
  replayed: readonly string[],
): Reconciliation {
  const byId = new Map(recorded.map((item) => [item.handoffId, item.state]));
  const seen = new Set(replayed);
  const skip: string[] = [];
  const resume: string[] = [];
  const start: string[] = [];
  for (const id of [...replayed].sort()) {
    const state = byId.get(id);
    if (state === 'completed') skip.push(id);
    else if (state === 'running' || state === 'failed') resume.push(id);
    else start.push(id);
  }
  const missing = recorded
    .filter((item) => !seen.has(item.handoffId) && item.state !== 'completed')
    .map((item) => item.handoffId)
    .sort();
  return {
    skip: Object.freeze(skip),
    resume: Object.freeze(resume),
    start: Object.freeze(start),
    missing: Object.freeze(missing),
  };
}

// --- scheduling ---------------------------------------------------------------

export interface ModelPin {
  readonly pinned: boolean;
  readonly reason: string;
}

/**
 * Whether a Team member is holding a model right now.
 *
 * A member that is waiting for a person, a sibling or an approval is not using
 * a runtime, and holding one anyway is how five idle members make the sixth
 * request slow.
 */
export function modelPin(state: 'working' | 'waiting' | 'idle'): ModelPin {
  if (state === 'working')
    return { pinned: true, reason: 'This worker is using a model right now.' };
  return {
    pinned: false,
    reason:
      state === 'waiting'
        ? 'This worker is waiting for something else, so its model was released for other work.'
        : 'This worker has nothing to do, so it is not holding a model.',
  };
}

export type WorkKind = 'interactive' | 'background';

export interface Queued {
  readonly id: string;
  readonly kind: WorkKind;
  readonly queuedAt: string;
}

/**
 * The order work is admitted in.
 *
 * Interactive first, unconditionally — a background job that has waited an hour
 * still yields to somebody who just pressed a button. Within a kind, oldest
 * first, so nothing inside a kind starves either.
 */
export function admissionOrder<T extends Queued>(items: readonly T[]): readonly T[] {
  return Object.freeze(
    [...items].sort(
      (a, b) =>
        (a.kind === b.kind ? 0 : a.kind === 'interactive' ? -1 : 1) ||
        a.queuedAt.localeCompare(b.queuedAt) ||
        a.id.localeCompare(b.id),
    ),
  );
}
