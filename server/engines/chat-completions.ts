/**
 * Reading a Chat Completions answer as data, shared by every route that speaks the protocol
 * (OpenRouter, and the direct AWS Bedrock route for Kimi K3). The stream is read from the
 * provider's own bytes, never from what the SDK's schema happens to accept.
 *
 * Fields one provider adds are read where they appear and are simply absent elsewhere:
 * OpenRouter names the upstream that served a call (`chunk.provider`, kept as `servedBy`) and
 * says when a provider key paid for it (`usage.is_byok`, kept as `otherPayer`).
 */
import { z } from 'zod';
import type { ProviderUsage } from '../spend-exposure.js';
import { bounded, consistentUsage, str, type ClassifiedEnvelope, type StreamEnvelope } from './model-api-core.js';

const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const chatUsageSchema = z.object({
  prompt_tokens: count,
  completion_tokens: count,
  prompt_tokens_details: z.object({ cached_tokens: count.nullish(), cache_write_tokens: count.nullish() }).nullish(),
  completion_tokens_details: z.object({ reasoning_tokens: count.nullish() }).nullish(),
  is_byok: z.boolean().nullish(),
});

/** Chat-completions usage in the ledger's structure. */
export function chatUsage(raw: unknown): { usage: ProviderUsage | null; byok: boolean } {
  const parsed = chatUsageSchema.safeParse(raw);
  if (!parsed.success) return { usage: null, byok: false };
  return {
    byok: parsed.data.is_byok === true,
    usage: consistentUsage({
      inputTokens: parsed.data.prompt_tokens,
      cacheReadTokens: parsed.data.prompt_tokens_details?.cached_tokens ?? 0,
      cacheWriteTokens: parsed.data.prompt_tokens_details?.cache_write_tokens ?? 0,
      outputTokens: parsed.data.completion_tokens,
      reasoningTokens: parsed.data.completion_tokens_details?.reasoning_tokens ?? 0,
    }),
  };
}

const record = (value: unknown) =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;

/**
 * Reads a Chat Completions stream as data: content joins, each tool call is folded
 * by its index, the last finish reason and the usage chunk decide the rest. A
 * plain JSON body is an error answer.
 */
export function classifyChat(envelope: StreamEnvelope): { readable: boolean; classified: ClassifiedEnvelope | null } {
  const result: ClassifiedEnvelope = {
    status: null,
    responseId: null,
    reportedModel: null,
    usage: null,
    text: '',
    refusal: null,
    functionCalls: [],
    unexpectedItems: [],
    incompleteReason: null,
    providerError: null,
    servedBy: null,
    otherPayer: false,
  };
  if (!envelope.readable) return { readable: false, classified: null };
  const readError = (value: Record<string, unknown> | null) => {
    const error = record(value?.error);
    if (error)
      result.providerError ??= {
        code: error.code == null ? null : String(error.code),
        message: bounded(str(error.message) ?? 'Unknown provider error.'),
      };
  };
  if (!envelope.events) {
    readError(record(envelope.body));
    if (!result.providerError) return { readable: false, classified: null };
    result.status = 'failed';
    return { readable: true, classified: result };
  }
  const calls = new Map<number, { callId: string; name: string; arguments: string }>();
  let finish: string | null = null;
  let sawChoice = false;
  for (const event of envelope.events) {
    const chunk = record(event);
    if (!chunk) {
      result.unexpectedItems.push('chunk:not-an-object');
      continue;
    }
    readError(chunk);
    result.responseId ??= str(chunk.id);
    result.reportedModel ??= str(chunk.model);
    result.servedBy ??= str(chunk.provider);
    if (chunk.usage != null) {
      const { usage, byok } = chatUsage(chunk.usage);
      result.usage = usage;
      if (byok) result.otherPayer = true;
    }
    const choices = Array.isArray(chunk.choices) ? chunk.choices : [];
    for (const raw of choices) {
      const choice = record(raw);
      if (!choice) continue;
      if (choice.index != null && choice.index !== 0) {
        result.unexpectedItems.push('choice:extra');
        continue;
      }
      sawChoice = true;
      if (typeof choice.finish_reason === 'string') finish = choice.finish_reason;
      const delta = record(choice.delta);
      if (!delta) continue;
      if (typeof delta.content === 'string') result.text += delta.content;
      if (typeof delta.refusal === 'string' && delta.refusal) result.refusal ??= bounded(delta.refusal);
      if (Array.isArray(delta.images) && delta.images.length) result.unexpectedItems.push('images');
      if (Array.isArray(delta.annotations) && delta.annotations.length) result.unexpectedItems.push('annotations');
      if (Array.isArray(delta.tool_calls))
        for (const rawCall of delta.tool_calls) {
          const call = record(rawCall);
          if (!call) continue;
          if (call.type != null && call.type !== 'function') {
            result.unexpectedItems.push(`tool_call:${String(call.type)}`);
            continue;
          }
          const index = typeof call.index === 'number' ? call.index : 0;
          const fn = record(call.function);
          const current = calls.get(index) ?? { callId: '', name: '', arguments: '' };
          if (typeof call.id === 'string' && call.id) current.callId ||= call.id;
          if (typeof fn?.name === 'string' && fn.name) current.name ||= fn.name;
          if (typeof fn?.arguments === 'string') current.arguments += fn.arguments;
          calls.set(index, current);
        }
    }
  }
  result.functionCalls = [...calls.entries()].sort(([a], [b]) => a - b).map(([, call]) => call);
  if (result.providerError) result.status = 'failed';
  else if (!sawChoice) result.status = null;
  else if (finish === 'stop' || finish === 'tool_calls') result.status = 'completed';
  else if (finish === 'length') {
    result.status = 'incomplete';
    result.incompleteReason = 'max_output_tokens';
  } else if (finish === 'content_filter') {
    result.status = 'incomplete';
    result.incompleteReason = 'content_filter';
  } else if (finish === 'error') result.providerError = { code: 'finish_error', message: 'The upstream endpoint reported an error.' };
  else if (finish) {
    result.status = 'incomplete';
    result.incompleteReason = finish;
  }
  return { readable: true, classified: result };
}

/** The usage a failed call can still be settled from: the last usage chunk the stream carried. */
export function chatEnvelopeUsage(envelope: StreamEnvelope): ProviderUsage | null {
  if (!envelope.readable || !envelope.events) return null;
  let usage: ProviderUsage | null = null;
  for (const event of envelope.events) {
    const chunk = record(event);
    if (chunk?.usage != null) usage = chatUsage(chunk.usage).usage;
  }
  return usage;
}
