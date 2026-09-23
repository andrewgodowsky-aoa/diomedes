import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { EngineModel } from '../../shared/types.js';
import type { SetupStage } from '../../shared/engines.js';
import { routeContractFor } from '../harness/route-contract.js';
import {
  ClaudeNativeSession,
  prepareClaudeSession,
  type ClaudeSessionOptions,
} from './claude-session.js';
import {
  contextMessage,
  type AdapterInspection,
  type TextEngineAdapter,
  type TextRequest,
  type TextResponse,
} from './contract.js';
import {
  capture,
  cleanupFailed,
  engineEnvironment,
  EngineError,
  failureKind,
  openProcess,
  record,
  staged,
  type EngineProcess,
  type ProcessFactory,
} from './process.js';
import {
  approvedMcpTool,
  displayPath,
  emitActivity,
  insideRoot,
  isWebUrl,
  readAccessOf,
  readDetail,
  readScopeNote,
  readSummary,
  serverEnvironment,
  type ReadKind,
  type ReadScope,
} from './read-scope.js';
import { readAllowed, type ReadKindForFiles } from './turn-scope.js';

export const CLAUDE_VERSION = '2.1.252';
const ACCOUNT_ROUTE = 'claude-code:claude.ai';
/**
 * The sign-in methods this route can name, as a closed list. Shape alone was
 * not a guarantee: `acme-holdings-inc` is identifier-shaped, and this value is
 * rendered in the setup sentence and copied into the support bundle a person
 * sends to someone else. A method not on this list is counted, never named.
 * `claude.ai` is the one this route accepts; `api_key` is the one it refuses
 * by name. Both are observed in this repository; nothing is listed from memory.
 */
const NAMEABLE_AUTH_METHODS = ['api_key'] as const;
/** Claude Code's built-in read tools. Nothing that edits, writes or runs a command. */
export const CLAUDE_READ_TOOLS = ['Read', 'Grep', 'Glob', 'LS'] as const;
export const CLAUDE_WEB_TOOLS = ['WebSearch', 'WebFetch'] as const;
/** Tool steps a read turn may take before Claude Code itself stops it. */
export const CLAUDE_READ_MAX_TURNS = 16;
/**
 * The built-in tools a scope makes available, in the order they are passed to `--tools`.
 * A selected-only turn has no file tool at all: its documents are already in the message.
 */
export function claudeBuiltinTools(scope: ReadScope): string[] {
  return [
    ...(readAccessOf(scope) === 'project' ? CLAUDE_READ_TOOLS : []),
    ...(scope.web ? CLAUDE_WEB_TOOLS : []),
  ];
}
/**
 * The tools that run without asking: web tools and the approved MCP read tools. File tools
 * are never pre-approved; on a whole-project turn each one asks the host first.
 */
export function claudeAllowedTools(scope: ReadScope): string[] {
  return [
    ...(scope.web ? CLAUDE_WEB_TOOLS : []),
    ...(scope.mcp ?? []).flatMap((server) =>
      server.readTools.map((tool) => `mcp__${server.name}__${tool}`),
    ),
  ];
}
/**
 * The `--mcp-config` document for a scope: approved servers only. A forwarded
 * secret is written as a `${NAME}` reference that Claude Code expands from its
 * own environment, so no value lands in a configuration file.
 */
export function claudeMcpConfig(scope?: ReadScope): string {
  return JSON.stringify({
    mcpServers: Object.fromEntries(
      (scope?.mcp ?? []).map((server) => [
        server.name,
        {
          type: 'stdio',
          command: server.command,
          args: [...server.args],
          env: Object.fromEntries(server.envFrom.map((name) => [name, '${' + name + '}'])),
        },
      ]),
    ),
  });
}
/**
 * `persistent` is the native-session transport's one difference: a session keeps
 * one process across turns, so it must not carry the single-turn guards. Every
 * other argument, including the closed tool and MCP configuration, is identical
 * for both, because a persistent process must not be a less restricted one.
 *
 * A selected-only scope offers web and approved MCP read tools, no file tool, and
 * denies everything else without asking (`dontAsk`, `--restricted`). A whole-project
 * scope also offers the file tools but pre-approves none of them: the process works in
 * an empty folder of its own, so every project read is outside its working folder and
 * asks the host over `--permission-prompt-tool stdio`, which answers only after
 * resolving the path (`claudePermission`). `--restricted` is left off there because it
 * would refuse those reads outright instead of asking. Either way a turn may take a
 * bounded number of tool steps. Without a scope the arguments are the text-only ones.
 */
export function claudeArguments(persistent = false, scope?: ReadScope): string[] {
  const args = [
    '--print',
    '--input-format',
    'stream-json',
    '--output-format',
    'stream-json',
    '--verbose',
    '--include-partial-messages',
    '--safe-mode',
    '--setting-sources',
    '',
    '--tools',
    scope ? claudeBuiltinTools(scope).join(',') : '',
    '--strict-mcp-config',
    '--mcp-config',
    scope ? claudeMcpConfig(scope) : '{"mcpServers":{}}',
    '--disable-slash-commands',
  ];
  if (scope) {
    const allowed = claudeAllowedTools(scope);
    if (allowed.length) args.push('--allowedTools', allowed.join(','));
    if (readAccessOf(scope) === 'project')
      args.push('--permission-mode', 'default', '--permission-prompt-tool', 'stdio');
    else args.push('--permission-mode', 'dontAsk', '--restricted');
  }
  if (!persistent)
    args.push(
      '--no-session-persistence',
      '--max-turns',
      scope ? String(CLAUDE_READ_MAX_TURNS) : '1',
    );
  args.push(
    '--settings',
    '{"disableAllHooks":true,"autoUpdatesChannel":"stable","enabledPlugins":{}}',
  );
  return args;
}
const stringField = (value: Record<string, unknown>, key: string) =>
  typeof value[key] === 'string' ? (value[key] as string) : undefined;
/**
 * One Claude Code tool call against a read scope: the plain sentence and the
 * technical line to show, or a refusal. A tool outside the allow-list, a path
 * outside the project folder, a web call without web access or an MCP tool the
 * owner did not approve stops the request.
 */
export function claudeToolCall(
  scope: ReadScope,
  name: string,
  raw: unknown,
): { kind: ReadKind; summary: string; detail?: string } {
  const input = record(raw);
  const refuse = (why: string) =>
    new EngineError(
      'POLICY_MISMATCH',
      `Claude Code ${why}; the read-only request was stopped.`,
      true,
      'stream',
    );
  const within = (candidate: string | undefined, optional: boolean) => {
    if (candidate === undefined) {
      if (optional) return scope.root;
      throw refuse(`called ${name} without a path`);
    }
    if (!insideRoot(scope.root, candidate)) throw refuse('tried to read outside the project folder');
    return candidate;
  };
  const detail = readDetail(input);
  if ((CLAUDE_READ_TOOLS as readonly string[]).includes(name) && readAccessOf(scope) !== 'project')
    throw refuse(`called ${name}, but this turn reads only the documents chosen for it`);
  switch (name) {
    case 'Read': {
      const file = within(stringField(input, 'file_path'), false);
      return {
        kind: 'read',
        summary: readSummary('read', { path: displayPath(scope.root, file) }),
        detail,
      };
    }
    case 'LS': {
      const folder = within(stringField(input, 'path'), true);
      return {
        kind: 'list',
        summary: readSummary('list', { path: displayPath(scope.root, folder) }),
        detail,
      };
    }
    case 'Glob':
    case 'Grep': {
      within(stringField(input, 'path'), true);
      const query = stringField(input, 'pattern');
      // An absolute pattern names its own folder; judge the part before any wildcard.
      if (name === 'Glob' && query && path.isAbsolute(query)) {
        const wild = query.search(/[*?[{]/);
        within(wild < 0 ? query : query.slice(0, wild) || query, false);
      }
      return name === 'Glob'
        ? {
            kind: 'list',
            summary: query ? `Finding files matching ${query}` : readSummary('list', {}),
            detail,
          }
        : { kind: 'search', summary: readSummary('search', { query }), detail };
    }
    case 'WebSearch':
      if (!scope.web) throw refuse('tried to search the web without web access');
      return {
        kind: 'web-search',
        summary: readSummary('web-search', { query: stringField(input, 'query') }),
        detail,
      };
    case 'WebFetch': {
      const url = stringField(input, 'url');
      if (!scope.web || !isWebUrl(url)) throw refuse('tried to open a page without web access');
      return { kind: 'web-fetch', summary: readSummary('web-fetch', { url }), detail };
    }
  }
  const mcp = /^mcp__([a-z][a-z0-9_-]{0,31})__(.+)$/.exec(name);
  if (mcp && approvedMcpTool(scope, mcp[1], mcp[2]))
    return { kind: 'mcp', summary: readSummary('mcp', { server: mcp[1], tool: mcp[2] }), detail };
  throw refuse(
    `attempted ${/^[A-Za-z0-9_.-]{1,80}$/.test(name) ? name : 'a tool'} outside the read allow-list`,
  );
}
const CLAUDE_FILE_KIND: Record<string, ReadKindForFiles> = {
  Read: 'read',
  LS: 'list',
  Glob: 'list',
  Grep: 'search',
};
/** A path segment that climbs: a pattern or filter carrying one could search above its folder. */
const climbs = (value: string | undefined) => Boolean(value && /(^|[\\/])\.\.([\\/]|$)/.test(value));
/**
 * The folders and files one file-tool call names. A relative path is the tool's own: it is
 * judged against the process's working folder, which on a whole-project turn is an empty
 * folder outside the project, so a relative read can never land on a project file unchecked.
 */
function claudeToolTargets(name: string, input: Record<string, unknown>): string[] | undefined {
  const where = stringField(input, name === 'Read' ? 'file_path' : 'path');
  if (name === 'Read' || name === 'LS') return where ? [where] : undefined;
  const pattern = stringField(input, 'pattern');
  if (climbs(pattern) || climbs(stringField(input, 'glob'))) return undefined;
  const targets = [where ?? '.'];
  // An absolute Glob pattern names its own folder: the part before the first wildcard.
  if (name === 'Glob' && pattern && path.isAbsolute(pattern)) {
    const wild = pattern.search(/[*?[{]/);
    const prefix = wild < 0 ? pattern : pattern.slice(0, wild) || pattern;
    targets.push(/[\\/]$/.test(prefix) || wild < 0 ? prefix : path.dirname(prefix));
  }
  return targets;
}
/**
 * The host's answer to one Claude Code `can_use_tool` permission request, given before the
 * tool runs. Only a whole-project turn asks at all; every file path the call names must pass
 * `readAllowed` (resolved on disk, inside the project, under a live turn grant), and any
 * other tool must already be on the read allow-list. A deny interrupts the turn.
 */
export async function claudePermission(
  scope: ReadScope | undefined,
  request: Record<string, unknown>,
  cwd: string,
): Promise<
  | { behavior: 'allow'; updatedInput: Record<string, unknown> }
  | { behavior: 'deny'; message: string; interrupt: true }
> {
  const deny = (message: string) => ({ behavior: 'deny' as const, message, interrupt: true as const });
  if (request.subtype !== 'can_use_tool') return deny('requested a disabled capability');
  if (!scope || readAccessOf(scope) !== 'project')
    return deny('asked for a permission this turn cannot grant');
  const name = typeof request.tool_name === 'string' ? request.tool_name : '';
  const input = record(request.input);
  try {
    claudeToolCall(scope, name, input);
  } catch (error) {
    return deny(error instanceof EngineError ? error.message : 'attempted a tool outside the read allow-list');
  }
  const kind = CLAUDE_FILE_KIND[name];
  if (kind) {
    const targets = claudeToolTargets(name, input);
    if (!targets) return deny(`called ${name} with a path that is not allowed`);
    for (const target of targets) {
      const check = await readAllowed(scope, kind, target, cwd);
      if (!check.ok) return deny(`tried to read a path that is not allowed (${check.reason})`);
    }
  }
  return { behavior: 'allow', updatedInput: input };
}
/** The frame that answers a control request. */
export const claudeControlResponse = (requestId: string, response: unknown) => ({
  type: 'control_response',
  response: { subtype: 'success', request_id: requestId, response },
});
/**
 * Whether an init frame's tools and MCP servers fit the route: none at all for
 * the text-only route; for a scope, a subset of its built-ins and approved
 * servers. A server's unapproved tools may be listed — `dontAsk` denies them
 * and a call to one stops the request — but no unapproved server may be.
 */
export function claudeInitAllowed(
  scope: ReadScope | undefined,
  frame: Record<string, unknown>,
): boolean {
  if (!Array.isArray(frame.tools) || !Array.isArray(frame.mcp_servers)) return false;
  if (!scope) return frame.tools.length === 0 && frame.mcp_servers.length === 0;
  const builtins = new Set<string>(claudeBuiltinTools(scope));
  const servers = new Set((scope.mcp ?? []).map((server) => server.name));
  return (
    frame.tools.every((tool) => {
      if (typeof tool !== 'string') return false;
      if (builtins.has(tool)) return true;
      const mcp = /^mcp__([a-z][a-z0-9_-]{0,31})__/.exec(tool);
      return Boolean(mcp && servers.has(mcp[1]));
    }) &&
    frame.mcp_servers.every((entry) => {
      const name = typeof entry === 'string' ? entry : record(entry).name;
      return typeof name === 'string' && servers.has(name);
    })
  );
}
/**
 * Tool-call and tool-result activity from one stream-json frame. Without a
 * scope any tool call stops the request, exactly as before. Returns true when
 * the frame carried a web call, which lets a scoped turn account for the helper
 * model Claude Code runs inside its web tools.
 */
export function claudeObserveTools(
  scope: ReadScope | undefined,
  frame: Record<string, unknown>,
  sink: TextRequest['onToolActivity'],
  open: Map<string, string>,
): boolean {
  const content = record(frame.message).content;
  if (!Array.isArray(content)) return false;
  let web = false;
  if (frame.type === 'assistant')
    for (const part of content.map(record)) {
      if (part.type !== 'tool_use') continue;
      if (!scope)
        throw new EngineError(
          'POLICY_MISMATCH',
          'Claude Code attempted a tool call on the text-only route.',
          true,
          'stream',
        );
      const name = typeof part.name === 'string' ? part.name : '';
      const call = claudeToolCall(scope, name, part.input);
      if (call.kind === 'web-search' || call.kind === 'web-fetch') web = true;
      const callId = typeof part.id === 'string' && part.id ? part.id : `call-${open.size + 1}`;
      open.set(callId, name);
      emitActivity(sink, {
        callId,
        phase: 'started',
        tool: name,
        summary: call.summary,
        ...(call.detail ? { detail: call.detail } : {}),
      });
    }
  if (frame.type === 'user' && scope)
    for (const part of content.map(record)) {
      if (part.type !== 'tool_result' || typeof part.tool_use_id !== 'string') continue;
      const tool = open.get(part.tool_use_id);
      if (!tool) continue;
      open.delete(part.tool_use_id);
      const failed = part.is_error === true;
      const detail = readDetail(part.content, 300);
      emitActivity(sink, {
        callId: part.tool_use_id,
        phase: failed ? 'failed' : 'finished',
        tool,
        summary: failed ? `${tool} did not complete` : `${tool} finished`,
        ...(detail ? { detail } : {}),
      });
    }
  return web;
}
/**
 * The helper model Claude Code runs inside its own web tools to read a fetched
 * page. Accepted in `modelUsage` only on a scoped turn that made a web call;
 * the answer is still attributed to the requested model alone.
 */
export const claudeWebHelperModel = (value: string) => /^claude-(3-5-)?haiku-/.test(value);
/** The approved MCP servers' forwarded variables, for Claude Code to expand into their config. */
function mcpEnvironment(scope?: ReadScope): Record<string, string> {
  return Object.assign({}, ...(scope?.mcp ?? []).map((server) => serverEnvironment(server)));
}
function environment(scope?: ReadScope) {
  return {
    ...engineEnvironment(),
    ...mcpEnvironment(scope),
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    DISABLE_AUTOUPDATER: '1',
    CLAUDE_CODE_MAX_RETRIES: '0',
    CLAUDE_CODE_SAFE_MODE: '1',
  };
}
/**
 * A denial names the account wherever it is seen; a limit and a plain provider
 * fault keep the stage they were seen at, so neither is read as a sign-in.
 */
function failure(value: unknown, stage: SetupStage): EngineError {
  // Read from the frame's own fields. Searching the serialised frame made
  // `auth` inside `authority` a missing sign-in, so an enterprise certificate
  // or proxy fault — on the audit's own list of hostile machines — was
  // answered with sign-in advice that repairs nothing.
  const kind = failureKind(value);
  if (kind === 'limited')
    return new EngineError(
      'USAGE_LIMIT',
      'Claude Code reported a usage or service limit. No account or model was substituted.',
      true,
      stage,
    );
  if (kind === 'denied')
    return new EngineError(
      'AUTH_REQUIRED',
      'Claude Code needs sign-in. Use its sign-in action, then recheck.',
      true,
      'provider-auth',
    );
  return new EngineError(
    'PROVIDER_ERROR',
    'Claude Code could not complete this request. No automatic retry was sent.',
    true,
    stage,
  );
}
const signInRequired = () =>
  new EngineError(
    'AUTH_REQUIRED',
    'Sign in to Claude Code with your Claude account. This route does not use API billing.',
    false,
    'provider-auth',
  );
function sameModel(requested: string, reported: string) {
  return (
    requested === reported ||
    (['sonnet', 'opus', 'haiku'].includes(requested) && reported.startsWith(`claude-${requested}-`))
  );
}
export class ClaudeAdapter implements TextEngineAdapter {
  readonly id = 'claude-code' as const;
  readonly contract = routeContractFor('claude-code');
  private readonly launch: ProcessFactory;
  private readonly account: (signal?: AbortSignal) => Promise<Record<string, unknown>>;
  constructor(
    private readonly file: string,
    private readonly cwd: string,
    deps: {
      launch?: ProcessFactory;
      account?: (signal?: AbortSignal) => Promise<Record<string, unknown>>;
    } = {},
  ) {
    this.launch = deps.launch ?? openProcess;
    this.account =
      deps.account ??
      (async (signal) => {
        let result;
        try {
          result = await capture({
            file,
            args: ['--safe-mode', '--setting-sources', '', 'auth', 'status', '--json'],
            cwd,
            env: environment(),
            timeoutMs: 10_000,
            maxBytes: 32_000,
            signal,
          });
        } catch (error) {
          // A probe that cannot start has not asked the account anything yet.
          throw staged(error, 'launch');
        }
        try {
          return record(JSON.parse(result.stdout));
        } catch {
          throw new EngineError(
            'AUTH_UNKNOWN',
            'Claude Code could not report its sign-in status.',
            false,
            'provider-auth',
          );
        }
      });
  }
  /**
   * The sign-in method the native tool reports. A tool signed in through
   * another kind of account is not signed out, so this returns what it holds
   * and the caller decides; only an absent sign-in refuses here.
   */
  private async accountMethod(signal?: AbortSignal): Promise<string> {
    const status = await this.account(signal);
    const method = typeof status.authMethod === 'string' ? status.authMethod : '';
    if (status.loggedIn !== true || !method) throw signInRequired();
    return method;
  }
  /**
   * The signed-in account itself, for the one caller that needs more than the
   * method name: a native session pins the account it opened on, so it has to
   * see the identity fields. The refusal is the same one `text` makes before it
   * sends (`accountMethod` plus the `claude.ai` rule), stated once here so the
   * session transport cannot be a softer door than the single-turn one.
   */
  private async claudeAccount(signal?: AbortSignal): Promise<Record<string, unknown>> {
    const status = await this.account(signal);
    const method = typeof status.authMethod === 'string' ? status.authMethod : '';
    if (status.loggedIn !== true || !method || method !== 'claude.ai') throw signInRequired();
    return status;
  }
  /** Opt-in transport leaf. The host must persist checkpoints in its existing run authority. */
  async openSession(
    input: TextRequest,
    options: ClaudeSessionOptions,
  ): Promise<ClaudeNativeSession> {
    contextMessage(input);
    const account = await this.claudeAccount(input.signal);
    // The checkpoint names the working folder, so a saved session never resumes in
    // another project or under another read choice.
    const workingDirectory = await this.workingFolder(input.readScope);
    const prepared = prepareClaudeSession(input, options, account, workingDirectory, CLAUDE_VERSION);
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, ...(input.signal ? [input.signal] : [])]);
    const process = await this.start(
      signal,
      prepared.args,
      30 * 60_000,
      input.instructions,
      true,
      input.readScope,
      workingDirectory,
    );
    try {
      await this.initialize(process.child);
      return new ClaudeNativeSession(
        process,
        prepared.checkpoint,
        options.onCheckpoint,
        async (signal) => {
          prepareClaudeSession(
            input,
            { ...options, restore: undefined, fork: false },
            await this.claudeAccount(signal),
            workingDirectory,
            CLAUDE_VERSION,
            prepared.checkpoint.accountDigest,
          );
        },
        controller,
      );
    } catch (error) {
      await process.close(error);
      throw error;
    }
  }
  /**
   * Where the process works. Text and selected-only turns keep the engine's own folder: a
   * turn with no file tool has no reason to sit in the project. A whole-project turn gets
   * an empty folder of its own, one per project, so no project file is inside its working
   * folder and every read asks the host (`claudePermission`). The folder is stable so a
   * native session can resume from it.
   */
  private async workingFolder(scope?: ReadScope): Promise<string> {
    if (!scope || readAccessOf(scope) !== 'project') return this.cwd;
    const folder = path.join(
      this.cwd,
      'read-folders',
      createHash('sha256').update(path.resolve(scope.root).toLowerCase()).digest('hex').slice(0, 24),
    );
    await fs.mkdir(folder, { recursive: true });
    return folder;
  }
  private async start(
    signal?: AbortSignal,
    extra: string[] = [],
    timeoutMs = 120_000,
    instructions?: string,
    persistent = false,
    scope?: ReadScope,
    cwd: string = this.cwd,
  ) {
    // The request files stay in the engine's own folder, never the project's.
    const directory = await fs.mkdtemp(path.join(this.cwd, '.claude-request-'));
    try {
      const args = claudeArguments(persistent, scope);
      if (scope && instructions !== undefined)
        instructions = `${instructions}\n\n${readScopeNote(scope)}`;
      for (const flag of ['--mcp-config', '--settings']) {
        const index = args.indexOf(flag) + 1,
          file = path.join(directory, `${flag.slice(2)}.json`);
        await fs.writeFile(file, args[index], { flag: 'wx' });
        args[index] = file;
      }
      if (instructions !== undefined) {
        const file = path.join(directory, 'instructions.txt');
        await fs.writeFile(file, instructions, { flag: 'wx' });
        args.push('--system-prompt-file', file);
      }
      const child = this.launch({
        file: this.file,
        args: [...args, ...extra],
        cwd,
        env: environment(scope),
        signal,
        timeoutMs,
      });
      return {
        child,
        close: async (primary?: unknown) => {
          let cleanup: unknown;
          try {
            await child.close(primary);
          } catch (error) {
            cleanup = error;
          }
          try {
            await fs.rm(directory, {
              recursive: true,
              force: true,
              maxRetries: 5,
              retryDelay: 100,
            });
          } catch {
            if (!cleanup) cleanup = cleanupFailed(primary);
          }
          if (cleanup) throw cleanup;
        },
      };
    } catch (error) {
      await fs.rm(directory, { recursive: true, force: true });
      throw staged(error, 'launch');
    }
  }
  private async initialize(child: EngineProcess): Promise<Record<string, unknown>> {
    const id = randomUUID();
    child.send({
      type: 'control_request',
      request_id: id,
      request: { subtype: 'initialize', hooks: null, skills: [] },
    });
    for (;;) {
      const frame = await child.next();
      if (frame.type === 'control_request')
        throw new EngineError(
          'POLICY_MISMATCH',
          'Claude Code requested a capability during initialization.',
          false,
          'local-handshake',
        );
      if (frame.type !== 'control_response') continue;
      const response = record(frame.response);
      if (response.request_id !== id) continue;
      if (response.subtype !== 'success') throw failure(response, 'local-handshake');
      return record(response.response);
    }
  }
  async inspect(signal?: AbortSignal): Promise<AdapterInspection> {
    let phase: SetupStage = 'provider-auth';
    let primary: unknown;
    try {
      const method = await this.accountMethod(signal);
      // Signed in through another kind of account: say which route this is,
      // never that the person is signed out and never what they bought.
      if (method !== 'claude.ai')
        return {
          authentication: 'unknown',
          accountRoute: null,
          models: [],
          routeIssue: {
            required: ACCOUNT_ROUTE,
            connected: (NAMEABLE_AUTH_METHODS as readonly string[]).includes(method)
              ? [method]
              : [],
          },
          detail:
            'Claude Code is signed in with an account kind this route does not accept: this route uses a Claude account sign-in, not API billing.',
        };
      phase = 'launch';
      const process = await this.start(signal, [], 15_000),
        child = process.child;
      try {
        phase = 'local-handshake';
        const init = await this.initialize(child);
        phase = 'model-list';
        const models: EngineModel[] = (Array.isArray(init.models) ? init.models : [])
          .slice(0, 80)
          .flatMap((raw) => {
            const m = record(raw);
            if (
              typeof m.value !== 'string' ||
              !/^[a-zA-Z0-9._:/-]{1,120}$/.test(m.value) ||
              m.value === 'default'
            )
              return [];
            return [
              {
                slug: m.value,
                name: typeof m.displayName === 'string' ? m.displayName.slice(0, 120) : m.value,
                description: typeof m.description === 'string' ? m.description.slice(0, 240) : '',
                efforts: [],
                defaultEffort: null,
              },
            ];
          });
        return {
          authentication: 'signed-in',
          accountRoute: ACCOUNT_ROUTE,
          models,
          detail: models.length
            ? 'Claude account connected. Choose a model for text and reviewed proposals.'
            : 'Claude Code did not report any model choices. Recheck after updating its account access.',
        };
      } catch (error) {
        primary = error;
        throw error;
      } finally {
        await process.close(primary);
      }
    } catch (error) {
      throw staged(error, phase, primary);
    }
  }
  async generate(input: TextRequest): Promise<TextResponse> {
    if (input.accountRoute !== ACCOUNT_ROUTE)
      throw new EngineError(
        'ACCOUNT_CHANGED',
        'The selected Claude account route changed. Recheck before sending.',
        false,
        'provider-auth',
      );
    // Until the answer starts arriving a failed turn is a dispatch; once the
    // response channel has produced content of its own it is a stream.
    let phase: SetupStage = 'provider-auth';
    let primary: unknown;
    try {
      const prompt = contextMessage(input);
      if ((await this.accountMethod(input.signal)) !== 'claude.ai') throw signInRequired();
      phase = 'launch';
      const scope = input.readScope;
      const workingDirectory = await this.workingFolder(scope);
      const process = await this.start(
          input.signal,
          ['--model', input.model],
          scope ? 300_000 : 120_000,
          input.instructions,
          false,
          scope,
          workingDirectory,
        ),
        child = process.child;
      let model: string | undefined;
      let nativeSession: string | undefined;
      const open = new Map<string, string>();
      let webUsed = false;
      try {
        phase = 'local-handshake';
        await this.initialize(child);
        phase = 'dispatch';
        child.send({
          type: 'user',
          session_id: '',
          parent_tool_use_id: null,
          message: { role: 'user', content: prompt },
        });
        for (;;) {
          const frame = await child.next();
          if (frame.type === 'control_request') {
            const request = record(frame.request);
            if (request.subtype !== 'can_use_tool' || typeof frame.request_id !== 'string')
              throw new EngineError(
                'POLICY_MISMATCH',
                'Claude Code requested an unapproved capability.',
                true,
                'stream',
              );
            // Answered before the tool runs: nothing it would read has been read yet.
            const answer = await claudePermission(scope, request, workingDirectory);
            child.send(claudeControlResponse(frame.request_id, answer));
            if (answer.behavior === 'deny')
              throw new EngineError(
                'POLICY_MISMATCH',
                `Claude Code ${answer.message}; the read-only request was stopped.`,
                true,
                'stream',
              );
            continue;
          }
          if (frame.type === 'system' && frame.subtype === 'init') {
            if (
              !claudeInitAllowed(scope, frame) ||
              typeof frame.model !== 'string' ||
              !sameModel(input.model, frame.model)
            )
              throw new EngineError(
                'POLICY_MISMATCH',
                'Claude Code reported different tools or a different model than requested.',
                true,
                'stream',
              );
            model = frame.model;
            nativeSession = typeof frame.session_id === 'string' ? frame.session_id : undefined;
          }
          if (frame.type === 'stream_event' && model) {
            const delta = record(record(frame.event).delta);
            if (delta.type === 'text_delta' && typeof delta.text === 'string') {
              phase = 'stream';
              input.onDelta?.(delta.text);
            }
          }
          if (frame.type === 'assistant' || frame.type === 'user') {
            if (claudeObserveTools(scope, frame, input.onToolActivity, open)) webUsed = true;
          }
          if (frame.type !== 'result') continue;
          if (frame.is_error === true || frame.subtype !== 'success')
            throw failure(frame.errors ?? frame, phase);
          if (
            !model ||
            !nativeSession ||
            frame.session_id !== nativeSession ||
            typeof frame.result !== 'string' ||
            !frame.result.trim()
          )
            throw new EngineError(
              'PROTOCOL_ERROR',
              'Claude Code did not complete an identifiable response.',
              true,
              'stream',
            );
          const used = Object.keys(record(frame.modelUsage));
          if (
            used.some(
              (value) =>
                !sameModel(input.model, value) &&
                !(scope && webUsed && claudeWebHelperModel(value)),
            )
          )
            throw new EngineError(
              'POLICY_MISMATCH',
              'Claude Code reported an unexpected model call.',
              true,
              'stream',
            );
          return {
            text: frame.result,
            model,
            version: CLAUDE_VERSION,
            projectId: input.projectId,
            threadId: input.threadId,
            requestId: input.requestId,
          };
        }
      } catch (error) {
        primary = error;
        throw error;
      } finally {
        await process.close(primary);
      }
    } catch (error) {
      throw staged(error, phase, primary);
    }
  }
}
