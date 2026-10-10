/**
 * OA2: Nectovia's tools inside a person's own Codex, in-band.
 *
 * Codex's app-server takes client-executed tools at `thread/start`
 * (`dynamicTools`), and asks the client to run one with the server request
 * `item/tool/call` (`DynamicToolCallParams`: threadId, turnId, callId, tool,
 * arguments, namespace). The client answers `{ success, contentItems }`. The
 * call never leaves the stdio pipe the host already holds, so no loopback port
 * is opened from the box. Read from the app-server protocol schema of codex
 * 0.153.4.
 *
 * Only calls for the thread this host started, with no namespace, are run.
 * Every other server request (approvals, auth refresh, anything new) is
 * refused with JSON-RPC -32601 and reported as blocked, the same rule the
 * text-only client in `integrations.ts` keeps.
 *
 * Not wired into the Codex driver yet: that file belongs to another lane. This
 * module is the frame-in, frame-out half the driver calls.
 */
import { z } from 'zod';
import type { OutsideToolHost } from './tool-host.js';

/** One `DynamicToolSpec` of the function kind. */
export interface CodexDynamicTool {
  type: 'function';
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export const codexDynamicTools = (host: OutsideToolHost): CodexDynamicTool[] =>
  host.tools().map((tool) => ({ type: 'function', name: tool.name, description: tool.description, inputSchema: tool.inputSchema }));

const CallParams = z.object({
  threadId: z.string().min(1).max(256),
  turnId: z.string().min(1).max(256),
  callId: z.string().min(1).max(256),
  tool: z.string().min(1).max(128),
  arguments: z.unknown(),
  namespace: z.string().nullish(),
});

type Id = string | number;
export interface CodexReply {
  /** The JSON-RPC response to write back on the app-server's stdin. */
  readonly reply: { id: Id; result: { success: boolean; contentItems: { type: 'inputText'; text: string }[] } } | { id: Id; error: { code: number; message: string } };
  /** True when the request asked for something outside this route; the driver stops the turn. */
  readonly blocked: boolean;
}

const answer = (id: Id, ok: boolean, text: string): CodexReply => ({
  reply: { id, result: { success: ok, contentItems: [{ type: 'inputText', text }] } },
  blocked: false,
});
const refuse = (id: Id, code: number, message: string): CodexReply => ({ reply: { id, error: { code, message } }, blocked: true });

/**
 * The answer to one app-server server request (a frame with both `id` and
 * `method`). Returns null for a frame that is not a server request.
 */
export async function answerCodexServerRequest(host: OutsideToolHost, frame: unknown, threadId: string): Promise<CodexReply | null> {
  if (!frame || typeof frame !== 'object') return null;
  const { id, method, params } = frame as { id?: unknown; method?: unknown; params?: unknown };
  if ((typeof id !== 'string' && typeof id !== 'number') || typeof method !== 'string') return null;
  if (method !== 'item/tool/call') return refuse(id, -32601, 'This client runs Nectovia tools only.');
  const parsed = CallParams.safeParse(params);
  if (!parsed.success) return refuse(id, -32602, 'The tool call was not well formed.');
  const call = parsed.data;
  if (call.threadId !== threadId) return refuse(id, -32602, 'That tool call is for a thread this client did not start.');
  if (call.namespace) return answer(id, false, `There is no tool namespace called ${JSON.stringify(call.namespace.slice(0, 64))}. (tool_unknown)`);
  const result = await host.call(call.tool, call.arguments, `codex:${call.threadId}:${call.turnId}:${call.callId}`);
  return answer(id, result.ok, result.text);
}
