import { describe, expect, test } from 'vitest';
import { acceptReasoning, endThinking, stepThinking, thoughtFor } from '../client/console/engine-reasoning';
import { stepLiveReply, type LiveBinding } from '../client/console/live-reply';

const id = { projectId: 'P1', threadId: 'T1', requestId: 'R1', runId: 'run-1', stepId: 's', attempt: 1, fence: 1 };
const frame = (seq: number, text: string) => ({ kind: 'reasoning-delta', ...id, seq, text });
const binding: LiveBinding = { projectId: 'P1', threadId: 'T1', requestId: 'R1' };

describe('live thinking', () => {
  test('appends in order, ignores a repeat and loses itself on a gap', () => {
    let state = stepThinking(null, frame(1, 'Weighing '), 1_000);
    state = stepThinking(state, frame(2, 'the menu.'), 1_000);
    state = stepThinking(state, frame(2, 'the menu.'), 1_000);
    expect(state).toMatchObject({ text: 'Weighing the menu.', since: 1_000, endedAt: null });
    expect(stepThinking(state, frame(4, 'late'), 1_000)).toMatchObject({ position: 'lost', text: '' });
    expect(acceptReasoning(null, { ...frame(1, 'x'), kind: 'text-delta' }).kind).toBe('discard');
  });

  test('ends once, at the first answer text', () => {
    const state = stepThinking(null, frame(1, 'Weighing'), 1_000);
    const ended = endThinking(state, 15_000);
    expect(ended?.endedAt).toBe(15_000);
    expect(endThinking(ended, 20_000)?.endedAt).toBe(15_000);
    expect(endThinking(null, 20_000)).toBeNull();
  });

  test('reads its duration plainly', () => {
    expect(thoughtFor(900)).toBe('Thought for a moment');
    expect(thoughtFor(14_200)).toBe('Thought for 14s');
  });
});

describe('the live reply', () => {
  const started = { type: 'engine-text' as const, data: { ...binding, runId: 'run-1', kind: 'started' } };
  test('carries thinking, folds it at the first answer text, and drops foreign runs', () => {
    let state = stepLiveReply(null, binding, started, 1_000);
    state = stepLiveReply(state, binding, { type: 'engine-reasoning', data: frame(1, 'Weighing') }, 2_000);
    state = stepLiveReply(state, binding, { type: 'engine-reasoning', data: { ...frame(2, 'x'), runId: 'other' } }, 2_500);
    expect(state?.thinking).toMatchObject({ text: 'Weighing', since: 1_000, endedAt: null });
    state = stepLiveReply(
      state,
      binding,
      { type: 'engine-text', data: { ...id, kind: 'delta', seq: 1, text: 'Soup.' } },
      9_000,
    );
    expect(state?.thinking?.endedAt).toBe(9_000);
    expect(state?.text).toBe('Soup.');
  });

  test('a lost stream loses the live thinking too', () => {
    let state = stepLiveReply(null, binding, started, 1_000);
    state = stepLiveReply(state, binding, { type: 'engine-reasoning', data: frame(1, 'Weighing') }, 2_000);
    state = stepLiveReply(state, binding, { type: 'lost' }, 3_000);
    expect(state?.thinking).toMatchObject({ position: 'lost', text: '' });
  });
});
