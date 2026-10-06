import { z } from 'zod';
import { ModelApiError, type StreamSinks } from './model-api-core.js';

const refused = (message: string) => new ModelApiError('bonsai_refused', message, true);
const progressSchema = z.object({
  total: z.number().int().nonnegative(), cache: z.number().int().nonnegative(),
  processed: z.number().int().nonnegative(), time_ms: z.number().nonnegative(),
}).refine(value => value.cache <= value.processed && value.processed <= value.total);
const chunkSchema = z.object({
  id: z.string().min(1), model: z.string().min(1),
  choices: z.array(z.object({
    index: z.literal(0), finish_reason: z.string().nullish(),
    delta: z.object({
      role: z.literal('assistant').optional(),
      content: z.string().nullish(), reasoning_content: z.string().nullish(),
      tool_calls: z.array(z.object({
        index: z.literal(0), id: z.string().optional(), type: z.literal('function').optional(),
        function: z.object({ name: z.string().optional(), arguments: z.string().optional() }),
      })).max(1).optional(),
    }).optional(),
  })).max(1),
  usage: z.unknown().optional(), timings: z.unknown().optional(),
  prompt_progress: progressSchema.optional(),
});

/** Reads llama.cpp's OpenAI stream; only the caller may accept the rebuilt final answer. */
export async function readLocalStream(input: {
  url: string; body: unknown; model: string; signal: AbortSignal; transport: typeof fetch;
  maxResponseBytes: number; idleTimeoutMs?: number;
} & StreamSinks): Promise<unknown> {
  const idle = new AbortController();
  const signal = AbortSignal.any([input.signal, idle.signal]);
  let timer: ReturnType<typeof setTimeout>;
  const moving = () => {
    clearTimeout(timer);
    timer = setTimeout(() => idle.abort(refused('The local model stopped making progress. Its answer was not used.')),
      input.idleTimeoutMs ?? 60_000);
    timer.unref?.();
  };
  moving();
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  const cancel = () => { void reader?.cancel().catch(() => undefined); };
  try {
    signal.throwIfAborted();
    const response = await input.transport(input.url, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input.body), redirect: 'error', signal });
    if (response.redirected || (response.status >= 300 && response.status < 400)) {
      await response.body?.cancel();
      throw refused('The local model returned a redirect.');
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw refused(`The local model returned HTTP ${response.status}. Check its logs.`);
    }
    if (!response.headers.get('content-type')?.toLowerCase().startsWith('text/event-stream')) {
      await response.body?.cancel();
      throw refused('The local model did not return an answer stream. Its answer was not used.');
    }
    reader = response.body?.getReader();
    if (!reader) throw refused('The local model returned no response.');
    signal.addEventListener('abort', cancel, { once: true });
    const decoder = new TextDecoder('utf-8', { fatal: true });
    let pending = '', bytes = 0, id = '', content = '', reasoning = '', finish: string | undefined;
    let usage: unknown, timings: unknown, done = false, announced = false;
    let tool: { id: string; type: 'function'; function: { name: string; arguments: string } } | undefined;
    const event = (frame: string) => {
      const data = frame.split(/\r?\n/).filter(line => line.startsWith('data:'))
        .map(line => line.slice(5).replace(/^ /, '')).join('\n');
      if (!data) return; // SSE comments and pings are not model progress.
      if (done) throw refused('The local model sent data after its stream ended.');
      if (data === '[DONE]') { done = true; return; }
      let raw: unknown;
      try { raw = JSON.parse(data); }
      catch { throw refused('The local model returned an invalid stream event.'); }
      const parsed = chunkSchema.safeParse(raw);
      if (!parsed.success) throw refused('The local model returned an invalid stream event.');
      const chunk = parsed.data;
      if (chunk.model !== input.model || (id && chunk.id !== id))
        throw refused('The local model stream changed the selected model or answer. Its answer was not used.');
      id = chunk.id;
      if (chunk.prompt_progress) {
        if (finish) throw refused('The local model sent progress after its answer finished.');
        moving(); input.onPromptProgress?.(chunk.prompt_progress);
      }
      const choice = chunk.choices[0];
      if (choice) {
        if (finish) throw refused('The local model sent another answer after finishing.');
        const delta = choice.delta;
        if (delta?.content) { content += delta.content; moving(); input.onDelta?.(delta.content); }
        if (delta?.reasoning_content) { reasoning += delta.reasoning_content; moving(); input.onReasoningDelta?.(delta.reasoning_content); }
        const part = delta?.tool_calls?.[0];
        if (part) {
          tool ??= { id: '', type: 'function', function: { name: '', arguments: '' } };
          if (tool.id && part.id) throw refused('The local model returned more than one tool header.');
          tool.id += part.id ?? '';
          tool.function.name += part.function.name ?? '';
          tool.function.arguments += part.function.arguments ?? '';
          if (part.id || part.function.name || part.function.arguments) moving();
          if (!announced && tool.id && tool.function.name) {
            announced = true;
            input.onToolActivity?.({ callId: tool.id, tool: tool.function.name, phase: 'started', summary: tool.function.name });
          }
        }
        if (choice.finish_reason) finish = choice.finish_reason;
      }
      // b11146's include_usage event has empty choices, after the finish event.
      if (chunk.usage !== undefined && chunk.usage !== null) {
        if (!finish) throw refused('The local model reported final accounting before finishing.');
        usage = chunk.usage;
      }
      if (finish && chunk.timings !== undefined) timings = chunk.timings;
    };
    for (;;) {
      signal.throwIfAborted();
      const next = await reader.read();
      signal.throwIfAborted();
      if (next.done) {
        pending += decoder.decode();
        break;
      }
      bytes += next.value.length;
      if (bytes > input.maxResponseBytes) throw refused('The local model returned more data than this request allows.');
      pending += decoder.decode(next.value, { stream: true });
      let boundary: RegExpExecArray | null;
      while ((boundary = /\r?\n\r?\n/.exec(pending))) {
        event(pending.slice(0, boundary.index));
        pending = pending.slice(boundary.index + boundary[0].length);
      }
      if (done) break;
    }
    if (!done || !finish || pending.trim()) throw refused('The local model stream ended before a complete answer. Its answer was not used.');
    if ((tool && finish !== 'tool_calls') || (!tool && finish === 'tool_calls'))
      throw refused('The local model stream did not finish the answer it started.');
    return { id, model: input.model, usage, timings,
      choices: [{ finish_reason: finish, message: { content, reasoning_content: reasoning,
        ...(tool ? { tool_calls: [tool] } : {}) } }] };
  } finally {
    clearTimeout(timer!);
    signal.removeEventListener('abort', cancel);
    if (reader) {
      await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
  }
}
