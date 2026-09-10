import type { Express } from 'express';
import type { Store } from './store.js';
import type { NativeWorkService } from './native-work.js';
import { ApiError } from './paths.js';

/** Uses the existing loopback + client-header boundary; does not claim owner authentication. */
export function mountPermissionRoutes(app: Express, store: Store, nativeWork: NativeWorkService) {
  const base = '/api/projects/:id/permissions/grants';
  app.get(base, (req, res) => res.json({ grants: store.scopeGrants.view(String(req.params.id)) }));
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
}
