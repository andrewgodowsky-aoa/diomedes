import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import fs from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createApp } from '../server/app.js';
import type { NativeGenerator } from '../server/native-work.js';
import { textKind } from '../server/paths.js';
import type { Store } from '../server/store.js';
import type { Change, DocumentInfo, Need, ProjectState } from '../shared/types.js';
import { directOrigin } from '../shared/attribution.js';
import { SVG_CHECK_PASSED } from '../shared/svg-check.js';
import { selectTaskSources, taskDocumentProblem } from '../shared/task-sources.js';
import { buildEntries, type PaletteContext, type PaletteHandlers } from '../client/console/paletteEntries';
import { ApprovalStatus } from '../client/components';
import { NeedBlock } from '../client/console/Need';
import { indexArtifacts, savedDocument } from '../client/console/artifacts';
import { saveArtifact } from '../client/console/artifact-save';

// Drawings in Files and the Trust checks on them (artifacts v2, lane 3): the
// 'drawing' kind, drawings as proposal sources, svg-check on every SVG a
// proposal writes, the verdict on the Need, and exact review for every .svg,
// .html and .xml a proposal writes while a grant still covers .mmd.

const fixture = (set: 'benign' | 'hostile', name: string) =>
  readFileSync(path.join(process.cwd(), 'tests', 'fixtures', 'svg-check', set, name), 'utf8');
const LOGO = fixture('benign', 'logo.svg');
const FLOW = 'flowchart TD\n  A[Order] --> B[Ship]\n';
const UNCHECKED =
  'No content check: this file can run code when it is opened in a browser. Read it before you say go ahead.';

let app: Awaited<ReturnType<typeof createApp>>;
let server: Server;
let temp: string, url: string, projectId: string, taskId: string, folder: string;
let result: Awaited<ReturnType<NativeGenerator>>;
let generate: NativeGenerator;
const pendingObservers = new Set<() => void>();
const headers = { 'Content-Type': 'application/json', 'X-Diomedes-Client': '1' };
const realFetch = globalThis.fetch;
async function request(route: string, method = 'GET', body?: unknown) {
  const response = await realFetch(`${url}/api${route}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, data: await response.json() };
}
const state = async (): Promise<ProjectState> =>
  (await request(`/projects/${projectId}/state`)).data;
const grant = () =>
  request(`/projects/${projectId}/permissions/grants`, 'POST', {
    protocolVersion: 2,
    commandId: crypto.randomUUID(),
    taskId,
    roots: ['.'],
    operations: ['text.create', 'text.modify'],
    engine: 'codex',
    accountRoute: 'codex:chatgpt',
    maxWrites: 40,
    maxBytes: 5_242_880,
    ttlMinutes: 60,
    review: 'human',
  });
const start = (sources: string[] = []) =>
  request(`/projects/${projectId}/work/start`, 'POST', {
    taskId,
    route: 'codex',
    consent: true,
    sources,
  });
function propose(changes: { path: string; text: string | null }[]) {
  result = {
    text: JSON.stringify({
      summary: 'Draw it',
      changes: changes.map((change) => ({ ...change, summary: `Write ${change.path}` })),
    }),
    model: 'runtime-model',
  };
}
const proposal = (name: string, text: string | null) => propose([{ path: name, text }]);
/** The latest session of this task once it stops working, with its own Needs. */
async function settled() {
  const store: Store = app.locals.store;
  const targetProject = projectId,
    targetTask = taskId;
  await new Promise<void>((resolve, reject) => {
    let sessionId: string | undefined;
    const cleanup = () => {
      store.off('change', changed);
      pendingObservers.delete(cancel);
    };
    const cancel = () => {
      cleanup();
      reject(new Error('Session observation ended before completion.'));
    };
    const changed = (id: string) => {
      if (id !== targetProject) return;
      try {
        const sessions = store.state(targetProject).sessions;
        sessionId ??= [...sessions].reverse().find((session) => session.taskId === targetTask)?.id;
        const session = sessions.find((item) => item.id === sessionId);
        if (!session) throw new Error('The started task session is missing.');
        if (session.state !== 'working' && session.state !== 'queued') {
          cleanup();
          resolve();
        }
      } catch (error) {
        cleanup();
        reject(error);
      }
    };
    pendingObservers.add(cancel);
    store.on('change', changed);
    changed(targetProject);
  });
  const current = await state();
  const session = [...current.sessions].reverse().find((item) => item.taskId === taskId)!;
  return { current, session, needs: current.needs.filter((need) => need.sessionId === session.id) };
}
const exists = (name: string) =>
  fs.stat(path.join(folder, name)).then(
    () => true,
    () => false,
  );

beforeEach(async () => {
  await fs.mkdir(path.join(process.cwd(), 'test-results'), { recursive: true });
  temp = await fs.mkdtemp(path.join(process.cwd(), 'test-results', 'drawings-trust-'));
  generate = async () => result;
  app = await createApp({
    dataDir: path.join(temp, 'data'),
    projectRoot: path.join(temp, 'projects'),
    nativeGenerator: (input) => generate(input),
  });
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  projectId = (await request('/projects/sample', 'POST', {})).data.id;
  taskId = (
    await request(`/projects/${projectId}/tasks`, 'POST', {
      name: 'Drawings',
      description: 'Draw the delivery flow',
    })
  ).data.id;
  folder = (await state()).project.folder;
  await fs.writeFile(path.join(folder, 'logo.svg'), LOGO);
  await fs.writeFile(path.join(folder, 'flow.mmd'), FLOW);
  await fs.writeFile(path.join(folder, 'scan.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  await request('/settings', 'PUT', { services: { codex: true } });
  expect(
    (
      await request(`/projects/${projectId}/cloud-sharing`, 'PUT', {
        expectedVersion: 0,
        routes: ['codex'],
        documents: ['Fall menu.md', 'logo.svg', 'flow.mmd', 'scan.png'],
        shareConversationHistory: false,
        shareReviewPackets: false,
      })
    ).status,
  ).toBe(200);
});
afterEach(async () => {
  vi.unstubAllGlobals();
  const closingApp = app,
    closingServer = server;
  for (const cancel of [...pendingObservers]) cancel();
  try {
    await closingApp?.locals.close();
  } finally {
    if (closingServer) {
      closingServer.closeAllConnections();
      await new Promise<void>((resolve) => closingServer.close(() => resolve()));
    }
    await fs.rm(temp, { recursive: true, force: true });
  }
});

describe('the drawing kind', () => {
  test('lists .svg and .mmd as drawings, and nothing else changes kind', async () => {
    const listed = (await request(`/projects/${projectId}/documents`)).data
      .documents as DocumentInfo[];
    const kinds = Object.fromEntries(listed.map((item) => [item.path, item.kind]));
    expect(kinds).toMatchObject({
      'logo.svg': 'drawing',
      'flow.mmd': 'drawing',
      'scan.png': 'unsupported',
      'Fall menu.md': 'markdown',
    });
    expect(['a/B.SVG', 'c.Mmd', 'page.html', 'feed.xml', 'x.svgz'].map(textKind)).toEqual([
      'drawing',
      'drawing',
      'text',
      'text',
      'unsupported',
    ]);
  });

  test('a saved version records drawings, as it records text', async () => {
    // store.snapshot reads only 'unsupported' as not text, so drawings are now
    // kept in saved versions (and a whole-folder restore treats them as text).
    const saved = await request(`/projects/${projectId}/history/label`, 'POST', {
      label: 'Before drawings',
    });
    expect(saved.status).toBe(200);
    const files = Object.fromEntries(
      (saved.data.files as { path: string; recorded: boolean; reason: string | null }[]).map(
        (file) => [file.path, [file.recorded, file.reason]],
      ),
    );
    expect(files).toMatchObject({
      'logo.svg': [true, null],
      'flow.mmd': [true, null],
      'scan.png': [false, 'Unsupported file type'],
    });
  });

  test('automatic task sources skip drawings, even when the task names them', async () => {
    const listed = (await request(`/projects/${projectId}/documents`)).data
      .documents as DocumentInfo[];
    expect(listed.find((item) => item.path === 'logo.svg')?.kind).toBe('drawing');
    expect(selectTaskSources({ name: 'Update logo.svg and flow.mmd' }, listed)).toEqual([]);
    expect(taskDocumentProblem('logo.svg', listed)).toBe('Select a supported text document.');
  });

  test('the palette names a drawing as a drawing', () => {
    const document = (file: string): DocumentInfo => ({
      path: file,
      kind: textKind(file),
      size: 100,
      changedAt: '2026-09-23T09:00:00Z',
      hasChangesWaiting: false,
      recorded: false,
    });
    const context = {
      tasks: [], sessions: [], needs: [], changes: [], documents: [document('logo.svg')],
      members: [], catalogs: {}, integrations: [], projects: [], currentProjectId: 'project',
      currentThread: null, policy: 'go', view: 'Board', pendingTaskId: null, routingTaskId: null,
      onPendingTask: vi.fn(), onRoutingTask: vi.fn(), onPivotModels: vi.fn(),
      handlers: { openDocument: vi.fn() } as unknown as PaletteHandlers,
    } as unknown as PaletteContext;
    const entry = buildEntries(context).find((row) => row.id === 'file:logo.svg');
    expect(entry?.sub).toBe('drawing, project folder');
  });
});

describe('drawings as proposal sources', () => {
  test('a drawing the person selects is sent as a source, and its edit is a Need', async () => {
    const sent: string[][] = [];
    generate = async (input) => {
      sent.push(input.documents.map((document) => document.path));
      return result;
    };
    const edited = LOGO.replace('Harbor &amp; Main</text>', 'Harbor &amp; Main Street</text>');
    proposal('logo.svg', edited);
    expect((await start(['logo.svg', 'flow.mmd'])).status).toBe(200);
    const { session, needs } = await settled();
    expect(session.state).toBe('waiting');
    expect(sent).toEqual([['logo.svg', 'flow.mmd']]);
    expect(needs).toHaveLength(1);
    expect(needs[0].preview?.[0]).toMatchObject({ path: 'logo.svg', op: 'modified', before: LOGO, after: edited });
  });

  test('a file that is not text is still refused as a source', async () => {
    const refused = await start(['scan.png']);
    expect(refused.status).toBe(415);
    expect(refused.data.error).toBe('Select supported text documents for this proposal.');
  });
});

describe('svg-check on proposals', () => {
  test('an SVG that fails the check is refused with its reason, before any Need exists', async () => {
    proposal('evil.svg', fixture('hostile', 'script-element.svg'));
    expect((await start()).status).toBe(200);
    const { current, session, needs } = await settled();
    const reason = 'The SVG check refused evil.svg: the element <script> is not allowed (line 1).';
    expect(session.state).toBe('failed');
    expect(session.parseError).toBe(reason);
    expect(session.log.at(-1)?.sentence).toBe(`Work stopped: ${reason} No project files were changed.`);
    expect(needs).toEqual([]);
    expect(
      current.history.find((entry) => entry.kind === 'fault' && entry.sessionId === session.id)
        ?.parseError,
    ).toBe(reason);
    expect(await exists('evil.svg')).toBe(false);
  });

  test.each([
    ['an svg root', fixture('hostile', 'script-element.svg'), 'the element <script> is not allowed (line 1)'],
    [
      'a doctype whose subset hides the root from svgRoot',
      `<!DOCTYPE svg [<!ENTITY a ">">]>${LOGO.slice(LOGO.indexOf('<svg'))}`,
      '<!DOCTYPE> is not allowed (line 1)',
    ],
    [
      'the SVG namespace spelled with a character reference',
      fixture('hostile', 'xml-g-root-charref-ns.xml'),
      'its root element must be <svg> (line 1)',
    ],
  ])('an .xml file with %s is checked as SVG', async (_name, text, problem) => {
    proposal('icon.xml', text);
    await start();
    const { session, needs } = await settled();
    expect(session.state).toBe('failed');
    expect(session.parseError).toBe(`The SVG check refused icon.xml: ${problem}.`);
    expect(needs).toEqual([]);
    expect(await exists('icon.xml')).toBe(false);
  });

  test('an SVG that passes carries the verdict on its Need', async () => {
    proposal('new-logo.svg', LOGO);
    await start();
    const { needs } = await settled();
    expect(needs).toHaveLength(1);
    expect(needs[0].state).toBe('open');
    expect(needs[0].checks).toEqual([
      { path: 'new-logo.svg', check: 'svg', version: 1, outcome: 'passed', sentence: SVG_CHECK_PASSED },
    ]);
  });

  test('a page or XML file says no check read it, and Markdown and Mermaid carry no line', async () => {
    propose([
      { path: 'page.html', text: '<!doctype html><p>Opening hours</p>' },
      { path: 'feed.xml', text: '<?xml version="1.0"?><feed><title>News</title></feed>' },
      { path: 'flow-2.mmd', text: FLOW },
      { path: 'Notes.md', text: '# Notes\n' },
    ]);
    await start();
    const { needs } = await settled();
    expect(needs).toHaveLength(1);
    expect(needs[0].checks).toEqual([
      { path: 'page.html', check: 'none', outcome: 'unchecked', sentence: UNCHECKED },
      { path: 'feed.xml', check: 'none', outcome: 'unchecked', sentence: UNCHECKED },
    ]);
  });
});

describe('grants and exact review', () => {
  test.each([
    ['logo-2.svg', LOGO],
    ['page.html', '<!doctype html><p>Opening hours</p>'],
    ['feed.xml', '<?xml version="1.0"?><feed><title>News</title></feed>'],
  ])('no grant covers a proposal that writes %s', async (name, text) => {
    expect((await grant()).status).toBe(200);
    proposal(name, text);
    await start();
    const { needs } = await settled();
    expect(needs).toHaveLength(1);
    expect(needs[0].state).toBe('open');
    expect(needs[0].authorization).toBeUndefined();
    expect(needs[0].authorizationBoundary).toBe(
      `${name} always needs your exact review: an SVG, HTML or XML file can run code when it is opened.`,
    );
    expect(await exists(name)).toBe(false);
  });

  test('a grant confirmed while an SVG proposal waits leaves it waiting', async () => {
    proposal('logo-2.svg', LOGO);
    await start();
    expect((await settled()).needs[0].state).toBe('open');
    expect((await grant()).status).toBe(200);
    const { needs } = await settled();
    expect(needs[0].state).toBe('open');
    expect(needs[0].authorization).toBeUndefined();
    expect(needs[0].authorizationBoundary).toContain('logo-2.svg always needs your exact review');
  });

  test('a grant covers no part of a batch that writes an .svg: the Markdown waits with it', async () => {
    expect((await grant()).status).toBe(200);
    propose([
      { path: 'drawing-notes.md', text: '# Drawing notes\n' },
      { path: 'logo-2.svg', text: LOGO },
    ]);
    await start();
    const { needs } = await settled();
    expect(needs).toHaveLength(1);
    expect(needs[0].state).toBe('open');
    expect(needs[0].authorization).toBeUndefined();
    expect(needs[0].authorizationBoundary).toBe(
      'logo-2.svg always needs your exact review: an SVG, HTML or XML file can run code when it is opened.',
    );
    expect(await exists('drawing-notes.md')).toBe(false);
    expect(await exists('logo-2.svg')).toBe(false);
  });

  test('a grant still covers a .mmd proposal', async () => {
    expect((await grant()).status).toBe(200);
    proposal('flow-2.mmd', FLOW);
    await start();
    const { session, needs } = await settled();
    expect(session.state).toBe('done');
    expect(needs[0].authorization?.kind).toBe('scope-grant');
    expect(needs[0].execution?.state).toBe('applied');
    expect(await fs.readFile(path.join(folder, 'flow-2.mmd'), 'utf8')).toBe(FLOW);
  });
});

describe("the person's own writes", () => {
  test('Save to Files writes a design as .html, script and all, and saves its next version over it', async () => {
    // The panel's real save path against the real routes: only fetch's base changes.
    vi.stubGlobal('fetch', (input: string, init?: RequestInit) => realFetch(`${url}${input}`, init));
    const page = (heading: string) =>
      '```html\n<!-- artifact: id=home-mock title="Home mock" -->\n' +
      `<!doctype html><html><body><h1>${heading}</h1><script>document.title = 'mine'</script></body></html>\n` +
      '```';
    const [first, second] = indexArtifacts('thread-1', [
      { id: 't1', role: 'diomedes', text: page('Home') },
      { id: 't2', role: 'diomedes', text: page('Home, revised') },
    ]).list;
    expect(first.kind).toBe('design');
    expect(await saveArtifact(projectId, first)).toMatchObject({
      ok: true,
      created: true,
      path: 'Saved artifacts/Home mock.html',
    });
    expect(await saveArtifact(projectId, second)).toMatchObject({ ok: true, created: false });
    expect(await fs.readFile(path.join(folder, 'Saved artifacts', 'Home mock.html'), 'utf8')).toBe(
      savedDocument(second, second.title),
    );
  });

  test('the editor routes write an SVG the check would refuse, unchanged', async () => {
    const hostile = fixture('hostile', 'script-element.svg');
    const created = await request(`/projects/${projectId}/documents/create`, 'POST', {
      path: 'mine.svg',
      text: hostile,
    });
    expect(created.status).toBe(200);
    const read = await request(`/projects/${projectId}/documents/read?path=mine.svg`);
    const written = await request(`/projects/${projectId}/documents/write`, 'POST', {
      path: 'mine.svg',
      text: `${hostile}<!-- again -->`,
      baseSha: read.data.sha,
    });
    expect(written.status).toBe(200);
    expect(await fs.readFile(path.join(folder, 'mine.svg'), 'utf8')).toBe(`${hostile}<!-- again -->`);
  });
});

describe('the verdict in the review', () => {
  const need = (extra: Partial<Need>): Need => ({
    id: 'N1',
    sessionId: 'S1',
    taskId: 'T1',
    what: 'apply the proposed changes to 2 files',
    why: 'Draw it',
    consequence: 'Your OK applies only to the exact files and text shown here.',
    files: ['logo.svg', 'page.html'],
    state: 'open',
    createdAt: '2026-09-23T09:00:00.000Z',
    decidedAt: null,
    decidedFrom: 'desktop',
    allowForTask: false,
    ...extra,
  });
  const checks: Need['checks'] = [
    { path: 'logo.svg', check: 'svg', version: 1, outcome: 'passed', sentence: SVG_CHECK_PASSED },
    { path: 'page.html', check: 'none', outcome: 'unchecked', sentence: UNCHECKED },
  ];

  test('shows each file with its check, beside the approval record', () => {
    const html = renderToStaticMarkup(
      createElement(ApprovalStatus, {
        need: need({
          checks,
          approval: {
            protocolVersion: 1,
            proposalDigest: 'p'.repeat(64),
            actionDigest: 'a'.repeat(64),
            baseDigest: 'b'.repeat(64),
            expiresAt: '2026-09-23T10:00:00.000Z',
            sources: [],
          },
        }),
      }),
    );
    expect(html).toContain('aria-label="Content checks"');
    expect(html).toContain('logo.svg');
    expect(html).toContain(SVG_CHECK_PASSED);
    expect(html).toContain('page.html');
    expect(html).toContain(UNCHECKED);
    expect(html).toContain('This OK covers only this proposal.');
  });

  test('shows the checks on a Need that has no approval record yet', () => {
    const html = renderToStaticMarkup(createElement(ApprovalStatus, { need: need({ checks }) }));
    expect(html).toContain(SVG_CHECK_PASSED);
    expect(html).toContain(UNCHECKED);
  });

  test('shows nothing for a Need no check read', () => {
    expect(renderToStaticMarkup(createElement(ApprovalStatus, { need: need({}) }))).toBe('');
  });
});

describe('the grant offer', () => {
  const OFFER = 'Allow creates and updates for this task';
  const change = (file: string, index: number): Change => ({
    id: `C${index}`,
    entryId: '',
    sessionId: 'S1',
    taskId: 'T1',
    path: file,
    op: 'created',
    summary: `Write ${file}`,
    before: null,
    after: 'text',
    current: null,
    changedSince: null,
    hunks: [],
    state: 'waiting',
  });
  const block = (files: string[]) =>
    renderToStaticMarkup(
      createElement(NeedBlock, {
        need: {
          id: 'N1',
          sessionId: 'S1',
          taskId: 'T1',
          what: `apply the proposed changes to ${files.length} files`,
          why: 'Draw it',
          consequence: 'Your OK applies only to the exact files and text shown here.',
          files,
          state: 'open',
          createdAt: '2026-09-23T09:00:00.000Z',
          decidedAt: null,
          decidedFrom: 'desktop',
          allowForTask: false,
          origin: directOrigin({ engine: 'codex' }),
          preview: files.map(change),
        },
        decide: vi.fn(),
        show: vi.fn(),
        onScope: vi.fn(),
      }),
    );

  test('is made where a grant could cover every file', () => {
    expect(block(['Notes.md', 'flow.mmd'])).toContain(OFFER);
  });

  test.each([
    { files: ['logo.svg'] },
    { files: ['page.html'] },
    { files: ['feed.xml'] },
    { files: ['Notes.md', 'logo.svg'] },
  ])('is not made for a proposal that writes $files: no grant covers it', ({ files }) => {
    const html = block(files);
    expect(html).not.toContain(OFFER);
    expect(html).toContain('Show me first');
  });
});
