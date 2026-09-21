import { Router, json, type Request, type ErrorRequestHandler } from 'express';
import { inventoryReceiptSchema } from '../../shared/inventory.js';
import { inventoryReceiveSchema } from '../../shared/inventory-workflow.js';
import { ApiError } from '../paths.js';
import type { InventoryStockService } from './stock-service.js';

/** Mount only on a host with verified ingress. A header/body is never an Authority. */
export function inventoryReceiptRoutes<Claim>(options: {
  service: InventoryStockService<Claim>;
  projectId: string;
  claim: (request: Request) => Claim;
}) {
  const router = Router();
  router.use((_request, response, next) => {
    response.set('Cache-Control', 'no-store');
    next();
  });
  router.use(json({ limit: '8kb' }));
  router.get('/view', async (request, response) => {
    const cursor = request.query.olderThan;
    if (
      Object.keys(request.query).some((key) => key !== 'olderThan') ||
      (cursor !== undefined && !inventoryReceiptSchema.shape.id.safeParse(cursor).success)
    )
      throw new ApiError(422, 'Use a valid history cursor.');
    response.json(
      await options.service.view(
        options.projectId,
        options.claim(request),
        cursor as string | undefined,
      ),
    );
  });
  router.get('/operations/:operationId', async (request, response) => {
    const result = await options.service.status(
      options.projectId,
      request.params.operationId,
      options.claim(request),
    );
    response
      .status(result.status === 'denied' ? 403 : result.status === 'invalid' ? 422 : 200)
      .json(result);
  });
  router.post('/receipts', async (request, response) => {
    const parsed = inventoryReceiveSchema.safeParse(request.body);
    if (!parsed.success)
      throw new ApiError(
        422,
        'Provide a received quantity, location, operation ID and expected version.',
      );
    const result = await options.service.execute(
      options.projectId,
      parsed.data,
      options.claim(request),
    );
    response
      .status(
        result.status === 'denied'
          ? 403
          : result.status === 'conflict'
            ? 409
            : result.status === 'invalid'
              ? 422
              : 200,
      )
      .json(result);
  });
  router.use((_request, response) => {
    response.status(404).json({ error: 'Inventory route unavailable.' });
  });
  const errors: ErrorRequestHandler = (error: unknown, _request, response, _next) => {
    if (error instanceof ApiError) response.status(error.status).json({ error: error.message });
    else if (error instanceof SyntaxError)
      response.status(422).json({ error: 'Provide valid JSON.' });
    else
      response
        .status(503)
        .json({
          error: 'Inventory is unavailable. Check the operation status before retrying a receipt.',
        });
  };
  router.use(errors);
  return router;
}
