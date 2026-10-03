/**
 * "Reach this computer from your phone", end to end over loopback: the desktop
 * host (createApp) signs in to a faux account service another listener serves,
 * turns the setting on, registers, dials out to the business's relay hub over a
 * real WebSocket, proves its key, and shows online to a phone's presence read.
 * Only the account service's clock is shifted, to reach the hub's recheck.
 * The last part opens a phone's own socket to the same hub and answers its
 * commands with the desktop's real paths (relay plan steps 3 and 4).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import dgram from 'node:dgram';
import fs from 'node:fs/promises';
import type { Server } from 'node:http';
import net, { type AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../server/app';
import type { AccountBackend } from '../server/accounts/backend';
import { ControlPlaneClient } from '../server/accounts/client';
import { testOnlySecretBox } from '../server/connection-secrets';
import { EngineService } from '../server/engines/service';
import { computerLabel, openRelayKey, publicHalf } from '../server/relay/keys';
import { LINK_SENTENCES } from '../server/relay/link';
import { ALREADY_ANSWERED } from '../server/relay/messages';
import { PHONE_RELAY_SENTENCES } from '../server/relay/service';
import { FAUX_BACKEND_LABEL } from '../services/control-plane/src/faux/cloud';
import { DEMO_ACCOUNTS, FAUX_DEMO_PASSWORD, type DemoAccount } from '../services/control-plane/src/faux/seed';
import { startFauxCloud, type RunningFauxCloud } from '../services/control-plane/src/faux/server';
import {
  RELAY_TIMINGS, parsePhoneBound, phoneRelayUrl, type DesktopToPhoneMessage, type ResultMessage,
} from '../services/control-plane/src/relay/protocol';
import { PHONE_RELAY_NOT_INCLUDED_REASON } from '../shared/access';
import type { AccountStateView } from '../shared/accounts';
import type { PhoneRelayView } from '../shared/phone-relay';
import type { ProjectState } from '../shared/types';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const headers = { 'Content-Type': 'application/json', 'X-Diomedes-Client': '1' };

let root: string;
/** How far the account service's clock runs ahead of the desktop's. */
let offset: number;
let running: RunningFauxCloud;
let backend: AccountBackend;
let app: Awaited<ReturnType<typeof createApp>> | null = null;
let server: Server | null = null;
let base: string;
let juniper: string;
let harbor: string;

async function open(accounts: { backend: AccountBackend } | null = { backend }) {
  app = await createApp({
    dataDir: path.join(root, 'data'),
    projectRoot: path.join(root, 'projects'),
    engineService: new EngineService(path.join(root, 'engines'), { discover: async () => [] }),
    reviewerAdapter: null,
    secretBox: testOnlySecretBox(),
    accounts,
  });
  server = await new Promise<Server>((resolve) => {
    const listener = app!.listen(0, '127.0.0.1', () => resolve(listener));
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function close() {
  if (!server || !app) return;
  await app.locals.close();
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server!.close((error) => (error ? reject(error) : resolve())));
  server = null;
  app = null;
}

/** The desktop's own API, as the Console calls it. */
async function desktop<T = any>(method: string, pathname: string, body?: unknown): Promise<{ status: number; body: T }> {
  const response = await fetch(`${base}/api${pathname}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: response.status, body: (await response.json()) as T };
}

const signIn = async (who: DemoAccount, remember = false) =>
  expect((await desktop('POST', '/account/sign-in', { email: DEMO_ACCOUNTS[who].email, password: FAUX_DEMO_PASSWORD, remember })).status).toBe(200);
const view = async (organizationId = juniper) => (await desktop<PhoneRelayView>('GET', `/account/organizations/${organizationId}/phone-relay`)).body;
const turn = (enabled: boolean, organizationId = juniper) =>
  desktop<PhoneRelayView & { error?: string; code?: string }>('PUT', `/account/organizations/${organizationId}/phone-relay`, { enabled });

/** The account service directly, as a phone or another computer reaches it. */
async function service(method: string, pathname: string, token: string | null, body?: unknown) {
  const response = await fetch(`${running.url}${pathname}`, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}
const bearer = async (who: DemoAccount): Promise<string> =>
  (await service('POST', '/auth/sign-in', null, { email: DEMO_ACCOUNTS[who].email, password: FAUX_DEMO_PASSWORD })).body.accessToken;

/** What a phone reads: the business's computers, online or not. */
const phone = async (token: string) =>
  (await service('GET', `/relay/v1/organizations/${juniper}/presence`, token)).body.devices as { deviceId: string; label: string; online: boolean }[];

async function until<T>(read: () => Promise<T>, done: (value: T) => boolean, what: string): Promise<T> {
  const deadline = Date.now() + 5_000;
  for (;;) {
    const value = await read();
    if (done(value)) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}: ${JSON.stringify(value)}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}
const reachable = () => until(() => view(), (current) => current.state === 'reachable', 'the computer to be reachable');

const computersFile = () => path.join(root, 'data', 'relay', 'computers.json');
async function computers(): Promise<{ deviceId: string; sealedKey: string | null; revokePending: boolean }[]> {
  return JSON.parse(await fs.readFile(computersFile(), 'utf8')).computers;
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'phone-relay-desktop-'));
  offset = 0;
  running = await startFauxCloud({ file: null, port: 0, seed: true, passwordIterations: 1_000, now: () => Date.now() + offset });
  juniper = running.seed!.organizations!.juniper;
  harbor = running.seed!.organizations!.harbor;
  backend = {
    client: new ControlPlaneClient(running.url, (request) => fetch(request)),
    view: () => ({ kind: 'faux', label: FAUX_BACKEND_LABEL, url: running.url, reason: null, signIn: 'password' }),
    close: async () => {},
  };
  await open();
});

afterEach(async () => {
  vi.restoreAllMocks();
  await close();
  await running.close();
  await fs.rm(root, { recursive: true, force: true });
});

describe('reaching this computer from a phone', () => {
  it('lets an owner turn it on: the computer registers, dials out, proves its key and shows online; off removes it', async () => {
    await signIn('owner');
    const off = { organizationId: juniper, included: true, enabled: false, canChange: true, label: computerLabel(), state: 'off', sentence: null };
    expect(await view()).toEqual(off);

    const on = await turn(true);
    expect(on.status).toBe(200);
    expect(on.body).toMatchObject({ enabled: true, canChange: true, label: computerLabel() });
    expect(await reachable()).toEqual({ ...off, enabled: true, state: 'reachable' });
    const [entry] = await computers();
    expect(entry).toMatchObject({ organizationId: juniper, deviceId: expect.stringMatching(/^relay_device_/), label: computerLabel(), revokePending: false });
    const employee = await bearer('employee');
    expect(await phone(employee)).toEqual([{ deviceId: entry.deviceId, label: computerLabel(), online: true, lastSeenAt: expect.any(String) }]);

    const stopped = await turn(false);
    expect(stopped).toEqual({ status: 200, body: off });
    // The record is gone at the service and here; the phone no longer lists the computer.
    expect(await phone(employee)).toEqual([]);
    expect(await computers()).toEqual([]);
  });

  it('lets a Manager turn it on; an Employee sees who can; a business without phone access sees why', async () => {
    await signIn('manager');
    expect((await turn(true)).body.enabled).toBe(true);
    await reachable();
    await desktop('POST', '/account/sign-out');

    await signIn('employee');
    expect(await view()).toEqual({
      organizationId: juniper, included: true, enabled: false, canChange: false, label: computerLabel(), state: 'off', sentence: PHONE_RELAY_SENTENCES.role,
    });
    expect(await turn(true)).toEqual({ status: 403, body: { error: PHONE_RELAY_SENTENCES.role, code: 'role_not_allowed' } });
    await desktop('POST', '/account/sign-out');

    await signIn('harborOwner');
    expect(await view(harbor)).toEqual({
      organizationId: harbor, included: false, enabled: false, canChange: false, label: computerLabel(), state: 'off', sentence: PHONE_RELAY_NOT_INCLUDED_REASON,
    });
    expect(await turn(true, harbor)).toEqual({ status: 403, body: { error: PHONE_RELAY_NOT_INCLUDED_REASON, code: 'phone_relay_not_included' } });
    // Another business's setting isn't this person's to read.
    expect(await desktop('GET', `/account/organizations/${juniper}/phone-relay`)).toMatchObject({ status: 404, body: { code: 'not_a_member' } });
    expect(await computers()).toEqual([]);
  });

  it('closes the connection and removes the record when the person signs out', async () => {
    await signIn('owner');
    await turn(true);
    await reachable();
    const employee = await bearer('employee');
    expect((await phone(employee)).map((device) => device.online)).toEqual([true]);
    expect((await desktop('POST', '/account/sign-out')).status).toBe(200);
    expect(await phone(employee)).toEqual([]);
    expect(await computers()).toEqual([]);
    expect(await desktop('GET', `/account/organizations/${juniper}/phone-relay`)).toMatchObject({ status: 401, body: { code: 'sign_in_required' } });
  });

  it("removes the previous person's record when someone else signs in on this computer", async () => {
    await signIn('owner');
    await turn(true);
    await reachable();
    await signIn('manager');
    expect(await phone(await bearer('employee'))).toEqual([]);
    expect(await computers()).toEqual([]);
    expect(await view()).toMatchObject({ enabled: false, state: 'off', sentence: null });
  });

  it('forgets its key when phone access is stopped from another device, and says so once', async () => {
    await signIn('owner');
    await turn(true);
    await reachable();
    const [entry] = await computers();
    // The owner stops it from their phone.
    expect((await service('DELETE', `/relay/v1/organizations/${juniper}/devices/${entry.deviceId}`, await bearer('owner'))).status).toBe(204);
    expect(await until(() => view(), (current) => !current.enabled, 'the stop')).toEqual({
      organizationId: juniper, included: true, enabled: false, canChange: true, label: computerLabel(), state: 'off', sentence: LINK_SENTENCES.stoppedElsewhere,
    });
    await until(computers, (list) => list.length === 0, 'the key to be forgotten');

    // Turning it on again registers this computer afresh.
    await turn(true);
    const [again] = await computers();
    expect(again.deviceId).not.toBe(entry.deviceId);
    expect((await reachable()).sentence).toBeNull();
  });

  it("ends a demoted Manager's connection at the hub's next recheck, keeps the registration, and says why", async () => {
    await signIn('manager');
    await turn(true);
    await reachable();
    const owner = await bearer('owner');
    const roster = await service('GET', `/account/organizations/${juniper}/roster`, owner);
    const manager = roster.body.people.find((person: { role: string }) => person.role === 'admin').personId as string;
    expect((await service('PATCH', `/account/organizations/${juniper}/members/${manager}`, owner, { role: 'member', state: 'active' })).status).toBe(200);
    offset += RELAY_TIMINGS.recheckMs;
    await running.cloud.relayHubs.tickAll();
    expect(await until(() => view(), (current) => current.state === 'error', 'the refusal')).toEqual({
      organizationId: juniper, included: true, enabled: true, canChange: true, label: computerLabel(), state: 'error', sentence: PHONE_RELAY_SENTENCES.role,
    });
    expect(await computers()).toHaveLength(1);
    // Turning it off still removes the record: stopping needs no role.
    expect((await turn(false)).body).toMatchObject({ enabled: false, state: 'off' });
    expect(await computers()).toEqual([]);
  });

  it('dials again with the same record after the app restarts with a kept sign-in', async () => {
    await signIn('owner', true);
    await turn(true);
    await reachable();
    const [entry] = await computers();
    const employee = await bearer('employee');
    await close();
    await until(() => phone(employee), (devices) => devices.length === 1 && !devices[0].online, 'the computer to go offline');
    await open();
    expect(await reachable()).toMatchObject({ enabled: true, state: 'reachable' });
    expect((await computers()).map((item) => item.deviceId)).toEqual([entry.deviceId]);
    expect(await phone(employee)).toEqual([expect.objectContaining({ deviceId: entry.deviceId, online: true })]);
  });

  it('keeps the private key out of every log, answer and file, sealed only by protected storage', async () => {
    const lines: string[] = [];
    for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const)
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
        lines.push(args.map(String).join(' '));
      });
    await signIn('owner');
    const answers = [JSON.stringify((await turn(true)).body), JSON.stringify(await reachable())];
    answers.push(JSON.stringify((await desktop('GET', '/account')).body));
    const text = await fs.readFile(computersFile(), 'utf8');
    const [entry] = JSON.parse(text).computers;
    const privateKey = openRelayKey(testOnlySecretBox(), entry.sealedKey)!;
    const secrets = [privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64'), privateKey.export({ format: 'jwk' }).d!];
    for (const secret of secrets) {
      expect(text).not.toContain(secret);
      for (const answer of answers) expect(answer).not.toContain(secret);
      for (const line of lines) expect(line).not.toContain(secret);
    }
    // No answer carries even the public half.
    for (const answer of answers) expect(answer).not.toContain(publicHalf(privateKey));
    // The file holds what the SecretBox sealed, never the key.
    expect(Buffer.from(entry.sealedKey, 'base64').toString('utf8')).toMatch(/^test-only:/);
    await turn(false);
    const relayLines = lines.filter((line) => line.startsWith('Phone access'));
    expect(relayLines.length).toBeGreaterThan(0);
    for (const line of relayLines) expect(line).toMatch(/^Phone access for relay_device_[0-9a-f-]+: (connecting|reachable|stopped|closed \d+ [a-z_]*)\.$/);
  });

  it('never listens: nothing in its source opens a server, and turning it on and off listens on nothing', async () => {
    const dir = path.join(REPO, 'server', 'relay');
    const names = await fs.readdir(dir);
    expect(names.sort()).toEqual([
      'commands.ts', 'frames.ts', 'keys.ts', 'link.ts', 'messages.ts', 'outbound.ts', 'ports.ts', 'routes.ts', 'service.ts', 'work-rows.ts',
    ]);
    for (const name of names) {
      const source = await fs.readFile(path.join(dir, name), 'utf8');
      for (const pattern of [/\.listen\s*\(/, /\bcreateServer\s*\(/, /\bcreateSocket\s*\(/, /WebSocketServer/, /from ['"]node:(?:net|dgram|http|https|http2|tls)['"]/])
        expect(source, `${name} must not match ${pattern}`).not.toMatch(pattern);
    }
    // The desktop's own loopback server and the test's account service are already listening.
    const listens = vi.spyOn(net.Server.prototype, 'listen');
    const binds = vi.spyOn(dgram.Socket.prototype, 'bind');
    await signIn('owner');
    await turn(true);
    await reachable();
    await turn(false);
    expect(listens).not.toHaveBeenCalled();
    expect(binds).not.toHaveBeenCalled();
  });

  it('is absent when accounts are off', async () => {
    await close();
    await open(null);
    expect((await desktop('GET', `/account/organizations/${juniper}/phone-relay`)).status).toBe(404);
    expect((await desktop('GET', '/account')).body).toMatchObject({ off: true });
  });
});

/** Node's WebSocket (undici) takes request headers; the DOM typing does not say so. */
const NodeWebSocket = WebSocket as unknown as new (url: string, init: { headers: Record<string, string> }) => WebSocket;

/** A phone on the business's relay hub, with its own socket, as the phone app opens it. */
function phoneOn(token: string) {
  const socket = new NodeWebSocket(phoneRelayUrl(running.url, juniper), { headers: { authorization: `Bearer ${token}` } });
  const frames: string[] = [];
  let state: 'connecting' | 'open' | 'closed' = 'connecting';
  socket.addEventListener('open', () => (state = 'open'));
  socket.addEventListener('message', (event) => frames.push(String(event.data)));
  socket.addEventListener('close', () => (state = 'closed'));
  const parsed = () => frames.map((text) => JSON.parse(text) as DesktopToPhoneMessage);
  const results = () => parsed().filter((frame): frame is ResultMessage => frame.type === 'result');
  return {
    socket, frames, parsed, results,
    send: (message: object) => socket.send(JSON.stringify(message)),
    opened: () => until(async () => state, (current) => current !== 'connecting', 'the phone to open'),
    next: async (match: (frame: DesktopToPhoneMessage) => boolean, what: string): Promise<DesktopToPhoneMessage> =>
      (await until(async () => parsed().find(match), (found) => found !== undefined, what))!,
  };
}

describe("a phone's commands on this computer (relay plan steps 3 and 4)", () => {
  it("decides a Need from the owner's phone through the Need answer path, once, and records that it came from the phone", async () => {
    await signIn('owner');
    await turn(true);
    await reachable();
    const [entry] = await computers();
    const ownerId = (await desktop<AccountStateView>('GET', '/account')).body.person!.id;

    // Sample work in a project of this business waits on a decision that names files.
    const project = (await desktop<{ id: string }>('POST', '/projects/sample', {})).body;
    expect((await desktop('POST', `/workspace/organizations/${juniper}/projects`, { projectId: project.id })).status).toBe(200);
    const task = (await desktop<{ id: string }>('POST', `/projects/${project.id}/tasks`, { name: 'Update the menu' })).body;
    expect((await desktop<{ state: string }>('POST', `/projects/${project.id}/work/start`, { taskId: task.id })).body.state).toBe('waiting');
    const projectState = async () => (await desktop<ProjectState>('GET', `/projects/${project.id}/state`)).body;
    const need = (await projectState()).needs.find((item) => item.state === 'open')!;
    expect(need.files.length).toBeGreaterThan(0);

    const phone = phoneOn(await bearer('owner'));
    expect(await phone.opened()).toBe('open');
    phone.send({ v: 1, type: 'hello', deviceId: entry.deviceId });
    const summary = await phone.next((frame) => frame.type === 'need.summary', 'the summary');
    expect(summary).toMatchObject({
      needId: need.id, projectId: project.id, taskTitle: 'Update the menu', what: need.what, why: need.why, consequence: need.consequence, part: 1, parts: 1,
      files: [...new Set(need.files.map((file) => file.split(/[\\/]/).at(-1)))],
    });
    expect(await phone.next((frame) => frame.type === 'board.counts', 'the Board')).toMatchObject({
      projectId: project.id, cards: [{ taskId: task.id, title: 'Update the menu', column: 'Review', workerLabel: 'Sample', payer: 'local' }],
    });
    expect(await phone.next((frame) => frame.type === 'work.rows', 'the worker rows')).toMatchObject({
      projectId: project.id, rows: [expect.objectContaining({ kind: 'session', label: 'Sample', title: 'Update the menu', state: 'waiting', payer: 'local' })],
    });

    const decision = { v: 1, type: 'need.decision', deviceId: entry.deviceId, commandId: 'phone_command_0001', needId: need.id, decision: 'go-ahead' };
    phone.send(decision);
    expect(await phone.next((frame) => frame.type === 'result', 'the answer')).toEqual({
      v: 1, type: 'result', commandId: 'phone_command_0001', outcome: 'accepted',
    });
    const decided = await projectState();
    expect(decided.needs.find((item) => item.id === need.id)).toMatchObject({ state: 'go-ahead', decidedFrom: 'phone', allowForTask: false });
    const recorded = decided.history.filter((item) => item.taskId === task.id && ['decision', 'phone-decision'].includes(item.kind));
    expect(recorded.map((item) => [item.kind, item.sentence])).toEqual([
      ['decision', `You said go ahead: ${need.what}`],
      ['phone-decision', 'You went ahead from your phone'],
    ]);
    expect(recorded[1]).toMatchObject({ approvalId: need.id, origin: { executorId: 'diomedes:phone-relay', producerId: `person:${ownerId}` } });

    // The phone didn't hear the answer and sends the same command again: the same answer, decided once.
    phone.send(decision);
    await until(async () => phone.results().length, (count) => count === 2, 'the repeated answer');
    expect(phone.results()[1]).toEqual(phone.results()[0]);
    // A new command for the same Need: already answered.
    phone.send({ ...decision, commandId: 'phone_command_0002', decision: 'declined' });
    await until(async () => phone.results().length, (count) => count === 3, 'the second answer');
    expect(phone.results()[2]).toEqual({
      v: 1, type: 'result', commandId: 'phone_command_0002', outcome: 'already-done', code: 'already_answered', message: ALREADY_ANSWERED,
    });
    expect((await projectState()).history.filter((item) => item.kind === 'phone-decision')).toHaveLength(1);

    // Every frame is one the contract allows, and none names a folder on this computer.
    for (const text of phone.frames) {
      expect(parsePhoneBound(text)).not.toBeNull();
      expect(text).not.toContain(path.basename(root));
    }
    phone.socket.close();
  });
});
