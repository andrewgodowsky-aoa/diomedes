/**
 * H05: the kept ACP conversation through the shared native conversation driver
 * and RunService, against the real fixture agent process: durable turns with
 * the ACP session id, Stop recorded on the turn, and a Diomedes restart in the
 * middle of a turn reconciled from the durable record — resumed with
 * session/load where the agent supports it, otherwise ended as unable to
 * resume, never left Running and never resent. Live Cursor is not reached.
 */
import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { FileRunStore } from '../server/harness/run-store.js';
import { RunService } from '../server/harness/run-service.js';
import { ClaudeSessionRuns, type ClaudeSessionTurn } from '../server/harness/claude-session-run.js';
import {
  acpSessionRunId,
  CURSOR_SESSION_CAPABILITY,
  CURSOR_SESSION_PROFILE,
} from '../server/harness/acp-session-run.js';
import { validateNativeCheckpoint } from '../server/harness/opencode-session-run.js';
import { textDispatchAuthorizer } from '../server/harness/text-route.js';
import { streamChecks } from '../server/harness/conformance.js';
import { CursorAdapter, CURSOR_ACCOUNT_ROUTE } from '../server/engines/cursor.js';
import type { AcpSessionCheckpoint } from '../server/engines/acp-session.js';
import type { TextRequest } from '../server/engines/contract.js';

const FIXTURE = fileURLToPath(new URL('./fixtures/acp-agent.mjs', import.meta.url));
const roots: string[] = [];
const drivers: ClaudeSessionRuns<AcpSessionCheckpoint>[] = [];
afterEach(async () => {
  for (const driver of drivers.splice(0)) await driver.closeAll().catch(() => undefined);
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

const input = (requestId: string, prompt = requestId): TextRequest => ({
  projectId: 'p1',
  threadId: 't1',
  requestId,
  model: 'fixture-model',
  accountRoute: CURSOR_ACCOUNT_ROUTE,
  instructions: 'Answer plainly.',
  prompt,
  documents: [],
});

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'diomedes acp runtime '));
  roots.push(root);
  const env: Record<string, string> = { ACP_FIXTURE_LOG: path.join(root, 'methods.log') };
  const adapter = new CursorAdapter(path.join(root, 'agent'), root, {
    spawn: (_file, _args, options) =>
      spawn(process.execPath, [FIXTURE], {
        ...options,
        env: { ...options.env, ...env },
      }) as ChildProcessWithoutNullStreams,
    capture: (async (options: { args: string[] }) =>
      options.args.includes('--version')
        ? { code: 0, stdout: '2026.08.11-e8db854' }
        : {
            code: 0,
            stdout: JSON.stringify({ status: 'authenticated', isAuthenticated: true }),
          }) as never,
    startupTimeoutMs: 5_000,
    requestTimeoutMs: 10_000,
  });
  const storage = new FileRunStore(path.join(root, 'runs'));
  const settings = { cursor: true, cursorAccountRoute: CURSOR_ACCOUNT_ROUTE };
  const driverFor = () => {
    const authorize = textDispatchAuthorizer(() => settings, [CURSOR_SESSION_CAPABILITY.id]);
    const runs: RunService = new RunService(storage, {
      validateNativeCheckpoint,
      authorizeEgress: async (runId, intent, _principal, phase) =>
        authorize(await runs.get(runId), intent, phase),
    });
    const driver = new ClaudeSessionRuns(runs, { profile: CURSOR_SESSION_PROFILE });
    // Synthetic policy for this standalone driver: sharing is allowed.
    driver.setSharingPolicy(() => {});
    drivers.push(driver);
    return { runs, driver };
  };
  const turn = (
    mode: ClaudeSessionTurn['mode'],
    runId: string,
    request: TextRequest,
  ): ClaudeSessionTurn<AcpSessionCheckpoint> => ({
    mode,
    runId,
    input: request,
    admit: async () => ({
      location: 'cursor',
      version: '2026.08.11',
      model: request.model,
      accountRoute: request.accountRoute,
    }),
    open: (_admission, wire, options) => adapter.openSession(wire, options),
  });
  const methods = async () =>
    (await fs.readFile(env.ACP_FIXTURE_LOG, 'utf8').catch(() => '')).split('\n').filter(Boolean);
  return { root, env, driverFor, turn, methods };
}
const runId = acpSessionRunId('cursor')('p1', 'lineage-1');

const checkpointOf = (run: Awaited<ReturnType<RunService['get']>>) =>
  [...run.steps].reverse().find((step) => step.nativeCheckpoint)?.nativeCheckpoint?.payload as
    | AcpSessionCheckpoint
    | undefined;

describe('kept Cursor conversation over the native conversation driver', () => {
  it('records each turn durably with the ACP session id, continued by session/load', async () => {
    const f = await fixture();
    const { driver, runs } = f.driverFor();
    const first = await driver.request(f.turn('start', runId, input('first')));
    const second = await driver.request(f.turn('follow-up', runId, input('second')));
    expect(first.response?.text).toBe('answer after 0 earlier turns');
    expect(second.response?.text).toBe('answer after 1 earlier turns');
    expect(second.nativeSession).toEqual(first.nativeSession);
    expect(first.nativeSession?.providerId).toBe('cursor');
    expect(second.continuity).toBeUndefined();
    const run = await runs.get(runId);
    expect(run.capabilityId).toBe(CURSOR_SESSION_CAPABILITY.id);
    expect(checkpointOf(run)).toMatchObject({
      nativeSessionId: first.nativeSession!.opaqueRef,
      state: 'idle',
      origin: 'loaded',
      loadSession: true,
      turns: 2,
    });
    expect(run.steps.find((step) => step.intent.kind === 'model')?.origin).toMatchObject({
      engine: { id: 'cursor', version: '2026.08.11' },
      model: { requested: 'fixture-model', reported: 'fixture-model', source: 'runtime' },
    });
    expect(streamChecks(run).filter((check) => check.outcome === 'failed')).toEqual([]);
  });

  it('says on every turn that an agent without loadSession started fresh', async () => {
    const f = await fixture();
    f.env.ACP_FIXTURE_LOAD = '0';
    const { driver } = f.driverFor();
    await driver.request(f.turn('start', runId, input('first')));
    const second = await driver.request(f.turn('follow-up', runId, input('second')));
    expect(second.response?.text).toBe('answer after 0 earlier turns');
    expect(second.continuity).toMatchObject({
      origin: 'load-unsupported',
      detail: expect.stringMatching(/started a fresh Cursor session/),
    });
  });

  it('a Stop is recorded as an interruption, with how the agent took it', async () => {
    const f = await fixture();
    const { driver, runs } = f.driverFor();
    await driver.request(f.turn('start', runId, input('first')));
    const running = driver.request(f.turn('follow-up', runId, input('stop-me', 'hang please')));
    await expect
      .poll(async () => (await f.methods()).filter((method) => method === 'session/prompt').length)
      .toBe(2);
    expect(await driver.interruptCommand('p1', runId, 'stop-me')).toEqual({ state: 'requested' });
    const stopped = await running;
    expect(stopped).toMatchObject({ response: null, interrupted: true });
    expect(await driver.turnResult('p1', runId, 'stop-me')).toEqual({ answered: false, interrupted: true });
    expect(checkpointOf(await runs.get(runId))).toMatchObject({ state: 'idle', lastStop: 'acknowledged' });
    const next = await driver.request(f.turn('follow-up', runId, input('after')));
    expect(next.response?.text).toBe('answer after 1 earlier turns');
  });

  it('a restart mid-turn is reconciled from the record and resumed with session/load, never resent', async () => {
    const f = await fixture();
    const before = f.driverFor();
    const first = await before.driver.request(f.turn('start', runId, input('first')));
    // A turn is running when Diomedes stops: the busy checkpoint with the session id is on disk.
    const lost = before.driver.request(f.turn('follow-up', runId, input('lost', 'hang please')));
    await expect
      .poll(async () => checkpointOf(await before.runs.get(runId))?.state)
      .toBe('busy');
    // The new process of Diomedes recovers from the durable record alone.
    const after = f.driverFor();
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
    const reconcile = recovered.events.find(
      (event) => event.type === 'step.cancelled' && event.stepId === interrupted?.intent.stepId,
    );
    expect(reconcile?.attributes).toMatchObject({ resent: false, afterSeq: expect.any(Number) });
    expect(checkpointOf(recovered)).toMatchObject({
      state: 'idle',
      origin: 'recovered',
      interruptedRequestId: 'lost',
      nativeSessionId: first.nativeSession!.opaqueRef,
    });
    expect(streamChecks(recovered).filter((check) => check.outcome === 'failed')).toEqual([]);
    // A follow-up needs a live connection; after a restart the resume is explicit.
    await expect(
      after.driver.request(f.turn('follow-up', runId, input('too-soon'))),
    ).rejects.toMatchObject({ code: 'RESUME_REQUIRED' });
    const resumed = await after.driver.request(f.turn('resume', runId, input('resumed')));
    expect(resumed.response?.text).toBe('answer after 1 earlier turns');
    expect(resumed.nativeSession).toEqual(first.nativeSession);
    expect(resumed.continuity).toMatchObject({
      detail: expect.stringMatching(/restarted while an earlier message was being answered.*not completed or resent/),
    });
    // The interrupted command is never answered from the record, and never sent again.
    expect(await after.driver.turnResult('p1', runId, 'lost')).toBeNull();
    const prompts = (await f.methods()).filter((method) => method === 'session/prompt');
    expect(prompts).toHaveLength(3);
  });

  it('a restart mid-turn without loadSession ends the conversation as unable to resume, not Running', async () => {
    const f = await fixture();
    f.env.ACP_FIXTURE_LOAD = '0';
    const before = f.driverFor();
    await before.driver.request(f.turn('start', runId, input('first')));
    const lost = before.driver.request(f.turn('follow-up', runId, input('lost', 'hang please')));
    await expect
      .poll(async () => checkpointOf(await before.runs.get(runId))?.state)
      .toBe('busy');
    const after = f.driverFor();
    await after.driver.recover(await after.runs.get(runId));
    await before.driver.closeAll().catch(() => undefined);
    await lost.catch(() => undefined);
    const ended = await after.runs.get(runId);
    expect(ended.state).toBe('cancelled');
    expect(ended.cancelReason).toMatch(/cannot continue a saved session, so this conversation couldn't resume\. Start again\./);
    await expect(
      after.driver.request(f.turn('resume', runId, input('resumed'))),
    ).rejects.toMatchObject({ code: 'RECONCILE_REQUIRED' });
    expect(streamChecks(ended).filter((check) => check.outcome === 'failed')).toEqual([]);
  });
});
