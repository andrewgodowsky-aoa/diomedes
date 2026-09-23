import { describe, expect, test } from 'vitest';
import { activitySink, toolActivitySchema, type ToolActivity } from '../shared/adapter-contract.js';

const identity = {
  projectId: 'P1',
  threadId: 'T1',
  requestId: 'R1',
  runId: 'run-1',
  stepId: 'text:dispatch',
  attempt: 1,
  fence: 1,
};

describe('tool activity frames', () => {
  test('stamps identity and a dense sequence, and pairs start with finish by callId', () => {
    const frames: ToolActivity[] = [];
    const sink = activitySink({ identity, onActivity: (f) => frames.push(f) });
    sink({ callId: 'c1', phase: 'started', tool: 'read_file', summary: 'Reading menu.md' });
    sink({ callId: 'c1', phase: 'finished', tool: 'read_file', summary: 'Read menu.md', detail: '42 lines' });
    expect(frames.map((f) => [f.seq, f.phase, f.callId])).toEqual([
      [1, 'started', 'c1'],
      [2, 'finished', 'c1'],
    ]);
    expect(frames.every((f) => toolActivitySchema.safeParse(f).success)).toBe(true);
    expect(frames[1]).toMatchObject({ ...identity, kind: 'tool-activity', detail: '42 lines' });
  });
  test('redacts and trims instead of failing, and strips control characters', () => {
    const frames: ToolActivity[] = [];
    const sink = activitySink({
      identity,
      redact: (t) => t.replaceAll('sk-secret', '[redacted]'),
      onActivity: (f) => frames.push(f),
    });
    sink({ callId: 'c', phase: 'started', tool: 'fetch', summary: 'x'.repeat(500), detail: 'key sk-secret‮' });
    expect(frames[0].summary.length).toBe(300);
    expect(frames[0].detail).toBe('key [redacted]');
  });
  test('nothing is emitted after the request is stopped', () => {
    const frames: ToolActivity[] = [];
    const control = new AbortController();
    const sink = activitySink({ identity, signal: control.signal, onActivity: (f) => frames.push(f) });
    control.abort();
    sink({ callId: 'c', phase: 'started', tool: 'search', summary: 'Searching' });
    expect(frames).toHaveLength(0);
  });
});
