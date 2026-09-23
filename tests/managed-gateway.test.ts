/**
 * The gateway: what has to be true before a company's key is used.
 *
 * The order of these checks is the design. Identity, then membership, then
 * entitlement, then the data route, then whether the charge can be bounded at
 * all, then who pays, and only then money. Each one is cheaper and more
 * conclusive than the next, and — more importantly — a later check passing must
 * never be able to stand in for an earlier one. A budget reservation is not
 * permission to execute.
 *
 * Two claims here are about what this build must NOT do. Entitlement is
 * absent, so every managed admission refuses; a test that skipped that would
 * let simulated paid readiness through. And a request body claiming `paid` or
 * naming a different company changes nothing, because a client-supplied field
 * is not authority however confidently it is spelled.
 *
 * Every company, person and figure here is invented. No key was used.
 */
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Store } from '../server/store.js';
import { AllowanceLedger } from '../server/managed-usage.js';
import { ManagedGateway, verifyAuthorization } from '../server/managed-gateway.js';
import { NO_ENTITLEMENT_REASON, type EntitlementView } from '../shared/workspaces.js';
import { approvedJobCap, dollars, type MicroUsd } from '../shared/managed-usage.js';

const AT = '2026-09-10T09:00:00.000Z';
const ORG = 'org_gateway';
const TENANT = 'tenant_gateway';
const PERSON = 'person_owner';
const PERIOD = '2026-09';

let root = '';
let ledger: AllowanceLedger;

/** An entitlement service that does not exist here, standing in as one that does. */
const entitled: EntitlementView = {
  plan: 'none',
  managedInference: false,
  reason: NO_ENTITLEMENT_REASON,
};
const paid = { ...entitled, managedInference: true } as unknown as EntitlementView;

function gateway(options: {
  entitlement?: EntitlementView;
  member?: boolean;
  processing?: 'local-only' | 'non-sensitive-may-leave' | 'may-leave';
  organizationRoute?: 'managed' | 'byo' | 'personal-subscription';
  suspended?: boolean | string;
  jobCap?: MicroUsd;
  jobCapCalls?: string[];
} = {}) {
  return new ManagedGateway({
    ledger,
    jobCapFor: (_organizationId, jobId) => {
      options.jobCapCalls?.push(jobId);
      return options.jobCap ?? approvedJobCap('efficient');
    },
    entitlementFor: () => options.entitlement ?? entitled,
    tenantFor: () => TENANT,
    memberOf: () => options.member ?? true,
    billingStatusFor: async () => ({
      suspended: Boolean(options.suspended),
      suspendedReason: typeof options.suspended === 'string' ? options.suspended : null,
    }),
    policyFor: () => ({
      processing: options.processing ?? 'may-leave',
      organizationRoute: options.organizationRoute ?? 'managed',
    }),
  });
}

const ask = (overrides: Record<string, unknown> = {}) => ({
  organizationId: ORG,
  personId: PERSON,
  route: 'codex',
  kind: 'generation' as const,
  parentTaskId: null,
  maxMicroUsd: dollars(1),
  requestDigest: 'digest-one',
  reservationId: 'res_1',
  periodId: PERIOD,
  at: AT,
  ...overrides,
});

beforeEach(async () => {
  await fs.mkdir(path.join(process.cwd(), 'test-results'), { recursive: true });
  root = await fs.mkdtemp(path.join(process.cwd(), 'test-results', 'gateway-'));
  const store = new Store(path.join(root, 'data'), path.join(root, 'projects'));
  await store.init();
  ledger = new AllowanceLedger(store);
  await ledger.init();
  await ledger.allocatePeriod({
    organizationId: ORG,
    periodId: PERIOD,
    planVersion: 'plan-test',
    rateCardVersion: 'rate-card-2026-09-10.1',
    grantedMicroUsd: dollars(10),
    startsAt: AT,
    endsAt: '2026-10-01T00:00:00.000Z',
    sourceEventId: 'evt_1',
    at: AT,
  });
});

afterEach(async () => {
  if (root) await fs.rm(root, { recursive: true, force: true });
  root = '';
});

describe('the checks that come before money', () => {
  test('a person who is not an active member is refused, and no hold is taken', async () => {
    const decision = await gateway({ member: false, entitlement: paid }).admit(ask());
    expect(decision.admitted).toBe(false);
    if (decision.admitted) throw new Error('unreachable');
    expect(decision.code).toBe('not_a_member');
    expect(ledger.summary(ORG, PERIOD).pendingMicroUsd).toBe(0);
  });

  test('no entitlement refuses every managed admission in this build', async () => {
    const decision = await gateway().admit(ask());
    expect(decision.admitted).toBe(false);
    if (decision.admitted) throw new Error('unreachable');
    expect(decision.code).toBe('no_entitlement');
    expect(decision.message).toBe(NO_ENTITLEMENT_REASON);
  });

  test('a local-only business does not have a remote route quietly downgraded', async () => {
    const decision = await gateway({ entitlement: paid, processing: 'local-only' }).admit(ask());
    expect(decision.admitted).toBe(false);
    if (decision.admitted) throw new Error('unreachable');
    expect(decision.code).toBe('data_route_refused');
    expect(ledger.summary(ORG, PERIOD).pendingMicroUsd).toBe(0);
  });

  test('a local-only business still runs on a route that never leaves the computer', async () => {
    const decision = await gateway({ entitlement: paid, processing: 'local-only' }).admit(
      ask({ route: 'ollama' }),
    );
    expect(decision.admitted).toBe(true);
    if (!decision.admitted) throw new Error('unreachable');
    expect(decision.payer).toBe('local');
    // Local work costs the company nothing upstream, so it holds nothing.
    expect(decision.reservation).toBeNull();
    expect(ledger.summary(ORG, PERIOD).pendingMicroUsd).toBe(0);
  });

  test('a charge with no knowable ceiling is not run on the allowance', async () => {
    const decision = await gateway({ entitlement: paid }).admit(ask({ kind: 'tool-service' }));
    expect(decision.admitted).toBe(false);
    if (decision.admitted) throw new Error('unreachable');
    expect(decision.code).toBe('charge_not_admissible');
  });

  test("a personal subscription is refused rather than used for the company's work", async () => {
    const decision = await gateway({
      entitlement: paid,
      organizationRoute: 'personal-subscription',
    }).admit(ask());
    expect(decision.admitted).toBe(false);
    if (decision.admitted) throw new Error('unreachable');
    expect(decision.code).toBe('payer_refused');
    expect(decision.message).toMatch(/personal subscription/i);
  });

  test("a business's own key is admitted and debits nothing", async () => {
    const decision = await gateway({ entitlement: paid, organizationRoute: 'byo' }).admit(ask());
    expect(decision.admitted).toBe(true);
    if (!decision.admitted) throw new Error('unreachable');
    expect(decision.payer).toBe('byo');
    expect(decision.reservation).toBeNull();
    expect(ledger.summary(ORG, PERIOD).pendingMicroUsd).toBe(0);
  });

  test('a budget refusal passes through with the ledger’s own reason', async () => {
    const decision = await gateway({ entitlement: paid, jobCap: dollars(5000) }).admit(
      ask({ maxMicroUsd: dollars(1000) }),
    );
    expect(decision.admitted).toBe(false);
    if (decision.admitted) throw new Error('unreachable');
    expect(decision.code).toBe('insufficient_allowance');
  });

  test('a paid invoice cannot override a security suspension', async () => {
    const decision = await gateway({
      entitlement: paid,
      suspended: 'chargeback under review',
    }).admit(ask());
    expect(decision.admitted).toBe(false);
    if (decision.admitted) throw new Error('unreachable');
    expect(decision.code).toBe('security_suspended');
    expect(decision.message).toBe('chargeback under review');
    expect(ledger.summary(ORG, PERIOD).pendingMicroUsd).toBe(0);
  });

  test('a suspension on the company account never holds a person’s own key hostage', async () => {
    const decision = await gateway({
      organizationRoute: 'byo',
      suspended: 'chargeback under review',
    }).admit(ask());
    expect(decision.admitted).toBe(true);
    if (!decision.admitted) throw new Error('unreachable');
    expect(decision.payer).toBe('byo');
  });
});

describe('a client cannot talk its way in', () => {
  test('a body claiming paid access and another company changes nothing', async () => {
    const decision = await gateway().admit(
      ask({
        // These are the fields a forged client would send. The gateway takes
        // the organization from the host's own resolution, never from here.
        paid: true,
        entitlement: { plan: 'business', managedInference: true },
        organizationId: ORG,
      }),
    );
    expect(decision.admitted).toBe(false);
    if (decision.admitted) throw new Error('unreachable');
    expect(decision.code).toBe('no_entitlement');
  });
});

describe('the authorization it hands out', () => {
  async function admitted() {
    const decision = await gateway({ entitlement: paid }).admit(ask());
    if (!decision.admitted) throw new Error(`expected admission, got ${decision.code}`);
    return decision;
  }

  test('an admitted managed call holds money and is bound to its request', async () => {
    const decision = await admitted();
    expect(decision.payer).toBe('managed');
    expect(decision.reservation?.state).toBe('pending');
    expect(ledger.summary(ORG, PERIOD).pendingMicroUsd).toBe(dollars(1));
    expect(
      verifyAuthorization(decision.authorization!, {
        tenantId: TENANT,
        audience: 'codex',
        requestDigest: 'digest-one',
        at: AT,
      }).valid,
    ).toBe(true);
  });

  test('it does not validate for a different request', async () => {
    const decision = await admitted();
    const check = verifyAuthorization(decision.authorization!, {
      tenantId: TENANT,
      audience: 'codex',
      requestDigest: 'digest-two',
      at: AT,
    });
    expect(check.valid).toBe(false);
    expect(check.reason).toMatch(/request/i);
  });

  test('it does not validate for a different tenant', async () => {
    const decision = await admitted();
    const check = verifyAuthorization(decision.authorization!, {
      tenantId: 'tenant_other',
      audience: 'codex',
      requestDigest: 'digest-one',
      at: AT,
    });
    expect(check.valid).toBe(false);
    expect(check.reason).toMatch(/tenant/i);
  });

  test('it does not validate for a different upstream', async () => {
    const decision = await admitted();
    const check = verifyAuthorization(decision.authorization!, {
      tenantId: TENANT,
      audience: 'opencode',
      requestDigest: 'digest-one',
      at: AT,
    });
    expect(check.valid).toBe(false);
  });

  test('it expires', async () => {
    const decision = await admitted();
    const check = verifyAuthorization(decision.authorization!, {
      tenantId: TENANT,
      audience: 'codex',
      requestDigest: 'digest-one',
      at: '2026-09-10T10:00:00.000Z',
    });
    expect(check.valid).toBe(false);
    expect(check.reason).toMatch(/expired/i);
  });
});

describe('the job cap comes from the host, never the caller', () => {
  test('a call with no parent task is its own job, and one dearer than its cap holds nothing', async () => {
    const calls: string[] = [];
    const decision = await gateway({ entitlement: paid, jobCapCalls: calls }).admit(
      ask({ maxMicroUsd: dollars(2.5) }),
    );
    expect(decision.admitted).toBe(false);
    if (decision.admitted) throw new Error('unreachable');
    expect(decision.code).toBe('job_cap_reached');
    // The call's own id names the job.
    expect(calls).toEqual(['res_1']);
    expect(ledger.summary(ORG, PERIOD).pendingMicroUsd).toBe(0);
  });

  test('children and retries under one parent task share its cap and cannot escape it', async () => {
    const calls: string[] = [];
    const g = gateway({ entitlement: paid, jobCapCalls: calls });
    const first = await g.admit(ask({ parentTaskId: 'task_1', reservationId: 'child_1', maxMicroUsd: dollars(1.2) }));
    expect(first.admitted).toBe(true);
    // A retry is a new attempt under the same parent: it counts against the same cap.
    const retry = await g.admit(ask({ parentTaskId: 'task_1', reservationId: 'child_1_retry', maxMicroUsd: dollars(1.2) }));
    expect(retry.admitted).toBe(false);
    if (retry.admitted) throw new Error('unreachable');
    expect(retry.code).toBe('parent_envelope_exceeded');
    expect(calls).toEqual(['task_1', 'task_1']);
    // Another job has its own cap.
    const other = await g.admit(ask({ parentTaskId: 'task_2', reservationId: 'child_2', maxMicroUsd: dollars(1.2) }));
    expect(other.admitted).toBe(true);
  });

  test('an envelope named in the request changes nothing', async () => {
    const forged = { ...ask({ parentTaskId: 'task_1', maxMicroUsd: dollars(3) }), parentEnvelopeMicroUsd: dollars(1000) };
    const decision = await gateway({ entitlement: paid }).admit(forged);
    expect(decision.admitted).toBe(false);
    if (decision.admitted) throw new Error('unreachable');
    expect(decision.code).toBe('parent_envelope_exceeded');
    expect(ledger.summary(ORG, PERIOD).pendingMicroUsd).toBe(0);
  });
});
