/**
 * The one way a durable record is read across versions (H21).
 *
 * Every durable file family Diomedes writes names the field that carries its
 * schema version and the version this build writes. A record at that version
 * is read as it is. An older record is carried forward one version at a time
 * by pure functions, so each step can be tested against a golden fixture of
 * what that version really looked like. A newer record, or a version that was
 * never written, is refused: this build cannot know what the newer fields
 * mean, and guessing would rewrite someone's evidence (decision 10).
 *
 * This module is pure. Reading, backing up and rewriting a file is
 * `server/migrations/files.ts`.
 */

export type DurableRecord = Record<string, unknown>;

/** Carries a record from version N to N + 1. Must not mutate its input. */
export type Migration = (record: DurableRecord) => DurableRecord;

export interface DurableFamily {
  /** Stable id, used in refusals and in the backup name. */
  readonly id: string;
  /** What the family holds, in a sentence a person could read. */
  readonly title: string;
  /** Where it lives, relative to the data folder (`*` is one name). */
  readonly location: string;
  /** The top-level field that carries the version. */
  readonly versionField: string;
  /** The version this build writes. */
  readonly current: number;
  /** The oldest version this build still reads. */
  readonly oldest: number;
  /**
   * The version a record without the field is read as, or null when such a
   * record is refused. Families that predate their version field use this.
   */
  readonly unversioned: number | null;
  /** `migrations[n]` carries version n to n + 1, for every n from `oldest` to `current - 1`. */
  readonly migrations: Readonly<Record<number, Migration>>;
  /** The source file that reads this family, and whether it reads it through here. */
  readonly reader: { readonly file: string; readonly throughFramework: boolean; readonly note?: string };
}

export type MigrationRefusalCode =
  | 'not-a-record'
  | 'unknown-version'
  | 'newer-version'
  | 'retired-version'
  | 'missing-migration'
  | 'invalid-migration';

export class MigrationRefusal extends Error {
  constructor(
    readonly code: MigrationRefusalCode,
    readonly family: string,
    readonly found: unknown,
    message: string,
  ) {
    super(message);
    this.name = 'MigrationRefusal';
  }
}

export interface MigrationResult {
  readonly record: DurableRecord;
  readonly from: number;
  readonly to: number;
  /** True when the record changed version; the caller must persist it (with a backup). */
  readonly migrated: boolean;
}

const isRecord = (value: unknown): value is DurableRecord =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** The version a stored value says it is, or a refusal. Reads nothing else. */
export function recordVersion(family: DurableFamily, value: unknown): number {
  if (!isRecord(value))
    throw new MigrationRefusal(
      'not-a-record',
      family.id,
      null,
      `The ${family.title} is not a record this build writes. Nothing in it was changed.`,
    );
  if (!(family.versionField in value)) {
    if (family.unversioned !== null) return family.unversioned;
    throw new MigrationRefusal(
      'unknown-version',
      family.id,
      undefined,
      `The ${family.title} does not say which version wrote it. Nothing in it was changed.`,
    );
  }
  const found = value[family.versionField];
  if (typeof found !== 'number' || !Number.isSafeInteger(found) || found < 1)
    throw new MigrationRefusal(
      'unknown-version',
      family.id,
      found,
      `The ${family.title} names version ${String(found)}, which no Diomedes writes. Nothing in it was changed.`,
    );
  return found;
}

/**
 * Whether this build can read the value, without changing it. Use where a
 * reader only needs the refusal and has no older version to carry forward.
 */
export function assertReadable(family: DurableFamily, value: unknown): number {
  const version = recordVersion(family, value);
  if (version > family.current)
    throw new MigrationRefusal(
      'newer-version',
      family.id,
      version,
      `The ${family.title} was written by a newer Diomedes (version ${version}); this build reads up to version ${family.current}. Nothing in it was changed.`,
    );
  if (version < family.oldest)
    throw new MigrationRefusal(
      'retired-version',
      family.id,
      version,
      `The ${family.title} is version ${version}, older than this build can carry forward (${family.oldest}). Nothing in it was changed.`,
    );
  return version;
}

/**
 * Carries a stored value to the current version. Pure: the input is never
 * mutated, and a current record comes back as the same object.
 */
export function migrateRecord(family: DurableFamily, value: unknown): MigrationResult {
  const from = assertReadable(family, value);
  let record = value as DurableRecord;
  for (let version = from; version < family.current; version++) {
    const step = family.migrations[version];
    if (!step)
      throw new MigrationRefusal(
        'missing-migration',
        family.id,
        version,
        `This build has no way to carry the ${family.title} from version ${version} to ${version + 1}. Nothing in it was changed.`,
      );
    const next = step(structuredClone(record));
    if (!isRecord(next) || next[family.versionField] !== version + 1)
      throw new MigrationRefusal(
        'invalid-migration',
        family.id,
        version,
        `Carrying the ${family.title} from version ${version} did not produce version ${version + 1}. Nothing in it was changed.`,
      );
    record = next;
  }
  return { record, from, to: family.current, migrated: from !== family.current };
}

/** The registry's own consistency: every step from `oldest` to `current` exists, and no others. */
export function familyProblems(family: DurableFamily): string[] {
  const problems: string[] = [];
  if (!Number.isSafeInteger(family.current) || family.current < 1) problems.push('current is not a positive integer');
  if (!Number.isSafeInteger(family.oldest) || family.oldest < 1 || family.oldest > family.current)
    problems.push('oldest is outside 1..current');
  if (family.unversioned !== null && (family.unversioned < family.oldest || family.unversioned > family.current))
    problems.push('unversioned is outside oldest..current');
  for (let version = family.oldest; version < family.current; version++)
    if (typeof family.migrations[version] !== 'function') problems.push(`no migration from ${version}`);
  for (const key of Object.keys(family.migrations)) {
    const version = Number(key);
    if (version < family.oldest || version >= family.current) problems.push(`stray migration from ${key}`);
  }
  if (!/^[a-z][a-z0-9-]*$/.test(family.id)) problems.push('id is not a plain slug');
  return problems;
}
