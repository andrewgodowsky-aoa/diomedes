/**
 * Plain writing on the real routes (Andrew, 2026-09-25): the writing standard reaches the model
 * through the rule path, and the finished answer is checked and repaired where it is committed,
 * with the record on the answer's own run record.
 *
 * - A model-API conversation (AWS, Diomedes-owned): code fixes, then one rewrite of only the
 *   flagged sentences on the same admitted route; the rewrite's own request is read to prove it.
 * - A Claude Code conversation (native session): code fixes only, recorded on the turn step.
 * - A Work proposal: its summary and prose files are checked and fixed in code; code files are not.
 * - The owner's phrases from Settings, and the weekly brief, which has no model.
 *
 * Nothing reaches a provider and nothing is spent.
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
import type { PersistentTextAdapter, TextRequest } from '../server/engines/contract';
import { ClaudeAdapter } from '../server/engines/claude';
import type { ClaudeSessionCheckpoint } from '../server/engines/claude-session';
import { openProcess, type ProcessFactory } from '../server/engines/process';
import { routeContractFor } from '../server/harness/route-contract';
import { REWRITE_INSTRUCTIONS } from '../server/plain-writing';
import { renderBrief } from '../server/weekly-brief';
import { checkPlainWriting, type PlainWritingRecord } from '../shared/plain-writing';
import { hash, type Store } from '../server/store';
import type { Conversation, Project } from '../shared/types';
import type { HarnessRun } from '../shared/harness';
import { ROUTES } from '../shared/engines';
import { responsesEvents, sseResponse } from './fixtures/model-api-streams.js';
import { AUTOMATION_LABEL_TEXT, SCHEDULE_OUTCOME } from '../shared/automations';
import { briefSources } from '../shared/citations';

const headers = { 'Content-Type': 'application/json', 'X-Diomedes-Client': '1' };
const STANDARD = '--- NECTOVIA WRITING STANDARD ---';
const MENU = { path: 'Fall menu.md', text: '# Fall menu\n\nSquash soup, 9.50. Rye bread, 4.\n' };

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
const runs = () => (app.locals.harness as { runs: { get(id: string): Promise<HarnessRun> } }).runs;
async function open(options: Parameters<typeof createApp>[0]) {
  app = await createApp(options);
  server = await new Promise<Server>((resolve) => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
afterEach(async () => {
  if (server) {
    await app.locals.close();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server!.close((error) => (error ? reject(error) : resolve())));
    server = undefined;
  }
  await fs.rm(root, { recursive: true, force: true });
});
async function bakery(routes: readonly string[]) {
  project = await api<Project>('/projects', 'POST', { name: 'Juniper Street Bakery' });
  await fs.writeFile(path.join(store().state(project.id).project.folder, MENU.path), MENU.text, 'utf8');
  await api(`/projects/${project.id}/cloud-sharing`, 'PUT', {
    expectedVersion: 0,
    routes,
    documents: [MENU.path],
    shareConversationHistory: true,
    shareReviewPackets: false,
  });
  thread = await api<Conversation>(`/projects/${project.id}/threads`, 'POST', {});
}
const message = (commandId: string, text: string) => ({
  commandId,
  text,
  mode: 'ask',
  sources: [{ path: MENU.path, sha: hash(MENU.text)! }],
  consent: true,
});
const answerTurn = () =>
  store()
    .state(project.id)
    .conversations.find((c) => c.id === thread.id)!
    .turns.filter((turn) => turn.role === 'assistant')
    .at(-1);
/** The committed turn step output of the thread's lineage run for a command. */
async function stepOutput(commandId: string) {
  const lineage = store().state(project.id).conversations.find((c) => c.id === thread.id)!.lineages![0];
  const run = await runs().get(lineage.runId);
  const step = run.steps.find(
    (item) =>
      (item.intent.input as { requestId?: string } | null)?.requestId === commandId &&
      Boolean((item.output as { response?: unknown } | null)?.response),
  )!;
  return step.output as unknown as { writing?: PlainWritingRecord; response: { text: string } };
}
async function until<T>(read: () => Promise<T> | T, done: (value: T) => boolean, what: string): Promise<T> {
  for (let attempt = 0; attempt < 400; attempt++) {
    const value = await read();
    if (done(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
  throw new Error(`Timed out waiting for ${what}.`);
}

describe('a model-API conversation: code fixes, then one rewrite of the flagged sentences', () => {
  type Item = Record<string, unknown>;
  let seen: { input: Item[] }[];
  let reply: (developer: string, user: string) => string;
  const text = (body: { input: Item[] }, role: string) => {
    const content = body.input.find((item) => item.role === role)?.content;
    return typeof content === 'string'
      ? content
      : Array.isArray(content)
        ? content.map((part) => String((part as Item).text ?? '')).join('')
        : '';
  };
  const aws = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { input: Item[] };
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
            content: [{ type: 'output_text', text: reply(text(body, 'developer'), text(body, 'user')), annotations: [] }],
          },
        ],
        usage: { input_tokens: 400, output_tokens: 30, total_tokens: 430 },
        incomplete_details: null,
        error: null,
      }),
      { 'x-amzn-requestid': `req-${seen.length}` },
    );
  }) as typeof globalThis.fetch;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'diomedes-plain-writing-aws-'));
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
    await bakery(ROUTES.filter((route) => route !== 'sample'));
    await api(`/projects/${project.id}/threads/${thread.id}`, 'PUT', { workStyle: 'efficient' });
  });

  test('the answer is sent the standard, repaired in code and by one rewrite, and the record says what changed', async () => {
    reply = (developer, user) =>
      developer.startsWith(REWRITE_INSTRUCTIONS)
        ? // The rewrite: one good sentence, and one that changes a price and must be refused.
          JSON.stringify({ '1': 'We bake it in a steady oven.', '2': 'The rye is a strong seller at 5.' })
        : user.includes('soup')
          ? 'Great question! The soup is 9.50 — the rye bread is 4. We leverage a robust oven for it. The rye is, ultimately, a strong seller at 4.'
          : 'Noted.';
    await api(`/projects/${project.id}/threads/${thread.id}/messages`, 'POST', message('c1', 'How much is the soup?'));
    await until(answerTurn, (turn) => Boolean(turn), 'the answer');

    // The answer call was sent the writing standard through the rule path.
    expect(text(seen[0], 'developer')).toContain(STANDARD);
    // Exactly one more call, the rewrite, and it carried only the two flagged sentences.
    expect(seen).toHaveLength(2);
    const asked = text(seen[1], 'user');
    expect(asked).toContain('We leverage a robust oven for it.');
    expect(asked).toContain('The rye is, ultimately, a strong seller at 4.');
    expect(asked).not.toContain('9.50');
    expect(text(seen[1], 'developer').startsWith(REWRITE_INSTRUCTIONS)).toBe(true);
    expect(text(seen[1], 'developer')).not.toContain(STANDARD);

    // What the person reads: the opener and the dash fixed in code, one sentence rewritten, and
    // the sentence whose rewrite changed a price kept as the model wrote it.
    expect(answerTurn()!.text).toBe('The soup is 9.50. The rye bread is 4. We bake it in a steady oven. The rye is, ultimately, a strong seller at 4.');
    const output = await stepOutput('c1');
    expect(output.response.text).toBe(answerTurn()!.text);
    expect(output.writing!.hits.map((hit) => hit.rule).sort()).toEqual([
      'em-dash',
      'filler-opener',
      'stock-phrase',
      'stock-phrase',
      'stock-phrase',
    ]);
    expect(output.writing!.fixed.map((fix) => fix.rule)).toEqual(['em-dash', 'filler-opener']);
    expect(output.writing!.rewrite).toMatchObject({ asked: 2, accepted: 1, kept: [{ reason: 'facts-changed' }] });
    expect(output.writing!.remaining).toEqual([{ rule: 'stock-phrase', match: 'ultimately' }]);
  });

  test('a clean answer costs no second call', async () => {
    reply = () => 'The soup is 9.50.';
    await api(`/projects/${project.id}/threads/${thread.id}/messages`, 'POST', message('c1', 'How much is the soup?'));
    await until(answerTurn, (turn) => Boolean(turn), 'the answer');
    expect(seen).toHaveLength(1);
    expect((await stepOutput('c1')).writing).toMatchObject({ hits: [], rewrite: null });
  });
});

describe('Claude Code: the native session is checked and fixed in code, and Work proposals too', () => {
  const model = 'sonnet';
  const accountRoute = 'claude-code:claude.ai';
  const SCRIPT = `import readline from 'node:readline';
import fs from 'node:fs';
const [,, session, log, answer] = process.argv;
const emit = (x) => console.log(JSON.stringify(x));
let count = 0;
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const m = JSON.parse(line);
  if (m.type === 'control_request') { emit({ type: 'control_response', response: { subtype: 'success', request_id: m.request_id, response: {} } }); return; }
  if (m.type !== 'user') return;
  count++;
  fs.appendFileSync(log, JSON.stringify(m.message.content) + '\\n');
  emit({ type: 'system', subtype: 'init', session_id: session, model: 'claude-sonnet-4-6', tools: [], mcp_servers: [] });
  emit({ type: 'result', uuid: session + '-' + process.pid + '-' + count, subtype: 'success', result: fs.readFileSync(answer, 'utf8'), session_id: session, modelUsage: { 'claude-sonnet-4-6': {} } });
});`;
  let log: string;
  let answerFile: string;
  let proposal: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'diomedes-plain-writing-claude-'));
    log = path.join(root, 'log.jsonl');
    answerFile = path.join(root, 'answer.txt');
    proposal = '';
    const script = path.join(root, 'claude.mjs');
    await fs.writeFile(script, SCRIPT);
    await fs.mkdir(path.join(root, 'transport'), { recursive: true });
    const launch: ProcessFactory = (options) => {
      const resume = options.args.includes('--resume');
      const session = options.args[options.args.indexOf(resume ? '--resume' : '--session-id') + 1];
      return openProcess({ ...options, file: process.execPath, args: [script, session, log, answerFile], timeoutMs: 10_000 });
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
      generate: async (input: TextRequest) => ({
        text: proposal,
        model,
        version: TESTED_VERSIONS['claude-code'],
        threadId: input.threadId,
        projectId: input.projectId,
        requestId: input.requestId,
      }),
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
    await bakery(['claude-code']);
    const state = store().state(project.id);
    state.conversations.find((item) => item.id === thread.id)!.engine = 'claude-code';
    state.project.ai = { engine: 'sample', model: null };
    await store().persist(state);
  });

  test('the session message carries the standard; the answer is fixed in code and the owner’s phrase recorded', async () => {
    await api('/settings', 'PUT', { plainWritingPhrases: ['Touch Base'] });
    await fs.writeFile(answerFile, 'Certainly, the soup is 9.50 — the rye is 4. We can touch base on Friday.');
    await api(`/projects/${project.id}/threads/${thread.id}/messages`, 'POST', message('c1', 'How much is the soup?'));
    const sent = JSON.parse(JSON.parse((await fs.readFile(log, 'utf8')).trim().split('\n')[0]) as string) as { rules: string };
    expect(sent.rules).toContain(STANDARD);
    await until(answerTurn, (turn) => Boolean(turn), 'the answer');
    expect(answerTurn()!.text).toBe('The soup is 9.50. The rye is 4. We can touch base on Friday.');
    const output = await stepOutput('c1');
    expect(output.writing!.fixed.map((fix) => fix.rule)).toEqual(['em-dash', 'filler-opener']);
    // No rewrite on a native session: the phrase stays, and the record says so.
    expect(output.writing!.rewrite).toBeNull();
    expect(output.writing!.remaining).toEqual([{ rule: 'owner-phrase', match: 'touch base' }]);
  });

  test('a Work proposal: the summary and the Markdown it writes are fixed; a code file is not touched', async () => {
    const task = await api<{ id: string }>(`/projects/${project.id}/tasks`, 'POST', {
      name: 'Write the soup notice',
      description: 'Write a short notice about the soup price',
    });
    proposal = JSON.stringify({
      summary: 'Great question! A notice about the soup — and a helper script.',
      changes: [
        { path: 'Soup notice.md', text: '# Soup\n\nThe soup is 9.50 — the rye is 4.\n', summary: 'A notice.' },
        { path: 'price.js', text: 'const note = "soup — 9.50"; // leverage\n', summary: 'A script.' },
      ],
    });
    const started = await request(`/projects/${project.id}/work/start`, 'POST', {
      taskId: task.id,
      route: 'claude-code',
      consent: true,
      sources: [MENU.path],
    });
    expect(started.status, await started.clone().text()).toBe(200);
    const session = await until(
      () => store().state(project.id).sessions.at(-1),
      (item) => Boolean(item?.writing),
      'the proposal',
    );
    const parts = Object.fromEntries(session!.writing!.map((part) => [part.part, part.record]));
    expect(Object.keys(parts).sort()).toEqual(['Soup notice.md', 'summary']);
    expect(parts['Soup notice.md'].fixed).toEqual([
      { rule: 'em-dash', before: 'The soup is 9.50 — the rye is 4.', after: 'The soup is 9.50. The rye is 4.' },
    ]);
    expect(parts.summary.remaining).toEqual([]);
  });
});

test('the weekly brief, which has no model, passes the check', () => {
  const exported = 'item,count\nSoup,40 — sold out Friday';
  const markdown = renderBrief({
    organizationId: 'org',
    tenantId: 'tenant',
    configurationRevision: 1,
    variantId: 'weekly-brief',
    title: 'Weekly brief',
    // A claim is the export's own line, as composeBrief writes it.
    sections: [{ heading: 'Sales export', claims: [{ text: 'Soup,40 — sold out Friday', sources: ['S1'] }] }],
    sources: [{ id: 'S1', label: 'Sales export', path: 'Sales.csv', sha: hash(exported)! }],
    unused: ['S2'],
    missing: ['Stock.csv'],
    producedAt: '2026-09-25T09:00:00.000Z',
  } as unknown as Parameters<typeof renderBrief>[0]);
  // Every template line passes; the export's own words (its dash included) are the person's.
  expect(checkPlainWriting(markdown, { userTexts: [exported] })).toEqual([]);
  expect(markdown).toContain('- [S1] Sales export (Sales.csv, SHA-256: ');
  // Without the export as the person's words, the only hit is its own dash.
  expect(checkPlainWriting(markdown).map((hit) => hit.match)).toEqual(['—']);
});

test('the brief Sources line the capture showed is flagged in its old form and gone in the new', () => {
  // docs/verification/2026-09-25-capture-polish/after-4-6-weekly-brief.png, before this change.
  const label = 'Weekly operations exports: POS weekly summary';
  const path = 'Imports/pos-weekly-2026-W38.csv';
  const old = `- [S1] ${label} — ${path} (SHA-256: ${'a'.repeat(64)})`;
  expect(checkPlainWriting(old).map((hit) => hit.rule)).toEqual(['em-dash']);
  const markdown = renderBrief({
    organizationId: 'org',
    tenantId: 'tenant',
    configurationRevision: 1,
    variantId: 'weekly-brief',
    title: 'Weekly operations brief',
    sections: [{ heading: 'Sales', claims: [{ text: 'Covers rose 4%.', sources: ['S1'] }] }],
    sources: [{ id: 'S1', label, path, sha: 'a'.repeat(64) }],
    unused: [],
    missing: [],
    producedAt: '2026-09-25T09:00:00.000Z',
  } as unknown as Parameters<typeof renderBrief>[0]);
  expect(markdown).toContain(`- [S1] ${label} (${path}, SHA-256: `);
  expect(checkPlainWriting(markdown)).toEqual([]);
});

test('the status words automations show carry no em dash', () => {
  const words = [...Object.values(SCHEDULE_OUTCOME), ...Object.values(AUTOMATION_LABEL_TEXT)];
  expect(words.length).toBeGreaterThan(8);
  for (const text of words) expect(checkPlainWriting(text), text).toEqual([]);
});

test('a reader still finds every source, in the new Sources line and the old', () => {
  const sha = 'c'.repeat(64);
  const brief = (line: string) => `# Weekly brief\n\n- Revenue rose [imports-pos-1]\n\n## Sources\n\n${line}\n`;
  const expected = (path: string) => ({ id: 'imports-pos-1', path, sha });
  const read = (line: string) => {
    const found = briefSources(brief(line)).get('imports-pos-1');
    return found && { id: found.id, path: found.path, sha: found.sha };
  };
  expect(read(`- [imports-pos-1] Weekly operations exports: POS weekly summary (Imports/pos-weekly.txt, SHA-256: ${sha})`)).toEqual(
    expected('Imports/pos-weekly.txt'),
  );
  expect(read(`- [imports-pos-1] POS (old) summary (Imports/pos (old).txt, SHA-256: ${sha})`)).toEqual(
    expected('Imports/pos (old).txt'),
  );
  expect(read(`- [imports-pos-1] Weekly operations exports: POS weekly summary — Imports/pos-weekly.txt (SHA-256: ${sha})`)).toEqual(
    expected('Imports/pos-weekly.txt'),
  );
});
