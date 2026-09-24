/**
 * The host-owned tool registry. A tool's effect class, permission, approval
 * need, destination and cost are declared here by trusted host code and taken
 * from here at dispatch. The model only ever sees a `ToolDescriptor`: the name,
 * a sentence and the input schema. Nothing a model returns can change what a
 * tool is allowed to do.
 *
 * H12: a tool is a typed contract. It declares an input and an output schema,
 * its effect class, the permission it needs (or an explicit null) and its
 * approval policy; a tool missing any of them is refused at registration. A
 * tool with an effect on the world also declares the targets it may change,
 * which are recorded in its effect intent before it runs. Every handler runs
 * under a timeout and bounded input and output sizes, and its output is checked
 * against the declared schema before anything records or returns it.
 */
import { z } from 'zod';
import type {
  Destination,
  Effect,
  EffectRecord,
  HarnessLabel,
  HarnessPrincipal,
  Json,
  ToolDescriptor,
  ToolEffectClass,
} from '../../shared/harness.js';
import type { OriginSnapshot } from '../../shared/attribution.js';
import { canonical, HarnessError, units } from './policy.js';
import type { RunService, StepContext } from './run-service.js';

export interface ToolLimits {
  /** Wall-clock limit for one call; the handler's signal aborts when it passes. */
  timeoutMs: number;
  /** Bytes of canonical JSON input one call may carry. */
  maxInputBytes: number;
  /** Bytes of canonical JSON output one call may return. */
  maxOutputBytes: number;
}
export const DEFAULT_TOOL_LIMITS: ToolLimits = {
  timeoutMs: 60_000,
  maxInputBytes: 64 * 1024,
  maxOutputBytes: 512 * 1024,
};

/**
 * What a tool's own reconciler may answer about an uncertain effect.
 * `{ applied: output }` also hands back the outcome the sink recorded, which
 * becomes the step's output as if the attempt had reported it.
 */
export type ReconcileAnswer = 'applied' | 'not-applied' | 'unknown' | { applied: Json };

export interface ToolDefinition<I = unknown, O = Json> {
  name: string;
  version: string;
  description: string;
  effect: Effect;
  /** H12 effect class. Must agree with `effect` and `destination`; see `EFFECT_CLASSES`. */
  effectClass: ToolEffectClass;
  /** The capability a principal must hold, or an explicit null when none is needed. */
  permission: string | null;
  /** The approval policy: true waits for an exact approval of this intent. */
  approval: boolean;
  destination: Destination;
  trustedInputRequired: boolean;
  cost: number;
  /** Strict input schema. Unknown keys are rejected when the schema is strict. */
  schema: z.ZodType<I>;
  /** Output schema. An output that does not match is refused, never recorded. */
  outputSchema: z.ZodType<O>;
  /**
   * The project-relative paths or named destinations one call may change,
   * derived from its validated input by trusted host code and recorded in the
   * effect intent before the handler runs. Required for every class with an
   * effect on the world; may throw a containment refusal.
   */
  targets?: (input: I) => string[] | Promise<string[]>;
  /** Tighter limits for this tool. Never looser than the defaults' hard caps. */
  limits?: Partial<ToolLimits>;
  /**
   * Establishes whether an uncertain effect happened, from the sink's own
   * record (for instance a write receipt under the idempotency key). Anything
   * but a definite answer leaves the effect uncertain for a person.
   */
  reconcile?: (context: { input: I; record: EffectRecord }) => Promise<ReconcileAnswer>;
  label?: HarnessLabel | null;
  execute: (context: StepContext & { input: I; targets?: readonly string[] }) => Promise<O> | O;
}

const NAME = /^[a-z][a-z0-9_-]{0,63}$/;
const EFFECTS: Effect[] = ['pure', 'read', 'idempotent', 'non-idempotent'];
const HARD_CAPS: ToolLimits = {
  timeoutMs: 10 * 60_000,
  maxInputBytes: 4 * 1024 * 1024,
  maxOutputBytes: 8 * 1024 * 1024,
};

/** Which effects and destinations each class may declare. */
export const EFFECT_CLASSES: Record<ToolEffectClass, { effect: Effect; destinations: Destination[] }> = {
  pure: { effect: 'pure', destinations: ['local', 'external'] },
  read: { effect: 'read', destinations: ['local', 'external'] },
  'idempotent-write': { effect: 'idempotent', destinations: ['local'] },
  'non-idempotent-effect': { effect: 'non-idempotent', destinations: ['local'] },
  'external-send': { effect: 'non-idempotent', destinations: ['external'] },
};

/** Classes that change something in the world, so their targets are declared and recorded. */
export const changesWorld = (effectClass: ToolEffectClass) =>
  effectClass !== 'pure' && effectClass !== 'read';

const incomplete = (name: string, what: string) =>
  new HarnessError('tool_contract_incomplete', `Tool ${name} does not declare ${what}.`);

function limitsOf(tool: ToolDefinition<unknown, Json>): ToolLimits {
  const limits = { ...DEFAULT_TOOL_LIMITS, ...(tool.limits ?? {}) };
  for (const key of Object.keys(DEFAULT_TOOL_LIMITS) as (keyof ToolLimits)[])
    if (units(limits[key], `Tool ${tool.name} ${key}`) === 0 || limits[key] > HARD_CAPS[key])
      throw new HarnessError('tool_contract_incomplete', `Tool ${tool.name} has an out-of-range ${key}.`);
  return limits;
}

const bytes = (value: unknown) => Buffer.byteLength(canonical(value), 'utf8');

/**
 * The handler as the registry runs it: under the tool's timeout, with the
 * output checked against its schema and size before anyone records it.
 */
function contained(tool: ToolDefinition<unknown, Json>, limits: ToolLimits) {
  return async (context: StepContext & { input: unknown; targets?: readonly string[] }): Promise<Json> => {
    const local = new AbortController();
    const signal = context.signal ? AbortSignal.any([context.signal, local.signal]) : local.signal;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        const error = new HarnessError('tool_timeout', `Tool ${tool.name} did not finish within ${limits.timeoutMs} ms.`);
        local.abort(error);
        reject(error);
      }, limits.timeoutMs);
    });
    let output: Json;
    try {
      output = await Promise.race([Promise.resolve(tool.execute({ ...context, signal })), timeout]);
    } finally {
      clearTimeout(timer);
    }
    let size: number;
    try {
      size = bytes(output);
    } catch {
      throw new HarnessError('tool_output_rejected', `Tool ${tool.name} returned something that is not plain JSON.`);
    }
    if (size > limits.maxOutputBytes)
      throw new HarnessError('tool_output_too_large', `Tool ${tool.name} returned ${size} bytes; the limit is ${limits.maxOutputBytes}.`);
    const parsed = tool.outputSchema.safeParse(output);
    if (!parsed.success)
      throw new HarnessError(
        'tool_output_rejected',
        `Tool output schema rejected for ${tool.name}: ${parsed.error.issues.map((i) => i.message).join('; ')}`,
      );
    return output;
  };
}

export interface DispatchRequest {
  runId: string;
  owner: string;
  principal: HarnessPrincipal;
  stepId: string;
  name: string;
  /** Model- or host-supplied input. Validated here; never trusted as given. */
  input: unknown;
  origin?: OriginSnapshot;
  /** A host grant reference recorded as the effect's authorization, e.g. an authority hash. */
  authorization?: string;
  /** Host checks run inside the attempt, after its intent is recorded and before the handler. */
  before?: () => Promise<void> | void;
}

export class ToolRegistry {
  private tools = new Map<string, ToolDefinition<unknown, Json>>();
  private limits = new Map<string, ToolLimits>();

  register<I, O extends Json>(tool: ToolDefinition<I, O>): void {
    if (!tool || typeof tool.name !== 'string' || !NAME.test(tool.name))
      throw new HarnessError('invalid_tool', 'A tool name is lowercase letters, digits, dashes or underscores.');
    if (this.tools.has(tool.name))
      throw new HarnessError('duplicate_tool', `Duplicate tool name: ${tool.name}.`);
    if (typeof tool.version !== 'string' || !tool.version)
      throw new HarnessError('invalid_tool', `Tool ${tool.name} needs a version.`);
    if (!EFFECTS.includes(tool.effect))
      throw new HarnessError('invalid_tool', `Tool ${tool.name} has an unknown effect.`);
    if (tool.destination !== 'local' && tool.destination !== 'external')
      throw new HarnessError('invalid_tool', `Tool ${tool.name} has an unknown destination.`);
    units(tool.cost, `Tool ${tool.name} cost`);
    if (!tool.schema || typeof tool.schema.safeParse !== 'function')
      throw new HarnessError('invalid_tool', `Tool ${tool.name} needs a schema.`);
    if (typeof tool.execute !== 'function')
      throw new HarnessError('invalid_tool', `Tool ${tool.name} needs a handler.`);
    if (typeof tool.description !== 'string' || !tool.description.trim()) throw incomplete(tool.name, 'a description');
    if (!tool.outputSchema || typeof tool.outputSchema.safeParse !== 'function')
      throw incomplete(tool.name, 'an output schema');
    if (!Object.hasOwn(EFFECT_CLASSES, tool.effectClass as string)) throw incomplete(tool.name, 'its effect class');
    if (!Object.hasOwn(tool, 'permission') || (tool.permission !== null && (typeof tool.permission !== 'string' || !tool.permission)))
      throw incomplete(tool.name, 'its required permission (a name, or null for none)');
    if (typeof tool.approval !== 'boolean') throw incomplete(tool.name, 'its approval policy');
    if (typeof tool.trustedInputRequired !== 'boolean') throw incomplete(tool.name, 'whether it needs trusted input');
    const allowed = EFFECT_CLASSES[tool.effectClass];
    if (allowed.effect !== tool.effect || !allowed.destinations.includes(tool.destination))
      throw new HarnessError(
        'tool_contract_mismatch',
        `Tool ${tool.name} is declared ${tool.effectClass} but its effect is ${tool.effect} to a ${tool.destination} destination.`,
      );
    if (changesWorld(tool.effectClass) && typeof tool.targets !== 'function')
      throw incomplete(tool.name, 'the targets it may change');
    if (tool.effectClass === 'external-send' && tool.permission === null)
      throw incomplete(tool.name, 'the permission an external send needs');
    if (tool.reconcile !== undefined && typeof tool.reconcile !== 'function')
      throw new HarnessError('invalid_tool', `Tool ${tool.name} has an invalid reconciler.`);
    const entry = tool as unknown as ToolDefinition<unknown, Json>;
    const limits = limitsOf(entry);
    this.tools.set(tool.name, { ...entry, execute: contained(entry, limits) });
    this.limits.set(tool.name, limits);
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  get(name: string): ToolDefinition<unknown, Json> {
    const tool = this.tools.get(name);
    if (!tool) throw new HarnessError('unknown_tool', `Unknown tool: ${String(name)}.`);
    return tool;
  }

  /** Validate a model-supplied input against the tool's schema before anything else touches it. */
  validate(name: string, input: unknown): unknown {
    const tool = this.get(name);
    let size: number;
    try {
      size = bytes(input);
    } catch {
      throw new HarnessError('tool_input_rejected', `Tool input schema rejected for ${name}: not plain JSON.`);
    }
    const limit = this.limits.get(name)!.maxInputBytes;
    if (size > limit)
      throw new HarnessError('tool_input_too_large', `Tool input for ${name} is ${size} bytes; the limit is ${limit}.`);
    const parsed = tool.schema.safeParse(input);
    if (!parsed.success)
      throw new HarnessError(
        'tool_input_rejected',
        `Tool input schema rejected for ${name}: ${parsed.error.issues.map((i) => i.message).join('; ')}`,
      );
    return parsed.data;
  }

  /**
   * The one mediated path from a tool call to an effect: validate the input,
   * resolve and contain its targets, then run it as one RunService tool step
   * whose effect intent (tool, inputs digest, targets, idempotency key,
   * principal, authorization) is durably recorded before the handler runs and
   * whose outcome is recorded against it. A step whose effect is uncertain is
   * refused with `effect_uncertain` until it is reconciled.
   */
  async dispatch<T extends Json = Json>(runs: RunService, request: DispatchRequest): Promise<T> {
    const tool = this.get(request.name);
    const input = this.validate(tool.name, request.input) as Json;
    const targets = tool.targets ? [...(await tool.targets(input))] : [];
    if (!targets.every((target) => typeof target === 'string' && target))
      throw new HarnessError('tool_contract_incomplete', `Tool ${tool.name} declared an empty target.`);
    return runs.step<T>(
      request.runId,
      request.owner,
      {
        id: request.stepId,
        version: tool.version,
        kind: 'tool',
        effect: tool.effect,
        name: tool.name,
        cost: tool.cost,
        permission: tool.permission,
        approval: tool.approval,
        destination: tool.destination,
        trustedInputRequired: tool.trustedInputRequired,
        label: tool.label ?? null,
        ...(request.origin === undefined ? {} : { origin: request.origin }),
        input,
        effectRecord: {
          tool: tool.name,
          effectClass: tool.effectClass,
          targets,
          ...(request.authorization === undefined ? {} : { authorization: request.authorization }),
        },
      },
      async (context) => {
        await request.before?.();
        return (await tool.execute({ ...context, input: context.input, targets })) as T;
      },
      request.principal,
    );
  }

  /**
   * Ask a tool's own reconciler about the uncertain effect of one step and
   * record a definite answer. `unknown`, a missing reconciler or a reconciler
   * that throws leave the effect uncertain for a person to reconcile.
   */
  async reconcile(
    runs: RunService,
    runId: string,
    stepId: string,
    principal: HarnessPrincipal,
  ): Promise<'applied' | 'not-applied' | 'unknown'> {
    const run = await runs.get(runId);
    const step = run.steps.find((item) => item.intent.stepId === stepId);
    const record = step?.effects?.at(-1);
    if (!step || !record || record.status !== 'uncertain' || step.state !== 'reconcile_required')
      throw new HarnessError('not_uncertain', 'This step has no uncertain effect to reconcile.');
    const tool = this.get(record.tool);
    if (!tool.reconcile) return 'unknown';
    let answer: ReconcileAnswer;
    try {
      answer = await tool.reconcile({ input: step.intent.input, record: structuredClone(record) });
    } catch {
      return 'unknown';
    }
    const recorded = typeof answer === 'object' && answer !== null && 'applied' in answer ? answer.applied : undefined;
    const resolution = recorded !== undefined ? 'applied' : answer;
    if (resolution !== 'applied' && resolution !== 'not-applied') return 'unknown';
    if (recorded !== undefined) {
      const parsed = tool.outputSchema.safeParse(recorded);
      if (!parsed.success) return 'unknown';
    }
    await runs.reconcileEffect(
      runId,
      stepId,
      {
        resolution,
        by: `tool:${tool.name}`,
        evidence: `The ${tool.name} reconciler found the effect ${resolution === 'applied' ? 'recorded' : 'absent'} under its idempotency key.`,
        ...(recorded === undefined ? {} : { output: recorded }),
      },
      principal,
    );
    return resolution;
  }

  /** What the model may know about the tools. No handlers, no authority. */
  describe(): ToolDescriptor[] {
    return [...this.tools.values()].map((tool) => ({
      name: tool.name,
      version: tool.version,
      description: tool.description,
      effect: tool.effect,
      permission: tool.permission,
      approval: tool.approval,
      destination: tool.destination,
      trustedInputRequired: tool.trustedInputRequired,
      cost: tool.cost,
      inputSchema: z.toJSONSchema(tool.schema) as Json,
    }));
  }
}
