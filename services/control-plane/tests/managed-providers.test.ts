import { describe, expect, it } from 'vitest';
import { createOpenAI } from '@ai-sdk/openai';
import { jsonSchema, stepCountIs, streamText, tool } from 'ai';
import {
  MANAGED_PROVIDERS,
  SCRIPTED_ANSWER,
  SCRIPTED_USAGE,
  bedrockResponsesCaller,
  credentialFor,
  registryRow,
  scriptedResponsesFetch,
} from '../src/managed-providers.js';
import { providerSpy } from './support/managed.js';

const LUNA = MANAGED_PROVIDERS[0];

describe('the reviewed provider registry', () => {
  it('holds exactly the contract row for GPT-6 Luna on Bedrock, and nothing staff can edit', () => {
    expect(MANAGED_PROVIDERS).toHaveLength(1);
    expect(LUNA).toEqual({
      provider: 'aws-bedrock',
      region: 'us',
      model: 'us.openai.gpt-6-luna',
      endpoint: 'https://bedrock-runtime.us-east-1.amazonaws.com/openai/v1/responses',
      rate: {
        version: 'aws-bedrock-gpt-6-luna-us-2026-09-25.1',
        inputMicroUsdPerMillion: 110_000,
        cacheReadMicroUsdPerMillion: 11_000,
        cacheWriteMicroUsdPerMillion: 137_500,
        outputMicroUsdPerMillion: 550_000,
      },
      maxOutputTokens: 16_000,
      credential: 'BEDROCK_API_KEY',
      requestIdHeaders: ['x-amzn-requestid', 'x-request-id'],
    });
    expect(Object.isFrozen(MANAGED_PROVIDERS)).toBe(true);
    expect(Object.isFrozen(LUNA)).toBe(true);
    expect(Object.isFrozen(LUNA.rate)).toBe(true);
  });

  it('matches a route only on provider, region and model together', () => {
    expect(registryRow({ provider: 'aws-bedrock', region: 'us', model: 'us.openai.gpt-6-luna' })).toBe(LUNA);
    expect(registryRow({ provider: 'aws-bedrock', region: null, model: 'us.openai.gpt-6-luna' })).toBeUndefined();
    expect(registryRow({ provider: 'aws-bedrock', region: 'us', model: 'us.openai.gpt-5.6-luna' })).toBeUndefined();
    expect(registryRow({ provider: 'azure-openai', region: 'us', model: 'us.openai.gpt-6-luna' })).toBeUndefined();
  });

  it('reads the credential from the environment by name, and only a usable one', () => {
    expect(credentialFor(LUNA, { BEDROCK_API_KEY: 'ABSKexample-key.value' })).toBe('ABSKexample-key.value');
    for (const value of [undefined, '', ' padded', 'two words', 'line\nbreak', 42, 'x'.repeat(8_193)])
      expect(credentialFor(LUNA, { BEDROCK_API_KEY: value })).toBeNull();
    expect(credentialFor(LUNA, { OTHER: 'ABSKexample' })).toBeNull();
  });
});

describe('the Bedrock Responses caller', () => {
  it('posts the exact body to the registry endpoint with the key as a bearer, and follows no redirect', async () => {
    const spy = providerSpy(() => new Response('ok'));
    let redirect: RequestRedirect | undefined;
    const transport = (async (input: RequestInfo | URL, init?: RequestInit) => {
      redirect = init?.redirect;
      return spy.fetch(input, init);
    }) as typeof fetch;
    const body = JSON.stringify({ model: LUNA.model, input: [], store: false, stream: true });
    const response = await bedrockResponsesCaller(transport)({ row: LUNA, credential: 'ABSKkey', body, signal: new AbortController().signal });
    expect(await response.text()).toBe('ok');
    expect(spy.calls).toHaveLength(1);
    expect(spy.calls[0]).toMatchObject({ url: LUNA.endpoint, method: 'POST', rawBody: body });
    expect(spy.calls[0].headers).toMatchObject({ authorization: 'Bearer ABSKkey', 'content-type': 'application/json', accept: 'text/event-stream' });
    expect(redirect).toBe('manual');
  });

  it('reads the global fetch at call time, so the offline guard stops an uninjected call', async () => {
    await expect(bedrockResponsesCaller()({ row: LUNA, credential: 'ABSKkey', body: '{}', signal: new AbortController().signal }))
      .rejects.toThrow('Unexpected HTTP request in offline tests.');
  });
});

describe('the scripted provider speaks the real SDK’s stream', () => {
  const model = (fetch: typeof globalThis.fetch) =>
    createOpenAI({ name: 'nectovia', baseURL: 'http://faux.local/managed/v1', apiKey: 'placeholder', fetch }).responses(LUNA.model);
  const providerOptions = {
    openai: { forceReasoning: true, systemMessageMode: 'developer', include: ['reasoning.encrypted_content'], reasoningEffort: 'low',
      reasoningSummary: null, store: false, parallelToolCalls: false },
  };
  const readFile = tool({ description: 'Read a file', inputSchema: jsonSchema({ type: 'object', properties: { path: { type: 'string' } }, required: ['path'] }) });

  it('answers a plain message with its short answer and exact usage', async () => {
    const result = streamText({
      model: model(scriptedResponsesFetch()), system: 'Be brief.', messages: [{ role: 'user', content: 'Hello there.' }],
      maxRetries: 0, stopWhen: stepCountIs(1), providerOptions: providerOptions as never,
    });
    expect(await result.text).toBe(SCRIPTED_ANSWER);
    const usage = await result.usage;
    expect(usage.inputTokens).toBe(SCRIPTED_USAGE.input_tokens);
    expect(usage.outputTokens).toBe(SCRIPTED_USAGE.output_tokens);
    expect(await result.finishReason).toBe('stop');
  });

  it('calls an offered tool when the last user message names it, with the arguments given', async () => {
    const result = streamText({
      model: model(scriptedResponsesFetch()),
      messages: [{ role: 'user', content: 'Please look. [[tool:read_file {"path":"notes.txt"}]]' }],
      tools: { read_file: readFile }, toolChoice: 'auto', maxRetries: 0, stopWhen: stepCountIs(1), providerOptions: providerOptions as never,
    });
    const calls = await result.toolCalls;
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ toolName: 'read_file', input: { path: 'notes.txt' } });
    expect(await result.finishReason).toBe('tool-calls');
  });

  it('answers in words when the named tool was not offered or the marker is not in the last user message', async () => {
    const unoffered = streamText({
      model: model(scriptedResponsesFetch()), messages: [{ role: 'user', content: '[[tool:delete_everything]]' }],
      tools: { read_file: readFile }, maxRetries: 0, stopWhen: stepCountIs(1), providerOptions: providerOptions as never,
    });
    expect(await unoffered.toolCalls).toEqual([]);
    expect(await unoffered.text).toBe(SCRIPTED_ANSWER);
  });

  it('never reports more output than the request allows', async () => {
    const result = streamText({
      model: model(scriptedResponsesFetch()), messages: [{ role: 'user', content: 'Hi.' }], maxOutputTokens: 5,
      maxRetries: 0, stopWhen: stepCountIs(1), providerOptions: providerOptions as never,
    });
    await result.text;
    expect((await result.usage).outputTokens).toBe(5);
  });
});
