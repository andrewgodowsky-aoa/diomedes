// Diomedes Trust v1 — revocation by epoch (NR-04).
//
// Revocation never requires enumerating outstanding credentials. Every principal
// carries two counters; bumping either invalidates each PrincipalRef minted under
// the old value at its next re-resolution.
//
// STORAGE: in-memory for this checkpoint, deliberately. Persistence belongs with
// the production resolver and would mean editing server/store.ts, where Codex has
// an announced edit in flight (harness-session exclusion). Keeping Trust
// self-contained here means neither of us waits on the other. The registry API
// below does not change when persistence lands behind it.

import type { Generation, Principal, PrincipalKind } from './types.js';

const identityGenerations = new Map<string, number>();
const principalGenerations = new Map<string, number>();
const revoked = new Set<string>();
const revocationReasons = new Map<string, string>();

const LOCAL_TENANT = '@local';

function tenantKey(tenantId: string | null): string {
  return tenantId ?? LOCAL_TENANT;
}

function principalKey(kind: PrincipalKind, id: string): string {
  return `${kind}:${id}`;
}

/** The live generation pair for a principal. Never cached by callers. */
export function generationFor(principal: Pick<Principal, 'kind' | 'id' | 'tenantId'>): Generation {
  return {
    identity: identityGenerations.get(tenantKey(principal.tenantId)) ?? 0,
    principal: principalGenerations.get(principalKey(principal.kind, principal.id)) ?? 0,
  };
}

/** Revoke one principal. Bumps only its own counter; siblings are unaffected. */
export async function revoke(
  ref: { kind: PrincipalKind; id: string },
  reason: string,
): Promise<void> {
  const key = principalKey(ref.kind, ref.id);
  principalGenerations.set(key, (principalGenerations.get(key) ?? 0) + 1);
  revoked.add(key);
  revocationReasons.set(key, reason);
}

/**
 * Revoke every principal under a tenant at once.
 *
 * A null tenantId targets the local tenant. This never invalidates the local
 * owner: the owner is re-resolved from the host, not from a stored reference,
 * so an identity bump cannot lock the machine's operator out of their own
 * install. Revoking a device must never cost the owner their access.
 */
export async function revokeTenant(tenantId: string | null, _reason: string): Promise<void> {
  const key = tenantKey(tenantId);
  identityGenerations.set(key, (identityGenerations.get(key) ?? 0) + 1);
}

export async function isRevoked(principal: Principal): Promise<boolean> {
  if (principal.kind === 'local-owner') return false;
  return revoked.has(principalKey(principal.kind, principal.id));
}

export function revocationReason(ref: { kind: PrincipalKind; id: string }): string | null {
  return revocationReasons.get(principalKey(ref.kind, ref.id)) ?? null;
}

/** Lift a revocation. Generations are NOT rolled back — old refs stay dead. */
export async function reinstate(ref: { kind: PrincipalKind; id: string }): Promise<void> {
  const key = principalKey(ref.kind, ref.id);
  revoked.delete(key);
  revocationReasons.delete(key);
}

/** Test seam. Not part of the consumer contract. */
export function __resetRevocationState(): void {
  identityGenerations.clear();
  principalGenerations.clear();
  revoked.clear();
  revocationReasons.clear();
}
