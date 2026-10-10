import { writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LocalMemoryStore } from '../../../server/memory/local-store.js';
import { MemoryService } from '../../../server/memory/service.js';
import type { MemoryFaultPoint } from '../../../server/memory/store.js';
import { command, epochs, scopeA, T2 } from './fixture.js';

// Only the recovery test starts this child, and only in its owned mkdtemp profile.
const [fileArgument, boundary] = process.argv.slice(2);
const file = path.resolve(fileArgument ?? '');
const root = path.dirname(file);
const boundaries: readonly MemoryFaultPoint[] = ['after-entry', 'after-event', 'before-commit'];
if (path.dirname(root) !== path.resolve(os.tmpdir()) ||
    !path.basename(root).startsWith('nectovia-memory-w01-') ||
    path.basename(file) !== 'ledger.sqlite' || !boundaries.some(value => value === boundary)) {
  throw new Error('The crash child requires an owned disposable ledger and known boundary.');
}
const store = await LocalMemoryStore.open({ path: file, fault: point => {
  if (point === boundary) {
    writeFileSync(path.join(root, 'crash-boundary.txt'), point, 'utf8');
    // Deliberately bypass adapter rollback and close; the parent verifies recovery.
    process.exit(86);
  }
} });
const service = new MemoryService(store, { currentEpochs: () => ({ ...epochs }), now: () => T2 });
service.commit(scopeA, command(scopeA, { revision: 2, body: 'Atomic crash update.' }));
store.close();
throw new Error('The requested crash boundary was not reached.');
