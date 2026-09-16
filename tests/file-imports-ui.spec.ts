import { expect, test } from '@playwright/test';
import express from 'express';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../server/app.js';
import type { Project, ProjectState } from '../shared/types.js';
import type { WorkspaceView } from '../shared/workspaces.js';
import type { BusinessSetupView } from '../shared/business-setup.js';
import type { ConfigurationView } from '../shared/configuration.js';

// Only setup identity/intake are prepared over the API. The two invented source
// exports live OUTSIDE the project, like normal downloads. The UI must import
// them, select their copies and run the activated brief; no project-file fixture.
let app: Awaited<ReturnType<typeof createApp>>;
let server: Server;
let url: string;
let root: string;
let project: Project;
let organizationId: string;
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
async function launch() {
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
  const dist = path.resolve(process.env.DIOMEDES_IMPORT_UI_DIST ?? 'dist');
  const built = (await fs.stat(path.join(dist, 'index.html'))).mtimeMs;
  for (const source of [
    'client/console/ImportFiles.tsx',
    'client/console/BriefFiles.tsx',
    'client/console/FilesPane.tsx',
    'client/console/Workspaces.tsx',
    'client/console/file-imports.css',
    'shared/file-imports.ts',
  ])
    expect(
      built,
      `Build the UI before this smoke: ${source} is newer than ${dist}.`,
    ).toBeGreaterThan((await fs.stat(path.resolve(source))).mtimeMs);
  app.use(express.static(dist));
  app.get('/{*path}', (_req, res) => res.sendFile(path.join(dist, 'index.html')));
  server.on('request', app);
}
async function stop() {
  await app.locals.close();
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}
test.beforeAll(async () => {
  await fs.mkdir(path.resolve('test-results'), { recursive: true });
  root = await fs.mkdtemp(path.resolve('test-results/fil02-ui-'));
  await fs.mkdir(path.join(root, 'downloads'));
  await fs.writeFile(
    path.join(root, 'downloads', 'room-export.csv'),
    '\ufeffitem,count\r\nTables,7\r\n',
  );
  await fs.writeFile(
    path.join(root, 'downloads', 'kitchen-export.md'),
    'Restock the welcome leaflets by Friday.\n![Remote image](https://example.invalid/export-image.png)\n<script>document.body.dataset.importExecuted="yes"</script>',
  );
  await launch();
  project = await api<Project>('/projects', 'POST', { name: 'FIL-02 operations' });
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
  const view = await api<WorkspaceView>('/workspace/organizations', 'POST', {
    name: 'FIL-02 fictional bistro',
    industry: 'restaurant',
  });
  organizationId = view.organizations.at(-1)!.organization.id;
  const base = `/workspace/organizations/${organizationId}`;
  const answers: Record<string, unknown> = {
    name: 'Fictional bistro',
    industry: 'restaurant',
    job: 'recurring-report',
    result: 'A weekly operations brief for review.',
    sources: ['files'],
    people: 'small-team',
    locations: 'one',
    'human-required': ['sending', 'money'],
    'data-leaving': 'non-sensitive',
    host: 'Office desktop',
    'spend-cap': 120,
    'first-run': 'manual',
  };
  await api(`${base}/setup/start`, 'POST', {});
  let setup = await api<BusinessSetupView>(`${base}/setup`);
  for (let guard = 0; setup.step !== 'review' && guard < 20; guard++)
    setup = await api<BusinessSetupView>(`${base}/setup/answer`, 'POST', {
      questionId: setup.step,
      value: answers[setup.step] ?? null,
      unknown: answers[setup.step] === undefined,
      expectedDigest: setup.digest,
    });
  expect(setup.state).toBe('proposal-ready');
  await api(`${base}/configuration/compile`, 'POST', {});
  await api(`${base}/output`, 'POST', { projectId: project.id });
});
test.afterAll(stop);

test('imports exports through Files, removes a source, runs and revises the activated brief, and survives restart', async ({
  page,
}) => {
  test.setTimeout(120_000);
  const externalRequests: string[] = [];
  await page.route('**/*', async (route) => {
    const requested = new URL(route.request().url());
    if (requested.protocol.startsWith('http') && requested.hostname !== '127.0.0.1') {
      externalRequests.push(requested.href);
      await route.abort();
    } else await route.continue();
  });
  await page.goto(url);
  await expect(page.locator('.console')).toBeVisible();
  await page.getByRole('button', { name: 'Change workspace' }).click();
  await page.getByRole('button', { name: 'Review the setup' }).click();
  await page.getByRole('button', { name: 'Turn it on' }).click();
  await expect(page.getByText(/Running now: version 1/)).toBeVisible();
  await page.getByRole('button', { name: 'Close dialog' }).click();
  // Closing configuration returns to Workspaces.
  if (await page.getByRole('dialog').count())
    await page.getByRole('button', { name: 'Close dialog' }).click();
  await page.getByRole('button', { name: 'Files', exact: true }).click();
  await page.getByRole('button', { name: 'Import files', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Import export files' });
  await dialog.getByLabel('Folder on this computer').fill(path.join(root, 'downloads'));
  await dialog.getByRole('button', { name: 'Open folder', exact: true }).click();
  await dialog.getByRole('button', { name: /^room-export.csv/ }).click();
  await dialog.getByRole('button', { name: /^kitchen-export.md/ }).click();
  await dialog.getByRole('button', { name: 'Remove kitchen-export.md' }).click();
  await expect(dialog.getByLabel('Selected exports')).not.toContainText('kitchen-export.md');
  await dialog.getByRole('button', { name: /^kitchen-export.md/ }).click();
  await expect(dialog.getByLabel('Selected exports')).toContainText('kitchen-export.md');
  await page.screenshot({ path: 'test-results/fil02-import-selection.png' });
  await dialog.getByRole('button', { name: 'Import selected files' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole('complementary', { name: 'Files', exact: true })).toContainText(
    'Tables,7',
  );
  const imported = await api<ProjectState>(`/projects/${project.id}/state`);
  expect(imported.project.packs ?? []).toEqual([]);
  expect(imported.history.filter((entry) => entry.label === 'Imported exports')).toHaveLength(1);
  expect(imported.needs).toEqual([]);
  const pane = page.getByRole('complementary', { name: 'Files', exact: true });
  await pane.getByRole('button', { name: 'Back', exact: true }).click();
  await pane.getByRole('button', { name: /kitchen-export.md/ }).click();
  await expect(pane).toContainText('Restock the welcome leaflets');
  expect(await pane.locator('img, script').count()).toBe(0);
  expect(await page.locator('body').getAttribute('data-import-executed')).toBeNull();
  expect(externalRequests).toEqual([]);

  await page.getByRole('button', { name: 'Change workspace' }).click();
  const sourceGroup = page.getByRole('group', { name: 'Weekly brief sources' });
  const select = async (name: string) => {
    const checkbox = sourceGroup.getByLabel(name);
    await checkbox.click();
    await expect(checkbox).toBeChecked();
  };
  await select('Imports/room-export.csv');
  await select('Imports/kitchen-export.md');
  await sourceGroup.getByLabel('Imports/kitchen-export.md').uncheck();
  await page.getByRole('button', { name: 'Prepare the weekly brief' }).click();
  await expect(page.getByText(/Drafted into FIL-02 operations/)).toBeVisible();
  const configuration = await api<ConfigurationView>(
    `/workspace/organizations/${organizationId}/configuration`,
  );
  const destination = configuration.active!.proposal.expectedOutputs[0]!.destination;
  const readBrief = () => fs.readFile(path.join(project.folder, destination), 'utf8');
  expect(await readBrief()).toContain('Tables,7');
  expect(await readBrief()).not.toContain('Restock');
  expect(await readBrief()).not.toContain('could not be read');
  await page.screenshot({ path: 'test-results/fil02-selected-brief.png' });

  // A project copy changed after selection must be reselected, not silently read.
  await fs.writeFile(path.join(project.folder, 'Imports/room-export.csv'), 'item,count\nTables,9');
  await page.getByRole('button', { name: 'Prepare the weekly brief' }).click();
  await expect(page.getByRole('dialog').getByRole('alert')).toContainText('changed or disappeared');
  expect(await readBrief()).toContain('Tables,7');
  await sourceGroup.getByLabel('Imports/room-export.csv').uncheck();
  await select('Imports/room-export.csv');
  await select('Imports/kitchen-export.md');
  await page.getByRole('button', { name: 'Prepare the weekly brief' }).click();
  await expect(page.getByText(/Drafted into FIL-02 operations/)).toBeVisible();
  const final = await readBrief();
  expect(final).toContain('Tables,9');
  expect(final).toContain('Restock');
  expect(final).toContain('SHA-256:');
  expect(await fs.readFile(path.join(root, 'downloads/room-export.csv'), 'utf8')).toContain(
    'Tables,7',
  );
  await stop();
  await launch();
  await page.goto(url);
  await expect(page.locator('.console')).toBeVisible();
  const reopened = await api<ProjectState>(`/projects/${project.id}/state`);
  expect(reopened.history.filter((entry) => entry.kind === 'weekly-brief')).toHaveLength(2);
  expect(await readBrief()).toBe(final);
  expect(externalRequests).toEqual([]);
  await page.screenshot({ path: 'test-results/fil02-restarted.png' });
});
