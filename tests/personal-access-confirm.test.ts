import { describe, expect, it, vi } from 'vitest';
import { AccountRoutingSession } from '../server/accounts/routing-session';
import type { AccountSessionService } from '../server/accounts/session';
import type { WorkspaceService } from '../server/workspaces';
import type { EntitlementView } from '../shared/workspaces';

// Personal work refused from the cached Individual access is confirmed with the account service
// before it is refused, so a re-grant inside the 60 second cache is not held to the old answer.
const PERSON = 'person_1';
const view = (state: EntitlementView['state'], features: string[] = []): EntitlementView => ({
  plan: state === 'none' ? 'none' : 'individual', planLabel: null, state, features, agent: features.includes('nectovia-agent'),
  managedInference: false, validFrom: '2026-09-01T00:00:00.000Z', validUntil: '2026-12-01T00:00:00.000Z', revision: 1,
  source: state === 'none' ? 'none' : 'account-service', reason: state === 'revoked' ? 'Your Individual plan was withdrawn.' : '',
});
const PAID = view('active', ['nectovia-agent']);

function setup() {
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
    personId: () => PERSON, backend: { client }, agentPlan: () => 'free',
    call: <T>(fn: (token: string) => Promise<T>) => fn('token'),
    confirmPersonalAdmitted: vi.fn(async () => {}), confirmPersonalDowngrade: vi.fn(async () => {}),
  };
  const workspaces = { projectOwner: () => null, active: () => ({ kind: 'personal' }) } as unknown as WorkspaceService;
  const routing = new AccountRoutingSession(session as unknown as AccountSessionService, workspaces, () => now.value);
  const grant = () => ({ admissionId: 'agent_admission_1', validUntil: new Date(now.value + 60_000).toISOString(),
    decision: { admitted: true, planId: 'individual', revision: 1, validUntil: null },
    pins: { scope: { kind: 'individual', id: 'ind_1' }, organizationId: null, tenantId: PERSON, personId: PERSON, planId: 'individual',
      accessRevision: 1, policyRevision: 1, rootJobId: 'job' } });
  return { routing, client, session, now,
    setAccess: (next: EntitlementView) => { access = next; },
    failAccess: (value: boolean) => { accessFails = value; },
    setAdmission: (next: unknown) => { admission = next; }, grant };
}
const work = { phase: 'admit', surface: 'conversation', projectId: null, rootJobId: 'job', routeKind: 'byo' } as const;

describe('a cached Personal refusal is confirmed before it is kept', () => {
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

  it('does not read anything when nothing is cached to refuse, or the person is paid', async () => {
    const t = setup();
    expect(await t.routing.confirmedPersonalRefusal(null)).toBeNull();
    expect(t.client.scopedAccess).not.toHaveBeenCalled();
    t.setAccess(PAID);
    await t.routing.refreshAccess();
    t.client.scopedAccess.mockClear();
    expect(await t.routing.confirmedPersonalRefusal(null)).toBeNull();
    expect(t.client.scopedAccess).not.toHaveBeenCalled();
  });
});

describe('admission of Personal work follows the live Individual access', () => {
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
