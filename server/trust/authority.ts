// Diomedes Trust v1 — the authority resolver (NR-04).
//
// currentAuthority() is called at all four points the runtime requires:
// admission, dispatch, after provider completion, and before a later write.
// It IS the revalidation — there is no revalidate(), because a cached result
// is exactly the failure mode "saved runs cannot restore rights" forbids.

import {
  allCapabilities,
  assuranceRank,
  denial,
  isDenial,
  type Assurance,
  type Authority,
  type AuthorityClaim,
  type Capability,
  type Denial,
  type Principal,
  type PrincipalKind,
  type PrincipalRef,
} from './types.js';
import { generationFor, isRevoked } from './revocation.js';

// --- capability policy -------------------------------------------------------

/**
 * Base grants per identity class.
 *
 * A team-member is an agent slot, not the operator. It gets neither
 * approval.decide nor write.apply: the exact-write decision belongs to the
 * human, which is the same boundary server/integrations.ts:292 already draws
 * when it refuses the engine approvals, auth refresh tokens, dynamic tools and
 * external calls. It also never gets egress.send — see assertInvariants.
 */
const BASE_CAPABILITIES: Readonly<Record<PrincipalKind, readonly Capability[]>> = Object.freeze({
  'local-owner': allCapabilities,
  device: ['work.submit', 'work.cancel', 'project.read', 'egress.reconcile'],
  session: ['work.submit', 'work.cancel', 'project.read', 'egress.reconcile'],
  'team-member': ['work.submit', 'work.cancel', 'team.call', 'project.read'],
  // A prototype NEVER draws from this table. Its capabilities come only from
  // the armed grant, which lists them explicitly. The empty entry exists so the
  // Record stays exhaustive and so a table lookup can never widen a driver.
  prototype: [],
});

/**
 * Invariants that no configuration, backend or grant table may relax. These
 * throw rather than deny: reaching one means the policy table itself is wrong,
 * which is a programming error, not an authorization outcome.
 */
function assertInvariants(kind: PrincipalKind, caps: ReadonlySet<Capability>): void {
  if (kind === 'team-member' && caps.has('egress.send'))
    throw new Error(
      'Trust invariant: a team-member principal may never hold egress.send. ' +
        'No ordinary HTTP client may mint an egress grant using the client header.',
    );
  if (kind === 'team-member' && (caps.has('approval.decide') || caps.has('write.apply')))
    throw new Error(
      'Trust invariant: the exact-write decision belongs to the owner, not a team slot.',
    );
  if (kind === 'prototype' && caps.has('project.admin'))
    throw new Error('Trust invariant: a synthetic driver never administers a project.');
}

function grantsFor(kind: PrincipalKind): ReadonlySet<Capability> {
  const caps = new Set<Capability>(BASE_CAPABILITIES[kind]);
  assertInvariants(kind, caps);
  return caps;
}

// --- pluggable production backend -------------------------------------------

/**
 * The production resolver installs this. Until it does, the non-prototype claim
 * kinds return a well-formed Denial rather than throwing or granting, so call
 * sites written today do not change when the backend arrives — only what comes
 * back does.
 */
export interface TrustBackend {
  lookupTeamMember(
    projectId: string,
    slotId: string,
    token: string,
  ): Promise<Principal | null>;
  lookupPrincipalRef(ref: PrincipalRef): Promise<Principal | null>;
  localOwner(ownerId: string): Promise<Principal | null>;
}

let backend: TrustBackend | null = null;

export function installTrustBackend(next: TrustBackend): void {
  backend = next;
}

export function trustBackendInstalled(): boolean {
  return backend !== null;
}

// --- bounded prototype driver ------------------------------------------------

interface PrototypeGrant {
  label: string;
  capabilities: ReadonlySet<Capability>;
  expiresAt: string | null;
  /**
   * The principal id this arming issues. It carries a per-arming instance tag,
   * so a reference minted under one arming cannot resolve under another. That
   * is what invalidates saved references across disable, re-arm and restart:
   * the tag is generated fresh each time and never persisted.
   */
  principalId: string;
}

let prototypeGrant: PrototypeGrant | null = null;
let armCounter = 0;

/**
 * Same shape as the lease token in server/lock.ts:225. This is a discriminator,
 * not a secret — its only job is to be different from the last one, including
 * across a process restart, where Date.now() differs even if the counter resets.
 */
function instanceTag(): string {
  armCounter += 1;
  return `${Date.now().toString(36)}-${armCounter.toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Arm the host-only synthetic driver. Off unless called, so the prototype path
 * cannot become production authentication by omission.
 *
 * Capabilities must be listed explicitly — there is no "everything" default.
 * project.admin is refused outright: a synthetic driver never administers.
 */
export function enablePrototypeAuthority(options: {
  label: string;
  capabilities: readonly Capability[];
  expiresAt?: string | null;
}): void {
  const label = options.label.trim();
  if (!label) throw new Error('A prototype authority must carry a non-empty label.');
  if (options.capabilities.includes('project.admin'))
    throw new Error('A prototype authority may not hold project.admin.');
  prototypeGrant = {
    label,
    capabilities: new Set(options.capabilities),
    expiresAt: options.expiresAt ?? null,
    principalId: `prototype:${label}:${instanceTag()}`,
  };
}

export function disablePrototypeAuthority(): void {
  prototypeGrant = null;
}

// --- resolution --------------------------------------------------------------

function nowIso(): string {
  return new Date().toISOString();
}

function expired(expiresAt: string | null): boolean {
  if (expiresAt === null) return false;
  const at = Date.parse(expiresAt);
  return Number.isNaN(at) || at <= Date.now();
}

async function finish(
  principal: Principal,
  assurance: Assurance,
  capabilities: ReadonlySet<Capability>,
  expiresAt: string | null,
  synthetic: boolean,
): Promise<Authority | Denial> {
  if (await isRevoked(principal))
    return denial(403, 'revoked', 'This principal has been revoked.');
  if (expired(expiresAt))
    return denial(401, 'expired', 'This authority has expired; resolve a fresh one.');
  assertInvariants(principal.kind, capabilities);
  return {
    principal,
    generation: generationFor(principal),
    assurance,
    capabilities,
    expiresAt,
    synthetic,
    resolvedAt: nowIso(),
  };
}

function prototypePrincipal(grant: PrototypeGrant): Principal {
  return {
    kind: 'prototype',
    id: grant.principalId,
    tenantId: null,
    projectId: null,
    deviceId: null,
    sessionId: null,
    slotId: null,
  };
}

/** Issue from an armed grant. The single place a prototype Authority is built. */
function finishPrototype(grant: PrototypeGrant): Promise<Authority | Denial> {
  return finish(
    prototypePrincipal(grant),
    'prototype',
    grant.capabilities,
    grant.expiresAt,
    true,
  );
}

/**
 * Re-resolve a saved reference to a prototype authority.
 *
 * Everything is taken from the currently armed grant, never from the reference:
 * assurance stays 'prototype', synthetic stays true, capabilities and expiry
 * come from the grant. A reference is a pointer, so it may not carry rights of
 * its own — and a stale one must not resolve at all.
 */
async function resolveStoredPrototype(ref: PrincipalRef): Promise<Authority | Denial> {
  if (!prototypeGrant)
    return denial(
      403,
      'synthetic-refused',
      'The prototype authority driver is not armed; this saved reference cannot be resolved.',
    );
  if (ref.id !== prototypeGrant.principalId)
    // Disabled and re-armed, or the host restarted, since this was minted. From
    // the run's point of view the authority changed underneath it: park and
    // reconcile, exactly as for a device revoked in flight.
    return denial(
      409,
      'generation-advanced',
      'The prototype driver was re-armed or restarted since this reference was minted.',
    );
  const live = generationFor(prototypePrincipal(prototypeGrant));
  if (live.identity !== ref.mintedAt.identity || live.principal !== ref.mintedAt.principal)
    return denial(
      409,
      'generation-advanced',
      'Authority changed while this run was in flight; reconcile rather than write.',
    );
  return finishPrototype(prototypeGrant);
}

/**
 * Resolve authority from a claim. Never throws for an authorization outcome —
 * it returns a Denial, so work-admission keeps its own error shaping.
 */
export async function currentAuthority(claim: AuthorityClaim): Promise<Authority | Denial> {
  switch (claim.via) {
    case 'prototype-driver': {
      if (!prototypeGrant)
        return denial(
          403,
          'synthetic-refused',
          'The prototype authority driver is not armed in this build.',
        );
      if (claim.label !== prototypeGrant.label)
        return denial(
          403,
          'synthetic-refused',
          'This prototype label does not match the armed grant.',
        );
      return finishPrototype(prototypeGrant);
    }

    case 'local-owner': {
      if (!backend) return noResolver('local owner');
      const principal = await backend.localOwner(claim.ownerId);
      if (!principal) return denial(401, 'unknown-principal', 'This owner was not recognized.');
      return finish(principal, 'owner-local', grantsFor('local-owner'), null, false);
    }

    case 'loopback-http': {
      if (!isLoopback(claim.remoteAddress))
        return denial(403, 'no-claim', 'The team server accepts loopback connections only.');
      const token = /^Bearer (.+)$/.exec(claim.headers.authorization ?? '')?.[1] ?? null;
      const slotId = claim.headers['x-slot-id'] ?? null;
      if (!token || !slotId)
        return denial(401, 'no-claim', 'Provide a member token and slot.');
      if (slotId === 'owner')
        return denial(401, 'no-claim', 'The owner slot cannot call the team server.');
      if (!backend) return noResolver('team member');
      const principal = await backend.lookupTeamMember(claim.projectId, slotId, token);
      if (!principal)
        return denial(401, 'unknown-principal', 'This member token was not recognized.');
      return finish(principal, 'shared-secret', grantsFor('team-member'), null, false);
    }

    case 'stored-reference': {
      // The bounded driver resolves its own saved references. This must come
      // BEFORE the backend, or a prototype reference re-resolves through a
      // production grant table and launders itself into genuine authority.
      if (claim.ref.kind === 'prototype') return resolveStoredPrototype(claim.ref);
      if (!backend) return noResolver('stored reference');
      const principal = await backend.lookupPrincipalRef(claim.ref);
      if (!principal)
        return denial(401, 'unknown-principal', 'This principal no longer exists.');
      // A backend may not change what class a reference resolves to. Kind is how
      // grants are chosen, so letting it drift would reopen the laundering path
      // the prototype branch above exists to close. That branch already returned
      // for prototype refs, so equality here also proves the backend did not
      // mint one — the compiler checks that, which is why there is no second
      // clause testing it.
      if (principal.kind !== claim.ref.kind)
        return denial(
          403,
          'unknown-principal',
          'The resolver returned a different identity class than the reference names.',
        );
      // The generation comparison is the whole point of a stored reference:
      // authority valid at dispatch may have been revoked underneath the run.
      const live = generationFor(principal);
      if (
        live.identity !== claim.ref.mintedAt.identity ||
        live.principal !== claim.ref.mintedAt.principal
      )
        return denial(
          409,
          'generation-advanced',
          'Authority changed while this run was in flight; reconcile rather than write.',
        );
      const assurance: Assurance = principal.kind === 'local-owner' ? 'owner-local' : 'device-key';
      return finish(principal, assurance, grantsFor(principal.kind), null, false);
    }

    default:
      return denial(401, 'no-claim', 'No recognizable authority claim was presented.');
  }
}

function noResolver(what: string): Denial {
  return denial(
    403,
    'no-resolver',
    `The production Trust resolver is not installed; ${what} authority cannot be issued.`,
  );
}

function isLoopback(addr: string): boolean {
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
}

// --- projection and guards ---------------------------------------------------

/**
 * The only persistable projection of an Authority. Store this alongside a run;
 * re-resolve it with { via: 'stored-reference', ref } at every later point.
 */
export function refOf(authority: Authority): PrincipalRef {
  return {
    kind: authority.principal.kind,
    id: authority.principal.id,
    tenantId: authority.principal.tenantId,
    mintedAt: { ...authority.generation },
  };
}

/** Narrow a result to one that holds a capability, or pass the Denial through. */
export function requireCapability(
  result: Authority | Denial,
  capability: Capability,
): Authority | Denial {
  if (isDenial(result)) return result;
  const authority = result;
  if (!authority.capabilities.has(capability))
    return denial(403, 'missing-capability', `This principal does not hold ${capability}.`);
  return authority;
}

/** Narrow a result to one meeting a minimum assurance, or pass the Denial through. */
export function requireAssurance(
  result: Authority | Denial,
  minimum: Assurance,
): Authority | Denial {
  if (isDenial(result)) return result;
  const authority = result;
  if (assuranceRank[authority.assurance] < assuranceRank[minimum])
    return denial(
      403,
      'insufficient-assurance',
      `This action requires ${minimum} assurance; the principal has ${authority.assurance}.`,
    );
  return authority;
}

/** Refuse synthetic authority. Call in any path a production build must gate. */
export function requireGenuine(result: Authority | Denial): Authority | Denial {
  if (isDenial(result)) return result;
  const authority = result;
  if (authority.synthetic)
    return denial(
      403,
      'synthetic-refused',
      'This path refuses prototype authority; no human or device claim was made.',
    );
  return authority;
}
