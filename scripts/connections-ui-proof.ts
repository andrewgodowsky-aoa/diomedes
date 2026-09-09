import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium } from '@playwright/test';
import { startConnectionsDemo } from './connections-demo.js';
import { fixtureStockEvent } from '../server/connections/fixture.js';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'diomedes-connections-ui-'));
const output = path.resolve('evidence', 'connections');
await fs.mkdir(output, { recursive: true });
const demo = await startConnectionsDemo(root);
const browser = await chromium.launch({
  headless: true,
  executablePath:
    process.env.PLAYWRIGHT_EXECUTABLE_PATH ??
    (process.platform === 'win32'
      ? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
      : undefined),
});
const checks: string[] = [];
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1180 } });
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(demo.url);
  await page.getByTestId('connection-health').filter({ hasText: 'Connection stale' }).waitFor();
  await page.getByText('Read only', { exact: true }).waitFor();
  checks.push('stale and read-only visible');
  await page.getByRole('button', { name: 'Refresh sample' }).click();
  await page.getByTestId('connection-health').filter({ hasText: 'Healthy' }).waitFor();
  await page.getByText('Not tracked by source', { exact: true }).first().waitFor();
  checks.push('healthy, unknown quantity and all locations rendered');
  await page.getByRole('button', { name: 'Review proposal' }).click();
  await page.getByText('Proposed rule / inactive until activated', { exact: true }).waitFor();
  assert.equal(
    demo.fixture.service
      .snapshot(demo.fixture.project.id)
      .rules.active.filter((rule) => rule.type === 'workflow').length,
    0,
  );
  checks.push('natural-language proposal remains inactive before explicit activation');
  await page.getByRole('button', { name: 'Activate fixture rule' }).click();
  await page.getByText('Active workflow rules: low-stock v1', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Simulate low stock' }).click();
  await page.getByTestId('issue-count').filter({ hasText: '1 open' }).waitFor();
  await page.getByRole('button', { name: 'Repeat sample event' }).click();
  await page.waitForFunction(() => !document.querySelector('button')?.disabled);
  assert.equal(demo.fixture.store.state(demo.fixture.project.id).tasks.length, 1);
  await page.getByText('Why was this created?', { exact: true }).click();
  await page
    .getByText(/Source time:/)
    .first()
    .waitFor();
  checks.push('signed event and duplicate produce one issue with rule/source evidence');
  // Hold business processing to prove that HTTP acknowledgement follows durable
  // ingress without waiting for triage. Restore the real consumer immediately.
  const service = demo.fixture.service,
    drain = service.drain.bind(service);
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  service.drain = async (projectId) => {
    await held;
    await drain(projectId);
  };
  const at = new Date().toISOString(),
    raw = fixtureStockEvent(at, 3, '30000000-0000-4000-8000-000000000099');
  const began = performance.now();
  try {
    const accepted = await fetch(`${demo.url}/api/fixture/webhook`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Toast-Signature': demo.fixture.sign(raw, at),
      },
      body: raw,
    });
    assert.equal(accepted.status, 202);
    const receipt = service.snapshot(demo.fixture.project.id).connections.inbox.at(-1)!;
    assert.equal(receipt.state, 'pending');
    checks.push(
      `HTTP 202 after durable inbox and before held triage (${Math.round(performance.now() - began)} ms locally)`,
    );
  } finally {
    service.drain = drain;
    release();
  }
  await drain(demo.fixture.project.id);
  assert.equal(demo.fixture.store.state(demo.fixture.project.id).tasks.length, 1);
  await page.reload();
  await page.getByRole('button', { name: 'Repeat sample event' }).click();
  await page.waitForFunction(() => !document.querySelector('button')?.disabled);
  assert.equal(demo.fixture.store.state(demo.fixture.project.id).tasks.length, 1);
  assert.equal(service.snapshot(demo.fixture.project.id).connections.inbox.length, 2);
  await page.getByText('Why was this created?', { exact: true }).click();
  await page.screenshot({ path: path.join(output, 'connections-desktop.png'), fullPage: true });
  await page.setViewportSize({ width: 720, height: 1100 });
  await page.screenshot({ path: path.join(output, 'connections-narrow.png'), fullPage: true });
  assert.equal(
    await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth),
    false,
  );
  checks.push('narrow layout has no horizontal overflow');
  await page.getByRole('button', { name: 'Pause', exact: true }).click();
  await page.getByTestId('connection-health').filter({ hasText: 'Paused' }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Refresh sample' }).isDisabled(), true);
  await page.getByRole('button', { name: 'Disconnect', exact: true }).click();
  await page.getByTestId('connection-health').filter({ hasText: 'Disconnected' }).waitFor();
  const revoked = await fetch(`${demo.url}/api/fixture/read`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Diomedes-Fixture': '1' },
    body: '{}',
  });
  assert.equal(revoked.status, 403);
  checks.push('pause/disconnect disable controls and server denies reads');
  await fetch(`${demo.url}/api/fixture/control`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Diomedes-Fixture': '1' },
    body: JSON.stringify({ status: 'authorization-required' }),
  });
  await page.reload();
  await page
    .getByTestId('connection-health')
    .filter({ hasText: 'Reauthorization required' })
    .waitFor();
  await page.getByRole('button', { name: 'Reconnect fixture', exact: true }).click();
  await page.getByTestId('connection-health').filter({ hasText: 'Connection stale' }).waitFor();
  checks.push('reauthorization and reconnect freshness are truthful');
  const csrf = await fetch(`${demo.url}/api/fixture/read`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  });
  assert.equal(csrf.status, 403);
  const invalidWebhook = await fetch(`${demo.url}/api/fixture/webhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  });
  assert.equal(invalidWebhook.status, 403);
  checks.push('fixture controls and webhook validation reject invalid requests');
  assert.deepEqual(errors, []);
  await fs.writeFile(
    path.join(output, 'ui-proof.json'),
    JSON.stringify(
      {
        at: new Date().toISOString(),
        checks,
        errors,
        proof:
          'Source fixture UI in Edge; no packaged desktop, production credentials or live provider.',
      },
      null,
      2,
    ),
  );
  console.log(
    JSON.stringify({ passed: checks.length, checks, errors, screenshots: output }, null, 2),
  );
} finally {
  await browser.close();
  await demo.close();
  await fs.rm(root, { recursive: true, force: true });
}
