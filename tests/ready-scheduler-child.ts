import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { createApp } from '../server/app.js';
import type { Store } from '../server/store.js';

// Abrupt exits deliberately bypass close(): the parent restarts the same synthetic store and
// checks that the claim written before admission is settled or replayed, never repeated.
// `claimed` exits right after the claim is durable and before admission; `admitted` exits right
// after admission persisted the session under the claim's command.
const [root, projectId, phase] = process.argv.slice(2);
if (!root || !projectId || !['claimed', 'admitted'].includes(phase))
  throw new Error('Invalid Ready queue crash fixture arguments.');
const app = await createApp({
  dataDir: path.join(root, 'data'),
  projectRoot: path.join(root, 'projects'),
  stepMs: 20,
});
const store: Store = app.locals.store;
const persist = store.persist.bind(store);
store.persist = async (state) => {
  const claim = state.readyQueue?.claims.find((item) => item.state === 'claimed');
  const admitted =
    !!claim && state.sessions.some((session) => session.receipt?.commandId === claim.commandId);
  await persist(state);
  if (claim && !admitted && phase === 'claimed') process.exit(70);
  if (claim && admitted && phase === 'admitted') process.exit(71);
};
const server = app.listen(0, '127.0.0.1');
await new Promise<void>((resolve) => server.once('listening', resolve));
const port = (server.address() as AddressInfo).port;
await fetch(`http://127.0.0.1:${port}/api/projects/${projectId}/ready-queue`, {
  method: 'PUT',
  headers: { 'Content-Type': 'application/json', 'X-Diomedes-Client': '1' },
  body: JSON.stringify({ autoStart: true }),
});
// The pass runs behind the lock after the response; give it bounded time to reach the exit.
await new Promise((resolve) => setTimeout(resolve, 15_000));
process.exit(1);
