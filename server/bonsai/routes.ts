import type { Express, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import {
  localModelCatalog,
  localProfileRefusal,
  LOCAL_MODEL_DESCRIPTOR,
  LOCAL_MODEL_ROUTE,
  type LocalModelStatus,
  type LocalModelsView,
} from '../../shared/local-model.js';
import type { IntegrationStatus } from '../../shared/types.js';
import { ApiError } from '../paths.js';
import type { Store } from '../store.js';
import type { LocalModelSetup } from './descriptor.js';
import { LocalModelError, type LocalModelRuntime } from './runtime.js';

/** One short word for the integration's status line. */
const STATUS_WORDS: Record<LocalModelStatus['state'], string> = {
  missing: 'Not installed',
  unloaded: 'Not running',
  starting: 'Starting',
  ready: 'Running',
  busy: 'Running',
  'insufficient-memory': 'Not enough memory',
  error: 'Needs attention',
};
const DISCLOSURE = [`Inference runs on this computer, on the server ${LOCAL_MODEL_DESCRIPTOR} names.`];

/**
 * The local model as the ask row reads it (`localModel()` in client/console/ask-row.ts): a
 * `kind: 'local'` integration whose id is its route and whose name is the descriptor's, `found`
 * once its folder holds a descriptor that passed every check, `available` only while its worker
 * runs, and `loaded` naming the catalogue profile that worker has. Null when no folder is set, so
 * the option stays hidden. A folder whose descriptor was refused is listed as not found, with the
 * sentence that says why, so Settings can show it. Reading it starts nothing.
 */
export function localModelIntegration(setup: LocalModelSetup, status: LocalModelStatus): IntegrationStatus | null {
  if (setup.kind === 'none') return null;
  if (setup.kind === 'invalid')
    return {
      id: LOCAL_MODEL_ROUTE, name: 'Local model', kind: 'local', found: false, available: false, enabled: true,
      status: STATUS_WORDS.error, detail: setup.detail, location: setup.folder.path,
      capabilities: [], signIn: 'not-needed', adapter: 'ready', disclosure: DISCLOSURE, loaded: null,
    };
  if (!status.installed) return null;
  const running = status.state === 'ready' || status.state === 'busy';
  const { descriptor } = setup;
  return {
    id: LOCAL_MODEL_ROUTE, name: descriptor.name, kind: 'local', found: true, available: running, enabled: true,
    status: STATUS_WORDS[status.state], detail: status.detail, location: descriptor.folder,
    capabilities: ['text', 'tools', ...descriptor.profiles.filter(profile => profile.inputModalities.includes('image'))
      .map(profile => `images in ${profile.mode}`)],
    signIn: 'not-needed', adapter: 'ready', disclosure: DISCLOSURE,
    loaded: running ? (descriptor.profiles.find(profile => profile.mode === status.mode)?.slug ?? null) : null,
  };
}

/**
 * The local model as integrations: one entry, or none when no folder is set. `/api/integrations`
 * carries it with the rest, and `/api/integrations/local` answers it alone, so the ask row can read
 * it again after a Start without checking every other engine. `fresh` asks the host again instead
 * of reusing a recent check.
 */
export async function localModelIntegrations(
  runtime: LocalModelRuntime,
  options: { fresh?: boolean } = {},
): Promise<IntegrationStatus[]> {
  const setup = runtime.setup();
  if (setup.kind === 'none') return [];
  const entry = localModelIntegration(setup, await runtime.status(options));
  return entry ? [entry] : [];
}

/** What `GET /api/ai/local-models` answers: the folder, its descriptor's name and profiles, and the status. */
export async function localModelsView(runtime: LocalModelRuntime): Promise<LocalModelsView> {
  const status = await runtime.status({ fresh: true });
  const setup = runtime.setup();
  return {
    route: LOCAL_MODEL_ROUTE, kind: 'local',
    name: setup.kind === 'ready' ? setup.descriptor.name : null,
    folder: setup.kind === 'none' ? null : setup.folder,
    status,
    models: setup.kind === 'ready' && status.installed ? localModelCatalog(setup.descriptor, status) : [],
  };
}

export function mountLocalModelRoutes(app: Express, runtime: LocalModelRuntime, store: Store) {
  const send = (action: (req: Request, signal: AbortSignal) => Promise<unknown>) =>
    async (req: Request, res: Response, next: NextFunction) => {
      const controller = new AbortController();
      const abort = () => controller.abort();
      res.once('close', abort);
      try { res.json(await action(req, controller.signal)); }
      catch (error) { next(error instanceof z.ZodError ? new ApiError(400, 'Choose a local model profile.')
        : error instanceof LocalModelError ? new ApiError(409, error.message, { code: `bonsai_${error.state}` }) : error); }
      finally { res.off('close', abort); }
    };
  // Both are the local model's own reads, asked for after a Start or when its controls open, so
  // they ask the host again. The full integration list reuses a recent check.
  app.get('/api/integrations/local', send(async () => ({
    integrations: await localModelIntegrations(runtime, { fresh: true }),
  })));
  app.get('/api/ai/local-models', send(() => localModelsView(runtime)));
  // A Start names one of the descriptor's profiles, or a profile saved before profiles came from it.
  app.post('/api/ai/local-models/wake', send(async (req, signal) => {
    const { model } = z.strictObject({ model: z.string().min(1).max(80) }).parse(req.body);
    if (!runtime.configured()) throw new LocalModelError('missing', "The local model isn't installed on this computer.");
    if (!runtime.profile(model)) throw new ApiError(400, localProfileRefusal(model));
    return runtime.wake(model, signal);
  }));
  app.get('/api/projects/:id/image-source', send(req => store.locked(() => store.readModelImage(
    String(req.params.id), z.string().min(1).max(1000).parse(req.query.path)))));
}
