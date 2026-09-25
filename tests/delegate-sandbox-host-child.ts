/**
 * Sandbox crash fixture: a real host starts a Diomedes loop whose delegate
 * writes a file in its sandbox and then exits the process abruptly, during its
 * next model call. The stub route's model steps are local, so that call is
 * safely repeated after the restart. `tests/delegate-sandbox-host.test.ts`
 * reopens the same data folder and proves the sandbox and the child's work
 * survived, the child resumed in it, and the sandbox is removed at the end.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { createApp } from '../server/app.js';
import type { Store } from '../server/store.js';
import { TEAM_STUB_ACCOUNT_ROUTE } from './fixtures/team-loop-stub.js';
import { localDelegateRoutes } from './fixtures/sandbox-loop-stub.js';

const [root, projectId, taskId] = process.argv.slice(2);
if (!root || !projectId || !taskId) throw new Error('Invalid crash fixture arguments.');
const app = await createApp({
  dataDir: path.join(root, 'data'),
  projectRoot: path.join(root, 'projects'),
  loopModelRoutes: localDelegateRoutes(() => process.exit(17)),
});
const store: Store = app.locals.store;
await store.saveSettings({
  ...store.settings,
  services: { ...(store.settings.services ?? {}), 'google-vertex': true, 'google-vertexAccountRoute': TEAM_STUB_ACCOUNT_ROUTE },
});
const server = app.listen(0, '127.0.0.1');
await new Promise<void>((resolve) => server.once('listening', resolve));
const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
const post = (route: string, method: string, body: unknown) =>
  fetch(`${url}/api/projects/${projectId}${route}`, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Diomedes-Client': '1' },
    body: JSON.stringify(body),
  });
const shared = await post('/cloud-sharing', 'PUT', {
  expectedVersion: 0,
  routes: ['google-vertex'],
  documents: ['order.md', 'delivery.md'],
  shareConversationHistory: false,
  shareReviewPackets: false,
});
if (!shared.ok) throw new Error(`Sharing failed: ${shared.status} ${await shared.text()}`);
const response = await post('/loop/start', 'POST', {
  protocolVersion: 1,
  commandId: 'crash-sandbox',
  taskId,
  goal: 'Compare the order with the delivery and write the report.',
  route: 'native-fixture',
  sources: ['order.md', 'delivery.md'],
  consent: true,
  delegate: { route: 'google-vertex' },
  applyScope: ['Notes'],
});
if (!response.ok) throw new Error(`Start failed: ${response.status} ${await response.text()}`);
const { runId } = (await response.json()) as { runId: string };
await fs.writeFile(path.join(root, 'crash-run.txt'), runId);
await new Promise((done) => setTimeout(done, 20_000));
throw new Error('The delegate never reached its second call.');
