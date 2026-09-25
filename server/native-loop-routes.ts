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

const routeName = z.string().min(1).max(40);
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
});
export type LoopStartRequest = z.infer<typeof startSchema>;

/** One command id names one run, in this project, forever. */
export function loopRunId(projectId: string, commandId: string): string {
  return `R${createHash('sha256').update(`diomedes-loop\0${projectId}\0${commandId}`).digest('hex').slice(0, 12)}`;
}

const loopRoute = (route: string) => route === LOOP_FIXTURE_ROUTE || isModelApiRoute(route);

export function mountNativeLoopRoutes(app: Express, store: Store, harness: HarnessHost, verification: VerificationService) {
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

  app.post(
    '/api/projects/:id/loop/start',
    handle((req) => {
      const projectId = String(req.params.id);
      const parsed = startSchema.safeParse(req.body ?? {});
      if (!parsed.success)
        throw new ApiError(400, 'Provide a versioned loop command: its id, the task, the goal and the route.', {
          code: 'invalid_loop_command',
        });
      const body = parsed.data;
      const { commandId, ...payload } = body;
      const commandDigest = digest(payload);
      const runId = loopRunId(projectId, commandId);
      return store.locked(async () => {
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
        if (saved && instructions.delivery) {
          saved.instructions = instructions.delivery;
          await store.persist(store.state(projectId));
        }
        return { runId, session: structuredClone(saved ?? session), replayed: false };
      });
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
      });
    }),
  );
}
