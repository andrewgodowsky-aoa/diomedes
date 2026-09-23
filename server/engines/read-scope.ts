/**
 * The read-only tool boundary for Ask and Plan (owner decision 2026-09-23).
 *
 * A request that carries a `ReadScope` may search the web, read the project's
 * files and call the read tools of MCP servers the owner has approved. Nothing
 * here can write: file changes stay on the guarded proposal and exact-approval
 * path (Build/Fix), and shell commands, edits and arbitrary network posts stay
 * refused. The host sets the scope from its own project record for an Ask or
 * Plan turn only; a client, a model or a saved preference never supplies it.
 * A request without a scope is the text-only route it always was.
 *
 * Each adapter maps the scope onto its tool's own vocabulary and keeps a second,
 * adapter-side check: a tool it did not allow, or a path outside `root`, stops
 * the request. That check observes what the tool reports, so it cannot stop the
 * one call it sees; the tool's own allow-list is what prevents the call.
 *
 * A model-API route (AWS Bedrock, Azure OpenAI, OpenRouter) has no tool of its
 * own: the host executes every read itself (`server/harness/capabilities/
 * read-scope-tools.ts`), so there the check happens before the read, not after.
 * Those routes offer no web search (QUESTIONS.md R8: search stays on the
 * subscription engines), only a guarded page fetch, so they write their own
 * note instead of `readScopeNote`.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { RawToolActivity } from '../../shared/adapter-contract.js';
import { CONNECTOR_DATA_KINDS } from '../../shared/read-connectors.js';

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
}

const NAME = /^[a-z][a-z0-9_-]{0,31}$/;
const TOOL = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const ENV = /^[A-Z][A-Z0-9_]{0,63}$/;
/** Variables that would reroute a server's provider, loader or proxy are never forwarded. */
const FORBIDDEN_ENV =
  /^(PATH|PATHEXT|NODE_OPTIONS|NODE_PATH|LD_PRELOAD|DYLD_.*|HTTPS?_PROXY|ALL_PROXY|NO_PROXY|OPENAI_.*|ANTHROPIC_.*|CODEX_.*|CLAUDE_.*|DIOMEDES_.*)$/;

/**
 * One approved connector entry in `read-connectors.json`. Exported so the
 * routes that add, change and remove entries validate with exactly these
 * rules; the messages are what the owner reads when an entry is refused.
 */
export const approvedReadServerSchema = z.strictObject({
  name: z.string().regex(NAME, 'Name the connector with lowercase letters, digits, - or _, starting with a letter (up to 32).'),
  /** Explicit owner approval. An entry without it is ignored, never half-loaded. */
  approved: z.literal(true),
  transport: z.literal('stdio'),
  command: z.string().min(1, 'Enter the command that starts the connector.').max(1000),
  args: z.array(z.string().max(1000)).max(32, 'Use at most 32 arguments.').default([]),
  envFrom: z
    .array(
      z
        .string()
        .regex(ENV, 'Environment variable names are capital letters, digits and _, starting with a letter.')
        .refine((name) => !FORBIDDEN_ENV.test(name), {
          error: (issue) => `${String(issue.input)} cannot be forwarded: it would change how the connector or its host runs.`,
        }),
    )
    .max(16, 'Forward at most 16 environment variables.')
    .default([]),
  readTools: z
    .array(z.string().regex(TOOL, 'Name each read tool exactly, with no spaces or wildcards.'))
    .min(1, 'List at least one read tool.')
    .max(64, 'List at most 64 read tools.'),
  /**
   * The kinds of business data it reads, in the Small Business pack's words
   * (`shared/read-connectors.ts`). Descriptive only: it grants nothing and no
   * read turn consults it.
   */
  provides: z.array(z.enum(CONNECTOR_DATA_KINDS)).max(CONNECTOR_DATA_KINDS.length).optional(),
  note: z.string().max(500).optional(),
});
/** Where the approved connectors live, under the host's data folder. */
export const READ_CONNECTORS_FILE = 'read-connectors.json';
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
    const server = approvedReadServerSchema.safeParse(entry);
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

/** A stable identity for a scope: the process a scope was started with serves only it. */
export function readScopeDigest(scope: ReadScope | undefined): string {
  if (!scope) return 'text-only';
  return createHash('sha256')
    .update(
      JSON.stringify({
        root: path.resolve(scope.root),
        web: scope.web,
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

/** Instructions appended for a read turn, so the model knows where the project is. */
export function readScopeNote(scope: ReadScope): string {
  const parts = [
    `You may read files inside the project folder ${scope.root} using read-only tools.`,
    scope.web ? 'You may search the web and open web pages.' : 'Web access is unavailable.',
    scope.mcp?.length
      ? `You may use the read tools of these approved connectors: ${scope.mcp.map((server) => server.name).join(', ')}.`
      : '',
    'You cannot change, create or delete files, run commands, or send anything. To change a file, describe the change so it can be proposed for approval.',
  ];
  return parts.filter(Boolean).join(' ');
}
