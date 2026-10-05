import { z } from 'zod';
import type { ModelMessage } from 'ai';
import { BONSAI_ACCOUNT, BONSAI_BASE_URL, BONSAI_MODEL, BONSAI_ROUTE, bonsaiProfile,
  MODEL_IMAGE_COUNT, MODEL_IMAGE_LIMIT, type ModelImage } from '../../shared/bonsai.js';
import type { ToolDescriptor } from '../../shared/harness.js';
import type { ModelRateCard } from '../spend-exposure.js';
import { createModelApiAdapter, modelApiContract } from '../harness/model-api-adapter.js';
import type { ModelTranscripts } from '../harness/model-transcripts.js';
import { ModelApiError, CONVERSATION_LIMITS, type RespondLimits, type RespondResult, type StreamSinks } from './model-api-core.js';
import { chatUsage } from './openrouter.js';
import { BonsaiError, type BonsaiRuntime } from '../bonsai/runtime.js';

export const BONSAI_CONNECTION = 'bonsai-local';
export const BONSAI_VERSION = 'bonsai-local/1';
export type BonsaiReply = Omit<RespondResult, 'reservation'>;
const refused = (message: string, dispatched = false) => new ModelApiError('bonsai_refused', message, dispatched);
export const BONSAI_MODEL_CONTRACT = (() => {
  const contract = modelApiContract({ routeId: BONSAI_ROUTE, sdk: BONSAI_VERSION, protocol: 'local-chat-completions', label: 'Bonsai' });
  contract.authentication = 'none';
  contract.models.source = 'fixed';
  contract.commands.interrupt = { support: 'host', note: 'Stop aborts this local request. A generation already dispatched may finish on the local server.' };
  contract.commands.status = { support: 'host', note: 'The durable run record and local worker health say what happened. Local inference has no provider charge.' };
  contract.commands.reconcile = { support: 'unsupported', note: 'An uncertain request is not automatically replayed.' };
  contract.commands.close = { support: 'host', note: 'Ending this request releases its local worker lease. The loaded worker stays available.' };
  return contract;
})();

/** Host-selected local allowance. Explicit per-call limits and the Runtime turn deadline still bound it. */
export function bonsaiLimits(model: string, base: RespondLimits = CONVERSATION_LIMITS): RespondLimits {
  const profile = bonsaiProfile(model);
  if (!profile) throw refused('Choose a configured Bonsai profile.');
  return { ...base, maxOutputTokens: profile.maxOutputTokens, callWallMs: Math.max(base.callWallMs, profile.callTimeoutMs) };
}

export function bonsaiRateCard(model: string): ModelRateCard {
  if (!bonsaiProfile(model)) throw refused('Choose a configured Bonsai profile.');
  return { route: BONSAI_ROUTE, modelId: model, version: 'bonsai-local-zero-inference-cost/1',
    shortContextMaxInputTokens: bonsaiProfile(model)!.contextTokens,
    short: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    long: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    source: 'Inference runs on this computer. No provider charge or Nectovia credits.' };
}

type ChatMessage = { role: string; content: unknown; tool_calls?: unknown[]; tool_call_id?: string; reasoning_content?: string };
/** No URLs are fetched by the SDK or the local server. Images are exact, host-read bytes only. */
export function bonsaiMessages(messages: readonly ModelMessage[], model: string): ChatMessage[] {
  const profile = bonsaiProfile(model);
  if (!profile) throw refused('Choose a configured Bonsai profile.');
  return messages.flatMap((message): ChatMessage[] => {
    if (typeof message.content === 'string') return [{ role: message.role, content: message.content }];
    if (message.role === 'user') {
      const content = message.content.map(part => {
        if (part.type === 'text') return { type: 'text', text: part.text };
        if (part.type !== 'image' || !profile.inputModalities.includes('image'))
          throw refused(`${profile.name} cannot receive this attachment. Gaming is text only.`);
        if (typeof part.image !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(part.image) ||
            !['image/png', 'image/jpeg', 'image/webp'].includes(part.mediaType ?? '') ||
            Buffer.from(part.image, 'base64').length > MODEL_IMAGE_LIMIT)
          throw refused('Bonsai images must be bounded project bytes, not an external URL.');
        return { type: 'image_url', image_url: { url: `data:${part.mediaType};base64,${part.image}` } };
      });
      return [{ role: 'user', content }];
    }
    if (message.role === 'tool') return message.content.map(part => {
      if (part.type !== 'tool-result' || !['json', 'text', 'error-text', 'error-json'].includes(part.output.type))
        throw refused('This tool result cannot be sent to Bonsai.');
      return { role: 'tool', tool_call_id: part.toolCallId,
        content: 'value' in part.output ? (typeof part.output.value === 'string' ? part.output.value : JSON.stringify(part.output.value)) : '' };
    });
    if (message.role !== 'assistant') throw refused('Unsupported Bonsai message.');
    const content: string[] = [], reasoning: string[] = [], calls: unknown[] = [];
    for (const part of message.content) {
      if (part.type === 'text') content.push(part.text);
      else if (part.type === 'reasoning') reasoning.push(part.text);
      else if (part.type === 'tool-call') calls.push({ id: part.toolCallId, type: 'function',
        function: { name: part.toolName, arguments: JSON.stringify(part.input) } });
      else throw refused('Unsupported Bonsai assistant content.');
    }
    return [{ role: 'assistant', content: content.join('') || null,
      ...(reasoning.length ? { reasoning_content: reasoning.join('') } : {}),
      ...(calls.length ? { tool_calls: calls } : {}) }];
  });
}

async function jsonRequest(route: string, payload: unknown, signal: AbortSignal, transport: typeof fetch,
  dispatched: boolean, maxBytes = 2_097_152): Promise<unknown> {
  signal.throwIfAborted();
  const response = await transport(`${BONSAI_BASE_URL}${route}`, { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload), redirect: 'error', signal });
  if (response.redirected || (response.status >= 300 && response.status < 400)) {
    await response.body?.cancel();
    throw refused('Bonsai returned a redirect. Nothing was sent to another address.', dispatched);
  }
  const reader = response.body?.getReader();
  if (!reader) throw refused('Bonsai returned no response.', dispatched);
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > maxBytes) throw refused('Bonsai returned more data than this request allows.', dispatched);
      chunks.push(value);
    }
  } finally { await reader.cancel(); reader.releaseLock(); }
  signal.throwIfAborted();
  if (!response.ok) throw refused(`Bonsai returned HTTP ${response.status}. Check its launcher logs.`, dispatched);
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw refused('Bonsai returned an invalid JSON response.', dispatched); }
}

const replySchema = z.object({ id: z.string(), model: z.literal(BONSAI_MODEL), usage: z.unknown(),
  choices: z.array(z.object({ finish_reason: z.enum(['stop', 'tool_calls']), message: z.object({
    content: z.string().nullish(), reasoning_content: z.string().nullish(),
    tool_calls: z.array(z.object({ id: z.string().min(1), type: z.literal('function'),
      function: z.object({ name: z.string(), arguments: z.string() }) })).max(1).optional(),
  }) })).length(1) });

export async function respondBonsai(input: {
  runtime: BonsaiRuntime; model: string; instructions: string; effort?: string;
  messages: ModelMessage[]; tools: readonly ToolDescriptor[]; signal: AbortSignal;
  limits?: RespondLimits; transport?: typeof fetch;
} & StreamSinks): Promise<BonsaiReply> {
  const profile = bonsaiProfile(input.model);
  if (!profile) throw refused('Choose a configured Bonsai profile.');
  const effort = input.effort ?? profile.defaultEffort!;
  if (!profile.efforts.some(item => item.id === effort)) throw refused('This Bonsai reasoning level is not supported.');
  const messages = [{ role: 'system', content: input.instructions }, ...bonsaiMessages(input.messages, profile.slug)];
  if (input.tools.length > 16 || new Set(input.tools.map(t => t.name)).size !== input.tools.length ||
      input.tools.some(t => !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(t.name))) throw refused('Invalid Bonsai tool descriptors.');
  const tools = input.tools.map(tool => ({ type: 'function', function: { name: tool.name,
    description: tool.description, parameters: tool.inputSchema } }));
  const limits = input.limits ?? bonsaiLimits(profile.slug);
  const max_tokens = Math.min(profile.maxOutputTokens, limits.maxOutputTokens);
  const body = { model: BONSAI_MODEL, messages, tools, tool_choice: 'auto', parallel_tool_calls: false,
    stream: false, max_tokens, reasoning_effort: effort,
    chat_template_kwargs: { reasoning_effort: effort }, cache_prompt: false };
  const imageCount = messages.reduce((n, m) => n + (Array.isArray(m.content) ? m.content.filter(p => p.type === 'image_url').length : 0), 0);
  const textMessages = messages.map(m => ({ ...m, content: Array.isArray(m.content)
    ? m.content.map(p => p.type === 'image_url' ? { type: 'text', text: '[image]' } : p) : m.content }));
  if (imageCount > MODEL_IMAGE_COUNT || Buffer.byteLength(JSON.stringify(body)) > 24_000_000 ||
      Buffer.byteLength(JSON.stringify({ ...body, messages: textMessages })) > limits.maxRequestBytes)
    throw refused('This message exceeds the Bonsai attachment or text limit.');
  let dispatched = false;
  try {
    return await input.runtime.use(profile.slug, input.signal, async (_profile, active) => {
      const signal = AbortSignal.any([active, AbortSignal.timeout(limits.callWallMs)]);
      const transport = input.transport ?? globalThis.fetch;
      // Tokenize the actual chat template before inference; reserve the launcher's 1024-token cap per image.
      const template = z.object({ prompt: z.string() }).parse(await jsonRequest('/apply-template',
        { ...body, messages: textMessages }, signal, transport, false));
      const tokens = z.object({ tokens: z.array(z.number().int()).max(1_000_000) }).parse(await jsonRequest('/tokenize',
        { content: template.prompt, add_special: true }, signal, transport, false, 12_000_000));
      if (tokens.tokens.length + imageCount * 1024 + max_tokens > profile.contextTokens)
        throw refused(`This message and its answer need more than ${profile.contextTokens.toLocaleString('en-US')} tokens. Start a new thread or reduce its sources.`);
      dispatched = true;
      const raw = await jsonRequest('/v1/chat/completions', body, signal, transport, true, limits.maxResponseBytes);
      const parsed = replySchema.safeParse(raw);
      if (!parsed.success) throw refused('Bonsai did not return a complete answer from the selected model. Its answer was not used.', true);
      const response = parsed.data, message = response.choices[0].message;
      const usage = chatUsage(response.usage).usage;
      if (!usage) throw refused('Bonsai returned no usable token accounting. Its answer was not used.', true);
      const call = message.tool_calls?.[0];
      const content: Exclude<Extract<ModelMessage, { role: 'assistant' }>['content'], string> = [];
      if (message.reasoning_content) { input.onReasoningDelta?.(message.reasoning_content); content.push({ type: 'reasoning', text: message.reasoning_content }); }
      if (message.content) content.push({ type: 'text', text: message.content });
      let outcome: BonsaiReply['outcome'];
      if (call) {
        if (!input.tools.some(tool => tool.name === call.function.name)) throw refused('Bonsai requested a tool this run did not offer.', true);
        let args: unknown;
        try { args = JSON.parse(call.function.arguments); } catch { throw refused('Bonsai returned invalid tool arguments.', true); }
        const data = z.record(z.string(), z.json()).safeParse(args);
        if (!data.success) throw refused('Bonsai returned invalid tool arguments.', true);
        content.push({ type: 'tool-call', toolCallId: call.id, toolName: call.function.name, input: data.data });
        outcome = { kind: 'tool', callId: call.id, name: call.function.name, input: data.data };
        input.onToolActivity?.({ callId: call.id, tool: call.function.name, phase: 'started', summary: call.function.name });
      } else {
        if (!message.content?.trim()) throw refused('Bonsai produced no final answer.', true);
        outcome = { kind: 'final', text: message.content };
        input.onDelta?.(message.content);
      }
      return { outcome, usage, rawUsage: { provider: response.usage, local: { profile: profile.slug, inferenceCostMicroUsd: 0 } },
        reportedModel: BONSAI_MODEL, responseId: response.id, providerRequestId: response.id,
        responseMessages: [{ role: 'assistant', content }], warnings: 0, servedBy: 'local' };
    });
  } catch (error) {
    if (error instanceof BonsaiError) throw new ModelApiError(`bonsai_${error.state}`, error.message, dispatched);
    throw error;
  }
}

export function createBonsaiAdapter(input: {
  runtime: BonsaiRuntime; model: string; instructions: string; effort?: string; transcripts: ModelTranscripts;
  images?: readonly ModelImage[]; loadImage?: (image: ModelImage) => Promise<string>;
  limits?: RespondLimits; transport?: typeof fetch; sinks?: StreamSinks;
}) {
  const profile = bonsaiProfile(input.model);
  if (!profile) throw refused('Choose a configured Bonsai profile.');
  const images = input.images ?? [];
  if (images.length && (!profile.inputModalities.includes('image') || !input.loadImage)) throw refused(`${profile.name} cannot receive images.`);
  return createModelApiAdapter({ route: BONSAI_ROUTE, prefix: 'bonsai', label: 'Bonsai', sdk: BONSAI_VERSION,
    protocol: 'local-chat-completions', contract: BONSAI_MODEL_CONTRACT, connectionId: BONSAI_CONNECTION, revision: 1,
    requestedModel: profile.slug, destination: 'local',
    profile: { model: profile.slug, alias: BONSAI_MODEL, mode: profile.mode, context: profile.contextTokens,
      effort: input.effort ?? profile.defaultEffort, account: BONSAI_ACCOUNT, images },
    transcripts: input.transcripts, notes: ['Local inference; tools remain owned by Nectovia Runtime and Trust.'],
    sinks: input.sinks,
    respond: async request => {
      const messages = structuredClone(request.messages);
      if (images.length) {
        const first = messages.find(m => m.role === 'user');
        if (!first || first.role !== 'user') throw refused('This image request has no user message.');
        const content = typeof first.content === 'string' ? [{ type: 'text' as const, text: first.content }] : [...first.content];
        for (const image of images) content.push({ type: 'image', image: await input.loadImage!(image), mediaType: image.mediaType });
        first.content = content;
      }
      // The private transcript saves the text and image identities, not duplicated base64 bytes.
      return respondBonsai({ ...input, ...request, messages });
    },
  });
}
