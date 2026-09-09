import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  CallToolResultSchema,
  ListToolsRequestSchema,
  ListToolsResultSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { Json } from '../../shared/harness.js';
import { digest } from '../harness/policy.js';
import type { ConnectionsService } from './service.js';

const bindingSchema = z.strictObject({
  projectId: z.string().min(1),
  connectionId: z.string().min(1),
  runId: z.string().min(1),
});

export type ConnectionsMcpBinding = z.infer<typeof bindingSchema>;

interface AuthorizedTool {
  operationId: string;
  name: string;
  description: string;
  inputSchema: Record<string, unknown> & { type: 'object' };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function inputSchema(value: Json): AuthorizedTool['inputSchema'] {
  if (!isRecord(value) || value['type'] !== 'object')
    throw new Error('A projected connection tool must have an object input schema.');
  return structuredClone(value) as AuthorizedTool['inputSchema'];
}

function errorResult() {
  return CallToolResultSchema.parse({
    content: [
      {
        type: 'text',
        text: JSON.stringify({ error: 'Connection invocation denied.' }),
      },
    ],
    isError: true,
  });
}

/**
 * Create a host-local MCP projection for one already admitted connection run.
 * Project, connection, run, resources, and operations come only from the trusted
 * closure and the current ConnectionsService binding. MCP arguments cannot add
 * authority. The caller chooses an in-process transport; this creates no listener.
 */
export function buildConnectionsMcpProjection(
  service: ConnectionsService,
  rawBinding: ConnectionsMcpBinding,
): Server {
  const binding = Object.freeze(bindingSchema.parse(structuredClone(rawBinding)));
  const server = new Server(
    { name: 'diomedes-connections', version: '0.1.0' },
    {
      capabilities: { tools: {} },
      instructions:
        'Host-local read-only projection of one admitted Diomedes connection run. All calls use Runtime and current connection authority.',
    },
  );

  const authorizedTools = async (): Promise<AuthorizedTool[]> => {
    const savedBinding = service.snapshot(binding.projectId).connections.bindings[binding.runId];
    if (savedBinding?.connectionId !== binding.connectionId)
      throw new Error('Connection discovery denied.');
    // modelContext rechecks the saved run binding, connection generation, current
    // principal identity/capability, and active connection state on discovery.
    const context = await service.modelContext({
      runId: binding.runId,
      capabilityId: 'connections-mcp-projection',
      messages: [],
      tools: [],
      transcript: null,
    });
    const status = await service.status(binding.projectId, binding.connectionId);
    if (
      status.connection.id !== binding.connectionId ||
      status.connection.projectId !== binding.projectId ||
      status.connection.status !== 'connected'
    )
      throw new Error('Connection discovery denied.');
    const allowed = new Set(context.tools);
    return status.manifest.operations
      .map((operation) => ({
        operationId: operation.id,
        name: service.toolName(status.manifest.id, operation.id),
        description: operation.description,
        inputSchema: inputSchema(operation.inputSchema),
      }))
      .filter((operation) => allowed.has(operation.name));
  };

  server.setRequestHandler(ListToolsRequestSchema, async (request) => {
    if (request.params?.cursor) throw new Error('Connection tool pagination is unavailable.');
    try {
      const tools = (await authorizedTools()).map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      }));
      return ListToolsResultSchema.parse({ tools });
    } catch {
      throw new Error('Connection discovery denied.');
    }
  });

  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    try {
      const tools = await authorizedTools();
      const operation = tools.find((tool) => tool.name === request.params.name);
      if (!operation) return errorResult();
      const args = z.json().parse(request.params.arguments ?? {});
      if (!isRecord(args)) return errorResult();
      // The JSON-RPC request id is the durable retry identity for this bound
      // projection. A repeated id and identical canonical arguments returns the
      // Runtime observation; changed arguments under that id are refused there.
      const stepId = `mcp-${digest({ requestId: extra.requestId })}`;
      const result = await service.invoke(binding.runId, operation.operationId, args, stepId);
      return CallToolResultSchema.parse({
        content: [{ type: 'text', text: JSON.stringify(result) }],
      });
    } catch {
      return errorResult();
    }
  });

  return server;
}
