/**
 * OPS-05: the business's own records, for its owner
 * (`GET /account/organizations/:id/export`).
 *
 * - **Only the Business owner.** An active owner, read again inside the
 *   transaction that reads the setup revisions and history. A Manager, an
 *   Employee and anyone no longer in the business are refused, so nobody can
 *   take the records after they leave or are removed.
 * - **Read only.** Every statement this export sends is a SELECT on a table the
 *   Worker login may read (`scripts/runtime-permissions.sql`). It changes none
 *   of the business's records. Like every account route, checking the sign-in
 *   keeps the caller's session row current.
 * - **The owner's own views, reused.** People and invitations are the owner's
 *   roster, the plan is the owner's access view and the phones are the owner's
 *   device list. The export shows what the owner can already see and nothing
 *   more: no token, code, hash, key or staff note.
 * - **Every setup revision, exactly as saved** (ORG-01), and the business's
 *   membership history, oldest first: the newest `EXPORT_HISTORY_LIMIT` events,
 *   marked incomplete when there were more.
 *
 * Each part is read on its own, so a change that lands during an export can
 * show in one part and not yet in another.
 */
import type { CoveredAccessView } from '../../../../shared/individual-plan.js';
import {
  EXPORT_HISTORY_LIMIT,
  ORGANIZATION_EXPORT_VERSION,
  type ExportedEvent,
  type OrganizationAccountExport,
} from '../../../../shared/organization-export.js';
import type { AccountService } from '../account-service.js';
import type { AccountEvent, AccountMembershipSnapshot, MembershipRow } from '../domain.js';
import { AccountError } from '../errors.js';
import type { OrganizationSetupRow } from '../organization-setup/service.js';
import { RelayError, type RelayDevicesAnswer } from '../relay/service.js';

/** A refusal with a stable code the desktop branches on. */
export class OrganizationExportError extends AccountError {
  readonly code: string;
  constructor(status: number, message: string, code: string) {
    super(status, message);
    this.name = 'OrganizationExportError';
    this.code = code;
  }
}

export const NOT_A_MEMBER = 'This Business workspace is unavailable to this person.';
export const ONLY_THE_OWNER = "Only the Business owner can export the business's records.";

/** Database reads only. */
export interface OrganizationExportTransaction {
  /** The membership row, read by id under the transaction. */
  member(organizationId: string, personId: string): Promise<MembershipRow | undefined>;
  /** Every setup revision the business has, oldest first. */
  setupRevisions(organizationId: string): Promise<OrganizationSetupRow[]>;
  /** The business's newest `limit` account events, oldest first. */
  history(organizationId: string, limit: number): Promise<AccountEvent[]>;
}
export interface OrganizationExportRepository {
  transaction<T>(action: (tx: OrganizationExportTransaction) => Promise<T>): Promise<T>;
}

/** The owner's own views, from the services that already answer them. */
export interface OrganizationExportViews {
  access(token: string, organizationId: string): Promise<CoveredAccessView>;
  devices(token: string, organizationId: string): Promise<RelayDevicesAnswer>;
}

/** An invitation's target is the invitee's identity-provider id, which is not the business's to keep. */
function exported(event: AccountEvent): ExportedEvent {
  return {
    id: event.id,
    at: event.at,
    kind: event.kind,
    actorPersonId: event.actorPersonId,
    targetId: event.kind === 'invited' ? null : event.targetId,
  };
}

export class OrganizationExportService {
  private readonly now: () => number;

  constructor(
    private readonly accounts: AccountService,
    private readonly views: OrganizationExportViews,
    private readonly repository: OrganizationExportRepository,
    options: { now?: () => number } = {},
  ) {
    this.now = options.now ?? Date.now;
  }

  /** The verified person and their membership. A person outside the business is `not_a_member`. */
  private async member(token: string, organizationId: string): Promise<AccountMembershipSnapshot> {
    try {
      return await this.accounts.membership(token, organizationId);
    } catch (error) {
      if (error instanceof AccountError && error.status === 403 && !(error instanceof OrganizationExportError))
        throw new OrganizationExportError(403, NOT_A_MEMBER, 'not_a_member');
      throw error;
    }
  }

  async export(token: string, organizationId: string): Promise<OrganizationAccountExport> {
    const snapshot = await this.member(token, organizationId);
    if (snapshot.membership.role !== 'owner') throw new OrganizationExportError(403, ONLY_THE_OWNER, 'role_not_allowed');
    const owner = snapshot.person.id;
    const { setupRevisions, events } = await this.repository.transaction(async (tx) => {
      // Read again with the records, so an owner removed or demoted first is refused.
      const member = await tx.member(organizationId, owner);
      if (!member || member.record.state !== 'active') throw new OrganizationExportError(403, NOT_A_MEMBER, 'not_a_member');
      if (member.record.role !== 'owner') throw new OrganizationExportError(403, ONLY_THE_OWNER, 'role_not_allowed');
      return {
        setupRevisions: await tx.setupRevisions(organizationId),
        events: await tx.history(organizationId, EXPORT_HISTORY_LIMIT + 1),
      };
    });
    const roster = await this.accounts.roster(token, organizationId);
    const access = await this.views.access(token, organizationId);
    let devices: OrganizationAccountExport['devices'];
    try {
      const answer = await this.views.devices(token, organizationId);
      devices = {
        included: true,
        devices: answer.devices.map((device) => ({
          deviceId: device.deviceId,
          label: device.label,
          createdAt: device.createdAt,
          lastSeenAt: device.lastSeenAt,
        })),
      };
    } catch (error) {
      if (!(error instanceof RelayError && error.code === 'phone_relay_not_included')) throw error;
      devices = { included: false, reason: error.message };
    }
    const complete = events.length <= EXPORT_HISTORY_LIMIT;
    const organization = snapshot.organization;
    return {
      v: ORGANIZATION_EXPORT_VERSION,
      organization: {
        id: organization.id,
        name: organization.name,
        industry: organization.industry,
        tenantId: organization.tenantId,
        createdAt: organization.createdAt,
        createdBy: organization.createdBy,
      },
      exportedAt: new Date(this.now()).toISOString(),
      exportedBy: owner,
      people: roster.people.map((person) => ({ ...person })),
      invitations: (roster.invitations ?? []).map((invitation) => ({ ...invitation })),
      access,
      devices,
      setupRevisions: setupRevisions.map((row) => ({
        revision: row.revision,
        writtenAt: row.writtenAt,
        writtenBy: row.writtenBy,
        record: row.record,
      })),
      history: { events: (complete ? events : events.slice(1)).map(exported), complete },
    };
  }
}
