import { expect, test, type Page } from '@playwright/test';
import express from 'express';
import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../server/app';
import type { Conversation, Project } from '../shared/types';

// P07 in the built Console against the production routes: the Software
// Engineering pack's Repository section in Files, on a fixture repository.
// It is absent where the pack is off; on, it shows the branch, changed files
// and commits, a readable diff, context for the open thread, and a declared
// command that runs only after Go ahead on exactly the request shown.
let app: Awaited<ReturnType<typeof createApp>>;
let server: Server;
let url: string;
let project: Project;
let plain: Project;
let repo: string;
const headers = { 'Content-Type': 'application/json', 'X-Diomedes-Client': '1' };
async function api<T>(route: string, method = 'GET', body?: unknown): Promise<T> {
  const response = await fetch(`${url}/api${route}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  expect(response.ok, `${route}: ${response.status}`).toBe(true);
  return response.json() as Promise<T>;
}
const git = (...args: string[]) =>
  execFileSync('git', args, { cwd: repo, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1' } });
const pane = (page: Page) => page.getByRole('complementary', { name: 'Files', exact: true });
const section = (page: Page) => pane(page).getByRole('region', { name: 'Repository', exact: true });

test.beforeAll(async () => {
  await fs.mkdir(path.resolve('test-results'), { recursive: true });
  const root = realpathSync.native(await fs.mkdtemp(path.resolve('test-results/p07-software-')));
  repo = path.join(root, 'compiler');
  await fs.mkdir(repo);
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'Grace Hopper');
  git('config', 'user.email', 'grace@example.com');
  git('config', 'commit.gpgsign', 'false');
  await fs.writeFile(path.join(repo, 'README.md'), '# Compiler\n\nParses the language.\n');
  await fs.writeFile(path.join(repo, 'check.js'), "console.log('12 checks passed');\n");
  git('add', '.');
  git('commit', '-q', '-m', 'Start the compiler');
  await fs.writeFile(path.join(repo, 'README.md'), '# Compiler\n\nParses and optimises the language.\n');

  server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  url = `http://127.0.0.1:${port}`;
  app = await createApp({
    port,
    clientPort: port,
    dataDir: path.join(root, 'data'),
    projectRoot: path.join(root, 'projects'),
    reviewerAdapter: null,
  });
  const dist = path.resolve('dist');
  const built = (await fs.stat(path.join(dist, 'index.html'))).mtimeMs;
  for (const source of [
    'client/console/Repository.tsx',
    'client/console/repository.css',
    'client/console/FilesPane.tsx',
    'client/console/Composer.tsx',
    'client/console/Shell.tsx',
    'shared/software-pack.ts',
  ])
    expect(built, `Build first: ${source}`).toBeGreaterThan((await fs.stat(source)).mtimeMs);
  app.use(express.static(dist));
  app.get('/{*path}', (_req, res) => res.sendFile(path.join(dist, 'index.html')));
  server.on('request', app);

  plain = await api<Project>('/projects', 'POST', { name: 'P07 plain' });
  project = await api<Project>('/projects', 'POST', { name: 'P07 compiler', folder: repo });
  for (const each of [plain, project]) {
    const thread = await api<Conversation>(`/projects/${each.id}/threads`, 'POST', { mode: 'ask' });
    await api(`/projects/${each.id}/threads/${thread.id}`, 'PUT', { engine: 'sample', mode: 'ask' });
  }
  await api(`/projects/${project.id}/packs/diomedes.software-engineering/activate`, 'POST');
  await api(`/projects/${project.id}/software/commands`, 'PUT', { commands: [{ command: 'node check.js' }] });
  await api('/settings', 'PUT', {
    detail: 'technical',
    openProjects: [plain.id, project.id],
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

test('the Repository section: absent where the pack is off; Git view, diff, context and an approved command run where it is on', async ({
  page,
}) => {
  test.setTimeout(120_000);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.addInitScript(() => {
    localStorage.setItem('console.files.open', 'true');
    localStorage.setItem('console.files.width', '460');
  });
  await page.goto(url);

  // Off: the plain project's Files pane has no Repository section at all.
  await page.getByRole('button', { name: 'P07 plain', exact: true }).click();
  await expect(pane(page)).toBeVisible();
  await expect(pane(page).getByRole('button', { name: 'Import files', exact: true })).toBeVisible();
  await expect(section(page)).toHaveCount(0);

  // On: branch, changed files, commits with author and message.
  await page.getByRole('button', { name: 'P07 compiler', exact: true }).click();
  await expect(section(page)).toBeVisible();
  await expect(section(page).locator('.repo-branch')).toHaveText(/^main · [0-9a-f]{7}$/);
  const changed = section(page).getByRole('list', { name: 'Changed files' });
  await expect(changed.getByRole('button', { name: 'README.md', exact: true })).toBeVisible();
  const commits = section(page).getByRole('list', { name: 'Recent commits' });
  await expect(commits).toContainText('Start the compiler');
  await expect(commits).toContainText('Grace Hopper');

  // The readable diff of one changed file, against HEAD.
  await changed.getByRole('button', { name: 'README.md', exact: true }).click();
  await expect(section(page).getByText(/1 line added, 1 removed in README\.md/)).toBeVisible();
  await expect(section(page).getByText('Parses and optimises the language.', { exact: false }).first()).toBeVisible();
  await section(page).getByRole('button', { name: '← Repository' }).click();

  // Context: the changed file attaches to the open thread, and the diff lands in the message box.
  await section(page).getByRole('button', { name: 'Attach changed files', exact: true }).click();
  await expect(page.getByLabel('Attached files').getByRole('button', { name: 'README.md', exact: true })).toBeVisible();
  await expect(section(page).getByRole('status')).toContainText(/Attached 1 file to your next message · ~\d+ tokens estimated/);
  await section(page).getByRole('button', { name: 'Add diff to message', exact: true }).click();
  const composer = page.getByRole('textbox', { name: 'Message this thread', exact: true });
  await expect(composer).toHaveValue(/^```diff\ndiff --git a\/README\.md b\/README\.md[\s\S]*\+Parses and optimises the language\.\n```$/);
  await expect(section(page).getByRole('status')).toContainText(/Added the diff of 1 file to your message · ~\d+ tokens estimated/);

  // A declared command asks first, runs only after Go ahead, and shows its recorded result.
  const commands = section(page).getByRole('list', { name: 'Declared commands' });
  await commands.getByRole('button', { name: 'Run', exact: true }).click();
  const approval = section(page).getByRole('group', { name: 'Approval needed' });
  await expect(approval).toContainText('Run node check.js in the project folder?');
  await expect(approval).toContainText('without a shell');
  await expect(commands.getByRole('button', { name: 'Run', exact: true })).toBeDisabled();
  await approval.getByRole('button', { name: 'Go ahead', exact: true }).click();
  await expect(approval).toHaveCount(0);
  const result = commands.locator('.repo-result summary');
  await expect(result).toContainText('Passed');
  await expect(result).toContainText('exit 0');
  await result.click();
  await expect(commands.locator('.repo-output')).toHaveText('12 checks passed\n');

  // A shell line is refused where it is declared, and nothing is added.
  await section(page).getByRole('textbox', { name: 'Command to declare' }).fill('node check.js && echo pwned');
  await section(page).getByRole('button', { name: 'Declare', exact: true }).click();
  await expect(section(page).getByRole('alert')).toContainText('a character a shell would interpret');
  await expect(commands.getByRole('listitem')).toHaveCount(1);

  // Nothing in the section overflows the pane (decision 5).
  const overflow = await section(page).evaluate((element) => element.scrollWidth - element.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
  expect(errors).toEqual([]);
});
