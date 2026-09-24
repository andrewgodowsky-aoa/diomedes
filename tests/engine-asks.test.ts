/**
 * H05: an engine's mid-turn question as a Need. The Need is written before the
 * turn waits; nobody answering in time expires it and tells the turn; a Stop
 * does the same; after a restart no open question survives; and a task-wide
 * allowance is refused. Nothing is ever answered on a person's behalf.
 */
import { describe, expect, it } from 'vitest';
import { EngineAskNeeds } from '../server/engines/engine-asks.js';
import type { Store } from '../server/store.js';
import type { Need } from '../shared/types.js';

function fakeStore() {
  const state = { project: { id: 'p1' }, needs: [] as Need[] };
  let persisted = 0;
  let queue = Promise.resolve();
  const store = {
    locked: <T>(action: () => Promise<T>) => {
      const result = queue.then(action);
      queue = result.then(
        () => undefined,
        () => undefined,
      );
      return result;
    },
    state: () => state,
    persist: async () => {
      persisted += 1;
    },
    projects: async () => [{ id: 'p1' }],
  } as unknown as Store;
  return { store, state, persisted: () => persisted };
}
const scope = { projectId: 'p1', runId: 'cursor-run', threadId: 't1', requestId: 'r1' };
const plan = { kind: 'plan' as const, engine: 'cursor' as const, title: 'Outline the report' };

describe('engine questions as Needs', () => {
  it('writes an open Need, and the go-ahead a person gives is what the turn receives', async () => {
    const f = fakeStore();
    const asks = new EngineAskNeeds(f.store);
    const answer = asks.ask(scope, plan, new AbortController().signal);
    await expect.poll(() => f.state.needs.length).toBe(1);
    const [need] = f.state.needs;
    expect(need).toMatchObject({
      state: 'open',
      sessionId: 'cursor-run',
      engineAsk: { runId: 'cursor-run', kind: 'plan', engine: 'cursor', requestId: 'r1' },
    });
    await expect(asks.resolve('p1', need.id, 'go-ahead', true)).rejects.toMatchObject({ status: 400 });
    expect(need.state).toBe('open');
    await asks.resolve('p1', need.id, 'go-ahead', false);
    await expect(answer).resolves.toBe('go-ahead');
    expect(need).toMatchObject({ state: 'go-ahead', decidedFrom: 'desktop' });
  });

  it('expires a question nobody answers and tells the turn, never answering for the person', async () => {
    const f = fakeStore();
    const asks = new EngineAskNeeds(f.store, { timeoutMs: 50 });
    await expect(asks.ask(scope, plan, new AbortController().signal)).resolves.toBe('expired');
    expect(f.state.needs[0].state).toBe('expired');
    await expect(asks.resolve('p1', f.state.needs[0].id, 'go-ahead', false)).rejects.toMatchObject({
      status: 409,
    });
  });

  it('a Stop expires the open question', async () => {
    const f = fakeStore();
    const asks = new EngineAskNeeds(f.store);
    const stop = new AbortController();
    const answer = asks.ask(scope, plan, stop.signal);
    await expect.poll(() => f.state.needs.length).toBe(1);
    stop.abort();
    await expect(answer).resolves.toBe('cancelled');
    expect(f.state.needs[0].state).toBe('expired');
  });

  it('after a restart no turn waits, so an open question is expired and cannot be answered', async () => {
    const f = fakeStore();
    const before = new EngineAskNeeds(f.store);
    void before.ask(scope, plan, new AbortController().signal);
    await expect.poll(() => f.state.needs.length).toBe(1);
    const after = new EngineAskNeeds(f.store);
    await after.expireOpen();
    expect(f.state.needs[0].state).toBe('expired');
    await expect(after.resolve('p1', f.state.needs[0].id, 'go-ahead', false)).rejects.toMatchObject({
      status: 409,
    });
  });
});
