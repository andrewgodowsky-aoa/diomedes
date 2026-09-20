import type { Express, Request, Response } from 'express';
import type { ProductKnowledgeBundle, ReadinessRuntimeSnapshot } from '../../shared/readiness.js';
import { ApiError } from '../paths.js';
import { projectReadiness } from './projection.js';

export interface ReadinessRouteDeps {
  /** Return cached facts only. This callback must not discover, probe or authorize. */
  snapshot(req: Request): Promise<ReadinessRuntimeSnapshot>;
  knowledge(): Promise<ProductKnowledgeBundle>;
  now?(): string;
}

export function mountReadinessRoutes(app: Express, deps: ReadinessRouteDeps) {
  const view = async (req: Request) => {
    const [snapshot, knowledge] = await Promise.all([deps.snapshot(req), deps.knowledge()]);
    return projectReadiness({ snapshot, knowledge, now: deps.now?.() });
  };
  const route = (action: (req: Request) => Promise<unknown>) =>
    async (req: Request, res: Response, next: (error?: unknown) => void) => {
      try {
        res.json(await action(req));
      } catch (error) {
        next(error);
      }
    };

  app.get('/api/readiness', route(async (req) => ({ readiness: await view(req) })));
  app.get(
    '/api/readiness/workflows/:workflowId',
    route(async (req) => {
      const readiness = await view(req);
      const workflow = readiness.workflows.find((item) => item.id === String(req.params.workflowId));
      if (!workflow)
        throw new ApiError(404, 'This readiness workflow is not part of shipped product knowledge.', {
          code: 'readiness_workflow_not_found',
        });
      return { workflow, generatedAt: readiness.generatedAt, build: readiness.build, knowledge: readiness.knowledge };
    }),
  );
}
