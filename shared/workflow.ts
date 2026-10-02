/**
 * WF: a workflow graph as data, and the checks a graph must pass before a
 * driver may walk it.
 *
 * A workflow keeps no lifecycle of its own. A driver (`server/harness/workflow.ts`)
 * turns each node into ordinary steps of one run, with ids derived from the
 * graph, so a restart re-drives the graph and every finished node, branch
 * choice and join comes back from the run's durable record:
 *
 * | Step id                   | Kind      | What it records                             |
 * |---------------------------|-----------|---------------------------------------------|
 * | `wf:<node>`               | tool/model/approval | the node's own step               |
 * | `wf:<node>:i<n>`          | tool/model | one iteration of a loop's body             |
 * | `wf:<node>:decide`        | transform | the case a branch chose, once              |
 * | `wf:<loop>:i<n>:until`    | transform | whether a loop stops after iteration n     |
 * | `wf:<node>:join`          | transform | the child steps a join consumed, once      |
 *
 * A graph is checked twice: when it is registered and again when a run starts.
 * The checks refuse duplicate ids, unknown or missing dependencies, cycles, a
 * reference to a value that may not exist yet, a tool the run's capability
 * does not offer, a `wait` node (no inbox exists yet), and a worst case that
 * could pass the budget the run is started with. Bindings are data: a literal,
 * or a JSON pointer into an earlier node's output. Nothing here evaluates code.
 *
 * Pure: no clock, no disk, no request. Client and server share it.
 */
import { z } from 'zod';
import type { HarnessBudget, Json, StepRecord } from './harness.js';

export const WORKFLOW_CONTRACT_VERSION = 1 as const;

export const WORKFLOW_LIMITS = {
  nodes: 48,
  /** Node runs across every loop iteration; bounds the run file. */
  maxNodeRuns: 64,
  maxIterations: 16,
  bindingDepth: 8,
  whatChars: 400,
} as const;

/** Lower case, so every derived step id fits the run service's step id pattern. */
export const WORKFLOW_NODE_ID = /^[a-z][a-z0-9_-]{0,47}$/;
const WORKFLOW_ID = /^[a-z][a-z0-9-]{0,63}$/;
/** The registry's own tool name pattern (`server/harness/tools.ts`). */
const TOOL_NAME = /^[a-z][a-z0-9_-]{0,63}$/;
/** RFC 6901, kept to plain segments. */
const POINTER = /^(\/([^~/]|~[01])*)*$/;

export type WorkflowBinding =
  | { value: Json }
  | { from: string; pointer?: string }
  | { object: { [key: string]: WorkflowBinding } };

interface NodeBase {
  id: string;
  /** Nodes that must finish first. A node with none is a root. */
  after: string[];
  /** `continue` hands a join a failure entry instead of failing the run. */
  onFailure?: 'fail-run' | 'continue';
}
export type WorkflowNode =
  | (NodeBase & { kind: 'tool'; tool: string; input: WorkflowBinding })
  | (NodeBase & { kind: 'model'; prompt: WorkflowBinding })
  | (NodeBase & { kind: 'approval'; what: string })
  | (NodeBase & { kind: 'branch'; on: WorkflowBinding; cases: { [value: string]: string }; otherwise: string })
  | (NodeBase & { kind: 'join'; from: string[]; reducer: 'collect' | 'merge-objects' | 'first-success' })
  | (NodeBase & { kind: 'loop'; body: string; until: WorkflowBinding; maxIterations: number })
  | (NodeBase & { kind: 'wait'; event: string });

export interface WorkflowDefinition {
  id: string;
  version: string;
  /** The capability a run of this graph starts under. Every tool node must be among its tools. */
  capabilityId: string;
  nodes: WorkflowNode[];
  limits: { maxNodeRuns: number };
}

const nodeId = z.string().regex(WORKFLOW_NODE_ID);
const json: z.ZodType<Json> = z.json() as z.ZodType<Json>;
const binding: z.ZodType<WorkflowBinding> = z.lazy(() =>
  z.union([
    z.strictObject({ value: json }),
    z.strictObject({ from: nodeId, pointer: z.string().regex(POINTER).max(400).optional() }),
    z.strictObject({ object: z.record(z.string().min(1).max(128), binding) }),
  ]),
);
const base = {
  id: nodeId,
  after: z.array(nodeId).max(WORKFLOW_LIMITS.nodes),
  onFailure: z.enum(['fail-run', 'continue']).optional(),
};
const nodeSchema = z.discriminatedUnion('kind', [
  z.strictObject({ ...base, kind: z.literal('tool'), tool: z.string().regex(TOOL_NAME), input: binding }),
  z.strictObject({ ...base, kind: z.literal('model'), prompt: binding }),
  z.strictObject({ ...base, kind: z.literal('approval'), what: z.string().trim().min(1).max(WORKFLOW_LIMITS.whatChars) }),
  z.strictObject({
    ...base,
    kind: z.literal('branch'),
    on: binding,
    cases: z.record(z.string().min(1).max(128), nodeId),
    otherwise: nodeId,
  }),
  z.strictObject({
    ...base,
    kind: z.literal('join'),
    from: z.array(nodeId).min(1).max(WORKFLOW_LIMITS.nodes),
    reducer: z.enum(['collect', 'merge-objects', 'first-success']),
  }),
  z.strictObject({
    ...base,
    kind: z.literal('loop'),
    body: nodeId,
    until: binding,
    maxIterations: z.number().int().min(1).max(WORKFLOW_LIMITS.maxIterations),
  }),
  z.strictObject({ ...base, kind: z.literal('wait'), event: z.string().min(1).max(128) }),
]);
export const workflowDefinitionSchema = z.strictObject({
  id: z.string().regex(WORKFLOW_ID),
  version: z.string().min(1).max(32),
  capabilityId: z.string().min(1).max(128),
  nodes: z.array(nodeSchema).min(1).max(WORKFLOW_LIMITS.nodes),
  limits: z.strictObject({ maxNodeRuns: z.number().int().min(1).max(WORKFLOW_LIMITS.maxNodeRuns) }),
}) satisfies z.ZodType<WorkflowDefinition>;

// --- step ids --------------------------------------------------------------------

export const nodeStepId = (node: string, iteration?: number) =>
  iteration === undefined ? `wf:${node}` : `wf:${node}:i${iteration}`;
export const decideStepId = (branch: string) => `wf:${branch}:decide`;
export const untilStepId = (loop: string, iteration: number) => `wf:${loop}:i${iteration}:until`;
export const joinStepId = (join: string) => `wf:${join}:join`;

// --- validation ------------------------------------------------------------------

export type WorkflowProblemCode =
  | 'invalid_shape'
  | 'duplicate_node'
  | 'unknown_dependency'
  | 'self_dependency'
  | 'cycle'
  | 'no_root'
  | 'unknown_reference'
  | 'reference_not_upstream'
  | 'branch_target'
  | 'join_source'
  | 'loop_body'
  | 'unknown_tool'
  | 'wait_unsupported'
  | 'node_runs'
  | 'budget';

export interface WorkflowProblem {
  code: WorkflowProblemCode;
  node: string | null;
  message: string;
}

/** What the run's capability and host offer, for the checks that need them. */
export interface WorkflowContext {
  /** The capability's tool names, with each tool's declared cost per call. */
  tools: ReadonlyMap<string, { cost: number }>;
  /** Attempts the driver allows each step; the run service default is 3. */
  maxAttempts: number;
  /** The budget the run will start with. Omitted at registration, given at start. */
  budget?: HarnessBudget;
}

/** The most one run of the graph could spend, every attempt failing but the last. */
export interface WorkflowWorstCase {
  nodeRuns: number;
  units: number;
  modelCalls: number;
  toolCalls: number;
}

export type WorkflowCheck =
  | { ok: true; definition: WorkflowDefinition; order: string[]; worstCase: WorkflowWorstCase }
  | { ok: false; problems: WorkflowProblem[] };

function referencesOf(value: WorkflowBinding, out: string[] = [], depth = 0): string[] {
  if (depth > WORKFLOW_LIMITS.bindingDepth) return out;
  if ('from' in value) out.push(value.from);
  else if ('object' in value) for (const child of Object.values(value.object)) referencesOf(child, out, depth + 1);
  return out;
}

function bindingDepth(value: WorkflowBinding): number {
  return 'object' in value ? 1 + Math.max(0, ...Object.values(value.object).map(bindingDepth)) : 0;
}

/** The bindings a node reads, with the place each sits for messages. */
function bindingsOf(node: WorkflowNode): WorkflowBinding[] {
  switch (node.kind) {
    case 'tool': return [node.input];
    case 'model': return [node.prompt];
    case 'branch': return [node.on];
    case 'loop': return [node.until];
    default: return [];
  }
}

/** A cost model per node kind. Model calls cost one unit, as the loop's model steps do. */
const MODEL_STEP_COST = 1;

/**
 * Check a graph. Every problem is reported, not only the first, so an author
 * fixes them in one pass. A graph that passes comes back with a deterministic
 * order (dependencies first, then by node id) and its worst case.
 */
export function checkWorkflow(input: unknown, context: WorkflowContext): WorkflowCheck {
  const parsed = workflowDefinitionSchema.safeParse(input);
  if (!parsed.success)
    return {
      ok: false,
      problems: parsed.error.issues.slice(0, 20).map((issue) => ({
        code: 'invalid_shape' as const,
        node: null,
        message: `${issue.path.join('.') || 'definition'}: ${issue.message}`,
      })),
    };
  const definition = parsed.data as WorkflowDefinition;
  const problems: WorkflowProblem[] = [];
  const problem = (code: WorkflowProblemCode, node: string | null, message: string) =>
    problems.push({ code, node, message });

  const byId = new Map<string, WorkflowNode>();
  for (const node of definition.nodes) {
    if (byId.has(node.id)) problem('duplicate_node', node.id, `Node ${node.id} is defined twice.`);
    else byId.set(node.id, node);
  }
  for (const node of byId.values())
    for (const dep of node.after) {
      if (dep === node.id) problem('self_dependency', node.id, `Node ${node.id} waits for itself.`);
      else if (!byId.has(dep)) problem('unknown_dependency', node.id, `Node ${node.id} waits for ${dep}, which is not in the graph.`);
    }
  if (problems.length) return { ok: false, problems };

  // Kahn's algorithm with a sorted ready set: the order is the same on every host.
  const remaining = new Map([...byId.values()].map((node) => [node.id, new Set(node.after)]));
  const order: string[] = [];
  let ready = [...remaining].filter(([, deps]) => deps.size === 0).map(([id]) => id).sort();
  if (!ready.length) problem('no_root', null, 'Every node waits for another, so nothing can start.');
  while (ready.length) {
    const id = ready.shift()!;
    order.push(id);
    remaining.delete(id);
    for (const [other, deps] of remaining) if (deps.delete(id) && deps.size === 0) ready.push(other);
    ready = [...new Set(ready)].sort();
  }
  if (remaining.size) {
    problem('cycle', null, `These nodes wait for each other in a cycle: ${[...remaining.keys()].sort().join(', ')}.`);
    return { ok: false, problems };
  }

  // Everything each node is guaranteed to follow.
  const upstream = new Map<string, Set<string>>();
  for (const id of order) {
    const set = new Set<string>();
    for (const dep of byId.get(id)!.after) {
      set.add(dep);
      for (const above of upstream.get(dep)!) set.add(above);
    }
    upstream.set(id, set);
  }

  const bodies = new Map<string, string>();
  for (const node of byId.values())
    if (node.kind === 'loop') {
      const body = byId.get(node.body);
      if (!body) problem('loop_body', node.id, `Loop ${node.id} repeats ${node.body}, which is not in the graph.`);
      else if (body.kind !== 'tool' && body.kind !== 'model')
        problem('loop_body', node.id, `Loop ${node.id} can repeat only a tool or model node, not a ${body.kind} node.`);
      else if (body.after.length !== 1 || body.after[0] !== node.id)
        problem('loop_body', node.id, `${node.body} must wait for loop ${node.id} and nothing else.`);
      else if (bodies.has(node.body))
        problem('loop_body', node.id, `${node.body} is already the body of loop ${bodies.get(node.body)}.`);
      else bodies.set(node.body, node.id);
    }
  for (const node of byId.values())
    for (const dep of node.after)
      if (bodies.has(dep) && !(node.kind === 'loop' && node.body === dep))
        problem('loop_body', node.id, `${node.id} waits for loop body ${dep}; wait for loop ${bodies.get(dep)} instead.`);

  const targeted = new Map<string, string>();
  for (const node of byId.values()) {
    if (node.kind === 'branch')
      for (const target of new Set([...Object.values(node.cases), node.otherwise])) {
        if (!byId.has(target)) problem('branch_target', node.id, `Branch ${node.id} can choose ${target}, which is not in the graph.`);
        else if (!byId.get(target)!.after.includes(node.id))
          problem('branch_target', node.id, `${target} must wait for branch ${node.id}, which chooses it.`);
        else if (targeted.has(target) && targeted.get(target) !== node.id)
          problem('branch_target', node.id, `${target} is already chosen by branch ${targeted.get(target)}.`);
        else targeted.set(target, node.id);
      }
    if (node.kind === 'join')
      for (const source of node.from)
        if (!node.after.includes(source))
          problem('join_source', node.id, `Join ${node.id} reads ${source}, so it must wait for it.`);
    if (node.kind === 'tool' && !context.tools.has(node.tool))
      problem('unknown_tool', node.id, `Tool ${node.tool} is not offered by capability ${definition.capabilityId}.`);
    if (node.kind === 'wait')
      problem('wait_unsupported', node.id, 'A wait node needs the event inbox, which does not exist yet.');
    for (const value of bindingsOf(node)) {
      if (bindingDepth(value) > WORKFLOW_LIMITS.bindingDepth)
        problem('invalid_shape', node.id, `A binding of ${node.id} nests deeper than ${WORKFLOW_LIMITS.bindingDepth}.`);
      for (const ref of referencesOf(value)) {
        // A loop's stop condition reads its own body's latest output; nothing else may.
        const ownBody = node.kind === 'loop' && ref === node.body;
        if (!byId.has(ref)) problem('unknown_reference', node.id, `${node.id} reads ${ref}, which is not in the graph.`);
        else if (!ownBody && bodies.has(ref))
          problem('reference_not_upstream', node.id, `${node.id} reads loop body ${ref}; read loop ${bodies.get(ref)} instead.`);
        else if (!ownBody && !upstream.get(node.id)!.has(ref))
          problem('reference_not_upstream', node.id, `${node.id} reads ${ref} without waiting for it.`);
      }
    }
  }

  const runsOf = (node: WorkflowNode) => {
    const loop = bodies.get(node.id);
    return loop ? (byId.get(loop) as Extract<WorkflowNode, { kind: 'loop' }>).maxIterations : 1;
  };
  const worstCase: WorkflowWorstCase = { nodeRuns: 0, units: 0, modelCalls: 0, toolCalls: 0 };
  for (const node of byId.values()) {
    const runs = runsOf(node);
    worstCase.nodeRuns += runs;
    const attempts = runs * context.maxAttempts;
    if (node.kind === 'tool') {
      worstCase.toolCalls += attempts;
      worstCase.units += attempts * (context.tools.get(node.tool)?.cost ?? 0);
    } else if (node.kind === 'model') {
      worstCase.modelCalls += attempts;
      worstCase.units += attempts * MODEL_STEP_COST;
    }
  }
  if (worstCase.nodeRuns > definition.limits.maxNodeRuns)
    problem('node_runs', null, `The graph can run ${worstCase.nodeRuns} nodes, above its limit of ${definition.limits.maxNodeRuns}.`);
  const budget = context.budget;
  if (budget)
    for (const key of ['units', 'modelCalls', 'toolCalls'] as const)
      if (worstCase[key] > budget[key])
        problem('budget', null, `At worst the graph needs ${worstCase[key]} ${key}, above the run's budget of ${budget[key]}.`);

  return problems.length ? { ok: false, problems } : { ok: true, definition, order, worstCase };
}

// --- progress ----------------------------------------------------------------------

/** What `wf:<branch>:decide` records. */
export interface WorkflowDecision {
  v: 1;
  /** The case value matched, or null when `otherwise` was taken. */
  matched: string | null;
  next: string;
}

export type WorkflowNodeStatus = 'not-started' | 'running' | 'waiting' | 'done' | 'failed' | 'skipped';

/**
 * Each node's status, read from the run's steps on every call. A node is
 * skipped when a branch it waits for chose another target, or when anything
 * it waits for was skipped. Nothing here is stored.
 */
export function workflowProgress(
  definition: WorkflowDefinition,
  steps: readonly Pick<StepRecord, 'intent' | 'state' | 'output'>[],
): Record<string, WorkflowNodeStatus> {
  const byStep = new Map(steps.map((step) => [step.intent.stepId, step]));
  const statusOfStep = (id: string): WorkflowNodeStatus | null => {
    const step = byStep.get(id);
    if (!step) return null;
    switch (step.state) {
      case 'succeeded': return 'done';
      case 'running':
      case 'retry_wait':
      case 'pending': return 'running';
      case 'waiting_approval':
      case 'waiting_event':
      case 'reconcile_required': return 'waiting';
      default: return 'failed';
    }
  };
  const byId = new Map(definition.nodes.map((node) => [node.id, node]));
  const chosen = new Map<string, string | null>();
  for (const node of definition.nodes)
    if (node.kind === 'branch') {
      const step = byStep.get(decideStepId(node.id));
      const decision = step?.state === 'succeeded' ? (step.output as unknown as WorkflowDecision | null) : null;
      chosen.set(node.id, decision?.next ?? null);
    }
  const result: Record<string, WorkflowNodeStatus> = {};
  const visit = (id: string): WorkflowNodeStatus => {
    if (result[id]) return result[id];
    const node = byId.get(id)!;
    for (const dep of node.after) {
      const above = byId.get(dep)!;
      if (visit(dep) === 'skipped') return (result[id] = 'skipped');
      if (above.kind === 'branch') {
        const next = chosen.get(dep);
        const targets = new Set([...Object.values(above.cases), above.otherwise]);
        if (next && targets.has(id) && next !== id) return (result[id] = 'skipped');
      }
    }
    const own =
      node.kind === 'branch'
        ? statusOfStep(decideStepId(id))
        : node.kind === 'join'
          ? statusOfStep(joinStepId(id))
          : node.kind === 'loop'
            ? loopStatus(node)
            : statusOfStep(nodeStepId(id));
    return (result[id] = own ?? 'not-started');
  };
  const loopStatus = (node: Extract<WorkflowNode, { kind: 'loop' }>): WorkflowNodeStatus | null => {
    let last: WorkflowNodeStatus | null = null;
    for (let i = 0; i < node.maxIterations; i++) {
      const body = statusOfStep(nodeStepId(node.body, i));
      if (!body) break;
      if (body !== 'done') return body;
      const until = statusOfStep(untilStepId(node.id, i));
      if (until !== 'done') return until ?? 'running';
      const stop = (byStep.get(untilStepId(node.id, i))!.output as { stop?: unknown } | null)?.stop === true;
      last = stop || i + 1 === node.maxIterations ? 'done' : 'running';
      if (last === 'done') break;
    }
    return last;
  };
  for (const node of definition.nodes) visit(node.id);
  // A loop's body is reported with its loop.
  for (const node of definition.nodes) if (node.kind === 'loop') result[node.body] = result[node.id];
  return result;
}
