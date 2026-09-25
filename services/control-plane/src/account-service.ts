import { z } from 'zod';
import { canAdministerMembers, entitlementFor, type MemberRole } from '../../../shared/workspaces.js';
import { canChangeMember, canInviteRole, ROLE_CAPABILITIES } from '../../../shared/access.js';
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
export const codeInvitationInput = z.strictObject({
  role: z.enum(['owner', 'admin', 'member']),
  email: z.email().max(320).nullable().optional(),
  ttlMs: z.number().int().min(60_000).max(7 * 24 * 60 * 60 * 1000),
});
/** Sixteen Crockford base-32 characters in four groups: 80 bits, typed by a person. */
export const INVITATION_CODE = /^[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{4}){3}$/;
export const redeemCodeInput = z.strictObject({ code: z.string().trim().toUpperCase().regex(INVITATION_CODE) });
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
function invitationCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  const chars = Array.from(bytes, (byte) => CROCKFORD[byte & 31]);
  return [0, 4, 8, 12].map((at) => chars.slice(at, at + 4).join('')).join('-');
}
/** A code's public id: enough of its hash to name it, never enough to redeem it. */
export const codeId = (hash: string) => hash.slice(0, 16);
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
  /** An owner invites anyone; a Manager invites Employees only (Andrew, 2026-09-25). */
  private async inviter(tx: AccountTransaction, personId: string, organizationId: string, role: MemberRole) {
    const found = await this.member(tx, personId, organizationId);
    if (!canInviteRole(found.member.record.role, found.member.record.state === 'active', role))
      throw new AccountError(403, found.member.record.role === 'admin'
        ? 'A Manager can invite Employees. Ask the Business owner to invite a Manager or owner.'
        : 'Only the Business owner or a Manager can invite people.');
    return found;
  }
  /** Owners and Managers read the full roster and outstanding codes. */
  private async manager(tx: AccountTransaction, personId: string, organizationId: string) {
    const found = await this.member(tx, personId, organizationId);
    if (ROLE_CAPABILITIES[found.member.record.role].managePeople === 'nobody')
      throw new AccountError(403, 'Only the Business owner or a Manager can manage people.');
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
      const { member } = await this.inviter(tx, actor.person.id, organizationId, parsed.data.role);
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
      const { member: inviter } = await this.inviter(tx, invitation.invitedBy, organizationId, invitation.role);
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
      const { org, member: self } = await this.member(tx, actor.person.id, organizationId);
      const target = await tx.member(organizationId, personId);
      if (!target) throw new AccountError(403, 'The membership is unavailable.');
      if (!canChangeMember({ actor: self.record.role, actorActive: self.record.state === 'active', actorPersonId: actor.person.id,
        target: target.record.role, targetPersonId: personId, change: parsed.data }))
        throw new AccountError(403, self.record.role === 'admin'
          ? 'A Manager can remove Employees. Ask the Business owner to change roles or remove a Manager.'
          : 'An active organization owner must administer membership.');
      if (target.record.role === 'owner' && target.record.state === 'active' &&
          (parsed.data.role !== 'owner' || parsed.data.state !== 'active') && !(await tx.hasOtherActiveOwner(organizationId, personId)))
        throw new AccountError(409, 'Transfer ownership before removing the final owner.');
      if (target.record.state !== 'active' && parsed.data.state === 'active')
        throw new AccountError(409, 'Invite this person again; a role edit cannot restore revoked membership.');
      const row: MembershipRow = { generation: target.generation + 1, record: { ...target.record,
        ...parsed.data, revokedAt: parsed.data.state === 'revoked' ? this.at() : null,
        revokedReason: parsed.data.state === 'revoked' ? (self.record.role === 'owner' ? 'Revoked by organization owner.' : 'Removed by a Manager.') : null } };
      await tx.saveMembership(row);
      await tx.saveOrganization({ ...org, generation: org.generation + 1 });
      await this.event(tx, actor.person.id, organizationId, 'membership-changed', personId);
      return row.record;
    });
  }
  /**
   * A single-use code for someone who may not have an account yet. The code is
   * returned once and stored only as a hash. The role is capped by the
   * inviter's own authority, and the inviter's generation is pinned so that a
   * later demotion or removal voids every code they issued.
   */
  async createInvitationCode(token: string, organizationId: string, input: z.infer<typeof codeInvitationInput>) {
    const parsed = codeInvitationInput.safeParse(input);
    if (!parsed.success) throw new AccountError(422, 'A role and an invitation lifetime of one minute to seven days are required.');
    const code = invitationCode();
    const codeHash = await digest(code);
    return this.act(token, async (tx, actor) => {
      const { member } = await this.inviter(tx, actor.person.id, organizationId, parsed.data.role);
      const expiresAt = new Date(this.now() + parsed.data.ttlMs).toISOString();
      await tx.saveCodeInvitation({ codeHash, organizationId, role: parsed.data.role, email: parsed.data.email?.toLowerCase() ?? null,
        invitedBy: actor.person.id, inviterGeneration: member.generation, createdAt: this.at(), expiresAt,
        redeemedAt: null, redeemedBy: null, revokedAt: null });
      await this.event(tx, actor.person.id, organizationId, 'invitation-code-created', codeId(codeHash));
      return { id: codeId(codeHash), code, organizationId, role: parsed.data.role, email: parsed.data.email?.toLowerCase() ?? null, expiresAt };
    });
  }
  async redeemInvitationCode(token: string, rawCode: string) {
    const parsed = redeemCodeInput.safeParse({ code: rawCode });
    if (!parsed.success) throw new AccountError(403, 'That invitation code is not valid.');
    const hash = await digest(parsed.data.code);
    return this.act(token, async (tx, actor, proof) => {
      const found = await tx.codeInvitation(hash);
      if (!found) throw new AccountError(403, 'That invitation code is not valid.');
      const org = await tx.organization(found.organizationId, true);
      // Re-read under the organization lock, so two redemptions of one code serialize.
      const invitation = await tx.codeInvitation(hash);
      if (!org || !invitation) throw new AccountError(403, 'That invitation code is not valid.');
      if (invitation.revokedAt !== null) throw new AccountError(410, 'That invitation was withdrawn.');
      if (invitation.redeemedAt !== null) throw new AccountError(409, 'That invitation code has already been used.');
      if (Date.parse(invitation.expiresAt) <= this.now()) throw new AccountError(410, 'That invitation code expired. Ask for a new one.');
      if (invitation.email !== null && (proof.email ?? '').toLowerCase() !== invitation.email)
        throw new AccountError(403, 'This invitation is for a different email address.');
      const { member: inviter } = await this.inviter(tx, invitation.invitedBy, org.record.id, invitation.role);
      if (inviter.generation !== invitation.inviterGeneration) throw new AccountError(403, 'The person who sent this invitation no longer has that authority.');
      const previous = await tx.member(org.record.id, actor.person.id);
      if (previous?.record.state === 'active') throw new AccountError(409, 'You are already a member of this business.');
      if ((await tx.members(org.record.id)).length >= ORGANIZATION_MEMBER_LIMIT)
        throw new AccountError(409, 'The workspace has reached its active member limit.');
      await this.requireWorkspaceCapacity(tx, actor.person.id);
      const row: MembershipRow = { generation: previous ? previous.generation + 1 : 0, record: { v: 1,
        organizationId: org.record.id, personId: actor.person.id, role: invitation.role, state: 'active', invitedAt: invitation.createdAt,
        joinedAt: this.at(), revokedAt: null, revokedReason: null } };
      await tx.saveMembership(row);
      await tx.saveOrganization({ ...org, generation: org.generation + 1 });
      await tx.saveCodeInvitation({ ...invitation, redeemedAt: this.at(), redeemedBy: actor.person.id });
      await this.event(tx, actor.person.id, org.record.id, 'joined', actor.person.id);
      return { organization: org.record, membership: row.record };
    });
  }
  async revokeInvitationCode(token: string, organizationId: string, id: string) {
    if (!/^[a-f0-9]{16}$/.test(id)) throw new AccountError(404, 'That invitation was not found.');
    return this.act(token, async (tx, actor) => {
      const { member } = await this.manager(tx, actor.person.id, organizationId);
      const open = await tx.openCodeInvitations(organizationId, this.at());
      const invitation = open.find((row) => codeId(row.codeHash) === id);
      if (!invitation) throw new AccountError(404, 'That invitation was not found or is no longer open.');
      if (!canInviteRole(member.record.role, true, invitation.role))
        throw new AccountError(403, 'Only the Business owner can withdraw this invitation.');
      await tx.saveCodeInvitation({ ...invitation, revokedAt: this.at() });
      await this.event(tx, actor.person.id, organizationId, 'invitation-code-revoked', id);
    });
  }
  /**
   * Everyone in the business. Every active member sees who is on the team and
   * their role; only an owner or Manager also sees removed members and the
   * outstanding invitation codes (never the codes themselves).
   */
  async roster(token: string, organizationId: string) {
    return this.act(token, async (tx, actor) => {
      const { member } = await this.member(tx, actor.person.id, organizationId);
      const managing = ROLE_CAPABILITIES[member.record.role].managePeople !== 'nobody';
      const rows = await tx.roster(organizationId);
      const people = rows
        .filter((row) => managing || row.membership.record.state === 'active')
        .map((row) => ({ personId: row.person.id, name: row.person.name, role: row.membership.record.role,
          state: row.membership.record.state, joinedAt: row.membership.record.joinedAt, revokedAt: row.membership.record.revokedAt }));
      const invitations = managing
        ? (await tx.openCodeInvitations(organizationId, this.at())).map((row) => ({ id: codeId(row.codeHash), role: row.role,
            email: row.email, createdAt: row.createdAt, expiresAt: row.expiresAt, invitedBy: row.invitedBy }))
        : null;
      return { organizationId, you: { personId: actor.person.id, role: member.record.role }, people, invitations };
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
