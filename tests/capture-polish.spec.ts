import { expect, test, type Page } from '@playwright/test';
import express from 'express';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../server/app';
import { composeBrief, prettyFor, slugFor } from '../server/weekly-brief';
import { testOnlySecretBox } from '../server/connection-secrets';
import type { ConfigurationManifest } from '../shared/configuration';
import type { Project, Task } from '../shared/types';
import {
  ARTIFACT_ENGINE,
  ARTIFACT_MODEL,
  artifactEngine,
  type ArtifactEngine,
} from './fixtures/scripted-artifacts';
import { shareAfter, shareFixtureProject } from './fixtures/cloud-sharing-grant';

// The sample bakery the site's product captures show (Juniper Street Bakery, 2026-09-24), in the
// real Console: the real host, Store and built bundle, with only the model scripted. Each test
// looks at one thing a prospect saw wrong in those captures, at the captures' own 1440x900.
//
// With CAPTURE_DIR set, every test first saves its screen there as `<CAPTURE_PHASE>-<name>.png`,
// before it asserts anything, so the same spec records the before and after of each fix.

const CAPTURE_DIR = process.env.CAPTURE_DIR;
const PHASE = process.env.CAPTURE_PHASE ?? 'after';

let app: Awaited<ReturnType<typeof createApp>> | undefined;
let server: Server | undefined;
let url = '';
let engine: ArtifactEngine;
let project: Project;

async function api<T>(route: string, method = 'GET', data?: unknown): Promise<T> {
  const response = await fetch(`${url}/api${route}`, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Diomedes-Client': '1' },
    body: data === undefined ? undefined : JSON.stringify(data),
  });
  if (!response.ok)
    throw new Error(
      `Bakery fixture request ${route} failed (${response.status}): ${await response.text()}`,
    );
  const value = (await response.json()) as T;
  await shareAfter(api, route, method, value);
  return value;
}

async function capture(page: Page, name: string) {
  if (!CAPTURE_DIR) return;
  await fs.mkdir(CAPTURE_DIR, { recursive: true });
  // Let fonts settle so the capture reads as a person sees it.
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: path.join(CAPTURE_DIR, `${PHASE}-${name}.png`) });
}

const POS_PATH = 'Imports/pos-weekly-summary.txt';

const POS_SUMMARY = [
  '2026-W36 (week of Aug 31): revenue $11,204, croissants 487, pumpkin items 355',
  '2026-W37 (week of Sep 7): revenue $11,380, croissants 488, pumpkin items 415',
  '2026-W38 (week of Sep 14): revenue $11,612, gross margin $8,856, croissants 483, pumpkin items 492',
].join('\n');

/** The label a compiled setup gives its output: the output's name, then the setup's sentence. */
const OUTPUT_LABEL =
  'Weekly operations brief — Produce a recurring report: A Monday note on last week: sales, margin, what changed, and what to watch';

/** The brief exactly as the deterministic composer writes it from the POS export above. */
function bakeryBrief(): string {
  const manifest = {
    v: 1,
    organizationId: null,
    tenantId: null,
    revision: 1,
    state: 'active',
    proposal: {
      template: {
        id: 'diomedes.weekly-brief',
        version: '1.0.0',
        variantId: 'restaurant-operations',
      },
      contextScopes: [
        {
          id: 'weekly-sources',
          label: 'Weekly operations exports',
          kind: 'approved-files',
          selection: ['Imports/pos-weekly-summary.txt'],
        },
      ],
      expectedOutputs: [
        { id: 'weekly-brief', label: OUTPUT_LABEL, destination: 'weekly-operations-brief.md' },
      ],
    },
  } as unknown as ConfigurationManifest;
  return composeBrief({
    manifest,
    sources: [
      {
        // The id a per-run selection gives its first source (server/weekly-brief.ts).
        id: `${slugFor(POS_PATH)}-1`,
        label: `Weekly operations exports: ${prettyFor(POS_PATH)}`,
        path: POS_PATH,
        text: POS_SUMMARY,
      },
    ],
    previous: null,
    at: '2026-09-21T09:00:00.000Z',
  }).markdown;
}

test.beforeAll(async () => {
  const results = path.resolve('test-results');
  await fs.mkdir(results, { recursive: true });
  const root = await fs.mkdtemp(path.join(results, 'capture-polish-'));
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
  });
  const dist = path.resolve('dist');
  const built = (await fs.stat(path.join(dist, 'index.html'))).mtimeMs;
  for (const source of [
    'client/console/TurnBody.tsx',
    'client/console/InlineVisual.tsx',
    'client/console/BoardView.tsx',
    'client/console/FilesPane.tsx',
  ])
    expect(built, `Build first: ${source}`).toBeGreaterThan((await fs.stat(source)).mtimeMs);
  app.use(express.static(dist));
  app.get('/{*path}', (_request, response) => response.sendFile(path.join(dist, 'index.html')));
  server.on('request', app);
  await api('/ai/discover', 'POST', { consent: true });
  await api(`/ai/check/${ARTIFACT_ENGINE}`, 'POST', {});
  await api('/ai/select', 'POST', { engine: ARTIFACT_ENGINE, model: ARTIFACT_MODEL });

  project = await api<Project>('/projects', 'POST', { name: 'Juniper Street Bakery' });
  const documents: Record<string, string> = {
    'Imports/pos-weekly-summary.txt': POS_SUMMARY,
    'catering/inquiries.md':
      '# Catering inquiries\n\n- Millbrook Library Friends, Sat 2026-10-10\n',
    'staff/schedule-2026-W39.md': '# Staff schedule, W39\n\n- Sat open: Marco 5:30–1:30\n',
    'weekly-operations-brief.md': bakeryBrief(),
  };
  for (const [name, text] of Object.entries(documents))
    await api(`/projects/${project.id}/documents/create`, 'POST', { path: name, text });
  await shareFixtureProject(api, project.id);
  for (const name of ['Saturday staffing', 'Nine weeks at a glance'])
    await api(`/projects/${project.id}/threads`, 'POST', { name, mode: 'ask' });
  const tasks: { name: string; sourceDocument?: string }[] = [
    {
      name: 'Quote Brightline Dental a standing Friday pastry box',
      sourceDocument: 'catering/inquiries.md',
    },
    { name: 'Try the butter croissant at $4.50 for three weeks' },
    {
      name: 'Find a second baker for Saturday mornings',
      sourceDocument: 'staff/schedule-2026-W39.md',
    },
  ];
  for (const task of tasks) await api<Task>(`/projects/${project.id}/tasks`, 'POST', task);
  await api('/settings', 'PUT', {
    detail: 'standard',
    openProjects: [project.id],
    onboarding: {
      work: 'business',
      detail: 'standard',
      familiarity: 'comfortable',
      resumeAt: 'done',
      completedAt: new Date().toISOString(),
    },
  });
});

test.afterAll(async () => {
  engine?.release();
  await app?.locals.close?.();
  server?.closeAllConnections();
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
});

const rail = (page: Page) => page.getByRole('navigation', { name: 'Threads and views' });
const composer = (page: Page) =>
  page.getByRole('textbox', { name: 'Message this thread', exact: true });
const filesPane = (page: Page) => page.getByRole('complementary', { name: 'Files', exact: true });

async function openBakery(page: Page, files = false) {
  await page.setViewportSize({ width: 1440, height: 900 });
  // Still captures: no arrival or travel motion caught half way.
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.addInitScript((open) => {
    localStorage.setItem('console.files.open', open ? 'true' : 'false');
  }, files);
  await page.goto(url);
  await page.getByRole('button', { name: 'Juniper Street Bakery', exact: true }).click();
  await expect(rail(page)).toBeVisible();
}

/** Opens a thread and asks it once; the scripted model answers by the prompt's first word. */
async function ask(page: Page, thread: string, prompt: string) {
  await rail(page)
    .getByRole('button', { name: new RegExp(`^${thread}`) })
    .first()
    .click();
  await expect(composer(page)).toBeVisible();
  const answered = page.locator('.transcript .turn.dio');
  if ((await answered.count()) === 0) {
    await composer(page).fill(prompt);
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await page
      .getByRole('dialog', { name: 'Send this message?' })
      .getByRole('button', { name: 'Send message', exact: true })
      .click();
  }
  await expect(answered.last()).toBeVisible();
  return answered.last();
}

test('1. an answer renders emphasis, bold and inline code in list items and table cells, and keeps a literal asterisk', async ({
  page,
}) => {
  await openBakery(page);
  const turn = await ask(page, 'Saturday staffing', 'SATURDAY staffing against catering load');
  await turn.locator('.art-table').scrollIntoViewIfNeeded();
  await capture(page, '1-saturday-staffing');
  const body = turn.locator('.body');
  await expect(body.locator('li em', { hasText: 'weekly recurring' })).toBeVisible();
  await expect(body.locator('li strong', { hasText: 'Friday:' })).toBeVisible();
  await expect(body.locator('li code', { hasText: 'final' })).toBeVisible();
  await expect(body.locator('td em', { hasText: '9–11 rush' })).toBeVisible();
  await expect(body.locator('td strong', { hasText: 'Marco' })).toBeVisible();
  await expect(body.locator('td code', { hasText: '4-mile' })).toBeVisible();
  await expect(body.locator('td', { hasText: '5 * 3 boxes a week' })).toBeVisible();
  // No marker a person should not see survives outside an intentional literal.
  const text = await body.innerText();
  expect(text).not.toContain('*weekly recurring*');
  expect(text).not.toContain('**');
});

test('2. chart labels stay readable at 1440x900: wrapped, or cut with the whole label on hover', async ({
  page,
}) => {
  // The same answer at 1440x900, then in the narrower column the open Files pane leaves it.
  for (const narrow of [false, true]) {
    await openBakery(page, narrow);
    const turn = await ask(page, 'Nine weeks at a glance', 'NINEWEEKS at a glance');
    const chart = turn.locator('figure.iv-line');
    await chart.scrollIntoViewIfNeeded();
    await capture(page, narrow ? '2-nine-weeks-chart-narrow' : '2-nine-weeks-chart');
    await turn.locator('figure.iv-bar').scrollIntoViewIfNeeded();
    await capture(page, narrow ? '2-long-labels-chart-narrow' : '2-long-labels-chart');
    for (const figure of [chart, turn.locator('figure.iv-bar')]) {
      const labels = figure.locator('svg .iv-grid text.iv-x');
      expect(await labels.count()).toBeGreaterThan(0);
      for (const label of await labels.all()) {
        const shown = (await label.textContent()) ?? '';
        const hover = label.locator('title');
        const whole = (await hover.count()) > 0 ? await hover.textContent() : null;
        // A cut label always carries its whole text for hover.
        if (shown.includes('…'))
          expect(whole, `"${shown}" is cut with nothing to hover`).toBeTruthy();
      }
      // No two shown labels overlap, and none runs past the drawing.
      const boxes = await labels.evaluateAll((nodes) =>
        nodes.map((node) => {
          const box = (node as SVGGraphicsElement).getBoundingClientRect();
          const svg = (node as SVGGraphicsElement).ownerSVGElement!.getBoundingClientRect();
          return { left: box.left, right: box.right, svgLeft: svg.left, svgRight: svg.right };
        }),
      );
      for (const [index, box] of boxes.entries()) {
        expect(box.left).toBeGreaterThanOrEqual(box.svgLeft - 1);
        expect(box.right).toBeLessThanOrEqual(box.svgRight + 1);
        if (index > 0) expect(box.left).toBeGreaterThanOrEqual(boxes[index - 1].right);
      }
    }
    await expect(chart.locator('svg .iv-grid text.iv-x', { hasText: 'W36' })).toContainText(
      '(price change)',
    );
  }
});

test('3. the Board shows two lines of a title, says what its age is, and names a document, not its path', async ({
  page,
}) => {
  await openBakery(page, true);
  await rail(page)
    .getByRole('button', { name: /^Board/ })
    .click();
  const board = page.locator('.board[aria-label="Board"]');
  await expect(board).toBeVisible();
  const ready = page.locator('.column[aria-label="Ready"]');
  const row = ready.locator('.crow', { hasText: 'Quote Brightline Dental' });
  await expect(row).toBeVisible();
  await capture(page, '3-board');
  // The board opens compact; the title still gets two lines at this width.
  const title = row.locator('.t');
  const lines = await title.evaluate((node) => {
    const style = getComputedStyle(node);
    return Math.round(node.getBoundingClientRect().height / parseFloat(style.lineHeight));
  });
  expect(lines).toBeGreaterThanOrEqual(2);
  await expect(title).toHaveAttribute(
    'title',
    'Quote Brightline Dental a standing Friday pastry box',
  );
  // Focus shows the whole title, not only a tooltip.
  await title.focus();
  const clamped = await title.evaluate((node) => node.scrollHeight > node.clientHeight + 1);
  expect(clamped).toBe(false);
  await capture(page, '3-board-title-focused');
  // The bare number is the time since the task last moved, and says so.
  const age = row.locator('.age');
  await expect(age).toHaveAttribute(
    'title',
    /^(Added|Last moved) (just now|\d+ (minute|hour|day)s? ago)$/,
  );
  await expect(row).toContainText('Catering inquiries');
  await expect(row).not.toContainText('catering/inquiries.md');
  await expect(row.locator('[title="catering/inquiries.md"]')).toHaveCount(1);
});

test('4-6. the weekly brief is titled by its name, keeps POS in capitals, and cites its source as a reference', async ({
  page,
}) => {
  await openBakery(page, true);
  await filesPane(page).getByRole('treeitem', { name: 'weekly-operations-brief.md' }).click();
  const md = filesPane(page).locator('.files-md');
  await expect(md).toBeVisible();
  await capture(page, '4-6-weekly-brief');
  await expect(md.locator('h3').first()).toHaveText('Weekly operations brief');
  await expect(md).toContainText('Weekly operations exports: POS weekly summary');
  await expect(md).not.toContainText('[imports-pos-weekly-summary-1]');
  const reference = md.getByRole('button', { name: /POS weekly summary/ }).first();
  await expect(reference).toBeVisible();
  await reference.click();
  await expect(filesPane(page)).toContainText('pos-weekly-summary.txt');
});

test("6. a citation tag in an answer is the thread's own source reference", async ({ page }) => {
  await openBakery(page);
  const turn = await ask(page, 'Nine weeks at a glance', 'NINEWEEKS at a glance');
  const finding = turn.locator('li', { hasText: 'Croissant units held steady' });
  await finding.scrollIntoViewIfNeeded();
  await capture(page, '6-answer-citation');
  await expect(finding).not.toContainText('[imports-pos-weekly-summary-1]');
  const reference = finding.locator('button.ref-chip');
  await expect(reference).toHaveCount(1);
  await expect(reference).toContainText('POS weekly summary');
  await reference.click();
  await expect(filesPane(page)).toContainText('pos-weekly-summary.txt');
});
