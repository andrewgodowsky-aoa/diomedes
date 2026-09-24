import type { Express } from 'express';
import type { Store } from './store.js';
import type { NativeWorkService } from './native-work.js';
import { ApiError } from './paths.js';
import {
  describePermissionChoices,
  REVIEWER_TIMEOUT_MS,
  type PermissionCapabilityView,
} from '../shared/permissions.js';
import { ROUTE_CAPABILITIES } from '../shared/capabilities.js';
import { listIsolatedEnvironments, NO_ENVIRONMENT_REASON } from './trust/environments.js';
import { REVIEWER_INDEPENDENCE_STATEMENT } from './trust/codex-reviewer.js';
import { engineCatalog } from './models.js';
import { AGENT_CATALOG } from '../shared/agents.js';
import type { HarnessBridge } from './harness/bridge.js';
/** The default reviewer identity. A grant may name another review-only Agent. */
const REVIEWER_AGENT = AGENT_CATALOG.find((item) => item.id === 'diomedes.reviewer')!;

/** Uses the existing loopback + client-header boundary; does not claim owner authentication. */
export function mountPermissionRoutes(
  app: Express,
  store: Store,
  nativeWork: NativeWorkService,
  bridge?: HarnessBridge,
) {
  const base = '/api/projects/:id/permissions/grants';
  app.get(base, (req, res) => res.json({ grants: store.scopeGrants.view(String(req.params.id)) }));
  /**
   * What this installation may truthfully offer. Availability is computed from
   * capability facts and the host's own reviewer wiring, never from a stored
   * preference, so the Console cannot present an option the host would refuse.
   */
  app.get('/api/projects/:id/permissions/capabilities', (req, res) => {
    const projectId = String(req.params.id);
    store.state(projectId);
    const requested = String(req.query.route ?? 'codex');
    const routeId = Object.hasOwn(ROUTE_CAPABILITIES, requested) ? requested : 'unknown';
    const scopedWritesSupported = routeId === 'codex';
    const codexEnabled = store.settings.services?.codex === true;
    const reviewerAvailable =
      store.scopeGrants.reviewerConfigured && scopedWritesSupported && codexEnabled;
    const reviewerReason = !store.scopeGrants.reviewerConfigured
      ? 'No separate reviewer route is connected on this installation.'
      : !scopedWritesSupported
        ? 'A reviewer is available for Codex text proposals only.'
        : !codexEnabled
          ? 'Turn on the Codex connection before a reviewer can be used.'
          : '';
    const environments = listIsolatedEnvironments();
    const { choices, fullAccess } = describePermissionChoices({
      routeId,
      scopedWritesSupported,
      reviewerAvailable,
      reviewerReason,
      environment: environments[0] ?? null,
    });
    const view: PermissionCapabilityView = {
      routeId,
      choices,
      fullAccess,
      environments: environments.map((item) => ({ id: item.id, name: item.name })),
      noEnvironmentReason: NO_ENVIRONMENT_REASON,
      reviewer: {
        available: reviewerAvailable,
        engine: 'codex',
        agentId: REVIEWER_AGENT.id,
        agentName: REVIEWER_AGENT.name,
        reason: reviewerReason,
        models: reviewerAvailable ? engineCatalog('codex').models.map((item) => item.slug) : [],
        independence: REVIEWER_INDEPENDENCE_STATEMENT,
        maxReviews: 20,
        timeoutMs: REVIEWER_TIMEOUT_MS,
      },
    };
    res.json(view);
  });
  app.post(base, async (req, res) => {
    if (req.headers.authorization || req.headers['x-slot-id'])
      throw new ApiError(403, 'Only the local client can confirm a task scope.');
    const projectId = String(req.params.id);
    const record = await store.locked(async () => {
      const granted = await store.scopeGrants.issue(projectId, req.body);
      await nativeWork.applyMatchingScope(projectId, granted.grant.taskId);
      return granted;
    });
    res.json(record);
  });
  app.post(`${base}/:grantId/revoke`, async (req, res) => {
    if (req.headers.authorization || req.headers['x-slot-id'])
      throw new ApiError(403, 'Only the local client can revoke a task scope.');
    if (
      !req.body ||
      typeof req.body !== 'object' ||
      Array.isArray(req.body) ||
      Object.keys(req.body).length
    )
      throw new ApiError(400, 'Revocation takes an empty object.');
    const projectId = String(req.params.id);
    const record = await store.locked(async () => {
      const revoked = await store.scopeGrants.revoke(projectId, String(req.params.grantId));
      const active = store
        .state(projectId)
        .sessions.filter(
          (session) =>
            session.taskId === revoked.grant.taskId &&
            ['working', 'waiting', 'queued'].includes(session.state),
        );
      for (const session of active)
        if (!session.sample && !session.engine.name.includes('harness'))
          await nativeWork.stop(projectId, session.id);
      return revoked;
    });
    res.json({
      ...record,
      detail:
        'Future scoped writes are blocked. Owned work was asked to stop; already-dispatched effects may finish.',
    });
  });

  /*
   * Remembered approvals (D5). Every route here is the person's explicit act
   * on the local client: remembering the approval just given, answering a
   * learned offer, or revoking. Nothing here is reachable from a slot, a
   * bearer credential, a setting or a configuration change.
   */
  const remembered = '/api/projects/:id/permissions/remembered';
  const localOnly = (req: { headers: Record<string, unknown> }, what: string) => {
    if (req.headers.authorization || req.headers['x-slot-id'])
      throw new ApiError(403, `Only the local client can ${what}.`);
  };
  const emptyBody = (value: unknown) => {
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length)
      throw new ApiError(400, 'This takes an empty object.');
  };
  app.get(remembered, (req, res) =>
    res.json(store.scopeGrants.remembered.view(String(req.params.id))),
  );
  app.post(remembered, async (req, res) => {
    localOnly(req, 'remember an approval');
    const input = req.body as unknown;
    if (
      !input ||
      typeof input !== 'object' ||
      Array.isArray(input) ||
      Object.keys(input).join() !== 'needId' ||
      typeof (input as { needId: unknown }).needId !== 'string'
    )
      throw new ApiError(400, 'Name the approval you just gave to remember it.');
    if (!bridge) throw new ApiError(503, 'Remembered approvals are not available on this host.');
    const projectId = String(req.params.id);
    const needId = (input as { needId: string }).needId;
    res.json(await store.locked(() => bridge.remember(projectId, needId)));
  });
  app.post(`${remembered}/offers/:offerId/accept`, async (req, res) => {
    localOnly(req, 'accept an offer to stop asking');
    emptyBody(req.body);
    const projectId = String(req.params.id);
    const record = await store.locked(async () => {
      const accepted = store.scopeGrants.remembered.acceptOffer(projectId, String(req.params.offerId));
      await store.persist(store.state(projectId));
      return accepted;
    });
    res.json(record);
  });
  app.post(`${remembered}/offers/:offerId/decline`, async (req, res) => {
    localOnly(req, 'answer an offer');
    emptyBody(req.body);
    const projectId = String(req.params.id);
    const offer = await store.locked(async () => {
      const declined = store.scopeGrants.remembered.declineOffer(projectId, String(req.params.offerId));
      await store.persist(store.state(projectId));
      return declined;
    });
    res.json(offer);
  });
  app.post(`${remembered}/:grantId/revoke`, async (req, res) => {
    localOnly(req, 'revoke a remembered approval');
    emptyBody(req.body);
    const projectId = String(req.params.id);
    const record = await store.locked(async () => {
      const revoked = store.scopeGrants.remembered.revoke(projectId, String(req.params.grantId));
      await store.persist(store.state(projectId));
      return revoked;
    });
    res.json(record);
  });
}
