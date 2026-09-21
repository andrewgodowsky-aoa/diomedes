import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, test } from 'vitest';
import type { Json } from '../shared/harness.js';
import { FileRunStore } from '../server/harness/run-store.js';
import { RunService } from '../server/harness/run-service.js';
import {
  CLAUDE_SESSION_CAPABILITY,
  ClaudeSessionRuns,
  validateClaudeNativeCheckpoint,
  type ClaudeSessionTurn,
  type InteractionPhase,
} from '../server/harness/claude-session-run.js';
import { localHarnessPrincipal } from '../server/harness/bridge.js';
import { prepareClaudeSession } from '../server/engines/claude-session.js';
import type { TextRequest } from '../server/engines/contract.js';
import { digest } from '../server/harness/policy.js';
import { textDispatchAuthorizer } from '../server/harness/text-route.js';

// The interaction seam at the driver, with a fake provider and the real RunService over real
// files. What is proved here: the first phase is written in a tail a replay also reaches; a
// reused command is compared before any answer comes back; a settled run is read and never
// touched; and phases are appended only under the driver's own lease.

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});
const principal = localHarnessPrincipal('p');
const SM = 'sm.0123456789abcdef0123456789abcdef';
const base: TextRequest = {
  projectId: 'p',
  threadId: 't',
  requestId: 'one',
  prompt: 'Order the usual from the bakery supplier',
  documents: [],
  instructions: 'Automatic',
  model: 'claude-test',
  accountRoute: 'claude-code:claude.ai',
};
const ANSWER = 'I can start that.\n\n```diomedes-decision\n{"disposition":"act"}\n```';
/** A stand-in for the host's pure splitter: text before the fence, and a body naming the rest. */
const decide = (answer: string) => {
  const at = answer.indexOf('```diomedes-decision');
  const answerText = (at < 0 ? answer : answer.slice(0, at)).trim();
  return { answerText, body: { restriction: 'automatic', answerDigest: digest(answer) } as Json };
};

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'interaction-driver-'));
  roots.push(root);
  const storage = new FileRunStore(root);
  const settings = { 'claude-code': true, 'claude-codeAccountRoute': base.accountRoute };
  const authorize = textDispatchAuthorizer(() => settings, [CLAUDE_SESSION_CAPABILITY.id]);
  const runs: RunService = new RunService(storage, {
    validateNativeCheckpoint: validateClaudeNativeCheckpoint,
    authorizeEgress: async (runId, intent, _principal, phase) =>
      authorize(await runs.get(runId), intent, phase),
  });
  let sent = 0;
  let failDecideOnce = false;
  const seen: TextRequest[] = [];
  const turn = (
    mode: ClaudeSessionTurn['mode'],
    commandId: string,
    patch: Partial<TextRequest> = {},
    runId = 'native',
  ): ClaudeSessionTurn => ({
    mode,
    runId,
    input: {
      ...base,
      requestId: commandId,
      binding: digest({ text: base.prompt, mode: 'auto', sources: [], action: mode }),
      interaction: {
        sourceMessageId: SM,
        decide: (answer) => {
          if (failDecideOnce) {
            failDecideOnce = false;
            throw new Error('the process died after the answer was saved');
          }
          return decide(answer);
        },
      },
      ...patch,
    },
    admit: async () => ({
      location: 'fixture',
      version: '2.1.252',
      model: base.model,
      accountRoute: base.accountRoute,
    }),
    open: async (_admission, value, opts) => {
      seen.push(value);
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
        close: async () => undefined,
        interrupt: async () => undefined,
        turn: async (request) => {
          seen.push(request);
          checkpoint = {
            ...checkpoint,
            state: 'busy',
            requests: [
              ...checkpoint.requests,
              { id: request.requestId, digest: digest(request.prompt) },
            ],
          };
          await opts.onCheckpoint(checkpoint, request.signal!);
          sent++;
          checkpoint = {
            ...checkpoint,
            nativeSessionId: checkpoint.nativeSessionId ?? '00000000-0000-4000-8000-000000000001',
            reportedModel: 'claude-test',
            state: 'idle',
            results: [...checkpoint.results, { id: request.requestId, digest: digest(ANSWER) }],
          };
          await opts.onCheckpoint(checkpoint, request.signal!);
          return {
            projectId: request.projectId,
            threadId: request.threadId,
            requestId: request.requestId,
            model: 'claude-test',
            version: '2.1.252',
            text: ANSWER,
          };
        },
      };
    },
  });
  /** A new driver over the same files, after the startup recovery a real restart runs. */
  const restart = async () => {
    const next = new ClaudeSessionRuns(runs);
    await next.recover(await runs.get('native'));
    return next;
  };
  return {
    runs,
    driver: new ClaudeSessionRuns(runs),
    turn,
    restart,
    seen,
    sent: () => sent,
    dieAfterTheAnswer: () => {
      failDecideOnce = true;
    },
  };
}
const phaseIds = async (runs: RunService) =>
  (await runs.get('native')).steps
    .filter((step) => step.intent.stepId.startsWith('phase.'))
    .map((step) => `${(step.intent.input as { phase: string }).phase}:${step.state}`);

test('an answered message has its first phase saved before the run parks, and no adapter sees the identity', async () => {
  const f = await fixture();
  const first = await f.driver.request(f.turn('start', 'one'));
  expect(first.answerText).toBe('I can start that.');
  expect(first.response?.text).toBe(ANSWER);
  expect(await phaseIds(f.runs)).toEqual(['decision:succeeded']);
  expect(await f.driver.phases('p', 'native', SM)).toEqual([
    { phase: 'decision', sourceMessageId: SM, body: decide(ANSWER).body },
  ]);
  const run = await f.runs.get('native');
  expect(run.state).toBe('waiting');
  // A phase is a transform: it charges no counter and costs no units.
  expect(run.used).toMatchObject({ modelCalls: 1, toolCalls: 1, units: 1 });
  // The turn keeps the whole answer as evidence; the derived text is never saved.
  const saved = run.steps.find((step) => step.intent.kind === 'model')!;
  expect(saved.output).not.toHaveProperty('answerText');
  expect((saved.intent.input as { binding?: string }).binding).toBe(f.turn('start', 'one').input.binding);
  for (const request of f.seen) {
    expect(request.interaction).toBeUndefined();
    expect(request.binding).toBeUndefined();
  }
  await f.driver.closeAll();
});

test('a replay returns exactly the first result, writes nothing and calls no provider', async () => {
  const f = await fixture();
  const first = await f.driver.request(f.turn('start', 'one'));
  const before = await f.runs.get('native');
  expect(await f.driver.request(f.turn('start', 'one'))).toEqual(first);
  expect(await f.runs.get('native')).toEqual(before);
  expect(f.sent()).toBe(1);
  await f.driver.closeAll();
});

test('a crash between the answer and the first phase is repaired by the next request, after a restart, with no second model call', async () => {
  const f = await fixture();
  f.dieAfterTheAnswer();
  await expect(f.driver.request(f.turn('start', 'one'))).rejects.toThrow('the process died');
  expect(await phaseIds(f.runs)).toEqual([]);
  expect(f.sent()).toBe(1);
  await f.driver.closeAll();
  const restarted = await f.restart();
  const fenceBefore = (await f.runs.get('native')).fence;
  const repaired = await restarted.request(f.turn('start', 'one'));
  expect(repaired.answerText).toBe('I can start that.');
  expect(await phaseIds(f.runs)).toEqual(['decision:succeeded']);
  expect(f.sent()).toBe(1);
  const run = await f.runs.get('native');
  // The new driver took the lease to write the phase, and parked the run again.
  expect(run.fence).toBeGreaterThan(fenceBefore);
  expect(run.state).toBe('waiting');
  expect(run.used.modelCalls).toBe(1);
  await restarted.closeAll();
});

test('a reused command with a different text, mode or source list is refused before any answer comes back', async () => {
  const f = await fixture();
  await f.driver.request(f.turn('start', 'one'));
  const before = await f.runs.get('native');
  for (const changed of [
    { text: 'Cancel the bakery order', mode: 'auto', sources: [] },
    { text: base.prompt, mode: 'plan', sources: [] },
    { text: base.prompt, mode: 'auto', sources: [{ path: 'prices.md', sha: 'a'.repeat(64) }] },
  ])
    await expect(
      f.driver.request(f.turn('start', 'one', { binding: digest({ ...changed, action: 'start' }) })),
    ).rejects.toMatchObject({ code: 'intent_mismatch' });
  // A request that lost its binding cannot prove it is the same message either.
  await expect(
    f.driver.request(f.turn('start', 'one', { binding: undefined })),
  ).rejects.toMatchObject({ code: 'intent_mismatch' });
  expect(await f.runs.get('native')).toEqual(before);
  expect(f.sent()).toBe(1);
  await f.driver.closeAll();
});

test('a settled run is read and left exactly as it was: no claim, no step, no phase, no charge', async () => {
  const f = await fixture();
  f.dieAfterTheAnswer();
  await expect(f.driver.request(f.turn('start', 'one'))).rejects.toThrow('the process died');
  await f.runs.cancel('native', 'the conversation moved on', principal);
  await f.driver.closeAll();
  const restarted = new ClaudeSessionRuns(f.runs);
  const before = await f.runs.get('native');
  expect(before.state).toBe('cancelled');
  // Byte-equivalent retry: the answer is still readable, with its text split for display.
  const read = await restarted.request(f.turn('start', 'one'));
  expect(read.answerText).toBe('I can start that.');
  expect(read.response?.text).toBe(ANSWER);
  // The first phase was never written, and a cancelled run does not get one now.
  expect(await restarted.phases('p', 'native', SM)).toEqual([]);
  // A changed body is refused on a settled run too.
  await expect(
    restarted.request(f.turn('start', 'one', { binding: digest('another message') })),
  ).rejects.toMatchObject({ code: 'intent_mismatch' });
  // Nothing can be recorded on it, so nothing later can be admitted through it.
  const missing: InteractionPhase = { phase: 'task-input', sourceMessageId: SM, body: { a: 1 } };
  await expect(restarted.record('p', 'native', [missing])).rejects.toMatchObject({
    code: 'RUN_SETTLED',
  });
  expect(await f.runs.get('native')).toEqual(before);
  expect(f.sent()).toBe(1);
  await restarted.closeAll();
});

test('a new message on a settled run is still refused: only an answered command is readable', async () => {
  const f = await fixture();
  await f.driver.request(f.turn('start', 'one'));
  await f.runs.cancel('native', 'the conversation moved on', principal);
  await expect(f.driver.request(f.turn('follow-up', 'two'))).rejects.toMatchObject({
    code: 'RECONCILE_REQUIRED',
  });
  expect(f.sent()).toBe(1);
  await f.driver.closeAll();
});

test('phases are appended once, refused when changed, read back in order, and leave the run parked', async () => {
  const f = await fixture();
  await f.driver.request(f.turn('start', 'one'));
  const selected: InteractionPhase = {
    phase: 'action-selected',
    sourceMessageId: SM,
    body: { proposalDigest: 'd'.repeat(64) },
  };
  const taskInput: InteractionPhase = { phase: 'task-input', sourceMessageId: SM, body: { n: 1 } };
  await f.driver.record('p', 'native', [selected, taskInput]);
  const once = await f.runs.get('native');
  expect(once.state).toBe('waiting');
  // The same phases again: not one step, claim or wait is added.
  await f.driver.record('p', 'native', [selected, taskInput]);
  expect(await f.runs.get('native')).toEqual(once);
  await expect(
    f.driver.record('p', 'native', [{ ...taskInput, body: { n: 2 } }]),
  ).rejects.toMatchObject({ code: 'intent_mismatch' });
  expect((await f.driver.phases('p', 'native', SM)).map((phase) => phase.phase)).toEqual([
    'decision',
    'action-selected',
    'task-input',
  ]);
  // Another message's phases are not this message's.
  expect(await f.driver.phases('p', 'native', 'sm.' + 'f'.repeat(32))).toEqual([]);
  expect(once.used).toMatchObject({ modelCalls: 1, toolCalls: 1, units: 1 });
  // The conversation still takes its next message after phases were recorded.
  await f.driver.request(
    f.turn('follow-up', 'two', {
      interaction: { sourceMessageId: 'sm.' + 'e'.repeat(32), decide },
    }),
  );
  expect(f.sent()).toBe(2);
  await f.driver.closeAll();
});

test('after a restart the new driver takes the lease to record a phase a crash left unwritten', async () => {
  const f = await fixture();
  await f.driver.request(f.turn('start', 'one'));
  await f.driver.closeAll();
  const restarted = await f.restart();
  const receipt: InteractionPhase = {
    phase: 'task-receipt',
    sourceMessageId: SM,
    body: { taskId: 'T7' },
  };
  await restarted.record('p', 'native', [receipt]);
  expect((await restarted.phases('p', 'native', SM)).map((phase) => phase.phase)).toEqual([
    'decision',
    'task-receipt',
  ]);
  expect((await f.runs.get('native')).state).toBe('waiting');
  await restarted.closeAll();
});

test('locate finds the run that holds a command through every lineage, settled ones included', async () => {
  const f = await fixture();
  await f.driver.request(f.turn('start', 'one', {}, 'native'));
  await f.runs.cancel('native', 'retired', principal);
  await f.driver.request(
    f.turn(
      'start',
      'two',
      { interaction: { sourceMessageId: 'sm.' + 'e'.repeat(32), decide } },
      'native-2',
    ),
  );
  const lineages = ['native-2', 'never-created', 'native'];
  expect(await f.driver.locate('p', lineages, 'one')).toEqual({
    runId: 'native',
    answered: true,
    settled: true,
  });
  expect(await f.driver.locate('p', lineages, 'two')).toEqual({
    runId: 'native-2',
    answered: true,
    settled: false,
  });
  expect(await f.driver.locate('p', lineages, 'three')).toBeNull();
  // Another project's run is not found through this project.
  expect(await f.driver.locate('other', lineages, 'one')).toBeNull();
  await f.driver.closeAll();
});

test('a turn saved before bindings existed is compared by what it did save', async () => {
  const f = await fixture();
  const legacy = (patch: Partial<TextRequest> = {}) =>
    f.turn('start', 'one', { binding: undefined, interaction: undefined, ...patch });
  const first = await f.driver.request(legacy());
  expect(first.answerText).toBeUndefined();
  expect(await phaseIds(f.runs)).toEqual([]);
  expect(await f.driver.request(legacy())).toEqual(first);
  // A caller that now sends a binding still reads a turn that has none.
  expect(await f.driver.request(f.turn('start', 'one', { interaction: undefined }))).toEqual(first);
  await expect(f.driver.request(legacy({ prompt: 'changed' }))).rejects.toMatchObject({
    code: 'intent_mismatch',
  });
  await expect(f.driver.request(legacy({ instructions: 'Plan only' }))).rejects.toMatchObject({
    code: 'intent_mismatch',
  });
  expect(f.sent()).toBe(1);
  await f.driver.closeAll();
});
