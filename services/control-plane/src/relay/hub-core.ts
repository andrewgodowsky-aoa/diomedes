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
 * Steps 3 and 4 add phones. A phone has no device key: the Worker front checks
 * its sign-in, membership and plan and hands over a PhoneGrant, and the
 * connection is open at once. The hub then rechecks those by id every 20
 * seconds, closes a phone silent for 60 seconds, keeps at most five phone
 * connections per person (a newer one replaces the oldest, 4409), and routes:
 * a phone command goes only to the ready desktop it names when that desktop was
 * registered by the same person, stamped with the phone's verified `from`; a
 * desktop frame goes only to the phones of the person who registered it,
 * stamped with that desktop's proven device id as its `source`. Rate
 * limits and refusals answer the phone with a `result`; nothing is queued. A
 * frame from a phone already past one of its deadlines ends that phone instead
 * of being read, so nothing it sends reaches a desktop before the alarm runs.
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
  RELAY_LIMITS,
  RELAY_MAX_MESSAGE_BYTES,
  RELAY_NONCE,
  RELAY_PONG_FRAME,
  RELAY_PUBLIC_KEY,
  RELAY_TIMINGS,
  challengePayload,
  closeForRefusal,
  parseDesktopMessage,
  parseDesktopToPhone,
  parsePhoneMessage,
  serializeFrame,
  type ChallengeMessage,
  type DesktopToPhoneMessage,
  type ReadyMessage,
  type RelayClose,
  type RelayHubRefusal,
  type RelayRefusalCode,
  type ResultMessage,
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

/** What the Worker front vouches for when it hands a phone to the business's hub (relay plan step 3). */
export const phoneGrantSchema = z.strictObject({
  organizationId: accountId,
  tenantId: accountId,
  /** The person signed in on the phone. */
  personId: accountId,
  /** The sign-in the connection was opened with, rechecked by id. */
  issuer: z.string().min(1).max(512),
  sessionId: accountId,
  /** When the bearer the connection was opened with expires. The hub ends the connection then (4000). */
  authorizedUntil: z.iso.datetime(),
  /** When the Worker front checked all of this. */
  checkedAt: z.iso.datetime(),
});
export type PhoneGrant = z.infer<typeof phoneGrantSchema>;

/** One phone connection's state, kept on its socket like a desktop's. `kind` tells the two apart. */
export const phoneConnectionStateSchema = z.strictObject({
  v: z.literal(1),
  kind: z.literal('phone'),
  id: z.string().regex(/^[A-Za-z0-9_-]{22}$/),
  grant: phoneGrantSchema,
  openedAt: moment,
  /** The last valid frame from the phone. */
  heardAt: moment,
  /** The last check that passed, the Worker front's included. */
  checkedAt: moment,
  nextCheckAt: moment,
});
export type PhoneConnectionState = z.infer<typeof phoneConnectionStateSchema>;

export interface HubTransport {
  send(text: string): void;
  close(code: number, reason: string): void;
  /** Keep this connection's state beside its socket. Null: the hub is done with it. */
  save(state: ConnectionState | null): void;
  /** When the host last answered a heartbeat without the hub (a Durable Object auto-response), if it can tell. */
  heardAt?(): number | null;
}

/** A phone's socket, as the hub uses it. */
export interface PhoneTransport {
  send(text: string): void;
  close(code: number, reason: string): void;
  save(state: PhoneConnectionState | null): void;
  heardAt?(): number | null;
}

/** Bounded resource accounting, never a sign-in or a replacement for the Worker's grant. */
const upgradeAccountingSchema = z.strictObject({
  v: z.literal(1),
  events: z.array(z.strictObject({ at: moment, personId: accountId, deviceId: accountId.nullable() }))
    .max(RELAY_LIMITS.upgradesPerOrganization),
});
export type UpgradeAccounting = z.infer<typeof upgradeAccountingSchema>;

/** A one-use reservation. Hosts persist accounting, recheck, then allocate the transport without another await. */
export interface PreparedUpgrade<T extends HubTransport | PhoneTransport> {
  accounting: UpgradeAccounting;
  recheck(): RelayClose | null;
  open(transport: T): string;
}

export interface HubAuthority {
  /** Null while the connection may stay; otherwise why not. Throws when it cannot tell. */
  recheck(grant: DesktopGrant, at: string): Promise<RelayRefusalCode | null>;
  /** Moves the device's last-seen time forward. */
  seen(grant: DesktopGrant, at: string): Promise<void>;
  /**
   * A phone's recheck: null while it may stay, otherwise why not; throws when it cannot tell.
   * Absent means it can never tell, so a phone connection lasts only the authority window.
   */
  recheckPhone?(grant: PhoneGrant, at: string): Promise<RelayRefusalCode | null>;
}

/** What a hub records about its connections: ids and outcomes, never keys, nonces, signatures or frames. */
export type HubEvent =
  | { event: 'relay-desktop-opened' | 'relay-desktop-ready'; organizationId: string; deviceId: string }
  | { event: 'relay-desktop-closed'; organizationId: string; deviceId: string; code: number; reason: string }
  | { event: 'relay-phone-opened'; organizationId: string; personId: string }
  | { event: 'relay-phone-closed'; organizationId: string; personId: string; code: number; reason: string }
  /** A frame the hub would not pass on: its type and why, never its content. */
  | { event: 'relay-frame-refused'; organizationId: string; from: 'phone' | 'desktop'; id: string; type: string; reason: RelayHubRefusal };

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

interface PhoneConnection {
  transport: PhoneTransport;
  state: PhoneConnectionState;
  /** A recheck is in flight. */
  checking: boolean;
}

const RATE_WINDOW_MS = 60_000;

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
  private readonly phones = new Map<string, PhoneConnection>();
  /** Recent frame times per rate-limited sender (`person:<id>` or `desktop:<id>`), newest last. */
  private readonly rates = new Map<string, number[]>();
  private upgrades: UpgradeAccounting['events'] = [];
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

  /** How many connections the hub holds, desktops proven or not and phones. */
  get size(): number {
    return this.connections.size + this.phones.size;
  }

  has(id: string): boolean {
    return this.connections.has(id) || this.phones.has(id);
  }

  /** How many phone connections the hub holds. */
  get phoneCount(): number {
    return this.phones.size;
  }

  /** Check before a host allocates/accepts its socket. */
  admitDesktop(grant: DesktopGrant): RelayClose | null {
    const at = this.now();
    return this.desktopAvailability(grant) ?? (this.allowUpgrade(grant, at, false) ? null : RELAY_CLOSE.upgradeRateLimited);
  }

  /** Phones retain their bounded newest-screen replacement, within the total hub and person budgets. */
  admitPhone(grant: PhoneGrant): RelayClose | null {
    const at = this.now();
    return this.phoneAvailability(grant) ?? (this.allowUpgrade(grant, at, false) ? null : RELAY_CLOSE.upgradeRateLimited);
  }

  /** Called once by a durable host before admission. Invalid accounting fails closed at that host. */
  restoreUpgradeAccounting(saved: unknown): boolean {
    const parsed = upgradeAccountingSchema.safeParse(saved === undefined ? { v: 1, events: [] } : saved);
    if (!parsed.success) return false;
    this.upgrades = parsed.data.events;
    this.pruneRates(this.now());
    return true;
  }

  prepareDesktop(grant: DesktopGrant): PreparedUpgrade<HubTransport> | RelayClose {
    return this.prepare<HubTransport>(grant, () => this.desktopAvailability(grant), (transport, id) => this.openDesktop(transport, grant, id));
  }

  preparePhone(grant: PhoneGrant): PreparedUpgrade<PhoneTransport> | RelayClose {
    return this.prepare<PhoneTransport>(grant, () => this.phoneAvailability(grant), (transport, id) => this.openPreparedPhone(transport, grant, id));
  }

  /** A desktop the Worker front authorized. Sends the challenge; answers the connection's id. */
  open(transport: HubTransport, grant: DesktopGrant): string {
    const prepared = this.prepareDesktop(grant);
    if ('reason' in prepared) {
      this.reject(transport, prepared);
      return randomToken(16);
    }
    return prepared.open(transport);
  }

  private openDesktop(transport: HubTransport, grant: DesktopGrant, id: string): string {
    const at = this.now();
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
    const state = parsed.data;
    if (this.has(state.id)) return false;
    const connection = { transport, state, verifying: false, checking: false, seeing: false };
    if (this.desktopEnding(connection, this.now()) || this.desktopCapacity(state.grant, state.phase)) return false;
    // Rebuild the same one-proven-socket invariant regardless of the runtime's socket iteration order.
    if (state.phase === 'ready') {
      const older = [...this.connections.values()].filter((other) => other.state.phase === 'ready' && other.state.grant.deviceId === state.grant.deviceId);
      if (older.some((other) => other.state.openedAt >= state.openedAt)) return false;
      for (const other of older) this.finish(other, RELAY_CLOSE.replaced);
    }
    this.connections.set(state.id, connection);
    return true;
  }

  /**
   * A phone the Worker front authorized (relay plan step 3). It has no key to prove, so it is
   * open at once; the hub sends it nothing until a desktop does. Answers the connection's id.
   */
  openPhone(transport: PhoneTransport, grant: PhoneGrant): string {
    const prepared = this.preparePhone(grant);
    if ('reason' in prepared) {
      this.reject(transport, prepared);
      return randomToken(16);
    }
    return prepared.open(transport);
  }

  private openPreparedPhone(transport: PhoneTransport, grant: PhoneGrant, id: string): string {
    const at = this.now();
    const state: PhoneConnectionState = {
      v: 1,
      kind: 'phone',
      id,
      grant,
      openedAt: at,
      heardAt: at,
      checkedAt: Math.min(at, Date.parse(grant.checkedAt)),
      nextCheckAt: at + RELAY_TIMINGS.recheckMs,
    };
    const phone: PhoneConnection = { transport, state, checking: false };
    this.phones.set(id, phone);
    this.record({ event: 'relay-phone-opened', organizationId: grant.organizationId, personId: grant.personId });
    if (at >= Date.parse(grant.authorizedUntil)) {
      this.finishPhone(phone, RELAY_CLOSE.sessionExpired);
      return id;
    }
    transport.save(state);
    // Replace, not refuse: the newest is the screen the person is looking at.
    this.trimPhones(grant.personId);
    return id;
  }

  /** A phone socket that outlived the hub's memory, with the state it saved. False: the host should close it. */
  restorePhone(transport: PhoneTransport, saved: unknown): boolean {
    const parsed = phoneConnectionStateSchema.safeParse(saved);
    if (!parsed.success) return false;
    const state = parsed.data;
    if (this.has(state.id)) return false;
    const phone = { transport, state, checking: false };
    if (this.phoneEnding(phone, this.now()) || this.phoneCapacity(state.grant)) return false;
    this.phones.set(state.id, phone);
    this.trimPhones(state.grant.personId);
    return this.phones.get(state.id) === phone;
  }

  /**
   * A frame from a desktop or a phone. While a desktop is challenged, anything
   * but one valid proof closes it. Once it is ready, its frames for phones
   * (steps 3 and 4) go to its person's phones, and anything else is dropped.
   */
  async message(id: string, data: string | ArrayBuffer | ArrayBufferView): Promise<void> {
    const phone = this.phones.get(id);
    if (phone) return this.phoneMessage(phone, data);
    const connection = this.connections.get(id);
    if (!connection) return;
    const ending = this.desktopEnding(connection, this.now());
    if (ending) {
      this.finish(connection, ending);
      return this.settle();
    }
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
      const ending = this.desktopEnding(connection, at);
      if (ending) this.finish(connection, ending);
      else if (!valid) this.finish(connection, RELAY_CLOSE.badSignature);
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

    if (!message) {
      const forPhones = text === null ? null : parseDesktopToPhone(text);
      if (!forPhones) return;
      this.update(connection, { heardAt: this.now() });
      this.toPhones(connection, forPhones);
      return;
    }
    this.update(connection, { heardAt: this.now() });
    if (message.type === 'ping') connection.transport.send(RELAY_PONG_FRAME);
    // A second proof after ready changes nothing.
  }

  /** A ready desktop's frame for phones: only to the phones of the person who registered it, within its rate, with its `source`. */
  private toPhones(desktop: Connection, message: DesktopToPhoneMessage): void {
    const { grant } = desktop.state;
    const at = this.now();
    if (this.connections.get(desktop.state.id) !== desktop) return;
    const ending = this.desktopEnding(desktop, at);
    if (ending) return this.finish(desktop, ending);
    if (!this.allow(`desktop:${grant.deviceId}`, RELAY_LIMITS.desktopFramesPerMinute, at)) {
      this.record({ event: 'relay-frame-refused', organizationId: grant.organizationId, from: 'desktop', id: grant.deviceId, type: message.type, reason: 'rate_limited' });
      return;
    }
    // Which computer it came from, from this desktop's proven grant: `message` was parsed as a desktop's own frame,
    // which cannot carry `source`. A frame the stamp would push past the cap goes out as sent, unattributed.
    const text = serializeFrame({ ...message, source: { deviceId: grant.deviceId } }) ?? serializeFrame(message);
    if (text === null) return;
    for (const phone of [...this.phones.values()])
      if (phone.state.grant.personId === grant.personId && this.phoneLive(phone, at)) phone.transport.send(text);
  }

  /**
   * A phone's frame. A phone past a deadline is ended first. Otherwise a ping is answered; a
   * command goes to the ready desktop it names, only when that desktop was registered by the
   * same person, with `from` stamped from the phone's own sign-in over anything the phone sent.
   * Anything else is dropped. A command that can't be passed on is answered with a `result`
   * saying why.
   */
  private phoneMessage(phone: PhoneConnection, data: string | ArrayBuffer | ArrayBufferView): void {
    const at = this.now();
    // A phone past its sign-in, its authority window or its heartbeat is ended here, as tick()
    // would end it, before anything it sent is read: nothing reaches a desktop between that
    // deadline and the host's alarm. Judged before this frame counts as heard, so a phone silent
    // past the heartbeat timeout is ended too, and before a ping is answered, so an ended phone
    // gets no pong. (On Cloudflare the runtime answers an exact ping itself without waking the hub.)
    const ending = this.phoneEnding(phone, at);
    if (ending) return this.finishPhone(phone, ending);
    const text = frameText(data);
    const message = text === null ? null : parsePhoneMessage(text);
    if (!message) return;
    this.updatePhone(phone, { heardAt: at });
    if (message.type === 'ping') {
      phone.transport.send(RELAY_PONG_FRAME);
      return;
    }
    const { grant } = phone.state;
    const refuse = (reason: RelayHubRefusal) => {
      this.record({ event: 'relay-frame-refused', organizationId: grant.organizationId, from: 'phone', id: grant.personId, type: message.type, reason });
      if (!('commandId' in message)) return;
      const result: ResultMessage = { v: 1, type: 'result', commandId: message.commandId, outcome: 'refused', code: reason };
      phone.transport.send(JSON.stringify(result));
    };
    if (!this.allow(`person:${grant.personId}`, RELAY_LIMITS.phoneCommandsPerMinute, at)) return refuse('rate_limited');
    const desktop = [...this.connections.values()].find(
      (connection) => connection.state.grant.deviceId === message.deviceId && this.desktopLive(connection, at),
    );
    if (!desktop) return refuse('device_offline');
    if (desktop.state.grant.personId !== grant.personId) return refuse('not_your_device');
    const { from: _sent, ...command } = message;
    const stamped = serializeFrame({ ...command, from: { personId: grant.personId, sessionId: grant.sessionId } });
    if (stamped === null) return refuse('too_large');
    desktop.transport.send(stamped);
  }

  /** Counts one frame against a sender's per-minute limit. False: over it, and not counted. */
  private allow(key: string, limit: number, at: number): boolean {
    this.pruneRates(at);
    const recent = (this.rates.get(key) ?? []).filter((moment) => moment > at - RATE_WINDOW_MS);
    if (recent.length >= limit) {
      this.rates.set(key, recent);
      return false;
    }
    recent.push(at);
    this.rates.set(key, recent);
    return true;
  }

  /** A proven desktop connection that is live right now: what presence counts. */
  private desktopLive(connection: Connection, at: number): boolean {
    return this.connections.get(connection.state.id) === connection && connection.state.phase === 'ready' && this.desktopEnding(connection, at) === null;
  }

  /** The same deadlines govern entry, proof completion, presence, admission reclamation and alarms. */
  private desktopEnding(connection: Connection, at: number): RelayClose | null {
    const { state } = connection;
    if (at >= Date.parse(state.grant.authorizedUntil)) return RELAY_CLOSE.sessionExpired;
    if (at >= state.checkedAt + RELAY_TIMINGS.authorityWindowMs) return RELAY_CLOSE.recheckUnavailable;
    if (state.phase === 'challenged') return at >= state.challengeExpiresAt ? RELAY_CLOSE.challengeTimeout : null;
    if (at >= this.heard(connection) + RELAY_TIMINGS.heartbeatTimeoutMs) return RELAY_CLOSE.heartbeatTimeout;
    return null;
  }

  /** A phone connection that is live right now. */
  private phoneLive(phone: PhoneConnection, at: number): boolean {
    return this.phoneEnding(phone, at) === null;
  }

  /** How the hub ends a phone connection that is past a deadline now, or null while it may stay. */
  private phoneEnding(phone: PhoneConnection, at: number): RelayClose | null {
    const { state } = phone;
    if (at >= Date.parse(state.grant.authorizedUntil)) return RELAY_CLOSE.sessionExpired;
    if (at >= state.checkedAt + RELAY_TIMINGS.authorityWindowMs) return RELAY_CLOSE.recheckUnavailable;
    if (at >= this.phoneHeard(phone) + RELAY_TIMINGS.heartbeatTimeoutMs) return RELAY_CLOSE.heartbeatTimeout;
    return null;
  }

  /** The socket closed from the desktop's or the phone's side, or failed. */
  async closed(id: string, code = 1006): Promise<void> {
    const phone = this.phones.get(id);
    if (phone) {
      this.phones.delete(id);
      const { grant } = phone.state;
      this.record({ event: 'relay-phone-closed', organizationId: grant.organizationId, personId: grant.personId, code, reason: 'closed_by_phone' });
      return;
    }
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

  /** The devices with a proven connection that is live right now. Desktops only: phones are not devices. */
  presence(): Set<string> {
    const at = this.now();
    const online = new Set<string>();
    for (const connection of this.connections.values())
      if (this.desktopLive(connection, at)) online.add(connection.state.grant.deviceId);
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
        next = Math.min(next, state.challengeExpiresAt);
        continue;
      }
      next = Math.min(next, this.heard(connection) + RELAY_TIMINGS.heartbeatTimeoutMs);
      if (!connection.checking) next = Math.min(next, state.nextCheckAt);
      if (!connection.seeing) next = Math.min(next, state.nextSeenAt);
    }
    for (const phone of this.phones.values()) {
      const { state } = phone;
      next = Math.min(
        next,
        Date.parse(state.grant.authorizedUntil),
        state.checkedAt + RELAY_TIMINGS.authorityWindowMs,
        this.phoneHeard(phone) + RELAY_TIMINGS.heartbeatTimeoutMs,
      );
      if (!phone.checking) next = Math.min(next, state.nextCheckAt);
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
      const ending = this.desktopEnding(connection, at);
      if (ending) this.finish(connection, ending);
      else if (state.phase === 'ready') {
        if (!connection.checking && at >= state.nextCheckAt) work.push(this.recheck(connection));
        if (!connection.seeing && at >= state.nextSeenAt) work.push(this.markSeen(connection));
      }
    }
    for (const phone of [...this.phones.values()]) {
      const ending = this.phoneEnding(phone, at);
      if (ending) this.finishPhone(phone, ending);
      else if (!phone.checking && at >= phone.state.nextCheckAt) work.push(this.recheckPhone(phone));
    }
    await Promise.all(work);
    await this.settle();
  }

  /** Admission must not depend on an alarm having already run. */
  private retireExpired(at: number): void {
    for (const connection of [...this.connections.values()]) {
      const ending = this.desktopEnding(connection, at);
      if (ending) this.finish(connection, ending);
    }
    for (const phone of [...this.phones.values()]) {
      const ending = this.phoneEnding(phone, at);
      if (ending) this.finishPhone(phone, ending);
    }
  }

  private desktopAvailability(grant: DesktopGrant): RelayClose | null {
    return this.grantAvailability(grant) ?? this.desktopCapacity(grant, 'challenged');
  }

  private phoneAvailability(grant: PhoneGrant): RelayClose | null {
    return this.grantAvailability(grant) ?? this.phoneCapacity(grant);
  }

  private grantAvailability(grant: DesktopGrant | PhoneGrant): RelayClose | null {
    const at = this.now();
    this.retireExpired(at);
    if (at >= Date.parse(grant.authorizedUntil)) return RELAY_CLOSE.sessionExpired;
    if (at >= Math.min(at, Date.parse(grant.checkedAt)) + RELAY_TIMINGS.authorityWindowMs) return RELAY_CLOSE.recheckUnavailable;
    return null;
  }

  private prepare<T extends HubTransport | PhoneTransport>(grant: DesktopGrant | PhoneGrant,
    available: () => RelayClose | null, open: (transport: T, id: string) => string): PreparedUpgrade<T> | RelayClose {
    const refusal = available();
    if (refusal) return refusal;
    if (!this.allowUpgrade(grant, this.now(), true)) return RELAY_CLOSE.upgradeRateLimited;
    const id = randomToken(16);
    let used = false;
    const recheck = () => used ? RELAY_CLOSE.protocolError : available();
    return {
      accounting: { v: 1, events: this.upgrades.map((event) => ({ ...event })) },
      recheck,
      open: (transport) => {
        const ending = recheck();
        used = true;
        if (ending) { this.reject(transport, ending); return id; }
        return open(transport, id);
      },
    };
  }

  private desktopCapacity(grant: DesktopGrant, phase: ConnectionState['phase']): RelayClose | null {
    const desktops = [...this.connections.values()];
    const device = desktops.filter((connection) => connection.state.grant.deviceId === grant.deviceId);
    const person = desktops.filter((connection) => connection.state.grant.personId === grant.personId);
    const phones = [...this.phones.values()].filter((phone) => phone.state.grant.personId === grant.personId);
    const pending = (connections: Connection[]) => connections.filter((connection) => connection.state.phase === 'challenged').length;
    const additionalPending = phase === 'challenged' ? 1 : 0;
    if (device.length + 1 > RELAY_LIMITS.desktopSocketsPerDevice || pending(device) + additionalPending > RELAY_LIMITS.desktopPendingPerDevice
      || person.length + 1 > RELAY_LIMITS.desktopSocketsPerPerson || pending(person) + additionalPending > RELAY_LIMITS.desktopPendingPerPerson
      || desktops.length + 1 > RELAY_LIMITS.desktopSocketsPerOrganization || pending(desktops) + additionalPending > RELAY_LIMITS.desktopPendingPerOrganization
      || person.length + phones.length + 1 > RELAY_LIMITS.socketsPerPerson || this.size + 1 > RELAY_LIMITS.socketsPerOrganization)
      return RELAY_CLOSE.connectionLimit;
    return null;
  }

  private phoneCapacity(grant: PhoneGrant): RelayClose | null {
    const mine = [...this.phones.values()].filter((phone) => phone.state.grant.personId === grant.personId).length;
    const desktops = [...this.connections.values()].filter((connection) => connection.state.grant.personId === grant.personId).length;
    const additional = mine >= RELAY_LIMITS.phoneSocketsPerPerson ? 0 : 1;
    if (desktops + mine + additional > RELAY_LIMITS.socketsPerPerson || this.size + additional > RELAY_LIMITS.socketsPerOrganization)
      return RELAY_CLOSE.connectionLimit;
    return null;
  }

  private trimPhones(personId: string): void {
    const mine = [...this.phones.values()].filter((phone) => phone.state.grant.personId === personId).sort((a, b) => a.state.openedAt - b.state.openedAt);
    for (const old of mine.slice(0, Math.max(0, mine.length - RELAY_LIMITS.phoneSocketsPerPerson))) this.finishPhone(old, RELAY_CLOSE.replaced);
  }

  /** At most 240 ID/time events. A failed durable write conservatively retains its attempt charge. */
  private allowUpgrade(grant: DesktopGrant | PhoneGrant, at: number, consume: boolean): boolean {
    this.pruneRates(at);
    if (this.upgrades.length >= RELAY_LIMITS.upgradesPerOrganization
      || this.upgrades.filter((event) => event.personId === grant.personId).length >= RELAY_LIMITS.upgradesPerPerson
      || ('deviceId' in grant && this.upgrades.filter((event) => event.deviceId === grant.deviceId).length >= RELAY_LIMITS.upgradesPerDevice)) return false;
    if (consume) this.upgrades.push({ at, personId: grant.personId, deviceId: 'deviceId' in grant ? grant.deviceId : null });
    return true;
  }

  private pruneRates(at: number): void {
    this.upgrades = this.upgrades.filter((event) => event.at > at - RATE_WINDOW_MS);
    for (const [key, times] of this.rates) {
      const recent = times.filter((moment) => moment > at - RATE_WINDOW_MS);
      if (recent.length) this.rates.set(key, recent);
      else this.rates.delete(key);
    }
  }

  /** A refused open never allocates connection/challenge state or sends a frame. */
  private reject(transport: HubTransport | PhoneTransport, close: RelayClose): void {
    try { transport.save(null); } catch { /* The socket is already gone. */ }
    try { transport.close(close.code, close.reason); } catch { /* The socket is already gone. */ }
  }

  private async recheckPhone(phone: PhoneConnection): Promise<void> {
    phone.checking = true;
    const started = this.now();
    let outcome: RelayRefusalCode | null | undefined;
    try {
      outcome = this.authority.recheckPhone ? await this.authority.recheckPhone(phone.state.grant, new Date(started).toISOString()) : undefined;
    } catch {
      outcome = undefined;
    } finally {
      phone.checking = false;
    }
    if (this.phones.get(phone.state.id) !== phone) return;
    // Could not tell: try again shortly. The 30-second window still closes it if that keeps failing.
    if (outcome === undefined) this.updatePhone(phone, { nextCheckAt: this.now() + RELAY_TIMINGS.recheckRetryMs });
    else if (outcome !== null) this.finishPhone(phone, closeForRefusal(outcome));
    else this.updatePhone(phone, { checkedAt: started, nextCheckAt: started + RELAY_TIMINGS.recheckMs });
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

  private phoneHeard(phone: PhoneConnection): number {
    return Math.max(phone.state.heardAt, phone.transport.heardAt?.() ?? 0);
  }

  private update(connection: Connection, change: Partial<ConnectionState>): void {
    connection.state = { ...connection.state, ...change };
    connection.transport.save(connection.state);
  }

  private updatePhone(phone: PhoneConnection, change: Partial<PhoneConnectionState>): void {
    phone.state = { ...phone.state, ...change };
    phone.transport.save(phone.state);
  }

  /** Ends a phone connection from the hub's side: forget its saved state, then close the socket. */
  private finishPhone(phone: PhoneConnection, close: RelayClose): void {
    if (this.phones.get(phone.state.id) !== phone) return;
    this.phones.delete(phone.state.id);
    const { grant } = phone.state;
    this.record({ event: 'relay-phone-closed', organizationId: grant.organizationId, personId: grant.personId, code: close.code, reason: close.reason });
    try {
      phone.transport.save(null);
    } catch {
      // The socket is already gone.
    }
    try {
      phone.transport.close(close.code, close.reason);
    } catch {
      // The socket is already gone.
    }
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
