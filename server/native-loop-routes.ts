/**
 * H13 routes: start a Diomedes work loop on a task, and read it back.
 *
 * Starting is admission and nothing more. It checks, in order: the task, the
 * route (the scripted fixture, a Diomedes-owned model-API route, or Nectovia
 * managed single-agent only; an external engine drives its own loop and is not
 * offered here), that the route is on (the app's own route-on: the Settings
 * switch, or for the local model that it is set up here and running the asked
 * profile now, read without starting it; Nectovia bypasses it and resolves its
 * managed model/account through the `managed` dependency below), the person's
 * consent to send, the project's sharing grant for every selected file, and the
 * route's own admission (connection, model, credential, spend cap; for Nectovia
 * the Agent gate's managed admission under the loop's deterministic run id).
 * A team's roles are admitted before their lead, so a role that refuses leaves
 * nothing admitted for the lead. A delegate route,
 * when the person names one, is admitted the same way now and again when the
 * loop hands it work; a Nectovia lead never runs with a delegate or a team the
 * person names. Under any other lead a team role may be Nectovia at a tier the
 * role names (DIO-216), admitted on the managed loop's own checks and the
 * account's escalation control, and a local lead started with no team takes a
 * Focused worker and a Thorough advisor by default where the account allows them.
 * A Nectovia lead's one exception (S3) is a worker on the person's own coding tool,
 * resolved here from their subscription worker preference for Personal work, on
 * the person's own start only and only once they confirmed the tools it may go
 * to. A host start (Board work, the Ready queue, a follow-up) never takes one, so
 * scheduled work never runs on a person's subscription (D12).
 * The run is created through the bridge with its admission pinned, so a replay
 * of the same command id returns the same run and admits nothing new.
 *
 * Reading projects the loop from its steps (`shared/native-loop.ts`) and the
 * finish from H17's four-state projection of the task's declared checks. No
 * state is stored for the view.
 */
import { createHash } from 'node:crypto';
import type { Express, NextFunction, Request, Response } from 'express';
import { z } from 'zod';
import type { HarnessPrincipal, Json } from '../shared/harness.js';
import { agentTeamSelectionSchema } from '../shared/agent-collaboration.js';
import { agentReviewSelectionSchema } from '../shared/agent-review.js';
import type { AgentCollaborationHost } from './harness/agent-collaboration.js';
import type { SpendExposure } from './spend-exposure.js';
import { REPORT_PATH } from './harness/approval.js';
import { isModelApiRoute, MODEL_API_NAMES, MODEL_API_PROVIDERS, NECTOVIA_ROUTE } from '../shared/model-api.js';
import { localContextBudget, localSourceRefusal, LOCAL_MODEL_ROUTE } from '../shared/local-model.js';
import { LOCAL_MODEL_NOT_INSTALLED } from './bonsai/runtime.js';
import type { EscalationRole, EscalationView } from '../shared/escalation-controls.js';
import {
  ADVISOR_NEEDS_WORKER,
  DEFAULT_ESCALATION_ROLES,
  NECTOVIA_ROLE_CREDITS,
  escalationConsentText,
  escalationRefusal,
  nectoviaRoleConsentText,
  nectoviaTierName,
  type EscalationOffer,
  type EscalationRecord,
  type EscalationRoleKind,
  type RoleTier,
} from '../shared/escalation-roles.js';
import { ROUTING_TIERS } from '../shared/routing-policy.js';
import {
  LOOP_LIMITS,
  NATIVE_LOOP_CAPABILITY,
  loopOutcome,
  loopView,
  type LoopRouteOffer,
  type LoopRunInput,
} from '../shared/native-loop.js';
import { ApiError, relativeName } from './paths.js';
import { NECTOVIA_EFFORT, NECTOVIA_LOOP_REFUSED } from './engines/nectovia.js';
import { EngineError } from './engines/process.js';
import { AGENT_NOT_INCLUDED, AGENT_SIGN_IN_REQUIRED } from './accounts/agent-gate.js';
import type { Store } from './store.js';
import { cloudSharing, requireCloudSharing } from './cloud-sharing.js';
import { assembleInstructions, instructionSectionBudget } from './harness/instruction-delivery.js';
import { localHarnessPrincipal } from './harness/bridge.js';
import { LOOP_FIXTURE_ROUTE } from './harness/capabilities/native-loop.js';
import { HarnessError, digest } from './harness/policy.js';
import type { HarnessHost } from './harness/host.js';
import type { VerificationService } from './verification/service.js';
import type { WorkControlDriver } from './durable-controls.js';
import { ROUTE_CONTRACTS } from './harness/route-contract.js';
import type { AdapterRouteContract } from '../shared/adapter-contract.js';
import type { AgentProfileService } from './agent-profiles.js';
import type { AgentRegistry } from './agents.js';
import { AGENT_CATALOG, AUTO_AGENT, type AgentDefinition } from '../shared/agents.js';
import { resolveProfileRoute, profileLabel } from '../shared/agent-profiles.js';
import {
  EXTERNAL_WORKER_LIMITS,
  EXTERNAL_WORKER_ROUTES,
  TEAM_LIMITS,
  budgetRefusal,
  executionOf,
  isExternalWorkerRoute,
  localRoleWallMs,
  type ExternalWorkerRoute,
  type TeamConfig,
  type TeamRetry,
  type TeamRole,
} from '../shared/team-delegation.js';
import { routeName as engineName } from './harness/external-worker.js';
import { CODEX_ACCOUNT_ROUTE } from './engines/codex-session.js';
import type { SubscriptionWorkerChoice, SubscriptionWorkers } from './subscription-workers.js';
import {
  reserveRefusal,
  type SubscriptionReserve,
  type SubscriptionWorkerRecord,
  type SubscriptionWorkerStartView,
} from '../shared/subscription-workers.js';
import type { Route, Session } from '../shared/types.js';
import { OWNER_RULES_NOT_INCLUDED_REASON } from '../shared/access.js';
import { isManualCard, MANUAL_CARD_LOOP_REFUSED, taskWorkflowBlocker } from '../shared/task-workflow.js';
import type { WorkAdmission } from './work-admission.js';
import type { PackContributions } from './pack-contributions.js';
import { prepareTaskSkill } from './task-skills.js';

const routeName = z.string().min(1).max(40);
/** One team role as the person names it: an Agent, and either an H09 profile or a route. */
const roleSchema = z.strictObject({
  agentId: z.string().min(1).max(120).optional(),
  profileId: z.string().min(1).max(120).optional(),
  route: routeName.optional(),
  model: z.string().min(1).max(200).nullable().optional(),
  accountRoute: z.string().min(1).max(400).nullable().optional(),
  /** A Nectovia role under another lead names the tier it runs at, never a model (DIO-216). */
  tier: z.enum(ROUTING_TIERS).optional(),
});
const startSchema = z.strictObject({
  protocolVersion: z.literal(1),
  commandId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/),
  taskId: z.string().min(1).max(100),
  goal: z.string().trim().min(1).max(16_000),
  route: routeName,
  model: z.string().min(1).max(200).nullable().optional(),
  accountRoute: z.string().min(1).max(400).nullable().optional(),
  effort: z.enum(['low', 'medium', 'high', 'xhigh']).nullable().optional(),
  consent: z.boolean().optional(),
  /**
   * S3: the coding tools the person confirmed a task may go to, under the consent text they read.
   * A start that would hand tasks to their tools needs it to name exactly those tools.
   */
  workerConsent: z
    .strictObject({
      revision: z.string().min(1).max(40),
      engines: z.array(z.enum(EXTERNAL_WORKER_ROUTES)).min(1).max(EXTERNAL_WORKER_ROUTES.length),
    })
    .optional(),
  maxTurns: z.number().int().min(1).max(LOOP_LIMITS.maxTurns).optional(),
  sources: z.array(z.string().min(1).max(400)).max(32).optional(),
  persistentTeam: agentTeamSelectionSchema.nullable().optional(),
  review: agentReviewSelectionSchema.nullable().optional(),
  composition: z.literal(true).optional(),
  delegate: z
    .strictObject({
      /** Absent when an H09 profile names it (Andrew, 2026-09-24: delegate routes come from profiles). */
      route: routeName.optional(),
      model: z.string().min(1).max(200).nullable().optional(),
      accountRoute: z.string().min(1).max(400).nullable().optional(),
      profileId: z.string().min(1).max(120).optional(),
    })
    .refine((value) => Boolean(value.route || value.profileId), { message: 'Name a route or a profile for the delegate.' })
    .nullable()
    .optional(),
  /**
   * The files and folders this loop may apply its delegates' and workers' changes in without
   * asking again (`.` is the whole project). Absent: every change they return waits for you.
   */
  applyScope: z.array(z.string().min(1).max(400)).min(1).max(32).nullable().optional(),
  /**
   * DIO-216: a local lead started with no team takes default Nectovia roles. `true` confirms the
   * ones that can join; `false` starts without them. Absent: the start asks first.
   */
  escalation: z.boolean().optional(),
  /** H14: workers and an advisor for this lead. */
  team: z
    .strictObject({
      scope: z.array(z.string().min(1).max(400)).min(1).max(64).nullable().optional(),
      worker: roleSchema.extend({
        budget: z
          .strictObject({
            turns: z.number().int().optional(),
            tokens: z.number().int().nullable().optional(),
            wallMs: z.number().int().nullable().optional(),
          })
          .optional(),
      }),
      advisor: roleSchema.nullable().optional(),
    })
    .nullable()
    .optional(),
}).refine((request) => request.effort !== 'xhigh' || request.route === 'azure-openai', {
  path: ['effort'], message: 'Only the Azure owner route accepts an extra-high loop effort.',
});
export type LoopStartRequest = z.infer<typeof startSchema>;

export interface LoopHostStart {
  retryOf?: TeamRetry | null;
  team?: TeamConfig | null;
  admission?: WorkAdmission;
  principal?: HarnessPrincipal;
  rootJobId?: string;
  rootJobRequestId?: string;
  threadId?: string | null;
  scopedLedger?: SpendExposure;
  qualityStatus?: 'hypothesis' | 'measured';
  selectionReason?: string;
  /** The exact pre-effect Session left by a process exit before this run file existed. */
  preparedSessionId?: string;
  /** Host-selected helper-only composition; ordinary H14 profile requests keep their existing contract. */
  compose?: boolean;
  /**
   * The person's own start of this loop, from the loop start route. Only such a start takes a
   * worker from their subscription worker preference (S3); a host start never does (D12).
   */
  personStart?: boolean;
}
export interface NativeCollaborationDeps {
  host: AgentCollaborationHost;
  rootLedger?(projectId: string, rawJobId: string, threadId: string | null): Promise<SpendExposure>;
}

/** One command id names one run, in this project, forever. */
export function loopRunId(projectId: string, commandId: string): string {
  return `R${createHash('sha256').update(`diomedes-loop\0${projectId}\0${commandId}`).digest('hex').slice(0, 12)}`;
}

const loopRoute = (route: string) => route === LOOP_FIXTURE_ROUTE || isModelApiRoute(route);

/** Tools by name for one sentence: "Codex", "Codex or Claude Code", "Codex, Claude Code or OpenCode". */
function engineNames(routes: readonly ExternalWorkerRoute[]): string {
  const names = routes.map(engineName);
  return names.length <= 1 ? (names[0] ?? '') : `${names.slice(0, -1).join(', ')} or ${names.at(-1)}`;
}

/** What H14 admission reads to resolve a team role: H09 profiles and the Agent catalog. */
export interface TeamAdmission {
  readonly profiles: AgentProfileService;
  readonly agents: AgentRegistry;
}

/**
 * Nectovia managed loop dependencies, supplied by the parent (app.ts) from the
 * signed-in account and its published tier. All read-only unless they admit:
 * `resolveManaged` names the managed model/account without recording a paid
 * admission; `readOnly` answers the routes offer the same way; `admitManaged`
 * records the paid managed admission under the loop's deterministic run id.
 * Absent: Nectovia loop starts fail closed and the routes offer reads
 * unavailable, never admitted. Never a BYO provider or payer.
 */
export interface NectoviaManagedLoopDeps {
  resolveManaged?: (
    projectId: string,
    taskId: string,
  ) => Promise<{ model: string; accountRoute: string } | null> | { model: string; accountRoute: string } | null;
  readOnly?: (
    projectId: string,
  ) => Promise<{ admitted: boolean; model: string | null; reason: string | null }> | { admitted: boolean; model: string | null; reason: string | null };
  admitManaged?: (
    projectId: string,
    runId: string,
    input: { model: string; accountRoute: string },
    taskId: string,
    /** Already validated host spend scope; the run id remains the raw request id. */
    rootJobId?: string,
  ) => Promise<{ model: string; accountRoute: string }>;
  /**
   * DIO-216: the managed model and account at one tier, with the managed loop's own checks (signed
   * in, the Agent and managed usage included, a published model for the tier). `fresh` reads the
   * account's routing again first. Records nothing.
   */
  managedTier?: (projectId: string, tier: RoleTier, fresh: boolean) => Promise<{ model: string; accountRoute: string }>;
  /** The account's escalation control, read again when `fresh`. Null: it could not be read. */
  escalation?: (projectId: string, fresh: boolean) => Promise<EscalationView | null>;
  /** The paid managed admission of a Nectovia role under another lead, under the role's own job. */
  admitManagedRole?: (
    projectId: string,
    jobId: string,
    input: { model: string; accountRoute: string },
    tier: RoleTier,
    role: EscalationRole,
    rootJobId: string,
  ) => Promise<{ model: string; accountRoute: string }>;
  /**
   * Keep going on a loop that stopped at its check-in: the earlier job's amount is raised by one more, for
   * the job the new attempt runs under, which continues it. Called before the attempt starts, with the raw
   * request id of the job that stopped and of the new one. A refusal stops the attempt from starting.
   */
  keepGoing?: (projectId: string, fromJobId: string, jobId: string) => Promise<void>;
}

/** The ids a role is admitted under: the lead's run and its root job. */
interface RoleIds {
  readonly runId: string;
  readonly rootJobId?: string;
}

/**
 * Whether a route takes work, as the parent (app.ts) decides it for every other send. Absent:
 * the Settings switch decides every route, as it always has.
 */
export interface LoopRouteGates {
  /** The app's own `routeOn`: the Settings switch, or for the local model that it is set up here. */
  on(route: string): boolean;
  /**
   * Null when the local model is running this profile now; otherwise the runtime's own sentence.
   * It reads the status and never starts or switches the model.
   */
  localRefusal(model: string | null): Promise<string | null>;
}

/** Nectovia takes no delegate and no team the person names; S3's host-resolved worker is the only team beside it. */
export const NECTOVIA_LOOP_TEAM_REFUSED =
  'A Nectovia loop can’t take a delegate or a team you name. Nothing was sent.';

const WORKER_AGENT = 'diomedes.general';
const ADVISOR_AGENT = 'diomedes.architect';
/** What a lead hands each role, in preference order; the Agent must accept one of them. */
const ARTIFACTS = {
  worker: ['plan.markdown', 'findings.list', 'answer.text'],
  advisor: ['answer.text', 'findings.list', 'plan.markdown'],
} as const;

export function mountNativeLoopRoutes(
  app: Express,
  store: Store,
  harness: HarnessHost,
  verification: VerificationService,
  teamAdmission: TeamAdmission | null = null,
  /**
   * Whether the work's business holds 'owner-rules' (Andrew, 2026-09-25),
   * resolved through the account session the way the Agent gate does. The
   * default passes everything through, the embedded-host behaviour.
   */
  ownerRules: (projectId: string | null) => boolean = () => true,
  /**
   * Nectovia managed loop wiring (optional). The parent supplies
   * `resolveManaged` from the signed-in account and its published tier, and
   * optionally `admitManaged`/`readOnly`. Extra params stay trailing so
   * existing callers keep working. `startLocked` also accepts an optional
   * `managedAdmission` extra (see below) for a Work receipt the parent may
   * record in app after bridge admission.
   */
  managed: NectoviaManagedLoopDeps | null = null,
  contributions: (() => PackContributions) | null = null,
  collaboration: NativeCollaborationDeps | null = null,
  /** S3: the person's subscription worker preference. Absent: a Nectovia lead never takes a worker. */
  subscription: SubscriptionWorkers | null = null,
  /** The app's route-on and the local model's status read. Absent: the Settings switch alone. */
  gates: LoopRouteGates | null = null,
) {
  if (collaboration) harness.loop.attachCollaboration(collaboration.host);
  const collaborationHost = () => collaboration?.host ?? harness.loop.collaboration?.() ?? null;
  const handle =
    (action: (req: Request) => Promise<unknown>) => async (req: Request, res: Response, next: NextFunction) => {
      try {
        res.json(await action(req));
      } catch (error) {
        if (error instanceof HarnessError)
          next(new ApiError(error.code === 'unknown_run' ? 404 : 409, harness.redact(error.message), { code: error.code }));
        else next(error);
      }
    };
  const services = () => (store.settings.services ?? {}) as Record<string, unknown>;

  /** The route's own admission, fresh; for a model-API route the saved model and account route by default. */
  const admitRoute = async (
    projectId: string,
    route: string,
    requested: { model?: string | null; accountRoute?: string | null },
    sources: readonly string[],
    consent: boolean,
    opts: { taskId?: string | null; runId?: string | null; rootJobId?: string; threadId?: string | null; effort?: string | null } = {},
  ) => {
    if (!loopRoute(route))
      throw new ApiError(400, 'A Diomedes loop runs on the fixture route or a model-API route. An external engine keeps its own loop.', {
        code: 'loop_route_unsupported',
      });
    if (route === LOOP_FIXTURE_ROUTE) return { model: null, accountRoute: null };
    if (route === NECTOVIA_ROUTE) {
      // Managed single-agent only. The Settings service switch is bypassed for
      // Nectovia ONLY: the model/account come from the managed dependency, set
      // by the parent from the signed-in account and its published tier. A
      // user-supplied model/account that conflicts is refused (no BYO, no
      // payer switch); nothing falls back to another provider.
      if (!consent)
        throw new ApiError(
          409,
          'Your goal and the files the loop reads will be sent to Nectovia. Confirm before sending.',
          { consentRequired: true },
        );
      requireCloudSharing(store.state(projectId), route, sources);
      const resolved = opts.taskId ? await managed?.resolveManaged?.(projectId, opts.taskId) : null;
      if (!resolved)
        throw new ApiError(409, 'Sign in to use the Nectovia Agent.', { code: 'route_refused' });
      if (requested.model != null && requested.model !== resolved.model)
        throw new ApiError(409, 'The Nectovia model is managed. Send without choosing one.', { code: 'route_refused' });
      if (requested.accountRoute != null && requested.accountRoute !== resolved.accountRoute)
        throw new ApiError(409, 'The Nectovia account is managed. Send without choosing one.', { code: 'route_refused' });
      try {
        // Paid managed admission under the loop's deterministic run id, when
        // the parent supplied the seam. Without it this stays read-only and
        // the per-step adapter admits with the real run id; never a null job.
        if (managed?.admitManaged && opts.runId)
          return await managed.admitManaged(projectId, opts.runId, resolved, opts.taskId!, opts.rootJobId);
        return resolved;
      } catch (error) {
        if (error instanceof ApiError) throw error;
        if (error instanceof EngineError && (error.code === AGENT_NOT_INCLUDED || error.code === AGENT_SIGN_IN_REQUIRED)) throw error;
        throw new ApiError(409, error instanceof Error ? error.message : 'This route refused the loop.', { code: 'route_refused' });
      }
    }
    if (route === LOCAL_MODEL_ROUTE && gates) {
      // The local model has no Settings switch: it is on where it is set up. A send never starts it,
      // so a profile that isn't running refuses here, before consent, sharing or any admission.
      const refusal = gates.on(route) ? await gates.localRefusal(requested.model ?? null) : LOCAL_MODEL_NOT_INSTALLED;
      if (refusal) throw new ApiError(409, refusal, { code: 'local_model_not_ready' });
    } else if (!(gates ? gates.on(route) : services()[route] === true))
      throw new ApiError(409, 'Turn the selected route on in Settings before using it.');
    if (!consent)
      throw new ApiError(
        409,
        'Your goal and the files the loop reads will be sent to the selected service. Confirm before sending.',
        { consentRequired: true },
      );
    requireCloudSharing(store.state(projectId), route, sources);
    const model = requested.model ?? (typeof services()[`${route}Model`] === 'string' ? (services()[`${route}Model`] as string) : null);
    const accountRoute =
      requested.accountRoute ??
      (typeof services()[`${route}AccountRoute`] === 'string' ? (services()[`${route}AccountRoute`] as string) : null);
    try {
      return await harness.loop.admit(route, { projectId, model, accountRoute, rootRunId: opts.runId ?? undefined,
        rootJobId: opts.rootJobId, threadId: opts.threadId, effort: opts.effort });
    } catch (error) {
      if (error instanceof ApiError) throw error;
      // The Agent gate's refusal is the business's plan, not the route: it answers as every Agent
      // entry point does (403 AGENT_NOT_INCLUDED, or 401 to sign in).
      if (error instanceof EngineError && (error.code === AGENT_NOT_INCLUDED || error.code === AGENT_SIGN_IN_REQUIRED)) throw error;
      throw new ApiError(409, error instanceof Error ? error.message : 'This route refused the loop.', { code: 'route_refused' });
    }
  };

  /**
   * S2: a team worker on the person's own installed coding tool. Its Settings switch, consent
   * naming it, cloud sharing for its files, then the tool's own fresh admission: install,
   * sign-in, model and account route. Never a lead, never an advisor, never a Nectovia lead's
   * unless the host chose it (S3). A reserve the person keeps is read on that same admission.
   */
  const admitExternalWorkerRoute = async (
    projectId: string,
    route: ExternalWorkerRoute,
    requested: { model?: string | null; accountRoute?: string | null },
    sources: readonly string[],
    consent: boolean,
    reserve?: SubscriptionReserve,
  ) => {
    const name = engineName(route);
    if (services()[route] !== true) throw new ApiError(409, `Turn ${name} on in Settings before giving it work.`);
    if (!consent)
      throw new ApiError(
        409,
        `This worker's task and files go to ${name}, signed in with your own account. Confirm before sending.`,
        { consentRequired: true },
      );
    requireCloudSharing(store.state(projectId), route, sources);
    const saved = (key: string) => (typeof services()[key] === 'string' ? (services()[key] as string) : null);
    const model = requested.model ?? saved(`${route}Model`);
    const accountRoute =
      requested.accountRoute ?? (route === 'codex' ? (saved('codexAccountRoute') ?? CODEX_ACCOUNT_ROUTE) : saved(`${route}AccountRoute`));
    let admitted: Awaited<ReturnType<typeof harness.loop.admitExternalWorker>>;
    try {
      admitted = await harness.loop.admitExternalWorker(route, { projectId, model, accountRoute });
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw new ApiError(409, error instanceof Error ? error.message : `${name} refused this worker.`, { code: 'route_refused' });
    }
    const kept = reserve ? reserveRefusal(reserve, admitted.usage, Date.now(), name) : null;
    if (kept) throw new ApiError(409, kept, { code: 'subscription_reserve' });
    return admitted;
  };

  /**
   * H14: resolve one team role. A named H09 profile decides the route and model
   * by H09's own rules (fallback only where the person turned it on); otherwise
   * the route named here, or the lead's. The route is admitted in its own right,
   * and the Agent must exist and accept what a lead hands it. An advisor's Agent
   * must be one that never writes.
   */
  const admitRole = async (
    projectId: string,
    taskId: string,
    kind: 'worker' | 'advisor',
    spec: z.infer<typeof roleSchema>,
    lead: LoopStartRequest,
    scope: readonly string[],
    consent: boolean,
    // S2: only a team's worker may run on the person's own installed coding tool, never a delegate.
    teamWorker = false,
    // S3: the part of the tool's usage limit the person keeps, for a worker the host chose.
    reserve?: SubscriptionReserve,
    // DIO-216: the lead's run and root job, which a Nectovia role is admitted under. A delegate has none.
    ids?: RoleIds,
  ): Promise<TeamRole & { effort: string | null }> => {
    const state = store.state(projectId);
    const refuse = (message: string, code = 'team_role_refused') => new ApiError(409, message, { code, role: kind });
    let route = spec.route ?? lead.route;
    let model = spec.model ?? (spec.route ? null : (lead.model ?? null));
    let accountRoute = spec.accountRoute ?? (spec.route ? null : (lead.accountRoute ?? null));
    let agentId = spec.agentId ?? null;
    let profile: TeamRole['profile'] = null;
    // Direct H14 roles keep the adapter's existing medium default. A saved
    // profile below may instead pin an explicit effort, including null.
    let effort: string | null = 'medium';
    if (spec.profileId) {
      if (!teamAdmission) throw refuse('Agent profiles cannot be used for a team in this process.');
      const preference = teamAdmission.profiles.profiles.routing(projectId, taskId);
      const routed = resolveProfileRoute({
        source: preference.source,
        order: [spec.profileId, ...preference.order.filter((id) => id !== spec.profileId)],
        fallback: preference.fallback,
        candidates: await teamAdmission.profiles.candidates(state.project.folder),
      });
      if (routed.outcome !== 'resolved')
        throw refuse(routed.outcome === 'refused' ? routed.reason : 'That profile was not found.', 'team_profile_refused');
      const pick = routed.pick;
      if (!loopRoute(pick.engine) && !(teamWorker && isExternalWorkerRoute(pick.engine)))
        throw refuse(`${profileLabel(pick)} runs on a route that keeps its own loop, so it cannot be a ${kind} here.`);
      route = pick.engine;
      model = pick.model;
      effort = pick.effort;
      accountRoute = null;
      if (!agentId && pick.agentId !== AUTO_AGENT) agentId = pick.agentId;
      profile = {
        profileId: pick.profileId,
        revision: pick.revision,
        name: pick.name,
        digest: pick.digest,
        source: pick.source,
        fallback: pick.fallback ? `${pick.fallback.fromName}: ${pick.fallback.reason}` : null,
      };
    }
    if (spec.tier && route !== NECTOVIA_ROUTE)
      throw new ApiError(400, 'Only a Nectovia role names a tier.', { code: 'team_role_invalid', role: kind });
    let tier: RoleTier | null = null;
    if (route === NECTOVIA_ROUTE) {
      // Nectovia takes no role under its own lead, as a delegate or by a saved profile. Under another
      // lead a role names its tier and runs at it, on the account's credits (DIO-216 slice C).
      if (lead.route === NECTOVIA_ROUTE || !ids || profile) throw refuse(NECTOVIA_LOOP_TEAM_REFUSED, 'team_route_unsupported');
      if (!spec.tier)
        throw new ApiError(400, 'A Nectovia role names its tier: efficient, focused or thorough.', { code: 'team_role_invalid', role: kind });
      if (spec.model != null) throw refuse('The Nectovia model is managed. Send without choosing one.', 'route_refused');
      if (spec.accountRoute != null) throw refuse('The Nectovia account is managed. Send without choosing one.', 'route_refused');
      tier = spec.tier;
      // The effort each tier asks for, as a Nectovia lead at that tier would.
      effort = NECTOVIA_EFFORT[tier];
    }
    const resolved = route;
    const external = isExternalWorkerRoute(resolved);
    if (external && !teamWorker)
      throw refuse(`${engineName(resolved)} can be a worker on a team, not ${kind === 'advisor' ? 'an advisor' : 'a delegate'}.`, 'team_route_unsupported');
    const admitted = tier && ids
      ? await admitNectoviaRole(projectId, kind, tier, scope, consent, ids)
      : external
        ? await admitExternalWorkerRoute(projectId, resolved, { model, accountRoute }, scope, consent, reserve)
        : await admitRoute(projectId, resolved, { model, accountRoute }, scope, consent);
    const wanted = agentId ?? (kind === 'advisor' ? ADVISOR_AGENT : WORKER_AGENT);
    const agent: AgentDefinition | undefined = teamAdmission
      ? await teamAdmission.agents.find(wanted, state.project.folder)
      : AGENT_CATALOG.find((item) => item.id === wanted);
    if (!agent) throw refuse(`The ${wanted} Agent is not available in this project.`);
    if (kind === 'advisor' && agent.permissionCeiling !== 'review')
      throw refuse(`${agent.name} may change things, so it cannot be an advisor. An advisor only reads.`);
    const artifact = ARTIFACTS[kind].find((item) => (agent.handoff.accepts as readonly string[]).includes(item));
    if (!artifact) throw refuse(`${agent.name} accepts no handoff a lead can give it.`);
    return {
      agent: { id: agent.id, version: agent.version, name: agent.name, ceiling: agent.permissionCeiling },
      guidance: agent.role,
      artifact,
      route,
      model: admitted.model,
      accountRoute: admitted.accountRoute,
      // Only an external worker names how it works, so a loop role's saved shape is unchanged.
      ...(external ? { execution: 'external-proposal' as const } : {}),
      ...(tier ? { tier } : {}),
      profile,
      effort,
    };
  };

  /**
   * DIO-216 slice C: a Nectovia role under a lead that is not Nectovia. The managed loop's own
   * checks in its order (consent, the project's sharing with Nectovia, signed in with the Agent and
   * managed usage, the tier's published model), then the account's escalation control for the tier,
   * which refuses when it can't be read, then the paid managed admission under the role's own job.
   */
  const admitNectoviaRole = async (
    projectId: string,
    kind: EscalationRoleKind,
    tier: RoleTier,
    scope: readonly string[],
    consent: boolean,
    ids: RoleIds,
  ): Promise<{ model: string | null; accountRoute: string | null }> => {
    if (!consent) throw new ApiError(409, nectoviaRoleConsentText(kind, tier), { consentRequired: true, role: kind });
    requireCloudSharing(store.state(projectId), NECTOVIA_ROUTE, scope);
    if (!managed?.managedTier || !managed.escalation || !managed.admitManagedRole)
      throw new ApiError(409, 'Sign in to use the Nectovia Agent.', { code: 'route_refused', role: kind });
    const refused = (error: unknown): never => {
      if (error instanceof ApiError) throw error;
      // The plan's refusal answers as every Agent entry point does (403, or 401 to sign in).
      if (error instanceof EngineError && (error.code === AGENT_NOT_INCLUDED || error.code === AGENT_SIGN_IN_REQUIRED)) throw error;
      throw new ApiError(409, error instanceof Error ? error.message : 'Nectovia refused this role.', { code: 'route_refused', role: kind });
    };
    const resolved = await managed.managedTier(projectId, tier, true).catch(refused);
    const refusal = escalationRefusal(await managed.escalation(projectId, true), tier);
    if (refusal) throw new ApiError(409, refusal, { code: 'escalation_refused', role: kind });
    return managed
      .admitManagedRole(projectId, `${ids.runId}-${kind}`, resolved, tier, kind, ids.rootJobId ?? ids.runId)
      .catch(refused);
  };

  /**
   * Why a Nectovia tier could not join as a role now, read without admitting anything: the
   * project's sharing with Nectovia for these files, the managed checks, then the account's
   * escalation control. Null: it can join.
   */
  const roleOfferReason = async (projectId: string, tier: RoleTier, scope: readonly string[], fresh: boolean): Promise<string | null> => {
    if (!managed?.managedTier || !managed.escalation || !managed.admitManagedRole) return 'Sign in to use the Nectovia Agent.';
    try {
      requireCloudSharing(store.state(projectId), NECTOVIA_ROUTE, scope);
      await managed.managedTier(projectId, tier, fresh);
    } catch (error) {
      return harness.redact(error instanceof Error ? error.message : 'Nectovia is unavailable.');
    }
    return escalationRefusal(await managed.escalation(projectId, fresh), tier);
  };

  const admitTeam = async (
    projectId: string,
    taskId: string,
    body: LoopStartRequest,
    sources: readonly string[],
    consent: boolean,
    ids: RoleIds,
  ): Promise<TeamConfig> => {
    const spec = body.team!;
    const named = spec.scope ? [...new Set(spec.scope.map((file) => relativeName(file)))] : null;
    // The lead's scope: what the person named, else the files it was started with, else the project.
    const scope = named ?? (sources.length ? [...sources] : null);
    if (scope && body.route !== LOOP_FIXTURE_ROUTE) requireCloudSharing(store.state(projectId), body.route as Route, scope);
    const budget = {
      turns: spec.worker.budget?.turns ?? TEAM_LIMITS.worker.turns,
      tokens: spec.worker.budget?.tokens === undefined ? TEAM_LIMITS.worker.tokens : spec.worker.budget.tokens,
      wallMs: spec.worker.budget?.wallMs === undefined ? TEAM_LIMITS.worker.wallMs : spec.worker.budget.wallMs,
    };
    const refusal = budgetRefusal(budget);
    if (refusal) throw new ApiError(400, refusal, { code: 'team_budget_invalid' });
    const worker = await admitRole(projectId, taskId, 'worker', spec.worker, body, scope ?? [], consent, true, undefined, ids);
    const advisor = spec.advisor
      ? await admitRole(projectId, taskId, 'advisor', spec.advisor, body, scope ?? [], consent, false, undefined, ids)
      : null;
    // DIO-257: a worker on the local model the person named no time for gets the time its profile's
    // calls take, as its advisor does (`localRoleWallMs`). Any other worker keeps TEAM_LIMITS.worker.
    const local = worker.route === LOCAL_MODEL_ROUTE && spec.worker.budget?.wallMs === undefined
      ? harness.loop.localProfile(worker.model) : undefined;
    return teamConfig(scope, worker, advisor, local ? { ...budget, wallMs: localRoleWallMs(local, budget.turns, worker.effort) } : budget);
  };

  /**
   * DIO-216 slice C: the Nectovia roles a local lead takes when the person names no team: a Focused
   * worker and a Thorough advisor, each where the account is signed in and includes the Agent and
   * managed usage, the project shares the files with Nectovia, and the account's escalation control
   * allows the tier. One that can't join is left out with its reason, and the lead runs on this
   * computer without it. The start asks before the ones that can join do (`escalation: true`
   * confirms them, `escalation: false` starts without them), and records which joined.
   */
  const defaultEscalation = async (
    projectId: string,
    taskId: string,
    body: LoopStartRequest,
    sources: readonly string[],
    ids: RoleIds,
  ): Promise<{ team: TeamConfig | null; record: EscalationRecord }> => {
    const scope = sources.length ? [...sources] : null;
    const leftOut: { role: EscalationRoleKind; tier: RoleTier; reason: string }[] = [];
    const ready: { role: EscalationRoleKind; tier: RoleTier }[] = [];
    let fresh = true;
    for (const offer of DEFAULT_ESCALATION_ROLES) {
      if (offer.role === 'advisor' && !ready.some((item) => item.role === 'worker')) {
        leftOut.push({ ...offer, reason: ADVISOR_NEEDS_WORKER });
        continue;
      }
      const reason = await roleOfferReason(projectId, offer.tier, scope ?? [], fresh);
      fresh = false;
      if (reason) leftOut.push({ ...offer, reason });
      else ready.push({ ...offer });
    }
    if (!ready.length) return { team: null, record: { attached: [], leftOut } };
    if (body.escalation !== true)
      throw new ApiError(409, escalationConsentText(ready), {
        consentRequired: true,
        escalation: Object.fromEntries(ready.map((item) => [item.role, item.tier])),
      });
    const joined: Partial<Record<EscalationRoleKind, TeamRole & { effort: string | null }>> = {};
    for (const offer of ready) {
      if (offer.role === 'advisor' && !joined.worker) {
        leftOut.push({ ...offer, reason: ADVISOR_NEEDS_WORKER });
        continue;
      }
      try {
        joined[offer.role] = await admitRole(projectId, taskId, offer.role, { route: NECTOVIA_ROUTE, tier: offer.tier }, body,
          scope ?? [], true, false, undefined, ids);
      } catch (error) {
        // A role refused now, after the read above, is left out the same way. The lead still runs.
        if (!(error instanceof ApiError || error instanceof EngineError)) throw error;
        leftOut.push({ ...offer, reason: harness.redact(error.message) });
      }
    }
    const attached = ready.filter((offer) => joined[offer.role]).map((offer) => ({ ...offer }));
    const budget = { turns: TEAM_LIMITS.worker.turns, tokens: TEAM_LIMITS.worker.tokens, wallMs: TEAM_LIMITS.worker.wallMs };
    return {
      team: joined.worker ? teamConfig(scope, joined.worker, joined.advisor ?? null, budget, 'escalation-default') : null,
      record: { attached, leftOut },
    };
  };

  /** One admitted team. An external worker answers in one turn, and one runs at a time. */
  const teamConfig = (
    scope: readonly string[] | null,
    worker: TeamRole & { effort: string | null },
    advisor: (TeamRole & { effort: string | null }) | null,
    budget: TeamConfig['worker']['budget'],
    origin?: TeamConfig['origin'],
  ): TeamConfig => {
    const external = executionOf(worker) === 'external-proposal';
    return {
      v: 1,
      ...(origin ? { origin } : {}),
      scope,
      worker: { ...worker, budget: external ? { ...budget, turns: EXTERNAL_WORKER_LIMITS.turns } : budget },
      advisor,
      limits: {
        depth: TEAM_LIMITS.depth,
        concurrentWorkers: external ? EXTERNAL_WORKER_LIMITS.concurrentWorkers : TEAM_LIMITS.concurrentWorkers,
        workersPerRun: TEAM_LIMITS.workersPerRun,
        advicePerRun: TEAM_LIMITS.advicePerRun,
      },
    };
  };

  /**
   * S3: the worker a Nectovia lead takes from the person's subscription worker preference. Each of
   * their tools is tried in their order and admitted the way a worker they name is, with the
   * reserve they keep; the first that's ready takes the role. When none is, the lead follows what
   * they chose: hold the work, or carry on by itself. Nothing is sent here.
   */
  const subscriptionWorkerFor = async (
    projectId: string,
    taskId: string,
    body: LoopStartRequest,
    sources: readonly string[],
    consent: boolean,
    choice: Exclude<SubscriptionWorkerChoice, { kind: 'off' }>,
  ): Promise<{ team: TeamConfig | null; record: SubscriptionWorkerRecord }> => {
    const { preference } = choice;
    const record = (state: SubscriptionWorkerRecord['state'], route: ExternalWorkerRoute | null, reason: string | null): SubscriptionWorkerRecord =>
      ({ state, route, reason, reserve: preference.reserve, consentRevision: preference.consentRevision });
    const unavailable = (reason: string) => {
      if (preference.whenUnavailable === 'pause')
        throw new ApiError(409, `${reason} You chose to hold work until one of your coding tools can take it, so this didn’t start.`, {
          code: 'subscription_worker_unavailable',
        });
      return { team: null, record: record('unavailable', null, reason) };
    };
    if (choice.kind === 'unavailable') return unavailable(choice.reason);
    // The person confirms the tools by name, under the consent text they read. A bare consent was
    // given to a dialog that may not have named them, so it never reaches their tools.
    const confirmed = body.workerConsent;
    if (
      !consent ||
      !confirmed ||
      confirmed.revision !== preference.consentRevision ||
      confirmed.engines.length !== choice.engines.length ||
      choice.engines.some((route) => !confirmed.engines.includes(route))
    )
      throw new ApiError(
        409,
        `Your goal and the files the loop reads will be sent to Nectovia, and a task it hands off goes to ${engineNames(choice.engines)} with the files it needs, signed in with your own account. Confirm before sending.`,
        { consentRequired: true, workerConsent: { revision: preference.consentRevision, engines: [...choice.engines] } },
      );
    const scope = sources.length ? [...sources] : null;
    const reasons: string[] = [];
    for (const route of choice.engines) {
      try {
        const worker = await admitRole(projectId, taskId, 'worker', { route }, body, scope ?? [], consent, true, preference.reserve);
        const budget = { turns: TEAM_LIMITS.worker.turns, tokens: TEAM_LIMITS.worker.tokens, wallMs: TEAM_LIMITS.worker.wallMs };
        return { team: teamConfig(scope, worker, null, budget, 'subscription-preference'), record: record('attached', route, null) };
      } catch (error) {
        if (!(error instanceof ApiError) || error.details.consentRequired) throw error;
        reasons.push(error.message);
      }
    }
    return unavailable(reasons.join(' '));
  };

  /**
   * An H08 Retry asks for exactly what the earlier lead was admitted with: the
   * same scope, roles, profiles and budget. Each role's route is admitted again,
   * fresh, so a route switched off since then refuses the retry.
   */
  const readmitTeam = async (
    projectId: string,
    team: TeamConfig,
    consent: boolean,
    reserve: SubscriptionReserve | undefined,
    lead: { route: string; ids: RoleIds },
  ): Promise<TeamConfig> => {
    const scope = team.scope ?? [];
    let next: TeamConfig = team;
    for (const kind of ['worker', 'advisor'] as const) {
      const role = team[kind];
      if (!role) continue;
      if (role.route === NECTOVIA_ROUTE) {
        // A Nectovia role under another lead names a tier, not a model (DIO-216): it is admitted
        // again at that tier, on the model the account's routing gives the tier now.
        if (!role.tier || lead.route === NECTOVIA_ROUTE)
          throw new ApiError(409, NECTOVIA_LOOP_TEAM_REFUSED, { code: 'team_route_unsupported' });
        const admitted = await admitNectoviaRole(projectId, kind, role.tier, scope, consent, lead.ids);
        const fresh = { model: admitted.model, accountRoute: admitted.accountRoute };
        next = kind === 'worker' ? { ...next, worker: { ...next.worker, ...fresh } } : { ...next, advisor: { ...role, ...fresh } };
        continue;
      }
      const requested = { model: role.model, accountRoute: role.accountRoute };
      const again = isExternalWorkerRoute(role.route)
        ? await admitExternalWorkerRoute(projectId, role.route, requested, scope, consent, reserve)
        : await admitRoute(projectId, role.route, requested, scope, consent);
      if (again.model !== role.model)
        throw new ApiError(409, `This team's ${kind} used ${role.model}, which its route would not use now, so it was not retried.`, {
          code: 'team_model_changed',
        });
    }
    return next;
  };

  /**
   * Start a loop. The caller holds the store lock: the start route below, or an
   * H08 Retry of an earlier loop (`retryOf`), which runs inside the control's lock.
   */
  const startLocked = async (
    projectId: string,
    body: LoopStartRequest,
    extra: LoopHostStart = {},
  ): Promise<{ runId: string; session: Session | null; replayed: boolean }> => {
    const { commandId, ...payload } = body;
    const commandDigest = digest(payload);
    const runId = loopRunId(projectId, commandId);
    const state = store.state(projectId);
    // Replay first: the same command names the same run and admits nothing new.
    const known = await harness.get(projectId, runId).catch((error: unknown) => {
      if (error instanceof ApiError && error.status === 404) return null;
      throw error;
    });
    if (known) {
      const input = known.input as { command?: { digest?: unknown } } | undefined;
      if (input?.command?.digest !== commandDigest)
        throw new ApiError(409, 'This command id already started a different loop.', { code: 'loop_command_conflict' });
      const session = state.sessions.find((item) => item.id === known.sessionId);
      return { runId, session: session ? structuredClone(session) : null, replayed: true };
    }
    const task = state.tasks.find((item) => item.id === body.taskId && !item.deletedAt);
    if (!task) throw new ApiError(404, 'This task was not found.');
    const workflowBlocker = taskWorkflowBlocker(task);
    if (workflowBlocker) throw new ApiError(409, workflowBlocker, { code: 'task_workflow_blocked' });
    // S1: a manual Team card never runs in the loop, so no loop phase gate can move it (N04).
    if (isManualCard(task)) throw new ApiError(409, MANUAL_CARD_LOOP_REFUSED, { code: 'manual_card_loop' });
    if (state.sessions.some((session) => session.id !== extra.preparedSessionId && ['queued', 'working', 'waiting'].includes(session.state)))
      throw new ApiError(409, 'This project already has work in progress.');
    if (task.workflow && body.maxTurns !== undefined && body.maxTurns > task.workflow.maxTurns)
      throw new ApiError(409, 'This loop exceeds the task turn limit.', { code: 'task_turn_limit' });
    const sources = [...new Set((body.sources ?? []).map((source) => relativeName(source)))];
    if ((body.persistentTeam || body.review || body.composition || extra.compose === true) &&
        sources.some(path => process.platform === 'win32' ? path.toLowerCase() === REPORT_PATH.toLowerCase() : path === REPORT_PATH))
      throw new HarnessError('collaboration_refused', 'The report output cannot also be an immutable collaboration source. Select separate source files.');
    const applyScope = body.applyScope
      ? [...new Set(body.applyScope.map((entry) => (entry.trim() === '.' ? '.' : relativeName(entry))))]
      : null;
    const consent = body.consent === true;
    // Nectovia names no delegate and no team, and nothing names it as a delegate. The one team
    // beside it is the worker the host resolves from the person's preference (S3), which a Retry
    // brings back from the recorded input with its origin.
    const hostTeam = extra.team?.origin === 'subscription-preference';
    if (body.route === NECTOVIA_ROUTE && (body.delegate || body.team || (extra.team && !hostTeam) || body.persistentTeam || body.review))
      throw new ApiError(409, NECTOVIA_LOOP_TEAM_REFUSED, { code: 'loop_route_unsupported' });
    if (body.delegate?.route === NECTOVIA_ROUTE)
      throw new ApiError(409, NECTOVIA_LOOP_REFUSED, { code: 'loop_route_unsupported' });
    if (task.workflow?.skill && !contributions)
      throw new ApiError(409, 'This host cannot load the selected task playbook.');
    const skill = contributions
      ? await prepareTaskSkill(contributions(), state, task, runId, instructionSectionBudget(0))
      : null;
    const principal = extra.principal ?? localHarnessPrincipal(projectId);
    const rawJobId = extra.rootJobRequestId ?? runId;
    const scopedLedger = extra.scopedLedger ?? (collaboration?.rootLedger ? await collaboration.rootLedger(projectId, rawJobId, extra.threadId ?? null) : undefined);
    const rootJobId = extra.rootJobId ?? scopedLedger?.jobScope?.id;
    if (rootJobId && (!scopedLedger || scopedLedger.jobScope?.id !== rootJobId))
      throw new HarnessError('collaboration_refused', 'The host must supply this existing root job ledger.');
    if (scopedLedger) harness.loop.pinRootScope(runId, scopedLedger);
    const selectedHost = collaborationHost();
    if (body.persistentTeam && !selectedHost) throw new HarnessError('collaboration_refused', 'This host cannot resolve a selected Team lead.');
    const selectedLead = body.persistentTeam ? await selectedHost!.resolveRootTeamLead(projectId, body.persistentTeam) : null;
    if (selectedLead && (body.route !== selectedLead.route || (body.model != null && body.model !== selectedLead.model) ||
        (body.accountRoute != null && body.accountRoute !== selectedLead.accountRoute) || (body.effort != null && body.effort !== selectedLead.effort)))
      throw new HarnessError('collaboration_refused', 'The requested route, model, account or effort differs from the selected Team lead.');
    const requestedRoot = selectedLead ? { ...body, model: selectedLead.model, accountRoute: selectedLead.accountRoute } : body;
    // S3: a Personal Nectovia lead may hand tasks to one of the person's own coding tools, when they
    // turned that on. It's resolved before the lead's paid admission, so a start held for want of a
    // tool records no admission. A collaboration root takes no such worker.
    let subscriptionWorker: SubscriptionWorkerRecord | undefined;
    let subscriptionTeam: TeamConfig | null = null;
    // Read on the person's own start, and on a Retry of a worker the host chose then. A host start
    // (Board work, the Ready queue, a follow-up) keeps the lead single-agent (D12).
    const choice: SubscriptionWorkerChoice =
      body.route === NECTOVIA_ROUTE && subscription && !body.composition && extra.compose !== true && (extra.personStart === true || hostTeam)
        ? subscription.choice(projectId)
        : { kind: 'off' };
    if (hostTeam) {
      // A Retry asks for the same tool again, under the person's preference as it is now.
      const route = extra.team!.worker.route;
      if (choice.kind !== 'candidates' || !isExternalWorkerRoute(route) || !choice.engines.includes(route))
        throw new ApiError(
          409,
          `This work handed tasks to ${isExternalWorkerRoute(route) ? engineName(route) : route}, which your settings don’t allow now, so it wasn’t retried. Start it again to use your current settings.`,
          { code: 'subscription_worker_changed' },
        );
      subscriptionWorker = { state: 'attached', route, reason: null, reserve: choice.preference.reserve, consentRevision: choice.preference.consentRevision };
    } else if (choice.kind !== 'off') {
      const resolved = await subscriptionWorkerFor(projectId, task.id, body, sources, consent, choice);
      subscriptionWorker = resolved.record;
      subscriptionTeam = resolved.team;
    }
    const ids: RoleIds = { runId, ...(rootJobId ? { rootJobId } : {}) };
    // DIO-216: a local lead that won't run refuses before any role is admitted beside it.
    if (body.route === LOCAL_MODEL_ROUTE && gates) {
      const refusal = gates.on(LOCAL_MODEL_ROUTE) ? await gates.localRefusal(requestedRoot.model ?? null) : LOCAL_MODEL_NOT_INSTALLED;
      if (refusal) throw new ApiError(409, refusal, { code: 'local_model_not_ready' });
    }
    // DIO-251: a local lead's sources fit its profile's reading allowance, checked as Work checks
    // its selection, before any role is admitted or the model is called. A source that is missing
    // or that the path guard refuses counts nothing here: the lead's read reports it, as before.
    const leadProfile = body.route === LOCAL_MODEL_ROUTE ? harness.loop.localProfile(requestedRoot.model) : undefined;
    if (leadProfile) {
      const allowance = localContextBudget(leadProfile).sourceBytes;
      let bytes = 0;
      for (const source of sources) {
        const text = await store.current(projectId, source).catch(() => null);
        bytes += text === null ? 0 : Buffer.byteLength(text);
        if (bytes > allowance) throw new ApiError(413, localSourceRefusal('Select no more than', allowance));
      }
    }
    // DIO-216: the default Nectovia roles beside a local lead the person started with no team,
    // delegate or composition. A Retry of a lead that took them asks for them again.
    let escalation: EscalationRecord | undefined;
    let escalationTeam: TeamConfig | null = null;
    if (body.route === LOCAL_MODEL_ROUTE && !extra.team && body.team === undefined && !body.delegate && !body.persistentTeam &&
        !body.review && !body.composition && extra.compose !== true && body.escalation !== false &&
        (extra.personStart === true || body.escalation === true) && managed?.managedTier && managed.escalation && managed.admitManagedRole)
      ({ team: escalationTeam, record: escalation } = await defaultEscalation(projectId, task.id, body, sources, ids));
    // A team's roles are admitted before their lead, as S3's worker is above: a role that refuses
    // (a local model that isn't running, a route switched off) leaves nothing admitted for the lead.
    let team = extra.team
      ? await readmitTeam(projectId, extra.team, consent, hostTeam ? subscriptionWorker?.reserve : undefined, { route: body.route, ids })
      : body.team
        ? await admitTeam(projectId, task.id, body, sources, consent, ids)
        : subscriptionTeam ?? escalationTeam;
    const admitted = await admitRoute(projectId, body.route, requestedRoot, sources, consent,
      { taskId: task.id, runId, rootJobId, threadId: extra.threadId, effort: selectedLead ? selectedLead.effort : body.effort });
    let delegate: LoopRunInput['delegate'] = null;
    if (body.delegate?.profileId) {
      // The person's H09 profile fixes the delegate's route and exact model, by H09's own rules.
      const role = await admitRole(projectId, task.id, 'worker', { profileId: body.delegate.profileId }, body, [], consent);
      if (role.route === NECTOVIA_ROUTE) throw new ApiError(409, NECTOVIA_LOOP_REFUSED, { code: 'loop_route_unsupported' });
      delegate = { route: role.route, model: role.model, accountRoute: role.accountRoute, profile: role.profile, effort: role.effort };
    } else if (body.delegate?.route) {
      const child = await admitRoute(projectId, body.delegate.route, body.delegate, [], consent);
      delegate = { route: body.delegate.route, model: child.model, accountRoute: child.accountRoute };
    }
    let composition: LoopRunInput['collaboration'] = null;
    if (body.persistentTeam || body.review || body.composition || extra.compose === true) {
      if (body.delegate || applyScope) throw new HarnessError('collaboration_refused', 'This bounded collaboration uses selected read-only roles and exact report approval.');
      const host = collaborationHost();
      if (!host || !rootJobId) throw new HarnessError('collaboration_refused', 'This host has no admitted collaboration and root spend scope.');
      composition = await host.admit({ projectId, taskId: task.id, rootRunId: runId, rootJobId, commandId,
        principal, route: body.route, model: admitted.model, accountRoute: admitted.accountRoute, sources, consent,
        persistentTeam: body.persistentTeam, helperProfileId: body.team?.worker.profileId ?? null, review: body.review,
        qualityStatus: extra.qualityStatus, selectionReason: extra.selectionReason });
      if (selectedLead && digest(selectedLead) !== digest(composition.persistentTeam?.lead))
        throw new HarnessError('collaboration_refused', 'The selected lead binding changed during admission.');
      if (composition.helper) {
        const helper = composition.helper;
        if (!team || team.advisor || team.worker.route !== helper.route || team.worker.model !== helper.model || team.worker.accountRoute !== helper.accountRoute ||
            team.worker.profile?.profileId !== helper.profile.id || team.worker.profile.revision !== helper.profile.revision || team.worker.profile.digest !== `sha256:${helper.profile.digest}` || helper.effort !== 'medium' ||
            (team.scope && team.scope.some(path => !sources.includes(path))))
          throw new HarnessError('collaboration_refused', 'The H14 worker differs from its selected helper profile or source scope.');
        team = { ...team, scope: sources, worker: { ...team.worker, agent: { ...team.worker.agent, ceiling: 'review' },
          budget: { turns: Math.min(3, team.worker.budget.turns), tokens: Math.min(15_000, team.worker.budget.tokens ?? 15_000), wallMs: Math.min(120_000, team.worker.budget.wallMs ?? 120_000) } },
          advisor: null, limits: { depth: 1, concurrentWorkers: 1, workersPerRun: 1, advicePerRun: 0 } };
      } else if (team) throw new HarnessError('collaboration_refused', 'Select one exact H14 helper profile for this composition.');
    }
    // H11: the project's instruction files, resolved through the rule path and recorded on the Session.
    const cloud = body.route !== LOOP_FIXTURE_ROUTE;
    const instructions = await assembleInstructions({
      state,
      routeId: body.route,
      agentRole: 'Diomedes work loop',
      budgetBytes: Math.max(0, instructionSectionBudget(0) - (skill ? skill.use.bytes + 2 : 0)),
      ...(cloud ? { allowedDocuments: cloudSharing(state).documents } : {}),
      workPaths: sources,
    });
    const input: LoopRunInput & { command: { id: string; digest: string } } = {
      v: 1,
      kind: 'diomedes-loop',
      goal: body.goal,
      route: body.route,
      model: admitted.model,
      accountRoute: admitted.accountRoute,
      effort: composition?.persistentTeam?.lead.effort ?? body.effort ?? null,
      ...(rootJobId ? { rootJobId, rootJobRequestId: rawJobId, threadId: extra.threadId ?? null } : {}),
      ...(composition ? { collaboration: composition } : {}),
      maxTurns: body.maxTurns ?? task.workflow?.maxTurns ?? LOOP_LIMITS.defaultTurns,
      instructions: [instructions.section, skill?.section].filter(Boolean).join('\n\n'),
      ...(skill ? { skill: skill.use } : {}),
      delegate,
      sources,
      ...(applyScope ? { applyScope } : {}),
      ...(team ? { team } : {}),
      ...(extra.retryOf ? { retryOf: extra.retryOf } : {}),
      ...(subscriptionWorker ? { subscriptionWorker } : {}),
      ...(escalation ? { escalation } : {}),
      command: { id: commandId, digest: commandDigest },
    };
    const session = await harness.bridge.start(
      projectId,
      task.id,
      NATIVE_LOOP_CAPABILITY,
      body.goal,
      principal,
      undefined,
      { runId, input: input as unknown as Json, admission: extra.admission, preparedSessionId: extra.preparedSessionId },
    );
    const saved = store.state(projectId).sessions.find((item) => item.id === session.id);
    if (saved) {
      if (skill) saved.skill = skill.use;
      if (instructions.delivery) saved.instructions = instructions.delivery;
      // What shipped product knowledge went with it, as a Work run records it (native-work.ts).
      saved.productKnowledge = instructions.productKnowledge;
      // H08: what this loop was asked, kept so a Retry can ask for exactly the same thing.
      saved.inputs = { instruction: body.goal, sources, agentId: null, mode: 'build' };
      await store.persist(store.state(projectId));
    }
    return { runId, session: structuredClone(saved ?? session), replayed: false };
  };

  app.post(
    '/api/projects/:id/loop/start',
    handle((req) => {
      const projectId = String(req.params.id);
      const parsed = startSchema.safeParse(req.body ?? {});
      if (!parsed.success)
        throw new ApiError(400, 'Provide a versioned loop command: its id, the task, the goal and the route.', {
          code: 'invalid_loop_command',
        });
      return store.locked(() => startLocked(projectId, parsed.data, { personStart: true }));
    }),
  );

  app.get('/api/projects/:id/loop/collaboration-options', handle(async req => {
    const host = collaborationHost();
    const projectId = String(req.params.id);
    const taskId = typeof req.query.taskId === 'string' ? req.query.taskId : '';
    if (!taskId) throw new ApiError(400, 'Select the task these roles will work on.');
    return host ? host.options(projectId, taskId) : { leads: [], members: [], helpers: [], reviews: [], reason: 'This host has no qualified collaboration choices.' };
  }));

  /**
   * S3: what the person's own Nectovia start in this project would do with their coding tools, so
   * the start dialog can name them in its consent and echo what was confirmed (`workerConsent`).
   * Read only: nothing is admitted, sent or recorded, and another person's preference reads as off.
   */
  app.get(
    '/api/projects/:id/subscription-workers',
    handle(async (req): Promise<SubscriptionWorkerStartView> => {
      const projectId = String(req.params.id);
      store.state(projectId);
      return subscription ? subscription.startView(projectId) : { kind: 'off' };
    }),
  );

  /**
   * DIO-216 slice C: the Nectovia tiers a start may name as a role beside a lead that is not
   * Nectovia, each read now: the project's sharing with Nectovia, signed in with the Agent and
   * managed usage, a published model for the tier, and the account's escalation control. A tier
   * that can't join carries the sentence its start would refuse with. Read-only: nothing is
   * admitted, sent or recorded.
   */
  app.get(
    '/api/projects/:id/loop/escalation',
    handle(async (req) => {
      const projectId = String(req.params.id);
      store.state(projectId);
      const offers: EscalationOffer[] = [];
      let fresh = true;
      for (const tier of ROUTING_TIERS) {
        const reason = await roleOfferReason(projectId, tier, [], fresh);
        fresh = false;
        offers.push({ tier, name: nectoviaTierName(tier), admitted: reason === null, reason });
      }
      return { offers, credits: NECTOVIA_ROLE_CREDITS };
    }),
  );

  /**
   * The routes a Console start control may offer, each with the start route's own admission
   * read now: on in Settings, then the route's connection, model, credential and spend cap.
   * Nectovia bypasses the Settings switch and is read through the managed
   * read-only dependency only: nothing is admitted, sent or recorded here.
   * Consent and the project's sharing grant depend on what the person picks, so the start
   * itself still asks for them. Read-only: nothing is admitted, sent or recorded.
   */
  app.get(
    '/api/projects/:id/loop/routes',
    handle(async (req) => {
      const projectId = String(req.params.id);
      store.state(projectId);
      const routes: LoopRouteOffer[] = [
        {
          route: LOOP_FIXTURE_ROUTE,
          label: 'Scripted demonstration (a fixed local script, no model)',
          admitted: true,
          sends: false,
          model: null,
          reason: null,
        },
      ];
      // Loops run on the owner's provider routes and on Nectovia managed single-agent.
      for (const route of MODEL_API_PROVIDERS) {
        const offer = { route, label: MODEL_API_NAMES[route], sends: true };
        if (services()[route] !== true) {
          routes.push({ ...offer, admitted: false, model: null, reason: 'Turn the selected route on in Settings before using it.' });
          continue;
        }
        const model = typeof services()[`${route}Model`] === 'string' ? (services()[`${route}Model`] as string) : null;
        const accountRoute =
          typeof services()[`${route}AccountRoute`] === 'string' ? (services()[`${route}AccountRoute`] as string) : null;
        try {
          const admitted = await harness.loop.admit(route, { projectId, model, accountRoute });
          routes.push({ ...offer, admitted: true, model: admitted.model, reason: null });
        } catch (error) {
          routes.push({
            ...offer,
            admitted: false,
            model,
            reason: harness.redact(error instanceof Error ? error.message : 'This route refused the loop.'),
          });
        }
      }
      // Nectovia managed, read-only: the managed dependency names the model or
      // the reason, without recording a paid admission. No gateway or provider
      // call is made here.
      {
        const offer = { route: NECTOVIA_ROUTE, label: MODEL_API_NAMES[NECTOVIA_ROUTE], sends: true };
        try {
          const read = await managed?.readOnly?.(projectId);
          if (read) routes.push({ ...offer, ...read });
          else {
            const resolved = await managed?.resolveManaged?.(projectId, '');
            routes.push({ ...offer, admitted: Boolean(resolved), model: resolved?.model ?? null,
              reason: resolved ? null : 'Sign in to use the Nectovia Agent.' });
          }
        } catch (error) {
          routes.push({
            ...offer,
            admitted: false,
            model: null,
            reason: harness.redact(error instanceof Error ? error.message : 'This route refused the loop.'),
          });
        }
      }
      // A business that does not hold 'owner-rules' still starts loops; its trigger
      // rules just do not reach them, and the Console says so once. The project's own
      // instruction files reach every loop (Andrew, 2026-09-27).
      return {
        routes,
        notIncludedReason: ownerRules(projectId) ? null : OWNER_RULES_NOT_INCLUDED_REASON,
      };
    }),
  );

  app.get(
    '/api/projects/:id/loop/runs/:runId',
    handle(async (req) => {
      const projectId = String(req.params.id);
      const run = await harness.get(projectId, String(req.params.runId));
      if (run.capabilityId !== NATIVE_LOOP_CAPABILITY) throw new ApiError(404, 'This run is not a Diomedes loop.');
      const children = await harness.loop.children(run);
      const view = loopView(run, children);
      const checked =
        run.sessionId && run.state === 'completed'
          ? await store.locked(async () => {
              await verification.sync(projectId);
              return verification.view(projectId, run.sessionId!);
            })
          : null;
      return harness.scrub({
        view,
        outcome: loopOutcome(view, checked),
        verification: checked,
        team: await harness.loop.teamView(run),
        // DIO-216: the default Nectovia roles a local lead took, and any left out with why.
        escalation: (run.input as unknown as LoopRunInput | null)?.escalation ?? null,
        changeSets: await harness.loop.changeSets.views(projectId, { rootRunId: run.id }),
      });
    }),
  );

  /**
   * The change sets a loop's sandboxed delegates and workers returned: one entry's both sides
   * with P06's readable diff, and a person's keep or discard, per entry or per hunk.
   */
  app.get(
    '/api/projects/:id/change-sets/:changeSetId/entries/:index/diff',
    handle(async (req) => {
      const projectId = String(req.params.id);
      store.state(projectId);
      const index = Number(req.params.index);
      if (!Number.isSafeInteger(index) || index < 0) throw new ApiError(400, 'Name one change by its number.');
      return harness.scrub(await harness.loop.changeSets.diff(projectId, String(req.params.changeSetId), index));
    }),
  );
  app.post(
    '/api/projects/:id/change-sets/:changeSetId/decide',
    handle((req) => {
      const projectId = String(req.params.id);
      store.state(projectId);
      return store.locked(async () => ({
        changeSet: await harness.loop.changeSets.decide(projectId, String(req.params.changeSetId), req.body ?? {}),
      }));
    }),
  );

  /**
   * H14: every lead in this project that was admitted with a team, newest first,
   * with its workers and advice. Projected on each read from the handoff ledger,
   * the child runs and H17; nothing is stored for the view.
   */
  app.get(
    '/api/projects/:id/loop/team',
    handle(async (req) => {
      const projectId = String(req.params.id);
      const runs = (await harness.list(projectId))
        .filter((run) => run.capabilityId === NATIVE_LOOP_CAPABILITY && (run.input as { team?: unknown } | null)?.team)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .slice(0, 20);
      const state = store.state(projectId);
      const leads = [];
      for (const run of runs) {
        const children = await harness.loop.children(run);
        const view = loopView(run, children);
        const checked =
          run.sessionId && run.state === 'completed'
            ? await store.locked(async () => {
                await verification.sync(projectId);
                return verification.view(projectId, run.sessionId!);
              })
            : null;
        const session = state.sessions.find((item) => item.id === run.sessionId);
        const task = state.tasks.find((item) => item.id === run.taskId);
        leads.push({
          runId: run.id,
          sessionId: run.sessionId,
          sessionState: session?.state ?? null,
          taskId: run.taskId,
          taskName: task?.name ?? null,
          route: view.route,
          models: view.models,
          usage: view.usage,
          outcome: loopOutcome(view, checked),
          team: await harness.loop.teamView(run),
          changeSets: await harness.loop.changeSets.views(projectId, { rootRunId: run.id }),
        });
      }
      return harness.scrub({ leads });
    }),
  );

  /**
   * H08: Retry of a stopped or failed loop, as its own control route. The new
   * attempt is started through this file's own admission with the earlier
   * run's recorded input, under the control's derived command id, and names the
   * run it retries, so a lead's workers that already answered are not run again.
   */
  const retryDriver: WorkControlDriver = {
    async retry(ctx) {
      const run = (await harness.list(ctx.projectId)).find(
        (item) => item.capabilityId === NATIVE_LOOP_CAPABILITY && item.sessionId === ctx.session.id,
      );
      if (!run) return { refused: { code: 'unsupported', reason: 'This loop’s run record was not found, so it cannot be retried.' } };
      const input = run.input as unknown as LoopRunInput;
      if (ctx.task.automaticWork) return { refused: { code: 'unsupported', reason: 'This work is bound to the original request and its spend records. Send a new original request to start another root.' } };
      if (input.collaboration) return { refused: { code: 'unsupported', reason: 'This root owns bounded response and spend records; select a new authorized task instead of retrying it.' } };
      const attempt = (input.retryOf?.attempt ?? 1) + 1;
      // The loop stopped at its check-in, so this Retry is Keep going: the job continues with one more amount.
      if (managed?.keepGoing && run.steps.some((step) => step.intent.stepId === 'stop:check-in' && step.state === 'succeeded'))
        await managed.keepGoing(ctx.projectId, input.rootJobRequestId ?? run.id, loopRunId(ctx.projectId, ctx.workCommandId));
      // DIO-216: default Nectovia roles the person confirmed are asked for again, read fresh at the
      // account's settings now. A lead that took none takes none on its Retry, and nothing asks.
      const defaults = input.team?.origin === 'escalation-default';
      const started = await startLocked(
        ctx.projectId,
        {
          protocolVersion: 1,
          commandId: ctx.workCommandId,
          taskId: ctx.task.id,
          goal: input.goal,
          route: input.route,
          model: input.model,
          accountRoute: input.accountRoute,
          consent: true,
          maxTurns: input.maxTurns,
          sources: [...input.sources],
          delegate: input.delegate ? { ...input.delegate } : null,
          ...(input.escalation ? { escalation: defaults } : {}),
        },
        { retryOf: { runId: run.id, attempt }, team: defaults ? null : (input.team ?? null) },
      );
      return {
        ...(started.session ? { sessionId: started.session.id } : {}),
        performedBy: { kind: 'diomedes' },
        detail: `Retried as attempt ${attempt}${started.session ? ` (${started.session.id})` : ''}, with the same inputs as ${ctx.session.id}.${input.team ? ' Workers that already answered are not run again.' : ''}`,
      };
    },
  };
  return { startLocked, startHostLocked: (projectId: string, request: LoopStartRequest, extra: LoopHostStart = {}) =>
    startLocked(projectId, startSchema.parse(request), extra), retryDriver, contract: LOOP_CONTROL_CONTRACT };
}

/**
 * The control contract a loop run answers by (H08). The run service is the
 * mechanism, as for the fixture route; Retry is wired to the loop's own start.
 * Resume and Fork are not offered for a loop in this build.
 */
export const LOOP_CONTROL_CONTRACT: AdapterRouteContract = {
  ...ROUTE_CONTRACTS['native-fixture'],
  routeId: NATIVE_LOOP_CAPABILITY,
  engine: { id: NATIVE_LOOP_CAPABILITY, version: 'v1', protocolVersion: 'harness-v1' },
  commands: {
    ...ROUTE_CONTRACTS['native-fixture'].commands,
    resume: { support: 'unsupported', note: 'A stopped loop is retried as a new attempt; it is not resumed in place.' },
    retry: {
      support: 'native',
      note: 'A new loop attempt with the same recorded input, linked to the one it retries; a lead’s answered workers are reused.',
    },
    fork: { support: 'unsupported', note: 'A loop is not forked in this build.' },
  },
};
