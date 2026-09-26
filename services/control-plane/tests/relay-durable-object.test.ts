/**
 * The RelayHub Durable Object's host code against a stand-in for the Workers
 * runtime: the upgrade, the attachments that carry a connection through
 * hibernation, the heartbeat auto-response, the alarm, and the Worker front's
 * calls. The real runtime is not here; this checks the wiring, not workerd.
 */
import { generateKeyPairSync, sign } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RELAY_GRANT_HEADER, RelayHub, durableObjectHubs, type HubSocket, type RelayHubState } from '../src/relay/durable-object.js';
import type { DesktopGrant, HubAuthority } from '../src/relay/hub-core.js';
import { RELAY_CLOSE, RELAY_PING_FRAME, RELAY_PONG_FRAME, RELAY_TIMINGS, challengePayload } from '../src/relay/protocol.js';

const START = Date.parse('2026-09-26T12:00:00.000Z');
const quiet = () => {};
let clock = START;
const now = () => clock;

class FakeSocket implements HubSocket {
  readyState = 1;
  frames: string[] = [];
  closes: { code?: number; reason?: string }[] = [];
  attachment: unknown = null;
  send(message: string) { this.frames.push(message); }
  close(code?: number, reason?: string) { this.closes.push({ code, reason }); this.readyState = 2; }
  serializeAttachment(value: unknown) { this.attachment = structuredClone(value); }
  deserializeAttachment() { return structuredClone(this.attachment); }
}

/** The runtime's side: accepted sockets, the auto-response, and the alarm. */
function runtime() {
  const accepted: FakeSocket[] = [];
  const alarms: (number | null)[] = [];
  const autoResponses: { request: string; response: string }[] = [];
  const heard = new Map<HubSocket, Date>();
  const ctx: RelayHubState = {
    acceptWebSocket: (ws) => { accepted.push(ws as FakeSocket); },
    getWebSockets: () => [...accepted],
    setWebSocketAutoResponse: (pair) => { autoResponses.push(pair as { request: string; response: string }); },
    getWebSocketAutoResponseTimestamp: (ws) => heard.get(ws) ?? null,
    storage: {
      setAlarm: async (at) => { alarms.push(at); },
      deleteAlarm: async () => { alarms.push(null); },
    },
  };
  return { ctx, accepted, alarms, autoResponses, heard };
}

/** The hub with Node's refusal of status 101 stepped around. */
class TestHub extends RelayHub {
  clients: HubSocket[] = [];
  protected override upgraded(client: HubSocket): Response {
    this.clients.push(client);
    return new Response(null, { status: 200, headers: { 'x-upgraded': 'yes' } });
  }
}

function authority() {
  const seen: string[] = [];
  const recheck = vi.fn<HubAuthority['recheck']>(async () => null);
  return { seen, recheck, authority: { recheck, seen: async (_grant: DesktopGrant, at: string) => { seen.push(at); } } satisfies HubAuthority };
}

const key = generateKeyPairSync('ed25519');
const grant: DesktopGrant = {
  organizationId: 'org_juniper', tenantId: 'tenant_juniper', deviceId: 'relay_device_front', personId: 'person_owner',
  publicKey: key.publicKey.export({ format: 'jwk' }).x!, issuer: 'https://issuer.test', sessionId: 'session_owner',
  authorizedUntil: '2026-09-26T12:15:00.000Z', checkedAt: '2026-09-26T12:00:00.000Z',
};

const upgrade = (headers: Record<string, string> = {}) => new Request('https://relay-hub.invalid/desktop', {
  headers: { upgrade: 'websocket', [RELAY_GRANT_HEADER]: JSON.stringify(grant), ...headers },
});

function proof(server: FakeSocket) {
  const challenge = JSON.parse(server.frames[0]);
  return JSON.stringify({ v: 1, type: 'prove', signature: sign(null, challengePayload(challenge), key.privateKey).toString('base64url') });
}

beforeEach(() => {
  clock = START;
  vi.stubGlobal('WebSocketPair', class {
    0 = new FakeSocket();
    1 = new FakeSocket();
  });
  vi.stubGlobal('WebSocketRequestResponsePair', class {
    constructor(readonly request: string, readonly response: string) {}
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the RelayHub Durable Object', () => {
  it('answers heartbeats without waking, accepts an upgrade, challenges, and sets its alarm', async () => {
    const { ctx, accepted, alarms, autoResponses } = runtime();
    const auth = authority();
    const logged = vi.spyOn(console, 'log').mockImplementation(() => {});
    const hub = new TestHub(ctx, {}, { authority: auth.authority, now });
    expect(autoResponses).toEqual([{ request: RELAY_PING_FRAME, response: RELAY_PONG_FRAME }]);

    const answer = await hub.fetch(upgrade());
    expect(answer.headers.get('x-upgraded')).toBe('yes');
    expect(hub.clients).toHaveLength(1);
    const [server] = accepted;
    expect(JSON.parse(server.frames[0])).toMatchObject({ type: 'challenge', deviceId: 'relay_device_front' });
    expect(server.attachment).toMatchObject({ v: 1, phase: 'challenged' });
    expect(alarms.at(-1)).toBe(START + RELAY_TIMINGS.challengeMs);

    await hub.webSocketMessage(server, proof(server));
    expect(JSON.parse(server.frames[1])).toMatchObject({ type: 'ready' });
    // Last seen is due at once; the alarm writes it.
    expect(alarms.at(-1)).toBe(START);
    await hub.alarm();
    expect(auth.seen).toEqual(['2026-09-26T12:00:00.000Z']);
    expect(alarms.at(-1)).toBe(START + RELAY_TIMINGS.recheckMs);
    expect(await (await hub.fetch(new Request('https://relay-hub.invalid/presence'))).json()).toEqual({ online: ['relay_device_front'] });
    // Its log names the business and the computer, and nothing it was sent.
    const lines = logged.mock.calls.map(([line]) => String(line));
    expect(lines.map((line) => JSON.parse(line).event)).toEqual(['relay-desktop-opened', 'relay-desktop-ready']);
    for (const line of lines) {
      expect(line).not.toContain(grant.publicKey);
      expect(line).not.toContain(JSON.parse(server.frames[0]).nonce);
    }
  });

  it('wakes from hibernation with its connections, counting the heartbeats the runtime answered', async () => {
    const { ctx, accepted, heard } = runtime();
    const auth = authority();
    const first = new TestHub(ctx, {}, { authority: auth.authority, now, record: quiet });
    await first.fetch(upgrade());
    const [server] = accepted;
    await first.webSocketMessage(server, proof(server));

    // Evicted: a new instance over the same sockets. The runtime answered a ping at 50 seconds.
    heard.set(server, new Date(START + 50_000));
    const woken = new TestHub(ctx, {}, { authority: auth.authority, now, record: quiet });
    // Rechecks keep passing; only the heartbeat decides here.
    auth.recheck.mockImplementation(async () => null);
    for (const ms of [20_000, 40_000, 60_000, 80_000, 100_000]) {
      clock = START + ms;
      await woken.alarm();
    }
    expect(server.closes).toEqual([]);
    expect(await (await woken.fetch(new Request('https://relay-hub.invalid/presence'))).json()).toEqual({ online: ['relay_device_front'] });
    clock = START + 110_000;
    await woken.alarm();
    expect(server.closes).toEqual([RELAY_CLOSE.heartbeatTimeout]);
    expect(server.attachment).toBeNull();
  });

  it('ends a stopped device when the Worker front asks, then clears its alarm', async () => {
    const { ctx, accepted, alarms } = runtime();
    const hub = new TestHub(ctx, {}, { authority: authority().authority, now, record: quiet });
    await hub.fetch(upgrade());
    const [server] = accepted;
    await hub.webSocketMessage(server, proof(server));
    const ended = await hub.fetch(new Request('https://relay-hub.invalid/end', {
      method: 'POST', body: JSON.stringify({ deviceId: 'relay_device_front', reason: 'device_revoked' }),
    }));
    expect(ended.status).toBe(204);
    expect(server.closes).toEqual([RELAY_CLOSE.deviceRevoked]);
    expect(alarms.at(-1)).toBeNull();
    const refused = await hub.fetch(new Request('https://relay-hub.invalid/end', {
      method: 'POST', body: JSON.stringify({ deviceId: 'relay_device_front', reason: 'anything' }),
    }));
    expect(refused.status).toBe(400);
  });

  it('refuses anything but an upgrade carrying a grant, and closes a socket whose state it cannot read', async () => {
    const { ctx, accepted } = runtime();
    const hub = new TestHub(ctx, {}, { authority: authority().authority, now, record: quiet });
    expect((await hub.fetch(new Request('https://relay-hub.invalid/desktop'))).status).toBe(426);
    expect((await hub.fetch(upgrade({ [RELAY_GRANT_HEADER]: '{}' }))).status).toBe(400);
    expect((await hub.fetch(new Request('https://relay-hub.invalid/elsewhere'))).status).toBe(404);
    expect(accepted).toEqual([]);

    const stray = new FakeSocket();
    stray.attachment = { unreadable: true };
    accepted.push(stray);
    const woken = new TestHub(ctx, {}, { authority: authority().authority, now, record: quiet });
    await woken.fetch(new Request('https://relay-hub.invalid/presence'));
    expect(stray.closes).toEqual([RELAY_CLOSE.recheckUnavailable]);
  });

  it('forgets a connection the desktop closed', async () => {
    const { ctx, accepted, alarms } = runtime();
    const auth = authority();
    const hub = new TestHub(ctx, {}, { authority: auth.authority, now, record: quiet });
    await hub.fetch(upgrade());
    const [server] = accepted;
    await hub.webSocketMessage(server, proof(server));
    await hub.webSocketClose(server, 1000);
    expect(await (await hub.fetch(new Request('https://relay-hub.invalid/presence'))).json()).toEqual({ online: [] });
    expect(auth.seen).toEqual(['2026-09-26T12:00:00.000Z']);
    expect(alarms.at(-1)).toBeNull();
  });
});

describe("the Worker front's way to the hub", () => {
  it('is absent without the binding', () => {
    expect(durableObjectHubs(undefined)).toBeNull();
    expect(durableObjectHubs({})).toBeNull();
  });

  it('names the hub by organization id, passes the grant, and never the bearer', async () => {
    const requests: { name: string; request: Request }[] = [];
    const namespace = {
      idFromName: (name: string) => ({ name }),
      get: (id: { name: string }) => ({
        fetch: async (input: Request | string, init?: RequestInit) => {
          const request = typeof input === 'string' ? new Request(input, init) : input;
          requests.push({ name: id.name, request });
          if (request.url.endsWith('/presence')) return Response.json({ online: ['relay_device_front'] });
          return new Response(null, { status: request.url.endsWith('/end') ? 204 : 200 });
        },
      }),
    };
    const hubs = durableObjectHubs(namespace)!;
    expect(await hubs.presence('org_juniper')).toEqual(new Set(['relay_device_front']));
    await hubs.connect(grant, new Request('https://accounts.diomedes.net/relay/v1/organizations/org_juniper/desktop', {
      headers: { authorization: 'Bearer secret-bearer', upgrade: 'websocket', 'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==', [RELAY_GRANT_HEADER]: '{"forged":true}' },
    }));
    await hubs.end('org_juniper', 'relay_device_front', RELAY_CLOSE.deviceRevoked);
    expect(requests.map(({ name, request }) => [name, new URL(request.url).pathname])).toEqual([
      ['org_juniper', '/presence'], ['org_juniper', '/desktop'], ['org_juniper', '/end'],
    ]);
    const dialled = requests[1].request;
    expect(dialled.headers.get('authorization')).toBeNull();
    expect(dialled.headers.get('upgrade')).toBe('websocket');
    expect(dialled.headers.get('sec-websocket-key')).toBe('dGhlIHNhbXBsZSBub25jZQ==');
    expect(JSON.parse(dialled.headers.get(RELAY_GRANT_HEADER)!)).toEqual(grant);
    expect(await requests[2].request.json()).toEqual({ deviceId: 'relay_device_front', reason: 'device_revoked' });
  });
});
