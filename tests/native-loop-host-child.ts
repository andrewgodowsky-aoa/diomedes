/**
 * H13 crash fixture: a real host starts a Diomedes loop whose delegate route
 * hangs, and the process exits abruptly while the delegate's model call is in
 * flight. `tests/native-loop-host.test.ts` reopens the same data folder and
 * proves the loop and its child are recovered from their records.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { createApp } from '../server/app.js';
import type { HarnessHost } from '../server/harness/host.js';
import type { Store } from '../server/store.js';
import { STUB_ACCOUNT_ROUTE, stubRoutes } from './fixtures/native-loop-stub.js';

const [root, projectId, taskId] = process.argv.slice(2);
if (!root || !projectId || !taskId) throw new Error('Invalid crash fixture arguments.');
const app = await createApp({
  dataDir: path.join(root, 'data'),
  projectRoot: path.join(root, 'projects'),
  loopModelRoutes: stubRoutes('hang'),
});
const store: Store = app.locals.store;
const host: HarnessHost = app.locals.harness;
await store.saveSettings({
  ...store.settings,
  services: { ...(store.settings.services ?? {}), 'google-vertex': true, 'google-vertexAccountRoute': STUB_ACCOUNT_ROUTE },
});
const server = app.listen(0, '127.0.0.1');
await new Promise<void>((resolve) => server.once('listening', resolve));
const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
const shared = await fetch(`${url}/api/projects/${projectId}/cloud-sharing`, {
  method: 'PUT',
  headers: { 'Content-Type': 'application/json', 'X-Diomedes-Client': '1' },
  body: JSON.stringify({
    expectedVersion: 0,
    routes: ['google-vertex'],
    documents: ['order.md', 'delivery.md'],
    shareConversationHistory: false,
    shareReviewPackets: false,
  }),
});
if (!shared.ok) throw new Error(`Sharing failed: ${shared.status} ${await shared.text()}`);
const response = await fetch(`${url}/api/projects/${projectId}/loop/start`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'X-Diomedes-Client': '1' },
  body: JSON.stringify({
    protocolVersion: 1,
    commandId: 'crash-loop',
    taskId,
    goal: 'Compare the order with the delivery and write the report.',
    route: 'native-fixture',
    sources: ['order.md', 'delivery.md'],
    consent: true,
    delegate: { route: 'google-vertex' },
  }),
});
if (!response.ok) throw new Error(`Start failed: ${response.status} ${await response.text()}`);
const { runId } = (await response.json()) as { runId: string };
await fs.writeFile(path.join(root, 'crash-run.txt'), runId);
for (const deadline = Date.now() + 20_000; Date.now() < deadline; ) {
  const child = await host.runs.get(`${runId}-d1`).catch(() => null);
  if (child?.steps.some((step) => step.intent.stepId === 'model:0' && step.state === 'running')) process.exit(17);
  await new Promise((done) => setTimeout(done, 10));
}
throw new Error('The delegate never reached its model call.');
