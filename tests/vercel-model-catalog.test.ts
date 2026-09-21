import { describe, expect, it, vi } from 'vitest';
import { BedrockModelCatalog } from '../server/harness/vercel-model-catalog.js';

const foundation = {
  modelId: 'openai.gpt-5.6-luna',
  modelName: 'GPT-5.6 Luna',
  providerName: 'OpenAI',
  outputModalities: ['TEXT'],
  inputModalities: ['TEXT', 'IMAGE'],
  modelLifecycle: { status: 'ACTIVE' },
  inferenceTypesSupported: ['ON_DEMAND'],
  responseStreamingSupported: true,
};
const inference = {
  inferenceProfileId: 'us.openai.gpt-5.6-luna',
  inferenceProfileName: 'US Luna',
  status: 'ACTIVE',
  type: 'SYSTEM_DEFINED',
  models: [{ modelArn: 'arn:aws:bedrock:us-east-1::foundation-model/openai.gpt-5.6-luna' }],
};
const credentials = {
  kind: 'sigv4' as const,
  accessKeyId: 'CATALOGTESTKEY',
  secretAccessKey: 'synthetic-catalog-secret',
};
const configuration = { accountRoute: 'aws:test', region: 'us-east-1', credentials };

function fixture() {
  return vi.fn<typeof globalThis.fetch>().mockImplementation(async (input, init) => {
    const req = new Request(input, init);
    return req.url.includes('/foundation-models')
      ? Response.json({ modelSummaries: [foundation] })
      : Response.json({ inferenceProfileSummaries: [inference] });
  });
}

describe('Bedrock catalog freshness', () => {
  it('discovers exact regional profile IDs with explicitly signed AWS reads', async () => {
    const fetch = fixture();
    const catalog = new BedrockModelCatalog({ ...configuration, fetch, now: () => 1000 });
    const snapshot = await catalog.get();
    expect(snapshot.state).toBe('fresh');
    expect(snapshot.fetchedAt).toBe(1000);
    expect(snapshot.models).toContainEqual(
      expect.objectContaining({
        id: 'us.openai.gpt-5.6-luna',
        scope: 'cross-region',
        access: 'unverified',
      }),
    );
    for (const [input, init] of fetch.mock.calls) {
      const req = new Request(input, init);
      expect(new URL(req.url).origin).toBe('https://bedrock.us-east-1.amazonaws.com');
      expect(req.headers.get('authorization')).toContain('Credential=CATALOGTESTKEY/');
    }
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('coalesces concurrent reads and refreshes on the next read after expiry', async () => {
    let clock = 1000;
    const fetch = fixture();
    const catalog = new BedrockModelCatalog({
      ...configuration,
      fetch,
      now: () => clock,
      ttlMs: 100,
    });
    await Promise.all([catalog.get(), catalog.get(), catalog.get()]);
    expect(fetch).toHaveBeenCalledTimes(2);
    await catalog.get();
    expect(fetch).toHaveBeenCalledTimes(2);
    clock += 101;
    await catalog.get();
    expect(fetch).toHaveBeenCalledTimes(4);
  });

  it('retains prior models as stale after refresh failure and does not return a secret-bearing error', async () => {
    let clock = 1000;
    const fetch = fixture();
    const catalog = new BedrockModelCatalog({
      ...configuration,
      fetch,
      now: () => clock,
      ttlMs: 100,
    });
    const before = await catalog.get();
    fetch.mockRejectedValue(new Error('synthetic-catalog-secret provider error'));
    clock += 101;
    const after = await catalog.get();
    expect(after.state).toBe('stale');
    expect(after.models).toEqual(before.models);
    expect(after.fetchedAt).toBe(before.fetchedAt);
    expect(after.error).toBe('catalog_unavailable');
    expect(JSON.stringify(after)).not.toContain('synthetic-catalog-secret');
    const calls = fetch.mock.calls.length;
    await catalog.get();
    expect(fetch).toHaveBeenCalledTimes(calls);
  });

  it('follows pagination and refuses a repeating pagination token', async () => {
    const fetch = fixture();
    fetch.mockImplementation(async (input, init) => {
      const req = new Request(input, init);
      if (req.url.includes('foundation-models'))
        return Response.json({ modelSummaries: [foundation] });
      return Response.json({ inferenceProfileSummaries: [inference], nextToken: 'repeated' });
    });
    const snapshot = await new BedrockModelCatalog({ ...configuration, fetch }).get();
    expect(snapshot.state).toBe('unavailable');
    expect(snapshot.models).toEqual([]);
    expect(fetch.mock.calls.length).toBeLessThanOrEqual(3);
  });

  it('returns independent snapshots and never changes an explicit model selection', async () => {
    const catalog = new BedrockModelCatalog({ ...configuration, fetch: fixture() });
    const snapshot = await catalog.get();
    snapshot.models.length = 0;
    expect((await catalog.get()).models).toHaveLength(2);
    expect(await catalog.get()).not.toHaveProperty('selectedModel');
  });

  it('keeps this catalog implementation on its explicit SigV4 credential route', async () => {
    const fetch = fixture();
    const catalog = new BedrockModelCatalog({
      ...configuration,
      credentials: { kind: 'bearer', apiKey: 'synthetic' },
      fetch,
    });
    expect(await catalog.get()).toMatchObject({
      state: 'unavailable',
      error: 'catalog_requires_sigv4',
      models: [],
    });
    expect(fetch).not.toHaveBeenCalled();
  });
});
