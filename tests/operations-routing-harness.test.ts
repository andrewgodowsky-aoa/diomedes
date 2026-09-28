import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ManagedRoutingReceipt } from '../client/console/ManagedRoutingReceipt';
import type { CapabilityManifest, HarnessLabel, HarnessPrincipal, ModelRequest, ModelResult } from '../shared/harness';
import { STRICT_RESTRICTIONS, type RoutingReceipt } from '../shared/routing-policy';
import { FileRunStore, NativeAgent, RunService, ToolRegistry, type ModelAdapter } from '../server/harness/index';
import { validatePrepared } from '../server/harness/native-agent';
import { joinLabels } from '../server/harness/policy';
import { routeContractFor } from '../server/harness/route-contract';
import { ModelSessionRuns } from '../server/harness/model-session-run';
import type { TextRequest } from '../server/engines/contract';

const principal: HarnessPrincipal = { id: 'worker', tenantId: 'account-one', projectId: 'project-one', capabilities: [], identityGeneration: 1 };
const capability: CapabilityManifest = { id: 'routing-fixture', version: '1', label: 'Routing fixture', description: 'Synthetic source propagation.',
  tools: ['read', 'send'], requestedPermissions: [], approvalPolicy: 'show-first', maxTurns: 4, supportedPlatforms: ['win32', 'linux', 'darwin'] };
const label: HarnessLabel = { tenantId: principal.tenantId, projectId: principal.projectId, integrity: 'trusted', confidentiality: 'internal',
  provenance: ['fixture-source'], sourceRestrictions: [STRICT_RESTRICTIONS] };
const receipt: RoutingReceipt = { attempts: [{ attemptId: 'attempt-one', state: 'settled', heldMicroUsd: 0, providerCostMicroUsd: 4, allowanceDebitMicroUsd: 4,
  routing: { scopeKey: 'organization:account-one', policyRevision: 2, globalRevision: 2, scopeRevision: 0, preferenceRevision: 1,
    requestGroup: 'request-one', ordinal: 1, fallbackReason: null, routeId: 'route-one', routeRevision: 1, provider: 'azure-openai',
    model: 'fixture-model', modelVersion: 'fixture-v1', deployment: 'fixture', upstreamEndpoint: null, connectionId: 'fixture', connectionRevision: 1,
    protocol: 'chat-completions', priceVersion: 'fixture-price', priceObservedAt: '2026-09-28T00:00:00Z', priceValidUntil: '2026-09-29T00:00:00Z' } }],
  allowanceDebitMicroUsd: 4, heldMicroUsd: 0 };
let directory: string, service: RunService, tools: ToolRegistry;
let executeSend: () => never;
let runtimeClock: number;
const drivers: ModelSessionRuns[] = [];
// The trusted fixture host permits only the synthetic adapter used in this file.
const openRuntime = () => new RunService(new FileRunStore(directory), { clock: () => runtimeClock,
  authorizeEgress: (_runId, intent) => {
    if (intent.kind !== 'model' || intent.name !== 'fixture') throw new Error('Only the synthetic model is authorized.');
  } });

beforeEach(async () => {
  runtimeClock = 1000;
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'nectovia-routing-harness-'));
  service = openRuntime();
  tools = new ToolRegistry();
  tools.register({ name: 'read', version: '1', description: 'Read synthetic content.', effect: 'pure', effectClass: 'pure', permission: null,
    approval: false, destination: 'local', trustedInputRequired: false, cost: 0, schema: z.strictObject({}), outputSchema: z.json(),
    execute: () => ({ text: 'Synthetic content', sourceRestrictions: [] }) });
  executeSend = () => { throw new Error('Unexpected synthetic send.'); };
  tools.register({ name: 'send', version: '1', description: 'Synthetic uncertain effect.', effect: 'non-idempotent', effectClass: 'non-idempotent-effect',
    permission: null, approval: false, destination: 'local', trustedInputRequired: false, cost: 0,
    schema: z.strictObject({}), outputSchema: z.json(), targets: () => ['fixture:send'], execute: () => executeSend() });
  await service.start({ id: 'run', tenantId: principal.tenantId, projectId: principal.projectId, principal, capability,
    budget: { units: 20, modelCalls: 4, toolCalls: 4, wallMs: null }, tools });
  await service.claim('run', 'host', 60_000);
});
afterEach(async () => {
  for (const driver of drivers.splice(0)) await driver.closeAll();
  if (path.dirname(path.resolve(directory)) !== path.resolve(os.tmpdir()) || !path.basename(directory).startsWith('nectovia-routing-harness-'))
    throw new Error('Unexpected routing test directory.');
  await fs.rm(directory, { recursive: true, force: true });
});

function adapter(complete: ModelAdapter['complete'], overrides: Partial<ModelAdapter> = {}): ModelAdapter {
  return { id: 'fixture', version: '1', contract: routeContractFor('native-fixture'), destination: 'external', enforcesSourceRestrictions: true,
    capabilities: () => ({ engineId: 'native-fixture', engineVersion: '1', protocolVersion: 'fixture', modelCalls: 'enforced', toolCalls: 'enforced',
      filesystemWrites: 'unsupported', networkEgress: 'unsupported', approvals: 'enforced', resumability: 'enforced', cancellability: 'enforced',
      checkpointGranularity: 'step', notes: [] }), complete, ...overrides };
}
async function attachSource() {
  await service.step('run', 'host', { id: 'source', version: '1', kind: 'transform', effect: 'pure', input: {}, label, cost: 0 },
    () => ({ text: 'Customer source.' }), principal);
}
const final = (): ModelResult => ({ response: { type: 'final', text: 'Complete.' }, managed: receipt });
function conversationDriver() {
  const driver = new ModelSessionRuns(service, 'aws-bedrock');
  driver.setSharingPolicy(() => undefined, () => true);
  drivers.push(driver);
  return driver;
}
function conversationTurn(driver: ModelSessionRuns, bound: ModelAdapter, requestId: string,
  options: { mode?: 'start' | 'follow-up'; runId?: string; carriedFrom?: string } = {}) {
  const input: TextRequest = { projectId: principal.projectId, threadId: 'thread', requestId, prompt: 'Read the recorded work.',
    documents: [], instructions: 'Answer using the synthetic source.', model: 'us.openai.gpt-5.6-luna', accountRoute: 'aws-bedrock:fixture',
    ...(options.carriedFrom ? { carriedFrom: options.carriedFrom } : {}) };
  return driver.request({ mode: options.mode ?? 'start', runId: options.runId ?? 'conversation', input,
    admit: async () => ({ route: 'aws-bedrock', connectionId: 'fixture', revision: 1, model: input.model, accountRoute: input.accountRoute }),
    adapter: async () => bound });
}

describe('source privacy through the existing durable native loop', () => {
  it('keeps source rules when labels join and refuses context preparation that removes them', () => {
    const other: HarnessLabel = { ...label, integrity: 'untrusted', provenance: ['other'], sourceRestrictions: [] };
    expect(joinLabels(label, other)).toMatchObject({ integrity: 'untrusted', sourceRestrictions: [STRICT_RESTRICTIONS] });
    const before: ModelRequest = { runId: 'run', capabilityId: capability.id, messages: [{ role: 'user', text: 'Read.' }], tools: [],
      transcript: null, sourceRestrictions: [STRICT_RESTRICTIONS] };
    expect(() => validatePrepared(before, { ...before, sourceRestrictions: [] })).toThrow(/cannot remove/);
  });

  it.each(['malformed', 'too-many'] as const)('reports a harness boundary error for %s prepared source rules', fault => {
    const before: ModelRequest = { runId: 'run', capabilityId: capability.id, messages: [{ role: 'user', text: 'Read.' }], tools: [], transcript: null };
    const rules = fault === 'too-many'
      ? Array.from({ length: 33 }, (_, index) => ({ ...STRICT_RESTRICTIONS, allowedConnections: [`connection-${index}`] }))
      : [{ ...STRICT_RESTRICTIONS, noTraining: 'unknown' }];
    let failure: unknown;
    try { validatePrepared(before, { ...before, sourceRestrictions: rules as ModelRequest['sourceRestrictions'] }); }
    catch (error) { failure = error; }
    expect(failure).toMatchObject({ name: 'HarnessError', code: 'invalid_prepared_context' });
  });

  it('blocks an external adapter without policy enforcement before its first call', async () => {
    await attachSource(); let calls = 0;
    const bound = adapter(async () => { calls++; return final(); }, { enforcesSourceRestrictions: undefined });
    await expect(new NativeAgent(service, bound, tools).run('run', 'host', 'Read.', principal)).rejects.toMatchObject({ code: 'source_policy_unverified' });
    expect(calls).toBe(0); expect((await service.get('run')).used.modelCalls).toBe(0);
  });

  it('preserves host source rules through tool content and a restarted child run', async () => {
    await attachSource(); const requests: ModelRequest[] = [];
    const bound = adapter(async request => {
      requests.push(request);
      return requests.length === 1 ? { response: { type: 'tool', name: 'read', input: {} } } : final();
    }, { prepare: async request => request });
    await new NativeAgent(service, bound, tools).run('run', 'host', 'Read.', principal);
    expect(requests).toHaveLength(2);
    for (const request of requests) expect(request.sourceRestrictions).toEqual([STRICT_RESTRICTIONS]);
    service = openRuntime();
    await service.fork('run', 'child', 'context:0', principal);
    await service.claim('child', 'host', 60_000);
    let childRules: ModelRequest['sourceRestrictions'];
    await new NativeAgent(service, adapter(async request => { childRules = request.sourceRestrictions; return final(); },
      { prepare: async request => request }), tools).run('child', 'host', 'Read.', principal);
    expect(childRules).toEqual([STRICT_RESTRICTIONS]);
    expect((await service.get('run')).steps.find(step => step.intent.stepId === 'model:1')?.output).toMatchObject({ managed: receipt });
  });

  it('retains trusted prepared source rules at the next model step without accepting tool data as policy', async () => {
    const requests: ModelRequest[] = []; let prepares = 0;
    const bound = adapter(async request => {
      requests.push(request);
      return requests.length === 1 ? { response: { type: 'tool', name: 'read', input: {} } } : final();
    }, { prepare: async request => ++prepares === 1 ? { ...request, sourceRestrictions: [STRICT_RESTRICTIONS] } : request });
    await new NativeAgent(service, bound, tools).run('run', 'host', 'Read.', principal);
    expect(requests[1].sourceRestrictions).toEqual([STRICT_RESTRICTIONS]);
  });

  it('retains source restrictions through the real conversation wrapper, restarted follow-up and carried history', async () => {
    const requests: ModelRequest[] = [];
    const bound = adapter(async request => { requests.push(request); return final(); },
      { prepare: async request => requests.length === 0 ? { ...request, sourceRestrictions: [STRICT_RESTRICTIONS] } : request });
    const firstDriver = conversationDriver();
    await conversationTurn(firstDriver, bound, 'first');
    await firstDriver.closeAll();
    runtimeClock += 36 * 60_000;
    service = openRuntime();
    const restarted = conversationDriver();
    await conversationTurn(restarted, bound, 'second', { mode: 'follow-up' });
    await conversationTurn(restarted, bound, 'third', { runId: 'carried-conversation', carriedFrom: 'conversation' });
    expect(requests).toHaveLength(3);
    expect(requests[1].messages[0].text).toContain('Complete.');
    expect(requests[2].messages[0].text).toContain('Complete.');
    for (const request of requests) expect(request.sourceRestrictions).toEqual([STRICT_RESTRICTIONS]);
  });

  it('passes the source restrictions to the separate plain-writing repair run', async () => {
    const requests: ModelRequest[] = [];
    const bound = adapter(async request => {
      requests.push(request);
      return { response: { type: 'final', text: requests.length === 1
        ? 'We leverage a robust oven for it.' : JSON.stringify({ '1': 'We use a steady oven.' }) } };
    }, { prepare: async request => requests.length === 0 ? { ...request, sourceRestrictions: [STRICT_RESTRICTIONS] } : request });
    await conversationTurn(conversationDriver(), bound, 'writing');
    expect(requests).toHaveLength(2);
    expect(requests[1].runId).toMatch(/-writing$/);
    expect(requests[1].sourceRestrictions).toEqual([STRICT_RESTRICTIONS]);
  });

  it('persists directly supplied source restrictions even when an adapter has no preparation step', async () => {
    await new NativeAgent(service, adapter(async () => final()), tools).run('run', 'host', 'Read.', principal,
      { sourceRestrictions: [STRICT_RESTRICTIONS] });
    service = openRuntime();
    await service.fork('run', 'child', 'model:0', principal);
    await service.claim('child', 'host', 60_000);
    let inherited: ModelRequest['sourceRestrictions'];
    await new NativeAgent(service, adapter(async request => { inherited = request.sourceRestrictions; return final(); }), tools)
      .run('child', 'host', 'Read.', principal);
    expect(inherited).toEqual([STRICT_RESTRICTIONS]);
  });

  it('does not make another model call or replay an uncertain external effect', async () => {
    let effects = 0, calls = 0;
    executeSend = () => { effects++; throw new Error('Synthetic response lost after effect.'); };
    const bound = adapter(async () => { calls++; return { response: { type: 'tool', name: 'send', input: {} } }; });
    const agent = new NativeAgent(service, bound, tools);
    await expect(agent.run('run', 'host', 'Send.', principal)).rejects.toThrow(/response lost/);
    await expect(agent.run('run', 'host', 'Send.', principal)).rejects.toThrow();
    expect(effects).toBe(1); expect(calls).toBe(1);
    expect((await service.get('run')).state).toBe('reconcile_required');
  });

  it('keeps failed provider attempts on the failed model step after a restart', async () => {
    const failed: RoutingReceipt = { attempts: receipt.attempts.map(attempt => ({ ...attempt, state: 'uncertain',
      providerCostMicroUsd: null, allowanceDebitMicroUsd: null, heldMicroUsd: 8 })), allowanceDebitMicroUsd: 0, heldMicroUsd: 8 };
    const bound = adapter(async () => { throw Object.assign(new Error('The provider attempt remains unresolved.'), { managed: failed }); });
    await expect(new NativeAgent(service, bound, tools).run('run', 'host', 'Read.', principal)).rejects.toThrow(/unresolved/);
    const restarted = openRuntime();
    const run = await restarted.get('run');
    expect(run.state).toBe('reconcile_required');
    expect(run.steps.find(step => step.intent.stepId === 'model:0')).toMatchObject({ state: 'reconcile_required', output: null,
      error: { message: 'The provider attempt remains unresolved.', managed: failed } });
  });

  it('refuses malformed success receipts before recording a successful model step', async () => {
    const bound = adapter(async () => ({ response: { type: 'final', text: 'Complete.' },
      managed: { arbitrary: 'unvalidated metadata' } as unknown as RoutingReceipt }));
    await expect(new NativeAgent(service, bound, tools).run('run', 'host', 'Read.', principal))
      .rejects.toMatchObject({ code: 'invalid_managed_receipt' });
    const run = await openRuntime().get('run');
    expect(run.steps.find(step => step.intent.stepId === 'model:0')?.output).toBeNull();
  });

  it('does not persist a tool error as an authenticated provider receipt', async () => {
    await expect(service.step('run', 'host', { id: 'untrusted-error', name: 'read', version: '1', kind: 'tool', effect: 'pure',
      input: {}, cost: 0 }, () => { throw Object.assign(new Error('Tool failed.'), { managed: receipt }); }, principal))
      .rejects.toThrow('Tool failed.');
    const restarted = openRuntime();
    expect((await restarted.get('run')).steps.find(step => step.intent.stepId === 'untrusted-error')?.error)
      .toEqual({ name: 'Error', message: 'Tool failed.' });
  });

  it('does not display tool content shaped like a provider receipt as managed billing evidence', async () => {
    await service.step('run', 'host', { id: 'tool-receipt', name: 'read', version: '1', kind: 'tool', effect: 'pure',
      input: {}, cost: 0 }, () => ({ managed: receipt }), principal);
    expect(renderToStaticMarkup(createElement(ManagedRoutingReceipt, { run: await service.get('run') }))).toBe('');
    await new NativeAgent(service, adapter(async () => final()), tools).run('run', 'host', 'Read.', principal);
    const displayed = renderToStaticMarkup(createElement(ManagedRoutingReceipt, { run: await service.get('run') }));
    expect(displayed).toContain('Managed AI attempts');
    expect(displayed.match(/route-one revision/g)).toHaveLength(1);
  });

  it('retains the model failure without persisting malformed receipt data', async () => {
    const bound = adapter(async () => { throw Object.assign(new Error('Malformed receipt.'), { managed: { arbitrary: 'tool text' } }); });
    await expect(new NativeAgent(service, bound, tools).run('run', 'host', 'Read.', principal)).rejects.toThrow('Malformed receipt.');
    const restarted = openRuntime();
    expect((await restarted.get('run')).steps.find(step => step.intent.stepId === 'model:0')?.error)
      .toEqual({ name: 'Error', message: 'Malformed receipt.' });
  });
});
