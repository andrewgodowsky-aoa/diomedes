import type { Express, NextFunction, Request, Response } from 'express';
import { z } from 'zod';
import { ApiError } from '../paths.js';
import { HarnessError } from '../harness/policy.js';
import { claudeSessionRunId } from '../harness/claude-session-run.js';
import type { ClaudeSessionTurnResult } from '../harness/claude-session-run.js';
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
  const base = '/api/projects/:id/claude-sessions';
  const native = () => {
    if (!engines.nativeSessions)
      throw new ApiError(503, 'The native conversation runtime is unavailable.');
    return engines.nativeSessions;
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
  const turn = (mode: 'start' | 'follow-up' | 'resume' | 'fork') =>
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
          ? claudeSessionRunId(projectId, body.data.commandId)
          : String(req.params.runId);
      const result = await engines.claudeSession(
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
    route((req) => native().status(String(req.params.id), String(req.params.runId))),
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
