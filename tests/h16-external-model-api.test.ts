/**
 * H16 on model-API routes (OpenRouter here; Bedrock, Vertex and Azure share the same
 * `model-api-core` stream and the same Work paths). Real HTTP through `createApp`, the real
 * EngineService, model-API core, NativeAgent, RunService, Store, H15 and H08; only the
 * provider's HTTP endpoint is a fake that streams its answer in four-character deltas.
 *
 * Proven:
 * - Work without a team: a phrase is matched while the answer streams, on the text route's
 *   run and dispatch step, and the proposal is made unchanged.
 * - A team member's Work turn: Nectovia runs the team tools itself through RunService, so a
 *   tool rule holds a team tool call before it runs, and the member's run is paused for you;
 *   its answer does not stream, so a text rule judges it whole.
 */
import { afterEach, describe, expect, test, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../server/app.js';
import { EngineService } from '../server/engines/service.js';
import { OpenRouterConnections } from '../server/engines/openrouter.js';
import { testOnlySecretBox } from '../server/connection-secrets.js';
import { FileModelTranscripts } from '../server/harness/model-transcripts.js';
import { teamWorkRunId } from '../server/harness/model-session-run.js';
import { textRunId } from '../server/harness/text-route.js';
import type { Store } from '../server/store.js';
import type { ProjectState, TeamMember } from '../shared/types.js';
import type { StreamRule } from '../shared/stream-rules.js';
import { ROUTES } from '../shared/engines.js';
import { chatEvents, sseResponse } from './fixtures/model-api-streams.js';

const headers = { 'Content-Type': 'application/json', 'X-Diomedes-Client': '1' };
const OR_KEY = 'sk-or-test-only-0123456789abcdef-never-real';
const OR_MODEL = 'anthropic/claude-sonnet-4.5';
const SETTLE_MS = 45_000;
const rates = {
  inputUsdPerMillion: 3,
  outputUsdPerMillion: 15,
  cacheReadUsdPerMillion: null,
  cacheWriteUsdPerMillion: null,
  source: 'the provider price page, read by the test owner',
};
const PROPOSAL = JSON.stringify({
  summary: 'Add the lunch plan with soup first',
  changes: [{ path: 'plan.md', text: '# Lunch plan\n\nSoup first.\n', summary: 'A new plan' }],
});

type Item = Record<string, unknown>;
let root: string, base: string, projectId: string;
let app: Awaited<ReturnType<typeof createApp>>, server: Server | undefined;
let seen: Item[];

/** OpenRouter: a team tool call first when tools are offered, then the proposal. */
const network = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input);
  if (!url.startsWith('https://openrouter.ai/')) throw new Error(`Unexpected provider: ${url}`);
  const body = JSON.parse(String(init?.body)) as Item;
  seen.push(body);
  const messages = (body.messages ?? []) as Item[];
  if (body.tools && !messages.some((message) => message.role === 'tool'))
    return sseResponse(
      chatEvents({
        model: OR_MODEL,
        provider: 'Anthropic',
        toolCalls: [
          {
            id: 'call_team_1',
            name: 'team_send_message',
            arguments: JSON.stringify({ to: 'owner', message: 'Starting the lunch plan.' }),
          },
        ],
        usage: { prompt_tokens: 600, completion_tokens: 30, total_tokens: 630, is_byok: false },
      }),
    );
  return sseResponse(
    chatEvents({
      model: OR_MODEL,
      provider: 'Anthropic',
      text: PROPOSAL,
      usage: { prompt_tokens: 700, completion_tokens: 40, total_tokens: 740, is_byok: false },
    }),
  );
}) as typeof globalThis.fetch;

async function request<T = any>(route: string, method = 'GET', body?: unknown) {
  const response = await fetch(`${base}/api${route}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, data: (await response.json()) as T };
}
const store = () => app.locals.store as Store;
const state = () => store().state(projectId) as ProjectState;
const rule = (id: string, extra: Partial<StreamRule> & Pick<StreamRule, 'match' | 'intervention'>): StreamRule => ({
  id,
  version: 1,
  enabled: true,
  text: `Rule ${id}.`,
  ...extra,
});
async function projectRules(...rules: StreamRule[]) {
  const saved = await request(`/projects/${projectId}/stream-rules`, 'PUT', { protocolVersion: 1, rules });
  expect(saved.status, JSON.stringify(saved.data)).toBe(200);
}

async function open() {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'diomedes-h16-model-api-'));
  seen = [];
  const service = new EngineService(path.join(root, 'engines'), { discover: async () => [] });
  const dataDir = path.join(root, 'data');
  app = await createApp({
    dataDir,
    projectRoot: path.join(root, 'projects'),
    engineService: service,
    reviewerAdapter: null,
    secretBox: testOnlySecretBox(),
    modelApiTransport: network,
  });
  service.modelApi!.openrouter = {
    connections: new OpenRouterConnections(dataDir),
    transcripts: new FileModelTranscripts(path.join(dataDir, 'model-transcripts-openrouter'), 'openrouter'),
  };
  server = await new Promise<Server>((resolve) => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  projectId = (await request<{ id: string }>('/projects', 'POST', { name: 'Lunch service' })).data.id;
  await request(`/projects/${projectId}/cloud-sharing`, 'PUT', {
    expectedVersion: 0,
    routes: ROUTES.filter((route) => route !== 'sample'),
    documents: [],
    shareConversationHistory: true,
    shareReviewPackets: true,
  });
  expect(
    (
      await request('/ai/model-api/openrouter', 'PUT', {
        models: [{ id: OR_MODEL, upstreams: ['anthropic'], rates }],
        apiKey: OR_KEY,
        expiresAt: null,
        consent: true,
      })
    ).status,
  ).toBe(200);
  expect((await request('/ai/model-api/openrouter/spend-limit', 'PUT', { capUsd: 1, consent: true })).status).toBe(200);
}
afterEach(async () => {
  if (!server) return;
  const closing = server;
  server = undefined;
  try {
    await app.locals.close();
  } finally {
    closing.closeAllConnections();
    await new Promise<void>((resolve, reject) => closing.close((error) => (error ? reject(error) : resolve())));
  }
  await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

async function member(): Promise<TeamMember> {
  const created = await request<{ member: TeamMember }>(`/projects/${projectId}/team/members`, 'POST', {
    name: 'Pip',
    role: 'member',
    engine: 'openrouter',
    model: OR_MODEL,
  });
  expect(created.status, JSON.stringify(created.data)).toBe(200);
  expect(
    (await request(`/projects/${projectId}/team/messages`, 'POST', { to: created.data.member.slotId, content: 'Draft the lunch plan.' }))
      .status,
  ).toBe(200);
  return created.data.member;
}

describe('H16 trigger rules on model-API Work', () => {
  test('Work without a team: a phrase is matched while the answer streams, on the text route’s run, and the proposal is unchanged', async () => {
    await open();
    await projectRules(rule('soup-note', { match: { kind: 'text', phrase: 'soup first' }, intervention: 'annotate' }));
    const taskId = (await request<{ id: string }>(`/projects/${projectId}/tasks`, 'POST', { name: 'Plan lunch' })).data.id;
    const started = await request<{ id: string }>(`/projects/${projectId}/work/start`, 'POST', {
      taskId,
      route: 'openrouter',
      consent: true,
      sources: [],
    });
    expect(started.status, JSON.stringify(started.data)).toBe(200);
    await vi.waitFor(() => expect(state().needs.some((need) => need.state === 'open')).toBe(true), { timeout: SETTLE_MS });
    const firings = state().streamTriggerFirings ?? [];
    expect(firings).toHaveLength(1);
    const at = PROPOSAL.toLowerCase().indexOf('soup first');
    expect(firings[0]).toMatchObject({
      sessionId: started.data.id,
      taskId,
      runId: textRunId(projectId, started.data.id),
      stepId: 'text:dispatch',
      match: { kind: 'text', source: 'stream', start: at, end: at + 'soup first'.length, excerpt: 'soup first' },
      handling: 'recorded',
    });
    expect(state().needs.find((need) => need.state === 'open')!.files).toEqual(['plan.md']);
  });

  test('a team member: a tool rule holds its team tool call before it runs, and the member’s run is paused for you', async () => {
    await open();
    await projectRules(
      rule('messages-held', {
        match: { kind: 'tool', tool: 'team_send_message' },
        intervention: 'hold',
        text: 'A member’s messages wait for a person.',
      }),
    );
    const pip = await member();
    const woke = await request<{ sessionId: string }>(`/projects/${projectId}/team/members/${pip.slotId}/wake`, 'POST', {});
    expect(woke.status, JSON.stringify(woke.data)).toBe(200);
    const sessionId = woke.data.sessionId;
    await vi.waitFor(
      () => expect(['queued', 'working']).not.toContain(state().sessions.find((item) => item.id === sessionId)!.state),
      { timeout: SETTLE_MS },
    );
    await store().locked(async () => undefined);
    // The team tool never ran: the owner has no message from Pip, and no proposal was made.
    expect(state().team?.messages.some((message) => message.from === pip.slotId)).toBe(false);
    expect(state().needs.some((need) => need.sessionId === sessionId && need.approval)).toBe(false);
    const firing = (state().streamTriggerFirings ?? [])[0];
    expect(firing).toMatchObject({
      rule: { id: 'messages-held' },
      intervention: 'hold',
      handling: 'handed-to-supervision',
      sessionId,
      runId: teamWorkRunId(projectId, sessionId),
      match: { kind: 'tool', tool: 'team_send_message' },
    });
    const run = await app.locals.harness.runs.get(teamWorkRunId(projectId, sessionId));
    const step = run.steps.find((item: { intent: { name?: string } }) => item.intent.name === 'team_send_message');
    expect(step?.state ?? 'never admitted').not.toBe('succeeded');
    const escalation = state().needs.find((need) => need.sessionId === sessionId && need.state === 'open');
    expect(escalation?.supervision?.code).toBe('rule-trigger');
    expect(escalation?.what).toMatch(/held the proposed team_send_message call/);
  });

  test('a team member’s answer does not stream, so a text rule judges it whole before it becomes a proposal', async () => {
    await open();
    await projectRules(rule('soup-note', { match: { kind: 'text', phrase: 'soup first' }, intervention: 'annotate' }));
    const pip = await member();
    const woke = await request<{ sessionId: string }>(`/projects/${projectId}/team/members/${pip.slotId}/wake`, 'POST', {});
    expect(woke.status, JSON.stringify(woke.data)).toBe(200);
    await vi.waitFor(() => expect(state().needs.some((need) => need.state === 'open')).toBe(true), { timeout: SETTLE_MS });
    const firings = state().streamTriggerFirings ?? [];
    expect(firings).toHaveLength(1);
    expect(firings[0]).toMatchObject({
      sessionId: woke.data.sessionId,
      runId: teamWorkRunId(projectId, woke.data.sessionId),
      stepId: 'answer',
      match: { kind: 'text', source: 'final-text', excerpt: 'soup first' },
    });
  });
});
