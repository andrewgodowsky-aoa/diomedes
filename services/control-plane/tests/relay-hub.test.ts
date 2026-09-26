/**
 * The relay hub's rules (relay plan step 2), apart from any socket: the
 * challenge, one connection per device, heartbeats, rechecks, expiry, presence
 * and last seen. Then the same hub against the faux store's real records.
 */
import { generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { createFauxCloud, type FauxCloud } from '../src/faux/cloud.js';
import { DEMO_ACCOUNTS, FAUX_DEMO_PASSWORD, seedDemo, type DemoAccount } from '../src/faux/seed.js';
import { RelayHubCore, type ConnectionState, type DesktopGrant, type HubEvent, type HubTransport } from '../src/relay/hub-core.js';
import {
  RELAY_CLOSE, RELAY_PING_FRAME, RELAY_PONG_FRAME, RELAY_TIMINGS, challengePayload, type RelayRefusalCode,
} from '../src/relay/protocol.js';
import { RelayAuthority } from '../src/relay/service.js';

const START = Date.parse('2026-09-26T12:00:00.000Z');
let clock = START;
const now = () => clock;

function keyPair() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return { publicKey: publicKey.export({ format: 'jwk' }).x!, privateKey };
}

function grantFor(publicKey: string, change: Partial<DesktopGrant> = {}): DesktopGrant {
  return {
    organizationId: 'org_juniper', tenantId: 'tenant_juniper', deviceId: 'relay_device_front', personId: 'person_owner',
    publicKey, issuer: 'https://issuer.test', sessionId: 'session_owner',
    authorizedUntil: new Date(START + 15 * 60_000).toISOString(), checkedAt: new Date(START).toISOString(), ...change,
  };
}

/** A socket as the hub sees one: everything sent, every close and the last saved state. */
function socket(heard?: () => number | null) {
  const frames: string[] = [];
  const closes: { code: number; reason: string }[] = [];
  let saved: ConnectionState | null | undefined;
  const transport: HubTransport = {
    send: (text) => frames.push(text),
    close: (code, reason) => closes.push({ code, reason }),
    save: (state) => { saved = state && structuredClone(state); },
    ...(heard ? { heardAt: heard } : {}),
  };
  return {
    transport, frames, closes,
    saved: () => saved,
    messages: () => frames.map((frame) => JSON.parse(frame) as Record<string, unknown>),
    challenge: () => frames.map((frame) => JSON.parse(frame)).find((message) => message.type === 'challenge') as { organizationId: string; deviceId: string; nonce: string },
  };
}
type Socket = ReturnType<typeof socket>;

function proveFrame(side: Socket, privateKey: KeyObject): string {
  const signature = sign(null, challengePayload(side.challenge()), privateKey).toString('base64url');
  return JSON.stringify({ v: 1, type: 'prove', signature });
}

/** An authority whose next answer each test sets. */
function authority() {
  const rechecks: string[] = [];
  const seen: string[] = [];
  let answer: () => Promise<RelayRefusalCode | null> = async () => null;
  let seeing: () => Promise<void> = async () => {};
  return {
    rechecks, seen,
    answer: (next: () => Promise<RelayRefusalCode | null>) => { answer = next; },
    seeing: (next: () => Promise<void>) => { seeing = next; },
    authority: {
      recheck: async (_grant: DesktopGrant, at: string) => { rechecks.push(at); return answer(); },
      seen: async (_grant: DesktopGrant, at: string) => { seen.push(at); return seeing(); },
    },
  };
}

async function ready(core: RelayHubCore, grant: DesktopGrant, privateKey: KeyObject, heard?: () => number | null) {
  const side = socket(heard);
  const id = core.open(side.transport, grant);
  await core.message(id, proveFrame(side, privateKey));
  expect(side.messages().at(-1)?.type).toBe('ready');
  return { id, side };
}

/** Moves the clock and runs what is due, as the host's alarm would. */
async function at(core: RelayHubCore, ms: number) {
  clock = START + ms;
  await core.tick();
}

beforeEach(() => {
  clock = START;
});

describe('the relay hub: proving the device key', () => {
  it('challenges a desktop and makes it ready only on a valid signature from the registered key', async () => {
    const key = keyPair();
    const auth = authority();
    const core = new RelayHubCore({ authority: auth.authority, now });
    const side = socket();
    const id = core.open(side.transport, grantFor(key.publicKey));

    const [challenge] = side.messages();
    expect(challenge).toEqual({ v: 1, type: 'challenge', organizationId: 'org_juniper', deviceId: 'relay_device_front',
      nonce: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/), expiresInMs: 10_000 });
    expect(core.presence()).toEqual(new Set());
    expect(core.nextDeadline()).toBe(START + RELAY_TIMINGS.challengeMs);

    await core.message(id, proveFrame(side, key.privateKey));
    expect(side.messages()[1]).toEqual({ v: 1, type: 'ready', deviceId: 'relay_device_front', heartbeatMs: 20_000, timeoutMs: 60_000,
      authorizedUntil: '2026-09-26T12:15:00.000Z' });
    expect(side.closes).toEqual([]);
    expect(core.presence()).toEqual(new Set(['relay_device_front']));
    expect(side.saved()).toMatchObject({ phase: 'ready', nonce: null, readyAt: START });
  });

  it('refuses a signature from another key', async () => {
    const key = keyPair();
    const core = new RelayHubCore({ authority: authority().authority, now });
    const side = socket();
    const id = core.open(side.transport, grantFor(key.publicKey));
    await core.message(id, proveFrame(side, keyPair().privateKey));
    expect(side.closes).toEqual([RELAY_CLOSE.badSignature]);
    expect(side.saved()).toBeNull();
    expect(core.presence()).toEqual(new Set());
  });

  it('refuses a proof replayed from an earlier connection: every connection signs its own nonce', async () => {
    const key = keyPair();
    const core = new RelayHubCore({ authority: authority().authority, now });
    const first = socket();
    const firstId = core.open(first.transport, grantFor(key.publicKey));
    const recorded = proveFrame(first, key.privateKey);
    await core.message(firstId, recorded);

    const second = socket();
    const secondId = core.open(second.transport, grantFor(key.publicKey));
    expect(second.challenge().nonce).not.toBe(first.challenge().nonce);
    await core.message(secondId, recorded);
    expect(second.closes).toEqual([RELAY_CLOSE.badSignature]);
    // The replay changed nothing for the connection that proved the key.
    expect(first.closes).toEqual([]);
    expect(core.presence()).toEqual(new Set(['relay_device_front']));
  });

  it('closes a challenged desktop that sends anything but one proof', async () => {
    const key = keyPair();
    const core = new RelayHubCore({ authority: authority().authority, now });
    const wrong = [
      RELAY_PING_FRAME,
      'not json',
      JSON.stringify({ v: 1, type: 'hello' }),
      JSON.stringify({ v: 2, type: 'prove', signature: 'A'.repeat(86) }),
      new Uint8Array([1, 2, 3]),
      JSON.stringify({ v: 1, type: 'prove', signature: 'A'.repeat(86), padding: 'x'.repeat(5_000) }),
    ];
    for (const frame of wrong) {
      const side = socket();
      const id = core.open(side.transport, grantFor(key.publicKey));
      await core.message(id, frame);
      expect(side.closes).toEqual([RELAY_CLOSE.protocolError]);
    }
    // Two proofs for one challenge: the second arrives while the first is checked, and ends the connection.
    const side = socket();
    const id = core.open(side.transport, grantFor(key.publicKey));
    const frame = proveFrame(side, key.privateKey);
    await Promise.all([core.message(id, frame), core.message(id, frame)]);
    expect(side.closes).toEqual([RELAY_CLOSE.protocolError]);
    expect(side.messages().some((message) => message.type === 'ready')).toBe(false);
    expect(core.size).toBe(0);
  });

  it('closes a desktop that does not answer its challenge in time, or answers too late', async () => {
    const key = keyPair();
    const core = new RelayHubCore({ authority: authority().authority, now });
    const silent = socket();
    core.open(silent.transport, grantFor(key.publicKey));
    await at(core, RELAY_TIMINGS.challengeMs - 1);
    expect(silent.closes).toEqual([]);
    await at(core, RELAY_TIMINGS.challengeMs);
    expect(silent.closes).toEqual([RELAY_CLOSE.challengeTimeout]);

    clock = START;
    const late = socket();
    const id = core.open(late.transport, grantFor(key.publicKey));
    clock = START + RELAY_TIMINGS.challengeMs;
    await core.message(id, proveFrame(late, key.privateKey));
    expect(late.closes).toEqual([RELAY_CLOSE.challengeTimeout]);
  });
});

describe('the relay hub: a ready connection', () => {
  it('answers pings with the exact pong frame and drops frames outside the closed set', async () => {
    expect(RELAY_PING_FRAME).toBe(JSON.stringify({ v: 1, type: 'ping' }));
    expect(RELAY_PONG_FRAME).toBe(JSON.stringify({ v: 1, type: 'pong' }));
    const key = keyPair();
    const core = new RelayHubCore({ authority: authority().authority, now });
    const { id, side } = await ready(core, grantFor(key.publicKey), key.privateKey);
    const before = side.frames.length;
    for (const frame of [JSON.stringify({ v: 1, type: 'hello' }), 'not json', new Uint8Array([1]), 'x'.repeat(5_000), proveFrame(side, key.privateKey)])
      await core.message(id, frame);
    expect(side.frames.length).toBe(before);
    await core.message(id, RELAY_PING_FRAME);
    expect(side.frames.at(-1)).toBe(RELAY_PONG_FRAME);
    expect(side.closes).toEqual([]);
  });

  it('closes a desktop silent for 60 seconds, counting heartbeats the host answered itself', async () => {
    const key = keyPair();
    const core = new RelayHubCore({ authority: authority().authority, now });
    let hostHeard: number | null = null;
    const { side } = await ready(core, grantFor(key.publicKey, { authorizedUntil: new Date(START + 60 * 60_000).toISOString() }),
      key.privateKey, () => hostHeard);
    // The host answered a ping at 50 seconds without waking the hub.
    hostHeard = START + 50_000;
    for (const ms of [20_000, 40_000, 60_000, 80_000, 100_000]) await at(core, ms);
    expect(side.closes).toEqual([]);
    expect(core.presence()).toEqual(new Set(['relay_device_front']));
    await at(core, 110_000);
    expect(side.closes).toEqual([RELAY_CLOSE.heartbeatTimeout]);
  });

  it('keeps one connection per device: a newer proof replaces the older connection', async () => {
    const key = keyPair();
    const other = keyPair();
    const core = new RelayHubCore({ authority: authority().authority, now });
    const older = await ready(core, grantFor(key.publicKey), key.privateKey);
    const back = await ready(core, grantFor(other.publicKey, { deviceId: 'relay_device_back' }), other.privateKey);
    const newer = await ready(core, grantFor(key.publicKey), key.privateKey);
    expect(older.side.closes).toEqual([RELAY_CLOSE.replaced]);
    expect(newer.side.closes).toEqual([]);
    expect(back.side.closes).toEqual([]);
    expect(core.presence()).toEqual(new Set(['relay_device_front', 'relay_device_back']));
    expect(core.size).toBe(2);
  });

  it('ends a stopped device at once', async () => {
    const key = keyPair();
    const core = new RelayHubCore({ authority: authority().authority, now });
    const { side } = await ready(core, grantFor(key.publicKey), key.privateKey);
    expect(await core.end('relay_device_front', RELAY_CLOSE.deviceRevoked)).toBe(1);
    expect(side.closes).toEqual([RELAY_CLOSE.deviceRevoked]);
    expect(core.presence()).toEqual(new Set());
    expect(core.nextDeadline()).toBeNull();
  });
});

describe('the relay hub: rechecks and expiry', () => {
  const refusals: [RelayRefusalCode, { code: number; reason: string }][] = [
    ['not_a_member', RELAY_CLOSE.notAMember],
    ['role_not_allowed', RELAY_CLOSE.roleNotAllowed],
    ['phone_relay_not_included', RELAY_CLOSE.notIncluded],
    ['device_revoked', RELAY_CLOSE.deviceRevoked],
    ['session_ended', RELAY_CLOSE.sessionEnded],
  ];
  for (const [refusal, close] of refusals)
    it(`rechecks every 20 seconds and closes with ${close.code} ${close.reason} when the answer is ${refusal}`, async () => {
      const key = keyPair();
      const auth = authority();
      const core = new RelayHubCore({ authority: auth.authority, now });
      const { id, side } = await ready(core, grantFor(key.publicKey), key.privateKey);
      await at(core, 10_000);
      await core.message(id, RELAY_PING_FRAME);
      await at(core, 19_999);
      expect(auth.rechecks).toEqual([]);
      await at(core, 20_000);
      expect(auth.rechecks).toEqual(['2026-09-26T12:00:20.000Z']);
      expect(side.closes).toEqual([]);
      auth.answer(async () => refusal);
      await core.message(id, RELAY_PING_FRAME);
      await at(core, 40_000);
      expect(side.closes).toEqual([close]);
      expect(core.presence()).toEqual(new Set());
    });

  it('retries a recheck it could not run, and closes the connection 30 seconds after the last one that passed', async () => {
    const key = keyPair();
    const auth = authority();
    const core = new RelayHubCore({ authority: auth.authority, now });
    const { id, side } = await ready(core, grantFor(key.publicKey), key.privateKey);
    auth.answer(async () => { throw new Error('database unavailable'); });
    await core.message(id, RELAY_PING_FRAME);
    await at(core, 20_000);
    expect(core.nextDeadline()).toBe(START + 25_000);
    await at(core, 25_000);
    expect(auth.rechecks).toHaveLength(2);
    expect(side.closes).toEqual([]);
    await at(core, 30_000);
    expect(side.closes).toEqual([RELAY_CLOSE.recheckUnavailable]);
  });

  it('ends the connection when the sign-in it was opened with expires', async () => {
    const key = keyPair();
    const core = new RelayHubCore({ authority: authority().authority, now });
    const { id, side } = await ready(core, grantFor(key.publicKey, { authorizedUntil: new Date(START + 25_000).toISOString() }), key.privateKey);
    await at(core, 15_000);
    await core.message(id, RELAY_PING_FRAME);
    await at(core, 20_000);
    expect(side.closes).toEqual([]);
    await at(core, 25_000);
    expect(side.closes).toEqual([RELAY_CLOSE.sessionExpired]);
  });

  it('writes last seen when a desktop is ready, every five minutes after, and when it leaves', async () => {
    const key = keyPair();
    const auth = authority();
    const core = new RelayHubCore({ authority: auth.authority, now });
    const { id } = await ready(core, grantFor(key.publicKey, { authorizedUntil: new Date(START + 60 * 60_000).toISOString() }), key.privateKey);
    expect(core.nextDeadline()).toBe(START);
    await at(core, 0);
    expect(auth.seen).toEqual(['2026-09-26T12:00:00.000Z']);
    for (let ms = 20_000; ms <= 300_000; ms += 20_000) {
      clock = START + ms;
      await core.message(id, RELAY_PING_FRAME);
      await core.tick();
    }
    expect(auth.seen).toEqual(['2026-09-26T12:00:00.000Z', '2026-09-26T12:05:00.000Z']);
    clock = START + 310_000;
    await core.closed(id, 1000);
    expect(auth.seen.at(-1)).toBe('2026-09-26T12:05:10.000Z');
    expect(core.size).toBe(0);
  });

  it('names only deadlines one tick retires, so a host alarm never spins', async () => {
    const key = keyPair();
    const auth = authority();
    auth.answer(async () => { throw new Error('database unavailable'); });
    auth.seeing(async () => { throw new Error('database unavailable'); });
    const core = new RelayHubCore({ authority: auth.authority, now });
    await ready(core, grantFor(key.publicKey), key.privateKey);
    core.open(socket().transport, grantFor(keyPair().publicKey, { deviceId: 'relay_device_back' }));
    let steps = 0;
    for (let next = core.nextDeadline(); next !== null; next = core.nextDeadline()) {
      expect(next).toBeGreaterThanOrEqual(clock);
      clock = next;
      await core.tick();
      const after = core.nextDeadline();
      if (after !== null) expect(after).toBeGreaterThan(clock);
      expect(++steps).toBeLessThan(50);
    }
    expect(core.size).toBe(0);
  });

  it('leaves a connection out of presence once it is past a deadline, before the alarm runs', async () => {
    const key = keyPair();
    const core = new RelayHubCore({ authority: authority().authority, now });
    await ready(core, grantFor(key.publicKey), key.privateKey);
    clock = START + RELAY_TIMINGS.authorityWindowMs;
    expect(core.presence()).toEqual(new Set());
  });
});

describe('the relay hub: hibernation and records', () => {
  it('takes back its connections from their saved state', async () => {
    const key = keyPair();
    const first = new RelayHubCore({ authority: authority().authority, now });
    const { side } = await ready(first, grantFor(key.publicKey), key.privateKey);
    const saved = side.saved();

    const woken = new RelayHubCore({ authority: authority().authority, now });
    const again = socket();
    expect(woken.restore(again.transport, saved)).toBe(true);
    expect(woken.presence()).toEqual(new Set(['relay_device_front']));
    await woken.message(saved!.id, RELAY_PING_FRAME);
    expect(again.frames).toEqual([RELAY_PONG_FRAME]);
    expect(woken.restore(socket().transport, null)).toBe(false);
    expect(woken.restore(socket().transport, { ...saved, phase: 'unknown' })).toBe(false);
    // Well under a Durable Object attachment's 16 KB, even with the longest ids.
    const longest = grantFor(key.publicKey, {
      organizationId: 'o'.repeat(128), tenantId: 't'.repeat(128), deviceId: 'd'.repeat(128), personId: 'p'.repeat(128),
      sessionId: 's'.repeat(128), issuer: `https://${'i'.repeat(500)}`,
    });
    const big = socket();
    new RelayHubCore({ authority: authority().authority, now }).open(big.transport, longest);
    expect(new TextEncoder().encode(JSON.stringify(big.saved())).length).toBeLessThan(2_048);
  });

  it('records ids and outcomes only: never a key, nonce, signature or frame', async () => {
    const key = keyPair();
    const events: HubEvent[] = [];
    const core = new RelayHubCore({ authority: authority().authority, now, record: (event) => events.push(event) });
    const { id, side } = await ready(core, grantFor(key.publicKey), key.privateKey);
    await core.message(id, RELAY_PING_FRAME);
    const bad = socket();
    const badId = core.open(bad.transport, grantFor(key.publicKey));
    const forged = proveFrame(bad, keyPair().privateKey);
    await core.message(badId, forged);
    await core.end('relay_device_front', RELAY_CLOSE.deviceRevoked);
    const text = JSON.stringify(events);
    expect(events.map((event) => event.event)).toEqual(['relay-desktop-opened', 'relay-desktop-ready', 'relay-desktop-opened',
      'relay-desktop-closed', 'relay-desktop-closed']);
    for (const secret of [key.publicKey, side.challenge().nonce, bad.challenge().nonce, JSON.parse(forged).signature, 'ping'])
      expect(text).not.toContain(secret);
  });
});

// --- the same hub against the faux store's records ---------------------------------------------

describe('the relay hub against the account records', () => {
  let cloud: FauxCloud;
  let organizationId: string;

  async function token(who: DemoAccount) {
    const response = await cloud.handle(new Request('http://127.0.0.1:8795/auth/sign-in', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: DEMO_ACCOUNTS[who].email, password: FAUX_DEMO_PASSWORD }),
    }));
    return ((await response.json()) as { accessToken: string }).accessToken;
  }

  /** The Manager's computer, registered and proven, on a hub that rechecks the faux store. */
  async function managerConnected() {
    const manager = await token('manager');
    const key = keyPair();
    const { deviceId } = await cloud.relay.register(manager, organizationId, { publicKey: key.publicKey, label: 'Back office' });
    const grant = await cloud.relay.authorizeDesktop(manager, organizationId, deviceId);
    const core = new RelayHubCore({ authority: new RelayAuthority(cloud.store.relay), now });
    const connected = await ready(core, grant, key.privateKey);
    // The host's alarm runs at once: a ready computer's last seen is due.
    await core.tick();
    return { manager, deviceId, grant, core, ...connected };
  }

  /** Twenty seconds on, with a heartbeat, then the recheck. */
  async function recheck(core: RelayHubCore, id: string) {
    clock += RELAY_TIMINGS.recheckMs;
    await core.message(id, RELAY_PING_FRAME);
    await core.tick();
  }

  beforeEach(async () => {
    cloud = await createFauxCloud({ file: null, now, passwordIterations: 1_000 });
    organizationId = (await seedDemo(cloud)).organizations!.juniper;
  });

  it('keeps a connection whose person, plan, device and sign-in still hold, and writes its last seen', async () => {
    const { core, id, side, deviceId } = await managerConnected();
    await recheck(core, id);
    await recheck(core, id);
    expect(side.closes).toEqual([]);
    expect(cloud.store.snapshot().relay.devices.find((row) => row.deviceId === deviceId)?.lastSeenAt).toBe('2026-09-26T12:00:00.000Z');
  });

  it('ends a live connection within the window when the owner removes the Manager', async () => {
    const { core, id, side, grant } = await managerConnected();
    await cloud.accounts.setMembership(await token('owner'), organizationId, grant.personId, { role: 'admin', state: 'revoked' });
    await recheck(core, id);
    expect(side.closes).toEqual([RELAY_CLOSE.notAMember]);
  });

  it('ends it when the Manager becomes an Employee', async () => {
    const { core, id, side, grant } = await managerConnected();
    await cloud.accounts.setMembership(await token('owner'), organizationId, grant.personId, { role: 'member', state: 'active' });
    await recheck(core, id);
    expect(side.closes).toEqual([RELAY_CLOSE.roleNotAllowed]);
  });

  it('ends it when Billing withdraws the plan', async () => {
    const { core, id, side } = await managerConnected();
    const billing = await token('staffBilling');
    const grants = cloud.store.snapshot().commercial.grants.filter((row) => row.organizationId === organizationId && row.state === 'active');
    expect(grants.length).toBeGreaterThan(0);
    for (const grant of grants)
      expect((await cloud.handle(new Request(`http://127.0.0.1:8795/ops/customers/${organizationId}/grants/${grant.id}/revoke`, {
        method: 'POST', headers: { authorization: `Bearer ${billing}`, 'content-type': 'application/json' },
        body: JSON.stringify({ reason: 'Subscription cancelled.' }),
      }))).status).toBe(200);
    await recheck(core, id);
    expect(side.closes).toEqual([RELAY_CLOSE.notIncluded]);
  });

  it('ends it when the computer is stopped elsewhere, or its sign-in is revoked', async () => {
    const stopped = await managerConnected();
    await cloud.relay.revoke(await token('owner'), organizationId, stopped.deviceId);
    await recheck(stopped.core, stopped.id);
    expect(stopped.side.closes).toEqual([RELAY_CLOSE.deviceRevoked]);

    const signedOut = await managerConnected();
    await cloud.accounts.revokeLocalSession(signedOut.manager);
    await recheck(signedOut.core, signedOut.id);
    expect(signedOut.side.closes).toEqual([RELAY_CLOSE.sessionEnded]);
  });
});
