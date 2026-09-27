/**
 * The kept ChatGPT conversation (server/engines/codex-session.ts) over its real port
 * (`codexConversations` in server/integrations.ts) and the fixture app-server
 * (tests/fixtures/codex-app-server.mjs): real child processes speaking the pinned 0.153.4
 * JSON-RPC over stdio. No Codex binary or ChatGPT account is reached.
 */
import { afterEach, beforeEach, expect, test } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createIntegrations, createRpcClient } from '../server/integrations';
import type { TextRequest } from '../server/engines/contract';
import {
  CODEX_ACCOUNT_ROUTE,
  openCodexSession,
  recoverCodexCheckpoint,
  type CodexNativeSession,
  type CodexSessionCheckpoint,
  type CodexSessionOptions,
  type CodexSessionTuning,
} from '../server/engines/codex-session';

const FIXTURE = fileURLToPath(new URL('./fixtures/codex-app-server.mjs', import.meta.url));
let dir: string;
let sessions: CodexNativeSession[];
let saves: CodexSessionCheckpoint[];
/** How many turn/start requests had reached the app-server when each busy checkpoint was saved. */
let startsAtBusySave: number[];
type Call = { pid: number; method: string; params: Record<string, unknown> };
const control = (value: Record<string, unknown>) => fs.writeFile(path.join(dir, 'control.json'), JSON.stringify(value));
const calls = async (): Promise<Call[]> =>
  (await fs.readFile(path.join(dir, 'calls.jsonl'), 'utf8').catch(() => ''))
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Call);
const port = () =>
  createIntegrations({
    platform: 'win32',
    verifySandbox: async () => {},
    turnTimeoutMs: 20_000,
    createClient: async () =>
      createRpcClient(
        spawn(process.execPath, [FIXTURE], {
          env: { PATH: process.env.PATH, CODEX_FIXTURE_DIR: dir },
          stdio: ['pipe', 'pipe', 'pipe'],
          detached: process.platform !== 'win32',
          windowsHide: true,
        }),
      ),
  }).codexConversations;
const request = (overrides: Partial<TextRequest> = {}): TextRequest => ({
  projectId: 'project-1',
  threadId: 'thread-1',
  requestId: `cmd-${Math.random().toString(36).slice(2)}`,
  prompt: 'What is on the lunch menu?',
  documents: [],
  instructions: 'Answer briefly.',
  model: 'fixture-codex-model',
  accountRoute: CODEX_ACCOUNT_ROUTE,
  ...overrides,
});
async function open(
  options: Partial<CodexSessionOptions> = {},
  tuning: Partial<CodexSessionTuning> = {},
  base: Partial<TextRequest> = {},
) {
  const session = await openCodexSession(
    port(),
    request(base),
    {
      observedVersion: '0.153.4',
      onCheckpoint: async (checkpoint) => {
        saves.push(checkpoint);
        if (checkpoint.state === 'busy')
          startsAtBusySave.push((await calls()).filter((call) => call.method === 'turn/start').length);
      },
      ...options,
    },
    tuning,
  );
  sessions.push(session);
  return session;
}
const until = async (check: () => boolean | Promise<boolean>) => {
  for (let i = 0; i < 300 && !(await check()); i++) await new Promise((resolve) => setTimeout(resolve, 10));
  expect(await check()).toBe(true);
};
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const starts = async () => (await calls()).filter((call) => call.method === 'turn/start');

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'diomedes-codex-session-'));
  sessions = [];
  saves = [];
  startsAtBusySave = [];
});
afterEach(async () => {
  for (const session of sessions) await session.close().catch(() => undefined);
  await fs.rm(dir, { recursive: true, force: true });
});

test('a new conversation keeps its thread, saves the thread id before each turn/start, and continues it', async () => {
  const session = await open();
  const first = await session.turn(request());
  const thread = session.checkpoint.nativeSessionId!;
  expect(first.text).toContain(`Fixture answer on ${thread} after 1 user turn.`);
  expect(first.version).toBe('0.153.4');
  expect(session.checkpoint).toMatchObject({
    origin: 'started',
    state: 'idle',
    turns: 1,
    lastStop: null,
    reportedModel: 'fixture-codex-model',
    effort: null,
    parentSessionId: null,
  });
  expect(session.checkpoint.account).toMatch(/^openai:chatgpt:[a-f0-9]{64}$/);
  expect(session.nativeSession).toEqual({ providerId: 'codex', lineageId: session.checkpoint.lineageId, opaqueRef: thread });

  const second = await session.turn(request());
  expect(second.text).toContain(`Fixture answer on ${thread} after 2 user turns.`);
  expect(session.checkpoint).toMatchObject({ origin: 'resumed', turns: 2 });
  // Each busy save named the thread and landed before that turn's turn/start.
  expect(saves.filter((saved) => saved.state === 'busy').map((saved) => saved.nativeSessionId)).toEqual([thread, thread]);
  expect(startsAtBusySave).toEqual([0, 1]);
  // One warm process served both turns.
  expect((await calls()).filter((call) => call.method === 'initialize')).toHaveLength(1);
});

test('thinking reaches the sink, and summaries are asked for only while one listens', async () => {
  await control({ think: 'Weighing the menu.' });
  const session = await open();
  const thinking: string[] = [];
  const answer = await session.turn(request({ onReasoningDelta: (text) => thinking.push(text) }));
  expect(thinking.join('')).toBe('Weighing the menu.');
  expect(answer.text).not.toContain('Weighing');
  await session.turn(request());
  expect((await starts()).map((call) => call.params.summary)).toEqual(['auto', 'none']);
});

test('after a restart the conversation continues its saved thread on a new process', async () => {
  const first = await open();
  await first.turn(request());
  const saved = first.checkpoint;
  await first.close();
  const again = await open({ restore: saved });
  expect((await again.turn(request())).text).toContain(`Fixture answer on ${saved.nativeSessionId} after 2 user turns.`);
  const log = await calls();
  expect(log.filter((call) => call.method === 'thread/resume').map((call) => call.params.threadId)).toEqual([saved.nativeSessionId]);
  expect(new Set(log.filter((call) => call.method === 'initialize').map((call) => call.pid)).size).toBe(2);
  expect(again.continuity).toEqual({ origin: 'resumed', detail: null });
});

test('a thread Codex no longer has starts fresh, and only that message says so', async () => {
  const first = await open();
  await first.turn(request());
  const saved = first.checkpoint;
  await first.close();
  await control({ forget: [saved.nativeSessionId] });
  const again = await open({ restore: saved });
  expect((await again.turn(request())).text).toContain('after 1 user turn.');
  expect(again.checkpoint).toMatchObject({ origin: 'restarted-fresh', lostThreadId: saved.nativeSessionId });
  expect(again.checkpoint.nativeSessionId).not.toBe(saved.nativeSessionId);
  expect(again.continuity.detail).toBe(
    "ChatGPT no longer had this conversation's thread, so this message started a new one. Earlier messages weren't carried into it.",
  );
  await again.turn(request());
  expect(again.continuity.detail).toBeNull();
});

test('Stop on a turn Codex acknowledges interrupts it and keeps the process for the next message', async () => {
  await control({ hold: true, stream: 'Soup is ready' });
  const session = await open();
  const deltas: string[] = [];
  const running = session.turn(request({ onDelta: (text) => deltas.push(text) }));
  await until(() => deltas.length > 0);
  // Watched before the Stop, which rejects the turn while it's awaited.
  const outcome = expect(running).rejects.toMatchObject({ code: 'CANCELLED' });
  expect(await session.stop(3_000)).toBe('interrupted');
  await outcome;
  expect(session.checkpoint).toMatchObject({ state: 'idle', lastStop: 'acknowledged' });
  await control({});
  expect((await session.turn(request())).text).toContain('after 2 user turns.');
  const log = await calls();
  expect(log.filter((call) => call.method === 'turn/interrupt')).toHaveLength(1);
  expect(log.filter((call) => call.method === 'initialize')).toHaveLength(1);
});

test('Stop on a turn Codex never lets go ends the process within the wait, and the thread stays resumable', async () => {
  await control({ hold: true, ignoreInterrupt: true, stream: 'Soup is ready' });
  const session = await open({}, { interruptWaitMs: 300 });
  const deltas: string[] = [];
  const running = session.turn(request({ onDelta: (text) => deltas.push(text) }));
  await until(() => deltas.length > 0);
  const outcome = expect(running).rejects.toMatchObject({ code: 'CANCELLED' });
  const asked = Date.now();
  expect(await session.stop(3_000)).toBe('killed');
  expect(Date.now() - asked).toBeLessThan(2_000);
  await outcome;
  expect(session.checkpoint).toMatchObject({ state: 'idle', lastStop: 'killed' });
  const pid = (await starts())[0].pid;
  await until(() => !alive(pid));
  await control({});
  expect((await session.turn(request())).text).toContain('after 2 user turns.');
});

test('Stop before Codex has answered turn/start ends the process at once: nothing half sent, the thread kept', async () => {
  const session = await open();
  await session.turn(request());
  const thread = session.checkpoint.nativeSessionId;
  await control({ delayTurnStart: 1_000 });
  const running = session.turn(request());
  await until(async () => (await starts()).length === 2);
  const outcome = expect(running).rejects.toMatchObject({ code: 'CANCELLED' });
  expect(await session.stop(3_000)).toBe('killed');
  await outcome;
  expect(session.checkpoint).toMatchObject({ state: 'idle', nativeSessionId: thread, lastStop: 'killed' });
  const log = await calls();
  expect(log.filter((call) => call.method === 'turn/interrupt')).toHaveLength(0);
  await until(() => !alive(log[0].pid));
  await control({});
  // The stopped message never reached the thread: the next one is its second user turn.
  expect((await session.turn(request())).text).toContain(`Fixture answer on ${thread} after 2 user turns.`);
});

test('the idle timer ends the process, and a turn that begins as it fires runs on a new one that resumes the thread', async () => {
  const session = await open({}, { idleMs: 50 });
  await session.turn(request());
  const thread = session.checkpoint.nativeSessionId;
  const first = (await calls())[0].pid;
  await until(() => !alive(first));
  // The driver's check before it records the next turn opens a process; its idle timer fires
  // before the turn begins.
  await session.verify();
  await new Promise((resolve) => setTimeout(resolve, 200));
  expect((await session.turn(request())).text).toContain(`Fixture answer on ${thread} after 2 user turns.`);
  const log = await calls();
  const pids = [...new Set(log.filter((call) => call.method === 'initialize').map((call) => call.pid))];
  expect(pids).toHaveLength(3);
  expect(log.filter((call) => call.pid === pids[1]).map((call) => call.method)).not.toContain('turn/start');
  expect(log.filter((call) => call.pid === pids[2]).map((call) => call.method)).toEqual(
    expect.arrayContaining(['thread/resume', 'turn/start']),
  );
});

test('two conversations at once have their own processes and threads, and a Stop in one leaves the other answering', async () => {
  const a = await open();
  const b = await open({}, {}, { threadId: 'thread-2' });
  await control({ hold: true, stream: 'Soup is ready' });
  const aDeltas: string[] = [];
  const aRunning = a.turn(request({ onDelta: (text) => aDeltas.push(text) }));
  await until(() => aDeltas.length > 0);
  await control({ delayTurnStart: 400 });
  const bRunning = b.turn(request({ threadId: 'thread-2' }));
  await until(async () => (await starts()).length === 2);
  const aOutcome = expect(aRunning).rejects.toMatchObject({ code: 'CANCELLED' });
  expect(await a.stop(3_000)).toBe('interrupted');
  await aOutcome;
  const bAnswer = await bRunning;
  const [aStart, bStart] = await starts();
  expect(aStart.pid).not.toBe(bStart.pid);
  expect(aStart.params.threadId).not.toBe(bStart.params.threadId);
  expect(bAnswer.text).toContain(`Fixture answer on ${b.checkpoint.nativeSessionId} after 1 user turn.`);
  expect((await calls()).filter((call) => call.method === 'turn/interrupt').map((call) => call.pid)).toEqual([aStart.pid]);
  expect(alive(bStart.pid)).toBe(true);
  expect(b.checkpoint.lastStop).toBeNull();
});

test('a runtime that changed since the conversation was saved continues its thread', async () => {
  const first = await open();
  await first.turn(request());
  const saved: CodexSessionCheckpoint = { ...first.checkpoint, cliVersion: '0.153.3' };
  await first.close();
  const again = await open({ restore: saved, observedVersion: '0.153.4' });
  expect((await again.turn(request())).text).toContain('after 2 user turns.');
  expect(again.checkpoint.cliVersion).toBe('0.153.4');
});

test('a different ChatGPT account is refused before anything is sent, whether reopening or between turns', async () => {
  const first = await open();
  await first.turn(request());
  const saved = first.checkpoint;
  await first.close();
  await control({ plan: 'pro' });
  await expect(open({ restore: saved })).rejects.toMatchObject({ code: 'ACCOUNT_CHANGED' });

  await control({});
  const session = await open();
  await session.turn(request());
  await control({ plan: 'pro' });
  const sent = (await starts()).length;
  await expect(session.verify()).rejects.toMatchObject({ code: 'ACCOUNT_CHANGED' });
  await expect(session.turn(request())).rejects.toMatchObject({ code: 'ACCOUNT_CHANGED' });
  expect(await starts()).toHaveLength(sent);
  expect(session.checkpoint.state).toBe('idle');
});

test('a tool outside the read boundary stops the turn and ends its process', async () => {
  await control({ tool: 'fileChange' });
  const session = await open();
  await expect(session.turn(request())).rejects.toMatchObject({ code: 'UNEXPECTED_TOOL' });
  const pid = (await calls())[0].pid;
  await until(() => !alive(pid));
  expect(session.checkpoint.state).toBe('idle');
});

test('a restart during a turn keeps a confirmed thread, and the next message says the earlier one was not completed', async () => {
  const first = await open();
  await first.turn(request());
  const busy: CodexSessionCheckpoint = { ...first.checkpoint, state: 'busy' };
  await first.close();
  const recovered = recoverCodexCheckpoint(busy, 'cmd-lost');
  expect(recovered).toEqual({ resume: { ...busy, state: 'idle', origin: 'recovered', interruptedRequestId: 'cmd-lost' } });
  expect(recoverCodexCheckpoint({ ...busy, nativeSessionId: null }, 'cmd-lost')).toEqual({
    refuse:
      "Diomedes restarted while ChatGPT was answering, and no ChatGPT thread was confirmed to continue, so this conversation couldn't resume. Start again.",
  });
  const again = await open({ restore: (recovered as { resume: CodexSessionCheckpoint }).resume });
  await again.turn(request());
  expect(again.continuity.detail).toBe(
    "Diomedes restarted while an earlier message was being answered. That message wasn't completed or sent again. This conversation continued from ChatGPT's saved thread.",
  );
  expect(again.checkpoint).toMatchObject({ origin: 'resumed', interruptedRequestId: null });
});

test('a fork continues a copy of the thread in the same lineage, under its own Diomedes thread, and the source goes on unchanged', async () => {
  const first = await open();
  await first.turn(request());
  const source = first.checkpoint;
  const forked = await open({ restore: source, fork: true }, {}, { threadId: 'thread-fork' });
  expect(forked.checkpoint).toMatchObject({
    origin: 'forked',
    turns: 0,
    threadId: 'thread-fork',
    lineageId: source.lineageId,
    parentSessionId: source.nativeSessionId,
  });
  expect(forked.checkpoint.nativeSessionId).not.toBe(source.nativeSessionId);
  expect((await forked.turn(request({ threadId: 'thread-fork' }))).text).toContain(
    `on ${forked.checkpoint.nativeSessionId} after 2 user turns.`,
  );
  expect((await first.turn(request())).text).toContain(`on ${source.nativeSessionId} after 2 user turns.`);
});
