// Owned synthetic-profile benchmark; never opens the installed application's data.
// node --import tsx scripts/startup-profile.ts [path/to/server/store.ts]
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
import { createHash } from 'node:crypto';
import type { Store as StoreType } from '../server/store.js';
import { seedSyntheticProject } from './perf-gate-seed.js';

const source = path.resolve(process.argv[2] ?? 'server/store.ts');
const { Store } = await import(pathToFileURL(source).href) as { Store: typeof StoreType };
const sourceSha256 = createHash('sha256').update(await fs.readFile(source)).digest('hex');
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'diomedes-startup-profile-'));
try {
  const fixture = await seedSyntheticProject(root, { historyEntries: 10_000, files: 0, tasks: 500 });
  const seed = new Store(fixture.dataDir, fixture.projectsDir);
  await seed.init();
  for (let i = 0; i < 19; i += 1) await seed.createProject(`Startup profile ${i}`);
  // Complete any one-time migrations before measuring unchanged launches.
  await new Store(fixture.dataDir, fixture.projectsDir).init();
  const samples: { milliseconds: number; durableProjectWrites: number }[] = [];
  for (let run = 0; run < 7; run += 1) {
    const store = new Store(fixture.dataDir, fixture.projectsDir);
    const persist = store.persist.bind(store);
    let durableProjectWrites = 0;
    store.persist = async state => { durableProjectWrites += 1; await persist(state); };
    const started = performance.now();
    await store.init();
    samples.push({ milliseconds: performance.now() - started, durableProjectWrites });
  }
  const sorted = samples.map(sample => sample.milliseconds).sort((a, b) => a - b);
  console.log(JSON.stringify({
    source, sourceSha256, node: process.version,
    profile: { projects: 20, historyEntries: 10_000, tasks: 500 },
    boundary: 'Store.init on a synthetic, filesystem-cache-warm profile; excludes Electron, authentication and renderer startup',
    medianMilliseconds: sorted[Math.floor(sorted.length / 2)], samples,
  }, null, 2));
} finally {
  if (path.dirname(root) !== os.tmpdir() || !path.basename(root).startsWith('diomedes-startup-profile-'))
    throw new Error('Refusing cleanup outside the owned startup fixture.');
  await fs.rm(root, { recursive: true, force: true });
}
