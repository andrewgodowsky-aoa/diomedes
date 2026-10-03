/**
 * Scripted inventory answers, qualification and transport only. The Console fixture still
 * uses the real Store, TeamService, RunService, H14, Need approval and H17 verifier.
 * These scripts are evidence of orchestration, never live provider or billing qualification.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { Json, ModelRequest, ModelResult } from '../../shared/harness.js';
import type { TeamMember } from '../../shared/types.js';
import { AWS_KIMI_K3, AWS_KIMI_K3_REFUSAL } from '../../shared/model-api.js';
import { micro } from '../../shared/managed-usage.js';
import { profileDigest } from '../../shared/evaluation.js';
import { AgentProfileStore, profileDigest as agentProfileDigest } from '../../server/agent-profiles.js';
import { digest } from '../../server/harness/policy.js';
import { scriptedEvaluationPort } from '../../server/harness/evaluation-adapter.js';
import { routeContractFor } from '../../server/harness/route-contract.js';
import * as teamModule from '../../server/team/service.js';
import * as loopModule from '../../server/harness/capabilities/native-loop.js';
import { AccountAgentGate } from '../../server/accounts/agent-gate.js';
import { installTrustBackend, isDenial, refOf, requireGenuine, type Principal } from '../../server/trust/index.js';
import type { ResolveHarnessAuthority } from '../../server/harness/trust-port.js';
import type { LoopModelRoutes } from '../../server/harness/capabilities/native-loop.js';
import type { Store } from '../../server/store.js';
import type { RunService } from '../../server/harness/run-service.js';
import type { ModelSessionRuns } from '../../server/harness/model-session-run.js';
import type { SpendExposure } from '../../server/spend-exposure.js';

export const SCRIPTED_SOURCE = 'sku,expected,counted,unitCost\nA,10,10,\nB,8,6,3.75\nC,5,5,\n';
export const SCRIPTED_REPORT = '# Inventory reconciliation (scripted fixture)\nB is the sole discrepancy: 8 expected, 6 counted.\n23 expected, 21 counted; shortage 2 units at $3.75, worth $7.50.\nNo inventory system was updated.\n';
export const SCRIPTED_MEMBER_ANSWER = 'Scripted Team answer: B is the sole discrepancy (8 expected, 6 counted).';
export const SCRIPTED_HELPER_ANSWER = 'Scripted H14 helper answer: 23 expected, 21 counted; 2 units at $3.75 = $7.50.';
export const SCRIPTED_LEAD = 'scripted-inventory-lead';
export const SCRIPTED_MEMBER = 'scripted-inventory-member';
export const SCRIPTED_REVIEW = 'scripted-inventory-review';
export const UNQUALIFIED_K3 = 'unqualified-k3-lead';
export const SCRIPTED_ACCOUNT_ROUTE = 'google-vertex:scripted-inventory@r1';
export const LONG_SOURCE = 'notes/archive/selection-only-inventory-context-with-a-long-machine-readable-file-name.md';
const AT = '2026-10-01T05:00:00.000Z';
const sha = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');
const rawProfileDigest = (value: string): string => {
  const raw = /^(?:sha256:)?([a-f0-9]{64})$/.exec(value)?.[1];
  if (!raw) throw new Error('The current saved profile digest is not a SHA256 pin.');
  return raw;
};

export interface CollaborationFixtureLog {
  calls: { role: 'lead' | 'member' | 'helper' | 'review'; runId: string }[];
  hangMember: boolean;
  hangHelper?: boolean;
}
export interface CollaborationFixtureContext {
  store: Store;
  team: teamModule.TeamService;
  runs: RunService;
  modelSessions: ModelSessionRuns;
  currentAuthority: ResolveHarnessAuthority;
  ownerId: string;
  rootLedger(projectId: string, rawJobId: string, threadId?: string | null): Promise<SpendExposure>;
}

const aborted = (signal: AbortSignal) => new Promise<never>((_resolve, reject) => {
  if (signal.aborted) reject(signal.reason ?? new Error('Scripted Stop'));
  else signal.addEventListener('abort', () => reject(signal.reason ?? new Error('Scripted Stop')), { once: true });
});

function model(log: CollaborationFixtureLog, role: 'lead' | 'member' | 'helper', stop?: AbortSignal) {
  return {
    id: 'fixture', version: 'scripted-inventory-1', destination: 'external' as const,
    contract: routeContractFor('native-fixture'),
    capabilities: () => ({
      engineId: 'fixture', engineVersion: 'scripted-inventory-1', protocolVersion: 'scripted',
      modelCalls: 'enforced' as const, toolCalls: 'enforced' as const, filesystemWrites: 'unsupported' as const,
      networkEgress: 'enforced' as const, approvals: 'enforced' as const, resumability: 'observed' as const,
      cancellability: 'observed' as const, checkpointGranularity: 'step' as const,
      notes: ['Scripted fixture; no provider call or live billing qualification.'],
    }),
    async complete(request: ModelRequest, signal: AbortSignal): Promise<ModelResult> {
      const joined = stop ? AbortSignal.any([signal, stop]) : signal;
      joined.throwIfAborted();
      log.calls.push({ role, runId: request.runId });
      if (role === 'member' && log.hangMember) await aborted(joined);
      if (role === 'helper' && log.hangHelper) await aborted(joined);
      const transcript = {
        providerId: 'fixture', modelId: null,
        lineageId: `scripted-${request.runId}`, opaqueRef: `scripted-${log.calls.length}`,
        prefixHash: `scripted-${request.messages.length}`,
      };
      if (role === 'member') return { response: { type: 'final', text: SCRIPTED_MEMBER_ANSWER }, transcript };
      if (role === 'helper') return { response: { type: 'final', text: SCRIPTED_HELPER_ANSWER }, transcript };
      if (!request.tools.length) return { response: { type: 'final', text: '1. Ask the persistent Team member.\n2. Ask the separate H14 helper.\n3. Review the combined report.\n4. Propose Harness report.md for exact approval and verification.' }, transcript };
      const completed = new Set(request.messages.filter(item => item.role === 'tool').map(item => item.tool ?? item.name));
      const actions: { name: string; input: Json }[] = [
        { name: 'team_task_create', input: { subject: 'Find the discrepant inventory row (scripted)', owner: SCRIPTED_MEMBER } },
        { name: 'team_send_message', input: { to: SCRIPTED_MEMBER, message: 'Scripted request: find the sole discrepancy in inventory.txt.', files: ['inventory.txt'] } },
        { name: 'assign_workers', input: { tasks: [{ task: 'Scripted request: calculate the inventory totals and shortage value.', files: ['inventory.txt'] }] } },
        { name: 'review_report', input: { text: SCRIPTED_REPORT } },
        { name: 'propose_write', input: { text: SCRIPTED_REPORT } },
      ];
      const next = actions.find(action => !completed.has(action.name));
      return { response: next ? { type: 'tool', ...next } : { type: 'final', text: 'Scripted reconciliation proposed in Harness report.md. No inventory system was updated.' }, transcript };
    },
  };
}

export function collaborationModelRoutes(log: CollaborationFixtureLog): LoopModelRoutes {
  return {
    async admit(route, input) {
      if (route !== 'google-vertex') throw new Error('Only the scripted inventory route is qualified in this fixture.');
      return { model: input.model ?? 'scripted-inventory-lead', accountRoute: SCRIPTED_ACCOUNT_ROUTE };
    },
    async adapter(_route, request, stop) { return model(log, request.purpose === 'worker' ? 'helper' : 'lead', stop); },
  };
}

export async function seedCollaboration(store: Store, projectId: string) {
  const state = store.state(projectId);
  await fs.writeFile(path.join(state.project.folder, 'inventory.txt'), SCRIPTED_SOURCE);
  await fs.mkdir(path.dirname(path.join(state.project.folder, LONG_SOURCE)), { recursive: true });
  await fs.writeFile(path.join(state.project.folder, LONG_SOURCE), 'Unselected fixture context; must not enter a child or review.\n');
  await store.locked(async () => {
    const members: TeamMember[] = [
      { slotId: SCRIPTED_LEAD, name: 'Inventory lead (scripted)', role: 'lead', engine: 'google-vertex', model: 'scripted-inventory-lead', status: 'idle', threadId: `${SCRIPTED_LEAD}-thread`, createdAt: AT, lastSeenAt: null },
      { slotId: SCRIPTED_MEMBER, name: 'Inventory member (scripted)', role: 'member', engine: 'google-vertex', model: 'scripted-inventory-member', status: 'idle', threadId: `${SCRIPTED_MEMBER}-thread`, createdAt: AT, lastSeenAt: null },
    ];
    state.team = { members, messages: [], runs: [] };
    for (const member of members) state.conversations.push({
      id: member.threadId!, name: `Thread with ${member.name}`, attachedTo: { kind: 'project', ref: projectId },
      taskId: null, turns: [], createdAt: AT, updatedAt: AT, permission: 'task', mode: 'build',
      helper: { engine: member.engine, model: member.model },
      requested: null,
    });
    await store.persist(state);
  });
}

/** This is a host-only scripted qualifier. The renderer receives IDs and reasons, never grants. */
export async function scriptedCollaborationHost(context: CollaborationFixtureContext, log: CollaborationFixtureLog) {
  const create = (loopModule as unknown as Record<string, any>).createAgentCollaboration;
  const OwnedTeamResponses = (teamModule as unknown as Record<string, any>).OwnedTeamResponses;
  if (typeof create !== 'function' || typeof OwnedTeamResponses !== 'function')
    throw new Error('The actual collaboration host and OwnedTeamResponses must exist before running the scripted journey.');
  const profileModule = await import(/* @vite-ignore */ new URL('../../shared/agent-review.ts', import.meta.url).href);
  const profile = profileModule.INVENTORY_REVIEW_PROFILE;
  // A bounded host fixture for the real Trust resolver. No renderer claim or prototype grant.
  const owner: Principal = { kind: 'local-owner', id: context.ownerId, tenantId: null, projectId: null,
    deviceId: null, sessionId: null, slotId: null };
  installTrustBackend({
    lookupTeamMember: async () => null,
    lookupPrincipalRef: async reference => reference.kind === owner.kind && reference.id === owner.id ? owner : null,
    localOwner: async ownerId => ownerId === owner.id ? owner : null,
  });
  const currentAuthority = context.currentAuthority;
  const authority = requireGenuine(await currentAuthority({ via: 'local-owner', ownerId: context.ownerId }));
  if (isDenial(authority)) throw new Error(authority.reason);
  const authorityRef = refOf(authority);
  const profileStore = new AgentProfileStore(context.store.dataDir);
  const helper = async (profileId?: string) => {
    await profileStore.load();
    const record = profileId ? profileStore.get(profileId) : null;
    const revision = profileId ? record && !record.archivedAt ? record.revisions.at(-1) : null
      : profileStore.list().find(item => item.name === 'Inventory helper (scripted)');
    if (!revision) throw new Error('The scripted helper profile is not saved.');
    return { route: revision.engine, model: revision.model, accountRoute: SCRIPTED_ACCOUNT_ROUTE, effort: revision.effort,
      profile: { id: revision.profileId, revision: revision.revision, digest: rawProfileDigest(agentProfileDigest(revision)) } };
  };
  const teamBinding = async (projectId: string, slotId: string) => {
    const member = context.team.teamState(projectId).members.find(item => item.slotId === slotId);
    if (!member) throw new Error('The selected scripted Team member is not present.');
    const thread = context.store.state(projectId).conversations.find(item => item.id === member.threadId);
    if (!thread?.requested?.profile) throw new Error('Select the scripted member profile through the public thread API.');
    const selected = await helper(thread.requested.profile);
    if (selected.route !== member.engine || selected.model !== member.model)
      throw new Error('The scripted Team member differs from its current saved profile.');
    return { slotId, role: member.role, agentId: member.agentId ?? null, createdAt: member.createdAt, threadId: member.threadId,
      route: member.engine, model: member.model, accountRoute: SCRIPTED_ACCOUNT_ROUTE, effort: selected.effort,
      profile: selected.profile };
  };
  const gate = new AccountAgentGate({
    personalIncludes: () => true, personalUnknown: () => false, agentPlan: () => 'paid',
    admitAgent: async () => ({ admitted: true, admissionId: 'scripted-ui-admission', organizationId: null, personId: 'scripted-ui-owner', planId: 'individual', policyRevision: 1, validUntil: '2099-01-01T00:00:00Z' }),
  } as any, { projectOwner: () => null, active: () => ({ kind: 'personal' }) } as any);
  let host: any;
  const rootLedger = async (rootRunId: string, expectedJobId: string) => {
    const run = await context.runs.get(rootRunId);
    const input = run.input as {
      rootJobId?: string; rootJobRequestId?: string; threadId?: string | null;
    };
    if (!input.rootJobRequestId || input.rootJobId !== expectedJobId)
      throw new Error('The scripted root has no original spend request identity.');
    const ledger = await context.rootLedger(run.projectId, input.rootJobRequestId, input.threadId ?? null);
    if (ledger.jobScope?.id !== expectedJobId) throw new Error('The scripted root spend scope changed.');
    return ledger;
  };
  const ownedTeam = new OwnedTeamResponses({
    store: context.store, team: context.team, runs: context.runs, sessions: context.modelSessions,
    resolveGrant: (grant: unknown, phase: string) => host.resolveTeamGrant(grant, phase),
    resolveGrantLocal: (grant: unknown, phase: string) => host.resolveTeamGrantLocal(grant, phase),
    documents: async (grant: any) => Promise.all(grant.sources.map(async (source: { path: string }) => ({ path: source.path, text: (await context.store.readDocument(grant.projectId, source.path)).text }))),
    admit: async (grant: any) => ({ route: grant.member.route, model: grant.member.model, accountRoute: grant.member.accountRoute, connectionId: 'scripted-inventory', revision: 1 }),
    adapter: async () => model(log, 'member'),
  });
  host = create({
    store: context.store, runs: context.runs, ownedTeam, agentGate: gate, currentAuthority,
    rootLedger: (admission: { rootRunId: string; rootJobId: string }) => rootLedger(admission.rootRunId, admission.rootJobId),
    authorityRef: async () => authorityRef,
    rootAdmission: async (runId: string) => {
      const run = await context.runs.get(runId);
      if (['cancelled', 'failed', 'completed', 'reconcile_required'].includes(run.state)) return null;
      return (run.input as { collaboration?: unknown } | undefined)?.collaboration;
    },
    resolveTeamBinding: teamBinding,
    resolveHelperBinding: (_projectId: string, profileId: string) => helper(profileId),
    offers: async (projectId: string, taskId: string) => {
      const state = context.store.state(projectId);
      if (!state.tasks.some(item => item.id === taskId)) throw new Error('The inventory task is not present.');
      const h14 = await helper();
      const choices = state.team!.members.map(member => ({ slotId: member.slotId, name: member.name, route: member.engine, model: member.model,
        admitted: member.status !== 'stopped', reason: member.status === 'stopped' ? 'This Team member is stopped.' : null }));
      return {
        leads: [...choices.filter(item => item.slotId === SCRIPTED_LEAD), { slotId: UNQUALIFIED_K3, name: 'Kimi K3', route: 'aws-bedrock', model: AWS_KIMI_K3.model, admitted: false, reason: AWS_KIMI_K3_REFUSAL }],
        members: choices.filter(item => item.slotId === SCRIPTED_MEMBER),
        helpers: [{ profileId: h14.profile.id, name: 'Inventory helper (scripted)', route: h14.route, model: h14.model, admitted: true, reason: null }],
        reviews: [{ profileId: 'agent.inventory-reconciliation', name: 'Inventory Jev review (scripted)', connectionId: SCRIPTED_REVIEW, model: 'typesafe/jev-1.13', admitted: true, reason: null }],
      };
    },
    review: {
      admit: async (request: any, sources: any[]) => ({
        version: 1, grantId: `review-${request.rootRunId}`, revocationId: `review-${request.rootRunId}`, revocationRevision: 1,
        rootRunId: request.rootRunId, rootJobId: request.rootJobId, tenantId: 'local', projectId: request.projectId, taskId: request.taskId,
        principalId: request.principal.id, identityGeneration: request.principal.identityGeneration,
        profileId: profile.profileId, profileRevision: profile.revision, profileDigest: profileDigest(profile),
        route: { provider: 'openrouter', connectionId: SCRIPTED_REVIEW, modelId: 'typesafe/jev-1.13' },
        account: { id: 'scripted-ui-account', revision: 1, digest: sha('scripted-ui-account') },
        dataPolicyDigest: sha('scripted-only-no-provider'), sources: sources.map(source => ({ sourceId: source.path, digest: source.sha256 })), maxCalls: 1,
      }),
      host: async (grant: any, reportText: string) => {
        const ledger = await rootLedger(grant.rootRunId, grant.rootJobId);
        if (!ledger.allowance(SCRIPTED_REVIEW)) await ledger.setCap(SCRIPTED_REVIEW, micro(1_000_000), { approvedBy: 'scripted-ui-owner', note: 'Owned offline scripted fixture; no real provider.' });
        const answer = { answers: Object.fromEntries(profile.questions.map((question: { id: string }) => [question.id, { type: 'boolean', probability: 0.95 }])),
          usage: { inputTokens: 200, outputTokens: 0, cost: 0 }, response: { modelId: 'typesafe/jev-1.13', id: `scripted-${grant.rootRunId}` }, warnings: ['Scripted answer; no provider call.'] };
        const scripted = scriptedEvaluationPort({ result: answer, requestedModel: 'typesafe/jev-1.13' });
        const port = { ...scripted, id: 'openrouter-evaluation', limits: { maxTotalTokens: 5_000, maxStatePlusLongestQuestionTokens: 5_000 },
          async evaluate(request: Parameters<typeof scripted.evaluate>[0]) { log.calls.push({ role: 'review', runId: grant.rootRunId }); return scripted.evaluate(request); } };
        const label = { tenantId: 'local', projectId: grant.projectId, integrity: 'untrusted', confidentiality: 'restricted', provenance: ['inventory.txt'] };
        return {
          scopedLedger: ledger, currentAuthority,
          resolveAdmission: async () => ({ grant, authorityRef, dataPolicyDigest: grant.dataPolicyDigest }),
          resolveProfile: async () => profile,
          resolveMaterial: async () => ({ sources: await Promise.all(grant.sources.map(async (source: { sourceId: string }) => ({ sourceId: source.sourceId, text: (await context.store.readDocument(grant.projectId, source.sourceId)).text, label }))), report: { text: reportText, label } }),
          resolveTransport: async (request: any) => ({ port, ledger, binding: { grantId: grant.grantId, rootRunId: grant.rootRunId, projectId: grant.projectId, taskId: grant.taskId, rootJobId: grant.rootJobId,
            stepId: request.stepId, route: 'openrouter', connectionId: SCRIPTED_REVIEW, modelId: 'typesafe/jev-1.13', accountId: grant.account.id, accountRevision: grant.account.revision,
            accountDigest: grant.account.digest, dataPolicyDigest: grant.dataPolicyDigest, maxInputTokens: 5_000, maxCalls: 1 } }),
        };
      },
    },
  });
  return host;
}
