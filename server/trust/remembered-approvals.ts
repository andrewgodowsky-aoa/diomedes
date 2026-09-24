/**
 * Remembered approvals (work order D5): the exact-pattern grant, the approval
 * tally that makes a learned offer, and the offer's remembered answer.
 *
 * This is the scope-grant model generalised, not a second one. It shares the
 * version 2 task scope's rules: a grant is the person's explicit act, it is
 * recorded as evidence in History, it is revoked by advancing a generation
 * that nothing moves back, it is validated strictly at load and fails closed,
 * and every action it covers is evidenced against the exact grant it matched.
 * Owned by `ScopeGrants` (`scope-grants.ts`), which is how the Store reaches it.
 *
 * What it never does:
 * - create a grant without the person's click. Repeated approvals only count,
 *   and a count only ever produces an offer;
 * - widen a grant. Coverage is digest equality over the whole pattern;
 * - revive a grant. Revocation is final; remembering again is a new grant from
 *   a new click;
 * - cover or offer anything the classifier says always asks.
 */
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Need, ProjectState } from '../../shared/types.js';
import type {
  ApprovalPattern,
  PatternGrant,
  PatternGrantAuthority,
  PatternGrantRecord,
  PatternGrantView,
  RememberOffer,
  RememberRoute,
  RememberedApprovals as Ledger,
  RememberedApprovalsView,
  RememberedAuthorization,
} from '../../shared/permissions.js';
import {
  classifyApproval,
  describePattern,
  intentTargets,
  REMEMBER_OFFER_THRESHOLD,
  rememberedAttribution,
} from '../../shared/remembered-approvals.js';
import type { StepIntent } from '../../shared/harness.js';
import { digestSchema, payloadDigest } from '../command-admission.js';
import { ApiError } from '../paths.js';
import type { Store } from '../store.js';

export const MAX_PATTERN_GRANTS = 256;
export const MAX_REMEMBER_OFFERS = 256;
export const MAX_APPROVAL_TALLIES = 512;
/** Route 1 remembers the approval being given, not one given long ago. */
export const REMEMBER_WINDOW_MS = 15 * 60 * 1000;

/** What the host knows about one waiting step, right now. */
export interface ApprovalCandidate {
  pattern: ApprovalPattern;
  deletes: boolean;
  what: string;
  /** The principal a decision would be made under now; null when it is unavailable. */
  authority: {
    principalId: string;
    identityGeneration: number;
    capabilities: readonly string[];
  } | null;
}

/** Fixed key order, so a digest never depends on how a pattern was parsed. */
export function canonicalPattern(pattern: ApprovalPattern): ApprovalPattern {
  return {
    kind: 'harness-step',
    projectId: pattern.projectId,
    procedure: pattern.procedure,
    tool: pattern.tool,
    action: {
      kind: pattern.action.kind,
      permission: pattern.action.permission,
      effect: pattern.action.effect,
    },
    destination: {
      kind: pattern.destination.kind,
      targets: [...pattern.destination.targets],
    },
    connection: {
      engine: pattern.connection.engine,
      accountRoute: pattern.connection.accountRoute,
    },
  };
}
export const patternDigest = (pattern: ApprovalPattern) =>
  payloadDigest({
    type: 'remembered-approval.pattern',
    protocolVersion: 3,
    pattern: canonicalPattern(pattern),
  });
export const patternGrantDigest = (record: PatternGrantRecord) => payloadDigest(record.grant);

/**
 * The pattern a harness step would be remembered as, or null when its input
 * names a destination in a shape that cannot be read (never guessed at).
 */
export function patternForStep(input: {
  projectId: string;
  procedure: string;
  intent: StepIntent;
  engine: string;
  accountRoute: string | null;
  procedureLabel?: string;
}): Omit<ApprovalCandidate, 'authority'> | null {
  const read = intentTargets(input.intent);
  if (!read || !input.intent.permission || !input.intent.name) return null;
  const pattern = canonicalPattern({
    kind: 'harness-step',
    projectId: input.projectId,
    procedure: input.procedure,
    tool: input.intent.name,
    action: {
      kind: input.intent.kind,
      permission: input.intent.permission,
      effect: input.intent.effect,
    },
    destination: { kind: input.intent.destination, targets: read.targets },
    connection: { engine: input.engine, accountRoute: input.accountRoute },
  });
  return { pattern, deletes: read.deletes, what: describePattern(pattern, input.procedureLabel) };
}

const classify = (candidate: Pick<ApprovalCandidate, 'pattern' | 'deletes'>) =>
  classifyApproval({
    procedure: candidate.pattern.procedure,
    tool: candidate.pattern.tool,
    permission: candidate.pattern.action.permission,
    effect: candidate.pattern.action.effect,
    destination: candidate.pattern.destination.kind,
    targets: candidate.pattern.destination.targets,
    deletes: candidate.deletes,
  });

const refused = (reason: string, code = 'remember_refused') => new ApiError(409, reason, { code });
const notCovered = (reason: string) => new ApiError(403, reason, { code: 'scope_not_authorized' });

/**
 * Why a live grant does not cover a candidate it otherwise names, or null
 * when it does. A pattern that differs is never covered; this only chooses the
 * words for the re-ask.
 */
function difference(grant: ApprovalPattern, candidate: ApprovalPattern): string | null {
  const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
  if (!same(grant.destination, candidate.destination))
    return 'this goes to a destination or recipient it does not cover';
  if (!same(grant.action, candidate.action)) return 'this is a different or wider action';
  if (!same(grant.connection, candidate.connection))
    return 'the connection it acts through changed';
  return null;
}

export class RememberedApprovals {
  /**
   * Host-set, like `ScopeGrants.reviewerConfigured`: never a setting, request
   * field or preference. Changing it can make an offer appear sooner at the
   * next exact approval; it can never create a grant.
   */
  threshold = REMEMBER_OFFER_THRESHOLD;
  constructor(private readonly store: Store) {}

  private ledger(state: ProjectState): Ledger {
    state.rememberedApprovals ??= { formatVersion: 1, grants: [], tallies: [], offers: [] };
    return state.rememberedApprovals;
  }
  private active(state: ProjectState, digest: string) {
    return state.rememberedApprovals?.grants.find(
      (record) =>
        record.grant.patternDigest === digest && !record.revokedAt && record.generation === 0,
    );
  }
  private inactiveReason(record: PatternGrantRecord) {
    return record.revokedAt || record.generation !== 0
      ? 'You revoked this remembered approval. Diomedes asks each time.'
      : null;
  }

  view(projectId: string): RememberedApprovalsView {
    const ledger = this.store.state(projectId).rememberedApprovals;
    return {
      grants: (ledger?.grants ?? []).map((record): PatternGrantView => {
        const reason = this.inactiveReason(record);
        return {
          ...structuredClone(record),
          active: !reason,
          reason: reason ?? 'Covers exactly this in this project until you revoke it.',
        };
      }),
      offers: structuredClone((ledger?.offers ?? []).filter((offer) => offer.state === 'open')),
      threshold: this.threshold,
    };
  }

  /**
   * Whether a live grant covers this candidate now. `reason` is the person's
   * re-ask explanation when a remembered approval exists but does not cover
   * this; it is null when nothing was remembered for anything like it.
   */
  coverage(
    projectId: string,
    candidate: ApprovalCandidate,
  ):
    | { record: PatternGrantRecord; reason?: undefined }
    | { record?: undefined; reason: string | null } {
    const state = this.store.state(projectId);
    const grants = state.rememberedApprovals?.grants ?? [];
    if (!grants.length) return { reason: null };
    if (!classify(candidate).rememberable) return { reason: null };
    if (candidate.pattern.projectId !== state.project.id) return { reason: null };
    const digest = patternDigest(candidate.pattern);
    const record = this.active(state, digest);
    if (!record) {
      const revoked = grants.some((item) => item.grant.patternDigest === digest);
      if (revoked)
        return { reason: 'You revoked the remembered approval for this, so it needs your OK.' };
      const near = grants.find(
        (item) =>
          !this.inactiveReason(item) &&
          item.grant.pattern.procedure === candidate.pattern.procedure &&
          item.grant.pattern.tool === candidate.pattern.tool,
      );
      const why = near && difference(near.grant.pattern, candidate.pattern);
      return {
        reason: why
          ? `Your remembered approval covers “${near.grant.what}”, but ${why}, so it needs your OK.`
          : null,
      };
    }
    const authority = candidate.authority;
    if (!authority)
      return {
        reason:
          'The authority your remembered approval rested on is not available now, so this needs your OK.',
      };
    if (
      authority.principalId !== record.grant.authority.principalId ||
      authority.identityGeneration !== record.grant.authority.identityGeneration ||
      !authority.capabilities.includes(record.grant.authority.permission)
    )
      return {
        reason: 'The authority your remembered approval rested on changed, so this needs your OK.',
      };
    return { record };
  }

  /**
   * Cover an open exact Need with a live grant. The Need keeps its exact
   * identity; the evidence says a remembered approval, whose and since when,
   * decided it. Caller persists.
   */
  cover(projectId: string, need: Need, candidate: ApprovalCandidate): PatternGrantRecord | null {
    if (need.state !== 'open' || need.approvalReceipt || need.authorization || !need.approval)
      return null;
    const result = this.coverage(projectId, candidate);
    if (!result.record) {
      if (result.reason) need.authorizationBoundary = result.reason;
      return null;
    }
    const record = result.record;
    const state = this.store.state(projectId);
    const event = this.store.addEntry(state, {
      kind: 'remembered-authorized',
      actor: 'diomedes',
      approvalId: need.id,
      sessionId: need.sessionId,
      taskId: need.taskId,
      sentence: `${rememberedAttribution({ acceptedBy: record.grant.acceptedBy, acceptedAt: record.grant.createdAt })} ${record.grant.what}.`,
    });
    const authorization: RememberedAuthorization = {
      protocolVersion: 3,
      kind: 'remembered-approval',
      id: `A${randomUUID()}`,
      grantId: record.grant.id,
      grantDigest: patternGrantDigest(record),
      grantGeneration: record.generation,
      patternDigest: record.grant.patternDigest,
      projectId,
      taskId: need.taskId,
      sessionId: need.sessionId,
      approvalId: need.id,
      proposalDigest: need.approval.proposalDigest,
      actionDigest: need.approval.actionDigest,
      baseDigest: need.approval.baseDigest,
      engine: record.grant.pattern.connection.engine,
      accountRoute: record.grant.pattern.connection.accountRoute,
      acceptedBy: record.grant.acceptedBy,
      acceptedAt: record.grant.createdAt,
      route: record.grant.route,
      authorizedAt: event.time,
      eventId: event.id,
    };
    need.authorization = authorization;
    event.authorization = structuredClone(authorization);
    need.state = 'go-ahead';
    need.decidedAt = event.time;
    need.decidedFrom = 'remembered-approval';
    need.allowForTask = false;
    delete need.authorizationBoundary;
    need.execution = {
      state: 'pending',
      eventId: null,
      completedAt: null,
      reason: null,
      conflicts: [],
    };
    return record;
  }

  /**
   * Count one exact decision. A go-ahead counts toward the offer; a decline
   * starts the count again. Reaching the threshold makes one offer, once per
   * pattern, ever: an offer already made (open, accepted or declined) is never
   * made again. Caller persists. Never creates a grant.
   */
  noteDecision(
    projectId: string,
    candidate: ApprovalCandidate,
    resolution: 'go-ahead' | 'declined',
    need: Need,
  ): RememberOffer | null {
    if (!classify(candidate).rememberable) return null;
    const state = this.store.state(projectId);
    const digest = patternDigest(candidate.pattern);
    const ledger = this.ledger(state);
    let tally = ledger.tallies.find((item) => item.patternDigest === digest);
    if (!tally) {
      // A tally is a learning aid, never evidence: the oldest one is dropped
      // rather than refusing the approval it would count.
      if (ledger.tallies.length >= MAX_APPROVAL_TALLIES) {
        ledger.tallies.sort((a, b) => a.lastApprovedAt.localeCompare(b.lastApprovedAt));
        ledger.tallies.shift();
      }
      tally = { patternDigest: digest, approvals: 0, lastApprovedAt: new Date().toISOString() };
      ledger.tallies.push(tally);
    }
    if (resolution === 'declined') {
      tally.approvals = 0;
      return null;
    }
    tally.approvals += 1;
    tally.lastApprovedAt = new Date().toISOString();
    if (
      tally.approvals < this.threshold ||
      !candidate.authority ||
      this.active(state, digest) ||
      ledger.offers.some((offer) => offer.patternDigest === digest) ||
      ledger.offers.length >= MAX_REMEMBER_OFFERS
    )
      return null;
    const offer: RememberOffer = {
      id: `O${randomUUID()}`,
      patternDigest: digest,
      pattern: canonicalPattern(candidate.pattern),
      what: candidate.what,
      authority: this.authorityOf(candidate),
      approvals: tally.approvals,
      needId: need.id,
      sessionId: need.sessionId,
      taskId: need.taskId,
      offeredAt: new Date().toISOString(),
      state: 'open',
      decidedAt: null,
      eventId: null,
      grantId: null,
    };
    ledger.offers.push(offer);
    return offer;
  }

  private authorityOf(candidate: ApprovalCandidate): PatternGrantAuthority {
    if (!candidate.authority)
      throw refused('The authority this approval was given under is not available now.');
    if (!candidate.authority.capabilities.includes(candidate.pattern.action.permission))
      throw refused('The authority this approval was given under does not hold its permission.');
    return {
      principalId: candidate.authority.principalId,
      identityGeneration: candidate.authority.identityGeneration,
      permission: candidate.pattern.action.permission,
    };
  }

  private grant(
    state: ReturnType<Store['state']>,
    input: {
      route: RememberRoute;
      pattern: ApprovalPattern;
      what: string;
      authority: PatternGrantAuthority;
      basis: PatternGrant['basis'];
      taskId: string | null;
      sessionId: string | null;
    },
  ): PatternGrantRecord {
    const ledger = this.ledger(state);
    if (ledger.grants.length >= MAX_PATTERN_GRANTS)
      throw refused('This project has reached its remembered approval limit.', 'remember_capacity');
    const event = this.store.addEntry(state, {
      kind: 'remembered-approval-granted',
      actor: 'you',
      taskId: input.taskId,
      sessionId: input.sessionId,
      sentence:
        input.route === 'approve-and-remember'
          ? `You approved and remembered “${input.what}” in this project. Diomedes will not ask again for exactly this until you revoke it.`
          : `You accepted the offer to stop asking: “${input.what}” is remembered in this project until you revoke it.`,
    });
    const pattern = canonicalPattern(input.pattern);
    const record: PatternGrantRecord = {
      generation: 0,
      revokedAt: null,
      revokedEventId: null,
      grant: {
        protocolVersion: 3,
        kind: 'remembered-approval',
        id: `G${randomUUID()}`,
        projectId: state.project.id,
        tenantId: null,
        issuer: {
          actor: 'local-client',
          assurance: 'loopback',
          authenticated: false,
          deviceId: null,
          sessionId: null,
        },
        acceptedBy: 'you',
        route: input.route,
        pattern,
        patternDigest: patternDigest(pattern),
        what: input.what,
        authority: { ...input.authority },
        basis: { ...input.basis },
        createdAt: event.time,
        eventId: event.id,
      },
    };
    ledger.grants.push(record);
    return record;
  }

  /**
   * Route 1: "Go ahead and remember in this project". The exact approval is
   * given first and stays the evidence; this remembers its pattern. Caller
   * persists.
   */
  rememberFromNeed(
    projectId: string,
    need: Need,
    candidate: ApprovalCandidate,
  ): PatternGrantRecord {
    const state = this.store.state(projectId);
    const receipt = need.approvalReceipt;
    if (
      !need.harness ||
      !receipt ||
      receipt.decision !== 'go-ahead' ||
      receipt.actor !== 'local-client' ||
      need.state !== 'go-ahead'
    )
      throw refused('Only an approval you just gave can be remembered.');
    const classification = classify(candidate);
    if (!classification.rememberable) throw refused(classification.reason, 'always_asks');
    const digest = patternDigest(candidate.pattern);
    const existing = state.rememberedApprovals?.grants.find(
      (record) =>
        record.grant.basis.needId === need.id && record.grant.route === 'approve-and-remember',
    );
    if (existing) return structuredClone(existing);
    const live = this.active(state, digest);
    if (live) return structuredClone(live);
    if (Date.now() - Date.parse(receipt.decidedAt) > REMEMBER_WINDOW_MS)
      throw refused('Remember an approval when you give it; this one was given too long ago.');
    const tally = state.rememberedApprovals?.tallies.find((item) => item.patternDigest === digest);
    const record = this.grant(state, {
      route: 'approve-and-remember',
      pattern: candidate.pattern,
      what: candidate.what,
      authority: this.authorityOf(candidate),
      basis: { needId: need.id, offerId: null, approvals: Math.max(1, tally?.approvals ?? 1) },
      taskId: need.taskId,
      sessionId: need.sessionId,
    });
    // An open offer for the same thing is answered by this click.
    for (const offer of this.ledger(state).offers)
      if (offer.patternDigest === digest && offer.state === 'open') {
        offer.state = 'accepted';
        offer.decidedAt = record.grant.createdAt;
        offer.eventId = record.grant.eventId;
        offer.grantId = record.grant.id;
      }
    return structuredClone(record);
  }

  /** Route 2: the person accepts a learned offer. Caller persists. */
  acceptOffer(projectId: string, offerId: string): PatternGrantRecord {
    const state = this.store.state(projectId);
    const offer = state.rememberedApprovals?.offers.find((item) => item.id === offerId);
    if (!offer) throw new ApiError(404, 'This offer was not found.');
    if (offer.state === 'accepted' && offer.grantId) {
      const granted = state.rememberedApprovals!.grants.find(
        (item) => item.grant.id === offer.grantId,
      );
      if (granted) return structuredClone(granted);
    }
    if (offer.state !== 'open') throw refused('This offer was already answered.');
    const classification = classify({ pattern: offer.pattern, deletes: false });
    if (!classification.rememberable) throw refused(classification.reason, 'always_asks');
    const record =
      this.active(state, offer.patternDigest) ??
      this.grant(state, {
        route: 'learned-offer',
        pattern: offer.pattern,
        what: offer.what,
        authority: offer.authority,
        basis: { needId: offer.needId, offerId: offer.id, approvals: offer.approvals },
        taskId: offer.taskId,
        sessionId: offer.sessionId,
      });
    offer.state = 'accepted';
    offer.decidedAt = record.grant.createdAt;
    offer.eventId = record.grant.eventId;
    offer.grantId = record.grant.id;
    return structuredClone(record);
  }

  /** The declined answer is kept, so the offer does not come back. Caller persists. */
  declineOffer(projectId: string, offerId: string): RememberOffer {
    const state = this.store.state(projectId);
    const offer = state.rememberedApprovals?.offers.find((item) => item.id === offerId);
    if (!offer) throw new ApiError(404, 'This offer was not found.');
    if (offer.state === 'declined') return structuredClone(offer);
    if (offer.state !== 'open') throw refused('This offer was already answered.');
    const event = this.store.addEntry(state, {
      kind: 'remembered-approval-declined',
      actor: 'you',
      taskId: offer.taskId,
      sessionId: offer.sessionId,
      sentence: `You chose to keep being asked: “${offer.what}”. This offer will not come back.`,
    });
    offer.state = 'declined';
    offer.decidedAt = event.time;
    offer.eventId = event.id;
    return structuredClone(offer);
  }

  /** Revocation is final and recorded; nothing moves the generation back. Caller persists. */
  revoke(projectId: string, grantId: string): PatternGrantRecord {
    const state = this.store.state(projectId);
    const record = state.rememberedApprovals?.grants.find((item) => item.grant.id === grantId);
    if (!record) throw new ApiError(404, 'This remembered approval was not found.');
    if (!record.revokedAt) {
      const event = this.store.addEntry(state, {
        kind: 'remembered-approval-revoked',
        actor: 'you',
        sentence: `You revoked the remembered approval for “${record.grant.what}”. Diomedes asks each time from now on.`,
      });
      record.revokedAt = event.time;
      record.generation += 1;
      record.revokedEventId = event.id;
    }
    return structuredClone(record);
  }

  /** Write-time check: the grant that covered this Need is still the live one. */
  assertCurrent(projectId: string, need: Need) {
    const state = this.store.state(projectId);
    validateRememberedAuthorization(state, need);
    const evidence = need.authorization as RememberedAuthorization;
    const record = state.rememberedApprovals?.grants.find(
      (item) => item.grant.id === evidence.grantId,
    );
    if (!record || record.generation !== evidence.grantGeneration || record.revokedAt)
      throw notCovered('This remembered approval was revoked before the write.');
  }
}

/* ------------------------------------------------------------------------- */
/* Strict persisted shapes: unknown versions or widened fields fail closed.   */

const id = z.string().min(1).max(100);
const time = z
  .string()
  .max(40)
  .refine((value) => Number.isFinite(Date.parse(value)));
const patternSchema = z.strictObject({
  kind: z.literal('harness-step'),
  projectId: id,
  procedure: z.string().min(1).max(120),
  tool: z.string().min(1).max(120),
  action: z.strictObject({
    kind: z.enum(['model', 'tool', 'transform', 'approval', 'wait']),
    permission: z.string().min(1).max(120),
    effect: z.enum(['pure', 'read', 'idempotent', 'non-idempotent']),
  }),
  destination: z.strictObject({
    kind: z.enum(['local', 'external']),
    targets: z.array(z.string().min(1).max(1000)).min(1).max(32),
  }),
  connection: z.strictObject({
    engine: z.string().min(1).max(120),
    accountRoute: z.string().min(1).max(120).nullable(),
  }),
});
const authoritySchema = z.strictObject({
  principalId: z.string().min(1).max(200),
  identityGeneration: z.number().int().min(0),
  permission: z.string().min(1).max(120),
});
const routeSchema = z.enum(['approve-and-remember', 'learned-offer']);
const grantSchema = z.strictObject({
  protocolVersion: z.literal(3),
  kind: z.literal('remembered-approval'),
  id,
  projectId: id,
  tenantId: z.null(),
  issuer: z.strictObject({
    actor: z.literal('local-client'),
    assurance: z.literal('loopback'),
    authenticated: z.literal(false),
    deviceId: z.null(),
    sessionId: z.null(),
  }),
  acceptedBy: z.literal('you'),
  route: routeSchema,
  pattern: patternSchema,
  patternDigest: digestSchema,
  what: z.string().min(1).max(2000),
  authority: authoritySchema,
  basis: z.strictObject({
    needId: id.nullable(),
    offerId: id.nullable(),
    approvals: z.number().int().min(1).max(1_000_000),
  }),
  createdAt: time,
  eventId: id,
});
const recordSchema = z.strictObject({
  grant: grantSchema,
  generation: z.number().int().min(0).max(1_000_000),
  revokedAt: time.nullable(),
  revokedEventId: id.nullable(),
});
const tallySchema = z.strictObject({
  patternDigest: digestSchema,
  approvals: z.number().int().min(0).max(1_000_000),
  lastApprovedAt: time,
});
const offerSchema = z.strictObject({
  id,
  patternDigest: digestSchema,
  pattern: patternSchema,
  what: z.string().min(1).max(2000),
  authority: authoritySchema,
  approvals: z.number().int().min(1).max(1_000_000),
  needId: id,
  sessionId: id,
  taskId: id,
  offeredAt: time,
  state: z.enum(['open', 'accepted', 'declined']),
  decidedAt: time.nullable(),
  eventId: id.nullable(),
  grantId: id.nullable(),
});
const ledgerSchema = z.strictObject({
  formatVersion: z.literal(1),
  grants: z.array(recordSchema).max(MAX_PATTERN_GRANTS),
  tallies: z.array(tallySchema).max(MAX_APPROVAL_TALLIES),
  offers: z.array(offerSchema).max(MAX_REMEMBER_OFFERS),
});
const authorizationSchema = z.strictObject({
  protocolVersion: z.literal(3),
  kind: z.literal('remembered-approval'),
  id,
  grantId: id,
  grantDigest: digestSchema,
  grantGeneration: z.literal(0),
  patternDigest: digestSchema,
  projectId: id,
  taskId: id,
  sessionId: id,
  approvalId: id,
  proposalDigest: digestSchema,
  actionDigest: z.union([digestSchema, z.string().regex(/^[a-f0-9]{64}$/)]),
  baseDigest: digestSchema,
  engine: z.string().min(1).max(120),
  accountRoute: z.string().min(1).max(120).nullable(),
  acceptedBy: z.literal('you'),
  acceptedAt: time,
  route: routeSchema,
  authorizedAt: time,
  eventId: id,
});
const executionSchema = z.strictObject({
  state: z.enum(['pending', 'applied', 'conflicted', 'not-applied']),
  eventId: id.nullable(),
  completedAt: time.nullable(),
  reason: z.string().nullable(),
  conflicts: z.array(z.string().min(1).max(1000)).max(8),
});

/**
 * Validate the saved ledger at load and recovery. Anything unknown, widened or
 * inconsistent fails closed; the saved state is never rewritten, trimmed or
 * broadened here. An absent ledger is a project from before this feature.
 */
export function validateRememberedApprovals(state: ProjectState) {
  const ledger = state.rememberedApprovals;
  if (ledger === undefined) return;
  const incompatible = () => {
    throw new Error(
      'A saved remembered approval is incompatible or inconsistent. Project state was not rewritten.',
    );
  };
  const parsed = ledgerSchema.safeParse(ledger);
  if (!parsed.success) throw incompatible();
  const events = new Map(state.history.map((entry) => [entry.id, entry]));
  const ids = new Set<string>();
  const live = new Set<string>();
  for (const record of parsed.data.grants) {
    const grant = record.grant;
    if (ids.has(grant.id)) throw incompatible();
    ids.add(grant.id);
    if (grant.projectId !== state.project.id || grant.pattern.projectId !== state.project.id)
      throw incompatible();
    if (patternDigest(grant.pattern) !== grant.patternDigest) throw incompatible();
    // A saved grant for something that always asks is not a grant.
    if (!classify({ pattern: grant.pattern, deletes: false }).rememberable) throw incompatible();
    if (grant.authority.permission !== grant.pattern.action.permission) throw incompatible();
    if ((grant.route === 'learned-offer') !== (grant.basis.offerId !== null)) throw incompatible();
    if (grant.route === 'approve-and-remember' && grant.basis.needId === null) throw incompatible();
    const revoked = record.revokedAt !== null;
    if ((record.generation === 0) === revoked) throw incompatible();
    if (revoked !== (record.revokedEventId !== null)) throw incompatible();
    if (revoked && Date.parse(record.revokedAt!) < Date.parse(grant.createdAt))
      throw incompatible();
    const granted = events.get(grant.eventId);
    if (
      !granted ||
      granted.kind !== 'remembered-approval-granted' ||
      granted.time !== grant.createdAt
    )
      throw incompatible();
    if (revoked) {
      const revocation = events.get(record.revokedEventId!);
      if (!revocation || revocation.kind !== 'remembered-approval-revoked') throw incompatible();
    } else {
      if (live.has(grant.patternDigest)) throw incompatible();
      live.add(grant.patternDigest);
    }
  }
  const offers = new Set<string>();
  for (const offer of parsed.data.offers) {
    if (ids.has(offer.id) || offers.has(offer.id)) throw incompatible();
    offers.add(offer.id);
    if (offer.pattern.projectId !== state.project.id) throw incompatible();
    if (patternDigest(offer.pattern) !== offer.patternDigest) throw incompatible();
    if ((offer.state === 'open') !== (offer.decidedAt === null)) throw incompatible();
    if ((offer.state === 'open') !== (offer.eventId === null)) throw incompatible();
    if ((offer.state === 'accepted') !== (offer.grantId !== null)) throw incompatible();
    if (offer.grantId !== null && !ids.has(offer.grantId)) throw incompatible();
  }
  if (new Set(parsed.data.offers.map((offer) => offer.patternDigest)).size !== offers.size)
    throw incompatible();
  if (
    new Set(parsed.data.tallies.map((tally) => tally.patternDigest)).size !==
    parsed.data.tallies.length
  )
    throw incompatible();
}

/** Validates the evidence a remembered approval left on a Need, without reviving it. */
export function validateRememberedAuthorization(state: ProjectState, need: Need) {
  const evidence = need.authorization as RememberedAuthorization | undefined;
  const fail = () => {
    throw new Error('A saved remembered authorization is inconsistent. No write was dispatched.');
  };
  if (!evidence || !authorizationSchema.safeParse(evidence).success) return fail();
  const record = state.rememberedApprovals?.grants.find(
    (item) => item.grant.id === evidence.grantId,
  );
  if (!record || !recordSchema.safeParse(record).success) return fail();
  const event = state.history.find((item) => item.id === evidence.eventId);
  const session = state.sessions.find((item) => item.id === need.sessionId);
  if (
    !need.approval ||
    !need.harness ||
    need.approvalReceipt ||
    need.allowForTask ||
    need.reviews?.length ||
    !executionSchema.safeParse(need.execution).success ||
    evidence.grantDigest !== patternGrantDigest(record) ||
    evidence.patternDigest !== record.grant.patternDigest ||
    evidence.projectId !== state.project.id ||
    evidence.taskId !== need.taskId ||
    evidence.sessionId !== need.sessionId ||
    evidence.approvalId !== need.id ||
    evidence.engine !== record.grant.pattern.connection.engine ||
    evidence.accountRoute !== record.grant.pattern.connection.accountRoute ||
    evidence.acceptedBy !== record.grant.acceptedBy ||
    evidence.acceptedAt !== record.grant.createdAt ||
    evidence.route !== record.grant.route ||
    session?.taskId !== need.taskId ||
    session.sample ||
    need.state !== 'go-ahead' ||
    evidence.authorizedAt !== need.decidedAt ||
    Date.parse(evidence.authorizedAt) < Date.parse(record.grant.createdAt) ||
    (record.revokedAt !== null &&
      Date.parse(evidence.authorizedAt) > Date.parse(record.revokedAt)) ||
    event?.kind !== 'remembered-authorized' ||
    event.approvalId !== need.id ||
    event.time !== evidence.authorizedAt ||
    JSON.stringify(event.authorization) !== JSON.stringify(evidence) ||
    (['proposalDigest', 'actionDigest', 'baseDigest'] as const).some(
      (key) => evidence[key] !== need.approval![key],
    )
  )
    return fail();
  const execution = need.execution!;
  if (
    (execution.state === 'pending') !== (execution.completedAt === null) ||
    (execution.state === 'applied' || execution.state === 'conflicted') !==
      (execution.eventId !== null)
  )
    return fail();
  if (execution.eventId !== null) {
    const write = state.history.find((entry) => entry.id === execution.eventId);
    if (
      !write ||
      write.approvalId !== need.id ||
      JSON.stringify(write.authorization) !== JSON.stringify(evidence)
    )
      return fail();
  }
}

/**
 * A prepared state image cannot undo what the person decided after it was
 * prepared: a revocation or an offer's answer is carried onto the image that
 * recovery persists, with the History entry that records it.
 */
export function carryRememberedDecisions(prepared: ProjectState, current: ProjectState) {
  const now = current.rememberedApprovals;
  const image = prepared.rememberedApprovals;
  if (!now || !image) return;
  const carryEvent = (eventId: string | null) => {
    if (!eventId || prepared.history.some((entry) => entry.id === eventId)) return;
    const entry = current.history.find((item) => item.id === eventId);
    if (entry) prepared.history.push(structuredClone(entry));
  };
  for (const record of image.grants) {
    const latest = now.grants.find((item) => item.grant.id === record.grant.id);
    if (latest && latest.generation > record.generation) {
      record.generation = latest.generation;
      record.revokedAt = latest.revokedAt;
      record.revokedEventId = latest.revokedEventId;
      carryEvent(latest.revokedEventId);
    }
  }
  for (const offer of image.offers) {
    const latest = now.offers.find((item) => item.id === offer.id);
    if (latest && offer.state === 'open' && latest.state === 'declined') {
      offer.state = latest.state;
      offer.decidedAt = latest.decidedAt;
      offer.eventId = latest.eventId;
      carryEvent(latest.eventId);
    }
  }
}
