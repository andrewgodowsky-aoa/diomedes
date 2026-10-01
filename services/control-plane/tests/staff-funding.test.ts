import { beforeEach, describe, expect, it } from 'vitest';
import { CommercialService, type CommercialRepository, type CommercialTransaction, type AuditEvent } from '../src/commercial.js';
import { FundingService } from '../src/funding.js';
import { createFauxCloud, type FauxCloud } from '../src/faux/cloud.js';
import { DEMO_ACCOUNTS, FAUX_DEMO_PASSWORD, seedDemo } from '../src/faux/seed.js';

let cloud: FauxCloud;
let organizationId: string;
let billing: string;
let clock: number;
const request = { requestId: 'correction-1', credits: 10, reason: 'Support ticket 132.' };

async function signIn(who: keyof typeof DEMO_ACCOUNTS) {
  const response = await cloud.handle(new Request('http://faux/auth/sign-in', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: DEMO_ACCOUNTS[who].email, password: FAUX_DEMO_PASSWORD }),
  }));
  return (await response.json()).accessToken as string;
}
async function add(body: unknown = request, token = billing) {
  return cloud.handle(new Request(`http://faux/ops/customers/${organizationId}/funding`, {
    method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }));
}
const added = () => cloud.store.snapshot().commercial.audit.filter(row => row.action === 'funding.added');

beforeEach(async () => {
  clock = Date.parse('2026-09-25T12:00:00Z');
  cloud = await createFauxCloud({ file: null, now: () => clock, passwordIterations: 1000 });
  organizationId = (await seedDemo(cloud)).organizations!.juniper;
  billing = await signIn('staffBilling');
});

describe('DIO-132 authenticated staff funding', () => {
  it('replays one request as one adjustment and one audit', async () => {
    const first = await add();
    expect(first.status).toBe(201);
    const row = await first.json();
    expect((await add()).status).toBe(201);
    expect(cloud.store.snapshot().funding.adjustments).toHaveLength(1);
    expect(added()).toHaveLength(1);
    expect(added()[0].targetId).toBe(row.id);
    expect(added()[0].actorPersonId).toBe((await cloud.accounts.signIn(billing)).person.id);
  });
  it('rejects changed credits or reason for the same request', async () => {
    expect((await add()).status).toBe(201);
    expect((await add({ ...request, credits: 11 })).status).toBe(409);
    expect((await add({ ...request, reason: 'Different ticket.' })).status).toBe(409);
    expect(cloud.store.snapshot().funding.adjustments).toHaveLength(1);
    expect(added()).toHaveLength(1);
  });
  it('serializes concurrent replays', async () => {
    expect((await Promise.all(Array.from({ length: 6 }, () => add()))).map(r => r.status)).toEqual(Array(6).fill(201));
    expect(cloud.store.snapshot().funding.adjustments).toHaveLength(1);
    expect(added()).toHaveLength(1);
  });
  it('allows distinct requests for the same amount', async () => {
    expect((await add()).status).toBe(201);
    expect((await add({ ...request, requestId: 'correction-2' })).status).toBe(201);
    expect(cloud.store.snapshot().funding.adjustments).toHaveLength(2);
    expect(added()).toHaveLength(2);
  });
  it('replays the original period after the calendar changes', async () => {
    expect((await add()).status).toBe(201);
    clock = Date.parse('2026-10-01T00:00:00Z');
    billing = await signIn('staffBilling');
    expect((await add()).status).toBe(201);
    expect(cloud.store.snapshot().funding.adjustments).toHaveLength(1);
    expect(added()).toHaveLength(1);
    expect(cloud.store.snapshot().funding.adjustments[0].periodId).toBe('2026-09');
  });
  it('requires a bounded request identity and current staff authority', async () => {
    expect((await add({ credits: 10, reason: request.reason })).status).toBe(422);
    expect((await add({ ...request, requestId: 'x'.repeat(129) })).status).toBe(422);
    expect((await add(request, await signIn('staffSupport'))).status).toBe(403);
    expect((await add(request, await signIn('owner'))).status).toBe(403);
    expect(cloud.store.snapshot().funding.adjustments).toHaveLength(0);
  });
  it('rolls back grant allocation when its audit insert fails', async () => {
    const failAudit = <T extends Pick<CommercialTransaction, 'audit'>>(tx: T) => new Proxy(tx, { get(target, name) {
      if (name === 'audit') return async (row: AuditEvent) => {
        if (row.action === 'funding.allocated') throw new Error('Injected audit failure');
        return target.audit(row);
      };
      const value = Reflect.get(target, name);
      return typeof value === 'function' ? value.bind(target) : value;
    } });
    const repo: CommercialRepository = { transaction: (action) => cloud.store.commercial.transaction(tx => action(failAudit(tx))) };
    const staffRepo = cloud.store.staffFunding;
    const service = new CommercialService(cloud.accounts, repo, new FundingService(cloud.store.funding, { now: () => clock }), {
      now: () => clock,
      ...(staffRepo ? { staffFunding: { transaction: (action) => staffRepo.transaction((tx) => action(failAudit(tx))) } } : {}),
    });
    const harbor = (await cloud.commercial.customers(billing)).find(row => row.organization.name === 'Harbor Hardware')!.organization.id;
    const result = await service.issueGrant(billing, harbor, { planId: 'business', source: 'subscription', reference: 'fixture invoice', note: 'Test allocation.' });
    expect(result.funding.allocated).toBe(false);
    expect(cloud.store.snapshot().funding.periods.filter(row => row.organizationId === harbor)).toHaveLength(0);
    expect(cloud.store.snapshot().commercial.audit.filter(row => row.action === 'funding.allocated' && row.organizationId === harbor)).toHaveLength(0);
  });
  it('rolls back a correction when its audit insert fails', async () => {
    const service = new CommercialService(cloud.accounts, cloud.store.commercial, null, {
      now: () => clock, staffFunding: { transaction: action => cloud.store.staffFunding.transaction(tx => action(new Proxy(tx, {
        get(target, name) {
          if (name === 'audit') return async () => { throw new Error('Injected correction audit failure'); };
          const value = Reflect.get(target, name);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      }))) },
    });
    await expect(service.addFunding(billing, organizationId, request)).rejects.toThrow('Injected correction audit failure');
    expect(cloud.store.snapshot().funding.adjustments).toHaveLength(0);
    expect(added()).toHaveLength(0);
  });
  it('reuses the committed receipt after the client loses the commit response', async () => {
    let loseResponse = true;
    const service = new CommercialService(cloud.accounts, cloud.store.commercial, null, {
      now: () => clock, staffFunding: { async transaction(action) {
        const row = await cloud.store.staffFunding.transaction(action);
        if (loseResponse) { loseResponse = false; throw new Error('Lost commit response'); }
        return row;
      } },
    });
    await expect(service.addFunding(billing, organizationId, request)).rejects.toThrow('Lost commit response');
    const replay = await service.addFunding(billing, organizationId, request);
    expect(cloud.store.snapshot().funding.adjustments).toHaveLength(1);
    expect(added()).toHaveLength(1);
    expect(replay.id).toBe(added()[0].targetId);
  });
  it('rechecks disabled staff even when replaying a committed request', async () => {
    expect((await add()).status).toBe(201);
    const person = (await cloud.accounts.signIn(billing)).person.id;
    await cloud.commercial.changeStaff(await signIn('staffAdmin'), person, { role: 'billing', state: 'disabled' });
    expect((await add()).status).toBe(403);
    expect(cloud.store.snapshot().funding.adjustments).toHaveLength(1);
    expect(added()).toHaveLength(1);
  });
  it('refuses plainly without the dedicated writer and never falls back to runtime', async () => {
    const service = new CommercialService(cloud.accounts, cloud.store.commercial, new FundingService(cloud.store.funding));
    await expect(service.addFunding(billing, organizationId, request)).rejects.toMatchObject({ status: 503, code: 'staff_funding_unavailable' });
    expect(cloud.store.snapshot().funding.adjustments).toHaveLength(0);
  });
  it('keeps independent actor and organization request scopes separate', async () => {
    expect((await add()).status).toBe(201);
    expect((await add(request, await signIn('staffAdmin'))).status).toBe(201);
    expect(new Set(cloud.store.snapshot().funding.adjustments.map(row => row.id)).size).toBe(2);
    expect(new Set(added().map(row => row.actorPersonId)).size).toBe(2);
  });
});
