/**
 * The host-owned tool registry. A tool's effect class, permission, approval
 * need, destination and cost are declared here by trusted host code and taken
 * from here at dispatch. The model only ever sees a `ToolDescriptor`: the name,
 * a sentence and the input schema. Nothing a model returns can change what a
 * tool is allowed to do.
 */
import { z } from 'zod';
import type { Destination, Effect, HarnessLabel, Json, ToolDescriptor } from '../../shared/harness.js';
import { HarnessError, units } from './policy.js';
import type { StepContext } from './run-service.js';

export interface ToolDefinition<I = unknown, O = Json> {
  name: string;
  version: string;
  description: string;
  effect: Effect;
  permission: string | null;
  approval: boolean;
  destination: Destination;
  trustedInputRequired: boolean;
  cost: number;
  /** Strict input schema. Unknown keys are rejected when the schema is strict. */
  schema: z.ZodType<I>;
  label?: HarnessLabel | null;
  execute: (context: StepContext & { input: I }) => Promise<O> | O;
}

const NAME = /^[a-z][a-z0-9_-]{0,63}$/;
const EFFECTS: Effect[] = ['pure', 'read', 'idempotent', 'non-idempotent'];

export class ToolRegistry {
  private tools = new Map<string, ToolDefinition<unknown, Json>>();

  register<I, O extends Json>(tool: ToolDefinition<I, O>): void {
    if (typeof tool.name !== 'string' || !NAME.test(tool.name))
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
    this.tools.set(tool.name, tool as unknown as ToolDefinition<unknown, Json>);
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
    const parsed = tool.schema.safeParse(input);
    if (!parsed.success)
      throw new HarnessError(
        'tool_input_rejected',
        `Tool input schema rejected for ${name}: ${parsed.error.issues.map((i) => i.message).join('; ')}`,
      );
    return parsed.data;
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
