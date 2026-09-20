import { describe, expect, it } from 'vitest';
import { SseLimitError, SseParser } from '../server/engines/sse.js';

const encoder = new TextEncoder();
const bytes = (value: string) => encoder.encode(value);
/** Push each piece as its own chunk, the way a socket delivers them. */
function parse(parser: SseParser, ...pieces: (string | Uint8Array)[]) {
  return pieces.flatMap((piece) =>
    parser.push(typeof piece === 'string' ? bytes(piece) : piece),
  );
}

describe('server-sent event framing', () => {
  it('reads a line-feed stream', () => {
    expect(parse(new SseParser(), 'data: one\n\n')).toEqual([{ event: 'message', data: 'one' }]);
  });
  it('reads a carriage-return line-feed stream', () => {
    expect(parse(new SseParser(), 'data: one\r\n\r\n')).toEqual([{ event: 'message', data: 'one' }]);
  });
  it('reads a carriage-return stream', () => {
    expect(parse(new SseParser(), 'data: one\r\r')).toEqual([{ event: 'message', data: 'one' }]);
  });
  it('treats a CR ending one chunk and its LF in the next as one line ending', () => {
    // Counting them separately would end the first line twice, dispatching
    // `one` on its own and leaving `two` in a second event.
    const events = parse(new SseParser(), 'data: one\r', '\ndata: two\n\n');
    expect(events).toEqual([{ event: 'message', data: 'one\ntwo' }]);
  });
  it('does not dispatch an empty event for the second half of a split line ending', () => {
    expect(parse(new SseParser(), 'data: one\r', '\n\n')).toEqual([
      { event: 'message', data: 'one' },
    ]);
  });
  it('joins repeated data fields with a newline', () => {
    expect(parse(new SseParser(), 'data: {"a":1,\ndata: "b":2}\n\n')).toEqual([
      { event: 'message', data: '{"a":1,\n"b":2}' },
    ]);
  });
  it('ignores comments and fields it does not use', () => {
    const events = parse(new SseParser(), ': heartbeat\nx-vendor: 1\ndata: one\n\n');
    expect(events).toEqual([{ event: 'message', data: 'one' }]);
  });
  it('dispatches nothing for a comment-only frame', () => {
    expect(parse(new SseParser(), ': heartbeat\n\n')).toEqual([]);
  });
  it('strips one leading byte order mark and keeps a second as content', () => {
    expect(parse(new SseParser(), '﻿data: one\n\n')).toEqual([
      { event: 'message', data: 'one' },
    ]);
    expect(parse(new SseParser(), '﻿﻿data: one\n\n')).toEqual([]);
  });
  it('keeps a UTF-8 character that arrives across three chunks', () => {
    const parser = new SseParser();
    const payload = bytes('data: {"t":"\u{1F680}"}\n\n');
    const rocket = payload.indexOf(0xf0);
    const events = parse(
      parser,
      payload.slice(0, rocket + 1),
      payload.slice(rocket + 1, rocket + 3),
      payload.slice(rocket + 3),
    );
    expect(events).toEqual([{ event: 'message', data: '{"t":"\u{1F680}"}' }]);
  });
  it('holds a partial line across a chunk boundary', () => {
    const parser = new SseParser();
    expect(parse(parser, 'data: he')).toEqual([]);
    expect(parse(parser, 'llo\n\n')).toEqual([{ event: 'message', data: 'hello' }]);
  });
  it('discards an unfinished trailing event rather than dispatching it', () => {
    expect(parse(new SseParser(), 'data: one\n\ndata: two\n')).toEqual([
      { event: 'message', data: 'one' },
    ]);
  });
  it('names the event type and defaults to message', () => {
    expect(parse(new SseParser(), 'event: ping\ndata: one\n\ndata: two\n\n')).toEqual([
      { event: 'ping', data: 'one' },
      { event: 'message', data: 'two' },
    ]);
  });
  it('removes exactly one space after the colon', () => {
    expect(parse(new SseParser(), 'data:  one\n\n')).toEqual([{ event: 'message', data: ' one' }]);
    expect(parse(new SseParser(), 'data:one\n\n')).toEqual([{ event: 'message', data: 'one' }]);
  });
  it('treats a line with no colon as a field with an empty value', () => {
    expect(parse(new SseParser(), 'data\n\n')).toEqual([{ event: 'message', data: '' }]);
  });
  it('parses id and retry per the specification and exposes neither on the event', () => {
    const parser = new SseParser();
    const events = parse(parser, 'id: 7\nretry: 2500\ndata: one\n\n');
    expect(events).toEqual([{ event: 'message', data: 'one' }]);
    expect(parser.lastEventId).toBe('7');
    expect(parser.retryMs).toBe(2500);
  });
  it('ignores a non-numeric retry and an id carrying a null character', () => {
    const parser = new SseParser();
    parse(parser, 'id: 7\n\n');
    parse(parser, 'id: bad\0id\nretry: soon\ndata: one\n\n');
    expect(parser.lastEventId).toBe('7');
    expect(parser.retryMs).toBeNull();
  });
  it('refuses an unterminated line past its byte bound', () => {
    const parser = new SseParser({ maxBufferBytes: 64 });
    expect(() => parse(parser, `data: ${'x'.repeat(200)}`)).toThrow(SseLimitError);
  });
  it('refuses data fields that accumulate past its byte bound without a blank line', () => {
    const parser = new SseParser({ maxBufferBytes: 64 });
    expect(() => parse(parser, 'data: xxxxxxxxxx\n'.repeat(20))).toThrow(SseLimitError);
  });
  it('counts the bound in bytes, not characters', () => {
    const parser = new SseParser({ maxBufferBytes: 32 });
    expect(() => parse(parser, `data: ${'\u{1F680}'.repeat(12)}`)).toThrow(SseLimitError);
  });
  it('releases the bound once an event is dispatched', () => {
    const parser = new SseParser({ maxBufferBytes: 64 });
    for (let round = 0; round < 40; round += 1)
      expect(parse(parser, 'data: xxxxxxxxxxxxxxxxxxxx\n\n')).toEqual([
        { event: 'message', data: 'x'.repeat(20) },
      ]);
  });
});
