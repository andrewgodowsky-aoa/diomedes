import type { Express, NextFunction, Request, Response } from 'express';
import type { Store } from '../store.js';
import type { VerificationService } from './service.js';

/**
 * H17 routes. Declaring checks and running a verification are separate, and
 * neither is an authorization: see server/verification/service.ts for what a
 * verification may read and why it never runs project code.
 */
export function mountVerificationRoutes(app: Express, store: Store, verification: VerificationService) {
  const handle =
    (action: (req: Request) => Promise<unknown>) => async (req: Request, res: Response, next: NextFunction) => {
      try {
        res.json(await action(req));
      } catch (error) {
        next(error);
      }
    };
  const project = (req: Request) => String(req.params.id);

  app.put(
    '/api/projects/:id/tasks/:taskId/acceptance',
    handle((req) =>
      store.locked(() => verification.declare(project(req), String(req.params.taskId), req.body ?? {})),
    ),
  );
  app.get(
    '/api/projects/:id/sessions/:sessionId/verification',
    handle((req) =>
      store.locked(async () => {
        await verification.sync(project(req));
        return verification.view(project(req), String(req.params.sessionId));
      }),
    ),
  );
  // Not wrapped in the store lock: the service takes it itself around its reads
  // and its record, and leaves it free while a reviewer is thinking.
  app.post(
    '/api/projects/:id/sessions/:sessionId/verification',
    handle((req) => verification.verify(project(req), String(req.params.sessionId))),
  );
}
