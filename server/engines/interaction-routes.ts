import type { Express, NextFunction, Request, Response } from 'express';
import { z } from 'zod';
import { ApiError } from '../paths.js';
import { HarnessError } from '../harness/policy.js';
import { commandIdSchema } from '../command-admission.js';
import type { InteractionTurns, RequestContext } from '../interaction-service.js';
import { EngineError } from './process.js';

const id = z.string().trim().min(1).max(200);
/**
 * One message to Diomedes. The client mints `commandId` once per message, saves the pending
 * send before its first request, and retries with the same id and the same body. The server
 * resolves the run and the transport action itself, so a client never names a run here.
 */
export const messageBody = z.strictObject({
  commandId: commandIdSchema,
  text: z.string().trim().min(1).max(32000),
  mode: z.enum(['ask', 'plan', 'auto']),
  sources: z
    .array(
      z.strictObject({
        path: z.string().min(1).max(4000),
        sha: z.string().regex(/^[a-f0-9]{64}$/),
      }),
    )
    .max(8),
  consent: z.literal(true),
});
/**
 * The person's own choice to start what Diomedes proposed for one message. `consent` is the
 * same explicit consent a Work start carries: the instruction is sent to the selected engine.
 */
export const selectionBody = z.strictObject({
  proposalDigest: z.string().regex(/^[a-f0-9]{64}$/),
  projectId: id,
  consent: z.literal(true),
});

export interface InteractionRouteDependencies {
  /** Existing request and project authority. */
  authorize(req: Request): Promise<void>;
  /** Stops generation when the connection drops, and ends the progress stream with the response. */
  context?(req: Request): RequestContext;
}

export function mountInteractionRoutes(
  app: Express,
  turns: InteractionTurns,
  dependencies: InteractionRouteDependencies,
) {
  const base = '/api/projects/:id/threads/:threadId/messages';
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
  const command = (req: Request) => {
    const parsed = commandIdSchema.safeParse(req.params.commandId);
    if (!parsed.success) throw new ApiError(400, 'Provide a valid message command.');
    return parsed.data;
  };
  app.post(
    base,
    route(async (req) => {
      const body = messageBody.safeParse(req.body);
      if (!body.success)
        throw new ApiError(
          400,
          'Provide a message command, text, a mode of ask, plan or auto, the selected sources and consent.',
        );
      const { consent: _consent, ...message } = body.data;
      return turns.message(
        String(req.params.id),
        String(req.params.threadId),
        message,
        dependencies.context?.(req),
      );
    }),
  );
  app.post(
    `${base}/:commandId/select`,
    route(async (req) => {
      const body = selectionBody.safeParse(req.body);
      if (!body.success)
        throw new ApiError(400, 'Provide the proposal you are starting, its project and consent.');
      return turns.select(String(req.params.id), String(req.params.threadId), command(req), {
        proposalDigest: body.data.proposalDigest,
        projectId: body.data.projectId,
      });
    }),
  );
  app.get(
    `${base}/:commandId`,
    route((req) => turns.outcome(String(req.params.id), String(req.params.threadId), command(req))),
  );
}
