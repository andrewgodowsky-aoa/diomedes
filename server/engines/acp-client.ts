/**
 * The shared ACP stdio client — one implementation of the JSON-RPC 2.0
 * machinery every ACP route runs on: incremental UTF-8 decoding, newline
 * framing with byte bounds, correlated pending requests, declined
 * server-to-client requests, drained diagnostics, session/cancel on failure,
 * reply flushing before close and owned-process cleanup.
 *
 * A second ACP agent is a profile, not a second copy of this file. The
 * profile carries what genuinely differs between agents — naming, byte
 * bounds, which server-to-client requests have a decline reply, which
 * notification namespaces are the agent's own extension channel, whether
 * stdin is ended before termination and whether a failed kill is verified
 * before reporting cleanup — and the adapter keeps its launch resolution,
 * workspace preparation, authentication and session policy.
 */
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { killOwnedProcess } from '../integrations.js';
import {
  abortFailure,
  cleanupFailed,
  EngineError,
  failureKind,
  record,
  stopped,
  text,
} from './process.js';
import type { TextRequest, TextResponse } from './contract.js';
import {
  displayPath,
  emitActivity,
  insideRoot,
  isWebUrl,
  readDetail,
  readScopeNote,
  readSummary,
  type ReadScope,
} from './read-scope.js';

type Json = Record<string, unknown>;
type SpawnOptions = {
  cwd: string;
  env: NodeJS.ProcessEnv;
  shell: false;
  windowsHide: true;
  detached: boolean;
  stdio: ['pipe', 'pipe', 'pipe'];
};

/** What differs between ACP agents — everything else is this file. */
export interface AcpProfile {
  /** Display name used in error text: `Cursor`, `Devin`. */
  readonly name: string;
  /** Per-line JSON bound and the stderr diagnostics bound. */
  readonly maxJsonBytes: number;
  /** Aggregate stdout bound for the life of the process. */
  readonly maxEventBytes: number;
  /** How long a stdin write may stall before the reply is declared failed. */
  readonly replyTimeoutMs: number;
  /** The engine's JSON-RPC error mapping. */
  readonly rpcFailure: (value: unknown) => EngineError;
  /**
   * The decline-reply body for a server-to-client request method, or
   * undefined for a generic `-32601` refusal.
   */
  readonly declineResult?: (method: string, params: unknown) => unknown;
  /** What the failure message names for a method; null means a generic request. */
  readonly declineLabel?: (method: string) => string | null;
  /** The agent's own extension namespaces, ignored rather than fatal. */
  readonly ignoreNotification?: (method: string) => boolean;
  /** Whether stdin is ended before the process is terminated. */
  readonly endStdin?: boolean;
  /**
   * After a failed kill, wait this long and check the pid before reporting
   * cleanup failure — a busy process tree can die moments after the check.
   */
  readonly verifyTerminatedMs?: number;
}

export interface AcpClientOptions {
  readonly profile: AcpProfile;
  readonly command: { file: string; args: string[] };
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly launch: (
    file: string,
    args: string[],
    options: SpawnOptions,
  ) => ChildProcessWithoutNullStreams;
  readonly startupTimeoutMs: number;
  readonly signal?: AbortSignal;
  readonly onUpdate: (params: Json) => void;
  /** Defaults to the owned-process killer; tests inject a fake. */
  readonly kill?: (child: ChildProcessWithoutNullStreams) => Promise<void>;
  /**
   * A read turn's answer to a server-to-client request: the reply body when the
   * request is a permission ask for an allowed read, undefined to decline it as
   * every request is declined on the text route. It may throw to stop the turn.
   */
  readonly permit?: (method: string, params: unknown) => unknown;
}

const protocolError = (profile: AcpProfile, detail: string) =>
  new EngineError('PROTOCOL_ERROR', `${profile.name} ${detail}`, true);

/** The sentence an ACP route uses when a time limit, not a person, ended the request. */
export const acpTimeoutDetail = (profile: AcpProfile) =>
  `${profile.name} exceeded the request time limit. No retry was sent.`;

/** True while the spawned pid still resolves to a live process. */
export function stillAlive(child: ChildProcessWithoutNullStreams): boolean {
  if (child.exitCode !== null || child.signalCode !== null || child.pid === undefined)
    return false;
  try {
    process.kill(child.pid, 0);
    return true;
  } catch (error) {
    // EPERM means the pid exists but is not ours to signal: still alive.
    return record(error).code !== 'ESRCH';
  }
}

export class AcpClient {
  readonly child: ChildProcessWithoutNullStreams;
  private readonly decoder = new StringDecoder('utf8');
  private buffer = '';
  private bytes = 0;
  private nextId = 0;
  private failure?: EngineError;
  private ended = false;
  private closing = false;
  private timer: ReturnType<typeof setTimeout>;
  private pending = new Map<
    number,
    { resolve: (value: Json) => void; reject: (error: EngineError) => void }
  >();
  private replies: Promise<void>[] = [];
  sessionId?: string;
  /**
   * A deadline the host imposed is not a person pressing stop, and the abort's
   * reason says which it was. The two ACP routes reach this listener rather
   * than `EngineProcess`, so without it they would still report a connection
   * test that ran out of time as the customer's own cancellation.
   */
  private readonly abort = () =>
    this.fail(abortFailure(this.options.signal?.reason, acpTimeoutDetail(this.options.profile)));

  constructor(private readonly options: AcpClientOptions) {
    const { profile, signal } = options;
    if (signal?.aborted) throw abortFailure(signal.reason, acpTimeoutDetail(profile));
    try {
      this.child = options.launch(options.command.file, options.command.args, {
        cwd: options.cwd,
        env: options.env,
        shell: false,
        windowsHide: true,
        detached: process.platform !== 'win32',
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch {
      throw new EngineError(
        'LAUNCH_FAILED',
        `${profile.name} could not start. Recheck its installation.`,
      );
    }
    this.timer = setTimeout(
      () =>
        this.fail(
          new EngineError('TIMEOUT', `${profile.name} exceeded the startup time limit.`, true),
        ),
      options.startupTimeoutMs,
    );
    this.child.on('error', () =>
      this.fail(
        new EngineError(
          'LAUNCH_FAILED',
          `${profile.name} could not start. Recheck its installation.`,
        ),
      ),
    );
    this.child.stdin.on('error', () =>
      this.fail(
        new EngineError('PROCESS_EXITED', `${profile.name} stopped accepting requests.`, true),
      ),
    );
    this.child.stdout.on('data', (chunk: Buffer) => this.receive(chunk));
    // Never retain native diagnostics, which may contain account information.
    let stderrBytes = 0;
    this.child.stderr.on('data', (chunk: Buffer) => {
      stderrBytes += chunk.length;
      if (stderrBytes > profile.maxJsonBytes)
        this.fail(
          new EngineError(
            'OUTPUT_LIMIT',
            `${profile.name} exceeded the diagnostic byte limit.`,
            true,
          ),
        );
    });
    this.child.on('close', () => {
      this.ended = true;
      if (!this.closing)
        this.fail(protocolError(profile, 'exited before completing its response.'));
    });
    signal?.addEventListener('abort', this.abort, { once: true });
    if (signal?.aborted) this.abort();
  }

  assertActive() {
    if (this.options.signal?.aborted)
      throw abortFailure(this.options.signal.reason, acpTimeoutDetail(this.options.profile));
    if (this.failure) throw this.failure;
  }

  private fail(error: EngineError) {
    this.failure ??= error;
    for (const pending of this.pending.values()) pending.reject(this.failure);
    this.pending.clear();
  }

  private write(frame: unknown): Promise<void> {
    if (this.ended || !this.child.stdin.writable)
      return Promise.reject(protocolError(this.options.profile, 'closed its input.'));
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(protocolError(this.options.profile, 'did not accept a protocol reply.')),
        this.options.profile.replyTimeoutMs,
      );
      this.child.stdin.write(`${JSON.stringify(frame)}\n`, (error) => {
        clearTimeout(timer);
        error
          ? reject(protocolError(this.options.profile, 'did not accept a protocol reply.'))
          : resolve();
      });
    });
  }

  private decline(frame: Json) {
    const { profile } = this.options;
    const method = text(frame.method);
    const result = profile.declineResult?.(method, frame.params);
    const detail = profile.declineLabel?.(method) ?? 'an unsupported client request';
    const failure = new EngineError(
      'UNEXPECTED_TOOL',
      `${profile.name} requested ${detail}; Diomedes denied it and stopped the text request.`,
      true,
    );
    // Retain the flush promise so close cannot kill before the denial reaches stdin.
    this.replies.push(
      this.write({
        jsonrpc: '2.0',
        id: frame.id,
        ...(result
          ? { result }
          : {
              error: {
                code: -32601,
                message: 'Diomedes text route declines this client capability.',
              },
            }),
      }).catch(() => {
        this.fail(failure);
      }),
    );
    this.fail(failure);
  }

  private receive(chunk: Buffer) {
    const { profile } = this.options;
    if (this.closing) return;
    this.bytes += chunk.length;
    if (this.bytes > profile.maxEventBytes) {
      this.fail(
        new EngineError(
          'OUTPUT_LIMIT',
          `${profile.name} exceeded the response byte limit.`,
          true,
        ),
      );
      return;
    }
    this.buffer += this.decoder.write(chunk);
    let end: number;
    while ((end = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, end);
      this.buffer = this.buffer.slice(end + 1);
      if (Buffer.byteLength(line) > profile.maxJsonBytes) {
        this.fail(
          new EngineError(
            'OUTPUT_LIMIT',
            `${profile.name} exceeded the JSON event byte limit.`,
            true,
          ),
        );
        return;
      }
      if (!line.trim()) continue;
      try {
        const frame = record(JSON.parse(line));
        if (frame.jsonrpc !== '2.0')
          throw protocolError(profile, 'returned an invalid JSON-RPC envelope.');
        if (typeof frame.method === 'string' && 'id' in frame) {
          const allowed = this.failure ? undefined : this.options.permit?.(frame.method, frame.params);
          if (allowed === undefined) this.decline(frame);
          else
            this.replies.push(
              this.write({ jsonrpc: '2.0', id: frame.id, result: allowed }).catch(() =>
                this.fail(protocolError(profile, 'did not accept a protocol reply.')),
              ),
            );
          continue;
        }
        if (this.failure) continue; // Drop every late result and delta after abort/failure.
        if (typeof frame.method === 'string') {
          if (frame.method === 'session/update') this.options.onUpdate(record(frame.params));
          else if (!profile.ignoreNotification?.(frame.method))
            throw new EngineError(
              'UNEXPECTED_TOOL',
              `${profile.name} sent an unexpected capability event on the text route.`,
              true,
            );
        } else {
          const pending =
            typeof frame.id === 'number' ? this.pending.get(frame.id) : undefined;
          if (!pending || (!('result' in frame) && !('error' in frame)))
            throw protocolError(profile, 'returned an unmatched response.');
          this.pending.delete(frame.id as number);
          if ('error' in frame) {
            const error = profile.rpcFailure(frame.error);
            pending.reject(error);
            this.fail(error);
          } else {
            pending.resolve(record(frame.result));
          }
        }
      } catch (error) {
        this.fail(
          error instanceof EngineError
            ? error
            : protocolError(profile, 'returned malformed JSON or event data.'),
        );
      }
    }
    if (Buffer.byteLength(this.buffer) > profile.maxJsonBytes)
      this.fail(
        new EngineError(
          'OUTPUT_LIMIT',
          `${profile.name} exceeded the JSON event byte limit.`,
          true,
        ),
      );
  }

  async request(method: string, params: Json): Promise<Json> {
    this.assertActive();
    const id = ++this.nextId;
    const result = new Promise<Json>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
    void this.write({ jsonrpc: '2.0', id, method, params }).catch(() =>
      this.fail(protocolError(this.options.profile, 'could not accept a request.')),
    );
    const value = await result;
    this.assertActive();
    return value;
  }

  /** Rearm the process-wide timer with a phase-specific deadline and message. */
  arm(timeoutMs: number, detail: string) {
    this.assertActive();
    clearTimeout(this.timer);
    this.timer = setTimeout(
      () => this.fail(new EngineError('TIMEOUT', detail, true)),
      timeoutMs,
    );
  }

  beginTurn(timeoutMs: number) {
    this.arm(
      timeoutMs,
      `${this.options.profile.name} exceeded the request time limit. No retry was sent.`,
    );
  }

  async close(primary?: unknown) {
    const { profile } = this.options;
    clearTimeout(this.timer);
    try {
      let flushed = 0;
      while (flushed < this.replies.length) {
        const replies = this.replies.slice(flushed);
        flushed = this.replies.length;
        await Promise.all(replies);
      }
      if ((primary || this.failure) && this.sessionId && !this.ended) {
        try {
          await this.write({
            jsonrpc: '2.0',
            method: 'session/cancel',
            params: { sessionId: this.sessionId },
          });
        } catch {
          /* Process termination below is still required when stdin has closed. */
        }
      }
      this.closing = true;
      if (profile.endStdin)
        try {
          this.child.stdin.end();
        } catch {
          /* The writer may already be closed; termination below is unaffected. */
        }
      try {
        await (this.options.kill ?? killOwnedProcess)(this.child);
      } catch {
        if (profile.verifyTerminatedMs === undefined) throw cleanupFailed(primary ?? this.failure);
        // taskkill's confirm window is short for a busy process tree; the
        // process can still die moments later, so verify the owned pid is
        // actually gone before reporting a cleanup failure.
        await new Promise<void>((resolve) => setTimeout(resolve, profile.verifyTerminatedMs));
        if (stillAlive(this.child)) throw cleanupFailed(primary ?? this.failure);
      }
      // Cancellation or a blocking request during cleanup still invalidates a
      // previously completed result, including for direct adapter callers.
      if (!primary) this.assertActive();
    } finally {
      this.options.signal?.removeEventListener('abort', this.abort);
    }
  }
}

// --- the shared session orchestration ------------------------------------------------------

export interface AcpSessionOptions {
  readonly profile: AcpProfile;
  readonly launch: AcpClientOptions['launch'];
  readonly startupTimeoutMs: number;
  readonly signal?: AbortSignal;
  /** The fresh private root is made under this directory with this prefix. */
  readonly rootParent: string;
  readonly rootPrefix: string;
  /** Build the isolated workspace, environment and launch command inside the root. */
  readonly prepare: (root: string) => Promise<{
    workspace: string;
    env: NodeJS.ProcessEnv;
    command: { file: string; args: string[] };
  }>;
  readonly onUpdate: (params: Json, rpc: AcpClient) => void;
  /** Per-agent authentication between initialize and session/new. */
  readonly authenticate?: (rpc: AcpClient) => Promise<void>;
  /** Per-agent session policy after session/new (mode set and confirmation). */
  readonly ready?: (rpc: AcpClient, created: Json) => Promise<void>;
  readonly kill?: (child: ChildProcessWithoutNullStreams) => Promise<void>;
  /** A read turn's permission answers (`AcpClientOptions.permit`). */
  readonly permit?: AcpClientOptions['permit'];
}

/**
 * The session lifecycle every ACP route shares: private root, spawned client,
 * initialize handshake, optional authentication, session/new, the session id
 * bound to the client, the agent's readiness policy, then the caller's work.
 * The private root is removed in every outcome; if the process cannot be
 * confirmed stopped the root is retained rather than deleted underneath a
 * possibly live process.
 */
export async function acpSession<T>(
  options: AcpSessionOptions,
  run: (rpc: AcpClient, created: Json) => Promise<T>,
): Promise<T> {
  const root = await fs.mkdtemp(path.join(options.rootParent, options.rootPrefix));
  let rpc: AcpClient | undefined;
  let primary: unknown;
  try {
    const prepared = await options.prepare(root);
    rpc = new AcpClient({
      profile: options.profile,
      command: prepared.command,
      cwd: prepared.workspace,
      env: prepared.env,
      launch: options.launch,
      startupTimeoutMs: options.startupTimeoutMs,
      signal: options.signal,
      onUpdate: (params) => options.onUpdate(params, rpc!),
      kill: options.kill,
      permit: options.permit,
    });
    const initialized = await rpc.request('initialize', {
      protocolVersion: 1,
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false,
      },
      clientInfo: { name: 'diomedes', version: '0.1.0' },
    });
    if (initialized.protocolVersion !== 1)
      throw protocolError(options.profile, 'reported an unsupported ACP version.');
    await options.authenticate?.(rpc);
    const created = await rpc.request('session/new', {
      cwd: prepared.workspace,
      mcpServers: [],
    });
    const sessionId = text(created.sessionId);
    if (!sessionId || sessionId.length > 256)
      throw protocolError(options.profile, 'did not return a session id.');
    rpc.sessionId = sessionId;
    await options.ready?.(rpc, created);
    return await run(rpc, created);
  } catch (error) {
    primary = error;
    throw error;
  } finally {
    // If native stop is uncertain, retain the private directory rather than
    // deleting configuration from underneath a possibly live process.
    await rpc?.close(primary);
    try {
      await fs.rm(root, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 100,
      });
    } catch {
      throw cleanupFailed(primary);
    }
  }
}

// --- the shared turn choreography --------------------------------------------------------------
//
// A text turn is one choreography on every ACP route: the model-id contract,
// the session/update frame policy, the session/prompt envelope, the end_turn
// settlement and the response shape. What differs between agents is policy —
// which mode is required, how its echo arrives — carried by `AcpTurnPolicy`.

/** ACP agents report parameterized ids; only an explicit id may be attributed. */
const ACP_MODEL_ID = /^[a-zA-Z0-9][a-zA-Z0-9._:/=,\[\]-]{0,255}$/;
export const acpExplicitModel = (value: string) =>
  ACP_MODEL_ID.test(value) && !/^(auto|default)(\[|$)/.test(value);

/** The accumulating state of one in-flight turn. */
export interface AcpTurn {
  text: string;
  model: string;
  onDelta?: TextRequest['onDelta'];
  prompting: boolean;
}

/** Session updates every text route tolerates without acting on them. */
const ACP_IDLE_UPDATES = [
  'available_commands_update',
  'config_option_update',
  'current_mode_update',
  'agent_thought_chunk',
  'user_message_chunk',
  'usage_update',
  'session_info_update',
];

export interface AcpTurnPolicy {
  /**
   * A read turn's handler for `tool_call` and `tool_call_update` frames, which
   * stop a text turn. It judges and narrates each call, or throws to stop.
   * With it, the agent's own `plan` (its to-do list) is tolerated too.
   */
  readonly reads?: (update: Json) => void;
  /** A `current_mode_update` echo; the agent's mode rule decides what is legal. */
  readonly onModeUpdate?: (modeId: string) => void;
  /**
   * Extra `config_option_update` handling after the shared model scan —
   * e.g. Devin's ask-mode confirmation arriving as a config option.
   */
  readonly onConfigUpdate?: (options: Json[]) => void;
}

/**
 * One `session/update` frame against the running turn. Shared policy: tool,
 * plan and non-text frames stop the request; a mismatched session id or an
 * update outside the tolerated list is a protocol fault; text chunks append
 * only inside a prompted turn; a model-selection drift is validated and then
 * attributed. The agent's own rules live in `policy`.
 */
export function acpSessionUpdate(
  profile: AcpProfile,
  rpc: AcpClient,
  params: Json,
  turn: AcpTurn | undefined,
  policy: AcpTurnPolicy,
): void {
  const update = record(params.update),
    kind = text(update.sessionUpdate);
  if (policy.reads && (kind === 'tool_call' || kind === 'tool_call_update' || kind === 'plan')) {
    if (rpc.sessionId && params.sessionId !== rpc.sessionId)
      throw protocolError(profile, 'reported a different session.');
    if (kind !== 'plan') policy.reads(update);
    return;
  }
  if (kind === 'tool_call' || kind === 'tool_call_update' || kind === 'plan')
    throw new EngineError(
      'UNEXPECTED_TOOL',
      `${profile.name} reported ${kind} on the text route; the request was stopped.`,
      true,
    );
  if (rpc.sessionId && params.sessionId !== rpc.sessionId)
    throw protocolError(profile, 'reported a different session.');
  if (kind === 'current_mode_update') policy.onModeUpdate?.(text(update.currentModeId));
  if (kind === 'agent_message_chunk') {
    if (!turn?.prompting || !rpc.sessionId)
      throw protocolError(profile, 'returned text outside the requested turn.');
    const content = record(update.content);
    if (content.type !== 'text' || typeof content.text !== 'string')
      throw protocolError(profile, 'returned non-text output.');
    turn.text += content.text;
    turn.onDelta?.(content.text);
  } else if (!ACP_IDLE_UPDATES.includes(kind)) {
    throw protocolError(profile, 'returned an unsupported session update.');
  }
  if (kind === 'config_option_update' && Array.isArray(update.configOptions)) {
    const options = update.configOptions.map(record);
    const model = options.find(
      (option) => option.category === 'model' || option.id === 'model',
    );
    if (turn && model) {
      if (!acpExplicitModel(text(model.currentValue)))
        throw protocolError(profile, 'reported an invalid model selection.');
      turn.model = text(model.currentValue);
    }
    policy.onConfigUpdate?.(options);
  }
}

/**
 * The one prompt a text turn sends: the shared instructions+input envelope,
 * the request deadline armed as the turn starts, settlement only on
 * `end_turn` with real text. `prompt` is the caller's `contextMessage`
 * output — prepared before the session exists, since the context bound is a
 * request-validation error, not a protocol one. Cancellation rides the
 * client's session/cancel on failure path — a stopped turn is never resent.
 */
export async function acpPromptTurn(
  profile: AcpProfile,
  rpc: AcpClient,
  input: TextRequest,
  turn: AcpTurn,
  requestTimeoutMs: number,
  prompt: string,
): Promise<void> {
  rpc.beginTurn(requestTimeoutMs);
  turn.prompting = true;
  const result = await rpc.request('session/prompt', {
    sessionId: rpc.sessionId,
    prompt: [
      {
        type: 'text',
        text: JSON.stringify({
          instructions: input.readScope
            ? `${input.instructions}

${readScopeNote(input.readScope)}`
            : input.instructions,
          input: JSON.parse(prompt),
        }),
      },
    ],
  });
  rpc.assertActive();
  if (result.stopReason !== 'end_turn' || !turn.text.trim())
    throw protocolError(profile, 'did not complete a text turn.');
}

/** The settled turn's response: the attributed text under the request's identity. */
export const acpTurnResponse = (
  input: TextRequest,
  turn: AcpTurn,
  version: string,
): TextResponse => ({
  text: turn.text,
  model: turn.model,
  version,
  projectId: input.projectId,
  threadId: input.threadId,
  requestId: input.requestId,
});

// --- read turns ---------------------------------------------------------------------------------
//
// ACP names what a tool call does with a `kind`. A read turn accepts `fetch`
// (with web access) and `think`, which touches nothing; `read`, `search`,
// `edit`, `delete`, `move`, `execute`, `switch_mode` and `other` stop it. The
// same rule answers the agent's permission asks: an allowed call gets
// `allow_once`, anything else is rejected and stops the turn.

// Security pass 2026-09-23: no ACP route has a way for Diomedes to answer a file read
// before it runs (Cursor runs allowed reads without asking), so a read turn is given no
// file tool and a `read` or `search` call stops it like any other kind. The documents
// the person chose travel inline in the prompt.
const ACP_READ_KINDS = ['fetch', 'think'];
const PATH_KEYS = ['path', 'file_path', 'filePath', 'target_file', 'targetFile', 'directory'];

/** The read handler and permission answer for one ACP read turn. */
export function acpReadTurn(
  profile: AcpProfile,
  scope: ReadScope,
  sink: TextRequest['onToolActivity'],
): { reads: (update: Json) => void; permit: (method: string, params: unknown) => unknown } {
  const calls = new Map<string, { kind: string; started: boolean; finished: boolean }>();
  const refuse = (why: string) =>
    new EngineError(
      'UNEXPECTED_TOOL',
      `${profile.name} ${why}; Diomedes stopped the read-only request.`,
      true,
    );
  /** Judge one call's kind and paths; returns the kind it resolved to. */
  const judge = (call: Json): { id: string; kind: string } => {
    const id = text(call.toolCallId);
    if (!id || id.length > 200) throw protocolError(profile, 'reported a tool call without an id.');
    const known = calls.get(id);
    const kind = text(call.kind) || known?.kind || '';
    if (!ACP_READ_KINDS.includes(kind)) throw refuse(`reported a ${kind || 'unnamed'} tool call`);
    if (kind === 'fetch' && !scope.web) throw refuse('tried to reach the web without web access');
    const locations = Array.isArray(call.locations) ? call.locations.map(record) : [];
    const input = record(call.rawInput);
    const paths = [
      ...locations.map((location) => text(location.path)),
      ...PATH_KEYS.map((key) => text(input[key])),
    ].filter(Boolean);
    if (kind !== 'fetch' && paths.some((candidate) => !insideRoot(scope.root, candidate)))
      throw refuse('tried to read outside the project folder');
    if (kind === 'fetch' && text(input.url) && !isWebUrl(text(input.url)))
      throw refuse('tried to open something that is not a web page');
    return { id, kind };
  };
  const summaryOf = (call: Json, kind: string) => {
    const input = record(call.rawInput);
    const location = Array.isArray(call.locations) ? text(record(call.locations[0]).path) : '';
    const where =
      location || PATH_KEYS.map((key) => text(input[key])).find(Boolean) || '';
    if (kind === 'read')
      return readSummary('read', { path: where ? displayPath(scope.root, where) : undefined });
    if (kind === 'search')
      return (
        text(call.title).slice(0, 200) ||
        readSummary('search', { query: text(input.query) || text(input.pattern) || undefined })
      );
    return isWebUrl(text(input.url))
      ? readSummary('web-fetch', { url: text(input.url) })
      : readSummary('web-search', { query: text(input.query) || undefined });
  };
  const reads = (update: Json) => {
    const { id, kind } = judge(update);
    const entry = calls.get(id) ?? { kind, started: false, finished: false };
    entry.kind = kind;
    calls.set(id, entry);
    if (kind === 'think') return;
    if (!entry.started) {
      entry.started = true;
      const detail = readDetail(update.rawInput);
      emitActivity(sink, {
        callId: id,
        phase: 'started',
        tool: kind,
        summary: summaryOf(update, kind),
        ...(detail ? { detail } : {}),
      });
    }
    const status = text(update.status);
    if ((status === 'completed' || status === 'failed') && !entry.finished) {
      entry.finished = true;
      const detail = readDetail(update.rawOutput, 300);
      emitActivity(sink, {
        callId: id,
        phase: status === 'failed' ? 'failed' : 'finished',
        tool: kind,
        summary: status === 'failed' ? 'The read did not complete' : 'Read finished',
        ...(detail ? { detail } : {}),
      });
    }
  };
  const permit = (method: string, params: unknown) => {
    if (method !== 'session/request_permission') return undefined;
    const call = record(record(params).toolCall);
    try {
      judge(call);
    } catch {
      return undefined;
    }
    const options = record(params).options;
    const allow = Array.isArray(options)
      ? options
          .map(record)
          .find((option) => option.kind === 'allow_once' && typeof option.optionId === 'string')
      : undefined;
    return allow ? { outcome: { outcome: 'selected', optionId: allow.optionId } } : undefined;
  };
  return { reads, permit };
}

// --- the known ACP agents --------------------------------------------------------------------

/** A permission-ask decline reply: pick a reject option when the agent offers one. */
const rejectOutcome = (params: unknown) => {
  const options = record(params).options;
  const reject = Array.isArray(options)
    ? options
        .map(record)
        .find(
          (option) =>
            (option.kind === 'reject_once' || option.kind === 'reject_always') &&
            typeof option.optionId === 'string',
        )
    : undefined;
  return {
    outcome: reject
      ? { outcome: 'selected', optionId: reject.optionId }
      : { outcome: 'cancelled' },
  };
};

const acpRpcFailure =
  (
    name: string,
    authDetail: string,
  ): ((value: unknown) => EngineError) =>
  (value) => {
    const error = record(value);
    // -32000 is the agent's own "this host has not authenticated" code, which
    // is a field it set rather than a word found in a sentence. Everything
    // else is read from the payload's named fields: `auth` is a substring of
    // `authority`, so matching the message for it answered "unable to verify
    // the certificate authority for the configured proxy" with sign-in advice.
    if (error.code === -32000) return new EngineError('AUTH_REQUIRED', authDetail, true);
    const kind = failureKind({ code: error.code, message: text(error.message) });
    if (kind === 'limited')
      return new EngineError(
        'USAGE_LIMIT',
        `${name} reported a service limit. No model or account was substituted.`,
        true,
      );
    if (kind === 'denied') return new EngineError('AUTH_REQUIRED', authDetail, true);
    return new EngineError(
      'PROVIDER_ERROR',
      `${name} could not complete the ACP request. No automatic retry was sent.`,
      true,
    );
  };

const ACP_JSON_BYTES = 512 * 1024;
const ACP_EVENT_BYTES = 4 * 1024 * 1024;

/**
 * Cursor 2026.08.11: permission asks, interactive questions and plan
 * proposals each get their own decline body; every other client request gets
 * the generic refusal. No extension channel — an unexpected notification is
 * fatal. Process termination goes straight to the owned-process killer.
 */
export const CURSOR_ACP_PROFILE: AcpProfile = {
  name: 'Cursor',
  maxJsonBytes: ACP_JSON_BYTES,
  maxEventBytes: ACP_EVENT_BYTES,
  replyTimeoutMs: 1000,
  rpcFailure: acpRpcFailure(
    'Cursor',
    'Cursor needs native sign-in. Run agent login, then recheck.',
  ),
  declineResult: (method, params) => {
    if (method === 'session/request_permission') return rejectOutcome(params);
    if (method === 'cursor/ask_question')
      return {
        outcome: {
          outcome: 'skipped',
          reason: 'Diomedes text route declines interactive questions.',
        },
      };
    if (method === 'cursor/create_plan')
      return {
        outcome: {
          outcome: 'rejected',
          reason: 'Diomedes text route does not authorize plans.',
        },
      };
    return undefined;
  },
  declineLabel: (method) =>
    ['session/request_permission', 'cursor/ask_question', 'cursor/create_plan'].includes(method)
      ? method
      : null,
};

/**
 * Devin 3000.10.23: only permission asks get a decline body. The agent's own
 * `_cognition.ai/*` and `devin/*` extension channel is observed and ignored.
 * stdin is ended before termination, and a failed kill is verified against
 * the pid before cleanup failure is reported — taskkill's confirm window is
 * short for a busy process tree.
 */
export const DEVIN_ACP_PROFILE: AcpProfile = {
  name: 'Devin',
  maxJsonBytes: ACP_JSON_BYTES,
  maxEventBytes: ACP_EVENT_BYTES,
  replyTimeoutMs: 1000,
  rpcFailure: acpRpcFailure(
    'Devin',
    'Devin sign-in did not complete. Use Sign in to open the Devin browser flow, then recheck.',
  ),
  declineResult: (method, params) =>
    method === 'session/request_permission' ? rejectOutcome(params) : undefined,
  declineLabel: (method) => (method === 'session/request_permission' ? method : null),
  ignoreNotification: (method) => /^(_?cognition\.ai|devin)[/.]/.test(method),
  endStdin: true,
  verifyTerminatedMs: 1500,
};
