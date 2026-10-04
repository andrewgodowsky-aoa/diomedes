import type { Express, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { BONSAI_PROFILES, BONSAI_ROUTE, type LocalModelsView } from '../../shared/bonsai.js';
import { ApiError } from '../paths.js';
import type { Store } from '../store.js';
import { BonsaiError, type BonsaiRuntime } from './runtime.js';

export function mountBonsaiRoutes(app: Express, runtime: BonsaiRuntime, store: Store) {
  const send = (action: (req: Request, signal: AbortSignal) => Promise<unknown>) =>
    async (req: Request, res: Response, next: NextFunction) => {
      const controller = new AbortController();
      const abort = () => controller.abort();
      res.once('close', abort);
      try { res.json(await action(req, controller.signal)); }
      catch (error) { next(error instanceof z.ZodError ? new ApiError(400, 'Choose a valid Bonsai profile.')
        : error instanceof BonsaiError ? new ApiError(409, error.message, { code: `bonsai_${error.state}` }) : error); }
      finally { res.off('close', abort); }
    };
  app.get('/api/ai/local-models', send(async (): Promise<LocalModelsView> => {
    const status = await runtime.status();
    return { route: BONSAI_ROUTE, kind: 'local', status, models: status.installed ? BONSAI_PROFILES : [] };
  }));
  app.post('/api/ai/local-models/wake', send(async (req, signal) => {
    const { model } = z.strictObject({ model: z.enum(['bonsai-gaming', 'bonsai-full']) }).parse(req.body);
    return runtime.wake(model, signal);
  }));
  app.get('/api/projects/:id/image-source', send(req => store.locked(() => store.readModelImage(
    String(req.params.id), z.string().min(1).max(1000).parse(req.query.path)))));
}
