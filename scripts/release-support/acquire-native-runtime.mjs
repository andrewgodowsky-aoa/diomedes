import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

// Build-time fallback only. Installed native runtimes take precedence at run time.
// Resolve the official current release once, then bind every downloaded file to
// that release's digest. Never resolve "latest" again in the middle of a package.
const root = fileURLToPath(new URL('../../', import.meta.url));
const releaseUrl = 'https://api.github.com/repos/openai/codex/releases/latest';
const required = ['codex', 'codex-command-runner', 'codex-windows-sandbox-setup'];
const optional = ['codex-code-mode-host', 'codex-app-server'];

export async function sha256File(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}
export async function currentNativeRelease(fetcher = fetch) {
  const response = await fetcher(releaseUrl, {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'Diomedes-release' },
    redirect: 'error', signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error('The official Codex release metadata is unavailable.');
  const release = await response.json();
  if (!/^rust-v[0-9A-Za-z.+-]{1,100}$/.test(release.tag_name) || !Array.isArray(release.assets))
    throw new Error('The official Codex release metadata is incomplete.');
  const files = [];
  for (const base of [...required, ...optional]) {
    const name = base + '-x86_64-pc-windows-msvc.exe';
    const asset = release.assets.find(entry => entry.name === name);
    if (!asset && optional.includes(base)) continue;
    const expectedUrl = 'https://github.com/openai/codex/releases/download/' + release.tag_name + '/' + name;
    if (!asset || asset.browser_download_url !== expectedUrl ||
        !/^sha256:[a-f0-9]{64}$/.test(asset.digest) ||
        !Number.isSafeInteger(asset.size) || asset.size <= 0 || asset.size > 400_000_000)
      throw new Error('Codex release lacks a verified Windows asset: ' + name);
    files.push({ name: base + '.exe', url: expectedUrl, sha256: asset.digest.slice(7), bytes: asset.size });
  }
  return { version: release.tag_name.slice(6), source: releaseUrl, files };
}
async function download(url, file) {
  const response = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(180_000) });
  if (!response.ok || !response.body) throw new Error('Official Codex asset download failed.');
  let bytes = 0;
  const limit = new Transform({ transform(chunk, _encoding, next) {
    bytes += chunk.length;
    next(bytes > 400_000_000 ? new Error('Codex asset exceeded its download limit.') : null, chunk);
  } });
  await pipeline(Readable.fromWeb(response.body), limit, createWriteStream(file, { flags: 'wx' }));
}
export async function acquireNativeRuntime({
  dest = path.join(root, '.data', 'native-runtime'),
  cache = path.join(root, 'test-results', 'native-runtime-source'),
  release, fetcher = fetch, fetchTo = download,
} = {}) {
  const selected = release ?? await currentNativeRelease(fetcher);
  await fs.mkdir(cache, { recursive: true });
  const staging = await fs.mkdtemp(path.join(cache, 'codex-'));
  try {
    for (const entry of selected.files) {
      if (!/^codex(?:-[a-z0-9]+)*\.exe$/i.test(entry.name))
        throw new Error('Invalid native runtime basename.');
      const target = path.join(staging, entry.name);
      await fetchTo(entry.url, target);
      if ((await fs.stat(target)).size !== entry.bytes || await sha256File(target) !== entry.sha256)
        throw new Error('Official Codex asset checksum mismatch: ' + entry.name);
    }
    await fs.mkdir(dest, { recursive: true });
    for (const entry of selected.files) {
      await fs.copyFile(path.join(staging, entry.name), path.join(dest, entry.name));
      if (await sha256File(path.join(dest, entry.name)) !== entry.sha256)
        throw new Error('Codex asset changed during activation: ' + entry.name);
    }
    const manifest = { ...selected, preparedAt: new Date().toISOString() };
    await fs.writeFile(path.join(dest, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
    return manifest;
  } finally {
    await fs.rm(staging, { recursive: true, force: true });
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const option = flag => {
    const index = args.indexOf(flag);
    return index === -1 ? undefined : path.resolve(args[index + 1]);
  };
  console.log(JSON.stringify(await acquireNativeRuntime({ dest: option('--dest'), cache: option('--cache') }), null, 2));
}
