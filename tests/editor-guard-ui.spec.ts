import { test, expect, type Locator, type Page, type Route } from '@playwright/test';
import express from 'express';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../server/app';
import type { DocumentInfo, Project } from '../shared/types';

/**
 * Every way out of the document editor either keeps the writing or asks first
 * (DIO-85), and the editor never takes typing before it knows the file is one
 * it can save (DIO-87). Driven through the Console against a service of its
 * own, so what the page is holding is the only state under test.
 *
 * The draft backup is what keeps writing across an exit that does not ask, so
 * the DIO-85 scenario breaks it the way a full or refused browser store does:
 * `setItem` throws. With nothing to keep the writing, each exit must stop and
 * ask, and "Keep writing" must leave the person back in the text box with
 * every word still there.
 */
test.describe.configure({ mode: 'serial' });

const HEADERS = { 'Content-Type': 'application/json', 'X-Diomedes-Client': '1' };
const ALPHA = 'Alpha notes.md';
const BETA = 'Beta notes.md';
const ALPHA_TEXT = '# Alpha\n\nThe first file.\n';
const BETA_TEXT = '# Beta\n\nThe second file.\n';
const THREAD = 'Talk it through';

let application: Awaited<ReturnType<typeof createApp>> | undefined;
let server: Server | undefined;
let baseURL = '';
let fixtureRoot = '';
let project: Project;
let other: Project;
let pageErrors: string[] = [];

async function api<T>(route: string, method = 'GET', data?: unknown): Promise<T> {
  const response = await fetch(`${baseURL}/api${route}`, {
    method,
    headers: HEADERS,
    body: data === undefined ? undefined : JSON.stringify(data),
  });
  if (!response.ok)
    throw new Error(`Editor fixture ${route} failed (${response.status}): ${await response.text()}`);
  return response.json() as Promise<T>;
}

test.beforeAll(async () => {
  const results = path.resolve('test-results');
  await fs.mkdir(results, { recursive: true });
  fixtureRoot = await fs.mkdtemp(path.join(results, 'editor-guard-ui-'));
  server = createServer();
  await new Promise<void>((resolve, reject) => {
    server!.once('error', reject);
    server!.listen(0, '127.0.0.1', resolve);
  });
  const port = (server.address() as AddressInfo).port;
  baseURL = `http://127.0.0.1:${port}`;
  application = await createApp({
    port,
    clientPort: port,
    dataDir: path.join(fixtureRoot, 'data'),
    projectRoot: path.join(fixtureRoot, 'projects'),
    nativeGenerator: async () => ({ model: 'fixture-model', text: '{"summary":"","changes":[]}' }),
    reviewerAdapter: null,
  });
  const dist = path.resolve('dist');
  await fs.access(path.join(dist, 'index.html'));
  application.use(express.static(dist));
  application.get('/{*path}', (_request, response) =>
    response.sendFile(path.join(dist, 'index.html')),
  );
  server.on('request', application);

  project = await api<Project>('/projects/sample', 'POST', {});
  other = await api<Project>('/projects', 'POST', { name: 'Second desk' });
  await api(`/projects/${project.id}/threads`, 'POST', { name: THREAD });
  await api('/settings', 'PUT', {
    view: 'architect',
    detail: 'standard',
    onboarding: {
      work: 'business',
      detail: 'standard',
      familiarity: 'some',
      resumeAt: 'done',
      completedAt: new Date().toISOString(),
    },
    openProjects: [other.id, project.id],
  });
});

test.beforeEach(async ({ page }) => {
  pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await fs.writeFile(path.join(project.folder, ALPHA), ALPHA_TEXT, 'utf8');
  await fs.writeFile(path.join(project.folder, BETA), BETA_TEXT, 'utf8');
});

test.afterEach(() => {
  expect(pageErrors, 'The interface must not throw uncaught browser errors').toEqual([]);
});

test.afterAll(async () => {
  if (application) await application.locals.close();
  if (server) {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server!.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

const rail = (page: Page) => page.getByRole('navigation', { name: 'Threads and views', exact: true });
const tabs = (page: Page) => page.getByRole('navigation', { name: 'Open projects', exact: true });
const filesPane = (page: Page) => page.getByRole('complementary', { name: 'Files', exact: true });
const textBox = (page: Page) =>
  page.getByRole('textbox', { name: 'The text in this file', exact: true });
const editorState = (page: Page) => page.locator('.docedit .de-state');
const asking = (page: Page) =>
  page.getByRole('alert', { name: 'You have writing that is not saved', exact: true });
const settingsNav = (page: Page) => page.getByRole('navigation', { name: 'Settings', exact: true });

/** Into the sample project's Console, by name, from a fresh page. */
async function enter(page: Page) {
  await page.goto(`${baseURL}/`);
  await tabs(page).getByRole('button', { name: project.name, exact: true }).click();
  await expect(rail(page)).toBeVisible();
}

/** Show one file in the Files pane's reader, opening the pane first if it is shut. */
async function showInPane(page: Page, file: string): Promise<Locator> {
  const pane = filesPane(page);
  if (!(await pane.isVisible()))
    await rail(page).getByRole('button', { name: 'Files', exact: true }).click();
  await expect(pane).toBeVisible();
  const back = pane.getByRole('button', { name: 'Back', exact: true });
  if (await back.isVisible()) await back.click();
  await pane
    .locator('.files-row')
    .filter({ has: page.locator('.files-name', { hasText: file }) })
    .click();
  await expect(pane.locator('.files-path')).toHaveText(file);
  return pane;
}

async function writeIn(page: Page, file: string): Promise<Locator> {
  const pane = await showInPane(page, file);
  await pane.getByRole('button', { name: 'Write in this file', exact: true }).click();
  const box = textBox(page);
  await expect(box).toBeVisible();
  await expect(page.locator('.docedit .de-path')).toHaveText(file);
  return box;
}

/** A browser store that refuses every write, the way a full one does. */
async function breakDraftBackup(page: Page) {
  await page.evaluate(() => {
    Storage.prototype.setItem = function refuse() {
      throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
    };
  });
}

/**
 * The exit did not happen: the question is on screen, the editor and every
 * word in it are still there, and "Keep writing" puts the keyboard back in the
 * text box.
 */
async function expectAskedAndKept(page: Page, file: string, draft: string) {
  await expect(asking(page)).toBeVisible();
  await expect(asking(page)).toBeFocused();
  await expect(page.locator('.docedit .de-path')).toHaveText(file);
  await expect(textBox(page)).toHaveValue(draft);
  await asking(page).getByRole('button', { name: 'Keep writing', exact: true }).click();
  await expect(asking(page)).toHaveCount(0);
  await expect(textBox(page)).toBeFocused();
  await expect(textBox(page)).toHaveValue(draft);
  await expect(editorState(page)).toHaveText('Not saved yet');
}

test('DIO-85: with no backup to keep the writing, every exit from the editor asks first', async ({
  page,
}) => {
  await enter(page);
  const box = await writeIn(page, ALPHA);
  await breakDraftBackup(page);
  const draft = `${ALPHA_TEXT}\nWriting that exists nowhere but this box.\n`;
  await box.fill(draft);
  await expect(editorState(page)).toHaveText('Not saved yet');
  await expect(page.locator('.docedit .de-warn')).toBeVisible();

  // Open another file from Files.
  const pane = await showInPane(page, BETA);
  await pane.getByRole('button', { name: 'Write in this file', exact: true }).click();
  await expectAskedAndKept(page, ALPHA, draft);

  // The Console header's Settings, Projects and project tabs.
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(settingsNav(page)).toHaveCount(0);
  await expectAskedAndKept(page, ALPHA, draft);
  await tabs(page).getByRole('button', { name: 'Projects', exact: true }).click();
  await expectAskedAndKept(page, ALPHA, draft);
  await tabs(page).getByRole('button', { name: other.name, exact: true }).click();
  await expectAskedAndKept(page, ALPHA, draft);

  // The rail: a thread, and a destination.
  await rail(page).getByRole('button', { name: new RegExp(THREAD) }).click();
  await expectAskedAndKept(page, ALPHA, draft);
  await rail(page).getByRole('button', { name: /^Board\b/ }).first().click();
  await expectAskedAndKept(page, ALPHA, draft);

  // The palette's view navigation.
  await page.keyboard.press('Control+k');
  const find = page.getByRole('textbox', { name: 'Find a task, worker, model, project or action' });
  await expect(find).toBeVisible();
  await find.fill('Board');
  await page
    .getByRole('dialog', { name: 'Find and act' })
    .locator('li', { has: page.locator('span', { hasText: /^Board$/ }) })
    .first()
    .click();
  await expectAskedAndKept(page, ALPHA, draft);

  // Throwing the writing away is a choice, and then the exit goes where it was going.
  await pane.getByRole('button', { name: 'Write in this file', exact: true }).click();
  await expect(asking(page)).toBeVisible();
  await asking(page).getByRole('button', { name: 'Throw my writing away', exact: true }).click();
  await expect(page.locator('.docedit .de-path')).toHaveText(BETA);
  await expect(textBox(page)).toHaveValue(BETA_TEXT);
  expect(await fs.readFile(path.join(project.folder, ALPHA), 'utf8')).toBe(ALPHA_TEXT);

  // Saving is the other way through: the file is written, then Settings opens.
  const kept = `${BETA_TEXT}\nSaved on the way out.\n`;
  await textBox(page).fill(kept);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(asking(page)).toBeVisible();
  await asking(page).getByRole('button', { name: 'Save and close', exact: true }).click();
  await expect(settingsNav(page)).toBeVisible();
  await expect.poll(() => fs.readFile(path.join(project.folder, BETA), 'utf8')).toBe(kept);
});

test('DIO-85: closing the window with unkept writing asks the browser to stop first', async ({
  page,
}) => {
  await enter(page);
  const box = await writeIn(page, ALPHA);
  await breakDraftBackup(page);
  await box.fill(`${ALPHA_TEXT}\nStill only here.\n`);
  await expect(editorState(page)).toHaveText('Not saved yet');
  const seen: string[] = [];
  page.once('dialog', (dialog) => {
    seen.push(dialog.type());
    void dialog.accept();
  });
  await page.reload();
  expect(seen).toEqual(['beforeunload']);
});

test('DIO-85: with the backup working, leaving keeps the writing and brings it back', async ({
  page,
}) => {
  await enter(page);
  const box = await writeIn(page, ALPHA);
  const draft = `${ALPHA_TEXT}\nKept in the backup while I look at something else.\n`;
  await box.fill(draft);
  await expect(editorState(page)).toHaveText('Not saved yet');

  // Another file opens straight away; nothing needs asking, because nothing is lost.
  await writeIn(page, BETA);
  await expect(asking(page)).toHaveCount(0);
  await expect(textBox(page)).toHaveValue(BETA_TEXT);

  // So does a rail destination.
  await rail(page).getByRole('button', { name: /^Board\b/ }).first().click();
  await expect(page.locator('.board[aria-label="Board"]')).toBeVisible();

  const back = await writeIn(page, ALPHA);
  await expect(back).toHaveValue(draft);
  await expect(page.locator('.docedit [role="status"]')).toHaveText(
    'We brought back writing you had not saved.',
  );
  // Leave the file as the next test expects to find it.
  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect(editorState(page)).toHaveText('All saved');
});

/** Hold every listing of the project's files until `release` is called. */
async function holdListings(page: Page) {
  const held: Route[] = [];
  let holding = true;
  let arrived: () => void = () => undefined;
  const first = new Promise<void>((resolve) => (arrived = resolve));
  await page.route(/\/api\/projects\/[^/]+\/documents(\?.*)?$/, async (route) => {
    if (route.request().method() !== 'GET' || !holding) return route.continue();
    held.push(route);
    arrived();
  });
  return {
    /** Resolves once a listing has been asked for and is being held. */
    arrived: first,
    async release() {
      holding = false;
      for (const route of held.splice(0)) await route.continue();
    },
  };
}

test('DIO-87: a file whose kind the listing has not settled cannot be typed in yet', async ({
  page,
}) => {
  await enter(page);
  const box = await writeIn(page, ALPHA);
  const mine = `${ALPHA_TEXT}\nMy version of this.\n`;
  await box.fill(mine);
  // Somebody else changes the file, so Save is refused and the rescue copy is offered.
  await fs.writeFile(path.join(project.folder, ALPHA), `${ALPHA_TEXT}\nTheirs.\n`, 'utf8');
  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  const conflict = page.getByRole('alert', {
    name: 'Someone else changed this file while you were writing',
    exact: true,
  });
  await expect(conflict).toBeVisible();

  // The copy is a file the listing has never seen. Until a listing says what
  // kind of file it is, the editor waits rather than guessing.
  const listings = await holdListings(page);
  const copy = 'Alpha notes (my copy).md';
  const reads: string[] = [];
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (url.pathname.endsWith('/documents/read')) reads.push(url.searchParams.get('path') ?? '');
  });
  await conflict
    .getByRole('button', { name: 'Save my writing as a separate file', exact: true })
    .click();
  await expect(page.locator('.docedit .de-path')).toHaveText(copy);
  // The save's own refresh asks for a listing. By then a guessing editor has
  // long since read the copy and opened it for typing.
  await listings.arrived;
  await expect(editorState(page)).toHaveText('Opening');
  await expect(textBox(page)).toHaveCount(0);
  expect(reads.filter((read) => read === copy)).toEqual([]);
  await expect(page.getByRole('button', { name: 'Save changes', exact: true })).toBeDisabled();

  await listings.release();
  await expect(textBox(page)).toBeVisible();
  await expect(textBox(page)).toHaveValue(mine);
  await expect(textBox(page)).toBeEditable();
  await expect(editorState(page)).toHaveText('All saved');
  await page.unroute(/\/api\/projects\/[^/]+\/documents(\?.*)?$/);
});

test('DIO-87: writing already in the box is never stranded by a later kind', async ({ page }) => {
  await enter(page);
  const box = await writeIn(page, ALPHA);
  // From here on, every listing says this file is a kind the editor cannot save.
  await page.route(/\/api\/projects\/[^/]+\/documents(\?.*)?$/, async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    const response = await route.fetch();
    const body = (await response.json()) as { documents: DocumentInfo[] };
    await route.fulfill({
      response,
      json: {
        documents: body.documents.map((file) =>
          file.path === ALPHA ? { ...file, kind: 'unsupported' as const } : file,
        ),
      },
    });
  });
  const draft = `${ALPHA_TEXT}\nTyped before the listing changed its mind.\n`;
  await box.fill(draft);
  await expect(editorState(page)).toHaveText('Not saved yet');
  // A state event is what refreshes the listing; a new thread makes one.
  const listed = page.waitForResponse(
    (response) =>
      /\/api\/projects\/[^/]+\/documents(\?.*)?$/.test(response.url()) &&
      response.request().method() === 'GET',
  );
  await api(`/projects/${project.id}/threads`, 'POST', { name: 'Something else' });
  await listed;
  await expect(editorState(page)).toHaveText('Not saved yet');
  await expect(textBox(page)).toBeEditable();
  await expect(textBox(page)).toHaveValue(draft);
  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect.poll(() => fs.readFile(path.join(project.folder, ALPHA), 'utf8')).toBe(draft);
  await page.unroute(/\/api\/projects\/[^/]+\/documents(\?.*)?$/);
});
