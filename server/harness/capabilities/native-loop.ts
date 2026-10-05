/**
 * H13 host capability: the Diomedes work loop as a bridge procedure.
 *
 * The loop engine (`../native-loop.ts`) knows no host. This module is what a
 * real project gives it:
 *
 * - **Tools**, registered once in the host registry, each checking at dispatch
 *   that it is running as the exact step of a loop run in that project:
 *   `list_project_files` and `read_project_file` (read only; on a cloud route,
 *   only files the project shares with that route), plus the existing
 *   `propose_write`, whose approval, Need and recorded writer are unchanged.
 * - **Routes**: the scripted `native-fixture` route is built in; a model-API
 *   route (AWS, Azure, OpenRouter, Google Vertex AI) is attached by the app from
 *   `EngineService`, so admission, the credential and the spend cap are the ones
 *   every model-API call is held to.
 * - **Delegation**, one level: a bounded read-only sub-task runs as its own
 *   harness run (`diomedes-loop-delegate`) on the route the person chose, under
 *   a handoff envelope (`shared/handoff.ts`), and is stopped with its parent.
 * - **The finish gate**: when a loop run completes, the task's declared
 *   acceptance checks are run by H17's verifier on the run's exact output, and
 *   the task reads done only when that projection is Verified.
 */
import { createHash } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { z } from 'zod';
import type { CapabilityManifest, HarnessBudget, HarnessPrincipal, HarnessRun, Json, ModelRequest, ModelResult } from '../../../shared/harness.js';
import type { Route } from '../../../shared/types.js';
import { ROUTES } from '../../../shared/engines.js';
import { acceptHandoff, openHandoff } from '../../../shared/handoff.js';
import { latestVerification, verificationOf } from '../../../shared/verification.js';
import {
  LOOP_LIMITS,
  NATIVE_LOOP_CAPABILITY,
  NATIVE_LOOP_DELEGATE_CAPABILITY,
  NATIVE_LOOP_ENGINE,
  NATIVE_LOOP_VERSION,
  loopSessionOrigin,
  reportedModels,
  supervisorOrigin,
  type LoopChildInput,
  type LoopDelegateResult,
  type LoopRunInput,
} from '../../../shared/native-loop.js';
import { ApiError, relativeName } from '../../paths.js';
import { hash, identifier, now, type Store } from '../../store.js';
import { cloudSharing, requireCloudSharing } from '../../cloud-sharing.js';
import { ADAPTER_CAPABILITIES } from '../adapters.js';
import { REPORT_PATH } from '../approval.js';
import type { HarnessProcedure } from '../bridge.js';
import { NativeAgent, type ModelAdapter, type ModelStreamSink } from '../native-agent.js';
import {
  LOOP_INSTRUCTIONS,
  NativeLoop,
  delegateBudget,
  type LoopDelegationPort,
  type LoopToolBinding,
  type NativeLoopOptions,
} from '../native-loop.js';
import { HarnessError, digest } from '../policy.js';
import { routeContractFor } from '../route-contract.js';
import type { RunService } from '../run-service.js';
import { ToolRegistry } from '../tools.js';
import {
  ADVISE_TOOL,
  ASSIGN_TOOL,
  TEAM_ADVISOR_CAPABILITY,
  TEAM_LIMITS,
  TEAM_WORKER_CAPABILITY,
  harnessBudgetOf,
  isExternalWorkerRoute,
  teamLeadView,
  type ExternalWorkerRoute,
} from '../../../shared/team-delegation.js';
import { ExternalWorkerGate, externalWorkerAdapter, routeName, type ExternalWorkerPort } from '../external-worker.js';
import { NECTOVIA_ROUTE } from '../../../shared/model-api.js';
import type { EscalationRole } from '../../../shared/escalation-controls.js';
import type { RoleTier } from '../../../shared/escalation-roles.js';
import { LOCAL_MODEL_ROUTE, type LocalModelProfile } from '../../../shared/local-model.js';
import { localModelWindow } from '../context-assembly.js';
import { reserveRefusal } from '../../../shared/subscription-workers.js';
import { CODEX_ACCOUNT_ROUTE } from '../../engines/codex-session.js';
import { HandoffLedger } from '../../team/handoff-ledger.js';
import { createTeamPort, teamChildIds } from './team-loop.js';
import { applicationOrigin, type OriginSnapshot } from '../../../shared/attribution.js';
import { DELEGATION_LIMITS, SANDBOX_LIMITS, intersectScope, type SandboxManifest } from '../../../shared/sandbox.js';
import { SandboxRefused, SandboxStore } from '../../sandbox/sandbox.js';
import { ChangeSetService } from '../../sandbox/change-sets.js';
import { DELEGATE_TOOL } from '../native-loop.js';
import { proposeTask, workflowApiError } from '../../task-workflow.js';
import { payloadDigest as taskProposalDigest } from '../../command-admission.js';
import { createTaskPhaseGate } from '../../task-phase.js';
import { AGENT_TEAM_TOOLS, AGENT_TEAM_MODEL_CALLS, AGENT_TEAM_RESPONSE_UNITS } from '../../../shared/agent-collaboration.js';
import type { SpendExposure } from '../../spend-exposure.js';
import type { RespondLimits } from '../../engines/model-api-core.js';
import { registerCollaborationTools, type AgentCollaborationHost } from '../agent-collaboration.js';
export { createAgentCollaboration } from '../agent-collaboration.js';
export type { AgentCollaborationHost, AgentCollaborationDeps, AgentCollaborationRequest, CollaborationOptions } from '../agent-collaboration.js';

/** A depth-2 helper's carve: fixed, so it can be the price of the tool that starts it. */
const NESTED_UNITS = 4;
const NESTED_OUTPUT = z.strictObject({
  state: z.string(),
  answer: z.string().nullable(),
  reason: z.string().optional(),
  changes: z
    .strictObject({ applied: z.array(z.string()), waitingForAPerson: z.array(z.string()), conflicts: z.array(z.string()) })
    .optional(),
}) as unknown as z.ZodType<Json>;

/** What a delegate is told about where it works. */
export function delegateInstructions(
  depth: number,
  scope: readonly string[] | null,
  canWrite: boolean,
  /** The loop's delivered rule section (H11), so a helper works under the rules its loop does. */
  rules = '',
): string {
  return [
    LOOP_INSTRUCTIONS,
    'You are a helper given one bounded sub-task. Answer it in a few lines.',
    `You work in your own copy of ${scope ? scope.join(', ') : 'the files you were given'}. Nothing you do changes the project directly.`,
    canWrite
      ? 'You may change files in your copy with write_file, or propose a change for a person with propose_file. What you change comes back to the loop that handed you this task as a change set.'
      : 'You may read your copy; you cannot change anything.',
    depth < LOOP_LIMITS.delegationDepth ? 'You may hand one smaller part to a helper of your own with delegate; it cannot hand work on.' : null,
    rules || null,
  ]
    .filter(Boolean)
    .join('\n\n');
}

export const NATIVE_LOOP: CapabilityManifest = {
  id: NATIVE_LOOP_CAPABILITY,
  version: NATIVE_LOOP_VERSION,
  label: 'Diomedes work loop',
  description:
    'Plan, act through registered tools under Trust, observe, and finish with a claim the task’s declared checks decide.',
  tools: ['list_project_files', 'read_project_file', 'propose_write', 'propose_task', ...AGENT_TEAM_TOOLS],
  requestedPermissions: ['write-project-file'],
  approvalPolicy: 'show-first',
  maxTurns: LOOP_LIMITS.maxTurns,
  supportedPlatforms: ['win32', 'linux', 'darwin'],
};

export const NATIVE_LOOP_DELEGATE: CapabilityManifest = {
  id: NATIVE_LOOP_DELEGATE_CAPABILITY,
  version: NATIVE_LOOP_VERSION,
  label: 'Delegated sub-task',
  description: 'One bounded, read-only sub-task handed over by a Diomedes work loop.',
  tools: ['list_project_files', 'read_project_file'],
  requestedPermissions: [],
  approvalPolicy: 'show-first',
  maxTurns: LOOP_LIMITS.delegateTurns,
  supportedPlatforms: ['win32', 'linux', 'darwin'],
};

/** The route that needs no network: a fixed local script, attributed as an application action. */
export const LOOP_FIXTURE_ROUTE = 'native-fixture';
const READ_MAX_CHARS = 24_000;
const LIST_MAX = 200;
const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');

const isCloudRoute = (route: string): route is Route =>
  route !== LOOP_FIXTURE_ROUTE && (ROUTES as readonly string[]).includes(route);

// --- reading project files --------------------------------------------------------------------

/** What the loop's two readers return, which H12 checks before recording an output. */
const LIST_OUTPUT = z.strictObject({
  files: z.array(z.string()),
  more: z.number().int().positive().optional(),
  note: z.string().optional(),
}) as unknown as z.ZodType<Json>;
const READ_OUTPUT = z.union([
  z.strictObject({ path: z.string(), refused: z.string() }),
  z.strictObject({ path: z.string(), found: z.literal(false) }),
  z.strictObject({
    path: z.string(),
    found: z.literal(true),
    sha: z.string(),
    bytes: z.number().int().nonnegative(),
    text: z.string(),
    truncated: z.boolean(),
  }),
]) as unknown as z.ZodType<Json>;

/**
 * Read one project file for a loop or its delegate. The path guard is the
 * Files pane's (`projectFile` through `Store.current`); on a cloud route the
 * project's sharing grant for that route must list the file, because the text
 * is about to be sent to that provider. A refusal is data the model sees, not a
 * crash: the observation records it.
 */
export async function readFor(
  store: Store,
  projectId: string,
  routes: string | readonly string[],
  input: string,
  /** H14: the explicit files this run may read; null is the whole project as the route allows. */
  scope: readonly string[] | null = null,
): Promise<Json> {
  let path: string;
  try {
    path = relativeName(input);
  } catch (error) {
    return { path: input, refused: error instanceof Error ? error.message : 'That is not a project path.' };
  }
  if (scope && !scope.includes(path)) return { path, refused: 'This file is outside what this run may read, so it was not read.' };
  // Every cloud route the text can reach must be granted it (a delegate's answer goes to its parent's).
  for (const route of typeof routes === 'string' ? [routes] : routes)
    if (isCloudRoute(route))
      try {
        requireCloudSharing(store.state(projectId), route, [path]);
      } catch {
        return { path, refused: `This file is not shared with ${route}, so it was not read.` };
      }
  let text: string | null;
  try {
    text = await store.current(projectId, path);
  } catch (error) {
    return { path, refused: error instanceof Error ? error.message : 'The path guard refused this file.' };
  }
  if (text === null) return { path, found: false };
  return {
    path,
    found: true,
    sha: hash(text),
    bytes: Buffer.byteLength(text),
    text: text.length > READ_MAX_CHARS ? text.slice(0, READ_MAX_CHARS) : text,
    truncated: text.length > READ_MAX_CHARS,
  };
}

export async function listFor(
  store: Store,
  projectId: string,
  routes: string | readonly string[],
  scope: readonly string[] | null = null,
): Promise<Json> {
  const names = (await store.listDocuments(projectId)).map((document) => document.path);
  const cloud = (typeof routes === 'string' ? [routes] : routes).find(isCloudRoute);
  const shared = cloud ? new Set(cloudSharing(store.state(projectId)).documents) : null;
  const files = names.filter((name) => (!shared || shared.has(name)) && (!scope || scope.includes(name)));
  return {
    files: files.slice(0, LIST_MAX),
    ...(files.length > LIST_MAX ? { more: files.length - LIST_MAX } : {}),
    ...(shared ? { note: `Only files shared with ${cloud} are listed.` } : scope ? { note: 'Only files this run may read are listed.' } : {}),
  };
}

const loopInput = (run: Pick<HarnessRun, 'input'>): LoopRunInput => {
  const input = run.input as unknown as LoopRunInput | undefined;
  if (!input || input.kind !== 'diomedes-loop') throw new HarnessError('invalid_loop_input', 'This run has no loop admission.');
  return input;
};
const childInput = (run: Pick<HarnessRun, 'input'>): LoopChildInput => {
  const input = run.input as unknown as LoopChildInput | undefined;
  if (!input || input.kind !== 'diomedes-loop-delegate')
    throw new HarnessError('invalid_loop_input', 'This run has no delegate admission.');
  return input;
};

/**
 * The host registry's read tools. The model never supplies `projectId` or
 * `runId`: the loop binds them, and the tool checks at dispatch that it is the
 * running step of a loop run in that project, the way `propose_write` does.
 */
export function registerLoopTools(tools: ToolRegistry, store: Store, runs: RunService) {
  const read = {
    version: 'v1',
    effect: 'read',
    effectClass: 'read',
    permission: null,
    approval: false,
    destination: 'local',
    trustedInputRequired: false,
    cost: 0,
  } as const;
  const scope = z.strictObject({ projectId: z.string().min(1).max(100), runId: z.string().min(1).max(128) });
  const ownRun = async (context: { idempotencyKey: string }, input: { projectId: string; runId: string }, name: string) => {
    const run = await runs.get(input.runId);
    const step = run.steps.find(
      (item) =>
        item.intent.name === name &&
        digest({ runId: run.id, stepId: item.intent.stepId, intentHash: item.intentHash }) === context.idempotencyKey,
    );
    if (
      run.projectId !== input.projectId ||
      ![NATIVE_LOOP.id, NATIVE_LOOP_DELEGATE.id].includes(run.capabilityId) ||
      step?.state !== 'running'
    )
      throw new ApiError(409, 'This read is not the active step of a loop run in this project.');
    return run;
  };
  const routeOf = (run: HarnessRun) =>
    run.capabilityId === NATIVE_LOOP.id ? loopInput(run).route : childInput(run).route;
  // H14: a lead admitted with a team reads only inside the scope the person gave it.
  const scopeOf = (run: HarnessRun) => {
    if (run.capabilityId !== NATIVE_LOOP.id) return null;
    const input = loopInput(run);
    return input.collaboration?.sources.map(source => source.path) ?? input.team?.scope ?? null;
  };
  tools.register({
    ...read,
    name: 'list_project_files',
    outputSchema: LIST_OUTPUT,
    description: 'List the project’s files.',
    schema: scope,
    execute: async (context) => {
      const run = await ownRun(context, context.input, 'list_project_files');
      return listFor(store, run.projectId, routeOf(run), scopeOf(run));
    },
  });
  tools.register({
    ...read,
    name: 'read_project_file',
    outputSchema: READ_OUTPUT,
    description: 'Read one project file as text.',
    schema: scope.extend({ path: z.string().trim().min(1).max(400) }),
    execute: async (context) => {
      const run = await ownRun(context, context.input, 'read_project_file');
      return readFor(store, run.projectId, routeOf(run), context.input.path, scopeOf(run));
    },
  });
  const proposal = scope.extend({
    name: z.string().trim().min(1).max(200),
    description: z.string().max(10_000),
    output: z.string().trim().min(1).max(1000),
  });
  const proposalOutput = z.strictObject({ taskId: z.string(), inbox: z.literal(true) });
  tools.register({
    ...read,
    name: 'propose_task',
    description: 'Propose a separate child task for the person to accept in Inbox. This does not start it.',
    effect: 'idempotent',
    effectClass: 'idempotent-write',
    schema: proposal,
    outputSchema: proposalOutput,
    targets: (input) => [`tasks/${input.projectId}/${input.runId}`],
    execute: async (context) => {
      const run = await ownRun(context, context.input, 'propose_task');
      if (run.capabilityId !== NATIVE_LOOP.id || !run.taskId || !run.sessionId)
        throw new ApiError(409, 'Only a task work loop can propose a child.');
      return store.locked(async () => {
        context.signal?.throwIfAborted();
        const state = store.state(run.projectId);
        const commandId = `proposal.${context.idempotencyKey}`;
        const payloadDigest = taskProposalDigest(context.input);
        const existing = state.tasks.find((task) => task.creationReceipt?.commandId === commandId);
        if (existing) {
          if (existing.creationReceipt!.payloadDigest !== payloadDigest)
            throw new ApiError(409, 'This proposal identity already names a different task.');
          return { taskId: existing.id, inbox: true as const };
        }
        const parent = state.tasks.find((task) => task.id === run.taskId);
        const input = {
          name: context.input.name,
          description: context.input.description,
          output: context.input.output,
          parentTaskId: run.taskId!,
          sessionId: run.sessionId!,
          origin: parent?.origin,
        };
        const child = (() => {
          try { return proposeTask(store, state, input); }
          catch (error) { throw workflowApiError(error); }
        })();
        const event = state.history.at(-1)!;
        child.creationReceipt = {
          protocolVersion: 1, commandId, payloadDigest, projectId: run.projectId,
          taskId: child.id, eventId: event.id, admittedAt: event.time,
          actor: 'harness', scope: 'local-prototype',
        };
        await store.persist(state);
        return { taskId: child.id, inbox: true as const };
      });
    },
    reconcile: async ({ input, record }) => {
      const task = store.state(input.projectId).tasks.find((item) =>
        item.creationReceipt?.commandId === `proposal.${record.idempotencyKey}` &&
        item.creationReceipt.payloadDigest === taskProposalDigest(input));
      return task ? { applied: { taskId: task.id, inbox: true } } : 'not-applied';
    },
  });
}

/** What the model supplies for each loop tool; the host binds the rest. */
export function loopBindings(store: Store): LoopToolBinding[] {
  return [
    {
      name: 'propose_task',
      description: 'Propose a bounded child task only for a separate result. It waits in Inbox and cannot start itself.',
      schema: z.strictObject({
        name: z.string().trim().min(1).max(200), description: z.string().max(10_000),
        output: z.string().trim().min(1).max(1000),
      }),
      bind: (input, run) => ({ ...(input as { name: string; description: string; output: string }), projectId: run.projectId, runId: run.id }),
    },
    {
      name: 'list_project_files',
      description: 'List the project’s files by path.',
      schema: z.strictObject({}),
      bind: (_input, run) => ({ projectId: run.projectId, runId: run.id }),
    },
    {
      name: 'read_project_file',
      description: 'Read one project file as text, by its path.',
      schema: z.strictObject({ path: z.string().trim().min(1).max(400) }),
      bind: (input, run) => ({ projectId: run.projectId, runId: run.id, path: (input as { path: string }).path }),
    },
    {
      name: 'propose_write',
      description: `Propose the full text of ${REPORT_PATH}. The person sees it and says go ahead before anything is written.`,
      schema: z.strictObject({ text: z.string().max(128_000).refine((value) => !value.includes('\0')) }),
      bind: async (input, run) => ({
        projectId: run.projectId,
        runId: run.id,
        files: [REPORT_PATH],
        expected: hash(await store.current(run.projectId, REPORT_PATH)),
        text: (input as { text: string }).text,
      }),
    },
  ];
}

/**
 * A child's own registry: the same two readers, bound to the child's project, to both the
 * child's route and the parent's (the child's answer is sent on to the parent's route), and to
 * the child's (H14) read scope. Nothing in it can change anything.
 */
export function delegateRegistry(
  store: Store,
  projectId: string,
  route: string | readonly string[],
  scope: readonly string[] | null = null,
): ToolRegistry {
  const registry = new ToolRegistry();
  const read = {
    version: 'v1',
    effect: 'read',
    effectClass: 'read',
    permission: null,
    approval: false,
    destination: 'local',
    trustedInputRequired: false,
    cost: 0,
  } as const;
  registry.register({
    ...read,
    name: 'list_project_files',
    outputSchema: LIST_OUTPUT,
    description: 'List the project’s files by path.',
    schema: z.strictObject({}),
    execute: () => listFor(store, projectId, route, scope),
  });
  registry.register({
    ...read,
    name: 'read_project_file',
    outputSchema: READ_OUTPUT,
    description: 'Read one project file as text, by its path.',
    schema: z.strictObject({ path: z.string().trim().min(1).max(400) }),
    execute: ({ input }) => readFor(store, projectId, route, input.path, scope),
  });
  return registry;
}

/**
 * An external worker's files, whole, for its one turn. The rules a loop's reads follow apply:
 * a path inside the project and inside the worker's scope, shared with every cloud route the
 * text can reach. A file that can't be given refuses the turn instead of being cut or skipped.
 */
export async function workerDocuments(
  store: Store,
  projectId: string,
  routes: readonly string[],
  scope: readonly string[] | null,
): Promise<{ path: string; text: string }[]> {
  if (!scope?.length) return [];
  const documents: { path: string; text: string }[] = [];
  for (const name of scope) {
    const path = relativeName(name);
    for (const route of routes) if (isCloudRoute(route)) requireCloudSharing(store.state(projectId), route, [path]);
    const text = await store.current(projectId, path);
    if (text === null) throw new HarnessError('external_worker_source', `${path} wasn't found, so the worker can't be given it.`);
    documents.push({ path, text });
  }
  return documents;
}

// --- the scripted route -----------------------------------------------------------------------

const toolOutputs = (request: ModelRequest) => request.messages.filter((message) => message.role === 'tool');
const text = (value: Json | undefined, key: string): string | null => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const found = (value as Record<string, Json>)[key];
  return typeof found === 'string' ? found : null;
};

/**
 * The scripted route streams like a provider does: its text in small chunks,
 * so a phrase can fall across two of them (H16).
 */
const FIXTURE_CHUNK = 5;
function streamed(stream: ModelStreamSink | undefined, result: ModelResult): ModelResult {
  if (stream && result.response.type === 'final')
    for (let at = 0; at < result.response.text.length; at += FIXTURE_CHUNK)
      stream.onDelta(result.response.text.slice(at, at + FIXTURE_CHUNK));
  return result;
}

/**
 * The loop's fixed local script, for the fixture route: plan, read the first
 * selected file, hand the second to a delegate when delegation is offered,
 * propose the report, then claim it is done. Not a model: every step it drives
 * is an application action, and no model is ever named for it.
 */
export function loopFixtureAdapter(sources: readonly string[], team = false, goal = ''): ModelAdapter {
  const first = sources[0] ?? 'README.md';
  const second = sources[1] ?? first;
  // "have a helper write <file>" (or propose) in the goal: the helper changes that file in its sandbox.
  const helperChange = goal.match(/\bhave a helper (write|propose) ([\w./-]+\.[A-Za-z0-9]{1,8})/);
  const helperTask = helperChange
    ? `Read ${second} and ${helperChange[1]} ${helperChange[2]} with what it lists.`
    : `Read ${second} and say in one line what it lists.`;
  const rest = sources.slice(1, 4);
  /**
   * H14's lead script, when workers are offered: read the first file, hand each
   * of the next (up to three) to its own worker at once, ask the advisor about
   * the first file when one is offered, propose the report, then claim it.
   */
  const teamScript = (offered: ReadonlySet<string>, outputs: ReturnType<typeof toolOutputs>): ModelResult => {
    const plan: { name: string; input: Json }[] = [{ name: 'read_project_file', input: { path: first } }];
    if (rest.length)
      plan.push({
        name: ASSIGN_TOOL,
        input: { tasks: rest.map((file) => ({ task: `Read ${file} and say in one line what it lists.`, files: [file] })) },
      });
    if (offered.has(ADVISE_TOOL))
      plan.push({ name: ADVISE_TOOL, input: { question: `What should be checked in ${first} before the report is proposed?` } });
    if (outputs.length < plan.length) return { response: { type: 'tool', ...plan[outputs.length] } };
    if (outputs.length === plan.length) {
      const lines = ['# Loop report', '', `## ${first}`, '', text(outputs[0].output, 'text') ?? 'Not read.', ''];
      const workers = (outputs[1]?.output as { workers?: { files?: string[]; answer?: string | null }[] } | undefined)?.workers ?? [];
      for (const worker of workers) lines.push(`## ${worker.files?.join(', ') ?? 'Worker'}`, '', worker.answer ?? 'No answer came back.', '');
      const advice = offered.has(ADVISE_TOOL) ? text(outputs[plan.length - 1]?.output, 'advice') : null;
      if (advice) lines.push('## Advice (not a permission)', '', advice, '');
      return { response: { type: 'tool', name: 'propose_write', input: { text: lines.join('\n') } } };
    }
    return {
      response: {
        type: 'final',
        text: `Proposed ${REPORT_PATH} from ${first} and ${rest.length} worker${rest.length === 1 ? '' : 's'}' readings.`,
      },
    };
  };
  return {
    id: LOOP_FIXTURE_ROUTE,
    version: 'loop-fixture-v1',
    contract: routeContractFor(LOOP_FIXTURE_ROUTE),
    capabilities: () => ADAPTER_CAPABILITIES['native-fixture'],
    async complete(request, signal, stream): Promise<ModelResult> {
      signal.throwIfAborted();
      if (!request.tools.length)
        return streamed(stream, {
          response: {
            type: 'final',
            text: team
              ? `1. Read ${first}.\n2. Hand ${rest.join(', ') || first} to workers, one file each.\n3. Ask the advisor what to check.\n4. Propose ${REPORT_PATH}.\n5. Summarise what was done.`
              : `1. Read ${first}.\n2. ${second !== first ? `Ask a helper to check ${second}.` : 'Check what it says.'}\n3. Propose ${REPORT_PATH}.\n4. Summarise what was done.`,
          },
        });
      const offered = new Set(request.tools.map((tool) => tool.name));
      const outputs = toolOutputs(request);
      if (offered.has(ASSIGN_TOOL)) return teamScript(offered, outputs);
      const plan: { name: string; input: Json }[] = [{ name: 'read_project_file', input: { path: first } }];
      if (offered.has('delegate') && second !== first)
        plan.push({ name: 'delegate', input: { task: helperTask } });
      if (outputs.length < plan.length) return { response: { type: 'tool', ...plan[outputs.length] } };
      if (outputs.length === plan.length) {
        const lines = [`# Loop report`, ''];
        const read = text(outputs[0].output, 'text');
        lines.push(`## ${first}`, '', read ?? 'Not read.', '');
        if (plan.length > 1) lines.push(`## ${second}`, '', text(outputs[1].output, 'answer') ?? 'No answer came back.', '');
        return { response: { type: 'tool', name: 'propose_write', input: { text: lines.join('\n') } } };
      }
      return streamed(stream, {
        response: {
          type: 'final',
          text: `Proposed ${REPORT_PATH} from ${plan.length > 1 ? `${first} and a helper's reading of ${second}` : first}.`,
        },
      });
    },
  };
}

/**
 * The delegate's fixed local script: read the file its task names; when the
 * task says "write <file>" or "propose <file>" and its copy may be changed,
 * write that file in its copy with what it read; then answer with the first line.
 */
export function delegateFixtureAdapter(task: string, canWrite = false): ModelAdapter {
  const named = task.match(/[\w./-]+\.[A-Za-z0-9]{1,8}/)?.[0] ?? 'README.md';
  const change = canWrite ? task.match(/\b(write|propose) ([\w./-]+\.[A-Za-z0-9]{1,8})/) : null;
  return {
    id: LOOP_FIXTURE_ROUTE,
    version: 'loop-fixture-v1',
    contract: routeContractFor(LOOP_FIXTURE_ROUTE),
    capabilities: () => ADAPTER_CAPABILITIES['native-fixture'],
    async complete(request, signal): Promise<ModelResult> {
      signal.throwIfAborted();
      const outputs = toolOutputs(request);
      if (!outputs.length) return { response: { type: 'tool', name: 'read_project_file', input: { path: named } } };
      const body = text(outputs[0].output, 'text');
      const line = body?.split(/\r?\n/).find((item) => item.trim())?.trim();
      if (change && outputs.length === 1)
        return {
          response: {
            type: 'tool',
            name: change[1] === 'propose' ? 'propose_file' : 'write_file',
            input: { path: change[2], text: `# Checked ${named}\n\n${line ?? 'It could not be read.'}\n` },
          },
        };
      return { response: { type: 'final', text: line ? `${named}: ${line}` : `${named} could not be read.` } };
    },
  };
}

// --- routes -----------------------------------------------------------------------------------

export interface LoopRouteRequest {
  readonly projectId: string;
  readonly runId: string;
  readonly taskId: string | null;
  readonly model: string | null;
  readonly accountRoute: string | null;
  readonly instructions: string;
  readonly purpose: 'loop' | 'delegate' | 'worker' | 'advisor';
  readonly rootRunId?: string;
  readonly rootJobId?: string;
  readonly threadId?: string | null;
  readonly scopedLedger?: SpendExposure;
  readonly effort?: string | null;
  readonly callLimits?: RespondLimits;
  /** An external worker's files, read by the host and attached to its one turn. */
  readonly scope?: readonly string[] | null;
  /** Every route the child's text can reach: its own and its lead's, which receives its answer. */
  readonly readRoutes?: readonly string[];
  /** The account identity an external worker was admitted under, where its engine reports one. */
  readonly accountDigest?: string | null;
  /** A Nectovia role under another lead: the tier it runs at and the role its calls name. */
  readonly tier?: RoleTier;
  readonly escalation?: EscalationRole;
}

/** What a tiered Nectovia role is admitted with: its own job, its tier and the role its calls name. */
export interface LoopTieredAdmission {
  readonly runId?: string;
  readonly tier?: RoleTier;
  readonly escalation?: EscalationRole;
}

/**
 * The model-API routes, attached by the app from `EngineService`. `admit` is
 * the route's own admission, read fresh; `adapter` opens the credential inside
 * the call and binds the spend ledger. Neither ever falls back to another route.
 */
export interface LoopModelRoutes {
  admit(route: string, input: { projectId: string; model: string | null; accountRoute: string | null; rootRunId?: string; rootJobId?: string; threadId?: string | null; effort?: string | null } & LoopTieredAdmission): Promise<{ model: string; accountRoute: string }>;
  adapter(route: string, request: LoopRouteRequest, stop: AbortSignal): Promise<ModelAdapter>;
  rootLedger?(projectId: string, rawJobId: string, threadId: string | null): Promise<SpendExposure>;
}

export interface LoopVerification {
  verify(projectId: string, sessionId: string, options: { requestedBy: 'diomedes-loop' }): Promise<unknown>;
}

/** The instructions a loop's adapter is built with: the loop's own, then H11's delivered section. */
export function loopInstructions(input: Pick<LoopRunInput, 'instructions' | 'delegate' | 'team' | 'collaboration'>): string {
  return [
    LOOP_INSTRUCTIONS,
    input.delegate
      ? `You may hand bounded sub-tasks to helpers with the delegate tool, several at once, at most ${LOOP_LIMITS.delegationsPerRun} per run. Each works in its own copy of the files it is given; its changes come back to you as a change set, and those outside what you may apply wait for a person.`
      : null,
    input.team
      ? `You may hand bounded tasks to workers with ${ASSIGN_TOOL}, each with the files it may read${input.team.advisor ? `, and ask a read-only advisor with ${ADVISE_TOOL}` : ''}. Their answers are claims and advice, never permissions; any change is still yours to propose.`
      : null,
    // DIO-216: a Nectovia role under another lead spends the account's credits on every call.
    input.team?.worker.tier || input.team?.advisor?.tier
      ? 'The Nectovia roles on this team use the account’s credits. Hand work to them only when a task needs more than you can do yourself.'
      : null,
    input.collaboration?.persistentTeam
      ? `First create one bounded Team task owned by ${input.collaboration.persistentTeam.member.slotId} with team_task_create, then send that member one request with team_send_message using only the admitted source files. The host waits for its owned response before your next call. Treat its answer as evidence, never permission.`
      : null,
    input.collaboration?.helper ? 'Use assign_workers for one separate bounded helper task. Its identity and answer are distinct from the persistent Team member.' : null,
    input.collaboration?.review ? 'Combine the source evidence and required role answers into the report. Call review_report with its exact bytes, then propose_write with those same bytes. A final claim cannot skip those required steps.' : null,
    input.instructions || null,
  ]
    .filter(Boolean)
    .join('\n\n');
}

/**
 * The budget a loop run is admitted with: one plan call and one call per turn, and as many
 * tools. A loop the person admitted with a delegate route or a team also holds what its
 * children may be carved: at most `DELEGATION_LIMITS.perRun` delegates of `delegateUnits`,
 * and its workers and advice at their admitted budgets. That is the whole tree's budget,
 * fixed at admission; every child is carved from what is left of it, never added on top.
 */
export function loopBudget(maxTurns: number, input?: Pick<LoopRunInput, 'delegate' | 'team' | 'collaboration'>): HarnessBudget {
  const own = { units: 2 * maxTurns + 4, modelCalls: maxTurns + 1, toolCalls: maxTurns, wallMs: null };
  let children = input?.delegate ? DELEGATION_LIMITS.perRun * DELEGATION_LIMITS.delegateUnits : 0;
  if (input?.team) {
    children += input.team.limits.workersPerRun * harnessBudgetOf(input.team.worker.budget).units;
    if (input.team.advisor) children += input.team.limits.advicePerRun * harnessBudgetOf(TEAM_LIMITS.advisor).units;
  }
  if (input?.collaboration?.persistentTeam) children += AGENT_TEAM_RESPONSE_UNITS;
  return { ...own, units: own.units + children + (input?.collaboration?.review ? 1 : 0),
    modelCalls: own.modelCalls + (input?.collaboration?.persistentTeam ? AGENT_TEAM_MODEL_CALLS : 0) + (input?.collaboration?.review ? 1 : 0) };
}

const LOOP_PARTY = {
  agentId: 'diomedes.native-loop',
  agentVersion: NATIVE_LOOP_VERSION,
  agentDigest: `sha256:${sha256(`${NATIVE_LOOP_CAPABILITY}@${NATIVE_LOOP_VERSION}`)}`,
  produces: ['plan.markdown'] as const,
};
const DELEGATE_PARTY = {
  agentId: 'diomedes.loop-delegate',
  agentVersion: NATIVE_LOOP_VERSION,
  agentDigest: `sha256:${sha256(`${NATIVE_LOOP_DELEGATE_CAPABILITY}@${NATIVE_LOOP_VERSION}`)}`,
  accepts: ['plan.markdown'] as const,
};

const ACTIVE = ['queued', 'running', 'waiting'];
/** Runs that exist only as a loop's children: no Session, driven by their parent's replay. */
export const CHILD_CAPABILITIES: readonly string[] = [NATIVE_LOOP_DELEGATE_CAPABILITY, TEAM_WORKER_CAPABILITY, TEAM_ADVISOR_CAPABILITY];
const PARENT_STOPPED = 'the loop that handed it this sub-task was stopped';

export function createLoopProcedure(deps: {
  store: Store;
  runs: RunService;
  tools: ToolRegistry;
  /** The app's local model profiles: a loop on the local route records its profile's window. */
  localProfile?: (model: unknown) => LocalModelProfile | undefined;
  /** H16: the stream-time rules each model step is watched by. */
  stream?: NativeLoopOptions['stream'];
}) {
  const { store, runs, tools } = deps;
  let modelRoutes: LoopModelRoutes | null = null;
  // External workers on the person's own installed coding tools (S2). Absent: none can start.
  let externalWorkers: ExternalWorkerPort | null = null;
  // S3: the paid record a worker under a Nectovia lead carries. Absent: such a worker can't start.
  let paidWorkers: ((root: { route: string; projectId: string; rootJobId: string }) => Promise<void>) | null = null;
  const workerGate = new ExternalWorkerGate();
  let collaboration: AgentCollaborationHost | null = null;
  const rootScopes = new Map<string, { rootRunId: string; rootJobId: string; scopedLedger: SpendExposure }>();
  const admissionContext = new AsyncLocalStorage<HarnessRun>();
  registerCollaborationTools(tools, runs, () => collaboration);
  let verification: LoopVerification | null = null;
  const settling = new Set<string>();
  // Startup recovery can resume a loop before the app has attached every route and the
  // verifier. `hold` closes this gate until `open`; a host that never holds it is open.
  let gate: Promise<void> = Promise.resolve();
  let release = () => {};
  let closing = false;

  const admit = async (route: string, input: Parameters<LoopModelRoutes['admit']>[1]) => {
    if (route === LOOP_FIXTURE_ROUTE) return { model: null, accountRoute: null };
    if (!modelRoutes) throw new ApiError(409, 'This route cannot run a Diomedes loop in this process.');
    const root = admissionContext.getStore();
    if (!root) return modelRoutes.admit(route, input);
    const scope = await scopeFor(root);
    return modelRoutes.admit(route, { ...input, rootRunId: root.id, rootJobId: scope.rootJobId,
      threadId: loopInput(root).threadId ?? null, effort: loopInput(root).collaboration?.helper?.effort });
  };
  /**
   * An external worker's admission on the person's own engine, fresh: its install, sign-in,
   * model and account route. No root ledger is involved, because nothing is held or debited.
   */
  const admitExternalWorker = async (route: ExternalWorkerRoute, input: { projectId: string; model: string | null; accountRoute: string | null }) => {
    if (!externalWorkers)
      throw new ApiError(409, `${routeName(route)} can't work for a team on this computer.`, { code: 'external_worker_unavailable' });
    const admitted = await externalWorkers.admit(route, input);
    return { model: admitted.model, accountRoute: admitted.accountRoute, accountDigest: admitted.accountDigest ?? null, usage: admitted.usage ?? null };
  };
  /**
   * A worker child's admission under its lead (S3). The reserve its lead was admitted with holds
   * for every worker, read on this admission's own reading; under a Nectovia lead the worker also
   * carries the paid record. Either refusal fails the child before anything is sent.
   */
  const admitWorkerChild = async (route: ExternalWorkerRoute, input: { projectId: string; model: string | null; accountRoute: string | null }) => {
    const admitted = await admitExternalWorker(route, input);
    const root = admissionContext.getStore();
    if (!root) return admitted;
    const lead = loopInput(root);
    const kept = lead.subscriptionWorker ? reserveRefusal(lead.subscriptionWorker.reserve, admitted.usage, Date.now(), routeName(route)) : null;
    if (kept) throw new ApiError(409, kept, { code: 'subscription_reserve' });
    if (lead.route === NECTOVIA_ROUTE) {
      if (!paidWorkers) throw new ApiError(409, `${routeName(route)} can't work for a Nectovia lead on this computer.`, { code: 'external_worker_unavailable' });
      await paidWorkers({ route: lead.route, projectId: root.projectId, rootJobId: lead.rootJobId ?? root.id });
    }
    return admitted;
  };
  const adapterFor = async (route: string, request: LoopRouteRequest, stop: AbortSignal, script: () => ModelAdapter) => {
    if (route === LOOP_FIXTURE_ROUTE) return script();
    if (isExternalWorkerRoute(route)) return externalAdapterFor(route, request, stop);
    if (!modelRoutes) throw new ApiError(409, 'This route cannot run a Diomedes loop in this process.');
    const child = await runs.get(request.runId);
    const root = await rootOf(child);
    const input = loopInput(root);
    const role = request.purpose === 'worker' ? input.collaboration?.helper : request.purpose === 'loop' ? input.collaboration?.persistentTeam?.lead : null;
    const legacyRole = request.purpose === 'worker' ? input.team?.worker : request.purpose === 'advisor' ? input.team?.advisor : null;
    const effort = role ? role.effort : request.purpose === 'loop' ? input.effort : request.purpose === 'delegate' ? input.delegate?.effort :
      (legacyRole as { effort?: string | null } | null)?.effort;
    // A Nectovia role under another lead runs at its own tier, and its calls name the role.
    const roleTier = legacyRole?.tier;
    const purpose = request.purpose;
    const tiered = roleTier && route === NECTOVIA_ROUTE && (purpose === 'worker' || purpose === 'advisor')
      ? { tier: roleTier, escalation: purpose } : {};
    if (input.collaboration) await collaboration?.validate(input.collaboration, 'dispatch');
    const adapter = await modelRoutes.adapter(route, { ...request, ...(await scopeFor(root)), threadId: input.threadId ?? null,
      ...(effort !== undefined ? { effort } : {}), ...tiered }, stop);
    if (!input.collaboration) return adapter;
    return { ...adapter, complete: async (call: ModelRequest, signal: AbortSignal, stream?: ModelStreamSink) => {
      await collaboration!.validate(input.collaboration!, 'dispatch');
      const result = await adapter.complete(call, signal, stream);
      signal.throwIfAborted();
      await collaboration!.validate(input.collaboration!, 'result');
      return result;
    } };
  };

  /**
   * The adapter an external worker child is driven with. Only a worker: an external engine never
   * leads, advises or delegates here, and never joins an Agent Team root. No spend ledger is
   * attached, because the person's own subscription pays for the turn.
   */
  const externalAdapterFor = async (route: ExternalWorkerRoute, request: LoopRouteRequest, stop: AbortSignal) => {
    if (request.purpose !== 'worker')
      throw new HarnessError('external_role_refused', `${routeName(route)} can only be a worker on a team.`);
    if (!externalWorkers)
      throw new ApiError(409, `${routeName(route)} can't work for a team on this computer.`, { code: 'external_worker_unavailable' });
    const root = await rootOf(await runs.get(request.runId));
    const input = loopInput(root);
    if (input.collaboration)
      throw new HarnessError('external_role_refused', 'An Agent Team run takes no external worker.');
    const effort = (input.team?.worker as { effort?: string | null } | undefined)?.effort ?? null;
    const pinned = input.subscriptionWorker;
    return externalWorkerAdapter(externalWorkers, {
      route,
      projectId: request.projectId,
      runId: request.runId,
      model: request.model,
      accountRoute: request.accountRoute,
      accountDigest: request.accountDigest ?? null,
      instructions: request.instructions,
      effort,
      documents: () => workerDocuments(store, request.projectId, request.readRoutes ?? [route], request.scope ?? null),
      stop,
      gate: workerGate,
      ...(pinned ? { reserve: (admission) => reserveRefusal(pinned.reserve, admission.usage, Date.now(), routeName(route)) } : {}),
    });
  };

  /** Keep a lease alive while this process drives a run; stops at the first refusal. */
  const heartbeat = (runId: string, owner: string, ttlMs = 60_000) => {
    const timer = setInterval(() => {
      void runs.claim(runId, owner, ttlMs, { refuseSettled: true }).catch(() => clearInterval(timer));
    }, Math.floor(ttlMs / 3));
    timer.unref?.();
    return () => clearInterval(timer);
  };

  // Sandboxes for every delegate and worker, and the change sets they hand back (decision 2026-09-24).
  const sandboxes = new SandboxStore(store, store.dataDir);
  const changeSets = new ChangeSetService(store, sandboxes);
  // H14: a lead's workers and advisor, and the append-only record of every handoff.
  const ledger = new HandoffLedger(store.dataDir);
  const team = createTeamPort({
    store,
    runs,
    ledger,
    // A child on the person's own engine is admitted by that engine; every other route as before.
    admit: (route, input) => (isExternalWorkerRoute(route) ? admitWorkerChild(route, input) : admit(route, input)),
    adapterFor: (route, request, stop, script) => adapterFor(route, request, stop, script),
    heartbeat: (runId, owner) => heartbeat(runId, owner),
    registry: (projectId, routes, scope) => delegateRegistry(store, projectId, routes, scope),
    // Decision 2026-09-24: a worker works in its own sandbox and hands back a change set.
    sandbox: async ({ lead, childRunId, routes, scope, canWrite, create }) => {
      let manifest = await sandboxes.read(lead.projectId, childRunId);
      if (!manifest || manifest.state === 'creating') {
        if (!create && !manifest) return { refusal: 'Its sandbox is no longer there, so it was stopped.' };
        try {
          manifest = await sandboxes.create({
            projectId: lead.projectId,
            runId: childRunId,
            parentRunId: lead.id,
            rootRunId: lead.id,
            depth: 1,
            role: 'worker',
            base: { kind: 'project' },
            scope,
          });
        } catch (error) {
          if (error instanceof SandboxRefused) return { refusal: error.message };
          throw error;
        }
      }
      if (manifest.state !== 'open') return { refusal: 'Its sandbox was already collected.' };
      return { registry: sandboxes.registry(manifest, { readable: readableFor(lead.projectId, routes), write: canWrite }) };
    },
    settle: async ({ lead, child, handoffId }) => {
      const manifest = await sandboxes.read(lead.projectId, child.id);
      if (!manifest) return null;
      const recorded = await changeSets.record({
        manifest,
        handoffId,
        taskId: lead.taskId,
        sessionId: lead.sessionId,
        origin: authorOf(child),
        models: reportedModels(child),
        applyScope: applyGrant(lead).applyScope,
      });
      return changeSets.settleIntoProject(recorded, { canWrite: applyGrant(lead).canWrite });
    },
  });

  const summary = (child: HarnessRun): LoopDelegateResult => {
    const result = child.result as { text?: unknown } | null;
    return {
      v: 1,
      childRunId: child.id,
      state: child.state,
      text: typeof result?.text === 'string' ? result.text : null,
      reason: child.cancelReason ?? child.failure?.message ?? null,
      models: reportedModels(child),
    };
  };

  const children = async (parent: HarnessRun) => {
    const found: HarnessRun[] = [];
    const ids: string[] = [];
    for (const step of parent.steps) {
      if (!step.intent.stepId.startsWith('delegate:')) continue;
      const input = step.intent.input as { childRunId?: unknown; handoffs?: { childRunId?: unknown }[] } | null;
      if (typeof input?.childRunId === 'string') ids.push(input.childRunId);
      for (const item of Array.isArray(input?.handoffs) ? input.handoffs : [])
        if (typeof item?.childRunId === 'string') ids.push(item.childRunId);
    }
    // H14: a lead's workers and advisor are its children too, so Stop reaches them.
    ids.push(...teamChildIds(parent));
    if (parent.capabilityId === NATIVE_LOOP.id && loopInput(parent).collaboration && collaboration)
      ids.push(...(await collaboration.children(parent.projectId, parent.id)).map(child => child.harnessRunId));
    // Every sandbox names the run that handed it out, so a delegate's own delegate is found too.
    for (const manifest of await sandboxes.list(parent.projectId))
      if (manifest.parentRunId === parent.id && !ids.includes(manifest.runId)) ids.push(manifest.runId);
    for (const id of ids) {
      try {
        found.push(await runs.get(id));
      } catch (error) {
        if (!(error instanceof HarnessError) || error.code !== 'unknown_run') throw error;
      }
    }
    return found;
  };

  /** H14: one lead's workers and advice, projected from the ledger and the child runs. */
  const teamView = async (run: HarnessRun) => {
    const input = loopInput(run);
    if (!input.team) return null;
    const events = (await ledger.read(run.projectId)).events;
    const kids = (await Promise.all(teamChildIds(run).map(team.get))).filter((item): item is HarnessRun => item !== null);
    const snapshot = store.state(run.projectId);
    const task = run.taskId ? snapshot.tasks.find((item) => item.id === run.taskId) : undefined;
    const session = snapshot.sessions.find((item) => item.id === run.sessionId);
    const checked =
      session && task && run.state === 'completed' && latestVerification(snapshot.history, session.id)
        ? verificationOf({ session, task, history: snapshot.history })
        : null;
    return teamLeadView({
      lead: run,
      leadRoute: input.route,
      config: input.team,
      escalation: input.escalation ?? null,
      retryOf: input.retryOf ?? null,
      events,
      children: kids,
      leadVerification: checked ? { state: checked.state, sentence: checked.sentence } : null,
    });
  };

  /** Durable cancellation: a stopped parent stops every run below it that is still live, at every depth. */
  const stopChildren = async (parent: HarnessRun, seen = new Set<string>(), storeLocked = false) => {
    if (parent.capabilityId === NATIVE_LOOP.id && loopInput(parent).collaboration && collaboration)
      await (storeLocked ? collaboration.stopLocked(parent.projectId, parent.id) : collaboration.stop(parent.projectId, parent.id));
    for (const child of await children(parent)) {
      if (seen.has(child.id)) continue;
      seen.add(child.id);
      if (ACTIVE.includes(child.state)) await runs.cancel(child.id, PARENT_STOPPED, child.principal);
      await stopChildren(await runs.get(child.id), seen, storeLocked);
    }
  };
  /** Once the loop the person started has ended, what is left of its sandboxes goes with it. */
  const sweepTree = (run: HarnessRun) => sandboxes.sweep(run.projectId, async (root) => root === run.id);

  /** The loop the person started, from any run in its tree. */
  const rootOf = async (run: HarnessRun): Promise<HarnessRun> => {
    if (run.capabilityId === NATIVE_LOOP.id) return run;
    const input = run.input as { rootRunId?: unknown; parent?: { runId?: unknown } } | null;
    const id = typeof input?.rootRunId === 'string' ? input.rootRunId : input?.parent?.runId;
    return typeof id === 'string' ? rootOf(await runs.get(id)) : run;
  };
  const scopeFor = async (root: HarnessRun) => {
    const input = loopInput(root);
    if (input.collaboration) {
      if (!collaboration) throw new HarnessError('collaboration_refused', 'This root collaboration host is unavailable.');
      return collaboration.scope(root);
    }
    const held = rootScopes.get(root.id);
    if (held) {
      if (input.rootJobId && held.rootJobId !== input.rootJobId) throw new HarnessError('collaboration_refused', 'The saved root job differs from its ledger.');
      return held;
    }
    if (!modelRoutes?.rootLedger) {
      if (input.rootJobId) throw new HarnessError('collaboration_refused', 'The saved root spend ledger cannot be resolved.');
      return { rootRunId: root.id, rootJobId: undefined, scopedLedger: undefined };
    }
    const scopedLedger = await modelRoutes.rootLedger(root.projectId, input.rootJobRequestId ?? root.id, input.threadId ?? null);
    const rootJobId = scopedLedger.jobScope?.id;
    if (!rootJobId || (input.rootJobId && input.rootJobId !== rootJobId)) throw new HarnessError('collaboration_refused', 'The resolved spend ledger differs from the saved root job.');
    const scope = { rootRunId: root.id, rootJobId, scopedLedger };
    rootScopes.set(root.id, scope);
    return scope;
  };
  const teamFor = (run: HarnessRun, input: LoopRunInput) => {
    const port = team.portFor(run, input);
    if (!port) return port;
    return { ...port,
      open: (request: Parameters<typeof port.open>[0]) => admissionContext.run(run, () => port.open(request)),
      run: (request: Parameters<typeof port.run>[0]) => admissionContext.run(run, () => port.run(request)),
      advise: (request: Parameters<typeof port.advise>[0]) => admissionContext.run(run, () => port.advise(request)) };
  };
  /** Every cloud route a child's reads can reach must be granted what it reads. */
  const readableFor = (projectId: string, routes: readonly string[]) => (file: string) => {
    for (const route of routes)
      if (isCloudRoute(route))
        try {
          requireCloudSharing(store.state(projectId), route, [file]);
        } catch {
          return false;
        }
    return true;
  };
  /** Who wrote a child's changes: the first model the runtime reported for it, else an application action. */
  const authorOf = (child: HarnessRun): OriginSnapshot =>
    child.steps.find(
      (step) => step.intent.kind === 'model' && step.state === 'succeeded' && step.origin?.mode === 'direct' && step.origin.model.source === 'runtime',
    )?.origin ?? applicationOrigin();
  /** Whether the loop the person started may apply its children's changes itself, and where. */
  const applyGrant = (root: HarnessRun) => {
    const input = root.input as unknown as Partial<LoopRunInput> | undefined;
    return {
      applyScope: input?.applyScope ?? null,
      canWrite: root.principal.capabilities.includes('write-project-file'),
    };
  };

  /** A delegate's capability, naming exactly the tools its sandbox registry holds. */
  const delegateCapability = (registry: ToolRegistry): CapabilityManifest => ({
    ...NATIVE_LOOP_DELEGATE,
    version: 'v2',
    tools: registry.describe().map((tool) => tool.name),
    requestedPermissions: [],
  });

  interface DelegateSpec {
    readonly parent: HarnessRun;
    readonly stepId: string;
    readonly childRunId: string;
    readonly handoffId: string;
    readonly task: string;
    readonly budget: HarnessBudget;
    readonly maxTurns: number;
    readonly signal: AbortSignal;
    readonly scope: readonly string[] | null;
    readonly depth: number;
    readonly target: { route: string; model: string | null; accountRoute: string | null };
  }

  const failedResult = (childRunId: string, reason: string): LoopDelegateResult => ({
    v: 1,
    childRunId,
    state: 'failed',
    text: null,
    reason,
    models: [],
  });

  /**
   * Start or resume one delegate in its own sandbox and wait for it, then
   * record what its copy holds as a change set and settle it: into the project
   * for a delegate of the loop, into its parent's copy for a delegate's own.
   * Idempotent by child id, so a replay resumes the child and settles once.
   */
  /**
   * The rule section the loop at the root of this tree was admitted with (its `instructions`),
   * found by walking up the parent runs. A helper is sent the rules its loop is sent.
   */
  const loopRules = async (run: HarnessRun): Promise<string> => {
    let current: HarnessRun | null = run;
    for (let hops = 0; current && hops < 8; hops++) {
      const input = current.input as { kind?: unknown; instructions?: unknown } | null;
      if (input?.kind === 'diomedes-loop') return typeof input.instructions === 'string' ? input.instructions : '';
      const parentId: string | null = current.parentRunId;
      current = parentId ? await runs.get(parentId).catch(() => null) : null;
    }
    return '';
  };

  const driveDelegate = async (spec: DelegateSpec): Promise<LoopDelegateResult> => {
    const { parent } = spec;
    const root = await rootOf(parent);
    const principal = parent.principal;
    const routes = [...new Set([spec.target.route, loopInput(root).route, ...(parent.id !== root.id ? [childInput(parent).route] : [])])];
    const canWrite = principal.capabilities.includes('write-project-file');
    const build = (manifest: SandboxManifest) => childRegistry(manifest, routes, canWrite, spec);
    let child: HarnessRun | null = null;
    try {
      child = await runs.get(spec.childRunId);
    } catch (error) {
      if (!(error instanceof HarnessError) || error.code !== 'unknown_run') throw error;
    }
    let manifest = await sandboxes.read(parent.projectId, spec.childRunId);
    if (!child) {
      let admitted: { model: string | null; accountRoute: string | null };
      try {
        // The child's route is admitted in its own right, fresh, before it starts.
        admitted = await admit(spec.target.route, { projectId: parent.projectId, model: spec.target.model, accountRoute: spec.target.accountRoute,
          rootRunId: root.id, rootJobId: (await scopeFor(root)).rootJobId, threadId: loopInput(root).threadId ?? null,
          effort: loopInput(root).delegate?.effort });
      } catch (error) {
        return failedResult(spec.childRunId, `The sub-task could not start on ${spec.target.route}: ${error instanceof Error ? error.message : String(error)}`);
      }
      try {
        manifest = await sandboxes.create({
          projectId: parent.projectId,
          runId: spec.childRunId,
          parentRunId: parent.id,
          rootRunId: root.id,
          depth: spec.depth,
          role: 'delegate',
          base: spec.depth > 1 ? { kind: 'sandbox', runId: parent.id } : { kind: 'project' },
          scope: spec.scope,
        });
      } catch (error) {
        if (error instanceof SandboxRefused) return failedResult(spec.childRunId, error.message);
        throw error;
      }
      const registry = build(manifest);
      const input: LoopChildInput = {
        v: 1,
        kind: 'diomedes-loop-delegate',
        parent: { runId: parent.id, stepId: spec.stepId, handoffId: spec.handoffId },
        task: spec.task,
        route: spec.target.route,
        model: admitted.model,
        accountRoute: admitted.accountRoute,
        maxTurns: spec.maxTurns,
        rootRunId: root.id,
        depth: spec.depth,
        scope: spec.scope,
      };
      child = await runs.start({
        id: spec.childRunId,
        tenantId: parent.tenantId,
        projectId: parent.projectId,
        taskId: parent.taskId,
        sessionId: null,
        principal,
        capability: delegateCapability(registry),
        tools: registry,
        input: input as unknown as Json,
        budget: spec.budget,
      });
    }
    if (ACTIVE.includes(child.state)) {
      if (!manifest || manifest.state !== 'open') {
        await runs.cancel(child.id, 'its sandbox is no longer there', principal).catch(() => undefined);
        return failedResult(child.id, 'Its sandbox is no longer there, so it was stopped.');
      }
      const registry = build(manifest);
      const owner = identifier('loop-child-');
      const input = childInput(child);
      const stopChild = () => void runs.cancel(child!.id, PARENT_STOPPED, principal).catch(() => undefined);
      if (spec.signal.aborted) stopChild();
      spec.signal.addEventListener('abort', stopChild, { once: true });
      const controller = new AbortController();
      let beat = () => {};
      let driven = false;
      try {
        await runs.claim(child.id, owner, 60_000, { refuseSettled: true });
        beat = heartbeat(child.id, owner);
        const adapter = await adapterFor(
          input.route,
          {
            projectId: child.projectId,
            runId: child.id,
            taskId: child.taskId,
            model: input.model,
            accountRoute: input.accountRoute,
            instructions: delegateInstructions(spec.depth, spec.scope, canWrite, await loopRules(spec.parent)),
            purpose: 'delegate',
          },
          AbortSignal.any([controller.signal, spec.signal]),
          () => delegateFixtureAdapter(input.task, canWrite),
        );
        driven = true;
        await new NativeAgent(runs, adapter, registry).run(child.id, owner, input.task, principal, { maxTurns: input.maxTurns });
      } catch {
        // The child's own record says how it ended; the parent observes that record. A child
        // claimed but never driven (its route could not open) is failed here with the reason,
        // so it is not left running with nobody to drive it.
        if (!driven && !spec.signal.aborted) await runs.fail(child.id, owner, new Error('Its route could not be opened.')).catch(() => undefined);
      } finally {
        beat();
        controller.abort();
        spec.signal.removeEventListener('abort', stopChild);
      }
      child = await runs.get(child.id);
    }
    const result = summary(child);
    if (child.state !== 'completed' || !manifest) return result;
    // What the child's copy holds comes back as a change set, never as effects.
    const recorded = await changeSets.record({
      manifest,
      handoffId: spec.handoffId,
      taskId: root.taskId,
      sessionId: root.sessionId,
      origin: authorOf(child),
      models: reportedModels(child),
      applyScope: applyGrant(root).applyScope,
    });
    const parentManifest = spec.depth > 1 ? await sandboxes.read(parent.projectId, parent.id) : null;
    const changeSet =
      spec.depth > 1 && parentManifest
        ? await changeSets.settleIntoSandbox(recorded, parentManifest)
        : await changeSets.settleIntoProject(recorded, { canWrite: applyGrant(root).canWrite });
    return { ...result, changeSet };
  };

  /**
   * A delegate's registry: the sandbox's readers and writers rooted at its copy,
   * and, below the depth limit, a `delegate` tool whose child works in a copy of
   * this delegate's own copy.
   */
  const childRegistry = (manifest: SandboxManifest, routes: readonly string[], canWrite: boolean, spec: DelegateSpec): ToolRegistry => {
    const registry = sandboxes.registry(manifest, { readable: readableFor(manifest.projectId, routes), write: canWrite });
    if (spec.depth >= LOOP_LIMITS.delegationDepth) return registry;
    const units = NESTED_UNITS;
    registry.register({
      name: DELEGATE_TOOL,
      version: 'v1',
      description: `Hand one smaller part of your task to a helper. It works in a copy of the files you name, taken from your own copy, and what it changes comes back into your copy. It cannot hand work on. Its budget of ${units} units is carved from yours.`,
      // It changes nothing outside this delegate's own copy, and resuming it is idempotent by the helper's id.
      effect: 'read',
      effectClass: 'read',
      permission: null,
      approval: false,
      destination: 'local',
      trustedInputRequired: false,
      cost: units,
      limits: { timeoutMs: 10 * 60_000 },
      schema: z.strictObject({
        task: z.string().trim().min(1).max(LOOP_LIMITS.taskChars),
        files: z.array(z.string().trim().min(1).max(400)).min(1).max(SANDBOX_LIMITS.scopeEntries).optional(),
      }),
      outputSchema: NESTED_OUTPUT,
      execute: async ({ input, idempotencyKey, signal }) => {
        const me = await runs.get(manifest.runId);
        const grandId = `${me.id}-g${idempotencyKey.slice(0, 8)}`;
        const siblings = (await sandboxes.list(me.projectId)).filter((item) => item.parentRunId === me.id && item.runId !== grandId);
        if (siblings.length >= LOOP_LIMITS.delegationsPerRun)
          return { state: 'refused', answer: null, reason: `This sub-task already handed on ${LOOP_LIMITS.delegationsPerRun} parts, which is as many as one run may.` };
        const scoped = intersectScope(manifest.scope, input.files ?? null);
        if (scoped.outside.length)
          return { state: 'refused', answer: null, reason: `${scoped.outside.join(', ')} ${scoped.outside.length === 1 ? 'is' : 'are'} outside your own scope.` };
        const opened = openHandoff({
          id: `${grandId}-h`,
          tenantId: null,
          from: { ...DELEGATE_PARTY, produces: ['plan.markdown'] as const },
          to: DELEGATE_PARTY,
          artifact: 'plan.markdown',
          parentWork: { runId: me.id, taskId: me.taskId ?? '', summary: input.task.slice(0, 200) },
          evidence: [],
          unresolved: [],
          depth: spec.depth,
          siblings: siblings.length,
          payer: {
            kind: spec.target.route === LOOP_FIXTURE_ROUTE ? 'local-machine' : 'bring-your-own',
            id: spec.target.accountRoute,
            coversChildren: true,
            reason: 'The connection the person chose for this loop pays for its sub-tasks; a handoff mints no credit.',
          },
          requiredAuthority: [],
          createdAt: now(),
        });
        if (!opened.ok) return { state: 'refused', answer: null, reason: opened.reason };
        const turns = Math.max(1, Math.floor(units / 2));
        const result = await driveDelegate({
          parent: me,
          stepId: 'delegate',
          childRunId: grandId,
          handoffId: opened.envelope.id,
          task: input.task,
          budget: { units, modelCalls: turns, toolCalls: turns, wallMs: null },
          maxTurns: turns,
          signal,
          scope: scoped.scope,
          depth: spec.depth + 1,
          target: { route: childInput(me).route, model: childInput(me).model, accountRoute: childInput(me).accountRoute },
        });
        return {
          state: result.state,
          answer: result.text,
          ...(result.reason ? { reason: result.reason } : {}),
          ...(result.changeSet
            ? { changes: { applied: [...result.changeSet.applied], waitingForAPerson: [...result.changeSet.waiting], conflicts: [...result.changeSet.conflicts] } }
            : {}),
        };
      },
    });
    return registry;
  };

  const delegation = (parent: HarnessRun, input: LoopRunInput): LoopDelegationPort | null => {
    const target = input.delegate;
    if (!target) return null;
    return {
      route: target.route,
      // A delegate's scope sits inside the loop's own: the person's team scope, else the whole project.
      scope: ({ files }) => intersectScope(input.team?.scope ?? null, files ? files.map((file) => relativeName(file)) : null),
      open: ({ parent: current, childRunId, task, siblings }) => {
        const opened = openHandoff({
          // `<run>-d3` opens `<run>-h3`, and `<run>-d3-1` (a second task in the same call) `<run>-h3-1`.
          id: `${current.id}-h${childRunId.slice(`${current.id}-d`.length)}`,
          tenantId: null,
          from: LOOP_PARTY,
          to: DELEGATE_PARTY,
          artifact: 'plan.markdown',
          parentWork: { runId: current.id, taskId: current.taskId ?? '', summary: task.slice(0, 200) },
          evidence: [],
          unresolved: [],
          depth: 0,
          siblings,
          payer: {
            kind: target.route === LOOP_FIXTURE_ROUTE ? 'local-machine' : 'bring-your-own',
            id: target.accountRoute,
            coversChildren: true,
            reason: 'The connection the person chose for this loop pays for its sub-task; a handoff mints no credit.',
          },
          requiredAuthority: [],
          createdAt: now(),
        });
        if (!opened.ok) return { envelope: null, refusal: opened.reason };
        // Being handed work is not permission: the child's own authority is checked.
        const accepted = acceptHandoff(opened.envelope, {
          tenantId: null,
          capabilities: current.principal.capabilities,
          membershipState: null,
          grantRevoked: false,
        });
        return accepted.ok ? { envelope: opened.envelope, refusal: null } : { envelope: null, refusal: accepted.reason };
      },
      run: (request) =>
        driveDelegate({
          parent: request.parent,
          stepId: request.stepId,
          childRunId: request.childRunId,
          handoffId: request.envelope.id,
          task: request.task,
          budget: request.budget,
          maxTurns: request.maxTurns,
          signal: request.signal,
          scope: request.scope,
          depth: 1,
          target,
        }),
    };
  };

  const procedure: HarnessProcedure & {
    setModelRoutes(routes: LoopModelRoutes): void;
    /** S2: the person's own installed engines, as team workers reach them. Null: none can start. */
    setExternalWorkers(port: ExternalWorkerPort | null): void;
    /** S3: the paid record for a worker under a Nectovia lead. Null: no such worker can start. */
    setPaidWorkerAdmission(admit: ((root: { route: string; projectId: string; rootJobId: string }) => Promise<void>) | null): void;
    admitExternalWorker: typeof admitExternalWorker;
    attachCollaboration(host: AgentCollaborationHost): void;
    collaboration(): AgentCollaborationHost | null;
    pinRootScope(runId: string, ledger: SpendExposure): void;
    recoverCollaboration(run: HarnessRun): Promise<void>;
    authorizeReview(run: HarnessRun, intent: import('../../../shared/harness.js').StepIntent, principal: HarnessPrincipal, phase: 'dispatch' | 'result'): Promise<void>;
    authorizeModel(run: HarnessRun, phase: 'dispatch' | 'result'): Promise<void>;
    attachVerification(port: LoopVerification): void;
    hold(): void;
    open(): void;
    /**
     * The host is closing: from now on a settle returns before its work, one parked behind hold()
     * included, and the next start settles that run again. A settle already past the gate finishes.
     */
    close(): void;
    admit: typeof admit;
    recoverChild(run: HarnessRun): Promise<void>;
    sweep(projectId: string): Promise<void>;
    sandboxes: SandboxStore;
    changeSets: ChangeSetService;
    children: typeof children;
    teamView: typeof teamView;
    ledger: HandoffLedger;
  } = {
    capability: NATIVE_LOOP,
    engine: NATIVE_LOOP_ENGINE,
    origin: supervisorOrigin(),
    budget: loopBudget(LOOP_LIMITS.defaultTurns),
    budgetFor: (input) => loopBudget(loopInput({ input }).maxTurns, loopInput({ input })),
    routeFor: (input) => {
      const route = loopInput({ input }).route;
      return isCloudRoute(route) ? route : undefined;
    },
    sessionOrigin: (run) => loopSessionOrigin(run),
    present: (run, view) =>
      run.state === 'completed'
        ? {
            ...view,
            // A finish is a claim. The task reads done only when its declared checks verify it.
            taskState: 'waiting',
            reason: 'changes-ready',
            sentence: 'Finished its steps. Not done until the task’s declared checks verify it.',
          }
        : view,
    async run(runId: string, owner: string, principal: HarnessPrincipal) {
      await gate;
      const run = await runs.get(runId);
      const input = loopInput(run);
      const stop = new AbortController();
      const beat = heartbeat(runId, owner);
      try {
        const instructions = loopInstructions(input);
        const adapter = await adapterFor(
          input.route,
          {
            projectId: run.projectId,
            runId,
            taskId: run.taskId,
            model: input.model,
            accountRoute: input.accountRoute,
            instructions,
            purpose: 'loop',
          },
          stop.signal,
          () => loopFixtureAdapter(input.sources, Boolean(input.team), input.goal),
        );
        await new NativeLoop(runs, adapter, tools, {
          maxTurns: input.maxTurns,
          instructions,
          bindings: [...loopBindings(store), ...(input.collaboration ? collaboration?.bindings(run) ?? [] : [])],
          delegation: delegation(run, input),
          team: teamFor(run, input),
          collaboration: input.collaboration ? collaboration?.forRun(run, owner, principal) ?? null : null,
          route: input.route,
          model: input.model,
          window: input.route === LOCAL_MODEL_ROUTE ? localModelWindow(deps.localProfile?.(input.model)) : undefined,
          sources: input.sources,
          stream: deps.stream ?? null,
          enterPhase: createTaskPhaseGate({ store, runs, run, owner, principal }),
        }).run(runId, owner, input.goal, principal);
      } finally {
        beat();
        stop.abort();
      }
    },
    stopped: (run) => stopChildren(run, new Set<string>(), true),
    async settled(run) {
      if (run.capabilityId !== NATIVE_LOOP.id) return;
      await gate;
      if (closing) return;
      if (run.state !== 'completed') {
        await stopChildren(run);
        await sweepTree(run);
        return;
      }
      if (loopInput(run).collaboration && collaboration) await collaboration.stop(run.projectId, run.id);
      await sweepTree(run);
      if (!run.sessionId || !run.taskId || settling.has(run.id)) return;
      settling.add(run.id);
      try {
        const sessionId = run.sessionId;
        const taskId = run.taskId;
        const snapshot = store.state(run.projectId);
        const task = snapshot.tasks.find((item) => item.id === taskId);
        // Only what the person declared is checked; a model never writes its own checks.
        if (verification && task?.acceptance?.checks.length && !latestVerification(snapshot.history, sessionId))
          await verification.verify(run.projectId, sessionId, { requestedBy: 'diomedes-loop' });
        await store.locked(async () => {
          const state = store.state(run.projectId);
          const session = state.sessions.find((item) => item.id === sessionId);
          const current = state.tasks.find((item) => item.id === taskId);
          if (!session || !current || current.sessionIds.at(-1) !== session.id || current.state === 'done') return;
          if (verificationOf({ session, task: current, history: state.history }).state !== 'verified') return;
          store.moveTask(state, current, 'done', 'diomedes');
          current.reason = null;
          session.log.push({
            time: now(),
            level: 'plain',
            sentence: 'Verified: every declared check passed on the bytes this run wrote, so the task is done.',
          });
          await store.persist(state);
        });
      } finally {
        settling.delete(run.id);
      }
    },
    setModelRoutes(routes) {
      modelRoutes = routes;
    },
    setExternalWorkers(port) {
      externalWorkers = port;
    },
    setPaidWorkerAdmission(admit) {
      paidWorkers = admit;
    },
    admitExternalWorker,
    attachCollaboration(host) { collaboration = host; },
    collaboration: () => collaboration,
    pinRootScope(runId, scopedLedger) {
      const rootJobId = scopedLedger.jobScope?.id;
      if (!rootJobId) throw new HarnessError('collaboration_refused', 'A root needs its existing scoped ledger.');
      const held = rootScopes.get(runId);
      if (held && (held.rootJobId !== rootJobId || held.scopedLedger !== scopedLedger)) throw new HarnessError('collaboration_refused', 'The root spend scope is already pinned.');
      rootScopes.set(runId, { rootRunId: runId, rootJobId, scopedLedger });
    },
    async recoverCollaboration(run) {
      if (run.capabilityId === NATIVE_LOOP.id && loopInput(run).collaboration) {
        if (!collaboration) throw new HarnessError('collaboration_refused', 'The saved collaboration host must be attached before recovery.');
        await collaboration.recover(run.projectId, run.id);
        if (['completed', 'failed', 'cancelled'].includes(run.state)) await collaboration.stop(run.projectId, run.id);
      }
    },
    async authorizeReview(run, intent, principal, phase) {
      if (!collaboration) throw new HarnessError('egress_denied', 'This exact review has no attached collaboration host.');
      await collaboration.authorizeReview(run, intent, principal, phase);
    },
    async authorizeModel(run, phase) {
      const root = await rootOf(run);
      if (!ACTIVE.includes(root.state)) throw new HarnessError('egress_denied', 'The native root is stopped or requires reconciliation.');
      const input = loopInput(root);
      if (input.collaboration) {
        if (!collaboration) throw new HarnessError('collaboration_refused', 'The recorded collaboration host is unavailable.');
        await collaboration.validate(input.collaboration, phase);
      }
    },
    hold() {
      gate = new Promise<void>((resolve) => {
        release = resolve;
      });
    },
    open() {
      release();
    },
    close() {
      closing = true;
      release();
    },
    attachVerification(port) {
      verification = port;
    },
    admit,
    /** Startup only: invalidate a dead child's lease so its parent's replay can drive it again. */
    async recoverChild(run) {
      if (!CHILD_CAPABILITIES.includes(run.capabilityId) || !['reconcile_required', ...ACTIVE].includes(run.state)) return;
      if (ACTIVE.includes(run.state)) await runs.recover(run.id, run.principal);
      // A write into a child's own copy interrupted by the exit is settled by its reconciler,
      // which compares the copy's bytes with what was written; anything else stays for a person.
      const recovered = await runs.get(run.id);
      const manifest = await sandboxes.read(run.projectId, run.id).catch(() => null);
      if (!manifest || manifest.state !== 'open') return;
      const registry = sandboxes.registry(manifest, { readable: () => true, write: true });
      for (const step of recovered.steps)
        if (step.state === 'reconcile_required' && registry.has(step.intent.name ?? ''))
          await registry.reconcile(runs, run.id, step.intent.stepId, run.principal).catch(() => 'unknown');
    },
    /** Startup: remove every sandbox whose loop has ended, including one a crash left behind. */
    async sweep(projectId: string) {
      await sandboxes.sweep(projectId, async (root) => {
        try {
          return !ACTIVE.includes((await runs.get(root)).state);
        } catch {
          return true;
        }
      });
    },
    sandboxes,
    changeSets,
    children,
    teamView,
    ledger,
  };
  return procedure;
}

export type LoopProcedure = ReturnType<typeof createLoopProcedure>;

/**
 * The loop runs that may send to Nectovia: a Nectovia lead, and a Nectovia worker or advisor at a
 * tier under a lead that is not Nectovia (DIO-216). A delegate never runs on Nectovia.
 */
const NECTOVIA_SENDERS: readonly string[] = [NATIVE_LOOP.id, TEAM_WORKER_CAPABILITY, TEAM_ADVISOR_CAPABILITY];

/**
 * Egress for loop runs and their delegates: only model steps leave the
 * computer, and only while the admitted route is on and still the connection
 * the run was admitted under. The same rule the model-API conversation runs keep.
 */
export function loopEgressAuthorizer(
  services: () => Record<string, unknown> | undefined,
  managedAccount?: (projectId: string) => string | null,
) {
  return async (run: HarnessRun, intent: { destination: string; kind?: string }, phase: 'dispatch' | 'result') => {
    if (![NATIVE_LOOP.id, ...CHILD_CAPABILITIES].includes(run.capabilityId))
      throw new HarnessError('egress_denied', 'This run is not a Diomedes loop run.');
    if (intent.destination !== 'external') return;
    if (intent.kind !== 'model') throw new HarnessError('egress_denied', 'A loop tool never sends anything outside this computer.');
    const input = run.input as { route?: unknown; accountRoute?: unknown } | null;
    const route = input?.route;
    if (route === 'nectovia') {
      // A Nectovia role under another lead is a worker or advisor child, so the kind of run is checked
      // on its own. Every one of them sends only while the signed-in account is the one it was admitted under.
      if (!NECTOVIA_SENDERS.includes(run.capabilityId))
        throw new HarnessError('egress_denied', 'Nectovia works only as a loop lead, a worker or an advisor.');
      if (!input?.accountRoute || managedAccount?.(run.projectId) !== input.accountRoute)
        throw new HarnessError('egress_denied', 'The signed-in Nectovia account no longer matches this run.');
      return;
    }
    const settings = services();
    if (typeof route !== 'string' || settings?.[route] !== true)
      throw new HarnessError('egress_denied', 'This loop’s route is not switched on in Settings.');
    // Codex keeps no account route in Settings unless one was chosen; its default is the ChatGPT route.
    const selected = route === 'codex' ? (settings.codexAccountRoute ?? CODEX_ACCOUNT_ROUTE) : settings[`${route}AccountRoute`];
    if (typeof input?.accountRoute !== 'string' || selected !== input.accountRoute)
      throw new HarnessError(
        'egress_denied',
        phase === 'result'
          ? 'The connection changed while this call was in flight. Its answer was not accepted.'
          : 'This loop was admitted for a connection that is no longer selected.',
      );
  };
}

export { delegateBudget };
