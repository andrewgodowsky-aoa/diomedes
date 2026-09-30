/** Bounded, pull-driven provider stream conversion into the existing Responses boundary. */
import type { ManagedProtocol } from '../../../shared/routing-policy.js';

type ObjectValue = Record<string, unknown>;
const object = (value: unknown): ObjectValue => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as ObjectValue : {};
const list = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
const text = (value: unknown): string => typeof value === 'string' ? value : '';
const number = (value: unknown): number | undefined => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
const MAX_FRAME = 1_048_576;
const MAX_OUTPUT = 4_194_304;

/** Preserve JSON values while ignoring object key insertion order. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(entry => canonicalJson(entry === undefined ? null : entry)).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = value as ObjectValue;
    return `{${Object.keys(entries).filter(key => entries[key] !== undefined).sort()
      .map(key => `${JSON.stringify(key)}:${canonicalJson(entries[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export class BindingError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = 'BindingError'; }
}

/** SSE supports CRLF, chunked UTF-8 and multiline data. Unterminated frames are failures. */
export async function* sseObjects(body: ReadableStream<Uint8Array>): AsyncGenerator<ObjectValue> {
  const reader = body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let buffer = '';
  let data: string[] = [];
  let held = 0;
  let completed = false;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      let end: number;
      while ((end = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, end).replace(/\r$/, '');
        buffer = buffer.slice(end + 1);
        if (line === '') {
          if (data.length) {
            const raw = data.join('\n'); data = []; held = 0;
            if (raw === '[DONE]') return;
            else {
              let parsed: unknown;
              try { parsed = JSON.parse(raw); } catch { throw new BindingError('invalid_stream', 'The provider sent an invalid event.'); }
              if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new BindingError('invalid_stream', 'The provider event was not an object.');
              yield object(parsed);
            }
          }
        } else if (line.startsWith('data:')) {
          const value = line.slice(5).replace(/^ /, ''); held += value.length;
          if (held > MAX_FRAME) throw new BindingError('stream_limit', 'The provider stream exceeded its frame limit.');
          data.push(value);
        }
      }
      if (buffer.length > MAX_FRAME) throw new BindingError('stream_limit', 'The provider stream exceeded its frame limit.');
      if (done) { completed = true; break; }
    }
    if (buffer.trim() || data.length) throw new BindingError('incomplete_stream', 'The provider stream ended during an event.');
  } finally {
    if (!completed) await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** AWS event-stream frames carry lengths and two CRCs; no unbounded buffering or SDK retry. */
export async function* awsEvents(body: ReadableStream<Uint8Array>, messages: boolean): AsyncGenerator<ObjectValue> {
  const reader = body.getReader();
  let buffer = new Uint8Array(0);
  let completed = false;
  const decoder = new TextDecoder('utf-8', { fatal: true });
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) { completed = true; break; }
      const joined = new Uint8Array(buffer.length + value.length); joined.set(buffer); joined.set(value, buffer.length); buffer = joined;
      while (buffer.length >= 12) {
        const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
        const size = view.getUint32(0); const headersSize = view.getUint32(4);
        if (size < 16 || size > MAX_FRAME || headersSize > size - 16 || view.getUint32(8) !== crc32(buffer.subarray(0, 8)))
          throw new BindingError('invalid_stream', 'The AWS event prelude is invalid.');
        if (buffer.length < size) break;
        const frame = buffer.slice(0, size); buffer = buffer.slice(size);
        if (new DataView(frame.buffer).getUint32(size - 4) !== crc32(frame.subarray(0, size - 4)))
          throw new BindingError('invalid_stream', 'The AWS event checksum is invalid.');
        const headers: Record<string, string> = {};
        let cursor = 12;
        while (cursor < 12 + headersSize) {
          const length = frame[cursor++];
          const name = decoder.decode(frame.subarray(cursor, cursor + length)); cursor += length;
          if (frame[cursor++] !== 7 || cursor + 2 > 12 + headersSize) throw new BindingError('invalid_stream', 'The AWS event header is invalid.');
          const valueLength = (frame[cursor] << 8) | frame[cursor + 1]; cursor += 2;
          if (cursor + valueLength > 12 + headersSize) throw new BindingError('invalid_stream', 'The AWS event header is truncated.');
          headers[name] = decoder.decode(frame.subarray(cursor, cursor + valueLength)); cursor += valueLength;
        }
        if (headers[':message-type'] === 'exception' || headers[':message-type'] === 'error')
          throw new BindingError('provider_stream_error', 'The AWS model ended the stream with an error.');
        let parsed: unknown;
        try { parsed = JSON.parse(decoder.decode(frame.subarray(12 + headersSize, size - 4))); }
        catch { throw new BindingError('invalid_stream', 'The AWS event body is invalid.'); }
        const value = object(parsed);
        if (messages) {
          const bytes = text(value.bytes);
          if (!bytes) throw new BindingError('invalid_stream', 'The AWS Messages event has no payload.');
          let decoded: unknown;
          try { decoded = JSON.parse(decoder.decode(Uint8Array.from(atob(bytes), c => c.charCodeAt(0)))); }
          catch { throw new BindingError('invalid_stream', 'The AWS Messages payload is invalid.'); }
          yield object(decoded);
        } else yield { ...value, type: headers[':event-type'] };
      }
      if (buffer.length > MAX_FRAME) throw new BindingError('stream_limit', 'The AWS event exceeded its frame limit.');
    }
    if (buffer.length) throw new BindingError('incomplete_stream', 'The AWS stream ended during an event.');
  } finally {
    if (!completed) await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

interface Usage {
  input_tokens?: number; output_tokens?: number;
  cost?: unknown;
  input_tokens_details?: { cached_tokens: number; cache_write_tokens: number };
  output_tokens_details?: { reasoning_tokens: number };
}
interface Tool { id: string; name: string; arguments: string; index: number }
export interface NormalizeOptions {
  protocol: ManagedProtocol;
  model: string;
  /** OpenRouter must attribute the served endpoint, not merely the requested provider. */
  upstreamEndpoint: string | null;
  upstreamName?: string;
  requestId: string | null;
  awsBinary?: boolean;
  servedModels: readonly string[];
  seal?: (checkpoint: NativeCheckpoint) => Promise<string>;
  cancel?: () => void;
  complete?: () => void;
}
export interface NativeCheckpoint { protocol: ManagedProtocol; parts: ObjectValue[]; answer: string; tools: { id: string; name: string; arguments: string }[] }

/** OpenRouter emits its authoritative routing metadata only on the final chunk.
 * Buffer this bounded response before releasing text or executable tool calls.
 * The request already pins one exact endpoint tag; the result must report one
 * matching candidate, one attempt, company payment and no server-side transforms.
 * Display names alone never stand in for regional ingress or privacy evidence.
 */
async function* verifiedOpenRouterEvents(body: ReadableStream<Uint8Array>, options: NormalizeOptions) {
  const held: ObjectValue[] = []; let bytes = 0; let metadata: ObjectValue | null = null;
  for await (const event of sseObjects(body)) {
    bytes += JSON.stringify(event).length;
    if (bytes > MAX_OUTPUT * 4) throw new BindingError('stream_limit', 'The provider response exceeded its attribution buffer.');
    if (event.provider !== undefined && event.provider !== options.upstreamName)
      throw new BindingError('served_endpoint_mismatch', 'OpenRouter reported an unauthorized downstream provider.');
    if (event.openrouter_metadata !== undefined) {
      if (metadata) throw new BindingError('served_endpoint_unverified', 'OpenRouter returned inconsistent routing metadata.');
      metadata = object(event.openrouter_metadata);
    }
    held.push(event);
  }
  if (!metadata || !options.upstreamName) throw new BindingError('served_endpoint_unverified', 'OpenRouter did not identify the served route.');
  const endpoints = object(metadata.endpoints), candidates = list(endpoints.available).map(object);
  const matches = (e: ObjectValue) => e.provider === options.upstreamName && options.servedModels.includes(text(e.model));
  if (metadata.requested !== options.model || metadata.strategy !== 'direct' || metadata.attempt !== 1 ||
      endpoints.total !== 1 || candidates.length !== 1 || candidates[0].selected !== true || !matches(candidates[0]) ||
      (metadata.attempts !== undefined && (list(metadata.attempts).length !== 1 || !matches(object(list(metadata.attempts)[0])) || object(list(metadata.attempts)[0]).status !== 200)))
    throw new BindingError('served_endpoint_mismatch', 'OpenRouter did not confirm the single approved downstream route.');
  if (metadata.is_byok !== false) throw new BindingError('payer_mismatch', 'OpenRouter did not confirm company payment.');
  if (list(metadata.pipeline).some(p => object(p).type !== 'guardrail'))
    throw new BindingError('provider_transform_unverified', 'OpenRouter applied an unapproved server-side transformation.');
  for (const event of held) yield event;
}

/** Each output event is a Responses SSE event consumed by the existing desktop SDK and funding tap. */
async function* normalizedEvents(response: Response, options: NormalizeOptions): AsyncGenerator<ObjectValue> {
  if (!response.body) throw new BindingError('empty_stream', 'The provider returned no stream.');
  const events = options.awsBinary ? awsEvents(response.body, options.protocol === 'messages')
    : options.upstreamEndpoint !== null ? verifiedOpenRouterEvents(response.body, options) : sseObjects(response.body);
  const tools = new Map<number, Tool>();
  const createdAt = Math.floor(Date.now() / 1000);
  let answer = ''; let refusal = ''; let finished = false; let id = options.requestId;
  let usage: Usage | null = null; let stop = '';
  let started = false; let textStarted = false; let held = 0; let nativeBytes = 0;
  const native = new Map<number, ObjectValue>(); let hasNative = false;
  const output = () => [
    ...(answer || refusal ? [{ id: 'msg_managed', type: 'message', role: 'assistant', status: 'completed', content: refusal
      ? [{ type: 'refusal', refusal }] : [{ type: 'output_text', text: answer, annotations: [] }] }] : []),
    ...[...tools.values()].map(t => ({ id: `fc_${t.index}`, type: 'function_call', status: 'completed', call_id: t.id, name: t.name, arguments: t.arguments })),
  ];
  for await (const event of events) {
    // Includes hidden thinking, signatures and fragmented tool state. These bytes are
    // retained only for a sealed continuation and are bounded just like visible output.
    nativeBytes += JSON.stringify(event).length;
    if (nativeBytes > MAX_OUTPUT * 4) throw new BindingError('stream_limit', 'The provider continuation exceeded its limit.');
    if (event.error || event.type === 'error') throw new BindingError('provider_stream_error', 'The provider reported a stream error.');
    const servedModel = text(event.model) || text(object(event.message).model) || text(event.modelVersion);
    if (servedModel && !options.servedModels.includes(servedModel)) throw new BindingError('served_model_mismatch', 'The provider reported an unapproved model/version.');
    if (object(event.usage).is_byok === true || event.is_byok === true) throw new BindingError('payer_mismatch', 'The provider reported a different payer.');
    id = text(event.id) || text(object(event.message).id) || id;
    const shell = { id: id ?? 'resp_managed', object: 'response', created_at: createdAt, model: options.model, error: null, incomplete_details: null };
    if (!started) { started = true; yield { type: 'response.created', response: { ...shell, status: 'in_progress', output: [], usage: null } }; }
    let delta = ''; let toolIndex: number | undefined; let toolId = ''; let toolName = ''; let toolArgs = '';
    if (options.protocol === 'chat-completions') {
      const choice = object(list(event.choices)[0]); const d = object(choice.delta);
      delta = text(d.content); refusal += text(d.refusal);
      for (const raw of list(d.tool_calls)) {
        const item = object(raw); const fn = object(item.function); const index = number(item.index) ?? 0;
        const existing = tools.get(index);
        if (!existing) {
          if (tools.size) throw new BindingError('parallel_tools', 'This managed route supports one tool call per turn.');
          if (!text(item.id) || !text(fn.name)) throw new BindingError('invalid_tool_stream', 'The provider tool call has no identity.');
          const t = { id: text(item.id), name: text(fn.name), arguments: '', index: index + 1 };
          tools.set(index, t);
          yield { type: 'response.output_item.added', output_index: t.index, item: { id: `fc_${t.index}`, type: 'function_call', status: 'in_progress', call_id: t.id, name: t.name, arguments: '' } };
        }
        const t = tools.get(index)!; t.arguments += text(fn.arguments); held += text(fn.arguments).length;
        if (text(fn.arguments)) yield { type: 'response.function_call_arguments.delta', item_id: `fc_${t.index}`, output_index: t.index, delta: text(fn.arguments) };
      }
      if (choice.finish_reason !== undefined && choice.finish_reason !== null) { stop = text(choice.finish_reason); finished = true; }
      if (event.usage) {
        const u = object(event.usage); const i = object(u.prompt_tokens_details); const o = object(u.completion_tokens_details);
        usage = { input_tokens: number(u.prompt_tokens), output_tokens: number(u.completion_tokens),
          ...(u.cost !== undefined ? { cost: u.cost } : {}),
          input_tokens_details: { cached_tokens: number(i.cached_tokens) ?? 0, cache_write_tokens: number(i.cache_write_tokens) ?? 0 },
          output_tokens_details: { reasoning_tokens: number(o.reasoning_tokens) ?? 0 } };
      }
      if (stop === 'content_filter') refusal ||= 'The model refused this request.';
    } else if (options.protocol === 'messages') {
      const d = object(event.delta); const block = object(event.content_block);
      if (event.type === 'message_start') {
        const u = object(object(event.message).usage);
        const cached = number(u.cache_read_input_tokens) ?? 0; const written = number(u.cache_creation_input_tokens) ?? 0;
        usage = { input_tokens: number(u.input_tokens) === undefined ? undefined : Number(u.input_tokens) + cached + written,
          input_tokens_details: { cached_tokens: cached, cache_write_tokens: written }, output_tokens_details: { reasoning_tokens: 0 } };
      }
      if (event.type === 'content_block_start' && block.type === 'tool_use') {
        toolIndex = number(event.index) ?? 0; toolId = text(block.id); toolName = text(block.name);
      }
      if (event.type === 'content_block_start') {
        native.set(number(event.index) ?? 0, { ...block });
        if (block.type === 'thinking' || block.type === 'redacted_thinking') hasNative = true;
      }
      if (event.type === 'content_block_delta') {
        if (d.type === 'text_delta') delta = text(d.text);
        if (d.type === 'input_json_delta') { toolIndex = number(event.index) ?? 0; toolArgs = text(d.partial_json); }
        const n = native.get(number(event.index) ?? 0);
        if (n && d.type === 'text_delta') n.text = text(n.text) + text(d.text);
        if (n && d.type === 'input_json_delta') n.partial = text(n.partial) + text(d.partial_json);
        if (n && (d.type === 'thinking_delta' || d.type === 'signature_delta')) {
          hasNative = true;
          const key = d.type === 'thinking_delta' ? 'thinking' : 'signature'; n[key] = text(n[key]) + text(d[key]);
        }
      }
      if (event.type === 'message_delta') {
        stop = text(d.stop_reason); if (stop === 'refusal') refusal ||= 'The model refused this request.';
        usage = { ...usage, output_tokens: number(object(event.usage).output_tokens) };
      }
      if (event.type === 'message_stop') finished = true;
    } else if (options.protocol === 'converse') {
      const d = object(event.delta); const start = object(object(event.start).toolUse); const tool = object(d.toolUse);
      if (event.type === 'contentBlockStart' && Object.keys(start).length) {
        toolIndex = number(event.contentBlockIndex) ?? 0; toolId = text(start.toolUseId); toolName = text(start.name);
        native.set(toolIndex, { toolUse: { ...start }, partial: '' });
      }
      if (event.type === 'contentBlockDelta') {
        delta = text(d.text);
        if (Object.keys(tool).length) { toolIndex = number(event.contentBlockIndex) ?? 0; toolArgs = text(tool.input); }
        const index = number(event.contentBlockIndex) ?? 0, n = native.get(index) ?? {};
        if (delta) n.text = text(n.text) + delta;
        if (tool.input) n.partial = text(n.partial) + text(tool.input);
        if (d.reasoningContent) {
          hasNative = true; const r = object(d.reasoningContent), previous = object(n.reasoningContent);
          n.reasoningContent = { ...previous, text: text(previous.text) + text(r.text), signature: text(previous.signature) + text(r.signature), ...(r.redactedContent ? { redactedContent: r.redactedContent } : {}) };
        }
        native.set(index, n);
      }
      if (event.type === 'messageStop') { finished = true; stop = text(event.stopReason); if (['guardrail_intervened', 'content_filtered'].includes(stop)) refusal ||= 'The model refused this request.'; }
      if (event.type === 'metadata') {
        const u = object(event.usage); const cached = number(u.cacheReadInputTokens) ?? 0; const written = number(u.cacheWriteInputTokens) ?? 0;
        usage = { input_tokens: number(u.inputTokens), output_tokens: number(u.outputTokens),
          input_tokens_details: { cached_tokens: cached, cache_write_tokens: written }, output_tokens_details: { reasoning_tokens: 0 } };
      }
    } else if (options.protocol === 'generate-content') {
      const candidate = object(list(event.candidates)[0]);
      for (const raw of list(object(candidate.content).parts)) {
        const part = object(raw);
        if (part.thoughtSignature) hasNative = true;
        native.set(native.size, { ...part });
        if (part.thought !== true) delta += text(part.text);
        if (part.functionCall) {
          const call = object(part.functionCall); toolIndex = 0; toolId = text(call.id) || 'vertex_tool_0'; toolName = text(call.name);
          toolArgs = JSON.stringify(call.args ?? {});
        }
      }
      if (candidate.finishReason) { finished = true; stop = text(candidate.finishReason); }
      if (['SAFETY', 'RECITATION', 'PROHIBITED_CONTENT', 'BLOCKLIST'].includes(stop) || object(event.promptFeedback).blockReason)
        { refusal ||= 'The model refused this request.'; finished = true; }
      if (event.usageMetadata) {
        const u = object(event.usageMetadata); const reasoning = number(u.thoughtsTokenCount) ?? 0;
        usage = { input_tokens: number(u.promptTokenCount),
          output_tokens: number(u.candidatesTokenCount) === undefined ? undefined : Number(u.candidatesTokenCount) + reasoning,
          input_tokens_details: { cached_tokens: number(u.cachedContentTokenCount) ?? 0, cache_write_tokens: 0 },
          output_tokens_details: { reasoning_tokens: reasoning } };
      }
    }
    if (toolIndex !== undefined) {
      let t = tools.get(toolIndex);
      if (!t) {
        if (!toolId || !toolName || tools.size) throw new BindingError('invalid_tool_stream', 'The provider tool call has no valid unique identity.');
        t = { id: toolId, name: toolName, arguments: '', index: toolIndex + 1 }; tools.set(toolIndex, t);
        yield { type: 'response.output_item.added', output_index: t.index, item: { id: `fc_${t.index}`, type: 'function_call', status: 'in_progress', call_id: t.id, name: t.name, arguments: '' } };
      }
      t.arguments += toolArgs; held += toolArgs.length;
      if (toolArgs) yield { type: 'response.function_call_arguments.delta', item_id: `fc_${t.index}`, output_index: t.index, delta: toolArgs };
    }
    if (delta) {
      if (!textStarted) {
        textStarted = true;
        yield { type: 'response.output_item.added', output_index: 0, item: { id: 'msg_managed', type: 'message', role: 'assistant', status: 'in_progress', content: [] } };
        yield { type: 'response.content_part.added', output_index: 0, content_index: 0, item_id: 'msg_managed', part: { type: 'output_text', text: '', annotations: [] } };
      }
      answer += delta; held += delta.length;
      yield { type: 'response.output_text.delta', output_index: 0, content_index: 0, item_id: 'msg_managed', delta };
    }
    if (held > MAX_OUTPUT || refusal.length > MAX_FRAME) throw new BindingError('stream_limit', 'The provider output exceeded its limit.');
  }
  if (!finished) throw new BindingError('incomplete_stream', 'The provider stream ended without a final outcome.');
  if (!id) throw new BindingError('receipt_missing', 'The provider named no request or response receipt.');
  if (textStarted) yield { type: 'response.output_text.done', output_index: 0, content_index: 0, item_id: 'msg_managed', text: answer };
  const finalOutput: ObjectValue[] = output();
  for (const item of output()) yield { type: 'response.output_item.done', output_index: item.type === 'message' ? 0 : Number(item.id.slice(3)), item };
  if (hasNative) {
    if (!options.seal) throw new BindingError('nonportable_continuation', 'This route cannot preserve its native continuation.');
    const parts = [...native.entries()].sort(([a], [b]) => a - b).map(([, n]) => {
      if (options.protocol === 'messages' && n.type === 'tool_use') { const { partial, ...rest } = n; return { ...rest, input: partial ? JSON.parse(text(partial)) : n.input ?? {} }; }
      if (options.protocol === 'converse' && n.toolUse) return { toolUse: { ...object(n.toolUse), input: JSON.parse(text(n.partial) || '{}') } };
      if (options.protocol === 'converse' && n.reasoningContent) {
        const r = object(n.reasoningContent);
        return { reasoningContent: r.redactedContent ? { redactedContent: r.redactedContent } : { reasoningText: { text: r.text, signature: r.signature } } };
      }
      return n;
    });
    const encrypted = await options.seal({ protocol: options.protocol, parts, answer, tools: [...tools.values()] });
    const item = { type: 'reasoning', id: 'rs_managed_checkpoint', summary: [], encrypted_content: encrypted };
    yield { type: 'response.output_item.added', output_index: 1024, item: { ...item, encrypted_content: null } };
    yield { type: 'response.output_item.done', output_index: 1024, item };
    finalOutput.push(item);
  }
  const incomplete = ['length', 'max_tokens', 'max_token', 'MAX_TOKENS'].includes(stop);
  yield { type: incomplete ? 'response.incomplete' : 'response.completed', response: {
    id, object: 'response', model: options.model, status: incomplete ? 'incomplete' : 'completed',
    error: null, incomplete_details: incomplete ? { reason: 'max_output_tokens' } : null, output: finalOutput, usage,
  } };
}

export function normalizeProviderResponse(response: Response, options: NormalizeOptions): Response {
  if (!response.ok) return response;
  const iterator = options.protocol === 'responses' ? checkedResponses(response, options) : normalizedEvents(response, options);
  const encoder = new TextEncoder();
  let sequence = 0;
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await iterator.next();
        if (next.done) { options.complete?.(); controller.close(); }
        else controller.enqueue(encoder.encode(`event: ${String(next.value.type)}\ndata: ${JSON.stringify({ ...next.value, sequence_number: sequence++ })}\n\n`));
      } catch (error) {
        options.cancel?.(); options.complete?.();
        await iterator.return(undefined);
        controller.error(error);
      }
    },
    async cancel() { options.cancel?.(); options.complete?.(); await iterator.return(undefined); },
  });
  const headers = new Headers(response.headers);
  headers.set('content-type', 'text/event-stream'); headers.delete('content-length'); headers.delete('content-encoding');
  return new Response(stream, { status: response.status, headers });
}

/** Even an API-compatible upstream must identify the configured model. Never forward an error body. */
async function* checkedResponses(response: Response, options: NormalizeOptions): AsyncGenerator<ObjectValue> {
  if (!response.body) throw new BindingError('empty_stream', 'The provider returned no stream.');
  let terminal = false;
  for await (const event of sseObjects(response.body)) {
    const result = object(event.response);
    const model = text(result.model);
    if (model && !options.servedModels.includes(model)) throw new BindingError('served_model_mismatch', 'The provider reported an unapproved model/version.');
    if (event.type === 'error' || event.type === 'response.failed') throw new BindingError('provider_stream_error', 'The provider reported a stream error.');
    if (event.type === 'response.completed' || event.type === 'response.incomplete') terminal = true;
    if (options.seal) {
      // Provider-native ciphertext is itself bound to this route before the desktop persists it.
      const sealItem = async (value: unknown) => {
        const item = object(value);
        return item.type === 'reasoning' && typeof item.encrypted_content === 'string'
          ? { ...item, encrypted_content: await options.seal!({ protocol: 'responses', parts: [item], answer: '', tools: [] }) } : item;
      };
      if (event.item) event.item = await sealItem(event.item);
      if (Array.isArray(result.output)) result.output = await Promise.all(result.output.map(sealItem));
    }
    yield event;
  }
  if (!terminal) throw new BindingError('incomplete_stream', 'The provider stream ended without a final outcome.');
}
