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
async function defaultOutbound(clientId, register, { requests = 1, concurrent = false, run } = {}) {
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
    // Each request is a separate invocation of the same isolate. A request with no answer in 15 s is an
    // answer with status 0 and the error, so a hang fails the case instead of stalling the run.
    const send = async (extra = {}) => {
      const started = performance.now();
      let timer;
      const bound = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('No answer within 15 s.')), 15_000); });
      try {
        const response = await Promise.race([worker.fetch('http://127.0.0.1/', { method: 'POST',
          body: JSON.stringify({ token: signedFor(clientId), clientId, ...extra }) }), bound]);
        const text = await Promise.race([response.text(), bound]);
        let body; try { body = JSON.parse(text); } catch { body = { text }; }
        return { status: response.status, body, ms: Math.round(performance.now() - started) };
      } catch (error) {
        return { status: 0, error: `${error?.name ?? 'Error'}: ${error?.message ?? error}`, ms: Math.round(performance.now() - started) };
      } finally { clearTimeout(timer); }
    };
    const answers = [];
    if (run) answers.push(...await run(send));
    else if (concurrent) answers.push(...await Promise.all(Array.from({ length: requests }, () => send())));
    else for (let i = 0; i < requests; i++) answers.push(await send());
    const result = { status: answers[0].status, body: answers[0].body, statuses: answers.map((answer) => answer.status),
      answers, trace: [...trace], unmatched: [...unmatched],
      pending: agent.pendingInterceptors().map((value) => `${value.method} ${value.origin}${value.path}`),
      logs: logs.filter((line) => /identity-/.test(line)), runtimeLogs: logs.filter((line) => !/identity-/.test(line)) };
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
// DIO-188: the Worker keeps the customer signing keys per isolate, so they are fetched once and a
// second request reuses them. The session list and the user are still read on every request.
const jwksOnce = 'GET https://api.workos.com/sso/jwks/client_kept_keys anon 200';
const twice = (pool, clientId, delay = 0, keyFetches = 1) => {
  const keys = pool.intercept({ path: `/sso/jwks/${clientId}`, method: 'GET' }).reply(...json({ keys: [fixture.key] })).times(keyFetches);
  if (delay > 0) keys.delay(delay);
  pool.intercept({ path: '/user_management/users/user_runtime/sessions?limit=100', method: 'GET' }).reply(...json({ data: [{ id: 'session_runtime', user_id: 'user_runtime', status: 'active', expires_at: fixture.expiresAt, ended_at: null }], list_metadata: { after: null } })).times(2);
  pool.intercept({ path: '/user_management/users/user_runtime', method: 'GET' }).reply(...json({ id: 'user_runtime', email_verified: true, first_name: 'Fixture' })).times(2);
};
const kept = await defaultOutbound('client_kept_keys', (pool) => twice(pool, 'client_kept_keys'), { requests: 2 });
assert.deepEqual(kept.statuses, [200, 200], 'A second request in the same isolate must verify with the kept signing keys.');
assert.deepEqual(kept.unmatched, []);
assert.equal(kept.trace.filter((line) => line.includes('/sso/jwks/')).length, 1, 'The signing keys must be fetched once per isolate.');
assert.ok(kept.trace.includes(jwksOnce));
assert.equal(kept.trace.filter((line) => line.includes('/sessions?')).length, 2, 'The session list is read on every request.');
assert.deepEqual(kept.pending, []);
// Two requests at once on a cold isolate, the signing keys held 300 ms. Each request fetches with its
// own verifier and waits only on that fetch, so the keys may be fetched once or twice.
const concurrent = await defaultOutbound('client_concurrent_cold', (pool) => twice(pool, 'client_concurrent_cold', 300, 2), { requests: 2, concurrent: true });
assert.deepEqual(concurrent.statuses, [200, 200], 'Two requests at once on a cold isolate must both verify.');
assert.deepEqual(concurrent.unmatched, []);
assert.ok([1, 2].includes(concurrent.trace.filter((line) => line.includes('/sso/jwks/')).length));
// Request A returns at once, its verification never awaited and not held by waitUntil, while its
// signing-key fetch is held 2000 ms. Then request B arrives in the same isolate. workerd cancels what
// A left in flight; with a key fetch shared across requests, B waited on it and had no answer in
// 15 s. B must answer, fetching the signing keys itself. A client abort is not covered: through Wrangler's
// local server it does not cancel the request, which runs on to the end.
const abandoned = await defaultOutbound('client_abandoned_refresh', (pool) => {
  pool.intercept({ path: '/sso/jwks/client_abandoned_refresh', method: 'GET' }).reply(...json({ keys: [fixture.key] })).delay(2000);
  twice(pool, 'client_abandoned_refresh');
}, { run: async (send) => [await send({ abandon: true }), await send()] });
assert.equal(abandoned.answers[0].status, 202, 'Request A returns before its signing-key fetch answers.');
assert.equal(abandoned.answers[1].status, 200, `A request after an abandoned signing-key fetch must verify: ${JSON.stringify(abandoned.answers[1])}`);
assert.deepEqual(abandoned.unmatched, []);

// DIO-217: POST /ops/routes/:id/checks in workerd, through the Worker's own handler and its own route
// checks transport (workerFetch); only the staff, route and audit stores are memory stand-ins. Every
// provider call leaves through workerd's global fetch and reaches the outbound handler below, which
// answers offline as Bedrock's Chat Completions would for Kimi K3. The second run is answered with a
// redirect, which workerd must hand back to the checks, never follow.
const BEDROCK_CHAT = 'https://bedrock-runtime.us-east-1.amazonaws.com/openai/v1/chat/completions';
function bedrockChatAnswer(body, prefixes, requestId) {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const text = (role) => messages.filter((message) => message.role === role).map((message) => String(message.content ?? '')).join('\n');
  const system = text('system');
  const toolResult = messages.find((message) => message.role === 'tool');
  const offered = (body.tools ?? []).some((tool) => tool?.function?.name === 'lookup_fact');
  const limit = Number(body.max_completion_tokens);
  const prefix = Math.ceil(Buffer.byteLength(system) / 4);
  const cached = prefix >= 1024 && prefixes.has(system) ? Math.floor(prefix / 128) * 128 : 0;
  if (prefix >= 1024) prefixes.add(system);
  const input = Math.max(Math.ceil(Buffer.byteLength(JSON.stringify(body)) / 4), cached);
  const created = Math.floor(Date.now() / 1000);
  const chunk = (delta, finish = null) => ({ id: `chatcmpl-${requestId}`, object: 'chat.completion.chunk', created, model: body.model,
    choices: [{ index: 0, delta, finish_reason: finish, logprobs: null }] });
  const chunks = [chunk({ role: 'assistant', content: '' }), chunk({ reasoning_content: 'Reading the request.' })];
  let output = 18; let reasoning = 14; let finish = 'stop';
  if (toolResult) chunks.push(chunk({ content: JSON.parse(String(toolResult.content)).value }));
  else if (offered) {
    chunks.push(chunk({ tool_calls: [{ index: 0, id: 'functions.lookup_fact:0', type: 'function', function: { name: 'lookup_fact', arguments: '' } }] }));
    chunks.push(chunk({ tool_calls: [{ index: 0, function: { arguments: '{"key":"alpha"}' } }] }));
    output = 26; reasoning = 12; finish = 'tool_calls';
  } else if (text('user').includes('9699690')) {
    chunks.push(chunk({ content: 'The prime factors of 9699690 are 2, 3, 5,' }));
    output = limit; reasoning = limit - 6; finish = 'length';
  } else chunks.push(chunk({ content: 'OK' }));
  chunks.push(chunk({}, finish));
  chunks.push({ id: `chatcmpl-${requestId}`, object: 'chat.completion.chunk', created, model: body.model, choices: [],
    usage: { prompt_tokens: input, completion_tokens: output, total_tokens: input + output,
      prompt_tokens_details: { cached_tokens: cached }, completion_tokens_details: { reasoning_tokens: reasoning } } });
  return [...chunks.map((value) => `data: ${JSON.stringify(value)}\n\n`), 'data: [DONE]\n\n'].join('');
}
async function routeChecksInWorkerd() {
  const requests = []; const logs = []; const prefixes = new Set();
  let mode = 'answer';
  const outboundService = async (request) => {
    const body = await request.text();
    const seen = { mode, method: request.method, url: request.url, bearer: /^Bearer \S+$/.test(request.headers.get('authorization') ?? '') };
    requests.push(seen);
    if (request.method !== 'POST' || request.url !== BEDROCK_CHAT) return new MiniflareResponse('', { status: 404 });
    const requestId = `runtime-${requests.length}`;
    if (mode === 'redirect')
      return new MiniflareResponse('', { status: 302, headers: { location: `${BEDROCK_CHAT}/redirect-target`, 'x-amzn-requestid': requestId } });
    return new MiniflareResponse(bedrockChatAnswer(JSON.parse(body), prefixes, requestId),
      { status: 200, headers: { 'content-type': 'text/event-stream', 'x-amzn-requestid': requestId } });
  };
  const worker = await unstable_startWorker({ config: 'tests/runtime/route-checks.wrangler.jsonc',
    dev: { server: { hostname: '127.0.0.1', port: await port() }, inspector: false, watch: false, persist: false,
      logLevel: 'error', outboundService, structuredLogsHandler: (log) => logs.push(log.message) } });
  try {
    await worker.ready;
    const run = async () => {
      let timer;
      const bound = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('No answer within 30 s.')), 30_000); });
      try {
        const response = await Promise.race([worker.fetch('http://127.0.0.1/ops/routes/aws-kimi-k3/checks', { method: 'POST',
          headers: { authorization: 'Bearer runtime-staff', 'content-type': 'application/json' }, body: JSON.stringify({ baseRevision: 1 }) }), bound]);
        return { status: response.status, ...JSON.parse(await Promise.race([response.text(), bound])) };
      } finally { clearTimeout(timer); }
    };
    const answered = await run();
    mode = 'redirect';
    const redirected = await run();
    const result = { answered, redirected, requests, runtimeLogs: logs };
    console.log(JSON.stringify({ routeChecks: { statuses: [answered.status, answered.body?.receipt ? 'receipt' : answered.body,
      redirected.status], requests, runtimeLogs: logs } }));
    return result;
  } finally { await worker.dispose(); }
}
const routeChecks = await routeChecksInWorkerd();
const checked = (run) => run.body.receipt.checks.map((check) => [check.id, check.outcome]);
assert.equal(routeChecks.answered.status, 200, `The route checks harness must answer: ${JSON.stringify(routeChecks.answered)}`);
assert.equal(routeChecks.answered.body?.receipt?.id?.startsWith('rq_'), true, `The route checks must answer a receipt in workerd: ${JSON.stringify(routeChecks.answered.body)}`);
assert.deepEqual(checked(routeChecks.answered), [['short-answer', 'passed'], ['output-bound', 'passed'], ['tool-round-trip', 'passed'],
  ['cache-default', 'passed'], ['cache-off', 'unsupported']]);
assert.deepEqual(routeChecks.answered.body.qualifies, { ok: true });
assert.equal(routeChecks.answered.body.uncertainMicroUsd, 0);
assert.deepEqual(routeChecks.answered.audits.map((row) => [row.action, row.targetId, row.reason]),
  [['route.checked', 'aws-kimi-k3', routeChecks.answered.body.evidence]]);
assert.equal(routeChecks.answered.keyInAnswer, false, 'The provider key must never reach the answer.');
const firstRun = routeChecks.requests.filter((seen) => seen.mode === 'answer');
assert.equal(firstRun.length, 6, 'One run makes six provider calls through the global fetch.');
assert.ok(firstRun.every((seen) => seen.method === 'POST' && seen.url === BEDROCK_CHAT && seen.bearer));
assert.deepEqual(checked(routeChecks.redirected), [['short-answer', 'failed'], ['output-bound', 'not-run'], ['tool-round-trip', 'not-run'],
  ['cache-default', 'not-run'], ['cache-off', 'unsupported']]);
assert.match(routeChecks.redirected.body.receipt.checks[0].detail, /redirect \(HTTP 302\)/);
assert.deepEqual(routeChecks.requests.filter((seen) => seen.mode === 'redirect').map((seen) => seen.url), [BEDROCK_CHAT],
  'workerd must hand a provider redirect back to the checks, never follow it.');
assert.ok(!routeChecks.runtimeLogs.some((line) => /route-checks-audit-unwritten|Illegal invocation/.test(line)));
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
    signingKeysKeptAcrossRequests: true, concurrentColdRequestsVerified: true, abandonedRequestNotAwaited: true,
    routeChecksEndpointVerified: true, routeChecksProviderRequests: firstRun.length, routeChecksRedirectRefused: true,
    coldWallMs, warmWallP50Ms: walls[49], warmWallP95Ms: walls[94],
    sampledActiveV8MsPerRequest: activeMicroseconds / 1000 / walls.length,
    workersFreeCpuLimitMs: 10,
    qualification: 'Local V8 sample estimate and end-to-end wall timings. Native crypto CPU, production I/O, platform quota enforcement and hosted CPU billing are NOT certified. Provider HTTP is offline fixture; SQL is not exercised.' };
  await writeFile(resolve(output, 'crypto.cpuprofile'), JSON.stringify(profile));
  await writeFile(resolve(output, 'runtime.json'), JSON.stringify(evidence, null, 2) + '\n');
  console.log(JSON.stringify(evidence, null, 2));
} finally { socket?.close(); await benchmark.worker.stop(); }
