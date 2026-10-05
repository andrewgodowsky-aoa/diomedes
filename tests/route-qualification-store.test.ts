import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { QUALIFICATION_RECEIPTS_KEPT, RouteQualifications } from '../server/engines/route-qualification-store.js';
import type { RouteQualificationReceipt } from '../shared/route-qualification.js';
import { passingReceipt, type ReceiptIdentity } from './fixtures/route-qualification-receipts.js';

const K3 = 'us.moonshotai.kimi-k3';
const LUNA = 'us.openai.gpt-5.6-luna';
const AWS: ReceiptIdentity = {
  route: 'aws-bedrock',
  connectionId: 'aws-bedrock-1',
  connectionRevision: 2,
  model: K3,
  protocol: 'openai-chat-completions',
  rateCard: 'aws-bedrock-kimi-k3-us-fixture',
  deployment: null,
  endpoint: 'https://bedrock-runtime.us-east-1.amazonaws.com/openai/v1',
  sdk: 'ai@7.0.107+@ai-sdk/openai@4.0.71',
};
const AZURE: ReceiptIdentity = {
  route: 'azure-openai',
  connectionId: 'azure-openai-1',
  connectionRevision: 3,
  model: 'gpt-6.1-sol',
  protocol: 'openai-responses',
  rateCard: 'azure-openai:gpt-6.1-sol@r3:fixture',
  deployment: 'sol-prod',
  endpoint: 'https://contoso-ai.openai.azure.com/openai/v1',
  sdk: 'ai@7.0.107+@ai-sdk/azure@4.0.75+@ai-sdk/openai@4.0.71',
};
const at = (minute: number) => new Date(Date.UTC(2026, 9, 5, 12, minute));
const receipt = (identity: ReceiptIdentity, n: number, patch: Partial<ReceiptIdentity> = {}): RouteQualificationReceipt =>
  passingReceipt({ ...identity, ...patch }, { id: `rq_fixture${String(n).padStart(4, '0')}`, createdAt: at(n) });

let dir: string;
let receipts: RouteQualifications;
const file = (route: string) => path.join(dir, 'connections', 'qualifications', `${route}.json`);
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'diomedes-route-receipts-'));
  receipts = new RouteQualifications(dir);
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe('route check receipts on disk', () => {
  test('records a receipt in its route file beside the connections and reads it back', async () => {
    expect(await receipts.latest('aws-bedrock', 'aws-bedrock-1')).toBeNull();
    const saved = await receipts.record(receipt(AWS, 1));
    expect(saved).toEqual(receipt(AWS, 1));
    expect(await receipts.latest('aws-bedrock', 'aws-bedrock-1')).toEqual(saved);
    expect(JSON.parse(await fs.readFile(file('aws-bedrock'), 'utf8'))).toEqual({ v: 1, route: 'aws-bedrock', receipts: [saved] });
    // Each route keeps its own file.
    expect(await receipts.latest('azure-openai', 'aws-bedrock-1')).toBeNull();
  });

  test('the newest receipt for a connection, narrowed by model or by deployment', async () => {
    await receipts.record(receipt(AWS, 1));
    await receipts.record(receipt(AWS, 2, { model: LUNA, protocol: 'openai-responses' }));
    await receipts.record(receipt(AWS, 3, { connectionId: 'aws-bedrock-2' }));
    expect((await receipts.latest('aws-bedrock', 'aws-bedrock-1'))?.id).toBe('rq_fixture0002');
    expect((await receipts.latest('aws-bedrock', 'aws-bedrock-1', { model: K3 }))?.id).toBe('rq_fixture0001');
    expect((await receipts.latest('aws-bedrock', 'aws-bedrock-2'))?.id).toBe('rq_fixture0003');
    expect(await receipts.latest('aws-bedrock', 'aws-bedrock-1', { model: 'us.moonshotai.kimi-k2' })).toBeNull();

    await receipts.record(receipt(AZURE, 4));
    await receipts.record(receipt(AZURE, 5, { deployment: 'sol-canary' }));
    expect((await receipts.latest('azure-openai', 'azure-openai-1', { model: 'gpt-6.1-sol', deployment: 'sol-prod' }))?.id).toBe('rq_fixture0004');
    expect((await receipts.latest('azure-openai', 'azure-openai-1', { deployment: 'sol-canary' }))?.id).toBe('rq_fixture0005');
    expect((await receipts.latest('azure-openai', 'azure-openai-1'))?.id).toBe('rq_fixture0005');
  });

  test(`keeps the newest ${QUALIFICATION_RECEIPTS_KEPT} receipts per route, newest last`, async () => {
    for (let n = 1; n <= QUALIFICATION_RECEIPTS_KEPT + 2; n += 1) await receipts.record(receipt(AWS, n));
    const kept = await receipts.list('aws-bedrock');
    expect(kept).toHaveLength(QUALIFICATION_RECEIPTS_KEPT);
    expect(kept[0].id).toBe('rq_fixture0003');
    expect(kept.at(-1)?.id).toBe(`rq_fixture00${QUALIFICATION_RECEIPTS_KEPT + 2}`);
  });

  test('records made at once are all kept, in the order they were made', async () => {
    await Promise.all([1, 2, 3].map((n) => receipts.record(receipt(AWS, n))));
    expect((await receipts.list('aws-bedrock')).map((item) => item.id)).toEqual(['rq_fixture0001', 'rq_fixture0002', 'rq_fixture0003']);
  });

  test('a receipt that is not valid is refused and nothing is written', async () => {
    const bad = { ...receipt(AWS, 1), validUntil: at(0).toISOString() };
    await expect(receipts.record(bad)).rejects.toThrow();
    await expect(fs.stat(file('aws-bedrock'))).rejects.toMatchObject({ code: 'ENOENT' });
    // The queue goes on after a refusal.
    expect((await receipts.record(receipt(AWS, 2))).id).toBe('rq_fixture0002');
  });

  test.each([
    ['bytes that are not JSON', '{ not json'],
    ['a receipt the schema refuses', JSON.stringify({ v: 1, route: 'aws-bedrock', receipts: [{ id: 'rq_fixture0001' }] })],
    ['a file naming another route', JSON.stringify({ v: 1, route: 'azure-openai', receipts: [] })],
  ])('a file holding %s reads as no receipt, and the next record sets it aside untouched', async (_name, bytes) => {
    await fs.mkdir(path.dirname(file('aws-bedrock')), { recursive: true });
    await fs.writeFile(file('aws-bedrock'), bytes);
    expect(await receipts.latest('aws-bedrock', 'aws-bedrock-1')).toBeNull();
    expect(await receipts.list('aws-bedrock')).toEqual([]);

    const saved = await receipts.record(receipt(AWS, 1));
    expect(await receipts.list('aws-bedrock')).toEqual([saved]);
    const names = await fs.readdir(path.dirname(file('aws-bedrock')));
    const aside = names.filter((name) => name.startsWith('aws-bedrock.json.unreadable-'));
    expect(aside).toHaveLength(1);
    expect(await fs.readFile(path.join(path.dirname(file('aws-bedrock')), aside[0]), 'utf8')).toBe(bytes);
  });
});
