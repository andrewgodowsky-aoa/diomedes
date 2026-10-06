import { describe, expect, test } from 'vitest';
import {
  acceptReading,
  closeReading,
  readingDetail,
  READING_LINE_MIN_TOKENS,
} from '../client/console/engine-prompt-progress';

const id = { projectId: 'P1', threadId: 'T1', requestId: 'R1', runId: 'run-1', stepId: 'turn-1', attempt: 1, fence: 1 };
const frame = (seq: number, processed: number, total = 117_536, cache = 0, extra: Record<string, unknown> = {}) => ({
  kind: 'local-prompt-progress', ...id, seq, text: 'Reading the document.', total, cache, processed, time_ms: seq * 500, ...extra,
});

describe('a long local read', () => {
  test('opens on a long read, follows its counters, and closes when the read ends', () => {
    let state = acceptReading(null, frame(1, 0));
    expect(state).toMatchObject({ open: true, processed: 0, total: 117_536, text: 'Reading the document.' });
    state = acceptReading(state, frame(2, 65_536));
    expect(state).toMatchObject({ open: true, processed: 65_536, seq: 2 });
    expect(readingDetail(state!)).toBe('65,536 of 117,536');
    expect(readingDetail(state!, true)).toBe('65,536 of 117,536 tokens');
    state = acceptReading(state, frame(3, 117_536));
    expect(state).toMatchObject({ open: false, processed: 117_536 });
  });

  test('drops malformed, duplicate, late and foreign-attempt frames, and returns the same object', () => {
    const state = acceptReading(null, frame(2, 40_000));
    expect(acceptReading(state, frame(2, 50_000))).toBe(state);
    expect(acceptReading(state, frame(1, 30_000))).toBe(state);
    expect(acceptReading(state, { ...frame(3, 50_000), kind: 'reasoning-delta' })).toBe(state);
    expect(acceptReading(state, frame(3, 120_000))).toBe(state);
    expect(acceptReading(state, frame(3, 10, 117_536, 20))).toBe(state);
    expect(acceptReading(state, { ...frame(3, 50_000), seq: 0 })).toBe(state);
    expect(acceptReading(state, 'not a frame')).toBe(state);
    expect(acceptReading(state, frame(3, 50_000, 117_536, 0, { stepId: 'turn-0' }))).toBe(state);
    expect(acceptReading(null, { ...frame(1, 0), text: '' })).toBeNull();
  });

  test('a retried attempt starts the read over, and an older attempt cannot come back', () => {
    const first = acceptReading(null, frame(9, 90_000));
    const retried = acceptReading(first, frame(1, 1_000, 117_536, 0, { attempt: 2 }));
    expect(retried).toMatchObject({ attempt: 2, seq: 1, processed: 1_000, open: true });
    expect(acceptReading(retried, frame(10, 100_000))).toBe(retried);
    const fenced = acceptReading(retried, frame(1, 2_000, 117_536, 0, { attempt: 1, fence: 2 }));
    expect(fenced).toMatchObject({ fence: 2, attempt: 1, processed: 2_000 });
  });

  test('a read mostly served from the cache, or a short prompt, never shows', () => {
    const cached = acceptReading(null, frame(1, 117_000, 117_536, 117_000));
    expect(cached).toMatchObject({ open: false });
    const short = acceptReading(null, frame(1, 0, 2_295));
    expect(short).toMatchObject({ open: false });
    // The gate counts what is left to read, on both sides of the line.
    expect(acceptReading(null, frame(1, 0, READING_LINE_MIN_TOKENS))).toMatchObject({ open: true });
    expect(acceptReading(null, frame(1, 0, READING_LINE_MIN_TOKENS - 1))).toMatchObject({ open: false });
    expect(acceptReading(null, frame(1, 1, READING_LINE_MIN_TOKENS + 1, 1))).toMatchObject({ open: true });
    expect(acceptReading(null, frame(1, 2, READING_LINE_MIN_TOKENS + 1, 2))).toMatchObject({ open: false });
  });

  test('the next call in the same turn reads again under the turn\'s identity', () => {
    // The file list is short, so it shows nothing; the read that follows it does.
    let state = acceptReading(null, frame(1, 0, 2_295));
    state = acceptReading(state, frame(2, 2_295, 2_295));
    expect(state).toMatchObject({ open: false });
    state = acceptReading(state, frame(3, 2_007, 118_154, 2_007));
    expect(state).toMatchObject({ open: true, seq: 3, total: 118_154 });
  });

  test('answer text closes the read once, and a later read opens again', () => {
    const open = acceptReading(null, frame(1, 50_000));
    const closed = closeReading(open);
    expect(closed).toMatchObject({ open: false, processed: 50_000 });
    expect(closeReading(closed)).toBe(closed);
    expect(closeReading(null)).toBeNull();
    expect(acceptReading(closed, frame(2, 60_000))).toMatchObject({ open: true, processed: 60_000 });
  });
});
