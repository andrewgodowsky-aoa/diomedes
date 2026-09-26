/**
 * The desktop's side of the phone relay, one link at a time, against a fake
 * hub: the challenge it signs, its heartbeats, how it dials again, how it
 * renews a connection before the bearer expires, and what each close and
 * refusal makes it do. The whole desktop over a real loopback socket is
 * tests/phone-relay-desktop.test.ts.
 */
import { generateKeyPairSync, randomBytes, verify } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { computerLabel, newRelayKey, openRelayKey, proveChallenge, publicHalf, sealRelayKey } from '../server/relay/keys';
import {
  LINK_SENTENCES,
  RELAY_RENEW_BEFORE_MS,
  RelayLink,
  backoffMs,
  type LinkStatus,
  type LinkStop,
  type RelayAnswer,
  type RelaySocket,
} from '../server/relay/link';
import { testOnlySecretBox } from '../server/connection-secrets';
import { RELAY_DEVICE_HEADER, RELAY_PING_FRAME, challengePayload } from '../services/control-plane/src/relay/protocol';

const START = Date.parse('2026-09-26T12:00:00.000Z');
const ORG = 'org_juniper';
const DEVICE = 'relay_device_desk';
const REFUSALS = { not_a_member: 'Not a member.', role_not_allowed: 'Owners and Managers only.', phone_relay_not_included: 'Not in the plan.' };

class FakeSocket implements RelaySocket {
  onopen: RelaySocket['onopen'] = null;
  onmessage: RelaySocket['onmessage'] = null;
  onclose: RelaySocket['onclose'] = null;
  onerror: RelaySocket['onerror'] = null;
  sent: string[] = [];
  closes: { code?: number; reason?: string }[] = [];
  /** The hub answers each ping, as a Durable Object's auto-response does. */
  answersPings = true;
  constructor(
    readonly url: string,
    readonly headers: Record<string, string>,
  ) {}
  send(data: string) {
    this.sent.push(data);
    if (data === RELAY_PING_FRAME && this.answersPings) this.deliver({ v: 1, type: 'pong' });
  }
  close(code?: number, reason?: string) {
    this.closes.push({ code, reason });
  }
  // The hub's side.
  open() {
    this.onopen?.({});
  }
  deliver(message: unknown) {
    this.onmessage?.({ data: typeof message === 'string' ? message : JSON.stringify(message) });
  }
  end(code: number, reason = '') {
    this.onclose?.({ code, reason });
  }
  challenge(overrides: Record<string, unknown> = {}) {
    const message = { v: 1, type: 'challenge', organizationId: ORG, deviceId: DEVICE, nonce: randomBytes(32).toString('base64url'), expiresInMs: 10_000, ...overrides };
    this.deliver(message);
    return message;
  }
  ready(authorizedUntil = START + 10 * 60_000) {
    this.deliver({ v: 1, type: 'ready', deviceId: DEVICE, heartbeatMs: 20_000, timeoutMs: 60_000, authorizedUntil: new Date(authorizedUntil).toISOString() });
  }
  /** Open, challenge, and ready once the desktop has proved its key. */
  prove(authorizedUntil?: number) {
    this.open();
    this.challenge();
    expect(JSON.parse(this.sent.at(-1)!)).toMatchObject({ v: 1, type: 'prove' });
    this.ready(authorizedUntil);
  }
}

/** Every setImmediate is real: the link's awaits settle before it returns. */
const settle = async () => {
  for (let round = 0; round < 3; round++) await new Promise<void>((resolve) => setImmediate(resolve));
};

function harness(check: () => Promise<RelayAnswer> = async () => ({ kind: 'ok' })) {
  const key = generateKeyPairSync('ed25519');
  const sockets: FakeSocket[] = [];
  const statuses: LinkStatus[] = [];
  const stops: LinkStop[] = [];
  const logs: string[] = [];
  const checks = vi.fn(check);
  const link = new RelayLink({
    url: `wss://relay.test/relay/v1/organizations/${ORG}/desktop`,
    organizationId: ORG,
    deviceId: DEVICE,
    key: key.privateKey,
    token: async () => ({ kind: 'ok', token: `bearer-${sockets.length}` }),
    check: checks,
    socket: (url, headers) => {
      const socket = new FakeSocket(url, headers);
      sockets.push(socket);
      return socket;
    },
    status: (status) => statuses.push(status),
    stopped: (stop) => stops.push(stop),
    refusals: REFUSALS,
    log: (line) => logs.push(line),
    random: () => 0.5,
  });
  return { link, key, sockets, statuses, stops, logs, checks, last: () => statuses.at(-1) };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
  vi.setSystemTime(START);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("the desktop's link to its relay hub", () => {
  it('dials out with the bearer and the device, signs exactly the challenge payload, then pings every heartbeat', async () => {
    const { link, key, sockets, last } = harness();
    link.start();
    expect(last()).toEqual({ state: 'connecting', sentence: null });
    await settle();
    const [socket] = sockets;
    expect(socket.url).toBe(`wss://relay.test/relay/v1/organizations/${ORG}/desktop`);
    expect(socket.headers).toEqual({ authorization: 'Bearer bearer-0', [RELAY_DEVICE_HEADER]: DEVICE });
    socket.open();
    const challenge = socket.challenge();
    const prove = JSON.parse(socket.sent[0]);
    expect(Object.keys(prove).sort()).toEqual(['signature', 'type', 'v']);
    expect(verify(null, challengePayload(challenge), key.publicKey, Buffer.from(prove.signature, 'base64url'))).toBe(true);
    socket.ready();
    expect(last()).toEqual({ state: 'reachable', sentence: null });

    await vi.advanceTimersByTimeAsync(20_000);
    expect(socket.sent.slice(1)).toEqual([RELAY_PING_FRAME]);
    // A frame this version doesn't know is ignored: later steps add types after `ready`.
    socket.deliver({ v: 1, type: 'turn', text: 'hello' });
    await vi.advanceTimersByTimeAsync(20_000);
    expect(socket.sent.slice(1)).toEqual([RELAY_PING_FRAME, RELAY_PING_FRAME]);
    expect(socket.closes).toEqual([]);
    link.stop();
  });

  it('refuses to sign a challenge for another business or computer, or a second one', async () => {
    for (const overrides of [{ organizationId: 'org_harbor' }, { deviceId: 'relay_device_other' }, null]) {
      const { link, sockets, stops } = harness();
      link.start();
      await settle();
      const [socket] = sockets;
      socket.open();
      if (overrides) socket.challenge(overrides);
      else {
        socket.challenge();
        socket.challenge();
      }
      expect(socket.sent.filter((frame) => frame.includes('prove'))).toHaveLength(overrides ? 0 : 1);
      expect(socket.closes).toEqual([{ code: 4400, reason: 'protocol_error' }]);
      expect(stops).toEqual([{ sentence: LINK_SENTENCES.protocol, forget: false, retry: false }]);
    }
  });

  it('dials again after 1, 2 and 4 seconds when the connection drops, and at once when the bearer expires', async () => {
    const { link, sockets, last } = harness();
    link.start();
    await settle();
    sockets[0].prove();
    sockets[0].end(1006);
    await settle();
    expect(last()).toEqual({ state: 'connecting', sentence: null });
    await vi.advanceTimersByTimeAsync(999);
    expect(sockets).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    await settle();
    expect(sockets).toHaveLength(2);
    sockets[1].open();
    sockets[1].end(4003, 'recheck_unavailable');
    await settle();
    await vi.advanceTimersByTimeAsync(1_999);
    expect(sockets).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    await settle();
    expect(sockets).toHaveLength(3);

    // Ready resets the backoff; the hub's 4000 at the bearer's expiry dials again at once.
    sockets[2].prove();
    sockets[2].end(4000, 'session_expired');
    await settle();
    expect(sockets).toHaveLength(4);
    expect(sockets[3].headers.authorization).toBe('Bearer bearer-3');
    link.stop();
  });

  it('gives up on a hub that has gone quiet for a minute and dials again', async () => {
    const { link, sockets } = harness();
    link.start();
    await settle();
    sockets[0].answersPings = false;
    sockets[0].prove();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sockets[0].closes).toEqual([]);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(sockets[0].closes).toEqual([{ code: 4001, reason: 'heartbeat_timeout' }]);
    await vi.advanceTimersByTimeAsync(1_000);
    await settle();
    expect(sockets).toHaveLength(2);
    // The dead socket's own close, arriving late, changes nothing.
    sockets[0].end(1006);
    await settle();
    expect(sockets).toHaveLength(2);
    link.stop();
  });

  it('renews before the bearer expires, and the hub replacing the old socket is expected either way round', async () => {
    const { link, sockets, stops, last } = harness();
    link.start();
    await settle();
    sockets[0].prove(START + 10 * 60_000);
    await vi.advanceTimersByTimeAsync(10 * 60_000 - RELAY_RENEW_BEFORE_MS - 1);
    expect(sockets).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    await settle();
    expect(sockets).toHaveLength(2);

    // The hub's 4409 to the old socket arrives before the new socket's ready.
    sockets[1].open();
    sockets[1].challenge();
    sockets[0].end(4409, 'replaced');
    await settle();
    expect(sockets).toHaveLength(2);
    expect(last()).toEqual({ state: 'reachable', sentence: null });
    sockets[1].ready(Date.now() + 10 * 60_000);
    expect(last()).toEqual({ state: 'reachable', sentence: null });

    // The next renewal: this time the new socket is ready first, and the old one's 4409 comes after.
    await vi.advanceTimersByTimeAsync(10 * 60_000 - RELAY_RENEW_BEFORE_MS);
    await settle();
    expect(sockets).toHaveLength(3);
    sockets[2].prove(Date.now() + 10 * 60_000);
    expect(sockets[1].closes).toEqual([{ code: 1000, reason: 'renewed' }]);
    sockets[1].end(4409, 'replaced');
    await settle();
    expect(sockets).toHaveLength(3);
    expect(stops).toEqual([]);
    expect(last()).toEqual({ state: 'reachable', sentence: null });
    link.stop();
  });

  it('keeps the open connection when a renewal fails, and dials again once the bearer expires', async () => {
    const { link, sockets, stops } = harness();
    link.start();
    await settle();
    sockets[0].prove(START + 10 * 60_000);
    await vi.advanceTimersByTimeAsync(10 * 60_000 - RELAY_RENEW_BEFORE_MS);
    await settle();
    sockets[1].end(1006);
    await settle();
    expect(sockets[0].closes).toEqual([]);
    sockets[0].end(4000, 'session_expired');
    await settle();
    expect(sockets).toHaveLength(3);
    expect(stops).toEqual([]);
    link.stop();
  });

  it('stops on each refusal with its sentence; a stopped device also forgets its key', async () => {
    const cases: [number, string, LinkStop][] = [
      [4410, 'device_revoked', { sentence: LINK_SENTENCES.stoppedElsewhere, forget: true, retry: false }],
      [4403, 'not_a_member', { sentence: REFUSALS.not_a_member, forget: false, retry: true }],
      [4403, 'role_not_allowed', { sentence: REFUSALS.role_not_allowed, forget: false, retry: true }],
      [4403, 'phone_relay_not_included', { sentence: REFUSALS.phone_relay_not_included, forget: false, retry: true }],
      [4401, 'session_ended', { sentence: LINK_SENTENCES.signedOut, forget: false, retry: true }],
      [4401, 'bad_signature', { sentence: LINK_SENTENCES.keyMismatch, forget: false, retry: false }],
      [4400, 'protocol_error', { sentence: LINK_SENTENCES.protocol, forget: false, retry: false }],
      // No renewal in flight: another copy of Nectovia proved this computer's key.
      [4409, 'replaced', { sentence: LINK_SENTENCES.takenOver, forget: false, retry: false }],
    ];
    for (const [code, reason, stop] of cases) {
      const { link, sockets, stops } = harness();
      link.start();
      await settle();
      sockets[0].prove();
      sockets[0].end(code, reason);
      await settle();
      expect(stops, `${code} ${reason}`).toEqual([stop]);
      await vi.advanceTimersByTimeAsync(120_000);
      expect(sockets, `${code} ${reason}`).toHaveLength(1);
    }
  });

  it('asks the plain check why an upgrade was refused, since a refused upgrade shows no reason', async () => {
    const answers: [RelayAnswer, LinkStop | LinkStatus][] = [
      [{ kind: 'refused', status: 404, code: 'device_revoked', sentence: 'Not registered.' }, { sentence: LINK_SENTENCES.stoppedElsewhere, forget: true, retry: false }],
      [{ kind: 'refused', status: 403, code: 'role_not_allowed', sentence: 'Owners and Managers only.' }, { sentence: 'Owners and Managers only.', forget: false, retry: true }],
      [{ kind: 'refused', status: 401, code: 'sign_in_required', sentence: 'Sign in.' }, { sentence: LINK_SENTENCES.signedOut, forget: false, retry: true }],
      [{ kind: 'unreachable' }, { state: 'error', sentence: LINK_SENTENCES.unreachable }],
      [{ kind: 'ok' }, { state: 'connecting', sentence: null }],
    ];
    for (const [answer, expected] of answers) {
      const { link, sockets, stops, checks, last } = harness(async () => answer);
      link.start();
      await settle();
      sockets[0].end(1006);
      await settle();
      expect(checks).toHaveBeenCalledOnce();
      if ('forget' in expected) {
        expect(stops).toEqual([expected]);
        continue;
      }
      expect(stops).toEqual([]);
      expect(last()).toEqual(expected);
      await vi.advanceTimersByTimeAsync(1_000);
      await settle();
      expect(sockets).toHaveLength(2);
      link.stop();
    }
  });

  it('stops everything when stopped: the socket closes, no timer is left, nothing is sent again', async () => {
    const { link, sockets, statuses, logs } = harness();
    link.start();
    await settle();
    sockets[0].prove();
    link.stop();
    expect(sockets[0].closes).toEqual([{ code: 1000, reason: 'stopped' }]);
    expect(vi.getTimerCount()).toBe(0);
    const reported = statuses.length;
    sockets[0].end(1000, 'stopped');
    await vi.advanceTimersByTimeAsync(15 * 60_000);
    expect(sockets).toHaveLength(1);
    expect(sockets[0].sent.filter((frame) => frame === RELAY_PING_FRAME)).toEqual([]);
    expect(statuses).toHaveLength(reported);
    expect(logs).toEqual([
      `Phone access for ${DEVICE}: connecting.`,
      `Phone access for ${DEVICE}: reachable.`,
      `Phone access for ${DEVICE}: stopped.`,
    ]);
  });

  it('backs off within 20 percent of 1, 2, 4 … seconds, never past a minute', () => {
    expect([0, 1, 2, 3].map((failures) => backoffMs(failures, () => 0.5))).toEqual([1_000, 2_000, 4_000, 8_000]);
    expect(backoffMs(0, () => 0)).toBe(800);
    expect(backoffMs(0, () => 1)).toBe(1_200);
    expect(backoffMs(40, () => 0.5)).toBe(60_000);
    expect(backoffMs(40, () => 1)).toBe(72_000);
  });
});

describe("this computer's relay key", () => {
  it('seals the private half with the SecretBox and opens it again; the public half is raw base64url', () => {
    const box = testOnlySecretBox();
    const key = newRelayKey();
    expect(key.publicKey).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const sealed = sealRelayKey(box, key.privateKey);
    const pkcs8 = key.privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64');
    expect(sealed).not.toContain(pkcs8);
    const opened = openRelayKey(box, sealed)!;
    expect(publicHalf(opened)).toBe(key.publicKey);
    const challenge = { organizationId: ORG, deviceId: DEVICE, nonce: randomBytes(32).toString('base64url') };
    expect(proveChallenge(opened, challenge)).toBe(proveChallenge(key.privateKey, challenge));
    // Printing or serializing the key shows no key material.
    expect(JSON.stringify({ key: key.privateKey })).toBe('{"key":{}}');
    expect(String(key.privateKey)).not.toContain(pkcs8);
    expect(openRelayKey(box, Buffer.from('not sealed').toString('base64'))).toBeNull();
    const rsa = generateKeyPairSync('rsa', { modulusLength: 1024 }).privateKey;
    expect(openRelayKey(box, box.seal(rsa.export({ format: 'der', type: 'pkcs8' }).toString('base64')).toString('base64'))).toBeNull();
  });

  it("names the computer by its host name, as the service accepts it", () => {
    expect(computerLabel('FRONT-COUNTER')).toBe('FRONT-COUNTER');
    expect(computerLabel(' desk\u0007top \n')).toBe('desktop');
    expect(computerLabel('x'.repeat(80))).toHaveLength(60);
    expect(computerLabel('\u0000\u0001')).toBe('This computer');
    expect(computerLabel(`${'y'.repeat(59)}\u{1F600}`)).toBe('y'.repeat(59));
  });
});
