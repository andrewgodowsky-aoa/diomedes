import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LOCK_NAME, inspectLock, readLock } from '../../server/lock.js';
import { REPO_ROOT, SUITE_ROOT, business } from './suite.js';
import { TODAY } from './workspace.js';

/**
 * Where the app keeps its state, and why a reset owns three folders.
 *
 * Nectovia records threads, tasks, the board, history and settings in its data folder,
 * keyed by project id (`registry.json`, `settings.json`, `projects/<id>/state.json`).
 * A project folder holds only the business's files. The desktop app takes its data
 * folder from DIOMEDES_DATA_DIR, its Electron profile (browser storage, sign-in) from
 * DIOMEDES_DESKTOP_PROFILE and its default project root from DIOMEDES_PROJECTS_DIR, and
 * never runs its first-launch reset on a location chosen that way (desktop/main.mjs).
 *
 * So a reset writes, under <root>/<slug>/:
 *   projects/<Business Name>/   the workspace, copied byte for byte from this repository
 *   data/                       an empty app data folder: no projects, threads or tasks
 *   profile/                    an empty desktop profile: no sign-in, no browser storage
 * and "starts empty" is achieved by pointing the app at that data and profile. Nothing
 * here reads or writes the real %APPDATA%\Diomedes, and every location it guards is
 * refused before anything is deleted.
 */
export const MARKER = '.nectovia-sample.json';

export function defaultRoot(env: NodeJS.ProcessEnv = process.env): string {
  if (env.DIOMEDES_SAMPLES_DIR) return path.resolve(env.DIOMEDES_SAMPLES_DIR);
  const base = env.LOCALAPPDATA || os.tmpdir();
  return path.join(base, 'nectovia-sample-businesses');
}

/** `<slug...|all> [--root <folder>]`, in any order. */
export function parseResetArgs(args: string[], env: NodeJS.ProcessEnv = process.env) {
  const at = args.indexOf('--root');
  if (at >= 0 && (!args[at + 1] || args[at + 1].startsWith('--')))
    throw new Error('--root needs a folder');
  const root = at >= 0 ? path.resolve(args[at + 1]) : defaultRoot(env);
  const slugs = args.filter((a, i) => !a.startsWith('--') && !(at >= 0 && i === at + 1));
  return { root, slugs };
}

/** The nearest existing ancestor resolved through links and 8.3 aliases, plus the rest. */
export function realish(p: string): string {
  let current = path.resolve(p);
  const rest: string[] = [];
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) break;
    rest.unshift(path.basename(current));
    current = parent;
  }
  return path.join(fs.realpathSync.native(current), ...rest);
}

const same = (a: string, b: string) =>
  path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
const inside = (root: string, candidate: string) => {
  const rel = path.relative(root.toLowerCase(), candidate.toLowerCase());
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
};

/**
 * Locations a reset must never write into or delete around: this repository, the real
 * app data and profile, the default projects folder, and every project folder the real
 * app has registered. The registry is only read.
 */
export function guardedLocations(env: NodeJS.ProcessEnv = process.env): string[] {
  const out = [REPO_ROOT, os.homedir()];
  const home = env.USERPROFILE || os.homedir();
  for (const base of [env.APPDATA, env.LOCALAPPDATA].filter(Boolean) as string[])
    out.push(path.join(base, 'Diomedes'));
  for (const docs of [
    path.join(home, 'Documents'),
    env.OneDrive && path.join(env.OneDrive, 'Documents'),
  ].filter(Boolean) as string[])
    out.push(path.join(docs, 'Diomedes'));
  if (env.APPDATA) {
    try {
      const registry = JSON.parse(
        fs.readFileSync(path.join(env.APPDATA, 'Diomedes', 'data', 'registry.json'), 'utf8'),
      );
      for (const project of Array.isArray(registry) ? registry : [])
        if (typeof project?.folder === 'string') out.push(project.folder);
    } catch {
      // No real app data on this machine, or unreadable: nothing more to guard.
    }
  }
  return out;
}

/** Refuse a target that is, contains or sits inside a guarded location. */
export function assertSafeTarget(target: string, guarded: string[]) {
  const real = realish(target);
  if (same(real, path.parse(real).root))
    throw new Error(`Refusing to reset into a drive root: ${target}`);
  // The sample root may sit inside the home folder (AppData\Local does); it may not be or
  // hold it. Checked first, so the refusal reads the same wherever the repository lives.
  if (inside(real, realish(os.homedir())))
    throw new Error(`Refusing to reset ${target}: it is or holds the home folder.`);
  for (const g of guarded) {
    if (same(g, os.homedir())) continue;
    const gr = realish(g);
    if (inside(gr, real) || inside(real, gr))
      throw new Error(
        `Refusing to reset ${target}: it overlaps ${g}, which a sample reset never touches.`,
      );
  }
}

/** Refuse to delete through a junction or symbolic link. */
function assertNoLinks(dir: string) {
  for (const entry of fs.readdirSync(dir)) {
    const p = path.join(dir, entry);
    const stat = fs.lstatSync(p);
    if (stat.isSymbolicLink())
      throw new Error(
        `Refusing to delete ${dir}: ${p} is a link or junction. Remove it by hand first.`,
      );
    if (stat.isDirectory()) assertNoLinks(p);
  }
}

export function treeDigest(dir: string): { files: number; sha256: string } {
  const hash = crypto.createHash('sha256');
  let files = 0;
  const walk = (d: string, rel: string) => {
    for (const entry of fs
      .readdirSync(d, { withFileTypes: true })
      .sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const r = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        hash.update(`dir ${r}\n`);
        walk(path.join(d, entry.name), r);
      } else {
        files++;
        hash.update(`file ${r}\n`).update(fs.readFileSync(path.join(d, entry.name)));
      }
    }
  };
  walk(dir, '');
  return { files, sha256: hash.digest('hex') };
}

/** A single-quoted PowerShell string. */
const ps = (p: string) => `'${p.replace(/'/g, "''")}'`;

export type ResetResult = {
  slug: string;
  target: string;
  project: string;
  dataDir: string;
  profileDir: string;
  files: number;
  sha256: string;
};

export async function resetBusiness(
  slug: string,
  options: { root?: string; suiteRoot?: string; guarded?: string[] } = {},
): Promise<ResetResult> {
  const b = business(slug);
  const root = path.resolve(options.root ?? defaultRoot());
  const target = path.join(root, b.slug);
  assertSafeTarget(target, options.guarded ?? guardedLocations());
  const source = path.join(options.suiteRoot ?? SUITE_ROOT, b.slug, 'workspace');
  if (!fs.existsSync(source)) throw new Error(`No committed workspace for ${b.slug} at ${source}`);

  if (fs.existsSync(target)) {
    if (!fs.statSync(target).isDirectory() || !fs.existsSync(path.join(target, MARKER)))
      throw new Error(
        `Refusing to replace ${target}: it was not written by a sample reset (no ${MARKER}).`,
      );
    const lock = await readLock(path.join(target, 'data', LOCK_NAME));
    if (lock !== null && (await inspectLock(lock)).held)
      throw new Error(
        `Refusing to reset ${b.slug}: Nectovia is running on ${path.join(target, 'data')}. Close it first.`,
      );
    assertNoLinks(target);
    fs.rmSync(target, { recursive: true, force: true });
  }

  const project = path.join(target, 'projects', b.name);
  const dataDir = path.join(target, 'data');
  const profileDir = path.join(target, 'profile');
  fs.mkdirSync(project, { recursive: true });
  fs.mkdirSync(dataDir);
  fs.mkdirSync(profileDir);
  fs.cpSync(source, project, { recursive: true });
  const digest = treeDigest(project);
  fs.writeFileSync(
    path.join(target, MARKER),
    JSON.stringify(
      { slug: b.slug, name: b.name, today: TODAY, files: digest.files, sha256: digest.sha256 },
      null,
      2,
    ) + '\n',
  );
  fs.writeFileSync(
    path.join(target, 'env.ps1'),
    [
      `# Dot-source this, then start Nectovia from the same PowerShell window: . ${ps(path.join(target, 'env.ps1'))}`,
      `$env:DIOMEDES_DESKTOP_PROFILE = ${ps(profileDir)}`,
      `$env:DIOMEDES_DATA_DIR = ${ps(dataDir)}`,
      `$env:DIOMEDES_PROJECTS_DIR = ${ps(path.join(target, 'projects'))}`,
      '',
    ].join('\r\n'),
  );
  return { slug: b.slug, target, project, dataDir, profileDir, ...digest };
}
