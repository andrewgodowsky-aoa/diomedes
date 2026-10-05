import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { createApp } from '../server/app.js';
import { testOnlySecretBox } from '../server/connection-secrets.js';
import * as aws from '../server/engines/aws-bedrock.js';
import { LOOKUP_FACT } from '../server/engines/route-qualification.js';
import { RouteQualifications } from '../server/engines/route-qualification-store.js';
import { EngineService } from '../server/engines/service.js';
import { AWS_MODEL_CONTRACT, awsModelContract, createAwsModelAdapter } from '../server/harness/aws-model-adapter.js';
import { FileModelTranscripts } from '../server/harness/model-transcripts.js';
import { digest } from '../server/harness/policy.js';
import { ceilingCost, SpendExposure, usageCost, validateRateCard } from '../server/spend-exposure.js';
import { micro } from '../shared/managed-usage.js';
import type { Store } from '../server/store.js';
import { AWS_KIMI_K3_REFUSAL, MANAGED_LUNA, type AwsConnectionView } from '../shared/model-api.js';
import type { RouteQualificationReceipt } from '../shared/route-qualification.js';
import { chatEvents, sseResponse } from './fixtures/model-api-streams.js';
import { passingReceipt } from './fixtures/route-qualification-receipts.js';

const KIMI_K3_US = 'us.moonshotai.kimi-k3';
const SECRET = 'test-only-bedrock-key-0123456789abcdef-never-real';
const DAY_MS = 86_400_000;
const CONNECTION = {
  v: 1,
  id: 'aws-bedrock-1',
  accountId: '123456789012',
  region: 'us-east-1',
  baseUrl: aws.AWS_RESPONSES_ENDPOINTS['us-east-1'],
  modelId: KIMI_K3_US,
  processing: 'us-geo',
  credential: {
    kind: 'bedrock-api-key',
    fingerprint: 'abcdef123456',
    savedAt: '2026-10-01T03:00:00.000Z',
    expiresAt: null,
  },
  revision: 1,
  createdAt: '2026-10-01T03:00:00.000Z',
  updatedAt: '2026-10-01T03:00:00.000Z',
};
const k3 = (patch: Partial<typeof CONNECTION> = {}) => aws.awsConnectionSchema.parse({ ...CONNECTION, ...patch });
/** A receipt every check passed, for exactly this connection's identity. */
const receiptFor = (
  connection: aws.AwsConnection = k3(),
  options: Parameters<typeof passingReceipt>[1] = {},
): RouteQualificationReceipt =>
  passingReceipt({ ...aws.awsQualificationIdentity(connection), endpoint: connection.baseUrl, sdk: aws.AWS_BEDROCK_SDK }, options);

describe('the direct AWS Kimi K3 selection', () => {
  test('accepts the exact US K3 profile at the existing owner-paid runtime endpoint', () => {
    expect(aws.awsConnectionSchema.parse(CONNECTION)).toEqual(CONNECTION);
    expect(aws.AWS_VETTED_MODELS['us-east-1']).toContain(KIMI_K3_US);
    expect(aws.awsAccountRoute(CONNECTION)).toBe('aws-bedrock:aws-bedrock-1@r1');
    expect(aws.accountEvidence).toContain('not a verified identity');
  });

  test.each([
    ['bare K3 model', { modelId: 'moonshotai.kimi-k3' }],
    ['Global K3 profile', { modelId: 'global.moonshotai.kimi-k3' }],
    ['a different Kimi model', { modelId: 'us.moonshotai.kimi-k2.5' }],
    ['a different processing boundary', { processing: 'global' }],
    ['a different region', { region: 'us-west-2' }],
    ['a different endpoint', { baseUrl: 'https://bedrock-mantle.us-east-1.api.aws/v1' }],
  ])('refuses %s without substituting an identity or region', (_description, patch) => {
    expect(aws.awsConnectionSchema.safeParse({ ...CONNECTION, ...patch }).success).toBe(false);
  });

  test('selects the US Standard K3 rate card, including the higher cache-write input price', () => {
    const card = aws.awsModelRateCard(KIMI_K3_US);
    expect(card).toMatchObject({
      route: 'aws-bedrock',
      modelId: KIMI_K3_US,
      short: { input: 3_300_000, cacheRead: 330_000, cacheWrite: 4_125_000, output: 16_500_000 },
    });
    expect(card.source).toContain('https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-moonshot-ai-kimi-k3.html');
    expect(card.source).toContain('2026-10-01');
    expect(() => aws.awsModelRateCard('global.moonshotai.kimi-k3')).toThrow();
    expect(() => aws.awsModelRateCard('moonshotai.kimi-k3')).toThrow();
  });

  test('validates and prices the flat US K3 card without a context premium', () => {
    const card = validateRateCard(aws.awsModelRateCard(KIMI_K3_US));
    expect(card.long).toEqual(card.short);
    // Local ledger arithmetic only: both sides of its required band marker retain
    // the same published price. The marker is not a provider context/token limit.
    for (const inputTokens of [1_000, 272_001, card.shortContextMaxInputTokens, card.shortContextMaxInputTokens + 1]) {
      expect(usageCost(card, {
        inputTokens, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0, reasoningTokens: 0,
      }).microUsd).toBe(Math.ceil(inputTokens * 3.3));
    }
    expect(usageCost(card, {
      inputTokens: 1_000_000,
      cacheReadTokens: 100_000,
      cacheWriteTokens: 200_000,
      outputTokens: 10_000,
      reasoningTokens: 8_000,
    }).microUsd).toBe(3_333_000);
    // A numeric envelope includes the dearer cache-write price; whether AWS K3 keeps billed
    // output inside it is what the route checks' output bound observes.
    expect(ceilingCost(card, { maxInputTokens: 1_000, maxOutputTokens: 100 })).toBe(5_775);
  });

  test('sends K3 over Chat Completions and Luna over Responses; an unknown identity has no protocol', () => {
    expect(aws.awsProtocolFor(KIMI_K3_US)).toBe('openai-chat-completions');
    expect(aws.awsProtocolFor(aws.AWS_LUNA_MODEL)).toBe('openai-responses');
    expect(() => aws.awsProtocolFor('global.moonshotai.kimi-k3')).toThrowError(
      expect.objectContaining({ code: 'aws_unknown_model' }),
    );
    expect(AWS_KIMI_K3_REFUSAL).toBe(
      'Kimi K3 needs a passing route check on this connection before it sends. Run the route checks in AI setup.',
    );
  });

  test('keeps the existing Luna default and its managed rate card unchanged', () => {
    expect(aws.AWS_LUNA_MODEL).toBe(MANAGED_LUNA.model);
    expect(aws.awsModelRateCard(aws.AWS_LUNA_MODEL)).toBe(aws.AWS_LUNA_RATE_CARD);
    expect(aws.awsConnectionSchema.parse({ ...CONNECTION, modelId: aws.AWS_LUNA_MODEL }).modelId).toBe(MANAGED_LUNA.model);
    expect(MANAGED_LUNA.model).toBe('us.openai.gpt-5.6-luna');
    expect(MANAGED_LUNA.rateCard).toBe('aws-bedrock-gpt-5.6-luna-us-2026-09-28.1');
  });
});

describe('the AWS Chat Completions binding for K3', () => {
  test('binds K3 to the chat endpoint and Luna to the Responses endpoint, with the chat options stated', () => {
    const chat = aws.awsBinding(k3(), 'medium', true, 512, true);
    expect(chat.guard.expectedUrl).toBe(`${CONNECTION.baseUrl}/chat/completions`);
    expect(chat.guard.inspectBody).toBeTypeOf('function');
    expect(chat.providerOptions).toEqual({
      openai: { forceReasoning: true, systemMessageMode: 'system', reasoningEffort: 'medium', parallelToolCalls: false, store: false },
    });
    // With no tool offered, the parallel tool call setting is not sent at all.
    expect(aws.awsBinding(k3(), 'medium', true, 512, false).providerOptions).toEqual({
      openai: { forceReasoning: true, systemMessageMode: 'system', reasoningEffort: 'medium', store: false },
    });
    const luna = aws.awsBinding(k3({ modelId: aws.AWS_LUNA_MODEL }), 'medium', true, 512, false);
    expect(luna.guard.expectedUrl).toBe(`${CONNECTION.baseUrl}/responses`);
    expect(luna.providerOptions.openai).toMatchObject({ systemMessageMode: 'developer', reasoningSummary: 'auto' });
  });

  test('the guard passes only the admitted model, a usage report and the exact output limit, and lets cache fields through', () => {
    const inspect = aws.inspectAwsChatBody(KIMI_K3_US, 512);
    const good = { model: KIMI_K3_US, stream: true, stream_options: { include_usage: true }, max_completion_tokens: 512, messages: [] };
    expect(() => inspect(JSON.stringify(good))).not.toThrow();
    expect(() =>
      inspect(JSON.stringify({ ...good, prompt_cache_options: { mode: 'explicit' }, prompt_cache_key: 'fixture-key' })),
    ).not.toThrow();
    for (const bad of [
      { ...good, model: aws.AWS_LUNA_MODEL },
      { ...good, stream: false },
      { ...good, stream_options: {} },
      { ...good, stream_options: undefined },
      { ...good, max_completion_tokens: 511 },
      { ...good, max_completion_tokens: 512.5 },
      { ...good, max_completion_tokens: undefined },
      { ...good, max_tokens: 512 },
      [good],
    ])
      expect(() => inspect(JSON.stringify(bad))).toThrowError(
        expect.objectContaining({ code: 'aws_request_refused', dispatched: false }),
      );
    expect(() => inspect('not json')).toThrowError(expect.objectContaining({ code: 'aws_request_refused' }));
  });

  test('a qualifying receipt sends one exact Chat Completions request and settles it from the reported usage', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'diomedes-aws-k3-chat-'));
    try {
      const exposure = new SpendExposure(path.join(dir, 'spend'));
      await exposure.init();
      await exposure.setCap(CONNECTION.id, micro(10_000_000), { approvedBy: 'test owner', note: 'Fixture cap; no live request.' });
      const seen: { url: string; headers: Headers; body: Record<string, unknown> }[] = [];
      const transport = (async (input: RequestInfo | URL, init?: RequestInit) => {
        seen.push({ url: String(input), headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) });
        return sseResponse(
          chatEvents({
            id: 'chatcmpl-k3-1',
            model: KIMI_K3_US,
            text: 'The order is for soup.',
            usage: { prompt_tokens: 120, completion_tokens: 30, total_tokens: 150, completion_tokens_details: { reasoning_tokens: 12 } },
          }),
          { 'x-amzn-requestid': 'req-k3-1' },
        );
      }) as typeof globalThis.fetch;
      const messages = [{ role: 'user' as const, content: 'What does the attached order say?' }];
      const result = await aws.respondOnce({
        connection: k3(),
        secret: SECRET,
        card: aws.awsModelRateCard(KIMI_K3_US),
        exposure,
        attempt: aws.exposureAttempt('k3-qualified', 'model:0', messages),
        instructions: 'Answer only from the admitted sources.',
        messages,
        tools: [],
        effort: 'high',
        limits: aws.CONVERSATION_LIMITS,
        signal: new AbortController().signal,
        transport,
        qualification: receiptFor(),
      });
      expect(seen).toHaveLength(1);
      const [sent] = seen;
      expect(sent.url).toBe(`${CONNECTION.baseUrl}/chat/completions`);
      expect(sent.headers.get('authorization')).toBe(`Bearer ${SECRET}`);
      expect(sent.body).toMatchObject({
        model: KIMI_K3_US,
        stream: true,
        stream_options: { include_usage: true },
        max_completion_tokens: aws.CONVERSATION_LIMITS.maxOutputTokens,
        reasoning_effort: 'high',
        store: false,
      });
      // No tool is offered, so neither tools nor the parallel tool call setting are sent.
      expect(sent.body).not.toHaveProperty('tools');
      expect(sent.body).not.toHaveProperty('parallel_tool_calls');
      expect(sent.body).not.toHaveProperty('max_tokens');
      expect(sent.body).not.toHaveProperty('prompt_cache_key');
      expect(sent.body).not.toHaveProperty('prompt_cache_options');
      expect((sent.body.messages as unknown[])[0]).toEqual({ role: 'system', content: 'Answer only from the admitted sources.' });
      expect(result.outcome).toEqual({ kind: 'final', text: 'The order is for soup.' });
      expect(result).toMatchObject({ reportedModel: KIMI_K3_US, responseId: 'chatcmpl-k3-1', providerRequestId: 'req-k3-1' });
      expect(result.usage).toMatchObject({ inputTokens: 120, outputTokens: 30, reasoningTokens: 12 });
      expect(exposure.list(CONNECTION.id).map((hold) => hold.state)).toEqual(['settled']);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  test('a call that offers a tool sends parallel tool calls off beside it', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'diomedes-aws-k3-tools-'));
    try {
      const exposure = new SpendExposure(path.join(dir, 'spend'));
      await exposure.init();
      await exposure.setCap(CONNECTION.id, micro(10_000_000), { approvedBy: 'test owner', note: 'Fixture cap; no live request.' });
      const seen: Record<string, unknown>[] = [];
      const transport = (async (_input: RequestInfo | URL, init?: RequestInit) => {
        seen.push(JSON.parse(String(init?.body)));
        return sseResponse(
          chatEvents({ id: 'chatcmpl-k3-2', model: KIMI_K3_US, text: 'OK', usage: { prompt_tokens: 90, completion_tokens: 4, total_tokens: 94 } }),
          { 'x-amzn-requestid': 'req-k3-2' },
        );
      }) as typeof globalThis.fetch;
      const messages = [{ role: 'user' as const, content: 'Look up the key alpha.' }];
      await aws.respondOnce({
        connection: k3(),
        secret: SECRET,
        card: aws.awsModelRateCard(KIMI_K3_US),
        exposure,
        attempt: aws.exposureAttempt('k3-tools', 'model:0', messages),
        instructions: 'Use the offered tool.',
        messages,
        tools: [LOOKUP_FACT],
        effort: 'low',
        limits: aws.CONVERSATION_LIMITS,
        signal: new AbortController().signal,
        transport,
        qualification: receiptFor(),
      });
      expect(seen).toHaveLength(1);
      expect(seen[0]).toMatchObject({ parallel_tool_calls: false, tools: [expect.objectContaining({ type: 'function' })] });
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

describe('K3 setup through the existing AWS owner route', () => {
  const headers = { 'Content-Type': 'application/json', 'X-Diomedes-Client': '1' };
  let root: string;
  let app: Awaited<ReturnType<typeof createApp>>;
  let server: Server;
  let base: string;
  let dispatched: string[];
  const store = () => app.locals.store as Store;
  const request = (route: string, method = 'GET', body?: unknown) =>
    fetch(`${base}/api${route}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const connect = (model: string) => request('/ai/model-api/aws-bedrock', 'PUT', {
    accountId: CONNECTION.accountId,
    region: CONNECTION.region,
    model,
    apiKey: SECRET,
    expiresAt: null,
    consent: true,
  });
  /** A Home conversation on AWS, and one message sent on it. */
  const send = async (commandId: string) => {
    const home = await (await request('/home/conversation', 'POST')).json() as { projectId: string; threadId: string };
    const state = store().state(home.projectId);
    const thread = state.conversations.find((item) => item.id === home.threadId)!;
    thread.engine = 'aws-bedrock';
    thread.engineChoice = 'person';
    await store().persist(state);
    return request(`/projects/${home.projectId}/threads/${home.threadId}/messages`, 'POST', {
      commandId, text: 'Read my order', mode: 'auto', sources: [], consent: true,
    });
  };

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'diomedes-aws-k3-app-'));
    dispatched = [];
    app = await createApp({
      dataDir: path.join(root, 'data'),
      projectRoot: path.join(root, 'projects'),
      engineService: new EngineService(path.join(root, 'engines'), {
        discover: async () => [],
        version: async () => { throw new Error('No native engine is checked in this fixture.'); },
        adapter: () => { throw new Error('No native engine is invoked in this fixture.'); },
      }),
      reviewerAdapter: null,
      secretBox: testOnlySecretBox(),
      modelApiTransport: (async (input: RequestInfo | URL) => {
        dispatched.push(String(input));
        throw new Error('This fixture must never reach AWS.');
      }) as typeof globalThis.fetch,
    });
    server = await new Promise<Server>((resolve) => {
      const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
    });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterEach(async () => {
    await app.locals.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await fs.rm(root, { recursive: true, force: true });
  });

  test('saves the exact K3 selection and price without qualifying access, resetting spend, or sending a message', async () => {
    expect((await connect(aws.AWS_LUNA_MODEL)).status).toBe(200);
    expect((await request('/ai/model-api/aws-bedrock/spend-limit', 'PUT', { capUsd: 1, consent: true })).status).toBe(200);
    const selected = await connect(KIMI_K3_US);
    expect(selected.status).toBe(200);
    const view = await selected.json() as AwsConnectionView;
    expect(view.connection).toMatchObject({
      model: KIMI_K3_US,
      revision: 2,
      accountRoute: 'aws-bedrock:aws-bedrock-1@r2',
      region: 'us-east-1',
      endpoint: CONNECTION.baseUrl,
      processing: 'us-geo',
      accountEvidence: expect.stringContaining('not a verified identity'),
    });
    expect(view.spend).toMatchObject({
      rateCard: aws.awsModelRateCard(KIMI_K3_US).version,
      capMicroUsd: 1_000_000,
      settledMicroUsd: 0,
      pendingMicroUsd: 0,
      recent: [],
    });
    expect(view.next).toBe(AWS_KIMI_K3_REFUSAL);
    expect(store().settings.services?.['aws-bedrockModel']).toBe(KIMI_K3_US);
    expect(store().settings.services?.defaultEngine).not.toBe('aws-bedrock');
    expect(JSON.stringify(view)).not.toContain('test-only-bedrock-key');

    const sent = await send('k3-unqualified');
    expect(sent.status).toBe(409);
    expect(await sent.json()).toMatchObject({ code: 'ROUTE_REFUSED', error: `${AWS_KIMI_K3_REFUSAL} Nothing was sent.` });
    expect(dispatched).toEqual([]);
  });

  test('without a spend limit the setup asks for one first: the route checks cannot run without it', async () => {
    const view = await (await connect(KIMI_K3_US)).json() as AwsConnectionView;
    expect(view.next).toBe('Approve a spend limit for AWS before sending.');
  });

  test('a receipt for the current revision opens K3 to the Chat Completions endpoint; a reconnect closes it again', async () => {
    expect((await connect(aws.AWS_LUNA_MODEL)).status).toBe(200);
    expect((await request('/ai/model-api/aws-bedrock/spend-limit', 'PUT', { capUsd: 1, consent: true })).status).toBe(200);
    const selected = await connect(KIMI_K3_US);
    const connection = (await selected.json() as AwsConnectionView).connection!;
    const saved = k3({ revision: connection.revision, credential: { ...CONNECTION.credential, fingerprint: connection.credential.fingerprint, savedAt: connection.credential.savedAt } });
    await new RouteQualifications(path.join(root, 'data')).record(receiptFor(saved));

    const view = await (await request('/ai/model-api/aws-bedrock')).json() as AwsConnectionView;
    expect(view.next).toBeNull();
    // The gate opens: the request reaches the Chat Completions endpoint. This fixture network then
    // fails after dispatch, so the turn ends uncertain rather than refused.
    const sent = await send('k3-qualified');
    expect(await sent.json()).toMatchObject({ code: 'DISPATCH_UNCERTAIN' });
    expect(dispatched).toEqual([`${CONNECTION.baseUrl}/chat/completions`]);

    // A reconnect is a new revision: the recorded check no longer covers it.
    expect((await connect(KIMI_K3_US)).status).toBe(200);
    const after = await (await request('/ai/model-api/aws-bedrock')).json() as AwsConnectionView;
    expect(after.connection?.revision).toBe(connection.revision + 1);
    expect(after.next).toBe(AWS_KIMI_K3_REFUSAL);
    const refused = await send('k3-after-reconnect');
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({ code: 'ROUTE_REFUSED' });
    expect(dispatched).toHaveLength(1);
  });
});

describe('the K3 receipt gate on a direct call', () => {
  let dir: string;
  let exposure: SpendExposure;
  let dispatches: number;
  const transport = (async () => {
    dispatches += 1;
    throw new Error('This fixture must never send a provider request.');
  }) as typeof globalThis.fetch;
  const call = (effort: 'low' | 'medium' | 'high', options: { connection?: aws.AwsConnection; qualification?: RouteQualificationReceipt | null } = {}) => {
    const messages = [{ role: 'user' as const, content: 'What does the attached order say?' }];
    return aws.respondOnce({
      connection: options.connection ?? k3(),
      secret: SECRET,
      card: aws.awsModelRateCard(KIMI_K3_US),
      exposure,
      attempt: aws.exposureAttempt(`k3-${effort}`, 'model:0', messages),
      instructions: 'Answer only from the admitted sources.',
      messages,
      tools: [],
      effort,
      limits: aws.CONVERSATION_LIMITS,
      signal: new AbortController().signal,
      transport,
      qualification: options.qualification,
    });
  };
  const refusedBeforeAnything = async (attempt: Promise<unknown>) => {
    await expect(attempt).rejects.toMatchObject({
      name: 'ModelApiError',
      code: 'aws_model_unqualified',
      dispatched: false,
      message: `${AWS_KIMI_K3_REFUSAL} Nothing was sent.`,
    });
    expect(dispatches).toBe(0);
    expect(exposure.list(CONNECTION.id)).toEqual([]);
    expect(exposure.summary(CONNECTION.id)?.availableMicroUsd).toBe(10_000_000);
  };

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'diomedes-aws-k3-'));
    exposure = new SpendExposure(path.join(dir, 'spend'));
    await exposure.init();
    await exposure.setCap(CONNECTION.id, micro(10_000_000), { approvedBy: 'test owner', note: 'Fixture cap; no live request.' });
    dispatches = 0;
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  test('Luna needs no receipt; K3 needs one; an unknown identity is refused outright', () => {
    const now = Date.now();
    expect(aws.awsModelRefusal(k3({ modelId: aws.AWS_LUNA_MODEL }), null, now)).toBeNull();
    expect(aws.awsModelRefusal(k3(), null, now)).toBe(AWS_KIMI_K3_REFUSAL);
    expect(aws.awsModelRefusal(k3(), receiptFor(), now)).toBeNull();
    const unknown = { id: CONNECTION.id, revision: 1, modelId: 'global.moonshotai.kimi-k3' as aws.AwsConnection['modelId'] };
    expect(() => aws.awsModelRefusal(unknown, null, now)).toThrowError(expect.objectContaining({ code: 'aws_unknown_model' }));
  });

  test.each(['low', 'medium', 'high'] as const)('refuses %s effort without a receipt before reservation or credential-bearing dispatch', async (effort) => {
    await refusedBeforeAnything(call(effort));
  });

  const stale: [string, () => { connection?: aws.AwsConnection; qualification: RouteQualificationReceipt }][] = [
    ['an expired receipt', () => ({ qualification: receiptFor(k3(), { createdAt: new Date(Date.now() - 31 * DAY_MS) }) })],
    ['a receipt from before a revision bump', () => ({ connection: k3({ revision: 2 }), qualification: receiptFor(k3({ revision: 1 })) })],
    ['a receipt made under another rate card', () => ({ qualification: receiptFor(k3(), { patch: { rateCard: 'aws-bedrock-kimi-k3-us-earlier' } }) })],
    ['a receipt that saw billed output above the limit', () => ({ qualification: receiptFor(k3(), { patch: { verdicts: { ...receiptFor().verdicts, outputBound: 'exceeded' } } }) })],
    ['a receipt that could not confirm the output bound', () => ({ qualification: receiptFor(k3(), { patch: { verdicts: { ...receiptFor().verdicts, outputBound: 'unknown' } } }) })],
    ['a receipt whose tool round trip failed', () => ({ qualification: receiptFor(k3(), { patch: { verdicts: { ...receiptFor().verdicts, tools: 'failed' } } }) })],
    ['a receipt with no complete answer', () => ({ qualification: receiptFor(k3(), { patch: { verdicts: { ...receiptFor().verdicts, answers: false } } }) })],
    ['a receipt made over another protocol', () => ({ qualification: receiptFor(k3(), { patch: { protocol: 'openai-responses' } }) })],
    ['a receipt for another connection', () => ({ qualification: receiptFor(k3(), { patch: { connectionId: 'aws-bedrock-2' } }) })],
  ];
  test.each(stale)('refuses K3 under %s, with nothing reserved or sent', async (_name, make) => {
    const { connection, qualification } = make();
    expect(aws.awsModelRefusal(connection ?? k3(), qualification, Date.now())).toBe(AWS_KIMI_K3_REFUSAL);
    await refusedBeforeAnything(call('low', { connection, qualification }));
  });

  test('reads the newest receipt for this connection and model, and none without a store or for Luna', async () => {
    const receipts = new RouteQualifications(path.join(dir, 'data'));
    expect(await aws.awsQualificationFor(undefined, k3())).toBeNull();
    expect(await aws.awsQualificationFor(receipts, k3())).toBeNull();
    const older = await receipts.record(receiptFor(k3(), { id: 'rq_older0001' }));
    const newer = await receipts.record(
      receiptFor(k3(), { id: 'rq_newer0001', patch: { verdicts: { ...older.verdicts, tools: 'failed' } } }),
    );
    // The newest run governs, even when an older one passed.
    expect(await aws.awsQualificationFor(receipts, k3())).toEqual(newer);
    expect(aws.awsModelRefusal(k3(), newer, Date.now())).toBe(AWS_KIMI_K3_REFUSAL);
    expect(await aws.awsQualificationFor(receipts, k3({ modelId: aws.AWS_LUNA_MODEL }))).toBeNull();
  });

  test('refuses the tool-capable native adapter without a receipt, before creating a provider exchange', () => {
    expect(() => createAwsModelAdapter({
      connection: k3(),
      secret: SECRET,
      card: aws.awsModelRateCard(KIMI_K3_US),
      exposure,
      transcripts: new FileModelTranscripts(path.join(dir, 'transcripts'), 'aws-bedrock'),
      instructions: 'Use only admitted local tools.',
      effort: 'medium',
      transport,
    })).toThrowError(expect.objectContaining({ code: 'aws_model_unqualified', dispatched: false }));
    expect(dispatches).toBe(0);
    expect(exposure.list(CONNECTION.id)).toEqual([]);
  });

  test('under a qualifying receipt the adapter states Chat Completions, no streamed thinking, and binds the protocol', () => {
    const options = {
      secret: SECRET,
      exposure,
      transcripts: new FileModelTranscripts(path.join(dir, 'transcripts'), 'aws-bedrock'),
      instructions: 'Use only admitted local tools.',
      effort: 'medium' as const,
      transport,
    };
    const adapter = createAwsModelAdapter({ ...options, connection: k3(), card: aws.awsModelRateCard(KIMI_K3_US), qualification: receiptFor() });
    expect(adapter.contract.engine.protocolVersion).toBe('openai-chat-completions');
    expect(adapter.contract.streaming.reasoning).toBe('none');
    expect(adapter.capabilities().protocolVersion).toBe('openai-chat-completions');
    expect(adapter.capabilities().notes[0]).toContain('Chat Completions');
    expect(awsModelContract(aws.AWS_LUNA_MODEL)).toBe(AWS_MODEL_CONTRACT);
    const luna = createAwsModelAdapter({ ...options, connection: k3({ modelId: aws.AWS_LUNA_MODEL }), card: aws.AWS_LUNA_RATE_CARD });
    expect(luna.capabilities().protocolVersion).toBe('openai-responses');
    expect(luna.profileHash).not.toBe(adapter.profileHash);
    // Luna's profile is exactly the one it had before protocols were named, so a Luna step saved by
    // an earlier version still resumes; only K3's profile names its protocol.
    const before = {
      route: aws.AWS_BEDROCK_ROUTE,
      sdk: aws.AWS_BEDROCK_SDK,
      connectionId: CONNECTION.id,
      revision: CONNECTION.revision,
      baseUrl: CONNECTION.baseUrl,
      modelId: aws.AWS_LUNA_MODEL,
      instructions: digest(options.instructions),
      effort: options.effort,
      limits: aws.CONVERSATION_LIMITS,
      rateCard: aws.AWS_LUNA_RATE_CARD.version,
    };
    expect(luna.profileHash).toBe(digest(before));
    expect(adapter.profileHash).toBe(
      digest({ ...before, protocol: 'openai-chat-completions', modelId: KIMI_K3_US, rateCard: aws.awsModelRateCard(KIMI_K3_US).version }),
    );
    expect(dispatches).toBe(0);
  });
});
