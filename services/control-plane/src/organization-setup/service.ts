/**
 * ORG-01: each business's setup, kept by the account service (migration 008).
 *
 * The intake a Business owner or Manager answers used to live only on the
 * computer that answered it. This keeps it for the organization instead: every
 * revision, in order, so a second computer, an invited administrator and a new
 * owner all open the same setup rather than a blank questionnaire.
 *
 * - **Reading** needs an active membership. An Employee sees the setup the
 *   owners made; they join it rather than repeat it.
 * - **Writing** needs an active owner or Manager (`admin`), read again under
 *   the business's lock so a demotion that lands first is honoured.
 * - **A write is compare-and-set.** It names the revision it was made from, and
 *   any other latest revision is a `setup_conflict`. Revisions are rows that
 *   are never updated or deleted (the table's trigger refuses both), so the
 *   history survives owner transfers and corrections.
 * - **The record is the organization's description, never authority.** Nothing
 *   here reads it to grant access, spending or membership. It is screened for
 *   credentials and for truthful attribution (`screenSetupRecord`), and it needs
 *   no plan: setting a business up is not the paid Agent.
 */
import { z } from 'zod';
import {
  screenSetupRecord,
  SETUP_RECORD_LIMITS,
  type OrganizationSetupAnswer,
  type OrganizationSetupWrite,
} from '../../../../shared/organization-setup.js';
import type { MemberRole } from '../../../../shared/workspaces.js';
import type { AccountService } from '../account-service.js';
import { accountId, type AccountMembershipSnapshot, type MembershipRow } from '../domain.js';
import { AccountError } from '../errors.js';
import { organizationSetupRecordSchema, organizationSetupWriteSchema } from './schema.js';

const time = z.iso.datetime({ offset: true });

/** One stored revision: a row of control_plane.organization_setups. */
export const organizationSetupRowSchema = z.strictObject({
  tenantId: accountId,
  organizationId: accountId,
  revision: z.number().int().min(1).max(SETUP_RECORD_LIMITS.revision),
  record: organizationSetupRecordSchema,
  writtenAt: time,
  writtenBy: accountId,
});
export type OrganizationSetupRow = z.infer<typeof organizationSetupRowSchema>;

/** A refusal with a stable code the desktop branches on. */
export class OrganizationSetupError extends AccountError {
  readonly code: string;
  constructor(status: number, message: string, code: string) {
    super(status, message);
    this.name = 'OrganizationSetupError';
    this.code = code;
  }
}

export const SETUP_CONFLICT =
  'Someone else saved this setup first. Reload it to see their changes, then try again.';

/** Who may change a business's setup: an active owner or Manager. */
export function mayConfigure(role: MemberRole): boolean {
  return role === 'owner' || role === 'admin';
}

/** Database operations only, never a provider call. */
export interface OrganizationSetupTransaction {
  /** Serializes writes for one business. */
  lockOrganization(organizationId: string): Promise<void>;
  /** The newest revision, or undefined when nothing is stored. */
  latest(organizationId: string): Promise<OrganizationSetupRow | undefined>;
  /** Appends a revision. The revision number is new for this business, or the insert fails. */
  insert(row: OrganizationSetupRow): Promise<void>;
  /** The membership row, read by id under the transaction. */
  member(organizationId: string, personId: string): Promise<MembershipRow | undefined>;
}
export interface OrganizationSetupRepository {
  transaction<T>(action: (tx: OrganizationSetupTransaction) => Promise<T>): Promise<T>;
}

function answerOf(snapshot: AccountMembershipSnapshot, row: OrganizationSetupRow | undefined): OrganizationSetupAnswer {
  return {
    organizationId: snapshot.organization.id,
    tenantId: snapshot.organization.tenantId,
    revision: row?.revision ?? 0,
    record: row?.record ?? null,
    writtenAt: row?.writtenAt ?? null,
    writtenBy: row?.writtenBy ?? null,
  };
}

export class OrganizationSetupService {
  private readonly now: () => number;

  constructor(
    private readonly accounts: AccountService,
    private readonly repository: OrganizationSetupRepository,
    options: { now?: () => number } = {},
  ) {
    this.now = options.now ?? Date.now;
  }

  /** The verified person and their membership. A person outside the business is `not_a_member`. */
  private async member(token: string, organizationId: string): Promise<AccountMembershipSnapshot> {
    try {
      return await this.accounts.membership(token, organizationId);
    } catch (error) {
      if (error instanceof AccountError && error.status === 403 && !(error instanceof OrganizationSetupError))
        throw new OrganizationSetupError(403, 'This Business workspace is unavailable to this person.', 'not_a_member');
      throw error;
    }
  }

  /** The business's current setup. Any active member may read it. */
  async read(token: string, organizationId: string): Promise<OrganizationSetupAnswer> {
    const snapshot = await this.member(token, organizationId);
    const row = await this.repository.transaction((tx) => tx.latest(organizationId));
    return answerOf(snapshot, row);
  }

  /** Save the next revision. The caller is an active owner or Manager, and names the revision they read. */
  async write(token: string, organizationId: string, input: OrganizationSetupWrite): Promise<OrganizationSetupAnswer> {
    const parsed = organizationSetupWriteSchema.safeParse(input);
    if (!parsed.success)
      throw new OrganizationSetupError(422, 'This setup record is not one the account service can keep.', 'invalid_setup');
    const snapshot = await this.member(token, organizationId);
    const writer = snapshot.person.id;
    return this.repository.transaction(async (tx) => {
      await tx.lockOrganization(organizationId);
      // The role is read again under the lock, so a demotion that lands first is honoured.
      const member = await tx.member(organizationId, writer);
      if (!member || member.record.state !== 'active')
        throw new OrganizationSetupError(403, 'This Business workspace is unavailable to this person.', 'not_a_member');
      if (!mayConfigure(member.record.role))
        throw new OrganizationSetupError(403, 'Only the Business owner or a Manager can change the business setup.', 'role_not_allowed');
      const latest = await tx.latest(organizationId);
      if ((latest?.revision ?? 0) !== parsed.data.expectedRevision)
        throw new OrganizationSetupError(409, SETUP_CONFLICT, 'setup_conflict');
      const refusal = screenSetupRecord(parsed.data.record, {
        organizationId,
        tenantId: snapshot.organization.tenantId,
        writer,
        previous: latest?.record ?? null,
      });
      if (refusal) throw new OrganizationSetupError(422, refusal.message, `setup_${refusal.code.replaceAll('-', '_')}`);
      if (parsed.data.expectedRevision >= SETUP_RECORD_LIMITS.revision)
        throw new OrganizationSetupError(409, 'This setup has reached the most revisions the account service keeps.', 'setup_revisions_exhausted');
      const row: OrganizationSetupRow = organizationSetupRowSchema.parse({
        tenantId: snapshot.organization.tenantId,
        organizationId,
        revision: parsed.data.expectedRevision + 1,
        record: parsed.data.record,
        writtenAt: new Date(this.now()).toISOString(),
        writtenBy: writer,
      });
      await tx.insert(row);
      return answerOf(snapshot, row);
    });
  }
}
