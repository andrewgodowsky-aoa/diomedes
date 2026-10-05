/**
 * A scripted provider for the route checks: it reads each request's own bytes to tell which check
 * sent it, and answers in the route's own protocol (Chat Completions for AWS Kimi K3, Responses for
 * Azure). Captured-shape streams only; nothing here reaches a network.
 */
import { OUTPUT_BOUND_TOKENS } from '../../server/engines/route-qualification.js';
import { chatEvents, responsesEvents, sseResponse } from './model-api-streams.js';

type Item = Record<string, unknown>;

export type CallKind = 'short-answer' | 'output-bound' | 'tool-ask' | 'tool-answer' | 'cache-default' | 'cache-off';
export interface Script {
  /** Billed output the output-bound call reports. 64 by default: inside its limit. */
  outputBound?: number;
  /** Cache-read tokens on the two default-cache calls. */
  cacheReads?: [number, number];
  /** How the no-cache calls answer: no cache tokens, cache writes anyway, or a 400 on the option. */
  cacheOff?: 'clean' | 'writes' | 'refused';
  /** Every call answers 401. */
  unauthorized?: boolean;
  /** Answer one call some other way; return undefined to answer as scripted. */
  intercept?: (kind: CallKind, signal: AbortSignal | undefined) => Response | undefined | Promise<Response | undefined>;
}
export interface Seen {
  url: string;
  headers: Headers;
  body: Item;
  kind: CallKind;
}

/** Which check a request belongs to, read from its own bytes. */
export function kindOf(body: Item): CallKind {
  const text = JSON.stringify(body.messages ?? body.input);
  if (body.prompt_cache_options !== undefined) return 'cache-off';
  if (text.includes('Reference rules for an automated route check')) return 'cache-default';
  if (text.includes('9699690')) return 'output-bound';
  if (text.includes('lookup_fact')) return text.includes('blue-42') ? 'tool-answer' : 'tool-ask';
  return 'short-answer';
}

interface Usage {
  input: number;
  output: number;
  read?: number;
  write?: number;
  reasoning?: number;
}
/** What each call reports, by check and by the call's place in it. */
function answerOf(kind: CallKind, n: number, script: Script): { text?: string; tool?: boolean; incomplete?: boolean; usage: Usage } {
  switch (kind) {
    case 'short-answer':
      return { text: 'OK', usage: { input: 60, output: 20, reasoning: 16 } };
    case 'output-bound': {
      const output = script.outputBound ?? OUTPUT_BOUND_TOKENS;
      return { text: 'The prime factors are', incomplete: true, usage: { input: 70, output, reasoning: Math.max(0, output - 5) } };
    }
    case 'tool-ask':
      return { tool: true, usage: { input: 90, output: 30, reasoning: 20 } };
    case 'tool-answer':
      return { text: 'blue-42', usage: { input: 140, output: 12, reasoning: 6 } };
    case 'cache-default':
      // Implicit caching writes the prefix on the first call and reads it on the second.
      return { text: 'OK', usage: { input: 1_600, output: 10, read: (script.cacheReads ?? [0, 1_280])[n - 1], write: n === 1 ? 1_536 : 0 } };
    case 'cache-off':
      return { text: 'OK', usage: { input: 1_600, output: 10, write: script.cacheOff === 'writes' ? 1_536 : 0 } };
  }
}

const jsonAnswer = (body: unknown, status: number, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

/** A stream that starts and then never ends, until the request's own signal stops it. */
export function hanging(signal: AbortSignal | undefined) {
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(': waiting\n\n'));
        signal?.addEventListener('abort', () => controller.error(new DOMException('The operation was aborted.', 'AbortError')), {
          once: true,
        });
      },
    }),
    { status: 200, headers: { 'content-type': 'text/event-stream' } },
  );
}

/** The provider for one route: `reportedModel` is what its answers say served them. */
export function routeCheckProvider(protocol: 'chat' | 'responses', reportedModel: string, script: Script = {}) {
  const seen: Seen[] = [];
  const counts = new Map<CallKind, number>();
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as Item;
    const kind = kindOf(body);
    const n = (counts.get(kind) ?? 0) + 1;
    counts.set(kind, n);
    seen.push({ url: String(input), headers: new Headers(init?.headers), body, kind });
    const intercepted = await script.intercept?.(kind, init?.signal ?? undefined);
    if (intercepted) return intercepted;
    const requestId: Record<string, string> =
      protocol === 'chat' ? { 'x-amzn-requestid': `req-${kind}-${n}` } : { 'apim-request-id': `apim-${kind}-${n}` };
    if (script.unauthorized)
      return jsonAnswer({ error: { message: 'The key was not accepted.', code: 'invalid_api_key' } }, 401, requestId);
    if (kind === 'cache-off' && script.cacheOff === 'refused')
      return jsonAnswer(
        { error: { message: 'Unrecognized request argument supplied: prompt_cache_options', code: 'invalid_request_error' } },
        400,
        requestId,
      );
    const answer = answerOf(kind, n, script);
    const u = answer.usage;
    if (protocol === 'chat')
      return sseResponse(
        chatEvents({
          id: `chatcmpl-${kind}-${n}`,
          model: reportedModel,
          text: answer.text,
          toolCalls: answer.tool ? [{ id: 'call_lookup_1', name: 'lookup_fact', arguments: '{"key":"alpha"}' }] : undefined,
          finishReason: answer.incomplete ? 'length' : undefined,
          usage: {
            prompt_tokens: u.input,
            completion_tokens: u.output,
            total_tokens: u.input + u.output,
            prompt_tokens_details: { cached_tokens: u.read ?? 0, cache_write_tokens: u.write ?? 0 },
            completion_tokens_details: { reasoning_tokens: u.reasoning ?? 0 },
          },
        }),
        requestId,
      );
    const output: Item[] = [{ type: 'reasoning', id: `rs_${kind}_${n}`, summary: [], encrypted_content: 'enc-azure' }];
    if (answer.tool)
      output.push({ type: 'function_call', id: 'fc_lookup_1', call_id: 'call_lookup_1', name: 'lookup_fact', arguments: '{"key":"alpha"}', status: 'completed' });
    else if (!answer.incomplete)
      output.push({
        type: 'message',
        id: `msg_${kind}_${n}`,
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_text', text: answer.text, annotations: [] }],
      });
    return sseResponse(
      responsesEvents({
        id: `resp_${kind}_${n}`,
        object: 'response',
        created_at: 1_790_000_000,
        status: answer.incomplete ? 'incomplete' : 'completed',
        model: reportedModel,
        output,
        usage: {
          input_tokens: u.input,
          input_tokens_details: { cached_tokens: u.read ?? 0, cache_write_tokens: u.write ?? 0 },
          output_tokens: u.output,
          output_tokens_details: { reasoning_tokens: u.reasoning ?? 0 },
          total_tokens: u.input + u.output,
        },
        incomplete_details: answer.incomplete ? { reason: 'max_output_tokens' } : null,
        error: null,
      }),
      requestId,
    );
  }) as typeof globalThis.fetch;
  return { fetch, seen };
}
