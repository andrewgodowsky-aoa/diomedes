import { describe, expect, it, vi } from 'vitest';
import { BONSAI_BASE_URL, BONSAI_MODEL, type BonsaiStatus } from '../shared/bonsai.js';
import { modelContextWindow } from '../shared/context-accounting.js';
import { BonsaiError, BonsaiRuntime, type BonsaiHost } from '../server/bonsai/runtime.js';
import { bonsaiLimits, bonsaiMessages, bonsaiRateCard, respondBonsai } from '../server/engines/bonsai.js';
import { inspectModelImage } from '../server/bonsai/images.js';
import { sourceTools } from '../server/harness/capabilities/conversation-sources.js';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aVnQAAAAASUVORK5CYII=', 'base64');
const tool = sourceTools([]).describe().find(tool => tool.name === 'read_source')!;
const reply = (extra: Record<string, unknown> = {}) => ({ id: 'local-1', model: BONSAI_MODEL,
  choices: [{ finish_reason: 'stop', message: { content: 'The answer.', reasoning_content: 'Check the facts.' } }],
  usage: { prompt_tokens: 32, completion_tokens: 12, total_tokens: 44 }, ...extra });
function fixture(answer: unknown = reply(), tokens = 10) {
  const released = vi.fn(async () => {});
  const host: BonsaiHost = {
    inspect: async (): Promise<BonsaiStatus> => ({ state: 'unloaded', installed: true, mode: null, owned: false, detail: '' }),
    acquire: vi.fn(async profile => ({ status: { state: 'ready' as const, installed: true, mode: profile.mode, owned: true, detail: '' }, release: released })),
  };
  const calls: { url: string; body: Record<string, unknown>; init: RequestInit }[] = [];
  const transport: typeof fetch = async (url, init) => {
    expect(String(url)).toMatch(/^http:\/\/127\.0\.0\.1:18082\//);
    calls.push({ url: String(url), body: JSON.parse(String(init?.body)), init: init! });
    if (String(url).endsWith('/apply-template')) return Response.json({ prompt: 'Complete template' });
    if (String(url).endsWith('/tokenize')) return Response.json({ tokens: Array.from({ length: tokens }, () => 7) });
    return answer instanceof Response ? answer : Response.json(answer);
  };
  const input = { runtime: new BonsaiRuntime(host), model: 'bonsai-gaming', instructions: 'Use the selected files.',
    messages: [{ role: 'user' as const, content: 'Explain this.' }], tools: [tool], signal: new AbortController().signal, transport };
  return { input, calls, host, released };
}

describe('Bonsai local provider', () => {
  it('allows Full reasoning to finish while preserving explicitly narrower host limits', async () => {
    expect(bonsaiLimits('bonsai-full')).toMatchObject({ maxOutputTokens: 32768, callWallMs: 900000 });
    expect(bonsaiLimits('bonsai-gaming')).toMatchObject({ maxOutputTokens: 4096, callWallMs: 120000 });
    const f = fixture();
    await respondBonsai({ ...f.input, model: 'bonsai-full', limits: { ...bonsaiLimits('bonsai-full'), maxOutputTokens: 512, callWallMs: 1000 } });
    expect(f.calls.at(-1)!.body.max_tokens).toBe(512);
  });
  it.each(['bonsai-gaming', 'bonsai-full'])('keeps %s local, bounded, accounted and at the requested effort', async model => {
    const f = fixture(), thoughts = vi.fn(), deltas = vi.fn();
    const result = await respondBonsai({ ...f.input, model, effort: 'xhigh', onDelta: deltas, onReasoningDelta: thoughts });
    expect(f.calls.map(c => c.url)).toEqual(['/apply-template', '/tokenize', '/v1/chat/completions'].map(p => BONSAI_BASE_URL + p));
    expect(f.calls.at(-1)!.body).toMatchObject({ model: BONSAI_MODEL, reasoning_effort: 'xhigh',
      chat_template_kwargs: { reasoning_effort: 'xhigh' }, parallel_tool_calls: false, stream: false,
      max_tokens: model === 'bonsai-full' ? 32768 : 4096 });
    expect(f.calls.every(c => c.init.redirect === 'error')).toBe(true);
    expect(f.calls.at(-1)!.init.headers).toEqual({ 'content-type': 'application/json' });
    expect(result).toMatchObject({ outcome: { kind: 'final', text: 'The answer.' }, reportedModel: BONSAI_MODEL,
      usage: { inputTokens: 32, outputTokens: 12 }, rawUsage: { local: { inferenceCostMicroUsd: 0 } } });
    expect(result).not.toHaveProperty('reservation');
    expect(bonsaiRateCard(model).short.input).toBe(0);
    expect(modelContextWindow('bonsai', model).tokens).toBe(model === 'bonsai-gaming' ? 16384 : 131072);
    expect(thoughts).toHaveBeenCalledWith('Check the facts.');
    expect(deltas).toHaveBeenCalledWith('The answer.');
    expect(f.released).toHaveBeenCalledOnce();
  });
  it('sends Full image bytes while the template preflight contains only image placeholders', async () => {
    const f = fixture();
    await respondBonsai({ ...f.input, model: 'bonsai-full', messages: [{ role: 'user', content: [
      { type: 'text', text: 'What is visible?' }, { type: 'image', image: png.toString('base64'), mediaType: 'image/png' },
    ] }] });
    expect(JSON.stringify(f.calls[0].body)).toContain('[image]');
    expect(JSON.stringify(f.calls[0].body)).not.toContain(png.toString('base64'));
    expect(JSON.stringify(f.calls.at(-1)!.body)).toContain(`data:image/png;base64,${png.toString('base64')}`);
  });
  it('refuses a Gaming image, unsupported effort and an unknown profile before waking', async () => {
    const f = fixture();
    await expect(respondBonsai({ ...f.input, messages: [{ role: 'user', content: [{ type: 'image', image: png.toString('base64'), mediaType: 'image/png' }] }] })).rejects.toThrow('text only');
    await expect(respondBonsai({ ...f.input, effort: 'ultra' })).rejects.toThrow('reasoning');
    await expect(respondBonsai({ ...f.input, model: 'cloud-default' })).rejects.toThrow('profile');
    expect(f.host.acquire).not.toHaveBeenCalled(); expect(f.calls).toEqual([]);
  });
  it('keeps the text bound when an image is attached', async () => {
    const f = fixture();
    await expect(respondBonsai({ ...f.input, model: 'bonsai-full', messages: [{ role: 'user', content: [
      { type: 'text', text: 'x'.repeat(2_000_000) },
      { type: 'image', image: png.toString('base64'), mediaType: 'image/png' },
    ] }] })).rejects.toThrow('text limit');
    expect(f.host.acquire).not.toHaveBeenCalled();
  });
  it.each(['https://example.test/image.png', 'file:///C:/secret.png'])('never fetches image URL %s', url => {
    expect(() => bonsaiMessages([{ role: 'user', content: [{ type: 'image', image: url, mediaType: 'image/png' }] }], 'bonsai-full')).toThrow('project bytes');
  });
  it('refuses context overflow before inference, including the image reserve', async () => {
    const f = fixture(reply(), 16384 - 4096 + 1);
    await expect(respondBonsai(f.input)).rejects.toThrow('16,384 tokens');
    expect(f.calls).toHaveLength(2); expect(f.released).toHaveBeenCalledOnce();
    const full = fixture(reply(), 131072 - 32768 - 1024 + 1);
    await expect(respondBonsai({ ...full.input, model: 'bonsai-full', messages: [{ role: 'user', content: [
      { type: 'image', image: png.toString('base64'), mediaType: 'image/png' },
    ] }] })).rejects.toThrow('131,072 tokens');
    expect(full.calls).toHaveLength(2);
  });
  it('returns a proposed tool call for Runtime to execute', async () => {
    const f = fixture(reply({ choices: [{ finish_reason: 'tool_calls', message: { content: null,
      tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'read_source', arguments: '{"path":"note.md"}' } }] } }] }));
    const result = await respondBonsai(f.input);
    expect(result.outcome).toEqual({ kind: 'tool', callId: 'call-1', name: 'read_source', input: { path: 'note.md' } });
  });
  it.each([
    reply({ model: 'different-model' }), reply({ usage: {} }),
    reply({ choices: [{ finish_reason: 'length', message: { content: 'Truncated' } }] }),
    reply({ choices: [{ finish_reason: 'tool_calls', message: { tool_calls: [
      { id: 'call-1', type: 'function', function: { name: 'execute_shell', arguments: '{}' } },
    ] } }] }),
  ])('refuses mismatched, unaccounted, truncated or unoffered responses without retrying', async answer => {
    const f = fixture(answer);
    await expect(respondBonsai(f.input)).rejects.toThrow();
    expect(f.calls.filter(c => c.url.endsWith('/v1/chat/completions'))).toHaveLength(1);
    expect(f.released).toHaveBeenCalledOnce();
  });
  it('does not dispatch or fall back when startup has insufficient memory', async () => {
    const f = fixture();
    vi.mocked(f.host.acquire).mockRejectedValueOnce(new BonsaiError('insufficient-memory', 'Needs 7168 MiB.'));
    await expect(respondBonsai(f.input)).rejects.toMatchObject({ code: 'bonsai_insufficient-memory' });
    expect(f.calls).toEqual([]);
  });
  it('keeps a lost lease after dispatch distinct from a request that never started', async () => {
    const f = fixture(), lost = new AbortController();
    vi.mocked(f.host.acquire).mockImplementation(async profile => ({
      status: { state: 'ready', installed: true, mode: profile.mode, owned: true, detail: 'Ready' },
      signal: lost.signal, release: f.released,
    }));
    const transport: typeof fetch = async (url, init) => {
      if (!String(url).endsWith('/v1/chat/completions')) return f.input.transport(url, init);
      lost.abort(new BonsaiError('error', 'The lease holder exited.'));
      throw init!.signal!.reason;
    };
    await expect(respondBonsai({ ...f.input, transport })).rejects.toMatchObject({ dispatched: true });
    expect(f.released).toHaveBeenCalledOnce();
  });
  it('does not follow a local-server redirect', async () => {
    const f = fixture(new Response(null, { status: 307, headers: { location: 'https://example.test' } }));
    await expect(respondBonsai(f.input)).rejects.toThrow('redirect');
    expect(f.calls).toHaveLength(3);
  });
  it('validates image type, bytes and the exact version hash', () => {
    expect(inspectModelImage('picture.png', png)).toMatchObject({ path: 'picture.png', mediaType: 'image/png', bytes: png.length });
    expect(inspectModelImage('picture.png', png).sha).toMatch(/^[a-f0-9]{64}$/);
    expect(() => inspectModelImage('picture.jpg', png)).toThrow('file type');
    expect(() => inspectModelImage('picture.svg', png)).toThrow('PNG');
    expect(() => inspectModelImage('picture.png', Buffer.alloc(4 * 1024 * 1024 + 1))).toThrow('4 MB');
  });
});
