/**
 * Message-scoped Stop on the two conversation drivers. `interruptCommand`
 * validates the project and run through the driver's own `get`, then compares
 * and signals the active entry in one synchronous block. Both drivers run for
 * real over a FileRunStore-backed RunService; only the provider transports are
 * faked, with explicit gates so each schedule is exact and no runtime state is
 * forged. `requested` is asserted as a transport acknowledgement only; the two
 * drivers record the stopped turn differently, and each test asserts that
 * driver's real durable outcome through `turnResult` and replay.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import type { HarnessRun, ModelRequest, ModelResult } from '../shared/harness.js';
import { prepareClaudeSession } from '../server/engines/claude-session.js';
import type { TextRequest } from '../server/engines/contract.js';
import { EngineError } from '../server/engines/process.js';
import { AWS_MODEL_CONTRACT } from '../server/harness/aws-model-adapter.js';
import { localHarnessPrincipal } from '../server/harness/bridge.js';
import {
  CLAUDE_SESSION_CAPABILITY,
  ClaudeSessionRuns,
  validateClaudeNativeCheckpoint,
  type ClaudeSessionTurn,
} from '../server/harness/claude-session-run.js';
import {
  MODEL_CONVERSATION_CAPABILITY,
  ModelSessionRuns,
  modelApiDispatchAuthorizer,
  type ModelSessionTurn,
} from '../server/harness/model-session-run.js';
import type { ModelAdapter } from '../server/harness/native-agent.js';
import { digest } from '../server/harness/policy.js';
import { FileRunStore } from '../server/harness/run-store.js';
import { RunService } from '../server/harness/run-service.js';
import { textDispatchAuthorizer } from '../server/harness/text-route.js';

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

/**
 * Attaches handlers to a turn promise the moment it is created, so a turn that
 * rejects while the test is still arranging later steps is never an unhandled
 * rejection. Awaiting the returned promise yields the settlement, never throws.
 */
const watch = <T>(promise: Promise<T>) =>
  promise.then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error }),
  );

/**
 * Provider-call gates keyed by the command each turn serves. `dispatch` is the
 * only thing a fake transport does while a call is in flight: it records that
 * the call was entered, holds until the test releases it, and rejects the way a
 * real transport does when its signal fires. A command never armed answers
 * immediately.
 */
function heldTransports() {
  const gates = new Map<string, { gate: Promise<void>; arrived: () => void }>();
  const dispatches = new Map<string, number>();
  const stopped = new Set<string>();
  return {
    hold(commandId: string) {
      const arrived = deferred();
      const release = deferred();
      gates.set(commandId, { gate: release.promise, arrived: arrived.resolve });
      return { entered: arrived.promise, release: release.resolve };
    },
    async dispatch(commandId: string, signal: AbortSignal | undefined): Promise<void> {
      dispatches.set(commandId, (dispatches.get(commandId) ?? 0) + 1);
      const held = gates.get(commandId);
      held?.arrived();
      await new Promise<void>((resolve, reject) => {
        const onAbort = () => {
          stopped.add(commandId);
          reject(new EngineError('CANCELLED', 'The fixture transport observed the stop.'));
        };
        if (signal?.aborted) return onAbort();
        signal?.addEventListener('abort', onAbort, { once: true });
        (held?.gate ?? Promise.resolve()).then(() => {
          signal?.removeEventListener('abort', onAbort);
          resolve();
        });
      });
    },
    sent: (commandId: string) => dispatches.get(commandId) ?? 0,
    aborted: (commandId: string) => stopped.has(commandId),
  };
}

type InterruptAck = { state: 'requested' | 'idle' | 'superseded' };
type TurnOutcome = { response: { text: string } | null; interrupted: boolean };

interface Fixture {
  projectId: string;
  runId: string;
  driver: {
    interruptCommand(projectId: string, runId: string, commandId: string): Promise<InterruptAck>;
    turnResult(
      projectId: string,
      runId: string,
      commandId: string,
    ): Promise<{ answered: boolean; interrupted: boolean } | null>;
    closeAll(): Promise<void>;
  };
  transports: ReturnType<typeof heldTransports>;
  send(commandId: string, mode?: 'start' | 'follow-up'): Promise<TurnOutcome>;
  /** Creates the conversation run with the same scope input the driver's first send would write. */
  seed(): Promise<void>;
  /**
   * Makes the driver's next `get` wait on the returned release before it reads
   * the run. One shot: later reads pass through. A schedule gate only; the read
   * itself is the driver's own.
   */
  delayNextGet(): { release(): void };
  /**
   * What a signal-stopped turn leaves behind, per driver. 'interrupted': the
   * provider call sits in a child run, so the parent's turn step commits
   * `{interrupted: true}` and the request resolves. 'uncertain': the turn is the
   * external step itself, the provider never acknowledged, the request rejects
   * CANCELLED, and the run lands reconcile_required with nothing for turnResult
   * to read.
   */
  stoppedTurn: 'interrupted' | 'uncertain';
}

const CLAUDE_INPUT: TextRequest = {
  projectId: 'p',
  threadId: 't',
  requestId: '',
  prompt: 'hello',
  documents: [],
  instructions: 'Be concise',
  model: 'claude-test',
  accountRoute: 'claude-code:claude.ai',
};

async function claudeFixture(): Promise<Fixture> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'interrupt-claude-'));
  roots.push(root);
  const storage = new FileRunStore(root);
  const settings = { 'claude-code': true, 'claude-codeAccountRoute': CLAUDE_INPUT.accountRoute };
  const authorize = textDispatchAuthorizer(() => settings, [CLAUDE_SESSION_CAPABILITY.id]);
  const runs: RunService = new RunService(storage, {
    validateNativeCheckpoint: validateClaudeNativeCheckpoint,
    authorizeEgress: async (runId, intent, _principal, phase) =>
      authorize(await runs.get(runId), intent, phase),
  });
  const driver = new ClaudeSessionRuns(runs);
  let pendingGet: Promise<void> | null = null;
  const realGet = driver.get.bind(driver);
  driver.get = async (projectId: string, runId: string): Promise<HarnessRun> => {
    const wait = pendingGet;
    pendingGet = null;
    if (wait) await wait;
    return realGet(projectId, runId);
  };
  const transports = heldTransports();
  const request = (mode: ClaudeSessionTurn['mode'], commandId: string): ClaudeSessionTurn => ({
    mode,
    runId: 'native',
    input: { ...CLAUDE_INPUT, requestId: commandId },
    admit: async () => ({
      location: 'fixture',
      version: '2.1.252',
      model: CLAUDE_INPUT.model,
      accountRoute: CLAUDE_INPUT.accountRoute,
    }),
    open: async (_admission, value, options) => {
      const prepared = prepareClaudeSession(
        value,
        options,
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
        close: async () => undefined,
        interrupt: async () => undefined,
        turn: async (turn) => {
          checkpoint = {
            ...checkpoint,
            state: 'busy',
            requests: [...checkpoint.requests, { id: turn.requestId, digest: digest(turn.prompt) }],
          };
          await options.onCheckpoint(checkpoint, turn.signal!);
          try {
            await transports.dispatch(turn.requestId, turn.signal);
          } catch (error) {
            // What the real session does when the merged signal fires mid-call:
            // the provider never acknowledged, the checkpoint goes uncertain in
            // memory, nothing new is persisted (the durable record stays busy),
            // and the turn rejects. `state === 'idle'` is reserved for the
            // provider-acknowledged interrupt path; this is not it.
            checkpoint = { ...checkpoint, state: 'uncertain' };
            throw error;
          }
          checkpoint = {
            ...checkpoint,
            reportedModel: 'claude-test',
            state: 'idle',
            results: [...checkpoint.results, { id: turn.requestId, digest: digest('answer') }],
          };
          await options.onCheckpoint(checkpoint, turn.signal!);
          return {
            projectId: turn.projectId,
            threadId: turn.threadId,
            requestId: turn.requestId,
            model: 'claude-test',
            version: '2.1.252',
            text: `answer:${turn.requestId}`,
          };
        },
      };
    },
  });
  return {
    projectId: 'p',
    runId: 'native',
    driver,
    transports,
    stoppedTurn: 'uncertain',
    send: (commandId, mode = 'start') => driver.request(request(mode, commandId)),
    seed: async () => {
      const principal = localHarnessPrincipal('p');
      await runs.start({
        id: 'native',
        projectId: 'p',
        tenantId: principal.tenantId,
        principal,
        capability: CLAUDE_SESSION_CAPABILITY,
        input: {
          engine: 'claude-code',
          projectId: 'p',
          threadId: 't',
          model: CLAUDE_INPUT.model,
          accountRoute: CLAUDE_INPUT.accountRoute,
          instructions: CLAUDE_INPUT.instructions,
        },
        budget: { units: 128, modelCalls: 128, toolCalls: 384, wallMs: null },
      });
    },
    delayNextGet: () => {
      const gate = deferred();
      pendingGet = gate.promise;
      return { release: gate.resolve };
    },
  };
}

const MODEL_INPUT: TextRequest = {
  projectId: 'p',
  threadId: 't',
  requestId: '',
  prompt: 'hello',
  documents: [],
  instructions: 'Be concise',
  model: 'luna-test',
  accountRoute: 'aws-bedrock:aws-bedrock-1@r1',
};

async function modelFixture(): Promise<Fixture> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'interrupt-model-'));
  roots.push(root);
  const storage = new FileRunStore(root);
  const services: Record<string, unknown> = {
    'aws-bedrock': true,
    'aws-bedrockAccountRoute': MODEL_INPUT.accountRoute,
  };
  const authorize = modelApiDispatchAuthorizer(() => services);
  const runs: RunService = new RunService(storage, {
    authorizeEgress: async (runId, intent, _principal, phase) =>
      authorize(await runs.get(runId), intent, phase),
  });
  const driver = new ModelSessionRuns(runs, 'aws-bedrock');
  let pendingGet: Promise<void> | null = null;
  const realGet = driver.get.bind(driver);
  driver.get = async (projectId: string, runId: string): Promise<HarnessRun> => {
    const wait = pendingGet;
    pendingGet = null;
    if (wait) await wait;
    return realGet(projectId, runId);
  };
  const transports = heldTransports();
  const request = (mode: ModelSessionTurn['mode'], commandId: string): ModelSessionTurn => ({
    mode,
    runId: 'conv',
    input: { ...MODEL_INPUT, requestId: commandId },
    admit: async () => ({
      route: 'aws-bedrock',
      connectionId: 'aws-bedrock-1',
      revision: 1,
      model: MODEL_INPUT.model,
      accountRoute: MODEL_INPUT.accountRoute,
    }),
    // The turn's stop signal is bound into every provider call, the same merge
    // the production adapter wiring applies in EngineService.modelSession.
    adapter: async (_admission, _instructions, stop): Promise<ModelAdapter> => ({
      id: 'aws-bedrock',
      version: 'fixture-aws-1',
      contract: AWS_MODEL_CONTRACT,
      destination: 'external',
      capabilities: () => ({
        engineId: 'aws-bedrock',
        engineVersion: 'fixture-aws-1',
        protocolVersion: 'fixture',
        modelCalls: 'enforced',
        toolCalls: 'enforced',
        filesystemWrites: 'unsupported',
        networkEgress: 'observed',
        approvals: 'enforced',
        resumability: 'unsupported',
        cancellability: 'enforced',
        checkpointGranularity: 'step',
        notes: ['Fixture transport for the interrupt tests; nothing reaches a provider.'],
      }),
      complete: async (_request: ModelRequest, signal: AbortSignal): Promise<ModelResult> => {
        await transports.dispatch(commandId, AbortSignal.any([signal, stop]));
        return { response: { type: 'final', text: `answer:${commandId}` } };
      },
    }),
  });
  return {
    projectId: 'p',
    runId: 'conv',
    driver,
    transports,
    stoppedTurn: 'interrupted',
    send: (commandId, mode = 'start') => driver.request(request(mode, commandId)),
    seed: async () => {
      const principal = localHarnessPrincipal('p');
      await runs.start({
        id: 'conv',
        projectId: 'p',
        tenantId: principal.tenantId,
        principal,
        capability: MODEL_CONVERSATION_CAPABILITY,
        input: {
          engine: 'aws-bedrock',
          route: 'aws-bedrock',
          projectId: 'p',
          threadId: 't',
          model: MODEL_INPUT.model,
          accountRoute: MODEL_INPUT.accountRoute,
          instructions: MODEL_INPUT.instructions,
        },
        budget: { units: 128, modelCalls: 128, toolCalls: 384, wallMs: null },
      });
    },
    delayNextGet: () => {
      const gate = deferred();
      pendingGet = gate.promise;
      return { release: gate.resolve };
    },
  };
}

const suite = (label: string, make: () => Promise<Fixture>) =>
  describe(label, () => {
    test('a Stop for the running command is signalled, and the recorded outcome stays the authority', async () => {
      const f = await make();
      const held = f.transports.hold('a');
      const turn = f.send('a');
      let settled = false;
      const outcome = turn.then(
        (value) => {
          settled = true;
          return { ok: true as const, value };
        },
        (error: unknown) => {
          settled = true;
          return { ok: false as const, error };
        },
      );
      await held.entered;
      await expect(f.driver.interruptCommand(f.projectId, f.runId, 'a')).resolves.toEqual({
        state: 'requested',
      });
      // The signal reached this command's transport, and the acknowledgement
      // came back only after the turn's own promise settled.
      expect(f.transports.aborted('a')).toBe(true);
      expect(settled).toBe(true);
      const result = await outcome;
      if (f.stoppedTurn === 'interrupted') {
        expect(result).toMatchObject({ ok: true, value: { interrupted: true, response: null } });
        await expect(f.driver.turnResult(f.projectId, f.runId, 'a')).resolves.toEqual({
          answered: false,
          interrupted: true,
        });
      } else {
        expect(result).toMatchObject({ ok: false, error: { code: 'CANCELLED' } });
        await expect(f.driver.turnResult(f.projectId, f.runId, 'a')).resolves.toBeNull();
      }
      await f.driver.closeAll();
    });

    test('with no active turn the answer is idle, before any turn and again after it settles', async () => {
      const f = await make();
      await f.seed();
      await expect(f.driver.interruptCommand(f.projectId, f.runId, 'a')).resolves.toEqual({
        state: 'idle',
      });
      const held = f.transports.hold('a');
      const outcome = watch(f.send('a'));
      await held.entered;
      await expect(f.driver.interruptCommand(f.projectId, f.runId, 'a')).resolves.toEqual({
        state: 'requested',
      });
      const result = await outcome;
      if (f.stoppedTurn === 'interrupted') expect(result.ok).toBe(true);
      else expect(result).toMatchObject({ ok: false, error: { code: 'CANCELLED' } });
      // The entry is gone with the turn it belonged to: a duplicate Stop is bound to nothing.
      await expect(f.driver.interruptCommand(f.projectId, f.runId, 'a')).resolves.toEqual({
        state: 'idle',
      });
      await f.driver.closeAll();
    });

    test('a Stop for a settled command while another is active answers superseded and aborts nothing', async () => {
      const f = await make();
      const first = f.transports.hold('a');
      const outcomeA = watch(f.send('a'));
      await first.entered;
      first.release();
      expect(await outcomeA).toMatchObject({ ok: true, value: { interrupted: false } });
      const second = f.transports.hold('b');
      const outcomeB = watch(f.send('b', 'follow-up'));
      await second.entered;
      await expect(f.driver.interruptCommand(f.projectId, f.runId, 'a')).resolves.toEqual({
        state: 'superseded',
      });
      expect(f.transports.aborted('b')).toBe(false);
      // B is still running and finishes with its own answer.
      second.release();
      expect(await outcomeB).toMatchObject({
        ok: true,
        value: { interrupted: false, response: { text: 'answer:b' } },
      });
      await f.driver.closeAll();
    });

    test('a Stop for another project is refused by the existing lookup and cannot abort the turn', async () => {
      const f = await make();
      const held = f.transports.hold('a');
      const outcome = watch(f.send('a'));
      await held.entered;
      await expect(f.driver.interruptCommand('foreign', f.runId, 'a')).rejects.toMatchObject({
        code: 'unknown_run',
      });
      expect(f.transports.aborted('a')).toBe(false);
      held.release();
      expect(await outcome).toMatchObject({
        ok: true,
        value: { interrupted: false, response: { text: 'answer:a' } },
      });
      await f.driver.closeAll();
    });

    test('an unknown run is refused through the existing error path', async () => {
      const f = await make();
      await f.seed();
      await expect(f.driver.interruptCommand(f.projectId, 'never-run', 'a')).rejects.toMatchObject({
        code: 'unknown_run',
      });
      await f.driver.closeAll();
    });

    test('a Stop whose lookup was delayed sees the active entry as it stands then, not as it was', async () => {
      const f = await make();
      const first = f.transports.hold('a');
      const outcomeA = watch(f.send('a'));
      await first.entered;
      // The interrupt is issued while A is still the active command, but its
      // validation read is held: by the time it completes, A has settled and B
      // is the active entry, so the answer is superseded and B is untouched.
      const delayed = f.delayNextGet();
      const interrupt = watch(f.driver.interruptCommand(f.projectId, f.runId, 'a'));
      first.release();
      await outcomeA;
      const second = f.transports.hold('b');
      const outcomeB = watch(f.send('b', 'follow-up'));
      delayed.release();
      expect(await interrupt).toMatchObject({ ok: true, value: { state: 'superseded' } });
      await second.entered;
      expect(f.transports.aborted('b')).toBe(false);
      second.release();
      expect(await outcomeB).toMatchObject({
        ok: true,
        value: { interrupted: false, response: { text: 'answer:b' } },
      });
      await f.driver.closeAll();
    });

    test('a replayed command reads the recorded outcome and dispatches nothing again', async () => {
      const f = await make();
      const held = f.transports.hold('a');
      const outcome = watch(f.send('a'));
      await held.entered;
      await expect(f.driver.interruptCommand(f.projectId, f.runId, 'a')).resolves.toEqual({
        state: 'requested',
      });
      const result = await outcome;
      if (f.stoppedTurn === 'interrupted') {
        expect(result).toMatchObject({ ok: true, value: { interrupted: true } });
        // The recorded interrupted answer is read back; the command is not redispatched.
        await expect(f.send('a')).resolves.toMatchObject({
          interrupted: true,
          response: null,
        });
      } else {
        expect(result).toMatchObject({ ok: false, error: { code: 'CANCELLED' } });
        // Nothing was durably recorded for the command and the run needs
        // reconciliation: a replay is refused rather than answered or resent.
        const replayed = watch(f.send('a'));
        expect(await replayed).toMatchObject({ ok: false, error: { code: 'RECONCILE_REQUIRED' } });
      }
      expect(f.transports.sent('a')).toBe(1);
      await f.driver.closeAll();
    });
  });

suite('ClaudeSessionRuns.interruptCommand', claudeFixture);
suite('ModelSessionRuns.interruptCommand', modelFixture);
