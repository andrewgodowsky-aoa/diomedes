import { test, expect } from '@playwright/test';
import express from 'express';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { Server } from 'node:http';
import { createApp } from '../server/app';
import { EngineService } from '../server/engines/service';
import type { TextEngineAdapter, TextRequest, TextResponse } from '../server/engines/contract';
import type {
  EngineModel,
  ExternalEngine,
  IntegrationStatus,
  Project,
  ProjectState,
} from '../shared/types';

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
};
const names: Record<ExternalEngine, string> = {
  'claude-code': 'Claude Code',
  opencode: 'OpenCode',
  'oh-my-pi': 'oh-my-pi',
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
    services: { 'claude-code': false, opencode: false, 'oh-my-pi': false },
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

test('Console discovers, selects, streams, cancels, and approves all three fixture engines', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(baseURL);
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
  }
  const selected = await api<{ services: Record<string, boolean | string> }>('/settings');
  expect(selected.services.defaultEngine).toBe('oh-my-pi');
  expect(selected.services['claude-codeModel']).toBe('claude-code/fixture-model');
  expect(selected.services.opencodeModel).toBe('opencode/fixture-model');
  expect(selected.services['oh-my-piModel']).toBe('oh-my-pi/fixture-model');

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

  await page.getByRole('button', { name: 'History', exact: true }).click();
  for (const engine of Object.keys(versions))
    await expect(page.locator('.history-entry').filter({ hasText: `${engine}/fixture-model changed 1 file` })).toHaveCount(1);
  expect(errors).toEqual([]);
});
