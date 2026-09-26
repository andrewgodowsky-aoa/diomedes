/**
 * A small RFC 6455 server endpoint over a Node socket, for the faux cloud's
 * relay hub. Node ships a WebSocket client but no server, and this package adds
 * no dependencies, so the faux cloud speaks the protocol itself: the opening
 * handshake (section 4.2), text and binary frames with fragmentation, close,
 * ping and pong (section 5). Client frames must be masked. No extension or
 * subprotocol is negotiated, so the reserved bits must be clear. Loopback only;
 * never part of the Worker bundle.
 */
import { createHash } from 'node:crypto';
import type { Duplex } from 'node:stream';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

/** The largest message the faux endpoint reads. The relay itself refuses anything over 4,096 bytes. */
export const FAUX_WEBSOCKET_MAX_MESSAGE = 65_536;

/** The Sec-WebSocket-Accept value for a client's key (section 4.2.2). */
export function acceptValue(key: string): string {
  return createHash('sha1').update(key + GUID).digest('base64');
}

/** The client's key when a request is a well-formed version 13 opening handshake (section 4.2.1), otherwise null. */
export function upgradeKey(headers: Headers): string | null {
  const connection = (headers.get('connection') ?? '').toLowerCase().split(',').map((token) => token.trim());
  const key = headers.get('sec-websocket-key') ?? '';
  if (headers.get('upgrade')?.toLowerCase() !== 'websocket' || !connection.includes('upgrade')) return null;
  if (headers.get('sec-websocket-version') !== '13' || !/^[A-Za-z0-9+/]{22}==$/.test(key)) return null;
  return key;
}

/** The server's side of the opening handshake. */
export function switchingProtocols(key: string): string {
  return ['HTTP/1.1 101 Switching Protocols', 'Upgrade: websocket', 'Connection: Upgrade', `Sec-WebSocket-Accept: ${acceptValue(key)}`, '', ''].join('\r\n');
}

/** Close codes a peer may send (section 7.4 and the IANA registry). */
function sendable(code: number): boolean {
  return (code >= 1000 && code <= 1014 && code !== 1004 && code !== 1005 && code !== 1006) || (code >= 3000 && code <= 4999);
}

export interface FauxWebSocketHandlers {
  message(data: string | Uint8Array): void;
  /** Once, when the connection is gone: the code and reason of the close, or 1006 without one. */
  close(code: number, reason: string): void;
}

interface Frame {
  fin: boolean;
  opcode: number;
  payload: Buffer;
}

const decoder = new TextDecoder('utf-8', { fatal: true });

export class FauxWebSocket {
  /** 1 open, 2 closing, 3 closed, as a WebSocket's readyState. */
  readyState: 1 | 2 | 3 = 1;
  private buffer: Buffer = Buffer.alloc(0);
  private fragments: Buffer[] = [];
  private fragmentOpcode = 0;
  private fragmentBytes = 0;
  private failed = false;
  private code = 1006;
  private reason = '';
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly socket: Duplex,
    private readonly head: Buffer,
    private readonly handlers: FauxWebSocketHandlers,
    private readonly maxMessage = FAUX_WEBSOCKET_MAX_MESSAGE,
  ) {}

  /** Starts reading. Call once the handlers can take a message: the handshake may carry frames already. */
  start(): void {
    this.socket.on('data', (chunk: Buffer) => this.receive(chunk));
    // An HTTP server's sockets allow half-open connections: when the client stops sending, finish ours too.
    this.socket.on('end', () => this.socket.end());
    this.socket.on('close', () => this.finished());
    this.socket.on('error', () => this.socket.destroy());
    if (this.head.length) this.receive(this.head);
  }

  send(text: string): void {
    if (this.readyState === 1) this.write(0x1, Buffer.from(text, 'utf8'));
  }

  /** Starts the closing handshake. The client answers with its own close frame; after a second, the socket goes. */
  close(code: number, reason: string): void {
    if (this.readyState !== 1) return;
    this.readyState = 2;
    this.code = code;
    this.reason = reason;
    this.writeClose(code, reason);
    this.later(() => this.socket.destroy());
  }

  /** Drops the connection without a closing handshake. */
  terminate(): void {
    this.socket.destroy();
  }

  private later(action: () => void): void {
    if (this.timer) return;
    this.timer = setTimeout(action, 1_000);
    this.timer.unref();
  }

  /** Failed, or closed: nothing more is read. */
  private get gone(): boolean {
    return this.failed || this.readyState === 3;
  }

  private receive(chunk: Buffer): void {
    if (this.gone) return;
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
    for (;;) {
      const frame = this.parse();
      if (!frame) return;
      this.handle(frame);
      if (this.gone) return;
    }
  }

  /** The next whole frame, or null until more bytes arrive (or after a failure). */
  private parse(): Frame | null {
    const buffer = this.buffer;
    if (buffer.length < 2) return null;
    const fin = (buffer[0] & 0x80) !== 0;
    const opcode = buffer[0] & 0x0f;
    if (buffer[0] & 0x70) return this.fail(1002, 'reserved bits set');
    if (!(buffer[1] & 0x80)) return this.fail(1002, 'client frames are masked');
    let length = buffer[1] & 0x7f;
    let offset = 2;
    if (length === 126) {
      if (buffer.length < 4) return null;
      length = buffer.readUInt16BE(2);
      offset = 4;
    } else if (length === 127) {
      if (buffer.length < 10) return null;
      if (buffer.readUInt32BE(2) !== 0) return this.fail(1009, 'message too big');
      length = buffer.readUInt32BE(6);
      offset = 10;
    }
    if (opcode >= 0x8 && (!fin || length > 125)) return this.fail(1002, 'invalid control frame');
    if (length > this.maxMessage) return this.fail(1009, 'message too big');
    if (buffer.length < offset + 4 + length) return null;
    const mask = buffer.subarray(offset, offset + 4);
    const payload = Buffer.from(buffer.subarray(offset + 4, offset + 4 + length));
    for (let index = 0; index < payload.length; index++) payload[index] ^= mask[index & 3];
    this.buffer = buffer.subarray(offset + 4 + length);
    return { fin, opcode, payload };
  }

  private handle({ fin, opcode, payload }: Frame): void {
    switch (opcode) {
      case 0x0:
        if (!this.fragmentOpcode) return void this.fail(1002, 'unexpected continuation');
        this.fragmentBytes += payload.length;
        if (this.fragmentBytes > this.maxMessage) return void this.fail(1009, 'message too big');
        this.fragments.push(payload);
        if (fin) {
          const opcodeOfMessage = this.fragmentOpcode;
          const whole = Buffer.concat(this.fragments);
          this.fragments = [];
          this.fragmentOpcode = 0;
          this.fragmentBytes = 0;
          this.deliver(opcodeOfMessage, whole);
        }
        return;
      case 0x1:
      case 0x2:
        if (this.fragmentOpcode) return void this.fail(1002, 'expected a continuation');
        if (fin) return this.deliver(opcode, payload);
        this.fragmentOpcode = opcode;
        this.fragments = [payload];
        this.fragmentBytes = payload.length;
        return;
      case 0x8:
        return this.receivedClose(payload);
      case 0x9:
        if (this.readyState === 1) this.write(0xa, payload);
        return;
      case 0xa:
        return;
      default:
        return void this.fail(1002, 'unknown opcode');
    }
  }

  private deliver(opcode: number, payload: Buffer): void {
    if (this.readyState !== 1) return;
    if (opcode === 0x2) return this.handlers.message(new Uint8Array(payload));
    let text: string;
    try {
      text = decoder.decode(payload);
    } catch {
      return void this.fail(1007, 'invalid UTF-8');
    }
    this.handlers.message(text);
  }

  private receivedClose(payload: Buffer): void {
    let code = 1005;
    let reason = '';
    if (payload.length === 1) return void this.fail(1002, 'invalid close frame');
    if (payload.length >= 2) {
      code = payload.readUInt16BE(0);
      if (!sendable(code)) return void this.fail(1002, 'invalid close code');
      try {
        reason = decoder.decode(payload.subarray(2));
      } catch {
        return void this.fail(1007, 'invalid UTF-8');
      }
    }
    if (this.readyState === 1) {
      // The client closed first: answer with its code (section 5.5.1).
      this.readyState = 2;
      this.code = code;
      this.reason = reason;
      this.writeClose(code === 1005 ? null : code, '');
    }
    // The server ends the TCP connection first (section 7.1.1).
    this.socket.end();
    this.later(() => this.socket.destroy());
  }

  /** A protocol error: close with its code and stop reading. */
  private fail(code: number, reason: string): null {
    this.failed = true;
    this.buffer = Buffer.alloc(0);
    if (this.readyState === 1) {
      this.readyState = 2;
      this.code = code;
      this.reason = reason;
      this.writeClose(code, reason);
    }
    this.socket.end();
    this.later(() => this.socket.destroy());
    return null;
  }

  private finished(): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    if (this.timer) clearTimeout(this.timer);
    this.handlers.close(this.code, this.reason);
  }

  private writeClose(code: number | null, reason: string): void {
    const payload = code === null ? Buffer.alloc(0)
      : Buffer.concat([Buffer.from([code >> 8, code & 0xff]), Buffer.from(reason, 'utf8').subarray(0, 123)]);
    this.write(0x8, payload);
  }

  private write(opcode: number, payload: Buffer): void {
    if (this.socket.destroyed || !this.socket.writable) return;
    let header: Buffer;
    if (payload.length < 126) header = Buffer.from([0x80 | opcode, payload.length]);
    else if (payload.length < 65_536) {
      header = Buffer.alloc(4);
      header[0] = 0x80 | opcode;
      header[1] = 126;
      header.writeUInt16BE(payload.length, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x80 | opcode;
      header[1] = 127;
      header.writeUInt32BE(0, 2);
      header.writeUInt32BE(payload.length, 6);
    }
    this.socket.write(Buffer.concat([header, payload]));
  }
}
