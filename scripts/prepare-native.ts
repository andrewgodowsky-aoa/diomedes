import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { currentCodexRuntime, nativeEnvironment } from '../server/integrations.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const destination = path.join(root, '.data', 'native-runtime');
// Copy a coherent installed build. Record its bytes for this package; execution
// independently proves the selected runtime's capabilities and sandbox.
const requiredFiles = ['codex.exe', 'codex-command-runner.exe', 'codex-windows-sandbox-setup.exe'];

const missing = (error: unknown) =>
  error instanceof Error && 'code' in error && error.code === 'ENOENT';
async function digest(file: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const bytes of createReadStream(file)) hash.update(bytes);
  return hash.digest('hex');
}
async function exists(file: string) {
  try {
    await fs.access(file);
    return true;
  } catch (error) {
    if (missing(error)) return false;
    throw error;
  }
}

async function candidateFolders(): Promise<string[]> {
  const supplied = process.argv.slice(2);
  if (supplied.length && (supplied.length !== 2 || supplied[0] !== '--source')) {
    throw new Error('Usage: npm run prepare-native -- [--source <installed-runtime-folder>]');
  }
  if (supplied.length) return [path.resolve(supplied[1])];
  const folders = new Set<string>([path.dirname(currentCodexRuntime().executable)]);
  if (process.env.LOCALAPPDATA) {
    const installed = path.join(process.env.LOCALAPPDATA, 'OpenAI', 'Codex', 'bin');
    if (await exists(installed)) {
      for (const entry of await fs.readdir(installed, { withFileTypes: true })) {
        if (entry.isDirectory() && /^[a-f0-9]{16}$/i.test(entry.name))
          folders.add(path.join(installed, entry.name));
      }
      folders.add(installed);
    }
  }
  for (const folder of (process.env.PATH || '').split(path.delimiter)) {
    if (!folder.trim()) continue;
    const executable = path.join(folder.replace(/^"|"$/g, ''), 'codex.exe');
    if (await exists(executable)) folders.add(path.dirname(await fs.realpath(executable)));
  }
  return [...folders];
}

async function matchingRuntime(folder: string): Promise<Record<string, string> | null> {
  const files: Record<string, string> = {};
  for (const name of requiredFiles) {
    const adjacent = path.join(folder, name);
    const packaged = path.join(path.dirname(folder), 'codex-resources', name);
    const source = (await exists(adjacent))
      ? adjacent
      : name !== 'codex.exe' && (await exists(packaged))
        ? packaged
        : null;
    if (!source) return null;
    files[name] = source;
  }
  for (const entry of await fs.readdir(folder, { withFileTypes: true }))
    if (entry.isFile() && /^codex(?:-[a-z0-9]+)+\.exe$/i.test(entry.name) && !files[entry.name])
      files[entry.name] = path.join(folder, entry.name);
  return files;
}

async function version(executable: string): Promise<string> {
  // This is an explicitly selected installed executable, not a downloaded script.
  const child = spawn(executable, ['--version'], {
    windowsHide: true,
    env: nativeEnvironment(),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (bytes: Buffer) => {
    if (output.length < 1024) output += bytes.toString();
  });
  child.stderr.on('data', () => {});
  const exit = await new Promise<number | null>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('The verified Codex executable did not report its version in time.'));
    }, 5000);
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
  const reported = output.trim().match(/^codex-cli ([0-9A-Za-z.+-]{1,100})$/)?.[1];
  if (exit !== 0 || !reported)
    throw new Error('The installed executable did not report its Codex runtime version.');
  return reported;
}

export async function prepareInstalledRuntime({
  sourceFiles, destination: targetFolder, readVersion = version, copyFile = fs.copyFile,
}: {
  sourceFiles: Record<string, string>;
  destination: string;
  readVersion?: (executable: string) => Promise<string>;
  copyFile?: typeof fs.copyFile;
}) {
  const entries = Object.entries(sourceFiles);
  if (requiredFiles.some((name) => !sourceFiles[name]) || entries.some(([name]) => !/^codex(?:-[a-z0-9]+)*\.exe$/i.test(name)))
    throw new Error('Invalid selected runtime file set.');
  const expected = new Map<string, string>();
  const identity = async (file: string) => {
    const stat = await fs.stat(file, { bigint: true });
    return [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(':');
  };
  const identities = new Map<string, string>();
  for (const [name, source] of entries) identities.set(name, await identity(source));
  // Capture the whole selected set before copying any file or asking its version.
  for (const [name, source] of entries) expected.set(name, await digest(source));
  const parent = path.dirname(path.resolve(targetFolder));
  await fs.mkdir(parent, { recursive: true });
  const staging = await fs.mkdtemp(path.join(parent, '.native-runtime-'));
  try {
    for (const [name, source] of entries) {
      await copyFile(source, path.join(staging, name));
      if (await digest(path.join(staging, name)) !== expected.get(name))
        throw new Error('Selected runtime changed during preparation: ' + name);
    }
    // Run only the private staged executable: the version describes these bytes.
    const reportedVersion = await readVersion(path.join(staging, 'codex.exe'));
    if (!/^[0-9A-Za-z.+-]{1,100}$/.test(reportedVersion))
      throw new Error('Invalid staged runtime version.');
    for (const [name, source] of entries) {
      if (await identity(source) !== identities.get(name) || await digest(source) !== expected.get(name) ||
          await digest(path.join(staging, name)) !== expected.get(name))
        throw new Error('Selected runtime changed during preparation: ' + name);
    }
    await fs.mkdir(targetFolder, { recursive: true });
    const files = [];
    for (const [name, source] of entries) {
      const target = path.join(targetFolder, name);
      await fs.copyFile(path.join(staging, name), target);
      files.push({ name, source, destination: target, sha256: expected.get(name)!, copied: true });
    }
    // Verify the entire destination after every copy, before publishing its manifest.
    for (const file of files)
      if (await digest(file.destination) !== file.sha256)
        throw new Error('Copied runtime verification failed for ' + file.name);
    const manifest = {
      preparedAt: new Date().toISOString(), version: reportedVersion,
      scope: 'Snapshot of the selected installed runtime; connection-time capability and isolation checks remain required.',
      files,
    };
    await fs.writeFile(path.join(targetFolder, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
    return manifest;
  } finally {
    if (path.dirname(path.resolve(staging)) !== parent || !path.basename(staging).startsWith('.native-runtime-'))
      throw new Error('Refusing to remove an unexpected runtime staging directory.');
    await fs.rm(staging, { recursive: true, force: true });
  }
}

async function main() {
  if (process.platform !== 'win32' || process.arch !== 'x64')
    throw new Error(
      'This preparation script contains the verified Windows x64 runtime manifest only.',
    );
  const candidates = await candidateFolders();
  let sourceFiles: Record<string, string> | null = null;
  for (const folder of candidates) {
    sourceFiles = await matchingRuntime(folder);
    if (sourceFiles) break;
  }
  if (!sourceFiles) {
    throw new Error(
      'No installed Codex runtime with its Windows sandbox helpers was found. Supply --source with an installed runtime folder.',
    );
  }
  const manifest = await prepareInstalledRuntime({ sourceFiles, destination });
  const manifestPath = path.join(destination, 'manifest.json');
  console.log(
    `Prepared native Codex ${manifest.version} and its Windows sandbox helpers in ${destination}.`,
  );
  console.log(`All copied file hashes verified. Manifest: ${manifestPath}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
