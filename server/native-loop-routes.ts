/**
 * H13 routes: start a Diomedes work loop on a task, and read it back.
 *
 * Starting is admission and nothing more. It checks, in order: the task, the
 * route (the scripted fixture or a Diomedes-owned model-API route; an external
 * engine drives its own loop and is not offered here), that the route is on,
 * the person's consent to send, the project's sharing grant for every selected
 * file, and the route's own admission (connection, model, credential, spend
 * cap). A delegate route, when the person names one, is admitted the same way
 * now and again when the loop hands it work. The run is created through the
 * bridge with its admission pinned, so a replay of the same command id returns
 * the same run and admits nothing new.
 *
 * Reading projects the loop from its steps (`shared/native-loop.ts`) and the
 * finish from H17's four-state projection of the task's declared checks. No
 * state is stored for the view.
 */
import { createHash } from 'node:crypto';
import type { Express, NextFunction, Request, Response } from 'express';
import { z } from 'zod';
import type { Json } from '../shared/harness.js';
import { isModelApiRoute } from '../shared/model-api.js';
import {
  LOOP_LIMITS,
  NATIVE_LOOP_CAPABILITY,
  loopOutcome,
  loopView,
  type LoopRunInput,
} from '../shared/native-loop.js';
import { ApiError, relativeName } from './paths.js';
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
  TEAM_LIMITS,
  budgetRefusal,
  type TeamConfig,
  type TeamRetry,
  type TeamRole,
} from '../shared/team-delegation.js';
import type { Route, Session } from '../shared/types.js';

const routeName = z.string().min(1).max(40);
/** One team role as the person names it: an Agent, and either an H09 profile or a route. */
const roleSchema = z.strictObject({
  agentId: z.string().min(1).max(120).optional(),
  profileId: z.string().min(1).max(120).optional(),
  route: routeName.optional(),
  model: z.string().min(1).max(200).nullable().optional(),
  accountRoute: z.string().min(1).max(400).nullable().optional(),
});
const startSchema = z.strictObject({
  protocolVersion: z.literal(1),
  commandId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/),
  taskId: z.string().min(1).max(100),
  goal: z.string().trim().min(1).max(16_000),
  route: routeName,
  model: z.string().min(1).max(200).nullable().optional(),
  accountRoute: z.string().min(1).max(400).nullable().optional(),
  consent: z.boolean().optional(),
  maxTurns: z.number().int().min(1).max(LOOP_LIMITS.maxTurns).optional(),
  sources: z.array(z.string().min(1).max(400)).max(32).optional(),
  delegate: z
    .strictObject({
      route: routeName,
      model: z.string().min(1).max(200).nullable().optional(),
      accountRoute: z.string().min(1).max(400).nullable().optional(),
    })
    .nullable()
    .optional(),
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
});
export type LoopStartRequest = z.infer<typeof startSchema>;

/** One command id names one run, in this project, forever. */
export function loopRunId(projectId: string, commandId: string): string {
  return `R${createHash('sha256').update(`diomedes-loop\0${projectId}\0${commandId}`).digest('hex').slice(0, 12)}`;
}

const loopRoute = (route: string) => route === LOOP_FIXTURE_ROUTE || isModelApiRoute(route);

/** What H14 admission reads to resolve a team role: H09 profiles and the Agent catalog. */
export interface TeamAdmission {
  readonly profiles: AgentProfileService;
  readonly agents: AgentRegistry;
}

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
) {
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
  ) => {
    if (!loopRoute(route))
      throw new ApiError(400, 'A Diomedes loop runs on the fixture route or a model-API route. An external engine keeps its own loop.', {
        code: 'loop_route_unsupported',
      });
    if (route === LOOP_FIXTURE_ROUTE) return { model: null, accountRoute: null };
    if (services()[route] !== true) throw new ApiError(409, 'Turn the selected route on in Settings before using it.');
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
      return await harness.loop.admit(route, { projectId, model, accountRoute });
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw new ApiError(409, error instanceof Error ? error.message : 'This route refused the loop.', { code: 'route_refused' });
    }
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
  ): Promise<TeamRole> => {
    const state = store.state(projectId);
    const refuse = (message: string, code = 'team_role_refused') => new ApiError(409, message, { code, role: kind });
    let route = spec.route ?? lead.route;
    let model = spec.model ?? (spec.route ? null : (lead.model ?? null));
    let accountRoute = spec.accountRoute ?? (spec.route ? null : (lead.accountRoute ?? null));
    let agentId = spec.agentId ?? null;
    let profile: TeamRole['profile'] = null;
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
      if (!loopRoute(pick.engine))
        throw refuse(`${profileLabel(pick)} runs on a route that keeps its own loop, so it cannot be a ${kind} here.`);
      route = pick.engine;
      model = pick.model;
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
    const admitted = await admitRoute(projectId, route, { model, accountRoute }, scope, consent);
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
      profile,
    };
  };

  const admitTeam = async (
    projectId: string,
    taskId: string,
    body: LoopStartRequest,
    sources: readonly string[],
    consent: boolean,
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
    const worker = await admitRole(projectId, taskId, 'worker', spec.worker, body, scope ?? [], consent);
    const advisor = spec.advisor ? await admitRole(projectId, taskId, 'advisor', spec.advisor, body, scope ?? [], consent) : null;
    return {
      v: 1,
      scope,
      worker: { ...worker, budget },
      advisor,
      limits: {
        depth: TEAM_LIMITS.depth,
        concurrentWorkers: TEAM_LIMITS.concurrentWorkers,
        workersPerRun: TEAM_LIMITS.workersPerRun,
        advicePerRun: TEAM_LIMITS.advicePerRun,
      },
    };
  };

  /**
   * An H08 Retry asks for exactly what the earlier lead was admitted with: the
   * same scope, roles, profiles and budget. Each role's route is admitted again,
   * fresh, so a route switched off since then refuses the retry.
   */
  const readmitTeam = async (projectId: string, team: TeamConfig, consent: boolean): Promise<TeamConfig> => {
    const scope = team.scope ?? [];
    for (const role of [team.worker, team.advisor]) {
      if (!role) continue;
      const again = await admitRoute(projectId, role.route, { model: role.model, accountRoute: role.accountRoute }, scope, consent);
      if (again.model !== role.model)
        throw new ApiError(409, `This team's ${role === team.worker ? 'worker' : 'advisor'} used ${role.model}, which its route would not use now, so it was not retried.`, {
          code: 'team_model_changed',
        });
    }
    return team;
  };

  /**
   * Start a loop. The caller holds the store lock: the start route below, or an
   * H08 Retry of an earlier loop (`retryOf`), which runs inside the control's lock.
   */
  const startLocked = async (
    projectId: string,
    body: LoopStartRequest,
    extra: { retryOf?: TeamRetry | null; team?: TeamConfig | null } = {},
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
    const sources = [...new Set((body.sources ?? []).map((source) => relativeName(source)))];
    const consent = body.consent === true;
    const admitted = await admitRoute(projectId, body.route, body, sources, consent);
    let delegate: LoopRunInput['delegate'] = null;
    if (body.delegate) {
      const child = await admitRoute(projectId, body.delegate.route, body.delegate, [], consent);
      delegate = { route: body.delegate.route, model: child.model, accountRoute: child.accountRoute };
    }
    const team = extra.team
      ? await readmitTeam(projectId, extra.team, consent)
      : body.team
        ? await admitTeam(projectId, task.id, body, sources, consent)
        : null;
    // H11: the project's instruction files, resolved through the rule path and recorded on the Session.
    const cloud = body.route !== LOOP_FIXTURE_ROUTE;
    const instructions = await assembleInstructions({
      state,
      routeId: body.route,
      agentRole: 'Diomedes work loop',
      budgetBytes: instructionSectionBudget(0),
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
      maxTurns: body.maxTurns ?? LOOP_LIMITS.defaultTurns,
      instructions: instructions.section ?? '',
      delegate,
      sources,
      ...(team ? { team } : {}),
      ...(extra.retryOf ? { retryOf: extra.retryOf } : {}),
      command: { id: commandId, digest: commandDigest },
    };
    const session = await harness.bridge.start(
      projectId,
      task.id,
      NATIVE_LOOP_CAPABILITY,
      body.goal,
      localHarnessPrincipal(projectId),
      undefined,
      { runId, input: input as unknown as Json },
    );
    const saved = store.state(projectId).sessions.find((item) => item.id === session.id);
    if (saved) {
      if (instructions.delivery) saved.instructions = instructions.delivery;
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
      return store.locked(() => startLocked(projectId, parsed.data));
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
      });
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
      const attempt = (input.retryOf?.attempt ?? 1) + 1;
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
        },
        { retryOf: { runId: run.id, attempt }, team: input.team ?? null },
      );
      return {
        ...(started.session ? { sessionId: started.session.id } : {}),
        performedBy: { kind: 'diomedes' },
        detail: `Retried as attempt ${attempt}${started.session ? ` (${started.session.id})` : ''}, with the same inputs as ${ctx.session.id}.${input.team ? ' Workers that already answered are not run again.' : ''}`,
      };
    },
  };
  return { startLocked, retryDriver, contract: LOOP_CONTROL_CONTRACT };
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
