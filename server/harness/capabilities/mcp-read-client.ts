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
import { approvedMcpTool, serverEnvironment, type ApprovedMcpServer, type ReadScope } from '../../engines/read-scope.js';

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
  private closed = false;
  constructor(
    private readonly scope: ReadScope,
    private readonly transport: McpTransportFactory = stdioTransport,
    private readonly maxChars = 24_000,
  ) {}

  private client(server: ApprovedMcpServer, signal: AbortSignal): Promise<Client> {
    let pending = this.clients.get(server.name);
    if (!pending) {
      pending = (async () => {
        const client = new Client({ name: 'diomedes-read', version: '1' }, { capabilities: {} });
        try {
          await client.connect(this.transport(server), { signal, timeout: CONNECT_TIMEOUT_MS });
        } catch (error) {
          // A half-started server is ended here, not left running beside the turn.
          await client.close().catch(() => undefined);
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
    const server = approvedMcpTool(this.scope, serverName, tool);
    if (!server)
      return {
        ok: false,
        server: serverName,
        tool,
        reason: `${serverName} (${tool}) is not an approved read tool. Only the tools the owner approved can be called.`,
      };
    try {
      const client = await this.client(server, signal);
      const result = (await client.callTool({ name: tool, arguments: args }, undefined, {
        signal,
        timeout: CALL_TIMEOUT_MS,
      })) as Record<string, unknown>;
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
      return { ok: false, server: serverName, tool, reason: `${serverName} could not answer this call.` };
    }
  }

  /** Closes every client this turn opened, which ends each server process. Safe to call twice. */
  async close(): Promise<void> {
    this.closed = true;
    const pending = [...this.clients.values()];
    this.clients.clear();
    await Promise.allSettled(
      pending.map(async (client) => {
        await (await client).close();
      }),
    );
  }
}
