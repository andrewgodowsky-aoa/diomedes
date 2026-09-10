import {
  fullAccessEligibility,
  type FullAccessEligibility,
  type IsolatedEnvironment,
} from './capabilities.js';

/**
 * Reviewer routing is a separate axis from access scope.
 *
 * `review: 'human'` means anything this scope does not already cover goes to
 * the person. `review: 'model-reviewer'` adds a bounded reviewer that must
 * approve each in-scope change set *before* the scope is used. The reviewer is
 * a gate on authority the person already granted, never a source of authority:
 * it can withhold, and nothing else. A reviewer that approves everything is
 * therefore exactly as powerful as `review: 'human'` is today, which is the
 * whole point of the bound.
 */
export type ReviewRouting = 'human' | 'model-reviewer';
/** The deterministic policy whose result a reviewer decision is recorded against. */
export const SCOPE_POLICY_VERSION = 'scope-grant-v2';
export const REVIEWER_PROTOCOL_VERSION = 3;
/** Host constants, recorded on every decision so an audit does not have to guess. */
export const REVIEWER_TIMEOUT_MS = 90_000;
export const REVIEWER_DECISION_TTL_MS = 10 * 60 * 1000;
export const REVIEWER_MAX_ATTEMPTS = 1;
export const REVIEWER_MAX_NOTE = 600;
export const REVIEWER_MAX_EXCERPT_BYTES = 24_000;
export const REVIEWER_MAX_RECORDS_PER_NEED = 4;

/**
 * Chosen by the person when they confirm the scope. A model never sets this.
 *
 * The reviewer is a Diomedes Agent execution: `agentId` names the worker
 * identity and the model that runs it is a separate field, so the same
 * `Code Reviewer` can be executed by any compatible model. The Agent's name,
 * version, digest and role are pinned here at consent time on purpose: editing
 * a project's Agent file afterwards must not change what an existing grant's
 * reviewer was told, or which identity it was.
 */
export interface ReviewerRoute {
  readonly engine: 'codex';
  readonly agentId: string;
  readonly agentVersion: string;
  readonly agentName: string;
  readonly agentDigest: string;
  readonly agentRole: string;
  /** What the person asked for. The runtime-reported identity is recorded separately. */
  readonly requestedModel: string | null;
  /** Reviewer calls this grant may spend in total. */
  readonly maxReviews: number;
  /** Explicit consent for the reviewer's own provider inference, bounded above. */
  readonly inferenceConsent: 'reviewer-only';
}

/** Version 2 adds scoped authority; exact approval protocol version 1 is unchanged. */
export interface TaskScopeGrant {
  readonly protocolVersion: 2;
  readonly id: string;
  readonly commandId: string;
  readonly payloadDigest: string;
  readonly projectId: string;
  readonly taskId: string;
  readonly tenantId: null;
  readonly issuer: {
    readonly actor: 'local-client';
    readonly assurance: 'loopback';
    readonly authenticated: false;
    readonly deviceId: null;
    readonly sessionId: null;
  };
  readonly hostLease: string;
  readonly projectFolder: string;
  readonly roots: readonly string[];
  readonly operations: readonly ('text.create' | 'text.modify')[];
  readonly engine: 'codex';
  readonly accountRoute: 'codex:chatgpt';
  readonly review: ReviewRouting;
  /** Present only when `review` is `model-reviewer`. */
  readonly reviewer?: ReviewerRoute;
  readonly budget: {
    readonly maxWrites: number;
    readonly maxBytes: number;
    readonly providerInference: 'separate-consent';
  };
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly eventId: string;
}
export interface ScopeGrantRecord {
  grant: TaskScopeGrant;
  generation: number;
  revokedAt: string | null;
}
export interface ScopeGrantView extends ScopeGrantRecord {
  active: boolean;
  reason: string;
}
export interface ScopeGrantCommand {
  protocolVersion: 2;
  commandId: string;
  taskId: string;
  roots: string[];
  operations: ('text.create' | 'text.modify')[];
  engine: 'codex';
  accountRoute: 'codex:chatgpt';
  maxWrites: number;
  maxBytes: number;
  ttlMinutes: number;
  review: ReviewRouting;
  reviewer?: { agentId?: string; requestedModel: string | null; maxReviews: number };
}
/** A deterministic authorization, never a synthetic human exact-approval receipt. */
export interface ScopedAuthorization {
  readonly protocolVersion: 2;
  readonly kind: 'scope-grant';
  readonly id: string;
  readonly grantId: string;
  readonly grantDigest: string;
  readonly grantGeneration: number;
  readonly projectId: string;
  readonly taskId: string;
  readonly sessionId: string;
  readonly approvalId: string;
  readonly proposalDigest: string;
  readonly actionDigest: string;
  readonly baseDigest: string;
  readonly engine: string;
  readonly accountRoute: string;
  readonly writes: number;
  readonly bytes: number;
  readonly authorizedAt: string;
  readonly eventId: string;
  /**
   * The reviewer decision that had to pass before this authorization existed.
   * Absent means deterministic scope alone authorized it, with no reviewer in
   * the path. It never means a person inspected this output.
   */
  readonly reviewId?: string;
}

/** What a reviewer is allowed to return. Prose is never authority. */
export type ReviewerVerdict = 'approve' | 'require-human' | 'reject';
export type ReviewerOutcome = ReviewerVerdict | 'error';
export type ReviewerReasonCode =
  | 'matches-request'
  | 'outside-request'
  | 'needs-judgement'
  | 'unsafe-content'
  | 'insufficient-context'
  | 'malformed-response'
  | 'timeout'
  | 'unavailable'
  | 'budget-exhausted'
  | 'contradictory-response'
  | 'cancelled';

/**
 * A durable reviewer record. It is written before an approved write proceeds
 * and is never relabelled. `decisionSource` is `model-reviewer` and nothing
 * else: this record must never be presentable as a person's decision.
 */
export interface ReviewerDecision {
  readonly protocolVersion: 3;
  readonly kind: 'model-review';
  readonly id: string;
  readonly decisionSource: 'model-reviewer';
  readonly grantId: string;
  readonly grantDigest: string;
  readonly grantGeneration: number;
  readonly projectId: string;
  readonly taskId: string;
  readonly sessionId: string;
  readonly approvalId: string;
  readonly proposalDigest: string;
  readonly actionDigest: string;
  readonly baseDigest: string;
  /** Reviewer invocation identity, distinct from the proposing run in every case. */
  readonly invocationId: string;
  /** Engine-reported thread or run identity for the reviewer call, when it reports one. */
  readonly runId: string | null;
  readonly engine: string;
  /** Which Agent identity reviewed, independently of the model that ran it. */
  readonly agent: {
    readonly id: string;
    readonly version: string;
    readonly name: string;
    readonly digest: string;
  };
  readonly requestedModel: string | null;
  readonly reportedModel: string | null;
  readonly modelSource: 'runtime' | 'not-recorded';
  /** The independence actually achieved, never more than the code can prove. */
  readonly independence: 'separate-invocation' | 'separate-invocation-and-model';
  /** The proposing model this reviewer was separate *from*, for comparison. */
  readonly proposerReportedModel: string | null;
  readonly policy: {
    readonly version: string;
    readonly result: 'in-scope';
    readonly detail: string;
  };
  readonly decision: ReviewerOutcome;
  readonly reasonCode: ReviewerReasonCode;
  /** Bounded reviewer text, scrubbed. Never parsed for authority. */
  readonly note: string | null;
  readonly attempt: number;
  readonly timeoutMs: number;
  readonly requestedAt: string;
  readonly decidedAt: string;
  readonly expiresAt: string;
  readonly eventId: string;
}

/** What the reviewer sees. Assembled by the host from validated data only. */
export interface ReviewPacket {
  readonly protocolVersion: 3;
  readonly projectName: string;
  readonly taskName: string;
  readonly instruction: string;
  readonly operation: 'text.create' | 'text.modify' | 'text.create+modify';
  readonly destinations: readonly string[];
  readonly actionDigest: string;
  readonly baseDigest: string;
  readonly proposalDigest: string;
  readonly scope: {
    readonly roots: readonly string[];
    readonly operations: readonly string[];
    readonly writesRemaining: number;
    readonly bytesRemaining: number;
    readonly expiresAt: string;
  };
  readonly policy: { readonly version: string; readonly result: 'in-scope'; readonly detail: string };
  readonly standingConstraints: readonly string[];
  readonly summary: string;
  readonly changes: readonly {
    readonly path: string;
    readonly op: 'created' | 'modified';
    readonly summary: string;
    readonly beforeExcerpt: string | null;
    readonly afterExcerpt: string;
    readonly truncated: boolean;
  }[];
}

export const PERMISSION_CHOICES = ['review', 'project', 'auto-review', 'full'] as const;
export type PermissionChoiceId = (typeof PERMISSION_CHOICES)[number];
export interface PermissionChoice {
  readonly id: PermissionChoiceId;
  readonly name: string;
  readonly available: boolean;
  readonly detail: string;
  /** Why it is unavailable, in the person's words. Empty when available. */
  readonly unavailableReason: string;
  readonly points: readonly string[];
}
export interface PermissionCapabilityView {
  readonly routeId: string;
  readonly choices: readonly PermissionChoice[];
  readonly fullAccess: FullAccessEligibility;
  readonly environments: readonly { readonly id: string; readonly name: string }[];
  readonly noEnvironmentReason: string;
  readonly reviewer: {
    readonly available: boolean;
    readonly engine: string;
    readonly agentId: string;
    readonly agentName: string;
    readonly reason: string;
    readonly models: readonly string[];
    readonly independence: string;
    readonly maxReviews: number;
    readonly timeoutMs: number;
  };
}

/**
 * The four conceptual choices, with availability driven by capability rather
 * than optimism. `describePermissionChoices` is the only place that decides
 * whether an option may be offered, so the Console cannot present one the host
 * would refuse.
 */
export function describePermissionChoices(input: {
  routeId: string;
  scopedWritesSupported: boolean;
  reviewerAvailable: boolean;
  reviewerReason: string;
  environment: IsolatedEnvironment | null;
}): { choices: PermissionChoice[]; fullAccess: FullAccessEligibility } {
  const fullAccess = fullAccessEligibility(input.routeId, input.environment);
  const scopeDetail = input.scopedWritesSupported
    ? 'Create and update supported text files for one task, inside the folders you name, until it expires or you revoke it.'
    : 'Scoped writes are available for Codex text proposals. This route has no verified boundary for them.';
  const choices: PermissionChoice[] = [
    {
      id: 'review',
      name: 'Review changes',
      available: true,
      detail: 'You see each change set and decide. Nothing is applied without your OK.',
      unavailableReason: '',
      points: [
        'Every write waits for your exact decision.',
        'Revoking a task scope returns you to this.',
      ],
    },
    {
      id: 'project',
      name: 'Work in this project',
      available: input.scopedWritesSupported,
      detail: scopeDetail,
      unavailableReason: input.scopedWritesSupported
        ? ''
        : 'This route only supports change sets you review yourself.',
      points: [
        'Text creates and updates only. No commands, deletion, installs or external destinations.',
        'Bounded by folders, file count, output bytes and an expiry, and revocable.',
        'Sending context to a provider still needs its own consent.',
      ],
    },
    {
      id: 'auto-review',
      name: 'Approve for me',
      available: input.scopedWritesSupported && input.reviewerAvailable,
      detail:
        'The same scope as Work in this project, plus a separate reviewer that must approve each change set before it is applied.',
      unavailableReason: !input.scopedWritesSupported
        ? 'This route has no scope for a reviewer to gate.'
        : input.reviewerAvailable
          ? ''
          : input.reviewerReason,
      points: [
        'A separate reviewer looks at each eligible change set. It can only hold a change back, never widen what is allowed.',
        'This does not increase file, tool, command or network permission by one byte.',
        'Anything outside the scope still comes to you.',
        'If the reviewer times out, fails or is unclear, the change set waits for you.',
        'A reviewer decision is recorded as a model decision. It is never recorded as your approval.',
      ],
    },
    {
      id: 'full',
      name: 'Full access',
      available: fullAccess.available,
      detail: fullAccess.available
        ? 'Unrestricted execution inside the named isolated environment.'
        : 'Unrestricted execution needs an isolated environment Diomedes can name, restore and revoke.',
      unavailableReason: fullAccess.available ? '' : fullAccess.summary,
      points: fullAccess.available
        ? ['Effects are confined to the named environment.']
        : [
            'Not offered: no environment on this installation has an operating-system, process or virtual-machine boundary that Diomedes owns.',
            `Never available for: ${fullAccess.unsupportedEffects.join(', ')}.`,
            'A disabled-tools flag, a prompt instruction or a git worktree is not containment.',
          ],
    },
  ];
  return { choices, fullAccess };
}
