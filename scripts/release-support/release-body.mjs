import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// The GitHub release body for one version.
//
//   node scripts/release-support/release-body.mjs --version 0.2.0-rc.1 --commit <sha> [--macos] --out body.md
//
// Source, in order (the contract the in-app release-notes lane owns):
//   1. resources/release-notes/releases.json, the entry whose `version` is this
//      version, or its X.Y.Z base for a -rc.N candidate;
//   2. docs/releases/notes/v<X.Y.Z>.txt, verbatim, when that file or entry is absent.
// Neither present is an error: a release is never published with an empty body.
// A short footer names the commit and points at README.txt and SHA256SUMS.txt,
// which carry the verification and the checksums; the body restates neither.

const root = fileURLToPath(new URL('../../', import.meta.url));
const VERSION = /^(\d+\.\d+\.\d+)(?:-rc\.(\d+))?$/;

export function parseReleaseVersion(value) {
  const match = VERSION.exec(String(value ?? '').trim());
  if (!match) throw new Error(`Version ${value} is neither X.Y.Z nor X.Y.Z-rc.N.`);
  return {
    version: match[0],
    base: match[1],
    candidate: match[2] === undefined ? null : Number(match[2]),
  };
}

/** The releases.json entry for a version, or null. The file is validated only as far as it is read. */
export function releaseEntry(releases, version) {
  if (!releases || releases.schemaVersion !== 1 || !Array.isArray(releases.releases)) return null;
  const { version: exact, base } = parseReleaseVersion(version);
  return (
    releases.releases.find((entry) => entry?.version === exact) ??
    releases.releases.find((entry) => entry?.version === base) ??
    null
  );
}

export function renderEntry(entry) {
  const lines = [];
  if (typeof entry.headline === 'string' && entry.headline.trim())
    lines.push(entry.headline.trim(), '');
  for (const section of Array.isArray(entry.sections) ? entry.sections : []) {
    if (typeof section?.title !== 'string' || !Array.isArray(section.items)) continue;
    lines.push(`## ${section.title.trim()}`, '');
    for (const item of section.items)
      if (typeof item === 'string' && item.trim()) lines.push(`- ${item.trim()}`);
    lines.push('');
  }
  const text = lines.join('\n').trim();
  if (!text)
    throw new Error(`The releases.json entry for ${entry.version} has no headline and no items.`);
  return text;
}

export function releaseBody({ version, commit, releases = null, notes = null, macos = false }) {
  const parsed = parseReleaseVersion(version);
  const entry = releaseEntry(releases, parsed.version);
  let text;
  let source;
  if (entry) {
    text = renderEntry(entry);
    source = 'resources/release-notes/releases.json';
  } else if (typeof notes === 'string' && notes.trim()) {
    text = ['```', notes.replace(/\r\n/g, '\n').trimEnd(), '```'].join('\n');
    source = `docs/releases/notes/v${parsed.base}.txt`;
  } else
    throw new Error(
      `No release notes for ${parsed.version}: neither releases.json nor docs/releases/notes/v${parsed.base}.txt has them.`,
    );
  const platforms = macos ? 'Windows x64 and macOS arm64' : 'Windows x64';
  const heading =
    parsed.candidate === null
      ? `Nectovia ${parsed.base}, experimental ${platforms} build.`
      : `Release candidate ${parsed.candidate} of Nectovia ${parsed.base}, experimental ${platforms} build. Not an update: installed copies are never offered a candidate.`;
  const footer = [
    '---',
    `Built from commit ${commit}. README.txt beside this release says which file to download, what was verified on these exact bytes, and what was not; SHA256SUMS.txt lists every file's SHA-256.`,
  ].join('\n');
  return { body: `${heading}\n\n${text}\n\n${footer}\n`, source };
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
    if (index === -1 || !args[index + 1]) throw new Error(`${flag} is required.`);
    return args[index + 1];
  };
  const version = option('--version');
  const { base } = parseReleaseVersion(version);
  const releases = await readJson(path.join(root, 'resources/release-notes/releases.json'));
  const notes = await fs
    .readFile(path.join(root, `docs/releases/notes/v${base}.txt`), 'utf8')
    .catch((error) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
  const { body, source } = releaseBody({
    version,
    commit: option('--commit'),
    releases,
    notes,
    macos: args.includes('--macos'),
  });
  await fs.writeFile(path.resolve(option('--out')), body);
  console.log(`Release body for ${version} from ${source}.`);
}
