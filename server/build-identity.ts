import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Which build is actually running.
 *
 * A stale shortcut, a second installed copy and a build made from uncommitted
 * source all look identical from inside the app today, so a support
 * conversation argues about a remembered version instead of reading one.
 * `scripts/package-desktop.mjs` already stamps `BUILD_INFO.json` at the root of
 * the packaged tree, and `scripts/write-candidate-record.ts` proves the copy
 * inside `resources/app.asar` is byte-identical to the recorded one. This reads
 * that record and says plainly when there is none.
 *
 * Nothing here runs `git`. A packaged app has no repository to ask, and a
 * process spawn during a support export is exactly the wrong thing to add.
 */

// Defined only by the desktop bundler, the same way
// server/harness/capabilities/format-report.ts guards its packaged fixture path.
declare const DIOMEDES_BUNDLED: boolean | undefined;

/** Where the identity came from. Reported separately from `packaged`. */
export type BuildRecordSource = 'build-record' | 'development' | 'unreadable-record';

export interface BuildIdentity {
  /** The version the record stamped, or the running package version without one. */
  readonly version: string;
  readonly commit: string | null;
  readonly builtAt: string | null;
  readonly channel: string;
  /** Verbatim from the record: an unsigned experimental build says so. */
  readonly signing: string | null;
  readonly sourceStatus: 'committed' | 'local-uncommitted' | null;
  /** This code is running from the packaged bundle, whatever the record says. */
  readonly packaged: boolean;
  readonly source: BuildRecordSource;
  /** `process.execPath`, home directory replaced: a stale shortcut is visible. */
  readonly launchTarget: string;
  /** `0.1.4+efa83acd021c`, matching the release id a person can compare against. */
  readonly buildId: string;
}

export interface BuildIdentityInput {
  /** The version compiled into this build, from `package.json`. */
  readonly version: string;
  /** Returns the record's text, `null` when none ships, and throws when one is unreadable. */
  readonly read: () => string | null;
  readonly execPath: string;
  readonly home?: string;
  readonly packaged?: boolean;
}

/**
 * The real record is about 45 KB, nearly all of it the per-file hash list. A
 * megabyte is room for that to grow and a refusal for anything that replaced it.
 */
export const MAX_BUILD_RECORD_BYTES = 1_048_576;

const VERSION = /^[0-9A-Za-z.+-]{1,40}$/;
const COMMIT = /^[0-9a-f]{40}$/;
const CHANNEL = /^[a-z][a-z-]{0,23}$/;
const SIGNING = /^[A-Za-z0-9 ._-]{1,40}$/;

/**
 * The record carries `signing`, not a channel, so until the packaging script
 * writes one this is the one mapping Diomedes is willing to make. Anything else
 * reads `unknown` rather than being guessed into a channel name.
 */
const CHANNEL_FOR_SIGNING: Record<string, string> = { 'unsigned-experimental': 'experimental' };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function homeless(text: string, home: string | undefined): string {
  if (!home) return text;
  // Windows spells the same profile several ways, and the executable path and
  // USERPROFILE often disagree in case, so the replacement ignores it.
  const pattern = new RegExp(home.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
  return text.replace(pattern, '~');
}

/** Pure: it reads nothing and spawns nothing. Give it a reader and an environment. */
export function buildIdentity(input: BuildIdentityInput): BuildIdentity {
  const launchTarget = homeless(input.execPath, input.home).slice(0, 300);
  const packaged = input.packaged ?? false;
  const fallback = VERSION.test(input.version) ? input.version : 'unknown';
  // A checkout with no record is a development build, and says so. A packaged
  // build with no record is not: it was built by something, and nothing here
  // knows what. `source` still reports that no record was found; the channel and
  // the build id are claims about where the build came from, so they stay
  // unknown rather than borrowing a checkout's answer.
  const blank = (source: BuildRecordSource): BuildIdentity => {
    const checkout = source === 'development' && !packaged;
    return {
      version: fallback,
      commit: null,
      builtAt: null,
      channel: checkout ? 'development' : 'unknown',
      signing: null,
      sourceStatus: null,
      packaged,
      source,
      launchTarget,
      buildId: `${fallback}+${checkout ? 'dev' : 'unknown'}`,
    };
  };

  let text: string | null;
  try {
    text = input.read();
  } catch {
    // A record that exists and cannot be read is not a development checkout.
    return blank('unreadable-record');
  }
  if (text === null) return blank('development');
  // The ceiling is the record's size on disk: UTF-8 bytes, not UTF-16 units.
  if (Buffer.byteLength(text, 'utf8') > MAX_BUILD_RECORD_BYTES) return blank('unreadable-record');

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return blank('unreadable-record');
  }
  if (!isRecord(parsed)) return blank('unreadable-record');

  const version = parsed.version;
  const commit = parsed.baseCommit;
  if (typeof version !== 'string' || !VERSION.test(version)) return blank('unreadable-record');
  if (typeof commit !== 'string' || !COMMIT.test(commit)) return blank('unreadable-record');

  const builtAt =
    typeof parsed.builtAt === 'string' &&
    parsed.builtAt.length <= 40 &&
    Number.isFinite(Date.parse(parsed.builtAt))
      ? parsed.builtAt
      : null;
  const sourceStatus =
    parsed.sourceStatus === 'committed' || parsed.sourceStatus === 'local-uncommitted'
      ? parsed.sourceStatus
      : null;
  const signing =
    typeof parsed.signing === 'string' && SIGNING.test(parsed.signing) ? parsed.signing : null;
  const stamped =
    typeof parsed.channel === 'string' && CHANNEL.test(parsed.channel) ? parsed.channel : null;

  return {
    // The record's own version is the one the packaging step stamped over these
    // exact bytes; the running package version is only what the source claimed.
    version,
    commit,
    builtAt,
    channel: stamped ?? (signing ? (CHANNEL_FOR_SIGNING[signing] ?? 'unknown') : 'unknown'),
    signing,
    sourceStatus,
    packaged,
    source: 'build-record',
    launchTarget,
    buildId: `${version}+${commit.slice(0, 12)}`,
  };
}

/**
 * The packaged server is one file at `<app>/server/app.mjs`, so the record sits
 * one directory up; in a checkout the same relative path lands on a repository
 * root that has no such file, which is the honest development answer.
 */
export function readPackagedBuildRecord(): string | null {
  const file = fileURLToPath(new URL('../BUILD_INFO.json', import.meta.url));
  let size: number;
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile()) throw new Error('The build record is not a file.');
    size = stat.size;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  if (size > MAX_BUILD_RECORD_BYTES)
    throw new Error(`The build record is ${String(size)} bytes, past the readable bound.`);
  return fs.readFileSync(file, 'utf8');
}

let current: { version: string; identity: BuildIdentity } | undefined;

/**
 * The running build. The record cannot change under a live process, so it is
 * read once for a given version — and the version is part of the question: with
 * no record to read, the answer is about the version it was asked about, and
 * handing a second caller the first caller's answer would report a version this
 * build never claimed.
 */
export function currentBuildIdentity(version: string): BuildIdentity {
  if (current?.version !== version)
    current = {
      version,
      identity: buildIdentity({
        version,
        read: readPackagedBuildRecord,
        execPath: process.execPath,
        home: process.env.USERPROFILE ?? process.env.HOME ?? '',
        packaged: typeof DIOMEDES_BUNDLED !== 'undefined' && DIOMEDES_BUNDLED,
      }),
    };
  return current.identity;
}
