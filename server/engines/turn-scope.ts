/**
 * The turn-bound read scope (security pass 2026-09-23).
 *
 * An Ask or Plan turn's send dialog says exactly which documents go to the provider. This
 * module turns that one turn's choice into the only project files the turn may read:
 *
 * - `buildTurnReadScope` makes the scope from the turn's own command: its route, its mode,
 *   the documents it already read and hash-checked, and its explicit `readAccess`. Nothing
 *   is taken from a setting, an earlier turn or a model. `selected` (the default) binds the
 *   allowed set to the chosen files; `project` needs a route whose reads the host answers
 *   before they run (`WHOLE_PROJECT_READ_ROUTES`) and is refused anywhere else.
 * - Every scope carries a host grant. A grant is per turn, expires with the turn window and
 *   is revoked when the project's folder or consent changes, so a turn that waited in a queue
 *   cannot read under a scope that no longer holds.
 * - `readAllowed` is the one check a read goes through before it runs. It resolves the path
 *   on disk: a link or junction at any component, a private or credential name, or a
 *   resolved location outside the project folder is refused, however it is spelled. For a
 *   `selected` turn only the chosen files themselves pass.
 * - It composes with the project's Cloud sharing allowlist (`server/cloud-sharing.ts`),
 *   which is the standing, default-deny list of documents a route may receive. The turn's
 *   choice narrows it and never widens it: a whole-project turn may list folders and read
 *   any file that list shares with its route, and nothing else. Searching file contents
 *   across a folder would read files the list does not share, so search is limited to one
 *   shared file.
 *
 * `readAllowed(scope, kind, path, base)` is the seam for host-run read tools: the model-API
 * routes' tools (Wave 2, `server/harness/capabilities/read-scope-tools.ts`) adopt it with one
 * call before they touch a file, so they share this allowed set and grant rather than
 * re-deriving them from `scope.root`.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { ApiError, isContained, projectFile, rejectForbidden, safeAbsolute } from '../paths.js';
import { READ_ACCESS, wholeProjectReadAvailable, type ReadAccess } from '../../shared/read-access.js';
import { insideRoot, readAccessOf, type ApprovedMcpServer, type ReadScope } from './read-scope.js';

/** A grant lives no longer than a native turn may hold its run (35 minutes). */
export const READ_GRANT_MS = 35 * 60_000;

interface Grant {
  readonly projectId: string;
  readonly expires: number;
}
const grants = new Map<string, Grant>();

function sweep(now = Date.now()) {
  for (const [id, grant] of grants) if (grant.expires <= now) grants.delete(id);
}

/** A fresh grant for one turn in one project. */
export function openReadGrant(projectId: string, ttlMs = READ_GRANT_MS): string {
  sweep();
  const id = randomUUID();
  grants.set(id, { projectId, expires: Date.now() + Math.max(0, ttlMs) });
  return id;
}

/** The turn ended: its reads end with it. */
export function closeReadGrant(id: string | undefined): void {
  if (id) grants.delete(id);
}

/** The project's folder or read consent changed: every outstanding turn grant ends. */
export function revokeProjectReadGrants(projectId: string): void {
  for (const [id, grant] of grants) if (grant.projectId === projectId) grants.delete(id);
}

export function readGrantLive(id: string | undefined): boolean {
  if (!id) return false;
  const grant = grants.get(id);
  if (!grant) return false;
  if (grant.expires <= Date.now()) {
    grants.delete(id);
    return false;
  }
  return true;
}

/** The turn's read choice from its command. Absent is `selected`; anything else is refused. */
export function parseReadAccess(value: unknown): ReadAccess {
  if (value === undefined) return 'selected';
  if (typeof value === 'string' && (READ_ACCESS as readonly string[]).includes(value))
    return value as ReadAccess;
  throw new ApiError(
    400,
    'Choose whether this message may read only the chosen documents or the whole project folder.',
  );
}

const fold = (value: string) => (process.platform === 'win32' ? value.toLowerCase() : value);

export interface TurnReadScopeInput {
  readonly projectId: string;
  readonly mode: string;
  /** The project folder. It is put through the path trust funnel here again. */
  readonly root: string;
  /** The route this turn will run on. */
  readonly route: string;
  /** The turn's own `readAccess` field, unparsed. */
  readonly access?: unknown;
  /** The documents this turn already read and hash-checked. */
  readonly documents: readonly { readonly path: string }[];
  readonly web?: boolean;
  readonly mcp?: readonly ApprovedMcpServer[];
  /**
   * The documents Cloud sharing lets this route receive (`cloudSharing(state).documents`
   * when the route is on its list, otherwise none). Absent means none.
   */
  readonly shared?: readonly string[];
  /** Test seam: the grant window. */
  readonly grantMs?: number;
}

/**
 * The scope one Ask or Plan turn runs with, or undefined for any other mode. A document that
 * is linked, private or resolves outside the folder refuses the turn rather than being
 * dropped quietly, because the dialog already told the person it would be sent.
 */
export async function buildTurnReadScope(input: TurnReadScopeInput): Promise<ReadScope | undefined> {
  if (input.mode !== 'ask' && input.mode !== 'plan') return undefined;
  const access = parseReadAccess(input.access);
  if (access === 'project' && !wholeProjectReadAvailable(input.route))
    throw new ApiError(
      409,
      'Reading the whole project folder is not available on this route. Choose the documents to include instead.',
    );
  const root = await safeAbsolute(input.root);
  const realRoot = await fs.realpath(root);
  const files: string[] = [];
  for (const document of input.documents) {
    const found = await projectFile(root, document.path);
    let real: string;
    try {
      real = await fs.realpath(found.absolute);
    } catch {
      throw new ApiError(409, `${found.relative} changed. Choose its current version before sending.`);
    }
    if (!isContained(realRoot, real)) throw new ApiError(403, 'Choose a file inside this project.');
    files.push(real);
  }
  return Object.freeze({
    root,
    web: input.web ?? true,
    ...(input.mcp ? { mcp: input.mcp } : {}),
    access,
    files: Object.freeze(files),
    shared: Object.freeze([...new Set(input.shared ?? [])]),
    grant: openReadGrant(input.projectId, input.grantMs),
  });
}

export type ReadKindForFiles = 'read' | 'list' | 'search';
export type ReadCheck = { ok: true; real: string } | { ok: false; reason: string };

/**
 * Whether one file read may run, decided before it runs. `base` is the reading tool's own
 * working folder, which a relative path is resolved against; it defaults to the project root.
 */
export async function readAllowed(
  scope: ReadScope,
  kind: ReadKindForFiles,
  candidate: string,
  base: string = scope.root,
): Promise<ReadCheck> {
  const no = (reason: string): ReadCheck => ({ ok: false, reason });
  if (!['read', 'list', 'search'].includes(kind)) return no('not a file read');
  if (typeof candidate !== 'string' || !candidate || candidate.includes('\0')) return no('no path');
  if (/^[a-z][a-z0-9+.-]+:\/\//i.test(candidate) || /^[\\/]{2}/.test(candidate))
    return no('not a project path');
  const access = readAccessOf(scope);
  // A whole-project read needs a live host grant; a selected turn's grant, when it has one,
  // must still be live too.
  if (access === 'project' ? !readGrantLive(scope.grant) : scope.grant !== undefined && !readGrantLive(scope.grant))
    return no('this turn no longer has read access');
  const absolute = path.resolve(base, candidate);
  if (!insideRoot(scope.root, absolute)) return no('outside the project folder');
  let real: string;
  let realRoot: string;
  let isFile: boolean;
  try {
    // Links and junctions at any component, private and credential names, 8.3 aliases.
    await safeAbsolute(absolute);
    realRoot = await fs.realpath(scope.root);
    real = await fs.realpath(absolute);
    if (!isContained(realRoot, real)) return no('resolves outside the project folder');
    rejectForbidden(real);
    isFile = (await fs.stat(real)).isFile();
  } catch {
    return no('outside the project folder, linked, private or missing');
  }
  if (access === 'selected') {
    if (kind !== 'read') return no('only the chosen documents can be read');
    if (!(scope.files ?? []).some((file) => fold(file) === fold(real)))
      return no('not one of the chosen documents');
    return { ok: true, real };
  }
  // Whole project: listing names is allowed anywhere inside; reading content needs the file
  // to be one Cloud sharing lets this route receive.
  if (kind === 'list' && !isFile) return { ok: true, real };
  if (!isFile) return no('searching a folder would read files the project does not share');
  const name = path.relative(realRoot, real).split(path.sep).join('/');
  if (!(scope.shared ?? []).includes(name))
    return no('this project does not share that file with this route');
  return { ok: true, real };
}
