import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
// @ts-expect-error Executable JavaScript module with bounded injected process seams.
import { acquireNsis, runVerifiedNsis } from '../scripts/build-windows-installer.mjs';

const runFile = promisify(execFile);
const execute = (command: string, args: string[], options: { env?: NodeJS.ProcessEnv; windowsHide?: boolean } = {}) => {
  const running = runFile(command, args, { ...options, encoding: 'utf8', timeout: 10_000, windowsHide: true });
  running.child.stdin?.end();
  return running;
};
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });

async function makeFixture() {
  await fs.mkdir(path.join(process.cwd(), 'test-results'), { recursive: true });
  const root = await fs.mkdtemp(path.join(process.cwd(), 'test-results/nsis-verification-'));
  roots.push(root);
  const source = path.join(root, 'source');
  const extractRoot = path.join(root, 'cache/nsis-3.12');
  const zipPath = path.join(root, 'cache/nsis-3.12.zip');
  for (const relative of ['nsis-3.12/makensis.exe', 'nsis-3.12/Bin/helper.dll', 'nsis-3.12/Include/header.nsh']) {
    const file = path.join(source, relative);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, `owned non-executable fixture: ${relative}`);
  }
  await fs.mkdir(path.dirname(zipPath), { recursive: true });
  await execute('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    "Add-Type -AssemblyName System.IO.Compression.FileSystem; $zip = [IO.Compression.ZipFile]::Open($env:MOCK_NSIS_ARCHIVE, 'Create'); try { foreach ($file in Get-ChildItem -LiteralPath $env:MOCK_NSIS_SOURCE -Recurse -File) { $relative = $file.FullName.Substring($env:MOCK_NSIS_SOURCE.Length + 1).Replace('\\', '/'); $null = [IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, $file.FullName, $relative) } } finally { $zip.Dispose() }"],
  { env: { ...process.env, MOCK_NSIS_SOURCE: source, MOCK_NSIS_ARCHIVE: zipPath }, windowsHide: true });
  await fs.cp(source, extractRoot, { recursive: true });
  const tool = { version: '3.12', sha256: createHash('sha256').update(await fs.readFile(zipPath)).digest('hex') };
  const compilerCalls: string[][] = [];
  const run = async (command: string, args: string[], options: { env?: NodeJS.ProcessEnv } = {}) => {
    if (command.endsWith('makensis.exe')) {
      compilerCalls.push(args);
      return { stdout: 'v3.12', stderr: '' };
    }
    expect(command).toBe('powershell.exe');
    return execute(command, args, { ...options, windowsHide: true });
  };
  return { root, source, extractRoot, zipPath, compilerCalls, dependencies: { tool, run },
    acquire: () => acquireNsis(path.dirname(zipPath), false, { tool, run }) };
}

describe.skipIf(process.platform !== 'win32')('complete NSIS extraction identity before execution', () => {
  it('accepts exact compiler, DLL and include bytes before an injected version call', async () => {
    const fixture = await makeFixture();
    const acquired = await fixture.acquire();
    expect(acquired.compilerVersion).toBe('v3.12');
    expect(fixture.compilerCalls).toEqual([['/VERSION']]);
  });

  it.each(['nsis-3.12/makensis.exe', 'nsis-3.12/Bin/helper.dll', 'nsis-3.12/Include/header.nsh'])(
    'refuses changed extraction bytes at %s without a compiler call', async (relative) => {
      const fixture = await makeFixture();
      const file = path.join(fixture.extractRoot, relative);
      const bytes = await fs.readFile(file);
      bytes[0] ^= 1;
      await fs.writeFile(file, bytes);
      await expect(fixture.acquire()).rejects.toThrow('NSIS extraction SHA-256 mismatch');
      expect(fixture.compilerCalls).toEqual([]);
    },
  );

  it('refuses an adjacent extra DLL even when all expected bytes match', async () => {
    const fixture = await makeFixture();
    await fs.writeFile(path.join(fixture.extractRoot, 'nsis-3.12/extra.dll'), 'untrusted extra fixture');
    await expect(fixture.acquire()).rejects.toThrow('Unexpected NSIS extraction file');
    expect(fixture.compilerCalls).toEqual([]);
  });

  it('refuses a missing DLL in a reusable extraction', async () => {
    const fixture = await makeFixture();
    await fs.unlink(path.join(fixture.extractRoot, 'nsis-3.12/Bin/helper.dll'));
    await expect(fixture.acquire()).rejects.toThrow();
    expect(fixture.compilerCalls).toEqual([]);
  });

  it('refuses a directory junction before inspecting or executing its target', async () => {
    const fixture = await makeFixture();
    const original = path.join(fixture.extractRoot, 'nsis-3.12/Bin');
    const outside = path.join(fixture.root, 'outside');
    await fs.rename(original, outside);
    await fs.symlink(outside, original, 'junction');
    await expect(fixture.acquire()).rejects.toThrow('unexpected link');
    expect(fixture.compilerCalls).toEqual([]);
  });

  it('refuses an extracted file hardlink', async () => {
    const fixture = await makeFixture();
    await fs.link(path.join(fixture.extractRoot, 'nsis-3.12/Bin/helper.dll'), path.join(fixture.root, 'alias.dll'));
    await expect(fixture.acquire()).rejects.toThrow('unexpected link');
    expect(fixture.compilerCalls).toEqual([]);
  });

  it('refuses invalid archive bytes before an injected compiler call', async () => {
    const fixture = await makeFixture();
    await fs.writeFile(fixture.zipPath, 'invalid fixture archive');
    await expect(fixture.acquire()).rejects.toThrow('NSIS cache SHA-256 mismatch');
    expect(fixture.compilerCalls).toEqual([]);
  });

  it('re-verifies DLL identity immediately before the later compile call', async () => {
    const fixture = await makeFixture();
    const acquired = await fixture.acquire();
    await fs.writeFile(path.join(fixture.extractRoot, 'nsis-3.12/Bin/helper.dll'), 'changed after version');
    await expect(runVerifiedNsis(acquired, ['/V4', '/WX', 'owned.nsi'], fixture.dependencies)).rejects.toThrow('NSIS extraction');
    expect(fixture.compilerCalls).toEqual([['/VERSION']]);
  });
});
