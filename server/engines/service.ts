import fs from 'node:fs/promises';
import { createReadStream, realpath as realpathCallback } from 'node:fs';
import { promisify } from 'node:util';
import { createHash, randomUUID } from 'node:crypto';
import type { OwnedTeamObservation } from '../observability/eligibility.js';
import path from 'node:path';
import { LOCAL_MODEL_ACCOUNT, LOCAL_MODEL_ROUTE } from '../../shared/local-model.js';
import type { ModelImage } from '../../shared/model-images.js';
import type { LocalModelRuntime } from '../bonsai/runtime.js';
import { LOCAL_MODEL_CONNECTION, LOCAL_MODEL_SDK, localLimits, localRateCard, createLocalAdapter, respondLocal } from './bonsai.js';
import type { ExternalEngine, IntegrationStatus } from '../../shared/types.js';
import {
  ENGINE_NAMES,
  EXTERNAL_ENGINES,
  HOST_TEST_PROJECT,
  type ConnectionReceipt,
  type EngineBinding,
  type EngineCandidate,
  type EngineConnection,
  type InstallationContext,
  type SetupDiagnostic,
  type SetupStage,
} from '../../shared/engines.js';
import {
  freshness,
  nextSetupAction,
  selectCandidate,
  type SetupAction,
} from '../../shared/connection-policy.js';
import { createDiscovery, installationContext, type DiscoveredInstallation } from '../discovery.js';
import { BindingStore, type StoredBinding } from './binding-store.js';
import { VerificationStore } from './verification.js';
import { recordEngineCatalog } from '../models.js';
import { ClaudeAdapter, CLAUDE_VERSION } from './claude.js';
import { OpenCodeAdapter } from './opencode.js';
import { OmpAdapter } from './omp.js';
import { CursorAdapter, cursorCommand, resolveCursorEntry } from './cursor.js';
import { DevinAdapter } from './devin.js';
import { managedBinary, verifyManagedBinary } from './install.js';
import { capture, engineEnvironment, EngineError, MEMBER_LIMIT } from './process.js';
import { MEMBER_LIMIT_REACHED } from '../../shared/credit-allotments.js';
import { secretFingerprint } from '../connection-secrets.js';
import {
  activitySink,
  commandGate,
  liveOrder,
  previewSink,
  reasoningSink,
  type AdapterRouteContract,
  type PreviewRejection,
  type ReasoningSink,
} from '../../shared/adapter-contract.js';
import { routeContractFor } from '../harness/route-contract.js';
import { MODEL_API_REASONING } from '../harness/model-api-adapter.js';
import type {
  PersistentTextAdapter,
  TextEngineAdapter,
  TextRequest,
  TextResponse,
} from './contract.js';
import { contextMessage } from './contract.js';
import { localPromptProgressSink } from './local-progress.js';
import type { ToolRegistry } from '../harness/tools.js';
import { TEAM_CARRIAGE, teamRouteRefusal } from '../../shared/team-routes.js';
import type { OpenCodeSessionCheckpoint } from './opencode-session.js';
import type { AcpSessionCheckpoint, AcpSessionEngine } from './acp-session.js';
import {
  ClaudeSessionRuns,
  type ClaudeSessionAdmission,
  type ClaudeSessionTurn,
  type SessionCheckpointFacts,
} from '../harness/claude-session-run.js';
import type { CodexConversationPort } from '../integrations.js';
import {
  CODEX_ACCOUNT_ROUTE,
  codexSessionError,
  openCodexSession,
  type CodexSessionCheckpoint,
} from './codex-session.js';
import { HarnessError } from '../harness/policy.js';
import { TEXT_DISPATCH_STEP, textRunId, type TextDispatch } from '../harness/text-route.js';
import { digest } from '../harness/policy.js';
import {
  AWS_BEDROCK_ROUTE,
  AWS_BEDROCK_SDK,
  ModelApiError,
  WORK_LIMITS,
  awsAccountRoute,
  awsModelRateCard,
  awsModelRefusal,
  awsQualificationFor,
  awsProtocolFor,
  AwsConnectionRetired,
  respondOnce,
  type AwsConnection,
  type AwsConnections,
} from './aws-bedrock.js';
import type { RouteQualifications } from './route-qualification-store.js';
import {
  AZURE_OPENAI_PROTOCOL,
  AZURE_OPENAI_ROUTE,
  AZURE_OPENAI_SDK,
  azureAccountRoute,
  azureRateCard,
  respondAzure,
  type AzureConnection,
  type AzureConnections,
} from './azure-openai.js';
import {
  cacheNamespace,
  DEFAULT_CACHE_POLICY,
  systemParts,
  type CacheMark,
  type CacheNamespace,
  type CachePolicy,
  type CacheRequest,
  type RouteCapability,
} from '../../shared/route-capabilities.js';
import { awsCapability, azureCapability, LOCAL_CACHE_TENANT, routeCacheRequest, type CachePolicyRoute } from './route-cache.js';
import {
  OPENROUTER_ROUTE,
  OPENROUTER_SDK,
  openRouterAccountRoute,
  openRouterRateCard,
  respondOpenRouter,
  type OpenRouterConnection,
  type OpenRouterConnections,
} from './openrouter.js';
import {
  GOOGLE_VERTEX_ROUTE,
  GOOGLE_VERTEX_SDK,
  mintVertexToken,
  readAdcIdentity,
  respondVertex,
  vertexAccountRoute,
  vertexRateCard,
  type AccessToken,
  type VertexConnection,
  type VertexConnections,
} from './google-vertex.js';
import { callCeiling, type CallExposure, type RespondLimits, type RespondResult, type StreamSinks } from './model-api-core.js';
import { decideJobStep, DEFAULT_JOB_TIER, isCheckInRefusal, type JobTier } from '../../shared/job-caps.js';
import type { EscalationRole } from '../../shared/escalation-controls.js';
import type { MicroUsd } from '../../shared/managed-usage.js';
import { createAwsModelAdapter } from '../harness/aws-model-adapter.js';
import { createAzureModelAdapter } from '../harness/azure-model-adapter.js';
import { createOpenRouterModelAdapter } from '../harness/openrouter-model-adapter.js';
import { createVertexModelAdapter, createVertexModelDescriptor } from '../harness/vertex-model-adapter.js';
import { createNectoviaModelAdapter } from '../harness/nectovia-model-adapter.js';
import {
  NECTOVIA_LOOP_REFUSED,
  NECTOVIA_SDK,
  NECTOVIA_SIGN_IN,
  NECTOVIA_UNAVAILABLE,
  ensureNectoviaGuard,
  nectoviaAccountRoute,
  nectoviaConnectionId,
  nectoviaRateCard,
  respondNectovia,
  usageClassFor,
  type ManagedAdmission,
  type NectoviaAccount,
} from './nectovia.js';
import type { ModelAdapter } from '../harness/native-agent.js';
import type { ExposureAttempt, JobScope, ModelRateCard } from '../spend-exposure.js';
import type { ModelTranscripts } from '../harness/model-transcripts.js';
import {
  turnRunId,
  type ModelSessionAdmission,
  type ModelSessionRuns,
  type ModelSessionTurn,
  type TurnCache,
} from '../harness/model-session-run.js';
import type { ReadToolDeps } from '../harness/capabilities/read-scope-tools.js';
import type { ConnectionSecrets } from '../connection-secrets.js';
import { SpendExposure } from '../spend-exposure.js';
import { NECTOVIA_ROUTE, type ModelApiRoute } from '../../shared/model-api.js';
import { WORK_STYLE_LABELS } from '../../shared/work-style.js';
import { routeUnavailable } from '../../shared/route-unavailable.js';
import { ENGINE_GONE_CODES, engineGoneSentence } from '../../shared/conversation-engines.js';
import { MANAGED_USAGE_NOT_INCLUDED_PERSONAL } from '../../shared/individual-plan.js';
import {
  AGENT_NOT_INCLUDED,
  AGENT_SIGN_IN_REQUIRED,
  type AdmittedAgentWork,
  type AgentGatePort,
  type AgentWork,
} from '../accounts/agent-gate.js';
import { refusalEndsObservation, type ObservationAsk, type ObservationBinder } from '../observability/scopes.js';

function recordShimError(error: unknown): boolean {
  return (
    (error instanceof EngineError && error.code === 'UNSUPPORTED_SHIM') ||
    (error instanceof Error && 'code' in error && error.code === 'ENOENT')
  );
}

/**
 * The build each adapter was last exercised against. Informational only: it is
 * shown beside the installed version and never refuses one. Every route accepts
 * whatever version its tool reports, because these tools update themselves.
 */
export const TESTED_VERSIONS: Record<ExternalEngine, string> = {
  'claude-code': CLAUDE_VERSION,
  opencode: '1.18.4',
  'oh-my-pi': '18.0.6',
  cursor: '2026.08.11',
  devin: '3000.10.23',
};
/** Which routes a scan covers. A request refreshes its own route, not all five. */
export interface DiscoveryScope {
  engine?: ExternalEngine;
}
/** What this computer says one file is. Identity, never provenance. */
export interface FileIdentity {
  path: string;
  size: number;
  mtimeMs: number;
  sha256: string;
}
export interface EngineServiceDeps {
  platform: NodeJS.Platform;
  discover(scope?: DiscoveryScope): Promise<IntegrationStatus[]>;
  /**
   * Every installation this computer offers, not the first one per engine. A
   * caller that supplies its own `discover` supplies the inventory too; the
   * service then takes the locations that caller reported and looks no further.
   */
  enumerate?(scope?: DiscoveryScope): Promise<DiscoveredInstallation[]>;
  version(file: string, signal?: AbortSignal): Promise<string>;
  adapter(engine: ExternalEngine, file: string, cwd: string): TextEngineAdapter;
  /**
   * The preview contract's redaction: any secret the caller knows is in scope
   * for this engine's deltas. Applied before the frame is measured or emitted.
   */
  redactFor?(engine: ExternalEngine | ModelApiRoute | 'codex'): (text: string) => string;
  /** This computer's answer for one file: its real path, size and bytes. */
  identify?(file: string): Promise<FileIdentity | null>;
  /** The reviewed-release digest check for Diomedes's own private copy. */
  verifyManaged?(engine: ExternalEngine, file: string, observedSha256: string): Promise<void>;
  /** The packaged build this diagnostic came from. The integrator wires it. */
  buildId?(): string;
}
const blank = (engine: ExternalEngine): EngineConnection => ({
  engine,
  installation: 'not-checked',
  compatibility: 'unknown',
  authentication: 'unknown',
  accountRoute: null,
  models: [],
  checkedAt: null,
  detail: 'Check this computer to find installed tools.',
  usage: { state: 'unknown', checkedAt: null },
  candidates: [],
  binding: null,
  recommendedCandidateId: null,
  repair: null,
  revision: 0,
  verification: null,
  routeIssue: null,
  diagnostic: null,
});

const realpathNative = promisify(realpathCallback.native);
/** The largest file this will read to record an identity. */
const DIGEST_LIMIT_BYTES = 350_000_000;

/**
 * The identity tuple a semantic revision is moved for. A status poll, a
 * re-scan that finds the same bytes, or a re-check never changes it.
 */
const revisionKey = (
  binding: EngineBinding,
  accountRoute: string | null,
  model: string | null,
) => [binding.id, binding.path, binding.version, binding.sha256, accountRoute ?? '', model ?? ''].join('|');

async function exists(file: string) {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

async function digestFile(file: string): Promise<string> {
  const digest = createHash('sha256');
  let bytes = 0;
  for await (const chunk of createReadStream(file)) {
    bytes += (chunk as Buffer).length;
    if (bytes > DIGEST_LIMIT_BYTES)
      throw new EngineError(
        'INSTALL_SIZE',
        'This file is larger than Diomedes will read. It was not run.',
        false,
        'runtime-verification',
      );
    digest.update(chunk);
  }
  return digest.digest('hex');
}

/**
 * This computer's own answer for a file. `realpath.native` is used because the
 * plain call leaves a Windows 8.3 alias in place, and two spellings of one file
 * must not become two candidates.
 */
async function readIdentity(file: string): Promise<FileIdentity | null> {
  let real: string;
  try {
    real = await realpathNative(file);
  } catch {
    return null;
  }
  let stat;
  try {
    stat = await fs.stat(real);
  } catch {
    return null;
  }
  if (!stat.isFile()) return null;
  return { path: real, size: stat.size, mtimeMs: stat.mtimeMs, sha256: '' };
}

/** A candidate Diomedes will not use, named honestly and never launched. */
function unusable(
  engine: ExternalEngine,
  item: { file: string; source: 'managed' | 'system'; context: InstallationContext },
  integrity: 'unknown' | 'failed',
  issue: string,
): EngineCandidate {
  return {
    id: `${item.source}:${engine}:${item.file}`,
    engine,
    source: item.source,
    present: false,
    path: item.file,
    version: '',
    sha256: '',
    integrity,
    protocol: 'unknown',
    provenance: 'unverified',
    context: item.context,
    compatibility: 'unknown',
    issue,
  };
}

/** A message a person can act on. Never provider output, a path or a token. */
function sanitise(error: unknown): string {
  if (error instanceof EngineError) return error.message;
  return 'This installation could not be examined. Check this computer again.';
}

/**
 * What this computer holds for a route, from the inventory alone. A failed
 * digest on the chosen copy — or on the only copy there is — is corruption;
 * nothing to examine is a missing installation; anything else was found and is
 * not one this route can use as it stands.
 */
function installationState(
  inventory: EngineCandidate[],
  binding: EngineBinding | null,
): {
  installation: 'corrupt' | 'missing' | 'found';
  compatibility: 'unknown' | 'unsupported';
} {
  const corrupt = binding
    ? inventory.some((row) => row.id === binding.id && row.integrity === 'failed')
    : inventory.length === 1 && inventory[0].integrity === 'failed';
  if (corrupt) return { installation: 'corrupt', compatibility: 'unknown' };
  if (inventory.length === 0) return { installation: 'missing', compatibility: 'unknown' };
  return { installation: 'found', compatibility: 'unsupported' };
}

function repairDetail(
  engine: ExternalEngine,
  reason: string,
  installation: 'missing' | 'corrupt' | 'found',
): string {
  if (reason === 'record-unreadable')
    return 'Diomedes cannot read which installation you chose for this service. Choose one again to continue; the record it could not read is kept.';
  if (reason === 'selected-missing')
    return 'The installation you chose is no longer on this computer. Choose another or install a compatible copy.';
  if (reason === 'selected-changed')
    return 'The installation you chose has changed since you selected it. Check it before using this service again.';
  if (reason === 'selected-unverified')
    return 'The installation you chose could not be verified. It was not run.';
  if (installation === 'corrupt')
    return 'The private copy Diomedes installed no longer matches its reviewed release. It was not run. Repair it to continue.';
  if (installation === 'missing') return 'Install this tool to connect it.';
  return `${ENGINE_NAMES[engine]} is installed, but it did not answer when Diomedes checked it. Reinstall or update it, or choose another installation.`;
}

/**
 * The whole content of a connection test: one fixed synthetic instruction, no
 * documents, no instructions and nothing a person wrote. The answer is read
 * only far enough to see that the route answered; it is never stored, never
 * attributed and never written into a receipt.
 */
const TEST_PROMPT = 'Reply with the single word: ok';
/**
 * How long one test may take. There is one attempt and no automatic retry: a
 * dispatch that may already have been billed is never quietly sent again.
 */
const TEST_TIMEOUT_MS = 60_000;
/** How many checks handed over back to back one `settled()` wait follows before it answers anyway. */
const SETTLE_HANDOVERS = 8;
/**
 * The reserved identity a host-initiated test runs under. It is declared with
 * the shared engine types so the store can refuse it without importing this
 * service, which would close an import cycle through the harness.
 */
export { HOST_TEST_PROJECT };
/** One reserved thread per route, so testing one route never blocks another. */
export const hostTestThread = (engine: ExternalEngine) => `connection-test:${engine}`;

/** Codes that describe the dispatch itself rather than an admission check. */
const DISPATCH_CODES = new Set([
  'CANCELLED',
  'DISPATCH_UNCERTAIN',
  'ROUTE_REFUSED',
  'PROVIDER_ERROR',
  'IDENTITY_MISMATCH',
  'OUTPUT_LIMIT',
  'PREVIEW_CONTRACT',
  'RUNTIME_UNAVAILABLE',
  'REQUEST_ACTIVE',
  'EMPTY_ANSWER',
]);

/**
 * Where a connection test failed. The thrower's own stage wins. A failure of
 * the dispatch itself belongs to `dispatch` until a frame has arrived, after
 * which it belongs to `stream`; everything else is an admission check and is
 * staged the way every other connection failure is.
 */
function testStage(error: unknown, streamed: boolean): SetupStage {
  if (error instanceof EngineError && error.stage) return error.stage;
  const code = error instanceof EngineError ? error.code : '';
  if (!code || DISPATCH_CODES.has(code)) return streamed ? 'stream' : 'dispatch';
  return stageOf(error);
}

/** Where a failure happened, from the thrower when it knows and the code otherwise. */
function stageOf(error: unknown): SetupStage {
  if (error instanceof EngineError && error.stage) return error.stage;
  const code = error instanceof EngineError ? error.code : '';
  if (code === 'AUTH_REQUIRED' || code === 'ACCOUNT_ROUTE') return 'provider-auth';
  if (code === 'MODEL_UNAVAILABLE') return 'model-list';
  if (code === 'LAUNCH_FAILED' || code === 'START_FAILED' || code === 'UNSUPPORTED_SHIM')
    return 'launch';
  if (code === 'PROTOCOL_ERROR' || code === 'PROCESS_EXITED') return 'local-handshake';
  if (code === 'CLEANUP_FAILED') return 'cleanup';
  if (code === 'NOT_INSTALLED' || code === 'CONSENT_REQUIRED') return 'discovery';
  return 'runtime-verification';
}
export class EngineService {
  private readonly jobLedgerViews = new Map<string, { base: SpendExposure; cap: MicroUsd; view: SpendExposure }>();
  private readonly connections = new Map(EXTERNAL_ENGINES.map((id) => [id, blank(id)]));
  private readonly deps: EngineServiceDeps;
  /** One run per scope: two simultaneous scans of the same routes share it. */
  private scans = new Map<string, Promise<EngineConnection[]>>();
  private checks = new Map<ExternalEngine, Promise<EngineConnection>>();
  /** One test per route at a time: a second one is refused, never queued. */
  private tests = new Map<ExternalEngine, Promise<ConnectionReceipt>>();
  private discoveryDisclosure = new Map<ExternalEngine, string[]>();
  private readonly nativeDiscovery: boolean;
  private running = new Map<string, AbortController>();
  private readonly bindings: BindingStore;
  private readonly receipts: VerificationStore;
  /** The last scan's facts, so a binding can be applied without rescanning. */
  private scanned = new Map<
    ExternalEngine,
    { inventory: EngineCandidate[]; observed?: { location?: string; version?: string } }
  >();
  /**
   * The host's runtime seam. External turns do not call an adapter here;
   * they run through the harness RunService under a durable run, its lease
   * fence and its egress authorization. The app attaches the host's
   * `TextRouteRuntime.request` after the harness host exists.
   */
  dispatch?: TextDispatch;
  /** Explicit native-session route; attaching this does not change generate(). */
  nativeSessions?: ClaudeSessionRuns;
  /** The kept OpenCode session route (H04); attaching it does not change generate() either. */
  opencodeSessions?: ClaudeSessionRuns<OpenCodeSessionCheckpoint>;
  /** The kept ACP conversations (H05); attaching them does not change generate() either. */
  cursorSessions?: ClaudeSessionRuns<AcpSessionCheckpoint>;
  devinSessions?: ClaudeSessionRuns<AcpSessionCheckpoint>;
  /** The kept ChatGPT conversation driver (spec 3.2); the app attaches it. */
  codexSessions?: ClaudeSessionRuns<CodexSessionCheckpoint>;
  /** The processes a kept ChatGPT conversation runs on (`server/integrations.ts`); the app attaches it. */
  codexConversations?: CodexConversationPort;
  /** The model-API conversation driver (CD-01 Decision 5's second driver). The app attaches it. */
  modelSessions?: ModelSessionRuns;
  /** Connection record, protected credential, spend ledger and private transcripts for model-API routes. */
  modelApi?: ModelApiServices;
  /**
   * Parent-job caps. The app attaches the host's `JobCaps`; with it attached,
   * every model-API call is held against its job's cap as well as the
   * connection's, and a step that would pass the job's cap is never started.
   */
  jobCaps?: JobCapsPort;
  /**
   * The Nectovia Agent's admission (server/accounts/agent-gate.ts). The app attaches it when this
   * host signs people in. With it attached, every model-API admission (a conversation message, a
   * Work or team turn, a work loop starting or resuming) asks whether the business the work is for
   * includes the Agent. It runs before any model step, so a refusal is recorded as nothing sent.
   */
  agentGate?: AgentGatePort;
  /** Optional metadata observation (server/observability/). Bound only after every check below passed. */
  observation?: ObservationBinder;
  constructor(
    readonly root: string,
    deps: Partial<EngineServiceDeps> = {},
  ) {
    this.nativeDiscovery = !deps.discover;
    this.deps = {
      platform: process.platform,
      discover: async () => (await createDiscovery().discover()).engines,
      version: async (file, signal) => {
        const command =
          path.basename(file) === 'index.js'
            ? cursorCommand(file, ['--version'])
            : { file, args: ['--version'] };
        const result = await capture({
          ...command,
          cwd: root,
          env: engineEnvironment(),
          signal,
          timeoutMs: 5000,
          maxBytes: 4096,
        });
        if (result.code !== 0)
          throw new EngineError(
            'VERSION_UNKNOWN',
            'The tool could not report its version. Check its dependencies.',
          );
        const match = result.stdout.match(/\b\d+\.\d+(?:\.\d+)?(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?/);
        if (!match)
          throw new EngineError('VERSION_UNKNOWN', 'The installed version could not be verified.');
        return match[0];
      },
      adapter: (engine, file, cwd) => {
        if (engine === 'claude-code') return new ClaudeAdapter(file, cwd);
        if (engine === 'opencode') return new OpenCodeAdapter(file, cwd);
        if (engine === 'cursor') return new CursorAdapter(file, cwd);
        if (engine === 'devin') return new DevinAdapter(file, cwd);
        return new OmpAdapter(file, cwd);
      },
      // The host's own enumeration runs only when the host is this computer.
      ...(this.nativeDiscovery
        ? { enumerate: (scope?: DiscoveryScope) => createDiscovery().installations(scope) }
        : {}),
      verifyManaged: (engine, file, observedSha256) => verifyManagedBinary(root, engine, file, observedSha256),
      identify: (file) => readIdentity(file),
      ...deps,
    };
    this.bindings = new BindingStore(root);
    this.receipts = new VerificationStore(root);
    // A binding is a decision, so it survives a restart. What was merely
    // observed — sign-in, models, when it was last checked — does not. A
    // decision this build cannot read survives as the repair it is, so nothing
    // downstream mistakes it for a route nobody has chosen yet.
    for (const engine of EXTERNAL_ENGINES) this.connections.set(engine, this.recorded(engine));
  }
  /** What a route is before anything on this computer has been observed about it. */
  private recorded(engine: ExternalEngine): EngineConnection {
    if (this.bindings.unreadable(engine))
      return {
        ...blank(engine),
        repair: 'record-unreadable',
        detail: repairDetail(engine, 'record-unreadable', 'found'),
      };
    const stored = this.bindings.get(engine);
    if (!stored) return blank(engine);
    return { ...blank(engine), binding: stored.binding, revision: stored.revision };
  }
  /**
   * Read a record an earlier fault denied, before anything reads what it says.
   * A reader that held the file for a moment must not cost the person every
   * route until they restart, so the refusal it left behind is re-derived here
   * — from this pass's inventory where there is one, and from the record alone
   * otherwise, because a route nobody has looked for yet is not a route that
   * is missing.
   *
   * Rebuilding from the record cannot drop a revision `syncRevision` is
   * holding: this runs only where the file itself could not be read, and a
   * hold needs a stored row, which such a record has none of.
   */
  private reread() {
    if (!this.bindings.refresh()) return;
    for (const engine of EXTERNAL_ENGINES) {
      if (this.connections.get(engine)!.repair !== 'record-unreadable') continue;
      if (this.bindings.unreadable(engine)) continue;
      if (this.scanned.has(engine)) this.apply(engine, { discovered: false });
      else this.save(this.recorded(engine));
    }
  }
  status(): EngineConnection[] {
    return EXTERNAL_ENGINES.map((id) => this.present(id));
  }
  /**
   * One connection as a reader sees it: the facts this service observed, plus
   * the verification history that still describes them.
   */
  private present(engine: ExternalEngine): EngineConnection {
    return {
      ...structuredClone(this.connections.get(engine)!),
      verification: this.verificationFor(engine),
    };
  }
  /**
   * The last real result for this route, shown only while the stored receipt
   * still names what is selected now. It is compared against the binding
   * record rather than the live connection, because a restart reloads the
   * record while sign-in, models and the account route start unknown again.
   */
  private verificationFor(engine: ExternalEngine): ConnectionReceipt | null {
    const receipt = this.receipts.get(engine);
    const stored = this.bindings.get(engine);
    if (!receipt || !stored || receipt.engine !== engine) return null;
    if (receipt.revision !== stored.revision) return null;
    // The installation, not its version: a receipt survives the tool updating itself.
    if (receipt.candidateId !== stored.binding.id) return null;
    // The stored key is the exact tuple the revision was last moved for, so a
    // route or model that changed since fails here even after a restart.
    return revisionKey(stored.binding, receipt.accountRoute, receipt.model) === stored.key
      ? receipt
      : null;
  }
  private save(value: EngineConnection) {
    this.connections.set(value.engine, value);
    recordEngineCatalog({
      engine: value.engine,
      models: value.authentication === 'signed-in' ? value.models : [],
      detail: value.detail,
    });
    return this.present(value.engine);
  }
  /**
   * One file's identity, digested from its bytes on every look (DIO-86). The
   * digest is what a binding, its revision key and a run's evidence name, and
   * size and modification time do not prove the bytes: a same-length
   * replacement can put the modification time back. The read is bounded by
   * `DIGEST_LIMIT_BYTES`, and a scan already launches each candidate for its
   * version, which costs more than reading it.
   */
  private async identify(file: string): Promise<FileIdentity | null> {
    const identity = await this.deps.identify!(file);
    if (!identity) return null;
    return identity.sha256 ? identity : { ...identity, sha256: await digestFile(identity.path) };
  }

  /**
   * Every installation this computer offers for one route, examined one at a
   * time. A candidate that cannot be resolved, whose bytes fail their reviewed
   * digest, or whose version probe does not answer becomes that candidate's
   * own issue. It never throws out of the loop and never hides another route.
   */
  private async inventory(
    engine: ExternalEngine,
    enumerated: DiscoveredInstallation[],
  ): Promise<EngineCandidate[]> {
    const wanted: { file: string; source: 'managed' | 'system'; context: InstallationContext }[] =
      enumerated
        .filter((row) => row.engine === engine)
        .map((row) => ({ file: row.path, source: 'system' as const, context: row.context }));
    // Managed artifacts have Windows installation receipts, never Mac installations.
    if (this.deps.platform === 'win32') try {
      const file = managedBinary(this.root, engine);
      await fs.access(file);
      wanted.push({
        file,
        source: 'managed',
        context: installationContext(file, this.deps.platform),
      });
    } catch {
      // No private copy, or this engine has none. Neither hides the rest.
    }
    const rows: EngineCandidate[] = [];
    const seen = new Set<string>();
    for (const item of wanted) {
      const candidate = await this.examine(engine, item).catch((error: unknown) =>
        unusable(engine, item, 'unknown', sanitise(error)),
      );
      const key = process.platform === 'win32' ? candidate.id.toLowerCase() : candidate.id;
      // A shim and its target resolve to one file; report that file once.
      if (seen.has(key)) continue;
      seen.add(key);
      rows.push(candidate);
    }
    return rows;
  }

  private async examine(
    engine: ExternalEngine,
    item: { file: string; source: 'managed' | 'system'; context: InstallationContext },
  ): Promise<EngineCandidate> {
    let file = item.file;
    // A Windows shim is not the executable. Resolve it before anything else,
    // so identity and version describe what would actually run.
    if (engine === 'opencode' && /\.cmd$/i.test(file)) {
      const native = path.join(
        path.dirname(file),
        'node_modules',
        'opencode-ai',
        'bin',
        'opencode.exe',
      );
      if (await exists(native)) file = native;
    }
    if (engine === 'cursor' && /\.(cmd|bat)$/i.test(file)) {
      try {
        file = await resolveCursorEntry(file);
      } catch (error) {
        if (!recordShimError(error)) throw error;
        return unusable(engine, item, 'unknown', 'This launcher does not name a runnable Cursor CLI.');
      }
    }
    const identity = await this.identify(file);
    if (!identity)
      return unusable(
        engine,
        { ...item, file },
        'unknown',
        'This file could not be read on this computer. It was not run.',
      );
    const base = {
      id: `${item.source}:${engine}:${identity.path}`,
      engine,
      source: item.source,
      present: true,
      path: identity.path,
      sha256: identity.sha256,
      context: item.context,
    };
    if (item.source === 'managed') {
      // The reviewed digest decides before anything launches. A private copy
      // whose bytes changed is never asked for its version.
      try {
        await this.deps.verifyManaged!(engine, identity.path, identity.sha256);
      } catch (error) {
        return {
          ...base,
          version: '',
          integrity: 'failed',
          protocol: 'unknown',
          provenance: 'unverified',
          compatibility: 'unknown',
          issue: sanitise(error),
        };
      }
    }
    let version: string;
    try {
      version = await this.deps.version(identity.path);
    } catch (error) {
      return {
        ...base,
        version: '',
        integrity: item.source === 'managed' ? 'verified' : 'unknown',
        protocol: 'failed',
        provenance: item.source === 'managed' ? 'reviewed-release' : 'unverified',
        compatibility: 'unknown',
        issue: sanitise(error),
      };
    }
    return {
      ...base,
      version,
      // A managed copy's bytes matched the release Diomedes reviewed. Their own
      // copy has a recorded identity, so a later change is detected; that is
      // not a claim about who published it.
      integrity: 'verified',
      protocol: 'passed',
      provenance: item.source === 'managed' ? 'reviewed-release' : 'unverified',
      // Any version that answered its probe is usable.
      compatibility: 'supported',
    };
  }

  async discover(consent: boolean, scope: DiscoveryScope = {}): Promise<EngineConnection[]> {
    if (!consent)
      throw new EngineError(
        'CONSENT_REQUIRED',
        'Confirm the local discovery disclosure before checking this computer.',
      );
    this.reread();
    const key = scope.engine ?? '*';
    const active = this.scans.get(key);
    if (active) return active;
    const job = this.scan(scope);
    this.scans.set(key, job);
    try {
      return await job;
    } finally {
      this.scans.delete(key);
    }
  }

  private async scan(scope: DiscoveryScope): Promise<EngineConnection[]> {
    await fs.mkdir(this.root, { recursive: true });
    const engines = scope.engine ? [scope.engine] : [...EXTERNAL_ENGINES];
    let found: IntegrationStatus[] = [];
    // Whether this pass actually managed to look. A pass that did not is not a
    // success at the discovery stage, so it does not retire what the last
    // failure there recorded.
    let discovered = true;
    try {
      found = await this.deps.discover(scope);
    } catch (error) {
      discovered = false;
      for (const engine of engines) this.record(engine, error, 'discovery');
    }
    let enumerated: DiscoveredInstallation[] = [];
    try {
      enumerated = this.deps.enumerate
        ? await this.deps.enumerate(scope)
        : // A caller that supplied the inventory is the host: take what it named.
          found
            .filter((row) => row.found && row.location)
            .map((row) => ({
              engine: row.id,
              path: row.location!,
              context: installationContext(row.location!, this.deps.platform),
            }));
    } catch (error) {
      discovered = false;
      for (const engine of engines) this.record(engine, error, 'discovery');
    }
    for (const engine of engines) {
      this.discoveryDisclosure.set(engine, found.find((row) => row.id === engine)?.disclosure.filter((line) => line.startsWith('Discovery: ')) ?? []);
      try {
        const inventory = await this.inventory(engine, enumerated);
        const hit = found.find((row) => row.id === engine && row.found);
        if (!hit && inventory.some((row) => row.source === 'managed' && row.integrity === 'verified' && row.protocol === 'passed'))
          this.discoveryDisclosure.set(engine, [
            'Discovery: observed on win32 via managed-installation; installation receipt verified and version probed.',
          ]);
        this.scanned.set(engine, {
          inventory,
          observed: hit
            ? { location: hit.location, version: hit.installedVersion }
            : undefined,
        });
        this.apply(engine, { discovered });
      } catch (error) {
        // One route's failure is one route's diagnostic, never a blank roster.
        this.record(engine, error, 'discovery');
      }
    }
    return this.status();
  }

  /**
   * Turn this route's observed installations into the one effective state,
   * through the shared policy. Discovery recommends; only a person binds.
   */
  private apply(
    engine: ExternalEngine,
    context: { discovered?: boolean } = {},
  ): EngineConnection {
    const scanned = this.scanned.get(engine) ?? { inventory: [] };
    const inventory = scanned.inventory;
    let stored = this.bindings.get(engine);
    // A chosen installation that updated itself in place is followed before
    // anything is derived from the binding, so the record names what runs now.
    if (stored && !this.bindings.unreadable(engine)) {
      const current = selectCandidate(inventory, { engine }, stored.binding);
      if (current.kind === 'candidate') {
        this.followUpdate(engine, stored, current.candidate as EngineCandidate);
        stored = this.bindings.get(engine);
      }
    }
    const binding = stored?.binding ?? null;
    // What this pass proved. A failure recorded at one of these stages is
    // answered by it; a failure at any other stage is not, and is kept.
    const looked: SetupStage[] = context.discovered === false ? [] : ['discovery'];
    const shared = {
      candidates: inventory.map((row) => structuredClone(row)),
      binding,
      revision: stored?.revision ?? 0,
      checkedAt: new Date().toISOString(),
    };
    // What this route runs is a decision, and the record of that decision
    // cannot be read here. Nothing may stand in for it: not a recommendation,
    // not the private copy, not the roster. The installations are still
    // reported, because choosing one again is the way out.
    if (this.bindings.unreadable(engine))
      return this.merge(engine, {
        ...blank(engine),
        ...shared,
        ...installationState(inventory, null),
        repair: 'record-unreadable',
        detail: repairDetail(engine, 'record-unreadable', 'found'),
      }, looked);
    // Nothing on this computer could be identified and nothing is bound: report
    // what discovery saw without claiming a verified identity for it.
    //
    // "Could not be identified" is narrower than it once was. An empty
    // inventory is not evidence of an installation at all — the roster alone
    // never stands in for one — and a candidate that was examined and failed
    // (`protocol: 'failed'`: a WSL binary, a launcher that does not answer) has
    // already told this computer it cannot run. Only a candidate this computer
    // could not resolve far enough to examine leaves the roster as the last
    // honest word about it.
    if (
      !binding &&
      inventory.length > 0 &&
      inventory.every((row) => row.integrity === 'unknown' && row.protocol === 'unknown') &&
      scanned.observed
    ) {
      const { location, version } = scanned.observed;
      return this.merge(engine, {
        ...blank(engine),
        ...shared,
        installation: 'found',
        compatibility: version ? 'supported' : 'unknown',
        ...(location ? { location } : {}),
        ...(version ? { version } : {}),
        detail: version
          ? 'Found a compatible installation. Check sign-in and models next.'
          : 'Found an installation whose version could not be read. Check this computer again.',
      }, looked);
    }
    const decision = selectCandidate(inventory, { engine }, binding ?? undefined);
    if (decision.kind === 'candidate') {
      const chosen = decision.candidate as EngineCandidate;
      return this.merge(engine, {
        ...blank(engine),
        ...shared,
        installation: 'found',
        compatibility: 'supported',
        location: chosen.path,
        version: chosen.version,
        recommendedCandidateId: decision.requiresSelection ? chosen.id : null,
        detail: decision.requiresSelection
          ? 'Found a compatible installation. Check sign-in and models next.'
          : 'Using the installation you chose. Check sign-in and models next.',
      // The effective installation resolved, matched its digest and answered
      // its version probe, which is what runtime-verification asks of it.
      }, [...looked, 'runtime-verification']);
    }
    const state = installationState(inventory, binding);
    const corrupt = state.installation === 'corrupt';
    const failure = inventory.find((row) => row.issue);
    return this.merge(engine, {
      ...blank(engine),
      ...shared,
      ...state,
      repair: decision.reason,
      detail: repairDetail(engine, decision.reason, state.installation),
      ...(corrupt && failure
        ? {
            diagnostic: this.diagnostic(engine, {
              stage: 'runtime-verification',
              code: 'INSTALL_CHECKSUM',
              candidateSource: 'managed',
              // A copy that failed its digest has no version Diomedes trusts,
              // and the previous scan's version is not this failure's fact.
              installedVersion: null,
            }),
          }
        : {}),
    }, looked);
  }

  /**
   * Replace the inventory every time; keep a readiness observation only while
   * the very same executable is still the effective one.
   *
   * A reported account-route mismatch is such an observation. The adapter
   * reports it with `authentication: 'unknown'` and no models, because it did
   * not get far enough to say either — so a check that ended there is kept on
   * the same terms as one that ended signed in. Otherwise checking this
   * computer again, which asks no account anything, would retire what the last
   * check learned and send the person back to "check connection".
   */
  private merge(
    engine: ExternalEngine,
    next: EngineConnection,
    succeeded: SetupStage[] = [],
  ): EngineConnection {
    const old = this.connections.get(engine)!;
    const same =
      !!next.location &&
      next.location === old.location &&
      next.version === old.version &&
      (old.authentication === 'signed-in' || !!old.routeIssue);
    const carried = same
      ? {
          ...next,
          authentication: old.authentication,
          accountRoute: old.accountRoute,
          models: old.models,
          routeIssue: old.routeIssue ?? null,
          checkedAt: old.checkedAt,
          detail: old.detail,
        }
      : next;
    return this.save({ ...carried, diagnostic: this.lastFailure(old, next, succeeded) });
  }
  /**
   * The failure a connection still carries. A diagnostic is cleared by the next
   * success at its own stage, or by a change of the executable it was about —
   * and by nothing else. Checking this computer again is not a successful
   * sign-in, so it no longer retires what a failed sign-in recorded.
   *
   * A failure recorded while no executable was known is about this computer,
   * not about a file, so finding one afterwards does not answer it either.
   */
  private lastFailure(
    old: EngineConnection,
    next: EngineConnection,
    succeeded: SetupStage[],
  ): SetupDiagnostic | null {
    if (next.diagnostic) return next.diagnostic;
    if (!old.diagnostic) return null;
    const executable = (value: EngineConnection) => value.location ?? value.binding?.path ?? null;
    const before = executable(old);
    const sameSubject = before === null || before === executable(next);
    return sameSubject && !succeeded.includes(old.diagnostic.stage) ? old.diagnostic : null;
  }
  async check(engine: ExternalEngine, signal?: AbortSignal): Promise<EngineConnection> {
    this.reread();
    if (this.checks.has(engine))
      throw new EngineError(
        'REQUEST_ACTIVE',
        'This service is already being checked. Wait for that check before starting another request.',
      );
    const job = this.inspect(engine, signal);
    this.checks.set(engine, job);
    try {
      return await job;
    } finally {
      this.checks.delete(engine);
    }
  }
  /**
   * Wait for whatever check is already running on this route, then return.
   *
   * It never rejects and never answers with that check's result: a caller who
   * needs a fresh answer — the host after a native sign-in window closes, for
   * one — waits here and then runs its own `check()`. Joining the running job
   * instead would hand back an answer decided before the caller asked, which
   * is the defect this exists to avoid.
   */
  async settled(engine: ExternalEngine): Promise<void> {
    // A check that starts in the instant another finishes is waited out too,
    // but only so many times: a caller that keeps starting checks must not be
    // able to hold this wait open for ever. Past the bound the caller's own
    // `check()` is refused as active, which it already reads as "a newer check
    // is running".
    for (let handover = 0; handover <= SETTLE_HANDOVERS; handover++) {
      const active = this.checks.get(engine);
      if (!active) return;
      await active.then(
        () => {},
        () => {},
      );
    }
  }
  private async inspect(engine: ExternalEngine, signal?: AbortSignal) {
    const saved = this.connections.get(engine)!;
    // A binding that no longer names a usable installation is broken, and a
    // broken binding is never quietly replaced by whatever PATH offers now.
    // A record that cannot be read is the same refusal: what was chosen is
    // unknown, so nothing may be checked, and nothing may run, in its name.
    if ((saved.binding || saved.repair === 'record-unreadable') && saved.repair)
      throw new EngineError(
        'BINDING_CHANGED',
        repairDetail(engine, saved.repair, saved.installation === 'corrupt' ? 'corrupt' : 'found'),
        false,
        'runtime-verification',
      );
    if (saved.installation === 'corrupt')
      throw new EngineError(
        'INSTALL_CHECKSUM',
        repairDetail(engine, saved.repair ?? '', 'corrupt'),
        false,
        'runtime-verification',
      );
    if (saved.installation !== 'found')
      throw new EngineError('NOT_INSTALLED', 'The tool was not found. Check this computer again.');
    // An installation this computer found and cannot use is not "not found".
    // It is named as what it is, at the stage that decided it, so the person is
    // not sent looking for a tool that is sitting right there.
    if (saved.repair)
      throw new EngineError(
        'UNSUPPORTED_VERSION',
        repairDetail(engine, saved.repair, 'found'),
        false,
        'runtime-verification',
      );
    if (!saved.location)
      throw new EngineError('NOT_INSTALLED', 'The tool was not found. Check this computer again.');
    try {
      let file = saved.location;
      if (await this.isManaged(engine, saved)) {
        const identity = await this.identify(file);
        if (!identity) throw new EngineError('INSTALL_CHECKSUM', 'The selected managed executable could not be verified.');
        file = identity.path;
        await this.deps.verifyManaged!(engine, file, identity.sha256);
      }
      // Any version the tool reports is accepted; a failed probe throws VERSION_UNKNOWN.
      const version = await this.deps.version(file, signal);
      const cwd = path.join(this.root, engine);
      await fs.mkdir(cwd, { recursive: true });
      const result = await this.deps.adapter(engine, file, cwd).inspect(signal);
      const value = this.save({
        ...saved,
        ...result,
        compatibility: 'supported',
        version,
        routeIssue: result.routeIssue ?? null,
        diagnostic: null,
        checkedAt: new Date().toISOString(),
      });
      // The account route is part of what a receipt is written against.
      this.syncRevision(engine, value.accountRoute);
      return this.present(engine);
    } catch (error) {
      this.save({
        ...saved,
        authentication:
          error instanceof EngineError && error.code === 'AUTH_REQUIRED' ? 'signed-out' : 'unknown',
        models: [],
        accountRoute: null,
        // What the last check learned about the account is exactly what this
        // one failed to learn. A route issue is an observation of an account,
        // so it retires with the sign-in and models it was reported beside;
        // keeping it would answer a later question with an older answer.
        routeIssue: null,
        compatibility:
          error instanceof EngineError && error.code === 'UNSUPPORTED_VERSION'
            ? 'unsupported'
            : saved.compatibility,
        checkedAt: new Date().toISOString(),
        diagnostic: this.diagnostic(engine, {
          stage: stageOf(error),
          code: error instanceof EngineError ? error.code : 'CHECK_FAILED',
          candidateSource: this.effective(saved)?.source ?? null,
        }),
        detail:
          error instanceof EngineError
            ? error.message
            : 'The connection could not be checked. Recheck its installation, network and sign-in.',
      });
      throw error;
    }
  }
  /** The installation this route would actually run. */
  private effective(value: EngineConnection): EngineCandidate | undefined {
    const id = value.binding?.id ?? value.recommendedCandidateId;
    return value.candidates?.find((row) => row.id === id);
  }
  /**
   * Whether the effective installation is Diomedes's own private copy. Decided
   * by the candidate's source, never by comparing two path spellings: a
   * Windows 8.3 alias and its long name are the same file.
   */
  private async isManaged(engine: ExternalEngine, value: EngineConnection) {
    const chosen = this.effective(value);
    if (chosen) return chosen.source === 'managed';
    if (engine === 'cursor' || engine === 'devin' || !value.location) return false;
    try {
      const [a, b] = await Promise.all([
        realpathNative(value.location),
        realpathNative(managedBinary(this.root, engine)),
      ]);
      return a === b;
    } catch {
      return false;
    }
  }
  private diagnostic(
    engine: ExternalEngine,
    facts: {
      stage: SetupStage;
      code: string;
      candidateSource: EngineCandidate['source'] | null;
      /** The version of the installation this failure is about, when it differs. */
      installedVersion?: string | null;
    },
  ): SetupDiagnostic {
    const value = this.connections.get(engine)!;
    const stored = this.bindings.get(engine);
    return {
      buildId: this.deps.buildId?.() ?? 'unknown',
      engine,
      candidateSource: facts.candidateSource,
      installedVersion:
        facts.installedVersion === undefined ? (value.version ?? null) : facts.installedVersion,
      accountRoute: value.accountRoute,
      selectedModel: stored?.model ?? null,
      stage: facts.stage,
      code: facts.code,
      correlationId: randomUUID(),
      lastVerifiedAt: this.verificationFor(engine)?.verifiedAt ?? null,
      at: new Date().toISOString(),
    };
  }
  private record(engine: ExternalEngine, error: unknown, stage: SetupStage) {
    const saved = this.connections.get(engine)!;
    this.save({
      ...saved,
      checkedAt: new Date().toISOString(),
      detail: sanitise(error),
      diagnostic: this.diagnostic(engine, {
        stage: error instanceof EngineError && error.stage ? error.stage : stage,
        code: error instanceof EngineError ? error.code : 'SCAN_FAILED',
        // A scan that failed before it enumerated anything has no candidate to
        // point at, but the record still knows which installation this route
        // was bound to, and that is the first thing a diagnostic is read for.
        candidateSource:
          this.effective(saved)?.source ?? this.bindings.get(engine)?.binding.source ?? null,
      }),
    });
  }
  /**
   * Move the semantic revision only when the binding identity, the account
   * route or the selected model differs from what is recorded.
   */
  private syncRevision(engine: ExternalEngine, accountRoute: string | null, model?: string | null) {
    const stored = this.bindings.get(engine);
    if (!stored) return;
    const selected = model === undefined ? stored.model : model;
    const key = revisionKey(stored.binding, accountRoute, selected);
    if (key === stored.key) return;
    const moved = {
      binding: stored.binding,
      revision: stored.revision + 1,
      key,
      model: selected,
    };
    // A revision is an observation, not a choice. The record is written by an
    // explicit bind, by a selection settled where no record existed, and by the
    // one-time adoption — so while any part of it cannot be read, this is held
    // in memory and goes to disk with the next choice, rather than filing an
    // unreadable record away on nobody's say-so.
    if (this.bindings.intact()) this.bindings.save(engine, moved);
    else this.bindings.hold(engine, moved);
    const value = this.connections.get(engine)!;
    this.save({ ...value, revision: stored.revision + 1 });
  }
  /**
   * A person who chose this route before bindings existed keeps their choice:
   * the recommended installation is bound once, marked as carried rather than
   * picked. Nothing else ever binds on a person's behalf.
   */
  private adopt(engine: ExternalEngine) {
    const value = this.connections.get(engine)!;
    // Carrying a selection forward needs a record that says there was none.
    // One that cannot be read says nothing of the sort.
    if (this.bindings.unreadable(engine)) return;
    if (this.bindings.get(engine) || !value.recommendedCandidateId) return;
    const candidate = this.effective(value);
    if (candidate) this.bindCandidate(engine, candidate, 'adopted');
  }
  /**
   * The chosen installation updated itself in place: same path, new version and
   * digest, and it verified again. Record the new identity without moving the
   * revision, so an auto-update never asks the person to choose or test again.
   */
  private followUpdate(
    engine: ExternalEngine,
    stored: StoredBinding,
    candidate: EngineCandidate,
  ) {
    const old = stored.binding;
    if (old.version === candidate.version && old.sha256 === candidate.sha256) return;
    const binding: EngineBinding = { ...old, version: candidate.version, sha256: candidate.sha256 };
    // The key's tail is the account route and model it was last moved for.
    const [, , , , ...rest] = stored.key.split('|');
    const followed = {
      ...stored,
      binding,
      key: [binding.id, binding.path, binding.version, binding.sha256, ...rest].join('|'),
    };
    if (this.bindings.intact()) this.bindings.save(engine, followed);
    else this.bindings.hold(engine, followed);
  }
  /** Bind one observed candidate to this route and re-derive its state. */
  private bindCandidate(
    engine: ExternalEngine,
    candidate: EngineCandidate,
    origin: EngineBinding['origin'],
    model?: string,
  ) {
    const stored = this.bindings.get(engine);
    const binding: EngineBinding = {
      id: candidate.id,
      engine,
      source: candidate.source,
      path: candidate.path,
      version: candidate.version,
      sha256: candidate.sha256,
      boundAt: new Date().toISOString(),
      origin,
    };
    const value = this.connections.get(engine)!;
    const selected = model ?? stored?.model ?? null;
    const key = revisionKey(binding, value.accountRoute, selected);
    // Binding an installation and choosing its model are one decision when
    // they arrive together: the revision moves once, not twice.
    this.bindings.save(engine, {
      binding,
      revision: stored && stored.key === key ? stored.revision : (stored?.revision ?? 0) + 1,
      key,
      model: selected,
    });
    return this.apply(engine);
  }
  selection(engine: ExternalEngine, model: string) {
    const state = this.connections.get(engine)!;
    // Choosing a route and a model binds the recommended installation when
    // nothing is recorded yet. That is only honest while the record is one this
    // build can read and nothing recorded in it is broken: otherwise settling a
    // selection would turn a recommendation into a choice nobody made.
    if (state.repair)
      throw new EngineError(
        'BINDING_CHANGED',
        repairDetail(
          engine,
          state.repair,
          state.installation === 'corrupt' ? 'corrupt' : 'found',
        ),
        false,
        'runtime-verification',
      );
    // Checked before sign-in, because a reported route mismatch is not one.
    // That person did sign in; the kind of account they hold is what this
    // route cannot use, and signing in again would not change it.
    if (state.routeIssue)
      throw new EngineError(
        'ACCOUNT_ROUTE',
        `This installation is signed in to a different account. Diomedes uses ${state.routeIssue.required} for this route.`,
        false,
        'provider-auth',
      );
    if (
      state.authentication !== 'signed-in' ||
      state.compatibility !== 'supported' ||
      !state.accountRoute
    )
      throw new EngineError('AUTH_REQUIRED', 'Check sign-in before selecting this service.');
    if (freshness(state.checkedAt, Date.now()) !== 'fresh')
      throw new EngineError('STALE_STATUS', 'Recheck this connection before selecting it.');
    if (!state.models.some((row) => row.slug === model))
      throw new EngineError(
        'MODEL_UNAVAILABLE',
        'The selected model is no longer offered. Choose a model after rechecking.',
      );
    // Choosing this route is the moment a binding becomes explicit. It is kept
    // synchronous because the route that calls this saves settings in the same
    // breath, and because a choice must survive a crash one line later.
    const chosen = this.effective(state);
    if (!this.bindings.get(engine) && chosen) this.bindCandidate(engine, chosen, 'explicit', model);
    else this.syncRevision(engine, state.accountRoute, model);
    return { engine, model, accountRoute: state.accountRoute };
  }
  /**
   * The one next action a screen offers for this route, derived here so no
   * screen computes its own. A reported account-route mismatch outranks the
   * sign-in state: that person is not signed out, they hold a different route.
   */
  nextAction(
    engine: ExternalEngine,
    facts: { enabled: boolean; installSupported: boolean },
  ): SetupAction {
    const value = this.connections.get(engine)!;
    if (value.installation === 'not-checked') return 'check-connection';
    // A route needs repair and this computer still offers a usable
    // installation: the honest next step is choosing one, not installing
    // another copy. `no-reviewed-candidate` and a corrupt private copy cannot
    // reach this, because neither leaves a usable candidate behind.
    if (
      value.repair &&
      selectCandidate(value.candidates ?? [], { engine }).kind === 'candidate'
    )
      return 'choose-installation';
    const installation =
      value.installation === 'corrupt'
        ? 'corrupt'
        : value.installation !== 'found'
          ? 'missing'
          : value.compatibility === 'supported' && !value.repair
            ? 'ready'
            : 'unsupported';
    if (installation === 'ready' && value.routeIssue) return 'explain-account-route';
    return nextSetupAction(
      {
        installation,
        installSupported: facts.installSupported,
        authentication: value.authentication,
        accountRouteAllowed: !value.routeIssue,
        modelCount: value.models.length,
        enabled: facts.enabled,
        checkedAt: value.checkedAt,
        revision: value.revision ?? 0,
        verifiedRevision: this.verificationFor(engine)?.revision ?? null,
      },
      Date.now(),
    );
  }
  /**
   * Bind the installation a person chose for this route. Only an explicit call
   * here (or the one-time adoption of a pre-binding selection) ever sets a
   * binding; discovery recommends and never binds.
   */
  async bind(engine: ExternalEngine, candidateId: string): Promise<EngineConnection> {
    // The id must name something this computer offers right now. A path from a
    // screen is never bound, and a stale id never resurrects a removed file.
    await this.discover(true, { engine });
    const value = this.connections.get(engine)!;
    const candidate = value.candidates?.find((row) => row.id === candidateId);
    if (!candidate)
      throw new EngineError(
        'CANDIDATE_UNKNOWN',
        'That installation is not one this computer currently offers. Check this computer again, then choose.',
        false,
        'discovery',
      );
    const decision = selectCandidate([candidate], { engine });
    if (decision.kind !== 'candidate')
      throw new EngineError(
        'CANDIDATE_UNUSABLE',
        candidate.issue ?? 'That installation did not answer when Diomedes checked it.',
        false,
        'runtime-verification',
      );
    return this.bindCandidate(engine, candidate, 'explicit');
  }
  /**
   * One consented, bounded, synthetic request through the ordinary admitted
   * dispatch path. Never called by a scan, a sign-in or a settings reopen.
   *
   * It may use the person's allowance or incur a provider charge, so it runs
   * only on an explicit say-so, one route at a time, once. There is no retry:
   * a dispatch whose outcome is uncertain may already have been billed.
   */
  async testConnection(
    engine: ExternalEngine,
    input: { consent: boolean; model: string; signal?: AbortSignal },
  ): Promise<ConnectionReceipt> {
    if (input.consent !== true)
      throw new EngineError(
        'CONSENT_REQUIRED',
        'Confirm that this test sends one small request through your selected service first.',
        false,
        'discovery',
      );
    if (this.tests.has(engine))
      throw new EngineError(
        'REQUEST_ACTIVE',
        'This service is already being tested. Wait for that test before starting another.',
      );
    const job = this.test(engine, input.model, input.signal);
    this.tests.set(engine, job);
    try {
      return await job;
    } finally {
      this.tests.delete(engine);
    }
  }
  private async test(
    engine: ExternalEngine,
    model: string,
    caller?: AbortSignal,
  ): Promise<ConnectionReceipt> {
    let streamed = false;
    try {
      // Settling the selection first is what makes a receipt mean anything: it
      // refuses an account this route cannot use before anything is sent,
      // refuses a model this connection does not currently list, refuses a
      // stale or signed-out connection with the existing errors, and names the
      // one account route the admission below will accept.
      const selected = this.selection(engine, model);
      const stored = this.bindings.get(engine);
      if (!stored)
        throw new EngineError(
          'BINDING_REQUIRED',
          'Choose which installation this service uses before testing it.',
          false,
          'discovery',
        );
      // Captured before anything is sent. If the binding, account route or
      // model moves while the answer is in flight, the receipt stays on this
      // revision and cannot verify whatever is selected when it lands.
      const captured = {
        revision: stored.revision,
        candidateId: stored.binding.id,
        version: stored.binding.version,
        accountRoute: selected.accountRoute,
        model: selected.model,
      };
      const signal = AbortSignal.any([
        AbortSignal.timeout(TEST_TIMEOUT_MS),
        ...(caller ? [caller] : []),
      ]);
      // A fresh request id every time: the durable run id derives from it, so
      // a test never lands on an earlier run's recorded outcome.
      const answer = await this.generate(engine, {
        projectId: HOST_TEST_PROJECT,
        threadId: hostTestThread(engine),
        requestId: `test-${randomUUID()}`,
        model: captured.model,
        accountRoute: captured.accountRoute,
        prompt: TEST_PROMPT,
        instructions: '',
        documents: [],
        signal,
        // Frames are discarded. They are read for one thing only: whether the
        // route had started answering when a failure happened.
        onPreview: () => {
          streamed = true;
        },
      });
      if (!answer.text.trim())
        throw new EngineError(
          'EMPTY_ANSWER',
          'The service accepted the request and returned nothing. Nothing was verified.',
          true,
        );
      const receipt: ConnectionReceipt = {
        engine,
        ...captured,
        runId: answer.runId,
        buildId: this.deps.buildId?.() ?? 'unknown',
        verifiedAt: new Date().toISOString(),
      };
      // Recorded before it is returned. A receipt Diomedes could not save is a
      // receipt it does not claim, so the save's failure is the test's failure.
      try {
        this.receipts.save(engine, receipt);
      } catch {
        // The reason names a file, and a person's screen is not where a path
        // belongs. The support diagnostic carries the stage and the code.
        throw new EngineError(
          'RECEIPT_UNSAVED',
          'The service answered, but Diomedes could not record the proof. Nothing was verified.',
          false,
          'cleanup',
        );
      }
      // A test that answered clears the failure an earlier one left behind.
      this.save({ ...this.connections.get(engine)!, diagnostic: null });
      return structuredClone(receipt);
    } catch (error) {
      // Something else being in progress is a reason to wait, not a failure of
      // the connection, so it is not filed against it — the same reading that
      // leaves a declined test with a clean record.
      if (error instanceof EngineError && error.code === 'REQUEST_ACTIVE') throw error;
      // Written down before the caller hears about it: the screen re-reads
      // status the moment this rejects.
      const value = this.connections.get(engine)!;
      this.save({
        ...value,
        diagnostic: this.diagnostic(engine, {
          stage: testStage(error, streamed),
          code: error instanceof EngineError ? error.code : 'TEST_FAILED',
          candidateSource: this.effective(value)?.source ?? null,
        }),
      });
      throw error;
    }
  }
  integration(engine: ExternalEngine, enabled: boolean): IntegrationStatus {
    const value = this.connections.get(engine)!;
    const fresh = freshness(value.checkedAt, Date.now()) === 'fresh';
    const ready =
      value.installation === 'found' &&
      value.compatibility === 'supported' &&
      !value.repair &&
      value.authentication === 'signed-in' &&
      value.models.length > 0 &&
      fresh;
    return {
      id: engine,
      name: ENGINE_NAMES[engine],
      kind: 'online',
      found: value.installation === 'found',
      available: ready,
      enabled,
      status: ready
        ? 'Ready'
        : value.installation === 'not-checked'
          ? 'Not checked'
          : value.installation === 'missing'
            ? 'Not installed'
            : value.authentication === 'signed-out'
                ? 'Sign in required'
                : 'Check connection',
      detail: fresh ? value.detail : 'Recheck this connection before use.',
      signIn: value.authentication === 'signed-out' ? 'not-signed-in' : value.authentication,
      adapter: 'ready',
      installedVersion: value.version,
      provenVersion: TESTED_VERSIONS[engine],
      location: value.location,
      capabilities: ready ? ['ask', 'plan', 'work-proposals'] : [],
      disclosure: [
        ...(this.discoveryDisclosure.get(engine) ?? []),
        'Selected text is sent to the chosen service using its native account route.',
        engine === 'cursor'
          ? 'Cursor denies tools through native permissions and stops on tool events; this is not an operating-system sandbox.'
          : engine === 'devin'
            ? 'Devin runs in ask mode with project deny rules and stops on tool events; its own MCP configuration still loads. This is not an operating-system sandbox.'
            : 'Tools are disabled by the engine configuration; this is not an operating-system sandbox.',
        'Diomedes reviews exact file proposals through its existing approvals and History.',
        'Usage remaining is unknown unless reported by the provider.',
      ],
    };
  }
  /**
   * One text route's admission, read fresh: this route's discovery, its sign-in, the chosen
   * model and account route, and the contract the adapter carries. A conversation turn and an
   * external team worker run exactly these checks.
   */
  private async admitText(
    engine: ExternalEngine,
    model: string,
    accountRoute: string | null,
    signal?: AbortSignal,
  ): Promise<TextAdmission> {
    // Refresh this route, not all five: admission is on the hot path.
    await this.discover(true, { engine });
    this.adopt(engine);
    await this.check(engine, signal);
    const selected = this.selection(engine, model);
    if (selected.accountRoute !== accountRoute)
      throw new EngineError(
        'ACCOUNT_CHANGED',
        'The sign-in route changed. Select it again before sending.',
      );
    const value = this.connections.get(engine)!;
    const adapter = this.deps.adapter(engine, value.location!, path.join(this.root, engine));
    // The descriptor the adapter carries is operative: dispatch only
    // what the route declares, only for the proven build.
    if (adapter.id !== engine)
      throw new EngineError(
        'CONTRACT_MISMATCH',
        `The ${engine} route was handed an adapter identifying as ${adapter.id}.`,
        true,
      );
    const gate = commandGate(adapter.contract, 'start');
    if (!gate.admitted)
      throw new EngineError(
        gate.code === 'command_unsupported' ? 'COMMAND_UNSUPPORTED' : 'CONTRACT_INVALID',
        gate.reason,
        true,
      );
    if (
      adapter.contract.routeId !== engine ||
      adapter.contract.engine.id !== engine
    )
      throw new EngineError(
        'CONTRACT_MISMATCH',
        'The adapter descriptor does not name this route and engine.',
        true,
      );
    return {
      engine,
      location: value.location!,
      version: value.version!,
      model: selected.model,
      accountRoute: selected.accountRoute,
    };
  }
  /**
   * An external team worker's admission (subscription-aware orchestration S2): the checks a
   * conversation turn runs, read fresh. The worker's own run is its durable record, so no
   * text run is opened here.
   */
  admitWorkerTurn(engine: ExternalEngine, input: { model: string; accountRoute: string | null }, signal?: AbortSignal) {
    return this.admitText(engine, input.model, input.accountRoute, signal);
  }
  /**
   * One admitted worker turn, sent straight to the engine's own adapter with its tools off: no
   * read scope, no team carriage, no preview sinks. The caller's `model:<n>` step records it and
   * never resends it, so nothing here retries.
   */
  async workerTurn(
    engine: ExternalEngine,
    admission: TextAdmission,
    input: {
      projectId: string;
      threadId: string;
      requestId: string;
      prompt: string;
      documents: { path: string; text: string }[];
      instructions: string;
      effort?: string;
      signal: AbortSignal;
    },
  ): Promise<TextResponse> {
    if (admission.engine !== engine)
      throw new EngineError('CONTRACT_MISMATCH', `This worker was admitted on ${admission.engine}, not ${engine}.`, true);
    const adapter = this.deps.adapter(engine, admission.location, path.join(this.root, engine));
    if (adapter.id !== engine)
      throw new EngineError(
        'CONTRACT_MISMATCH',
        `The ${engine} route was handed an adapter identifying as ${adapter.id}.`,
        true,
      );
    input.signal.throwIfAborted();
    const result = await adapter.generate({
      projectId: input.projectId,
      threadId: input.threadId,
      requestId: input.requestId,
      prompt: input.prompt,
      documents: input.documents,
      instructions: input.instructions,
      model: admission.model,
      accountRoute: admission.accountRoute,
      ...(input.effort ? { effort: input.effort } : {}),
      signal: input.signal,
    });
    if (input.signal.aborted)
      throw new EngineError('CANCELLED', 'The request was stopped. No late response was saved.', true);
    if (
      result.projectId !== input.projectId ||
      result.threadId !== input.threadId ||
      result.requestId !== input.requestId
    )
      throw new EngineError(
        'IDENTITY_MISMATCH',
        'The engine response did not match this request. No response was saved.',
        true,
      );
    // Version attribution comes from this installation's fresh admission.
    return { ...result, version: admission.version };
  }
  /**
   * One admitted external text turn. Admission runs inside the run's recorded
   * `text:admission` step; the provider transport runs inside the fenced
   * `text:dispatch` step. Preview frames are stamped with the run, step,
   * attempt and fence of the attempt that produced them.
   */
  async generate(
    engine: ExternalEngine,
    input: TextRequest,
  ): Promise<TextResponse & { runId: string }> {
    const key = `${input.projectId}:${input.threadId}`;
    // Only a route whose adapter carries the team service over MCP accepts team tools;
    // every other adapter would drop them, so the request is refused by name instead.
    if (input.team && (engine !== 'claude-code' || TEAM_CARRIAGE[engine] !== 'mcp'))
      throw new EngineError('ROUTE_REFUSED', teamRouteRefusal(engine) ?? 'Team tools cannot ride on this request.', true);
    if (this.running.has(key))
      throw new EngineError(
        'REQUEST_ACTIVE',
        'This thread already has a request in progress. Wait for it or cancel it.',
      );
    const dispatch = this.dispatch;
    if (!dispatch)
      throw new EngineError(
        'RUNTIME_UNAVAILABLE',
        'The harness runtime seam is not attached to this service.',
        true,
      );
    const controller = new AbortController();
    this.running.set(key, controller);
    const signal = AbortSignal.any([controller.signal, ...(input.signal ? [input.signal] : [])]);
    try {
      if (input.onDelta || input.onToolActivity || input.onReasoningDelta)
        throw new EngineError(
          'PREVIEW_CONTRACT',
          'Preview frames reach the caller through onPreview and onActivity; the raw adapter sinks are not caller-facing.',
          true,
        );
      const runId = textRunId(input.projectId, input.requestId);
      const previewFailures: PreviewRejection[] = [];
      // The latest attempt's thinking; a replayed outcome streams none and keeps none.
      let thinking: ReasoningSink | undefined;
      const outcome = await dispatch<TextAdmission, TextResponse>({
        runId,
        intent: {
          engine,
          projectId: input.projectId,
          threadId: input.threadId,
          requestId: input.requestId,
          model: input.model,
          accountRoute: input.accountRoute,
          prompt: input.prompt,
          instructions: input.instructions,
          documents: input.documents,
          effort: input.effort ?? null,
        },
        signal,
        admit: () => this.admitText(engine, input.model, input.accountRoute, signal),
        send: async (context, admission) => {
          const adapter = this.deps.adapter(
            engine,
            admission.location,
            path.join(this.root, engine),
          );
          // Stamp the attempt, then check its current durable ownership at
          // publication. Transport cancellation alone cannot fence a preview.
          const attemptSignal = AbortSignal.any([signal, context.signal]);
          let accepting = true;
          let pending = Promise.resolve();
          let publicationFailure: { error: unknown } | undefined;
          // Text and tool activity share one ordered, fenced publication queue, so
          // a tool line never overtakes the text written before it.
          const publish = (deliver: () => void) => {
            if (!accepting || publicationFailure) return;
            pending = pending
              .then(async () => {
                if (publicationFailure) return;
                await context.publishPreview(() => {
                  if (!attemptSignal.aborted) deliver();
                });
              })
              .catch((error: unknown) => {
                publicationFailure = { error };
              });
          };
          const identity = {
            projectId: input.projectId,
            threadId: input.threadId,
            requestId: input.requestId,
            runId,
            stepId: TEXT_DISPATCH_STEP,
            attempt: context.attempt,
            fence: context.fence,
          };
          // Text and thinking hold back their newest part until it is safe to redact
          // (LIVE_REDACTION); the attempt's order keeps every channel as the engine wrote it.
          const order = liveOrder();
          const onDelta = previewSink({
            identity,
            redact: this.deps.redactFor?.(engine),
            onPreview: (frame) => publish(() => input.onPreview?.(frame)),
            onInvalid: (failure) => previewFailures.push(failure),
            signal: attemptSignal,
            order,
          });
          const onToolActivity = activitySink({
            identity,
            redact: this.deps.redactFor?.(engine),
            onActivity: (frame) => publish(() => input.onActivity?.(frame)),
            signal: attemptSignal,
            order,
          });
          // Thinking only where the route declares it, on the same ordered, fenced queue as text.
          thinking =
            input.onReasoning && adapter.contract.streaming.reasoning === 'reasoning-delta'
              ? reasoningSink({
                  identity,
                  redact: this.deps.redactFor?.(engine),
                  onReasoning: (frame) => publish(() => input.onReasoning?.(frame)),
                  signal: attemptSignal,
                  order,
                })
              : undefined;
          let result: TextResponse;
          try {
            result = await adapter.generate({
              ...input,
              signal: attemptSignal,
              onDelta,
              onActivity: undefined,
              onToolActivity,
              onReasoning: undefined,
              onReasoningDelta: thinking,
            });
          } finally {
            // What the channels still hold is shown before they close.
            order.flush();
            accepting = false;
            // Drain ordered publications before the step can commit or fail.
            await pending;
          }
          if (publicationFailure) throw publicationFailure.error;
          if (attemptSignal.aborted)
            throw new EngineError(
              'CANCELLED',
              'The request was stopped. No late response was saved.',
              true,
            );
          if (
            result.projectId !== input.projectId ||
            result.threadId !== input.threadId ||
            result.requestId !== input.requestId
          )
            throw new EngineError(
              'IDENTITY_MISMATCH',
              'The engine response did not match this request. No response was saved.',
              true,
            );
          if (previewFailures.length)
            throw new EngineError('OUTPUT_LIMIT', previewFailures[0].reason, true);
          // Version attribution comes from this installation's fresh admission,
          // not the adapter author's historical verification build.
          return { ...result, version: admission.version };
        },
      });
      const reasoning = thinking?.finish() ?? null;
      return { ...outcome.result, runId: outcome.run.id, ...(reasoning ? { reasoning } : {}) };
    } catch (error) {
      throw seamError(error);
    } finally {
      // Invalidate callbacks retained by a transport after either outcome.
      // A settled request must not publish previews into a later request.
      controller.abort();
      this.running.delete(key);
    }
  }
  async claudeSession(
    mode: ClaudeSessionTurn['mode'],
    runId: string,
    input: TextRequest,
    sourceRunId?: string,
    /** H03: wait behind a running turn (the route's steer queue) instead of being refused. */
    options: { queued?: boolean } = {},
  ) {
    return this.nativeTurn(
      { engine: 'claude-code', routeId: 'claude-code-session', driver: this.nativeSessions, name: 'Claude' },
      mode,
      runId,
      input,
      sourceRunId,
      options,
    );
  }
  /**
   * The kept OpenCode session (H04): the same admission, contract gate, fenced
   * preview queue and driver lifecycle as the Claude session, under OpenCode's
   * own route contract and tested version.
   */
  async opencodeSession(
    mode: ClaudeSessionTurn['mode'],
    runId: string,
    input: TextRequest,
    sourceRunId?: string,
    /** Wait behind a running turn (the route's steer queue) instead of being refused. */
    options: { queued?: boolean } = {},
  ) {
    return this.nativeTurn(
      { engine: 'opencode', routeId: 'opencode-session', driver: this.opencodeSessions, name: 'OpenCode' },
      mode,
      runId,
      input,
      sourceRunId,
      options,
    );
  }
  /**
   * A kept ACP conversation (H05): the same admission, contract gate, fenced
   * preview queue and driver lifecycle, under the agent's own session contract.
   */
  async acpSession(
    engine: AcpSessionEngine,
    mode: ClaudeSessionTurn['mode'],
    runId: string,
    input: TextRequest,
    sourceRunId?: string,
  ) {
    return this.nativeTurn(
      {
        engine,
        routeId: `${engine}-session`,
        driver: engine === 'cursor' ? this.cursorSessions : this.devinSessions,
        name: engine === 'cursor' ? 'Cursor' : 'Devin',
      },
      mode,
      runId,
      input,
      sourceRunId,
    );
  }
  /**
   * The kept ChatGPT conversation (spec 3.2): the same contract gate, fenced preview queue and
   * driver lifecycle as the other kept sessions, on Diomedes' own Codex runtime. ChatGPT isn't one
   * of the scanned engines: its profile opens the conversation's process and checks its ChatGPT
   * account before a turn is recorded, so a refusal there is known not sent.
   */
  async codexSession(
    mode: ClaudeSessionTurn['mode'],
    runId: string,
    input: TextRequest,
    sourceRunId?: string,
    /** Wait behind a running turn (the route's steer queue) instead of being refused. */
    options: { queued?: boolean } = {},
  ) {
    const conversations = this.codexConversations;
    return this.nativeTurn(
      { engine: 'codex', routeId: 'codex-session', driver: this.codexSessions, name: 'Codex' },
      mode,
      runId,
      input,
      sourceRunId,
      options,
      {
        contract: routeContractFor('codex-session'),
        admit: async () => {
          if (!conversations)
            throw new EngineError('RUNTIME_UNAVAILABLE', 'The Codex conversation runtime is not attached.');
          if (input.accountRoute !== CODEX_ACCOUNT_ROUTE)
            throw new EngineError(
              'ACCOUNT_CHANGED',
              'The ChatGPT account route changed. Select it again.',
              false,
              'provider-auth',
            );
          // Observe the current installation. The process that executes the turn
          // reports its version again; saved evidence never freezes future builds.
          const observed = await (async () => {
            try {
              if (conversations.inspect) return await conversations.inspect();
              const process = await conversations.open(undefined);
              try { return { location: 'diomedes-codex', version: process.version }; }
              finally { await process.close(); }
            } catch (error) {
              throw codexSessionError(error, false);
            }
          })();
          return {
            ...observed,
            model: input.model,
            accountRoute: CODEX_ACCOUNT_ROUTE,
          };
        },
        open: (_admission, request, sessionOptions) =>
          openCodexSession(conversations!, request, sessionOptions),
      },
    );
  }
  private async nativeTurn<C extends SessionCheckpointFacts>(
    route: {
      engine: 'claude-code' | 'opencode' | AcpSessionEngine | 'codex';
      routeId: string;
      driver: ClaudeSessionRuns<C> | undefined;
      name: string;
    },
    mode: ClaudeSessionTurn['mode'],
    runId: string,
    input: TextRequest,
    sourceRunId?: string,
    options: { queued?: boolean } = {},
    /**
     * A route whose sessions aren't opened through a scanned engine's adapter (ChatGPT): its own
     * admission and opener, under its declared contract and the same command gate.
     */
    transport?: {
      contract: AdapterRouteContract;
      admit(signal?: AbortSignal): Promise<ClaudeSessionAdmission>;
      open: ClaudeSessionTurn<C>['open'];
    },
  ) {
    const driver = route.driver;
    if (!driver)
      throw new EngineError('RUNTIME_UNAVAILABLE', 'The native session runtime is not attached.');
    if (input.onDelta || input.onToolActivity || input.onReasoningDelta)
      throw new EngineError('PREVIEW_CONTRACT', 'Use the bounded onPreview and onActivity channels.');
    // What the route declares, read from the adapter admission resolved for this request.
    let declared: AdapterRouteContract | undefined;
    let thinking: ReasoningSink | undefined;
    /** Only a scanned engine opens through an adapter; ChatGPT opens through its transport. */
    const scanned = () => {
      const engine = route.engine;
      if (engine === 'codex')
        throw new EngineError('COMMAND_UNSUPPORTED', 'This adapter has no native session transport.');
      return engine;
    };
    const adapterAt = (location: string) => {
      const engine = scanned();
      const adapter = this.deps.adapter(engine, location, path.join(this.root, engine));
      if (
        !('openSession' in adapter) ||
        typeof adapter.openSession !== 'function' ||
        !('sessionContract' in adapter)
      )
        throw new EngineError(
          'COMMAND_UNSUPPORTED',
          'This adapter has no native session transport.',
        );
      const persistent = adapter as PersistentTextAdapter<C>;
      const gate = commandGate(persistent.sessionContract, mode);
      if (
        adapter.id !== engine ||
        persistent.sessionContract.routeId !== route.routeId ||
        persistent.sessionContract.engine.id !== engine ||
        !gate.admitted
      )
        throw new EngineError(
          'CONTRACT_MISMATCH',
          'The native session contract does not match this route and protocol.',
        );
      declared = persistent.sessionContract;
      return persistent;
    };
    try {
      const result = await driver.request({
        mode,
        runId,
        sourceRunId,
        input,
        redact: this.deps.redactFor?.(route.engine),
        ...(options.queued ? { queued: true } : {}),
        admit: transport
          ? async (signal) => {
              if (!commandGate(transport.contract, mode).admitted)
                throw new EngineError(
                  'CONTRACT_MISMATCH',
                  'The native session contract does not match this route and build.',
                );
              declared = transport.contract;
              return transport.admit(signal);
            }
          : async (signal) => {
              const engine = scanned();
              await this.discover(true);
              await this.check(engine, signal);
              const selected = this.selection(engine, input.model);
              if (selected.accountRoute !== input.accountRoute)
                throw new EngineError(
                  'ACCOUNT_CHANGED',
                  `The ${route.name} account route changed. Select it again.`,
                );
              const value = this.connections.get(engine)!;
              adapterAt(value.location!);
              return {
                location: value.location!,
                version: value.version!,
                model: selected.model,
                accountRoute: selected.accountRoute,
              };
            },
        open: transport
          ? transport.open
          : (admission, request, options) =>
              adapterAt(admission.location).openSession(request, options),
        preview: (context, stepId) => {
          let accepting = true;
          let pending = Promise.resolve();
          let failure: { error: unknown } | undefined;
          const signal = AbortSignal.any([context.signal, ...(input.signal ? [input.signal] : [])]);
          // One ordered, fenced queue for text and tool activity alike.
          const publish = (deliver: () => void) => {
            if (!accepting || failure) return;
            pending = pending
              .then(async () => {
                if (failure) return;
                await context.publishPreview(() => {
                  if (!signal.aborted) deliver();
                });
              })
              .catch((error: unknown) => {
                failure = { error };
              });
          };
          const identity = {
            projectId: input.projectId,
            threadId: input.threadId,
            requestId: input.requestId,
            runId,
            stepId,
            attempt: context.attempt,
            fence: context.fence,
          };
          const order = liveOrder();
          const onDelta = previewSink({
            identity,
            signal,
            order,
            redact: this.deps.redactFor?.(route.engine),
            onInvalid: (invalid) => {
              failure = { error: new EngineError('OUTPUT_LIMIT', invalid.reason, true) };
            },
            onPreview: (frame) => publish(() => input.onPreview?.(frame)),
          });
          const onToolActivity = activitySink({
            identity,
            signal,
            order,
            redact: this.deps.redactFor?.(route.engine),
            onActivity: (frame) => publish(() => input.onActivity?.(frame)),
          });
          thinking =
            input.onReasoning &&
            (declared ?? routeContractFor(route.routeId)).streaming.reasoning === 'reasoning-delta'
              ? reasoningSink({
                  identity,
                  signal,
                  order,
                  redact: this.deps.redactFor?.(route.engine),
                  onReasoning: (frame) => publish(() => input.onReasoning?.(frame)),
                })
              : undefined;
          return {
            onDelta,
            onToolActivity,
            onReasoningDelta: thinking,
            finish: async () => {
              // What the channels still hold is shown before they close.
              order.flush();
              accepting = false;
              await pending;
              if (failure) throw failure.error;
            },
          };
        },
      });
      const reasoning = thinking?.finish() ?? null;
      return reasoning && result.response
        ? { ...result, response: { ...result.response, reasoning } }
        : result;
    } catch (error) {
      throw seamError(engineGone(route.engine, error) ?? error);
    }
  }
  /**
   * The spend ledger this request's calls hold against: the ledger itself held
   * to the request's job. The job is named by the request id and its tier comes
   * from its thread, both read by the host; nothing in a request body sets a cap.
   */
  private async jobLedger(api: ModelApiServices, input: Pick<TextRequest, 'projectId' | 'requestId'> & { threadId?: string | null }): Promise<SpendExposure> {
    if (!this.jobCaps) return api.exposure;
    const scope = await this.jobCaps.scope(input.projectId, input.requestId, input.threadId ?? null);
    const held = this.jobLedgerViews.get(scope.id);
    if (held?.base === api.exposure && held.cap === scope.capMicroUsd) return held.view;
    const view = api.exposure.forJob(scope);
    this.jobLedgerViews.set(scope.id, { base: api.exposure, cap: scope.capMicroUsd, view });
    return view;
  }
  /** Resolve once from the original raw request id; callers preserve this scope across roles. */
  async rootJobLedger(projectId: string, rawJobId: string, threadId: string | null = null): Promise<SpendExposure> {
    if (!this.modelApi) throw new EngineError('RUNTIME_UNAVAILABLE', 'The model-API runtime is not attached to this service.', true);
    return this.jobLedger(this.modelApi, { projectId, requestId: rawJobId, threadId });
  }
  /**
   * Record where a job stopped at its check-in, so Keep going can raise the next one from it. The local
   * ledger stops a job with its own numbers; the account service can stop it first, at the same amount,
   * and that refusal (nothing sent, hold released) is the same stop, recorded at the cap the job holds.
   */
  private async noteJobStop(error: unknown, job?: { projectId?: string; requestId?: string }) {
    if (error instanceof ModelApiError && isManagedCheckIn(error)) {
      if (this.jobCaps?.noteManagedStop && job?.projectId && job.requestId)
        await this.jobCaps.noteManagedStop(job.projectId, job.requestId).catch(() => undefined);
      return;
    }
    const stopped = error instanceof ModelApiError ? error.evidence.job : null;
    if (!stopped || !this.jobCaps) return;
    await this.jobCaps
      .noteStop(stopped.id, {
        usedMicroUsd: stopped.usedMicroUsd as MicroUsd,
        capMicroUsd: stopped.capMicroUsd as MicroUsd,
        neededMicroUsd: stopped.neededMicroUsd as MicroUsd,
      })
      .catch(() => undefined);
  }
  /**
   * The declared price card a model-API route would use for a model, for the
   * pre-send estimate. Null when the route is not connected, does not serve the
   * model, or has no declared price for it: an unknown price, never zero.
   */
  async modelApiCard(route: ModelApiRoute, model: string): Promise<ModelRateCard | null> {
    const api = this.modelApi;
    if (!api) return null;
    try {
      const handle = await modelApiRoute(api, route);
      if (!handle.connected || !handle.serves(model)) return null;
      return handle.card(model);
    } catch {
      return null;
    }
  }
  /**
   * Admission for a model-API route, read fresh each time: the route is switched on, the saved
   * connection is the one Settings selects, the requested model is one the connection serves, the
   * credential is present and unexpired, and the spend ledger has an approved cap. Nothing here
   * reads the credential into a record; the adapter opens it inside the dispatch step. Each route
   * is admitted only on its own connection: nothing falls back to another route or payer.
   */
  async admitModelApi(
    route: ModelApiRoute,
    input: Pick<TextRequest, 'model' | 'accountRoute'> & {
      effort?: string | null;
      projectId?: string;
      prompt?: string;
      requestId?: string;
      threadId?: string | null;
      /**
       * A Nectovia role under another lead: the tier it runs at, pinned on its own job, and the
       * role its calls name to the gateway. Only the Nectovia route reads them.
       */
      tier?: JobTier;
      escalation?: EscalationRole;
    },
    agent?: Pick<AgentWork, 'surface' | 'rootJobId'>,
    observe?: { readonly runId: string; readonly ownedTeam?: OwnedTeamObservation } | false,
  ): Promise<ModelSessionAdmission> {
    // A loop on the Nectovia route is admitted only under its own stable root
    // job (the loop's deterministic run id). Without one there is nothing the
    // gateway can meter the steps under, so it is refused before the Agent gate
    // is asked and the service records no admission (NECTOVIA_LOOP_REFUSED says
    // why). With one it follows the ordinary managed admission below: the gate,
    // the published policy, the pinned model/account and the month's guard.
    // The gateway already admits `loop` (AGENT_SURFACES), checks the admission
    // is current (15m) and pinned to the job, and accrues every step to the
    // same job cap; the stale comment claiming otherwise lives in nectovia.ts.
    if (
      route === NECTOVIA_ROUTE &&
      agent?.surface === 'loop' &&
      (!agent?.rootJobId || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(agent.rootJobId))
    )
      throw new EngineError('ROUTE_REFUSED', NECTOVIA_LOOP_REFUSED);
    const api = this.modelApi;
    if (!api)
      throw new EngineError('RUNTIME_UNAVAILABLE', 'This model-API route is not available in this process.', true);
    // What observation measures this admission from, read on the same turn as the gate, before its
    // round trip: the business a refusal is about, and the workspace a bind is compared against.
    let ask: ObservationAsk | undefined;
    try {
      ask = this.observation?.ask(input.projectId ?? null);
    } catch {
      // Observation never changes an admission.
    }
    const refused = (error: unknown): never => {
      try {
        // Only a refusal of the business ends its observation; an outage does not.
        if (refusalEndsObservation(error))
          this.observation?.refused({ projectId: input.projectId ?? null, organizationId: ask?.organizationId ?? null });
      } catch {
        // Observation never changes a refusal.
      }
      throw error;
    };
    // The Nectovia route is company-managed inference: its admission is the managed one, and it is
    // admitted on the business's plan and the published policy, never on a connection in Settings.
    if (route === NECTOVIA_ROUTE) {
      // A job that continues one that stopped at its check-in (Keep going) is admitted and metered under that
      // job, so the account service's count and its raised cap carry over. Any other job is its own.
      const continued = input.projectId && input.requestId ? this.jobCaps?.meteredAs?.(input.projectId, input.requestId) : null;
      const metered = continued && agent ? { ...agent, rootJobId: continued } : agent;
      return this.admitNectovia(api, input, metered, await this.admitAgent(input, { ...metered, routeKind: 'managed' }).catch(refused), ask, observe);
    }
    const admitted = await this.admitAgent(input, agent).catch(refused);
    const handle = await modelApiRoute(api, route);
    const { short, long } = handle.names;
    // A customer cannot repair a provider connection, so each of these reads the same: the
    // provider is unavailable, and support is the place to go (`routeUnavailable`).
    if (!handle.connected) throw new EngineError('ROUTE_REFUSED', routeUnavailable(long), true);
    if (handle.accountRoute !== input.accountRoute)
      throw new EngineError('ACCOUNT_CHANGED', `The ${short} connection changed. Select it again before sending.`);
    if (!handle.serves(input.model))
      throw new EngineError('ROUTE_REFUSED', routeUnavailable(long), true);
    if (handle.expiresAt && Date.parse(handle.expiresAt) <= Date.now() + 60_000)
      throw new EngineError('ROUTE_REFUSED', routeUnavailable(long), true);
    const blocked = await handle.credential.check();
    if (blocked) throw new EngineError('ROUTE_REFUSED', routeUnavailable(long), true);
    if (route !== LOCAL_MODEL_ROUTE && (!api.exposure.allowance(handle.connectionId) || api.exposure.summary(handle.connectionId).availableMicroUsd <= 0))
      throw new EngineError(
        'SPEND_LIMIT',
        `The approved ${short} spend limit has no room left. Nothing was sent. The owner can review usage and approve more in AI setup.`,
        true,
      );
    // A loop's observation belongs to its actual run, separately from the shared spend job.
    // Bind at adapter setup only: dispatch/result checks must not move the attempt's boundAt.
    if (observe !== false && (agent?.surface !== 'loop' || observe))
      try {
        this.observation?.bind({
          admission: admitted,
          rootJobId: observe?.ownedTeam?.commandId ?? observe?.runId ?? agent?.rootJobId ?? null,
          route,
          connectionId: handle.connectionId,
          connectionRevision: handle.revision,
          ownedTeam: observe?.ownedTeam,
          model: input.model,
          ask,
        });
      } catch {
        // Observation never changes an admission.
      }
    return {
      route,
      ...(route === LOCAL_MODEL_ROUTE ? { projectId: input.projectId } : {}),
      connectionId: handle.connectionId,
      revision: handle.revision,
      model: input.model,
      accountRoute: handle.accountRoute,
    };
  }
  /**
   * Admission for the Nectovia route. Nobody connects anything: the person is signed in, the
   * Agent gate admitted this work as managed for a business, the tier's model is the one the
   * account service publishes now (read again once when the service admitted under a newer
   * revision), and this computer has a price for it. The local guard for the business's month is
   * approved here by the host from the plan's published grant; it guards this computer and is
   * never read as the business's balance, which only the gateway's ledger holds.
   */
  private async admitNectovia(
    api: ModelApiServices,
    input: Pick<TextRequest, 'model' | 'accountRoute'> & {
      projectId?: string; requestId?: string; threadId?: string | null; tier?: JobTier; escalation?: EscalationRole;
    },
    agent: Pick<AgentWork, 'surface' | 'rootJobId'> | undefined,
    admitted: AdmittedAgentWork | null,
    ask?: ObservationAsk,
    observe?: { readonly runId: string; readonly ownedTeam?: OwnedTeamObservation } | false,
  ): Promise<ModelSessionAdmission> {
    const account = api.nectovia?.account;
    if (!account?.signedIn()) throw new EngineError(AGENT_SIGN_IN_REQUIRED, NECTOVIA_SIGN_IN, false);
    // Only the Agent gate names the business and records the admission the gateway checks, so a
    // call without one (the host's own connection test, or a host with no gate) is not sent.
    if (!admitted)
      throw new EngineError(
        'ROUTE_REFUSED',
        input.projectId === HOST_TEST_PROJECT
          ? 'Nectovia is checked by sending it a message. Nothing was sent.'
          : NECTOVIA_UNAVAILABLE,
        true,
      );
    const rootJobId = agent?.rootJobId ?? null;
    if (!rootJobId || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(rootJobId))
      throw new EngineError('ROUTE_REFUSED', 'This work has no job Nectovia can meter it under. Nothing was sent.', true);
    const tier = await this.managedTier(input);
    // The job's record exists now (the tier was pinned above), so the id it is metered under can be kept on it.
    if (this.jobCaps?.noteMetered && input.projectId && input.requestId)
      await this.jobCaps.noteMetered(input.projectId, input.requestId, rootJobId).catch(() => undefined);
    const label = WORK_STYLE_LABELS[tier];
    let policy = account.policy(input.projectId ?? null);
    if (!policy || policy.revision !== admitted.policyRevision)
      policy = await account.refreshPolicy(input.projectId ?? null);
    if (!policy) throw new EngineError('ROUTE_REFUSED', NECTOVIA_UNAVAILABLE, true);
    const published = policy.tiers[tier];
    if (!published)
      throw new EngineError('ROUTE_REFUSED', `${label} has no Nectovia model right now. Nothing was sent. Choose another tier.`, true);
    if (published.model !== input.model)
      throw new EngineError(
        'ROUTE_REFUSED',
        `Nectovia now runs ${label} on ${published.label}. Nothing was sent. Send your message again to use it.`,
        true,
      );
    // The gateway's legacy account field carries an explicit billing scope for Personal work.
    // The admission itself keeps organizationId null; no Business identity is synthesized.
    const organizationId = admitted.scope?.id ?? admitted.organizationId;
    if (organizationId === null) throw new EngineError(AGENT_NOT_INCLUDED, MANAGED_USAGE_NOT_INCLUDED_PERSONAL, false);
    const managed: ManagedAdmission = {
      admissionId: admitted.admissionId,
      organizationId,
      scope: admitted.scope,
      // Read here, so a refusal for want of credits can say who can buy more. Never a credential.
      role: account.roleFor?.(organizationId) ?? null,
      routing: policy.resolved,
      policyRevision: policy.revision,
      tier,
      usageClass: usageClassFor(admitted.surface),
      rootJobId,
      // A role under another lead names itself on every call it makes, so the gateway can check
      // the account's escalation control. A Nectovia lead and a person's conversation name none.
      ...(input.escalation ? { escalation: input.escalation } : {}),
    };
    const handle = await modelApiRoute(api, NECTOVIA_ROUTE, { managed, projectId: input.projectId });
    if (!handle.connected) throw new EngineError(AGENT_SIGN_IN_REQUIRED, NECTOVIA_SIGN_IN, false);
    if (handle.accountRoute !== input.accountRoute)
      throw new EngineError('ACCOUNT_CHANGED', 'This conversation belongs to another business. Send the message again from this one.');
    try {
      handle.card(input.model);
    } catch (error) {
      throw new EngineError('ROUTE_REFUSED', error instanceof Error ? error.message : NECTOVIA_UNAVAILABLE, true);
    }
    // The plan's published monthly grant, set once for the month (pay as you go: this month's use plus the bought
    // balance the account service reported, approved again when it changes); the gateway decides what the
    // business can actually spend.
    if ((await ensureNectoviaGuard(api.exposure, handle.connectionId, admitted.planId, admitted.boughtAvailable)).availableMicroUsd <= 0)
      throw new EngineError(
        'SPEND_LIMIT',
        "Nectovia's safety limit on this computer for this business's month has been reached, so nothing was sent.",
        true,
      );
    // Observed as managed because the gate admitted it as managed (`admitted.routeKind`), never by name.
    if (observe !== false && (agent?.surface !== 'loop' || observe))
      try {
        this.observation?.bind({ admission: admitted, rootJobId: observe?.ownedTeam?.commandId ?? observe?.runId ?? rootJobId, route: NECTOVIA_ROUTE,
          connectionId: handle.connectionId, connectionRevision: handle.revision, model: input.model, ownedTeam: observe?.ownedTeam, ask });
      } catch {
        // Observation never changes an admission.
      }
    return {
      route: NECTOVIA_ROUTE,
      connectionId: handle.connectionId,
      revision: handle.revision,
      model: input.model,
      accountRoute: handle.accountRoute,
      managed,
    };
  }
  /**
   * The tier a managed job is metered under: the one its job record pinned from its thread, or for
   * a Nectovia role under another lead, the role's own tier, pinned on the role's own job.
   */
  private async managedTier(input: { projectId?: string; requestId?: string; threadId?: string | null; tier?: JobTier }): Promise<JobTier> {
    if (!this.jobCaps || !input.projectId || !input.requestId) return input.tier ?? DEFAULT_JOB_TIER;
    if (input.tier) return (await this.jobCaps.scope(input.projectId, input.requestId, null, input.tier)).tier;
    return (await this.jobCaps.scope(input.projectId, input.requestId, input.threadId ?? null)).tier;
  }
  /**
   * The Agent check for one admission. The host's own connection test (the fixed one-word prompt in
   * the host test project) proves a route works and is not Agent work; everything else is.
   */
  private async admitAgent(
    input: { projectId?: string; prompt?: string },
    agent?: Partial<Pick<AgentWork, 'surface' | 'rootJobId' | 'routeKind'>>,
  ): Promise<AdmittedAgentWork | null> {
    const gate = this.agentGate;
    if (!gate) return null;
    if (input.projectId === HOST_TEST_PROJECT && input.prompt === TEST_PROMPT) return null;
    return gate.check({
      phase: 'admit',
      surface: agent?.surface ?? 'other',
      projectId: input.projectId ?? null,
      rootJobId: agent?.rootJobId ?? null,
      routeKind: agent?.routeKind ?? 'byo',
    });
  }
  private async modelApiHandle(admission: ModelSessionAdmission): Promise<ConnectedRoute> {
    const api = this.modelApi!;
    const handle = await modelApiRoute(api, admission.route as ModelApiRoute, { managed: admission.managed ?? null, projectId: admission.projectId });
    if (!handle.connected || handle.connectionId !== admission.connectionId || handle.revision !== admission.revision)
      throw new EngineError(
        'ACCOUNT_CHANGED',
        `The ${handle.names.short} connection changed after this message was admitted. Nothing was sent.`,
      );
    return handle;
  }
  private async openModelApi(admission: ModelSessionAdmission): Promise<{ handle: ConnectedRoute; secret: string }> {
    const handle = await this.modelApiHandle(admission);
    return { handle, secret: await handle.credential.open() };
  }
  /** One conversation message on a model-API route, through the model-session driver. */
  async modelSession(route: ModelApiRoute, mode: ModelSessionTurn['mode'], runId: string, input: TextRequest) {
    const driver = this.modelSessions;
    const api = this.modelApi;
    if (!driver || !api)
      throw new EngineError('RUNTIME_UNAVAILABLE', 'The model-API conversation runtime is not attached.', true);
    if (input.onDelta || input.onToolActivity || input.onReasoningDelta)
      throw new EngineError('PREVIEW_CONTRACT', 'Use the bounded onPreview and onActivity channels.');
    try {
      let thinking: ReasoningSink | undefined;
      const result = await driver.request({
        mode,
        runId,
        route,
        input,
        readTools: api.readTools,
        // Each message is its own job: admitted, capped and metered under the message's own turn
        // run, never the conversation's, so a job cap applies to one message.
        admit: () =>
          this.admitModelApi(route, input, { surface: 'conversation', rootJobId: turnRunId(runId, input.requestId) }),
        // The caller's channels, stamped with the turn step's identity and published only while
        // that exact attempt still owns its lease.
        activity:
          input.onPreview || input.onActivity || input.onReasoning || (route === LOCAL_MODEL_ROUTE && input.onPromptProgress)
            ? (context, stepId) => {
                const signal = AbortSignal.any([context.signal, ...(input.signal ? [input.signal] : [])]);
                const sinks = fencedSinks(
                  input,
                  { runId, stepId, attempt: context.attempt, fence: context.fence },
                  context,
                  signal,
                  MODEL_API_REASONING[route] === 'reasoning-delta',
                  this.deps.redactFor?.(route),
                  route === LOCAL_MODEL_ROUTE,
                );
                thinking = sinks.onReasoningDelta;
                return {
                  onDelta: (text) => sinks.onDelta?.(text),
                  onToolActivity: (raw) => sinks.onToolActivity?.(raw),
                  onReasoningDelta: sinks.onReasoningDelta,
                  onPromptProgress: sinks.onPromptProgress,
                  finish: sinks.finish,
                };
              }
            : undefined,
        adapter: async (admission, instructions, stop, sinks, turnCache) => {
          const { handle, secret } = await this.openModelApi(admission);
          const adapter = handle.adapter({
            model: admission.model,
            secret,
            exposure: handle.exposure(await this.jobLedger(api, input), runId),
            instructions,
            effort: route === LOCAL_MODEL_ROUTE ? input.effort : selectedEffortOf(input.effort),
            images: input.documents.flatMap(document => document.image ? [document.image] : []),
            transport: api.transport,
            sinks,
            ...(await cacheCall(handle, admission.model, input.projectId ?? null, instructions, turnCache)),
          });
          return {
            ...adapter,
            complete: (request, signal) => adapter.complete(request, AbortSignal.any([signal, stop])),
          };
        },
      });
      const reasoning = thinking?.finish() ?? null;
      return reasoning && result.response
        ? { ...result, response: { ...result.response, reasoning } }
        : result;
    } catch (error) {
      await this.noteJobStop(error, input);
      throw seamError(modelApiError(error));
    }
  }
  /**
   * One Work text turn on a model-API route: the same fenced text-route run every external engine
   * uses (admission step, one external dispatch step, never resent), with the route's exchange as
   * the transport. No tools are offered; the result is the text a Work proposal is parsed from.
   */
  async generateModelApi(route: ModelApiRoute, input: TextRequest): Promise<TextResponse & { runId: string }> {
    const key = `${input.projectId}:${input.threadId}`;
    if (this.running.has(key))
      throw new EngineError('REQUEST_ACTIVE', 'This thread already has a request in progress. Wait for it or cancel it.');
    if (input.onDelta || input.onToolActivity || input.onReasoningDelta)
      throw new EngineError('PREVIEW_CONTRACT', 'Use the bounded onPreview and onActivity channels.');
    // A team turn on this route runs through generateModelApiTools; this one offers no tools.
    if (input.team)
      throw new EngineError('POLICY_MISMATCH', 'Team tools on a model-API route ride in the host registry.', true);
    const dispatch = this.dispatch;
    const api = this.modelApi;
    if (!dispatch || !api)
      throw new EngineError('RUNTIME_UNAVAILABLE', 'The harness runtime seam is not attached to this service.', true);
    const controller = new AbortController();
    this.running.set(key, controller);
    const signal = AbortSignal.any([controller.signal, ...(input.signal ? [input.signal] : [])]);
    try {
      const runId = textRunId(input.projectId, input.requestId);
      const exposure = await this.jobLedger(api, input);
      // The step boundary for a one-call Work turn: checked before the dispatch step, so a turn
      // its job cannot afford is refused as never sent rather than parked as uncertain.
      await this.admitWorkCall(route, input, exposure);
      const intent = {
        engine: route,
        projectId: input.projectId,
        threadId: input.threadId,
        requestId: input.requestId,
        model: input.model,
        accountRoute: input.accountRoute,
        prompt: input.prompt,
        instructions: input.instructions,
        documents: input.documents,
        effort: input.effort ?? null,
      };
      const outcome = await dispatch<ModelSessionAdmission, TextResponse>({
        runId,
        intent,
        signal,
        admit: () => this.admitModelApi(route, input, { surface: 'work', rootJobId: runId }),
        send: async (context, admission) => {
          const { handle, secret } = await this.openModelApi(admission);
          const attemptSignal = AbortSignal.any([signal, context.signal]);
          const sinks = fencedSinks(
            input,
            { runId, stepId: TEXT_DISPATCH_STEP, attempt: context.attempt, fence: context.fence },
            context,
            attemptSignal,
            false,
            undefined,
            route === LOCAL_MODEL_ROUTE,
          );
          let result: Omit<RespondResult, 'reservation'>;
          try {
            result = await handle.respond({
              model: admission.model,
              secret,
              exposure: handle.exposure(exposure, runId),
              attempt: { runId, stepId: TEXT_DISPATCH_STEP, attempt: context.attempt, requestDigest: digest(intent) },
              instructions: input.instructions,
              messages: [{ role: 'user', content: contextMessage(input,
                route === LOCAL_MODEL_ROUTE ? api.bonsai?.runtime.profile(admission.model) : undefined) }],
              tools: [],
              effort: route === LOCAL_MODEL_ROUTE ? input.effort : selectedEffortOf(input.effort),
              limits: route === LOCAL_MODEL_ROUTE ? localLimits(api.bonsai?.runtime.profile(admission.model), WORK_LIMITS) : WORK_LIMITS,
              signal: attemptSignal,
              transport: api.transport,
              sinks: { onDelta: sinks.onDelta, onToolActivity: sinks.onToolActivity, onPromptProgress: sinks.onPromptProgress },
              // A Work turn has no stable prefix: an explicit setting marks its whole instructions.
              ...(await cacheCall(handle, admission.model, input.projectId ?? null, input.instructions)),
            });
          } catch (error) {
            // Drain ordered publications before the step can fail; the call's own failure is reported.
            await sinks.finish().catch(() => undefined);
            throw error;
          }
          // Drain ordered publications before the step can commit.
          await sinks.finish();
          if (result.outcome.kind !== 'final')
            throw new ModelApiError(
              `${handle.prefix}_unexpected_tool`,
              'The model asked for a tool where none was offered.',
              true,
            );
          context.reportOrigin?.({
            protocolVersion: 1,
            mode: 'direct',
            engine: { id: route, version: handle.sdk },
            model: {
              requested: input.model,
              reported: result.reportedModel,
              source: result.reportedModel ? 'runtime' : 'not-recorded',
            },
            accountRoute: input.accountRoute,
          });
          return {
            text: result.outcome.text,
            // Only the provider's own report. Work marks a model verified when this is non-empty,
            // so the requested model never stands in for one the provider did not report.
            model: result.reportedModel ?? '',
            version: handle.sdk,
            threadId: input.threadId,
            projectId: input.projectId,
            requestId: input.requestId,
          };
        },
      });
      return { ...outcome.result, runId: outcome.run.id };
    } catch (error) {
      await this.noteJobStop(error, input);
      throw seamError(modelApiError(error));
    } finally {
      controller.abort();
      this.running.delete(key);
    }
  }
  /** The job check for a one-call Work turn, with the same ceiling its reservation will hold. */
  private async admitWorkCall(route: ModelApiRoute, input: TextRequest, exposure: SpendExposure) {
    const job = exposure.jobScope;
    if (!job) return;
    const card = await this.modelApiCard(route, input.model);
    // No card means the call is refused before it is sent anyway; the reservation still checks.
    if (!card) return;
    let next: MicroUsd;
    try {
      next = callCeiling({
        prefix: route,
        card,
        instructions: input.instructions,
        messages: [{ role: 'user', content: contextMessage(input,
          route === LOCAL_MODEL_ROUTE ? this.modelApi?.bonsai?.runtime.profile(input.model) : undefined) }],
        tools: [],
        limits: route === LOCAL_MODEL_ROUTE ? localLimits(this.modelApi?.bonsai?.runtime.profile(input.model), WORK_LIMITS) : WORK_LIMITS,
      });
    } catch {
      // Too large for the route: the call itself refuses it, with the route's own words, before sending.
      return;
    }
    const decision = decideJobStep({ capMicroUsd: job.capMicroUsd, usedMicroUsd: exposure.jobUsed(job.id), nextMicroUsd: next });
    if (!decision.ok)
      throw new ModelApiError(
        `${route}_job_cap_reached`,
        'This job would pass its cap on this step, so it stopped before sending anything.',
        false,
        { job: { id: job.id, usedMicroUsd: decision.usedMicroUsd, capMicroUsd: decision.capMicroUsd, neededMicroUsd: decision.neededMicroUsd } },
      );
  }
  /**
   * One team member's Work turn on a model-API route. The route carries the team tools by
   * running them itself: the model is offered their descriptors and each call is a host tool
   * step in the member's own run (ModelSessionRuns.workTurn). Admission, the connection, the
   * credential and the spend cap are the ones every model-API call is held to. The result is
   * the proposal text, parsed and approved exactly as any other Work proposal.
   */
  async generateModelApiTools(
    route: ModelApiRoute,
    input: TextRequest,
    registry: ToolRegistry,
  ): Promise<TextResponse & { runId: string }> {
    const key = `${input.projectId}:${input.threadId}`;
    if (this.running.has(key))
      throw new EngineError('REQUEST_ACTIVE', 'This thread already has a request in progress. Wait for it or cancel it.');
    if (input.onDelta || input.onToolActivity || input.onReasoningDelta)
      throw new EngineError('PREVIEW_CONTRACT', 'Use the bounded onPreview and onActivity channels.');
    if (input.team || input.readScope)
      throw new EngineError('POLICY_MISMATCH', 'A model-API team turn carries its tools in the host registry only.', true);
    const driver = this.modelSessions;
    const api = this.modelApi;
    if (!driver || !api)
      throw new EngineError('RUNTIME_UNAVAILABLE', 'The model-API runtime is not attached to this service.', true);
    const controller = new AbortController();
    this.running.set(key, controller);
    try {
      const result = await driver.workTurn({
        route,
        input: { ...input, signal: AbortSignal.any([controller.signal, ...(input.signal ? [input.signal] : [])]) },
        registry,
        admit: () => this.admitModelApi(route, input, { surface: 'team', rootJobId: input.requestId }),
        adapter: async (admission, instructions, stop) => {
          const { handle, secret } = await this.openModelApi(admission);
          const adapter = handle.adapter({
            model: admission.model,
            secret,
            exposure: await this.jobLedger(api, input),
            instructions,
            effort: route === LOCAL_MODEL_ROUTE ? input.effort : selectedEffortOf(input.effort),
            images: input.documents.flatMap(document => document.image ? [document.image] : []),
            transport: api.transport,
            ...(await cacheCall(handle, admission.model, input.projectId ?? null, instructions)),
          });
          return {
            ...adapter,
            complete: (request, signal) => adapter.complete(request, AbortSignal.any([signal, stop])),
          };
        },
      });
      return {
        text: result.text,
        // Only the provider's own report; Work marks the model verified when this is non-empty.
        model: result.model,
        version: result.version,
        threadId: input.threadId,
        projectId: input.projectId,
        requestId: input.requestId,
        runId: result.runId,
      };
    } catch (error) {
      await this.noteJobStop(error, input);
      throw seamError(modelApiError(error));
    } finally {
      controller.abort();
      this.running.delete(key);
    }
  }
  /**
   * H13: a model-API route as the adapter a Diomedes work loop (or its delegate) drives.
   * Admission is the route's own, read fresh; the credential opens here and the adapter is
   * bound to this run's job ledger, exactly as for a conversation turn. Nothing falls back to
   * another route, connection or payer.
   *
   * Nectovia is managed single-agent only: the wrapper below re-admits and
   * re-opens immediately before every `complete` call, using the original
   * runId as the root job, the pinned route/model/account and the same job
   * ledger and stop signal. A captured credential or managed binding is never
   * reused across steps, so a revoked membership, a moved policy or an emptied
   * cap fails before the next dispatch. The descriptor (id, contract,
   * capabilities) is the first admission's; only the call is fresh. No retries
   * and no new ids on cap errors: the refusal propagates honestly.
   */
  async loopAdapter(
    route: ModelApiRoute,
    request: { projectId: string; runId: string; model: string; accountRoute: string; instructions: string;
      rootRunId?: string; rootJobId?: string; threadId?: string | null; scopedLedger?: SpendExposure;
      effort?: string | null; callLimits?: RespondLimits; ownedTeamObservation?: OwnedTeamObservation;
      /** A Nectovia role under another lead: its tier and its role, read again on every step. */
      tier?: JobTier; escalation?: EscalationRole },
    stop: AbortSignal,
  ): Promise<ModelAdapter> {
    const api = this.modelApi;
    if (!api) throw new EngineError('RUNTIME_UNAVAILABLE', 'The model-API runtime is not attached to this service.', true);
    const rootRunId = request.rootRunId ?? request.runId;
    const ownedTeamObservation = request.ownedTeamObservation;
    if (ownedTeamObservation && (ownedTeamObservation.runId !== request.runId || ownedTeamObservation.rootRunId !== rootRunId))
      throw new HarnessError('collaboration_refused', 'The observed Team identity differs from the validated child.');
    const surface = ownedTeamObservation ? 'team' : 'loop';
    const threadId = request.threadId ?? `loop-${rootRunId}`;
    if (request.rootJobId && !request.scopedLedger)
      throw new HarnessError('collaboration_refused', 'The existing root job requires its supplied scoped spend ledger.');
    const ledger = request.scopedLedger ?? await this.rootJobLedger(request.projectId, rootRunId, threadId);
    if (request.rootJobId && ledger.jobScope?.id !== request.rootJobId)
      throw new HarnessError('collaboration_refused', 'This role was supplied a different root spend ledger.');
    const rootJobId = ledger.jobScope?.id ?? rootRunId;
    const effort = request.effort === undefined ? 'medium' : request.effort === null ? undefined : request.effort;
    if (effort !== undefined && !(route === LOCAL_MODEL_ROUTE ? ['low', 'medium', 'xhigh'] : ['low', 'medium', 'high']).includes(effort))
      throw new HarnessError('collaboration_refused', 'The pinned model effort is unsupported on this API route.');
    const callOptions = { instructions: request.instructions, effort,
      transport: api.transport, ...(request.callLimits ? { limits: request.callLimits } : {}) };
    const admission = await this.admitModelApi(
      route,
      { ...request, requestId: request.runId, threadId },
      { surface, rootJobId },
      { runId: request.runId, ownedTeam: ownedTeamObservation },
    );
    if (admission.model !== request.model || admission.accountRoute !== request.accountRoute)
      throw new EngineError('ACCOUNT_CHANGED', 'The selected route changed after this role was admitted. Nothing was sent.', true);
    let adapter: ModelAdapter;
    if (route === GOOGLE_VERTEX_ROUTE) {
      // Setup needs the exact current descriptor/profile, not a token. Every
      // actual model step below opens its own fresh credential after admission.
      const handle = await this.modelApiHandle(admission);
      if (!handle.descriptor) throw new EngineError('RUNTIME_UNAVAILABLE', routeUnavailable('Google Vertex AI'), false);
      adapter = handle.descriptor({
        model: admission.model,
        exposure: ledger,
        ...callOptions,
      });
    } else {
      const { handle, secret } = await this.openModelApi(admission);
      adapter = handle.adapter({
        model: admission.model,
        secret,
        exposure: handle.exposure(ledger, request.runId),
        ...callOptions,
        ...(await cacheCall(handle, admission.model, request.projectId, request.instructions)),
      });
    }
    // Every role re-admits, re-opens and rebuilds the call's adapter
    // on every step. Route, model, account, job and ledger stay pinned to what
    // the loop was admitted with; the token, policy, membership and cap are
    // read again. Stale policy, expiry and revocation refuse here, unsent.
    const pinned = { route, model: request.model, accountRoute: request.accountRoute, runId: request.runId, projectId: request.projectId, instructions: request.instructions,
      tier: request.tier, escalation: request.escalation };
    return {
      ...adapter,
      complete: async (call, signal, stream) => {
        const callSignal = AbortSignal.any([signal, stop]);
        callSignal.throwIfAborted();
        const fresh = await this.admitModelApi(
          pinned.route,
          { model: pinned.model, accountRoute: pinned.accountRoute, projectId: pinned.projectId, requestId: pinned.runId, threadId,
            tier: pinned.tier, escalation: pinned.escalation },
          { surface, rootJobId },
          false,
        );
        if (fresh.model !== pinned.model || fresh.accountRoute !== pinned.accountRoute)
          throw new EngineError('ACCOUNT_CHANGED', 'The selected route changed after this role was admitted. Nothing was sent.', true);
        const opened = await this.openModelApi(fresh);
        const step = opened.handle.adapter({
          model: fresh.model,
          secret: opened.secret,
          exposure: opened.handle.exposure(ledger, pinned.runId),
          ...callOptions,
          // The owner's cache setting is read again for every step, like the rest of the route.
          ...(await cacheCall(opened.handle, fresh.model, pinned.projectId, pinned.instructions)),
        });
        callSignal.throwIfAborted();
        const result = await step.complete(call, callSignal, stream);
        callSignal.throwIfAborted();
        const accepted = await this.admitModelApi(pinned.route,
          { model: pinned.model, accountRoute: pinned.accountRoute, projectId: pinned.projectId, requestId: pinned.runId, threadId,
            tier: pinned.tier, escalation: pinned.escalation },
          { surface, rootJobId }, false);
        if (accepted.model !== pinned.model || accepted.accountRoute !== pinned.accountRoute)
          throw new EngineError('ACCOUNT_CHANGED', 'The selected route changed while this role was in flight. Its answer was not accepted.', true);
        return result;
      },
    };
  }
  close() {
    for (const controller of this.running.values()) controller.abort();
  }
}


/** What the engine service needs from the host's parent-job caps (`server/job-caps.ts`). */
export interface JobCapsPort {
  scope(projectId: string, jobId: string, threadId: string | null, tier?: JobTier): Promise<JobScope & { tier: JobTier }>;
  noteStop(key: string, stop: { usedMicroUsd: MicroUsd; capMicroUsd: MicroUsd; neededMicroUsd: MicroUsd }): Promise<void>;
  /** The id an earlier job of this chain was metered under at the account service, when Keep going continues it. */
  meteredAs?(projectId: string, jobId: string): string | null;
  /** Record the id the account service meters this job under. */
  noteMetered?(projectId: string, jobId: string, meteredJobId: string): Promise<void>;
  /** The account service stopped this job at its check-in before the local ledger did. */
  noteManagedStop?(projectId: string, jobId: string): Promise<void>;
}

/**
 * What a model-API route needs from the app: its record, its protected credential, its ledgers.
 * The top-level record and transcripts are AWS Bedrock's; each later route brings its own record
 * and its own private transcript store (a store is bound to one provider id). The credential
 * store and the spend ledger are shared and keyed by connection id, so no route can read another
 * route's key or spend against another route's cap. A route whose services are absent is
 * unavailable in this process, never served by another route.
 */
export interface ModelApiServices {
  /** The local model route: its runtime reads the folder's descriptor, so it is set up when that is. */
  bonsai?: { runtime: LocalModelRuntime; transcripts: ModelTranscripts;
    loadImage(image: ModelImage, projectId: string): Promise<string> };
  connections: AwsConnections;
  secrets: ConnectionSecrets;
  exposure: SpendExposure;
  transcripts: ModelTranscripts;
  /**
   * The route check receipts (`route-qualification.ts`). A model that sends only under a receipt
   * (Kimi K3 on AWS) is refused while this is absent.
   */
  qualifications?: RouteQualifications;
  azure?: { connections: AzureConnections; transcripts: ModelTranscripts };
  openrouter?: { connections: OpenRouterConnections; transcripts: ModelTranscripts };
  /**
   * Google Vertex AI. There is no stored key: each turn mints a short-lived token from the
   * Application Default Credentials file the connection was verified with. `mint`, `env` and
   * `now` are replaced only by tests. `funding`, when present, makes every call a managed call:
   * it wraps the local ledger with the customer's parent-job credits and is consulted again
   * immediately before each dispatch.
   */
  vertex?: {
    connections: VertexConnections;
    transcripts: ModelTranscripts;
    env?: NodeJS.ProcessEnv;
    mint?: (connection: VertexConnection) => Promise<AccessToken>;
    funding?: (base: SpendExposure, runId: string) => CallExposure;
    now?: () => Date;
  };
  /**
   * The Nectovia route: company-managed inference through the account service's gateway. It has
   * no connection record and no credential here; it reads the signed-in session for each call.
   * Absent in a host without customer accounts, where it is never connected.
   */
  nectovia?: {
    account: NectoviaAccount;
    transcripts: ModelTranscripts;
    /** Tests only: the clock the month's local guard is named by. */
    now?: () => Date;
  };
  /**
   * The owner's cache setting for a route (DIO-215), read from Settings each time a route's calls
   * are prepared. Absent reads as the provider's default: every request goes out as it did before
   * the setting existed.
   */
  cachePolicy?: (route: string) => CachePolicy;
  /**
   * The tenant an explicit cache key is scoped to for work in one project: the signed-in
   * principal's tenant when accounts are on, `local` otherwise. Absent reads as `local`.
   */
  cacheTenant?: (projectId: string | null) => string;
  /** Tests substitute the network here, below the SDK. Production leaves it unset. */
  transport?: typeof globalThis.fetch;
  /**
   * Tests substitute what the Ask and Plan read tools reach (DNS, the page transport, the
   * connector transport). Production leaves it unset; it never widens what a tool may read.
   */
  readTools?: ReadToolDeps;
}

interface RouteCallOptions {
  model: string;
  secret: string;
  exposure: CallExposure;
  instructions: string;
  effort?: string;
  images?: readonly ModelImage[];
  limits?: RespondLimits;
  transport?: typeof globalThis.fetch;
  sinks?: StreamSinks;
  /** The owner's cache setting for these calls (DIO-215); absent sends them as before. */
  cache?: CacheRequest | null;
  /** The stable start of `instructions`, or null where the path has none. */
  stablePrefix?: string | null;
  /** Told what each answered call's cache breakpoint marked (a conversation turn's record). */
  onCacheMarked?: (marked: CacheMark) => void;
}
type ConnectedRoute = {
  connected: true;
  route: ModelApiRoute;
  prefix: string;
  names: { short: string; long: string };
  sdk: string;
  connectionId: string;
  revision: number;
  accountRoute: string;
  expiresAt: string | null;
  serving: string;
  serves(model: string): boolean;
  /** The declared price card calls for this model are reserved under. Throws when there is none. */
  card(model: string): ModelRateCard;
  /**
   * The route's credential: `check` refuses, before anything is sent, when it cannot be used;
   * `open` returns it inside the dispatch step. Keyed routes read protected storage.
   */
  credential: { check(): Promise<string | null>; open(): Promise<string> };
  /** The ledger a call is held on: the local cap, or a managed route's funded ledger over it. */
  exposure(base: SpendExposure, runId: string): CallExposure;
  /** A pure descriptor/profile for loop setup; it cannot dispatch without a credential. */
  descriptor?(options: Omit<RouteCallOptions, 'secret'>): ModelAdapter;
  /**
   * The owner's cache setting for calls to one model of this connection (DIO-215), read fresh.
   * Only routes with the setting have it; their calls carry what it returns.
   */
  cache?(model: string, projectId: string | null): Promise<RouteCachePlan>;
  adapter(options: RouteCallOptions): ModelAdapter;
  respond(
    options: RouteCallOptions & {
      attempt: ExposureAttempt;
      messages: import('ai').ModelMessage[];
      tools: [];
      limits: RespondLimits;
      signal: AbortSignal;
    },
  ): Promise<Omit<RespondResult, 'reservation'>>;
};
type RouteHandle = ConnectedRoute | { connected: false; route: ModelApiRoute; names: { short: string; long: string } };

const ROUTE_WORDS: Record<ModelApiRoute, { short: string; long: string }> = {
  'aws-bedrock': { short: 'AWS', long: 'AWS Bedrock' },
  'azure-openai': { short: 'Azure', long: 'Azure OpenAI' },
  openrouter: { short: 'OpenRouter', long: 'OpenRouter' },
  'google-vertex': { short: 'Google Vertex AI', long: 'Google Vertex AI' },
  nectovia: { short: 'Nectovia', long: 'Nectovia' },
  bonsai: { short: 'Local model', long: 'Local model' },
};

/**
 * What a route handle is built for. Only the Nectovia route reads it: its business comes from the
 * admission when there is one, else from the project the work belongs to (or the active business).
 */
interface RouteWork {
  projectId?: string | null;
  managed?: ManagedAdmission | null;
}

/** A keyed route's credential: the key in protected storage under its own connection id. */
const storedKey = (api: ModelApiServices, connectionId: string): ConnectedRoute['credential'] => ({
  check: async () => (api.secrets.available() ? null : 'Protected credential storage is not available in this process.'),
  open: () => api.secrets.get(connectionId),
});
const localLedger = (base: SpendExposure) => base;

/** Keep a keyed route's exact local job view; never replace it with the connection ledger. */
function localCallLedger(exposure: CallExposure): SpendExposure {
  if (!(exposure instanceof SpendExposure))
    throw new EngineError('RUNTIME_UNAVAILABLE', 'This route requires the local spend ledger admitted for this call. Nothing was sent.', true);
  return exposure;
}

/** The owner's cache setting for one route's calls, read when they are prepared (DIO-215). */
interface RouteCachePlan {
  policy: CachePolicy;
  request: CacheRequest;
  /** Where the route's SDK model reads cache options and breakpoints. */
  namespace: CacheNamespace;
  /** The capability record of the model the calls go to; null when it could not be read. */
  record: RouteCapability | null;
}

/**
 * The setting's request for one connection and model. An explicit prefix's key is derived from the
 * whole scope here, on the host; a key that cannot be made refuses the call before anything is held.
 */
async function routeCachePlan(
  api: ModelApiServices,
  target: {
    prefix: string;
    route: CachePolicyRoute;
    connectionId: string;
    revision: number;
    model: string;
    namespace: CacheNamespace;
    record: () => Promise<RouteCapability>;
  },
  projectId: string | null,
): Promise<RouteCachePlan> {
  const policy = api.cachePolicy?.(target.route) ?? DEFAULT_CACHE_POLICY;
  const request = routeCacheRequest(target.prefix, policy, {
    tenantId: policy === 'explicit-prefix' ? (api.cacheTenant?.(projectId) ?? LOCAL_CACHE_TENANT) : LOCAL_CACHE_TENANT,
    route: target.route,
    connectionId: target.connectionId,
    connectionRevision: target.revision,
    model: target.model,
  });
  const record = await target.record().catch(() => null);
  return { policy, request, namespace: target.namespace, record };
}

/**
 * The cache fields one opened route's calls carry: the owner's setting read fresh and the stable
 * prefix where the path has one. A conversation turn also gets the report its context record
 * keeps: what the setting marks, said before the first call and again after each answered call.
 * A route with no setting carries nothing.
 */
async function cacheCall(
  handle: ConnectedRoute,
  model: string,
  projectId: string | null,
  instructions: string,
  turn?: TurnCache,
): Promise<Pick<RouteCallOptions, 'cache' | 'stablePrefix' | 'onCacheMarked'>> {
  if (!handle.cache) return {};
  const plan = await handle.cache(model, projectId);
  const stablePrefix = turn?.stablePrefix ?? null;
  if (!turn) return { cache: plan.request, stablePrefix };
  const report = (marked: CacheMark) => turn.report({ policy: plan.policy, record: plan.record, marked });
  report(systemParts(instructions, stablePrefix, plan.request, plan.namespace).marked);
  return { cache: plan.request, stablePrefix, onCacheMarked: report };
}

/**
 * One model-API route's saved connection, read fresh, with the calls it can make. Each branch
 * builds only its own route's adapter and exchange from its own record: there is no path from
 * one route's admission to another route's provider, key or ledger entry.
 */
async function modelApiRoute(api: ModelApiServices, route: ModelApiRoute, work: RouteWork = {}): Promise<RouteHandle> {
  const names = ROUTE_WORDS[route];
  const unavailable = () =>
    new EngineError('RUNTIME_UNAVAILABLE', 'This model-API route is not available in this process.', true);
  switch (route) {
    case LOCAL_MODEL_ROUTE: {
      const services = api.bonsai;
      // Set up means a folder whose descriptor passed every check; its profiles are what it serves.
      const descriptor = services?.runtime.descriptor();
      if (!services || !descriptor) return { connected: false, route, names };
      return {
        connected: true, route, prefix: 'bonsai', names, sdk: LOCAL_MODEL_SDK,
        connectionId: LOCAL_MODEL_CONNECTION, revision: 1, accountRoute: LOCAL_MODEL_ACCOUNT,
        expiresAt: null, serving: descriptor.model, serves: model => !!services.runtime.profile(model),
        card: model => localRateCard(services.runtime.profile(model)),
        credential: { check: async () => null, open: async () => '' }, exposure: localLedger,
        adapter: options => createLocalAdapter({ ...options, runtime: services.runtime, transcripts: services.transcripts,
          loadImage: image => {
            if (!work.projectId) throw new EngineError('ROUTE_REFUSED', 'An image needs its admitted project.');
            return services.loadImage(image, work.projectId);
          } }),
        respond: ({ sinks, ...options }) => respondLocal({ ...options, runtime: services.runtime, ...sinks }),
      };
    }
    case AWS_BEDROCK_ROUTE: {
      // A connection saved for a retired model is refused with the reconnect sentence; nothing is
      // sent on it and nothing moves it to the current model.
      const connection: AwsConnection | null = await api.connections.read().catch((error: unknown) => {
        if (error instanceof AwsConnectionRetired)
          throw new EngineError('ROUTE_REFUSED', `${error.message} Nothing was sent.`, true);
        throw error;
      });
      if (!connection) return { connected: false, route, names };
      // Kimi K3 sends only under a current route check receipt for this exact connection, model,
      // protocol and price. It is read once for this handle and checked again on every call.
      const qualification = await awsQualificationFor(api.qualifications, connection);
      const refusal = awsModelRefusal(connection, qualification, Date.now());
      if (refusal) throw new EngineError('ROUTE_REFUSED', `${refusal} Nothing was sent.`, true);
      return {
        connected: true,
        route,
        prefix: 'aws',
        names,
        sdk: AWS_BEDROCK_SDK,
        connectionId: connection.id,
        revision: connection.revision,
        accountRoute: awsAccountRoute(connection),
        expiresAt: connection.credential.expiresAt,
        serving: connection.modelId,
        serves: (model) => model === connection.modelId,
        card: (model) => awsModelRateCard(model),
        credential: storedKey(api, connection.id),
        exposure: localLedger,
        adapter: (options) =>
          createAwsModelAdapter({
            connection,
            secret: options.secret,
            card: awsModelRateCard(connection.modelId),
            exposure: localCallLedger(options.exposure),
            transcripts: api.transcripts,
            instructions: options.instructions,
            effort: effortOf(options.effort),
            transport: options.transport,
            limits: options.limits,
            qualification,
            cache: options.cache,
            stablePrefix: options.stablePrefix,
            onCacheMarked: options.onCacheMarked,
            ...options.sinks,
          }),
        respond: ({ sinks, model: _model, onCacheMarked: _marked, ...options }) =>
          respondOnce({ connection, card: awsModelRateCard(connection.modelId), ...options, effort: effortOf(options.effort), exposure: localCallLedger(options.exposure), qualification, ...sinks }),
        cache: (_model, projectId) =>
          routeCachePlan(
            api,
            {
              prefix: 'aws',
              route,
              connectionId: connection.id,
              revision: connection.revision,
              model: connection.modelId,
              namespace: cacheNamespace(route, awsProtocolFor(connection.modelId)),
              record: () => awsCapability(api.qualifications, connection, Date.now()),
            },
            projectId,
          ),
      };
    }
    case AZURE_OPENAI_ROUTE: {
      const services = api.azure;
      if (!services) throw unavailable();
      const connection: AzureConnection | null = await services.connections.read();
      if (!connection) return { connected: false, route, names };
      const models = connection.deployments.map((entry) => entry.model);
      return {
        connected: true,
        route,
        prefix: 'azure',
        names,
        sdk: AZURE_OPENAI_SDK,
        connectionId: connection.id,
        revision: connection.revision,
        accountRoute: azureAccountRoute(connection),
        expiresAt: connection.credential.expiresAt,
        serving: models.join(', '),
        serves: (model) => models.includes(model),
        card: (model) => azureRateCard(connection, model),
        credential: storedKey(api, connection.id),
        exposure: localLedger,
        adapter: (options) =>
          createAzureModelAdapter({
            connection,
            model: options.model,
            secret: options.secret,
            card: azureRateCard(connection, options.model),
            exposure: localCallLedger(options.exposure),
            transcripts: services.transcripts,
            instructions: options.instructions,
            effort: effortOf(options.effort),
            transport: options.transport,
            limits: options.limits,
            cache: options.cache,
            stablePrefix: options.stablePrefix,
            onCacheMarked: options.onCacheMarked,
            ...options.sinks,
          }),
        respond: ({ sinks, onCacheMarked: _marked, ...options }) =>
          respondAzure({ connection, card: azureRateCard(connection, options.model), ...options, effort: effortOf(options.effort), exposure: localCallLedger(options.exposure), ...sinks }),
        cache: (model, projectId) =>
          routeCachePlan(
            api,
            {
              prefix: 'azure',
              route,
              connectionId: connection.id,
              revision: connection.revision,
              model,
              namespace: cacheNamespace(route, AZURE_OPENAI_PROTOCOL),
              record: () => azureCapability(api.qualifications, connection, model, Date.now()),
            },
            projectId,
          ),
      };
    }
    case OPENROUTER_ROUTE: {
      const services = api.openrouter;
      if (!services) throw unavailable();
      const connection: OpenRouterConnection | null = await services.connections.read();
      if (!connection) return { connected: false, route, names };
      const models = connection.models.map((entry) => entry.id);
      return {
        connected: true,
        route,
        prefix: 'openrouter',
        names,
        sdk: OPENROUTER_SDK,
        connectionId: connection.id,
        revision: connection.revision,
        accountRoute: openRouterAccountRoute(connection),
        expiresAt: connection.credential.expiresAt,
        serving: models.join(', '),
        serves: (model) => models.includes(model),
        card: (model) => openRouterRateCard(connection, model),
        credential: storedKey(api, connection.id),
        exposure: localLedger,
        adapter: (options) =>
          createOpenRouterModelAdapter({
            connection,
            model: options.model,
            secret: options.secret,
            card: openRouterRateCard(connection, options.model),
            exposure: localCallLedger(options.exposure),
            transcripts: services.transcripts,
            instructions: options.instructions,
            effort: selectedEffortOf(options.effort),
            transport: options.transport,
            limits: options.limits,
            ...options.sinks,
          }),
        respond: ({ sinks, ...options }) =>
          respondOpenRouter({ connection, card: openRouterRateCard(connection, options.model), ...options,
            effort: selectedEffortOf(options.effort), exposure: localCallLedger(options.exposure), ...sinks }),
      };
    }
    case GOOGLE_VERTEX_ROUTE: {
      const services = api.vertex;
      if (!services) throw unavailable();
      const connection: VertexConnection | null = await services.connections.read();
      if (!connection) return { connected: false, route, names };
      const now = services.now ?? (() => new Date());
      const mint = services.mint ?? ((value: VertexConnection) => mintVertexToken(value, services.env));
      const adapterOptions = (options: Omit<RouteCallOptions, 'secret'>) => ({
        connection,
        card: vertexRateCard(now()),
        exposure: options.exposure,
        transcripts: services.transcripts,
        instructions: options.instructions,
        effort: effortOf(options.effort),
        transport: options.transport,
        limits: options.limits,
        now,
        ...options.sinks,
      });
      return {
        connected: true,
        route,
        prefix: 'vertex',
        names,
        sdk: GOOGLE_VERTEX_SDK,
        connectionId: connection.id,
        revision: connection.revision,
        accountRoute: vertexAccountRoute(connection),
        expiresAt: null,
        serving: connection.model,
        serves: (model) => model === connection.model,
        credential: {
          // Offline: a price must be in force, and the credential must be the one verified.
          check: async () => {
            try {
              vertexRateCard(now());
            } catch (error) {
              return error instanceof Error ? error.message : 'No current Gemini price is recorded.';
            }
            if (connection.credential.kind === 'google-api-key') {
              if (!api.secrets.available()) return 'Protected credential storage is not available in this process.';
              try {
                if (secretFingerprint(await api.secrets.get(connection.id)) === connection.credential.fingerprint) return null;
              } catch {
                // Missing or unreadable: said below.
              }
              return 'The saved Google Vertex AI key is missing or not the one connected. Connect it again in AI setup. Nothing was sent.';
            }
            const identity = await readAdcIdentity(services.env);
            if (!identity)
              return 'No Google Application Default Credentials were found on this computer. Run `gcloud auth application-default login`, then verify Google Vertex AI in AI setup. Nothing was sent.';
            if (identity.fingerprint !== connection.credential.fingerprint)
              return 'The Google credential on this computer is not the one Google Vertex AI was verified with. Verify it again in AI setup. Nothing was sent.';
            return null;
          },
          open: async () => {
            if (connection.credential.kind !== 'google-api-key') return (await mint(connection)).token;
            const key = await api.secrets.get(connection.id);
            if (secretFingerprint(key) !== connection.credential.fingerprint)
              throw new EngineError('RUNTIME_UNAVAILABLE', routeUnavailable('Google Vertex AI'), false);
            return key;
          },
        },
        card: () => vertexRateCard(now()),
        exposure: (base, runId) => (services.funding ? services.funding(base, runId) : base),
        descriptor: (options) => createVertexModelDescriptor(adapterOptions(options)),
        adapter: (options) => createVertexModelAdapter({ ...adapterOptions(options), secret: options.secret }),
        respond: ({ sinks, model: _model, ...options }) =>
          respondVertex({ connection, card: vertexRateCard(now()), now, ...options, effort: effortOf(options.effort), ...sinks }),
      };
    }
    case NECTOVIA_ROUTE: {
      // Connected when someone is signed in and the work belongs to a business. There is no record
      // to read and no key to open: the session's token is the credential, read for each call.
      const services = api.nectovia;
      const account = services?.account;
      const organizationId = work.managed?.organizationId ?? account?.organizationFor(work.projectId ?? null) ?? null;
      if (!services || !account?.signedIn() || !organizationId) return { connected: false, route, names };
      const now = services.now ?? (() => new Date());
      const connectionId = nectoviaConnectionId(organizationId, now());
      const policy = work.managed?.routing ? { revision: work.managed.routing.revision, tiers: work.managed.routing.tiers, resolved: work.managed.routing }
        : account.policy(work.projectId ?? null);
      const scopedAccount = { policy: () => account.policy(work.projectId ?? null), refreshPolicy: () => account.refreshPolicy(work.projectId ?? null) };
      const published = Object.values(policy?.tiers ?? {}).flatMap((entry) => (entry ? [entry.model] : []));
      const managed = () => {
        if (!work.managed)
          throw new EngineError('ROUTE_REFUSED', 'This Nectovia call has no admission, so nothing was sent.', true);
        return work.managed;
      };
      // The gateway is the account service's, so its own transport reaches it. A provider test
      // transport (`modelApiTransport`) replaces the provider network, never the account service.
      const transport = (given?: typeof globalThis.fetch) => account.fetch ?? given;
      return {
        connected: true,
        route,
        prefix: 'nectovia',
        names,
        sdk: NECTOVIA_SDK,
        connectionId,
        // Nothing on this computer is revised: the business, the admission and the policy
        // revision are what fence a call, and each is checked again by the gateway.
        revision: 1,
        accountRoute: nectoviaAccountRoute(organizationId),
        expiresAt: null,
        serving: [...new Set(published)].join(', ') || 'no published model',
        serves: (model) => published.includes(model),
        card: (model) => nectoviaRateCard(model, policy),
        credential: {
          check: async () => (account.signedIn() ? null : NECTOVIA_SIGN_IN),
          open: async () => {
            if (!account.signedIn()) throw new EngineError(AGENT_SIGN_IN_REQUIRED, NECTOVIA_SIGN_IN, false);
            return account.token();
          },
        },
        // The local guard: this computer's own ledger, held to the job's cap. Never the balance.
        exposure: localLedger,
        adapter: (options) =>
          createNectoviaModelAdapter({
            base: account.base,
            account: scopedAccount,
            connectionId,
            model: options.model,
            managed: managed(),
            token: options.secret,
            card: nectoviaRateCard(options.model, policy),
            // This route's `exposure()` is the local ledger itself, so what arrives is one.
            exposure: options.exposure as SpendExposure,
            transcripts: services.transcripts,
            instructions: options.instructions,
            effort: effortOf(options.effort),
            transport: transport(options.transport),
            limits: options.limits,
            now,
            ...options.sinks,
          }),
        respond: ({ sinks, secret, transport: given, ...options }) =>
          respondNectovia({
            base: account.base,
            account: scopedAccount,
            connectionId,
            managed: managed(),
            token: secret,
            card: nectoviaRateCard(options.model, policy),
            transport: transport(given),
            now,
            ...options,
            effort: effortOf(options.effort),
            ...sinks,
          }),
      };
    }
  }
}

/**
 * A caller's preview and activity channels, stamped with one fenced attempt's identity: text
 * through `previewSink`, tool activity through `activitySink`, both published in order and only
 * while that attempt still owns its lease. `finish` shows what the channels still hold back, stops
 * accepting, drains, and reports a contract violation or a publication failure.
 */
function fencedSinks(
  input: TextRequest,
  identity: { runId: string; stepId: string; attempt: number; fence: number },
  context: { publishPreview: (publish: () => void) => Promise<void> },
  signal: AbortSignal,
  /** Whether the route declares thinking (`streaming.reasoning`). Work turns pass false. */
  reasoning = false,
  /** The route's redaction (`redactFor`), applied to every frame and to the saved thinking. */
  redact?: (text: string) => string,
  /** The local route's reading counters; they carry no text, so they skip the live order. */
  local = false,
) {
  let accepting = true;
  let pending = Promise.resolve();
  let failure: { error: unknown } | undefined;
  const publish = (deliver: () => void) => {
    if (!accepting || failure) return;
    pending = pending
      .then(async () => {
        if (failure) return;
        await context.publishPreview(() => {
          if (!signal.aborted) deliver();
        });
      })
      .catch((error: unknown) => {
        failure = { error };
      });
  };
  const stamped = { projectId: input.projectId, threadId: input.threadId, requestId: input.requestId, ...identity };
  const order = liveOrder();
  const onDelta = input.onPreview
    ? previewSink({
        identity: stamped,
        signal,
        order,
        redact,
        onInvalid: (invalid) => {
          failure ??= { error: new EngineError('OUTPUT_LIMIT', invalid.reason, true) };
        },
        onPreview: (frame) => publish(() => input.onPreview?.(frame)),
      })
    : undefined;
  const onToolActivity = input.onActivity
    ? activitySink({
        identity: stamped,
        signal,
        order,
        redact,
        onActivity: (frame) => publish(() => input.onActivity?.(frame)),
      })
    : undefined;
  const onReasoningDelta =
    reasoning && input.onReasoning
      ? reasoningSink({
          identity: stamped,
          signal,
          order,
          redact,
          onReasoning: (frame) => publish(() => input.onReasoning?.(frame)),
        })
      : undefined;
  const onPromptProgress = local && input.onPromptProgress
    ? localPromptProgressSink({ identity: stamped, signal,
        publish: frame => publish(() => input.onPromptProgress?.(frame)) })
    : undefined;
  return {
    onDelta,
    onToolActivity,
    onReasoningDelta,
    onPromptProgress,
    finish: async () => {
      order.flush();
      accepting = false;
      await pending;
      if (failure) throw failure.error;
    },
  };
}

const effortOf = (effort: string | undefined): 'low' | 'medium' | 'high' =>
  effort === 'medium' || effort === 'high' ? effort : 'low';

/** OpenRouter requests reasoning only when the caller selected a supported effort. */
const selectedEffortOf = (effort: string | undefined): 'low' | 'medium' | 'high' | undefined =>
  effort === 'low' || effort === 'medium' || effort === 'high' ? effort : undefined;

/** The account service refused a step because the job reached its check-in; its hold was released, so nothing was charged. */
const isManagedCheckIn = (error: ModelApiError) => error.code === 'nectovia_cap_request_required' && isCheckInRefusal(error);

/** A model-API failure in the service's vocabulary. What is known about the send decides the code. */
function modelApiError(error: unknown): unknown {
  if (!(error instanceof ModelApiError)) return error;
  // The gateway's refusals held and sent nothing: said in the Agent's own vocabulary, so a
  // signed-out person is asked to sign in and a plan that ended names the plan.
  if (error.code === 'nectovia_sign_in_required') return new EngineError(AGENT_SIGN_IN_REQUIRED, error.message, false);
  if (error.code === 'nectovia_agent_not_included') return new EngineError(AGENT_NOT_INCLUDED, error.message, false);
  // A member's own monthly limit stopped the step: the person asks an owner or admin,
  // who may approve one job or raise their month, the way a job that reached its cap asks.
  if (error.code === `nectovia_${MEMBER_LIMIT_REACHED}`) return new EngineError(MEMBER_LIMIT, error.message, false);
  // The account service stopped the job at its check-in, before anything was sent: the same stop the
  // local ledger makes, so the person is asked whether to keep going.
  if (isManagedCheckIn(error)) return new EngineError('JOB_CAP', error.message, false);
  if (/^nectovia_/.test(error.code) && error.evidence.reservation?.state === 'released')
    return new EngineError('ROUTE_REFUSED', error.message, true);
  // A job that reached its cap stopped at a step boundary: nothing of that step was sent.
  if (!error.dispatched && /_job_cap_reached$/.test(error.code))
    return new EngineError('JOB_CAP', error.message, false);
  if (!error.dispatched)
    return new EngineError(/_spend_refused$/.test(error.code) ? 'SPEND_LIMIT' : 'ROUTE_REFUSED', error.message, true);
  if (error.evidence.reservation?.state === 'uncertain')
    return new EngineError('DISPATCH_UNCERTAIN', error.message, true);
  return new EngineError('PROVIDER_ERROR', error.message, true);
}

/** The durable admission record — what the admission step is allowed to persist. */
export interface TextAdmission {
  engine: ExternalEngine;
  location: string;
  version: string;
  model: string;
  accountRoute: string;
}

/**
 * Spec decision 5: a kept conversation whose engine is no longer found on this computer is
 * refused in that engine's own words, and only when nothing was sent. Every other refusal keeps
 * its own sentence. One code per meaning, both answered 409, so a caller reads them alike.
 */
function engineGone(engine: string, error: unknown): EngineError | null {
  if (!(error instanceof EngineError) || error.ambiguous) return null;
  const gone = ENGINE_GONE_CODES[error.code];
  if (!gone) return null;
  return new EngineError(
    gone === 'not-installed' ? 'NOT_INSTALLED' : 'AUTH_REQUIRED',
    engineGoneSentence(engine, gone),
    false,
    error.stage,
  );
}

/**
 * The runtime seam's errors surface in the service's own vocabulary. A
 * cancelled or parked run is a request outcome, not a transport fault; an
 * unattributed runtime failure is internal and never presented as provider
 * behaviour.
 */
function seamError(error: unknown): unknown {
  if (!(error instanceof HarnessError)) return error;
  const { code, message } = error;
  if (code === 'run_cancelled' || code === 'step_cancelled')
    return new EngineError(
      'CANCELLED',
      'The request was stopped. No late response was saved.',
      true,
    );
  if (code === 'reconcile_required' || code === 'stale_lease' || code === 'stale_attempt')
    // The dispatch may have reached the provider; the record stays uncertain.
    return new EngineError(
      'DISPATCH_UNCERTAIN',
      `The dispatch outcome could not be confirmed. ${message}`,
      true,
    );
  // A dispatch-phase denial is a refusal: the provider never saw the request.
  // (A result-phase denial surfaces earlier as the parked reconcile_required.)
  if (code === 'egress_denied') return new EngineError('ROUTE_REFUSED', message, true);
  if (code === 'lease_busy' || (code === 'blocked' && /in flight/.test(message)))
    return new EngineError(
      'REQUEST_ACTIVE',
      'This request already has a dispatch in progress.',
      true,
    );
  if (code === 'input_mismatch' || code === 'intent_mismatch' || code === 'run_id_collision')
    return new EngineError('IDENTITY_MISMATCH', message, true);
  if (code === 'request_failed') return new EngineError('PROVIDER_ERROR', message, true);
  return new EngineError('RUNTIME_UNAVAILABLE', message, true);
}
