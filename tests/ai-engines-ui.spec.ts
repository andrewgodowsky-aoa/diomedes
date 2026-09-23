import { test, expect, type Locator, type Page } from '@playwright/test';
import express from 'express';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { Server } from 'node:http';
import { createApp } from '../server/app';
import { EngineService } from '../server/engines/service';
import type { TextEngineAdapter, TextRequest, TextResponse } from '../server/engines/contract';
import { routeContractFor } from '../server/harness/route-contract';
import type {
  EngineModel,
  ExternalEngine,
  IntegrationStatus,
  Conversation,
  Project,
  ProjectState,
  Task,
} from '../shared/types';
import { reopenLastProject } from './fixtures/landing';

// This is a browser contract fixture. The adapters below never start a native
// engine, read credentials, or contact a provider; they only exercise the
// server's injected EngineService through the real Console UI.
test.describe.configure({ mode: 'serial' });

const port = Number(process.env.DIOMEDES_AI_ENGINES_UI_PORT ?? 47636);
const baseURL = `http://127.0.0.1:${port}`;
const headers = { 'Content-Type': 'application/json', 'X-Diomedes-Client': '1' };
const versions: Record<ExternalEngine, string> = {
  'claude-code': '2.1.252',
  opencode: '1.18.4',
  'oh-my-pi': '18.0.6',
  cursor: '2026.08.11',
  devin: '3000.10.23',
};
const names: Record<ExternalEngine, string> = {
  'claude-code': 'Claude Code',
  opencode: 'OpenCode',
  'oh-my-pi': 'oh-my-pi',
  cursor: 'Cursor',
  devin: 'Devin',
};
const modelOf = (engine: ExternalEngine): EngineModel => ({
  slug: `${engine}/fixture-model`,
  name: `${names[engine]} fixture model`,
  description: 'A deterministic browser fixture model.',
  defaultEffort: null,
  efforts: [],
});

interface FixtureCall {
  engine: ExternalEngine;
  input: TextRequest;
}

let application: Awaited<ReturnType<typeof createApp>> | undefined;
let server: Server | undefined;
let fixtureRoot: string | undefined;
let project: Project;
const calls: FixtureCall[] = [];
const cancelled = new Set<string>();
let releaseStream: (() => void) | undefined;

async function api<T>(route: string, method = 'GET', data?: unknown): Promise<T> {
  const response = await fetch(`${baseURL}/api${route}`, {
    method,
    headers,
    body: data === undefined ? undefined : JSON.stringify(data),
  });
  if (!response.ok) {
    throw new Error(
      `AI engine UI fixture request ${route} failed (${response.status}): ${await response.text()}`,
    );
  }
  return response.json() as Promise<T>;
}

function fixtureAdapter(engine: ExternalEngine): TextEngineAdapter {
  return {
    id: engine,
    contract: routeContractFor(engine),
    inspect: async () => ({
      authentication: 'signed-in',
      accountRoute: `${engine}:fixture-account`,
      models: [modelOf(engine)],
      detail: 'Fixture account and model catalogue.',
    }),
    generate: async (input: TextRequest): Promise<TextResponse> => {
      calls.push({ engine, input });
      if (input.prompt === 'CANCEL fixture request') {
        return await new Promise<TextResponse>((_resolve, reject) => {
          const abort = () => {
            cancelled.add(input.requestId);
            reject(new Error('fixture request cancelled'));
          };
          if (input.signal?.aborted) abort();
          else input.signal?.addEventListener('abort', abort, { once: true });
        });
      }
      const proposal = input.prompt.includes('PROPOSE exact note');
      const text = proposal
        ? JSON.stringify({
            summary: 'Create the approved fixture note.',
            changes: [
              {
                path: `Approved ${engine}.md`,
                text: `Approved ${engine} fixture content.\n`,
                summary: 'Create the approved fixture note.',
              },
            ],
          })
        : `Scoped answer from ${engine}.`;
      input.onDelta?.(proposal ? 'Preparing the exact fixture proposal.' : `Scoped answer from `);
      if (!proposal) input.onDelta?.(`${engine}.`);
      if (!proposal && input.prompt.startsWith('ASK ')) {
        await new Promise<void>((resolve) => {
          releaseStream = resolve;
        });
        releaseStream = undefined;
      }
      return {
        text,
        model: input.model,
        version: versions[engine],
        threadId: input.threadId,
        projectId: input.projectId,
        requestId: input.requestId,
      };
    },
  };
}

async function expectFreshBundle(dist: string): Promise<void> {
  const built = (await fs.stat(path.join(dist, 'index.html'))).mtimeMs;
  let newest = 0;
  let newestPath = '';
  for (const dir of ['client', 'shared']) {
    for (const entry of await fs.readdir(path.resolve(dir), { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      const file = path.resolve(dir, entry.name);
      const { mtimeMs } = await fs.stat(file);
      if (mtimeMs > newest) {
        newest = mtimeMs;
        newestPath = path.relative(process.cwd(), file);
      }
    }
  }
  expect(built, `dist is older than ${newestPath}; run "npm run build" first.`).toBeGreaterThan(
    newest,
  );
}

test.beforeAll(async () => {
  const results = path.resolve('test-results');
  await fs.mkdir(results, { recursive: true });
  const root = await fs.mkdtemp(path.join(results, 'ai-engines-ui-'));
  fixtureRoot = root;
  const statuses: IntegrationStatus[] = (Object.keys(versions) as ExternalEngine[]).map(
    (engine) => ({
      id: engine,
      name: names[engine],
      kind: 'online',
      found: true,
      available: false,
      enabled: false,
      status: 'Installed',
      detail: 'Fixture installation.',
      capabilities: [],
      signIn: 'first-use',
      adapter: 'ready',
      installedVersion: versions[engine],
      location: path.join(root, `${engine}.fixture`),
      disclosure: [],
    }),
  );
  const service = new EngineService(path.join(root, 'engines'), {
    discover: async () => statuses,
    version: async (file) => {
      const engine = (Object.keys(versions) as ExternalEngine[]).find((id) =>
        file.endsWith(`${id}.fixture`),
      );
      if (!engine) throw new Error('Unknown fixture engine path.');
      return versions[engine];
    },
    adapter: (engine) => fixtureAdapter(engine),
  });
  application = await createApp({
    dataDir: path.join(root, 'data'),
    projectRoot: path.join(root, 'projects'),
    port,
    clientPort: port,
    engineService: service,
  });
  const dist = path.resolve('dist');
  await fs.access(path.join(dist, 'index.html'));
  await expectFreshBundle(dist);
  application.use(express.static(dist));
  application.get('/{*path}', (_request, response) =>
    response.sendFile(path.join(dist, 'index.html')),
  );
  server = application.listen(port, '127.0.0.1');
  await new Promise<void>((resolve, reject) => {
    server!.once('listening', resolve);
    server!.once('error', reject);
  });

  project = await api<Project>('/projects', 'POST', { name: 'AI engine UI fixture' });
  await api(`/projects/${project.id}/documents/create`, 'POST', {
    path: 'Scoped notes.md',
    text: 'Only this selected note belongs in scope.\n',
  });
  await api(`/projects/${project.id}/threads`, 'POST', {
    name: 'Engine UI thread',
    attachedTo: { kind: 'document', ref: 'Scoped notes.md' },
  });
  await api('/settings', 'PUT', {
    surface: 'console',
    detail: 'technical',
    openProjects: [project.id],
    services: { 'claude-code': false, opencode: false, 'oh-my-pi': false, cursor: false },
    onboarding: {
      work: 'software',
      detail: 'technical',
      familiarity: 'comfortable',
      resumeAt: 'done',
      completedAt: new Date().toISOString(),
    },
  });
});

test.afterAll(async () => {
  if (application) await application.locals.close();
  if (server) {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server!.close((error) => (error ? reject(error) : resolve())),
    );
  }
  if (fixtureRoot) await fs.rm(fixtureRoot, { recursive: true, force: true });
});

test('Console discovers, selects, streams, cancels, and approves every fixture engine', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(baseURL);
  await reopenLastProject(page);
  await expect(page.locator('.console')).toBeVisible();

  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('button', { name: 'Engines', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Engines', exact: true, level: 1 })).toBeVisible();
  await page.getByRole('button', { name: 'Check this computer', exact: true }).click();
  for (const engine of Object.keys(versions) as ExternalEngine[]) {
    const section = page.locator(`section.service[aria-label="${names[engine]}"]`);
    await expect(section).toBeVisible();
    await section.getByRole('button', { name: 'Check sign-in and models', exact: true }).click();
    await expect(
      section.getByRole('combobox', { name: `${names[engine]} model`, exact: true }),
    ).toHaveValue(`${engine}/fixture-model`);
    await section.locator('input[type="checkbox"]').click();
    await expect(section.locator('input[type="checkbox"]')).toBeChecked();
    await section.getByRole('button', { name: 'Use as default', exact: true }).click();
    // The click only starts the save; the row shows Default once the server has stored it.
    await expect(section.getByText('Default', { exact: true })).toBeVisible();
  }
  const selected = await api<{ services: Record<string, boolean | string> }>('/settings');
  // The last row whose `Use as default` was clicked is the default; every row kept its model.
  const engines = Object.keys(versions) as ExternalEngine[];
  expect(selected.services.defaultEngine).toBe(engines.at(-1));
  for (const engine of engines)
    expect(selected.services[`${engine}Model`]).toBe(`${engine}/fixture-model`);

  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(page.locator('.console')).toBeVisible();
  const picker = page.locator('.model-picker > button');
  const documentScope = [
    { path: 'Scoped notes.md', text: 'Only this selected note belongs in scope.\n' },
  ];

  for (const engine of Object.keys(versions) as ExternalEngine[]) {
    await picker.click();
    const menu = page.getByRole('menu');
    await expect(
      menu.getByRole('menuitemradio').filter({ hasText: `${engine}/fixture-model` }),
    ).toBeVisible();
    await menu
      .getByRole('menuitemradio')
      .filter({ hasText: `${engine}/fixture-model` })
      .click();
    await expect(picker).toContainText(`${engine}/fixture-model`);
    await page
      .getByRole('textbox', { name: 'Message this thread', exact: true })
      .fill(`ASK ${engine}`);
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    const confirmation = page.getByRole('dialog', { name: 'Send this message?' });
    await expect(confirmation).toContainText(names[engine]);
    await expect(confirmation).toContainText('Scoped notes.md');
    expect(calls.some((item) => item.input.prompt === `ASK ${engine}`)).toBe(false);
    await confirmation.getByRole('button', { name: 'Send message', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Stop', exact: true })).toBeVisible();
    await expect(
      page.locator('.exchange .turn.dio').filter({ hasText: `Scoped answer from ${engine}.` }),
    ).toBeVisible();
    releaseStream?.();
    await expect(page.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0);
    const call = calls.find((item) => item.input.prompt === `ASK ${engine}`);
    expect(call?.engine).toBe(engine);
    expect(call?.input.documents).toEqual(documentScope);
    expect(call?.input.model).toBe(`${engine}/fixture-model`);
    expect(call?.input.accountRoute).toBe(`${engine}:fixture-account`);
  }

  await picker.click();
  await page
    .getByRole('menu')
    .getByRole('menuitemradio')
    .filter({ hasText: 'claude-code/fixture-model' })
    .click();
  await expect(picker).toContainText('claude-code/fixture-model');
  await page
    .getByRole('textbox', { name: 'Message this thread', exact: true })
    .fill('CANCEL fixture request');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await page.getByRole('dialog', { name: 'Send this message?' })
    .getByRole('button', { name: 'Send message', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Stop', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Stop', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Request stopped');
  await page.getByRole('alert').getByRole('button', { name: 'Dismiss' }).click();
  await expect.poll(() => cancelled.size).toBe(1);
  expect(
    (await api<ProjectState>(`/projects/${project.id}/state`)).conversations[0].turns.some(
      (turn) => turn.role !== 'you' && turn.text.includes('CANCEL'),
    ),
  ).toBe(false);

  for (const engine of Object.keys(versions) as ExternalEngine[]) {
    await picker.click();
    await page
      .getByRole('menu')
      .getByRole('menuitemradio')
      .filter({ hasText: `${engine}/fixture-model` })
      .click();
    await expect(picker).toContainText(`${engine}/fixture-model`);
    await page
      .getByRole('radio', { name: engine === 'oh-my-pi' ? 'fix' : 'build', exact: true })
      .click();
    if (engine === 'oh-my-pi')
      await page
        .getByRole('textbox', { name: 'Paste what went wrong' })
        .fill('A synthetic typo needs a corrected note.');
    await page
      .getByRole('textbox', { name: 'Message this thread', exact: true })
      .fill('PROPOSE exact note');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await page.getByRole('dialog', { name: 'Send this message?' })
      .getByRole('button', { name: 'Send message', exact: true }).click();
    const need = page.getByRole('region', { name: 'Needs your OK' });
    await expect(need).toBeVisible();
    await need.getByRole('button', { name: 'Show me first', exact: true }).click();
    // Attribution now leads with the worker identity, then the model that ran
    // it and the engine it went through: who proposed this, and on what.
    const proposal = page.getByRole('dialog', {
      name: new RegExp(`^[A-Z][A-Za-z ]+ · ${engine}/fixture-model .*proposes to`),
    });
    await expect(proposal).toContainText(`Approved ${engine} fixture content.`);
    await expect(
      fs.access(path.join(project.folder, `Approved ${engine}.md`)),
    ).rejects.toMatchObject({ code: 'ENOENT' });
    if (engine === 'claude-code')
      await page.screenshot({
        path: 'evidence/ai-setup/console-exact-proposal.png',
        animations: 'disabled',
      });
    await proposal.getByRole('button', { name: 'Go ahead', exact: true }).click();
    await expect(proposal).not.toBeVisible();
    await expect
      .poll(
        async () =>
          (await api<ProjectState>(`/projects/${project.id}/state`)).needs.at(-1)?.execution?.state,
      )
      .toBe('applied');
    const state = await api<ProjectState>(`/projects/${project.id}/state`);
    const changed = state.history.find(
      (entry) =>
        entry.kind === 'changed' &&
        entry.files.some((file) => file.path === `Approved ${engine}.md`),
    );
    expect(await fs.readFile(path.join(project.folder, `Approved ${engine}.md`), 'utf8')).toBe(
      `Approved ${engine} fixture content.\n`,
    );
    expect(changed?.files[0].after).toMatch(/^[a-f0-9]{64}$/);
    const proposalCall = calls.find(
      (item) => item.engine === engine && item.input.prompt.includes('PROPOSE exact note'),
    );
    expect(proposalCall?.engine).toBe(engine);
    expect(proposalCall?.input.accountRoute).toBe(`${engine}:fixture-account`);
    expect(proposalCall?.input.documents).toEqual(documentScope);
  }

  // History is the Console's own screen now. This button used to switch the
  // whole surface to the Workbook to show it, which is why the rows it looks
  // for are `.hrow` rather than the Workbook's `.history-entry`. The sentence
  // is written by the server and has not changed.
  await page.getByRole('button', { name: 'History', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'History', exact: true, level: 1 })).toBeVisible();
  for (const engine of Object.keys(versions))
    await expect(page.locator('.hrow').filter({ hasText: `${engine}/fixture-model changed 1 file` })).toHaveCount(1);
  expect(errors).toEqual([]);
});

test('Console Ask revision confirms the named task documents, preserves Cancel, and never writes', async ({ page }, testInfo) => {
  await api('/ai/discover', 'POST', { consent: true });
  await api('/ai/check/opencode', 'POST', {});
  await api('/ai/select', 'POST', { engine: 'opencode', model: 'opencode/fixture-model' });
  const fixture = await api<Project>('/projects', 'POST', { name: 'Composer revision fixture' });
  const documents = [
    { path: 'weekly-operations-brief.md', text: 'Three changes. [inventory:1]\n' },
    { path: 'bakery-inventory.md', text: 'Flour is low. [inventory:1]\n' },
    { path: 'unrelated.md', text: 'This must never travel with the revision.\n' },
  ];
  for (const document of documents)
    await api(`/projects/${fixture.id}/documents/create`, 'POST', document);
  const task = await api<Task>(`/projects/${fixture.id}/tasks`, 'POST', {
    name: 'Review the weekly brief',
    description: 'Read weekly-operations-brief.md and bakery-inventory.md.',
  });
  const thread = await api<Conversation>(`/projects/${fixture.id}/threads`, 'POST', {
    name: 'Revise the brief', taskId: task.id, mode: 'ask', permission: 'task',
  });
  await api('/settings', 'PUT', { surface: 'console', openProjects: [fixture.id] });
  const before = await api<ProjectState>(`/projects/${fixture.id}/state`);
  const count = calls.length;
  const instruction = 'Shorten the brief to the three things that changed most, and keep the source markers.';
  const request = { threadId: thread.id, mode: 'ask', route: 'opencode', text: instruction, sources: documents.slice(0, 2).map((d) => d.path) };
  const denied = await page.request.post(`${baseURL}/api/projects/${fixture.id}/ask`, { headers, data: request });
  expect(denied.status()).toBe(409);
  expect((await denied.json()).consentRequired).toBe(true);
  expect(calls).toHaveLength(count);

  await page.goto(baseURL);
  await reopenLastProject(page);
  const composer = page.getByRole('textbox', { name: 'Message this thread', exact: true });
  await composer.fill(instruction);
  await composer.press('Enter');
  const confirmation = page.getByRole('dialog', { name: 'Send this message?' });
  await expect(confirmation).toContainText('OpenCode');
  await expect(confirmation).toContainText('weekly-operations-brief.md');
  await expect(confirmation).toContainText('bakery-inventory.md');
  await expect(confirmation).not.toContainText('unrelated.md');
  await expect(confirmation).toContainText('Nothing in the project changes');
  expect(calls).toHaveLength(count);
  expect((await api<ProjectState>(`/projects/${fixture.id}/state`)).conversations[0].turns).toHaveLength(0);
  await confirmation.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(composer).toHaveValue(instruction);
  expect(calls).toHaveLength(count);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(confirmation).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('composer-revision-confirmation.png'), animations: 'disabled' });
  await confirmation.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect.poll(() => calls.length).toBe(count + 1);
  expect(calls.at(-1)?.input.documents).toEqual(documents.slice(0, 2));
  expect(calls.at(-1)?.input.prompt).toBe(instruction);
  expect(calls.at(-1)?.input.accountRoute).toBe('opencode:fixture-account');
  await expect(page.locator('.exchange .turn.dio')).toContainText('Scoped answer from opencode.');
  await expect(composer).toHaveValue('');
  const after = await api<ProjectState>(`/projects/${fixture.id}/state`);
  expect(after.conversations[0].turns[0].sources).toEqual(['weekly-operations-brief.md', 'bakery-inventory.md']);
  expect(after.conversations[0].permission).toBe('task');
  expect(after.needs).toEqual(before.needs);
  expect(after.sessions).toEqual(before.sessions);
  expect(after.changes).toEqual(before.changes);
  for (const document of documents)
    expect(await fs.readFile(path.join(fixture.folder, document.path), 'utf8')).toBe(document.text);
});

test('Console standalone Ask includes only documents named in the message and refuses a failed listing', async ({ page }) => {
  await api('/ai/discover', 'POST', { consent: true });
  await api('/ai/check/opencode', 'POST', {});
  await api('/ai/select', 'POST', { engine: 'opencode', model: 'opencode/fixture-model' });
  const fixture = await api<Project>('/projects', 'POST', { name: 'Standalone revision fixture' });
  for (const name of ['brief.md', 'weekly-brief.md'])
    await api(`/projects/${fixture.id}/documents/create`, 'POST', { path: name, text: name });
  await api(`/projects/${fixture.id}/threads`, 'POST', { name: 'Standalone Ask', mode: 'ask' });
  await api('/settings', 'PUT', { surface: 'console', openProjects: [fixture.id] });
  await page.goto(baseURL);
  await reopenLastProject(page);
  const composer = page.getByRole('textbox', { name: 'Message this thread', exact: true });
  const count = calls.length;
  await page.route(`**/api/projects/${fixture.id}/documents`, (route) => route.fulfill({ status: 503, json: { error: 'Listing unavailable' } }));
  await composer.fill('Shorten weekly-brief.md.');
  await composer.press('Enter');
  await expect(page.getByRole('alert')).toContainText('Listing unavailable');
  await expect(composer).toHaveValue('Shorten weekly-brief.md.');
  expect(calls).toHaveLength(count);
  await page.unrouteAll({ behavior: 'wait' });
  await composer.press('Enter');
  const confirmation = page.getByRole('dialog', { name: 'Send this message?' });
  await expect(confirmation).toContainText('weekly-brief.md');
  await confirmation.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect.poll(() => calls.length).toBe(count + 1);
  expect(calls.at(-1)?.input.documents).toEqual([{ path: 'weekly-brief.md', text: 'weekly-brief.md' }]);
  await expect(composer).toHaveValue('');
  await expect(page.locator('.exchange .turn.dio')).toBeVisible();
  await composer.fill('Explain how to write a brief.');
  await composer.press('Enter');
  await expect(confirmation).toContainText('No project documents are included');
  await confirmation.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect.poll(() => calls.length).toBe(count + 2);
  expect(calls.at(-1)?.input.documents).toEqual([]);
});

test('Console keeps the Codex sending preference and sample route separate from external confirmation', async ({ page }) => {
  const fixture = await api<Project>('/projects', 'POST', { name: 'Sending preference fixture' });
  const thread = await api<Conversation>(`/projects/${fixture.id}/threads`, 'POST', { mode: 'ask' });
  const sent: { route: string; mode: string; consent: boolean }[] = [];
  // Observe the client request boundary without starting a real Codex process.
  // The backend consent contract is exercised in backend.test.ts.
  await page.route(`**/api/projects/${fixture.id}/ask`, (route) => {
    sent.push(route.request().postDataJSON());
    return route.fulfill({ json: {} });
  });
  for (const scenario of [
    { route: 'codex', mode: 'ask', sending: false, confirm: false },
    { route: 'codex', mode: 'ask', sending: true, confirm: true },
    { route: 'codex', mode: 'build', sending: false, confirm: true },
    { route: 'sample', mode: 'ask', sending: true, confirm: false },
  ]) {
    await api(`/projects/${fixture.id}/threads/${thread.id}`, 'PUT', { engine: scenario.route, mode: scenario.mode });
    await api('/settings', 'PUT', {
      surface: 'console', openProjects: [fixture.id], services: { codex: true }, permissions: { sending: scenario.sending },
    });
    await page.goto(baseURL);
    await reopenLastProject(page);
    const count = sent.length;
    const composer = page.getByRole('textbox', { name: 'Message this thread', exact: true });
    await composer.fill('Check this send preference.');
    await composer.press('Enter');
    const confirmation = page.getByRole('dialog', { name: 'Send this message?' });
    if (scenario.confirm) {
      await expect(confirmation).toContainText('ChatGPT');
      expect(sent).toHaveLength(count);
      await confirmation.getByRole('button', { name: 'Send message', exact: true }).click();
    }
    await expect.poll(() => sent.length).toBe(count + 1);
    await expect(confirmation).toHaveCount(0);
    expect(sent.at(-1)).toMatchObject({ route: scenario.route, mode: scenario.mode, consent: true });
  }
  await page.unrouteAll({ behavior: 'wait' });
});

/**
 * First-run setup, one route at a time.
 *
 * These cases pin what the screen does with the host's own record: the one next
 * action it renders, the four states it shows, how it explains a broken
 * binding, a different account route and a failed stage, and that one real
 * request is only ever sent by an explicit second click. The connection payload
 * is served from `page.route` so a host state the fixture service cannot reach
 * — a wrong-version installation, a corrupt one, two candidates — is still
 * rendered by the real Console.
 */
const setupSection = (page: Page) => page.locator('section.service[aria-label="OpenCode"]');
/** One of the four states, by the key it is derived from. */
const stateChip = (page: Page, key: string) =>
  setupSection(page).locator(`li.ai-state[data-state="${key}"]`);

function wire(patch: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    engine: 'opencode',
    installation: 'found',
    compatibility: 'supported',
    authentication: 'signed-in',
    accountRoute: 'opencode:opencode-go',
    models: [modelOf('opencode')],
    checkedAt: new Date().toISOString(),
    detail: 'Native OpenCode Go account connected.',
    usage: { state: 'unknown', checkedAt: null },
    version: versions.opencode,
    location: 'C:\\Tools\\opencode.exe',
    revision: 1,
    nextAction: 'test-connection',
    ...patch,
  };
}

const systemCandidate = {
  id: 'system:opencode:C:\\Tools\\opencode.exe',
  engine: 'opencode',
  source: 'system',
  present: true,
  path: 'C:\\Tools\\opencode.exe',
  version: '1.19.0',
  sha256: 'b'.repeat(64),
  integrity: 'verified',
  protocol: 'passed',
  provenance: 'unverified',
  context: 'windows-native',
  compatibility: 'unsupported',
};
const managedCandidate = {
  id: 'managed:opencode:C:\\Diomedes\\engines\\opencode\\opencode.exe',
  engine: 'opencode',
  source: 'managed',
  present: true,
  path: 'C:\\Diomedes\\engines\\opencode\\opencode.exe',
  version: versions.opencode,
  sha256: 'c'.repeat(64),
  integrity: 'verified',
  protocol: 'passed',
  provenance: 'reviewed-release',
  context: 'windows-native',
  compatibility: 'supported',
};

/**
 * Rows render in the order the host sent them. A Windows path is matched as plain text on
 * the row rather than through a text selector, whose parser reads a backslash as an escape.
 */
function candidateRow(section: Locator, index: number, _path: string): Locator {
  const row = section.locator('li.ai-candidate').nth(index);
  return row;
}

async function serveStatus(page: Page, connections: Record<string, unknown>[]): Promise<void> {
  await page.route('**/api/ai/status', (route) => route.fulfill({ json: { connections } }));
}

async function openEngines(page: Page): Promise<void> {
  await page.goto(baseURL);
  // Settings-only flow: the top strip's Settings button is on the Diomedes
  // landing too, so there is no project to enter here. Waiting for the click
  // itself to succeed replaces the old `.console` load-wait, which is now
  // ambiguous on the landing (it holds both `.console.strip-only` and
  // `.console.diomedes`).
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('button', { name: 'Engines', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Engines', exact: true, level: 1 })).toBeVisible();
}

/**
 * The model this route is set to use. A test verifies the route a run would
 * take, so the screen offers one only for a route whose model is saved, and
 * the host refuses a request for any other model.
 */
async function selectOpenCode(): Promise<void> {
  await api('/settings', 'PUT', {
    services: {
      opencode: true,
      defaultEngine: 'opencode',
      opencodeModel: 'opencode/fixture-model',
    },
  });
}

test('Settings offers the private compatible copy for a found but incompatible installation', async ({
  page,
}) => {
  const installs: unknown[] = [];
  await serveStatus(page, [
    wire({
      compatibility: 'unsupported',
      authentication: 'unknown',
      models: [],
      version: '1.19.0',
      nextAction: 'repair',
      detail: 'The installed version is not the one this adapter was tested against.',
    }),
  ]);
  await page.route('**/api/ai/install/opencode', (route) => {
    if (route.request().method() === 'GET')
      return route.fulfill({
        json: {
          engine: 'opencode',
          publisher: 'Diomedes',
          source: 'https://example.invalid/opencode-1.18.4.zip',
          version: versions.opencode,
          destination: 'C:\\Users\\fixture\\AppData\\Local\\Diomedes\\engines\\opencode',
          dependencies: [],
          privileges: 'No administrator rights are required.',
          account: 'No account is needed to install this copy.',
          available: true,
          detail: 'A copy Diomedes installs for itself.',
        },
      });
    installs.push(route.request().postDataJSON());
    return route.fulfill({ json: { detail: 'Installed the private copy.' } });
  });
  try {
    await openEngines(page);
    const section = setupSection(page);
    // Found is not usable, and the strip says which of the two it is.
    await expect(stateChip(page, 'installation')).toContainText('Found, unsupported version');
    // The defect this repairs: Install used to appear only when nothing was found.
    const primary = section.getByRole('button', {
      name: 'Repair with a compatible copy for Diomedes',
      exact: true,
    });
    await expect(primary).toBeVisible();
    expect(installs).toHaveLength(0);
    await primary.click();
    await expect(section.getByText('C:\\Users\\fixture\\AppData\\Local\\Diomedes\\engines\\opencode')).toBeVisible();
    await expect(section.getByText(versions.opencode, { exact: true }).first()).toBeVisible();
    await expect(
      section.getByText(
        'This copy belongs to Diomedes alone. It does not change, downgrade or remove your own installation, and it does not change PATH.',
      ),
    ).toBeVisible();
    // Reading the offer sends nothing; only the confirmation does.
    expect(installs).toHaveLength(0);
    await section.getByRole('button', { name: 'Repair this installation', exact: true }).click();
    await expect.poll(() => installs.length).toBe(1);
    expect(installs[0]).toEqual({ consent: true });
  } finally {
    await page.unrouteAll({ behavior: 'wait' });
  }
});

test('Settings names a corrupt installation and a broken binding, and switches to neither', async ({
  page,
}) => {
  const binds: unknown[] = [];
  // Opening the installations must not take the app down with it: the panel's
  // own toggle used to read a cleared event inside a state updater, which threw
  // during render and emptied the window.
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/api/ai/bind', (route) => {
    binds.push(route.request().postDataJSON());
    return route.fulfill({ json: wire() });
  });
  try {
    await serveStatus(page, [
      wire({
        installation: 'corrupt',
        authentication: 'unknown',
        models: [],
        nextAction: 'repair',
        detail: 'The installation failed its integrity check.',
      }),
    ]);
    await openEngines(page);
    const section = setupSection(page);
    await expect(stateChip(page, 'installation')).toContainText('Found, failed its integrity check');
    await expect(
      section.getByRole('button', {
        name: 'Repair with a compatible copy for Diomedes',
        exact: true,
      }),
    ).toBeVisible();

    // A binding whose executable changed: named, repairable, never replaced.
    await page.unroute('**/api/ai/status');
    await serveStatus(page, [
      wire({
        authentication: 'unknown',
        models: [],
        nextAction: 'repair',
        repair: 'selected-changed',
        binding: {
          id: systemCandidate.id,
          engine: 'opencode',
          path: systemCandidate.path,
          version: versions.opencode,
          sha256: 'd'.repeat(64),
          source: 'system',
          boundAt: new Date().toISOString(),
          origin: 'explicit',
        },
        candidates: [systemCandidate, managedCandidate],
        recommendedCandidateId: managedCandidate.id,
        detail: 'The installation you chose is no longer the one you chose.',
      }),
    ]);
    // A reload lands on Home, not on the screen under test.
    await openEngines(page);
    await expect(stateChip(page, 'installation')).toContainText('Found, needs repair');
    await expect(section.getByText(/has changed since you chose it/)).toContainText(
      'C:\\Tools\\opencode.exe',
    );
    await section.locator('details.ai-candidates > summary').click();
    // Both installations are shown; the bound one is still the bound one.
    const own = candidateRow(section, 0, systemCandidate.path);
    const managed = candidateRow(section, 1, managedCandidate.path);
    await expect(own).toContainText('Your own installation');
    await expect(own).toContainText('Your own copy; Diomedes did not verify its publisher.');
    await expect(own).toContainText('Unsupported version');
    await expect(own).toContainText('In use');
    await expect(managed).toContainText("Diomedes's private copy");
    await expect(managed.getByRole('button', { name: 'Use this installation', exact: true })).toBeVisible();
    // Nothing moved on its own: a different executable is used only on request.
    expect(binds).toHaveLength(0);
    // The screen survived opening that panel.
    expect(errors).toEqual([]);
  } finally {
    await page.unrouteAll({ behavior: 'wait' });
  }
});

test('Settings binds the installation a person chooses, and sends only its candidate id', async ({
  page,
}) => {
  const binds: unknown[] = [];
  await serveStatus(page, [
    wire({
      authentication: 'unknown',
      models: [],
      nextAction: 'choose-installation',
      candidates: [systemCandidate, managedCandidate],
      recommendedCandidateId: managedCandidate.id,
      detail: 'Two installations were found. Choose the one this route uses.',
    }),
  ]);
  await page.route('**/api/ai/bind', (route) => {
    binds.push(route.request().postDataJSON());
    return route.fulfill({
      json: wire({
        binding: {
          id: managedCandidate.id,
          engine: 'opencode',
          path: managedCandidate.path,
          version: versions.opencode,
          sha256: managedCandidate.sha256,
          source: 'managed',
          boundAt: new Date().toISOString(),
          origin: 'explicit',
        },
        candidates: [systemCandidate, managedCandidate],
        nextAction: 'check-connection',
        detail: 'Using the copy Diomedes installed for itself.',
      }),
    });
  });
  try {
    await openEngines(page);
    const section = setupSection(page);
    await section.getByRole('button', { name: 'Choose an installation', exact: true }).click();
    const managed = candidateRow(section, 1, managedCandidate.path);
    await expect(managed).toContainText('Recommended');
    await expect(managed).toContainText('Diomedes verified these bytes against the release it pinned.');
    expect(binds).toHaveLength(0);
    await managed.getByRole('button', { name: 'Use this installation', exact: true }).click();
    await expect.poll(() => binds.length).toBe(1);
    expect(binds[0]).toEqual({ engine: 'opencode', candidateId: managedCandidate.id });
    // The chosen installation is the one the card now reports.
    await expect(section.getByText('Using the copy Diomedes installed for itself.')).toBeVisible();
    await expect(
      candidateRow(section, 1, managedCandidate.path),
    ).toContainText('In use');
  } finally {
    await page.unrouteAll({ behavior: 'wait' });
  }
});

test('Settings explains a different account route without calling the person signed out', async ({
  page,
}) => {
  await serveStatus(page, [
    wire({
      nextAction: 'explain-account-route',
      routeIssue: { required: 'opencode-go', connected: ['zen', 'anthropic'] },
      detail: 'The account this tool reported is not the one this route accepts.',
    }),
  ]);
  try {
    await openEngines(page);
    const section = setupSection(page);
    await expect(section.getByText('OpenCode reported zen, anthropic.')).toBeVisible();
    await expect(section.getByText(/This route uses opencode-go only/)).toContainText(
      'not used here',
    );
    // The route keeps its own name, and carries the caption where it is chosen.
    await expect(section.getByRole('heading', { name: 'OpenCode', exact: true })).toBeVisible();
    await expect(section.getByText('OpenCode Go · Text and reviewed proposals')).toBeVisible();
    // Not signed out, and nothing to buy.
    await expect(section.getByRole('button', { name: /Sign in/ })).toHaveCount(0);
    await expect(section.getByText(/signed out|subscribe|upgrade|buy/i)).toHaveCount(0);
    // An account on another route is not offered a default model or a paid test.
    await expect(
      section.getByRole('button', { name: /Use as default|Test this connection/ }),
    ).toHaveCount(0);
    await expect(section.getByRole('combobox')).toHaveCount(0);
    await expect(
      section.getByRole('button', { name: 'Check sign-in and models', exact: true }),
    ).toBeVisible();
  } finally {
    await page.unrouteAll({ behavior: 'wait' });
  }
});

test('Settings sends one test request only on an explicit second click, and shows its receipt', async ({
  page,
}) => {
  const tests: unknown[] = [];
  const verifiedAt = new Date().toISOString();
  await serveStatus(page, [wire()]);
  await page.route('**/api/ai/test/opencode', (route) => {
    tests.push(route.request().postDataJSON());
    return route.fulfill({
      json: {
        receipt: {
          engine: 'opencode',
          revision: 1,
          candidateId: managedCandidate.id,
          version: versions.opencode,
          accountRoute: 'opencode:opencode-go',
          model: 'opencode/fixture-model',
          runId: 'run-fixture',
          buildId: 'build-fixture',
          verifiedAt,
        },
        connection: wire({
          nextAction: 'ready',
          verification: {
            engine: 'opencode',
            revision: 1,
            candidateId: managedCandidate.id,
            version: versions.opencode,
            accountRoute: 'opencode:opencode-go',
            model: 'opencode/fixture-model',
            runId: 'run-fixture',
            buildId: 'build-fixture',
            verifiedAt,
          },
        }),
      },
    });
  });
  try {
    await selectOpenCode();
    await openEngines(page);
    const section = setupSection(page);
    await expect(stateChip(page, 'test')).toContainText('Not tested');
    await section.getByRole('button', { name: 'Test this connection', exact: true }).click();
    // The consent names the model this route is set to use.
    await expect(section.getByText(/one small synthetic request/)).toContainText(
      'opencode/fixture-model',
    );
    await expect(section.getByText(/one small synthetic request/)).toContainText(
      "allowance or add provider charges",
    );
    // Opening the consent sends nothing.
    expect(tests).toHaveLength(0);
    await section.getByRole('button', { name: 'Send the test request', exact: true }).click();
    await expect.poll(() => tests.length).toBe(1);
    expect(tests[0]).toEqual({ consent: true, model: 'opencode/fixture-model' });
    await expect(section.getByText(/^Test succeeded /)).toContainText('opencode/fixture-model');
    await expect(stateChip(page, 'test')).toContainText('Succeeded');
  } finally {
    await page.unrouteAll({ behavior: 'wait' });
  }
});

test('Settings reports the stage a test failed at, and warns when a retry may be billed again', async ({
  page,
}) => {
  let failed = false;
  const diagnostic = {
    buildId: 'build-fixture',
    engine: 'opencode',
    candidateSource: 'managed',
    installedVersion: versions.opencode,
    accountRoute: 'opencode:opencode-go',
    selectedModel: 'opencode/fixture-model',
    stage: 'provider-auth',
    code: 'PROVIDER_DENIED',
    correlationId: 'correlation-fixture',
    lastVerifiedAt: null,
    at: new Date().toISOString(),
  };
  await page.route('**/api/ai/status', (route) =>
    route.fulfill({ json: { connections: [wire(failed ? { diagnostic } : {})] } }),
  );
  await page.route('**/api/ai/test/opencode', (route) => {
    failed = true;
    return route.fulfill({
      status: 503,
      json: {
        error: 'The provider refused this request.',
        code: 'PROVIDER_DENIED',
        ambiguous: true,
      },
    });
  });
  try {
    await selectOpenCode();
    await openEngines(page);
    const section = setupSection(page);
    await section.getByRole('button', { name: 'Test this connection', exact: true }).click();
    await section.getByRole('button', { name: 'Send the test request', exact: true }).click();
    await expect(section.getByRole('alert')).toContainText('The provider refused this request.');
    // The stage comes from the host record, and names the provider check rather
    // than telling the person to sign in again.
    await expect(section.getByText(/the provider checking the account/)).toContainText(
      'Check the account this route uses',
    );
    await expect(section.getByText(/sign in again/i)).toHaveCount(0);
    await expect(section.getByText(/A retry may be billed again/)).toBeVisible();
    // The route is kept, and a retry is another explicit click.
    await expect(section.getByRole('combobox', { name: 'OpenCode model', exact: true })).toHaveValue(
      'opencode/fixture-model',
    );
    await expect(section.getByRole('button', { name: 'Retry the test', exact: true })).toBeVisible();
  } finally {
    await page.unrouteAll({ behavior: 'wait' });
  }
});

test('Settings reads the stage a failed test carried with it, without a status re-read', async ({
  page,
}) => {
  // The failure answers with the stage it stopped at, and the status payload
  // served here carries no diagnostic at all. Whatever the card says about
  // where this stopped therefore came from the error itself.
  const tests: unknown[] = [];
  await serveStatus(page, [wire()]);
  await page.route('**/api/ai/test/opencode', (route) => {
    tests.push(route.request().postDataJSON());
    return route.fulfill({
      status: 503,
      json: {
        error: 'The provider did not answer this request.',
        code: 'PROVIDER_ERROR',
        ambiguous: false,
        stage: 'dispatch',
      },
    });
  });
  try {
    await selectOpenCode();
    await openEngines(page);
    const section = setupSection(page);
    await expect(stateChip(page, 'test')).toContainText('Not tested');
    await section.getByRole('button', { name: 'Test this connection', exact: true }).click();
    await section.getByRole('button', { name: 'Send the test request', exact: true }).click();
    await expect.poll(() => tests.length).toBe(1);
    await expect(section.getByRole('alert')).toContainText(
      'The provider did not answer this request.',
    );
    await expect(
      section.getByText(/The last attempt stopped while sending the request/),
    ).toContainText('The request reached the provider and did not finish.');
    await expect(section.getByText(/sign in again/i)).toHaveCount(0);
    // Not ambiguous, so no billing warning is invented.
    await expect(section.getByText(/A retry may be billed again/)).toHaveCount(0);
    await expect(stateChip(page, 'test')).toContainText('Not tested');
    await expect(section.getByRole('button', { name: 'Retry the test', exact: true })).toBeVisible();
  } finally {
    await page.unrouteAll({ behavior: 'wait' });
  }
});

/**
 * A native sign-in window Diomedes opened, through its three host states: the
 * window is running, the window has ended and the host's own check has not
 * landed, and the check has answered.
 *
 * Timing note for whoever runs this: the screen waits up to four seconds from
 * the first status answer that reports the window gone, and reads status once a
 * second. The phase is therefore flipped immediately after the waiting state is
 * asserted, and `checkedAt` is computed inside the route handler so the
 * re-checked payload is genuinely newer than the moment the wait began.
 */
test('Settings waits for the host check when a sign-in window ends, and never calls it signed in', async ({
  page,
}) => {
  let phase: 'open' | 'ended' | 'rechecked' = 'open';
  const stale = new Date(Date.now() - 600_000).toISOString();
  await page.route('**/api/ai/status', (route) =>
    route.fulfill({
      json: {
        connections: [
          phase === 'rechecked'
            ? wire({
                signInWindow: 'idle',
                checkedAt: new Date().toISOString(),
                nextAction: 'enable',
                detail: 'Native OpenCode Go account connected.',
              })
            : wire({
                signInWindow: phase === 'open' ? 'running' : 'idle',
                authentication: 'signed-out',
                models: [],
                checkedAt: stale,
                nextAction: 'sign-in',
                detail: 'Sign in to the native OpenCode Go account before using this route.',
              }),
        ],
      },
    }),
  );
  try {
    await openEngines(page);
    const section = setupSection(page);
    // The window is open. The card says so and offers only to close it: no
    // check to press, and no test to send through an account that is not there.
    await expect(
      section.getByText(
        'The OpenCode sign-in window is open on this computer. Finish it there, or close it.',
      ),
    ).toBeVisible();
    await expect(
      section.getByRole('button', { name: 'Close sign-in window', exact: true }),
    ).toBeVisible();
    await expect(
      section.getByRole('button', { name: 'Check sign-in and models', exact: true }),
    ).toHaveCount(0);
    await expect(section.getByRole('button', { name: /Sign in with/ })).toHaveCount(0);
    await expect(section.getByRole('button', { name: /Test this connection/ })).toHaveCount(0);

    // The window ended. That is not a sign-in: the host's own check has not
    // answered yet, so the card is still waiting and the account still reads
    // as it did before the window opened.
    phase = 'ended';
    await expect(
      section.getByText(
        'The OpenCode sign-in window closed. Diomedes is checking this service again.',
      ),
    ).toBeVisible();
    // The account still reads as it did before the window opened.
    await expect(stateChip(page, 'account')).toContainText('Not detected');
    await expect(
      section.getByRole('button', { name: 'Check sign-in and models', exact: true }),
    ).toHaveCount(0);

    // The check answered. What it said is what the card now shows, and the
    // waiting line is gone.
    phase = 'rechecked';
    await expect(stateChip(page, 'account')).toContainText('Detected');
    await expect(stateChip(page, 'models')).toContainText('1 listed');
    await expect(section.getByText(/sign-in window/)).toHaveCount(0);
    await expect(
      section.getByRole('button', { name: 'Turn on for Diomedes', exact: true }),
    ).toBeVisible();
  } finally {
    await page.unrouteAll({ behavior: 'wait' });
  }
});

test('Settings raises no alarm when a manual check collides with the host own check', async ({
  page,
}) => {
  // REQUEST_ACTIVE means a check for this route is already running — which is
  // exactly what the host starts for itself when a sign-in window ends. Nothing
  // failed, so nothing is reported.
  const checks: string[] = [];
  await serveStatus(page, [
    wire({ authentication: 'unknown', models: [], nextAction: 'check-connection' }),
  ]);
  await page.route('**/api/ai/check/opencode', (route) => {
    checks.push(route.request().method());
    return route.fulfill({
      status: 503,
      json: {
        error: 'This service is already being checked. Wait for that check before starting another request.',
        code: 'REQUEST_ACTIVE',
        ambiguous: false,
      },
    });
  });
  try {
    await openEngines(page);
    const section = setupSection(page);
    const check = section.getByRole('button', { name: 'Check sign-in and models', exact: true });
    await check.click();
    await expect.poll(() => checks.length).toBe(1);
    await expect(check).toBeEnabled();
    await expect(section.getByRole('alert')).toHaveCount(0);
    await expect(section.getByText(/already being checked/)).toHaveCount(0);
  } finally {
    await page.unrouteAll({ behavior: 'wait' });
  }
});

test('Settings sends a changed binding to the installations, not to a sign-in', async ({ page }) => {
  let broken = false;
  await page.route('**/api/ai/status', (route) =>
    route.fulfill({
      json: {
        connections: [
          broken
            ? wire({
                nextAction: 'repair',
                repair: 'selected-changed',
                binding: {
                  id: systemCandidate.id,
                  engine: 'opencode',
                  path: systemCandidate.path,
                  version: versions.opencode,
                  sha256: 'd'.repeat(64),
                  source: 'system',
                  boundAt: new Date().toISOString(),
                  origin: 'explicit',
                },
                candidates: [systemCandidate, managedCandidate],
                recommendedCandidateId: managedCandidate.id,
                detail: 'The installation you chose is no longer the one you chose.',
              })
            : wire(),
        ],
      },
    }),
  );
  await page.route('**/api/ai/test/opencode', (route) => {
    broken = true;
    return route.fulfill({
      status: 409,
      json: {
        error: 'The installation you chose has changed since you chose it.',
        code: 'BINDING_CHANGED',
        ambiguous: false,
        stage: 'runtime-verification',
      },
    });
  });
  try {
    await selectOpenCode();
    await openEngines(page);
    const section = setupSection(page);
    await section.getByRole('button', { name: 'Test this connection', exact: true }).click();
    await section.getByRole('button', { name: 'Send the test request', exact: true }).click();
    await expect(section.getByRole('alert')).toContainText(
      'The installation you chose has changed since you chose it.',
    );
    // The stage names the installation check, and the installations are open.
    await expect(
      section.getByText(/checking the version and integrity of the installation/),
    ).toContainText('Check the installation, or install the compatible copy.');
    // Not a sign-in problem, and not answered with one.
    await expect(section.getByRole('button', { name: /Sign in/ })).toHaveCount(0);
    await expect(section.getByText(/sign in again/i)).toHaveCount(0);
    // The installations opened themselves, both rows in the order sent.
    await expect(section.locator('li.ai-candidate')).toHaveCount(2);
    await expect(candidateRow(section, 1, managedCandidate.path)).toContainText(
      "Diomedes's private copy",
    );
    await expect(
      section.getByRole('button', {
        name: 'Repair with a compatible copy for Diomedes',
        exact: true,
      }),
    ).toBeVisible();
  } finally {
    await page.unrouteAll({ behavior: 'wait' });
  }
});

/**
 * The same code, from the action beside it. The host throws BINDING_CHANGED
 * from the connection check and from the model selection as well as from the
 * test, and only the test used to answer it: the other two showed a red banner
 * with the one panel that resolves a changed binding shut.
 */
test('Settings sends a changed binding to the installations when the check is what found it', async ({
  page,
}) => {
  let broken = false;
  await page.route('**/api/ai/status', (route) =>
    route.fulfill({
      json: {
        connections: [
          broken
            ? wire({
                nextAction: 'repair',
                repair: 'selected-changed',
                binding: {
                  id: systemCandidate.id,
                  engine: 'opencode',
                  path: systemCandidate.path,
                  version: versions.opencode,
                  sha256: 'd'.repeat(64),
                  source: 'system',
                  boundAt: new Date().toISOString(),
                  origin: 'explicit',
                },
                candidates: [systemCandidate, managedCandidate],
                recommendedCandidateId: managedCandidate.id,
                detail: 'The installation you chose is no longer the one you chose.',
              })
            : wire(),
        ],
      },
    }),
  );
  await page.route('**/api/ai/check/opencode', (route) => {
    broken = true;
    return route.fulfill({
      status: 409,
      json: {
        error: 'The installation you chose has changed since you chose it.',
        code: 'BINDING_CHANGED',
        ambiguous: false,
        stage: 'runtime-verification',
      },
    });
  });
  try {
    await selectOpenCode();
    await openEngines(page);
    const section = setupSection(page);
    await section
      .getByRole('button', { name: 'Check sign-in and models', exact: true })
      .first()
      .click();
    await expect(section.getByRole('alert')).toContainText(
      'The installation you chose has changed since you chose it.',
    );
    // Answered among the installations, which opened themselves, and never by
    // signing in again.
    await expect(section.locator('li.ai-candidate')).toHaveCount(2);
    await expect(section.getByRole('button', { name: /Sign in/ })).toHaveCount(0);
    await expect(
      section.getByRole('button', {
        name: 'Repair with a compatible copy for Diomedes',
        exact: true,
      }),
    ).toBeVisible();
  } finally {
    await page.unrouteAll({ behavior: 'wait' });
  }
});

test('Settings separates how old a check is from what the route can do now', async ({ page }) => {
  const verifiedAt = new Date(Date.now() - 86_400_000).toISOString();
  await serveStatus(page, [
    wire({
      checkedAt: new Date(Date.now() - 600_000).toISOString(),
      nextAction: 'check-connection',
      verification: {
        engine: 'opencode',
        revision: 1,
        candidateId: managedCandidate.id,
        version: versions.opencode,
        accountRoute: 'opencode:opencode-go',
        model: 'opencode/fixture-model',
        runId: 'run-fixture',
        buildId: 'build-fixture',
        verifiedAt,
      },
    }),
  ]);
  try {
    await openEngines(page);
    const section = setupSection(page);
    await expect(section.getByText(/That check is no longer current/)).toBeVisible();
    await expect(section.getByText(/^Last verified /)).toContainText('opencode/fixture-model');
    await page.unroute('**/api/ai/status');
    // A future timestamp is not fresh; it needs a fresh check.
    await serveStatus(page, [
      wire({ checkedAt: new Date(Date.now() + 3_600_000).toISOString() }),
    ]);
    // A reload lands on Home, not on the screen under test.
    await openEngines(page);
    await expect(
      section.getByText('The last check carries no usable time. Check again.'),
    ).toBeVisible();
  } finally {
    await page.unrouteAll({ behavior: 'wait' });
  }
});

test('Settings renders a status payload that carries none of the optional fields', async ({
  page,
}) => {
  // Exactly what a build before candidate binding sends: no candidates, no
  // binding, no revision, no verification, no diagnostic and no next action.
  await serveStatus(page, [
    {
      engine: 'opencode',
      installation: 'found',
      compatibility: 'supported',
      authentication: 'unknown',
      accountRoute: null,
      models: [],
      checkedAt: null,
      detail: 'Found on this computer.',
      usage: { state: 'unknown', checkedAt: null },
    },
  ]);
  try {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await openEngines(page);
    const section = setupSection(page);
    await expect(stateChip(page, 'installation')).toContainText('Found');
    await expect(stateChip(page, 'account')).toContainText('Not checked');
    await expect(stateChip(page, 'test')).toContainText('Not tested');
    // With no next action on the wire, the screen asks the host what is true.
    await expect(
      section.getByRole('button', { name: 'Check sign-in and models', exact: true }),
    ).toHaveCount(1);
    await expect(section.getByText(/Last verified/)).toHaveCount(0);
    expect(errors).toEqual([]);
  } finally {
    await page.unrouteAll({ behavior: 'wait' });
  }
});

/**
 * What continuing from the AI step is, in the three states a person can be in.
 * Setup completion is not proof that a route works, so none of the three reads
 * like another, and the scripted sample is never offered as a provider result.
 */
test('Onboarding says which of the three things continuing actually does', async ({ page }) => {
  const saved = await api<{ services?: Record<string, unknown> }>('/settings');
  const verifiedAt = new Date().toISOString();
  const receipt = {
    engine: 'opencode',
    revision: 1,
    candidateId: managedCandidate.id,
    version: versions.opencode,
    accountRoute: 'opencode:opencode-go',
    model: 'opencode/fixture-model',
    runId: 'run-fixture',
    buildId: 'build-fixture',
    verifiedAt,
  };
  let tested = false;
  await page.route('**/api/ai/status', (route) =>
    route.fulfill({
      json: { connections: [wire(tested ? { verification: receipt } : { nextAction: 'enable' })] },
    }),
  );
  try {
    // Nothing usable: the local sample, said as the sample it is.
    await api('/settings', 'PUT', {
      services: {},
      onboarding: { resumeAt: 'ai', completedAt: null },
    });
    await page.goto(baseURL);
    await expect(
      page.getByRole('heading', { name: 'Connect an AI service', exact: true }),
    ).toBeVisible();
    const actions = page.locator('.setup-actions');
    await expect(
      actions.getByRole('button', { name: 'Continue with the local sample', exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText(
        'Sample work is scripted on this computer. It is not proof that a provider answered.',
      ),
    ).toBeVisible();

    // Selected and switched on, and nothing has been sent through it. The
    // control says so, and the test is offered beside it.
    await api('/settings', 'PUT', {
      services: {
        opencode: true,
        defaultEngine: 'opencode',
        opencodeModel: 'opencode/fixture-model',
      },
    });
    await page.goto(baseURL);
    await expect(
      actions.getByRole('button', { name: 'Continue without testing', exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText('This connection has not answered a real request yet.'),
    ).toBeVisible();
    await expect(
      actions.getByRole('button', { name: 'Continue with the local sample', exact: true }),
    ).toHaveCount(0);
    // That control reveals the one consent the card owns; it sends nothing.
    await actions.getByRole('button', { name: 'Test this connection', exact: true }).click();
    await expect(setupSection(page).getByText(/one small synthetic request/)).toBeVisible();

    // A result through this binding: plain Continue, and no sample sentence.
    tested = true;
    await page.goto(baseURL);
    await expect(actions.getByRole('button', { name: 'Continue', exact: true })).toBeVisible();
    await expect(
      actions.getByRole('button', { name: /Continue without testing|local sample/ }),
    ).toHaveCount(0);
    await expect(page.getByText('Diomedes will use the service you tested.')).toBeVisible();
    await expect(page.getByText(/Sample work is scripted/)).toHaveCount(0);
  } finally {
    await page.unrouteAll({ behavior: 'wait' });
    await api('/settings', 'PUT', {
      services: (saved.services ?? {}) as Record<string, unknown>,
      onboarding: { resumeAt: 'done', completedAt: new Date().toISOString() },
    });
  }
});

/**
 * The thread menu and the setup screen answer the same question the same way.
 * This account is real, signed in and lists models, and it is on an account
 * route this adapter does not use — the one case where "OpenCode is connected"
 * and "this route can run" come apart.
 */
test('The thread picker refuses a route whose account is on another route', async ({ page }) => {
  const saved = await api<{ services?: Record<string, unknown> }>('/settings');
  let issue = true;
  await page.route('**/api/ai/status', (route) =>
    route.fulfill({
      json: {
        connections: [
          wire(
            issue
              ? {
                  nextAction: 'explain-account-route',
                  routeIssue: { required: 'opencode-go', connected: ['zen'] },
                }
              : {},
          ),
        ],
      },
    }),
  );
  try {
    await api('/settings', 'PUT', {
      surface: 'console',
      openProjects: [project.id],
      services: {
        opencode: true,
        defaultEngine: 'opencode',
        opencodeModel: 'opencode/fixture-model',
      },
      onboarding: { resumeAt: 'done', completedAt: new Date().toISOString() },
    });
    await page.goto(baseURL);
    await reopenLastProject(page);
    await expect(page.locator('.console')).toBeVisible();
    // The Console opens on Home, and the picker belongs to a thread.
    await page
      .getByRole('navigation', { name: 'Threads and views' })
      .getByRole('button', { name: /Engine UI thread/ })
      .click();
    const picker = page.locator('.model-picker > button');
    await picker.click();
    const menu = page.getByRole('menu');
    // Not offered, and the menu says which of the reasons it is.
    await expect(menu.getByRole('menuitemradio')).toHaveCount(0);
    await expect(
      menu.getByText(/the account it reported is not the one this route uses/),
    ).toBeVisible();

    // The same account on the route this adapter does use is offered.
    issue = false;
    await page.keyboard.press('Escape');
    await picker.click();
    await expect(
      menu.getByRole('menuitemradio').filter({ hasText: 'opencode/fixture-model' }),
    ).toBeVisible();
  } finally {
    await page.unrouteAll({ behavior: 'wait' });
    await api('/settings', 'PUT', {
      services: (saved.services ?? {}) as Record<string, unknown>,
    });
  }
});

test('Console drops a late source listing when the person changes threads', async ({ page }) => {
  const fixture = await api<Project>('/projects', 'POST', { name: 'Late listing fixture' });
  await api(`/projects/${fixture.id}/threads`, 'POST', { name: 'First composer', mode: 'ask' });
  await api(`/projects/${fixture.id}/threads`, 'POST', { name: 'Second composer', mode: 'ask' });
  await api('/settings', 'PUT', { surface: 'console', openProjects: [fixture.id], services: { defaultEngine: 'opencode' } });
  await page.goto(baseURL);
  await reopenLastProject(page);
  const rail = page.getByRole('navigation', { name: 'Threads and views' });
  await rail.getByRole('button', { name: /First composer/ }).click();
  let release: (() => void) | undefined;
  let requested = false;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  await page.route(`**/api/projects/${fixture.id}/documents`, async (route) => {
    requested = true;
    await gate;
    await route.fulfill({ json: { documents: [] } });
  });
  const count = calls.length;
  try {
    const composer = page.getByRole('textbox', { name: 'Message this thread', exact: true });
    await composer.fill('Do not send notes.md from the second thread.');
    await composer.press('Enter');
    await expect.poll(() => requested).toBe(true);
    await rail.getByRole('button', { name: /Second composer/ }).click();
    release!();
    await page.unrouteAll({ behavior: 'wait' });
    await expect(composer).toBeEnabled();
    await expect(composer).toHaveValue('');
    await expect(page.getByRole('dialog', { name: 'Send this message?' })).toHaveCount(0);
    expect(calls).toHaveLength(count);
    expect((await api<ProjectState>(`/projects/${fixture.id}/state`)).conversations.every((c) => c.turns.length === 0)).toBe(true);
  } finally {
    release?.();
    await page.unrouteAll({ behavior: 'wait' });
  }
});

/**
 * The support preview is the payload, read before it is shared. The person sees
 * the exact characters the host sent, nothing reaches the clipboard until Copy
 * is pressed, and what Copy writes is the string that was on screen.
 *
 * The served text carries its own `generated:` timestamp, so it is captured
 * from the response this page received rather than read again afterwards.
 */
test('Settings shows the support information before it is shared, and copies exactly that', async ({
  page,
}) => {
  const writes = () =>
    page.evaluate(() => (window as unknown as { __clipboardWrites: string[] }).__clipboardWrites);
  await page.addInitScript(() => {
    const recorded: string[] = [];
    (window as unknown as { __clipboardWrites: string[] }).__clipboardWrites = recorded;
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: (value: string) => {
          recorded.push(value);
          return Promise.resolve();
        },
      },
    });
  });
  await page.goto(baseURL);
  // The landing page renders two elements with a `console` class (the strip
  // chrome and the Diomedes content itself), so a plain `.console` check is
  // ambiguous here; the Settings click below provides its own wait.
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('button', { name: 'About', exact: true }).click();

  const served = page.waitForResponse((response) =>
    response.url().includes('/api/support/bundle'),
  );
  await page.getByRole('button', { name: 'Review support information', exact: true }).click();
  const sent = ((await (await served).json()) as { text: string }).text;

  const dialog = page.getByRole('dialog', { name: 'Support information' });
  await expect(dialog).toBeVisible();
  const shown = (await dialog.locator('pre.code').textContent()) ?? '';
  // What is on screen is what the host sent, character for character, and it
  // names the build this app is actually running.
  expect(shown).toBe(sent);
  expect(shown).toMatch(/^build: .+$/m);

  // Reading it copies nothing.
  expect(await writes()).toEqual([]);

  await dialog.getByRole('button', { name: 'Copy', exact: true }).click();
  await expect.poll(writes).toEqual([shown]);
  // The note belongs to the dialog while the dialog is open, and is said once.
  await expect(page.getByText('Copied.', { exact: true })).toHaveCount(1);
  await expect(dialog.getByText('Copied.', { exact: true })).toHaveCount(1);

  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByText('Copied.', { exact: true })).toHaveCount(0);
});
