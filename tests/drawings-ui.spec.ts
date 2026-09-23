import { expect, firefox, test, type Page } from '@playwright/test';
import express from 'express';
import fs from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../server/app';
import type { NativeGenerator } from '../server/native-work';
import type { Conversation, Project, ProjectState, Task } from '../shared/types';
import { SVG_CHECK_PASSED } from '../shared/svg-check';
import { reopenLastProject } from './fixtures/landing';
import { MARKUP_TEXT } from './fixtures/markup-text';

// Drawings in Files and the SVG check on proposals (artifacts v2, lane 3),
// against the built Console and real guarded routes. The model is an injected
// generator: nothing is sent anywhere, and every request that leaves the
// loopback host fails the test.

const fixture = (set: 'benign' | 'hostile', name: string) =>
  readFileSync(path.resolve('tests', 'fixtures', 'svg-check', set, name), 'utf8');
const LOGO = fixture('benign', 'logo.svg');
const HOSTILE = fixture('hostile', 'script-element.svg');
const FLOW = 'flowchart TD\n  A[Order received] --> B{In stock?}\n  B -->|Yes| C[Pack and ship]\n';

let app: Awaited<ReturnType<typeof createApp>>;
let server: Server;
let url: string;
let project: Project;
/** What the injected generator proposes next: one file, written whole. */
let next: { path: string; text: string } = { path: 'badge.svg', text: LOGO };
let generated = 0;
/** Every request a drawing made to this service: a hostile file's loads land here, or nowhere. */
const PROBE = '/drawing-probe';
const probes: string[] = [];
/**
 * A drawing that tries what a file already on disk could: script, handlers,
 * and loads from this service and from outside, by element, stylesheet and
 * foreign content. svg-check refuses it as a proposal, but a file put in the
 * folder by other means reaches Files unchecked, and the frame alone must hold.
 */
const hostileDrawing = (origin: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="160" height="40" onload="console.log('hostile drawing ran: onload')">` +
  `<script>console.log('hostile drawing ran: script')</script>` +
  `<style>@import url("${origin}${PROBE}/import.css");rect{fill:url("${origin}${PROBE}/paint.svg#p")}</style>` +
  `<image href="${origin}${PROBE}/image.png" width="10" height="10"/>` +
  `<image xlink:href="https://example.invalid/outside.png" width="10" height="10"/>` +
  `<foreignObject width="10" height="10"><img xmlns="http://www.w3.org/1999/xhtml" src="${origin}${PROBE}/foreign.png" onerror="console.log('hostile drawing ran: onerror')"/></foreignObject>` +
  `<rect width="160" height="40"/><text x="4" y="24" class="word">Hostile</text></svg>\n`;

async function api<T>(route: string, method = 'GET', body?: unknown): Promise<T> {
  const response = await fetch(`${url}/api${route}`, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Diomedes-Client': '1' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  expect(response.ok, `${route}: ${response.status} ${response.ok ? '' : await response.text()}`).toBe(true);
  return response.json() as Promise<T>;
}
const pane = (page: Page) => page.getByRole('complementary', { name: 'Files', exact: true });
const row = (page: Page, name: string) =>
  pane(page)
    .locator('.files-row')
    .filter({
      has: page.locator('.files-name', {
        hasText: new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`),
      }),
    });
/** Every request must stay on this machine's loopback service. */
async function guard(page: Page, errors: string[]) {
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/*', async (route) => {
    const requested = new URL(route.request().url());
    if (requested.protocol.startsWith('http') && requested.hostname !== '127.0.0.1') {
      errors.push(`external request: ${requested.href}`);
      await route.abort();
      return;
    }
    await route.continue();
  });
}
/** Start Build work for a new task, in its own thread, and wait until the run settles. */
async function work(name: string) {
  const task = await api<Task>(`/projects/${project.id}/tasks`, 'POST', { name });
  const thread = await api<Conversation>(`/projects/${project.id}/threads`, 'POST', {
    name,
    taskId: task.id,
  });
  await api(`/projects/${project.id}/work/start`, 'POST', {
    protocolVersion: 1,
    commandId: `drawings-${task.id}`,
    taskId: task.id,
    threadId: thread.id,
    route: 'codex',
    sources: [],
    consent: true,
  });
  let session: ProjectState['sessions'][number] | undefined;
  await expect
    .poll(async () => {
      const state = await api<ProjectState>(`/projects/${project.id}/state`);
      session = state.sessions.find((item) => item.taskId === task.id);
      return session?.state;
    })
    .toMatch(/^(failed|waiting)$/);
  const state = await api<ProjectState>(`/projects/${project.id}/state`);
  return { session: session!, needs: state.needs.filter((need) => need.sessionId === session!.id) };
}
async function openThread(page: Page, name: string) {
  await page.goto(url);
  await reopenLastProject(page);
  await page
    .getByRole('navigation', { name: 'Threads and views' })
    .getByRole('button', { name: new RegExp(name) })
    .click();
  const thread = page.locator('#scrThread');
  await expect(thread).toBeVisible();
  return thread;
}

test.beforeAll(async () => {
  await fs.mkdir(path.resolve('test-results'), { recursive: true });
  const root = await fs.mkdtemp(path.resolve('test-results/drawings-ui-'));
  server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  url = `http://127.0.0.1:${port}`;
  const generator: NativeGenerator = async () => {
    generated += 1;
    return {
      model: 'Injected drawings test generator',
      text: JSON.stringify({
        summary: `Draw ${next.path}`,
        changes: [{ path: next.path, text: next.text, summary: `Write ${next.path}` }],
      }),
    };
  };
  app = await createApp({
    port,
    clientPort: port,
    dataDir: path.join(root, 'data'),
    projectRoot: path.join(root, 'projects'),
    reviewerAdapter: null,
    nativeGenerator: generator,
  });
  // This spec serves the built bundle: refuse a build older than the code it tests.
  const dist = path.resolve('dist');
  const built = (await fs.stat(path.join(dist, 'index.html'))).mtimeMs;
  for (const source of [
    'client/console/FilesPane.tsx',
    'client/console/files.css',
    'client/console/Need.tsx',
    'client/components.tsx',
    'shared/exact-review.ts',
    'shared/types.ts',
  ])
    expect(built, `Build first: ${source}`).toBeGreaterThan((await fs.stat(source)).mtimeMs);
  app.use(PROBE, (req, res) => {
    probes.push(req.originalUrl);
    res.status(204).end();
  });
  app.use(express.static(dist));
  app.get('/{*path}', (_req, res) => res.sendFile(path.join(dist, 'index.html')));
  server.on('request', app);
  project = await api<Project>('/projects', 'POST', { name: 'Drawings fixture' });
  await fs.writeFile(path.join(project.folder, 'logo.svg'), LOGO);
  await fs.writeFile(path.join(project.folder, 'flow.mmd'), FLOW);
  await fs.writeFile(path.join(project.folder, 'hostile.svg'), hostileDrawing(url));
  await api(`/projects/${project.id}/cloud-sharing`, 'PUT', {
    expectedVersion: 0,
    routes: ['codex'],
    documents: [],
    shareConversationHistory: false,
    shareReviewPackets: false,
  });
  await api('/settings', 'PUT', {
    surface: 'console',
    detail: 'technical',
    openProjects: [project.id],
    services: { codex: true },
    onboarding: {
      work: 'business',
      detail: 'technical',
      familiarity: 'comfortable',
      resumeAt: 'done',
      completedAt: new Date().toISOString(),
    },
  });
});
test.afterAll(async () => {
  await app?.locals.close();
  server?.closeAllConnections();
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
});

test('Firefox file sniffing cannot turn a model Markdown or Mermaid write into executable HTML', async ({}, testInfo) => {
  // A real file:// navigation, with Firefox's default sniffing preferences and
  // a fresh, headless profile. These payloads only set a title; all network is refused.
  // The suite normally overrides the executable with Edge; select Firefox
  // explicitly instead of inheriting that executable with Firefox arguments.
  const browser = await firefox.launch({ executablePath: firefox.executablePath() });
  try {
    const context = await browser.newContext();
    const requests: string[] = [];
    await context.route(/^https?:/, async (route) => {
      requests.push(route.request().url());
      await route.abort();
    });
    const page = await context.newPage();
    for (const extension of ['md', 'mmd']) {
      const payload = MARKUP_TEXT[2][1];
      const raw = testInfo.outputPath(`raw.${extension}`);
      await fs.mkdir(path.dirname(raw), { recursive: true });
      await fs.writeFile(raw, payload);
      await page.goto(pathToFileURL(raw).href);
      expect(await page.evaluate(() => document.contentType)).toBe('text/html');
      await expect(page).toHaveTitle('markup-executed');

      const name = `sniffed.${extension}`;
      next = { path: name, text: payload };
      const { session, needs } = await work(`Sniffed ${extension}`);
      expect(session.state).toBe('failed');
      expect(session.parseError).toContain('starts with markup');
      expect(needs).toEqual([]);
      await expect(fs.stat(path.join(project.folder, name))).rejects.toMatchObject({ code: 'ENOENT' });

      // Benign starts retain the model writer's byte-for-byte text contract,
      // even with a script example later in the text. Open those actual bytes.
      const safeName = `safe-sniff.${extension}`;
      const safe = extension === 'md' ? `# Notes\n\n${payload}` : `${FLOW}%% ${payload}`;
      const store = app.locals.store;
      await store.locked(() => store.writeRecorded(project.id, [{ path: safeName, text: safe, expected: null }], { actor: 'diomedes' }));
      const saved = path.join(project.folder, safeName);
      expect(await fs.readFile(saved, 'utf8')).toBe(safe);
      await page.goto(pathToFileURL(saved).href);
      expect(await page.evaluate(() => document.contentType)).toBe('text/plain');
      expect(await page.title()).not.toBe('markup-executed');
      await expect(page.locator('body')).toContainText(payload);
    }
    expect(requests).toEqual([]);
  } finally {
    await browser.close();
  }
});

test('Files previews an .svg and an .mmd only inside the sandboxed artifact frame', async ({ page }) => {
  const errors: string[] = [];
  await guard(page, errors);
  await page.addInitScript(() => {
    // Init scripts reach every frame, and the sandboxed drawing frames refuse
    // storage: only the app's own document opens the pane.
    if (window !== window.top) return;
    localStorage.setItem('console.files.open', 'true');
    localStorage.setItem('console.files.width', '420');
  });
  await page.goto(url);
  await page.getByRole('button', { name: 'Drawings fixture', exact: true }).click();

  await row(page, 'logo.svg').click();
  const image = pane(page).locator('.files-drawing iframe.art-frame.still.image');
  await expect(image).toBeVisible();
  expect(await image.getAttribute('sandbox')).toBe('');
  const imageDoc = (await image.getAttribute('srcdoc')) ?? '';
  expect(imageDoc).toContain("default-src 'none'");
  expect(imageDoc).toContain('id="wave"');
  // Drawn in the frame's own document, never in the app's.
  await expect(page.frameLocator('.files-drawing iframe').locator('text.word')).toHaveText('Harbor & Main');
  await expect(page.locator('#wave')).toHaveCount(0);
  await expect(pane(page).getByText('drawing ·', { exact: false })).toBeVisible();
  await pane(page).getByRole('button', { name: 'Back', exact: true }).click();

  await row(page, 'flow.mmd').click();
  const diagram = pane(page).locator('.files-drawing iframe.art-frame.still.diagram');
  await expect(diagram).toBeVisible();
  expect(await diagram.getAttribute('sandbox')).toBe('');
  expect((await diagram.getAttribute('srcdoc')) ?? '').toContain("default-src 'none'");
  await expect(page.frameLocator('.files-drawing iframe').getByText('Order received')).toBeVisible();
  await pane(page).getByRole('button', { name: 'Raw', exact: true }).click();
  await expect(pane(page).locator('pre.files-raw')).toContainText('flowchart TD');
  await expect(diagram).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('a hostile .svg already in the folder runs nothing and loads nothing when Files shows it', async ({ page }) => {
  const errors: string[] = [];
  const ran: string[] = [];
  probes.length = 0;
  await guard(page, errors);
  page.on('console', (message) => {
    if (message.text().includes('hostile drawing ran')) ran.push(message.text());
  });
  await page.addInitScript(() => {
    if (window !== window.top) return;
    localStorage.setItem('console.files.open', 'true');
    localStorage.setItem('console.files.width', '420');
  });
  await page.goto(url);
  await page.getByRole('button', { name: 'Drawings fixture', exact: true }).click();

  await row(page, 'hostile.svg').click();
  const image = pane(page).locator('.files-drawing iframe.art-frame.still.image');
  await expect(image).toBeVisible();
  // Drawn in the frame's own document, and the frame has loaded: every script,
  // handler and fetch in the file has had its chance.
  await expect(page.frameLocator('.files-drawing iframe').locator('text.word')).toHaveText('Hostile');
  await (await (await image.elementHandle())?.contentFrame())?.waitForLoadState('load');
  // Nothing to wait for can prove a negative; this gives a late console event
  // from the frame's own process time to arrive.
  await page.waitForTimeout(500);
  expect(ran).toEqual([]);
  expect(probes).toEqual([]);
  expect(errors).toEqual([]);
  // What held: a frame with no permission at all, under a policy that loads nothing.
  expect(await image.getAttribute('sandbox')).toBe('');
  expect((await image.getAttribute('srcdoc')) ?? '').toContain("default-src 'none'");
});

test('a hostile .svg proposal is refused with its reason, and nothing is written', async ({ page }) => {
  const errors: string[] = [];
  await guard(page, errors);
  next = { path: 'badge.svg', text: HOSTILE };
  const before = generated;
  const { session, needs } = await work('Hostile badge');
  expect(generated).toBe(before + 1);
  const reason = 'The SVG check refused badge.svg: the element <script> is not allowed (line 1).';
  expect(session.state).toBe('failed');
  expect(session.parseError).toBe(reason);
  expect(needs).toEqual([]);
  await expect(fs.stat(path.join(project.folder, 'badge.svg'))).rejects.toMatchObject({ code: 'ENOENT' });

  await openThread(page, 'Hostile badge');
  // The thread's own run record; the ledger's Activity list repeats the line.
  const transcript = page.getByRole('main', { name: 'Hostile badge' });
  await transcript.getByRole('button', { name: 'show run', exact: true }).click();
  await expect(
    transcript.getByText(`Work stopped: ${reason} No project files were changed.`, { exact: true }),
  ).toBeVisible();
  expect(errors).toEqual([]);
});

test('an .svg proposal that passes shows the verdict with its review', async ({ page }) => {
  const errors: string[] = [];
  await guard(page, errors);
  next = { path: 'badge.svg', text: LOGO };
  const { session, needs } = await work('Passing badge');
  expect(session.state).toBe('waiting');
  expect(needs).toHaveLength(1);

  const thread = await openThread(page, 'Passing badge');
  const need = thread.getByRole('region', { name: 'Needs your OK' });
  await expect(need.getByLabel('Content checks')).toContainText(`badge.svg ${SVG_CHECK_PASSED}`);
  await need.getByRole('button', { name: 'Show me first', exact: true }).click();
  const review = page.getByRole('dialog');
  await expect(review.getByLabel('Content checks')).toContainText(`badge.svg ${SVG_CHECK_PASSED}`);
  await expect(review.getByText('Harbor &amp; Main', { exact: false }).first()).toBeVisible();
  await expect(fs.stat(path.join(project.folder, 'badge.svg'))).rejects.toMatchObject({ code: 'ENOENT' });
  expect(errors).toEqual([]);
});
