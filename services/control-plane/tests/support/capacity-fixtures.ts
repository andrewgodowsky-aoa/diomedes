import { emptyAccountState, type AccountState, type IdentityVerifier } from '../../src/domain.js';
import { MemoryRepository } from './memory.js';
import { now, verifier } from './fixtures.js';

export function capacitySeed(workspaces: number, members = 1, revoked = 0, prefix = '') {
  const state = emptyAccountState();
  const at = new Date(now).toISOString();
  const personId = (name: string) => `${prefix}person_${name === 'alice' ? 'zz_alice' : name}`;
  const organizationId = (i: number) => `${prefix}org_${String(i).padStart(4, '0')}`;
  const addPerson = (name: string) => {
    if (state.persons.some(p => p.id === personId(name))) return;
    state.persons.push({ v: 1, id: personId(name), name, assurance: 'hosted', createdAt: at });
    state.subjects.push({ issuer: verifier.issuer, subject: `user_${prefix}${name}`, personId: personId(name), verifiedAt: at, identityGeneration: 0 });
  };
  addPerson('alice'); addPerson('bob'); addPerson('carol');
  for (let i = 0; i < workspaces; i++) {
    state.organizations.push({ generation: 0, record: { v: 1, id: organizationId(i), tenantId: `${prefix}tenant_${i}`,
      createdBy: personId('alice'), createdAt: at, identitySource: 'hosted', name: `Workspace ${i}`, industry: null } });
    state.memberships.push({ generation: 0, record: { v: 1, organizationId: organizationId(i), personId: personId('alice'),
      role: 'owner', state: 'active', invitedAt: at, joinedAt: at, revokedAt: null, revokedReason: null } });
  }
  for (let i = 1; i < members + revoked; i++) {
    const name = `filler_${String(i).padStart(5, '0')}`;
    addPerson(name);
    const history = i >= members;
    state.memberships.push({ generation: 0, record: { ...state.memberships[0].record, personId: personId(name), role: 'member',
      state: history ? 'revoked' : 'active', revokedAt: history ? at : null, revokedReason: history ? 'Fixture history' : null } });
  }
  const identity: IdentityVerifier = { issuer: verifier.issuer, async verify(token) {
    return { ...await verifier.verify(token), subject: `user_${prefix}${token}`, sessionId: `session_${prefix}${token}` };
  } };
  return { state, personId, organizationId, identity };
}

export async function seededMemory(seed: AccountState) {
  const memory = new MemoryRepository();
  await memory.transaction(async tx => {
    for (const person of seed.persons) await tx.savePerson(person, seed.subjects.find(s => s.personId === person.id)!);
    for (const org of seed.organizations) await tx.saveOrganization(org);
    for (const member of seed.memberships) await tx.saveMembership(member);
    for (const session of seed.sessions) await tx.saveSession(session);
    for (const invitation of seed.invitations) await tx.saveInvitation(invitation);
  });
  return memory;
}
