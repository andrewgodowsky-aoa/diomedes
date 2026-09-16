/**
 * Devin 3000.10.23 (deb81600), probed on 2026-09-13.
 * devin.exe --version, --help and acp --help were run.
 * Exact exchanges observed over devin.exe acp stdio:
 * initialize -> {"protocolVersion":1,"agentCapabilities":{"loadSession":true,
 *   "promptCapabilities":{"image":true,"audio":false,"embeddedContext":true},
 *   "mcpCapabilities":{"http":false,"sse":false},
 *   "sessionCapabilities":{"list":{},"delete":{},"additionalDirectories":{}},
 *   "auth":{}},"authMethods":[{"id":"devin-browser","name":"Log in with
 *   browser"}],"agentInfo":{"name":"affogato","title":"Devin Agent",
 *   "version":"0.0.0-dev"}}
 * session/new before authenticate -> error -32000: "ACP host has not
 *   authenticated. Call the `authenticate` ACP method with `meta.api_key` set
 *   to the user's API key (or invoke the browser auth method to start the PKCE
 *   browser flow) before opening a session. Local CLI credentials are
 *   intentionally not used in ACP mode to avoid attributing usage to the wrong
 *   account."
 * authenticate {"methodId":"devin-browser"} -> PKCE browser flow -> {} on
 *   success. {"methodId":"devin-browser","_meta":{"api_key":...}} validates a
 *   Devin API key instead; an invalid key fails with -32603. The
 *   WINDSURF_API_KEY environment variable is not read by the ACP server.
 * session/new -> {"sessionId":"goldenrod-sorrel","modes":{"currentModeId":
 *   "accept-edits","availableModes":[{"id":"accept-edits","name":"Code"},
 *   {"id":"smart"},{"id":"ask"},{"id":"plan"},{"id":"bypass"}]},
 *   "configOptions":[{"id":"model","category":"model","type":"select",
 *   "currentValue":"swe-2-high","options":[{"value":"swe-2-high",
 *   "name":"SWE-2 High"}, ...420 options]}]}
 * session/set_mode {"modeId":"ask"} -> {} and a current_mode_update
 *   notification; the echo can land before or after the reply, and the
 *   session's startup mode echo can lag behind set_mode entirely. The default
 *   mode is accept-edits, so the mode is always set and confirmed.
 * The agent emits _cognition.ai/* extension notifications alongside
 *   session/update frames; they are observed and ignored. Session set-up emits
 *   config_option_update, current_mode_update and available_commands_update.
 * The installed user mcp_config.json is loaded at server start and no flag
 *   suppresses it, so the workspace project configuration denies mcp__* tools
 *   instead; the processes themselves still launch under the user account.
 * acp --model pins the session model at launch; DEVIN_REFUSAL_FALLBACK is never
 *   set, so no substitute model can be selected on refusal.
 * Client filesystem/terminal capabilities are false, the session is set to ask
 *   mode, the project configuration denies every documented tool scope,
 *   blocking client requests are declined and any tool update aborts the turn.
 *   These controls do not constitute OS containment or proof of unseen effects.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import type { EngineModel } from '../../shared/types.js';
import { killOwnedProcess } from '../integrations.js';
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
  record,
  stopped,
  text,
} from './process.js';

export const DEVIN_VERSION = '3000.10.23';
export const DEVIN_ACCOUNT_ROUTE = 'devin:devin-account';
const MAX_JSON_BYTES = 512 * 1024;
const MAX_EVENT_BYTES = 4 * 1024 * 1024;
const STARTUP_TIMEOUT_MS = 30_000;
const AUTH_TIMEOUT_MS = 120_000;
const REQUEST_TIMEOUT_MS = 120_000;
// The set_mode reply carries no state; the mode echo is the only confirmation
// and can land before or after the reply on the same stream.
const MODE_CONFIRM_MS = 5_000;
// Devin reports parameterized IDs such as swe-2-high; the same contract as
// every ACP route: only an explicit runtime-reported ID may be attributed.
const MODEL_ID = /^[a-zA-Z0-9][a-zA-Z0-9._:/=,\[\]-]{0,255}$/;
const explicitModel = (value: string) =>
  MODEL_ID.test(value) && !/^(auto|default)(\[|$)/.test(value);
type Json = Record<string, unknown>;
type DevinTurn = {
  text: string;
  model: string;
  onDelta?: TextRequest['onDelta'];
  prompting: boolean;
};
type SpawnOptions = Parameters<typeof spawn>[2];
export interface DevinAdapterDeps {
  spawn?: (file: string, args: string[], options: SpawnOptions) => ChildProcessWithoutNullStreams;
  capture?: typeof capture;
  startupTimeoutMs?: number;
  authTimeoutMs?: number;
  requestTimeoutMs?: number;
}
const protocolError = (detail: string) =>
  new EngineError('PROTOCOL_ERROR', `Devin ${detail}`, true);

/** Resolve only the installed layout, never execute or interpret launcher text. */
export async function resolveDevinEntry(file: string): Promise<string> {
  if (!/\.(cmd|bat|ps1)$/i.test(file)) return file;
  if (!/^devin\.(cmd|bat|ps1)$/i.test(path.basename(file)))
    throw new EngineError('UNSUPPORTED_SHIM', 'Select the installed Devin CLI executable.');
  const entry = path.join(path.dirname(file), 'devin.exe');
  try {
    await fs.access(entry);
    return entry;
  } catch (error) {
    if (record(error).code === 'ENOENT')
      throw new EngineError('UNSUPPORTED_SHIM', 'Select the installed Devin CLI executable.');
    throw error;
  }
}

export function devinCommand(file: string, args: string[]): { file: string; args: string[] } {
  if (!/\.exe$/i.test(file))
    throw new EngineError('UNSUPPORTED_SHIM', 'Select the installed Devin CLI executable.');
  return { file, args };
}

function rpcFailure(value: unknown): EngineError {
  const error = record(value);
  if (error.code === -32000 || /auth|sign.?in|login/i.test(text(error.message)))
    return new EngineError(
      'AUTH_REQUIRED',
      'Devin sign-in did not complete. Use Sign in to open the Devin browser flow, then recheck.',
      true,
    );
  if (/rate.?limit|quota|usage.?limit/i.test(text(error.message)))
    return new EngineError(
      'USAGE_LIMIT',
      'Devin reported a service limit. No model or account was substituted.',
      true,
    );
  return new EngineError(
    'PROVIDER_ERROR',
    'Devin could not complete the ACP request. No automatic retry was sent.',
    true,
  );
}

/** True while the spawned pid still resolves to a live process. */
function stillAlive(child: ChildProcessWithoutNullStreams): boolean {
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

class DevinAcp {
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
  /** The mode Devin reported when the session was created, before ask is set. */
  initialMode?: string;
  /** Devin confirmed ask through its own mode echo, which precedes the reply. */
  askConfirmed = false;
  private readonly abort = () => this.fail(stopped());

  constructor(
    command: { file: string; args: string[] },
    cwd: string,
    env: NodeJS.ProcessEnv,
    launch: NonNullable<DevinAdapterDeps['spawn']>,
    timeout: number,
    private readonly authTimeout: number,
    private readonly signal: AbortSignal | undefined,
    private readonly update: (params: Json) => void,
  ) {
    if (signal?.aborted) throw stopped();
    try {
      this.child = launch(command.file, command.args, {
        cwd,
        env,
        shell: false,
        windowsHide: true,
        detached: process.platform !== 'win32',
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch {
      throw new EngineError('LAUNCH_FAILED', 'Devin could not start. Recheck its installation.');
    }
    this.timer = setTimeout(
      () => this.fail(new EngineError('TIMEOUT', 'Devin exceeded the startup time limit.', true)),
      timeout,
    );
    this.child.on('error', () =>
      this.fail(
        new EngineError('LAUNCH_FAILED', 'Devin could not start. Recheck its installation.'),
      ),
    );
    this.child.stdin.on('error', () =>
      this.fail(new EngineError('PROCESS_EXITED', 'Devin stopped accepting requests.', true)),
    );
    this.child.stdout.on('data', (chunk: Buffer) => this.receive(chunk));
    // Never retain native diagnostics, which may contain account information.
    let stderrBytes = 0;
    this.child.stderr.on('data', (chunk: Buffer) => {
      stderrBytes += chunk.length;
      if (stderrBytes > MAX_JSON_BYTES)
        this.fail(
          new EngineError('OUTPUT_LIMIT', 'Devin exceeded the diagnostic byte limit.', true),
        );
    });
    this.child.on('close', () => {
      this.ended = true;
      if (!this.closing) this.fail(protocolError('exited before completing its response.'));
    });
    signal?.addEventListener('abort', this.abort, { once: true });
    if (signal?.aborted) this.abort();
  }
  assertActive() {
    if (this.signal?.aborted) throw stopped();
    if (this.failure) throw this.failure;
  }
  private fail(error: EngineError) {
    this.failure ??= error;
    for (const pending of this.pending.values()) pending.reject(this.failure);
    this.pending.clear();
  }
  private arm(timeout: number, detail: string) {
    clearTimeout(this.timer);
    this.timer = setTimeout(
      () => this.fail(new EngineError('TIMEOUT', detail, true)),
      timeout,
    );
  }
  private write(frame: unknown): Promise<void> {
    if (this.ended || !this.child.stdin.writable)
      return Promise.reject(protocolError('closed its input.'));
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(protocolError('did not accept a protocol reply.')),
        1000,
      );
      this.child.stdin.write(`${JSON.stringify(frame)}\n`, (error) => {
        clearTimeout(timer);
        error ? reject(protocolError('did not accept a protocol reply.')) : resolve();
      });
    });
  }
  private decline(frame: Json) {
    const method = text(frame.method);
    let result: unknown;
    if (method === 'session/request_permission') {
      const options = record(frame.params).options;
      const reject = Array.isArray(options)
        ? options
            .map(record)
            .find(
              (option) =>
                (option.kind === 'reject_once' || option.kind === 'reject_always') &&
                typeof option.optionId === 'string',
            )
        : undefined;
      result = {
        outcome: reject
          ? { outcome: 'selected', optionId: reject.optionId }
          : { outcome: 'cancelled' },
      };
    }
    const failure = new EngineError(
      'UNEXPECTED_TOOL',
      `Devin requested ${
        method === 'session/request_permission' ? method : 'an unsupported client request'
      }; Diomedes denied it and stopped the text request.`,
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
    if (this.closing) return;
    this.bytes += chunk.length;
    if (this.bytes > MAX_EVENT_BYTES) {
      this.fail(new EngineError('OUTPUT_LIMIT', 'Devin exceeded the response byte limit.', true));
      return;
    }
    this.buffer += this.decoder.write(chunk);
    let end: number;
    while ((end = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, end);
      this.buffer = this.buffer.slice(end + 1);
      if (Buffer.byteLength(line) > MAX_JSON_BYTES) {
        this.fail(
          new EngineError('OUTPUT_LIMIT', 'Devin exceeded the JSON event byte limit.', true),
        );
        return;
      }
      if (!line.trim()) continue;
      try {
        const frame = record(JSON.parse(line));
        if (frame.jsonrpc !== '2.0') throw protocolError('returned an invalid JSON-RPC envelope.');
        if (typeof frame.method === 'string' && 'id' in frame) {
          this.decline(frame);
          continue;
        }
        if (this.failure) continue; // Drop every late result and delta after abort/failure.
        if (typeof frame.method === 'string') {
          if (frame.method === 'session/update') {
            this.update(record(frame.params));
          } else if (!/^(_?cognition\.ai|devin)[/.]/.test(frame.method)) {
            // Devin emits its own extension channel (observed: _cognition.ai/*);
            // extension notifications carry no effect and are ignored.
            throw new EngineError(
              'UNEXPECTED_TOOL',
              'Devin sent an unexpected capability event on the text route.',
              true,
            );
          }
        } else {
          const pending = typeof frame.id === 'number' ? this.pending.get(frame.id) : undefined;
          if (!pending || (!('result' in frame) && !('error' in frame)))
            throw protocolError('returned an unmatched response.');
          this.pending.delete(frame.id as number);
          if ('error' in frame) {
            const error = rpcFailure(frame.error);
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
            : protocolError('returned malformed JSON or event data.'),
        );
      }
    }
    if (Buffer.byteLength(this.buffer) > MAX_JSON_BYTES)
      this.fail(
        new EngineError('OUTPUT_LIMIT', 'Devin exceeded the JSON event byte limit.', true),
      );
  }
  async request(method: string, params: Json): Promise<Json> {
    this.assertActive();
    const id = ++this.nextId;
    const result = new Promise<Json>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
    void this.write({ jsonrpc: '2.0', id, method, params }).catch(() =>
      this.fail(protocolError('could not accept a request.')),
    );
    const value = await result;
    this.assertActive();
    return value;
  }
  /** The browser flow may wait on a person; it gets a wider window than start-up. */
  beginAuth() {
    this.assertActive();
    this.arm(
      this.authTimeout,
      'Devin browser sign-in did not complete. Close this attempt and try signing in again.',
    );
  }
  beginTurn(timeout: number) {
    this.assertActive();
    this.arm(timeout, 'Devin exceeded the request time limit. No retry was sent.');
  }
  async close(primary?: unknown) {
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
      try {
        this.child.stdin.end();
      } catch {
        /* The writer may already be closed; termination below is unaffected. */
      }
      try {
        await killOwnedProcess(this.child);
      } catch {
        // taskkill's confirm window is short for a busy process tree; the
        // process can still die moments later, so verify the owned pid is
        // actually gone before reporting a cleanup failure.
        await new Promise<void>((resolve) => setTimeout(resolve, 1500));
        if (stillAlive(this.child)) throw cleanupFailed(primary ?? this.failure);
      }
      // Cancellation or a blocking request during cleanup still invalidates a
      // previously completed result, including for direct adapter callers.
      if (!primary) this.assertActive();
    } finally {
      this.signal?.removeEventListener('abort', this.abort);
    }
  }
}

/** The model select option list Devin reports inside configOptions. */
function modelConfig(created: Json): Json | undefined {
  return (Array.isArray(created.configOptions) ? created.configOptions : [])
    .map(record)
    .find((option) => option.category === 'model' || option.id === 'model');
}
function modelsFrom(created: Json): EngineModel[] {
  const choices = modelConfig(created)?.options;
  if (!Array.isArray(choices)) return [];
  return choices.slice(0, 512).flatMap((value) => {
    const row = record(value),
      id = text(row.value);
    if (!explicitModel(id)) return [];
    return [
      {
        slug: id,
        name: text(row.name).slice(0, 120) || id,
        description: '',
        efforts: [],
        defaultEffort: null,
      },
    ];
  });
}

export class DevinAdapter implements TextEngineAdapter {
  readonly id = 'devin' as const;
  private readonly launch: NonNullable<DevinAdapterDeps['spawn']>;
  private readonly capture: typeof capture;
  private readonly startupTimeout: number;
  private readonly authTimeout: number;
  private readonly requestTimeout: number;
  constructor(
    private readonly file: string,
    private readonly cwd: string,
    deps: DevinAdapterDeps = {},
  ) {
    this.launch =
      deps.spawn ??
      ((file, args, options) => spawn(file, args, options) as ChildProcessWithoutNullStreams);
    this.capture = deps.capture ?? capture;
    this.startupTimeout = deps.startupTimeoutMs ?? STARTUP_TIMEOUT_MS;
    this.authTimeout = deps.authTimeoutMs ?? AUTH_TIMEOUT_MS;
    this.requestTimeout = deps.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;
  }
  private async withSession<T>(
    signal: AbortSignal | undefined,
    run: (rpc: DevinAcp, created: Json, version: string) => Promise<T>,
    turn?: DevinTurn,
    model?: string,
  ): Promise<T> {
    if (signal?.aborted) throw stopped();
    const entry = await resolveDevinEntry(this.file);
    const versionResult = await this.capture({
      ...devinCommand(entry, ['--version']),
      cwd: this.cwd,
      env: engineEnvironment(),
      signal,
      timeoutMs: this.startupTimeout,
      maxBytes: 4096,
    });
    const version = versionResult.stdout.trim().match(/\bdevin\s+(\d+\.\d+\.\d+)\b/i)?.[1];
    if (versionResult.code !== 0 || version !== DEVIN_VERSION)
      throw new EngineError(
        'UNSUPPORTED_VERSION',
        'Devin changed version. Review compatibility before sending.',
      );
    const root = await fs.mkdtemp(path.join(this.cwd, '.diomedes-devin-'));
    let rpc: DevinAcp | undefined;
    let primary: unknown;
    try {
      const workspace = path.join(root, 'workspace');
      // Devin has no configuration-directory override; the session workspace is
      // fresh, carries deny rules for every documented tool scope, and nothing
      // is copied from the person's Devin configuration. The user-scope
      // mcp_config.json still loads at server start; its tools are denied here.
      await fs.mkdir(path.join(workspace, '.devin'), { recursive: true });
      await fs.writeFile(
        path.join(workspace, '.devin', 'config.json'),
        JSON.stringify({
          permissions: {
            allow: [],
            deny: [
              'Read(**)',
              'Write(**)',
              'Fetch(http://*)',
              'Fetch(https://*)',
              'read',
              'edit',
              'grep',
              'glob',
              'exec',
              'mcp__*',
            ],
          },
        }),
        { flag: 'wx' },
      );
      rpc = new DevinAcp(
        devinCommand(entry, model ? ['acp', '--model', model] : ['acp']),
        workspace,
        engineEnvironment(),
        this.launch,
        this.startupTimeout,
        this.authTimeout,
        signal,
        (params) => this.onUpdate(rpc!, params, turn),
      );
      const initialized = await rpc.request('initialize', {
        protocolVersion: 1,
        clientCapabilities: {
          fs: { readTextFile: false, writeTextFile: false },
          terminal: false,
        },
        clientInfo: { name: 'diomedes', version: '0.1.0' },
      });
      if (initialized.protocolVersion !== 1)
        throw protocolError('reported an unsupported ACP version.');
      // ACP never reuses the native CLI credential, so every process
      // authenticates its own host before a session can be opened.
      rpc.beginAuth();
      await rpc.request('authenticate', { methodId: 'devin-browser' });
      const created = await rpc.request('session/new', {
        cwd: workspace,
        mcpServers: [],
      });
      const sessionId = text(created.sessionId);
      if (!sessionId || sessionId.length > 256)
        throw protocolError('did not return a session id.');
      rpc.sessionId = sessionId;
      rpc.initialMode ??= text(record(created.modes).currentModeId) || undefined;
      const offered = Array.isArray(record(created.modes).availableModes)
        ? (record(created.modes).availableModes as unknown[]).map((mode) => text(record(mode).id))
        : [];
      if (!offered.includes('ask'))
        throw new EngineError(
          'POLICY_MISMATCH',
          'Devin did not offer the required ask mode.',
          true,
        );
      await rpc.request('session/set_mode', { sessionId, modeId: 'ask' });
      const confirmBy = Date.now() + MODE_CONFIRM_MS;
      while (!rpc.askConfirmed) {
        rpc.assertActive();
        if (Date.now() >= confirmBy)
          throw new EngineError(
            'POLICY_MISMATCH',
            'Devin did not confirm the required ask mode.',
            true,
          );
        await new Promise<void>((resolve) => setTimeout(resolve, 50));
      }
      return await run(rpc, created, version);
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
  private onUpdate(rpc: DevinAcp, params: Json, turn?: DevinTurn) {
    const update = record(params.update),
      kind = text(update.sessionUpdate);
    if (kind === 'tool_call' || kind === 'tool_call_update' || kind === 'plan')
      throw new EngineError(
        'UNEXPECTED_TOOL',
        `Devin reported ${kind} on the text route; the request was stopped.`,
        true,
      );
    if (rpc.sessionId && params.sessionId !== rpc.sessionId)
      throw protocolError('reported a different session.');
    if (kind === 'current_mode_update') {
      const mode = text(update.currentModeId);
      if (mode === 'ask') rpc.askConfirmed = true;
      else {
        // The first non-ask echo is the session's startup mode, which can be
        // announced at any point before ask is confirmed. Anything else, and
        // any change once ask is confirmed, is a real mode change.
        if (mode && !rpc.initialMode) rpc.initialMode = mode;
        if (mode !== rpc.initialMode || rpc.askConfirmed)
          throw new EngineError(
            'POLICY_MISMATCH',
            `Devin reported ${mode || 'an unknown'} mode on the text route; the request was stopped.`,
            true,
          );
      }
    }
    if (kind === 'agent_message_chunk') {
      if (!turn?.prompting || !rpc.sessionId)
        throw protocolError('returned text outside the requested turn.');
      const content = record(update.content);
      if (content.type !== 'text' || typeof content.text !== 'string')
        throw protocolError('returned non-text output.');
      turn.text += content.text;
      turn.onDelta?.(content.text);
    } else if (
      ![
        'available_commands_update',
        'config_option_update',
        'current_mode_update',
        'agent_thought_chunk',
        'user_message_chunk',
        'usage_update',
        'session_info_update',
      ].includes(kind)
    ) {
      throw protocolError('returned an unsupported session update.');
    }
    if (kind === 'config_option_update' && Array.isArray(update.configOptions)) {
      const options = update.configOptions.map(record);
      const mode = options.find((option) => option.category === 'mode' || option.id === 'mode');
      if (mode && text(mode.currentValue) === 'ask') rpc.askConfirmed = true;
      const model = options.find((option) => option.category === 'model' || option.id === 'model');
      if (turn && model) {
        if (!explicitModel(text(model.currentValue)))
          throw protocolError('reported an invalid model selection.');
        turn.model = text(model.currentValue);
      }
    }
  }
  private generating = false;
  async inspect(signal?: AbortSignal): Promise<AdapterInspection> {
    try {
      return await this.withSession(signal, async (_rpc, created) => {
        const models = modelsFrom(created);
        return {
          authentication: 'signed-in' as const,
          accountRoute: DEVIN_ACCOUNT_ROUTE,
          models,
          detail: models.length
            ? 'Devin account connected for bounded ACP text requests. Sign-in is confirmed through the Devin browser flow on each request; tool events stop the request; OS containment is unsupported.'
            : 'Devin did not report explicit model choices.',
        };
      });
    } catch (error) {
      if (error instanceof EngineError && error.code === 'AUTH_REQUIRED')
        return {
          authentication: 'signed-out',
          accountRoute: null,
          models: [],
          detail: 'Sign in through the Devin browser flow, then recheck.',
        };
      throw error;
    }
  }
  async generate(input: TextRequest): Promise<TextResponse> {
    if (input.accountRoute !== DEVIN_ACCOUNT_ROUTE)
      throw new EngineError(
        'ACCOUNT_CHANGED',
        'Select the Devin account route before sending.',
      );
    if (!explicitModel(input.model))
      throw new EngineError('MODEL_UNAVAILABLE', 'Choose an explicit Devin model.');
    const prompt = contextMessage(input);
    if (this.generating)
      throw new EngineError('REQUEST_ACTIVE', 'Devin already has a request in progress.');
    this.generating = true;
    const turn: DevinTurn = {
      text: '',
      model: input.model,
      onDelta: input.onDelta,
      prompting: false,
    };
    try {
      return await this.withSession(
        input.signal,
        async (rpc, created, version) => {
          if (!modelsFrom(created).some((model) => model.slug === input.model))
            throw new EngineError(
              'MODEL_UNAVAILABLE',
              'Devin no longer offers the requested model. No substitute was selected.',
            );
          // --model pins the session at launch; the reported selection is the
          // attribution, and drift is never silently accepted.
          const selected = text(modelConfig(created)?.currentValue);
          if (selected && selected !== input.model)
            throw new EngineError(
              'POLICY_MISMATCH',
              'Devin selected a different model than requested; the request was stopped before any prompt was sent.',
              true,
            );
          if (selected) turn.model = selected;
          rpc.beginTurn(this.requestTimeout);
          turn.prompting = true;
          const result = await rpc.request('session/prompt', {
            sessionId: rpc.sessionId,
            prompt: [
              {
                type: 'text',
                text: JSON.stringify({
                  instructions: input.instructions,
                  input: JSON.parse(prompt),
                }),
              },
            ],
          });
          rpc.assertActive();
          if (result.stopReason !== 'end_turn' || !turn.text.trim())
            throw protocolError('did not complete a text turn.');
          return {
            text: turn.text,
            model: turn.model,
            version,
            projectId: input.projectId,
            threadId: input.threadId,
            requestId: input.requestId,
          };
        },
        turn,
        input.model,
      );
    } finally {
      this.generating = false;
    }
  }
}

/**
 * ACP sign-in is per-process: a fresh `devin acp` authenticates through the
 * provider's PKCE browser flow. `done` settles when the flow answers; the
 * caller owns the process and stops it once sign-in resolves.
 */
export function startDevinLogin(
  entry: string,
  cwd: string,
): { child: ChildProcessWithoutNullStreams; done: Promise<void> } {
  const rpc = new DevinAcp(
    devinCommand(entry, ['acp']),
    cwd,
    engineEnvironment(),
    (file, args, options) => spawn(file, args, options) as ChildProcessWithoutNullStreams,
    STARTUP_TIMEOUT_MS,
    AUTH_TIMEOUT_MS,
    undefined,
    () => {},
  );
  const done = (async () => {
    const initialized = await rpc.request('initialize', {
      protocolVersion: 1,
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false,
      },
      clientInfo: { name: 'diomedes', version: '0.1.0' },
    });
    if (initialized.protocolVersion !== 1)
      throw protocolError('reported an unsupported ACP version.');
    rpc.beginAuth();
    await rpc.request('authenticate', { methodId: 'devin-browser' });
  })();
  return { child: rpc.child, done };
}
