import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test as base, expect, type Page } from '@playwright/test';
import { startInventoryReceiptsDemo } from '../scripts/inventory-receipts-demo.js';
import { receiptPendingKey } from '../client/inventory/receipt-client.js';

const test = base.extend<{ demo: Awaited<ReturnType<typeof startInventoryReceiptsDemo>> }>({
  demo: async ({}, use) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'diomedes-receipt-browser-'));
    const demo = await startInventoryReceiptsDemo(root);
    try {
      await use(demo);
    } finally {
      await demo.close();
      await fs.rm(root, { recursive: true, force: true });
    }
  },
});
async function review(page: Page, quantity = '3') {
  await page.getByLabel('Item and bin').selectOption({ index: 1 });
  await page.getByLabel('Quantity received').fill(quantity);
  await page.getByLabel('Receipt note').fill('Synthetic delivery note 001');
  await page.getByRole('button', { name: 'Review receipt', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Review received stock' })).toBeVisible();
}
const noOverflow = async (page: Page) =>
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);

test('receive and inspect the actual linked History, with a readable device layout', async ({
  page,
  demo,
}, info) => {
  await page.goto(demo.url);
  await expect(page.getByText(/Diomedes 0.2.0 development demonstration/)).toBeVisible();
  await expect(page.getByText('No stock receipts recorded.')).toBeVisible();
  await review(page);
  await noOverflow(page);
  await page.screenshot({ path: info.outputPath('receipt-review.png'), fullPage: true });
  // Two clicks in the same turn prove the synchronous dispatch guard, independent of React's rerender.
  await page
    .getByRole('button', { name: 'Confirm receipt' })
    .evaluate((button: HTMLButtonElement) => {
      button.click();
      button.click();
    });
  await expect(page.getByText('Stock receipt recorded.', { exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Received 3 each', exact: true })).toBeVisible();
  await page.getByText('Receipt and History evidence', { exact: true }).click();
  await expect(page.getByText('12 each to 15 each')).toBeVisible();
  const snapshot = await demo.fixture.service.view(demo.fixture.project.id, {});
  expect(snapshot.history).toHaveLength(1);
  expect(snapshot.history[0].history.id).toBe(snapshot.history[0].receipt.historyEntryId);
  await noOverflow(page);
  await page.screenshot({ path: info.outputPath('receipt-history.png'), fullPage: true });
  await page.getByRole('button', { name: 'Start another receipt' }).click();
  await page.getByLabel('Item and bin').selectOption({ index: 3 });
  await expect(page.getByText('Unknown', { exact: true })).toHaveCount(3);
  await expect(page.getByText('Not recorded', { exact: true })).toBeVisible();
});

test('a second device must refresh and review after a stock-version conflict', async ({
  page,
  demo,
}) => {
  const second = await page.context().newPage();
  try {
    await page.goto(demo.url);
    await second.goto(demo.url);
    await review(page, '3');
    await review(second, '2');
    await page.getByRole('button', { name: 'Confirm receipt' }).click();
    await expect(page.getByText('Stock receipt recorded.', { exact: true })).toBeVisible();
    await second.getByRole('button', { name: 'Confirm receipt' }).click();
    await expect(
      second.getByText('Stock changed. Refresh and review a new receipt before submitting again.'),
    ).toBeVisible();
    expect((await demo.fixture.service.view(demo.fixture.project.id, {})).history).toHaveLength(1);
    await second.getByRole('button', { name: 'Refresh and start a new review' }).click();
    await review(second, '2');
    await second.getByRole('button', { name: 'Confirm receipt' }).click();
    await expect(second.getByText('Stock receipt recorded.', { exact: true })).toBeVisible();
    const snapshot = await demo.fixture.service.view(demo.fixture.project.id, {});
    expect(snapshot.history).toHaveLength(2);
    expect(snapshot.catalog.balances[0].onHandMinor).toBe(17);
  } finally {
    await second.close();
  }
});

test('a committed receipt with a lost response survives reload and reconciles without a second POST', async ({
  page,
  demo,
}) => {
  let posts = 0;
  await page.route('**/api/inventory/receipts', async (route) => {
    posts++;
    await route.fetch();
    await route.abort('failed');
  });
  await page.goto(demo.url);
  await review(page);
  await page.getByRole('button', { name: 'Confirm receipt' }).click();
  await expect(
    page.getByText('The receipt outcome is unknown. Check its status before trying again.'),
  ).toBeVisible();
  expect(posts).toBe(1);
  await page.reload();
  await expect(
    page.getByText('This receipt needs a status check before you continue.'),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Check receipt status' }).click();
  await expect(page.getByText('Stock receipt recorded.', { exact: true })).toBeVisible();
  expect(posts).toBe(1);
  expect((await demo.fixture.service.view(demo.fixture.project.id, {})).history).toHaveLength(1);
});

test('a request lost before dispatch retries only after status, with the same saved intent', async ({
  page,
  demo,
}) => {
  let body: string | null = null;
  await page.route('**/api/inventory/receipts', async (route) => {
    body = route.request().postData();
    await route.abort('failed');
  });
  await page.goto(demo.url);
  await review(page);
  await page.getByRole('button', { name: 'Confirm receipt' }).click();
  await expect(
    page.getByText('The receipt outcome is unknown. Check its status before trying again.'),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'Retry same receipt' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Check receipt status' }).click();
  await expect(
    page.getByText('No receipt is recorded for this operation. You can retry the same receipt.'),
  ).toBeVisible();
  await page.unroute('**/api/inventory/receipts');
  const nextPost = page.waitForRequest(
    (request) => request.method() === 'POST' && request.url().endsWith('/receipts'),
  );
  await page.getByRole('button', { name: 'Retry same receipt' }).click();
  expect((await nextPost).postData()).toBe(body);
  await expect(page.getByText('Stock receipt recorded.', { exact: true })).toBeVisible();
});

test('read-only access and effect-time revocation cannot be bypassed by the form', async ({
  page,
  demo,
}) => {
  demo.fixture.control.access = 'read-only';
  await page.goto(demo.url);
  await expect(page.getByText('Read-only access', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Review receipt', exact: true })).toBeDisabled();
  demo.fixture.control.access = 'receive';
  await page.getByRole('button', { name: 'Refresh stock and history' }).click();
  await review(page);
  demo.fixture.control.revokeAtEffect = true;
  await page.getByRole('button', { name: 'Confirm receipt' }).click();
  await expect(page.getByText('Demo access revoked.', { exact: true })).toBeVisible();
  expect(demo.fixture.store.state(demo.fixture.project.id).history).toHaveLength(0);
  await expect(page.getByRole('button', { name: 'Start another receipt' })).toHaveCount(0);
});

test('a changed project binding clears a stale review without sending it', async ({
  page,
  demo,
}) => {
  await page.goto(demo.url);
  await review(page);
  await page.route('**/api/inventory/view', async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    body.catalog.scope.projectId = 'changed-project';
    await route.fulfill({ response, json: body });
  });
  await page.getByRole('button', { name: 'Refresh stock and history' }).click();
  await expect(
    page.getByText('The inventory binding changed. Reload to inspect the selected project.'),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'Confirm receipt' })).toHaveCount(0);
  expect(demo.fixture.store.state(demo.fixture.project.id).history).toHaveLength(0);
});

test('older receipt pages retain the project binding and cannot preserve a stale review', async ({
  page,
  demo,
}) => {
  const { service, project } = demo.fixture;
  let version = (await service.view(project.id, {})).catalog.balances[0].version;
  for (let index = 0; index < 21; index++) {
    const result = await service.execute(
      project.id,
      {
        kind: 'receive',
        operationId: `history-page-${index}`,
        itemId: 'bolt',
        siteId: 'workshop',
        binId: 'shelf-a',
        quantity: { minor: 1, scale: 0, unit: 'each' },
        expectedVersion: version,
      },
      {},
    );
    expect(result.status).toBe('applied');
    if (result.status !== 'applied') throw new Error('History setup did not apply.');
    version = result.receipt.changes[0].version;
  }
  await page.goto(demo.url);
  await expect(page.getByRole('heading', { name: 'Received 1 each', exact: true })).toHaveCount(20);
  await page.getByRole('button', { name: 'Show older receipts' }).click();
  await expect(page.getByRole('heading', { name: 'Received 1 each', exact: true })).toHaveCount(1);
  await page.getByRole('button', { name: 'Refresh stock and history' }).click();
  await review(page);
  await page.route('**/api/inventory/view?olderThan=*', async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    body.catalog.scope.projectId = 'changed-project';
    await route.fulfill({ response, json: body });
  });
  await page.getByRole('button', { name: 'Show older receipts' }).click();
  await expect(
    page.getByText('The inventory binding changed. Reload to inspect the selected project.'),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'Confirm receipt' })).toHaveCount(0);
  expect(demo.fixture.store.state(project.id).history).toHaveLength(21);
});

test('unavailable intent storage prevents dispatch', async ({ page, demo }) => {
  await page.addInitScript(() => {
    const setItem = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) {
      if (key.startsWith('diomedes.inventory.receipt.'))
        throw new Error('Intent storage unavailable.');
      return setItem.call(this, key, value);
    };
  });
  await page.goto(demo.url);
  await review(page);
  await page.getByRole('button', { name: 'Confirm receipt' }).click();
  await expect(page.getByText('Intent storage unavailable.', { exact: true })).toBeVisible();
  expect(demo.fixture.store.state(demo.fixture.project.id).history).toHaveLength(0);
});

test('unreadable saved intent blocks an existing review without overwriting the evidence', async ({
  page,
  demo,
}) => {
  await page.goto(demo.url);
  await review(page);
  const key = receiptPendingKey(demo.fixture.scope);
  await page.evaluate((key) => sessionStorage.setItem(key, '{broken'), key);
  await page.getByRole('button', { name: 'Refresh stock and history' }).click();
  await expect(page.getByRole('alert')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Confirm receipt' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Review receipt', exact: true })).toHaveCount(0);
  expect(await page.evaluate((key) => sessionStorage.getItem(key), key)).toBe('{broken');
  expect(demo.fixture.store.state(demo.fixture.project.id).history).toHaveLength(0);
});

test('the fixture exposes no desktop or purchasing API and refuses cross-origin access', async ({
  request,
  demo,
}) => {
  const headers = { 'X-Diomedes-Inventory': '1' };
  expect((await request.get(`${demo.url}/api/settings`, { headers })).status()).toBe(404);
  expect((await request.post(`${demo.url}/api/inventory/orders`, { headers })).status()).toBe(404);
  expect((await request.get(`${demo.url}/api/inventory/view`)).status()).toBe(403);
  expect(
    (
      await request.get(`${demo.url}/api/inventory/view`, {
        headers: { ...headers, Origin: 'https://example.invalid' },
      })
    ).status(),
  ).toBe(403);
  const build = await (await request.get(`${demo.url}/api/demo/build`, { headers })).json();
  expect(build).toMatchObject({
    version: '0.2.0',
    authentication: 'simulated-test-authorizer',
    purchasing: 'unavailable',
  });
});
