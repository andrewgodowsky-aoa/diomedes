/**
 * The small part of semantic versioning that pack manifests use.
 *
 * Versions are plain `X.Y.Z`, with an optional `-prerelease` tag that sorts
 * below its release. Ranges are what `package.json` readers expect and nothing
 * more: an exact version, `^`, `~`, the comparators `>= > <= <`, an `x`/`*`
 * wildcard, whitespace-joined AND and `||`-joined OR. Anything else is refused
 * rather than guessed at, so a manifest cannot carry a range two readers would
 * interpret differently.
 *
 * Pure data handling: no clock, no filesystem, no dependency.
 */

export interface SemVer {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
  readonly prerelease: string | null;
}

const VERSION = /^(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})(?:-([0-9A-Za-z.-]{1,64}))?$/;

export function parseVersion(value: unknown): SemVer | null {
  if (typeof value !== 'string') return null;
  const match = VERSION.exec(value);
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ?? null,
  };
}

export const isVersion = (value: unknown): value is string => parseVersion(value) !== null;

/** Negative when `a` is older, positive when newer, zero when the same release. */
export function compareVersions(a: string, b: string): number {
  const left = parseVersion(a);
  const right = parseVersion(b);
  if (!left || !right) throw new Error(`Not a version: ${left ? b : a}`);
  return compareParsed(left, right);
}

function compareParsed(a: SemVer, b: SemVer): number {
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  if (a.patch !== b.patch) return a.patch - b.patch;
  if (a.prerelease === b.prerelease) return 0;
  if (a.prerelease === null) return 1;
  if (b.prerelease === null) return -1;
  return comparePrerelease(a.prerelease, b.prerelease);
}

/**
 * Semver 2.0 precedence for two prerelease tags: identifier by identifier,
 * numeric ones numerically and below alphanumeric ones, and a tag that runs
 * out first sorts first (`beta.2` < `beta.11` < `beta.11.a`).
 */
function comparePrerelease(a: string, b: string): number {
  const left = a.split('.');
  const right = b.split('.');
  for (let i = 0; i < Math.min(left.length, right.length); i++) {
    const x = left[i];
    const y = right[i];
    if (x === y) continue;
    const xNumeric = /^\d+$/.test(x);
    const yNumeric = /^\d+$/.test(y);
    if (xNumeric && yNumeric) {
      // Compared as digit strings, so an identifier past 2^53 still orders exactly.
      const [m, n] = [x.replace(/^0+(?=\d)/, ''), y.replace(/^0+(?=\d)/, '')];
      if (m.length !== n.length) return m.length - n.length;
      if (m !== n) return m < n ? -1 : 1;
      return x < y ? -1 : 1;
    }
    if (xNumeric) return -1;
    if (yNumeric) return 1;
    return x < y ? -1 : 1;
  }
  return left.length - right.length;
}

type Comparator = { readonly op: '>=' | '>' | '<=' | '<' | '='; readonly version: SemVer };

const bump = (v: SemVer, part: 'major' | 'minor' | 'patch'): SemVer =>
  part === 'major'
    ? { major: v.major + 1, minor: 0, patch: 0, prerelease: null }
    : part === 'minor'
      ? { major: v.major, minor: v.minor + 1, patch: 0, prerelease: null }
      : { major: v.major, minor: v.minor, patch: v.patch + 1, prerelease: null };

const PARTIAL = /^(0|[1-9]\d{0,8}|[xX*])(?:\.(0|[1-9]\d{0,8}|[xX*]))?(?:\.(0|[1-9]\d{0,8}|[xX*]))?$/;

/** One whitespace-free token as comparators, or null when it is not a range we read. */
function token(text: string): Comparator[] | null {
  const op = /^(\^|~|>=|<=|>|<|=)?(.*)$/.exec(text)!;
  const prefix = op[1] ?? '';
  const rest = op[2];
  const exact = parseVersion(rest);
  if (exact) {
    if (prefix === '^') {
      const upper =
        exact.major > 0 ? bump(exact, 'major') : exact.minor > 0 ? bump(exact, 'minor') : bump(exact, 'patch');
      return [
        { op: '>=', version: exact },
        { op: '<', version: upper },
      ];
    }
    if (prefix === '~')
      return [
        { op: '>=', version: exact },
        { op: '<', version: bump(exact, 'minor') },
      ];
    return [{ op: prefix === '' ? '=' : (prefix as Comparator['op']), version: exact }];
  }
  const partial = PARTIAL.exec(rest);
  if (!partial || (prefix !== '' && prefix !== '=' && prefix !== '^' && prefix !== '~')) return null;
  const wild = (part: string | undefined) => part === undefined || /^[xX*]$/.test(part);
  if (wild(partial[1])) return [];
  const major = Number(partial[1]);
  if (wild(partial[2])) {
    const low = { major, minor: 0, patch: 0, prerelease: null };
    return [
      { op: '>=', version: low },
      { op: '<', version: bump(low, 'major') },
    ];
  }
  const minor = Number(partial[2]);
  const low = { major, minor, patch: 0, prerelease: null };
  return [
    { op: '>=', version: low },
    { op: '<', version: prefix === '^' && major > 0 ? bump(low, 'major') : bump(low, 'minor') },
  ];
}

/** A range as OR-of-AND comparator sets, or null when it is not one we read. */
function parseRange(range: string): Comparator[][] | null {
  if (typeof range !== 'string' || range.length > 200) return null;
  const alternatives = range.split('||').map((part) => part.trim());
  const sets: Comparator[][] = [];
  for (const alternative of alternatives) {
    if (!alternative) return null;
    const comparators: Comparator[] = [];
    for (const piece of alternative.split(/\s+/)) {
      const parsed = token(piece);
      if (!parsed) return null;
      comparators.push(...parsed);
    }
    sets.push(comparators);
  }
  return sets;
}

export const isRange = (value: unknown): value is string =>
  typeof value === 'string' && parseRange(value) !== null;

/**
 * Does `version` satisfy `range`? A prerelease only satisfies a comparator set
 * that names a prerelease of the same `X.Y.Z`, as npm does, so a `^1.0.0`
 * dependency never silently takes `2.0.0-beta`.
 */
export function satisfies(version: string, range: string): boolean {
  const v = parseVersion(version);
  const sets = parseRange(range);
  if (!v || !sets) return false;
  return sets.some((set) => {
    const holds = set.every(({ op, version: bound }) => {
      const order = compareParsed(v, bound);
      return op === '='
        ? order === 0
        : op === '>='
          ? order >= 0
          : op === '>'
            ? order > 0
            : op === '<='
              ? order <= 0
              : order < 0;
    });
    if (!holds || v.prerelease === null) return holds;
    return set.some(
      ({ version: bound }) =>
        bound.prerelease !== null &&
        bound.major === v.major &&
        bound.minor === v.minor &&
        bound.patch === v.patch,
    );
  });
}

/** The newest of `versions` that satisfies `range`, or null. Deterministic. */
export function maxSatisfying(versions: readonly string[], range: string): string | null {
  return (
    [...versions]
      .filter((version) => satisfies(version, range))
      .sort(compareVersions)
      .at(-1) ?? null
  );
}
