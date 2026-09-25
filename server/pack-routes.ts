/**
 * The pack routes: the per-project listing and activation the Console already
 * used, now through the lifecycle, and the installation-wide install, update,
 * rollback and uninstall actions.
 *
 * Activation is a Project-level record and nothing more: no grant, no Need, no
 * permission changes here (`AGENTS.md` decision 14). The listing carries the
 * manifests so the person reads what a pack requests before deciding, and the
 * instruction records so what discovery found is inspectable.
 */
import path from 'node:path';
import type express from 'express';
import type { Request, Response } from 'express';
import { CAPABILITY_PACK_IDS, CAPABILITY_PACKS } from '../shared/capability-packs.js';
import { PACK_ID_PATTERN } from '../shared/pack-manifest.js';
import { discoverInstructionFiles } from './capability-packs.js';
import { bundledCatalogue } from './pack-catalogue.js';
import { PackLifecycle } from './pack-lifecycle.js';
import { ApiError } from './paths.js';
import { identifier, type Store } from './store.js';
import { activeIndexes, loadedIn } from './pack-contributions.js';
import {
  isContributionKind,
  renderIndex,
  type RegisteredPackIndex,
} from '../shared/pack-contributions.js';

/** What a pack's index costs a request against what all its bodies would, in bytes (P04). */
function indexBudgetOf(index: RegisteredPackIndex) {
  const kinds = [...new Set(index.entries.map((entry) => entry.kind))];
  const indexBytes = kinds.reduce(
    (total, kind) => total + Buffer.byteLength(renderIndex([index], kind)),
    0,
  );
  const bodyBytes = index.entries.reduce((total, entry) => total + entry.bytes, 0);
  return { indexBytes, bodyBytes };
}

type Route = (
  action: (req: Request, res: Response) => Promise<unknown>,
  locked?: boolean,
) => express.RequestHandler;

export function mountPackRoutes(
  app: express.Express,
  input: { store: Store; route: Route; body: (req: Request) => Record<string, unknown> },
): PackLifecycle {
  const { store, route, body } = input;
  const packs = new PackLifecycle({
    store,
    root: path.join(store.dataDir, 'packs'),
    catalogue: () => bundledCatalogue(),
  });
  const projectId = (req: Request) => String(req.params.id);
  /** A pack id this build knows: installed, bundled, or refused as absent. */
  const packId = async (req: Request) => {
    const value = String(req.params.packId);
    if (
      PACK_ID_PATTERN.test(value) &&
      ((await packs.isInstalled(value)) ||
        (await packs.catalogue()).some((manifest) => manifest.id === value))
    )
      return value;
    throw new ApiError(404, 'This capability pack does not exist.');
  };
  const flag = (value: unknown) => value === true;
  /** Options for a per-project action. A bare POST, as the Console sent before the lifecycle, has none. */
  const options = (req: Request) => (req.body === undefined ? {} : body(req));

  /** Everything the Capabilities section shows for one Project, read from the records. */
  const view = async (id: string) => {
    const state = store.state(id);
    let installed: Awaited<ReturnType<PackLifecycle['installed']>> = [];
    let available: Awaited<ReturnType<PackLifecycle['available']>> = [];
    let operations: Awaited<ReturnType<PackLifecycle['operations']>> = [];
    let loaded: Awaited<ReturnType<PackLifecycle['loadedContributions']>> = [];
    let storeProblem: string | null = null;
    try {
      [installed, available, operations, loaded] = await Promise.all([
        packs.installed(),
        packs.available(),
        packs.operations(),
        packs.loadedContributions(id),
      ]);
    } catch (error) {
      // A store this build cannot read is reported as it is, never replaced.
      storeProblem = error instanceof Error ? error.message : 'The pack store could not be read.';
    }
    return {
      packs: CAPABILITY_PACK_IDS.map((pack) => CAPABILITY_PACKS[pack]),
      activations: state.project.packs ?? [],
      instructionFiles: await discoverInstructionFiles(store, id),
      installed,
      available,
      operations,
      loaded,
      storeProblem,
    };
  };
  const decided = (id: string) => {
    const state = store.state(id);
    return { activations: state.project.packs ?? [], instructionFiles: state.instructionFiles ?? [] };
  };

  app.get('/api/projects/:id/packs', route(async (req) => view(projectId(req))));
  app.post(
    '/api/projects/:id/packs/:packId/activate',
    route(async (req) => {
      const id = projectId(req);
      store.state(id);
      await packs.activate(id, await packId(req), {
        includeDependencies: flag(options(req).includeDependencies),
      });
      return decided(id);
    }),
  );
  app.post(
    '/api/projects/:id/packs/:packId/deactivate',
    route(async (req) => {
      const id = projectId(req);
      store.state(id);
      await packs.deactivate(id, await packId(req));
      return decided(id);
    }),
  );

  // P04: the contribution index of the packs that are on here, and what is loaded. Bodies are
  // never listed; a panel loads one when a person opens it.
  app.get(
    '/api/projects/:id/packs/contributions',
    route(async (req) => {
      const state = store.state(projectId(req));
      const indexes = activeIndexes(state);
      return {
        indexes,
        loaded: loadedIn(state),
        records: (state.contributionRecords ?? []).slice(-50),
        budgets: indexes.map((index) => ({
          packId: index.packId,
          ...indexBudgetOf(index),
        })),
      };
    }),
  );
  app.post(
    '/api/projects/:id/packs/:packId/contributions/:kind/:contributionId/open',
    route(async (req) => {
      const id = projectId(req);
      const state = store.state(id);
      const kind = String(req.params.kind);
      if (!isContributionKind(kind)) throw new ApiError(404, 'That is not a kind of contribution.');
      const pin = await packs.contributions.admit(state, identifier('open-'));
      const loaded = await packs.contributions.load(
        pin,
        { packId: String(req.params.packId), kind, id: String(req.params.contributionId) },
        { reason: 'opened', state },
      );
      await store.persist(state);
      return loaded;
    }),
  );

  // Installation-wide actions. Each is recorded in the pack store before it returns.
  app.post(
    '/api/packs/inspect',
    route(async (req) => packs.inspect(body(req).source)),
  );
  app.post(
    '/api/packs/install',
    route(async (req) =>
      packs.install(body(req).source, { includeDependencies: flag(body(req).includeDependencies) }),
    ),
  );
  app.post(
    '/api/packs/:packId/update',
    route(async (req) => packs.update(await packId(req), body(req).source)),
  );
  app.post(
    '/api/packs/:packId/rollback',
    route(async (req) => packs.rollback(await packId(req))),
  );
  app.post(
    '/api/packs/:packId/uninstall',
    route(async (req) => packs.uninstall(await packId(req))),
  );
  return packs;
}
