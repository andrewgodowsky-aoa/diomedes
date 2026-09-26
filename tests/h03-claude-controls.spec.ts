import { test, expect, type Page } from '@playwright/test';
import express from 'express';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { Server } from 'node:http';
import { createApp } from '../server/app';
import { EngineService, TESTED_VERSIONS } from '../server/engines/service';
import type { PersistentTextAdapter } from '../server/engines/contract';
import { ClaudeAdapter } from '../server/engines/claude';
import type { ClaudeSessionCheckpoint } from '../server/engines/claude-session';
import { openProcess, type ProcessFactory } from '../server/engines/process';
import { routeContractFor } from '../server/harness/route-contract';
import { testOnlySecretBox } from '../server/connection-secrets';
import { shareAfter, shareFixtureProject } from './fixtures/cloud-sharing-grant';

// H03 in a real browser: the Diomedes page on a Claude Code conversation, with the real Store,
// Runtime, session driver and Claude session transport. Only the Claude Code binary is a script:
// a stream-json child whose turn is decided by the person's words (`[slow]`, `[hang]`,
// `[stuck]`). This proves the page and the protocol Diomedes speaks, not live Claude Code.
// It serves the built bundle, like diomedes-home.spec.ts.
test.describe.configure({ mode: 'serial' });

const port = Number(process.env.DIOMEDES_H03_UI_PORT ?? 47645);
const baseURL = `http://127.0.0.1:${port}`;
const headers = { 'Content-Type': 'application/json', 'X-Diomedes-Client': '1' };
const model = 'sonnet';
const accountRoute = 'claude-code:claude.ai';

const SCRIPT = `import readline from 'node:readline';
import fs from 'node:fs';
const [,, session, known, resumed, log] = process.argv;
const emit = (x) => console.log(JSON.stringify(x));
const sessions = fs.existsSync(known) ? fs.readFileSync(known, 'utf8').split('\\n') : [];
if (resumed === 'resume' && !sessions.includes(session)) process.exit(1);
if (!sessions.includes(session)) fs.appendFileSync(known, session + '\\n');
let count = 0, open = null;
const result = (text) => emit({ type: 'result', uuid: session + '-' + process.pid + '-' + count, subtype: 'success', result: text, session_id: session, modelUsage: { 'claude-sonnet-4-6': {} } });
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const m = JSON.parse(line);
  if (m.type === 'control_request') {
    emit({ type: 'control_response', response: { subtype: 'success', request_id: m.request_id, response: {} } });
    if (m.request.subtype === 'interrupt' && open === 'hang') { open = null; setTimeout(() => emit({ type: 'result', uuid: session + '-' + process.pid + '-stop-' + count, subtype: 'error_during_execution', is_error: true, session_id: session, errors: ['Request was aborted'] }), 20); }
    return;
  }
  if (m.type !== 'user') return;
  count++;
  const words = JSON.parse(m.message.content).request.split('\\n\\n[[diomedes')[0];
  fs.appendFileSync(log, words + '\\n');
  emit({ type: 'system', subtype: 'init', session_id: session, model: 'claude-sonnet-4-6', tools: [], mcp_servers: [] });
  if (words.includes('[hang]')) { open = 'hang'; return; }
  if (words.includes('[stuck]')) { open = 'stuck'; return; }
  if (words.includes('[slow]')) return setTimeout(() => result('Answer to ' + words), 8000);
  result('Answer to ' + words);
});`;

let root: string;
let application: Awaited<ReturnType<typeof createApp>> | undefined;
let server: Server | undefined;
let pageErrors: string[] = [];
let launches: string[][] = [];

async function api<T>(route: string, method = 'GET', data?: unknown): Promise<T> {
  const response = await fetch(`${baseURL}/api${route}`, {
    method,
    headers,
    body: data === undefined ? undefined : JSON.stringify(data),
  });
  if (!response.ok)
    throw new Error(`H03 fixture request ${route} failed (${response.status}): ${await response.text()}`);
  const value = (await response.json()) as T;
  await shareAfter(api, route, method, value);
  return value;
}

async function start() {
  const script = path.join(root, 'claude.mjs');
  const known = path.join(root, 'known.txt');
  const launch: ProcessFactory = (options) => {
    launches.push(options.args);
    const resume = options.args.includes('--resume');
    const session = options.args[options.args.indexOf(resume ? '--resume' : '--session-id') + 1];
    return openProcess({
      ...options,
      file: process.execPath,
      args: [script, session, known, resume ? 'resume' : 'new', path.join(root, 'turns.txt')],
      timeoutMs: 30_000,
    });
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
    generate: async () => {
      throw new Error('Conversation requests must use the native transport');
    },
    openSession: (input, options) => transport.openSession(input, options),
  };
  const engines = new EngineService(path.join(root, 'engines'), {
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
  });
  application = await createApp({
    dataDir: path.join(root, 'data'),
    projectRoot: path.join(root, 'projects'),
    port,
    clientPort: port,
    engineService: engines,
    reviewerAdapter: null,
    secretBox: testOnlySecretBox(),
  });
  const dist = path.resolve('dist');
  application.use(express.static(dist));
  application.get('/{*path}', (_request, response) => response.sendFile(path.join(dist, 'index.html')));
  server = application.listen(port, '127.0.0.1');
  await new Promise<void>((resolve, reject) => {
    server!.once('listening', resolve);
    server!.once('error', reject);
  });
}
async function stop() {
  await application?.locals.close?.();
  server?.closeAllConnections();
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = undefined;
  application = undefined;
}

/** Whether the scripted Claude Code has received these words as a turn. */
const received = async (words: string) =>
  (await fs.readFile(path.join(root, 'turns.txt'), 'utf8').catch(() => '')).split('\n').includes(words);
const composer = (page: Page) => page.getByRole('textbox', { name: 'Message Nectovia' });
const answers = (page: Page) => page.locator('.turn.dio .body');
const session = (page: Page) => page.locator('.dio-session');
async function open(page: Page) {
  await page.goto(baseURL);
  await expect(page.getByRole('heading', { name: 'Nectovia', exact: true })).toBeVisible();
}
async function say(page: Page, text: string) {
  await expect(page.locator('.dio-pending')).toHaveCount(0);
  await composer(page).fill(text);
  await composer(page).press('Enter');
}

test.beforeAll(async () => {
  const results = path.resolve('test-results');
  await fs.mkdir(results, { recursive: true });
  root = await fs.mkdtemp(path.join(results, 'h03-claude-controls-'));
  await fs.mkdir(path.join(root, 'transport'), { recursive: true });
  await fs.writeFile(path.join(root, 'claude.mjs'), SCRIPT);
  const built = (await fs.stat(path.resolve('dist', 'index.html'))).mtimeMs;
  const newest = Math.max(
    ...(await Promise.all(
      ['client/console/NativeSessionControls.tsx', 'client/console/native-session-view.ts', 'shared/session-controls.ts'].map(
        async (file) => (await fs.stat(path.resolve(file))).mtimeMs,
      ),
    )),
  );
  expect(built, 'dist is older than the H03 controls. Run "npx vite build" first.').toBeGreaterThan(newest);
  await start();
  await api('/ai/discover', 'POST', { consent: true });
  await api('/ai/check/claude-code', 'POST', {});
  await api('/ai/select', 'POST', { engine: 'claude-code', model });
  // The owner's testing pin sends a styled conversation to Claude Code. The pin applies wherever
  // a style applies, so a default style is saved with it. Services are saved whole, so both are
  // added to what Claude Code's selection already saved.
  const saved = await api<{ services?: Record<string, unknown> }>('/settings');
  await api('/settings', 'PUT', {
    services: { ...saved.services, workStyle: 'focused', ownerPinRoute: 'claude-code', ownerPinModel: model },
    onboarding: {
      work: 'business',
      detail: 'guided',
      familiarity: 'new',
      resumeAt: 'done',
      completedAt: new Date().toISOString(),
    },
  });
  // The home conversation, shared with Claude Code as a person would in Cloud sharing, so a
  // follow-up may reach the session that holds the earlier messages.
  const home = await api<{ projectId: string; threadId: string }>('/home/conversation', 'POST', {});
  await shareFixtureProject(api, home.projectId);
  // A new conversation is provisioned on Nectovia, which this app (no account service) cannot
  // send on. This spec is about Claude Code's session controls, so the person routes Home to
  // Claude Code explicitly: a choice the provisioner keeps, here and after the restart below.
  const routed = await api<{ engine: string; engineChoice?: string }>(
    `/projects/${home.projectId}/threads/${home.threadId}`,
    'PUT',
    { engine: 'claude-code' },
  );
  expect(routed).toMatchObject({ engine: 'claude-code', engineChoice: 'person' });
});

test.afterAll(async () => {
  await stop();
});

test.beforeEach(async ({ page }) => {
  pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
});
test.afterEach(() => {
  expect(pageErrors, 'The interface must not throw uncaught browser errors').toEqual([]);
});

test('no session controls before a conversation exists; then the live session and its reported model', async ({ page }) => {
  await open(page);
  await expect(composer(page)).toBeVisible();
  await expect(session(page)).toHaveCount(0);
  await say(page, 'Good morning');
  await expect(answers(page).last()).toHaveText('Answer to Good morning');
  await expect(session(page).locator('.dio-session-state')).toHaveText('Live session');
  await expect(session(page).locator('.dio-session-by')).toHaveText('Claude Code · claude-sonnet-4-6');
  // Nothing is running, so there is nothing to queue behind.
  await expect(page.getByRole('textbox', { name: 'Queue a message' })).toHaveCount(0);
});

test('a message queued while Claude Code answers is sent next, and both answers land in order', async ({ page }) => {
  await open(page);
  await say(page, 'Plan the week [slow]');
  const queue = page.getByRole('textbox', { name: 'Queue a message' });
  await expect(queue).toBeVisible();
  await queue.fill('Also check the linen order');
  await page.getByRole('button', { name: 'Queue', exact: true }).click();
  const queued = page.getByRole('list', { name: 'Queued messages' });
  await expect(queued).toContainText('Also check the linen order');
  await expect(queued).toContainText('Queued: sent when the current answer finishes');
  await expect(answers(page).filter({ hasText: 'Answer to Plan the week [slow]' })).toHaveCount(1);
  await expect(answers(page).last()).toHaveText('Answer to Also check the linen order');
  await expect(queued).toHaveCount(0);
  // One Claude Code process served all of it.
  expect(launches).toHaveLength(1);
});

test('a waiting message can be withdrawn, and Stop ends the answer gracefully with the session still live', async ({ page }) => {
  await open(page);
  await say(page, 'Think hard [hang]');
  await expect.poll(() => received('Think hard [hang]')).toBe(true);
  const queue = page.getByRole('textbox', { name: 'Queue a message' });
  await expect(queue).toBeVisible();
  await queue.fill('Never mind this one');
  await page.getByRole('button', { name: 'Queue', exact: true }).click();
  const queued = page.getByRole('list', { name: 'Queued messages' });
  await expect(queued).toContainText('Never mind this one');
  await queued.getByRole('button', { name: 'Withdraw' }).click();
  await expect(queued).toContainText('Withdrawn by Stop before it was sent.');
  await queued.getByRole('button', { name: 'Dismiss' }).click();
  await expect(queued).toHaveCount(0);
  await page.getByRole('button', { name: 'Stop', exact: true }).click();
  await expect(page.locator('.dio-pending')).toHaveCount(0);
  await expect(session(page).locator('.dio-session-state')).toHaveText('Live session');
  // The page's Stop leaves its own message unconfirmed; Send again reads the recorded,
  // interrupted turn and asks Claude Code nothing.
  const unconfirmed = page.getByRole('group', { name: 'A message that was not confirmed' });
  await expect(unconfirmed).toContainText('Think hard [hang]');
  await unconfirmed.getByRole('button', { name: 'Send again' }).click();
  await expect(unconfirmed).toHaveCount(0);
  await say(page, 'Carry on');
  await expect(answers(page).last()).toHaveText('Answer to Carry on');
  expect(launches).toHaveLength(1);
});

test('after Diomedes restarts, the conversation says it resumes, and the next message resumes it', async ({ page }) => {
  await stop();
  await start();
  await open(page);
  await expect(session(page).locator('.dio-session-state')).toHaveText('Resumes on your next message');
  await say(page, 'Where were we?');
  await expect(answers(page).last()).toHaveText('Answer to Where were we?');
  expect(launches.at(-1)).toContain('--resume');
  await expect(session(page).locator('.dio-session-state')).toHaveText('Live session');
});

test("a Stop Claude Code does not honour ends its process, and the page says it couldn't resume", async ({ page }) => {
  test.setTimeout(90_000);
  await open(page);
  await say(page, 'Stuck [stuck]');
  await expect(page.getByRole('textbox', { name: 'Queue a message' })).toBeVisible();
  // Stop names a command the record holds, so it is pressed once the turn reached Claude Code.
  await expect.poll(() => received('Stuck [stuck]')).toBe(true);
  await page.getByRole('button', { name: 'Stop', exact: true }).click();
  await expect(session(page).locator('.dio-session-state')).toHaveText("Couldn't resume", { timeout: 20_000 });
  await expect(session(page).locator('.dio-session-detail')).toHaveText(
    /^Claude Code did not stop when asked, so its process was ended\./,
  );
  // Review F (decision 4): the forced stop is said once, by the session line read from the record.
  await expect(page.getByText(/process was ended/)).toHaveCount(1);
  await expect(page.getByText("Couldn't resume")).toHaveCount(1);
});
