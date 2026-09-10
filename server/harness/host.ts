import path from 'node:path';
import { z } from 'zod';
import type { HarnessPrincipal, HarnessRun, Json } from '../../shared/harness.js';
import { Store, hash } from '../store.js';
import { ApiError } from '../paths.js';
import { secretScrubber } from '../secrets.js';
import { FileRunStore, validateRunId, type RunStore } from './run-store.js';
import { RunService, type StepDefinition, type StepHandler } from './run-service.js';
import { ToolRegistry } from './tools.js';
import { HarnessError } from './policy.js';
import { HarnessBridge } from './bridge.js';
import { ScriptedModelAdapter } from './fixture-adapter.js';
import { REPORT_PATH } from './approval.js';
import { registerFormatReport } from './capabilities/format-report.js';
import { CODEX_REPORT, CodexEngineAdapter, type ResolveHarnessAuthority } from './codex-engine.js';
import { askCodex } from '../integrations.js';
import { parseWorkCommand } from '../work-admission.js';
import { identifier } from '../store.js';
import { currentAuthority as resolveTrustAuthority } from '../trust/index.js';

export const HARNESS_POLICY_VERSION = 'diomedes-host-policy-v1';

// The boundary's reader checks the contract version. The host also needs a
// structurally readable record before startup recovery can touch any Session.
const integer = z.number().int().nonnegative().safe();
const stamp = z.string().refine((value) => Number.isFinite(Date.parse(value)));
const sha = z.string().regex(/^[a-f0-9]{64}$/);
const errorRecord = z.object({ name: z.string(), message: z.string() }).nullable();
const usage = z.object({ units: integer, modelCalls: integer, toolCalls: integer });
// Per-step provenance from trustworthy adapter/runtime metadata. Optional so
// legacy records without origin remain readable; unknown is never invented.
// When present it is validated but never alters intent hashes or approvals.
const stepOrigin = z
  .object({
    protocolVersion: z.literal(1),
    mode: z.enum(['direct', 'supervisor', 'application']),
    engine: z.object({ id: z.string(), version: z.string().nullable() }).nullable(),
    model: z.object({
      requested: z.string().nullable(),
      reported: z.string().nullable(),
      source: z.enum(['runtime', 'not-recorded']),
    }),
    worker: z.object({ id: z.string(), name: z.string() }).optional(),
    producerId: z.string().optional(),
    executorId: z.string().optional(),
    accountRoute: z.string().nullable().optional(),
  })
  .optional();
const readableRun = z.object({
  v: z.literal(1),
  id: z.string(),
  projectId: z.string(),
  tenantId: z.string(),
  sessionId: z.string().nullable(),
  taskId: z.string().nullable(),
  capabilityId: z.string(),
  capabilityVersion: z.string(),
  capabilityTools: z.array(z.string()),
  policyVersion: z.string(),
  principal: z.object({
    id: z.string(),
    projectId: z.string(),
    tenantId: z.string(),
    capabilities: z.array(z.string()),
    identityGeneration: integer,
  }),
  state: z.enum([
    'queued',
    'running',
    'waiting',
    'reconcile_required',
    'completed',
    'failed',
    'cancelled',
  ]),
  budget: usage.extend({ wallMs: integer.nullable() }),
  used: usage,
  owner: z.string().nullable(),
  fence: integer,
  leaseExpiresAt: integer.nullable(),
  parentRunId: z.string().nullable(),
  forkPoint: z.string().nullable(),
  contextRevision: integer,
  transcripts: z.record(
    z.string(),
    z.object({
      providerId: z.string(),
      modelId: z.string().nullable(),
      lineageId: z.string(),
      opaqueRef: z.string(),
      prefixHash: z.string(),
    }),
  ),
  result: z.json(),
  failure: errorRecord,
  cancelReason: z.string().nullable(),
  createdAt: stamp,
  updatedAt: stamp,
  steps: z.array(
    z.object({
      intent: z.object({
        stepId: z.string(),
        stepVersion: z.string(),
        kind: z.enum(['model', 'tool', 'transform', 'approval', 'wait']),
        effect: z.enum(['pure', 'read', 'idempotent', 'non-idempotent']),
        name: z.string().nullable().optional(),
        input: z.json(),
        cost: integer,
        maxAttempts: integer.positive(),
        permission: z.string().nullable(),
        approval: z.boolean(),
        destination: z.enum(['local', 'external']),
        trustedInputRequired: z.boolean(),
        label: z
          .object({
            tenantId: z.string(),
            projectId: z.string(),
            integrity: z.enum(['trusted', 'untrusted']),
            confidentiality: z.enum(['public', 'internal', 'restricted']),
            provenance: z.array(z.string()),
          })
          .nullable(),
        policyVersion: z.string(),
      }),
      intentHash: sha,
      attempt: integer,
      state: z.enum([
        'pending',
        'running',
        'succeeded',
        'retry_wait',
        'waiting_approval',
        'waiting_event',
        'reconcile_required',
        'failed',
        'cancelled',
      ]),
      output: z.json(),
      outputHash: sha.nullable(),
      origin: stepOrigin,
      leaseFence: integer,
      startedAt: stamp.nullable(),
      endedAt: stamp.nullable(),
      error: errorRecord,
    }),
  ),
  approvals: z.array(
    z.object({
      runId: z.string(),
      stepId: z.string(),
      intentHash: sha,
      principalId: z.string(),
      identityGeneration: integer,
      executionGeneration: integer,
      decision: z.enum(['approved', 'denied']),
      decidedBy: z.string(),
      decidedAt: stamp,
      expiresAt: stamp,
      consumedAt: stamp.nullable(),
    }),
  ),
  events: z.array(
    z.object({
      v: z.literal(1),
      seq: integer.positive(),
      runId: z.string(),
      at: stamp,
      type: z.string(),
      stepId: z.string().optional(),
      attempt: integer.optional(),
      attributes: z.record(z.string(), z.json()),
    }),
  ),
  lastSeq: integer,
});

/** One lazily created file store per registered project; no second write queue. */
class ProjectRunStore implements RunStore {
  private projects = new Map<string, FileRunStore>();
  private locations = new Map<string, string>();
  private catalogs = new Map<string, Set<string>>();
  private revisions = new Map<string, number>();
  private duplicates = new Set<string>();
  saved: (run: HarnessRun) => void = () => {};
  constructor(
    private readonly store: Store,
    private readonly dataDir: string,
  ) {}
  private project(projectId: string) {
    this.store.state(projectId);
    let files = this.projects.get(projectId);
    if (!files) {
      files = new FileRunStore(path.join(this.dataDir, 'projects', projectId, 'harness', 'runs'));
      this.projects.set(projectId, files);
    }
    return files;
  }
  async ids(projectId: string): Promise<string[]> {
    const revision = this.revisions.get(projectId) ?? 0;
    const ids = await this.project(projectId).list();
    // A listing begun before create() must not erase the new run's lookup.
    if (revision !== (this.revisions.get(projectId) ?? 0)) return this.ids(projectId);
    this.catalog(projectId, new Set(ids));
    return ids;
  }
  private catalog(projectId: string, ids: Set<string>) {
    const previous = this.catalogs.get(projectId);
    if (previous && previous.size === ids.size && [...ids].every((id) => previous.has(id))) return;
    this.catalogs.set(projectId, ids);
    this.revisions.set(projectId, (this.revisions.get(projectId) ?? 0) + 1);
    this.index();
  }
  private index() {
    this.locations.clear();
    this.duplicates.clear();
    for (const [projectId, ids] of this.catalogs)
      for (const id of ids) {
        if (this.locations.has(id)) this.duplicates.add(id);
        else this.locations.set(id, projectId);
      }
  }
  async list() {
    return (
      await Promise.all((await this.store.projects()).map((project) => this.ids(project.id)))
    ).flat();
  }
  async create(run: HarnessRun) {
    if (this.locations.has(run.id))
      throw new HarnessError('run_exists', 'This run already exists.');
    await this.project(run.projectId).create(run);
    const ids = new Set(this.catalogs.get(run.projectId));
    ids.add(run.id);
    this.catalog(run.projectId, ids);
    this.saved(structuredClone(run));
  }
  async read(runId: string) {
    validateRunId(runId);
    if (this.duplicates.has(runId))
      throw new HarnessError(
        'duplicate_run',
        'This run id appears in more than one project. Its files were left unchanged.',
      );
    const projectId = this.locations.get(runId);
    if (!projectId) return null;
    let run: HarnessRun | null;
    try {
      run = await this.project(projectId).read(runId);
    } catch (error) {
      if (error instanceof SyntaxError)
        throw new HarnessError('invalid_run_record', 'This saved run could not be read.');
      throw error;
    }
    if (
      run &&
      (run.id !== runId ||
        run.projectId !== projectId ||
        !readableRun.safeParse(run).success ||
        run.projectId !== run.principal.projectId ||
        run.tenantId !== run.principal.tenantId ||
        run.events.length !== run.lastSeq ||
        run.events.some((event, index) => event.seq !== index + 1 || event.runId !== run.id))
    )
      throw new HarnessError(
        'invalid_run_record',
        'This saved run has inconsistent identity or events.',
      );
    if (!run) {
      const ids = new Set(this.catalogs.get(projectId));
      ids.delete(runId);
      this.catalog(projectId, ids);
    }
    return run;
  }
  async write(run: HarnessRun) {
    if (this.duplicates.has(run.id) || this.locations.get(run.id) !== run.projectId)
      throw new HarnessError('project_mismatch', 'The run does not belong to this project.');
    await this.project(run.projectId).write(run);
    this.saved(structuredClone(run));
  }
}

class HostRunService extends RunService {
  afterStep: () => Promise<void> = async () => {};
  override async step<T = Json>(
    runId: string,
    owner: string,
    definition: StepDefinition,
    handler: StepHandler<T>,
    principal: HarnessPrincipal,
  ): Promise<T> {
    try {
      return await super.step(runId, owner, definition, handler, principal);
    } finally {
      await this.afterStep();
    }
  }
}

export function createHarnessHost({
  store,
  dataDir,
  currentAuthority,
  codexGenerator,
  codexAccountRoute,
}: {
  store: Store;
  dataDir: string;
  currentAuthority?: ResolveHarnessAuthority;
  codexGenerator?: typeof askCodex;
  codexAccountRoute?: () => Promise<string>;
}) {
  if (path.resolve(dataDir) !== store.dataDir)
    throw new Error('The harness must use the Store data folder.');
  const secrets = new Set<string>();
  const redact = secretScrubber(secrets);
  const files = new ProjectRunStore(store, dataDir);
  let codex: CodexEngineAdapter;
  const runs = new HostRunService(files, {
    clock: Date.now,
    policyVersion: HARNESS_POLICY_VERSION,
    redact,
    authorizeEgress: (runId, intent, principal, phase) =>
      codex.authorize(runId, intent, principal, phase),
  });
  const tools = new ToolRegistry();
  const adapter = new ScriptedModelAdapter(async (runId) => {
    const run = await runs.get(runId);
    return {
      projectId: run.projectId,
      expected: hash(await store.current(run.projectId, REPORT_PATH)),
    };
  });
  registerFormatReport(tools, store, runs);
  codex = new CodexEngineAdapter(
    store,
    runs,
    tools,
    HARNESS_POLICY_VERSION,
    currentAuthority ?? resolveTrustAuthority,
    codexGenerator,
    codexAccountRoute,
  );
  const adapters = { 'native-fixture': adapter, codex };
  const bridge = new HarnessBridge(store, runs, tools, adapter, redact, codex);
  files.saved = (run) => bridge.enqueue(run);
  runs.afterStep = () => bridge.flush();
  runs.use((context) => bridge.beforeStep(context));
  const refreshSecrets = async () => {
    for (const project of await store.projects())
      for (const token of Object.values(await store.readTeamSecrets(project.id)))
        secrets.add(token);
  };
  const get = async (projectId: string, runId: string) => {
    if (!(await files.ids(projectId)).includes(validateRunId(runId)))
      throw new ApiError(404, 'This run was not found in this project.');
    const run = await runs.get(runId);
    if (run.capabilityId === CODEX_REPORT.id) await codex.authorityForRun(run, 'project.read');
    return run;
  };
  // Startup may inspect saved records to report an authority pause. Client
  // reads below still require current rights before returning their contents.
  const savedRuns = async (projectId: string) => {
    const result: HarnessRun[] = [];
    for (const id of await files.ids(projectId)) {
      try {
        const run = await runs.get(id);
        result.push(run);
      } catch (error) {
        if (!(error instanceof HarnessError)) throw error;
        console.warn(`Skipped an unreadable harness run: ${redact(error.message)}`);
      }
    }
    return result;
  };
  const list = async (projectId: string) => {
    const result = await savedRuns(projectId);
    for (const run of result)
      if (run.capabilityId === CODEX_REPORT.id) await codex.authorityForRun(run, 'project.read');
    return result;
  };
  const scrub = <T>(value: T): T =>
    JSON.parse(
      JSON.stringify(value, (_key, item: unknown) =>
        typeof item === 'string' ? redact(item) : item,
      ),
    ) as T;
  return {
    runs,
    tools,
    adapters,
    bridge,
    codex,
    /** Host-only until authenticated client admission is supplied by Trust.
     * Reuses the same command parser, collision check, receipt and Store lock. */
    startCodexReport(
      projectId: string,
      body: Record<string, unknown>,
      selection: { model: string; effort: string },
    ) {
      return store.locked(async () => {
        const command = parseWorkCommand({
          ...body,
          model: selection.model,
          effort: selection.effort,
        });
        if (
          !command ||
          command.request.capabilityId !== CODEX_REPORT.id ||
          command.request.route !== 'codex' ||
          command.request.consent !== true ||
          !command.request.instruction ||
          command.request.threadId
        )
          throw new ApiError(
            400,
            'Provide an explicit versioned Codex report command without team context.',
          );
        const authority = await codex.authority(projectId);
        if (!store.settings.services?.codex || !store.settings.permissions.sending)
          throw new ApiError(403, 'Current sending permission is disabled.');
        const previous = store.workCommand(
          projectId,
          command.admission.commandId,
          command.admission.payloadDigest,
        );
        if (previous) return structuredClone(previous);
        const state = store.state(projectId);
        if (!state.tasks.some((t) => t.id === command.request.taskId && !t.deletedAt))
          throw new ApiError(404, 'This task was not found.');
        if (state.sessions.some((s) => ['queued', 'working', 'waiting'].includes(s.state)))
          throw new ApiError(409, 'This project already has work in progress.');
        store.checkWorkReceiptCapacity(projectId);
        const runId = identifier('R');
        const input = await codex.prepare(runId, projectId, {
          instruction: command.request.instruction,
          sources: command.request.sources,
          consent: true,
          ...selection,
        });
        return bridge.start(
          projectId,
          command.request.taskId,
          CODEX_REPORT.id,
          command.request.instruction,
          authority.principal,
          { runId, input, admission: command.admission },
        );
      });
    },
    redact,
    scrub,
    get,
    list,
    refreshSecrets,
    // Future leased secrets use the same live scrubber; no secret is leased by this fixture.
    rememberSecret(secret: string) {
      if (secret) secrets.add(secret);
    },
    async init() {
      await refreshSecrets();
      await files.list();
      for (const project of await store.projects())
        await bridge.recover(project.id, await savedRuns(project.id));
      await bridge.flush();
    },
    close: () => bridge.close(),
  };
}

export type HarnessHost = ReturnType<typeof createHarnessHost>;
