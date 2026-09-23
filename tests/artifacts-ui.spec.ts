import { expect, test as base, type CDPSession, type Locator, type Page } from '@playwright/test';
import express from 'express';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../server/app';
import { testOnlySecretBox } from '../server/connection-secrets';
import { DESIGN_CSP, STATIC_CSP } from '../client/console/artifact-frame';
import type { DocumentContent, Project, ProjectState } from '../shared/types';
import {
  ARTIFACT_ENGINE,
  ARTIFACT_MODEL,
  artifactEngine,
  artifactTransport,
  type ArtifactEngine,
} from './fixtures/scripted-artifacts';
import { AWS_CONNECT_BODY } from './fixtures/scripted-home-luna';

// Model artifacts in the real Console: the real host, Store, event stream and built bundle, with
// only the model scripted (tests/fixtures/scripted-artifacts.ts). It serves the built bundle, so
// it refuses a stale one.
//
// Every test proves the artifact frames reach nothing, rather than merely show nothing, with two
// observers. `page.route` sees the Console's own document and the frames Playwright instruments.
// It cannot be relied on for a sandboxed frame: Chromium runs those in a process of their own, and
// a request from one can pass page.route, context.route and the request events unreported (the
// first test is the control: two such frames, seen only by the proxy). So every browser context
// also runs through a recording proxy that refuses every tunnel: whatever any frame asks for off
// 127.0.0.1 is written down, and never leaves the machine.

/** Every host:port the browser asked the proxy to reach, in order, across the worker. */
interface Tunnels {
  server: string;
  opened: string[];
  close(): Promise<void>;
}

async function recordTunnels(): Promise<Tunnels> {
  const opened: string[] = [];
  const proxy = createServer((request, response) => {
    // Plain http through a proxy names its absolute URL.
    let target = request.url ?? '?';
    try {
      const parsed = new URL(target);
      target = `${parsed.hostname}:${parsed.port || '80'}`;
    } catch {
      // Not an absolute URL: record it as it came.
    }
    opened.push(target);
    response.writeHead(403).end();
  });
  proxy.on('connect', (request, socket) => {
    socket.on('error', () => undefined);
    opened.push(request.url ?? '?');
    socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
  });
  proxy.on('clientError', (_error, socket) => socket.destroy());
  await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve));
  return {
    server: `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`,
    opened,
    close: () =>
      new Promise<void>((resolve) => {
        proxy.closeAllConnections();
        proxy.close(() => resolve());
      }),
  };
}

/**
 * The browser's own service traffic. From every context Edge preconnects to its default search
 * engine and reaches its own services (seen here: www.bing.com, edge.microsoft.com). page.route
 * aborts every request the Console's document makes before it could reach the proxy, so a tunnel
 * comes either from a sandboxed frame or from the browser itself; these are the browser's. They
 * are refused like every other tunnel, so nothing reaches them either.
 */
const browserOwn = (target: string) => /(^|\.)(bing\.com|microsoft\.com|msn\.com):443$/.test(target);

const test = base.extend<object, { tunnels: Tunnels }>({
  tunnels: [
    async ({}, use) => {
      const tunnels = await recordTunnels();
      await use(tunnels);
      await tunnels.close();
    },
    { scope: 'worker' },
  ],
  proxy: async ({ tunnels }, use) => use({ server: tunnels.server, bypass: '127.0.0.1' }),
});

let app: Awaited<ReturnType<typeof createApp>> | undefined;
let server: Server | undefined;
let url = '';
let engine: ArtifactEngine;
let pageErrors: string[] = [];
let externals: string[] = [];
let dialogs: string[] = [];
/** Where this test's tunnels start in the worker's record. */
let tunnelMark = 0;
const tunnelsSince = (tunnels: Tunnels) => tunnels.opened.slice(tunnelMark);

async function api<T>(route: string, method = 'GET', data?: unknown): Promise<T> {
  const response = await fetch(`${url}/api${route}`, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Diomedes-Client': '1' },
    body: data === undefined ? undefined : JSON.stringify(data),
  });
  if (!response.ok)
    throw new Error(`Artifacts fixture request ${route} failed (${response.status}): ${await response.text()}`);
  return response.json() as Promise<T>;
}

async function expectFreshBundle(dist: string): Promise<void> {
  const built = (await fs.stat(path.join(dist, 'index.html'))).mtimeMs;
  let newest = 0;
  let newestPath = '';
  for (const dir of ['client', 'client/console', 'shared']) {
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
  expect(
    built,
    `dist is older than ${newestPath}, so this spec would test the previous build. Run "npm run build" first.`,
  ).toBeGreaterThan(newest);
}

/** http(s) and ws(s) requests may go to 127.0.0.1 and nowhere else. */
function local(target: string): boolean {
  const parsed = new URL(target);
  if (!/^(https?|wss?):$/.test(parsed.protocol)) return true;
  return parsed.hostname === '127.0.0.1';
}

test.beforeAll(async () => {
  const results = path.resolve('test-results');
  await fs.mkdir(results, { recursive: true });
  const root = await fs.mkdtemp(path.join(results, 'artifacts-ui-'));
  engine = artifactEngine(path.join(root, 'engines'));
  server = createServer();
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  url = `http://127.0.0.1:${port}`;
  app = await createApp({
    port,
    clientPort: port,
    dataDir: path.join(root, 'data'),
    projectRoot: path.join(root, 'projects'),
    engineService: engine.service,
    reviewerAdapter: null,
    secretBox: testOnlySecretBox(),
    modelApiTransport: artifactTransport,
  });
  const dist = path.resolve('dist');
  await fs.access(path.join(dist, 'index.html'));
  await expectFreshBundle(dist);
  app.use(express.static(dist));
  app.get('/{*path}', (_request, response) => response.sendFile(path.join(dist, 'index.html')));
  server.on('request', app);
  await api('/ai/discover', 'POST', { consent: true });
  await api(`/ai/check/${ARTIFACT_ENGINE}`, 'POST', {});
  await api('/ai/select', 'POST', { engine: ARTIFACT_ENGINE, model: ARTIFACT_MODEL });
  // The Diomedes conversation runs on AWS Bedrock (Luna), connected and spend-approved the way a
  // person would do it; only its transport is scripted. Project threads stay on Claude Code.
  await api('/ai/model-api/aws-bedrock', 'PUT', AWS_CONNECT_BODY);
  await api('/ai/model-api/aws-bedrock/spend-limit', 'PUT', { capUsd: 1, consent: true });
});

test.afterAll(async () => {
  engine?.release();
  await app?.locals.close?.();
  server?.closeAllConnections();
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
});

test.beforeEach(async ({ page, tunnels }) => {
  pageErrors = [];
  externals = [];
  dialogs = [];
  tunnelMark = tunnels.opened.length;
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('dialog', (dialog) => {
    dialogs.push(dialog.message());
    void dialog.dismiss();
  });
  page.on('websocket', (socket) => {
    if (!local(socket.url())) externals.push(socket.url());
  });
  await page.route('**/*', async (route) => {
    const target = route.request().url();
    if (local(target)) return route.continue();
    externals.push(target);
    return route.abort('blockedbyclient');
  });
});

test.afterEach(({ tunnels }) => {
  expect(externals, 'Nothing may be requested from outside 127.0.0.1').toEqual([]);
  expect(
    tunnelsSince(tunnels).filter((target) => !browserOwn(target)),
    'No frame may reach past 127.0.0.1, sandboxed ones included',
  ).toEqual([]);
  expect(dialogs, 'No script may open a dialog').toEqual([]);
  expect(pageErrors, 'The interface must not throw uncaught browser errors').toEqual([]);
});

/** A project of the test's own, with one thread, open in the Console. */
async function freshProject(name: string): Promise<Project> {
  const project = await api<Project>('/projects', 'POST', { name });
  await api(`/projects/${project.id}/threads`, 'POST', { name: `${name} thread`, mode: 'ask' });
  await api('/settings', 'PUT', {
    surface: 'console',
    detail: 'technical',
    openProjects: [project.id],
    onboarding: {
      work: 'business',
      detail: 'technical',
      familiarity: 'comfortable',
      resumeAt: 'done',
      completedAt: new Date().toISOString(),
    },
  });
  return project;
}

const state = (project: Project) => api<ProjectState>(`/projects/${project.id}/state`);
const composer = (page: Page) => page.getByRole('textbox', { name: 'Message this thread', exact: true });
const pane = (page: Page) => page.getByRole('complementary', { name: 'Artifact', exact: true });
const filesPane = (page: Page) => page.getByRole('complementary', { name: 'Files', exact: true });
const escaped = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** A chip in the thread: its kind, then its title, then its version and state. */
const chips = (page: Page, kind: string, title: string) =>
  page.locator('.transcript').getByRole('button', { name: new RegExp(`^${kind}\\s+${escaped(title)}\\b`) });

async function openConsole(page: Page, project: Project) {
  await page.goto(url);
  await page.getByRole('button', { name: project.name, exact: true }).click();
  await expect(composer(page)).toBeVisible();
}

async function send(page: Page, text: string) {
  await composer(page).fill(text);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await page
    .getByRole('dialog', { name: 'Send this message?' })
    .getByRole('button', { name: 'Send message', exact: true })
    .click();
}

// ---- reading a frame that runs nothing ------------------------------------------------------

interface DomNode {
  nodeType: number;
  nodeName: string;
  localName?: string;
  nodeValue?: string;
  attributes?: string[];
  children?: DomNode[];
  shadowRoots?: DomNode[];
  contentDocument?: DomNode;
}

function* walk(node: DomNode): Generator<DomNode> {
  yield node;
  for (const child of node.children ?? []) yield* walk(child);
  for (const shadow of node.shadowRoots ?? []) yield* walk(shadow);
  if (node.contentDocument) yield* walk(node.contentDocument);
}

function attributesOf(node: DomNode): Record<string, string> {
  const list = node.attributes ?? [];
  const found: Record<string, string> = {};
  for (let index = 0; index + 1 < list.length; index += 2) found[list[index]] = list[index + 1];
  return found;
}

interface FrameContents {
  /** Every element's tag name, lower case, in document order. */
  elements: string[];
  /** Every text node, joined by single spaces. */
  text: string;
  /** The attributes of the frame's <html> element. */
  root: Record<string, string>;
}

function contentsOf(document: DomNode): FrameContents {
  const nodes = [...walk(document)];
  const html = nodes.find((node) => node.nodeType === 1 && node.localName === 'html');
  return {
    elements: nodes
      .filter((node) => node.nodeType === 1)
      .map((node) => (node.localName || node.nodeName).toLowerCase()),
    text: nodes
      .filter((node) => node.nodeType === 3)
      .map((node) => node.nodeValue ?? '')
      .join(' ')
      .replace(/\s+/g, ' '),
    root: html ? attributesOf(html) : {},
  };
}

/**
 * What a `sandbox=""` frame holds. Nothing can run in one, Playwright's own injected script
 * included, so it is read the way DevTools reads it: as the DOM tree, with nothing run inside.
 * The frame may live in its own process (Chromium isolates sandboxed frames), so its own session
 * is tried first; otherwise its document is part of the page's tree.
 */
async function stillFrame(page: Page, frame: Locator): Promise<FrameContents> {
  const title = await frame.getAttribute('title');
  const inner = await (await frame.elementHandle())?.contentFrame();
  let session: CDPSession | null = null;
  if (inner) {
    try {
      session = await page.context().newCDPSession(inner);
    } catch {
      // Not an out-of-process frame: read it from the page's tree below.
    }
  }
  if (session) {
    try {
      const { root } = await session.send('DOM.getDocument', { depth: -1, pierce: true });
      return contentsOf(root);
    } finally {
      await session.detach();
    }
  }
  const pageSession = await page.context().newCDPSession(page);
  try {
    const { root } = await pageSession.send('DOM.getDocument', { depth: -1, pierce: true });
    for (const node of walk(root))
      if (node.localName === 'iframe' && attributesOf(node).title === title && node.contentDocument)
        return contentsOf(node.contentDocument);
  } finally {
    await pageSession.detach();
  }
  return { elements: [], text: '', root: {} };
}

/** Which delivery-check version a diagram frame is drawing, read from its srcdoc. */
async function drawnVersion(frame: Locator): Promise<string> {
  const srcdoc = await frame.getAttribute('srcdoc', { timeout: 1_000 }).catch(() => null);
  if (!srcdoc) return 'drawing';
  return srcdoc.includes('7am') ? 'v2' : 'v1';
}

// ---- the tests --------------------------------------------------------------------------------

test('the observers see what a frame without a policy does: the control for every "nothing" below', async ({ page, tunnels }) => {
  // "Nothing was requested" is only worth something if a request would have been seen. The same
  // two kinds of frame the panel draws in, with no policy in them, are seen asking for files, and
  // a script's mark is found by the same DOM read the tests below use to say that none ran.
  const project = await freshProject('Guard control');
  await openConsole(page, project);
  await page.evaluate(() => {
    const scripted = document.createElement('iframe');
    scripted.title = 'Control: script';
    scripted.setAttribute('sandbox', 'allow-scripts');
    scripted.srcdoc =
      '<img src="https://control-img.example.com/x.png" alt=""><script>document.documentElement.setAttribute("data-ran", "yes"); fetch("https://control-fetch.example.com/x").catch(() => undefined);</script>';
    const still = document.createElement('iframe');
    still.title = 'Control: picture';
    still.setAttribute('sandbox', '');
    still.srcdoc =
      '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><image href="https://control-still.example.com/x.png" width="10" height="10"/></svg>';
    document.body.append(scripted, still);
  });
  // Sandboxed frames run out of process, where the proxy is what sees them and what stops them.
  await expect
    .poll(() => [...new Set(tunnelsSince(tunnels).filter((target) => !browserOwn(target)))].sort())
    .toEqual(['control-fetch.example.com:443', 'control-img.example.com:443', 'control-still.example.com:443']);
  await expect
    .poll(async () => (await stillFrame(page, page.locator('iframe[title="Control: script"]'))).root['data-ran'])
    .toBe('yes');
  // The control's own requests were the point; the checks after it start from here.
  externals = [];
  tunnelMark = tunnels.opened.length;
});

test('a diagram opens in the panel, drawn in a frame that runs nothing', async ({ page }, testInfo) => {
  const project = await freshProject('Delivery desk');
  await openConsole(page, project);
  await send(page, 'DIAGRAM of the delivery check');
  const chip = chips(page, 'Diagram', 'Delivery check');
  await expect(chip).toBeVisible();
  await expect(chip).toContainText('Open');
  // The fence is the chip alone: none of its source is written into the turn.
  await expect(page.locator('.transcript')).toContainText('Here is how a delivery gets checked.');
  await expect(page.locator('.transcript')).not.toContainText('flowchart TD');

  await chip.click();
  const panel = pane(page);
  await expect(panel).toBeVisible();
  await expect(panel.getByRole('heading', { name: 'Delivery check', exact: true })).toBeFocused();
  await expect(panel.locator('.art-kind')).toHaveText('Diagram');
  await expect(chip).toHaveAttribute('aria-current', 'true');
  await expect(chip).toContainText('In panel');

  const frame = panel.locator('iframe[title="Diagram: Delivery check"]');
  await expect(frame).toHaveAttribute('sandbox', '');
  await expect(frame).toHaveAttribute('referrerpolicy', 'no-referrer');
  const srcdoc = (await frame.getAttribute('srcdoc')) ?? '';
  expect(
    srcdoc.startsWith(`<!doctype html><meta http-equiv="Content-Security-Policy" content="${STATIC_CSP}">`),
  ).toBe(true);
  expect(srcdoc).toContain('<svg');
  // The drawing is an SVG inside the frame's own document.
  await expect.poll(async () => (await stillFrame(page, frame)).elements).toContain('svg');
  const drawn = await stillFrame(page, frame);
  for (const word of ['Order', 'Book', 'customer']) expect(drawn.text).toContain(word);
  expect(drawn.elements).not.toContain('script');
  await page.screenshot({ path: testInfo.outputPath('diagram-in-panel.png'), animations: 'disabled' });

  // The panel's width is the person's own, and it is remembered.
  await panel.getByRole('separator', { name: 'Resize the artifact panel' }).focus();
  await page.keyboard.press('ArrowLeft');
  await expect
    .poll(() => page.evaluate(() => localStorage.getItem('console.artifacts.width')))
    .toBe('496');

  // Esc closes it while focus is inside it, and focus goes back to the chip that opened it.
  await page.keyboard.press('Escape');
  await expect(panel).toHaveCount(0);
  await expect(chip).toBeFocused();
  await expect(chip).toContainText('Open');
});

test('an answer with the same declared id is the next version, and the stepper walks them', async ({ page }, testInfo) => {
  const project = await freshProject('Delivery versions');
  await openConsole(page, project);
  await send(page, 'DIAGRAM of the delivery check');
  await chips(page, 'Diagram', 'Delivery check').click();
  const panel = pane(page);
  const frame = panel.locator('iframe[title="Diagram: Delivery check"]');
  await expect.poll(() => drawnVersion(frame)).toBe('v1');
  await expect(panel.locator('.art-version')).toHaveCount(0);

  // The panel is showing this artifact, so its next version comes in by itself and says so.
  await send(page, 'REDRAW it with the loading step');
  await expect(panel.locator('.art-version')).toHaveText('v2 of 2');
  await expect(panel.locator('.art-status')).toHaveText('New diagram: Delivery check, version 2 of 2.');
  await expect.poll(() => drawnVersion(frame)).toBe('v2');
  const both = chips(page, 'Diagram', 'Delivery check');
  await expect(both).toHaveCount(2);
  await expect(both.nth(0)).toContainText('v1');
  await expect(both.nth(1)).toContainText('v2');
  await expect(both.nth(1)).toHaveAttribute('aria-current', 'true');

  const previous = panel.getByRole('button', { name: 'Previous version', exact: true });
  const next = panel.getByRole('button', { name: 'Next version', exact: true });
  await expect(next).toHaveAttribute('aria-disabled', 'true');
  await previous.click();
  await expect(panel.locator('.art-version')).toHaveText('v1 of 2');
  await expect(previous).toHaveAttribute('aria-disabled', 'true');
  await expect.poll(() => drawnVersion(frame)).toBe('v1');
  await expect(both.nth(0)).toHaveAttribute('aria-current', 'true');
  await expect(both.nth(1)).not.toHaveAttribute('aria-current', 'true');
  await page.screenshot({ path: testInfo.outputPath('version-stepper.png'), animations: 'disabled' });
  await next.click();
  await expect(panel.locator('.art-version')).toHaveText('v2 of 2');
  await expect.poll(() => drawnVersion(frame)).toBe('v2');
});

test('Save to Files makes one file and one History entry, and Files opens it in the panel again', async ({ page }, testInfo) => {
  const project = await freshProject('Delivery files');
  await openConsole(page, project);
  await send(page, 'DIAGRAM of the delivery check');
  await chips(page, 'Diagram', 'Delivery check').click();
  const panel = pane(page);
  await expect(panel.locator('iframe[title="Diagram: Delivery check"]')).toBeAttached();

  const saved = 'Saved artifacts/Delivery check.md';
  const before = (await state(project)).history.length;
  const save = panel.getByRole('button', { name: 'Save to Files', exact: true });
  await save.click();
  await expect(panel.locator('.art-status')).toContainText(`Saved to Files as ${saved}.`);
  const after = await state(project);
  expect(after.history).toHaveLength(before + 1);
  expect(after.history.at(-1)!.files).toEqual([expect.objectContaining({ path: saved, op: 'created' })]);
  const file = await api<DocumentContent>(
    `/projects/${project.id}/documents/read?path=${encodeURIComponent(saved)}`,
  );
  expect(file.text).toContain('```mermaid');
  expect(file.text).toContain('%% artifact: id=delivery-flow title="Delivery check"');
  // The same version again is already there: no second file and no second entry.
  await save.click();
  await expect(panel.locator('.art-status')).toContainText(`Already saved as ${saved}.`);
  expect((await state(project)).history).toHaveLength(before + 1);

  // Files and the artifact share one column. Each keeps its place while the other is in front.
  await panel.getByRole('button', { name: 'Source', exact: true }).click();
  await expect(panel.locator('pre.art-source')).toContainText('flowchart TD');
  await panel.getByRole('button', { name: 'Show in Files', exact: true }).click();
  const files = filesPane(page);
  await expect(files).toBeVisible();
  await expect(panel).toBeHidden();
  const views = page.getByRole('group', { name: 'Panel', exact: true });
  await expect(views.getByRole('button', { name: 'Files', exact: true })).toHaveAttribute('aria-pressed', 'true');
  const openInPanel = files.getByRole('button', { name: 'Open in panel', exact: true });
  await expect(openInPanel).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('saved-in-files.png'), animations: 'disabled' });
  await views.getByRole('button', { name: 'Artifact', exact: true }).click();
  await expect(panel).toBeVisible();
  await expect(files).toBeHidden();
  await expect(panel.getByRole('button', { name: 'Source', exact: true })).toHaveAttribute('aria-pressed', 'true');

  // The saved file opens in the panel from Files, drawn from the file.
  await views.getByRole('button', { name: 'Files', exact: true }).click();
  await openInPanel.click();
  await expect(panel).toBeVisible();
  await expect(panel.getByRole('heading', { name: 'Delivery check', exact: true })).toBeFocused();
  await panel.getByRole('button', { name: 'Rendered', exact: true }).click();
  await expect(panel.locator('iframe[title="Diagram: Delivery check"]')).toHaveAttribute('srcdoc', /<svg/);
  // It is the file's artifact, not the thread's, so no chip says it is in the panel.
  await expect(chips(page, 'Diagram', 'Delivery check')).not.toHaveAttribute('aria-current', 'true');
});

test('a chart is an SVG with a plain-words name and its data one button away', async ({ page }, testInfo) => {
  const project = await freshProject('Weekly numbers');
  await openConsole(page, project);
  await send(page, 'CHART of this week');
  await chips(page, 'Chart', 'Weekly sends').click();
  const panel = pane(page);
  const chart = panel.getByRole('img', {
    name: /^Bar chart: Weekly sends\. 2 series \(Sent, Replies\) across 5 categories/,
  });
  await expect(chart).toBeVisible();
  await expect(panel.locator('svg.art-chart-svg rect.art-bar')).toHaveCount(10);
  const data = panel.getByRole('button', { name: 'Show data', exact: true });
  await expect(data).toHaveAttribute('aria-expanded', 'false');
  await data.click();
  const table = panel.getByRole('table');
  await expect(table.getByRole('columnheader')).toHaveText(['Category', 'Sent (msgs)', 'Replies (msgs)']);
  await expect(table.getByRole('row')).toHaveCount(6);
  await expect(table.getByRole('row').nth(3)).toHaveText(/Wed\s*150\s*20/);
  await expect(panel.getByRole('button', { name: 'Hide data', exact: true })).toHaveAttribute('aria-expanded', 'true');
  await page.screenshot({ path: testInfo.outputPath('chart-with-data.png'), animations: 'disabled' });
});

/**
 * Every segment of a segment bar has its share of the track. Inside the Console `.console .seg`
 * (console.css, the segmented radio control) also matches a segment, and without the chart's own
 * rule its `margin-left: auto` shrank each one to a 2 px border.
 */
async function expectSegmentsDrawn(track: Locator, count: number) {
  const segments = track.locator('span.seg');
  await expect(segments).toHaveCount(count);
  const trackBox = await track.boundingBox();
  const share = (trackBox!.width - 4 * (count - 1)) / count;
  for (const segment of await segments.all()) {
    const box = await segment.boundingBox();
    expect(box!.width).toBeGreaterThan(share - 1);
    expect(box!.height).toBeGreaterThanOrEqual(3);
  }
}

test('segments and progress charts are the Console segment bar, every segment drawn', async ({ page }, testInfo) => {
  const project = await freshProject('Launch board');
  await openConsole(page, project);
  await send(page, 'STEPS for the launch');
  await chips(page, 'Chart', 'Launch steps').click();
  const panel = pane(page);
  const steps = panel.getByRole('progressbar', { name: /^Steps: Launch steps\. 2 of 5 done/ });
  await expect(steps).toBeVisible();
  await expectSegmentsDrawn(steps, 5);
  await expect(steps.locator('span.seg.done')).toHaveCount(2);
  await expect(steps.locator('span.seg.active')).toHaveCount(1);
  await page.screenshot({ path: testInfo.outputPath('segments-chart.png'), animations: 'disabled' });
  await chips(page, 'Chart', 'Boxes packed').click();
  const packed = panel.getByRole('progressbar', { name: 'Progress: Boxes packed. 7 of 12 boxes.', exact: true });
  await expect(packed).toHaveAttribute('aria-valuenow', '7');
  await expect(packed).toHaveAttribute('aria-valuemax', '12');
  await expectSegmentsDrawn(packed, 12);
  await expect(packed.locator('span.seg.done')).toHaveCount(7);
});

test('a table stays readable in the turn, and Chart this draws any of its number columns', async ({ page }, testInfo) => {
  const project = await freshProject('Regional replies');
  await openConsole(page, project);
  await send(page, 'TABLE of replies by region');
  const turn = page.locator('.transcript .turn.dio').last();
  await expect(turn.getByRole('table')).toBeVisible();
  await expect(turn.getByRole('cell', { name: 'North', exact: true })).toBeVisible();

  await chips(page, 'Table', 'Replies by region').click();
  const panel = pane(page);
  await expect(panel.getByRole('table')).toBeVisible();
  const chartIt = panel.getByRole('button', { name: 'Chart this', exact: true });
  await expect(chartIt).toHaveAttribute('aria-expanded', 'false');
  await chartIt.click();
  await expect(panel.getByRole('img', { name: /^Bar chart: Sent by Region\./ })).toBeVisible();
  await expect(panel.locator('.art-chart-heading')).toHaveText('Sent by Region');
  await expect(panel.getByRole('button', { name: 'Hide chart', exact: true })).toHaveAttribute('aria-expanded', 'true');
  await panel.getByRole('combobox', { name: 'Column' }).selectOption({ label: 'Replies' });
  await expect(panel.getByRole('img', { name: /^Bar chart: Replies by Region\./ })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('table-charted.png'), animations: 'disabled' });
});

test('a hostile design runs only inside its own frame: no parent, no network, no popup, no storage', async ({ page, tunnels }, testInfo) => {
  const project = await freshProject('Offer page');
  await openConsole(page, project);
  const title = await page.title();
  const address = page.url();
  await send(page, 'DESIGN the offer page');
  await chips(page, 'Design', 'Spring offer').click();
  const panel = pane(page);
  const frame = panel.locator('iframe[title="Design: Spring offer"]');
  await expect(frame).toHaveAttribute('sandbox', 'allow-scripts');
  await expect(frame).toHaveAttribute('referrerpolicy', 'no-referrer');
  const srcdoc = (await frame.getAttribute('srcdoc')) ?? '';
  expect(
    srcdoc.startsWith(`<!doctype html><meta http-equiv="Content-Security-Policy" content="${DESIGN_CSP}">`),
  ).toBe(true);

  const body = page.frameLocator('iframe[title="Design: Spring offer"]').locator('body');
  // Its own script runs, inside its own frame...
  await expect(body).toHaveAttribute('data-ran', 'yes');
  await expect(body.getByRole('heading', { name: 'Spring offer', exact: true })).toBeVisible();
  // ...and every way out of that frame is closed.
  for (const avenue of ['parent', 'top', 'popup', 'storage', 'cookie', 'fetch', 'img'])
    await expect(body, `the design reached ${avenue}`).toHaveAttribute(`data-${avenue}`, 'blocked');
  await expect(page).toHaveTitle(title);
  expect(page.url()).toBe(address);
  expect(page.context().pages()).toHaveLength(1);
  // Every attempt above has settled, so anything it asked for has already been written down.
  expect(externals).toEqual([]);
  expect(tunnelsSince(tunnels).filter((target) => !browserOwn(target))).toEqual([]);

  // A design is laid out at the chosen width and scaled into the panel.
  await panel.getByRole('button', { name: 'Desktop', exact: true }).click();
  await expect(panel.getByText(/^1280 px at \d+%$/)).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('hostile-design.png'), animations: 'disabled' });
});

test('a design that sends its own frame elsewhere is taken down, not shown', async ({ page }) => {
  const project = await freshProject('Wandering page');
  await openConsole(page, project);
  await send(page, 'WANDER off somewhere');
  await chips(page, 'Design', 'Wandering page').click();
  const panel = pane(page);
  await expect(panel.getByText('This design tried to open another page, so it was stopped.')).toBeVisible();
  await expect(panel.locator('iframe[title="Design: Wandering page"]')).toHaveCount(0);
  await expect(panel.getByRole('button', { name: 'Load it again', exact: true })).toBeVisible();
});

test('a hostile picture and hostile diagram labels load nothing and run nothing', async ({ page, tunnels }, testInfo) => {
  const project = await freshProject('Shop sign');
  await openConsole(page, project);
  await send(page, 'PICTURE of the shop sign');
  await chips(page, 'Image', 'Shop sign').click();
  const panel = pane(page);
  const picture = panel.locator('iframe[title="Image: Shop sign"]');
  await expect(picture).toHaveAttribute('sandbox', '');
  await expect.poll(async () => (await stillFrame(page, picture)).elements).toContain('image');
  const sign = await stillFrame(page, picture);
  expect(sign.text).toContain('Linen Co.');
  // Its script is in the frame's document and never ran: nothing set the mark it writes.
  expect(sign.elements).toContain('script');
  expect(sign.root['data-ran']).toBeUndefined();
  await page.screenshot({ path: testInfo.outputPath('hostile-picture.png'), animations: 'disabled' });

  await send(page, 'LABEL with markup in it');
  await chips(page, 'Diagram', 'Hostile labels').click();
  const labels = panel.locator('iframe[title="Diagram: Hostile labels"]');
  const refused = panel.getByRole('group', { name: 'This diagram could not be drawn.' });
  await expect(labels.or(refused)).toBeAttached();
  if (await labels.count()) {
    // Drawn: the labels are text, and no element of their markup exists anywhere in the frame.
    const srcdoc = (await labels.getAttribute('srcdoc')) ?? '';
    expect(srcdoc).not.toMatch(/<(img|script|a|foreignObject)\b/i);
    expect(srcdoc).not.toMatch(/\son[a-z]+\s*=/i);
    await expect.poll(async () => (await stillFrame(page, labels)).elements).toContain('svg');
    const inside = await stillFrame(page, labels);
    for (const tag of ['img', 'image', 'script', 'a', 'foreignobject']) expect(inside.elements).not.toContain(tag);
    for (const word of ['Plain', 'Second', 'Third']) expect(inside.text).toContain(word);
  }
  // Nothing ran in the Console while Mermaid laid the labels out.
  expect(await page.evaluate(() => (window as { __owned?: unknown }).__owned)).toBeUndefined();
  expect(externals).toEqual([]);
  expect(tunnelsSince(tunnels).filter((target) => !browserOwn(target))).toEqual([]);
  await page.screenshot({ path: testInfo.outputPath('hostile-labels.png'), animations: 'disabled' });

  // The page survives: the picture opens again.
  await chips(page, 'Image', 'Shop sign').click();
  await expect(panel.getByRole('heading', { name: 'Shop sign', exact: true })).toBeVisible();
  await expect(picture).toHaveAttribute('srcdoc', /Linen Co\./);
});

test('live text holds an artifact back until its answer is saved', async ({ page }, testInfo) => {
  const project = await freshProject('Van route');
  await openConsole(page, project);
  await send(page, 'STREAM the van route');
  const live = page
    .locator('.transcript .turn.dio')
    .filter({ has: page.locator('.who .mono', { hasText: /^live$/ }) });
  await expect(live).toContainText('Here is the route.');
  await expect(live.getByRole('status')).toHaveText('Drawing a diagram…');
  // Nothing of the open fence is shown or drawn while it arrives.
  await expect(live).not.toContainText('flowchart');
  await expect(live).not.toContainText('Depot');
  await expect(live.locator('iframe, pre, code, .art-chip')).toHaveCount(0);
  expect(engine.holding()).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('live-preview-held.png'), animations: 'disabled' });

  engine.release();
  const chip = chips(page, 'Diagram', 'Van route');
  await expect(chip).toBeVisible();
  await expect(live).toHaveCount(0);
  await expect(page.locator('.transcript')).not.toContainText('Drawing a diagram…');
});

test('on the Diomedes page the panel opens beside the conversation, and says why it cannot save there', async ({ page }, testInfo) => {
  await freshProject('Home page');
  await page.goto(url);
  await expect(page.getByRole('heading', { name: 'Diomedes', exact: true })).toBeVisible();
  const box = page.getByRole('textbox', { name: 'Message Diomedes' });
  await box.fill('CHART of this week');
  await box.press('Enter');
  const chip = page.locator('.turn.dio').getByRole('button', { name: /^Chart\s+Weekly sends\b/ });
  await expect(chip).toBeVisible();
  await chip.click();
  const panel = pane(page);
  await expect(panel).toBeVisible();
  await expect(panel).toHaveClass(/\boverlay\b/);
  await expect(panel.getByRole('heading', { name: 'Weekly sends', exact: true })).toBeFocused();
  await expect(panel.getByRole('img', { name: /^Bar chart: Weekly sends\./ })).toBeVisible();
  // At this width the page makes room for the panel: nothing of the composer, Send included, is under it.
  const composerBox = await page.locator('.dio-screen .composer').boundingBox();
  const sendBox = await page.locator('.dio-screen .composer .send').boundingBox();
  const panelBox = await panel.boundingBox();
  expect(composerBox!.x + composerBox!.width).toBeLessThanOrEqual(panelBox!.x + 1);
  expect(sendBox!.x + sendBox!.width).toBeLessThanOrEqual(panelBox!.x + 1);
  // The conversation is about all projects, so there is no folder to save into. The button stays
  // a reachable control (aria-disabled, not disabled) and says why when a person presses it.
  const save = panel.getByRole('button', { name: 'Save to Files', exact: true });
  await expect(save).toHaveAttribute('aria-disabled', 'true');
  await save.focus();
  await page.keyboard.press('Enter');
  await expect(panel.locator('.art-status')).toHaveText(
    'This conversation is about all projects, so it has no folder to save into. Copy the source, or save from a project conversation.',
  );
  await page.screenshot({ path: testInfo.outputPath('home-panel.png'), animations: 'disabled' });
  await page.keyboard.press('Escape');
  await expect(panel).toHaveCount(0);
  await expect(chip).toBeFocused();
});
