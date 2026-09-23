/**
 * The job-cap routes: the pre-send estimate, the one-job cap raise a person
 * agrees to, and the status a stopped job reports.
 *
 * Every number here is the host's. The estimate is computed from what the host
 * would send (its own route, model, declared prices, limits and step cap), the
 * tier is read from the thread, and a raise is sized by `oneJobRaise` from the
 * host's own estimate or the recorded stop. A request body names a job and a
 * message, never a cap or an amount.
 */
import type { Express, Request, Response } from 'express';
import {
  approvedJobCap,
  capWarningCopy,
  estimateJob,
  oneJobRaise,
  overrunCopy,
  worstCaseNote,
  type JobEstimate,
  type JobEstimateView,
  type JobRates,
  type JobShape,
  type JobStatusView,
  type JobTier,
} from '../shared/job-caps.js';
import type { MicroUsd } from '../shared/managed-usage.js';
export type { JobEstimateView, JobStatusView } from '../shared/job-caps.js';
import type { Mode } from '../shared/types.js';
import { modeOf } from './modes.js';
import { ApiError } from './paths.js';
import { capOf, type JobCaps, type JobRecord } from './job-caps.js';
import type { ModelRateCard } from './spend-exposure.js';

/** Who agrees on this computer. There is one person at the keyboard and no sign-in. */
export const LOCAL_AGREEMENT = 'local-person';

/** What one job would run on and how large it can grow, as the host would send it. */
export interface JobPlan {
  threadId: string | null;
  metering: 'metered' | 'not-metered';
  /** Null on a metered route: the price is unknown, and the estimate says so and warns. */
  rates: JobRates | null;
  shape: JobShape;
  reason?: string;
}

export interface MessageDraft {
  text: string;
  mode: Mode;
  sources: { path: string; sha: string }[];
}

export interface JobCapRouteDeps {
  jobCaps: JobCaps;
  /** The plan a message on this thread would run under, resolved the way sending resolves it. */
  messagePlan(projectId: string, threadId: string, draft: MessageDraft): Promise<JobPlan>;
  /** The plan the next wake of this team member would run under. */
  teamWakePlan(projectId: string, slotId: string): Promise<JobPlan & { threadId: string }>;
  /** Wake the member exactly as the team wake route does. */
  wake(projectId: string, slotId: string): Promise<unknown>;
}

/** A route's declared prices as the estimate reads them: the dearer band of each, never a discount. */
export function jobRatesOf(card: ModelRateCard | null): JobRates | null {
  if (!card) return null;
  const pick = (key: keyof ModelRateCard['short']) => Math.max(card.short[key], card.long[key]);
  return { input: pick('input'), output: pick('output'), cacheRead: pick('cacheRead'), cacheWrite: pick('cacheWrite') };
}

/** What the estimate says a job needs, for sizing a raise: likely when known, else nothing. */
const neededOf = (estimate: JobEstimate): MicroUsd | null =>
  estimate.kind === 'estimate' ? estimate.likelyMicroUsd : null;

export function estimateView(tier: JobTier, plan: JobPlan): JobEstimateView {
  const estimate = estimateJob({
    tier,
    metering: plan.metering,
    rates: plan.rates,
    shape: plan.shape,
    ...(plan.reason ? { reason: plan.reason } : {}),
  });
  const raisedToMicroUsd = oneJobRaise({ tier, capMicroUsd: approvedJobCap(tier), neededMicroUsd: neededOf(estimate) });
  return {
    estimate,
    warning: estimate.warn ? capWarningCopy(estimate, raisedToMicroUsd) : null,
    note: worstCaseNote(estimate),
    raisedToMicroUsd,
  };
}

export function statusView(record: JobRecord): JobStatusView {
  const stop = record.stop;
  return {
    jobId: record.jobId,
    tier: record.tier,
    capMicroUsd: capOf(record),
    raised: record.raise !== null,
    stop: stop
      ? {
          usedMicroUsd: stop.usedMicroUsd,
          capMicroUsd: stop.capMicroUsd,
          neededMicroUsd: stop.neededMicroUsd,
          consumed: stop.consumedBy !== null,
        }
      : null,
    overrun:
      stop && stop.consumedBy === null
        ? overrunCopy({
            tier: record.tier,
            capMicroUsd: stop.capMicroUsd,
            usedMicroUsd: stop.usedMicroUsd,
            raisedToMicroUsd: oneJobRaise({ tier: record.tier, capMicroUsd: stop.capMicroUsd, neededMicroUsd: stop.neededMicroUsd }),
          })
        : null,
  };
}

function plain(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ApiError(400, 'Provide an object.');
  return value as Record<string, unknown>;
}

/** Fields a client might send to size its own cap. None is accepted anywhere here. */
const CLIENT_AMOUNTS = ['cap', 'capMicroUsd', 'neededMicroUsd', 'raiseMicroUsd', 'toMicroUsd', 'tier', 'amount', 'parentEnvelopeMicroUsd'];

function refuseClientAmounts(body: Record<string, unknown>) {
  const named = CLIENT_AMOUNTS.filter((key) => key in body);
  if (named.length > 0)
    throw new ApiError(400, 'A job cap comes from its tier on this computer. Send the message, not an amount.', {
      code: 'client_amount_refused',
      fields: named,
    });
}

const MAX_DRAFT_TEXT = 200_000;

export function parseDraft(body: Record<string, unknown>): MessageDraft {
  if (typeof body.text !== 'string' || body.text.length > MAX_DRAFT_TEXT)
    throw new ApiError(400, 'Provide the message text.');
  const mode = modeOf(body.mode);
  if (!mode) throw new ApiError(400, 'Provide a valid mode.');
  const raw = body.sources ?? [];
  if (!Array.isArray(raw) || raw.length > 64) throw new ApiError(400, 'Provide sources as a list.');
  const sources = raw.map((item) => {
    const source = plain(item);
    if (typeof source.path !== 'string' || typeof source.sha !== 'string')
      throw new ApiError(400, 'Each source needs a path and a version.');
    return { path: source.path, sha: source.sha };
  });
  return { text: body.text, mode, sources };
}

export function mountJobCapRoutes(app: Express, deps: JobCapRouteDeps) {
  const route =
    (action: (req: Request) => Promise<unknown>) =>
    async (req: Request, res: Response, next: (error: unknown) => void) => {
      try {
        res.json(await action(req));
      } catch (error) {
        next(error);
      }
    };
  const caps = deps.jobCaps;

  /** The estimate for the message about to be sent on a thread. */
  app.post(
    '/api/projects/:id/threads/:threadId/job-estimate',
    route(async (req) => {
      const body = plain(req.body);
      refuseClientAmounts(body);
      const projectId = String(req.params.id);
      const threadId = String(req.params.threadId);
      const plan = await deps.messagePlan(projectId, threadId, parseDraft(body));
      return estimateView(caps.tierFor(projectId, plan.threadId), plan);
    }),
  );

  /**
   * "Go over this once". Before a send: the job id the client will send with,
   * sized from the host's own estimate of that message. After a stop: the new
   * job that resends the message, sized from the earlier job's recorded stop.
   */
  app.post(
    '/api/projects/:id/threads/:threadId/jobs/:jobId/go-over',
    route(async (req) => {
      const body = plain(req.body);
      refuseClientAmounts(body);
      const projectId = String(req.params.id);
      const threadId = String(req.params.threadId);
      const jobId = String(req.params.jobId);
      if (body.fromJobId !== undefined) {
        if (typeof body.fromJobId !== 'string') throw new ApiError(400, 'Name the job that stopped.');
        const record = await caps.raiseAfterStop({ projectId, jobId, fromJobId: body.fromJobId, threadId, by: LOCAL_AGREEMENT });
        return statusView(record);
      }
      const plan = await deps.messagePlan(projectId, threadId, parseDraft(body));
      const view = estimateView(caps.tierFor(projectId, plan.threadId), plan);
      if (!view.estimate.warn)
        throw new ApiError(409, 'This job is not expected to pass its cap, so there is nothing to go over.', {
          code: 'no_warning',
        });
      const record = await caps.raiseBeforeSend({
        projectId,
        jobId,
        threadId: plan.threadId,
        neededMicroUsd: neededOf(view.estimate),
        by: LOCAL_AGREEMENT,
      });
      return statusView(record);
    }),
  );

  /** Where a job stands: its tier and cap, and the stop it reached, if any. */
  app.get(
    '/api/projects/:id/jobs/:jobId',
    route(async (req) => {
      const record = caps.get(String(req.params.id), String(req.params.jobId));
      if (!record) throw new ApiError(404, 'This job has not started.', { code: 'unknown_job' });
      return statusView(record);
    }),
  );

  /** The estimate for the next wake of a team member. */
  app.post(
    '/api/projects/:id/team/members/:slot/job-estimate',
    route(async (req) => {
      refuseClientAmounts(plain(req.body ?? {}));
      const projectId = String(req.params.id);
      const plan = await deps.teamWakePlan(projectId, String(req.params.slot));
      return estimateView(caps.tierFor(projectId, plan.threadId), plan);
    }),
  );

  /**
   * Wake a member with "Go over this once" agreed. The wake's job id is minted
   * by the host during the wake, so the raise is armed on the member's thread
   * for the next job scoped there, and withdrawn if the wake fails.
   */
  app.post(
    '/api/projects/:id/team/members/:slot/wake-over-cap',
    route(async (req) => {
      refuseClientAmounts(plain(req.body ?? {}));
      const projectId = String(req.params.id);
      const slotId = String(req.params.slot);
      const plan = await deps.teamWakePlan(projectId, slotId);
      const view = estimateView(caps.tierFor(projectId, plan.threadId), plan);
      if (!view.estimate.warn)
        throw new ApiError(409, 'This wake is not expected to pass its cap, so there is nothing to go over.', {
          code: 'no_warning',
        });
      const ticket = caps.arm({ projectId, threadId: plan.threadId, neededMicroUsd: neededOf(view.estimate), by: LOCAL_AGREEMENT });
      try {
        return await deps.wake(projectId, slotId);
      } catch (error) {
        caps.disarm(ticket);
        throw error;
      }
    }),
  );
}
