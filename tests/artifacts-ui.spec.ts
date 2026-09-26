import { expect, test as base, type CDPSession, type Locator, type Page } from '@playwright/test';
import express from 'express';
import dgram from 'node:dgram';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../server/app';
import { testOnlySecretBox } from '../server/connection-secrets';
import { FRAME_CSP } from '../client/console/artifact-frame';
import {
  REFUSED_IMAGE,
  REFUSED_MATH_HERE,
  REFUSED_MATH_MARKUP,
  REFUSED_PARTICIPANT_DETAILS,
} from '../client/console/mermaid-render';
import { APP_CSP } from '../scripts/app-csp';
import type { UpdateStatusSnapshot } from '../shared/app-updates';
import type { DocumentContent, Project, ProjectState, Task } from '../shared/types';
import {
  ARTIFACT_ENGINE,
  ARTIFACT_MODEL,
  artifactEngine,
  artifactTransport,
  heldUpdate,
  PIXEL,
  probes,
  UPDATE_RECEIVED,
  UPDATE_SIZE,
  WEEKLY_VISUAL,
  type ArtifactEngine,
} from './fixtures/scripted-artifacts';
import { gateway, nectoviaAccounts } from './fixtures/nectovia-home';
import { shareAfter } from './fixtures/cloud-sharing-grant';

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
//
// Three more observers stand beside it (hostile review, 2026-09-23). WebRTC's ICE goes around every
// proxy and every Content-Security-Policy, so a UDP socket on 127.0.0.1 records any STUN request
// a frame makes, and the hostile design points its peer connection at it. Every request that
// reaches the spec's own server under /leak is written down, whichever frame made it. And the
// Console's own document reports each policy violation it sees: the built index.html carries the
// app's policy (scripts/app-csp.ts), and nothing the Console does may trip it.

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
/** The app update the UPDATE card reads: a newer release, and a download held part way. */
const update = heldUpdate();
let pageErrors: string[] = [];
let externals: string[] = [];
let dialogs: string[] = [];
/** Where this test's tunnels start in the worker's record. */
let tunnelMark = 0;
const tunnelsSince = (tunnels: Tunnels) => tunnels.opened.slice(tunnelMark);
/** Every UDP datagram that reached the STUN listener, and where this test's start. */
const stun: string[] = [];
let stunSocket: dgram.Socket | undefined;
let stunMark = 0;
/** Every request that reached the spec's server under /leak, and where this test's start. */
const leaks: string[] = [];
let leakMark = 0;
/** Every policy violation the Console's own document reported in this test. */
let violations: string[] = [];
/** Calls that went to a provider directly rather than through Nectovia's gateway. */
let direct = 0;

async function api<T>(route: string, method = 'GET', data?: unknown): Promise<T> {
  const response = await fetch(`${url}/api${route}`, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Diomedes-Client': '1' },
    body: data === undefined ? undefined : JSON.stringify(data),
  });
  if (!response.ok)
    throw new Error(`Artifacts fixture request ${route} failed (${response.status}): ${await response.text()}`);
  const value = (await response.json()) as T;
  await shareAfter(api, route, method, value);
  return value;
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
  stunSocket = dgram.createSocket('udp4');
  stunSocket.on('message', (message, from) => stun.push(`${message.length} bytes from ${from.address}:${from.port}`));
  await new Promise<void>((resolve) => stunSocket!.bind(0, '127.0.0.1', resolve));
  // A request under /leak is written down and answered with a line of plain text, so a frame that
  // followed a link there really does leave its srcdoc (and the Console never loads inside it).
  // The app answers everything else, once it exists.
  let answer: ((request: IncomingMessage, response: ServerResponse) => void) | null = null;
  server = createServer((request, response) => {
    if (request.url?.startsWith('/leak')) {
      leaks.push(`${request.method} ${request.url}`);
      response.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' }).end('leaked');
      return;
    }
    // The control's page: on this server like the Console, with no policy of any kind.
    if (request.url === '/control') {
      response
        .writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
        .end('<!doctype html><html><head><title>Control</title></head><body></body></html>');
      return;
    }
    if (answer) answer(request, response);
    else response.writeHead(503).end();
  });
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  url = `http://127.0.0.1:${port}`;
  probes.stun = `stun:127.0.0.1:${stunSocket.address().port}`;
  probes.leak = `${url}/leak`;
  // The Diomedes conversation answers on Nectovia, the company-managed route: the app signs the
  // faux seed's Business owner in at start (test mode) and reaches the real account service and
  // its real managed gateway, with the artifact script answering behind the gateway at the
  // provider boundary. The customer connects nothing.
  const { accounts } = await nectoviaAccounts(artifactTransport);
  app = await createApp({
    port,
    clientPort: port,
    dataDir: path.join(root, 'data'),
    projectRoot: path.join(root, 'projects'),
    engineService: engine.service,
    reviewerAdapter: null,
    secretBox: testOnlySecretBox(),
    // Nothing on this computer calls a provider directly, so this transport only counts.
    modelApiTransport: (async () => {
      direct += 1;
      throw new Error('No provider is called directly in this spec.');
    }) as typeof globalThis.fetch,
    accounts,
    // An installed Windows build, so the host's updater runs; its channel is the fixture's.
    updateOverrides: { platform: 'win32', packaged: true, installed: true, transport: update.transport },
  });
  const dist = path.resolve('dist');
  await fs.access(path.join(dist, 'index.html'));
  await expectFreshBundle(dist);
  app.use(express.static(dist));
  app.get('/{*path}', (_request, response) => response.sendFile(path.join(dist, 'index.html')));
  const handler = app;
  answer = (request, response) => void handler(request, response);
  await api('/ai/discover', 'POST', { consent: true });
  await api(`/ai/check/${ARTIFACT_ENGINE}`, 'POST', {});
  await api('/ai/select', 'POST', { engine: ARTIFACT_ENGINE, model: ARTIFACT_MODEL });
  // Project threads stay on Claude Code; the Diomedes conversation is Nectovia's (above).
});

test.afterAll(async () => {
  engine?.release();
  update.drop();
  await app?.locals.close?.();
  server?.closeAllConnections();
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  await new Promise<void>((resolve) => (stunSocket ? stunSocket.close(() => resolve()) : resolve()));
});

test.beforeEach(async ({ page, tunnels }) => {
  pageErrors = [];
  externals = [];
  dialogs = [];
  violations = [];
  tunnelMark = tunnels.opened.length;
  stunMark = stun.length;
  leakMark = leaks.length;
  // The Console's own document, and only it, reports each policy violation it sees. Frames
  // report theirs to themselves: a hostile artifact's refused fetches are its frame's business.
  await page.exposeBinding('__reportViolation', (_source, line: string) => violations.push(line));
  await page.addInitScript(() => {
    if (window !== window.top) return;
    document.addEventListener(
      'securitypolicyviolation',
      (event) =>
        (window as unknown as { __reportViolation(line: string): void }).__reportViolation(
          `${event.effectiveDirective} refused ${event.blockedURI || '(inline)'} at ${event.sourceFile || document.URL}:${event.lineNumber}`,
        ),
      true,
    );
  });
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
  expect(stun.slice(stunMark), 'No frame may send a STUN request: no script runs in any of them').toEqual([]);
  expect(leaks.slice(leakMark), 'No link in an artifact may reach the server').toEqual([]);
  expect(violations, "Nothing the Console does may trip its own Content-Security-Policy").toEqual([]);
  expect(dialogs, 'No script may open a dialog').toEqual([]);
  expect(pageErrors, 'The interface must not throw uncaught browser errors').toEqual([]);
});

/** A project of the test's own, with one thread, open in the Console. */
async function freshProject(name: string): Promise<Project> {
  const project = await api<Project>('/projects', 'POST', { name });
  await api(`/projects/${project.id}/threads`, 'POST', { name: `${name} thread`, mode: 'ask' });
  await onConsole(project);
  return project;
}

/** Settings that open the Console on this project, the way a person who finished onboarding has them. */
async function onConsole(project: Project): Promise<void> {
  await api('/settings', 'PUT', {
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

/**
 * Serves the Console's document without its policy, as a browser on the development server has
 * it, so what a frame's own sandbox, policy and markup do is tested with nothing behind them.
 */
async function withoutAppPolicy(page: Page): Promise<{ served: () => number; restore: () => Promise<void> }> {
  const consoleDocument = `${url}/`;
  let served = 0;
  await page.route(consoleDocument, async (route) => {
    const response = await route.fetch();
    const html = await response.text();
    const bare = html.replace(/<meta\b[^>]*http-equiv="Content-Security-Policy"[^>]*>/i, '');
    if (bare !== html) served += 1;
    await route.fulfill({ response, body: bare });
  });
  return { served: () => served, restore: () => page.unroute(consoleDocument) };
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
  documentURL?: string;
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
  /** Where the frame's document is, as the browser has it: about:srcdoc until something moves it. */
  url: string;
  /** Every element's tag name, lower case, in document order. */
  elements: string[];
  /** Every element with its attributes, shadow roots and nested frames included. */
  tags: Array<{ name: string; attributes: Record<string, string> }>;
  /** Every text node, joined by single spaces. */
  text: string;
  /** The attributes of the frame's <html> element. */
  root: Record<string, string>;
  /** The attributes of the frame's <body> element. */
  body: Record<string, string>;
}

function contentsOf(document: DomNode): FrameContents {
  const nodes = [...walk(document)];
  const html = nodes.find((node) => node.nodeType === 1 && node.localName === 'html');
  const body = nodes.find((node) => node.nodeType === 1 && node.localName === 'body');
  const elements = nodes.filter((node) => node.nodeType === 1);
  return {
    url: document.documentURL ?? '',
    elements: elements.map((node) => (node.localName || node.nodeName).toLowerCase()),
    tags: elements.map((node) => ({ name: (node.localName || node.nodeName).toLowerCase(), attributes: attributesOf(node) })),
    text: nodes
      .filter((node) => node.nodeType === 3)
      .map((node) => node.nodeValue ?? '')
      .join(' ')
      .replace(/\s+/g, ' '),
    root: html ? attributesOf(html) : {},
    body: body ? attributesOf(body) : {},
  };
}

/**
 * What a `sandbox=""` frame holds: every artifact frame, a design's included. Nothing can run in
 * one, Playwright's own injected script included, so it is read the way DevTools reads it: as the
 * DOM tree, with nothing run inside. The frame may live in its own process (Chromium isolates
 * sandboxed frames), so its own session is tried first; otherwise its document is part of the
 * page's tree.
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
  return { url: '', elements: [], tags: [], text: '', root: {}, body: {} };
}

/**
 * Where a frame's document is now, read from the document itself: about:srcdoc until something
 * moves it. (Playwright's own Frame.url() is empty for a sandboxed srcdoc frame.) Null when the
 * frame is gone: the panel takes down a frame that loads twice.
 */
async function frameUrl(page: Page, frame: Locator): Promise<string | null> {
  if ((await frame.count()) === 0) return null;
  return (await stillFrame(page, frame)).url || null;
}

/**
 * Time for anything a frame would do once it has loaded: its handlers, its script's timers, and
 * the ICE gathering behind a STUN request (the control sees one well inside this).
 */
const SETTLE_MS = 1_500;

const STOPPED = 'This design tried to open another page, so it was stopped.';

/**
 * Every way out a frame's markup still holds: a link a person can follow, an attribute that sends
 * a form, a ping or a target, a <base>, a refresh, or an animation that would write a link back.
 */
function waysOut(contents: FrameContents): string[] {
  const found: string[] = [];
  for (const { name, attributes } of contents.tags) {
    for (const attribute of Object.keys(attributes)) {
      const local = attribute.toLowerCase().split(':').at(-1) ?? '';
      if ((local === 'href' && (name === 'a' || name === 'area')) || ['action', 'formaction', 'ping', 'target'].includes(local))
        found.push(`<${name} ${attribute}="${attributes[attribute]}">`);
    }
    if (name === 'base') found.push('<base>');
    if (name === 'meta' && /refresh/i.test(attributes['http-equiv'] ?? '')) found.push('<meta http-equiv="refresh">');
    const writes = (attributes.attributeName ?? attributes.attributename ?? '').toLowerCase();
    if (/(^|:)href$/.test(writes.trim())) found.push(`<${name} attributeName="${writes}">`);
  }
  return found;
}

/** Which delivery-check version a diagram frame is drawing, read from its srcdoc. */
async function drawnVersion(frame: Locator): Promise<string> {
  const srcdoc = await frame.getAttribute('srcdoc', { timeout: 1_000 }).catch(() => null);
  if (!srcdoc) return 'drawing';
  return srcdoc.includes('7am') ? 'v2' : 'v1';
}

// ---- the tests --------------------------------------------------------------------------------

test('the observers see what a frame without a policy does: the control for every "nothing" below', async ({ page, tunnels }) => {
  // "Nothing was requested" is only worth something if a request would have been seen. Frames of
  // the kind the panel draws, with no policy in them and one with its scripts on, are seen asking
  // for files, sending STUN requests and following a link to the spec's server, and a script's
  // mark is found by the same DOM read the tests below use to say that none ran. They are made on
  // a page of the spec's own server with no policy: a srcdoc frame takes its parent's policy with
  // it, and the Console now has one.
  await page.goto(`${url}/control`);
  await page.evaluate(
    ({ stunTarget, leakTarget }) => {
      const scripted = document.createElement('iframe');
      scripted.title = 'Control: script';
      scripted.setAttribute('sandbox', 'allow-scripts');
      scripted.srcdoc =
        '<img src="https://control-img.example.com/x.png" alt=""><script>document.documentElement.setAttribute("data-ran", "yes"); fetch("https://control-fetch.example.com/x").catch(() => undefined);' +
        `const peer = new RTCPeerConnection({ iceServers: [{ urls: "${stunTarget}" }] }); peer.createDataChannel("control"); peer.createOffer().then((offer) => peer.setLocalDescription(offer)).catch(() => undefined);</script>`;
      const still = document.createElement('iframe');
      still.title = 'Control: picture';
      still.setAttribute('sandbox', '');
      still.srcdoc =
        '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><image href="https://control-still.example.com/x.png" width="10" height="10"/></svg>';
      const leaving = document.createElement('iframe');
      leaving.title = 'Control: link';
      leaving.setAttribute('sandbox', 'allow-scripts');
      leaving.srcdoc = `<script>location.href = "${leakTarget}?control=frame";</script>`;
      document.body.append(scripted, still, leaving);
    },
    { stunTarget: probes.stun, leakTarget: probes.leak },
  );
  // Sandboxed frames run out of process, where the proxy is what sees them and what stops them.
  await expect
    .poll(() => [...new Set(tunnelsSince(tunnels).filter((target) => !browserOwn(target)))].sort())
    .toEqual(['control-fetch.example.com:443', 'control-img.example.com:443', 'control-still.example.com:443']);
  await expect
    .poll(async () => (await stillFrame(page, page.locator('iframe[title="Control: script"]'))).root['data-ran'])
    .toBe('yes');
  // WebRTC goes around the proxy: a frame that runs script reaches the STUN listener directly.
  await expect.poll(() => stun.length - stunMark, { message: 'a STUN request from the scripted frame' }).toBeGreaterThan(0);
  // A frame that goes to the spec's server is written down there.
  await expect.poll(() => leaks.slice(leakMark)).toEqual(['GET /leak?control=frame']);
  // A policy this page is under, and one thing it refuses: the violation reaches the spec.
  await page.evaluate(() => {
    const policy = document.createElement('meta');
    policy.httpEquiv = 'Content-Security-Policy';
    policy.content = "img-src 'none'";
    document.head.append(policy);
    new Image().src = 'data:image/gif;base64,R0lGODlhAQABAAAAACw=';
  });
  await expect.poll(() => violations.map((line) => line.split(' ')[0])).toEqual(['img-src']);
  // The control's own traffic was the point; the checks after it start from here. Its frames go
  // first, so the peer connection stops sending STUN retransmissions.
  await page.goto('about:blank');
  await page.waitForTimeout(500);
  externals = [];
  tunnelMark = tunnels.opened.length;
  stunMark = stun.length;
  leakMark = leaks.length;
  violations = [];
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
    srcdoc.startsWith(`<!doctype html><meta http-equiv="Content-Security-Policy" content="${FRAME_CSP}">`),
  ).toBe(true);
  expect(srcdoc).toContain('<svg');
  // The scan of what Mermaid drew keeps its arrowheads: a same-document fragment is not a fetch.
  expect(srcdoc).toMatch(/marker-end="url\(#[^)"]+\)"/);
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

/** What the bar chart in the CHART and VISUALS answers is called, as a screen reader hears it. */
const WEEKLY = 'Bar chart: Weekly sends. 5 points, Mon to Fri. Sent from 80 to 150; Replies from 7 to 20.';

/**
 * The quiet control under a visual in a saved turn: "Open in panel", or "In panel" while the panel
 * shows it, then the visual's title for a screen reader.
 */
const panelControl = (scope: Locator, title: string, current = false) =>
  scope.getByRole('button', {
    name: new RegExp(`^${current ? 'In panel' : 'Open in panel'}\\s*:\\s*${escaped(title)}$`),
  });

/** A colour as the page computes it, so a token can be compared with a drawn fill. */
const computedColour = (page: Page, value: string) =>
  page.evaluate((colour) => {
    const probe = document.createElement('i');
    probe.style.color = colour;
    document.body.append(probe);
    const found = getComputedStyle(probe).color;
    probe.remove();
    return found;
  }, value);

test('a visual is drawn in its turn and opens in the panel as a visual, saved to Files as its JSON', async ({ page }, testInfo) => {
  const project = await freshProject('Weekly numbers');
  await openConsole(page, project);
  await send(page, 'CHART of this week');
  const turn = page.locator('.transcript .turn.dio').last();
  // Drawn where the reply put it, not behind a chip, and none of its JSON is shown.
  await expect(turn.getByRole('img', { name: WEEKLY, exact: true })).toBeVisible();
  await expect(turn.locator('svg.iv-svg rect.iv-mark')).toHaveCount(10);
  await expect(turn.locator('.art-chip')).toHaveCount(0);
  await expect(turn).not.toContainText('"kind"');

  await panelControl(turn, 'Weekly sends').click();
  const panel = pane(page);
  await expect(panel.getByRole('heading', { name: 'Weekly sends', exact: true })).toBeFocused();
  await expect(panel.locator('.art-kind')).toHaveText('Visual');
  await expect(panel.getByRole('img', { name: WEEKLY, exact: true })).toBeVisible();
  await expect(panel.locator('svg.iv-svg rect.iv-mark')).toHaveCount(10);
  // The panel draws the chart at its own width, so its labels keep their size: the drawing is
  // as wide as the panel's body, not a 640-wide picture scaled down into it.
  // (Polled: the panel measures its body after the first paint, then draws again at that width.)
  await expect
    .poll(async () => {
      const drawnWidth = await panel.locator('svg.iv-svg').evaluate((svg) => (svg as SVGSVGElement).viewBox.baseVal.width);
      const bodyWidth = (await panel.locator('.art-visual').boundingBox())!.width;
      return Math.abs(drawnWidth - bodyWidth);
    })
    .toBeLessThanOrEqual(2);
  // The control in the turn keeps a chip's state while the panel shows its visual.
  await expect(panelControl(turn, 'Weekly sends', true)).toHaveAttribute('aria-current', 'true');

  // Its source is the JSON the reply wrote, and Save to Files writes that JSON as a .json file.
  await panel.getByRole('button', { name: 'Source', exact: true }).click();
  await expect(panel.locator('pre.art-source')).toContainText('"kind":"bar"');
  const saved = 'Saved artifacts/Weekly sends.json';
  await panel.getByRole('button', { name: 'Save to Files', exact: true }).click();
  await expect(panel.locator('.art-status')).toContainText(`Saved to Files as ${saved}.`);
  const file = await api<DocumentContent>(`/projects/${project.id}/documents/read?path=${encodeURIComponent(saved)}`);
  expect(JSON.parse(file.text)).toEqual(WEEKLY_VISUAL);

  // The saved file opens in the panel from Files, drawn from the file.
  await panel.getByRole('button', { name: 'Show in Files', exact: true }).click();
  const files = filesPane(page);
  await files.getByRole('button', { name: 'Open in panel', exact: true }).click();
  await expect(panel.getByRole('heading', { name: 'Weekly sends', exact: true })).toBeFocused();
  await panel.getByRole('button', { name: 'Rendered', exact: true }).click();
  await expect(panel.getByRole('img', { name: WEEKLY, exact: true })).toBeVisible();
  // It is the file's visual, not the turn's, so the turn no longer says it is in the panel.
  await expect(panelControl(turn, 'Weekly sends')).not.toHaveAttribute('aria-current', 'true');
  await page.screenshot({ path: testInfo.outputPath('visual-from-files.png'), animations: 'disabled' });
});

test('a retired ```chart fence reads as the code block it is: no chip, no drawing', async ({ page }) => {
  const project = await freshProject('Old chart');
  await openConsole(page, project);
  await send(page, 'LEGACY chart from before');
  const turn = page.locator('.transcript .turn.dio').last();
  await expect(turn).toContainText('The chart from before.');
  await expect(turn.locator('pre code')).toContainText('"type":"bar"');
  await expect(turn.locator('figure.iv, .art-chip, button.iv-open')).toHaveCount(0);
});

test('a bar chart, key figures and a reply\'s own progress in one turn, under scheme nectovia at 1440 wide', async ({ page }, testInfo) => {
  // Tall enough that the whole turn, three visuals, is on screen at once.
  await page.setViewportSize({ width: 1440, height: 1300 });
  const project = await freshProject('Week in visuals');
  await openConsole(page, project);
  await expect(page.locator('html')).toHaveAttribute('data-package', 'nectovia');
  expect(page.viewportSize()?.width).toBe(1440);
  await send(page, 'VISUALS of this week');
  const turn = page.locator('.transcript .turn.dio').last();
  await expect(turn.locator('figure.iv')).toHaveCount(3);

  // The bar chart, its series in the palette: lead cyan, then the violet trail.
  const chart = turn.getByRole('img', { name: WEEKLY, exact: true });
  await expect(chart).toBeVisible();
  const fillOf = (series: number) =>
    chart.locator(`g.iv-s${series} rect.iv-mark`).first().evaluate((mark) => getComputedStyle(mark).fill);
  expect(await fillOf(0)).toBe(await computedColour(page, 'var(--seam-lead)'));
  expect(await fillOf(1)).toBe(await computedColour(page, 'var(--seam-trail)'));

  // The key figures, as the reply gave them.
  const figures = turn.locator('figure.iv-stat .iv-stat');
  await expect(figures).toHaveCount(3);
  await expect(figures.nth(0)).toContainText('575');
  await expect(figures.nth(2)).toContainText('11%');

  // The reply's progress is a share in its own words: one outlined track marked as the reply's,
  // never segments, never a count the reply did not write, and nothing on it moves.
  const progress = turn.getByRole('progressbar', { name: 'Follow-ups drafted', exact: true });
  await expect(progress).toHaveAttribute('aria-valuenow', '40');
  await expect(progress).toHaveAttribute('aria-valuetext', '40%, 4 of the 10 I planned');
  const gauge = turn.locator('.seg-bar[data-source="reply"]');
  await expect(gauge).toHaveCount(1);
  await expect(gauge.locator('span.seg')).toHaveCount(0);
  await expect(gauge.locator('.seg-caption')).toHaveText('Follow-ups drafted · 4 of the 10 I planned');
  expect(await gauge.locator('.seg-track').evaluate((track) => getComputedStyle(track).borderTopStyle)).toBe('solid');
  expect(await gauge.locator('.seg-fill').evaluate((fill) => getComputedStyle(fill).transitionDuration)).toBe('0s');

  // Every valid visual can go to the panel; the progress takes its kind's name.
  await expect(turn.locator('button.iv-open')).toHaveText([
    'Open in panel: Weekly sends',
    'Open in panel: This week',
    'Open in panel: Progress',
  ]);
  for (const title of ['Weekly sends', 'This week', 'Progress']) await expect(panelControl(turn, title)).toBeVisible();
  await turn.locator('.iv-open-row').last().scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath('visuals-in-turn.png'), animations: 'disabled' });

  // The same bar chart, opened in the panel.
  await panelControl(turn, 'Weekly sends').click();
  const panel = pane(page);
  await expect(panel.getByRole('heading', { name: 'Weekly sends', exact: true })).toBeFocused();
  await expect(panel.getByRole('img', { name: WEEKLY, exact: true })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('bar-chart-in-panel.png'), animations: 'disabled' });
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
  // Drawn by the one visual renderer, from a spec the visual schema accepted: one bar a region.
  const chart = panel.locator('figure.iv-bar');
  await expect(chart.getByRole('img', { name: /^Bar chart: Sent by Region\./ })).toBeVisible();
  await expect(chart.locator('.iv-title')).toHaveText('Sent by Region');
  await expect(chart.locator('rect.iv-mark')).toHaveCount(3);
  await expect(panel.getByRole('button', { name: 'Hide chart', exact: true })).toHaveAttribute('aria-expanded', 'true');
  await panel.getByRole('combobox', { name: 'Column' }).selectOption({ label: 'Replies' });
  await expect(panel.getByRole('img', { name: /^Bar chart: Replies by Region\./ })).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('data-package', 'nectovia');
  await chart.scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath('table-charted.png'), animations: 'disabled' });
});

test('a hostile design runs nothing: no script, no handler, no javascript: URL, no WebRTC', async ({ page, tunnels }, testInfo) => {
  const project = await freshProject('Offer page');
  // First with nothing behind the frame's own sandbox and policy, as a browser on the development
  // server has the Console. (The app's policy, which a srcdoc frame inherits, refuses inline script
  // by itself, so it would hide a sandbox that let script run.)
  const bare = await withoutAppPolicy(page);
  await openConsole(page, project);
  expect(bare.served(), 'the served document had a policy to take out').toBeGreaterThan(0);
  await expect(page.locator('meta[http-equiv="Content-Security-Policy"]')).toHaveCount(0);
  const title = await page.title();
  const address = page.url();
  await send(page, 'DESIGN the offer page');
  const panel = pane(page);
  const frame = panel.locator('iframe[title="Design: Spring offer"]');
  // The checks are soft, so a frame that lets something run reports everything that ran, in both
  // phases, rather than only the first thing found.
  const expectNothingRan = async () => {
    await chips(page, 'Design', 'Spring offer').click();
    await expect.soft(frame).toHaveAttribute('sandbox', '');
    await expect.soft(frame).toHaveAttribute('referrerpolicy', 'no-referrer');
    const srcdoc = (await frame.getAttribute('srcdoc')) ?? '';
    expect
      .soft(srcdoc.startsWith(`<!doctype html><meta http-equiv="Content-Security-Policy" content="${FRAME_CSP}">`))
      .toBe(true);
    // Its <link>s are gone, and so is its nested frame's srcdoc, which held another: Chromium does
    // not hold dns-prefetch or preconnect to the frame's policy, and no proxy sees a DNS lookup.
    expect.soft(srcdoc).not.toContain('<link');
    expect.soft(srcdoc).not.toMatch(/\ssrcdoc=/);

    // The page is drawn, and everything it would run is in its document as written...
    await expect.poll(async () => (await stillFrame(page, frame)).text).toContain('Ten percent off every order this week.');
    const drawn = await stillFrame(page, frame);
    expect(drawn.text).toContain('Spring offer');
    expect(drawn.elements).toContain('script');
    expect(drawn.body.onload).toContain('dataset.onload');
    expect(drawn.tags.filter((tag) => tag.name === 'img' && tag.attributes.onerror)).toHaveLength(1);
    expect(drawn.tags.find((tag) => tag.name === 'iframe')?.attributes.src).toMatch(/^javascript:/);

    // ...and, given time to do all of it, none of it ran. The inline script would have set `ran`,
    // then a mark for each way out it tried (parent, top, popup, storage, cookie, fetch) and one for
    // the WebRTC connection it built (`rtc`); the body's onload, the images' onload and onerror, and
    // the nested frame's javascript: URL each set one of their own.
    await page.waitForTimeout(SETTLE_MS);
    const settled = await stillFrame(page, frame);
    const marks = ['ran', 'onload', 'img', 'pixel', 'js', 'rtc', 'parent', 'top', 'popup', 'storage', 'cookie', 'fetch'];
    expect
      .soft(
        marks.filter((mark) => settled.body[`data-${mark}`] !== undefined).map((mark) => `${mark}=${settled.body[`data-${mark}`]}`),
        'marks left by something in the design that ran',
      )
      .toEqual([]);
    // No STUN request reached the listener its peer connection named.
    expect.soft(stun.slice(stunMark), 'STUN requests from the design').toEqual([]);
    await expect(page).toHaveTitle(title);
    expect(page.url()).toBe(address);
    expect(page.context().pages()).toHaveLength(1);
    expect(externals).toEqual([]);
    expect(tunnelsSince(tunnels).filter((target) => !browserOwn(target))).toEqual([]);
  };
  await expectNothingRan();

  // Then as the built app is served, with its policy in force as well.
  await bare.restore();
  await openConsole(page, project);
  await expect(page.locator('meta[http-equiv="Content-Security-Policy"]')).toHaveAttribute('content', APP_CSP);
  await expectNothingRan();

  // A design is laid out at the chosen width and scaled into the panel.
  await panel.getByRole('button', { name: 'Desktop', exact: true }).click();
  await expect(panel.getByText(/^1280 px at \d+%$/)).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('hostile-design.png'), animations: 'disabled' });
});

test('a design whose script would send its frame elsewhere stays put, and a frame that loads twice is taken down', async ({ page }) => {
  const project = await freshProject('Wandering page');
  // Without the app's policy, which would refuse the inline script by itself: the sandbox alone
  // keeps it from running.
  const bare = await withoutAppPolicy(page);
  await openConsole(page, project);
  expect(bare.served(), 'the served document had a policy to take out').toBeGreaterThan(0);
  await send(page, 'WANDER off somewhere');
  await chips(page, 'Design', 'Wandering page').click();
  const panel = pane(page);
  const frame = panel.locator('iframe[title="Design: Wandering page"]');
  await expect.poll(async () => (await stillFrame(page, frame)).text).toContain('This page leaves.');
  // Its script would have replaced the page after 50 ms. It never runs, so the frame stays.
  await page.waitForTimeout(SETTLE_MS);
  expect(await frameUrl(page, frame)).toBe('about:srcdoc');
  await expect(frame).toHaveCount(1);
  await expect(panel.getByText(STOPPED)).toHaveCount(0);

  // Should a design's frame load a second time anyway, however that came about, the panel takes it
  // down rather than show what it loaded. Here the spec loads it again from outside.
  await frame.evaluate((element: HTMLIFrameElement) => {
    element.srcdoc = `${element.srcdoc} `;
  });
  await expect(panel.getByText(STOPPED)).toBeVisible();
  await expect(frame).toHaveCount(0);
  await panel.getByRole('button', { name: 'Load it again', exact: true }).click();
  await expect(frame).toHaveCount(1);
  await expect.poll(async () => (await stillFrame(page, frame)).text).toContain('This page leaves.');
});

test('a link in a design goes nowhere: a click sends nothing, with the app policy or without it', async ({ page }, testInfo) => {
  const project = await freshProject('Price list');
  // First as a browser on the development server has the Console, with no policy of its own: only
  // the links' removal stands between a click and the spec's server.
  const bare = await withoutAppPolicy(page);
  await openConsole(page, project);
  expect(bare.served(), 'the served document had a policy to take out').toBeGreaterThan(0);
  await expect(page.locator('meta[http-equiv="Content-Security-Policy"]')).toHaveCount(0);
  await send(page, 'LINK the price list');

  const panel = pane(page);
  const frame = panel.locator('iframe[title="Design: Price list"]');
  // The checks are soft, so a link that survives is also clicked, and what the click did is
  // reported in both phases, rather than only the markup that let it.
  const clickTheLink = async () => {
    await chips(page, 'Design', 'Price list').click();
    await expect.soft(frame).toHaveAttribute('sandbox', '');
    await expect.poll(async () => (await stillFrame(page, frame)).text).toContain('Open the price list');
    // Every link's text is still there, and nothing in the frame leads anywhere.
    const list = await stillFrame(page, frame);
    for (const words of ['Open the price list', 'Chart link', 'Animated link', 'Send the order', 'Shadow link'])
      expect(list.text).toContain(words);
    expect.soft(waysOut(list), 'ways out of the frame left in its markup').toEqual([]);
    expect.soft(await frame.getAttribute('srcdoc')).not.toContain('/leak');
    // A person clicks the page's big link.
    await frame.scrollIntoViewIfNeeded();
    const box = await frame.boundingBox();
    expect(box).not.toBeNull();
    const before = leaks.length;
    await page.mouse.click(box!.x + 60, box!.y + 60);
    await page.waitForTimeout(SETTLE_MS);
    expect.soft(leaks.slice(before), 'requests the click sent to the spec server').toEqual([]);
    expect.soft(await frameUrl(page, frame)).toBe('about:srcdoc');
    await expect.soft(panel.getByText(STOPPED)).toHaveCount(0);
  };
  await clickTheLink();
  await page.screenshot({ path: testInfo.outputPath('linked-design.png'), animations: 'disabled' });

  // Then as the built app is served, its policy in force: a live link would now also be refused
  // there, and the refusal reported.
  await bare.restore();
  await openConsole(page, project);
  await expect(page.locator('meta[http-equiv="Content-Security-Policy"]')).toHaveAttribute('content', APP_CSP);
  await clickTheLink();
  // Taking the links out means reading the design in the Console's own document, with DOMParser,
  // which runs and loads nothing. Its <base> is read there too, and the app's policy refuses it
  // (`base-uri 'none'`) and says so (Chromium reports it once with its address and once without):
  // the policy doing its job on the model's markup. Those reports are expected here; no other is.
  const expected = new RegExp(`^base-uri refused (${escaped(probes.leak)}/base/|\\(inline\\)) at `);
  expect(violations.filter((line) => !expected.test(line))).toEqual([]);
  violations = [];
});

test('the Console runs under its own policy, and nothing on its main surfaces trips it', async ({ page }, testInfo) => {
  // Every test in this file fails on a violation the Console's document reports (afterEach), so
  // each surface they use is covered already: a thread, the artifact panel, Files beside it, and
  // the conversation on the Nectovia page. This one walks the rest.
  const project = await freshProject('Policy walk');
  await page.goto(url);
  const policy = page.locator('head > meta[http-equiv="Content-Security-Policy"]');
  await expect(policy).toHaveAttribute('content', APP_CSP);
  // First in the head, so it is in force before anything else in the document is read.
  expect(await page.evaluate(() => document.head.firstElementChild?.getAttribute('http-equiv'))).toBe(
    'Content-Security-Policy',
  );
  // Home: the Nectovia page.
  await expect(page.getByRole('heading', { name: 'Nectovia', exact: true })).toBeVisible();

  // A thread with a diagram and an ordinary design in the panel.
  await page.getByRole('button', { name: project.name, exact: true }).click();
  await expect(composer(page)).toBeVisible();
  await send(page, 'HOURS for the shop');
  await chips(page, 'Design', 'Opening hours').click();
  const panel = pane(page);
  const hours = panel.locator('iframe[title="Design: Opening hours"]');
  await expect.poll(async () => (await stillFrame(page, hours)).text).toContain('Monday to Friday');
  await send(page, 'DIAGRAM of the delivery check');
  await chips(page, 'Diagram', 'Delivery check').click();
  await expect.poll(async () => (await stillFrame(page, panel.locator('iframe[title="Diagram: Delivery check"]'))).elements).toContain('svg');

  // Files: the saved artifact's preview, rendered and raw.
  await panel.getByRole('button', { name: 'Save to Files', exact: true }).click();
  await expect(panel.locator('.art-status')).toContainText('Saved to Files as');
  await panel.getByRole('button', { name: 'Show in Files', exact: true }).click();
  const files = filesPane(page);
  await expect(files).toBeVisible();
  await expect(files.getByRole('button', { name: 'Open in panel', exact: true })).toBeVisible();
  await files.getByRole('button', { name: 'Raw', exact: true }).click();
  await expect(files.locator('pre.files-raw')).toContainText('flowchart TD');

  // Settings, every section this build offers.
  await page.getByRole('button', { name: 'Settings', exact: true }).first().click();
  const rail = page.getByRole('navigation', { name: 'Settings', exact: true });
  const names = (await rail.getByRole('button').allTextContents()).map((name) => name.trim());
  expect(names).toContain('Appearance');
  for (const name of names) {
    await rail.getByRole('button', { name, exact: true }).click();
    await expect(page.getByRole('heading', { level: 1, name, exact: true })).toBeVisible();
  }
  // The Design Center, from its section. The Console offers it (this project's settings put the
  // person on the Console), and no other spec opens it under the built app's policy.
  expect(names).toContain('Design Center');
  await rail.getByRole('button', { name: 'Design Center', exact: true }).click();
  await page.getByRole('button', { name: 'Open Design Center' }).click();
  await expect(page.locator('.design-center')).toBeVisible();
  await expect(page.locator('.dc-stage')).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('design-center-under-policy.png'), animations: 'disabled' });
  await page.locator('.design-center').getByRole('button', { name: 'Close', exact: true }).click();
  await expect(page.locator('.design-center')).toHaveCount(0);
  // Anything reported late (a font, a picture) has arrived by now.
  await page.waitForTimeout(500);
  expect(violations).toEqual([]);
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
  // Its links keep their words and lose their way out, xlink:href included.
  expect(sign.text).toContain('Since 1998');
  expect(waysOut(sign)).toEqual([]);
  expect(await picture.getAttribute('srcdoc')).not.toContain('/leak');
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

// ---- Mermaid math and pictures (artifacts v2, E1) ---------------------------------------------
//
// Math is drawn as MathML, and only where the page carries the app's policy: the built index.html
// has one (scripts/app-csp.ts), the development server has none. A picture is drawn only when the
// diagram carries it as a data:image URL. Everything else is refused before Mermaid lays the
// diagram out in the Console's own document.

/** Every request the Console's document makes for a local document read, from now on. */
function documentReads(page: Page): string[] {
  const reads: string[] = [];
  page.on('request', (request) => {
    if (request.url().includes('/documents/read')) reads.push(request.url());
  });
  return reads;
}

const refusedDiagram = (panel: Locator) =>
  panel.getByRole('group', { name: 'This diagram could not be drawn.', exact: true }).locator('.art-error-problem');

test('math in a diagram is drawn as MathML on the built Console, and nothing is fetched for it', async ({ page }, testInfo) => {
  const project = await freshProject('Price formula');
  await openConsole(page, project);
  // What turns math on: the policy the build writes first in the head.
  await expect(page.locator('head > meta[http-equiv="Content-Security-Policy"]')).toHaveAttribute('content', APP_CSP);
  const reads = documentReads(page);
  await send(page, 'MATH for the monthly price');
  await chips(page, 'Diagram', 'Price formula').click();
  const panel = pane(page);
  const frame = panel.locator('iframe[title="Diagram: Price formula"]');
  await expect(frame).toHaveAttribute('sandbox', '');
  await expect.poll(async () => (await stillFrame(page, frame)).elements).toContain('math');
  const drawn = await stillFrame(page, frame);
  // Both labels are MathML: a product with its brackets, and a fraction.
  expect(drawn.elements.filter((name) => name === 'math')).toHaveLength(2);
  for (const name of ['mfrac', 'mi', 'mn', 'mo']) expect(drawn.elements).toContain(name);
  // MathML only: no KaTeX HTML (it would need KaTeX's stylesheet and fonts), no TeX source left
  // in an annotation, and nothing that links, loads or runs.
  const srcdoc = (await frame.getAttribute('srcdoc')) ?? '';
  expect(srcdoc).not.toContain('katex-html');
  for (const name of ['annotation', 'semantics', 'mglyph', 'a', 'img', 'image', 'script'])
    expect(drawn.elements).not.toContain(name);
  const linking = drawn.tags.flatMap(({ name, attributes }) =>
    Object.keys(attributes)
      .filter((attribute) => /(^|:)(href|src)$/i.test(attribute))
      .map((attribute) => `<${name} ${attribute}>`),
  );
  expect(linking).toEqual([]);
  expect(drawn.text).toContain('Monthly price');
  expect(reads).toEqual([]);
  await page.screenshot({ path: testInfo.outputPath('math-in-panel.png'), animations: 'disabled' });
});

test('math beside markup, and a picture from a link, are refused before Mermaid draws them', async ({ page }) => {
  const project = await freshProject('Formula checks');
  // A document of this project, read from the Console's own origin, which its policy allows.
  await api(`/projects/${project.id}/documents/create`, 'POST', { path: 'Notes.md', text: 'Private notes.\n' });
  probes.read = `/api/projects/${project.id}/documents/read?path=Notes.md`;
  await openConsole(page, project);
  const reads = documentReads(page);
  const panel = pane(page);

  await send(page, 'MIXED math and markup');
  await chips(page, 'Diagram', 'Formula with markup').click();
  await expect(refusedDiagram(panel)).toHaveText(REFUSED_MATH_MARKUP);
  await expect(panel.locator('iframe')).toHaveCount(0);

  await send(page, 'REMOTE logo');
  await chips(page, 'Diagram', 'Linked logo').click();
  await expect(refusedDiagram(panel)).toHaveText(REFUSED_IMAGE);
  await expect(panel.locator('iframe')).toHaveCount(0);

  // Nothing asked for the document, from the Console's document or from anywhere else.
  await page.waitForTimeout(SETTLE_MS);
  expect(reads).toEqual([]);
});

test("a sequence diagram that gives a participant a picture from a link is refused, and nothing asks for it", async ({ page }) => {
  const project = await freshProject('Courier desk');
  // A document of this project, read from the Console's own origin, which its policy allows.
  await api(`/projects/${project.id}/documents/create`, 'POST', { path: 'Notes.md', text: 'Private notes.\n' });
  probes.read = `/api/projects/${project.id}/documents/read?path=Notes.md`;
  await openConsole(page, project);
  const reads = documentReads(page);
  const panel = pane(page);
  await send(page, 'ICON for the parcel handoff');
  await chips(page, 'Diagram', 'Parcel handoff').click();
  // Whichever comes, the refusal or a drawing, then anything the diagram asked for on the way.
  await expect(refusedDiagram(panel).or(panel.locator('iframe'))).toHaveCount(1);
  await page.waitForTimeout(SETTLE_MS);
  expect(reads).toEqual([]);
  await expect(refusedDiagram(panel)).toHaveText(REFUSED_PARTICIPANT_DETAILS);
  await expect(panel.locator('iframe')).toHaveCount(0);
});

test('a picture written into a diagram as a data:image URL is drawn in its frame', async ({ page }) => {
  const project = await freshProject('Shop logo');
  await openConsole(page, project);
  await send(page, 'PHOTO of the shop logo');
  await chips(page, 'Diagram', 'Shop logo').click();
  const frame = pane(page).locator('iframe[title="Diagram: Shop logo"]');
  await expect(frame).toHaveAttribute('sandbox', '');
  await expect.poll(async () => (await stillFrame(page, frame)).elements).toContain('image');
  const drawn = await stillFrame(page, frame);
  expect(drawn.tags.filter((tag) => tag.name === 'image').map((tag) => tag.attributes.href)).toEqual([PIXEL]);
  for (const word of ['Logo', 'Shop front']) expect(drawn.text).toContain(word);
});

test('a page without the app policy draws no math: the policy in the page is the signal', async ({ page }) => {
  const bare = await withoutAppPolicy(page);
  const project = await freshProject('Formula without policy');
  await openConsole(page, project);
  expect(bare.served()).toBeGreaterThan(0);
  await expect(page.locator('head > meta[http-equiv="Content-Security-Policy"]')).toHaveCount(0);
  await send(page, 'MATH for the monthly price');
  await chips(page, 'Diagram', 'Price formula').click();
  const panel = pane(page);
  await expect(refusedDiagram(panel)).toHaveText(REFUSED_MATH_HERE);
  await expect(panel.locator('iframe')).toHaveCount(0);
  await bare.restore();
});

test('the development server carries no policy, so math stays off there', async ({ page, baseURL }) => {
  // The suite's own Vite development server (playwright.config.ts, webServer), not this spec's
  // built bundle. Its index.html has no policy: the plugin that writes one applies at build only.
  await page.goto(baseURL!);
  await expect(page.locator('head > meta[http-equiv="Content-Security-Policy"]')).toHaveCount(0);
  // The Console's own renderer, as the development server serves it.
  await page.addScriptTag({
    type: 'module',
    content: [
      "import { renderDiagram } from '/client/console/mermaid-render.ts';",
      "import { NECTOVIA_TOKENS } from '/client/console/artifact-frame.ts';",
      "window.__drawn = renderDiagram('flowchart LR\\n  A[\"$$x^2$$\"] --> B[Price]', NECTOVIA_TOKENS);",
    ].join('\n'),
  });
  await page.waitForFunction(() => '__drawn' in window);
  const drawn = await page.evaluate(() => (window as unknown as { __drawn: Promise<unknown> }).__drawn);
  expect(drawn).toEqual({ ok: false, problem: REFUSED_MATH_HERE });
});

test('what Mermaid drew keeps a picture only when it is written in, and a <use> only of the drawing itself', async ({ page, baseURL }) => {
  // The Console's own scan of what Mermaid returns (withoutFetchingSvg), as the development server
  // serves it, run on drawings written by hand. It parses them inertly; so does this test.
  const svg = (body: string) =>
    `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 10 10">${body}</svg>`;
  const READ = '/api/projects/p/documents/read?path=a.md';
  const drawings: Array<[string, string[]]> = [
    // A picture written into the drawing stays, whichever href spells it.
    [svg(`<image href="${PIXEL}" width="4" height="4"/>`), [`image ${PIXEL}`]],
    [svg(`<image xlink:href="${PIXEL}" width="4" height="4"/>`), [`image ${PIXEL}`]],
    // Every other picture goes: another site, the local service, a file beside the page, an SVG,
    // and a written one that also names a link.
    [svg('<image href="https://example.com/x.png"/>'), []],
    [svg(`<image xlink:href="${READ}"/>`), []],
    [svg('<image href="x.png"/>'), []],
    [svg('<image href="data:image/svg+xml;base64,PHN2Zz4="/>'), []],
    [svg(`<image href="${PIXEL}" xlink:href="https://example.com/x.png"/>`), []],
    [svg('<IMAGE HREF="https://example.com/x.png"/>'), []],
    // A filter's picture, by the same rule.
    [
      svg(`<filter id="f"><feImage href="https://example.com/x.png"/><feImage href="${PIXEL}"/></filter><rect filter="url(#f)" width="4" height="4"/>`),
      [`feImage ${PIXEL}`],
    ],
    // A <use> stays only when it points into the drawing itself.
    [svg('<circle id="dot" r="1"/><use href="#dot"/><use xlink:href="#dot"/>'), ['use #dot', 'use #dot']],
    [svg(`<use href="https://example.com/s.svg#x"/><use xlink:href="${READ}#x"/>`), []],
    // A shadow root written as markup, which a frame would attach and draw.
    [`<div><template shadowrootmode="open">${svg('<image href="https://example.com/x.png"/>')}</template></div>`, []],
  ];
  await page.goto(baseURL!);
  await page.addScriptTag({
    type: 'module',
    content: ["import { withoutFetchingSvg } from '/client/console/mermaid-render.ts';", 'window.__scan = withoutFetchingSvg;'].join('\n'),
  });
  await page.waitForFunction(() => '__scan' in window);
  const kept = await page.evaluate((written) => {
    const scan = (window as unknown as { __scan: (drawing: string) => string }).__scan;
    // Every picture, filter picture and <use> left, with its hrefs, template contents included.
    const references = (root: ParentNode): string[] =>
      [...root.querySelectorAll('*')].flatMap((element) => [
        ...(/^(image|feimage|use)$/i.test(element.localName)
          ? [[element.localName, ...[...element.attributes].filter((a) => a.localName === 'href').map((a) => a.value)].join(' ')]
          : []),
        ...(element instanceof HTMLTemplateElement ? references(element.content) : []),
      ]);
    return written.map((drawing) => references(new DOMParser().parseFromString(`<!doctype html><body>${scan(drawing)}`, 'text/html').body));
  }, drawings.map(([drawing]) => drawing));
  expect(kept).toEqual(drawings.map(([, left]) => left));
});

// ---- the progress board (artifacts v2, (d)) ---------------------------------------------------

test('a thread on a running plan shows the plan counted from its tasks in the side panel, and follows them', async ({ page }, testInfo) => {
  const project = await api<Project>('/projects', 'POST', { name: 'Launch week' });
  const plan = 'plans/Launch week.md';
  await api(`/projects/${project.id}/documents/create`, 'POST', {
    path: plan,
    kind: 'plan',
    text: '# Launch week\n\n- Draft the offer\n- Build the landing page\n- Send the announcement\n',
  });
  const { found } = await api<{ found: Array<{ line: number; name: string; owner: string }> }>(
    `/projects/${project.id}/plans/find-tasks`,
    'POST',
    { path: plan },
  );
  const { tasks } = await api<{ tasks: Task[] }>(`/projects/${project.id}/plans/add-tasks`, 'POST', {
    path: plan,
    items: found,
  });
  expect(tasks.map((task) => task.name)).toEqual(['Draft the offer', 'Build the landing page', 'Send the announcement']);
  await api(`/projects/${project.id}/threads`, 'POST', {
    name: 'Launch plan',
    mode: 'plan',
    attachedTo: { kind: 'plan', ref: plan },
  });
  // The first task is done, and the second is running on the sample route, waiting on the person.
  await api(`/projects/${project.id}/tasks/${tasks[0].id}`, 'PUT', { state: 'done' });
  await api(`/projects/${project.id}/work/start`, 'POST', { taskId: tasks[1].id, route: 'sample' });
  await onConsole(project);
  await openConsole(page, project);

  const board = page.getByRole('complementary', { name: 'Progress', exact: true });
  await expect(board).toBeVisible();
  await expect(board.getByRole('heading', { name: 'Launch plan', exact: true })).toBeVisible();
  const bar = board.getByRole('progressbar', { name: 'Tasks from Launch week.md', exact: true });
  await expect(bar).toHaveAttribute('aria-valuetext', '1 of 3 tasks done');
  const steps = board.getByRole('listitem');
  await expect(steps).toHaveText([/Draft the offer/, /Build the landing page/, /Send the announcement/]);
  await expect(steps.nth(1)).toContainText('Needs your decision');
  await page.screenshot({ path: testInfo.outputPath('progress-board.png'), animations: 'disabled' });

  // Another task is done: the board follows the tasks event, with no reload.
  await api(`/projects/${project.id}/tasks/${tasks[2].id}`, 'PUT', { state: 'done' });
  await expect(bar).toHaveAttribute('aria-valuetext', '2 of 3 tasks done');

  // A reload rebuilds it from the same records.
  await openConsole(page, project);
  await expect(bar).toHaveAttribute('aria-valuetext', '2 of 3 tasks done');

  // Close puts it away while it counts the same tasks, across a reload too.
  await board.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(board).toHaveCount(0);
  await openConsole(page, project);
  await expect(page.locator('button.console-thread', { hasText: 'Launch plan' })).toBeVisible();
  await page.waitForTimeout(SETTLE_MS);
  await expect(board).toHaveCount(0);
});

// ---- the thread list's preview line (artifacts v2, E3) ----------------------------------------

test('the thread list reads a reply that is only a diagram by its title, never by its fence', async ({ page }) => {
  const project = await freshProject('Fence reply');
  await openConsole(page, project);
  await send(page, 'FENCE only, please');
  await expect(chips(page, 'Diagram', 'Van route')).toBeVisible();
  const row = page
    .getByRole('navigation', { name: 'Threads and views', exact: true })
    .locator('button.console-thread', { hasText: 'Fence reply thread' });
  await expect(row.locator('small')).toHaveText('Diagram: Van route');
  await expect(row).not.toContainText('`');
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

test('on the Nectovia page the panel opens beside the conversation, and says why it cannot save there', async ({ page }, testInfo) => {
  await freshProject('Home page');
  await page.goto(url);
  await expect(page.getByRole('heading', { name: 'Nectovia', exact: true })).toBeVisible();
  const box = page.getByRole('textbox', { name: 'Message Nectovia' });
  const calls = gateway.length;
  await box.fill('CHART of this week');
  await box.press('Enter');
  const turn = page.locator('.turn.dio').last();
  await expect(turn.getByRole('img', { name: WEEKLY, exact: true })).toBeVisible();
  // The answer came through Nectovia's gateway, and nothing here called a provider itself.
  expect(gateway.length).toBeGreaterThan(calls);
  expect(direct).toBe(0);
  const open = panelControl(turn, 'Weekly sends');
  await expect(open).toBeVisible();
  await open.click();
  const panel = pane(page);
  await expect(panel).toBeVisible();
  await expect(panel).toHaveClass(/\boverlay\b/);
  await expect(panel.getByRole('heading', { name: 'Weekly sends', exact: true })).toBeFocused();
  await expect(panel.getByRole('img', { name: WEEKLY, exact: true })).toBeVisible();
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
  // Esc closes it, and focus goes back to the control that opened it, which says so again.
  await page.keyboard.press('Escape');
  await expect(panel).toHaveCount(0);
  await expect(panelControl(turn, 'Weekly sends')).toBeFocused();
});

// Last in the file: it leaves the host's updater with a checked release.
test('the update card in a reply and Settings draw the bytes the host reported, and no share once it ends', async ({ page }, testInfo) => {
  const project = await freshProject('Update watch');
  await openConsole(page, project);
  await expect(page.locator('html')).toHaveAttribute('data-package', 'nectovia');
  const status = () => api<UpdateStatusSnapshot>('/updates/status');
  await api('/updates/check', 'POST', {});
  expect((await status()).check.outcome).toBe('available');
  // The download runs on the host. This request answers only when the download ends.
  const download = fetch(`${url}/api/updates/download`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Diomedes-Client': '1' },
    body: '{}',
  });
  await expect.poll(() => update.holding()).toBe(true);
  expect((await status()).download.progress).toEqual({ transferred: UPDATE_RECEIVED, total: UPDATE_SIZE });

  // The card's numbers are the host's: the bytes received over the size the server declared.
  await send(page, 'UPDATE me on the download');
  const card = page.locator('.transcript .turn.dio').last().locator('figure.iv-app');
  const downloading = `Downloading version ${update.version}`;
  const bar = card.getByRole('progressbar', { name: downloading, exact: true });
  await expect(bar).toHaveAttribute('aria-valuenow', '15');
  await expect(bar).toHaveAttribute('aria-valuetext', '15%, 12.3 of 80.0 MB');
  await expect(card.locator('.seg-caption')).toHaveText(`${downloading} · 12.3 of 80.0 MB`);
  // A record's bar, not the outlined gauge a reply's own progress is drawn as.
  await expect(card.locator('.seg-bar[data-source="reply"]')).toHaveCount(0);
  await card.scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath('update-card-mid-download.png'), animations: 'disabled' });

  // Settings, App updates draws the same download by the same rule.
  await page.getByRole('button', { name: 'Settings', exact: true }).first().click();
  await page.getByRole('button', { name: 'App updates', exact: true }).click();
  const settings = page.locator('.app-updates');
  const settingsBar = settings.getByRole('progressbar', { name: downloading, exact: true });
  await expect(settingsBar).toHaveAttribute('aria-valuenow', '15');
  await expect(settingsBar).toHaveAttribute('aria-valuetext', '15%, 12.3 of 80.0 MB');
  await page.screenshot({ path: testInfo.outputPath('settings-update-mid-download.png'), animations: 'disabled' });

  // The connection drops. The host clears what the download said about itself, and Settings,
  // reading the record again, draws no share of a download that is no longer running.
  update.drop();
  expect((await download).status).toBe(502);
  expect((await status()).download.progress).toBeUndefined();
  await expect(settingsBar).toHaveCount(0);
  await expect(settings.locator('.seg-bar')).toHaveCount(0);
  await expect(settings).toContainText(`Version ${update.version} is available`);
});
