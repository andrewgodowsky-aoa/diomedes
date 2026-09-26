/**
 * "Reach this computer from your phone" on the desktop (relay plan steps 1 and 2, 2026-09-26).
 *
 *   <data>/relay/computers.json   this computer's registrations, one per person and business
 *
 * Off by default, and offered only to a business whose plan includes phone access. An active
 * Business owner or Manager turns it on: the desktop makes an Ed25519 key, registers the public
 * half with the account service, seals the private half with the desktop's SecretBox exactly as a
 * kept sign-in is sealed, and starts a link that dials out. The desktop never listens.
 *
 * Turning it off, signing out, switching accounts or forgetting the account stops the link, drops
 * the key and removes the device record. When the account service can't be reached to remove the
 * record, the entry stays as a tombstone without a key and is removed at the next chance; without
 * the key the record can never connect again. A sign-in the service ended stops the links and
 * keeps the registrations, so signing in again resumes them. Closing the app closes the links, and
 * the next start dials again. Revocation never touches the desktop's files or history.
 */
import type { KeyObject } from 'node:crypto';
import path from 'node:path';
import { z } from 'zod';
import { PHONE_RELAY_FEATURE, PHONE_RELAY_NOT_INCLUDED_REASON } from '../../shared/access.js';
import { SIGN_IN_REQUIRED } from '../../shared/accounts.js';
import type { PhoneRelayView } from '../../shared/phone-relay.js';
import type { MemberRole } from '../../shared/workspaces.js';
import { desktopRelayUrl } from '../../services/control-plane/src/relay/protocol.js';
import { RELAY_REFUSAL_ANSWERS, mayRegisterComputer } from '../../services/control-plane/src/relay/service.js';
import type { AccountSessionService } from '../accounts/session.js';
import type { SecretBox } from '../connection-secrets.js';
import { ApiError } from '../paths.js';
import { durableWrite, readJson } from '../store.js';
import { computerLabel, newRelayKey, openRelayKey, sealRelayKey } from './keys.js';
import {
  RelayLink,
  runtimeRelaySocket,
  type LinkStatus,
  type LinkStop,
  type RelayAnswer,
  type RelayBearer,
  type RelaySocketFactory,
} from './link.js';

/** The most entries the file keeps. Tombstones go first. */
const MAX_ENTRIES = 100;
/** How soon a record the service couldn't remove is tried again. */
const RETRY_STOP_MS = 60_000;
/** The longest closing the app waits for a change in flight. */
const CLOSE_WAIT_MS = 5_000;

const entrySchema = z.object({
  /** The account service's address: registrations belong to one service. */
  service: z.string().min(1).max(300),
  organizationId: z.string().min(1).max(128),
  /** Who turned it on. The link dials only while this person is signed in. */
  personId: z.string().min(1).max(128),
  deviceId: z.string().min(1).max(128),
  label: z.string().min(1).max(60),
  /** base64 of SecretBox.seal(the private key, PKCS #8). Null once stopped: the key is gone. */
  sealedKey: z.string().max(8_192).nullable(),
  createdAt: z.string(),
  /** Stopped here; the account service hasn't yet confirmed the device record is gone. */
  revokePending: z.boolean(),
});
type Entry = z.infer<typeof entrySchema>;
const fileSchema = z.object({ v: z.literal(1), computers: z.array(entrySchema).max(MAX_ENTRIES) });

/** Why the switch can't be turned on, when it can't. */
interface Blocked {
  status: number;
  code: string;
  sentence: string;
}

export const PHONE_RELAY_SENTENCES = {
  notIncluded: PHONE_RELAY_NOT_INCLUDED_REASON,
  role: RELAY_REFUSAL_ANSWERS.role_not_allowed.message,
  notAMember: "You're no longer an active member of this business.",
  noStorage: "This computer can't protect the key phone access needs, so it can't be turned on here.",
  noTransport: "This copy of Nectovia can't connect to the relay, so a phone can't reach it.",
  keyUnreadable: "This computer can't open its key for phone access. Turn it off and on again.",
} as const;

/** The sentence for each refusal a hub closes with (4403) or the service answers (403). */
const REFUSALS: Record<string, string> = {
  not_a_member: PHONE_RELAY_SENTENCES.notAMember,
  role_not_allowed: PHONE_RELAY_SENTENCES.role,
  phone_relay_not_included: PHONE_RELAY_SENTENCES.notIncluded,
};

const keyOf = (entry: Pick<Entry, 'service' | 'organizationId' | 'personId'>) =>
  `${entry.service}\n${entry.organizationId}\n${entry.personId}`;

/** A failed call to the account service, as a link reads it. */
function failure(error: unknown): Exclude<RelayAnswer, { kind: 'ok' }> {
  if (!(error instanceof ApiError)) return { kind: 'unreachable' };
  const code = typeof error.details.code === 'string' ? error.details.code : null;
  if (code === 'unreachable') return { kind: 'unreachable' };
  return { kind: 'refused', status: error.status, code, sentence: (code && REFUSALS[code]) || error.message };
}

export interface PhoneRelayOptions {
  /** How the desktop dials out. Default: the runtime's WebSocket client; null where there is none. */
  socket?: RelaySocketFactory | null;
  hostname?: () => string;
  /** State changes, by device id. Never a key, a token or anything a message carried. */
  log?: (line: string) => void;
}

export class PhoneRelayService {
  private entries: Entry[] = [];
  private readonly links = new Map<string, RelayLink>();
  private readonly statuses = new Map<string, LinkStatus>();
  /** Why a switch went off without the person turning it off, until they change it. */
  private readonly notices = new Map<string, string>();
  /** Stops only the switch undoes: the key didn't match, or another copy took over. */
  private readonly halted = new Set<string>();
  private chain: Promise<unknown> = Promise.resolve();
  private retry: NodeJS.Timeout | null = null;
  private closed = false;
  private readonly socket: RelaySocketFactory | null;
  private readonly hostname: () => string;
  private readonly log: (line: string) => void;

  constructor(
    private readonly session: AccountSessionService,
    private readonly dataDir: string,
    private readonly box: SecretBox | null,
    options: PhoneRelayOptions = {},
  ) {
    this.socket = options.socket === undefined ? runtimeRelaySocket() : options.socket;
    this.hostname = options.hostname ?? (() => computerLabel());
    this.log = options.log ?? ((line) => console.info(line));
  }

  private get file() {
    return path.join(this.dataDir, 'relay', 'computers.json');
  }

  /** The account service's address, when a phone's relay can reach it. Null for an in-process service. */
  private service(): string | null {
    return this.session.backend.view().url;
  }

  private protectedStorage(): boolean {
    try {
      return this.box?.available() === true;
    } catch {
      return false;
    }
  }

  /** One change at a time: turning on or off, a sign-out, a sync. */
  private serial<T>(task: () => Promise<T>): Promise<T> {
    const run = this.chain.then(task, task);
    this.chain = run.catch(() => {});
    return run;
  }

  async init(): Promise<void> {
    const saved = await readJson<unknown>(this.file, () => ({ v: 1, computers: [] })).catch(() => null);
    const parsed = fileSchema.safeParse(saved);
    this.entries = parsed.success ? parsed.data.computers : [];
  }

  private async save() {
    await durableWrite(this.file, JSON.stringify({ v: 1, computers: this.entries }, null, 2));
  }

  /** The signed-in person's live registration for a business on this service. */
  private live(organizationId: string): Entry | undefined {
    const personId = this.session.personId();
    const service = this.service();
    return this.entries.find(
      (entry) =>
        entry.organizationId === organizationId &&
        entry.personId === personId &&
        entry.service === service &&
        entry.sealedKey !== null &&
        !entry.revokePending,
    );
  }

  private blocked(role: MemberRole, included: boolean): Blocked | null {
    if (!included) return { status: 403, code: 'phone_relay_not_included', sentence: PHONE_RELAY_SENTENCES.notIncluded };
    if (!mayRegisterComputer(role)) return { status: 403, code: 'role_not_allowed', sentence: PHONE_RELAY_SENTENCES.role };
    if (!this.protectedStorage()) return { status: 409, code: 'protected_storage_unavailable', sentence: PHONE_RELAY_SENTENCES.noStorage };
    if (!this.service() || !this.socket) return { status: 409, code: 'relay_unavailable', sentence: PHONE_RELAY_SENTENCES.noTransport };
    return null;
  }

  // --- the setting ----------------------------------------------------------------

  view(organizationId: string): PhoneRelayView {
    const state = this.session.state();
    if (!state.signedIn || !state.person) throw new ApiError(401, 'Sign in to use Nectovia.', { code: SIGN_IN_REQUIRED });
    const workspace = state.workspaces.find((item) => item.organization.id === organizationId);
    if (!workspace) throw new ApiError(404, PHONE_RELAY_SENTENCES.notAMember, { code: 'not_a_member' });
    // The one entitlement seam: the business's current access, as the account service answered it.
    const included = this.session.includes(organizationId, PHONE_RELAY_FEATURE);
    const entry = this.live(organizationId);
    if (entry) {
      const status = this.statuses.get(keyOf(entry)) ?? { state: 'connecting', sentence: null };
      return { organizationId, included, enabled: true, canChange: true, label: entry.label, state: status.state, sentence: status.sentence };
    }
    const blocked = this.blocked(workspace.role, included);
    const notice = this.notices.get(keyOf({ service: this.service() ?? '', organizationId, personId: state.person.id }));
    return {
      organizationId,
      included,
      enabled: false,
      canChange: blocked === null,
      label: this.hostname(),
      state: 'off',
      sentence: blocked?.sentence ?? notice ?? null,
    };
  }

  setEnabled(organizationId: string, enabled: boolean): Promise<PhoneRelayView> {
    return this.serial(async () => {
      const view = this.view(organizationId);
      if (enabled) {
        if (!view.enabled) await this.turnOn(organizationId);
      } else await this.turnOff(organizationId);
      return this.view(organizationId);
    });
  }

  private async turnOn(organizationId: string) {
    const workspace = this.session.state().workspaces.find((item) => item.organization.id === organizationId)!;
    const blocked = this.blocked(workspace.role, this.session.includes(organizationId, PHONE_RELAY_FEATURE));
    if (blocked) throw new ApiError(blocked.status, blocked.sentence, { code: blocked.code });
    const personId = this.session.personId()!;
    const service = this.service()!;
    const key = newRelayKey();
    // Sealed before anything is registered: a key this computer can't keep is never registered.
    const sealedKey = sealRelayKey(this.box!, key.privateKey);
    const answer = await this.session.call((token) =>
      this.session.backend.client.registerRelayDevice(token, organizationId, { publicKey: key.publicKey, label: this.hostname() }),
    );
    const entry: Entry = {
      service,
      organizationId,
      personId,
      deviceId: answer.deviceId,
      label: answer.label,
      sealedKey,
      createdAt: answer.createdAt,
      revokePending: false,
    };
    this.entries.push(entry);
    this.trim();
    try {
      await this.save();
    } catch (error) {
      // Not kept here, so not left registered there.
      this.entries = this.entries.filter((item) => item !== entry);
      await this.session
        .call((token) => this.session.backend.client.revokeRelayDevice(token, organizationId, answer.deviceId))
        .catch(() => {});
      throw error;
    }
    const k = keyOf(entry);
    this.notices.delete(k);
    this.halted.delete(k);
    this.start(entry, key.privateKey);
  }

  private async turnOff(organizationId: string) {
    const personId = this.session.personId()!;
    const k = keyOf({ service: this.service() ?? '', organizationId, personId });
    this.notices.delete(k);
    this.halted.delete(k);
    const entry = this.live(organizationId);
    if (!entry) return;
    this.stopLink(k);
    entry.sealedKey = null;
    entry.revokePending = true;
    await this.save();
    if (!(await this.revoke(entry))) this.later();
  }

  // --- links ------------------------------------------------------------------

  private start(entry: Entry, key?: KeyObject) {
    const k = keyOf(entry);
    if (this.closed || this.links.has(k)) return;
    const privateKey = key ?? (entry.sealedKey && this.box ? openRelayKey(this.box, entry.sealedKey) : null);
    if (!privateKey) {
      this.statuses.set(k, { state: 'error', sentence: PHONE_RELAY_SENTENCES.keyUnreadable });
      this.halted.add(k);
      return;
    }
    if (!this.socket) {
      this.statuses.set(k, { state: 'error', sentence: PHONE_RELAY_SENTENCES.noTransport });
      return;
    }
    const link: RelayLink = new RelayLink({
      url: desktopRelayUrl(entry.service, entry.organizationId),
      organizationId: entry.organizationId,
      deviceId: entry.deviceId,
      key: privateKey,
      token: () => this.bearer(entry.personId),
      check: () => this.check(entry),
      socket: this.socket,
      refusals: REFUSALS,
      log: this.log,
      status: (status) => {
        if (this.links.get(k) === link) this.statuses.set(k, status);
      },
      stopped: (stop) => void this.linkStopped(k, link, stop),
    });
    this.links.set(k, link);
    this.statuses.set(k, { state: 'connecting', sentence: null });
    link.start();
  }

  private stopLink(k: string) {
    this.links.get(k)?.stop();
    this.links.delete(k);
    this.statuses.delete(k);
  }

  private async bearer(personId: string): Promise<RelayBearer> {
    if (this.session.personId() !== personId) return { kind: 'refused', status: 401, code: SIGN_IN_REQUIRED, sentence: 'Sign in again.' };
    try {
      return { kind: 'ok', token: await this.session.token() };
    } catch (error) {
      return failure(error);
    }
  }

  private async check(entry: Entry): Promise<RelayAnswer> {
    if (this.session.personId() !== entry.personId) return { kind: 'refused', status: 401, code: SIGN_IN_REQUIRED, sentence: 'Sign in again.' };
    try {
      await this.session.call((token) => this.session.backend.client.checkRelayDesktop(token, entry.organizationId, entry.deviceId));
      return { kind: 'ok' };
    } catch (error) {
      return failure(error);
    }
  }

  private linkStopped(k: string, link: RelayLink, stop: LinkStop) {
    return this.serial(async () => {
      if (this.links.get(k) !== link) return;
      this.links.delete(k);
      if (stop.forget) {
        // The device record is gone at the account service, so this computer's key goes too.
        this.notices.set(k, stop.sentence);
        this.statuses.delete(k);
        this.entries = this.entries.filter((entry) => keyOf(entry) !== k || entry.revokePending);
        await this.save();
        return;
      }
      this.statuses.set(k, { state: 'error', sentence: stop.sentence });
      if (!stop.retry) this.halted.add(k);
    });
  }

  /**
   * Bring the links in line with who is signed in, after every sign-in, sign-out and refresh: dial
   * for the signed-in person's registrations, stop every other link, and finish removing records
   * the account service couldn't remove before. The hub decides everything else on each connect.
   */
  sync(): Promise<void> {
    return this.serial(async () => {
      if (this.closed) return;
      const personId = this.session.personId();
      const service = this.service();
      // Businesses the person is an active member of. A registration elsewhere waits: it can't connect.
      const active = new Set(this.session.state().workspaces.map((workspace) => workspace.organization.id));
      const dialable = (entry: Entry) =>
        entry.personId === personId && entry.service === service && active.has(entry.organizationId) && entry.sealedKey !== null && !entry.revokePending;
      for (const k of [...this.links.keys()]) {
        const entry = this.entries.find((item) => keyOf(item) === k && item.sealedKey !== null && !item.revokePending);
        if (!entry || !dialable(entry)) this.stopLink(k);
      }
      if (!personId || !service) return;
      await this.finishStops(personId, service);
      for (const entry of this.entries)
        if (dialable(entry) && !this.links.has(keyOf(entry)) && !this.halted.has(keyOf(entry))) this.start(entry);
    });
  }

  /**
   * A person's sign-in on this computer is ending on purpose. Their links stop and their keys go;
   * while they are still signed in, their device records are removed too. Otherwise the records
   * are removed the next time they sign in here, and without the key they can never connect.
   */
  release(personId: string, signedIn: boolean): Promise<void> {
    return this.serial(async () => {
      let changed = false;
      for (const entry of this.entries) {
        if (entry.personId !== personId) continue;
        const k = keyOf(entry);
        this.stopLink(k);
        this.notices.delete(k);
        this.halted.delete(k);
        if (entry.sealedKey !== null || !entry.revokePending) {
          entry.sealedKey = null;
          entry.revokePending = true;
          changed = true;
        }
      }
      if (changed) await this.save();
      const service = this.service();
      if (signedIn && service && this.session.personId() === personId) await this.finishStops(personId, service);
    });
  }

  private async finishStops(personId: string, service: string) {
    let left = false;
    for (const entry of this.entries.filter((item) => item.personId === personId && item.service === service && item.revokePending))
      if (!(await this.revoke(entry))) left = true;
    if (left) this.later();
  }

  /** Remove a device record. True once it is gone, or can no longer be removed by this person. */
  private async revoke(entry: Entry): Promise<boolean> {
    try {
      await this.session.call((token) => this.session.backend.client.revokeRelayDevice(token, entry.organizationId, entry.deviceId));
    } catch (error) {
      // 404: already gone. 403: this person was removed from the business; without the key the
      // record can never connect, and the Business owner can remove it. Anything else: try later.
      if (!(error instanceof ApiError) || (error.status !== 404 && error.status !== 403)) return false;
    }
    this.entries = this.entries.filter((item) => item !== entry);
    await this.save();
    return true;
  }

  private later() {
    if (this.retry || this.closed) return;
    this.retry = setTimeout(() => {
      this.retry = null;
      void this.sync();
    }, RETRY_STOP_MS);
    this.retry.unref?.();
  }

  /** Keep the file bounded: the oldest tombstones go first. */
  private trim() {
    while (this.entries.length > MAX_ENTRIES) {
      const index = this.entries.findIndex((entry) => entry.revokePending);
      this.entries.splice(index === -1 ? 0 : index, 1);
    }
  }

  /** The app is closing: links close, registrations stay, and the next start dials again. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.retry) clearTimeout(this.retry);
    this.retry = null;
    for (const link of this.links.values()) link.stop();
    this.links.clear();
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([
      this.chain,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, CLOSE_WAIT_MS);
      }),
    ]);
    clearTimeout(timer);
  }
}
