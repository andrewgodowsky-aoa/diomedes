/**
 * What a rule is allowed to look at, and how.
 *
 * A business rule has to be able to say "not outside the reports folder", "only
 * when the estimate is under five dollars", "never a create". The obvious way
 * to let somebody express that is a regular expression over whatever text is
 * lying around. This file exists because that is the wrong answer twice over.
 *
 * First, a pattern over a transcript is not a boundary. It reads whatever the
 * model happened to say, which means the thing being governed also writes the
 * evidence the governing is based on. Typed predicates ask the host instead:
 * the path list the writer produced, the capability set Trust resolved, the
 * reservation the budget service made, the operation the command named. None of
 * those can be talked into a different value.
 *
 * Second, an unbounded regex from a user file is an availability problem. So
 * text matching survives here, deliberately small: a closed list of named
 * surfaces, a screened pattern subset with no groups, backreferences or
 * lookaround, and a hard cap on the input scanned. What is *not* claimed is a
 * timeout — Node cannot interrupt a running regex without a worker, and
 * pretending otherwise would be worse than the honest bound below.
 *
 * Filesystem effects are the important exception. `path` here compares names
 * the writer has already canonicalized; it does not canonicalize, does not
 * resolve and does not decide. `server/paths.ts` and `Store.writeRecorded`
 * remain the only things that say where a byte may land, because two
 * canonicalizers eventually disagree and the weaker one is the one an attacker
 * uses.
 */

// --- the subject --------------------------------------------------------------

/** The operations a grant can carry today. Reused from `shared/permissions.ts`. */
export const RULE_OPERATIONS = Object.freeze(['text.create', 'text.modify'] as const);
export type RuleOperation = (typeof RULE_OPERATIONS)[number];

/**
 * The only text a pattern may be pointed at. Short, host-produced strings —
 * never a transcript, never model prose, never file content.
 */
export const MATCH_SURFACES = Object.freeze([
  'tool-name',
  'operation-name',
  'destination-label',
  'output-summary',
] as const);
export type MatchSurface = (typeof MATCH_SURFACES)[number];

/**
 * Everything a predicate may read, assembled by the host before evaluation.
 * A predicate cannot reach past this record, which is the whole design: adding
 * a new thing a rule may see is a deliberate edit here, not an accident.
 */
export interface PredicateSubject {
  readonly routeId: string;
  readonly operation: RuleOperation | null;
  readonly capabilities: readonly string[];
  /** Canonical, project-relative names the writer produced. */
  readonly paths: readonly string[];
  /** The reserved amount, or null when nobody has priced this yet. */
  readonly budgetUsd: number | null;
  readonly surfaces: Readonly<Record<MatchSurface, string>>;
}

// --- screened patterns --------------------------------------------------------

export const PATTERN_MAX_SOURCE = 120;
export const PATTERN_MAX_INPUT = 4_000;

/**
 * A pattern that has passed the screen, with the list of checks it passed
 * recorded on it. The list travels with the pattern so evidence can say what
 * was actually verified rather than "validated".
 */
export interface BoundedPattern {
  readonly source: string;
  readonly checks: readonly string[];
}

export type ScreenResult =
  | { readonly ok: true; readonly pattern: BoundedPattern }
  | { readonly ok: false; readonly reason: string };

const FORBIDDEN: readonly { readonly test: RegExp; readonly reason: string }[] = Object.freeze([
  {
    test: /\(/,
    reason:
      'Patterns cannot use brackets to group parts together. A grouped repeat can take a very long time to run on ordinary text, so this build does not accept one.',
  },
  {
    test: /\\[1-9]/,
    reason:
      'Patterns cannot refer back to an earlier part of themselves. Matching has to finish in one pass over the text.',
  },
  {
    test: /\{\s*\d*\s*,/,
    reason:
      'Patterns cannot use open-ended repeat counts. Give an exact number of repeats, or use a simpler pattern.',
  },
]);

/**
 * Accept a user pattern, or say plainly why not.
 *
 * The subset is chosen so that matching is a single pass: no groups means no
 * backtracking between alternatives, no backreferences means no re-scanning,
 * and no open-ended `{n,}` repeats means no quantifier stacking. Together with
 * `PATTERN_MAX_INPUT` that bounds the work at a size a person's laptop does not
 * notice.
 */
export function screenPattern(source: string): ScreenResult {
  if (source.length === 0) return { ok: false, reason: 'A pattern cannot be empty.' };
  if (source.length > PATTERN_MAX_SOURCE)
    return {
      ok: false,
      reason: `A pattern can be at most ${PATTERN_MAX_SOURCE} characters. Shorten it, or split it into two rules.`,
    };
  for (const rule of FORBIDDEN)
    if (rule.test.test(source)) return { ok: false, reason: rule.reason };
  try {
    // Compiled once here so an invalid pattern is refused at review, not at run time.
    new RegExp(source, 'i');
  } catch {
    return {
      ok: false,
      reason: 'That is not a pattern this build can read. Check the punctuation.',
    };
  }
  return {
    ok: true,
    pattern: {
      source,
      checks: Object.freeze([
        `at most ${PATTERN_MAX_SOURCE} characters`,
        'no grouping brackets',
        'no back references',
        'no open-ended repeat counts',
        `matched against at most ${PATTERN_MAX_INPUT} characters of one named surface`,
      ]),
    },
  };
}

// --- predicates ---------------------------------------------------------------

export type TypedPredicate =
  | { readonly kind: 'path'; readonly within: readonly string[] }
  | { readonly kind: 'capability'; readonly requires: string }
  | { readonly kind: 'budget'; readonly maxUsd: number }
  | { readonly kind: 'operation'; readonly anyOf: readonly RuleOperation[] }
  | { readonly kind: 'route'; readonly anyOf: readonly string[] }
  | {
      readonly kind: 'text-match';
      readonly surface: MatchSurface;
      readonly pattern: BoundedPattern;
    };

export interface PredicateOutcome {
  readonly matched: boolean;
  /** Why. Shown to a person, so it says what happened rather than a code. */
  readonly detail: string;
}

/**
 * A name the writer could have produced: forward slashes, ordinary segments,
 * no drive letter, no leading slash and no traversal. Anything else means the
 * value did not come from `server/paths.ts`, and a rule must not pretend to
 * have an opinion about a name the writer would never accept.
 */
const CANONICAL_NAME = /^(?!\/)(?!.*\\)(?!(?:.*\/)?\.\.(?:\/|$))[^\0:*?"<>|]+$/;
const isCanonical = (name: string) => name.length > 0 && CANONICAL_NAME.test(name);

const segmentsOf = (name: string) => name.split('/').filter((part) => part.length > 0);

/** True when `name` is the root itself or sits under it, by whole segments. */
function underRoot(name: string, root: string): boolean {
  if (!isCanonical(root)) return false;
  const rootParts = segmentsOf(root);
  if (rootParts.length === 0) return false;
  const nameParts = segmentsOf(name);
  if (nameParts.length < rootParts.length) return false;
  return rootParts.every((part, index) => part === nameParts[index]);
}

export function evaluatePredicate(
  predicate: TypedPredicate,
  subject: PredicateSubject,
): PredicateOutcome {
  switch (predicate.kind) {
    case 'path': {
      const uncanonical = subject.paths.filter((name) => !isCanonical(name));
      if (uncanonical.length > 0)
        return {
          matched: false,
          detail: `${uncanonical[0]} is not a canonical project name, so this rule does not apply to it. The writer decides where a file may go.`,
        };
      const matched = subject.paths.some((name) =>
        predicate.within.some((root) => underRoot(name, root)),
      );
      return {
        matched,
        detail: matched
          ? `Inside ${predicate.within.join(', ')}.`
          : `Not inside ${predicate.within.join(', ')}.`,
      };
    }
    case 'capability': {
      const matched = subject.capabilities.includes(predicate.requires);
      return {
        matched,
        detail: matched
          ? `This work holds ${predicate.requires}.`
          : `This work does not hold ${predicate.requires}.`,
      };
    }
    case 'budget': {
      if (subject.budgetUsd === null)
        return {
          matched: false,
          detail: 'The cost of this work is not known yet, so a spending rule cannot be applied.',
        };
      const matched = subject.budgetUsd <= predicate.maxUsd;
      return {
        matched,
        detail: `${subject.budgetUsd} is ${matched ? 'within' : 'over'} the ${predicate.maxUsd} limit.`,
      };
    }
    case 'operation': {
      const matched = subject.operation !== null && predicate.anyOf.includes(subject.operation);
      return {
        matched,
        detail: matched
          ? `This is a ${subject.operation}.`
          : `This is ${subject.operation ?? 'not a recorded operation'}, not ${predicate.anyOf.join(' or ')}.`,
      };
    }
    case 'route': {
      const matched = predicate.anyOf.includes(subject.routeId);
      return {
        matched,
        detail: matched
          ? `Running on ${subject.routeId}.`
          : `Running on ${subject.routeId}, not ${predicate.anyOf.join(' or ')}.`,
      };
    }
    case 'text-match': {
      if (!(MATCH_SURFACES as readonly string[]).includes(predicate.surface))
        return {
          matched: false,
          detail: `${String(predicate.surface)} is not a surface a rule may read. Nothing was checked.`,
        };
      const whole = subject.surfaces[predicate.surface] ?? '';
      if (whole.length > PATTERN_MAX_INPUT)
        return {
          matched: false,
          detail: `That text is longer than the ${PATTERN_MAX_INPUT} characters a pattern may read, so it was not checked.`,
        };
      const matched = new RegExp(predicate.pattern.source, 'i').test(whole);
      return {
        matched,
        detail: matched ? `${predicate.surface} matches.` : `${predicate.surface} does not match.`,
      };
    }
  }
}

/** One plain sentence, for a review screen. */
export function describePredicate(predicate: TypedPredicate): string {
  switch (predicate.kind) {
    case 'path':
      return `Files inside ${predicate.within.join(', ')}`;
    case 'capability':
      return `Work that holds ${predicate.requires}`;
    case 'budget':
      return `Work costing at most ${predicate.maxUsd} dollars`;
    case 'operation':
      return `A ${predicate.anyOf.join(' or ')}`;
    case 'route':
      return `Work running on ${predicate.anyOf.join(' or ')}`;
    case 'text-match':
      return `${predicate.surface} containing ${predicate.pattern.source}`;
  }
}
