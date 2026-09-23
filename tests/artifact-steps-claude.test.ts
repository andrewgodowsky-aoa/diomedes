/**
 * Recorded artifacts on the Claude Code driver (artifacts v2, frozen item 5): the interaction seam
 * fixture of interaction-driver.test.ts, a fake provider over the real RunService and real files,
 * with an answer that holds artifacts. What is proved: the steps follow the decision phase, cost
 * nothing and hold no source; a replay writes nothing; a crash before or between them is finished
 * by the next request after a restart, with no second model call; and a later parser that reads a
 * recorded block differently neither rewrites the record nor refuses the retry.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { afterEach, expect, test, vi } from 'vitest';
import type { Json } from '../shared/harness.js';
import { FileRunStore } from '../server/harness/run-store.js';
import { RunService } from '../server/harness/run-service.js';
import {
  CLAUDE_SESSION_CAPABILITY,
  ClaudeSessionRuns,
  validateClaudeNativeCheckpoint,
  type ClaudeSessionTurn,
} from '../server/harness/claude-session-run.js';
import { ARTIFACT_STEP_PREFIX, type RecordedArtifact } from '../server/harness/artifact-steps.js';
import { prepareClaudeSession } from '../server/engines/claude-session.js';
import type { TextRequest } from '../server/engines/contract.js';
import { digest } from '../server/harness/policy.js';
import { textDispatchAuthorizer } from '../server/harness/text-route.js';
import { applicationOrigin } from '../shared/attribution.js';
import { indexArtifacts } from '../shared/artifacts.js';
import { projectedTurnIds, turnIdentityText } from '../shared/conversation-turn-id.js';

// A later build's parser, for one replay: it reads one more block ahead of the recorded ones.
const reading = vi.hoisted(() => ({ shifted: false }));
vi.mock('../server/harness/artifact-steps.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../server/harness/artifact-steps.js')>();
  return {
    ...actual,
    artifactSteps: (input: Parameters<typeof actual.artifactSteps>[0]) =>
      actual.artifactSteps(reading.shifted ? { ...input, answer: `Before anything else.\n\n${input.answer}` } : input),
  };
});

const roots: string[] = [];
afterEach(async () => {
  reading.shifted = false;
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});
const sha = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');
const SM = 'sm.0123456789abcdef0123456789abcdef';
const DECISION = '```diomedes-decision\n{"disposition":"act"}\n```';
const SHOWN = [
  'I can start that. Here is the delivery and the shelf.',
  '',
  '```mermaid',
  '%% artifact: id=delivery title="Delivery"',
  'graph LR',
  '  Bakery --> Kitchen',
  '```',
  '',
  '```html',
  '<!-- artifact: id=shelf title="Shelf label" -->',
  '<p>Rye, 12 loaves</p>',
  '```',
].join('\n');
const DRAWN = `${SHOWN}\n\n${DECISION}\n\n\`\`\`mermaid\ngraph LR\n  Never --> Shown\n\`\`\``;
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
/** A stand-in for the host's pure splitter: text before the fence, and a body naming the rest. */
const decide = (answer: string) => {
  const at = answer.indexOf('```diomedes-decision');
  const answerText = (at < 0 ? answer : answer.slice(0, at)).trim();
  return { answerText, body: { restriction: 'automatic', answerDigest: digest(answer) } as Json };
};

async function fixture(answer = DRAWN) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'artifact-steps-claude-'));
  roots.push(root);
  const storage = new FileRunStore(root);
  const settings = { 'claude-code': true, 'claude-codeAccountRoute': base.accountRoute };
  const authorize = textDispatchAuthorizer(() => settings, [CLAUDE_SESSION_CAPABILITY.id]);
  const runs: RunService = new RunService(storage, {
    validateNativeCheckpoint: validateClaudeNativeCheckpoint,
    authorizeEgress: async (runId, intent, _principal, phase) => authorize(await runs.get(runId), intent, phase),
  });
  let sent = 0;
  let failDecideOnce = false;
  const turn = (mode: ClaudeSessionTurn['mode'], commandId: string): ClaudeSessionTurn => ({
    mode,
    runId: 'native',
    input: {
      ...base,
      requestId: commandId,
      binding: digest({ text: base.prompt, mode: 'auto', sources: [], action: mode }),
      interaction: {
        sourceMessageId: SM,
        decide: (text) => {
          if (failDecideOnce) {
            failDecideOnce = false;
            throw new Error('the process died after the answer was saved');
          }
          return decide(text);
        },
      },
    },
    admit: async () => ({ location: 'fixture', version: '2.1.252', model: base.model, accountRoute: base.accountRoute }),
    open: async (_admission, value, opts) => {
      const prepared = prepareClaudeSession(value, opts, { email: 'fixture@invalid.example' }, root, '2.1.252');
      let checkpoint = prepared.checkpoint;
      return {
        get checkpoint() {
          return structuredClone(checkpoint);
        },
        get nativeSession() {
          return checkpoint.nativeSessionId && checkpoint.reportedModel
            ? { providerId: 'claude-code', lineageId: checkpoint.lineageId, opaqueRef: checkpoint.nativeSessionId }
            : null;
        },
        close: async () => undefined,
        interrupt: async () => undefined,
        turn: async (request) => {
          checkpoint = {
            ...checkpoint,
            state: 'busy',
            requests: [...checkpoint.requests, { id: request.requestId, digest: digest(request.prompt) }],
          };
          await opts.onCheckpoint(checkpoint, request.signal!);
          sent++;
          checkpoint = {
            ...checkpoint,
            nativeSessionId: checkpoint.nativeSessionId ?? '00000000-0000-4000-8000-000000000001',
            reportedModel: 'claude-test',
            state: 'idle',
            results: [...checkpoint.results, { id: request.requestId, digest: digest(answer) }],
          };
          await opts.onCheckpoint(checkpoint, request.signal!);
          return {
            projectId: request.projectId,
            threadId: request.threadId,
            requestId: request.requestId,
            model: 'claude-test',
            version: '2.1.252',
            text: answer,
          };
        },
      };
    },
  });
  const driverOver = () => {
    const driver = new ClaudeSessionRuns(runs);
    // Synthetic test policy for this standalone driver fixture.
    driver.setSharingPolicy(() => {});
    return driver;
  };
  /** A new driver over the same files, after the startup recovery a real restart runs. */
  const restart = async () => {
    const next = driverOver();
    await next.recover(await runs.get('native'));
    return next;
  };
  return {
    runs,
    driver: driverOver(),
    turn,
    restart,
    sent: () => sent,
    dieAfterTheAnswer: () => {
      failDecideOnce = true;
    },
  };
}
const artifacts = async (runs: RunService) =>
  (await runs.get('native')).steps.filter((step) => step.intent.stepId.startsWith(ARTIFACT_STEP_PREFIX));
const recordedOf = (step: { intent: { input: unknown } }) => step.intent.input as RecordedArtifact;
/** The turn the host projects for this command, and the artifacts the thread reads from it. */
const shownTurn = projectedTurnIds(sha(turnIdentityText('native', 'one'))).assistant;
const shownIndex = () => indexArtifacts('t', [{ id: shownTurn, role: 'assistant', text: decide(DRAWN).answerText }]);

test('an answer records its artifacts right after the decision phase: free, index-only, pointing at the turn that shows them', async () => {
  const f = await fixture();
  const first = await f.driver.request(f.turn('start', 'one'));
  expect(first.answerText).toBe(SHOWN);
  const run = await f.runs.get('native');
  // The model turn, its decision, the artifacts the person sees (not the one after the decision
  // block), then the wait for the next message.
  const order = run.steps.map((step) => step.intent.stepId);
  const phaseAt = order.findIndex((id) => id.startsWith('phase.'));
  const artifactAt = order.findIndex((id) => id.startsWith(ARTIFACT_STEP_PREFIX));
  expect(phaseAt).toBeGreaterThan(order.findIndex((id) => id.startsWith('turn:')));
  expect(artifactAt).toBeGreaterThan(phaseAt);
  expect(order.length - 1 - [...order].reverse().findIndex((id) => id.startsWith('input:'))).toBeGreaterThan(artifactAt);
  expect(run.state).toBe('waiting');

  const recorded = await artifacts(f.runs);
  expect(recorded).toHaveLength(2);
  const index = shownIndex();
  const turnStep = stepKeyOf(run, 'turn:');
  for (const step of recorded) {
    expect(step.state).toBe('succeeded');
    expect(step.intent).toMatchObject({ kind: 'transform', effect: 'pure', cost: 0, destination: 'local' });
    expect(step.origin).toEqual({ ...applicationOrigin(), producerId: turnStep });
    const input = recordedOf(step);
    expect(input).toMatchObject({ sourceMessageId: SM, turnId: shownTurn, turnStepId: turnStep });
    const record = index.forBlock(input.turnId, input.blockIndex)!;
    expect(record.key).toBe(input.artifactId);
    expect(input.sha256).toBe(sha(record.source));
  }
  expect(recorded.map((step) => recordedOf(step).declaredId)).toEqual(['delivery', 'shelf']);
  const kept = JSON.stringify(recorded);
  for (const source of ['Bakery --> Kitchen', 'Rye, 12 loaves', 'Never --> Shown', '%% artifact']) expect(kept).not.toContain(source);
  // The steps charge nothing: the run is charged exactly what the phase-only case is charged.
  expect(run.used).toMatchObject({ modelCalls: 1, toolCalls: 1, units: 1 });
  await f.driver.closeAll();
});

/** The id of the one step whose id starts with `prefix`. */
function stepKeyOf(run: { steps: { intent: { stepId: string } }[] }, prefix: string) {
  const found = run.steps.filter((step) => step.intent.stepId.startsWith(prefix));
  expect(found).toHaveLength(1);
  return found[0].intent.stepId;
}

test('a replay returns the first result, writes nothing and calls no provider', async () => {
  const f = await fixture();
  const first = await f.driver.request(f.turn('start', 'one'));
  const before = await f.runs.get('native');
  expect(await f.driver.request(f.turn('start', 'one'))).toEqual(first);
  expect(await f.runs.get('native')).toEqual(before);
  expect(f.sent()).toBe(1);
  await f.driver.closeAll();
});

test('a crash between the answer and the first phase is finished, artifacts and all, after a restart, with no second model call', async () => {
  const f = await fixture();
  f.dieAfterTheAnswer();
  await expect(f.driver.request(f.turn('start', 'one'))).rejects.toThrow('the process died');
  expect(await artifacts(f.runs)).toEqual([]);
  await f.driver.closeAll();
  const restarted = await f.restart();
  const repaired = await restarted.request(f.turn('start', 'one'));
  expect(repaired.answerText).toBe(SHOWN);
  expect((await artifacts(f.runs)).map((step) => `${recordedOf(step).declaredId}:${step.state}`)).toEqual([
    'delivery:succeeded',
    'shelf:succeeded',
  ]);
  expect(f.sent()).toBe(1);
  expect((await f.runs.get('native')).state).toBe('waiting');
  await restarted.closeAll();
});

test('a crash between two artifacts is finished by the next request after a restart, and only the missing one is written', async () => {
  const f = await fixture();
  const step = f.runs.step.bind(f.runs);
  let seen = 0;
  f.runs.step = (async (...args: Parameters<typeof step>) => {
    if (args[2].id.startsWith(ARTIFACT_STEP_PREFIX) && ++seen === 2) throw new Error('the process died between two artifacts');
    return step(...args);
  }) as typeof step;
  await expect(f.driver.request(f.turn('start', 'one'))).rejects.toThrow('between two artifacts');
  f.runs.step = step;
  const written = await artifacts(f.runs);
  expect(written.map((item) => recordedOf(item).declaredId)).toEqual(['delivery']);
  await f.driver.closeAll();

  const restarted = await f.restart();
  expect((await restarted.request(f.turn('start', 'one'))).answerText).toBe(SHOWN);
  const finished = await artifacts(f.runs);
  expect(finished.map((item) => `${recordedOf(item).declaredId}:${item.state}`)).toEqual(['delivery:succeeded', 'shelf:succeeded']);
  // The one written before the crash is the same record, untouched.
  expect(finished[0]).toEqual(written[0]);
  expect(f.sent()).toBe(1);
  await restarted.closeAll();
});

test('a later parser that reads a recorded block differently writes nothing on replay, and does not refuse it', async () => {
  const f = await fixture();
  const first = await f.driver.request(f.turn('start', 'one'));
  const before = await f.runs.get('native');
  reading.shifted = true;
  expect(await f.driver.request(f.turn('start', 'one'))).toEqual(first);
  expect(await f.runs.get('native')).toEqual(before);
  await f.driver.closeAll();
});

test('an answer that is only a decision block, or holds no artifact, records none', async () => {
  for (const answer of [DECISION, `I can start that.\n\n${DECISION}`]) {
    const f = await fixture(answer);
    await f.driver.request(f.turn('start', 'one'));
    expect(await artifacts(f.runs)).toEqual([]);
    expect((await f.runs.get('native')).used).toMatchObject({ modelCalls: 1, toolCalls: 1, units: 1 });
    await f.driver.closeAll();
  }
});
