/**
 * An evaluation as a recorded step.
 *
 * The handoff package is emphatic on one point: a real cloud evaluation must
 * not hide inside the native loop's `prepare` or `inspect` hooks. Those are
 * declared pure, zero-cost and application-attributed, and a network call in
 * one of them would be an unrecorded, unbudgeted, misattributed charge that no
 * usage screen could ever show.
 *
 * So an evaluation goes through the same door every other model call goes
 * through: `RunService.step`, with `kind: 'model'` and `destination: 'external'`.
 * That declaration is not decoration. It is what routes the step through the
 * host's egress authorizer, and it is what makes `needsReconciliation` park an
 * unknown outcome instead of silently retrying a call that may already have
 * been charged for.
 *
 * These tests use a RunService with its own egress authorizer, which is how the
 * existing harness tests work. No host, no network, no provider.
 */
import { afterEach, describe, expect, test } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { CapabilityManifest, HarnessPrincipal, StepIntent } from '../shared/harness.js';
import { FileRunStore, RunService } from '../server/harness/index.js';
import { EVALUATION_PERMISSION, recordEvaluation } from '../server/harness/evaluation.js';
import { scriptedEvaluationPort } from '../server/harness/evaluation-adapter.js';
import { booleanQuestion, choiceQuestion, evaluationProfile } from '../shared/evaluation.js';

const AT = '2026-09-19T09:00:00.000Z';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  // Taken before the first await: a hook that outlives its timeout must not go
  // on to run the cleanups the next test pushes.
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const principal: HarnessPrincipal = {
  id: 'worker',
  tenantId: 'a',
  projectId: 'p',
  capabilities: [EVALUATION_PERMISSION],
  identityGeneration: 1,
};

const capability: CapabilityManifest = {
  id: 'evaluation-fixture',
  version: 'v1',
  label: 'Evaluation fixture',
  description: 'A synthetic capability for the evaluation step tests.',
  tools: [],
  requestedPermissions: [EVALUATION_PERMISSION],
  approvalPolicy: 'show-first',
  maxTurns: 4,
  supportedPlatforms: ['win32'],
};

const profile = () =>
  evaluationProfile({
    profileId: 'thread-preparation.sources',
    revision: 1,
    purpose: 'thread-preparation',
    questions: [
      choiceQuestion({
        id: 'most-relevant',
        instructions: 'Which source matters?',
        options: [
          { id: 'src-a', description: null },
          { id: 'src-b', description: null },
        ],
      }),
      booleanQuestion({ id: 'needs-history', instructions: 'Needs a prior period?' }),
    ],
  });

const answer = {
  answers: {
    'most-relevant': { type: 'choice', choice: 'src-b' },
    'needs-history': { type: 'boolean', probability: 0.7 },
  },
  usage: { inputTokens: 1_200 },
  warnings: [],
  response: { modelId: 'jev-1.13.0' },
};

const label = {
  tenantId: 'a',
  projectId: 'p',
  integrity: 'untrusted' as const,
  confidentiality: 'restricted' as const,
  provenance: ['src-a', 'src-b'],
};

async function setup(options: { egress?: (intent: StepIntent, phase: string) => void } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'diomedes-evaluation-'));
  cleanups.push(() => fs.rm(dir, { recursive: true, force: true }));
  const seen: { intent: StepIntent; phase: string }[] = [];
  const service = new RunService(new FileRunStore(dir), {
    clock: () => 1000,
    authorizeEgress: async (_runId, intent, _principal, phase) => {
      seen.push({ intent, phase });
      options.egress?.(intent, phase);
    },
  });
  await service.start({
    id: 'r',
    tenantId: 'a',
    projectId: 'p',
    capability,
    principal,
    budget: { units: 20, modelCalls: 5, toolCalls: 5, wallMs: null },
  });
  await service.claim('r', 'host', 100);
  return { service, seen, dir };
}

const run = async (
  service: RunService,
  port: ReturnType<typeof scriptedEvaluationPort>,
  over: { state?: unknown } = {},
) =>
  recordEvaluation({
    runtime: service,
    runId: 'r',
    owner: 'host',
    principal,
    port,
    profile: profile(),
    state: over.state ?? 'the synthetic project',
    label,
    observedAt: AT,
  });

// --- the step it records ------------------------------------------------------

describe('the recorded step', () => {
  test('is a model call, not a pure transform', async () => {
    const { service } = await setup();
    await run(service, scriptedEvaluationPort({ result: answer }));
    const step = (await service.get('r')).steps.at(-1)!;
    expect(step.intent.kind).toBe('model');
    expect(step.intent.effect).toBe('read');
    expect(step.intent.cost).toBeGreaterThan(0);
  });

  test('declares itself external, which is what routes it through egress', async () => {
    const { service, seen } = await setup();
    await run(service, scriptedEvaluationPort({ result: answer }));
    expect((await service.get('r')).steps.at(-1)!.intent.destination).toBe('external');
    // Authorized at dispatch and again before the observation may commit.
    expect(seen.map((s) => s.phase)).toEqual(['dispatch', 'dispatch', 'dispatch', 'result']);
  });

  test('is never retried on its own, because an unknown outcome may already be charged', async () => {
    const { service } = await setup();
    await run(service, scriptedEvaluationPort({ result: answer }));
    expect((await service.get('r')).steps.at(-1)!.intent.maxAttempts).toBe(1);
  });

  test('carries the permission it needs, so a principal without it cannot run one', async () => {
    const { service } = await setup();
    await run(service, scriptedEvaluationPort({ result: answer }));
    expect((await service.get('r')).steps.at(-1)!.intent.permission).toBe(EVALUATION_PERMISSION);
  });

  test('does not copy the project into the run record', async () => {
    const { service } = await setup();
    const secret = 'CONFIDENTIAL-SUPPLIER-TERMS-9f2b';
    await run(service, scriptedEvaluationPort({ result: answer }), {
      state: `a project containing ${secret}`,
    });
    const step = (await service.get('r')).steps.at(-1)!;
    // The intent pins the state by digest so a changed state is a different
    // step, without duplicating documents into telemetry.
    expect(JSON.stringify(step.intent.input)).not.toContain(secret);
    expect(JSON.stringify(step.intent.input)).toMatch(/stateDigest/);
  });
});

// --- attribution --------------------------------------------------------------

describe('who the work is attributed to', () => {
  test('is the application when the port is a fixed script', async () => {
    const { service } = await setup();
    await run(service, scriptedEvaluationPort({ result: answer }));
    const step = (await service.get('r')).steps.at(-1)!;
    expect(step.origin?.mode).toBe('application');
  });

  test('is the model the provider reported when the port is real', async () => {
    const { service } = await setup();
    const real = { ...scriptedEvaluationPort({ result: answer }), scripted: false };
    await run(service, real as ReturnType<typeof scriptedEvaluationPort>);
    const step = (await service.get('r')).steps.at(-1)!;
    expect(step.origin?.mode).toBe('direct');
    expect(JSON.stringify(step.origin)).toContain('jev-1.13.0');
  });
});

// --- replay -------------------------------------------------------------------

describe('asking the same question twice', () => {
  test('calls the provider once and returns the saved answer', async () => {
    const { service } = await setup();
    const port = scriptedEvaluationPort({ result: answer });
    const first = await run(service, port);
    const second = await run(service, port);
    expect(port.calls).toHaveLength(1);
    expect(second).toEqual(first);
  });

  test('asks again when the project changed under it', async () => {
    const { service } = await setup();
    const port = scriptedEvaluationPort({ result: answer });
    await run(service, port, { state: 'before' });
    await run(service, port, { state: 'after' });
    expect(port.calls).toHaveLength(2);
  });
});

// --- refusals -----------------------------------------------------------------

describe('a call the host refuses', () => {
  test('never reaches the provider', async () => {
    const { service } = await setup({
      egress: () => {
        throw new Error('egress_denied');
      },
    });
    const port = scriptedEvaluationPort({ result: answer });
    await expect(run(service, port)).rejects.toThrow(/egress_denied/);
    expect(port.calls).toHaveLength(0);
  });

  test('leaves no successful observation behind', async () => {
    const { service } = await setup({
      egress: () => {
        throw new Error('egress_denied');
      },
    });
    await expect(run(service, scriptedEvaluationPort({ result: answer }))).rejects.toThrow();
    const steps = (await service.get('r')).steps;
    expect(steps.every((step) => step.state !== 'succeeded')).toBe(true);
  });
});

describe('a provider that answers badly', () => {
  test('fails the step rather than committing a malformed decision', async () => {
    const { service } = await setup();
    const port = scriptedEvaluationPort({
      result: { answers: { 'most-relevant': { type: 'choice', choice: 'src-invented' } } },
    });
    await expect(run(service, port)).rejects.toThrow();
    const step = (await service.get('r')).steps.at(-1)!;
    expect(step.state).not.toBe('succeeded');
  });
});

// --- what it returns ----------------------------------------------------------

describe('the observation', () => {
  test('is the validated decision, bound to the profile that asked it', async () => {
    const { service } = await setup();
    const observed = await run(service, scriptedEvaluationPort({ result: answer }));
    expect(observed.profileId).toBe('thread-preparation.sources');
    expect(observed.actualModel).toBe('jev-1.13.0');
    expect(observed.usage.inputTokens).toBe(1_200);
  });

  test('survives the run record unchanged, because it is plain JSON', async () => {
    const { service } = await setup();
    const observed = await run(service, scriptedEvaluationPort({ result: answer }));
    const stored = (await service.get('r')).steps.at(-1)!.output;
    expect(stored).toEqual(observed);
  });
});
