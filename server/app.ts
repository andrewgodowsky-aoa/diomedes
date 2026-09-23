import { parseApprovalCommand } from './approval-admission.js';
import { taskDocumentProblem } from '../shared/task-sources.js';
import { mountPermissionRoutes } from './permission-routes.js';
import { WorkspaceService } from './workspaces.js';
import { mountWorkspaceRoutes } from './workspace-routes.js';
import { ThemeService, THEME_PACK_ID_PATTERN, THEME_SCOPE_PATTERN } from './themes.js';
import { mountThemeRoutes } from './theme-routes.js';
import { CustomizationGate } from './customization-gate.js';
import { CustomizationBenefitLedger } from './customization-benefit.js';
import { mountCustomizationBenefitRoutes } from './customization-benefit-routes.js';
import { ConfigurationService } from './configuration.js';
import { mountConfigurationRoutes } from './configuration-routes.js';
import { DiscoveryService } from './discovery/service.js';
import { mountDiscoveryRoutes } from './discovery/routes.js';
import { WeeklyBriefService } from './weekly-brief.js';
import { browseImports, inspectImport, importExports } from './file-imports.js';
import { isActiveMember } from '../shared/workspaces.js';
import { AllowanceLedger } from './managed-usage.js';
import { ManagedGateway } from './managed-gateway.js';
import { BillingEventProcessor } from './billing-events.js';
import { mountManagedUsageRoutes } from './managed-usage-routes.js';
import { directOrigin, applicationOrigin } from '../shared/attribution.js';
import express, { type ErrorRequestHandler, type Request, type Response } from 'express';
import fs from 'node:fs/promises';
import path from 'node:path';
import { timingSafeEqual } from 'node:crypto';
import { spawn } from 'node:child_process';
import type {
  Conversation,
  ConversationLineage,
  EngineModel,
  Mode,
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
import { activatePack, deactivatePack, discoverInstructionFiles } from './capability-packs.js';
import {
  CAPABILITY_PACK_IDS,
  CAPABILITY_PACKS,
  isCapabilityPackId,
} from '../shared/capability-packs.js';
import {
  defaults,
  findTasks,
  hash,
  HOME_REFUSES_WORK,
  identifier,
  now,
  Store,
  threadNameFromText,
} from './store.js';
import { buildSupportBundle, renderSupportBundle } from './support-bundle.js';
import { currentBuildIdentity } from './build-identity.js';
import { WorkService } from './work.js';
import { NativeWorkService, type NativeGenerator } from './native-work.js';
import { ChangeReviewService } from './change-review/service.js';
import {
  askCodex,
  closeWarmCodex,
  getIntegrationStatuses,
  type NativeTeamOptions,
} from './integrations.js';
import { MODES, modeOf } from './modes.js';
import { fakeCodexSnapshot, usageService } from './usage.js';
import { engineCatalog, isKnownChoice } from './models.js';
import { ReviewerService, type ReviewerAdapter } from './trust/reviewer.js';
import { codexReviewerAdapter } from './trust/codex-reviewer.js';
import { AgentRegistry } from './agents.js';
import { AUTO_AGENT, agentCompatibility } from '../shared/agents.js';
import { effortFor } from '../shared/effort.js';
import {
  DEFAULT_WORK_STYLE,
  chooseWorkStyleSentence,
  isWorkStyle,
  resolveWorkStyle,
  type WorkStyle,
} from '../shared/work-style.js';
import type { UsageSnapshot } from '../shared/types.js';
import { mountTeamRoutes } from './team/routes.js';
import { createHarnessHost } from './harness/host.js';
import { mountHarnessRoutes } from './harness/routes.js';
import { localHarnessPrincipal } from './harness/bridge.js';
import { TEXT_DISPATCH_STEP, textRunId } from './harness/text-route.js';
import {
  previewSink,
  type ToolActivity,
  type TransientPreview,
} from '../shared/adapter-contract.js';
import { FIXTURE_ENGINE } from './harness/approval.js';
import { CODEX_ENGINE, type ResolveHarnessAuthority } from './harness/codex-engine.js';
import { roleInstructions } from './team/prompts.js';
import { parseWorkCommand, validateWorkCommandId } from './work-admission.js';
import { parseTaskCommand } from './task-admission.js';
import { WorkControl } from './work-control.js';
import { DesktopConnections } from './connections/desktop.js';
import { toastConnector } from './connections/fixture.js';
import { compiledConnectionDemoConnectors } from './connections/compiler-demo.js';
import { digest as evidenceDigest, HarnessError } from './harness/policy.js';
import { mountReadinessRoutes } from './readiness/routes.js';
import { loadShippedProductKnowledge } from './readiness/instructions.js';
import packageInfo from '../package.json' with { type: 'json' };
import {
  EXTERNAL_ENGINES,
  ENGINE_NAMES,
  isExternalEngine,
  isRoute,
  isConversationRoute,
  ROUTES,
  routeDisplayName,
  type EngineConnection,
} from '../shared/engines.js';
import { EngineService, HOST_TEST_PROJECT } from './engines/service.js';
import { mountClaudeSessionRoutes } from './engines/claude-session-routes.js';
import { loadApprovedReadServers, type ReadScope } from './engines/read-scope.js';
import { mountInteractionRoutes } from './engines/interaction-routes.js';
import {
  InteractionTurns,
  narrower,
  type AdmissionSource,
  type InteractionHost,
} from './interaction-service.js';
import { admitInteraction } from './interaction-admission.js';
import {
  blockedMessage,
  commandBinding,
  decideWith,
  instructionsFor,
  previewGate,
  promptFor,
  restrictionOf,
  sourceMessageIdFor,
} from './interaction-turn.js';
import { assertReplay, findCommand } from './command-admission.js';
import { claudeSessionRunId } from './harness/claude-session-run.js';
import { modelSessionRunId } from './harness/model-session-run.js';
import { FileModelTranscripts } from './harness/model-transcripts.js';
import { AWS_BEDROCK_ROUTE, AwsConnections } from './engines/aws-bedrock.js';
import { AZURE_OPENAI_ROUTE, AzureConnections } from './engines/azure-openai.js';
import { OPENROUTER_ROUTE, OpenRouterConnections } from './engines/openrouter.js';
import { mountModelApiRoutes } from './engines/model-api-routes.js';
import { ConnectionSecrets, type SecretBox } from './connection-secrets.js';
import { SpendExposure } from './spend-exposure.js';
import { isModelApiRoute, MODEL_API_NAMES, MODEL_API_ROUTES } from '../shared/model-api.js';
import { baselineRedact } from './secrets.js';
import { EngineError } from './engines/process.js';
import { selectedEngine, selectedModel } from '../shared/ai-selection.js';
import { projectedTurnIds, turnIdentityText } from '../shared/conversation-turn-id.js';
import { AppUpdateService, mountAppUpdateRoutes, type UpdateTransport } from './app-updates.js';
import { EngineInstaller } from './engines/install.js';
import { NativeLogin } from './engines/login.js';
import { changeCloudSharing, cloudSharing, requireCloudSharing } from './cloud-sharing.js';
import { assembleSkillSection, instructionSectionBudget } from './harness/instruction-delivery.js';

interface AppOptions {
  dataDir: string;
  /** Fresh per-launch secret held by the desktop main process, never persisted. */
  loopbackToken?: string;
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
  /** How a native sign-in window is opened; tests pass a fake so none opens. */
  nativeLoginLaunch?: ConstructorParameters<typeof NativeLogin>[1];
  harnessAuthority?: ResolveHarnessAuthority;
  /** Lease TTL for external text-turn runs; tests shorten it to exercise takeover. */
  harnessTextLeaseMs?: number;
  /**
   * OS-protected sealing for model-API credentials. The desktop shell passes Electron's
   * safeStorage; without it no credential can be saved and setup says so.
   */
  secretBox?: SecretBox | null;
  /** Tests replace the network below the SDK here. Production leaves it unset. */
  modelApiTransport?: typeof globalThis.fetch;
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
/** A run that has not finished: the same three states the rest of the server uses. */
const ACTIVE_SESSION_STATES = ['queued', 'working', 'waiting'];
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
/** What one request says about itself, for a WorkStyle to read. Never a permission. */
interface RunHints {
  mode?: Mode;
  text?: string | null;
  /** A model-API conversation binds its level into saved context: style and mode only. */
  stableEffort?: boolean;
}
/** The model and level one request is sent with, and who chose them. */
interface RunChoice {
  model?: string;
  effort?: string;
  selection?: 'automatic' | 'runtime-default';
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
  // `activeWorkspace` and `home` are deliberately absent from every branch
  // below. The clone above keeps whatever is stored, so a client that echoes
  // the whole settings object back cannot move itself into a business
  // workspace, and cannot rebind Diomedes' own conversation: only
  // POST /api/workspace/switch writes the first, after checking membership, and
  // only the home provisioner writes the second. Do not add a branch here that
  // reads `supplied.activeWorkspace` or `supplied.home`.
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
    if (value.textureOff !== undefined) {
      if (typeof value.textureOff !== 'boolean')
        throw new ApiError(400, 'Texture must be on or off.');
      result.appearance.textureOff = value.textureOff;
    }
    // Shape only. Whether the theme still exists, still validates, or was
    // written by this install is decided when it is read, by the theme service
    // and its fallback — not here, where a stale pointer would become a saved
    // settings failure instead of a notice.
    if (value.activeTheme !== undefined) {
      if (value.activeTheme === null) result.appearance.activeTheme = null;
      else {
        const theme = plain(value.activeTheme);
        for (const key of Object.keys(theme))
          if (!['id', 'revision', 'scope'].includes(key))
            throw new ApiError(400, `Unknown active theme field: ${key}`);
        if (typeof theme.id !== 'string' || !THEME_PACK_ID_PATTERN.test(theme.id))
          throw new ApiError(400, 'That theme name is not one this computer can store.');
        if (
          typeof theme.revision !== 'number' ||
          !Number.isInteger(theme.revision) ||
          theme.revision < 1
        )
          throw new ApiError(400, 'A theme revision is a whole number from 1 up.');
        // Shape only, and never stamped here: the theme routes own which scope
        // a pointer was written in. A pointer sent without one is a pointer
        // written before scopes were recorded, and stays that way.
        if (theme.scope !== undefined && !THEME_SCOPE_PATTERN.test(String(theme.scope)))
          throw new ApiError(400, 'That theme scope is not one this computer writes.');
        result.appearance.activeTheme = {
          id: theme.id,
          revision: theme.revision,
          ...(theme.scope === undefined ? {} : { scope: String(theme.scope) }),
        };
      }
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
      // The WorkStyle a thread follows when it names none. A style is not a
      // switch and grants nothing; only the three names are accepted.
      if (key === 'workStyle') {
        if (!isWorkStyle(on)) throw new ApiError(400, chooseWorkStyleSentence());
        services[key] = on;
        continue;
      }
      if (
        ['codex', ...EXTERNAL_ENGINES, ...MODEL_API_ROUTES].some(
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
  if (options.loopbackToken !== undefined && !/^[0-9a-f]{64}$/.test(options.loopbackToken))
    throw new Error('The desktop local-service token is invalid.');
  const store = new Store(path.resolve(options.dataDir), options.projectRoot, options.secretBox ?? null);
  await store.init();
  // Automatic Change Review: deterministic per-run evidence. Constructed before
  // the work services so every run can capture its baseline from the start.
  const changeReview = new ChangeReviewService(store);
  await changeReview.init();
  const work = new WorkService(store, options.stepMs, changeReview);
  const engines =
    options.engineService ??
    new EngineService(path.join(store.dataDir, 'engines'), {
      redactFor: () => baselineRedact,
      // A staged failure names the build it happened in, so a stale shortcut or
      // an older installed copy shows up in the first support report.
      buildId: () => currentBuildIdentity(packageInfo.version).buildId,
    });
  const installer = new EngineInstaller(engines.root);
  // A finished native sign-in is not evidence of an account. The window ending
  // only asks for one fresh inspection, and what that inspection answers is what
  // the screen shows.
  let closing = false;
  const login = new NativeLogin(engines.root, options.nativeLoginLaunch, {
    onFinished: async (engine) => {
      if (closing) return;
      // A check that began before the sign-in finished cannot know about it, so
      // it is never allowed to be the last word: wait for it, then look again.
      await engines.settled(engine);
      if (closing) return;
      try {
        await engines.check(engine);
      } catch (error) {
        // A failed check has already written its own detail onto the connection,
        // and REQUEST_ACTIVE only means a newer check for this route is running.
        if (!(error instanceof EngineError && error.code === 'REQUEST_ACTIVE')) noteError(error);
      }
    },
  });
  const reviewerAdapter =
    options.reviewerAdapter === undefined ? codexReviewerAdapter() : options.reviewerAdapter;
  const agents = new AgentRegistry(store.dataDir);
  // Organizations, membership and the Business intake. Identity for them comes
  // from server/trust/, whose production backend is not installed, so what this
  // creates is a labelled local fixture rather than a hosted organization.
  const workspaces = new WorkspaceService(store);
  await workspaces.init();
  const discovery = new DiscoveryService(store, {
    verifyObservedEvidence: async ({ operatorId, evidence }) => {
      if (operatorId !== workspaces.currentPerson().id) return false;
      let state: ReturnType<Store['state']>;
      try {
        state = store.state(evidence.projectId);
      } catch (error) {
        if (error instanceof ApiError && error.status === 404) return false;
        throw error;
      }
      const entry = state.history.find((item) => item.id === evidence.historyEntryId);
      if (!entry) return false;
      if (evidence.kind === 'approved-file') {
        const name = relativeName(evidence.path);
        return (
          (entry.actor === 'you' || !!entry.approvalId || !!entry.authorization) &&
          entry.files.some(
            (file) => file.path === name && file.recorded && file.after === evidence.sha,
          ) &&
          hash(await store.current(evidence.projectId, name)) === evidence.sha
        );
      }
      return (
        entry.sessionId === evidence.executionId &&
        state.sessions.some(
          (session) => session.id === evidence.executionId && session.state === 'done',
        )
      );
    },
  });
  // Design Studio storage. It reads the *live* workspace rather than the stored
  // reference, so a revoked business member reads their Personal themes and not
  // the ones they can no longer see.
  const themes = new ThemeService(store, {
    workspace: () => workspaces.active(),
    personId: () => workspaces.currentPerson().id,
  });
  // Who may change how this app looks. It reads the same live workspace the
  // storage does, so the scope a mutation is checked against is the scope it
  // would be written to. `DIOMEDES_DESIGN_AUTHORING` is read once, here, from
  // the environment the service was launched in.
  const customization = new CustomizationGate({
    workspace: () => workspaces.active(),
    personId: () => workspaces.currentPerson().id,
    membershipOf: (organizationId, personId) => workspaces.membershipOf(organizationId, personId),
    entitlementOf: (organizationId) => workspaces.entitlementOf(organizationId),
  });
  // The one design engagement a paid plan includes, recorded beside the
  // billing records because it is a promise with money behind it.
  const customizationBenefit = new CustomizationBenefitLedger(store);
  await customizationBenefit.init();
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
    billingStatusFor: (organizationId) => billing.statusOf(organizationId),
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
        if (input.projectId && input.engine)
          requireCloudSharing(store.state(input.projectId), input.engine, [
            ...input.documents.map((doc) => doc.path),
            ...(input.sharingPaths ?? []),
          ]);
        if (isModelApiRoute(input.engine)) {
          if (!input.projectId || !input.threadId || !input.requestId || !input.model)
            throw new ApiError(409, 'Select a model and thread before requesting work.');
          if (typeof input.accountRoute !== 'string')
            throw new ApiError(409, 'Connect this route in AI setup first.');
          return engines.generateModelApi(input.engine, {
            ...input,
            projectId: input.projectId,
            threadId: input.threadId,
            requestId: input.requestId,
            model: input.model,
            instructions: input.instructions ?? '',
            accountRoute: input.accountRoute,
          });
        }
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
          // A work run's requestId is its session id, which is how its run card finds these.
          onActivity: (frame) => store.emit('engine-activity', frame),
        });
      }),
    reviewer,
    agents,
    changeReview,
  );
  const harness = createHarnessHost({
    store,
    dataDir: store.dataDir,
    currentAuthority: options.harnessAuthority,
    textLeaseMs: options.harnessTextLeaseMs,
  });
  // External text turns run through the host's RunService: the adapter is only
  // the provider transport inside the fenced dispatch step.
  engines.dispatch = (request) => {
    const intent = request.intent as { projectId?: unknown; engine?: unknown; documents?: unknown };
    if (intent.projectId !== HOST_TEST_PROJECT) {
      if (
        typeof intent.projectId !== 'string' || !isRoute(intent.engine) ||
        !Array.isArray(intent.documents) ||
        !intent.documents.every((doc) => doc && typeof doc === 'object' && typeof doc.path === 'string')
      ) throw new ApiError(403, 'This cloud request has no valid project sharing scope.');
      const names = intent.documents.map((doc: { path: string }) => doc.path);
      requireCloudSharing(store.state(intent.projectId), intent.engine, names);
      return harness.textRoute.request({
        ...request,
        send: (context, admission) => {
          requireCloudSharing(store.state(intent.projectId as string), intent.engine as Route, names);
          return request.send(context, admission);
        },
      });
    }
    return harness.textRoute.request(request);
  };
  engines.nativeSessions = harness.claudeSessions;
  engines.modelSessions = harness.modelSessions;
  const exposure = new SpendExposure(store.dataDir);
  await exposure.init();
  engines.modelApi = {
    connections: new AwsConnections(store.dataDir),
    secrets: new ConnectionSecrets(store.dataDir, options.secretBox ?? null),
    exposure,
    transcripts: new FileModelTranscripts(path.join(store.dataDir, 'model-transcripts'), AWS_BEDROCK_ROUTE),
    transport: options.modelApiTransport,
    // Each route keeps its own connection record and private transcripts: funds, data terms
    // and provider continuation state are never shared between payers.
    azure: {
      connections: new AzureConnections(store.dataDir),
      transcripts: new FileModelTranscripts(
        path.join(store.dataDir, 'model-transcripts-azure-openai'),
        AZURE_OPENAI_ROUTE,
      ),
    },
    openrouter: {
      connections: new OpenRouterConnections(store.dataDir),
      transcripts: new FileModelTranscripts(
        path.join(store.dataDir, 'model-transcripts-openrouter'),
        OPENROUTER_ROUTE,
      ),
    },
  };
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
    projectId: string,
    threadId: string | undefined,
    // The socket is the listening service, even when listen(0) selected the port.
    port: number | undefined,
  ): NativeTeamOptions | undefined => {
    if (!threadId) return undefined;
    const state = store.state(projectId);
    const member = state.team?.members.find(
      (item) => item.threadId === threadId && item.engine === 'codex',
    );
    if (!member) return undefined;
    return teamForMember(projectId, member, port);
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
  const loopbackToken = options.loopbackToken
    ? Buffer.from(options.loopbackToken, 'hex')
    : null;
  const origins = new Set([`http://127.0.0.1:${port}`, `http://127.0.0.1:${clientPort}`]);
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    if (req.socket.localPort) listeningPort = req.socket.localPort;
    const teamRequest = req.path.startsWith('/mcp/team/');
    const origin = req.headers.origin;
    const host = req.headers.host;
    if (!host || !/^127\.0\.0\.1:\d+$/.test(host))
      return next(new ApiError(403, 'This service accepts connections on 127.0.0.1 only.'));
    if (origin && !origins.has(origin))
      return next(new ApiError(403, 'This page cannot access the local service.'));
    // Team helpers use their own scoped bearer token, but must still obey the
    // same loopback Host and browser-Origin boundary as the desktop UI.
    if (teamRequest) return next();
    if (loopbackToken) {
      const supplied = req.headers['x-diomedes-session'];
      if (
        typeof supplied !== 'string' ||
        !/^[0-9a-f]{64}$/.test(supplied) ||
        !timingSafeEqual(Buffer.from(supplied, 'hex'), loopbackToken)
      )
        return next(new ApiError(401, 'This local-service session is not authorized.'));
    }
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
  mountThemeRoutes(app, store, themes, customization);
  mountCustomizationBenefitRoutes(app, store, workspaces, customization, customizationBenefit);
  mountManagedUsageRoutes(app, store, ledger, gateway, billing, workspaces);
  mountConfigurationRoutes(app, store, workspaces, configuration, agents);
  mountDiscoveryRoutes(app, discovery, {
    operatorId: () => workspaces.currentPerson().id,
    importDocument: async (_req, input) => {
      const name = relativeName(input.path);
      const state = store.state(input.projectId);
      const imported =
        name.startsWith('Imports/') &&
        state.history.some(
          (entry) =>
            entry.actor === 'you' &&
            entry.label === 'Imported exports' &&
            entry.files.some(
              (file) =>
                file.path === name &&
                file.op === 'created' &&
                file.recorded &&
                file.after === input.sha,
            ),
        );
      if (!imported) throw new ApiError(403, 'Choose a research file imported through Files.');
      const document = await store.readDocument(input.projectId, name);
      if (document.sha !== input.sha || document.text === null)
        throw new ApiError(409, 'The research file changed. Select its current version again.');
      return { filename: name, content: document.text };
    },
    exportToProject: async (_req, artifact, projectId) => {
      store.state(projectId);
      const destination = `Discovery/${artifact.prospectId}/${identifier('record')}.md`;
      const entry = await store.writeRecorded(
        projectId,
        [
          {
            path: destination,
            text: artifact.text,
            expected: null,
          },
        ],
        {
          actor: 'you',
          kind: 'discovery-export',
          merge: false,
          label: 'Discovery record',
          sentence: 'You exported the active discovery record.',
        },
      );
      return { id: entry.id, path: destination, createdAt: entry.time };
    },
  });
  connections.mount(app);
  mountReadinessRoutes(app, {
    knowledge: () => loadShippedProductKnowledge({ buildVersion: packageInfo.version }),
    snapshot: async (req) => {
      const projectId = req.query.projectId;
      if (projectId !== undefined && (typeof projectId !== 'string' || !projectId))
        throw new ApiError(400, 'Choose one project for connection readiness.');
      // Cached snapshots never arm a connector or probe an engine.
      const saved = projectId ? connections.service.snapshot(projectId).connections : null;
      return {
        build: { version: packageInfo.version, source: 'package.json' },
        settings: { services: { ...store.settings.services }, observedAt: now() },
        engines: engines.status(),
        connectors: {
          manifests: [toastConnector, ...compiledConnectionDemoConnectors].map(({ manifest }) => ({
            manifest,
            digest: evidenceDigest(manifest),
          })),
          instances: saved?.instances ?? [],
          // Bind only exact processed receipts; legacy observations lack generation.
          observations: saved
            ? saved.inbox
                .filter(
                  (event) =>
                    event.state === 'processed' &&
                    evidenceDigest(
                      saved.observations[
                        evidenceDigest([
                          event.connectionId,
                          event.observation.resourceId,
                          event.observation.key,
                        ])
                      ] ?? null,
                    ) === evidenceDigest(event.observation),
                )
                .map((event) => ({
                  connectionId: event.connectionId,
                  generation: event.generation,
                  projectId: projectId as string,
                  observation: event.observation,
                }))
            : [],
        },
      };
    },
  });
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
  /**
   * The last few errors the service logged, for the support bundle. Messages
   * only, capped, and scrubbed again on the way out; a stack is a developer's
   * tool and this is a person's.
   */
  const recentErrors: string[] = [];
  const noteError = (error: unknown) => {
    const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    recentErrors.push(`${now()} ${message}`.slice(0, 500));
    if (recentErrors.length > 20) recentErrors.shift();
  };
  /**
   * What a person may paste into a support request. Everything is scrubbed
   * against the team secrets of the project named, if any, and the bundle
   * itself lists what it leaves out. Read-only; no lock needed.
   */
  app.get(
    '/api/support/bundle',
    route(async (req) => {
      const projectId = typeof req.query.project === 'string' ? req.query.project : null;
      let state = null;
      let secrets: string[] = [];
      if (projectId) {
        try {
          state = store.state(projectId);
          secrets = Object.values(await store.readTeamSecrets(projectId));
        } catch {
          state = null;
        }
      }
      const bundle = buildSupportBundle({
        version: packageInfo.version,
        dataDir: store.dataDir,
        projectRoot: store.projectRoot,
        port,
        engines: await getIntegrationStatuses({ refresh: false, passive: true }),
        // Cached observations only: a support export never starts a scan.
        connections: engines.status(),
        services: store.settings.services,
        // The name is the identifying part, so it travels only when asked for.
        includeProjectName: req.query.projectName === '1',
        state,
        recentErrors,
        secrets,
      });
      return { bundle, text: renderSupportBundle(bundle) };
    }, false),
  );
  /**
   * The expected-hash write guard for settings.
   *
   * Two AI-setup controls write settings by different routes, and a
   * whole-object PUT built from a screen's snapshot silently discards whatever
   * landed after that snapshot was taken — `validateSettings` replaces
   * `services` wholesale, so an On switch and a "Use as default" pressed close
   * together lose one of the two. The stored settings therefore carry their own
   * content hash as an ETag. A caller that echoes it back in `If-Match` is
   * refused with 409 when the stored settings have moved, and the refusal
   * carries the saved settings so the caller re-applies its one change to the
   * current truth. A caller that sends no `If-Match` is unguarded, exactly as
   * before, so this adds a guarantee without taking one away.
   */
  const settingsTag = (value: Settings) => `"${hash(JSON.stringify(value)) ?? ''}"`;
  const withSettingsTag = (res: Response, value: Settings) => {
    res.setHeader('ETag', settingsTag(value));
    return value;
  };
  app.get(
    '/api/settings',
    route(async (_req, res) => withSettingsTag(res, store.settings)),
  );
  app.put(
    '/api/settings',
    route(async (req, res) => {
      const expected = req.headers['if-match'];
      if (typeof expected === 'string' && expected !== settingsTag(store.settings))
        throw new ApiError(
          409,
          'Settings changed while this screen was saving. The saved settings were reloaded.',
          {
            code: 'settings_conflict',
            settings: store.settings,
            etag: settingsTag(store.settings),
          },
        );
      return withSettingsTag(
        res,
        await store.saveSettings(validateSettings(store.settings, req.body)),
      );
    }),
  );
  const externalEngine = (req: Request) =>
    choice(String(req.params.engine), EXTERNAL_ENGINES, 'engine');
  const connectionSignal = (res: Response) => {
    const controller = new AbortController();
    // A client that left before this was asked for has already fired 'close'.
    if (res.closed && !res.writableEnded) controller.abort();
    else
      res.once('close', () => {
        if (!res.writableEnded) controller.abort();
      });
    return controller.signal;
  };
  // The next action is derived on the host, beside the facts it rests on: the
  // On switch lives in settings and the guided installer knows its platforms.
  const withNextAction = (connections: EngineConnection[]): EngineConnection[] =>
    connections.map((connection) => ({
      ...connection,
      nextAction: engines.nextAction(connection.engine, {
        enabled: store.settings.services?.[connection.engine] === true,
        installSupported: installer.offer(connection.engine).available,
      }),
      // Whether a native sign-in window Diomedes opened is still open, so a
      // screen can wait for its check instead of asking for one.
      signInWindow: login.state(connection.engine),
    }));
  app.get(
    '/api/ai/status',
    route(async () => ({ connections: withNextAction(engines.status()) }), false),
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
      return { connections: withNextAction(await engines.discover(true)) };
    }, false),
  );
  app.post(
    '/api/ai/check/:engine',
    route(async (req, res) => {
      const checked = await engines.check(externalEngine(req), connectionSignal(res));
      return withNextAction([checked])[0];
    }, false),
  );
  /**
   * Choose which observed installation a route uses. A candidate id names
   * something the host itself observed; a path from the screen is never bound.
   */
  app.post(
    '/api/ai/bind',
    route(async (req) => {
      const b = body(req),
        engine = choice(b.engine, EXTERNAL_ENGINES, 'engine');
      // `<source>:<engine>:<canonical path>`: at most 20 characters of prefix and
      // a Windows path of up to 32,767 units, which a long-path install can have.
      // The id is only ever compared with ids the host itself produced.
      const bound = await engines.bind(engine, asString(b.candidateId, 'an installation', 32_787));
      return withNextAction([bound])[0];
    }, false),
  );
  /**
   * One real request, on the person's say-so. It may use their allowance or
   * incur provider charges, so nothing calls it for them: not a scan, not a
   * finished sign-in, not reopening Settings.
   */
  app.post(
    '/api/ai/test/:engine',
    route(async (req, res) => {
      const engine = externalEngine(req),
        b = body(req);
      if (b.consent !== true)
        throw new ApiError(
          409,
          'Confirm that this test sends one small request through your selected service first.',
        );
      const model = asString(b.model, 'a model', 120);
      // A receipt verifies the route a run would take, so the model tested is
      // the model selected — never one the screen names on its own.
      if (model !== store.settings.services?.[`${engine}Model`])
        throw new ApiError(409, 'Select this model in AI setup before testing it.');
      const receipt = await engines.testConnection(engine, {
        consent: true,
        model,
        signal: connectionSignal(res),
      });
      const connection = engines.status().find((c) => c.engine === engine)!;
      return { receipt, connection: withNextAction([connection])[0] };
    }, false),
  );
  app.post(
    '/api/ai/select',
    route(async (req, res) => {
      const b = body(req),
        engine = choice(b.engine, EXTERNAL_ENGINES, 'engine');
      const selected = engines.selection(engine, asString(b.model, 'a model', 120));
      return withSettingsTag(
        res,
        await store.saveSettings({
          ...store.settings,
          services: {
            ...store.settings.services,
            defaultEngine: engine,
            [engine]: true,
            [`${engine}Model`]: selected.model,
            [`${engine}AccountRoute`]: selected.accountRoute,
          },
        }),
      );
    }),
  );
  /**
   * The engine On switch. It exists as its own route so the read-modify-write
   * happens here, under the same store lock `/api/ai/select` holds, rather than
   * on a screen that must first guess what the rest of settings currently says.
   * Turning an engine on or off then commutes with choosing its default model:
   * neither can lose the other, in either order, at any speed. The switch is a
   * preference and never a readiness claim — `EngineService.generate()` still
   * rechecks installation, version, sign-in and the model before anything is
   * sent, and refuses when the account cannot answer.
   */
  app.post(
    '/api/ai/enabled',
    route(async (req, res) => {
      const b = body(req),
        engine = choice(b.engine, EXTERNAL_ENGINES, 'engine');
      if (typeof b.on !== 'boolean') throw new ApiError(400, 'Provide on as true or false.');
      return withSettingsTag(
        res,
        await store.saveSettings({
          ...store.settings,
          services: { ...store.settings.services, [engine]: b.on },
        }),
      );
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
      // Installing one route is a question about one route, so only it is scanned.
      const found = (await engines.discover(true, { engine })).find((c) => c.engine === engine)!;
      // Found is not usable. A wrong-version, changed or corrupt installation
      // still needs the private compatible copy; only a usable one is reused.
      const usable =
        found.installation === 'found' && found.compatibility === 'supported' && !found.repair;
      if (usable)
        return {
          detail:
            'An installation already exists. Diomedes will reuse it. Check compatibility and sign-in.',
        };
      // A private copy that failed its digest needs the repair path even when
      // another installation sits beside it and the route reads as unsupported.
      const result = await installer.install(engine, true, connectionSignal(res), {
        repair:
          found.installation === 'corrupt' ||
          (found.candidates ?? []).some((c) => c.source === 'managed' && c.integrity === 'failed'),
      });
      await engines.discover(true, { engine });
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
    // The reserved home Project is not one of the person's projects and is
    // never listed. The filter lives here and never in `Store.projects()`,
    // which startup recovery enumerates to recover saved runs, home
    // conversations included.
    route(async () => ({
      projects: (await store.projects()).filter((project) => !store.isHomeProject(project.id)),
    })),
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
  app.get(
    '/api/projects/:id/cloud-sharing',
    route(async (req) => cloudSharing(store.state(id(req)))),
  );
  app.put(
    '/api/projects/:id/cloud-sharing',
    route(async (req) => {
      const projectId = id(req);
      const state = store.state(projectId);
      const candidate = structuredClone(state);
      const policy = changeCloudSharing(candidate, body(req));
      state.cloudSharing = policy;
      await store.persist(state);
      return policy;
    }),
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
    '/api/projects/:id/imports/browse',
    route(async (req) => {
      store.state(id(req));
      return browseImports(
        typeof req.query.path === 'string' && req.query.path.trim()
          ? req.query.path
          : store.projectRoot,
      );
    }),
  );
  app.post(
    '/api/projects/:id/imports/inspect',
    route(async (req) => {
      store.state(id(req));
      return inspectImport(body(req).path);
    }),
  );
  app.post(
    '/api/projects/:id/imports',
    route(async (req) => importExports(store, id(req), body(req).files)),
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
  /**
   * Capability packs for one Project.
   *
   * Activation is a Project-level record and nothing more: no grant, no Need,
   * no permission changes here (`AGENTS.md` decision 14). The listing carries
   * the manifests so the person reads what a pack would use before deciding,
   * and the instruction records so what discovery found is inspectable rather
   * than a hidden behaviour change.
   */
  const packId = (req: Request) => {
    const value = String(req.params.packId);
    if (!isCapabilityPackId(value)) throw new ApiError(404, 'This capability pack does not exist.');
    return value;
  };
  app.get(
    '/api/projects/:id/packs',
    route(async (req) => ({
      packs: CAPABILITY_PACK_IDS.map((id) => CAPABILITY_PACKS[id]),
      activations: store.state(id(req)).project.packs ?? [],
      instructionFiles: await discoverInstructionFiles(store, id(req)),
    })),
  );
  app.post(
    '/api/projects/:id/packs/:packId/activate',
    route(async (req) => {
      const state = await activatePack(store, id(req), packId(req));
      return {
        activations: state.project.packs ?? [],
        instructionFiles: state.instructionFiles ?? [],
      };
    }),
  );
  app.post(
    '/api/projects/:id/packs/:packId/deactivate',
    route(async (req) => {
      const state = await deactivatePack(store, id(req), packId(req));
      return {
        activations: state.project.packs ?? [],
        instructionFiles: state.instructionFiles ?? [],
      };
    }),
  );
  /**
   * Read one discovered instruction file, as Diomedes read it.
   *
   * Only a path discovery actually recorded is served. That is what keeps the
   * route from becoming a second way to read the project folder: the guard in
   * `server/paths.ts` still decides what may be opened, and this decides only
   * whether the file is one of the ones already on the record.
   */
  app.get(
    '/api/projects/:id/instructions/read',
    route(async (req) => {
      const projectId = id(req);
      const wanted = asString(req.query.path, 'an instruction file path', 1000);
      const record = (store.state(projectId).instructionFiles ?? []).find(
        (item) => item.path === wanted,
      );
      if (!record)
        throw new ApiError(404, 'That file is not one of the instruction files in this project.');
      return store.readDocument(projectId, record.path);
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
  /**
   * Home is a conversation container, never a work destination. Both admission paths say so
   * before they read a command. What holds for every route is `Store.createTask`, which makes
   * no task there: review r6 found the direct route going round these two.
   */
  const refuseHomeWork = (projectId: string) => {
    if (store.isHomeProject(projectId)) throw new ApiError(409, HOME_REFUSES_WORK);
  };
  /**
   * The task route's own creation path, called with the store lock held. A task proposed from
   * a conversation is made by calling exactly this with the command id derived for that
   * message, so the protocol check, the receipt replay and the journal entry are the ones a
   * person's task goes through. Nothing here is duplicated elsewhere.
   */
  const createTaskFrom = async (projectId: string, b: Record<string, unknown>) => {
    refuseHomeWork(projectId);
    const state = store.state(projectId);
    const command = parseTaskCommand(b);
    if (command) {
      // A replay answers before validation: the admitted task is the evidence.
      const replay = store.taskCommand(
        projectId,
        command.admission.commandId,
        command.admission.payloadDigest,
      );
      if (replay) return replay;
    }
    // The document is checked against a fresh listing on both the versioned and the
    // unversioned path, before anything is created.
    const requested = command ? command.input.sourceDocument : b.sourceDocument;
    const sourceDocument = requested === undefined ? undefined : relativeName(requested);
    if (sourceDocument !== undefined) {
      if (sourceDocument.length > 1000)
        throw new ApiError(400, 'Select a project document with a shorter path.');
      const problem = taskDocumentProblem(sourceDocument, await store.listDocuments(projectId));
      if (problem) throw new ApiError(400, problem);
    }
    const task = store.createTask(state, {
      ...(command?.input ?? {
        name: asString(b.name, 'a task name', 200),
        description: typeof b.description === 'string' ? b.description.slice(0, 10000) : '',
        owner: b.owner === undefined ? 'you' : choice(b.owner, owners, 'owner'),
      }),
      ...(sourceDocument !== undefined ? { sourceDocument } : {}),
    });
    const entry = store.addEntry(state, {
      kind: 'tasks-made',
      sentence: `You made a task: ${task.name}`,
      taskId: task.id,
    });
    if (command) {
      task.creationReceipt = {
        protocolVersion: 1,
        ...command.admission,
        projectId: state.project.id,
        taskId: task.id,
        eventId: entry.id,
        admittedAt: entry.time,
        actor: 'local-client',
        scope: 'local-prototype',
      };
    }
    await store.persist(state);
    return task;
  };
  app.post(
    '/api/projects/:id/tasks',
    route(async (req) => createTaskFrom(id(req), body(req))),
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
  /**
   * The Work start route's own admission path, called with the store lock held.
   * A queued follow-up is delivered by calling exactly this with the follow-up's
   * own command identity, so the protocol check, the consent check, the route
   * check, the receipt replay and the scope the task already has are the same
   * ones a person's Start goes through. Nothing here is duplicated elsewhere.
   */
  const admitWork = async (
    projectId: string,
    supplied: Record<string, unknown>,
    port: number | undefined,
    /**
     * The caller's ordering guard for the durable admission alone, where one supplied it.
     * The conversation passes the guard that holds its own source run; a person's Start
     * passes none and the two Work paths run exactly as they did.
     */
    commit?: <T>(step: () => Promise<T>) => Promise<T>,
  ) => {
    refuseHomeWork(projectId);
    if (isUpdateClosing())
      throw new ApiError(409, 'The app update is accepted. New work pauses until restart.');
    if (supplied.capabilityId !== undefined) {
      if (supplied.protocolVersion !== undefined || supplied.commandId !== undefined)
        throw new ApiError(400, 'Saved Work commands for native fixtures are not available yet.');
      return harness.bridge.start(
        projectId,
        supplied.taskId === null ? null : asString(supplied.taskId, 'a task', 100),
        asString(supplied.capabilityId, 'a capability', 100),
        asString(supplied.instruction, 'an instruction', 16000),
        localHarnessPrincipal(projectId),
      );
    }
    const command = parseWorkCommand(supplied);
    const b = command?.request ?? supplied;
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
    const team = teamForThread(projectId, threadId, port);
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
      requireCloudSharing(state, selectedRoute, b.sources.map(relativeName));
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
          { mode: 'build', text: typeof b.instruction === 'string' ? b.instruction : null },
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
        commit,
      });
    }
    return work.start(
      projectId,
      taskId,
      typeof b.instruction === 'string' ? b.instruction : '',
      b.demo === 'fault',
      { permission: threadPermission, admission: command?.admission, commit },
    );
  };
  /**
   * Stop scopes and the follow-up queue. Delivery goes through `admitWork`, the
   * Work start route's own path, so a follow-up can never reach the runtime by
   * a route a person's Start does not take, and can never widen what the task
   * already has.
   */
  const workControl = new WorkControl({
    store,
    native: nativeWork,
    admit: (projectId, command) => admitWork(projectId, command, listeningPort),
    stopSession: (projectId, sessionId) =>
      serviceFor(projectId, sessionId).stop(projectId, sessionId),
    modelFor: (projectId, threadId, engine) => {
      if (engine === 'sample') return null;
      // A name for a queued follow-up. A style that would ask is answered when it is sent.
      try {
        return (
          nativeChoice(
            engine,
            projectId,
            store.state(projectId).conversations.find((c) => c.id === threadId),
          ).model ?? null
        );
      } catch {
        return null;
      }
    },
  });
  /**
   * The one trigger. A session reaching a terminal state and a task becoming
   * done both end in a durable write, and `persist` announces that write, so
   * this listens for it rather than polling or duplicating the half-dozen
   * places that can settle a run. It is a level check, not an edge: a turn has
   * ended when the task has run at least once and nothing of its is active.
   * The work itself is queued behind the lock rather than done inside it.
   */
  const deliveries = new Set<Promise<unknown>>();
  const delivering = new Set<string>();
  const again = new Set<string>();
  let deliveryClosed = false;
  const deliverFor = (projectId: string) => {
    if (deliveryClosed) return;
    if (delivering.has(projectId)) {
      again.add(projectId);
      return;
    }
    let tasks: string[];
    try {
      const current = store.state(projectId);
      tasks = [
        ...new Set(
          (current.followUps ?? [])
            .filter((item) => item.state === 'queued')
            .map((item) => item.taskId),
        ),
      ];
    } catch {
      return;
    }
    if (!tasks.length) return;
    delivering.add(projectId);
    const job = store
      .locked(async () => {
        for (const taskId of tasks) {
          const current = store.state(projectId);
          const task = current.tasks.find((item) => item.id === taskId && !item.deletedAt);
          if (!task) continue;
          const own = current.sessions.filter((session) => session.taskId === taskId);
          await workControl.deliverDue(projectId, {
            taskId,
            turnEnded:
              own.length > 0 &&
              !own.some((session) => ACTIVE_SESSION_STATES.includes(session.state)),
            taskDone: task.state === 'done',
          });
        }
      })
      .catch((error) =>
        console.error(
          'Could not deliver a queued follow-up:',
          error instanceof Error ? error.message : error,
        ),
      )
      .finally(() => {
        deliveries.delete(job);
        delivering.delete(projectId);
        if (again.delete(projectId)) deliverFor(projectId);
      });
    deliveries.add(job);
  };
  store.on('change', deliverFor);
  app.post(
    '/api/projects/:id/work/start',
    route(async (req) => admitWork(id(req), body(req), req.socket.localPort)),
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
  // Today's Stop, unchanged for the caller: it now runs through the `task`
  // scope, so it also cancels what that task had queued, and still answers with
  // the session.
  app.post(
    '/api/projects/:id/work/:sessionId/stop',
    route(async (req) => {
      const projectId = id(req);
      const sessionId = String(req.params.sessionId);
      const session = store.state(projectId).sessions.find((item) => item.id === sessionId);
      if (!session) throw new ApiError(404, 'This work session was not found.');
      await workControl.stop(projectId, {
        scope: 'task',
        taskId: session.taskId,
        sessionId,
      });
      return store.state(projectId).sessions.find((item) => item.id === sessionId) ?? session;
    }),
  );
  app.post(
    '/api/projects/:id/stop',
    route(async (req) => workControl.stop(id(req), body(req))),
  );
  app.get(
    '/api/projects/:id/follow-ups',
    route(async (req) => ({ followUps: workControl.list(id(req)) })),
  );
  app.post(
    '/api/projects/:id/follow-ups',
    route(async (req) => ({ followUp: await workControl.queue(id(req), body(req)) })),
  );
  app.post(
    '/api/projects/:id/follow-ups/reorder',
    route(async (req) => ({ followUps: await workControl.reorder(id(req), body(req)) })),
  );
  app.put(
    '/api/projects/:id/follow-ups/:fid',
    route(async (req) => ({
      followUp: await workControl.edit(id(req), String(req.params.fid), body(req)),
    })),
  );
  app.delete(
    '/api/projects/:id/follow-ups/:fid',
    route(async (req) => ({
      followUp: await workControl.remove(id(req), String(req.params.fid), 'you'),
    })),
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
  // Automatic Change Review: the deterministic per-run manifest, and the two
  // fixed Business examples running through the same pipeline.
  app.get(
    '/api/projects/:id/change-review/session/:sessionId',
    route(async (req) => ({
      manifest: await changeReview.manifestForSession(id(req), String(req.params.sessionId)),
    })),
  );
  app.get(
    '/api/projects/:id/change-review/task/:taskId',
    route(async (req) => ({
      manifest: await changeReview.manifestForTask(id(req), String(req.params.taskId)),
    })),
  );
  app.get(
    '/api/projects/:id/change-review/examples/:exampleId',
    route(async (req) => ({
      manifest: await changeReview.exampleManifest(String(req.params.exampleId), id(req)),
    })),
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
        b.engine === undefined &&
        b.workStyle === undefined
      )
        throw new ApiError(400, 'Provide a thread name, permission mode, mode or helper choice.');
      // Checked before any field is touched, so a refused style leaves nothing half applied.
      if (b.workStyle !== undefined && b.workStyle !== null && !isWorkStyle(b.workStyle))
        throw new ApiError(400, chooseWorkStyleSentence());
      // The home conversation runs on the routes a Diomedes conversation supports: Claude
      // Code or a model-API route. Anything else is refused before any field is touched, so a
      // request that also renames or narrows the Mode leaves nothing half applied. Its name,
      // Mode and permission stay its own. The same predicate guards the send path.
      if (b.engine !== undefined && store.isHomeProject(id(req)) && !isConversationRoute(b.engine))
        throw new ApiError(
          409,
          'The Diomedes conversation runs on Claude Code or AWS Bedrock. Its engine cannot be changed to that.',
        );
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
      // A style changes which offered model leads and how hard it reasons, from the next
      // request on. It never touches the mode, the permission or the route.
      if (b.workStyle !== undefined)
        conversation.workStyle = b.workStyle === null ? null : (b.workStyle as WorkStyle);
      if (b.engine !== undefined) {
        conversation.engine = engine;
        // A route the person picked is marked theirs: the conversation provisioners
        // re-pin only threads that were never deliberately routed.
        conversation.engineChoice = 'person';
      }
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
    // A model chosen for this thread is never swapped for another. When ChatGPT's own list
    // no longer offers it, the person is asked rather than given the account default.
    if (
      chosen?.model &&
      engineCatalog('codex').models.length > 0 &&
      !isKnownChoice('codex', chosen.model, chosen.effort ?? null)
    )
      throw new ApiError(
        409,
        `The chosen model ${chosen.model} is no longer offered on ChatGPT. Choose another model or return to a style.`,
      );
    const model = chosen?.model ?? codexModelSetting();
    const effort = chosen?.model ? (chosen.effort ?? undefined) : codexEffortSetting();
    if (!model || !isKnownChoice('codex', model, effort ?? null)) return {};
    return { model, ...(effort ? { effort } : {}) };
  };
  /** The thread's WorkStyle, else the Settings default, else none. */
  const styleOf = (conversation?: Conversation | null): WorkStyle | null => {
    if (isWorkStyle(conversation?.workStyle)) return conversation.workStyle;
    const saved = store.settings.services?.workStyle;
    return isWorkStyle(saved) ? saved : DEFAULT_WORK_STYLE;
  };
  /**
   * What a route offers a style to choose from: the engine's own list. The AWS route reports
   * no list; its one connected model is what it can run, with the three levels its adapter
   * accepts. Nothing here adds a model a route did not report.
   */
  const routeModels = (engine: string): EngineModel[] => {
    const listed = engineCatalog(engine).models;
    if (listed.length > 0 || engine !== AWS_BEDROCK_ROUTE) return listed;
    const saved = store.settings.services?.[`${engine}Model`];
    if (typeof saved !== 'string' || !saved) return [];
    const efforts = ['low', 'medium', 'high'].map((level) => ({ id: level, description: '' }));
    return [{ slug: saved, name: saved, description: '', defaultEffort: 'low', efforts }];
  };
  /**
   * The WorkStyle seam (NC-2026-09-22.1). Null when the thread pins a model (the pin always
   * wins) or no style applies, so the caller keeps its own path unchanged. Otherwise the model
   * and level the style resolves to from what this route offers; when nothing offered
   * qualifies, the request is refused with the reason rather than quietly downgraded.
   */
  const styleChoice = (
    engine: Exclude<Route, 'sample'>,
    projectId: string,
    conversation: Conversation | null | undefined,
    options: RunHints = {},
  ): (RunChoice & { reason: string }) | null => {
    if (conversation?.requested?.model) return null;
    const style = styleOf(conversation);
    if (!style) return null;
    const savedModel =
      engine === 'codex'
        ? codexModelSetting()
        : selectedModel(engine, store.settings, store.state(projectId).project, conversation);
    const resolved = resolveWorkStyle({
      style,
      mode: options.mode ?? conversation?.mode ?? 'ask',
      route: engine,
      availableModels: routeModels(engine),
      hints: { text: options.text ?? null },
      savedModel: savedModel ?? null,
      routeDefaultAllowed: engine === 'codex',
      stableEffort: options.stableEffort === true,
    });
    if (resolved.outcome === 'ask') throw new ApiError(409, resolved.reason);
    return {
      ...(resolved.model ? { model: resolved.model } : {}),
      ...(resolved.effort ? { effort: resolved.effort } : {}),
      selection: resolved.selection === 'manual' ? 'automatic' : resolved.selection,
      reason: resolved.reason,
    };
  };
  /**
   * The read-only tools an Ask or Plan turn gets (owner decision 2026-09-23):
   * the project folder through the path trust funnel, web search, and the MCP
   * read tools the owner approved in `<data>/read-connectors.json`. Only the
   * host builds it, from its own project record; a missing folder means text.
   */
  const readScopeFor = async (
    projectId: string,
    mode: string,
  ): Promise<{ readScope?: ReadScope }> => {
    if (mode !== 'ask' && mode !== 'plan') return {};
    // A folder the path funnel refuses, or one that is gone, leaves the turn text-only.
    const root = await safeAbsolute(store.state(projectId).project.folder).catch(() => null);
    if (!root || !(await fs.stat(root).then((entry) => entry.isDirectory(), () => false)))
      return {};
    let mcp: ReadScope['mcp'];
    try {
      mcp = loadApprovedReadServers(path.join(store.dataDir, 'read-connectors.json'));
    } catch {
      throw new ApiError(
        409,
        'The approved read connectors file (read-connectors.json) is malformed. Fix or remove it, then send again.',
      );
    }
    return { readScope: { root, web: true, mcp } };
  };
  const nativeChoice = (
    engine: Exclude<Route, 'sample'>,
    projectId: string,
    conversation?: Conversation | null,
    options: RunHints = {},
  ): RunChoice => {
    const styled = styleChoice(engine, projectId, conversation, options);
    if (styled) {
      const { reason: _reason, ...choice } = styled;
      return choice;
    }
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
  /**
   * What the thread's next request would run with, for the style picker and the details line.
   * Read-only: it resolves exactly as dispatch does, minus the message itself, and changes
   * nothing. A pin is reported as the pin; a style that would ask says so here first.
   */
  app.get(
    '/api/projects/:id/threads/:threadId/work-style',
    route(async (req) => {
      const projectId = id(req);
      const state = store.state(projectId);
      const thread = state.conversations.find((c) => c.id === req.params.threadId);
      if (!thread) throw new ApiError(404, 'This thread was not found.');
      const engine = selectedEngine(store.settings, state.project, thread);
      const style = styleOf(thread);
      const source = isWorkStyle(thread.workStyle)
        ? 'thread'
        : isWorkStyle(store.settings.services?.workStyle)
          ? 'settings'
          : style
            ? 'default'
            : 'none';
      if (engine === 'sample') return { route: engine, style, source, resolution: null };
      const pin = thread.requested?.model
        ? { model: thread.requested.model, effort: thread.requested.effort ?? null }
        : null;
      const savedModel =
        engine === 'codex'
          ? codexModelSetting()
          : selectedModel(engine, store.settings, state.project, { ...thread, requested: null });
      const resolution = resolveWorkStyle({
        style,
        mode: thread.mode,
        route: engine,
        availableModels: routeModels(engine),
        pin,
        savedModel: savedModel ?? null,
        routeDefaultAllowed: engine === 'codex',
        stableEffort: isModelApiRoute(engine),
      });
      return { route: engine, style, source, resolution };
    }),
  );
  mountClaudeSessionRoutes(app, engines, {
    authorize: async (req) => {
      store.state(String(req.params.id));
    },
    prepare: async (req, command) => {
      const projectId = String(req.params.id);
      const input = await store.locked(async () => {
        const state = store.state(projectId);
        const thread = state.conversations.find((item) => item.id === command.threadId);
        if (!thread) throw new ApiError(404, 'This thread was not found.');
        if (selectedEngine(store.settings, state.project, thread) !== 'claude-code')
          throw new ApiError(
            409,
            'Select Claude Code for this thread before opening its native conversation.',
          );
        if (store.settings.services?.['claude-code'] !== true)
          throw new ApiError(409, 'Turn Claude Code on in Settings before sending.');
        const accountRoute = store.settings.services?.['claude-codeAccountRoute'];
        const selection = nativeChoice('claude-code', projectId, thread, {
          mode: command.mode,
          text: command.text,
        });
        if (!selection.model || typeof accountRoute !== 'string')
          throw new ApiError(409, 'Select the Claude account and model in Settings first.');
        requireCloudSharing(
          state,
          'claude-code',
          command.sources.map((source) => source.path),
          !!req.params.runId,
        );
        const paths = new Set<string>();
        const documents = [];
        for (const source of command.sources) {
          const name = relativeName(source.path);
          if (paths.has(name.toLowerCase()))
            throw new ApiError(400, 'Choose each source file once.');
          paths.add(name.toLowerCase());
          const document = await store.readDocument(projectId, name);
          if (document.sha !== source.sha)
            throw new ApiError(409, `${name} changed. Choose its current version before sending.`);
          documents.push({ path: name, text: document.text });
        }
        if (
          documents.reduce((bytes, document) => bytes + Buffer.byteLength(document.text), 0) >
          128_000
        )
          throw new ApiError(413, 'Choose less than 128 KB of source text for this request.');
        return {
          projectId,
          threadId: thread.id,
          requestId: command.commandId,
          prompt: command.text,
          documents,
          instructions: MODES[command.mode].instructions,
          model: selection.model,
          accountRoute,
          ...(await readScopeFor(projectId, command.mode)),
        };
      });
      const runId =
        req.params.runId && !req.path.endsWith('/fork')
          ? String(req.params.runId)
          : claudeSessionRunId(projectId, command.commandId);
      const progress = (kind: 'started' | 'delta' | 'ended', frame?: TransientPreview) =>
        store.emit('engine-text', {
          projectId,
          threadId: input.threadId,
          requestId: input.requestId,
          runId,
          kind,
          ...(frame
            ? {
                stepId: frame.stepId,
                attempt: frame.attempt,
                fence: frame.fence,
                seq: frame.seq,
                text: frame.text,
              }
            : {}),
        });
      progress('started');
      let ended = false;
      const end = () => {
        if (!ended) {
          ended = true;
          progress('ended');
        }
      };
      req.res?.once('finish', end);
      req.res?.once('close', end);
      return {
        ...input,
        signal: req.res ? connectionSignal(req.res) : undefined,
        onPreview: (frame) => progress('delta', frame),
        onActivity: (frame) => store.emit('engine-activity', frame),
      };
    },
    recordResult: async (_req, command, result, input) => {
      if (!result.response) return;
      const response = result.response;
      await store.locked(async () => {
        // Project a committed runtime result into the ordinary thread. Clone first:
        // a failed persist must remain repairable by replaying the same command.
        const state = structuredClone(store.state(input.projectId));
        const thread = state.conversations.find((item) => item.id === input.threadId);
        if (!thread)
          throw new ApiError(
            404,
            'The response is recorded in the runtime, but its thread is missing.',
          );
        const { user: userId, assistant: assistantId } = projectedTurnIds(
          hash(turnIdentityText(result.runId, input.requestId))!,
        );
        const priorUser = thread.turns.find((turn) => turn.id === userId);
        const priorAssistant = thread.turns.find((turn) => turn.id === assistantId);
        if (priorUser || priorAssistant) {
          if (priorUser?.text !== input.prompt || priorAssistant?.text !== response.text)
            throw new ApiError(
              409,
              'The recorded conversation projection conflicts with this native response.',
            );
          return;
        }
        const at = now();
        const sources = input.documents.map((document) => document.path);
        const helper = {
          engine: 'claude-code',
          model: response.model,
          version: response.version,
          verified: true,
        };
        thread.turns.push(
          {
            id: userId,
            role: 'you',
            mode: command.mode,
            text: input.prompt,
            at,
            sources,
            route: 'claude-code',
          },
          {
            id: assistantId,
            role: 'assistant',
            mode: command.mode,
            text: response.text,
            at,
            sources,
            route: 'claude-code',
            helper,
            origin: directOrigin({
              engine: 'claude-code',
              requestedModel: input.model,
              reportedModel: response.model,
              version: response.version,
              accountRoute: input.accountRoute,
              executorId: 'claude-code',
            }),
          },
        );
        thread.helper = { engine: 'claude-code', model: response.model };
        thread.mode = command.mode;
        touchThread(thread, at, state.tasks);
        await store.persist(state);
      });
    },
  });
  /**
   * The digest the task route would give this message's own task command. A message too long
   * for a task description has no valid command at all, so it has no receipt to trust either
   * and its own admission refuses it below in the route's own words.
   */
  const conversationTaskDigest = (
    commandId: string,
    task: { name: string; description: string },
  ) => {
    try {
      return parseTaskCommand({
        protocolVersion: 1,
        commandId,
        owner: 'diomedes-with-ok',
        ...task,
      })!.admission.payloadDigest;
    } catch {
      return null;
    }
  };
  /** The same, for the Work command, from the route and task its own input phase pinned. */
  const conversationWorkDigest = (
    commandId: string,
    work: { taskId: string; route: string; instruction: string },
  ) => {
    try {
      return parseWorkCommand({
        protocolVersion: 1,
        commandId,
        taskId: work.taskId,
        route: work.route,
        instruction: work.instruction,
        sources: [],
        consent: true,
      })!.admission.payloadDigest;
    } catch {
      return null;
    }
  };
  /**
   * The projects a conversation may target, read per turn. Only a valid binding counts:
   * before the first message there is no home, so no project is one and every project is
   * targetable.
   */
  const admissionContext = async () => {
    const home = store.homeBinding();
    return {
      homeProjectId: home?.projectId ?? null,
      targetableProjectIds: (await store.projects())
        .map((project) => project.id)
        .filter((id) => id !== home?.projectId),
    };
  };
  /**
   * What every child admission is held to, read here rather than sampled before the awaits
   * that precede it: the thread, this message's own lineage, the Mode control as it stands
   * now intersected with what the message was bound to, and the person's saved choice of
   * this exact proposal. A narrowing, a retirement or a changed target between the answer
   * and this commit refuses the new child. A child that already committed is not revisited.
   */
  const admitChild = async (
    projectId: string,
    command: { commandId: string },
    source: AdmissionSource,
    family: 'task' | 'work',
  ) => {
    const thread = store
      .state(source.projectId)
      .conversations.find((item) => item.id === source.threadId);
    if (!thread) throw new ApiError(404, 'This thread was not found.');
    const lineage = (thread.lineages ?? []).find((item) => item.runId === source.runId);
    if (!lineage || lineage.retired)
      throw new ApiError(409, 'This conversation moved on before this was started.', {
        code: 'conversation_settled',
      });
    const verdict = admitInteraction({
      decision: source.decision,
      restriction: narrower(
        source.restriction,
        restrictionOf(thread.mode === 'auto' || thread.mode === 'plan' ? thread.mode : 'ask'),
      ),
      conversationProjectId: source.projectId,
      ...(await admissionContext()),
      selection: source.selection,
    });
    if (verdict.outcome === 'blocked')
      throw new ApiError(409, blockedMessage(verdict.reason), { code: verdict.reason });
    if (
      verdict.outcome !== 'escalate' ||
      verdict.projectId !== projectId ||
      verdict.projectId !== source.targetProjectId ||
      verdict.proposalDigest !== source.proposalDigest ||
      (family === 'task' ? verdict.taskCommandId : verdict.workCommandId) !== command.commandId
    )
      throw new ApiError(409, 'This message can no longer start that work. Nothing was started.', {
        code: 'not_startable',
      });
  };
  // The Diomedes conversation. `InteractionTurns` owns the sequence; what follows is only what
  // the Store and the existing admission paths supply to it. Each method takes and releases
  // its own lock, and none of them holds one while a provider runs.
  /** The driver that owns a conversation run. Model-API runs are named `model-...`. */
  const conversationDriver = (runId: string) => {
    const driver = runId.startsWith('model-') ? engines.modelSessions : engines.nativeSessions;
    if (!driver) throw new ApiError(503, 'The conversation runtime is unavailable.');
    return driver;
  };
  /** `locate` across a thread's lineages, each on its own driver, newest first. */
  const conversationLocator =
    () => async (projectId: string, runIds: readonly string[], commandId: string) => {
      for (const runId of runIds) {
        const found = await conversationDriver(runId).locate(projectId, [runId], commandId);
        if (found) return found;
      }
      return null;
    };
  const interactionHost: InteractionHost = {
    resolve: (projectId, threadId, command, options) =>
      store.locked(async () => {
        const driver = engines.nativeSessions;
        if (!driver) throw new ApiError(503, 'The native conversation runtime is unavailable.');
        const locateAny = conversationLocator();
        // Clone first, as the projection does: a failed persist must leave nothing half admitted.
        const state = structuredClone(store.state(projectId));
        const thread = state.conversations.find((item) => item.id === threadId);
        if (!thread) throw new ApiError(404, 'This thread was not found.');
        const sourceMessageId = sourceMessageIdFor(projectId, threadId, command.commandId);
        const restriction = restrictionOf(command.mode);
        const lineages = thread.lineages ?? [];
        const request = {
          projectId,
          threadId,
          requestId: command.commandId,
          prompt: promptFor(command.mode, command.text, sourceMessageId),
          instructions: instructionsFor(command.mode, MODES[command.mode].instructions),
          // From the parsed command alone, before any setting or file is read, so a retry is
          // compared with what was sent even after either has changed.
          binding: commandBinding('message', command),
          interaction: {
            sourceMessageId,
            decide: decideWith(sourceMessageId, restriction, command.text),
          },
        };
        const resolved = { projectId, threadId, commandId: command.commandId, sourceMessageId };
        // A command this thread already holds is found first, through every lineage it ever
        // had, retired ones included, and before the engine, the model or a file is looked at.
        const located = await locateAny(
          projectId,
          [...lineages].reverse().map((lineage) => lineage.runId),
          command.commandId,
        );
        if (located?.answered)
          return {
            ...resolved,
            restriction,
            // The command keeps the restriction it was bound to. What it may still start is
            // held to the thread's Mode now, so narrowing the control stops an admission
            // that has not happened yet, on a retry exactly as on a selection.
            control: restrictionOf(
              thread.mode === 'auto' || thread.mode === 'plan' ? thread.mode : 'ask',
            ),
            runId: located.runId,
            // A model-API run answers on the route the thread recorded; AWS is only the
            // historical default for a thread that predates the other routes.
            route: located.runId.startsWith('model-')
              ? isModelApiRoute(thread.engine)
                ? thread.engine
                : AWS_BEDROCK_ROUTE
              : ('claude-code' as const),
            action: 'follow-up' as const,
            replay: true,
            text: command.text,
            mode: command.mode,
            // Nothing is generated, so nothing here is sent anywhere: no file is read again
            // and no model is chosen. The driver compares the binding and reads the record.
            input: { ...request, documents: [], model: '', accountRoute: '' },
          };
        // A turn a budget refused was written and never sent. Nothing was asked of a model, so
        // it is not an unfinished message, and it never stands in the way of a new lineage.
        const sent = located?.dispatched ? located : null;
        if (
          sent &&
          (sent.settled || lineages.find((lineage) => lineage.runId === sent.runId)?.retired)
        )
          return { unfinished: true as const, runId: sent.runId, sourceMessageId };
        // CD-01 Decision 5: a conversation runs on the native Claude session or on a
        // model-API route through its own driver. Any other route is refused here, by
        // name, through the same predicate the thread update guards with.
        const conversationRoute = selectedEngine(store.settings, state.project, thread);
        if (!isConversationRoute(conversationRoute))
          throw new ApiError(
            409,
            'Select Claude Code or AWS Bedrock for this conversation before sending.',
          );
        const routeName =
          conversationRoute === 'claude-code' ? 'Claude Code' : MODEL_API_NAMES[conversationRoute];
        if (store.settings.services?.[conversationRoute] !== true)
          throw new ApiError(409, `Turn ${routeName} on in Settings before sending.`);
        const accountRoute = store.settings.services?.[`${conversationRoute}AccountRoute`];
        // A WorkStyle, when one applies, chooses from what the route offers; on a model-API
        // route its level follows style and mode only, because that route binds it into the
        // lineage's saved context. Without one, each route keeps its own path.
        const styled = styleChoice(conversationRoute, projectId, thread, {
          mode: command.mode,
          text: command.text,
          stableEffort: isModelApiRoute(conversationRoute),
        });
        const selection: { model?: unknown; effort?: string } =
          styled ??
          (conversationRoute === 'claude-code'
            ? nativeChoice('claude-code', projectId, thread)
            : { model: store.settings.services?.[`${conversationRoute}Model`] });
        if (typeof selection.model !== 'string' || !selection.model || typeof accountRoute !== 'string')
          throw new ApiError(409, `Connect ${routeName} and choose its model in AI setup first.`);
        requireCloudSharing(state, conversationRoute, command.sources.map((source) => source.path), false, {
          home: store.isHomeProject(projectId),
        });
        const paths = new Set<string>();
        const documents = [];
        for (const source of command.sources) {
          const name = relativeName(source.path);
          if (paths.has(name.toLowerCase()))
            throw new ApiError(400, 'Choose each source file once.');
          paths.add(name.toLowerCase());
          const document = await store.readDocument(projectId, name);
          if (document.sha !== source.sha)
            throw new ApiError(409, `${name} changed. Choose its current version before sending.`);
          documents.push({ path: name, text: document.text });
        }
        if (
          documents.reduce((bytes, document) => bytes + Buffer.byteLength(document.text), 0) >
          128_000
        )
          throw new ApiError(413, 'Choose less than 128 KB of source text for this request.');
        // One current lineage per mode. Retiring one and admitting its replacement are a single
        // mutation, and the next generation counts every entry the thread ever had.
        let current: ConversationLineage | undefined = lineages
          .filter((lineage) => lineage.mode === command.mode && !lineage.retired)
          .sort((a, b) => b.generation - a.generation)[0];
        let changed = false;
        // A lineage belongs to one route. Choosing another route starts the next generation;
        // the earlier run stays as evidence under its own driver.
        const modelRoute = isModelApiRoute(conversationRoute);
        if (current && !sent && current.runId.startsWith('model-') !== modelRoute) {
          current.retired = 'scope-change';
          current = undefined;
          changed = true;
        }
        // A model-API lineage keeps the level it was opened with. A style change that moves
        // the level is the safe boundary: the next generation starts, the earlier stays.
        const lineageEffort = modelRoute ? selection.effort : undefined;
        if (current && !sent && modelRoute && current.effort !== lineageEffort) {
          current.retired = 'scope-change';
          current = undefined;
          changed = true;
        }
        // The lineages are searched newest first, so once the replacement holds this command
        // it is the one a retry or a restart finds, and the refused turn stays as evidence.
        if (current && options.replace && !sent) {
          current.retired = options.replace;
          current = undefined;
          changed = true;
        }
        if (!current) {
          const generation = 1 + Math.max(0, ...lineages.map((lineage) => lineage.generation));
          current = {
            mode: command.mode,
            generation,
            runId: (modelRoute ? modelSessionRunId : claudeSessionRunId)(
              projectId,
              `lineage.${evidenceDigest({ threadId, mode: command.mode, generation }).slice(0, 40)}`,
            ),
            ...(lineageEffort ? { effort: lineageEffort } : {}),
          };
          thread.lineages = [...lineages, current];
          changed = true;
        }
        if (changed) await store.persist(state);
        const runId = current.runId;
        const lineageDriver = runId.startsWith('model-') ? engines.modelSessions : driver;
        if (!lineageDriver) throw new ApiError(503, 'The conversation runtime is unavailable.');
        const known = await lineageDriver.status(projectId, runId).catch((error: unknown) => {
          if (error instanceof HarnessError && error.code === 'unknown_run') return null;
          throw error;
        });
        const action = !known
          ? ('start' as const)
          : known.connected
            ? ('follow-up' as const)
            : known.nativeSession
              ? ('resume' as const)
              : ('start' as const);
        if (conversationRoute === 'claude-code' && action !== 'start')
          requireCloudSharing(state, conversationRoute, command.sources.map((source) => source.path), true, {
            home: store.isHomeProject(projectId),
          });
        // One resolved identity: progress, execution and projection all name the run that ran.
        const progress = (kind: 'started' | 'delta' | 'ended', frame?: TransientPreview) =>
          store.emit('engine-text', {
            projectId,
            threadId,
            requestId: command.commandId,
            runId,
            kind,
            ...(frame
              ? {
                  stepId: frame.stepId,
                  attempt: frame.attempt,
                  fence: frame.fence,
                  seq: frame.seq,
                  text: frame.text,
                }
              : {}),
          });
        progress('started');
        let ended = false;
        options.whenDone?.(() => {
          if (!ended) {
            ended = true;
            progress('ended');
          }
        });
        // Frames keep their dense sequence; only their text is held back, so the decision
        // block never reaches a person's screen while the answer streams.
        const gate = command.mode === 'auto' ? previewGate() : (text: string) => text;
        return {
          ...resolved,
          restriction,
          control: restriction,
          runId,
          route: modelRoute ? conversationRoute : ('claude-code' as const),
          action,
          replay: false,
          text: command.text,
          mode: command.mode,
          input: {
            ...request,
            documents,
            model: selection.model as string,
            ...(modelRoute && selection.effort ? { effort: selection.effort } : {}),
            accountRoute,
            ...(modelRoute ? {} : await readScopeFor(projectId, command.mode)),
            signal: options.signal,
            onPreview: (frame: TransientPreview) =>
              progress('delta', { ...frame, text: gate(frame.text) }),
            // Tool calls are narration beside the answer, bound to the same run identity.
            onActivity: (frame: ToolActivity) => store.emit('engine-activity', frame),
          },
        };
      }),
    locate: (projectId, threadId, commandId) =>
      store.locked(async () => {
        const driver = engines.nativeSessions;
        if (!driver) throw new ApiError(503, 'The native conversation runtime is unavailable.');
        const thread = store
          .state(projectId)
          .conversations.find((item) => item.id === threadId);
        if (!thread) throw new ApiError(404, 'This thread was not found.');
        const located = await conversationLocator()(
          projectId,
          [...(thread.lineages ?? [])].reverse().map((lineage) => lineage.runId),
          commandId,
        );
        if (!located) return null;
        const mode = thread.mode;
        return {
          ...located,
          sourceMessageId: sourceMessageIdFor(projectId, threadId, commandId),
          // The Mode control as it stands now. A thread on a work mode is not a conversation
          // that may start anything from here, so it reads as the narrowest limit.
          restriction: restrictionOf(mode === 'auto' || mode === 'plan' ? mode : 'ask'),
        };
      }),
    project: (resolved, result) =>
      store.locked(async () => {
        const state = structuredClone(store.state(resolved.projectId));
        const thread = state.conversations.find((item) => item.id === resolved.threadId);
        if (!thread)
          throw new ApiError(
            404,
            'The response is recorded in the runtime, but its thread is missing.',
          );
        const { user: userId, assistant: assistantId } = projectedTurnIds(
          hash(turnIdentityText(result.runId, resolved.commandId))!,
        );
        const priorUser = thread.turns.find((turn) => turn.id === userId);
        const priorAssistant = thread.turns.find((turn) => turn.id === assistantId);
        if (priorUser || priorAssistant) {
          if (priorUser?.text !== resolved.text || priorAssistant?.text !== result.text)
            throw new ApiError(
              409,
              'The recorded conversation projection conflicts with this native response.',
            );
          return;
        }
        const at = now();
        // A projection repaired after the fact is rebuilt from what the turn itself recorded.
        // The files are not read again and no current setting stands in for a past one.
        const answeredBy = resolved.route ?? 'claude-code';
        // A model-API answer is always projected from its recorded origin: the requested model,
        // the model AWS reported (or none) and the account route, exactly as the turn saved them.
        const modelAnswer = result.runId.startsWith('model-');
        const recorded = resolved.replay || modelAnswer
          ? await (modelAnswer ? engines.modelSessions! : engines.nativeSessions!).evidence(
              resolved.projectId,
              result.runId,
              resolved.commandId,
            )
          : null;
        const sources =
          recorded?.sources ?? resolved.input.documents.map((document) => document.path);
        thread.turns.push(
          {
            id: userId,
            role: 'you',
            mode: resolved.mode,
            // What the person typed. The identity line the model was given is never shown.
            text: resolved.text,
            at,
            sources,
            route: answeredBy,
          },
          {
            id: assistantId,
            role: 'assistant',
            mode: resolved.mode,
            // The answer without its decision block. The whole answer stays in the run.
            text: result.text,
            at,
            sources,
            route: answeredBy,
            helper: {
              engine: answeredBy,
              model: result.model,
              version: result.version,
              verified: modelAnswer ? recorded?.origin?.model.source === 'runtime' : true,
            },
            origin: recorded
              ? (recorded.origin ??
                // Nothing was recorded, so nothing is claimed: the model the runtime reported
                // and no requested model or account.
                directOrigin({
                  engine: answeredBy,
                  reportedModel: result.model,
                  version: result.version,
                  executorId: answeredBy,
                }))
              : directOrigin({
                  engine: answeredBy,
                  requestedModel: resolved.input.model,
                  reportedModel: result.model,
                  version: result.version,
                  accountRoute: resolved.input.accountRoute,
                  executorId: answeredBy,
                }),
          },
        );
        thread.helper = { engine: answeredBy, model: result.model };
        // A repair never moves the Mode control: the person may have narrowed it since.
        if (!resolved.replay) thread.mode = resolved.mode;
        touchThread(thread, at, state.tasks);
        await store.persist(state);
      }),
    admissionContext,
    receipts: (projectId, ids, intent) =>
      store.locked(async () => {
        const state = store.state(projectId);
        // A derived command id another request bound to different work is a conflict, not
        // this message's child. The parser, the digest and the replay refusal a person's own
        // task goes through decide that, so nothing foreign is read back as a start here.
        const expected = intent && conversationTaskDigest(ids.taskCommandId, intent.task);
        const task = expected
          ? store.taskCommand(projectId, ids.taskCommandId, expected)
          : undefined;
        if (!expected) assertReplay(findCommand(state, ids.taskCommandId), 'task.create');
        // The Work command is recognised only once its own input phase has pinned what it
        // names. A session under that id holding anything else is other work, so it is not
        // this message's receipt; the Work admission refuses it there, in its own words,
        // and the refusal it records stays readable.
        const started = intent?.work && conversationWorkDigest(ids.workCommandId, intent.work);
        const work = findCommand(state, ids.workCommandId);
        assertReplay(work, 'work.start');
        return {
          projectId,
          taskId: task?.id ?? null,
          sessionId:
            work?.type === 'work.start' && started && work.digest === started
              ? work.subject.id
              : null,
        };
      }),
    workRoute: async (projectId) =>
      // The target project's own engine, as a person's Start there would use.
      selectedEngine(store.settings, store.state(projectId).project, null),
    createTask: (projectId, command, source) =>
      store.locked(async () => {
        const driver = conversationDriver(source.runId);
        await driver.assertLive(source.projectId, source.runId);
        await admitChild(projectId, command, source, 'task');
        return driver.fenced(source.projectId, source.runId, async () => ({
          taskId: (
            await createTaskFrom(projectId, {
              protocolVersion: 1,
              commandId: command.commandId,
              name: command.name,
              description: command.description,
              owner: 'diomedes-with-ok',
            })
          ).id,
        }));
      }),
    startWork: (projectId, command, source) =>
      store.locked(async () => {
        const driver = conversationDriver(source.runId);
        await driver.assertLive(source.projectId, source.runId);
        await admitChild(projectId, command, source, 'work');
        const session = (await admitWork(
          projectId,
          {
            protocolVersion: 1,
            commandId: command.commandId,
            taskId: command.taskId,
            // The route this message's own Work input pinned, not the setting as it stands.
            route: command.route,
            instruction: command.instruction,
            sources: [],
            // The person's selection of this exact proposal carried this consent.
            consent: true,
          },
          undefined,
          // Only the durable admission is ordered against this conversation's own Runtime
          // transitions; the preparation the Work path does first stays outside that queue.
          (step) => driver.fenced(source.projectId, source.runId, step),
        )) as { id: string };
        return { sessionId: session.id };
      }),
  };
  /**
   * Where Diomedes' own conversation lives: the reserved home Project and its
   * one thread. The read answers null until a binding is both saved and valid,
   * and creates nothing, so opening the app provisions no home. The page posts
   * here when the person sends their first message, and that is the only thing
   * that ever makes one.
   */
  app.get(
    '/api/home/conversation',
    route(async () => store.homeBinding()),
  );
  app.post(
    '/api/home/conversation',
    // The provisioner takes the Store lock itself: its steps are one mutation.
    route(async () => store.provisionHome(), false),
  );
  /**
   * Where a project's own Diomedes conversation lives. There is no read here on
   * purpose: a page that wants to know reads the project's state and applies
   * `diomedesThread`, which creates and repairs nothing. This POST is the only
   * thing that adopts or makes one, and it does both in one locked sequence, so
   * two windows sending their first message at once land on one thread rather
   * than each on its own. The body is ignored; the project is the whole request.
   */
  app.post(
    '/api/projects/:id/conversation',
    route(async (req) => store.provisionProjectConversation(id(req)), false),
  );
  mountModelApiRoutes(app, { store, engines });
  mountInteractionRoutes(app, new InteractionTurns(engines, interactionHost), {
    authorize: async (req) => {
      store.state(String(req.params.id));
    },
    context: (req) => ({
      signal: req.res ? connectionSignal(req.res) : undefined,
      whenDone: (end) => {
        req.res?.once('finish', end);
        req.res?.once('close', end);
      },
    }),
  });
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
      requireCloudSharing(state, engine, sources, wake === true);
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
      const choice = nativeChoice(engine, projectId, conversation, { mode: runMode, text });
      const session = await nativeWork.start(projectId, task.id, {
        instruction,
        sources,
        consent: consent,
        team: team,
        turnId,
        engine,
        threadId: conversation.id,
        mode: runMode,
        requested: choice,
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
        // The run's own attribution from admission, so the holding line names the
        // model it was sent to, as a request, until the runtime reports one.
        ...(storedSession.origin ? { origin: structuredClone(storedSession.origin) } : {}),
        helper: {
          engine,
          model: choice.model ?? null,
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
      if (isModelApiRoute(serviceRoute))
        throw new ApiError(
          409,
          `${MODEL_API_NAMES[serviceRoute]} answers through the conversation. Send your message there.`,
        );
      // Home is reached through its messages route alone. This direct route would start work
      // there, write a plan into it, or re-route the one thread that has to stay on Claude
      // Code, so it is refused for every mode before anything is changed, any source file is
      // read or anything is sent.
      if (store.isHomeProject(projectId))
        throw new ApiError(
          409,
          'The Diomedes conversation does not take direct requests. Send it a message, or name the project this belongs to.',
        );
      const parsedMode = modeOf(b.mode);
      if (!parsedMode) throw new ApiError(400, 'Choose a valid mode.');
      if (parsedMode === 'auto')
        throw new ApiError(
          409,
          'Automatic is a conversation mode. Direct execution does not accept it.',
        );
      const mode = parsedMode;
      // A Small Business skill the person picked. Checked here, before consent is asked for or
      // anything is read, so a skill that cannot run says why instead of a send being confirmed
      // for nothing. The section itself is assembled once the selected documents are known,
      // because they decide how much room it has.
      const skillId =
        b.skill === undefined || b.skill === null ? undefined : asString(b.skill, 'a skill', 64);
      if (skillId !== undefined)
        assembleSkillSection({
          state: store.state(projectId),
          packId: 'diomedes.small-business',
          skillId,
          mode,
          budgetBytes: Number.POSITIVE_INFINITY,
        });
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
          `Your instruction and selected documents will be sent to ${routeDisplayName(serviceRoute)}. Confirm before sending.`,
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
      requireCloudSharing(store.state(projectId), serviceRoute, sources);
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
          team: teamForThread(projectId, threadId, req.socket.localPort),
          mode,
          ...(failing ? { failing } : {}),
        });
      const prepared = await store.locked(async () => {
        const state = store.state(projectId);
        requireCloudSharing(state, serviceRoute, sources);
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
        const documentBytes = documents.reduce((total, d) => total + Buffer.byteLength(d.text), 0);
        if (documentBytes > 128000)
          throw new ApiError(413, 'Choose less than 128 KB of source text for this request.');
        // Assembled before the turn is written, so a playbook that does not fit leaves no turn
        // behind. It rides in the instruction channel below; the person's words stay theirs.
        const skill =
          skillId === undefined
            ? undefined
            : assembleSkillSection({
                state,
                packId: 'diomedes.small-business',
                skillId,
                mode,
                budgetBytes: instructionSectionBudget(documentBytes),
              });
        const youTurn: Turn = {
          id: identifier('U'),
          role: 'you',
          mode,
          text,
          at: now(),
          sources,
          route: serviceRoute,
          ...(attempt ? { attempt } : {}),
          ...(skill
            ? { skill: serviceRoute === 'sample' ? { ...skill.use, bytes: 0 } : skill.use }
            : {}),
        };
        conversation.turns.push(youTurn);
        touchThread(conversation, youTurn.at, state.tasks);
        await store.persist(state);
        return {
          conversationId: conversation.id,
          documents,
          attempt,
          skill: skill ? { section: skill.section, name: skill.use.name } : undefined,
        };
      });
      // The mode's own contract first, then the playbook the person picked, if any. Identical on
      // every route that takes an instruction channel.
      const instructionsForRequest = prepared.skill
        ? `${MODES[mode].instructions}\n\n${prepared.skill.section}`
        : MODES[mode].instructions;
      let answer: string;
      let helper: NonNullable<Turn['helper']>;
      const runChoice =
        serviceRoute === 'sample'
          ? {}
          : nativeChoice(
              serviceRoute,
              projectId,
              store.state(projectId).conversations.find((c) => c.id === prepared.conversationId),
              { mode, text },
            );
      const requestedModel = runChoice.model;
      if (isExternalEngine(serviceRoute)) {
        const accountRoute = store.settings.services?.[`${serviceRoute}AccountRoute`];
        if (!requestedModel || typeof accountRoute !== 'string')
          throw new ApiError(409, 'Select this service and model in AI setup first.');
        const requestId = identifier('R');
        const runId = textRunId(projectId, requestId);
        const progress = (
          kind: 'started' | 'delta' | 'ended',
          text?: string,
          frame?: TransientPreview,
        ) =>
          store.emit('engine-text', {
            projectId,
            threadId: prepared.conversationId,
            requestId,
            runId,
            kind,
            ...(frame
              ? { stepId: frame.stepId, attempt: frame.attempt, fence: frame.fence, seq: frame.seq }
              : {}),
            ...(text === undefined ? {} : { text }),
          });
        // The signal exists before Stop is shown, so a Stop during the read-scope lookup still lands.
        const signal = connectionSignal(res);
        progress('started');
        try {
          requireCloudSharing(store.state(projectId), serviceRoute, prepared.documents.map((doc) => doc.path));
          const readScope = await readScopeFor(projectId, mode);
          const result = await engines.generate(serviceRoute, {
            projectId,
            threadId: prepared.conversationId,
            requestId,
            prompt: text,
            documents: prepared.documents,
            instructions: instructionsForRequest,
            model: requestedModel,
            accountRoute,
            ...readScope,
            signal,
            onPreview: (frame) => progress('delta', frame.text, frame),
            onActivity: (frame) => store.emit('engine-activity', frame),
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
        // The same preview stream the other engines use: the answer shows as it
        // is written, and the completed answer below replaces it.
        const requestId = identifier('R');
        const runId = textRunId(projectId, requestId);
        const signal = connectionSignal(res);
        const progress = (kind: 'started' | 'delta' | 'ended', frame?: TransientPreview) =>
          store.emit('engine-text', {
            projectId,
            threadId: prepared.conversationId,
            requestId,
            runId,
            kind,
            ...(frame
              ? {
                  stepId: frame.stepId,
                  attempt: frame.attempt,
                  fence: frame.fence,
                  seq: frame.seq,
                  text: frame.text,
                }
              : {}),
          });
        const onDelta = previewSink({
          identity: {
            projectId,
            threadId: prepared.conversationId,
            requestId,
            runId,
            stepId: TEXT_DISPATCH_STEP,
            attempt: 1,
            fence: 1,
          },
          onPreview: (frame) => progress('delta', frame),
          // An over-long frame ends the preview; the answer itself still arrives.
          onInvalid: () => {},
          signal,
        });
        progress('started');
        try {
          requireCloudSharing(store.state(projectId), serviceRoute, prepared.documents.map((doc) => doc.path));
          const result = await askCodex({
            prompt: text,
            documents: prepared.documents,
            ...(requestedModel ? { model: requestedModel } : {}),
            instructions: instructionsForRequest,
            // A level chosen for the thread outranks the mode's own, up to the
            // mode's ceiling; only Fix has one, so Ask and Plan follow the choice.
            effort: effortFor(mode, runChoice.effort, MODES[mode].effort),
            // Stop closes the request, and this ends the ChatGPT turn with it.
            signal,
            onDelta,
            ...(await readScopeFor(projectId, mode)),
          });
          answer = result.text;
          helper = codexHelper(result);
        } catch (error) {
          throw new ApiError(
            503,
            error instanceof Error
              ? error.message
              : `${routeDisplayName('codex')} could not complete this request.`,
          );
        } finally {
          progress('ended');
        }
      } else {
        helper = sampleHelper();
        answer =
          mode === 'ask'
            ? `No service is connected for this request, so Diomedes cannot answer yet.${prepared.skill ? ` It would follow the ${prepared.skill.name} playbook.` : ''}${sources.length ? ` It would read ${sources.slice(0, 3).join(', ')} to answer.` : ''} ${
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
                ? `Diomedes, with ${routeDisplayName(serviceRoute)} ${helper.model}, wrote ${document}`
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
    // Tool activity rides the same stream as text previews: narration, never persisted.
    const activityListener = (data: unknown) => send('engine-activity', data);
    const usageListener = (snapshots: UsageSnapshot[]) => send('usage', { usage: snapshots });
    store.on('change', listener);
    store.on('settings', settingsListener);
    store.on('engine-text', textListener);
    store.on('engine-activity', activityListener);
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
      store.off('engine-activity', activityListener);
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
            'ACCOUNT_ROUTE',
            'MODEL_UNAVAILABLE',
            'STALE_STATUS',
            'NOT_INSTALLED',
            'UNSUPPORTED_VERSION',
            'ACCOUNT_CHANGED',
            'ROUTE_REFUSED',
            'BINDING_CHANGED',
          ].includes(error.code)
            ? 409
            : 503,
        )
        .json({
          error: error.message,
          code: error.code,
          ambiguous: error.ambiguous,
          // Where it failed decides the recovery, so the stage travels with the code.
          ...(error.stage ? { stage: error.stage } : {}),
        });
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
    noteError(error);
    res.status(500).json({
      error: 'The local service could not complete this action. Your saved history is preserved.',
    });
  };
  app.use(errorHandler);
  app.locals.store = store;
  app.locals.discovery = discovery;
  app.locals.work = work;
  app.locals.nativeWork = nativeWork;
  app.locals.changeReview = changeReview;
  app.locals.harness = harness;
  app.locals.connections = connections;
  app.locals.workControl = workControl;
  app.locals.close = async () => {
    // A window closed on the way out must not start a check against services
    // that are already shutting down.
    closing = true;
    // Stop listening before anything is stopped, or shutting a run down would
    // announce a settled session and schedule a delivery on the way out.
    deliveryClosed = true;
    store.off('change', deliverFor);
    await Promise.allSettled([...deliveries]);
    // Change-review writes into the data dir; drain its queued builds before
    // the remaining services' close persists can settle, or a late record
    // write can race removal of the data dir.
    await changeReview.close();
    engines.close();
    await login.close();
    await connections.close();
    await harness.close();
    await work.close();
    await nativeWork.close();
    // The ChatGPT app-server kept between requests goes with the service.
    await closeWarmCodex();
  };
  return app;
}
