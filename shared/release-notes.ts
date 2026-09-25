/**
 * Release notes: the shared contract for `resources/release-notes/releases.json`.
 *
 * That file is the single source of truth for what each release changed. The
 * desktop app bundles it, the website reads it from this repository's `main`,
 * and the release pipeline adds each new release's entry. All three read it
 * through the rules below, so a change to them is a change to a contract three
 * parties share.
 *
 * Releases are ordered newest first. Every string is plain text written for a
 * person: no markdown, no HTML and no line breaks, because the app, the site and
 * the pipeline each draw it their own way and none of them interprets markup.
 * A `draft` entry is the next release being written; nothing a person reads
 * shows it, and the pipeline flips it to `stable` when that release ships.
 *
 * Pure data handling: no clock, no filesystem, no network.
 */
import { compareVersions, parseStableVersion } from './app-updates.js';

export const RELEASE_NOTES_SCHEMA_VERSION = 1;
export const RELEASE_CHANNELS = ['stable', 'draft'] as const;
export const RELEASE_PLATFORMS = ['windows', 'macos'] as const;
export type ReleaseChannel = (typeof RELEASE_CHANNELS)[number];
export type ReleasePlatform = (typeof RELEASE_PLATFORMS)[number];

export interface ReleaseSection {
  title: string;
  items: string[];
}

export interface ReleaseEntry {
  version: string;
  /** `YYYY-MM-DD`, the day the release was published. */
  date: string;
  channel: ReleaseChannel;
  platforms: ReleasePlatform[];
  headline: string;
  sections: ReleaseSection[];
}

export interface ReleaseNotesFile {
  schemaVersion: typeof RELEASE_NOTES_SCHEMA_VERSION;
  releases: ReleaseEntry[];
}

/** Bounds that keep every surface's layout honest; generous for prose, tight for labels. */
export const RELEASE_NOTES_LIMITS = {
  headline: 240,
  sectionTitle: 40,
  item: 1200,
  sections: 8,
  items: 40,
} as const;

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
// Control characters, including line breaks: a note is one run of text.
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;
// A tag, a comment or an entity is HTML, whether or not it would render.
const HTML = /<\s*[a-z/!?]|&(?:[a-z]+|#\d+|#x[0-9a-f]+);/i;
// Markup a Markdown reader would act on: emphasis, code, links, headings, list and quote markers.
const MARKDOWN = [/\*\*|__|`/, /\[[^\]]*\]\([^)]*\)/, /^\s*(?:#{1,6}\s|[-*+]\s|>\s|\d+\.\s)/];

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Why a string is not plain text for a person, or null when it is. */
export function plainTextProblem(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return 'must be a string';
  if (!value.trim()) return 'must not be empty';
  if (value !== value.trim()) return 'must not start or end with spaces';
  if (value.length > max) return `must be at most ${max} characters`;
  if (CONTROL.test(value)) return 'must be one line of plain text';
  if (HTML.test(value)) return 'must not contain HTML';
  if (MARKDOWN.some((pattern) => pattern.test(value))) return 'must not contain markdown';
  return null;
}

function validDate(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const match = DATE.exec(value);
  if (!match) return false;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
  );
}

function unknownKeys(value: Record<string, unknown>, allowed: readonly string[]): string[] {
  return Object.keys(value).filter((key) => !allowed.includes(key));
}

export type ReleaseNotesResult =
  | { ok: true; file: ReleaseNotesFile }
  | { ok: false; errors: string[] };

/**
 * Check a parsed `releases.json` against the contract. Every problem is named
 * with where it is, so a pipeline or a reviewer can fix all of them at once.
 * Unknown fields are refused rather than ignored: a field one reader acts on
 * and another drops is how three surfaces start to disagree.
 */
export function validateReleaseNotes(value: unknown): ReleaseNotesResult {
  const errors: string[] = [];
  if (!isRecord(value)) return { ok: false, errors: ['The file must be a JSON object.'] };
  for (const key of unknownKeys(value, ['schemaVersion', 'releases']))
    errors.push(`Unknown field "${key}" at the top level.`);
  if (value.schemaVersion !== RELEASE_NOTES_SCHEMA_VERSION)
    errors.push(`schemaVersion must be ${RELEASE_NOTES_SCHEMA_VERSION}.`);
  if (!Array.isArray(value.releases) || value.releases.length === 0) {
    errors.push('releases must be a non-empty array.');
    return { ok: false, errors };
  }
  const seen = new Set<string>();
  let previous: { version: string; date: string } | null = null;
  let stableSeen = false;
  value.releases.forEach((entry, index) => {
    const at = `releases[${index}]`;
    if (!isRecord(entry)) {
      errors.push(`${at} must be an object.`);
      return;
    }
    const label = typeof entry.version === 'string' ? `${at} (${entry.version})` : at;
    for (const key of unknownKeys(entry, [
      'version',
      'date',
      'channel',
      'platforms',
      'headline',
      'sections',
    ]))
      errors.push(`${label}: unknown field "${key}".`);
    const version = parseStableVersion(entry.version);
    if (!version || version !== entry.version)
      errors.push(`${label}: version must be a stable X.Y.Z with no "v" prefix.`);
    else if (seen.has(version)) errors.push(`${label}: version ${version} appears twice.`);
    else seen.add(version);
    if (!validDate(entry.date)) errors.push(`${label}: date must be a real YYYY-MM-DD day.`);
    if (!RELEASE_CHANNELS.includes(entry.channel as ReleaseChannel))
      errors.push(`${label}: channel must be "stable" or "draft".`);
    else if (entry.channel === 'stable') stableSeen = true;
    else if (stableSeen)
      errors.push(`${label}: a draft must be newer than every stable release, so it comes first.`);
    if (
      !Array.isArray(entry.platforms) ||
      entry.platforms.length === 0 ||
      entry.platforms.some((p) => !RELEASE_PLATFORMS.includes(p as ReleasePlatform)) ||
      new Set(entry.platforms).size !== entry.platforms.length
    )
      errors.push(`${label}: platforms must list "windows" and/or "macos", each once.`);
    const headline = plainTextProblem(entry.headline, RELEASE_NOTES_LIMITS.headline);
    if (headline) errors.push(`${label}: headline ${headline}.`);
    if (
      !Array.isArray(entry.sections) ||
      entry.sections.length === 0 ||
      entry.sections.length > RELEASE_NOTES_LIMITS.sections
    ) {
      errors.push(
        `${label}: sections must be an array of 1 to ${RELEASE_NOTES_LIMITS.sections} sections.`,
      );
    } else {
      const titles = new Set<string>();
      entry.sections.forEach((section, s) => {
        const where = `${label} sections[${s}]`;
        if (!isRecord(section)) {
          errors.push(`${where} must be an object.`);
          return;
        }
        for (const key of unknownKeys(section, ['title', 'items']))
          errors.push(`${where}: unknown field "${key}".`);
        const title = plainTextProblem(section.title, RELEASE_NOTES_LIMITS.sectionTitle);
        if (title) errors.push(`${where}: title ${title}.`);
        else if (titles.has(section.title as string))
          errors.push(`${where}: the title "${section.title}" appears twice in one release.`);
        else titles.add(section.title as string);
        if (
          !Array.isArray(section.items) ||
          section.items.length === 0 ||
          section.items.length > RELEASE_NOTES_LIMITS.items
        ) {
          errors.push(`${where}: items must be an array of 1 to ${RELEASE_NOTES_LIMITS.items}.`);
          return;
        }
        section.items.forEach((item, i) => {
          const problem = plainTextProblem(item, RELEASE_NOTES_LIMITS.item);
          if (problem) errors.push(`${where} items[${i}] ${problem}.`);
        });
      });
    }
    if (version && version === entry.version && validDate(entry.date)) {
      if (previous) {
        if (compareVersions(version, previous.version) >= 0)
          errors.push(
            `${label}: releases must be newest first, but ${version} follows ${previous.version}.`,
          );
        else if (entry.date > previous.date)
          errors.push(`${label}: its date ${entry.date} is later than ${previous.version}'s.`);
      }
      previous = { version, date: entry.date };
    }
  });
  return errors.length > 0 ? { ok: false, errors } : { ok: true, file: value as unknown as ReleaseNotesFile };
}

/**
 * What a person may read: stable releases only, newest first. A draft is the
 * next release being written and is never shown, and a file that fails the
 * contract shows nothing rather than a guess.
 */
export function publishedReleases(value: unknown): ReleaseEntry[] {
  const result = validateReleaseNotes(value);
  if (!result.ok) return [];
  return result.file.releases.filter((entry) => entry.channel === 'stable');
}

/** The published notes for one version, or null when there are none to show. */
export function publishedRelease(value: unknown, version: string | null): ReleaseEntry | null {
  if (!version) return null;
  return publishedReleases(value).find((entry) => entry.version === version) ?? null;
}

/** The most "seen" versions kept; older ones can never be installed again past a downgrade guard. */
export const RELEASE_NOTES_SEEN_LIMIT = 50;

/**
 * Whether the notes for the installed version should be offered once, as a
 * notice, when the app opens. They are offered when all of these hold:
 *
 * - the installed version has published notes;
 * - the person has not already dismissed them (`seen` holds the versions whose
 *   notice was dismissed);
 * - setup is finished, and it finished before the installed version was
 *   released — which is what makes this launch an update rather than a new
 *   install. Without a recorded finish time there is no way to tell, and no
 *   notice is offered.
 *
 * The day is the unit because a release carries a day, not a time: someone who
 * finishes setup and then updates on the release day itself sees no notice, and
 * Settings > What's new still has the notes.
 */
export function releaseNoticeFor(input: {
  notes: unknown;
  installedVersion: string | null;
  seen: readonly string[] | undefined;
  setupDone: boolean;
  setupCompletedAt: string | null;
}): ReleaseEntry | null {
  const entry = publishedRelease(input.notes, input.installedVersion);
  if (!entry) return null;
  if (input.seen?.includes(entry.version)) return null;
  if (!input.setupDone || !input.setupCompletedAt) return null;
  const finished = Date.parse(input.setupCompletedAt);
  if (!Number.isFinite(finished)) return null;
  if (new Date(finished).toISOString().slice(0, 10) >= entry.date) return null;
  return entry;
}

/** The `seen` list after dismissing one version's notice: that version added once, oldest dropped. */
export function withReleaseNoticeSeen(seen: readonly string[] | undefined, version: string): string[] {
  const next = (seen ?? []).filter((item) => item !== version);
  next.push(version);
  return next.slice(-RELEASE_NOTES_SEEN_LIMIT);
}

/** Bound for a GitHub release body carried into the update card. */
export const RELEASE_BODY_MAX_CHARS = 12_000;
const BODY_START = /^(WHAT IS NEW|UPDATES|NEW|WHAT'S NEW)\s*$/m;

/**
 * The person-facing part of a GitHub release body, as plain text, for the
 * update card when the bundled file does not know the offered version yet.
 * Release bodies here open with installer and checksum instructions and then
 * the notes under `WHAT IS NEW` (or `UPDATES`); from that heading on is what
 * is kept. The text is never interpreted as markup — the card draws it as
 * text — but control characters are removed and the length is bounded.
 */
export function notesFromReleaseBody(body: unknown): string | null {
  if (typeof body !== 'string') return null;
  // eslint-disable-next-line no-control-regex
  let text = body.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '');
  const start = BODY_START.exec(text);
  if (start) text = text.slice(start.index);
  text = text.trim();
  if (!text) return null;
  if (text.length > RELEASE_BODY_MAX_CHARS)
    text = `${text.slice(0, RELEASE_BODY_MAX_CHARS).trimEnd()}…`;
  return text;
}
