/** Native composition of admitted Team mail, a distinct H14 helper and exact review. */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { agentTeamGrantSchema, agentTeamSelectionSchema, AGENT_TEAM_TOOLS, type AgentTeamBinding, type AgentTeamGrant, type OwnedTeamRun, type OwnedTeamResponseResult } from '../../shared/agent-collaboration.js';
import { agentReviewGrantSchema, agentReviewSelectionSchema, type AgentReviewGrant, type AgentReviewSelection } from '../../shared/agent-review.js';
import type { HarnessPrincipal, HarnessRun, Json, StepIntent } from '../../shared/harness.js';
import type { LoopCollaborationInput, LoopHelperBinding, LoopRunInput } from '../../shared/native-loop.js';
import { isModelApiProvider } from '../../shared/model-api.js';
import type { AgentGatePort } from '../accounts/agent-gate.js';
import { requireCloudSharing } from '../cloud-sharing.js';
import { ApiError, relativeName } from '../paths.js';
import type { SpendExposure } from '../spend-exposure.js';
import type { Store } from '../store.js';
import { isDenial, refOf, requireCapability, requireGenuine, type PrincipalRef } from '../trust/index.js';
import { TEAM_TOOLS } from '../team/tools.js';
import { authorizeAgentReviewStep, recordAgentReview, type AgentReviewHost } from './agent-review.js';
import { EVALUATION_PERMISSION } from './evaluation.js';
import { REPORT_PATH } from './approval.js';
import type { LoopCollaborationPort, LoopToolBinding, LoopToolContext } from './native-loop.js';
import { digest, HarnessError, validatePrincipal } from './policy.js';
import type { RunService } from './run-service.js';
import type { ResolveHarnessAuthority } from './trust-port.js';
import { ToolRegistry } from './tools.js';

const sha = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');
const fail = (message: string): never => { throw new HarnessError('collaboration_refused', message); };
const helperSchema = z.strictObject({
  route: z.string().min(1), model: z.string().min(1), accountRoute: z.string().min(1), effort: z.string().nullable(),
  profile: z.strictObject({ id: z.string().min(1), revision: z.number().int().positive(), digest: z.string().regex(/^[a-f0-9]{64}$/) }),
});
export interface AgentCollaborationRequest {
  projectId: string; taskId: string; rootRunId: string; rootJobId: string; commandId: string;
  principal: HarnessPrincipal; route: string; model: string | null; accountRoute: string | null;
  sources: readonly string[]; consent: boolean;
  persistentTeam?: { leadSlotId: string; memberSlotId: string } | null;
  helperProfileId?: string | null; review?: AgentReviewSelection | null;
  qualityStatus?: 'hypothesis' | 'measured'; selectionReason?: string;
}
export interface CollaborationOptions {
  leads: { slotId: string; name: string; route: string; model: string | null; admitted: boolean; reason: string | null }[];
  members: { slotId: string; name: string; route: string; model: string | null; admitted: boolean; reason: string | null }[];
  helpers: { profileId: string; name: string; route: string; model: string | null; admitted: boolean; reason: string | null }[];
  reviews: { profileId: 'agent.inventory-reconciliation'; name: string; connectionId: string; model: string; admitted: boolean; reason: string | null }[];
  reason?: string | null;
}
export interface OwnedTeamPort {
  registry(grant: AgentTeamGrant, principal: HarnessPrincipal): ToolRegistry;
  waitForResponse(input: { grant: AgentTeamGrant; parentRunId: string; owner: string; principal: HarnessPrincipal; stepId: string }): Promise<OwnedTeamResponseResult>;
  ownedChildren(projectId: string, rootRunId: string): OwnedTeamRun[] | Promise<OwnedTeamRun[]>;
  stopRoot(projectId: string, rootRunId: string): Promise<void>;
  stopRootLocked?(projectId: string, rootRunId: string): Promise<void>;
  recoverRoot(projectId: string, rootRunId: string): Promise<void>;
}
export interface AgentCollaborationDeps {
  store: Store; runs?: RunService; ownedTeam: OwnedTeamPort; agentGate: AgentGatePort;
  currentAuthority: ResolveHarnessAuthority;
  authorityRef(projectId: string): Promise<PrincipalRef>;
  rootAdmission(runId: string): Promise<LoopCollaborationInput | null | undefined>;
  resolveTeamBinding(projectId: string, slotId: string): Promise<AgentTeamBinding>;
  resolveHelperBinding(projectId: string, profileId: string): Promise<LoopHelperBinding>;
  rootLedger?(admission: LoopCollaborationInput): Promise<SpendExposure>;
  /** Explicit offline driver only. Production defaults to genuine existing Trust authority. */
  allowPrototypeAuthority?: boolean;
  offers?(projectId: string, taskId: string): Promise<CollaborationOptions>;
  review?: {
    admit(request: AgentCollaborationRequest, sources: AgentTeamGrant['sources']): Promise<Omit<AgentReviewGrant, 'reportDigest'>>;
    host(grant: AgentReviewGrant, reportText: string): Promise<AgentReviewHost>;
  };
}
export function createAgentCollaboration(deps: AgentCollaborationDeps) {
  const { store } = deps;
  const sourcesFor = async (projectId: string, names: readonly string[]) => Promise.all(names.map(async path => {
    const text = (await store.readDocument(projectId, path)).text;
    return { path, sha256: sha(text) };
  }));
  const trust = async (reference: PrincipalRef, projectId: string, tenantId: string, phase: 'dispatch' | 'result') => {
    const resolved = await deps.currentAuthority({ via: 'stored-reference', ref: reference });
    const authority = requireCapability(requireCapability(deps.allowPrototypeAuthority ? resolved : requireGenuine(resolved), 'project.read'), phase === 'dispatch' ? 'egress.send' : 'egress.reconcile');
    if (isDenial(authority)) return fail(`The recorded Trust authority is revoked or unavailable (${authority.code}): ${authority.reason}`);
    if (digest(refOf(authority)) !== digest(reference) || (authority.principal.projectId !== null && authority.principal.projectId !== projectId) ||
        (authority.principal.tenantId !== null && authority.principal.tenantId !== tenantId))
      fail('The current Trust authority differs from this root admission.');
  };
  const paid = (projectId: string, rootJobId: string, phase: 'admit' | 'dispatch') =>
    deps.agentGate.check({ projectId, rootJobId, phase, surface: 'loop', routeKind: 'byo' });
  const paidDigest = (admitted: Awaited<ReturnType<typeof paid>>) => digest({
    organizationId: admitted.organizationId, personId: admitted.personId, planId: admitted.planId,
    scope: admitted.scope ?? null, policyRevision: admitted.policyRevision, routeKind: admitted.routeKind,
  });
  const binding = async (projectId: string, slotId: string, role: 'lead' | 'member') => {
    const live = store.state(projectId).team?.members.find(member => member.slotId === slotId);
    if (!live || live.status === 'stopped') fail('The selected Team membership is absent or stopped.');
    const selected = await deps.resolveTeamBinding(projectId, slotId);
    if (selected.slotId !== slotId || selected.role !== role || live!.role !== role || selected.createdAt !== live!.createdAt ||
        selected.threadId !== live!.threadId || selected.route !== live!.engine || selected.model !== live!.model ||
        (live!.agentId !== undefined && (selected.agentId ?? null) !== (live!.agentId ?? null)) || !isModelApiProvider(selected.route))
      fail('The selected Team binding changed or cannot run on this route.');
    return selected;
  };
  const requestOf = (admission: LoopCollaborationInput): AgentCollaborationRequest => ({
    projectId: admission.projectId, taskId: admission.taskId, rootRunId: admission.rootRunId, rootJobId: admission.rootJobId,
    commandId: admission.commandId, principal: admission.principal, route: admission.route, model: admission.model,
    accountRoute: admission.accountRoute, sources: admission.sources.map(source => source.path), consent: true,
    persistentTeam: admission.persistentTeam ? { leadSlotId: admission.persistentTeam.lead.slotId, memberSlotId: admission.persistentTeam.member.slotId } : null,
    helperProfileId: admission.helper?.profile.id ?? null, review: admission.reviewSelection,
    qualityStatus: admission.qualityStatus, selectionReason: admission.selectionReason,
  });
  const validateLocal = async (admission: LoopCollaborationInput, phase: 'dispatch' | 'result') => {
    const current = await deps.rootAdmission(admission.rootRunId);
    if (!current || digest(current) !== digest(admission)) fail('The recorded root collaboration admission changed.');
    const state = store.state(admission.projectId);
    if (!state.tasks.some(task => task.id === admission.taskId && !task.deletedAt)) fail('The admitted root task is no longer present.');
    await trust(admission.authorityRef, admission.projectId, admission.principal.tenantId, phase);
    if (deps.runs) {
      const root = await deps.runs.get(admission.rootRunId);
      if (root.projectId !== admission.projectId || root.taskId !== admission.taskId || digest(root.principal) !== digest(admission.principal) ||
          ['cancelled', 'failed', 'completed', 'reconcile_required'].includes(root.state)) fail('The root collaboration run is settled or requires reconciliation.');
    }
    if (admission.persistentTeam) {
      for (const selected of [admission.persistentTeam.lead, admission.persistentTeam.member])
        if (digest(await binding(admission.projectId, selected.slotId, selected.role)) !== digest(selected)) fail('The current member profile, effort, model or account binding changed.');
    }
    if (admission.helper && digest(await deps.resolveHelperBinding(admission.projectId, admission.helper.profile.id)) !== digest(admission.helper))
      fail('The admitted helper profile or account binding changed.');
    const routes = [admission.route, admission.persistentTeam?.member.route, admission.helper?.route].filter((route): route is string => Boolean(route));
    for (const route of new Set(routes)) requireCloudSharing(state, route as import('../../shared/types.js').Route, admission.sources.map(source => source.path));
    if (digest(await sourcesFor(admission.projectId, admission.sources.map(source => source.path))) !== digest(admission.sources))
      fail('The selected source bytes changed after admission.');
  };
  const validate = async (admission: LoopCollaborationInput, phase: 'dispatch' | 'result') => {
    if (paidDigest(await paid(admission.projectId, admission.rootJobId, 'dispatch')) !== admission.paidAdmissionDigest)
      fail('The paid account, membership or policy differs from the admitted root.');
    await validateLocal(admission, phase);
    if (admission.review) {
      if (!deps.review) fail('The selected review is not qualified on this host.');
      const refreshed = await deps.review!.admit(requestOf(admission), admission.sources);
      if (digest(refreshed) !== digest(admission.review)) fail('The selected review admission or policy changed.');
    }
  };
  const admit = async (request: AgentCollaborationRequest): Promise<LoopCollaborationInput> => {
    validatePrincipal(request.principal);
    if (request.principal.projectId !== request.projectId || !/^job-[a-f0-9]{40}$/.test(request.rootJobId)) fail('The host must supply the exact root project and job scope.');
    if (request.route === 'nectovia') fail('Managed Nectovia is single-agent only; this composition needs an admitted direct route.');
    if (!isModelApiProvider(request.route) || !request.model || !request.accountRoute || !request.consent) fail('The collaboration needs a selected direct model, account and source-sharing consent.');
    const state = store.state(request.projectId);
    if (!state.tasks.some(task => task.id === request.taskId && !task.deletedAt)) fail('The root task is missing.');
    const names = [...new Set(request.sources.map(relativeName))];
    if (!names.length || names.length > 16) fail('Select one to sixteen exact source files.');
    if (names.some(path => process.platform === 'win32' ? path.toLowerCase() === REPORT_PATH.toLowerCase() : path === REPORT_PATH))
      fail('The report output cannot also be an immutable collaboration source. Select separate source files.');
    const paidAdmissionDigest = paidDigest(await paid(request.projectId, request.rootJobId, 'admit'));
    const authorityRef = await deps.authorityRef(request.projectId);
    if (authorityRef.kind === 'team-member') fail('A Team member cannot grant this root collaboration.');
    await trust(authorityRef, request.projectId, request.principal.tenantId, 'dispatch');
    const sources = await sourcesFor(request.projectId, names);
    let persistentTeam: AgentTeamGrant | null = null;
    if (request.persistentTeam) {
      const selection = agentTeamSelectionSchema.safeParse(request.persistentTeam);
      if (!selection.success) fail(`Team selection schema refused: ${selection.error.message}`);
      const picked = selection.success ? selection.data : fail('Select distinct Team slots.');
      const lead = await binding(request.projectId, picked.leadSlotId, 'lead');
      const member = await binding(request.projectId, picked.memberSlotId, 'member');
      if (lead.route !== request.route || lead.model !== request.model || lead.accountRoute !== request.accountRoute)
        fail('The selected lead route, model or account does not match the root request.');
      const grant = agentTeamGrantSchema.safeParse({ v: 1, id: `team-${request.rootRunId}`, commandId: request.commandId,
        projectId: request.projectId, taskId: request.taskId, rootRunId: request.rootRunId, lead, member, sources, maxModelCalls: 6, maxResponses: 1 });
      if (!grant.success) fail(`The Team admission binding is unsupported: ${grant.error.message}`);
      persistentTeam = grant.success ? grant.data : null;
    }
    let helper: LoopHelperBinding | null = null;
    if (request.helperProfileId) {
      helper = helperSchema.parse(await deps.resolveHelperBinding(request.projectId, request.helperProfileId));
      if (!isModelApiProvider(helper.route) || helper.profile.id !== request.helperProfileId) fail('The selected helper profile cannot run as a direct helper.');
    }
    for (const route of new Set([request.route, persistentTeam?.member.route, helper?.route].filter((route): route is string => Boolean(route))))
      requireCloudSharing(state, route as import('../../shared/types.js').Route, names);
    let review: LoopCollaborationInput['review'] = null;
    const reviewSelection = request.review ? agentReviewSelectionSchema.parse(request.review) : null;
    if (reviewSelection) {
      if (!deps.review) fail('This review connection is not qualified on this host.');
      const selected = await deps.review!.admit({ ...request, review: reviewSelection }, sources);
      const checked = agentReviewGrantSchema.parse({ ...selected, reportDigest: '0'.repeat(64) });
      const { reportDigest: _digest, ...pin } = checked;
      if (pin.rootRunId !== request.rootRunId || pin.rootJobId !== request.rootJobId || pin.projectId !== request.projectId || pin.taskId !== request.taskId ||
          pin.principalId !== request.principal.id || pin.identityGeneration !== request.principal.identityGeneration || pin.route.connectionId !== reviewSelection.connectionId ||
          digest(pin.sources) !== digest(sources.map(source => ({ sourceId: source.path, digest: source.sha256 })))) fail('The qualified review belongs to a different root or selection.');
      review = pin;
    }
    return structuredClone({ v: 1, projectId: request.projectId, taskId: request.taskId, rootRunId: request.rootRunId, rootJobId: request.rootJobId,
      commandId: request.commandId, principal: request.principal, authorityRef, route: request.route, model: request.model!, accountRoute: request.accountRoute!,
      sources, persistentTeam, helper, reviewSelection, review, paidAdmissionDigest,
      qualityStatus: request.qualityStatus ?? 'hypothesis',
      selectionReason: request.selectionReason ?? 'The selected roles are admitted for bounded work; their comparative quality is an unmeasured hypothesis.' });
  };
  const resolveTeamGrantLocal = async (grant: AgentTeamGrant, phase: 'dispatch' | 'result' = 'dispatch') => {
    const admission = await deps.rootAdmission(grant.rootRunId);
    if (!admission?.persistentTeam || digest(admission.persistentTeam) !== digest(grant)) fail('The Team grant differs from its root admission.');
    await validateLocal(admission!, phase);
    return structuredClone(admission!.persistentTeam!);
  };
  const resolveTeamGrant = async (grant: AgentTeamGrant, phase: 'dispatch' | 'result' = 'dispatch') => {
    const admission = await deps.rootAdmission(grant.rootRunId);
    if (!admission?.persistentTeam || digest(admission.persistentTeam) !== digest(grant)) fail('The Team grant differs from its root admission.');
    await validate(admission!, phase);
    return structuredClone(admission!.persistentTeam!);
  };
  const pinFor = (run: HarnessRun): LoopCollaborationInput => {
    const input = run.input as unknown as Partial<LoopRunInput> | undefined;
    const admission = input?.collaboration;
    if (run.capabilityId !== 'diomedes-loop' || input?.kind !== 'diomedes-loop' || !admission || admission.rootRunId !== run.id || admission.projectId !== run.projectId || admission.taskId !== run.taskId)
      fail('This run has no matching native-root collaboration admission.');
    return admission!;
  };
  const scope = async (run: HarnessRun) => {
    const admission = pinFor(run);
    await validate(admission, 'dispatch');
    if (!deps.rootLedger) fail('The host has not supplied this root spend scope.');
    const scopedLedger = await deps.rootLedger!(admission);
    if (scopedLedger.jobScope?.id !== admission.rootJobId) fail('This ledger does not belong to the admitted root job.');
    return { rootRunId: admission.rootRunId, rootJobId: admission.rootJobId, scopedLedger };
  };
  const forRun = (run: HarnessRun, owner: string, principal: HarnessPrincipal): LoopCollaborationPort => {
    const admission = pinFor(run);
    if (digest(principal) !== digest(admission.principal)) fail('The native root principal changed.');
    const runtime = () => deps.runs ?? fail('This host has no attached RunService.');
    const rolesCompleted = async (root: HarnessRun) => {
      const owned = admission.persistentTeam || admission.helper ? await deps.ownedTeam.ownedChildren(run.projectId, run.id) : [];
      if (admission.persistentTeam && !owned.some(child => child.status === 'completed' && child.result && !child.unknownOutcome))
        fail('The required persistent Team response is missing.');
      if (admission.helper) {
        const ids = root.steps.filter(step => step.intent.stepId.startsWith('workers:') && step.state === 'succeeded').flatMap(step => {
          const input = step.intent.input as { handoffs?: { childRunId?: string }[] } | null;
          return (input?.handoffs ?? []).flatMap(item => item.childRunId ? [item.childRunId] : []);
        });
        const memberIds = new Set(owned.map(child => child.harnessRunId));
        const completed = (await Promise.all(ids.map(id => runtime().get(id)))).some(child => {
          const childInput = child.input as { parent?: { runId?: unknown }; route?: unknown; model?: unknown; accountRoute?: unknown } | null;
          return child.state === 'completed' && child.capabilityId === 'diomedes-loop-worker' && !memberIds.has(child.id) &&
            childInput?.parent?.runId === run.id && childInput.route === admission.helper!.route && childInput.model === admission.helper!.model && childInput.accountRoute === admission.helper!.accountRoute;
        });
        if (!ids.length || !completed) fail('The distinct H14 helper has not completed.');
      }
    };
    return {
      validate: phase => validate(admission, phase),
      afterTool: async context => {
        if (context.name !== 'team_send_message' || !admission.persistentTeam || (context.output as { error?: unknown } | null)?.error) return context.output;
        const result = await deps.ownedTeam.waitForResponse({ grant: admission.persistentTeam, parentRunId: run.id, owner, principal, stepId: `team-response:${context.stepId}` });
        await validate(admission, 'result');
        return { ...(context.output as Record<string, Json>), answer: result.text, memberRunId: result.runId, model: result.model };
      },
      ...(admission.review ? { review: async (context: LoopToolContext & { text: string }) => {
        await validate(admission, 'dispatch');
        await rolesCompleted(await runtime().get(run.id));
        const grant = agentReviewGrantSchema.parse({ ...admission.review, reportDigest: sha(context.text) });
        const existing = (await runtime().get(run.id)).steps.find(step => step.intent.stepId === 'agent-review:grant');
        if (existing && digest(existing.output) !== digest({ grant, reportText: context.text })) fail('This root already pinned different report bytes for review.');
        const pin = await runtime().step<{ grant: AgentReviewGrant; reportText: string }>(run.id, owner,
          { id: 'agent-review:grant', version: '1', kind: 'transform', effect: 'pure', cost: 0, input: { grant, reportText: context.text } as unknown as Json },
          () => ({ grant, reportText: context.text }), principal);
        const host = await deps.review!.host(pin.grant, pin.reportText);
        if (host.scopedLedger.jobScope?.id !== admission.rootJobId) fail('The review must use this root spend ledger.');
        return await recordAgentReview({ runtime: runtime(), runId: run.id, owner, principal, grant: pin.grant, host, observedAt: new Date().toISOString() }) as unknown as Json;
      } } : {}),
      beforeTool: async context => {
        await validate(admission, 'dispatch');
        if (context.name !== 'propose_write') return;
        const root = await runtime().get(run.id);
        await rolesCompleted(root);
        if (!admission.review) return;
        const pin = root.steps.find(step => step.intent.stepId === 'agent-review:grant' && step.state === 'succeeded')?.output as unknown as { grant?: AgentReviewGrant } | undefined;
        const text = (context.input as { text?: unknown } | null)?.text;
        if (!pin?.grant || typeof text !== 'string' || pin.grant.reportDigest !== sha(text) || !root.steps.some(step => step.intent.permission === EVALUATION_PERMISSION && step.state === 'succeeded'))
          fail('The proposal differs from the reviewed bytes or its required review is missing.');
      },
      assertFinish: async () => {
        await validate(admission, 'result');
        const root = await runtime().get(run.id);
        await rolesCompleted(root);
        if (admission.review && !root.steps.some(step => step.intent.permission === EVALUATION_PERMISSION && step.state === 'succeeded')) fail('The required exact report review is missing.');
        if (!root.steps.some(step => step.intent.name === 'propose_write' && step.state === 'succeeded')) fail('The root has no approved recorded report output.');
      },
    };
  };
  const bindings = (run: HarnessRun): LoopToolBinding[] => pinFor(run).persistentTeam ? TEAM_TOOLS.filter(tool => (AGENT_TEAM_TOOLS as readonly string[]).includes(tool.name)).map(tool => ({
    name: tool.name, description: tool.description, schema: z.strictObject(tool.shape),
    bind: (input: unknown, current: HarnessRun) => ({ ...(input as Record<string, Json>), projectId: current.projectId, runId: current.id }),
  })) : [];
  const registryFor = (run: HarnessRun) => {
    const admission = pinFor(run);
    if (!admission.persistentTeam) fail('This root was not admitted with persistent Team work.');
    return deps.ownedTeam.registry(admission.persistentTeam!, run.principal);
  };
  const authorizeReview = async (run: HarnessRun, intent: StepIntent, principal: HarnessPrincipal, phase: 'dispatch' | 'result') => {
    const admission = pinFor(run);
    await validate(admission, phase);
    const pin = run.steps.find(step => step.intent.stepId === 'agent-review:grant' && step.state === 'succeeded')?.output as unknown as { grant: AgentReviewGrant; reportText: string } | undefined;
    if (!pin || !admission.review || !deps.review) fail('This run has no admitted exact review.');
    const { reportDigest: _digest, ...scopePin } = pin!.grant;
    if (digest(scopePin) !== digest(admission.review)) fail('The review grant no longer matches the admitted selection.');
    await authorizeAgentReviewStep({ runtime: deps.runs ?? fail('The review runtime is unavailable.'), runId: run.id, principal,
      grant: pin!.grant, host: await deps.review!.host(pin!.grant, pin!.reportText), intent, phase });
  };
  return {
    admit, resolveTeamGrant, resolveTeamGrantLocal, forRun, bindings, registryFor, scope, validate, authorizeReview,
    async resolveRootTeamLead(projectId: string, selection: { leadSlotId: string; memberSlotId: string }) {
      const selected = agentTeamSelectionSchema.parse(selection);
      return structuredClone(await binding(projectId, selected.leadSlotId, 'lead'));
    },
    async documents(grant: AgentTeamGrant) { return Promise.all(grant.sources.map(async source => ({ path: source.path, text: (await store.readDocument(grant.projectId, source.path)).text }))); },
    async options(projectId: string, taskId: string): Promise<CollaborationOptions> {
      if (!store.state(projectId).tasks.some(task => task.id === taskId && !task.deletedAt)) throw new ApiError(404, 'This task was not found.');
      return deps.offers ? deps.offers(projectId, taskId) : { leads: [], members: [], helpers: [], reviews: [], reason: 'This host has no qualified collaboration choices.' };
    },
    children: (projectId: string, rootRunId: string) => deps.ownedTeam.ownedChildren(projectId, rootRunId),
    stop: (projectId: string, rootRunId: string) => deps.ownedTeam.stopRoot(projectId, rootRunId),
    stopLocked: (projectId: string, rootRunId: string) => deps.ownedTeam.stopRootLocked
      ? deps.ownedTeam.stopRootLocked(projectId, rootRunId)
      : Promise.reject(new HarnessError('collaboration_refused', 'This owned Team host lacks the locked Stop seam.')),
    recover: (projectId: string, rootRunId: string) => deps.ownedTeam.recoverRoot(projectId, rootRunId),
  };
}
export type AgentCollaborationHost = ReturnType<typeof createAgentCollaboration>;

/** Registered at host construction; each execution resolves the admitted root afresh. */
export function registerCollaborationTools(tools: ToolRegistry, runs: RunService, resolve: () => AgentCollaborationHost | null) {
  for (const definition of TEAM_TOOLS.filter(tool => (AGENT_TEAM_TOOLS as readonly string[]).includes(tool.name))) {
    const schema = z.strictObject({ ...definition.shape, projectId: z.string().min(1), runId: z.string().min(1) });
    tools.register({
      name: definition.name, version: 'agent-owned-1', description: definition.description,
      effect: definition.effect, effectClass: definition.effect === 'read' ? 'read' : 'non-idempotent-effect', permission: null,
      approval: false, destination: 'local', trustedInputRequired: false, cost: definition.effect === 'read' ? 0 : 1,
      schema, outputSchema: z.json(),
      ...(definition.effect === 'read' ? {} : { targets: (input: { projectId: string; runId: string }) => [`team:${input.projectId}`] }),
      execute: async context => {
        const { projectId, runId, ...input } = schema.parse(context.input);
        const run = await runs.get(runId);
        const step = run.steps.find(step => step.intent.name === definition.name && digest({ runId, stepId: step.intent.stepId, intentHash: step.intentHash }) === context.idempotencyKey);
        if (run.projectId !== projectId || run.capabilityId !== 'diomedes-loop' || step?.state !== 'running') fail('This Team effect is not the active native-root step.');
        const host = resolve() ?? fail('Persistent Team collaboration is not attached to this host.');
        const admission = (run.input as unknown as LoopRunInput).collaboration;
        if (!admission) fail('This root has no recorded collaboration admission.');
        await host.validate(admission!, 'dispatch');
        return host.registryFor(run).get(definition.name).execute({ ...context, input });
      },
    });
  }
}
