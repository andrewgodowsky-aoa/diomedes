/**
 * H14 host capability: a lead loop's workers and advisor.
 *
 * A lead is an H13 loop run (`./native-loop.ts`). When the person admitted it
 * with a team (`LoopRunInput.team`), this port is what its `assign_workers` and
 * `consult_advisor` tools reach:
 *
 * - **Open** checks each assignment before anything runs: the scope must sit
 *   inside the lead's, the budget may only be smaller than the person admitted,
 *   the handoff envelope must be accepted against the child's own authority, and
 *   the run's worker limit must hold. A refusal is recorded and nothing starts.
 * - **Run** starts every opened worker at once as its own harness run through
 *   `RunService`, with its own registry of read tools bound to its scope, its
 *   route admitted fresh, its budget enforced (turns and calls by the run
 *   service, reported tokens before each call, wall time by a timer) and its
 *   capabilities the lead's narrowed by its Agent's ceiling. It waits for all.
 * - **Advise** does the same for the one advisor, whose registry only reads.
 *
 * Every step of that is appended to the handoff ledger, so the Team view can
 * show it after a restart. A retried lead (H08) takes a finished worker's
 * answer from its earlier attempt instead of running the same task again.
 */
import { createHash } from 'node:crypto';
import type {
  CapabilityManifest,
  HarnessPrincipal,
  HarnessRun,
  Json,
  ModelResult,
} from '../../../shared/harness.js';
import { acceptHandoff, openHandoff } from '../../../shared/handoff.js';
import type { AgentArtifact } from '../../../shared/agents.js';
import type { LoopRunInput } from '../../../shared/native-loop.js';
import {
  ASSIGN_TOOL,
  TEAM_ADVISOR_CAPABILITY,
  TEAM_LIMITS,
  TEAM_WORKER_CAPABILITY,
  assignedBudget,
  assignmentKey,
  childCapabilities,
  harnessBudgetOf,
  outcomeOf,
  reportedTokens,
  runWallMs,
  scopeRefusal,
  teamLeadView,
  type HandoffEvent,
  type HandoffRole,
  type TeamChildInput,
  type TeamConfig,
  type TeamRole,
  type WorkerBudget,
  type WorkerResult,
} from '../../../shared/team-delegation.js';
import { reportedModels } from '../../../shared/native-loop.js';
import { relativeName } from '../../paths.js';
import { identifier, now, type Store } from '../../store.js';
import { ADAPTER_CAPABILITIES } from '../adapters.js';
import { NativeAgent, type ModelAdapter } from '../native-agent.js';
import { LOOP_INSTRUCTIONS, type LoopTeamPort, type TeamAssignment, type TeamOpenedAssignment, type TeamOpenedRecord } from '../native-loop.js';
import { HarnessError } from '../policy.js';
import { routeContractFor } from '../route-contract.js';
import type { RunService } from '../run-service.js';
import type { ToolRegistry } from '../tools.js';
import type { HandoffLedger } from '../../team/handoff-ledger.js';
import type { ChangeSetSummary } from '../../../shared/sandbox.js';

const READ_TOOLS = ['list_project_files', 'read_project_file'];

export const TEAM_WORKER: CapabilityManifest = {
  id: TEAM_WORKER_CAPABILITY,
  version: 'v1',
  label: 'Worker task',
  description: 'One bounded task handed over by a lead Diomedes loop, reading only the files it was given.',
  tools: READ_TOOLS,
  requestedPermissions: [],
  approvalPolicy: 'show-first',
  maxTurns: TEAM_LIMITS.maxTurns,
  supportedPlatforms: ['win32', 'linux', 'darwin'],
};

export const TEAM_ADVISOR: CapabilityManifest = {
  id: TEAM_ADVISOR_CAPABILITY,
  version: 'v1',
  label: 'Advisor',
  description: 'A read-only advisor a lead Diomedes loop consults. Its advice is evidence, never a permission.',
  tools: READ_TOOLS,
  requestedPermissions: [],
  approvalPolicy: 'show-first',
  maxTurns: TEAM_LIMITS.advisor.turns,
  supportedPlatforms: ['win32', 'linux', 'darwin'],
};

/**
 * Every route a child's reads can reach: its own, and its lead's, because the child's answer goes
 * back to the lead. A cloud route in either place must have been granted what the child reads.
 */
export function childReadRoutes(lead: Pick<HarnessRun, 'input'>, childRoute: string): string[] {
  const leadRoute = (lead.input as { route?: unknown } | null)?.route;
  return typeof leadRoute === 'string' && leadRoute !== childRoute ? [childRoute, leadRoute] : [childRoute];
}

/**
 * The advisor's rule, checked where its registry is built: every tool it holds
 * only reads, needs no permission and asks for no approval. A registry that
 * breaks it is refused before the run starts, so an advisor can never be handed
 * an effect by a later change to what the readers are.
 */
export function assertReadOnly(registry: ToolRegistry): void {
  for (const tool of registry.describe())
    if (tool.effect !== 'read' || tool.permission !== null || tool.approval || tool.destination !== 'local')
      throw new HarnessError('advisor_not_read_only', `An advisor may only read; ${tool.name} can do more than that.`);
}

const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');
const LEAD_PARTY = {
  agentId: 'diomedes.native-loop',
  agentVersion: 'v1',
  agentDigest: `sha256:${sha256('diomedes-loop@v1')}`,
  produces: ['plan.markdown', 'answer.text', 'findings.list'] as AgentArtifact[],
};
const PARENT_STOPPED = 'the lead that handed it this task was stopped';
const ACTIVE = ['queued', 'running', 'waiting'];

const toolOutputs = (messages: readonly { role: string; output?: Json }[]) => messages.filter((message) => message.role === 'tool');
const field = (value: Json | undefined, key: string): string | null => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const found = (value as Record<string, Json>)[key];
  return typeof found === 'string' ? found : null;
};
const fixtureCapabilities = () => ADAPTER_CAPABILITIES['native-fixture'];
const FIXTURE_ROUTE = 'native-fixture';

/**
 * A worker's fixed local script: read the file its task names and answer with
 * its first line. When that file is not in the project the script fails, which
 * is how the fixture route shows a worker that could not finish. Not a model.
 */
export function workerFixtureAdapter(task: string): ModelAdapter {
  const named = task.match(/[\w./-]+\.[A-Za-z0-9]{1,8}/)?.[0] ?? 'README.md';
  return {
    id: FIXTURE_ROUTE,
    version: 'team-fixture-v1',
    contract: routeContractFor(FIXTURE_ROUTE),
    capabilities: fixtureCapabilities,
    async complete(request, signal): Promise<ModelResult> {
      signal.throwIfAborted();
      const outputs = toolOutputs(request.messages);
      if (!outputs.length) return { response: { type: 'tool', name: 'read_project_file', input: { path: named } } };
      const output = outputs[0].output as { found?: boolean; refused?: string } | undefined;
      if (output?.refused) throw new HarnessError('worker_input_refused', output.refused);
      if (output?.found === false) throw new HarnessError('worker_input_missing', `${named} is not in the project.`);
      const line = field(outputs[0].output, 'text')?.split(/\r?\n/).find((item) => item.trim())?.trim();
      // "write <file>" or "propose <file>" in the task: change that file in its own copy first.
      const change = task.match(/\b(write|propose) ([\w./-]+\.[A-Za-z0-9]{1,8})/);
      const tool = change?.[1] === 'propose' ? 'propose_file' : 'write_file';
      if (change && outputs.length === 1 && request.tools.some((item) => item.name === tool))
        return { response: { type: 'tool', name: tool, input: { path: change[2], text: `# Checked ${named}\n\n${line ?? ''}\n` } } };
      return { response: { type: 'final', text: line ? `${named}: ${line}` : `${named} is empty.` } };
    },
  };
}

/** The advisor's fixed local script: read the file the question names, then advise on it. Not a model. */
export function advisorFixtureAdapter(question: string): ModelAdapter {
  const named = question.match(/[\w./-]+\.[A-Za-z0-9]{1,8}/)?.[0] ?? null;
  return {
    id: FIXTURE_ROUTE,
    version: 'team-fixture-v1',
    contract: routeContractFor(FIXTURE_ROUTE),
    capabilities: fixtureCapabilities,
    async complete(request, signal): Promise<ModelResult> {
      signal.throwIfAborted();
      const outputs = toolOutputs(request.messages);
      if (named && !outputs.length)
        return { response: { type: 'tool', name: 'read_project_file', input: { path: named } } };
      const line = field(outputs[0]?.output, 'text')?.split(/\r?\n/).find((item) => item.trim())?.trim();
      return {
        response: {
          type: 'final',
          text: line
            ? `Check every figure in the report against ${named} (“${line}”) before proposing it.`
            : 'Check every figure in the report against its source before proposing it.',
        },
      };
    },
  };
}

export interface TeamRouteRequest {
  readonly projectId: string;
  readonly runId: string;
  readonly taskId: string | null;
  readonly model: string | null;
  readonly accountRoute: string | null;
  readonly instructions: string;
  readonly purpose: 'worker' | 'advisor';
}

export interface TeamPortDeps {
  readonly store: Store;
  readonly runs: RunService;
  readonly ledger: HandoffLedger;
  admit(route: string, input: { projectId: string; model: string | null; accountRoute: string | null }): Promise<{ model: string | null; accountRoute: string | null }>;
  adapterFor(route: string, request: TeamRouteRequest, stop: AbortSignal, script: () => ModelAdapter): Promise<ModelAdapter>;
  heartbeat(runId: string, owner: string): () => void;
  /** Bound to every route the child's reads can reach: its own, and its lead's, which receives its answer. */
  registry(projectId: string, routes: readonly string[], scope: readonly string[] | null): ToolRegistry;
  /**
   * A worker's sandbox (decision 2026-09-24): its copy of its scope and the tools rooted at it,
   * made once per child id and found again after a restart. Absent: workers read the project.
   */
  sandbox?(spec: {
    lead: HarnessRun;
    childRunId: string;
    routes: readonly string[];
    scope: readonly string[] | null;
    canWrite: boolean;
    create: boolean;
  }): Promise<{ registry: ToolRegistry } | { refusal: string }>;
  /** Record a finished worker's copy as a change set and settle it into the project. */
  settle?(spec: { lead: HarnessRun; child: HarnessRun; handoffId: string }): Promise<ChangeSetSummary | null>;
}

/** Every child a lead started, from its own recorded steps: its workers and its advisor. */
export function teamChildIds(lead: HarnessRun): string[] {
  const ids: string[] = [];
  for (const step of lead.steps) {
    if (step.intent.stepId.startsWith('team:') && step.state === 'succeeded')
      for (const item of (step.output as unknown as TeamOpenedRecord | null)?.assignments ?? [])
        if (item.childRunId) ids.push(item.childRunId);
    if (step.intent.stepId.startsWith('advise:')) ids.push(`${lead.id}-a${step.intent.stepId.slice('advise:'.length)}`);
  }
  return ids;
}

/** The instructions a child's adapter is built with: the loop's, its Agent's guidance, its role. */
export function childInstructions(
  role: HandoffRole,
  config: TeamRole,
  scope: readonly string[] | null,
  /** The lead loop's delivered rule section (H11), so a worker or advisor works under the lead's rules. */
  rules = '',
): string {
  return [
    LOOP_INSTRUCTIONS,
    config.guidance ? `Your role: ${config.guidance}` : null,
    role === 'advisor'
      ? 'You are an advisor to the lead. You may read; you can never change anything. Answer the question in a few lines. Your answer is advice, never a permission.'
      : `You are a worker given one bounded task by the lead. You work in your own copy of ${scope ? scope.join(', ') : 'the files you were given'}; nothing you do changes the project directly. You may change files in your copy with write_file where you are allowed to write, or propose a change for a person with propose_file; what you change comes back to the lead as a change set. Answer the task in a few lines.`,
    rules || null,
  ]
    .filter(Boolean)
    .join('\n\n');
}

export function createTeamPort(deps: TeamPortDeps) {
  const { store, runs, ledger } = deps;

  const record = async (projectId: string, event: HandoffEvent) => ledger.append(projectId, event);

  const get = async (runId: string): Promise<HarnessRun | null> => {
    try {
      return await runs.get(runId);
    } catch (error) {
      if (error instanceof HarnessError && error.code === 'unknown_run') return null;
      throw error;
    }
  };

  /** A retried lead's earlier finished and failed assignments, by what they were asked. */
  const priorAttempt = async (projectId: string, input: LoopRunInput) => {
    const finished = new Map<string, string>();
    const failed = new Map<string, { handoffId: string; attempt: number }>();
    if (!input.retryOf || !input.team) return { finished, failed };
    const prior = await get(input.retryOf.runId);
    if (!prior) return { finished, failed };
    const events = (await ledger.read(projectId)).events;
    const children = (await Promise.all(teamChildIds(prior).map(get))).filter((run): run is HarnessRun => run !== null);
    const view = teamLeadView({
      lead: prior,
      config: input.team,
      retryOf: null,
      events,
      children,
      leadVerification: null,
    });
    for (const item of view.workers) {
      const key = assignmentKey('worker', item.task, item.scope);
      if (item.outcome === 'completed' || item.outcome === 'reused') finished.set(key, item.handoffId);
      else if (item.outcome === 'failed' || item.outcome === 'died' || item.outcome === 'running')
        failed.set(key, { handoffId: item.handoffId, attempt: item.attempt });
    }
    return { finished, failed };
  };

  /** The envelope and its acceptance against the child's own authority; the reason when either refuses. */
  const envelopeFor = (parent: HarnessRun, id: string, role: TeamRole, task: string, depth: number, siblings: number) => {
    const opened = openHandoff({
      id,
      tenantId: null,
      from: LEAD_PARTY,
      to: {
        agentId: role.agent.id,
        agentVersion: role.agent.version,
        agentDigest: `sha256:${sha256(`${role.agent.id}@${role.agent.version}`)}`,
        accepts: [role.artifact as AgentArtifact],
      },
      artifact: role.artifact as AgentArtifact,
      parentWork: { runId: parent.id, taskId: parent.taskId ?? '', summary: task.slice(0, 200) },
      evidence: [],
      unresolved: [],
      depth,
      siblings,
      payer: {
        kind: role.route === FIXTURE_ROUTE ? 'local-machine' : 'bring-your-own',
        id: role.accountRoute,
        coversChildren: true,
        reason: 'The connection the person chose for this team pays for its work; a handoff mints no credit.',
      },
      // A worker's tools only read, so its handoff requires nothing a reader lacks.
      requiredAuthority: [],
      createdAt: now(),
    });
    if (!opened.ok) return { envelope: null, refusal: opened.reason };
    const accepted = acceptHandoff(opened.envelope, {
      tenantId: null,
      capabilities: childCapabilities(parent.principal.capabilities, role.agent.ceiling),
      membershipState: null,
      grantRevoked: false,
    });
    return accepted.ok ? { envelope: opened.envelope, refusal: null } : { envelope: null, refusal: accepted.reason };
  };

  const summary = (handoffId: string, role: HandoffRole, child: HarnessRun): WorkerResult => ({
    v: 1,
    handoffId,
    role,
    childRunId: child.id,
    // Once its runner returns, a child that is still marked live is not being driven by anyone.
    outcome: outcomeOf(child, false),
    text: typeof (child.result as { text?: unknown } | null)?.text === 'string' ? (child.result as { text: string }).text : null,
    reason: child.cancelReason ?? child.failure?.message ?? null,
    models: reportedModels(child),
    reusedFrom: null,
  });

  const settle = async (parent: HarnessRun, handoffId: string, child: HarnessRun) =>
    record(parent.projectId, {
      v: 1,
      kind: 'settled',
      at: now(),
      handoffId,
      leadRunId: parent.id,
      childRunId: child.id,
      state: child.state,
      text: typeof (child.result as { text?: unknown } | null)?.text === 'string' ? (child.result as { text: string }).text : null,
      reason: child.cancelReason ?? child.failure?.message ?? null,
      models: reportedModels(child),
      used: child.used,
      tokens: reportedTokens(child),
      wallMs: runWallMs(child),
    });

  /**
   * Start or resume one child and wait for it. Idempotent by child id: a replay
   * finds the run and, if it already ended, reads how.
   */
  const runChild = async (spec: {
    parent: HarnessRun;
    stepId: string;
    handoffId: string;
    childRunId: string;
    role: HandoffRole;
    task: string;
    scope: readonly string[] | null;
    budget: WorkerBudget;
    config: TeamRole;
    signal: AbortSignal;
    script: () => ModelAdapter;
  }): Promise<WorkerResult> => {
    const { parent } = spec;
    const principal: HarnessPrincipal = {
      ...parent.principal,
      capabilities: childCapabilities(parent.principal.capabilities, spec.config.agent.ceiling),
    };
    const routes = childReadRoutes(parent, spec.config.route);
    // A worker works in its own sandbox; the advisor only ever reads the project (decision 2026-09-24).
    const canWrite = principal.capabilities.includes('write-project-file');
    let registry = deps.registry(parent.projectId, routes, spec.scope);
    if (spec.role === 'advisor') assertReadOnly(registry);
    let child = await get(spec.childRunId);
    const sandboxed = spec.role === 'worker' && deps.sandbox;
    if (sandboxed && (!child || ACTIVE.includes(child.state))) {
      const made = await deps.sandbox!({ lead: parent, childRunId: spec.childRunId, routes, scope: spec.scope, canWrite, create: !child });
      if ('refusal' in made) {
        if (child) await runs.cancel(child.id, made.refusal, principal).catch(() => undefined);
        else {
          await record(parent.projectId, {
            v: 1,
            kind: 'settled',
            at: now(),
            handoffId: spec.handoffId,
            leadRunId: parent.id,
            childRunId: spec.childRunId,
            state: 'failed',
            text: null,
            reason: made.refusal,
            models: [],
            used: { units: 0, modelCalls: 0, toolCalls: 0 },
            tokens: null,
            wallMs: null,
          });
          return { v: 1, handoffId: spec.handoffId, role: spec.role, childRunId: null, outcome: 'failed', text: null, reason: made.refusal, models: [], reusedFrom: null };
        }
      } else registry = made.registry;
    }
    if (!child) {
      let admitted: { model: string | null; accountRoute: string | null };
      try {
        // The child's route is admitted in its own right, fresh, before it starts.
        admitted = await deps.admit(spec.config.route, {
          projectId: parent.projectId,
          model: spec.config.model,
          accountRoute: spec.config.accountRoute,
        });
      } catch (error) {
        const reason = `It could not start on ${spec.config.route}: ${error instanceof Error ? error.message : String(error)}`;
        await record(parent.projectId, {
          v: 1,
          kind: 'settled',
          at: now(),
          handoffId: spec.handoffId,
          leadRunId: parent.id,
          childRunId: spec.childRunId,
          state: 'failed',
          text: null,
          reason,
          models: [],
          used: { units: 0, modelCalls: 0, toolCalls: 0 },
          tokens: null,
          wallMs: null,
        });
        return { v: 1, handoffId: spec.handoffId, role: spec.role, childRunId: null, outcome: 'failed', text: null, reason, models: [], reusedFrom: null };
      }
      const input: TeamChildInput = {
        v: 1,
        kind: spec.role === 'advisor' ? TEAM_ADVISOR_CAPABILITY : TEAM_WORKER_CAPABILITY,
        parent: { runId: parent.id, stepId: spec.stepId, handoffId: spec.handoffId },
        task: spec.task,
        scope: spec.scope,
        route: spec.config.route,
        model: admitted.model,
        accountRoute: admitted.accountRoute,
        budget: spec.budget,
      };
      child = await runs.start({
        id: spec.childRunId,
        tenantId: parent.tenantId,
        projectId: parent.projectId,
        taskId: parent.taskId,
        sessionId: null,
        principal,
        capability:
          spec.role === 'advisor'
            ? TEAM_ADVISOR
            : sandboxed
              ? { ...TEAM_WORKER, version: 'v2', tools: registry.describe().map((tool) => tool.name) }
              : TEAM_WORKER,
        tools: registry,
        input: input as unknown as Json,
        budget: harnessBudgetOf(spec.budget),
      });
    }
    if (ACTIVE.includes(child.state)) {
      const input = child.input as unknown as TeamChildInput;
      const owner = identifier('team-child-');
      const childId = child.id;
      const stopChild = (reason: string) => void runs.cancel(childId, reason, principal).catch(() => undefined);
      const onParent = () => stopChild(PARENT_STOPPED);
      if (spec.signal.aborted) onParent();
      spec.signal.addEventListener('abort', onParent, { once: true });
      // Wall time is measured from the child's own creation, so a restart does not reset it.
      const remaining = spec.budget.wallMs === null ? null : Math.max(0, spec.budget.wallMs - (Date.now() - Date.parse(child.createdAt)));
      const timer =
        remaining === null
          ? null
          : setTimeout(() => stopChild(`budget reached (wall time ${Math.round((spec.budget.wallMs ?? 0) / 1000)} s)`), remaining);
      timer?.unref?.();
      const controller = new AbortController();
      let beat = () => {};
      try {
        await runs.claim(childId, owner, 60_000, { refuseSettled: true });
        beat = deps.heartbeat(childId, owner);
        const adapter = await deps.adapterFor(
          input.route,
          {
            projectId: child.projectId,
            runId: childId,
            taskId: child.taskId,
            model: input.model,
            accountRoute: input.accountRoute,
            instructions: childInstructions(
              spec.role,
              spec.config,
              spec.scope,
              typeof (parent.input as { instructions?: unknown } | null)?.instructions === 'string'
                ? ((parent.input as { instructions: string }).instructions)
                : '',
            ),
            purpose: spec.role,
          },
          AbortSignal.any([controller.signal, spec.signal]),
          spec.script,
        );
        await new NativeAgent(runs, tokenBudgeted(adapter, runs, childId, spec.budget.tokens, stopChild), registry).run(
          childId,
          owner,
          spec.role === 'advisor' ? spec.task : `${spec.task}${spec.scope ? `\n\nFiles you may read: ${spec.scope.join(', ')}.` : ''}`,
          principal,
          { maxTurns: spec.budget.turns },
        );
      } catch {
        // The child's own record says how it ended; the lead observes that record.
      } finally {
        beat();
        controller.abort();
        if (timer) clearTimeout(timer);
        spec.signal.removeEventListener('abort', onParent);
      }
      child = await runs.get(childId);
    }
    await settle(parent, spec.handoffId, child);
    const result = summary(spec.handoffId, spec.role, child);
    // A finished worker's copy comes back as a change set, never as effects.
    if (sandboxed && child.state === 'completed' && deps.settle)
      return { ...result, changeSet: await deps.settle({ lead: parent, child, handoffId: spec.handoffId }) };
    return result;
  };

  /** The port one lead run is given. */
  const portFor = (lead: HarnessRun, input: LoopRunInput): LoopTeamPort | null => {
    const team: TeamConfig | null | undefined = input.team;
    if (!team) return null;
    return {
      workerRoute: team.worker.route,
      advisor: team.advisor !== null,
      concurrentWorkers: team.limits.concurrentWorkers,
      workersPerRun: team.limits.workersPerRun,
      advicePerRun: team.limits.advicePerRun,
      turnCeiling: team.worker.budget.turns,
      open: async ({ parent, turn, assignments }) => {
        const prior = await priorAttempt(parent.projectId, input);
        const opened: TeamOpenedAssignment[] = [];
        let siblings = 0;
        for (const [index, assignment] of assignments.entries()) {
          const handoffId = `${parent.id}-t${turn}-${index}`;
          const refuse = async (reason: string, scope: readonly string[]) => {
            await record(parent.projectId, {
              v: 1,
              kind: 'refused',
              at: now(),
              handoffId,
              leadRunId: parent.id,
              role: 'worker',
              stepId: `team:${turn}`,
              task: assignment.task,
              scope: [...scope],
              reason,
            });
            opened.push({
              handoffId,
              task: assignment.task,
              scope: [...scope],
              childRunId: null,
              budget: null,
              envelopeId: null,
              refusal: reason,
              reusedFrom: null,
              attempt: 1,
              retryOf: null,
            });
          };
          let scope: string[];
          try {
            scope = [...new Set(assignment.files.map((file) => relativeName(file)))];
          } catch (error) {
            await refuse(error instanceof Error ? error.message : 'That is not a project path.', assignment.files);
            continue;
          }
          const outside = scopeRefusal(scope, team.scope);
          if (outside) {
            await refuse(outside, scope);
            continue;
          }
          const budget = assignedBudget(team.worker.budget, assignment);
          if (!budget.budget) {
            await refuse(budget.refusal, scope);
            continue;
          }
          const key = assignmentKey('worker', assignment.task, scope);
          const reused = prior.finished.get(key);
          if (reused) {
            await record(parent.projectId, {
              v: 1,
              kind: 'reused',
              at: now(),
              handoffId,
              leadRunId: parent.id,
              role: 'worker',
              stepId: `team:${turn}`,
              from: reused,
              task: assignment.task,
              scope,
            });
            opened.push({
              handoffId,
              task: assignment.task,
              scope,
              childRunId: null,
              budget: budget.budget,
              envelopeId: null,
              refusal: null,
              reusedFrom: reused,
              attempt: 1,
              retryOf: null,
            });
            continue;
          }
          const envelope = envelopeFor(parent, `${handoffId}-e`, team.worker, assignment.task, TEAM_LIMITS.depth - 1, siblings);
          if (!envelope.envelope) {
            await refuse(envelope.refusal ?? 'The handoff could not be opened.', scope);
            continue;
          }
          siblings += 1;
          const earlier = prior.failed.get(key) ?? null;
          const childRunId = `${parent.id}-w${turn}-${index}`;
          await record(parent.projectId, {
            v: 1,
            kind: 'opened',
            at: now(),
            handoffId,
            leadRunId: parent.id,
            taskId: parent.taskId,
            role: 'worker',
            stepId: `team:${turn}`,
            childRunId,
            envelopeId: envelope.envelope.id,
            task: assignment.task,
            scope,
            budget: budget.budget,
            agent: team.worker.agent,
            route: team.worker.route,
            model: team.worker.model,
            profile: team.worker.profile,
            attempt: earlier ? earlier.attempt + 1 : 1,
            retryOf: earlier?.handoffId ?? null,
          });
          opened.push({
            handoffId,
            task: assignment.task,
            scope,
            childRunId,
            budget: budget.budget,
            envelopeId: envelope.envelope.id,
            refusal: null,
            reusedFrom: null,
            attempt: earlier ? earlier.attempt + 1 : 1,
            retryOf: earlier?.handoffId ?? null,
          });
        }
        return { v: 1, turn, assignments: opened };
      },
      run: async ({ parent, stepId, opened, signal }) => {
        const prior = opened.assignments.some((item) => item.reusedFrom)
          ? (await ledger.read(parent.projectId)).events
          : [];
        return Promise.all(
          opened.assignments
            .filter((item) => item.childRunId !== null || item.reusedFrom !== null)
            .map(async (item): Promise<WorkerResult> => {
              if (item.reusedFrom) {
                const source = await reusedAnswer(item.reusedFrom, prior);
                return {
                  v: 1,
                  handoffId: item.handoffId,
                  role: 'worker',
                  childRunId: source.childRunId,
                  outcome: 'completed',
                  text: source.text,
                  reason: null,
                  models: source.models,
                  reusedFrom: item.reusedFrom,
                };
              }
              return runChild({
                parent,
                stepId,
                handoffId: item.handoffId,
                childRunId: item.childRunId!,
                role: 'worker',
                task: item.task,
                scope: item.scope,
                budget: item.budget!,
                config: team.worker,
                signal,
                script: () => workerFixtureAdapter(item.task),
              });
            }),
        );
      },
      advise: async ({ parent, stepId, turn, question, signal }) => {
        const advisor = team.advisor!;
        const handoffId = `${parent.id}-t${turn}`;
        const childRunId = `${parent.id}-a${turn}`;
        const scope = team.scope;
        const envelope = envelopeFor(parent, `${handoffId}-e`, advisor, question, TEAM_LIMITS.depth - 1, 0);
        if (!envelope.envelope) {
          const reason = envelope.refusal ?? 'The handoff could not be opened.';
          await record(parent.projectId, {
            v: 1,
            kind: 'refused',
            at: now(),
            handoffId,
            leadRunId: parent.id,
            role: 'advisor',
            stepId,
            task: question,
            scope: [...(scope ?? [])],
            reason,
          });
          return { v: 1, handoffId, role: 'advisor', childRunId: null, outcome: 'refused', text: null, reason, models: [], reusedFrom: null };
        }
        if (!(await get(childRunId)))
          await record(parent.projectId, {
            v: 1,
            kind: 'opened',
            at: now(),
            handoffId,
            leadRunId: parent.id,
            taskId: parent.taskId,
            role: 'advisor',
            stepId,
            childRunId,
            envelopeId: envelope.envelope.id,
            task: question,
            scope: [...(scope ?? [])],
            budget: TEAM_LIMITS.advisor,
            agent: advisor.agent,
            route: advisor.route,
            model: advisor.model,
            profile: advisor.profile,
            attempt: 1,
            retryOf: null,
          });
        return runChild({
          parent,
          stepId,
          handoffId,
          childRunId,
          role: 'advisor',
          task: question,
          scope,
          budget: TEAM_LIMITS.advisor,
          config: advisor,
          signal,
          script: () => advisorFixtureAdapter(question),
        });
      },
    };
  };

  /** The answer a reused handoff carries, from the child that gave it (following reuse chains). */
  const reusedAnswer = async (
    handoffId: string,
    events: readonly HandoffEvent[],
    depth = 0,
  ): Promise<{ childRunId: string | null; text: string | null; models: WorkerResult['models'] }> => {
    const about = events.filter((event) => event.handoffId === handoffId);
    const reused = about.find((event) => event.kind === 'reused');
    if (reused && reused.kind === 'reused' && depth < 16) return reusedAnswer(reused.from, events, depth + 1);
    const opened = about.find((event) => event.kind === 'opened');
    const child = opened && opened.kind === 'opened' ? await get(opened.childRunId) : null;
    if (child)
      return {
        childRunId: child.id,
        text: typeof (child.result as { text?: unknown } | null)?.text === 'string' ? (child.result as { text: string }).text : null,
        models: reportedModels(child),
      };
    const settled = about.find((event) => event.kind === 'settled');
    return settled && settled.kind === 'settled'
      ? { childRunId: settled.childRunId, text: settled.text, models: settled.models }
      : { childRunId: null, text: null, models: [] };
  };

  return { portFor, get, record };
}

/**
 * An adapter held to a reported-token budget. The check runs before each call
 * against what the child's recorded model steps reported, so it survives a
 * restart. A call is never cut off mid-flight: the call that crosses the budget
 * finishes and is recorded, and the next one is not sent.
 */
export function tokenBudgeted(
  adapter: ModelAdapter,
  runs: RunService,
  childRunId: string,
  tokens: number | null,
  stop: (reason: string) => void,
): ModelAdapter {
  if (tokens === null) return adapter;
  const wrapped = Object.create(adapter) as ModelAdapter;
  wrapped.complete = async (request, signal) => {
    const used = reportedTokens(await runs.get(childRunId)) ?? 0;
    if (used >= tokens) {
      const reason = `budget reached (tokens ${used} of ${tokens})`;
      stop(reason);
      throw new HarnessError('blocked', reason);
    }
    return adapter.complete(request, signal);
  };
  return wrapped;
}

export { ASSIGN_TOOL };
export type { TeamAssignment };
