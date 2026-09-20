import type { AccountState, AccountTransaction, VerifiedIdentity, SubjectMapping, SessionRecord,
  OrganizationRow, MembershipRow, InvitationRecord, AccountEvent } from './domain.js';

/**
 * Bridge for the existing local Store adapter and offline tests. The caller
 * must hold its one Store lock for the complete async callback and commit.
 * This class owns no persistence, mutex or server, and is never used by Workers.
 */
export class StateTransaction implements AccountTransaction {
  constructor(private readonly state: AccountState) {}
  async lockIdentity(_proof: VerifiedIdentity) {}
  async subject(issuer: string, subject: string) { return this.state.subjects.find((row) => row.issuer === issuer && row.subject === subject); }
  async person(id: string) { return this.state.persons.find((row) => row.id === id); }
  async session(issuer: string, sessionId: string) { return this.state.sessions.find((row) => row.issuer === issuer && row.sessionId === sessionId); }
  async savePerson(person: AccountState['persons'][number], mapping: SubjectMapping) {
    this.state.persons.push(person); this.state.subjects.push(mapping);
  }
  async saveSession(row: SessionRecord) {
    const index = this.state.sessions.findIndex((old) => old.issuer === row.issuer && old.sessionId === row.sessionId);
    if (index < 0) this.state.sessions.push(row); else this.state.sessions[index] = row;
  }
  async organization(id: string) { return this.state.organizations.find((row) => row.record.id === id); }
  async members(organizationId: string) { return this.state.memberships.filter((row) => row.record.organizationId === organizationId); }
  async memberships(personId: string) { return this.state.memberships.filter((row) => row.record.personId === personId); }
  async saveOrganization(row: OrganizationRow) {
    const index = this.state.organizations.findIndex((old) => old.record.id === row.record.id);
    if (index < 0) this.state.organizations.push(row); else this.state.organizations[index] = row;
  }
  async saveMembership(row: MembershipRow) {
    const index = this.state.memberships.findIndex((old) => old.record.organizationId === row.record.organizationId && old.record.personId === row.record.personId);
    if (index < 0) this.state.memberships.push(row); else this.state.memberships[index] = row;
  }
  async invitation(hash: string) { return this.state.invitations.find((row) => row.tokenHash === hash); }
  async saveInvitation(row: InvitationRecord) {
    const index = this.state.invitations.findIndex((old) => old.tokenHash === row.tokenHash);
    if (index < 0) this.state.invitations.push(row); else this.state.invitations[index] = row;
  }
  async event(row: AccountEvent) { this.state.events.push(row); }
}
