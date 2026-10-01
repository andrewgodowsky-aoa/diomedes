/**
 * The ask a member makes when their own monthly credit limit stops a message (Andrew, 2026-10-01).
 *
 * The Console knows which message stopped: its project and its command id. It does not know the
 * business, and it never names the control plane's job. This route resolves both here, from the
 * project and from where the message ran, and sends the ask to the account service as the signed-in
 * person. A body carries one thing, the kind of ask. It never carries a job, a person, a business or
 * an amount; the service decides what an approval adds, and an owner or admin decides the approval.
 *
 * The request id is made here, from the project, the command and the kind, so a second press, a retry
 * or a second window is the same ask and the service answers it once.
 */
import type { Express, NextFunction, Request, Response } from 'express';
import type { AccountSessionService } from './accounts/session.js';
import { digest } from './harness/policy.js';
import { turnRunId } from './harness/model-session-run.js';
import { ApiError } from './paths.js';
import type { WorkspaceService } from './workspaces.js';

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export const ASK_NOT_SIGNED_IN =
  'This app is not signed in to a Nectovia account, so it cannot ask for more credits.';
export const ASK_NO_BUSINESS = 'This project doesn’t belong to a business, so there is no owner or admin to ask.';
export const ASK_MESSAGE_NOT_FOUND = 'That message wasn’t found, so the ask can’t name its job. Ask for the month instead.';
export const ASK_NOT_AN_AGENT_JOB = 'That message didn’t run on the Nectovia Agent, so it has no credit job to ask about.';

export interface CreditAskDeps {
  /** The business this project's work is for, the way the Agent gate resolves it. Null for none. */
  organizationFor(projectId: string): string | null;
  /** Where a message ran: the run it was recorded on, or null when this project has no such message. */
  locate(projectId: string, commandId: string): Promise<{ runId: string } | null>;
  /** The signed-in session, or null when nobody is signed in to an account service. */
  session: Pick<AccountSessionService, 'askCreditLimit'> | null;
  workspaces: Pick<WorkspaceService, 'assertMine'>;
}

/** The id of one ask. The same project, command and kind always make the same id. */
export const askRequestId = (projectId: string, commandId: string, kind: 'job' | 'month') =>
  `ask-${digest({ projectId, commandId, kind }).slice(0, 40)}`;

export function mountCreditAskRoutes(app: Express, deps: CreditAskDeps) {
  app.post(
    '/api/projects/:id/jobs/:commandId/credit-ask',
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const projectId = String(req.params.id);
        const commandId = String(req.params.commandId);
        if (!ID.test(commandId)) throw new ApiError(400, 'Name the message that stopped.', { code: 'invalid_request' });
        const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? (req.body as Record<string, unknown>) : {};
        // The client names the kind of ask and nothing else. A job, a person, a business or an amount
        // is something only the host and the account service decide.
        if (Object.keys(body).some((key) => key !== 'kind'))
          throw new ApiError(400, 'That request names something only the account service decides.', { code: 'client_field_refused' });
        if (body.kind !== 'job' && body.kind !== 'month')
          throw new ApiError(400, 'Ask for this job, or for the month.', { code: 'invalid_request' });
        const kind = body.kind;
        if (!deps.session) throw new ApiError(401, ASK_NOT_SIGNED_IN, { code: 'sign_in_required' });
        const organizationId = deps.organizationFor(projectId);
        if (!organizationId) throw new ApiError(409, ASK_NO_BUSINESS, { code: 'no_business' });
        deps.workspaces.assertMine(organizationId);
        let jobId: string | null = null;
        if (kind === 'job') {
          const located = await deps.locate(projectId, commandId);
          if (!located) throw new ApiError(404, ASK_MESSAGE_NOT_FOUND, { code: 'unknown_message' });
          // Only a model conversation is metered per message, under this run id.
          if (!located.runId.startsWith('model-')) throw new ApiError(409, ASK_NOT_AN_AGENT_JOB, { code: 'not_an_agent_job' });
          jobId = turnRunId(located.runId, commandId);
        }
        res.json(await deps.session.askCreditLimit(organizationId, { requestId: askRequestId(projectId, commandId, kind), kind, jobId }));
      } catch (error) {
        next(error);
      }
    },
  );
}
