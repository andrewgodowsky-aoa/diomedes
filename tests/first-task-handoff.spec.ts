import { test, expect, type Page } from '@playwright/test';
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
  Project,
  ProjectState,
} from '../shared/types';

/**
 * From a connection test that succeeded to a composer the person writes their
 * own first task in.
 *
 * The scaffolding is `tests/ai-engines-ui.spec.ts`: a real `createApp` with a
 * fixture adapter that never starts an engine, reads a credential or contacts a
 * provider. The host's answer about the route is served through `page.route`,
 * the same way that spec serves a state its fixture service cannot reach, and
 * the one test request is answered by a stub — so the fixture adapter's
 * `generate` is never called, which is the number this spec watches.
 */
test.describe.configure({ mode: 'serial' });

const port = Number(process.env.DIOMEDES_FIRST_TASK_UI_PORT ?? 47637);
const baseURL = `http://127.0.0.1:${port}`;
const headers = { 'Content-Type': 'application/json', 'X-Diomedes-Client': '1' };
const OPENCODE_VERSION = '1.18.4';
const MODEL = 'opencode/fixture-model';

const fixtureModel: EngineModel = {
  slug: MODEL,
  name: 'OpenCode fixture model',
  description: 'A deterministic browser fixture model.',
  defaultEffort: null,
  efforts: [],
};

let application: Awaited<ReturnType<typeof createApp>> | undefined;
let server: Server | undefined;
let fixtureRoot: string | undefined;
let project: Project;
/** Every call the fixture adapter was asked to generate. It must stay empty. */
const calls: TextRequest[] = [];

async function api<T>(route: string, method = 'GET', data?: unknown): Promise<T> {
  const response = await fetch(`${baseURL}/api${route}`, {
    method,
    headers,
    body: data === undefined ? undefined : JSON.stringify(data),
  });
  if (!response.ok)
    throw new Error(
      `First-task fixture request ${route} failed (${response.status}): ${await response.text()}`,
    );
  return response.json() as Promise<T>;
}

function fixtureAdapter(engine: ExternalEngine): TextEngineAdapter {
  return {
    id: engine,
    contract: routeContractFor(engine),
    inspect: async () => ({
      authentication: 'signed-in',
      accountRoute: 'opencode:opencode-go',
      models: [fixtureModel],
      detail: 'Fixture account and model catalogue.',
    }),
    generate: async (input: TextRequest): Promise<TextResponse> => {
      calls.push(input);
      return {
        text: 'The fixture adapter answered.',
        model: input.model,
        version: OPENCODE_VERSION,
        threadId: input.threadId,
        projectId: input.projectId,
        requestId: input.requestId,
      };
    },
  };
}

/** The host's record for this route, before and after its test. */
function wire(patch: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    engine: 'opencode',
    installation: 'found',
    compatibility: 'supported',
    authentication: 'signed-in',
    accountRoute: 'opencode:opencode-go',
    models: [fixtureModel],
    checkedAt: new Date().toISOString(),
    detail: 'Native OpenCode Go account connected.',
    usage: { state: 'unknown', checkedAt: null },
    version: OPENCODE_VERSION,
    location: 'C:\\Tools\\opencode.exe',
    revision: 1,
    nextAction: 'test-connection',
    ...patch,
  };
}

const receipt = {
  engine: 'opencode',
  revision: 1,
  candidateId: 'managed:opencode:C:\\Diomedes\\engines\\opencode\\opencode.exe',
  version: OPENCODE_VERSION,
  accountRoute: 'opencode:opencode-go',
  model: MODEL,
  runId: 'run-fixture',
  buildId: 'build-fixture',
  verifiedAt: new Date().toISOString(),
};

const setupSection = (page: Page) => page.locator('section.service[aria-label="OpenCode"]');

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
  const root = await fs.mkdtemp(path.join(results, 'first-task-handoff-'));
  fixtureRoot = root;
  const statuses: IntegrationStatus[] = [
    {
      id: 'opencode',
      name: 'OpenCode',
      kind: 'online',
      found: true,
      available: false,
      enabled: false,
      status: 'Installed',
      detail: 'Fixture installation.',
      capabilities: [],
      signIn: 'first-use',
      adapter: 'ready',
      installedVersion: OPENCODE_VERSION,
      location: path.join(root, 'opencode.fixture'),
      disclosure: [],
    },
  ];
  const service = new EngineService(path.join(root, 'engines'), {
    discover: async () => statuses,
    version: async () => OPENCODE_VERSION,
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

  project = await api<Project>('/projects', 'POST', { name: 'First task fixture' });
  await api(`/projects/${project.id}/threads`, 'POST', {
    name: 'First task thread',
    mode: 'ask',
  });
  // The host refuses `POST /api/ai/test/:engine` unless the model equals the
  // saved `opencodeModel`, so the route is selected before it is tested.
  await api('/settings', 'PUT', {
    surface: 'console',
    detail: 'technical',
    openProjects: [project.id],
    services: { opencode: true, defaultEngine: 'opencode', opencodeModel: MODEL },
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

test('A verified route carries the person to a composer, chooses itself for the thread, and sends nothing', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const tests: unknown[] = [];
  let verified = false;
  await page.route('**/api/ai/status', (route) =>
    route.fulfill({
      json: {
        connections: [
          wire(verified ? { nextAction: 'ready', verification: receipt } : {}),
        ],
      },
    }),
  );
  await page.route('**/api/ai/test/opencode', (route) => {
    tests.push(route.request().postDataJSON());
    verified = true;
    return route.fulfill({
      json: { receipt, connection: wire({ nextAction: 'ready', verification: receipt }) },
    });
  });
  const generated = calls.length;
  try {
    await page.goto(baseURL);
    await expect(page.locator('.console')).toBeVisible();
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByRole('button', { name: 'Engines', exact: true }).click();
    await expect(
      page.getByRole('heading', { name: 'Engines', exact: true, level: 1 }),
    ).toBeVisible();

    const section = setupSection(page);
    // Before a real request there is nothing to start a task on.
    await expect(section.getByRole('button', { name: 'Start a first task', exact: true })).toHaveCount(
      0,
    );

    await section.getByRole('button', { name: 'Test this connection', exact: true }).click();
    // Opening the consent sends nothing; the request is the second click.
    expect(tests).toHaveLength(0);
    await section.getByRole('button', { name: 'Send the test request', exact: true }).click();
    await expect.poll(() => tests.length).toBe(1);
    expect(tests[0]).toEqual({ consent: true, model: MODEL });
    await expect(section.getByText(/^Test succeeded /)).toContainText(MODEL);

    const start = section.getByRole('button', { name: 'Start a first task', exact: true });
    await expect(start).toBeVisible();
    await start.click();

    // Settings is closed and the Console is showing.
    await expect(page.getByRole('heading', { name: 'Engines', exact: true, level: 1 })).toHaveCount(
      0,
    );
    await expect(page.locator('.console')).toBeVisible();

    // The cursor is in the composer, and the composer is empty: no task was
    // written for the person.
    const composer = page.getByRole('textbox', { name: 'Message this thread', exact: true });
    await expect(composer).toBeFocused();
    await expect(composer).toHaveValue('');

    // The thread now requests the route and model that were tested, through the
    // same record the Picker reads.
    await expect
      .poll(async () => {
        const state = await api<ProjectState>(`/projects/${project.id}/state`);
        const thread = state.conversations.find((c) => c.name === 'First task thread');
        return { engine: thread?.engine, model: thread?.requested?.model };
      })
      .toEqual({ engine: 'opencode', model: MODEL });
    await expect(page.locator('.model-picker > button')).toContainText(MODEL);

    // Nothing was sent: no provider call, and no turn on the thread.
    expect(calls).toHaveLength(generated);
    const state = await api<ProjectState>(`/projects/${project.id}/state`);
    expect(state.conversations.every((c) => c.turns.length === 0)).toBe(true);
    await expect(page.getByRole('dialog', { name: 'Send this message?' })).toHaveCount(0);
    expect(errors).toEqual([]);
  } finally {
    await page.unrouteAll({ behavior: 'wait' });
  }
});
