import { test, expect, type Page } from '@playwright/test';
import express from 'express';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../server/app';
import type { BusinessSetupView } from '../shared/business-setup';
import type { Project } from '../shared/types';
import type { WorkspaceView } from '../shared/workspaces';

/**
 * Browser proof of the screen between a finished questionnaire and a setup
 * that runs.
 *
 * The claims are the ones a person's decision rests on: the review says why
 * each field is there, it names what this build will not do instead of hiding
 * it, and turning the setup on is something they do rather than something that
 * happens. The questions themselves are answered over the API here — they have
 * their own browser proof in `workspace-ui.spec.ts`, and repeating them would
 * only make this file slower at proving something else.
 */
test.describe.configure({ mode: 'serial' });

const HEADERS = { 'Content-Type': 'application/json', 'X-Diomedes-Client': '1' };
const EVIDENCE = path.resolve('evidence/workspaces');
let application: Awaited<ReturnType<typeof createApp>> | undefined;
let server: Server | undefined;
let baseURL = '';
let fixtureRoot = '';

async function api<T>(route: string, method = 'GET', data?: unknown): Promise<T> {
  const response = await fetch(`${baseURL}/api${route}`, {
    method,
    headers: HEADERS,
    body: data === undefined ? undefined : JSON.stringify(data),
  });
  if (!response.ok)
    throw new Error(
      `Configuration fixture ${route} failed (${response.status}): ${await response.text()}`,
    );
  return response.json() as Promise<T>;
}

/** Answer the whole intake over the API, in the order the host asks. */
async function answerAll(organizationId: string) {
  const canned: Record<string, unknown> = {
    name: 'Ridge Cabinetry',
    industry: 'cabinetry',
    job: 'recurring-report',
    result: 'A weekly note a person reads before anyone acts on it.',
    sources: ['files', 'business-system'],
    people: 'small-team',
    locations: 'one',
    'human-required': ['sending', 'money'],
    'data-leaving': 'non-sensitive',
    host: 'The office desktop, weekdays.',
    'spend-cap': 120,
    'first-run': 'weekly',
  };
  const base = `/workspace/organizations/${organizationId}/setup`;
  await api(`${base}/start`, 'POST', {});
  let view = await api<BusinessSetupView>(base);
  for (let guard = 0; guard < 20 && view.step !== 'review'; guard += 1)
    view = await api<BusinessSetupView>(`${base}/answer`, 'POST', {
      questionId: view.step,
      value: canned[view.step] ?? null,
      unknown: canned[view.step] === undefined,
      expectedDigest: view.digest,
    });
  expect(view.state).toBe('proposal-ready');
}

test.beforeAll(async () => {
  const results = path.resolve('test-results');
  await fs.mkdir(results, { recursive: true });
  await fs.mkdir(EVIDENCE, { recursive: true });
  fixtureRoot = await fs.mkdtemp(path.join(results, 'configuration-ui-'));
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

  const project = await api<Project>('/projects/sample', 'POST', {});
  await api('/settings', 'PUT', {
    surface: 'console',
    detail: 'technical',
    // Onboarding is marked finished so the app opens on the Console rather
    // than on the first-run questions, which have their own proof elsewhere.
    onboarding: {
      work: 'business',
      detail: 'technical',
      familiarity: 'comfortable',
      resumeAt: 'done',
      completedAt: new Date().toISOString(),
    },
    openProjects: [project.id],
  });

  const created = await api<WorkspaceView>('/workspace/organizations', 'POST', {
    name: 'Ridge Cabinetry',
    industry: 'cabinetry',
  });
  const organization = created.organizations.find(
    (item) => item.organization.name === 'Ridge Cabinetry',
  )!.organization;
  await api('/workspace/switch', 'POST', { kind: 'business', organizationId: organization.id });
  await answerAll(organization.id);
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

async function openReview(page: Page) {
  await page.goto(`${baseURL}/`);
  await expect(page.locator('.console')).toBeVisible();
  await page.getByRole('button', { name: 'Change workspace' }).click();
  const panel = page.getByRole('dialog');
  await panel.getByRole('button', { name: 'Review the setup' }).click();
  return panel;
}

test('the review explains every field and says what this build will not do', async ({ page }) => {
  const panel = await openReview(page);
  await expect(panel.getByRole('heading', { name: 'Your setup, before it runs' })).toBeVisible();

  // Nothing has been prepared, so the screen offers to prepare rather than
  // showing an empty review.
  await panel.getByRole('button', { name: 'Prepare the setup' }).click();

  // With nothing running yet, everything is new — and every row carries the
  // recorded reason it is there.
  await expect(panel.getByRole('heading', { name: 'New' })).toBeVisible();
  const explanations = panel.locator('.ws-why');
  expect(await explanations.count()).toBeGreaterThan(0);
  for (const line of await explanations.allTextContents()) expect(line.trim()).not.toBe('');

  // The weekly schedule this business asked for is not built. It is named as
  // unavailable rather than quietly dropped or drawn as though it works.
  await expect(panel.getByRole('heading', { name: 'Not available yet' })).toBeVisible();
  await expect(panel.getByText(/recorded but stays inactive/i).first()).toBeVisible();

  // The business system it named is not connected, and the review says that in
  // words rather than printing a status id, while still letting the setup run.
  await expect(panel.getByText('Not connected', { exact: true }).first()).toBeVisible();
  await expect(panel.getByText(/can run with less than was asked for/i)).toBeVisible();
  await page.screenshot({ path: path.join(EVIDENCE, 'configuration-review.png'), fullPage: true });
});

test('turning the setup on is something a person does, and it then says what is running', async ({
  page,
}) => {
  const panel = await openReview(page);
  await expect(panel.getByRole('heading', { name: 'Your setup, before it runs' })).toBeVisible();
  // The setup prepared in the previous test is still staged and still inactive.
  await expect(panel.getByText(/Running now/)).toHaveCount(0);

  await panel.getByRole('button', { name: 'Turn it on' }).click();
  await expect(panel.getByText(/Running now: version 1/)).toBeVisible();

  // Having turned it on, a person can still read what they turned on. An
  // earlier pass showed only the comparison, so this panel went blank here.
  await expect(panel.getByRole('heading', { name: 'What is running' })).toBeVisible();
  await expect(panel.getByText('Weekly Operations Analyst')).toBeVisible();
  await expect(panel.getByRole('button', { name: 'Turn it on' })).toBeDisabled();
  await page.screenshot({ path: path.join(EVIDENCE, 'configuration-active.png'), fullPage: true });
});

test('a person can go back to change an answer instead of activating', async ({ page }) => {
  const panel = await openReview(page);
  await panel.getByRole('button', { name: 'Change an answer' }).click();
  await expect(panel.getByRole('heading', { name: 'Here is what you told us' })).toBeVisible();
  await expect(panel.getByText(/no rehearsal step yet/i)).toBeVisible();
  await page.screenshot({ path: path.join(EVIDENCE, 'configuration-revise.png') });
});
