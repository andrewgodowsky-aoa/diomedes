import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FileRunStore, NativeAgent, RunService, ToolRegistry } from '../server/harness/index.js';
import { FileSdkTranscripts } from '../server/harness/sdk-transcripts.js';
import { createBedrockModelAdapter } from '../server/harness/vercel-model-adapter.js';
import type { CapabilityManifest, HarnessPrincipal, StepIntent } from '../shared/harness.js';

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});
const principal: HarnessPrincipal = {
  id: 'test-host',
  tenantId: 'test',
  projectId: 'project',
  identityGeneration: 1,
  capabilities: [],
};
const capability: CapabilityManifest = {
  id: 'bedrock-test',
  version: '1',
  label: 'Test',
  description: 'Synthetic SDK runtime proof',
  tools: [],
  requestedPermissions: [],
  approvalPolicy: 'show-first',
  maxTurns: 2,
  supportedPlatforms: ['win32', 'darwin', 'linux'],
};

async function setup(authorized: boolean, fail = false) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'diomedes-sdk-runtime-'));
  dirs.push(dir);
  const authorize = vi.fn(
    async (
      _id: string,
      _intent: StepIntent,
      _principal: HarnessPrincipal,
      _phase: 'dispatch' | 'result',
    ) => {},
  );
  const runs = new RunService(new FileRunStore(path.join(dir, 'runs')), {
    ...(authorized ? { authorizeEgress: authorize } : {}),
  });
  await runs.start({
    id: 'run-test',
    tenantId: principal.tenantId,
    projectId: principal.projectId,
    capability,
    principal,
    budget: { units: 10, modelCalls: 2, toolCalls: 0, wallMs: null },
  });
  await runs.claim('run-test', 'host', 60_000);
  const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async () => {
    if (fail) throw new TypeError('synthetic transport lost after dispatch');
    return Response.json({
      output: { message: { role: 'assistant', content: [{ text: 'Hello.' }] } },
      stopReason: 'end_turn',
      usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 },
      metrics: { latencyMs: 1 },
    });
  });
  const adapter = createBedrockModelAdapter({
    profile: {
      id: 'test-luna',
      accountRoute: 'aws:test',
      region: 'us-east-1',
      modelId: 'us.openai.gpt-5.6-luna',
    },
    credentials: { kind: 'bearer', apiKey: 'synthetic-key' },
    transcripts: new FileSdkTranscripts(path.join(dir, 'private')),
    fetch,
  });
  return { runs, fetch, authorize, dir, agent: new NativeAgent(runs, adapter, new ToolRegistry()) };
}

describe('AWS SDK operations in the existing durable runtime', () => {
  it('refuses cloud dispatch without the host egress authorizer', async () => {
    const { agent, fetch } = await setup(false);
    await expect(agent.run('run-test', 'host', 'Hello.', principal)).rejects.toThrow(
      /egress|external|grant/i,
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  it('records the explicit route and usage and replays without another provider call', async () => {
    const { agent, fetch, authorize, runs } = await setup(true);
    expect(await agent.run('run-test', 'host', 'Hello.', principal)).toBe('Hello.');
    expect(await agent.run('run-test', 'host', 'Hello.', principal)).toBe('Hello.');
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(authorize.mock.calls.some((call) => call[3] === 'result')).toBe(true);
    const run = await runs.get('run-test');
    const step = run.steps.find((value) => value.intent.stepId === 'model:0')!;
    expect(step.intent.destination).toBe('external');
    expect(JSON.stringify(step.intent.input)).toContain('aws:test');
    expect(JSON.stringify(step.intent.input)).toContain('us.openai.gpt-5.6-luna');
    expect(step.output).toMatchObject({ usage: { inputTokens: 10, outputTokens: 2 } });
    expect(JSON.stringify(run)).not.toContain('synthetic-key');
  });

  it('parks a lost AWS result for reconciliation and never resends it on replay', async () => {
    const { agent, fetch, runs } = await setup(true, true);
    await expect(agent.run('run-test', 'host', 'Hello.', principal)).rejects.toMatchObject({
      code: 'sdk_unknown_outcome',
    });
    expect((await runs.get('run-test')).state).toBe('reconcile_required');
    await expect(agent.run('run-test', 'host', 'Hello.', principal)).rejects.toThrow();
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('refuses a provider result when host authority was revoked during the call', async () => {
    const { agent, fetch, authorize, runs } = await setup(true);
    authorize.mockImplementation(async (_id, _intent, _principal, phase) => {
      if (phase === 'result') throw new Error('Synthetic authority revoked');
    });
    await expect(agent.run('run-test', 'host', 'Hello.', principal)).rejects.toThrow(/revoked/);
    const run = await runs.get('run-test');
    expect(run.state).toBe('reconcile_required');
    expect(run.steps.find((step) => step.intent.stepId === 'model:0')?.output).toBeNull();
    expect(fetch).toHaveBeenCalledTimes(1);
    await expect(agent.run('run-test', 'host', 'Hello.', principal)).rejects.toThrow();
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
