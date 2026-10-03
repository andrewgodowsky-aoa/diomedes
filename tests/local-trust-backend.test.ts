import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { Store } from '../server/store.js';
import { TeamService } from '../server/team/service.js';
import { createLocalTrustBackend, type LocalTrustAccountFacts, type PersonalAuthorityFacts } from '../server/trust/local-backend.js';
import { currentAuthority, disablePrototypeAuthority, enablePrototypeAuthority, isDenial, refOf,
  requireCapability, trustBackendInstalled, type Authority, type Denial, type Principal, type TrustBackend } from '../server/trust/index.js';
import { __resetRevocationState } from '../server/trust/revocation.js';

// These are trusted callback fixtures, not evidence of a live cloud account or paid eligibility.
const CLOCK = Date.parse('2026-10-01T12:00:00.000Z');
let directory: string, store: Store, team: TeamService, projectId: string, otherProjectId: string;
let account: LocalTrustAccountFacts | null, personalAllowed: boolean, generation: number;
let backends: Awaited<ReturnType<typeof createLocalTrustBackend>>[];

function granted(result: Authority | Denial): Authority {
  if (isDenial(result)) throw new Error(`Authority refused: ${result.code}: ${result.reason}`);
  return result;
}
function refused(result: Authority | Denial): Denial {
  expect(isDenial(result)).toBe(true);
  if (!isDenial(result)) throw new Error('An identity was unexpectedly admitted.');
  return result;
}
function personalFacts(id: string): PersonalAuthorityFacts | null {
  if (!personalAllowed) return null;
  return { projectId: id, tenantId: 'local', generation, projectFolder: store.state(id).project.folder };
}
async function backend(selectedStore = store) {
  const value = await createLocalTrustBackend({ store: selectedStore, accountFacts: () => account,
    personalFacts: id => personalFacts(id), now: () => CLOCK });
  backends.push(value);
  return value;
}
async function member() {
  return store.locked(() => team.createMember(projectId, { name: 'Scoped member', role: 'member', engine: 'sample' }));
}
const memberClaim = (slotId: string, token: string) => ({ via: 'loopback-http' as const, remoteAddress: '127.0.0.1',
  projectId, headers: { authorization: `Bearer ${token}`, 'x-slot-id': slotId } });

beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'diomedes-local-trust-'));
  store = new Store(path.join(directory, 'data'), path.join(directory, 'projects'));
  await store.init();
  projectId = (await store.locked(() => store.createProject('Personal Trust fixture'))).id;
  otherProjectId = (await store.locked(() => store.createProject('Other Personal Trust fixture'))).id;
  team = new TeamService(store);
  account = { backendKind: 'cloud', backendKey: 'https://account.invalid', personId: 'verified-person-fixture',
    sessionId: 'host-publication-fixture', lifecycle: 1, publishedLifecycle: 1,
    expiresAt: new Date(CLOCK + 60_000).toISOString() };
  personalAllowed = true; generation = 1; backends = [];
});
afterEach(async () => {
  for (const value of backends) value.close();
  vi.restoreAllMocks(); disablePrototypeAuthority(); __resetRevocationState();
  await fs.rm(directory, { recursive: true, force: true });
});

describe('app-scoped Personal desktop Trust', () => {
  test('uses existing owner policy with exact project and local tenant, without global installation or network', async () => {
    const installed = trustBackendInstalled();
    const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('No network is permitted by this resolver.'));
    const local = await backend();
    const first = granted(await store.locked(() => local.ownerAuthority(projectId)));
    expect(first).toMatchObject({ synthetic: false, assurance: 'owner-local',
      principal: { kind: 'local-owner', tenantId: 'local', projectId } });
    expect(isDenial(requireCapability(first, 'egress.send'))).toBe(false);
    expect(granted(await local.resolve({ via: 'stored-reference', ref: refOf(first) })).principal).toEqual(first.principal);
    expect(trustBackendInstalled()).toBe(installed);
    expect(refused(await currentAuthority({ via: 'local-owner', ownerId: first.principal.id }, null)).code).toBe('no-resolver');
    expect(fetch).not.toHaveBeenCalled();
  });

  test('does not let an account/person string claim OS-owner authority', async () => {
    const local = await backend();
    refused(await local.resolve({ via: 'local-owner', ownerId: account!.personId }));
    refused(await local.resolve({ via: 'local-owner', ownerId: 'owner' }));
  });

  test('refuses forged tenants, project identities, and unissued references', async () => {
    const local = await backend();
    const first = granted(await local.ownerAuthority(projectId));
    const other = granted(await local.ownerAuthority(otherProjectId));
    expect(first.principal.id).not.toBe(other.principal.id);
    refused(await local.resolve({ via: 'stored-reference', ref: { ...refOf(first), tenantId: 'company-tenant' } }));
    refused(await local.resolve({ via: 'stored-reference', ref: { ...refOf(first), id: `${first.principal.id}:other-project` } }));
    const wrongFacts = await createLocalTrustBackend({ store, accountFacts: () => account,
      personalFacts: () => personalFacts(otherProjectId), now: () => CLOCK });
    backends.push(wrongFacts);
    refused(await wrongFacts.ownerAuthority(projectId));
    refused(await local.ownerAuthority('unknown-project'));
  });

  test('rejects device, cloud session, and armed prototype identities', async () => {
    const local = await backend();
    const first = refOf(granted(await local.ownerAuthority(projectId)));
    for (const kind of ['session', 'device'] as const)
      refused(await local.resolve({ via: 'stored-reference', ref: { ...first, kind } }));
    enablePrototypeAuthority({ label: 'local-trust-fixture', capabilities: ['egress.send'] });
    const prototype = granted(await currentAuthority({ via: 'prototype-driver', label: 'local-trust-fixture' }));
    expect(refused(await local.resolve({ via: 'stored-reference', ref: refOf(prototype) })).code).toBe('synthetic-refused');
    expect(refused(await local.resolve({ via: 'prototype-driver', label: 'local-trust-fixture' })).code).toBe('synthetic-refused');
  });

  test.each(['signed-out', 'transition', 'faux', 'expired', 'unknown-session'] as const)('refuses %s account facts', async state => {
    const local = await backend();
    const ref = refOf(granted(await local.ownerAuthority(projectId)));
    if (state === 'signed-out') account = null;
    else if (state === 'transition') account!.lifecycle++;
    else if (state === 'faux') account = { ...account!, backendKind: 'faux' } as unknown as LocalTrustAccountFacts;
    else if (state === 'expired') account!.expiresAt = new Date(CLOCK).toISOString();
    else account!.sessionId = '';
    refused(await local.ownerAuthority(projectId));
    refused(await local.resolve({ via: 'stored-reference', ref }));
  });

  test('a frozen clock cannot revive a previous verified publication', async () => {
    const local = await backend();
    const previous = refOf(granted(await local.ownerAuthority(projectId)));
    account = { ...account!, lifecycle: 2, publishedLifecycle: 2, sessionId: 'new-host-publication-fixture' };
    refused(await local.resolve({ via: 'stored-reference', ref: previous }));
    expect(granted(await local.ownerAuthority(projectId)).principal.id).not.toBe(previous.id);
  });

  test('a verified first native publication may begin at lifecycle zero', async () => {
    account = { ...account!, lifecycle: 0, publishedLifecycle: 0 };
    expect(granted(await (await backend()).ownerAuthority(projectId)).principal.projectId).toBe(projectId);
  });

  test('credential renewal preserves a current publication while checking its new expiry', async () => {
    const local = await backend();
    const ref = refOf(granted(await local.ownerAuthority(projectId)));
    account!.expiresAt = new Date(CLOCK + 120_000).toISOString();
    expect(granted(await local.resolve({ via: 'stored-reference', ref })).principal.id).toBe(ref.id);
  });

  test('a scope switch, blocked scope, and returning Personal generation cannot restore an old ref', async () => {
    const local = await backend();
    const ref = refOf(granted(await local.ownerAuthority(projectId)));
    personalAllowed = false;
    refused(await local.ownerAuthority(projectId));
    refused(await local.resolve({ via: 'stored-reference', ref }));
    personalAllowed = true; generation++;
    refused(await local.resolve({ via: 'stored-reference', ref }));
    expect(granted(await local.ownerAuthority(projectId)).principal.id).not.toBe(ref.id);
  });

  test('an absent or unpersisted positive scope generation refuses authority', async () => {
    const local = await backend();
    generation = 0;
    refused(await local.ownerAuthority(projectId));
  });

  test('close, another Store, and restart after Trust-memory reset cannot revive stored refs', async () => {
    const original = await backend();
    const ref = refOf(granted(await original.ownerAuthority(projectId)));
    original.close();
    refused(await original.resolve({ via: 'stored-reference', ref }));
    __resetRevocationState();
    const restarted = await backend();
    refused(await restarted.resolve({ via: 'stored-reference', ref }));
    expect(granted(await restarted.ownerAuthority(projectId)).principal.id).not.toBe(ref.id);
    const secondStore = new Store(path.join(directory, 'second-data'), path.join(directory, 'second-projects'));
    await secondStore.init();
    const other = await backend(secondStore);
    refused(await other.resolve({ via: 'stored-reference', ref }));
    refused(await other.ownerAuthority(projectId));
  });

  test('live personal project-folder drift invalidates the exact saved project binding', async () => {
    const local = await backend();
    const ref = refOf(granted(await local.ownerAuthority(projectId)));
    store.state(projectId).project.folder = store.state(otherProjectId).project.folder;
    refused(await local.resolve({ via: 'stored-reference', ref }));
  });

  test('replacement of the Store data-root object invalidates existing host authority', async () => {
    const local = await backend();
    const ref = refOf(granted(await local.ownerAuthority(projectId)));
    await fs.rename(store.dataDir, path.join(directory, 'retired-data'));
    await fs.mkdir(store.dataDir);
    refused(await local.resolve({ via: 'stored-reference', ref }));
    refused(await local.ownerAuthority(projectId));
  });
});

describe('current durable Team identity', () => {
  test('a genuine member token stays limited by existing Team policy', async () => {
    const local = await backend(), created = await member();
    const first = granted(await local.resolve(memberClaim(created.member.slotId, created.token)));
    expect(first.principal).toMatchObject({ kind: 'team-member', tenantId: 'local', projectId, slotId: created.member.slotId });
    expect(refused(requireCapability(first, 'egress.send')).code).toBe('missing-capability');
    expect(refused(requireCapability(first, 'approval.decide')).code).toBe('missing-capability');
    expect(granted(await local.resolve({ via: 'stored-reference', ref: refOf(first) })).principal.id).toBe(first.principal.id);
    refused(await local.resolve(memberClaim('owner', created.token)));
    refused(await local.resolve({ ...memberClaim(created.member.slotId, created.token), remoteAddress: '192.0.2.1' }));
  });

  test('token rotation refuses old token and saved ref while permitting only the new identity', async () => {
    const local = await backend(), created = await member();
    const first = refOf(granted(await local.resolve(memberClaim(created.member.slotId, created.token))));
    const replacement = randomBytes(32).toString('hex');
    await store.locked(async () => {
      const secrets = await store.readTeamSecrets(projectId); secrets[created.member.slotId] = replacement;
      await store.writeTeamSecrets(projectId, secrets);
    });
    refused(await local.resolve(memberClaim(created.member.slotId, created.token)));
    refused(await local.resolve({ via: 'stored-reference', ref: first }));
    expect(granted(await local.resolve(memberClaim(created.member.slotId, replacement))).principal.id).not.toBe(first.id);
  });

  test('observed Stop cannot be undone by restoring status under the same token', async () => {
    const local = await backend(), created = await member();
    const first = refOf(granted(await local.resolve(memberClaim(created.member.slotId, created.token))));
    await store.locked(() => team.stopMember(projectId, created.member.slotId));
    refused(await local.resolve({ via: 'stored-reference', ref: first }));
    // Simulate a stale configuration restoring a status; this is not an authorization event.
    store.state(projectId).team!.members.find(item => item.slotId === created.member.slotId)!.status = 'idle';
    refused(await local.resolve({ via: 'stored-reference', ref: first }));
    refused(await local.resolve(memberClaim(created.member.slotId, created.token)));
    const rejoined = await member();
    expect(granted(await local.resolve(memberClaim(rejoined.member.slotId, rejoined.token))).principal.id).not.toBe(first.id);
  });

  test.each(['sign-out', 'Stop'] as const)('rechecks %s after an awaited token read without taking Store.locked', async change => {
    const local = await backend(), created = await member();
    const first = refOf(granted(await local.resolve(memberClaim(created.member.slotId, created.token))));
    let arrived!: () => void, release!: () => void;
    const entered = new Promise<void>(resolve => { arrived = resolve; });
    const barrier = new Promise<void>(resolve => { release = resolve; });
    const read = store.readTeamSecrets.bind(store);
    vi.spyOn(store, 'readTeamSecrets').mockImplementationOnce(async id => { arrived(); await barrier; return read(id); });
    const pending = local.resolve({ via: 'stored-reference', ref: first });
    await entered;
    if (change === 'sign-out') account!.lifecycle++;
    else await store.locked(() => team.stopMember(projectId, created.member.slotId));
    release();
    refused(await pending);
  });
});

test('the existing resolver rejects a backend that swaps identity class, ID, or tenant', async () => {
  const owner: Principal = { kind: 'local-owner', id: 'fixed-owner', tenantId: 'local', projectId,
    deviceId: null, sessionId: null, slotId: null };
  const base: TrustBackend = { localOwner: async () => owner, lookupTeamMember: async () => null,
    lookupPrincipalRef: async () => owner };
  const ref = refOf(granted(await currentAuthority({ via: 'local-owner', ownerId: owner.id }, base)));
  for (const change of [{ kind: 'session' as const }, { id: 'other-owner' }, { tenantId: 'company-tenant' }]) {
    const swapped = { ...owner, ...change };
    refused(await currentAuthority({ via: 'stored-reference', ref }, { ...base, lookupPrincipalRef: async () => swapped }));
  }
  refused(await currentAuthority({ via: 'local-owner', ownerId: owner.id }, {
    ...base, localOwner: async () => ({ ...owner, kind: 'session' }),
  }));
});
