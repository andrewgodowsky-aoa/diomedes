import { z } from 'zod';
import type { Membership, Organization, Person } from '../../../shared/workspaces.js';
import type {
  MembershipAssertion,
  VerifiedSubjectMapping,
} from '../contract/contract.js';

export const ACCOUNT_FOUNDATION_VERSION = 1 as const;
export const ACCOUNT_WORKSPACE_LIMIT = 100;
export const ORGANIZATION_MEMBER_LIMIT = 1000;
export const CLOUD_WORKSPACE_PAGE_SIZE = 25;
/** Outstanding invitation codes listed per organization. */
export const CODE_INVITATION_PAGE = 50;
export const accountId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/);
const time = z.iso.datetime();
const epoch = z
  .number()
  .int()
  .min(0)
  .max(Number.MAX_SAFE_INTEGER - 1);
const label = z.string().trim().min(1).max(200);
const issuer = z.url().refine((value) => {
  const url = new URL(value);
  return url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash;
});
const role = z.enum(['owner', 'admin', 'member']);

/** A provider response, never a request body or a decoded-but-unverified JWT. */
export interface VerifiedIdentity {
  issuer: string;
  subject: string;
  sessionId: string;
  displayName: string;
  emailVerified: boolean;
  /**
   * The provider's verified email, when it states one. Only an email-bound
   * invitation code reads it; an email never creates a subject or membership.
   */
  email?: string | null;
  issuedAt: string;
  expiresAt: string;
  verifiedAt: string;
}
export interface IdentityVerifier {
  readonly issuer: string;
  verify(accessToken: string): Promise<VerifiedIdentity>;
}
export const verifiedIdentitySchema = z.strictObject({
  issuer,
  subject: accountId,
  sessionId: accountId,
  displayName: label,
  emailVerified: z.boolean(),
  email: z.email().max(320).nullable().optional(),
  issuedAt: time,
  expiresAt: time,
  verifiedAt: time,
});

/**
 * Who a subject is, for staff reading a customer record and for an inviter
 * naming who they invited. A lookup, never authority: nothing here admits,
 * maps or grants. The WorkOS directory is not wired yet and answers null.
 */
export interface IdentityDirectory {
  lookup(issuer: string, subject: string): Promise<{ email: string | null; name: string | null } | null>;
}
export const NO_IDENTITY_DIRECTORY: IdentityDirectory = { lookup: async () => null };

// Reuse the PB-01 records. Hosted provenance is required in this account store;
// no migration reads the local fixture registry or copies its grants/credit.
const person = z.strictObject({
  v: z.literal(1),
  id: accountId,
  name: label,
  assurance: z.literal('hosted'),
  createdAt: time,
});
const subject = z.strictObject({
  issuer,
  subject: accountId,
  personId: accountId,
  verifiedAt: time,
  identityGeneration: epoch,
});
const organization = z.strictObject({
  v: z.literal(1),
  id: accountId,
  name: label,
  industry: label.nullable(),
  tenantId: accountId,
  identitySource: z.literal('hosted'),
  createdAt: time,
  createdBy: accountId,
});
const membership = z.strictObject({
  v: z.literal(1),
  organizationId: accountId,
  personId: accountId,
  role,
  state: z.enum(['invited', 'active', 'revoked']),
  invitedAt: time,
  joinedAt: time.nullable(),
  revokedAt: time.nullable(),
  revokedReason: label.nullable(),
});
const session = z.strictObject({
  principalId: accountId,
  issuer,
  subject: accountId,
  sessionId: accountId,
  personId: accountId,
  expiresAt: time,
  revokedAt: time.nullable(),
});
const invitation = z.strictObject({
  tokenHash: z.string().regex(/^[a-f0-9]{64}$/),
  organizationId: accountId,
  issuer,
  subject: accountId,
  role,
  invitedBy: accountId,
  inviterGeneration: epoch,
  createdAt: time,
  expiresAt: time,
  redeemedAt: time.nullable(),
  redeemedBy: accountId.nullable(),
});
/**
 * A single-use invitation code, for inviting someone who may not have an
 * account yet. Stored only as a hash. `email`, when set, binds redemption to a
 * provider-verified email; otherwise the code is a bearer secret the inviter
 * hands over. Either way the role is capped by the inviter's own authority and
 * the inviter's membership generation is pinned, so a demoted or removed
 * inviter's outstanding codes stop working.
 */
const codeInvitation = z.strictObject({
  codeHash: z.string().regex(/^[a-f0-9]{64}$/),
  organizationId: accountId,
  role,
  email: z.email().max(320).nullable(),
  invitedBy: accountId,
  inviterGeneration: epoch,
  createdAt: time,
  expiresAt: time,
  redeemedAt: time.nullable(),
  redeemedBy: accountId.nullable(),
  revokedAt: time.nullable(),
});
const event = z.strictObject({
  id: accountId,
  at: time,
  actorPersonId: accountId,
  organizationId: accountId.nullable(),
  kind: z.enum([
    'organization-created',
    'invited',
    'joined',
    'membership-changed',
    'session-revoked',
    'invitation-code-created',
    'invitation-code-revoked',
  ]),
  targetId: accountId,
});

export const accountStateSchema = z
  .strictObject({
    v: z.literal(ACCOUNT_FOUNDATION_VERSION),
    revision: epoch,
    persons: z.array(person).max(10_000),
    subjects: z.array(subject).max(10_000),
    organizations: z.array(z.strictObject({ record: organization, generation: epoch })).max(10_000),
    memberships: z.array(z.strictObject({ record: membership, generation: epoch })).max(100_000),
    sessions: z.array(session).max(100_000),
    invitations: z.array(invitation).max(100_000),
    codeInvitations: z.array(codeInvitation).max(100_000).default([]),
    events: z.array(event).max(100_000),
  })
  .superRefine((state, context) => {
    const fail = () =>
      context.addIssue({ code: 'custom', message: 'Invalid account relationships.' });
    const unique = <T>(rows: T[], key: (row: T) => string) => {
      if (new Set(rows.map(key)).size !== rows.length) fail();
    };
    unique(state.persons, (row) => row.id);
    unique(state.subjects, (row) => JSON.stringify([row.issuer, row.subject]));
    unique(state.subjects, (row) => row.personId);
    unique(state.organizations, (row) => row.record.id);
    unique(state.organizations, (row) => row.record.tenantId);
    unique(state.memberships, (row) =>
      JSON.stringify([row.record.organizationId, row.record.personId]),
    );
    unique(state.sessions, (row) => JSON.stringify([row.issuer, row.sessionId]));
    unique(state.sessions, (row) => row.principalId);
    unique(state.invitations, (row) => row.tokenHash);
    unique(state.events, (row) => row.id);
    const people = new Set(state.persons.map((row) => row.id));
    const orgs = new Set(state.organizations.map((row) => row.record.id));
    for (const row of state.subjects) if (!people.has(row.personId)) fail();
    for (const row of state.persons)
      if (!state.subjects.some((item) => item.personId === row.id)) fail();
    for (const row of state.sessions)
      if (
        !state.subjects.some(
          (item) =>
            item.personId === row.personId &&
            item.issuer === row.issuer &&
            item.subject === row.subject,
        )
      )
        fail();
    for (const row of state.memberships) {
      if (!people.has(row.record.personId) || !orgs.has(row.record.organizationId)) fail();
      if ((row.record.state === 'revoked') !== (row.record.revokedAt !== null)) fail();
      if (row.record.state === 'active' && row.record.joinedAt === null) fail();
    }
    for (const row of state.organizations) {
      if (!people.has(row.record.createdBy)) fail();
      if (
        !state.memberships.some(
          (item) =>
            item.record.organizationId === row.record.id &&
            item.record.role === 'owner' &&
            item.record.state === 'active',
        )
      )
        fail();
    }
    for (const row of state.invitations) {
      if (!people.has(row.invitedBy) || !orgs.has(row.organizationId)) fail();
      if ((row.redeemedAt === null) !== (row.redeemedBy === null)) fail();
      if (row.redeemedBy !== null && !people.has(row.redeemedBy)) fail();
      if (Date.parse(row.expiresAt) <= Date.parse(row.createdAt)) fail();
    }
    unique(state.codeInvitations, (row) => row.codeHash);
    for (const row of state.codeInvitations) {
      if (!people.has(row.invitedBy) || !orgs.has(row.organizationId)) fail();
      if ((row.redeemedAt === null) !== (row.redeemedBy === null)) fail();
      if (row.redeemedBy !== null && !people.has(row.redeemedBy)) fail();
      if (Date.parse(row.expiresAt) <= Date.parse(row.createdAt)) fail();
    }
    for (const row of state.events)
      if (
        !people.has(row.actorPersonId) ||
        (row.organizationId !== null && !orgs.has(row.organizationId))
      )
        fail();
  });

export type AccountState = z.infer<typeof accountStateSchema>;
export const emptyAccountState = (): AccountState => ({
  v: ACCOUNT_FOUNDATION_VERSION,
  revision: 0,
  persons: [],
  subjects: [],
  organizations: [],
  memberships: [],
  sessions: [],
  invitations: [],
  codeInvitations: [],
  events: [],
});

/** No tokens, credentials, entitlement or execution grants are persisted here. */
export interface AccountSession {
  person: Person;
  mapping: VerifiedSubjectMapping;
  principalId: string;
  sessionId: string;
  expiresAt: string;
}
export interface AccountMembershipSnapshot extends AccountSession {
  organization: Organization;
  membership: Membership;
  assertion: MembershipAssertion;
  checkedAt: string;
  validUntil: string;
}


/** B01 shares these records with the original foundation; no execution grants. */
export type SubjectMapping = AccountState['subjects'][number];
export type SessionRecord = AccountState['sessions'][number];
export type OrganizationRow = AccountState['organizations'][number];
export type MembershipRow = AccountState['memberships'][number];
export type InvitationRecord = AccountState['invitations'][number];
export type CodeInvitationRecord = AccountState['codeInvitations'][number];
export type AccountEvent = AccountState['events'][number];
export interface WorkspaceRow { organization: OrganizationRow; membership: MembershipRow }
export const recordSchemas = { person, subject, organization, membership, session, invitation, codeInvitation, event };

/** Methods are database/local-state operations only, never provider calls. */
export interface AccountTransaction {
  lockIdentity(proof: VerifiedIdentity): Promise<void>;
  subject(issuer: string, subject: string): Promise<SubjectMapping | undefined>;
  person(id: string): Promise<AccountState['persons'][number] | undefined>;
  session(issuer: string, sessionId: string): Promise<SessionRecord | undefined>;
  savePerson(person: AccountState['persons'][number], mapping: SubjectMapping): Promise<void>;
  saveSession(record: SessionRecord): Promise<void>;
  organization(id: string, lock?: boolean): Promise<OrganizationRow | undefined>;
  member(organizationId: string, personId: string): Promise<MembershipRow | undefined>;
  hasOtherActiveOwner(organizationId: string, personId: string): Promise<boolean>;
  /** Active-only, bounded admission window; never used to authorize a member. */
  members(organizationId: string): Promise<MembershipRow[]>;
  /** Active-only keyset page, including one extra row to detect continuation. */
  memberships(personId: string, after?: string): Promise<MembershipRow[]>;
  /** Membership and organization from one bounded read, with an extra row. */
  workspaceRows(personId: string, after?: string): Promise<WorkspaceRow[]>;
  saveOrganization(row: OrganizationRow): Promise<void>;
  saveMembership(row: MembershipRow): Promise<void>;
  invitation(hash: string): Promise<InvitationRecord | undefined>;
  saveInvitation(record: InvitationRecord): Promise<void>;
  codeInvitation(hash: string): Promise<CodeInvitationRecord | undefined>;
  saveCodeInvitation(record: CodeInvitationRecord): Promise<void>;
  /** Outstanding (unredeemed, unrevoked, unexpired at `at`) codes, newest first, bounded. */
  openCodeInvitations(organizationId: string, at: string): Promise<CodeInvitationRecord[]>;
  /** Every membership row of one organization, any state, with each person's display record. Bounded. */
  roster(organizationId: string): Promise<{ membership: MembershipRow; person: AccountState['persons'][number] }[]>;
  event(record: AccountEvent): Promise<void>;
}
export interface AccountRepository {
  transaction<T>(action: (transaction: AccountTransaction) => Promise<T>): Promise<T>;
}
