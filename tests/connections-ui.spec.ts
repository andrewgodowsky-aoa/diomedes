import { test, expect } from '@playwright/test';
import fs from 'node:fs/promises';

test('Connections works through ordinary Console and Workbook navigation', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', (error) => errors.push(error.message));
  const headers = { 'Content-Type': 'application/json', 'X-Diomedes-Client': '1' };
  const projectResponse = await page.request.post('/api/projects/sample', { headers, data: {} });
  expect(projectResponse.ok()).toBeTruthy(); const project = await projectResponse.json();
  const settings = { detail: 'technical', surface: 'console', openProjects: [project.id],
    onboarding: { work: 'business', detail: 'technical', familiarity: 'some', resumeAt: 'done', completedAt: new Date().toISOString() } };
  expect((await page.request.put('/api/settings', { headers, data: settings })).ok()).toBeTruthy();
  await page.goto('/'); await page.getByRole('button', { name: 'Connections', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Connections', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Prepare connection proposal' }).click();
  await expect(page.getByText('Choose the reported numeric quantity threshold for a manager issue.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Approve synthetic connection' })).toHaveCount(0);
  await page.getByLabel('Reported quantity threshold').fill('5');
  await page.getByLabel('Service starts').fill('00:00'); await page.getByLabel('Service ends').fill('23:59');
  await page.getByRole('button', { name: 'Prepare connection proposal' }).click();
  await page.getByRole('button', { name: 'Approve synthetic connection' }).click();
  await expect(page.getByTestId('connection-health')).toHaveText('stale');
  await page.getByRole('button', { name: 'Refresh availability' }).click();
  await expect(page.getByTestId('connection-health')).toHaveText('healthy');
  await expect(page.getByRole('cell', { name: 'Not tracked', exact: true })).toHaveCount(3);
  await page.getByRole('button', { name: 'Run correction demo' }).click();
  await expect(page.getByText('completed / 3 scripted model calls / 1 tool calls')).toBeVisible();
  await page.getByRole('button', { name: 'Propose improvement from corrections' }).click();
  await expect(page.getByLabel('Rule revision proposal')).toBeVisible();
  await page.getByRole('button', { name: 'Adopt reviewed revision' }).click();
  await expect(page.getByText('stock-investigator-notes v2', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Review rollback to guidance v1' }).click();
  await page.getByRole('button', { name: 'Adopt reviewed revision' }).click();
  await expect(page.getByText('stock-investigator-notes v3', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Deliver signed stock event' }).click();
  await expect(page.getByText('1 durable receipt(s). 1 manager task(s).')).toBeVisible();
  await page.getByRole('button', { name: 'Replay same event' }).click();
  await expect(page.getByText('1 durable receipt(s). 1 manager task(s).')).toBeVisible();
  await fs.mkdir('evidence/windows-release', { recursive: true });
  await page.getByText('Review generated connection examples', { exact: true }).click();
  await page.getByRole('button', { name: 'Load generated candidates' }).click();
  for (const name of ['library', 'helpdesk']) {
    await page.getByRole('button', { name: `Approve ${name} fixture`, exact: true }).click();
    await page.getByRole('button', { name: `Run ${name} MCP check`, exact: true }).click();
    await expect(page.getByLabel('MCP result')).toContainText(name === 'library' ? 'conn_library_list_books' : 'conn_helpdesk_list_tickets');
  }
  await page.locator('.connection-desktop').evaluate((element) => { element.scrollTop = 0; });
  await page.screenshot({ path: 'evidence/windows-release/connections-console.png', fullPage: true });
  await page.setViewportSize({ width: 760, height: 960 });
  await expect(page.getByRole('heading', { name: 'Connections', exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: 'evidence/windows-release/connections-narrow.png', fullPage: true });
  expect((await page.request.put('/api/settings', { headers, data: { surface: 'workbook', lastPage: { [project.id]: 'connections' } } })).ok()).toBeTruthy();
  await page.reload(); await expect(page.getByRole('heading', { name: 'Reported availability' })).toBeVisible();
  await page.getByRole('button', { name: 'Pause connection', exact: true }).click();
  await expect(page.getByTestId('connection-health')).toHaveText('paused');
  await page.getByRole('button', { name: 'Enable synthetic connection for this session' }).click();
  await expect(page.getByTestId('connection-health')).toHaveText('stale');
  expect(errors).toEqual([]);
});
