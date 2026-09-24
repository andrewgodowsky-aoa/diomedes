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
import { randomUUID } from 'node:crypto';
import { briefAutomationId } from '../shared/automations.js';
import { BUSINESS_QUESTIONS, REVIEW_STEP } from '../shared/business-setup.js';
import { MEMBER_ROLES, type MemberRole } from '../shared/workspaces.js';
import { ApiError } from './paths.js';
import { refusalStatus, type AutomationService } from './automations.js';
import type { ConfigurationService } from './configuration.js';
import type { Store } from './store.js';
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
  _configuration: ConfigurationService,
  automations: AutomationService,
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

  // Access profiles are organization-owned configuration. The administration
  // ledger is Owner-only; ordinary members use resource discovery, which
  // returns only resources their pinned profile assignments cover.
  app.get(
    '/api/workspace/organizations/:organizationId/access',
    route(async (req) => workspaces.accessView(organizationId(req)), false),
  );

  app.get(
    '/api/workspace/organizations/:organizationId/access/resources',
    route(
      async (req) =>
        workspaces.discoverAccessResources(organizationId(req), String(req.query.permission ?? '')),
      false,
    ),
  );

  app.post(
    '/api/workspace/organizations/:organizationId/access/resources',
    route(async (req) => {
      const value = body(req);
      return workspaces.createAccessResource(organizationId(req), {
        type: value.type,
        parentId: value.parentId,
        label: value.label,
        externalId: value.externalId,
      });
    }),
  );

  app.post(
    '/api/workspace/organizations/:organizationId/access/profiles',
    route(async (req) => {
      const value = body(req);
      return workspaces.createAccessProfile(organizationId(req), {
        name: value.name,
        description: value.description,
        permissions: value.permissions,
      });
    }),
  );

  app.post(
    '/api/workspace/organizations/:organizationId/access/profiles/:profileId/revisions',
    route(async (req) => {
      const value = body(req);
      return workspaces.reviseAccessProfile(
        organizationId(req),
        String(req.params.profileId ?? ''),
        {
          expectedRevision: value.expectedRevision,
          name: value.name,
          description: value.description,
          permissions: value.permissions,
        },
      );
    }),
  );

  app.post(
    '/api/workspace/organizations/:organizationId/access/assignments',
    route(async (req) => {
      const value = body(req);
      return workspaces.assignAccessProfile(organizationId(req), {
        personId: value.personId,
        profileId: value.profileId,
        profileRevision: value.profileRevision,
        scopes: value.scopes,
      });
    }),
  );

  app.post(
    '/api/workspace/organizations/:organizationId/access/assignments/:assignmentId/revoke',
    route(async (req) =>
      workspaces.revokeAccessAssignment(
        organizationId(req),
        String(req.params.assignmentId ?? ''),
        body(req).expectedRevision,
      ),
    ),
  );

  app.post(
    '/api/workspace/organizations/:organizationId/access/worker-profiles',
    route(async (req) => {
      const value = body(req);
      return workspaces.createWorkerProfile(organizationId(req), {
        name: value.name,
        purpose: value.purpose,
        executionMode: value.executionMode,
        agent: value.agent,
        permissionCeilings: value.permissionCeilings,
        resourceCeilings: value.resourceCeilings,
        contextCeilings: value.contextCeilings,
        toolCeilings: value.toolCeilings,
        ruleScopes: value.ruleScopes,
        routeCeilings: value.routeCeilings,
      });
    }),
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
   * The same admission Run once uses on the Automations screen: one path to a
   * brief draft, not two. This route keeps its old shape for the workspace
   * panel — it waits for the draft and answers with where it went — and a
   * request without a command id is given a fresh one, so each press of the
   * panel's button is its own occurrence. A refusal is still an error here,
   * in the words and status it always had, and it is also recorded.
   */
  app.post(
    '/api/workspace/organizations/:organizationId/brief',
    route(async (req) => {
      const id = organizationId(req);
      const value = body(req);
      const admitted = await store.locked(() =>
        automations.admit(id, briefAutomationId(id), {
          ...value,
          commandId: typeof value.commandId === 'string' ? value.commandId : `brief-${randomUUID()}`,
        }),
      );
      const occurrence = admitted.occurrence;
      if (occurrence.admission.state === 'refused')
        throw new ApiError(refusalStatus(occurrence.admission.code), occurrence.admission.reason, {
          code: occurrence.admission.code,
          occurrenceId: occurrence.id,
        });
      const run = await automations.settled(occurrence);
      const links = {
        occurrenceId: occurrence.id,
        runId: run?.id ?? null,
        taskId: occurrence.admission.state === 'admitted' ? occurrence.admission.taskId : null,
      };
      if (run?.state === 'completed') {
        const result = (run.result ?? {}) as { entryId?: string; path?: string; sections?: number };
        return {
          organizationId: id,
          projectId: occurrence.target!.projectId,
          projectName: occurrence.target!.projectName,
          destination: result.path,
          entryId: result.entryId,
          sections: result.sections ?? 0,
          ...links,
        };
      }
      if (run?.state === 'failed' && run.failure?.name === 'waiting_for_data')
        throw new ApiError(409, run.failure.message, { code: 'waiting_for_data', ...links });
      if (run && ['queued', 'running'].includes(run.state))
        throw new ApiError(409, 'The brief is still being prepared. Follow it in Automations.', {
          code: 'brief_still_running',
          ...links,
        });
      throw new ApiError(
        409,
        'The brief stopped before it was saved. Open Automations to see why.',
        { code: 'brief_failed', ...links },
      );
    }, false),
  );
}
