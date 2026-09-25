/**
 * H20: one real Core for the headless runner.
 *
 * `createApp` is the production Core: the real Store, RunService, Work, Needs,
 * recorded writer, durable controls, supervision and verifier. It listens on a
 * free loopback port and the runner reaches it only over HTTP, with the same
 * `X-Diomedes-Client` header the Console sends. No browser is started.
 *
 * The only things replaced are at the transport boundary, through the seams
 * Core already exposes for exactly this: `nativeGenerator` (the Codex Work
 * call), `modelApiTransport` (the network below the AI SDK) and `engineService`
 * (which installations exist). Nothing inside Core is mocked, and the runner
 * never writes Core's records: what it learns it reads back over HTTP.
 *
 * `close()` then `open()` over the same folder is a restart.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../../server/app.js';

export type CoreOptions = Omit<Parameters<typeof createApp>[0], 'dataDir' | 'projectRoot'>;

const HEADERS = { 'Content-Type': 'application/json', 'X-Diomedes-Client': '1' };

export interface Reply<T = unknown> {
  status: number;
  data: T;
}

export class Core {
  private app: Awaited<ReturnType<typeof createApp>> | undefined;
  private server: Server | undefined;
  url = '';

  constructor(
    readonly root: string,
    private readonly options: () => CoreOptions,
  ) {}

  get dataDir() {
    return path.join(this.root, 'data');
  }
  get projectRoot() {
    return path.join(this.root, 'projects');
  }
  get running() {
    return this.server !== undefined;
  }

  async open() {
    if (this.server) throw new Error('This Core is already running.');
    await fs.mkdir(this.root, { recursive: true });
    this.app = await createApp({
      dataDir: this.dataDir,
      projectRoot: this.projectRoot,
      // No reviewer route is configured on a fresh install either.
      reviewerAdapter: null,
      ...this.options(),
    });
    const app = this.app;
    this.server = await new Promise<Server>((resolve, reject) => {
      const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
      listener.once('error', reject);
    });
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  async close() {
    const app = this.app,
      server = this.server;
    this.app = undefined;
    this.server = undefined;
    if (!server || !app) return;
    try {
      await app.locals.close();
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  }

  async restart() {
    await this.close();
    await this.open();
  }

  async request<T = any>(route: string, method = 'GET', body?: unknown): Promise<Reply<T>> {
    const response = await fetch(`${this.url}/api${route}`, {
      method,
      headers: HEADERS,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    let data: unknown = text;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      // A non-JSON body is kept as text for the failure message.
    }
    return { status: response.status, data: data as T };
  }

  /** A request that must succeed; anything else throws with what Core said. */
  async api<T = any>(route: string, method = 'GET', body?: unknown): Promise<T> {
    const reply = await this.request<T>(route, method, body);
    if (reply.status < 200 || reply.status >= 300)
      throw new Error(`${method} ${route} answered ${reply.status}: ${JSON.stringify(reply.data).slice(0, 400)}`);
    return reply.data;
  }

  /**
   * The Console's event stream (`GET /api/events`), read the way the Console
   * reads it. Returns the events seen so far and a function that stops reading.
   */
  async events(): Promise<{ seen: { event: string; data: any }[]; stop(): void }> {
    const controller = new AbortController();
    const response = await fetch(`${this.url}/api/events`, { signal: controller.signal });
    if (!response.ok || !response.body) throw new Error(`The event stream answered ${response.status}.`);
    const seen: { event: string; data: any }[] = [];
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    void (async () => {
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) return;
          buffer += decoder.decode(value, { stream: true });
          let cut: number;
          while ((cut = buffer.indexOf('\n\n')) >= 0) {
            const frame = buffer.slice(0, cut);
            buffer = buffer.slice(cut + 2);
            const event = /^event: (.*)$/m.exec(frame)?.[1];
            const data = /^data: (.*)$/m.exec(frame)?.[1];
            if (event && data && event !== 'state') seen.push({ event, data: JSON.parse(data) });
          }
        }
      } catch {
        // Stopped.
      }
    })();
    return { seen, stop: () => controller.abort() };
  }
}

/** Poll `read` until `done` holds; a timeout names what never happened. */
export async function until<T>(read: () => Promise<T>, done: (value: T) => boolean, what: string, timeoutMs = 20_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (done(value)) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}.`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
