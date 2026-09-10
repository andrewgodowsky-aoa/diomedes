// Diomedes Trust v1 — public surface (NR-04).
//
// Runtime call sites import from here and from nowhere else inside server/trust/.
// Everything below is the contract in planning/DIOMEDES-TRUST-OWNERSHIP-2026-09-09.md §8.
//
// Typical NR-03 use, at each of the four required resolution points:
//
//   const a = requireCapability(await currentAuthority(claim), 'egress.send');
//   if (isDenial(a)) return refuse(a.status, a.reason);
//   const ref = refOf(a);                     // persist THIS, never `a`
//   ...dispatch...
//   const back = requireCapability(
//     await currentAuthority({ via: 'stored-reference', ref }), 'egress.reconcile');
//   if (isDenial(back)) return park(back);    // 409 generation-advanced = revoked in flight

export {
  allCapabilities,
  assuranceRank,
  denial,
  isAuthority,
  isDenial,
  type Assurance,
  type Authority,
  type AuthorityClaim,
  type Capability,
  type Denial,
  type DenialCode,
  type Generation,
  type Principal,
  type PrincipalKind,
  type PrincipalRef,
} from './types.js';

export {
  currentAuthority,
  disablePrototypeAuthority,
  enablePrototypeAuthority,
  installTrustBackend,
  refOf,
  requireAssurance,
  requireCapability,
  requireGenuine,
  trustBackendInstalled,
  type TrustBackend,
} from './authority.js';

export {
  generationFor,
  isRevoked,
  reinstate,
  revocationReason,
  revoke,
  revokeTenant,
} from './revocation.js';
