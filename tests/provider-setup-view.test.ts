import { describe, expect, test } from 'vitest';
import {
  azureConnectBody,
  azureInputFrom,
  emptyAzureDeployment,
  emptyOpenRouterModel,
  openRouterConnectBody,
  openRouterInputFrom,
  providerIsDefault,
  providerModels,
  providerPickerState,
  providerStateRows,
  ratesBody,
  readinessLines,
} from '../client/provider-setup-view';
import type { AzureConnectionView, OpenRouterConnectionView } from '../shared/model-api';

const NOW = Date.parse('2026-09-23T12:00:00Z');
const KEY = 'test-only-provider-key-0123456789abcdef';
const RATES = {
  input: 1_250_000,
  output: 10_000_000,
  cacheRead: 125_000,
  cacheWrite: null,
  source: 'Price page, read by the test owner',
  declaredAt: '2026-09-23T10:00:00.000Z',
};
const credential = { kind: 'azure-api-key', fingerprint: 'abcdef123456', savedAt: '2026-09-23T10:00:00Z', expiresAt: null, expired: false };
const spend = {
  rateCard: 'r1',
  capMicroUsd: 1_000_000,
  settledMicroUsd: 0,
  pendingMicroUsd: 0,
  uncertainMicroUsd: 0,
  writtenOffMicroUsd: 0,
  availableMicroUsd: 1_000_000,
  note: 'Estimated.',
  recent: [],
};

function azure(patch: Partial<AzureConnectionView> = {}): AzureConnectionView {
  return {
    route: 'azure-openai',
    configured: true,
    protectedStorage: true,
    enabled: true,
    connection: {
      id: 'azure-openai-1',
      resource: 'contoso-ai',
      endpoint: 'https://contoso-ai.openai.azure.com/openai/v1',
      apiVersion: 'v1',
      deployments: [{ model: 'gpt-5.6-luna', deployment: 'luna-prod', reasoning: true, rates: RATES }],
      credential,
      revision: 1,
      accountRoute: 'azure-openai:azure-openai-1@r1',
    },
    spend,
    next: null,
    ...patch,
  };
}

function openrouter(patch: Partial<OpenRouterConnectionView> = {}): OpenRouterConnectionView {
  return {
    route: 'openrouter',
    configured: true,
    protectedStorage: true,
    enabled: true,
    connection: {
      id: 'openrouter-1',
      endpoint: 'https://openrouter.ai/api/v1',
      models: [{ id: 'vendor/model-a', upstreams: ['upstream-one'], rates: RATES }],
      dataCollection: 'deny',
      allowFallbacks: false,
      credential: { ...credential, kind: 'openrouter-api-key' },
      revision: 2,
      accountRoute: 'openrouter:openrouter-1@r2',
    },
    spend,
    next: null,
    ...patch,
  };
}

const prices = { input: '1.25', output: '10', cacheRead: '', cacheWrite: '', source: ' Price page ' };

describe('Azure OpenAI and OpenRouter setup view', () => {
  test('a fresh install waits on every fact, and a server without protected storage blocks the key', () => {
    const fresh = providerStateRows(azure({ configured: false, connection: null, spend: null, enabled: false }), NOW);
    expect(fresh.map((row) => row.value)).toEqual(['waiting', 'waiting', 'waiting', 'waiting']);
    expect(fresh[0].text).toBe('Not connected');
    const plain = providerStateRows(openrouter({ connection: null, spend: null, protectedStorage: false }), NOW);
    expect(plain[1]).toMatchObject({ value: 'blocked', text: 'Protected storage is not available here' });
  });

  test('a connected route names what it points at and what is left to spend', () => {
    const rows = providerStateRows(azure(), NOW);
    expect(rows[0]).toMatchObject({ label: 'Azure resource', value: 'ok', text: 'contoso-ai · gpt-5.6-luna → luna-prod' });
    expect(rows[2]).toMatchObject({ value: 'ok', text: '$1.00 approved, $1.00 left' });
    const or = providerStateRows(openrouter({ spend: { ...spend, capMicroUsd: 0, availableMicroUsd: 0 } }), NOW);
    expect(or[0].text).toBe('vendor/model-a (upstream-one)');
    expect(or[2]).toMatchObject({ value: 'waiting', text: 'Not approved: nothing can be sent' });
  });

  test('prices are required, cache prices optional, and a source is always said', () => {
    expect(ratesBody(prices, 'x')).toEqual({
      ok: true,
      body: {
        inputUsdPerMillion: 1.25,
        outputUsdPerMillion: 10,
        cacheReadUsdPerMillion: null,
        cacheWriteUsdPerMillion: null,
        source: 'Price page',
      },
    });
    expect(ratesBody({ ...prices, input: '' }, 'x').ok).toBe(false);
    expect(ratesBody({ ...prices, output: '0' }, 'x').ok).toBe(false);
    expect(ratesBody({ ...prices, cacheRead: 'cheap' }, 'x').ok).toBe(false);
    expect(ratesBody({ ...prices, source: '  ' }, 'x').ok).toBe(false);
  });

  test('Azure connect builds exactly the route body and never echoes the key in a refusal', () => {
    const input = {
      resourceName: ' contoso-ai ',
      deployments: [{ model: 'gpt-5.6-luna', deployment: 'luna-prod', reasoning: true, rates: prices }],
      apiKey: ` ${KEY} `,
      expiresLocal: '',
      consent: true,
    };
    const parsed = azureConnectBody(input, NOW);
    expect(parsed).toEqual({
      ok: true,
      body: {
        resourceName: 'contoso-ai',
        deployments: [
          {
            model: 'gpt-5.6-luna',
            deployment: 'luna-prod',
            reasoning: true,
            rates: {
              inputUsdPerMillion: 1.25,
              outputUsdPerMillion: 10,
              cacheReadUsdPerMillion: null,
              cacheWriteUsdPerMillion: null,
              source: 'Price page',
            },
          },
        ],
        apiKey: KEY,
        expiresAt: null,
        consent: true,
      },
    });
    const refusals = [
      azureConnectBody({ ...input, resourceName: '' }, NOW),
      azureConnectBody({ ...input, deployments: [] }, NOW),
      azureConnectBody({ ...input, deployments: [emptyAzureDeployment()] }, NOW),
      azureConnectBody({ ...input, apiKey: 'short' }, NOW),
      azureConnectBody({ ...input, expiresLocal: '2026-09-22T12:00' }, NOW),
      azureConnectBody({ ...input, consent: false }, NOW),
    ];
    for (const refusal of refusals) {
      expect(refusal.ok).toBe(false);
      expect(JSON.stringify(refusal)).not.toContain(KEY);
    }
  });

  test('OpenRouter connect lists each model with its endpoints and never echoes the key', () => {
    const input = {
      models: [{ id: 'vendor/model-a', upstreams: 'upstream-one, upstream-two upstream-one', rates: prices }],
      apiKey: KEY,
      expiresLocal: '2026-09-24T12:00',
      consent: true,
    };
    const parsed = openRouterConnectBody(input, NOW);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(Object.keys(parsed.body).sort()).toEqual(['apiKey', 'consent', 'expiresAt', 'models']);
    expect(parsed.body.models).toEqual([
      {
        id: 'vendor/model-a',
        upstreams: ['upstream-one', 'upstream-two'],
        rates: expect.objectContaining({ inputUsdPerMillion: 1.25 }),
      },
    ]);
    expect(typeof parsed.body.expiresAt).toBe('string');
    for (const refusal of [
      openRouterConnectBody({ ...input, models: [emptyOpenRouterModel()] }, NOW),
      openRouterConnectBody({ ...input, models: [{ ...input.models[0], upstreams: ' , ' }] }, NOW),
      openRouterConnectBody({ ...input, consent: false }, NOW),
    ]) {
      expect(refusal.ok).toBe(false);
      expect(JSON.stringify(refusal)).not.toContain(KEY);
    }
  });

  test('replacing a key refills the saved deployments and prices, never the key', () => {
    const azureForm = azureInputFrom(azure());
    expect(azureForm.resourceName).toBe('contoso-ai');
    expect(azureForm.deployments[0].rates).toEqual({
      input: '1.25',
      output: '10',
      cacheRead: '0.125',
      cacheWrite: '',
      source: RATES.source,
    });
    expect(JSON.stringify(azureForm)).not.toContain('fingerprint');
    expect(openRouterInputFrom(openrouter()).models[0].upstreams).toBe('upstream-one');
    expect(azureInputFrom(null).deployments).toHaveLength(1);
  });

  test('the setup check lists failed checks first and carries only the host’s words', () => {
    const lines = readinessLines({
      route: 'azure-openai',
      ready: false,
      sent: false,
      checks: [
        { id: 'connection', ok: true, detail: 'Saved.' },
        { id: 'spend-limit', ok: false, detail: 'No spend limit is approved.' },
      ],
      note: 'No request was sent.',
    });
    expect(lines.map((line) => line.id)).toEqual(['spend-limit', 'connection']);
  });

  test('a thread offers the route only when nothing blocks a send, one entry per model', () => {
    expect(providerPickerState(null)).toEqual({ offered: false, note: null });
    expect(providerPickerState(azure({ enabled: false }))).toEqual({ offered: false, note: null });
    expect(providerPickerState(azure({ next: 'Approve a spend limit for Azure OpenAI before sending.' }))).toEqual({
      offered: false,
      note: 'Azure OpenAI is on but not ready: Approve a spend limit for Azure OpenAI before sending.',
    });
    expect(providerPickerState(openrouter())).toEqual({ offered: true, note: null });
    expect(providerModels(azure())).toEqual([{ slug: 'gpt-5.6-luna', where: 'luna-prod' }]);
    expect(providerModels(openrouter())).toEqual([{ slug: 'vendor/model-a', where: 'upstream-one' }]);
  });

  test('connecting alone never makes a route the default', () => {
    expect(providerIsDefault('azure-openai', { 'azure-openai': true })).toBe(false);
    expect(providerIsDefault('openrouter', { defaultEngine: 'openrouter' })).toBe(true);
  });
});
