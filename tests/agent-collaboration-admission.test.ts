/** Offline composition admission. Real Store, Trust resolver and AccountAgentGate; no provider. */
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import express from 'express';
import { Store } from '../server/store.js';
import { AccountAgentGate } from '../server/accounts/agent-gate.js';
import * as loopHost from '../server/harness/capabilities/native-loop.js';
import { currentAuthority, disablePrototypeAuthority, enablePrototypeAuthority, isDenial, refOf, revoke } from '../server/trust/index.js';
import { __resetRevocationState } from '../server/trust/revocation.js';
import { digest } from '../server/harness/policy.js';
import { mountNativeLoopRoutes } from '../server/native-loop-routes.js';
import { ApiError } from '../server/paths.js';
import { RunService } from '../server/harness/run-service.js';
import { FileRunStore } from '../server/harness/run-store.js';

const SOURCE = 'A 10/10\nB 8/6 at $3.75\nC 5/5\n';
const ROOT_JOB_KEY = 'job-1111111111111111111111111111111111111111';
const sha = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');
let dir: string, store: Store, projectId: string, taskId: string, authorityRef: any;
let entitled: boolean, lead: any, member: any, helper: any, admissionSnapshot: any;
let gate: AccountAgentGate;

function factory(overrides: Record<string, unknown> = {}) {
  const create = (loopHost as any).createAgentCollaboration;
  expect(create, 'native host composes admitted persistent Team work').toBeTypeOf('function');
  const host = create({
    store, agentGate: gate, currentAuthority, allowPrototypeAuthority: true,
    authorityRef: async () => authorityRef,
    rootAdmission: async () => structuredClone(admissionSnapshot),
    resolveTeamBinding: async (_projectId: string, slotId: string) => structuredClone(slotId === 'lead' ? lead : member),
    resolveHelperBinding: async () => structuredClone(helper),
    ownedTeam: { registry: () => { throw new Error('admission never opens tools'); }, ownedChildren: () => [], stopRoot: async () => {}, recoverRoot: async () => {} },
    ...overrides,
  });
  const admit = host.admit.bind(host);
  host.admit = async (...args: any[]) => { admissionSnapshot = await admit(...args); return admissionSnapshot; };
  return host;
}
const request = (overrides: Record<string, unknown> = {}) => ({
  projectId, taskId, rootRunId: 'agent-root', rootJobId: ROOT_JOB_KEY, commandId: 'inventory-start',
  principal: { id: 'native-lead', tenantId: 'local', projectId, capabilities: ['write-project-file'], identityGeneration: 1 },
  route: lead.route, model: lead.model, accountRoute: lead.accountRoute,
  sources: ['inventory.txt'], consent: true,
  persistentTeam: { leadSlotId: 'lead', memberSlotId: 'member' },
  helperProfileId: 'helper-profile', ...overrides,
});
function binding(slotId: string, role: 'lead' | 'member') {
  return { slotId, role, agentId: 'diomedes.general', createdAt: '2026-10-01T00:00:00Z', threadId: `${slotId}-thread`,
    route: role === 'lead' ? 'aws-bedrock' : 'openrouter', model: role === 'lead' ? 'kimi-k3' : 'openai/gpt-6.1-sol',
    accountRoute: `${role === 'lead' ? 'aws-bedrock' : 'openrouter'}:${slotId}@r1`, effort: 'medium',
    profile: { id: `${slotId}-profile`, revision: 1, digest: digest(slotId) } };
}
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'diomedes-agent-admission-'));
  store = new Store(path.join(dir, 'data'), path.join(dir, 'projects')); await store.init();
  projectId = (await store.locked(() => store.createProject('Synthetic inventory'))).id;
  await fs.writeFile(path.join(store.state(projectId).project.folder, 'inventory.txt'), SOURCE);
  taskId = await store.locked(async () => { const state = store.state(projectId); const task = store.createTask(state, { name: 'Reconcile inventory' }); await store.persist(state); return task.id; });
  store.state(projectId).cloudSharing = { version: 1, routes: ['aws-bedrock', 'openrouter'], documents: ['inventory.txt'], shareConversationHistory: false, shareReviewPackets: false };
  lead = binding('lead', 'lead'); member = binding('member', 'member');
  helper = { route: 'openrouter', model: 'openai/gpt-6.1-sol', accountRoute: 'openrouter:member@r1', effort: 'medium', profile: { id: 'helper-profile', revision: 1, digest: digest('helper') } };
  store.state(projectId).team = { members: [
    { slotId: 'lead', name: 'Lead', role: 'lead', engine: lead.route, model: lead.model, status: 'idle', threadId: lead.threadId, createdAt: lead.createdAt, lastSeenAt: null },
    { slotId: 'member', name: 'Member', role: 'member', engine: member.route, model: member.model, status: 'idle', threadId: member.threadId, createdAt: member.createdAt, lastSeenAt: null },
  ], messages: [], runs: [] } as any;
  enablePrototypeAuthority({ label: 'agent-admission-fixture', capabilities: ['egress.send', 'egress.reconcile', 'project.read'] });
  const authority = await currentAuthority({ via: 'prototype-driver', label: 'agent-admission-fixture' });
  if (isDenial(authority)) throw new Error(authority.reason);
  authorityRef = refOf(authority); entitled = true; admissionSnapshot = null;
  gate = new AccountAgentGate({
    personalIncludes: () => entitled, personalUnknown: () => false, agentPlan: () => entitled ? 'paid' : 'free',
    admitAgent: async () => ({ admitted: true, admissionId: 'fixture-paid-admission', organizationId: null, personId: 'fixture-person', planId: 'individual', policyRevision: 1, validUntil: '2099-01-01T00:00:00Z' }),
  } as any, { projectOwner: () => null, active: () => ({ kind: 'personal' }) } as any);
});
afterEach(async () => { disablePrototypeAuthority(); __resetRevocationState(); await fs.rm(dir, { recursive: true, force: true }); });

describe('persistent Team admission', () => {
  test('production defaults reject the explicitly armed synthetic driver', async () => {
    await expect(factory({ allowPrototypeAuthority: false }).admit(request())).rejects.toThrow(/synthetic|authority/i);
  });
  test('an authority in a different tenant cannot admit or revive the root', async () => {
    await expect(factory({ currentAuthority: async (claim: Parameters<typeof currentAuthority>[0]) => {
      const authority = await currentAuthority(claim);
      return isDenial(authority) ? authority : { ...authority, principal: { ...authority.principal, tenantId: 'different-tenant' } };
    } }).admit(request())).rejects.toThrow(/authority|differs/i);
  });
  test('pins real member identity, profile revision, exact route/model/effort/account and source bytes', async () => {
    const admitted = await factory().admit(request());
    expect(admitted.rootJobId).toBe(ROOT_JOB_KEY);
    expect(admitted.persistentTeam).toMatchObject({ rootRunId: 'agent-root', commandId: 'inventory-start', projectId, taskId,
      lead, member, sources: [{ path: 'inventory.txt', sha256: sha(SOURCE) }], maxModelCalls: 6, maxResponses: 1 });
    expect(admitted.helper).toEqual(helper);
    expect(admitted.authorityRef).toEqual(authorityRef);
  });
  test('missing paid Agent entitlement refuses before an adapter or owned child can open', async () => {
    entitled = false;
    await expect(factory().admit(request())).rejects.toMatchObject({ code: 'AGENT_NOT_INCLUDED' });
  });
  test('a managed lead and repeated selected slot are refused', async () => {
    await expect(factory().admit(request({ route: 'nectovia' }))).rejects.toThrow(/single-agent|managed/i);
    await expect(factory().admit(request({ persistentTeam: { leadSlotId: 'lead', memberSlotId: 'lead' } }))).rejects.toThrow(/different|distinct/i);
  });
  test('a stopped member or mismatching selected lead route is refused', async () => {
    store.state(projectId).team!.members[1].status = 'stopped';
    await expect(factory().admit(request())).rejects.toThrow(/stopped|membership/i);
    store.state(projectId).team!.members[1].status = 'idle';
    await expect(factory().admit(request({ model: 'another-model' }))).rejects.toThrow(/lead|model/i);
  });
  test('source sharing is checked for every selected route by the real sharing guard', async () => {
    store.state(projectId).cloudSharing!.routes = ['aws-bedrock'];
    await expect(factory().admit(request())).rejects.toThrow(/shar/i);
  });
  test.each(process.platform === 'win32' ? ['Harness report.md', 'harness report.md'] : ['Harness report.md'])('the immutable sources cannot include the fixed native report output %s', async (source) => {
    await expect(factory().admit(request({ sources: [source] }))).rejects.toThrow(/output.*source|source.*output/i);
  });
  test.each(['profile', 'accountRoute', 'effort'] as const)('changed member %s cannot revive admitted authority', async (field) => {
    const host = factory(); const admitted = await host.admit(request());
    if (field === 'profile') member.profile = { ...member.profile, revision: 2 };
    else member[field] = field === 'effort' ? 'high' : 'openrouter:another@r2';
    await expect(host.resolveTeamGrant(admitted.persistentTeam, 'dispatch')).rejects.toThrow(/changed|admission|binding/i);
  });
  test('changed source bytes, revoked sharing and paid access fail at result as well as dispatch', async () => {
    const host = factory(); const admitted = await host.admit(request());
    await fs.writeFile(path.join(store.state(projectId).project.folder, 'inventory.txt'), `${SOURCE}changed`);
    await expect(host.resolveTeamGrant(admitted.persistentTeam, 'result')).rejects.toThrow(/source|changed/i);
    await fs.writeFile(path.join(store.state(projectId).project.folder, 'inventory.txt'), SOURCE);
    store.state(projectId).cloudSharing!.documents = [];
    await expect(host.resolveTeamGrant(admitted.persistentTeam, 'result')).rejects.toThrow(/shar/i);
    store.state(projectId).cloudSharing!.documents = ['inventory.txt']; entitled = false;
    await expect(host.resolveTeamGrant(admitted.persistentTeam, 'result')).rejects.toMatchObject({ code: 'AGENT_NOT_INCLUDED' });
  });
  test('a revoked real Trust reference rejects an in-flight result without refreshing the reference', async () => {
    const host = factory(); const admitted = await host.admit(request());
    await revoke({ kind: authorityRef.kind, id: authorityRef.id }, 'fixture revocation during a call');
    await expect(host.resolveTeamGrant(admitted.persistentTeam, 'result')).rejects.toThrow(/revok|generation|authority/i);
  });
  test('an unqualified Jev selection refuses and renderer cannot provide grant or cap fields', async () => {
    await expect(factory().admit(request({ review: { profileId: 'agent.inventory-reconciliation', connectionId: 'or-1' } }))).rejects.toThrow(/review|qualif/i);
    await expect(factory().admit(request({ persistentTeam: { leadSlotId: 'lead', memberSlotId: 'member', maxModelCalls: 99 } }))).rejects.toThrow(/selection|schema|field/i);
  });
  test.each([
    { name: 'missing Team response', role: 'member', child: 'missing' },
    { name: 'missing H14 helper', role: 'helper', child: 'missing' },
    { name: 'running H14 helper', role: 'helper', child: 'running' },
    { name: 'completed helper from another root', role: 'helper', child: 'prior-root' },
  ])('review and proposal refuse $name before pinning or disclosing report bytes', async ({ role, child }) => {
    const runtime = new RunService(new FileRunStore(path.join(dir, 'runs')));
    let reviewCalls = 0;
    const host = factory({ runs: runtime, review: {
      admit: async (selected: any, sources: { path: string; sha256: string }[]) => ({
        version: 1, grantId: 'fixture-review-grant', revocationId: 'fixture-review-revocation', revocationRevision: 1,
        rootRunId: selected.rootRunId, rootJobId: selected.rootJobId, tenantId: selected.principal.tenantId,
        projectId: selected.projectId, taskId: selected.taskId, principalId: selected.principal.id, identityGeneration: selected.principal.identityGeneration,
        profileId: 'agent.inventory-reconciliation', profileRevision: 1, profileDigest: digest('fixture-review-profile'),
        route: { provider: 'openrouter', connectionId: 'or-fixture', modelId: 'typesafe/jev-1.13' },
        account: { id: 'fixture-account', revision: 1, digest: digest('fixture-account') }, dataPolicyDigest: digest('fixture-data-policy'),
        sources: sources.map(source => ({ sourceId: source.path, digest: source.sha256 })), maxCalls: 1,
      }),
      host: async () => { reviewCalls++; throw new Error('Report disclosure must not be reached.'); },
    } });
    const admitted = await host.admit(request({
      persistentTeam: role === 'member' ? { leadSlotId: 'lead', memberSlotId: 'member' } : null,
      helperProfileId: role === 'helper' ? 'helper-profile' : null,
      review: { profileId: 'agent.inventory-reconciliation', connectionId: 'or-fixture' },
    }));
    const principal = admitted.principal;
    const capability = { id: 'diomedes-loop', version: '1', label: 'Offline native root', description: 'Actual runtime role-order refusal',
      tools: [], requestedPermissions: principal.capabilities, approvalPolicy: 'show-first' as const, maxTurns: 12,
      supportedPlatforms: ['win32', 'darwin', 'linux'] };
    const budget = { units: 70, modelCalls: 14, toolCalls: 12, wallMs: null };
    await runtime.start({ id: admitted.rootRunId, tenantId: principal.tenantId, projectId, taskId, principal, capability,
      budget, input: { v: 1, kind: 'diomedes-loop', collaboration: admitted, rootJobId: ROOT_JOB_KEY } });
    await runtime.claim(admitted.rootRunId, 'native-host', 60_000);
    if (child !== 'missing') {
      await runtime.start({ id: 'h14-helper', tenantId: principal.tenantId, projectId, taskId, principal,
        capability: { ...capability, id: 'diomedes-loop-worker' }, budget,
        input: { parent: { runId: child === 'prior-root' ? 'prior-root' : admitted.rootRunId }, route: helper.route, model: helper.model, accountRoute: helper.accountRoute } });
      await runtime.claim('h14-helper', 'helper-host', 60_000);
      await runtime.step('h14-helper', 'helper-host',
        { id: 'prepare-helper', version: '1', kind: 'transform', effect: 'pure', cost: 0 }, () => ({ prepared: true }), principal);
      if (child === 'prior-root') await runtime.complete('h14-helper', 'helper-host', { text: 'An earlier root answered.' });
      await runtime.step(admitted.rootRunId, 'native-host',
        { id: 'workers:0', version: '1', kind: 'transform', effect: 'pure', cost: 0, input: { handoffs: [{ childRunId: 'h14-helper' }] } },
        () => ({ handoffs: [{ childRunId: 'h14-helper' }] }), principal);
    }
    const run = await runtime.get(admitted.rootRunId);
    const port = host.forRun(run, 'native-host', principal);
    const context = { runId: run.id, owner: 'native-host', principal, stepId: 'review:0', name: 'review_report', input: {}, output: null, text: 'B is short 2 units.' };
    const reason = role === 'member' ? /persistent Team response.*missing/ : /distinct H14 helper.*not completed/;
    await expect(port.review(context)).rejects.toThrow(reason);
    await expect(port.beforeTool({ ...context, name: 'propose_write', input: { text: context.text } })).rejects.toThrow(reason);
    expect(reviewCalls).toBe(0);
    expect((await runtime.get(run.id)).steps.some(step => step.intent.stepId === 'agent-review:grant')).toBe(false);
  });
  test.each(['collaboration', 'automatic request'] as const)('H08 Retry cannot mint a new parent or budget for a root bound to %s', async (binding) => {
    let starts = 0;
    const harness = { redact: (text: string) => text,
      list: async () => [{ id: 'original-root', capabilityId: 'diomedes-loop', sessionId: 'original-session',
        input: { v: 1, kind: 'diomedes-loop', goal: 'Reconcile inventory', route: 'native-fixture', model: null, accountRoute: null,
          maxTurns: 8, instructions: '', sources: ['inventory.txt'], delegate: null,
          collaboration: binding === 'collaboration' ? { rootRunId: 'original-root', rootJobId: ROOT_JOB_KEY } : null } }],
      get: async () => { throw new ApiError(404, 'No new run.'); }, loop: { admit: async () => ({ model: null, accountRoute: null }) },
      bridge: { start: async () => { starts++; return { id: 'new-session' }; } },
    };
    const routes = mountNativeLoopRoutes(express(), store, harness as any, {} as any);
    const result = await routes.retryDriver.retry!({ projectId, session: { id: 'original-session' },
      task: { id: taskId, ...(binding === 'automatic request' ? { automaticWork: { rootRunId: 'original-root', rootJobId: ROOT_JOB_KEY } } : {}) },
      workCommandId: 'retry-bound-root' } as any);
    expect(result).toMatchObject({ refused: { code: 'unsupported' } });
    expect(starts).toBe(0);
  });
});
