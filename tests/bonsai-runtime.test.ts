import { describe, expect, it, vi } from 'vitest';
import { BONSAI_PROFILES, bonsaiSelectionFields, type BonsaiStatus } from '../shared/bonsai.js';
import { BonsaiError, BonsaiRuntime, type BonsaiHost } from '../server/bonsai/runtime.js';

const ready = (mode: 'Gaming' | 'Full'): BonsaiStatus => ({ state: 'ready', installed: true, mode, owned: true, detail: 'Ready' });
const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; };
function host() {
  let running: string | null = null;
  const starts: string[] = [];
  const releases = vi.fn(async () => {});
  const value: BonsaiHost = {
    inspect: vi.fn(async (): Promise<BonsaiStatus> => ({ state: 'unloaded', installed: true, mode: null, owned: false, detail: 'Unloaded' })),
    acquire: vi.fn(async profile => {
      if (running !== profile.mode) { starts.push(profile.mode); running = profile.mode; }
      return { status: ready(profile.mode), release: releases };
    }),
  };
  return { value, starts, releases };
}
describe('Bonsai profile and display identity', () => {
  it('keeps the two capabilities and contexts distinct from the common model alias', () => {
    expect(BONSAI_PROFILES.map(p => [p.slug, p.model, p.contextTokens, p.inputModalities])).toEqual([
      ['bonsai-gaming', 'bonsai-2-27b', 16384, ['text']],
      ['bonsai-full', 'bonsai-2-27b', 131072, ['text', 'image']],
    ]);
  });
  it.each(['bonsai-gaming', 'bonsai-full'])('renders %s with independent effort and Agent fields', model => {
    const fields = bonsaiSelectionFields(model, 'xhigh', 'Auto')!;
    expect([fields.engine, fields.profile, fields.effort, fields.agent].join(' | '))
      .toBe(`Nectovia | ${model === 'bonsai-gaming' ? 'Bonsai Gaming' : 'Bonsai Full'} | Extra | Auto`);
  });
});
describe('Bonsai lifecycle queue', () => {
  it('wakes the chosen profile and reuses it for simultaneous requests', async () => {
    const h = host(), runtime = new BonsaiRuntime(h.value);
    const signal = new AbortController().signal;
    await Promise.all([runtime.wake('bonsai-full', signal), runtime.wake('bonsai-full', signal)]);
    expect(h.starts).toEqual(['Full']);
    expect(h.releases).toHaveBeenCalledTimes(2);
  });
  it('does not switch modes until the active request releases its lease', async () => {
    const h = host(), runtime = new BonsaiRuntime(h.value), finish = deferred<void>();
    const signal = new AbortController().signal;
    const first = runtime.use('bonsai-gaming', signal, () => finish.promise);
    await vi.waitFor(() => expect(h.starts).toEqual(['Gaming']));
    const second = runtime.wake('bonsai-full', signal);
    expect((await runtime.status()).state).toBe('busy');
    expect(h.starts).toEqual(['Gaming']);
    finish.resolve();
    await Promise.all([first, second]);
    expect(h.starts).toEqual(['Gaming', 'Full']);
  });
  it('cancels a queued selection without starting it or releasing the active lease', async () => {
    const h = host(), runtime = new BonsaiRuntime(h.value), finish = deferred<void>();
    const first = runtime.use('bonsai-gaming', new AbortController().signal, () => finish.promise);
    await vi.waitFor(() => expect(h.starts).toEqual(['Gaming']));
    const controller = new AbortController();
    const second = runtime.wake('bonsai-full', controller.signal);
    controller.abort();
    await expect(second).rejects.toMatchObject({ name: 'AbortError' });
    expect(h.releases).not.toHaveBeenCalled();
    finish.resolve(); await first;
    await runtime.wake('bonsai-gaming', new AbortController().signal);
    expect(h.starts).toEqual(['Gaming']);
  });
  it('finishes one shared startup after cancellation, without dispatching the cancelled request', async () => {
    const loading = deferred<Awaited<ReturnType<BonsaiHost['acquire']>>>(), h = host();
    vi.mocked(h.value.acquire).mockReturnValueOnce(loading.promise);
    const runtime = new BonsaiRuntime(h.value), controller = new AbortController(), work = vi.fn();
    const pending = runtime.use('bonsai-full', controller.signal, work);
    await vi.waitFor(() => expect(h.value.acquire).toHaveBeenCalledTimes(1));
    controller.abort(); await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    const next = runtime.wake('bonsai-full', new AbortController().signal);
    expect(h.value.acquire).toHaveBeenCalledTimes(1);
    loading.resolve({ status: ready('Full'), release: h.releases });
    await next;
    expect(work).not.toHaveBeenCalled();
    expect(h.releases).toHaveBeenCalledTimes(2);
  });
  it('reports memory refusal and lets a later explicit retry succeed', async () => {
    const h = host();
    vi.mocked(h.value.acquire).mockRejectedValueOnce(new BonsaiError('insufficient-memory', 'Needs 12288 MiB.'));
    const runtime = new BonsaiRuntime(h.value), work = vi.fn();
    await expect(runtime.use('bonsai-full', new AbortController().signal, work)).rejects.toThrow('12288');
    expect((await runtime.status()).state).toBe('insufficient-memory');
    expect(work).not.toHaveBeenCalled();
    expect((await runtime.wake('bonsai-full', new AbortController().signal)).state).toBe('ready');
  });
  it('releases a failed inference and never substitutes a profile', async () => {
    const h = host(), runtime = new BonsaiRuntime(h.value);
    await expect(runtime.use('bonsai-full', new AbortController().signal, async () => { throw new Error('inference failed'); })).rejects.toThrow('inference failed');
    expect(h.releases).toHaveBeenCalledOnce();
    expect(h.starts).toEqual(['Full']);
    await expect(runtime.wake('unknown', new AbortController().signal)).rejects.toThrow('profile');
    expect(h.value.acquire).toHaveBeenCalledTimes(1);
  });
});
