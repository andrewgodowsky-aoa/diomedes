/**
 * Host-side MCP clients for one Ask or Plan turn on a model-API route.
 *
 * The native engines run their own MCP clients from a config the host writes;
 * a model-API route has no engine, so the host is the client. It connects only
 * to a server the owner approved in `read-connectors.json`, and calls only a
 * tool named in that server's `readTools`: anything else is refused before a
 * process is started or a request is sent. A server is started lazily, at most
 * once per turn, and every client is closed when the turn ends or is stopped.
 *
 * The child process gets the SDK's minimal inherited environment (on Windows
 * APPDATA, HOMEDRIVE, HOMEPATH, LOCALAPPDATA, PATH, PROCESSOR_ARCHITECTURE,
 * SYSTEMDRIVE, SYSTEMROOT, TEMP, USERNAME, USERPROFILE, PROGRAMFILES; on other
 * systems HOME, LOGNAME, PATH, SHELL, TERM, USER) plus exactly the variables the
 * owner named in `envFrom`. Nothing else from this process's environment,
 * including every provider key, reaches it.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { approvedMcpTool, serverEnvironment, snapshotReadScope, type ApprovedMcpServer, type ReadScope } from '../../engines/read-scope.js';
import { externalReadAllowed, readGrantSignal } from '../../engines/turn-scope.js';
import { copy, HarnessError } from '../policy.js';

/** Opens a transport to one approved server. Tests substitute an in-memory pair. */
export type McpTransportFactory = (server: ApprovedMcpServer) => Transport;

const CONNECT_TIMEOUT_MS = 20_000;
const CALL_TIMEOUT_MS = 30_000;

/** The exact spawn parameters for an approved server: its command, its args and its allowed environment. */
export function stdioParameters(server: ApprovedMcpServer, source: NodeJS.ProcessEnv = process.env) {
  return {
    command: server.command,
    args: [...server.args],
    env: { ...getDefaultEnvironment(), ...serverEnvironment(server, source) },
    stderr: 'ignore' as const,
  };
}

export const stdioTransport: McpTransportFactory = (server) => new StdioClientTransport(stdioParameters(server));

export type McpReadResult =
  | { ok: true; server: string; tool: string; text: string; truncated: boolean; isError: boolean }
  | { ok: false; server: string; tool: string; reason: string };

/** Text from a tool result's content: text parts as they are, anything else named, never decoded. */
function resultText(result: Record<string, unknown>): string {
  const parts: string[] = [];
  const content = Array.isArray(result.content) ? result.content : [];
  for (const item of content) {
    const part = item && typeof item === 'object' ? (item as Record<string, unknown>) : {};
    if (part.type === 'text' && typeof part.text === 'string') parts.push(part.text);
    else if (part.type === 'resource' && part.resource && typeof part.resource === 'object') {
      const resource = part.resource as Record<string, unknown>;
      if (typeof resource.text === 'string') parts.push(resource.text);
      else parts.push(`[a ${String(resource.mimeType ?? 'binary')} resource, not shown]`);
    } else parts.push(`[${String(part.type ?? 'unknown')} content, not shown]`);
  }
  if (!parts.length && result.structuredContent !== undefined) {
    try {
      parts.push(JSON.stringify(result.structuredContent));
    } catch {
      /* not representable */
    }
  }
  return parts.join('\n');
}

export class McpReadClients {
  private readonly clients = new Map<string, Promise<Client>>();
  private readonly liveClients = new Set<Client>();
  private readonly scope: ReadScope;
  private readonly grantStop: AbortSignal;
  private readonly ended = new AbortController();
  private readonly onRevoke = () => { void this.close(); };
  private closed = false;
  constructor(
    scope: ReadScope,
    private readonly transport: McpTransportFactory = stdioTransport,
    private readonly maxChars = 24_000,
  ) {
    this.scope = snapshotReadScope(scope);
    this.grantStop = readGrantSignal(this.scope);
    this.grantStop.addEventListener('abort', this.onRevoke, { once: true });
  }

  private client(server: ApprovedMcpServer, signal: AbortSignal): Promise<Client> {
    let pending = this.clients.get(server.name);
    if (!pending) {
      pending = (async () => {
        signal.throwIfAborted();
        const client = new Client({ name: 'diomedes-read', version: '1' }, { capabilities: {} });
        this.liveClients.add(client);
        try {
          const transport = this.transport(server);
          signal.throwIfAborted();
          await client.connect(transport, { signal, timeout: CONNECT_TIMEOUT_MS });
          signal.throwIfAborted();
        } catch (error) {
          // A half-started server is ended here, not left running beside the turn.
          await client.close().catch(() => undefined);
          this.liveClients.delete(client);
          throw error;
        }
        return client;
      })();
      // A server that failed to start is not retried within the turn, and is still closed.
      this.clients.set(server.name, pending);
    }
    return pending;
  }

  /** One read tool call. A refusal or a server failure is a result; a stop propagates. */
  async call(serverName: string, tool: string, args: Record<string, unknown>, signal: AbortSignal): Promise<McpReadResult> {
    signal.throwIfAborted();
    if (this.closed) return { ok: false, server: serverName, tool, reason: 'The connector session has ended.' };
    const allowed = externalReadAllowed(this.scope, 'connector_read', { server: serverName, tool });
    if (!allowed.ok) return { ok: false, server: serverName, tool, reason: allowed.reason };
    const server = approvedMcpTool(this.scope, serverName, tool);
    if (!server)
      return {
        ok: false,
        server: serverName,
        tool,
        reason: `${serverName} (${tool}) is not an approved read tool. Only the tools the owner approved can be called.`,
      };
    let admittedArgs: Record<string, unknown>;
    try { admittedArgs = copy(args); }
    catch (error) {
      if (error instanceof HarnessError && error.code === 'not_json')
        return { ok: false, server: serverName, tool, reason: 'Connector arguments must be plain JSON.' };
      throw error;
    }
    if (JSON.stringify(admittedArgs).length > 4_000)
      return { ok: false, server: serverName, tool, reason: 'The arguments for that call are too large.' };
    const stop = AbortSignal.any([signal, this.grantStop, this.ended.signal]);
    try {
      const client = await this.client(server, stop);
      stop.throwIfAborted();
      const dispatch = externalReadAllowed(this.scope, 'connector_read', { server: serverName, tool });
      if (!dispatch.ok) return { ok: false, server: serverName, tool, reason: dispatch.reason };
      const result = (await client.callTool({ name: tool, arguments: admittedArgs }, undefined, {
        signal: stop,
        timeout: CALL_TIMEOUT_MS,
      })) as Record<string, unknown>;
      stop.throwIfAborted();
      const current = externalReadAllowed(this.scope, 'connector_read', { server: serverName, tool });
      if (!current.ok) return { ok: false, server: serverName, tool, reason: current.reason };
      const text = resultText(result);
      const truncated = text.length > this.maxChars;
      return {
        ok: true,
        server: serverName,
        tool,
        text: truncated ? text.slice(0, this.maxChars) : text,
        truncated,
        isError: result.isError === true,
      };
    } catch (error) {
      if (signal.aborted) throw signal.reason ?? error;
      const current = externalReadAllowed(this.scope, 'connector_read', { server: serverName, tool });
      if (!current.ok) return { ok: false, server: serverName, tool, reason: current.reason };
      if (this.closed) return { ok: false, server: serverName, tool, reason: 'The connector session has ended.' };
      return { ok: false, server: serverName, tool, reason: `${serverName} could not answer this call.` };
    }
  }

  /** Closes every client this turn opened, which ends each server process. Safe to call twice. */
  async close(): Promise<void> {
    this.closed = true;
    this.ended.abort(new Error('The connector session has ended.'));
    this.grantStop.removeEventListener('abort', this.onRevoke);
    const pending = [...this.clients.values()];
    this.clients.clear();
    const live = [...this.liveClients];
    this.liveClients.clear();
    await Promise.allSettled([
      ...live.map(client => client.close()),
      ...pending.map(async (client) => {
        await (await client).close();
      }),
    ]);
  }
}
