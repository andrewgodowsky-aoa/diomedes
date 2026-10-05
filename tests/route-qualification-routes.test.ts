/**
 * The owner's route check routes through the real app: gating and refusal sentences, a run on the
 * AWS Kimi K3 connection and on one Azure deployment, one run at a time, and Stop. The provider
 * network is the scripted fixture injected as `modelApiTransport`; nothing reaches AWS or Azure.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { createApp } from '../server/app.js';
import { testOnlySecretBox } from '../server/connection-secrets.js';
import { EngineService } from '../server/engines/service.js';
import { AWS_KIMI_K3_REFUSAL, type AwsConnectionView, type RouteQualificationView } from '../shared/model-api.js';
import { hanging, routeCheckProvider, type Script } from './fixtures/route-check-provider.js';

const K3 = 'us.moonshotai.kimi-k3';
const SOL = 'gpt-6.1-sol';
const AWS_KEY = 'test-only-bedrock-key-0123456789abcdef-never-real';
const AZURE_KEY = 'test-only-azure-key-0123456789abcdef-never-real';
const AWS_BASE = 'https://bedrock-runtime.us-east-1.amazonaws.com/openai/v1';
const headers = { 'Content-Type': 'application/json', 'X-Diomedes-Client': '1' };
const rates = { inputUsdPerMillion: 2, outputUsdPerMillion: 12, cacheReadUsdPerMillion: 0.2, cacheWriteUsdPerMillion: null, source: 'the provider price page, read by the test owner' };

let root: string | undefined;
let app: Awaited<ReturnType<typeof createApp>>;
let server: Server | undefined;
let base: string;
let net = routeCheckProvider('chat', K3);

async function open(options: { protectedStorage?: boolean } = {}) {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'diomedes-route-check-routes-'));
  net = routeCheckProvider('chat', K3);
  app = await createApp({
    dataDir: path.join(root, 'data'),
    projectRoot: path.join(root, 'projects'),
    engineService: new EngineService(path.join(root, 'engines'), { discover: async () => [] }),
    reviewerAdapter: null,
    ...(options.protectedStorage === false ? {} : { secretBox: testOnlySecretBox() }),
    modelApiTransport: ((input: RequestInfo | URL, init?: RequestInit) => net.fetch(input, init)) as typeof globalThis.fetch,
  });
  server = await new Promise<Server>((resolve) => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
afterEach(async () => {
  if (server) {
    await app.locals.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
  }
  if (root) await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  root = undefined;
});

const request = async (route: string, method = 'GET', body?: unknown, signal?: AbortSignal) => {
  const response = await fetch(`${base}/api${route}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal,
  });
  const text = await response.text();
  return { status: response.status, text, data: JSON.parse(text) as any };
};
const connectAws = (expiresAt: string | null = null) =>
  request('/ai/model-api/aws-bedrock', 'PUT', {
    accountId: '123456789012',
    region: 'us-east-1',
    model: K3,
    apiKey: AWS_KEY,
    expiresAt,
    consent: true,
  });
const limitAws = (capUsd: number) => request('/ai/model-api/aws-bedrock/spend-limit', 'PUT', { capUsd, consent: true });
const qualifyAws = (signal?: AbortSignal) => request('/ai/model-api/aws-bedrock/qualify', 'POST', { consent: true }, signal);
const awsQualification = async () => (await request('/ai/model-api/aws-bedrock/qualification')).data as RouteQualificationView;

describe('route check gating', () => {
  test('refuses in plain words, with nothing sent, until a run can start', async () => {
    await open();
    const none = await qualifyAws();
    expect(none).toMatchObject({
      status: 409,
      data: { code: 'qualify_no_connection', error: 'Connect AWS Bedrock before running route checks.' },
    });
    expect(await awsQualification()).toEqual({
      route: 'aws-bedrock',
      model: null,
      deployment: null,
      receipt: null,
      qualifies: false,
      reason: 'No route check has been recorded for this connection.',
      required: false,
      blocked: 'Connect AWS Bedrock before running route checks.',
      ceilingMicroUsd: null,
      running: false,
    });
    expect((await request('/ai/model-api/aws-bedrock/qualify', 'POST', {})).status).toBe(400);

    expect((await connectAws(new Date(Date.now() + 30_000).toISOString())).status).toBe(200);
    expect((await qualifyAws()).data).toEqual({
      code: 'qualify_key_expired',
      error: 'The saved AWS key has expired. Enter a new key before running route checks.',
    });

    expect((await connectAws()).status).toBe(200);
    expect((await qualifyAws()).data).toEqual({
      code: 'qualify_no_limit',
      error: 'Approve a spend limit for AWS before running route checks.',
    });

    expect((await limitAws(0.05)).status).toBe(200);
    const view = await awsQualification();
    expect(view).toMatchObject({ model: K3, required: true, receipt: null, running: false });
    const dollars = `$${(Math.ceil(view.ceilingMicroUsd! / 10_000) / 100).toFixed(2)}`;
    const room = `The route checks can hold up to ${dollars}, and $0.05 of the AWS spend limit is left. Raise the limit or resolve open calls first.`;
    expect(view.blocked).toBe(room);
    expect(await qualifyAws()).toMatchObject({ status: 409, data: { code: 'qualify_no_room', error: room } });
    expect(net.seen).toEqual([]);
  });

  test('a process without protected credential storage cannot run route checks', async () => {
    await open({ protectedStorage: false });
    const sentence = 'Open the Diomedes desktop app to run route checks: this process has no protected credential storage.';
    expect((await awsQualification()).blocked).toBe(sentence);
    expect(await qualifyAws()).toMatchObject({ status: 409, data: { code: 'qualify_no_storage', error: sentence } });
    expect(net.seen).toEqual([]);
  });
});

describe('route checks on the AWS Kimi K3 connection', () => {
  test('a passing run is recorded, opens K3, and returns no key, prompt or answer text', async () => {
    await open();
    await connectAws();
    await limitAws(5);
    expect(((await request('/ai/model-api/aws-bedrock')).data as AwsConnectionView).next).toBe(AWS_KIMI_K3_REFUSAL);

    const run = await qualifyAws();
    expect(run.status, run.text).toBe(200);
    const view = run.data as RouteQualificationView;
    expect(view).toMatchObject({
      route: 'aws-bedrock',
      model: K3,
      deployment: null,
      qualifies: true,
      reason: null,
      required: true,
      blocked: null,
      running: false,
      receipt: {
        connectionId: 'aws-bedrock-1',
        connectionRevision: 1,
        protocol: 'openai-chat-completions',
        servedModels: [K3],
        verdicts: { answers: true, outputBound: 'bounded', tools: 'one-call', cacheDefault: 'caches', cacheOff: 'verified' },
      },
    });
    expect(net.seen).toHaveLength(8);
    expect(net.seen.every((call) => call.url === `${AWS_BASE}/chat/completions`)).toBe(true);
    for (const absent of [AWS_KEY, 'Reply with the single word', 'blue-42', 'Rule 1:']) expect(run.text).not.toContain(absent);
    const saved = JSON.parse(await fs.readFile(path.join(root!, 'data', 'connections', 'qualifications', 'aws-bedrock.json'), 'utf8'));
    expect(saved.receipts.map((receipt: { id: string }) => receipt.id)).toEqual([view.receipt!.id]);

    expect((await awsQualification()).receipt).toEqual(view.receipt);
    const setup = (await request('/ai/model-api/aws-bedrock')).data as AwsConnectionView;
    expect(setup.next).toBeNull();
    const held = setup.spend!.recent.filter((hold) => hold.runId === `qualify:${view.receipt!.id}`);
    expect(held).toHaveLength(8);
    expect(held.every((hold) => hold.state === 'settled')).toBe(true);
  });

  test('a run that saw billed output above the limit keeps K3 closed and says why', async () => {
    await open();
    await connectAws();
    await limitAws(5);
    net = routeCheckProvider('chat', K3, { outputBound: 300 });
    const view = (await qualifyAws()).data as RouteQualificationView;
    expect(view).toMatchObject({ qualifies: false, reason: 'The route check saw billed output above the limit it was sent with.' });
    expect(((await request('/ai/model-api/aws-bedrock')).data as AwsConnectionView).next).toBe(AWS_KIMI_K3_REFUSAL);
  });

  test('one run at a time per connection, shown as running while it lasts', async () => {
    await open();
    await connectAws();
    await limitAws(5);
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const script: Script = {
      intercept: async (kind) => {
        if (kind === 'short-answer') await held;
        return undefined;
      },
    };
    net = routeCheckProvider('chat', K3, script);
    const first = qualifyAws();
    await vi.waitFor(() => expect(net.seen).toHaveLength(1), { timeout: 10_000 });
    expect(await qualifyAws()).toMatchObject({
      status: 409,
      data: { code: 'qualify_running', error: 'Route checks are already running on this connection.' },
    });
    expect(await awsQualification()).toMatchObject({ running: true, blocked: 'Route checks are already running on this connection.' });
    release();
    expect((await first).status).toBe(200);
    expect(await awsQualification()).toMatchObject({ running: false, blocked: null, qualifies: true });
    expect(net.seen).toHaveLength(8);
  });

  test('closing the request stops the run; what it saw is still recorded', async () => {
    await open();
    await connectAws();
    await limitAws(5);
    net = routeCheckProvider('chat', K3, { intercept: (kind, signal) => (kind === 'tool-ask' ? hanging(signal) : undefined) });
    const stop = new AbortController();
    const run = qualifyAws(stop.signal).catch((error: unknown) => error);
    await vi.waitFor(() => expect(net.seen.map((call) => call.kind)).toContain('tool-ask'), { timeout: 10_000 });
    stop.abort();
    expect(await run).toMatchObject({ name: 'AbortError' });
    await vi.waitFor(async () => expect(await awsQualification()).toMatchObject({ running: false, receipt: expect.any(Object) }), {
      timeout: 10_000,
    });
    const { receipt } = await awsQualification();
    expect(receipt!.checks.map((check) => [check.id, check.outcome])).toEqual([
      ['short-answer', 'passed'],
      ['output-bound', 'passed'],
      ['tool-round-trip', 'failed'],
      ['cache-default', 'not-run'],
      ['cache-off', 'not-run'],
    ]);
    expect(receipt!.checks[2]).toMatchObject({ detail: 'Stopped before this check finished.', calls: [{ finish: 'cancelled', ledger: { state: 'uncertain' } }] });
    expect(net.seen).toHaveLength(3);
  });
});

describe('route checks on an Azure deployment', () => {
  test('runs on the named deployment over Responses and records a receipt for it', async () => {
    await open();
    const put = await request('/ai/model-api/azure-openai', 'PUT', {
      resourceName: 'contoso-ai',
      deployments: [{ model: SOL, deployment: 'sol-prod', reasoning: true, rates }],
      apiKey: AZURE_KEY,
      expiresAt: null,
      consent: true,
    });
    expect(put.status, put.text).toBe(200);
    expect((await request('/ai/model-api/azure-openai/spend-limit', 'PUT', { capUsd: 5, consent: true })).status).toBe(200);

    expect(await request('/ai/model-api/azure-openai/qualification')).toMatchObject({ status: 400, data: { error: 'Name the Azure model to check.' } });
    expect(await request('/ai/model-api/azure-openai/qualification?model=gpt-unknown')).toMatchObject({
      status: 409,
      data: { code: 'qualify_unknown_model', error: 'This Azure connection has no deployment for gpt-unknown.' },
    });

    net = routeCheckProvider('responses', 'gpt-6.1-sol-2026-09-15');
    const run = await request('/ai/model-api/azure-openai/qualify', 'POST', { consent: true, model: SOL });
    expect(run.status, run.text).toBe(200);
    expect(run.data).toMatchObject({
      route: 'azure-openai',
      model: SOL,
      deployment: 'sol-prod',
      required: false,
      qualifies: true,
      blocked: null,
      receipt: { deployment: 'sol-prod', protocol: 'openai-responses', servedModels: ['gpt-6.1-sol-2026-09-15'] },
    });
    expect(net.seen).toHaveLength(8);
    expect(net.seen.every((call) => call.url === 'https://contoso-ai.openai.azure.com/openai/v1/responses')).toBe(true);
    expect(run.text).not.toContain(AZURE_KEY);
    const read = await request(`/ai/model-api/azure-openai/qualification?model=${SOL}`);
    expect(read.data.receipt).toEqual(run.data.receipt);
  });
});
