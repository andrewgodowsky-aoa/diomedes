// Tool names and mailbox semantics follow iOfficeAI/AionCore v0.2.1 crates/aionui-team (Apache-2.0); reimplemented for Diomedes.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { ApiError } from '../paths.js';
import type { Store } from '../store.js';
import type { TeamMember } from '../../shared/types.js';
import type { TeamService } from './service.js';

const textResult = (data: unknown) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(data) }],
});

const errorResult = (message: string) => ({
  content: [{ type: 'text' as const, text: JSON.stringify({ error: message }) }],
  isError: true as const,
});

function toError(error: unknown): { content: [{ type: 'text'; text: string }]; isError: true } {
  const message =
    error instanceof ApiError
      ? error.message
      : error instanceof Error
        ? error.message
        : 'The local service could not complete this action.';
  return { content: [{ type: 'text' as const, text: JSON.stringify({ error: message }) }], isError: true as const };
}

export function buildTeamMcpServer(
  projectId: string,
  member: TeamMember,
  store: Store,
  service: TeamService,
): McpServer {
  const server = new McpServer({ name: 'diomedes-team', version: '0.1.0' });

  server.registerTool('team_members', { description: 'List the team roster without tokens.' }, async () => {
    try {
      const team = service.teamState(projectId);
      return textResult({ members: team.members });
    } catch (error) {
      return toError(error);
    }
  });

  server.registerTool(
    'team_send_message',
    {
      description: 'Send a message to another slot.',
      inputSchema: {
        to: z.string(),
        message: z.string(),
        files: z.array(z.string()).optional(),
        summary: z.string().optional(),
      },
    },
    async (args) => {
      try {
        const result = await store.locked(() =>
          service.sendAsMember(projectId, member, {
            to: args.to,
            message: args.message,
            files: args.files,
            summary: args.summary,
          }),
        );
        return textResult({ message: result });
      } catch (error) {
        return toError(error);
      }
    },
  );

  server.registerTool(
    'team_read_messages',
    {
      description: 'Read this slot’s messages, oldest first, marking them read.',
      inputSchema: { since_message_id: z.string().optional() },
    },
    async (args) => {
      try {
        const result = await store.locked(() =>
          service.readAsMember(projectId, member, args.since_message_id),
        );
        return textResult({ messages: result });
      } catch (error) {
        return toError(error);
      }
    },
  );

  server.registerTool(
    'team_task_create',
    {
      description: 'Put a task on the board.',
      inputSchema: {
        subject: z.string(),
        description: z.string().optional(),
        owner: z.string().optional(),
        blocked_by: z.array(z.string()).optional(),
        idempotency_key: z.string().optional(),
      },
    },
    async (args) => {
      try {
        const result = await store.locked(() =>
          service.taskCreateAsMember(projectId, member, {
            subject: args.subject,
            description: args.description,
            owner: args.owner,
            blocked_by: args.blocked_by,
            idempotency_key: args.idempotency_key,
          }),
        );
        return textResult({ task: result });
      } catch (error) {
        return toError(error);
      }
    },
  );

  server.registerTool(
    'team_task_update',
    {
      description: 'Update a board task.',
      inputSchema: {
        task_id: z.string(),
        status: z.enum(['pending', 'in_progress', 'completed', 'deleted']).optional(),
        description: z.string().optional(),
        owner: z.string().optional(),
        blocked_by: z.array(z.string()).optional(),
      },
    },
    async (args) => {
      try {
        const result = await store.locked(() =>
          service.taskUpdateAsMember(projectId, member, {
            task_id: args.task_id,
            status: args.status,
            description: args.description,
            owner: args.owner,
            blocked_by: args.blocked_by,
          }),
        );
        return textResult({ task: result });
      } catch (error) {
        return toError(error);
      }
    },
  );

  server.registerTool(
    'team_task_list',
    {
      description: 'List board tasks mapped back to team statuses.',
      inputSchema: {
        owner: z.string().optional(),
        status: z.union([z.string(), z.array(z.string())]).optional(),
        include_deleted: z.boolean().optional(),
        limit: z.number().optional(),
      },
    },
    async (args) => {
      try {
        const result = await service.taskListAsMember(projectId, member, {
          owner: args.owner,
          status: args.status,
          include_deleted: args.include_deleted,
          limit: args.limit,
        });
        return textResult({ tasks: result });
      } catch (error) {
        return toError(error);
      }
    },
  );

  server.registerTool('team_list_assistants', { description: 'List spawnable assistants.' }, async () => {
    try {
      return textResult({
        assistants: [],
        note: 'spawning is not available in this version',
      });
    } catch (error) {
      return toError(error);
    }
  });

  server.registerTool(
    'team_describe_assistant',
    {
      description: 'Describe an assistant.',
      inputSchema: { assistant_id: z.string() },
    },
    async () => errorResult('team_describe_assistant is not available in this version'),
  );

  server.registerTool(
    'team_spawn_agent',
    {
      description: 'Spawn an agent (lead only).',
      inputSchema: { name: z.string(), assistant_id: z.string() },
    },
    async () => {
      if (member.role !== 'lead') return errorResult('Only the lead can use team_spawn_agent.');
      return errorResult('team_spawn_agent is not available in this version');
    },
  );

  server.registerTool(
    'team_rename_agent',
    {
      description: 'Rename a team member (lead only).',
      inputSchema: { slot_id: z.string(), new_name: z.string() },
    },
    async (args) => {
      try {
        if (member.role !== 'lead') return errorResult('Only the lead can use team_rename_agent.');
        const result = await store.locked(() =>
          service.renameAsLead(projectId, member, args.slot_id, args.new_name),
        );
        return textResult({ member: result });
      } catch (error) {
        return toError(error);
      }
    },
  );

  server.registerTool(
    'team_interrupt_agent',
    {
      description: 'Interrupt a team member (lead only).',
      inputSchema: { slot_id: z.string(), message: z.string(), reason: z.string().optional() },
    },
    async (args) => {
      try {
        if (member.role !== 'lead')
          return errorResult('Only the lead can use team_interrupt_agent.');
        const result = await store.locked(() =>
          service.interruptAsLead(projectId, member, args.slot_id, args.message, args.reason),
        );
        return textResult({ message: result });
      } catch (error) {
        return toError(error);
      }
    },
  );

  server.registerTool(
    'team_shutdown_agent',
    {
      description: 'Request shutdown of a team member (lead only).',
      inputSchema: { slot_id: z.string(), reason: z.string().optional() },
    },
    async (args) => {
      try {
        if (member.role !== 'lead')
          return errorResult('Only the lead can use team_shutdown_agent.');
        const result = await store.locked(() =>
          service.shutdownAsLead(projectId, member, args.slot_id, args.reason),
        );
        return textResult(result);
      } catch (error) {
        return toError(error);
      }
    },
  );

  server.registerTool(
    'team_clear_agent_context',
    {
      description: 'Clear an agent’s context (lead only).',
      inputSchema: { slot_id: z.string() },
    },
    async () => {
      if (member.role !== 'lead')
        return errorResult('Only the lead can use team_clear_agent_context.');
      return errorResult('team_clear_agent_context is not available in this version');
    },
  );

  void projectId;
  return server;
}
