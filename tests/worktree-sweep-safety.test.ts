import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, describe, expect, test, vi } from 'vitest';

import { detachLinks, retainedIgnoredPaths } from '../scripts/worktree-sweep.js';

const SENTINEL = Buffer.from([0xde, 0xad, 0xbe, 0xef, 0x10, 0x20, 0x30]);
const ownedRoots = new Set<string>();
const ownedLinks = new Set<string>();
const sweepScript = fileURLToPath(new URL('../scripts/worktree-sweep.ts', import.meta.url));
const tsxLoader = pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href;

function tmpDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  ownedRoots.add(dir);
  return dir;
}

function mkdirs(first: string, ...rest: string[]): string {
  const dir = path.join(first, ...rest);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function linkTo(target: string, link: string): string {
  fs.symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir');
  ownedLinks.add(link);
  return link;
}

function isLink(p: string): boolean {
  try {
    return fs.lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

function countLinks(dir: string): number {
  let n = 0;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isSymbolicLink()) n += 1;
    else if (e.isDirectory()) n += countLinks(p);
  }
  return n;
}

function failReads(badDir: string): void {
  const rb = path.resolve(badDir);
  const hit = (p: unknown, opts: unknown): boolean => {
    const rp = path.resolve(String(p));
    if (rp === rb || rp.startsWith(rb + path.sep)) return true;
    const rec =
      typeof opts === 'object' && opts !== null && (opts as { recursive?: boolean }).recursive;
    return Boolean(rec) && rb.startsWith(rp + path.sep);
  };
  const rd = fs.readdirSync.bind(fs) as (...a: unknown[]) => unknown;
  const od = fs.opendirSync.bind(fs) as (...a: unknown[]) => unknown;
  const denied = (): never => {
    throw Object.assign(new Error('read denied'), { code: 'EACCES' });
  };
  vi.spyOn(fs, 'readdirSync').mockImplementation(((p: unknown, o?: unknown) =>
    hit(p, o) ? denied() : rd(p, o)) as unknown as typeof fs.readdirSync);
  vi.spyOn(fs, 'opendirSync').mockImplementation(((p: unknown, o?: unknown) =>
    hit(p, o) ? denied() : od(p, o)) as unknown as typeof fs.opendirSync);
}

function failDetach(linkPath: string): void {
  const rl = path.resolve(linkPath);
  const unlink = fs.unlinkSync.bind(fs);
  vi.spyOn(fs, 'unlinkSync').mockImplementation((p) => {
    if (path.resolve(String(p)) === rl)
      throw Object.assign(new Error('detach denied'), { code: 'EIO' });
    return unlink(p);
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const link of ownedLinks) {
    try {
      fs.rmdirSync(link);
    } catch {
      try {
        fs.unlinkSync(link);
      } catch {
        /* already gone */
      }
    }
  }
  ownedLinks.clear();
  const base = fs.realpathSync(os.tmpdir());
  for (const root of ownedRoots) {
    let real = '';
    try {
      real = fs.realpathSync(root);
    } catch {
      /* already gone */
    }
    if (!real.startsWith(base + path.sep)) continue;
    fs.rmSync(root, { recursive: true, force: true });
  }
  ownedRoots.clear();
});

describe('detachLinks', () => {
  test('preserves ignored local data while allowing dependency links to be detached', () => {
    const root = tmpDir('ws-root-');
    const target = tmpDir('ws-ext-');
    execFileSync('git', ['init', '--quiet', root]);
    fs.writeFileSync(path.join(root, '.gitignore'), '.env\ndist/\nnode_modules/\n');
    fs.writeFileSync(path.join(root, '.env'), 'synthetic local data');
    fs.writeFileSync(path.join(mkdirs(root, 'dist'), 'owned.txt'), 'preserve');
    linkTo(target, path.join(root, 'node_modules'));
    expect(retainedIgnoredPaths(root).sort()).toEqual(['.env', 'dist/']);
    expect(fs.readFileSync(path.join(root, '.env'), 'utf8')).toBe('synthetic local data');
  });

  test('detaches a link nested deeper than seven directories', () => {
    const root = tmpDir('ws-root-');
    const target = tmpDir('ws-ext-');
    const marker = path.join(target, 'sentinel.bin');
    fs.writeFileSync(marker, SENTINEL);
    const deep = mkdirs(root, 'a', 'b', 'c', 'd', 'e', 'f', 'g', 'h');
    const link = linkTo(target, path.join(deep, 'dep_link'));
    expect(detachLinks(root)).toBe(1);
    expect(isLink(link)).toBe(false);
    expect(() => fs.lstatSync(link)).toThrow();
    expect(countLinks(root)).toBe(0);
    expect(fs.statSync(target).isDirectory()).toBe(true);
    expect(fs.readFileSync(marker)).toEqual(SENTINEL);
  });

  test('detaches a broken directory link', () => {
    const root = tmpDir('ws-root-');
    const target = path.join(tmpDir('ws-ext-'), 'missing');
    const link = linkTo(target, path.join(root, 'node_modules'));
    expect(detachLinks(root)).toBe(1);
    expect(() => fs.lstatSync(link)).toThrow();
  });

  test('refuses a root that is itself a link', () => {
    const root = tmpDir('ws-root-');
    const target = tmpDir('ws-ext-');
    const link = linkTo(target, path.join(root, 'linked_root'));
    expect(() => detachLinks(link)).toThrow();
    expect(isLink(link)).toBe(true);
    expect(fs.statSync(target).isDirectory()).toBe(true);
  });

  test('a traversal failure aborts before any link is removed', () => {
    const root = tmpDir('ws-root-');
    const target = tmpDir('ws-ext-');
    const bad = mkdirs(root, 'zzz_blocked');
    const link = linkTo(target, path.join(root, 'aaa_link'));
    failReads(bad);
    expect(() => detachLinks(root)).toThrow();
    vi.restoreAllMocks();
    expect(isLink(link)).toBe(true);
    expect(fs.statSync(target).isDirectory()).toBe(true);
  });

  test('a detach failure refuses and leaves the link in place', () => {
    const root = tmpDir('ws-root-');
    const target = tmpDir('ws-ext-');
    const link = linkTo(target, path.join(root, 'node_modules'));
    failDetach(link);
    expect(() => detachLinks(root)).toThrow();
    vi.restoreAllMocks();
    expect(isLink(link)).toBe(true);
    expect(fs.statSync(target).isDirectory()).toBe(true);
  });

  test('leaves ordinary directories and files untouched and returns zero', () => {
    const root = tmpDir('ws-root-');
    const dir = mkdirs(root, 'src', 'deep', 'deeper');
    const f = path.join(dir, 'keep.txt');
    fs.writeFileSync(f, 'keep');
    expect(detachLinks(root)).toBe(0);
    expect(fs.readFileSync(f, 'utf8')).toBe('keep');
    expect(fs.statSync(dir).isDirectory()).toBe(true);
  });

  test('detaches every link it finds in one pass', () => {
    const root = tmpDir('ws-root-');
    const target = tmpDir('ws-ext-');
    const l1 = linkTo(target, path.join(root, 'one'));
    const l2 = linkTo(target, path.join(mkdirs(root, 'sub'), 'two'));
    expect(detachLinks(root)).toBe(2);
    expect(isLink(l1)).toBe(false);
    expect(isLink(l2)).toBe(false);
    expect(countLinks(root)).toBe(0);
  });
});

describe('sweep in an owned temporary repository', () => {
  function fixture() {
    const root = tmpDir('ws-repo-');
    const repo = mkdirs(root, 'main');
    const worktree = path.join(root, 'landed');
    const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
    git('init', '--quiet');
    fs.writeFileSync(path.join(repo, '.gitignore'), 'node_modules/\n.env\n');
    git('add', '.gitignore');
    git('-c', 'user.name=Sweep fixture', '-c', 'user.email=fixture@example.invalid',
      'commit', '--quiet', '-m', 'Fixture');
    git('update-ref', 'refs/remotes/origin/main', 'HEAD');
    git('worktree', 'add', '--quiet', '-b', 'landed', worktree);
    mkdirs(repo, 'node_modules', 'vitest');
    const admin = git('-C', worktree, 'rev-parse', '--absolute-git-dir');
    const old = new Date(Date.now() - 48 * 60 * 60 * 1000);
    for (const name of ['index', 'HEAD', 'logs/HEAD']) fs.utimesSync(path.join(admin, name), old, old);
    const sweep = () => execFileSync(process.execPath, ['--import', tsxLoader, sweepScript, '--sweep'],
      { cwd: repo, encoding: 'utf8', timeout: 30_000, stdio: 'pipe' });
    return { root, repo, worktree, sweep };
  }

  test('removes only the clean landed checkout and preserves its nested junction target', () => {
    const { root, worktree, sweep } = fixture();
    const target = mkdirs(root, 'external-target');
    fs.writeFileSync(path.join(target, 'sentinel'), SENTINEL);
    linkTo(target, path.join(worktree, 'node_modules'));
    expect(sweep()).toContain('removed 1');
    expect(fs.existsSync(worktree)).toBe(false);
    expect(fs.readFileSync(path.join(target, 'sentinel'))).toEqual(SENTINEL);
  });

  test('keeps a landed checkout containing ignored local data', () => {
    const { worktree, sweep } = fixture();
    fs.writeFileSync(path.join(worktree, '.env'), 'synthetic local data');
    expect(sweep()).toContain('removed 0');
    expect(fs.readFileSync(path.join(worktree, '.env'), 'utf8')).toBe('synthetic local data');
  });

  test('an unreadable ownership record aborts before removing a checkout', () => {
    const { repo, worktree, sweep } = fixture();
    const claims = mkdirs(repo, '.git', 'diomedes-coordination', 'fixture', 'claims');
    fs.writeFileSync(path.join(claims, 'partial.json'), '{');
    expect(sweep).toThrow(/JSON/);
    expect(fs.readFileSync(path.join(worktree, '.gitignore'), 'utf8')).toContain('.env');
  });
});
