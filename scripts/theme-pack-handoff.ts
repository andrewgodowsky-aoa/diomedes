/**
 * Copy the ThemePack v1 contract out of the repository as a standalone handoff
 * bundle, and record what was copied.
 *
 * The bundle is what the website worker consumes: the five source files, the
 * fixtures and the README, with nothing else and no dependencies. A file that
 * reaches outside the folder would break that promise, so this script refuses
 * to publish one.
 *
 *   npx tsx scripts/theme-pack-handoff.ts [destination]
 *
 * Default destination: F:\Diomedes\deliverables\theme-pack-v1
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const source = path.join(root, 'shared/theme-pack');
/** The path the brief names. A caller may override it, under the rule below. */
export const DEFAULT_DESTINATION = 'F:\\Diomedes\\deliverables\\theme-pack-v1';
const destination = path.resolve(process.argv[2] ?? DEFAULT_DESTINATION);

const SOURCE_FILES = [
  'types.ts',
  'validate.ts',
  'resolve.ts',
  'compatibility.ts',
  'package.ts',
] as const;

const files = [
  ...SOURCE_FILES,
  'README.md',
  ...(await fs.readdir(path.join(source, 'fixtures'))).sort().map((name) => `fixtures/${name}`),
];

// The bundle only works standalone if nothing in it imports out of the folder.
for (const file of SOURCE_FILES) {
  const text = await fs.readFile(path.join(source, file), 'utf8');
  for (const [, specifier] of text.matchAll(/from\s+'([^']+)'/g))
    if (!/^\.\/[a-z-]+\.js$/.test(specifier))
      throw new Error(`${file} imports ${specifier}, which is outside the handoff bundle`);
}

/**
 * The destination is caller-supplied, and this script deletes it. It therefore
 * only ever deletes a folder it can recognise as its own: one that does not
 * exist, one that is empty, or one that already holds a MANIFEST.sha256 from a
 * previous run. Anything else is someone's work, and we stop.
 */
const existing = await fs.readdir(destination).catch((error: NodeJS.ErrnoException) => {
  if (error.code === 'ENOENT') return undefined;
  throw error;
});
if (existing && existing.length > 0 && !existing.includes('MANIFEST.sha256'))
  throw new Error(
    `refusing to overwrite ${destination}: it is not empty and holds no MANIFEST.sha256, so it is not a handoff bundle this script wrote`,
  );
if (existing) await fs.rm(destination, { recursive: true, force: true });
await fs.mkdir(path.join(destination, 'fixtures'), { recursive: true });

const manifest: string[] = [];
for (const file of files) {
  const bytes = await fs.readFile(path.join(source, file));
  await fs.writeFile(path.join(destination, file), bytes);
  manifest.push(`${createHash('sha256').update(bytes).digest('hex')}  ${file}`);
}
await fs.writeFile(path.join(destination, 'MANIFEST.sha256'), `${manifest.join('\n')}\n`, 'utf8');

console.log(`ThemePack v1 handoff bundle written to ${destination}`);
for (const line of manifest) console.log(line);
