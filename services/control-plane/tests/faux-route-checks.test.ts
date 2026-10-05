/**
 * The faux cloud's side of the gateway route checks (DIO-217): the two approved connections as
 * deployed, the seeded Kimi K3 and GPT-6.1 Sol routes, and the scripted provider answering in each
 * route's own protocol through the gateway's provider call. Nothing here reaches a network.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createFauxCloud } from '../src/faux/cloud.js';
import { seedDemo } from '../src/faux/seed.js';
import {
  FAUX_AWS_CONNECTION,
  FAUX_AZURE_CONNECTION,
  FAUX_ROUTE_CHECK_CONNECTIONS,
  fauxRouteCheckEnvironment,
  fauxRouteCheckRoutes,
  scriptedRouteChecksFetch,
} from '../src/faux/route-checks.js';
import { approvedConnections, callManagedProvider } from '../src/managed-bindings.js';
import { sseObjects } from '../src/managed-normalization.js';
import type { ResponsesBody } from '../src/managed-inference.js';
import { FAUX_SCRIPTED_CREDENTIAL } from '../src/managed-providers.js';
import { CACHE_PREFIX, INSTRUCTIONS, LOOKUP_FACT_TOOL, OUTPUT_BOUND_ASK, SHORT_ANSWER, TOOL_ASK, TOOL_VALUE } from '../../../shared/route-qualification-plan.js';
import type { CatalogRoute, ProviderConnection } from '../../../shared/routing-policy.js';

const AT = '2026-10-05T12:00:00.000Z';
const routes = () => fauxRouteCheckRoutes(AT).map((entry): CatalogRoute => ({ ...entry, revision: 1 }));
const k3 = () => ({ route: routes()[0], connection: FAUX_AWS_CONNECTION });
const sol = () => ({ route: routes()[1], connection: FAUX_AZURE_CONNECTION });
const tool = { type: 'function', name: LOOKUP_FACT_TOOL.name, description: LOOKUP_FACT_TOOL.description, parameters: LOOKUP_FACT_TOOL.parameters };
const body = (input: Record<string, unknown>[], extra: Record<string, unknown> = {}): ResponsesBody =>
  ({ model: 'fixture', instructions: INSTRUCTIONS, input, max_output_tokens: 512, reasoning: { effort: 'low' }, ...extra });

/** One call through the gateway's own provider call, read back as the normalized Responses stream. */
async function send(target: { route: CatalogRoute; connection: ProviderConnection }, request: ResponsesBody, transport: typeof globalThis.fetch) {
  const response = await callManagedProvider({ ...target, credential: FAUX_SCRIPTED_CREDENTIAL, body: request,
    scopeKey: 'organization:faux', signal: new AbortController().signal }, transport);
  expect(response.status).toBe(200);
  const events = [];
  for await (const event of sseObjects(response.body!)) events.push(event);
  const terminal = events.at(-1) as { type: string; response: { model: string; usage: Record<string, unknown>; output: Record<string, unknown>[] } };
  const text = terminal.response.output.filter((item) => item.type === 'message')
    .flatMap((item) => item.content as { type: string; text?: string }[]).map((part) => part.text ?? '').join('');
  const call = terminal.response.output.find((item) => item.type === 'function_call');
  return { terminal, text, call, usage: terminal.response.usage as { input_tokens: number; output_tokens: number;
    input_tokens_details: { cached_tokens: number }; output_tokens_details: { reasoning_tokens: number } } };
}

describe('the faux route check connections and routes', () => {
  it('are the deployed MANAGED_CONNECTIONS entries, field for field', () => {
    const text = readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8');
    const deployed = approvedConnections(JSON.parse(text.replace(/^\s*\/\/.*$/gm, '')).vars);
    for (const connection of FAUX_ROUTE_CHECK_CONNECTIONS)
      expect(deployed.find((entry) => entry.id === connection.id)).toEqual(connection);
    expect(approvedConnections(fauxRouteCheckEnvironment())).toEqual(FAUX_ROUTE_CHECK_CONNECTIONS);
  });

  it('are seeded bound and unqualified on the default faux cloud, and left out when a test brings its own connections', async () => {
    const cloud = await createFauxCloud({ file: null, passwordIterations: 1_000 });
    await seedDemo(cloud);
    const seeded = cloud.store.snapshot().commercial.routes.filter((row) => row.binding);
    expect(seeded.map((row) => [row.id, row.status, row.binding!.connectionId, row.binding!.protocol, row.binding!.qualification])).toEqual([
      ['aws-kimi-k3', 'unqualified', 'aws-bedrock-us-east-1', 'chat-completions', null],
      ['azure-sol-6-1', 'unqualified', 'azure-foundry-dev', 'responses', null],
    ]);
    // No tier resolves to either: the published policy still names the seed's own route.
    expect(Object.values(cloud.store.snapshot().commercial.policies[0].tiers).map((tier) => tier?.entryId)).not.toContain('aws-kimi-k3');

    const own = await createFauxCloud({ file: null, passwordIterations: 1_000, managed: { bindings: { MANAGED_CONNECTIONS: JSON.stringify([FAUX_AZURE_CONNECTION]) } } });
    await seedDemo(own);
    expect(own.store.snapshot().commercial.routes.filter((row) => row.binding)).toEqual([]);
  });
});

describe('the scripted route check provider through the gateway’s provider call', () => {
  it('answers Kimi K3 in Bedrock Chat Completions chunks: an answer, a tool call, its result, a bounded answer and a cache read', async () => {
    const transport = scriptedRouteChecksFetch();
    const short = await send(k3(), body([{ role: 'user', content: SHORT_ANSWER }]), transport);
    expect(short).toMatchObject({ text: 'OK', terminal: { type: 'response.completed', response: { model: 'us.moonshotai.kimi-k3' } } });
    expect(short.usage).toMatchObject({ output_tokens: 18, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 14 } });

    const asked = await send(k3(), body([{ role: 'user', content: TOOL_ASK }], { tools: [tool] }), transport);
    expect(asked.call).toMatchObject({ type: 'function_call', call_id: 'functions.lookup_fact:0', name: 'lookup_fact', arguments: '{"key":"alpha"}' });
    const answered = await send(k3(), body([{ role: 'user', content: TOOL_ASK },
      { type: 'function_call', call_id: 'functions.lookup_fact:0', name: 'lookup_fact', arguments: '{"key":"alpha"}' },
      { type: 'function_call_output', call_id: 'functions.lookup_fact:0', output: JSON.stringify({ value: TOOL_VALUE }) }], { tools: [tool] }), transport);
    expect(answered.text).toBe(TOOL_VALUE);

    const bounded = await send(k3(), body([{ role: 'user', content: OUTPUT_BOUND_ASK }], { max_output_tokens: 64 }), transport);
    expect(bounded.terminal).toMatchObject({ type: 'response.incomplete', response: { incomplete_details: { reason: 'max_output_tokens' } } });
    expect(bounded.usage.output_tokens).toBe(64);

    const cached = [];
    for (let n = 0; n < 2; n++) cached.push(await send(k3(), body([{ role: 'user', content: SHORT_ANSWER }], { instructions: CACHE_PREFIX }), transport));
    expect(cached[0].usage.input_tokens_details.cached_tokens).toBe(0);
    expect(cached[1].usage.input_tokens_details.cached_tokens).toBeGreaterThan(1_024);
    expect(cached[1].usage.input_tokens).toBeGreaterThanOrEqual(cached[1].usage.input_tokens_details.cached_tokens);
  });

  it('answers GPT-6.1 Sol as an Azure Responses stream, naming the deployment it served', async () => {
    const transport = scriptedRouteChecksFetch();
    const short = await send(sol(), body([{ role: 'user', content: SHORT_ANSWER }]), transport);
    expect(short).toMatchObject({ text: 'OK', terminal: { type: 'response.completed', response: { model: 'gpt-6.1-sol' } } });
    const asked = await send(sol(), body([{ role: 'user', content: TOOL_ASK }], { tools: [tool] }), transport);
    expect(asked.call).toMatchObject({ type: 'function_call', call_id: expect.stringMatching(/^call_/), name: 'lookup_fact', arguments: '{"key":"alpha"}' });
    const second = [];
    for (let n = 0; n < 2; n++) second.push(await send(sol(), body([{ role: 'user', content: SHORT_ANSWER }], { instructions: CACHE_PREFIX }), transport));
    expect(second[1].usage.input_tokens_details.cached_tokens).toBeGreaterThan(1_024);
  });

  it('refuses a request without the connection’s key, one that would follow a redirect, and any other path', async () => {
    const transport = scriptedRouteChecksFetch();
    const post = (url: string, headers: Record<string, string>, redirect: RequestRedirect = 'manual') =>
      transport(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: '{}', redirect });
    expect((await post('https://bedrock-runtime.us-east-1.amazonaws.com/openai/v1/chat/completions', {})).status).toBe(401);
    expect((await post('https://diomedes-foundry-dev-rg.services.ai.azure.com/openai/v1/responses', { authorization: 'Bearer faux' })).status).toBe(401);
    expect((await post('https://bedrock-runtime.us-east-1.amazonaws.com/openai/v1/responses', { authorization: 'Bearer faux' })).status).toBe(404);
    expect((await post('https://example.com/openai/v1/chat/completions', { authorization: 'Bearer faux' })).status).toBe(404);
    await expect(post('https://bedrock-runtime.us-east-1.amazonaws.com/openai/v1/chat/completions', { authorization: 'Bearer faux' }, 'follow'))
      .rejects.toThrow(/redirects refused/);
  });
});
