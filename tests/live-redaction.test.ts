/**
 * Live frames are redacted across chunk boundaries. Engines stream answers and thinking in small
 * token chunks, so a secret a model echoes almost always arrives in pieces; the sinks redact the
 * stream's text as one piece and hold back its newest part until more of it arrives, the attempt
 * ends (`shared/adapter-contract.ts`, `LIVE_REDACTION`). Channel switches never end a redaction window.
 */
import { describe, expect, test } from 'vitest';
import {
  LIVE_REDACTION,
  OUTPUT_DELTA,
  REASONING,
  activitySink,
  liveOrder,
  previewSink,
  reasoningSink,
  type PreviewRejection,
  type ReasoningPreview,
  type TransientPreview,
} from '../shared/adapter-contract.js';
import { baselineRedact, secretScrubber } from '../server/secrets.js';

const identity = {
  projectId: 'P1',
  threadId: 'T1',
  requestId: 'R1',
  runId: 'run-1',
  stepId: 'text:dispatch',
  attempt: 1,
  fence: 1,
};

/** A configured secret, as `redactFor` knows the secrets in scope for a route. */
const KEY = 'sk-test-leak-0123456789abcdef';
const scrub = secretScrubber([KEY]);

/**
 * What the production floor (`baselineRedact`) removes, all in one message: a provider key, a
 * bearer token and a home folder, each of which a chunk boundary can cut anywhere.
 */
const PROSE =
  'Using sk-abcdefghijklmnop for the call. Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.e30.c2ln and C:\\Users\\Andrew\\menu.md done.';
const PROSE_REDACTED =
  'Using [redacted] for the call. Authorization: Bearer [redacted] and [home]\\menu.md done.';

/** Pieces of `size` characters, the way a fixture engine streams. */
const pieces = (text: string, size: number) =>
  Array.from({ length: Math.ceil(text.length / size) }, (_, at) => text.slice(at * size, at * size + size));

/** Pieces of 1 to `most` characters from a seeded generator, so a failing cut replays exactly. */
function chunked(text: string, seed: number, most = 12): string[] {
  let state = seed >>> 0;
  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let mixed = Math.imul(state ^ (state >>> 15), state | 1);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4_294_967_296;
  };
  const cut: string[] = [];
  for (let at = 0; at < text.length; ) {
    const size = 1 + Math.floor(next() * most);
    cut.push(text.slice(at, at + size));
    at += size;
  }
  return cut;
}

const bytes = (text: string) => new TextEncoder().encode(text).byteLength;
/** No half of a surrogate pair stands alone. */
const wellFormed = (text: string) => !/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(text);
const joined = (frames: readonly { text: string }[]) => frames.map((frame) => frame.text).join('');
const dense = (frames: readonly { seq: number }[]) => frames.map((_frame, at) => at + 1);

describe('answer previews are redacted across chunk boundaries', () => {
  test('a secret split across chunks never reaches a frame', () => {
    const frames: TransientPreview[] = [];
    const sink = previewSink({ identity, redact: scrub, onPreview: (frame) => frames.push(frame) });
    for (const piece of pieces(`The menu key is ${KEY}, keep it safe.`, 7)) sink(piece);
    sink.flush();
    expect(joined(frames)).toBe('The menu key is [redacted], keep it safe.');
    expect(frames.map((frame) => frame.seq)).toEqual(dense(frames));
  });

  test('the production floor catches a split key, bearer token and home folder wherever the stream is cut', () => {
    for (let seed = 1; seed <= 200; seed += 1) {
      const frames: TransientPreview[] = [];
      const sink = previewSink({ identity, redact: baselineRedact, onPreview: (frame) => frames.push(frame) });
      for (const piece of chunked(PROSE, seed)) sink(piece);
      sink.flush();
      expect(joined(frames), `cut with seed ${seed}`).toBe(PROSE_REDACTED);
      expect(frames.map((frame) => frame.seq), `cut with seed ${seed}`).toEqual(dense(frames));
    }
  });

  test('a secret as long as the hold is caught when it arrives one character at a time', () => {
    const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
    // No spaces: held as the word being written. With spaces: held as the newest characters.
    const word = Array.from({ length: LIVE_REDACTION.wordChars }, (_, at) => alphabet[at % alphabet.length]).join('');
    const phrase = Array.from({ length: LIVE_REDACTION.holdChars }, (_, at) =>
      at % 6 === 5 ? ' ' : alphabet[at % alphabet.length],
    ).join('');
    for (const secret of [word, phrase]) {
      const frames: TransientPreview[] = [];
      const sink = previewSink({ identity, redact: secretScrubber([secret]), onPreview: (frame) => frames.push(frame) });
      for (const char of `Before ${secret} after.`) sink(char);
      sink.flush();
      expect(joined(frames)).toBe('Before [redacted] after.');
    }
  });

  test('the text streams while it is written, holding back only its newest part', () => {
    const frames: TransientPreview[] = [];
    const sink = previewSink({ identity, redact: scrub, onPreview: (frame) => frames.push(frame) });
    const answer = 'Tomato soup and a grilled cheese, then an apple tart for dessert. Coffee is extra today.';
    for (const piece of pieces(answer, 5)) sink(piece);
    const live = joined(frames);
    expect(live.length).toBeGreaterThan(0);
    expect(answer.startsWith(live)).toBe(true);
    expect(answer.length - live.length).toBeLessThanOrEqual(LIVE_REDACTION.holdChars + 'today.'.length);
    sink.flush();
    expect(joined(frames)).toBe(answer);
  });

  test('a release longer than one frame is split into frames within the budget, never refused', () => {
    const frames: TransientPreview[] = [];
    const failures: PreviewRejection[] = [];
    const sink = previewSink({
      identity,
      redact: scrub,
      onPreview: (frame) => frames.push(frame),
      onInvalid: (failure) => failures.push(failure),
    });
    // One long word, then a chunk exactly at the budget: what the first held back rides along
    // with the second, 256 bytes past one frame.
    const first = '😀'.repeat(200);
    const second = `${'€'.repeat(21_760)}${'a'.repeat(256)}`;
    expect(bytes(second)).toBe(OUTPUT_DELTA.maxChunkBytes);
    sink(first);
    sink(second);
    sink.flush();
    expect(failures).toEqual([]);
    expect(joined(frames)).toBe(first + second);
    for (const frame of frames) {
      expect(bytes(frame.text)).toBeLessThanOrEqual(OUTPUT_DELTA.maxChunkBytes);
      expect(wellFormed(frame.text)).toBe(true);
    }
    expect(frames.map((frame) => frame.seq)).toEqual(dense(frames));
  });

  test('a frame never ends inside a character', () => {
    const frames: TransientPreview[] = [];
    const sink = previewSink({ identity, redact: scrub, onPreview: (frame) => frames.push(frame) });
    const text = `${'😀'.repeat(200)}b`;
    sink(text);
    sink.flush();
    expect(joined(frames)).toBe(text);
    for (const frame of frames) expect(wellFormed(frame.text)).toBe(true);
  });

  test('an over-budget chunk still poisons the stream, and the text it held is never shown', () => {
    const frames: TransientPreview[] = [];
    const failures: PreviewRejection[] = [];
    const sink = previewSink({
      identity,
      redact: scrub,
      onPreview: (frame) => frames.push(frame),
      onInvalid: (failure) => failures.push(failure),
    });
    sink('Soup is ready');
    sink('€'.repeat(30_000)); // 90 KB in UTF-8: refused
    sink('after');
    sink.flush();
    expect(frames).toEqual([]);
    expect(failures).toHaveLength(1);
    expect(failures[0].code).toBe('OUTPUT_LIMIT');
  });

  test('nothing held is shown once the request is stopped', () => {
    const control = new AbortController();
    const frames: TransientPreview[] = [];
    const sink = previewSink({ identity, redact: scrub, signal: control.signal, onPreview: (frame) => frames.push(frame) });
    sink('The soup today is tomato, and the bread is sourdough from the corner bakery.');
    const shown = joined(frames);
    expect(shown.length).toBeGreaterThan(0);
    expect(shown).not.toContain('bakery.');
    control.abort();
    sink(' Late words.');
    sink.flush();
    expect(joined(frames)).toBe(shown);
  });

  test('a second flush sends nothing more', () => {
    const frames: TransientPreview[] = [];
    const sink = previewSink({ identity, redact: scrub, onPreview: (frame) => frames.push(frame) });
    sink('Soup and bread.');
    sink.flush();
    sink.flush();
    expect(frames.map((frame) => [frame.seq, frame.text])).toEqual([[1, 'Soup and bread.']]);
  });
});

describe('live thinking is redacted across chunk boundaries', () => {
  test('a secret split across thinking chunks never reaches a frame, and the saved thinking matches', () => {
    const frames: ReasoningPreview[] = [];
    const sink = reasoningSink({ identity, redact: scrub, onReasoning: (frame) => frames.push(frame) });
    for (const piece of pieces(`Weighing ${KEY} first.`, 7)) sink(piece);
    sink.flush();
    expect(joined(frames)).toBe('Weighing [redacted] first.');
    expect(frames.map((frame) => frame.seq)).toEqual(dense(frames));
    expect(sink.finish()?.text).toBe('Weighing [redacted] first.');
  });

  test('the production floor catches a split key, bearer token and home folder wherever thinking is cut', () => {
    for (let seed = 1; seed <= 200; seed += 1) {
      const frames: ReasoningPreview[] = [];
      const sink = reasoningSink({ identity, redact: baselineRedact, onReasoning: (frame) => frames.push(frame) });
      for (const piece of chunked(PROSE, seed)) sink(piece);
      sink.flush();
      expect(joined(frames), `cut with seed ${seed}`).toBe(PROSE_REDACTED);
      expect(frames.map((frame) => frame.seq), `cut with seed ${seed}`).toEqual(dense(frames));
    }
  });

  test('a redactor that fails never fails the producer, and shows nothing unredacted', () => {
    const frames: ReasoningPreview[] = [];
    const sink = reasoningSink({
      identity,
      redact: () => {
        throw new Error('the redactor broke');
      },
      onReasoning: (frame) => frames.push(frame),
    });
    expect(() => {
      sink('Weighing the menu, then the prices, then the opening hours of the shop.');
      sink.flush();
    }).not.toThrow();
    expect(frames).toEqual([]);
  });

  test('thinking longer than one frame is still split, never inside a character', () => {
    const frames: ReasoningPreview[] = [];
    const sink = reasoningSink({ identity, redact: scrub, onReasoning: (frame) => frames.push(frame) });
    const big = `${'a'.repeat(REASONING.maxChunkBytes - 1)}😀${'b'.repeat(10)}`;
    sink(big);
    sink.flush();
    expect(joined(frames)).toBe(big);
    for (const frame of frames) {
      expect(bytes(frame.text)).toBeLessThanOrEqual(REASONING.maxChunkBytes);
      expect(wellFormed(frame.text)).toBe(true);
    }
  });

  test('nothing held is shown once the request is stopped', () => {
    const control = new AbortController();
    const frames: ReasoningPreview[] = [];
    const sink = reasoningSink({ identity, redact: scrub, signal: control.signal, onReasoning: (frame) => frames.push(frame) });
    sink('Weighing the soup, the bread and the tart against what the kitchen has left today.');
    const shown = joined(frames);
    expect(shown.length).toBeGreaterThan(0);
    control.abort();
    sink.flush();
    expect(joined(frames)).toBe(shown);
    expect(shown).not.toContain('today.');
  });
});

describe('one attempt keeps its live channels in order', () => {
  /** Consecutive frames of one channel, as one run of text. */
  const runs = (events: readonly [string, string][]) =>
    events.reduce<[string, string][]>((merged, [channel, text]) => {
      const last = merged.at(-1);
      if (last && last[0] === channel) last[1] += text;
      else merged.push([channel, text]);
      return merged;
    }, []);

  test.each(['text', 'thinking'] as const)('a tool between %s chunks cannot expose a split credential', channel => {
    const order = liveOrder();
    const events: [string, string][] = [];
    const text = previewSink({ identity, redact: baselineRedact, order, onPreview: frame => events.push(['text', frame.text]) });
    const thinking = reasoningSink({ identity, redact: baselineRedact, order, onReasoning: frame => events.push(['thinking', frame.text]) });
    const tools = activitySink({ identity, redact: baselineRedact, order, onActivity: frame => events.push(['tool', frame.summary]) });
    const sink = channel === 'text' ? text : thinking;
    sink('Credential sk-abcde');
    tools({ callId: 'c1', phase: 'started', tool: 'read', summary: 'Reading menu.md' });
    expect(events).toEqual([]);
    sink('fghijk is private.');
    order.flush();
    const shown = events.filter(([kind]) => kind === channel).map(([, value]) => value).join('');
    expect(shown).toBe('Credential [redacted] is private.');
    expect(JSON.stringify(events)).not.toContain('sk-abcde');
    expect(runs(events)).toEqual([
      [channel, 'Credential '], ['tool', 'Reading menu.md'], [channel, '[redacted] is private.'],
    ]);
    if (channel === 'thinking') expect(thinking.finish()?.text).toBe(shown);
  });

  test('switching repeatedly between text, thinking and tools preserves each channel redaction window', () => {
    const order = liveOrder();
    const events: [string, string][] = [];
    const text = previewSink({ identity, redact: scrub, order, onPreview: frame => events.push(['text', frame.text]) });
    const thinking = reasoningSink({ identity, redact: scrub, order, onReasoning: frame => events.push(['thinking', frame.text]) });
    const tools = activitySink({ identity, redact: scrub, order, onActivity: frame => events.push(['tool', frame.summary]) });
    for (const [i, char] of Array.from(`Before ${KEY} after.`).entries()) {
      text(char);
      thinking(char);
      tools({ callId: `c${i}`, phase: 'finished', tool: 'read', summary: `Read ${i}` });
    }
    order.flush();
    for (const channel of ['text', 'thinking'])
      expect(events.filter(([kind]) => kind === channel).map(([, value]) => value).join('')).toBe('Before [redacted] after.');
    expect(events.filter(([kind]) => kind === 'tool')).toHaveLength(`Before ${KEY} after.`.length);
    expect(JSON.stringify(events)).not.toContain(KEY);
  });

  test('Stop discards both held text and tool frames queued behind it', () => {
    const control = new AbortController();
    const order = liveOrder();
    const events: string[] = [];
    const text = previewSink({ identity, redact: scrub, signal: control.signal, order, onPreview: frame => events.push(frame.text) });
    const tools = activitySink({ identity, redact: scrub, signal: control.signal, order, onActivity: frame => events.push(frame.summary) });
    text('Still being written');
    tools({ callId: 'c1', phase: 'started', tool: 'read', summary: 'Reading menu.md' });
    control.abort();
    order.flush();
    expect(events).toEqual([]);
  });

  test('a long ordered text stream still releases safe output before the attempt ends', () => {
    const order = liveOrder();
    const frames: TransientPreview[] = [];
    const sink = previewSink({ identity, redact: scrub, order, onPreview: frame => frames.push(frame) });
    const answer = 'Tomato soup, bread and coffee are ready. '.repeat(200);
    for (const chunk of pieces(answer, 7)) sink(chunk);
    expect(joined(frames).length).toBeGreaterThan(answer.length - 100);
    expect(answer.startsWith(joined(frames))).toBe(true);
    order.flush();
    expect(joined(frames)).toBe(answer);
    expect(frames.map(frame => frame.seq)).toEqual(dense(frames));
  });

  test('output held behind an incomplete channel is bounded and fails explicitly', () => {
    const order = liveOrder();
    const frames: TransientPreview[] = [];
    const thinking = reasoningSink({ identity, redact: scrub, order });
    const text = previewSink({ identity, redact: scrub, order, onPreview: frame => frames.push(frame) });
    thinking('Still thinking');
    const chunk = 'word '.repeat(12_000);
    expect(() => {
      for (let i = 0; i < 40; i++) text(chunk);
    }).toThrow('waiting for redaction');
    expect(frames).toEqual([]);
    expect(() => order.flush()).toThrow('waiting for redaction');
  });

  test('thinking never restarts a partial redaction window after interleaved queue overflow', () => {
    const order = liveOrder();
    const frames: ReasoningPreview[] = [];
    const thinking = reasoningSink({ identity, redact: baselineRedact, order, onReasoning: frame => frames.push(frame) });
    const tools = activitySink({ identity, order });
    thinking('Credential sk-abcde');
    for (let i = 0; i < LIVE_REDACTION.pendingFrames - 1; i++)
      tools({ callId: 'c', phase: 'started', tool: 'read', summary: 'Read' });
    expect(() => thinking('fghijk')).not.toThrow();
    thinking('lmnopqrstuvwxyz is private.');
    order.flush();
    expect(frames).toEqual([]);
    expect(thinking.finish()).toBeNull();
  });

  test('a throwing redactor discards subsequent thinking and the saved partial record', () => {
    const order = liveOrder();
    const frames: ReasoningPreview[] = [];
    let broken = false;
    const thinking = reasoningSink({ identity, order, onReasoning: frame => frames.push(frame), redact: text => {
      if (broken) throw new Error('Redaction failed');
      return baselineRedact(text);
    } });
    thinking('Credential sk-abcde');
    broken = true;
    thinking('fghijk followed by enough text to trigger a redaction pass.');
    broken = false;
    thinking('lmnopqrstuvwxyz is private.');
    order.flush();
    expect(frames).toEqual([]);
    expect(thinking.finish()).toBeNull();
  });

  test('ordered thinking without a redactor also discards on overflow without failing the answer', () => {
    const order = liveOrder();
    order.join(() => {}).reserve(LIVE_REDACTION.pendingChars);
    const frames: ReasoningPreview[] = [];
    const thinking = reasoningSink({ identity, order, onReasoning: frame => frames.push(frame) });
    expect(() => thinking('No room')).not.toThrow();
    thinking('Later output');
    expect(() => order.flush()).not.toThrow();
    expect(frames).toEqual([]);
    expect(thinking.finish()).toBeNull();
  });

  test('preview overflow uses the host refusal callback and cannot be swallowed into a successful finish', () => {
    const order = liveOrder();
    order.join(() => {}).reserve(LIVE_REDACTION.pendingChars);
    const failures: PreviewRejection[] = [];
    const frames: TransientPreview[] = [];
    const text = previewSink({ identity, redact: scrub, order,
      onInvalid: failure => failures.push(failure), onPreview: frame => frames.push(frame) });
    expect(() => text('No room')).not.toThrow();
    text('Later text must stay discarded');
    expect(failures).toEqual([{ code: 'OUTPUT_LIMIT', reason: expect.stringContaining('waiting for redaction') }]);
    expect(frames).toEqual([]);
    expect(() => order.flush()).toThrow('waiting for redaction');
  });

  test('a failed preview redactor discards the partial window before later callbacks or finish', () => {
    const order = liveOrder();
    const frames: TransientPreview[] = [];
    let broken = false;
    const text = previewSink({ identity, order, onPreview: frame => frames.push(frame), redact: value => {
      if (broken) throw new Error('Redaction failed');
      return baselineRedact(value);
    } });
    text('Credential sk-abcde');
    broken = true;
    expect(() => text('fghijk')).toThrow('Redaction failed');
    broken = false;
    text('lmnopqrstuvwxyz is private.');
    order.flush();
    expect(frames).toEqual([]);
  });

  test('held text is shown before a later tool line, and thinking before the answer', () => {
    const order = liveOrder();
    const events: [string, string][] = [];
    const thinking = reasoningSink({ identity, redact: scrub, order, onReasoning: (frame) => events.push(['think', frame.text]) });
    const text = previewSink({ identity, redact: scrub, order, onPreview: (frame) => events.push(['text', frame.text]) });
    const tools = activitySink({ identity, redact: scrub, order, onActivity: (frame) => events.push(['tool', frame.summary]) });
    thinking('Weighing the menu.');
    text('Let me read menu.md.');
    tools({ callId: 'c1', phase: 'started', tool: 'read', summary: 'Reading menu.md' });
    text(' Soup and bread.');
    order.flush();
    order.flush();
    expect(runs(events)).toEqual([
      ['think', 'Weighing the menu.'],
      ['text', 'Let me read menu.md.'],
      ['tool', 'Reading menu.md'],
      ['text', ' Soup and bread.'],
    ]);
  });

  test('a secret split across one channel is still caught when another channel speaks after it', () => {
    const order = liveOrder();
    const events: [string, string][] = [];
    const thinking = reasoningSink({ identity, redact: scrub, order, onReasoning: (frame) => events.push(['think', frame.text]) });
    const text = previewSink({ identity, redact: scrub, order, onPreview: (frame) => events.push(['text', frame.text]) });
    for (const piece of pieces(`Checking ${KEY} now.`, 6)) thinking(piece);
    text('Here it is.');
    order.flush();
    expect(runs(events)).toEqual([
      ['think', 'Checking [redacted] now.'],
      ['text', 'Here it is.'],
    ]);
  });
});
