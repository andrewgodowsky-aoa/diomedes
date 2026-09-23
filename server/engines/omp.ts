import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { EngineModel } from '../../shared/types.js';
import type { SetupStage } from '../../shared/engines.js';
import { routeContractFor } from '../harness/route-contract.js';
import {
  contextMessage,
  type AdapterInspection,
  type TextEngineAdapter,
  type TextRequest,
  type TextResponse,
} from './contract.js';
import {
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
  displayPath,
  emitActivity,
  insideRoot,
  isWebUrl,
  readDetail,
  readScopeNote,
  readSummary,
  type ReadKind,
  type ReadScope,
} from './read-scope.js';

// Tagged OMP 18.0.6 writes a v1 ready frame, then negotiates transport v2.
export const OMP_VERSION = '18.0.6';
export const SUPPORTED_OMP_PROVIDERS = ['openai'] as const;
export const ompAccountRoute = (provider: string) => `oh-my-pi:${provider}`;

const MODEL_PART = /^[A-Za-z0-9._:-]{1,120}$/;
const SESSION_PART = /^[A-Za-z0-9_.-]{1,128}$/;
/** A provider name is an identifier: short and printable, never an account or a key. */
const PROVIDER_PART = /^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/;
const TOOL_EVENT = /^tool_execution_/;
const PROFILE_CONFIG = '# Diomedes-isolated oh-my-pi profile.\n{}\n';
const OVERLAY_CONFIG =
  '# Diomedes-owned OMP RPC overlay.\nretry:\n  enabled: false\n  maxRetries: 0\n  modelFallback: false\n  usageAwareFallback: false\n  fallbackChains: {}\ncompaction:\n  enabled: false\n  midTurnEnabled: false\n';

/** oh-my-pi 18.0.6 built-in read tools (BUILTIN_TOOL_NAMES); `read` also opens URLs. */
export const OMP_READ_TOOLS = ['read', 'grep', 'glob'] as const;
export const OMP_WEB_TOOLS = ['web_search'] as const;
/** A hidden built-in that only records the model's reasoning; it reads and writes nothing. */
const OMP_SILENT_TOOLS = ['think'];
export function ompReadTools(scope: ReadScope): string[] {
  return [...OMP_READ_TOOLS, ...(scope.web ? OMP_WEB_TOOLS : [])];
}
/**
 * Without a scope, every built-in tool is off. With one, `--tools` names the
 * read tools and nothing else (the CLI refuses an unknown name), so bash, edit,
 * write, eval, browser, task and the rest are never loaded.
 */
export function ompArguments(overlayPath: string, scope?: ReadScope): string[] {
  return [
    '--mode',
    'rpc',
    ...(scope ? [`--tools=${ompReadTools(scope).join(',')}`] : ['--no-tools']),
    '--no-extensions',
    '--no-skills',
    '--no-rules',
    '--no-lsp',
    '--no-pty',
    '--no-title',
    '--no-session',
    '--max-time',
    scope ? '240' : '90',
    '--config',
    overlayPath,
  ];
}

/**
 * A denial names the account wherever it is seen; a limit and a plain provider
 * fault keep the stage they were seen at, so neither is read as a sign-in.
 */
function failure(value: unknown, stage: SetupStage): EngineError {
  // Read from the frame's own fields rather than from the serialised frame,
  // where `auth` inside `authority` turned a certificate or proxy fault into
  // sign-in advice, and a stray number or word decided the rest.
  const kind = failureKind(value);
  if (kind === 'limited')
    return new EngineError(
      'USAGE_LIMIT',
      'oh-my-pi reported a usage or service limit. No account or model was substituted.',
      true,
      stage,
    );
  if (kind === 'denied')
    return new EngineError(
      'AUTH_REQUIRED',
      'oh-my-pi needs native provider authentication. Recheck the isolated profile before sending.',
      true,
      'provider-auth',
    );
  return new EngineError(
    'PROVIDER_ERROR',
    'oh-my-pi could not complete this request. No automatic retry was sent.',
    true,
    stage,
  );
}

function containsTool(message: Record<string, unknown>): boolean {
  if (message.role === 'toolResult') return true;
  return (
    Array.isArray(message.content) &&
    message.content.some((part) => {
      const type = record(part).type;
      return (
        type === 'toolCall' || type === 'tool_call' || type === 'tool_use' || type === 'toolcall'
      );
    })
  );
}

/** A path argument without its inline line selector (`file.md:10-20`). */
const withoutSelector = (value: string) => value.replace(/:\d+(?:-\d+)?$/, '');
/** The fixed folder a glob or path list entry starts from, before any wildcard. */
const globBase = (value: string) => {
  const wild = value.search(/[*?[{]/);
  return wild < 0 ? value : value.slice(0, wild) || '.';
};
/**
 * One oh-my-pi tool execution against a read scope: the activity to show, or a
 * refusal. `read` of a URL needs web access; an internal URI (memory://,
 * skill://) or a path outside the project folder is refused, and so is any
 * tool beyond the allow-list.
 */
export function ompToolCall(
  scope: ReadScope,
  name: string,
  raw: unknown,
): { kind: ReadKind; summary: string; detail?: string } {
  const args = record(raw);
  const refuse = () =>
    new EngineError(
      'POLICY_MISMATCH',
      'oh-my-pi went beyond the read-only boundary; the request was stopped.',
      true,
      'stream',
    );
  const detail = readDetail(args);
  const list = (value: unknown) =>
    typeof value === 'string' && value.trim()
      ? value.split(';').map((entry) => entry.trim()).filter(Boolean)
      : [];
  const local = (entry: string) => !/^[a-z][a-z0-9+.-]*:\/\//i.test(entry) && insideRoot(scope.root, entry);
  switch (name) {
    case 'read': {
      const target = typeof args.path === 'string' ? args.path.trim() : '';
      if (isWebUrl(target)) {
        if (!scope.web) throw refuse();
        return { kind: 'web-fetch', summary: readSummary('web-fetch', { url: target }), detail };
      }
      const file = withoutSelector(target);
      if (!file || !local(file)) throw refuse();
      return { kind: 'read', summary: readSummary('read', { path: displayPath(scope.root, file) }), detail };
    }
    case 'grep': {
      const paths = list(args.path).map(withoutSelector);
      if (!paths.every((entry) => local(globBase(entry)))) throw refuse();
      return {
        kind: 'search',
        summary: readSummary('search', { query: typeof args.pattern === 'string' ? args.pattern : undefined }),
        detail,
      };
    }
    case 'glob': {
      const paths = list(args.path);
      if (!paths.every((entry) => local(globBase(entry)))) throw refuse();
      return {
        kind: 'list',
        summary: paths.length ? `Finding files matching ${paths.join('; ')}` : readSummary('list', {}),
        detail,
      };
    }
    case 'web_search':
      if (!scope.web) throw refuse();
      return {
        kind: 'web-search',
        summary: readSummary('web-search', { query: typeof args.query === 'string' ? args.query : undefined }),
        detail,
      };
  }
  throw refuse();
}

function promptMessage(input: TextRequest): string {
  // RPC prompt has no system-prompt field. Keep the contract size check and
  // make the instruction boundary explicit in the request sent to OMP.
  return JSON.stringify({
    diomedes: {
      instructions: input.readScope
        ? `${input.instructions}\n\n${readScopeNote(input.readScope)}`
        : input.instructions,
      requestContext: JSON.parse(contextMessage(input)),
    },
  });
}

export class OmpAdapter implements TextEngineAdapter {
  readonly id = 'oh-my-pi' as const;
  readonly contract = routeContractFor('oh-my-pi');
  private readonly launch: ProcessFactory;

  constructor(
    private readonly file: string,
    private readonly cwd: string,
    deps: { launch?: ProcessFactory } = {},
  ) {
    this.launch = deps.launch ?? openProcess;
  }

  private profileDir() {
    return path.join(this.cwd, 'native-profile');
  }
  private overlayPath() {
    return path.join(this.cwd, 'omp-overlay.yml');
  }

  private ensureIsolation() {
    fs.mkdirSync(this.profileDir(), { recursive: true });
    const config = path.join(this.profileDir(), 'config.yml');
    if (!fs.existsSync(config)) fs.writeFileSync(config, PROFILE_CONFIG);
    else if (fs.readFileSync(config, 'utf8') !== PROFILE_CONFIG)
      throw new EngineError(
        'PROFILE_UNSAFE',
        'The isolated oh-my-pi profile config changed. Remove it or create a fresh native profile before using Diomedes.',
        true,
        'launch',
      );
    // These are the v18.0.6 schema paths. RPC controls repeat the two active
    // session toggles below; the overlay prevents a future session default from
    // re-enabling model or usage fallback before the prompt is dispatched.
    fs.writeFileSync(this.overlayPath(), OVERLAY_CONFIG);
  }

  private environment(): NodeJS.ProcessEnv {
    return { ...engineEnvironment(), PI_CODING_AGENT_DIR: this.profileDir() };
  }

  private start(signal?: AbortSignal, timeoutMs = 120_000, scope?: ReadScope) {
    this.ensureIsolation();
    return this.launch({
      file: this.file,
      args: ompArguments(this.overlayPath(), scope),
      // A read turn starts in the project folder; the profile stays the engine's.
      cwd: scope ? scope.root : this.cwd,
      env: this.environment(),
      signal,
      timeoutMs,
      maxBytes: 2_000_000,
    });
  }

  private static rejectChunk(frame: Record<string, unknown>, stage: SetupStage) {
    if (frame.type === 'rpc_chunk')
      throw new EngineError(
        'PROTOCOL_ERROR',
        'oh-my-pi sent a chunked RPC frame, which this text route does not reassemble.',
        true,
        stage,
      );
  }

  private static observeSafety(
    frame: Record<string, unknown>,
    stage: SetupStage,
    reads?: (frame: Record<string, unknown>) => void,
  ) {
    // A read turn judges each tool at execution, where its arguments are set;
    // the message-level tool parts that precede and follow it are narration.
    if (reads && typeof frame.type === 'string' && TOOL_EVENT.test(frame.type)) {
      reads(frame);
      return;
    }
    if (typeof frame.type === 'string' && TOOL_EVENT.test(frame.type))
      throw new EngineError(
        'POLICY_MISMATCH',
        'oh-my-pi attempted a tool execution on the text-only route.',
        true,
        stage,
      );
    if (
      frame.type === 'host_tool_call' ||
      frame.type === 'host_tool_cancel' ||
      frame.type === 'host_tool_update' ||
      frame.type === 'host_tool_result' ||
      frame.type === 'host_uri_request' ||
      frame.type === 'host_uri_cancel' ||
      frame.type === 'extension_ui_request'
    )
      throw new EngineError(
        'POLICY_MISMATCH',
        'oh-my-pi requested a tool or host capability on the text-only route.',
        true,
        stage,
      );
    if (reads) return;
    const message = record(frame.message);
    if (containsTool(message))
      throw new EngineError(
        'POLICY_MISMATCH',
        'oh-my-pi attempted a tool call on the text-only route.',
        true,
        stage,
      );
    if (
      Array.isArray(frame.messages) &&
      frame.messages.some((entry) => containsTool(record(entry)))
    )
      throw new EngineError(
        'POLICY_MISMATCH',
        'oh-my-pi attempted a tool call on the text-only route.',
        true,
        stage,
      );
    if (frame.type === 'message_update') {
      const event = record(frame.assistantMessageEvent);
      if (typeof event.type === 'string' && event.type.startsWith('toolcall'))
        throw new EngineError(
          'POLICY_MISMATCH',
          'oh-my-pi attempted a tool call on the text-only route.',
          true,
          stage,
        );
    }
  }

  private async awaitReady(child: EngineProcess) {
    for (;;) {
      const frame = await child.next();
      OmpAdapter.rejectChunk(frame, 'local-handshake');
      if (frame.type !== 'ready') {
        OmpAdapter.observeSafety(frame, 'local-handshake');
        continue;
      }
      if (
        frame.protocolVersion !== 1 ||
        !Array.isArray(frame.supportedProtocolVersions) ||
        !frame.supportedProtocolVersions.includes(2)
      )
        throw new EngineError(
          'PROTOCOL_ERROR',
          'oh-my-pi did not report the expected RPC ready frame.',
          true,
          'local-handshake',
        );
      return;
    }
  }

  private async call(
    child: EngineProcess,
    type: string,
    extra: Record<string, unknown> = {},
    stage: SetupStage = 'local-handshake',
  ): Promise<Record<string, unknown>> {
    const id = randomUUID();
    child.send({ id, type, ...extra });
    for (;;) {
      const frame = await child.next();
      OmpAdapter.rejectChunk(frame, stage);
      if (frame.type !== 'response') {
        OmpAdapter.observeSafety(frame, stage);
        continue;
      }
      if (frame.id !== id || frame.command !== type)
        throw new EngineError(
          'PROTOCOL_ERROR',
          'oh-my-pi returned a response for a different command.',
          true,
          stage,
        );
      if (frame.success !== true) throw failure(frame, stage);
      return record(frame.data);
    }
  }

  private async initialise(child: EngineProcess) {
    await this.awaitReady(child);
    const negotiated = await this.call(child, 'negotiate_protocol', { protocolVersion: 2 });
    if (negotiated.protocolVersion !== 2)
      throw new EngineError(
        'PROTOCOL_ERROR',
        'oh-my-pi did not negotiate RPC protocol v2.',
        true,
        'local-handshake',
      );
  }

  private parseModels(data: Record<string, unknown>) {
    const raw = Array.isArray(data.models) ? data.models : [];
    return raw.flatMap((entry) => {
      const model = record(entry);
      if (typeof model.provider !== 'string' || typeof model.id !== 'string') return [];
      if (
        !(SUPPORTED_OMP_PROVIDERS as readonly string[]).includes(model.provider) ||
        !MODEL_PART.test(model.id)
      )
        return [];
      const slug = `${model.provider}/${model.id}`;
      return [
        {
          provider: model.provider,
          id: model.id,
          name: typeof model.name === 'string' && model.name ? model.name.slice(0, 120) : slug,
          description: typeof model.description === 'string' ? model.description.slice(0, 240) : '',
        },
      ];
    });
  }

  private toEngineModels(models: ReturnType<OmpAdapter['parseModels']>): EngineModel[] {
    return models
      .slice(0, 80)
      .map((model) => ({
        slug: `${model.provider}/${model.id}`,
        name: model.name,
        description: model.description,
        efforts: [],
        defaultEffort: null,
      }));
  }

  /**
   * The account kinds the native profile is authenticated for. OMP filters its
   * model list by its own stored authentication, so an entry for another
   * provider is an account rather than a catalogue listing.
   *
   * What the code guarantees is narrower than "an identifier": the provider is
   * taken only from an entry that is a usable model row, so a name the tool
   * did not publish as the provider of a model cannot ride along. Shape alone
   * would have published `acme-holdings-inc` into the setup sentence and the
   * support bundle, both of which render this list.
   */
  private otherProviders(data: Record<string, unknown>): string[] {
    const found = new Set<string>();
    for (const entry of Array.isArray(data.models) ? data.models : []) {
      const row = record(entry);
      const provider = row.provider;
      if (typeof row.id !== 'string' || !MODEL_PART.test(row.id)) continue;
      if (
        typeof provider === 'string' &&
        PROVIDER_PART.test(provider) &&
        !(SUPPORTED_OMP_PROVIDERS as readonly string[]).includes(provider)
      )
        found.add(provider);
    }
    return [...found].slice(0, 8);
  }

  async inspect(signal?: AbortSignal): Promise<AdapterInspection> {
    let phase: SetupStage = 'launch';
    let primary: unknown;
    try {
      const child = this.start(signal, 15_000);
      try {
        phase = 'local-handshake';
        await this.initialise(child);
        // v18.0.6 maps this to session.getAvailableModels(), filtered via
        // authStorage.hasAuth. get_login_providers only describes OAuth providers.
        phase = 'model-list';
        const data = await this.call(child, 'get_available_models', {}, phase);
        const models = this.parseModels(data);
        if (!models.length) {
          const connected = this.otherProviders(data);
          if (connected.length)
            return {
              authentication: 'unknown',
              accountRoute: null,
              models: [],
              routeIssue: { required: ompAccountRoute('openai'), connected },
              detail:
                'The isolated native OMP profile is authenticated for another provider; this route accepts direct OpenAI API access only.',
            };
          return {
            authentication: 'signed-out',
            accountRoute: null,
            models: [],
            detail:
              'oh-my-pi reported no authenticated direct OpenAI API models in its isolated native profile. OAuth login metadata is not used as route proof.',
          };
        }
        return {
          authentication: 'signed-in',
          accountRoute: ompAccountRoute('openai'),
          models: this.toEngineModels(models),
          detail:
            'Authenticated OpenAI API models reported by the isolated native OMP profile; text-only, no tools, retry, fallback, or compaction.',
        };
      } catch (error) {
        primary = error;
        // OMP checks for a selected model before it enters RPC mode. A fresh
        // profile therefore exits before ready, but the same exit can also mean
        // invalid native model configuration or a broken executable. Do not
        // represent either case as proof that the user is signed out.
        if (error instanceof EngineError && error.code === 'PROCESS_EXITED') {
          return {
            authentication: 'unknown',
            accountRoute: null,
            models: [],
            detail:
              'The isolated native OMP profile exited before it could report metadata. Configure supported OpenAI API access in the native profile, then recheck.',
          };
        }
        throw error;
      } finally {
        await child.close(primary);
      }
    } catch (error) {
      throw staged(error, phase, primary);
    }
  }

  private splitModel(model: string) {
    const slash = model.indexOf('/');
    const provider = model.slice(0, slash);
    const modelId = model.slice(slash + 1);
    if (
      slash <= 0 ||
      !MODEL_PART.test(provider) ||
      !MODEL_PART.test(modelId) ||
      !(SUPPORTED_OMP_PROVIDERS as readonly string[]).includes(provider)
    )
      throw new EngineError(
        'PROTOCOL_ERROR',
        'The selected model identity is malformed or unsupported.',
        true,
        'model-list',
      );
    return { provider, modelId };
  }

  private acceptRuntimeModel(value: Record<string, unknown>, provider: string, modelId: string) {
    if (value.provider !== provider || value.id !== modelId)
      throw new EngineError(
        'POLICY_MISMATCH',
        'oh-my-pi reported a different model than requested.',
        true,
        'model-list',
      );
  }

  /**
   * A turn that has produced content of its own — answer text, or a tool event
   * this route forbids — is a stream; before that a failed turn is a dispatch.
   */
  private observePromptEvent(
    frame: Record<string, unknown>,
    provider: string,
    modelId: string,
    onDelta?: (text: string) => void,
    reads?: (frame: Record<string, unknown>) => void,
  ): Record<string, unknown> | undefined {
    OmpAdapter.observeSafety(frame, 'stream', reads);
    if (frame.type === 'extension_error' || frame.type === 'error') throw failure(frame, 'stream');
    if (frame.type === 'message_update') {
      const event = record(frame.assistantMessageEvent);
      if (event.type === 'text_delta') {
        if (typeof event.delta !== 'string')
          throw new EngineError(
            'PROTOCOL_ERROR',
            'oh-my-pi sent a malformed text delta.',
            true,
            'stream',
          );
        onDelta?.(event.delta);
      }
    }
    if (frame.type !== 'agent_end' || frame.isTerminal === false) return undefined;
    const messages = Array.isArray(frame.messages) ? frame.messages.map(record) : [];
    const terminal = [...messages].reverse().find((message) => message.role === 'assistant');
    if (
      !terminal ||
      terminal.provider !== provider ||
      terminal.model !== modelId ||
      typeof terminal.stopReason !== 'string'
    )
      throw new EngineError(
        'POLICY_MISMATCH',
        'oh-my-pi did not report the requested provider and model at terminal completion.',
        true,
        'stream',
      );
    if (typeof terminal.errorMessage === 'string' && terminal.errorMessage)
      throw failure(terminal, 'stream');
    if (terminal.stopReason === 'error' || terminal.stopReason === 'aborted')
      throw failure(terminal, 'stream');
    return frame;
  }

  async generate(input: TextRequest): Promise<TextResponse> {
    let phase: SetupStage = 'model-list';
    let primary: unknown;
    const { provider, modelId } = this.splitModel(input.model);
    if (input.accountRoute !== ompAccountRoute(provider))
      throw new EngineError(
        'ACCOUNT_CHANGED',
        'The selected oh-my-pi account route changed. Recheck before sending.',
        false,
        'provider-auth',
      );
    const scope = input.readScope;
    const started = new Set<string>();
    /** Tool executions on a read turn: judged, then narrated. */
    const reads = scope
      ? (frame: Record<string, unknown>) => {
          const name = typeof frame.toolName === 'string' ? frame.toolName : '';
          if (OMP_SILENT_TOOLS.includes(name)) return;
          const callId =
            typeof frame.toolCallId === 'string' && frame.toolCallId
              ? frame.toolCallId
              : `call-${started.size + 1}`;
          if (frame.type === 'tool_execution_start' || !started.has(callId)) {
            if (frame.type !== 'tool_execution_start' && !ompReadTools(scope).includes(name))
              throw new EngineError(
                'POLICY_MISMATCH',
                'oh-my-pi went beyond the read-only boundary; the request was stopped.',
                true,
                'stream',
              );
            if (frame.type === 'tool_execution_start') {
              const call = ompToolCall(scope, name, frame.args);
              started.add(callId);
              emitActivity(input.onToolActivity, {
                callId,
                phase: 'started',
                tool: name,
                summary: call.summary,
                ...(call.detail ? { detail: call.detail } : {}),
              });
            }
          }
          if (frame.type === 'tool_execution_end' && started.has(callId)) {
            started.delete(callId);
            const failed = frame.isError === true;
            const detail = readDetail(record(frame.result).content, 300);
            emitActivity(input.onToolActivity, {
              callId,
              phase: failed ? 'failed' : 'finished',
              tool: name,
              summary: failed ? `${name} did not complete` : `${name} finished`,
              ...(detail ? { detail } : {}),
            });
          }
        }
      : undefined;
    try {
      phase = 'launch';
      const child = this.start(input.signal, scope ? 300_000 : 120_000, scope);
      let aborted = false;
      const onAbort = () => {
        aborted = true;
        try {
          child.send({ type: 'abort' });
        } catch {
          /* close owns cancellation */
        }
      };
      input.signal?.addEventListener('abort', onAbort, { once: true });
      try {
        phase = 'local-handshake';
        await this.initialise(child);
        await this.call(child, 'set_auto_retry', { enabled: false }, phase);
        await this.call(child, 'set_auto_compaction', { enabled: false }, phase);
        phase = 'model-list';
        this.acceptRuntimeModel(
          await this.call(child, 'set_model', { provider, modelId }, phase),
          provider,
          modelId,
        );
        const state = await this.call(child, 'get_state', {}, phase);
        this.acceptRuntimeModel(record(state.model), provider, modelId);
        if (typeof state.sessionId !== 'string' || !SESSION_PART.test(state.sessionId))
          throw new EngineError(
            'PROTOCOL_ERROR',
            'oh-my-pi returned a session with malformed identity.',
            true,
            'local-handshake',
          );
        const sessionId = state.sessionId;
        const promptId = randomUUID();
        phase = 'dispatch';
        child.send({ id: promptId, type: 'prompt', message: promptMessage(input) });
        let terminal: Record<string, unknown> | undefined;
        let acknowledged = false;
        while (!acknowledged || !terminal) {
          const frame = await child.next();
          OmpAdapter.rejectChunk(frame, phase);
          if (frame.type === 'response') {
            if (frame.id !== promptId || frame.command !== 'prompt')
              throw new EngineError(
                'PROTOCOL_ERROR',
                'oh-my-pi returned a response for a different command.',
                true,
                phase,
              );
            if (frame.success !== true) throw failure(frame, phase);
            acknowledged = true;
            continue;
          }
          terminal ??= this.observePromptEvent(
            frame,
            provider,
            modelId,
            (text) => {
              phase = 'stream';
              input.onDelta?.(text);
            },
            reads,
          );
        }
        phase = 'stream';
        if (terminal.sessionId !== undefined && terminal.sessionId !== sessionId)
          throw new EngineError(
            'PROTOCOL_ERROR',
            'oh-my-pi ended a different session than requested.',
            true,
            'stream',
          );
        const last = await this.call(child, 'get_last_assistant_text', {}, phase);
        if (typeof last.text !== 'string' || !last.text.trim())
          throw new EngineError(
            'PROTOCOL_ERROR',
            'oh-my-pi did not complete an identifiable text response.',
            true,
            'stream',
          );
        return {
          text: last.text,
          model: input.model,
          version: OMP_VERSION,
          projectId: input.projectId,
          threadId: input.threadId,
          requestId: input.requestId,
        };
      } catch (error) {
        primary = error;
        throw error;
      } finally {
        input.signal?.removeEventListener('abort', onAbort);
        if (aborted || input.signal?.aborted) {
          try {
            child.send({ type: 'abort' });
          } catch {
            /* already closed */
          }
        }
        await child.close(primary);
      }
    } catch (error) {
      throw staged(error, phase, primary);
    }
  }
}
