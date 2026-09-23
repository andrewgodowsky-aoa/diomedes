/**
 * Recorded artifacts, as index-only evidence (artifacts v2, frozen item 5; draft (c)). The step
 * builder and the replay rule, then the model-API driver through the real app over HTTP, with only
 * the network under the AI SDK replaced (as in conversation-update.test.ts), read back through the
 * same run read the panel uses. The Claude Code driver's half is artifact-steps-claude.test.ts.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../server/app';
import { EngineService } from '../server/engines/service';
import { AWS_LUNA_MODEL } from '../server/engines/aws-bedrock';
import { testOnlySecretBox } from '../server/connection-secrets';
import type { Store } from '../server/store';
import type { MessageResult } from '../server/interaction-service';
import type { RunService, StepDefinition } from '../server/harness/run-service';
import {
  ARTIFACT_STEP_PREFIX,
  MAX_RECORDED_ARTIFACTS,
  artifactSteps,
  unrecordedArtifacts,
  type RecordedArtifact,
} from '../server/harness/artifact-steps';
import { applicationOrigin } from '../shared/attribution';
import { artifactKey, indexArtifacts } from '../shared/artifacts';
import { projectedTurnIds, turnIdentityText } from '../shared/conversation-turn-id';
import type { HarnessRun } from '../shared/harness';
import type { CloudSharingPolicy, Conversation, Project } from '../shared/types';
import { responsesEvents, sseResponse } from './fixtures/model-api-streams.js';

// A later build's parser, for one retry: it reads the same answer with one more block ahead of the
// recorded ones, so every recorded block sits one place later.
const reading = vi.hoisted(() => ({ shifted: false }));
vi.mock('../server/harness/artifact-steps', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../server/harness/artifact-steps')>();
  return {
    ...actual,
    artifactSteps: (input: Parameters<typeof actual.artifactSteps>[0]) =>
      actual.artifactSteps(reading.shifted ? { ...input, answer: `Before anything else.\n\n${input.answer}` } : input),
  };
});

const sha = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');
const DIAGRAM = 'graph LR\n  Order --> Delivery';
const PICTURE = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10"/></svg>';
const DRAWN = [
  'Here is the route and the shelf.',
  '',
  '```mermaid',
  '%% artifact: id=linen-route title="Linen route"',
  DIAGRAM,
  '```',
  '',
  '### Shelf plan',
  '',
  '```svg',
  PICTURE,
  '```',
].join('\n');
const recordedOf = (step: { input?: unknown } | { intent: { input: unknown } }) =>
  ('intent' in step ? step.intent.input : step.input) as RecordedArtifact;

describe('artifactSteps', () => {
  const RUN = 'model-conversation-1';
  const COMMAND = 'm-1';
  const SM = 'sm.' + '0'.repeat(32);
  const TURN_STEP = 'turn:' + 'a'.repeat(40);
  const turnId = projectedTurnIds(sha(turnIdentityText(RUN, COMMAND))).assistant;
  const built = (answer: string, sourceMessageId = SM) =>
    artifactSteps({ runId: RUN, threadId: 't-1', commandId: COMMAND, sourceMessageId, turnStepId: TURN_STEP, answer });
  const indexed = (answer: string) => indexArtifacts('t-1', [{ id: turnId, role: 'assistant', text: answer }]);

  test('one pure, free, local transform step per artifact: an index and a digest, never the source', () => {
    const steps = built(DRAWN);
    const index = indexed(DRAWN);
    expect(index.list).toHaveLength(2);
    expect(steps).toHaveLength(2);
    steps.forEach((step, at) => {
      const record = index.list[at];
      expect(step).toEqual({
        id: expect.stringMatching(/^artifact\.v1:[0-9a-f]{40}$/),
        version: '1',
        kind: 'transform',
        effect: 'pure',
        name: `Artifact ${record.kind}`,
        input: {
          v: 1,
          artifactId: artifactKey('t-1', turnId, record.blockIndex),
          declaredId: record.declaredId,
          kind: record.kind,
          lang: record.lang,
          title: record.title,
          sha256: sha(record.source),
          blockIndex: record.blockIndex,
          turnId,
          turnStepId: TURN_STEP,
          sourceMessageId: SM,
        },
        cost: 0,
        maxAttempts: 3,
        destination: 'local',
        // The application wrote it; the model turn it indexes is named as what produced it.
        origin: { ...applicationOrigin(), producerId: TURN_STEP },
      });
      expect(step.input).not.toHaveProperty('source');
    });
    expect(steps.map((step) => [recordedOf(step).kind, recordedOf(step).declaredId])).toEqual([
      ['diagram', 'linen-route'],
      ['image', null],
    ]);
    expect(recordedOf(steps[0]).title).toBe('Linen route');
    // No source text anywhere: not the bodies, not the declaration line.
    const kept = JSON.stringify(steps);
    expect(kept).not.toContain('Order --> Delivery');
    expect(kept).not.toContain('<svg');
    expect(kept).not.toContain('%% artifact');
  });

  test('each step matches the text it indexes, and a changed digest or a changed place is caught', () => {
    /** The panel's check: the block the step points at, in the turn it names, has the digest it holds. */
    const matches = (recorded: RecordedArtifact, text: string) => {
      const record = indexed(text).forBlock(recorded.turnId, recorded.blockIndex);
      return !!record && record.kind === recorded.kind && sha(record.source) === recorded.sha256;
    };
    const steps = built(DRAWN).map(recordedOf);
    for (const recorded of steps) expect(matches(recorded, DRAWN)).toBe(true);
    // The text changed under the record.
    expect(matches(steps[0], DRAWN.replace('Order --> Delivery', 'Order --> Return'))).toBe(false);
    // The record was tampered with: its digest, or the place it points at.
    expect(matches({ ...steps[0], sha256: sha('something else') }, DRAWN)).toBe(false);
    expect(matches({ ...steps[1], blockIndex: steps[0].blockIndex }, DRAWN)).toBe(false);
  });

  test('at most 16 are recorded for one message; the rest stay readable from the text', () => {
    const many = Array.from({ length: 20 }, (_, n) => `\`\`\`mermaid\ngraph LR\n  A${n} --> B${n}\n\`\`\``).join('\n\n');
    expect(indexed(many).list).toHaveLength(20);
    const steps = built(many);
    expect(steps).toHaveLength(MAX_RECORDED_ARTIFACTS);
    expect(MAX_RECORDED_ARTIFACTS).toBe(16);
    expect(steps.map((step) => recordedOf(step).blockIndex)).toEqual(indexed(many).list.slice(0, 16).map((r) => r.blockIndex));
  });

  test('a title is recorded only when the artifact has one of its own, never a number only its thread could give it', () => {
    const drafts = 'Two drafts.\n\n```mermaid\ngraph LR\n  A --> B\n```\n\n```mermaid\ngraph LR\n  B --> C\n```';
    // Read alone, the answer numbers them; the thread they land in may number them otherwise.
    expect(indexed(drafts).list.map((record) => record.title)).toEqual(['Diagram 1', 'Diagram 2']);
    expect(built(drafts).map((step) => recordedOf(step).title)).toEqual([null, null]);
    // A declared title and a heading above are the artifact's own, and are kept.
    expect(built(DRAWN).map((step) => recordedOf(step).title)).toEqual(['Linen route', 'Shelf plan']);
  });

  test('an answer without an artifact records nothing, and each message and block has its own id', () => {
    expect(built('The linen order arrives Friday.')).toEqual([]);
    const one = built(DRAWN).map((step) => step.id);
    const other = built(DRAWN, 'sm.' + '1'.repeat(32)).map((step) => step.id);
    expect(new Set(one).size).toBe(2);
    expect(one.some((id) => other.includes(id))).toBe(false);
  });

  describe('unrecordedArtifacts, the replay rule', () => {
    const run = (recorded: { step: StepDefinition; state: string }[]) =>
      ({
        steps: recorded.map(({ step, state }) => ({ intent: { stepId: step.id, input: step.input }, state })),
      }) as unknown as HarnessRun;
    const steps = built(DRAWN);

    test('with nothing recorded for the message, a replay records every artifact', () => {
      expect(unrecordedArtifacts(run([]), SM, steps)).toEqual(steps);
      // Another message's record is not this message's.
      const elsewhere = built(DRAWN, 'sm.' + '2'.repeat(32)).map((step) => ({ step, state: 'succeeded' }));
      expect(unrecordedArtifacts(run(elsewhere), SM, steps)).toEqual(steps);
    });

    test('with every artifact recorded, a replay records nothing', () => {
      expect(unrecordedArtifacts(run(steps.map((step) => ({ step, state: 'succeeded' }))), SM, steps)).toEqual([]);
    });

    test('after a crash between two artifacts, a replay records only the rest', () => {
      expect(unrecordedArtifacts(run([{ step: steps[0], state: 'succeeded' }]), SM, steps)).toEqual([steps[1]]);
      expect(
        unrecordedArtifacts(run([{ step: steps[0], state: 'succeeded' }, { step: steps[1], state: 'retry_wait' }]), SM, steps),
      ).toEqual([steps[1]]);
    });

    test('a parser that reads a recorded block differently records nothing more', () => {
      const recorded = run([{ step: steps[0], state: 'succeeded' }]);
      // One place later: the recorded step is not in the new reading at all.
      expect(unrecordedArtifacts(recorded, SM, built(`Before anything else.\n\n${DRAWN}`))).toEqual([]);
      // The same place, read with another title.
      const retitled = steps.map((step) => ({ ...step, input: { ...recordedOf(step), title: 'Another title' } }));
      expect(unrecordedArtifacts(recorded, SM, retitled)).toEqual([]);
    });
  });
});

// ---- the model-API driver, through the app ------------------------------------------------------

const headers = { 'Content-Type': 'application/json', 'X-Diomedes-Client': '1' };
const SECRET = 'test-only-bedrock-key-0123456789abcdef-never-real';
let root: string;
let app: Awaited<ReturnType<typeof createApp>>;
let server: Server | undefined;
let base: string;
let project: Project;
let thread: Conversation;
type Item = Record<string, unknown>;
type Body = { input: Item[] };

const userText = (body: Body) => {
  const content = body.input.find((item) => item.role === 'user')?.content;
  if (typeof content === 'string') return content;
  return Array.isArray(content) ? content.map((part) => String((part as Item).text ?? '')).join('') : '';
};
const said = (body: Body) => (userText(body).split("The person's message:\n\n")[1] ?? '').split('\n\n[[diomedes')[0];
const issued = (body: Body) => /\[\[diomedes source_message_id=(sm\.[0-9a-f]{32})\]\]$/.exec(userText(body))?.[1];
const proposal = (sourceMessageId: string, words: string) =>
  '```diomedes-decision\n' +
  JSON.stringify({
    source_message_id: sourceMessageId,
    disposition: 'act',
    requested_project_id: null,
    operation_class: 'write_internal',
    source_refs: [],
    target_run_id: null,
    question: null,
    public_summary: `Do this: ${words}`,
  }) +
  '\n```';
const SHOWN_PLAN = '```mermaid\n%% artifact: id=usual-order title="The usual order"\ngraph LR\n  Supplier --> Kitchen\n```';
const AFTER_THE_BLOCK = '```mermaid\ngraph LR\n  Hidden --> After\n```';

let calls = 0;
const aws = (async (_input: RequestInfo | URL, init?: RequestInit) => {
  const body = JSON.parse(String(init?.body)) as Body;
  calls += 1;
  const words = said(body);
  const id = issued(body);
  const answer = words.startsWith('DRAW')
    ? DRAWN
    : words.startsWith('ACTDRAW') && id
      ? `Here is what I would order.\n\n${SHOWN_PLAN}\n\n${proposal(id, words)}\n\n${AFTER_THE_BLOCK}`
      : words.startsWith('ACT') && id
        ? `I can start that.\n\n${proposal(id, words)}`
        : `answer:${words}`;
  return sseResponse(
    responsesEvents({
      id: `resp_${calls}`,
      object: 'response',
      created_at: 1_790_000_000,
      status: 'completed',
      model: AWS_LUNA_MODEL,
      output: [
        { type: 'message', id: `msg_${calls}`, role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: answer, annotations: [] }] },
      ],
      usage: { input_tokens: 900, input_tokens_details: { cached_tokens: 0 }, output_tokens: 40, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 940 },
      incomplete_details: null,
      error: null,
    }),
    { 'x-amzn-requestid': `req-${calls}` },
  );
}) as typeof globalThis.fetch;

async function api<T>(route: string, method = 'GET', body?: unknown): Promise<T> {
  const response = await fetch(`${base}/api${route}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const reply = await response.text();
  expect(response.ok, `${route}: ${response.status} ${reply}`).toBe(true);
  return JSON.parse(reply) as T;
}
const store = () => app.locals.store as Store;
const current = (threadId = thread.id) => store().state(project.id).conversations.find((item) => item.id === threadId)!;
const send = (commandId: string, words: string, mode: 'ask' | 'auto', threadId = thread.id) =>
  api<MessageResult>(`/projects/${project.id}/threads/${threadId}/messages`, 'POST', {
    commandId,
    text: words,
    mode,
    sources: [],
    consent: true,
  });
/** The conversation run exactly as the panel reads it. */
const readRun = (runId: string) => api<HarnessRun>(`/projects/${project.id}/harness/runs/${runId}`);
const artifactsIn = (run: HarnessRun, sourceMessageId?: string) =>
  run.steps.filter(
    (step) =>
      step.intent.stepId.startsWith(ARTIFACT_STEP_PREFIX) &&
      (sourceMessageId === undefined || recordedOf(step).sourceMessageId === sourceMessageId),
  );
async function awsThread() {
  const made = await api<Conversation>(`/projects/${project.id}/threads`, 'POST', {});
  await api<Conversation>(`/projects/${project.id}/threads/${made.id}`, 'PUT', { engine: 'aws-bedrock' });
  return made;
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'diomedes-artifact-steps-'));
  calls = 0;
  app = await createApp({
    dataDir: path.join(root, 'data'),
    projectRoot: path.join(root, 'projects'),
    engineService: new EngineService(path.join(root, 'engines'), { discover: async () => [] }),
    reviewerAdapter: null,
    secretBox: testOnlySecretBox(),
    modelApiTransport: aws,
  });
  server = await new Promise<Server>((resolve) => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  project = await api<Project>('/projects', 'POST', { name: 'Linen service' });
  thread = await awsThread();
  const policy = await api<CloudSharingPolicy>(`/projects/${project.id}/cloud-sharing`);
  await api(`/projects/${project.id}/cloud-sharing`, 'PUT', {
    expectedVersion: policy.version,
    routes: ['aws-bedrock'],
    documents: [],
    shareConversationHistory: false,
    shareReviewPackets: false,
  });
  await api('/ai/model-api/aws-bedrock', 'PUT', {
    accountId: '123456789012',
    region: 'us-east-1',
    model: AWS_LUNA_MODEL,
    apiKey: SECRET,
    expiresAt: null,
    consent: true,
  });
  await api('/ai/model-api/aws-bedrock/spend-limit', 'PUT', { capUsd: 5, consent: true });
});
afterEach(async () => {
  reading.shifted = false;
  if (server) {
    await app.locals.close();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server!.close((error) => (error ? reject(error) : resolve())));
    server = undefined;
  }
  await fs.rm(root, { recursive: true, force: true });
});

describe('the model-API driver records an answer\'s artifacts', () => {
  test('once, after its decision, as free steps the run read returns intact, pointing at the turn that shows them', async () => {
    const drawn = await send('m-draw', 'DRAW the linen route', 'ask');
    const run = await readRun(drawn.runId);
    const shown = current().turns.at(-1)!;
    expect(shown.id).toBe(projectedTurnIds(sha(turnIdentityText(drawn.runId, 'm-draw'))).assistant);
    const index = indexArtifacts(thread.id, current().turns);
    expect(index.list).toHaveLength(2);

    const recorded = artifactsIn(run);
    expect(recorded).toHaveLength(2);
    const turnStep = run.steps.find((step) => step.intent.stepId.startsWith('turn:'))!;
    for (const step of recorded) {
      expect(step.state).toBe('succeeded');
      expect(step.intent).toMatchObject({ kind: 'transform', effect: 'pure', cost: 0, destination: 'local' });
      expect(step.origin).toEqual({ ...applicationOrigin(), producerId: turnStep.intent.stepId });
      const input = recordedOf(step);
      expect(input).toMatchObject({ sourceMessageId: drawn.sourceMessageId, turnId: shown.id, turnStepId: turnStep.intent.stepId });
      // The index matches the text the thread shows.
      const record = index.forBlock(input.turnId, input.blockIndex)!;
      expect(record.key).toBe(input.artifactId);
      expect(input.sha256).toBe(sha(record.source));
    }
    expect(JSON.stringify(recorded)).not.toContain('Order --> Delivery');
    expect(JSON.stringify(recorded)).not.toContain('<svg');
    // Written after the message's decision phase and before the run parks for the next message.
    const ids = run.steps.map((step) => step.intent.stepId);
    const firstArtifact = ids.findIndex((id) => id.startsWith(ARTIFACT_STEP_PREFIX));
    expect(ids.findIndex((id) => id.startsWith('phase.'))).toBeLessThan(firstArtifact);
    expect(ids.length - 1 - [...ids].reverse().findIndex((id) => id.startsWith('input:'))).toBeGreaterThan(firstArtifact);
    expect(run.state).toBe('waiting');

    // Free: the same message answered without artifacts costs the run exactly the same.
    const plainThread = await awsThread();
    const plain = await send('m-plain', 'Where is the linen order?', 'ask', plainThread.id);
    const plainRun = await readRun(plain.runId);
    expect(artifactsIn(plainRun)).toEqual([]);
    expect(run.used).toEqual(plainRun.used);
  });

  test('a retried command reads its answer back and records nothing more', async () => {
    const first = await send('m-draw', 'DRAW the linen route', 'ask');
    const before = await readRun(first.runId);
    const sent = calls;
    expect(await send('m-draw', 'DRAW the linen route', 'ask')).toEqual(first);
    expect(await readRun(first.runId)).toEqual(before);
    expect(calls).toBe(sent);
  });

  test('a failure between two artifacts is finished by a retry of the same command, with no second model call', async () => {
    const runs = app.locals.harness.runs as RunService;
    const step = runs.step.bind(runs);
    let seen = 0;
    runs.step = (async (...args: Parameters<typeof step>) => {
      if (args[2].id.startsWith(ARTIFACT_STEP_PREFIX) && ++seen === 2) throw new Error('the process died between two artifacts');
      return step(...args);
    }) as typeof step;
    const failed = await fetch(`${base}/api/projects/${project.id}/threads/${thread.id}/messages`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ commandId: 'm-draw', text: 'DRAW the linen route', mode: 'ask', sources: [], consent: true }),
    });
    expect(failed.ok).toBe(false);
    runs.step = step;
    const lineage = current().lineages![0].runId;
    const written = artifactsIn(await readRun(lineage));
    expect(written.map((item) => recordedOf(item).declaredId)).toEqual(['linen-route']);

    const retried = await send('m-draw', 'DRAW the linen route', 'ask');
    expect(retried.runId).toBe(lineage);
    const finished = artifactsIn(await readRun(lineage));
    expect(finished.map((item) => `${recordedOf(item).kind}:${item.state}`)).toEqual(['diagram:succeeded', 'image:succeeded']);
    expect(finished[0]).toEqual(written[0]);
    expect(calls).toBe(1);
    // The thread shows the answer once, and the record points at it.
    expect(current().turns.filter((turn) => turn.role !== 'you')).toHaveLength(1);
    expect(recordedOf(finished[1]).turnId).toBe(current().turns.at(-1)!.id);
  });

  test('a later parser that reads the answer differently records nothing on a retry, and does not refuse it', async () => {
    const first = await send('m-draw', 'DRAW the linen route', 'ask');
    const before = await readRun(first.runId);
    reading.shifted = true;
    expect(await send('m-draw', 'DRAW the linen route', 'ask')).toEqual(first);
    expect(await readRun(first.runId)).toEqual(before);
  });

  test('under Automatic, only what the person sees: nothing after the decision block, and nothing for a proposal without one', async () => {
    const drawn = await send('m-act-draw', 'ACTDRAW order the usual', 'auto');
    expect(drawn.outcome.status).toBe('proposed');
    const bare = await send('m-act', 'ACT order the usual', 'auto');
    expect(bare.outcome.status).toBe('proposed');
    const run = await readRun(drawn.runId);
    const recorded = artifactsIn(run, drawn.sourceMessageId).map(recordedOf);
    expect(recorded).toEqual([expect.objectContaining({ declaredId: 'usual-order', title: 'The usual order', kind: 'diagram' })]);
    const index = indexArtifacts(thread.id, current().turns);
    expect(index.list.map((record) => record.declaredId)).toEqual(['usual-order']);
    expect(recorded[0].sha256).toBe(sha(index.list[0].source));
    expect(artifactsIn(run, bare.sourceMessageId)).toEqual([]);
  });
});
