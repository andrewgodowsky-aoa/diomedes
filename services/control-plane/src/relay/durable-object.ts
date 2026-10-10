/**
 * The relay hub on Cloudflare: one Durable Object per business, named by its
 * organization id, holding that business's desktop connections (relay plan
 * step 2) and its phones' connections (steps 3 and 4) with the WebSocket
 * Hibernation API. The rules are RelayHubCore's; this file is its Cloudflare host.
 *
 * Only this Worker reaches the hub, through the RELAY_HUB binding, and only
 * after the Worker front has checked the desktop's sign-in, membership, role,
 * plan and registration, or the phone's sign-in, membership and plan. The
 * front passes what it checked in the grant header;
 * there is no public route to the hub. While it hibernates, each socket keeps
 * its connection state as an attachment, the runtime answers heartbeats on its
 * own, and an alarm wakes the hub for its next recheck or deadline.
 *
 * A plain class against the few runtime methods it uses: this package
 * type-checks without the Workers runtime types.
 */
import { z } from 'zod';
import { configuration } from '../config.js';
import { accountId } from '../domain.js';
import { neonClientFactory } from '../postgres.js';
import {
  RelayHubCore,
  desktopGrantSchema,
  phoneGrantSchema,
  type DesktopGrant,
  type HubAuthority,
  type HubEvent,
  type HubTransport,
  type PhoneGrant,
  type PhoneTransport,
  type PreparedUpgrade,
} from './hub-core.js';
import { PostgresRelayRepository } from './postgres.js';
import { RELAY_CLOSE, RELAY_LIMITS, RELAY_PING_FRAME, RELAY_PONG_FRAME, type RelayClose } from './protocol.js';
import { RelayAuthority, type RelayHubs } from './service.js';

/** The header the Worker front passes its grant to the hub in. A client's copy is always replaced. */
export const RELAY_GRANT_HEADER = 'X-Nectovia-Relay-Grant';
const HUB_ORIGIN = 'https://relay-hub.invalid';
const UPGRADE_ACCOUNTING_KEY = 'relay-upgrade-accounting-v1';

/** The runtime's hibernatable WebSocket, as far as the hub uses it. */
export interface HubSocket {
  readonly readyState: number;
  send(message: string): void;
  close(code?: number, reason?: string): void;
  serializeAttachment(value: unknown): void;
  deserializeAttachment(): unknown;
}

/** The Durable Object state, as far as the hub uses it. */
export interface RelayHubState {
  acceptWebSocket(ws: HubSocket, tags?: string[]): void;
  getWebSockets(tag?: string): HubSocket[];
  setWebSocketAutoResponse(pair?: unknown): void;
  getWebSocketAutoResponseTimestamp(ws: HubSocket): Date | null;
  readonly storage: {
    get(key: string): Promise<unknown>;
    put(key: string, value: unknown): Promise<void>;
    setAlarm(scheduledTime: number): Promise<void>;
    deleteAlarm(): Promise<void>;
  };
}

interface RuntimeGlobals {
  WebSocketPair?: new () => Record<0 | 1, HubSocket>;
  WebSocketRequestResponsePair?: new (request: string, response: string) => unknown;
}

/** Test seams. On Cloudflare the hub reads the database through DATABASE_URL (cp_runtime). */
export interface RelayHubOptions {
  authority?: HubAuthority;
  now?: () => number;
  record?: (event: HubEvent) => void;
}

const OPEN = 1;
const endInput = z.strictObject({ deviceId: accountId, reason: z.literal(RELAY_CLOSE.deviceRevoked.reason) });

/** The database behind the rechecks, opened on first use so a missing setting fails a recheck, not the hub. */
function databaseAuthority(env: Record<string, unknown>): HubAuthority {
  let authority: RelayAuthority | null = null;
  const current = () => (authority ??= new RelayAuthority(new PostgresRelayRepository(neonClientFactory(configuration(env).databaseUrl))));
  return {
    recheck: async (grant, at) => current().recheck(grant, at),
    seen: async (grant, at) => current().seen(grant, at),
    recheckPhone: async (grant, at) => current().recheckPhone(grant, at),
  };
}

/** The saved connection id on a socket, or null. */
function savedId(ws: HubSocket): string | null {
  try {
    const saved = ws.deserializeAttachment() as { id?: unknown } | null;
    return typeof saved?.id === 'string' ? saved.id : null;
  } catch {
    return null;
  }
}

export class RelayHub {
  private core: RelayHubCore | null = null;
  private upgradeAccountingLoaded = false;
  private admission: Promise<void> = Promise.resolve();
  private queuedAdmissions = 0;
  /** Only current queued admissions, bounded by queuedAdmissions; no retained device tombstones. */
  private readonly pendingDesktopAdmissions = new Set<{ deviceId: string; cancelled: boolean }>();

  constructor(
    private readonly ctx: RelayHubState,
    private readonly env: Record<string, unknown>,
    private readonly options: RelayHubOptions = {},
  ) {
    // Heartbeats are answered by the runtime without waking the hub; the hub reads when it last did.
    const Pair = (globalThis as RuntimeGlobals).WebSocketRequestResponsePair;
    if (Pair) ctx.setWebSocketAutoResponse(new Pair(RELAY_PING_FRAME, RELAY_PONG_FRAME));
  }

  async fetch(request: Request): Promise<Response> {
    const hub = this.hub();
    const { pathname } = new URL(request.url);
    try {
      if (pathname === '/desktop') return await this.accept(request, desktopGrantSchema, (grant) => hub.prepareDesktop(grant));
      if (pathname === '/phone') return await this.accept(request, phoneGrantSchema, (grant) => hub.preparePhone(grant));
      if (pathname === '/presence' && request.method === 'GET') return Response.json({ online: [...hub.presence()] });
      if (pathname === '/end' && request.method === 'POST') {
        const input = endInput.safeParse(await request.json().catch(() => null));
        if (!input.success) return new Response(null, { status: 400 });
        for (const pending of this.pendingDesktopAdmissions)
          if (pending.deviceId === input.data.deviceId) pending.cancelled = true;
        await hub.end(input.data.deviceId, RELAY_CLOSE.deviceRevoked);
        return new Response(null, { status: 204 });
      }
      return new Response(null, { status: 404 });
    } finally {
      await this.schedule();
    }
  }

  async webSocketMessage(ws: HubSocket, message: string | ArrayBuffer): Promise<void> {
    const id = savedId(ws);
    if (id !== null) await this.hub().message(id, message);
    await this.schedule();
  }

  async webSocketClose(ws: HubSocket, code: number): Promise<void> {
    const id = savedId(ws);
    if (id !== null) await this.hub().closed(id, code);
    try {
      ws.close(code === 1005 || code === 1006 ? 1000 : code, 'closed');
    } catch {
      // The runtime already answered the close.
    }
    await this.schedule();
  }

  async webSocketError(ws: HubSocket): Promise<void> {
    const id = savedId(ws);
    if (id !== null) await this.hub().closed(id, 1006);
    await this.schedule();
  }

  async alarm(): Promise<void> {
    await this.hub().tick();
    await this.schedule();
  }

  /** The 101 answer that hands the client end of the socket back through the Worker. A seam: Node refuses status 101. */
  protected upgraded(client: HubSocket): Response {
    const init: ResponseInit & { webSocket: HubSocket } = { status: 101, webSocket: client };
    return new Response(null, init);
  }

  /** Persist bounded accounting before allocating a socket. Awaited storage must never bypass caps or deadlines. */
  private async accept<G extends DesktopGrant | PhoneGrant>(request: Request, schema: z.ZodType<G>,
    prepare: (grant: G) => PreparedUpgrade<HubTransport & PhoneTransport> | RelayClose): Promise<Response> {
    if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') return new Response(null, { status: 426 });
    let grant: G;
    try {
      grant = schema.parse(JSON.parse(request.headers.get(RELAY_GRANT_HEADER) ?? ''));
    } catch {
      return new Response(null, { status: 400 });
    }
    const Pair = (globalThis as RuntimeGlobals).WebSocketPair;
    if (!Pair) return new Response(null, { status: 503 });
    if (this.queuedAdmissions >= RELAY_LIMITS.queuedUpgradesPerOrganization) return this.refused(RELAY_CLOSE.connectionLimit);
    const pending = 'deviceId' in grant ? { deviceId: grant.deviceId, cancelled: false } : null;
    if (pending) this.pendingDesktopAdmissions.add(pending);
    this.queuedAdmissions++;
    const previous = this.admission;
    let release!: () => void;
    this.admission = new Promise<void>((resolve) => { release = resolve; });
    try {
      // Explicit serialization also protects deterministic hosts without the Workers storage input gate.
      await previous;
      if (pending?.cancelled) return this.refused(RELAY_CLOSE.deviceRevoked);
      if (!this.upgradeAccountingLoaded) {
        try {
          const saved = await this.ctx.storage.get(UPGRADE_ACCOUNTING_KEY);
          if (!this.hub().restoreUpgradeAccounting(saved)) return this.refused(RELAY_CLOSE.recheckUnavailable);
          this.upgradeAccountingLoaded = true;
        } catch { return this.refused(RELAY_CLOSE.recheckUnavailable); }
      }
      if (pending?.cancelled) return this.refused(RELAY_CLOSE.deviceRevoked);
      const prepared = prepare(grant);
      if ('reason' in prepared) return this.refused(prepared);
      try { await this.ctx.storage.put(UPGRADE_ACCOUNTING_KEY, prepared.accounting); }
      catch { return this.refused(RELAY_CLOSE.recheckUnavailable); }
      if (pending?.cancelled) return this.refused(RELAY_CLOSE.deviceRevoked);
      const ending = prepared.recheck();
      if (ending) return this.refused(ending);
      // No await between the final check, allocation and opening. The reservation is consumed once.
      const [client, server] = Object.values(new Pair()) as [HubSocket, HubSocket];
      this.ctx.acceptWebSocket(server);
      prepared.open(this.transport(server));
      return this.upgraded(client);
    } finally {
      if (pending) this.pendingDesktopAdmissions.delete(pending);
      this.queuedAdmissions--;
      release();
    }
  }

  private refused(refusal: RelayClose): Response {
    return Response.json({ error: 'Phone access cannot accept another connection right now. Try again shortly.', code: refusal.reason }, {
      status: refusal === RELAY_CLOSE.sessionExpired ? 401 : refusal === RELAY_CLOSE.deviceRevoked ? 403 : refusal === RELAY_CLOSE.recheckUnavailable ? 503 : 429,
      headers: { 'retry-after': refusal === RELAY_CLOSE.upgradeRateLimited ? '60' : '10' },
    });
  }

  /** A socket as the hub uses it, desktop or phone: each keeps its own state as the socket's attachment. */
  private transport(ws: HubSocket): HubTransport & PhoneTransport {
    return {
      send: (text) => ws.send(text),
      close: (code, reason) => ws.close(code, reason),
      save: (state: unknown) => {
        try {
          ws.serializeAttachment(state);
        } catch {
          // The socket is gone; so is its state.
        }
      },
      heardAt: () => this.ctx.getWebSocketAutoResponseTimestamp(ws)?.getTime() ?? null,
    };
  }

  /** The hub, rebuilt from the sockets' saved state after hibernation. */
  private hub(): RelayHubCore {
    if (this.core) return this.core;
    const core = new RelayHubCore({
      authority: this.options.authority ?? databaseAuthority(this.env),
      now: this.options.now,
      record: this.options.record ?? ((event) => console.log(JSON.stringify(event))),
    });
    for (const ws of this.ctx.getWebSockets()) {
      if (ws.readyState !== OPEN) continue;
      let saved: unknown = null;
      try {
        saved = ws.deserializeAttachment();
      } catch {
        // Unreadable: closed below.
      }
      // A socket whose state can't be read can't be vouched for: the desktop or phone dials again.
      const phone = (saved as { kind?: unknown } | null)?.kind === 'phone';
      if (!(phone ? core.restorePhone(this.transport(ws), saved) : core.restore(this.transport(ws), saved))) {
        try {
          ws.close(RELAY_CLOSE.recheckUnavailable.code, RELAY_CLOSE.recheckUnavailable.reason);
        } catch {
          // Already closing.
        }
      }
    }
    this.core = core;
    return core;
  }

  private async schedule(): Promise<void> {
    const next = this.hub().nextDeadline();
    if (next === null) await this.ctx.storage.deleteAlarm();
    else await this.ctx.storage.setAlarm(next);
  }
}

/** The RELAY_HUB binding, as far as the Worker front uses it. */
interface HubNamespace {
  idFromName(name: string): unknown;
  get(id: unknown): { fetch(input: Request | string, init?: RequestInit): Promise<Response> };
}

const presenceAnswer = z.strictObject({ online: z.array(accountId).max(10_000) });

function isHubNamespace(value: unknown): value is HubNamespace {
  const candidate = value as Partial<HubNamespace> | null | undefined;
  return typeof candidate?.idFromName === 'function' && typeof candidate.get === 'function';
}

/** The Worker front's way to each business's hub, or null where RELAY_HUB is not bound. */
export function durableObjectHubs(binding: unknown): RelayHubs | null {
  if (!isHubNamespace(binding)) return null;
  const hub = (organizationId: string) => binding.get(binding.idFromName(organizationId));
  // The hub needs the handshake headers and the grant, never the bearer.
  const forward = (path: '/desktop' | '/phone', grant: DesktopGrant | PhoneGrant, request: Request) => {
    const headers = new Headers(request.headers);
    headers.delete('authorization');
    headers.set(RELAY_GRANT_HEADER, JSON.stringify(grant));
    return hub(grant.organizationId).fetch(new Request(`${HUB_ORIGIN}${path}`, { method: 'GET', headers }));
  };
  return {
    async presence(organizationId) {
      const response = await hub(organizationId).fetch(`${HUB_ORIGIN}/presence`);
      if (!response.ok) throw new Error('The relay hub did not answer.');
      return new Set(presenceAnswer.parse(await response.json()).online);
    },
    connect(grant, request) {
      return forward('/desktop', grant, request);
    },
    connectPhone(grant, request) {
      return forward('/phone', grant, request);
    },
    async end(organizationId: string, deviceId: string, close: RelayClose) {
      const response = await hub(organizationId).fetch(`${HUB_ORIGIN}/end`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ deviceId, reason: close.reason }),
      });
      if (!response.ok) throw new Error('The relay hub did not end the connection.');
    },
  };
}
