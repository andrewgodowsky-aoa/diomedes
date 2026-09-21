import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { Store } from '../server/store.js';
import { createHarnessHost, type HarnessHost } from '../server/harness/host.js';

let directory: string | undefined;
let host: HarnessHost | undefined;
afterEach(async () => {
  await host?.close();
  vi.unstubAllGlobals();
  if (directory) await fs.rm(directory, { recursive: true, force: true });
});

it('exposes an explicit host-only Bedrock factory without activating an account or making a call', async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'diomedes-bedrock-host-'));
  const dataDir = path.join(directory, 'data');
  const store = new Store(dataDir, path.join(directory, 'projects'));
  await store.init();
  host = createHarnessHost({ store, dataDir });
  const fetch = vi.fn<typeof globalThis.fetch>().mockRejectedValue(new Error('No network allowed'));
  vi.stubGlobal('fetch', fetch);
  const route = host.createBedrockModelRoute({
    profile: {
      id: 'luna',
      accountRoute: 'aws:test',
      region: 'us-east-1',
      modelId: 'us.openai.gpt-5.6-luna',
    },
    credentials: { kind: 'bearer', apiKey: 'synthetic-host-key' },
  });
  expect(route.adapter.destination).toBe('external');
  expect(route.adapter.id).toBe('amazon-bedrock');
  expect(host.redact('synthetic-host-key')).not.toContain('synthetic-host-key');
  expect(await route.catalog.get()).toMatchObject({
    accountRoute: 'aws:test',
    error: 'catalog_requires_sigv4',
  });
  expect(fetch).not.toHaveBeenCalled();
  expect(await fs.readdir(dataDir)).not.toContain('bedrock-transcripts');
  await host.close();
  expect(() =>
    host!.createBedrockModelRoute({
      profile: {
        id: 'luna',
        accountRoute: 'aws:test',
        region: 'us-east-1',
        modelId: 'us.openai.gpt-5.6-luna',
      },
      credentials: { kind: 'bearer', apiKey: 'synthetic-host-key' },
    }),
  ).toThrow(/closing/i);
  host = undefined;
});
