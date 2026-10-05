/**
 * The Team host's member admission (`agent-team-host.ts`), read through the collaboration options
 * the app serves: a Kimi K3 lead on the AWS route carries the route check sentence until a current
 * receipt exists for the connection, and carries it again after a reconnect. Nothing reaches AWS.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, expect, test } from 'vitest';
import { createApp } from '../server/app.js';
import { testOnlySecretBox } from '../server/connection-secrets.js';
import { AWS_BEDROCK_SDK, awsQualificationIdentity } from '../server/engines/aws-bedrock.js';
import { RouteQualifications } from '../server/engines/route-qualification-store.js';
import { EngineService } from '../server/engines/service.js';
import { AWS_KIMI_K3_REFUSAL, type AwsConnectionView } from '../shared/model-api.js';
import { passingReceipt } from './fixtures/route-qualification-receipts.js';

const K3 = 'us.moonshotai.kimi-k3';
const headers = { 'Content-Type': 'application/json', 'X-Diomedes-Client': '1' };
let root: string;
let app: Awaited<ReturnType<typeof createApp>>;
let server: Server | undefined;
let base: string;
let dispatches = 0;

afterEach(async () => {
  if (!server) return;
  await app.locals.close();
  server.closeAllConnections();
  await new Promise<void>((resolve) => server!.close(() => resolve()));
  server = undefined;
  await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

const request = async (route: string, method = 'GET', body?: unknown) => {
  const response = await fetch(`${base}/api${route}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await response.text();
  return { status: response.status, text, data: JSON.parse(text) as any };
};

test('a Kimi K3 Team lead is admitted only under a current route check receipt for its connection', async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'diomedes-route-check-team-'));
  app = await createApp({
    dataDir: path.join(root, 'data'),
    projectRoot: path.join(root, 'projects'),
    engineService: new EngineService(path.join(root, 'engines'), { discover: async () => [] }),
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

  const connect = async () => {
    const put = await request('/ai/model-api/aws-bedrock', 'PUT', {
      accountId: '123456789012',
      region: 'us-east-1',
      model: K3,
      apiKey: 'test-only-bedrock-key-0123456789abcdef-never-real',
      expiresAt: null,
      consent: true,
    });
    expect(put.status, put.text).toBe(200);
    return (put.data as AwsConnectionView).connection!;
  };
  const projectId = (await request('/projects', 'POST', { name: 'Lunch service' })).data.id as string;
  const taskId = (await request(`/projects/${projectId}/tasks`, 'POST', { name: 'Plan the lunch menu' })).data.id as string;
  const connection = await connect();
  expect((await request('/ai/model-api/aws-bedrock/spend-limit', 'PUT', { capUsd: 5, consent: true })).status).toBe(200);
  const lead = await request(`/projects/${projectId}/team/members`, 'POST', { name: 'Kimi', role: 'lead', engine: 'aws-bedrock', model: K3 });
  expect(lead.status, lead.text).toBe(200);
  const leadRow = async () => {
    const options = (await request(`/projects/${projectId}/loop/collaboration-options?taskId=${taskId}`)).data;
    const row = (options.leads as { slotId: string; route: string; model: string; admitted: boolean; reason: string | null }[])
      .find((item) => item.slotId === lead.data.member.slotId);
    return { row, hostReason: (options.reason ?? null) as string | null };
  };

  expect((await leadRow()).row).toMatchObject({ route: 'aws-bedrock', model: K3, admitted: false, reason: AWS_KIMI_K3_REFUSAL });

  await new RouteQualifications(path.join(root, 'data')).record(
    passingReceipt({
      ...awsQualificationIdentity({ id: connection.id, revision: connection.revision, modelId: K3 }),
      endpoint: connection.endpoint,
      sdk: AWS_BEDROCK_SDK,
    }),
  );
  // The connection no longer refuses the lead: only the host's own Trust reason, if any, remains.
  const opened = await leadRow();
  expect(opened.row).toBeDefined();
  expect(opened.row!.reason).not.toBe(AWS_KIMI_K3_REFUSAL);
  expect(opened.row!.reason).toBe(opened.hostReason);

  // A reconnect is a new revision, which the recorded check does not cover.
  expect((await connect()).revision).toBe(connection.revision + 1);
  expect((await leadRow()).row).toMatchObject({ admitted: false, reason: AWS_KIMI_K3_REFUSAL });
  expect(dispatches).toBe(0);
});
