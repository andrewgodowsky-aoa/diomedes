import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

// Supply the offline Electron archive scripts/package-desktop.mjs requires for a
// macOS target (DIOMEDES_ELECTRON_ZIP_DIR). The packager never downloads a
// platform archive silently; this is the deliberate, recorded download.
//
//   node scripts/release-support/acquire-electron-archive.mjs --platform darwin --arch arm64 --dir <dir>
//
// The archive is accepted only when its SHA-256 equals both
//   - the line for it in SHASUMS256.txt, published beside it in Electron's release, and
//   - the value in node_modules/electron/checksums.json, which arrived through
//     package-lock.json's integrity-checked install of the exact Electron version.
// Two independent sources must agree, and nothing is left in --dir when they do not.

const root = fileURLToPath(new URL('../../', import.meta.url));

async function sha256File(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

async function download(url, file) {
  const response = await fetch(url, { redirect: 'follow' });
  if (!response.ok || !response.body) throw new Error(`Download failed: ${response.status} ${url}`);
  await pipeline(Readable.fromWeb(response.body), createWriteStream(file));
}

async function fetchText(url) {
  const response = await fetch(url, { redirect: 'follow' });
  if (!response.ok) throw new Error(`Download failed: ${response.status} ${url}`);
  return response.text();
}

/** The digest SHASUMS256.txt gives for one file name, or null. */
export function publishedDigest(shasums, name) {
  for (const line of shasums.split(/\r?\n/)) {
    const match = /^([0-9a-f]{64}) [ *]?(.+)$/.exec(line.trim());
    if (match && match[2] === name) return match[1];
  }
  return null;
}

export async function acquireElectronArchive({
  platform,
  arch,
  dir,
  electronDir = path.join(root, 'node_modules', 'electron'),
  fetchTo = download,
  fetchShasums = fetchText,
}) {
  const { version } = JSON.parse(await fs.readFile(path.join(electronDir, 'package.json'), 'utf8'));
  const locked = JSON.parse(await fs.readFile(path.join(electronDir, 'checksums.json'), 'utf8'));
  const name = `electron-v${version}-${platform}-${arch}.zip`;
  const base = `https://github.com/electron/electron/releases/download/v${version}`;
  const fromLock = locked[name];
  if (!/^[0-9a-f]{64}$/.test(fromLock ?? ''))
    throw new Error(`node_modules/electron/checksums.json has no digest for ${name}.`);
  const fromRelease = publishedDigest(await fetchShasums(`${base}/SHASUMS256.txt`), name);
  if (fromRelease !== fromLock)
    throw new Error(
      `SHASUMS256.txt gives ${fromRelease ?? 'no digest'} for ${name}; the locked package gives ${fromLock}.`,
    );

  await fs.mkdir(dir, { recursive: true });
  const archive = path.join(dir, name);
  const partial = `${archive}.partial`;
  await fs.rm(partial, { force: true });
  await fetchTo(`${base}/${name}`, partial);
  const actual = await sha256File(partial);
  if (actual !== fromLock) {
    await fs.rm(partial, { force: true });
    throw new Error(`${name} hashes ${actual}; Electron publishes ${fromLock}. It was deleted.`);
  }
  await fs.rename(partial, archive);
  return {
    name,
    version,
    sha256: actual,
    bytes: (await fs.stat(archive)).size,
    url: `${base}/${name}`,
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const option = (flag) => {
    const index = args.indexOf(flag);
    if (index === -1 || !args[index + 1]) throw new Error(`${flag} is required.`);
    return args[index + 1];
  };
  const result = await acquireElectronArchive({
    platform: option('--platform'),
    arch: option('--arch'),
    dir: path.resolve(option('--dir')),
  });
  console.log(JSON.stringify(result, null, 2));
}
