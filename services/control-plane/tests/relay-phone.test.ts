/**
 * Relay plan steps 3 and 4 on the hub side: the closed set of frames after
 * `ready`, and the phone's own connection. First the wire contract (what each
 * side may send, the 4,096-byte cap, extra keys, `allowForTask`); then the hub's
 * routing against stand-in sockets (same person only, `from` stamped, offline and
 * other people's computers refused, rate limits, the socket limit, rechecks); the
 * Durable Object host with phones; the same hub against the faux store's records;
 * and last a phone and a desktop over a real loopback socket.
 */
import { generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import http from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFauxCloud, type FauxCloud } from '../src/faux/cloud.js';
import { DEMO_ACCOUNTS, FAUX_DEMO_PASSWORD, seedDemo, type DemoAccount } from '../src/faux/seed.js';
import { startFauxCloud, type RunningFauxCloud } from '../src/faux/server.js';
import { RELAY_GRANT_HEADER, RelayHub, durableObjectHubs, type HubSocket, type RelayHubState } from '../src/relay/durable-object.js';
import {
  RelayHubCore, type DesktopGrant, type HubAuthority, type HubEvent, type HubTransport, type PhoneConnectionState, type PhoneGrant, type PhoneTransport,
} from '../src/relay/hub-core.js';
import {
  RELAY_CLOSE, RELAY_DEVICE_HEADER, RELAY_LIMITS, RELAY_MAX_MESSAGE_BYTES, RELAY_PING_FRAME, RELAY_PONG_FRAME, RELAY_SOURCE_RESERVE_BYTES,
  RELAY_STAMP_RESERVE_BYTES, RELAY_TIMINGS,
  challengePayload, desktopRelayUrl, parseDesktopToPhone, parsePhoneBound, parsePhoneMessage, parseRelayedPhoneMessage, phoneRelayUrl,
  serializeFrame, type RelayRefusalCode,
} from '../src/relay/protocol.js';
import { RelayAuthority } from '../src/relay/service.js';

const START = Date.parse('2026-09-26T12:00:00.000Z');
const AT = '2026-09-26T12:00:00.000Z';
let clock = START;
const now = () => clock;
const quiet = () => {};
const frame = (message: unknown) => JSON.stringify(message);

// --- the wire contract ----------------------------------------------------------------------

const row = {
  rowId: 'session_menu', kind: 'session', label: 'Claude Code', title: 'Draft the winter menu', state: 'working',
  startedAt: AT, verification: 'not-run', payer: 'your-subscription',
};
const workRows = { v: 1, type: 'work.rows', projectId: 'project_menu', rootRunId: null, taskTitle: 'Winter menu', rows: [row], at: AT };
const boardCounts = {
  v: 1, type: 'board.counts', projectId: 'project_menu', columns: [{ name: 'Doing', count: 1 }, { name: 'Done', count: 4 }],
  cards: [{ taskId: 'task_menu', title: 'Draft the winter menu', column: 'Doing', workerLabel: 'Claude Code', payer: 'your-subscription' }],
  page: 1, pages: 1, at: AT,
};
const needSummary = {
  v: 1, type: 'need.summary', needId: 'need_menu', projectId: 'project_menu', taskTitle: 'Winter menu',
  what: 'Save the new menu', why: 'The draft is finished', consequence: 'One document on your computer changes.',
  files: ['menu.md'], expiresAt: '2026-09-26T12:10:00.000Z', part: 1, parts: 1,
};
const turnUpdate = { v: 1, type: 'turn.update', conversation: { kind: 'home' }, turnId: 'command_0001', status: 'running', text: '', seq: 0 };
const result = { v: 1, type: 'result', commandId: 'command_0001', outcome: 'already-done', code: 'already_answered', message: 'Already answered on your computer' };

const DEVICE = 'relay_device_front';
const hello = { v: 1, type: 'hello', deviceId: DEVICE };
const boardPage = { v: 1, type: 'board.page', deviceId: DEVICE, projectId: 'project_menu', page: 2 };
const decision = { v: 1, type: 'need.decision', deviceId: DEVICE, commandId: 'command_0001', needId: 'need_menu', decision: 'go-ahead' };
const stopRun = { v: 1, type: 'stop.request', deviceId: DEVICE, commandId: 'command_0002', projectId: 'project_menu', target: { kind: 'run', runId: 'run_menu' } };
const stopTask = { ...stopRun, commandId: 'command_0003', target: { kind: 'task', taskId: 'task_menu' } };
const send = { v: 1, type: 'message.send', deviceId: DEVICE, commandId: 'command_0004', conversation: { kind: 'project', projectId: 'project_menu' }, text: 'How is the menu going?' };
const wake = { v: 1, type: 'member.wake', deviceId: DEVICE, commandId: 'command_0005', projectId: 'project_menu', slotId: 'slot_writer' };
const stamp = { personId: 'person_owner', sessionId: 'session_phone' };

describe('the wire contract after ready (steps 3 and 4)', () => {
  it('accepts each desktop frame for phones as sent, and each phone command', () => {
    for (const message of [workRows, boardCounts, needSummary, turnUpdate, result])
      expect(parseDesktopToPhone(frame(message))).toEqual(message);
    for (const message of [hello, boardPage, decision, stopRun, stopTask, send, wake, { ...send, conversation: { kind: 'home' } },
      { ...send, conversation: { kind: 'member', projectId: 'project_menu', slotId: 'slot_writer' } }])
      expect(parsePhoneMessage(frame(message))).toEqual(message);
    expect(parsePhoneMessage(RELAY_PING_FRAME)).toEqual({ v: 1, type: 'ping' });
    expect(parsePhoneBound(RELAY_PONG_FRAME)).toEqual({ v: 1, type: 'pong' });
    expect(parsePhoneBound(frame(result))).toEqual(result);
    // A phone reads each with the hub's `source`; a desktop can't send one, and nothing rides inside it.
    for (const message of [workRows, boardCounts, needSummary, turnUpdate, result]) {
      const stamped = { ...message, source: { deviceId: DEVICE } };
      expect(parsePhoneBound(frame(stamped))).toEqual(stamped);
      expect(parseDesktopToPhone(frame(stamped))).toBeNull();
      expect(parsePhoneBound(frame({ ...message, source: { deviceId: DEVICE, personId: 'person_owner' } }))).toBeNull();
      expect(parsePhoneBound(frame({ ...message, source: { deviceId: 'relay device' } }))).toBeNull();
    }
    // A row may carry the provider's quota; nothing else.
    expect(parseDesktopToPhone(frame({ ...workRows, rows: [{ ...row, quota: { window: '5-hour window', remainingPercent: 62 } }] }))).not.toBeNull();
  });

  it('refuses any frame over 4,096 bytes, counted in UTF-8, and will not write one', () => {
    const fits = { ...turnUpdate, text: 'a'.repeat(3_000) };
    expect(parseDesktopToPhone(frame(fits))).toEqual(fits);
    // 3,000 characters, 6,000 bytes.
    const wide = { ...turnUpdate, text: 'é'.repeat(3_000) };
    expect(new TextEncoder().encode(frame(wide)).length).toBeGreaterThan(RELAY_MAX_MESSAGE_BYTES);
    expect(parseDesktopToPhone(frame(wide))).toBeNull();
    expect(serializeFrame(wide)).toBeNull();
    expect(serializeFrame(fits)).toBe(frame(fits));
    // 2,000 characters a phone may send, but not 6,000 bytes of them.
    expect(parsePhoneMessage(frame({ ...send, text: '€'.repeat(2_000) }))).toBeNull();
    expect(parsePhoneMessage(frame({ ...send, text: 'a'.repeat(2_000) }))).not.toBeNull();
  });

  it('refuses extra keys anywhere, unknown types, other versions and binary frames', () => {
    for (const message of [
      { ...workRows, extra: true },
      { ...workRows, rows: [{ ...row, path: 'C:/menus/winter.md' }] },
      { ...boardCounts, cards: [{ ...boardCounts.cards[0], description: 'The whole card' }] },
      { ...needSummary, contents: 'The document itself' },
      { ...turnUpdate, conversation: { kind: 'home', projectId: 'project_menu' } },
      { ...turnUpdate, reasoning: 'Thinking' },
      { ...result, detail: 'more' },
      { ...workRows, v: 2 },
      { v: 1, type: 'files.list', projectId: 'project_menu' },
      { v: 1, type: 'trust.set', projectId: 'project_menu', allow: true },
    ]) expect(parseDesktopToPhone(frame(message))).toBeNull();
    for (const message of [
      { ...hello, extra: true },
      { ...stopRun, target: { kind: 'run', runId: 'run_menu', force: true } },
      { ...send, conversation: { kind: 'member', projectId: 'project_menu' } },
      { ...send, sources: ['menu.md'] },
      { ...wake, consent: true },
      { v: 1, type: 'payer.set', deviceId: DEVICE, payer: 'nectovia-credits' },
      { v: 1, type: 'settings.update', deviceId: DEVICE, commandId: 'command_0009' },
      { v: 1, type: 'http.request', deviceId: DEVICE, path: '/api/trust' },
      workRows,
    ]) expect(parsePhoneMessage(frame(message))).toBeNull();
    expect(parsePhoneMessage(new TextEncoder().encode(frame(hello)))).toBeNull();
    expect(parsePhoneMessage('not json')).toBeNull();
  });

  it('never lets a decision carry allowForTask or a Trust change', () => {
    expect(parsePhoneMessage(frame({ ...decision, allowForTask: true }))).toBeNull();
    expect(parsePhoneMessage(frame({ ...decision, allowForTask: false }))).toBeNull();
    expect(parsePhoneMessage(frame({ ...decision, decision: 'allow-for-task' }))).toBeNull();
    expect(parsePhoneMessage(frame({ ...decision, decision: 'approved' }))).toBeNull();
    expect(parsePhoneMessage(frame({ ...decision, decision: 'declined' }))).not.toBeNull();
  });

  it('caps every list and string the frames carry', () => {
    const tooLong = (n: number) => 'x'.repeat(n);
    for (const message of [
      { ...workRows, rows: Array.from({ length: 9 }, (_, index) => ({ ...row, rowId: `row_${index}` })) },
      { ...workRows, rows: [{ ...row, title: tooLong(81) }] },
      { ...workRows, rows: [{ ...row, label: tooLong(41) }] },
      { ...workRows, rows: [{ ...row, label: '' }] },
      { ...workRows, taskTitle: tooLong(81) },
      { ...workRows, rows: [{ ...row, quota: { window: 'week', remainingPercent: 101 } }] },
      { ...boardCounts, columns: Array.from({ length: 9 }, (_, index) => ({ name: `Column ${index}`, count: 0 })) },
      { ...boardCounts, cards: Array.from({ length: 11 }, () => boardCounts.cards[0]) },
      { ...boardCounts, page: 2, pages: 1 },
      { ...needSummary, what: tooLong(301) },
      { ...needSummary, why: tooLong(301) },
      { ...needSummary, consequence: tooLong(601) },
      { ...needSummary, files: Array.from({ length: 11 }, (_, index) => `menu ${index}.md`) },
      { ...needSummary, files: [tooLong(81)] },
      { ...needSummary, part: 3, parts: 2 },
      { ...turnUpdate, text: tooLong(3_001) },
      { ...turnUpdate, status: 'interrupted' },
      { ...result, message: tooLong(201) },
      { ...result, code: 'not a code' },
      { ...result, outcome: 'maybe' },
    ]) expect(parseDesktopToPhone(frame(message))).toBeNull();
    for (const commandId of ['short_1', tooLong(65), 'command 0001', 'command/0001'])
      expect(parsePhoneMessage(frame({ ...decision, commandId }))).toBeNull();
    for (const text of ['', '   \n ', tooLong(2_001), 'bell\u0007'])
      expect(parsePhoneMessage(frame({ ...send, text }))).toBeNull();
    expect(parsePhoneMessage(frame({ ...send, text: 'Two lines\nare fine' }))).not.toBeNull();
  });

  it('names files in words only: a path or an empty name never crosses', () => {
    for (const files of [['menus/winter.md'], ['C:\\menus\\winter.md'], ['/etc/passwd'], [''], ['  '], ['line\nbreak.md']])
      expect(parseDesktopToPhone(frame({ ...needSummary, files }))).toBeNull();
    expect(parseDesktopToPhone(frame({ ...needSummary, files: ['Winter menu.md', 'prices.xlsx'] }))).not.toBeNull();
  });

  it("checks a phone's own `from` for shape, and requires the hub's on what a desktop reads", () => {
    expect(parsePhoneMessage(frame({ ...decision, from: { personId: 'person_someone', sessionId: 'session_x' } }))).not.toBeNull();
    expect(parsePhoneMessage(frame({ ...decision, from: { personId: 'person_someone', sessionId: 'session_x', role: 'owner' } }))).toBeNull();
    expect(parseRelayedPhoneMessage(frame(decision))).toBeNull();
    expect(parseRelayedPhoneMessage(frame({ ...decision, from: stamp }))).toEqual({ ...decision, from: stamp });
    expect(parseRelayedPhoneMessage(frame({ ...decision, from: stamp, allowForTask: true }))).toBeNull();
  });

  it('dials phones at their own endpoint', () => {
    expect(phoneRelayUrl('https://accounts.diomedes.net/', 'org_juniper')).toBe('wss://accounts.diomedes.net/relay/v1/organizations/org_juniper/phone');
    expect(desktopRelayUrl('http://127.0.0.1:8795', 'org_juniper')).toBe('ws://127.0.0.1:8795/relay/v1/organizations/org_juniper/desktop');
  });
});

// --- the hub's routing, against stand-in sockets -------------------------------------------

function keyPair() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return { publicKey: publicKey.export({ format: 'jwk' }).x!, privateKey };
}

function desktopGrant(publicKey: string, change: Partial<DesktopGrant> = {}): DesktopGrant {
  return {
    organizationId: 'org_juniper', tenantId: 'tenant_juniper', deviceId: DEVICE, personId: 'person_owner',
    publicKey, issuer: 'https://issuer.test', sessionId: 'session_owner',
    authorizedUntil: new Date(START + 15 * 60_000).toISOString(), checkedAt: AT, ...change,
  };
}

function phoneGrant(change: Partial<PhoneGrant> = {}): PhoneGrant {
  return {
    organizationId: 'org_juniper', tenantId: 'tenant_juniper', personId: 'person_owner', issuer: 'https://issuer.test',
    sessionId: 'session_phone', authorizedUntil: new Date(START + 15 * 60_000).toISOString(), checkedAt: AT, ...change,
  };
}

/** A socket as the hub sees one: everything sent, every close and the last saved state. */
function socket<State>() {
  const frames: string[] = [];
  const closes: { code: number; reason: string }[] = [];
  let saved: State | null | undefined;
  const transport = {
    send: (text: string) => { frames.push(text); },
    close: (code: number, reason: string) => { closes.push({ code, reason }); },
    save: (state: State | null) => { saved = state && structuredClone(state); },
  };
  return { transport, frames, closes, saved: () => saved, messages: () => frames.map((text) => JSON.parse(text) as Record<string, unknown>) };
}

/** An authority whose phone answer each test sets. Desktop rechecks always pass here. */
function authority(withPhone = true) {
  const phoneChecks: string[] = [];
  let answer: () => Promise<RelayRefusalCode | null> = async () => null;
  const desktop: HubAuthority = { recheck: async () => null, seen: async () => {} };
  return {
    phoneChecks,
    answer: (next: () => Promise<RelayRefusalCode | null>) => { answer = next; },
    authority: withPhone
      ? { ...desktop, recheckPhone: async (_grant: PhoneGrant, at: string) => { phoneChecks.push(at); return answer(); } } satisfies HubAuthority
      : desktop,
  };
}

/** A proven desktop of `personId`. */
async function desktop(core: RelayHubCore, change: Partial<DesktopGrant> = {}) {
  const key = keyPair();
  const side = socket<unknown>();
  const id = core.open(side.transport as HubTransport, desktopGrant(key.publicKey, change));
  const challenge = side.messages()[0] as { organizationId: string; deviceId: string; nonce: string };
  await core.message(id, frame({ v: 1, type: 'prove', signature: sign(null, challengePayload(challenge), key.privateKey).toString('base64url') }));
  expect(side.messages().at(-1)?.type).toBe('ready');
  side.frames.length = 0;
  return { id, side, privateKey: key.privateKey as KeyObject };
}

function phone(core: RelayHubCore, change: Partial<PhoneGrant> = {}) {
  const side = socket<PhoneConnectionState>();
  const id = core.openPhone(side.transport as PhoneTransport, phoneGrant(change));
  return { id, side };
}

/** Moves the clock in heartbeat steps, every named socket pinging, running what is due as the host's alarm would. */
async function keepAlive(core: RelayHubCore, ms: number, ids: string[]) {
  for (let left = ms; left > 0; left -= RELAY_TIMINGS.recheckMs) {
    clock += Math.min(left, RELAY_TIMINGS.recheckMs);
    for (const id of ids) await core.message(id, RELAY_PING_FRAME);
    await core.tick();
  }
}

describe('the relay hub: phones', () => {
  beforeEach(() => {
    clock = START;
  });

  it('opens a phone at once, sends it nothing until a desktop does, answers its heartbeat, and leaves presence to desktops', async () => {
    const events: HubEvent[] = [];
    const core = new RelayHubCore({ authority: authority().authority, now, record: (event) => events.push(event) });
    const { id, side } = phone(core);
    expect(side.frames).toEqual([]);
    expect(side.saved()).toMatchObject({ v: 1, kind: 'phone', id, grant: { personId: 'person_owner' }, heardAt: START });
    expect(core.has(id)).toBe(true);
    expect(core.phoneCount).toBe(1);
    expect(core.presence()).toEqual(new Set());
    await core.message(id, RELAY_PING_FRAME);
    expect(side.frames).toEqual([RELAY_PONG_FRAME]);
    expect(core.nextDeadline()).toBe(START + RELAY_TIMINGS.recheckMs);
    expect(events).toEqual([{ event: 'relay-phone-opened', organizationId: 'org_juniper', personId: 'person_owner' }]);
  });

  it("passes a command only to the desktop it names, stamping `from` from the phone's sign-in over the phone's own", async () => {
    const core = new RelayHubCore({ authority: authority().authority, now });
    const front = await desktop(core);
    const back = await desktop(core, { deviceId: 'relay_device_back' });
    const mine = phone(core);
    await core.message(mine.id, frame({ ...decision, from: { personId: 'person_manager', sessionId: 'session_forged' } }));
    expect(front.side.messages()).toEqual([{ ...decision, from: stamp }]);
    expect(parseRelayedPhoneMessage(front.side.frames[0])).toEqual({ ...decision, from: stamp });
    expect(back.side.frames).toEqual([]);
    expect(mine.side.frames).toEqual([]);
    await core.message(mine.id, frame({ ...hello, deviceId: 'relay_device_back' }));
    expect(back.side.messages()).toEqual([{ ...hello, deviceId: 'relay_device_back', from: stamp }]);
  });

  it("answers a command for another person's computer or an offline one with a result, and drops what has no command id", async () => {
    const events: HubEvent[] = [];
    const core = new RelayHubCore({ authority: authority().authority, now, record: (event) => events.push(event) });
    const owners = await desktop(core);
    const managers = phone(core, { personId: 'person_manager', sessionId: 'session_manager' });
    await core.message(managers.id, frame(stopRun));
    await core.message(managers.id, frame(hello));
    expect(managers.side.messages()).toEqual([{ v: 1, type: 'result', commandId: 'command_0002', outcome: 'refused', code: 'not_your_device' }]);
    expect(owners.side.frames).toEqual([]);

    const mine = phone(core);
    await core.message(mine.id, frame({ ...send, deviceId: 'relay_device_elsewhere' }));
    await core.message(mine.id, frame({ ...boardPage, deviceId: 'relay_device_elsewhere' }));
    expect(mine.side.messages()).toEqual([{ v: 1, type: 'result', commandId: 'command_0004', outcome: 'refused', code: 'device_offline' }]);

    // A computer that has not proved its key yet is not online.
    const key = keyPair();
    const unproven = socket<unknown>();
    core.open(unproven.transport as HubTransport, desktopGrant(key.publicKey, { deviceId: 'relay_device_new' }));
    await core.message(mine.id, frame({ ...wake, deviceId: 'relay_device_new' }));
    expect(mine.side.messages().at(-1)).toEqual({ v: 1, type: 'result', commandId: 'command_0005', outcome: 'refused', code: 'device_offline' });
    expect(unproven.frames).toHaveLength(1);

    // What the hub records names the type and why, never what the frame said.
    const refused = events.filter((event) => event.event === 'relay-frame-refused');
    expect(refused).toEqual([
      { event: 'relay-frame-refused', organizationId: 'org_juniper', from: 'phone', id: 'person_manager', type: 'stop.request', reason: 'not_your_device' },
      { event: 'relay-frame-refused', organizationId: 'org_juniper', from: 'phone', id: 'person_manager', type: 'hello', reason: 'not_your_device' },
      { event: 'relay-frame-refused', organizationId: 'org_juniper', from: 'phone', id: 'person_owner', type: 'message.send', reason: 'device_offline' },
      { event: 'relay-frame-refused', organizationId: 'org_juniper', from: 'phone', id: 'person_owner', type: 'board.page', reason: 'device_offline' },
      { event: 'relay-frame-refused', organizationId: 'org_juniper', from: 'phone', id: 'person_owner', type: 'member.wake', reason: 'device_offline' },
    ]);
    expect(JSON.stringify(events)).not.toContain(send.text);
  });

  it('sends a desktop frame only to the phones of the person who registered it, and drops anything outside the set', async () => {
    const core = new RelayHubCore({ authority: authority().authority, now });
    const owners = await desktop(core);
    const first = phone(core);
    const second = phone(core, { sessionId: 'session_tablet' });
    const managers = phone(core, { personId: 'person_manager', sessionId: 'session_manager' });
    await core.message(owners.id, frame(workRows));
    await core.message(owners.id, frame(needSummary));
    const source = { deviceId: DEVICE };
    expect(first.side.messages()).toEqual([{ ...workRows, source }, { ...needSummary, source }]);
    expect(second.side.messages()).toEqual([{ ...workRows, source }, { ...needSummary, source }]);
    expect(managers.side.frames).toEqual([]);

    // Unknown types, phone commands and oversize frames go nowhere, and the desktop stays connected.
    await core.message(owners.id, frame({ v: 1, type: 'files.list', projectId: 'project_menu' }));
    await core.message(owners.id, frame(decision));
    await core.message(owners.id, frame({ ...turnUpdate, text: 'é'.repeat(3_000) }));
    expect(first.side.frames).toHaveLength(2);
    expect(owners.side.closes).toEqual([]);

    // A desktop that hasn't proved its key can't send phones anything: it is closed.
    const key = keyPair();
    const unproven = socket<unknown>();
    const unprovenId = core.open(unproven.transport as HubTransport, desktopGrant(key.publicKey, { deviceId: 'relay_device_new' }));
    await core.message(unprovenId, frame(workRows));
    expect(unproven.closes).toEqual([RELAY_CLOSE.protocolError]);
    expect(first.side.frames).toHaveLength(2);
  });

  it("stamps each frame for phones with the computer it came from, never one a desktop names, and only when it fits", async () => {
    const bytes = (text: string) => new TextEncoder().encode(text).length;
    const core = new RelayHubCore({ authority: authority().authority, now });
    const front = await desktop(core);
    const back = await desktop(core, { deviceId: 'relay_device_back' });
    const mine = phone(core);

    // Two of the owner's computers: each frame names the one that sent it.
    await core.message(front.id, frame(needSummary));
    await core.message(back.id, frame({ ...needSummary, needId: 'need_back' }));
    expect(mine.side.messages()).toEqual([
      { ...needSummary, source: { deviceId: DEVICE } },
      { ...needSummary, needId: 'need_back', source: { deviceId: 'relay_device_back' } },
    ]);

    // A desktop that names a computer, its own or another, sends nothing.
    await core.message(back.id, frame({ ...needSummary, source: { deviceId: DEVICE } }));
    await core.message(back.id, frame({ ...needSummary, source: { deviceId: 'relay_device_back' } }));
    expect(mine.side.frames).toHaveLength(2);
    expect(back.side.closes).toEqual([]);

    /** A turn.update frame of exactly `size` bytes. */
    const sized = (size: number) => {
      const room = size - bytes(frame({ ...turnUpdate, text: '' }));
      const text = '€'.repeat(Math.floor(room / 3)) + 'a'.repeat(room % 3);
      const full = frame({ ...turnUpdate, text });
      expect(bytes(full)).toBe(size);
      return full;
    };
    // The longest device id still fits a frame that leaves RELAY_SOURCE_RESERVE_BYTES.
    const longest = `d${'x'.repeat(127)}`;
    const long = await desktop(core, { deviceId: longest });
    await core.message(long.id, sized(RELAY_MAX_MESSAGE_BYTES - RELAY_SOURCE_RESERVE_BYTES));
    const stamped = mine.side.frames.at(-1)!;
    expect(bytes(stamped)).toBeLessThanOrEqual(RELAY_MAX_MESSAGE_BYTES);
    expect((parsePhoneBound(stamped) as { source?: unknown }).source).toEqual({ deviceId: longest });

    // A frame inside the cap that the stamp would push past it goes out as sent, unattributed.
    await core.message(long.id, sized(RELAY_MAX_MESSAGE_BYTES - 20));
    const unstamped = mine.side.frames.at(-1)!;
    expect(mine.side.frames).toHaveLength(4);
    expect(bytes(unstamped)).toBe(RELAY_MAX_MESSAGE_BYTES - 20);
    expect(parsePhoneBound(unstamped)).not.toBeNull();
    expect((parsePhoneBound(unstamped) as { source?: unknown }).source).toBeUndefined();
  });

  it('holds phones to 30 commands a minute per person, answering the rest rate_limited', async () => {
    const core = new RelayHubCore({ authority: authority().authority, now });
    const owners = await desktop(core);
    const first = phone(core);
    const second = phone(core, { sessionId: 'session_tablet' });
    for (let index = 0; index < RELAY_LIMITS.phoneCommandsPerMinute; index++)
      await core.message(index % 2 ? first.id : second.id, frame({ ...decision, commandId: `command_${String(index).padStart(4, '0')}` }));
    expect(owners.side.frames).toHaveLength(30);
    // Both phones are the same person: the 31st is over, from either.
    await core.message(first.id, frame({ ...decision, commandId: 'command_over' }));
    await core.message(second.id, frame(hello));
    expect(first.side.messages()).toEqual([{ v: 1, type: 'result', commandId: 'command_over', outcome: 'refused', code: 'rate_limited' }]);
    expect(second.side.frames).toEqual([]);
    // Heartbeats never count.
    await core.message(first.id, RELAY_PING_FRAME);
    expect(first.side.frames.at(-1)).toBe(RELAY_PONG_FRAME);
    expect(owners.side.frames).toHaveLength(30);

    // A minute on, the person may send again.
    await keepAlive(core, 60_000, [owners.id, first.id, second.id]);
    owners.side.frames.length = 0;
    await core.message(first.id, frame({ ...decision, commandId: 'command_later' }));
    expect(owners.side.messages()).toEqual([{ ...decision, commandId: 'command_later', from: stamp }]);
  });

  it('holds a desktop to 120 frames a minute for phones, dropping the rest', async () => {
    const events: HubEvent[] = [];
    const core = new RelayHubCore({ authority: authority().authority, now, record: (event) => events.push(event) });
    const owners = await desktop(core);
    const mine = phone(core);
    for (let index = 0; index <= RELAY_LIMITS.desktopFramesPerMinute; index++) await core.message(owners.id, frame({ ...turnUpdate, seq: index }));
    expect(mine.side.frames).toHaveLength(120);
    expect(mine.side.messages().at(-1)).toMatchObject({ seq: 119 });
    expect(events.filter((event) => event.event === 'relay-frame-refused')).toEqual([
      { event: 'relay-frame-refused', organizationId: 'org_juniper', from: 'desktop', id: DEVICE, type: 'turn.update', reason: 'rate_limited' },
    ]);
    expect(owners.side.closes).toEqual([]);
  });

  it("refuses a command the hub's stamp would push past the cap, and always passes one within the stamp reserve", async () => {
    const bytes = (text: string) => new TextEncoder().encode(text).length;
    /** A message.send frame of exactly `size` bytes, its text in three-byte and one-byte characters. */
    const sized = (size: number, deviceId: string) => {
      const room = size - bytes(frame({ ...send, deviceId, text: '' }));
      const text = '€'.repeat(Math.floor(room / 3)) + 'a'.repeat(room % 3);
      const full = frame({ ...send, deviceId, text });
      expect(bytes(full)).toBe(size);
      expect(parsePhoneMessage(full)).not.toBeNull();
      return full;
    };
    const core = new RelayHubCore({ authority: authority().authority, now });
    const owners = await desktop(core);
    const mine = phone(core);
    await core.message(mine.id, sized(RELAY_MAX_MESSAGE_BYTES - 6, DEVICE));
    expect(owners.side.frames).toEqual([]);
    expect(mine.side.messages()).toEqual([{ v: 1, type: 'result', commandId: 'command_0004', outcome: 'refused', code: 'too_large' }]);

    // The longest ids an account may have still fit a frame that leaves RELAY_STAMP_RESERVE_BYTES.
    const longest = { personId: `p${'x'.repeat(127)}`, sessionId: `s${'y'.repeat(127)}` };
    const theirs = await desktop(core, { deviceId: 'relay_device_long', personId: longest.personId });
    const long = phone(core, longest);
    await core.message(long.id, sized(RELAY_MAX_MESSAGE_BYTES - RELAY_STAMP_RESERVE_BYTES, 'relay_device_long'));
    expect(long.side.frames).toEqual([]);
    expect(theirs.side.frames).toHaveLength(1);
    expect(bytes(theirs.side.frames[0])).toBeLessThanOrEqual(RELAY_MAX_MESSAGE_BYTES);
    expect(parseRelayedPhoneMessage(theirs.side.frames[0])?.from).toEqual(longest);
  });

  it('keeps at most five phone connections per person, replacing the oldest', async () => {
    const core = new RelayHubCore({ authority: authority().authority, now });
    const managers = phone(core, { personId: 'person_manager', sessionId: 'session_manager' });
    const mine = Array.from({ length: RELAY_LIMITS.phoneSocketsPerPerson + 1 }, (_, index) => phone(core, { sessionId: `session_${index}` }));
    expect(mine[0].side.closes).toEqual([RELAY_CLOSE.replaced]);
    expect(mine[0].side.saved()).toBeNull();
    expect(core.has(mine[0].id)).toBe(false);
    for (const later of mine.slice(1)) expect(later.side.closes).toEqual([]);
    expect(managers.side.closes).toEqual([]);
    expect(core.phoneCount).toBe(6);
  });

  it('rechecks a phone every 20 seconds and ends it when the check refuses', async () => {
    const auth = authority();
    const core = new RelayHubCore({ authority: auth.authority, now });
    const { id, side } = phone(core);
    await keepAlive(core, 40_000, [id]);
    expect(auth.phoneChecks).toEqual(['2026-09-26T12:00:20.000Z', '2026-09-26T12:00:40.000Z']);
    expect(side.closes).toEqual([]);
    auth.answer(async () => 'not_a_member');
    await keepAlive(core, 20_000, [id]);
    expect(side.closes).toEqual([RELAY_CLOSE.notAMember]);
    expect(side.saved()).toBeNull();
    for (const [code, close] of [['phone_relay_not_included', RELAY_CLOSE.notIncluded], ['session_ended', RELAY_CLOSE.sessionEnded]] as const) {
      auth.answer(async () => null);
      // A phone the front has just checked, as each new connection is.
      const next = phone(core, { checkedAt: new Date(clock).toISOString() });
      auth.answer(async () => code);
      await keepAlive(core, 20_000, [next.id]);
      expect(next.side.closes).toEqual([close]);
    }
  });

  it('ends a phone at sign-in expiry, after 60 silent seconds, and when it cannot be checked for 30 seconds', async () => {
    const auth = authority();
    const core = new RelayHubCore({ authority: auth.authority, now });
    const expired = phone(core, { authorizedUntil: new Date(START - 1).toISOString() });
    expect(expired.side.closes).toEqual([RELAY_CLOSE.sessionExpired]);
    expect(core.has(expired.id)).toBe(false);

    const short = phone(core, { authorizedUntil: new Date(START + 10_000).toISOString() });
    expect(core.nextDeadline()).toBe(START + 10_000);
    clock = START + 10_000;
    await core.tick();
    expect(short.side.closes).toEqual([RELAY_CLOSE.sessionExpired]);

    clock = START;
    const silent = phone(core);
    for (const ms of [20_000, 40_000]) {
      clock = START + ms;
      await core.tick();
    }
    expect(silent.side.closes).toEqual([]);
    clock = START + 60_000;
    await core.tick();
    expect(silent.side.closes).toEqual([RELAY_CLOSE.heartbeatTimeout]);

    clock = START;
    auth.answer(async () => { throw new Error('database down'); });
    const unchecked = phone(core);
    await keepAlive(core, 20_000, [unchecked.id]);
    expect(unchecked.side.closes).toEqual([]);
    // Retried after 5 seconds, still failing; the 30-second window closes it.
    clock = START + 25_000;
    await core.tick();
    clock = START + 30_000;
    await core.tick();
    expect(unchecked.side.closes).toEqual([RELAY_CLOSE.recheckUnavailable]);

    // A host without a phone recheck can never vouch past the window.
    clock = START;
    const blind = new RelayHubCore({ authority: authority(false).authority, now });
    const lone = phone(blind);
    await keepAlive(blind, 40_000, [lone.id]);
    expect(lone.side.closes).toEqual([RELAY_CLOSE.recheckUnavailable]);
  });

  it('ends a phone past a deadline when its next frame arrives, before the alarm, passing nothing on and answering no ping', async () => {
    const core = new RelayHubCore({ authority: authority().authority, now });
    // No recheck has run since the front checked this phone, and no alarm has run: 30 seconds on, its window has closed.
    const lapsed = phone(core);
    clock = START + RELAY_TIMINGS.authorityWindowMs;
    // A computer the front has just checked, so only the phone is past its authority.
    const owners = await desktop(core, { checkedAt: new Date(clock).toISOString() });
    await core.message(lapsed.id, frame(decision));
    expect(lapsed.side.closes).toEqual([RELAY_CLOSE.recheckUnavailable]);
    expect(lapsed.side.saved()).toBeNull();
    expect(core.has(lapsed.id)).toBe(false);
    expect(lapsed.side.frames).toEqual([]);
    expect(owners.side.frames).toEqual([]);

    // Past its sign-in, a ping goes unanswered and ends it.
    const expiring = phone(core, { authorizedUntil: new Date(clock + 1_000).toISOString(), checkedAt: new Date(clock).toISOString() });
    clock += 1_000;
    await core.message(expiring.id, RELAY_PING_FRAME);
    expect(expiring.side.closes).toEqual([RELAY_CLOSE.sessionExpired]);
    expect(expiring.side.frames).toEqual([]);

    // Checked, but silent for 60 seconds: the late frame doesn't count as heard first.
    clock = START;
    const quietHub = new RelayHubCore({ authority: authority().authority, now });
    const silent = phone(quietHub);
    for (const ms of [20_000, 40_000]) {
      clock = START + ms;
      await quietHub.tick();
    }
    clock = START + RELAY_TIMINGS.heartbeatTimeoutMs;
    await quietHub.message(silent.id, RELAY_PING_FRAME);
    expect(silent.side.closes).toEqual([RELAY_CLOSE.heartbeatTimeout]);
    expect(silent.side.frames).toEqual([]);
  });

  it('forgets a phone that closed, and stops sending it frames', async () => {
    const events: HubEvent[] = [];
    const core = new RelayHubCore({ authority: authority().authority, now, record: (event) => events.push(event) });
    const owners = await desktop(core);
    const mine = phone(core);
    await core.closed(mine.id, 1000);
    expect(core.has(mine.id)).toBe(false);
    await core.message(owners.id, frame(workRows));
    expect(mine.side.frames).toEqual([]);
    expect(events.at(-1)).toEqual({ event: 'relay-phone-closed', organizationId: 'org_juniper', personId: 'person_owner', code: 1000, reason: 'closed_by_phone' });
  });

  it('never records what a frame said', async () => {
    const events: HubEvent[] = [];
    const core = new RelayHubCore({ authority: authority().authority, now, record: (event) => events.push(event) });
    const owners = await desktop(core);
    const mine = phone(core);
    const strangers = phone(core, { personId: 'person_manager', sessionId: 'session_manager' });
    await core.message(mine.id, frame({ ...send, text: 'The secret recipe is cardamom' }));
    await core.message(strangers.id, frame({ ...send, text: 'Another secret' }));
    await core.message(owners.id, frame({ ...turnUpdate, text: 'Cardamom and orange' }));
    await core.message(owners.id, frame({ ...needSummary, what: 'Save the private ledger' }));
    const text = JSON.stringify(events);
    for (const secret of ['cardamom', 'Cardamom', 'Another secret', 'private ledger', 'session_phone']) expect(text).not.toContain(secret);
  });
});

// --- the Durable Object host, with phones -----------------------------------------------------

class FakeSocket implements HubSocket {
  readyState = 1;
  frames: string[] = [];
  closes: { code?: number; reason?: string }[] = [];
  attachment: unknown = null;
  send(message: string) { this.frames.push(message); }
  close(code?: number, reason?: string) { this.closes.push({ code, reason }); this.readyState = 2; }
  serializeAttachment(value: unknown) { this.attachment = structuredClone(value); }
  deserializeAttachment() { return structuredClone(this.attachment); }
}

function runtime() {
  const accepted: FakeSocket[] = [];
  const alarms: (number | null)[] = [];
  const ctx: RelayHubState = {
    acceptWebSocket: (ws) => { accepted.push(ws as FakeSocket); },
    getWebSockets: () => [...accepted],
    setWebSocketAutoResponse: () => {},
    getWebSocketAutoResponseTimestamp: () => null,
    storage: { setAlarm: async (at) => { alarms.push(at); }, deleteAlarm: async () => { alarms.push(null); } },
  };
  return { ctx, accepted, alarms };
}

class TestHub extends RelayHub {
  protected override upgraded(): Response {
    return new Response(null, { status: 200, headers: { 'x-upgraded': 'yes' } });
  }
}

describe('the RelayHub Durable Object with phones', () => {
  const key = generateKeyPairSync('ed25519');
  const desktopOf = desktopGrant(key.publicKey.export({ format: 'jwk' }).x!);
  const upgrade = (path: string, grant: unknown) => new Request(`https://relay-hub.invalid${path}`, {
    headers: { upgrade: 'websocket', [RELAY_GRANT_HEADER]: JSON.stringify(grant) },
  });
  const proof = (server: FakeSocket) => frame({
    v: 1, type: 'prove', signature: sign(null, challengePayload(JSON.parse(server.frames[0])), key.privateKey).toString('base64url'),
  });

  beforeEach(() => {
    clock = START;
    vi.stubGlobal('WebSocketPair', class {
      0 = new FakeSocket();
      1 = new FakeSocket();
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('takes a phone upgrade, keeps it through hibernation, and routes between it and the desktop after waking', async () => {
    const { ctx, accepted, alarms } = runtime();
    const auth = authority();
    const hub = new TestHub(ctx, {}, { authority: auth.authority, now, record: quiet });
    await hub.fetch(upgrade('/desktop', desktopOf));
    const [desktopServer] = accepted;
    await hub.webSocketMessage(desktopServer, proof(desktopServer));
    const answer = await hub.fetch(upgrade('/phone', phoneGrant()));
    expect(answer.headers.get('x-upgraded')).toBe('yes');
    const phoneServer = accepted[1];
    expect(phoneServer.frames).toEqual([]);
    expect(phoneServer.attachment).toMatchObject({ v: 1, kind: 'phone', grant: { personId: 'person_owner', sessionId: 'session_phone' } });
    expect(alarms.at(-1)).not.toBeNull();

    // Evicted: a new instance over the same sockets.
    const woken = new TestHub(ctx, {}, { authority: auth.authority, now, record: quiet });
    await woken.webSocketMessage(phoneServer, frame(hello));
    expect(JSON.parse(desktopServer.frames.at(-1)!)).toEqual({ ...hello, from: stamp });
    await woken.webSocketMessage(desktopServer, frame(workRows));
    expect(JSON.parse(phoneServer.frames.at(-1)!)).toEqual({ ...workRows, source: { deviceId: DEVICE } });
    expect(await (await woken.fetch(new Request('https://relay-hub.invalid/presence'))).json()).toEqual({ online: [DEVICE] });

    // The phone's recheck runs on the alarm.
    clock = START + RELAY_TIMINGS.recheckMs;
    await woken.webSocketMessage(phoneServer, RELAY_PING_FRAME);
    await woken.webSocketMessage(desktopServer, RELAY_PING_FRAME);
    await woken.alarm();
    expect(auth.phoneChecks).toEqual(['2026-09-26T12:00:20.000Z']);

    await woken.webSocketClose(phoneServer, 1000);
    await woken.webSocketMessage(desktopServer, frame(workRows));
    expect(phoneServer.frames.filter((text) => text !== RELAY_PONG_FRAME)).toHaveLength(1);
  });

  it('ends a phone whose frame arrives after its authority lapsed, before the alarm runs, and passes nothing on', async () => {
    const { ctx, accepted, alarms } = runtime();
    const auth = authority();
    const hub = new TestHub(ctx, {}, { authority: auth.authority, now, record: quiet });
    await hub.fetch(upgrade('/desktop', desktopOf));
    const [desktopServer] = accepted;
    await hub.webSocketMessage(desktopServer, proof(desktopServer));
    await hub.fetch(upgrade('/phone', phoneGrant()));
    const phoneServer = accepted[1];
    // The phone's recheck can't run while the computer's still passes.
    auth.answer(async () => {
      throw new Error('database down');
    });
    clock = START + RELAY_TIMINGS.recheckMs;
    await hub.webSocketMessage(desktopServer, RELAY_PING_FRAME);
    await hub.webSocketMessage(phoneServer, RELAY_PING_FRAME);
    await hub.alarm();
    desktopServer.frames.length = 0;

    // The phone's window closes at 30 seconds; its frame wakes the hub before the alarm does.
    clock = START + RELAY_TIMINGS.authorityWindowMs;
    await hub.webSocketMessage(phoneServer, frame(hello));
    expect(phoneServer.closes).toEqual([RELAY_CLOSE.recheckUnavailable]);
    expect(phoneServer.attachment).toBeNull();
    expect(desktopServer.frames).toEqual([]);
    // What the hub waits for next is the computer's recheck, not the phone's lapsed window.
    expect(alarms.at(-1)).toBe(START + 2 * RELAY_TIMINGS.recheckMs);
  });

  it("refuses a phone upgrade without a phone's grant, and wakes without a phone whose state it can't read", async () => {
    const { ctx, accepted } = runtime();
    const hub = new TestHub(ctx, {}, { authority: authority().authority, now, record: quiet });
    expect((await hub.fetch(new Request('https://relay-hub.invalid/phone'))).status).toBe(426);
    // A desktop's grant is not a phone's: its device and key are keys a phone grant never has.
    expect((await hub.fetch(upgrade('/phone', desktopOf))).status).toBe(400);
    expect((await hub.fetch(upgrade('/phone', { ...phoneGrant(), deviceId: DEVICE }))).status).toBe(400);
    expect(accepted).toEqual([]);

    const stray = new FakeSocket();
    stray.attachment = { v: 1, kind: 'phone', id: 'not-an-id' };
    accepted.push(stray);
    const woken = new TestHub(ctx, {}, { authority: authority().authority, now, record: quiet });
    await woken.fetch(new Request('https://relay-hub.invalid/presence'));
    expect(stray.closes).toEqual([RELAY_CLOSE.recheckUnavailable]);
  });

  it("forwards a phone's upgrade to the business's hub with the grant, never the bearer", async () => {
    const requests: { name: string; request: Request }[] = [];
    const hubs = durableObjectHubs({
      idFromName: (name: string) => ({ name }),
      get: (id: { name: string }) => ({
        fetch: async (input: Request | string, init?: RequestInit) => {
          const request = typeof input === 'string' ? new Request(input, init) : input;
          requests.push({ name: id.name, request });
          return new Response(null, { status: 200 });
        },
      }),
    })!;
    await hubs.connectPhone(phoneGrant(), new Request('https://accounts.diomedes.net/relay/v1/organizations/org_juniper/phone', {
      headers: { authorization: 'Bearer secret-bearer', upgrade: 'websocket', 'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==', [RELAY_GRANT_HEADER]: '{"forged":true}' },
    }));
    expect(requests.map(({ name, request }) => [name, new URL(request.url).pathname])).toEqual([['org_juniper', '/phone']]);
    const dialled = requests[0].request;
    expect(dialled.headers.get('authorization')).toBeNull();
    expect(dialled.headers.get('sec-websocket-key')).toBe('dGhlIHNhbXBsZSBub25jZQ==');
    expect(JSON.parse(dialled.headers.get(RELAY_GRANT_HEADER)!)).toEqual(phoneGrant());
  });
});

// --- the same hub against the faux store's records --------------------------------------------

describe("a phone's connection against the account records", () => {
  let cloud: FauxCloud;
  let organizationId: string;

  async function token(who: DemoAccount) {
    const response = await cloud.handle(new Request('http://127.0.0.1:8795/auth/sign-in', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: DEMO_ACCOUNTS[who].email, password: FAUX_DEMO_PASSWORD }),
    }));
    return ((await response.json()) as { accessToken: string }).accessToken;
  }

  async function connected(who: DemoAccount) {
    const bearer = await token(who);
    const grant = await cloud.relay.authorizePhone(bearer, organizationId);
    const core = new RelayHubCore({ authority: new RelayAuthority(cloud.store.relay), now });
    return { bearer, grant, core, ...phone(core, grant) };
  }

  async function recheck(core: RelayHubCore, id: string) {
    clock += RELAY_TIMINGS.recheckMs;
    await core.message(id, RELAY_PING_FRAME);
    await core.tick();
  }

  beforeEach(async () => {
    clock = START;
    cloud = await createFauxCloud({ file: null, now, passwordIterations: 1_000 });
    organizationId = (await seedDemo(cloud)).organizations!.juniper;
  });

  it('lets any active member open one with their sign-in alone, and keeps it while that holds', async () => {
    for (const who of ['owner', 'manager', 'employee'] as const) {
      const { grant, core, id, side } = await connected(who);
      expect(grant).toMatchObject({ organizationId, authorizedUntil: expect.any(String), checkedAt: AT });
      expect(Object.keys(grant).sort()).toEqual(['authorizedUntil', 'checkedAt', 'issuer', 'organizationId', 'personId', 'sessionId', 'tenantId']);
      await recheck(core, id);
      await recheck(core, id);
      expect(side.closes).toEqual([]);
      clock = START;
    }
    const plain = await cloud.relay.phone(await token('employee'), organizationId, new Request('http://127.0.0.1/relay'));
    expect(plain).toEqual({ organizationId, authorizedUntil: expect.any(String) });
  });

  it('ends it at the next recheck when the person is removed, the plan is withdrawn, or the sign-in is revoked', async () => {
    const removed = await connected('employee');
    await cloud.accounts.setMembership(await token('owner'), organizationId, removed.grant.personId, { role: 'member', state: 'revoked' });
    await recheck(removed.core, removed.id);
    expect(removed.side.closes).toEqual([RELAY_CLOSE.notAMember]);

    clock = START;
    const signedOut = await connected('manager');
    await cloud.accounts.revokeLocalSession(signedOut.bearer);
    await recheck(signedOut.core, signedOut.id);
    expect(signedOut.side.closes).toEqual([RELAY_CLOSE.sessionEnded]);

    clock = START;
    const lapsed = await connected('owner');
    const billing = await token('staffBilling');
    const grants = cloud.store.snapshot().commercial.grants.filter((row) => row.organizationId === organizationId && row.state === 'active');
    for (const grant of grants)
      expect((await cloud.handle(new Request(`http://127.0.0.1:8795/ops/customers/${organizationId}/grants/${grant.id}/revoke`, {
        method: 'POST', headers: { authorization: `Bearer ${billing}`, 'content-type': 'application/json' },
        body: JSON.stringify({ reason: 'Subscription cancelled.' }),
      }))).status).toBe(200);
    await recheck(lapsed.core, lapsed.id);
    expect(lapsed.side.closes).toEqual([RELAY_CLOSE.notIncluded]);
    await expect(cloud.relay.authorizePhone(lapsed.bearer, organizationId)).rejects.toMatchObject({ code: 'phone_relay_not_included' });
  });
});

// --- a phone and a desktop over loopback --------------------------------------------------------

/** Node's WebSocket (undici) takes request headers; the DOM typing does not say so. */
const NodeWebSocket = WebSocket as unknown as new (url: string, init: { headers: Record<string, string> }) => WebSocket;

describe('a phone and a desktop over the loopback relay', () => {
  let running: RunningFauxCloud;
  let organizationId: string;

  function call(method: string, pathname: string, bearer?: string, body?: unknown, headers: Record<string, string> = {}) {
    return new Promise<{ status: number; body: any }>((resolve, reject) => {
      const request = http.request(`${running.url}${pathname}`, {
        method,
        headers: { ...(bearer ? { authorization: `Bearer ${bearer}` } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
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

  function dial(url: string, headers: Record<string, string>) {
    const socket = new NodeWebSocket(url, { headers });
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
      socket, frames, until,
      opened: () => opened,
      closed: () => closed,
      failed: () => failed && !opened,
      frame: async (index: number) => { await until(() => frames.length > index, `frame ${index}`); return JSON.parse(frames[index]); },
    };
  }

  async function desktopOf(who: DemoAccount) {
    const bearer = await token(who);
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const registered = await call('POST', `/relay/v1/organizations/${organizationId}/devices`, bearer,
      { publicKey: publicKey.export({ format: 'jwk' }).x, label: 'Front counter' });
    expect(registered.status).toBe(201);
    const deviceId = registered.body.deviceId as string;
    const desktop = dial(desktopRelayUrl(running.url, organizationId), { authorization: `Bearer ${bearer}`, [RELAY_DEVICE_HEADER]: deviceId });
    const challenge = await desktop.frame(0);
    desktop.socket.send(frame({ v: 1, type: 'prove', signature: sign(null, challengePayload(challenge), privateKey).toString('base64url') }));
    expect(await desktop.frame(1)).toMatchObject({ type: 'ready', deviceId });
    return { bearer, deviceId, desktop };
  }

  async function phoneOf(who: DemoAccount) {
    const bearer = await token(who);
    const side = dial(phoneRelayUrl(running.url, organizationId), { authorization: `Bearer ${bearer}` });
    await side.until(() => side.opened() || side.closed() !== null, 'the phone to open');
    expect(side.opened()).toBe(true);
    return { bearer, side };
  }

  async function personId(bearer: string, role: string) {
    const roster = await call('GET', `/account/organizations/${organizationId}/roster`, bearer);
    return roster.body.people.find((person: { role: string }) => person.role === role).personId as string;
  }

  beforeEach(async () => {
    clock = START;
    running = await startFauxCloud({ file: null, port: 0, seed: true, passwordIterations: 1_000, now: () => clock });
    organizationId = running.seed!.organizations!.juniper;
  });

  afterEach(async () => {
    await running.close();
  });

  it("carries the owner's hello to their computer with `from` stamped, and the computer's rows back to the phone", async () => {
    const { deviceId, desktop, bearer } = await desktopOf('owner');
    const { side } = await phoneOf('owner');
    side.socket.send(frame({ v: 1, type: 'hello', deviceId, from: { personId: 'person_forged', sessionId: 'session_forged' } }));
    const relayed = await desktop.frame(2);
    expect(relayed).toEqual({ v: 1, type: 'hello', deviceId, from: { personId: await personId(bearer, 'owner'), sessionId: expect.any(String) } });
    expect(relayed.from.sessionId).not.toBe('session_forged');
    expect(parseRelayedPhoneMessage(desktop.frames[2])).not.toBeNull();

    desktop.socket.send(frame(workRows));
    expect(await side.frame(0)).toEqual({ ...workRows, source: { deviceId } });
    // A desktop naming a computer itself sends nothing; the next frame the phone reads is the pong.
    desktop.socket.send(frame({ ...workRows, source: { deviceId: 'relay_device_elsewhere' } }));
    side.socket.send(RELAY_PING_FRAME);
    await side.until(() => side.frames.length > 1, 'the pong');
    expect(side.frames[1]).toBe(RELAY_PONG_FRAME);
    // Presence still lists the computer, and only the computer.
    expect((await call('GET', `/relay/v1/organizations/${organizationId}/presence`, bearer)).body.devices).toEqual([
      { deviceId, label: 'Front counter', online: true, lastSeenAt: '2026-09-26T12:00:00.000Z' },
    ]);
  });

  it("refuses an Employee's command for the owner's computer, and answers a plain check without opening anything", async () => {
    const { deviceId, desktop } = await desktopOf('owner');
    const { side, bearer } = await phoneOf('employee');
    side.socket.send(frame({ ...stopTask, deviceId }));
    expect(await side.frame(0)).toEqual({ v: 1, type: 'result', commandId: 'command_0003', outcome: 'refused', code: 'not_your_device' });
    side.socket.send(frame({ ...hello, deviceId }));
    side.socket.send(RELAY_PING_FRAME);
    await side.until(() => side.frames.length > 1, 'the pong');
    expect(side.frames[1]).toBe(RELAY_PONG_FRAME);
    expect(desktop.frames).toHaveLength(2);

    const check = await call('GET', `/relay/v1/organizations/${organizationId}/phone`, bearer);
    expect(check).toEqual({ status: 200, body: { organizationId, authorizedUntil: expect.any(String) } });
  });

  it('refuses the upgrade of a phone whose person was removed, and the plain check says why', async () => {
    const owner = await token('owner');
    const employeeBearer = await token('employee');
    const employee = await personId(owner, 'member');
    expect((await call('PATCH', `/account/organizations/${organizationId}/members/${employee}`, owner, { role: 'member', state: 'revoked' })).status).toBe(200);
    const side = dial(phoneRelayUrl(running.url, organizationId), { authorization: `Bearer ${employeeBearer}` });
    await side.until(() => side.failed() || side.closed() !== null, 'the refusal');
    expect(side.frames).toEqual([]);
    const check = await call('GET', `/relay/v1/organizations/${organizationId}/phone`, employeeBearer);
    expect(check.status).toBe(403);
    expect(check.body.code).toBe('not_a_member');
  });
});
