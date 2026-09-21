import fs from 'node:fs/promises';
import path from 'node:path';

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
