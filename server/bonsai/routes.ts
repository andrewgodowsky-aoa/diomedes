import type { Express, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { BONSAI_PROFILES, BONSAI_ROUTE, type BonsaiStatus, type LocalModelsView } from '../../shared/bonsai.js';
import type { IntegrationStatus } from '../../shared/types.js';
import { ApiError } from '../paths.js';
import type { Store } from '../store.js';
import { BonsaiError, type BonsaiRuntime } from './runtime.js';

/** One short word for the integration's status line. */
const STATUS_WORDS: Record<BonsaiStatus['state'], string> = {
  missing: 'Not installed',
  unloaded: 'Not running',
  starting: 'Starting',
  ready: 'Running',
  busy: 'Running',
  'insufficient-memory': 'Not enough memory',
  error: 'Needs attention',
};

/**
 * The local model as the ask row reads it (`localModel()` in client/console/ask-row.ts): a
 * `kind: 'local'` integration whose id is its route, `found` once it is installed, `available`
 * only while its worker runs, and `loaded` naming the catalogue profile that worker has. Null
 * when nothing is installed, so the option stays hidden. Reading it starts nothing.
 */
export function bonsaiIntegration(status: BonsaiStatus): IntegrationStatus | null {
  if (!status.installed) return null;
  const running = status.state === 'ready' || status.state === 'busy';
  return {
    id: BONSAI_ROUTE, name: 'Bonsai', kind: 'local', found: true, available: running, enabled: true,
    status: STATUS_WORDS[status.state], detail: status.detail,
    capabilities: ['text', 'tools', 'images in Full'], signIn: 'not-needed', adapter: 'ready',
    disclosure: ['Local inference. Model startup checks available GPU memory.'],
    loaded: running ? (BONSAI_PROFILES.find(profile => profile.mode === status.mode)?.slug ?? null) : null,
  };
}

/**
 * The installed local model as integrations: one entry, or none when nothing is installed.
 * `/api/integrations` carries it with the rest, and `/api/integrations/local` answers it alone,
 * so the ask row can read it again after a Start without checking every other engine.
 */
export async function localModelIntegrations(runtime: BonsaiRuntime, configured: boolean): Promise<IntegrationStatus[]> {
  if (!configured) return [];
  const entry = bonsaiIntegration(await runtime.status());
  return entry ? [entry] : [];
}

export function mountBonsaiRoutes(app: Express, runtime: BonsaiRuntime, store: Store, configured: boolean) {
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
  app.get('/api/integrations/local', send(async () => ({ integrations: await localModelIntegrations(runtime, configured) })));
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
