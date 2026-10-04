import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { afterEach, expect, test, vi } from 'vitest';
// @ts-expect-error Build-time executable JavaScript module.
import { currentNativeRelease, acquireNativeRuntime } from '../scripts/release-support/acquire-native-runtime.mjs';
// @ts-expect-error Build-time executable JavaScript module.
import { readNativeRuntimeManifest } from '../scripts/package-desktop.mjs';
import { prepareInstalledRuntime } from '../scripts/prepare-native.js';
import { verifyNativePublisher, verifyNativePublishers } from '../scripts/release-support/verify-native-publisher.mjs';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });
const payload = 'synthetic native binary';
const digest = createHash('sha256').update(payload).digest('hex');
// Synthetic binary fixtures have no real publisher. Success-path tests accept
// them; attack tests read every file as unsigned through the real verdict
// logic. Only the packaging forgery test below launches Windows PowerShell.
const verifyFixturePublishers = vi.fn(async (_files: string[]) => {});
const verifyUnsignedPublishers = (files: string[]) =>
  verifyNativePublishers(files, async read => read.map(() => ({ status: 'NotSigned', subject: null })));
const invalid = 'Codex publisher signature is not valid for the reviewed OpenAI identity: ';
const metadata = () => ({ tag_name: 'rust-v99.0.0', assets: ['codex', 'codex-command-runner', 'codex-windows-sandbox-setup'].map(base => ({
  name: base + '-x86_64-pc-windows-msvc.exe', size: Buffer.byteLength(payload), digest: 'sha256:' + digest,
  browser_download_url: 'https://github.com/openai/codex/releases/download/rust-v99.0.0/' + base + '-x86_64-pc-windows-msvc.exe',
})) });

test('a future official release is resolved once and all packaged bytes bind to that snapshot', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'diomedes-runtime-release-'));
  roots.push(root);
  const fetcher = vi.fn(async () => Response.json(metadata()));
  const dest = path.join(root, '.data/native-runtime');
  await acquireNativeRuntime({ dest, cache: path.join(root, 'cache'), fetcher, verifyPublishers: verifyFixturePublishers,
    fetchTo: async (_url: string, file: string) => fs.writeFile(file, payload) });
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(await readNativeRuntimeManifest(root, verifyFixturePublishers)).toEqual({ version: '99.0.0', hashes: {
    'codex.exe': digest, 'codex-command-runner.exe': digest, 'codex-windows-sandbox-setup.exe': digest,
  } });
});

test.each(['missing-digest', 'foreign-source', 'missing-helper'] as const)('refuses incomplete current metadata: %s', async change => {
  const release = metadata();
  if (change === 'missing-digest') release.assets[0].digest = '';
  if (change === 'foreign-source') release.assets[0].browser_download_url = 'https://example.invalid/codex.exe';
  if (change === 'missing-helper') release.assets.pop();
  await expect(currentNativeRelease(async () => Response.json(release))).rejects.toThrow('verified Windows asset');
});

test('a failed artifact verification leaves the previous package snapshot intact', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'diomedes-runtime-release-'));
  roots.push(root);
  const dest = path.join(root, '.data/native-runtime');
  await fs.mkdir(dest, { recursive: true });
  await fs.writeFile(path.join(dest, 'codex.exe'), 'previous snapshot');
  await expect(acquireNativeRuntime({ dest, cache: path.join(root, 'cache'), fetcher: async () => Response.json(metadata()),
    fetchTo: async (_url: string, file: string) => fs.writeFile(file, 'wrong payload') })).rejects.toThrow('checksum mismatch');
  expect(await fs.readFile(path.join(dest, 'codex.exe'), 'utf8')).toBe('previous snapshot');
  expect(await fs.readdir(dest)).toEqual(['codex.exe']);
});

test('matching attacker-controlled release bytes and metadata do not establish publisher trust', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'diomedes-runtime-untrusted-'));
  roots.push(root);
  const dest = path.join(root, '.data/native-runtime');
  await fs.mkdir(dest, { recursive: true });
  await fs.writeFile(path.join(dest, 'codex.exe'), 'previous snapshot');
  await expect(acquireNativeRuntime({ dest, cache: path.join(root, 'cache'), fetcher: async () => Response.json(metadata()),
    verifyPublishers: verifyUnsignedPublishers, fetchTo: async (_url: string, file: string) => fs.writeFile(file, payload) }))
    .rejects.toThrow(invalid + 'codex.exe');
  expect(await fs.readFile(path.join(dest, 'codex.exe'), 'utf8')).toBe('previous snapshot');
  expect(await fs.readdir(dest)).toEqual(['codex.exe']);
});

async function installedFixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'diomedes-installed-snapshot-'));
  roots.push(root);
  const source = path.join(root, 'installed');
  const destination = path.join(root, '.data/native-runtime');
  await fs.mkdir(source);
  await fs.mkdir(destination, { recursive: true });
  await fs.writeFile(path.join(destination, 'manifest.json'), 'previous manifest');
  await fs.writeFile(path.join(destination, 'codex.exe'), 'previous executable');
  const sourceFiles: Record<string, string> = {};
  for (const name of ['codex.exe', 'codex-command-runner.exe', 'codex-windows-sandbox-setup.exe']) {
    sourceFiles[name] = path.join(source, name);
    await fs.writeFile(sourceFiles[name], 'build A: ' + name);
  }
  return { root, sourceFiles, destination };
}

test('untrusted installed bytes are refused before the version command can execute', async () => {
  const { sourceFiles, destination } = await installedFixture();
  const readVersion = vi.fn(async () => '99.0.0');
  await expect(prepareInstalledRuntime({ sourceFiles, destination, readVersion, verifyPublishers: verifyUnsignedPublishers }))
    .rejects.toThrow(invalid + 'codex.exe');
  expect(readVersion).not.toHaveBeenCalled();
  expect(await fs.readFile(path.join(destination, 'codex.exe'), 'utf8')).toBe('previous executable');
});

test('installed preparation reads the version from the private copied executable', async () => {
  const { sourceFiles, destination } = await installedFixture();
  const readVersion = vi.fn(async (file: string) => {
    expect(file).not.toBe(sourceFiles['codex.exe']);
    expect(await fs.readFile(file, 'utf8')).toBe('build A: codex.exe');
    return '99.0.0';
  });
  await prepareInstalledRuntime({ sourceFiles, destination, readVersion, verifyPublishers: verifyFixturePublishers });
  expect(readVersion).toHaveBeenCalledOnce();
  const manifest = await readNativeRuntimeManifest(path.dirname(path.dirname(destination)), verifyFixturePublishers);
  expect(manifest.version).toBe('99.0.0');
  for (const [name, hash] of Object.entries(manifest.hashes))
    expect(createHash('sha256').update(await fs.readFile(path.join(destination, name))).digest('hex')).toBe(hash);
});

test('an update after version observation refuses the mixed snapshot and preserves the previous one', async () => {
  const { root, sourceFiles, destination } = await installedFixture();
  await expect(prepareInstalledRuntime({ sourceFiles, destination, verifyPublishers: verifyFixturePublishers, readVersion: async () => {
    for (const [name, source] of Object.entries(sourceFiles)) await fs.writeFile(source, 'build B: ' + name);
    return '98.0.0';
  } })).rejects.toThrow('changed during preparation');
  expect(await fs.readFile(path.join(destination, 'manifest.json'), 'utf8')).toBe('previous manifest');
  expect(await fs.readFile(path.join(destination, 'codex.exe'), 'utf8')).toBe('previous executable');
  expect((await fs.readdir(path.join(root, '.data'))).filter(name => name.startsWith('.native-runtime-'))).toEqual([]);
});

test('a helper replaced between copies is refused before activating any new file', async () => {
  const { sourceFiles, destination } = await installedFixture();
  await expect(prepareInstalledRuntime({ sourceFiles, destination, verifyPublishers: verifyFixturePublishers, readVersion: async () => '99.0.0',
    copyFile: async (source, target, mode) => {
      await fs.copyFile(source, target, mode);
      if (source === sourceFiles['codex.exe']) await fs.writeFile(sourceFiles['codex-command-runner.exe'], 'build B helper');
    },
  })).rejects.toThrow('changed during preparation');
  expect(await fs.readFile(path.join(destination, 'manifest.json'), 'utf8')).toBe('previous manifest');
  expect(await fs.readFile(path.join(destination, 'codex.exe'), 'utf8')).toBe('previous executable');
});

test.each([
  { status: 'NotSigned', subject: null },
  { status: 'HashMismatch', subject: 'CN="OpenAI OpCo, LLC", O="OpenAI OpCo, LLC", L=San Francisco, S=California, C=US' },
  { status: 'Valid', subject: 'CN=Another Publisher, C=US' },
])('refuses a native signature without both chain validity and the pinned publisher: $status', async signature => {
  await expect(verifyNativePublisher('codex.exe', async () => signature)).rejects.toThrow(invalid + 'codex.exe');
});

const reviewed = { status: 'Valid', subject: 'CN="OpenAI OpCo, LLC", O="OpenAI OpCo, LLC", L=San Francisco, S=California, C=US' };
test('one signature read covers a whole set, and a short answer is no verdict', async () => {
  const readSignatures = vi.fn(async (files: string[]) => files.map(() => reviewed));
  await verifyNativePublishers(['a.exe', 'b.exe', 'c.exe'], readSignatures);
  expect(readSignatures).toHaveBeenCalledOnce();
  expect(readSignatures).toHaveBeenCalledWith(['a.exe', 'b.exe', 'c.exe']);
  await expect(verifyNativePublishers(['a.exe', 'b.exe'], async () => [reviewed]))
    .rejects.toThrow('Codex publisher signature could not be verified: expected 2 signature results.');
  await expect(verifyNativePublishers(['a.exe', 'b.exe'], async () => [reviewed, { status: 'NotSigned', subject: null }]))
    .rejects.toThrow('Codex publisher signature is not valid for the reviewed OpenAI identity: b.exe');
});

test('acquisition and packaging authenticate each runtime set with one read, before activating any of it', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'diomedes-runtime-batch-'));
  roots.push(root);
  const dest = path.join(root, '.data/native-runtime');
  await fs.mkdir(dest, { recursive: true });
  await fs.writeFile(path.join(dest, 'codex.exe'), 'previous snapshot');
  const names = ['codex.exe', 'codex-command-runner.exe', 'codex-windows-sandbox-setup.exe'];
  const verifyPublishers = vi.fn(async (files: string[]) => {
    expect(files.map(file => path.basename(file))).toEqual(names);
    expect(await fs.readFile(path.join(dest, 'codex.exe'), 'utf8')).toBe('previous snapshot');
  });
  await acquireNativeRuntime({ dest, cache: path.join(root, 'cache'), fetcher: async () => Response.json(metadata()),
    verifyPublishers, fetchTo: async (_url: string, file: string) => fs.writeFile(file, payload) });
  expect(verifyPublishers).toHaveBeenCalledOnce();
  const packaging = vi.fn(async (_files: string[]) => {});
  await readNativeRuntimeManifest(root, packaging);
  expect(packaging).toHaveBeenCalledOnce();
  expect(packaging.mock.calls[0][0].map((file: string) => path.basename(file))).toEqual(names);
});

// The one real Windows PowerShell signature read in this suite, through the
// default packaging path. It must reach a verdict: a check that is stopped,
// blocked or timed out throws "could not be verified" and fails this test.
test.runIf(process.platform === 'win32')('packaging rejects a forged manifest even when every untrusted byte matches its declared digest', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'diomedes-package-untrusted-'));
  roots.push(root);
  const dest = path.join(root, '.data/native-runtime');
  await acquireNativeRuntime({ dest, cache: path.join(root, 'cache'), fetcher: async () => Response.json(metadata()),
    verifyPublishers: verifyFixturePublishers, fetchTo: async (_url: string, file: string) => fs.writeFile(file, payload) });
  await expect(readNativeRuntimeManifest(root)).rejects.toThrow(invalid + 'codex.exe');
});
