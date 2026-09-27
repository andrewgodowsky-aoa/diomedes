/**
 * ORG-01 on the desktop: what a computer shows and keeps for a business's setup.
 *
 * The decision (`decideSetupLoad`) is pure and tested directly. The sync runs
 * against a fake account service that keeps revisions with the same
 * compare-and-set and the same record screening (`screenSetupRecord`) the
 * control plane applies, and answers with its keys in another order, as the
 * service's database does. The control plane's own suite covers the service.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { BusinessAnswer, BusinessSetup } from '../shared/business-setup.js';
import {
  decideSetupLoad,
  screenSetupRecord,
  SETUP_CACHED_REASON,
  SETUP_UNREACHABLE_REASON,
  type OrganizationSetupAnswer,
  type OrganizationSetupWrite,
  type SetupCacheTag,
  type SetupCopy,
  type SetupFetchOutcome,
} from '../shared/organization-setup.js';
import {
  OrganizationSetupSync,
  SETUP_SAVE_CONFLICT,
  SetupConflict,
  type SetupRemote,
  type SetupSubject,
} from '../server/organization-setup.js';
import { ApiError } from '../server/paths.js';

const ORG = 'org_juniper';
const TENANT = 'tenant_juniper';
const OWNER = 'person_owner';
const MANAGER = 'person_manager';
const EMPLOYEE = 'person_employee';
const T0 = '2026-09-26T12:00:00.000Z';
const FETCHED = '2026-09-26T13:00:00.000Z';

const answer = (questionId: string, value: string, by: string): BusinessAnswer => ({
  questionId,
  value,
  unknown: false,
  origin: 'person',
  at: T0,
  by,
});

function setup(answers: BusinessAnswer[], startedBy = OWNER, overrides: Partial<BusinessSetup> = {}): BusinessSetup {
  return {
    v: 1,
    organizationId: ORG,
    tenantId: TENANT,
    schemaRevision: 1,
    state: 'drafting',
    answers: Object.fromEntries(answers.map((item) => [item.questionId, item])),
    cursor: 'industry',
    startedAt: T0,
    startedBy,
    updatedAt: T0,
    proposalDigest: null,
    ...overrides,
  };
}

/** The same object with its keys in the opposite order. */
const reversed = <T extends object>(value: T): T => Object.fromEntries(Object.entries(value).reverse()) as T;

type Mode = 'up' | 'unreachable' | 'unsupported' | { refused: string };

function fakeService() {
  const revisions: { revision: number; setup: BusinessSetup; writtenBy: string }[] = [];
  const state = {
    mode: 'up' as Mode,
    /** The verified person every write through `remote` is made as. */
    writer: OWNER,
    writes: [] as OrganizationSetupWrite[],
    /** Runs once inside the next write, before the service decides: someone acting in between. */
    interleave: null as null | (() => void),
    revisions,
  };
  const current = (): OrganizationSetupAnswer => {
    const last = revisions.at(-1);
    return {
      organizationId: ORG,
      tenantId: TENANT,
      revision: last?.revision ?? 0,
      record: last ? { v: 1, setup: reversed(structuredClone(last.setup)) } : null,
      writtenAt: last ? T0 : null,
      writtenBy: last?.writtenBy ?? null,
    };
  };
  const failure = (): Exclude<SetupFetchOutcome, { kind: 'answered' }> | null => {
    if (state.mode === 'unreachable') return { kind: 'unreachable', message: 'The account service could not be reached.' };
    if (state.mode === 'unsupported') return { kind: 'unsupported' };
    if (typeof state.mode === 'object') return { kind: 'refused', code: state.mode.refused, message: `Refused: ${state.mode.refused}.` };
    return null;
  };
  const remote: SetupRemote = {
    async read(organizationId) {
      expect(organizationId).toBe(ORG);
      return failure() ?? { kind: 'answered', answer: current() };
    },
    async write(organizationId, input) {
      expect(organizationId).toBe(ORG);
      state.writes.push(structuredClone(input));
      const between = state.interleave;
      state.interleave = null;
      between?.();
      const failed = failure();
      if (failed) return failed;
      const last = revisions.at(-1);
      if (input.expectedRevision !== (last?.revision ?? 0)) return { kind: 'conflict', message: 'A newer revision exists.' };
      const refusal = screenSetupRecord(input.record, {
        organizationId: ORG,
        tenantId: TENANT,
        writer: state.writer,
        previous: last ? { v: 1, setup: last.setup } : null,
      });
      if (refusal) return { kind: 'refused', code: `setup_${refusal.code.replace('-', '_')}`, message: refusal.message };
      revisions.push({ revision: (last?.revision ?? 0) + 1, setup: structuredClone(input.record.setup), writtenBy: state.writer });
      return { kind: 'written', answer: current() };
    },
  };
  /** Another computer saving the next revision. */
  const saveElsewhere = (value: BusinessSetup, by = OWNER) => {
    revisions.push({ revision: (revisions.at(-1)?.revision ?? 0) + 1, setup: structuredClone(value), writtenBy: by });
  };
  return { remote, state, saveElsewhere };
}

let dir: string;
let service: ReturnType<typeof fakeService>;
let sync: OrganizationSetupSync;
const owner: SetupSubject = { organizationId: ORG, tenantId: TENANT, personId: OWNER, generation: 3, mayConfigure: true };
const first = setup([answer('name', 'Juniper Street Bakery', OWNER)]);
const second = setup([answer('name', 'Juniper Street Bakery', OWNER), answer('industry', 'bakery', OWNER)], OWNER, {
  cursor: 'review',
});

const file = (name: string) => path.join(dir, name);
const json = async (name: string) => JSON.parse(await fs.readFile(file(name), 'utf8')) as unknown;
const exists = (name: string) => fs.access(file(name)).then(() => true, () => false);
const listing = async () => (await fs.readdir(dir)).sort();
const place = (name: string, value: unknown) =>
  fs.writeFile(file(name), typeof value === 'string' ? value : JSON.stringify(value));

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nectovia-organization-setup-'));
  service = fakeService();
  sync = new OrganizationSetupSync(dir, service.remote, () => new Date(FETCHED));
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe('what a computer shows for a business setup', () => {
  const tag: SetupCacheTag = { v: 1, organizationId: ORG, tenantId: TENANT, personId: OWNER, generation: 3, revision: 2, fetchedAt: T0 };
  const copy = { tag, setup: first };
  const who = { organizationId: ORG, tenantId: TENANT, personId: OWNER, generation: 3 };
  const answered = (value: Partial<OrganizationSetupAnswer>): SetupFetchOutcome => ({
    kind: 'answered',
    answer: { organizationId: ORG, tenantId: TENANT, revision: 0, record: null, writtenAt: null, writtenBy: null, ...value },
  });
  const unreachable: SetupFetchOutcome = { kind: 'unreachable', message: 'The account service could not be reached.' };

  it("takes the service's answer, including that nothing is stored yet", () => {
    expect(decideSetupLoad({ ...who, fetched: answered({}), copy })).toEqual({
      kind: 'service',
      revision: 0,
      setup: null,
      writtenAt: null,
      writtenBy: null,
    });
    expect(
      decideSetupLoad({ ...who, fetched: answered({ revision: 4, record: { v: 1, setup: second }, writtenAt: T0, writtenBy: MANAGER }), copy }),
    ).toEqual({ kind: 'service', revision: 4, setup: second, writtenAt: T0, writtenBy: MANAGER });
  });

  it('loads nothing from an answer about a different business', () => {
    const wrong: Partial<OrganizationSetupAnswer>[] = [
      { organizationId: 'org_other' },
      { tenantId: 'tenant_other' },
      { revision: 1, record: { v: 1, setup: { ...first, organizationId: 'org_other' } } },
      { revision: 1, record: { v: 1, setup: { ...first, tenantId: 'tenant_other' } } },
    ];
    for (const value of wrong) expect(decideSetupLoad({ ...who, fetched: answered(value), copy }).kind).toBe('load-error');
  });

  it('never shows the copy after a refusal', () => {
    expect(
      decideSetupLoad({ ...who, fetched: { kind: 'refused', code: 'not_a_member', message: 'You are not a member.' }, copy }),
    ).toEqual({ kind: 'refused', code: 'not_a_member', reason: 'You are not a member.' });
  });

  it('shows the tagged copy, read-only, while the service cannot be reached', () => {
    expect(decideSetupLoad({ ...who, fetched: unreachable, copy })).toEqual({
      kind: 'cache',
      revision: 2,
      setup: first,
      fetchedAt: T0,
      reason: SETUP_CACHED_REASON,
    });
  });

  it('treats any other copy as unusable: a load error, never a blank setup', () => {
    const others: SetupCopy[] = [
      { tag: null, setup: first },
      { tag, setup: null },
      { tag: null, setup: null },
      { tag: { ...tag, personId: MANAGER }, setup: first },
      { tag: { ...tag, generation: 4 }, setup: first },
      { tag: { ...tag, tenantId: 'tenant_other' }, setup: first },
      { tag: { ...tag, organizationId: 'org_other' }, setup: first },
      { tag: { ...tag, revision: 0 }, setup: first },
      { tag, setup: { ...first, tenantId: 'tenant_other' } },
    ];
    for (const other of others)
      expect(decideSetupLoad({ ...who, fetched: unreachable, copy: other })).toEqual({
        kind: 'load-error',
        reason: SETUP_UNREACHABLE_REASON,
      });
  });

  it('leaves the setup to this computer while the service keeps none', () => {
    expect(decideSetupLoad({ ...who, fetched: { kind: 'unsupported' }, copy: { tag: null, setup: first } })).toEqual({
      kind: 'local',
      setup: first,
    });
    expect(decideSetupLoad({ ...who, fetched: { kind: 'unsupported' }, copy: { tag: null, setup: null } })).toEqual({
      kind: 'local',
      setup: null,
    });
  });
});

describe('the copy this computer keeps', () => {
  it("keeps the service's revision with a tag, and shows it read-only while the service is down", async () => {
    service.saveElsewhere(first);
    const loaded = await sync.load(owner);
    expect(loaded).toEqual({ kind: 'service', revision: 1, setup: first, writtenAt: T0, writtenBy: OWNER });
    expect(await json(`${ORG}.json`)).toEqual(first);
    expect(await json(`${ORG}.sync.json`)).toEqual({
      v: 1,
      organizationId: ORG,
      tenantId: TENANT,
      personId: OWNER,
      generation: 3,
      revision: 1,
      fetchedAt: FETCHED,
    });
    expect(await sync.revision(ORG)).toBe(1);

    service.state.mode = 'unreachable';
    const before = await listing();
    expect(await sync.load(owner)).toEqual({ kind: 'cache', revision: 1, setup: first, fetchedAt: FETCHED, reason: SETUP_CACHED_REASON });
    // The copy is this person's, under this access generation, and nobody else's.
    for (const other of [{ ...owner, generation: 4 }, { ...owner, personId: MANAGER }])
      expect(await sync.load(other)).toEqual({ kind: 'load-error', reason: SETUP_UNREACHABLE_REASON });
    expect(await listing()).toEqual(before);
    expect(await json(`${ORG}.json`)).toEqual(first);
  });

  it('lets a refusal win over the copy, and changes nothing on this computer', async () => {
    service.saveElsewhere(first);
    await sync.load(owner);
    const bytes = await fs.readFile(file(`${ORG}.json`), 'utf8');
    for (const code of ['not_a_member', 'sign_in_required']) {
      service.state.mode = { refused: code };
      expect(await sync.load(owner)).toEqual({ kind: 'refused', code, reason: `Refused: ${code}.` });
    }
    expect(await fs.readFile(file(`${ORG}.json`), 'utf8')).toBe(bytes);
    expect(await exists(`${ORG}.sync.json`)).toBe(true);
  });

  it('does not keep the same setup twice when the service returns it in another key order', async () => {
    service.saveElsewhere(first);
    await place(`${ORG}.json`, reversed(first));
    await sync.load(owner);
    expect(await listing()).toEqual([`${ORG}.json`, `${ORG}.sync.json`]);
  });

  it("sets aside a setup only this computer held before the business's replaces it", async () => {
    service.saveElsewhere(first);
    const local = setup([answer('name', 'Written while the service kept no setups', OWNER)]);
    await place(`${ORG}.json`, local);
    await sync.load(owner);
    expect(await json(`${ORG}.before-sync.json`)).toEqual(local);
    expect(await json(`${ORG}.json`)).toEqual(first);
    expect(service.state.writes).toEqual([]);
  });

  it('sets aside an unreadable setup file rather than overwriting it', async () => {
    service.saveElsewhere(first);
    await place(`${ORG}.json`, '{"v":1,"organ');
    await sync.load(owner);
    expect(await fs.readFile(file(`${ORG}.before-sync.json`), 'utf8')).toBe('{"v":1,"organ');
    expect(await json(`${ORG}.json`)).toEqual(first);
  });

  it('never reuses a set-aside name', async () => {
    await place(`${ORG}.before-sync.json`, 'first');
    await place(`${ORG}.before-sync-2.json`, 'second');
    const mixed = setup([answer('name', 'Juniper Street Bakery', OWNER), answer('industry', 'bakery', MANAGER)]);
    await place(`${ORG}.json`, mixed);
    await sync.load(owner);
    expect(await fs.readFile(file(`${ORG}.before-sync.json`), 'utf8')).toBe('first');
    expect(await fs.readFile(file(`${ORG}.before-sync-2.json`), 'utf8')).toBe('second');
    expect(await json(`${ORG}.before-sync-3.json`)).toEqual(mixed);
    expect(await exists(`${ORG}.json`)).toBe(false);
  });
});

describe('a setup saved before the service kept setups', () => {
  it('becomes the business revision 1 when the person who wrote all of it opens it', async () => {
    await place(`${ORG}.json`, second);
    const loaded = await sync.load(owner);
    expect(service.state.writes).toEqual([{ expectedRevision: 0, record: { v: 1, setup: second } }]);
    expect(loaded).toEqual({ kind: 'service', revision: 1, setup: second, writtenAt: T0, writtenBy: OWNER });
    expect(await json(`${ORG}.sync.json`)).toMatchObject({ revision: 1, personId: OWNER });
    expect(await listing()).toEqual([`${ORG}.json`, `${ORG}.sync.json`]);
  });

  it('is set aside, and never uploaded, when someone else gave any of it', async () => {
    const mixed = setup([answer('name', 'Juniper Street Bakery', OWNER), answer('industry', 'bakery', MANAGER)]);
    await place(`${ORG}.json`, mixed);
    expect(await sync.load(owner)).toEqual({ kind: 'service', revision: 0, setup: null, writtenAt: null, writtenBy: null });
    expect(service.state.writes).toEqual([]);
    expect(await listing()).toEqual([`${ORG}.before-sync.json`]);
    expect(await json(`${ORG}.before-sync.json`)).toEqual(mixed);
  });

  it('waits for its author when someone who cannot move it opens the business first', async () => {
    await place(`${ORG}.json`, first);
    expect(await sync.load({ ...owner, personId: EMPLOYEE, mayConfigure: false })).toMatchObject({ kind: 'service', revision: 0, setup: null });
    // A Manager who did not write it cannot move it either.
    expect(await sync.load({ ...owner, personId: MANAGER })).toMatchObject({ kind: 'service', revision: 0, setup: null });
    expect(service.state.writes).toEqual([]);
    expect(await listing()).toEqual([`${ORG}.before-sync.json`]);

    expect(await sync.load(owner)).toMatchObject({ kind: 'service', revision: 1, setup: first });
    expect(service.state.writes).toEqual([{ expectedRevision: 0, record: { v: 1, setup: first } }]);
    // The set-aside file stays; the service now holds the same setup.
    expect(await listing()).toEqual([`${ORG}.before-sync.json`, `${ORG}.json`, `${ORG}.sync.json`]);
  });

  it("loses to someone else's first save, and is set aside", async () => {
    const theirs = setup([answer('name', 'Juniper Street Bakery Ltd', MANAGER)], MANAGER);
    await place(`${ORG}.json`, first);
    service.state.interleave = () => service.saveElsewhere(theirs, MANAGER);
    expect(await sync.load(owner)).toEqual({ kind: 'service', revision: 1, setup: theirs, writtenAt: T0, writtenBy: MANAGER });
    expect(service.state.revisions).toHaveLength(1);
    expect(await json(`${ORG}.json`)).toEqual(theirs);
    expect(await json(`${ORG}.before-sync.json`)).toEqual(first);
  });

  it('stays where it was when the person is refused while moving it', async () => {
    await place(`${ORG}.json`, first);
    service.state.interleave = () => {
      service.state.mode = { refused: 'not_a_member' };
    };
    expect(await sync.load(owner)).toEqual({ kind: 'refused', code: 'not_a_member', reason: 'Refused: not_a_member.' });
    expect(await listing()).toEqual([`${ORG}.json`]);
    expect(await json(`${ORG}.json`)).toEqual(first);
  });

  it('is set aside, and offered once, when the service will not hold it', async () => {
    const card = setup([answer('name', 'Juniper Street Bakery', OWNER), answer('notes', 'Card 4111 1111 1111 1111', OWNER)]);
    await place(`${ORG}.json`, card);
    expect(await sync.load(owner)).toMatchObject({ kind: 'service', revision: 0, setup: null });
    expect(await sync.load(owner)).toMatchObject({ kind: 'service', revision: 0, setup: null });
    expect(service.state.writes).toHaveLength(1);
    expect(service.state.revisions).toEqual([]);
    expect(await listing()).toEqual([`${ORG}.before-sync.json`]);
  });

  it('is shown as a load error, not "not started", when the move cannot reach the service', async () => {
    await place(`${ORG}.json`, first);
    service.state.interleave = () => {
      service.state.mode = 'unreachable';
    };
    expect(await sync.load(owner)).toEqual({ kind: 'load-error', reason: SETUP_UNREACHABLE_REASON });
    expect(await listing()).toEqual([`${ORG}.json`]);
  });
});

describe('saving a setup', () => {
  it('saves the next revision through the service and keeps it', async () => {
    service.saveElsewhere(first);
    const loaded = await sync.load(owner);
    const revision = loaded.kind === 'service' ? loaded.revision : -1;
    expect(await sync.save(owner, second, revision)).toEqual({
      kind: 'service',
      revision: 2,
      setup: second,
      writtenAt: T0,
      writtenBy: OWNER,
    });
    expect(service.state.writes.at(-1)).toEqual({ expectedRevision: 1, record: { v: 1, setup: second } });
    expect(await json(`${ORG}.json`)).toEqual(second);
    expect(await sync.revision(ORG)).toBe(2);
  });

  it("refuses a save made from an old revision, and hands back the other person's work", async () => {
    service.saveElsewhere(first);
    await sync.load(owner);
    const theirs = setup([answer('name', 'Juniper Street Bakery Ltd', MANAGER)]);
    service.saveElsewhere(theirs, MANAGER);
    const refused = await sync.save(owner, second, 1).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(SetupConflict);
    expect(refused).toBeInstanceOf(ApiError);
    expect(refused).toMatchObject({ status: 409, message: SETUP_SAVE_CONFLICT, details: { code: 'setup_conflict' } });
    expect((refused as SetupConflict).load).toEqual({ kind: 'service', revision: 2, setup: theirs, writtenAt: T0, writtenBy: MANAGER });
    expect(service.state.revisions).toHaveLength(2);
    expect(await json(`${ORG}.json`)).toEqual(theirs);
    expect(await sync.revision(ORG)).toBe(2);
  });

  it('writes nothing anywhere while the service cannot be reached', async () => {
    service.saveElsewhere(first);
    await sync.load(owner);
    const bytes = await fs.readFile(file(`${ORG}.json`), 'utf8');
    service.state.mode = 'unreachable';
    await expect(sync.save(owner, second, 1)).rejects.toMatchObject({ status: 503, details: { code: 'setup_unavailable' } });
    expect(await fs.readFile(file(`${ORG}.json`), 'utf8')).toBe(bytes);
    expect(await sync.revision(ORG)).toBe(1);
    expect(service.state.revisions).toHaveLength(1);
  });

  it('passes each refusal on with its code', async () => {
    for (const [code, status] of [
      ['sign_in_required', 401],
      ['not_a_member', 403],
      ['role_not_allowed', 403],
    ] as const) {
      service.state.mode = { refused: code };
      await expect(sync.save(owner, first, 0)).rejects.toMatchObject({ status, details: { code } });
    }
    service.state.mode = 'up';
    const card = setup([answer('name', 'Card 4111 1111 1111 1111', OWNER)]);
    await expect(sync.save(owner, card, 0)).rejects.toMatchObject({ status: 422, details: { code: 'setup_secret_like' } });
    const theirs = setup([answer('name', 'Juniper Street Bakery', MANAGER)]);
    await expect(sync.save(owner, theirs, 0)).rejects.toMatchObject({ status: 422, details: { code: 'setup_attribution' } });
    expect(service.state.revisions).toEqual([]);
    expect(await listing()).toEqual([]);
  });

  it('leaves the setup to this computer, claiming no revision, while the service keeps none', async () => {
    service.saveElsewhere(first);
    await sync.load(owner);
    service.state.mode = 'unsupported';
    expect(await sync.save(owner, second, 1)).toEqual({ kind: 'local', setup: second });
    expect(await json(`${ORG}.json`)).toEqual(second);
    expect(await exists(`${ORG}.sync.json`)).toBe(false);
    expect(await sync.load(owner)).toEqual({ kind: 'local', setup: second });
  });

  it('runs one load or save for a business at a time', async () => {
    let active = 0;
    let most = 0;
    const paced = async <T>(work: () => Promise<T>) => {
      active += 1;
      most = Math.max(most, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return work();
    };
    const serial = new OrganizationSetupSync(dir, {
      read: (id) => paced(() => service.remote.read(id)),
      write: (id, input) => paced(() => service.remote.write(id, input)),
    });
    service.saveElsewhere(first);
    await Promise.all([serial.load(owner), serial.save(owner, second, 1), serial.load(owner)]);
    expect(most).toBe(1);
    expect(service.state.revisions.map((item) => item.revision)).toEqual([1, 2]);
    expect(await json(`${ORG}.json`)).toEqual(second);
  });
});
