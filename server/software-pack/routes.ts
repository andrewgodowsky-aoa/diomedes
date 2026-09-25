/**
 * The Software Engineering pack's repository routes (P07). Each refuses with
 * `pack_inactive` in a Project that has not turned the pack on, before it
 * reads anything or starts any process.
 *
 * The writes (a command run, a worktree change) are two calls: the request,
 * which records the exact intent and waits, and the answer, which must name
 * that intent's hash. Neither route takes the Store lock around a run; the
 * service takes it only to write its records.
 */
import type express from 'express';
import type { Request, Response } from 'express';
import type { SoftwarePackService } from './service.js';

type Route = (
  action: (req: Request, res: Response) => Promise<unknown>,
  locked?: boolean,
) => express.RequestHandler;

export function mountSoftwarePackRoutes(
  app: express.Express,
  input: { service: SoftwarePackService; route: Route; body: (req: Request) => Record<string, unknown> },
) {
  const { service, route, body } = input;
  const id = (req: Request) => String(req.params.id);
  const base = '/api/projects/:id/software';

  app.get(`${base}`, route((req) => service.view(id(req)), false));
  app.get(`${base}/repository`, route(async (req) => service.repository(id(req)), false));
  app.get(`${base}/file`, route(async (req) => service.file(id(req), req.query.path), false));
  app.post(`${base}/diff`, route(async (req) => service.diff(id(req), body(req)), false));
  app.put(`${base}/commands`, route(async (req) => ({ commands: await service.declareCommands(id(req), body(req)) })));
  app.post(`${base}/commands/:commandId/run`, route((req) => service.requestCommand(id(req), String(req.params.commandId)), false));
  app.post(`${base}/runs/:runId/decision`, route((req) => service.decideCommand(id(req), String(req.params.runId), body(req)), false));
  app.post(`${base}/worktrees`, route((req) => service.requestWorktree(id(req), body(req)), false));
  app.post(
    `${base}/worktrees/:requestId/decision`,
    route((req) => service.decideWorktree(id(req), String(req.params.requestId), body(req)), false),
  );
}
