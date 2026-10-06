/**
 * DIO-215: the owner's cache setting on the wire, read from the request bytes the pinned SDK
 * (ai 7.0.107, @ai-sdk/openai 4.0.71, @ai-sdk/azure 4.0.75) serialized, on the three bindings that
 * carry it: AWS Luna over Responses, AWS Kimi K3 over Chat Completions and Azure over Responses.
 * Every request goes to a capturing fixture transport; nothing reaches AWS, Azure or any model.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { ModelMessage } from 'ai';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { micro } from '../shared/managed-usage.js';
import { cacheRequest, type CacheRequest } from '../shared/route-capabilities.js';
import * as aws from '../server/engines/aws-bedrock.js';
import { cacheFieldsMatch, CONVERSATION_LIMITS, ModelApiError, respondStream } from '../server/engines/model-api-core.js';
import { azureRateCard, respondAzure } from '../server/engines/azure-openai.js';
import { HOST_READ_OPENER } from '../server/harness/native-agent.js';
import { CHECK_CACHE_OFF } from '../server/engines/route-qualification.js';
import { SpendExposure } from '../server/spend-exposure.js';
import base from './fixtures/cache-base-bodies.json';
import {
  AZURE_CONNECTION,
  AZURE_MODELS,
  CALL_SCENARIOS,
  INSTRUCTIONS,
  K3_CONNECTION,
  LUNA_CONNECTION,
  K3_RECEIPT,
  SCENARIO_NAMES,
  SCENARIO_NOW,
  STABLE_PREFIX,
  VARIABLE_PART,
  scenarioBodies,
  type ScenarioName,
} from './fixtures/cache-body-scenarios.js';
import { chatEvents, responsesEvents, sseResponse } from './fixtures/model-api-streams.js';

type Item = Record<string, unknown>;
const KEY = `dio1-${'ab12'.repeat(10)}`;
const PROVIDER_DEFAULT = cacheRequest({ policy: 'provider-default' })!;
const OFF = cacheRequest({ policy: 'off' })!;
const EXPLICIT = cacheRequest({ policy: 'explicit-prefix', key: KEY })!;
const baseBodies = base.bodies as Record<ScenarioName, string[]>;
const bodyOf = (text: string) => JSON.parse(text) as Item;
/** The scenarios Kimi K3 serves over Chat Completions; every other one goes over Responses. */
const CHAT = new Set<ScenarioName>(['aws-k3-respond', 'aws-k3-respond-tools', 'aws-k3-adapter']);
/** The Responses scenarios whose model takes its instructions as a developer message. */
const PLAIN_SYSTEM = new Set<ScenarioName>(['azure-plain-respond']);
const messagesOf = (name: ScenarioName, body: Item) => body[CHAT.has(name) ? 'messages' : 'input'] as Item[];
const roleOf = (name: ScenarioName) => (CHAT.has(name) || PLAIN_SYSTEM.has(name) ? 'system' : 'developer');
const partType = (name: ScenarioName) => (CHAT.has(name) ? 'text' : 'input_text');
/** Every cache field a raw body carries, by plain text search, independent of the code under test. */
const occurrences = (text: string, field: string) => text.split(`"${field}"`).length - 1;

/** The body with its cache fields taken out and its system parts joined back into one message. */
function withoutCache(name: ScenarioName, text: string): string {
  const body = bodyOf(text);
  delete body.prompt_cache_key;
  delete body.prompt_cache_options;
  const list = messagesOf(name, body);
  const first = list[0];
  if (Array.isArray(first.content)) {
    const marked = (first.content as Item[])[0].text as string;
    const second = list[1];
    const rest = second && second.role === first.role && typeof second.content === 'string' ? second.content : null;
    list.splice(0, rest === null ? 1 : 2, { role: first.role, content: rest === null ? marked : `${marked}\n\n${rest}` });
  }
  return JSON.stringify(body);
}

describe('provider-default sends exactly what the base commit sent', () => {
  test('the base bodies were captured for every scenario before any cache setting existed', () => {
    expect(base.base).toBe('04954ab');
    expect(Object.keys(baseBodies).sort()).toEqual([...SCENARIO_NAMES].sort());
    for (const name of SCENARIO_NAMES) expect(baseBodies[name].length).toBeGreaterThan(0);
  });

  test('no cache request at all: every byte of every request is unchanged', async () => {
    const bodies = await scenarioBodies();
    for (const name of SCENARIO_NAMES) expect(bodies[name], name).toEqual(baseBodies[name]);
  });

  test('provider-default with a stable prefix given: every byte of every request is unchanged', async () => {
    const bodies = await scenarioBodies(() => ({ cache: PROVIDER_DEFAULT, stablePrefix: STABLE_PREFIX }));
    for (const name of SCENARIO_NAMES) expect(bodies[name], name).toEqual(baseBodies[name]);
  });
});

describe('off sends the explicit mode alone, on all three bindings', () => {
  test('one top-level field is added and nothing else about any request changes', async () => {
    const bodies = await scenarioBodies(() => ({ cache: OFF, stablePrefix: STABLE_PREFIX }));
    for (const name of CALL_SCENARIOS) {
      expect(bodies[name].length, name).toBe(baseBodies[name].length);
      bodies[name].forEach((text, index) => {
        const body = bodyOf(text);
        expect(body.prompt_cache_options, name).toEqual({ mode: 'explicit' });
        expect(occurrences(text, 'prompt_cache_options'), name).toBe(1);
        expect(occurrences(text, 'prompt_cache_key'), name).toBe(0);
        expect(occurrences(text, 'prompt_cache_breakpoint'), name).toBe(0);
        expect(withoutCache(name, text), name).toBe(baseBodies[name][index]);
      });
    }
    // The route checks set their own cache requests and keep their bytes whatever the setting.
    for (const name of SCENARIO_NAMES.filter((item) => !CALL_SCENARIOS.includes(item)))
      expect(bodies[name], name).toEqual(baseBodies[name]);
  });

  test('the route checks’ cache-off calls send exactly the cache fields an ordinary call set to off sends', async () => {
    expect(CHECK_CACHE_OFF).toEqual(OFF);
    const ordinary = await scenarioBodies(() => ({ cache: OFF }));
    const cacheFields = (text: string) => {
      const body = bodyOf(text);
      return {
        key: body.prompt_cache_key,
        options: body.prompt_cache_options,
        breakpoints: occurrences(text, 'prompt_cache_breakpoint'),
      };
    };
    const offCall = cacheFields(ordinary['aws-k3-respond'][0]);
    expect(offCall).toEqual({ key: undefined, options: { mode: 'explicit' }, breakpoints: 0 });
    for (const name of ['aws-luna-route-checks', 'aws-k3-route-checks', 'azure-route-checks'] as const) {
      const checks = ordinary[name].filter((text) => occurrences(text, 'prompt_cache_options') > 0);
      // The two no-cache calls, and only those, carry a cache field.
      expect(checks, name).toHaveLength(2);
      for (const text of checks) {
        expect(cacheFields(text), name).toEqual(offCall);
        expect(cacheFieldsMatch(text, OFF), name).toBe(true);
      }
      for (const text of ordinary[name].filter((item) => !checks.includes(item)))
        expect(cacheFieldsMatch(text, PROVIDER_DEFAULT), name).toBe(true);
    }
  });
});

describe('explicit-prefix marks the stable prefix, on all three bindings', () => {
  test('the derived key, the explicit mode with its lifetime, and one breakpoint on the first system part', async () => {
    const bodies = await scenarioBodies(() => ({ cache: EXPLICIT, stablePrefix: STABLE_PREFIX }));
    for (const name of CALL_SCENARIOS)
      bodies[name].forEach((text, index) => {
        const body = bodyOf(text);
        expect(body.prompt_cache_key, name).toBe(KEY);
        expect(body.prompt_cache_options, name).toEqual({ mode: 'explicit', ttl: '30m' });
        expect(occurrences(text, 'prompt_cache_breakpoint'), name).toBe(1);
        const [first, second] = messagesOf(name, body);
        // Chat Completions: a system message whose content is one text part carrying the breakpoint.
        // Responses: a developer (or system) input item whose content is one input_text part.
        expect(first, name).toEqual({
          role: roleOf(name),
          content: [{ type: partType(name), text: STABLE_PREFIX, prompt_cache_breakpoint: { mode: 'explicit' } }],
        });
        expect(second, name).toEqual({ role: roleOf(name), content: VARIABLE_PART });
        expect(cacheFieldsMatch(text, EXPLICIT), name).toBe(true);
        expect(withoutCache(name, text), name).toBe(baseBodies[name][index]);
      });
  });

  test('with no stable prefix the whole instructions carry the breakpoint', async () => {
    const bodies = await scenarioBodies(() => ({ cache: EXPLICIT, stablePrefix: null }));
    for (const name of CALL_SCENARIOS)
      bodies[name].forEach((text, index) => {
        const body = bodyOf(text);
        const [first, second] = messagesOf(name, body);
        expect(first, name).toEqual({
          role: roleOf(name),
          content: [{ type: partType(name), text: INSTRUCTIONS, prompt_cache_breakpoint: { mode: 'explicit' } }],
        });
        expect(second.role, name).toBe('user');
        expect(withoutCache(name, text), name).toBe(baseBodies[name][index]);
      });
  });
});

describe('each route guard refuses cache fields its call did not ask for', () => {
  const chat = (extra: Item, first: Item = { role: 'system', content: 'Rules.' }) =>
    JSON.stringify({ model: 'm', ...extra, messages: [first, { role: 'user', content: 'Hello.' }], stream: true });
  const responses = (extra: Item, first: Item = { role: 'developer', content: 'Rules.' }) =>
    JSON.stringify({ model: 'm', input: [first, { role: 'user', content: [{ type: 'input_text', text: 'Hello.' }] }], ...extra, stream: true });
  const marked = (type: string, role = 'system', mode = 'explicit') => ({
    role,
    content: [{ type, text: 'Rules.', prompt_cache_breakpoint: { mode } }],
  });
  const explicitFields = { prompt_cache_key: KEY, prompt_cache_options: { mode: 'explicit', ttl: '30m' } };

  test('provider-default: no key, no cache options and no breakpoint anywhere', () => {
    expect(cacheFieldsMatch(chat({}), PROVIDER_DEFAULT)).toBe(true);
    expect(cacheFieldsMatch(responses({}), PROVIDER_DEFAULT)).toBe(true);
    for (const body of [
      chat({ prompt_cache_key: KEY }),
      chat({ prompt_cache_options: { mode: 'explicit' } }),
      chat({ prompt_cache_options: { mode: 'implicit' } }),
      chat({}, marked('text')),
      responses({}, marked('input_text', 'developer')),
    ])
      expect(cacheFieldsMatch(body, PROVIDER_DEFAULT), body).toBe(false);
  });

  test('off: exactly the explicit mode, no key and no breakpoint', () => {
    expect(cacheFieldsMatch(chat({ prompt_cache_options: { mode: 'explicit' } }), OFF)).toBe(true);
    expect(cacheFieldsMatch(responses({ prompt_cache_options: { mode: 'explicit' } }), OFF)).toBe(true);
    for (const body of [
      chat({}),
      chat({ prompt_cache_options: { mode: 'explicit', ttl: '30m' } }),
      chat({ prompt_cache_options: { mode: 'implicit' } }),
      chat({ prompt_cache_options: {} }),
      chat({ prompt_cache_options: { mode: 'explicit' }, prompt_cache_key: KEY }),
      chat({ prompt_cache_options: { mode: 'explicit' } }, marked('text')),
      // In the wrong place: nested, not at the top level.
      chat({ metadata: { prompt_cache_options: { mode: 'explicit' } } }),
    ])
      expect(cacheFieldsMatch(body, OFF), body).toBe(false);
  });

  test('explicit-prefix: the derived key, the explicit mode with its lifetime and one breakpoint on the first system part', () => {
    expect(cacheFieldsMatch(chat(explicitFields, marked('text')), EXPLICIT)).toBe(true);
    expect(cacheFieldsMatch(responses(explicitFields, marked('input_text', 'developer')), EXPLICIT)).toBe(true);
    expect(cacheFieldsMatch(responses(explicitFields, marked('input_text', 'system')), EXPLICIT)).toBe(true);
    const twice = {
      role: 'system',
      content: [
        { type: 'text', text: 'Rules.', prompt_cache_breakpoint: { mode: 'explicit' } },
        { type: 'text', text: 'More.', prompt_cache_breakpoint: { mode: 'explicit' } },
      ],
    };
    const second = { role: 'system', content: [{ type: 'text', text: 'Unmarked.' }, { type: 'text', text: 'Rules.', prompt_cache_breakpoint: { mode: 'explicit' } }] };
    for (const body of [
      chat(explicitFields),
      chat({ ...explicitFields, prompt_cache_key: `dio1-${'cd34'.repeat(10)}` }, marked('text')),
      chat({ prompt_cache_options: explicitFields.prompt_cache_options }, marked('text')),
      chat({ prompt_cache_key: KEY, prompt_cache_options: { mode: 'explicit' } }, marked('text')),
      chat(explicitFields, twice),
      chat(explicitFields, second),
      chat(explicitFields, marked('text', 'user')),
      chat(explicitFields, marked('text', 'system', 'implicit')),
      JSON.stringify({
        model: 'm',
        ...explicitFields,
        messages: [{ role: 'system', content: 'Rules.' }, marked('text')],
      }),
      'not json',
    ])
      expect(cacheFieldsMatch(body, EXPLICIT), body).toBe(false);
  });
});

describe('a cache request that cannot be sent is refused before anything is held', () => {
  let dir: string;
  let exposure: SpendExposure;
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'diomedes-cache-refusals-'));
    exposure = new SpendExposure(path.join(dir, 'spend'));
    await exposure.init();
    await exposure.setCap(K3_CONNECTION.id, micro(10_000_000), { approvedBy: 'test owner', note: 'Fixture cap; no live request.' });
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  const messages: ModelMessage[] = [{ role: 'user', content: 'Which deliveries arrived short?' }];
  let attempts = 0;
  const call = async (cache: CacheRequest, binding = aws.awsChatBinding(K3_CONNECTION, 'high', CONVERSATION_LIMITS.maxOutputTokens, false)) => {
    let sent = 0;
    const transport = (async () => {
      sent += 1;
      return sseResponse(chatEvents({ model: K3_CONNECTION.modelId, text: 'OK', usage: { prompt_tokens: 20, completion_tokens: 2, total_tokens: 22 } }));
    }) as unknown as typeof globalThis.fetch;
    const error = await respondStream({
      binding,
      secret: 'test-only-key-0123456789abcdef-never-real',
      card: aws.awsModelRateCard(K3_CONNECTION.modelId),
      exposure,
      attempt: aws.exposureAttempt(`refusal-${++attempts}`, 'model:0', messages),
      instructions: INSTRUCTIONS,
      messages,
      tools: [],
      limits: CONVERSATION_LIMITS,
      signal: new AbortController().signal,
      transport,
      now: () => SCENARIO_NOW,
      cache,
      stablePrefix: STABLE_PREFIX,
    }).then(
      () => null,
      (caught: unknown) => caught,
    );
    return { error, sent };
  };

  test('an explicit prefix whose key is not a derived key', async () => {
    const forged: CacheRequest = { ...EXPLICIT, options: { ...EXPLICIT.options, promptCacheKey: 'tenant-acme-bakery' } };
    const { error, sent } = await call(forged);
    expect(error).toBeInstanceOf(ModelApiError);
    expect(error).toMatchObject({ code: 'aws_cache_refused', dispatched: false });
    expect((error as ModelApiError).message).not.toMatch(/Nothing was/);
    expect(sent).toBe(0);
    expect(exposure.list(K3_CONNECTION.id)).toEqual([]);
  });

  test('a request in no shape cacheRequest makes', async () => {
    const odd: CacheRequest[] = [
      { ...OFF, options: { promptCacheOptions: { mode: 'implicit' } } },
      { ...PROVIDER_DEFAULT, breakpoint: { mode: 'explicit' } },
      { ...EXPLICIT, options: { promptCacheKey: KEY } },
    ];
    for (const cache of odd) {
      const { error, sent } = await call(cache);
      expect(error, cache.policy).toMatchObject({ code: 'aws_cache_refused', dispatched: false });
      expect(sent).toBe(0);
    }
    expect(exposure.list(K3_CONNECTION.id)).toEqual([]);
  });

  test('a setting other than the provider’s default on a binding with no cache namespace', async () => {
    const { cacheNamespace: _namespace, ...plain } = aws.awsChatBinding(K3_CONNECTION, 'high', CONVERSATION_LIMITS.maxOutputTokens, false);
    const { error, sent } = await call(OFF, plain);
    expect(error).toMatchObject({ code: 'aws_cache_refused', dispatched: false });
    expect(sent).toBe(0);
    expect(exposure.list(K3_CONNECTION.id)).toEqual([]);
    // The provider's default needs no namespace and sends as before.
    expect((await call(PROVIDER_DEFAULT, plain)).error).toBeNull();
  });

  test('an answered call reports what its breakpoint marked', async () => {
    const result = await aws.respondOnce({
      connection: K3_CONNECTION,
      secret: 'test-only-key-0123456789abcdef-never-real',
      card: aws.awsModelRateCard(K3_CONNECTION.modelId),
      exposure,
      attempt: aws.exposureAttempt('marked-1', 'model:0', messages),
      instructions: INSTRUCTIONS,
      messages,
      tools: [],
      effort: 'high',
      limits: CONVERSATION_LIMITS,
      signal: new AbortController().signal,
      transport: (async () =>
        sseResponse(chatEvents({ model: K3_CONNECTION.modelId, text: 'OK', usage: { prompt_tokens: 20, completion_tokens: 2, total_tokens: 22 } }))) as unknown as typeof globalThis.fetch,
      now: () => SCENARIO_NOW,
      qualification: K3_RECEIPT,
      cache: EXPLICIT,
      stablePrefix: STABLE_PREFIX,
    });
    expect(result.marked).toBe('stable-prefix');
    const noCache = await aws.respondOnce({
      connection: K3_CONNECTION,
      secret: 'test-only-key-0123456789abcdef-never-real',
      card: aws.awsModelRateCard(K3_CONNECTION.modelId),
      exposure,
      attempt: aws.exposureAttempt('marked-2', 'model:0', messages),
      instructions: INSTRUCTIONS,
      messages,
      tools: [],
      effort: 'high',
      limits: CONVERSATION_LIMITS,
      signal: new AbortController().signal,
      transport: (async () =>
        sseResponse(chatEvents({ model: K3_CONNECTION.modelId, text: 'OK', usage: { prompt_tokens: 20, completion_tokens: 2, total_tokens: 22 } }))) as unknown as typeof globalThis.fetch,
      now: () => SCENARIO_NOW,
      qualification: K3_RECEIPT,
    });
    expect(noCache).not.toHaveProperty('marked');
  });
});

describe('DIO-247.N4: an explicit prefix marks the host\'s reads of the attached files too, on all three bindings', () => {
  let dir: string;
  let exposure: SpendExposure;
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'diomedes-cache-files-'));
    exposure = new SpendExposure(path.join(dir, 'spend'));
    await exposure.init();
    for (const id of [K3_CONNECTION.id, AZURE_CONNECTION.id])
      await exposure.setCap(id, micro(10_000_000), { approvedBy: 'test owner', note: 'Fixture cap; no live request.' });
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  /** One host read as a conversation turn sends it: the host's call and its result, under the host's id. */
  const read = (n: number, file: string, text: string): ModelMessage[] => [
    { role: 'assistant', content: [{ type: 'tool-call', toolCallId: `host-read-${n}`, toolName: 'read_source', input: { path: file } }] },
    {
      role: 'tool',
      content: [
        {
          type: 'tool-result',
          toolCallId: `host-read-${n}`,
          toolName: 'read_source',
          output: { type: 'json', value: { found: true, path: file, truncated: false, text } },
        },
      ],
    },
  ];
  const HOSTED: ModelMessage[] = [
    { role: 'user', content: HOST_READ_OPENER },
    ...read(1, 'Deliveries.md', '# Deliveries\n\n94 of 100 napkins on Friday.\n'),
    ...read(2, 'Invoices.md', '# Invoices\n\nInvoice 1182 bills 100 napkins.\n'),
    { role: 'user', content: 'Which deliveries arrived short last week?' },
  ];
  const WIRES = ['aws-luna', 'aws-k3', 'azure'] as const;
  type Wire = (typeof WIRES)[number];
  const ok = (wire: Wire) =>
    wire === 'aws-k3'
      ? sseResponse(chatEvents({ model: K3_CONNECTION.modelId, text: 'Two deliveries.', usage: { prompt_tokens: 300, completion_tokens: 20, total_tokens: 320 } }))
      : sseResponse(
          responsesEvents({
            id: 'resp_files',
            object: 'response',
            created_at: 1_790_000_000,
            status: 'completed',
            model: wire === 'azure' ? `${AZURE_MODELS.reasoning}-2026-09-15` : aws.AWS_LUNA_MODEL,
            output: [
              { type: 'reasoning', id: 'rs_files', summary: [], encrypted_content: 'enc-files' },
              { type: 'message', id: 'msg_files', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'Two deliveries.', annotations: [] }] },
            ],
            usage: { input_tokens: 300, output_tokens: 20, total_tokens: 320, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 8 } },
            incomplete_details: null,
            error: null,
          }),
          { 'x-amzn-requestid': 'req-files', 'apim-request-id': 'apim-files' },
        );
  let attempts = 0;
  /** One call on a wire, with the host's reads leading its messages when `stableMessages` is given. */
  async function send(wire: Wire, cache: CacheRequest | null, stableMessages?: number, messages: ModelMessage[] = HOSTED) {
    const bodies: string[] = [];
    const transport = (async (_url: RequestInfo | URL, init?: RequestInit) => {
      bodies.push(String(init?.body));
      return ok(wire);
    }) as unknown as typeof globalThis.fetch;
    const common = {
      secret: 'test-only-key-0123456789abcdef-never-real',
      exposure,
      attempt: aws.exposureAttempt(`files-${++attempts}`, 'model:0', messages),
      instructions: INSTRUCTIONS,
      messages,
      tools: [],
      effort: 'high' as const,
      limits: CONVERSATION_LIMITS,
      signal: new AbortController().signal,
      transport,
      now: () => SCENARIO_NOW,
      ...(cache ? { cache, stablePrefix: STABLE_PREFIX } : {}),
      ...(stableMessages ? { stableMessages } : {}),
    };
    const result =
      wire === 'azure'
        ? await respondAzure({ ...common, connection: AZURE_CONNECTION, model: AZURE_MODELS.reasoning, card: azureRateCard(AZURE_CONNECTION, AZURE_MODELS.reasoning) })
        : await aws.respondOnce({
            ...common,
            connection: wire === 'aws-k3' ? K3_CONNECTION : LUNA_CONNECTION,
            card: aws.awsModelRateCard(wire === 'aws-k3' ? K3_CONNECTION.modelId : LUNA_CONNECTION.modelId),
            ...(wire === 'aws-k3' ? { qualification: K3_RECEIPT } : {}),
          });
    expect(bodies, wire).toHaveLength(1);
    return { result, text: bodies[0] };
  }
  /** The tool results in a body, by call id: a tool message on Chat Completions, a function_call_output on Responses. */
  const results = (wire: Wire, text: string) => {
    const body = bodyOf(text);
    return wire === 'aws-k3'
      ? (body.messages as Item[]).filter((item) => item.role === 'tool').map((item) => ({ id: item.tool_call_id, value: item.content }))
      : (body.input as Item[]).filter((item) => item.type === 'function_call_output').map((item) => ({ id: item.call_id, value: item.output }));
  };

  test('a second breakpoint goes on the last read\'s result, and the call reports the files marked', async () => {
    for (const wire of WIRES) {
      const { result, text } = await send(wire, EXPLICIT, 5);
      expect(result.marked, wire).toBe('stable-prefix-and-files');
      expect(occurrences(text, 'prompt_cache_breakpoint'), wire).toBe(2);
      const [first, last] = results(wire, text);
      // The first read is sent as it always is; the last carries the breakpoint on its one part.
      expect(first, wire).toMatchObject({ id: 'host-read-1' });
      expect(typeof first.value, wire).toBe('string');
      expect(last, wire).toEqual({
        id: 'host-read-2',
        value: [{ type: wire === 'aws-k3' ? 'text' : 'input_text', text: expect.stringContaining('Invoice 1182'), prompt_cache_breakpoint: { mode: 'explicit' } }],
      });
      expect(cacheFieldsMatch(text, EXPLICIT, true), wire).toBe(true);
      expect(cacheFieldsMatch(text, EXPLICIT), wire).toBe(false);
    }
  });

  test('without the host\'s reads, or under another setting, nothing more is marked and nothing else changes', async () => {
    for (const wire of WIRES) {
      // A count that does not end on a host read's result marks the instructions alone.
      const plain = await send(wire, EXPLICIT, 2);
      expect(plain.result.marked, wire).toBe('stable-prefix');
      expect(occurrences(plain.text, 'prompt_cache_breakpoint'), wire).toBe(1);
      const own: ModelMessage[] = [...HOSTED.slice(0, 5).map((message) => structuredClone(message)), HOSTED[5]];
      for (const message of own)
        if (message.role !== 'user' && Array.isArray(message.content))
          for (const part of message.content) if ('toolCallId' in part) part.toolCallId = part.toolCallId.replace('host-read-', 'call_');
      const provider = await send(wire, EXPLICIT, 5, own);
      expect(provider.result.marked, wire).toBe('stable-prefix');
      expect(occurrences(provider.text, 'prompt_cache_breakpoint'), wire).toBe(1);
      // Provider default and off send the same bytes with the count as without it.
      for (const cache of [PROVIDER_DEFAULT, OFF]) {
        const counted = await send(wire, cache, 5);
        const uncounted = await send(wire, cache);
        expect(counted.text, `${wire} ${cache.policy}`).toBe(uncounted.text);
        expect(occurrences(counted.text, 'prompt_cache_breakpoint'), wire).toBe(0);
      }
    }
  });

  test('the guard accepts the files breakpoint only on the last host read\'s result', () => {
    const fields = { prompt_cache_key: KEY, prompt_cache_options: { mode: 'explicit', ttl: '30m' } };
    const mark = { prompt_cache_breakpoint: { mode: 'explicit' } };
    const system = { role: 'system', content: [{ type: 'text', text: 'Rules.', ...mark }] };
    const tool = (id: string, marked = false) => ({ role: 'tool', tool_call_id: id, content: marked ? [{ type: 'text', text: '{}', ...mark }] : '{}' });
    const call = (id: string) => ({ role: 'assistant', content: null, tool_calls: [{ id, type: 'function', function: { name: 'read_source', arguments: '{}' } }] });
    const chat = (...messages: Item[]) => JSON.stringify({ model: 'm', ...fields, messages: [system, ...messages], stream: true });
    const opener = { role: 'user', content: HOST_READ_OPENER };
    const person = { role: 'user', content: 'Which deliveries arrived short?' };
    expect(cacheFieldsMatch(chat(opener, call('host-read-1'), tool('host-read-1'), call('host-read-2'), tool('host-read-2', true), person), EXPLICIT, true)).toBe(true);
    const developer = { role: 'developer', content: [{ type: 'input_text', text: 'Rules.', ...mark }] };
    const output = (id: string, marked = false) => ({ type: 'function_call_output', call_id: id, output: marked ? [{ type: 'input_text', text: '{}', ...mark }] : '{}' });
    const responses = (...items: Item[]) => JSON.stringify({ model: 'm', input: [developer, ...items], ...fields, stream: true });
    const fn = (id: string) => ({ type: 'function_call', call_id: id, name: 'read_source', arguments: '{}' });
    expect(cacheFieldsMatch(responses(opener, fn('host-read-1'), output('host-read-1', true), person), EXPLICIT, true)).toBe(true);
    for (const body of [
      // Only the instructions marked, when the files were to be.
      chat(opener, call('host-read-1'), tool('host-read-1'), person),
      // On a read that another host read follows.
      chat(opener, call('host-read-1'), tool('host-read-1', true), call('host-read-2'), tool('host-read-2'), person),
      // On the model's own call, or on the person's message.
      chat(opener, call('host-read-1'), tool('host-read-1'), person, call('call_1'), tool('call_1', true)),
      chat(opener, call('host-read-1'), tool('host-read-1'), { role: 'user', content: [{ type: 'text', text: 'Hi.', ...mark }] }),
      // Three breakpoints, or the files marked without the instructions.
      chat(opener, call('host-read-1'), tool('host-read-1', true), call('host-read-2'), tool('host-read-2', true), person),
      JSON.stringify({ model: 'm', ...fields, messages: [{ role: 'system', content: 'Rules.' }, opener, call('host-read-1'), tool('host-read-1', true), person] }),
      responses(opener, fn('host-read-1'), { ...output('host-read-1'), ...mark }, person),
    ])
      expect(cacheFieldsMatch(body, EXPLICIT, true), body).toBe(false);
    // A call that marks the files is refused by a guard that expects the instructions alone.
    expect(cacheFieldsMatch(chat(opener, call('host-read-1'), tool('host-read-1', true), person), EXPLICIT)).toBe(false);
  });
});
