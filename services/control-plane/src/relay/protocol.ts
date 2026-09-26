/**
 * The phone relay's wire contract, version 1: steps 1 and 2 of the relay plan
 * (device registration and presence, 2026-09-26). What the desktop sends and
 * receives on /relay/v1/organizations/:id/desktop, the refusal codes the relay
 * routes answer with, and the close codes that end a connection.
 *
 * Pure: no platform imports, so the Worker, its Durable Object, the faux cloud,
 * the desktop and the tests all read this one file. The prose version, which
 * the phone apps implement against, is
 * docs/implementation/2026-09-26-phone-relay-protocol.md.
 *
 * Every message is a JSON text frame `{ "v": 1, "type": "<name>", ... }` from a
 * closed set. Step 3 adds types after `ready`; the handshake does not change.
 */
import { z } from 'zod';

export const RELAY_PROTOCOL_VERSION = 1 as const;

/** The request header that names which registered computer is dialling. */
export const RELAY_DEVICE_HEADER = 'Nectovia-Relay-Device';

/** The longest frame the hub reads in version 1. The handshake and heartbeats are far smaller. */
export const RELAY_MAX_MESSAGE_BYTES = 4_096;

export const RELAY_TIMINGS = {
  /** How long the desktop has to answer a challenge. */
  challengeMs: 10_000,
  /** How often the desktop pings once it is ready. */
  heartbeatMs: 20_000,
  /** How long the hub waits without a message before it closes a ready connection. */
  heartbeatTimeoutMs: 60_000,
  /** How often the hub rechecks membership, role, plan, device and sign-in. */
  recheckMs: 20_000,
  /** How soon a recheck that could not run is tried again. */
  recheckRetryMs: 5_000,
  /** The most a connection lives past its last successful check. */
  authorityWindowMs: 30_000,
  /** How often a long connection moves the device's last-seen time. */
  seenEveryMs: 5 * 60_000,
} as const;

/**
 * Why the relay refuses a person or a computer, in the HTTP answers (`code`) and
 * in close reasons. `device_unknown` is only an HTTP answer: a device id the
 * business never registered, or already revoked, when an owner revokes it.
 */
export const RELAY_REFUSALS = [
  'not_a_member',
  'role_not_allowed',
  'phone_relay_not_included',
  'device_revoked',
  'session_ended',
] as const;
export type RelayRefusalCode = (typeof RELAY_REFUSALS)[number];

export interface RelayClose {
  readonly code: number;
  readonly reason: string;
}

/**
 * The close codes the hub sends. 4000-4099 are transient: the desktop dials
 * again (at once after `session_expired`, with backoff otherwise). 4400-4499
 * are refusals: the desktop stops and says why. `replaced` ends only the older
 * socket of a device that has proved its key again on a newer one.
 */
export const RELAY_CLOSE = {
  sessionExpired: { code: 4000, reason: 'session_expired' },
  heartbeatTimeout: { code: 4001, reason: 'heartbeat_timeout' },
  challengeTimeout: { code: 4002, reason: 'challenge_timeout' },
  recheckUnavailable: { code: 4003, reason: 'recheck_unavailable' },
  protocolError: { code: 4400, reason: 'protocol_error' },
  sessionEnded: { code: 4401, reason: 'session_ended' },
  badSignature: { code: 4401, reason: 'bad_signature' },
  notAMember: { code: 4403, reason: 'not_a_member' },
  roleNotAllowed: { code: 4403, reason: 'role_not_allowed' },
  notIncluded: { code: 4403, reason: 'phone_relay_not_included' },
  replaced: { code: 4409, reason: 'replaced' },
  deviceRevoked: { code: 4410, reason: 'device_revoked' },
} as const satisfies Record<string, RelayClose>;

/** The close a failed recheck ends a connection with. */
export function closeForRefusal(code: RelayRefusalCode): RelayClose {
  switch (code) {
    case 'not_a_member': return RELAY_CLOSE.notAMember;
    case 'role_not_allowed': return RELAY_CLOSE.roleNotAllowed;
    case 'phone_relay_not_included': return RELAY_CLOSE.notIncluded;
    case 'device_revoked': return RELAY_CLOSE.deviceRevoked;
    case 'session_ended': return RELAY_CLOSE.sessionEnded;
  }
}

/** An Ed25519 public key: 32 bytes, base64url without padding. */
export const RELAY_PUBLIC_KEY = /^[A-Za-z0-9_-]{43}$/;
/** An Ed25519 signature: 64 bytes, base64url without padding. */
export const RELAY_SIGNATURE = /^[A-Za-z0-9_-]{86}$/;
/** A challenge nonce: 32 random bytes, base64url without padding. */
export const RELAY_NONCE = /^[A-Za-z0-9_-]{43}$/;

/**
 * The exact bytes a desktop signs to answer a challenge. The first two lines
 * keep a relay signature from ever reading as anything else, and the business
 * and device bind it to the connection that asked.
 */
export function challengePayload(input: { organizationId: string; deviceId: string; nonce: string }): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(
    `nectovia-relay/1\ndesktop-challenge\n${input.organizationId}\n${input.deviceId}\n${input.nonce}`,
  ) as Uint8Array<ArrayBuffer>;
}

// --- hub to desktop --------------------------------------------------------------

export interface ChallengeMessage {
  v: 1;
  type: 'challenge';
  organizationId: string;
  deviceId: string;
  nonce: string;
  expiresInMs: number;
}
export interface ReadyMessage {
  v: 1;
  type: 'ready';
  deviceId: string;
  heartbeatMs: number;
  timeoutMs: number;
  /** When the sign-in this connection was opened with expires; the hub closes it then (4000). */
  authorizedUntil: string;
}
export interface PongMessage {
  v: 1;
  type: 'pong';
}
export type HubMessage = ChallengeMessage | ReadyMessage | PongMessage;

const hubMessageSchema = z.discriminatedUnion('type', [
  z.strictObject({
    v: z.literal(1),
    type: z.literal('challenge'),
    organizationId: z.string().min(1).max(128),
    deviceId: z.string().min(1).max(128),
    nonce: z.string().regex(RELAY_NONCE),
    expiresInMs: z.number().int().positive().max(60_000),
  }),
  z.strictObject({
    v: z.literal(1),
    type: z.literal('ready'),
    deviceId: z.string().min(1).max(128),
    heartbeatMs: z.number().int().min(1_000).max(300_000),
    timeoutMs: z.number().int().min(1_000).max(900_000),
    authorizedUntil: z.iso.datetime(),
  }),
  z.strictObject({ v: z.literal(1), type: z.literal('pong') }),
]);

// --- desktop to hub --------------------------------------------------------------

export interface ProveMessage {
  v: 1;
  type: 'prove';
  signature: string;
}
export interface PingMessage {
  v: 1;
  type: 'ping';
}
export type DesktopMessage = ProveMessage | PingMessage;

const desktopMessageSchema = z.discriminatedUnion('type', [
  z.strictObject({ v: z.literal(1), type: z.literal('prove'), signature: z.string().regex(RELAY_SIGNATURE) }),
  z.strictObject({ v: z.literal(1), type: z.literal('ping') }),
]);

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** A desktop frame from the closed set, or null for anything else. */
export function parseDesktopMessage(text: string): DesktopMessage | null {
  const parsed = desktopMessageSchema.safeParse(parseJson(text));
  return parsed.success ? parsed.data : null;
}

/** A hub frame from the closed set, or null for anything else. */
export function parseHubMessage(text: string): HubMessage | null {
  const parsed = hubMessageSchema.safeParse(parseJson(text));
  return parsed.success ? (parsed.data as HubMessage) : null;
}

/** The URL a desktop dials for one business, from the account service's own address. */
export function desktopRelayUrl(base: string, organizationId: string): string {
  const url = new URL(`${base.replace(/\/+$/, '')}/relay/v1/organizations/${encodeURIComponent(organizationId)}/desktop`);
  url.protocol = url.protocol === 'https:' ? 'wss:' : url.protocol === 'http:' ? 'ws:' : url.protocol;
  return url.href;
}
