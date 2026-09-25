import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// The release notes and the GitHub release body for one version.
//
//   node scripts/release-support/release-body.mjs --version 0.2.0-rc.1 --notes-out notes.txt
//   node scripts/release-support/release-body.mjs --version 0.2.0-rc.1 --readme README.txt --out body.md
//
// Notes, in order (the contract the in-app release-notes lane owns):
//   1. resources/release-notes/releases.json, the entry whose `version` is this
//      version, or its X.Y.Z base for a -rc.N candidate, drawn in the plain-text
//      sections every release README has used (WHAT IS NEW, FIXED, UPDATES, LIMITS);
//   2. docs/releases/notes/v<X.Y.Z>.txt, verbatim, when no entry exists.
// Neither present is an error: a release is never published without notes.
//
// The notes continue the README (scripts/write-release-assets.mjs --notes), and
// the body is that README, as the bodies of 0.1.7 to 0.1.11 were: file choice,
// checksums and what was verified first, the notes from WHAT IS NEW on. The
// update check reads the body from that heading on (notesFromReleaseBody in
// shared/release-notes.ts), so the heading is kept exactly.

const root = fileURLToPath(new URL('../../', import.meta.url));
const VERSION = /^(\d+\.\d+\.\d+)(?:-rc\.(\d+))?$/;
const WIDTH = 78;
/** The README's section names for the releases.json section titles. */
const HEADINGS = new Map([
  ['new', 'WHAT IS NEW'],
  ['fixed', 'FIXED'],
  ['updating', 'UPDATES'],
  ['known limits', 'LIMITS'],
]);

export function parseReleaseVersion(value) {
  const match = VERSION.exec(String(value ?? '').trim());
  if (!match) throw new Error(`Version ${value} is neither X.Y.Z nor X.Y.Z-rc.N.`);
  return { version: match[0], base: match[1], candidate: match[2] === undefined ? null : Number(match[2]) };
}

/** The releases.json entry for a version, or null. */
export function releaseEntry(releases, version) {
  if (!releases || releases.schemaVersion !== 1 || !Array.isArray(releases.releases)) return null;
  const { version: exact, base } = parseReleaseVersion(version);
  return (
    releases.releases.find((entry) => entry?.version === exact) ??
    releases.releases.find((entry) => entry?.version === base) ??
    null
  );
}

/** One paragraph, wrapped at WIDTH with a two-space indent, as the README's sections are. */
function paragraph(text) {
  const lines = [];
  let line = '';
  for (const word of text.trim().split(/\s+/)) {
    if (line && 2 + line.length + 1 + word.length > WIDTH) {
      lines.push(`  ${line}`);
      line = word;
    } else line = line ? `${line} ${word}` : word;
  }
  if (line) lines.push(`  ${line}`);
  return lines.join('\n');
}

export function sectionHeading(title) {
  const key = String(title).trim().toLowerCase();
  return HEADINGS.get(key) ?? key.toUpperCase().replace(/[^A-Z ]+/g, ' ').replace(/\s+/g, ' ').trim();
}

/** A releases.json entry as README sections: the headline opens WHAT IS NEW, each item a paragraph. */
export function renderEntry(entry) {
  const sections = [];
  const items = (list) => list.filter((item) => typeof item === 'string' && item.trim()).map(paragraph);
  const headline = typeof entry.headline === 'string' && entry.headline.trim() ? paragraph(entry.headline) : null;
  const given = Array.isArray(entry.sections) ? entry.sections : [];
  let opened = false;
  for (const section of given) {
    if (typeof section?.title !== 'string' || !Array.isArray(section.items)) continue;
    const heading = sectionHeading(section.title);
    const body = items(section.items);
    if (heading === 'WHAT IS NEW' && headline) body.unshift(headline), (opened = true);
    if (body.length) sections.push(`${heading}\n${body.join('\n\n')}`);
  }
  if (headline && !opened) sections.unshift(`WHAT IS NEW\n${headline}`);
  const text = sections.join('\n\n').trim();
  if (!text) throw new Error(`The releases.json entry for ${entry.version} has no headline and no items.`);
  return text;
}

/** The notes that continue the README, and where they came from. */
export function releaseNotes({ version, releases = null, notes = null }) {
  const parsed = parseReleaseVersion(version);
  const entry = releaseEntry(releases, parsed.version);
  if (entry) return { text: renderEntry(entry), source: 'resources/release-notes/releases.json' };
  if (typeof notes === 'string' && notes.trim())
    return { text: notes.replace(/\r\n/g, '\n').trimEnd(), source: `docs/releases/notes/v${parsed.base}.txt` };
  throw new Error(
    `No release notes for ${parsed.version}: neither releases.json nor docs/releases/notes/v${parsed.base}.txt has them.`,
  );
}

/** The GitHub body: the README, with a candidate saying first that it is one. */
export function releaseBody({ version, readme }) {
  const parsed = parseReleaseVersion(version);
  const text = String(readme ?? '').replace(/\r\n/g, '\n').trim();
  if (!text) throw new Error('The README is empty; the release body is the README.');
  if (!/^WHAT IS NEW$/m.test(text)) throw new Error('The README has no WHAT IS NEW section for the update check to read.');
  const candidate =
    parsed.candidate === null
      ? ''
      : `RELEASE CANDIDATE ${parsed.candidate} of ${parsed.base}. Installed copies are never offered a candidate as an update.\n\n`;
  return `${candidate}${text}\n`;
}

async function readJson(file) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const option = (flag) => {
    const index = args.indexOf(flag);
    return index === -1 ? undefined : args[index + 1];
  };
  const version = option('--version');
  if (!version) throw new Error('--version is required.');
  const { base } = parseReleaseVersion(version);
  if (option('--notes-out')) {
    const releases = await readJson(path.join(root, 'resources/release-notes/releases.json'));
    const notes = await fs
      .readFile(path.join(root, `docs/releases/notes/v${base}.txt`), 'utf8')
      .catch((error) => {
        if (error.code === 'ENOENT') return null;
        throw error;
      });
    const { text, source } = releaseNotes({ version, releases, notes });
    await fs.writeFile(path.resolve(option('--notes-out')), `${text}\n`);
    console.log(`Release notes for ${version} from ${source}.`);
  }
  if (option('--out')) {
    if (!option('--readme')) throw new Error('--out needs --readme: the body is the README.');
    const readme = await fs.readFile(path.resolve(option('--readme')), 'utf8');
    await fs.writeFile(path.resolve(option('--out')), releaseBody({ version, readme }));
    console.log(`Release body for ${version} from ${option('--readme')}.`);
  }
}
