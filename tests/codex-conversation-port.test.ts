/**
 * The kept ChatGPT conversation's process (`codexConversations` in server/integrations.ts) against
 * the fixture app-server (tests/fixtures/codex-app-server.mjs): a real child process speaking the
 * pinned 0.153.4 JSON-RPC over stdio. No Codex binary or ChatGPT account is reached.
 */
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  createIntegrations,
  createRpcClient,
  type CodexConversationProcess,
  type CodexTurnInput,
} from '../server/integrations';

const FIXTURE = fileURLToPath(new URL('./fixtures/codex-app-server.mjs', import.meta.url));
let dir: string;
let processes: CodexConversationProcess[];
const control = (value: Record<string, unknown>) =>
  fs.writeFile(path.join(dir, 'control.json'), JSON.stringify(value));
const calls = async () =>
  (await fs.readFile(path.join(dir, 'calls.jsonl'), 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as { pid: number; method: string; params: Record<string, unknown> });
const conversations = (turnTimeoutMs = 20_000) =>
  createIntegrations({
    platform: 'win32',
    verifySandbox: async () => {},
    turnTimeoutMs,
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
const open = async (turnTimeoutMs?: number) => {
  const opened = await conversations(turnTimeoutMs).open(undefined);
  processes.push(opened);
  return opened;
};
const thread = { model: 'fixture-codex-model', instructions: 'Answer briefly.' };
const turn = (on: CodexConversationProcess, threadId: string, extra: Partial<CodexTurnInput> = {}) =>
  on.turn({
    threadId,
    prompt: JSON.stringify({ request: 'What is on the lunch menu?', documents: [] }),
    summaries: false,
    signal: new AbortController().signal,
    ...extra,
  });
const until = async (check: () => boolean) => {
  for (let i = 0; i < 200 && !check(); i++) await new Promise((resolve) => setTimeout(resolve, 10));
  expect(check()).toBe(true);
};

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'diomedes-codex-port-'));
  processes = [];
});
afterEach(async () => {
  for (const opened of processes) await opened.close().catch(() => undefined);
  vi.unstubAllEnvs();
  await fs.rm(dir, { recursive: true, force: true });
});

test('a conversation process keeps its thread, streams the answer, and asks for no summary without a sink', async () => {
  const on = await open();
  expect(on.version).toBe('0.153.4');
  expect(await on.account()).toMatch(/^openai:chatgpt:[a-f0-9]{64}$/);
  const opened = await on.thread(thread);
  expect(opened).toMatchObject({ origin: 'started', lost: null });
  const deltas: string[] = [];
  const answer = await turn(on, opened.threadId, { onDelta: (text) => deltas.push(text) });
  expect(answer.text).toContain(`Fixture answer on ${opened.threadId} after 1 user turn.`);
  expect(deltas.join('')).not.toBe('');
  const log = await calls();
  // Kept: a later process must be able to resume it.
  expect(log.find((call) => call.method === 'thread/start')?.params.ephemeral).toBe(false);
  expect(log.find((call) => call.method === 'turn/start')?.params.summary).toBe('none');
});

test('reasoning summaries reach the thinking sink, a new part as a new paragraph, and never the answer', async () => {
  await control({ think: ['Weighing the menu.', 'Checking prices.'] });
  const on = await open();
  const opened = await on.thread(thread);
  const thinking: string[] = [];
  const deltas: string[] = [];
  const answer = await turn(on, opened.threadId, {
    summaries: true,
    onReasoningDelta: (text) => thinking.push(text),
    onDelta: (text) => deltas.push(text),
  });
  expect(thinking.join('')).toBe('Weighing the menu.\n\nChecking prices.');
  expect(answer.text).not.toContain('Weighing');
  expect(deltas.join('')).not.toContain('Weighing');
  expect((await calls()).find((call) => call.method === 'turn/start')?.params.summary).toBe('auto');
});

test('a new process continues a saved thread, and a thread Codex no longer has starts fresh and names it', async () => {
  const first = await open();
  const opened = await first.thread(thread);
  await turn(first, opened.threadId);
  await first.close();
  expect(first.closed).toBe(true);
  const second = await open();
  const resumed = await second.thread({ ...thread, resume: opened.threadId });
  expect(resumed).toMatchObject({ threadId: opened.threadId, origin: 'resumed', lost: null });
  expect((await turn(second, opened.threadId)).text).toContain('after 2 user turns');
  await control({ forget: [opened.threadId] });
  const third = await open();
  const fresh = await third.thread({ ...thread, resume: opened.threadId });
  expect(fresh).toMatchObject({ origin: 'restarted-fresh', lost: opened.threadId });
  expect(fresh.threadId).not.toBe(opened.threadId);
});

test('an interrupt Codex acknowledges ends the turn as interrupted and keeps the process', async () => {
  await control({ hold: true });
  const on = await open();
  const opened = await on.thread(thread);
  let turnId = '';
  const running = turn(on, opened.threadId, { onTurn: (id) => (turnId = id) });
  await until(() => turnId !== '');
  expect(await on.interrupt(opened.threadId, turnId, 3_000)).toBe(true);
  await expect(running).rejects.toMatchObject({ code: 'TURN_INTERRUPTED' });
  expect(on.closed).toBe(false);
  expect((await calls()).filter((call) => call.method === 'turn/interrupt')).toHaveLength(1);
});

test('an interrupt Codex never answers is reported within the wait, and closing ends the turn', async () => {
  await control({ hold: true, ignoreInterrupt: true });
  const on = await open();
  const opened = await on.thread(thread);
  let turnId = '';
  const running = turn(on, opened.threadId, { onTurn: (id) => (turnId = id) });
  await until(() => turnId !== '');
  const asked = Date.now();
  expect(await on.interrupt(opened.threadId, turnId, 300)).toBe(false);
  expect(Date.now() - asked).toBeLessThan(2_000);
  // Watch the turn before closing: the close rejects it at once.
  const ended = expect(running).rejects.toBeDefined();
  await on.close();
  await ended;
  expect(on.closed).toBe(true);
});

test('a tool outside the read boundary stops the turn', async () => {
  await control({ tool: 'fileChange' });
  const on = await open();
  const opened = await on.thread(thread);
  await expect(turn(on, opened.threadId)).rejects.toMatchObject({ code: 'UNEXPECTED_TOOL' });
});

test('an account that is not ChatGPT is refused before any thread opens', async () => {
  await control({ signedOut: true });
  await expect(conversations().open(undefined)).rejects.toMatchObject({ code: 'CHATGPT_REQUIRED' });
  expect((await calls()).some((call) => call.method === 'thread/start')).toBe(false);
});

test("a conversation's turn outlives the direct path's deadline: Stop bounds it, as it bounds Claude Code's", async () => {
  // The direct path's two minutes, shortened. A conversation's answer may run longer than that.
  const on = await open(100);
  const opened = await on.thread(thread);
  await control({ turnMs: 400 });
  const answer = await turn(on, opened.threadId);
  expect(answer.text).toContain(`Fixture answer on ${opened.threadId} after 1 user turn.`);
});

test.runIf(process.platform === 'win32')(
  'a runtime that was never prepared is refused as not installed, with no sandbox proof remembered',
  async () => {
    vi.stubEnv('DIOMEDES_DATA_DIR', path.join(dir, 'data'));
    vi.stubEnv('DIOMEDES_RUNTIME_DIR', path.join(dir, 'no-runtime'));
    vi.resetModules();
    const fresh = await import('../server/integrations');
    // Only the platform is given: the real sandbox proof and the real process start run.
    await expect(fresh.createIntegrations({ platform: 'win32' }).codexConversations.open(undefined)).rejects.toMatchObject({
      code: 'NATIVE_NOT_INSTALLED',
    });
  },
);
