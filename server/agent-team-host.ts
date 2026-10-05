/** Production composition over existing Team, Runtime, Trust and root spend records. */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { ownedTeamResponseMetadataSchema, type AgentTeamBinding } from '../shared/agent-collaboration.js';
import { agentReviewGrantSchema, INVENTORY_REVIEW_MAX_INPUT_TOKENS, INVENTORY_REVIEW_PROFILE,
  type AgentReviewGrant } from '../shared/agent-review.js';
import type { AutomaticTeamCandidate, AutomaticTeamQualification } from '../shared/automatic-team.js';
import type { AgentProfileRevision } from '../shared/agent-profiles.js';
import { profileDigest as evaluationProfileDigest } from '../shared/evaluation.js';
import type { HarnessLabel } from '../shared/harness.js';
import { micro as usdMicro } from '../shared/managed-usage.js';
import type { LoopCollaborationInput, LoopHelperBinding, LoopRunInput } from '../shared/native-loop.js';
import { isTeamModelRoute, type TeamModelRoute } from '../shared/model-api.js';
import { findLocalProfile, LOCAL_MODEL_ACCOUNT, LOCAL_MODEL_ROUTE } from '../shared/local-model.js';
import { isPersonOnlyTeamRoute } from '../shared/team-routes.js';
import type { Conversation, TeamMember } from '../shared/types.js';
import { profileDigest, type AgentProfileService, type AgentProfileStore } from './agent-profiles.js';
import { AGENT_SIGN_IN_REQUIRED, type AgentGatePort } from './accounts/agent-gate.js';
import { LOCAL_MODEL_NOT_INSTALLED } from './bonsai/runtime.js';
import { cloudSharing, requireCloudSharing } from './cloud-sharing.js';
import { secretFingerprint } from './connection-secrets.js';
import { awsAccountRoute, awsModelRefusal, awsQualificationFor } from './engines/aws-bedrock.js';
import { azureAccountRoute } from './engines/azure-openai.js';
import { LOCAL_MODEL_CONNECTION } from './engines/bonsai.js';
import { openRouterAccountRoute, openRouterConnectionSchema, openRouterModelFor, openRouterPreferences,
  type OpenRouterConnection } from './engines/openrouter.js';
import { readAdcIdentity, vertexAccountRoute } from './engines/google-vertex.js';
import { CONVERSATION_LIMITS } from './engines/model-api-core.js';
import type { EngineService } from './engines/service.js';
import { EngineError } from './engines/process.js';
import { automaticTeamStillCurrent } from './harness/automatic-team-selection.js';
import { createAgentCollaboration, type AgentCollaborationDeps, type AgentCollaborationRequest,
  type CollaborationOptions } from './harness/agent-collaboration.js';
import type { AgentReviewHost, AgentReviewTransportBinding } from './harness/agent-review.js';
import { createAgentReviewTransport, type AgentReviewProviderPolicy,
  type AgentReviewQualification } from './harness/agent-review-transport.js';
import type { HarnessHost } from './harness/host.js';
import { sourceRules } from './harness/native-agent.js';
import { TEAM_WORK_CAPABILITY } from './harness/model-session-run.js';
import { digest, HarnessError } from './harness/policy.js';
import type { RunService } from './harness/run-service.js';
import type { ResolveHarnessAuthority } from './harness/trust-port.js';
import { validateRateCard, type ModelRateCard, type SpendExposure } from './spend-exposure.js';
import type { Store } from './store.js';
import { OwnedTeamResponses } from './team/owned-response.js';
import type { TeamService } from './team/service.js';
import { isDenial, refOf, requireCapability, requireGenuine, type Authority, type Denial, type PrincipalRef } from './trust/index.js';
import type { WorkspaceService } from './workspaces.js';

const refuse = (message: string): never => { throw new HarnessError('collaboration_refused', message); };
const reasonOf = (error: unknown) => error instanceof Error ? error.message : 'This selection is unavailable on this host.';
export const LOCAL_PROFILE_REFUSED = "Saved profiles don't run on the local model yet.";
const sha = z.string().regex(/^[a-f0-9]{64}$/);
/** H09 carries its algorithm prefix; collaboration pins carry the validated SHA bytes. */
const collaborationProfileDigest = (revision: AgentProfileRevision): string => {
  const value = profileDigest(revision);
  if (!/^sha256:[a-f0-9]{64}$/.test(value)) return refuse('The saved profile digest is invalid.');
  return value.slice('sha256:'.length);
};
const identity = z.string().min(1).max(256);
const micro = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const qualificationSchema = z.strictObject({
  id: identity, evidenceSha: sha, scope: z.literal('bounded-work'), validUntil: z.string().datetime({ offset: true }),
  route: identity, model: identity, effort: z.string().nullable(), accountRoute: identity,
  connectionId: identity, connectionRevision: z.number().int().positive(), payerId: identity, profileDigest: sha,
  benchmark: z.strictObject({ id: identity, accepted: z.boolean(), score: z.number().finite(), independent: z.boolean() }),
  bounds: z.strictObject({ qualificationId: identity, workerMicroUsd: micro, verificationMicroUsd: micro,
    correctionMicroUsd: micro, coordinationMicroUsd: micro }),
});

interface LocalConnection {
  connectionId: string;
  connectionRevision: number;
  accountRoute: string;
}
interface LocalMember {
  binding: AgentTeamBinding;
  profile: AgentProfileRevision | null;
  connection: LocalConnection;
}

export interface ProductionAgentTeamHostDependencies {
  store: Store;
  team: TeamService;
  harness: HarnessHost;
  engines: EngineService;
  profiles: AgentProfileService;
  profileStore: AgentProfileStore;
  workspaces: Pick<WorkspaceService, 'currentPerson'>;
  currentAuthority: ResolveHarnessAuthority;
  /** Protected host proof for this exact project; never a renderer/person record alone. */
  ownerAuthority?: (projectId:string) => Promise<Authority | Denial>;
  modelApiTransport?: typeof globalThis.fetch;
  trustedReviewQualification?: ProductionReviewQualificationSource;
}

export function createProductionAgentTeamHost(deps: ProductionAgentTeamHostDependencies) {
  const { store, harness, engines } = deps;
  /**
   * A local profile is named as the local model's catalogue names it, from its folder and its running
   * server; every other model by its id, as before.
   */
  const localModelName = (route: string, model: string | null): string | null => {
    const runtime = route === LOCAL_MODEL_ROUTE ? engines.modelApi?.bonsai?.runtime : undefined;
    return runtime ? findLocalProfile({ profiles: runtime.catalog() }, model)?.name ?? null : null;
  };
  const ledgers = new Map<string, Promise<SpendExposure>>();
  const rootLedger = (projectId: string, rawJobId: string, threadId: string | null = null) => {
    const key = JSON.stringify([projectId, rawJobId, threadId]);
    const cached = ledgers.get(key);
    if (cached) return cached;
    const promise = engines.rootJobLedger(projectId, rawJobId, threadId);
    ledgers.set(key, promise);
    void promise.catch(() => { if (ledgers.get(key) === promise) ledgers.delete(key); });
    return promise;
  };
  const authorityRef = async (projectId: string): Promise<PrincipalRef> => {
    const resolved = deps.ownerAuthority ? await deps.ownerAuthority(projectId)
      : await deps.currentAuthority({ via: 'local-owner', ownerId: deps.workspaces.currentPerson().id });
    const authority = requireCapability(requireCapability(requireGenuine(resolved), 'project.read'), 'egress.send');
    if (isDenial(authority)) return refuse(`Current Trust authority is unavailable: ${authority.reason}`);
    if (authority.principal.projectId !== null && authority.principal.projectId !== projectId)
      return refuse('The current Trust authority belongs to a different project.');
    return refOf(authority);
  };
  const localConnection = async (route: TeamModelRoute, model: string): Promise<LocalConnection> => {
    const api = engines.modelApi;
    if (!api) return refuse('This model route is not enabled on this host.');
    if (route === LOCAL_MODEL_ROUTE) {
      // The local model has no key, no account setting and no expiry. It is on where it is set up
      // here, and takes a role's work only while the person keeps that profile running: its status
      // is read, never started, and a profile that isn't running is refused in the runtime's words.
      // It is read now, not answered from the runtime's last check, which may be ten seconds old.
      const local = api.bonsai;
      if (!local?.runtime.configured()) return refuse(LOCAL_MODEL_NOT_INSTALLED);
      const refusal = await local.runtime.refusal(model, { fresh: true });
      if (refusal) return refuse(refusal);
      // The local lane's own zero-cost card: inference here has no provider charge.
      if (!(await engines.modelApiCard(route, model))) return refuse('The selected model has no current bounded price card.');
      return { connectionId: LOCAL_MODEL_CONNECTION, connectionRevision: 1, accountRoute: LOCAL_MODEL_ACCOUNT };
    }
    if (store.settings.services?.[route] !== true) return refuse('This model route is not enabled on this host.');
    let facts: LocalConnection;
    let expiresAt: string | null | undefined;
    let fingerprint: string;
    let usesAdc = false;
    if (route === 'aws-bedrock') {
      const c = await api.connections.read();
      if (!c || c.modelId !== model) return refuse('The selected model is not on the current AWS connection.');
      // Kimi K3 joins a team only under a current route check receipt for this connection.
      const refusal = awsModelRefusal(c, await awsQualificationFor(api.qualifications, c), Date.now());
      if (refusal) return refuse(refusal);
      facts = { connectionId: c.id, connectionRevision: c.revision, accountRoute: awsAccountRoute(c) };
      expiresAt = c.credential.expiresAt;
      fingerprint = c.credential.fingerprint;
    } else if (route === 'azure-openai') {
      const c = await api.azure?.connections.read();
      if (!c || !c.deployments.some(entry => entry.model === model)) return refuse('The selected model is not on the current Azure connection.');
      facts = { connectionId: c.id, connectionRevision: c.revision, accountRoute: azureAccountRoute(c) };
      expiresAt = c.credential.expiresAt;
      fingerprint = c.credential.fingerprint;
    } else if (route === 'openrouter') {
      const c = await api.openrouter?.connections.read();
      if (!c) return refuse('OpenRouter is not connected on this host.');
      openRouterModelFor(c, model);
      facts = { connectionId: c.id, connectionRevision: c.revision, accountRoute: openRouterAccountRoute(c) };
      expiresAt = c.credential.expiresAt;
      fingerprint = c.credential.fingerprint;
    } else {
      const c = await api.vertex?.connections.read();
      if (!c || c.model !== model) return refuse('The selected model is not on the current Vertex connection.');
      facts = { connectionId: c.id, connectionRevision: c.revision, accountRoute: vertexAccountRoute(c) };
      expiresAt = c.credential.expiresAt;
      fingerprint = c.credential.fingerprint;
      usesAdc = c.credential.kind === 'google-adc';
    }
    if (usesAdc) {
      const identity = await readAdcIdentity(api.vertex?.env);
      if (!identity || identity.fingerprint !== fingerprint) return refuse('The saved Google credential is missing or changed.');
    } else {
      if (!api.secrets.available()) return refuse('Protected credential storage is unavailable on this host.');
      if (secretFingerprint(await api.secrets.get(facts.connectionId)) !== fingerprint)
        return refuse('The protected credential differs from the current connection.');
    }
    if (expiresAt && Date.parse(expiresAt) <= Date.now() + 60_000) return refuse('The selected connection credential has expired.');
    if (store.settings.services?.[`${route}AccountRoute`] !== facts.accountRoute)
      return refuse('The selected account route differs from the current connection.');
    if (!(await engines.modelApiCard(route, model))) return refuse('The selected model has no current bounded price card.');
    return facts;
  };
  const profile = async (projectId: string, profileId: string): Promise<AgentProfileRevision> => {
    await deps.profileStore.load();
    if (deps.profileStore.damaged) return refuse(deps.profileStore.damaged);
    const saved = deps.profileStore.get(profileId);
    const revision = saved && !saved.archivedAt ? saved.revisions.at(-1) : null;
    if (!revision || !isTeamModelRoute(revision.engine)) return refuse('The selected direct Agent profile is absent or archived.');
    // A saved profile's availability is its route's Settings switch, which the local model doesn't
    // have, so no saved profile runs there yet. A local Team member is how it joins a team.
    if (revision.engine === LOCAL_MODEL_ROUTE) return refuse(LOCAL_PROFILE_REFUSED);
    const unavailable = await deps.profiles.unavailable(revision, store.state(projectId).project.folder);
    if (unavailable) return refuse(unavailable);
    return structuredClone(revision);
  };
  const memberPin = (member: TeamMember, thread: Conversation) => ({
    slotId: member.slotId, role: member.role, agentId: member.agentId ?? null, createdAt: member.createdAt,
    threadId: member.threadId, engine: member.engine, model: member.model,
    helper: thread.helper ?? null, requested: thread.requested ?? null,
  });
  const localMember = async (projectId: string, slotId: string): Promise<LocalMember> => {
    const member = structuredClone(deps.team.requireActive(projectId, slotId));
    if (!member.threadId || !member.model || !isTeamModelRoute(member.engine))
      return refuse('Select an existing direct Team member with an explicit model and thread.');
    const thread = structuredClone(store.state(projectId).conversations.find(item => item.id === member.threadId));
    if (!thread || thread.helper?.engine !== member.engine || thread.helper.model !== member.model ||
      (thread.requested?.model ?? member.model) !== member.model)
      return refuse('The current Team thread and selected member model disagree.');
    const initial = digest(memberPin(member, thread));
    const revision = thread.requested?.profile ? await profile(projectId, thread.requested.profile) : null;
    // Selecting a saved profile deliberately leaves requested.model/effort null.
    const effort = revision ? revision.effort : thread.requested?.effort ?? null;
    if (member.role === 'member' && effort !== 'medium') return refuse('The selected Team member must use medium reasoning.');
    if (revision && (revision.engine !== member.engine || revision.model !== member.model || revision.effort !== effort ||
      (member.agentId && revision.agentId !== member.agentId)))
      return refuse('The current saved profile differs from this Team member or its thread.');
    const connection = await localConnection(member.engine, member.model);
    if (revision && profileDigest(await profile(projectId, revision.profileId)) !== profileDigest(revision))
      return refuse('The selected saved profile changed while its binding was read.');
    const currentMember = deps.team.requireActive(projectId, slotId);
    const currentThread = store.state(projectId).conversations.find(item => item.id === member.threadId);
    if (!currentThread || digest(memberPin(currentMember, currentThread)) !== initial)
      return refuse('The selected Team member changed while its binding was read.');
    return {
      binding: { slotId, role: member.role, agentId: member.agentId ?? null, createdAt: member.createdAt,
        threadId: member.threadId, route: member.engine, model: member.model, accountRoute: connection.accountRoute,
        effort, profile: revision ? { id: revision.profileId, revision: revision.revision, digest: collaborationProfileDigest(revision) } : null },
      profile: revision, connection,
    };
  };
  const resolveTeamBinding = async (projectId: string, slotId: string) => (await localMember(projectId, slotId)).binding;
  const resolveHelperBinding = async (projectId: string, profileId: string): Promise<LoopHelperBinding> => {
    const revision = await profile(projectId, profileId);
    if (!isTeamModelRoute(revision.engine)) return refuse('The selected helper is not a direct model profile.');
    const connection = await localConnection(revision.engine, revision.model);
    return { route: revision.engine, model: revision.model, accountRoute: connection.accountRoute, effort: revision.effort,
      profile: { id: revision.profileId, revision: revision.revision, digest: collaborationProfileDigest(revision) } };
  };
  const candidates = async (projectId: string): Promise<AutomaticTeamCandidate[]> => {
    let authorized = false;
    try { await authorityRef(projectId); authorized = Boolean(engines.agentGate); } catch { /* Unqualified candidates grant nothing. */ }
    const result: AutomaticTeamCandidate[] = [];
    for (const member of [...(store.state(projectId).team?.members ?? [])]) {
      // Automatic work never picks the local model. It runs only where the person selects it.
      if (isPersonOnlyTeamRoute(member.engine)) continue;
      try {
        const live = await localMember(projectId, member.slotId);
        if (!live.profile || !live.binding.profile) continue;
        const pin = live.binding, connection = live.connection;
        let qualification: AutomaticTeamQualification | null = null;
        for (const value of store.state(projectId).team?.qualifications ?? []) {
          const checked = qualificationSchema.safeParse(value);
          if (!checked.success) continue;
          const q = checked.data;
          if (q.route === pin.route && q.model === pin.model && q.effort === pin.effort &&
            q.accountRoute === pin.accountRoute && q.profileDigest === pin.profile!.digest &&
            q.connectionId === connection.connectionId && q.connectionRevision === connection.connectionRevision &&
            q.bounds.qualificationId === q.id && q.benchmark.accepted && q.benchmark.independent && Date.parse(q.validUntil) > Date.now()) {
            qualification = q;
            break;
          }
        }
        result.push({ slotId: pin.slotId, role: pin.role, profileId: pin.profile!.id, profileRevision: pin.profile!.revision,
          profileDigest: pin.profile!.digest, route: pin.route, model: pin.model, effort: pin.effort,
          accountRoute: pin.accountRoute, connectionId: connection.connectionId, connectionRevision: connection.connectionRevision,
          // Provider billing identity comes only from the trusted measured account qualification.
          // Current connection/account/revision pins above fence it; Agent plan payer is separate.
          payerId: qualification?.payerId ?? '', authorized, available: true, qualification });
      } catch { /* Absent, stopped, stale and unsupported members cannot join an automatic selection. */ }
    }
    return structuredClone(result);
  };
  const rootAdmission = async (runId: string): Promise<LoopCollaborationInput | null> => {
    const run = await harness.runs.get(runId);
    if (run.capabilityId !== 'diomedes-loop') return null;
    if (['cancelled', 'failed', 'completed', 'reconcile_required'].includes(run.state)) return null;
    const input = run.input as unknown as Partial<LoopRunInput>;
    const admitted = input?.kind === 'diomedes-loop' ? input.collaboration ?? null : null;
    if (!admitted) return null;
    if (admitted.rootRunId !== run.id || admitted.projectId !== run.projectId || admitted.taskId !== run.taskId)
      return refuse('The collaboration admission differs from its saved root.');
    const task = store.state(run.projectId).tasks.find(item => item.id === run.taskId && !item.deletedAt);
    const automatic = task?.automaticWork;
    const decision = automatic?.teamDecision;
    if (admitted.qualityStatus === 'measured' && decision?.mode !== 'team')
      return refuse('The measured root no longer has its automatic Team decision.');
    if (decision?.mode === 'team') {
      if (automatic!.rootRunId !== run.id || automatic!.rootJobId !== admitted.rootJobId ||
        automatic!.request.requestDigest !== decision.requestDigest ||
        admitted.persistentTeam?.lead.slotId !== decision.lead.slotId || admitted.persistentTeam.member.slotId !== decision.worker.slotId ||
        !automaticTeamStillCurrent(decision, await candidates(run.projectId), Date.now()))
        return refuse('The measured automatic Team decision no longer matches its root and current qualification.');
    } else if (decision?.mode === 'single' && admitted.persistentTeam) {
      return refuse('This automatic root was admitted for one agent.');
    }
    return structuredClone(admitted);
  };
  const ledgerFor = async (admission: LoopCollaborationInput): Promise<SpendExposure> => {
    const run = await harness.runs.get(admission.rootRunId);
    const input = run.input as unknown as Partial<LoopRunInput>;
    if (run.projectId !== admission.projectId || input.rootJobId !== admission.rootJobId || !input.rootJobRequestId)
      return refuse('The saved root is missing its original spend request identity.');
    const ledger = await rootLedger(admission.projectId, input.rootJobRequestId, input.threadId ?? null);
    if (ledger.jobScope?.id !== admission.rootJobId) return refuse('The original request resolved a different root spend scope.');
    return ledger;
  };
  let collaboration: ReturnType<typeof createAgentCollaboration>;
  const ownedTeam: OwnedTeamResponses = new OwnedTeamResponses({
    store, team: deps.team, runs: harness.runs, sessions: harness.modelSessions,
    resolveGrant: (grant, phase) => collaboration.resolveTeamGrant(grant, phase),
    resolveGrantLocal: (grant, phase) => collaboration.resolveTeamGrantLocal(grant, phase),
    documents: grant => Promise.all(grant.sources.map(async source => ({ path: source.path,
      text: (await store.readDocument(grant.projectId, source.path)).text }))),
    admit: async (grant, stop) => {
      stop?.throwIfAborted();
      const root = await rootAdmission(grant.rootRunId);
      if (!root?.persistentTeam || digest(root.persistentTeam) !== digest(grant)) return refuse('The root no longer owns this Team grant.');
      return engines.admitModelApi(grant.member.route,
        { projectId: grant.projectId, model: grant.member.model, accountRoute: grant.member.accountRoute,
          requestId: grant.rootRunId, threadId: grant.member.threadId },
        { surface: 'team', rootJobId: root.rootJobId });
    },
    adapter: async (grant, admitted, instructions, stop) => {
      stop.throwIfAborted();
      const root = await rootAdmission(grant.rootRunId);
      if (!root?.persistentTeam || digest(root.persistentTeam) !== digest(grant)) return refuse('The root no longer owns this Team response.');
      const saved = ownedTeam.ownedChildren(grant.projectId, grant.rootRunId);
      if (saved.length !== 1 || digest(saved[0].grant) !== digest(grant) || saved[0].rootClosed || saved[0].unknownOutcome)
        return refuse('This Team adapter has no exact active saved child.');
      const child = saved[0];
      const childRun = await harness.runs.get(child.harnessRunId);
      const childInput = childRun.input as { ownedTeam?: unknown; commandId?: unknown; sources?: unknown;
        route?: unknown; model?: unknown; accountRoute?: unknown; effort?: unknown } | null;
      const metadata = ownedTeamResponseMetadataSchema.safeParse(childInput?.ownedTeam);
      if (childRun.capabilityId !== TEAM_WORK_CAPABILITY.id || childRun.projectId !== grant.projectId || childRun.taskId !== grant.taskId ||
        !childInput || !child.parent || !metadata.success || digest(metadata.data) !== digest({ v: 1, grantId: grant.id,
          rootRunId: grant.rootRunId, taskId: grant.taskId, teamRunId: child.id, assignmentTaskId: child.assignmentTaskId, parent: child.parent }) ||
        childInput.commandId !== child.commandId || digest(childInput.sources) !== digest(grant.sources) ||
        childInput.route !== grant.member.route || childInput.model !== grant.member.model ||
        childInput.accountRoute !== grant.member.accountRoute || childInput.effort !== 'medium' ||
        admitted.route !== grant.member.route || admitted.model !== grant.member.model || admitted.accountRoute !== grant.member.accountRoute)
        return refuse('The Team child or paid account differs from its saved admission.');
      const ledger = await ledgerFor(root);
      const decision = store.state(grant.projectId).tasks.find(task => task.id === grant.taskId)?.automaticWork?.teamDecision;
      if (decision?.mode === 'team') await ledger.limitRunBudget(child.harnessRunId, usdMicro(decision.reserve.workerMicroUsd), root.rootJobId);
      return engines.loopAdapter(grant.member.route, { projectId: grant.projectId, runId: child.harnessRunId,
        rootRunId: grant.rootRunId, rootJobId: root.rootJobId, threadId: grant.member.threadId,
        model: grant.member.model, accountRoute: grant.member.accountRoute, instructions,
        effort: 'medium', scopedLedger: ledger, callLimits: { ...CONVERSATION_LIMITS },
        ownedTeamObservation: { ...metadata.data, runId: childRun.id, commandId: child.commandId } }, stop);
    },
  });
  const review = createProductionReview({ store, engines, runs: harness.runs, currentAuthority: deps.currentAuthority,
    authorityRef, rootAdmission, rootLedger: ledgerFor, qualification: deps.trustedReviewQualification,
    ...(deps.modelApiTransport ? { modelApiTransport: deps.modelApiTransport } : {}) });
  const offers = async (projectId: string, taskId: string): Promise<CollaborationOptions> => {
    const state = store.state(projectId);
    if (!state.tasks.some(task => task.id === taskId && !task.deletedAt)) return refuse('The selected task is absent.');
    const choices: CollaborationOptions = { leads: [], members: [], helpers: [], reviews: [] };
    let trustReason: string | null = null;
    try { await authorityRef(projectId); } catch (error) { trustReason = reasonOf(error); }
    if (!engines.agentGate) trustReason = 'Sign in to a Nectovia plan before starting Agent work.';
    for (const member of state.team?.members ?? []) {
      let reason = trustReason;
      try { await localMember(projectId, member.slotId); } catch (error) { reason = reasonOf(error); }
      const modelName = localModelName(member.engine, member.model);
      const row = { slotId: member.slotId, name: member.name, route: member.engine, model: member.model,
        ...(modelName ? { modelName } : {}), admitted: reason === null, reason };
      choices[member.role === 'lead' ? 'leads' : 'members'].push(row);
    }
    await deps.profileStore.load();
    for (const selected of deps.profileStore.list()) {
      if (!isTeamModelRoute(selected.engine)) continue;
      let reason = trustReason;
      try { await resolveHelperBinding(projectId, selected.profileId); } catch (error) { reason = reasonOf(error); }
      const modelName = localModelName(selected.engine, selected.model);
      choices.helpers.push({ profileId: selected.profileId, name: selected.name, route: selected.engine,
        model: selected.model, ...(modelName ? { modelName } : {}), admitted: reason === null, reason });
    }
    choices.reviews = await review.offers(projectId);
    if (trustReason) choices.reason = trustReason;
    return choices;
  };
  const missingGate: AgentGatePort = { check: async () => { throw new EngineError(AGENT_SIGN_IN_REQUIRED,
    'Sign in to a Nectovia plan before starting Agent work.'); } };
  collaboration = createAgentCollaboration({ store, runs: harness.runs, ownedTeam,
    agentGate: engines.agentGate ?? missingGate, currentAuthority: deps.currentAuthority, authorityRef,
    rootAdmission, resolveTeamBinding, resolveHelperBinding, rootLedger: ledgerFor, offers,
    review,
  });
  return { collaboration, ownedTeam, resolveTeamBinding, resolveHelperBinding, candidates, rootLedger };
}

/** Trusted server configuration only. Neither a selection nor saved chat rates qualify Decisions. */
export interface TrustedProductionReviewQualification {
  version: 1;
  id: string;
  revision: number;
  source: string;
  qualifiedAt: string;
  validUntil: string;
  connectionId: string;
  connectionRevision: number;
  connectionDigest: string;
  credentialFingerprint: string;
  /** Actual account identity established by the account qualification for this exact credential. */
  accountId: string;
  accountDigest: string;
  dataPolicyDigest: string;
  profileId: 'agent.inventory-reconciliation';
  profileRevision: 1;
  profileDigest: string;
  /** Qualified Decisions pricing, including its request fee; never inferred from the chat catalog. */
  rateCard: ModelRateCard;
  inputFramingTokens: number;
}
export type ProductionReviewQualificationSource = TrustedProductionReviewQualification | null |
  ((projectId: string) => TrustedProductionReviewQualification | null | Promise<TrustedProductionReviewQualification | null>);
interface ProductionReviewDeps {
  store: Store;
  engines: EngineService;
  runs: RunService;
  currentAuthority: ResolveHarnessAuthority;
  authorityRef(projectId: string): Promise<PrincipalRef>;
  rootLedger(admission: LoopCollaborationInput): Promise<SpendExposure>;
  /** Read the persisted root; return null for stopped, settled or reconciliation-required roots. */
  rootAdmission(runId: string): Promise<LoopCollaborationInput | null | undefined>;
  modelApiTransport?: typeof fetch;
  qualification?: ProductionReviewQualificationSource;
}
const reviewModel = 'typesafe/jev-1.13' as const;
const reviewProfileDigest = evaluationProfileDigest(INVENTORY_REVIEW_PROFILE);
const rawDigest = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');
const reviewRefused = (message: string): never => { throw new HarnessError('review_unqualified', message); };
const nonempty = (value: unknown, max = 200): value is string =>
  typeof value === 'string' && Boolean(value.trim()) && value.length <= max;

/** Non-secret binding facts only; these hashes are not qualification or authority. */
export function productionReviewBindingFacts(connection: OpenRouterConnection, accountId: string) {
  const provider = openRouterPreferences(openRouterModelFor(connection, reviewModel)) as AgentReviewProviderPolicy;
  return {
    connectionId: connection.id, connectionRevision: connection.revision,
    connectionDigest: digest(connection), credentialFingerprint: connection.credential.fingerprint,
    accountId,
    accountDigest: digest({ provider: 'openrouter', accountId, connectionId: connection.id,
      connectionRevision: connection.revision, credentialFingerprint: connection.credential.fingerprint }),
    dataPolicyDigest: digest(provider), profileId: INVENTORY_REVIEW_PROFILE.profileId,
    profileRevision: INVENTORY_REVIEW_PROFILE.revision, profileDigest: reviewProfileDigest,
  };
}

/** Default configuration has no qualification; listing and admission never contact a catalog. */
export function createProductionReview(deps: ProductionReviewDeps): NonNullable<AgentCollaborationDeps['review']> & {
  offers(projectId: string): Promise<CollaborationOptions['reviews']>;
} {
  async function configured(projectId: string) {
    const given = typeof deps.qualification === 'function' ? await deps.qualification(projectId) : deps.qualification;
    if (!given) return reviewRefused('This fixed review has no current account and Decisions billing qualification.');
    // Detach trusted configuration too, so mutation during an awaited secret read cannot change the pin.
    const q = structuredClone(given);
    const now = Date.now();
    if (q.version !== 1 || !nonempty(q.id) || !nonempty(q.source, 2_000) || !nonempty(q.accountId, 128) ||
        !Number.isSafeInteger(q.revision) || q.revision < 1 || !Number.isFinite(Date.parse(q.qualifiedAt)) ||
        Date.parse(q.qualifiedAt) > now || !Number.isFinite(Date.parse(q.validUntil)) || Date.parse(q.validUntil) <= now + 60_000 ||
        !Number.isSafeInteger(q.inputFramingTokens) || q.inputFramingTokens < 0 || q.inputFramingTokens > INVENTORY_REVIEW_MAX_INPUT_TOKENS)
      return reviewRefused('The trusted review qualification is stale or does not bound billing and input framing.');
    const api = deps.engines.modelApi;
    const connection = openRouterConnectionSchema.parse(await api?.openrouter?.connections.read());
    if (!api || !api.secrets.available()) return reviewRefused('The direct review has no protected credential storage.');
    const settings = deps.store.settings.services;
    if (settings?.openrouter !== true || settings.openrouterAccountRoute !== openRouterAccountRoute(connection) ||
        (connection.credential.expiresAt !== null && Date.parse(connection.credential.expiresAt) <= now + 60_000))
      return reviewRefused('The current direct OpenRouter connection is off, changed or expiring.');
    const facts = productionReviewBindingFacts(connection, q.accountId);
    for (const key of Object.keys(facts) as (keyof typeof facts)[])
      if (q[key] !== facts[key]) return reviewRefused('The review qualification belongs to a different connection, credential, account, profile or policy.');
    const rateCard = validateRateCard(q.rateCard);
    if (rateCard.route !== 'openrouter' || rateCard.modelId !== reviewModel || rateCard.short.output !== 0 || rateCard.long.output !== 0)
      return reviewRefused('The exact Decisions account has no qualified zero-output-rate bound.');
    const provider = openRouterPreferences(openRouterModelFor(connection, reviewModel)) as AgentReviewProviderPolicy;
    return { q, api, connection, provider, qualification: {
      id: q.id, source: q.source, rateCard, inputFramingTokens: q.inputFramingTokens,
    } satisfies AgentReviewQualification };
  }
  async function trust(reference: PrincipalRef, projectId: string, tenantId: string, phase: 'dispatch' | 'result') {
    if (reference.kind === 'team-member') return reviewRefused('A Team member cannot authorize the root review.');
    const authority = requireCapability(requireCapability(requireGenuine(await deps.currentAuthority({
      via: 'stored-reference', ref: reference,
    })), 'project.read'), phase === 'dispatch' ? 'egress.send' : 'egress.reconcile');
    if (isDenial(authority) || digest(refOf(authority)) !== digest(reference) ||
        (authority.principal.projectId !== null && authority.principal.projectId !== projectId) ||
        (authority.principal.tenantId !== null && authority.principal.tenantId !== tenantId))
      return reviewRefused('The genuine stored Trust reference no longer authorizes this review.');
  }
  function sharing(projectId: string, sources: readonly string[]) {
    const state = deps.store.state(projectId);
    requireCloudSharing(state, 'openrouter', sources);
    const policy = cloudSharing(state);
    if (!policy.shareReviewPackets) return reviewRefused('Sharing a report with the reviewer is off for this project.');
    return policy;
  }
  async function admit(request: AgentCollaborationRequest, sources: LoopCollaborationInput['sources']) {
    if (!request.review || request.review.profileId !== INVENTORY_REVIEW_PROFILE.profileId || !request.consent ||
        sources.length < 1 || sources.length > 8 || request.route === 'nectovia')
      return reviewRefused('Select the fixed review and one to eight shared sources on an admitted direct root.');
    const state = deps.store.state(request.projectId);
    if (!state.tasks.some(task => task.id === request.taskId && !task.deletedAt)) return reviewRefused('The review task no longer exists.');
    const selected = await configured(request.projectId);
    if (selected.connection.id !== request.review.connectionId) return reviewRefused('The selected review connection changed.');
    const policy = sharing(request.projectId, sources.map(source => source.path));
    const reference = await deps.authorityRef(request.projectId);
    await trust(reference, request.projectId, request.principal.tenantId, 'dispatch');
    for (const source of sources) {
      const current = (await deps.store.readDocument(request.projectId, source.path)).text;
      if (typeof current !== 'string' || rawDigest(current) !== source.sha256) return reviewRefused('Selected review source bytes changed.');
    }
    // Deterministic for repeated re-admission; current Trust/config/policy changes revoke the pin.
    const seed = { rootRunId: request.rootRunId, rootJobId: request.rootJobId, projectId: request.projectId,
      taskId: request.taskId, principalId: request.principal.id, sources };
    const grant = agentReviewGrantSchema.parse({
      version: 1, grantId: `review-${digest(seed).slice(0, 40)}`,
      revocationId: `review-revocation-${digest({ reference, qualification: selected.q, sharing: policy }).slice(0, 40)}`,
      revocationRevision: selected.q.revision, ...seed, sources: sources.map(source => ({ sourceId: source.path, digest: source.sha256 })),
      tenantId: request.principal.tenantId, identityGeneration: request.principal.identityGeneration,
      profileId: INVENTORY_REVIEW_PROFILE.profileId, profileRevision: 1, profileDigest: reviewProfileDigest,
      route: { provider: 'openrouter', connectionId: selected.connection.id, modelId: reviewModel },
      account: { id: selected.q.accountId, revision: selected.connection.revision, digest: selected.q.accountDigest },
      dataPolicyDigest: digest(selected.provider), reportDigest: '0'.repeat(64), maxCalls: 1,
    });
    const { reportDigest: _reportDigest, ...pin } = grant;
    return pin;
  }
  async function host(given: AgentReviewGrant, reportText: string): Promise<AgentReviewHost> {
    const grant = agentReviewGrantSchema.parse(structuredClone(given));
    if (typeof reportText !== 'string' || rawDigest(reportText) !== grant.reportDigest) return reviewRefused('The report differs from its exact review grant.');
    const { reportDigest: _reportDigest, ...scopePin } = grant;
    async function root(phase: 'dispatch' | 'result') {
      const admission = await deps.rootAdmission(grant.rootRunId);
      if (!admission || digest(admission.review) !== digest(scopePin) || admission.rootJobId !== grant.rootJobId)
        return reviewRefused('The persisted review root is revoked or changed.');
      const run = await deps.runs.get(grant.rootRunId);
      if (['cancelled', 'failed', 'completed', 'reconcile_required'].includes(run.state) || run.capabilityId !== 'diomedes-loop' ||
          run.projectId !== grant.projectId || run.taskId !== grant.taskId || digest(run.principal) !== digest(admission.principal))
        return reviewRefused('The root review is stopped, changed or requires reconciliation.');
      const reportPin = run.steps.find(step => step.intent.stepId === 'agent-review:grant' && step.state === 'succeeded');
      if (!reportPin || digest(reportPin.output) !== digest({ grant, reportText })) return reviewRefused('The exact report is not durably pinned on this root.');
      // Preserve inherited restrictions; the direct Decisions path has no proof for additional rules.
      if (sourceRules(run).length) return reviewRefused('This direct review cannot enforce the root source restrictions.');
      await trust(admission.authorityRef, grant.projectId, grant.tenantId, phase);
      const gate = deps.engines.agentGate;
      if (!gate) return reviewRefused('The current paid account admission is unavailable.');
      const paid = await gate.check({ projectId: grant.projectId, rootJobId: grant.rootJobId, phase: 'dispatch', surface: 'loop', routeKind: 'byo' });
      if (digest({ organizationId: paid.organizationId, personId: paid.personId, planId: paid.planId,
          scope: paid.scope ?? null, policyRevision: paid.policyRevision, routeKind: paid.routeKind }) !== admission.paidAdmissionDigest)
        return reviewRefused('The paid account or policy differs from the root admission.');
      const request: AgentCollaborationRequest = { projectId: admission.projectId, taskId: admission.taskId,
        rootRunId: admission.rootRunId, rootJobId: admission.rootJobId, commandId: admission.commandId,
        principal: admission.principal, route: admission.route, model: admission.model, accountRoute: admission.accountRoute,
        sources: admission.sources.map(source => source.path), consent: true, review: admission.reviewSelection };
      if (digest(await admit(request, admission.sources)) !== digest(scopePin)) return reviewRefused('The current review qualification, Trust or disclosure policy changed.');
      return admission;
    }
    const admission = await root('dispatch');
    const ledger = await deps.rootLedger(admission);
    if (ledger.jobScope?.id !== grant.rootJobId) return reviewRefused('The review needs the original root scoped ledger.');
    return {
      scopedLedger: ledger, currentAuthority: deps.currentAuthority,
      resolveAdmission: async (id, phase) => {
        if (id !== grant.grantId) return null;
        const current = await root(phase);
        if (await deps.rootLedger(current) !== ledger) return reviewRefused('The original root ledger object changed.');
        return { grant, authorityRef: current.authorityRef, dataPolicyDigest: grant.dataPolicyDigest };
      },
      resolveProfile: async id => id === INVENTORY_REVIEW_PROFILE.profileId ? INVENTORY_REVIEW_PROFILE : reviewRefused('The fixed review profile changed.'),
      resolveMaterial: async (_grant, phase) => {
        await root(phase);
        const policy = sharing(grant.projectId, grant.sources.map(source => source.sourceId));
        const label = (id: string, contentDigest: string): HarnessLabel => ({
          tenantId: grant.tenantId, projectId: grant.projectId, integrity: 'untrusted', confidentiality: 'internal',
          provenance: [`project:${grant.projectId}:${id}:${contentDigest}`, `cloud-sharing:${policy.version}`],
        });
        const sources = await Promise.all(grant.sources.map(async source => {
          const text = (await deps.store.readDocument(grant.projectId, source.sourceId)).text;
          if (typeof text !== 'string' || rawDigest(text) !== source.digest) return reviewRefused('Selected source bytes changed before review.');
          return { sourceId: source.sourceId, text, label: label(source.sourceId, source.digest) };
        }));
        return { sources, report: { text: reportText, label: label(`report:${grant.taskId}`, grant.reportDigest) } };
      },
      resolveTransport: async request => {
        const binding: AgentReviewTransportBinding = { grantId: grant.grantId, rootRunId: grant.rootRunId,
          projectId: grant.projectId, taskId: grant.taskId, rootJobId: grant.rootJobId, stepId: request.stepId,
          route: 'openrouter', connectionId: grant.route.connectionId, modelId: reviewModel, accountId: grant.account.id,
          accountRevision: grant.account.revision, accountDigest: grant.account.digest, dataPolicyDigest: grant.dataPolicyDigest,
          maxInputTokens: request.maxInputTokens, maxCalls: 1 };
        return createAgentReviewTransport({ binding, ledger, stateDigest: request.stateDigest,
          ...(deps.modelApiTransport ? { fetch: deps.modelApiTransport } : {}),
          resolveCurrent: async signal => {
            signal.throwIfAborted();
            const current = await root('dispatch');
            if (await deps.rootLedger(current) !== ledger) return reviewRefused('The review root ledger changed during dispatch.');
            const live = await configured(grant.projectId);
            const liveBinding = { ...binding, connectionId: live.connection.id, accountId: live.q.accountId,
              accountRevision: live.connection.revision, accountDigest: live.q.accountDigest, dataPolicyDigest: digest(live.provider) };
            if (digest(liveBinding) !== digest(binding)) return reviewRefused('The current review account binding changed before credential access.');
            const apiKey = await live.api.secrets.get(live.connection.id);
            if (secretFingerprint(apiKey) !== live.connection.credential.fingerprint) return reviewRefused('The protected review credential changed.');
            const afterSecret = await configured(grant.projectId);
            if (digest(afterSecret.q) !== digest(live.q) || digest(afterSecret.connection) !== digest(live.connection))
              return reviewRefused('Review qualification changed while its credential was opening.');
            await root('dispatch');
            signal.throwIfAborted();
            return { binding: liveBinding, apiKey, provider: live.provider, qualification: live.qualification };
          },
        });
      },
    };
  }
  return { admit, host, async offers(projectId) {
    const connectionId = deps.engines.modelApi?.openrouter?.connections.peek()?.id ?? 'openrouter-1';
    const offer = { profileId: INVENTORY_REVIEW_PROFILE.profileId as 'agent.inventory-reconciliation',
      name: 'Inventory report review', connectionId, model: reviewModel, admitted: false, reason: null as string | null };
    try {
      const selected = await configured(projectId);
      const reference = await deps.authorityRef(projectId);
      const authority = requireGenuine(await deps.currentAuthority({ via: 'stored-reference', ref: reference }));
      if (isDenial(authority) || reference.kind === 'team-member' || digest(refOf(authority)) !== digest(reference))
        return [{ ...offer, reason: 'The genuine current review authority is unavailable.' }];
      sharing(projectId, []);
      const key = await selected.api.secrets.get(selected.connection.id);
      if (secretFingerprint(key) !== selected.connection.credential.fingerprint) return [{ ...offer, reason: 'The protected review credential changed.' }];
      return [{ ...offer, connectionId: selected.connection.id, admitted: true }];
    } catch (error) {
      return [{ ...offer, reason: error instanceof HarnessError ? error.message : 'The fixed review is not currently qualified on this host.' }];
    }
  } };
}
