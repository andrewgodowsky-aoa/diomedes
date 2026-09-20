import { AccountService as PortableAccounts } from '../../services/control-plane/src/account-service.js';
import { StateTransaction } from '../../services/control-plane/src/state-transaction.js';
import { AccountError } from '../../services/control-plane/src/errors.js';
import { assertionStale } from '../../services/control-plane/contract/contract.js';
import { ApiError } from '../paths.js';
import type { AccountMembershipSnapshot, AccountRepository, AccountState, IdentityVerifier } from './account-contract.js';

// Preserve the existing local host capability boundary. Serialized projections
// from the cloud are never accepted as in-process local snapshots.
const issued = new WeakMap<AccountMembershipSnapshot, { scope: string; value: AccountMembershipSnapshot }>();

export class AccountService {
  private readonly portable: PortableAccounts;
  private readonly now: () => number;
  constructor(private readonly repository: AccountRepository, identity: IdentityVerifier, options: { now?: () => number } = {}) {
    this.now = options.now ?? Date.now;
    this.portable = new PortableAccounts({ transaction: action => repository.transact(state => action(new StateTransaction(state))) }, identity, options);
  }
  private async call<T>(action: () => Promise<T>): Promise<T> {
    try { return await action(); }
    catch (error) { if (error instanceof AccountError) throw new ApiError(error.status, error.message); throw error; }
  }
  signIn(token: string) { return this.call(() => this.portable.signIn(token)); }
  createOrganization(token: string, displayName: string) { return this.call(() => this.portable.createOrganization(token, displayName)); }
  listWorkspaces(token: string) { return this.call(() => this.portable.listWorkspaces(token)); }
  invite(...args: Parameters<PortableAccounts['invite']>) { return this.call(() => this.portable.invite(...args)); }
  acceptInvitation(...args: Parameters<PortableAccounts['acceptInvitation']>) { return this.call(() => this.portable.acceptInvitation(...args)); }
  setMembership(...args: Parameters<PortableAccounts['setMembership']>) { return this.call(() => this.portable.setMembership(...args)); }
  revokeLocalSession(token: string) { return this.call(() => this.portable.revokeLocalSession(token)); }
  async membership(token: string, organizationId: string): Promise<AccountMembershipSnapshot> {
    const snapshot = await this.call(() => this.portable.membership(token, organizationId));
    issued.set(snapshot, { scope: this.repository.scope, value: structuredClone(snapshot) });
    return snapshot;
  }
  private member(state: AccountState, personId: string, organizationId: string) {
    const org = state.organizations.find(row => row.record.id === organizationId);
    const member = state.memberships.find(row => row.record.organizationId === organizationId && row.record.personId === personId);
    if (!org || !member || member.record.state !== 'active') throw new ApiError(403, 'This Business workspace is unavailable to this person.');
    return { org, member };
  }
  async withCurrentMembership<T>(snapshot: AccountMembershipSnapshot, action: (current: AccountMembershipSnapshot) => T | Promise<T>): Promise<T> {
    const saved = issued.get(snapshot);
    if (!saved || saved.scope !== this.repository.scope) throw new ApiError(401, 'Resolve the account session again.');
    const expected = saved.value;
    return this.repository.read(async state => {
      const now = this.now();
      if (Date.parse(expected.validUntil) <= now || Date.parse(expected.checkedAt) > now) throw new ApiError(401, 'The membership snapshot expired.');
      const session = state.sessions.find(row => row.principalId === expected.principalId);
      if (!session || session.revokedAt !== null || session.personId !== expected.person.id || session.sessionId !== expected.sessionId || Date.parse(session.expiresAt) <= now)
        throw new ApiError(401, 'The account session is no longer active.');
      const { org, member } = this.member(state, expected.person.id, expected.organization.id);
      if (org.record.tenantId !== expected.organization.tenantId || assertionStale(expected.assertion, { identity: org.generation, principal: member.generation }))
        throw new ApiError(409, 'Membership changed; resolve it again before accessing this workspace.');
      return action(structuredClone(expected));
    });
  }
}
