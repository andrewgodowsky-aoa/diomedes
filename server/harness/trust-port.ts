/** Runtime consumer of Opus's shared Trust contract. No parallel authority model. */
import type { Authority, AuthorityClaim, Denial } from '../trust/index.js';
export type { Authority, AuthorityClaim, Capability, Denial, Generation, PrincipalKind, PrincipalRef } from '../trust/index.js';
export type ResolveHarnessAuthority = (claim: AuthorityClaim) => Promise<Authority | Denial>;
