// Tool names and mailbox semantics follow iOfficeAI/AionCore v0.2.1 crates/aionui-team (Apache-2.0); reimplemented for Diomedes.
/**
 * The team tools, defined once. The loopback MCP service (Codex, Claude Code)
 * and the host tool registry (model-API routes) both serve exactly these
 * definitions, so what a member may do does not depend on which route it runs
 * on. The member identity is always the host's: the MCP service authenticates
 * a bearer token and slot, and the host registry is built for the one member
 * whose run it serves. Nothing a model returns names a different member.
 */
import { z } from 'zod';
import type { Json, Effect } from '../../shared/harness.js';
import type { TeamMember } from '../../shared/types.js';
import { TEAM_TOOL_NAMES } from '../../shared/team-routes.js';
import { ApiError } from '../paths.js';
import type { Store } from '../store.js';
import type { TeamService } from './service.js';
import { ToolRegistry } from '../harness/tools.js';

type TeamToolName = (typeof TEAM_TOOL_NAMES)[number];

export interface TeamToolContext {
  projectId: string;
  member: TeamMember;
  store: Store;
  service: TeamService;
}

export interface TeamToolDefinition {
  name: TeamToolName;
  description: string;
  shape: z.ZodRawShape;
  /** Whether the call changes team state (it then runs under the Store lock). */
  effect: Extract<Effect, 'read' | 'non-idempotent'>;
  /** The result object the tool returns. Throws ApiError for a refusal the model may read. */
  run(context: TeamToolContext, args: Record<string, any>): Promise<unknown>;
}

const unavailable = (name: string) => {
  throw new ApiError(409, `${name} is not available in this version`);
};
const lead = (member: TeamMember, name: string) => {
  if (member.role !== 'lead') throw new ApiError(403, `Only the lead can use ${name}.`);
};

export const TEAM_TOOLS: readonly TeamToolDefinition[] = [
  {
    name: 'team_members',
    description: 'List the team roster without tokens.',
    shape: {},
    effect: 'read',
    run: async ({ service, projectId, member }) => {
      // A stopped helper reads nothing more from the team (security hardening, ce3cfba).
      service.requireActive(projectId, member.slotId);
      return { members: service.teamState(projectId).members };
    },
  },
  {
    name: 'team_send_message',
    description: 'Send a message to another slot.',
    shape: {
      to: z.string(),
      message: z.string(),
      files: z.array(z.string()).optional(),
      summary: z.string().optional(),
    },
    effect: 'non-idempotent',
    run: async ({ service, projectId, member }, args) => ({
      message: await service.sendAsMember(projectId, member, {
        to: args.to,
        message: args.message,
        files: args.files,
        summary: args.summary,
      }),
    }),
  },
  {
    name: 'team_read_messages',
    description: 'Read this slot’s messages, oldest first, marking them read.',
    shape: { since_message_id: z.string().optional() },
    effect: 'non-idempotent',
    run: async ({ service, projectId, member }, args) => ({
      messages: await service.readAsMember(projectId, member, args.since_message_id),
    }),
  },
  {
    name: 'team_task_create',
    description: 'Put a task on the board.',
    shape: {
      subject: z.string(),
      description: z.string().optional(),
      owner: z.string().optional(),
      blocked_by: z.array(z.string()).optional(),
      idempotency_key: z.string().optional(),
    },
    effect: 'non-idempotent',
    run: async ({ service, projectId, member }, args) => ({
      task: await service.taskCreateAsMember(projectId, member, {
        subject: args.subject,
        description: args.description,
        owner: args.owner,
        blocked_by: args.blocked_by,
        idempotency_key: args.idempotency_key,
      }),
    }),
  },
  {
    name: 'team_task_update',
    description: 'Update a board task.',
    shape: {
      task_id: z.string(),
      status: z.enum(['pending', 'in_progress', 'completed', 'deleted']).optional(),
      description: z.string().optional(),
      owner: z.string().optional(),
      blocked_by: z.array(z.string()).optional(),
    },
    effect: 'non-idempotent',
    run: async ({ service, projectId, member }, args) => ({
      task: await service.taskUpdateAsMember(projectId, member, {
        task_id: args.task_id,
        status: args.status,
        description: args.description,
        owner: args.owner,
        blocked_by: args.blocked_by,
      }),
    }),
  },
  {
    name: 'team_task_list',
    description: 'List board tasks mapped back to team statuses.',
    shape: {
      owner: z.string().optional(),
      status: z.union([z.string(), z.array(z.string())]).optional(),
      include_deleted: z.boolean().optional(),
      limit: z.number().optional(),
    },
    effect: 'read',
    run: async ({ service, projectId, member }, args) => ({
      tasks: await service.taskListAsMember(projectId, member, {
        owner: args.owner,
        status: args.status,
        include_deleted: args.include_deleted,
        limit: args.limit,
      }),
    }),
  },
  {
    name: 'team_list_assistants',
    description: 'List spawnable assistants.',
    shape: {},
    effect: 'read',
    run: async () => ({ assistants: [], note: 'spawning is not available in this version' }),
  },
  {
    name: 'team_describe_assistant',
    description: 'Describe an assistant.',
    shape: { assistant_id: z.string() },
    effect: 'read',
    run: async () => unavailable('team_describe_assistant'),
  },
  {
    name: 'team_spawn_agent',
    description: 'Spawn an agent (lead only).',
    shape: { name: z.string(), assistant_id: z.string() },
    effect: 'read',
    run: async ({ member }) => {
      lead(member, 'team_spawn_agent');
      return unavailable('team_spawn_agent');
    },
  },
  {
    name: 'team_rename_agent',
    description: 'Rename a team member (lead only).',
    shape: { slot_id: z.string(), new_name: z.string() },
    effect: 'non-idempotent',
    run: async ({ service, projectId, member }, args) => {
      lead(member, 'team_rename_agent');
      return { member: await service.renameAsLead(projectId, member, args.slot_id, args.new_name) };
    },
  },
  {
    name: 'team_interrupt_agent',
    description: 'Interrupt a team member (lead only).',
    shape: { slot_id: z.string(), message: z.string(), reason: z.string().optional() },
    effect: 'non-idempotent',
    run: async ({ service, projectId, member }, args) => {
      lead(member, 'team_interrupt_agent');
      return {
        message: await service.interruptAsLead(
          projectId,
          member,
          args.slot_id,
          args.message,
          args.reason,
        ),
      };
    },
  },
  {
    name: 'team_shutdown_agent',
    description: 'Request shutdown of a team member (lead only).',
    shape: { slot_id: z.string(), reason: z.string().optional() },
    effect: 'non-idempotent',
    run: async ({ service, projectId, member }, args) => {
      lead(member, 'team_shutdown_agent');
      return service.shutdownAsLead(projectId, member, args.slot_id, args.reason);
    },
  },
  {
    name: 'team_clear_agent_context',
    description: 'Clear an agent’s context (lead only).',
    shape: { slot_id: z.string() },
    effect: 'read',
    run: async ({ member }) => {
      lead(member, 'team_clear_agent_context');
      return unavailable('team_clear_agent_context');
    },
  },
];

export const teamErrorMessage = (error: unknown): string =>
  error instanceof ApiError
    ? error.message
    : error instanceof Error
      ? error.message
      : 'The local service could not complete this action.';

/**
 * Run one team tool for the member, under the Store lock when it changes team
 * state (the MCP service holds the same lock for the same calls). Returns the
 * tool's result, or `{ error }` for a refusal, exactly as the MCP service
 * answers it.
 */
export async function runTeamTool(
  definition: TeamToolDefinition,
  context: TeamToolContext,
  args: Record<string, unknown>,
): Promise<{ ok: true; data: unknown } | { ok: false; error: string }> {
  try {
    const data =
      definition.effect === 'read'
        ? await definition.run(context, args)
        : await context.store.locked(() => definition.run(context, args));
    return { ok: true, data };
  } catch (error) {
    return { ok: false, error: teamErrorMessage(error) };
  }
}

/**
 * The same tools as host-executed registry entries, for a route whose model
 * only receives descriptors (the model-API routes). Each call is a RunService
 * tool step; a refusal comes back to the model as `{ error }`, as it does over
 * MCP. `onCall` narrates the call into the Work session's log.
 */
export function teamToolRegistry(
  context: TeamToolContext,
  onCall?: (tool: string) => void,
): ToolRegistry {
  const registry = new ToolRegistry();
  for (const definition of TEAM_TOOLS)
    registry.register<Record<string, unknown>, Json>({
      name: definition.name,
      version: '1',
      description: definition.description,
      effect: definition.effect,
      permission: null,
      approval: false,
      destination: 'local',
      trustedInputRequired: false,
      cost: 1,
      schema: z.object(definition.shape) as unknown as z.ZodType<Record<string, unknown>>,
      execute: async ({ input }) => {
        try {
          onCall?.(definition.name);
        } catch {
          // Narration never decides a tool's outcome.
        }
        const result = await runTeamTool(definition, context, input);
        return JSON.parse(
          JSON.stringify(result.ok ? result.data : { error: result.error }),
        ) as Json;
      },
    });
  return registry;
}
