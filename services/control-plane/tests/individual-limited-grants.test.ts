import { beforeEach, describe, expect, it } from 'vitest';
import { createFauxCloud, type FauxCloud } from '../src/faux/cloud.js';
import { seedDemo, DEMO_ACCOUNTS, FAUX_DEMO_PASSWORD, type DemoAccount } from '../src/faux/seed.js';

const at = '2026-09-30T15:00:00.000Z', until = '2026-10-30T15:00:00.000Z';
const legacy = ['nectovia-agent', 'maintained-profiles', 'owner-rules', 'phone-relay'];
const current = [...legacy, 'managed-inference'];
const limited = [
  { name: 'Agent only', features: ['nectovia-agent'] },
  { name: 'Agent and managed inference', features: ['nectovia-agent', 'managed-inference'] },
  ...legacy.map(missing => ({ name: `missing ${missing}`, features: current.filter(feature => feature !== missing) })),
];
let cloud: FauxCloud, personId: string, staff: string, customer: string, support: string;
async function token(who: DemoAccount) {
  const response = await cloud.handle(new Request('http://faux.local/auth/sign-in', { method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: DEMO_ACCOUNTS[who].email, password: FAUX_DEMO_PASSWORD }) }));
  expect(response.status).toBe(200);
  return (await response.json()).accessToken as string;
}
async function issue(features: string[], extra: Record<string, unknown> = {}, actor = staff) {
  const response = await cloud.handle(new Request(`http://faux.local/ops/people/${personId}/grants`, { method: 'POST',
    headers: { authorization: `Bearer ${actor}`, 'content-type': 'application/json' },
    body: JSON.stringify({ planId: 'individual', source: 'internal-test', reference: 'Limited access ticket', note: '', features, ...extra }) }));
  return { status: response.status, body: await response.json() as any };
}
beforeEach(async () => {
  cloud = await createFauxCloud({ file: null, now: () => Date.parse(at), passwordIterations: 1_000 });
  await seedDemo(cloud);
  customer = await token('free'); staff = await token('staffBilling'); support = await token('staffSupport');
  personId = (await cloud.accounts.signIn(customer)).person.id;
});

describe('limited Individual issuance', () => {
  it.each(limited)('$name requires an explicit end and issues nothing without it', async ({ features }) => {
    const before = cloud.store.snapshot().commercial;
    expect((await issue(features)).status).toBe(422);
    expect(cloud.store.snapshot().commercial).toEqual(before);
  });

  it.each(limited.filter(row => row.features.includes('nectovia-agent')))('$name keeps its explicit end without a monthly term', async ({ features }) => {
    const end = '2026-12-31T00:00:00.000Z';
    const before = cloud.store.snapshot().funding;
    const issued = await issue(features, { validUntil: end });
    expect(issued.status, JSON.stringify(issued.body)).toBe(201);
    expect(issued.body.grant).toMatchObject({ features, validFrom: at, validUntil: end });
    expect(issued.body.grant.billingCycle).toBeUndefined();
    expect(cloud.store.snapshot().funding).toEqual(before);
  });

  it.each(limited)('$name cannot name a monthly billingCycle, even with matching dates', async ({ features }) => {
    const before = cloud.store.snapshot().commercial;
    expect((await issue(features, { validFrom: at, validUntil: until, billingCycle: { anchorAt: at, index: 0 } })).status).toBe(422);
    expect(cloud.store.snapshot().commercial).toEqual(before);
  });

  it.each([{ name: 'legacy four features', features: legacy }, { name: 'current five features', features: current }])
   ('$name retains monthly issuance without an explicit end', async ({ features }) => {
      const issued = await issue(features);
      expect(issued.status, JSON.stringify(issued.body)).toBe(201);
      expect(issued.body.grant).toMatchObject({ features, validFrom: at, validUntil: until,
        billingCycle: { anchorAt: at, index: 0, startsAt: at, endsAt: until } });
    });

  it.each(['customer', 'support'])('requires grants.write rather than the %s role', async role => {
    const before = cloud.store.snapshot().commercial;
    expect((await issue(['nectovia-agent', 'managed-inference'], { validUntil: until }, role === 'customer' ? customer : support)).status).toBe(403);
    expect(cloud.store.snapshot().commercial).toEqual(before);
  });
});
