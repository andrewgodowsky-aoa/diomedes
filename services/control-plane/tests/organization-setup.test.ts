/**
 * ORG-01: a business's setup kept by the account service, over HTTP on the
 * faux cloud (the Worker's own handler over the faux store).
 *
 * The acceptance this file carries: a second sign-in reads the same setup; an
 * Employee reads but cannot change it; two computers saving from the same
 * revision conflict instead of overwriting; an owner transfer keeps every
 * revision and the previous owner's answers as theirs; a revoked person reads
 * nothing; credentials and put-words-in-mouth attribution are refused.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { createFauxCloud, type FauxCloud } from '../src/faux/cloud.js';
import { DEMO_ACCOUNTS, FAUX_DEMO_PASSWORD, seedDemo } from '../src/faux/seed.js';
import type { OrganizationSetupAnswer, OrganizationSetupRecord } from '../../../shared/organization-setup.js';

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

function call(method: string, path: string, token: string, body?: unknown) {
  return cloud.handle(new Request(`http://faux.local${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  }));
}

async function ok<T>(response: Promise<Response>): Promise<T> {
  const answer = await response;
  const text = await answer.text();
  expect(answer.status, text).toBeLessThan(300);
  return JSON.parse(text) as T;
}

async function refused(response: Promise<Response>, status: number, code: string) {
  const answer = await response;
  const text = await answer.text();
  expect(answer.status, text).toBe(status);
  expect(JSON.parse(text)).toMatchObject({ code });
}

const tenantOf = (organizationId: string) =>
  cloud.store.snapshot().accounts.organizations.find((row) => row.record.id === organizationId)!.record.tenantId;

const at = (minutes: number) => new Date(START + minutes * 60_000).toISOString();

/** A setup record as the desktop would send it. */
function record(
  organizationId: string,
  startedBy: string,
  answers: Record<string, { value: string | string[] | number | null; by: string; at?: string; unknown?: boolean }>,
  options: { cursor?: string; state?: 'drafting' | 'proposal-ready' } = {},
): OrganizationSetupRecord {
  return {
    v: 1,
    setup: {
      v: 1,
      organizationId,
      tenantId: tenantOf(organizationId),
      schemaRevision: 1,
      state: options.state ?? 'drafting',
      answers: Object.fromEntries(Object.entries(answers).map(([id, answer]) => [id, {
        questionId: id,
        value: answer.value,
        unknown: answer.unknown ?? false,
        origin: 'person' as const,
        at: answer.at ?? at(1),
        by: answer.by,
        prompt: `The question called ${id}`,
      }])),
      cursor: options.cursor ?? 'job',
      startedAt: at(0),
      startedBy,
      updatedAt: at(1),
      proposalDigest: null,
    },
  };
}

const setupPath = (organizationId: string) => `/account/organizations/${organizationId}/setup`;

beforeEach(async () => {
  clock = START;
  cloud = await createFauxCloud({ file: null, now: () => clock, passwordIterations: 1_000 });
  const seeded = await seedDemo(cloud);
  juniper = seeded.organizations!.juniper;
  harbor = seeded.organizations!.harbor;
});

describe('a business setup kept for the organization', () => {
  it('reads as revision 0 before anyone saves one, to any member, with nothing invented', async () => {
    const owner = await signIn(DEMO_ACCOUNTS.owner.email);
    const employee = await signIn(DEMO_ACCOUNTS.employee.email);
    for (const who of [owner, employee]) {
      const answer = await ok<OrganizationSetupAnswer>(call('GET', setupPath(juniper), who.token));
      expect(answer).toEqual({
        organizationId: juniper, tenantId: tenantOf(juniper), revision: 0, record: null, writtenAt: null, writtenBy: null,
      });
    }
  });

  it('the owner saves revision 1 and a second sign-in (another computer) reads exactly it', async () => {
    const first = await signIn(DEMO_ACCOUNTS.owner.email);
    const saved = record(juniper, first.personId, { name: { value: 'Juniper Street Bakery, a bakery', by: first.personId } });
    clock = START + 60_000;
    const written = await ok<OrganizationSetupAnswer>(call('POST', setupPath(juniper), first.token, { expectedRevision: 0, record: saved }));
    expect(written).toMatchObject({ revision: 1, writtenBy: first.personId, writtenAt: at(1) });
    expect(written.record).toEqual(saved);

    const second = await signIn(DEMO_ACCOUNTS.owner.email);
    expect(second.token).not.toBe(first.token);
    const read = await ok<OrganizationSetupAnswer>(call('GET', setupPath(juniper), second.token));
    expect(read).toEqual(written);
  });

  it('an Employee reads the setup the owners made but cannot change it; a Manager can', async () => {
    const owner = await signIn(DEMO_ACCOUNTS.owner.email);
    const manager = await signIn(DEMO_ACCOUNTS.manager.email);
    const employee = await signIn(DEMO_ACCOUNTS.employee.email);
    const first = record(juniper, owner.personId, { name: { value: 'Juniper', by: owner.personId } });
    await ok(call('POST', setupPath(juniper), owner.token, { expectedRevision: 0, record: first }));

    expect((await ok<OrganizationSetupAnswer>(call('GET', setupPath(juniper), employee.token))).record).toEqual(first);
    const byEmployee = record(juniper, owner.personId, {
      name: { value: 'Juniper', by: owner.personId },
      industry: { value: 'bakery', by: employee.personId },
    });
    await refused(call('POST', setupPath(juniper), employee.token, { expectedRevision: 1, record: byEmployee }), 403, 'role_not_allowed');

    const byManager = record(juniper, owner.personId, {
      name: { value: 'Juniper', by: owner.personId },
      industry: { value: 'bakery', by: manager.personId },
    });
    const written = await ok<OrganizationSetupAnswer>(call('POST', setupPath(juniper), manager.token, { expectedRevision: 1, record: byManager }));
    expect(written).toMatchObject({ revision: 2, writtenBy: manager.personId });
  });

  it('a person outside the business can neither read nor write its setup', async () => {
    const outsider = await signIn(DEMO_ACCOUNTS.harborOwner.email);
    await refused(call('GET', setupPath(juniper), outsider.token), 403, 'not_a_member');
    const forged = record(juniper, outsider.personId, { name: { value: 'Not mine', by: outsider.personId } });
    await refused(call('POST', setupPath(juniper), outsider.token, { expectedRevision: 0, record: forged }), 403, 'not_a_member');
    expect(cloud.store.snapshot().organizationSetups).toEqual([]);
  });

  it('two computers saving from the same revision: the second is a conflict and writes nothing', async () => {
    const owner = await signIn(DEMO_ACCOUNTS.owner.email);
    const manager = await signIn(DEMO_ACCOUNTS.manager.email);
    await ok(call('POST', setupPath(juniper), owner.token, {
      expectedRevision: 0, record: record(juniper, owner.personId, { name: { value: 'Juniper', by: owner.personId } }),
    }));
    const fromOwner = record(juniper, owner.personId, {
      name: { value: 'Juniper', by: owner.personId }, industry: { value: 'bakery', by: owner.personId, at: at(2) },
    });
    const fromManager = record(juniper, owner.personId, {
      name: { value: 'Juniper', by: owner.personId }, industry: { value: 'cafe', by: manager.personId, at: at(2) },
    });
    await ok(call('POST', setupPath(juniper), owner.token, { expectedRevision: 1, record: fromOwner }));
    await refused(call('POST', setupPath(juniper), manager.token, { expectedRevision: 1, record: fromManager }), 409, 'setup_conflict');
    const rows = cloud.store.snapshot().organizationSetups;
    expect(rows.map((row) => row.revision)).toEqual([1, 2]);
    expect((await ok<OrganizationSetupAnswer>(call('GET', setupPath(juniper), manager.token))).record).toEqual(fromOwner);
    // A write from an older revision is a conflict too, never a rewrite of history.
    await refused(call('POST', setupPath(juniper), owner.token, { expectedRevision: 0, record: fromOwner }), 409, 'setup_conflict');
  });

  it('an owner transfer keeps every revision, and the previous owner keeps their answers', async () => {
    const previous = await signIn(DEMO_ACCOUNTS.owner.email);
    const next = await signIn(DEMO_ACCOUNTS.manager.email);
    const first = record(juniper, previous.personId, {
      name: { value: 'Juniper Street Bakery', by: previous.personId },
      result: { value: 'A Monday order summary the owner checks', by: previous.personId },
    });
    await ok(call('POST', setupPath(juniper), previous.token, { expectedRevision: 0, record: first }));

    // Ownership moves: the Manager becomes an owner, then removes the previous owner.
    await ok(call('PATCH', `/account/organizations/${juniper}/members/${next.personId}`, previous.token, { role: 'owner', state: 'active' }));
    await ok(call('PATCH', `/account/organizations/${juniper}/members/${previous.personId}`, next.token, { role: 'owner', state: 'revoked' }));

    const kept = await ok<OrganizationSetupAnswer>(call('GET', setupPath(juniper), next.token));
    expect(kept).toMatchObject({ revision: 1, writtenBy: previous.personId });
    expect(kept.record).toEqual(first);

    // The new owner changes one answer; the other stays the previous owner's.
    const changed = record(juniper, previous.personId, {
      name: { value: 'Juniper Street Bakery', by: previous.personId },
      result: { value: 'A Monday order summary the new owner checks', by: next.personId, at: at(5) },
    });
    const written = await ok<OrganizationSetupAnswer>(call('POST', setupPath(juniper), next.token, { expectedRevision: 1, record: changed }));
    expect(written.record!.setup.answers.name.by).toBe(previous.personId);
    expect(written.record!.setup.answers.result.by).toBe(next.personId);

    // The previous owner, now removed, reads nothing.
    await refused(call('GET', setupPath(juniper), previous.token), 403, 'not_a_member');
    const history = cloud.store.snapshot().organizationSetups.filter((row) => row.organizationId === juniper);
    expect(history.map((row) => [row.revision, row.writtenBy])).toEqual([[1, previous.personId], [2, next.personId]]);
    expect(history[0].record).toEqual(first);
  });

  it('a Manager demoted to Employee can no longer change the setup', async () => {
    const owner = await signIn(DEMO_ACCOUNTS.owner.email);
    const manager = await signIn(DEMO_ACCOUNTS.manager.email);
    await ok(call('PATCH', `/account/organizations/${juniper}/members/${manager.personId}`, owner.token, { role: 'member', state: 'active' }));
    const attempt = record(juniper, manager.personId, { name: { value: 'Juniper', by: manager.personId } });
    await refused(call('POST', setupPath(juniper), manager.token, { expectedRevision: 0, record: attempt }), 403, 'role_not_allowed');
  });

  it('a changed answer must be the writer\'s own, and who started the setup cannot change', async () => {
    const owner = await signIn(DEMO_ACCOUNTS.owner.email);
    const manager = await signIn(DEMO_ACCOUNTS.manager.email);
    // A new setup is started by the person saving it.
    await refused(call('POST', setupPath(juniper), manager.token, {
      expectedRevision: 0, record: record(juniper, owner.personId, { name: { value: 'Juniper', by: manager.personId } }),
    }), 422, 'setup_attribution');
    await ok(call('POST', setupPath(juniper), owner.token, {
      expectedRevision: 0, record: record(juniper, owner.personId, { name: { value: 'Juniper', by: owner.personId } }),
    }));
    // The Manager cannot put a changed answer in the owner's name.
    await refused(call('POST', setupPath(juniper), manager.token, {
      expectedRevision: 1, record: record(juniper, owner.personId, { name: { value: 'Juniper Bakery', by: owner.personId, at: at(3) } }),
    }), 422, 'setup_attribution');
    // Nor claim the setup was started by someone else.
    await refused(call('POST', setupPath(juniper), manager.token, {
      expectedRevision: 1, record: record(juniper, manager.personId, { name: { value: 'Juniper', by: owner.personId } }),
    }), 422, 'setup_attribution');
    expect(cloud.store.snapshot().organizationSetups).toHaveLength(1);
  });

  it('refuses an answer that looks like a credential, a record for another business and unexpected fields', async () => {
    const owner = await signIn(DEMO_ACCOUNTS.owner.email);
    const withKey = record(juniper, owner.personId, { host: { value: 'The office PC. api_key=sk_live_0123456789abcdefghijkl', by: owner.personId } });
    await refused(call('POST', setupPath(juniper), owner.token, { expectedRevision: 0, record: withKey }), 422, 'setup_secret_like');
    const card = record(juniper, owner.personId, { host: { value: 'Pay with 4111 1111 1111 1111', by: owner.personId } });
    await refused(call('POST', setupPath(juniper), owner.token, { expectedRevision: 0, record: card }), 422, 'setup_secret_like');

    const harborOwner = await signIn(DEMO_ACCOUNTS.harborOwner.email);
    const elsewhere = record(harbor, harborOwner.personId, { name: { value: 'Harbor', by: owner.personId } });
    await refused(call('POST', setupPath(juniper), owner.token, { expectedRevision: 0, record: elsewhere }), 422, 'setup_wrong_organization');

    const extra = { ...record(juniper, owner.personId, { name: { value: 'Juniper', by: owner.personId } }), grants: ['send-email'] };
    const response = await call('POST', setupPath(juniper), owner.token, { expectedRevision: 0, record: extra });
    expect(response.status).toBe(422);
    const smuggled = record(juniper, owner.personId, { name: { value: 'Juniper', by: owner.personId } });
    (smuggled.setup as unknown as Record<string, unknown>).permissions = ['payroll-write'];
    expect((await call('POST', setupPath(juniper), owner.token, { expectedRevision: 0, record: smuggled })).status).toBe(422);
    expect(cloud.store.snapshot().organizationSetups).toEqual([]);
  });

  it('never rewrites a revision, even from inside the store', async () => {
    const owner = await signIn(DEMO_ACCOUNTS.owner.email);
    const first = record(juniper, owner.personId, { name: { value: 'Juniper', by: owner.personId } });
    await ok(call('POST', setupPath(juniper), owner.token, { expectedRevision: 0, record: first }));
    const row = cloud.store.snapshot().organizationSetups[0];
    await expect(cloud.store.organizationSetups.transaction((tx) => tx.insert({ ...row, writtenAt: at(9) }))).rejects.toThrow('written once');
    expect(cloud.store.snapshot().organizationSetups).toEqual([row]);
  });

  it('needs a verified sign-in', async () => {
    const response = await cloud.handle(new Request(`http://faux.local${setupPath(juniper)}`));
    expect(response.status).toBe(401);
  });

  it('carries a setup forward to newer questions and refuses one that would take it back (ORG-02)', async () => {
    const owner = await signIn(DEMO_ACCOUNTS.owner.email);
    const underTwo = (setup: OrganizationSetupRecord) => ({ ...setup, setup: { ...setup.setup, schemaRevision: 2 } });
    const first = record(juniper, owner.personId, { name: { value: 'Juniper', by: owner.personId } });
    await ok(call('POST', setupPath(juniper), owner.token, { expectedRevision: 0, record: first }));
    // A newer desktop carries it to revision 2 of the questions.
    await ok(call('POST', setupPath(juniper), owner.token, { expectedRevision: 1, record: underTwo(first) }));

    // A desktop that only knows revision 1 resumes it with no answers: refused, nothing written.
    const emptied = record(juniper, owner.personId, {});
    await refused(call('POST', setupPath(juniper), owner.token, { expectedRevision: 2, record: emptied }), 409, 'setup_newer');
    const rows = cloud.store.snapshot().organizationSetups;
    expect(rows.map((row) => [row.revision, row.record.setup.schemaRevision])).toEqual([[1, 1], [2, 2]]);
    expect(rows[1]!.record.setup.answers.name?.value).toBe('Juniper');
  });
});
