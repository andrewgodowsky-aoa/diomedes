import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

/**
 * Run by the desktop smoke drivers before they launch the packaged app.
 *
 * `npm run build` used to package too, so a smoke run after it always launched
 * the package just built. Packaging is now its own command, which leaves two
 * ways to be wrong: nothing has been packaged, or the package on disk predates
 * the source being checked.
 *
 * A missing package is an error, with the command that makes one. A package
 * older than `dist/` is only a warning: the release gates rebuild the client
 * with Vite before the smoke runs, so a newer `dist/` is normal there and does
 * not mean the package is out of date.
 */
export async function checkPackagedRelease({
  root = process.cwd(),
  executablePath,
  warn = (message) => console.warn(message),
}) {
  const stat = (file) => fs.stat(file).catch(() => null);
  if (!(await stat(executablePath))?.isFile())
    throw new Error(
      `No packaged desktop app at ${executablePath}. \`npm run build\` no longer packages; run \`npm run package:windows\` first.`,
    );
  const asar = await stat(path.join(path.dirname(executablePath), 'resources/app.asar'));
  const dist = await stat(path.join(root, 'dist/index.html'));
  if (asar && dist && dist.mtimeMs > asar.mtimeMs)
    warn(
      `The packaged app (${asar.mtime.toISOString()}) is older than dist/ (${dist.mtime.toISOString()}). If the source changed since it was packaged, this smoke is checking the previous build; run \`npm run package:windows\`.`,
    );
}

/**
 * Phase 0 of the update-refresh work (docs/research/2026-09-25-skin-layering-and-update-refresh.md):
 * a build whose app files differ from its version's release tag cannot keep that version.
 *
 * `837a426` landed after `v0.1.11` and still said 0.1.11, so the updater, which
 * offers only a newer version, could never deliver it, and nobody could tell
 * that build from the release. This refuses exactly that, and nothing else:
 *
 * - the version is tagged, and HEAD's app files differ from the tag: refused,
 *   with the changed files named;
 * - the version is tagged and HEAD's app files match it: a rebuild of the
 *   release, allowed;
 * - the version is not tagged yet: allowed only when it is ahead of every
 *   release tag.
 *
 * Only a release runs it (`npm run release:check`, `package-desktop --release`
 * and the tag workflow), so ordinary pull requests between releases stay green.
 */
export const RELEASED_APP_PATHS = [
  'client',
  'server',
  'shared',
  'desktop',
  'resources',
  'index.html',
  'vite.config.ts',
  'package-lock.json',
];

const RELEASE_TAG = /^v(\d+)\.(\d+)\.(\d+)$/;
const parts = (version) => {
  const match = RELEASE_TAG.exec(`v${version}`);
  return match ? match.slice(1).map(Number) : null;
};
const compare = (a, b) => {
  for (let index = 0; index < 3; index++) if (a[index] !== b[index]) return a[index] - b[index];
  return 0;
};

/**
 * @param {{ root?: string, version?: string, git?: (args: string[]) => string }} options
 * @returns {Promise<{ ok: boolean, message: string, tag: string | null, changed: string[] }>}
 */
export async function checkReleaseVersion({ root = process.cwd(), version, git } = {}) {
  const run =
    git ??
    ((args) =>
      execFileSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }));
  const current = version ?? JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8')).version;
  const mine = parts(current);
  if (!mine)
    return { ok: false, message: `package.json version ${current} is not X.Y.Z.`, tag: null, changed: [] };
  const tags = run(['tag', '--list', 'v*'])
    .split(/\r?\n/)
    .map((tag) => tag.trim())
    .filter((tag) => RELEASE_TAG.test(tag));
  const fetchHint = 'Fetch the release tags first: git fetch --tags --unshallow (or git fetch --tags).';
  if (tags.length === 0)
    return { ok: false, message: `No release tags are visible here. ${fetchHint}`, tag: null, changed: [] };
  const own = `v${current}`;
  if (tags.includes(own)) {
    try {
      run(['merge-base', '--is-ancestor', own, 'HEAD']);
    } catch {
      return {
        ok: false,
        message: `${own} is not in this branch's history (or the history is shallow). ${fetchHint}`,
        tag: own,
        changed: [],
      };
    }
    const changed = run(['diff', '--name-only', own, 'HEAD', '--', ...RELEASED_APP_PATHS])
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    if (changed.length > 0)
      return {
        ok: false,
        message:
          `The app files changed since ${own}, and package.json still says ${current}. ` +
          `Bump the version before releasing, or the updater will never offer this build. ` +
          `Changed: ${changed.slice(0, 20).join(', ')}${changed.length > 20 ? ` and ${changed.length - 20} more` : ''}.`,
        tag: own,
        changed,
      };
    return { ok: true, message: `The app files match ${own}: this is a rebuild of that release.`, tag: own, changed: [] };
  }
  const latest = tags.map((tag) => tag.slice(1)).sort((a, b) => compare(parts(b), parts(a)))[0];
  if (compare(mine, parts(latest)) <= 0)
    return {
      ok: false,
      message: `package.json says ${current}, which is not ahead of the latest release v${latest}. Bump the version.`,
      tag: null,
      changed: [],
    };
  return { ok: true, message: `${own} is not tagged yet and is ahead of v${latest}: ready to release.`, tag: null, changed: [] };
}
