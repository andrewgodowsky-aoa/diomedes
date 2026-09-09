import type { Express, NextFunction, Request, Response } from 'express';
import { z } from 'zod';
import type { Store } from '../store.js';
import { ApiError } from '../paths.js';
import type { HarnessHost } from './host.js';
import { localHarnessPrincipal } from './bridge.js';
import { HarnessError } from './policy.js';

export function mountHarnessRoutes(app: Express, store: Store, host: HarnessHost) {
  const base = '/api/projects/:id/harness/runs';
  const route =
    (action: (req: Request) => Promise<unknown>) =>
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        await host.refreshSecrets();
        res.json(host.scrub(await action(req)));
      } catch (error) {
        if (error instanceof HarnessError) {
          const message =
            error.code === 'unsupported_run_version'
              ? 'This saved run needs a different version of Diomedes. Its record was left unchanged.'
              : error.code === 'invalid_run_record'
                ? 'This saved run could not be read. Its record was left unchanged.'
                : host.redact(error.message);
          next(
            new ApiError(error.code === 'unknown_run' ? 404 : 409, message, { code: error.code }),
          );
        } else next(error);
      }
    };
  app.get(
    base,
    route(async (req) => ({
      runs: (await host.list(String(req.params.id))).map((run) => ({
        id: run.id,
        state: run.state,
        capabilityId: run.capabilityId,
        capabilityVersion: run.capabilityVersion,
        taskId: run.taskId,
        sessionId: run.sessionId,
      })),
    })),
  );
  app.get(
    `${base}/:runId`,
    route((req) => host.get(String(req.params.id), String(req.params.runId))),
  );
  app.get(
    `${base}/:runId/events`,
    route(async (req) => {
      const raw = req.query.after ?? '0';
      if (typeof raw !== 'string' || !/^\d+$/.test(raw) || !Number.isSafeInteger(Number(raw)))
        throw new ApiError(400, 'Provide a nonnegative whole event cursor.');
      const run = await host.get(String(req.params.id), String(req.params.runId));
      return {
        events: run.events.filter((event) => event.seq > Number(raw)),
        lastSeq: run.lastSeq,
      };
    }),
  );
  app.post(
    `${base}/:runId/cancel`,
    route(async (req) => {
      const input = z
        .strictObject({ reason: z.string().trim().min(1).max(1000).optional() })
        .safeParse(req.body ?? {});
      if (!input.success) throw new ApiError(400, 'Provide a short reason for stopping the run.');
      const projectId = String(req.params.id);
      const run = await host.get(projectId, String(req.params.runId));
      await store.locked(() =>
        host.runs.cancel(
          run.id,
          input.data.reason ?? 'Stopped by the person.',
          localHarnessPrincipal(projectId),
        ),
      );
      await host.bridge.flush();
      return host.get(projectId, run.id);
    }),
  );
}
