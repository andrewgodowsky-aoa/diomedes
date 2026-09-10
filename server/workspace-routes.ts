/**
 * Workspace, membership and Business-intake routes.
 *
 * Every mutating route runs inside `store.locked`, because switching workspace
 * and joining an organization both write settings, and the store owns that
 * serialization already.
 *
 * There is deliberately no personal equivalent of the setup routes. Personal is
 * not a workspace with the company questions turned off; it is a workspace the
 * questions have no route into.
 */
import type { Express, Request, Response } from 'express';
import { BUSINESS_QUESTIONS, REVIEW_STEP } from '../shared/business-setup.js';
import { MEMBER_ROLES, type MemberRole } from '../shared/workspaces.js';
import { ApiError } from './paths.js';
import type { ConfigurationService } from './configuration.js';
import type { Store } from './store.js';
import type { WeeklyBriefService } from './weekly-brief.js';
import type { WorkspaceService } from './workspaces.js';

const body = (req: Request): Record<string, unknown> =>
  req.body && typeof req.body === 'object' && !Array.isArray(req.body)
    ? (req.body as Record<string, unknown>)
    : {};

const organizationId = (req: Request) => String(req.params.organizationId ?? '');

export function mountWorkspaceRoutes(
  app: Express,
  store: Store,
  workspaces: WorkspaceService,
  configuration: ConfigurationService,
  briefs: WeeklyBriefService,
) {
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

  // Unlocked: the view is a read, and it takes the store lock itself only on
  // the rare pass that has a stale workspace reference to settle.
  app.get(
    '/api/workspace',
    route(async () => workspaces.currentView(), false),
  );

  /**
   * The question set itself, so the renderer draws exactly what the host will
   * accept. It carries no answers and needs no membership: it is the schema.
   */
  app.get('/api/workspace/questions', (_req, res) =>
    res.json({
      schemaRevision: 1,
      reviewStep: REVIEW_STEP,
      questions: BUSINESS_QUESTIONS.map((question) => ({
        id: question.id,
        prompt: question.prompt,
        reason: question.reason,
        kind: question.kind,
        options: question.options ?? null,
        allowOther: question.allowOther === true,
        required: question.required,
        maxLength: question.maxLength ?? null,
      })),
    }),
  );

  app.post(
    '/api/workspace/switch',
    route(async (req) => {
      const value = body(req);
      const kind = value.kind === 'business' ? 'business' : 'personal';
      if (kind === 'personal') return workspaces.switchTo({ kind: 'personal' });
      const id = String(value.organizationId ?? '');
      if (!id)
        throw new ApiError(400, 'Name the business workspace to open.', {
          code: 'invalid_workspace',
        });
      return workspaces.switchTo({ kind: 'business', organizationId: id });
    }),
  );

  app.post(
    '/api/workspace/organizations',
    route(async (req) => {
      const value = body(req);
      return workspaces.createOrganization({
        name: String(value.name ?? ''),
        industry: value.industry == null ? null : String(value.industry),
      });
    }),
  );

  app.post(
    '/api/workspace/organizations/join',
    route(async (req) => workspaces.join(String(body(req).code ?? ''))),
  );

  app.post(
    '/api/workspace/organizations/:organizationId/invitations',
    route(async (req) => {
      const requested = String(body(req).role ?? 'member');
      if (!(MEMBER_ROLES as readonly string[]).includes(requested))
        throw new ApiError(400, 'Choose a role for the invitation.', { code: 'invalid_role' });
      const invitation = await workspaces.invite(organizationId(req), requested as MemberRole);
      return { code: invitation.code, role: invitation.role, expiresAt: invitation.expiresAt };
    }),
  );

  app.post(
    '/api/workspace/organizations/:organizationId/members/:personId/revoke',
    route(async (req) =>
      workspaces.revokeMember(
        organizationId(req),
        String(req.params.personId ?? ''),
        String(body(req).reason ?? ''),
      ),
    ),
  );

  app.get(
    '/api/workspace/organizations/:organizationId/setup',
    route(async (req) => workspaces.setupView(organizationId(req)), false),
  );

  app.post(
    '/api/workspace/organizations/:organizationId/setup/start',
    route(async (req) => workspaces.startSetup(organizationId(req), 'start')),
  );

  app.post(
    '/api/workspace/organizations/:organizationId/setup/resume',
    route(async (req) => workspaces.startSetup(organizationId(req), 'resume')),
  );

  app.post(
    '/api/workspace/organizations/:organizationId/setup/answer',
    route(async (req) => {
      const value = body(req);
      return workspaces.answer(organizationId(req), {
        questionId: String(value.questionId ?? ''),
        value: (value.value ?? null) as never,
        unknown: value.unknown === true,
        expectedDigest: typeof value.expectedDigest === 'string' ? value.expectedDigest : undefined,
      });
    }),
  );

  app.post(
    '/api/workspace/organizations/:organizationId/setup/back',
    route(async (req) => workspaces.back(organizationId(req))),
  );

  /**
   * Choose the project this business writes into.
   *
   * This is the answer to the one question that kept a working weekly brief
   * unreachable. It is a route rather than an inference because every implicit
   * answer is wrong somewhere: the open project would let switching workspace
   * redirect a company's output, and a project made on demand would put a
   * company's work where nobody chose.
   */
  app.post(
    '/api/workspace/organizations/:organizationId/output',
    route(async (req) =>
      workspaces.bindOutputProject(organizationId(req), String(body(req).projectId ?? '')),
    ),
  );

  /**
   * Run the weekly brief for this organization.
   *
   * The target is resolved once, here, and handed to the service whole. The
   * service already refuses a setup that is not active or not ready, so this
   * route decides where and never whether — which is why a bound project on an
   * unconfigured business still gets a refusal rather than an empty draft.
   */
  app.post(
    '/api/workspace/organizations/:organizationId/brief',
    route(async (req) => {
      const id = organizationId(req);
      const target = await workspaces.briefTarget(id);
      if (!target.ready)
        throw new ApiError(409, target.message, { code: target.code.replace(/-/g, '_') });
      const manifest = configuration.active(id);
      if (!manifest)
        throw new ApiError(
          409,
          'This business has no setup running, so there is nothing to prepare a brief from. Turn a setup on first.',
          { code: 'no_active_configuration' },
        );
      const previous = await store.current(target.projectId, 'diomedes/last-brief.md');
      const result = await briefs.run({
        projectId: target.projectId,
        manifest,
        previous,
        at: new Date().toISOString(),
      });
      return {
        organizationId: target.organizationId,
        projectId: target.projectId,
        projectName: target.projectName,
        destination: result.destination,
        entryId: result.entryId,
        sections: result.draft.sections.length,
      };
    }),
  );
}
