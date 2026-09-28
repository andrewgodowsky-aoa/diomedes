/**
 * The shape of the owner's export (OPS-05), for the desktop that reads the
 * Worker's answer before writing any of it to disk.
 *
 * Every object is strict: a field this version does not know is refused, not
 * written, so nothing new can reach a customer's files without this file (and
 * its review) changing first. Values that only name a kind of thing (an event
 * kind, a feature, a grant source) are checked as slugs, so an older desktop
 * can still export after the service adds one.
 *
 * Kept here rather than in shared/ so the Worker bundles one copy of zod, as
 * ../organization-setup/schema.ts is.
 */
import { z } from 'zod';
import { ACCESS_CONTRACT_VERSION, type AccessView } from '../../../../shared/access.js';
import {
  EXPORT_HISTORY_LIMIT,
  ORGANIZATION_EXPORT_VERSION,
  type OrganizationAccountExport,
} from '../../../../shared/organization-export.js';
import { SETUP_RECORD_LIMITS } from '../../../../shared/organization-setup.js';
import { organizationSetupRecordSchema } from '../organization-setup/schema.js';

/** The account service's id rule (`accountId` in ../domain.ts). */
const recordId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/);
const time = z.iso.datetime({ offset: true });
const slug = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/);
/** The account service's label rule: names, business names and industries. */
const label = z.string().min(1).max(200);
const role = z.enum(['owner', 'admin', 'member']);

const grantSummarySchema = z.strictObject({
  id: recordId,
  planId: slug.nullable(),
  planLabel: label.nullable(),
  features: z.array(slug).max(64),
  source: slug,
  validFrom: time,
  validUntil: time,
  state: slug,
  /** Legacy person-grant scope remains readable; it grants no Business coverage. */
  scope: z.literal('person').optional(),
});

/** The owner's access view, as `GET /account/organizations/:id/access` answers it. */
export const accessViewSchema = z.strictObject({
  v: z.literal(ACCESS_CONTRACT_VERSION),
  organizationId: recordId,
  role,
  roleLabel: label,
  capabilities: z.strictObject({
    seePlan: z.boolean(),
    managePeople: z.enum(['everyone', 'employees', 'nobody']),
    configure: z.boolean(),
  }),
  state: slug,
  planLabel: label.nullable(),
  planId: slug.nullable(),
  features: z.array(slug).max(64),
  agent: z.strictObject({ included: z.boolean(), reason: z.string().max(1_000) }),
  validFrom: time.nullable(),
  validUntil: time.nullable(),
  revision: z.number().int().min(0),
  grants: z.array(grantSummarySchema).max(10_000).nullable(),
  checkedAt: time,
  /** Legacy field remains readable; new access views do not assert Individual Business coverage. */
  coveredBy: z.literal('individual').optional(),
});

/** What the desktop accepts back from `GET /account/organizations/:id/export`. */
export const organizationAccountExportSchema = z.strictObject({
  v: z.literal(ORGANIZATION_EXPORT_VERSION),
  organization: z.strictObject({
    id: recordId,
    name: label,
    industry: label.nullable(),
    tenantId: recordId,
    createdAt: time,
    createdBy: recordId,
  }),
  exportedAt: time,
  exportedBy: recordId,
  people: z.array(z.strictObject({
    personId: recordId,
    name: label,
    role,
    state: z.enum(['invited', 'active', 'revoked']),
    joinedAt: time.nullable(),
    revokedAt: time.nullable(),
  })).max(100_000),
  invitations: z.array(z.strictObject({
    id: z.string().regex(/^[a-f0-9]{16}$/),
    role,
    email: z.email().max(320).nullable(),
    createdAt: time,
    expiresAt: time,
    invitedBy: recordId,
  })).max(100_000),
  access: accessViewSchema,
  devices: z.discriminatedUnion('included', [
    z.strictObject({
      included: z.literal(true),
      devices: z.array(z.strictObject({
        deviceId: recordId,
        label: z.string().min(1).max(60),
        createdAt: time,
        lastSeenAt: time.nullable(),
      })).max(1_000),
    }),
    z.strictObject({ included: z.literal(false), reason: z.string().min(1).max(1_000) }),
  ]),
  setupRevisions: z.array(z.strictObject({
    revision: z.number().int().min(1).max(SETUP_RECORD_LIMITS.revision),
    writtenAt: time,
    writtenBy: recordId,
    record: organizationSetupRecordSchema,
  })).max(SETUP_RECORD_LIMITS.revision),
  history: z.strictObject({
    events: z.array(z.strictObject({
      id: recordId,
      at: time,
      kind: slug,
      actorPersonId: recordId,
      targetId: recordId.nullable(),
    })).max(EXPORT_HISTORY_LIMIT),
    complete: z.boolean(),
  }),
});

/**
 * An export as this desktop read it. The same fields as OrganizationAccountExport, with the
 * slug-checked values (kinds, features, sources, states) left as the strings the service sent.
 */
export type ReadOrganizationExport = z.infer<typeof organizationAccountExportSchema>;

/** Every key the service's type names is one the schema reads: a new field fails here first. */
type Keys<T> = T extends readonly (infer U)[] ? Keys<U> : T extends object ? { [K in keyof T]-?: Keys<T[K]> } : true;
export const SCHEMA_READS_EVERY_FIELD: Keys<OrganizationAccountExport> extends Keys<ReadOrganizationExport> ? true : never = true;
export const SCHEMA_READS_NO_EXTRA_FIELD: Keys<ReadOrganizationExport> extends Keys<OrganizationAccountExport> ? true : never = true;
export const ACCESS_VIEW_READ_EVERY_FIELD: keyof AccessView extends keyof z.infer<typeof accessViewSchema> ? true : never = true;
