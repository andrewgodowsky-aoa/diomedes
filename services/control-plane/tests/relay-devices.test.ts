/**
 * The phone relay's device records (relay plan step 1) through the Worker's
 * own routes over the faux cloud: who may register a computer, who may stop
 * one, what members see, and what a business without phone access is told.
 */
import { generateKeyPairSync } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { PHONE_RELAY_NOT_INCLUDED_REASON } from '../../../shared/access.js';
import { createFauxCloud, type FauxCloud } from '../src/faux/cloud.js';
import { DEMO_ACCOUNTS, FAUX_DEMO_PASSWORD, seedDemo, type DemoAccount } from '../src/faux/seed.js';
import { RELAY_DEVICE_LIMIT } from '../src/relay/service.js';

let cloud: FauxCloud;
let orgs: { juniper: string; harbor: string };
let clock = Date.parse('2026-09-26T12:00:00.000Z');
const now = () => clock;

async function call(method: string, pathname: string, token?: string, body?: unknown) {
  const headers = new Headers();
  if (token) headers.set('authorization', `Bearer ${token}`);
  if (body !== undefined) headers.set('content-type', 'application/json');
  const response = await cloud.handle(new Request(`http://127.0.0.1:8795${pathname}`, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
  }));
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null, text };
}

const tokens = new Map<DemoAccount, string>();
async function token(who: DemoAccount) {
  const known = tokens.get(who);
  if (known) return known;
  const result = await call('POST', '/auth/sign-in', undefined, { email: DEMO_ACCOUNTS[who].email, password: FAUX_DEMO_PASSWORD });
  expect(result.status).toBe(200);
  tokens.set(who, result.body.accessToken);
  return result.body.accessToken as string;
}

/** A fresh Ed25519 public key, as the desktop registers it: 32 raw bytes in base64url. */
function publicKey(): string {
  const { publicKey: key } = generateKeyPairSync('ed25519');
  return key.export({ format: 'jwk' }).x!;
}

const devices = (organizationId: string) => `/relay/v1/organizations/${organizationId}/devices`;
const register = async (who: DemoAccount, organizationId: string, label = 'Front counter', key = publicKey()) =>
  call('POST', devices(organizationId), await token(who), { publicKey: key, label });
const personId = async (who: DemoAccount, organizationId: string) =>
  (await cloud.accounts.membership(await token(who), organizationId)).person.id;

beforeEach(async () => {
  clock = Date.parse('2026-09-26T12:00:00.000Z');
  tokens.clear();
  cloud = await createFauxCloud({ file: null, now, passwordIterations: 1_000 });
  const seed = await seedDemo(cloud);
  expect(seed.seeded).toBe(true);
  orgs = seed.organizations!;
});

describe('registering a computer for phone access', () => {
  it('lets the Business owner and a Manager register a computer, and refuses an Employee', async () => {
    const key = publicKey();
    const owner = await register('owner', orgs.juniper, 'Front counter', key);
    expect(owner.status).toBe(201);
    expect(owner.body).toEqual({ deviceId: expect.stringMatching(/^relay_device_[0-9a-f-]{36}$/), organizationId: orgs.juniper,
      label: 'Front counter', createdAt: '2026-09-26T12:00:00.000Z' });
    // The answer never echoes the key it was given.
    expect(owner.text).not.toContain(key);

    const manager = await register('manager', orgs.juniper, 'Back office');
    expect(manager.status).toBe(201);

    const employee = await register('employee', orgs.juniper, 'Kitchen tablet');
    expect(employee.status).toBe(403);
    expect(employee.body).toEqual({ code: 'role_not_allowed', error: 'Only the Business owner or a Manager can let a phone reach a computer.' });
    expect(cloud.store.snapshot().relay.devices.map((row) => row.label)).toEqual(['Front counter', 'Back office']);
  });

  it('refuses a business without phone access with the plan sentence, and stores nothing', async () => {
    const harbor = await register('harborOwner', orgs.harbor);
    expect(harbor.status).toBe(403);
    expect(harbor.body).toEqual({ code: 'phone_relay_not_included', error: PHONE_RELAY_NOT_INCLUDED_REASON });
    const list = await call('GET', devices(orgs.harbor), await token('harborOwner'));
    expect(list.status).toBe(403);
    expect(list.body).toEqual({ code: 'phone_relay_not_included', error: PHONE_RELAY_NOT_INCLUDED_REASON });
    expect(cloud.store.snapshot().relay.devices).toEqual([]);
  });

  it('refuses a person outside the business without naming it', async () => {
    for (const who of ['free', 'harborOwner'] as const) {
      const outside = await register(who, orgs.juniper);
      expect(outside.status).toBe(403);
      expect(outside.body.code).toBe('not_a_member');
      expect(outside.text).not.toContain('Juniper');
      const list = await call('GET', devices(orgs.juniper), await token(who));
      expect(list.status).toBe(403);
      expect(list.body.code).toBe('not_a_member');
    }
    expect((await call('POST', devices(orgs.juniper), undefined, { publicKey: publicKey(), label: 'No sign-in' })).status).toBe(401);
  });

  it('reads the role at the moment of registering: a demoted Manager is refused, a removed one is not a member', async () => {
    const owner = await token('owner');
    const manager = await personId('manager', orgs.juniper);
    const demoted = await call('PATCH', `/account/organizations/${orgs.juniper}/members/${manager}`, owner, { role: 'member', state: 'active' });
    expect(demoted.status).toBe(200);
    expect((await register('manager', orgs.juniper)).body.code).toBe('role_not_allowed');
    const removed = await call('PATCH', `/account/organizations/${orgs.juniper}/members/${manager}`, owner, { role: 'member', state: 'revoked' });
    expect(removed.status).toBe(200);
    expect((await register('manager', orgs.juniper)).body.code).toBe('not_a_member');
  });

  it('needs a real Ed25519 public key and a plain name of up to 60 characters', async () => {
    const owner = await token('owner');
    const valid = publicKey();
    const refused = [
      { publicKey: valid.slice(0, 42), label: 'Short key' },
      // 43 characters whose last one sets bits beyond the 32 bytes: not canonical.
      { publicKey: `${'A'.repeat(42)}B`, label: 'Noncanonical key' },
      { publicKey: `${valid.slice(0, 42)}+`, label: 'Not base64url' },
      { publicKey: valid, label: '' },
      { publicKey: valid, label: '   ' },
      { publicKey: valid, label: 'x'.repeat(61) },
      { publicKey: valid, label: 'Bell\u0007' },
      { publicKey: valid, label: 'Front counter', privateKey: 'never sent' },
      { label: 'No key' },
    ];
    for (const input of refused) expect((await call('POST', devices(orgs.juniper), owner, input)).status).toBe(422);
    expect(cloud.store.snapshot().relay.devices).toEqual([]);
    const trimmed = await call('POST', devices(orgs.juniper), owner, { publicKey: valid, label: '  Front counter  ' });
    expect(trimmed.status).toBe(201);
    expect(trimmed.body.label).toBe('Front counter');
  });

  it(`keeps at most ${RELAY_DEVICE_LIMIT} computers per business, and a stopped one frees its place`, async () => {
    const ids: string[] = [];
    for (let index = 0; index < RELAY_DEVICE_LIMIT; index++) {
      const answer = await register('owner', orgs.juniper, `Computer ${index + 1}`);
      expect(answer.status).toBe(201);
      ids.push(answer.body.deviceId);
    }
    const over = await register('owner', orgs.juniper, 'One too many');
    expect(over.status).toBe(409);
    expect(over.body.code).toBe('device_limit');
    expect((await call('DELETE', `${devices(orgs.juniper)}/${ids[0]}`, await token('owner'))).status).toBe(204);
    expect((await register('owner', orgs.juniper, 'Replacement')).status).toBe(201);
  });
});

describe('what members see', () => {
  it('shows every member the name, whether it is online and when it was last seen, and never a key', async () => {
    const ownerKey = publicKey();
    const managerKey = publicKey();
    const ownerDevice = (await register('owner', orgs.juniper, 'Front counter', ownerKey)).body.deviceId;
    clock += 1_000;
    const managerDevice = (await register('manager', orgs.juniper, 'Back office', managerKey)).body.deviceId;

    const employee = await call('GET', devices(orgs.juniper), await token('employee'));
    expect(employee.status).toBe(200);
    expect(employee.body).toEqual({
      organizationId: orgs.juniper,
      checkedAt: '2026-09-26T12:00:01.000Z',
      devices: [
        { deviceId: ownerDevice, label: 'Front counter', online: false, lastSeenAt: null, createdAt: '2026-09-26T12:00:00.000Z', mine: false, canRevoke: false },
        { deviceId: managerDevice, label: 'Back office', online: false, lastSeenAt: null, createdAt: '2026-09-26T12:00:01.000Z', mine: false, canRevoke: false },
      ],
    });
    for (const who of ['owner', 'manager', 'employee'] as const) {
      const list = await call('GET', devices(orgs.juniper), await token(who));
      expect(list.text).not.toContain(ownerKey);
      expect(list.text).not.toContain(managerKey);
      expect(list.text).not.toMatch(/publicKey|public_key/);
    }
    const owner = await call('GET', devices(orgs.juniper), await token('owner'));
    expect(owner.body.devices.map((row: { mine: boolean; canRevoke: boolean }) => [row.mine, row.canRevoke])).toEqual([[true, true], [false, true]]);
    const manager = await call('GET', devices(orgs.juniper), await token('manager'));
    expect(manager.body.devices.map((row: { mine: boolean; canRevoke: boolean }) => [row.mine, row.canRevoke])).toEqual([[false, false], [true, true]]);
  });
});

describe('stopping a computer', () => {
  it('lets the person who turned it on or the Business owner stop it, and keeps the record as a tombstone', async () => {
    const ownerDevice = (await register('owner', orgs.juniper, 'Front counter')).body.deviceId;
    const managerDevice = (await register('manager', orgs.juniper, 'Back office')).body.deviceId;

    for (const who of ['employee', 'manager'] as const) {
      const refused = await call('DELETE', `${devices(orgs.juniper)}/${ownerDevice}`, await token(who));
      expect(refused.status).toBe(403);
      expect(refused.body.code).toBe('role_not_allowed');
    }
    expect((await call('DELETE', `${devices(orgs.juniper)}/${ownerDevice}`, await token('harborOwner'))).body.code).toBe('not_a_member');

    clock += 60_000;
    const stopped = await call('DELETE', `${devices(orgs.juniper)}/${managerDevice}`, await token('owner'));
    expect(stopped.status).toBe(204);
    expect(stopped.text).toBe('');
    const again = await call('DELETE', `${devices(orgs.juniper)}/${managerDevice}`, await token('owner'));
    expect(again.status).toBe(404);
    expect(again.body.code).toBe('device_unknown');
    expect((await call('DELETE', `${devices(orgs.juniper)}/relay_device_never_registered`, await token('owner'))).body.code).toBe('device_unknown');

    const list = await call('GET', devices(orgs.juniper), await token('employee'));
    expect(list.body.devices.map((row: { deviceId: string }) => row.deviceId)).toEqual([ownerDevice]);
    // The row stays, frozen with who stopped it and when.
    const tombstone = cloud.store.snapshot().relay.devices.find((row) => row.deviceId === managerDevice)!;
    expect(tombstone).toMatchObject({ revokedAt: '2026-09-26T12:01:00.000Z', revokedBy: await personId('owner', orgs.juniper), label: 'Back office' });

    // The owner's own computer: stopped by the person who turned it on.
    expect((await call('DELETE', `${devices(orgs.juniper)}/${ownerDevice}`, await token('owner'))).status).toBe(204);
    expect((await call('GET', devices(orgs.juniper), await token('owner'))).body.devices).toEqual([]);
  });

  it('a device id from another business reads as unknown there', async () => {
    const juniperDevice = (await register('owner', orgs.juniper)).body.deviceId;
    // Harbor has no plan, but stopping needs none: the refusal is only that Harbor never had this computer.
    const crossed = await call('DELETE', `${devices(orgs.harbor)}/${juniperDevice}`, await token('harborOwner'));
    expect(crossed.status).toBe(404);
    expect(crossed.body.code).toBe('device_unknown');
    expect(cloud.store.snapshot().relay.devices[0].revokedAt).toBeNull();
  });

  it('still lets a computer be stopped after Billing withdraws the plan, while registering and listing stop', async () => {
    const managerDevice = (await register('manager', orgs.juniper, 'Back office')).body.deviceId;
    const billing = await token('staffBilling');
    const detail = await call('GET', `/ops/customers/${orgs.juniper}`, billing);
    const grantId = detail.body.grants[0].id;
    expect((await call('POST', `/ops/customers/${orgs.juniper}/grants/${grantId}/revoke`, billing, { reason: 'Subscription cancelled.' })).status).toBe(200);

    const registerAfter = await register('owner', orgs.juniper);
    expect(registerAfter.body).toEqual({ code: 'phone_relay_not_included', error: PHONE_RELAY_NOT_INCLUDED_REASON });
    expect((await call('GET', devices(orgs.juniper), await token('owner'))).body.code).toBe('phone_relay_not_included');
    expect((await call('DELETE', `${devices(orgs.juniper)}/${managerDevice}`, await token('manager'))).status).toBe(204);
  });
});
