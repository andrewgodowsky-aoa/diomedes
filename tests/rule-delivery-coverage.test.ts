/**
 * Rule delivery coverage (2026-09-25): the rule path's section (shipped product knowledge and the
 * project's instruction files, `assembleInstructions`) reaches every model call that writes text
 * for a person, and each call says what it was sent under.
 *
 * Before this, only Work runs (`native-work.ts`) and work loop runs (`native-loop-routes.ts`)
 * were sent it. Conversation messages (Home and project threads, on every route), the explicit
 * native session routes, the direct Ask route and the loop's own helpers were sent their mode's
 * text and nothing from the rule path.
 *
 * Each test drives the real host over HTTP and reads what the adapter actually sent: the AWS
 * Responses body on a model-API route, the stream-json user message a real `ClaudeAdapter`
 * session writes to its (scripted) child, and the request a one-shot adapter is handed. Nothing
 * reaches a provider and nothing is spent.
 */
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../server/app';
import { EngineService, TESTED_VERSIONS } from '../server/engines/service';
import { AWS_LUNA_MODEL } from '../server/engines/aws-bedrock';
import { testOnlySecretBox } from '../server/connection-secrets';
import { contextMessage, type PersistentTextAdapter, type TextRequest } from '../server/engines/contract';
import { ClaudeAdapter } from '../server/engines/claude';
import type { ClaudeSessionCheckpoint } from '../server/engines/claude-session';
import { openProcess, type ProcessFactory } from '../server/engines/process';
import { routeContractFor } from '../server/harness/route-contract';
import { delegateInstructions } from '../server/harness/capabilities/native-loop';
import { childInstructions } from '../server/harness/capabilities/team-loop';
import { hash, type Store } from '../server/store';
import type { Conversation, Project } from '../shared/types';
import type { HarnessRun } from '../shared/harness';
import { ROUTES } from '../shared/engines';
import { responsesEvents, sseResponse } from './fixtures/model-api-streams.js';

const headers = { 'Content-Type': 'application/json', 'X-Diomedes-Client': '1' };
const PACK = 'diomedes.software-engineering';
const PRODUCT = '--- BEGIN DIOMEDES PRODUCT KNOWLEDGE ---';
const HOUSE = '# House rules\n\nQuote every price in dollars and cents.\n';
const HOUSE_LINE = 'Quote every price in dollars and cents.';
const MENU = { path: 'Fall menu.md', text: '# Fall menu\n\nSquash soup, 9.50.\n' };

let root: string;
let app: Awaited<ReturnType<typeof createApp>>;
let server: Server | undefined;
let base: string;
let project: Project;
let thread: Conversation;

async function request(route: string, method = 'GET', body?: unknown) {
  return fetch(`${base}/api${route}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
}
async function api<T>(route: string, method = 'GET', body?: unknown): Promise<T> {
  const response = await request(route, method, body);
  const text = await response.text();
  expect(response.ok, `${route}: ${response.status} ${text}`).toBe(true);
  return JSON.parse(text) as T;
}
const store = () => app.locals.store as Store;
async function open(options: Parameters<typeof createApp>[0]) {
  app = await createApp(options);
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
/** A project with the Software Engineering pack on and a shared, loaded root AGENTS.md. */
async function projectWithRules(routes: readonly string[]) {
  project = await api<Project>('/projects', 'POST', { name: 'Juniper Street Bakery' });
  const folder = store().state(project.id).project.folder;
  await fs.writeFile(path.join(folder, 'AGENTS.md'), HOUSE, 'utf8');
  await fs.writeFile(path.join(folder, MENU.path), MENU.text, 'utf8');
  await api(`/projects/${project.id}/cloud-sharing`, 'PUT', {
    expectedVersion: 0,
    routes,
    documents: ['AGENTS.md', MENU.path],
    shareConversationHistory: true,
    shareReviewPackets: false,
  });
  expect((await request(`/projects/${project.id}/packs/${PACK}/activate`, 'POST', {})).status).toBe(200);
  thread = await api<Conversation>(`/projects/${project.id}/threads`, 'POST', {});
}
async function sources() {
  return [{ path: MENU.path, sha: hash(MENU.text)! }];
}
async function until<T>(read: () => Promise<T> | T, done: (value: T) => boolean, what: string): Promise<T> {
  for (let attempt = 0; attempt < 400; attempt++) {
    const value = await read();
    if (done(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
  throw new Error(`Timed out waiting for ${what}.`);
}

afterEach(async () => {
  await close();
  await fs.rm(root, { recursive: true, force: true });
});

describe('the wire shapes', () => {
  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'diomedes-rule-coverage-unit-'));
  });

  test('a native session message carries the rules as their own field, never inside a document', () => {
    const input: TextRequest = {
      projectId: 'p',
      threadId: 't',
      requestId: 'r',
      prompt: 'How much is the soup?',
      documents: [{ path: 'Fall menu.md', text: 'Squash soup' }],
      instructions: 'mode text',
      model: 'm',
      accountRoute: 'a',
    };
    // Without rules the message is exactly what it always was.
    expect(contextMessage(input)).toBe(JSON.stringify({ request: input.prompt, documents: input.documents }));
    const sent = JSON.parse(contextMessage({ ...input, rules: { text: 'RULES', record: {} } }));
    expect(Object.keys(sent)).toEqual(['rules', 'request', 'documents']);
    expect(sent.rules).toBe('RULES');
    expect(JSON.stringify(sent.documents)).not.toContain('RULES');
  });

  test("a loop's helpers and team members are sent the loop's rules after their own role", () => {
    const delegate = delegateInstructions(1, ['Fall menu.md'], true, 'RULE SECTION');
    expect(delegate.endsWith('RULE SECTION')).toBe(true);
    expect(delegateInstructions(1, null, false)).not.toContain('RULE SECTION');
    const worker = childInstructions(
      'worker',
      { guidance: 'Check prices.' } as Parameters<typeof childInstructions>[1],
      ['Fall menu.md'],
      'RULE SECTION',
    );
    expect(worker).toContain('Your role: Check prices.');
    expect(worker.endsWith('RULE SECTION')).toBe(true);
  });
});

describe('model-API conversations (AWS Bedrock, Diomedes-owned system text)', () => {
  type Item = Record<string, unknown>;
  let seen: { instructions?: string; input: Item[] }[];

  const aws = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as (typeof seen)[number];
    seen.push(body);
    return sseResponse(
      responsesEvents({
        id: `resp_${seen.length}`,
        object: 'response',
        created_at: 1_790_000_000,
        status: 'completed',
        model: AWS_LUNA_MODEL,
        output: [
          {
            type: 'message',
            id: `msg_${seen.length}`,
            role: 'assistant',
            status: 'completed',
            content: [{ type: 'output_text', text: 'The soup is 9.50.', annotations: [] }],
          },
        ],
        usage: { input_tokens: 500, output_tokens: 20, total_tokens: 520 },
        incomplete_details: null,
        error: null,
      }),
      { 'x-amzn-requestid': `req-${seen.length}` },
    );
  }) as typeof globalThis.fetch;

  // The system text rides as the developer message of the Responses request.
  const system = (index: number) =>
    String(seen[index].input.find((item) => item.role === 'developer')?.content ?? seen[index].instructions ?? '');

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'diomedes-rule-coverage-aws-'));
    seen = [];
    await open({
      dataDir: path.join(root, 'data'),
      projectRoot: path.join(root, 'projects'),
      engineService: new EngineService(path.join(root, 'engines'), { discover: async () => [] }),
      reviewerAdapter: null,
      secretBox: testOnlySecretBox(),
      modelApiTransport: aws,
    });
    await api('/ai/model-api/aws-bedrock', 'PUT', {
      accountId: '123456789012',
      region: 'us-east-1',
      model: AWS_LUNA_MODEL,
      apiKey: 'test-only-bedrock-key-0123456789abcdef-never-real',
      expiresAt: null,
      consent: true,
    });
    await api('/ai/model-api/aws-bedrock/spend-limit', 'PUT', { capUsd: 1, consent: true });
  });

  const send = async (projectId: string, threadId: string, commandId: string, text: string, paths: { path: string; sha: string }[]) =>
    api<{ runId: string }>(`/projects/${projectId}/threads/${threadId}/messages`, 'POST', {
      commandId,
      text,
      mode: 'ask',
      sources: paths,
      consent: true,
    });

  test('a project thread message is sent the instruction file and product knowledge after its recorded text', async () => {
    await projectWithRules(ROUTES.filter((route) => route !== 'sample'));
    await api(`/projects/${project.id}/threads/${thread.id}`, 'PUT', { workStyle: 'efficient' });
    await send(project.id, thread.id, 'c1', 'How much is the soup?', await sources());
    await until(() => seen.length, (count) => count > 0, 'the AWS request');
    const sent = system(0);
    expect(sent).toContain(HOUSE_LINE);
    expect(sent).toContain(PRODUCT);
    expect(sent).toContain('Project instructions from AGENTS.md');
    // The lineage's recorded text stays the stable prefix; the rules follow it.
    const lineage = store().state(project.id).conversations.find((c) => c.id === thread.id)!.lineages![0];
    const run = await (app.locals.harness as { runs: { get(id: string): Promise<HarnessRun> } }).runs.get(lineage.runId);
    const recorded = String((run.input as { instructions: string }).instructions);
    expect(sent.startsWith(recorded)).toBe(true);
    expect(recorded).not.toContain(HOUSE_LINE);
  });

  test('an open conversation gets the edited rules on its next message and does not retire', async () => {
    await projectWithRules(ROUTES.filter((route) => route !== 'sample'));
    await api(`/projects/${project.id}/threads/${thread.id}`, 'PUT', { workStyle: 'efficient' });
    await send(project.id, thread.id, 'c1', 'How much is the soup?', await sources());
    await until(() => seen.length, (count) => count > 0, 'the first request');
    await until(
      () => store().state(project.id).conversations.find((c) => c.id === thread.id)!.turns.length,
      (count) => count >= 2,
      'the first answer',
    );
    await fs.writeFile(
      path.join(store().state(project.id).project.folder, 'AGENTS.md'),
      `${HOUSE}Round every total to the nearest dollar.\n`,
      'utf8',
    );
    await send(project.id, thread.id, 'c2', 'And the bread?', await sources());
    await until(() => seen.length, (count) => count > 1, 'the second request');
    expect(system(1)).toContain('Round every total to the nearest dollar.');
    const current = store().state(project.id).conversations.find((c) => c.id === thread.id)!;
    expect(current.lineages!.filter((lineage) => lineage.mode === 'ask')).toHaveLength(1);
    expect(current.lineages![0].retired ?? null).toBeNull();
  });

  test('Home is sent the shipped product knowledge', async () => {
    const home = await api<{ projectId: string; threadId: string }>('/home/conversation', 'POST', {});
    const state = store().state(home.projectId);
    await api(`/projects/${home.projectId}/cloud-sharing`, 'PUT', {
      expectedVersion: state.cloudSharing?.version ?? 0,
      routes: ROUTES.filter((route) => route !== 'sample'),
      documents: [],
      shareConversationHistory: true,
      shareReviewPackets: false,
    }).catch(() => undefined);
    await api(`/projects/${home.projectId}/threads/${home.threadId}`, 'PUT', { workStyle: 'efficient' });
    await send(home.projectId, home.threadId, 'h1', 'What can you do?', []);
    await until(() => seen.length, (count) => count > 0, 'the Home request');
    expect(system(0), JSON.stringify(seen[0]).slice(0, 2000)).toContain(PRODUCT);
  });
});

describe('Claude Code (native session, one-shot Ask)', () => {
  const model = 'sonnet';
  const accountRoute = 'claude-code:claude.ai';
  // A scripted stream-json child: it logs every user message it is sent, verbatim.
  const SCRIPT = `import readline from 'node:readline';
import fs from 'node:fs';
const [,, session, log] = process.argv;
const emit = (x) => console.log(JSON.stringify(x));
let count = 0;
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const m = JSON.parse(line);
  if (m.type === 'control_request') { emit({ type: 'control_response', response: { subtype: 'success', request_id: m.request_id, response: {} } }); return; }
  if (m.type !== 'user') return;
  count++;
  fs.appendFileSync(log, JSON.stringify(m.message.content) + '\\n');
  emit({ type: 'system', subtype: 'init', session_id: session, model: 'claude-sonnet-4-6', tools: [], mcp_servers: [] });
  emit({ type: 'result', uuid: session + '-' + process.pid + '-' + count, subtype: 'success', result: 'The soup is 9.50.', session_id: session, modelUsage: { 'claude-sonnet-4-6': {} } });
});`;
  let log: string;
  let oneShot: TextRequest[];
  const wire = async () =>
    (await fs.readFile(log, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(JSON.parse(line) as string) as { rules?: string; request: string });

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'diomedes-rule-coverage-claude-'));
    log = path.join(root, 'log.jsonl');
    oneShot = [];
    const script = path.join(root, 'claude.mjs');
    await fs.writeFile(script, SCRIPT);
    await fs.mkdir(path.join(root, 'transport'), { recursive: true });
    const launch: ProcessFactory = (options) => {
      const resume = options.args.includes('--resume');
      const session = options.args[options.args.indexOf(resume ? '--resume' : '--session-id') + 1];
      return openProcess({ ...options, file: process.execPath, args: [script, session, log], timeoutMs: 10_000 });
    };
    const transport = new ClaudeAdapter('claude.exe', path.join(root, 'transport'), {
      launch,
      account: async () => ({ loggedIn: true, authMethod: 'claude.ai', email: 'owner@example.com' }),
    });
    const adapter: PersistentTextAdapter<ClaudeSessionCheckpoint> = {
      id: 'claude-code',
      contract: routeContractFor('claude-code'),
      sessionContract: routeContractFor('claude-code-session'),
      inspect: async () => ({
        authentication: 'signed-in',
        accountRoute,
        detail: 'Fixture only',
        models: [{ slug: model, name: model, description: '', efforts: [], defaultEffort: null }],
      }),
      // The one-shot route: what it is handed is what it sends as its system prompt.
      generate: async (input) => {
        oneShot.push(input);
        return { text: 'The soup is 9.50.', model, version: TESTED_VERSIONS['claude-code'], threadId: input.threadId, projectId: input.projectId, requestId: input.requestId };
      },
      openSession: (input, options) => transport.openSession(input, options),
    };
    await open({
      dataDir: path.join(root, 'data'),
      projectRoot: path.join(root, 'projects'),
      engineService: new EngineService(path.join(root, 'engines'), {
        discover: async () => [
          {
            id: 'claude-code',
            name: 'Fixture',
            kind: 'online',
            found: true,
            available: false,
            enabled: false,
            status: 'Installed',
            detail: 'Fixture',
            capabilities: [],
            signIn: 'unknown',
            adapter: 'planned',
            installedVersion: TESTED_VERSIONS['claude-code'],
            location: process.execPath,
            disclosure: [],
          },
        ],
        version: async () => TESTED_VERSIONS['claude-code'],
        adapter: () => adapter,
      }),
      reviewerAdapter: null,
    });
    await api('/ai/discover', 'POST', { consent: true });
    await api('/ai/check/claude-code', 'POST', {});
    await api('/ai/select', 'POST', { engine: 'claude-code', model });
    await projectWithRules(['claude-code']);
    const state = store().state(project.id);
    state.conversations.find((item) => item.id === thread.id)!.engine = 'claude-code';
    state.project.ai = { engine: 'sample', model: null };
    await store().persist(state);
  });

  test('a conversation message carries the rules in the message the session writes, and the turn records them', async () => {
    await api(`/projects/${project.id}/threads/${thread.id}/messages`, 'POST', {
      commandId: 'c1',
      text: 'How much is the soup?',
      mode: 'ask',
      sources: await sources(),
      consent: true,
    });
    const [first] = await until(wire, (lines) => lines.length > 0, 'the session message').catch(async () => wire());
    expect(first.request).toContain('How much is the soup?');
    expect(first.rules).toContain(HOUSE_LINE);
    expect(first.rules).toContain(PRODUCT);
    // The turn's step says which rules it was sent under, by sha and path, never by body.
    const lineage = store().state(project.id).conversations.find((c) => c.id === thread.id)!.lineages![0];
    const run = await (app.locals.harness as { runs: { get(id: string): Promise<HarnessRun> } }).runs.get(lineage.runId);
    const turn = run.steps.find((step) => (step.intent.input as { requestId?: string }).requestId === 'c1')!;
    const record = (turn.intent.input as { rules: { files: { path: string; state: string }[]; sha256: string } }).rules;
    expect(record.files).toEqual([expect.objectContaining({ path: 'AGENTS.md', state: 'sent' })]);
    expect(record.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(record)).not.toContain(HOUSE_LINE);
  });

  test('the explicit native session route sends the rules the same way', async () => {
    await api(`/projects/${project.id}/claude-sessions`, 'POST', {
      commandId: 'n1',
      threadId: thread.id,
      text: 'How much is the soup?',
      mode: 'ask',
      sources: await sources(),
      consent: true,
    });
    const [first] = await wire();
    expect(first.rules).toContain(HOUSE_LINE);
    expect(first.rules).toContain(PRODUCT);
  });

  test('a direct Ask is sent the rules in its instruction channel', async () => {
    await api(`/projects/${project.id}/ask`, 'POST', {
      text: 'How much is the soup?',
      mode: 'ask',
      threadId: thread.id,
      route: 'claude-code',
      sources: (await sources()).map((source) => source.path),
      consent: true,
    });
    expect(oneShot).toHaveLength(1);
    expect(oneShot[0].instructions).toContain(HOUSE_LINE);
    expect(oneShot[0].instructions).toContain(PRODUCT);
    expect(oneShot[0].rules).toBeUndefined();
  });
});

