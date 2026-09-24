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
import { NativeAgent, type ModelAdapter } from '../native-agent.js';
import { LOOP_INSTRUCTIONS, NativeLoop, delegateBudget, type LoopDelegationPort, type LoopToolBinding } from '../native-loop.js';
import { HarnessError, digest } from '../policy.js';
import { routeContractFor } from '../route-contract.js';
import type { RunService } from '../run-service.js';
import { ToolRegistry } from '../tools.js';

export const NATIVE_LOOP: CapabilityManifest = {
  id: NATIVE_LOOP_CAPABILITY,
  version: NATIVE_LOOP_VERSION,
  label: 'Diomedes work loop',
  description:
    'Plan, act through registered tools under Trust, observe, and finish with a claim the task’s declared checks decide.',
  tools: ['list_project_files', 'read_project_file', 'propose_write'],
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
async function readFor(store: Store, projectId: string, routes: string | readonly string[], input: string): Promise<Json> {
  let path: string;
  try {
    path = relativeName(input);
  } catch (error) {
    return { path: input, refused: error instanceof Error ? error.message : 'That is not a project path.' };
  }
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

async function listFor(store: Store, projectId: string, routes: string | readonly string[]): Promise<Json> {
  const names = (await store.listDocuments(projectId)).map((document) => document.path);
  const cloud = (typeof routes === 'string' ? [routes] : routes).find(isCloudRoute);
  const shared = cloud ? new Set(cloudSharing(store.state(projectId)).documents) : null;
  const files = names.filter((name) => !shared || shared.has(name));
  return {
    files: files.slice(0, LIST_MAX),
    ...(files.length > LIST_MAX ? { more: files.length - LIST_MAX } : {}),
    ...(shared ? { note: `Only files shared with ${cloud} are listed.` } : {}),
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
  tools.register({
    ...read,
    name: 'list_project_files',
    outputSchema: LIST_OUTPUT,
    description: 'List the project’s files.',
    schema: scope,
    execute: async (context) => {
      const run = await ownRun(context, context.input, 'list_project_files');
      return listFor(store, run.projectId, routeOf(run));
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
      return readFor(store, run.projectId, routeOf(run), context.input.path);
    },
  });
}

/** What the model supplies for each loop tool; the host binds the rest. */
export function loopBindings(store: Store): LoopToolBinding[] {
  return [
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
 * The delegate's own registry: the same readers, bound to the child's project, and to both the
 * child's route and the parent's, because the child's answer is sent on to the parent's route.
 */
function delegateRegistry(store: Store, projectId: string, route: readonly string[]): ToolRegistry {
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
    execute: () => listFor(store, projectId, route),
  });
  registry.register({
    ...read,
    name: 'read_project_file',
    outputSchema: READ_OUTPUT,
    description: 'Read one project file as text, by its path.',
    schema: z.strictObject({ path: z.string().trim().min(1).max(400) }),
    execute: ({ input }) => readFor(store, projectId, route, input.path),
  });
  return registry;
}

// --- the scripted route -----------------------------------------------------------------------

const toolOutputs = (request: ModelRequest) => request.messages.filter((message) => message.role === 'tool');
const text = (value: Json | undefined, key: string): string | null => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const found = (value as Record<string, Json>)[key];
  return typeof found === 'string' ? found : null;
};

/**
 * The loop's fixed local script, for the fixture route: plan, read the first
 * selected file, hand the second to a delegate when delegation is offered,
 * propose the report, then claim it is done. Not a model: every step it drives
 * is an application action, and no model is ever named for it.
 */
export function loopFixtureAdapter(sources: readonly string[]): ModelAdapter {
  const first = sources[0] ?? 'README.md';
  const second = sources[1] ?? first;
  return {
    id: LOOP_FIXTURE_ROUTE,
    version: 'loop-fixture-v1',
    contract: routeContractFor(LOOP_FIXTURE_ROUTE),
    capabilities: () => ADAPTER_CAPABILITIES['native-fixture'],
    async complete(request, signal): Promise<ModelResult> {
      signal.throwIfAborted();
      if (!request.tools.length)
        return {
          response: {
            type: 'final',
            text: `1. Read ${first}.\n2. ${second !== first ? `Ask a helper to check ${second}.` : 'Check what it says.'}\n3. Propose ${REPORT_PATH}.\n4. Summarise what was done.`,
          },
        };
      const offered = new Set(request.tools.map((tool) => tool.name));
      const outputs = toolOutputs(request);
      const plan: { name: string; input: Json }[] = [{ name: 'read_project_file', input: { path: first } }];
      if (offered.has('delegate') && second !== first)
        plan.push({ name: 'delegate', input: { task: `Read ${second} and say in one line what it lists.` } });
      if (outputs.length < plan.length) return { response: { type: 'tool', ...plan[outputs.length] } };
      if (outputs.length === plan.length) {
        const lines = [`# Loop report`, ''];
        const read = text(outputs[0].output, 'text');
        lines.push(`## ${first}`, '', read ?? 'Not read.', '');
        if (plan.length > 1) lines.push(`## ${second}`, '', text(outputs[1].output, 'answer') ?? 'No answer came back.', '');
        return { response: { type: 'tool', name: 'propose_write', input: { text: lines.join('\n') } } };
      }
      return {
        response: {
          type: 'final',
          text: `Proposed ${REPORT_PATH} from ${plan.length > 1 ? `${first} and a helper's reading of ${second}` : first}.`,
        },
      };
    },
  };
}

/** The delegate's fixed local script: read the file its task names, answer with its first line. */
export function delegateFixtureAdapter(task: string): ModelAdapter {
  const named = task.match(/[\w./-]+\.[A-Za-z0-9]{1,8}/)?.[0] ?? 'README.md';
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
  readonly purpose: 'loop' | 'delegate';
}

/**
 * The model-API routes, attached by the app from `EngineService`. `admit` is
 * the route's own admission, read fresh; `adapter` opens the credential inside
 * the call and binds the spend ledger. Neither ever falls back to another route.
 */
export interface LoopModelRoutes {
  admit(route: string, input: { projectId: string; model: string | null; accountRoute: string | null }): Promise<{ model: string; accountRoute: string }>;
  adapter(route: string, request: LoopRouteRequest, stop: AbortSignal): Promise<ModelAdapter>;
}

export interface LoopVerification {
  verify(projectId: string, sessionId: string, options: { requestedBy: 'diomedes-loop' }): Promise<unknown>;
}

/** The instructions a loop's adapter is built with: the loop's own, then H11's delivered section. */
export function loopInstructions(input: Pick<LoopRunInput, 'instructions' | 'delegate'>): string {
  return [
    LOOP_INSTRUCTIONS,
    input.delegate
      ? `You may hand one bounded, read-only sub-task at a time to a helper with the delegate tool, at most ${LOOP_LIMITS.delegationsPerRun} per run.`
      : null,
    input.instructions || null,
  ]
    .filter(Boolean)
    .join('\n\n');
}

/** The budget a loop run is admitted with: one plan call and one call per turn, and as many tools. */
export function loopBudget(maxTurns: number): HarnessBudget {
  return { units: 2 * maxTurns + 4, modelCalls: maxTurns + 1, toolCalls: maxTurns, wallMs: null };
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
const PARENT_STOPPED = 'the loop that handed it this sub-task was stopped';

export function createLoopProcedure(deps: { store: Store; runs: RunService; tools: ToolRegistry }) {
  const { store, runs, tools } = deps;
  let modelRoutes: LoopModelRoutes | null = null;
  let verification: LoopVerification | null = null;
  const settling = new Set<string>();
  // Startup recovery can resume a loop before the app has attached every route and the
  // verifier. `hold` closes this gate until `open`; a host that never holds it is open.
  let gate: Promise<void> = Promise.resolve();
  let release = () => {};

  const admit = async (route: string, input: { projectId: string; model: string | null; accountRoute: string | null }) => {
    if (route === LOOP_FIXTURE_ROUTE) return { model: null, accountRoute: null };
    if (!modelRoutes) throw new ApiError(409, 'This route cannot run a Diomedes loop in this process.');
    return modelRoutes.admit(route, input);
  };
  const adapterFor = async (route: string, request: LoopRouteRequest, stop: AbortSignal, script: () => ModelAdapter) => {
    if (route === LOOP_FIXTURE_ROUTE) return script();
    if (!modelRoutes) throw new ApiError(409, 'This route cannot run a Diomedes loop in this process.');
    return modelRoutes.adapter(route, request, stop);
  };

  /** Keep a lease alive while this process drives a run; stops at the first refusal. */
  const heartbeat = (runId: string, owner: string, ttlMs = 60_000) => {
    const timer = setInterval(() => {
      void runs.claim(runId, owner, ttlMs, { refuseSettled: true }).catch(() => clearInterval(timer));
    }, Math.floor(ttlMs / 3));
    timer.unref?.();
    return () => clearInterval(timer);
  };

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
    for (const step of parent.steps) {
      if (!step.intent.stepId.startsWith('delegate:')) continue;
      const id = (step.intent.input as { childRunId?: unknown } | null)?.childRunId;
      if (typeof id !== 'string') continue;
      try {
        found.push(await runs.get(id));
      } catch (error) {
        if (!(error instanceof HarnessError) || error.code !== 'unknown_run') throw error;
      }
    }
    return found;
  };

  /** Durable cancellation: a stopped parent stops every child that is still live. */
  const stopChildren = async (parent: HarnessRun) => {
    for (const child of await children(parent))
      if (ACTIVE.includes(child.state)) await runs.cancel(child.id, PARENT_STOPPED, child.principal);
  };

  const delegation = (parent: HarnessRun, input: LoopRunInput): LoopDelegationPort | null => {
    const target = input.delegate;
    if (!target) return null;
    return {
      route: target.route,
      open: ({ parent: current, turn, task, siblings }) => {
        const opened = openHandoff({
          id: `${current.id}-h${turn}`,
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
      run: async (request) => {
        const principal = request.parent.principal;
        let child: HarnessRun | null = null;
        try {
          child = await runs.get(request.childRunId);
        } catch (error) {
          if (!(error instanceof HarnessError) || error.code !== 'unknown_run') throw error;
        }
        const registry = delegateRegistry(store, request.parent.projectId, [target.route, loopInput(request.parent).route]);
        if (!child) {
          // The child's route is admitted in its own right, fresh, before it starts.
          let admitted: { model: string | null; accountRoute: string | null };
          try {
            admitted = await admit(target.route, {
              projectId: request.parent.projectId,
              model: target.model,
              accountRoute: target.accountRoute,
            });
          } catch (error) {
            return {
              v: 1,
              childRunId: request.childRunId,
              state: 'failed',
              text: null,
              reason: `The sub-task could not start on ${target.route}: ${error instanceof Error ? error.message : String(error)}`,
              models: [],
            };
          }
          const input: LoopChildInput = {
            v: 1,
            kind: 'diomedes-loop-delegate',
            parent: { runId: request.parent.id, stepId: request.stepId, handoffId: request.envelope.id },
            task: request.task,
            route: target.route,
            model: admitted.model,
            accountRoute: admitted.accountRoute,
            maxTurns: request.maxTurns,
          };
          child = await runs.start({
            id: request.childRunId,
            tenantId: request.parent.tenantId,
            projectId: request.parent.projectId,
            taskId: request.parent.taskId,
            sessionId: null,
            principal,
            capability: NATIVE_LOOP_DELEGATE,
            tools: registry,
            input: input as unknown as Json,
            budget: request.budget,
          });
        }
        if (!ACTIVE.includes(child.state)) return summary(child);
        const owner = identifier('loop-child-');
        const input = childInput(child);
        const stopChild = () => void runs.cancel(child!.id, PARENT_STOPPED, principal).catch(() => undefined);
        if (request.signal.aborted) stopChild();
        request.signal.addEventListener('abort', stopChild, { once: true });
        const controller = new AbortController();
        let beat = () => {};
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
              instructions: `${LOOP_INSTRUCTIONS}\n\nYou are a helper given one bounded sub-task. Answer it in a few lines.`,
              purpose: 'delegate',
            },
            AbortSignal.any([controller.signal, request.signal]),
            () => delegateFixtureAdapter(input.task),
          );
          await new NativeAgent(runs, adapter, registry).run(child.id, owner, input.task, principal, {
            maxTurns: input.maxTurns,
          });
        } catch {
          // The child's own record says how it ended; the parent observes that record.
        } finally {
          beat();
          controller.abort();
          request.signal.removeEventListener('abort', stopChild);
        }
        return summary(await runs.get(child.id));
      },
    };
  };

  const procedure: HarnessProcedure & {
    setModelRoutes(routes: LoopModelRoutes): void;
    attachVerification(port: LoopVerification): void;
    hold(): void;
    open(): void;
    admit: typeof admit;
    recoverChild(run: HarnessRun): Promise<void>;
    children: typeof children;
  } = {
    capability: NATIVE_LOOP,
    engine: NATIVE_LOOP_ENGINE,
    origin: supervisorOrigin(),
    budget: loopBudget(LOOP_LIMITS.defaultTurns),
    budgetFor: (input) => loopBudget(loopInput({ input }).maxTurns),
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
          () => loopFixtureAdapter(input.sources),
        );
        await new NativeLoop(runs, adapter, tools, {
          maxTurns: input.maxTurns,
          instructions,
          bindings: loopBindings(store),
          delegation: delegation(run, input),
          route: input.route,
          model: input.model,
          sources: input.sources,
        }).run(runId, owner, input.goal, principal);
      } finally {
        beat();
        stop.abort();
      }
    },
    stopped: (run) => stopChildren(run),
    async settled(run) {
      if (run.capabilityId !== NATIVE_LOOP.id) return;
      await gate;
      if (run.state !== 'completed') {
        await stopChildren(run);
        return;
      }
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
    hold() {
      gate = new Promise<void>((resolve) => {
        release = resolve;
      });
    },
    open() {
      release();
    },
    attachVerification(port) {
      verification = port;
    },
    admit,
    /** Startup only: invalidate a dead child's lease so its parent's replay can drive it again. */
    async recoverChild(run) {
      if (run.capabilityId !== NATIVE_LOOP_DELEGATE.id || !ACTIVE.includes(run.state)) return;
      await runs.recover(run.id, run.principal);
    },
    children,
  };
  return procedure;
}

export type LoopProcedure = ReturnType<typeof createLoopProcedure>;

/**
 * Egress for loop runs and their delegates: only model steps leave the
 * computer, and only while the admitted route is on and still the connection
 * the run was admitted under. The same rule the model-API conversation runs keep.
 */
export function loopEgressAuthorizer(services: () => Record<string, unknown> | undefined) {
  return async (run: HarnessRun, intent: { destination: string; kind?: string }, phase: 'dispatch' | 'result') => {
    if (![NATIVE_LOOP.id, NATIVE_LOOP_DELEGATE.id].includes(run.capabilityId))
      throw new HarnessError('egress_denied', 'This run is not a Diomedes loop run.');
    if (intent.destination !== 'external') return;
    if (intent.kind !== 'model') throw new HarnessError('egress_denied', 'A loop tool never sends anything outside this computer.');
    const input = run.input as { route?: unknown; accountRoute?: unknown } | null;
    const route = input?.route;
    const settings = services();
    if (typeof route !== 'string' || settings?.[route] !== true)
      throw new HarnessError('egress_denied', 'This loop’s route is not switched on in Settings.');
    if (typeof input?.accountRoute !== 'string' || settings[`${route}AccountRoute`] !== input.accountRoute)
      throw new HarnessError(
        'egress_denied',
        phase === 'result'
          ? 'The connection changed while this call was in flight. Its answer was not accepted.'
          : 'This loop was admitted for a connection that is no longer selected.',
      );
  };
}

export { delegateBudget };
