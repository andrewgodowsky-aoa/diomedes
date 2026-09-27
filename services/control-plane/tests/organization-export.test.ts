/**
 * OPS-05: the business's records, for its owner, over HTTP on the faux cloud
 * (the Worker's own handler over the faux store).
 *
 * The acceptance this file carries: the owner's export holds the people, the
 * plan, the phones' computers, every setup revision and the membership
 * history, and no credential of any kind; a Manager, an Employee, a person
 * outside the business and a former owner are refused; an export changes none
 * of the business's records; the owner is checked again with the records; a
 * history longer than the limit is cut to its newest events and says so.
 */
import { generateKeyPairSync } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { PHONE_RELAY_NOT_INCLUDED_REASON } from '../../../shared/access.js';
import { EXPORT_HISTORY_LIMIT, type OrganizationAccountExport } from '../../../shared/organization-export.js';
import type { OrganizationSetupRecord } from '../../../shared/organization-setup.js';
import type { AccountEvent } from '../src/domain.js';
import { createFauxCloud, type FauxCloud } from '../src/faux/cloud.js';
import { DEMO_ACCOUNTS, FAUX_DEMO_PASSWORD, seedDemo } from '../src/faux/seed.js';
import {
  OrganizationExportError,
  OrganizationExportService,
  type OrganizationExportRepository,
  type OrganizationExportViews,
} from '../src/organization-export/service.js';

const START = Date.parse('2026-09-26T22:00:00.000Z');
let clock = START;
let cloud: FauxCloud;
let juniper: string;
let harbor: string;

async function signIn(email: string): Promise<{ token: string; personId: string }> {
  const pair = await cloud.store.run((draft) => cloud.identity.signIn(draft.identity, { email, password: FAUX_DEMO_PASSWORD, remember: false }));
  const session = await cloud.accounts.signIn(pair.accessToken);
  return { token: pair.accessToken, personId: session.person.id };
}

function call(method: string, path: string, token: string | null, body?: unknown) {
  const headers: Record<string, string> = {};
  if (token) headers.authorization = `Bearer ${token}`;
  if (body !== undefined) headers['content-type'] = 'application/json';
  return cloud.handle(new Request(`http://faux.local${path}`, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
  }));
}

async function ok<T>(response: Promise<Response>): Promise<{ body: T; text: string }> {
  const answer = await response;
  const text = await answer.text();
  expect(answer.status, text).toBeLessThan(300);
  return { body: JSON.parse(text) as T, text };
}

async function refused(response: Promise<Response>, status: number, code: string) {
  const answer = await response;
  const text = await answer.text();
  expect(answer.status, text).toBe(status);
  expect(JSON.parse(text)).toMatchObject({ code });
}

const exportPath = (organizationId: string) => `/account/organizations/${organizationId}/export`;
const setupPath = (organizationId: string) => `/account/organizations/${organizationId}/setup`;
const at = (minutes: number) => new Date(START + minutes * 60_000).toISOString();
const tenantOf = (organizationId: string) =>
  cloud.store.snapshot().accounts.organizations.find((row) => row.record.id === organizationId)!.record.tenantId;

/** A setup record as the desktop would send it. */
function record(organizationId: string, startedBy: string, answers: Record<string, { value: string; by: string; at?: string }>): OrganizationSetupRecord {
  return {
    v: 1,
    setup: {
      v: 1,
      organizationId,
      tenantId: tenantOf(organizationId),
      schemaRevision: 1,
      state: 'drafting',
      answers: Object.fromEntries(Object.entries(answers).map(([id, answer]) => [id, {
        questionId: id, value: answer.value, unknown: false, origin: 'person' as const, at: answer.at ?? at(1), by: answer.by, prompt: `The question called ${id}`,
      }])),
      cursor: 'job',
      startedAt: at(0),
      startedBy,
      updatedAt: at(1),
      proposalDigest: null,
    },
  };
}

/** A fresh Ed25519 public key, as the desktop registers it. */
function publicKey(): string {
  return generateKeyPairSync('ed25519').publicKey.export({ format: 'jwk' }).x!;
}

/** Everything an export must never change: the business's own records. */
function businessRecords() {
  const state = cloud.store.snapshot();
  return JSON.stringify({
    organizations: state.accounts.organizations,
    memberships: state.accounts.memberships,
    events: state.accounts.events,
    setups: state.organizationSetups,
    devices: state.relay.devices,
    commercial: state.commercial,
  });
}

beforeEach(async () => {
  clock = START;
  cloud = await createFauxCloud({ file: null, now: () => clock, passwordIterations: 1_000 });
  const seeded = await seedDemo(cloud);
  juniper = seeded.organizations!.juniper;
  harbor = seeded.organizations!.harbor;
});

describe("the Business owner's export", () => {
  it('holds the people, plan, phones, every setup revision and the history, and no credential', async () => {
    const owner = await signIn(DEMO_ACCOUNTS.owner.email);
    const manager = await signIn(DEMO_ACCOUNTS.manager.email);

    clock = START + 60_000;
    const key = publicKey();
    const device = await ok<{ deviceId: string }>(call('POST', `/relay/v1/organizations/${juniper}/devices`, owner.token, { publicKey: key, label: 'Front counter' }));
    const code = await ok<{ id: string; code: string }>(call('POST', `/account/organizations/${juniper}/invitation-codes`, owner.token,
      { role: 'member', email: 'new.hire@juniper.test', ttlMs: 60 * 60 * 1000 }));
    const invitee = 'user_01INVITEE0EXAMPLE';
    const invitation = await ok<{ token: string }>(call('POST', `/account/organizations/${juniper}/invitations`, owner.token,
      { subject: invitee, role: 'member', ttlMs: 60 * 60 * 1000 }));

    const first = record(juniper, owner.personId, { name: { value: 'Juniper Street Bakery', by: owner.personId } });
    await ok(call('POST', setupPath(juniper), owner.token, { expectedRevision: 0, record: first }));
    clock = START + 2 * 60_000;
    const second = record(juniper, owner.personId, {
      name: { value: 'Juniper Street Bakery', by: owner.personId },
      industry: { value: 'bakery', by: manager.personId, at: at(2) },
    });
    await ok(call('POST', setupPath(juniper), manager.token, { expectedRevision: 1, record: second }));

    clock = START + 3 * 60_000;
    const before = businessRecords();
    const { body, text } = await ok<OrganizationAccountExport>(call('GET', exportPath(juniper), owner.token));
    expect(businessRecords()).toBe(before);

    expect(body).toMatchObject({
      v: 1,
      organization: { id: juniper, name: 'Juniper Street Bakery', tenantId: tenantOf(juniper), createdBy: owner.personId },
      exportedAt: at(3),
      exportedBy: owner.personId,
    });
    expect(body.people.map((person) => [person.name, person.role, person.state]).sort()).toEqual([
      ['Maya Ortiz', 'owner', 'active'], ['Priya Shah', 'member', 'active'], ['Sam Rivera', 'admin', 'active'],
    ]);
    expect(body.invitations).toEqual([{
      id: code.body.id, role: 'member', email: 'new.hire@juniper.test', createdAt: at(1), expiresAt: at(61), invitedBy: owner.personId,
    }]);
    expect(body.access).toMatchObject({ organizationId: juniper, role: 'owner', planId: 'business' });
    expect(body.access.grants!.length).toBeGreaterThan(0);
    expect(body.devices).toEqual({ included: true, devices: [{ deviceId: device.body.deviceId, label: 'Front counter', createdAt: at(1), lastSeenAt: null }] });
    expect(body.setupRevisions.map((row) => [row.revision, row.writtenBy, row.writtenAt])).toEqual([[1, owner.personId, at(1)], [2, manager.personId, at(2)]]);
    expect(body.setupRevisions.map((row) => row.record)).toEqual([first, second]);

    // The history is the business's own, oldest first, complete.
    expect(body.history.complete).toBe(true);
    // The seed writes its events at one instant, so ties are the rule here: by time, then id.
    const order = body.history.events.map((event) => `${event.at} ${event.id}`);
    expect(order).toEqual([...order].sort());
    const kinds = body.history.events.map((event) => event.kind);
    expect(kinds).toEqual(expect.arrayContaining(['organization-created', 'invitation-code-created', 'joined', 'invited']));
    expect(body.history.events.find((event) => event.kind === 'invited')).toMatchObject({ actorPersonId: owner.personId, targetId: null });
    expect(body.history.events.filter((event) => event.kind === 'invitation-code-created').map((event) => event.targetId)).toContain(code.body.id);
    for (const event of body.history.events) expect(Object.keys(event).sort()).toEqual(['actorPersonId', 'at', 'id', 'kind', 'targetId']);

    // No credential, no staff note and no identity-provider id, in any field.
    for (const secret of [owner.token, manager.token, code.body.code, invitation.body.token, key, invitee,
      'Demo business with the Nectovia Agent included.', 'Faux seed'])
      expect(text).not.toContain(secret);
    for (const field of ['tokenHash', 'codeHash', 'publicKey', 'passwordHash', 'subject', 'issuer', 'note', 'reference', 'issuedBy', 'sessionId'])
      expect(text).not.toContain(`"${field}"`);
  });

  it('refuses a Manager, an Employee and a person outside the business, and changes nothing', async () => {
    const manager = await signIn(DEMO_ACCOUNTS.manager.email);
    const employee = await signIn(DEMO_ACCOUNTS.employee.email);
    const outsider = await signIn(DEMO_ACCOUNTS.harborOwner.email);
    const before = businessRecords();
    const managerAnswer = await call('GET', exportPath(juniper), manager.token);
    expect(managerAnswer.status).toBe(403);
    expect(await managerAnswer.json()).toEqual({ code: 'role_not_allowed', error: "Only the Business owner can export the business's records." });
    await refused(call('GET', exportPath(juniper), employee.token), 403, 'role_not_allowed');
    await refused(call('GET', exportPath(juniper), outsider.token), 403, 'not_a_member');
    await refused(call('GET', exportPath('organization_nobody'), outsider.token), 403, 'not_a_member');
    expect(businessRecords()).toBe(before);
  });

  it('refuses a former owner after a transfer, and the new owner keeps their revisions and history', async () => {
    const previous = await signIn(DEMO_ACCOUNTS.owner.email);
    const next = await signIn(DEMO_ACCOUNTS.manager.email);
    const first = record(juniper, previous.personId, { name: { value: 'Juniper Street Bakery', by: previous.personId } });
    await ok(call('POST', setupPath(juniper), previous.token, { expectedRevision: 0, record: first }));

    clock = START + 60_000;
    await ok(call('PATCH', `/account/organizations/${juniper}/members/${next.personId}`, previous.token, { role: 'owner', state: 'active' }));
    clock = START + 2 * 60_000;
    await ok(call('PATCH', `/account/organizations/${juniper}/members/${previous.personId}`, next.token, { role: 'owner', state: 'revoked' }));

    await refused(call('GET', exportPath(juniper), previous.token), 403, 'not_a_member');
    const { body } = await ok<OrganizationAccountExport>(call('GET', exportPath(juniper), next.token));
    expect(body.exportedBy).toBe(next.personId);
    expect(body.setupRevisions).toEqual([{ revision: 1, writtenAt: at(0), writtenBy: previous.personId, record: first }]);
    expect(body.people.find((person) => person.personId === previous.personId)).toMatchObject({ role: 'owner', state: 'revoked', revokedAt: at(2) });
    const changes = body.history.events.filter((event) => event.kind === 'membership-changed');
    expect(changes.map((event) => [event.actorPersonId, event.targetId])).toEqual([[previous.personId, next.personId], [next.personId, previous.personId]]);
  });

  it('says a business without phone access has none, instead of listing phones', async () => {
    const owner = await signIn(DEMO_ACCOUNTS.harborOwner.email);
    const { body } = await ok<OrganizationAccountExport>(call('GET', exportPath(harbor), owner.token));
    expect(body.devices).toEqual({ included: false, reason: PHONE_RELAY_NOT_INCLUDED_REASON });
    expect(body.access).toMatchObject({ planId: null });
    expect(body.people.map((person) => person.name)).toEqual(['Leo Grant']);
    expect(body.invitations).toEqual([]);
    expect(body.setupRevisions).toEqual([]);
    expect(body.history).toEqual({ complete: true, events: [expect.objectContaining({ kind: 'organization-created', targetId: harbor })] });
  });

  it('needs a verified sign-in and takes no query', async () => {
    expect((await call('GET', exportPath(juniper), null)).status).toBe(401);
    const owner = await signIn(DEMO_ACCOUNTS.owner.email);
    expect((await call('GET', `${exportPath(juniper)}?since=2026-01-01`, owner.token)).status).toBe(422);
    expect((await call('POST', exportPath(juniper), owner.token, {})).status).toBe(404);
  });
});

describe('the export service', () => {
  /** The faux services' own views, counting each use. */
  function views(uses: string[]): OrganizationExportViews {
    return {
      access: (token, organizationId) => { uses.push('access'); return cloud.commercial.access(token, organizationId); },
      devices: (token, organizationId) => { uses.push('devices'); return cloud.relay.devices(token, organizationId); },
    };
  }

  it('checks the owner again with the records: one demoted or removed first is refused before anything is read', async () => {
    const owner = await signIn(DEMO_ACCOUNTS.owner.email);
    for (const [change, code] of [[{ role: 'admin' as const }, 'role_not_allowed'], [{ state: 'revoked' as const }, 'not_a_member']] as const) {
      const reads: string[] = [];
      const repository: OrganizationExportRepository = {
        transaction: (action) => cloud.store.organizationExports.transaction((tx) => action({
          member: async (organizationId, personId) => {
            const row = await tx.member(organizationId, personId);
            return row && { ...row, record: { ...row.record, ...change } };
          },
          setupRevisions: (organizationId) => { reads.push('setups'); return tx.setupRevisions(organizationId); },
          history: (organizationId, limit) => { reads.push('history'); return tx.history(organizationId, limit); },
        })),
      };
      const uses: string[] = [];
      const service = new OrganizationExportService(cloud.accounts, views(uses), repository, { now: () => clock });
      const failure = await service.export(owner.token, juniper).catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(OrganizationExportError);
      expect((failure as OrganizationExportError).code).toBe(code);
      expect([...reads, ...uses]).toEqual([]);
    }
  });

  it('keeps the newest events when the history is longer than the limit, and says it is incomplete', async () => {
    const owner = await signIn(DEMO_ACCOUNTS.owner.email);
    const event = (index: number): AccountEvent => ({
      id: `account_event_${String(index).padStart(6, '0')}`,
      at: new Date(START + index * 1000).toISOString(),
      actorPersonId: owner.personId,
      organizationId: juniper,
      kind: 'membership-changed',
      targetId: owner.personId,
    });
    for (const count of [EXPORT_HISTORY_LIMIT, EXPORT_HISTORY_LIMIT + 1]) {
      const asked: number[] = [];
      const repository: OrganizationExportRepository = {
        transaction: (action) => cloud.store.organizationExports.transaction((tx) => action({
          member: (organizationId, personId) => tx.member(organizationId, personId),
          setupRevisions: (organizationId) => tx.setupRevisions(organizationId),
          history: async (_organizationId, limit) => {
            asked.push(limit);
            return Array.from({ length: Math.min(count, limit) }, (_, index) => event(index));
          },
        })),
      };
      const exported = await new OrganizationExportService(cloud.accounts, views([]), repository, { now: () => clock }).export(owner.token, juniper);
      expect(asked).toEqual([EXPORT_HISTORY_LIMIT + 1]);
      expect(exported.history.events).toHaveLength(EXPORT_HISTORY_LIMIT);
      expect(exported.history.complete).toBe(count === EXPORT_HISTORY_LIMIT);
      // Cut from the oldest end: the newest event is always the last one kept.
      expect(exported.history.events.at(-1)!.id).toBe(event(count - 1).id);
      expect(exported.history.events[0].id).toBe(event(count - EXPORT_HISTORY_LIMIT).id);
    }
  });

  it('reads the history oldest first, ties broken by id, and only the business asked for', async () => {
    const history = await cloud.store.organizationExports.transaction((tx) => tx.history(juniper, 1_000));
    const all = cloud.store.snapshot().accounts.events.filter((event) => event.organizationId === juniper);
    expect(history).toHaveLength(all.length);
    expect(history.every((event) => event.organizationId === juniper)).toBe(true);
    const keys = history.map((event) => `${event.at} ${event.id}`);
    expect(keys).toEqual([...keys].sort());
    expect(await cloud.store.organizationExports.transaction((tx) => tx.history(juniper, 2))).toEqual(history.slice(-2));
  });
});
