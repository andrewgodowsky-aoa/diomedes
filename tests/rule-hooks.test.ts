import { afterEach, expect, test } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import type { HarnessPrincipal, ModelRequest } from '../shared/harness.js';
import { FileRunStore, RunService, ToolRegistry } from '../server/harness/index.js';
import { Suspended } from '../server/harness/run-service.js';
import { NativeAgent, type ModelAdapter } from '../server/harness/native-agent.js';

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});
const principal: HarnessPrincipal = {
  id: 'fixture',
  tenantId: 'fixture',
  projectId: 'p',
  capabilities: [],
  identityGeneration: 1,
};
const capabilities: ReturnType<ModelAdapter['capabilities']> = {
  engineId: 'scripted',
  engineVersion: '1',
  protocolVersion: '1',
  modelCalls: 'enforced',
  toolCalls: 'enforced',
  filesystemWrites: 'unsupported',
  networkEgress: 'unsupported',
  approvals: 'enforced',
  resumability: 'enforced',
  cancellability: 'enforced',
  checkpointGranularity: 'step',
  notes: ['Injected model output; no provider call.'],
};
async function setup(options: { tools?: string[]; toolCalls?: number } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'diomedes-rule-hooks-'));
  dirs.push(dir);
  const runtime = new RunService(new FileRunStore(dir));
  await runtime.start({
    id: 'r',
    projectId: 'p',
    tenantId: 'fixture',
    principal,
    capability: {
      id: 'fixture',
      version: '1',
      label: 'Synthetic',
      description: 'Rules',
      tools: options.tools ?? [],
      requestedPermissions: [],
      approvalPolicy: 'show-first',
      maxTurns: 4,
      supportedPlatforms: ['win32'],
    },
    budget: { units: 4, modelCalls: 4, toolCalls: options.toolCalls ?? 0, wallMs: 5000 },
  });
  await runtime.claim('r', 'owner');
  return { runtime, dir };
}
function adapter(onRequest: (request: ModelRequest) => void = () => {}): ModelAdapter {
  return {
    id: 'scripted',
    version: '1',
    capabilities: () => capabilities,
    prepare: async (request) => ({
      ...request,
      messages: [
        { role: 'user', text: '[quantity-rule v1] Untracked quantity is unknown.' },
        ...request.messages,
      ],
    }),
    complete: async (request) => {
      onRequest(request);
      return {
        response: {
          type: 'final',
          text: request.messages.some(
            (message) =>
              message.role === 'user' && message.text?.startsWith('Correction required:'),
          )
            ? 'Untracked quantity is unknown.'
            : 'Untracked quantity is 0.',
        },
      };
    },
    inspect: async (_request, text) => ({
      action: text.includes('is 0') ? 'correct' : 'verified',
      message: 'Do not infer a number for an untracked quantity.',
      rules: [{ id: 'quantity-rule', version: 1 }],
    }),
  };
}

test('the actual final context is durable before dispatch and a correction gets a distinct model identity', async () => {
  const { runtime } = await setup();
  const sent: ModelRequest[] = [];
  const model = adapter((request) => sent.push(request));
  const value = await new NativeAgent(runtime, model, new ToolRegistry()).run(
    'r',
    'owner',
    'Read stock',
    principal,
  );
  expect(value).toBe('Untracked quantity is unknown.');
  const run = await runtime.get('r');
  expect(run.used.modelCalls).toBe(2);
  const steps = run.steps.filter((step) => step.intent.kind === 'model');
  expect(steps.map((step) => step.intent.stepId)).toEqual(['model:0', 'model:1']);
  expect(steps[0].intent.input).toEqual({ provider: model.id, request: sent[0] });
  expect(steps[1].intent.input).toEqual({ provider: model.id, request: sent[1] });
  expect(steps[0].output).toMatchObject({ response: { text: 'Untracked quantity is 0.' } });
  expect(run.steps.filter((step) => step.intent.name === 'inspect_model_output')).toHaveLength(2);
  expect(steps.every((step) => step.attempt === 1)).toBe(true);
});

test('restart reuses saved context and raw observations without another model dispatch', async () => {
  const { runtime, dir } = await setup();
  let calls = 0;
  const model = adapter(() => calls++);
  await new NativeAgent(runtime, model, new ToolRegistry()).run(
    'r',
    'owner',
    'Read stock',
    principal,
  );
  const reopened = new RunService(new FileRunStore(dir), { clock: () => Date.now() + 120000 });
  await reopened.recover('r', principal);
  await reopened.claim('r', 'other');
  await new NativeAgent(reopened, model, new ToolRegistry()).run(
    'r',
    'other',
    'Read stock',
    principal,
  );
  expect(calls).toBe(2);
  expect((await reopened.get('r')).used.modelCalls).toBe(2);
});

test('mandatory project policy refuses before optional context preparation', async () => {
  const { runtime } = await setup();
  let prepared = 0;
  const model = adapter();
  model.prepare = async (request) => {
    prepared++;
    return request;
  };
  await expect(
    new NativeAgent(runtime, model, new ToolRegistry()).run('r', 'owner', 'Read', {
      ...principal,
      projectId: 'other',
    }),
  ).rejects.toThrow();
  expect(prepared).toBe(0);
});

test('replaying a transcript-returning corrected trajectory reconstructs each earlier transcript', async () => {
  const { runtime, dir } = await setup();
  let calls = 0;
  const sent: ModelRequest[] = [];
  const model = adapter((request) => sent.push(request)),
    complete = model.complete;
  model.complete = async (request, signal) => ({
    ...(await complete(request, signal)),
    transcript: {
      providerId: 'scripted',
      modelId: 'fixture',
      lineageId: 'lineage',
      opaqueRef: `opaque-${++calls}`,
      prefixHash: String(calls),
    },
  });
  await new NativeAgent(runtime, model, new ToolRegistry()).run(
    'r',
    'owner',
    'Read stock',
    principal,
  );
  expect(sent.map((request) => request.transcript?.opaqueRef ?? null)).toEqual([null, 'opaque-1']);
  const reopened = new RunService(new FileRunStore(dir), { clock: () => Date.now() + 120000 });
  await reopened.recover('r', principal);
  await reopened.claim('r', 'other');
  await new NativeAgent(reopened, model, new ToolRegistry()).run(
    'r',
    'other',
    'Read stock',
    principal,
  );
  expect(calls).toBe(2);
  expect((await reopened.get('r')).transcripts.scripted.opaqueRef).toBe('opaque-2');
});

test('a context hook cannot add a tool or change its run identity', async () => {
  const { runtime } = await setup();
  let calls = 0;
  const model = adapter(() => calls++);
  model.prepare = async (request) => ({ ...request, runId: 'other' });
  await expect(
    new NativeAgent(runtime, model, new ToolRegistry()).run('r', 'owner', 'Read', principal),
  ).rejects.toMatchObject({ code: 'invalid_prepared_context' });
  expect(calls).toBe(0);
});

test('a tool removed from the final prepared context cannot dispatch', async () => {
  const { runtime } = await setup({ tools: ['kept_tool', 'removed_tool'], toolCalls: 1 });
  const tools = new ToolRegistry();
  let dispatches = 0;
  for (const name of ['kept_tool', 'removed_tool'])
    tools.register({
      name,
      version: '1',
      description: name,
      effect: 'pure',
      permission: null,
      approval: false,
      destination: 'local',
      trustedInputRequired: false,
      cost: 1,
      schema: z.strictObject({}),
      execute: async () => {
        dispatches++;
        return { called: name };
      },
    });
  const model = adapter();
  model.prepare = async (request) => ({
    ...request,
    tools: request.tools.filter((tool) => tool.name === 'kept_tool'),
  });
  model.complete = async () => ({ response: { type: 'tool', name: 'removed_tool', input: {} } });
  await expect(
    new NativeAgent(runtime, model, tools).run('r', 'owner', 'Read', principal),
  ).rejects.toMatchObject({ code: 'tool_not_in_context' });
  expect(dispatches).toBe(0);
  expect((await runtime.get('r')).used.toolCalls).toBe(0);
});

test('interruption after the first model observation does not redispatch that provider turn on recovery', async () => {
  const { runtime, dir } = await setup();
  let calls = 0;
  const model = adapter(),
    complete = model.complete;
  model.complete = async (request, signal) => ({
    ...(await complete(request, signal)),
    transcript: {
      providerId: 'scripted',
      modelId: 'fixture',
      lineageId: 'lineage',
      opaqueRef: `opaque-${++calls}`,
      prefixHash: String(calls),
    },
  });
  // Exact crash seam: the provider observation is durable, convenience index is not.
  runtime.recordTranscript = async () => {
    throw new Suspended('event', 'Injected host interruption');
  };
  await expect(
    new NativeAgent(runtime, model, new ToolRegistry()).run('r', 'owner', 'Read stock', principal),
  ).rejects.toThrow('Injected host interruption');
  expect(
    (await runtime.get('r')).steps.find((step) => step.intent.stepId === 'model:0')?.state,
  ).toBe('succeeded');
  const reopened = new RunService(new FileRunStore(dir), { clock: () => Date.now() + 6000 });
  await reopened.recover('r', principal);
  await reopened.claim('r', 'other');
  await new NativeAgent(reopened, model, new ToolRegistry()).run(
    'r',
    'other',
    'Read stock',
    principal,
  );
  expect(calls).toBe(2);
  expect((await reopened.get('r')).transcripts.scripted.opaqueRef).toBe('opaque-2');
});

test('persistent erroneous output stops at the correction budget without rewriting observations', async () => {
  const { runtime } = await setup();
  let calls = 0;
  const model = adapter();
  model.complete = async () => {
    calls++;
    return { response: { type: 'final', text: 'Untracked quantity is 0.' } };
  };
  await expect(
    new NativeAgent(runtime, model, new ToolRegistry()).run('r', 'owner', 'Read', principal),
  ).rejects.toMatchObject({ code: 'correction_limit' });
  expect(calls).toBe(2);
  expect(
    (await runtime.get('r')).steps.filter((step) => step.intent.kind === 'model'),
  ).toHaveLength(2);
});

test('revoking a prepared rule context denies dispatch instead of changing frozen bytes', async () => {
  const { runtime } = await setup();
  let calls = 0;
  const model = adapter(() => calls++);
  model.validatePrepared = async () => {
    throw new Error('Rule version revoked; start a new reviewed run.');
  };
  await expect(
    new NativeAgent(runtime, model, new ToolRegistry()).run('r', 'owner', 'Read', principal),
  ).rejects.toThrow('Rule version revoked');
  expect(calls).toBe(0);
});
