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
import { CHECK_CACHE_OFF } from '../server/engines/route-qualification.js';
import { SpendExposure } from '../server/spend-exposure.js';
import base from './fixtures/cache-base-bodies.json';
import {
  CALL_SCENARIOS,
  INSTRUCTIONS,
  K3_CONNECTION,
  K3_RECEIPT,
  SCENARIO_NAMES,
  SCENARIO_NOW,
  STABLE_PREFIX,
  VARIABLE_PART,
  scenarioBodies,
  type ScenarioName,
} from './fixtures/cache-body-scenarios.js';
import { chatEvents, sseResponse } from './fixtures/model-api-streams.js';

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
