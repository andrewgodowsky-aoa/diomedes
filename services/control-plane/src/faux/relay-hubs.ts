/**
 * The faux cloud's relay hubs: the same RelayHubCore the Durable Object hosts,
 * one per business, in this process, over the faux cloud's own RFC 6455
 * endpoint (./websocket.ts). Timers stand in for the Durable Object's alarm.
 *
 * The faux server hands each raw upgrade to hold() before the Worker's relay
 * route runs. When the route authorizes the desktop, connect() answers the
 * upgrade on that same socket; when it refuses, the server writes the refusal
 * as an ordinary HTTP answer. Only the faux server can hold a socket, so an
 * in-process call to the route can check a desktop but never connect one.
 */
import type { Duplex } from 'node:stream';
import { RelayHubCore, type DesktopGrant, type HubAuthority } from '../relay/hub-core.js';
import type { RelayClose } from '../relay/protocol.js';
import { RelayError, type RelayHubs } from '../relay/service.js';
import { FauxWebSocket, switchingProtocols, upgradeKey } from './websocket.js';

interface HeldUpgrade {
  socket: Duplex;
  head: Buffer;
  taken: boolean;
}

interface Hub {
  core: RelayHubCore;
  timer: NodeJS.Timeout | null;
}

export class FauxRelayHubs implements RelayHubs {
  private readonly hubs = new Map<string, Hub>();
  private readonly held = new WeakMap<Request, HeldUpgrade>();
  private readonly sockets = new Set<FauxWebSocket>();
  private stopped = false;

  constructor(private readonly authority: HubAuthority, private readonly now: () => number = Date.now) {}

  /** The faux server's raw upgrade, kept until the relay route answers the request. */
  hold(request: Request, socket: Duplex, head: Buffer): void {
    this.held.set(request, { socket, head, taken: false });
  }

  /** Whether the relay route answered the upgrade itself and owns the socket now. */
  taken(request: Request): boolean {
    return this.held.get(request)?.taken === true;
  }

  async presence(organizationId: string): Promise<ReadonlySet<string>> {
    return this.hubs.get(organizationId)?.core.presence() ?? new Set<string>();
  }

  async connect(grant: DesktopGrant, request: Request): Promise<Response> {
    const held = this.held.get(request);
    if (!held || held.taken || this.stopped)
      throw new RelayError(503, "Phone access isn't available right now. Try again shortly.", 'relay_unavailable');
    const key = upgradeKey(request.headers);
    if (!key) throw new RelayError(400, 'A computer dials in with a version 13 WebSocket handshake.', 'invalid_upgrade');
    held.taken = true;
    const hub = this.hub(grant.organizationId);
    let id = '';
    const socket: FauxWebSocket = new FauxWebSocket(held.socket, held.head, {
      message: (data) => void hub.core.message(id, data).finally(() => this.schedule(grant.organizationId)),
      close: (code) => {
        this.sockets.delete(socket);
        void hub.core.closed(id, code).finally(() => this.schedule(grant.organizationId));
      },
    });
    this.sockets.add(socket);
    (held.socket as Duplex & { setNoDelay?(noDelay: boolean): unknown }).setNoDelay?.(true);
    held.socket.write(switchingProtocols(key));
    id = hub.core.open({ send: (text) => socket.send(text), close: (code, reason) => socket.close(code, reason), save: () => {} }, grant);
    socket.start();
    this.schedule(grant.organizationId);
    return new Response(null, { status: 204 });
  }

  async end(organizationId: string, deviceId: string, close: RelayClose): Promise<void> {
    const hub = this.hubs.get(organizationId);
    if (!hub) return;
    await hub.core.end(deviceId, close);
    this.schedule(organizationId);
  }

  /** Runs every hub's due work now. Tests move the faux clock, then call this. */
  async tickAll(): Promise<void> {
    await Promise.all([...this.hubs.entries()].map(async ([organizationId, hub]) => {
      await hub.core.tick();
      this.schedule(organizationId);
    }));
  }

  /** Drops every relay socket and timer: the faux server is stopping. */
  closeAll(): void {
    this.stopped = true;
    for (const hub of this.hubs.values()) if (hub.timer) clearTimeout(hub.timer);
    for (const socket of this.sockets) socket.terminate();
    this.sockets.clear();
  }

  private hub(organizationId: string): Hub {
    let hub = this.hubs.get(organizationId);
    if (!hub) {
      hub = { core: new RelayHubCore({ authority: this.authority, now: this.now }), timer: null };
      this.hubs.set(organizationId, hub);
    }
    return hub;
  }

  /** Sets the hub's timer for its next deadline, as the Durable Object sets its alarm. */
  private schedule(organizationId: string): void {
    const hub = this.hubs.get(organizationId);
    if (!hub) return;
    if (hub.timer) clearTimeout(hub.timer);
    hub.timer = null;
    const next = hub.core.nextDeadline();
    if (next === null || this.stopped) return;
    hub.timer = setTimeout(() => {
      hub.timer = null;
      void hub.core.tick().finally(() => this.schedule(organizationId));
    }, Math.max(0, next - this.now()));
    hub.timer.unref();
  }
}
