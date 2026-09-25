import { describe, expect, it } from 'vitest';
import { createOpenAI } from '@ai-sdk/openai';
import { jsonSchema, stepCountIs, streamText, tool, type ModelMessage } from 'ai';
import { validateResponsesBody } from '../src/managed-inference.js';
import { MANAGED_PROVIDERS, scriptedResponsesFetch } from '../src/managed-providers.js';

const MODEL = MANAGED_PROVIDERS[0].model;

/**
 * The desktop's nectovia route is `@ai-sdk/openai`'s responses() model with the
 * AWS binding's providerOptions (server/engines/aws-bedrock.ts, awsBinding).
 * These are those options, verbatim, at the Efficient tier's effort.
 */
const AWS_BINDING_PROVIDER_OPTIONS = {
  openai: {
    forceReasoning: true,
    systemMessageMode: 'developer',
    include: ['reasoning.encrypted_content'],
    reasoningEffort: 'low',
    reasoningSummary: null,
    store: false,
    parallelToolCalls: false,
  },
};

/** The scripted provider behind a recorder: every body the SDK sends is kept. */
function capturing() {
  const bodies: Record<string, unknown>[] = [];
  const scripted = scriptedResponsesFetch();
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return scripted(input, init);
  }) as typeof globalThis.fetch;
  const model = createOpenAI({ name: 'nectovia', baseURL: 'http://faux.local/managed/v1', apiKey: 'placeholder', fetch }).responses(MODEL);
  return { bodies, model };
}

const readFile = tool({
  description: 'Read a project file.',
  inputSchema: jsonSchema({ type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false }),
});

describe('the body the real SDK sends is inside the allowlist', () => {
  it('accepts both turns of a tool loop: the first request, and the one carrying the prior call, its reasoning and its result', async () => {
    const { bodies, model } = capturing();
    const common = {
      model,
      system: 'You are the Nectovia agent for Juniper Street Bakery.',
      tools: { read_file: readFile },
      toolChoice: 'auto' as const,
      maxOutputTokens: 4_096,
      maxRetries: 0,
      stopWhen: stepCountIs(1),
      providerOptions: AWS_BINDING_PROVIDER_OPTIONS as never,
    };
    const opening: ModelMessage[] = [{
      role: 'user',
      content: [
        { type: 'text', text: 'What does the notes file say? [[tool:read_file {"path":"notes.txt"}]]' },
        { type: 'file', data: new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), mediaType: 'image/png' },
      ],
    }];
    const first = streamText({ ...common, messages: opening });
    const [call] = await first.toolCalls;
    expect(call).toMatchObject({ toolName: 'read_file', input: { path: 'notes.txt' } });
    const history: ModelMessage[] = [
      ...opening,
      ...((await first.response).messages as ModelMessage[]),
      { role: 'tool', content: [{ type: 'tool-result', toolCallId: call.toolCallId, toolName: 'read_file', output: { type: 'text', value: 'Order more rye flour.' } }] },
    ];
    const second = streamText({ ...common, messages: history });
    await second.text;

    expect(bodies).toHaveLength(2);
    for (const body of bodies) expect(validateResponsesBody(body)).toMatchObject({ ok: true });
    // The second request really carries what the allowlist has to admit.
    const kinds = (bodies[1].input as Record<string, unknown>[]).map((item) => item.type ?? `message:${String(item.role)}`);
    expect(kinds).toEqual(['message:developer', 'message:user', 'reasoning', 'function_call', 'function_call_output']);
    const reasoning = (bodies[1].input as Record<string, unknown>[])[2];
    expect(reasoning).toMatchObject({ type: 'reasoning', id: expect.stringMatching(/^rs_/), encrypted_content: expect.stringMatching(/^scripted-reasoning-/), summary: [] });
    const image = ((bodies[0].input as Record<string, unknown>[])[1].content as Record<string, unknown>[])[1];
    expect(image).toMatchObject({ type: 'input_image', image_url: expect.stringMatching(/^data:image\/png;base64,/) });
    expect(bodies[1]).toMatchObject({ store: false, stream: true, parallel_tool_calls: false, include: ['reasoning.encrypted_content'], reasoning: { effort: 'low' } });
  });

  it('accepts an assistant answer carried back as history, and json_schema output', async () => {
    const { bodies, model } = capturing();
    const first = streamText({ model, messages: [{ role: 'user', content: 'Say hello.' }], maxRetries: 0, stopWhen: stepCountIs(1), providerOptions: AWS_BINDING_PROVIDER_OPTIONS as never });
    await first.text;
    const second = streamText({
      model,
      messages: [{ role: 'user', content: 'Say hello.' }, ...((await first.response).messages as ModelMessage[]), { role: 'user', content: 'Again, as JSON.' }],
      maxRetries: 0, stopWhen: stepCountIs(1), providerOptions: AWS_BINDING_PROVIDER_OPTIONS as never,
    });
    await second.text;
    expect(validateResponsesBody(bodies[1])).toMatchObject({ ok: true });
    expect((bodies[1].input as Record<string, unknown>[]).some((item) => item.role === 'assistant' && typeof item.content === 'string')).toBe(true);
    expect(validateResponsesBody({ ...bodies[1], text: { format: { type: 'json_schema', name: 'answer', schema: { type: 'object' }, strict: true } } }))
      .toMatchObject({ ok: true });
  });
});

const base = () => ({
  model: MODEL,
  input: [{ role: 'user', content: [{ type: 'input_text', text: 'Hello.' }] }],
});
const refusal = (body: unknown) => validateResponsesBody(body) as { ok: false; code: string; field: string; message: string };

describe('everything outside the allowlist is refused by name', () => {
  it.each([
    'temperature', 'top_p', 'top_logprobs', 'previous_response_id', 'conversation', 'background', 'metadata', 'user', 'service_tier',
    'truncation', 'prompt', 'prompt_cache_key', 'prompt_cache_retention', 'safety_identifier', 'max_tool_calls', 'stream_options', 'context_management',
  ])('refuses the top-level field %s', (field) => {
    expect(refusal({ ...base(), [field]: field === 'metadata' ? {} : 1 })).toMatchObject({ ok: false, code: 'unsupported_field', field });
  });

  it.each([
    ['store: true', { store: true }, 'store'],
    ['stream: false', { stream: false }, 'stream'],
    ['parallel tool calls', { parallel_tool_calls: true }, 'parallel_tool_calls'],
    ['another include', { include: ['file_search_call.results'] }, 'include'],
    ['an extra include', { include: ['reasoning.encrypted_content', 'message.output_text.logprobs'] }, 'include'],
    ['an unlisted effort', { reasoning: { effort: 'minimal' } }, 'reasoning.effort'],
    ['a reasoning summary', { reasoning: { effort: 'low', summary: 'auto' } }, 'reasoning.summary'],
    ['text verbosity', { text: { format: { type: 'text' }, verbosity: 'low' } }, 'text.verbosity'],
    ['json_object output', { text: { format: { type: 'json_object' } } }, 'text.format.type'],
    ['a json_schema description', { text: { format: { type: 'json_schema', name: 'a', schema: {}, description: 'x' } } }, 'text.format.description'],
  ])('refuses %s', (_label, extra, field) => {
    expect(refusal({ ...base(), ...extra })).toMatchObject({ ok: false, code: 'unsupported_field', field });
  });

  it.each([
    ['an item reference', { type: 'item_reference', id: 'msg_1' }, 'input[0].type'],
    ['a file input', { role: 'user', content: [{ type: 'input_file', file_id: 'file-1' }] }, 'input[0].content[0].type'],
    ['an uploaded image id', { role: 'user', content: [{ type: 'input_image', file_id: 'file-1' }] }, 'input[0].content[0].file_id'],
    ['a remote image URL', { role: 'user', content: [{ type: 'input_image', image_url: 'https://example.test/cat.png' }] }, 'input[0].content[0].image_url'],
    ['an image detail', { role: 'user', content: [{ type: 'input_image', image_url: 'data:image/png;base64,AAAA', detail: 'high' }] }, 'input[0].content[0].detail'],
    ['a tool role', { role: 'tool', content: 'x' }, 'input[0].role'],
    ['a message phase', { role: 'assistant', content: 'Done.', phase: 'final_answer' }, 'input[0].phase'],
    ['a message id', { type: 'message', id: 'msg_1', role: 'assistant', content: 'Done.' }, 'input[0].id'],
    ['a namespaced call', { type: 'function_call', call_id: 'c', name: 'n', arguments: '{}', namespace: 'x' }, 'input[0].namespace'],
    ['an async call', { type: 'function_call', call_id: 'c', name: 'n', arguments: '{}', async: true }, 'input[0].async'],
    ['reasoning without encrypted content', { type: 'reasoning', id: 'rs_1', summary: [] }, 'input[0].encrypted_content'],
    ['a web search call', { type: 'web_search_call', id: 'ws_1', status: 'completed' }, 'input[0].type'],
    ['a remote image in a tool result', { type: 'function_call_output', call_id: 'c', output: [{ type: 'input_image', image_url: 'http://example.test/a.png' }] }, 'input[0].output[0].image_url'],
  ])('refuses %s in the input', (_label, item, field) => {
    expect(refusal({ ...base(), input: [item] })).toMatchObject({ ok: false, code: 'unsupported_field', field });
  });

  it.each(['web_search', 'web_search_preview', 'file_search', 'computer_use_preview', 'mcp', 'code_interpreter', 'image_generation', 'local_shell', 'custom'])(
    'refuses the built-in tool %s', (type) => {
      expect(refusal({ ...base(), tools: [{ type }] })).toMatchObject({ ok: false, code: 'unsupported_field', field: 'tools[0].type' });
    });

  it('refuses an unknown key on a function tool, and a tool choice that is not a listed function', () => {
    const fn = { type: 'function', name: 'read_file', parameters: { type: 'object' } };
    expect(refusal({ ...base(), tools: [{ ...fn, defer_loading: true }] })).toMatchObject({ code: 'unsupported_field', field: 'tools[0].defer_loading' });
    expect(refusal({ ...base(), tools: [fn], tool_choice: { type: 'web_search' } })).toMatchObject({ code: 'unsupported_field', field: 'tool_choice.type' });
    expect(refusal({ ...base(), tools: [fn], tool_choice: { type: 'function', name: 'other' } })).toMatchObject({ code: 'invalid_body', field: 'tool_choice.name' });
    expect(refusal({ ...base(), tools: [fn], tool_choice: 'sometimes' })).toMatchObject({ code: 'unsupported_field', field: 'tool_choice' });
    expect(validateResponsesBody({ ...base(), tools: [fn], tool_choice: { type: 'function', name: 'read_file' } })).toMatchObject({ ok: true });
  });

  it('bounds the tools: at most 64, each at most 16 KB serialized, unique names', () => {
    const fn = (name: string) => ({ type: 'function', name, parameters: { type: 'object' } });
    expect(validateResponsesBody({ ...base(), tools: Array.from({ length: 64 }, (_, i) => fn(`t${i}`)) })).toMatchObject({ ok: true });
    expect(refusal({ ...base(), tools: Array.from({ length: 65 }, (_, i) => fn(`t${i}`)) })).toMatchObject({ code: 'invalid_body', field: 'tools' });
    expect(refusal({ ...base(), tools: [{ ...fn('big'), description: 'x'.repeat(16_384) }] })).toMatchObject({ code: 'invalid_body', field: 'tools[0]' });
    expect(refusal({ ...base(), tools: [fn('a'), fn('a')] })).toMatchObject({ code: 'invalid_body', field: 'tools[1].name' });
  });

  it('calls a malformed value invalid, not unsupported', () => {
    expect(refusal([])).toMatchObject({ code: 'invalid_body', field: 'body' });
    expect(refusal({ input: base().input })).toMatchObject({ code: 'invalid_body', field: 'model' });
    expect(refusal({ model: MODEL, input: 'Hello.' })).toMatchObject({ code: 'invalid_body', field: 'input' });
    expect(refusal({ model: MODEL, input: [] })).toMatchObject({ code: 'invalid_body', field: 'input' });
    expect(refusal({ ...base(), max_output_tokens: 0 })).toMatchObject({ code: 'invalid_body', field: 'max_output_tokens' });
    expect(refusal({ ...base(), max_output_tokens: 1.5 })).toMatchObject({ code: 'invalid_body', field: 'max_output_tokens' });
    expect(refusal({ ...base(), instructions: 7 })).toMatchObject({ code: 'invalid_body', field: 'instructions' });
    expect(refusal({ ...base(), input: [{ role: 'user', content: [{ type: 'input_text', text: 3 }] }] })).toMatchObject({ code: 'invalid_body', field: 'input[0].content[0].text' });
  });

  it('keeps each refusal a plain sentence that names the field', () => {
    const result = refusal({ ...base(), temperature: 0.2 });
    expect(result.message).toMatch(/temperature/);
    expect(result.message).toMatch(/\.$/);
  });
});
