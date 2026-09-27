/**
 * The kept ChatGPT conversation (spec 3.2) through the shared native conversation driver and
 * RunService, and through EngineService's `codexSession`, against the fixture app-server
 * (tests/fixtures/codex-app-server.mjs) over the real port (`codexConversations`): durable turns
 * with the Codex thread id, a message held while ChatGPT answers and sent as the next turn, a
 * fork into a child run, Stop recorded on the turn, and a Diomedes restart in the middle of a turn
 * reconciled from the durable record, resumed with thread/resume and never resent. No Codex
 * binary or ChatGPT account is reached.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { FileRunStore } from '../server/harness/run-store.js';
import { RunService } from '../server/harness/run-service.js';
import { ClaudeSessionRuns, type ClaudeSessionTurn } from '../server/harness/claude-session-run.js';
import {
  CODEX_SESSION_CAPABILITY,
  CODEX_SESSION_PROFILE,
  codexSessionRunId,
} from '../server/harness/codex-session-run.js';
import { validateNativeCheckpoint } from '../server/harness/opencode-session-run.js';
import { textDispatchAuthorizer } from '../server/harness/text-route.js';
import { streamChecks } from '../server/harness/conformance.js';
import { createIntegrations, createRpcClient, type CodexConversationPort } from '../server/integrations.js';
import {
  CODEX_ACCOUNT_ROUTE,
  openCodexSession,
  type CodexSessionCheckpoint,
} from '../server/engines/codex-session.js';
import { EngineService } from '../server/engines/service.js';
import type { TextRequest } from '../server/engines/contract.js';

const FIXTURE = fileURLToPath(new URL('./fixtures/codex-app-server.mjs', import.meta.url));
const LEAKED = 'sk-test-leak-0123456789abcdef';
let dir: string;
let storage: FileRunStore;
let settings: Record<string, unknown>;
const drivers: ClaudeSessionRuns<CodexSessionCheckpoint>[] = [];
type Call = { pid: number; method: string; params: Record<string, unknown> };

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'diomedes codex runtime '));
  storage = new FileRunStore(path.join(dir, 'runs'));
  settings = { codex: true };
});
afterEach(async () => {
  for (const driver of drivers.splice(0)) await driver.closeAll().catch(() => undefined);
  await fs.rm(dir, { recursive: true, force: true });
});

const control = (value: Record<string, unknown>) =>
  fs.writeFile(path.join(dir, 'control.json'), JSON.stringify(value));
const calls = async (): Promise<Call[]> =>
  (await fs.readFile(path.join(dir, 'calls.jsonl'), 'utf8').catch(() => ''))
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Call);
const starts = async () => (await calls()).filter((call) => call.method === 'turn/start');
const port = (): CodexConversationPort =>
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
const input = (requestId: string, overrides: Partial<TextRequest> = {}): TextRequest => ({
  projectId: 'p1',
  threadId: 't1',
  requestId,
  model: 'fixture-codex-model',
  accountRoute: CODEX_ACCOUNT_ROUTE,
  instructions: 'Answer plainly.',
  prompt: requestId,
  documents: [],
  ...overrides,
});

/** One Diomedes process: its own RunService and driver over the shared run store. */
function driverFor() {
  const authorize = textDispatchAuthorizer(() => settings, [CODEX_SESSION_CAPABILITY.id]);
  const runs: RunService = new RunService(storage, {
    validateNativeCheckpoint,
    authorizeEgress: async (runId, intent, _principal, phase) =>
      authorize(await runs.get(runId), intent, phase),
  });
  const driver = new ClaudeSessionRuns(runs, { profile: CODEX_SESSION_PROFILE });
  // Synthetic policy for this standalone driver: sharing is allowed.
  driver.setSharingPolicy(() => {});
  drivers.push(driver);
  return { runs, driver, conversations: port() };
}
const turn = (
  conversations: CodexConversationPort,
  mode: ClaudeSessionTurn['mode'],
  runId: string,
  request: TextRequest,
  extra: Partial<Pick<ClaudeSessionTurn<CodexSessionCheckpoint>, 'sourceRunId' | 'queued' | 'preview'>> = {},
): ClaudeSessionTurn<CodexSessionCheckpoint> => ({
  mode,
  runId,
  input: request,
  ...extra,
  admit: async () => ({
    location: 'diomedes-codex',
    version: '0.153.4',
    model: request.model,
    accountRoute: request.accountRoute,
  }),
  open: (_admission, wire, options) => openCodexSession(conversations, wire, options),
});
const runId = codexSessionRunId('p1', 'lineage-1');
const checkpointOf = (run: Awaited<ReturnType<RunService['get']>>) =>
  [...run.steps].reverse().find((step) => step.nativeCheckpoint)?.nativeCheckpoint?.payload as
    | CodexSessionCheckpoint
    | undefined;

describe('kept ChatGPT conversation over the native conversation driver', () => {
  it('records each turn durably with the Codex thread id, on one process, with the runtime-reported attribution', async () => {
    const { driver, runs, conversations } = driverFor();
    const first = await driver.request(turn(conversations, 'start', runId, input('first')));
    const second = await driver.request(turn(conversations, 'follow-up', runId, input('second')));
    const thread = first.nativeSession!.opaqueRef;
    expect(first.response?.text).toContain(`Fixture answer on ${thread} after 1 user turn.`);
    expect(second.response?.text).toContain(`Fixture answer on ${thread} after 2 user turns.`);
    expect(first.nativeSession?.providerId).toBe('codex');
    expect(second.nativeSession).toEqual(first.nativeSession);
    expect(second.continuity).toBeUndefined();
    const run = await runs.get(runId);
    expect(run.capabilityId).toBe(CODEX_SESSION_CAPABILITY.id);
    expect(checkpointOf(run)).toMatchObject({ nativeSessionId: thread, state: 'idle', origin: 'resumed', turns: 2 });
    expect(run.steps.find((step) => step.intent.kind === 'model')?.origin).toMatchObject({
      engine: { id: 'codex', version: '0.153.4' },
      model: { requested: 'fixture-codex-model', reported: 'fixture-codex-model', source: 'runtime' },
    });
    expect(streamChecks(run).filter((check) => check.outcome === 'failed')).toEqual([]);
    expect((await calls()).filter((call) => call.method === 'initialize')).toHaveLength(1);
  });

  it('holds a message sent while ChatGPT answers and sends it next on the same thread, never with turn/steer', async () => {
    await control({ delayTurnStart: 400 });
    const { driver, conversations } = driverFor();
    const running = driver.request(turn(conversations, 'start', runId, input('first')));
    await vi.waitFor(async () => expect(await starts()).toHaveLength(1), { timeout: 5_000 });
    expect(driver.busy(runId)).toBe(true);
    const held = await driver.steer('p1', runId, 'steer-1', 'also this');
    expect(held).toMatchObject({ commandId: 'steer-1', state: 'pending', nativeSession: null });
    const first = await running;
    await vi.waitFor(
      async () => expect((await driver.steering('p1', runId))[0]).toMatchObject({ state: 'delivered' }),
      { timeout: 5_000 },
    );
    const [delivered] = await driver.steering('p1', runId);
    expect(delivered.nativeSession).toEqual(first.nativeSession);
    expect(await driver.turnResult('p1', runId, 'steer-1')).toEqual({ answered: true, interrupted: false });
    const sent = await starts();
    expect(sent).toHaveLength(2);
    expect(sent[1].params.threadId).toBe(first.nativeSession!.opaqueRef);
    expect((await calls()).filter((call) => call.method === 'turn/steer')).toHaveLength(0);
  });

  it('forks an idle conversation into a child run on a copy of its thread, in the same lineage', async () => {
    const { driver, runs, conversations } = driverFor();
    const source = await driver.request(turn(conversations, 'start', runId, input('first')));
    const forkRun = codexSessionRunId('p1', 'fork-1');
    const fork = await driver.request(
      turn(conversations, 'fork', forkRun, input('branch'), { sourceRunId: runId }),
    );
    expect(fork.runId).toBe(forkRun);
    expect(fork.nativeSession?.opaqueRef).not.toBe(source.nativeSession?.opaqueRef);
    expect(fork.nativeSession?.lineageId).toBe(source.nativeSession?.lineageId);
    expect(fork.response?.text).toContain(`Fixture answer on ${fork.nativeSession!.opaqueRef} after 2 user turns.`);
    expect((await runs.get(forkRun)).parentRunId).toBe(runId);
    // H02's capability probe sends each method with no parameters first; one fork names a thread.
    expect((await calls()).filter((call) => call.method === 'thread/fork' && call.params.threadId)).toHaveLength(1);
  });

  it('a Stop is recorded as an interruption, with how ChatGPT took it, and the thread goes on', async () => {
    const { driver, runs, conversations } = driverFor();
    await driver.request(turn(conversations, 'start', runId, input('first')));
    await control({ hold: true, stream: 'Soup is ready' });
    const deltas: string[] = [];
    const running = driver.request(
      turn(conversations, 'follow-up', runId, input('stop-me'), {
        preview: () => ({ onDelta: (text) => deltas.push(text), finish: async () => {} }),
      }),
    );
    await vi.waitFor(() => expect(deltas.length).toBeGreaterThan(0), { timeout: 5_000 });
    // The session reports how the Stop ended, as Claude Code's does (H03).
    expect(await driver.interruptCommand('p1', runId, 'stop-me')).toEqual({ state: 'requested', stop: 'interrupted' });
    expect(await running).toMatchObject({ response: null, interrupted: true });
    expect(await driver.turnResult('p1', runId, 'stop-me')).toEqual({ answered: false, interrupted: true });
    expect(checkpointOf(await runs.get(runId))).toMatchObject({ state: 'idle', lastStop: 'acknowledged' });
    await control({});
    const next = await driver.request(turn(conversations, 'follow-up', runId, input('after')));
    expect(next.response?.text).toContain('after 3 user turns.');
  });

  it('a restart mid-turn is reconciled from the record, resumed with thread/resume and never resent', async () => {
    const before = driverFor();
    const first = await before.driver.request(turn(before.conversations, 'start', runId, input('first')));
    await control({ hold: true });
    // A turn is running when Diomedes stops: the busy checkpoint with the thread id is on disk,
    // and Codex has the message.
    const lost = before.driver.request(turn(before.conversations, 'follow-up', runId, input('lost')));
    // The old process can only fail once the new one takes the run: watched from the start.
    void lost.catch(() => undefined);
    await vi.waitFor(async () => expect(await starts()).toHaveLength(2), { timeout: 5_000 });
    expect(checkpointOf(await before.runs.get(runId))?.state).toBe('busy');
    // The new process of Diomedes recovers from the durable record alone.
    const after = driverFor();
    await after.driver.recover(await after.runs.get(runId));
    // The old process is gone; nothing it does can commit any more.
    await before.driver.closeAll().catch(() => undefined);
    await lost.catch(() => undefined);
    const recovered = await after.runs.get(runId);
    expect(['queued', 'waiting']).toContain(recovered.state);
    const interrupted = recovered.steps.find(
      (step) => (step.intent.input as { requestId?: string }).requestId === 'lost',
    );
    expect(interrupted?.state).toBe('cancelled');
    expect(checkpointOf(recovered)).toMatchObject({
      state: 'idle',
      origin: 'recovered',
      interruptedRequestId: 'lost',
      nativeSessionId: first.nativeSession!.opaqueRef,
    });
    expect(streamChecks(recovered).filter((check) => check.outcome === 'failed')).toEqual([]);
    // A follow-up needs a live connection; after a restart the resume is explicit.
    await expect(
      after.driver.request(turn(after.conversations, 'follow-up', runId, input('too-soon'))),
    ).rejects.toMatchObject({ code: 'RESUME_REQUIRED' });
    await control({});
    const resumed = await after.driver.request(turn(after.conversations, 'resume', runId, input('resumed')));
    expect(resumed.nativeSession?.opaqueRef).toBe(first.nativeSession!.opaqueRef);
    expect(resumed.continuity).toMatchObject({
      detail:
        "Diomedes restarted while an earlier message was being answered. That message wasn't completed or sent again. This conversation continued from ChatGPT's saved thread.",
    });
    // The interrupted command is never answered from the record, and never sent again: Codex kept
    // it in the thread, so the resumed message is the thread's third.
    expect(await after.driver.turnResult('p1', runId, 'lost')).toBeNull();
    expect(resumed.response?.text).toContain('after 3 user turns.');
    expect(await starts()).toHaveLength(3);
    expect((await calls()).filter((call) => call.method === 'thread/resume')).toHaveLength(1);
  });

  it('the Settings check admits ChatGPT under its fixed account route, and only while ChatGPT is on', async () => {
    const authorize = textDispatchAuthorizer(() => settings, [CODEX_SESSION_CAPABILITY.id]);
    const run = { capabilityId: CODEX_SESSION_CAPABILITY.id, input: { accountRoute: CODEX_ACCOUNT_ROUTE } } as never;
    const intent = { destination: 'external', input: { engine: 'codex' } } as never;
    // Settings records ChatGPT's account route only once a person chose it; the route is fixed.
    await expect(authorize(run, intent, 'dispatch')).resolves.toBeUndefined();
    settings = { codex: true, codexAccountRoute: CODEX_ACCOUNT_ROUTE };
    await expect(authorize(run, intent, 'dispatch')).resolves.toBeUndefined();
    settings = { codex: false };
    await expect(authorize(run, intent, 'dispatch')).rejects.toMatchObject({ code: 'egress_denied' });
    settings = { codex: true, codexAccountRoute: 'codex:another' };
    await expect(authorize(run, intent, 'result')).rejects.toMatchObject({ code: 'egress_denied' });
  });
});

describe('the ChatGPT conversation through EngineService', () => {
  const service = (conversations: CodexConversationPort, driver: ClaudeSessionRuns<CodexSessionCheckpoint>) => {
    const engines = new EngineService(path.join(dir, 'engines'), {
      redactFor: () => (text) => text.split(LEAKED).join('[redacted]'),
    });
    engines.codexSessions = driver;
    engines.codexConversations = conversations;
    return engines;
  };

  it('streams thinking and the answer as fenced frames, redacted, and saves the thinking on the reply', async () => {
    await control({ think: `Weighing ${LEAKED} first.` });
    const { driver, conversations } = driverFor();
    const thoughts: string[] = [];
    const previews: string[] = [];
    const result = await service(conversations, driver).codexSession('start', runId, {
      ...input('first'),
      onPreview: (frame) => previews.push(frame.text),
      onReasoning: (frame) => thoughts.push(frame.text),
    });
    expect(result.response?.text).toContain('after 1 user turn.');
    expect(result.response?.reasoning?.text).toBe('Weighing [redacted] first.');
    // Live frames are redacted chunk by chunk, as answer previews are (shared/adapter-contract.ts);
    // a secret split across chunks is caught in the saved thinking, redacted as one piece above.
    expect(thoughts.join('')).toContain('Weighing');
    // The fixture previews the answer's first characters; the preview is where the answer began.
    expect(previews.join('')).not.toBe('');
    expect(result.response?.text.startsWith(previews.join(''))).toBe(true);
    // Summaries were asked for because someone was watching.
    expect((await starts()).map((call) => call.params.summary)).toEqual(['auto']);
  });

  it('asks for no summaries when nobody watches the thinking', async () => {
    await control({ think: 'Weighing the menu.' });
    const { driver, conversations } = driverFor();
    const result = await service(conversations, driver).codexSession('start', runId, input('first'));
    expect(result.response?.reasoning).toBeUndefined();
    expect((await starts()).map((call) => call.params.summary)).toEqual(['none']);
  });

  it('refuses a changed account route before any process starts', async () => {
    const { driver, conversations } = driverFor();
    await expect(
      service(conversations, driver).codexSession('start', runId, input('first', { accountRoute: 'codex:another' })),
    ).rejects.toMatchObject({ code: 'ACCOUNT_CHANGED' });
    expect(await calls()).toEqual([]);
  });

  it('says the runtime is missing when no ChatGPT conversation runtime is attached', async () => {
    const { driver } = driverFor();
    const engines = new EngineService(path.join(dir, 'engines'));
    engines.codexSessions = driver;
    await expect(engines.codexSession('start', runId, input('first'))).rejects.toMatchObject({
      code: 'RUNTIME_UNAVAILABLE',
    });
  });
});
