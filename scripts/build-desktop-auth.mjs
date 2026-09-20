import { build } from 'esbuild';
import path from 'node:path';

/** Shared by packaging and the sandbox bundle acceptance test. */
export async function buildDesktopAuth(root, stage) {
  await build({
    entryPoints: [path.join(root, 'desktop/native-auth.ts')],
    outfile: path.join(stage, 'native-auth.mjs'),
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    external: ['electron'],
    banner: {
      js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
    },
  });
  await build({
    entryPoints: [path.join(root, 'desktop/native-auth-preload.ts')],
    outfile: path.join(stage, 'native-auth-preload.cjs'),
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    external: ['electron'],
  });
}
