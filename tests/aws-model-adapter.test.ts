/**
 * The AWS route inside the existing native loop: `NativeAgent` drives, the real
 * `RunService` records every step, the registry runs the one read tool, and the
 * adapter makes one Responses exchange per model step through the real SDK. Only
 * the network is replaced.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { micro } from '../shared/managed-usage.js';
import {
  AWS_LUNA_MODEL,
  AWS_LUNA_RATE_CARD,
  AWS_RESPONSES_ENDPOINTS,
  awsAccountRoute,
  type AwsConnection,
} from '../server/engines/aws-bedrock.js';
import { createAwsModelAdapter } from '../server/harness/aws-model-adapter.js';
import { localHarnessPrincipal } from '../server/harness/bridge.js';
import { sourceSha, sourceTools } from '../server/harness/capabilities/conversation-sources.js';
import { FileRunStore, NativeAgent, RunService } from '../server/harness/index.js';
import {
  MODEL_CONVERSATION_CAPABILITY,
  MODEL_TURN_CAPABILITY,
  ModelSessionRuns,
  modelApiDispatchAuthorizer,
} from '../server/harness/model-session-run.js';
import type { InteractionPhase } from '../server/harness/claude-session-run.js';
import { FileModelTranscripts } from '../server/harness/model-transcripts.js';
import { SpendExposure } from '../server/spend-exposure.js';
import { responsesAnswer } from './fixtures/model-api-streams.js';

const BASE = AWS_RESPONSES_ENDPOINTS['us-east-1'];
const SECRET = 'test-only-bedrock-key-0123456789abcdef';
const CONNECTION: AwsConnection = {
  v: 1,
  id: 'aws-bedrock-1',
  accountId: '123456789012',
  region: 'us-east-1',
  baseUrl: BASE,
  modelId: AWS_LUNA_MODEL,
  processing: 'us-geo',
  credential: { kind: 'bedrock-api-key', fingerprint: 'abcdef123456', savedAt: '2026-09-21T08:00:00.000Z', expiresAt: null },
  revision: 1,
  createdAt: '2026-09-21T08:00:00.000Z',
  updatedAt: '2026-09-21T08:00:00.000Z',
};
const ACCOUNT_ROUTE = awsAccountRoute(CONNECTION);
const PROJECT = 'linen-project';
const principal = localHarnessPrincipal(PROJECT);
const SOURCES = [
  { path: 'orders/linen-order.txt', text: 'Order 1182: 100 napkins, 40 tablecloths, delivery Friday.' },
  { path: 'deliveries/friday.txt', text: 'Friday delivery for order 1182: 94 napkins, 40 tablecloths. Driver noted 6 napkins short.' },
  { path: 'invoices/inv-1182.txt', text: 'Invoice 1182 bills 100 napkins and 40 tablecloths.' },
];
const USAGE = {
  input_tokens: 900,
  input_tokens_details: { cached_tokens: 0 },
  output_tokens: 150,
  output_tokens_details: { reasoning_tokens: 60 },
  total_tokens: 1_050,
};
type Item = Record<string, unknown>;
const envelope = (id: string, output: Item[]) => ({
  id,
  object: 'response',
  created_at: 1_790_000_000,
  status: 'completed',
  model: AWS_LUNA_MODEL,
  output,
  usage: USAGE,
  incomplete_details: null,
  error: null,
});
const reasoning = (id: string): Item => ({ type: 'reasoning', id, summary: [], encrypted_content: `enc-${id}` });
const call = (callId: string, name: string, args: unknown): Item => ({
  type: 'function_call',
  id: `fc_${callId}`,
  call_id: callId,
  name,
  arguments: JSON.stringify(args),
  status: 'completed',
});
const answer = (text: string): Item => ({
  type: 'message',
  id: 'msg_1',
  role: 'assistant',
  status: 'completed',
  content: [{ type: 'output_text', text, annotations: [] }],
});

interface Sent {
  body: { input: Item[]; tools?: Item[] };
}
function network(script: Array<(signal: AbortSignal | undefined) => Promise<Response> | Response>) {
  const sent: Sent[] = [];
  const fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    sent.push({ body: JSON.parse(String(init?.body)) });
    const next = script.shift();
    if (!next) throw new Error('Unexpected provider request.');
    return next(init?.signal ?? undefined);
  }) as typeof globalThis.fetch;
  return { fetch, sent };
}
/** A Responses object answers as its event stream: the route asks for `stream: true`. */
const json = (body: unknown) => responsesAnswer(body, 200, { 'x-amzn-requestid': 'req-1' });

let dir: string;
let runs: RunService;
let exposure: SpendExposure;
let transcripts: FileModelTranscripts;
let services: Record<string, unknown>;
const INSTRUCTIONS = 'You are Diomedes. Answer from the attached files and cite their paths.';

function runService() {
  const authorize = modelApiDispatchAuthorizer(() => services);
  const service: RunService = new RunService(new FileRunStore(path.join(dir, 'runs')), {
    authorizeEgress: async (runId, intent, _principal, phase) => authorize(await service.get(runId), intent, phase),
  });
  return service;
}

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'diomedes-aws-adapter-'));
  services = { 'aws-bedrock': true, 'aws-bedrockAccountRoute': ACCOUNT_ROUTE };
  runs = runService();
  exposure = new SpendExposure(path.join(dir, 'spend'));
  await exposure.init();
  await exposure.setCap(CONNECTION.id, micro(500_000), { approvedBy: 'test owner', note: 'fifty cents' });
  transcripts = new FileModelTranscripts(path.join(dir, 'transcripts'), 'aws-bedrock');
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

async function startTurn(id: string, service = runs) {
  const registry = sourceTools(SOURCES);
  await service.start({
    id,
    projectId: PROJECT,
    tenantId: principal.tenantId,
    principal,
    capability: MODEL_TURN_CAPABILITY,
    tools: registry,
    input: {
      engine: 'aws-bedrock',
      route: 'aws-bedrock',
      accountRoute: ACCOUNT_ROUTE,
      model: AWS_LUNA_MODEL,
      sources: SOURCES.map((source) => ({ path: source.path, sha256: sourceSha(source.text) })),
    },
    budget: { units: 32, modelCalls: 8, toolCalls: 16, wallMs: 480_000 },
  });
  await service.claim(id, 'host', 600_000);
  return registry;
}
function adapter(fetch: typeof globalThis.fetch, instructions = INSTRUCTIONS, ledger = exposure) {
  return createAwsModelAdapter({
    connection: CONNECTION,
    secret: SECRET,
    card: AWS_LUNA_RATE_CARD,
    exposure: ledger,
    transcripts,
    instructions,
    effort: 'low',
    transport: fetch,
  });
}

describe('the AWS adapter inside NativeAgent', () => {
  test('a registered read-tool round trip: provider call id mapped, source-backed answer, every step recorded', async () => {
    const net = network([
      () => json(envelope('resp_1', [reasoning('rs_1'), call('call_7', 'read_source', { path: 'deliveries/friday.txt' })])),
      () =>
        json(
          envelope('resp_2', [
            reasoning('rs_2'),
            answer('Six napkins were short on Friday (deliveries/friday.txt), but invoice 1182 bills all 100 (invoices/inv-1182.txt).'),
          ]),
        ),
    ]);
    const registry = await startTurn('turn-1');
    const text = await new NativeAgent(runs, adapter(net.fetch), registry).run(
      'turn-1',
      'host',
      'How many napkins were short on Friday, and were we billed for them?',
      principal,
    );
    expect(text).toContain('deliveries/friday.txt');

    // The tool the model named ran through the registry and the Runtime, not the SDK.
    const run = await runs.get('turn-1');
    expect(run.state).toBe('completed');
    expect(run.steps.map((step) => `${step.intent.stepId}:${step.state}`)).toEqual([
      'context:0:succeeded',
      'model:0:succeeded',
      'tool:0:succeeded',
      'context:1:succeeded',
      'model:1:succeeded',
    ]);
    const model = run.steps.find((step) => step.intent.stepId === 'model:0')!;
    expect(model.intent.destination).toBe('external');
    expect(model.origin).toMatchObject({ mode: 'direct', engine: { id: 'aws-bedrock' } });
    const tool = run.steps.find((step) => step.intent.stepId === 'tool:0')!;
    expect(tool.intent.name).toBe('read_source');
    expect(tool.output).toMatchObject({ found: true, path: 'deliveries/friday.txt', sha256: sourceSha(SOURCES[1].text) });

    // The provider's own call id answers it; encrypted reasoning is carried locally under store:false.
    const second = net.sent[1].body.input;
    expect(second).toContainEqual(expect.objectContaining({ type: 'reasoning', id: 'rs_1', encrypted_content: 'enc-rs_1' }));
    expect(second).toContainEqual(expect.objectContaining({ type: 'function_call', call_id: 'call_7', name: 'read_source' }));
    const output = second.find((item) => item.type === 'function_call_output');
    expect(output?.call_id).toBe('call_7');
    expect(String(output?.output)).toContain('Driver noted 6 napkins short');
    expect(net.sent[0].body.tools?.map((item) => item.name).sort()).toEqual(['list_sources', 'read_source']);

    // The private transcript maps the canonical tool step to the provider call; the run record holds only a reference.
    const firstRef = (model.output as unknown as { transcript: Parameters<FileModelTranscripts['read']>[0] }).transcript;
    const saved = await transcripts.read(firstRef);
    expect(saved.pendingTool).toMatchObject({ callId: 'call_7', name: 'read_source' });
    expect(saved.runId).toBe('turn-1');
    expect(JSON.stringify(run)).not.toContain('enc-rs_1');
    expect(JSON.stringify(run)).not.toContain(SECRET);

    // Two paid calls, both settled from reported usage.
    expect(exposure.list(CONNECTION.id).map((hold) => hold.state)).toEqual(['settled', 'settled']);
  });

  test('a restart after the tool ran: completed steps replay, and a fresh process continues from the private transcript', async () => {
    const before = network([
      () => json(envelope('resp_1', [reasoning('rs_1'), call('call_1', 'read_source', { path: 'orders/linen-order.txt' })])),
    ]);
    const registry = await startTurn('turn-2');
    // The first process stops just before its second model step, as if it ended there.
    const gate: { resume?: () => void } = {};
    runs.use(async ({ step }) => {
      if (step.stepId === 'context:1') await new Promise<void>((resolve) => (gate.resume = resolve));
    });
    const stalled = new NativeAgent(runs, adapter(before.fetch), registry)
      .run('turn-2', 'host', 'What did we order?', principal)
      .catch((error: unknown) => error);
    while (!gate.resume) await new Promise((resolve) => setTimeout(resolve, 5));

    const restarted = runService();
    await restarted.recover('turn-2', principal);
    await restarted.claim('turn-2', 'host-2', 600_000);
    const after = network([
      () => json(envelope('resp_2', [answer('Order 1182 asked for 100 napkins (orders/linen-order.txt).')])),
    ]);
    // A new adapter instance: nothing is carried in memory between the two processes.
    const text = await new NativeAgent(restarted, adapter(after.fetch), sourceTools(SOURCES)).run(
      'turn-2',
      'host-2',
      'What did we order?',
      principal,
    );
    expect(text).toContain('orders/linen-order.txt');
    expect(before.sent).toHaveLength(1);
    expect(after.sent).toHaveLength(1);
    const input = after.sent[0].body.input;
    expect(input).toContainEqual(expect.objectContaining({ type: 'reasoning', id: 'rs_1', encrypted_content: 'enc-rs_1' }));
    expect(input.find((item) => item.type === 'function_call_output')?.call_id).toBe('call_1');
    const run = await restarted.get('turn-2');
    expect(run.state).toBe('completed');
    expect(run.steps.filter((step) => step.intent.kind === 'model')).toHaveLength(2);
    expect(exposure.list(CONNECTION.id).map((hold) => hold.state)).toEqual(['settled', 'settled']);

    // The first process, if it wakes, cannot write under its old lease.
    gate.resume?.();
    const stale = await stalled;
    expect(stale).toMatchObject({ code: 'stale_lease' });
  });

  test('a changed mode or connection cannot replay a saved context', async () => {
    const net = network([() => json(envelope('resp_1', [answer('Order 1182 (orders/linen-order.txt).')]))]);
    const registry = await startTurn('turn-3');
    await new NativeAgent(runs, adapter(net.fetch), registry).run('turn-3', 'host', 'What did we order?', principal);
    const silent = network([]);
    await expect(
      new NativeAgent(runs, adapter(silent.fetch, 'Different instructions.'), registry).run(
        'turn-3',
        'host',
        'What did we order?',
        principal,
      ),
    ).rejects.toMatchObject({ code: 'aws_profile_changed' });
    expect(silent.sent).toHaveLength(0);
  });

  test('two tool calls in one response are refused before any tool runs', async () => {
    const net = network([
      () =>
        json(
          envelope('resp_1', [
            call('call_1', 'read_source', { path: 'orders/linen-order.txt' }),
            call('call_2', 'read_source', { path: 'invoices/inv-1182.txt' }),
          ]),
        ),
    ]);
    const registry = await startTurn('turn-4');
    await expect(
      new NativeAgent(runs, adapter(net.fetch), registry).run('turn-4', 'host', 'Compare them.', principal),
    ).rejects.toMatchObject({ code: 'aws_multiple_tools' });
    const run = await runs.get('turn-4');
    expect(run.steps.some((step) => step.intent.kind === 'tool')).toBe(false);
    // The Runtime parks any failed external model step for reconciliation; the ledger knows it settled.
    expect(run.state).toBe('reconcile_required');
    expect(exposure.list(CONNECTION.id)[0].state).toBe('settled');
  });

  test('a connection change while a call is in flight: the answer is not accepted', async () => {
    const net = network([
      () => {
        services['aws-bedrockAccountRoute'] = awsAccountRoute({ ...CONNECTION, revision: 2 });
        return json(envelope('resp_1', [answer('Order 1182.')]));
      },
    ]);
    const registry = await startTurn('turn-5');
    await expect(
      new NativeAgent(runs, adapter(net.fetch), registry).run('turn-5', 'host', 'What did we order?', principal),
    ).rejects.toMatchObject({ code: 'egress_denied' });
    const run = await runs.get('turn-5');
    expect(run.state).toBe('reconcile_required');
    expect(run.result).toBeNull();
  });

  test('a route switched off in Settings sends nothing', async () => {
    services['aws-bedrock'] = false;
    const net = network([]);
    const registry = await startTurn('turn-6');
    await expect(
      new NativeAgent(runs, adapter(net.fetch), registry).run('turn-6', 'host', 'What did we order?', principal),
    ).rejects.toMatchObject({ code: 'egress_denied' });
    expect(net.sent).toHaveLength(0);
    expect(exposure.list(CONNECTION.id)).toHaveLength(0);
  });

  test('a crash while a call is in flight: recovery parks it uncertain and nothing is resent', async () => {
    const pending: { release?: () => void } = {};
    const net = network([
      (signal) =>
        new Promise<Response>((_resolve, reject) => {
          pending.release = () => reject(new Error("process ended"));
          signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
        }),
    ]);
    const registry = await startTurn('turn-7');
    const inflight = new NativeAgent(runs, adapter(net.fetch), registry)
      .run('turn-7', 'host', 'What did we order?', principal)
      .catch((error: unknown) => error);
    while (net.sent.length === 0) await new Promise((resolve) => setTimeout(resolve, 5));

    // A new process: a fresh ledger sweeps pending holds, a fresh Runtime recovers the run.
    const ledger = new SpendExposure(path.join(dir, 'spend'));
    await ledger.init();
    const [hold] = ledger.list(CONNECTION.id);
    expect(hold.state).toBe('uncertain');
    const restarted = runService();
    await restarted.recover('turn-7', principal);
    const run = await restarted.get('turn-7');
    expect(run.state).toBe('reconcile_required');
    expect(run.steps.find((step) => step.intent.stepId === 'model:0')?.state).toBe('reconcile_required');

    const silent = network([]);
    await restarted.claim('turn-7', 'host-2', 600_000).catch(() => undefined);
    await expect(
      new NativeAgent(restarted, adapter(silent.fetch, INSTRUCTIONS, ledger), sourceTools(SOURCES)).run(
        'turn-7',
        'host-2',
        'What did we order?',
        principal,
      ),
    ).rejects.toBeTruthy();
    expect(silent.sent).toHaveLength(0);
    pending.release?.();
    await inflight;
  });
});

describe('the conversation driver under the Runtime admission fence', () => {
  const conversation = (id: string) =>
    runs.start({
      id,
      projectId: PROJECT,
      tenantId: principal.tenantId,
      principal,
      capability: MODEL_CONVERSATION_CAPABILITY,
      input: { engine: 'aws-bedrock', scope: id },
      budget: { units: 8, modelCalls: 0, toolCalls: 0, wallMs: null },
    });

  test('commits a child inside the run queue, and refuses a settled run in its own words before the commit', async () => {
    const sessions = new ModelSessionRuns(runs, 'aws-bedrock');
    // Synthetic test policy for this standalone driver fixture: allow cloud
    // sharing; history stays off (no prior-history asserted here).
    sessions.setSharingPolicy(
      () => {},
      () => false,
    );
    await conversation('model-fence-1');
    expect(await sessions.fenced(PROJECT, 'model-fence-1', async () => 'committed')).toBe('committed');

    let foreign = false;
    await expect(
      sessions.fenced('another-project', 'model-fence-1', async () => {
        foreign = true;
      }),
    ).rejects.toThrow();
    expect(foreign).toBe(false);

    await runs.cancel('model-fence-1', 'The person moved on.', principal);
    let committed = false;
    await expect(
      sessions.fenced(PROJECT, 'model-fence-1', async () => {
        committed = true;
      }),
    ).rejects.toMatchObject({ code: 'RUN_SETTLED' });
    expect(committed).toBe(false);
  });

  test('identical concurrent phase saves are one write', async () => {
    const sessions = new ModelSessionRuns(runs, 'aws-bedrock');
    // Synthetic test policy for this standalone driver fixture: allow cloud
    // sharing; history stays off (no prior-history asserted here).
    sessions.setSharingPolicy(
      () => {},
      () => false,
    );
    await conversation('model-fence-2');
    const phase = { phase: 'decision', sourceMessageId: 'sm.1', body: { block: 'none' } } as unknown as InteractionPhase;
    await Promise.all([
      sessions.record(PROJECT, 'model-fence-2', [phase]),
      sessions.record(PROJECT, 'model-fence-2', [phase]),
    ]);
    expect(await sessions.phases(PROJECT, 'model-fence-2', 'sm.1')).toHaveLength(1);
    const run = await runs.get('model-fence-2');
    expect(run.steps.filter((step) => step.intent.stepId.startsWith('phase.'))).toHaveLength(1);
  });
});
