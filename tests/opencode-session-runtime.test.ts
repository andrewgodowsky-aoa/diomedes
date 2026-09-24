/**
 * H04: the kept OpenCode session through the shared native conversation driver
 * and RunService, end to end against the fixture server: durable turns and
 * checkpoints, the host steering queue, stop, restart and resume, a resume
 * OpenCode cannot honour, and fork. Live opencode 1.18.4 is not reached.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { FileRunStore } from '../server/harness/run-store.js';
import { RunService } from '../server/harness/run-service.js';
import { ClaudeSessionRuns, type ClaudeSessionTurn } from '../server/harness/claude-session-run.js';
import {
  OPENCODE_SESSION_CAPABILITY,
  OPENCODE_SESSION_PROFILE,
  opencodeSessionRunId,
  validateNativeCheckpoint,
} from '../server/harness/opencode-session-run.js';
import { textDispatchAuthorizer } from '../server/harness/text-route.js';
import { streamChecks } from '../server/harness/conformance.js';
import { OpenCodeAdapter, OPENCODE_ACCOUNT_ROUTE, OPENCODE_VERSION } from '../server/engines/opencode.js';
import {
  RESTARTED_FRESH_DETAIL,
  type OpenCodeSessionCheckpoint,
} from '../server/engines/opencode-session.js';
import type { TextRequest } from '../server/engines/contract.js';

const FIXTURE = fileURLToPath(new URL('./fixtures/opencode-session-server.mjs', import.meta.url));
const roots: string[] = [];
const drivers: ClaudeSessionRuns<OpenCodeSessionCheckpoint>[] = [];
beforeEach(() => {
  vi.stubEnv('XDG_CACHE_HOME', path.join(os.tmpdir(), 'diomedes-no-opencode-cache'));
});
afterEach(async () => {
  for (const driver of drivers.splice(0)) await driver.closeAll().catch(() => undefined);
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

const input = (requestId: string, prompt = requestId): TextRequest => ({
  projectId: 'p1',
  threadId: 't1',
  requestId,
  model: 'opencode-go/go-model',
  accountRoute: OPENCODE_ACCOUNT_ROUTE,
  instructions: 'Answer plainly.',
  prompt,
  documents: [],
});

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'diomedes opencode runtime '));
  roots.push(root);
  vi.stubEnv('XDG_DATA_HOME', path.join(root, 'data'));
  const state = { mode: 'ok', launches: 0 };
  const adapter = new OpenCodeAdapter('opencode', path.join(root, 'engine'), {
    spawn: (_command, args, options) => {
      state.launches += 1;
      return spawn(process.execPath, [FIXTURE, args[args.indexOf('--port') + 1], state.mode], options) as ChildProcessWithoutNullStreams;
    },
    startupTimeoutMs: 5_000,
    requestTimeoutMs: 5_000,
  });
  await fs.mkdir(path.join(root, 'engine'), { recursive: true });
  const storage = new FileRunStore(path.join(root, 'runs'));
  const settings = { opencode: true, opencodeAccountRoute: OPENCODE_ACCOUNT_ROUTE };
  const driverFor = () => {
    const authorize = textDispatchAuthorizer(() => settings, [OPENCODE_SESSION_CAPABILITY.id]);
    const runs: RunService = new RunService(storage, {
      validateNativeCheckpoint,
      authorizeEgress: async (runId, intent, _principal, phase) =>
        authorize(await runs.get(runId), intent, phase),
    });
    const driver = new ClaudeSessionRuns(runs, { profile: OPENCODE_SESSION_PROFILE });
    // Synthetic policy for this standalone driver: sharing is allowed.
    driver.setSharingPolicy(() => {});
    drivers.push(driver);
    return { runs, driver };
  };
  const turn = (
    mode: ClaudeSessionTurn['mode'],
    runId: string,
    request: TextRequest,
    sourceRunId?: string,
  ): ClaudeSessionTurn<OpenCodeSessionCheckpoint> => ({
    mode,
    runId,
    sourceRunId,
    input: request,
    admit: async () => ({
      location: 'opencode',
      version: OPENCODE_VERSION,
      model: request.model,
      accountRoute: request.accountRoute,
    }),
    open: (_admission, wire, options) => adapter.openSession(wire, options),
  });
  const log = async () =>
    (await fs.readFile(path.join(root, 'engine', 'requests.log'), 'utf8').catch(() => ''))
      .split('\n')
      .filter(Boolean);
  return { root, state, driverFor, turn, log };
}
const runId = opencodeSessionRunId('p1', 'lineage-1');

describe('kept OpenCode session over the native conversation driver', () => {
  it('records each turn durably on one live session, with the runtime-reported attribution', async () => {
    const f = await fixture();
    const { driver, runs } = f.driverFor();
    const first = await driver.request(f.turn('start', runId, input('first')));
    const second = await driver.request(f.turn('follow-up', runId, input('second')));
    const id = first.nativeSession!.opaqueRef;
    expect(first.response?.text).toBe(`answer:first (turn 1 of ${id})`);
    expect(second.response?.text).toBe(`answer:second (turn 2 of ${id})`);
    expect(second.nativeSession).toEqual(first.nativeSession);
    expect(first.nativeSession?.providerId).toBe('opencode');
    expect(f.state.launches).toBe(1);
    // A replayed command reads the record; nothing is sent again.
    expect(await driver.request(f.turn('follow-up', runId, input('second')))).toEqual(second);
    expect((await f.log()).filter((line) => line.endsWith('/prompt_async'))).toHaveLength(2);
    const run = await runs.get(runId);
    expect(run.capabilityId).toBe(OPENCODE_SESSION_CAPABILITY.id);
    const turns = run.steps.filter((step) => step.intent.kind === 'model');
    expect(turns.map((step) => step.intent.name)).toEqual(['OpenCode native turn', 'OpenCode native turn']);
    expect(turns.at(-1)?.nativeCheckpoint).toMatchObject({
      providerId: 'opencode',
      payload: { nativeSessionId: id, state: 'idle', reportedModel: 'opencode-go/go-model', turns: 2 },
    });
    expect(turns.at(-1)?.origin).toMatchObject({
      mode: 'direct',
      engine: { id: 'opencode', version: OPENCODE_VERSION },
      model: { requested: 'opencode-go/go-model', reported: 'opencode-go/go-model', source: 'runtime' },
      accountRoute: OPENCODE_ACCOUNT_ROUTE,
    });
    expect(await driver.status('p1', runId)).toMatchObject({
      state: 'waiting',
      connected: true,
      reportedModel: 'opencode-go/go-model',
      nativeSession: { providerId: 'opencode', opaqueRef: id },
      steering: [],
    });
    // The durable event stream is well formed: the conformance suite over the run.
    expect(streamChecks(run).filter((check) => check.outcome === 'failed')).toEqual([]);
  });

  it('holds a message sent while a turn runs and sends it next, as its own durable turn', async () => {
    const f = await fixture();
    f.state.mode = 'delayed';
    const { driver } = f.driverFor();
    const running = driver.request(f.turn('start', runId, input('first')));
    await vi.waitFor(async () => expect((await f.log()).some((line) => line.endsWith('/prompt_async'))).toBe(true));
    expect(driver.busy(runId)).toBe(true);
    const held = await driver.steer('p1', runId, 'steer-1', 'also this');
    expect(held).toMatchObject({ commandId: 'steer-1', state: 'pending', nativeSession: null });
    // The same command again is the same acknowledgement; different text is refused.
    expect(await driver.steer('p1', runId, 'steer-1', 'also this')).toEqual(held);
    await expect(driver.steer('p1', runId, 'steer-1', 'something else')).rejects.toMatchObject({
      code: 'intent_mismatch',
    });
    expect((await driver.status('p1', runId)).steering).toEqual([held]);
    const first = await running;
    await vi.waitFor(async () =>
      expect((await driver.steering('p1', runId))[0]).toMatchObject({ state: 'delivered' }),
      { timeout: 5_000 },
    );
    const [delivered] = await driver.steering('p1', runId);
    expect(delivered.nativeSession).toEqual(first.nativeSession);
    // Sent as the next message of the same session, never into the running one.
    expect(await driver.turnResult('p1', runId, 'steer-1')).toEqual({ answered: true, interrupted: false });
    const prompts = (await f.log()).filter((line) => line.endsWith('/prompt_async'));
    expect(prompts).toHaveLength(2);
    // With nothing running, a steer is refused rather than silently queued.
    expect(await driver.steer('p1', runId, 'steer-2', 'late')).toMatchObject({ state: 'rejected' });
  });

  it('sends several held messages in the order they were sent, and holds again behind a later turn', async () => {
    const f = await fixture();
    f.state.mode = 'delayed';
    const { driver } = f.driverFor();
    const prompts = async () => (await f.log()).filter((line) => line.endsWith('/prompt_async')).length;
    const running = driver.request(f.turn('start', runId, input('first')));
    await vi.waitFor(async () => expect(await prompts()).toBe(1));
    await driver.steer('p1', runId, 'steer-1', 'one');
    await driver.steer('p1', runId, 'steer-2', 'two');
    await running;
    await vi.waitFor(
      async () => expect((await driver.steering('p1', runId)).map((ack) => ack.state)).toEqual(['delivered', 'delivered']),
      { timeout: 5_000 },
    );
    const first = await driver.request(f.turn('follow-up', runId, input('probe-1')));
    // Turn order in the session: first, one, two, then the follow-up.
    expect(first.response?.text).toContain('(turn 4 of');
    // The first drain has ended; a message held behind a new turn starts another.
    const later = driver.request(f.turn('follow-up', runId, input('later')));
    await vi.waitFor(async () => expect(await prompts()).toBe(5));
    await driver.steer('p1', runId, 'steer-3', 'three');
    await later;
    await vi.waitFor(
      async () => expect((await driver.steering('p1', runId)).at(-1)).toMatchObject({ commandId: 'steer-3', state: 'delivered' }),
      { timeout: 5_000 },
    );
    expect(await driver.turnResult('p1', runId, 'steer-3')).toEqual({ answered: true, interrupted: false });
  });

  it('a stop leaves the session resumable and cancels what was held, with the reason', async () => {
    const f = await fixture();
    f.state.mode = 'slow';
    const { driver, runs } = f.driverFor();
    const running = driver.request(f.turn('start', runId, input('first')));
    await vi.waitFor(async () => expect((await f.log()).some((line) => line.endsWith('/prompt_async'))).toBe(true));
    await driver.steer('p1', runId, 'steer-1', 'queued behind it');
    expect(await driver.interruptCommand('p1', runId, 'first')).toEqual({ state: 'requested' });
    const stopped = await running;
    expect(stopped).toMatchObject({ response: null, interrupted: true });
    await vi.waitFor(async () =>
      expect((await driver.steering('p1', runId))[0]).toMatchObject({
        state: 'cancelled',
        detail: 'The answer it was waiting for was stopped, so this message was not sent.',
      }),
    );
    expect((await f.log()).some((line) => line.endsWith('/abort'))).toBe(true);
    const saved = (await runs.get(runId)).steps.filter((step) => step.intent.kind === 'model').at(-1);
    expect(saved?.nativeCheckpoint?.payload).toMatchObject({ state: 'idle' });
    // The same OpenCode session answers the next message.
    f.state.mode = 'ok';
    await driver.control('p1', runId, 'close-1', 'close');
    const next = await driver.request(f.turn('resume', runId, input('after')));
    expect(next.response?.text).toBe(`answer:after (turn 2 of ${stopped.nativeSession!.opaqueRef})`);
  });

  it('after a restart, recovery then an explicit resume continue the same OpenCode session', async () => {
    const f = await fixture();
    const before = f.driverFor();
    const first = await before.driver.request(f.turn('start', runId, input('first')));
    await before.driver.closeAll();
    const after = f.driverFor();
    const run = await after.runs.get(runId);
    await after.driver.recover(run);
    // A follow-up needs a live connection; after a restart the resume is explicit.
    await expect(after.driver.request(f.turn('follow-up', runId, input('too-soon')))).rejects.toMatchObject({
      code: 'RESUME_REQUIRED',
    });
    const resumed = await after.driver.request(f.turn('resume', runId, input('resumed')));
    expect(resumed.nativeSession).toEqual(first.nativeSession);
    expect(resumed.continuity).toBeUndefined();
    expect(resumed.response?.text).toBe(`answer:resumed (turn 2 of ${first.nativeSession!.opaqueRef})`);
    expect(f.state.launches).toBe(2);
    const recovered = await after.runs.get(runId);
    expect(recovered.events.some((event) => event.type === 'run.recovered')).toBe(true);
    expect(streamChecks(recovered).filter((check) => check.outcome === 'failed')).toEqual([]);
  });

  it('a resume OpenCode cannot honour starts fresh, and the turn says so', async () => {
    const f = await fixture();
    const before = f.driverFor();
    const first = await before.driver.request(f.turn('start', runId, input('first')));
    await before.driver.closeAll();
    await fs.rm(path.join(f.root, 'data', 'opencode-fixture'), { recursive: true, force: true });
    const after = f.driverFor();
    await after.driver.recover(await after.runs.get(runId));
    const resumed = await after.driver.request(f.turn('resume', runId, input('resumed')));
    expect(resumed.continuity).toEqual({ origin: 'restarted-fresh', detail: RESTARTED_FRESH_DETAIL });
    expect(resumed.nativeSession?.opaqueRef).not.toBe(first.nativeSession?.opaqueRef);
    expect(resumed.nativeSession?.lineageId).toBe(first.nativeSession?.lineageId);
    expect(resumed.response?.text).toBe(`answer:resumed (turn 1 of ${resumed.nativeSession!.opaqueRef})`);
    // The continuity notice is saved with the turn that carried it.
    const saved = (await after.runs.get(runId)).steps.filter((step) => step.intent.kind === 'model').at(-1);
    expect(saved?.output).toMatchObject({ continuity: { origin: 'restarted-fresh' } });
    expect(saved?.nativeCheckpoint?.payload).toMatchObject({
      origin: 'restarted-fresh',
      lostSessionId: first.nativeSession!.opaqueRef,
    });
  });

  it('forks an idle conversation into a child run on a new OpenCode session', async () => {
    const f = await fixture();
    const { driver, runs } = f.driverFor();
    const source = await driver.request(f.turn('start', runId, input('first')));
    const forkRun = opencodeSessionRunId('p1', 'fork-1');
    const fork = await driver.request(f.turn('fork', forkRun, input('branch'), runId));
    expect(fork.runId).toBe(forkRun);
    expect(fork.nativeSession?.opaqueRef).not.toBe(source.nativeSession?.opaqueRef);
    expect(fork.nativeSession?.lineageId).toBe(source.nativeSession?.lineageId);
    expect(fork.response?.text).toBe(`answer:branch (turn 2 of ${fork.nativeSession!.opaqueRef})`);
    expect((await runs.get(forkRun)).parentRunId).toBe(runId);
  });

  it('refuses a fork the OpenCode build cannot make, and starts nothing', async () => {
    const f = await fixture();
    const { driver, runs } = f.driverFor();
    await driver.request(f.turn('start', runId, input('first')));
    await driver.control('p1', runId, 'close-1', 'close');
    f.state.mode = 'no-fork';
    const forkRun = opencodeSessionRunId('p1', 'fork-1');
    await expect(driver.request(f.turn('fork', forkRun, input('branch'), runId))).rejects.toMatchObject({
      code: 'COMMAND_UNSUPPORTED',
    });
    const fork = await runs.get(forkRun);
    expect(fork.steps.some((step) => step.intent.kind === 'model' && step.state === 'succeeded')).toBe(false);
  });

  it('a refused fork leaves nothing to reconcile, and the same fork command goes through once the cause is fixed', async () => {
    const f = await fixture();
    const { driver, runs } = f.driverFor();
    await driver.request(f.turn('start', runId, input('first')));
    await driver.control('p1', runId, 'close-1', 'close');
    f.state.mode = 'no-fork';
    const forkRun = opencodeSessionRunId('p1', 'fork-1');
    await expect(driver.request(f.turn('fork', forkRun, input('branch'), runId))).rejects.toMatchObject({
      code: 'COMMAND_UNSUPPORTED',
    });
    // Known not sent: no turn was attempted, so nothing is left for reconciliation.
    const refused = await runs.get(forkRun);
    expect(refused.state).not.toBe('reconcile_required');
    expect(refused.steps.filter((step) => step.intent.kind === 'model')).toEqual([]);
    expect(await driver.busy(forkRun)).toBe(false);
    f.state.mode = 'ok';
    const fork = await driver.request(f.turn('fork', forkRun, input('branch'), runId));
    expect(fork.response?.text).toBe(`answer:branch (turn 2 of ${fork.nativeSession!.opaqueRef})`);
    expect((await runs.get(forkRun)).parentRunId).toBe(runId);
  });

  it('a session deleted in OpenCode while connected is refused as not sent, and a resume starts fresh and says so', async () => {
    const f = await fixture();
    const { driver, runs } = f.driverFor();
    const first = await driver.request(f.turn('start', runId, input('first')));
    // The person deletes it from their own OpenCode history, which is where it lives.
    await fs.rm(path.join(f.root, 'data', 'opencode-fixture'), { recursive: true, force: true });
    await expect(driver.request(f.turn('follow-up', runId, input('second')))).rejects.toMatchObject({
      code: 'SESSION_INVALID',
    });
    expect((await f.log()).filter((line) => line.endsWith('/prompt_async'))).toHaveLength(1);
    const run = await runs.get(runId);
    expect(run.state).not.toBe('reconcile_required');
    expect(run.steps.filter((step) => step.intent.kind === 'model').at(-1)?.nativeCheckpoint?.payload).toMatchObject({
      state: 'idle',
      nativeSessionId: first.nativeSession!.opaqueRef,
    });
    const resumed = await driver.request(f.turn('resume', runId, input('second')));
    expect(resumed.continuity).toEqual({ origin: 'restarted-fresh', detail: RESTARTED_FRESH_DETAIL });
    expect(resumed.nativeSession?.opaqueRef).not.toBe(first.nativeSession?.opaqueRef);
    expect(resumed.response?.text).toBe(`answer:second (turn 1 of ${resumed.nativeSession!.opaqueRef})`);
  });
});
