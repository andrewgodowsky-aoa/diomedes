import fs from 'node:fs/promises';
import { createReadStream, realpath as realpathCallback } from 'node:fs';
import { promisify } from 'node:util';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
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
import { BindingStore } from './binding-store.js';
import { VerificationStore } from './verification.js';
import { recordEngineCatalog } from '../models.js';
import { ClaudeAdapter, CLAUDE_VERSION } from './claude.js';
import { OpenCodeAdapter } from './opencode.js';
import { OmpAdapter } from './omp.js';
import { CursorAdapter, cursorCommand, resolveCursorEntry } from './cursor.js';
import { DevinAdapter } from './devin.js';
import { managedBinary, verifyManagedBinary } from './install.js';
import { capture, engineEnvironment, EngineError } from './process.js';
import { commandGate, previewSink, type PreviewRejection } from '../../shared/adapter-contract.js';
import type {
  PersistentTextAdapter,
  TextEngineAdapter,
  TextRequest,
  TextResponse,
} from './contract.js';
import { contextMessage } from './contract.js';
import type { ClaudeSessionCheckpoint } from './claude-session.js';
import { ClaudeSessionRuns, type ClaudeSessionTurn } from '../harness/claude-session-run.js';
import { HarnessError } from '../harness/policy.js';
import { TEXT_DISPATCH_STEP, textRunId, type TextDispatch } from '../harness/text-route.js';
import { digest } from '../harness/policy.js';
import {
  AWS_BEDROCK_ROUTE,
  AWS_BEDROCK_SDK,
  AWS_LUNA_RATE_CARD,
  ModelApiError,
  WORK_LIMITS,
  awsAccountRoute,
  respondOnce,
  type AwsConnection,
  type AwsConnections,
} from './aws-bedrock.js';
import { createAwsModelAdapter } from '../harness/aws-model-adapter.js';
import type { ModelTranscripts } from '../harness/model-transcripts.js';
import type { ModelSessionAdmission, ModelSessionRuns, ModelSessionTurn } from '../harness/model-session-run.js';
import type { ConnectionSecrets } from '../connection-secrets.js';
import type { SpendExposure } from '../spend-exposure.js';
import type { ModelApiRoute } from '../../shared/model-api.js';

function recordShimError(error: unknown): boolean {
  return (
    (error instanceof EngineError && error.code === 'UNSUPPORTED_SHIM') ||
    (error instanceof Error && 'code' in error && error.code === 'ENOENT')
  );
}

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
  redactFor?(engine: ExternalEngine): (text: string) => string;
  /** This computer's answer for one file: its real path, size and bytes. */
  identify?(file: string): Promise<FileIdentity | null>;
  /** The reviewed-release digest check for Diomedes's own private copy. */
  verifyManaged?(engine: ExternalEngine): Promise<void>;
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
  return `This adapter was checked with ${TESTED_VERSIONS[engine]}. Install a compatible copy for Diomedes, or choose another installation.`;
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
  private digests = new Map<string, FileIdentity>();
  /**
   * The host's runtime seam. External turns do not call an adapter here;
   * they run through the harness RunService under a durable run, its lease
   * fence and its egress authorization. The app attaches the host's
   * `TextRouteRuntime.request` after the harness host exists.
   */
  dispatch?: TextDispatch;
  /** Explicit native-session route; attaching this does not change generate(). */
  nativeSessions?: ClaudeSessionRuns;
  /** The model-API conversation driver (CD-01 Decision 5's second driver). The app attaches it. */
  modelSessions?: ModelSessionRuns;
  /** Connection record, protected credential, spend ledger and private transcripts for model-API routes. */
  modelApi?: ModelApiServices;
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
        const match = result.stdout.match(/\b\d+\.\d+\.\d+\b/);
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
      verifyManaged: (engine) => verifyManagedBinary(root, engine),
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
    if (receipt.candidateId !== stored.binding.id || receipt.version !== stored.binding.version)
      return null;
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
  /** One file's identity, re-read only when its size or modification time moved. */
  private async identify(file: string): Promise<FileIdentity | null> {
    const cached = this.digests.get(path.resolve(file));
    const identity = await this.deps.identify!(file);
    if (!identity) return null;
    if (
      cached &&
      cached.path === identity.path &&
      cached.size === identity.size &&
      cached.mtimeMs === identity.mtimeMs &&
      cached.sha256
    )
      return cached;
    const complete = identity.sha256 ? identity : { ...identity, sha256: await digestFile(identity.path) };
    this.digests.set(path.resolve(file), complete);
    return complete;
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
    // Managed artifacts are pinned Windows executables, never Mac installations.
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
        await this.deps.verifyManaged!(engine);
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
    const compatibility = version === TESTED_VERSIONS[engine] ? 'supported' : 'unsupported';
    return {
      ...base,
      version,
      // A managed copy's bytes matched the release Diomedes reviewed. Their own
      // copy has a recorded identity, so a later change is detected; that is
      // not a claim about who published it.
      integrity: 'verified',
      protocol: 'passed',
      provenance: item.source === 'managed' ? 'reviewed-release' : 'unverified',
      compatibility,
      ...(compatibility === 'unsupported'
        ? {
            issue: `This adapter was checked with ${TESTED_VERSIONS[engine]}. Version ${version} needs compatibility review.`,
          }
        : {}),
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
            'Discovery: observed on win32 via managed-installation; pinned artifact verified and version probed.',
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
    const stored = this.bindings.get(engine);
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
        compatibility: version === TESTED_VERSIONS[engine] ? 'supported' : 'unsupported',
        ...(location ? { location } : {}),
        ...(version ? { version } : {}),
        detail:
          version === TESTED_VERSIONS[engine]
            ? 'Found a compatible installation. Check sign-in and models next.'
            : `This adapter was checked with ${TESTED_VERSIONS[engine]}. The installed version needs compatibility review.`,
      }, looked);
    }
    const decision = selectCandidate(
      inventory,
      { engine, version: TESTED_VERSIONS[engine] },
      binding ?? undefined,
    );
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
    if (saved.compatibility !== 'supported')
      throw new EngineError(
        'UNSUPPORTED_VERSION',
        `Use the reviewed ${TESTED_VERSIONS[engine]} version before connecting this route.`,
      );
    try {
      if (await this.isManaged(engine, saved)) await this.deps.verifyManaged!(engine);
      const version = await this.deps.version(saved.location, signal);
      if (version !== TESTED_VERSIONS[engine])
        throw new EngineError(
          'UNSUPPORTED_VERSION',
          'The tool changed version. Check compatibility before sending.',
        );
      const cwd = path.join(this.root, engine);
      await fs.mkdir(cwd, { recursive: true });
      const result = await this.deps.adapter(engine, saved.location, cwd).inspect(signal);
      const value = this.save({
        ...saved,
        ...result,
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
      selectCandidate(value.candidates ?? [], {
        engine,
        version: TESTED_VERSIONS[engine],
      }).kind === 'candidate'
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
    const decision = selectCandidate([candidate], { engine, version: TESTED_VERSIONS[engine] });
    if (decision.kind !== 'candidate')
      throw new EngineError(
        'CANDIDATE_UNUSABLE',
        candidate.issue ??
          `This adapter was checked with ${TESTED_VERSIONS[engine]}. That installation cannot be used yet.`,
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
            : value.compatibility === 'unsupported'
              ? 'Compatibility check needed'
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
      if (input.onDelta)
        throw new EngineError(
          'PREVIEW_CONTRACT',
          'Preview frames reach the caller through onPreview; the raw adapter sink is not caller-facing.',
          true,
        );
      const runId = textRunId(input.projectId, input.requestId);
      const previewFailures: PreviewRejection[] = [];
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
        admit: async () => {
          // Refresh this route, not all five: admission is on the hot path.
          await this.discover(true, { engine });
          this.adopt(engine);
          await this.check(engine, signal);
          const selected = this.selection(engine, input.model);
          if (selected.accountRoute !== input.accountRoute)
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
            adapter.contract.engine.version !== TESTED_VERSIONS[engine]
          )
            throw new EngineError(
              'CONTRACT_MISMATCH',
              'The adapter descriptor does not name this route and its proven build.',
              true,
            );
          return {
            engine,
            location: value.location!,
            model: selected.model,
            accountRoute: selected.accountRoute,
          } satisfies TextAdmission;
        },
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
          const onDelta = previewSink({
            identity: {
              projectId: input.projectId,
              threadId: input.threadId,
              requestId: input.requestId,
              runId,
              stepId: TEXT_DISPATCH_STEP,
              attempt: context.attempt,
              fence: context.fence,
            },
            redact: this.deps.redactFor?.(engine),
            onPreview: (frame) => {
              if (!accepting || publicationFailure) return;
              pending = pending
                .then(async () => {
                  if (publicationFailure) return;
                  await context.publishPreview(() => {
                    if (!attemptSignal.aborted) input.onPreview?.(frame);
                  });
                })
                .catch((error: unknown) => {
                  publicationFailure = { error };
                });
            },
            onInvalid: (failure) => previewFailures.push(failure),
            signal: attemptSignal,
          });
          let result: TextResponse;
          try {
            result = await adapter.generate({ ...input, signal: attemptSignal, onDelta });
          } finally {
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
            result.requestId !== input.requestId ||
            result.version !== TESTED_VERSIONS[engine]
          )
            throw new EngineError(
              'IDENTITY_MISMATCH',
              'The engine response did not match this request. No response was saved.',
              true,
            );
          if (previewFailures.length)
            throw new EngineError('OUTPUT_LIMIT', previewFailures[0].reason, true);
          return result;
        },
      });
      return { ...outcome.result, runId: outcome.run.id };
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
  ) {
    if (!this.nativeSessions)
      throw new EngineError('RUNTIME_UNAVAILABLE', 'The native session runtime is not attached.');
    if (input.onDelta)
      throw new EngineError('PREVIEW_CONTRACT', 'Use the bounded onPreview channel.');
    const adapterAt = (location: string) => {
      const adapter = this.deps.adapter(
        'claude-code',
        location,
        path.join(this.root, 'claude-code'),
      );
      if (
        !('openSession' in adapter) ||
        typeof adapter.openSession !== 'function' ||
        !('sessionContract' in adapter)
      )
        throw new EngineError(
          'COMMAND_UNSUPPORTED',
          'This adapter has no native session transport.',
        );
      const persistent = adapter as PersistentTextAdapter<ClaudeSessionCheckpoint>;
      const gate = commandGate(persistent.sessionContract, mode);
      if (
        adapter.id !== 'claude-code' ||
        persistent.sessionContract.routeId !== 'claude-code-session' ||
        persistent.sessionContract.engine.version !== TESTED_VERSIONS['claude-code'] ||
        !gate.admitted
      )
        throw new EngineError(
          'CONTRACT_MISMATCH',
          'The native session contract does not match this route and build.',
        );
      return persistent;
    };
    try {
      return await this.nativeSessions.request({
        mode,
        runId,
        sourceRunId,
        input,
        admit: async (signal) => {
          await this.discover(true);
          await this.check('claude-code', signal);
          const selected = this.selection('claude-code', input.model);
          if (selected.accountRoute !== input.accountRoute)
            throw new EngineError(
              'ACCOUNT_CHANGED',
              'The Claude account route changed. Select it again.',
            );
          const value = this.connections.get('claude-code')!;
          adapterAt(value.location!);
          return {
            location: value.location!,
            version: value.version!,
            model: selected.model,
            accountRoute: selected.accountRoute,
          };
        },
        open: (admission, request, options) =>
          adapterAt(admission.location).openSession(request, options),
        preview: (context, stepId) => {
          let accepting = true;
          let pending = Promise.resolve();
          let failure: { error: unknown } | undefined;
          const signal = AbortSignal.any([context.signal, ...(input.signal ? [input.signal] : [])]);
          const onDelta = previewSink({
            identity: {
              projectId: input.projectId,
              threadId: input.threadId,
              requestId: input.requestId,
              runId,
              stepId,
              attempt: context.attempt,
              fence: context.fence,
            },
            signal,
            redact: this.deps.redactFor?.('claude-code'),
            onInvalid: (invalid) => {
              failure = { error: new EngineError('OUTPUT_LIMIT', invalid.reason, true) };
            },
            onPreview: (frame) => {
              if (!accepting || failure) return;
              pending = pending
                .then(async () => {
                  if (failure) return;
                  await context.publishPreview(() => {
                    if (!signal.aborted) input.onPreview?.(frame);
                  });
                })
                .catch((error: unknown) => {
                  failure = { error };
                });
            },
          });
          return {
            onDelta,
            finish: async () => {
              accepting = false;
              await pending;
              if (failure) throw failure.error;
            },
          };
        },
      });
    } catch (error) {
      throw seamError(error);
    }
  }
  /**
   * Admission for a model-API route, read fresh each time: the route is switched on, the saved
   * connection is the one Settings selects, the requested model is the connection's, the
   * credential is present and unexpired, and the spend ledger has an approved cap. Nothing here
   * reads the credential into a record; the adapter opens it inside the dispatch step.
   */
  async admitModelApi(
    route: ModelApiRoute,
    input: Pick<TextRequest, 'model' | 'accountRoute'>,
  ): Promise<ModelSessionAdmission> {
    const api = this.modelApi;
    if (route !== AWS_BEDROCK_ROUTE || !api)
      throw new EngineError('RUNTIME_UNAVAILABLE', 'This model-API route is not available in this process.', true);
    const connection = await api.connections.read();
    if (!connection) throw new EngineError('ROUTE_REFUSED', 'Connect AWS Bedrock in AI setup before sending.', true);
    if (awsAccountRoute(connection) !== input.accountRoute)
      throw new EngineError('ACCOUNT_CHANGED', 'The AWS connection changed. Select it again before sending.');
    if (connection.modelId !== input.model)
      throw new EngineError('ROUTE_REFUSED', `This AWS connection serves ${connection.modelId}, not ${input.model}.`, true);
    if (connection.credential.expiresAt && Date.parse(connection.credential.expiresAt) <= Date.now() + 60_000)
      throw new EngineError('ROUTE_REFUSED', 'The saved AWS key has expired. Enter a new key in AI setup.', true);
    if (!api.secrets.available())
      throw new EngineError('ROUTE_REFUSED', 'Protected credential storage is not available in this process.', true);
    if (!api.exposure.allowance(connection.id) || api.exposure.summary(connection.id).availableMicroUsd <= 0)
      throw new EngineError(
        'SPEND_LIMIT',
        'The approved AWS spend limit has no room left. Nothing was sent. The owner can review usage and approve more in AI setup.',
        true,
      );
    return {
      route: AWS_BEDROCK_ROUTE,
      connectionId: connection.id,
      revision: connection.revision,
      model: connection.modelId,
      accountRoute: awsAccountRoute(connection),
    };
  }
  private async openModelApi(admission: ModelSessionAdmission): Promise<{ connection: AwsConnection; secret: string }> {
    const api = this.modelApi!;
    const connection = await api.connections.read();
    if (!connection || connection.id !== admission.connectionId || connection.revision !== admission.revision)
      throw new EngineError('ACCOUNT_CHANGED', 'The AWS connection changed after this message was admitted. Nothing was sent.');
    return { connection, secret: await api.secrets.get(connection.id) };
  }
  /** One conversation message on a model-API route, through the model-session driver. */
  async modelSession(route: ModelApiRoute, mode: ModelSessionTurn['mode'], runId: string, input: TextRequest) {
    const driver = this.modelSessions;
    const api = this.modelApi;
    if (!driver || !api)
      throw new EngineError('RUNTIME_UNAVAILABLE', 'The model-API conversation runtime is not attached.', true);
    if (input.onDelta) throw new EngineError('PREVIEW_CONTRACT', 'This route has no preview channel.');
    try {
      return await driver.request({
        mode,
        runId,
        input,
        admit: () => this.admitModelApi(route, input),
        adapter: async (admission, instructions, stop) => {
          const { connection, secret } = await this.openModelApi(admission);
          const adapter = createAwsModelAdapter({
            connection,
            secret,
            card: AWS_LUNA_RATE_CARD,
            exposure: api.exposure,
            transcripts: api.transcripts,
            instructions,
            effort: effortOf(input.effort),
            transport: api.transport,
          });
          return {
            ...adapter,
            complete: (request, signal) => adapter.complete(request, AbortSignal.any([signal, stop])),
          };
        },
      });
    } catch (error) {
      throw seamError(modelApiError(error));
    }
  }
  /**
   * One Work text turn on a model-API route: the same fenced text-route run every external engine
   * uses (admission step, one external dispatch step, never resent), with the AWS exchange as the
   * transport. No tools are offered; the result is the text a Work proposal is parsed from.
   */
  async generateModelApi(route: ModelApiRoute, input: TextRequest): Promise<TextResponse & { runId: string }> {
    const key = `${input.projectId}:${input.threadId}`;
    if (this.running.has(key))
      throw new EngineError('REQUEST_ACTIVE', 'This thread already has a request in progress. Wait for it or cancel it.');
    const dispatch = this.dispatch;
    const api = this.modelApi;
    if (!dispatch || !api)
      throw new EngineError('RUNTIME_UNAVAILABLE', 'The harness runtime seam is not attached to this service.', true);
    const controller = new AbortController();
    this.running.set(key, controller);
    const signal = AbortSignal.any([controller.signal, ...(input.signal ? [input.signal] : [])]);
    try {
      const runId = textRunId(input.projectId, input.requestId);
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
        admit: () => this.admitModelApi(route, input),
        send: async (context, admission) => {
          const { connection, secret } = await this.openModelApi(admission);
          const result = await respondOnce({
            connection,
            secret,
            card: AWS_LUNA_RATE_CARD,
            exposure: api.exposure,
            attempt: { runId, stepId: TEXT_DISPATCH_STEP, attempt: context.attempt, requestDigest: digest(intent) },
            instructions: input.instructions,
            messages: [{ role: 'user', content: contextMessage(input) }],
            tools: [],
            effort: effortOf(input.effort),
            limits: WORK_LIMITS,
            signal: AbortSignal.any([signal, context.signal]),
            transport: api.transport,
          });
          if (result.outcome.kind !== 'final')
            throw new ModelApiError('aws_unexpected_tool', 'The model asked for a tool where none was offered.', true);
          context.reportOrigin?.({
            protocolVersion: 1,
            mode: 'direct',
            engine: { id: route, version: AWS_BEDROCK_SDK },
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
            // so the requested model never stands in for one AWS did not report.
            model: result.reportedModel ?? '',
            version: AWS_BEDROCK_SDK,
            threadId: input.threadId,
            projectId: input.projectId,
            requestId: input.requestId,
          };
        },
      });
      return { ...outcome.result, runId: outcome.run.id };
    } catch (error) {
      throw seamError(modelApiError(error));
    } finally {
      controller.abort();
      this.running.delete(key);
    }
  }
  close() {
    for (const controller of this.running.values()) controller.abort();
  }
}


/** What a model-API route needs from the app: its record, its protected credential, its ledgers. */
export interface ModelApiServices {
  connections: AwsConnections;
  secrets: ConnectionSecrets;
  exposure: SpendExposure;
  transcripts: ModelTranscripts;
  /** Tests substitute the network here, below the SDK. Production leaves it unset. */
  transport?: typeof globalThis.fetch;
}

const effortOf = (effort: string | undefined): 'low' | 'medium' | 'high' =>
  effort === 'medium' || effort === 'high' ? effort : 'low';

/** A model-API failure in the service's vocabulary. What is known about the send decides the code. */
function modelApiError(error: unknown): unknown {
  if (!(error instanceof ModelApiError)) return error;
  if (!error.dispatched)
    return new EngineError(error.code === 'aws_spend_refused' ? 'SPEND_LIMIT' : 'ROUTE_REFUSED', error.message, true);
  if (error.evidence.reservation?.state === 'uncertain')
    return new EngineError('DISPATCH_UNCERTAIN', error.message, true);
  return new EngineError('PROVIDER_ERROR', error.message, true);
}

/** The durable admission record — what the admission step is allowed to persist. */
interface TextAdmission {
  engine: ExternalEngine;
  location: string;
  model: string;
  accountRoute: string;
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
