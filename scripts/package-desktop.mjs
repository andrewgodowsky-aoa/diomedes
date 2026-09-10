import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { packager } from '@electron/packager';
import { createHash } from 'node:crypto';

const root = fileURLToPath(new URL('../', import.meta.url));
const manifest = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
// Each build gets an isolated staging folder; never copy app data or credentials.
const stage = await fs.mkdtemp(path.join(root, '.desktop-stage-'));
try {
  await fs.mkdir(path.join(stage, 'server'));
  await fs.mkdir(path.join(stage, 'fixtures/harness'), { recursive: true });
  await fs.copyFile(
    path.join(root, 'fixtures/harness/report-lines.txt'),
    path.join(stage, 'fixtures/harness/report-lines.txt'),
  );
  await fs.copyFile(path.join(root, 'desktop/main.mjs'), path.join(stage, 'main.mjs'));
  await fs.cp(path.join(root, 'dist'), path.join(stage, 'dist'), { recursive: true });
  await fs.cp(path.join(root, 'licenses'), path.join(stage, 'licenses'), { recursive: true });
  await fs.writeFile(
    path.join(stage, 'package.json'),
    JSON.stringify({
      name: 'diomedes',
      productName: 'Diomedes',
      version: manifest.version,
      type: 'module',
      main: 'main.mjs',
    }),
  );
  const runtime = path.join(stage, 'native-runtime');
  await fs.mkdir(runtime);
  const hashes = {
    'codex.exe': 'a1cf6360ca71918d5466bc3a32d9f18b7044c9128756d1949e715d277b88c9b6',
    'codex-command-runner.exe': '08b56828cca57c83d14f03eb9ec62c73a2cd6648248cc731ae8fedd5fa3ae566',
    'codex-windows-sandbox-setup.exe':
      '682cf7b351a871f3479b78fe3b7ea7348554de655bd98b0f322cef2d006a8d62',
  };
  for (const [name, expected] of Object.entries(hashes)) {
    const bytes = await fs.readFile(path.join(root, '.data/native-runtime', name));
    if (createHash('sha256').update(bytes).digest('hex') !== expected)
      throw new Error(`Native runtime hash mismatch: ${name}. Run prepare-native first.`);
    await fs.writeFile(path.join(runtime, name), bytes);
  }
  await build({
    entryPoints: [path.join(root, 'desktop/service.ts')],
    outfile: path.join(stage, 'server/app.mjs'),
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    define: { DIOMEDES_BUNDLED: 'true' },
    banner: {
      js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
    },
  });
  const outputs = await packager({
    dir: stage,
    out: path.join(root, 'release'),
    name: 'Diomedes',
    platform: 'win32',
    arch: 'x64',
    asar: true,
    electronVersion: JSON.parse(
      await fs.readFile(path.join(root, 'node_modules/electron/package.json'), 'utf8'),
    ).version,
    extraResource: [runtime],
    ignore: /^\/native-runtime(?:\/|$)/,
    appVersion: manifest.version,
    overwrite: true,
    win32metadata: {
      ProductName: 'Diomedes',
      FileDescription: 'Diomedes desktop',
      CompanyName: 'Diomedes',
    },
  });
  console.log(`Desktop release: ${outputs.join(', ')}`);
} finally {
  // The staging copy is fully derived from the repo; never leave it behind.
  await fs.rm(stage, { recursive: true, force: true });
}
