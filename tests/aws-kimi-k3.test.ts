import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { createApp } from '../server/app.js';
import { testOnlySecretBox } from '../server/connection-secrets.js';
import * as aws from '../server/engines/aws-bedrock.js';
import { EngineService } from '../server/engines/service.js';
import { createAwsModelAdapter } from '../server/harness/aws-model-adapter.js';
import { FileModelTranscripts } from '../server/harness/model-transcripts.js';
import { ceilingCost, SpendExposure, usageCost, validateRateCard } from '../server/spend-exposure.js';
import { micro } from '../shared/managed-usage.js';
import type { Store } from '../server/store.js';
import { MANAGED_LUNA, type AwsConnectionView } from '../shared/model-api.js';

const KIMI_K3_US = 'us.moonshotai.kimi-k3';
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

  test('validates and prices the flat US K3 card without a context premium or dispatch qualification', () => {
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
    // A hypothetical numeric envelope includes the dearer cache-write price;
    // it does not establish that AWS K3 enforces such an output envelope.
    expect(ceilingCost(card, { maxInputTokens: 1_000, maxOutputTokens: 100 })).toBe(5_775);
    expect(aws.awsModelRefusal(KIMI_K3_US)).toContain('blocked');
  });

  test('keeps the existing Luna default and its managed rate card unchanged', () => {
    expect(aws.AWS_LUNA_MODEL).toBe(MANAGED_LUNA.model);
    expect(aws.awsModelRateCard(aws.AWS_LUNA_MODEL)).toBe(aws.AWS_LUNA_RATE_CARD);
    expect(aws.awsConnectionSchema.parse({ ...CONNECTION, modelId: aws.AWS_LUNA_MODEL }).modelId).toBe(MANAGED_LUNA.model);
    expect(MANAGED_LUNA.model).toBe('us.openai.gpt-5.6-luna');
    expect(MANAGED_LUNA.rateCard).toBe('aws-bedrock-gpt-5.6-luna-us-2026-09-28.1');
  });
});

describe('K3 setup through the existing AWS owner route', () => {
  const headers = { 'Content-Type': 'application/json', 'X-Diomedes-Client': '1' };
  let root: string;
  let app: Awaited<ReturnType<typeof createApp>>;
  let server: Server;
  let base: string;
  let dispatches: number;
  const store = () => app.locals.store as Store;
  const request = (route: string, method = 'GET', body?: unknown) =>
    fetch(`${base}/api${route}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const connect = (model: string) => request('/ai/model-api/aws-bedrock', 'PUT', {
    accountId: CONNECTION.accountId,
    region: CONNECTION.region,
    model,
    apiKey: 'test-only-bedrock-key-0123456789abcdef-never-real',
    expiresAt: null,
    consent: true,
  });

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'diomedes-aws-k3-app-'));
    dispatches = 0;
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
      modelApiTransport: (async () => {
        dispatches += 1;
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
    expect(view.next).toBe(aws.awsModelRefusal(KIMI_K3_US));
    expect(store().settings.services?.['aws-bedrockModel']).toBe(KIMI_K3_US);
    expect(store().settings.services?.defaultEngine).not.toBe('aws-bedrock');
    expect(JSON.stringify(view)).not.toContain('test-only-bedrock-key');

    const home = await (await request('/home/conversation', 'POST')).json() as { projectId: string; threadId: string };
    const state = store().state(home.projectId);
    const thread = state.conversations.find((item) => item.id === home.threadId)!;
    thread.engine = 'aws-bedrock';
    thread.engineChoice = 'person';
    await store().persist(state);
    const sent = await request(`/projects/${home.projectId}/threads/${home.threadId}/messages`, 'POST', {
      commandId: 'k3-unqualified', text: 'Read my order', mode: 'auto', sources: [], consent: true,
    });
    expect(sent.status).toBe(409);
    expect(await sent.json()).toMatchObject({ code: 'ROUTE_REFUSED', error: expect.stringContaining('Nothing was sent.') });
    expect(dispatches).toBe(0);
  });
});

describe('K3 catalog recognition does not qualify a billed Responses exchange', () => {
  let dir: string;
  let exposure: SpendExposure;
  let dispatches: number;
  const transport = (async () => {
    dispatches += 1;
    throw new Error('This fixture must never send a provider request.');
  }) as typeof globalThis.fetch;

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

  test('explains the unverified combined billed-token bound and preserves Luna’s existing call path', () => {
    expect(aws.awsModelRefusal(KIMI_K3_US)).toMatch(/reasoning.*output|output.*reasoning/);
    expect(aws.awsModelRefusal(KIMI_K3_US)).toContain('blocked');
    expect(aws.awsModelRefusal(aws.AWS_LUNA_MODEL)).toBeNull();
    expect(() => aws.awsModelRefusal('global.moonshotai.kimi-k3')).toThrow();
  });

  test.each(['low', 'medium', 'high'] as const)('refuses %s effort before reservation or credential-bearing dispatch', async (effort) => {
    const messages = [{ role: 'user' as const, content: 'What does the attached order say?' }];
    await expect(aws.respondOnce({
      connection: aws.awsConnectionSchema.parse(CONNECTION),
      secret: 'test-only-bedrock-key-0123456789abcdef-never-real',
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
    })).rejects.toMatchObject({
      name: 'ModelApiError',
      code: 'aws_model_unqualified',
      dispatched: false,
      message: expect.stringContaining('Nothing was sent.'),
    });
    expect(dispatches).toBe(0);
    expect(exposure.list(CONNECTION.id)).toEqual([]);
    expect(exposure.summary(CONNECTION.id)?.availableMicroUsd).toBe(10_000_000);
  });

  test('refuses the tool-capable native adapter before creating a provider exchange', () => {
    expect(() => createAwsModelAdapter({
      connection: aws.awsConnectionSchema.parse(CONNECTION),
      secret: 'test-only-bedrock-key-0123456789abcdef-never-real',
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
});
