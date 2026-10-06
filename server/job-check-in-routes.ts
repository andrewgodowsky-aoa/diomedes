/**
 * How far a business's jobs run before they check in, as this app reaches it (Andrew, 2026-10-05).
 *
 * The account service keeps the amounts: Nectovia's defaults, and a business's own, which an owner or an
 * admin sets and which apply to that business alone. This surface only asks it as the signed-in person
 * and hands the answer on. It keeps no amount of its own and decides nothing. Membership is checked
 * here first so an outsider reads as absent, and the owner-or-admin rule is applied early for the plain
 * refusal; the service refuses again.
 *
 * A body carries the business's own amounts and nothing else: never a business, a person, a tier a job
 * runs under or the amount a particular job is raised by. A job's raise is one more amount, sized by the
 * account service from these settings, in `server/job-cap-routes.ts`.
 */
import type { Express, Request, Response } from 'express';
import { MAX_CHECK_IN_CREDITS, setCheckInOverrideInput } from '../shared/job-check-ins.js';
import type { AccountSessionService } from './accounts/session.js';
import { ApiError } from './paths.js';
import type { WorkspaceService } from './workspaces.js';

/** What this surface needs of the signed-in session. Left out, nobody is signed in to an account service. */
export type JobCheckInSession = Pick<AccountSessionService, 'jobCheckInSettings' | 'setJobCheckIns'>;

export const CHECK_INS_NOT_SIGNED_IN =
  'This app is not signed in to a Nectovia account, so it cannot reach this business’s job check-ins.';
export const CHECK_IN_AMOUNT_INVALID = `Each amount is a whole number of credits from 1 to ${MAX_CHECK_IN_CREDITS.toLocaleString('en-US')}, or empty.`;

export function mountJobCheckInRoutes(
  app: Express,
  workspaces: Pick<WorkspaceService, 'assertMine' | 'assertCanManageMemberLimits'>,
  session: JobCheckInSession | null,
  /** Called after a change is saved, so amounts this app kept for a minute are read again. */
  changed: () => void = () => undefined,
) {
  const path = '/api/workspace/organizations/:organizationId/job-check-ins';
  const manager =
    (action: (req: Request, organizationId: string, account: JobCheckInSession) => Promise<unknown>) =>
    async (req: Request, res: Response, next: (error?: unknown) => void) => {
      try {
        const organizationId = String(req.params.organizationId ?? '');
        workspaces.assertMine(organizationId);
        workspaces.assertCanManageMemberLimits(organizationId);
        if (!session) throw new ApiError(401, CHECK_INS_NOT_SIGNED_IN, { code: 'sign_in_required' });
        res.json(await action(req, organizationId, session));
      } catch (error) {
        next(error);
      }
    };

  /** The amounts in force for this business, the defaults under them, and the business's own setting. Owners and admins. */
  app.get(path, manager(async (_req, organizationId, account) => account.jobCheckInSettings(organizationId)));

  /** Set the business's own amounts: a number for a tier, or null to go back to the default. Owners and admins. */
  app.post(
    path,
    manager(async (req, organizationId, account) => {
      const parsed = setCheckInOverrideInput.safeParse(req.body);
      if (!parsed.success) throw new ApiError(400, CHECK_IN_AMOUNT_INVALID, { code: 'invalid_amount' });
      const saved = await account.setJobCheckIns(organizationId, parsed.data);
      changed();
      return saved;
    }),
  );
}
