/**
 * The owner's AWS Bedrock route on GPT-6 Luna (bot-mode item 7). The route's model,
 * its price card and the saved connection's model literal move to GPT-6 Luna
 * together, from the one registry row the Nectovia route prices with. A connection
 * an earlier version saved for GPT-5.6 Luna is not a crash and not a silent
 * substitution: the view and a send both say to reconnect, nothing is sent, and the
 * reconnect keeps the connection's revision increasing so no old result can land.
 */
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../server/app';
import { EngineService } from '../server/engines/service';
import {
  AWS_BEDROCK_ROUTE,
  AWS_LUNA_MODEL,
  AWS_LUNA_RATE_CARD,
  AWS_RECONNECT,
  AWS_RESPONSES_ENDPOINTS,
  AwsConnections,
  awsConnectionSchema,
  type AwsConnection,
} from '../server/engines/aws-bedrock';
import { testOnlySecretBox } from '../server/connection-secrets';
import { HarnessError } from '../server/harness/policy';
import type { Store } from '../server/store';
import { GPT6_LUNA, MODEL_API_NAMES, type AwsConnectionView } from '../shared/model-api';

const RETIRED = 'us.openai.gpt-5.6-luna';
const at = '2026-09-20T12:00:00.000Z';

const saved = (modelId: string, revision = 3): Record<string, unknown> => ({
  v: 1,
  id: 'aws-bedrock-1',
  accountId: '123456789012',
  region: 'us-east-1',
  baseUrl: AWS_RESPONSES_ENDPOINTS['us-east-1'],
  modelId,
  processing: 'us-geo',
  credential: { kind: 'bedrock-api-key', fingerprint: 'abcdef012345', savedAt: at, expiresAt: null },
  revision,
  createdAt: at,
  updatedAt: at,
});

async function writeRecord(dataDir: string, record: Record<string, unknown>) {
  await fs.mkdir(path.join(dataDir, 'connections'), { recursive: true });
  await fs.writeFile(path.join(dataDir, 'connections', `${AWS_BEDROCK_ROUTE}.json`), JSON.stringify(record));
}

describe('the route names GPT-6 Luna everywhere at once', () => {
  test('model, price card and display name come from the registry row', () => {
    expect(AWS_LUNA_MODEL).toBe('us.openai.gpt-6-luna');
    expect(AWS_LUNA_MODEL).toBe(GPT6_LUNA.model);
    expect(MODEL_API_NAMES[AWS_BEDROCK_ROUTE]).toBe('AWS Bedrock (GPT-6 Luna)');
    const band = { input: 110_000, cacheRead: 11_000, cacheWrite: 137_500, output: 550_000 };
    expect(AWS_LUNA_RATE_CARD).toEqual({
      version: 'aws-bedrock-gpt-6-luna-us-2026-09-25.1',
      route: AWS_BEDROCK_ROUTE,
      modelId: 'us.openai.gpt-6-luna',
      source: expect.stringContaining('GPT-6 Luna'),
      shortContextMaxInputTokens: 272_000,
      short: band,
      // The registry has no long-context price, so a long input is priced at the same band.
      long: band,
    });
  });

  test('the saved connection accepts GPT-6 Luna and nothing older', () => {
    expect(awsConnectionSchema.safeParse(saved(AWS_LUNA_MODEL)).success).toBe(true);
    expect(awsConnectionSchema.safeParse(saved(RETIRED)).success).toBe(false);
  });
});

describe('a connection saved for GPT-5.6 Luna', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'diomedes-aws-gpt6-'));
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  test('reads as retired with a reconnect sentence and the revision it reached', async () => {
    await writeRecord(dir, saved(RETIRED, 3));
    const error = await new AwsConnections(dir).read().then(
      () => null,
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(HarnessError);
    expect(error).toMatchObject({ code: 'connection_retired', message: AWS_RECONNECT, retired: { revision: 3, createdAt: at } });
    expect(AWS_RECONNECT).toMatch(/Reconnect AWS Bedrock/);
    expect(AWS_RECONNECT).toMatch(/GPT-6 Luna/);
  });

  test('a record that is wrong in any other way is still unreadable, not retired', async () => {
    await writeRecord(dir, { ...saved(RETIRED), accountId: 'not-an-account' });
    await expect(new AwsConnections(dir).read()).rejects.toMatchObject({ code: 'connection_corrupt' });
  });
});

describe('through the real app', () => {
  const headers = { 'Content-Type': 'application/json', 'X-Diomedes-Client': '1' };
  let root: string;
  let app: Awaited<ReturnType<typeof createApp>>;
  let server: Server;
  let base: string;
  let calls: number;
  const store = () => app.locals.store as Store;
  const request = (route: string, method = 'GET', body?: unknown) =>
    fetch(`${base}/api${route}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'diomedes-aws-gpt6-app-'));
    calls = 0;
    app = await createApp({
      dataDir: path.join(root, 'data'),
      projectRoot: path.join(root, 'projects'),
      engineService: new EngineService(path.join(root, 'engines'), {
        discover: async () => [],
        version: async () => {
          throw new Error('No engine is checked in this fixture');
        },
        adapter: () => {
          throw new Error('No native adapter exists in this fixture');
        },
      }),
      reviewerAdapter: null,
      secretBox: testOnlySecretBox(),
      modelApiTransport: (async () => {
        calls += 1;
        throw new Error('No AWS call is made in this fixture');
      }) as typeof globalThis.fetch,
    });
    server = await new Promise<Server>((resolve) => {
      const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
    });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    // Exactly what an earlier version left: the 5.6 connection at revision 3, switched on,
    // with Settings naming its model and account route.
    await writeRecord(store().dataDir, saved(RETIRED, 3));
    await store().saveSettings({
      ...store().settings,
      services: {
        ...store().settings.services,
        [AWS_BEDROCK_ROUTE]: true,
        [`${AWS_BEDROCK_ROUTE}Model`]: RETIRED,
        [`${AWS_BEDROCK_ROUTE}AccountRoute`]: 'aws-bedrock:aws-bedrock-1@r3',
      },
    });
  });
  afterEach(async () => {
    await app.locals.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await fs.rm(root, { recursive: true, force: true });
  });

  test('the setup view says to reconnect instead of failing', async () => {
    const response = await request('/ai/model-api/aws-bedrock');
    expect(response.status).toBe(200);
    const view = (await response.json()) as AwsConnectionView;
    expect(view).toMatchObject({ route: AWS_BEDROCK_ROUTE, configured: false, connection: null, next: AWS_RECONNECT });
  });

  test('a send on the owner route is refused with the reconnect sentence and nothing is sent', async () => {
    const home = (await (await request('/home/conversation', 'POST')).json()) as { projectId: string; threadId: string };
    // The person chose the owner route for this conversation.
    const state = store().state(home.projectId);
    const thread = state.conversations.find((item) => item.id === home.threadId)!;
    thread.engine = AWS_BEDROCK_ROUTE;
    thread.engineChoice = 'person';
    await store().persist(state);
    const sent = await request(`/projects/${home.projectId}/threads/${home.threadId}/messages`, 'POST', {
      commandId: 'm-retired',
      text: 'Good morning',
      mode: 'auto',
      sources: [],
      consent: true,
    });
    expect(sent.status).toBe(409);
    const body = (await sent.json()) as { error: string; code: string };
    expect(body.code).toBe('ROUTE_REFUSED');
    expect(body.error).toContain(AWS_RECONNECT);
    expect(body.error).toContain('Nothing was sent.');
    expect(calls).toBe(0);
  });

  test('reconnecting replaces the retired record and keeps the revision increasing', async () => {
    const response = await request('/ai/model-api/aws-bedrock', 'PUT', {
      accountId: '123456789012',
      region: 'us-east-1',
      model: AWS_LUNA_MODEL,
      apiKey: 'test-only-bedrock-key-0123456789abcdef-never-real',
      expiresAt: null,
      consent: true,
    });
    expect(response.status).toBe(200);
    const view = (await response.json()) as AwsConnectionView;
    expect(view.connection).toMatchObject({ model: AWS_LUNA_MODEL, revision: 4, accountRoute: 'aws-bedrock:aws-bedrock-1@r4' });
    const record = (await new AwsConnections(store().dataDir).read()) as AwsConnection;
    expect(record).toMatchObject({ modelId: AWS_LUNA_MODEL, revision: 4, createdAt: at });
    expect(store().settings.services?.[`${AWS_BEDROCK_ROUTE}Model`]).toBe(AWS_LUNA_MODEL);
  });
});
