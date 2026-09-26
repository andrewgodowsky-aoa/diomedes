/**
 * The phone relay over a real loopback socket: Node's own WebSocket client
 * dials the faux server, whose upgrade runs the Worker's relay route, and the
 * faux hub answers on the faux cloud's RFC 6455 endpoint. The same protocol a
 * desktop speaks to the Durable Object on Cloudflare.
 */
import { generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import http from 'node:http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEMO_ACCOUNTS, FAUX_DEMO_PASSWORD, type DemoAccount } from '../src/faux/seed.js';
import { startFauxCloud, type RunningFauxCloud } from '../src/faux/server.js';
import { RELAY_CLOSE, RELAY_DEVICE_HEADER, RELAY_PING_FRAME, RELAY_PONG_FRAME, RELAY_TIMINGS, challengePayload, desktopRelayUrl } from '../src/relay/protocol.js';

const START = Date.parse('2026-09-26T12:00:00.000Z');
let clock = START;
let running: RunningFauxCloud;
let organizationId: string;

/** Node's WebSocket (undici) takes request headers; the DOM typing does not say so. */
const NodeWebSocket = WebSocket as unknown as new (url: string, init: { headers: Record<string, string> }) => WebSocket;

/** An HTTP call over loopback. The offline guard stubs fetch, so this goes through node:http. */
function call(method: string, pathname: string, token?: string, body?: unknown, headers: Record<string, string> = {}) {
  return new Promise<{ status: number; body: any }>((resolve, reject) => {
    const request = http.request(`${running.url}${pathname}`, {
      method,
      headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => chunks.push(chunk));
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve({ status: response.statusCode ?? 0, body: text ? JSON.parse(text) : null });
      });
      response.on('error', reject);
    });
    request.once('error', reject);
    request.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

async function token(who: DemoAccount): Promise<string> {
  const answer = await call('POST', '/auth/sign-in', undefined, { email: DEMO_ACCOUNTS[who].email, password: FAUX_DEMO_PASSWORD });
  expect(answer.status).toBe(200);
  return answer.body.accessToken;
}

async function register(who: DemoAccount) {
  const bearer = await token(who);
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const answer = await call('POST', `/relay/v1/organizations/${organizationId}/devices`, bearer,
    { publicKey: publicKey.export({ format: 'jwk' }).x, label: 'Front counter' });
  expect(answer.status).toBe(201);
  return { bearer, deviceId: answer.body.deviceId as string, privateKey };
}

/** A desktop's socket: every frame and the close, kept as they arrive. */
function dial(bearer: string, deviceId: string) {
  const socket = new NodeWebSocket(desktopRelayUrl(running.url, organizationId), {
    headers: { authorization: `Bearer ${bearer}`, [RELAY_DEVICE_HEADER]: deviceId },
  });
  const frames: string[] = [];
  const waiters: (() => void)[] = [];
  let opened = false;
  let failed = false;
  let closed: { code: number; reason: string } | null = null;
  const wake = () => waiters.splice(0).forEach((resolve) => resolve());
  socket.addEventListener('open', () => { opened = true; wake(); });
  socket.addEventListener('message', (event) => { frames.push(String(event.data)); wake(); });
  socket.addEventListener('error', () => { failed = true; wake(); });
  socket.addEventListener('close', (event) => { closed = { code: event.code, reason: event.reason }; wake(); });
  const until = async (done: () => boolean, what: string) => {
    const deadline = Date.now() + 5_000;
    while (!done()) {
      if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}.`);
      await new Promise<void>((resolve) => { waiters.push(resolve); setTimeout(resolve, 50); });
    }
  };
  return {
    socket,
    frames,
    closed: () => closed,
    failed: () => failed && !opened,
    until,
    /** The frame after `count` frames have arrived. */
    frame: async (index: number) => { await until(() => frames.length > index, `frame ${index}`); return JSON.parse(frames[index]); },
  };
}

async function proven(bearer: string, deviceId: string, privateKey: KeyObject) {
  const desktop = dial(bearer, deviceId);
  const challenge = await desktop.frame(0);
  expect(challenge).toMatchObject({ v: 1, type: 'challenge', organizationId, deviceId, expiresInMs: 10_000 });
  const signature = sign(null, challengePayload(challenge), privateKey).toString('base64url');
  desktop.socket.send(JSON.stringify({ v: 1, type: 'prove', signature }));
  expect(await desktop.frame(1)).toMatchObject({ v: 1, type: 'ready', deviceId, heartbeatMs: 20_000, timeoutMs: 60_000 });
  return desktop;
}

const presence = async (bearer: string) => call('GET', `/relay/v1/organizations/${organizationId}/presence`, bearer);

beforeEach(async () => {
  clock = START;
  running = await startFauxCloud({ file: null, port: 0, seed: true, passwordIterations: 1_000, now: () => clock });
  organizationId = running.seed!.organizations!.juniper;
});

afterEach(async () => {
  await running.close();
});

describe('a desktop dialling the relay over loopback', () => {
  it('proves its key, shows online to the phone, answers heartbeats, and is closed at once when stopped', async () => {
    const { bearer, deviceId, privateKey } = await register('owner');
    const employee = await token('employee');
    expect((await presence(employee)).body.devices).toEqual([{ deviceId, label: 'Front counter', online: false, lastSeenAt: null }]);

    const desktop = await proven(bearer, deviceId, privateKey);
    await running.cloud.relayHubs.tickAll();
    const online = await presence(employee);
    expect(online.status).toBe(200);
    expect(online.body).toEqual({ organizationId, checkedAt: '2026-09-26T12:00:00.000Z',
      devices: [{ deviceId, label: 'Front counter', online: true, lastSeenAt: '2026-09-26T12:00:00.000Z' }] });

    desktop.socket.send(RELAY_PING_FRAME);
    await desktop.until(() => desktop.frames.length > 2, 'the pong');
    expect(desktop.frames[2]).toBe(RELAY_PONG_FRAME);

    expect((await call('DELETE', `/relay/v1/organizations/${organizationId}/devices/${deviceId}`, bearer)).status).toBe(204);
    await desktop.until(() => desktop.closed() !== null, 'the close');
    expect(desktop.closed()).toEqual(RELAY_CLOSE.deviceRevoked);
    expect((await presence(employee)).body.devices).toEqual([]);
  });

  it('refuses a bad signature with 4401', async () => {
    const { bearer, deviceId } = await register('owner');
    const desktop = dial(bearer, deviceId);
    const challenge = await desktop.frame(0);
    const forged = sign(null, challengePayload(challenge), generateKeyPairSync('ed25519').privateKey).toString('base64url');
    desktop.socket.send(JSON.stringify({ v: 1, type: 'prove', signature: forged }));
    await desktop.until(() => desktop.closed() !== null, 'the close');
    expect(desktop.closed()).toEqual(RELAY_CLOSE.badSignature);
  });

  it('replaces the older socket when the same computer dials again', async () => {
    const { bearer, deviceId, privateKey } = await register('manager');
    const first = await proven(bearer, deviceId, privateKey);
    const second = await proven(bearer, deviceId, privateKey);
    await first.until(() => first.closed() !== null, 'the older close');
    expect(first.closed()).toEqual(RELAY_CLOSE.replaced);
    expect(second.closed()).toBeNull();
    expect((await presence(bearer)).body.devices.map((row: { online: boolean }) => row.online)).toEqual([true]);
  });

  it('ends a live socket at the next recheck once the owner removes the Manager', async () => {
    const { bearer, deviceId, privateKey } = await register('manager');
    const desktop = await proven(bearer, deviceId, privateKey);
    const owner = await token('owner');
    const manager = (await call('GET', `/account/organizations/${organizationId}/roster`, owner)).body.people
      .find((person: { role: string }) => person.role === 'admin').personId as string;
    expect((await call('PATCH', `/account/organizations/${organizationId}/members/${manager}`, owner, { role: 'admin', state: 'revoked' })).status).toBe(200);
    clock += RELAY_TIMINGS.recheckMs;
    desktop.socket.send(RELAY_PING_FRAME);
    await desktop.until(() => desktop.frames.length > 2, 'the pong');
    await running.cloud.relayHubs.tickAll();
    await desktop.until(() => desktop.closed() !== null, 'the close');
    expect(desktop.closed()).toEqual(RELAY_CLOSE.notAMember);
  });

  it('refuses the upgrade of a desktop that may no longer connect, and the plain check says why', async () => {
    const { bearer, deviceId } = await register('manager');
    const owner = await token('owner');
    const manager = (await call('GET', `/account/organizations/${organizationId}/roster`, owner)).body.people
      .find((person: { role: string }) => person.role === 'admin').personId as string;
    // The owner makes the Manager an Employee: the computer stays registered, but may not connect.
    expect((await call('PATCH', `/account/organizations/${organizationId}/members/${manager}`, owner, { role: 'member', state: 'active' })).status).toBe(200);
    const desktop = dial(bearer, deviceId);
    await desktop.until(() => desktop.failed() || desktop.closed() !== null, 'the refusal');
    expect(desktop.frames).toEqual([]);
    const check = await call('GET', `/relay/v1/organizations/${organizationId}/desktop`, bearer, undefined, { [RELAY_DEVICE_HEADER]: deviceId });
    expect(check).toEqual({ status: 403, body: { code: 'role_not_allowed', error: 'Only the Business owner or a Manager can let a phone reach a computer.' } });

    // Another person's computer, and a computer that was never registered, read as not registered.
    const stranger = await call('GET', `/relay/v1/organizations/${organizationId}/desktop`, owner, undefined, { [RELAY_DEVICE_HEADER]: deviceId });
    expect(stranger.body.code).toBe('device_revoked');
    const unknown = await call('GET', `/relay/v1/organizations/${organizationId}/desktop`, owner, undefined, { [RELAY_DEVICE_HEADER]: 'relay_device_unknown' });
    expect(unknown).toMatchObject({ status: 404, body: { code: 'device_revoked' } });
    expect((await call('GET', `/relay/v1/organizations/${organizationId}/desktop`, owner)).body.code).toBe('device_required');
  });

  it('answers a plain check for a computer that may connect, without opening anything', async () => {
    const { bearer, deviceId } = await register('owner');
    const check = await call('GET', `/relay/v1/organizations/${organizationId}/desktop`, bearer, undefined, { [RELAY_DEVICE_HEADER]: deviceId });
    expect(check.status).toBe(200);
    expect(check.body).toEqual({ organizationId, deviceId, authorizedUntil: '2026-09-26T12:10:00.000Z' });
    expect((await presence(bearer)).body.devices[0].online).toBe(false);
  });

  it('closes relay sockets when the faux server stops', async () => {
    const { bearer, deviceId, privateKey } = await register('owner');
    const desktop = await proven(bearer, deviceId, privateKey);
    await running.close();
    await desktop.until(() => desktop.closed() !== null, 'the close');
    expect(desktop.closed()!.code).toBe(1006);
    running = await startFauxCloud({ file: null, port: 0, seed: true, passwordIterations: 1_000, now: () => clock });
  });
});
