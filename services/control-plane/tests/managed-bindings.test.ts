import { describe, expect, it } from 'vitest';
import { createOpenAI } from '@ai-sdk/openai';
import { jsonSchema, streamText, tool, type ModelMessage } from 'ai';
import { callManagedProvider, providerBody, approvedConnections, providerEndpoint } from '../src/managed-bindings.js';
import { sseObjects } from '../src/managed-normalization.js';
import type { ResponsesBody } from '../src/managed-inference.js';
import type { CatalogRoute, ModelBinding, ProviderConnection, ManagedProtocol } from '../../../shared/routing-policy.js';

const encoder = new TextEncoder();
const credential = 'synthetic-test-key';
const request: ResponsesBody = { model: 'fixture', input: [{ role: 'user', content: 'Read notes.' }],
  store: false, stream: true, max_output_tokens: 2048,
  tools: [{ type: 'function', name: 'read_file', description: 'Read notes.', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } }] };
const base = { id: 'company', revision: 1, label: 'Synthetic connection', payer: 'company' as const, account: 'fixture', enabled: true };
function setup(provider: ProviderConnection['provider'], protocol: ManagedProtocol) {
  const connection: ProviderConnection = provider === 'aws-bedrock'
    ? { ...base, provider, secretRef: 'BEDROCK_API_KEY', region: 'us-east-1', endpointFamily: 'runtime',
      allowedProfiles: ['us.anthropic.fixture'], modelProtocols: { 'us.anthropic.fixture': [protocol] } }
    : provider === 'azure-openai' ? { ...base, provider, secretRef: 'AZURE_OPENAI_API_KEY', resource: 'fixture-resource', apiVersion: 'v1', deployments: ['fixture-deployment'] }
      : provider === 'google-vertex' ? { ...base, provider, secretRef: 'VERTEX_ACCESS_TOKEN', project: 'fixture-project', location: 'us-central1', publisher: protocol === 'messages' ? 'anthropic' : 'google' }
        : { ...base, provider, secretRef: 'OPENROUTER_API_KEY', ingress: 'us', regionalEntitlement: true, allowedEndpoints: ['fixture/us'], endpointNames: { 'fixture/us': 'Fixture Provider' } };
  const binding: ModelBinding = { connectionId: connection.id, connectionRevision: 1, protocol, deployment: provider === 'azure-openai' ? 'fixture-deployment' : null,
    modelVersion: 'fixture-v1', upstreamEndpoint: provider === 'openrouter' ? 'fixture/us' : null,
    capabilities: { contextTokens: 100_000, outputTokens: 4096, tools: true, images: true, reasoning: false },
    qualification: null, access: null, privacy: null,
    health: { state: 'unverified', observedAt: '2026-09-28T00:00:00Z', validUntil: '2026-09-29T00:00:00Z', cooldownUntil: null, reason: 'Synthetic only' },
    price: { version: 'fixture-1', observedAt: '2026-09-28T00:00:00Z', validUntil: '2026-09-29T00:00:00Z', evidence: 'Synthetic only',
      inputMicroUsdPerMillion: 100_000, outputMicroUsdPerMillion: 200_000, reasoningMicroUsdPerMillion: 200_000,
      cacheReadMicroUsdPerMillion: 10_000, cacheWriteMicroUsdPerMillion: 125_000, requestFeeMicroUsd: 2, longContext: [] } };
  const route: CatalogRoute = { id: 'fixture', model: provider === 'aws-bedrock' ? 'us.anthropic.fixture' : provider === 'openrouter' ? 'fixture/model' : 'fixture-v1',
    provider, status: 'unqualified', revision: 1, binding };
  return { connection, route, scopeKey: 'organization:fixture' };
}
function sse(events: unknown[]) { return new Response(events.map(e => `data: ${JSON.stringify(e)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream', 'x-request-id': 'request-fixture' } }); }
function crc(bytes: Uint8Array) { let n = 0xffffffff; for (const b of bytes) { n ^= b; for (let i = 0; i < 8; i++) n = (n >>> 1) ^ (0xedb88320 & -(n & 1)); } return (n ^ 0xffffffff) >>> 0; }
function awsFrame(type: string, payload: unknown) {
  const name = encoder.encode(':event-type'), value = encoder.encode(type), data = encoder.encode(JSON.stringify(payload));
  const headers = new Uint8Array(1 + name.length + 1 + 2 + value.length); headers[0] = name.length; headers.set(name, 1);
  headers[1 + name.length] = 7; new DataView(headers.buffer).setUint16(2 + name.length, value.length); headers.set(value, 4 + name.length);
  const frame = new Uint8Array(16 + headers.length + data.length), view = new DataView(frame.buffer);
  view.setUint32(0, frame.length); view.setUint32(4, headers.length); view.setUint32(8, crc(frame.subarray(0, 8)));
  frame.set(headers, 12); frame.set(data, 12 + headers.length); view.setUint32(frame.length - 4, crc(frame.subarray(0, -4))); return frame;
}
function aws(events: { type: string; [key: string]: unknown }[], messages = false) {
  const frames = events.map(({ type, ...e }) => messages
    ? awsFrame('chunk', { bytes: Buffer.from(JSON.stringify({ type, ...e })).toString('base64') }) : awsFrame(type, e));
  return new Response(new ReadableStream({ start(c) { for (const f of frames) { c.enqueue(f.slice(0, 9)); c.enqueue(f.slice(9)); } c.close(); } }),
    { headers: { 'content-type': 'application/vnd.amazon.eventstream', 'x-amzn-requestid': 'request-fixture' } });
}
const chatEvents = (provider?: string) => [
  { id: 'fixture-chat', model: 'fixture-v1', ...(provider ? { provider } : {}), choices: [{ delta: { tool_calls: [{ index: 0, id: 'call-1', function: { name: 'read_file', arguments: '{"path":' } }] } }] },
  { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"notes.txt"}' } }] }, finish_reason: 'tool_calls' }] },
  { choices: [], usage: { prompt_tokens: 100, completion_tokens: 12, prompt_tokens_details: { cached_tokens: 20 }, completion_tokens_details: { reasoning_tokens: 0 } } },
  ...(provider ? [{ openrouter_metadata: { requested: 'fixture/model', strategy: 'direct', attempt: 1, is_byok: false,
    endpoints: { total: 1, available: [{ provider, model: 'fixture-v1', selected: true }] }, pipeline: [] } }] : []),
];
const messageEvents = [
  { type: 'message_start', message: { id: 'fixture-message', model: 'fixture-v1', usage: { input_tokens: 70, cache_read_input_tokens: 20, cache_creation_input_tokens: 10 } } },
  { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'call-1', name: 'read_file', input: {} } },
  { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"path":"notes.txt"}' } },
  { type: 'content_block_stop', index: 0 },
  { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 12 } }, { type: 'message_stop' },
];
const converseEvents = [
  { type: 'messageStart', role: 'assistant' },
  { type: 'contentBlockStart', contentBlockIndex: 0, start: { toolUse: { toolUseId: 'call-1', name: 'read_file' } } },
  { type: 'contentBlockDelta', contentBlockIndex: 0, delta: { toolUse: { input: '{"path":"notes.txt"}' } } },
  { type: 'contentBlockStop', contentBlockIndex: 0 }, { type: 'messageStop', stopReason: 'tool_use' },
  { type: 'metadata', usage: { inputTokens: 100, outputTokens: 12, cacheReadInputTokens: 20 } },
];
const vertexEvents = [{ modelVersion: 'fixture-v1', candidates: [{ content: { role: 'model', parts: [{ functionCall: { name: 'read_file', args: { path: 'notes.txt' } } }] }, finishReason: 'STOP' }],
  usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 12, cachedContentTokenCount: 20 } }];
const responsesEvents = [
  { type: 'response.created', response: { id: 'fixture-response', created_at: 1_800_000_000, model: 'fixture-v1', status: 'in_progress', output: [] } },
  { type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', id: 'fc1', call_id: 'call-1', name: 'read_file', arguments: '' } },
  { type: 'response.function_call_arguments.delta', output_index: 0, item_id: 'fc1', delta: '{"path":"notes.txt"}' },
  { type: 'response.output_item.done', output_index: 0, item: { type: 'function_call', id: 'fc1', call_id: 'call-1', name: 'read_file', arguments: '{"path":"notes.txt"}', status: 'completed' } },
  { type: 'response.completed', response: { id: 'fixture-response', model: 'fixture-v1', status: 'completed', output: [], usage: { input_tokens: 100, output_tokens: 12, input_tokens_details: { cached_tokens: 20 }, output_tokens_details: { reasoning_tokens: 0 } } } },
];

describe('real managed provider transports at the Responses SDK boundary', () => {
  it.each(['responses', 'chat-completions', 'messages'] as const)('uses Mantle protocol-specific authentication for %s', async protocol => {
    const config = setup('aws-bedrock', protocol);
    if (config.connection.provider !== 'aws-bedrock') throw new Error('Expected AWS fixture.');
    config.connection.endpointFamily = 'mantle';
    config.route.model = protocol === 'messages' ? 'anthropic.fixture' : 'openai.fixture';
    config.connection.allowedProfiles = [config.route.model];
    config.connection.modelProtocols = { [config.route.model]: [protocol] };
    let sent: { url: string; headers: Headers } | undefined;
    const response = await callManagedProvider({ ...config, credential, body: request, signal: new AbortController().signal }, async (url, init) => {
      sent = { url: String(url), headers: new Headers(init?.headers) };
      return sse(protocol === 'messages' ? messageEvents : protocol === 'responses' ? responsesEvents : chatEvents());
    });
    const events = []; for await (const event of sseObjects(response.body!)) events.push(event);
    expect(events.at(-1)).toMatchObject({ type: 'response.completed', response: { usage: { input_tokens: 100, output_tokens: 12 } } });
    expect(sent!.url).toBe(`https://bedrock-mantle.us-east-1.api.aws/${protocol === 'messages' ? 'anthropic/v1/messages' : `v1/${protocol === 'responses' ? 'responses' : 'chat/completions'}`}`);
    expect(sent!.headers.get('authorization')).toBe(protocol === 'messages' ? null : `Bearer ${credential}`);
    expect(sent!.headers.get('x-api-key')).toBe(protocol === 'messages' ? credential : null);
    expect(sent!.headers.get('anthropic-version')).toBe(protocol === 'messages' ? '2023-06-01' : null);
  });
  it.each(['messages', 'converse'] as const)('uses configured Anthropic thinking on %s and refuses forced tools', protocol => {
    const config = setup('aws-bedrock', protocol);
    config.route.binding!.capabilities.reasoning = true;
    config.route.binding!.reasoning = { kind: 'anthropic-adaptive', levels: { low: 'low', medium: 'medium', high: 'high' } };
    const payload = JSON.parse(providerBody(config.route, config.connection, { ...request, reasoning: { effort: 'medium' } }));
    expect(protocol === 'converse' ? payload.additionalModelRequestFields : payload).toMatchObject({ thinking: { type: 'adaptive' }, output_config: { effort: 'medium' } });
    expect(() => providerBody(config.route, config.connection, { ...request, tool_choice: 'required' })).toThrow(/forced tool/);
    config.route.binding!.reasoning = { kind: 'anthropic-budget', levels: { low: 1024, medium: 1536, high: 4096 } };
    expect(() => providerBody(config.route, config.connection, { ...request, reasoning: { effort: 'high' } })).toThrow(/output bound/);
  });
  it('selects the configured Gemini budget or level without guessing from the model identity', () => {
    const config = setup('google-vertex', 'generate-content');
    config.route.binding!.capabilities.reasoning = true;
    config.route.binding!.reasoning = { kind: 'gemini-budget', levels: { low: 256, medium: 512, high: 1024 } };
    const budget = JSON.parse(providerBody(config.route, config.connection, { ...request, reasoning: { effort: 'medium' } }));
    expect(budget.generationConfig.thinkingConfig).toEqual({ thinkingBudget: 512, includeThoughts: false });
    config.route.binding!.reasoning = { kind: 'gemini-level', levels: { low: 'LOW', medium: 'HIGH', high: 'HIGH' } };
    const level = JSON.parse(providerBody(config.route, config.connection, { ...request, reasoning: { effort: 'medium' } }));
    expect(level.generationConfig.thinkingConfig).toEqual({ thinkingLevel: 'HIGH', includeThoughts: false });
  });
  it.each([
    ['aws-bedrock', 'responses', () => sse(responsesEvents)],
    ['aws-bedrock', 'converse', () => aws(converseEvents)],
    ['aws-bedrock', 'messages', () => aws(messageEvents, true)],
    ['azure-openai', 'responses', () => sse(responsesEvents)],
    ['azure-openai', 'chat-completions', () => sse(chatEvents())],
    ['google-vertex', 'generate-content', () => sse(vertexEvents)],
    ['google-vertex', 'messages', () => sse(messageEvents)],
    ['openrouter', 'chat-completions', () => sse(chatEvents('Fixture Provider'))],
  ] as const)('%s / %s preserves tool calls and usage through the real SDK', async (provider, protocol, reply) => {
    const { route, connection } = setup(provider, protocol);
    const sdkErrors: unknown[] = [];
    const sent: { url: string; init: RequestInit }[] = [];
    const transport: typeof fetch = async (url, init) => { sent.push({ url: String(url), init: init! }); return reply(); };
    const model = createOpenAI({ name: 'nectovia', apiKey: 'fixture-customer-token', baseURL: 'https://fixture.invalid/managed/v1',
      fetch: async (_url, init) => callManagedProvider({ route, connection, credential, scopeKey: 'organization:fixture',
        body: JSON.parse(String(init!.body)), signal: init?.signal ?? new AbortController().signal }, transport),
    }).responses(route.model);
    const result = streamText({ model, prompt: 'Read notes.', maxRetries: 0, maxOutputTokens: 2048,
      onError: ({ error }) => { sdkErrors.push(error); },
      providerOptions: { openai: { store: false, parallelToolCalls: false } },
      tools: { read_file: tool({ inputSchema: jsonSchema({ type: 'object', properties: { path: { type: 'string' } }, required: ['path'] }) }) } });
    expect(await result.toolCalls).toMatchObject([{ toolName: 'read_file', input: { path: 'notes.txt' } }]);
    expect(await result.usage).toMatchObject({ inputTokens: 100, outputTokens: 12 });
    expect(sdkErrors).toEqual([]);
    expect(sent).toHaveLength(1); expect(sent[0].init.redirect).toBe('manual');
    const headers = new Headers(sent[0].init.headers);
    expect(headers.get(provider === 'azure-openai' ? 'api-key' : 'authorization')).toBe(provider === 'azure-openai' ? credential : `Bearer ${credential}`);
    const body = JSON.parse(String(sent[0].init.body));
    if (provider === 'azure-openai') expect(body.model).toBe('fixture-deployment');
    if (provider === 'openrouter') expect(body.provider).toMatchObject({ only: ['fixture/us'], order: ['fixture/us'], allow_fallbacks: false, require_parameters: true, data_collection: 'deny', zdr: false });
    if (provider === 'google-vertex') expect(sent[0].url).toContain('/projects/fixture-project/locations/us-central1/');
  });
  it('rejects an unauthorized downstream before exposing its text', async () => {
    const config = setup('openrouter', 'chat-completions');
    const response = await callManagedProvider({ ...config, credential, body: request, signal: new AbortController().signal }, async () => sse(chatEvents('other/us')));
    await expect(response.text()).rejects.toMatchObject({ code: 'served_endpoint_mismatch' });
  });
  it.each(['missing', 'retry', 'payer', 'transform'] as const)('withholds OpenRouter tool calls when final attribution is %s', async fault => {
    const config = setup('openrouter', 'chat-completions');
    const stream = chatEvents('Fixture Provider') as Record<string, any>[];
    if (fault === 'missing') stream.pop();
    else if (fault === 'retry') stream.at(-1)!.openrouter_metadata.attempt = 2;
    else if (fault === 'payer') stream.at(-1)!.openrouter_metadata.is_byok = true;
    else stream.at(-1)!.openrouter_metadata.pipeline = [{ type: 'server_tools', name: 'web-search' }];
    const response = await callManagedProvider({ ...config, credential, body: request, signal: new AbortController().signal }, async () => sse(stream));
    const reader = response.body!.getReader();
    await expect(reader.read()).rejects.toThrow();
  });
  it.each(['messages', 'converse', 'generate-content', 'responses'] as const)('round trips a sealed %s continuation through the real SDK, but rejects a different account', async protocol => {
    const sdkErrors: unknown[] = [];
    const config = setup(protocol === 'responses' || protocol === 'converse' ? 'aws-bedrock' : 'google-vertex', protocol);
    config.route.binding!.capabilities.reasoning = true;
    if (protocol === 'messages' || protocol === 'converse')
      config.route.binding!.reasoning = { kind: 'anthropic-adaptive', levels: { low: 'low', medium: 'medium', high: 'high' } };
    if (protocol === 'generate-content')
      config.route.binding!.reasoning = { kind: 'gemini-level', levels: { low: 'LOW', medium: 'HIGH', high: 'HIGH' } };
    let fixture: unknown[];
    if (protocol === 'messages') fixture = [messageEvents[0],
      { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'Private reasoning.' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'provider-signature' } },
      { type: 'content_block_stop', index: 0 },
      ...messageEvents.slice(1).map(e => 'index' in e ? { ...e, index: 1 } : e)];
    else if (protocol === 'converse') fixture = [converseEvents[0],
      { type: 'contentBlockDelta', contentBlockIndex: 0, delta: { reasoningContent: { text: 'Private reasoning.' } } },
      { type: 'contentBlockDelta', contentBlockIndex: 0, delta: { reasoningContent: { signature: 'provider-signature' } } },
      { type: 'contentBlockStop', contentBlockIndex: 0 },
      ...converseEvents.slice(1).map(e => 'contentBlockIndex' in e ? { ...e, contentBlockIndex: 1 } : e)];
    else if (protocol === 'generate-content') fixture = [{ ...vertexEvents[0], candidates: [{ content: { role: 'model', parts: [
      { thoughtSignature: 'provider-signature', functionCall: { name: 'read_file', args: { path: 'notes.txt' } } },
    ] }, finishReason: 'STOP' }] }];
    else {
      const native = { type: 'reasoning', id: 'rs_provider', summary: [], encrypted_content: 'provider-ciphertext' };
      fixture = [responsesEvents[0], { type: 'response.output_item.added', output_index: 0, item: { ...native, encrypted_content: null } },
        { type: 'response.output_item.done', output_index: 0, item: native },
        ...responsesEvents.slice(1, -1).map(e => ({ ...e, output_index: 1 })),
        { ...responsesEvents.at(-1), response: { ...responsesEvents.at(-1)!.response, output: [native, responsesEvents[3].item] } }];
    }
    const raw: ResponsesBody[] = [], serialized: Record<string, unknown>[] = [];
    const model = createOpenAI({ name: 'nectovia', apiKey: 'fixture-token', baseURL: 'https://fixture.invalid/managed/v1',
      fetch: async (_u, init) => {
        const body: ResponsesBody = JSON.parse(String(init!.body)); raw.push(body);
        return callManagedProvider({ ...config, credential, body, scopeKey: 'individual:alice', signal: new AbortController().signal }, async (_url, outgoing) => {
          serialized.push(JSON.parse(String(outgoing!.body)));
          return protocol === 'converse' ? aws(fixture as { type: string; [key: string]: unknown }[]) : sse(fixture);
        });
      } }).responses(config.route.model);
    const initial: ModelMessage[] = [{ role: 'user', content: 'Read notes.' }];
    const tools = { read_file: tool({ inputSchema: jsonSchema({ type: 'object', properties: { path: { type: 'string' } }, required: ['path'] }) }) };
    const options = { model, maxRetries: 0, maxOutputTokens: 2048, tools,
      onError: ({ error }: { error: unknown }) => { sdkErrors.push(error); },
      providerOptions: { openai: { store: false, parallelToolCalls: false, include: ['reasoning.encrypted_content'] } } };
    const first = streamText({ ...options, messages: initial });
    const calls = await first.toolCalls;
    const history = (await first.response).messages;
    expect(JSON.stringify(history)).toContain('nectovia-native-v1:');
    const next = streamText({ ...options, messages: [...initial, ...history, { role: 'tool', content: [{ type: 'tool-result', toolCallId: calls[0].toolCallId,
      toolName: 'read_file', output: { type: 'text', value: 'Order rye.' } }] }] });
    await next.toolCalls;
    expect(sdkErrors).toEqual([]);
    expect(serialized).toHaveLength(2);
    expect(JSON.stringify(serialized[1])).toContain(protocol === 'responses' ? 'provider-ciphertext' : 'provider-signature');
    expect(JSON.stringify(serialized[1])).not.toContain('nectovia-native-v1:');
    let foreignSends = 0;
    await expect(callManagedProvider({ ...config, credential, body: raw[1], scopeKey: 'organization:other', signal: new AbortController().signal },
      async () => { foreignSends++; return sse(fixture); })).rejects.toMatchObject({ code: 'nonportable_continuation' });
    expect(foreignSends).toBe(0);
  });
  it('does not forward a Responses-native checkpoint into another protocol', () => {
    const { route, connection } = setup('google-vertex', 'generate-content');
    expect(() => providerBody(route, connection, { ...request, input: [{ type: 'reasoning', encrypted_content: 'opaque', summary: [] }] })).toThrow(/portable checkpoint/);
  });
  it('preserves a native tool checkpoint when portable JSON keys change order, but rejects changed values', () => {
    const { route, connection } = setup('google-vertex', 'generate-content');
    const original = { path: 'notes.txt', options: { encoding: 'utf8', limit: 10 } };
    const reordered = { options: { limit: 10, encoding: 'utf8' }, path: 'notes.txt' };
    const native = { protocol: 'generate-content', parts: [{ thoughtSignature: 'fixture-signature', functionCall: { name: 'read_file', args: original } }],
      answer: '', tools: [{ id: 'call-1', name: 'read_file', arguments: JSON.stringify(original) }] };
    const body: ResponsesBody = { ...request, input: [...request.input,
      { type: 'function_call', call_id: 'call-1', name: 'read_file', arguments: JSON.stringify(reordered) },
      { type: 'reasoning', managedCheckpoint: native },
      { type: 'function_call_output', call_id: 'call-1', output: 'Read complete.' }] };
    expect(providerBody(route, connection, body)).toContain('fixture-signature');
    body.input[1].arguments = JSON.stringify({ ...reordered, path: 'different.txt' });
    expect(() => providerBody(route, connection, body)).toThrow(/does not match/);
  });
  it('refuses a transport call without an account scope before sending', async () => {
    const config = setup('azure-openai', 'responses');
    let sends = 0;
    await expect(callManagedProvider({ ...config, scopeKey: '', credential, body: request, signal: new AbortController().signal },
      async () => { sends++; return sse(responsesEvents); })).rejects.toMatchObject({ code: 'account_scope_required' });
    expect(sends).toBe(0);
  });
  it('replays portable tool results using the Vertex request format', () => {
    const { route, connection } = setup('google-vertex', 'generate-content');
    const body = JSON.parse(providerBody(route, connection, { ...request, input: [...request.input,
      { type: 'function_call', call_id: 'call-1', name: 'read_file', arguments: '{"path":"notes.txt"}' },
      { type: 'function_call_output', call_id: 'call-1', output: 'Order rye.' }] }));
    expect(body.contents.at(-1).parts[0]).toEqual({ functionResponse: { name: 'read_file', response: { result: 'Order rye.' } } });
  });
  it('forwards cancellation and never follows a redirect', async () => {
    const config = setup('azure-openai', 'responses'), controller = new AbortController();
    let sent: RequestInit | undefined;
    const result = await callManagedProvider({ ...config, credential, body: request, signal: controller.signal }, async (_u, init) => { sent = init; return new Response(null, { status: 307, headers: { location: 'https://attacker.invalid' } }); });
    expect(sent?.redirect).toBe('manual'); expect(result.status).toBe(307);
    const pending = await callManagedProvider({ ...config, credential, body: request, signal: controller.signal }, async (_u, init) => { sent = init; return sse(responsesEvents); });
    controller.abort(); expect(sent?.signal?.aborted).toBe(true); await pending.body!.cancel();
  });
  it('constructs only approved hosts and rejects arbitrary connection destinations', () => {
    const { route, connection } = setup('azure-openai', 'responses');
    expect(providerEndpoint(route, connection)).toBe('https://fixture-resource.openai.azure.com/openai/v1/responses');
    expect(() => approvedConnections({ MANAGED_CONNECTIONS: JSON.stringify([{ ...connection, url: 'https://attacker.invalid' }]) })).toThrow();
    expect(() => approvedConnections({ MANAGED_CONNECTIONS: JSON.stringify([{ ...connection, resource: 'fixture@attacker.invalid' }]) })).toThrow();
  });
  it('keeps a refusal terminal and rejects missing usage as unknown rather than inventing tokens', async () => {
    const config = setup('azure-openai', 'chat-completions');
    const response = await callManagedProvider({ ...config, credential, body: request, signal: new AbortController().signal }, async () => sse([
      { id: 'refusal', model: 'fixture-v1', choices: [{ delta: { refusal: 'Refused.' }, finish_reason: 'content_filter' }] },
    ]));
    const events = []; for await (const e of sseObjects(response.body!)) events.push(e);
    expect(events.at(-1)).toMatchObject({ type: 'response.completed', response: { usage: null, output: [{ content: [{ type: 'refusal', refusal: 'Refused.' }] }] } });
  });
});
