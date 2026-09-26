/**
 * The phone relay's device records (relay plan steps 1 and 2, 2026-09-26).
 *
 * The desktop never listens. When a Business owner or Manager turns on "Reach
 * this computer from your phone", the desktop makes an Ed25519 key and
 * registers its public half here as a device of that business. From then on
 * the desktop dials out to the business's relay hub and proves the key on
 * every connect; the phone asks the hub which computers are online.
 *
 * Everything here needs the business to hold the `phone-relay` feature, except
 * stopping: revoking a device only ever takes access away, so a lapsed plan
 * never strands a computer's record or blocks a sign-out. A revoked device is a
 * tombstone (revoked_at), never a deleted row, and can never connect again.
 * Public keys are never answered; nothing here holds a signing key.
 */
import { z } from 'zod';
import { PHONE_RELAY_FEATURE, PHONE_RELAY_NOT_INCLUDED_REASON } from '../../../../shared/access.js';
import type { MemberRole } from '../../../../shared/workspaces.js';
import type { AccountService } from '../account-service.js';
import { entitlementFromGrants, type FeatureGrant } from '../commercial.js';
import { fromBase64url } from '../crypto.js';
import { accountId, type AccountMembershipSnapshot, type MembershipRow, type SessionRecord } from '../domain.js';
import { AccountError } from '../errors.js';
import { desktopGrantSchema, type DesktopGrant, type HubAuthority } from './hub-core.js';
import { RELAY_CLOSE, RELAY_DEVICE_HEADER, RELAY_PUBLIC_KEY, type RelayClose, type RelayRefusalCode } from './protocol.js';

/** The most computers one business may keep registered at once. */
export const RELAY_DEVICE_LIMIT = 50;

const time = z.iso.datetime();

export const relayDeviceSchema = z.strictObject({
  deviceId: accountId,
  tenantId: accountId,
  organizationId: accountId,
  /** The person who turned it on. The desktop connects with this person's sign-in only. */
  personId: accountId,
  publicKey: z.string().regex(RELAY_PUBLIC_KEY),
  label: z.string().min(1).max(60),
  createdAt: time,
  revokedAt: time.nullable(),
  revokedBy: accountId.nullable(),
  lastSeenAt: time.nullable(),
});
export type RelayDevice = z.infer<typeof relayDeviceSchema>;

/** A refusal with a stable code the desktop and the phone apps branch on. */
export class RelayError extends AccountError {
  readonly code: string;
  constructor(status: number, message: string, code: string) {
    super(status, message);
    this.name = 'RelayError';
    this.code = code;
  }
}

/** The sentence and status each refusal answers with over HTTP. */
export const RELAY_REFUSAL_ANSWERS: Record<RelayRefusalCode, { status: number; message: string }> = {
  not_a_member: { status: 403, message: 'This Business workspace is unavailable to this person.' },
  role_not_allowed: { status: 403, message: 'Only the Business owner or a Manager can let a phone reach a computer.' },
  phone_relay_not_included: { status: 403, message: PHONE_RELAY_NOT_INCLUDED_REASON },
  device_revoked: { status: 404, message: "This computer isn't registered for phone access. Turn it on again from the computer." },
  session_ended: { status: 401, message: 'Your sign-in ended. Sign in again.' },
};

export const refusal = (code: RelayRefusalCode) =>
  new RelayError(RELAY_REFUSAL_ANSWERS[code].status, RELAY_REFUSAL_ANSWERS[code].message, code);

/**
 * Who may register a computer: an active Business owner or Manager. Whether an
 * Employee may register their own computer is the relay plan's open question
 * for Andrew; until he answers, the owner-safe default is no.
 */
export function mayRegisterComputer(role: MemberRole): boolean {
  return role === 'owner' || role === 'admin';
}

/** Whether a business's current grants include phone access, at a moment. */
export function includesPhoneRelay(grants: readonly FeatureGrant[], at: string): boolean {
  const view = entitlementFromGrants(grants, 0, at);
  return view.state === 'active' && view.features.includes(PHONE_RELAY_FEATURE);
}

/** 32 bytes in canonical base64url: the only public key shape the hub can verify with. */
export function isRelayPublicKey(value: string): boolean {
  if (!RELAY_PUBLIC_KEY.test(value)) return false;
  try {
    return fromBase64url(value).length === 32;
  } catch {
    return false;
  }
}

export const registerDeviceInput = z.strictObject({
  publicKey: z.string().refine(isRelayPublicKey),
  label: z.string().trim().min(1).max(60).regex(/^[^\u0000-\u001f\u007f]+$/),
});

// --- persistence -------------------------------------------------------------------

/**
 * Database operations only, never a provider call. The member, grant and
 * session reads are the account and access tables' rows by id, so the relay
 * hub can recheck a live connection without the person's bearer.
 */
export interface RelayTransaction {
  /** Serializes registrations and revocations for one business. */
  lockOrganization(organizationId: string): Promise<void>;
  /** The business's devices that are not revoked, oldest first. Bounded. */
  devices(organizationId: string): Promise<RelayDevice[]>;
  /** One device of this business, revoked or not. Another business's device reads as absent. */
  device(organizationId: string, deviceId: string): Promise<RelayDevice | undefined>;
  insertDevice(row: RelayDevice): Promise<void>;
  /** Writes the tombstone once. False when the device is unknown or already revoked. */
  revokeDevice(organizationId: string, deviceId: string, at: string, by: string): Promise<boolean>;
  /** Moves last_seen_at forward on a device that is not revoked. Never backward. */
  touchDevice(organizationId: string, deviceId: string, at: string): Promise<void>;
  member(organizationId: string, personId: string): Promise<MembershipRow | undefined>;
  grants(organizationId: string): Promise<FeatureGrant[]>;
  session(issuer: string, sessionId: string): Promise<SessionRecord | undefined>;
}
export interface RelayRepository {
  transaction<T>(action: (tx: RelayTransaction) => Promise<T>): Promise<T>;
}

/**
 * The business's relay hub, as the account routes reach it: a Durable Object
 * keyed by organization id on Cloudflare, an in-process hub in the faux cloud.
 * Null where no hub is bound, and then no computer can be connected at all.
 */
export interface RelayHubs {
  /** The ids of this business's devices with a proven connection right now. */
  presence(organizationId: string): Promise<ReadonlySet<string>>;
  /** Hands an authorized desktop's upgrade request to the business's hub, and answers the upgrade. */
  connect(grant: DesktopGrant, request: Request): Promise<Response>;
  /** Ends a device's connection now. The hub's own recheck would end it within 30 seconds anyway. */
  end(organizationId: string, deviceId: string, close: RelayClose): Promise<void>;
}

// --- what a connected computer rests on ------------------------------------------------

/** The device, person and sign-in behind a desktop connection, all by id: the hub holds no bearer. */
export interface DesktopIdentity {
  organizationId: string;
  deviceId: string;
  personId: string;
  issuer: string;
  sessionId: string;
  /** The key the connection proved; null at the Worker front, before any proof. */
  publicKey: string | null;
}

/**
 * Whether a desktop may be connected now: its device is registered, not revoked
 * and was registered by this person with this key; the person is an active owner
 * or Manager; the business's plan includes phone access; and the sign-in is not
 * revoked. The Worker front runs it at connect and the hub every 20 seconds.
 */
export async function checkDesktop(tx: RelayTransaction, who: DesktopIdentity, at: string):
  Promise<{ ok: true; device: RelayDevice } | { ok: false; refusal: RelayRefusalCode }> {
  const device = await tx.device(who.organizationId, who.deviceId);
  if (!device || device.revokedAt !== null || device.personId !== who.personId || (who.publicKey !== null && device.publicKey !== who.publicKey))
    return { ok: false, refusal: 'device_revoked' };
  const member = await tx.member(who.organizationId, who.personId);
  if (!member || member.record.state !== 'active') return { ok: false, refusal: 'not_a_member' };
  if (!mayRegisterComputer(member.record.role)) return { ok: false, refusal: 'role_not_allowed' };
  if (!includesPhoneRelay(await tx.grants(who.organizationId), at)) return { ok: false, refusal: 'phone_relay_not_included' };
  const session = await tx.session(who.issuer, who.sessionId);
  if (!session || session.revokedAt !== null || session.personId !== who.personId) return { ok: false, refusal: 'session_ended' };
  return { ok: true, device };
}

/** The hub's rechecks and last-seen writes, over the repository alone. */
export class RelayAuthority implements HubAuthority {
  constructor(private readonly repository: RelayRepository) {}
  async recheck(grant: DesktopGrant, at: string): Promise<RelayRefusalCode | null> {
    const result = await this.repository.transaction((tx) => checkDesktop(tx, grant, at));
    return result.ok ? null : result.refusal;
  }
  seen(grant: DesktopGrant, at: string): Promise<void> {
    return this.repository.transaction((tx) => tx.touchDevice(grant.organizationId, grant.deviceId, at));
  }
}

// --- answers -----------------------------------------------------------------------

export interface RelayDeviceView {
  deviceId: string;
  label: string;
  online: boolean;
  /** Now when online; otherwise when the hub last had it, or null if it never connected. */
  lastSeenAt: string | null;
  createdAt: string;
  /** Registered by the person asking. */
  mine: boolean;
  /** Whether the person asking may revoke it: the person who registered it, or a Business owner. */
  canRevoke: boolean;
}

export interface RelayDevicesAnswer {
  organizationId: string;
  devices: RelayDeviceView[];
  checkedAt: string;
}

/** What the phone reads: each computer, whether it is online now, and when it was last seen. */
export interface RelayPresenceAnswer {
  organizationId: string;
  devices: Pick<RelayDeviceView, 'deviceId' | 'label' | 'online' | 'lastSeenAt'>[];
  checkedAt: string;
}

/** A desktop's dial checked without the upgrade: the same checks, answered in JSON. */
export interface DesktopCheckAnswer {
  organizationId: string;
  deviceId: string;
  /** When the bearer it checked expires: a connection opened now ends then. */
  authorizedUntil: string;
}

const newDeviceId = () => `relay_device_${crypto.randomUUID()}`;

export class RelayService {
  protected readonly now: () => number;

  constructor(
    protected readonly accounts: AccountService,
    protected readonly repository: RelayRepository,
    protected readonly hubs: RelayHubs | null,
    options: { now?: () => number } = {},
  ) {
    this.now = options.now ?? Date.now;
  }

  protected at() {
    return new Date(this.now()).toISOString();
  }

  /** The verified person and their membership. A person outside the business is `not_a_member`. */
  protected async member(token: string, organizationId: string): Promise<AccountMembershipSnapshot> {
    try {
      return await this.accounts.membership(token, organizationId);
    } catch (error) {
      if (error instanceof AccountError && error.status === 403 && !(error instanceof RelayError))
        throw new RelayError(403, error.message, 'not_a_member');
      throw error;
    }
  }

  /** The ids of this business's devices online now. No hub bound: none can be. */
  protected async online(organizationId: string): Promise<ReadonlySet<string>> {
    if (!this.hubs) return new Set();
    try {
      return await this.hubs.presence(organizationId);
    } catch {
      throw new RelayError(503, "Phone access can't be checked right now. Try again shortly.", 'relay_unavailable');
    }
  }

  /** Register this computer. The caller is an active owner or Manager of a business with phone access. */
  async register(token: string, organizationId: string, input: z.infer<typeof registerDeviceInput>) {
    const parsed = registerDeviceInput.safeParse(input);
    if (!parsed.success)
      throw new RelayError(422, 'A computer needs an Ed25519 public key and a name of up to 60 characters.', 'invalid_device');
    const snapshot = await this.member(token, organizationId);
    return this.repository.transaction(async (tx) => {
      await tx.lockOrganization(organizationId);
      const at = this.at();
      if (!includesPhoneRelay(await tx.grants(organizationId), at)) throw refusal('phone_relay_not_included');
      // The role is read again under the lock, so a demotion that lands first is honoured.
      const member = await tx.member(organizationId, snapshot.person.id);
      if (!member || member.record.state !== 'active') throw refusal('not_a_member');
      if (!mayRegisterComputer(member.record.role)) throw refusal('role_not_allowed');
      if ((await tx.devices(organizationId)).length >= RELAY_DEVICE_LIMIT)
        throw new RelayError(409, `This business already lets phones reach ${RELAY_DEVICE_LIMIT} computers. Stop one first.`, 'device_limit');
      const row: RelayDevice = {
        deviceId: newDeviceId(),
        tenantId: snapshot.organization.tenantId,
        organizationId,
        personId: snapshot.person.id,
        publicKey: parsed.data.publicKey,
        label: parsed.data.label,
        createdAt: at,
        revokedAt: null,
        revokedBy: null,
        lastSeenAt: null,
      };
      await tx.insertDevice(row);
      return { deviceId: row.deviceId, organizationId, label: row.label, createdAt: row.createdAt };
    });
  }

  /**
   * Stop a computer being reachable: the person who registered it, or an active
   * Business owner. Needs no plan. Revocation deletes nothing on the computer.
   */
  async revoke(token: string, organizationId: string, deviceId: string): Promise<void> {
    if (!accountId.safeParse(deviceId).success)
      throw new RelayError(404, 'That computer is not registered for phone access.', 'device_unknown');
    const snapshot = await this.member(token, organizationId);
    await this.repository.transaction(async (tx) => {
      await tx.lockOrganization(organizationId);
      const device = await tx.device(organizationId, deviceId);
      if (!device || device.revokedAt !== null)
        throw new RelayError(404, 'That computer is not registered for phone access.', 'device_unknown');
      if (device.personId !== snapshot.person.id && snapshot.membership.role !== 'owner')
        throw new RelayError(403, 'Only the person who turned it on or the Business owner can stop a phone reaching this computer.', 'role_not_allowed');
      if (!(await tx.revokeDevice(organizationId, deviceId, this.at(), snapshot.person.id)))
        throw new RelayError(404, 'That computer is not registered for phone access.', 'device_unknown');
    });
    // The tombstone is written. End its live connection now; if the hub can't be
    // reached, its recheck ends the connection within 30 seconds anyway.
    await this.hubs?.end(organizationId, deviceId, RELAY_CLOSE.deviceRevoked).catch(() => {});
  }

  /** The business's computers as any member sees them: name, online or not, last seen. Never a key. */
  async devices(token: string, organizationId: string): Promise<RelayDevicesAnswer> {
    const snapshot = await this.member(token, organizationId);
    const at = this.at();
    const devices = await this.repository.transaction(async (tx) => {
      if (!includesPhoneRelay(await tx.grants(organizationId), at)) throw refusal('phone_relay_not_included');
      return tx.devices(organizationId);
    });
    const online = await this.online(organizationId);
    return {
      organizationId,
      devices: devices.map((device) => {
        const mine = device.personId === snapshot.person.id;
        return {
          deviceId: device.deviceId,
          label: device.label,
          online: online.has(device.deviceId),
          lastSeenAt: online.has(device.deviceId) ? at : device.lastSeenAt,
          createdAt: device.createdAt,
          mine,
          canRevoke: mine || snapshot.membership.role === 'owner',
        };
      }),
      checkedAt: at,
    };
  }

  /** The phone's view: each computer of the business, online or not, and when it was last seen. */
  async presence(token: string, organizationId: string): Promise<RelayPresenceAnswer> {
    const answer = await this.devices(token, organizationId);
    return {
      organizationId,
      devices: answer.devices.map(({ deviceId, label, online, lastSeenAt }) => ({ deviceId, label, online, lastSeenAt })),
      checkedAt: answer.checkedAt,
    };
  }

  /**
   * Everything a desktop's connection rests on, checked with its bearer: the
   * person is an active owner or Manager, the plan includes phone access, and
   * the device is theirs and not revoked. The grant carries it to the hub.
   */
  async authorizeDesktop(token: string, organizationId: string, deviceId: string): Promise<DesktopGrant> {
    if (!accountId.safeParse(deviceId).success)
      throw new RelayError(400, `A computer names its registration in the ${RELAY_DEVICE_HEADER} header.`, 'device_required');
    const snapshot = await this.member(token, organizationId);
    const at = this.at();
    const who: DesktopIdentity = {
      organizationId, deviceId, personId: snapshot.person.id, issuer: snapshot.mapping.issuer, sessionId: snapshot.sessionId, publicKey: null,
    };
    const result = await this.repository.transaction((tx) => checkDesktop(tx, who, at));
    if (!result.ok) throw refusal(result.refusal);
    return desktopGrantSchema.parse({
      organizationId, tenantId: snapshot.organization.tenantId, deviceId, personId: who.personId, publicKey: result.device.publicKey,
      issuer: who.issuer, sessionId: who.sessionId, authorizedUntil: new Date(snapshot.expiresAt).toISOString(), checkedAt: at,
    });
  }

  /**
   * A desktop dialling in. With a WebSocket upgrade the business's hub takes the
   * connection. Without one the same checks answer in JSON, which is how a
   * desktop learns why a dial was refused: a refused upgrade shows no reason.
   */
  async desktop(token: string, organizationId: string, request: Request): Promise<Response | DesktopCheckAnswer> {
    const grant = await this.authorizeDesktop(token, organizationId, request.headers.get(RELAY_DEVICE_HEADER) ?? '');
    if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket')
      return { organizationId, deviceId: grant.deviceId, authorizedUntil: grant.authorizedUntil };
    if (!this.hubs) throw new RelayError(503, "Phone access isn't available right now. Try again shortly.", 'relay_unavailable');
    return this.hubs.connect(grant, request);
  }
}
