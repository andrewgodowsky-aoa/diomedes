import { randomBytes } from 'node:crypto';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import fs from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import type { EngineModel } from '../../shared/types.js';
import type { SetupStage } from '../../shared/engines.js';
import { routeContractFor } from '../harness/route-contract.js';
import {
  contextMessage,
  type AdapterInspection,
  type PersistentTextAdapter,
  type TextRequest,
  type TextResponse,
} from './contract.js';
import {
  openOpenCodeSession,
  type OpenCodeNativeSession,
  type OpenCodeSessionCheckpoint,
  type OpenCodeSessionOptions,
  type OpenCodeTransport,
} from './opencode-session.js';
import {
  abortedByDeadline,
  abortFailure,
  atStage,
  cleanupFailed,
  engineEnvironment,
  EngineError,
  failureKind,
  launchCommand,
  text,
} from './process.js';
import { SseLimitError, SseParser, type SseEvent } from './sse.js';
import { killOwnedProcess } from '../integrations.js';
import {
  approvedMcpTool,
  emitActivity,
  isWebUrl,
  readAccessOf,
  readDetail,
  readScopeNote,
  readSummary,
  serverEnvironment,
  type ReadKind,
  type ReadScope,
} from './read-scope.js';

export const OPENCODE_VERSION = '1.18.4';
export const OPENCODE_ACCOUNT_ROUTE = 'opencode:opencode-go';
const MAX_JSON_BYTES = 512 * 1024;
const MAX_EVENT_BYTES = 4 * 1024 * 1024;
// One event, before the blank line that ends it. The whole-stream budget above
// still applies; this is the tighter bound, so a single hostile event is
// refused long before four megabytes of legitimate stream would be.
const MAX_SSE_EVENT_BYTES = 1024 * 1024;
// A cold `opencode serve` answers in about two seconds here, but the setup
// screen checks four engines at once and a first start on a slow disk or a
// busy machine has been seen past fifteen; the budget is generous because the
// sentence that follows a miss names the wait and asks for a recheck.
const STARTUP_TIMEOUT_MS = 45_000;
const REQUEST_TIMEOUT_MS = 120_000;
// One readiness probe. Measured 2026-09-23 on Windows with opencode 1.18.4:
// about one launch in four, the first /provider request never reached a server
// that was already listening, and it held the whole startup budget. A fresh
// connection answered in under half a second. Each probe now has its own
// short bound inside the startup deadline; a slow first instance keeps
// building server-side between probes, so a later one finds it ready.
const HANDSHAKE_ATTEMPT_MS = 5_000;
// The models.dev catalogue a person's own OpenCode keeps refreshed. Bounded:
// the file is about 5 MB today.
const MAX_CATALOGUE_BYTES = 32 * 1024 * 1024;

type Json = Record<string, unknown>;
type Fetcher = typeof globalThis.fetch;
/** The server a kept session runs on: the handle `start` returns. */
type OpenCodeServerHandle = {
  child: ChildProcessWithoutNullStreams;
  base: string;
  auth: string;
  env: NodeJS.ProcessEnv;
  root: string;
  directory: string;
};
type SpawnOptions = Parameters<typeof spawn>[2];
export interface OpenCodeAdapterDeps {
  fetch?: Fetcher;
  spawn?: (file: string, args: string[], options: SpawnOptions) => ChildProcessWithoutNullStreams;
  reservePort?: () => Promise<number>;
  startupTimeoutMs?: number;
  requestTimeoutMs?: number;
  handshakeAttemptMs?: number;
}

/**
 * Where the person's own OpenCode keeps its models.dev catalogue: the same
 * `<XDG_CACHE_HOME or ~/.cache>/opencode/models.json` opencode v1.18.4 reads
 * and refreshes (ModelsDev.populate reads that file first, then the catalogue
 * bundled in the binary). It is the public model catalogue, not account data.
 */
export function nativeCatalogueFile(source: NodeJS.ProcessEnv = process.env): string {
  const home = source.USERPROFILE ?? source.HOME ?? process.cwd();
  return path.join(source.XDG_CACHE_HOME || path.join(home, '.cache'), 'opencode', 'models.json');
}

/**
 * Give the isolated server the catalogue the person's own OpenCode last
 * refreshed. Without it the server starts from an empty cache and answers from
 * the catalogue bundled in the binary unless its own background fetch lands
 * first, so a check and the dispatch after it could list different models
 * (live, 2026-09-23: MiMo 2.6 on some checks and not others). A copy, never a
 * link: the server may rewrite or delete its cache file, and that must never
 * reach the person's own. Anything unusual leaves the old behaviour in place.
 */
async function seedCatalogue(
  cache: string,
  source: NodeJS.ProcessEnv,
  binary: string,
): Promise<void> {
  const to = path.join(cache, 'opencode', 'models.json');
  try {
    const from = nativeCatalogueFile(source);
    // lstat: a link is not followed; only a plain file is copied.
    const stat = await fs.lstat(from);
    if (!stat.isFile() || stat.size === 0 || stat.size > MAX_CATALOGUE_BYTES) return;
    // A catalogue last refreshed before this OpenCode was built is probably
    // older than the one bundled inside it, and OpenCode reads the cache file
    // first, so seeding it would hide newer models. Leave the bundled one.
    const built = await fs.stat(binary).catch(() => undefined);
    if (built && built.mtimeMs > stat.mtimeMs) return;
    await fs.mkdir(path.dirname(to), { recursive: true });
    await fs.copyFile(from, to);
    // The bound is checked before the copy; hold it for a file that grew meanwhile.
    if ((await fs.stat(to)).size > MAX_CATALOGUE_BYTES) await fs.rm(to, { force: true });
  } catch {
    /* No refreshed catalogue: OpenCode falls back to its own, as before. */
    await fs.rm(to, { force: true }).catch(() => {});
  }
}

const object = (value: unknown): Json =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : {};

async function cappedText(response: Response, limit: number, stage: SetupStage): Promise<string> {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > limit)
        throw new EngineError('OUTPUT_LIMIT', 'OpenCode returned too much data.', true, stage);
      chunks.push(part.value);
    }
  } finally {
    await reader.cancel().catch(() => {
      /* The body is already bounded and no longer needed. */
    });
  }
  const merged = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(merged);
}

/** OpenCode 1.18.4's read tools (its `hF` built-in list plus `list`); nothing that edits or runs. */
export const OPENCODE_READ_TOOLS = ['read', 'glob', 'grep', 'list'] as const;
export const OPENCODE_WEB_TOOLS = ['webfetch', 'websearch'] as const;
/** Tool steps a read turn may take before OpenCode itself stops the agent. */
export const OPENCODE_READ_STEPS = 16;
/** OpenCode names an MCP tool `<server>_<tool>`. */
const mcpToolName = (server: string, tool: string) => `${server}_${tool}`;
/**
 * Every tool a scope allows, in OpenCode's vocabulary: web and the approved MCP read tools.
 * No file tool (security pass 2026-09-23): OpenCode's read permission is not checked by
 * Diomedes before a read runs, so the documents the person chose travel inline instead,
 * and a whole-project turn is refused on this route.
 */
export function opencodeAllowedTools(scope: ReadScope): string[] {
  return [
    ...(scope.web ? OPENCODE_WEB_TOOLS : []),
    ...(scope.mcp ?? []).flatMap((server) =>
      server.readTools.map((tool) => mcpToolName(server.name, tool)),
    ),
  ];
}
/**
 * The whole configuration, passed inline. Without a scope it is the text-only
 * route: every tool off and denied, one step. With one, the web tools and the
 * owner's approved MCP read tools are the only ones on and allowed; file reads,
 * edit, bash, task and everything else stay off and denied, and a turn may take
 * a bounded number of steps.
 */
export function configContent(scope?: ReadScope): string {
  const allowed = scope ? opencodeAllowedTools(scope) : [];
  const on = Object.fromEntries(allowed.map((tool) => [tool, true]));
  const allow = Object.fromEntries(allowed.map((tool) => [tool, 'allow']));
  return JSON.stringify({
    plugin: [],
    instructions: [],
    mcp: Object.fromEntries(
      (scope?.mcp ?? []).map((server) => [
        server.name,
        {
          type: 'local',
          command: [server.command, ...server.args],
          // `{env:NAME}` is resolved by OpenCode from its own environment.
          environment: Object.fromEntries(server.envFrom.map((name) => [name, `{env:${name}}`])),
          enabled: true,
        },
      ]),
    ),
    provider: {},
    enabled_providers: ['opencode-go'],
    tools: { '*': false, ...on },
    snapshot: false,
    share: 'disabled',
    autoupdate: false,
    compaction: { auto: false, prune: false },
    permission: { '*': 'deny', ...allow },
    agent: {
      diomedes: {
        mode: 'primary',
        description: scope ? 'Read-only Diomedes route.' : 'Text-only Diomedes route.',
        steps: scope ? OPENCODE_READ_STEPS : 1,
        tools: { '*': false, ...on },
        permission: {
          edit: 'deny',
          bash: 'deny',
          webfetch: scope?.web ? 'allow' : 'deny',
          doom_loop: 'deny',
          external_directory: 'deny',
          ...(scope ? { ...allow, task: 'deny', todowrite: 'deny', skill: 'deny', lsp: 'deny' } : {}),
        },
      },
    },
    experimental: { continue_loop_on_deny: false, batch_tool: false },
  });
}
const stringField = (value: Json, ...keys: string[]) => {
  for (const key of keys) if (typeof value[key] === 'string' && value[key]) return value[key] as string;
  return undefined;
};
/**
 * One OpenCode tool part against a read scope: the activity to show, or a
 * refusal. A file tool, a tool outside the allow-list, a web call without web
 * access or an unapproved MCP tool stops the request.
 */
export function opencodeToolCall(
  scope: ReadScope,
  tool: string,
  raw: unknown,
): { kind: ReadKind; summary: string; detail?: string } {
  const input = object(raw);
  const refuse = () =>
    new EngineError(
      'POLICY_MISMATCH',
      'OpenCode went beyond the read-only boundary; the request was stopped.',
      true,
      'stream',
    );
  // No read turn is given a file tool; one reported anyway is beyond the boundary.
  if ((OPENCODE_READ_TOOLS as readonly string[]).includes(tool)) throw refuse();
  const detail = readDetail(input);
  switch (tool) {
    case 'websearch':
      if (!scope.web) throw refuse();
      return { kind: 'web-search', summary: readSummary('web-search', { query: stringField(input, 'query') }), detail };
    case 'webfetch': {
      const url = stringField(input, 'url');
      if (!scope.web || !isWebUrl(url)) throw refuse();
      return { kind: 'web-fetch', summary: readSummary('web-fetch', { url }), detail };
    }
  }
  for (const server of scope.mcp ?? [])
    if (tool.startsWith(`${server.name}_`)) {
      const name = tool.slice(server.name.length + 1);
      if (approvedMcpTool(scope, server.name, name))
        return { kind: 'mcp', summary: readSummary('mcp', { server: server.name, tool: name }), detail };
    }
  throw refuse();
}

async function ephemeralPort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (!address || typeof address === 'string')
    throw new EngineError(
      'START_FAILED',
      'OpenCode did not provide a loopback port.',
      false,
      'launch',
    );
  return address.port;
}

/** This adapter's own budget expiring, told apart from any reason the caller carries. */
const OWN_BUDGET = 'timeout';
/**
 * The caller's reason is forwarded rather than flattened to one word, because
 * an external abort says which of two different things happened: a deadline the
 * host imposed, or a person pressing stop. `abortError` below reads it.
 */
function deadline(
  signal: AbortSignal | undefined,
  timeout: number,
): { signal: AbortSignal; dispose: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(OWN_BUDGET), timeout);
  const onAbort = () => controller.abort(signal?.reason);
  signal?.addEventListener('abort', onAbort, { once: true });
  if (signal?.aborted) controller.abort(signal.reason);
  return {
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    },
  };
}

/** The sentence for a time limit this adapter did not set itself. */
const REQUEST_TIMEOUT_DETAIL =
  'OpenCode did not finish within the time limit. Recheck before starting another request.';
function abortError(
  signal: AbortSignal,
  timeoutMs: number,
  budget: 'startup' | 'request',
  stage: SetupStage,
): EngineError {
  // A deadline the caller imposed is a timeout, not the person stopping the
  // request, and it does not name this adapter's own startup budget either:
  // that budget is still running and its number would be a false one.
  if (abortedByDeadline(signal.reason))
    return new EngineError('TIMEOUT', REQUEST_TIMEOUT_DETAIL, true, stage);
  // Anything else that is not this adapter's own budget came from outside: the
  // person stopping it, or the host withdrawing the run. The shared reader tells
  // those apart, so this route gives the same answer as the other four.
  if (signal.reason !== OWN_BUDGET)
    return atStage(abortFailure(signal.reason, REQUEST_TIMEOUT_DETAIL), stage);
  return budget === 'startup'
    ? new EngineError(
        'TIMEOUT',
        `OpenCode did not start within ${Math.round(timeoutMs / 1000)} seconds. Recheck the engine in Settings before starting another request.`,
        true,
        stage,
      )
    : new EngineError('TIMEOUT', REQUEST_TIMEOUT_DETAIL, true, stage);
}

/**
 * Diomedes generates the password for the server it starts and hands it over
 * itself: that server refusing it is a local fault, it proves nothing about the
 * person's account, and telling them to sign in again would send them to repair
 * something that is not broken. A denial that came back from the account
 * arrives over the stream instead, and `streamFailure` reads it.
 */
function errorForResponse(status: number, body: string, stage: SetupStage): EngineError {
  // Every 401 this server sends is its own Basic check on the password Diomedes
  // generated and handed it: the authorization middleware is the only producer
  // of one and has no 403 path at all (opencode v1.18.4,
  // packages/opencode/src/server/routes/instance/httpapi/middleware/
  // authorization.ts:13, 47-52). A refusal by the account never arrives as an
  // HTTP status here; it arrives as a session or assistant error on the stream.
  // So this is a local fault wherever it is seen, and it proves nothing about
  // the person's sign-in.
  if (status === 401 || status === 403)
    return new EngineError(
      'HANDSHAKE_FAILED',
      'Diomedes could not authenticate to the OpenCode server it started. No account was reached, so nothing here is known about its sign-in.',
      false,
      'local-handshake',
    );
  // The body is read to classify and never quoted: it is whatever the tool
  // chose to send, and a response body can carry account detail.
  if (failureKind(parsedBody(body), status) === 'limited')
    return new EngineError(
      'USAGE_LIMIT',
      'OpenCode reported a service limit. No provider or model was substituted.',
      true,
      stage,
    );
  return new EngineError(
    'PROVIDER_ERROR',
    'OpenCode could not complete this request. No automatic retry was sent.',
    true,
    stage,
  );
}
/** A body read as its parsed fields where it is JSON, and as plain text where it is not. */
function parsedBody(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    return body.slice(0, 4096);
  }
}

/**
 * A refusal that arrived over the stream is the only way a refusal by the
 * account reaches this adapter, and OpenCode says which one it is rather than
 * leaving it to be guessed: assistant and session errors are a union
 * discriminated on `name`, each carrying its own fields under `data` (opencode
 * v1.18.4, packages/schema/src/v1/session.ts:29-63, 385-394). The name decides.
 *
 * `responseBody`, `responseHeaders` and `metadata` are never read into a
 * sentence, a diagnostic or a support bundle. They are whatever the upstream
 * service sent back, and that can include account detail.
 */
function streamFailure(value: unknown, fallback: string): EngineError {
  const error = object(value);
  const name = text(error.name);
  const data = object(error.data);
  const status = typeof data.statusCode === 'number' ? data.statusCode : undefined;
  if (name === 'ProviderAuthError' || (name === 'APIError' && (status === 401 || status === 403)))
    return new EngineError(
      'AUTH_REQUIRED',
      'OpenCode Go refused this request for the connected account. Check that account in OpenCode, then recheck.',
      true,
      'provider-auth',
    );
  if (name === 'APIError' && status === 429)
    return new EngineError(
      'USAGE_LIMIT',
      'OpenCode reported a service limit. No provider or model was substituted.',
      true,
      'stream',
    );
  if (name === 'ContextOverflowError')
    return new EngineError(
      'OUTPUT_LIMIT',
      'This request was longer than the selected OpenCode Go model accepts. Shorten it before sending again.',
      true,
      'stream',
    );
  if (name === 'MessageOutputLengthError')
    return new EngineError(
      'OUTPUT_LIMIT',
      'OpenCode Go stopped at its own response length limit.',
      true,
      'stream',
    );
  if (name === 'ContentFilterError')
    return new EngineError(
      'POLICY_MISMATCH',
      'OpenCode Go stopped this request on its own content policy. Nothing was retried.',
      true,
      'stream',
    );
  if (name === 'MessageAbortedError')
    return new EngineError(
      'PROVIDER_ERROR',
      'OpenCode Go stopped this message before it finished. No automatic retry was sent.',
      true,
      'stream',
    );
  if (name === 'StructuredOutputError')
    return new EngineError(
      'PROTOCOL_ERROR',
      'OpenCode Go could not produce a usable response.',
      true,
      'stream',
    );
  // `UnknownError` is the tool saying it does not know either, and its message
  // is the only thing left to read. Whole words that actually denote a refusal
  // or a limit, and nothing shorter; an unrecognised name reads the same way.
  const kind = failureKind({ message: text(data.message) });
  if (kind === 'denied')
    return new EngineError(
      'AUTH_REQUIRED',
      'OpenCode Go refused this request for the connected account. Check that account in OpenCode, then recheck.',
      true,
      'provider-auth',
    );
  if (kind === 'limited')
    return new EngineError(
      'USAGE_LIMIT',
      'OpenCode reported a service limit. No provider or model was substituted.',
      true,
      'stream',
    );
  return new EngineError('PROVIDER_ERROR', fallback, true, 'stream');
}

function modelFrom(value: unknown, providerId: string): EngineModel | undefined {
  const item = object(value);
  const id = text(item.id) || text(item.modelID);
  if (!id || !/^[a-zA-Z0-9._:/-]{1,160}$/.test(id)) return undefined;
  return {
    slug: `${providerId}/${id}`,
    name: text(item.name) || id,
    description: text(item.description).slice(0, 240),
    efforts: [],
    defaultEffort: null,
  };
}

/**
 * A provider identifier is short and plain. This bounds shape and length only:
 * `acme-holdings-inc` and a 64-character opaque value both satisfy it, so shape
 * alone is not what decides that an identifier may be recorded. What decides it
 * is `reported` below — the intersection with the catalogue the same response
 * published — and only an identifier the tool itself publishes as a provider
 * can reach a diagnostic, a screen or a support bundle.
 */
const PROVIDER_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/i;
const MAX_REPORTED_PROVIDERS = 16;
/**
 * What an empty `connected` means on this route, said once. Diomedes starts the
 * server with `enabled_providers: ["opencode-go"]`, and opencode v1.18.4 prunes
 * every other provider out of its own state before it answers
 * (packages/opencode/src/provider/provider.ts:1606-1611). So an empty list does
 * not mean "this person has no OpenCode account"; it means no OpenCode Go
 * account is connected here, and a sign-in to OpenCode Zen or to any other
 * provider in the person's own OpenCode is invisible to this route by
 * construction. Say that rather than implying the person never signed in.
 */
const NO_GO_ACCOUNT_DETAIL =
  `This route runs on the native OpenCode Go account (${OPENCODE_ACCOUNT_ROUTE}), and no OpenCode Go account is connected on this computer. ` +
  'A sign-in to OpenCode Zen, or to any other provider inside your own OpenCode, is a different account and is not visible to this route. ' +
  'Sign in to OpenCode Go, then recheck.';

function catalogue(body: Json): {
  connected: boolean;
  /** Every other connected provider the tool named. Counted, never published. */
  others: string[];
  /** The identifiers of those that are safe to record: shape-checked and capped. */
  reported: string[];
  models: EngineModel[];
} {
  const all = Array.isArray(body.all) ? body.all : [];
  const connected = Array.isArray(body.connected)
    ? body.connected.filter((v): v is string => typeof v === 'string')
    : [];
  const providerId = 'opencode-go';
  const others = connected.filter((id) => id !== providerId);
  // Only an id the same response publishes in its own catalogue survives.
  // Shape and length bound an account name or a secret-shaped value no better
  // than they bound a provider id, and `connected` is rendered in the setup
  // sentence and copied into a support bundle the person sends to someone else.
  const published = new Set(
    all
      .map(object)
      .map((item) => text(item.id))
      .filter((id) => PROVIDER_ID.test(id)),
  );
  const reported = others.filter((id) => published.has(id)).slice(0, MAX_REPORTED_PROVIDERS);
  if (!connected.includes(providerId)) return { connected: false, others, reported, models: [] };
  const provider = all.map(object).find((item) => item.id === providerId) ?? {};
  const rawModels = object(provider.models);
  const models = Object.entries(rawModels)
    .slice(0, 80)
    .flatMap(([id, value]) => modelFrom({ ...object(value), id }, providerId) ?? []);
  return { connected: true, others, reported, models };
}

export function parseSelection(value: string): { providerID: string; modelID: string } {
  const slash = value.indexOf('/');
  if (slash <= 0 || slash === value.length - 1)
    throw new EngineError(
      'MODEL_UNAVAILABLE',
      'Choose an explicit OpenCode Go provider/model.',
      true,
      'model-list',
    );
  const providerID = value.slice(0, slash);
  const modelID = value.slice(slash + 1);
  if (providerID !== 'opencode-go')
    throw new EngineError(
      'ACCOUNT_CHANGED',
      'Only the native OpenCode Go account route is allowed.',
      true,
      'provider-auth',
    );
  return { providerID, modelID };
}

/** The session every turn runs in: deny everything, then allow only the reads its scope names. */
export function sessionBody(
  input: TextRequest,
  selection: { providerID: string; modelID: string },
  scope?: ReadScope,
): Json {
  return {
    title: `Diomedes ${input.requestId}`.slice(0, 120),
    agent: 'diomedes',
    model: { providerID: selection.providerID, id: selection.modelID },
    // Last matching rule wins: deny everything, then allow only the reads.
    permission: [
      { permission: '*', pattern: '*', action: 'deny' },
      ...(scope
        ? opencodeAllowedTools(scope).map((tool) => ({
            permission: tool,
            pattern: '*',
            action: 'allow',
          }))
        : []),
      ...(scope ? [{ permission: 'external_directory', pattern: '*', action: 'deny' }] : []),
    ],
  };
}
/** One message into a session, with its instructions and read scope stated each time. */
export function promptBody(
  input: TextRequest,
  selection: { providerID: string; modelID: string },
  scope: ReadScope | undefined,
  prompt: string,
): Json {
  return {
    agent: 'diomedes',
    model: { providerID: selection.providerID, modelID: selection.modelID },
    system: scope ? `${input.instructions}\n\n${readScopeNote(scope)}` : input.instructions,
    parts: [{ type: 'text', text: prompt }],
  };
}

export function opencodeArguments(port: number): string[] {
  return ['serve', '--hostname', '127.0.0.1', '--port', String(port), '--pure'];
}

export class OpenCodeAdapter implements PersistentTextAdapter<OpenCodeSessionCheckpoint> {
  readonly id = 'opencode' as const;
  readonly contract = routeContractFor('opencode');
  /** The kept-session transport, admitted separately from the single-turn route (H04). */
  readonly sessionContract = routeContractFor('opencode-session');
  private readonly fetcher: Fetcher;
  private readonly spawnProcess: NonNullable<OpenCodeAdapterDeps['spawn']>;
  private readonly reserve: NonNullable<OpenCodeAdapterDeps['reservePort']>;
  private readonly startupTimeout: number;
  private readonly requestTimeout: number;
  private readonly handshakeAttempt: number;
  constructor(
    private readonly file: string,
    private readonly cwd: string,
    deps: OpenCodeAdapterDeps = {},
  ) {
    this.fetcher = deps.fetch ?? globalThis.fetch;
    this.spawnProcess =
      deps.spawn ??
      ((command, args, options) => spawn(command, args, options) as ChildProcessWithoutNullStreams);
    this.reserve = deps.reservePort ?? ephemeralPort;
    this.startupTimeout = deps.startupTimeoutMs ?? STARTUP_TIMEOUT_MS;
    this.requestTimeout = deps.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;
    this.handshakeAttempt = deps.handshakeAttemptMs ?? HANDSHAKE_ATTEMPT_MS;
  }

  private async isolatedEnvironment(root: string, scope?: ReadScope): Promise<NodeJS.ProcessEnv> {
    const [config, cache, state, home] = await Promise.all(
      ['config', 'cache', 'state', 'home'].map((name) =>
        fs.mkdtemp(path.join(root, `.opencode-${name}-`)),
      ),
    );
    const source = process.env;
    const nativeHome = source.USERPROFILE ?? source.HOME ?? process.cwd();
    const nativeData = source.XDG_DATA_HOME ?? path.join(nativeHome, '.local', 'share');
    await seedCatalogue(cache, source, this.file);
    return {
      ...engineEnvironment(source),
      HOME: home,
      USERPROFILE: home,
      XDG_CONFIG_HOME: config,
      XDG_CACHE_HOME: cache,
      XDG_STATE_HOME: state,
      XDG_DATA_HOME: nativeData,
      ...Object.assign({}, ...(scope?.mcp ?? []).map((server) => serverEnvironment(server))),
      OPENCODE_CONFIG_CONTENT: configContent(scope),
      OPENCODE_DISABLE_PROJECT_CONFIG: '1',
      OPENCODE_DISABLE_EXTERNAL_SKILLS: '1',
      OPENCODE_PURE: '1',
      OPENCODE_SERVER_USERNAME: 'opencode',
    };
  }

  private async start(
    signal?: AbortSignal,
    scope?: ReadScope,
  ): Promise<{
    child: ChildProcessWithoutNullStreams;
    base: string;
    auth: string;
    env: NodeJS.ProcessEnv;
    root: string;
    directory: string;
  }> {
    if (signal?.aborted)
      throw atStage(abortFailure(signal.reason, REQUEST_TIMEOUT_DETAIL), 'launch');
    const root = await fs.mkdtemp(path.join(this.cwd, '.diomedes-opencode-'));
    let env: NodeJS.ProcessEnv;
    let port: number;
    let command: ReturnType<typeof launchCommand>;
    try {
      env = await this.isolatedEnvironment(root, scope);
      port = await this.reserve();
      command = launchCommand(this.file, opencodeArguments(port));
    } catch (error) {
      await fs.rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 200 });
      throw atStage(error, 'launch');
    }
    const password = randomBytes(32).toString('hex');
    env.OPENCODE_SERVER_PASSWORD = password;
    let child: ChildProcessWithoutNullStreams;
    let launchError: EngineError | undefined;
    try {
      child = this.spawnProcess(command.file, command.args, {
        cwd: this.cwd,
        env,
        shell: false,
        windowsHide: true,
        windowsVerbatimArguments: command.verbatim,
        detached: process.platform !== 'win32',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch {
      await fs.rm(root, { recursive: true, force: true });
      throw new EngineError(
        'LAUNCH_FAILED',
        'OpenCode could not start. Recheck its installation and dependencies.',
        false,
        'launch',
      );
    }
    // Drain logs without retaining credential-bearing diagnostics. Protocol
    // response/stream sizes and process lifetime are bounded separately.
    child.stdout.resume();
    child.stderr.resume();
    child.once('error', () => {
      launchError ??= new EngineError(
        'LAUNCH_FAILED',
        'OpenCode could not start. Recheck its installation and dependencies.',
        false,
        'launch',
      );
    });
    const base = `http://127.0.0.1:${port}`;
    const auth = `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}`;
    // The engine's own folder for every turn: no turn has a file tool, and a project's
    // own OpenCode configuration must never be loaded into a Diomedes turn.
    const directory = this.cwd;
    const ready = deadline(signal, this.startupTimeout);
    try {
      for (;;) {
        try {
          // Talking to the loopback server Diomedes started, with the password
          // Diomedes generated for it. Nothing here has reached an account yet.
          const response = await this.fetcher(`${base}/provider`, {
            headers: this.headers(auth, directory),
            signal: AbortSignal.any([ready.signal, AbortSignal.timeout(this.handshakeAttempt)]),
          });
          const body = await cappedText(response, MAX_JSON_BYTES, 'local-handshake');
          if (response.status === 401 || response.status === 403)
            throw errorForResponse(response.status, body, 'local-handshake');
          if (response.ok) {
            ready.dispose();
            return { child, base, auth, env, root, directory };
          }
        } catch (error) {
          if (error instanceof EngineError) throw error;
          if (launchError) throw launchError;
          if (ready.signal.aborted)
            throw abortError(ready.signal, this.startupTimeout, 'startup', 'launch');
        }
        if (launchError) throw launchError;
        if (child.exitCode !== null || child.signalCode !== null)
          throw new EngineError(
            'LAUNCH_FAILED',
            'OpenCode stopped before its server became ready.',
            true,
            'launch',
          );
        await new Promise((resolve) => setTimeout(resolve, 40));
      }
    } catch (error) {
      ready.dispose();
      const failure = atStage(error, 'launch');
      await this.closeChild(child, failure);
      await fs.rm(root, { recursive: true, force: true });
      throw failure;
    }
  }

  private headers(auth: string, directory = this.cwd): Record<string, string> {
    return { Authorization: auth, Accept: 'application/json', 'x-opencode-directory': directory };
  }
  /**
   * A cleanup failure never replaces the failure that caused it, and it must
   * not lose the stage that failure was found at either: `cleanupFailed`
   * rebuilds the error from the primary's code and message alone.
   */
  private async closeChild(child: ChildProcessWithoutNullStreams, primary?: unknown) {
    try {
      await killOwnedProcess(child);
    } catch {
      const failure = cleanupFailed(primary);
      const found = primary instanceof EngineError ? primary.stage : undefined;
      throw atStage(failure, found ?? 'cleanup');
    }
  }
  private async request(
    server: { base: string; auth: string; directory?: string },
    route: string,
    init: RequestInit,
    signal: AbortSignal,
    stage: SetupStage,
    /** Read a 404 as `NOT_FOUND` rather than a provider failure: a session lookup's clear answer. */
    notFound = false,
  ): Promise<Response> {
    let response: Response;
    try {
      response = await this.fetcher(`${server.base}${route}`, {
        ...init,
        signal,
        headers: { ...this.headers(server.auth, server.directory), ...(init.headers ?? {}) },
      });
    } catch (error) {
      if (signal.aborted) throw abortError(signal, this.requestTimeout, 'request', stage);
      throw new EngineError('PROVIDER_ERROR', 'OpenCode could not be reached.', true, stage);
    }
    if (!response.ok) {
      const body = (await cappedText(response, 4096, stage)).slice(0, 4096);
      if (notFound && response.status === 404)
        throw new EngineError('NOT_FOUND', 'OpenCode has no such session.', true, stage);
      throw errorForResponse(response.status, body, stage);
    }
    return response;
  }
  private async json(response: Response, stage: SetupStage): Promise<Json> {
    try {
      return object(JSON.parse(await cappedText(response, MAX_JSON_BYTES, stage)));
    } catch (error) {
      if (error instanceof EngineError) throw error;
      throw new EngineError('PROTOCOL_ERROR', 'OpenCode returned malformed JSON.', true, stage);
    }
  }
  private async cleanupRequest(
    server: { base: string; auth: string; directory?: string },
    route: string,
  ) {
    const control = new AbortController();
    const timer = setTimeout(() => control.abort('cleanup-timeout'), 2_000);
    try {
      await this.request(
        server,
        route,
        { method: route.endsWith('/abort') ? 'POST' : 'DELETE' },
        control.signal,
        'cleanup',
      );
    } catch {
      /* Cleanup must not replace the primary provider or cancellation error. */
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * The same three answers a single turn and a kept session both need before
   * anything is dispatched: no Go account, a different account, or a Go account
   * that does not offer this model.
   */
  private async admitModel(
    server: { base: string; auth: string; directory?: string },
    signal: AbortSignal,
    model: string,
  ): Promise<void> {
    const provider = catalogue(
      await this.json(await this.request(server, '/provider', {}, signal, 'model-list'), 'model-list'),
    );
    if (!provider.connected && provider.others.length)
      throw new EngineError(
        'ACCOUNT_CHANGED',
        `OpenCode reported connected providers other than ${OPENCODE_ACCOUNT_ROUTE}. This route uses that account only and substitutes nothing for it.`,
        true,
        'provider-auth',
      );
    if (!provider.connected)
      throw new EngineError('AUTH_REQUIRED', NO_GO_ACCOUNT_DETAIL, true, 'provider-auth');
    if (!provider.models.some((item) => item.slug === model))
      throw new EngineError(
        'MODEL_UNAVAILABLE',
        'The selected OpenCode Go model is unavailable. Recheck before sending.',
        true,
        'model-list',
      );
  }
  /**
   * Reads one turn's events for one session until OpenCode reports it idle with
   * a complete answer from the requested model. Shared by the single-turn route
   * and a kept session, so both hold the same read boundary, the same retry and
   * permission refusals and the same model check. `earlier` names assistant
   * messages a kept session's previous turns already answered with.
   */
  private async readTurn(
    eventResponse: Response,
    turn: {
      sessionId: string;
      selection: { providerID: string; modelID: string };
      input: TextRequest;
      scope?: ReadScope;
      earlier?: ReadonlySet<string>;
    },
  ): Promise<{ text: string; assistantMessageId: string; reportedModel: string }> {
    const { sessionId, selection, input, scope, earlier } = turn;
    const calls = new Map<string, { tool: string; started: boolean }>();
    if (!eventResponse.body)
      throw new EngineError(
        'PROTOCOL_ERROR',
        'OpenCode did not provide an event stream.',
        true,
        'stream',
      );
    const reader = eventResponse.body.getReader();
    // Framing follows the specification, so LF, CRLF and CR streams, joined
    // data fields and comments all read the same. Nothing below relaxes:
    // an event that never reached its blank line is never dispatched.
    const parser = new SseParser({ maxBufferBytes: MAX_SSE_EVENT_BYTES });
    let answer = '';
    let bytes = 0;
    let assistantMessageId: string | undefined;
    let assistantInfo = false;
    let assistantTerminal = false;
    // The answer is built from text parts only. OpenCode 1.18.4 streams a
    // reasoning part's deltas with the same `field: "text"`, so a delta is
    // accepted only for a part it has already announced as text. A text
    // delta that arrives before its announcement is recovered from the
    // part's full text when that part is next updated.
    const textParts = new Map<string, string>();
    try {
      for (;;) {
        const part = await reader.read();
        if (part.done) break;
        bytes += part.value.byteLength;
        if (bytes > MAX_EVENT_BYTES)
          throw new EngineError('OUTPUT_LIMIT', 'OpenCode exceeded the response limit.', true);
        let frames: SseEvent[];
        try {
          frames = parser.push(part.value);
        } catch (error) {
          if (!(error instanceof SseLimitError)) throw error;
          throw new EngineError('OUTPUT_LIMIT', 'OpenCode exceeded the response limit.', true);
        }
        for (const frame of frames) {
          let event: Json;
          try {
            event = object(JSON.parse(frame.data));
          } catch {
            throw new EngineError(
              'PROTOCOL_ERROR',
              'OpenCode returned malformed event data.',
              true,
            );
          }
          const kind = text(event.type);
          const props = object(event.properties);
          const eventSession =
            text(props.sessionID) ||
            text(object(props.info).sessionID) ||
            text(object(props.part).sessionID);
          if (eventSession !== sessionId) continue;
          const partValue = object(props.part);
          const partType = text(partValue.type);
          const status = object(props.status);
          const statusType = text(status.type);
          if (/retry/i.test(kind) || /retry/i.test(partType) || statusType === 'retry')
            throw new EngineError(
              'PROVIDER_ERROR',
              'OpenCode started a retry. Diomedes stopped without redispatching.',
              true,
            );
          if (scope && kind === 'message.part.updated' && partType === 'tool') {
            const tool = text(partValue.tool);
            const callId = text(partValue.callID) || text(partValue.id) || `call-${calls.size + 1}`;
            const state = object(partValue.state);
            const status = text(state.status);
            if (!opencodeAllowedTools(scope).includes(tool))
              throw new EngineError(
                'POLICY_MISMATCH',
                'OpenCode went beyond the read-only boundary; the request was stopped.',
                true,
              );
            // A pending part is still streaming its arguments; judge it once they are set.
            if (status === 'pending') continue;
            const call = calls.get(callId) ?? { tool, started: false };
            calls.set(callId, call);
            const checked = opencodeToolCall(scope, tool, state.input);
            if (!call.started) {
              call.started = true;
              emitActivity(input.onToolActivity, {
                callId,
                phase: 'started',
                tool,
                summary: checked.summary,
                ...(checked.detail ? { detail: checked.detail } : {}),
              });
            }
            if (status === 'completed' || status === 'error') {
              calls.delete(callId);
              const detail = readDetail(status === 'error' ? state.error : state.output, 300);
              emitActivity(input.onToolActivity, {
                callId,
                phase: status === 'error' ? 'failed' : 'finished',
                tool,
                summary: status === 'error' ? `${tool} did not complete` : `${tool} finished`,
                ...(detail ? { detail } : {}),
              });
            }
            continue;
          }
          if (/permission/i.test(kind) || /tool/i.test(partType))
            throw new EngineError(
              'POLICY_MISMATCH',
              'OpenCode requested a tool or permission on the text-only route.',
              true,
            );
          if (kind === 'message.updated') {
            const info = object(props.info);
            if (text(info.role) !== 'assistant') continue;
            // An answer an earlier turn of a kept session already gave is not this turn's.
            if (earlier?.has(text(info.id))) continue;
            assistantMessageId = text(info.id);
            const reportedProvider = text(info.providerID);
            const reportedModel = text(info.modelID);
            if (
              !assistantMessageId ||
              reportedProvider !== selection.providerID ||
              reportedModel !== selection.modelID
            )
              throw new EngineError(
                'POLICY_MISMATCH',
                'OpenCode reported a different provider or model.',
                true,
              );
            assistantInfo = true;
            const time = object(info.time);
            assistantTerminal = Number.isFinite(time.completed) && text(info.finish).length > 0;
            if (info.error)
              throw streamFailure(info.error, 'OpenCode reported an assistant error.');
          }
          if (kind === 'session.error')
            throw streamFailure(props.error, 'OpenCode reported a session error.');
          if (
            kind === 'message.part.updated' &&
            assistantMessageId &&
            text(partValue.messageID) === assistantMessageId
          ) {
            if (partType !== 'text') continue;
            const partId = text(partValue.id);
            if (partId && !textParts.has(partId)) textParts.set(partId, '');
            const delta = text(props.delta);
            if (delta) {
              answer += delta;
              if (partId) textParts.set(partId, (textParts.get(partId) ?? '') + delta);
              input.onDelta?.(delta);
            } else {
              // Recover what this part has that the answer does not, per part,
              // so a later part's early deltas are not lost either.
              const full = text(partValue.text);
              const prior = partId ? (textParts.get(partId) ?? '') : answer;
              if (full && full.startsWith(prior)) {
                const next = full.slice(prior.length);
                answer += next;
                if (partId) textParts.set(partId, full);
                if (next) input.onDelta?.(next);
              }
            }
          }
          if (
            kind === 'message.part.delta' &&
            assistantMessageId &&
            text(props.messageID) === assistantMessageId &&
            text(props.field) === 'text' &&
            textParts.has(text(props.partID))
          ) {
            const delta = text(props.delta);
            if (delta) {
              answer += delta;
              textParts.set(text(props.partID), (textParts.get(text(props.partID)) ?? '') + delta);
              input.onDelta?.(delta);
            }
          }
          if (
            kind === 'session.status' &&
            statusType === 'idle' &&
            assistantInfo &&
            assistantTerminal &&
            answer.trim()
          )
            return {
              text: answer,
              assistantMessageId: assistantMessageId!,
              reportedModel: `${selection.providerID}/${selection.modelID}`,
            };
        }
      }
    } finally {
      await reader.cancel().catch(() => {
        /* The body is already bounded and no longer needed. */
      });
    }
    throw new EngineError(
      'PROTOCOL_ERROR',
      'OpenCode ended without a complete text response.',
      true,
      'stream',
    );
  }

  /**
   * Opens a kept OpenCode session for a conversation: one server process for
   * its turns and one OpenCode session whose id the host saves. See
   * `server/engines/opencode-session.ts` for resume, fork and abort.
   */
  openSession(input: TextRequest, options: OpenCodeSessionOptions): Promise<OpenCodeNativeSession<OpenCodeServerHandle>> {
    return openOpenCodeSession(this.transport(), input, options);
  }
  private transport(): OpenCodeTransport<OpenCodeServerHandle> {
    return {
      accountRoute: OPENCODE_ACCOUNT_ROUTE,
      start: (scope) => this.start(undefined, scope),
      stop: async (server, primary) => {
        try {
          await this.closeChild(server.child, primary);
        } finally {
          await fs.rm(server.root, { recursive: true, force: true, maxRetries: 8, retryDelay: 200 });
        }
      },
      request: (server, route, init, signal, stage) =>
        this.request(server, route, init, signal, stage, route.startsWith('/session/')),
      json: (response, stage) => this.json(response, stage),
      admitModel: (server, signal, model) => this.admitModel(server, signal, model),
      sessionBody,
      promptBody,
      readTurn: (eventResponse, turn) => this.readTurn(eventResponse, turn),
      parseSelection,
      bounded: async (signal, stage, work) => {
        const control = deadline(signal, this.requestTimeout);
        try {
          return await work(control.signal);
        } catch (error) {
          if (!(error instanceof EngineError) && control.signal.aborted)
            error = abortError(control.signal, this.requestTimeout, 'request', stage());
          throw error instanceof EngineError
            ? atStage(error, stage())
            : new EngineError('PROVIDER_ERROR', 'OpenCode could not complete this request.', true, stage());
        } finally {
          control.dispose();
        }
      },
    };
  }

  async inspect(signal?: AbortSignal): Promise<AdapterInspection> {
    const server = await this.start(signal);
    const control = deadline(signal, this.requestTimeout);
    try {
      const body = await this.json(
        await this.request(server, '/provider', {}, control.signal, 'model-list'),
        'model-list',
      );
      const list = catalogue(body);
      // UNREACHABLE over HTTP under this adapter's own configuration, and kept
      // only as a guard if that configuration ever changes. `enabled_providers`
      // makes the tool prune every non-Go provider out of its state before it
      // answers, so `others` is always empty here and a person holding only an
      // OpenCode Zen account reaches the branch below instead. Nothing on this
      // route detects that account; the sentence below is what they get, and it
      // says so rather than pretending this branch covers them.
      if (!list.connected && list.others.length)
        return {
          authentication: 'unknown',
          accountRoute: null,
          models: [],
          routeIssue: { required: OPENCODE_ACCOUNT_ROUTE, connected: list.reported },
          detail: `This route runs on the native OpenCode Go account (${OPENCODE_ACCOUNT_ROUTE}). OpenCode reported other connected providers, which this route does not use.`,
        };
      // The field is answered either way. A caller that merges this over the
      // last answer would otherwise keep reporting a route issue the person
      // has since resolved, because an absent key overwrites nothing.
      if (!list.connected)
        return {
          authentication: 'signed-out',
          accountRoute: null,
          models: [],
          routeIssue: undefined,
          detail: NO_GO_ACCOUNT_DETAIL,
        };
      return {
        authentication: 'signed-in',
        accountRoute: OPENCODE_ACCOUNT_ROUTE,
        models: list.models,
        routeIssue: undefined,
        detail: list.models.length
          ? 'Native OpenCode Go account connected. Choose an explicit provider/model.'
          : 'OpenCode Go reported no usable models.',
      };
    } finally {
      control.dispose();
      await this.closeChild(server.child);
      await fs.rm(server.root, { recursive: true, force: true });
    }
  }

  async generate(input: TextRequest): Promise<TextResponse> {
    if (input.accountRoute !== OPENCODE_ACCOUNT_ROUTE)
      throw new EngineError(
        'ACCOUNT_CHANGED',
        'The selected OpenCode account route changed. Recheck before sending.',
        false,
        'provider-auth',
      );
    const selection = parseSelection(input.model);
    const prompt = contextMessage(input);
    const scope = input.readScope;
    if (scope && readAccessOf(scope) === 'project')
      throw new EngineError(
        'POLICY_MISMATCH',
        'OpenCode cannot read the whole project folder, because its reads cannot be checked before they run. Choose the documents to include instead.',
        false,
        'dispatch',
      );
    const server = await this.start(input.signal, scope);
    const control = deadline(input.signal, this.requestTimeout);
    let sessionId: string | undefined;
    let eventResponse: Response | undefined;
    let completed = false;
    let primary: unknown;
    /** Where the attempt has reached, for anything that arrives without a stage of its own. */
    let stage: SetupStage = 'model-list';
    try {
      await this.admitModel(server, control.signal, input.model);
      stage = 'dispatch';
      const created = await this.json(
        await this.request(
          server,
          '/session',
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(sessionBody(input, selection, scope)),
          },
          control.signal,
          'dispatch',
        ),
        'dispatch',
      );
      sessionId = text(created.id) || text(created.sessionID);
      if (!sessionId)
        throw new EngineError(
          'PROTOCOL_ERROR',
          'OpenCode did not return a session id.',
          true,
          'dispatch',
        );
      eventResponse = await this.request(
        server,
        '/event',
        { headers: { Accept: 'text/event-stream' } },
        control.signal,
        'stream',
      );
      await this.request(
        server,
        `/session/${encodeURIComponent(sessionId)}/prompt_async`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(promptBody(input, selection, scope, prompt)),
        },
        control.signal,
        'dispatch',
      );
      // The prompt is accepted from here on, so every later failure is a
      // stream failure over work the account may already have been charged for.
      stage = 'stream';
      const turn = await this.readTurn(eventResponse, { sessionId, selection, input, scope });
      completed = true;
      return {
        text: turn.text,
        model: input.model,
        version: OPENCODE_VERSION,
        projectId: input.projectId,
        threadId: input.threadId,
        requestId: input.requestId,
      };
    } catch (error) {
      if (!(error instanceof EngineError) && control.signal.aborted)
        error = abortError(control.signal, this.requestTimeout, 'request', stage);
      // Anything raised inside the stream loop is stamped here rather than at
      // every throw; `atStage` keeps a stage the thrower already knew.
      const failure =
        error instanceof EngineError
          ? atStage(error, stage)
          : new EngineError(
              'PROVIDER_ERROR',
              'OpenCode could not complete this request.',
              true,
              stage,
            );
      primary = failure;
      if (sessionId && !completed)
        await this.cleanupRequest(server, `/session/${encodeURIComponent(sessionId)}/abort`);
      throw failure;
    } finally {
      if (sessionId) await this.cleanupRequest(server, `/session/${encodeURIComponent(sessionId)}`);
      await eventResponse?.body?.cancel().catch(() => {
        /* Cleanup must not replace the primary result. */
      });
      control.dispose();
      await this.closeChild(server.child, primary);
      await fs.rm(server.root, { recursive: true, force: true });
    }
  }
}
