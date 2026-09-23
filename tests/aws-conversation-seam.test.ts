/**
 * AWS Luna through the real conversation, over HTTP: the same messages route the
 * Console posts to, the real Store, RunService, interaction service, model-session
 * driver, NativeAgent loop, registered read tools, CD-1 selection, Work, Need and
 * recorded writer. Only the network under the AI SDK is replaced, so nothing here
 * reaches AWS or spends money. `close()` then `open()` over the same data
 * directory is a crash and restart.
 */
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../server/app';
import { EngineService } from '../server/engines/service';
import { AWS_LUNA_MODEL } from '../server/engines/aws-bedrock';
import { testOnlySecretBox, type SecretBox } from '../server/connection-secrets';
import type { ModelSessionRuns } from '../server/harness/model-session-run';
import type { Store } from '../server/store';
import { conversationCommandIds } from '../server/interaction-admission';
import type { MessageResult } from '../server/interaction-service';
import type { AwsConnectionView } from '../shared/model-api';
import type { Conversation, Project, ProjectState } from '../shared/types';
import { responsesEvents, sseResponse } from './fixtures/model-api-streams.js';

const headers = { 'Content-Type': 'application/json', 'X-Diomedes-Client': '1' };
const SECRET = 'test-only-bedrock-key-0123456789abcdef-never-real';
const DOCS = {
  order: { path: 'Linen order 1182.md', text: '# Order 1182\n\n100 napkins and 40 tablecloths, delivery Friday.\n' },
  delivery: {
    path: 'Friday delivery.md',
    text: '# Friday delivery, order 1182\n\n94 napkins and 40 tablecloths. The driver noted 6 napkins short.\n',
  },
  invoice: { path: 'Invoice 1182.md', text: '# Invoice 1182\n\nBills 100 napkins and 40 tablecloths.\n' },
};
const CHECKLIST = 'Linen delivery checklist.md';

let root: string;
let app: Awaited<ReturnType<typeof createApp>>;
let server: Server | undefined;
let service: EngineService;
let base: string;
let project: Project;
let thread: Conversation;

// --- the fake AWS Responses endpoint ------------------------------------------------

type Item = Record<string, unknown>;
interface Seen {
  url: string;
  authorization: string | null;
  body: { input: Item[]; tools?: Item[]; store?: boolean; model?: string };
}
let seen: Seen[];
let proposals: number;
let hang: { waiting: boolean };

const usage = { input_tokens: 1_400, input_tokens_details: { cached_tokens: 0 }, output_tokens: 220, output_tokens_details: { reasoning_tokens: 80 }, total_tokens: 1_620 };
const envelope = (output: Item[]) => ({
  id: `resp_${seen.length}`,
  object: 'response',
  created_at: 1_790_000_000,
  status: 'completed',
  model: AWS_LUNA_MODEL,
  output: [{ type: 'reasoning', id: `rs_${seen.length}`, summary: [], encrypted_content: `enc-${seen.length}` }, ...output],
  usage,
  incomplete_details: null,
  error: null,
});
const answer = (text: string): Item => ({
  type: 'message',
  id: `msg_${seen.length}`,
  role: 'assistant',
  status: 'completed',
  content: [{ type: 'output_text', text, annotations: [] }],
});
const userText = (body: Seen['body']) => {
  const user = body.input.find((item) => item.role === 'user');
  const content = user?.content;
  if (typeof content === 'string') return content;
  return Array.isArray(content) ? content.map((part) => String((part as Item).text ?? '')).join('') : '';
};
const decisionBlock = (sourceMessageId: string, summary: string) =>
  '```diomedes-decision\n' +
  JSON.stringify({
    source_message_id: sourceMessageId,
    disposition: 'act',
    requested_project_id: null,
    operation_class: 'write_internal',
    source_refs: [],
    target_run_id: null,
    question: null,
    public_summary: summary,
  }) +
  '\n```';

/** Answers like the model would, from what the request actually carries. */
function respond(body: Seen['body']): Item[] | 'hang' {
  const text = userText(body);
  if (!body.tools?.length) {
    // A Work call: a strict JSON file proposal, a little different each time it is asked.
    proposals += 1;
    if (text.includes('SLOW-WORK')) return 'hang';
    return [
      answer(
        JSON.stringify({
          summary: `Draft a linen delivery checklist (version ${proposals})`,
          changes: [
            {
              path: CHECKLIST,
              text: `# Linen delivery checklist (version ${proposals})\n\n- [ ] Count napkins against the order\n- [ ] Note shortages on the delivery slip\n- [ ] Compare the invoice before paying\n`,
              summary: 'A new checklist for checking linen deliveries.',
            },
          ],
        }),
      ),
    ];
  }
  const message = text.split("The person's message:\n\n")[1] ?? '';
  const issued = /\[\[diomedes source_message_id=(sm\.[0-9a-f]{32})\]\]\s*$/.exec(message)?.[1];
  const said = message.split('\n\n[[diomedes')[0];
  if (said.startsWith('SLOW')) return 'hang';
  if (said.startsWith('ACT') && issued)
    return [answer(`I can draft that checklist from the linen records.\n\n${decisionBlock(issued, 'Draft a linen delivery checklist')}`)];
  if (said.includes('napkins')) {
    const result = body.input.find((item) => item.type === 'function_call_output');
    if (!result)
      return [
        {
          type: 'function_call',
          id: `fc_${seen.length}`,
          call_id: 'call_linen_1',
          name: 'read_source',
          arguments: JSON.stringify({ path: DOCS.delivery.path }),
          status: 'completed',
        },
      ];
    const observed = String(result.output);
    return [
      answer(
        observed.includes('6 napkins short')
          ? `Six napkins were short on Friday (${DOCS.delivery.path}), yet invoice 1182 bills all 100 (${DOCS.invoice.path}).`
          : 'I could not find the delivery record.',
      ),
    ];
  }
  return [answer(`answer:${said}`)];
}

const aws = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const headersIn = new Headers(init?.headers);
  const body = JSON.parse(String(init?.body)) as Seen['body'];
  seen.push({ url: String(input), authorization: headersIn.get('authorization'), body });
  const output = respond(body);
  if (output === 'hang') {
    hang.waiting = true;
    return new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      signal?.addEventListener('abort', () => reject(signal.reason ?? new Error('aborted')), { once: true });
    });
  }
  return sseResponse(responsesEvents(envelope(output)), { 'x-amzn-requestid': `req-${seen.length}` });
}) as typeof globalThis.fetch;

// --- the app ------------------------------------------------------------------------

async function request(route: string, method = 'GET', body?: unknown) {
  return fetch(`${base}/api${route}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
}
async function api<T>(route: string, method = 'GET', body?: unknown): Promise<T> {
  const response = await request(route, method, body);
  const text = await response.text();
  expect(response.ok, `${route}: ${response.status} ${text}`).toBe(true);
  return JSON.parse(text) as T;
}
async function open(secretBox: SecretBox | null = testOnlySecretBox()) {
  app = await createApp({
    dataDir: path.join(root, 'data'),
    projectRoot: path.join(root, 'projects'),
    engineService: service,
    reviewerAdapter: null,
    secretBox,
    modelApiTransport: aws,
  });
  server = await new Promise<Server>((resolve) => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
async function close() {
  if (!server) return;
  await app.locals.close();
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server!.close((error) => (error ? reject(error) : resolve())));
  server = undefined;
}
const store = () => app.locals.store as Store;
const modelSessions = () => app.locals.harness.modelSessions as ModelSessionRuns;
const state = () => api<ProjectState>(`/projects/${project.id}/state`);
const messages = () => `/projects/${project.id}/threads/${thread.id}/messages`;
const sha = async (name: string) => (await store().readDocument(project.id, name)).sha;
const sources = async (...names: string[]) =>
  Promise.all(names.map(async (name) => ({ path: name, sha: await sha(name) })));
const send = async (commandId: string, text: string, attached: string[] = []) =>
  api<MessageResult>(messages(), 'POST', { commandId, text, mode: 'auto', sources: await sources(...attached), consent: true });
const select = (commandId: string, proposalDigest: string) =>
  api<MessageResult>(`${messages()}/${commandId}/select`, 'POST', { proposalDigest, projectId: project.id, consent: true });
const view = () => api<AwsConnectionView>('/ai/model-api/aws-bedrock');
const connect = (apiKey = SECRET) =>
  api<AwsConnectionView>('/ai/model-api/aws-bedrock', 'PUT', {
    accountId: '123456789012',
    region: 'us-east-1',
    model: AWS_LUNA_MODEL,
    apiKey,
    expiresAt: null,
    consent: true,
  });
const approveSpend = (capUsd = 1) =>
  api<AwsConnectionView>('/ai/model-api/aws-bedrock/spend-limit', 'PUT', { capUsd, consent: true });
const assistantTurns = () =>
  store()
    .state(project.id)
    .conversations.find((item) => item.id === thread.id)!
    .turns.filter((turn) => turn.role === 'assistant');
const lineageRun = () =>
  store()
    .state(project.id)
    .conversations.find((item) => item.id === thread.id)!
    .lineages!.filter((lineage) => !lineage.retired)
    .sort((a, b) => b.generation - a.generation)[0].runId;
async function until<T>(read: () => Promise<T>, done: (value: T) => boolean, what: string): Promise<T> {
  for (let attempt = 0; attempt < 400; attempt++) {
    const value = await read();
    if (done(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${what}.`);
}
const openNeed = () => until(state, (value) => value.needs.some((need) => need.state === 'open'), 'an open Need');
const resolveNeed = async (resolution: 'go-ahead' | 'declined') => {
  const need = (await state()).needs.find((item) => item.state === 'open')!;
  return api(`/projects/${project.id}/needs/${need.id}/resolve`, 'POST', {
    protocolVersion: 1,
    commandId: randomUUID(),
    resolution,
    allowForTask: false,
    proposalDigest: need.approval!.proposalDigest,
    actionDigest: need.approval!.actionDigest,
    baseDigest: need.approval!.baseDigest,
  });
};
const workFor = (sourceMessageId: string) => {
  const ids = conversationCommandIds(sourceMessageId);
  const current = store().state(project.id);
  return current.sessions.filter((session) => session.receipt?.commandId === ids.workCommandId);
};

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'diomedes-aws-seam-'));
  seen = [];
  proposals = 0;
  hang = { waiting: false };
  service = new EngineService(path.join(root, 'engines'), { discover: async () => [] });
  await open();
  project = await api<Project>('/projects', 'POST', { name: 'Linen service' });
  thread = await api<Conversation>(`/projects/${project.id}/threads`, 'POST', {});
  const folder = store().state(project.id).project.folder;
  for (const doc of Object.values(DOCS)) await fs.writeFile(path.join(folder, doc.path), doc.text, 'utf8');
  // The thread runs on AWS, chosen through the same thread route the Console's picker saves.
  // Work started from this conversation follows the thread's route.
  const chosen = await api<Conversation>(`/projects/${project.id}/threads/${thread.id}`, 'PUT', { engine: 'aws-bedrock' });
  expect(chosen.engine).toBe('aws-bedrock');
});
afterEach(async () => {
  await close();
  await fs.rm(root, { recursive: true, force: true });
});

async function connected() {
  await connect();
  await approveSpend();
  // Work takes the default route, chosen through the same settings save the Console uses.
  // Connecting never makes AWS the default by itself.
  const current = await api<{ services?: Record<string, unknown> }>('/settings');
  expect(current.services?.defaultEngine).not.toBe('aws-bedrock');
  await api('/settings', 'PUT', { ...current, services: { ...current.services, defaultEngine: 'aws-bedrock' } });
}

describe('AWS Luna in the actual Diomedes conversation', () => {
  test('connect AWS: the key goes only into protected storage, and nothing is sent before a spend limit is approved', async () => {
    const before = await view();
    expect(before).toMatchObject({ configured: false, protectedStorage: true, enabled: false });
    expect(before.next).toMatch(/Connect your AWS account/);

    const saved = await connect();
    expect(saved).toMatchObject({ configured: true, enabled: true });
    expect(saved.connection).toMatchObject({
      account: '••••9012',
      region: 'us-east-1',
      endpoint: 'https://bedrock-runtime.us-east-1.amazonaws.com/openai/v1',
      model: AWS_LUNA_MODEL,
      processing: 'us-geo',
      revision: 1,
      accountRoute: 'aws-bedrock:aws-bedrock-1@r1',
    });
    expect(JSON.stringify(saved)).not.toContain(SECRET);
    expect(saved.next).toMatch(/Approve a spend limit/);

    // Nothing admitted until the owner approves an amount.
    const refused = await request(messages(), 'POST', {
      commandId: 'm-early',
      text: 'How many napkins were short on Friday?',
      mode: 'auto',
      sources: [],
      consent: true,
    });
    expect(refused.ok).toBe(false);
    expect(await refused.text()).toMatch(/spend limit/i);
    expect(seen).toHaveLength(0);

    const approved = await approveSpend(1);
    expect(approved.spend).toMatchObject({ capMicroUsd: 1_000_000, availableMicroUsd: 1_000_000, recent: [] });
    expect(approved.next).toBeNull();

    // The key is on disk only sealed; no file under the data folder holds it in the clear.
    const files = await fs.readdir(path.join(root, 'data'), { recursive: true, withFileTypes: true });
    for (const file of files.filter((entry) => entry.isFile())) {
      const text = await fs.readFile(path.join(file.parentPath, file.name), 'utf8').catch(() => '');
      expect(text.includes(SECRET), path.join(file.parentPath, file.name)).toBe(false);
    }
  });

  test('without protected storage, as in the plain development server, the view still answers and nothing is saved', async () => {
    await close();
    await open(null);
    const plain = await view();
    expect(plain).toMatchObject({ configured: false, protectedStorage: false, enabled: false, connection: null });
    expect(plain.next).toMatch(/desktop app/);
    const refused = await request('/ai/model-api/aws-bedrock', 'PUT', {
      accountId: '123456789012',
      region: 'us-east-1',
      model: AWS_LUNA_MODEL,
      apiKey: SECRET,
      expiresAt: null,
      consent: true,
    });
    expect(refused.status).toBe(409);
    expect(await refused.text()).not.toContain(SECRET);
    expect((await view()).configured).toBe(false);
    const files = await fs.readdir(path.join(root, 'data'), { recursive: true, withFileTypes: true });
    for (const file of files.filter((entry) => entry.isFile())) {
      const text = await fs.readFile(path.join(file.parentPath, file.name), 'utf8').catch(() => '');
      expect(text.includes(SECRET), path.join(file.parentPath, file.name)).toBe(false);
    }
    expect(seen).toHaveLength(0);
  });

  test('ask about the linen records: a real registered read-tool call, a source-backed answer, attribution and usage', async () => {
    await connected();
    const asked = await send('m-linen', 'How many napkins were short on Friday, and were we billed for them?', [
      DOCS.order.path,
      DOCS.delivery.path,
      DOCS.invoice.path,
    ]);
    expect(asked.answerText).toBe(
      `Six napkins were short on Friday (${DOCS.delivery.path}), yet invoice 1182 bills all 100 (${DOCS.invoice.path}).`,
    );
    expect(asked.outcome).toEqual({ status: 'answered' });
    expect(asked.runId.startsWith('model-')).toBe(true);

    // Two provider exchanges: the model asked for the file, the harness read it, the model answered.
    expect(seen).toHaveLength(2);
    for (const call of seen) {
      expect(call.url).toBe('https://bedrock-runtime.us-east-1.amazonaws.com/openai/v1/responses');
      expect(call.authorization).toBe(`Bearer ${SECRET}`);
      expect(call.body.store).toBe(false);
      expect(call.body.model).toBe(AWS_LUNA_MODEL);
    }
    const toolOutput = seen[1].body.input.find((item) => item.type === 'function_call_output');
    expect(toolOutput?.call_id).toBe('call_linen_1');
    expect(String(toolOutput?.output)).toContain('The driver noted 6 napkins short.');
    expect(userText(seen[0].body)).toContain(DOCS.invoice.path);
    expect(userText(seen[0].body)).not.toContain('Bills 100 napkins');

    // The turn's own run records the tool step through the Runtime.
    const child = await modelSessions().turnRun(project.id, asked.runId, 'm-linen');
    expect(child?.state).toBe('completed');
    expect(child?.steps.map((step) => `${step.intent.kind}:${step.intent.name}`)).toEqual([
      'transform:prepare_model_context',
      'model:aws-bedrock',
      'tool:read_source',
      'transform:prepare_model_context',
      'model:aws-bedrock',
    ]);

    // The Console's record: who answered, requested and reported model, account route; no secret.
    const [turn] = assistantTurns();
    expect(turn.route).toBe('aws-bedrock');
    expect(turn.sources).toEqual([DOCS.order.path, DOCS.delivery.path, DOCS.invoice.path]);
    expect(turn.origin).toMatchObject({
      mode: 'direct',
      engine: { id: 'aws-bedrock', version: 'ai@7.0.107+@ai-sdk/openai@4.0.71' },
      model: { requested: AWS_LUNA_MODEL, reported: AWS_LUNA_MODEL, source: 'runtime' },
      accountRoute: 'aws-bedrock:aws-bedrock-1@r1',
    });
    expect(turn.helper).toMatchObject({ engine: 'aws-bedrock', verified: true });
    expect(JSON.stringify(store().state(project.id))).not.toContain(SECRET);

    // Usage: two settled holds, priced from the usage AWS reported.
    const usageView = await view();
    expect(usageView.spend!.recent.map((hold) => hold.state)).toEqual(['settled', 'settled']);
    expect(usageView.spend!.settledMicroUsd).toBeGreaterThan(0);
    expect(usageView.spend!.recent[0].usage).toMatchObject({ inputTokens: 1_400, outputTokens: 220, reasoningTokens: 80 });

    // The same message again is a replay: nothing is sent.
    expect(await send('m-linen', 'How many napkins were short on Friday, and were we billed for them?', [
      DOCS.order.path,
      DOCS.delivery.path,
      DOCS.invoice.path,
    ])).toEqual(asked);
    expect(seen).toHaveLength(2);

    // Job caps (owner decision 2026-09-23): the message is one job, named by its command id and
    // pinned under the host's tier; with no style set, the placeholder default of 20 credits.
    const job = await api<{ jobId: string; tier: string; capMicroUsd: number; stop: unknown }>(
      `/projects/${project.id}/jobs/m-linen`,
    );
    expect(job).toMatchObject({ jobId: 'm-linen', tier: 'efficient', capMicroUsd: 2_000_000, stop: null });
    // The pre-send estimate for the next message prices it from the route's declared card.
    const estimate = await api<{ estimate: { kind: string; capMicroUsd: number; warn: boolean } }>(
      `/projects/${project.id}/threads/${thread.id}/job-estimate`,
      'POST',
      { text: 'And the tablecloths?', mode: 'auto', sources: [] },
    );
    expect(estimate.estimate).toMatchObject({ kind: 'estimate', capMicroUsd: 2_000_000 });
  });

  test('request a draft checklist: deny one exact proposal and nothing changes; approve a new one and it is written', async () => {
    await connected();
    const folder = store().state(project.id).project.folder;

    const first = await send('m-act-1', 'ACT draft a linen delivery checklist');
    if (first.outcome.status !== 'proposed') throw new Error(`expected a proposal, got ${first.outcome.status}`);
    expect(first.answerText).toBe('I can draft that checklist from the linen records.');
    const started = await select('m-act-1', first.outcome.proposalDigest);
    expect(started.outcome).toMatchObject({ status: 'started', projectId: project.id });
    await openNeed();
    const [work] = workFor(first.sourceMessageId);
    expect(work.route).toBe('aws-bedrock');
    // Work's single call offered no tools and asked for the strict file proposal.
    const workCall = seen.at(-1)!;
    expect(workCall.body.tools ?? []).toEqual([]);
    expect(userText(workCall.body)).toContain('Return STRICT JSON only');

    await resolveNeed('declined');
    await expect(fs.stat(path.join(folder, CHECKLIST))).rejects.toMatchObject({ code: 'ENOENT' });
    const declined = await until(state, (value) => !value.needs.some((need) => need.state === 'open'), 'the Need to close');
    expect(declined.sessions.find((session) => session.id === work.id)?.state).not.toBe('working');

    const second = await send('m-act-2', 'ACT draft the linen delivery checklist again');
    if (second.outcome.status !== 'proposed') throw new Error(`expected a proposal, got ${second.outcome.status}`);
    await select('m-act-2', second.outcome.proposalDigest);
    await openNeed();
    await resolveNeed('go-ahead');
    const written = await until(
      () => fs.readFile(path.join(folder, CHECKLIST), 'utf8').catch(() => null),
      (text) => text !== null,
      'the approved checklist',
    );
    expect(written).toContain('# Linen delivery checklist (version 2)');
    const [approvedWork] = workFor(second.sourceMessageId);
    const after = await until(
      state,
      (value) => value.sessions.find((session) => session.id === approvedWork.id)?.state === 'done',
      'the approved Work to finish',
    );
    const session = after.sessions.find((item) => item.id === approvedWork.id)!;
    expect(session.origin).toMatchObject({
      mode: 'direct',
      engine: { id: 'aws-bedrock' },
      model: { requested: AWS_LUNA_MODEL, reported: AWS_LUNA_MODEL, source: 'runtime' },
      accountRoute: 'aws-bedrock:aws-bedrock-1@r1',
      executorId: 'diomedes:recorded-writer',
    });
    // The file was written by the recorded writer, with a record of the change.
    expect(after.history.some((entry) => entry.files?.some((file) => file.path === CHECKLIST && file.recorded))).toBe(true);
    // Paid calls: two conversation answers and two Work proposals, all settled.
    expect((await view()).spend!.recent.map((hold) => hold.state)).toEqual(['settled', 'settled', 'settled', 'settled']);
  });

  test('stop a conversation turn; after a restart its status is honest and the conversation continues', async () => {
    await connected();
    const pending = send('m-slow', 'SLOW think about the linen invoices for a long time');
    await until(async () => hang.waiting, Boolean, 'the call to reach AWS');
    const runId = lineageRun();
    const stopped = await api<{ acknowledged: boolean }>(`/projects/${project.id}/model-sessions/${runId}/interrupt`, 'POST', {
      commandId: 'stop-1',
    });
    expect(stopped.acknowledged).toBe(true);
    const result = await pending;
    expect(result.interrupted).toBe(true);
    expect(result.answerText).toBeNull();

    // The call left, so its cost is unknown: held as uncertain, never released, never resent.
    const held = await view();
    expect(held.spend!.recent[0]).toMatchObject({ state: 'uncertain' });
    expect(held.spend!.uncertainMicroUsd).toBeGreaterThan(0);
    expect(await api(`/projects/${project.id}/model-sessions/${runId}`)).toMatchObject({ state: 'waiting', connected: true });
    // Reading the message back reports the interruption the turn saved, and sends nothing.
    const polled = await api<MessageResult>(`${messages()}/m-slow`);
    expect(polled).toMatchObject({ runId, interrupted: true, answerText: null });

    await close();
    await open();
    const restarted = await view();
    expect(restarted.spend!.recent[0]).toMatchObject({ state: 'uncertain' });
    expect(await api<MessageResult>(`${messages()}/m-slow`)).toMatchObject({ runId, interrupted: true });
    // Recovery releases the dead process's lease; like a Claude conversation, the run reads
    // queued with no owner, still live, so the next message follows up on it.
    expect(await api(`/projects/${project.id}/model-sessions/${runId}`)).toMatchObject({ state: 'queued', connected: true });
    // Sending the stopped message again replays its recorded outcome; nothing is sent.
    const calls = seen.length;
    expect((await send('m-slow', 'SLOW think about the linen invoices for a long time')).interrupted).toBe(true);
    expect(seen).toHaveLength(calls);

    const next = await send('m-after', 'Good morning');
    expect(next.answerText).toBe('answer:Good morning');
    expect(next.runId).toBe(runId);
  });

  test("stop AWS Work with the Console's Stop; after a restart nothing was written and the call stays uncertain", async () => {
    await connected();
    const folder = store().state(project.id).project.folder;
    const proposed = await send('m-act-slow', 'ACT draft a checklist SLOW-WORK');
    if (proposed.outcome.status !== 'proposed') throw new Error('expected a proposal');
    await select('m-act-slow', proposed.outcome.proposalDigest);
    await until(async () => hang.waiting, Boolean, 'the Work call to reach AWS');
    const [work] = workFor(proposed.sourceMessageId);
    await api(`/projects/${project.id}/work/${work.id}/stop`, 'POST', {});
    const stopped = await until(
      state,
      (value) => value.sessions.find((session) => session.id === work.id)?.state !== 'working',
      'the Work session to stop',
    );
    expect(stopped.needs.some((need) => need.state === 'open')).toBe(false);
    const holds = (await view()).spend!.recent;
    expect(holds[0]).toMatchObject({ state: 'uncertain' });

    await close();
    await open();
    const after = await state();
    expect(after.sessions.find((session) => session.id === work.id)?.state).toBe(
      stopped.sessions.find((session) => session.id === work.id)?.state,
    );
    await expect(fs.stat(path.join(folder, CHECKLIST))).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await view()).spend!.recent[0]).toMatchObject({ state: 'uncertain' });
  });

  test('a new key is a new connection generation: the old lineage is retired, and Build from the thread runs on the new key', async () => {
    await connected();
    const first = await send('m-one', 'Good morning');
    await connect('test-only-bedrock-key-second-generation-0000');
    expect((await view()).connection?.accountRoute).toBe('aws-bedrock:aws-bedrock-1@r2');
    const second = await send('m-two', 'Good afternoon');
    expect(second.answerText).toBe('answer:Good afternoon');
    expect(second.runId).not.toBe(first.runId);
    expect(seen.at(-1)?.authorization).toBe('Bearer test-only-bedrock-key-second-generation-0000');

    // Owner decision 2026-09-23: a thread runs Build and Fix on every connected route, AWS
    // included, reversing CD-01 Decision 5's refusal. Ask and Plan still answer through the
    // conversation, so the direct route refuses them as before.
    const plan = await request(`/projects/${project.id}/ask`, 'POST', {
      text: 'Plan it now',
      threadId: thread.id,
      mode: 'plan',
      consent: true,
    });
    expect(plan.status).toBe(409);
    expect(await plan.text()).toMatch(/answers through the conversation/);

    const calls = seen.length;
    const direct = await request(`/projects/${project.id}/ask`, 'POST', {
      text: 'Draft it now',
      threadId: thread.id,
      mode: 'build',
      consent: true,
    });
    expect(direct.status, await direct.clone().text()).toBe(200);
    const { session: work } = (await direct.json()) as { session: { id: string; route: string } };
    expect(work.route).toBe('aws-bedrock');
    await openNeed();
    // One Work call, on the new key, with no tools and the strict proposal contract.
    expect(seen).toHaveLength(calls + 1);
    expect(seen.at(-1)?.authorization).toBe('Bearer test-only-bedrock-key-second-generation-0000');
    expect(seen.at(-1)?.body.tools ?? []).toEqual([]);
    expect(userText(seen.at(-1)!.body)).toContain('Return STRICT JSON only');
    const folder = store().state(project.id).project.folder;
    await expect(fs.stat(path.join(folder, CHECKLIST))).rejects.toMatchObject({ code: 'ENOENT' });
    await resolveNeed('go-ahead');
    const written = await until(
      () => fs.readFile(path.join(folder, CHECKLIST), 'utf8').catch(() => null),
      (text) => text !== null,
      'the approved checklist',
    );
    expect(written).toContain('# Linen delivery checklist');
    const done = await until(
      state,
      (value) => value.sessions.find((session) => session.id === work.id)?.state === 'done',
      'the Build to finish',
    );
    expect(done.sessions.find((session) => session.id === work.id)?.origin).toMatchObject({
      engine: { id: 'aws-bedrock' },
      model: { requested: AWS_LUNA_MODEL, reported: AWS_LUNA_MODEL, source: 'runtime' },
      accountRoute: 'aws-bedrock:aws-bedrock-1@r2',
      executorId: 'diomedes:recorded-writer',
    });
  });
});
