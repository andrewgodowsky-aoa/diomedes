/**
 * Server-sent events, framed the way the format actually allows.
 *
 * A stream may end its lines with LF, CRLF or CR, may spread one event's text
 * across several `data` fields, and may carry comments and fields this route
 * does not read. A parser that looks for `\n\n` and takes the first `data:`
 * line accepts a narrower format than a conforming provider or an intermediary
 * may send, so this follows the specification's own "interpreting an event
 * stream" algorithm instead.
 *
 * It frames; it judges nothing. Session and model attribution, malformed
 * payloads, tool events, retries and what counts as a finished answer all stay
 * with the adapter, where they can be refused.
 */

/** One dispatched event. `id` and `retry` are parsed but no reader here uses them. */
export interface SseEvent {
  /** The `event` field, or `message` when the stream named none. */
  event: string;
  /** Every `data` field of this event, joined with a newline. */
  data: string;
}

/**
 * A single event grew past the parser's bound before a blank line ended it. A
 * stream that never dispatches must not be able to grow this buffer for ever.
 */
export class SseLimitError extends Error {
  constructor(readonly limit: number) {
    super(`A server-sent event passed ${limit} bytes before it was dispatched.`);
    this.name = 'SseLimitError';
  }
}

const DEFAULT_LIMIT = 1024 * 1024;

export class SseParser {
  /**
   * Streaming UTF-8: a character split across chunks survives, and the decoder
   * removes one leading byte order mark. A second mark is content and stays.
   */
  private readonly decoder = new TextDecoder();
  private readonly limit: number;
  private pending = '';
  private pendingBytes = 0;
  private data = '';
  private dataBytes = 0;
  private eventType = '';
  private idBuffer = '';
  /** A carriage return ended the last chunk; the line feed opening the next belongs to it. */
  private joinLineFeed = false;
  /** The last dispatched `id`. Recorded per the specification; nothing here reconnects. */
  lastEventId = '';
  /** The last reconnection time the stream offered, in milliseconds. Nothing here reconnects. */
  retryMs: number | null = null;

  constructor(options: { maxBufferBytes?: number } = {}) {
    this.limit = options.maxBufferBytes ?? DEFAULT_LIMIT;
  }

  /** Feed one chunk of bytes and take whatever events it completed. */
  push(chunk: Uint8Array): SseEvent[] {
    const text = this.decoder.decode(chunk, { stream: true });
    const events: SseEvent[] = [];
    let index = 0;
    while (index < text.length) {
      if (this.joinLineFeed) {
        this.joinLineFeed = false;
        if (text[index] === '\n') {
          index += 1;
          continue;
        }
      }
      let cut = -1;
      let skip = 0;
      for (let at = index; at < text.length; at += 1) {
        const character = text[at];
        if (character === '\n') {
          cut = at;
          skip = 1;
          break;
        }
        if (character === '\r') {
          cut = at;
          skip = 1;
          if (at + 1 === text.length) this.joinLineFeed = true;
          else if (text[at + 1] === '\n') skip = 2;
          break;
        }
      }
      if (cut < 0) {
        this.hold(text.slice(index));
        break;
      }
      this.hold(text.slice(index, cut));
      index = cut + skip;
      const line = this.pending;
      this.pending = '';
      this.pendingBytes = 0;
      const event = this.field(line);
      if (event) events.push(event);
    }
    return events;
  }

  private hold(segment: string) {
    if (!segment) return;
    this.pending += segment;
    this.pendingBytes += Buffer.byteLength(segment);
    this.bound();
  }
  private bound() {
    if (this.pendingBytes + this.dataBytes > this.limit) throw new SseLimitError(this.limit);
  }
  private field(line: string): SseEvent | undefined {
    if (line === '') return this.dispatch();
    if (line.startsWith(':')) return undefined;
    const colon = line.indexOf(':');
    const name = colon < 0 ? line : line.slice(0, colon);
    let value = colon < 0 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (name === 'event') this.eventType = value;
    else if (name === 'data') {
      this.data += `${value}\n`;
      this.dataBytes += Buffer.byteLength(value) + 1;
      this.bound();
    } else if (name === 'id') {
      if (!value.includes('\0')) this.idBuffer = value;
    } else if (name === 'retry') {
      if (/^[0-9]+$/.test(value)) this.retryMs = Number(value);
    }
    return undefined;
  }
  /**
   * A blank line ends an event. An event that collected no `data` field is not
   * dispatched at all, so a heartbeat comment or a bare `event:` stays silent.
   */
  private dispatch(): SseEvent | undefined {
    this.lastEventId = this.idBuffer;
    const data = this.data;
    const event = this.eventType;
    this.data = '';
    this.dataBytes = 0;
    this.eventType = '';
    if (data === '') return undefined;
    return { event: event || 'message', data: data.endsWith('\n') ? data.slice(0, -1) : data };
  }
}
