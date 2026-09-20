import { z } from 'zod';
import { canAdministerMembers, entitlementFor } from '../../../shared/workspaces.js';
import { assertMembership, verifySubject } from '../contract/contract.js';
import { AccountError } from './errors.js';
import { base64url, digest } from './crypto.js';
import { ACCOUNT_WORKSPACE_LIMIT, ORGANIZATION_MEMBER_LIMIT, CLOUD_WORKSPACE_PAGE_SIZE, accountId, verifiedIdentitySchema, type AccountTransaction, type AccountRepository,
  type AccountSession, type AccountMembershipSnapshot, type IdentityVerifier, type VerifiedIdentity,
  type MembershipRow, type OrganizationRow, type AccountEvent } from './domain.js';

export const organizationInput = z.strictObject({ name: z.string().trim().min(1).max(200) });
export const invitationInput = z.strictObject({
  subject: accountId, role: z.enum(['owner', 'admin', 'member']),
  ttlMs: z.number().int().min(1000).max(7 * 24 * 60 * 60 * 1000),
});
export const changeInput = z.strictObject({ role: z.enum(['owner', 'admin', 'member']), state: z.enum(['active', 'revoked']) });
export const acceptanceInput = z.strictObject({ token: z.string().regex(/^[A-Za-z0-9_-]{43}$/) });
const id = (kind: string) => `${kind}_${crypto.randomUUID()}`;

/**
 * Portable extraction of the foundation rules. Both adapters execute these
 * same mutations. Verification completes before any transaction starts.
 * A membership projection is not an execution capability or Trust grant.
 */
export class AccountService {
  private readonly now: () => number;
  constructor(private readonly repository: AccountRepository, private readonly identity: IdentityVerifier,
    options: { now?: () => number } = {}) { this.now = options.now ?? Date.now; }

  private at() { return new Date(this.now()).toISOString(); }
  private fresh(proof: VerifiedIdentity) {
    const now = this.now();
    if (Date.parse(proof.expiresAt) <= now || Date.parse(proof.issuedAt) > now + 5000 ||
        Date.parse(proof.verifiedAt) > now + 5000 || now - Date.parse(proof.verifiedAt) > 5000)
      throw new AccountError(401, 'The verified session has expired or must be checked again.');
  }
  private async verified(token: string) {
    const result = verifiedIdentitySchema.safeParse(await this.identity.verify(token));
    if (!result.success || result.data.issuer !== this.identity.issuer)
      throw new AccountError(401, 'The identity provider did not verify this session.');
    if (!result.data.emailVerified) throw new AccountError(403, 'Verify the account email before joining a Business workspace.');
    this.fresh(result.data);
    return result.data;
  }
  private async act<T>(token: string, action: (tx: AccountTransaction, actor: AccountSession, proof: VerifiedIdentity) => Promise<T>) {
    const proof = await this.verified(token);
    return this.repository.transaction(async (tx) => {
      const actor = await this.session(tx, proof);
      const result = await action(tx, actor, proof);
      this.fresh(proof);
      return result;
    });
  }
  private async session(tx: AccountTransaction, proof: VerifiedIdentity): Promise<AccountSession> {
    await tx.lockIdentity(proof);
    this.fresh(proof);
    let mapping = await tx.subject(proof.issuer, proof.subject);
    let person;
    if (!mapping) {
      person = { v: 1 as const, id: id('person'), name: proof.displayName, assurance: 'hosted' as const, createdAt: this.at() };
      const checked = verifySubject({ identitySource: 'hosted', issuer: proof.issuer, subject: proof.subject,
        personId: person.id, verifiedAt: proof.verifiedAt, identityGeneration: 0 });
      if (!checked.verified) throw new AccountError(401, 'The subject mapping could not be verified.');
      mapping = { ...checked.mapping };
      await tx.savePerson(person, mapping);
    } else person = await tx.person(mapping.personId);
    if (!person) throw new AccountError(503, 'Account storage is inconsistent.');
    let session = await tx.session(proof.issuer, proof.sessionId);
    if (session && (session.revokedAt !== null || session.personId !== person.id || session.subject !== proof.subject))
      throw new AccountError(401, 'This session is revoked or belongs to another person.');
    if (!session) session = { principalId: id('account_session'), issuer: proof.issuer, subject: proof.subject,
      sessionId: proof.sessionId, personId: person.id, expiresAt: proof.expiresAt, revokedAt: null };
    else if (Date.parse(proof.expiresAt) > Date.parse(session.expiresAt)) session.expiresAt = proof.expiresAt;
    await tx.saveSession(session);
    return { person, mapping, principalId: session.principalId, sessionId: proof.sessionId, expiresAt: proof.expiresAt };
  }
  private async member(tx: AccountTransaction, personId: string, organizationId: string) {
    const org = await tx.organization(organizationId, true);
    const member = org ? await tx.member(organizationId, personId) : undefined;
    if (!org || !member || member.record.state !== 'active')
      throw new AccountError(403, 'This Business workspace is unavailable to this person.');
    return { org, member };
  }
  private async owner(tx: AccountTransaction, personId: string, organizationId: string) {
    const found = await this.member(tx, personId, organizationId);
    if (!canAdministerMembers(found.member.record))
      throw new AccountError(403, 'An active organization owner must administer membership.');
    return found;
  }
  private async event(tx: AccountTransaction, actorPersonId: string, organizationId: string | null, kind: AccountEvent['kind'], targetId: string) {
    await tx.event({ id: id('account_event'), at: this.at(), actorPersonId, organizationId, kind, targetId });
  }
  private async requireWorkspaceCapacity(tx: AccountTransaction, personId: string) {
    // act() holds the verified subject lock for all additions by this person.
    // Revocations only reduce the active count; history remains stored.
    if ((await tx.memberships(personId)).length >= ACCOUNT_WORKSPACE_LIMIT)
      throw new AccountError(409, 'The account has reached its active workspace limit.');
  }
  signIn(token: string) { return this.act(token, async (_tx, actor) => actor); }
  async createOrganization(token: string, displayName: string) {
    const parsed = organizationInput.safeParse({ name: displayName });
    if (!parsed.success) throw new AccountError(422, 'A bounded organization name is required.');
    return this.act(token, async (tx, actor) => {
      await this.requireWorkspaceCapacity(tx, actor.person.id);
      const at = this.at();
      const org: OrganizationRow = { generation: 0, record: { v: 1, id: id('org'), name: parsed.data.name,
        industry: null, tenantId: id('tenant'), identitySource: 'hosted', createdAt: at, createdBy: actor.person.id } };
      await tx.saveOrganization(org);
      await tx.saveMembership({ generation: 0, record: { v: 1, organizationId: org.record.id, personId: actor.person.id,
        role: 'owner', state: 'active', invitedAt: at, joinedAt: at, revokedAt: null, revokedReason: null } });
      await this.event(tx, actor.person.id, org.record.id, 'organization-created', org.record.id);
      return org.record;
    });
  }
  private async workspacePageFor(tx: AccountTransaction, actor: AccountSession, after?: string) {
    const organizations = [];
    const rows = await tx.memberships(actor.person.id, after);
    const page = rows.slice(0, ACCOUNT_WORKSPACE_LIMIT);
    for (const row of page) {
      const org = await tx.organization(row.record.organizationId);
      if (!org) throw new AccountError(503, 'Account storage is inconsistent.');
      organizations.push({ organization: org.record, membership: row.record, entitlement: entitlementFor(org.record.id) });
    }
    return { person: actor.person, organizations,
      nextCursor: rows.length > ACCOUNT_WORKSPACE_LIMIT ? page.at(-1)!.record.organizationId : null };
  }
  /** Existing local Store consumers retain the complete response and shape.
   * The cloud HTTP handler uses workspacePage() for bounded network responses. */
  listWorkspaces(token: string) {
    return this.act(token, async (tx, actor) => {
      let page = await this.workspacePageFor(tx, actor);
      const organizations = [...page.organizations];
      while (page.nextCursor !== null) {
        const after = page.nextCursor;
        page = await this.workspacePageFor(tx, actor, after);
        if (page.nextCursor !== null && page.nextCursor <= after)
          throw new AccountError(503, 'Account storage returned an invalid continuation.');
        organizations.push(...page.organizations);
      }
      return { person: actor.person, organizations };
    });
  }
  workspacePage(token: string, after?: string) {
    if (after !== undefined && !accountId.safeParse(after).success)
      throw new AccountError(422, 'A valid workspace continuation is required.');
    return this.act(token, async (tx, actor) => {
      // The cloud projection joins both records in one SQL round trip. No
      // per-workspace network query can consume the current proof's lifetime.
      const rows = await tx.workspaceRows(actor.person.id, after);
      const page = rows.slice(0, CLOUD_WORKSPACE_PAGE_SIZE);
      return { person: actor.person, organizations: page.map(row => ({ organization: row.organization.record,
        membership: row.membership.record, entitlement: entitlementFor(row.organization.record.id) })),
        nextCursor: rows.length > CLOUD_WORKSPACE_PAGE_SIZE ? page.at(-1)!.organization.record.id : null };
    });
  }
  async invite(token: string, organizationId: string, input: z.infer<typeof invitationInput>) {
    const parsed = invitationInput.safeParse(input);
    if (!parsed.success) throw new AccountError(422, 'A recipient, role and finite invitation lifetime are required.');
    const invitationToken = base64url(crypto.getRandomValues(new Uint8Array(32)));
    const tokenHash = await digest(invitationToken);
    return this.act(token, async (tx, actor, proof) => {
      const { member } = await this.owner(tx, actor.person.id, organizationId);
      const expiresAt = new Date(this.now() + parsed.data.ttlMs).toISOString();
      await tx.saveInvitation({ tokenHash, organizationId, issuer: proof.issuer, subject: parsed.data.subject,
        role: parsed.data.role, invitedBy: actor.person.id, inviterGeneration: member.generation,
        createdAt: this.at(), expiresAt, redeemedAt: null, redeemedBy: null });
      await this.event(tx, actor.person.id, organizationId, 'invited', parsed.data.subject);
      return { token: invitationToken, organizationId, expiresAt };
    });
  }
  async acceptInvitation(token: string, organizationId: string, invitationToken: string) {
    if (!acceptanceInput.safeParse({ token: invitationToken }).success) throw new AccountError(403, 'The invitation is unavailable.');
    const hash = await digest(invitationToken);
    return this.act(token, async (tx, actor, proof) => {
      // Lock the tenant before reading its invitation or member generation.
      const org = await tx.organization(organizationId, true);
      const invitation = await tx.invitation(hash);
      if (!org || !invitation || invitation.organizationId !== organizationId || invitation.issuer !== proof.issuer || invitation.subject !== proof.subject)
        throw new AccountError(403, 'The invitation is unavailable to this recipient or workspace.');
      if (invitation.redeemedAt !== null) throw new AccountError(409, 'This invitation has already been used.');
      if (Date.parse(invitation.expiresAt) <= this.now()) throw new AccountError(410, 'This invitation expired.');
      const { member: inviter } = await this.owner(tx, invitation.invitedBy, organizationId);
      if (inviter.generation !== invitation.inviterGeneration) throw new AccountError(403, 'The invitation authority changed.');
      const previous = await tx.member(organizationId, actor.person.id);
      if (previous?.record.state === 'active') throw new AccountError(409, 'This person is already a member.');
      if ((await tx.members(organizationId)).length >= ORGANIZATION_MEMBER_LIMIT)
        throw new AccountError(409, 'The workspace has reached its active member limit.');
      await this.requireWorkspaceCapacity(tx, actor.person.id);
      const row: MembershipRow = { generation: previous ? previous.generation + 1 : 0, record: { v: 1,
        organizationId, personId: actor.person.id, role: invitation.role, state: 'active', invitedAt: invitation.createdAt,
        joinedAt: this.at(), revokedAt: null, revokedReason: null } };
      await tx.saveMembership(row);
      await tx.saveOrganization({ ...org, generation: org.generation + 1 });
      await tx.saveInvitation({ ...invitation, redeemedAt: this.at(), redeemedBy: actor.person.id });
      await this.event(tx, actor.person.id, organizationId, 'joined', actor.person.id);
      return row.record;
    });
  }
  async setMembership(token: string, organizationId: string, personId: string, input: z.infer<typeof changeInput>) {
    const parsed = changeInput.safeParse(input);
    if (!parsed.success) throw new AccountError(422, 'A valid membership change is required.');
    return this.act(token, async (tx, actor) => {
      const { org } = await this.owner(tx, actor.person.id, organizationId);
      const target = await tx.member(organizationId, personId);
      if (!target) throw new AccountError(403, 'The membership is unavailable.');
      if (target.record.role === 'owner' && target.record.state === 'active' &&
          (parsed.data.role !== 'owner' || parsed.data.state !== 'active') && !(await tx.hasOtherActiveOwner(organizationId, personId)))
        throw new AccountError(409, 'Transfer ownership before removing the final owner.');
      if (target.record.state !== 'active' && parsed.data.state === 'active')
        throw new AccountError(409, 'Invite this person again; a role edit cannot restore revoked membership.');
      const row: MembershipRow = { generation: target.generation + 1, record: { ...target.record,
        ...parsed.data, revokedAt: parsed.data.state === 'revoked' ? this.at() : null,
        revokedReason: parsed.data.state === 'revoked' ? 'Revoked by organization owner.' : null } };
      await tx.saveMembership(row);
      await tx.saveOrganization({ ...org, generation: org.generation + 1 });
      await this.event(tx, actor.person.id, organizationId, 'membership-changed', personId);
      return row.record;
    });
  }
  revokeLocalSession(token: string): Promise<void> {
    return this.act(token, async (tx, actor, proof) => {
      const session = await tx.session(proof.issuer, proof.sessionId);
      if (!session) throw new AccountError(401, 'The session is unavailable.');
      await tx.saveSession({ ...session, revokedAt: this.at() });
      await this.event(tx, actor.person.id, null, 'session-revoked', actor.principalId);
    });
  }
  membership(token: string, organizationId: string): Promise<AccountMembershipSnapshot> {
    return this.act(token, async (tx, actor) => {
      const { org, member } = await this.member(tx, actor.person.id, organizationId);
      const result = assertMembership({ organization: org.record, membership: member.record,
        generation: { identity: org.generation, principal: member.generation }, at: this.at() });
      if (!result.asserted) throw new AccountError(403, 'Current membership could not be established.');
      return { ...actor, organization: org.record, membership: member.record, assertion: result.assertion,
        checkedAt: this.at(), validUntil: new Date(Math.min(this.now() + 30_000, Date.parse(actor.expiresAt))).toISOString() };
    });
  }
}
