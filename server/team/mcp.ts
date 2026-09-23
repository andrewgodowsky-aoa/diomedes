// Tool names and mailbox semantics follow iOfficeAI/AionCore v0.2.1 crates/aionui-team (Apache-2.0); reimplemented for Diomedes.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Store } from '../store.js';
import type { TeamMember } from '../../shared/types.js';
import type { TeamService } from './service.js';
import { runTeamTool, TEAM_TOOLS } from './tools.js';

/**
 * The loopback MCP face of the team tools (server/team/tools.ts), for routes
 * whose engine connects to an MCP service itself. The member is the one the
 * bearer token and slot authenticated; the definitions are shared with the
 * host registry the model-API routes use.
 */
export function buildTeamMcpServer(
  projectId: string,
  member: TeamMember,
  store: Store,
  service: TeamService,
): McpServer {
  const server = new McpServer({ name: 'diomedes-team', version: '0.1.0' });
  for (const definition of TEAM_TOOLS) {
    const handler = async (args: Record<string, unknown> = {}) => {
      const result = await runTeamTool(definition, { projectId, member, store, service }, args);
      return result.ok
        ? { content: [{ type: 'text' as const, text: JSON.stringify(result.data) }] }
        : {
            content: [{ type: 'text' as const, text: JSON.stringify({ error: result.error }) }],
            isError: true as const,
          };
    };
    if (Object.keys(definition.shape).length)
      server.registerTool(
        definition.name,
        { description: definition.description, inputSchema: definition.shape },
        (args) => handler(args as Record<string, unknown>),
      );
    else server.registerTool(definition.name, { description: definition.description }, () => handler());
  }
  return server;
}
