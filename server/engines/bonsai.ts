import { z } from 'zod';
import type { ModelMessage } from 'ai';
import { findLocalProfile, localContextBudget, localCallCeiling, localDeadlines, localProfileRefusal, LOCAL_MODEL_ACCOUNT, LOCAL_MODEL_ROUTE, LOCAL_MODEL_UNKNOWN_PROFILE,
  type LocalModelProfile } from '../../shared/local-model.js';
import { MODEL_IMAGE_COUNT, MODEL_IMAGE_LIMIT, type ModelImage } from '../../shared/model-images.js';
import type { ModelRoom, ToolDescriptor } from '../../shared/harness.js';
import type { ModelRateCard } from '../spend-exposure.js';
import { createModelApiAdapter, modelApiContract } from '../harness/model-api-adapter.js';
import type { ModelTranscripts } from '../harness/model-transcripts.js';
import { ModelApiError, CONVERSATION_LIMITS, type RespondLimits, type RespondResult, type StreamSinks } from './model-api-core.js';
import { chatUsage } from './openrouter.js';
import { LocalModelError, LOCAL_MODEL_NOT_INSTALLED, type LocalModelRuntime } from '../bonsai/runtime.js';
import { readLocalStream } from './local-stream.js';

// Saved records carry these identifiers, so they keep the values they were first written with.
export const LOCAL_MODEL_CONNECTION = 'bonsai-local';
export const LOCAL_MODEL_SDK = 'bonsai-local/1';
const LOCAL_RATE_CARD = 'bonsai-local-zero-inference-cost/1';
const PREFIX = 'bonsai';
const LABEL = 'Local model';

export type LocalModelReply = Omit<RespondResult, 'reservation'>;
const refused = (message: string, dispatched = false) => new ModelApiError(`${PREFIX}_refused`, message, dispatched);
export const LOCAL_MODEL_CONTRACT = (() => {
  const contract = modelApiContract({ routeId: LOCAL_MODEL_ROUTE, sdk: LOCAL_MODEL_SDK, protocol: 'local-chat-completions', label: LABEL });
  contract.authentication = 'none';
  contract.models.source = 'fixed';
  contract.commands.interrupt = { support: 'host', note: 'Stop aborts this local request. A generation already dispatched may finish on the local server.' };
  contract.commands.status = { support: 'host', note: 'The durable run record and local worker health say what happened. Local inference has no provider charge.' };
  contract.commands.reconcile = { support: 'unsupported', note: 'An uncertain request is not automatically replayed.' };
  contract.commands.close = { support: 'host', note: 'Ending this request releases its local worker lease. The loaded worker stays available.' };
  return contract;
})();

/** The profile a call names, or the refusal that says why there is none. */
function profileOf(runtime: LocalModelRuntime, model: string): LocalModelProfile {
  const profile = runtime.profile(model);
  if (!profile) throw refused(localProfileRefusal(model));
  return profile;
}

/** Host-selected local allowance. Explicit per-call limits and the Runtime turn deadline still bound it. */
export function localLimits(profile: LocalModelProfile | undefined, base: RespondLimits = CONVERSATION_LIMITS): RespondLimits {
  if (!profile) throw refused(LOCAL_MODEL_UNKNOWN_PROFILE);
  return { ...base, maxRequestBytes: localContextBudget(profile).requestBytes,
    maxResponseBytes: localContextBudget(profile).responseBytes,
    maxOutputTokens: profile.maxOutputTokens, callWallMs: Math.max(base.callWallMs, profile.callTimeoutMs) };
}

export function localRateCard(profile: LocalModelProfile | undefined): ModelRateCard {
  if (!profile) throw refused(LOCAL_MODEL_UNKNOWN_PROFILE);
  return { route: LOCAL_MODEL_ROUTE, modelId: profile.slug, version: LOCAL_RATE_CARD,
    shortContextMaxInputTokens: profile.contextTokens,
    short: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    long: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    source: 'Inference runs on this computer. No provider charge or Nectovia credits.' };
}

type ChatMessage = { role: string; content: unknown; tool_calls?: unknown[]; tool_call_id?: string; reasoning_content?: string };
/** No URLs are fetched by the SDK or the local server. Images are exact, host-read bytes only. */
export function localMessages(messages: readonly ModelMessage[], profile: LocalModelProfile): ChatMessage[] {
  return messages.flatMap((message): ChatMessage[] => {
    if (typeof message.content === 'string') return [{ role: message.role, content: message.content }];
    if (message.role === 'user') {
      const content = message.content.map(part => {
        if (part.type === 'text') return { type: 'text', text: part.text };
        if (part.type !== 'image' || !profile.inputModalities.includes('image'))
          throw refused(`${profile.name} cannot receive this attachment. ${profile.mode} takes text only.`);
        if (typeof part.image !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(part.image) ||
            !['image/png', 'image/jpeg', 'image/webp'].includes(part.mediaType ?? '') ||
            Buffer.from(part.image, 'base64').length > MODEL_IMAGE_LIMIT)
          throw refused('Local model images must be bounded project bytes, not an external URL.');
        return { type: 'image_url', image_url: { url: `data:${part.mediaType};base64,${part.image}` } };
      });
      return [{ role: 'user', content }];
    }
    if (message.role === 'tool') return message.content.map(part => {
      if (part.type !== 'tool-result' || !['json', 'text', 'error-text', 'error-json'].includes(part.output.type))
        throw refused('This tool result cannot be sent to the local model.');
      return { role: 'tool', tool_call_id: part.toolCallId,
        content: 'value' in part.output ? (typeof part.output.value === 'string' ? part.output.value : JSON.stringify(part.output.value)) : '' };
    });
    if (message.role !== 'assistant') throw refused('The local model cannot take this message.');
    const content: string[] = [], reasoning: string[] = [], calls: unknown[] = [];
    for (const part of message.content) {
      if (part.type === 'text') content.push(part.text);
      else if (part.type === 'reasoning') reasoning.push(part.text);
      else if (part.type === 'tool-call') calls.push({ id: part.toolCallId, type: 'function',
        function: { name: part.toolName, arguments: JSON.stringify(part.input) } });
      else throw refused('The local model cannot take this answer content.');
    }
    return [{ role: 'assistant', content: content.join('') || null,
      ...(reasoning.length ? { reasoning_content: reasoning.join('') } : {}),
      ...(calls.length ? { tool_calls: calls } : {}) }];
  });
}

async function jsonRequest(url: string, payload: unknown, signal: AbortSignal, transport: typeof fetch,
  dispatched: boolean, maxBytes = 2_097_152): Promise<unknown> {
  signal.throwIfAborted();
  const response = await transport(url, { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload), redirect: 'error', signal });
  if (response.redirected || (response.status >= 300 && response.status < 400)) {
    await response.body?.cancel();
    throw refused('The local model returned a redirect.', dispatched);
  }
  const reader = response.body?.getReader();
  if (!reader) throw refused('The local model returned no response.', dispatched);
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > maxBytes) throw refused('The local model returned more data than this request allows.', dispatched);
      chunks.push(value);
    }
  } finally { await reader.cancel(); reader.releaseLock(); }
  signal.throwIfAborted();
  if (!response.ok) throw refused(`The local model returned HTTP ${response.status}. Check its logs.`, dispatched);
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw refused('The local model returned an invalid JSON response.', dispatched); }
}

const replySchema = z.object({ id: z.string(), model: z.string(), usage: z.unknown(), timings: z.unknown().optional(),
  choices: z.array(z.object({ finish_reason: z.enum(['stop', 'tool_calls']), message: z.object({
    content: z.string().nullish(), reasoning_content: z.string().nullish(),
    tool_calls: z.array(z.object({ id: z.string().min(1), type: z.literal('function'),
      function: z.object({ name: z.string(), arguments: z.string() }) })).max(1).optional(),
  }) })).length(1) });

/** A call's messages as its template is counted: each image a placeholder, its tokens reserved apart. */
const countable = (messages: readonly ChatMessage[]): ChatMessage[] => messages.map(m => ({ ...m, content: Array.isArray(m.content)
  ? m.content.map(p => p.type === 'image_url' ? { type: 'text', text: '[image]' } : p) : m.content }));

/** What a read folded to make room says in its place (DIO-254). */
export const localFoldedRead = (path: string, chars: number) =>
  `The ${chars.toLocaleString('en-US')} characters read from ${path} were left out here to make room. Read it again with read_project_file if you need its exact lines.`;

/** The file a tool message's result holds, when it is a read that returned the file's text. */
function readIn(content: unknown): { path: string; bytes: number; text: string } | null {
  if (typeof content !== 'string') return null;
  let value: unknown;
  try { value = JSON.parse(content); } catch { return null; }
  if (!value || typeof value !== 'object') return null;
  const read = value as Record<string, unknown>;
  return read.found === true && typeof read.path === 'string' && typeof read.text === 'string' && typeof read.bytes === 'number'
    ? { path: read.path, bytes: read.bytes, text: read.text } : null;
}

/**
 * DIO-254, the owner's order (2026-10-06): an Agent loop's call that won't fit its window first
 * leaves out the reasoning of earlier assistant turns, newest first, then folds a read's text into
 * a stub that names the file and its size, newest first. Each stops as soon as the call fits, by
 * the same count as the refusal. Answer text and every other tool result are kept, and nothing
 * before the first change moves, so the cached prefix holds. Null when the call still won't fit.
 * Positions are in the call's own messages, after its system prompt.
 */
async function makeRoom(messages: readonly ChatMessage[], count: (chat: ChatMessage[]) => Promise<number>, room: number,
  counted: number): Promise<{ messages: ChatMessage[]; record: ModelRoom } | null> {
  const next = messages.map(message => ({ ...message }));
  const record: ModelRoom = { counted, room, sent: counted, reasoning: [], folded: [] };
  let needed = counted;
  for (let i = next.length - 1; i > 0 && needed > room; i--) {
    const { reasoning_content: reasoning, ...rest } = next[i];
    if (next[i].role !== 'assistant' || !reasoning) continue;
    next[i] = rest;
    record.reasoning.push({ message: i - 1, chars: reasoning.length });
    needed = await count(next);
  }
  const names = new Map(next.flatMap(message => (message.tool_calls ?? []) as { id?: unknown; function?: { name?: unknown } }[])
    .map(call => [call.id, call.function?.name]));
  for (let i = next.length - 1; i > 0 && needed > room; i--) {
    const message = next[i];
    const read = message.role === 'tool' && names.get(message.tool_call_id) === 'read_project_file' ? readIn(message.content) : null;
    if (!read) continue;
    next[i] = { ...message, content: JSON.stringify({ path: read.path, found: true, bytes: read.bytes,
      note: localFoldedRead(read.path, read.text.length) }) };
    record.folded.push({ message: i - 1, path: read.path, chars: read.text.length, bytes: read.bytes });
    needed = await count(next);
  }
  if (needed > room) return null;
  record.sent = needed;
  return { messages: next, record };
}

export async function respondLocal(input: {
  runtime: LocalModelRuntime; model: string; instructions: string; effort?: string;
  messages: ModelMessage[]; tools: readonly ToolDescriptor[]; signal: AbortSignal;
  limits?: RespondLimits; transport?: typeof fetch;
  /** An Agent loop's call (DIO-254): one that won't fit its window makes room before it is refused. */
  makeRoom?: boolean;
} & StreamSinks): Promise<LocalModelReply> {
  const chosen = profileOf(input.runtime, input.model);
  const effort = input.effort ?? chosen.defaultEffort!;
  if (!chosen.efforts.some(item => item.id === effort)) throw refused('This local reasoning level is not supported.');
  const messages = [{ role: 'system', content: input.instructions }, ...localMessages(input.messages, chosen)];
  if (input.tools.length > 16 || new Set(input.tools.map(t => t.name)).size !== input.tools.length ||
      input.tools.some(t => !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(t.name))) throw refused('Invalid local model tool descriptors.');
  const tools = input.tools.map(tool => ({ type: 'function', function: { name: tool.name,
    description: tool.description, parameters: tool.inputSchema } }));
  const limits = input.limits ?? localLimits(chosen);
  const effortBudget = chosen.effortBudgets?.[effort as 'medium' | 'xhigh'];
  const max_tokens = Math.min(chosen.maxOutputTokens, limits.maxOutputTokens, effortBudget?.outputTokens ?? chosen.maxOutputTokens);
  const request = { messages, tools, tool_choice: 'auto', parallel_tool_calls: false,
    stream: true, stream_options: { include_usage: true }, return_progress: true, max_tokens, reasoning_effort: effort,
    chat_template_kwargs: { reasoning_effort: effort, ...(effortBudget ? { enable_thinking: effortBudget.thinking } : {}) },
    ...(effortBudget ? { reasoning_budget_tokens: Math.min(effortBudget.reasoningTokens, Math.max(0, max_tokens - 1)) } : {}), cache_prompt: true };
  const imageCount = messages.reduce((n, m) => n + (Array.isArray(m.content) ? m.content.filter(p => p.type === 'image_url').length : 0), 0);
  const textMessages = countable(messages);
  if (imageCount > MODEL_IMAGE_COUNT || Buffer.byteLength(JSON.stringify(request)) > 24_000_000 ||
      Buffer.byteLength(JSON.stringify({ ...request, messages: textMessages })) > limits.maxRequestBytes)
    throw refused('This message exceeds the local model attachment or text limit.');
  let dispatched = false;
  try {
    return await input.runtime.use(chosen.slug, input.signal, async (profile, active, { descriptor, status }) => {
      const signal = AbortSignal.any([active, AbortSignal.timeout(limits.callWallMs)]);
      const transport = input.transport ?? globalThis.fetch;
      // The model the server listed when the lease was taken; the answer must come from it.
      const model = status.model ?? descriptor.model;
      // The running profile's context, as the server reported it.
      const window = status.contextTokens ?? profile.contextTokens;
      const budget = localContextBudget(profile, { nativeTotalWindow: window, outputReserve: max_tokens });
      let body = { model, ...request };
      // Tokenize the actual chat template before inference; reserve a 1024-token cap per image.
      const count = async (chat: ChatMessage[]) => {
        const template = z.object({ prompt: z.string() }).parse(await jsonRequest(`${descriptor.serverRoot}/apply-template`,
          { ...body, messages: chat }, signal, transport, false, budget.templateResponseBytes));
        const tokens = z.object({ tokens: z.array(z.number().int()).max(1_000_000) }).parse(await jsonRequest(`${descriptor.serverRoot}/tokenize`,
          { content: template.prompt, add_special: true }, signal, transport, false, 12_000_000));
        return tokens.tokens.length + imageCount * 1024;
      };
      let needed = await count(textMessages);
      let room: ModelRoom | undefined;
      // DIO-254: only a call that won't fit changes; one that fits is sent exactly as it was.
      if (needed > budget.inputRoom && input.makeRoom) {
        const made = await makeRoom(messages, chat => count(countable(chat)), budget.inputRoom, needed);
        if (made) {
          body = { ...body, messages: made.messages };
          room = made.record;
          needed = made.record.sent;
        }
      }
      if (needed > budget.inputRoom)
        throw refused(`This message and its answer need more than ${window.toLocaleString('en-US')} tokens. Start a new thread or reduce its sources.`);
      dispatched = true;
      const ceiling = localCallCeiling({ measuredRates: profile.measuredRates,
        callTimeoutMs: localDeadlines(profile.maxOutputTokens).callTimeoutMs }, needed - imageCount * 1024, max_tokens);
      const raw = await readLocalStream({ url: `${descriptor.baseUrl}/chat/completions`, body, model,
        signal: AbortSignal.any([signal, AbortSignal.timeout(Math.min(limits.callWallMs, ceiling))]),
        transport, maxResponseBytes: limits.maxResponseBytes,
        onDelta: input.onDelta, onReasoningDelta: input.onReasoningDelta,
        onToolActivity: input.onToolActivity, onPromptProgress: input.onPromptProgress });
      const parsed = replySchema.safeParse(raw);
      if (!parsed.success || parsed.data.model !== model)
        throw refused('The local model did not return a complete answer from the selected model. Its answer was not used.', true);
      const response = parsed.data, message = response.choices[0].message;
      const usage = chatUsage(response.usage).usage;
      if (!usage) throw refused('The local model returned no usable token accounting. Its answer was not used.', true);
      const call = message.tool_calls?.[0];
      const content: Exclude<Extract<ModelMessage, { role: 'assistant' }>['content'], string> = [];
      if (message.reasoning_content) content.push({ type: 'reasoning', text: message.reasoning_content });
      if (message.content) content.push({ type: 'text', text: message.content });
      let outcome: LocalModelReply['outcome'];
      if (call) {
        if (!input.tools.some(tool => tool.name === call.function.name)) throw refused('The local model requested a tool this run did not offer.', true);
        let args: unknown;
        try { args = JSON.parse(call.function.arguments); } catch { throw refused('The local model returned invalid tool arguments.', true); }
        const data = z.record(z.string(), z.json()).safeParse(args);
        if (!data.success) throw refused('The local model returned invalid tool arguments.', true);
        content.push({ type: 'tool-call', toolCallId: call.id, toolName: call.function.name, input: data.data });
        outcome = { kind: 'tool', callId: call.id, name: call.function.name, input: data.data };
      } else {
        if (!message.content?.trim()) throw refused('The local model produced no final answer.', true);
        outcome = { kind: 'final', text: message.content };
      }
      return { outcome, usage, rawUsage: { provider: response.usage, local: { profile: profile.slug, inferenceCostMicroUsd: 0,
        ...(response.timings !== undefined ? { timings: response.timings } : {}) } },
        reportedModel: model, responseId: response.id, providerRequestId: response.id,
        responseMessages: [{ role: 'assistant', content }], warnings: 0, servedBy: 'local', ...(room ? { room } : {}) };
    });
  } catch (error) {
    if (error instanceof LocalModelError) throw new ModelApiError(`${PREFIX}_${error.state}`, error.message, dispatched);
    throw error;
  }
}

export function createLocalAdapter(input: {
  runtime: LocalModelRuntime; model: string; instructions: string; effort?: string; transcripts: ModelTranscripts;
  images?: readonly ModelImage[]; loadImage?: (image: ModelImage) => Promise<string>;
  limits?: RespondLimits; transport?: typeof fetch; sinks?: StreamSinks;
  /** An Agent loop's calls (DIO-254): one that won't fit its window makes room before it is refused. */
  makeRoom?: boolean;
}) {
  const descriptor = input.runtime.descriptor();
  if (!descriptor) throw refused(LOCAL_MODEL_NOT_INSTALLED);
  const profile = findLocalProfile(descriptor, input.model);
  if (!profile) throw refused(localProfileRefusal(input.model));
  const images = input.images ?? [];
  if (images.length && (!profile.inputModalities.includes('image') || !input.loadImage)) throw refused(`${profile.name} cannot receive images.`);
  return createModelApiAdapter({ route: LOCAL_MODEL_ROUTE, prefix: PREFIX, label: LABEL, sdk: LOCAL_MODEL_SDK,
    protocol: 'local-chat-completions', contract: LOCAL_MODEL_CONTRACT, connectionId: LOCAL_MODEL_CONNECTION, revision: 1,
    requestedModel: profile.slug, destination: 'local',
    preparedRequestMaxBytes: localContextBudget(profile).requestBytes,
    profile: { model: profile.slug, alias: descriptor.model, mode: profile.mode, context: profile.contextTokens,
      budget: localContextBudget(profile), effortBudgets: profile.effortBudgets,
      effort: input.effort ?? profile.defaultEffort, account: LOCAL_MODEL_ACCOUNT, images },
    transcripts: input.transcripts.withLocalByteLimit?.(localContextBudget(profile).transcriptBytes) ?? input.transcripts,
    notes: ['Local inference; tools remain owned by Nectovia Runtime and Trust.'],
    sinks: input.sinks,
    respond: async request => {
      const messages = structuredClone(request.messages);
      if (images.length) {
        // The person's message, which follows the host's reads of the attached text files.
        const first = request.stableMessages ? messages[request.stableMessages] : messages.find(m => m.role === 'user');
        if (!first || first.role !== 'user') throw refused('This image request has no user message.');
        const content = typeof first.content === 'string' ? [{ type: 'text' as const, text: first.content }] : [...first.content];
        for (const image of images) content.push({ type: 'image', image: await input.loadImage!(image), mediaType: image.mediaType });
        first.content = content;
      }
      // The private transcript saves the text and image identities, not duplicated base64 bytes.
      return respondLocal({ ...input, ...request, messages });
    },
  });
}
