import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NECTOVIA_TOKENS } from '../client/console/artifact-frame';

const mermaid = vi.hoisted(() => ({ initialize: vi.fn(), render: vi.fn() }));
vi.mock('mermaid', () => ({ default: mermaid }));

let renderDiagram: typeof import('../client/console/mermaid-render')['renderDiagram'];
let release: () => void;
let gate: Promise<void>;

beforeEach(async () => {
  vi.resetModules();
  vi.doMock('mermaid', () => ({ default: mermaid }));
  mermaid.initialize.mockReset();
  mermaid.render.mockReset();
  gate = new Promise<void>((resolve) => { release = resolve; });
  mermaid.render.mockImplementation(async (_id: string, source: string) => {
    if (source.includes('First')) await gate;
    return { svg: '<svg><text>fixture</text></svg>' };
  });
  vi.stubGlobal('document', {
    querySelector: () => null,
    createElement: () => ({ setAttribute: vi.fn(), style: {}, remove: vi.fn() }),
    body: { appendChild: vi.fn() },
    getElementById: () => null,
  });
  vi.stubGlobal('DOMParser', class {
    parseFromString() { return { body: { querySelectorAll: () => [], innerHTML: '<svg/>' } }; }
  });
  ({ renderDiagram } = await import('../client/console/mermaid-render'));
});
afterEach(() => { release(); vi.unstubAllGlobals(); });

const diagram = (label: string) => `graph TD\n  ${label} --> Done`;

describe('serialized Mermaid work', () => {
  it('drops 999 obsolete panel jobs before Mermaid draws them', async () => {
    const first = renderDiagram(diagram('First'), NECTOVIA_TOKENS);
    await vi.waitFor(() => expect(mermaid.render).toHaveBeenCalledOnce());
    const owner = {};
    const requests = [];
    let controller: AbortController | null = null;
    for (let index = 0; index < 1000; index += 1) {
      controller?.abort();
      controller = new AbortController();
      requests.push(renderDiagram(diagram(`Current${index}`), NECTOVIA_TOKENS,
        { signal: controller.signal, owner }));
    }
    release();
    const results = await Promise.all([first, ...requests]);
    expect(mermaid.render).toHaveBeenCalledTimes(2);
    expect(mermaid.render.mock.calls[1][1]).toContain('Current999');
    expect(results.slice(1, -1).every((result) => !result.ok && result.cancelled)).toBe(true);
    expect(results.at(-1)?.ok).toBe(true);
  });

  it('coalesces a panel generation even when its caller omitted explicit abort', async () => {
    const first = renderDiagram(diagram('First'), NECTOVIA_TOKENS);
    await vi.waitFor(() => expect(mermaid.render).toHaveBeenCalledOnce());
    const owner = {};
    const old = renderDiagram(diagram('Old'), NECTOVIA_TOKENS, { owner });
    const current = renderDiagram(diagram('Current'), NECTOVIA_TOKENS, { owner });
    release();
    expect(await old).toMatchObject({ ok: false, cancelled: true });
    expect((await current).ok).toBe(true);
    await first;
    expect(mermaid.render).toHaveBeenCalledTimes(2);
  });

  it('bounds independently owned pending jobs and keeps the newest jobs', async () => {
    const first = renderDiagram(diagram('First'), NECTOVIA_TOKENS);
    await vi.waitFor(() => expect(mermaid.render).toHaveBeenCalledOnce());
    const pending = Array.from({ length: 50 }, (_, index) =>
      renderDiagram(diagram(`Panel${index}`), NECTOVIA_TOKENS, { owner: {} }));
    release();
    const results = await Promise.all(pending);
    await first;
    expect(mermaid.render).toHaveBeenCalledTimes(33);
    expect(results.filter((result) => !result.ok && result.cancelled)).toHaveLength(18);
    expect(mermaid.render.mock.calls.at(-1)?.[1]).toContain('Panel49');
  });

  it('settles pre-aborted jobs without loading or configuring Mermaid', async () => {
    const controller = new AbortController();
    controller.abort();
    expect(await renderDiagram(diagram('Cancelled'), NECTOVIA_TOKENS, { signal: controller.signal }))
      .toMatchObject({ ok: false, cancelled: true });
    expect(mermaid.initialize).not.toHaveBeenCalled();
    expect(mermaid.render).not.toHaveBeenCalled();
  });

  it('keeps live jobs serial and initializes each draw with its own tokens', async () => {
    const first = renderDiagram(diagram('First'), NECTOVIA_TOKENS);
    await vi.waitFor(() => expect(mermaid.render).toHaveBeenCalledOnce());
    const tokens = { ...NECTOVIA_TOKENS, lead: '#123456' };
    const second = renderDiagram(diagram('Second'), tokens);
    await Promise.resolve();
    expect(mermaid.initialize).toHaveBeenCalledOnce();
    release();
    expect((await first).ok).toBe(true);
    expect((await second).ok).toBe(true);
    expect(mermaid.initialize).toHaveBeenCalledTimes(2);
    expect(mermaid.initialize.mock.calls[1][0].themeVariables.lineColor).toBe(tokens.lead);
  });

  it('settles a closed pending panel immediately while another layout is active', async () => {
    const first = renderDiagram(diagram('First'), NECTOVIA_TOKENS);
    await vi.waitFor(() => expect(mermaid.render).toHaveBeenCalledOnce());
    const controller = new AbortController();
    const pending = renderDiagram(diagram('Closed'), NECTOVIA_TOKENS, { signal: controller.signal });
    controller.abort();
    expect(await pending).toMatchObject({ ok: false, cancelled: true });
    expect(mermaid.render).toHaveBeenCalledOnce();
    release();
    await first;
    expect(mermaid.render).toHaveBeenCalledOnce();
  });

  it('checks cancellation after a delayed module load and before initialization', async () => {
    let loading = false;
    let finishLoading!: () => void;
    const loaded = new Promise<void>((resolve) => { finishLoading = resolve; });
    vi.doMock('mermaid', async () => { loading = true; await loaded; return { default: mermaid }; });
    const controller = new AbortController();
    const old = renderDiagram(diagram('Old'), NECTOVIA_TOKENS, { signal: controller.signal });
    await vi.waitFor(() => expect(loading).toBe(true));
    controller.abort();
    const current = renderDiagram(diagram('Current'), NECTOVIA_TOKENS);
    finishLoading();
    expect(await old).toMatchObject({ ok: false, cancelled: true });
    expect((await current).ok).toBe(true);
    expect(mermaid.initialize).toHaveBeenCalledOnce();
    expect(mermaid.render).toHaveBeenCalledOnce();
    expect(mermaid.render.mock.calls[0][1]).toContain('Current');
  });

  it('does not poison the serial queue after a layout failure', async () => {
    mermaid.render.mockRejectedValueOnce(new Error('owned fixture layout failure'));
    expect(await renderDiagram(diagram('Bad'), NECTOVIA_TOKENS))
      .toMatchObject({ ok: false, problem: 'owned fixture layout failure' });
    expect((await renderDiagram(diagram('Good'), NECTOVIA_TOKENS)).ok).toBe(true);
    expect(mermaid.render).toHaveBeenCalledTimes(2);
  });
});
