import { readFile, writeFile } from 'node:fs/promises';

// Wrangler includes a NodeJS.ProcessEnv augmentation. This independent package
// exports its generated Env from a module so desktop ambient types stay intact.
const path = new URL('../worker-configuration.d.ts', import.meta.url);
const generated = await readFile(path, 'utf8');
if (!generated.includes('interface Env extends __BaseEnv_Env')) throw new Error('Unexpected Wrangler Env output; inspect the generator version.');
await writeFile(path, generated + '\n// Module scope prevents Worker bindings from augmenting desktop ProcessEnv.\nexport type WorkerEnv = Env;\n');
