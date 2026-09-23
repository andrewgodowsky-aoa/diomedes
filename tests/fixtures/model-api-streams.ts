/**
 * Captured-shape provider streams for the model-API route tests. Each helper
 * turns a whole answer into the server-sent events the real provider sends for
 * it, so the real SDK parses the same bytes it would in production. Nothing
 * here reaches a network.
 */

type Item = Record<string, unknown>;

const frame = (event: unknown) => `data: ${JSON.stringify(event)}\n\n`;

/**
 * A Responses API answer (AWS Bedrock runtime, Azure OpenAI v1) as its stream:
 * `response.created`, each output item added / delta / done, then the terminal
 * event carrying the whole response. `terminal` defaults from the response's
 * own status.
 */
export function responsesEvents(response: Item, options: { terminal?: string; split?: number } = {}): string {
  let seq = 0;
  const next = () => ++seq;
  const created = {
    id: String(response.id ?? 'resp_x'),
    object: 'response',
    created_at: Number(response.created_at ?? 1_790_000_000),
    model: String(response.model ?? 'unknown'),
    status: 'in_progress',
    output: [],
  };
  let out = frame({ type: 'response.created', sequence_number: next(), response: created });
  out += frame({ type: 'response.in_progress', sequence_number: next(), response: created });
  const output = Array.isArray(response.output) ? (response.output as Item[]) : [];
  output.forEach((raw, index) => {
    const id = String(raw.id ?? `item_${index}`);
    const item: Item = { ...raw, id };
    if (item.type === 'message') {
      out += frame({
        type: 'response.output_item.added',
        sequence_number: next(),
        output_index: index,
        item: { type: 'message', id, role: 'assistant', status: 'in_progress', content: [] },
      });
      const content = Array.isArray(item.content) ? (item.content as Item[]) : [];
      content.forEach((part, contentIndex) => {
        if (part.type !== 'output_text' || typeof part.text !== 'string') return;
        const size = options.split ?? 4;
        for (let at = 0; at < part.text.length; at += size)
          out += frame({
            type: 'response.output_text.delta',
            sequence_number: next(),
            item_id: id,
            output_index: index,
            content_index: contentIndex,
            delta: part.text.slice(at, at + size),
            logprobs: [],
          });
      });
      out += frame({ type: 'response.output_item.done', sequence_number: next(), output_index: index, item });
    } else if (item.type === 'function_call') {
      out += frame({
        type: 'response.output_item.added',
        sequence_number: next(),
        output_index: index,
        item: { ...item, arguments: '', status: 'in_progress' },
      });
      out += frame({
        type: 'response.function_call_arguments.delta',
        sequence_number: next(),
        item_id: id,
        output_index: index,
        delta: String(item.arguments ?? ''),
      });
      out += frame({
        type: 'response.function_call_arguments.done',
        sequence_number: next(),
        item_id: id,
        output_index: index,
        arguments: String(item.arguments ?? ''),
      });
      out += frame({ type: 'response.output_item.done', sequence_number: next(), output_index: index, item });
    } else {
      out += frame({ type: 'response.output_item.added', sequence_number: next(), output_index: index, item });
      out += frame({ type: 'response.output_item.done', sequence_number: next(), output_index: index, item });
    }
  });
  const terminal =
    options.terminal ??
    (response.status === 'incomplete'
      ? 'response.incomplete'
      : response.status === 'failed'
        ? 'response.failed'
        : 'response.completed');
  out += frame({ type: terminal, sequence_number: next(), response });
  return out;
}

export const sseResponse = (text: string, headers: Record<string, string> = {}, status = 200) =>
  new Response(text, { status, headers: { 'content-type': 'text/event-stream', ...headers } });

/**
 * A plain JSON body stays JSON (an error answer); a Responses object becomes
 * its event stream, which is what a `stream: true` request receives.
 */
export function responsesAnswer(body: unknown, status: number, headers: Record<string, string>) {
  const object = body && typeof body === 'object' && !Array.isArray(body) ? (body as Item) : null;
  if (status < 400 && object?.object === 'response') return sseResponse(responsesEvents(object), headers, status);
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}

/**
 * An OpenRouter chat completion as its stream: role, content deltas, one
 * tool-call delta per call, the finish reason, then the usage chunk that
 * `stream_options.include_usage` adds.
 */
export function chatEvents(answer: {
  id?: string;
  model: string;
  provider?: string;
  text?: string;
  toolCalls?: { id: string; name: string; arguments: string }[];
  finishReason?: string | null;
  usage?: Item | null;
  refusal?: string;
  split?: number;
}): string {
  const base = { id: answer.id ?? 'gen-1', object: 'chat.completion.chunk', created: 1_790_000_000, model: answer.model, ...(answer.provider ? { provider: answer.provider } : {}) };
  let out = frame({ ...base, choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] });
  const text = answer.text ?? '';
  const size = answer.split ?? 4;
  for (let at = 0; at < text.length; at += size)
    out += frame({ ...base, choices: [{ index: 0, delta: { content: text.slice(at, at + size) }, finish_reason: null }] });
  if (answer.refusal)
    out += frame({ ...base, choices: [{ index: 0, delta: { refusal: answer.refusal }, finish_reason: null }] });
  (answer.toolCalls ?? []).forEach((call, index) => {
    out += frame({
      ...base,
      choices: [
        {
          index: 0,
          delta: { tool_calls: [{ index, id: call.id, type: 'function', function: { name: call.name, arguments: call.arguments } }] },
          finish_reason: null,
        },
      ],
    });
  });
  if (answer.finishReason !== null)
    out += frame({
      ...base,
      choices: [{ index: 0, delta: {}, finish_reason: answer.finishReason ?? (answer.toolCalls?.length ? 'tool_calls' : 'stop') }],
    });
  if (answer.usage !== null)
    out += frame({ ...base, choices: [], usage: answer.usage ?? undefined });
  out += 'data: [DONE]\n\n';
  return out;
}
