// Tool names and mailbox semantics follow iOfficeAI/AionCore v0.2.1 crates/aionui-team (Apache-2.0); reimplemented for Diomedes.
import type { Express, Request, Response } from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { ApiError } from '../paths.js';
import type { Store } from '../store.js';
import { TeamService } from './service.js';
import { buildTeamMcpServer } from './mcp.js';

function plain(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new ApiError(400, 'Provide an object.');
  return value as Record<string, unknown>;
}

function isLoopback(req: Request): boolean {
  const addr = req.socket.remoteAddress ?? '';
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
}

export function mountTeamRoutes(app: Express, store: Store, existing?: TeamService): TeamService {
  const service = existing ?? new TeamService(store);

  const route =
    (action: (req: Request, res: Response) => Promise<unknown>, locked = true) =>
    async (req: Request, res: Response, next: (error: unknown) => void) => {
      try {
        const result = locked ? await store.locked(() => action(req, res)) : await action(req, res);
        if (!res.headersSent) res.json(result);
      } catch (error) {
        next(error);
      }
    };

  app.get('/mcp/team/:projectId', (_req, res) => {
    res.status(405).json({ error: 'Use POST for the team MCP endpoint.' });
  });
  app.delete('/mcp/team/:projectId', (_req, res) => {
    res.status(405).json({ error: 'Use POST for the team MCP endpoint.' });
  });
  app.post('/mcp/team/:projectId', async (req, res, next) => {
    try {
      if (!isLoopback(req)) {
        res.status(403).json({ error: 'The team server accepts loopback connections only.' });
        return;
      }
      const projectId = String(req.params.projectId);
      store.state(projectId);
      const authorization = req.headers.authorization ?? '';
      const match = /^Bearer (.+)$/.exec(authorization);
      const token = match ? match[1] : null;
      const slotHeader = req.headers['x-slot-id'];
      const slotId = Array.isArray(slotHeader) ? slotHeader[0] : (slotHeader ?? null);
      let member;
      try {
        member = await service.authenticate(projectId, slotId ?? null, token);
      } catch (error) {
        if (error instanceof ApiError && error.status === 401) {
          res.status(401).json({ error: error.message });
          return;
        }
        throw error;
      }
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      const mcpServer = buildTeamMcpServer(projectId, member, store, service);
      try {
        await mcpServer.connect(transport);
        await transport.handleRequest(req, res, req.body);
      } finally {
        await mcpServer.close().catch(() => undefined);
      }
    } catch (error) {
      next(error);
    }
  });

  app.get(
    '/api/projects/:id/team',
    route(async (req) => {
      const team = service.teamState(String(req.params.id));
      return structuredClone(team);
    }, false),
  );
  app.post(
    '/api/projects/:id/team/members',
    route(async (req) => {
      const b = plain(req.body);
      return service.createMember(String(req.params.id), {
        name: b.name,
        role: b.role,
        engine: b.engine,
        model: b.model,
        threadId: b.threadId,
        agentId: b.agentId,
      });
    }),
  );
  app.post(
    '/api/projects/:id/team/members/:slot/stop',
    route(async (req) => service.stopMember(String(req.params.id), String(req.params.slot))),
  );
  app.post(
    '/api/projects/:id/team/members/:slot/wake',
    route(async (req) => service.wakeMember(String(req.params.id), String(req.params.slot))),
  );
  app.post(
    '/api/projects/:id/team/messages',
    route(async (req) => {
      const b = plain(req.body);
      if (typeof b.to !== 'string' || typeof b.content !== 'string')
        throw new ApiError(400, 'Provide a recipient and message content.');
      return service.ownerSendMessage(String(req.params.id), b.to, b.content);
    }),
  );

  app.locals.teamService = service;
  return service;
}
