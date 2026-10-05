/**
 * The Chat Completions reading shared by OpenRouter and the direct AWS route (Kimi K3). Every
 * stream here is a captured-shape fixture; nothing reaches a network.
 */
import { describe, expect, test } from 'vitest';
import * as chat from '../server/engines/chat-completions.js';
import { parseEventStream, type StreamEnvelope } from '../server/engines/model-api-core.js';
import * as openrouter from '../server/engines/openrouter.js';
import { chatEvents } from './fixtures/model-api-streams.js';

const K3 = 'us.moonshotai.kimi-k3';
const streamed = (text: string, status = 200): StreamEnvelope => {
  const parsed = parseEventStream(text);
  return { status, bytes: text.length, body: null, events: parsed.events, readable: parsed.readable, providerRequestId: null };
};
const json = (body: unknown, status: number): StreamEnvelope => ({
  status,
  bytes: JSON.stringify(body).length,
  body,
  events: null,
  readable: true,
  providerRequestId: null,
});

describe('the shared Chat Completions reader', () => {
  test('OpenRouter re-exports the same functions, unchanged', () => {
    expect(openrouter.chatUsage).toBe(chat.chatUsage);
    expect(openrouter.classifyChat).toBe(chat.classifyChat);
    expect(openrouter.chatEnvelopeUsage).toBe(chat.chatEnvelopeUsage);
  });

  test('reads usage with cache reads, cache writes and reasoning kept apart; a partial report is no usage', () => {
    expect(
      chat.chatUsage({
        prompt_tokens: 1_600,
        completion_tokens: 40,
        prompt_tokens_details: { cached_tokens: 1_024, cache_write_tokens: 512 },
        completion_tokens_details: { reasoning_tokens: 30 },
      }),
    ).toEqual({
      byok: false,
      usage: { inputTokens: 1_600, cacheReadTokens: 1_024, cacheWriteTokens: 512, outputTokens: 40, reasoningTokens: 30 },
    });
    expect(chat.chatUsage({ prompt_tokens: 10 })).toEqual({ usage: null, byok: false });
    expect(chat.chatUsage({ prompt_tokens: 10, completion_tokens: 2, is_byok: true }).byok).toBe(true);
  });

  test('a direct AWS stream carries no OpenRouter fields: no named upstream and no other payer', () => {
    const { readable, classified } = chat.classifyChat(
      streamed(chatEvents({ id: 'chatcmpl-1', model: K3, text: 'OK', usage: { prompt_tokens: 20, completion_tokens: 2, total_tokens: 22 } })),
    );
    expect(readable).toBe(true);
    expect(classified).toMatchObject({
      status: 'completed',
      responseId: 'chatcmpl-1',
      reportedModel: K3,
      text: 'OK',
      servedBy: null,
      otherPayer: false,
      usage: { inputTokens: 20, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 },
    });
  });

  test('an OpenRouter stream keeps the upstream that served it and who paid', () => {
    const { classified } = chat.classifyChat(
      streamed(
        chatEvents({
          model: 'anthropic/claude-test',
          provider: 'Anthropic',
          text: 'OK',
          usage: { prompt_tokens: 20, completion_tokens: 2, total_tokens: 22, is_byok: true },
        }),
      ),
    );
    expect(classified).toMatchObject({ servedBy: 'Anthropic', otherPayer: true });
  });

  test('a length finish is incomplete at the output limit, and its usage can still be settled', () => {
    const envelope = streamed(
      chatEvents({ model: K3, text: 'The prime', finishReason: 'length', usage: { prompt_tokens: 70, completion_tokens: 300, total_tokens: 370 } }),
    );
    expect(chat.classifyChat(envelope).classified).toMatchObject({ status: 'incomplete', incompleteReason: 'max_output_tokens' });
    expect(chat.chatEnvelopeUsage(envelope)).toMatchObject({ inputTokens: 70, outputTokens: 300 });
  });

  test('a tool call is folded from its deltas', () => {
    const { classified } = chat.classifyChat(
      streamed(
        chatEvents({
          model: K3,
          toolCalls: [{ id: 'call_1', name: 'lookup_fact', arguments: '{"key":"alpha"}' }],
          usage: { prompt_tokens: 90, completion_tokens: 30, total_tokens: 120 },
        }),
      ),
    );
    expect(classified).toMatchObject({
      status: 'completed',
      functionCalls: [{ callId: 'call_1', name: 'lookup_fact', arguments: '{"key":"alpha"}' }],
    });
  });

  test('a JSON error body is a provider error with no usage', () => {
    const envelope = json(
      { error: { message: 'Unrecognized request argument supplied: prompt_cache_options', code: 'invalid_request_error' } },
      400,
    );
    expect(chat.classifyChat(envelope)).toEqual({
      readable: true,
      classified: expect.objectContaining({
        status: 'failed',
        providerError: { code: 'invalid_request_error', message: 'Unrecognized request argument supplied: prompt_cache_options' },
      }),
    });
    expect(chat.chatEnvelopeUsage(envelope)).toBeNull();
    expect(chat.classifyChat(json({ unexpected: true }, 500))).toEqual({ readable: false, classified: null });
  });
});
