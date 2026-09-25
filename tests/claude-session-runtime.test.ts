import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import type { NativeCheckpoint } from '../shared/harness.js';
import { FileRunStore } from '../server/harness/run-store.js';
import { RunService, Suspended } from '../server/harness/run-service.js';
import {
  CLAUDE_SESSION_CAPABILITY,
  validateClaudeNativeCheckpoint,
} from '../server/harness/claude-session-run.js';
import { localHarnessPrincipal } from '../server/harness/bridge.js';
import { ClaudeSessionRuns, type ClaudeSessionTurn } from '../server/harness/claude-session-run.js';
import {
  prepareClaudeSession,
  type ClaudeSessionOptions,
} from '../server/engines/claude-session.js';
import type { TextRequest } from '../server/engines/contract.js';
import { EngineError } from '../server/engines/process.js';
import { digest } from '../server/harness/policy.js';
import { textDispatchAuthorizer } from '../server/harness/text-route.js';

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});
const principal = localHarnessPrincipal('p');
async function setup() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-runtime-'));
  roots.push(root);
  const storage = new FileRunStore(root);
  const runs: RunService = new RunService(storage, {
    validateNativeCheckpoint: validateClaudeNativeCheckpoint,
  });
  await runs.start({
    id: 'run',
    projectId: 'p',
    tenantId: principal.tenantId,
    principal,
    capability: CLAUDE_SESSION_CAPABILITY,
    budget: { units: 10, modelCalls: 10, toolCalls: 10, wallMs: null },
  });
  await runs.claim('run', 'owner');
  return { root, storage, runs };
}
test('waiting input uses the existing event state while ordinary failures remain retry-wait', async () => {
  const { runs } = await setup();
  const wait = {
    id: 'wait',
    version: '1',
    kind: 'wait' as const,
    effect: 'pure' as const,
    maxAttempts: 2,
  };
  await expect(
    runs.step(
      'run',
      'owner',
      wait,
      () => {
        throw new Suspended('event', 'Awaiting input');
      },
      principal,
    ),
  ).rejects.toBeInstanceOf(Suspended);
  expect((await runs.get('run')).state).toBe('waiting');
  expect((await runs.get('run')).steps[0].state).toBe('waiting_event');
  await runs.step('run', 'owner', wait, () => ({ received: true }), principal);
  await expect(
    runs.step(
      'run',
      'owner',
      { id: 'ordinary', version: '1', effect: 'pure' },
      () => {
        throw new Error('retry');
      },
      principal,
    ),
  ).rejects.toThrow('retry');
  expect((await runs.get('run')).steps.at(-1)?.state).toBe('retry_wait');
});
test('late checkpoint callbacks cannot mutate a settled step even with the same live owner', async () => {
  const { runs } = await setup();
  let save!: (checkpoint: NativeCheckpoint) => Promise<void>;
  await runs.step(
    'run',
    'owner',
    { id: 'step', version: '1', effect: 'pure' },
    (context) => {
      save = context.saveNativeCheckpoint!;
      return null;
    },
    principal,
  );
  await expect(save({ v: 1, providerId: 'claude-code', payload: {} })).rejects.toMatchObject({
    code: 'stale_attempt',
  });
  expect((await runs.get('run')).steps[0].nativeCheckpoint).toBeUndefined();
});

const input: TextRequest = {
  projectId: 'p',
  threadId: 't',
  requestId: 'one',
  prompt: 'hello',
  documents: [],
  instructions: 'Be concise',
  model: 'claude-test',
  accountRoute: 'claude-code:claude.ai',
};
async function runtime(options: { connectionLifetimeMs?: number } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-driver-'));
  roots.push(root);
  const storage = new FileRunStore(root);
  const settings = { 'claude-code': true, 'claude-codeAccountRoute': input.accountRoute };
  const authorize = textDispatchAuthorizer(() => settings, [CLAUDE_SESSION_CAPABILITY.id]);
  const runs: RunService = new RunService(storage, {
    validateNativeCheckpoint: validateClaudeNativeCheckpoint,
    authorizeEgress: async (runId, intent, _principal, phase) =>
      authorize(await runs.get(runId), intent, phase),
  });
  const driver = new ClaudeSessionRuns(runs, options);
  // Synthetic test policy for this standalone driver fixture: allow cloud
  // sharing so the session behaviors under test are exercised.
  driver.setSharingPolicy(() => {});
  let opened = 0,
    sent = 0,
    closed = 0;
  let duringTurn: (() => Promise<void>) | undefined;
  let fail = false;
  const sessionOptions: ClaudeSessionOptions[] = [];
  const request = (
    mode: ClaudeSessionTurn['mode'],
    id: string,
    runId = 'native',
    sourceRunId?: string,
  ): ClaudeSessionTurn => ({
    mode,
    runId,
    sourceRunId,
    input: { ...input, requestId: id },
    admit: async () => ({
      location: 'fixture',
      version: '2.1.252',
      model: input.model,
      accountRoute: input.accountRoute,
    }),
    open: async (_admission, value, opts) => {
      opened++;
      sessionOptions.push(opts);
      const prepared = prepareClaudeSession(
        value,
        opts,
        { email: 'fixture@invalid.example' },
        root,
        '2.1.252',
      );
      let checkpoint = prepared.checkpoint;
      return {
        get checkpoint() {
          return structuredClone(checkpoint);
        },
        get nativeSession() {
          return checkpoint.nativeSessionId && checkpoint.reportedModel
            ? {
                providerId: 'claude-code',
                lineageId: checkpoint.lineageId,
                opaqueRef: checkpoint.nativeSessionId,
              }
            : null;
        },
        close: async () => {
          closed++;
        },
        interrupt: async () => undefined,
        turn: async (turn) => {
          checkpoint = {
            ...checkpoint,
            state: 'busy',
            requests: [...checkpoint.requests, { id: turn.requestId, digest: digest(turn.prompt) }],
          };
          await opts.onCheckpoint(checkpoint, turn.signal!);
          // The fixture transport's dispatch boundary sees the durable busy metadata first.
          expect((await runs.get(runId)).steps.at(-1)?.nativeCheckpoint?.payload).toMatchObject({
            state: 'busy',
          });
          sent++;
          await duringTurn?.();
          if (fail) throw new EngineError('DISPATCH_UNCERTAIN', 'fixture unknown completion');
          checkpoint = {
            ...checkpoint,
            nativeSessionId: checkpoint.nativeSessionId ?? '00000000-0000-4000-8000-000000000001',
            reportedModel: 'claude-test',
            state: 'idle',
            results: [...checkpoint.results, { id: turn.requestId, digest: digest('answer') }],
          };
          await opts.onCheckpoint(checkpoint, turn.signal!);
          return {
            projectId: turn.projectId,
            threadId: turn.threadId,
            requestId: turn.requestId,
            model: 'claude-test',
            version: '2.1.252',
            text: 'answer',
          };
        },
      };
    },
  });
  return {
    root,
    storage,
    runs,
    driver,
    request,
    options: sessionOptions,
    settings,
    counters: () => ({ opened, sent, closed }),
    during: (hook: () => Promise<void>) => {
      duringTurn = hook;
    },
    fail: () => {
      fail = true;
    },
  };
}

test('sequential turns share the process and durable replays never dispatch or consume budget again', async () => {
  const f = await runtime();
  const first = await f.driver.request(f.request('start', 'one'));
  expect((await f.runs.get('native')).state).toBe('waiting');
  expect(await f.driver.request(f.request('start', 'one'))).toEqual(first);
  await f.driver.request(f.request('follow-up', 'two'));
  expect(f.counters()).toMatchObject({ opened: 1, sent: 2 });
  expect((await f.runs.get('native')).used.modelCalls).toBe(2);
  const collision = f.request('follow-up', 'two');
  collision.input.prompt = 'changed';
  await expect(f.driver.request(collision)).rejects.toMatchObject({ code: 'intent_mismatch' });
  expect(f.counters().sent).toBe(2);
  await f.driver.closeAll();
});

test('close receipts replay and explicit resume validates the saved idle checkpoint', async () => {
  const f = await runtime();
  await f.driver.request(f.request('start', 'one'));
  const receipt = await f.driver.control('p', 'native', 'close-1', 'close');
  expect(await f.driver.control('p', 'native', 'close-1', 'close')).toEqual(receipt);
  await expect(f.driver.request(f.request('follow-up', 'two'))).rejects.toMatchObject({
    code: 'RESUME_REQUIRED',
  });
  await f.driver.request(f.request('resume', 'two'));
  expect(f.options[1].restore).toMatchObject({ state: 'idle', projectId: 'p', threadId: 't' });
  expect(f.counters()).toMatchObject({ opened: 2, sent: 2, closed: 1 });
  await expect(f.driver.get('foreign', 'native')).rejects.toMatchObject({ code: 'unknown_run' });
  await f.driver.closeAll();
});

test('fork records parent lineage but copies no provider checkpoint into its portable pure prefix', async () => {
  const f = await runtime();
  await f.driver.request(f.request('start', 'one'));
  await f.driver.request(f.request('fork', 'fork-one', 'child', 'native'));
  const child = await f.runs.get('child');
  expect(child.parentRunId).toBe('native');
  expect(child.transcripts).toEqual({});
  expect(
    child.steps.filter((step) => step.intent.kind === 'model' && step.nativeCheckpoint),
  ).toHaveLength(1);
  expect(child.steps.find((step) => step.intent.stepId === 'fork:source')).toMatchObject({
    intent: { effect: 'read' },
    nativeCheckpoint: { providerId: 'claude-code' },
  });
  expect(f.options[1].fork).toBe(true);
  expect(f.options[1].restore?.nativeSessionId).toBeTruthy();
  expect((await f.driver.status('p', 'child')).nativeSession?.opaqueRef).not.toBe(
    (await f.driver.status('p', 'native')).nativeSession?.opaqueRef,
  );
  await f.driver.closeAll();
});

test('unknown dispatch stays uncertain across restart and refuses resume without sending again', async () => {
  const f = await runtime();
  f.fail();
  await expect(f.driver.request(f.request('start', 'one'))).rejects.toMatchObject({
    code: 'DISPATCH_UNCERTAIN',
  });
  const saved = await f.runs.get('native');
  expect(saved.state).toBe('reconcile_required');
  expect(saved.steps.at(-1)?.nativeCheckpoint?.payload).toMatchObject({ state: 'busy' });
  const restarted = new ClaudeSessionRuns(
    new RunService(f.storage, { validateNativeCheckpoint: validateClaudeNativeCheckpoint }),
  );
  // Same synthetic fixture policy for the restarted driver.
  restarted.setSharingPolicy(() => {});
  await restarted.recover(saved);
  await expect(restarted.request(f.request('resume', 'two'))).rejects.toMatchObject({
    code: 'RECONCILE_REQUIRED',
  });
  expect(f.counters()).toMatchObject({ opened: 1, sent: 1 });
});

test('a second caller joins the exact active command but cannot enqueue new work or reuse settled runs', async () => {
  const f = await runtime();
  let release!: () => void, entered!: () => void;
  const reached = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const block = new Promise<void>((resolve) => {
    release = resolve;
  });
  f.during(async () => {
    entered();
    await block;
  });
  const first = f.driver.request(f.request('start', 'one'));
  await Promise.race([reached, first]);
  expect(f.driver.request(f.request('start', 'one'))).toBe(first);
  await expect(f.driver.request(f.request('follow-up', 'two'))).rejects.toMatchObject({
    code: 'SESSION_BUSY',
  });
  release();
  await first;
  await f.runs.cancel('native', 'done', principal);
  await expect(f.driver.request(f.request('follow-up', 'two'))).rejects.toMatchObject({
    code: 'RECONCILE_REQUIRED',
  });
  expect(f.counters().sent).toBe(1);
  await f.driver.closeAll();
});

test('checkpoint callback from a closed transport cannot attach to a resumed process', async () => {
  const f = await runtime();
  await f.driver.request(f.request('start', 'one'));
  const saved = (await f.runs.get('native')).steps.find(
    (s) => s.nativeCheckpoint,
  )!.nativeCheckpoint!;
  await f.driver.control('p', 'native', 'close', 'close');
  f.during(async () => {
    await expect(
      f.options[0].onCheckpoint(saved.payload as never, new AbortController().signal),
    ).rejects.toMatchObject({ code: 'stale_attempt' });
  });
  await f.driver.request(f.request('resume', 'two'));
  await f.driver.closeAll();
});

test('strict checkpoint validation applies before writes and again on disk reload', async () => {
  const f = await runtime();
  await f.driver.request(f.request('start', 'one'));
  const record = await f.runs.get('native');
  const saved = record.steps.find((s) => s.nativeCheckpoint)!.nativeCheckpoint!;
  expect(JSON.stringify(saved)).not.toContain(input.prompt);
  const { runs } = await setup();
  await expect(
    runs.step(
      'run',
      'owner',
      { id: 'invalid', version: '1', effect: 'pure' },
      (context) =>
        context.saveNativeCheckpoint!({
          ...saved,
          payload: { ...(saved.payload as object), rawPrompt: 'never metadata' },
        }),
      principal,
    ),
  ).rejects.toMatchObject({ code: 'invalid_checkpoint' });
  expect((await runs.get('run')).steps[0].nativeCheckpoint).toBeUndefined();
  record.steps.find((s) => s.nativeCheckpoint)!.nativeCheckpoint = {
    ...saved,
    payload: {
      ...(saved.payload as object),
      requests: Array(129).fill({ id: 'x', digest: 'a'.repeat(64) }),
    },
  };
  await f.storage.write(record);
  await expect(f.runs.get('native')).rejects.toMatchObject({ code: 'invalid_checkpoint' });
  await f.driver.closeAll();
});

test('expired callback signals are checked inside the durable step queue before mutation', async () => {
  const { runs } = await setup();
  const signal = AbortSignal.abort();
  await runs.step(
    'run',
    'owner',
    { id: 'expiry', version: '1', effect: 'pure' },
    async (context) => {
      await expect(
        context.saveNativeCheckpoint!({ v: 1, providerId: 'claude-code', payload: {} }, signal),
      ).rejects.toMatchObject({ code: 'stale_attempt' });
      return null;
    },
    principal,
  );
  expect((await runs.get('run')).steps[0].nativeCheckpoint).toBeUndefined();
});

test('Settings authorizer admits only the explicit native capability addition', async () => {
  const { runs } = await setup();
  const run = await runs.get('run');
  const definition = { destination: 'external', input: { engine: 'claude-code' } } as never;
  run.input = { accountRoute: input.accountRoute };
  const settings = { 'claude-code': true, 'claude-codeAccountRoute': input.accountRoute };
  await expect(
    textDispatchAuthorizer(() => settings)(run, definition, 'dispatch'),
  ).rejects.toMatchObject({ code: 'egress_denied' });
  const native = textDispatchAuthorizer(
    () => settings,
    ['engine-text-turn', CLAUDE_SESSION_CAPABILITY.id],
  );
  await expect(native(run, definition, 'dispatch')).resolves.toBeUndefined();
  run.capabilityId = 'unrelated-native-session';
  await expect(native(run, definition, 'dispatch')).rejects.toMatchObject({
    code: 'egress_denied',
  });
});

test('Settings revocation at the result boundary closes the process and cannot commit a successful turn', async () => {
  const f = await runtime();
  f.during(async () => {
    f.settings['claude-code'] = false;
  });
  await expect(f.driver.request(f.request('start', 'one'))).rejects.toMatchObject({
    code: 'egress_denied',
  });
  const run = await f.runs.get('native');
  expect(run.state).toBe('reconcile_required');
  expect(run.steps.find((step) => step.intent.kind === 'model')?.state).toBe('reconcile_required');
  expect(f.counters()).toMatchObject({ sent: 1, closed: 1 });
  expect((await f.driver.status('p', 'native')).connected).toBe(false);
});

test('interrupt acknowledgment is durable while the active turn still owns its completion', async () => {
  const f = await runtime();
  let release!: () => void, entered!: () => void;
  const reached = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const block = new Promise<void>((resolve) => {
    release = resolve;
  });
  f.during(async () => {
    entered();
    await block;
  });
  const turn = f.driver.request(f.request('start', 'one'));
  await Promise.race([turn, reached]);
  const receipt = await f.driver.control('p', 'native', 'interrupt-one', 'interrupt');
  expect(receipt).toMatchObject({ acknowledged: true, turnCompleted: false });
  expect(
    (await f.runs.get('native')).steps.find((step) => step.intent.kind === 'model')?.state,
  ).toBe('running');
  release();
  await turn;
  await f.driver.closeAll();
});

test('portable pure-prefix forks strip native references from otherwise reusable observations', async () => {
  const f = await runtime();
  await f.driver.request(f.request('start', 'one'));
  const checkpoint = (await f.runs.get('native')).steps.find(
    (s) => s.nativeCheckpoint,
  )!.nativeCheckpoint!;
  const { runs } = await setup();
  await runs.step(
    'run',
    'owner',
    { id: 'pure', version: '1', effect: 'pure' },
    async (context) => {
      await context.saveNativeCheckpoint!(checkpoint);
      return 'portable observation';
    },
    principal,
  );
  await runs.step(
    'run',
    'owner',
    { id: 'point', version: '1', effect: 'pure' },
    () => null,
    principal,
  );
  const child = await runs.fork('run', 'portable-child', 'point', principal);
  expect(child.steps[0].output).toBe('portable observation');
  expect(child.steps[0].nativeCheckpoint).toBeUndefined();
  await f.driver.closeAll();
});

test('failed fork admission preserves its pinned source and retries without an earlier model dispatch', async () => {
  const f = await runtime();
  await f.driver.request(f.request('start', 'one'));
  const fork = f.request('fork', 'fork-one', 'child', 'native');
  const admit = fork.admit;
  let attempts = 0;
  fork.admit = async (signal) => {
    if (++attempts === 1) throw new EngineError('AUTH_REQUIRED', 'fixture admission failed');
    return admit(signal);
  };
  await expect(f.driver.request(fork)).rejects.toMatchObject({ code: 'AUTH_REQUIRED' });
  const failed = await f.runs.get('child');
  expect(failed.steps.some((step) => step.intent.kind === 'model')).toBe(false);
  expect(
    failed.steps.find((step) => step.intent.stepId === 'fork:source')?.nativeCheckpoint,
  ).toBeDefined();
  expect(f.counters()).toMatchObject({ sent: 1, opened: 1 });
  await f.driver.request(fork);
  expect(attempts).toBe(2);
  expect(f.counters()).toMatchObject({ sent: 2, opened: 2 });
  expect(f.options[1]).toMatchObject({ fork: true, restore: { state: 'idle' } });
  await f.driver.closeAll();
});

test('fork retry refuses a changed parent before any child model execution', async () => {
  const f = await runtime();
  await f.driver.request(f.request('start', 'one'));
  const fork = f.request('fork', 'fork-one', 'child', 'native');
  fork.admit = async () => {
    throw new EngineError('AUTH_REQUIRED', 'fixture');
  };
  await expect(f.driver.request(fork)).rejects.toMatchObject({ code: 'AUTH_REQUIRED' });
  await f.driver.request(f.request('follow-up', 'two'));
  await expect(
    f.driver.request(f.request('fork', 'fork-one', 'child', 'native')),
  ).rejects.toMatchObject({ code: 'SESSION_MISMATCH' });
  expect((await f.runs.get('child')).steps.some((step) => step.intent.kind === 'model')).toBe(
    false,
  );
  expect(f.counters()).toMatchObject({ sent: 2, opened: 1 });
  await f.driver.closeAll();
});

test('generic cancellation disposes an idle owned connection and terminal close remains idempotent', async () => {
  const f = await runtime();
  await f.driver.request(f.request('start', 'one'));
  await f.runs.cancel('native', 'stop from generic Harness endpoint', principal);
  expect((await f.driver.status('p', 'native')).connected).toBe(false);
  expect(f.counters().closed).toBe(1);
  await expect(
    f.driver.control('p', 'native', 'close-after-cancel', 'close'),
  ).resolves.toMatchObject({ acknowledged: true });
  expect(f.counters().closed).toBe(1);
  expect((await f.runs.get('native')).state).toBe('cancelled');
  await f.driver.closeAll();
});

test('terminal close can clean up a completed run without creating another durable step', async () => {
  const f = await runtime();
  await f.driver.request(f.request('start', 'one'));
  const before = await f.runs.get('native');
  await f.runs.complete('native', before.owner!, null);
  await f.driver.control('p', 'native', 'terminal-close', 'close');
  expect(f.counters().closed).toBe(1);
  expect((await f.runs.get('native')).steps).toHaveLength(before.steps.length);
  await f.driver.closeAll();
});

test('a lifetime that ends mid-turn lets the turn finish, then closes the connection', async () => {
  const f = await runtime({ connectionLifetimeMs: 50 });
  // The turn outlasts the lifetime, as a slow machine or a long answer does.
  f.during(() => new Promise((resolve) => setTimeout(resolve, 150)));
  const answer = await f.driver.request(f.request('start', 'one'));
  expect(answer.response?.text).toBe('answer');
  await vi.waitFor(() => expect(f.counters().closed).toBe(1), { timeout: 1500, interval: 20 });
  expect((await f.driver.status('p', 'native')).connected).toBe(false);
  await f.driver.closeAll();
});

test('owned lifetime timer closes an idle connection while leaving known metadata resumable', async () => {
  const f = await runtime({ connectionLifetimeMs: 200 });
  await f.driver.request(f.request('start', 'one'));
  await vi.waitFor(() => expect(f.counters().closed).toBe(1), { timeout: 1500, interval: 20 });
  expect((await f.driver.status('p', 'native')).connected).toBe(false);
  await expect(f.driver.request(f.request('follow-up', 'two'))).rejects.toMatchObject({
    code: 'RESUME_REQUIRED',
  });
  await f.driver.request(f.request('resume', 'two'));
  expect(f.counters()).toMatchObject({ opened: 2, sent: 2 });
  await f.driver.closeAll();
});
