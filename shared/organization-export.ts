/**
 * OPS-05: a business owner's copy of the business's records, and how leaving
 * is done.
 *
 * An export is a copy, never a transfer. Taking one removes, revokes and
 * cancels nothing, so it cannot cut off the people still working. Leaving is
 * a set of separate steps (`EXIT_STEPS`), each through a control that already
 * exists: removing people, turning off phone access, disconnecting services
 * and ending the plan.
 *
 * The records come from two places:
 * - The account service keeps the business's people, plan, phones, every
 *   setup revision and the history of its membership changes. Only the
 *   Business owner may export them (`GET /account/organizations/:id/export`),
 *   because they name everyone in the business.
 * - Each computer keeps the business's configuration and the projects it
 *   writes into.
 *
 * No export carries a credential: no sign-in session, no invitation token or
 * code, no connection key and no phone's device key. What is not included is
 * listed in the manifest, with why (`OMITTED_CATEGORIES`).
 *
 * Pure and dependency-free: type imports only. The account service's Worker
 * bundles this file.
 */
import type { AccessView } from './access.js';
import type { OrganizationSetupRecord } from './organization-setup.js';
import type { MemberRole, MembershipState } from './workspaces.js';

export const ORGANIZATION_EXPORT_VERSION = 1 as const;

/** The most account-history events one export carries, newest kept last. */
export const EXPORT_HISTORY_LIMIT = 20_000;

/** One person in the business, as the owner's roster shows them. */
export interface ExportedPerson {
  personId: string;
  name: string;
  role: MemberRole;
  state: MembershipState;
  joinedAt: string | null;
  revokedAt: string | null;
}

/**
 * An invitation code nobody has used yet. The code itself is a credential and
 * is never exported; `id` is the one the owner revokes it by.
 */
export interface ExportedInvitation {
  id: string;
  role: MemberRole;
  email: string | null;
  createdAt: string;
  expiresAt: string;
  invitedBy: string;
}

/** A computer phones can reach now. Its device key is never exported. */
export interface ExportedDevice {
  deviceId: string;
  label: string;
  createdAt: string;
  lastSeenAt: string | null;
}

/**
 * One change to the business's membership or invitations. `targetId` is the
 * person, business or invitation code it concerned. It is null for an
 * invitation to someone not yet in the business, whose identity-provider id is
 * not the business's to keep.
 */
export interface ExportedEvent {
  id: string;
  at: string;
  kind: string;
  actorPersonId: string;
  targetId: string | null;
}

/** One stored revision of the business's setup (ORG-01), exactly as it was saved. */
export interface ExportedSetupRevision {
  revision: number;
  writtenAt: string;
  writtenBy: string;
  record: OrganizationSetupRecord;
}

/** What the account service gives the Business owner. */
export interface OrganizationAccountExport {
  v: typeof ORGANIZATION_EXPORT_VERSION;
  organization: {
    id: string;
    name: string;
    industry: string | null;
    tenantId: string;
    createdAt: string;
    createdBy: string;
  };
  exportedAt: string;
  exportedBy: string;
  people: ExportedPerson[];
  invitations: ExportedInvitation[];
  /** The plan, as the owner's access view shows it. */
  access: AccessView;
  /** Phones' computers, or why there are none to list. */
  devices: { included: true; devices: ExportedDevice[] } | { included: false; reason: string };
  setupRevisions: ExportedSetupRevision[];
  /** `complete` is false when the history held more than `EXPORT_HISTORY_LIMIT` events and only the newest are here. */
  history: { events: ExportedEvent[]; complete: boolean };
}

// --- the archive a computer writes ------------------------------------------------------

export type ExportCategoryId =
  | 'business'
  | 'setup-revisions'
  | 'account-history'
  | 'configuration'
  | 'this-computer';

/**
 * The format each archive file is written in, named and versioned so a reader
 * can tell what it holds without this app. Each file states its own format.
 */
export const EXPORT_FORMATS = Object.freeze({
  manifest: 'nectovia.organization-export.manifest/1',
  business: 'nectovia.organization-export.business/1',
  'setup-revisions': 'nectovia.organization-export.setup-revisions/1',
  'account-history': 'nectovia.organization-export.account-history/1',
  configuration: 'nectovia.organization-export.configuration/1',
  'this-computer': 'nectovia.organization-export.this-computer/1',
} as const);

/** One file in the archive: what it holds, in which format, and where that came from. */
export interface ExportFile {
  path: string;
  category: ExportCategoryId;
  title: string;
  format: string;
  source: 'account-service' | 'this-computer';
  /** How many records it holds. */
  count: number;
  /** A category too large for one file is split into numbered parts, in order. */
  part: number;
  parts: number;
  /** What a reader should know about what the file holds, such as a history cut short. */
  note?: string;
}

/** A category of the business's records that is not in the archive, and why. */
export interface OmittedCategory {
  id: string;
  title: string;
  why: string;
}

/** One separate step of leaving, and the control that does it. */
export interface ExitStep {
  id: string;
  title: string;
  how: string;
}

export interface OrganizationExportManifest {
  v: typeof ORGANIZATION_EXPORT_VERSION;
  kind: 'nectovia.organization-export';
  organization: { id: string; name: string; tenantId: string };
  exportedAt: string;
  exportedBy: { personId: string; name: string };
  /** The app version that wrote the archive. */
  build: string;
  files: ExportFile[];
  omitted: OmittedCategory[];
  leaving: ExitStep[];
}

/** What the desktop answers after writing an archive. */
export interface OrganizationExportResult {
  projectId: string;
  folder: string;
  manifest: OrganizationExportManifest;
  /** The recorded write, as the project's History shows it. */
  historyEntryId: string;
}

export const OMITTED_CATEGORIES: readonly OmittedCategory[] = Object.freeze([
  {
    id: 'credentials',
    title: "Sign-in sessions, invitation tokens and codes, connection keys, and phones' device keys",
    why: 'They are credentials, and an export never carries one. To stop them working, use the steps under Leaving.',
  },
  {
    id: 'billing',
    title: 'Billing, payments and credit',
    why: 'Nectovia keeps these for accounting. They are not part of this export.',
  },
  {
    id: 'plan-notes',
    title: "Nectovia's notes on your plan",
    why: "Each plan grant carries Nectovia's own working note and the invoice or agreement it answers to. The export has the plan itself.",
  },
  {
    id: 'connected-services',
    title: 'Data in the services you connected, such as email, drives and business systems',
    why: 'It stays with those services, and Nectovia never held a copy. Export it from each service.',
  },
  {
    id: 'other-computers',
    title: 'Configuration, work and files on other computers',
    why: "Each computer keeps its own configuration and its own project folders. This archive has this computer's. Export on each computer to take theirs.",
  },
  {
    id: 'agent-records',
    title: 'Records of Nectovia Agent admissions and usage',
    why: 'Not in this export yet. The app shows how many requests the business has used.',
  },
]);

export const EXIT_STEPS: readonly ExitStep[] = Object.freeze([
  {
    id: 'people',
    title: 'Remove people',
    how: 'In the business workspace, remove each person. Their access ends at their next check. The business keeps its records, and nobody removed can export them.',
  },
  {
    id: 'phones',
    title: 'Turn off phone access',
    how: 'Turn off each computer phones can reach. It can never connect again.',
  },
  {
    id: 'connections',
    title: 'Disconnect connected services',
    how: "In Connections on each computer, disconnect each service, then remove Nectovia from that service's own settings too.",
  },
  {
    id: 'plan',
    title: 'End the Business plan',
    how: 'Ask Nectovia to end it. Ending the plan stops the paid Agent, and it does not delete these records.',
  },
  {
    id: 'kept',
    title: 'What stays',
    how: "The account service keeps every setup revision and the history of the business's membership. They are never rewritten, and after you leave they are not shown to anyone who is no longer in the business.",
  },
]);
