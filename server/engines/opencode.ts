import { randomBytes } from 'node:crypto';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import fs from 'node:fs/promises';
import net from 'node:net';
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
  cleanupFailed,
  engineEnvironment,
  EngineError,
  launchCommand,
  stopped,
  text,
} from './process.js';
import { killOwnedProcess } from '../integrations.js';

export const OPENCODE_VERSION = '1.18.4';
export const OPENCODE_ACCOUNT_ROUTE = 'opencode:opencode-go';
const MAX_JSON_BYTES = 512 * 1024;
const MAX_EVENT_BYTES = 4 * 1024 * 1024;
const STARTUP_TIMEOUT_MS = 15_000;
const REQUEST_TIMEOUT_MS = 120_000;

type Json = Record<string, unknown>;
type Fetcher = typeof globalThis.fetch;
type SpawnOptions = Parameters<typeof spawn>[2];
export interface OpenCodeAdapterDeps {
  fetch?: Fetcher;
  spawn?: (file: string, args: string[], options: SpawnOptions) => ChildProcessWithoutNullStreams;
  reservePort?: () => Promise<number>;
  startupTimeoutMs?: number;
  requestTimeoutMs?: number;
}

const object = (value: unknown): Json =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : {};

async function cappedText(response: Response, limit: number): Promise<string> {
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
        throw new EngineError('OUTPUT_LIMIT', 'OpenCode returned too much data.', true);
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

function configContent(): string {
  return JSON.stringify({
    plugin: [],
    instructions: [],
    mcp: {},
    provider: {},
    enabled_providers: ['opencode-go'],
    tools: { '*': false },
    snapshot: false,
    share: 'disabled',
    autoupdate: false,
    compaction: { auto: false, prune: false },
    permission: { '*': 'deny' },
    agent: {
      diomedes: {
        mode: 'primary',
        description: 'Text-only Diomedes route.',
        steps: 1,
        tools: { '*': false },
        permission: {
          edit: 'deny',
          bash: 'deny',
          webfetch: 'deny',
          doom_loop: 'deny',
          external_directory: 'deny',
        },
      },
    },
    experimental: { continue_loop_on_deny: false, batch_tool: false },
  });
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
    throw new EngineError('START_FAILED', 'OpenCode did not provide a loopback port.');
  return address.port;
}

function deadline(
  signal: AbortSignal | undefined,
  timeout: number,
): { signal: AbortSignal; dispose: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort('timeout'), timeout);
  const onAbort = () => controller.abort('cancelled');
  signal?.addEventListener('abort', onAbort, { once: true });
  if (signal?.aborted) controller.abort('cancelled');
  return {
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    },
  };
}

function abortError(
  signal: AbortSignal,
  timeoutMs: number,
  budget: 'startup' | 'request',
): EngineError {
  if (signal.reason !== 'timeout') return stopped();
  return budget === 'startup'
    ? new EngineError(
        'TIMEOUT',
        `OpenCode did not start within ${Math.round(timeoutMs / 1000)} seconds. Recheck the engine in Settings before starting another request.`,
        true,
      )
    : new EngineError(
        'TIMEOUT',
        'OpenCode did not finish within the time limit. Recheck before starting another request.',
        true,
      );
}

function errorForResponse(status: number, body: string): EngineError {
  if (status === 401 || status === 403)
    return new EngineError(
      'AUTH_REQUIRED',
      'OpenCode Go is not signed in. Sign in through OpenCode, then recheck.',
      true,
    );
  if (/retry|rate.?limit|quota|usage/i.test(body))
    return new EngineError(
      'USAGE_LIMIT',
      'OpenCode reported a service limit. No provider or model was substituted.',
      true,
    );
  return new EngineError(
    'PROVIDER_ERROR',
    'OpenCode could not complete this request. No automatic retry was sent.',
    true,
  );
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

function catalogue(body: Json): { connected: boolean; models: EngineModel[] } {
  const all = Array.isArray(body.all) ? body.all : [];
  const connected = Array.isArray(body.connected)
    ? body.connected.filter((v): v is string => typeof v === 'string')
    : [];
  const providerId = 'opencode-go';
  if (!connected.includes(providerId)) return { connected: false, models: [] };
  const provider = all.map(object).find((item) => item.id === providerId) ?? {};
  const rawModels = object(provider.models);
  const models = Object.entries(rawModels)
    .slice(0, 80)
    .flatMap(([id, value]) => modelFrom({ ...object(value), id }, providerId) ?? []);
  return { connected: true, models };
}

function parseSelection(value: string): { providerID: string; modelID: string } {
  const slash = value.indexOf('/');
  if (slash <= 0 || slash === value.length - 1)
    throw new EngineError(
      'MODEL_UNAVAILABLE',
      'Choose an explicit OpenCode Go provider/model.',
      true,
    );
  const providerID = value.slice(0, slash);
  const modelID = value.slice(slash + 1);
  if (providerID !== 'opencode-go')
    throw new EngineError(
      'ACCOUNT_CHANGED',
      'Only the native OpenCode Go account route is allowed.',
      true,
    );
  return { providerID, modelID };
}

export function opencodeArguments(port: number): string[] {
  return ['serve', '--hostname', '127.0.0.1', '--port', String(port), '--pure'];
}

export class OpenCodeAdapter implements TextEngineAdapter {
  readonly id = 'opencode' as const;
  private readonly fetcher: Fetcher;
  private readonly spawnProcess: NonNullable<OpenCodeAdapterDeps['spawn']>;
  private readonly reserve: NonNullable<OpenCodeAdapterDeps['reservePort']>;
  private readonly startupTimeout: number;
  private readonly requestTimeout: number;
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
  }

  private async isolatedEnvironment(root: string): Promise<NodeJS.ProcessEnv> {
    const [config, cache, state, home] = await Promise.all(
      ['config', 'cache', 'state', 'home'].map((name) =>
        fs.mkdtemp(path.join(root, `.opencode-${name}-`)),
      ),
    );
    const source = process.env;
    const nativeHome = source.USERPROFILE ?? source.HOME ?? process.cwd();
    const nativeData = source.XDG_DATA_HOME ?? path.join(nativeHome, '.local', 'share');
    return {
      ...engineEnvironment(source),
      HOME: home,
      USERPROFILE: home,
      XDG_CONFIG_HOME: config,
      XDG_CACHE_HOME: cache,
      XDG_STATE_HOME: state,
      XDG_DATA_HOME: nativeData,
      OPENCODE_CONFIG_CONTENT: configContent(),
      OPENCODE_DISABLE_PROJECT_CONFIG: '1',
      OPENCODE_DISABLE_EXTERNAL_SKILLS: '1',
      OPENCODE_PURE: '1',
      OPENCODE_SERVER_USERNAME: 'opencode',
    };
  }

  private async start(signal?: AbortSignal): Promise<{
    child: ChildProcessWithoutNullStreams;
    base: string;
    auth: string;
    env: NodeJS.ProcessEnv;
    root: string;
  }> {
    if (signal?.aborted) throw stopped();
    const root = await fs.mkdtemp(path.join(this.cwd, '.diomedes-opencode-'));
    let env: NodeJS.ProcessEnv;
    let port: number;
    let command: ReturnType<typeof launchCommand>;
    try {
      env = await this.isolatedEnvironment(root);
      port = await this.reserve();
      command = launchCommand(this.file, opencodeArguments(port));
    } catch (error) {
      await fs.rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 200 });
      throw error;
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
      );
    });
    const base = `http://127.0.0.1:${port}`;
    const auth = `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}`;
    const ready = deadline(signal, this.startupTimeout);
    try {
      for (;;) {
        try {
          const response = await this.fetcher(`${base}/provider`, {
            headers: this.headers(auth),
            signal: ready.signal,
          });
          const body = await cappedText(response, MAX_JSON_BYTES);
          if (response.status === 401 || response.status === 403)
            throw errorForResponse(response.status, body);
          if (response.ok) {
            ready.dispose();
            return { child, base, auth, env, root };
          }
        } catch (error) {
          if (error instanceof EngineError) throw error;
          if (launchError) throw launchError;
          if (ready.signal.aborted) throw abortError(ready.signal, this.startupTimeout, 'startup');
        }
        if (launchError) throw launchError;
        if (child.exitCode !== null || child.signalCode !== null)
          throw new EngineError(
            'LAUNCH_FAILED',
            'OpenCode stopped before its server became ready.',
            true,
          );
        await new Promise((resolve) => setTimeout(resolve, 40));
      }
    } catch (error) {
      ready.dispose();
      await this.closeChild(child, error);
      await fs.rm(root, { recursive: true, force: true });
      throw error;
    }
  }

  private headers(auth: string): Record<string, string> {
    return { Authorization: auth, Accept: 'application/json', 'x-opencode-directory': this.cwd };
  }
  private async closeChild(child: ChildProcessWithoutNullStreams, primary?: unknown) {
    try {
      await killOwnedProcess(child);
    } catch {
      throw cleanupFailed(primary);
    }
  }
  private async request(
    server: { base: string; auth: string },
    route: string,
    init: RequestInit,
    signal: AbortSignal,
  ): Promise<Response> {
    let response: Response;
    try {
      response = await this.fetcher(`${server.base}${route}`, {
        ...init,
        signal,
        headers: { ...this.headers(server.auth), ...(init.headers ?? {}) },
      });
    } catch (error) {
      if (signal.aborted) throw abortError(signal, this.requestTimeout, 'request');
      throw new EngineError('PROVIDER_ERROR', 'OpenCode could not be reached.', true);
    }
    if (!response.ok) {
      const body = (await cappedText(response, 4096)).slice(0, 4096);
      throw errorForResponse(response.status, body);
    }
    return response;
  }
  private async json(response: Response): Promise<Json> {
    try {
      return object(JSON.parse(await cappedText(response, MAX_JSON_BYTES)));
    } catch (error) {
      if (error instanceof EngineError) throw error;
      throw new EngineError('PROTOCOL_ERROR', 'OpenCode returned malformed JSON.', true);
    }
  }
  private async cleanupRequest(server: { base: string; auth: string }, route: string) {
    const control = new AbortController();
    const timer = setTimeout(() => control.abort('cleanup-timeout'), 2_000);
    try {
      await this.request(
        server,
        route,
        { method: route.endsWith('/abort') ? 'POST' : 'DELETE' },
        control.signal,
      );
    } catch {
      /* Cleanup must not replace the primary provider or cancellation error. */
    } finally {
      clearTimeout(timer);
    }
  }

  async inspect(signal?: AbortSignal): Promise<AdapterInspection> {
    const server = await this.start(signal);
    const control = deadline(signal, this.requestTimeout);
    try {
      const body = await this.json(await this.request(server, '/provider', {}, control.signal));
      const list = catalogue(body);
      if (!list.connected)
        return {
          authentication: 'signed-out',
          accountRoute: null,
          models: [],
          detail: 'Sign in to the native OpenCode Go account before using this route.',
        };
      return {
        authentication: 'signed-in',
        accountRoute: OPENCODE_ACCOUNT_ROUTE,
        models: list.models,
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
      );
    const selection = parseSelection(input.model);
    const prompt = contextMessage(input);
    const server = await this.start(input.signal);
    const control = deadline(input.signal, this.requestTimeout);
    let sessionId: string | undefined;
    let eventResponse: Response | undefined;
    let completed = false;
    let primary: unknown;
    try {
      const provider = catalogue(
        await this.json(await this.request(server, '/provider', {}, control.signal)),
      );
      if (!provider.connected || !provider.models.some((model) => model.slug === input.model))
        throw new EngineError(
          'MODEL_UNAVAILABLE',
          'The selected OpenCode Go model is unavailable. Recheck before sending.',
          true,
        );
      const created = await this.json(
        await this.request(
          server,
          '/session',
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              title: `Diomedes ${input.requestId}`.slice(0, 120),
              agent: 'diomedes',
              model: { providerID: selection.providerID, id: selection.modelID },
              permission: [{ permission: '*', pattern: '*', action: 'deny' }],
            }),
          },
          control.signal,
        ),
      );
      sessionId = text(created.id) || text(created.sessionID);
      if (!sessionId)
        throw new EngineError('PROTOCOL_ERROR', 'OpenCode did not return a session id.', true);
      eventResponse = await this.request(
        server,
        '/event',
        { headers: { Accept: 'text/event-stream' } },
        control.signal,
      );
      await this.request(
        server,
        `/session/${encodeURIComponent(sessionId)}/prompt_async`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            agent: 'diomedes',
            model: { providerID: selection.providerID, modelID: selection.modelID },
            system: input.instructions,
            parts: [{ type: 'text', text: prompt }],
          }),
        },
        control.signal,
      );
      if (!eventResponse.body)
        throw new EngineError('PROTOCOL_ERROR', 'OpenCode did not provide an event stream.', true);
      const reader = eventResponse.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let answer = '';
      let bytes = 0;
      let assistantMessageId: string | undefined;
      let assistantInfo = false;
      let assistantTerminal = false;
      try {
        for (;;) {
          const part = await reader.read();
          if (part.done) break;
          bytes += part.value.byteLength;
          if (bytes > MAX_EVENT_BYTES)
            throw new EngineError('OUTPUT_LIMIT', 'OpenCode exceeded the response limit.', true);
          buffer += decoder.decode(part.value, { stream: true });
          let end: number;
          while ((end = buffer.indexOf('\n\n')) >= 0) {
            const frame = buffer.slice(0, end);
            buffer = buffer.slice(end + 2);
            const line = frame.split(/\r?\n/).find((row) => row.startsWith('data:'));
            if (!line) continue;
            let event: Json;
            try {
              event = object(JSON.parse(line.slice(5).trim()));
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
            if (/permission/i.test(kind) || /tool/i.test(partType))
              throw new EngineError(
                'POLICY_MISMATCH',
                'OpenCode requested a tool or permission on the text-only route.',
                true,
              );
            if (kind === 'message.updated') {
              const info = object(props.info);
              if (text(info.role) !== 'assistant') continue;
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
                throw new EngineError(
                  'PROVIDER_ERROR',
                  'OpenCode reported an assistant error.',
                  true,
                );
            }
            if (kind === 'session.error')
              throw new EngineError('PROVIDER_ERROR', 'OpenCode reported a session error.', true);
            if (
              kind === 'message.part.updated' &&
              assistantMessageId &&
              text(partValue.messageID) === assistantMessageId
            ) {
              if (partType !== 'text') continue;
              const delta = text(props.delta);
              if (delta) {
                answer += delta;
                input.onDelta?.(delta);
              } else {
                const full = text(partValue.text);
                if (full && full.startsWith(answer)) {
                  const next = full.slice(answer.length);
                  answer = full;
                  if (next) input.onDelta?.(next);
                }
              }
            }
            if (
              kind === 'message.part.delta' &&
              assistantMessageId &&
              text(props.messageID) === assistantMessageId &&
              text(props.field) === 'text'
            ) {
              const delta = text(props.delta);
              if (delta) {
                answer += delta;
                input.onDelta?.(delta);
              }
            }
            if (
              kind === 'session.status' &&
              statusType === 'idle' &&
              assistantInfo &&
              assistantTerminal &&
              answer.trim()
            ) {
              completed = true;
              return {
                text: answer,
                model: input.model,
                version: OPENCODE_VERSION,
                projectId: input.projectId,
                threadId: input.threadId,
                requestId: input.requestId,
              };
            }
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
      );
    } catch (error) {
      if (!(error instanceof EngineError) && control.signal.aborted)
        error = abortError(control.signal, this.requestTimeout, 'request');
      primary = error;
      if (sessionId && !completed)
        await this.cleanupRequest(server, `/session/${encodeURIComponent(sessionId)}/abort`);
      throw error instanceof EngineError
        ? error
        : new EngineError('PROVIDER_ERROR', 'OpenCode could not complete this request.', true);
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
