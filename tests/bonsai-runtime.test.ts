import { describe, expect, it, vi } from 'vitest';
import type { LocalModelStatus } from '../shared/local-model.js';
import {
  LOCAL_MODEL_STATUS_TTL_MS,
  LocalModelError,
  LocalModelRuntime,
  localModelOtherProfile,
  localModelUnknownProfile,
  type LocalModelHost,
} from '../server/bonsai/runtime.js';
import { BONSAI_MODEL, FixedLocalModel, MEADOW_FOLDER, MEADOW_MODEL, meadowDescriptor } from './fixtures/local-model.js';

const ready = (mode: string, extra: Partial<LocalModelStatus> = {}): LocalModelStatus =>
  ({ state: 'ready', installed: true, mode, owned: true, detail: 'Ready', ...extra });
const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; };
/** A host that keeps the helper's rule: only an explicit Start starts or switches the worker. */
function host() {
  let running: string | null = null;
  const starts: string[] = [];
  const releases = vi.fn(async () => {});
  const value: LocalModelHost = {
    inspect: vi.fn(async (): Promise<LocalModelStatus> => ({ state: 'unloaded', installed: true, mode: null, owned: false, detail: 'Unloaded' })),
    acquire: vi.fn(async (profile, options?: { start?: boolean }) => {
      if (running !== profile.mode) {
        if (!options?.start) throw new LocalModelError('unloaded', "The local model isn't running. Start it first.");
        starts.push(profile.mode); running = profile.mode;
      }
      return { status: ready(profile.mode), release: releases };
    }),
  };
  return { value, starts, releases };
}
const runtimeOf = (h: ReturnType<typeof host>, now?: () => number, source = new FixedLocalModel()) =>
  new LocalModelRuntime(source, h.value, now);

describe('local profiles come from the description', () => {
  it('lists its profiles, each with its own context and inputs, under one served model', () => {
    const runtime = runtimeOf(host());
    expect(runtime.catalog().map(p => [p.slug, p.mode, p.contextTokens, p.inputModalities])).toEqual([
      ['local:gaming', 'Gaming', 16384, ['text']],
      ['local:full', 'Full', 131072, ['text', 'image']],
    ]);
    expect(runtime.descriptor()?.model).toBe(BONSAI_MODEL);
  });
  it('maps the slugs saved before profiles came from the description, and refuses an unknown one', async () => {
    const h = host(), runtime = runtimeOf(h);
    expect(runtime.profile('bonsai-gaming')?.slug).toBe('local:gaming');
    expect(runtime.profile('bonsai-full')?.slug).toBe('local:full');
    expect(runtime.profile('local:turbo')).toBeUndefined();
    expect((await runtime.wake('bonsai-full', new AbortController().signal)).mode).toBe('Full');
    expect(h.starts).toEqual(['Full']);
    await expect(runtime.wake('local:turbo', new AbortController().signal)).rejects.toThrow('Choose a local model profile.');
    expect(await runtime.refusal('local:turbo')).toBe('Choose a local model profile.');
  });
  it('refuses a saved slug the current description has no profile for', async () => {
    const h = host(), runtime = runtimeOf(h, undefined, new FixedLocalModel(meadowDescriptor(), MEADOW_FOLDER));
    expect(runtime.catalog().map(p => p.slug)).toEqual(['local:quick', 'local:deep']);
    await expect(runtime.wake('bonsai-gaming', new AbortController().signal))
      .rejects.toThrow('The local model has no Gaming profile now. Choose one of its profiles.');
    expect(await runtime.refusal('bonsai-full')).toBe('The local model has no Full profile now. Choose one of its profiles.');
    expect(h.value.acquire).not.toHaveBeenCalled();
  });
  it('names the catalogue for the model the server listed, with the context it reported', async () => {
    const h = host(), runtime = runtimeOf(h, () => 0, new FixedLocalModel(meadowDescriptor(), MEADOW_FOLDER));
    vi.mocked(h.value.inspect).mockResolvedValueOnce(ready('Deep', { model: MEADOW_MODEL, contextTokens: 131072 }));
    await runtime.status();
    expect(runtime.catalog().map(p => [p.name, p.contextTokens])).toEqual([['meadow-9b Quick', 16384], ['meadow-9b Deep', 131072]]);
    expect((await runtime.wake('local:deep', new AbortController().signal)).detail).toBe('meadow-9b Deep is ready.');
  });
  it('is not set up when no folder is set, and says so', async () => {
    const h = host(), runtime = runtimeOf(h, undefined, new FixedLocalModel(null));
    expect(runtime.configured()).toBe(false);
    expect(runtime.catalog()).toEqual([]);
    expect(await runtime.status()).toMatchObject({ state: 'missing', installed: false, detail: 'No local model folder is set.' });
    expect(await runtime.refusal('local:gaming')).toBe("The local model isn't installed on this computer.");
    await expect(runtime.wake('local:gaming', new AbortController().signal)).rejects.toMatchObject({ state: 'missing' });
    expect(h.value.inspect).not.toHaveBeenCalled();
  });
});

describe('work on a profile that is not the running one', () => {
  it('names the running profile, the unknown one, or that nothing runs', async () => {
    const h = host(), runtime = runtimeOf(h, () => 0);
    vi.mocked(h.value.inspect).mockResolvedValueOnce(ready('Full'));
    expect(await runtime.refusal('local:gaming')).toBe(localModelOtherProfile('Full', 'Gaming'));
    expect(await runtime.refusal('bonsai-full')).toBeNull();
    vi.mocked(h.value.inspect).mockResolvedValueOnce({ state: 'ready', installed: true, mode: null, model: BONSAI_MODEL,
      contextTokens: 32768, owned: false, detail: '' });
    expect(await runtime.status({ fresh: true })).toMatchObject({ state: 'ready', mode: null });
    expect(await runtime.refusal('local:gaming')).toBe(localModelUnknownProfile(32768, 'Gaming'));
    expect(localModelUnknownProfile(32768, 'Gaming')).toBe(
      'The local model is running with 32,768 tokens of context, which matches none of its profiles. Start Gaming first.');
    expect(localModelUnknownProfile(null, 'Full')).toBe(
      'The local model did not report its context size, so its profile is unknown. Start Full first.');
    vi.mocked(h.value.inspect).mockResolvedValueOnce({ state: 'unloaded', installed: true, mode: null, owned: false, detail: '' });
    expect(await runtime.status({ fresh: true })).toMatchObject({ state: 'unloaded' });
    expect(await runtime.refusal('local:gaming')).toBe("The local model isn't running. Start it first.");
  });
});

describe('the local lifecycle queue', () => {
  it('wakes the chosen profile and reuses it for simultaneous requests', async () => {
    const h = host(), runtime = runtimeOf(h);
    const signal = new AbortController().signal;
    await Promise.all([runtime.wake('local:full', signal), runtime.wake('local:full', signal)]);
    expect(h.starts).toEqual(['Full']);
    expect(h.releases).toHaveBeenCalledTimes(2);
  });
  it('does not switch modes until the active request releases its lease', async () => {
    const h = host(), runtime = runtimeOf(h), finish = deferred<void>();
    const signal = new AbortController().signal;
    await runtime.wake('local:gaming', signal);
    const first = runtime.use('local:gaming', signal, () => finish.promise);
    await vi.waitFor(() => expect(h.value.acquire).toHaveBeenCalledTimes(2));
    const second = runtime.wake('local:full', signal);
    expect((await runtime.status()).state).toBe('busy');
    expect(h.starts).toEqual(['Gaming']);
    finish.resolve();
    await Promise.all([first, second]);
    expect(h.starts).toEqual(['Gaming', 'Full']);
  });
  it('cancels a queued selection without starting it or releasing the active lease', async () => {
    const h = host(), runtime = runtimeOf(h), finish = deferred<void>();
    await runtime.wake('local:gaming', new AbortController().signal);
    const first = runtime.use('local:gaming', new AbortController().signal, () => finish.promise);
    await vi.waitFor(() => expect(h.value.acquire).toHaveBeenCalledTimes(2));
    const controller = new AbortController();
    const second = runtime.wake('local:full', controller.signal);
    controller.abort();
    await expect(second).rejects.toMatchObject({ name: 'AbortError' });
    // Only the earlier Start's lease has been released; the active request still holds its own.
    expect(h.releases).toHaveBeenCalledTimes(1);
    finish.resolve(); await first;
    await runtime.wake('local:gaming', new AbortController().signal);
    expect(h.starts).toEqual(['Gaming']);
  });
  it('finishes one shared startup after cancellation, without dispatching the cancelled request', async () => {
    const loading = deferred<Awaited<ReturnType<LocalModelHost['acquire']>>>(), h = host();
    vi.mocked(h.value.acquire).mockReturnValueOnce(loading.promise);
    const runtime = runtimeOf(h), controller = new AbortController(), work = vi.fn();
    const pending = runtime.use('local:full', controller.signal, work);
    await vi.waitFor(() => expect(h.value.acquire).toHaveBeenCalledTimes(1));
    controller.abort(); await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    const next = runtime.wake('local:full', new AbortController().signal);
    expect(h.value.acquire).toHaveBeenCalledTimes(1);
    loading.resolve({ status: ready('Full'), release: h.releases });
    await next;
    expect(work).not.toHaveBeenCalled();
    expect(h.releases).toHaveBeenCalledTimes(2);
  });
  it('reports memory refusal and lets a later explicit retry succeed', async () => {
    const h = host();
    vi.mocked(h.value.acquire).mockRejectedValueOnce(new LocalModelError('insufficient-memory', 'Needs 12288 MiB.'));
    const runtime = runtimeOf(h);
    await expect(runtime.wake('local:full', new AbortController().signal)).rejects.toThrow('12288');
    expect((await runtime.status()).state).toBe('insufficient-memory');
    expect((await runtime.wake('local:full', new AbortController().signal)).state).toBe('ready');
  });
  it('starts the worker only for the explicit wake, never for inference', async () => {
    const h = host(), runtime = runtimeOf(h), signal = new AbortController().signal, work = vi.fn(async () => 'answered');
    await expect(runtime.use('local:gaming', signal, work)).rejects.toMatchObject({ state: 'unloaded' });
    expect(h.value.acquire).toHaveBeenLastCalledWith(expect.objectContaining({ slug: 'local:gaming' }), { start: false },
      expect.objectContaining({ model: BONSAI_MODEL }));
    expect(h.starts).toEqual([]);
    expect(work).not.toHaveBeenCalled();
    await runtime.wake('local:gaming', signal);
    expect(h.value.acquire).toHaveBeenLastCalledWith(expect.objectContaining({ slug: 'local:gaming' }), { start: true },
      expect.objectContaining({ model: BONSAI_MODEL }));
    await expect(runtime.use('local:gaming', signal, work)).resolves.toBe('answered');
    // Inference on another profile never switches the worker either.
    await expect(runtime.use('local:full', signal, work)).rejects.toMatchObject({ state: 'unloaded' });
    expect(h.starts).toEqual(['Gaming']);
  });
  it('does not remember a refusal for a worker that is not running', async () => {
    const h = host(), runtime = runtimeOf(h);
    await expect(runtime.use('local:gaming', new AbortController().signal, vi.fn())).rejects.toMatchObject({ state: 'unloaded' });
    // Started outside the app afterwards: the next status reads the host instead of a cached refusal.
    vi.mocked(h.value.inspect).mockResolvedValueOnce(ready('Gaming'));
    expect((await runtime.status()).state).toBe('ready');
    expect(h.value.inspect).toHaveBeenCalledTimes(1);
  });
  it('releases a failed inference and never substitutes a profile', async () => {
    const h = host(), runtime = runtimeOf(h);
    await runtime.wake('local:full', new AbortController().signal);
    await expect(runtime.use('local:full', new AbortController().signal, async () => { throw new Error('inference failed'); })).rejects.toThrow('inference failed');
    expect(h.releases).toHaveBeenCalledTimes(2);
    expect(h.starts).toEqual(['Full']);
    await expect(runtime.wake('unknown', new AbortController().signal)).rejects.toThrow('profile');
    expect(h.value.acquire).toHaveBeenCalledTimes(2);
  });
});
describe('local status checks', () => {
  it('shares one host check between questions asked together, and reuses it for ten seconds', async () => {
    const h = host();
    let clock = 1_000;
    const runtime = runtimeOf(h, () => clock);
    const pending = deferred<LocalModelStatus>();
    vi.mocked(h.value.inspect).mockReturnValueOnce(pending.promise);
    const first = runtime.status(), second = runtime.status();
    pending.resolve(ready('Gaming'));
    expect((await first).state).toBe('ready');
    expect((await second).state).toBe('ready');
    expect(h.value.inspect).toHaveBeenCalledTimes(1);
    clock += LOCAL_MODEL_STATUS_TTL_MS - 1;
    expect((await runtime.status()).state).toBe('ready');
    expect(h.value.inspect).toHaveBeenCalledTimes(1);
    clock += 1;
    expect((await runtime.status()).state).toBe('unloaded');
    expect(h.value.inspect).toHaveBeenCalledTimes(2);
  });
  it('asks the host again for a fresh question, and later questions reuse that answer', async () => {
    const h = host(), runtime = runtimeOf(h, () => 0);
    await runtime.status();
    vi.mocked(h.value.inspect).mockResolvedValueOnce(ready('Full'));
    expect((await runtime.status({ fresh: true })).mode).toBe('Full');
    expect((await runtime.status()).mode).toBe('Full');
    expect(h.value.inspect).toHaveBeenCalledTimes(2);
  });
  it('never answers a changed description from a check of the old one', async () => {
    const h = host(), source = new FixedLocalModel(), runtime = runtimeOf(h, () => 0, source);
    vi.mocked(h.value.inspect).mockResolvedValueOnce(ready('Gaming'));
    expect((await runtime.status()).mode).toBe('Gaming');
    source.use(meadowDescriptor(), MEADOW_FOLDER);
    expect((await runtime.status()).state).toBe('unloaded');
    expect(h.value.inspect).toHaveBeenCalledTimes(2);
    expect(vi.mocked(h.value.inspect).mock.calls[1][0].model).toBe(MEADOW_MODEL);
  });
  it('forgets the last check when the app starts or uses the model, and never keeps a check begun before that', async () => {
    const h = host(), runtime = runtimeOf(h, () => 0);
    expect((await runtime.status()).state).toBe('unloaded');
    await runtime.wake('local:gaming', new AbortController().signal);
    vi.mocked(h.value.inspect).mockResolvedValueOnce(ready('Gaming'));
    expect((await runtime.status()).state).toBe('ready');
    expect(h.value.inspect).toHaveBeenCalledTimes(2);
    // A check still running when a use begins is answered, but not kept.
    const stale = deferred<LocalModelStatus>();
    vi.mocked(h.value.inspect).mockReturnValueOnce(stale.promise);
    const slow = runtime.status({ fresh: true });
    await runtime.use('local:gaming', new AbortController().signal, async () => 'done');
    stale.resolve({ state: 'unloaded', installed: true, mode: null, owned: false, detail: 'Unloaded' });
    expect((await slow).state).toBe('unloaded');
    vi.mocked(h.value.inspect).mockResolvedValueOnce(ready('Gaming'));
    expect((await runtime.status()).state).toBe('ready');
    expect(h.value.inspect).toHaveBeenCalledTimes(4);
  });
});
