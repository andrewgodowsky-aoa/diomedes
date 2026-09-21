import type { Express, Request, Response } from 'express';
import { z } from 'zod';
import {
  DISCOVERY_STAGES,
  HYPOTHESIS_OUTCOMES,
  PERSONALIZATION_LEVELS,
  createProspectDiscoverySchema,
  type DiscoveryArtifact,
  type DiscoveryExportReference,
} from '../../shared/discovery.js';
import { ApiError } from '../paths.js';
import type { DiscoveryService } from './service.js';

export interface DiscoveryRouteDependencies {
  /** Trusted loopback identity, normally WorkspaceService.currentPerson().id. */
  readonly operatorId: (req: Request) => string;
  /** Reads an already selected document through the existing Files path. */
  readonly importDocument?: (
    req: Request,
    input: { readonly projectId: string; readonly path: string; readonly sha: string },
  ) => Promise<{ readonly filename: string; readonly content: string }>;
  /** Writes through Store.writeRecorded into an explicitly approved existing project. */
  readonly exportToProject?: (
    req: Request,
    artifact: DiscoveryArtifact,
    projectId: string,
  ) => Promise<Omit<DiscoveryExportReference, 'routeLabel'>>;
}

const objectBody = (req: Request): unknown =>
  req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
const parse = <T>(schema: z.ZodType<T>, req: Request): T => {
  const result = schema.safeParse(objectBody(req));
  if (!result.success) {
    const fields = result.error.issues
      .flatMap((issue) =>
        issue.code === 'unrecognized_keys'
          ? issue.keys.map((key) => [...issue.path, key].join('.'))
          : [issue.path.join('.') || issue.message],
      )
      .join(', ');
    throw new ApiError(400, `The discovery request was refused: ${fields}.`, {
      code: 'invalid_discovery_request',
    });
  }
  return result.data;
};

const emptySchema = z.object({}).strict();
const importSchema = z
  .object({
    projectId: z.string().min(1).max(160),
    path: z.string().min(1).max(1_000),
    sha: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
const outcomeSchema = z
  .object({ outcome: z.enum(HYPOTHESIS_OUTCOMES), checkedAt: z.string().min(1).max(80) })
  .strict();
const classificationSchema = z
  .object({
    stage: z.enum(DISCOVERY_STAGES).optional(),
    personalizationLevel: z.enum(PERSONALIZATION_LEVELS).optional(),
  })
  .strict()
  .refine((value) => value.stage !== undefined || value.personalizationLevel !== undefined, {
    message: 'Choose a stage or personalization level.',
  });
const exportSchema = z.object({ projectId: z.string().min(1).max(160) }).strict();
const provenanceSchema = z.discriminatedUnion('class', [
  z
    .object({
      class: z.literal('observed'),
      evidence: z.discriminatedUnion('kind', [
        z
          .object({
            kind: z.literal('approved-file'),
            projectId: z.string().min(1).max(160),
            path: z.string().min(1).max(1_000),
            sha: z.string().regex(/^[a-f0-9]{64}$/),
            historyEntryId: z.string().min(1).max(160),
          })
          .strict(),
        z
          .object({
            kind: z.literal('diomedes-execution'),
            projectId: z.string().min(1).max(160),
            executionId: z.string().min(1).max(160),
            historyEntryId: z.string().min(1).max(160),
          })
          .strict(),
      ]),
    })
    .strict(),
  z.object({ class: z.literal('reported'), reportedBy: z.enum(['owner', 'consultant']) }).strict(),
  z
    .object({
      class: z.literal('hypothesized'),
      sourceFactIds: z.array(z.string().min(1).max(160)).max(100),
    })
    .strict(),
  z.object({ class: z.literal('unknown'), reason: z.string().min(1).max(500) }).strict(),
]);
const correctionSchema = z
  .object({
    factId: z.string().min(1).max(160),
    value: z.string().trim().min(1).max(1_000).nullable(),
    provenance: provenanceSchema,
  })
  .strict();
const factSchema = z
  .object({
    field: z.string().trim().min(1).max(240),
    label: z.string().trim().min(1).max(160),
    value: z.string().trim().min(1).max(1_000).nullable(),
    provenance: provenanceSchema,
  })
  .strict();
const transitionSchema = z.discriminatedUnion('to', [
  z
    .object({
      factId: z.string().min(1).max(160),
      to: z.literal('reported'),
      reportedBy: z.enum(['owner', 'consultant']),
    })
    .strict(),
  z
    .object({
      factId: z.string().min(1).max(160),
      to: z.literal('unknown'),
      reason: z.string().min(1).max(500),
    })
    .strict(),
]);

export function mountDiscoveryRoutes(
  app: Express,
  service: DiscoveryService,
  dependencies: DiscoveryRouteDependencies,
): void {
  const route =
    (action: (req: Request, res: Response) => Promise<unknown>, locked = true) =>
    async (req: Request, res: Response, next: (error?: unknown) => void) => {
      try {
        const result = locked
          ? await service.locked(() => action(req, res))
          : await action(req, res);
        if (!res.headersSent) res.json(result);
      } catch (error) {
        next(error);
      }
    };
  const operator = (req: Request) => dependencies.operatorId(req);
  const requestedProspect = (req: Request) => String(req.params.prospectId ?? '');
  const activeForPath = async (req: Request) =>
    service.assertActive(operator(req), requestedProspect(req));

  // There is deliberately no route that lists every prospect. The owner-facing
  // pane reads only the active record selected under the trusted operator id.
  app.get(
    '/api/discovery',
    route(async (req) => ({ record: await service.active(operator(req)) }), false),
  );
  app.post(
    '/api/discovery',
    route(async (req) => ({
      record: await service.createAndSelect(
        operator(req),
        parse(createProspectDiscoverySchema, req),
      ),
    })),
  );
  app.post(
    '/api/discovery/:prospectId/select',
    route(async (req) => {
      parse(emptySchema, req);
      return { record: await service.select(operator(req), requestedProspect(req)) };
    }),
  );
  app.post(
    '/api/discovery/:prospectId/import',
    route(async (req) => {
      if (!dependencies.importDocument)
        throw new ApiError(409, 'Import through Files is not available in this build.', {
          code: 'discovery_import_unavailable',
        });
      const input = parse(importSchema, req);
      await activeForPath(req);
      const document = await dependencies.importDocument(req, input);
      return {
        record: await service.importBrief(operator(req), document.filename, document.content),
      };
    }),
  );
  app.post(
    '/api/discovery/:prospectId/facts',
    route(async (req) => {
      await activeForPath(req);
      return { record: await service.addFact(operator(req), parse(factSchema, req)) };
    }),
  );
  app.post(
    '/api/discovery/:prospectId/facts/correct',
    route(async (req) => {
      await activeForPath(req);
      return { record: await service.correctFact(operator(req), parse(correctionSchema, req)) };
    }),
  );
  app.post(
    '/api/discovery/:prospectId/facts/public-transition',
    route(async (req) => {
      await activeForPath(req);
      return {
        record: await service.transitionPublicFact(operator(req), parse(transitionSchema, req)),
      };
    }),
  );
  app.post(
    '/api/discovery/:prospectId/hypothesis/outcome',
    route(async (req) => {
      await activeForPath(req);
      return {
        record: await service.setHypothesisOutcome(operator(req), parse(outcomeSchema, req)),
      };
    }),
  );
  app.post(
    '/api/discovery/:prospectId/classification',
    route(async (req) => {
      await activeForPath(req);
      return {
        record: await service.setClassification(operator(req), parse(classificationSchema, req)),
      };
    }),
  );
  app.post(
    '/api/discovery/:prospectId/export',
    route(async (req) => {
      if (!dependencies.exportToProject)
        throw new ApiError(409, 'Export through Files is not available in this build.', {
          code: 'discovery_export_unavailable',
        });
      const { projectId } = parse(exportSchema, req);
      await activeForPath(req);
      const operatorId = operator(req);
      const artifact = await service.exportActive(operatorId);
      const receipt = await dependencies.exportToProject(req, artifact, projectId);
      return { record: await service.recordExport(operatorId, receipt) };
    }),
  );
}
