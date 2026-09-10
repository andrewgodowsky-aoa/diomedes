import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { EngineModel } from '../../shared/types.js';
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
  openProcess,
  record,
  type EngineProcess,
  type ProcessFactory,
} from './process.js';

// Tagged OMP 18.0.6 writes a v1 ready frame, then negotiates transport v2.
export const OMP_VERSION = '18.0.6';
export const SUPPORTED_OMP_PROVIDERS = ['openai'] as const;
export const ompAccountRoute = (provider: string) => `oh-my-pi:${provider}`;

const MODEL_PART = /^[A-Za-z0-9._:-]{1,120}$/;
const SESSION_PART = /^[A-Za-z0-9_.-]{1,128}$/;
const TOOL_EVENT = /^tool_execution_/;
const PROFILE_CONFIG = '# Diomedes-isolated oh-my-pi profile.\n{}\n';
const OVERLAY_CONFIG =
  '# Diomedes-owned OMP RPC overlay.\nretry:\n  enabled: false\n  maxRetries: 0\n  modelFallback: false\n  usageAwareFallback: false\n  fallbackChains: {}\ncompaction:\n  enabled: false\n  midTurnEnabled: false\n';

export function ompArguments(overlayPath: string): string[] {
  return [
    '--mode',
    'rpc',
    '--no-tools',
    '--no-extensions',
    '--no-skills',
    '--no-rules',
    '--no-lsp',
    '--no-pty',
    '--no-title',
    '--no-session',
    '--max-time',
    '90',
    '--config',
    overlayPath,
  ];
}

function failure(value: unknown): EngineError {
  const text = JSON.stringify(value);
  if (/rate.?limit|usage.?limit|quota|overloaded|insufficient/i.test(text))
    return new EngineError(
      'USAGE_LIMIT',
      'oh-my-pi reported a usage or service limit. No account or model was substituted.',
      true,
    );
  if (/auth|login|sign.?in|unauthorized|unauthenticated|api.?key/i.test(text))
    return new EngineError(
      'AUTH_REQUIRED',
      'oh-my-pi needs native provider authentication. Recheck the isolated profile before sending.',
      true,
    );
  return new EngineError(
    'PROVIDER_ERROR',
    'oh-my-pi could not complete this request. No automatic retry was sent.',
    true,
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

function promptMessage(input: TextRequest): string {
  // RPC prompt has no system-prompt field. Keep the contract size check and
  // make the instruction boundary explicit in the request sent to OMP.
  return JSON.stringify({
    diomedes: {
      instructions: input.instructions,
      requestContext: JSON.parse(contextMessage(input)),
    },
  });
}

export class OmpAdapter implements TextEngineAdapter {
  readonly id = 'oh-my-pi' as const;
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
      );
    // These are the v18.0.6 schema paths. RPC controls repeat the two active
    // session toggles below; the overlay prevents a future session default from
    // re-enabling model or usage fallback before the prompt is dispatched.
    fs.writeFileSync(this.overlayPath(), OVERLAY_CONFIG);
  }

  private environment(): NodeJS.ProcessEnv {
    return { ...engineEnvironment(), PI_CODING_AGENT_DIR: this.profileDir() };
  }

  private start(signal?: AbortSignal, timeoutMs = 120_000) {
    this.ensureIsolation();
    return this.launch({
      file: this.file,
      args: ompArguments(this.overlayPath()),
      cwd: this.cwd,
      env: this.environment(),
      signal,
      timeoutMs,
      maxBytes: 2_000_000,
    });
  }

  private static rejectChunk(frame: Record<string, unknown>) {
    if (frame.type === 'rpc_chunk')
      throw new EngineError(
        'PROTOCOL_ERROR',
        'oh-my-pi sent a chunked RPC frame, which this text route does not reassemble.',
        true,
      );
  }

  private static observeSafety(frame: Record<string, unknown>) {
    if (typeof frame.type === 'string' && TOOL_EVENT.test(frame.type))
      throw new EngineError(
        'POLICY_MISMATCH',
        'oh-my-pi attempted a tool execution on the text-only route.',
        true,
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
      );
    const message = record(frame.message);
    if (containsTool(message))
      throw new EngineError(
        'POLICY_MISMATCH',
        'oh-my-pi attempted a tool call on the text-only route.',
        true,
      );
    if (
      Array.isArray(frame.messages) &&
      frame.messages.some((entry) => containsTool(record(entry)))
    )
      throw new EngineError(
        'POLICY_MISMATCH',
        'oh-my-pi attempted a tool call on the text-only route.',
        true,
      );
    if (frame.type === 'message_update') {
      const event = record(frame.assistantMessageEvent);
      if (typeof event.type === 'string' && event.type.startsWith('toolcall'))
        throw new EngineError(
          'POLICY_MISMATCH',
          'oh-my-pi attempted a tool call on the text-only route.',
          true,
        );
    }
  }

  private async awaitReady(child: EngineProcess) {
    for (;;) {
      const frame = await child.next();
      OmpAdapter.rejectChunk(frame);
      if (frame.type !== 'ready') {
        OmpAdapter.observeSafety(frame);
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
        );
      return;
    }
  }

  private async call(
    child: EngineProcess,
    type: string,
    extra: Record<string, unknown> = {},
  ): Promise<Record<string, unknown>> {
    const id = randomUUID();
    child.send({ id, type, ...extra });
    for (;;) {
      const frame = await child.next();
      OmpAdapter.rejectChunk(frame);
      if (frame.type !== 'response') {
        OmpAdapter.observeSafety(frame);
        continue;
      }
      if (frame.id !== id || frame.command !== type)
        throw new EngineError(
          'PROTOCOL_ERROR',
          'oh-my-pi returned a response for a different command.',
          true,
        );
      if (frame.success !== true) throw failure(frame);
      return record(frame.data);
    }
  }

  private async initialise(child: EngineProcess) {
    await this.awaitReady(child);
    const negotiated = await this.call(child, 'negotiate_protocol', { protocolVersion: 2 });
    if (negotiated.protocolVersion !== 2)
      throw new EngineError('PROTOCOL_ERROR', 'oh-my-pi did not negotiate RPC protocol v2.', true);
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

  async inspect(signal?: AbortSignal): Promise<AdapterInspection> {
    const child = this.start(signal, 15_000);
    let primary: unknown;
    try {
      await this.initialise(child);
      // v18.0.6 maps this to session.getAvailableModels(), filtered via
      // authStorage.hasAuth. get_login_providers only describes OAuth providers.
      const models = this.parseModels(await this.call(child, 'get_available_models'));
      if (!models.length)
        return {
          authentication: 'signed-out',
          accountRoute: null,
          models: [],
          detail:
            'oh-my-pi reported no authenticated direct OpenAI API models in its isolated native profile. OAuth login metadata is not used as route proof.',
        };
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
      );
    return { provider, modelId };
  }

  private acceptRuntimeModel(value: Record<string, unknown>, provider: string, modelId: string) {
    if (value.provider !== provider || value.id !== modelId)
      throw new EngineError(
        'POLICY_MISMATCH',
        'oh-my-pi reported a different model than requested.',
        true,
      );
  }

  private observePromptEvent(
    frame: Record<string, unknown>,
    provider: string,
    modelId: string,
    onDelta?: (text: string) => void,
  ): Record<string, unknown> | undefined {
    OmpAdapter.observeSafety(frame);
    if (frame.type === 'extension_error' || frame.type === 'error') throw failure(frame);
    if (frame.type === 'message_update') {
      const event = record(frame.assistantMessageEvent);
      if (event.type === 'text_delta') {
        if (typeof event.delta !== 'string')
          throw new EngineError('PROTOCOL_ERROR', 'oh-my-pi sent a malformed text delta.', true);
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
      );
    if (typeof terminal.errorMessage === 'string' && terminal.errorMessage) throw failure(terminal);
    if (terminal.stopReason === 'error' || terminal.stopReason === 'aborted')
      throw failure(terminal);
    return frame;
  }

  async generate(input: TextRequest): Promise<TextResponse> {
    const { provider, modelId } = this.splitModel(input.model);
    if (input.accountRoute !== ompAccountRoute(provider))
      throw new EngineError(
        'ACCOUNT_CHANGED',
        'The selected oh-my-pi account route changed. Recheck before sending.',
      );
    const child = this.start(input.signal, 120_000);
    let aborted = false;
    let primary: unknown;
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
      await this.initialise(child);
      await this.call(child, 'set_auto_retry', { enabled: false });
      await this.call(child, 'set_auto_compaction', { enabled: false });
      this.acceptRuntimeModel(
        await this.call(child, 'set_model', { provider, modelId }),
        provider,
        modelId,
      );
      const state = await this.call(child, 'get_state');
      this.acceptRuntimeModel(record(state.model), provider, modelId);
      if (typeof state.sessionId !== 'string' || !SESSION_PART.test(state.sessionId))
        throw new EngineError(
          'PROTOCOL_ERROR',
          'oh-my-pi returned a session with malformed identity.',
          true,
        );
      const sessionId = state.sessionId;
      const promptId = randomUUID();
      child.send({ id: promptId, type: 'prompt', message: promptMessage(input) });
      let terminal: Record<string, unknown> | undefined;
      let acknowledged = false;
      while (!acknowledged || !terminal) {
        const frame = await child.next();
        OmpAdapter.rejectChunk(frame);
        if (frame.type === 'response') {
          if (frame.id !== promptId || frame.command !== 'prompt')
            throw new EngineError(
              'PROTOCOL_ERROR',
              'oh-my-pi returned a response for a different command.',
              true,
            );
          if (frame.success !== true) throw failure(frame);
          acknowledged = true;
          continue;
        }
        terminal ??= this.observePromptEvent(frame, provider, modelId, input.onDelta);
      }
      if (terminal.sessionId !== undefined && terminal.sessionId !== sessionId)
        throw new EngineError(
          'PROTOCOL_ERROR',
          'oh-my-pi ended a different session than requested.',
          true,
        );
      const last = await this.call(child, 'get_last_assistant_text');
      if (typeof last.text !== 'string' || !last.text.trim())
        throw new EngineError(
          'PROTOCOL_ERROR',
          'oh-my-pi did not complete an identifiable text response.',
          true,
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
  }
}
