import { describe, expect, it, vi } from 'vitest';
import { AccountRoutingSession } from '../server/accounts/routing-session';
import type { AccountSessionService } from '../server/accounts/session';
import type { WorkspaceService } from '../server/workspaces';
import type { EntitlementView } from '../shared/workspaces';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { individualCycle } from '../shared/individual-period';
import { creditAmount } from '../shared/managed-usage';
import { MANAGED_LUNA, NECTOVIA_ROUTE } from '../shared/model-api';
import { EngineService } from '../server/engines/service';
import { AwsConnections } from '../server/engines/aws-bedrock';
import { ConnectionSecrets, testOnlySecretBox } from '../server/connection-secrets';
import { FileModelTranscripts } from '../server/harness/model-transcripts';
import { SpendExposure } from '../server/spend-exposure';
import { EngineError } from '../server/engines/process';
import { ApiError } from '../server/paths';

// Personal work refused from the cached Individual access is confirmed with the account service
// before it is refused, so a re-grant inside the 60 second cache is not held to the old answer.
const PERSON = 'person_1';
const view = (state: EntitlementView['state'], features: string[] = []): EntitlementView => ({
  plan: state === 'none' ? 'none' : 'individual', planLabel: null, state, features, agent: features.includes('nectovia-agent'),
  managedInference: false, validFrom: '2026-09-01T00:00:00.000Z', validUntil: '2026-12-01T00:00:00.000Z', revision: 1,
  source: state === 'none' ? 'none' : 'account-service', reason: state === 'revoked' ? 'Your Individual plan was withdrawn.' : '',
});
const PAID = view('active', ['nectovia-agent']);
const CYCLE = individualCycle('2026-09-15T00:00:00.000Z', 0);
const managedAccess = (): EntitlementView => ({ ...PAID, features: [...PAID.features, 'managed-inference'],
  managedInference: true, validFrom: CYCLE.startsAt, validUntil: CYCLE.endsAt });

function setup(active: 'personal' | 'business' = 'personal') {
  let person: string | null = PERSON;
  let access = view('none');
  let accessFails = false;
  let admission: unknown = null;
  const now = { value: Date.parse('2026-10-01T00:00:00.000Z') };
  const client = {
    individualAccount: vi.fn(async () => ({ id: 'ind_1', personId: PERSON, tenantId: PERSON })),
    scopedAccess: vi.fn(async () => { if (accessFails) throw new Error('offline'); return access; }),
    scopedRoutingPolicy: vi.fn(async () => ({ legacy: false, revision: 1, tiers: {}, validUntil: '2026-12-01T00:00:00.000Z' })),
    admitScopedAgent: vi.fn(async () => admission),
  };
  const session = {
    personId: () => person, backend: { client }, agentPlan: () => 'free',
    call: <T>(fn: (token: string) => Promise<T>) => fn('token'),
    confirmPersonalAdmitted: vi.fn(async () => {}), confirmPersonalDowngrade: vi.fn(async () => {}),
  };
  const workspaces = { projectOwner: () => null, active: () => active === 'personal'
    ? { kind: 'personal' } : { kind: 'business', organizationId: 'org_1' } } as unknown as WorkspaceService;
  const routing = new AccountRoutingSession(session as unknown as AccountSessionService, workspaces, () => now.value);
  const grant = () => ({ admissionId: 'agent_admission_1', validUntil: new Date(now.value + 60_000).toISOString(),
    decision: { admitted: true, planId: 'individual', revision: 1, validUntil: null },
    pins: { scope: { kind: 'individual', id: 'ind_1' }, organizationId: null, tenantId: PERSON, personId: PERSON, planId: 'individual',
      accessRevision: 1, policyRevision: 1, rootJobId: 'job' } });
  return { routing, client, session, now, setPerson: (next: string | null) => { person = next; },
    setActive: (next: 'personal' | 'business') => { active = next; },
    setAccess: (next: EntitlementView) => { access = next; },
    failAccess: (value: boolean) => { accessFails = value; },
    setAdmission: (next: unknown) => { admission = next; }, grant };
}
const work = { phase: 'admit', surface: 'conversation', projectId: null, rootJobId: 'job', routeKind: 'byo' } as const;

describe('a cached Personal refusal is confirmed before it is kept', () => {
  it.each(['expired', 'absent'] as const)('refreshes %s Personal cache before route selection after a re-grant', async state => {
    const t = setup();
    if (state === 'expired') await t.routing.refreshAccess();
    t.setAccess(PAID);
    t.now.value += 61_000;
    expect(await t.routing.confirmedPersonalRefusal(null)).toBeNull();
    expect(t.routing.includes({ kind: 'individual', id: 'ind_1' }, 'nectovia-agent')).toBe(true);
    expect(t.session.confirmPersonalAdmitted).toHaveBeenCalledTimes(1);
  });
  it('lets a re-grant inside the cache window through, and brings the session access along', async () => {
    const t = setup();
    await t.routing.refreshAccess();
    expect(t.routing.personalRefusal(null)).toBeTruthy();
    t.setAccess(PAID);
    t.now.value += 10_000;
    expect(t.routing.personalRefusal(null)).toBeTruthy(); // the cache alone still says no plan
    expect(await t.routing.confirmedPersonalRefusal(null)).toBeNull();
    expect(t.routing.includes({ kind: 'individual', id: 'ind_1' }, 'nectovia-agent')).toBe(true);
    expect(t.routing.mayHaveAgent({ kind: 'individual', id: 'ind_1' })).toBe(true);
    expect(t.session.confirmPersonalAdmitted).toHaveBeenCalledTimes(1);
    expect(t.session.confirmPersonalDowngrade).not.toHaveBeenCalled();
  });

  it('still refuses a person who is still unpaid, and lets the session access follow the refusal', async () => {
    const t = setup();
    await t.routing.refreshAccess();
    const cached = t.routing.personalRefusal(null);
    t.now.value += 10_000;
    t.client.scopedAccess.mockClear();
    expect(await t.routing.confirmedPersonalRefusal(null)).toBe(cached);
    expect(t.client.scopedAccess).toHaveBeenCalledTimes(1);
    expect(t.session.confirmPersonalDowngrade).toHaveBeenCalledWith('entitlement_none');
  });

  it('refuses a revocation seen on the read, with the service reason', async () => {
    const t = setup();
    t.setAccess(view('revoked'));
    await t.routing.refreshAccess();
    expect(await t.routing.confirmedPersonalRefusal(null)).toBe('Your Individual plan was withdrawn.');
    expect(t.session.confirmPersonalDowngrade).toHaveBeenCalledWith('entitlement_revoked');
  });

  it('keeps the refusal when the read fails: an unreadable answer is never an admission', async () => {
    const t = setup();
    await t.routing.refreshAccess();
    const cached = t.routing.personalRefusal(null);
    t.setAccess(PAID);
    t.failAccess(true);
    expect(await t.routing.confirmedPersonalRefusal(null)).toBe(cached);
    expect(t.routing.personalRefusal(null)).toBe(cached);
    expect(t.session.confirmPersonalAdmitted).not.toHaveBeenCalled();
    expect(t.session.confirmPersonalDowngrade).not.toHaveBeenCalled();
  });

  it('keeps a current paid cache without another access read', async () => {
    const t = setup();
    t.setAccess(PAID);
    await t.routing.refreshAccess();
    t.client.scopedAccess.mockClear();
    expect(await t.routing.confirmedPersonalRefusal(null)).toBeNull();
    expect(t.client.scopedAccess).not.toHaveBeenCalled();
  });

  it.each(['business', 'signed out'] as const)('does not discover Personal coverage while %s', async state => {
    const t = setup(state === 'business' ? 'business' : 'personal');
    if (state === 'signed out') t.setPerson(null);
    expect(await t.routing.confirmedPersonalRefusal(null)).toBeNull();
    expect(t.client.individualAccount).not.toHaveBeenCalled();
    expect(t.client.scopedAccess).not.toHaveBeenCalled();
  });
});

describe('Personal refresh failures preserve identity and scope', () => {
  it.each([
    { read: 'scopedAccess', change: 'person' }, { read: 'scopedAccess', change: 'scope' },
    { read: 'individualAccount', change: 'person' }, { read: 'individualAccount', change: 'scope' },
  ] as const)('refuses after $change changes while a deferred $read rejects', async ({ read, change }) => {
    const t = setup();
    if (read === 'scopedAccess') await t.routing.refreshAccess();
    let entered!: () => void, release!: () => void;
    const reached = new Promise<void>(done => { entered = done; });
    const blocked = new Promise<void>(done => { release = done; });
    t.client[read].mockImplementation(async () => { entered(); await blocked; throw new Error('Account service offline'); });
    const pending = t.routing.confirmedPersonalRefusal(null);
    await reached;
    if (change === 'person') t.setPerson('another_person');
    else t.setActive('business');
    release();
    await expect(pending).rejects.toMatchObject({ code: 'ACCOUNT_CHANGED' });
  });

  it('does not swallow an explicit account supersession when the person id is unchanged', async () => {
    const t = setup();
    t.client.individualAccount.mockRejectedValue(new EngineError('ACCOUNT_CHANGED', 'Sign-in was superseded.', false));
    await expect(t.routing.confirmedPersonalRefusal(null)).rejects.toMatchObject({ code: 'ACCOUNT_CHANGED' });
  });

  it('does not swallow the session sign-in refusal', async () => {
    const t = setup();
    t.client.individualAccount.mockRejectedValue(new ApiError(401, 'Sign in again.', { code: 'SIGN_IN_REQUIRED' }));
    await expect(t.routing.confirmedPersonalRefusal(null)).rejects.toMatchObject({ status: 401 });
  });
});

describe('authenticated Individual cycle at the routing client', () => {
  const grant = (t: ReturnType<typeof setup>) => ({ ...t.grant(), billingCycle: CYCLE,
    decision: { admitted: true, planId: 'individual', revision: 1, validUntil: CYCLE.endsAt } });
  const managedWork = { ...work, routeKind: 'managed' } as const;

  it('carries the paid term and accepts a recovery grant narrowed inside it', async () => {
    const t = setup(), validUntil = new Date(t.now.value + 30_000).toISOString();
    t.setAccess({ ...managedAccess(), validFrom: new Date(t.now.value - 1000).toISOString(), validUntil });
    t.setAdmission({ ...grant(t), validUntil, decision: { admitted: true, planId: 'individual', revision: 1, validUntil } });
    await expect(t.routing.admit(managedWork)).resolves.toMatchObject({ billingCycle: CYCLE, validUntil });
  });

  it.each([
    { name: 'malformed cycle', change: (answer: ReturnType<typeof grant>) => ({ ...answer, billingCycle: { ...CYCLE, index: 5 } }) },
    { name: 'wrong person', change: (answer: ReturnType<typeof grant>) => ({ ...answer, pins: { ...answer.pins, personId: 'another_person' } }) },
    { name: 'wrong scope', change: (answer: ReturnType<typeof grant>) => ({ ...answer, pins: { ...answer.pins, scope: { kind: 'individual', id: 'another_account' } } }) },
    { name: 'wrong tenant', change: (answer: ReturnType<typeof grant>) => ({ ...answer, pins: { ...answer.pins, tenantId: 'another_person' } }) },
    { name: 'wrong plan', change: (answer: ReturnType<typeof grant>) => ({ ...answer, decision: { ...answer.decision, planId: 'business' } }) },
    { name: 'admission past term end', change: (answer: ReturnType<typeof grant>) => ({ ...answer, validUntil: new Date(Date.parse(CYCLE.endsAt) + 1).toISOString() }) },
    { name: 'future cycle', change: (answer: ReturnType<typeof grant>) => ({ ...answer, billingCycle: individualCycle(CYCLE.anchorAt, 1) }) },
    { name: 'expired cycle', change: (answer: ReturnType<typeof grant>) => ({ ...answer, billingCycle: individualCycle('2026-08-15T00:00:00.000Z', 0) }) },
  ])('rejects $name without choosing a guard', async ({ change }) => {
    const t = setup();
    t.setAccess(managedAccess());
    t.setAdmission(change(grant(t)));
    await expect(t.routing.admit(managedWork)).rejects.toMatchObject({ code: 'ACCOUNT_CHANGED' });
    expect(t.session.confirmPersonalAdmitted).not.toHaveBeenCalled();
  });

  it.each([
    { name: 'future access', access: { ...managedAccess(), validFrom: '2026-10-02T00:00:00.000Z' } },
    { name: 'expired access', access: { ...managedAccess(), validUntil: '2026-09-30T00:00:00.000Z' } },
    { name: 'missing managed permission', access: { ...managedAccess(), managedInference: false } },
  ])('rejects $name attached to an otherwise valid term', async ({ access }) => {
    const t = setup();
    t.setAccess(access); t.setAdmission(grant(t));
    await expect(t.routing.admit(managedWork)).rejects.toThrow();
    expect(t.session.confirmPersonalAdmitted).not.toHaveBeenCalled();
  });

  it('uses the validated service cycle through EngineService admission and route selection', async () => {
    const t = setup(), dir = await fs.mkdtemp(path.join(os.tmpdir(), 'individual-engine-term-'));
    try {
      t.setAccess(managedAccess()); t.setAdmission(grant(t));
      const policy = { revision: 1, tiers: { efficient: { entryId: 'luna', entryRevision: 1, provider: 'aws-bedrock' as const,
        model: MANAGED_LUNA.model, label: 'Fixture Luna' }, focused: null, thorough: null } };
      const exposure = new SpendExposure(dir); await exposure.init();
      const transcripts = new FileModelTranscripts(path.join(dir, 'transcripts'), NECTOVIA_ROUTE);
      const engine = new EngineService(dir, { discover: async () => [] });
      engine.agentGate = { check: next => t.routing.admit(next) };
      engine.modelApi = { connections: new AwsConnections(dir), secrets: new ConnectionSecrets(dir, testOnlySecretBox()),
        transcripts, exposure, nectovia: { transcripts, now: () => new Date(t.now.value), account: {
          base: 'http://synthetic.local', signedIn: () => true, token: async () => 'synthetic', organizationFor: () => null,
          policy: () => policy, refreshPolicy: async () => policy } } };
      const admit = () => engine.admitModelApi(NECTOVIA_ROUTE, { model: MANAGED_LUNA.model, accountRoute: 'nectovia:ind_1' },
        { surface: 'conversation', rootJobId: 'job' });
      const first = await admit();
      expect(first.managed?.billingCycle).toEqual(CYCLE);
      expect(first.connectionId).toMatch(/-individual-/);
      expect(exposure.summary(first.connectionId).availableMicroUsd).toBe(creditAmount(1000));
      t.now.value = Date.parse('2026-10-10T00:00:00.000Z'); t.setAdmission(grant(t));
      expect((await admit()).connectionId).toBe(first.connectionId);
      const second = individualCycle(CYCLE.anchorAt, 1); t.now.value = Date.parse(second.startsAt);
      t.setAccess({ ...managedAccess(), validFrom: second.startsAt, validUntil: second.endsAt });
      t.setAdmission({ ...grant(t), billingCycle: second, decision: { ...grant(t).decision, validUntil: second.endsAt } });
      const renewed = await admit();
      expect(renewed.connectionId).not.toBe(first.connectionId);
      expect(renewed.managed?.billingCycle).toEqual(second);
      expect(exposure.summary(renewed.connectionId).availableMicroUsd).toBe(creditAmount(1000));
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

describe('admission of Personal work follows the live Individual access', () => {
  it.each([
    { operation: 'confirmation', change: 'person' }, { operation: 'confirmation', change: 'scope' },
    { operation: 'admission', change: 'person' }, { operation: 'admission', change: 'scope' },
  ])('refuses $operation if the $change changes while session access sync waits', async ({ operation, change }) => {
    const t = setup();
    if (operation === 'confirmation') await t.routing.refreshAccess();
    t.setAccess(PAID); t.setAdmission(t.grant());
    let entered!: () => void, release!: () => void;
    const waiting = new Promise<void>(resolve => { entered = resolve; });
    const resume = new Promise<void>(resolve => { release = resolve; });
    t.session.confirmPersonalAdmitted.mockImplementation(async () => { entered(); await resume; });
    const pending = operation === 'confirmation' ? t.routing.confirmedPersonalRefusal(null) : t.routing.admit(work);
    await waiting;
    if (change === 'person') t.setPerson('another_person'); else t.setActive('business');
    release();
    await expect(pending).rejects.toMatchObject({ code: 'ACCOUNT_CHANGED' });
  });

  it('does not finish an old-account refusal after its downgrade sync changes the person', async () => {
    const t = setup(); t.setAccess(view('revoked'));
    t.setAdmission({ ...t.grant(), decision: { admitted: false, code: 'entitlement_revoked', reason: 'Plan revoked.' } });
    t.session.confirmPersonalDowngrade.mockImplementation(async () => { t.setPerson('another_person'); });
    await expect(t.routing.admit(work)).rejects.toMatchObject({ code: 'ACCOUNT_CHANGED' });
  });

  it('admits the next message after a re-grant inside the cache window, with no manual refresh', async () => {
    const t = setup();
    await t.routing.refreshAccess();
    t.setAccess(PAID);
    t.setAdmission(t.grant());
    t.now.value += 10_000;
    await expect(t.routing.admit(work)).resolves.toMatchObject({ admissionId: 'agent_admission_1', personId: PERSON });
    expect(t.session.confirmPersonalAdmitted).toHaveBeenCalled();
  });

  it('refuses a revocation inside the window, on the service answer', async () => {
    const t = setup();
    t.setAccess(PAID);
    await t.routing.refreshAccess();
    t.setAccess(view('revoked'));
    t.setAdmission({ ...t.grant(), decision: { admitted: false, code: 'entitlement_revoked', reason: 'Your Individual plan was withdrawn.' } });
    t.now.value += 10_000;
    await expect(t.routing.admit(work)).rejects.toMatchObject({ refusalCode: 'entitlement_revoked' });
    expect(t.session.confirmPersonalDowngrade).toHaveBeenCalledWith('entitlement_revoked');
  });

  it('refuses without asking the service when the live read says no plan, and the session follows', async () => {
    const t = setup();
    await expect(t.routing.admit(work)).rejects.toMatchObject({ refusalCode: 'agent_not_included' });
    expect(t.client.admitScopedAgent).not.toHaveBeenCalled();
    expect(t.session.confirmPersonalDowngrade).toHaveBeenCalledWith('agent_not_included');
  });

  it('never admits when the read fails: nothing is sent', async () => {
    const t = setup();
    await t.routing.refreshAccess();
    t.setAccess(PAID);
    t.setAdmission(t.grant());
    t.failAccess(true);
    t.now.value += 10_000;
    await expect(t.routing.admit(work)).rejects.toThrow();
    expect(t.client.admitScopedAgent).not.toHaveBeenCalled();
  });
});
