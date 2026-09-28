/** Disposable loopback fixture. No provider credentials or external transport are used. */
import { startFauxCloud } from '../../../services/control-plane/src/faux/server.js';
import type { ModelBinding, ProviderConnection } from '../../../shared/routing-policy.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const connection: ProviderConnection = { id: 'fixture-azure', revision: 1, provider: 'azure-openai', label: 'Synthetic Azure',
  payer: 'company', account: 'fixture-only', enabled: true, secretRef: 'AZURE_OPENAI_API_KEY', resource: 'fixture-resource',
  apiVersion: 'v1', deployments: ['primary', 'backup'] };
export function fixtureBinding(deployment = 'primary'): ModelBinding {
  const at = new Date().toISOString(), until = new Date(Date.now() + 3_600_000).toISOString();
  return { connectionId: connection.id, connectionRevision: 1, protocol: 'chat-completions', deployment, modelVersion: 'fixture-non-luna', upstreamEndpoint: null,
    capabilities: { contextTokens: 100_000, outputTokens: 4096, tools: true, images: false, reasoning: false },
    qualification: { id: 'fixture-only', evidence: 'Synthetic transport only', validUntil: until, tiers: ['efficient', 'focused', 'thorough'], qualityFloor: 1 },
    access: { state: 'ready', evidence: 'Synthetic transport only', validUntil: until, availableRequests: 100 },
    privacy: { connectionRevision: 1, modelVersion: 'fixture-non-luna', protocol: 'chat-completions', evidence: 'Synthetic transport only', validUntil: until,
      ingressCountries: ['US'], decryptionCountries: ['US'], processingCountries: ['US'], retentionPolicy: 'fixture-zdr', zeroRetention: true, training: false,
      contentLogging: false, caching: 'off', transientCacheEvidence: null, features: ['text', 'tools'], allowedRetentionModes: [], effectiveRetentionMode: null, regionalEntitlement: false },
    health: { state: 'healthy', observedAt: at, validUntil: until, cooldownUntil: null, reason: 'Synthetic transport only' },
    price: { version: 'fixture-price', observedAt: at, validUntil: until, evidence: 'Synthetic transport only', inputMicroUsdPerMillion: 100_000,
      outputMicroUsdPerMillion: 200_000, reasoningMicroUsdPerMillion: 200_000, cacheReadMicroUsdPerMillion: 10_000, cacheWriteMicroUsdPerMillion: 125_000,
      requestFeeMicroUsd: 1, longContext: [] } };
}

export function startRoutingFixture(file: string | null = null, port = 0) {
  return startFauxCloud({ file, port,
  seed: true, passwordIterations: 1000, liveBedrockApiKey: null, liveOpenRouterApiKey: null,
  managed: { bindings: { MANAGED_CONNECTIONS: JSON.stringify([connection]), AZURE_OPENAI_API_KEY: 'synthetic-fixture-key' },
    settings: { MANAGED_SPEND_CEILING_MICRO_USD: '1000000' },
    transport: async (url, init) => {
      if (String(url) !== 'https://fixture-resource.openai.azure.com/openai/v1/chat/completions' || init?.redirect !== 'manual' ||
          new Headers(init?.headers).get('api-key') !== 'synthetic-fixture-key') throw new Error('Unexpected provider transport request.');
      const body = JSON.parse(String(init?.body));
      if (!['primary', 'backup'].includes(body.model)) throw new Error('Unexpected deployment.');
      const events = [
        { id: 'fixture-response', model: 'fixture-non-luna', choices: [{ delta: { content: 'Operations selected this model.' } }] },
        { choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 12 } },
      ];
      return new Response(events.map(e => `data: ${JSON.stringify(e)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream', 'x-request-id': 'fixture-provider-call' } });
    } } });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const running = await startRoutingFixture(process.env.ROUTING_FIXTURE_FILE ?? null, Number(process.env.ROUTING_FIXTURE_PORT ?? 0));
  console.log(JSON.stringify({ ready: true, url: running.url }));
  const stop = async () => { await running.cloud.idle(); await running.close(); process.exit(0); };
  process.on('SIGTERM', () => void stop());
  process.on('SIGINT', () => void stop());
}
