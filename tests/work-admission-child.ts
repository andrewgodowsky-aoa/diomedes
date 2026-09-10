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
    try {
      await fs.writeFile(path.join(root, 'adapter-invoked.txt'), 'once', { flag: 'wx' });
    } catch {
      // A second concurrent invocation raced the first past the route guard:
      // unsafe redispatch. Report it with its own exit code so the parent test
      // cannot mistake it for the intended single dispatch.
      await fs
        .writeFile(path.join(root, 'adapter-redispatched.txt'), 'second', { flag: 'w' })
        .catch(() => undefined);
      process.exit(73);
    }
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
if (phase === 'dispatched') {
  // The admitted 200 can win the race against the generator's abrupt exit on a
  // loaded host, so reaching this line no longer means the generator never ran.
  // Wait (bounded) for the dispatched generator's marker and report the phase's
  // exit code either way, so the parent observes a deterministic result.
  const marker = async (name: string) => {
    try {
      await fs.stat(path.join(root, name));
      return true;
    } catch {
      return false;
    }
  };
  if (await marker('adapter-redispatched.txt')) process.exit(73);
  for (let attempt = 0; attempt < 200 && !(await marker('adapter-invoked.txt')); attempt++)
    await new Promise((resolve) => setTimeout(resolve, 10));
  await fs.stat(path.join(root, 'adapter-invoked.txt'));
  if (await marker('adapter-redispatched.txt')) process.exit(73);
  process.exit(72);
}
throw new Error('The crash fixture unexpectedly returned from Work start.');
