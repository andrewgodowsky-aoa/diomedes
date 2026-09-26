/**
 * One outbound connection from this computer to its business's relay hub
 * (relay plan steps 1 and 2, 2026-09-26). The wire contract is
 * services/control-plane/src/relay/protocol.ts.
 *
 * The desktop never listens. A link dials out with the signed-in person's
 * bearer, answers the hub's challenge with this computer's key, pings every
 * `heartbeatMs`, and dials again with backoff when the connection drops.
 * Shortly before the bearer it dialled with expires, it dials a second
 * connection and lets the hub replace the first, so the computer stays
 * reachable across a sign-in's renewal. A refusal stops the link and says why
 * in one sentence. Frames it doesn't know are ignored: later steps add message
 * types after `ready` without changing the handshake.
 */
import type { KeyObject } from 'node:crypto';
import {
  RELAY_CLOSE,
  RELAY_DEVICE_HEADER,
  RELAY_PING_FRAME,
  parseHubMessage,
  type ReadyMessage,
} from '../../services/control-plane/src/relay/protocol.js';
import { proveChallenge } from './keys.js';

/** The WHATWG WebSocket surface a link uses. */
export interface RelaySocket {
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event: { code: number; reason: string }) => void) | null;
  onerror: ((event: unknown) => void) | null;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

/** Opens a client socket with request headers. Node's WebSocket (undici) takes them; a browser's doesn't. */
export type RelaySocketFactory = (url: string, headers: Record<string, string>) => RelaySocket;

/** The runtime's own WebSocket client, or null where there is none. It only ever dials out. */
export function runtimeRelaySocket(): RelaySocketFactory | null {
  const Native = (globalThis as { WebSocket?: unknown }).WebSocket;
  if (typeof Native !== 'function') return null;
  const Client = Native as new (url: string, init: { headers: Record<string, string> }) => RelaySocket;
  return (url, headers) => new Client(url, { headers });
}

/** What the account service said when asked, as a link reads it. */
export type RelayAnswer =
  | { kind: 'ok' }
  | { kind: 'unreachable' }
  | { kind: 'refused'; status: number; code: string | null; sentence: string };
export type RelayBearer = { kind: 'ok'; token: string } | Exclude<RelayAnswer, { kind: 'ok' }>;

export interface LinkStatus {
  state: 'connecting' | 'reachable' | 'error';
  /** One plain sentence for `error`, null otherwise. */
  sentence: string | null;
}

export interface LinkStop {
  sentence: string;
  /** The device record is gone at the account service: forget this computer's key. */
  forget: boolean;
  /** A later sign-in or refresh may dial again: the refusal was about membership, the plan or the sign-in. */
  retry: boolean;
}

/** The sentences a link reports. The refusals the service answers over HTTP carry the service's own. */
export const LINK_SENTENCES = {
  unreachable: "Can't reach the account service. Trying again.",
  signedOut: 'Your sign-in ended. Sign in again to reach this computer from your phone.',
  stoppedElsewhere: 'Phone access to this computer was stopped from another device.',
  keyMismatch: "This computer's key for phone access didn't match. Turn it off and on again.",
  protocol: 'The relay answered in a way this version of Nectovia doesn’t understand. Turn it off and on again.',
  takenOver: 'Another copy of Nectovia on this computer took over phone access.',
} as const;

export interface RelayLinkOptions {
  /** wss://…/relay/v1/organizations/:id/desktop */
  url: string;
  organizationId: string;
  deviceId: string;
  key: KeyObject;
  /** A live bearer for the person who registered this computer. */
  token(): Promise<RelayBearer>;
  /** The same checks as a dial, answered in JSON: why an upgrade was refused. */
  check(): Promise<RelayAnswer>;
  socket: RelaySocketFactory;
  status(status: LinkStatus): void;
  stopped(stop: LinkStop): void;
  /** The sentence for each 4403 reason: not_a_member, role_not_allowed, phone_relay_not_included. */
  refusals: Record<string, string>;
  log?: (line: string) => void;
  now?: () => number;
  random?: () => number;
}

/** Dial again after 1, 2, 4 … seconds, at most a minute, each within 20 percent either way. */
export const RELAY_BACKOFF = { firstMs: 1_000, maxMs: 60_000, jitter: 0.2 } as const;
/** Dial the next connection this long before the bearer the current one was opened with expires. */
export const RELAY_RENEW_BEFORE_MS = 30_000;
/** The soonest a renewal is dialled after a connection is ready, whatever the clocks say. */
export const RELAY_RENEW_FLOOR_MS = 15_000;

export function backoffMs(failures: number, random: () => number = Math.random): number {
  const base = Math.min(RELAY_BACKOFF.maxMs, RELAY_BACKOFF.firstMs * 2 ** Math.min(failures, 16));
  return Math.round(base * (1 - RELAY_BACKOFF.jitter + 2 * RELAY_BACKOFF.jitter * random()));
}

interface Dial {
  socket: RelaySocket;
  opened: boolean;
  proved: boolean;
  ready: ReadyMessage | null;
  heardAt: number;
  /** Its events no longer count: replaced, timed out, closed or stopped. */
  done: boolean;
}

type Next = { kind: 'now' } | { kind: 'again'; sentence: string | null } | { kind: 'stop'; stop: LinkStop };

export class RelayLink {
  private current: Dial | null = null;
  private renewal: Dial | null = null;
  private failures = 0;
  private redial: NodeJS.Timeout | null = null;
  private heartbeat: NodeJS.Timeout | null = null;
  private renew: NodeJS.Timeout | null = null;
  private ended = false;
  private reported = '';
  private readonly now: () => number;
  private readonly random: () => number;

  constructor(private readonly options: RelayLinkOptions) {
    this.now = options.now ?? Date.now;
    this.random = options.random ?? Math.random;
  }

  start(): void {
    this.report({ state: 'connecting', sentence: null });
    void this.dial(false);
  }

  /** Closes every socket and cancels every timer. Nothing is sent or reported after this. */
  stop(): void {
    if (this.ended) return;
    this.ended = true;
    this.quiet();
    if (this.redial) clearTimeout(this.redial);
    this.redial = null;
    for (const dial of [this.current, this.renewal]) if (dial && !dial.done) this.detach(dial, 1000, 'stopped');
    this.current = this.renewal = null;
    this.options.log?.(`Phone access for ${this.options.deviceId}: stopped.`);
  }

  private async dial(renewal: boolean): Promise<void> {
    if (this.ended) return;
    const bearer = await this.options.token();
    if (this.ended) return;
    if (bearer.kind !== 'ok') {
      // A renewal that can't get a bearer leaves the open connection to run until its own expires.
      if (!renewal) this.follow(this.answered(bearer));
      return;
    }
    let socket: RelaySocket;
    try {
      socket = this.options.socket(this.options.url, {
        authorization: `Bearer ${bearer.token}`,
        [RELAY_DEVICE_HEADER]: this.options.deviceId,
      });
    } catch {
      if (!renewal) this.follow({ kind: 'again', sentence: null });
      return;
    }
    const dial: Dial = { socket, opened: false, proved: false, ready: null, heardAt: this.now(), done: false };
    if (renewal) this.renewal = dial;
    else this.current = dial;
    socket.onopen = () => {
      dial.opened = true;
      dial.heardAt = this.now();
    };
    socket.onmessage = (event) => this.message(dial, event.data);
    socket.onclose = (event) => this.closed(dial, event.code, event.reason);
    // A close always follows an error, and says more.
    socket.onerror = () => {};
  }

  private message(dial: Dial, data: unknown) {
    if (dial.done || this.ended || typeof data !== 'string') return;
    dial.heardAt = this.now();
    const message = parseHubMessage(data);
    if (!message) return;
    if (message.type === 'challenge') {
      if (dial.proved || message.organizationId !== this.options.organizationId || message.deviceId !== this.options.deviceId) {
        this.detach(dial, RELAY_CLOSE.protocolError.code, RELAY_CLOSE.protocolError.reason);
        return this.halt({ sentence: LINK_SENTENCES.protocol, forget: false, retry: false });
      }
      dial.proved = true;
      dial.socket.send(JSON.stringify({ v: 1, type: 'prove', signature: proveChallenge(this.options.key, message) }));
      return;
    }
    if (message.type === 'ready' && dial.proved && !dial.ready) {
      dial.ready = message;
      this.promote(dial);
    }
    // A pong only shows the hub is there, which heardAt already records.
  }

  private promote(dial: Dial) {
    if (dial === this.renewal) {
      const old = this.current;
      this.renewal = null;
      this.current = dial;
      // The hub replaced it when this one proved its key; closing ours too is harmless.
      if (old) this.detach(old, 1000, 'renewed');
    }
    this.failures = 0;
    const ready = dial.ready!;
    this.quiet();
    this.heartbeat = setInterval(() => this.pulse(), ready.heartbeatMs);
    this.heartbeat.unref?.();
    const renewAt = Date.parse(ready.authorizedUntil) - RELAY_RENEW_BEFORE_MS - this.now();
    this.renew = setTimeout(() => {
      this.renew = null;
      if (!this.ended && !this.renewal && this.current?.ready) void this.dial(true);
    }, Math.max(RELAY_RENEW_FLOOR_MS, renewAt));
    this.renew.unref?.();
    this.report({ state: 'reachable', sentence: null });
  }

  /** Every heartbeat: ping, or give up on a hub that has gone quiet and dial again. */
  private pulse() {
    const dial = this.current;
    if (this.ended || !dial?.ready || dial.done) return;
    if (this.now() - dial.heardAt > dial.ready.timeoutMs) {
      this.detach(dial, RELAY_CLOSE.heartbeatTimeout.code, RELAY_CLOSE.heartbeatTimeout.reason);
      if (this.renewal) this.detach(this.renewal, 1000, 'restarting');
      this.current = this.renewal = null;
      this.quiet();
      return this.follow({ kind: 'again', sentence: null });
    }
    try {
      dial.socket.send(RELAY_PING_FRAME);
    } catch {
      // The close that follows decides.
    }
  }

  private closed(dial: Dial, code: number, reason: string) {
    if (dial.done || this.ended) return;
    dial.done = true;
    if (dial === this.renewal) {
      this.renewal = null;
      // A renewal that failed leaves the open connection to run until its bearer expires (4000).
      if (this.current) return;
      return void this.after(dial, code, reason);
    }
    if (dial !== this.current) return;
    this.current = null;
    this.quiet();
    // Replaced by this link's own renewal, which proved first and carries on.
    if (code === RELAY_CLOSE.replaced.code && this.renewal) return;
    void this.after(dial, code, reason);
  }

  private async after(dial: Dial, code: number, reason: string) {
    if (!dial.opened) {
      // A refused upgrade shows no reason; the plain check gives it.
      const answer = await this.options.check();
      if (this.ended) return;
      return this.follow(answer.kind === 'ok' ? { kind: 'again', sentence: null } : this.answered(answer));
    }
    this.options.log?.(`Phone access for ${this.options.deviceId}: closed ${code} ${reason}.`);
    this.follow(this.classify(code, reason));
  }

  /** What a close code means for this link. */
  private classify(code: number, reason: string): Next {
    switch (code) {
      case RELAY_CLOSE.sessionExpired.code:
        return { kind: 'now' };
      case RELAY_CLOSE.protocolError.code:
        return { kind: 'stop', stop: { sentence: LINK_SENTENCES.protocol, forget: false, retry: false } };
      case RELAY_CLOSE.sessionEnded.code:
        return reason === RELAY_CLOSE.badSignature.reason
          ? { kind: 'stop', stop: { sentence: LINK_SENTENCES.keyMismatch, forget: false, retry: false } }
          : { kind: 'stop', stop: { sentence: LINK_SENTENCES.signedOut, forget: false, retry: true } };
      case RELAY_CLOSE.notAMember.code:
        return { kind: 'stop', stop: { sentence: this.options.refusals[reason] ?? this.options.refusals.not_a_member, forget: false, retry: true } };
      case RELAY_CLOSE.replaced.code:
        return { kind: 'stop', stop: { sentence: LINK_SENTENCES.takenOver, forget: false, retry: false } };
      case RELAY_CLOSE.deviceRevoked.code:
        return { kind: 'stop', stop: { sentence: LINK_SENTENCES.stoppedElsewhere, forget: true, retry: false } };
      default:
        // 4001–4003, a server going away, a dropped network: dial again.
        return { kind: 'again', sentence: null };
    }
  }

  /** What an HTTP answer means for this link. */
  private answered(answer: Exclude<RelayAnswer, { kind: 'ok' }>): Next {
    if (answer.kind === 'unreachable') return { kind: 'again', sentence: LINK_SENTENCES.unreachable };
    if (answer.code === 'device_revoked') return { kind: 'stop', stop: { sentence: LINK_SENTENCES.stoppedElsewhere, forget: true, retry: false } };
    if (answer.status === 401) return { kind: 'stop', stop: { sentence: LINK_SENTENCES.signedOut, forget: false, retry: true } };
    if (answer.status === 403) return { kind: 'stop', stop: { sentence: answer.sentence, forget: false, retry: true } };
    // A busy or unavailable service, or a route it doesn't answer yet: dial again later.
    if (answer.status >= 500 || answer.status === 404 || answer.status === 408 || answer.status === 429)
      return { kind: 'again', sentence: answer.sentence };
    return { kind: 'stop', stop: { sentence: answer.sentence, forget: false, retry: false } };
  }

  private follow(next: Next) {
    if (this.ended) return;
    if (next.kind === 'stop') return this.halt(next.stop);
    if (next.kind === 'now') {
      this.report({ state: 'connecting', sentence: null });
      return void this.dial(false);
    }
    const delay = backoffMs(this.failures++, this.random);
    this.report(next.sentence ? { state: 'error', sentence: next.sentence } : { state: 'connecting', sentence: null });
    if (this.redial) clearTimeout(this.redial);
    this.redial = setTimeout(() => {
      this.redial = null;
      void this.dial(false);
    }, delay);
    this.redial.unref?.();
  }

  private halt(stop: LinkStop) {
    if (this.ended) return;
    this.stop();
    this.options.stopped(stop);
  }

  private detach(dial: Dial, code: number, reason: string) {
    dial.done = true;
    try {
      dial.socket.close(code, reason);
    } catch {
      // Already closing.
    }
  }

  private quiet() {
    if (this.heartbeat) clearInterval(this.heartbeat);
    if (this.renew) clearTimeout(this.renew);
    this.heartbeat = this.renew = null;
  }

  private report(status: LinkStatus) {
    if (this.ended) return;
    const line = `${status.state}${status.sentence ? `: ${status.sentence}` : ''}`;
    if (line !== this.reported) this.options.log?.(`Phone access for ${this.options.deviceId}: ${status.state}.`);
    this.reported = line;
    this.options.status(status);
  }
}
