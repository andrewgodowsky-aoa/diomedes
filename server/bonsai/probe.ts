import type { LocalModelDescriptor, LocalModelProfile, LocalModelStatus } from '../../shared/local-model.js';

/**
 * The local model's live identity, read from its own server (DIO-201 decision 3). Reading it starts
 * nothing. In order:
 *
 * 1. The descriptor's health URL: no answer means it isn't running, 503 means it is loading.
 * 2. `<base>/models`, the model ids the server lists. The descriptor's model must be one of them,
 *    and that id is the name shown.
 * 3. llama.cpp's `<base minus /v1>/props`, when it answers: `default_generation_settings.n_ctx` is
 *    the context the server runs. The running profile is the descriptor profile whose
 *    `contextTokens` equals it. With no answer, or a context no profile declares, the profile is
 *    unknown: the status says so and work that names a profile is refused.
 */
export interface ProbeOptions {
  fetch?: typeof globalThis.fetch;
  /** Milliseconds for the health check. The model list and `/props` get a little longer. */
  timeoutMs?: number;
}

type Answer =
  | { kind: 'json'; status: number; body: unknown }
  | { kind: 'http'; status: number }
  | { kind: 'down' }
  | { kind: 'timeout' }
  | { kind: 'redirect' };

const MAX_BYTES = 2 * 1024 * 1024;

async function read(url: string, fetcher: typeof globalThis.fetch, timeoutMs: number): Promise<Answer> {
  let response: Response;
  try {
    // A local server never redirects; one that does is answered as a failure, never followed.
    response = await fetcher(url, { redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) });
  } catch (error) {
    const name = error instanceof Error ? error.name : '';
    return name === 'TimeoutError' || name === 'AbortError' ? { kind: 'timeout' } : { kind: 'down' };
  }
  if (response.status >= 300 && response.status < 400) {
    await response.body?.cancel().catch(() => {});
    return { kind: 'redirect' };
  }
  let text = '';
  try {
    const reader = response.body?.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    if (reader)
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > MAX_BYTES) {
          await reader.cancel().catch(() => {});
          return { kind: 'http', status: response.status };
        }
        chunks.push(value);
      }
    text = Buffer.concat(chunks).toString('utf8');
  } catch {
    return { kind: 'down' };
  }
  if (!response.ok) return { kind: 'http', status: response.status };
  try {
    return { kind: 'json', status: response.status, body: text ? JSON.parse(text) : null };
  } catch {
    return { kind: 'json', status: response.status, body: null };
  }
}

const record = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;

/** The ids in an OpenAI-style model list: `{ data: [{ id }] }`. */
function servedIds(body: unknown): string[] | null {
  const data = record(body)?.data;
  if (!Array.isArray(data)) return null;
  return data.flatMap((entry) => {
    const id = record(entry)?.id;
    return typeof id === 'string' && id ? [id] : [];
  });
}

/** llama.cpp's running context and, when it says, whether it takes images. */
function served(body: unknown): { context: number | null; vision: boolean | null } {
  const props = record(body);
  const context = record(props?.default_generation_settings)?.n_ctx;
  const vision = record(props?.modalities)?.vision;
  return {
    context: typeof context === 'number' && Number.isSafeInteger(context) && context > 0 ? context : null,
    vision: typeof vision === 'boolean' ? vision : null,
  };
}

/**
 * The descriptor profile a running context belongs to: the one whose context equals it. A profile
 * that takes images also needs a server that says it takes them, when the server says either way.
 */
export function runningProfile(
  descriptor: Pick<LocalModelDescriptor, 'profiles'>,
  context: number | null,
  vision: boolean | null = null,
): LocalModelProfile | null {
  if (context === null) return null;
  return descriptor.profiles.find((profile) =>
    profile.contextTokens === context && !(profile.inputModalities.includes('image') && vision === false)) ?? null;
}

export async function probeLocalModel(descriptor: LocalModelDescriptor, options: ProbeOptions = {}): Promise<LocalModelStatus> {
  const fetcher = options.fetch ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? 2_000;
  const status = (state: LocalModelStatus['state'], detail: string, extra: Partial<LocalModelStatus> = {}): LocalModelStatus =>
    ({ state, installed: true, mode: null, model: null, contextTokens: null, owned: false, detail, ...extra });
  const name = descriptor.name;

  const health = await read(descriptor.healthUrl, fetcher, timeoutMs);
  if (health.kind === 'down') return status('unloaded', `${name} isn't running.`);
  if (health.kind === 'timeout') return status('error', `${name} did not answer its health check.`);
  if (health.kind === 'redirect') return status('error', `${name}'s health check answered with a redirect.`);
  if (health.kind === 'http')
    return health.status === 503
      ? status('starting', `${name} is starting.`)
      : status('error', `${name}'s health check answered HTTP ${health.status}.`);
  const said = record(health.body)?.status;
  if (typeof said === 'string' && said.toLowerCase() !== 'ok') return status('starting', `${name} is starting.`);

  const listed = await read(`${descriptor.baseUrl}/models`, fetcher, timeoutMs + 1_000);
  const ids = listed.kind === 'json' ? servedIds(listed.body) : null;
  if (!ids) return status('error', `${name} did not list its models.`);
  if (!ids.includes(descriptor.model))
    return status('error', ids.length
      ? `The local server lists ${ids.slice(0, 3).join(', ')}, not ${descriptor.model}.`
      : `The local server lists no model, not ${descriptor.model}.`);
  const model = descriptor.model;

  const props = await read(`${descriptor.serverRoot}/props`, fetcher, timeoutMs + 1_000);
  const { context, vision } = props.kind === 'json' ? served(props.body) : { context: null, vision: null };
  if (context === null)
    return status('ready', `${model} is running, but it did not report its context size.`, { model });
  const profile = runningProfile(descriptor, context, vision);
  if (!profile)
    return status('ready', `${model} is running with ${context.toLocaleString('en-US')} tokens of context, which matches none of its profiles.`,
      { model, contextTokens: context });
  return status('ready', `${model} ${profile.mode} is ready.`, { mode: profile.mode, model, contextTokens: context });
}
