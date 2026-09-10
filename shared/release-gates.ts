/**
 * The truthful release gates as a checkable structure rather than prose.
 *
 * Doc 06 (`docs/product/personal-business/06_EDGE_CASES_AND_ACCEPTANCE.md`)
 * names four gates — Development, Controlled pilot, Paid managed inference and
 * Broader Business release — and is explicit that fixtures prove the flow
 * rather than paid readiness: no customer billing or multi-tenant security
 * claim follows from them, and website forms plus a desktop checkbox do not
 * satisfy the paid gate. This module encodes that honesty directly: each
 * requirement carries what would have to be true, what kind of evidence could
 * show it, and whether this build actually demonstrates it today.
 *
 * `met` is deliberately pessimistic. Flipping a requirement to `met: true`
 * without installing the service it names should fail
 * `tests/release-gates.test.ts`, which pins the paid gate as unmet and pins
 * the reason to the absent entitlement/gateway service.
 */

export type GateId = 'development' | 'controlled-pilot' | 'paid-managed-inference' | 'broader-business';

export interface GateRequirement {
  readonly id: string;
  readonly text: string; // what must be true, in plain English
  readonly evidenceKind: 'test' | 'smoke' | 'written-authorization' | 'operational' | 'commercial';
  /** What this build can actually demonstrate today: honest, and usually false. */
  readonly met: boolean;
  readonly note: string; // why met, or exactly what is missing
}

export interface ReleaseGate {
  readonly id: GateId;
  readonly name: string;
  readonly summary: string;
  readonly requirements: readonly GateRequirement[];
}

export const RELEASE_GATES: readonly ReleaseGate[] = Object.freeze([
  {
    id: 'development',
    name: 'Development',
    summary:
      'Synthetic identities and test usage are isolated from production; real local persistence and UI may be demonstrated. Nothing here is a customer billing or multi-tenant security claim.',
    requirements: [
      {
        id: 'development.synthetic-identities-isolated',
        text: 'Synthetic identities and prototype authority are isolated from production and off unless armed.',
        evidenceKind: 'test',
        met: true,
        note: 'Held by tests/trust.test.ts: the bounded prototype driver is off unless armed and refuses widened or hand-forged grants.',
      },
      {
        id: 'development.no-billing-claim-from-fixtures',
        text: 'No customer billing or multi-tenant security claim follows from fixtures.',
        evidenceKind: 'test',
        met: true,
        note: 'Held by tests/workspaces.test.ts and tests/managed-usage.test.ts: entitlement is always none and the candidate plan is asserted not sellable.',
      },
      {
        id: 'development.local-persistence-demonstrable',
        text: 'Real local persistence and UI may be demonstrated against synthetic data.',
        evidenceKind: 'test',
        met: true,
        note: 'Held by restart tests in tests/workspaces.test.ts and tests/configuration-service.test.ts: drafts, manifests and history survive a restart over the same directory.',
      },
    ],
  },
  {
    id: 'controlled-pilot',
    name: 'Controlled pilot',
    summary:
      'A supported identity with organization ownership, scoped data and credentials, one verified route, written authorization, and defined support, recovery and export. Review time and failures are measured, not just the successful demo.',
    requirements: [
      {
        id: 'controlled-pilot.supported-identity-ownership',
        text: 'Organizations are issued by a supported identity service with verifiable ownership.',
        evidenceKind: 'operational',
        met: false,
        note: 'Missing: this build issues only local development fixtures and says so (hosted.available is false); no production identity service is installed.',
      },
      {
        id: 'controlled-pilot.scoped-data-credentials',
        text: 'Pilot data and credentials are scoped to the pilot organization and separable from personal data.',
        evidenceKind: 'operational',
        met: false,
        note: 'Missing: tenant labelling and intake scoping exist in fixtures, but no supported identity or credential service backs them for a real pilot.',
      },
      {
        id: 'controlled-pilot.verified-route',
        text: 'One route is verified end to end for the pilot workload.',
        evidenceKind: 'operational',
        met: false,
        note: 'Missing: route capabilities are recorded with evidence, but no route has a pilot verification record in this build.',
      },
      {
        id: 'controlled-pilot.written-authorization',
        text: 'Written data and access authorization exists for the pilot.',
        evidenceKind: 'written-authorization',
        met: false,
        note: 'Missing: no written authorization exists in this build, and none is claimed.',
      },
      {
        id: 'controlled-pilot.support-recovery-export',
        text: 'Support, recovery and export are defined and reachable for the pilot.',
        evidenceKind: 'operational',
        met: false,
        note: 'Missing: restart survival is tested, but defined pilot support, recovery and export paths are not.',
      },
    ],
  },
  {
    id: 'paid-managed-inference',
    name: 'Paid managed inference',
    summary:
      'Server-held keys, membership and entitlement enforcement, bounded spend, request and settlement reconciliation, abuse controls, approved provider terms, a clear allowance contract, and revocation and incident handling. Website forms and a desktop checkbox do not satisfy this gate.',
    requirements: [
      {
        id: 'paid-managed-inference.server-held-keys',
        text: 'Provider keys are held server-side and never leave the managed boundary.',
        evidenceKind: 'operational',
        met: false,
        note: 'Missing: no key service exists in this build; local routes and BYO keys are the only paths.',
      },
      {
        id: 'paid-managed-inference.entitlement-enforcement',
        text: 'Membership and entitlement are enforced before managed work is admitted.',
        evidenceKind: 'operational',
        met: false,
        note: 'Missing: no entitlement or gateway service is installed, so entitlementFor always returns none and no local record can grant managed inference.',
      },
      {
        id: 'paid-managed-inference.bounded-spend',
        text: 'Spend is bounded by an enforced allowance with atomic reservations.',
        evidenceKind: 'operational',
        met: false,
        note: 'Missing: the reservation state machine is pure and tested, but no ledger enforces it against real billing.',
      },
      {
        id: 'paid-managed-inference.reconciliation',
        text: 'Requests settle against provider reports; lost responses reconcile rather than retry blindly.',
        evidenceKind: 'operational',
        met: false,
        note: 'Missing: uncertain holds reconcile only in the pure contract; no provider-report pipeline exists.',
      },
      {
        id: 'paid-managed-inference.abuse-controls',
        text: 'Abuse controls rate-limit and suspend misuse.',
        evidenceKind: 'operational',
        met: false,
        note: 'Missing: no abuse-control service exists in this build.',
      },
      {
        id: 'paid-managed-inference.provider-terms',
        text: 'Provider terms for managed inference are approved.',
        evidenceKind: 'commercial',
        met: false,
        note: 'Missing: no provider terms have been approved, and none are claimed.',
      },
      {
        id: 'paid-managed-inference.allowance-contract',
        text: 'A clear allowance contract (price, included usage, limits) is approved and sellable.',
        evidenceKind: 'commercial',
        met: false,
        note: 'Missing: the managed plan is a candidate with sellable false; its price and limits need commercial approval and no checkout exists.',
      },
      {
        id: 'paid-managed-inference.revocation-incidents',
        text: 'Revocation and incident handling for paid access are defined and exercised.',
        evidenceKind: 'operational',
        met: false,
        note: 'Missing: membership revocation is tested locally, but paid-access revocation and incident handling are not defined.',
      },
    ],
  },
  {
    id: 'broader-business',
    name: 'Broader Business release',
    summary:
      'A supported signed distribution and update path, rollout and rollback, measured tenant isolation and capacity, operational monitoring, realistic support and retention terms, and repeatable first-job onboarding. Existing release processes remain authoritative.',
    requirements: [
      {
        id: 'broader-business.signed-distribution',
        text: 'Distribution and updates travel a supported signed path.',
        evidenceKind: 'operational',
        met: false,
        note: 'Missing: no signed distribution or update path is installed in this build.',
      },
      {
        id: 'broader-business.rollout-rollback',
        text: 'Rollout and rollback are defined beyond a single-machine configuration restore.',
        evidenceKind: 'operational',
        met: false,
        note: 'Missing: configuration rollback is tested locally, but product rollout and rollback are not defined.',
      },
      {
        id: 'broader-business.isolation-capacity',
        text: 'Tenant isolation and capacity are measured, not asserted from fixtures.',
        evidenceKind: 'operational',
        met: false,
        note: 'Missing: tenant-bound execution is tested in harnesses, but no measured isolation or capacity evidence exists.',
      },
      {
        id: 'broader-business.monitoring',
        text: 'Operational monitoring covers the business workload.',
        evidenceKind: 'operational',
        met: false,
        note: 'Missing: no operational monitoring exists in this build.',
      },
      {
        id: 'broader-business.support-retention',
        text: 'Support and retention terms are realistic and approved.',
        evidenceKind: 'commercial',
        met: false,
        note: 'Missing: no support or retention terms have been approved.',
      },
      {
        id: 'broader-business.repeatable-onboarding',
        text: 'First-job onboarding is repeatable by evidence, not by demo.',
        evidenceKind: 'smoke',
        met: false,
        note: 'Missing: the intake compiles to a proposal in fixtures, but no repeatable onboarding measurement exists.',
      },
    ],
  },
]);

export function gateStatus(gate: ReleaseGate): {
  met: boolean;
  missing: readonly GateRequirement[];
} {
  const missing = gate.requirements.filter((requirement) => !requirement.met);
  return { met: missing.length === 0, missing };
}

export function highestMetGate(): GateId | null {
  let highest: GateId | null = null;
  for (const gate of RELEASE_GATES) if (gateStatus(gate).met) highest = gate.id;
  return highest;
}
