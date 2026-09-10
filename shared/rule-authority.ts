/**
 * Who a rule belongs to, which one governs, and where it is actually enforced.
 *
 * `shared/connection-rules.ts` already says what a rule *is* — its schema, its
 * scope keys, its predicate, its action. `server/rules.ts` already says how one
 * is selected and evaluated. Neither answers the three questions the harness
 * contract asks, so those three live here and nowhere else:
 *
 * 1. **Authority.** A restriction an organization's administrator set is not
 *    the same kind of thing as a sentence somebody typed into a task. Ranking
 *    them is what lets project guidance *specialize* company policy without
 *    being able to weaken it. Without a rank, the only deterministic tie-break
 *    left is "whichever was written last", which is how a task note quietly
 *    turns into a company decision.
 *
 * 2. **Admissibility.** An imported document, a connector's output, a
 *    questionnaire's free text and a model's suggestion are *data*. They are
 *    frequently text that reads exactly like an instruction, and reading like
 *    an instruction is not authorization. `admissibleAsRule` therefore answers
 *    from the content's origin and the person's role, and never from the
 *    content itself. `screenForInstructionText` exists only to *report* the
 *    attempt so a person can see it; calling it is not a defence, and its
 *    result is deliberately not an input to admissibility.
 *
 * 3. **Enforcement surface.** The same rule is a hard stop in one place and an
 *    explained preference in another. Saying "enforced" about a sentence that
 *    is only ever put in front of a model would be the single most misleading
 *    thing this file could do, so `enforcementFor` answers per surface from the
 *    route's own honest capability facts, in the existing
 *    enforced/observed/instructional/unsupported vocabulary.
 *
 * What this is not: a second rule engine. Nothing here evaluates a predicate,
 * reads a fact or denies an operation — `server/rules.ts` still does all three.
 * This decides *which* rules that engine should be looking at, and what may be
 * truthfully claimed about the ones it applies.
 */
import type { RuleCategory } from './configuration.js';
import { ROUTE_CAPABILITIES } from './capabilities.js';
import type { Enforcement } from './harness.js';
import type { Rule } from './connection-rules.js';

export const RULE_AUTHORITY_CONTRACT_VERSION = 1 as const;

// --- authority ----------------------------------------------------------------

/**
 * Ordered weakest to strongest. `personal` is a person's own tone preference,
 * `task` and `project` are where work is specialized, `organization` is what an
 * authorized administrator decided for everybody.
 */
export type RuleAuthority = 'personal' | 'task' | 'project' | 'organization';
export const RULE_AUTHORITIES: readonly RuleAuthority[] = Object.freeze([
  'personal',
  'task',
  'project',
  'organization',
]);

export function authorityRank(authority: RuleAuthority): number {
  return RULE_AUTHORITIES.indexOf(authority);
}

/**
 * What a rule asks for on the one requirement it names. `forbid` is the only
 * restrictive stance; the other two are permissive, which is why a lower
 * authority holding either against a higher authority's `forbid` is weakening
 * rather than specializing.
 */
export type RuleStance = 'forbid' | 'require' | 'prefer';

/**
 * A rule as precedence sees it. `constrains` is the requirement key — two rules
 * only ever meet if they name the same one, and exactly one of them governs it.
 * Single-valued keys are what makes "incompatible requirements block the work"
 * a decidable statement rather than a judgement call.
 */
export interface ScopedRule {
  readonly id: string;
  readonly version: number;
  readonly authority: RuleAuthority;
  readonly category: RuleCategory;
  readonly constrains: string;
  readonly stance: RuleStance;
  readonly text: string;
  /** Keys from `ruleScopeSchema`. More keys means more specific. */
  readonly scope: Readonly<Record<string, string>>;
  readonly recordedAt: string;
}

/** The existing four rule types, in the harness contract's three categories. */
export function categoryOf(type: Rule['type']): RuleCategory {
  return type === 'standing' ? 'guidance' : type === 'correction' ? 'correction' : 'enforced';
}

// --- lifecycle surfaces -------------------------------------------------------

/**
 * The hooks the harness already has, in the order work passes through them.
 * There is no tenth surface and no poller: anything that wants to govern work
 * governs it at one of these.
 */
export const LIFECYCLE_SURFACES = Object.freeze([
  'configuration-activation',
  'task-admission',
  'context-assembly',
  'before-model',
  'before-tool',
  'before-effect',
  'after-observation',
  'verification',
  'handoff',
] as const);
export type LifecycleSurface = (typeof LIFECYCLE_SURFACES)[number];

export interface EnforcementAnswer {
  readonly enforcement: Enforcement;
  /** Why that is the honest answer here. Never a slogan. */
  readonly reason: string;
}

/** Surfaces the host owns outright: no engine is between the decision and the effect. */
const HOST_OWNED: readonly LifecycleSurface[] = Object.freeze([
  'configuration-activation',
  'task-admission',
  'handoff',
]);
/** Surfaces that only shape what a model sees. Nothing is blocked here. */
const SHAPING_ONLY: readonly LifecycleSurface[] = Object.freeze([
  'context-assembly',
  'before-model',
]);

/**
 * What may truthfully be claimed about a rule of this category, at this
 * surface, on this route.
 *
 * The `enforced` category does not make a rule enforced everywhere. A company
 * restriction explained during context assembly is `instructional` there and
 * `enforced` at the effect boundary, and saying so is the point: the hard check
 * stays in the host whether or not the model was told about it.
 */
export function enforcementFor(
  category: RuleCategory,
  routeId: string,
  surface: LifecycleSurface,
): EnforcementAnswer {
  const route = ROUTE_CAPABILITIES[routeId];
  if (!route)
    return {
      enforcement: 'unsupported',
      reason: `${routeId} is not a known execution route, so nothing can be claimed about what it enforces.`,
    };
  if (category === 'guidance')
    return {
      enforcement: 'instructional',
      reason: 'Guidance shapes how the work reads. It stops nothing on its own.',
    };
  if (category === 'correction')
    return {
      enforcement: 'observed',
      reason:
        'A correction responds to something already observed, within a bounded attempt count.',
    };
  if (HOST_OWNED.includes(surface))
    return {
      enforcement: 'enforced',
      reason: `Diomedes decides this itself at ${surface}; no engine is between the decision and the effect.`,
    };
  if (SHAPING_ONLY.includes(surface))
    return {
      enforcement: 'instructional',
      reason: `At ${surface} the rule is only explained. The hard check stays in the host at before-effect.`,
    };
  if (surface === 'after-observation')
    return {
      enforcement: 'observed',
      reason: 'The effect has already happened; what is left is evidence.',
    };
  if (surface === 'verification')
    return route.effectProof.answer === 'yes'
      ? {
          enforcement: 'enforced',
          reason: `${route.name} proves which effect was applied: ${route.effectProof.evidence}`,
        }
      : {
          enforcement: 'observed',
          reason: `${route.name} does not prove which effect was applied: ${route.effectProof.evidence}`,
        };
  // before-tool and before-effect: the only surfaces where an effect can still be refused.
  return route.preExecutionInterception.answer === 'yes'
    ? {
        enforcement: 'enforced',
        reason: `${route.name} lets Diomedes refuse the effect first: ${route.preExecutionInterception.evidence}`,
      }
    : {
        enforcement: 'unsupported',
        reason: `${route.name} cannot be stopped before an effect: ${route.preExecutionInterception.evidence}`,
      };
}

// --- what may become a rule ---------------------------------------------------

/**
 * Where a piece of text came from. Only `administrative` was typed by a person
 * acting in an administrative capacity. Everything else arrived as content,
 * and content stays content however imperative it sounds.
 */
export type ContentOrigin =
  | 'administrative'
  | 'imported-document'
  | 'connector-output'
  | 'questionnaire-free-text'
  | 'model-output';

export function isAdministrative(origin: ContentOrigin): boolean {
  return origin === 'administrative';
}

export interface Admissibility {
  readonly ok: boolean;
  readonly reason: string;
}

/**
 * Whether this text may become a rule at this authority.
 *
 * Note what is absent: the text. A sentence cannot argue its way into being a
 * rule, so passing it here would only invite someone to start reading it.
 */
export function admissibleAsRule(input: {
  readonly origin: ContentOrigin;
  readonly authority: RuleAuthority;
  /** Whether the person is an authorized administrator of the organization. */
  readonly authorizedAdmin: boolean;
}): Admissibility {
  if (!isAdministrative(input.origin))
    return {
      ok: false,
      reason:
        'This arrived as data — an imported document, a connector result, free text or a model suggestion. Data stays data. Someone with authority has to write the rule themselves.',
    };
  if (input.authority === 'organization' && !input.authorizedAdmin)
    return {
      ok: false,
      reason: 'Only an owner or administrator of this business can set a rule for everybody.',
    };
  return { ok: true, reason: 'Written by someone with authority to set it.' };
}

/** One place text tried to sound like an instruction. A report, not a verdict. */
export interface InstructionAttempt {
  readonly at: number;
  readonly excerpt: string;
  readonly matched: string;
}

const MAX_SCREENED_CHARS = 64_000;
const MAX_ATTEMPTS_REPORTED = 8;
const EXCERPT_CHARS = 120;

/**
 * Phrases that only appear when text is addressing the harness rather than
 * describing a business. Each is a plain literal or a short bounded pattern:
 * there is no user input here, and nothing on this list decides anything.
 */
const INSTRUCTION_SHAPES: readonly { readonly label: string; readonly pattern: RegExp }[] =
  Object.freeze([
    {
      label: 'ignore previous instructions',
      pattern: /ignore\s+(?:all\s+)?(?:previous|prior|above|earlier)\s+instructions?/i,
    },
    {
      label: 'disregard the rules',
      pattern: /disregard\s+(?:all\s+)?(?:the\s+)?(?:previous|prior|above|rules?|policy|policies)/i,
    },
    { label: 'assumed identity', pattern: /you\s+are\s+now\s+(?:an?\s+)?[a-z]/i },
    { label: 'system prompt', pattern: /system\s+prompt/i },
    { label: 'new instructions', pattern: /new\s+instructions?\s*:/i },
    {
      label: 'self-granted access',
      pattern:
        /grant\s+(?:me\s+|yourself\s+)?(?:full|admin(?:istrator)?|all)\s+(?:access|permissions?|rights?)/i,
    },
    {
      label: 'act as administrator',
      pattern: /act\s+as\s+(?:an?\s+)?(?:admin(?:istrator)?|owner|the\s+system)/i,
    },
    {
      label: 'override policy',
      pattern: /override\s+(?:the\s+)?(?:polic(?:y|ies)|rules?|restrictions?)/i,
    },
  ]);

/**
 * Report where text reads like an administrative instruction.
 *
 * This exists so a person reviewing an imported document can see what was in
 * it, and so the Console can say "this file tried to give itself permission".
 * It is not a filter: `admissibleAsRule` already refuses the whole origin, and
 * text that slips past this list is refused just the same.
 */
export function screenForInstructionText(text: string): readonly InstructionAttempt[] {
  const bounded = text.slice(0, MAX_SCREENED_CHARS);
  const found: InstructionAttempt[] = [];
  for (const shape of INSTRUCTION_SHAPES) {
    const match = shape.pattern.exec(bounded);
    if (!match) continue;
    found.push({
      at: match.index,
      excerpt: bounded.slice(match.index, match.index + EXCERPT_CHARS),
      matched: shape.label,
    });
    if (found.length >= MAX_ATTEMPTS_REPORTED) break;
  }
  return Object.freeze(found.sort((a, b) => a.at - b.at || a.matched.localeCompare(b.matched)));
}

// --- precedence ---------------------------------------------------------------

export type PrecedenceOutcome = 'applied' | 'overridden' | 'blocked';

export interface RuleDecision {
  readonly rule: ScopedRule;
  readonly outcome: PrecedenceOutcome;
  readonly reason: string;
  /** The rule that won, when one did. */
  readonly overriddenBy: string | null;
}

export interface RuleConflict {
  readonly constrains: string;
  /** The rule ids that cannot both hold, sorted. */
  readonly between: readonly string[];
  readonly message: string;
  /** What a person can do about it. Never "contact support". */
  readonly next: string;
}

export interface RuleResolution {
  readonly applied: readonly ScopedRule[];
  readonly decisions: readonly RuleDecision[];
  readonly blocking: readonly RuleConflict[];
  /** Stable across input order; changes when the governing set changes. */
  readonly revision: string;
}

const specificity = (rule: ScopedRule) => Object.keys(rule.scope).length;

/** Strongest authority, then most specific scope, then newest version, then id. */
const byPrecedence = (a: ScopedRule, b: ScopedRule) =>
  authorityRank(b.authority) - authorityRank(a.authority) ||
  specificity(b) - specificity(a) ||
  b.version - a.version ||
  a.id.localeCompare(b.id);

const weakens = (governing: ScopedRule, other: ScopedRule) =>
  governing.stance === 'forbid' && other.stance !== 'forbid';

/**
 * Decide which rules govern.
 *
 * One requirement key has exactly one governing rule. Strongest authority
 * first, then the most specific scope: that ordering is total, so the same set
 * of rules resolves the same way whatever order it arrives in, and a resolution
 * can be compared between two runs.
 *
 * Two rules that tie on both and disagree are not resolved by picking one. They
 * block the work, because guessing which of two equal company requirements the
 * business meant is exactly the decision a person has to make.
 */
export function resolveRules(rules: readonly ScopedRule[]): RuleResolution {
  const ordered = [...rules].sort(byPrecedence);
  const groups = new Map<string, ScopedRule[]>();
  for (const rule of ordered) {
    const group = groups.get(rule.constrains);
    if (group) group.push(rule);
    else groups.set(rule.constrains, [rule]);
  }

  const outcomes = new Map<string, RuleDecision>();
  const blocking: RuleConflict[] = [];

  for (const [constrains, group] of groups) {
    const governing = group[0];
    const tied = group.filter(
      (rule) =>
        rule.authority === governing.authority && specificity(rule) === specificity(governing),
    );
    const disagreeing = tied.filter((rule) => rule.stance !== governing.stance);
    if (disagreeing.length > 0) {
      const between = [...new Set([governing.id, ...disagreeing.map((rule) => rule.id)])].sort();
      blocking.push({
        constrains,
        between,
        message: `${between.join(' and ')} ask for opposite things about ${constrains}, with the same authority and the same reach.`,
        next: `Change one of these rules, or narrow one of them to the project or task it was meant for, then start the work again.`,
      });
      for (const rule of group)
        outcomes.set(rule.id, {
          rule,
          outcome: 'blocked',
          reason: `Held back until ${constrains} is settled.`,
          overriddenBy: null,
        });
      continue;
    }
    for (const rule of group) {
      if (rule.id === governing.id) {
        outcomes.set(rule.id, {
          rule,
          outcome: 'applied',
          reason: `Governs ${constrains}.`,
          overriddenBy: null,
        });
        continue;
      }
      outcomes.set(rule.id, {
        rule,
        outcome: weakens(governing, rule) ? 'blocked' : 'overridden',
        reason: weakens(governing, rule)
          ? `${governing.id} restricts ${constrains} with ${governing.authority} authority, and this cannot loosen it.`
          : `${governing.id} covers ${constrains} more closely.`,
        overriddenBy: governing.id,
      });
    }
  }

  const decisions = ordered.map((rule) => outcomes.get(rule.id)!);
  const applied = decisions
    .filter((decision) => decision.outcome === 'applied')
    .map((decision) => decision.rule);
  return {
    applied: Object.freeze(applied),
    decisions: Object.freeze(decisions),
    blocking: Object.freeze(blocking.sort((a, b) => a.constrains.localeCompare(b.constrains))),
    revision: stableRevision({
      applied: applied.map((rule) => [rule.id, rule.version] as const),
      blocking: blocking.map((conflict) => conflict.between),
    }),
  };
}

// --- what gets recorded -------------------------------------------------------

/**
 * The part of a rule that is safe to write into evidence: which rule, which
 * revision, whose authority, and where it actually bit.
 *
 * The rule's own text is not here. A rule can name a customer, a folder or an
 * account, and a governing record ends up in run history, exports and telemetry
 * where none of those belong. Scope *keys* are included because the shape of a
 * scope is not sensitive; scope *values* are not, for the same reason.
 */
export interface GoverningRecord {
  readonly ruleId: string;
  readonly ruleVersion: number;
  readonly authority: RuleAuthority;
  readonly category: RuleCategory;
  readonly enforcement: Enforcement;
  readonly surface: LifecycleSurface;
  readonly routeId: string;
  readonly scopeKeys: readonly string[];
}

export function governingRecord(
  rule: ScopedRule,
  where: { readonly routeId: string; readonly surface: LifecycleSurface },
): GoverningRecord {
  return {
    ruleId: rule.id,
    ruleVersion: rule.version,
    authority: rule.authority,
    category: rule.category,
    enforcement: enforcementFor(rule.category, where.routeId, where.surface).enforcement,
    surface: where.surface,
    routeId: where.routeId,
    scopeKeys: Object.freeze(Object.keys(rule.scope).sort()),
  };
}

// --- stable revisions ---------------------------------------------------------

/** Sorted-key JSON, so two equal values always produce the same string. */
function canonical(value: unknown): string {
  if (value === undefined || value === null) return 'null';
  if (typeof value === 'number') return Number.isFinite(value) ? JSON.stringify(value) : 'null';
  if (typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
      .join(',')}}`;
  }
  return 'null';
}

/**
 * A content revision: a short, stable name for one arrangement of values.
 *
 * This is FNV-1a, and it is deliberately **not** a security digest. It answers
 * "is this the same instruction view the model saw last time" in code that also
 * runs in the browser, where `node:crypto` is not available. Anywhere the
 * answer has to survive someone trying to forge it — receipts, grants, Agent
 * identity — the existing `payloadDigest` in `server/command-admission.ts` is
 * the one to use.
 */
export function stableRevision(value: unknown): string {
  const text = canonical(value);
  let high = 0x811c9dc5;
  let low = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    high = Math.imul(high ^ code, 0x01000193) >>> 0;
    low = Math.imul(low ^ ((code * 31 + index) & 0xffff), 0x01000193) >>> 0;
  }
  return `r1-${high.toString(16).padStart(8, '0')}${low.toString(16).padStart(8, '0')}`;
}
