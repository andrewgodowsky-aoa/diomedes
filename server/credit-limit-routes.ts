/**
 * Members' monthly credit limits, as this app reaches them (Andrew, 2026-10-01).
 *
 * The account service keeps the limits, the asks for more and who used what, and enforces a limit where
 * credits are held. This surface only asks it as the signed-in person and hands the answer on: it keeps
 * no limit, usage figure or approval of its own, and decides nothing. Membership is checked here first so
 * an outsider reads as absent, and the owner-or-admin rule is applied early for the plain refusal; the
 * service refuses again, including the narrower rules for an admin.
 *
 * Nothing a request names is authority. A body never carries a business, a person to act as, a usage
 * figure or a balance. The two figures a request may carry are the approver's own choices (a limit, and
 * what a month raise adds), and the service validates and applies them. A member's ask names a job and a
 * kind, never an amount, the same way a one-job cap raise does (`server/job-cap-routes.ts`).
 *
 * Money crosses as whole micro-USD for the client to show as credits. Nothing here says a dollar.
 */
import type { Express, Request, Response } from 'express';
import type { CreditLimitSubject } from './accounts/client.js';
import type { AccountSessionService } from './accounts/session.js';
import { ApiError } from './paths.js';
import type { WorkspaceService } from './workspaces.js';

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

/** What this surface needs of the signed-in session. Left out, nobody is signed in to an account service. */
export type CreditLimitSession = Pick<
  AccountSessionService,
  | 'creditLimits' | 'setCreditLimit' | 'setCreditSettings' | 'myCreditUsage' | 'creditUsageReport'
  | 'askCreditLimit' | 'creditLimitRequests' | 'decideCreditLimit'
>;

const plain = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
const body = (req: Request) => plain(req.body);

const invalid = (message: string, code = 'invalid_request') => new ApiError(400, message, { code });

function only(value: Record<string, unknown>, allowed: readonly string[]) {
  const extra = Object.keys(value).filter((key) => !allowed.includes(key));
  if (extra.length) throw invalid('That request names something only the account service decides.', 'client_field_refused');
}

const id = (value: unknown, what: string): string => {
  if (typeof value !== 'string' || !ID.test(value)) throw invalid(`Provide ${what}.`);
  return value;
};

const money = (value: unknown, what: string): number => {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)
    throw invalid(`Provide ${what} as a whole number of micro-USD.`, 'invalid_amount');
  return value;
};

export const NOT_SIGNED_IN_REASON =
  'This app is not signed in to a Nectovia account, so it cannot reach this business’s credit limits. Nothing is estimated in its place.';

export function mountCreditLimitRoutes(
  app: Express,
  workspaces: Pick<WorkspaceService, 'assertMine' | 'assertCanManageMemberLimits'>,
  session: CreditLimitSession | null,
) {
  const base = '/api/workspace/organizations/:organizationId';
  const route =
    (action: (req: Request, organizationId: string) => Promise<unknown>) =>
    async (req: Request, res: Response, next: (error?: unknown) => void) => {
      try {
        const organizationId = String(req.params.organizationId ?? '');
        workspaces.assertMine(organizationId);
        res.json(await action(req, organizationId));
      } catch (error) {
        next(error);
      }
    };
  const signedIn = (): CreditLimitSession => {
    if (!session) throw new ApiError(401, NOT_SIGNED_IN_REASON, { code: 'sign_in_required' });
    return session;
  };
  const manager =
    (action: (req: Request, organizationId: string, account: CreditLimitSession) => Promise<unknown>) =>
    route(async (req, organizationId) => {
      workspaces.assertCanManageMemberLimits(organizationId);
      return action(req, organizationId, signedIn());
    });

  /** The limits, the default under them, and who sees what. Owners and admins. */
  app.get(`${base}/credit-limits`, manager(async (_req, organizationId, account) => account.creditLimits(organizationId)));

  /** Set or clear one limit, for a role or one person. */
  app.post(
    `${base}/credit-limits`,
    manager(async (req, organizationId, account) => {
      const value = body(req);
      only(value, ['subject', 'mode', 'limitMicroUsd']);
      const subject = plain(value.subject);
      let parsed: CreditLimitSubject;
      if (subject.kind === 'role' && (subject.role === 'member' || subject.role === 'admin')) {
        only(subject, ['kind', 'role']);
        parsed = { kind: 'role', role: subject.role };
      } else if (subject.kind === 'person') {
        only(subject, ['kind', 'personId']);
        parsed = { kind: 'person', personId: id(subject.personId, 'the person') };
      } else throw invalid('Name a role (member or admin) or a person.');
      if (value.mode !== 'limit' && value.mode !== 'unlimited' && value.mode !== 'inherit') throw invalid('A limit is a number of credits, unlimited, or inherited.');
      const limit = value.limitMicroUsd === undefined || value.limitMicroUsd === null ? null : money(value.limitMicroUsd, 'the limit');
      return account.setCreditLimit(organizationId, { subject: parsed, mode: value.mode, limitMicroUsd: limit });
    }),
  );

  /** Who sees what. The service lets only an owner change it. */
  app.post(
    `${base}/credit-limits/settings`,
    manager(async (req, organizationId, account) => {
      const value = body(req);
      only(value, ['membersSeeOwnUsage', 'adminsSeeMemberUsage']);
      for (const key of ['membersSeeOwnUsage', 'adminsSeeMemberUsage'])
        if (value[key] !== undefined && typeof value[key] !== 'boolean') throw invalid('Say yes or no.');
      return account.setCreditSettings(organizationId, {
        ...(value.membersSeeOwnUsage === undefined ? {} : { membersSeeOwnUsage: value.membersSeeOwnUsage as boolean }),
        ...(value.adminsSeeMemberUsage === undefined ? {} : { adminsSeeMemberUsage: value.adminsSeeMemberUsage as boolean }),
      });
    }),
  );

  /** The signed-in person's own usage against their own limit. Any member; never the pool or anyone else. */
  app.get(
    `${base}/credit-usage/mine`,
    route(async (_req, organizationId) =>
      session
        ? session.myCreditUsage(organizationId)
        : { state: 'unavailable', organizationId, reason: NOT_SIGNED_IN_REASON },
    ),
  );

  /** Who used what this month, by member. Owners and admins. */
  app.get(`${base}/credit-usage/members`, manager(async (_req, organizationId, account) => account.creditUsageReport(organizationId)));

  /**
   * A member asks to go past their limit, for one job or for the month. The person agrees to ask; an owner
   * or admin decides. The client mints the request id once per ask, so a retry is the same ask.
   */
  app.post(
    `${base}/credit-limit-requests`,
    route(async (req, organizationId) => {
      const value = body(req);
      only(value, ['requestId', 'kind', 'jobId']);
      if (value.kind !== 'job' && value.kind !== 'month') throw invalid('Ask for one job, or for the month.');
      const jobId = value.kind === 'job' ? id(value.jobId, 'the job') : null;
      if (value.kind === 'month' && value.jobId !== undefined && value.jobId !== null) throw invalid('A request for the month doesn’t name a job.');
      return signedIn().askCreditLimit(organizationId, { requestId: id(value.requestId, 'a request id'), kind: value.kind, jobId });
    }),
  );

  /** Every ask for an owner or admin; their own for anyone else. The service picks which. */
  app.get(`${base}/credit-limit-requests`, route(async (_req, organizationId) => signedIn().creditLimitRequests(organizationId)));

  /** An owner or admin approves or denies. An approval of a month names the credits to add, and may allow bought credits. */
  app.post(
    `${base}/credit-limit-requests/:requestId/decision`,
    manager(async (req, organizationId, account) => {
      const value = body(req);
      only(value, ['approve', 'extraMicroUsd', 'allowPurchased']);
      if (typeof value.approve !== 'boolean') throw invalid('Say whether to approve or deny.');
      if (value.allowPurchased !== undefined && typeof value.allowPurchased !== 'boolean') throw invalid('Say yes or no.');
      return account.decideCreditLimit(organizationId, id(req.params.requestId, 'the request'), {
        approve: value.approve,
        ...(value.extraMicroUsd === undefined ? {} : { extraMicroUsd: money(value.extraMicroUsd, 'the credits to add') }),
        ...(value.allowPurchased === undefined ? {} : { allowPurchased: value.allowPurchased }),
      });
    }),
  );
}
