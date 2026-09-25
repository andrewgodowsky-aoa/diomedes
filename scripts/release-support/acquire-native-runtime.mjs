import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { WINDOWS_NATIVE_RUNTIME_SHA256 } from '../package-desktop.mjs';

// Put the three pinned Windows native-runtime files into .data/native-runtime on a
// machine that has no Codex installation, such as a hosted CI runner.
//
//   node scripts/release-support/acquire-native-runtime.mjs [--dest <dir>] [--cache <dir>]
//
// Where the bytes come from. The pinned files are OpenAI's signed Codex 0.153.4
// executables, but not the copies OpenAI publishes today: the GitHub release assets
// and the npm package carry the same program with a different Authenticode
// signature instance, so their whole-file SHA-256 differs
// (docs/releases/NOTICES_HANDOFF.md, evidence/windows-release/native-provenance.json).
// A download from upstream can therefore never pass the pin, and the pin is not
// changed here. The exact pinned bytes are published in Diomedes' own release
// v0.1.11: its portable ZIP carries them under resources/native-runtime. So this
// script downloads that ZIP, requires its SHA-256 to be the one the v0.1.11
// release manifest and SHA256SUMS.txt publish, extracts only those three files,
// and requires each to hash to WINDOWS_NATIVE_RUNTIME_SHA256 -- the table
// scripts/package-desktop.mjs checks again before it packages. Any mismatch
// stops with nothing written to the destination.

export const NATIVE_RUNTIME_SOURCE = Object.freeze({
  release: 'v0.1.11',
  url: 'https://github.com/andrewgodowsky-aoa/diomedes/releases/download/v0.1.11/Diomedes-Experimental-0.1.11-win32-x64.zip',
  bytes: 269088059,
  // Published in v0.1.11's release-manifest.json and SHA256SUMS.txt.
  sha256: 'e30c17c8228db2fdfba1380234fbbe4e69eca0cea4ad0ad90560c9f1e8c1a070',
  folder: 'Diomedes-Experimental-0.1.11-win32-x64/resources/native-runtime',
});

const root = fileURLToPath(new URL('../../', import.meta.url));

export async function sha256File(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

function run(command, argv, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, argv, {
      cwd,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let err = '';
    child.stderr.on('data', (chunk) => (err += chunk));
    child.stdout.resume();
    child.on('error', reject);
    child.on('close', (code) =>
      code === 0 ? resolve() : reject(new Error(`${command} exited ${code}: ${err.trim()}`)),
    );
  });
}

/** bsdtar reads ZIP on Windows and macOS; a Linux host has unzip instead. */
async function extract(zip, members, into) {
  if (process.platform === 'linux')
    await run('unzip', ['-q', '-o', zip, ...members, '-d', into], into);
  else {
    const tar =
      process.platform === 'win32'
        ? path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe')
        : 'tar';
    await run(tar, ['-x', '-f', zip, ...members], into);
  }
}

async function download(url, file) {
  const response = await fetch(url, { redirect: 'follow' });
  if (!response.ok || !response.body) throw new Error(`Download failed: ${response.status} ${url}`);
  await pipeline(Readable.fromWeb(response.body), createWriteStream(file));
}

export async function acquireNativeRuntime({
  dest = path.join(root, '.data', 'native-runtime'),
  cache = path.join(root, 'test-results', 'native-runtime-source'),
  source = NATIVE_RUNTIME_SOURCE,
  expected = WINDOWS_NATIVE_RUNTIME_SHA256,
  fetchTo = download,
} = {}) {
  await fs.mkdir(cache, { recursive: true });
  const zip = path.join(cache, path.basename(new URL(source.url).pathname));
  const cached = await fs.stat(zip).catch(() => null);
  if (!cached || cached.size !== source.bytes || (await sha256File(zip)) !== source.sha256) {
    await fs.rm(zip, { force: true });
    await fetchTo(source.url, zip);
  }
  const zipSha256 = await sha256File(zip);
  const { size } = await fs.stat(zip);
  if (size !== source.bytes || zipSha256 !== source.sha256)
    throw new Error(
      `The ${source.release} archive is ${size} bytes with SHA-256 ${zipSha256}; the published values are ${source.bytes} and ${source.sha256}. Nothing was extracted.`,
    );

  const staging = await fs.mkdtemp(path.join(cache, 'extract-'));
  try {
    const members = Object.keys(expected).map((name) => `${source.folder}/${name}`);
    await extract(zip, members, staging);
    const files = [];
    for (const [name, sha256] of Object.entries(expected)) {
      const file = path.join(staging, source.folder, name);
      const actual = await sha256File(file);
      if (actual !== sha256)
        throw new Error(
          `${name} from ${source.release} hashes ${actual}, not the pinned ${sha256}. Nothing was written.`,
        );
      files.push({ name, sha256, bytes: (await fs.stat(file)).size, file });
    }
    await fs.mkdir(dest, { recursive: true });
    for (const entry of files) await fs.copyFile(entry.file, path.join(dest, entry.name));
    for (const entry of files)
      if ((await sha256File(path.join(dest, entry.name))) !== entry.sha256)
        throw new Error(`${entry.name} changed while it was copied to ${dest}.`);
    return {
      source: { release: source.release, url: source.url, bytes: size, sha256: zipSha256 },
      files: files.map(({ name, sha256, bytes }) => ({ name, sha256, bytes })),
    };
  } finally {
    await fs.rm(staging, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const option = (flag) => {
    const index = args.indexOf(flag);
    return index === -1 ? undefined : path.resolve(args[index + 1]);
  };
  const result = await acquireNativeRuntime({ dest: option('--dest'), cache: option('--cache') });
  console.log(JSON.stringify(result, null, 2));
}
