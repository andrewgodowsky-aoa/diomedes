import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
// @ts-expect-error The packaged-release check is an executable JavaScript module.
import { checkPackagedRelease } from '../scripts/packaged-release-check.mjs';

// `npm run build` used to package as well, so a desktop smoke run after it was
// always looking at the package just built. Now that packaging is its own
// command, the smoke says so when there is nothing to launch, and warns when
// the package on disk is older than the client build beside it.

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

async function checkout({ packaged = true, dist = true } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'packaged-release-'));
  roots.push(root);
  const executablePath = path.join(root, 'release/Diomedes-win32-x64/nectovia.exe');
  const asar = path.join(root, 'release/Diomedes-win32-x64/resources/app.asar');
  if (packaged) {
    await fs.mkdir(path.dirname(asar), { recursive: true });
    await fs.writeFile(executablePath, 'exe');
    await fs.writeFile(asar, 'asar');
  }
  if (dist) {
    await fs.mkdir(path.join(root, 'dist'), { recursive: true });
    await fs.writeFile(path.join(root, 'dist/index.html'), 'html');
  }
  return { root, executablePath, asar, distIndex: path.join(root, 'dist/index.html') };
}

const at = (file: string, iso: string) => fs.utimes(file, new Date(iso), new Date(iso));

describe('checkPackagedRelease', () => {
  it('names the package command when there is nothing to launch', async () => {
    const { root, executablePath } = await checkout({ packaged: false });
    await expect(checkPackagedRelease({ root, executablePath })).rejects.toThrow(
      /No packaged desktop app at .*nectovia\.exe.*npm run package:windows/s,
    );
  });

  it('is quiet when the package is newer than the client build', async () => {
    const { root, executablePath, asar, distIndex } = await checkout();
    await at(distIndex, '2026-09-20T10:00:00Z');
    await at(asar, '2026-09-20T10:05:00Z');
    const warnings: string[] = [];
    await checkPackagedRelease({ root, executablePath, warn: (m: string) => warnings.push(m) });
    expect(warnings).toEqual([]);
  });

  it('warns, and does not fail, when the client build is newer than the package', async () => {
    const { root, executablePath, asar, distIndex } = await checkout();
    await at(asar, '2026-09-19T10:00:00Z');
    await at(distIndex, '2026-09-20T10:00:00Z');
    const warnings: string[] = [];
    await checkPackagedRelease({ root, executablePath, warn: (m: string) => warnings.push(m) });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/older than dist.*npm run package:windows/s);
  });

  it('does not warn when there is no client build to compare with', async () => {
    const { root, executablePath } = await checkout({ dist: false });
    const warnings: string[] = [];
    await checkPackagedRelease({ root, executablePath, warn: (m: string) => warnings.push(m) });
    expect(warnings).toEqual([]);
  });
});
