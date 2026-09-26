/**
 * The desktop's account routes, and the rule that everything else needs a
 * signed-in person.
 *
 *   GET   /api/account                                   who is signed in, their businesses, the chooser
 *   POST  /api/account/sign-in | sign-up | resume | sign-out | forget | refresh
 *   POST  /api/account/browser-sign-in                   sign in to the deployed service through the system browser
 *   GET   /api/account/organizations/:id/roster          people, by what the viewer's role may see
 *   POST  /api/account/organizations/:id/invitation-codes
 *   POST  /api/account/organizations/:id/invitation-codes/:codeId/revoke
 *   PATCH /api/account/organizations/:id/members/:personId
 *   POST  /api/account/invitation-codes/redeem
 *
 * Mounted after the loopback, origin and client-header guards, and before any
 * other /api route. The account service decides every permission; these routes
 * validate shape, pass the request on as the signed-in person and report back.
 */
import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import { SIGN_IN_REQUIRED } from '../../shared/accounts.js';
import { ApiError } from '../paths.js';
import type { AccountSessionService } from './session.js';

const email = z.string().trim().toLowerCase().email().max(320);
const signInBody = z.strictObject({ email, password: z.string().min(1).max(256), remember: z.boolean().default(false) });
const signUpBody = z.strictObject({
  name: z.string().trim().min(1).max(120),
  email,
  password: z.string().min(10, 'Use at least 10 characters for the password.').max(256),
  remember: z.boolean().default(false),
});
const personBody = z.strictObject({ personId: z.string().min(1).max(128) });
const role = z.enum(['owner', 'admin', 'member']);
const codeBody = z.strictObject({
  role,
  email: email.nullable().default(null),
  days: z.number().int().min(1).max(7).default(7),
});
const memberBody = z.strictObject({ role, state: z.enum(['active', 'revoked']) });
const redeemBody = z.strictObject({ code: z.string().trim().min(4).max(40) });
const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/);

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value ?? {});
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const message = issue?.message && !issue.message.startsWith('Invalid') ? issue.message : 'Check the details and try again.';
    throw new ApiError(422, message, { code: 'invalid_account_request' });
  }
  return parsed.data;
}

const param = (req: Request, name: string) => parse(id, req.params[name]);

/** Paths that work before anyone signs in: the account routes themselves and the update channel. */
const OPEN = [/^\/api\/account(\/|$)/, /^\/api\/updates\//];

export function mountAccountSessionRoutes(app: Express, session: AccountSessionService) {
  const route =
    (action: (req: Request) => Promise<unknown>) => async (req: Request, res: Response, next: NextFunction) => {
      try {
        const result = await action(req);
        if (result === undefined) res.status(204).end();
        else res.json(result);
      } catch (error) {
        next(error);
      }
    };
  const router = express.Router();
  router.use(express.json({ limit: '16kb' }));

  router.get('/', route(async () => session.read()));
  router.post('/sign-in', route(async (req) => session.signIn(parse(signInBody, req.body))));
  router.post('/browser-sign-in', route(async () => session.signInWithBrowser()));
  router.post('/sign-up', route(async (req) => session.signUp(parse(signUpBody, req.body))));
  router.post('/resume', route(async (req) => session.resume(parse(personBody, req.body).personId)));
  router.post('/sign-out', route(async () => session.signOut()));
  router.post('/forget', route(async (req) => session.forget(parse(personBody, req.body).personId)));
  router.post(
    '/refresh',
    route(async () => {
      await session.reload();
      return session.state();
    }),
  );
  router.get('/organizations/:organizationId/roster', route(async (req) => session.roster(param(req, 'organizationId'))));
  router.post(
    '/organizations/:organizationId/invitation-codes',
    route(async (req) => {
      const body = parse(codeBody, req.body);
      return session.createInvitationCode(param(req, 'organizationId'), {
        role: body.role,
        email: body.email,
        ttlMs: body.days * 86_400_000,
      });
    }),
  );
  router.post(
    '/organizations/:organizationId/invitation-codes/:codeId/revoke',
    route(async (req) => {
      const codeId = parse(z.string().regex(/^[a-f0-9]{16}$/), req.params.codeId);
      await session.revokeInvitationCode(param(req, 'organizationId'), codeId);
      return undefined;
    }),
  );
  router.patch(
    '/organizations/:organizationId/members/:personId',
    route(async (req) => session.setMember(param(req, 'organizationId'), param(req, 'personId'), parse(memberBody, req.body))),
  );
  router.post(
    '/invitation-codes/redeem',
    route(async (req) => {
      const joined = await session.redeemInvitationCode(parse(redeemBody, req.body).code);
      return { organization: { id: joined.organization.id, name: joined.organization.name }, role: joined.membership.role, account: session.state() };
    }),
  );
  app.use('/api/account', router);

  // Everything else under /api needs a signed-in person. The renderer shows the
  // sign-in screen on this code; nothing behind it runs or reads.
  app.use('/api', (req, _res, next) => {
    if (session.signedIn() || OPEN.some((pattern) => pattern.test(req.originalUrl.split('?')[0]))) return next();
    next(new ApiError(401, 'Sign in to use Nectovia.', { code: SIGN_IN_REQUIRED }));
  });
}
