/**
 * PH-07 round 4: the reviewer's additions to the owner's rule, pinned in f4ef0b9 by
 * `tests/observability-no-posthog-ai.test.ts`: this integration reaches only `POST <host>/batch/`,
 * never a PostHog AI service. Written by the round 3 and 4 reviewer, who wrote neither the candidate
 * nor its guard.
 *
 * Both groups pass on f4ef0b9. Each closes a gap the round 4 mutations showed in the guard (see
 * `docs/implementation/2026-09-25-posthog-ph07-review-round4.md`):
 *
 *   G1  The guard reads `server/observability/` and `shared/observability.ts` only. A PostHog host,
 *       the capture-key variables, the operator's configured host and key, or a PostHog SDK anywhere
 *       else in the host, the renderer, the desktop shell, the scripts or the account service fails
 *       nothing there. G1 scans all of them.
 *   G2  The guard drives the exporter and the transport, never a turn. A request made on the turn
 *       path (bind, resolve, the projector) with a computed `globalThis['fe' + 'tch']` and a relative
 *       `'flags/?v=2'` passes its static and canary checks and is never executed by it. G2 runs a
 *       Nectovia turn and an AWS turn in `posthog` mode on the production path (no fetch injected)
 *       with the global fetch replaced, and requires every request that leaves the process to be the
 *       one POST to `/batch/`.
 *
 * Nothing here reaches PostHog, AWS or any other host. The global fetch passes only the test's own
 * requests to its local app; everything else is recorded and answered here.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../server/app.js';
import { EngineService } from '../server/engines/service.js';
import { AWS_LUNA_MODEL } from '../server/engines/aws-bedrock.js';
import { testOnlySecretBox } from '../server/connection-secrets.js';
import { ControlPlaneClient } from '../server/accounts/client.js';
import type { AccountBackend } from '../server/accounts/backend.js';
import type { ObservationOptions, ObservationRuntime } from '../server/observability/runtime.js';
import type { PostHogWireEvent } from '../server/observability/wire.js';
import { createFauxCloud, FAUX_BACKEND_LABEL, type FauxCloud } from '../services/control-plane/src/faux/cloud.js';
import { FAUX_DEMO_PASSWORD, seedDemo } from '../services/control-plane/src/faux/seed.js';
import type { Conversation, Project } from '../shared/types.js';
import { responsesEvents, sseResponse } from './fixtures/model-api-streams.js';

const root = fileURLToPath(new URL('..', import.meta.url));

// =================================================================================================
// G1  every other place a PostHog path could come from
// =================================================================================================

/** The host, the renderer, the desktop shell, the scripts and the account service. */
const SCANNED = ['server', 'shared', 'client', 'desktop', 'scripts', 'services/control-plane/src', 'services/control-plane/contract', 'services/control-plane/scripts'];
const SKIPPED = new Set(['node_modules', 'dist', 'build', 'out', 'tmp', 'evidence', 'test-results', 'coverage', '.wrangler']);
const SOURCE = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs|html|json|jsonc)$/;
/** The folder the f4ef0b9 guard already reads, literal by literal. */
const GUARDED = 'server/observability/';

function files(): { file: string; text: string }[] {
  const found: { file: string; text: string }[] = [];
  for (const dir of SCANNED) {
    const absolute = path.join(root, dir);
    if (!fs.existsSync(absolute)) continue;
    for (const entry of fs.readdirSync(absolute, { recursive: true }) as string[]) {
      const relative = `${dir}/${entry.replaceAll('\\', '/')}`;
      if (relative.split('/').some((part) => SKIPPED.has(part)) || !SOURCE.test(relative)) continue;
      const full = path.join(root, relative);
      if (fs.statSync(full).isFile()) found.push({ file: relative, text: fs.readFileSync(full, 'utf8') });
    }
  }
  // The renderer's pages and the root configuration (where a web snippet or a proxy would go).
  for (const entry of fs.readdirSync(root)) {
    if (entry === 'package-lock.json' || !SOURCE.test(entry)) continue;
    const full = path.join(root, entry);
    if (fs.statSync(full).isFile()) found.push({ file: entry, text: fs.readFileSync(full, 'utf8') });
  }
  return found;
}

/**
 * A PostHog host, as a URL or a bare host name. Keyed on the host, never the word: the vendor
 * contract cites `https://github.com/PostHog/posthog.com/...`, which is not a PostHog host.
 */
const POSTHOG_HOST_PATTERN = /https?:\/\/(?:[a-z0-9-]+\.)*posthog\.(?:com|dev)\b|\b(?:app|us|eu|[a-z0-9-]+\.i)\.posthog\.com\b/i;
/** The configured host and key reach a request only through these; elsewhere they need neither a literal nor the environment. */
const POSTHOG_CONFIG_PATTERN = /\bcaptureKey\b|\bposthog\??\.host\b|posthog-transport/;

describe('G1 no PostHog path outside server/observability/, anywhere in the product', () => {
  test('G1a no source outside server/observability/ names a PostHog host', () => {
    const scanned = files();
    expect(scanned.length, 'the tree was read').toBeGreaterThan(500);
    expect(scanned.some((item) => item.file === 'index.html'), 'the renderer page was read').toBe(true);
    const named = scanned
      .filter((item) => !item.file.startsWith(GUARDED) && POSTHOG_HOST_PATTERN.test(item.text))
      .map((item) => `${item.file}: ${item.text.match(POSTHOG_HOST_PATTERN)![0]}`);
    expect(named).toEqual([]);
  });

  test('G1b the capture-key variables and a `phc_` key are read in one place only: eligibility.ts', () => {
    const readers = files()
      .filter((item) => /NECTOVIA_POSTHOG_|\bphc_/.test(item.text))
      .map((item) => item.file);
    expect(readers).toEqual(['server/observability/eligibility.ts']);
  });

  test('G1d the operator’s PostHog host and capture key, and the transport, are used only inside server/observability/', () => {
    const users = files()
      .filter((item) => !item.file.startsWith(GUARDED) && POSTHOG_CONFIG_PATTERN.test(item.text))
      .map((item) => `${item.file}: ${item.text.match(POSTHOG_CONFIG_PATTERN)![0]}`);
    expect(users).toEqual([]);
  });

  test('G1c no PostHog SDK or package is a dependency of the app or the account service', () => {
    const blocks = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'] as const;
    const found: string[] = [];
    for (const manifest of ['package.json', 'services/control-plane/package.json']) {
      const parsed = JSON.parse(fs.readFileSync(path.join(root, manifest), 'utf8')) as Record<string, Record<string, string> | undefined>;
      for (const block of blocks) for (const name of Object.keys(parsed[block] ?? {})) if (/posthog/i.test(name)) found.push(`${manifest}: ${block}.${name}`);
    }
    expect(found).toEqual([]);
  });

  test('G1 is not vacuous: each pattern finds what it is for, and not the vendor contract’s citation', () => {
    for (const planted of [
      "fetch('https://us.i.posthog.com/decide/?v=3')",
      "posthog.init(key, { api_host: 'https://eu.i.posthog.com' })",
      "<script src='https://us-assets.i.posthog.com/static/array.js'></script>",
      "const host = 'app.posthog.com';",
    ])
      expect(POSTHOG_HOST_PATTERN.test(planted), planted).toBe(true);
    expect(POSTHOG_HOST_PATTERN.test("url: 'https://github.com/PostHog/posthog.com/blob/master/contents/docs/ai-observability/start-here.mdx'")).toBe(false);
    expect(POSTHOG_HOST_PATTERN.test("host: 'https://posthog.invalid'")).toBe(false);
    for (const planted of [
      "https.request(`${config.posthog.host}/decide/`)",
      'const host = operator.posthog?.host;',
      'body: JSON.stringify({ api_key: options.captureKey })',
      "import { PostHogTransport } from './observability/posthog-transport.js';",
    ])
      expect(POSTHOG_CONFIG_PATTERN.test(planted), planted).toBe(true);
  });
});

// =================================================================================================
// G2  a turn on the production fetch path
// =================================================================================================

const TIMEOUT = 90_000;
const headers = { 'Content-Type': 'application/json', 'X-Diomedes-Client': '1' };
const SECRET = 'test-only-bedrock-key-0123456789abcdef-never-real';
const ACCOUNT_ID = '123456789012';
const POSTHOG_HOST = 'https://posthog.invalid';
const CAPTURE_KEY = 'phc_testOnlyNotARealKey0';
const USAGE = {
  input_tokens: 100,
  input_tokens_details: { cached_tokens: 0 },
  output_tokens: 10,
  output_tokens_details: { reasoning_tokens: 0 },
  total_tokens: 110,
};

type Item = Record<string, unknown>;
const message = (text: string, id = 'msg'): Item => ({
  type: 'message',
  id,
  role: 'assistant',
  status: 'completed',
  content: [{ type: 'output_text', text, annotations: [] }],
});
function respond(n: number, output: Item[], options: { model?: string; id?: string } = {}) {
  return sseResponse(
    responsesEvents({
      id: options.id ?? `resp_${n}`,
      object: 'response',
      created_at: 1_760_000_000,
      model: options.model ?? AWS_LUNA_MODEL,
      status: 'completed',
      output: output.map((item, index) => ({ ...item, id: `${item.id}_${n}_${index}` })),
      usage: USAGE,
      incomplete_details: null,
      error: null,
    }),
    { 'x-amzn-requestid': `req-${n}` },
  );
}
/** The owner's AWS route. */
let awsCalls = 0;
const aws = (async () => respond(++awsCalls, [message('The order has 100 napkins.')])) as unknown as typeof globalThis.fetch;
/** The provider behind the faux account service's managed gateway (the Nectovia route). */
let gatewayCalls = 0;
const gatewayProvider = (async (_input: RequestInfo | URL, init?: RequestInit) => {
  let model: string = AWS_LUNA_MODEL;
  try {
    model = String((JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as { model?: string }).model ?? AWS_LUNA_MODEL);
  } catch {
    // Only the model is read, to echo it.
  }
  gatewayCalls += 1;
  return respond(gatewayCalls, [message('Twelve loaves are on order.')], { model, id: `resp_gw_${gatewayCalls}` });
}) as typeof globalThis.fetch;

// --- the process's only way out ------------------------------------------------------------------

interface Outbound {
  readonly url: string;
  readonly method: string;
  readonly redirect: RequestRedirect | undefined;
  readonly headers: unknown;
  readonly body: string;
}
const realFetch = globalThis.fetch;
let outbound: Outbound[];
/** The test's own requests to its local app pass; anything else is recorded and answered here. */
const onlyWayOut = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = input instanceof Request ? input.url : String(input);
  if (base && new URL(url).origin === new URL(base).origin) return realFetch(input, init);
  outbound.push({
    url,
    method: String(init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase(),
    redirect: init?.redirect,
    headers: init?.headers,
    body: typeof init?.body === 'string' ? init.body : '',
  });
  return new Response('{"status":1}', { status: 200 });
}) as typeof globalThis.fetch;

// --- the host ------------------------------------------------------------------------------------

let dir: string;
let cloud: FauxCloud;
let orgs: { juniper: string; harbor: string };
let backend: AccountBackend;
let app: Awaited<ReturnType<typeof createApp>> | undefined;
let server: Server | undefined;
let base: string | undefined;

const day = (offsetDays: number) => new Date(Date.now() + offsetDays * 86_400_000).toISOString().slice(0, 10);
/** `posthog` mode as an operator would set it, with no fetch injected: the transport uses the global fetch. */
const production = (internal: string[]): ObservationOptions => ({
  operator: {
    mode: 'posthog',
    environment: 'test',
    companyHost: true,
    internalOrganizations: new Set(internal),
    pseudonymKey: new Uint8Array(32).fill(5),
    customerExport: false,
    posthog: { host: POSTHOG_HOST, captureKey: CAPTURE_KEY, fundedUntil: day(30), dailyEvents: 10_000 },
  },
  timer: false,
  random: () => 0,
});

async function open(observation: ObservationOptions) {
  const engines = new EngineService(path.join(dir, 'engines'), { discover: async () => [] });
  app = await createApp({
    dataDir: path.join(dir, 'data'),
    projectRoot: path.join(dir, 'projects'),
    engineService: engines,
    reviewerAdapter: null,
    secretBox: testOnlySecretBox(),
    modelApiTransport: aws,
    accounts: { backend },
    observation,
  });
  server = await new Promise<Server>((resolve) => {
    const listener = app!.listen(0, '127.0.0.1', () => resolve(listener));
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
async function close() {
  if (!server || !app) return;
  const closing = server;
  server = undefined;
  try {
    await app.locals.close();
  } finally {
    closing.closeAllConnections();
    await new Promise<void>((resolve, reject) => closing.close((error) => (error ? reject(error) : resolve())));
  }
}

const request = (route: string, method = 'GET', body?: unknown) =>
  fetch(`${base}/api${route}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
async function api<T>(route: string, method = 'GET', body?: unknown): Promise<T> {
  const response = await request(route, method, body);
  const text = await response.text();
  expect(response.ok, `${method} ${route}: ${response.status} ${text}`).toBe(true);
  return (text ? JSON.parse(text) : null) as T;
}
interface Target {
  projectId: string;
  threadId: string;
}
const say = (target: Target, commandId: string, text: string) =>
  request(`/projects/${target.projectId}/threads/${target.threadId}/messages`, 'POST', { commandId, text, mode: 'auto', sources: [], consent: true });
async function workingAws(name: string): Promise<Target> {
  const project = await api<Project>('/projects', 'POST', { name });
  const thread = await api<Conversation>(`/projects/${project.id}/threads`, 'POST', {});
  await api(`/projects/${project.id}/threads/${thread.id}`, 'PUT', { engine: 'aws-bedrock' });
  await api(`/projects/${project.id}/cloud-sharing`, 'PUT', {
    expectedVersion: 0,
    routes: ['aws-bedrock'],
    documents: [],
    shareConversationHistory: true,
    shareReviewPackets: false,
  });
  await api('/ai/model-api/aws-bedrock', 'PUT', { accountId: ACCOUNT_ID, region: 'us-east-1', model: AWS_LUNA_MODEL, apiKey: SECRET, expiresAt: null, consent: true });
  await api('/ai/model-api/aws-bedrock/spend-limit', 'PUT', { capUsd: 5, consent: true });
  return { projectId: project.id, threadId: thread.id };
}

beforeEach(async () => {
  dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'diomedes-ph07r4-'));
  outbound = [];
  awsCalls = 0;
  gatewayCalls = 0;
  base = undefined;
  cloud = await createFauxCloud({ file: null, passwordIterations: 1_000, managed: { transport: gatewayProvider } });
  orgs = (await seedDemo(cloud)).organizations!;
  backend = {
    // The account service is reached in process, never through the global fetch.
    client: new ControlPlaneClient('http://faux.local', (req) => cloud.handle(req)),
    view: () => ({ kind: 'faux', label: FAUX_BACKEND_LABEL, url: null, reason: null, signIn: 'password' }),
    close: async () => {},
  };
  vi.stubGlobal('fetch', onlyWayOut);
});
afterEach(async () => {
  try {
    await close();
  } finally {
    vi.unstubAllGlobals();
    await fsp.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

describe('G2 on the production fetch path, a turn reaches POST <host>/batch/ and nothing else', () => {
  test(
    'G2 a Nectovia turn and an AWS turn, bound, projected and exported: every request that leaves the process is the one POST',
    async () => {
      await open(production([orgs.juniper]));
      await api('/account/sign-in', 'POST', { email: 'owner@juniper.test', password: FAUX_DEMO_PASSWORD, remember: false });

      const home = await api<Target>('/home/conversation', 'POST');
      const managed = await say(home, 'r4-g2-home', 'How many loaves are on order?');
      expect(managed.status, await managed.clone().text()).toBe(200);
      const owned = await workingAws('Linen order');
      const byo = await say(owned, 'r4-g2-aws', 'How many napkins are on order?');
      expect(byo.status, await byo.clone().text()).toBe(200);
      expect(gatewayCalls, 'the Nectovia turn reached its provider').toBeGreaterThan(0);
      expect(awsCalls, 'the AWS turn reached its provider').toBeGreaterThan(0);

      const observation = app!.locals.observation as ObservationRuntime | null;
      expect(observation, 'posthog mode constructs the runtime').not.toBeNull();
      await observation!.exporter.flush(10_000);

      expect(outbound.length, 'the transport was reached through the global fetch').toBeGreaterThan(0);
      for (const call of outbound) {
        expect(call.url).toBe(`${POSTHOG_HOST}/batch/`);
        expect(call.method).toBe('POST');
        expect(call.redirect).toBe('error');
        expect(call.headers).toEqual({ 'Content-Type': 'application/json' });
        expect(Object.keys(JSON.parse(call.body) as object)).toEqual(['api_key', 'batch']);
      }
      const events = outbound.flatMap((call) => (JSON.parse(call.body) as { batch: PostHogWireEvent[] }).batch);
      const traces = events.filter((item) => item.event === '$ai_trace');
      expect(traces.length, 'both turns were exported').toBeGreaterThanOrEqual(2);
      expect(new Set(traces.map((item) => item.properties.nectovia_payer)).size, 'one managed and one owner-paid turn').toBe(2);
    },
    TIMEOUT,
  );
});
