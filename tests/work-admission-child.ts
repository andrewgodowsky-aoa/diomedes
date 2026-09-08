import fs from 'node:fs/promises';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { createApp } from '../server/app.js';
import type { Store } from '../server/store.js';

// Abrupt process exits deliberately bypass close(): the parent restarts the exact
// synthetic store and verifies durable state, rather than simulating a graceful stop.
const [root, projectId, taskId, phase] = process.argv.slice(2);
if (!root || !projectId || !taskId || !['before', 'admitted', 'dispatched'].includes(phase))
  throw new Error('Invalid admission crash fixture arguments.');
const app = await createApp({
  dataDir: path.join(root, 'data'),
  projectRoot: path.join(root, 'projects'),
  nativeGenerator: async () => {
    await fs.writeFile(path.join(root, 'adapter-invoked.txt'), 'once', { flag: 'wx' });
    process.exit(72);
  },
});
const store: Store = app.locals.store;
const persist = store.persist.bind(store);
store.persist = async (state) => {
  const admitting = state.sessions.some(
    (session) => session.receipt?.commandId === 'crash-command',
  );
  if (admitting && phase === 'before') process.exit(70);
  await persist(state);
  if (admitting && phase === 'admitted') process.exit(71);
};
const server = app.listen(0, '127.0.0.1');
await new Promise<void>((resolve) => server.once('listening', resolve));
const port = (server.address() as AddressInfo).port;
await fetch(`http://127.0.0.1:${port}/api/projects/${projectId}/work/start`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'X-Diomedes-Client': '1' },
  body: JSON.stringify({
    protocolVersion: 1,
    commandId: 'crash-command',
    taskId,
    route: 'codex',
    sources: ['Brief.md'],
    consent: true,
  }),
});
throw new Error('The crash fixture unexpectedly returned from Work start.');
