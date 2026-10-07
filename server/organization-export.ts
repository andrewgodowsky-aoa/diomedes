/**
 * OPS-05 on this computer: the Business owner's copy of the business's
 * records, written as plain files into one of the business's own projects.
 *
 * - What the account service keeps (people, plan, phones, every setup
 *   revision, the membership history) comes from its owner-only export,
 *   read against a strict schema
 *   (services/control-plane/src/organization-export/schema.ts). A former
 *   owner, a Manager and an Employee are refused there, whatever this
 *   computer still remembers.
 * - What this computer keeps (every configuration revision, the business's
 *   access profiles, the projects linked to it and where it writes) is read
 *   under the store lock.
 * - The archive goes only into a project that belongs to the business, as
 *   one recorded write in that project's History: every file new, nothing
 *   overwritten. Every value is checked first for text that looks like a key,
 *   password or card number; one that does stops the export, and nothing is
 *   written.
 * - An export is a copy. It revokes, removes and cancels nothing. Leaving is
 *   the separate steps the manifest lists (EXIT_STEPS), each through a
 *   control that already exists.
 *
 * `assembleArchive` and `secretLikePaths` are pure; the route is thin.
 */
import type { Express, Request, Response } from 'express';
import { containsSecretLikeText } from '../shared/business-setup.js';
import type { OrganizationAccessView } from '../shared/business-access.js';
import type { ConfigurationManifest } from '../shared/configuration.js';
import {
  EXIT_STEPS,
  EXPORT_FORMATS,
  EXPORT_HISTORY_LIMIT,
  OMITTED_CATEGORIES,
  ORGANIZATION_EXPORT_VERSION,
  type ExportCategoryId,
  type ExportFile,
  type OrganizationExportManifest,
  type OrganizationExportResult,
} from '../shared/organization-export.js';
import type { OutputBinding } from '../shared/workspaces.js';
import type { ReadOrganizationExport } from '../services/control-plane/src/organization-export/schema.js';
import type { AccountSessionService } from './accounts/session.js';
import type { ConfigurationService } from './configuration.js';
import { ApiError, MAX_TEXT_BYTES } from './paths.js';
import type { Store } from './store.js';
import type { WorkspaceService } from './workspaces.js';

/** What this computer holds for the business. */
export interface LocalRecords {
  /** Every configuration revision this computer holds, oldest first. */
  configurations: readonly ConfigurationManifest[];
  /** The business's access resources, profiles and assignments. */
  access: OrganizationAccessView;
  /** The business's projects on this computer. Their files are already plain files in these folders. */
  projects: readonly { projectId: string; name: string; folder: string }[];
  /** The project the business writes its work into, if one is chosen. */
  output: OutputBinding | null;
}

/** One file of the archive, with the value it was written from (checked before anything is written). */
export interface ArchiveFile {
  path: string;
  text: string;
  value: unknown;
}

export interface Archive {
  /** Where in the project the archive goes. */
  folder: string;
  files: ArchiveFile[];
  manifest: OrganizationExportManifest;
}

export interface ArchiveOptions {
  /** When the archive is written. */
  at: string;
  /** The app version writing it. */
  build: string;
  folder: string;
  /** The most one file may hold. The store refuses text over MAX_TEXT_BYTES; the default leaves room. */
  partBytes?: number;
}

export const ARCHIVE_PART_BYTES = 7 * 1024 * 1024;

const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
const bytes = (text: string) => Buffer.byteLength(text, 'utf8');

/**
 * Split a list so each part's file stays under the limit, keeping order. An
 * item's size inside the file is its own pretty-printed size plus four spaces
 * on each of its lines and a separator, which is exact for this layout.
 */
function split<T>(items: readonly T[], overhead: number, limit: number, what: string): T[][] {
  const chunks: T[][] = [[]];
  let size = overhead;
  for (const item of items) {
    const text = JSON.stringify(item, null, 2);
    const cost = bytes(text) + 4 * (text.split('\n').length) + 2;
    if (overhead + cost > limit)
      throw new ApiError(413, `One of the business's ${what} is too large to write to a file, so the export stopped.`, {
        code: 'export_too_large',
      });
    if (size + cost > limit && chunks.at(-1)!.length > 0) {
      chunks.push([]);
      size = overhead;
    }
    chunks.at(-1)!.push(item);
    size += cost;
  }
  return chunks;
}

const TITLES: Record<ExportCategoryId, string> = {
  business: 'The business, its people, its plan and the computers phones can reach',
  'setup-revisions': "Every revision of the business's setup, exactly as it was saved",
  'account-history': 'The history of who joined, left or changed role, oldest first',
  configuration: "This computer's configuration revisions and the business's access profiles",
  'this-computer': "The business's projects on this computer and where it writes",
};

export function assembleArchive(payload: ReadOrganizationExport, local: LocalRecords, options: ArchiveOptions): Archive {
  const limit = options.partBytes ?? ARCHIVE_PART_BYTES;
  const files: ArchiveFile[] = [];
  const listed: ExportFile[] = [];

  /** One category: a document, with its list split into parts when it is too large for one file. */
  function add(
    category: ExportCategoryId,
    name: string,
    source: ExportFile['source'],
    document: Record<string, unknown>,
    list: { key: string; items: readonly unknown[] } | null,
    note: string | null = null,
    title = TITLES[category],
  ) {
    const envelope = (items: readonly unknown[] | null, part: number, parts: number) => ({
      format: EXPORT_FORMATS[category],
      part,
      parts,
      ...document,
      ...(list ? { [list.key]: items } : {}),
    });
    const overhead = bytes(json(envelope([], 999, 999))) + 16;
    const chunks = list ? split(list.items, overhead, limit, list.key) : [null];
    chunks.forEach((chunk, index) => {
      const path = chunks.length === 1 ? `${name}.json` : `${name}-${String(index + 1).padStart(3, '0')}.json`;
      const value = envelope(chunk, index + 1, chunks.length);
      const text = json(value);
      if (bytes(text) > Math.min(limit, MAX_TEXT_BYTES))
        throw new ApiError(413, `The business's ${name} records are too large to write to one file, so the export stopped.`, {
          code: 'export_too_large',
        });
      files.push({ path: `${options.folder}/${path}`, text, value });
      listed.push({
        path,
        category,
        title,
        format: EXPORT_FORMATS[category],
        source,
        count: chunk ? chunk.length : 1,
        part: index + 1,
        parts: chunks.length,
        ...(note ? { note } : {}),
      });
    });
  }

  const owner = payload.people.find((person) => person.personId === payload.exportedBy);
  add('business', 'business', 'account-service', {
    organization: payload.organization,
    exportedAt: payload.exportedAt,
    exportedBy: payload.exportedBy,
    plan: payload.access,
    phones: payload.devices,
    invitations: payload.invitations,
  }, { key: 'people', items: payload.people },
  payload.devices.included ? null : `No computers are listed for phones: ${payload.devices.reason}`);
  add('setup-revisions', 'setup-revisions', 'account-service', {}, { key: 'revisions', items: payload.setupRevisions });
  add('account-history', 'account-history', 'account-service', { complete: payload.history.complete },
    { key: 'events', items: payload.history.events },
    payload.history.complete ? null : `Only the newest ${EXPORT_HISTORY_LIMIT.toLocaleString('en-US')} events. The history held more.`);
  add('configuration', 'configuration', 'this-computer', {
    active: local.configurations.find((manifest) => manifest.state === 'active')?.revision ?? null,
  }, { key: 'revisions', items: local.configurations });
  add('configuration', 'access', 'this-computer', { access: local.access }, null, null,
    "The business's access resources, profiles and assignments on this computer");
  add('this-computer', 'this-computer', 'this-computer', {
    organization: {
      id: payload.organization.id,
      name: payload.organization.name,
      tenantId: payload.organization.tenantId,
    },
    output: local.output,
  }, { key: 'projects', items: local.projects });

  const manifest: OrganizationExportManifest = {
    v: ORGANIZATION_EXPORT_VERSION,
    kind: 'nectovia.organization-export',
    organization: { id: payload.organization.id, name: payload.organization.name, tenantId: payload.organization.tenantId },
    exportedAt: options.at,
    exportedBy: { personId: payload.exportedBy, name: owner?.name ?? '' },
    build: options.build,
    files: listed,
    omitted: [...OMITTED_CATEGORIES],
    leaving: [...EXIT_STEPS],
  };
  const manifestValue = { format: EXPORT_FORMATS.manifest, ...manifest };
  files.push({ path: `${options.folder}/manifest.json`, text: json(manifestValue), value: manifestValue });
  const readme = renderReadme(manifest);
  files.push({ path: `${options.folder}/README.md`, text: readme, value: readme });
  return { folder: options.folder, files, manifest };
}

/** The archive's front page, for a person reading the folder without this app. */
export function renderReadme(manifest: OrganizationExportManifest): string {
  const name = manifest.organization.name;
  const from = (source: ExportFile['source']) => (source === 'account-service' ? 'Nectovia account service' : 'This computer');
  const lines = [
    `# ${name}: business records`,
    '',
    `Exported ${manifest.exportedAt} by ${manifest.exportedBy.name || 'the Business owner'}, the Business owner, with Nectovia ${manifest.build}.`,
    '',
    `This folder is a copy of ${name}'s records. Taking it changed nothing: nobody lost access, and nothing was cancelled or deleted.`,
    '',
    '## Files',
    '',
    'Each file is JSON. It names its own format and version (`format`), and a category too large for one file is split into numbered parts (`part` of `parts`). `manifest.json` lists every file.',
    '',
    '| File | What it holds | From | Records |',
    '|---|---|---|---|',
    ...manifest.files.map((file) => `| ${file.path} | ${file.title}${file.parts > 1 ? ` (part ${file.part} of ${file.parts})` : ''} | ${from(file.source)} | ${file.count} |`),
    '',
    ...manifest.files.flatMap((file) => (file.note ? [`${file.path}: ${file.note}`, ''] : [])),
    '## Not included',
    '',
    ...manifest.omitted.map((item) => `- **${item.title}.** ${item.why}`),
    '',
    '## Leaving Nectovia',
    '',
    'Each step is separate, and none of them happened because of this export.',
    '',
    ...manifest.leaving.map((step, index) => `${index + 1}. **${step.title}.** ${step.how}`),
    '',
  ];
  return lines.join('\n');
}

/** Keys whose values this app or the account service generated: ids, who acted, times and digests. */
const GENERATED_KEY = /^(?:id|ids|by|at|digest|[a-z]+(?:Id|Ids|By|At|Digest))$/;
// A random id, bare or with its kind in front (person_..., relay_device_..., project:...).
const GENERATED_UUID = /^(?:[a-z][a-z0-9]*[_:.-])*[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const GENERATED_VALUE: readonly RegExp[] = [
  GENERATED_UUID,
  // A digest, or an invitation code's id (the first 16 characters of its hash).
  /^(?:[a-z0-9]+:)?[0-9a-f]{16,128}$/i,
  // A time.
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/,
];
const generated = (text: string) => GENERATED_VALUE.some((shape) => shape.test(text));

/**
 * Where a value holds text that looks like a key, password or card number, as
 * paths into it. Each field is checked on its own. A field that holds an id,
 * time or digest this app or the account service generated is skipped: a
 * random id is often all digits in places, and the card check would otherwise
 * stop about one export in twenty-five with a thousand events in its history.
 * Only the field names that hold generated values are skipped, so a card
 * number in an answer, a name or a label is still found.
 */
export function secretLikePaths(value: unknown, root = '$'): string[] {
  const found: string[] = [];
  const visit = (node: unknown, at: string, key: string | null) => {
    if (typeof node === 'string' || typeof node === 'number' || typeof node === 'bigint') {
      const text = String(node);
      // Audit records use this multi-word key. Only UUIDs qualify here; a bare card number does not.
      if (key === 'actorPersonId' && GENERATED_UUID.test(text)) return;
      if (key !== null && GENERATED_KEY.test(key) && generated(text)) return;
      if (containsSecretLikeText(text)) found.push(at);
      return;
    }
    if (Array.isArray(node)) {
      node.forEach((item, index) => visit(item, `${at}[${index}]`, key));
      return;
    }
    if (node && typeof node === 'object')
      for (const [name, item] of Object.entries(node)) {
        if (!generated(name) && containsSecretLikeText(name)) found.push(`${at} (a field name)`);
        visit(item, `${at}.${name}`, name);
      }
  };
  visit(value, root, null);
  return found;
}

/** Every place in the archive that looks like a credential, by file. */
export function archiveSecretLikePaths(archive: Archive): string[] {
  return archive.files.flatMap((file) => {
    const name = file.path.slice(archive.folder.length + 1);
    return typeof file.value === 'string'
      ? (containsSecretLikeText(file.value) ? [name] : [])
      : secretLikePaths(file.value).map((path) => `${name} ${path}`);
  });
}

// --- on this computer ----------------------------------------------------------------

export interface ExportDependencies {
  store: Store;
  workspaces: WorkspaceService;
  configuration: ConfigurationService;
  accounts: Pick<AccountSessionService, 'exportOrganization'> | null;
  build: string;
  now?: () => Date;
}

const NOT_THE_BUSINESS_PROJECT = "Choose one of this business's own projects to write its records into.";

/** The folder's name says when, and a second export in the same second gets its own. */
async function freeFolder(store: Store, projectId: string, at: string): Promise<string> {
  const stamp = `${at.slice(0, 19).replace(/:/g, '-')}Z`;
  for (let n = 1; n <= 20; n += 1) {
    const folder = `Exports/business-records-${stamp}${n === 1 ? '' : `-${n}`}`;
    if ((await store.current(projectId, `${folder}/manifest.json`)) === null) return folder;
  }
  throw new ApiError(409, 'Another export is being written. Try again in a moment.', { code: 'export_busy' });
}

async function localRecords(deps: ExportDependencies, organizationId: string): Promise<LocalRecords> {
  const access = deps.workspaces.accessView(organizationId);
  const linked = new Set(
    access.resources.filter((resource) => resource.type === 'project' && resource.state === 'active').map((resource) => resource.externalId),
  );
  return {
    configurations: [...deps.configuration.history(organizationId)].reverse(),
    access,
    projects: (await deps.store.projects())
      .filter((project) => linked.has(project.id))
      .map((project) => ({ projectId: project.id, name: project.name, folder: project.folder })),
    output: deps.workspaces.outputBinding(organizationId),
  };
}

/**
 * Export the business's records into one of its projects. The account service decides who
 * may: only the Business owner. The call to it runs outside the store lock; everything this
 * computer reads and writes runs inside it.
 */
export async function exportOrganization(
  deps: ExportDependencies,
  organizationId: string,
  projectId: string,
): Promise<OrganizationExportResult> {
  const { store, workspaces } = deps;
  // Membership here first, so a business that isn't yours reads the same as one that doesn't exist.
  workspaces.assertMine(organizationId);
  const organization = workspaces.organization(organizationId)!;
  if (!workspaces.isAccountBusiness(organizationId) || !deps.accounts)
    throw new ApiError(409, "This business isn't kept by a Nectovia account, so there are no account records to export. Sign in to export a business you own.", {
      code: 'export_needs_account',
    });
  const destination = () => {
    if (workspaces.projectOwner(projectId)?.organizationId !== organizationId)
      throw new ApiError(409, NOT_THE_BUSINESS_PROJECT, { code: 'export_project_not_owned' });
  };
  destination();
  const payload = await deps.accounts.exportOrganization(organizationId);
  return store.locked(async () => {
    // The project may have been unlinked while the account service answered.
    destination();
    const at = (deps.now?.() ?? new Date()).toISOString();
    const folder = await freeFolder(store, projectId, at);
    const archive = assembleArchive(payload, await localRecords(deps, organizationId), { at, build: deps.build, folder });
    const found = archiveSecretLikePaths(archive);
    if (found.length)
      throw new ApiError(
        422,
        'Something in these records looks like a key, password or card number, so the export stopped and nothing was written. Remove it from the business, then export again.',
        { code: 'export_secret_like', where: found.slice(0, 10) },
      );
    const entry = await store.writeRecorded(
      projectId,
      archive.files.map((file) => ({ path: file.path, text: file.text, expected: null })),
      {
        actor: 'you',
        merge: false,
        label: 'Business records exported',
        sentence: `You exported ${organization.name}'s records to ${folder}.`,
      },
    );
    return { projectId, folder, manifest: archive.manifest, historyEntryId: entry.id };
  });
}

const body = (req: Request): Record<string, unknown> =>
  req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? (req.body as Record<string, unknown>) : {};

/** `POST /api/workspace/organizations/:organizationId/export` with `{ projectId }`. */
export function mountOrganizationExportRoute(app: Express, deps: ExportDependencies) {
  app.post('/api/workspace/organizations/:organizationId/export', async (req: Request, res: Response, next: (error?: unknown) => void) => {
    try {
      res.json(await exportOrganization(deps, String(req.params.organizationId ?? ''), String(body(req).projectId ?? '')));
    } catch (error) {
      next(error);
    }
  });
}
