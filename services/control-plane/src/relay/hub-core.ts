/**
 * The relay hub's rules, apart from any transport (relay plan step 2).
 *
 * One hub per business holds that business's desktop connections. Before a
 * connection reaches the hub, the Worker front has checked the person's sign-in,
 * membership, role, plan and the device's registration, and hands over what it
 * checked as a DesktopGrant. The hub then:
 *
 * - challenges the desktop to sign a fresh nonce with the device key, and closes
 *   the connection unless a valid signature arrives within 10 seconds;
 * - keeps one proven connection per device: a newer proof replaces the older
 *   connection (4409), so a computer is never locked out behind its own
 *   half-open socket, and nothing is lost because the newer one proved the same
 *   key under a verified sign-in of the same person;
 * - rechecks the device, membership, role, plan and sign-in by id every 20
 *   seconds, and closes a connection whose last passing check is 30 seconds old
 *   or whose sign-in has expired;
 * - closes a proven connection that has been silent for 60 seconds;
 * - answers presence: the devices with a proven, live connection now.
 *
 * It reads only the closed set of frames in protocol.ts and never records keys,
 * nonces, signatures or frame text. Its two hosts are the Durable Object
 * (durable-object.ts) and the faux cloud's hubs (faux/relay-hubs.ts). They hand
 * it sockets, run tick() at nextDeadline(), and keep each connection's saved
 * state where it outlives the hub's memory.
 */
import { z } from 'zod';
import { base64url, fromBase64url } from '../crypto.js';
import { accountId } from '../domain.js';
import {
  RELAY_CLOSE,
  RELAY_MAX_MESSAGE_BYTES,
  RELAY_NONCE,
  RELAY_PONG_FRAME,
  RELAY_PUBLIC_KEY,
  RELAY_TIMINGS,
  challengePayload,
  closeForRefusal,
  parseDesktopMessage,
  type ChallengeMessage,
  type ReadyMessage,
  type RelayClose,
  type RelayRefusalCode,
} from './protocol.js';

/** What the Worker front vouches for when it hands a desktop to the business's hub. */
export const desktopGrantSchema = z.strictObject({
  organizationId: accountId,
  tenantId: accountId,
  deviceId: accountId,
  /** The person who registered the device, signed in on it now. */
  personId: accountId,
  publicKey: z.string().regex(RELAY_PUBLIC_KEY),
  /** The sign-in the connection was opened with, rechecked by id. */
  issuer: z.string().min(1).max(512),
  sessionId: accountId,
  /** When the bearer the connection was opened with expires. The hub ends the connection then (4000). */
  authorizedUntil: z.iso.datetime(),
  /** When the Worker front checked all of this. */
  checkedAt: z.iso.datetime(),
});
export type DesktopGrant = z.infer<typeof desktopGrantSchema>;

const moment = z.number().int().nonnegative();

/** One connection's state. A Durable Object keeps it on the socket, so it outlives hibernation. */
export const connectionStateSchema = z.strictObject({
  v: z.literal(1),
  id: z.string().regex(/^[A-Za-z0-9_-]{22}$/),
  grant: desktopGrantSchema,
  phase: z.enum(['challenged', 'ready']),
  /** The open challenge. Null once answered: one challenge takes one answer. */
  nonce: z.string().regex(RELAY_NONCE).nullable(),
  openedAt: moment,
  challengeExpiresAt: moment,
  readyAt: moment.nullable(),
  /** The last valid frame from the desktop. */
  heardAt: moment,
  /** The last check that passed, the Worker front's included. */
  checkedAt: moment,
  nextCheckAt: moment,
  /** When the device's last-seen time is next written. */
  nextSeenAt: moment,
});
export type ConnectionState = z.infer<typeof connectionStateSchema>;

export interface HubTransport {
  send(text: string): void;
  close(code: number, reason: string): void;
  /** Keep this connection's state beside its socket. Null: the hub is done with it. */
  save(state: ConnectionState | null): void;
  /** When the host last answered a heartbeat without the hub (a Durable Object auto-response), if it can tell. */
  heardAt?(): number | null;
}

export interface HubAuthority {
  /** Null while the connection may stay; otherwise why not. Throws when it cannot tell. */
  recheck(grant: DesktopGrant, at: string): Promise<RelayRefusalCode | null>;
  /** Moves the device's last-seen time forward. */
  seen(grant: DesktopGrant, at: string): Promise<void>;
}

/** What a hub records about its connections: ids and outcomes, never keys, nonces, signatures or frames. */
export type HubEvent =
  | { event: 'relay-desktop-opened' | 'relay-desktop-ready'; organizationId: string; deviceId: string }
  | { event: 'relay-desktop-closed'; organizationId: string; deviceId: string; code: number; reason: string };

export interface HubOptions {
  authority: HubAuthority;
  now?: () => number;
  record?: (event: HubEvent) => void;
}

interface Connection {
  transport: HubTransport;
  state: ConnectionState;
  /** A signature check is in flight. */
  verifying: boolean;
  /** A recheck is in flight. */
  checking: boolean;
  /** A last-seen write is in flight. */
  seeing: boolean;
}

const randomToken = (bytes: number) => base64url(crypto.getRandomValues(new Uint8Array(bytes)));

/** Whether a signature answers this challenge with the device's registered key. Never throws. */
export async function verifyProof(grant: DesktopGrant, nonce: string, signature: string): Promise<boolean> {
  try {
    const key = await crypto.subtle.importKey('raw', fromBase64url(grant.publicKey), { name: 'Ed25519' }, false, ['verify']);
    return await crypto.subtle.verify({ name: 'Ed25519' }, key, fromBase64url(signature),
      challengePayload({ organizationId: grant.organizationId, deviceId: grant.deviceId, nonce }));
  } catch {
    return false;
  }
}

/** A text frame within the size cap, or null. UTF-8 never takes fewer bytes than UTF-16 code units. */
function frameText(data: string | ArrayBuffer | ArrayBufferView): string | null {
  if (typeof data !== 'string' || data.length > RELAY_MAX_MESSAGE_BYTES) return null;
  return new TextEncoder().encode(data).length <= RELAY_MAX_MESSAGE_BYTES ? data : null;
}

export class RelayHubCore {
  private readonly connections = new Map<string, Connection>();
  private readonly authority: HubAuthority;
  private readonly now: () => number;
  private readonly record: (event: HubEvent) => void;
  /** Last-seen writes for connections that just ended; the calling event waits for them. */
  private readonly settling: Promise<void>[] = [];
  private ticking: Promise<void> | null = null;

  constructor(options: HubOptions) {
    this.authority = options.authority;
    this.now = options.now ?? Date.now;
    this.record = options.record ?? (() => {});
  }

  /** How many connections the hub holds, proven or not. */
  get size(): number {
    return this.connections.size;
  }

  has(id: string): boolean {
    return this.connections.has(id);
  }

  /** A desktop the Worker front authorized. Sends the challenge; answers the connection's id. */
  open(transport: HubTransport, grant: DesktopGrant): string {
    const at = this.now();
    const id = randomToken(16);
    const nonce = randomToken(32);
    const state: ConnectionState = {
      v: 1,
      id,
      grant,
      phase: 'challenged',
      nonce,
      openedAt: at,
      challengeExpiresAt: at + RELAY_TIMINGS.challengeMs,
      readyAt: null,
      heardAt: at,
      checkedAt: Math.min(at, Date.parse(grant.checkedAt)),
      nextCheckAt: at + RELAY_TIMINGS.recheckMs,
      nextSeenAt: at,
    };
    const connection: Connection = { transport, state, verifying: false, checking: false, seeing: false };
    this.connections.set(id, connection);
    this.record({ event: 'relay-desktop-opened', organizationId: grant.organizationId, deviceId: grant.deviceId });
    if (at >= Date.parse(grant.authorizedUntil)) {
      this.finish(connection, RELAY_CLOSE.sessionExpired);
      return id;
    }
    transport.save(state);
    const challenge: ChallengeMessage = {
      v: 1, type: 'challenge', organizationId: grant.organizationId, deviceId: grant.deviceId, nonce, expiresInMs: RELAY_TIMINGS.challengeMs,
    };
    transport.send(JSON.stringify(challenge));
    return id;
  }

  /** A socket that outlived the hub's memory, with the state it saved. False: the host should close it. */
  restore(transport: HubTransport, saved: unknown): boolean {
    const parsed = connectionStateSchema.safeParse(saved);
    if (!parsed.success) return false;
    if (!this.connections.has(parsed.data.id))
      this.connections.set(parsed.data.id, { transport, state: parsed.data, verifying: false, checking: false, seeing: false });
    return true;
  }

  /**
   * A frame from a desktop. While it is challenged, anything but one valid
   * proof closes it. Once it is ready, frames outside the closed set are
   * dropped; step 3 adds its message types here.
   */
  async message(id: string, data: string | ArrayBuffer | ArrayBufferView): Promise<void> {
    const connection = this.connections.get(id);
    if (!connection) return;
    const text = frameText(data);
    const message = text === null ? null : parseDesktopMessage(text);
    const { grant } = connection.state;

    if (connection.state.phase === 'challenged') {
      if (!message || message.type !== 'prove' || connection.state.nonce === null || connection.verifying) {
        this.finish(connection, RELAY_CLOSE.protocolError);
        return this.settle();
      }
      const nonce = connection.state.nonce;
      connection.verifying = true;
      this.update(connection, { nonce: null });
      const valid = await verifyProof(grant, nonce, message.signature);
      connection.verifying = false;
      // The connection may have ended while the signature was checked.
      if (this.connections.get(id) !== connection) return this.settle();
      const at = this.now();
      if (!valid) this.finish(connection, RELAY_CLOSE.badSignature);
      else if (at >= connection.state.challengeExpiresAt) this.finish(connection, RELAY_CLOSE.challengeTimeout);
      else {
        for (const other of [...this.connections.values()])
          if (other !== connection && other.state.phase === 'ready' && other.state.grant.deviceId === grant.deviceId)
            this.finish(other, RELAY_CLOSE.replaced);
        this.update(connection, { phase: 'ready', readyAt: at, heardAt: at, nextSeenAt: at });
        const ready: ReadyMessage = {
          v: 1, type: 'ready', deviceId: grant.deviceId, heartbeatMs: RELAY_TIMINGS.heartbeatMs,
          timeoutMs: RELAY_TIMINGS.heartbeatTimeoutMs, authorizedUntil: grant.authorizedUntil,
        };
        connection.transport.send(JSON.stringify(ready));
        this.record({ event: 'relay-desktop-ready', organizationId: grant.organizationId, deviceId: grant.deviceId });
      }
      return this.settle();
    }

    if (!message) return;
    this.update(connection, { heardAt: this.now() });
    if (message.type === 'ping') connection.transport.send(RELAY_PONG_FRAME);
    // A second proof after ready changes nothing.
  }

  /** The socket closed from the desktop's side, or failed. */
  async closed(id: string, code = 1006): Promise<void> {
    const connection = this.connections.get(id);
    if (!connection) return;
    this.connections.delete(id);
    const { grant } = connection.state;
    this.record({ event: 'relay-desktop-closed', organizationId: grant.organizationId, deviceId: grant.deviceId, code, reason: 'closed_by_desktop' });
    if (connection.state.phase === 'ready') this.settling.push(this.lastSeen(grant));
    await this.settle();
  }

  /** Ends every connection of one device now (it was stopped). Answers how many ended. */
  async end(deviceId: string, close: RelayClose): Promise<number> {
    let ended = 0;
    for (const connection of [...this.connections.values()])
      if (connection.state.grant.deviceId === deviceId) {
        this.finish(connection, close);
        ended++;
      }
    await this.settle();
    return ended;
  }

  /** The devices with a proven connection that is live right now. */
  presence(): Set<string> {
    const at = this.now();
    const online = new Set<string>();
    for (const connection of this.connections.values()) {
      const { state } = connection;
      if (state.phase !== 'ready') continue;
      if (at >= Date.parse(state.grant.authorizedUntil) || at >= state.checkedAt + RELAY_TIMINGS.authorityWindowMs) continue;
      if (at >= this.heard(connection) + RELAY_TIMINGS.heartbeatTimeoutMs) continue;
      online.add(state.grant.deviceId);
    }
    return online;
  }

  /**
   * When the hub next has something to do, or null with nothing to watch. Every
   * time returned here is one tick() retires (closes, rechecks or writes), so a
   * host's alarm never spins on a deadline already past.
   */
  nextDeadline(): number | null {
    let next = Number.POSITIVE_INFINITY;
    for (const connection of this.connections.values()) {
      const { state } = connection;
      next = Math.min(next, Date.parse(state.grant.authorizedUntil), state.checkedAt + RELAY_TIMINGS.authorityWindowMs);
      if (state.phase === 'challenged') {
        if (!connection.verifying) next = Math.min(next, state.challengeExpiresAt);
        continue;
      }
      next = Math.min(next, this.heard(connection) + RELAY_TIMINGS.heartbeatTimeoutMs);
      if (!connection.checking) next = Math.min(next, state.nextCheckAt);
      if (!connection.seeing) next = Math.min(next, state.nextSeenAt);
    }
    return Number.isFinite(next) ? next : null;
  }

  /** Runs everything due: expiries, timeouts, rechecks and last-seen writes. Overlapping calls share one run. */
  tick(): Promise<void> {
    this.ticking ??= this.run().finally(() => {
      this.ticking = null;
    });
    return this.ticking;
  }

  private async run(): Promise<void> {
    const at = this.now();
    const work: Promise<void>[] = [];
    for (const connection of [...this.connections.values()]) {
      const { state } = connection;
      if (at >= Date.parse(state.grant.authorizedUntil)) this.finish(connection, RELAY_CLOSE.sessionExpired);
      else if (at >= state.checkedAt + RELAY_TIMINGS.authorityWindowMs) this.finish(connection, RELAY_CLOSE.recheckUnavailable);
      else if (state.phase === 'challenged') {
        if (!connection.verifying && at >= state.challengeExpiresAt) this.finish(connection, RELAY_CLOSE.challengeTimeout);
      } else if (at >= this.heard(connection) + RELAY_TIMINGS.heartbeatTimeoutMs) this.finish(connection, RELAY_CLOSE.heartbeatTimeout);
      else {
        if (!connection.checking && at >= state.nextCheckAt) work.push(this.recheck(connection));
        if (!connection.seeing && at >= state.nextSeenAt) work.push(this.markSeen(connection));
      }
    }
    await Promise.all(work);
    await this.settle();
  }

  private async recheck(connection: Connection): Promise<void> {
    connection.checking = true;
    const started = this.now();
    let outcome: RelayRefusalCode | null | undefined;
    try {
      outcome = await this.authority.recheck(connection.state.grant, new Date(started).toISOString());
    } catch {
      outcome = undefined;
    } finally {
      connection.checking = false;
    }
    if (this.connections.get(connection.state.id) !== connection) return;
    // Could not tell: try again shortly. The 30-second window still closes it if that keeps failing.
    if (outcome === undefined) this.update(connection, { nextCheckAt: this.now() + RELAY_TIMINGS.recheckRetryMs });
    else if (outcome !== null) this.finish(connection, closeForRefusal(outcome));
    else this.update(connection, { checkedAt: started, nextCheckAt: started + RELAY_TIMINGS.recheckMs });
  }

  private async markSeen(connection: Connection): Promise<void> {
    connection.seeing = true;
    const at = this.now();
    let written = false;
    try {
      await this.authority.seen(connection.state.grant, new Date(at).toISOString());
      written = true;
    } catch {
      // Last seen is a courtesy to the phone; try again shortly.
    } finally {
      connection.seeing = false;
    }
    if (this.connections.get(connection.state.id) !== connection) return;
    this.update(connection, { nextSeenAt: written ? at + RELAY_TIMINGS.seenEveryMs : this.now() + RELAY_TIMINGS.recheckRetryMs });
  }

  /** The last-seen time a device leaves behind when its connection ends. Never throws. */
  private async lastSeen(grant: DesktopGrant): Promise<void> {
    try {
      await this.authority.seen(grant, new Date(this.now()).toISOString());
    } catch {
      // The five-minute writes already left a recent time.
    }
  }

  private async settle(): Promise<void> {
    while (this.settling.length) await Promise.all(this.settling.splice(0));
  }

  private heard(connection: Connection): number {
    return Math.max(connection.state.heardAt, connection.transport.heardAt?.() ?? 0);
  }

  private update(connection: Connection, change: Partial<ConnectionState>): void {
    connection.state = { ...connection.state, ...change };
    connection.transport.save(connection.state);
  }

  /** Ends a connection from the hub's side: forget its saved state, then close the socket. */
  private finish(connection: Connection, close: RelayClose): void {
    if (this.connections.get(connection.state.id) !== connection) return;
    this.connections.delete(connection.state.id);
    const { grant } = connection.state;
    this.record({ event: 'relay-desktop-closed', organizationId: grant.organizationId, deviceId: grant.deviceId, code: close.code, reason: close.reason });
    if (connection.state.phase === 'ready') this.settling.push(this.lastSeen(grant));
    try {
      connection.transport.save(null);
    } catch {
      // The socket is already gone.
    }
    try {
      connection.transport.close(close.code, close.reason);
    } catch {
      // The socket is already gone.
    }
  }
}
