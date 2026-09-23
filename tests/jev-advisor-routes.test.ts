import { afterEach, describe, expect, test, vi } from 'vitest';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../server/app.js';
import { forgetCatalog } from '../server/models.js';
import { createJevAdvisor, type JevAdvisor } from '../server/harness/jev-advisor.js';
import {
  scriptedEvaluationPort,
  type EvaluationPort,
  type EvaluationPortCall,
} from '../server/harness/evaluation-adapter.js';

/**
 * The preflight route, mounted only when the host is given an advisor. The
 * advisor here always sits on a fixture port, and the ChatGPT runtime is
 * stubbed, so nothing is sent anywhere and nothing is charged.
 */
const calls: { model?: string; effort?: string }[] = [];
vi.mock('../server/integrations.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../server/integrations.js')>();
  return {
    ...actual,
    askCodex: async (input: { model?: string; effort?: string }) => {
      calls.push({ model: input.model, effort: input.effort });
      return { text: 'An answer.', model: input.model ?? 'gpt-6-astra', version: '0.153.4', threadId: 'mock-thread' };
    },
  };
});

const LEVELS = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
const entry = (slug: string, priority: number) => ({
  slug,
  display_name: slug.toUpperCase(),
  description: '',
  default_reasoning_level: 'medium',
  supported_reasoning_levels: LEVELS.map((effort) => ({ effort, description: '' })),
  visibility: 'list',
  priority,
});

const PLAN = 'Work out a staffing plan for the holiday weekend given the new opening hours.';
const reply = {
  answers: {
    workload: {
      type: 'choice',
      choice: 'planning',
      probabilities: { lookup: 0.05, extraction: 0.05, planning: 0.8, reasoning: 0.1 },
    },
    'needs-unattached-material': { type: 'boolean', probability: 0.1 },
    'needs-clarification': { type: 'boolean', probability: 0.1 },
    'needs-extra-review': { type: 'boolean', probability: 0.9 },
  },
};

let server: Server | undefined, app: Awaited<ReturnType<typeof createApp>> | undefined;
let url = '', home = '', previousHome: string | undefined;
const headers = { 'Content-Type': 'application/json', 'X-Diomedes-Client': '1' };

async function start(jevAdvisor?: JevAdvisor) {
  calls.length = 0;
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'diomedes-preflight-codex-'));
  previousHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = home;
  fs.writeFileSync(
    path.join(home, 'models_cache.json'),
    JSON.stringify({ models: [entry('gpt-6-astra', 1), entry('gpt-6-sol', 2), entry('gpt-6-luna', 3)] }),
    'utf8',
  );
  forgetCatalog();
  await fsp.mkdir(path.join(process.cwd(), 'test-results'), { recursive: true });
  const temp = await fsp.mkdtemp(path.join(process.cwd(), 'test-results', 'preflight-'));
  app = await createApp({
    dataDir: path.join(temp, 'data'),
    projectRoot: path.join(temp, 'projects'),
    stepMs: 20,
    ...(jevAdvisor ? { jevAdvisor } : {}),
  });
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server!.once('listening', resolve));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function request(route: string, method = 'GET', body?: unknown) {
  const response = await fetch(`${url}/api${route}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let data: any = null;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }
  return { status: response.status, data };
}

async function efficientThread() {
  await request('/settings', 'PUT', { services: { codex: true } });
  const created = await request('/projects/sample', 'POST', {});
  const projectId = created.data.id as string;
  const thread = await request(`/projects/${projectId}/threads`, 'POST', { name: 'Preflight' });
  const threadId = thread.data.id as string;
  await request(`/projects/${projectId}/threads/${threadId}`, 'PUT', { workStyle: 'efficient', engine: 'codex' });
  return { projectId, threadId };
}

afterEach(async () => {
  const closingApp = app, closingServer = server;
  app = undefined;
  server = undefined;
  try {
    await closingApp?.locals.close();
  } finally {
    if (closingServer) {
      closingServer.closeAllConnections();
      await new Promise<void>((resolve, reject) => closingServer.close((e) => (e ? reject(e) : resolve())));
    }
    if (previousHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousHome;
    forgetCatalog();
    if (home) fs.rmSync(home, { recursive: true, force: true });
  }
});

describe('the preflight route', () => {
  test('does not exist unless the host is given an advisor', async () => {
    await start();
    const { projectId, threadId } = await efficientThread();
    const response = await request(`/projects/${projectId}/threads/${threadId}/preflight`, 'POST', { text: PLAN });
    expect(response.status).toBe(404);
  });

  test('returns the advice beside the resolution with and without it', async () => {
    const port = scriptedEvaluationPort({ result: reply });
    await start(createJevAdvisor({ port }));
    const { projectId, threadId } = await efficientThread();
    const { status, data } = await request(`/projects/${projectId}/threads/${threadId}/preflight`, 'POST', {
      text: PLAN,
      sources: [{ path: 'hours.md', sha: 'abc' }],
    });
    expect(status).toBe(200);
    expect(data.advice.status).toBe('advised');
    expect(data.advice.hints.demanding).toBe(true);
    expect(data.advice.hints.needsReview).toBe(true);
    expect(data.resolution.deterministic.escalation).toBeNull();
    // The demanding reading surfaces an escalation that still needs approval,
    // and leaves the model where the style put it.
    expect(data.resolution.advised.escalation).toBe('needs-approval');
    expect(data.resolution.advised.model).toBe('gpt-6-luna');
    expect(data.resolution.advised.model).toBe(data.resolution.deterministic.model);
    expect(port.calls).toHaveLength(1);
    expect(JSON.stringify(port.calls[0].state)).toContain('hours.md');
  });

  test('changes nothing about dispatch: the next message runs as it would have', async () => {
    const port = scriptedEvaluationPort({ result: reply });
    await start(createJevAdvisor({ port }));
    const { projectId, threadId } = await efficientThread();
    const preview = await request(`/projects/${projectId}/threads/${threadId}/preflight`, 'POST', { text: PLAN });
    const sent = await request(`/projects/${projectId}/ask`, 'POST', {
      mode: 'ask',
      text: PLAN,
      route: 'codex',
      threadId,
      consent: true,
    });
    expect(sent.status).toBe(200);
    expect(calls.at(-1)?.model).toBe(preview.data.resolution.deterministic.model);
    // Dispatch never asks the advisor.
    expect(port.calls).toHaveLength(1);
  });

  test('an unavailable provider still returns the deterministic resolution, unchanged', async () => {
    await start(createJevAdvisor({ port: scriptedEvaluationPort({ failWith: new Error('offline') }) }));
    const { projectId, threadId } = await efficientThread();
    const { status, data } = await request(`/projects/${projectId}/threads/${threadId}/preflight`, 'POST', { text: PLAN });
    expect(status).toBe(200);
    expect(data.advice.status).toBe('unavailable');
    expect(data.resolution.advised).toEqual(data.resolution.deterministic);
  });

  test('a greeting is answered without asking the provider', async () => {
    const port = scriptedEvaluationPort({ result: reply });
    await start(createJevAdvisor({ port }));
    const { projectId, threadId } = await efficientThread();
    const { data } = await request(`/projects/${projectId}/threads/${threadId}/preflight`, 'POST', { text: 'thanks!' });
    expect(data.advice.status).toBe('skipped');
    expect(port.calls).toHaveLength(0);
  });

  test('asks the provider outside the store lock, so other requests are not held behind it', async () => {
    const pending: EvaluationPortCall[] = [];
    const hanging: EvaluationPort = {
      id: 'hanging-fixture',
      version: '1',
      requestedModel: 'fixture',
      scripted: true,
      supports: ['choice', 'score', 'boolean'],
      evaluate(call) {
        pending.push(call);
        return new Promise((_resolve, reject) =>
          call.signal.addEventListener('abort', () => reject(call.signal.reason), { once: true }),
        );
      },
    };
    await start(createJevAdvisor({ port: hanging, timeoutMs: 1_500 }));
    const { projectId, threadId } = await efficientThread();
    const preflight = request(`/projects/${projectId}/threads/${threadId}/preflight`, 'POST', { text: PLAN });
    while (pending.length === 0) await new Promise((resolve) => setTimeout(resolve, 5));
    const started = Date.now();
    const view = await request(`/projects/${projectId}/threads/${threadId}/work-style`);
    expect(view.status).toBe(200);
    expect(Date.now() - started).toBeLessThan(1_000);
    const done = await preflight;
    expect(done.data.advice.status).toBe('unavailable');
    expect(done.data.advice.reason).toMatch(/did not answer/);
  });

  test('refuses a thread that does not exist, and a missing message', async () => {
    await start(createJevAdvisor({ port: scriptedEvaluationPort({ result: reply }) }));
    const { projectId, threadId } = await efficientThread();
    expect((await request(`/projects/${projectId}/threads/nope/preflight`, 'POST', { text: PLAN })).status).toBe(404);
    expect((await request(`/projects/${projectId}/threads/${threadId}/preflight`, 'POST', { text: '' })).status).toBe(400);
  });
});
