import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ModelRequest, ToolDescriptor } from '../shared/harness.js';
import {
  createBedrockModelAdapter,
  type SdkTranscript,
} from '../server/harness/vercel-model-adapter.js';

const profile = {
  id: 'bedrock-luna',
  accountRoute: 'aws:test-account',
  region: 'us-east-1',
  modelId: 'us.openai.gpt-5.6-luna',
  maxOutputTokens: 256,
};
const request: ModelRequest = {
  runId: 'run-test',
  capabilityId: 'test-capability',
  messages: [{ role: 'user', text: 'Say hello.' }],
  tools: [],
  transcript: null,
};
const lookup: ToolDescriptor = {
  name: 'lookup',
  version: '1',
  description: 'Read a recorded item.',
  effect: 'read',
  permission: null,
  approval: false,
  destination: 'local',
  trustedInputRequired: false,
  cost: 0,
  inputSchema: {
    type: 'object',
    properties: { id: { type: 'string' } },
    required: ['id'],
    additionalProperties: false,
  },
};
const response = (content: unknown[] = [{ text: 'Hello.' }], stopReason = 'end_turn') =>
  Response.json({
    output: { message: { role: 'assistant', content } },
    stopReason,
    usage: { inputTokens: 12, outputTokens: 3, totalTokens: 15 },
    metrics: { latencyMs: 1 },
  });

function setup(fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response()), extra = {}) {
  const saved: SdkTranscript[] = [];
  const transcripts = {
    save: vi.fn(async (value: SdkTranscript) => {
      saved.push(value);
      return {
        providerId: 'amazon-bedrock',
        modelId: null,
        lineageId: request.runId,
        opaqueRef: String(saved.length),
        prefixHash: 'test-prefix',
      };
    }),
    read: vi.fn(async () => {
      const value = saved.at(-1);
      if (!value) throw new Error('No fixture transcript');
      return value;
    }),
  };
  const adapter = createBedrockModelAdapter({
    profile,
    credentials: { kind: 'bearer', apiKey: 'synthetic-bedrock-key' },
    transcripts,
    fetch,
    ...extra,
  });
  return { adapter, fetch, transcripts, saved };
}

afterEach(() => vi.unstubAllEnvs());

describe('Bedrock through the real Vercel SDK', () => {
  it('uses the explicit AWS endpoint, model and key and returns measured usage', async () => {
    vi.stubEnv('AI_GATEWAY_API_KEY', 'never-use-gateway');
    vi.stubEnv('AWS_BEARER_TOKEN_BEDROCK', 'never-use-ambient-payer');
    const { adapter, fetch, transcripts } = setup();
    const result = await adapter.complete(request, new AbortController().signal);
    expect(result.response).toEqual({ type: 'final', text: 'Hello.' });
    expect(result.usage).toEqual({ inputTokens: 12, outputTokens: 3 });
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0];
    expect(String(url)).toBe(
      'https://bedrock-runtime.us-east-1.amazonaws.com/model/us.openai.gpt-5.6-luna/converse',
    );
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer synthetic-bedrock-key');
    expect(init?.redirect).toBe('error');
    expect(JSON.parse(String(init?.body)).inferenceConfig.maxTokens).toBe(256);
    expect(transcripts.save).toHaveBeenCalledTimes(1);
  });

  it('refuses missing explicit credentials before an ambient account can be used', () => {
    vi.stubEnv('AWS_BEARER_TOKEN_BEDROCK', 'ambient-key');
    expect(() => setup(undefined, { credentials: { kind: 'bearer', apiKey: '' } })).toThrow(
      /credential/i,
    );
  });

  it('does not retry a retryable provider failure or expose its raw message', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(
        Response.json({ message: 'synthetic-bedrock-key private failure' }, { status: 503 }),
      );
    const { adapter } = setup(fetch);
    await expect(adapter.complete(request, new AbortController().signal)).rejects.toMatchObject({
      code: 'sdk_provider_error',
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('never dispatches a cancelled request', async () => {
    const { adapter, fetch } = setup();
    const signal = AbortSignal.abort();
    await expect(adapter.complete(request, signal)).rejects.toMatchObject({
      code: 'sdk_cancelled',
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('returns a single offered tool proposal without executing it', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(
        response(
          [{ toolUse: { toolUseId: 'tool-1', name: 'lookup', input: { id: 'item-1' } } }],
          'tool_use',
        ),
      );
    const { adapter } = setup(fetch);
    const result = await adapter.complete(
      { ...request, tools: [lookup] },
      new AbortController().signal,
    );
    expect(result.response).toEqual({ type: 'tool', name: 'lookup', input: { id: 'item-1' } });
    expect(fetch).toHaveBeenCalledTimes(1);
    const body = JSON.parse(String(fetch.mock.calls[0][1]?.body));
    expect(body.toolConfig.tools[0].toolSpec.name).toBe('lookup');
  });

  it('refuses every proposal when a provider returns multiple tools', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(
        response(
          [
            { toolUse: { toolUseId: 'tool-1', name: 'lookup', input: { id: '1' } } },
            { toolUse: { toolUseId: 'tool-2', name: 'lookup', input: { id: '2' } } },
          ],
          'tool_use',
        ),
      );
    const { adapter, transcripts } = setup(fetch);
    await expect(
      adapter.complete({ ...request, tools: [lookup] }, new AbortController().signal),
    ).rejects.toMatchObject({
      code: 'sdk_multiple_tools',
      usage: { inputTokens: 12, outputTokens: 3 },
    });
    expect(transcripts.save).not.toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['empty', [], 'end_turn', 'sdk_empty_output'],
    ['refused', [{ text: 'Refused.' }], 'guardrail_intervened', 'sdk_refused'],
    ['truncated', [{ text: 'Incomplete' }], 'max_tokens', 'sdk_incomplete_output'],
  ])('distinguishes %s output from a completed answer', async (_label, content, stop, code) => {
    const { adapter } = setup(
      vi
        .fn<typeof globalThis.fetch>()
        .mockResolvedValue(response(content as unknown[], String(stop))),
    );
    await expect(adapter.complete(request, new AbortController().signal)).rejects.toMatchObject({
      code,
    });
  });

  it('bounds output by UTF-8 bytes', async () => {
    const { adapter } = setup(
      vi.fn<typeof globalThis.fetch>().mockResolvedValue(response([{ text: '界'.repeat(30) }])),
      { profile: { ...profile, maxOutputBytes: 64 } },
    );
    await expect(adapter.complete(request, new AbortController().signal)).rejects.toMatchObject({
      code: 'sdk_output_too_large',
    });
  });

  it('uses explicit SigV4 credentials despite ambient bearer and session credentials', async () => {
    vi.stubEnv('AWS_BEARER_TOKEN_BEDROCK', 'ambient-key');
    vi.stubEnv('AWS_SESSION_TOKEN', 'ambient-session');
    const { adapter, fetch } = setup(undefined, {
      credentials: {
        kind: 'sigv4',
        accessKeyId: 'EXPLICITTESTKEY',
        secretAccessKey: 'synthetic-secret-key',
      },
    });
    await adapter.complete(request, new AbortController().signal);
    const [input, init] = fetch.mock.calls[0];
    const sent = new Request(input, init);
    expect(sent.headers.get('authorization')).toContain('Credential=EXPLICITTESTKEY/');
    expect(sent.headers.get('authorization')).not.toContain('ambient');
    expect(sent.headers.get('x-amz-security-token')).toBeNull();
  });

  it('cancels a pending response reader when the caller aborts', async () => {
    let opened!: () => void;
    const ready = new Promise<void>((resolve) => {
      opened = resolve;
    });
    let body!: ReadableStreamDefaultController<Uint8Array>;
    const cancel = vi.fn();
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              body = controller;
            },
            pull() {
              opened();
            },
            cancel,
          }),
          { headers: { 'content-type': 'application/json' } },
        ),
    );
    const { adapter } = setup(fetch);
    const controller = new AbortController();
    const result = adapter
      .complete(request, controller.signal)
      .catch((error: { code: string }) => error.code);
    await ready;
    controller.abort();
    const observed = await Promise.race([
      result,
      new Promise<string>((resolve) => setTimeout(() => resolve('timed-out'), 250)),
    ]);
    if (observed === 'timed-out') body.error(new Error('fixture cleanup'));
    await result;
    expect(observed).toBe('sdk_cancelled');
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('keeps signed reasoning private while continuing the exact authorized tool result', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(
        response(
          [
            {
              reasoningContent: {
                reasoningText: { text: 'private-reasoning', signature: 'signed-private-block' },
              },
            },
            { toolUse: { toolUseId: 'tool-1', name: 'lookup', input: { id: '1' } } },
          ],
          'tool_use',
        ),
      )
      .mockResolvedValueOnce(response([{ text: 'Recorded quantity: 4.' }]));
    const { adapter, saved } = setup(fetch);
    const first = await adapter.complete(
      { ...request, tools: [lookup] },
      new AbortController().signal,
    );
    expect(JSON.stringify(first)).not.toContain('private-reasoning');
    expect(JSON.stringify(saved[0].messages)).toContain('signed-private-block');
    const second = await adapter.complete(
      {
        ...request,
        tools: [lookup],
        transcript: first.transcript!,
        messages: [
          ...request.messages,
          { role: 'assistant', tool: 'lookup', input: { id: '1' } },
          { role: 'tool', name: 'lookup', output: { quantity: 4 } },
        ],
      },
      new AbortController().signal,
    );
    expect(second.response).toEqual({ type: 'final', text: 'Recorded quantity: 4.' });
    const body = JSON.parse(String(fetch.mock.calls[1][1]?.body));
    expect(JSON.stringify(body.messages)).toContain('signed-private-block');
    expect(body.messages.at(-1).content[0].toolResult.toolUseId).toBe('tool-1');
  });

  it('rejects resuming a continuation under another payer before dispatch', async () => {
    const first = setup();
    const answer = await first.adapter.complete(request, new AbortController().signal);
    const next = setup(undefined, {
      profile: { ...profile, accountRoute: 'aws:other-account' },
      transcripts: first.transcripts,
    });
    await expect(
      next.adapter.complete(
        {
          ...request,
          transcript: answer.transcript!,
          messages: [
            ...request.messages,
            { role: 'assistant', text: 'Hello.' },
            { role: 'user', text: 'Continue' },
          ],
        },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: 'sdk_transcript_mismatch' });
    expect(next.fetch).not.toHaveBeenCalled();
  });

  it('rejects an unoffered tool without saving a usable continuation', async () => {
    const { adapter, transcripts } = setup(
      vi
        .fn<typeof globalThis.fetch>()
        .mockResolvedValue(
          response(
            [{ toolUse: { toolUseId: 'evil', name: 'delete_everything', input: {} } }],
            'tool_use',
          ),
        ),
    );
    await expect(adapter.complete(request, new AbortController().signal)).rejects.toMatchObject({
      code: 'sdk_invalid_tool',
    });
    expect(transcripts.save).not.toHaveBeenCalled();
  });

  it('rejects non-object tool input without saving a continuation', async () => {
    const { adapter, transcripts } = setup(
      vi
        .fn<typeof globalThis.fetch>()
        .mockResolvedValue(
          response(
            [{ toolUse: { toolUseId: 'bad-input', name: 'lookup', input: ['not-an-object'] } }],
            'tool_use',
          ),
        ),
    );
    await expect(
      adapter.complete({ ...request, tools: [lookup] }, new AbortController().signal),
    ).rejects.toMatchObject({ code: 'sdk_invalid_tool' });
    expect(transcripts.save).not.toHaveBeenCalled();
  });

  it('decodes multibyte output split across transport chunks without corrupting it', async () => {
    const bytes = new Uint8Array(await response([{ text: 'Hello, 世界.' }]).arrayBuffer());
    const { adapter } = setup(
      vi.fn<typeof globalThis.fetch>().mockResolvedValue(
        new Response(
          new ReadableStream({
            start(controller) {
              for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
              controller.close();
            },
          }),
          { headers: { 'content-type': 'application/json' } },
        ),
      ),
    );
    expect((await adapter.complete(request, new AbortController().signal)).response).toEqual({
      type: 'final',
      text: 'Hello, 世界.',
    });
  });

  it('rejects changed prepared model profiles before dispatch', async () => {
    const first = setup();
    const prepared = await first.adapter.prepare!(request, new AbortController().signal);
    const next = setup(undefined, { profile: { ...profile, accountRoute: 'aws:changed' } });
    await expect(
      next.adapter.complete(prepared, new AbortController().signal),
    ).rejects.toMatchObject({ code: 'sdk_profile_changed', dispatched: false });
    expect(next.fetch).not.toHaveBeenCalled();
  });
});
