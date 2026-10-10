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
 * closed set. Steps 3 and 4 add types after `ready` (the end of this file) and a
 * phone endpoint; the handshake does not change.
 */
import { z } from 'zod';
import { WORK_ROWS_RELAY_LIMIT, WORK_ROW_TITLE_LIMIT, type WorkerRow, type WorkerRowPayer } from '../../../../shared/work-rows.js';

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
  connectionLimit: { code: 4004, reason: 'connection_limit' },
  upgradeRateLimited: { code: 4005, reason: 'upgrade_rate_limited' },
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

/**
 * The heartbeat frames, byte for byte. On Cloudflare the hub answers a ping
 * without waking (a Durable Object auto-response matches the exact text), so a
 * desktop sends exactly RELAY_PING_FRAME, which is JSON.stringify of a ping.
 */
export const RELAY_PING_FRAME = '{"v":1,"type":"ping"}';
export const RELAY_PONG_FRAME = '{"v":1,"type":"pong"}';

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
  return relayUrl(base, organizationId, 'desktop');
}

/** The URL a phone dials for one business (relay plan step 3). */
export function phoneRelayUrl(base: string, organizationId: string): string {
  return relayUrl(base, organizationId, 'phone');
}

function relayUrl(base: string, organizationId: string, side: 'desktop' | 'phone'): string {
  const url = new URL(`${base.replace(/\/+$/, '')}/relay/v1/organizations/${encodeURIComponent(organizationId)}/${side}`);
  url.protocol = url.protocol === 'https:' ? 'wss:' : url.protocol === 'http:' ? 'ws:' : url.protocol;
  return url.href;
}

// --- steps 3 and 4: messages after `ready` ---------------------------------------------
//
// A phone reaches a desktop through the hub and nothing else. A phone frame names the
// desktop it is for; the hub forwards it only to a desktop registered by the same person,
// stamped with who sent it (`from`). A desktop frame goes to that person's phones, stamped
// with the computer it came from (`source`), so a phone holding several of that person's
// computers knows whose Need or Board it reads. The hub reads each frame against these
// schemas and drops anything else, so a type either side doesn't know never crosses. Every
// frame stays within RELAY_MAX_MESSAGE_BYTES.

/** Ids inside steps 3 and 4: up to 128 characters, no spaces. A phone's command id may lead with `_` or `-`. */
export const RELAY_ID = /^[A-Za-z0-9_-][A-Za-z0-9._:-]{0,127}$/;
/** A command's id, minted by the phone once per command and kept across retries. */
export const RELAY_COMMAND_ID = /^[A-Za-z0-9_-]{8,64}$/;
/** An account id, as the hub stamps it in `from`. */
const RELAY_ACCOUNT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/** What the hub holds phones and desktops to. */
export const RELAY_LIMITS = {
  /** One ready socket plus at most two concurrent reconnect challenges for a device. */
  desktopPendingPerDevice: 2,
  desktopSocketsPerDevice: 3,
  /** Bound independent devices and reconnects opened by one verified person. */
  desktopPendingPerPerson: 8,
  desktopSocketsPerPerson: 16,
  /** One core is one organization's hub. These include restored sockets. */
  desktopPendingPerOrganization: 64,
  desktopSocketsPerOrganization: 256,
  /** Both desktop and phone sockets, including bounded phone replacement overlap. */
  socketsPerPerson: 21,
  socketsPerOrganization: 512,
  /** Bound queued storage work before any upgrade is accepted. */
  queuedUpgradesPerOrganization: 64,
  /** Upgrade reservations per minute. Capacity refusals allocate no rate or socket state. */
  upgradesPerDevice: 6,
  upgradesPerPerson: 30,
  upgradesPerOrganization: 240,
  /** Phone connections one person may hold to one business's hub. A newer one replaces the oldest (4409). */
  phoneSocketsPerPerson: 5,
  /** Frames one person's phones may send to desktops, per minute. Over it, a command is refused `rate_limited`. */
  phoneCommandsPerMinute: 30,
  /** Frames one desktop may send to phones, per minute. Over it, the hub drops them. */
  desktopFramesPerMinute: 120,
} as const;

/**
 * The most bytes the hub's `from` stamp adds to a phone frame: two account ids of up to 128
 * characters and their keys. A stamped frame over RELAY_MAX_MESSAGE_BYTES is refused
 * `too_large`, so a phone keeps each frame within RELAY_MAX_MESSAGE_BYTES minus this.
 */
export const RELAY_STAMP_RESERVE_BYTES = 300;

/**
 * The most bytes the hub's `source` stamp adds to a desktop's frame for phones: one device id of
 * up to 128 characters and its keys (153 bytes). A frame the stamp would push past
 * RELAY_MAX_MESSAGE_BYTES goes out as sent, which a phone cannot attribute, so a desktop keeps
 * each frame for phones within RELAY_MAX_MESSAGE_BYTES minus this.
 */
export const RELAY_SOURCE_RESERVE_BYTES = 160;

/** Timings the desktop keeps for steps 3 and 4. The hub's own are RELAY_TIMINGS. */
export const RELAY_MESSAGE_TIMINGS = {
  /** How long after a `need.summary` is sent a decision from the phone is taken. Kept on the desktop, per Need. */
  needDecisionMs: 10 * 60_000,
  /** How long a desktop remembers a command id and the result it answered. */
  commandMemoryMs: 24 * 60 * 60_000,
  /** The least time between two frames of one type for one project. */
  coalesceMs: 1_000,
  /** How long after a phone's last frame the desktop keeps sending changes. A phone says `hello` again to stay. */
  attentionMs: 5 * 60_000,
} as const;

/** The refusal codes the hub answers a phone's command with, in a `result`. */
export const RELAY_HUB_REFUSALS = ['rate_limited', 'device_offline', 'not_your_device', 'too_large'] as const;
export type RelayHubRefusal = (typeof RELAY_HUB_REFUSALS)[number];

const id = z.string().regex(RELAY_ID);
const time = z.iso.datetime();
/** One line of plain words: no control characters. */
const words = (max: number, min = 0) =>
  z.string().min(min).max(max).regex(/^[^\u0000-\u001f\u007f]*$/);
/** Assistant or person text: line breaks and tabs allowed, other control characters not. */
const prose = (max: number, min = 0) =>
  z.string().min(min).max(max).regex(/^[^\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]*$/);
/** A file named in words: never a path, never empty. */
const fileName = words(80, 1).refine((name) => !/[\\/]/.test(name) && name.trim().length > 0);
const payer = z.enum(['nectovia-credits', 'your-subscription', 'your-key', 'local', 'unknown']);

export type ConversationRef = { kind: 'home' } | { kind: 'project'; projectId: string } | { kind: 'member'; projectId: string; slotId: string };
const conversationRefSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('home') }),
  z.strictObject({ kind: z.literal('project'), projectId: id }),
  z.strictObject({ kind: z.literal('member'), projectId: id, slotId: id }),
]);

const workerRowSchema = z.strictObject({
  rowId: id,
  kind: z.enum(['h14-worker', 'external-worker', 'team-member', 'session']),
  label: words(40, 1),
  title: words(WORK_ROW_TITLE_LIMIT),
  state: z.enum(['queued', 'working', 'waiting', 'stop-requested', 'stopped', 'answered', 'failed', 'unknown']),
  startedAt: time.nullable(),
  verification: z.enum(['verified', 'unverified', 'failed', 'not-run']),
  payer,
  quota: z.strictObject({ window: words(40, 1), remainingPercent: z.number().min(0).max(100) }).optional(),
}) satisfies z.ZodType<WorkerRow>;

// desktop to phone

export interface WorkRowsMessage {
  v: 1;
  type: 'work.rows';
  projectId: string;
  rootRunId: string | null;
  taskTitle: string | null;
  rows: WorkerRow[];
  at: string;
}
export interface BoardCard {
  taskId: string;
  title: string;
  column: string;
  workerLabel: string | null;
  payer: WorkerRowPayer;
}
export interface BoardCountsMessage {
  v: 1;
  type: 'board.counts';
  projectId: string;
  columns: { name: string; count: number }[];
  cards: BoardCard[];
  page: number;
  pages: number;
  at: string;
}
/** One part of a Need's summary. A summary that doesn't fit one frame continues in the next part, field by field. */
export interface NeedSummaryMessage {
  v: 1;
  type: 'need.summary';
  needId: string;
  projectId: string;
  taskTitle: string;
  what: string;
  why: string;
  consequence: string;
  files: string[];
  expiresAt: string;
  part: number;
  parts: number;
}
export type TurnStatus = 'running' | 'done' | 'failed' | 'stopped';
/** A turn's assistant text, in order by `seq`. `turnId` is the `commandId` of the `message.send` that started it. */
export interface TurnUpdateMessage {
  v: 1;
  type: 'turn.update';
  conversation: ConversationRef;
  turnId: string;
  status: TurnStatus;
  text: string;
  seq: number;
}
export type ResultOutcome = 'accepted' | 'refused' | 'already-done' | 'expired';
/** The answer to one phone command, from the desktop or (refusals only) the hub. */
export interface ResultMessage {
  v: 1;
  type: 'result';
  commandId: string;
  outcome: ResultOutcome;
  code?: string;
  message?: string;
}
export type DesktopToPhoneMessage = WorkRowsMessage | BoardCountsMessage | NeedSummaryMessage | TurnUpdateMessage | ResultMessage;

// Each desktop frame's fields, kept apart from its schema: a desktop sends them as they are, and a
// phone reads them with the hub's `source` added (phoneBoundSchema, below).
const workRowsFields = {
  v: z.literal(1),
  type: z.literal('work.rows'),
  projectId: id,
  rootRunId: id.nullable(),
  taskTitle: words(WORK_ROW_TITLE_LIMIT).nullable(),
  rows: z.array(workerRowSchema).max(WORK_ROWS_RELAY_LIMIT),
  at: time,
};
const boardCountsFields = {
  v: z.literal(1),
  type: z.literal('board.counts'),
  projectId: id,
  columns: z.array(z.strictObject({ name: words(40, 1), count: z.number().int().min(0).max(1_000_000) })).max(8),
  cards: z.array(z.strictObject({
    taskId: id,
    title: words(WORK_ROW_TITLE_LIMIT),
    column: words(40, 1),
    workerLabel: words(40, 1).nullable(),
    payer,
  })).max(10),
  page: z.number().int().min(1).max(10_000),
  pages: z.number().int().min(1).max(10_000),
  at: time,
};
const needSummaryFields = {
  v: z.literal(1),
  type: z.literal('need.summary'),
  needId: id,
  projectId: id,
  taskTitle: words(WORK_ROW_TITLE_LIMIT),
  what: prose(300),
  why: prose(300),
  consequence: prose(600),
  files: z.array(fileName).max(10),
  expiresAt: time,
  part: z.number().int().min(1).max(100),
  parts: z.number().int().min(1).max(100),
};
const turnUpdateFields = {
  v: z.literal(1),
  type: z.literal('turn.update'),
  conversation: conversationRefSchema,
  turnId: id,
  status: z.enum(['running', 'done', 'failed', 'stopped']),
  text: prose(3_000),
  seq: z.number().int().min(0).max(1_000_000),
};
const resultFields = {
  v: z.literal(1),
  type: z.literal('result'),
  commandId: z.string().regex(RELAY_COMMAND_ID),
  outcome: z.enum(['accepted', 'refused', 'already-done', 'expired']),
  code: z.string().regex(/^[A-Za-z][A-Za-z0-9_.-]{0,39}$/).optional(),
  message: words(200, 1).optional(),
};
const pageWithinPages = (message: { page: number; pages: number }) => message.page <= message.pages;
const partWithinParts = (message: { part: number; parts: number }) => message.part <= message.parts;

/** A desktop's own frame for phones. A desktop cannot send `source`: the hub stamps it. */
const desktopToPhoneSchema = z.discriminatedUnion('type', [
  z.strictObject(workRowsFields),
  z.strictObject(boardCountsFields).refine(pageWithinPages),
  z.strictObject(needSummaryFields).refine(partWithinParts),
  z.strictObject(turnUpdateFields),
  z.strictObject(resultFields),
]);

// phone to desktop

/** Who sent a phone frame, from the phone's verified sign-in. The hub stamps it; a phone's own copy is replaced. */
export interface RelayFrom {
  personId: string;
  sessionId: string;
}
export type StopTarget = { kind: 'run'; runId: string } | { kind: 'task'; taskId: string };
export type NeedDecision = 'go-ahead' | 'declined';
export type PhoneCommand =
  | { v: 1; type: 'hello'; deviceId: string }
  | { v: 1; type: 'board.page'; deviceId: string; projectId: string; page: number }
  | { v: 1; type: 'need.decision'; deviceId: string; commandId: string; needId: string; decision: NeedDecision }
  | { v: 1; type: 'stop.request'; deviceId: string; commandId: string; projectId: string; target: StopTarget }
  | { v: 1; type: 'message.send'; deviceId: string; commandId: string; conversation: ConversationRef; text: string }
  | { v: 1; type: 'member.wake'; deviceId: string; commandId: string; projectId: string; slotId: string };
/** A phone command as the hub forwards it to the desktop it names. */
export type RelayedPhoneMessage = PhoneCommand & { from: RelayFrom };
/** What a phone may send the hub: a command for a desktop, or a heartbeat. */
export type PhoneMessage = (PhoneCommand & { from?: RelayFrom }) | PingMessage;
/**
 * Which computer a frame for phones came from. The hub stamps it from that desktop's proven grant, over
 * nothing a desktop sent: a desktop's own frame carrying `source` is refused.
 */
export interface RelaySource {
  deviceId: string;
}
/**
 * What a phone reads: desktop frames, each with the hub's `source` unless the stamp would not fit, the
 * hub's refusals (a `result`, with no `source`) and heartbeats.
 */
export type PhoneBoundMessage = (DesktopToPhoneMessage & { source?: RelaySource }) | PongMessage;

const fromSchema = z.strictObject({
  personId: z.string().regex(RELAY_ACCOUNT_ID),
  sessionId: z.string().regex(RELAY_ACCOUNT_ID),
});
const commandId = z.string().regex(RELAY_COMMAND_ID);
const deviceId = z.string().regex(RELAY_ACCOUNT_ID);

/** The phone commands' fields, with `from` as `stamp` says: optional from a phone, required from the hub. */
function phoneCommandSchema<Stamp extends z.ZodType>(stamp: Stamp) {
  return z.discriminatedUnion('type', [
    z.strictObject({ v: z.literal(1), type: z.literal('hello'), deviceId, from: stamp }),
    z.strictObject({ v: z.literal(1), type: z.literal('board.page'), deviceId, projectId: id, page: z.number().int().min(1).max(10_000), from: stamp }),
    z.strictObject({
      v: z.literal(1), type: z.literal('need.decision'), deviceId, commandId, needId: id, decision: z.enum(['go-ahead', 'declined']), from: stamp,
    }),
    z.strictObject({
      v: z.literal(1), type: z.literal('stop.request'), deviceId, commandId, projectId: id,
      target: z.discriminatedUnion('kind', [
        z.strictObject({ kind: z.literal('run'), runId: id }),
        z.strictObject({ kind: z.literal('task'), taskId: id }),
      ]),
      from: stamp,
    }),
    z.strictObject({
      v: z.literal(1), type: z.literal('message.send'), deviceId, commandId, conversation: conversationRefSchema,
      text: prose(2_000, 1).refine((text) => text.trim().length > 0), from: stamp,
    }),
    z.strictObject({ v: z.literal(1), type: z.literal('member.wake'), deviceId, commandId, projectId: id, slotId: id, from: stamp }),
  ]);
}
const phoneSchema = z.union([
  z.strictObject({ v: z.literal(1), type: z.literal('ping') }),
  phoneCommandSchema(fromSchema.optional()),
]);
const relayedSchema = phoneCommandSchema(fromSchema);
/** A desktop frame as a phone reads it: the hub's `source` when the stamp fit, nothing else added. */
const stamped = { source: z.strictObject({ deviceId }).optional() };
const phoneBoundSchema = z.union([
  z.discriminatedUnion('type', [
    z.strictObject({ ...workRowsFields, ...stamped }),
    z.strictObject({ ...boardCountsFields, ...stamped }).refine(pageWithinPages),
    z.strictObject({ ...needSummaryFields, ...stamped }).refine(partWithinParts),
    z.strictObject({ ...turnUpdateFields, ...stamped }),
    z.strictObject({ ...resultFields, ...stamped }),
  ]),
  z.strictObject({ v: z.literal(1), type: z.literal('pong') }),
]);

/** A frame's text when it is a text frame within RELAY_MAX_MESSAGE_BYTES, else null. UTF-8 never takes fewer bytes than UTF-16 units. */
export function relayFrameText(data: unknown): string | null {
  if (typeof data !== 'string' || data.length > RELAY_MAX_MESSAGE_BYTES) return null;
  return new TextEncoder().encode(data).length <= RELAY_MAX_MESSAGE_BYTES ? data : null;
}

/** A message as one frame's text, or null when it would pass RELAY_MAX_MESSAGE_BYTES. */
export function serializeFrame(message: object): string | null {
  return relayFrameText(JSON.stringify(message));
}

function parseFrame<T>(schema: z.ZodType<T>, data: unknown): T | null {
  const text = relayFrameText(data);
  if (text === null) return null;
  const parsed = schema.safeParse(parseJson(text));
  return parsed.success ? parsed.data : null;
}

/** A desktop's frame for its person's phones (after `ready`), or null for anything else. */
export function parseDesktopToPhone(data: unknown): DesktopToPhoneMessage | null {
  return parseFrame(desktopToPhoneSchema, data) as DesktopToPhoneMessage | null;
}

/** A phone's frame for the hub: a command for a desktop or a ping, or null for anything else. */
export function parsePhoneMessage(data: unknown): PhoneMessage | null {
  return parseFrame(phoneSchema, data) as PhoneMessage | null;
}

/** A phone command as the hub forwards it, `from` stamped; null for anything else. What a desktop reads after `ready`. */
export function parseRelayedPhoneMessage(data: unknown): RelayedPhoneMessage | null {
  return parseFrame(relayedSchema, data) as RelayedPhoneMessage | null;
}

/** What a phone reads from the hub, or null for anything else. */
export function parsePhoneBound(data: unknown): PhoneBoundMessage | null {
  return parseFrame(phoneBoundSchema, data) as PhoneBoundMessage | null;
}
