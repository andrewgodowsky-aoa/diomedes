/**
 * The faux cloud over loopback HTTP, as the desktop reaches it: a managed answer
 * streams as it is produced, a large conversation fits, and a client that
 * leaves mid-stream parks the attempt. Loopback only; nothing leaves the machine.
 */
import http from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEMO_ACCOUNTS, FAUX_DEMO_PASSWORD } from '../src/faux/seed.js';
import { startFauxCloud, type RunningFauxCloud } from '../src/faux/server.js';
import { MANAGED_PROVIDERS, scriptedResponsesFetch } from '../src/managed-providers.js';
import { providerSpy, readAll } from './support/managed.js';

let running: RunningFauxCloud | null = null;
afterEach(async () => {
  await running?.cloud.idle();
  await running?.close();
  running = null;
  vi.unstubAllEnvs();
});

function send(url: string, method: string, headers: Record<string, string>, body?: string) {
  return new Promise<http.IncomingMessage>((resolve, reject) => {
    const request = http.request(url, { method, headers }, resolve);
    request.once('error', reject);
    request.end(body);
  });
}
async function json(response: http.IncomingMessage) {
  const chunks: Buffer[] = [];
  for await (const chunk of response) chunks.push(chunk as Buffer);
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

describe('the faux cloud server and the managed gateway', () => {
  it('streams a managed answer as it is produced, accepts a large body, and parks the attempt when the client leaves', async () => {
    let open!: () => void;
    const gate = new Promise<void>((resolve) => { open = resolve; });
    const scripted = scriptedResponsesFetch();
    const spy = providerSpy(async (request) => {
      const whole = await readAll((await scripted(request.url, { method: 'POST', headers: request.headers, body: request.rawBody })).body);
      const half = Math.floor(whole.byteLength / 2);
      return new Response(new ReadableStream<Uint8Array>({
        async start(controller) {
          controller.enqueue(whole.slice(0, half));
          await gate;
          try { controller.enqueue(whole.slice(half)); controller.close(); } catch { /* cancelled */ }
        },
      }), { status: 200, headers: { 'content-type': 'text/event-stream' } });
    });
    running = await startFauxCloud({ file: null, port: 0, seed: true, passwordIterations: 1_000, managed: { transport: spy.fetch } });
    expect(running.cloud.provider).toBe('scripted');
    const organization = running.seed!.organizations!.juniper;
    const signIn = await json(await send(`${running.url}/auth/sign-in`, 'POST', { 'content-type': 'application/json' },
      JSON.stringify({ email: DEMO_ACCOUNTS.employee.email, password: FAUX_DEMO_PASSWORD })));
    const token = signIn.accessToken as string;
    const admission = await json(await send(`${running.url}/account/organizations/${organization}/agent-admissions`, 'POST',
      { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, JSON.stringify({ surface: 'conversation', routeKind: 'managed' })));

    // 100 KB of instructions: past the 64 KB the account routes accept, well inside the gateway's 2,000,000 bytes.
    const body = JSON.stringify({ model: MANAGED_PROVIDERS[0].model, instructions: 'x'.repeat(100_000), input: [{ role: 'user', content: 'Hello.' }] });
    const response = await send(`${running.url}/managed/v1/responses`, 'POST', {
      authorization: `Bearer ${token}`, 'content-type': 'application/json', 'x-nectovia-organization': organization,
      'x-nectovia-admission': admission.admissionId, 'x-nectovia-job': 'run-1', 'x-nectovia-attempt': 'run-1:1',
      'x-nectovia-tier': 'efficient', 'x-nectovia-usage-class': 'included-chat', 'x-nectovia-policy-revision': '1',
    }, body);
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toMatch(/^text\/event-stream/);
    // The first half arrives while the provider is still holding the second.
    const first = await new Promise<Buffer>((resolve) => response.once('data', resolve));
    expect(first.toString('utf8')).toContain('response.created');
    // The client leaves while the provider is still holding the rest of its answer.
    response.destroy();
    const attempt = () => running!.cloud.store.snapshot().funding.attempts[0];
    for (let waited = 0; attempt().state === 'pending' && waited < 5_000; waited += 20) await new Promise((resolve) => setTimeout(resolve, 20));
    open();
    await running.cloud.idle();
    expect(spy.calls).toHaveLength(1);
    expect(attempt()).toMatchObject({ state: 'uncertain', uncertainReason: expect.stringMatching(/disconnected/) });
  });

  it('reads MANAGED_SPEND_CEILING_MICRO_USD and MANAGED_MAX_OUTPUT_TOKENS from its environment', async () => {
    vi.stubEnv('MANAGED_SPEND_CEILING_MICRO_USD', '0');
    vi.stubEnv('MANAGED_MAX_OUTPUT_TOKENS', '2000');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const spy = providerSpy(() => new Response(null, { status: 500 }));
    running = await startFauxCloud({ file: null, port: 0, seed: true, passwordIterations: 1_000, managed: { transport: spy.fetch } });
    const organization = running.seed!.organizations!.juniper;
    const signIn = await json(await send(`${running.url}/auth/sign-in`, 'POST', { 'content-type': 'application/json' },
      JSON.stringify({ email: DEMO_ACCOUNTS.employee.email, password: FAUX_DEMO_PASSWORD })));
    const token = signIn.accessToken as string;
    const admission = await json(await send(`${running.url}/account/organizations/${organization}/agent-admissions`, 'POST',
      { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, JSON.stringify({ surface: 'conversation', routeKind: 'managed' })));
    const response = await send(`${running.url}/managed/v1/responses`, 'POST', {
      authorization: `Bearer ${token}`, 'content-type': 'application/json', 'x-nectovia-organization': organization,
      'x-nectovia-admission': admission.admissionId, 'x-nectovia-job': 'run-1', 'x-nectovia-attempt': 'run-1:1',
      'x-nectovia-tier': 'efficient', 'x-nectovia-usage-class': 'included-chat', 'x-nectovia-policy-revision': '1',
    }, JSON.stringify({ model: MANAGED_PROVIDERS[0].model, input: [{ role: 'user', content: 'Hello.' }] }));
    expect(response.statusCode).toBe(503);
    expect(response.headers['x-nectovia-max-output']).toBe('2000');
    expect((await json(response)).error.code).toBe('route_unavailable');
    expect(spy.calls).toHaveLength(0);
    warn.mockRestore();
  });
});
