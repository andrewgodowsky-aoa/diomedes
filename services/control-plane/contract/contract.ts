/**
 * Control-plane contract, version 1 — the B00 seam.
 *
 * This module is the provider-neutral contract the commercial work orders
 * consume. It defines the shapes and predicates; it does not implement a
 * control plane, and nothing here contacts a provider. Every verdict is
 * derived from records the host already owns — membership, tenant binding,
 * billing status, the micro-USD rate card — and where a production predicate
 * does not exist yet the honest answer is refusal, never a defaulted grant.
 *
 * The source map below is part of the contract: it names the one existing
 * authority per domain so a later item extends them rather than growing a
 * second implementation beside them.
 *
 *   identity          → `verifySubject` here + `identitySource` in shared/workspaces.ts
 *   membership        → `assertMembership` here over shared/workspaces.ts records
 *   entitlement       → `EntitlementSnapshot` here; today only `entitlementFor`
 *                       in shared/workspaces.ts exists, and it can only say none
 *   billing status    → BillingEventProcessor in server/billing-events.ts
 *   budget semantics  → the micro-USD rate card + ledger in shared/server
 *                       managed-usage; there is no second money implementation
 *   admission         → ManagedGateway in server/managed-gateway.ts; this file
 *                       declares the same gate order so it can be tested as a
 *                       contract, and the gateway is the producer
 *   scheduler         → none. No cloud scheduler exists or is admitted.
 */
import {
  chargeKindEligibility,
  type ChargeKind,
  type MicroUsd,
  type Payer,
  type RateCard,
} from '../../../shared/managed-usage.js';
import {
  isActiveMember,
  type EntitlementView,
  type IdentitySource,
  type Membership,
  type MemberRole,
  type Organization,
} from '../../../shared/workspaces.js';
import type { PayerKind } from '../../../shared/execution.js';
import type { Generation } from '../../../server/trust/types.js';

export const CONTROL_PLANE_CONTRACT_VERSION = 1 as const;

// --- the source map ---------------------------------------------------------------

/**
 * One authority per domain. A conformance test asserts these files exist and
 * that no second implementation of the same domain is introduced beside them.
 */
export const CONTROL_PLANE_SOURCES = Object.freeze({
  /** The only selected hosted identity vendor; see vendors.ts. */
  hostedIdentityProvider: 'workos-authkit',
  /** Local identity provenance that can never produce a verified subject. */
  fixtureIdentity: 'development-fixture',
  externalSubjectMapping: 'services/control-plane/contract/contract.ts',
  membershipRecords: 'shared/workspaces.ts',
  entitlementToday: 'shared/workspaces.ts',
  billingEvents: 'server/billing-events.ts',
  /** The one local writer of allowance and reservation records. */
  allowanceWriter: 'server/managed-usage.ts',
  /** The one budget semantic: integer micro-USD against a versioned rate card. */
  budgetSemantics: 'shared/managed-usage.ts',
  managedAdmission: 'server/managed-gateway.ts',
  spendPolicy: 'services/control-plane/contract/vendors.ts',
  /** Deliberately null: managed dispatch is request-driven; nothing is scheduled. */
  scheduler: null,
} as const);

/** No cloud scheduler exists in this contract, and none may appear silently. */
export const CLOUD_SCHEDULER: null = null;

// --- verified external-subject mapping ---------------------------------------------

/**
 * The record a hosted identity flow produces when it has actually verified an
 * external subject to a local Person. `subject` is the provider's stable id —
 * an email address is never a subject, and email equality never creates one.
 */
export interface VerifiedSubjectMapping {
  readonly issuer: string;
  readonly subject: string;
  readonly personId: string;
  readonly verifiedAt: string;
  /** The Trust identity epoch at verification time; a later bump ends it. */
  readonly identityGeneration: number;
}

export type SubjectVerification =
  | { readonly verified: true; readonly mapping: VerifiedSubjectMapping }
  | { readonly verified: false; readonly reason: string };

const nonEmpty = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0;

const validGeneration = (generation: Generation): boolean =>
  Number.isSafeInteger(generation.identity) && generation.identity >= 0 &&
  Number.isSafeInteger(generation.principal) && generation.principal >= 0;

/**
 * The only way an external subject becomes verified: a hosted identity source
 * produced the claim. A development fixture fails regardless of how complete
 * the record looks, because the check reads the source and nothing else —
 * no settings field, role or stored preference participates.
 */
export function verifySubject(input: {
  readonly identitySource: IdentitySource | undefined;
  readonly issuer: unknown;
  readonly subject: unknown;
  readonly personId: unknown;
  readonly verifiedAt: unknown;
  readonly identityGeneration: unknown;
}): SubjectVerification {
  if (input.identitySource === 'development-fixture')
    return {
      verified: false,
      reason:
        'A development fixture cannot produce a verified subject; only the hosted identity flow can.',
    };
  if (input.identitySource !== 'hosted')
    return { verified: false, reason: 'The identity source is not the hosted provider.' };
  if (!nonEmpty(input.issuer) || !nonEmpty(input.subject) || !nonEmpty(input.personId))
    return { verified: false, reason: 'The hosted claim is missing issuer, subject or person.' };
  if (
    !nonEmpty(input.verifiedAt) ||
    !Number.isFinite(Date.parse(input.verifiedAt)) ||
    !Number.isSafeInteger(input.identityGeneration) ||
    (input.identityGeneration as number) < 0
  )
    return { verified: false, reason: 'The hosted claim has no usable time or generation.' };
  return {
    verified: true,
    mapping: {
      issuer: input.issuer,
      subject: input.subject,
      personId: input.personId,
      verifiedAt: input.verifiedAt,
      identityGeneration: input.identityGeneration as number,
    },
  };
}

// --- tenant-bound membership with generation ----------------------------------------

/**
 * A membership answer bound to the organization's tenant and stamped with the
 * live revocation epochs. The assertion is a snapshot: `assertionStale` is how
 * a holder learns the world moved under it.
 */
export interface MembershipAssertion {
  readonly organizationId: string;
  readonly tenantId: string;
  readonly personId: string;
  readonly role: MemberRole;
  readonly generation: Generation;
  readonly assertedAt: string;
}

export type MembershipResult =
  | { readonly asserted: true; readonly assertion: MembershipAssertion }
  | { readonly asserted: false; readonly reason: string };

/**
 * Assert membership the way admission needs it: the organization exists and is
 * tenant-bound, the membership is active and belongs to it, and the assertion
 * records the caller-supplied live generation. A fixture organization can be
 * asserted — its membership is real local state; what it can never do is
 * produce a verified external subject.
 */
export function assertMembership(input: {
  readonly organization: Organization | undefined;
  readonly membership: Membership | undefined;
  readonly generation: Generation;
  readonly at: string;
}): MembershipResult {
  const { organization, membership } = input;
  if (!Number.isFinite(Date.parse(input.at)))
    return { asserted: false, reason: 'The observation time is not readable.' };
  if (!validGeneration(input.generation))
    return { asserted: false, reason: 'The live revocation generation is invalid.' };
  if (!organization) return { asserted: false, reason: 'No such organization.' };
  if (!organization.tenantId)
    return { asserted: false, reason: 'The organization has no tenant to bind work under.' };
  if (!membership || membership.organizationId !== organization.id)
    return { asserted: false, reason: 'No membership binds this person to this organization.' };
  if (!isActiveMember(membership))
    return {
      asserted: false,
      reason: 'An invited or revoked membership is not an active membership.',
    };
  return {
    asserted: true,
    assertion: {
      organizationId: organization.id,
      tenantId: organization.tenantId,
      personId: membership.personId,
      role: membership.role,
      generation: { ...input.generation },
      assertedAt: input.at,
    },
  };
}

/**
 * Whether the world has moved since the assertion was minted. An assertion
 * minted under an older epoch is stale even though its text still reads the
 * same — the comparison is the only authority.
 */
export function assertionStale(assertion: MembershipAssertion, live: Generation): boolean {
  return (
    !validGeneration(assertion.generation) ||
    !validGeneration(live) ||
    assertion.generation.identity !== live.identity ||
    assertion.generation.principal !== live.principal
  );
}

// --- entitlement snapshot -----------------------------------------------------------

/**
 * What an entitlement service answers, when one exists. `unknown` is a real
 * state — the service could not be asked — and it refuses like `none`, never
 * silently reads as active. `revoked` and `expired` are read at observation
 * time by `snapshotAt`; a stored snapshot never updates itself.
 */
export type EntitlementState = 'none' | 'active' | 'expired' | 'revoked' | 'unknown';

export interface EntitlementSnapshot {
  readonly state: EntitlementState;
  readonly planId: string | null;
  readonly planVersion: string | null;
  readonly issuedAt: string | null;
  readonly expiresAt: string | null;
  readonly revokedAt: string | null;
  /** Snapshot ordering. A newer revision wins; a stale one never re-grants. */
  readonly revision: number;
  readonly reason: string;
}

/** The honest answer of a build with no entitlement service. */
export const NO_ENTITLEMENT_SNAPSHOT: EntitlementSnapshot = Object.freeze({
  state: 'none',
  planId: null,
  planVersion: null,
  issuedAt: null,
  expiresAt: null,
  revokedAt: null,
  revision: 0,
  reason:
    'This installation has no entitlement service. Managed access, included usage and billing are not available here, and no local record can grant them.',
});

/**
 * Adapt today's EntitlementView, which can only express absence, into the
 * snapshot vocabulary. It always produces `none`; an adapter that claimed
 * `active` from a record the service never issued would be the bug this
 * contract exists to prevent.
 */
export function snapshotFromView(view: EntitlementView, _at?: string): EntitlementSnapshot {
  return {
    ...NO_ENTITLEMENT_SNAPSHOT,
    reason: view.reason || NO_ENTITLEMENT_SNAPSHOT.reason,
  };
}

/**
 * The state a snapshot reads at a moment: revocation first, then expiry. Both
 * are observed, not stored — a snapshot dated in the past stays as written,
 * and `snapshotAt` is how a reader asks what it means now.
 */
export function snapshotAt(snapshot: EntitlementSnapshot, at: string): EntitlementSnapshot {
  const when = Date.parse(at);
  // An unreadable clock or marker can only undo an active claim — it never
  // re-labels a recorded refusal, and it never manufactures an active one.
  const undetermined = (s: EntitlementSnapshot): EntitlementSnapshot =>
    s.state === 'active' ? { ...s, state: 'unknown' } : s;

  if (!Number.isFinite(when)) return undetermined(snapshot);

  if (snapshot.revokedAt !== null) {
    const revoked = Date.parse(snapshot.revokedAt);
    if (!Number.isFinite(revoked)) return undetermined(snapshot);
    if (revoked <= when) return { ...snapshot, state: 'revoked' };
  }
  if (snapshot.state === 'active') {
    const issued = snapshot.issuedAt ? Date.parse(snapshot.issuedAt) : Number.NaN;
    if (
      !Number.isFinite(issued) || issued > when ||
      !Number.isSafeInteger(snapshot.revision) || snapshot.revision < 0
    ) return { ...snapshot, state: 'unknown' };
    const expires = snapshot.expiresAt ? Date.parse(snapshot.expiresAt) : Number.NaN;
    if (!Number.isFinite(expires)) return { ...snapshot, state: 'unknown' };
    if (expires <= when) return { ...snapshot, state: 'expired' };
  }
  return snapshot;
}

// --- billing status the contract consumes --------------------------------------------

/** The slice of server/billing-events.ts `BillingStatus` admission needs. */
export interface BillingStatusView {
  readonly paidThrough: string | null;
  readonly suspended: boolean;
  readonly suspendedReason: string | null;
  readonly lastSequence: number;
}

// --- charge-kind eligibility -----------------------------------------------------------

/**
 * The contract's eligibility vocabulary. `unknown` is distinct from every
 * classified answer: a kind the card does not classify is not free, not zero,
 * and not admissible — it is unknown, and managed admission refuses it.
 */
export type ManagedKindEligibility = 'admitted' | 'refused' | 'separate' | 'unknown';

export function kindEligibility(
  card: RateCard | null | undefined,
  kind: ChargeKind,
): ManagedKindEligibility {
  if (!card || !(kind in card.eligibility)) return 'unknown';
  const classified = chargeKindEligibility(card, kind);
  if (classified === 'included') return 'admitted';
  if (classified === 'excluded-not-admitted') return 'refused';
  return 'separate';
}

// --- managed admission decision ---------------------------------------------------------

/**
 * The discriminated outcome of a managed request: never `success: boolean`.
 * `denied` carries a typed reason; `accepted` carries the durable reservation
 * identity; `running`, `finished`, `failed` and `uncertain` carry the
 * observation or reconciliation reference. A transport acknowledgment is none
 * of these — it proves receipt, not an outcome.
 */
export type ManagedAdmission =
  | { readonly state: 'denied'; readonly code: string; readonly reason: string }
  | {
      readonly state: 'accepted';
      readonly reservationId: string;
      readonly expiresAt: string;
    }
  | { readonly state: 'running'; readonly reservationId: string; readonly cursor: string | null }
  | {
      readonly state: 'finished';
      readonly reservationId: string;
      readonly settled: 'settled' | 'released';
    }
  | { readonly state: 'failed'; readonly reservationId: string; readonly providerFailure: string }
  | {
      readonly state: 'uncertain';
      readonly reservationId: string;
      readonly reconcileAfter: string;
    };

/** Everything the admission decision reads, supplied by the host. */
export interface AdmissionView {
  readonly member: boolean;
  readonly tenantId: string | null;
  /** True when a local-only processing policy meets a route that leaves. */
  readonly dataRouteRefused: boolean;
  /** The resolved payer, from `payerForRoute`; 'refused' is an answer, not a gap. */
  readonly payer: Payer;
  readonly payerReason?: string | null;
  readonly entitlement: EntitlementSnapshot;
  readonly billing: BillingStatusView;
  readonly kind: ChargeKind;
  readonly rateCard: RateCard | null;
  readonly at: string;
}

export type AdmissionDecision =
  | { readonly decided: 'admitted'; readonly payer: 'local' | 'byo' | 'managed' }
  | {
      readonly decided: 'refused';
      readonly payer: Payer;
      readonly code: string;
      readonly reason: string;
    };

const refuse = (code: string, reason: string, payer: Payer = 'refused'): AdmissionDecision => ({
  decided: 'refused',
  payer,
  code,
  reason,
});

/**
 * The gate order, as a pure predicate so the contract can be tested without
 * the gateway. `ManagedGateway.admit` is the producer; this is the same order
 * stated so a reviewer can attack it directly:
 *
 *   membership → tenant → data route → local/BYO pass → suspension →
 *   entitlement → charge kind → reservable (budget stays the ledger's)
 *
 * Suspension is checked only on the managed path: a suspended company account
 * cannot block a person's own BYO key, and a local route is not the managed
 * plane's business at all.
 */
export function decideAdmission(view: AdmissionView): AdmissionDecision {
  if (!view.member)
    return refuse('not_a_member', 'No active membership binds this person to this business.');
  if (!view.tenantId)
    return refuse('no_tenant', 'This business has no tenant to label its work under.');
  if (view.dataRouteRefused)
    return refuse(
      'data_route_refused',
      'This business keeps its work on its own computers, and that route sends work elsewhere.',
      view.payer,
    );
  if (view.payer === 'local') return { decided: 'admitted', payer: 'local' };
  if (view.payer === 'refused')
    return refuse('payer_refused', view.payerReason ?? 'No payer could be resolved for this work.');
  if (view.payer === 'byo') return { decided: 'admitted', payer: 'byo' };

  // Managed work only from here.
  if (view.billing.suspended)
    return refuse(
      'security_suspended',
      view.billing.suspendedReason ||
        'This business is under a security suspension. Paying an invoice does not lift it.',
      'managed',
    );
  const entitlement = snapshotAt(view.entitlement, view.at);
  if (entitlement.state === 'unknown')
    return refuse(
      'entitlement_unknown',
      'Entitlement could not be determined; managed work is refused rather than guessed.',
      'managed',
    );
  if (entitlement.state !== 'active')
    return refuse(
      'no_entitlement',
      entitlement.reason || 'No active entitlement covers managed work for this business.',
      'managed',
    );
  const kind = kindEligibility(view.rateCard, view.kind);
  if (kind === 'unknown')
    return refuse(
      'charge_kind_unknown',
      `The rate card does not classify ${view.kind}; an unclassified charge is never admitted.`,
      'managed',
    );
  if (kind === 'refused')
    return refuse(
      'charge_not_admissible',
      view.rateCard?.reason[view.kind] ?? 'This charge kind is not admitted under a managed payer.',
      'managed',
    );
  return { decided: 'admitted', payer: 'managed' };
}

// --- host-only credential handle ---------------------------------------------------------

/**
 * A lease on a host-held credential. It is data about the credential, never
 * the credential: `handle` is an opaque reference, and no token, key or secret
 * appears anywhere in the record. Usability is decided against live
 * generations at use time.
 */
export interface CredentialLease {
  readonly handle: string;
  readonly principalId: string;
  readonly tenantId: string | null;
  readonly resources: readonly string[];
  readonly scopes: readonly string[];
  /** The epochs this lease was minted under. A minted snapshot is not authority. */
  readonly generation: Generation;
  readonly expiresAt: string;
}

export function leaseUsable(
  lease: CredentialLease,
  live: Generation,
  at: string,
): { usable: boolean; reason: string } {
  if (!validGeneration(lease.generation) || !validGeneration(live))
    return { usable: false, reason: 'The lease or live revocation generation is invalid.' };
  const when = Date.parse(at);
  if (!Number.isFinite(when))
    return { usable: false, reason: 'The observation time is not readable.' };
  const expires = Date.parse(lease.expiresAt);
  if (!Number.isFinite(expires))
    return { usable: false, reason: 'This lease carries an unreadable expiry.' };
  if (expires <= when) return { usable: false, reason: 'This lease has expired.' };
  if (lease.generation.identity !== live.identity || lease.generation.principal !== live.principal)
    return {
      usable: false,
      reason: 'This lease was minted under a generation that has since been revoked.',
    };
  return { usable: true, reason: '' };
}

// --- feature availability -----------------------------------------------------------------

/**
 * Whether a feature exists, as evidence rather than pricing. `unknown` is a
 * reportable state: an availability that was never observed is not "no", and a
 * price paid is never evidence a feature works.
 */
export interface FeatureAvailability {
  readonly feature: string;
  readonly state: 'available' | 'unavailable' | 'unknown';
  readonly reason: string;
  /** What demonstrated it: a probe, a recorded run, a version pin. */
  readonly evidence: string | null;
}

export function featureAvailability(input: {
  readonly feature: string;
  readonly observed: boolean | 'unknown';
  readonly reason: string;
  readonly evidence: string | null;
}): FeatureAvailability {
  return {
    feature: input.feature,
    state:
      input.observed === 'unknown' ? 'unknown' : input.observed ? 'available' : 'unavailable',
    reason: input.reason,
    evidence: input.evidence,
  };
}

// --- payer vocabulary bridge ----------------------------------------------------------------

/**
 * The only bridge between the managed-usage payer vocabulary and the
 * execution evidence vocabulary. `refused` maps to no payer at all rather
 * than a fourth kind; a refused admission names no payer because none paid.
 */
export function payerKindFor(payer: Payer): PayerKind | null {
  switch (payer) {
    case 'managed':
      return 'organization';
    case 'byo':
      return 'bring-your-own';
    case 'local':
      return 'local-machine';
    case 'refused':
      return null;
  }
}

/** The spend-policy zero, typed as money so a bare number can never slip in. */
export type SpendAmount = MicroUsd;
