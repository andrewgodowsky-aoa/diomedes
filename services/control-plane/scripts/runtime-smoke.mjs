import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { createServer } from 'node:net';
import { createRequire } from 'node:module';
import { unstable_dev, unstable_startWorker } from 'wrangler';

// Local workerd only. Fixture identity HTTP never contacts WorkOS or PostgreSQL.
// Profile data are V8 samples, NOT Cloudflare's billed per-invocation CPU metric.
process.env.WRANGLER_SEND_METRICS = 'false';
const output = process.env.CP_EVIDENCE_DIRECTORY;
if (!output) throw new Error('Set CP_EVIDENCE_DIRECTORY to an existing evidence directory.');
async function port() {
  const server = createServer();
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  const value = server.address().port;
  await new Promise((done) => server.close(done));
  return value;
}
async function start(script, config, vars = {}) {
  const inspectorPort = await port();
  const worker = await unstable_dev(script, { config, local: true, ip: '127.0.0.1', port: await port(),
    inspectorPort, vars, logLevel: 'error', experimental: { disableExperimentalWarning: true,
      disableDevRegistry: true, forceLocal: true, watch: false, showInteractiveDevSession: false } });
  return { worker, inspectorPort };
}
const env = {
  ENVIRONMENT: 'local', ALLOWED_ORIGINS: 'http://127.0.0.1:8791', WORKOS_CLIENT_ID: 'client_fixture',
  WORKOS_ISSUER: 'https://api.workos.com', WORKOS_TOKEN_AUDIENCE: 'diomedes-control-plane',
  WORKOS_API_KEY: 'sk_test_fixture_only_no_service_calls',
  DATABASE_URL: 'postgresql://cp_runtime:fixture_password@ep-fixture.us-east-2.aws.neon.tech/neondb?sslmode=require',
};
const production = await start('src/worker.ts', 'wrangler.jsonc');
try {
  const response = await production.worker.fetch('/account/session');
  assert.equal(response.status, 503);
  assert.doesNotMatch(await response.text(), /DATABASE_URL|WORKOS_API_KEY/);
} finally { await production.worker.stop(); }
const configured = await start('src/worker.ts', 'wrangler.jsonc', env);
try {
  assert.equal((await configured.worker.fetch('/account/session', { headers: { origin: 'https://evil.example' } })).status, 403);
  assert.equal((await configured.worker.fetch('/account/session')).status, 401);
  assert.equal((await configured.worker.fetch('/account/session', { headers: { authorization: 'Bearer invalid' } })).status, 401);
} finally { await configured.worker.stop(); }

const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
const now = Date.now();
const payload = { iss: 'https://api.workos.com', client_id: 'client_runtime', aud: 'diomedes-control-plane',
  sub: 'user_runtime', sid: 'session_runtime', iat: Math.floor(now / 1000) - 1, exp: Math.floor(now / 1000) + 300 };
const encoded = [{ alg: 'RS256', kid: 'runtime', typ: 'JWT' }, payload].map((value) => Buffer.from(JSON.stringify(value)).toString('base64url')).join('.');
const token = `${encoded}.${sign('RSA-SHA256', Buffer.from(encoded), pair.privateKey).toString('base64url')}`;
const fixture = { token, key: { ...pair.publicKey.export({ format: 'jwk' }), kid: 'runtime', alg: 'RS256', use: 'sig' }, expiresAt: new Date(now + 600_000).toISOString() };

// The verifier's DEFAULT outbound path in workerd. The test Worker passes no fetch,
// so workerd's own fetch checks the call (its this, its redirect mode) before any
// request leaves the isolate. Requests that pass reach the Worker's global outbound,
// which Miniflare binds to the handler below, where an undici MockAgent answers and
// refuses anything unregistered. Wrangler 4.135.0 types dev.mockFetch but never reads
// it, so dev.outboundService carries the interceptor. MockAgent is loaded from the
// undici copy Miniflare itself uses (wrangler -> miniflare -> undici), resolved from
// Miniflare's own location, because undici is not a declared dependency here.
const wranglerRequire = createRequire(createRequire(import.meta.url).resolve('wrangler/package.json'));
const miniflareRequire = createRequire(wranglerRequire.resolve('miniflare'));
const { Response: MiniflareResponse } = wranglerRequire('miniflare');
const { MockAgent, request: dispatchRequest } = miniflareRequire('undici');
const signedFor = (clientId) => {
  const body = [{ alg: 'RS256', kid: 'runtime', typ: 'JWT' }, { ...payload, client_id: clientId }]
    .map((value) => Buffer.from(JSON.stringify(value)).toString('base64url')).join('.');
  return `${body}.${sign('RSA-SHA256', Buffer.from(body), pair.privateKey).toString('base64url')}`;
};
async function defaultOutbound(clientId, register) {
  const agent = new MockAgent();
  agent.disableNetConnect();
  register(agent.get('https://api.workos.com'));
  const trace = []; const unmatched = []; const logs = [];
  const outboundService = async (request) => {
    const headers = {};
    for (const name of ['accept', 'authorization']) if (request.headers.has(name)) headers[name] = request.headers.get(name);
    try {
      // undici.request never follows a redirect, so only workerd could chase a Location.
      const answer = await dispatchRequest(request.url, { dispatcher: agent, method: request.method, headers });
      trace.push(`${request.method} ${request.url} ${headers.authorization ? 'auth' : 'anon'} ${answer.statusCode}`);
      const replyHeaders = Object.entries(answer.headers).flatMap(([name, value]) => (Array.isArray(value) ? value : [value]).map((one) => [name, one]));
      return new MiniflareResponse(await answer.body.arrayBuffer(), { status: answer.statusCode, headers: replyHeaders });
    } catch (error) {
      unmatched.push(`${request.method} ${request.url} ${error?.name ?? 'Error'}`);
      throw error;
    }
  };
  const worker = await unstable_startWorker({ config: 'tests/runtime/default-fetch.wrangler.jsonc',
    dev: { server: { hostname: '127.0.0.1', port: await port() }, inspector: false, watch: false, persist: false,
      logLevel: 'error', outboundService, structuredLogsHandler: (log) => logs.push(log.message) } });
  try {
    await worker.ready;
    const response = await worker.fetch('http://127.0.0.1/', { method: 'POST', body: JSON.stringify({ token: signedFor(clientId), clientId }) });
    const result = { status: response.status, body: await response.json(), trace: [...trace], unmatched: [...unmatched],
      pending: agent.pendingInterceptors().map((value) => `${value.method} ${value.origin}${value.path}`),
      logs: logs.filter((line) => /identity-/.test(line)) };
    console.log(JSON.stringify({ defaultOutbound: clientId, ...result }));
    return result;
  } finally { await worker.dispose(); await agent.close(); }
}
const json = (value) => [200, JSON.stringify(value), { headers: { 'content-type': 'application/json' } }];
const verified = await defaultOutbound('client_default_fetch', (pool) => {
  pool.intercept({ path: '/sso/jwks/client_default_fetch', method: 'GET' }).reply(...json({ keys: [fixture.key] }));
  pool.intercept({ path: '/user_management/users/user_runtime/sessions?limit=100', method: 'GET' }).reply(...json({ data: [{ id: 'session_runtime', user_id: 'user_runtime', status: 'active', expires_at: fixture.expiresAt, ended_at: null }], list_metadata: { after: null } }));
  pool.intercept({ path: '/user_management/users/user_runtime', method: 'GET' }).reply(...json({ id: 'user_runtime', email_verified: true, first_name: 'Fixture' }));
});
assert.equal(verified.status, 200, 'The default outbound path must verify a signed token in workerd.');
assert.equal(verified.body.subject, 'user_runtime');
assert.deepEqual(verified.unmatched, []);
assert.deepEqual([...verified.trace].sort(), [
  'GET https://api.workos.com/sso/jwks/client_default_fetch anon 200',
  'GET https://api.workos.com/user_management/users/user_runtime auth 200',
  'GET https://api.workos.com/user_management/users/user_runtime/sessions?limit=100 auth 200',
]);
assert.deepEqual(verified.pending, []);
const redirected = await defaultOutbound('client_redirect_refused', (pool) => {
  pool.intercept({ path: '/sso/jwks/client_redirect_refused', method: 'GET' }).reply(302, '', { headers: { location: 'https://api.workos.com/sso/jwks/redirect_target' } });
  pool.intercept({ path: '/sso/jwks/redirect_target', method: 'GET' }).reply(...json({ keys: [fixture.key] }));
});
assert.equal(redirected.status, 503, 'A provider redirect must be refused, never followed.');
assert.deepEqual(redirected.unmatched, []);
assert.deepEqual(redirected.trace, ['GET https://api.workos.com/sso/jwks/client_redirect_refused anon 302']);
assert.deepEqual(redirected.pending, ['GET https://api.workos.com/sso/jwks/redirect_target']);
const keyHeld = await defaultOutbound('client_redirect_authenticated', (pool) => {
  pool.intercept({ path: '/sso/jwks/client_redirect_authenticated', method: 'GET' }).reply(...json({ keys: [fixture.key] }));
  pool.intercept({ path: '/user_management/users/user_runtime/sessions?limit=100', method: 'GET' }).reply(302, '', { headers: { location: 'https://api.workos.com/user_management/redirect_target' } });
  pool.intercept({ path: '/user_management/redirect_target', method: 'GET' }).reply(...json({ data: [], list_metadata: { after: null } }));
  pool.intercept({ path: '/user_management/users/user_runtime', method: 'GET' }).reply(...json({ id: 'user_runtime', email_verified: true, first_name: 'Fixture' }));
});
assert.equal(keyHeld.status, 503, 'A redirect on a call that carries the API key must be refused, never followed.');
assert.deepEqual(keyHeld.unmatched, []);
assert.ok(keyHeld.trace.includes('GET https://api.workos.com/user_management/users/user_runtime/sessions?limit=100 auth 302'));
assert.ok(!keyHeld.trace.some((line) => line.includes('redirect_target')));
assert.ok(keyHeld.pending.includes('GET https://api.workos.com/user_management/redirect_target'));
const benchmark = await start('tests/runtime/crypto-worker.ts', 'tests/runtime/wrangler.jsonc');
let socket;
try {
  const pages = await (await fetch(`http://127.0.0.1:${benchmark.inspectorPort}/json/list`)).json();
  const page = pages.find((value) => value.webSocketDebuggerUrl && /crypto-proof/.test(value.title)) ?? pages.find((value) => value.webSocketDebuggerUrl);
  assert.ok(page, 'A local workerd inspector target is required.');
  // Wrangler's inspector requires a loopback Origin when the client sends a
  // User-Agent. Node's WebSocketInit supports headers; browser callers do not.
  socket = new WebSocket(page.webSocketDebuggerUrl, { headers: { Origin: 'http://localhost' } });
  await new Promise((done, reject) => {
    const timeout = setTimeout(() => reject(new Error('Local inspector handshake timed out.')), 5_000);
    socket.addEventListener('open', () => { clearTimeout(timeout); done(); }, { once: true });
    socket.addEventListener('error', () => { clearTimeout(timeout); reject(new Error('Local inspector handshake failed.')); }, { once: true });
  });
  let sequence = 0; const waiting = new Map();
  socket.addEventListener('message', ({ data }) => {
    const message = JSON.parse(String(data));
    const entry = waiting.get(message.id);
    if (entry) { clearTimeout(entry.timeout); waiting.delete(message.id); message.error ? entry.reject(new Error(JSON.stringify(message.error))) : entry.resolve(message.result); }
  });
  const command = (method, params = {}) => new Promise((resolveResult, reject) => {
    const id = ++sequence;
    const timeout = setTimeout(() => { waiting.delete(id); reject(new Error(`Local inspector command timed out: ${method}`)); }, 5_000);
    waiting.set(id, { resolve: resolveResult, reject, timeout }); socket.send(JSON.stringify({ id, method, params }));
  });
  const run = async (data = fixture) => {
    const started = performance.now();
    const response = await benchmark.worker.fetch('/', { method: 'POST', body: JSON.stringify(data) });
    const result = await response.json();
    assert.equal(response.status, 200); assert.equal(result.subject, 'user_runtime'); assert.equal(result.providerRequests, 3);
    return performance.now() - started;
  };
  const coldWallMs = await run();
  for (let i = 0; i < 10; i++) await run();
  await command('Profiler.enable');
  await command('Profiler.setSamplingInterval', { interval: 100 });
  await command('Profiler.start');
  const walls = [];
  for (let i = 0; i < 100; i++) walls.push(await run());
  const { profile } = await command('Profiler.stop');
  const names = new Map(profile.nodes.map((node) => [node.id, node.callFrame.functionName]));
  let activeMicroseconds = 0;
  for (let i = 0; i < (profile.samples?.length ?? 0); i++) {
    if (!['(idle)', '(program)'].includes(names.get(profile.samples[i]))) activeMicroseconds += profile.timeDeltas[i];
  }
  const wrong = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const tampered = `${encoded}.${sign('RSA-SHA256', Buffer.from(encoded), wrong.privateKey).toString('base64url')}`;
  assert.equal((await benchmark.worker.fetch('/', { method: 'POST', body: JSON.stringify({ ...fixture, token: tampered }) })).status, 401);
  walls.sort((a,b) => a-b);
  const evidence = { runtime: 'local workerd via Wrangler 4.135.0', compatibilityDate: '2026-09-19',
    productionEntryAssertions: 4, signatureRequests: 111, tamperedSignatureRefused: true,
    defaultOutboundVerified: true, defaultOutboundRequests: verified.trace.length, defaultOutboundRedirectRefused: true, defaultOutboundKeyNotForwarded: true,
    coldWallMs, warmWallP50Ms: walls[49], warmWallP95Ms: walls[94],
    sampledActiveV8MsPerRequest: activeMicroseconds / 1000 / walls.length,
    workersFreeCpuLimitMs: 10,
    qualification: 'Local V8 sample estimate and end-to-end wall timings. Native crypto CPU, production I/O, platform quota enforcement and hosted CPU billing are NOT certified. Provider HTTP is offline fixture; SQL is not exercised.' };
  await writeFile(resolve(output, 'crypto.cpuprofile'), JSON.stringify(profile));
  await writeFile(resolve(output, 'runtime.json'), JSON.stringify(evidence, null, 2) + '\n');
  console.log(JSON.stringify(evidence, null, 2));
} finally { socket?.close(); await benchmark.worker.stop(); }
