// Diomedes Trust v1 — the shared authority result (NR-04).
//
// This module is the contract recorded in planning/DIOMEDES-TRUST-OWNERSHIP-2026-09-09.md §8.
// It is deliberately dependency-free: nothing here imports from server/ or shared/,
// so it cannot collide with runtime edits in flight elsewhere in the tree.

/** The four identity classes NR-04 requires be distinguishable. */
export type PrincipalKind = 'local-owner' | 'device' | 'session' | 'team-member';

export interface Principal {
  kind: PrincipalKind;
  /** Stable, independently revocable reference. */
  id: string;
  /** null = local-only. No tenant is a normal state, not a defect. */
  tenantId: string | null;
  /** null = account-scoped rather than project-scoped. */
  projectId: string | null;
  /** Explicit null for the prototype; set once device pairing exists. */
  deviceId: string | null;
  /** Explicit null for the prototype; set once sessions exist. */
  sessionId: string | null;
  /** Set only for 'team-member' — preserves the shape the team service uses today. */
  slotId: string | null;
}

/**
 * Revocation epochs. Revoking never requires tracking outstanding credentials:
 * bump a counter and every reference minted under the old value fails comparison.
 *
 *  - identity  advances on owner/tenant rotation and revokes everything under it
 *  - principal advances when this one principal is revoked
 */
export interface Generation {
  identity: number;
  principal: number;
}

/** How the principal proved itself. Ordered; compare with assuranceRank. */
export type Assurance =
  | 'prototype' // synthetic driver — asserts NO human or device authentication claim
  | 'loopback' // same host, no credential (today's isLoopback)
  | 'shared-secret' // bearer from team secrets (today's team member)
  | 'device-key' // paired, device-generated key
  | 'owner-local'; // the local owner at the machine

export const assuranceRank: Readonly<Record<Assurance, number>> = Object.freeze({
  prototype: 0,
  loopback: 1,
  'shared-secret': 2,
  'device-key': 3,
  'owner-local': 4,
});

/**
 * Named from the admission gates that exist today, not invented.
 * Sending and exact-write are separate grants and never imply one another.
 */
export type Capability =
  | 'work.submit' // server/work-admission.ts
  | 'work.cancel'
  | 'approval.decide' // server/approval-admission.ts — the exact-write decision
  | 'write.apply' // applying an approved write
  | 'egress.send' // NR-03 outbound provider dispatch — SENDING
  | 'egress.reconcile' // accepting a provider result back into state
  | 'team.call' // the team MCP tools
  | 'project.read'
  | 'project.admin'; // membership, token mint, revocation

export const allCapabilities: readonly Capability[] = Object.freeze([
  'work.submit',
  'work.cancel',
  'approval.decide',
  'write.apply',
  'egress.send',
  'egress.reconcile',
  'team.call',
  'project.read',
  'project.admin',
] as const);

/**
 * The resolved result. DO NOT PERSIST THIS OBJECT — persist refOf(authority).
 * Saved runs cannot restore rights; a stored Authority would be exactly that.
 */
export interface Authority {
  principal: Principal;
  generation: Generation;
  assurance: Assurance;
  capabilities: ReadonlySet<Capability>;
  /** null = non-expiring. Only the local owner is ever non-expiring. */
  expiresAt: string | null;
  /** true for the prototype driver. A production build can refuse in one check. */
  synthetic: boolean;
  resolvedAt: string;
}

export type DenialCode =
  | 'no-claim'
  | 'unknown-principal'
  | 'revoked'
  | 'generation-advanced'
  | 'expired'
  | 'insufficient-assurance'
  | 'missing-capability'
  | 'synthetic-refused'
  | 'no-resolver';

export interface Denial {
  denied: true;
  status: 401 | 403 | 409;
  code: DenialCode;
  reason: string;
}

/**
 * A pointer, not a credential. The only value safe to persist alongside a run.
 * Re-resolving it can come back denied — that is the point.
 */
export interface PrincipalRef {
  kind: PrincipalKind;
  id: string;
  tenantId: string | null;
  /** Generations captured at mint time; compared on every re-resolution. */
  mintedAt: Generation;
}

/**
 * What callers pass in. NOT an HTTP request: two of the four required resolution
 * points (after provider completion, and before a later write) run on the
 * reconciliation path where no request exists any more.
 */
export type AuthorityClaim =
  | {
      via: 'loopback-http';
      remoteAddress: string;
      projectId: string;
      headers: { authorization?: string; 'x-slot-id'?: string };
    }
  | { via: 'local-owner'; ownerId: string }
  | { via: 'stored-reference'; ref: PrincipalRef }
  | { via: 'prototype-driver'; label: string };

export function isDenial(result: Authority | Denial): result is Denial {
  return (result as Denial).denied === true;
}

export function isAuthority(result: Authority | Denial): result is Authority {
  return (result as Denial).denied !== true;
}

export function denial(status: Denial['status'], code: DenialCode, reason: string): Denial {
  return { denied: true, status, code, reason };
}
