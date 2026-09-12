/**
 * Cursor 2026.08.11-e8db854, probed on 2026-09-11.
 * agent.cmd --help, acp --help, --list-models and --version were run.
 * Exact initialize exchange observed over agent.cmd acp stdio:
 * {"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":1,"clientCapabilities":{"fs":{"readTextFile":false,"writeTextFile":false},"terminal":false},"clientInfo":{"name":"diomedes-probe","version":"0.1.0"}}}
 * {"jsonrpc":"2.0","id":1,"result":{"protocolVersion":1,"agentCapabilities":{"loadSession":true,"mcpCapabilities":{"http":true,"sse":true},"promptCapabilities":{"audio":false,"embeddedContext":false,"image":true},"sessionCapabilities":{"list":{}}},"authMethods":[{"id":"cursor_login","name":"Cursor Login","description":"Authenticate using existing Cursor login credentials. Run 'agent login' first if not logged in."}]}}
 * status --format json reports status/isAuthenticated (account details are discarded).
 * Windows agent.cmd -> cursor-agent.ps1 -> versions/2026.08.11-e8db854/
 * node.exe index.js. Launch the bundled runtime directly, never evaluate the shim.
 * Protocol: https://cursor.com/docs/cli/acp and https://agentclientprotocol.com/protocol/v1/overview
 * Native deny rules: https://cursor.com/docs/cli/reference/permissions
 * ACP has no no-tools advertisement. Client filesystem/terminal capabilities are
 * false, native permissions deny tools, and any observed tool aborts the turn.
 * These controls do not constitute OS containment or proof of unseen effects.
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

export const CURSOR_VERSION = '2026.08.11';
export const CURSOR_ACCOUNT_ROUTE = 'cursor:cursor-account';
const MAX_JSON_BYTES = 512 * 1024;
const MAX_EVENT_BYTES = 4 * 1024 * 1024;
const STARTUP_TIMEOUT_MS = 15_000;
const REQUEST_TIMEOUT_MS = 120_000;
// ACP advertises parameterized IDs, unlike the aliases from --list-models.
const MODEL_ID = /^[a-zA-Z0-9][a-zA-Z0-9._:/=,\[\]-]{0,255}$/;
const explicitModel = (value: string) =>
  MODEL_ID.test(value) && !/^(auto|default)(\[|$)/.test(value);
type Json = Record<string, unknown>;
type CursorTurn = {
  text: string;
  model: string;
  onDelta?: TextRequest['onDelta'];
  prompting: boolean;
};
type SpawnOptions = Parameters<typeof spawn>[2];
export interface CursorAdapterDeps {
  spawn?: (file: string, args: string[], options: SpawnOptions) => ChildProcessWithoutNullStreams;
  capture?: typeof capture;
  startupTimeoutMs?: number;
  requestTimeoutMs?: number;
}
const protocolError = (detail: string) =>
  new EngineError('PROTOCOL_ERROR', `Cursor ${detail}`, true);

/** Resolve only the installed layout, never execute or interpret launcher text. */
export async function resolveCursorEntry(file: string): Promise<string> {
  if (!/\.(cmd|bat)$/i.test(file)) return file;
  if (!/^(agent|cursor-agent)\.cmd$/i.test(path.basename(file)))
    throw new EngineError('UNSUPPORTED_SHIM', 'Select the installed Cursor CLI launcher.');
  const root = await fs.realpath(path.dirname(file));
  const complete = async (directory: string) => {
    const entry = path.join(directory, 'index.js');
    await fs.access(path.join(directory, 'node.exe'));
    await fs.access(entry);
    return entry;
  };
  try {
    return await complete(root);
  } catch (error) {
    if (record(error).code !== 'ENOENT') throw error;
  }
  const versions = (await fs.readdir(path.join(root, 'versions'), { withFileTypes: true }))
    .filter(
      (entry) =>
        entry.isDirectory() &&
        /^\d{4}\.\d{1,2}\.\d{1,2}(-\d{2}-\d{2}-\d{2})?-[a-f0-9]+$/.test(entry.name),
    )
    .sort((a, b) => {
      const date = (name: string) => name.split('-')[0].split('.').map(Number);
      const left = date(a.name),
        right = date(b.name);
      return (
        right[0] - left[0] ||
        right[1] - left[1] ||
        right[2] - left[2] ||
        b.name.localeCompare(a.name)
      );
    });
  if (!versions.length)
    throw new EngineError('UNSUPPORTED_SHIM', 'Cursor has no installed CLI version.');
  return complete(path.join(root, 'versions', versions[0].name));
}

export function cursorCommand(file: string, args: string[]): { file: string; args: string[] } {
  if (/\.(cmd|bat|ps1)$/i.test(file))
    throw new EngineError('UNSUPPORTED_SHIM', 'Resolve the Cursor launcher before starting it.');
  return path.basename(file).toLowerCase() === 'index.js'
    ? {
        file: path.join(path.dirname(file), process.platform === 'win32' ? 'node.exe' : 'node'),
        args: [file, ...args],
      }
    : { file, args };
}

function rpcFailure(value: unknown): EngineError {
  const error = record(value);
  if (error.code === -32000 || /auth|sign.?in|login/i.test(text(error.message)))
    return new EngineError(
      'AUTH_REQUIRED',
      'Cursor needs native sign-in. Run agent login, then recheck.',
      true,
    );
  if (/rate.?limit|quota|usage.?limit/i.test(text(error.message)))
    return new EngineError(
      'USAGE_LIMIT',
      'Cursor reported a service limit. No model or account was substituted.',
      true,
    );
  return new EngineError(
    'PROVIDER_ERROR',
    'Cursor could not complete the ACP request. No automatic retry was sent.',
    true,
  );
}

class CursorAcp {
  private readonly child: ChildProcessWithoutNullStreams;
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
  private readonly abort = () => this.fail(stopped());

  constructor(
    command: { file: string; args: string[] },
    cwd: string,
    env: NodeJS.ProcessEnv,
    launch: NonNullable<CursorAdapterDeps['spawn']>,
    timeout: number,
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
      throw new EngineError('LAUNCH_FAILED', 'Cursor could not start. Recheck its installation.');
    }
    this.timer = setTimeout(
      () => this.fail(new EngineError('TIMEOUT', 'Cursor exceeded the startup time limit.', true)),
      timeout,
    );
    this.child.on('error', () =>
      this.fail(
        new EngineError('LAUNCH_FAILED', 'Cursor could not start. Recheck its installation.'),
      ),
    );
    this.child.stdin.on('error', () =>
      this.fail(new EngineError('PROCESS_EXITED', 'Cursor stopped accepting requests.', true)),
    );
    this.child.stdout.on('data', (chunk: Buffer) => this.receive(chunk));
    // Never retain native diagnostics, which may contain account information.
    let stderrBytes = 0;
    this.child.stderr.on('data', (chunk: Buffer) => {
      stderrBytes += chunk.length;
      if (stderrBytes > MAX_JSON_BYTES)
        this.fail(
          new EngineError('OUTPUT_LIMIT', 'Cursor exceeded the diagnostic byte limit.', true),
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
    } else if (method === 'cursor/ask_question') {
      result = {
        outcome: {
          outcome: 'skipped',
          reason: 'Diomedes text route declines interactive questions.',
        },
      };
    } else if (method === 'cursor/create_plan') {
      result = {
        outcome: {
          outcome: 'rejected',
          reason: 'Diomedes text route does not authorize plans.',
        },
      };
    }
    const detail = [
      'session/request_permission',
      'cursor/ask_question',
      'cursor/create_plan',
    ].includes(method)
      ? method
      : 'an unsupported client request';
    const failure = new EngineError(
      'UNEXPECTED_TOOL',
      `Cursor requested ${detail}; Diomedes denied it and stopped the text request.`,
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
      this.fail(new EngineError('OUTPUT_LIMIT', 'Cursor exceeded the response byte limit.', true));
      return;
    }
    this.buffer += this.decoder.write(chunk);
    let end: number;
    while ((end = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, end);
      this.buffer = this.buffer.slice(end + 1);
      if (Buffer.byteLength(line) > MAX_JSON_BYTES) {
        this.fail(
          new EngineError('OUTPUT_LIMIT', 'Cursor exceeded the JSON event byte limit.', true),
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
          if (frame.method !== 'session/update')
            throw new EngineError(
              'UNEXPECTED_TOOL',
              'Cursor sent an unexpected capability event on the text route.',
              true,
            );
          this.update(record(frame.params));
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
        new EngineError('OUTPUT_LIMIT', 'Cursor exceeded the JSON event byte limit.', true),
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
  beginTurn(timeout: number) {
    this.assertActive();
    clearTimeout(this.timer);
    this.timer = setTimeout(
      () =>
        this.fail(
          new EngineError(
            'TIMEOUT',
            'Cursor exceeded the request time limit. No retry was sent.',
            true,
          ),
        ),
      timeout,
    );
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
        await killOwnedProcess(this.child);
      } catch {
        throw cleanupFailed(primary ?? this.failure);
      }
      // Cancellation or a blocking request during cleanup still invalidates a
      // previously completed result, including for direct adapter callers.
      if (!primary) this.assertActive();
    } finally {
      this.signal?.removeEventListener('abort', this.abort);
    }
  }
}

function modelsFrom(value: unknown): EngineModel[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 256).flatMap((value) => {
    const row = record(value),
      id = text(row.modelId);
    if (!explicitModel(id)) return [];
    return [
      {
        slug: id,
        name: text(row.name).slice(0, 120) || id,
        description: text(row.description).slice(0, 240),
        efforts: [],
        defaultEffort: null,
      },
    ];
  });
}

export class CursorAdapter implements TextEngineAdapter {
  readonly id = 'cursor' as const;
  private readonly launch: NonNullable<CursorAdapterDeps['spawn']>;
  private readonly capture: typeof capture;
  private readonly startupTimeout: number;
  private readonly requestTimeout: number;
  constructor(
    private readonly file: string,
    private readonly cwd: string,
    deps: CursorAdapterDeps = {},
  ) {
    this.launch =
      deps.spawn ??
      ((file, args, options) => spawn(file, args, options) as ChildProcessWithoutNullStreams);
    this.capture = deps.capture ?? capture;
    this.startupTimeout = deps.startupTimeoutMs ?? STARTUP_TIMEOUT_MS;
    this.requestTimeout = deps.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;
  }
  private async status(signal?: AbortSignal): Promise<AdapterInspection['authentication']> {
    const command = cursorCommand(await resolveCursorEntry(this.file), [
      'status',
      '--format',
      'json',
    ]);
    const output = await this.capture({
      ...command,
      cwd: this.cwd,
      env: engineEnvironment(),
      signal,
      timeoutMs: this.startupTimeout,
      maxBytes: MAX_JSON_BYTES,
    });
    let status: Json;
    try {
      status = record(JSON.parse(output.stdout));
    } catch {
      throw new EngineError('AUTH_UNKNOWN', 'Cursor did not report structured sign-in status.');
    }
    if (status.isAuthenticated === false) return 'signed-out';
    return output.code === 0 && status.isAuthenticated === true && status.status === 'authenticated'
      ? 'signed-in'
      : 'unknown';
  }
  private async withSession<T>(
    signal: AbortSignal | undefined,
    run: (rpc: CursorAcp, created: Json, version: string) => Promise<T>,
    turn?: CursorTurn,
  ): Promise<T> {
    if (signal?.aborted) throw stopped();
    const entry = await resolveCursorEntry(this.file);
    const versionResult = await this.capture({
      ...cursorCommand(entry, ['--version']),
      cwd: this.cwd,
      env: engineEnvironment(),
      signal,
      timeoutMs: this.startupTimeout,
      maxBytes: 4096,
    });
    const version = versionResult.stdout
      .trim()
      .match(/^(\d{4}\.\d{2}\.\d{2})(?:-[a-z0-9-]+)?$/)?.[1];
    if (versionResult.code !== 0 || version !== CURSOR_VERSION)
      throw new EngineError(
        'UNSUPPORTED_VERSION',
        'Cursor changed version. Review compatibility before sending.',
      );
    const root = await fs.mkdtemp(path.join(this.cwd, '.diomedes-cursor-'));
    let rpc: CursorAcp | undefined;
    let primary: unknown;
    try {
      const config = path.join(root, 'config'),
        workspace = path.join(root, 'workspace');
      await fs.mkdir(config);
      await fs.mkdir(workspace);
      await fs.writeFile(
        path.join(config, 'cli-config.json'),
        JSON.stringify({
          version: 1,
          editor: { vimMode: false },
          approvalMode: 'allowlist',
          autoAcceptWebSearch: false,
          permissions: {
            allow: [],
            deny: ['Shell(*)', 'Read(**)', 'Write(**)', 'WebFetch(*)', 'WebSearch(*)', 'Mcp(*:*)'],
          },
        }),
        { flag: 'wx' },
      );
      await fs.writeFile(path.join(config, 'mcp.json'), '{"mcpServers":{}}', {
        flag: 'wx',
      });
      // The CLI owns native authentication; its profile/credential location is preserved.
      // Config and session data are fresh and never copied from the person's config.
      rpc = new CursorAcp(
        cursorCommand(entry, ['--mode', 'ask', 'acp']),
        workspace,
        {
          ...engineEnvironment(),
          CURSOR_CONFIG_DIR: config,
          CURSOR_DATA_DIR: path.join(root, 'data'),
          // Windows credentials live under native APPDATA, independently of home.
          // Avoid loading the person's global rules, skills and commands as context.
          ...(process.platform === 'win32' ? { HOME: root, USERPROFILE: root } : {}),
        },
        this.launch,
        this.startupTimeout,
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
      const created = await rpc.request('session/new', {
        cwd: workspace,
        mcpServers: [],
      });
      const sessionId = text(created.sessionId);
      if (!sessionId || sessionId.length > 256) throw protocolError('did not return a session id.');
      rpc.sessionId = sessionId;
      await rpc.request('session/set_mode', { sessionId, modeId: 'ask' });
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
  private onUpdate(rpc: CursorAcp, params: Json, turn?: CursorTurn) {
    const update = record(params.update),
      kind = text(update.sessionUpdate);
    if (kind === 'tool_call' || kind === 'tool_call_update' || kind === 'plan')
      throw new EngineError(
        'UNEXPECTED_TOOL',
        `Cursor reported ${kind} on the text route; the request was stopped.`,
        true,
      );
    if (rpc.sessionId && params.sessionId !== rpc.sessionId)
      throw protocolError('reported a different session.');
    if (kind === 'current_mode_update' && update.currentModeId !== 'ask')
      throw new EngineError(
        'POLICY_MISMATCH',
        'Cursor changed away from the requested ask mode.',
        true,
      );
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
    if (kind === 'config_option_update' && turn && Array.isArray(update.configOptions)) {
      const model = update.configOptions
        .map(record)
        .find((option) => option.category === 'model' || option.id === 'model');
      if (model) {
        if (!explicitModel(text(model.currentValue)))
          throw protocolError('reported an invalid model selection.');
        turn.model = text(model.currentValue);
      }
    }
  }
  private generating = false;
  async inspect(signal?: AbortSignal): Promise<AdapterInspection> {
    const authentication = await this.status(signal);
    if (authentication !== 'signed-in')
      return {
        authentication,
        accountRoute: null,
        models: [],
        detail:
          authentication === 'signed-out'
            ? 'Sign in through Cursor, then recheck.'
            : 'Cursor sign-in could not be verified.',
      };
    return this.withSession(signal, async (_rpc, created) => {
      const models = modelsFrom(record(created.models).availableModels);
      return {
        authentication,
        accountRoute: CURSOR_ACCOUNT_ROUTE,
        models,
        detail: models.length
          ? 'Cursor account connected for bounded ACP text requests. Tool events stop the request; OS containment is unsupported.'
          : 'Cursor did not report explicit model choices.',
      };
    });
  }
  async generate(input: TextRequest): Promise<TextResponse> {
    if (input.accountRoute !== CURSOR_ACCOUNT_ROUTE)
      throw new EngineError(
        'ACCOUNT_CHANGED',
        'Select the native Cursor account route before sending.',
      );
    if (!explicitModel(input.model))
      throw new EngineError('MODEL_UNAVAILABLE', 'Choose an explicit Cursor model.');
    const prompt = contextMessage(input);
    if (this.generating)
      throw new EngineError('REQUEST_ACTIVE', 'Cursor already has a request in progress.');
    this.generating = true;
    const turn: CursorTurn = {
      text: '',
      model: input.model,
      onDelta: input.onDelta,
      prompting: false,
    };
    try {
      if ((await this.status(input.signal)) !== 'signed-in')
        throw new EngineError('AUTH_REQUIRED', 'Sign in through Cursor, then recheck.');
      return await this.withSession(
        input.signal,
        async (rpc, created, version) => {
          if (
            !modelsFrom(record(created.models).availableModels).some(
              (model) => model.slug === input.model,
            )
          )
            throw new EngineError(
              'MODEL_UNAVAILABLE',
              'Cursor no longer offers the requested model. No substitute was selected.',
            );
          await rpc.request('session/set_model', {
            sessionId: rpc.sessionId,
            modelId: input.model,
          });
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
      );
    } finally {
      this.generating = false;
    }
  }
}
