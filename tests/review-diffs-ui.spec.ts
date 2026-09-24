import { expect, test, type Page } from '@playwright/test';
import express from 'express';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../server/app';
import type { NativeGenerator } from '../server/native-work';
import type { Conversation, Project, ProjectState, Task } from '../shared/types';
import { identityLabel, versionsOf } from '../shared/file-identity';
import { revisionRequest } from '../shared/review-comments';
import { reopenLastProject } from './fixtures/landing';

// P06 in the built Console against the real host, Store and routes: a run's
// change to a restaurant's price list is reviewed as a readable diff, kept in
// part (after a conflict with an outside edit is refused and reviewed again),
// commented on, and sent back for revision as an ordinary follow-up; the same
// diff and comments work from the file's version list in Files. The model is an
// injected generator: nothing leaves this machine.

const FILE = 'Menu/Prices.md';
const ORIGINAL = ['# Prices', '', 'Soup $7', 'Bread $3', 'Tea $2', 'Coffee $3', 'Cake $5', 'Pie $6', 'Juice $4', ''].join('\n');
const PROPOSED = ORIGINAL.replace('Soup $7', 'Soup $8').replace('Coffee $3\n', '') + 'Water $1\n';
const KEPT = ORIGINAL.replace('Soup $7', 'Soup $8') + 'Water $1\n';
const TASK = 'Update the menu prices';
const COMMENT = 'Soup should be $9 now, the supplier raised prices.';

let app: Awaited<ReturnType<typeof createApp>>;
let server: Server;
let url: string;
let project: Project;
let task: Task;
/** Every prompt the injected generator was asked, in order. */
const prompts: string[] = [];

async function api<T>(route: string, method = 'GET', body?: unknown): Promise<T> {
  const response = await fetch(`${url}/api${route}`, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Diomedes-Client': '1' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  expect(response.ok, `${route}: ${response.status} ${response.ok ? '' : await response.text()}`).toBe(true);
  return response.json() as Promise<T>;
}
const state = () => api<ProjectState>(`/projects/${project.id}/state`);
const onDisk = () => fs.readFile(path.join(project.folder, FILE), 'utf8');
const pane = (page: Page) => page.getByRole('complementary', { name: 'Files', exact: true });
const fileRow = (page: Page, name: string) =>
  pane(page)
    .locator('.files-row')
    .filter({ has: page.locator('.files-name', { hasText: new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`) }) });

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

async function openThread(page: Page) {
  await page
    .getByRole('navigation', { name: 'Threads and views' })
    .getByRole('button', { name: new RegExp(TASK) })
    .click();
  await expect(page.locator('#scrThread')).toBeVisible();
}

test.beforeAll(async () => {
  await fs.mkdir(path.resolve('test-results'), { recursive: true });
  const root = await fs.mkdtemp(path.resolve('test-results/review-diffs-ui-'));
  server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  url = `http://127.0.0.1:${port}`;
  const generator: NativeGenerator = async ({ prompt, documents }) => {
    prompts.push(prompt);
    const current = documents.find((document) => document.path === FILE)?.text ?? ORIGINAL;
    const text = prompts.length === 1 ? PROPOSED : current.replace('Soup $8', 'Soup $9');
    return {
      model: 'Injected review test generator',
      text: JSON.stringify({
        summary: prompts.length === 1 ? 'Update the price list' : 'Revise the soup price',
        changes: [{ path: FILE, text, summary: `Update ${FILE}` }],
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
  const dist = path.resolve('dist');
  const built = (await fs.stat(path.join(dist, 'index.html'))).mtimeMs;
  for (const source of [
    'client/console/DiffView.tsx',
    'client/console/ChangeDiffs.tsx',
    'client/console/VersionCompare.tsx',
    'client/console/diff-view.css',
    'shared/text-diff.ts',
    'shared/review-comments.ts',
  ])
    expect(built, `Build first: ${source}`).toBeGreaterThan((await fs.stat(source)).mtimeMs);
  app.use(express.static(dist));
  app.get('/{*path}', (_req, res) => res.sendFile(path.join(dist, 'index.html')));
  server.on('request', app);

  project = await api<Project>('/projects', 'POST', { name: 'Diner review fixture' });
  await fs.mkdir(path.join(project.folder, 'Menu'), { recursive: true });
  await fs.writeFile(path.join(project.folder, FILE), ORIGINAL, 'utf8');
  await api(`/projects/${project.id}/cloud-sharing`, 'PUT', {
    expectedVersion: 0,
    routes: ['codex'],
    documents: [FILE],
    shareConversationHistory: false,
    shareReviewPackets: false,
  });
  await api('/settings', 'PUT', {
    detail: 'guided',
    openProjects: [project.id],
    services: { codex: true },
    onboarding: {
      work: 'business',
      detail: 'guided',
      familiarity: 'comfortable',
      resumeAt: 'done',
      completedAt: new Date().toISOString(),
    },
  });
  task = await api<Task>(`/projects/${project.id}/tasks`, 'POST', { name: TASK });
  const thread = await api<Conversation>(`/projects/${project.id}/threads`, 'POST', { name: TASK, taskId: task.id });
  await api(`/projects/${project.id}/work/start`, 'POST', {
    protocolVersion: 1,
    commandId: `review-diffs-${task.id}`,
    taskId: task.id,
    threadId: thread.id,
    route: 'codex',
    sources: [FILE],
    consent: true,
  });
  await expect
    .poll(async () => (await state()).sessions.find((item) => item.taskId === task.id)?.state, { timeout: 20_000 })
    .toBe('waiting');
});

test.afterAll(async () => {
  await app?.locals.close();
  server?.closeAllConnections();
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
});

test('review a change as a diff, keep it in part past a conflict, comment, and ask for a revision', async ({
  page,
}, testInfo) => {
  const errors: string[] = [];
  await guard(page, errors);
  await page.addInitScript(() => {
    if (window !== window.top) return;
    localStorage.setItem('console.files.open', 'true');
    localStorage.setItem('console.files.width', '460');
  });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(url);
  await reopenLastProject(page);
  await openThread(page);

  // The run's proposal is approved the way a person does it.
  const needs = page.getByRole('region', { name: 'Needs your OK' });
  await needs.getByRole('button', { name: 'Show me first', exact: true }).click();
  const proposal = page.getByRole('dialog');
  await proposal.getByRole('button', { name: 'Go ahead', exact: true }).click();
  await expect(proposal).not.toBeVisible();
  await expect.poll(onDisk).toBe(PROPOSED);

  // A readable diff with a plain header, three places, unified and side by side.
  const review = page.getByRole('region', { name: 'Review changes' });
  await expect(review).toBeVisible();
  const card = review.locator('.cdiff-card').first();
  await expect(card.locator('.dv-head')).toHaveText(`2 lines added, 2 removed in ${FILE}`);
  await expect(card.locator('.dv-hunk-head')).toHaveCount(3);
  await expect(card.locator('mark.dv-w.added')).toHaveText('8');
  await card.getByRole('radio', { name: 'Side by side' }).click();
  await expect(card.locator('.dv-split-row').filter({ hasText: 'Soup $7' }).filter({ hasText: 'Soup $8' })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('p06-side-by-side.png'), fullPage: true });
  await card.getByRole('radio', { name: 'Unified' }).click();

  // Choose to undo the second place (Coffee removed). Before the keep lands, someone edits the
  // file outside Diomedes: nothing is written, the card says so and offers the newer text.
  await card.getByRole('checkbox', { name: /Keep change 2 of 3/ }).uncheck();
  await expect(card.locator('.dv-undoing')).toHaveText('will be undone');
  await fs.writeFile(path.join(project.folder, FILE), `${PROPOSED}Tip jar\n`, 'utf8');
  await card.getByRole('button', { name: 'Keep 2 of 3 changes', exact: true }).click();
  await expect(card.getByRole('alert')).toContainText(
    `${FILE} was changed by someone outside Diomedes after this change was made, so nothing was written.`,
  );
  expect(await onDisk()).toBe(`${PROPOSED}Tip jar\n`);
  await card.getByRole('button', { name: 'Review again', exact: true }).click();
  await expect(card.locator('.cdiff-since')).toContainText('Since this change was made:');
  await expect(card.locator('.cdiff-since')).toContainText('Tip jar');
  expect((await state()).changes.find((change) => change.path === FILE)!.state).toBe('waiting');

  // The outside edit is taken back; the same partial keep now lands as one recorded revision.
  await fs.writeFile(path.join(project.folder, FILE), PROPOSED, 'utf8');
  await page.reload();
  await openThread(page);
  await card.getByRole('checkbox', { name: /Keep change 2 of 3/ }).uncheck();
  await card.getByRole('button', { name: 'Keep 2 of 3 changes', exact: true }).click();
  await expect(card.locator('.cdiff-state')).toHaveText('Kept 2 of 3 changes; undid 1');
  await expect(card.locator('.dv-decision')).toHaveText(['kept', 'undone', 'kept']);
  expect(await onDisk()).toBe(KEPT);
  const kept = await state();
  const evidence = kept.history.find((entry) => entry.kind === 'partial-keep')!;
  expect(evidence).toMatchObject({ actor: 'you', sessionId: null, taskId: task.id });
  expect(evidence.hunkReview!.hunks.map((hunk) => hunk.decision)).toEqual(['kept', 'undone', 'kept']);

  // A comment on the kept price line, resolved and reopened in place.
  await card.locator('.dv-row').filter({ hasText: 'Soup $8' }).hover();
  await card.getByRole('button', { name: 'Comment on line 3', exact: true }).click();
  await card.getByRole('textbox', { name: 'Comment on line 3' }).fill(COMMENT);
  await card.getByRole('button', { name: 'Save comment', exact: true }).click();
  const comment = card.locator('.dv-comment');
  await expect(comment).toContainText(COMMENT);
  await comment.getByRole('button', { name: 'Resolve', exact: true }).click();
  await expect(comment).toContainText('resolved');
  await comment.getByRole('button', { name: 'Reopen', exact: true }).click();
  await expect(comment.getByRole('button', { name: 'Resolve', exact: true })).toBeVisible();

  // "Revise with these comments" shows the exact message, then queues it as a follow-up; the
  // follow-up starts the next run through the ordinary admission path, with the comment in it.
  const saved = (await state()).reviewComments!;
  expect(saved).toHaveLength(1);
  expect(saved[0]).toMatchObject({ anchor: { hunk: 0, side: 'new', line: 3, quote: 'Soup $8' }, text: COMMENT });
  await review.getByRole('button', { name: 'Revise with these comments (1)', exact: true }).click();
  const revise = review.getByRole('group', { name: 'Revise with these comments' });
  await expect(revise.locator('.cdiff-message')).toHaveText(revisionRequest(saved));
  await page.screenshot({ path: testInfo.outputPath('p06-revise-preview.png'), fullPage: true });
  await revise.getByRole('button', { name: 'Queue the revision', exact: true }).click();
  await expect.poll(() => prompts.length, { timeout: 20_000 }).toBe(2);
  expect(prompts[1]).toContain(COMMENT);
  expect(prompts[1]).toContain(`${FILE}, change 1, line 3: "Soup $8"`);
  await expect(comment).toContainText('sent with a revision request');
  const after = await state();
  const followUp = after.followUps!.find((item) => item.id === after.reviewComments![0].sent!.followUpId)!;
  expect(followUp).toMatchObject({ state: 'delivered', text: revisionRequest(saved), sources: [FILE] });

  // From the file's version list: the run's version, what it changed, and a comment on it.
  await expect(pane(page)).toBeVisible();
  await fileRow(page, 'Menu').click();
  await fileRow(page, 'Prices.md').click();
  await pane(page).getByText(/^Versions \(\d+\)$/).click();
  const runVersion = versionsOf(after.history, FILE).find((version) => version.sha === evidence.files[0].before)!;
  await pane(page).getByRole('button', { name: new RegExp(`^${identityLabel(runVersion)}`) }).click();
  await pane(page).getByRole('radio', { name: 'Changes from the version before', exact: true }).click();
  const versionDiff = pane(page).locator('.dv');
  await expect(versionDiff.locator('.dv-head')).toHaveText(`2 lines added, 2 removed in ${FILE}`);
  await versionDiff.locator('.dv-row').filter({ hasText: 'Water $1' }).hover();
  await versionDiff.getByRole('button', { name: 'Comment on line 9', exact: true }).click();
  await versionDiff.getByRole('textbox', { name: 'Comment on line 9' }).fill('Water stays free for diners.');
  await versionDiff.getByRole('button', { name: 'Save comment', exact: true }).click();
  await expect(versionDiff.locator('.dv-comment')).toContainText('Water stays free for diners.');
  const onVersion = (await state()).reviewComments!.find((item) => item.target.kind === 'version')!;
  expect(onVersion).toMatchObject({ target: { path: FILE, sha: runVersion.sha }, anchor: { line: 9, quote: 'Water $1' } });
  await page.screenshot({ path: testInfo.outputPath('p06-version-compare.png'), fullPage: true });

  expect(errors).toEqual([]);
});
