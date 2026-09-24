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
  DEVIN_ACP_PROFILE,
  type AcpTurn,
} from './acp-client.js';
import {
  contextMessage,
  type AdapterInspection,
  type PersistentTextAdapter,
  type TextRequest,
  type TextResponse,
} from './contract.js';
import {
  acpSessionRoot,
  openAcpSession,
  type AcpSessionCheckpoint,
  type AcpSessionOptions,
  type AcpTurnKeep,
  type AcpTurnRunner,
} from './acp-session.js';
import {
  abortFailure,
  capture,
  engineEnvironment,
  EngineError,
  record,
  staged,
  text,
} from './process.js';

export const DEVIN_VERSION = '3000.10.23';
export const DEVIN_ACCOUNT_ROUTE = 'devin:devin-account';
const STARTUP_TIMEOUT_MS = 30_000;
const AUTH_TIMEOUT_MS = 120_000;
const REQUEST_TIMEOUT_MS = 120_000;
// The set_mode reply carries no state; the mode echo is the only confirmation
// and can land before or after the reply on the same stream.
const MODE_CONFIRM_MS = 5_000;
// Devin reports parameterized IDs such as swe-2-high; the same contract as
// every ACP route: only an explicit runtime-reported ID may be attributed.
const explicitModel = acpExplicitModel;
type Json = Record<string, unknown>;
type SpawnOptions = Parameters<typeof spawn>[2];
export interface DevinAdapterDeps {
  spawn?: (file: string, args: string[], options: SpawnOptions) => ChildProcessWithoutNullStreams;
  capture?: typeof capture;
  startupTimeoutMs?: number;
  authTimeoutMs?: number;
  requestTimeoutMs?: number;
}
const protocolError = (detail: string) =>
  new EngineError('PROTOCOL_ERROR', `Devin ${detail}`, true, 'local-handshake');
/** Where the attempt has reached, so an untagged failure can name its stage. */
type Phase = { at: SetupStage };
/** A frame that answers the running turn: the response has begun. */
const CONTENT_UPDATES = ['agent_message_chunk', 'tool_call', 'tool_call_update', 'plan'];

/** Per-session mode policy state — adapter state, not transport state. */
type DevinSession = {
  /** The mode Devin reported when the session was created, before ask is set. */
  initialMode?: string;
  /** Devin confirmed ask through its own mode echo, which precedes the reply. */
  askConfirmed: boolean;
};

/** Resolve only the installed layout, never execute or interpret launcher text. */
export async function resolveDevinEntry(file: string): Promise<string> {
  if (!/\.(cmd|bat|ps1)$/i.test(file)) return file;
  if (!/^devin\.(cmd|bat|ps1)$/i.test(path.basename(file))) throw unsupportedShim();
  const entry = path.join(path.dirname(file), 'devin.exe');
  try {
    await fs.access(entry);
    return entry;
  } catch (error) {
    if (record(error).code === 'ENOENT') throw unsupportedShim();
    throw error;
  }
}
const unsupportedShim = () =>
  new EngineError(
    'UNSUPPORTED_SHIM',
    'Select the installed Devin CLI executable.',
    false,
    'discovery',
  );

export function devinCommand(file: string, args: string[]): { file: string; args: string[] } {
  if (!/\.exe$/i.test(file)) throw unsupportedShim();
  return { file, args };
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

export class DevinAdapter implements PersistentTextAdapter<AcpSessionCheckpoint> {
  readonly id = 'devin' as const;
  readonly contract = routeContractFor('devin');
  /** The kept conversation over the shared ACP session layer, admitted separately (H05). */
  readonly sessionContract = routeContractFor('devin-session');
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
    phase: Phase,
    run: (rpc: AcpClient, created: Json, version: string) => Promise<T>,
    turn?: AcpTurn,
    model?: string,
    keep?: AcpTurnKeep,
  ): Promise<T> {
    phase.at = 'launch';
    if (signal?.aborted) throw abortFailure(signal.reason, acpTimeoutDetail(DEVIN_ACP_PROFILE));
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
    // Any version Devin reports is accepted; only an unreadable one stops here.
    if (versionResult.code !== 0 || !version)
      throw new EngineError(
        'VERSION_UNKNOWN',
        'Devin did not report its version. Reinstall or update it.',
        false,
        'runtime-verification',
      );
    phase.at = 'local-handshake';
    const session: DevinSession = { askConfirmed: false };
    return acpSession(
      {
        profile: DEVIN_ACP_PROFILE,
        launch: this.launch,
        startupTimeoutMs: this.startupTimeout,
        signal,
        rootParent: this.cwd,
        rootPrefix: '.diomedes-devin-',
        ...(keep ? { keep } : {}),
        prepare: async (root) => {
          const workspace = path.join(root, 'workspace');
          // A kept conversation's workspace outlives the turn; its deny rules are rewritten.
          if (keep) await fs.rm(path.join(workspace, '.devin'), { recursive: true, force: true });
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
          return {
            workspace,
            env: engineEnvironment(),
            command: devinCommand(entry, model ? ['acp', '--model', model] : ['acp']),
          };
        },
        onUpdate: (params, rpc) => {
          // A frame answering the running turn means the response has begun,
          // even when that same frame is the one that stops the request.
          if (turn?.prompting && CONTENT_UPDATES.includes(text(record(params.update).sessionUpdate)))
            phase.at = 'stream';
          // The ask-mode echo can land before or after the set_mode reply, and
          // a startup mode echo can lag behind it — only a different mode once
          // ask is confirmed (or a non-startup mode before) is a real change.
          acpSessionUpdate(DEVIN_ACP_PROFILE, rpc, params, turn, {
            ...(keep ? { plans: keep.plans } : {}),
            onModeUpdate: (modeId) => {
              if (modeId === 'ask') {
                session.askConfirmed = true;
                return;
              }
              if (modeId && !session.initialMode) session.initialMode = modeId;
              if (modeId !== session.initialMode || session.askConfirmed)
                throw new EngineError(
                  'POLICY_MISMATCH',
                  `Devin reported ${modeId || 'an unknown'} mode on the text route; the request was stopped.`,
                  true,
                  phase.at,
                );
            },
            onConfigUpdate: (options) => {
              const mode = options.find(
                (option) => option.category === 'mode' || option.id === 'mode',
              );
              if (mode && text(mode.currentValue) === 'ask') session.askConfirmed = true;
            },
          });
        },
        authenticate: async (rpc) => {
          // ACP never reuses the native CLI credential, so every process
          // authenticates its own host before a session can be opened. The
          // browser flow may wait on a person; it gets a wider window than start-up.
          phase.at = 'provider-auth';
          rpc.arm(
            this.authTimeout,
            'Devin browser sign-in did not complete. Close this attempt and try signing in again.',
          );
          await rpc.request('authenticate', { methodId: 'devin-browser' });
          // The account answered; opening the session is this process again.
          phase.at = 'local-handshake';
        },
        ready: async (rpc, created) => {
          session.initialMode ??= text(record(created.modes).currentModeId) || undefined;
          const offered = Array.isArray(record(created.modes).availableModes)
            ? (record(created.modes).availableModes as unknown[]).map((mode) =>
                text(record(mode).id),
              )
            : [];
          if (!offered.includes('ask'))
            throw new EngineError(
              'POLICY_MISMATCH',
              'Devin did not offer the required ask mode.',
              true,
              'local-handshake',
            );
          await rpc.request('session/set_mode', { sessionId: rpc.sessionId, modeId: 'ask' });
          const confirmBy = Date.now() + MODE_CONFIRM_MS;
          while (!session.askConfirmed) {
            rpc.assertActive();
            if (Date.now() >= confirmBy)
              throw new EngineError(
                'POLICY_MISMATCH',
                'Devin did not confirm the required ask mode.',
                true,
                'local-handshake',
              );
            await new Promise<void>((resolve) => setTimeout(resolve, 50));
          }
        },
      },
      (rpc, created) => run(rpc, created, version),
    );
  }
  private generating = false;
  async inspect(signal?: AbortSignal): Promise<AdapterInspection> {
    const phase: Phase = { at: 'launch' };
    try {
      return await this.withSession(signal, phase, async (_rpc, created) => {
        phase.at = 'model-list';
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
      throw staged(error, phase.at);
    }
  }
  async generate(input: TextRequest): Promise<TextResponse> {
    return (await this.turn(input)).response;
  }
  /** The request checks every Devin turn makes before a process starts. */
  private admit(input: TextRequest) {
    if (input.accountRoute !== DEVIN_ACCOUNT_ROUTE)
      throw new EngineError(
        'ACCOUNT_CHANGED',
        'Select the Devin account route before sending.',
        false,
        'provider-auth',
      );
    if (!explicitModel(input.model))
      throw new EngineError(
        'MODEL_UNAVAILABLE',
        'Choose an explicit Devin model.',
        false,
        'model-list',
      );
  }
  /** One Devin turn: the single-turn route, or a kept conversation's turn under `keep` (H05). */
  private async turn(
    input: TextRequest,
    keep?: AcpTurnKeep,
  ): Promise<{ response: TextResponse; version: string }> {
    this.admit(input);
    const prompt = contextMessage(input);
    if (this.generating)
      throw new EngineError(
        'REQUEST_ACTIVE',
        'Devin already has a request in progress.',
        false,
        'dispatch',
      );
    this.generating = true;
    const phase: Phase = { at: 'launch' };
    const turn: AcpTurn = {
      text: '',
      model: input.model,
      onDelta: input.onDelta,
      prompting: false,
    };
    try {
      return await this.withSession(
        input.signal,
        phase,
        async (rpc, created, version) => {
          phase.at = 'model-list';
          // A loaded session may not list the catalogue again; --model still pins it.
          const listed = modelsFrom(created).length > 0;
          if ((!keep || listed) && !modelsFrom(created).some((model) => model.slug === input.model))
            throw new EngineError(
              'MODEL_UNAVAILABLE',
              'Devin no longer offers the requested model. No substitute was selected.',
              false,
              'model-list',
            );
          // --model pins the session at launch; the reported selection is the
          // attribution, and drift is never silently accepted.
          const selected = text(modelConfig(created)?.currentValue);
          if (selected && selected !== input.model)
            throw new EngineError(
              'POLICY_MISMATCH',
              'Devin selected a different model than requested; the request was stopped before any prompt was sent.',
              true,
              'model-list',
            );
          if (selected) turn.model = selected;
          await keep?.beforePrompt();
          phase.at = 'dispatch';
          await acpPromptTurn(
            DEVIN_ACP_PROFILE,
            rpc,
            input,
            turn,
            this.requestTimeout,
            prompt,
          );
          return { response: acpTurnResponse(input, turn, version), version };
        },
        turn,
        input.model,
        keep,
      );
    } catch (error) {
      throw staged(error, phase.at);
    } finally {
      this.generating = false;
    }
  }
  /**
   * A kept Devin conversation (H05): the shared ACP session layer, running each
   * turn through this adapter's own turn so it holds the same boundary.
   */
  async openSession(input: TextRequest, options: AcpSessionOptions) {
    const runner: AcpTurnRunner = {
      engine: 'devin',
      profile: DEVIN_ACP_PROFILE,
      accountRoute: DEVIN_ACCOUNT_ROUTE,
      // Devin's route has no read policy: every tool call stops the turn.
      reads: false,
      admit: (request) => this.admit(request),
      root: (lineageId) => acpSessionRoot(this.cwd, 'devin', lineageId),
      run: (request, keep) => this.turn(request, keep),
    };
    return openAcpSession(runner, input, options);
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
  const rpc = new AcpClient({
    profile: DEVIN_ACP_PROFILE,
    command: devinCommand(entry, ['acp']),
    cwd,
    env: engineEnvironment(),
    launch: (file, args, options) => spawn(file, args, options) as ChildProcessWithoutNullStreams,
    startupTimeoutMs: STARTUP_TIMEOUT_MS,
    onUpdate: () => {},
  });
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
    // The browser flow may wait on a person; it gets a wider window than start-up.
    rpc.arm(
      AUTH_TIMEOUT_MS,
      'Devin browser sign-in did not complete. Close this attempt and try signing in again.',
    );
    try {
      await rpc.request('authenticate', { methodId: 'devin-browser' });
    } catch (error) {
      throw staged(error, 'provider-auth');
    }
  })();
  return { child: rpc.child, done };
}
