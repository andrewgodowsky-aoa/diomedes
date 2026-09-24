import type { Express, NextFunction, Request, Response } from 'express';
import { z } from 'zod';
import { ApiError } from '../paths.js';
import { HarnessError } from '../harness/policy.js';
import { claudeSessionRunId } from '../harness/claude-session-run.js';
import type {
  ClaudeSessionRuns,
  ClaudeSessionTurnResult,
  SessionCheckpointFacts,
} from '../harness/claude-session-run.js';
import { opencodeSessionRunId } from '../harness/opencode-session-run.js';
import { routeContractFor } from '../harness/route-contract.js';
import { sessionControls, type ThreadSessionView } from '../../shared/session-controls.js';
import type { TextRequest } from './contract.js';
import { EngineError } from './process.js';
import type { EngineService } from './service.js';

const commandId = z.string().trim().min(1).max(200);
export const claudeSessionBody = z.strictObject({
  commandId,
  threadId: z.string().trim().min(1).max(200),
  text: z.string().trim().min(1).max(32000),
  mode: z.enum(['ask', 'plan']),
  sources: z
    .array(
      z.strictObject({
        path: z.string().min(1).max(4000),
        sha: z.string().regex(/^[a-f0-9]{64}$/),
      }),
    )
    .max(8),
  consent: z.literal(true),
  /**
   * What this Ask or Plan message may read from the project (`shared/read-access.ts`).
   * Absent means the selected documents only; `project` is the person's per-message choice.
   */
  readAccess: z.enum(['selected', 'project']).optional(),
});
export type ClaudeSessionBody = z.infer<typeof claudeSessionBody>;
export interface ClaudeSessionRouteDependencies {
  /** Existing request/project authority; stop and status do not require a sending account. */
  authorize(req: Request): Promise<void>;
  /** Existing Settings selection, thread, mode instructions and bounded Files selection. */
  prepare(req: Request, body: ClaudeSessionBody): Promise<TextRequest>;
  /** Idempotent projection from a committed response; invoked on durable replay as well. */
  recordResult?(
    req: Request,
    body: ClaudeSessionBody,
    result: ClaudeSessionTurnResult,
    input: TextRequest,
  ): Promise<void>;
}

export function mountClaudeSessionRoutes(
  app: Express,
  engines: EngineService,
  dependencies: ClaudeSessionRouteDependencies,
) {
  mountNativeSessionRoutes(
    app,
    {
      base: '/api/projects/:id/claude-sessions',
      driver: () => engines.nativeSessions,
      runId: claudeSessionRunId,
      turn: (mode, runId, input, sourceRunId) => engines.claudeSession(mode, runId, input, sourceRunId),
      // H03: its status carries the contract's controls too, and its steer is the host queue.
      routeId: 'claude-code-session',
    },
    dependencies,
  );
}
/**
 * The kept OpenCode session (H04): the same routes, plus `steer` because its
 * contract answers it (as a host queue), and a `controls` block on its status
 * read from that contract, so a surface offers only what the route supports.
 */
export function mountOpenCodeSessionRoutes(
  app: Express,
  engines: EngineService,
  dependencies: ClaudeSessionRouteDependencies,
) {
  mountNativeSessionRoutes(
    app,
    {
      base: '/api/projects/:id/opencode-sessions',
      driver: () => engines.opencodeSessions,
      runId: opencodeSessionRunId,
      turn: (mode, runId, input, sourceRunId) => engines.opencodeSession(mode, runId, input, sourceRunId),
      routeId: 'opencode-session',
    },
    dependencies,
  );
}
type NativeTurnMode = 'start' | 'follow-up' | 'resume' | 'fork';
function mountNativeSessionRoutes(
  app: Express,
  spec: {
    base: string;
    driver: () => ClaudeSessionRuns<SessionCheckpointFacts> | undefined;
    runId: (projectId: string, commandId: string) => string;
    turn: (
      mode: NativeTurnMode,
      runId: string,
      input: TextRequest,
      sourceRunId?: string,
    ) => Promise<ClaudeSessionTurnResult>;
    /** Set for a route whose status carries its contract-derived controls. */
    routeId?: string;
  },
  dependencies: ClaudeSessionRouteDependencies,
) {
  const base = spec.base;
  /**
   * The mode of the message each run last answered, in this process. A held message is sent
   * under the instructions of the turn it waited behind, so it is shown in the thread under
   * that turn's mode. Bounded; a run with no entry has no turn running to steer into.
   */
  const modes = new Map<string, ClaudeSessionBody['mode']>();
  const noteMode = (runId: string, mode: ClaudeSessionBody['mode']) => {
    modes.delete(runId);
    modes.set(runId, mode);
    if (modes.size > 512) modes.delete(modes.keys().next().value!);
  };
  const contract = spec.routeId ? routeContractFor(spec.routeId) : undefined;
  const native = () => {
    const driver = spec.driver();
    if (!driver) throw new ApiError(503, 'The native conversation runtime is unavailable.');
    return driver;
  };
  const route =
    (action: (req: Request) => Promise<unknown>) =>
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        await dependencies.authorize(req);
        res.json(await action(req));
      } catch (error) {
        if (error instanceof EngineError || error instanceof HarnessError)
          next(
            new ApiError(error.code === 'unknown_run' ? 404 : 409, error.message, {
              code: error.code,
            }),
          );
        else next(error);
      }
    };
  const turn = (mode: NativeTurnMode) =>
    route(async (req) => {
      const body = claudeSessionBody.safeParse(req.body);
      if (!body.success)
        throw new ApiError(
          400,
          'Provide an explicit conversation command, existing thread, text, ask/plan mode and selected sources.',
        );
      native();
      // prepare may take a short Store lock; this route never holds one over a provider call.
      const input = await dependencies.prepare(req, body.data);
      const projectId = String(req.params.id);
      if (
        input.projectId !== projectId ||
        input.threadId !== body.data.threadId ||
        input.requestId !== body.data.commandId ||
        input.prompt !== body.data.text
      )
        throw new ApiError(400, 'The admitted conversation identity does not match this command.');
      const runId =
        mode === 'start' || mode === 'fork'
          ? spec.runId(projectId, body.data.commandId)
          : String(req.params.runId);
      noteMode(runId, body.data.mode);
      const result = await spec.turn(
        mode,
        runId,
        input,
        mode === 'fork' ? String(req.params.runId) : undefined,
      );
      await dependencies.recordResult?.(req, body.data, result, input);
      return result;
    });
  app.post(base, turn('start'));
  app.post(`${base}/:runId/turn`, turn('follow-up'));
  app.post(`${base}/:runId/resume`, turn('resume'));
  app.post(`${base}/:runId/fork`, turn('fork'));
  app.get(
    `${base}/:runId`,
    route(async (req) => {
      const status = await native().status(String(req.params.id), String(req.params.runId));
      return contract ? { ...status, controls: sessionControls(contract) } : status;
    }),
  );
  if (contract && contract.commands.steer.support !== 'unsupported')
    app.post(
      `${base}/:runId/steer`,
      route(async (req) => {
        const body = z
          .strictObject({ commandId, text: z.string().trim().min(1).max(32000) })
          .safeParse(req.body);
        if (!body.success) throw new ApiError(400, 'Provide a bounded command ID and the message text.');
        const runId = String(req.params.runId);
        const mode = modes.get(runId) ?? 'ask';
        const record = dependencies.recordResult;
        return native().steer(String(req.params.id), runId, body.data.commandId, body.data.text, {
          // Once sent, the message and its answer are projected into the thread exactly as a
          // turn sent through this route is, so the thread holds what the native session holds.
          onDelivered: record
            ? (result, input) =>
                record(
                  req,
                  {
                    commandId: input.requestId,
                    threadId: input.threadId,
                    text: input.prompt,
                    mode,
                    sources: [],
                    consent: true,
                  },
                  result,
                  input,
                )
            : undefined,
        });
      }),
    );
  for (const command of ['interrupt', 'close'] as const)
    app.post(
      `${base}/:runId/${command}`,
      route(async (req) => {
        const body = z.strictObject({ commandId }).safeParse(req.body);
        if (!body.success) throw new ApiError(400, 'Provide a bounded command ID.');
        return native().control(
          String(req.params.id),
          String(req.params.runId),
          body.data.commandId,
          command,
        );
      }),
    );
}

/**
 * H03: what a Console thread may offer for its open native conversation, read from the route
 * contract (the H04 `sessionControls` pattern) and from the conversation's durable record, and
 * nothing else. A thread whose open lineage is not a native session gets no controls.
 */
export interface ThreadSessionRouteDependencies {
  authorize(req: Request): Promise<void>;
  /** The run of the thread's open native lineage for `mode` (the newest when absent), or null. */
  lineage(projectId: string, threadId: string, mode?: 'ask' | 'plan' | 'auto'): Promise<string | null>;
  drivers: {
    claude(): ClaudeSessionRuns<SessionCheckpointFacts> | undefined;
    opencode(): ClaudeSessionRuns<SessionCheckpointFacts> | undefined;
  };
}
export function mountThreadSessionRoute(app: Express, dependencies: ThreadSessionRouteDependencies) {
  app.get('/api/projects/:id/threads/:threadId/native-session', async (req, res, next) => {
    try {
      await dependencies.authorize(req);
      const mode = z.enum(['ask', 'plan', 'auto']).optional().safeParse(req.query.mode);
      if (!mode.success) throw new ApiError(400, 'Provide a mode of ask, plan or auto, or none.');
      const projectId = String(req.params.id);
      const runId = await dependencies.lineage(projectId, String(req.params.threadId), mode.data);
      const native = runId?.startsWith('claude-')
        ? { driver: dependencies.drivers.claude(), routeId: 'claude-code-session' }
        : runId?.startsWith('opencode-')
          ? { driver: dependencies.drivers.opencode(), routeId: 'opencode-session' }
          : null;
      const empty: ThreadSessionView = {
        runId: null,
        controls: null,
        busy: false,
        continuity: null,
        requestedModel: null,
        reportedModel: null,
        queued: [],
      };
      if (!runId || !native?.driver) return res.json(empty);
      let status;
      try {
        status = await native.driver.status(projectId, runId);
      } catch (error) {
        // A lineage opened for a message that has not reached its run yet: nothing to control.
        if (error instanceof HarnessError && error.code === 'unknown_run')
          return res.json({ ...empty, controls: sessionControls(routeContractFor(native.routeId)) });
        throw error;
      }
      const view: ThreadSessionView = {
        runId,
        controls: sessionControls(routeContractFor(native.routeId)),
        busy: status.busy,
        continuity: status.continuity,
        requestedModel: status.requestedModel,
        reportedModel: status.reportedModel,
        queued: (status.steering ?? []).map((ack) => ({
          commandId: ack.commandId,
          state: ack.state,
          detail: ack.detail,
          at: ack.at,
        })),
      };
      res.json(view);
    } catch (error) {
      next(error);
    }
  });
}
