/**
 * The included customization benefit, over HTTP.
 *
 * The same division of labour as the allowance routes: this file parses,
 * refuses malformed input and takes the store lock. Whether the business may
 * have the benefit at all is the entitlement question and belongs to
 * `CustomizationGate`; where the one engagement stands is the ledger's, and
 * both are asked here rather than re-implemented here.
 *
 * The organization is never a body field. It is the workspace this person is
 * acting in, re-read on every request, so a benefit cannot be moved onto
 * another company's record by asking nicely.
 */
import type { Express, Request, Response } from 'express';
import type { CustomizationBenefitLedger, BenefitStep } from './customization-benefit.js';
import type { CustomizationGate } from './customization-gate.js';
import { ApiError } from './paths.js';
import type { Store } from './store.js';
import type { WorkspaceService } from './workspaces.js';
import { isBusiness } from '../shared/workspaces.js';

const body = (req: Request): Record<string, unknown> =>
  req.body && typeof req.body === 'object' && !Array.isArray(req.body)
    ? (req.body as Record<string, unknown>)
    : {};

const text = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;

export function mountCustomizationBenefitRoutes(
  app: Express,
  store: Store,
  workspaces: WorkspaceService,
  gate: CustomizationGate,
  benefit: CustomizationBenefitLedger,
) {
  /** The business this person is acting in, or a refusal naming why not. */
  const organizationId = (): string => {
    const scope = workspaces.active();
    if (!isBusiness(scope))
      throw new ApiError(
        409,
        'The included customization engagement belongs to a business. Switch to the business workspace to see it.',
        { code: 'benefit_needs_business' },
      );
    return scope.organizationId;
  };

  const route =
    (action: (req: Request, res: Response) => Promise<unknown>, locked = true) =>
    async (req: Request, res: Response, next: (error?: unknown) => void) => {
      try {
        const result = locked ? await store.locked(() => action(req, res)) : await action(req, res);
        if (!res.headersSent) res.json(result);
      } catch (error) {
        next(error);
      }
    };

  app.get(
    '/api/benefits/customization',
    route(async () => ({ benefit: await benefit.read(organizationId()) }), false),
  );

  const step = (name: BenefitStep) =>
    route(async (req) => {
      const id = organizationId();
      // Asking for the benefit is asking for something the plan includes, so
      // the plan is checked. The later steps are the engagement running; a
      // plan that lapses mid-engagement does not un-promise what was promised,
      // and refusing the accept of work already delivered would be the wrong
      // answer to the wrong question.
      if (name === 'request') gate.assertCanAuthor(req);
      const input = body(req);
      const key = text(input.idempotencyKey);
      if (!key)
        throw new ApiError(
          400,
          'Every step carries an idempotency key, so sending it twice records it once.',
          { code: 'benefit_no_idempotency_key' },
        );
      const revision = input.themeRevision;
      if (
        revision !== undefined &&
        (typeof revision !== 'number' || !Number.isInteger(revision) || revision < 1)
      )
        throw new ApiError(400, 'A theme version is a whole number from 1 up.', {
          code: 'benefit_invalid_revision',
        });
      const result = await benefit.apply({
        organizationId: id,
        step: name,
        idempotencyKey: key,
        actor: workspaces.currentPerson().id,
        at: new Date().toISOString(),
        engagementId: text(input.engagementId),
        themeId: text(input.themeId),
        themeRevision: revision as number | undefined,
        reason: text(input.reason),
      });
      // A repeat is reported, not thrown: the caller asked for a state and this
      // is the state. An invalid transition is a genuine conflict.
      if (!result.applied && result.code === 'benefit_invalid_transition')
        throw new ApiError(409, result.reason, { code: result.code });
      if (!result.applied && result.code === 'benefit_consumed')
        throw new ApiError(409, result.reason, { code: result.code });
      return {
        applied: result.applied,
        code: result.applied ? null : result.code,
        reason: result.applied ? '' : result.reason,
        benefit: result.view,
      };
    });

  app.post('/api/benefits/customization/request', step('request'));
  app.post('/api/benefits/customization/draft', step('draft'));
  app.post('/api/benefits/customization/review', step('review'));
  app.post('/api/benefits/customization/accept', step('accept'));
  app.post('/api/benefits/customization/fail', step('fail'));
}
