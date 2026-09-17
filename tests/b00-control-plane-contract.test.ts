/**
 * B00.I — the shared commercial/control-plane contract.
 *
 * These tests pin what the contract must prove before any provider is wired:
 * Personal keeps working with the cloud offline; a development fixture cannot
 * launder itself into a verified subject; a paid invoice never lifts a
 * security suspension; an unclassified charge kind is unknown and refused;
 * and the USD 0 spend policy cannot be moved by a questionnaire answer or a
 * model's output. Each named fixture in `fixtures.ts` is the normative case
 * the reviewer can diff without reading the implementation.
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  ADMISSION_FIXTURES,
  assertMembership,
  assertionStale,
  CLOUD_SCHEDULER,
  CONTROL_PLANE_CONTRACT_VERSION,
  CONTROL_PLANE_SOURCES,
  decideAdmission,
  ENTITLEMENT_FIXTURES,
  kindEligibility,
  leaseUsable,
  NO_ENTITLEMENT_SNAPSHOT,
  payerKindFor,
  snapshotAt,
  snapshotFromView,
  verifySubject,
} from '../services/control-plane/contract/index.js';
import {
  applySpendOverride,
  SPEND_POLICY,
  VENDOR_ALLOWLIST,
} from '../services/control-plane/contract/vendors.js';
import { entitlementFor, type Membership, type Organization } from '../shared/workspaces.js';
import { RATE_CARD_V1, type RateCard } from '../shared/managed-usage.js';

const AT = '2026-09-16T12:00:00.000Z';
const GEN = { identity: 3, principal: 1 };

const fixtureOrg = (overrides: Partial<Organization> = {}): Organization => ({
  v: 1,
  id: 'org_fixture',
  name: 'Fixture Co',
  industry: null,
  tenantId: 'tenant_fixture',
  identitySource: 'development-fixture',
  createdAt: AT,
  createdBy: 'person_owner',
  ...overrides,
});

const activeMembership = (overrides: Partial<Membership> = {}): Membership => ({
  v: 1,
  organizationId: 'org_fixture',
  personId: 'person_owner',
  role: 'owner',
  state: 'active',
  invitedAt: AT,
  joinedAt: AT,
  revokedAt: null,
  revokedReason: null,
  ...overrides,
});

describe('verified external-subject mapping', () => {
  it('verifies a complete hosted claim', () => {
    const result = verifySubject({
      identitySource: 'hosted',
      issuer: 'https://api.workos.com/user_management/client_01',
      subject: 'user_01JXYZ',
      personId: 'person_owner',
      verifiedAt: AT,
      identityGeneration: 3,
    });
    expect(result.verified).toBe(true);
    if (result.verified) {
      expect(result.mapping.subject).toBe('user_01JXYZ');
      expect(result.mapping.identityGeneration).toBe(3);
    }
  });

  it('refuses a development fixture no matter how complete the record looks', () => {
    // The acceptance case: editing settings cannot make a fixture verified.
    // Every field is present and well-formed; only the source decides.
    const result = verifySubject({
      identitySource: 'development-fixture',
      issuer: 'https://api.workos.com/user_management/client_01',
      subject: 'user_01JXYZ',
      personId: 'person_owner',
      verifiedAt: AT,
      identityGeneration: 3,
    });
    expect(result.verified).toBe(false);
    if (!result.verified) expect(result.reason).toMatch(/fixture/i);
  });

  it('refuses hosted claims missing any required field', () => {
    for (const omit of ['issuer', 'subject', 'personId', 'verifiedAt', 'identityGeneration']) {
      const claim: Record<string, unknown> = {
        identitySource: 'hosted',
        issuer: 'https://issuer.example',
        subject: 'sub_1',
        personId: 'person_1',
        verifiedAt: AT,
        identityGeneration: 1,
      };
      delete claim[omit];
      expect(verifySubject(claim as never).verified).toBe(false);
    }
  });
});

describe('tenant-bound membership with generation', () => {
  it('asserts an active member under the live generation', () => {
    const result = assertMembership({
      organization: fixtureOrg(),
      membership: activeMembership(),
      generation: GEN,
      at: AT,
    });
    expect(result.asserted).toBe(true);
    if (result.asserted) {
      expect(result.assertion.tenantId).toBe('tenant_fixture');
      expect(result.assertion.generation).toEqual(GEN);
    }
  });

  it('refuses invited, revoked and absent memberships alike', () => {
    for (const state of ['invited', 'revoked'] as const) {
      expect(
        assertMembership({
          organization: fixtureOrg(),
          membership: activeMembership({ state }),
          generation: GEN,
          at: AT,
        }).asserted,
      ).toBe(false);
    }
    expect(
      assertMembership({
        organization: fixtureOrg(),
        membership: undefined,
        generation: GEN,
        at: AT,
      }).asserted,
    ).toBe(false);
  });

  it('reads staleness from the generation, never from the snapshot text', () => {
    const result = assertMembership({
      organization: fixtureOrg(),
      membership: activeMembership(),
      generation: GEN,
      at: AT,
    });
    if (!result.asserted) throw new Error('expected an assertion');
    expect(assertionStale(result.assertion, GEN)).toBe(false);
    expect(assertionStale(result.assertion, { identity: 4, principal: 1 })).toBe(true);
    expect(assertionStale(result.assertion, { identity: 3, principal: 2 })).toBe(true);
  });
});

describe('entitlement snapshots', () => {
  it('adapts the build that has no entitlement service to state none', () => {
    const snapshot = snapshotFromView(entitlementFor('org_any'), AT);
    expect(snapshot.state).toBe('none');
    expect(snapshot.planId).toBeNull();
  });

  it('reads expiry and revocation at observation time', () => {
    const active = {
      ...NO_ENTITLEMENT_SNAPSHOT,
      state: 'active' as const,
      planId: 'plan_test',
      planVersion: 'plan_test.1',
      issuedAt: '2026-09-01T00:00:00.000Z',
      expiresAt: '2026-09-15T00:00:00.000Z',
      revision: 2,
      reason: '',
    };
    expect(snapshotAt(active, '2026-09-14T00:00:00.000Z').state).toBe('active');
    expect(snapshotAt(active, AT).state).toBe('expired');
    expect(
      snapshotAt({ ...active, expiresAt: null, revokedAt: '2026-09-15T00:00:00.000Z' }, AT).state,
    ).toBe('revoked');
  });
});

describe('managed admission decisions', () => {
  it('admits local and BYO payers with no entitlement service at all', () => {
    // Personal with the cloud offline: the managed plane is never consulted.
    for (const payer of ['local', 'byo'] as const) {
      const decision = decideAdmission({
        member: true,
        tenantId: 'tenant_fixture',
        dataRouteRefused: false,
        payer,
        entitlement: NO_ENTITLEMENT_SNAPSHOT,
        billing: { paidThrough: null, suspended: false, suspendedReason: null, lastSequence: 0 },
        kind: 'generation',
        rateCard: RATE_CARD_V1,
        at: AT,
      });
      expect(decision).toEqual({ decided: 'admitted', payer });
    }
  });

  it('never lets a paid invoice override a security suspension', () => {
    const decision = decideAdmission({
      member: true,
      tenantId: 'tenant_fixture',
      dataRouteRefused: false,
      payer: 'managed',
      entitlement: { ...ENTITLEMENT_FIXTURES.active },
      billing: {
        paidThrough: '2026-10-01T00:00:00.000Z',
        suspended: true,
        suspendedReason: 'chargeback under review',
        lastSequence: 9,
      },
      kind: 'generation',
      rateCard: RATE_CARD_V1,
      at: AT,
    });
    expect(decision).toMatchObject({ decided: 'refused', code: 'security_suspended' });
  });

  it('refuses managed admission when the rate card does not classify the kind', () => {
    const thinCard: RateCard = {
      ...RATE_CARD_V1,
      version: 'rate-card-thin',
      eligibility: { setup: 'included' } as RateCard['eligibility'],
      reason: { setup: 'only setup' } as RateCard['reason'],
    };
    expect(kindEligibility(thinCard, 'generation')).toBe('unknown');
    const decision = decideAdmission({
      member: true,
      tenantId: 'tenant_fixture',
      dataRouteRefused: false,
      payer: 'managed',
      entitlement: { ...ENTITLEMENT_FIXTURES.active },
      billing: { paidThrough: null, suspended: false, suspendedReason: null, lastSequence: 0 },
      kind: 'generation',
      rateCard: thinCard,
      at: AT,
    });
    expect(decision).toMatchObject({ decided: 'refused', code: 'charge_kind_unknown' });
  });

  it('every named fixture decides exactly as recorded', () => {
    for (const [name, fixture] of Object.entries(ADMISSION_FIXTURES)) {
      const decision = decideAdmission(fixture.view);
      expect(
        decision,
        `fixture ${name}: expected ${fixture.expected}`,
      ).toMatchObject({ decided: fixture.expected, ...(fixture.code ? { code: fixture.code } : {}) });
    }
  });
});

describe('the USD 0 spend policy', () => {
  it('is frozen at zero new spend', () => {
    expect(SPEND_POLICY.newFixedSpendMicroUsd).toBe(0);
    expect(SPEND_POLICY.unapprovedVariableSpendMicroUsd).toBe(0);
    expect(SPEND_POLICY.automaticTopUps).toBe(false);
    expect(Object.isFrozen(SPEND_POLICY)).toBe(true);
  });

  it('refuses overrides from a questionnaire answer and from model output', () => {
    const questionnaire = { source: 'setup-questionnaire', newFixedSpendMicroUsd: 25_000_000 };
    const modelOutput = { source: 'model', cloudSpendCapUsd: 500 };
    for (const attempt of [questionnaire, modelOutput]) {
      const result = applySpendOverride(attempt);
      expect(result.applied).toBe(false);
      expect(result).toMatchObject({ applied: false });
    }
    expect(SPEND_POLICY.newFixedSpendMicroUsd).toBe(0);
  });
});

describe('one of each authority', () => {
  const root = path.resolve(__dirname, '..');
  it('names exactly one hosted identity provider', () => {
    const identity = VENDOR_ALLOWLIST.filter((v) => v.role === 'identity' && v.selected);
    expect(identity.map((v) => v.vendor)).toEqual(['workos-authkit']);
  });
  it('names the existing single writers rather than new ones', () => {
    expect(CONTROL_PLANE_SOURCES.allowanceWriter).toBe('server/managed-usage.ts');
    expect(CONTROL_PLANE_SOURCES.budgetSemantics).toBe('shared/managed-usage.ts');
    for (const file of [CONTROL_PLANE_SOURCES.allowanceWriter, CONTROL_PLANE_SOURCES.budgetSemantics])
      expect(fs.existsSync(path.join(root, file)), file).toBe(true);
  });
  it('admits no cloud scheduler', () => {
    expect(CLOUD_SCHEDULER).toBeNull();
    expect(CONTROL_PLANE_SOURCES.scheduler).toBeNull();
  });
  it('every selected vendor bills zero fixed monthly spend', () => {
    for (const vendor of VENDOR_ALLOWLIST.filter((v) => v.selected))
      expect(vendor.monthlyFixedMicroUsd, vendor.vendor).toBe(0);
  });
  it('records the rejected paid add-ons explicitly', () => {
    const workos = VENDOR_ALLOWLIST.find((v) => v.vendor === 'workos-authkit');
    expect(workos?.rejectedAddOns).toEqual(
      expect.arrayContaining([expect.stringMatching(/sso|scim/i)]),
    );
  });
});

describe('credential leases and payer bridging', () => {
  const lease = {
    handle: 'lease_opaque_01',
    principalId: 'person_owner',
    tenantId: 'tenant_fixture',
    resources: ['org_fixture'],
    scopes: ['inference'],
    generation: GEN,
    expiresAt: '2026-09-16T13:00:00.000Z',
  };
  it('a lease fails closed on expiry or a generation bump', () => {
    expect(leaseUsable(lease, GEN, AT).usable).toBe(true);
    expect(leaseUsable(lease, GEN, '2026-09-16T14:00:00.000Z').usable).toBe(false);
    expect(leaseUsable(lease, { identity: 4, principal: 1 }, AT).usable).toBe(false);
    expect(leaseUsable(lease, { identity: 3, principal: 2 }, AT).usable).toBe(false);
  });
  it('bridges the two payer vocabularies without a second semantic', () => {
    expect(payerKindFor('managed')).toBe('organization');
    expect(payerKindFor('byo')).toBe('bring-your-own');
    expect(payerKindFor('local')).toBe('local-machine');
    expect(payerKindFor('refused')).toBeNull();
  });
});

it('the contract is versioned', () => {
  expect(CONTROL_PLANE_CONTRACT_VERSION).toBe(1);
});
