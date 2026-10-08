import { afterEach, describe, expect, it, vi } from 'vitest';
import { readLocalStream } from '../server/engines/local-stream.js';

const frame = (value: unknown) => `data: ${JSON.stringify(value)}\r\n\r\n`;
const chunk = (delta: unknown, finish_reason: string | null = null) => ({
  id: 'answer-1', model: 'meadow-9b', choices: [{ index: 0, delta, finish_reason }],
});
const accounting = { id: 'answer-1', model: 'meadow-9b', choices: [],
  usage: { prompt_tokens: 115_164, completion_tokens: 3, total_tokens: 115_167 },
  timings: { cache_n: 115_000, prompt_ms: 200, predicted_per_second: 49.5 } };
const end = frame(chunk({}, 'stop')) + frame(accounting) + 'data: [DONE]\r\n\r\n';
const input = () => ({ url: 'http://127.0.0.1:18100/v1/chat/completions', body: {}, model: 'meadow-9b',
  signal: new AbortController().signal, maxResponseBytes: 1_048_576 });
function stream(text: string, width = 1) {
  const bytes = new TextEncoder().encode(text);
  return new Response(new ReadableStream({ start(controller) {
    for (let offset = 0; offset < bytes.length; offset += width) controller.enqueue(bytes.slice(offset, offset + width));
    controller.close();
  } }), { headers: { 'content-type': 'text/event-stream; charset=utf-8' } });
}

afterEach(() => vi.useRealTimers());
describe('local response streams', () => {
  it('decodes split UTF-8 and event boundaries and publishes progress and tokens before EOF', async () => {
    const onDelta = vi.fn(), onReasoningDelta = vi.fn(), onPromptProgress = vi.fn();
    const progress = { total: 115_164, cache: 0, processed: 512, time_ms: 42 };
    const body = ': ping\r\n\r\n' + frame({ ...chunk({ role: 'assistant', content: null }), prompt_progress: progress }) +
      frame(chunk({ reasoning_content: 'Check. ' })) + frame(chunk({ content: 'A \u4e00 \ud83d\ude42' })) + end;
    const result = await readLocalStream({ ...input(), onDelta, onReasoningDelta, onPromptProgress,
      transport: vi.fn(async () => stream(body)) });
    expect(onPromptProgress).toHaveBeenCalledExactlyOnceWith(progress);
    expect(onDelta).toHaveBeenCalledExactlyOnceWith('A \u4e00 \ud83d\ude42');
    expect(onReasoningDelta).toHaveBeenCalledExactlyOnceWith('Check. ');
    expect(result).toMatchObject({ usage: accounting.usage, timings: accounting.timings,
      choices: [{ finish_reason: 'stop', message: { content: 'A \u4e00 \ud83d\ude42', reasoning_content: 'Check. ' } }] });
  });

  it('reassembles one tool without executing it and announces its header once', async () => {
    const onToolActivity = vi.fn();
    const body = frame(chunk({ tool_calls: [{ index: 0, id: 'call-1', type: 'function',
      function: { name: 'read_source', arguments: '{"path":' } }] })) +
      frame(chunk({ tool_calls: [{ index: 0, function: { arguments: '"ledger.txt"}' } }] })) +
      frame(chunk({}, 'tool_calls')) + frame(accounting) + 'data: [DONE]\n\n';
    const result = await readLocalStream({ ...input(), onToolActivity, transport: vi.fn(async () => stream(body, 17)) });
    expect(result).toMatchObject({ choices: [{ message: { tool_calls: [{ id: 'call-1', type: 'function',
      function: { name: 'read_source', arguments: '{"path":"ledger.txt"}' } }] } }] });
    expect(onToolActivity).toHaveBeenCalledExactlyOnceWith({ callId: 'call-1', tool: 'read_source',
      phase: 'started', summary: 'read_source' });
  });

  it.each([
    ['model mismatch', frame({ ...chunk({ content: 'bad' }), model: 'another-model' }) + end],
    ['answer mismatch', frame(chunk({ content: 'first' })) + frame({ ...chunk({ content: 'bad' }), id: 'another-id' }) + end],
    ['malformed JSON', 'data: {\n\n' + end],
    ['invalid progress', frame({ ...chunk({}), prompt_progress: { total: 2, cache: 3, processed: 1, time_ms: 0 } }) + end],
    ['multiple calls', frame(chunk({ tool_calls: [{ index: 1, function: { name: 'read_source' } }] })) + end],
    ['early accounting', frame(accounting) + end],
    ['missing terminator', frame(chunk({ content: 'partial' })) + frame(chunk({}, 'stop'))],
    ['missing finish', frame(chunk({ content: 'partial' })) + 'data: [DONE]\n\n'],
    ['answer after finish', frame(chunk({}, 'stop')) + frame(chunk({ content: 'bad' })) + end],
  ])('refuses %s', async (_name, body) => {
    await expect(readLocalStream({ ...input(), transport: vi.fn(async () => stream(body)) })).rejects.toThrow();
  });

  it('counts all response bytes across chunks and cancels on the cap', async () => {
    const response = stream(frame(chunk({ content: 'a'.repeat(2_000) })) + end, 19);
    await expect(readLocalStream({ ...input(), maxResponseBytes: 1_000,
      transport: vi.fn(async () => response) })).rejects.toThrow('more data');
    expect(response.body?.locked).toBe(false);
  });

  it.each([new Response(null, { status: 307 }), Response.json({ content: 'buffered' })])(
    'refuses redirects and buffered responses', async response => {
      await expect(readLocalStream({ ...input(), transport: vi.fn(async () => response) })).rejects.toThrow();
    });

  it('stops a stalled body, while progress extends the idle deadline and pings do not', async () => {
    vi.useFakeTimers();
    let source!: ReadableStreamDefaultController<Uint8Array>;
    const response = new Response(new ReadableStream<Uint8Array>({ start(controller) { source = controller; } }),
      { headers: { 'content-type': 'text/event-stream' } });
    const onPromptProgress = vi.fn();
    const run = readLocalStream({ ...input(), idleTimeoutMs: 1_000, onPromptProgress,
      transport: vi.fn(async () => response) });
    const rejected = expect(run).rejects.toThrow('stopped making progress');
    await vi.advanceTimersByTimeAsync(900);
    source.enqueue(new TextEncoder().encode(frame({ ...chunk({}),
      prompt_progress: { total: 2, cache: 0, processed: 1, time_ms: 900 } })));
    await vi.advanceTimersByTimeAsync(900);
    expect(onPromptProgress).toHaveBeenCalledOnce();
    source.enqueue(new TextEncoder().encode(': ping\n\n'));
    await vi.advanceTimersByTimeAsync(101);
    await rejected;
    expect(response.body?.locked).toBe(false);
  });

  it('honors a parent abort while waiting for the next event', async () => {
    const stop = new AbortController();
    const response = new Response(new ReadableStream(), { headers: { 'content-type': 'text/event-stream' } });
    const run = readLocalStream({ ...input(), signal: stop.signal, transport: vi.fn(async () => response) });
    const rejected = expect(run).rejects.toThrow('Stopped by user');
    await Promise.resolve();
    stop.abort(new Error('Stopped by user'));
    await rejected;
    expect(response.body?.locked).toBe(false);
  });
});
