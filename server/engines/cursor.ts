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
import type { EngineModel } from '../../shared/types.js';
import type { SetupStage } from '../../shared/engines.js';
import { routeContractFor } from '../harness/route-contract.js';
import {
  AcpClient,
  acpExplicitModel,
  acpPromptTurn,
  acpSession,
  acpSessionUpdate,
  acpTimeoutDetail,
  acpTurnResponse,
  CURSOR_ACP_PROFILE,
  type AcpTurn,
} from './acp-client.js';
import {
  contextMessage,
  type AdapterInspection,
  type TextEngineAdapter,
  type TextRequest,
  type TextResponse,
} from './contract.js';
import {
  abortFailure,
  capture,
  engineEnvironment,
  EngineError,
  record,
  staged,
  text,
} from './process.js';

export const CURSOR_VERSION = '2026.08.11';
export const CURSOR_ACCOUNT_ROUTE = 'cursor:cursor-account';
/** Where the attempt has reached, so an untagged failure can name its stage. */
type Phase = { at: SetupStage };
/** A frame that answers the running turn: the response has begun. */
const CONTENT_UPDATES = ['agent_message_chunk', 'tool_call', 'tool_call_update', 'plan'];
const MAX_JSON_BYTES = 512 * 1024;
const STARTUP_TIMEOUT_MS = 15_000;
const REQUEST_TIMEOUT_MS = 120_000;
// ACP advertises parameterized IDs, unlike the aliases from --list-models.
const explicitModel = acpExplicitModel;
type Json = Record<string, unknown>;
type SpawnOptions = Parameters<typeof spawn>[2];
export interface CursorAdapterDeps {
  spawn?: (file: string, args: string[], options: SpawnOptions) => ChildProcessWithoutNullStreams;
  capture?: typeof capture;
  startupTimeoutMs?: number;
  requestTimeoutMs?: number;
}
/** Resolve only the installed layout, never execute or interpret launcher text. */
export async function resolveCursorEntry(file: string): Promise<string> {
  if (!/\.(cmd|bat)$/i.test(file)) return file;
  if (!/^(agent|cursor-agent)\.cmd$/i.test(path.basename(file)))
    throw new EngineError(
      'UNSUPPORTED_SHIM',
      'Select the installed Cursor CLI launcher.',
      false,
      'discovery',
    );
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
    throw new EngineError(
      'UNSUPPORTED_SHIM',
      'Cursor has no installed CLI version.',
      false,
      'discovery',
    );
  return complete(path.join(root, 'versions', versions[0].name));
}

export function cursorCommand(file: string, args: string[]): { file: string; args: string[] } {
  if (/\.(cmd|bat|ps1)$/i.test(file))
    throw new EngineError(
      'UNSUPPORTED_SHIM',
      'Resolve the Cursor launcher before starting it.',
      false,
      'discovery',
    );
  return path.basename(file).toLowerCase() === 'index.js'
    ? {
        file: path.join(path.dirname(file), process.platform === 'win32' ? 'node.exe' : 'node'),
        args: [file, ...args],
      }
    : { file, args };
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
  readonly contract = routeContractFor('cursor');
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
    let output;
    try {
      output = await this.capture({
        ...command,
        cwd: this.cwd,
        env: engineEnvironment(),
        signal,
        timeoutMs: this.startupTimeout,
        maxBytes: MAX_JSON_BYTES,
      });
    } catch (error) {
      // A probe that cannot start has not asked the account anything yet.
      throw staged(error, 'launch');
    }
    let status: Json;
    try {
      status = record(JSON.parse(output.stdout));
    } catch {
      throw new EngineError(
        'AUTH_UNKNOWN',
        'Cursor did not report structured sign-in status.',
        false,
        'provider-auth',
      );
    }
    if (status.isAuthenticated === false) return 'signed-out';
    return output.code === 0 && status.isAuthenticated === true && status.status === 'authenticated'
      ? 'signed-in'
      : 'unknown';
  }
  private async withSession<T>(
    signal: AbortSignal | undefined,
    phase: Phase,
    run: (rpc: AcpClient, created: Json, version: string) => Promise<T>,
    turn?: AcpTurn,
  ): Promise<T> {
    phase.at = 'launch';
    if (signal?.aborted) throw abortFailure(signal.reason, acpTimeoutDetail(CURSOR_ACP_PROFILE));
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
        false,
        'runtime-verification',
      );
    phase.at = 'local-handshake';
    return acpSession(
      {
        profile: CURSOR_ACP_PROFILE,
        launch: this.launch,
        startupTimeoutMs: this.startupTimeout,
        signal,
        rootParent: this.cwd,
        rootPrefix: '.diomedes-cursor-',
        prepare: async (root) => {
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
                deny: [
                  'Shell(*)',
                  'Read(**)',
                  'Write(**)',
                  'WebFetch(*)',
                  'WebSearch(*)',
                  'Mcp(*:*)',
                ],
              },
            }),
            { flag: 'wx' },
          );
          await fs.writeFile(path.join(config, 'mcp.json'), '{"mcpServers":{}}', {
            flag: 'wx',
          });
          // The CLI owns native authentication; its profile/credential location is preserved.
          // Config and session data are fresh and never copied from the person's config.
          return {
            workspace,
            env: {
              ...engineEnvironment(),
              CURSOR_CONFIG_DIR: config,
              CURSOR_DATA_DIR: path.join(root, 'data'),
              // Windows credentials live under native APPDATA, independently of home.
              // Avoid loading the person's global rules, skills and commands as context.
              ...(process.platform === 'win32' ? { HOME: root, USERPROFILE: root } : {}),
            },
            command: cursorCommand(entry, ['--mode', 'ask', 'acp']),
          };
        },
        onUpdate: (params, rpc) => {
          // A frame answering the running turn means the response has begun,
          // even when that same frame is the one that stops the request.
          if (turn?.prompting && CONTENT_UPDATES.includes(text(record(params.update).sessionUpdate)))
            phase.at = 'stream';
          // Ask mode is set at launch and confirmed through set_mode; any
          // other reported mode is a drift the text route does not accept.
          acpSessionUpdate(CURSOR_ACP_PROFILE, rpc, params, turn, {
            onModeUpdate: (modeId) => {
              if (modeId !== 'ask')
                throw new EngineError(
                  'POLICY_MISMATCH',
                  'Cursor changed away from the requested ask mode.',
                  true,
                  phase.at,
                );
            },
          });
        },
        ready: (rpc) =>
          rpc.request('session/set_mode', { sessionId: rpc.sessionId, modeId: 'ask' }).then(() => {}),
      },
      (rpc, created) => run(rpc, created, version),
    );
  }
  private generating = false;
  async inspect(signal?: AbortSignal): Promise<AdapterInspection> {
    const phase: Phase = { at: 'provider-auth' };
    try {
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
      return await this.withSession(signal, phase, async (_rpc, created) => {
        phase.at = 'model-list';
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
    } catch (error) {
      throw staged(error, phase.at);
    }
  }
  async generate(input: TextRequest): Promise<TextResponse> {
    if (input.accountRoute !== CURSOR_ACCOUNT_ROUTE)
      throw new EngineError(
        'ACCOUNT_CHANGED',
        'Select the native Cursor account route before sending.',
        false,
        'provider-auth',
      );
    if (!explicitModel(input.model))
      throw new EngineError(
        'MODEL_UNAVAILABLE',
        'Choose an explicit Cursor model.',
        false,
        'model-list',
      );
    const prompt = contextMessage(input);
    if (this.generating)
      throw new EngineError(
        'REQUEST_ACTIVE',
        'Cursor already has a request in progress.',
        false,
        'dispatch',
      );
    this.generating = true;
    const phase: Phase = { at: 'provider-auth' };
    const turn: AcpTurn = {
      text: '',
      model: input.model,
      onDelta: input.onDelta,
      prompting: false,
    };
    try {
      if ((await this.status(input.signal)) !== 'signed-in')
        throw new EngineError(
          'AUTH_REQUIRED',
          'Sign in through Cursor, then recheck.',
          false,
          'provider-auth',
        );
      return await this.withSession(
        input.signal,
        phase,
        async (rpc, created, version) => {
          phase.at = 'model-list';
          if (
            !modelsFrom(record(created.models).availableModels).some(
              (model) => model.slug === input.model,
            )
          )
            throw new EngineError(
              'MODEL_UNAVAILABLE',
              'Cursor no longer offers the requested model. No substitute was selected.',
              false,
              'model-list',
            );
          await rpc.request('session/set_model', {
            sessionId: rpc.sessionId,
            modelId: input.model,
          });
          phase.at = 'dispatch';
          await acpPromptTurn(
            CURSOR_ACP_PROFILE,
            rpc,
            input,
            turn,
            this.requestTimeout,
            prompt,
          );
          return acpTurnResponse(input, turn, version);
        },
        turn,
      );
    } catch (error) {
      throw staged(error, phase.at);
    } finally {
      this.generating = false;
    }
  }
}
