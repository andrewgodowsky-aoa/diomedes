/**
 * The named contract fixtures.
 *
 * Each entry is the normative scenario a reviewer can diff without reading
 * implementation: an input view plus the decision the contract must return.
 * The conformance test iterates `ADMISSION_FIXTURES` and asserts each view
 * decides exactly as recorded, so adding a case is adding data — the fixture
 * file is where "what should happen" lives.
 */
import { RATE_CARD_V1 } from '../../../shared/managed-usage.js';
import type { AdmissionView, EntitlementSnapshot } from './contract.js';
import { NO_ENTITLEMENT_SNAPSHOT } from './contract.js';

const AT = '2026-09-16T12:00:00.000Z';

/**
 * The five named entitlement states the contract must answer.
 * `development-fixture` is not an entitlement at all — it is the provenance a
 * locally created organization carries, and it can never read as `active`.
 */
export const ENTITLEMENT_FIXTURES = Object.freeze({
  active: {
    state: 'active',
    planId: 'plan_candidate',
    planVersion: 'plan_candidate.1',
    issuedAt: '2026-09-01T00:00:00.000Z',
    expiresAt: '2026-10-01T00:00:00.000Z',
    revokedAt: null,
    revision: 4,
    reason: '',
  },
  expired: {
    state: 'active',
    planId: 'plan_candidate',
    planVersion: 'plan_candidate.1',
    issuedAt: '2026-08-01T00:00:00.000Z',
    expiresAt: '2026-09-01T00:00:00.000Z',
    revokedAt: null,
    revision: 4,
    reason: 'The entitlement period ended before this request.',
  },
  unknown: {
    state: 'unknown',
    planId: null,
    planVersion: null,
    issuedAt: null,
    expiresAt: null,
    revokedAt: null,
    revision: 0,
    reason: 'The entitlement service could not be asked.',
  },
  'development-fixture': NO_ENTITLEMENT_SNAPSHOT,
  'security-suspended': {
    state: 'active',
    planId: 'plan_candidate',
    planVersion: 'plan_candidate.1',
    issuedAt: '2026-09-01T00:00:00.000Z',
    expiresAt: '2026-10-01T00:00:00.000Z',
    revokedAt: null,
    revision: 4,
    reason: '',
  },
} as const satisfies Record<string, EntitlementSnapshot>);

const member = (
  overrides: Partial<AdmissionView> & { entitlement: EntitlementSnapshot },
): AdmissionView => ({
  member: true,
  tenantId: 'tenant_fixture',
  dataRouteRefused: false,
  payer: 'managed',
  billing: { paidThrough: null, suspended: false, suspendedReason: null, lastSequence: 0 },
  kind: 'generation',
  rateCard: RATE_CARD_V1,
  at: AT,
  ...overrides,
});

export interface AdmissionFixture {
  readonly view: AdmissionView;
  readonly expected: 'admitted' | 'refused';
  readonly code?: string;
  readonly why: string;
}

export const ADMISSION_FIXTURES: Readonly<Record<string, AdmissionFixture>> = Object.freeze({
  active: {
    view: member({ entitlement: ENTITLEMENT_FIXTURES.active }),
    expected: 'admitted',
    why: 'An active entitlement, no suspension and an admissible kind admits managed work.',
  },
  expired: {
    view: member({ entitlement: ENTITLEMENT_FIXTURES.expired }),
    expected: 'refused',
    code: 'no_entitlement',
    why: 'An entitlement whose period ended reads expired at observation time and refuses.',
  },
  unknown: {
    view: member({ entitlement: ENTITLEMENT_FIXTURES.unknown }),
    expected: 'refused',
    code: 'entitlement_unknown',
    why: 'An entitlement that could not be asked is unknown; unknown never reads as active.',
  },
  'development-fixture': {
    view: member({ entitlement: ENTITLEMENT_FIXTURES['development-fixture'] }),
    expected: 'refused',
    code: 'no_entitlement',
    why: 'A development fixture carries no entitlement and cannot gain one locally.',
  },
  'security-suspended': {
    view: member({
      entitlement: ENTITLEMENT_FIXTURES['security-suspended'],
      billing: {
        paidThrough: '2026-10-01T00:00:00.000Z',
        suspended: true,
        suspendedReason: 'chargeback under review',
        lastSequence: 9,
      },
    }),
    expected: 'refused',
    code: 'security_suspended',
    why: 'A paid invoice does not lift a security suspension; the suspension record decides.',
  },
});
