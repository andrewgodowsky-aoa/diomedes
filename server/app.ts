import { parseApprovalCommand } from './approval-admission.js';
import { mountPermissionRoutes } from './permission-routes.js';
import { WorkspaceService } from './workspaces.js';
import { mountWorkspaceRoutes } from './workspace-routes.js';
import { ConfigurationService } from './configuration.js';
import { mountConfigurationRoutes } from './configuration-routes.js';
import { WeeklyBriefService } from './weekly-brief.js';
import { isActiveMember } from '../shared/workspaces.js';
import { AllowanceLedger } from './managed-usage.js';
import { ManagedGateway } from './managed-gateway.js';
import { BillingEventProcessor } from './billing-events.js';
import { mountManagedUsageRoutes } from './managed-usage-routes.js';
import { directOrigin, applicationOrigin } from '../shared/attribution.js';
import express, { type ErrorRequestHandler, type Request, type Response } from 'express';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import type {
  Conversation,
  Owner,
  Page,
  ProjectState,
  Session,
  Settings,
  TaskState,
  ThreadPermission,
  Turn,
  TeamMember,
  Route,
} from '../shared/types.js';
import { ApiError, absent, relativeName, safeAbsolute } from './paths.js';
import { defaults, findTasks, hash, identifier, now, Store, threadNameFromText } from './store.js';
import { WorkService } from './work.js';
import { NativeWorkService, type NativeGenerator } from './native-work.js';
import { askCodex, getIntegrationStatuses, type NativeTeamOptions } from './integrations.js';
import { MODES, modeOf } from './modes.js';
import { fakeCodexSnapshot, usageService } from './usage.js';
import { engineCatalog, isKnownChoice } from './models.js';
import { ReviewerService, type ReviewerAdapter } from './trust/reviewer.js';
import { codexReviewerAdapter } from './trust/codex-reviewer.js';
import { AgentRegistry } from './agents.js';
import { AUTO_AGENT, agentCompatibility } from '../shared/agents.js';
import { effortFor } from '../shared/effort.js';
import type { UsageSnapshot } from '../shared/types.js';
import { mountTeamRoutes } from './team/routes.js';
import { createHarnessHost } from './harness/host.js';
import { mountHarnessRoutes } from './harness/routes.js';
import { localHarnessPrincipal } from './harness/bridge.js';
import { FIXTURE_ENGINE } from './harness/approval.js';
import { CODEX_ENGINE, type ResolveHarnessAuthority } from './harness/codex-engine.js';
import { roleInstructions } from './team/prompts.js';
import { parseWorkCommand, validateWorkCommandId } from './work-admission.js';
import { DesktopConnections } from './connections/desktop.js';
import packageInfo from '../package.json' with { type: 'json' };
import {
  EXTERNAL_ENGINES,
  ENGINE_NAMES,
  isExternalEngine,
  isRoute,
  ROUTES,
} from '../shared/engines.js';
import { EngineService } from './engines/service.js';
import { EngineError } from './engines/process.js';
import { selectedEngine, selectedModel } from '../shared/ai-selection.js';
import { AppUpdateService, mountAppUpdateRoutes, type UpdateTransport } from './app-updates.js';
import { EngineInstaller } from './engines/install.js';
import { NativeLogin } from './engines/login.js';

interface AppOptions {
  dataDir: string;
  projectRoot?: string;
  stepMs?: number;
  port?: number;
  clientPort?: number;
  nativeGenerator?: NativeGenerator;
  /**
   * Reviewer route for `Approve for me`. Omitted means no reviewer exists and
   * the option cannot be confirmed. Tests and packaged smokes inject a
   * synthetic reviewer to prove authority without a provider call.
   */
  reviewerAdapter?: ReviewerAdapter | null;
  engineService?: EngineService;
  harnessAuthority?: ResolveHarnessAuthority;
  updateOverrides?: {
    platform?: string;
    packaged?: boolean;
    installed?: boolean;
    onInstallAccepted?: () => void;
    transport?: Partial<UpdateTransport>;
  };
}
const pages: Page[] = [
  'home',
  'ask',
  'plan',
  'work',
  'review',
  'tasks',
  'documents',
  'history',
  'connections',
];
const owners: Owner[] = ['you', 'diomedes', 'diomedes-with-ok'];
const states: TaskState[] = ['todo', 'working', 'waiting', 'done'];
const asString = (value: unknown, name: string, max = 10000): string => {
  if (typeof value !== 'string' || !value.trim() || value.length > max)
    throw new ApiError(400, `Provide ${name} of up to ${max} characters.`);
  return value;
};
function taskNameFromText(text: string): string {
  const firstLine = text.split('\n')[0].trim();
  if (firstLine.length <= 80) return firstLine;
  const shortened = firstLine.slice(0, 80);
  if (/\s/.test(firstLine[80])) return shortened.trimEnd();
  const boundary = shortened.search(/\s+\S*$/);
  return (boundary > 0 ? shortened.slice(0, boundary) : shortened).trimEnd();
}
const choice = <const T extends string>(value: unknown, values: readonly T[], name: string): T => {
  if (typeof value !== 'string' || !values.includes(value as T))
    throw new ApiError(400, `Choose a valid ${name}.`);
  return value as T;
};
const THREAD_PERMISSIONS: readonly ThreadPermission[] = ['show-first', 'task'];
const PERMISSION_UNAVAILABLE = 'That permission mode is not available in this version.';
/**
 * The SSE `state` fan-out never carries the documents listing: it can hold
 * 10,000 rows and the client already refetches after any event.
 */
export function statePayload(state: ProjectState): ProjectState {
  return { ...state, documents: [] };
}
function parseThreadPermission(value: unknown): ThreadPermission {
  if (typeof value !== 'string' || !THREAD_PERMISSIONS.includes(value as ThreadPermission))
    throw new ApiError(400, PERMISSION_UNAVAILABLE);
  return value as ThreadPermission;
}
/**
 * A thread's helper choice. Null clears it, so the thread follows the saved
 * default again. The pair is checked against the engine's own list, which keeps
 * a choice that has since been withdrawn from reaching `thread/start`.
 */
function parseRequested(value: unknown, engine: Route = 'codex'): Conversation['requested'] {
  if (value === null) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new ApiError(400, 'Provide a helper choice, or null to use the default.');
  const v = value as Record<string, unknown>;
  const model = v.model === null || v.model === undefined ? null : v.model;
  const effort = v.effort === null || v.effort === undefined ? null : v.effort;
  let agent: string | null = null;
  if (v.agent !== null && v.agent !== undefined) {
    if (typeof v.agent !== 'string' || !v.agent.trim() || v.agent.length > 80)
      throw new ApiError(400, 'That is not an Agent.');
    agent = v.agent.trim();
  }
  // Agent and model are independent axes: an Agent with no model chosen keeps
  // the runtime default, and clearing the model does not clear the Agent.
  if (model === null) return agent === null ? null : { model: null, effort: null, agent };
  if (typeof model !== 'string' || !model.trim() || model.length > 120)
    throw new ApiError(400, 'That is not a helper choice.');
  if (effort !== null && (typeof effort !== 'string' || !effort.trim() || effort.length > 40))
    throw new ApiError(400, 'That is not a reasoning level.');
  const chosen = {
    model: model.trim(),
    effort: effort === null ? null : String(effort).trim(),
    ...(agent === null ? {} : { agent }),
  };
  if (!isKnownChoice(engine, chosen.model, chosen.effort))
    throw new ApiError(400, 'That helper choice is not one this computer offers.');
  return chosen;
}
function plain(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new ApiError(400, 'Provide an object.');
  return value as Record<string, unknown>;
}

function validateSettings(current: Settings, body: unknown): Settings {
  const supplied = plain(body);
  const result = structuredClone(current);
  for (const key of Object.keys(supplied))
    if (!Object.hasOwn(defaults(), key)) throw new ApiError(400, `Unknown setting: ${key}`);
  // `activeWorkspace` is deliberately absent from every branch below. The clone
  // above keeps whatever is stored, so a client that echoes the whole settings
  // object back cannot move itself into a business workspace: only
  // POST /api/workspace/switch writes it, and only after checking membership.
  // Do not add a branch here that reads `supplied.activeWorkspace`.
  if (supplied.version !== undefined && supplied.version !== 1)
    throw new ApiError(400, 'This settings version is unsupported.');
  if (supplied.detail !== undefined)
    result.detail = choice(supplied.detail, ['guided', 'standard', 'technical'], 'detail level');
  if (supplied.surface !== undefined) {
    // A client from before the rename still says book or desk; accept those and
    // store the current name, so only one spelling is ever written.
    const named = choice(
      supplied.surface,
      ['workbook', 'console', 'book', 'desk', 'technical'],
      'surface',
    );
    result.surface = named === 'book' ? 'workbook' : named === 'workbook' ? 'workbook' : 'console';
  }
  if (supplied.explanations !== undefined)
    result.explanations = choice(
      supplied.explanations,
      ['persistent', 'once', 'off'],
      'explanations setting',
    );
  if (supplied.permissions) {
    const value = plain(supplied.permissions);
    for (const key of Object.keys(result.permissions) as (keyof Settings['permissions'])[]) {
      if (value[key] !== undefined) {
        if (typeof value[key] !== 'boolean')
          throw new ApiError(400, 'Permissions must be true or false.');
        result.permissions[key] = value[key];
      }
    }
  }
  if (supplied.onboarding) {
    const value = plain(supplied.onboarding);
    if (value.work !== undefined)
      result.onboarding.work =
        value.work === null
          ? null
          : choice(value.work, ['business', 'school', 'software', 'personal', 'mix'], 'work type');
    if (value.detail !== undefined)
      result.onboarding.detail =
        value.detail === null
          ? null
          : choice(value.detail, ['guided', 'standard', 'technical'], 'detail level');
    if (value.familiarity !== undefined)
      result.onboarding.familiarity =
        value.familiarity === null
          ? null
          : choice(value.familiarity, ['new', 'some', 'comfortable'], 'familiarity');
    if (value.resumeAt !== undefined)
      result.onboarding.resumeAt = choice(
        value.resumeAt,
        ['welcome', 'q1', 'q2', 'q3', 'ai', 'ready', 'done'],
        'setup step',
      );
    if (value.completedAt !== undefined) {
      if (
        value.completedAt !== null &&
        (typeof value.completedAt !== 'string' || !Number.isFinite(Date.parse(value.completedAt)))
      )
        throw new ApiError(400, 'Provide a valid completion time.');
      result.onboarding.completedAt = value.completedAt;
    }
    if (value.setupVersion !== undefined) {
      if (value.setupVersion !== 2) throw new ApiError(400, 'Unsupported setup version.');
      result.onboarding.setupVersion = 2;
    }
    if (value.aiSkipped !== undefined) {
      if (typeof value.aiSkipped !== 'boolean') throw new ApiError(400, 'Invalid setup choice.');
      result.onboarding.aiSkipped = value.aiSkipped;
    }
    // Discovery consent is recorded only by the disclosed discovery action.
  }
  if (supplied.appearance) {
    const value = plain(supplied.appearance);
    if (value.package !== undefined)
      result.appearance.package = choice(
        value.package,
        [
          'field',
          'deep-field',
          'graphite',
          'verdigris',
          'harbor',
          'ember',
          'moss',
          'dusk',
          'ink',
          'paper',
          'cobalt',
        ],
        'appearance package',
      );
    if (value.motion !== undefined)
      result.appearance.motion = choice(value.motion, ['normal', 'reduced'], 'motion setting');
    for (const key of ['interfaceScale', 'readingScale', 'codeScale'] as const)
      if (value[key] !== undefined) {
        const n = value[key];
        if (typeof n !== 'number' || n < 0.75 || n > 2)
          throw new ApiError(400, 'Text scale must be between 0.75 and 2.');
        result.appearance[key] = n;
      }
  }
  if (supplied.services) {
    const value = plain(supplied.services);
    const services: Record<string, boolean | string> = {};
    for (const [key, on] of Object.entries(value)) {
      // The Codex selection is a name, not a switch; it only ever reaches
      // `thread/start` config, never the answer text.
      if (key === 'defaultEngine') {
        services[key] = choice(on, ROUTES, 'default engine');
        continue;
      }
      if (
        ['codex', ...EXTERNAL_ENGINES].some(
          (engine) =>
            key === `${engine}Model` ||
            key === `${engine}Effort` ||
            key === `${engine}AccountRoute`,
        )
      ) {
        if (typeof on !== 'string' || !on.trim() || on.length > 120)
          throw new ApiError(400, 'The helper choice must be up to 120 characters.');
        services[key] = on.trim();
        continue;
      }
      if (!/^[a-z][a-z0-9-]{0,39}$/.test(key) || typeof on !== 'boolean')
        throw new ApiError(400, 'A helper setting must be true or false.');
      services[key] = on;
    }
    result.services = services as Settings['services'];
  }
  if (supplied.openProjects) {
    if (
      !Array.isArray(supplied.openProjects) ||
      supplied.openProjects.some((id) => typeof id !== 'string' || !/^[a-f0-9]{12}$/.test(id))
    )
      throw new ApiError(400, 'Provide valid project identifiers.');
    result.openProjects = supplied.openProjects;
  }
  if (supplied.lastPage) {
    const value = plain(supplied.lastPage);
    result.lastPage = {};
    for (const [key, page] of Object.entries(value)) {
      if (!/^[a-f0-9]{12}$/.test(key)) throw new ApiError(400, 'Invalid project identifier.');
      result.lastPage[key] = choice(page, pages, 'page');
    }
  }
  if (supplied.tasksView) {
    const value = plain(supplied.tasksView);
    result.tasksView = {};
    for (const [key, view] of Object.entries(value)) {
      if (!/^[a-f0-9]{12}$/.test(key)) throw new ApiError(400, 'Invalid project identifier.');
      result.tasksView[key] = choice(view, ['board', 'list'], 'tasks view');
    }
  }
  if (supplied.seen) {
    const value = plain(supplied.seen);
    if (value.onlineServiceNotice !== undefined) {
      if (typeof value.onlineServiceNotice !== 'boolean')
        throw new ApiError(400, 'The notice setting must be true or false.');
      result.seen.onlineServiceNotice = value.onlineServiceNotice;
    }
    if (value.firstUse !== undefined) {
      if (
        !Array.isArray(value.firstUse) ||
        value.firstUse.some((item) => typeof item !== 'string' || item.length > 100)
      )
        throw new ApiError(400, 'Invalid first-use settings.');
      result.seen.firstUse = value.firstUse;
    }
    if (value.guidedDescriptors !== undefined) {
      const entries = plain(value.guidedDescriptors);
      result.seen.guidedDescriptors = {};
      for (const [key, count] of Object.entries(entries)) {
        if (
          !pages.includes(key as Page) ||
          typeof count !== 'number' ||
          !Number.isSafeInteger(count) ||
          count < 0
        )
          throw new ApiError(400, 'Invalid guided descriptor settings.');
        result.seen.guidedDescriptors[key] = count;
      }
    }
  }
  return result;
}

export async function createApp(options: AppOptions) {
  const store = new Store(path.resolve(options.dataDir), options.projectRoot);
  await store.init();
  const work = new WorkService(store, options.stepMs);
  const engines = options.engineService ?? new EngineService(path.join(store.dataDir, 'engines'));
  const installer = new EngineInstaller(engines.root);
  const login = new NativeLogin(engines.root);
  const reviewerAdapter =
    options.reviewerAdapter === undefined ? codexReviewerAdapter() : options.reviewerAdapter;
  const agents = new AgentRegistry(store.dataDir);
  // Organizations, membership and the Business intake. Identity for them comes
  // from server/trust/, whose production backend is not installed, so what this
  // creates is a labelled local fixture rather than a hosted organization.
  const workspaces = new WorkspaceService(store);
  await workspaces.init();
  // The setup those answers compile into. It reads the Agent registry and Trust
  // live on every check, so a staged configuration cannot ride on an old reading.
  const configuration = new ConfigurationService(store, workspaces, agents);
  await configuration.init();
  // The one job an activated setup can actually run. It composes from approved
  // files and writes through the recorded writer; the workspace decides which
  // project it writes into, and refuses rather than guessing when nobody has.
  const briefs = new WeeklyBriefService(store);
  // Managed usage. The ledger is durable and per-organization; the gateway
  // reads membership, tenant, entitlement and processing policy from the host's
  // own services, so no request field can stand in for any of them.
  const ledger = new AllowanceLedger(store);
  await ledger.init();
  const billing = new BillingEventProcessor(ledger, store);
  await billing.init();
  const gateway = new ManagedGateway({
    ledger,
    entitlementFor: (organizationId) => workspaces.entitlementOf(organizationId),
    tenantFor: (organizationId) => workspaces.organization(organizationId)?.tenantId ?? null,
    memberOf: (organizationId, personId) =>
      isActiveMember(workspaces.membershipOf(organizationId, personId)),
    policyFor: (organizationId) => {
      const active = configuration.active(organizationId);
      return {
        // With no setup running there is nothing that permitted work to leave
        // this computer, so the strict reading is the correct one.
        processing: active?.proposal.modelPolicy.processing ?? 'local-only',
        // No build sells managed access yet, and no questionnaire asks which
        // key a business brings. Until one does, the honest answer is that the
        // company has not chosen, and `managed` is what the gateway then tests
        // against its own entitlement check — which refuses.
        organizationRoute: 'managed' as const,
      };
    },
  });
  const reviewer = new ReviewerService(store, reviewerAdapter);
  // Reviewer routing exists because the host wired it, not because a setting,
  // a request field or a saved preference said so.
  store.scopeGrants.reviewerConfigured = reviewer.configured;
  // Trust resolves the reviewer identity itself, from the host registry only.
  store.scopeGrants.reviewerAgent = async (agentId, projectFolder) => {
    const found = await agents.find(agentId, projectFolder);
    return found
      ? {
          id: found.id,
          version: found.version,
          name: found.name,
          digest: found.digest,
          role: found.role,
          ceiling: found.permissionCeiling,
        }
      : null;
  };
  const nativeWork = new NativeWorkService(
    store,
    options.nativeGenerator ??
      (async (input) => {
        if (!isExternalEngine(input.engine)) return askCodex(input);
        if (!input.projectId || !input.threadId || !input.requestId || !input.model)
          throw new ApiError(409, 'Select a model and thread before requesting work.');
        const accountRoute = input.accountRoute;
        if (typeof accountRoute !== 'string')
          throw new ApiError(409, 'Select this service in AI setup first.');
        return engines.generate(input.engine, {
          ...input,
          projectId: input.projectId,
          threadId: input.threadId,
          requestId: input.requestId,
          model: input.model,
          instructions: input.instructions ?? '',
          accountRoute,
        });
      }),
    reviewer,
    agents,
  );
  const harness = createHarnessHost({
    store,
    dataDir: store.dataDir,
    currentAuthority: options.harnessAuthority,
  });
  await harness.init();
  const connections = new DesktopConnections(store, harness);
  const app = express();
  // The port this service listens on, learned from the first request's socket (listen(0)
  // in tests picks it late). A wake has no request of its own, so it uses the remembered one.
  let listeningPort: number | undefined;
  const teamForMember = (
    projectId: string,
    member: TeamMember,
    port: number | undefined,
  ): NativeTeamOptions => {
    if (!port) throw new ApiError(503, 'The team service listening port is unavailable.');
    return {
      url: `http://127.0.0.1:${port}/mcp/team/${projectId}`,
      tokenEnv: `DIOMEDES_TEAM_${member.slotId.toUpperCase().replace(/[^A-Z0-9]/g, '')}`,
      slotId: member.slotId,
      role: member.role,
      roleInstructions: roleInstructions(member.role, member, store.state(projectId).project),
    };
  };
  const teamForThread = (
    req: Request,
    projectId: string,
    threadId: string | undefined,
  ): NativeTeamOptions | undefined => {
    if (!threadId) return undefined;
    const state = store.state(projectId);
    const member = state.team?.members.find(
      (item) => item.threadId === threadId && item.engine === 'codex',
    );
    if (!member) return undefined;
    // The socket is the listening service, even when listen(0) selected the port.
    return teamForMember(projectId, member, req.socket.localPort);
  };
  const serviceFor = (projectId: string, sessionId: string) => {
    const session = store.state(projectId).sessions.find((item) => item.id === sessionId);
    if (!session) throw new ApiError(404, 'This work session was not found.');
    return [FIXTURE_ENGINE, CODEX_ENGINE].includes(session.engine.name)
      ? harness.bridge
      : session.sample
        ? work
        : nativeWork;
  };
  const port = options.port ?? Number(process.env.DIOMEDES_PORT ?? 47631),
    clientPort = options.clientPort ?? Number(process.env.DIOMEDES_CLIENT_PORT ?? 5173);
  const origins = new Set([`http://127.0.0.1:${port}`, `http://127.0.0.1:${clientPort}`]);
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    if (req.socket.localPort) listeningPort = req.socket.localPort;
    if (req.path.startsWith('/mcp/team/')) return next();
    const origin = req.headers.origin;
    const host = req.headers.host;
    if (!host || !/^127\.0\.0\.1:\d+$/.test(host))
      return next(new ApiError(403, 'This service accepts connections on 127.0.0.1 only.'));
    if (origin && !origins.has(origin))
      return next(new ApiError(403, 'This page cannot access the local service.'));
    res.setHeader('Vary', 'Origin');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    if (origin) res.setHeader('Access-Control-Allow-Origin', origin);
    if (req.method === 'OPTIONS') {
      res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type,X-Diomedes-Client');
      res.status(204).end();
      return;
    }
    if (
      !req.path.startsWith('/vendor/connections/') &&
      !['GET', 'HEAD'].includes(req.method) &&
      req.headers['x-diomedes-client'] !== '1'
    )
      return next(new ApiError(403, 'The Diomedes client header is required.'));
    next();
  });
  let isUpdateClosing: () => boolean = () => false;
  let pendingMutations = 0;
  // Hold update admission while a mutation response is outstanding. A lost
  // response stays conservative until restart because its effect is uncertain.
  app.use((req, res, next) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method) || req.path.startsWith('/api/updates/'))
      return next();
    if (isUpdateClosing())
      return next(
        new ApiError(409, 'The app update is accepted. New changes pause until restart.'),
      );
    pendingMutations += 1;
    res.once('finish', () => {
      pendingMutations -= 1;
    });
    next();
  });
  connections.mountRaw(app);
  app.use(express.json({ limit: '9mb' }));
  const teamService = mountTeamRoutes(app, store);
  mountHarnessRoutes(app, store, harness);
  /**
   * The Agent catalog for this project. Compatibility is computed from the
   * honest route capability facts, so an Agent that cannot run here says so
   * rather than failing at dispatch. This route never changes authority.
   */
  app.get('/api/projects/:id/agents', async (req, res) => {
    const state = store.state(String(req.params.id));
    const route = typeof req.query.route === 'string' ? req.query.route : 'codex';
    const { agents: list, skipped } = await agents.list(state.project.folder);
    res.json({
      route,
      auto: AUTO_AGENT,
      agents: list.map((definition) => ({
        id: definition.id,
        version: definition.version,
        name: definition.name,
        summary: definition.summary,
        origin: definition.origin,
        source: definition.source,
        digest: definition.digest,
        modes: definition.modes,
        permissionCeiling: definition.permissionCeiling,
        models: definition.models,
        handoff: definition.handoff,
        evidence: definition.evidence,
        role: definition.role,
        requires: definition.requires,
        tools: definition.tools,
        ruleScopes: definition.ruleScopes,
        compatibility: agentCompatibility(definition, route),
      })),
      skipped,
    });
  });
  mountPermissionRoutes(app, store, nativeWork);
  mountWorkspaceRoutes(app, store, workspaces, configuration, briefs);
  mountManagedUsageRoutes(app, store, ledger, gateway, billing, workspaces);
  mountConfigurationRoutes(app, store, workspaces, configuration, agents);
  connections.mount(app);
  // Accepted close-and-install latches before the desktop handoff; new
  // mutating work pauses after that point. Assigned once updates exist;
  // route handlers run later, so the late binding is safe.
  // A member wakes on team mail (see server/team/service.ts): the run is the same Codex Work
  // run a person starts from the thread, on the member's open task when it has one. Only
  // Codex members run; other engines park as waiting until they exist.
  teamService.setRunStarter(async ({ projectId, member, threadId, text }) => {
    if (isUpdateClosing())
      throw new ApiError(409, 'The app update is accepted. New work pauses until restart.');
    pendingMutations += 1;
    try {
      if (member.engine !== 'codex') throw new ApiError(409, 'This helper cannot run here yet.');
      const state = store.state(projectId);
      const openTask = state.tasks.find(
        (item) => item.assignedTo === member.slotId && !item.deletedAt && item.state !== 'done',
      );
      const started = await startCodexWork(
        {
          projectId,
          threadId,
          attachedTo: { kind: 'project', ref: projectId },
          text,
          sources: [],
          consent: true,
          team: teamForMember(projectId, member, listeningPort),
          taskId: openTask?.id,
          wake: true,
        },
        true,
      );
      return { sessionId: started.session.id };
    } finally {
      pendingMutations -= 1;
    }
  });
  const route =
    (action: (req: Request, res: Response) => Promise<unknown>, locked = true) =>
    async (req: Request, res: Response, next: express.NextFunction) => {
      try {
        const result = locked ? await store.locked(() => action(req, res)) : await action(req, res);
        if (!res.headersSent) res.json(result);
      } catch (error) {
        next(error);
      }
    };
  const id = (req: Request) => String(req.params.id);
  const body = (req: Request) => plain(req.body);
  app.get('/api/health', (_req, res) =>
    res.json({
      ok: true,
      name: 'Diomedes',
      version: packageInfo.version,
      dataDir: store.dataDir,
      projectRoot: store.projectRoot,
      service: 'local',
      port,
    }),
  );
  app.get(
    '/api/settings',
    route(async () => store.settings),
  );
  app.put(
    '/api/settings',
    route(async (req) => store.saveSettings(validateSettings(store.settings, req.body))),
  );
  const externalEngine = (req: Request) =>
    choice(String(req.params.engine), EXTERNAL_ENGINES, 'engine');
  const connectionSignal = (res: Response) => {
    const controller = new AbortController();
    res.once('close', () => {
      if (!res.writableEnded) controller.abort();
    });
    return controller.signal;
  };
  app.get(
    '/api/ai/status',
    route(async () => ({ connections: engines.status() }), false),
  );
  app.post(
    '/api/ai/discover',
    route(async (req) => {
      if (body(req).consent !== true)
        throw new ApiError(409, 'Confirm the local discovery disclosure first.');
      await store.locked(() =>
        store.saveSettings({
          ...store.settings,
          onboarding: {
            ...store.settings.onboarding,
            discoveryConsentAt: now(),
          },
        }),
      );
      return { connections: await engines.discover(true) };
    }, false),
  );
  app.post(
    '/api/ai/check/:engine',
    route(async (req, res) => engines.check(externalEngine(req), connectionSignal(res)), false),
  );
  app.post(
    '/api/ai/select',
    route(async (req) => {
      const b = body(req),
        engine = choice(b.engine, EXTERNAL_ENGINES, 'engine');
      const selected = engines.selection(engine, asString(b.model, 'a model', 120));
      return store.saveSettings({
        ...store.settings,
        services: {
          ...store.settings.services,
          defaultEngine: engine,
          [engine]: true,
          [`${engine}Model`]: selected.model,
          [`${engine}AccountRoute`]: selected.accountRoute,
        },
      });
    }),
  );
  app.get(
    '/api/ai/install/:engine',
    route(async (req) => installer.offer(externalEngine(req)), false),
  );
  app.post(
    '/api/ai/install/:engine',
    route(async (req, res) => {
      const engine = externalEngine(req);
      if (body(req).consent !== true)
        throw new ApiError(409, 'Review and confirm this installation first.');
      const found = (await engines.discover(true)).find((c) => c.engine === engine)!;
      if (found.installation === 'found')
        return {
          detail:
            'An installation already exists. Diomedes will reuse it. Check compatibility and sign-in.',
        };
      const result = await installer.install(engine, true, connectionSignal(res));
      await engines.discover(true);
      return result;
    }, false),
  );
  app.post(
    '/api/ai/login/:engine',
    route(async (req) => {
      const engine = externalEngine(req),
        connection = engines.status().find((c) => c.engine === engine)!;
      return login.start(connection, body(req).consent === true);
    }, false),
  );
  app.post(
    '/api/ai/login/:engine/cancel',
    route(async (req) => login.stop(externalEngine(req)), false),
  );
  app.get(
    '/api/integrations',
    route(
      async (req) => ({
        integrations: (
          await getIntegrationStatuses({
            refresh: req.query.refresh === '1',
            passive: !store.settings.onboarding.discoveryConsentAt,
          })
        ).map((item) =>
          isExternalEngine(item.id)
            ? engines.integration(item.id, store.settings.services?.[item.id] === true)
            : item.adapter === 'ready' && item.kind !== 'sample'
              ? { ...item, enabled: store.settings.services?.[item.id] === true }
              : item,
        ),
      }),
      false,
    ),
  );
  app.get(
    '/api/usage',
    route(async (req) => {
      if (req.query.fake === '1') {
        // Test-mode only: a fixed Codex snapshot so the UI suite can assert
        // the chip, the signal colour and the Settings bars without a real
        // Codex session.
        if (process.env.DIOMEDES_TEST_MODE !== '1')
          throw new ApiError(404, 'This action was not found.');
        const snapshot = fakeCodexSnapshot();
        usageService.record('codex', snapshot);
        return { usage: usageService.all() };
      }
      return { usage: usageService.all() };
    }, false),
  );
  app.get(
    '/api/fs/list',
    route(async (req) => {
      const folder = await safeAbsolute(
        typeof req.query.path === 'string' && req.query.path.trim()
          ? req.query.path
          : store.projectRoot,
      );
      try {
        await fs.access(folder);
      } catch (error) {
        if (!absent(error)) throw error;
        return { path: folder, parent: path.dirname(folder), folders: [] };
      }
      const folders = [];
      for (const item of await fs.readdir(folder, { withFileTypes: true })) {
        if (!item.isDirectory() || item.isSymbolicLink() || item.name.startsWith('.')) continue;
        try {
          const safe = await safeAbsolute(path.join(folder, item.name));
          folders.push({ name: item.name, path: safe });
        } catch (error) {
          if (!(error instanceof ApiError && error.status === 403)) throw error;
        }
      }
      return {
        path: folder,
        parent: path.dirname(folder) === folder ? null : path.dirname(folder),
        folders,
      };
    }),
  );
  app.get(
    '/api/projects',
    route(async () => ({ projects: await store.projects() })),
  );
  app.post(
    '/api/projects/sample',
    route(async () => {
      const name = 'Harbor Street restaurants';
      const project = await store.createProject(
        name,
        path.join(store.projectRoot, `${name} ${identifier().slice(0, 6)}`),
      );
      const state = store.state(project.id);
      state.project.plans.push('Reopening plan.md');
      await store.persist(state);
      await store.writeRecorded(
        project.id,
        [
          {
            path: 'Reopening plan.md',
            expected: null,
            text: '# Reopening plan\n\nHarbor Street restaurants is reopening the patio for fall.\n\n1. Review the fall menu and update the descriptions\n2. Prepare a reopening announcement\n3. Call the produce supplier about seasonal availability\n4. Check the patio setup before opening day\n',
          },
          {
            path: 'Fall menu.md',
            expected: null,
            text: '# Fall menu\n\nRoasted squash soup - $9\nHarbor Street burger - $18\nMushroom risotto - $21\nApple crumble - $8\n\nUse local produce where available. Confirm prices before printing.\n',
          },
          {
            path: 'Opening notes.txt',
            expected: null,
            text: 'Patio reopening: Friday, September 18.\nCheck the weather on Wednesday.\nAsk the team to review the fall menu before the announcement goes out.\n',
          },
        ],
        {
          kind: 'edited',
          sentence: 'You created the Harbor Street sample project',
          sample: true,
          merge: false,
        },
      );
      return store.state(project.id).project;
    }),
  );
  app.post(
    '/api/projects/open',
    route(async (req) => {
      const folder = asString(body(req).folder, 'a folder path', 1000);
      return store.createProject(path.basename(path.resolve(folder)), folder, true);
    }),
  );
  app.post(
    '/api/projects',
    route(async (req) => {
      const b = body(req);
      return store.createProject(
        asString(b.name, 'a project name', 120),
        b.folder === undefined || b.folder === ''
          ? undefined
          : asString(b.folder, 'a folder path', 1000),
      );
    }),
  );
  app.get(
    '/api/projects/:id/state',
    route(async (req) => store.projectState(id(req))),
  );
  /**
   * What an engine can be asked to run. Read from the engine's own list on this
   * computer, so the choices follow the account rather than a Diomedes release.
   */
  app.get(
    '/api/engines/:engineId/models',
    route(async (req) => {
      const engine = String(req.params.engineId);
      if (!/^[a-z][a-z0-9-]{0,39}$/.test(engine))
        throw new ApiError(400, 'That is not an engine name.');
      return engineCatalog(engine);
    }),
  );
  app.get(
    '/api/projects/:id',
    route(async (req) => {
      await store.projects();
      return store.state(id(req)).project;
    }),
  );
  app.post(
    '/api/projects/:id/open-folder',
    route(async (req) => {
      const folder = await safeAbsolute(store.state(id(req)).project.folder);
      if (!(await fs.stat(folder)).isDirectory())
        throw new ApiError(404, 'The project folder is missing.');
      if (process.platform !== 'win32')
        throw new ApiError(
          501,
          'Opening a folder in its desktop app is supported on Windows only.',
        );
      await new Promise<void>((resolve, reject) => {
        const explorer = spawn(
          path.join(process.env.SystemRoot ?? 'C:\\Windows', 'explorer.exe'),
          [folder],
          { shell: false, windowsHide: true, stdio: 'ignore' },
        );
        explorer.once('error', reject);
        explorer.once('spawn', () => {
          explorer.unref();
          resolve();
        });
      });
      return { opened: true };
    }),
  );
  app.put(
    '/api/projects/:id/left-off',
    route(async (req) => {
      const b = body(req),
        state = store.state(id(req));
      const page = choice(b.page, pages, 'page');
      const document =
        b.document === null || b.document === undefined ? null : relativeName(b.document);
      const scroll = b.scroll ?? 0;
      if (typeof scroll !== 'number' || !Number.isFinite(scroll) || scroll < 0)
        throw new ApiError(400, 'Provide a valid scroll position.');
      state.project.leftOff = { page, document, scroll, at: now() };
      await store.persist(state);
      return state.project;
    }),
  );
  app.get(
    '/api/projects/:id/documents',
    route(async (req) => ({ documents: await store.listDocuments(id(req)) })),
  );
  app.get(
    '/api/projects/:id/documents/read',
    route(async (req) =>
      store.readDocument(id(req), asString(req.query.path, 'a document path', 1000)),
    ),
  );
  app.post(
    '/api/projects/:id/documents/write',
    route(async (req) => {
      const b = body(req);
      if (
        typeof b.text !== 'string' ||
        typeof b.baseSha !== 'string' ||
        !/^[a-f0-9]{64}$/.test(b.baseSha)
      )
        throw new ApiError(400, 'Provide document text and the version you opened.');
      const entry = await store.writeRecorded(id(req), [
        { path: relativeName(b.path), text: b.text, expected: b.baseSha },
      ]);
      return { sha: hash(b.text), entryId: entry.id };
    }),
  );
  app.post(
    '/api/projects/:id/documents/create',
    route(async (req) => {
      const b = body(req);
      if (typeof b.text !== 'string') throw new ApiError(400, 'Provide document text.');
      const name = relativeName(b.path);
      if (b.kind === 'plan' && !store.state(id(req)).project.plans.includes(name))
        store.state(id(req)).project.plans.push(name);
      return store.writeRecorded(id(req), [{ path: name, text: b.text, expected: null }], {
        merge: false,
      });
    }),
  );
  app.get(
    '/api/projects/:id/history',
    route(async (req) => {
      const entries = [...store.state(id(req)).history]
        .reverse()
        .filter(
          (e) =>
            (!req.query.path || e.files.some((f) => f.path === req.query.path)) &&
            (!req.query.kind || e.kind === req.query.kind),
        );
      const days = new Map<string, typeof entries>();
      for (const entry of entries) {
        const day = entry.time.slice(0, 10);
        const group = days.get(day) ?? [];
        group.push(entry);
        days.set(day, group);
      }
      return { days: [...days].map(([day, entries]) => ({ day, entries })) };
    }),
  );
  app.post(
    '/api/projects/:id/history/label',
    route(async (req) => store.snapshot(id(req), asString(body(req).label, 'a version name', 120))),
  );
  app.get(
    '/api/projects/:id/history/:entryId/changes',
    route(async (req) => {
      const entry = store.state(id(req)).history.find((e) => e.id === req.params.entryId);
      if (!entry) throw new ApiError(404, 'This history entry was not found.');
      return {
        files: await Promise.all(
          entry.files.map((_file, index) => store.changeFromFile(id(req), entry, index)),
        ),
      };
    }),
  );
  app.post(
    '/api/projects/:id/history/:entryId/restore',
    route(async (req) => {
      const b = body(req);
      let files: string[] | undefined;
      if (b.files !== undefined) {
        if (!Array.isArray(b.files)) throw new ApiError(400, 'Provide the files to restore.');
        files = b.files.map(relativeName);
      }
      return store.restore(
        id(req),
        String(req.params.entryId),
        files,
        b.mode === undefined
          ? undefined
          : choice(b.mode, ['all', 'unchanged-only', 'copies'], 'restore option'),
      );
    }),
  );
  app.post(
    '/api/projects/:id/history/:entryId/restore-file',
    route(
      async (req) =>
        (await store.restore(id(req), String(req.params.entryId), [relativeName(body(req).path)]))
          .entry,
    ),
  );
  app.get(
    '/api/projects/:id/tasks',
    route(async (req) => ({
      tasks: store.state(id(req)).tasks,
      autoUpdate: store.state(id(req)).autoUpdate,
    })),
  );
  app.post(
    '/api/projects/:id/tasks',
    route(async (req) => {
      const b = body(req),
        state = store.state(id(req));
      const task = store.createTask(state, {
        name: asString(b.name, 'a task name', 200),
        description: typeof b.description === 'string' ? b.description.slice(0, 10000) : '',
        owner: b.owner === undefined ? 'you' : choice(b.owner, owners, 'owner'),
      });
      store.addEntry(state, {
        kind: 'tasks-made',
        sentence: `You made a task: ${task.name}`,
        taskId: task.id,
      });
      await store.persist(state);
      return task;
    }),
  );
  app.put(
    '/api/projects/:id/tasks/auto',
    route(async (req) => {
      const state = store.state(id(req)),
        value = body(req).autoUpdate;
      if (typeof value !== 'boolean') throw new ApiError(400, 'Choose true or false.');
      state.autoUpdate = value;
      await store.persist(state);
      return { autoUpdate: value };
    }),
  );
  app.put(
    '/api/projects/:id/tasks/:taskId',
    route(async (req) => {
      const b = body(req),
        state = store.state(id(req)),
        task = state.tasks.find((t) => t.id === req.params.taskId);
      if (!task) throw new ApiError(404, 'This task was not found.');
      if (b.name !== undefined) task.name = asString(b.name, 'a task name', 200);
      if (b.description !== undefined) {
        if (typeof b.description !== 'string' || b.description.length > 10000)
          throw new ApiError(400, 'Provide a description of up to 10,000 characters.');
        task.description = b.description;
      }
      if (b.owner !== undefined) task.owner = choice(b.owner, owners, 'owner');
      if (b.state !== undefined) {
        if (
          state.sessions.some(
            (s) => s.taskId === task.id && ['working', 'waiting', 'queued'].includes(s.state),
          )
        )
          throw new ApiError(409, 'Stop this work before moving the task manually.');
        store.moveTask(state, task, choice(b.state, states, 'task state'));
        task.reason = null;
      }
      await store.persist(state);
      return task;
    }),
  );
  app.post(
    '/api/projects/:id/tasks/:taskId/undo-move',
    route(async (req) => {
      const state = store.state(id(req)),
        task = state.tasks.find((t) => t.id === req.params.taskId);
      if (!task) throw new ApiError(404, 'This task was not found.');
      const move = task.moves.at(-1);
      if (!move || move.undone || move.by === 'you' || Date.parse(move.undoUntil) < Date.now())
        throw new ApiError(409, 'This automatic move can no longer be undone.');
      const session = state.sessions.find(
        (s) => s.taskId === task.id && ['working', 'waiting', 'queued'].includes(s.state),
      );
      if (session) await serviceFor(id(req), session.id).stop(id(req), session.id);
      task.state = move.from;
      move.undone = true;
      store.addEntry(state, {
        kind: 'task-moved',
        sentence: `You undid the move of ${task.name}`,
        taskId: task.id,
      });
      await store.persist(state);
      return task;
    }),
  );
  app.post(
    '/api/projects/:id/plans/find-tasks',
    route(async (req) => {
      const document = await store.readDocument(id(req), relativeName(body(req).path));
      return { found: findTasks(document.text) };
    }),
  );
  app.post(
    '/api/projects/:id/plans/add-tasks',
    route(async (req) => {
      const b = body(req),
        name = relativeName(b.path),
        document = await store.readDocument(id(req), name);
      const found = findTasks(document.text);
      const state = store.state(id(req));
      if (!Array.isArray(b.items) || !b.items.length || b.items.length > 500)
        throw new ApiError(400, 'Choose between 1 and 500 tasks.');
      const items = b.items.map((item) => {
        const value = plain(item);
        const candidate = found.find((f) => f.line === value.line);
        if (!candidate) throw new ApiError(409, 'This plan changed. Find its tasks again.');
        return {
          line: candidate.line,
          name: asString(value.name, 'a task name', 200),
          owner: choice(value.owner, owners, 'owner'),
        };
      });
      if (new Set(items.map((i) => i.line)).size !== items.length)
        throw new ApiError(400, 'Choose each plan line once.');
      const tasks = items.map((item) =>
        store.createTask(state, {
          name: item.name,
          owner: item.owner,
          from: {
            plan: name,
            step: found.findIndex((candidate) => candidate.line === item.line) + 1,
          },
        }),
      );
      const lines = document.text.split(/\r?\n/);
      items.forEach((item, index) => {
        lines[item.line - 1] += ` T${tasks[index].id.slice(1)}`;
      });
      if (!state.project.plans.includes(name)) state.project.plans.push(name);
      const entry = await store.writeRecorded(
        id(req),
        [{ path: name, text: lines.join('\n'), expected: document.sha }],
        {
          kind: 'tasks-made',
          sentence: `You made ${tasks.length} tasks from ${name}`,
          merge: false,
        },
      );
      return { tasks, entryId: entry.id };
    }),
  );
  app.get(
    '/api/projects/:id/work',
    route(async (req) => ({ sessions: store.state(id(req)).sessions })),
  );
  app.post(
    '/api/projects/:id/work/start',
    route(async (req) => {
      if (isUpdateClosing())
        throw new ApiError(409, 'The app update is accepted. New work pauses until restart.');
      const supplied = body(req);
      if (supplied.capabilityId !== undefined) {
        if (supplied.protocolVersion !== undefined || supplied.commandId !== undefined)
          throw new ApiError(400, 'Saved Work commands for native fixtures are not available yet.');
        return harness.bridge.start(
          id(req),
          supplied.taskId === null ? null : asString(supplied.taskId, 'a task', 100),
          asString(supplied.capabilityId, 'a capability', 100),
          asString(supplied.instruction, 'an instruction', 16000),
          localHarnessPrincipal(id(req)),
        );
      }
      const command = parseWorkCommand(supplied);
      const b = command?.request ?? supplied;
      const projectId = id(req);
      const state = store.state(projectId);
      const taskId = asString(b.taskId, 'a task', 100);
      const threadId =
        b.threadId === undefined || b.threadId === null
          ? undefined
          : asString(b.threadId, 'a thread', 100);
      let threadPermission: ThreadPermission = 'show-first';
      if (threadId !== undefined) {
        const thread = store.state(projectId).conversations.find((c) => c.id === threadId);
        if (!thread) throw new ApiError(404, 'This thread was not found.');
        threadPermission = thread.permission ?? 'show-first';
      }
      const selectedRoute =
        b.route === undefined
          ? selectedEngine(
              store.settings,
              state.project,
              state.conversations.find((c) => c.id === threadId),
            )
          : choice(b.route, ROUTES, 'service');
      const team = teamForThread(req, projectId, threadId);
      if (command && team)
        throw new ApiError(409, 'Saved Work commands for team helpers are not available yet.', {
          code: 'unsupported_work_target',
        });
      if (selectedRoute !== 'sample') {
        if (store.settings.services?.[selectedRoute] !== true)
          throw new ApiError(409, 'Turn the selected engine on in Settings before using it.');
        if (b.consent !== true)
          throw new ApiError(
            409,
            'Your instruction and selected documents will be sent to the selected service. Confirm before sending.',
            { consentRequired: true },
          );
        if (!Array.isArray(b.sources))
          throw new ApiError(
            400,
            'Provide the explicitly selected source documents, or an empty list to propose new files.',
          );
      }
      // Recheck the current local scope and service consent before returning a cached
      // receipt. Replay never scans source files or dispatches another adapter call.
      if (!state.tasks.some((task) => task.id === taskId && !task.deletedAt))
        throw new ApiError(404, 'This task was not found.');
      if (command) {
        const previous = store.workCommand(
          projectId,
          command.admission.commandId,
          command.admission.payloadDigest,
        );
        if (previous) return structuredClone(previous);
        store.checkWorkReceiptCapacity(projectId);
      }
      if (selectedRoute !== 'sample') {
        return nativeWork.start(projectId, taskId, {
          engine: selectedRoute,
          threadId,
          agentId:
            command?.request.agentId ??
            state.conversations.find((c) => c.id === threadId)?.requested?.agent ??
            null,
          requested: nativeChoice(
            selectedRoute,
            projectId,
            state.conversations.find((c) => c.id === threadId),
          ),
          instruction:
            b.instruction === undefined
              ? undefined
              : asString(b.instruction, 'an instruction', 16000),
          sources: Array.isArray(b.sources) ? b.sources.map(relativeName) : [],
          consent: true,
          team,
          permission: threadPermission,
          admission: command?.admission,
        });
      }
      return work.start(
        projectId,
        taskId,
        typeof b.instruction === 'string' ? b.instruction : '',
        b.demo === 'fault',
        { permission: threadPermission, admission: command?.admission },
      );
    }),
  );
  app.get(
    '/api/projects/:id/work/commands/:commandId',
    route(async (req) => {
      const session = store.workCommand(
        id(req),
        validateWorkCommandId(String(req.params.commandId)),
      );
      if (!session)
        throw new ApiError(404, 'This Work command was not found.', {
          code: 'work_command_not_found',
        });
      return structuredClone(session);
    }),
  );
  app.post(
    '/api/projects/:id/work/:sessionId/stop',
    route(async (req) =>
      serviceFor(id(req), String(req.params.sessionId)).stop(id(req), String(req.params.sessionId)),
    ),
  );
  app.post(
    '/api/projects/:id/work/:sessionId/note',
    route(async (req) =>
      serviceFor(id(req), String(req.params.sessionId)).note(
        id(req),
        String(req.params.sessionId),
        asString(body(req).text, 'a note', 4000),
      ),
    ),
  );
  app.get(
    '/api/projects/:id/needs',
    route(async (req) => ({ needs: store.state(id(req)).needs })),
  );
  app.get(
    '/api/projects/:id/needs/:needId',
    route(async (req) => {
      const need = store.state(id(req)).needs.find((item) => item.id === req.params.needId);
      if (!need) throw new ApiError(404, 'This request was not found.');
      return need;
    }),
  );
  app.post(
    '/api/projects/:id/needs/:needId/resolve',
    route(async (req) => {
      const b = body(req);
      if (b.allowForTask !== undefined && typeof b.allowForTask !== 'boolean')
        throw new ApiError(400, 'Choose true or false for the task allowance.');
      const need = store.state(id(req)).needs.find((item) => item.id === req.params.needId);
      if (!need) throw new ApiError(404, 'This request was not found.');
      const admission = parseApprovalCommand(id(req), need.id, b);
      if (need.harness)
        return harness.bridge.resolve(
          id(req),
          need.id,
          choice(b.resolution, ['go-ahead', 'declined'], 'decision'),
          b.allowForTask === true,
          admission,
        );
      if (need.approval || admission)
        return nativeWork.resolve(
          id(req),
          need.id,
          choice(b.resolution, ['go-ahead', 'declined'], 'decision'),
          b.allowForTask === true,
          admission,
        );
      return serviceFor(id(req), need.sessionId).resolve(
        id(req),
        String(req.params.needId),
        choice(b.resolution, ['go-ahead', 'declined'], 'decision'),
        b.allowForTask === true,
      );
    }),
  );
  const review = async (projectId: string, changeId: string, action: 'keep' | 'undo') => {
    let state = store.state(projectId);
    const change = state.changes.find((c) => c.id === changeId);
    if (!change) throw new ApiError(404, 'This change was not found.');
    if (change.state !== 'waiting')
      throw new ApiError(409, 'This change has already been reviewed.');
    let entryId: string | undefined;
    if (action === 'undo') {
      const result = await store.restore(projectId, change.entryId, [change.path]);
      entryId = result.entryId;
      state = store.state(projectId);
    }
    const fresh = state.changes.find((c) => c.id === changeId)!;
    fresh.state = action === 'keep' ? 'kept' : 'undone';
    const task = state.tasks.find((t) => t.id === fresh.taskId);
    if (task && !state.changes.some((c) => c.taskId === task.id && c.state === 'waiting')) {
      store.moveTask(state, task, 'done', 'diomedes');
      task.reason = null;
    }
    await store.persist(state);
    return { change: fresh, entryId };
  };
  app.get(
    '/api/projects/:id/review',
    route(async (req) => ({ changes: store.state(id(req)).changes })),
  );
  app.post(
    '/api/projects/:id/review/all',
    route(async (req) => {
      const b = body(req),
        action = choice(b.action, ['keep', 'undo'], 'review action');
      const changes = store
        .state(id(req))
        .changes.filter(
          (c) => c.state === 'waiting' && (!b.sessionId || c.sessionId === b.sessionId),
        );
      const results = [];
      for (const change of changes) results.push(await review(id(req), change.id, action));
      return { changes: results.map((r) => r.change) };
    }),
  );
  app.post(
    '/api/projects/:id/review/:changeId',
    route(async (req) =>
      review(
        id(req),
        String(req.params.changeId),
        choice(body(req).action, ['keep', 'undo'], 'review action'),
      ),
    ),
  );
  app.get(
    '/api/projects/:id/conversations',
    route(async (req) => ({ conversations: store.state(id(req)).conversations })),
  );
  const touchThread = (
    conversation: Conversation,
    at: string,
    tasks: { id: string; name: string }[] = [],
  ) => {
    conversation.updatedAt = at;
    if (conversation.name === 'New thread') {
      const firstYou = conversation.turns.find((t) => t.role === 'you');
      if (firstYou) conversation.name = threadNameFromText(firstYou.text);
      else if (conversation.attachedTo.kind === 'task') {
        const task = tasks.find((t) => t.id === conversation.attachedTo.ref);
        if (task) conversation.name = `Thread for ${task.name}`;
      }
    }
  };
  app.get(
    '/api/projects/:id/threads',
    route(async (req) => {
      const threads = [...store.state(id(req)).conversations].sort((a, b) =>
        (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''),
      );
      return { threads };
    }),
  );
  app.post(
    '/api/projects/:id/threads',
    route(async (req, res) => {
      const b = body(req),
        projectId = id(req),
        state = store.state(projectId);
      let attachedTo: Conversation['attachedTo'] = { kind: 'project', ref: projectId };
      if (b.attachedTo !== undefined) {
        const attached = plain(b.attachedTo);
        attachedTo = {
          kind: choice(
            attached.kind,
            ['project', 'document', 'plan', 'task', 'review'],
            'attachment type',
          ),
          ref: asString(attached.ref, 'an attachment', 1000),
        };
      }
      let taskId: string | null = attachedTo.kind === 'task' ? attachedTo.ref : null;
      if (b.taskId !== undefined && b.taskId !== null) {
        const given = asString(b.taskId, 'a task', 100);
        const task = state.tasks.find((t) => t.id === given);
        if (task) {
          attachedTo = { kind: 'task', ref: task.id };
          taskId = task.id;
        }
      }
      let name: string;
      if (b.name !== undefined) {
        if (typeof b.name !== 'string' || !b.name.trim() || b.name.trim().length > 120)
          throw new ApiError(400, 'Give this thread a name of up to 120 characters.');
        name = b.name.trim();
      } else {
        const task =
          attachedTo.kind === 'task' ? state.tasks.find((t) => t.id === attachedTo.ref) : undefined;
        name = task ? `Thread for ${task.name}` : 'New thread';
      }
      const permission: ThreadPermission =
        b.permission === undefined ? 'show-first' : parseThreadPermission(b.permission);
      let threadMode: Conversation['mode'] = 'ask';
      if (b.mode !== undefined) {
        const parsed = modeOf(b.mode);
        if (!parsed) throw new ApiError(400, 'Choose a valid mode.');
        threadMode = parsed;
      }
      const stamped = now();
      const conversation: Conversation = {
        id: identifier('C'),
        attachedTo,
        turns: [],
        name,
        createdAt: stamped,
        updatedAt: stamped,
        taskId,
        helper: null,
        permission,
        mode: threadMode,
      };
      state.conversations.push(conversation);
      await store.persist(state);
      res.status(201).json(conversation);
      return undefined;
    }),
  );
  app.put(
    '/api/projects/:id/threads/:threadId',
    route(async (req) => {
      const state = store.state(id(req)),
        conversation = state.conversations.find((c) => c.id === req.params.threadId);
      if (!conversation) throw new ApiError(404, 'This thread was not found.');
      const b = body(req);
      if (
        b.name === undefined &&
        b.permission === undefined &&
        b.mode === undefined &&
        b.requested === undefined &&
        b.engine === undefined
      )
        throw new ApiError(400, 'Provide a thread name, permission mode, mode or helper choice.');
      if (b.name !== undefined) {
        if (typeof b.name !== 'string' || !b.name.trim() || b.name.trim().length > 120)
          throw new ApiError(400, 'Give this thread a name of up to 120 characters.');
        conversation.name = b.name.trim();
      }
      if (b.permission !== undefined) conversation.permission = parseThreadPermission(b.permission);
      if (b.mode !== undefined) {
        const parsed = modeOf(b.mode);
        if (!parsed) throw new ApiError(400, 'Choose a valid mode.');
        conversation.mode = parsed;
      }
      const engine =
        b.engine === undefined
          ? selectedEngine(store.settings, state.project, conversation)
          : choice(b.engine, ROUTES, 'engine');
      if (b.requested !== undefined) conversation.requested = parseRequested(b.requested, engine);
      if (b.engine !== undefined) conversation.engine = engine;
      await store.persist(state);
      return conversation;
    }),
  );
  /**
   * Verified helper bookkeeping (muse/verified-model). A displayed helper name comes
   * only from the runtime result, never from answer text. Sample work is
   * deterministic, so its helper is verified without a runtime call.
   */
  const codexModelSetting = (): string | undefined => {
    const raw = (store.settings.services as Record<string, unknown> | undefined)?.codexModel;
    return typeof raw === 'string' && raw.trim() && raw.length <= 120 ? raw.trim() : undefined;
  };
  const codexEffortSetting = (): string | undefined => {
    const raw = (store.settings.services as Record<string, unknown> | undefined)?.codexEffort;
    return typeof raw === 'string' && raw.trim() && raw.length <= 40 ? raw.trim() : undefined;
  };
  /**
   * What to ask Codex to run: the thread's own choice first, then the saved
   * default, then nothing, which leaves the runtime's default in place. A pair
   * the engine no longer offers is dropped rather than sent.
   */
  const codexChoice = (conversation?: Conversation | null): { model?: string; effort?: string } => {
    const chosen = conversation?.requested;
    const model = chosen?.model ?? codexModelSetting();
    const effort = chosen?.model ? (chosen.effort ?? undefined) : codexEffortSetting();
    if (!model || !isKnownChoice('codex', model, effort ?? null)) return {};
    return { model, ...(effort ? { effort } : {}) };
  };
  const nativeChoice = (
    engine: Exclude<Route, 'sample'>,
    projectId: string,
    conversation?: Conversation | null,
  ): { model?: string; effort?: string } => {
    if (engine === 'codex') return codexChoice(conversation);
    const model = selectedModel(
      engine,
      store.settings,
      store.state(projectId).project,
      conversation,
    );
    if (!model) throw new ApiError(409, 'Select a model for this engine in Settings.');
    // The adapter rechecks the live catalogue before sending. Persisted overrides
    // never disappear just because the connection is stale or unavailable.
    return { model };
  };
  const codexHelper = (result: {
    model?: string;
    version?: string;
  }): NonNullable<Turn['helper']> =>
    result.model
      ? { engine: 'codex', model: result.model, version: result.version ?? null, verified: true }
      : { engine: 'codex', model: null, version: result.version ?? null, verified: false };
  const sampleHelper = (): NonNullable<Turn['helper']> => ({
    engine: 'sample',
    model: null,
    version: null,
    verified: true,
  });
  /**
   * A Codex Work run from a thread: a task from the text (or the given task), the person's
   * turn, the native run with any team options, and the reply turn. `held` says the caller
   * already holds the store lock (the lock is a queue, not reentrant): the team service's
   * wake runs inside a locked route, the /ask route does not.
   */
  const startCodexWork = async (
    input: {
      projectId: string;
      engine?: Exclude<Route, 'sample'>;
      threadId: string | undefined;
      attachedTo: Conversation['attachedTo'];
      text: string;
      sources: string[];
      consent: boolean;
      team: NativeTeamOptions | undefined;
      taskId?: string;
      wake?: boolean;
      mode?: 'build' | 'fix';
      failing?: { document?: string; text?: string };
    },
    held = false,
  ) => {
    const { projectId, threadId, attachedTo, text, sources, consent, team, taskId, wake, failing } =
      input;
    const runMode = input.mode ?? 'build';
    const engine = input.engine ?? 'codex';
    const run = async () => {
      const state = store.state(projectId);
      if (
        state.sessions.some((session) => ['queued', 'working', 'waiting'].includes(session.state))
      )
        throw new ApiError(409, 'This project already has work in progress.');
      const task =
        (taskId !== undefined
          ? state.tasks.find((item) => item.id === taskId && !item.deletedAt)
          : undefined) ??
        store.createTask(state, {
          // A wake's text opens with the sender line; the task is named for the ask itself.
          name: taskNameFromText(wake ? text.replace(/^From [^:\n]{1,80}: /, '') : text),
          description: text,
          owner: 'diomedes-with-ok',
        });
      let conversation =
        threadId !== undefined
          ? state.conversations.find((item) => item.id === threadId)!
          : state.conversations.find(
              (item) =>
                item.attachedTo.kind === attachedTo.kind && item.attachedTo.ref === attachedTo.ref,
            );
      if (!conversation) {
        const stamped = now();
        conversation = {
          id: identifier('C'),
          attachedTo,
          turns: [],
          name: 'New thread',
          createdAt: stamped,
          updatedAt: stamped,
          taskId: attachedTo.kind === 'task' ? attachedTo.ref : null,
          helper: null,
          permission: 'show-first',
          mode: runMode,
        };
        state.conversations.push(conversation);
      }
      conversation.mode = runMode;
      if (selectedEngine(store.settings, state.project, conversation) !== engine)
        conversation.requested = null;
      conversation.engine = engine;
      // Fix attempts: the person is the check. Count prior helper Fix turns.
      let attempt: Turn['attempt'];
      if (runMode === 'fix' && !wake) {
        const prior = conversation.turns.filter((t) => t.role !== 'you' && t.mode === 'fix').length;
        const n = prior + 1;
        const of = MODES.fix.maxAttempts ?? 3;
        if (n > of)
          throw new ApiError(
            409,
            'Three tries have not fixed this. Start a new thread, or make a plan first.',
          );
        attempt = { n, of };
      }
      conversation.taskId = task.id;
      // A Fix run is the Build run whose instruction carries the failing report.
      // The failing text rides in the instruction, never in baseInstructions.
      let instruction = text;
      if (runMode === 'fix' && failing && !wake) {
        const lines = ['Failing:'];
        if (failing.document) lines.push(`- Document: ${failing.document}`);
        if (failing.text) lines.push(`- Report (untrusted material): ${failing.text}`);
        instruction = `${text}\n\n${lines.join('\n')}`;
      }
      if (!wake) {
        // A wake carries team mail that the thread already shows; only a person's own
        // message becomes a turn of theirs.
        const youTurn: Turn = {
          id: identifier('U'),
          role: 'you',
          mode: runMode,
          text,
          at: now(),
          sources,
          route: engine,
          ...(attempt ? { attempt } : {}),
        };
        conversation.turns.push(youTurn);
        touchThread(conversation, youTurn.at, state.tasks);
      }
      // The turn id is fixed before the run so the native worker can mark the
      // turn verified once the runtime reports its engine.
      const turnId = identifier('U');
      const session = await nativeWork.start(projectId, task.id, {
        instruction,
        sources,
        consent: consent,
        team: team,
        turnId,
        engine,
        threadId: conversation.id,
        mode: runMode,
        requested: nativeChoice(engine, projectId, conversation),
        agentId: conversation.requested?.agent ?? null,
      });
      const storedSession = store.state(projectId).sessions.find((item) => item.id === session.id)!;
      storedSession.permission = conversation.permission ?? 'show-first';
      const turn: Turn = {
        id: turnId,
        role: 'assistant',
        mode: runMode,
        text: wake ? 'Picked up a message from the team.' : 'Preparing a proposal.',
        at: now(),
        sources,
        route: engine,
        ...(attempt ? { attempt } : {}),
        helper: {
          engine,
          model: nativeChoice(engine, projectId, conversation).model ?? null,
          version: null,
          verified: false,
        },
      };
      conversation.turns.push(turn);
      touchThread(conversation, turn.at, state.tasks);
      await store.persist(store.state(projectId));
      return {
        turn,
        conversation,
        session: store.state(projectId).sessions.find((item) => item.id === session.id)!,
      };
    };
    return held ? run() : store.locked(run);
  };
  app.post(
    '/api/projects/:id/ask',
    route(async (req, res) => {
      const b = body(req),
        projectId = id(req),
        text = asString(b.text, 'an instruction', 16000),
        serviceRoute =
          b.route === undefined
            ? selectedEngine(
                store.settings,
                store.state(projectId).project,
                store.state(projectId).conversations.find((c) => c.id === b.threadId),
              )
            : choice(b.route, ROUTES, 'service');
      const parsedMode = modeOf(b.mode);
      if (!parsedMode) throw new ApiError(400, 'Choose a valid mode.');
      const mode = parsedMode;
      const attached =
        b.attachedTo === undefined ? { kind: 'project', ref: projectId } : plain(b.attachedTo);
      const attachedTo: Conversation['attachedTo'] = {
        kind: choice(
          attached.kind,
          ['project', 'document', 'plan', 'task', 'review'],
          'attachment type',
        ),
        ref: asString(attached.ref, 'an attachment', 1000),
      };
      const threadId =
        b.threadId === undefined || b.threadId === null
          ? undefined
          : asString(b.threadId, 'a thread', 100);
      if (
        threadId !== undefined &&
        !store.state(projectId).conversations.some((c) => c.id === threadId)
      )
        throw new ApiError(404, 'This thread was not found.');
      if (serviceRoute !== 'sample' && store.settings.services?.[serviceRoute] !== true)
        throw new ApiError(409, 'Turn the selected engine on in Settings before using it.');
      const needsConsent =
        isExternalEngine(serviceRoute) ||
        (serviceRoute === 'codex' &&
          (mode === 'build' || mode === 'fix' || store.settings.permissions.sending));
      if (needsConsent && b.consent !== true)
        throw new ApiError(
          409,
          `Your instruction and selected documents will be sent to ${isExternalEngine(serviceRoute) ? ENGINE_NAMES[serviceRoute] : 'Codex'}. Confirm before sending.`,
          { consentRequired: true },
        );
      let sources: string[] = [];
      if (b.sources !== undefined) {
        if (!Array.isArray(b.sources) || b.sources.length > 8)
          throw new ApiError(400, 'Select no more than eight source documents.');
        sources = b.sources.map(relativeName);
      }
      if (['document', 'plan'].includes(attachedTo.kind))
        sources.push(relativeName(attachedTo.ref));
      sources = [...new Set(sources)];
      if (sources.length > 8)
        throw new ApiError(400, 'Select no more than eight source documents.');
      // Fix binds to one failing thing: a selected document and/or pasted text.
      let failing: { document?: string; text?: string } | undefined;
      if (mode === 'fix') {
        const raw = b.failing;
        const missing = () =>
          new ApiError(400, 'Say what is failing: pick the document or paste what went wrong.');
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw missing();
        const record = raw as Record<string, unknown>;
        let document: string | undefined;
        let failText: string | undefined;
        if (record.document !== undefined) {
          if (typeof record.document !== 'string' || !record.document.trim()) throw missing();
          try {
            document = relativeName(record.document);
          } catch {
            throw missing();
          }
          if (!sources.includes(document)) throw missing();
        }
        if (record.text !== undefined) {
          if (typeof record.text !== 'string' || !record.text.trim()) throw missing();
          if (record.text.length > 4000) throw missing();
          failText = record.text;
        }
        if (!document && !failText) throw missing();
        failing = { ...(document ? { document } : {}), ...(failText ? { text: failText } : {}) };
      }
      if ((mode === 'build' || mode === 'fix') && serviceRoute !== 'sample')
        return startCodexWork({
          engine: serviceRoute,
          projectId,
          threadId,
          attachedTo,
          text,
          sources,
          consent: b.consent === true,
          team: teamForThread(req, projectId, threadId),
          mode,
          ...(failing ? { failing } : {}),
        });
      const prepared = await store.locked(async () => {
        const state = store.state(projectId);
        let conversation =
          threadId !== undefined
            ? state.conversations.find((c) => c.id === threadId)!
            : state.conversations.find(
                (c) => c.attachedTo.kind === attachedTo.kind && c.attachedTo.ref === attachedTo.ref,
              );
        if (!conversation) {
          const stamped = now();
          conversation = {
            id: identifier('C'),
            attachedTo,
            turns: [],
            name: 'New thread',
            createdAt: stamped,
            updatedAt: stamped,
            taskId: attachedTo.kind === 'task' ? attachedTo.ref : null,
            helper: null,
            permission: 'show-first',
            mode,
          };
          state.conversations.push(conversation);
        }
        conversation.mode = mode;
        if (selectedEngine(store.settings, state.project, conversation) !== serviceRoute)
          conversation.requested = null;
        conversation.engine = serviceRoute;
        let attempt: Turn['attempt'];
        if (mode === 'fix') {
          const prior = conversation.turns.filter(
            (t) => t.role !== 'you' && t.mode === 'fix',
          ).length;
          const n = prior + 1;
          const of = MODES.fix.maxAttempts ?? 3;
          if (n > of)
            throw new ApiError(
              409,
              'Three tries have not fixed this. Start a new thread, or make a plan first.',
            );
          attempt = { n, of };
        }
        const documents = await Promise.all(
          sources.map(async (name) => {
            const document = await store.readDocument(projectId, name);
            return { path: name, text: document.text };
          }),
        );
        if (documents.reduce((total, d) => total + Buffer.byteLength(d.text), 0) > 128000)
          throw new ApiError(413, 'Choose less than 128 KB of source text for this request.');
        const youTurn: Turn = {
          id: identifier('U'),
          role: 'you',
          mode,
          text,
          at: now(),
          sources,
          route: serviceRoute,
          ...(attempt ? { attempt } : {}),
        };
        conversation.turns.push(youTurn);
        touchThread(conversation, youTurn.at, state.tasks);
        await store.persist(state);
        return { conversationId: conversation.id, documents, attempt };
      });
      let answer: string;
      let helper: NonNullable<Turn['helper']>;
      const runChoice =
        serviceRoute === 'sample'
          ? {}
          : nativeChoice(
              serviceRoute,
              projectId,
              store.state(projectId).conversations.find((c) => c.id === prepared.conversationId),
            );
      const requestedModel = runChoice.model;
      if (isExternalEngine(serviceRoute)) {
        const accountRoute = store.settings.services?.[`${serviceRoute}AccountRoute`];
        if (!requestedModel || typeof accountRoute !== 'string')
          throw new ApiError(409, 'Select this service and model in AI setup first.');
        const requestId = identifier('R');
        const progress = (kind: 'started' | 'delta' | 'ended', text?: string) =>
          store.emit('engine-text', {
            projectId,
            threadId: prepared.conversationId,
            requestId,
            kind,
            ...(text ? { text } : {}),
          });
        progress('started');
        try {
          const result = await engines.generate(serviceRoute, {
            projectId,
            threadId: prepared.conversationId,
            requestId,
            prompt: text,
            documents: prepared.documents,
            instructions: MODES[mode].instructions,
            model: requestedModel,
            accountRoute,
            signal: connectionSignal(res),
            onDelta: (delta) => progress('delta', delta),
          });
          answer = result.text;
          helper = {
            engine: serviceRoute,
            model: result.model,
            version: result.version,
            verified: true,
          };
        } finally {
          progress('ended');
        }
      } else if (serviceRoute === 'codex') {
        try {
          const result = await askCodex({
            prompt: text,
            documents: prepared.documents,
            ...(requestedModel ? { model: requestedModel } : {}),
            instructions: MODES[mode].instructions,
            // A level chosen for the thread outranks the mode's own, up to the
            // mode's ceiling; only Fix has one, so Ask and Plan follow the choice.
            effort: effortFor(mode, runChoice.effort, MODES[mode].effort),
          });
          answer = result.text;
          helper = codexHelper(result);
        } catch (error) {
          throw new ApiError(
            503,
            error instanceof Error ? error.message : 'Codex could not complete this request.',
          );
        }
      } else {
        helper = sampleHelper();
        answer =
          mode === 'ask'
            ? `No service is connected for this request, so Diomedes cannot answer yet.${sources.length ? ` It would read ${sources.slice(0, 3).join(', ')} to answer.` : ''} ${
                store.settings.surface === 'console'
                  ? 'Turn an engine on in Settings > Engines.'
                  : 'Turn a helper on in Settings > Helpers on this computer.'
              }`
            : mode === 'plan'
              ? `# ${text.split('\n')[0].slice(0, 120)}\n\nSample plan written without a service on ${now()}. Edit it freely.\n\n1. ${text.replaceAll('\n', ' ').slice(0, 240)}\n2. Review what changed\n3. Call anyone who needs to know\n`
              : mode === 'fix'
                ? 'Started a clearly labelled sample fix. No AI service is involved.'
                : 'Started clearly labelled sample work. No AI service is involved.';
      }
      return store.locked(async () => {
        let state = store.state(projectId);
        let document: string | undefined;
        let session: Session | undefined;
        let createdTaskId: string | null = null;
        if (mode === 'plan' && !isExternalEngine(serviceRoute)) {
          const safeTitle =
            text
              .split('\n')[0]
              .replace(/[<>:"/\\|?*\x00-\x1f]/g, '')
              .trim()
              .replace(/[. ]+$/, '')
              .slice(0, 72) || 'New plan';
          document = `${safeTitle}.md`;
          if ((await store.current(projectId, document)) !== null)
            document = `${safeTitle} ${identifier().slice(0, 4)}.md`;
          state.project.plans.push(document);
          await store.writeRecorded(projectId, [{ path: document, text: answer, expected: null }], {
            actor: 'diomedes',
            kind: 'edited',
            sentence:
              helper.verified && helper.model
                ? `Diomedes, with Codex ${helper.model}, wrote ${document}`
                : `Diomedes wrote ${document}`,
            sample: serviceRoute === 'sample',
            review: true,
            merge: false,
          });
          state = store.state(projectId);
        } else if (mode === 'build' || mode === 'fix') {
          if (
            state.sessions.some((session) =>
              ['queued', 'working', 'waiting'].includes(session.state),
            )
          )
            throw new ApiError(409, 'This project already has work in progress.');
          const task = store.createTask(state, {
            name: taskNameFromText(text),
            description: text,
            owner: 'diomedes-with-ok',
          });
          createdTaskId = task.id;
          await store.persist(state);
          session = await work.start(projectId, task.id, text);
          state = store.state(projectId);
        }
        const conversation = state.conversations.find((c) => c.id === prepared.conversationId)!;
        if (createdTaskId && !conversation.taskId) conversation.taskId = createdTaskId;
        conversation.mode = mode;
        conversation.helper = { engine: helper.engine, model: helper.model };
        if (session) {
          const sessionId = session.id;
          const stored = state.sessions.find((item) => item.id === sessionId)!;
          stored.permission = conversation.permission ?? 'show-first';
          if (stored.sample) {
            stored.engine.verified = true;
            stored.engine.version = null;
          }
          session = stored;
        }
        const turn: Turn = {
          id: identifier('U'),
          role: 'assistant',
          mode,
          text: answer,
          at: now(),
          sources,
          route: serviceRoute,
          ...(prepared.attempt ? { attempt: prepared.attempt } : {}),
          helper,
          origin:
            serviceRoute === 'sample'
              ? applicationOrigin()
              : directOrigin({
                  engine: helper.engine,
                  requestedModel: requestedModel ?? null,
                  reportedModel: helper.verified ? helper.model : null,
                  version: helper.version,
                  producerId: prepared.conversationId,
                  executorId: helper.engine,
                }),
        };
        conversation.turns.push(turn);
        touchThread(conversation, turn.at, state.tasks);
        await store.persist(state);
        return { turn, conversation, document, session };
      });
    }, false),
  );
  app.get('/api/events', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();
    const send = (event: string, data: unknown) => {
      if (!res.destroyed) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };
    const listener = (projectId: string) => {
      const state = store.state(projectId);
      send('state', { projectId, state: statePayload(state) });
      for (const event of [
        'project',
        'tasks',
        'needs',
        'history',
        'review',
        'session',
        'status',
        'conversations',
        'team',
      ])
        send(event, {
          projectId,
          data:
            event === 'project'
              ? state.project
              : event === 'review'
                ? state.changes
                : event === 'session'
                  ? state.sessions
                  : event === 'status'
                    ? state.project.status
                    : event === 'team'
                      ? (state.team ?? { members: [], messages: [], runs: [] })
                      : state[event as 'tasks' | 'needs' | 'history' | 'conversations'],
        });
      send('projects', { projects: [state.project] });
    };
    const settingsListener = (settings: Settings) => send('settings', settings);
    const textListener = (data: unknown) => send('engine-text', data);
    const usageListener = (snapshots: UsageSnapshot[]) => send('usage', { usage: snapshots });
    store.on('change', listener);
    store.on('settings', settingsListener);
    store.on('engine-text', textListener);
    const offUsage: () => void = usageService.subscribe(usageListener);
    // The client re-fetches /api/usage on this event, like it does for settings.
    send('ready', { ok: true });
    const heartbeat = setInterval(() => {
      if (!res.destroyed) res.write(': keep-alive\n\n');
    }, 15000);
    heartbeat.unref();
    req.on('close', () => {
      clearInterval(heartbeat);
      store.off('change', listener);
      store.off('settings', settingsListener);
      store.off('engine-text', textListener);
      offUsage();
    });
  });
  // Bounded application updates: explicit check of the fixed official
  // release channel, verified download, then explicit close-and-install.
  // The verified record lives in host state; update effects never run
  // under task grants and never touch project data.
  const updates = new AppUpdateService({
    currentVersion: packageInfo.version,
    dataDir: store.dataDir,
    platform: options.updateOverrides?.platform,
    packaged: options.updateOverrides?.packaged,
    installed: options.updateOverrides?.installed ?? false,
    isBusy: async () => {
      if (pendingMutations > 0) return true;
      for (const project of await store.projects()) {
        if (
          store
            .state(project.id)
            .sessions.some((session) => ['queued', 'working', 'waiting'].includes(session.state))
        )
          return true;
      }
      return false;
    },
    transport: options.updateOverrides?.transport,
  });
  isUpdateClosing = () => updates.isInstallAccepted();
  mountAppUpdateRoutes(app, updates, {
    onInstallAccepted: options.updateOverrides?.onInstallAccepted,
  });
  app.use('/api', (_req, _res, next) => next(new ApiError(404, 'This action was not found.')));
  const errorHandler: ErrorRequestHandler = (error: unknown, _req, res, _next) => {
    if (error instanceof EngineError) {
      res
        .status(
          [
            'CONSENT_REQUIRED',
            'AUTH_REQUIRED',
            'MODEL_UNAVAILABLE',
            'STALE_STATUS',
            'NOT_INSTALLED',
            'UNSUPPORTED_VERSION',
            'ACCOUNT_CHANGED',
          ].includes(error.code)
            ? 409
            : 503,
        )
        .json({ error: error.message, code: error.code, ambiguous: error.ambiguous });
      return;
    }
    if (error instanceof ApiError) {
      res.status(error.status).json({ error: error.message, ...error.details });
      return;
    }
    if (
      error instanceof SyntaxError ||
      (error instanceof Error && 'type' in error && error.type === 'entity.too.large')
    ) {
      res.status(400).json({ error: 'The request is not valid JSON or is too large.' });
      return;
    }
    if (absent(error)) {
      res.status(404).json({ error: 'The requested folder or file does not exist.' });
      return;
    }
    console.error(error);
    res.status(500).json({
      error: 'The local service could not complete this action. Your saved history is preserved.',
    });
  };
  app.use(errorHandler);
  app.locals.store = store;
  app.locals.work = work;
  app.locals.nativeWork = nativeWork;
  app.locals.harness = harness;
  app.locals.connections = connections;
  app.locals.close = async () => {
    engines.close();
    await login.close();
    await connections.close();
    await harness.close();
    await work.close();
    await nativeWork.close();
  };
  return app;
}
