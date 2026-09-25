/**
 * The Software Engineering pack's repository slice (P07), for one Diomedes
 * installation: the Repository view, declared commands, worktrees, and the
 * evidence a command run leaves for H17.
 *
 * Every write is one harness run through the host's RunService, with one tool
 * step dispatched through `ToolRegistry.dispatch`: the intent (tool, inputs
 * digest, targets, principal) is recorded before anything runs, the step
 * waits for an exact approval of that intent, and the outcome is recorded
 * against it. There is no second approval model and no second run store. The
 * person answers in the Files pane's Repository section, and the decision is
 * `RunService.decide` bound to the exact intent hash they were shown.
 *
 * What this slice does not do, on purpose:
 * - It never dispatches while holding the Store lock (the host's step hook
 *   takes it); records are written under the lock, runs outside it.
 * - It never offers a remembered approval. The remembered-approval rules
 *   (`classifyApproval`) do not recognise a command or a worktree change, so
 *   each one asks, every time.
 * - It never loads for a Project that has not turned the pack on.
 */
import { createHash } from 'node:crypto';
import type { CapabilityManifest, HarnessBudget, Json } from '../../shared/harness.js';
import { isPackActive } from '../../shared/capability-packs.js';
import { applicationOrigin, type OriginSnapshot } from '../../shared/attribution.js';
import {
  COMMAND_LIMITS,
  MAX_WORKTREES,
  SOFTWARE_PACK_ID,
  SOFTWARE_PACK_REQUESTS,
  WORKTREE_FOLDER,
  WORKTREE_NAME,
  branchProblem,
  emptySoftwarePackRecord,
  normalCommand,
  parseCommandLine,
  type CommandKind,
  type CommandRunRecord,
  type DeclaredCommand,
  type RepositoryView,
  type RunnableCommand,
  type SoftwarePackRecord,
  type SoftwarePackView,
  type WorktreeRecord,
  type WorktreeRequest,
} from '../../shared/software-pack.js';
import type { ProjectState } from '../../shared/types.js';
import { localHarnessPrincipal } from '../harness/bridge.js';
import { containedPath } from '../harness/containment.js';
import { HarnessError } from '../harness/policy.js';
import { Suspended, type RunService } from '../harness/run-service.js';
import { ToolRegistry } from '../harness/tools.js';
import { ApiError } from '../paths.js';
import { identifier, now, type Store } from '../store.js';
import { fingerprint } from './git.js';
import { commandOutcome, registerSoftwareTools, worktreeOutcome, type CommandOutcome, type WorktreeOutcome } from './tools.js';

const PLATFORMS = ['win32', 'linux', 'darwin'];

export const SOFTWARE_COMMAND_CAPABILITY = {
  id: 'software-pack-command',
  version: 'v1',
  label: 'Run a declared project command',
  description: 'Run one command declared for this project, once, after your exact approval.',
  tools: ['run_command'],
  requestedPermissions: ['write-project-file'],
  approvalPolicy: 'show-first',
  maxTurns: 1,
  supportedPlatforms: PLATFORMS,
} satisfies CapabilityManifest;

export const SOFTWARE_WORKTREE_CAPABILITY = {
  id: 'software-pack-worktree',
  version: 'v1',
  label: 'Change a worktree',
  description: 'Add or remove one git worktree for a task, after your exact approval.',
  tools: ['worktree_add', 'worktree_remove'],
  requestedPermissions: ['write-project-file'],
  approvalPolicy: 'show-first',
  maxTurns: 1,
  supportedPlatforms: PLATFORMS,
} satisfies CapabilityManifest;

/** One tool step and no model call; the budget makes a model call impossible, not merely unused. */
const BUDGET: HarnessBudget = { units: 3, modelCalls: 0, toolCalls: 3, wallMs: null };

/** A fixed procedure ran these steps; no model authored anything (decision 8). */
export const SOFTWARE_PACK_ORIGIN: OriginSnapshot = Object.freeze({
  ...applicationOrigin(),
  executorId: 'diomedes:software-pack',
}) as OriginSnapshot;

const STEP = 'effect';
/** How long an approval stays good once given: long enough to press it, short enough not to linger. */
const APPROVAL_TTL_MS = 10 * 60_000;

const commandId = (command: string, cwd: string) =>
  `cmd-${createHash('sha256').update(`${cwd}\0${normalCommand(command)}`).digest('hex').slice(0, 12)}`;

const seconds = (ms: number | null) => (ms === null ? '' : ` in ${(ms / 1000).toFixed(1)} s`);

export interface CommandEvidence {
  outcome: 'passed' | 'failed' | 'incomplete';
  sentence: string;
}

export class SoftwarePackService {
  readonly tools = new ToolRegistry();
  private readonly owner = identifier('software-pack-');
  private readonly jobs = new Set<Promise<void>>();
  /** Records whose run this process is carrying out. A `running` record not here was left by a stop. */
  private readonly live = new Set<string>();

  constructor(
    private readonly store: Store,
    private readonly runs: RunService,
  ) {
    registerSoftwareTools(this.tools, {
      root: (projectId) => this.store.state(projectId).project.folder,
      active: (projectId) => this.active(projectId),
      now,
    });
  }

  active(projectId: string): boolean {
    return isPackActive(this.store.state(projectId).project.packs, SOFTWARE_PACK_ID);
  }

  /** Every route and write starts here: nothing of this slice runs where the pack is off. */
  assertActive(projectId: string) {
    if (!this.active(projectId))
      throw new ApiError(409, 'Turn on the Software Engineering pack for this project to see its repository.', {
        code: 'pack_inactive',
      });
  }

  /** Wait for every command or worktree change started here to settle. For tests and shutdown. */
  async settled() {
    while (this.jobs.size) await Promise.allSettled([...this.jobs]);
  }

  /**
   * A command or worktree change this process is not carrying out, yet recorded as
   * running, was interrupted by a stop. H12 already treats its effect as uncertain; the
   * record says so, and nothing re-runs it. Call under `store.locked`.
   */
  private async settleInterrupted(projectId: string) {
    const state = this.store.state(projectId);
    const record = state.softwarePack;
    if (!record) return;
    const at = now();
    let changed = false;
    for (const item of [...record.runs, ...record.worktreeRequests]) {
      if (item.state !== 'running' || this.live.has(item.id)) continue;
      item.state = 'uncertain';
      item.endedAt = at;
      item.detail = 'Diomedes stopped while this was running, so what it did is not confirmed. It will not run it again on its own.';
      this.store.addEntry(state, { actor: 'diomedes', kind: 'pack-interrupted', origin: SOFTWARE_PACK_ORIGIN, sentence: item.detail });
      changed = true;
    }
    if (changed) await this.store.persist(state);
  }

  private record(state: ProjectState): SoftwarePackRecord {
    state.softwarePack ??= emptySoftwarePackRecord();
    return state.softwarePack;
  }

  /** A read tool, run through the registry's validation, timeout and output bounds. No run, no effect. */
  private async read<T>(name: string, input: Json): Promise<T> {
    const validated = this.tools.validate(name, input) as Json;
    const controller = new AbortController();
    const output = await this.tools.get(name).execute({
      input: validated,
      idempotencyKey: `read:${name}`,
      attempt: 1,
      fence: 0,
      signal: controller.signal,
      publishPreview: async () => {},
    });
    return output as T;
  }

  async repository(projectId: string): Promise<RepositoryView> {
    this.assertActive(projectId);
    return this.read<RepositoryView>('git_status', { projectId });
  }

  /** The commands this project can run: those declared here, then a task's H17 command checks. */
  runnable(state: ProjectState): RunnableCommand[] {
    const record = state.softwarePack;
    const approved = new Set(
      (record?.runs ?? []).filter((run) => run.decidedBy === 'you' && run.state !== 'declined').map((run) => run.commandId),
    );
    const seen = new Set<string>();
    const out: RunnableCommand[] = [];
    for (const command of record?.commands ?? []) {
      seen.add(command.id);
      out.push({
        id: command.id,
        label: command.label,
        kind: command.kind,
        command: command.command,
        cwd: command.cwd,
        timeoutMs: command.timeoutMs,
        source: 'project',
        parsed: parseCommandLine(command.command),
        approvedBefore: approved.has(command.id),
      });
    }
    for (const task of state.tasks) {
      if (task.deletedAt) continue;
      for (const check of task.acceptance?.checks ?? []) {
        if (check.kind !== 'command') continue;
        const id = commandId(check.command, '');
        if (seen.has(id)) continue;
        seen.add(id);
        out.push({
          id,
          label: `${task.name}: ${check.command}`.slice(0, 120),
          kind: 'test',
          command: normalCommand(check.command),
          cwd: '',
          timeoutMs: COMMAND_LIMITS.defaultTimeoutMs,
          source: 'acceptance',
          parsed: parseCommandLine(check.command),
          approvedBefore: approved.has(id),
        });
      }
    }
    return out;
  }

  async view(projectId: string): Promise<SoftwarePackView> {
    this.assertActive(projectId);
    await this.store.locked(() => this.settleInterrupted(projectId));
    const repository = await this.repository(projectId);
    const state = this.store.state(projectId);
    const record = state.softwarePack ?? emptySoftwarePackRecord();
    return {
      active: true,
      repository,
      commands: this.runnable(state),
      runs: structuredClone(record.runs.slice(-20).reverse()),
      worktrees: structuredClone(record.worktrees),
      worktreeRequests: structuredClone(record.worktreeRequests.slice(-10).reverse()),
      requests: SOFTWARE_PACK_REQUESTS,
    };
  }

  /**
   * Replace the project's declared commands. Declaring runs nothing and grants
   * nothing: each run still waits for its own approval. Call under `store.locked`.
   */
  async declareCommands(projectId: string, input: unknown): Promise<DeclaredCommand[]> {
    this.assertActive(projectId);
    const list = (input as { commands?: unknown } | null)?.commands;
    if (!Array.isArray(list) || list.length > COMMAND_LIMITS.maxCommands)
      throw new ApiError(400, `Declare at most ${COMMAND_LIMITS.maxCommands} commands.`, { code: 'invalid_commands' });
    const state = this.store.state(projectId);
    const declared: DeclaredCommand[] = [];
    for (const item of list) {
      const value = (item ?? {}) as Record<string, unknown>;
      const parsed = parseCommandLine(value.command);
      if (!parsed.ok) throw new ApiError(400, parsed.message, { code: parsed.code });
      const cwd = typeof value.cwd === 'string' && value.cwd.trim() && value.cwd.trim() !== '.' ? value.cwd.trim() : '';
      if (cwd) {
        try {
          await containedPath(state.project.folder, cwd, { write: false });
        } catch (error) {
          throw new ApiError(400, error instanceof Error ? error.message : 'Choose a folder inside this project.', {
            code: error instanceof HarnessError ? error.code : 'invalid_folder',
          });
        }
      }
      const kind: CommandKind = value.kind === 'build' || value.kind === 'check' ? value.kind : 'test';
      const timeout = typeof value.timeoutMs === 'number' && Number.isInteger(value.timeoutMs) ? value.timeoutMs : COMMAND_LIMITS.defaultTimeoutMs;
      if (timeout < COMMAND_LIMITS.minTimeoutMs || timeout > COMMAND_LIMITS.maxTimeoutMs)
        throw new ApiError(400, `A command's time limit is between 1 s and ${COMMAND_LIMITS.maxTimeoutMs / 60_000} minutes.`, {
          code: 'invalid_timeout',
        });
      const command = parsed.argv.join(' ');
      const id = commandId(command, cwd);
      if (declared.some((other) => other.id === id))
        throw new ApiError(400, `${command} is declared twice.`, { code: 'duplicate_command' });
      const label = typeof value.label === 'string' && value.label.trim() ? value.label.trim().slice(0, 80) : command;
      declared.push({
        id,
        label,
        kind,
        command,
        argv: parsed.argv,
        cwd,
        timeoutMs: timeout,
        declaredAt: now(),
        declaredBy: 'you',
      });
    }
    const record = this.record(state);
    record.commands = declared;
    this.store.addEntry(state, {
      actor: 'you',
      kind: 'pack-commands-declared',
      origin: SOFTWARE_PACK_ORIGIN,
      sentence: declared.length
        ? `You declared ${declared.length === 1 ? '1 project command' : `${declared.length} project commands`}: ${declared
            .map((command) => command.command)
            .join(', ')}. Declaring runs nothing; each run asks first.`
        : 'You cleared the declared project commands.',
    });
    await this.store.persist(state);
    return structuredClone(declared);
  }

  /** Start a harness run for one write and stop at its approval. Outside the Store lock. */
  private async prepare(projectId: string, capability: CapabilityManifest, tool: string, input: Json) {
    const principal = localHarnessPrincipal(projectId);
    const run = await this.runs.start({
      tenantId: 'local',
      projectId,
      principal,
      capability,
      tools: this.tools,
      budget: BUDGET,
      input,
    });
    await this.runs.claim(run.id, this.owner, 60_000);
    try {
      await this.tools.dispatch(this.runs, {
        runId: run.id,
        owner: this.owner,
        principal,
        stepId: STEP,
        name: tool,
        input,
        origin: SOFTWARE_PACK_ORIGIN,
      });
    } catch (error) {
      if (!(error instanceof Suspended)) {
        await this.runs.fail(run.id, this.owner, error).catch(() => {});
        throw error;
      }
    }
    const waiting = (await this.runs.get(run.id)).steps.find((step) => step.intent.stepId === STEP);
    if (waiting?.state !== 'waiting_approval')
      throw new ApiError(500, 'The request did not stop for its approval, so nothing was run.');
    return { runId: run.id, intentHash: waiting.intentHash };
  }

  /** Answer one waiting run, bound to the exact intent the person was shown. Outside the Store lock. */
  private async decide(runId: string, intentHash: string, projectId: string, approve: boolean) {
    const run = await this.runs.get(runId);
    const step = run.steps.find((item) => item.intent.stepId === STEP);
    if (run.projectId !== projectId || step?.state !== 'waiting_approval')
      throw new ApiError(409, 'This request is no longer waiting for an answer.', { code: 'not_waiting' });
    if (step.intentHash !== intentHash)
      throw new ApiError(409, 'This approval does not match the waiting request. Reload it and look again.', {
        code: 'exact_approval_required',
      });
    await this.runs.decide(
      { runId, stepId: STEP, decision: approve ? 'approved' : 'denied', decidedBy: 'local-client', ttlMs: APPROVAL_TTL_MS },
      localHarnessPrincipal(projectId),
    );
  }

  /** Run the approved step and settle the run. Outside the Store lock. */
  private async execute<T>(runId: string, projectId: string, tool: string, input: Json, leaseMs: number): Promise<T> {
    const principal = localHarnessPrincipal(projectId);
    await this.runs.claim(runId, this.owner, leaseMs);
    const output = await this.tools.dispatch<Json>(this.runs, {
      runId,
      owner: this.owner,
      principal,
      stepId: STEP,
      name: tool,
      input,
      origin: SOFTWARE_PACK_ORIGIN,
    });
    await this.runs.complete(runId, this.owner, output);
    return output as T;
  }

  private background(job: () => Promise<void>) {
    const running = job().catch((error: unknown) => {
      console.error('A Software Engineering pack job stopped:', error instanceof Error ? error.message : String(error));
    });
    this.jobs.add(running);
    void running.finally(() => this.jobs.delete(running));
  }

  // --- commands --------------------------------------------------------------------

  /** Ask to run one declared command. Nothing runs until the person approves this exact request. */
  async requestCommand(projectId: string, id: string): Promise<CommandRunRecord> {
    const { command, pending } = await this.store.locked(async () => {
      this.assertActive(projectId);
      const state = this.store.state(projectId);
      const command = this.runnable(state).find((item) => item.id === id);
      if (!command) throw new ApiError(404, 'This command is not declared for this project.', { code: 'unknown_command' });
      if (!command.parsed.ok) throw new ApiError(400, command.parsed.message, { code: command.parsed.code });
      await this.settleInterrupted(projectId);
      const pending = (state.softwarePack?.runs ?? []).find((run) => run.state === 'waiting-approval' || run.state === 'running');
      return { command, pending };
    });
    if (pending)
      throw new ApiError(409, `${pending.command} is ${pending.state === 'running' ? 'still running' : 'waiting for your answer'}. One command at a time.`, {
        code: 'command_pending',
      });
    const argv = (command.parsed as { argv: readonly string[] }).argv;
    const input = { projectId, commandId: command.id, argv: [...argv], cwd: command.cwd, timeoutMs: command.timeoutMs };
    const { runId, intentHash } = await this.prepare(projectId, SOFTWARE_COMMAND_CAPABILITY, 'run_command', input);
    return this.store.locked(async () => {
      const state = this.store.state(projectId);
      const entry: CommandRunRecord = {
        id: identifier('CR'),
        commandId: command.id,
        command: command.command,
        argv: [...argv],
        cwd: command.cwd,
        timeoutMs: command.timeoutMs,
        runId,
        intentHash,
        state: 'waiting-approval',
        requestedAt: now(),
        decidedAt: null,
        decidedBy: null,
        startedAt: null,
        endedAt: null,
        durationMs: null,
        exitCode: null,
        stdoutTail: '',
        stderrTail: '',
        fingerprint: null,
        historyMark: null,
        detail: `Waiting for your OK to run ${command.command}${command.cwd ? ` in ${command.cwd}` : ''}. Nothing runs until you say go ahead.`,
      };
      const record = this.record(state);
      record.runs.push(entry);
      if (record.runs.length > COMMAND_LIMITS.maxRuns) record.runs.splice(0, record.runs.length - COMMAND_LIMITS.maxRuns);
      await this.store.persist(state);
      return structuredClone(entry);
    });
  }

  /** The person's answer to one waiting command run. Approval starts it; the result arrives later. */
  async decideCommand(projectId: string, recordId: string, body: unknown): Promise<CommandRunRecord> {
    const answer = parseAnswer(body);
    const entry = await this.store.locked(async () => {
      const state = this.store.state(projectId);
      const found = state.softwarePack?.runs.find((run) => run.id === recordId);
      if (!found) throw new ApiError(404, 'This command run was not found.');
      if (found.state !== 'waiting-approval')
        throw new ApiError(409, 'This command run has already been answered.', { code: 'not_waiting' });
      if (answer.decision === 'go-ahead') this.assertActive(projectId);
      return structuredClone(found);
    });
    await this.decide(entry.runId, answer.intentHash, projectId, answer.decision === 'go-ahead');
    const decided = await this.store.locked(async () => {
      const state = this.store.state(projectId);
      const found = state.softwarePack!.runs.find((run) => run.id === recordId)!;
      found.decidedAt = now();
      found.decidedBy = 'you';
      const where = found.cwd ? ` in ${found.cwd}` : '';
      if (answer.decision === 'declined') {
        found.state = 'declined';
        found.endedAt = found.decidedAt;
        found.detail = 'You declined. Nothing ran.';
      } else {
        found.state = 'running';
        this.live.add(found.id);
        found.startedAt = found.decidedAt;
        found.historyMark = [...state.history].reverse().find((item) => item.files.length > 0)?.id ?? null;
        found.detail = `Running ${found.command}${where}.`;
      }
      this.store.addEntry(state, {
        actor: 'you',
        kind: 'pack-command-approval',
        origin: SOFTWARE_PACK_ORIGIN,
        sentence:
          answer.decision === 'go-ahead'
            ? `You approved running ${found.command}${where}, once.`
            : `You declined running ${found.command}${where}. Nothing ran.`,
      });
      await this.store.persist(state);
      return structuredClone(found);
    });
    if (answer.decision === 'go-ahead')
      this.background(() => this.finishCommand(projectId, decided));
    return decided;
  }

  private async finishCommand(projectId: string, entry: CommandRunRecord) {
    let outcome: CommandOutcome | null = null;
    let failure: string | null = null;
    try {
      outcome = commandOutcome.parse(
        await this.execute(
          entry.runId,
          projectId,
          'run_command',
          { projectId, commandId: entry.commandId, argv: [...entry.argv], cwd: entry.cwd, timeoutMs: entry.timeoutMs },
          entry.timeoutMs + 120_000,
        ),
      );
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
    }
    await this.store.locked(async () => {
      const state = this.store.state(projectId);
      const found = state.softwarePack?.runs.find((run) => run.id === entry.id);
      this.live.delete(entry.id);
      if (!found) return;
      if (outcome) {
        found.state = outcome.outcome === 'refused' ? 'error' : outcome.outcome;
        found.exitCode = outcome.exitCode;
        found.startedAt = outcome.startedAt;
        found.endedAt = outcome.endedAt;
        found.durationMs = outcome.durationMs;
        found.stdoutTail = outcome.stdoutTail;
        found.stderrTail = outcome.stderrTail;
        found.fingerprint = outcome.fingerprint;
        found.detail = outcome.detail;
      } else {
        // Something unforeseen: H12 recorded the effect as uncertain, and nothing re-runs it.
        found.state = 'uncertain';
        found.endedAt = now();
        found.detail = `Diomedes could not confirm how this ended (${failure}). It will not run it again on its own.`;
      }
      this.store.addEntry(state, {
        actor: 'diomedes',
        kind: 'pack-command',
        origin: SOFTWARE_PACK_ORIGIN,
        sentence: `${found.command}: ${
          found.state === 'passed'
            ? `exited 0${seconds(found.durationMs)}.`
            : found.state === 'failed'
              ? `exited ${found.exitCode ?? 'without a code'}${seconds(found.durationMs)}.`
              : found.detail
        }`,
      });
      await this.store.persist(state);
    });
  }

  // --- worktrees -------------------------------------------------------------------

  /** Ask to add or remove one worktree. Nothing changes until the person approves this exact request. */
  async requestWorktree(projectId: string, body: unknown): Promise<WorktreeRequest> {
    const value = (body ?? {}) as Record<string, unknown>;
    const operation = value.operation === 'remove' ? 'remove' : value.operation === 'add' ? 'add' : null;
    if (!operation) throw new ApiError(400, 'Say whether to add or remove a worktree.', { code: 'invalid_worktree' });
    const name = typeof value.name === 'string' ? value.name.trim() : '';
    if (!WORKTREE_NAME.test(name))
      throw new ApiError(400, 'A worktree name is lowercase letters, digits and dashes, at most 40.', { code: 'invalid_worktree' });
    const taskId = typeof value.taskId === 'string' && value.taskId ? value.taskId : null;
    const { branch } = await this.store.locked(async () => {
      this.assertActive(projectId);
      const state = this.store.state(projectId);
      if (taskId && !state.tasks.some((task) => task.id === taskId && !task.deletedAt))
        throw new ApiError(404, 'This task was not found.');
      await this.settleInterrupted(projectId);
      const record = state.softwarePack ?? emptySoftwarePackRecord();
      if (record.worktreeRequests.some((item) => item.state === 'waiting-approval' || item.state === 'running'))
        throw new ApiError(409, 'Another worktree change is waiting. Answer it first.', { code: 'worktree_pending' });
      const live = record.worktrees.find((item) => item.name === name && !item.removedAt);
      if (operation === 'add') {
        if (live) throw new ApiError(409, `${WORKTREE_FOLDER}/${name} already exists.`, { code: 'worktree_exists' });
        if (record.worktrees.filter((item) => !item.removedAt).length >= MAX_WORKTREES)
          throw new ApiError(409, `This project already has ${MAX_WORKTREES} worktrees. Remove one first.`, { code: 'worktree_limit' });
        const branch = typeof value.branch === 'string' && value.branch.trim() ? value.branch.trim() : `diomedes/${name}`;
        const problem = branchProblem(branch);
        if (problem) throw new ApiError(400, problem, { code: 'branch_invalid' });
        return { branch };
      }
      if (!live)
        throw new ApiError(404, 'Only a worktree this pack added can be removed here.', { code: 'worktree_unknown' });
      return { branch: live.branch };
    });
    const input: Json = operation === 'add' ? { projectId, name, branch } : { projectId, name };
    const { runId, intentHash } = await this.prepare(
      projectId,
      SOFTWARE_WORKTREE_CAPABILITY,
      operation === 'add' ? 'worktree_add' : 'worktree_remove',
      input,
    );
    return this.store.locked(async () => {
      const state = this.store.state(projectId);
      const request: WorktreeRequest = {
        id: identifier('WR'),
        operation,
        name,
        branch,
        path: `${WORKTREE_FOLDER}/${name}`,
        taskId,
        runId,
        intentHash,
        state: 'waiting-approval',
        requestedAt: now(),
        decidedAt: null,
        endedAt: null,
        detail:
          operation === 'add'
            ? `Waiting for your OK to add ${WORKTREE_FOLDER}/${name} on a new branch ${branch}.`
            : `Waiting for your OK to remove ${WORKTREE_FOLDER}/${name}. It is removed only if nothing in it is uncommitted.`,
      };
      this.record(state).worktreeRequests.push(request);
      await this.store.persist(state);
      return structuredClone(request);
    });
  }

  async decideWorktree(projectId: string, requestId: string, body: unknown): Promise<WorktreeRequest> {
    const answer = parseAnswer(body);
    const request = await this.store.locked(async () => {
      const found = this.store.state(projectId).softwarePack?.worktreeRequests.find((item) => item.id === requestId);
      if (!found) throw new ApiError(404, 'This worktree request was not found.');
      if (found.state !== 'waiting-approval')
        throw new ApiError(409, 'This worktree request has already been answered.', { code: 'not_waiting' });
      if (answer.decision === 'go-ahead') this.assertActive(projectId);
      return structuredClone(found);
    });
    await this.decide(request.runId, answer.intentHash, projectId, answer.decision === 'go-ahead');
    const decided = await this.store.locked(async () => {
      const state = this.store.state(projectId);
      const found = state.softwarePack!.worktreeRequests.find((item) => item.id === requestId)!;
      found.decidedAt = now();
      const what = found.operation === 'add' ? `adding ${found.path} on ${found.branch}` : `removing ${found.path}`;
      if (answer.decision === 'declined') {
        found.state = 'declined';
        found.endedAt = found.decidedAt;
        found.detail = 'You declined. Nothing changed.';
      } else {
        found.state = 'running';
        this.live.add(found.id);
        found.detail = `${found.operation === 'add' ? 'Adding' : 'Removing'} ${found.path}.`;
      }
      this.store.addEntry(state, {
        actor: 'you',
        kind: 'pack-worktree-approval',
        origin: SOFTWARE_PACK_ORIGIN,
        taskId: found.taskId,
        sentence: answer.decision === 'go-ahead' ? `You approved ${what}, once.` : `You declined ${what}. Nothing changed.`,
      });
      await this.store.persist(state);
      return structuredClone(found);
    });
    if (answer.decision === 'go-ahead') this.background(() => this.finishWorktree(projectId, decided));
    return decided;
  }

  private async finishWorktree(projectId: string, request: WorktreeRequest) {
    let outcome: WorktreeOutcome | null = null;
    let failure: string | null = null;
    try {
      outcome = worktreeOutcome.parse(
        await this.execute(
          request.runId,
          projectId,
          request.operation === 'add' ? 'worktree_add' : 'worktree_remove',
          request.operation === 'add'
            ? { projectId, name: request.name, branch: request.branch }
            : { projectId, name: request.name },
          180_000,
        ),
      );
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
    }
    await this.store.locked(async () => {
      const state = this.store.state(projectId);
      const record = this.record(state);
      const found = record.worktreeRequests.find((item) => item.id === request.id);
      this.live.delete(request.id);
      if (!found) return;
      found.endedAt = now();
      if (!outcome) {
        found.state = 'uncertain';
        found.detail = `Diomedes could not confirm what happened (${failure}). Check ${found.path} before trying again.`;
      } else {
        found.state = outcome.outcome;
        found.detail = outcome.detail;
        if (outcome.outcome === 'done' && found.operation === 'add')
          record.worktrees.push({
            id: identifier('WT'),
            name: found.name,
            branch: found.branch,
            path: found.path,
            taskId: found.taskId,
            createdAt: found.endedAt,
            createRunId: found.runId,
            removedAt: null,
            removeRunId: null,
          } satisfies WorktreeRecord);
        if (outcome.outcome === 'done' && found.operation === 'remove') {
          const live = record.worktrees.find((item) => item.name === found.name && !item.removedAt);
          if (live) {
            live.removedAt = found.endedAt;
            live.removeRunId = found.runId;
          }
        }
      }
      this.store.addEntry(state, {
        actor: 'diomedes',
        kind: 'pack-worktree',
        origin: SOFTWARE_PACK_ORIGIN,
        taskId: found.taskId,
        sentence: found.detail,
      });
      await this.store.persist(state);
    });
  }

  // --- diffs and context ------------------------------------------------------------

  /** One changed file at HEAD and now, for the readable diff. */
  async file(projectId: string, name: unknown) {
    this.assertActive(projectId);
    if (typeof name !== 'string' || !name) throw new ApiError(400, 'Choose a changed file.');
    try {
      return await this.read<Json>('git_file', { projectId, path: name });
    } catch (error) {
      if (error instanceof HarnessError && error.code.startsWith('path_')) throw new ApiError(403, error.message, { code: error.code });
      throw error;
    }
  }

  /**
   * The chosen changed files' diff against HEAD, as text a person may add to
   * their message. Whole or not at all: a diff past the limit is refused, never
   * cut. Only files git lists as changed can be chosen, so this never reads the
   * whole repository.
   */
  async diff(projectId: string, body: unknown) {
    this.assertActive(projectId);
    const paths = (body as { paths?: unknown } | null)?.paths;
    if (!Array.isArray(paths) || !paths.length || !paths.every((item) => typeof item === 'string'))
      throw new ApiError(400, 'Choose at least one changed file.', { code: 'invalid_paths' });
    const repository = await this.repository(projectId);
    if (repository.state !== 'repository') throw new ApiError(409, repository.detail ?? 'This is not a repository.', { code: repository.state });
    const changed = new Map(repository.changes.map((change) => [change.path, change]));
    const unknown = (paths as string[]).filter((item) => !changed.has(item));
    if (unknown.length)
      throw new ApiError(400, `${unknown[0]} is not a changed file in this repository.`, { code: 'not_changed' });
    const untracked = (paths as string[]).filter(
      (item) => changed.get(item)!.kind === 'untracked' || (repository.head === null && changed.get(item)!.kind === 'added'),
    );
    const tracked = repository.head ? (paths as string[]).filter((item) => !untracked.includes(item)) : [];
    const result = await this.read<{ text: string; tooLarge: boolean }>('git_diff', {
      projectId,
      paths: tracked.length ? tracked : [...untracked],
      untracked,
    });
    return result;
  }

  // --- H17 evidence -----------------------------------------------------------------

  /**
   * What the project's recorded runs of one declared command say about a run
   * that finished at `notBefore`. Null when the pack is off here, so the
   * verifier keeps its own sentence. A result counts only when the command
   * ran after the work finished, no recorded write came after it, and the
   * repository is still exactly as it was when it ran.
   */
  async commandEvidence(projectId: string, command: string, notBefore: string | null): Promise<CommandEvidence | null> {
    if (!this.active(projectId)) return null;
    const state = this.store.state(projectId);
    const wanted = normalCommand(command);
    const settled = new Set(['passed', 'failed', 'timed-out', 'output-capped']);
    const found = [...(state.softwarePack?.runs ?? [])]
      .reverse()
      .find(
        (run) =>
          normalCommand(run.command) === wanted &&
          run.cwd === '' &&
          settled.has(run.state) &&
          run.startedAt !== null &&
          (notBefore === null || run.startedAt >= notBefore),
      );
    if (!found)
      return {
        outcome: 'incomplete',
        sentence: `Not run on this output yet: run ${wanted} from Files > Repository after the work finishes, and its recorded result is the evidence.`,
      };
    const mark = found.historyMark;
    const markIndex = mark === null ? -1 : state.history.findIndex((entry) => entry.id === mark);
    const startedAt = found.startedAt!;
    const wroteSince = state.history.some(
      (entry, index) => entry.files.length > 0 && index > markIndex && entry.time >= startedAt,
    );
    if (wroteSince)
      return {
        outcome: 'incomplete',
        sentence: `${wanted} ran at ${startedAt}, and a file was recorded as changed after it, so its result does not describe these bytes. Run it again.`,
      };
    if (found.fingerprint?.digest) {
      const current = await fingerprint(state.project.folder);
      if (current?.digest !== found.fingerprint.digest)
        return {
          outcome: 'incomplete',
          sentence: `${wanted} ran at ${startedAt}, and the repository has changed since, so its result does not describe these bytes. Run it again.`,
        };
    }
    const where = found.fingerprint?.digest ? ` against repository state ${found.fingerprint.digest.slice(0, 12)}` : '';
    if (found.state === 'passed')
      return { outcome: 'passed', sentence: `${wanted} exited 0 at ${found.endedAt}${seconds(found.durationMs)}${where} (command run ${found.id}).` };
    if (found.state === 'failed') {
      const last = (found.stderrTail || found.stdoutTail).trim().split(/\r?\n/).at(-1)?.slice(0, 160);
      return {
        outcome: 'failed',
        sentence: `${wanted} exited ${found.exitCode ?? 'without a code'} at ${found.endedAt}${where} (command run ${found.id})${last ? `: ${last}` : '.'}`,
      };
    }
    return { outcome: 'incomplete', sentence: `${wanted} did not finish when it ran at ${startedAt}: ${found.detail}` };
  }
}

function parseAnswer(body: unknown): { decision: 'go-ahead' | 'declined'; intentHash: string } {
  const value = (body ?? {}) as Record<string, unknown>;
  const decision = value.decision === 'go-ahead' ? 'go-ahead' : value.decision === 'declined' ? 'declined' : null;
  if (!decision || typeof value.intentHash !== 'string' || !/^[a-f0-9]{64}$/.test(value.intentHash))
    throw new ApiError(400, 'Send go-ahead or declined with the exact request you were shown.', { code: 'exact_approval_required' });
  return { decision, intentHash: value.intentHash };
}
