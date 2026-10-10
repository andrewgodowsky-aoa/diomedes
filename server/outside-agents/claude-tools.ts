/**
 * OA2: Nectovia's tools inside a person's own Claude Code, in-band.
 *
 * Claude Code's stream-json mode can host an MCP server in the client: an
 * `--mcp-config` entry of `type: "sdk"` makes the CLI send that server's
 * JSON-RPC as a `control_request` (`subtype: "mcp_message"`, `server_name`,
 * `message`) on stdout, and read the reply as a `control_response` whose
 * response is `{ mcp_response }`. That is the channel the Agent SDK uses for
 * its in-process servers. Like Codex's dynamic tools, the call never leaves
 * the stdio pipe, so the box needs no loopback port.
 *
 * The MCP side is the SDK's own `Server`, so `initialize`, `tools/list` and
 * `tools/call` follow the protocol version the CLI asks for; this module only
 * moves messages between frames and that server, and answers the permission
 * request for exactly our tools. `--tools ""` switches every built-in tool off,
 * `--strict-mcp-config` keeps every other server out, and the box refuses
 * what a flag might not.
 *
 * Not wired into the Claude Code driver yet: that file belongs to another lane.
 */
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { CallToolRequestSchema, ListToolsRequestSchema, type JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import { runLayout, type ContainedAgentPlan, type EgressRule } from './container-request.js';
import type { OutsideToolHost } from './tool-host.js';

export const CLAUDE_TOOL_SERVER = 'nectovia';
const PREFIX = `mcp__${CLAUDE_TOOL_SERVER}__`;
const REPLY_TIMEOUT_MS = 10 * 60 * 1000;

/** The flags that give a Claude Code turn our tools and nothing else. */
export function claudeToolFlags(host: OutsideToolHost): string[] {
  return [
    '--tools',
    '',
    '--strict-mcp-config',
    '--mcp-config',
    JSON.stringify({ mcpServers: { [CLAUDE_TOOL_SERVER]: { type: 'sdk', name: CLAUDE_TOOL_SERVER } } }),
    '--allowedTools',
    host.tools().map((tool) => `${PREFIX}${tool.name}`).join(','),
  ];
}

/**
 * A contained Claude Code turn on the person's own subscription: the one-year
 * token `claude setup-token` makes, a config folder of its own under the run,
 * hooks off, and only our tools.
 */
export function claudeCodeTurnPlan(input: {
  readonly executable: string;
  readonly runRoot: string;
  readonly profile: string;
  readonly systemRoot: string;
  readonly token: string;
  readonly egress: readonly EgressRule[];
  readonly timeoutMs: number;
  readonly host: OutsideToolHost;
  readonly model?: string;
}): ContainedAgentPlan {
  const layout = runLayout(input.runRoot);
  return {
    executable: input.executable,
    args: [
      '--print',
      '--input-format',
      'stream-json',
      '--output-format',
      'stream-json',
      '--verbose',
      ...(input.model ? ['--model', input.model] : []),
      '--settings',
      JSON.stringify({ disableAllHooks: true }),
      ...claudeToolFlags(input.host),
    ],
    runRoot: input.runRoot,
    profile: input.profile,
    systemRoot: input.systemRoot,
    egress: input.egress,
    env: {
      CLAUDE_CONFIG_DIR: path.join(layout.home, '.claude'),
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      DISABLE_AUTOUPDATER: '1',
    },
    signIn: { name: 'CLAUDE_CODE_OAUTH_TOKEN', value: input.token },
    timeoutMs: input.timeoutMs,
  };
}

type Id = string | number;
/** Carries one message at a time from a frame into the server, and the server's reply back out. */
class FrameTransport implements Transport {
  onmessage?: Transport['onmessage'];
  onclose?: () => void;
  onerror?: (error: Error) => void;
  private readonly waiting = new Map<Id, (message: JSONRPCMessage) => void>();

  async start() {}
  async close() {
    this.onclose?.();
  }
  async send(message: JSONRPCMessage) {
    // Only replies travel this channel; a server-initiated request or notification has no way back and is dropped.
    if ('id' in message && ('result' in message || 'error' in message)) {
      const done = this.waiting.get(message.id as Id);
      if (done) {
        this.waiting.delete(message.id as Id);
        done(message);
      }
    }
  }
  /** Hand a message to the server; resolves with its reply, or at once for a notification. */
  deliver(message: JSONRPCMessage): Promise<JSONRPCMessage> {
    const id = (message as { id?: unknown }).id;
    if (typeof id !== 'string' && typeof id !== 'number') {
      this.onmessage?.(message);
      return Promise.resolve({ jsonrpc: '2.0', result: {} } as unknown as JSONRPCMessage);
    }
    if (this.waiting.has(id)) return Promise.resolve(rpcError(id, -32600, 'That request id is already waiting.'));
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.waiting.delete(id);
        resolve(rpcError(id, -32603, 'The tool host did not answer in time.'));
      }, REPLY_TIMEOUT_MS);
      this.waiting.set(id, (reply) => {
        clearTimeout(timer);
        resolve(reply);
      });
      this.onmessage?.(message);
    });
  }
}

const rpcError = (id: Id, code: number, message: string) => ({ jsonrpc: '2.0', id, error: { code, message } }) as unknown as JSONRPCMessage;

export interface ClaudeReply {
  /** The frame to write back on the CLI's stdin. */
  readonly reply: { type: 'control_response'; response: { subtype: 'success'; request_id: string; response: unknown } };
  /** True when the request asked for something outside this route; the driver stops the turn. */
  readonly blocked: boolean;
}

const success = (requestId: string, response: unknown, blocked = false): ClaudeReply => ({
  reply: { type: 'control_response', response: { subtype: 'success', request_id: requestId, response } },
  blocked,
});
const deny = (requestId: string, message: string) => success(requestId, { behavior: 'deny', message, interrupt: true }, true);

/** One Claude Code turn's tool server: answers the CLI's control requests for our tools, refuses the rest. */
export class ClaudeToolBridge {
  private readonly transport = new FrameTransport();
  private ready: Promise<void> | null = null;
  // The CLI's JSON-RPC ids can repeat across turns, so each call gets this bridge's own id.
  private readonly nonce = randomUUID();
  private calls = 0;

  constructor(private readonly host: OutsideToolHost) {}

  private connect(): Promise<void> {
    if (this.ready) return this.ready;
    const server = new Server({ name: CLAUDE_TOOL_SERVER, version: '1.0.0' }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: this.host.tools() as never }));
    server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const answer = await this.host.call(request.params.name, request.params.arguments ?? {}, `claude:${this.nonce}:${++this.calls}`);
      return { content: [{ type: 'text', text: answer.text }], isError: !answer.ok };
    });
    this.ready = server.connect(this.transport);
    return this.ready;
  }

  /**
   * The answer to one frame from the CLI's stdout, or null when the frame is not
   * a control request (assistant text, results and the like are the driver's).
   */
  async answer(frame: unknown): Promise<ClaudeReply | null> {
    if (!frame || typeof frame !== 'object' || (frame as { type?: unknown }).type !== 'control_request') return null;
    const { request_id: requestId, request } = frame as { request_id?: unknown; request?: unknown };
    if (typeof requestId !== 'string' || !requestId) return null;
    const body = (request && typeof request === 'object' ? request : {}) as Record<string, unknown>;
    if (body.subtype === 'mcp_message') {
      if (body.server_name !== CLAUDE_TOOL_SERVER) return deny(requestId, 'Only the Nectovia tool server runs on this route.');
      const message = body.message;
      if (!message || typeof message !== 'object' || (message as { jsonrpc?: unknown }).jsonrpc !== '2.0')
        return deny(requestId, 'That tool message was not well formed.');
      await this.connect();
      return success(requestId, { mcp_response: await this.transport.deliver(message as JSONRPCMessage) });
    }
    if (body.subtype === 'can_use_tool') {
      const name = typeof body.tool_name === 'string' ? body.tool_name : '';
      if (name.startsWith(PREFIX) && this.host.has(name.slice(PREFIX.length)))
        return success(requestId, { behavior: 'allow', updatedInput: body.input && typeof body.input === 'object' ? body.input : {} });
      return deny(requestId, 'Only Nectovia tools run on this route.');
    }
    return deny(requestId, 'Permission prompts and callbacks are disabled on this route.');
  }
}
