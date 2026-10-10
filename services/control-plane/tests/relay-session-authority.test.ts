/** The actual relay core and hosts under delayed proof, restored-state and admission pressure. All grants and transports are synthetic. */
import { generateKeyPairSync, sign } from 'node:crypto';
import { Duplex } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FauxRelayHubs } from '../src/faux/relay-hubs.js';
import { RELAY_GRANT_HEADER, RelayHub, type HubSocket, type RelayHubState } from '../src/relay/durable-object.js';
import { RelayHubCore, type ConnectionState, type DesktopGrant, type HubAuthority, type HubTransport, type PhoneGrant, type PhoneConnectionState } from '../src/relay/hub-core.js';
import { RELAY_CLOSE, RELAY_PING_FRAME, RELAY_TIMINGS, challengePayload } from '../src/relay/protocol.js';

const START = Date.parse('2026-10-10T00:00:00.000Z');
let clock = START;
const now = () => clock;
const key = generateKeyPairSync('ed25519');
const quiet = () => {};
const authority: HubAuthority = { recheck: async () => null, recheckPhone: async () => null, seen: async () => {} };
const desktopGrant = (change: Partial<DesktopGrant> = {}): DesktopGrant => ({
  organizationId: 'fixture_org', tenantId: 'fixture_tenant', deviceId: 'fixture_device', personId: 'fixture_person',
  publicKey: key.publicKey.export({ format: 'jwk' }).x!, issuer: 'https://issuer.invalid', sessionId: 'fixture_session',
  authorizedUntil: new Date(START + 3_600_000).toISOString(), checkedAt: new Date(clock).toISOString(), ...change,
});
const phoneGrant = (change: Partial<PhoneGrant> = {}): PhoneGrant => ({
  organizationId: 'fixture_org', tenantId: 'fixture_tenant', personId: 'fixture_person', issuer: 'https://issuer.invalid',
  sessionId: 'fixture_phone_session', authorizedUntil: new Date(START + 3_600_000).toISOString(), checkedAt: new Date(clock).toISOString(), ...change,
});
const identifier = (index: number) => String(index).padStart(22, 'A');
function side<State = ConnectionState>() {
  const frames: string[] = [];
  const closes: { code: number; reason: string }[] = [];
  const saved: (State | null)[] = [];
  const transport = { send: (text: string) => frames.push(text), close: (code: number, reason: string) => closes.push({ code, reason }),
    save: (state: State | null) => saved.push(state && structuredClone(state)) };
  return { transport, frames, closes, saved };
}
function restored(id: string, change: Partial<ConnectionState> = {}): ConnectionState {
  return { v: 1, id, grant: desktopGrant(), phase: 'ready', nonce: null, openedAt: START, challengeExpiresAt: START + 10_000,
    readyAt: START, heardAt: START, checkedAt: START, nextCheckAt: START + 20_000, nextSeenAt: START + 300_000, ...change };
}
const rows = () => JSON.stringify({ v: 1, type: 'work.rows', projectId: 'fixture_project', rootRunId: null, taskTitle: null, rows: [], at: new Date(clock).toISOString() });
const core = (auth: HubAuthority = authority) => new RelayHubCore({ now, authority: auth });
function proof(frames: string[]): string {
  return JSON.stringify({ v: 1, type: 'prove', signature: sign(null, challengePayload(JSON.parse(frames[0])), key.privateKey).toString('base64url') });
}
async function ready(hub: RelayHubCore, grant = desktopGrant()) {
  const desktop = side();
  const id = hub.open(desktop.transport, grant);
  await hub.message(id, proof(desktop.frames));
  expect(JSON.parse(desktop.frames.at(-1)!)).toMatchObject({ type: 'ready' });
  return { id, desktop };
}
function gate() {
  let release!: () => void;
  let start!: () => void;
  const started = new Promise<void>((resolve) => { start = resolve; });
  const waiting = new Promise<void>((resolve) => { release = resolve; });
  return { started, release, wait: async () => { start(); await waiting; } };
}

beforeEach(() => { clock = START; });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('desktop authority before every frame', () => {
  it.each([
    ['bearer expiry', START + 11_000, { grant: desktopGrant({ authorizedUntil: new Date(START + 10_000).toISOString() }) }, RELAY_CLOSE.sessionExpired],
    ['authority deadline', START + RELAY_TIMINGS.authorityWindowMs, {}, RELAY_CLOSE.recheckUnavailable],
    ['heartbeat deadline', START + RELAY_TIMINGS.heartbeatTimeoutMs, { checkedAt: START + 55_000 }, RELAY_CLOSE.heartbeatTimeout],
  ] as const)('retires a restored desktop at its %s before output or activity is accepted', async (_name, at, change, close) => {
    const hub = core();
    const desktop = side();
    const id = identifier(1);
    expect(hub.restore(desktop.transport, restored(id, change))).toBe(true);
    clock = at;
    const phone = side<PhoneConnectionState>();
    hub.openPhone(phone.transport, phoneGrant());
    await hub.message(id, rows());
    expect(phone.frames).toEqual([]);
    expect(desktop.closes).toEqual([close]);
    expect(hub.has(id)).toBe(false);
    expect(desktop.saved.filter((state) => state !== null).every((state) => state!.heardAt === START)).toBe(true);
    await hub.message(id, RELAY_PING_FRAME);
    expect(desktop.frames).toEqual([]);
  });

  it('retires an expired desktop before answering its next ping', async () => {
    const hub = core();
    const { id, desktop } = await ready(hub, desktopGrant({ authorizedUntil: new Date(START + 1_000).toISOString() }));
    desktop.frames.length = 0;
    clock += 1_000;
    await hub.message(id, RELAY_PING_FRAME);
    expect(desktop.frames).toEqual([]);
    expect(desktop.closes).toEqual([RELAY_CLOSE.sessionExpired]);
  });

  it('keeps an ordinary live desktop-to-phone frame attributed to the proven device', async () => {
    const hub = core();
    const { id } = await ready(hub);
    const phone = side<PhoneConnectionState>();
    hub.openPhone(phone.transport, phoneGrant());
    await hub.message(id, rows());
    expect(phone.frames.map((frame) => JSON.parse(frame))).toEqual([expect.objectContaining({ type: 'work.rows', source: { deviceId: 'fixture_device' } })]);
  });

  it('never forwards from a desktop after the current authority recheck retires it', async () => {
    const hub = core({ ...authority, recheck: async () => 'device_revoked' });
    const { id, desktop } = await ready(hub);
    const phone = side<PhoneConnectionState>();
    hub.openPhone(phone.transport, phoneGrant());
    clock += RELAY_TIMINGS.recheckMs;
    await hub.tick();
    await hub.message(id, rows());
    expect(desktop.closes).toEqual([RELAY_CLOSE.deviceRevoked]);
    expect(phone.frames).toEqual([]);
  });

  it('rejects expiry during a delayed signature check before replacing the live desktop', async () => {
    const hub = core();
    const current = await ready(hub);
    const pending = side();
    const id = hub.open(pending.transport, desktopGrant({ authorizedUntil: new Date(START + 1_000).toISOString() }));
    const delayed = gate();
    const verify = crypto.subtle.verify.bind(crypto.subtle);
    vi.spyOn(crypto.subtle, 'verify').mockImplementationOnce(async (...args) => { await delayed.wait(); return verify(...args); });
    const checking = hub.message(id, proof(pending.frames));
    await delayed.started;
    clock += 1_000;
    delayed.release();
    await checking;
    expect(pending.closes).toEqual([RELAY_CLOSE.sessionExpired]);
    expect(current.desktop.closes).toEqual([]);
    expect(pending.frames.map((frame) => JSON.parse(frame).type)).toEqual(['challenge']);
  });

  it('expires a challenged socket even while its signature verifier is suspended', async () => {
    const hub = core();
    const desktop = side();
    const id = hub.open(desktop.transport, desktopGrant());
    const delayed = gate();
    const verify = crypto.subtle.verify.bind(crypto.subtle);
    vi.spyOn(crypto.subtle, 'verify').mockImplementationOnce(async (...args) => { await delayed.wait(); return verify(...args); });
    const checking = hub.message(id, proof(desktop.frames));
    await delayed.started;
    clock += RELAY_TIMINGS.challengeMs;
    await hub.tick();
    const retainedWhileVerifying = hub.has(id);
    delayed.release();
    await checking;
    expect(retainedWhileVerifying).toBe(false);
    expect(desktop.closes).toEqual([RELAY_CLOSE.challengeTimeout]);
    expect(hub.has(id)).toBe(false);
  });

  it('does not revive a mapped sender removed while proof was awaited', async () => {
    const hub = core();
    const desktop = side();
    const id = hub.open(desktop.transport, desktopGrant());
    const delayed = gate();
    const verify = crypto.subtle.verify.bind(crypto.subtle);
    vi.spyOn(crypto.subtle, 'verify').mockImplementationOnce(async (...args) => { await delayed.wait(); return verify(...args); });
    const checking = hub.message(id, proof(desktop.frames));
    await delayed.started;
    await hub.end('fixture_device', RELAY_CLOSE.deviceRevoked);
    delayed.release();
    await checking;
    expect(desktop.closes).toEqual([RELAY_CLOSE.deviceRevoked]);
    expect(desktop.frames.map((frame) => JSON.parse(frame).type)).toEqual(['challenge']);
  });
});

describe('bounded desktop and whole-hub admission', () => {
  it('retains only bounded challenged sockets under a 2000-upgrade one-device flood', () => {
    const hub = core();
    const sides = Array.from({ length: 2_000 }, () => side());
    for (const desktop of sides) hub.open(desktop.transport, desktopGrant());
    expect(hub.size).toBeLessThanOrEqual(2);
    expect(sides.filter((desktop) => desktop.closes.length > 0).length).toBeGreaterThanOrEqual(1_998);
    expect(sides.filter((desktop) => desktop.frames.length > 0)).toHaveLength(2);
  });

  it('bounds pending sockets per person across many registered devices', () => {
    const hub = core();
    for (let index = 0; index < 100; index++) hub.open(side().transport, desktopGrant({ deviceId: `fixture_device_${index}` }));
    expect(hub.size).toBeLessThanOrEqual(8);
  });

  it('bounds pending sockets across all people in an organization', () => {
    const hub = core();
    for (let index = 0; index < 1_000; index++) hub.open(side().transport, desktopGrant({ deviceId: `fixture_device_${index}`, personId: `fixture_person_${index}` }));
    expect(hub.size).toBeLessThanOrEqual(64);
  });

  it('allows one ready desktop and bounded reconnect overlap, replacing only after proof', async () => {
    const hub = core();
    const current = await ready(hub);
    const next = side();
    const nextId = hub.open(next.transport, desktopGrant());
    const overlap = side();
    hub.open(overlap.transport, desktopGrant());
    const excess = side();
    hub.open(excess.transport, desktopGrant());
    expect(hub.size).toBe(3);
    expect(excess.frames).toEqual([]);
    expect(excess.closes).toHaveLength(1);
    expect(current.desktop.closes).toEqual([]);
    await hub.message(nextId, proof(next.frames));
    expect(current.desktop.closes).toEqual([RELAY_CLOSE.replaced]);
    expect(hub.presence()).toEqual(new Set(['fixture_device']));
  });

  it('reclaims expired challenges before a new admission even when the alarm has not run', () => {
    const hub = core();
    const first = side();
    const second = side();
    hub.open(first.transport, desktopGrant());
    hub.open(second.transport, desktopGrant());
    clock += RELAY_TIMINGS.challengeMs;
    const reconnect = side();
    hub.open(reconnect.transport, desktopGrant());
    expect(first.closes).toEqual([RELAY_CLOSE.challengeTimeout]);
    expect(second.closes).toEqual([RELAY_CLOSE.challengeTimeout]);
    expect(hub.size).toBe(1);
    expect(reconnect.frames).toHaveLength(1);
  });

  it('bounds restored pending and total sockets, including phones, before retaining them', () => {
    const hub = core();
    for (let index = 0; index < 1_000; index++) {
      hub.restore(side().transport, restored(identifier(index), { grant: desktopGrant({ deviceId: `device_${index}`, personId: `person_${index}` }) }));
    }
    expect(hub.size).toBeLessThanOrEqual(256);
    for (let index = 1_000; index < 2_000; index++) {
      hub.restorePhone(side<PhoneConnectionState>().transport, { v: 1, kind: 'phone', id: identifier(index), grant: phoneGrant({ personId: `person_${index}` }),
        openedAt: START, heardAt: START, checkedAt: START, nextCheckAt: START + RELAY_TIMINGS.recheckMs });
    }
    expect(hub.size).toBeLessThanOrEqual(512);
  });

  it('bounds rapid closed upgrades and rate-key memory, then expires both limits and idle keys', async () => {
    const hub = core();
    let accepted = 0;
    for (let index = 0; index < 2_000; index++) {
      const desktop = side();
      const id = hub.open(desktop.transport, desktopGrant({ deviceId: `device_${index}`, personId: `person_${index}` }));
      if (hub.has(id)) accepted++;
      await hub.closed(id);
    }
    expect(accepted).toBeLessThanOrEqual(240);
    const retained = (hub as unknown as { rates: Map<string, number[]> }).rates;
    expect((hub as unknown as { upgrades: unknown[] }).upgrades).toHaveLength(accepted);
    expect(retained.size).toBeLessThanOrEqual(481);
    clock += 60_001;
    const reconnect = side();
    hub.open(reconnect.transport, desktopGrant());
    expect(reconnect.frames).toHaveLength(1);
    expect(retained.size).toBeLessThanOrEqual(3);
    expect((hub as unknown as { upgrades: unknown[] }).upgrades).toHaveLength(1);
  });

  it('limits repeated upgrades by device while another device can still connect', async () => {
    const hub = core();
    for (let index = 0; index < 6; index++) await hub.closed(hub.open(side().transport, desktopGrant()));
    const excess = side();
    hub.open(excess.transport, desktopGrant());
    expect(excess.frames).toEqual([]);
    expect(excess.closes).toHaveLength(1);
    const other = side();
    hub.open(other.transport, desktopGrant({ deviceId: 'fixture_other' }));
    expect(other.frames).toHaveLength(1);
  });
});

class FakeSocket implements HubSocket {
  readyState = 1;
  frames: string[] = [];
  attachment: unknown = null;
  closes: { code?: number; reason?: string }[] = [];
  send(text: string) { this.frames.push(text); }
  close(code?: number, reason?: string) { this.closes.push({ code, reason }); this.readyState = 2; }
  serializeAttachment(saved: unknown) { this.attachment = structuredClone(saved); }
  deserializeAttachment() { return structuredClone(this.attachment); }
}
class TestHub extends RelayHub {
  protected override upgraded(_client: HubSocket): Response { return new Response(null, { status: 200, headers: { 'x-upgraded': 'yes' } }); }
}
function runtime() {
  const accepted: FakeSocket[] = [];
  const saved = new Map<string, unknown>();
  const storage = {
    get: async (key: string) => structuredClone(saved.get(key)),
    put: async (key: string, value: unknown) => { saved.set(key, structuredClone(value)); },
    setAlarm: async () => {}, deleteAlarm: async () => {},
  };
  const ctx: RelayHubState = { acceptWebSocket: (socket) => { accepted.push(socket as FakeSocket); }, getWebSockets: () => accepted,
    setWebSocketAutoResponse() {}, getWebSocketAutoResponseTimestamp: () => null, storage };
  return { accepted, ctx, storage, saved };
}
const upgrade = (grant: DesktopGrant) => new Request('https://relay-hub.invalid/desktop', {
  headers: { upgrade: 'websocket', [RELAY_GRANT_HEADER]: JSON.stringify(grant) },
});
class RawSocket extends Duplex {
  writes: Buffer[] = [];
  _read() {}
  _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void) { this.writes.push(Buffer.from(chunk)); callback(); }
}

describe('admission before transport acceptance', () => {
  it.each([
    ['device', 6, (index: number) => desktopGrant()],
    ['person', 30, (index: number) => desktopGrant({ deviceId: `device_${index}` })],
    ['organization', 240, (index: number) => desktopGrant({ deviceId: `device_${index}`, personId: `person_${index}` })],
  ] as const)('keeps the %s upgrade budget across repeated no-socket hibernation and permits recovery after the window', async (_name, limit, grantAt) => {
    const { ctx, accepted, saved } = runtime();
    vi.stubGlobal('WebSocketPair', class { 0 = new FakeSocket(); 1 = new FakeSocket(); });
    for (let index = 0; index < limit; index++) {
      const hub = new TestHub(ctx, {}, { now, authority, record: quiet });
      expect((await hub.fetch(upgrade(grantAt(index)))).headers.get('x-upgraded')).toBe('yes');
      await hub.webSocketClose(accepted.at(-1)!, 1000);
    }
    const woken = new TestHub(ctx, {}, { now, authority, record: quiet });
    expect((await woken.fetch(upgrade(grantAt(limit)))).status).toBe(429);
    expect(accepted).toHaveLength(limit);
    const ledger = [...saved.values()][0] as { events: unknown[] };
    expect(ledger.events).toHaveLength(limit);
    expect(JSON.stringify(ledger)).not.toContain('session');
    expect(JSON.stringify(ledger)).not.toContain('issuer');
    clock += 60_001;
    const recovered = new TestHub(ctx, {}, { now, authority, record: quiet });
    expect((await recovered.fetch(upgrade(grantAt(limit + 1)))).headers.get('x-upgraded')).toBe('yes');
    expect(([...saved.values()][0] as { events: unknown[] }).events).toHaveLength(1);
  });

  it.each(['read', 'write'] as const)('fails closed before socket allocation when upgrade accounting %s fails', async (failure) => {
    const { ctx, storage, accepted } = runtime();
    if (failure === 'read') storage.get = async () => { throw new Error('synthetic storage unavailable'); };
    else storage.put = async () => { throw new Error('synthetic storage unavailable'); };
    let allocated = 0;
    vi.stubGlobal('WebSocketPair', class { 0 = new FakeSocket(); 1 = new FakeSocket(); constructor() { allocated++; } });
    const hub = new TestHub(ctx, {}, { now, authority, record: quiet });
    expect((await hub.fetch(upgrade(desktopGrant()))).status).toBe(503);
    expect(allocated).toBe(0);
    expect(accepted).toEqual([]);
  });

  it('serializes delayed persistence so ordinary overlapping upgrades succeed within the pending cap', async () => {
    const { ctx, storage, accepted } = runtime();
    const delayed = gate();
    const put = storage.put;
    storage.put = async (key, value) => { await delayed.wait(); await put(key, value); };
    let allocated = 0;
    vi.stubGlobal('WebSocketPair', class { 0 = new FakeSocket(); 1 = new FakeSocket(); constructor() { allocated++; } });
    const hub = new TestHub(ctx, {}, { now, authority, record: quiet });
    const first = hub.fetch(upgrade(desktopGrant()));
    const waitingForStorage = await Promise.race([delayed.started.then(() => true), first.then(() => false)]);
    let answers: Response[] = [];
    try {
      expect(waitingForStorage, 'persistence must precede accepting the first socket').toBe(true);
      const second = hub.fetch(upgrade(desktopGrant()));
      const third = hub.fetch(upgrade(desktopGrant()));
      expect(allocated).toBe(0);
      delayed.release();
      answers = await Promise.all([first, second, third]);
    } finally { delayed.release(); await first; }
    expect(answers.map((response) => response.headers.get('x-upgraded') ?? String(response.status))).toEqual(['yes', 'yes', '429']);
    expect(allocated).toBe(2);
    expect(accepted).toHaveLength(2);
  });

  it.each(['persisting', 'queued'] as const)('cancels a %s desktop admission when the existing device-end signal arrives', async (phase) => {
    const { ctx, storage, accepted } = runtime();
    const delayed = gate();
    const put = storage.put;
    storage.put = async (key, value) => { await delayed.wait(); await put(key, value); };
    let allocated = 0;
    vi.stubGlobal('WebSocketPair', class { 0 = new FakeSocket(); 1 = new FakeSocket(); constructor() { allocated++; } });
    const hub = new TestHub(ctx, {}, { now, authority, record: quiet });
    const first = hub.fetch(upgrade(desktopGrant({ deviceId: phase === 'queued' ? 'fixture_unrelated' : 'fixture_device' })));
    await delayed.started;
    const target = phase === 'queued' ? hub.fetch(upgrade(desktopGrant())) : first;
    try {
      expect((await hub.fetch(new Request('https://relay-hub.invalid/end', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ deviceId: 'fixture_device', reason: RELAY_CLOSE.deviceRevoked.reason }),
      }))).status).toBe(204);
      expect(allocated).toBe(0);
    } finally { delayed.release(); }
    const refusal = await target;
    expect(refusal.status).toBe(403);
    expect(await refusal.json()).toMatchObject({ code: 'device_revoked' });
    if (phase === 'queued') expect((await first).headers.get('x-upgraded')).toBe('yes');
    expect(allocated).toBe(phase === 'queued' ? 1 : 0);
    expect(accepted).toHaveLength(phase === 'queued' ? 1 : 0);
    expect((hub as unknown as { pendingDesktopAdmissions: Set<unknown> }).pendingDesktopAdmissions.size).toBe(0);
  });

  it.each([
    ['bearer', 1_000, 401],
    ['authority', RELAY_TIMINGS.authorityWindowMs, 503],
  ] as const)('rechecks the %s deadline after persisted accounting and before accepting the socket', async (_name, elapsed, status) => {
    const { ctx, storage, accepted } = runtime();
    const delayed = gate();
    const put = storage.put;
    storage.put = async (key, value) => { await delayed.wait(); await put(key, value); };
    let allocated = 0;
    vi.stubGlobal('WebSocketPair', class { 0 = new FakeSocket(); 1 = new FakeSocket(); constructor() { allocated++; } });
    const hub = new TestHub(ctx, {}, { now, authority, record: quiet });
    const signingIn = hub.fetch(upgrade(desktopGrant({ authorizedUntil: new Date(START + (_name === 'bearer' ? elapsed : 3_600_000)).toISOString() })));
    const waitingForStorage = await Promise.race([delayed.started.then(() => true), signingIn.then(() => false)]);
    try {
      expect(waitingForStorage, 'the upgrade must wait for durable accounting').toBe(true);
      clock += elapsed;
    } finally { delayed.release(); }
    expect((await signingIn).status).toBe(status);
    expect(allocated).toBe(0);
    expect(accepted).toEqual([]);
  });

  it('refuses malformed or unbounded stored accounting before accepting an upgrade', async () => {
    const { ctx, storage, accepted } = runtime();
    storage.get = async () => ({ v: 1, events: Array.from({ length: 241 }, () => ({ at: START, personId: 'fixture_person', deviceId: 'fixture_device' })) });
    vi.stubGlobal('WebSocketPair', class { 0 = new FakeSocket(); 1 = new FakeSocket(); });
    expect((await new TestHub(ctx, {}, { now, authority, record: quiet }).fetch(upgrade(desktopGrant()))).status).toBe(503);
    expect(accepted).toEqual([]);
  });

  it('bounds queued admission work while durable accounting is suspended', async () => {
    const { ctx, storage, accepted } = runtime();
    const delayed = gate();
    const put = storage.put;
    storage.put = async (key, value) => { await delayed.wait(); await put(key, value); };
    vi.stubGlobal('WebSocketPair', class { 0 = new FakeSocket(); 1 = new FakeSocket(); });
    const hub = new TestHub(ctx, {}, { now, authority, record: quiet });
    const first = hub.fetch(upgrade(desktopGrant()));
    const waitingForStorage = await Promise.race([delayed.started.then(() => true), first.then(() => false)]);
    let pending: Promise<Response>[] = [];
    try {
      expect(waitingForStorage).toBe(true);
      pending = Array.from({ length: 1_000 }, () => hub.fetch(upgrade(desktopGrant())));
      expect((hub as unknown as { queuedAdmissions: number }).queuedAdmissions).toBeLessThanOrEqual(64);
      expect(accepted).toEqual([]);
    } finally { delayed.release(); await first; }
    const answers = await Promise.all(pending);
    expect(answers.filter((response) => response.status === 429).length).toBeGreaterThanOrEqual(999);
    expect(accepted).toHaveLength(2);
  });

  it('refuses an excess Durable Object upgrade before allocating or accepting a socket pair', async () => {
    const { ctx, accepted } = runtime();
    let allocated = 0;
    vi.stubGlobal('WebSocketPair', class { 0 = new FakeSocket(); 1 = new FakeSocket(); constructor() { allocated++; } });
    const hub = new TestHub(ctx, {}, { now, authority, record: quiet });
    for (let index = 0; index < 2; index++) expect((await hub.fetch(upgrade(desktopGrant()))).headers.get('x-upgraded')).toBe('yes');
    const refusal = await hub.fetch(upgrade(desktopGrant()));
    expect(refusal.status).toBe(429);
    expect(accepted).toHaveLength(2);
    expect(allocated).toBe(2);
  });

  it('caps challenged sockets rebuilt after Durable Object hibernation', async () => {
    const { ctx, accepted } = runtime();
    for (let index = 0; index < 30; index++) {
      const socket = new FakeSocket();
      socket.attachment = restored(identifier(index), { phase: 'challenged', readyAt: null, nonce: 'A'.repeat(43) });
      accepted.push(socket);
    }
    const woken = new TestHub(ctx, {}, { now, authority, record: quiet });
    await woken.fetch(new Request('https://relay-hub.invalid/presence'));
    expect(accepted.filter((socket) => socket.readyState === 1)).toHaveLength(2);
  });

  it('refuses an excess faux-cloud upgrade before writing the HTTP switching response', async () => {
    const hubs = new FauxRelayHubs(authority, now);
    const sockets: RawSocket[] = [];
    try {
      for (let index = 0; index < 2; index++) {
        const request = new Request('http://127.0.0.1/desktop', { headers: { upgrade: 'websocket', connection: 'Upgrade', 'sec-websocket-version': '13', 'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==' } });
        const socket = new RawSocket(); sockets.push(socket);
        hubs.hold(request, socket, Buffer.alloc(0));
        await hubs.connect(desktopGrant(), request);
        expect(socket.writes[0].toString()).toContain('101 Switching Protocols');
      }
      const refused = new Request('http://127.0.0.1/desktop', { headers: { upgrade: 'websocket', connection: 'Upgrade', 'sec-websocket-version': '13', 'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==' } });
      const socket = new RawSocket(); sockets.push(socket);
      hubs.hold(refused, socket, Buffer.alloc(0));
      await expect(hubs.connect(desktopGrant(), refused)).rejects.toMatchObject({ status: 429 });
      expect(hubs.taken(refused)).toBe(false);
      expect(socket.writes).toEqual([]);
    } finally {
      hubs.closeAll();
      for (const socket of sockets) socket.destroy();
    }
  });
});
