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
import { createHash, randomUUID } from 'node:crypto';
import { ApiError, isContained, projectFile, rejectForbidden, safeAbsolute } from '../paths.js';
import { READ_ACCESS, wholeProjectReadAvailable, type ReadAccess } from '../../shared/read-access.js';
import { approvedMcpTool, insideRoot, readAccessOf, readScopeDigest, snapshotReadScope, type ApprovedMcpServer, type ReadScope } from './read-scope.js';
import { checkPageUrl, PageRefused, webReferences } from '../harness/capabilities/page-fetch.js';

/** A grant lives no longer than a native turn may hold its run (35 minutes). */
export const READ_GRANT_MS = 35 * 60_000;

interface Grant {
  readonly projectId: string;
  readonly expires: number;
  readonly stop: AbortController;
  readonly timer: ReturnType<typeof setTimeout>;
  /** Filled once by the host, only while this grant is still live. */
  scope?: ReadScope;
  /** Registered before source preparation awaits, so consent changes cancel it too. */
  preparing?: ReadScope;
  readonly scopes: Map<string, ReadScope>;
  readonly references: Map<string, { kind: 'message' | 'public-page'; source: string | null }>;
  referenceChars: number;
  runId?: string;
}
const grants = new Map<string, Grant>();
/** Admission pauses only for connectors whose effective approval is being changed. */
const connectorChanges = new Map<string, number>();
const connectorChangePending = (scope: ReadScope) =>
  (scope.mcp ?? []).some(server => connectorChanges.has(server.name));

function sweep(now = Date.now()) {
  for (const [id, grant] of grants) if (grant.expires <= now) closeReadGrant(id);
}

/**
 * A fresh grant for one turn in one project. Only the trusted host supplies the
 * admitted scope and the current human message. Documents, history, connector
 * answers and model prose must never be used as that initial web authority.
 * An unbound legacy grant grants no external reads.
 */
export function openReadGrant(
  projectId: string,
  ttlMs = READ_GRANT_MS,
  binding?: { scope: ReadScope; text?: string },
): string {
  sweep();
  const id = randomUUID();
  if (binding?.scope.projectId !== undefined && binding.scope.projectId !== projectId)
    throw new ApiError(400, 'The read scope belongs to another project.');
  const duration = Number.isFinite(ttlMs) ? Math.min(READ_GRANT_MS, Math.max(0, ttlMs)) : 0;
  const timer = setTimeout(() => closeReadGrant(id), duration);
  timer.unref();
  const grant: Grant = {
    projectId, expires: Date.now() + duration, stop: new AbortController(), timer,
    scopes: new Map(), references: new Map(), referenceChars: 0,
  };
  grants.set(id, grant);
  if (binding && !bindReadGrant(id, binding)) {
    closeReadGrant(id);
    throw new ApiError(409, 'Read access changed while preparing this message. Send it again.');
  }
  return id;
}

/** A grant revoked during source preparation cannot be replaced by a new one. */
function bindReadGrant(id: string, binding: { scope: ReadScope; text?: string }): boolean {
  if (!readGrantLive(id)) return false;
  const grant = grants.get(id)!;
  if (grant.scope) throw new ApiError(409, 'This read grant already has its admitted scope.');
  const scope = snapshotReadScope({ ...binding.scope, projectId: grant.projectId });
  if (connectorChangePending(scope)) return false;
  grant.scope = scope;
  grant.preparing = undefined;
  grant.scopes.set(readGrantScopeDigest(scope), scope);
  if (scope.web) addReferences(grant, webReferences(binding.text ?? ''), { kind: 'message', source: null });
  return true;
}

/** The turn ended: its reads end with it. */
export function closeReadGrant(id: string | undefined): void {
  if (!id) return;
  const grant = grants.get(id);
  if (!grant) return;
  grants.delete(id);
  clearTimeout(grant.timer);
  grant.stop.abort(new Error('This turn no longer has read access.'));
}

/** The project's folder or read consent changed: every outstanding turn grant ends. */
export function revokeProjectReadGrants(projectId: string): void {
  for (const [id, grant] of grants) if (grant.projectId === projectId) closeReadGrant(id);
}

/**
 * Settings uses the same host grant authority while a connector approval write
 * is pending. Old grants end immediately, including scopes still being built;
 * neither a failed write nor a turn reading the old file can revive them.
 */
export function holdConnectorReadGrants(names: readonly string[]): () => void {
  const changed = new Set(names);
  const revoke = () => {
    for (const [id, grant] of grants) {
      const scope = grant.scope ?? grant.preparing;
      if (scope?.mcp?.some(server => changed.has(server.name))) closeReadGrant(id);
    }
  };
  for (const name of changed) connectorChanges.set(name, (connectorChanges.get(name) ?? 0) + 1);
  revoke();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    revoke();
    for (const name of changed) {
      const remaining = (connectorChanges.get(name) ?? 1) - 1;
      if (remaining) connectorChanges.set(name, remaining);
      else connectorChanges.delete(name);
    }
  };
}

export function readGrantLive(id: string | undefined): boolean {
  if (!id) return false;
  const grant = grants.get(id);
  if (!grant) return false;
  if (grant.expires <= Date.now()) {
    closeReadGrant(id);
    return false;
  }
  return true;
}

/** The complete per-turn binding, independent of native process reuse identity. */
function readGrantScopeDigest(scope: ReadScope): string {
  return createHash('sha256').update(JSON.stringify({
    projectId: scope.projectId, route: scope.route, scope: readScopeDigest(scope), files: scope.files ?? [], shared: scope.shared ?? [],
  })).digest('hex');
}

const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);
function narrowedScope(original: ReadScope, scope: ReadScope): boolean {
  if (scope.projectId !== original.projectId || scope.route !== original.route || path.resolve(scope.root) !== path.resolve(original.root) ||
      readAccessOf(scope) !== readAccessOf(original) || (scope.web && !original.web) ||
      !same(scope.files ?? [], original.files ?? []) || !same(scope.shared ?? [], original.shared ?? [])) return false;
  return (scope.mcp ?? []).every(server => {
    const admitted = original.mcp?.find(candidate => candidate.name === server.name);
    return admitted !== undefined && server.command === admitted.command && same(server.args, admitted.args) &&
      same(server.envFrom, admitted.envFrom) && server.readTools.every(tool => admitted.readTools.includes(tool));
  });
}

/** Registers only a host narrowing of the original grant; never widens it. */
function matchingReadGrant(scope: ReadScope): Grant | undefined {
  if (!readGrantLive(scope.grant) || connectorChangePending(scope)) return undefined;
  const grant = grants.get(scope.grant!)!;
  if (!grant.scope || grant.projectId !== scope.projectId || !narrowedScope(grant.scope, scope)) return undefined;
  const key = readGrantScopeDigest(scope);
  if (!grant.scopes.has(key)) {
    if (grant.scopes.size >= 16) return undefined;
    grant.scopes.set(key, snapshotReadScope(scope));
  }
  return grant;
}

export const EXTERNAL_READ_ENDED = 'This turn no longer has matching read access.';
export type ExternalReadCheck = { ok: true } | { ok: false; reason: string };

/** Revocation and expiry cancel retained network reads and connector processes. */
export function readGrantSignal(scope: ReadScope): AbortSignal {
  return matchingReadGrant(scope)?.stop.signal ?? AbortSignal.abort(new Error(EXTERNAL_READ_ENDED));
}

/** Exact host-bound URL bytes, including hostname/path/query, before any DNS. */
export function externalReadAllowed(scope: ReadScope, name: string, input: unknown): ExternalReadCheck {
  const grant = matchingReadGrant(scope);
  if (!grant) return { ok: false, reason: EXTERNAL_READ_ENDED };
  const args = input && typeof input === 'object' && !Array.isArray(input) ? input as Record<string, unknown> : {};
  if (name === 'fetch_page') {
    if (!scope.web || typeof args.url !== 'string') return { ok: false, reason: 'This turn was not given web access.' };
    try {
      const url = checkPageUrl(args.url).toString();
      if (grant.references.has(url)) return { ok: true };
    } catch (error) {
      if (error instanceof PageRefused) return { ok: false, reason: error.message };
      throw error;
    }
    return { ok: false, reason: 'Only exact web addresses in the current message or links from an opened public page can be requested. Ask the person to include this address in their message.' };
  }
  if (name === 'connector_read' && typeof args.server === 'string' && typeof args.tool === 'string' &&
      approvedMcpTool(scope, args.server, args.tool)) return { ok: true };
  return { ok: false, reason: 'This turn was not given that connector read access.' };
}

function addReferences(grant: Grant, urls: readonly string[], provenance: { kind: 'message' | 'public-page'; source: string | null }) {
  for (const value of urls) {
    if (grant.references.size >= 128 || grant.referenceChars >= 64_000) break;
    let url: string;
    try { url = checkPageUrl(value).toString(); }
    catch (error) { if (error instanceof PageRefused) continue; throw error; }
    if (url.length > 2_000 || grant.references.has(url) || grant.referenceChars + url.length > 64_000) continue;
    grant.references.set(url, Object.freeze({ ...provenance }));
    grant.referenceChars += url.length;
  }
}

/** Only bytes from a currently authorized public response can add exact references. */
export function admitPublicPageReferences(scope: ReadScope, source: string, urls: readonly string[]): void {
  const allowed = externalReadAllowed(scope, 'fetch_page', { url: source });
  if (!allowed.ok) throw new PageRefused(allowed.reason);
  const grant = matchingReadGrant(scope)!;
  addReferences(grant, urls, { kind: 'public-page', source: checkPageUrl(source).toString() });
}

/** Host-only binding recorded by Runtime; it never revives an expired grant. */
export function readGrantRecord(scope: ReadScope, runId?: string) {
  let grant = matchingReadGrant(scope);
  if (grant && runId) {
    if (grant.runId && grant.runId !== runId) grant = undefined;
    else grant.runId = runId;
  }
  return {
    grant: scope.grant ?? null,
    authority: grant ? readGrantScopeDigest(scope) : null,
    run: grant?.runId ?? null,
    references: grant ? [...grant.references].map(([url, provenance]) => ({ url, ...provenance })) : [],
  };
}

/** Runtime dispatch and result checks resolve the live host binding, never recorded flags alone. */
export function recordedExternalReadAllowed(projectId: string, record: unknown, name: string, input: unknown, runId: string, route: unknown): ExternalReadCheck {
  const read = record && typeof record === 'object' && !Array.isArray(record) ? record as Record<string, unknown> : {};
  if (typeof read.grant !== 'string' || typeof read.authority !== 'string' || !readGrantLive(read.grant))
    return { ok: false, reason: EXTERNAL_READ_ENDED };
  const grant = grants.get(read.grant)!;
  const scope = grant.scopes.get(read.authority);
  if (grant.projectId !== projectId || !scope || !grant.runId || grant.runId !== runId || read.run !== runId ||
      (scope.route !== undefined && scope.route !== route) || read.digest !== readScopeDigest(scope) || read.web !== scope.web ||
      !same(read.connectors, (scope.mcp ?? []).map(server => ({ name: server.name, readTools: [...server.readTools] }))))
    return { ok: false, reason: EXTERNAL_READ_ENDED };
  return externalReadAllowed({ ...scope, grant: read.grant }, name, input);
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
  /** Current host-accepted human message only, never model text or private sources/history. */
  readonly text?: string;
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
  // Capture every caller-owned value before the first await. The provisional
  // grant is already revocable while the filesystem is being checked.
  const requested = snapshotReadScope({
    projectId: input.projectId,
    route: input.route,
    root: input.root,
    web: input.web ?? true,
    ...(input.mcp ? { mcp: input.mcp } : {}),
    access,
    shared: Object.freeze([...new Set(input.shared ?? [])]),
  });
  const documents = input.documents.map(document => ({ path: document.path }));
  const text = input.text;
  const grant = openReadGrant(input.projectId, input.grantMs);
  try {
    if (!readGrantLive(grant))
      throw new ApiError(409, 'Read access changed while preparing this message. Send it again.');
    grants.get(grant)!.preparing = requested;
    if (connectorChangePending(requested))
      throw new ApiError(409, 'Read connector approval is changing. Send this message again after it finishes.');
    const root = await safeAbsolute(requested.root);
    const realRoot = await fs.realpath(root);
    const files: string[] = [];
    for (const document of documents) {
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
    const scope = snapshotReadScope({ ...requested, root, files, grant });
    if (!bindReadGrant(grant, { scope, text }))
      throw new ApiError(409, 'Read access changed while preparing this message. Send it again.');
    return scope;
  } catch (error) {
    closeReadGrant(grant);
    throw error;
  }
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
