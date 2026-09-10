import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { EngineModel } from '../../shared/types.js';
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
  openProcess,
  record,
  type EngineProcess,
  type ProcessFactory,
} from './process.js';

export const CLAUDE_VERSION = '2.1.252';
const ACCOUNT_ROUTE = 'claude-code:claude.ai';
export function claudeArguments(): string[] {
  return [
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
    '',
    '--strict-mcp-config',
    '--mcp-config',
    '{"mcpServers":{}}',
    '--disable-slash-commands',
    '--no-session-persistence',
    '--max-turns',
    '1',
    '--settings',
    '{"disableAllHooks":true,"autoUpdatesChannel":"stable","enabledPlugins":{}}',
  ];
}
function environment() {
  return {
    ...engineEnvironment(),
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    DISABLE_AUTOUPDATER: '1',
    CLAUDE_CODE_MAX_RETRIES: '0',
    CLAUDE_CODE_SAFE_MODE: '1',
  };
}
function failure(value: unknown): EngineError {
  const text = JSON.stringify(value);
  if (/rate.?limit|usage.?limit|quota|overloaded/i.test(text))
    return new EngineError(
      'USAGE_LIMIT',
      'Claude Code reported a usage or service limit. No account or model was substituted.',
      true,
    );
  if (/auth|login|sign.?in|unauthorized/i.test(text))
    return new EngineError(
      'AUTH_REQUIRED',
      'Claude Code needs sign-in. Use its sign-in action, then recheck.',
      true,
    );
  return new EngineError(
    'PROVIDER_ERROR',
    'Claude Code could not complete this request. No automatic retry was sent.',
    true,
  );
}
function sameModel(requested: string, reported: string) {
  return (
    requested === reported ||
    (['sonnet', 'opus', 'haiku'].includes(requested) && reported.startsWith(`claude-${requested}-`))
  );
}
export class ClaudeAdapter implements TextEngineAdapter {
  readonly id = 'claude-code' as const;
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
        const result = await capture({
          file,
          args: ['--safe-mode', '--setting-sources', '', 'auth', 'status', '--json'],
          cwd,
          env: environment(),
          timeoutMs: 10_000,
          maxBytes: 32_000,
          signal,
        });
        try {
          return record(JSON.parse(result.stdout));
        } catch {
          throw new EngineError('AUTH_UNKNOWN', 'Claude Code could not report its sign-in status.');
        }
      });
  }
  private async requireAccount(signal?: AbortSignal) {
    const status = await this.account(signal);
    if (status.loggedIn !== true || status.authMethod !== 'claude.ai')
      throw new EngineError(
        'AUTH_REQUIRED',
        'Sign in to Claude Code with your Claude account. This route does not use API billing.',
      );
  }
  private async start(
    signal?: AbortSignal,
    extra: string[] = [],
    timeoutMs = 120_000,
    instructions?: string,
  ) {
    const directory = await fs.mkdtemp(path.join(this.cwd, '.claude-request-'));
    try {
      const args = claudeArguments();
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
        cwd: this.cwd,
        env: environment(),
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
      throw error;
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
        );
      if (frame.type !== 'control_response') continue;
      const response = record(frame.response);
      if (response.request_id !== id) continue;
      if (response.subtype !== 'success') throw failure(response);
      return record(response.response);
    }
  }
  async inspect(signal?: AbortSignal): Promise<AdapterInspection> {
    await this.requireAccount(signal);
    const process = await this.start(signal, [], 15_000),
      child = process.child;
    let primary: unknown;
    try {
      const init = await this.initialize(child);
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
  }
  async generate(input: TextRequest): Promise<TextResponse> {
    if (input.accountRoute !== ACCOUNT_ROUTE)
      throw new EngineError(
        'ACCOUNT_CHANGED',
        'The selected Claude account route changed. Recheck before sending.',
      );
    const prompt = contextMessage(input);
    await this.requireAccount(input.signal);
    const process = await this.start(
        input.signal,
        ['--model', input.model],
        120_000,
        input.instructions,
      ),
      child = process.child;
    let model: string | undefined;
    let nativeSession: string | undefined;
    let primary: unknown;
    try {
      await this.initialize(child);
      child.send({
        type: 'user',
        session_id: '',
        parent_tool_use_id: null,
        message: { role: 'user', content: prompt },
      });
      for (;;) {
        const frame = await child.next();
        if (frame.type === 'control_request')
          throw new EngineError(
            'POLICY_MISMATCH',
            'Claude Code requested an unapproved capability.',
            true,
          );
        if (frame.type === 'system' && frame.subtype === 'init') {
          if (
            !Array.isArray(frame.tools) ||
            frame.tools.length ||
            !Array.isArray(frame.mcp_servers) ||
            frame.mcp_servers.length ||
            typeof frame.model !== 'string' ||
            !sameModel(input.model, frame.model)
          )
            throw new EngineError(
              'POLICY_MISMATCH',
              'Claude Code reported different tools or a different model than requested.',
              true,
            );
          model = frame.model;
          nativeSession = typeof frame.session_id === 'string' ? frame.session_id : undefined;
        }
        if (frame.type === 'stream_event' && model) {
          const delta = record(record(frame.event).delta);
          if (delta.type === 'text_delta' && typeof delta.text === 'string')
            input.onDelta?.(delta.text);
        }
        if (frame.type === 'assistant' && Array.isArray(record(frame.message).content)) {
          for (const part of record(frame.message).content as unknown[])
            if (record(part).type === 'tool_use')
              throw new EngineError(
                'POLICY_MISMATCH',
                'Claude Code attempted a tool call on the text-only route.',
                true,
              );
        }
        if (frame.type !== 'result') continue;
        if (frame.is_error === true || frame.subtype !== 'success')
          throw failure(frame.errors ?? frame);
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
          );
        const used = Object.keys(record(frame.modelUsage));
        if (used.some((value) => !sameModel(input.model, value)))
          throw new EngineError(
            'POLICY_MISMATCH',
            'Claude Code reported an unexpected model call.',
            true,
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
  }
}
