/**
 * H18 through the real model-API conversation driver: a FileRunStore-backed RunService, the real
 * ModelSessionRuns and NativeAgent loop, and a scripted adapter in place of the provider. Each
 * turn records what went into its context, the provider's usage reconciled against it, a stable
 * prefix that is byte-identical from turn to turn, and, once the history passes its budget, the
 * selection and the compaction record as evidence, with every original message left where it was.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import type { ModelRequest, ModelResult } from '../shared/harness.js';
import type { ContextAccount } from '../shared/context-accounting.js';
import type { TextRequest } from '../server/engines/contract.js';
import { AWS_MODEL_CONTRACT } from '../server/harness/aws-model-adapter.js';
import { ModelSessionRuns, modelApiDispatchAuthorizer, type ModelSessionTurn } from '../server/harness/model-session-run.js';
import type { ModelAdapter } from '../server/harness/native-agent.js';
import { FileRunStore } from '../server/harness/run-store.js';
import { RunService } from '../server/harness/run-service.js';
import { ARTIFACT_FORMAT, answerInstructions } from '../server/answer-format.js';
import { VISUAL_INSTRUCTIONS } from '../server/modes.js';

const roots: string[] = [];
const drivers: ModelSessionRuns[] = [];
afterEach(async () => {
  for (const driver of drivers.splice(0)) await driver.closeAll();
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

const ACCOUNT_ROUTE = 'aws-bedrock:aws-bedrock-1@r1';
const INSTRUCTIONS = answerInstructions('ask');

async function fixture(options: { usage?: (call: number) => ModelResult['usage'] } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'h18-context-'));
  roots.push(root);
  const services: Record<string, unknown> = { 'aws-bedrock': true, 'aws-bedrockAccountRoute': ACCOUNT_ROUTE };
  const authorize = modelApiDispatchAuthorizer(() => services);
  const runs: RunService = new RunService(new FileRunStore(root), {
    authorizeEgress: async (runId, intent, _principal, phase) => authorize(await runs.get(runId), intent, phase),
  });
  const driver = new ModelSessionRuns(runs, 'aws-bedrock');
  driver.setSharingPolicy(
    () => {},
    () => true,
  );
  drivers.push(driver);
  const sent: { instructions: string; messages: ModelRequest['messages'] }[] = [];
  let calls = 0;
  const send = (commandId: string, prompt: string, mode: ModelSessionTurn['mode'] = 'follow-up') => {
    const input: TextRequest = {
      projectId: 'p',
      threadId: 't',
      requestId: commandId,
      prompt,
      documents: [],
      instructions: INSTRUCTIONS,
      model: 'us.openai.gpt-5.6-luna',
      accountRoute: ACCOUNT_ROUTE,
    };
    return driver.request({
      mode,
      runId: 'conv',
      input,
      admit: async () => ({
        route: 'aws-bedrock',
        connectionId: 'aws-bedrock-1',
        revision: 1,
        model: input.model,
        accountRoute: ACCOUNT_ROUTE,
      }),
      adapter: async (_admission, instructions): Promise<ModelAdapter> => ({
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
          notes: ['Scripted transport for the H18 tests; nothing reaches a provider.'],
        }),
        complete: async (request: ModelRequest): Promise<ModelResult> => {
          sent.push({ instructions, messages: structuredClone(request.messages) });
          const call = calls++;
          return {
            response: { type: 'final', text: `Answer to ${commandId}. More detail follows.` },
            usage: options.usage ? options.usage(call) : { inputTokens: 1_000 + call, outputTokens: 30, cacheReadTokens: call ? 800 : 0, cacheWriteTokens: 0 },
          };
        },
      }),
    });
  };
  return { runs, driver, sent, send };
}

const contextOf = async (runs: RunService, commandId: string) => {
  const run = await runs.get('conv');
  const turn = run.steps.find(
    (step) => step.intent.stepId.startsWith('turn:') && (step.intent.input as { requestId?: string }).requestId === commandId,
  )!;
  return (turn.output as { context?: ContextAccount }).context!;
};

describe('context accounting on a model-API conversation', () => {
  test('each turn records its sections, the provider usage reconciled, and cache reads kept apart', async () => {
    const { runs, driver, sent, send } = await fixture();
    await send('m-1', 'What is on the lunch menu?', 'start');
    await send('m-2', 'And the soup?');
    const first = await contextOf(runs, 'm-1');
    expect(first.v).toBe(1);
    expect(first.route).toBe('aws-bedrock');
    expect(first.model).toBe('us.openai.gpt-5.6-luna');
    expect(first.window).toEqual({ tokens: null, source: 'not declared' });
    expect(first.requestLimitBytes).toBe(200_000);
    const bytes = Object.fromEntries(first.sections.map((section) => [section.id, section.bytes]));
    // The whole first call is in the sections: the system text, the tools and the user message.
    const system = sent[0].instructions;
    const user = sent[0].messages[0].text!;
    expect(bytes.instructions + bytes['answer-format']).toBe(Buffer.byteLength(system));
    // Ask carries the visual guidance inside its mode text, and the artifact format after it.
    expect(bytes['answer-format']).toBe(Buffer.byteLength(ARTIFACT_FORMAT) + Buffer.byteLength(VISUAL_INSTRUCTIONS));
    expect(bytes['project-files'] + bytes.history + bytes.message).toBe(Buffer.byteLength(user));
    expect(bytes.history).toBe(0);
    expect(bytes.tools).toBeGreaterThan(0);
    expect(first.provider).toMatchObject({ calls: 1, reportedCalls: 1, inputTokens: 1_000, cacheReadTokens: 0 });
    expect(first.reconciliation).toEqual({ estimated: first.estimatedTokens, reported: 1_000, difference: 1_000 - first.estimatedTokens });
    expect(first.stablePrefix.sameAsPrevious).toBeNull();

    const second = await contextOf(runs, 'm-2');
    expect(second.provider).toMatchObject({ inputTokens: 1_001, cacheReadTokens: 800 });
    expect(second.sections.find((section) => section.id === 'history')!.bytes).toBeGreaterThan(0);
    expect(second.history).toBeNull();
    // The same record reaches the projection through evidence.
    expect((await driver.evidence('p', 'conv', 'm-2')).context).toEqual(second);
  });

  test('the stable prefix is byte-identical from turn to turn, and sent first', async () => {
    const { runs, sent, send } = await fixture();
    await send('m-1', 'First question', 'start');
    for (let n = 2; n <= 4; n++) await send(`m-${n}`, `Question ${n}`);
    const accounts = await Promise.all([1, 2, 3, 4].map((n) => contextOf(runs, `m-${n}`)));
    const shas = new Set(accounts.map((account) => account.stablePrefix.sha));
    expect(shas.size).toBe(1);
    expect(accounts.slice(1).every((account) => account.stablePrefix.sameAsPrevious === true)).toBe(true);
    const prefixBytes = accounts[0].stablePrefix.bytes;
    const prefix = Buffer.from(sent[0].instructions).subarray(0, prefixBytes);
    for (const call of sent) expect(Buffer.from(call.instructions).subarray(0, prefixBytes).equals(prefix)).toBe(true);
    expect(sent[0].instructions.startsWith(INSTRUCTIONS)).toBe(true);
  });

  test('past the history budget: the newest stay, the rest are summarised as evidence, and History keeps every message', async () => {
    const { runs, driver, sent, send } = await fixture();
    await send('m-1', 'We are planning the Friday staff lunch.', 'start');
    await send('m-2', 'Where is the Harbor Supply linen invoice?');
    for (let n = 3; n <= 14; n++) await send(`m-${n}`, `Q${n}: how many chairs for table ${n}?`);
    await send('m-15', 'Has the Harbor Supply invoice been paid yet?');
    const account = await contextOf(runs, 'm-15');
    const selection = account.history!;
    expect(selection.available).toBe(14);
    expect(selection.included.filter((item) => item.reason === 'pinned').map((item) => item.index)).toEqual([1]);
    expect(selection.included.filter((item) => item.reason === 'recent').map((item) => item.index)).toEqual([9, 10, 11, 12, 13, 14]);
    expect(selection.included.find((item) => item.index === 2)?.reason).toBe('relevant');
    const compaction = account.compaction!;
    expect(compaction.turns.map((item) => item.index)).toEqual(selection.omitted.map((item) => item.index));
    expect(compaction.author).toBe('diomedes-application');
    // What the model read: the marker, the summary, the recalled message and the newest one.
    const user = sent.at(-1)!.messages[0].text!;
    expect(user).toContain(selection.marker!);
    expect(user).toContain(compaction.text);
    expect(user).toContain('Person: Where is the Harbor Supply linen invoice?');
    expect(user).toContain('Person: Q14: how many chairs for table 14?');
    // The turn's own run carries the same record, as evidence of what was summarised.
    const child = await driver.turnRun('p', 'conv', 'm-15');
    expect(child!.input).toMatchObject({ historyShared: true, history: { selection, compaction } });
    // History is untouched: every answered message is still its own step, with what it said.
    const conversation = await runs.get('conv');
    const turns = conversation.steps.filter((step) => step.intent.stepId.startsWith('turn:') && step.state === 'succeeded');
    expect(turns).toHaveLength(15);
    for (const item of compaction.turns) {
      const step = turns.find((candidate) => candidate.intent.stepId === item.stepId)!;
      expect((step.intent.input as { prompt: string }).prompt).toBeTruthy();
    }
  });

  test('a provider that reports no usage leaves the reconciliation unknown, never zero', async () => {
    const { runs, send } = await fixture({ usage: () => null });
    await send('m-1', 'Hello', 'start');
    const account = await contextOf(runs, 'm-1');
    expect(account.provider).toMatchObject({ calls: 1, reportedCalls: 0, firstCallInputTokens: null });
    expect(account.reconciliation).toBeNull();
  });
});
