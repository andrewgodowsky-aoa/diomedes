/**
 * The desktop's phone relay setting, one per business:
 *
 *   GET /api/account/organizations/:id/phone-relay   whether it's on, this computer's name, and its state
 *   PUT /api/account/organizations/:id/phone-relay   { enabled: boolean }
 *
 * Mounted after the account routes, behind the same loopback, origin and
 * client-header guards. Only the account service decides who may turn it on;
 * these routes validate shape and report back. No answer carries a key.
 */
import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import { ApiError } from '../paths.js';
import type { PhoneRelayService } from './service.js';

const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/);
const changeBody = z.strictObject({ enabled: z.boolean() });

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value ?? {});
  if (!parsed.success) throw new ApiError(422, 'Check the details and try again.', { code: 'invalid_account_request' });
  return parsed.data;
}

export function mountPhoneRelayRoutes(app: Express, relay: PhoneRelayService) {
  const route =
    (action: (req: Request) => Promise<unknown>) => async (req: Request, res: Response, next: NextFunction) => {
      try {
        res.json(await action(req));
      } catch (error) {
        next(error);
      }
    };
  const router = express.Router();
  router.use(express.json({ limit: '1kb' }));
  router.get(
    '/organizations/:organizationId/phone-relay',
    route(async (req) => relay.view(parse(id, req.params.organizationId))),
  );
  router.put(
    '/organizations/:organizationId/phone-relay',
    route(async (req) => relay.setEnabled(parse(id, req.params.organizationId), parse(changeBody, req.body).enabled)),
  );
  app.use('/api/account', router);
}
