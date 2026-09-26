/**
 * Serve a faux cloud over loopback HTTP, for the Nectovia desktop app and the
 * Diomedes Operations app to share. Node only; never part of the Worker bundle.
 *
 * One process owns a store file at a time. The lock file names the owner's
 * pid, and a lock whose process is gone is taken over; a live one is refused.
 */
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import { createFauxCloud, FAUX_BACKEND_LABEL, type FauxCloud, type FauxCloudOptions, type FauxIdentityMode } from './cloud.js';
import { seedDemo, type SeedResult } from './seed.js';
import { SPEND_SETTINGS } from '../managed-inference.js';

export const FAUX_CLOUD_PORT = 8795;

/**
 * Where the shared faux store lives when nobody says otherwise. A WorkOS stand-in
 * store is kept apart: its people have WorkOS subjects, so a password store's
 * staff would not be staff there.
 */
export function defaultFauxCloudFile(identity: FauxIdentityMode = 'password'): string {
  const base = process.env.LOCALAPPDATA ?? process.env.XDG_DATA_HOME ?? path.join(os.homedir(), '.local', 'share');
  return path.join(base, 'Diomedes', 'faux-cloud', identity === 'workos-standin' ? 'faux-cloud-workos-standin.json' : 'faux-cloud.json');
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; }
}

/** Stores this process already serves: a second open in one process is refused too. */
const held = new Set<string>();

async function lock(file: string): Promise<() => Promise<void>> {
  const lockFile = `${path.resolve(file)}.lock`;
  if (held.has(lockFile)) throw new Error('This process is already serving this faux cloud store.');
  await fs.mkdir(path.dirname(file), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await fs.writeFile(lockFile, String(process.pid), { flag: 'wx' });
      held.add(lockFile);
      return async () => { held.delete(lockFile); await fs.rm(lockFile, { force: true }); };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const owner = Number(await fs.readFile(lockFile, 'utf8').catch(() => 'NaN'));
      if (Number.isInteger(owner) && owner !== process.pid && alive(owner))
        throw new Error(`Another process (pid ${owner}) is serving this faux cloud store.`);
      await fs.rm(lockFile, { force: true });
    }
  }
  throw new Error('The faux cloud store lock could not be taken.');
}

/** The managed gateway takes up to 2,000,000 bytes and refuses more itself, in its own words. */
const MANAGED_REQUEST_LIMIT = 2_000_000 + 65_536;

async function toRequest(req: http.IncomingMessage, port: number): Promise<Request> {
  const limit = (req.url ?? '').startsWith('/managed/') ? MANAGED_REQUEST_LIMIT : 65_536;
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) throw new RangeError('Request body too large.');
    chunks.push(chunk as Buffer);
  }
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) value.forEach((item) => headers.append(key, item));
    else headers.set(key, value);
  }
  const method = req.method ?? 'GET';
  return new Request(`http://127.0.0.1:${port}${req.url ?? '/'}`, {
    method,
    headers,
    body: ['GET', 'HEAD'].includes(method) || chunks.length === 0 ? undefined : Buffer.concat(chunks),
  });
}

/**
 * Stream a Fetch response to Node as it is produced, so a managed answer
 * arrives token by token, and cancel it when the client leaves, so the gateway
 * sees the disconnect and parks the attempt.
 */
async function pipe(response: Response, res: http.ServerResponse): Promise<void> {
  if (!response.body) { res.end(); return; }
  const reader = response.body.getReader();
  const gone = () => { if (!res.writableFinished) void reader.cancel().catch(() => {}); };
  res.once('close', gone);
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done || res.destroyed) break;
      if (!res.write(value))
        await new Promise<void>((resolve) => { res.once('drain', resolve); res.once('close', resolve); });
    }
    res.end();
  } catch {
    // The stream failed after its headers went out: end the response short, as the Worker would.
    res.destroy();
  } finally {
    res.off('close', gone);
  }
}

export interface RunningFauxCloud {
  cloud: FauxCloud;
  url: string;
  file: string | null;
  seed: SeedResult | null;
  close(): Promise<void>;
}

/**
 * Start a faux cloud listener on loopback. Seeds demo data into an empty store
 * when asked. Managed calls are answered by the scripted provider unless
 * NECTOVIA_FAUX_BEDROCK_API_KEY is set, which calls Bedrock for real and needs
 * Andrew's separate spend approval before it is ever set. The Worker's spend
 * settings, MANAGED_SPEND_CEILING_MICRO_USD and MANAGED_MAX_OUTPUT_TOKENS, are
 * read from the environment under the same names; `managed.settings` wins. A
 * live key without a readable ceiling refuses to start (createFauxCloud).
 * Typed evaluations are answered by the scripted Decisions provider unless
 * NECTOVIA_FAUX_OPENROUTER_API_KEY is set, under the same approval and rule.
 */
export async function startFauxCloud(options: {
  file?: string | null;
  port?: number;
  seed?: boolean;
  allowedOrigins?: readonly string[];
  passwordIterations?: number;
  identity?: FauxIdentityMode;
  managed?: FauxCloudOptions['managed'];
  liveBedrockApiKey?: string | null;
  liveOpenRouterApiKey?: string | null;
}): Promise<RunningFauxCloud> {
  const file = options.file === undefined ? defaultFauxCloudFile(options.identity) : options.file;
  const unlock = file ? await lock(file) : async () => {};
  try {
    const liveBedrockApiKey = options.liveBedrockApiKey !== undefined ? options.liveBedrockApiKey
      : process.env.NECTOVIA_FAUX_BEDROCK_API_KEY?.trim() || null;
    const liveOpenRouterApiKey = options.liveOpenRouterApiKey !== undefined ? options.liveOpenRouterApiKey
      : process.env.NECTOVIA_FAUX_OPENROUTER_API_KEY?.trim() || null;
    const fromEnvironment = Object.fromEntries(SPEND_SETTINGS.filter((name) => process.env[name] !== undefined).map((name) => [name, process.env[name]!]));
    const managed = { ...options.managed, settings: { ...fromEnvironment, ...options.managed?.settings } };
    const cloud = await createFauxCloud({ file, allowedOrigins: options.allowedOrigins, passwordIterations: options.passwordIterations,
      identity: options.identity, managed, liveBedrockApiKey, liveOpenRouterApiKey });
    const seed = options.seed ? await seedDemo(cloud) : null;
    const port = options.port ?? FAUX_CLOUD_PORT;
    const server = http.createServer(async (req, res) => {
      try {
        const response = await cloud.handle(await toRequest(req, port));
        res.statusCode = response.status;
        response.headers.forEach((value, key) => res.setHeader(key, value));
        await pipe(response, res);
      } catch (error) {
        if (res.headersSent) { res.destroy(); return; }
        res.statusCode = error instanceof RangeError ? 413 : 500;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ error: error instanceof RangeError ? 'The request is too large.' : 'The test account service failed.' }));
      }
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', () => { server.off('error', reject); resolve(); });
    });
    const address = server.address();
    const bound = typeof address === 'object' && address ? address.port : port;
    return {
      cloud,
      url: `http://127.0.0.1:${bound}`,
      file,
      seed,
      async close() {
        // Keep-alive clients would hold close() open forever; end them first.
        const closed = new Promise<void>((resolve) => server.close(() => resolve()));
        server.closeAllConnections();
        await closed;
        await unlock();
      },
    };
  } catch (error) {
    await unlock();
    throw error;
  }
}

export { FAUX_BACKEND_LABEL };
