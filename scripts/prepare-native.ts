import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CODEX_PROTOCOL_VERSION, nativeEnvironment } from '../server/integrations.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const destination = path.join(root, '.data', 'native-runtime');
// These three matching, already-installed Windows x64 binaries passed the
// sandbox protocol and read-only write-denial proof. Version text alone cannot
// detect an old helper next to a newer codex.exe.
const verifiedHashes: Record<string, string> = {
  'codex.exe': 'a1cf6360ca71918d5466bc3a32d9f18b7044c9128756d1949e715d277b88c9b6',
  'codex-command-runner.exe': '08b56828cca57c83d14f03eb9ec62c73a2cd6648248cc731ae8fedd5fa3ae566',
  'codex-windows-sandbox-setup.exe':
    '682cf7b351a871f3479b78fe3b7ea7348554de655bd98b0f322cef2d006a8d62',
};

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
  const folders = new Set<string>();
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
  for (const [name, expected] of Object.entries(verifiedHashes)) {
    const adjacent = path.join(folder, name);
    const packaged = path.join(path.dirname(folder), 'codex-resources', name);
    const source = (await exists(adjacent))
      ? adjacent
      : name !== 'codex.exe' && (await exists(packaged))
        ? packaged
        : null;
    if (!source || (await digest(source)) !== expected) return null;
    files[name] = source;
  }
  return files;
}

async function version(executable: string): Promise<string> {
  // Only launch after every file has matched the known-good hashes.
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
  if (exit !== 0 || output.trim() !== `codex-cli ${CODEX_PROTOCOL_VERSION}`)
    throw new Error('The installed executable did not report the proven Codex protocol version.');
  return output.trim();
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
      `No matching, already-installed Codex ${CODEX_PROTOCOL_VERSION} runtime and Windows sandbox helpers were found. Nothing was downloaded or installed. Supply --source with an installed runtime folder containing the verified build.`,
    );
  }
  const reportedVersion = await version(sourceFiles['codex.exe']);
  await fs.mkdir(destination, { recursive: true });
  const files = [];
  for (const [name, source] of Object.entries(sourceFiles)) {
    const target = path.join(destination, name);
    const unchanged = (await exists(target)) && (await digest(target)) === verifiedHashes[name];
    if (!unchanged) await fs.copyFile(source, target);
    const sha256 = await digest(target);
    if (sha256 !== verifiedHashes[name])
      throw new Error(
        `Copied runtime verification failed for ${name}. Native execution must remain disabled.`,
      );
    files.push({ name, source, destination: target, sha256, copied: !unchanged });
  }
  await fs.mkdir(path.join(root, 'evidence'), { recursive: true });
  const manifestPath = path.join(root, 'evidence', 'native-runtime-manifest.json');
  await fs.writeFile(
    manifestPath,
    `${JSON.stringify(
      {
        preparedAt: new Date().toISOString(),
        version: reportedVersion,
        scope:
          'Local copy of three matching installed binaries; no global installation or credential changes.',
        files,
      },
      null,
      2,
    )}\n`,
  );
  console.log(
    `Prepared native Codex ${CODEX_PROTOCOL_VERSION} and matching Windows sandbox helpers in ${destination}.`,
  );
  console.log(`All three SHA-256 hashes verified. Manifest: ${manifestPath}`);
}

await main();
