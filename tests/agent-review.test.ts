/** Task-scoped Jev review, over real durable runs and a scripted provider. No paid calls. */
import { afterEach, describe, expect, test } from 'vitest';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { CapabilityManifest, HarnessPrincipal } from '../shared/harness.js';
import { booleanQuestion, evaluationProfile, profileDigest, type EvaluationProfile } from '../shared/evaluation.js';
import { micro } from '../shared/managed-usage.js';
import { serializedRequestTokens, serializedStateTokens } from '../shared/evaluation-wire.js';
import { FileRunStore, RunService } from '../server/harness/index.js';
import { digest } from '../server/harness/policy.js';
import { evaluationStepId, EVALUATION_PERMISSION } from '../server/harness/evaluation.js';
import { providerQuestions, scriptedEvaluationPort, type EvaluationPort } from '../server/harness/evaluation-adapter.js';
import { localHarnessPrincipal } from '../server/harness/bridge.js';
import { SpendExposure } from '../server/spend-exposure.js';
import { denial, type Authority, type PrincipalRef } from '../server/trust/index.js';

// A missing feature fails a behavioral assertion, rather than preventing test collection.
const moduleFile = new URL('../server/harness/agent-review.ts', import.meta.url);
const reviewModule: Record<string, unknown> = await fs.access(moduleFile).then(
  () => import(/* @vite-ignore */ moduleFile.href),
  () => ({}),
);
const sharedFile = new URL('../shared/agent-review.ts', import.meta.url);
const contractModule: Record<string, unknown> = await fs.access(sharedFile).then(
  () => import(/* @vite-ignore */ sharedFile.href),
  () => ({}),
);

const AT = '2026-10-01T05:00:00.000Z';
const SOURCE = 'sku,expected,counted,unitCost\nA,10,10,\nB,8,6,3.75\nC,5,5,\n';
const REPORT = '# Inventory reconciliation\nB is the sole discrepancy: 8 expected, 6 counted.\n23 expected, 21 counted; shortage 2 units at $3.75, worth $7.50.\nNo inventory system was updated.\n';
const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

const fallbackProfile = evaluationProfile({
  profileId: 'agent.inventory-reconciliation', revision: 1, purpose: 'source-support',
  questions: ['sole-discrepancy', 'totals', 'shortage', 'no-inventory-update'].map(id =>
    booleanQuestion({ id, instructions: `Check ${id} against the selected synthetic rows and report.` })),
});
const profile = (contractModule.INVENTORY_REVIEW_PROFILE ?? fallbackProfile) as EvaluationProfile;
const principal = localHarnessPrincipal('p');
const reference: PrincipalRef = {
  kind: 'local-owner', id: 'synthetic-owner', tenantId: null,
  mintedAt: { identity: 1, principal: 1 },
};
const authority: Authority = {
  principal: { kind: 'local-owner', id: reference.id, tenantId: null, projectId: 'p', deviceId: null, sessionId: null, slotId: null },
  generation: reference.mintedAt, assurance: 'owner-local',
  capabilities: new Set(['project.read', 'egress.send', 'egress.reconcile']),
  expiresAt: null, synthetic: false, resolvedAt: AT,
};
const capability: CapabilityManifest = {
  id: 'agent-review-fixture', version: '1', label: 'Synthetic root', description: 'Task review fixture',
  tools: [], requestedPermissions: ['write-project-file'], approvalPolicy: 'show-first',
  maxTurns: 12, supportedPlatforms: ['win32'],
};
const label = {
  tenantId: 'local', projectId: 'p', integrity: 'untrusted' as const,
  confidentiality: 'restricted' as const, provenance: ['synthetic.csv'],
};
const answer = {
  answers: Object.fromEntries(profile.questions.map(question => [question.id, { type: 'boolean', probability: 0.95 }])),
  usage: { inputTokens: 200, outputTokens: 20 },
  response: { modelId: 'typesafe/jev-1.13', id: 'scripted-request' }, warnings: [],
};
const freshGrant = () => ({
  version: 1 as const, grantId: 'review-one', revocationId: 'review-revocation', revocationRevision: 1,
  rootRunId: 'root', rootJobId: `job-${'a'.repeat(40)}`, tenantId: 'local', projectId: 'p', taskId: 'task',
  principalId: principal.id, identityGeneration: principal.identityGeneration,
  profileId: profile.profileId, profileRevision: profile.revision, profileDigest: profileDigest(profile),
  route: { provider: 'openrouter' as const, connectionId: 'synthetic-or', modelId: 'typesafe/jev-1.13' as const },
  account: { id: 'synthetic-account', revision: 1, digest: sha256('synthetic-account') },
  dataPolicyDigest: digest({ only: ['TypeSafe'], allow_fallbacks: false, require_parameters: true, data_collection: 'deny', zdr: true }),
  sources: [{ sourceId: 'synthetic.csv', digest: sha256(SOURCE) }], reportDigest: sha256(REPORT), maxCalls: 1 as const,
});
type Grant = ReturnType<typeof freshGrant>;
type Material = { sources: { sourceId: string; text: string; label: typeof label }[]; report: { text: string; label: typeof label } };
type ReviewInput = {
  runtime: RunService; runId: string; owner: string; principal: HarnessPrincipal;
  grant: Grant; host: unknown; observedAt: string;
};

async function setup(portOverride?: EvaluationPort) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'diomedes-agent-review-'));
  cleanups.push(() => fs.rm(dir, { recursive: true, force: true }));
  const runtime = new RunService(new FileRunStore(path.join(dir, 'runs')), { clock: () => 1_000, authorizeEgress: async () => undefined });
  await runtime.start({ id: 'root', tenantId: 'local', projectId: 'p', taskId: 'task', capability, principal,
    input: { rootRunId: 'root' }, budget: { units: 20, modelCalls: 5, toolCalls: 5, wallMs: null } });
  await runtime.claim('root', 'host', 60_000);
  const ledger = new SpendExposure(dir);
  await ledger.init();
  await ledger.setCap('synthetic-or', micro(1_000_000), { approvedBy: 'synthetic-owner', note: 'Scripted test only.' });
  const scopedLedger = ledger.forJob({ id: freshGrant().rootJobId, capMicroUsd: micro(1_000) });
  const script = scriptedEvaluationPort({ result: answer, requestedModel: 'typesafe/jev-1.13' });
  const port: EvaluationPort = portOverride ?? { ...script, id: 'openrouter-evaluation', limits: { maxTotalTokens: 5_000, maxStatePlusLongestQuestionTokens: 5_000 } };
  let admitted: Grant | null = freshGrant();
  let currentProfile = profile;
  let material: Material = { sources: [{ sourceId: 'synthetic.csv', text: SOURCE, label }], report: { text: REPORT, label } };
  const phases: string[] = [];
  const host = {
    scopedLedger,
    currentAuthority: async () => authority,
    resolveAdmission: async (_grantId: string, phase: string) => {
      phases.push(phase);
      return admitted ? { grant: admitted, authorityRef: reference, dataPolicyDigest: admitted.dataPolicyDigest } : null;
    },
    resolveProfile: async () => currentProfile,
    resolveMaterial: async () => material,
    resolveTransport: async (request: { grant: Grant; stepId: string; stateDigest: string; maxInputTokens: number }) => ({
      port, ledger: scopedLedger,
      binding: {
        grantId: request.grant.grantId, rootRunId: 'root', projectId: 'p', taskId: 'task', rootJobId: freshGrant().rootJobId,
        stepId: request.stepId, route: 'openrouter' as const, connectionId: 'synthetic-or', modelId: 'typesafe/jev-1.13' as const,
        accountId: 'synthetic-account', accountRevision: 1, accountDigest: sha256('synthetic-account'),
        dataPolicyDigest: request.grant.dataPolicyDigest, maxInputTokens: 5_000, maxCalls: 1 as const,
      },
    }),
  };
  const run = async (over: Partial<Pick<ReviewInput, 'grant' | 'runId' | 'principal'>> = {}) => {
    expect(reviewModule.recordAgentReview, 'the task-scoped review wrapper must exist').toBeTypeOf('function');
    return (reviewModule.recordAgentReview as (input: ReviewInput) => Promise<unknown>)({ runtime, runId: 'root', owner: 'host', principal, grant: freshGrant(), host, observedAt: AT, ...over });
  };
  return { runtime, ledger, script, port, host, phases, run,
    setAdmission: (value: Grant | null) => { admitted = value; },
    setProfile: (value: EvaluationProfile) => { currentProfile = value; },
    setMaterial: (value: Material) => { material = value; },
  };
}

describe('fixed inventory evaluation', () => {
  test('checks B only, totals 23/21, two units at $3.75 worth $7.50, and no inventory update', () => {
    expect(contractModule.INVENTORY_REVIEW_PROFILE, 'a bounded inventory profile must be exported').toBeDefined();
    const fixed = contractModule.INVENTORY_REVIEW_PROFILE as EvaluationProfile;
    expect(fixed.purpose).toBe('source-support');
    expect(fixed.questions.map(question => question.id)).toEqual(['sole-discrepancy', 'totals', 'shortage', 'no-inventory-update']);
    expect(fixed.questions.every(question => question.type === 'boolean')).toBe(true);
    const instructions = fixed.questions.map(question => question.instructions).join('\n');
    for (const text of ['A', 'B', 'C', '10', '8', '6', '5', '23', '21', '2', '$3.75', '$7.50']) expect(instructions).toContain(text);
    expect(instructions).toMatch(/sole discrepancy/i);
    expect(instructions).toMatch(/no inventory system was updated/i);
    expect(Object.isFrozen(fixed)).toBe(true);
  });

  test('sends only selected source bytes and report and records a one-attempt external model step', async () => {
    const f = await setup();
    f.setMaterial({ sources: [{ sourceId: 'synthetic.csv', text: SOURCE, label }], report: { text: REPORT, label },
      ...{ unrelatedMail: 'DO-NOT-DISCLOSE-TEAM-HISTORY', credentials: 'DO-NOT-DISCLOSE-KEY' } });
    await f.run();
    expect(f.script.calls[0].state).toEqual({ sources: [{ sourceId: 'synthetic.csv', text: SOURCE }], report: REPORT });
    const root = await f.runtime.get('root');
    const step = root.steps.find(item => item.intent.kind === 'model')!;
    expect(step.intent).toMatchObject({ destination: 'external', effect: 'read', maxAttempts: 1, permission: EVALUATION_PERMISSION });
    expect(step.intent.stepId).toBe(evaluationStepId(profile, f.script.calls[0].state));
    expect(JSON.stringify(root)).not.toContain('DO-NOT-DISCLOSE');
    expect(JSON.stringify(step.intent)).not.toContain(REPORT);
    expect(root.principal.capabilities).toEqual(['write-project-file']);
    expect(root.approvals).toHaveLength(0);
    expect(root.state).not.toBe('completed');
  });
});

describe('current scope, not cached configuration', () => {
  test('exports the task wrapper and its dedicated egress authorizer', () => {
    expect(reviewModule.recordAgentReview).toBeTypeOf('function');
    expect(reviewModule.authorizeAgentReviewStep).toBeTypeOf('function');
  });

  test('refuses a revoked grant before the provider can receive data', async () => {
    const f = await setup(); f.setAdmission(null);
    await expect(f.run()).rejects.toMatchObject({ code: 'review_admission_revoked' });
    expect(f.script.calls).toHaveLength(0);
  });

  test('refuses a reworded profile even when its id and revision are unchanged', async () => {
    const f = await setup();
    f.setProfile({ ...profile, questions: profile.questions.map((question, index) => index ? question : { ...question, instructions: 'Approve unrelated stock changes.' }) });
    await expect(f.run()).rejects.toMatchObject({ code: 'review_profile_changed' });
    expect(f.script.calls).toHaveLength(0);
  });

  test.each(['source', 'report'])('refuses changed %s bytes', async what => {
    const f = await setup();
    f.setMaterial({ sources: [{ sourceId: 'synthetic.csv', text: what === 'source' ? `${SOURCE}D,1,0,9\n` : SOURCE, label }],
      report: { text: what === 'report' ? `${REPORT}Inventory updated.\n` : REPORT, label } });
    await expect(f.run()).rejects.toMatchObject({ code: what === 'source' ? 'review_source_changed' : 'review_report_changed' });
    expect(f.script.calls).toHaveLength(0);
  });

  test('refuses a changed account under the same saved grant', async () => {
    const f = await setup(); const grant = freshGrant();
    f.setAdmission({ ...grant, account: { ...grant.account, revision: 2 } });
    await expect(f.run()).rejects.toMatchObject({ code: 'review_grant_changed' });
    expect(f.script.calls).toHaveLength(0);
  });

  test('cannot revive a revoked Trust reference through a still-active selection', async () => {
    const f = await setup();
    f.host.currentAuthority = async () => denial(409, 'generation-advanced', 'Synthetic owner revoked in flight.') as unknown as Authority;
    await expect(f.run()).rejects.toMatchObject({ code: 'review_authority_denied' });
    expect(f.script.calls).toHaveLength(0);
  });

  test('checks revocation again immediately before dispatch', async () => {
    const f = await setup(); const resolve = f.host.resolveTransport;
    f.host.resolveTransport = async request => { const transport = await resolve(request); f.setAdmission(null); return transport; };
    await expect(f.run()).rejects.toMatchObject({ code: 'review_admission_revoked' });
    expect(f.script.calls).toHaveLength(0);
  });

  test('rechecks revocation after an awaited profile or material resolution', async () => {
    const f = await setup();
    f.host.resolveProfile = async () => { f.setAdmission(null); return profile; };
    await expect(f.run()).rejects.toMatchObject({ code: 'review_admission_revoked' });
    expect(f.script.calls).toHaveLength(0);
    expect((await f.runtime.get('root')).used.modelCalls).toBe(0);
  });

  test('a replacement ledger view cannot raise the root budget while context resolves', async () => {
    const f = await setup();
    f.host.resolveProfile = async () => {
      f.host.scopedLedger = f.ledger.forJob({ id: freshGrant().rootJobId, capMicroUsd: micro(2_000) });
      return profile;
    };
    await expect(f.run()).rejects.toMatchObject({ code: 'review_ledger_scope' });
    expect(f.script.calls).toHaveLength(0);
    expect(f.ledger.list('synthetic-or')).toHaveLength(0);
  });

  test('rechecks the disclosure label after transport resolution even with identical bytes', async () => {
    const f = await setup(); const resolve = f.host.resolveTransport;
    f.host.resolveTransport = async request => {
      const transport = await resolve(request);
      const changedLabel = { ...label, provenance: ['changed-source-policy'] };
      f.setMaterial({ sources: [{ sourceId: 'synthetic.csv', text: SOURCE, label: changedLabel }], report: { text: REPORT, label: changedLabel } });
      return transport;
    };
    await expect(f.run()).rejects.toMatchObject({ code: 'review_policy_changed' });
    expect(f.script.calls).toHaveLength(0);
  });

  test('rejects a late result after revocation', async () => {
    let revoke: () => void = () => undefined;
    const scripted = scriptedEvaluationPort({ result: answer, requestedModel: 'typesafe/jev-1.13' });
    const f = await setup({ ...scripted, id: 'openrouter-evaluation', async evaluate(call) { const raw = await scripted.evaluate(call); revoke(); return raw; } });
    revoke = () => f.setAdmission(null);
    await expect(f.run()).rejects.toMatchObject({ code: 'review_admission_revoked' });
    expect(scripted.calls).toHaveLength(1);
    expect((await f.runtime.get('root')).steps.filter(step => step.intent.kind === 'model').every(step => step.state !== 'succeeded')).toBe(true);
  });
});

describe('bounded payload and transport', () => {
  test('counts every serialized question and UTF-8 byte in the 5,000-token bound', async () => {
    const f = await setup(); const largeReport = '界'.repeat(1_500); const grant = { ...freshGrant(), reportDigest: sha256(largeReport) };
    const state = { sources: [{ sourceId: 'synthetic.csv', text: SOURCE }], report: largeReport };
    expect(serializedStateTokens(state)).toBeLessThan(5_000);
    expect(serializedRequestTokens(state, providerQuestions(profile)).total).toBeGreaterThan(5_000);
    f.setAdmission(grant); f.setMaterial({ sources: [{ sourceId: 'synthetic.csv', text: SOURCE, label }], report: { text: largeReport, label } });
    await expect(f.run({ grant })).rejects.toMatchObject({ code: 'review_request_too_large' });
    expect(f.script.calls).toHaveLength(0);
  });

  test('refuses an unscoped raw SDK port instead of minting another budget', async () => {
    const f = await setup(); const resolve = f.host.resolveTransport;
    f.host.resolveTransport = async request => ({ ...await resolve(request), ledger: f.ledger });
    await expect(f.run()).rejects.toMatchObject({ code: 'review_ledger_scope' });
    expect(f.script.calls).toHaveLength(0);
  });

  test('refuses transport account or data-policy drift', async () => {
    const f = await setup(); const resolve = f.host.resolveTransport;
    f.host.resolveTransport = async request => { const transport = await resolve(request); return { ...transport, binding: { ...transport.binding, dataPolicyDigest: sha256('looser-policy') } }; };
    await expect(f.run()).rejects.toMatchObject({ code: 'review_transport_binding' });
    expect(f.script.calls).toHaveLength(0);
  });
});

describe('the dedicated host egress seam', () => {
  test('cannot admit an AWS lead intent as the selected Jev evaluation', async () => {
    const f = await setup(); await f.run();
    expect(reviewModule.authorizeAgentReviewStep, 'a task-bound review egress check must exist').toBeTypeOf('function');
    const step = (await f.runtime.get('root')).steps.find(item => item.intent.kind === 'model')!;
    const authorize = reviewModule.authorizeAgentReviewStep as (input: Record<string, unknown>) => Promise<void>;
    await expect(authorize({ runtime: f.runtime, runId: 'root', principal, grant: freshGrant(), host: f.host, phase: 'dispatch',
      intent: { ...step.intent, input: { ...(step.intent.input as object), requestedModel: 'aws.kimi-k3' } } })).rejects.toMatchObject({ code: 'review_intent_mismatch' });
    expect(f.script.calls).toHaveLength(1);
  });

  test('result egress re-resolves authority without sending another provider request', async () => {
    const f = await setup(); await f.run();
    expect(reviewModule.authorizeAgentReviewStep).toBeTypeOf('function');
    const intent = (await f.runtime.get('root')).steps.find(item => item.intent.kind === 'model')!.intent;
    const authorize = reviewModule.authorizeAgentReviewStep as (input: Record<string, unknown>) => Promise<void>;
    await authorize({ runtime: f.runtime, runId: 'root', principal, grant: freshGrant(), host: f.host, phase: 'dispatch', intent });
    f.setAdmission(null);
    await expect(authorize({ runtime: f.runtime, runId: 'root', principal, grant: freshGrant(), host: f.host, phase: 'result', intent })).rejects.toMatchObject({ code: 'review_admission_revoked' });
    expect(f.script.calls).toHaveLength(1);
  });
});

describe('one root review and no inherited permission', () => {
  test('a caller cannot add the helper capability to its root principal', async () => {
    const f = await setup();
    await expect(f.run({ principal: { ...principal, capabilities: [...principal.capabilities, EVALUATION_PERMISSION] } }))
      .rejects.toMatchObject({ code: 'review_principal_scope' });
    expect(f.script.calls).toHaveLength(0);
    expect((await f.runtime.get('root')).principal.capabilities).toEqual(['write-project-file']);
  });

  test('identical replay returns the durable observation without another send', async () => {
    const f = await setup(); const first = await f.run(); const second = await f.run();
    expect(second).toEqual(first);
    expect(f.script.calls).toHaveLength(1);
    expect((await f.runtime.get('root')).used.modelCalls).toBe(1);
    expect(f.phases).toContain('result');
  });

  test('a fresh grant for changed report cannot consume a second distinct review', async () => {
    const f = await setup(); await f.run(); const text = `${REPORT}A second version.\n`;
    const second = { ...freshGrant(), grantId: 'review-two', revocationId: 'review-revocation-two', reportDigest: sha256(text) };
    f.setAdmission(second); f.setMaterial({ sources: [{ sourceId: 'synthetic.csv', text: SOURCE, label }], report: { text, label } });
    await expect(f.run({ grant: second })).rejects.toMatchObject({ code: 'intent_mismatch' });
    expect(f.script.calls).toHaveLength(1);
    expect((await f.runtime.get('root')).used.modelCalls).toBe(1);
  });

  test.each(['team', 'h14'])('a %s child cannot inherit the root review grant', async childKind => {
    const f = await setup(); const child = `child-${childKind}`;
    await f.runtime.start({ id: child, tenantId: 'local', projectId: 'p', taskId: 'child-task', capability, principal,
      input: { rootRunId: 'root', parent: { runId: 'root' } }, budget: { units: 3, modelCalls: 1, toolCalls: 1, wallMs: null } });
    await f.runtime.claim(child, 'host', 60_000);
    await expect(f.run({ runId: child })).rejects.toMatchObject({ code: 'review_root_scope' });
    expect(f.script.calls).toHaveLength(0);
    expect((await f.runtime.get(child)).principal.capabilities).not.toContain(EVALUATION_PERMISSION);
  });

  test('rebinding the grant to a child still refuses its parent/root metadata', async () => {
    const f = await setup(); const child = 'rebound-child';
    await f.runtime.start({ id: child, tenantId: 'local', projectId: 'p', taskId: 'child-task', capability, principal,
      input: { rootRunId: 'root', parent: { runId: 'root' } }, budget: { units: 3, modelCalls: 1, toolCalls: 1, wallMs: null } });
    await f.runtime.claim(child, 'host', 60_000);
    const grant = { ...freshGrant(), rootRunId: child, taskId: 'child-task' };
    f.setAdmission(grant);
    await expect(f.run({ grant, runId: child })).rejects.toMatchObject({ code: 'review_child_scope' });
    expect(f.script.calls).toHaveLength(0);
    expect((await f.runtime.get(child)).used.modelCalls).toBe(0);
  });

  test('unknown provider outcomes park the recorded attempt and refuse resend', async () => {
    const scripted = scriptedEvaluationPort({ failWith: new Error('Unknown nonstreaming provider outcome'), requestedModel: 'typesafe/jev-1.13' });
    const f = await setup({ ...scripted, id: 'openrouter-evaluation' });
    await expect(f.run()).rejects.toThrow(/Unknown/);
    await expect(f.run()).rejects.toMatchObject({ code: 'review_reconciliation_required' });
    expect(scripted.calls).toHaveLength(1);
    const step = (await f.runtime.get('root')).steps.find(item => item.intent.kind === 'model')!;
    expect(step.state).toBe('reconcile_required');
    expect(step.attempt).toBe(1);
  });

  test('Stop prevents accepting a late answer or resending it', async () => {
    let stop: () => Promise<void> = async () => undefined;
    const scripted = scriptedEvaluationPort({ result: answer, requestedModel: 'typesafe/jev-1.13' });
    const f = await setup({ ...scripted, id: 'openrouter-evaluation', async evaluate(call) { const raw = await scripted.evaluate(call); await stop(); return raw; } });
    stop = () => f.runtime.cancel('root', 'Synthetic Stop', principal);
    await expect(f.run()).rejects.toThrow();
    await expect(f.run()).rejects.toMatchObject({ code: 'run_cancelled' });
    expect(scripted.calls).toHaveLength(1);
    expect((await f.runtime.get('root')).state).toBe('cancelled');
  });
});
