/**
 * The read-only tool boundary for Ask and Plan (owner decision 2026-09-23).
 *
 * A request that carries a `ReadScope` may search the web and call the read
 * tools of MCP servers the owner has approved. Which project files it may read is
 * the turn's own choice (security pass 2026-09-23): `selected`, the default, is
 * exactly the documents sent inline and gives the engine no file tool at all;
 * `project` is the person's explicit per-turn choice to allow the whole folder,
 * offered only where the host answers each read before it runs
 * (`server/engines/turn-scope.ts`). Nothing
 * here can write: file changes stay on the guarded proposal and exact-approval
 * path (Build/Fix), and shell commands, edits and arbitrary network posts stay
 * refused. The host sets the scope from its own project record for an Ask or
 * Plan turn only; a client, a model or a saved preference never supplies it.
 * A request without a scope is the text-only route it always was.
 *
 * Each adapter maps the scope onto its tool's own vocabulary and keeps a second,
 * adapter-side check: a tool it did not allow, or a path outside `root`, stops
 * the request. That check observes what the tool reports, so it cannot stop the
 * one call it sees. It is narration and a tripwire, never the boundary: the
 * boundary is a tool the engine was never given, or a host answer given before
 * the call runs.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { RawToolActivity } from '../../shared/adapter-contract.js';
import type { ReadAccess } from '../../shared/read-access.js';

/** One MCP server the owner approved, with the only tools a read turn may call. */
export interface ApprovedMcpServer {
  /** Short identifier, also the server's name inside each engine's MCP config. */
  readonly name: string;
  /** A local stdio server: the executable and its arguments. */
  readonly command: string;
  readonly args: readonly string[];
  /**
   * Names of host environment variables forwarded to the server (for example
   * the POS token). Values are never written into Diomedes configuration.
   */
  readonly envFrom: readonly string[];
  /** Exact tool names the owner declared read-only. No wildcard is accepted. */
  readonly readTools: readonly string[];
}

export interface ReadScope {
  /** The project folder, already resolved through `safeAbsolute` by the host. */
  readonly root: string;
  /** Whether web search and page fetches are allowed. */
  readonly web: boolean;
  /** Approved MCP servers and their read tools. Empty or absent means none. */
  readonly mcp?: readonly ApprovedMcpServer[];
  /**
   * The turn's own read choice. Absent reads as `selected`: a scope that does not
   * say otherwise never reaches past the documents sent with the message.
   */
  readonly access?: ReadAccess;
  /**
   * The allowed source set of a `selected` turn: the chosen documents' resolved
   * absolute paths. Host-run tools check it through `readAllowed`.
   */
  readonly files?: readonly string[];
  /**
   * The project documents Cloud sharing lets this route receive, as project-relative
   * names, when the turn was built. A whole-project turn may read only these; the
   * grant is revoked when the sharing policy changes.
   */
  readonly shared?: readonly string[];
  /**
   * The host grant this turn's reads are answered under (`openReadGrant`). A
   * whole-project read needs a live one; revoking it ends the turn's reads.
   */
  readonly grant?: string;
}

export type { ReadAccess };

/** The access a scope actually carries: anything but an explicit `project` is `selected`. */
export const readAccessOf = (scope: ReadScope | undefined): ReadAccess =>
  scope?.access === 'project' ? 'project' : 'selected';

const NAME = /^[a-z][a-z0-9_-]{0,31}$/;
const TOOL = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const ENV = /^[A-Z][A-Z0-9_]{0,63}$/;
/** Variables that would reroute a server's provider, loader or proxy are never forwarded. */
const FORBIDDEN_ENV =
  /^(PATH|PATHEXT|NODE_OPTIONS|NODE_PATH|LD_PRELOAD|DYLD_.*|HTTPS?_PROXY|ALL_PROXY|NO_PROXY|OPENAI_.*|ANTHROPIC_.*|CODEX_.*|CLAUDE_.*|DIOMEDES_.*)$/;

const serverSchema = z.strictObject({
  name: z.string().regex(NAME),
  /** Explicit owner approval. An entry without it is ignored, never half-loaded. */
  approved: z.literal(true),
  transport: z.literal('stdio'),
  command: z.string().min(1).max(1000),
  args: z.array(z.string().max(1000)).max(32).default([]),
  envFrom: z
    .array(z.string().regex(ENV).refine((name) => !FORBIDDEN_ENV.test(name)))
    .max(16)
    .default([]),
  readTools: z.array(z.string().regex(TOOL)).min(1).max(64),
  note: z.string().max(500).optional(),
});
export const approvedReadServersSchema = z.strictObject({
  version: z.literal(1),
  servers: z.array(z.unknown()).max(16),
});

/**
 * The owner's approved read connectors, from one file the host owns
 * (`<data>/read-connectors.json`). A missing file means none. A malformed file
 * is refused whole; an entry that is not explicitly approved, or that repeats a
 * name, is skipped. Nothing is inferred from an engine's own MCP configuration.
 */
export function loadApprovedReadServers(file: string): ApprovedMcpServer[] {
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const parsed = approvedReadServersSchema.safeParse(JSON.parse(raw));
  if (!parsed.success) throw new Error('The approved read connectors file is malformed.');
  const seen = new Set<string>();
  const servers: ApprovedMcpServer[] = [];
  for (const entry of parsed.data.servers) {
    const server = serverSchema.safeParse(entry);
    if (!server.success || seen.has(server.data.name)) continue;
    seen.add(server.data.name);
    servers.push(
      Object.freeze({
        name: server.data.name,
        command: server.data.command,
        args: Object.freeze([...server.data.args]),
        envFrom: Object.freeze([...new Set(server.data.envFrom)]),
        readTools: Object.freeze([...new Set(server.data.readTools)]),
      }),
    );
  }
  return servers;
}

/** The forwarded environment for one server: only the named variables that are set. */
export function serverEnvironment(
  server: ApprovedMcpServer,
  source: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  return Object.fromEntries(
    server.envFrom.flatMap((name) => {
      const value = source[name];
      return typeof value === 'string' && value ? [[name, value]] : [];
    }),
  );
}

/**
 * A stable identity for a scope: the process a scope was started with serves only it.
 * The access choice is part of it, so a process or native session opened for selected
 * documents never serves a whole-project turn, nor the reverse. The per-turn file set
 * and grant are not: a selected-only process has no file tool for them to change, and a
 * whole-project process asks the host about every read under the current turn's grant.
 */
export function readScopeDigest(scope: ReadScope | undefined): string {
  if (!scope) return 'text-only';
  return createHash('sha256')
    .update(
      JSON.stringify({
        root: path.resolve(scope.root),
        web: scope.web,
        access: readAccessOf(scope),
        mcp: (scope.mcp ?? []).map((server) => [
          server.name,
          server.command,
          server.args,
          server.envFrom,
          [...server.readTools].sort(),
        ]),
      }),
    )
    .digest('hex');
}

const fold = (value: string) => (process.platform === 'win32' ? value.toLowerCase() : value);

/**
 * Whether `candidate` names the root or something inside it. A relative path is
 * read against `base` (the tool's own working directory, default the root). A
 * URL, a device path or a path that climbs out is outside.
 */
export function insideRoot(root: string, candidate: string, base = root): boolean {
  if (typeof candidate !== 'string' || !candidate || candidate.includes('\0')) return false;
  if (/^[a-z][a-z0-9+.-]+:\/\//i.test(candidate)) return false;
  if (/^\\\\[?.]\\/.test(candidate)) return false;
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(base, candidate);
  const relative = path.relative(fold(resolvedRoot), fold(resolved));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

/** A display path for one line of activity: relative to the root when it is inside. */
export function displayPath(root: string, candidate: string): string {
  if (!insideRoot(root, candidate)) return candidate;
  const relative = path.relative(path.resolve(root), path.resolve(root, candidate));
  return relative ? relative.split(path.sep).join('/') : 'the project folder';
}

export const isWebUrl = (value: unknown): value is string =>
  typeof value === 'string' && /^https?:\/\/[^\s]+$/i.test(value);

/** The kinds of read a scope allows; each engine maps its tool names onto these. */
export type ReadKind = 'read' | 'list' | 'search' | 'web-search' | 'web-fetch' | 'mcp';

const clip = (value: string, max = 120) =>
  value.length > max ? `${value.slice(0, max - 1)}…` : value;

/** The plain sentence a person reads for one read tool call. */
export function readSummary(
  kind: ReadKind,
  facts: { path?: string; query?: string; url?: string; server?: string; tool?: string },
): string {
  switch (kind) {
    case 'read':
      return facts.path ? `Reading ${clip(facts.path)}` : 'Reading a project file';
    case 'list':
      return facts.path ? `Listing files in ${clip(facts.path)}` : 'Listing project files';
    case 'search':
      return facts.query
        ? `Searching project files for ${clip(facts.query)}`
        : 'Searching project files';
    case 'web-search':
      return facts.query ? `Searching the web for ${clip(facts.query)}` : 'Searching the web';
    case 'web-fetch':
      return facts.url ? `Opening ${clip(facts.url)}` : 'Opening a web page';
    case 'mcp':
      return `Reading from ${facts.server ?? 'a connector'}${facts.tool ? ` (${facts.tool})` : ''}`;
  }
}

/**
 * A short technical line for "All details": the arguments, never an
 * environment, a header or a token. The activity sink redacts again.
 */
export function readDetail(value: unknown, max = 600): string | undefined {
  if (value === undefined || value === null) return undefined;
  let text: string;
  try {
    text = typeof value === 'string' ? value : JSON.stringify(value);
  } catch {
    return undefined;
  }
  text = text
    .replace(/(?:Bearer\s+|sk-|ghp_|xox[abp]-)[\w.-]+/gi, '[redacted]')
    .replace(/("?(?:token|password|secret|api[_-]?key|authorization)"?\s*[:=]\s*)"[^"]*"/gi, '$1"[redacted]"');
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** Emit one activity line; a failing sink never fails the read. */
export function emitActivity(
  sink: ((raw: RawToolActivity) => void) | undefined,
  raw: RawToolActivity,
): void {
  if (!sink) return;
  try {
    sink(raw);
  } catch {
    /* Activity is narration; the durable record is the authority. */
  }
}

/** The approved server and tool an engine-qualified MCP tool name refers to, if any. */
export function approvedMcpTool(
  scope: ReadScope,
  server: string,
  tool: string,
): ApprovedMcpServer | undefined {
  const found = (scope.mcp ?? []).find((entry) => entry.name === server);
  return found && found.readTools.includes(tool) ? found : undefined;
}

/**
 * Instructions appended for a read turn. It does not vary with the chosen files, so a
 * native session's fixed system prompt stays true for every turn it serves.
 */
export function readScopeNote(scope: ReadScope): string {
  const parts = [
    readAccessOf(scope) === 'project'
      ? `For this message you may read any file inside the project folder ${scope.root} using read-only tools. Use absolute paths inside that folder; each read is checked before it runs.`
      : 'You have no file tools: the documents the person chose are included in the message, and no other project file can be read. If the answer needs another file, say which one so the person can include it.',
    scope.web ? 'You may search the web and open web pages.' : 'Web access is unavailable.',
    scope.mcp?.length
      ? `You may use the read tools of these approved connectors: ${scope.mcp.map((server) => server.name).join(', ')}.`
      : '',
    'You cannot change, create or delete files, run commands, or send anything. To change a file, describe the change so it can be proposed for approval.',
  ];
  return parts.filter(Boolean).join(' ');
}
