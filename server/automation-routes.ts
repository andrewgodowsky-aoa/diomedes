/**
 * Automations routes (Milestones A and B).
 *
 * Mounted beside the workspace routes, behind the same loopback, origin and
 * client-header gates. Every route starts with the workspace's membership
 * check, so a non-member gets the 404 an organization that does not exist
 * gets, in the list, the detail and a deep link alike (A25).
 *
 * Reads take the store lock: admission writes an occurrence as `admitting` and
 * settles it inside one locked step, so a read never sees it half-way.
 */
import type { Express, Request, Response } from 'express';
import type { AutomationService } from './automations.js';
import type { Store } from './store.js';

const body = (req: Request): Record<string, unknown> =>
  req.body && typeof req.body === 'object' && !Array.isArray(req.body)
    ? (req.body as Record<string, unknown>)
    : {};

export function mountAutomationRoutes(app: Express, store: Store, automations: AutomationService) {
  const route =
    (action: (req: Request) => Promise<unknown>) =>
    async (req: Request, res: Response, next: (error?: unknown) => void) => {
      try {
        const result = await store.locked(() => action(req));
        if (!res.headersSent) res.json(result);
      } catch (error) {
        next(error);
      }
    };
  const organizationId = (req: Request) => String(req.params.organizationId ?? '');
  const automationId = (req: Request) => String(req.params.automationId ?? '');

  app.get(
    '/api/workspace/organizations/:organizationId/automations',
    route((req) => automations.list(organizationId(req))),
  );

  app.get(
    '/api/workspace/organizations/:organizationId/automations/:automationId',
    route((req) =>
      automations.detail(organizationId(req), automationId(req), Number(req.query.page ?? 1)),
    ),
  );

  /**
   * Run once. The body carries the press's command id, which the client keeps
   * for a retry of the same press, so a double click or a retried request is
   * one run and a duplicate receipt. `sources` is an owner or admin choice.
   */
  app.post(
    '/api/workspace/organizations/:organizationId/automations/:automationId/run',
    route((req) => automations.admit(organizationId(req), automationId(req), body(req))),
  );

  /**
   * Milestone B: edit, turn on, pause, resume or turn off the schedule, as
   * `{ action, expectedGeneration, schedule?, catchUpMinutes?, reason? }`. An
   * owner or admin only; each is a recorded act and a History entry. It takes
   * the store lock, as the scheduler's pass does, so a pause and a due slot
   * never interleave.
   */
  app.post(
    '/api/workspace/organizations/:organizationId/automations/:automationId/schedule',
    route((req) => automations.changeSchedule(organizationId(req), automationId(req), body(req))),
  );

  /** Say an attention item has been seen. Any active member; it changes no authority. */
  app.post(
    '/api/workspace/organizations/:organizationId/automations/:automationId/attention/:attentionId/seen',
    route((req) =>
      automations.markSeen(organizationId(req), automationId(req), String(req.params.attentionId ?? '')),
    ),
  );

  /** The open attention items that belong in one project's Needs you. In-app only. */
  app.get(
    '/api/projects/:projectId/automation-attention',
    route(async (req) => ({ items: automations.attentionForProject(String(req.params.projectId ?? '')) })),
  );
}
