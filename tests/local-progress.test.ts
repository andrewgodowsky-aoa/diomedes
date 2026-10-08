import { describe, expect, it, vi } from 'vitest';
import { localPromptProgressSink } from '../server/engines/local-progress.js';

const identity = { projectId: 'p', threadId: 't', requestId: 'request', runId: 'run',
  stepId: 'model', attempt: 2, fence: 7 };
const progress = { total: 115_164, cache: 0, processed: 512, time_ms: 500 };
describe('local reading progress', () => {
  it('keeps the attempt identity, strips untrusted fields and uses dense channel ordering', () => {
    const publish = vi.fn();
    const sink = localPromptProgressSink({ identity, signal: new AbortController().signal, publish });
    sink({ ...progress, text: 'untrusted', runId: 'other' } as typeof progress);
    sink({ ...progress, processed: -1 });
    sink({ ...progress, processed: 1024 });
    expect(publish.mock.calls.map(([frame]) => frame.seq)).toEqual([1, 2]);
    expect(publish.mock.calls[0][0]).toEqual({ ...identity, ...progress,
      kind: 'local-prompt-progress', seq: 1, text: 'Reading the document.' });
  });
  it('publishes each reading frame as it arrives and nothing after stop', () => {
    const publish = vi.fn(), stop = new AbortController();
    const sink = localPromptProgressSink({ identity, signal: stop.signal, publish });
    sink(progress);
    expect(publish).toHaveBeenCalledTimes(1);
    stop.abort();
    sink({ ...progress, processed: 1024 });
    expect(publish).toHaveBeenCalledTimes(1);
  });
});
