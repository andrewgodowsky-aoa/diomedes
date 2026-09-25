import type { AccountState, AccountTransaction, VerifiedIdentity, SubjectMapping, SessionRecord,
  OrganizationRow, MembershipRow, InvitationRecord, CodeInvitationRecord, AccountEvent } from './domain.js';
import { ACCOUNT_WORKSPACE_LIMIT, ORGANIZATION_MEMBER_LIMIT, CLOUD_WORKSPACE_PAGE_SIZE, CODE_INVITATION_PAGE } from './domain.js';
import { AccountError } from './errors.js';

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
  async member(organizationId: string, personId: string) {
    return this.state.memberships.find(row => row.record.organizationId === organizationId && row.record.personId === personId);
  }
  async hasOtherActiveOwner(organizationId: string, personId: string) {
    return this.state.memberships.some(row => row.record.organizationId === organizationId && row.record.personId !== personId && row.record.state === 'active' && row.record.role === 'owner');
  }
  async members(organizationId: string) {
    return this.state.memberships.filter(row => row.record.organizationId === organizationId && row.record.state === 'active').slice(0, ORGANIZATION_MEMBER_LIMIT + 1);
  }
  async memberships(personId: string, after?: string) {
    return this.state.memberships.filter(row => row.record.personId === personId && row.record.state === 'active' && (after === undefined || row.record.organizationId > after))
      .sort((a, b) => a.record.organizationId < b.record.organizationId ? -1 : a.record.organizationId > b.record.organizationId ? 1 : 0)
      .slice(0, ACCOUNT_WORKSPACE_LIMIT + 1);
  }
  async workspaceRows(personId: string, after?: string) {
    const memberships = (await this.memberships(personId, after)).slice(0, CLOUD_WORKSPACE_PAGE_SIZE + 1);
    return memberships.map(membership => {
      const organization = this.state.organizations.find(row => row.record.id === membership.record.organizationId);
      if (!organization) throw new AccountError(503, 'Account storage is inconsistent.');
      return { organization, membership };
    });
  }
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
  async codeInvitation(hash: string) { return this.state.codeInvitations.find((row) => row.codeHash === hash); }
  async saveCodeInvitation(row: CodeInvitationRecord) {
    const index = this.state.codeInvitations.findIndex((old) => old.codeHash === row.codeHash);
    if (index < 0) this.state.codeInvitations.push(row); else this.state.codeInvitations[index] = row;
  }
  async openCodeInvitations(organizationId: string, at: string) {
    const now = Date.parse(at);
    return this.state.codeInvitations
      .filter((row) => row.organizationId === organizationId && row.redeemedAt === null && row.revokedAt === null && Date.parse(row.expiresAt) > now)
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0))
      .slice(0, CODE_INVITATION_PAGE);
  }
  async roster(organizationId: string) {
    return this.state.memberships
      .filter((row) => row.record.organizationId === organizationId)
      .sort((a, b) => (a.record.personId < b.record.personId ? -1 : a.record.personId > b.record.personId ? 1 : 0))
      .slice(0, ORGANIZATION_MEMBER_LIMIT * 2)
      .map((membership) => {
        const person = this.state.persons.find((row) => row.id === membership.record.personId);
        if (!person) throw new AccountError(503, 'Account storage is inconsistent.');
        return { membership, person };
      });
  }
  async event(row: AccountEvent) { this.state.events.push(row); }
}
