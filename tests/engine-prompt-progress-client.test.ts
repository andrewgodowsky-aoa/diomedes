import { describe, expect, test } from 'vitest';
import {
  acceptReading,
  closeReading,
  MAX_RUN_READINGS,
  readingCaption,
  readingDetail,
  readingPercent,
  READING_LINE_MIN_TOKENS,
  rememberRunReading,
  type RunReading,
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

  test('the line says the share read so far, and technical detail adds the counts', () => {
    const state = acceptReading(null, frame(2, 65_536))!;
    expect(readingPercent(state)).toBe(55);
    expect(readingCaption(state)).toBe('Reading the document. 55% so far.');
    expect(readingCaption(state, true)).toBe('Reading the document. 55% so far, 65,536 of 117,536 tokens.');
    // Floored: one token short of the end still says 99%, and the line is still open.
    const nearly = acceptReading(null, frame(1, 117_535))!;
    expect(nearly.open).toBe(true);
    expect(readingCaption(nearly)).toBe('Reading the document. 99% so far.');
    // What the server took from its cache counts as read, as the bar fills it.
    expect(readingPercent(acceptReading(null, frame(1, 58_768, 117_536, 58_768))!)).toBe(50);
  });
});

describe("a run card's read (DIO-256)", () => {
  const run = (seq: number, processed: number, extra: Record<string, unknown> = {}) =>
    frame(seq, processed, 117_536, 0, { requestId: 'S1', runId: 'run-9', childRunId: null, seat: 'lead', ...extra });

  test("keeps each run's read under its session, and a new call or a child's call starts it over", () => {
    let runs = rememberRunReading({}, run(1, 10_000));
    expect(runs.S1).toMatchObject({ key: 'run-9:turn-1', reading: { seq: 1, processed: 10_000, open: true } });
    expect(rememberRunReading(runs, run(1, 10_000))).toBe(runs);
    runs = rememberRunReading(runs, run(2, 60_000));
    expect(runs.S1?.reading).toMatchObject({ seq: 2, processed: 60_000 });
    expect(rememberRunReading(runs, run(1, 70_000))).toBe(runs);
    // A worker's call is named by its child run, so its first frame is a new read.
    runs = rememberRunReading(runs, run(1, 5_000, { childRunId: 'child-1', seat: 'worker', stepId: 'model:0' }));
    expect(runs.S1).toMatchObject({ key: 'child-1:model:0', reading: { seq: 1, processed: 5_000, open: true } });
    // The lead's next call takes the run card back.
    runs = rememberRunReading(runs, run(1, 2_000, { stepId: 'model:1' }));
    expect(runs.S1).toMatchObject({ key: 'run-9:model:1', reading: { processed: 2_000 } });
  });

  test('ignores a frame without its request, run or step, and keeps the latest eight runs', () => {
    const none: Record<string, RunReading> = {};
    expect(rememberRunReading(none, { ...run(1, 10_000), requestId: undefined })).toBe(none);
    expect(rememberRunReading(none, { ...run(1, 10_000), runId: 7 })).toBe(none);
    expect(rememberRunReading(none, { ...run(1, 10_000), stepId: undefined })).toBe(none);
    expect(rememberRunReading(none, 'not a frame')).toBe(none);
    let runs = none;
    for (let n = 1; n <= MAX_RUN_READINGS + 2; n++) runs = rememberRunReading(runs, run(1, 10_000, { requestId: `S${n}` }));
    expect(Object.keys(runs)).toEqual(Array.from({ length: MAX_RUN_READINGS }, (_, i) => `S${i + 3}`));
  });
});
