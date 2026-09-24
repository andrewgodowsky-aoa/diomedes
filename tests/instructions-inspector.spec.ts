import { test, expect, type Page } from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { Conversation, Project, ProjectState, Session, Settings } from '../shared/types';
import type { InstructionDelivery } from '../shared/capability-packs';
import { reopenLastProject } from './fixtures/landing';

/**
 * H11: the thread's "Project instructions loaded" line opens an inspector that
 * lists what the last run actually used — each file in precedence order with
 * its folder, sha, size and whether it went, and every file that did not go
 * with its recorded reason — and opens any readable one in Files.
 *
 * Discovery and the read route are real: the pack is activated over a real
 * nested folder. The one thing injected is the delivery record on a session,
 * because only an engine run writes one and this suite has no engine. It is
 * built from the real discovered shas, exactly as `assembleInstructions`
 * would record them.
 */

test.describe.configure({ mode: 'serial' });

const HEADERS = { 'X-Diomedes-Client': '1' };
const FILES: Record<string, string> = {
  'AGENTS.md': '# Root rules\n\nROOT-RULES-BODY\n',
  'CLAUDE.md': '# Root Claude\n\nROOT-CLAUDE-BODY\n',
  'pkg/api/AGENTS.md': '# API rules\n\nAPI-RULES-BODY\n',
  'pkg/api/CLAUDE.md': '# API Claude\n\nAPI-CLAUDE-BODY\n',
  'pkg/web/AGENTS.md': '# Web rules\n\nWEB-RULES-BODY\n',
  'pkg/api/src/index.md': '# Index\n',
};
let originalSettings: Settings | null = null;
let projectId = '';
let threadId = '';
let delivery: InstructionDelivery;
let pageErrors: string[] = [];

test.beforeEach(async ({ page }) => {
  pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
});

test.afterEach(() => {
  expect(pageErrors, 'The interface must not throw uncaught browser errors').toEqual([]);
});

test.beforeAll(async ({ request }) => {
  originalSettings = (await (await request.get('/api/settings')).json()) as Settings;
  expect(
    (
      await request.put('/api/settings', {
        headers: HEADERS,
        data: {
          onboarding: { resumeAt: 'done', work: 'business', detail: 'guided', familiarity: 'comfortable' },
          detail: 'guided',
        },
      })
    ).ok(),
  ).toBe(true);
  const created = await request.post('/api/projects', {
    headers: HEADERS,
    data: { name: 'Instruction inspector' },
  });
  expect(created.ok()).toBe(true);
  projectId = ((await created.json()) as Project).id;
  const folder = ((await (await request.get(`/api/projects/${projectId}/state`)).json()) as ProjectState)
    .project.folder;
  for (const [name, text] of Object.entries(FILES)) {
    await fs.mkdir(path.dirname(path.join(folder, name)), { recursive: true });
    await fs.writeFile(path.join(folder, name), text, 'utf8');
  }
  const activated = await request.post(
    `/api/projects/${projectId}/packs/diomedes.software-engineering/activate`,
    { headers: HEADERS },
  );
  expect(activated.ok()).toBe(true);
  const records = ((await activated.json()) as { instructionFiles: ProjectState['instructionFiles'] })
    .instructionFiles!;
  expect(records.map((record) => record.path).sort()).toEqual(
    ['AGENTS.md', 'CLAUDE.md', 'pkg/api/AGENTS.md', 'pkg/api/CLAUDE.md', 'pkg/web/AGENTS.md'],
  );
  const sha = (name: string) => records.find((record) => record.path === name)!.sha!;
  const bytes = (name: string) => Buffer.byteLength(FILES[name]);
  const sent = (name: string, scope: string, precedence: number) => ({
    path: name,
    sha: sha(name),
    bytes: bytes(name),
    packId: 'diomedes.software-engineering' as const,
    packVersion: '0.1.0',
    ruleId: records.find((record) => record.path === name)!.ruleId!,
    state: 'sent' as const,
    detail: 'Sent whole.',
    scope,
    precedence,
  });
  delivery = {
    revision: 'iv-h11-fixture',
    routeId: 'codex',
    at: '2026-09-24T01:00:00.000Z',
    workPaths: ['pkg/api/src/index.md'],
    truncated: true,
    bytes: bytes('pkg/api/AGENTS.md') + bytes('pkg/api/CLAUDE.md') + bytes('AGENTS.md'),
    files: [
      sent('pkg/api/AGENTS.md', 'pkg/api', 1),
      sent('pkg/api/CLAUDE.md', 'pkg/api', 2),
      sent('AGENTS.md', '', 3),
      {
        ...sent('CLAUDE.md', '', 4),
        state: 'omitted',
        exclusion: 'no-room',
        detail: 'Not sent. Only 0 KB of room was left after the selected documents, and it is 1 KB. It was left out whole rather than cut part way through a rule.',
      },
    ],
    excluded: [
      {
        path: 'pkg/web/AGENTS.md',
        scope: 'pkg/web',
        sha: sha('pkg/web/AGENTS.md'),
        bytes: bytes('pkg/web/AGENTS.md'),
        packId: 'diomedes.software-engineering',
        exclusion: 'out-of-scope',
        detail: 'Not sent. It governs work in pkg/web, and this work is on pkg/api/src/index.md.',
      },
    ],
  };
  const thread = await request.post(`/api/projects/${projectId}/threads`, {
    headers: HEADERS,
    data: { name: 'Inspector thread' },
  });
  expect(thread.ok()).toBe(true);
  threadId = ((await thread.json()) as Conversation).id;
});

test.afterAll(async ({ request }) => {
  expect(originalSettings).toBeTruthy();
  const restore = await request.put('/api/settings', {
    headers: HEADERS,
    data: JSON.parse(JSON.stringify(originalSettings)),
  });
  expect(restore.ok()).toBe(true);
});

/** The thread's session carries the recorded delivery; everything else is the server's. */
async function withRecordedRun(page: Page) {
  await page.route(`**/api/projects/${projectId}/state`, async (route) => {
    const response = await route.fetch();
    const state = (await response.json()) as ProjectState;
    const session = {
      id: 'S-h11-inspector',
      taskId: 'T-h11-inspector',
      threadId,
      route: 'codex',
      state: 'done',
      startedAt: '2026-09-24T01:00:00.000Z',
      endedAt: '2026-09-24T01:01:00.000Z',
      sample: false,
      instructions: delivery,
      log: [],
      entryIds: [],
      needId: null,
      engine: {
        name: 'Codex, guarded file proposals',
        model: null,
        worker: 1,
        branch: null,
        context: 0,
        events: 0,
        version: null,
        verified: false,
      },
    } as unknown as Session;
    await route.fulfill({ response, json: { ...state, sessions: [...state.sessions, session] } });
  });
}

async function openThread(page: Page) {
  expect(
    (await page.request.put('/api/settings', { headers: HEADERS, data: { openProjects: [projectId] } })).ok(),
  ).toBe(true);
  await page.goto('/');
  await reopenLastProject(page);
  await expect(page.locator('.console')).toBeVisible();
  await page
    .getByRole('navigation', { name: 'Threads and views' })
    .getByRole('button', { name: /Inspector thread/ })
    .click();
}

test('H11-UI-01: the line opens the last run in precedence order, with scope, sha, size and reasons', async ({
  page,
}) => {
  await withRecordedRun(page);
  await openThread(page);
  const line = page.locator('.instructions-line');
  await expect(line).toBeVisible();
  // Decision 14's wording, said once.
  await expect(line).toContainText('Project instructions loaded ·');
  await expect(line).toContainText('AGENTS.md');
  await expect(line).toHaveAttribute('aria-expanded', 'false');
  await line.click();
  await expect(line).toHaveAttribute('aria-expanded', 'true');

  const run = page.getByRole('region', { name: 'Last run' });
  await expect(run).toBeVisible();
  await expect(run.locator('.instructions-run-head')).toContainText('codex');
  const rows = run.locator('.instructions-file');
  await expect(rows).toHaveCount(5);
  expect(await rows.evaluateAll((items) => items.map((item) => item.getAttribute('data-path')))).toEqual([
    'pkg/api/AGENTS.md',
    'pkg/api/CLAUDE.md',
    'AGENTS.md',
    'CLAUDE.md',
    'pkg/web/AGENTS.md',
  ]);
  const first = rows.nth(0);
  await expect(first.locator('.instructions-rank')).toHaveText('1');
  await expect(first.locator('.instructions-meta')).toContainText('sent · pkg/api');
  await expect(first.locator('.instructions-meta')).toContainText(delivery.files[0].sha!.slice(0, 12));
  await expect(rows.nth(2).locator('.instructions-meta')).toContainText('sent · project root');
  const omitted = rows.nth(3);
  await expect(omitted.locator('.instructions-meta')).toContainText('left out whole · no room left');
  await expect(omitted.locator('p')).toContainText('rather than cut part way');
  const excluded = rows.nth(4);
  // Excluded files took no part in the run, so they carry no rank.
  await expect(excluded.locator('.instructions-rank')).toHaveText('–');
  await expect(excluded.locator('.instructions-meta')).toContainText('out of scope · pkg/web');
  await expect(excluded.locator('p')).toContainText('It governs work in pkg/web');
  // A sent file's detail restates nothing the status word already says (decision 4).
  await expect(first.locator('p')).toHaveCount(0);

  // The body reads exactly as Diomedes read it, through the instruction read route.
  await first.getByRole('button', { name: 'pkg/api/AGENTS.md', exact: true }).click();
  await expect(first.locator('.instructions-body')).toContainText('API-RULES-BODY');
});

test('H11-UI-02: Open in Files opens the instruction file in the Files pane', async ({ page }) => {
  await withRecordedRun(page);
  await openThread(page);
  await page.locator('.instructions-line').click();
  const row = page.getByRole('region', { name: 'Last run' }).locator('[data-path="pkg/api/AGENTS.md"]');
  await row.getByRole('button', { name: 'Open in Files', exact: true }).click();
  const files = page.getByRole('complementary', { name: 'Files' });
  await expect(files).toBeVisible();
  await expect(files.locator('.files-path')).toContainText('pkg/api/AGENTS.md');
  await expect(files).toContainText('API-RULES-BODY');
});

test('H11-UI-03: long paths truncate inside the panel instead of widening the page', async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 800 });
  await withRecordedRun(page);
  await openThread(page);
  await page.locator('.instructions-line').click();
  await expect(page.getByRole('region', { name: 'Last run' })).toBeVisible();
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
});

test('H11-UI-04: turning the pack off keeps what the last run was sent inspectable', async ({
  page,
  request,
}) => {
  // Review (2026-09-24): the thread line rendered only while a loaded file
  // was on record for an active pack, so turning the pack off after a run
  // hid the run's delivery record too — instructions that were applied,
  // left where the person could no longer inspect them (decision 14).
  const off = await request.post(
    `/api/projects/${projectId}/packs/diomedes.software-engineering/deactivate`,
    { headers: HEADERS },
  );
  expect(off.ok()).toBe(true);
  try {
    await withRecordedRun(page);
    await openThread(page);
    const line = page.locator('.instructions-line');
    await expect(line).toBeVisible();
    // Nothing is loaded now, so the line does not say it is.
    await expect(line).not.toContainText('loaded');
    await expect(line).toContainText('Project instructions last sent ·');
    await line.click();
    const run = page.getByRole('region', { name: 'Last run' });
    await expect(run.locator('.instructions-file')).toHaveCount(5);
    const first = run.locator('[data-path="pkg/api/AGENTS.md"]');
    await expect(first.locator('.instructions-meta')).toContainText('sent · pkg/api');
    await first.getByRole('button', { name: 'pkg/api/AGENTS.md', exact: true }).click();
    await expect(first.locator('.instructions-body')).toContainText('API-RULES-BODY');
  } finally {
    const on = await request.post(
      `/api/projects/${projectId}/packs/diomedes.software-engineering/activate`,
      { headers: HEADERS },
    );
    expect(on.ok()).toBe(true);
  }
});
