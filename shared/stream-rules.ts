/**
 * H16 — stream-time rule triggers and safe intervention.
 *
 * A trigger rule watches a run while it happens: the text a model is streaming,
 * or a tool intent the model proposed, before that intent is admitted. When it
 * matches it names one of four interventions, from weakest to strongest:
 *
 * - **annotate** — a record, nothing else;
 * - **steer** — a correction through H08 (Steer where the route steers a running
 *   turn natively, otherwise Queue, and the receipt says which), asked for by
 *   H15 supervision on its ladder;
 * - **hold** — the proposed tool intent waits for a person as an ordinary Need,
 *   through the same approval gate every harness step already has;
 * - **stop** — the run is paused through H08 Stop by H15 supervision, which
 *   then asks the person, as every escalation does.
 *
 * Nothing here rewrites model output or tool input: a trigger records, asks,
 * holds or stops, and the record says which. Every firing is appended to
 * `ProjectState.streamTriggerFirings` with the rule's identity and digest, the
 * matched span or intent, the intervention and how it was handled.
 *
 * Authority is H11's (`shared/rule-authority.ts`): a rule is `organization`
 * (written for every project on this installation) or `project`. Precedence is
 * `resolveRules` — one rule governs each requirement key, the stronger
 * authority first — so a project rule can add a trigger or tighten one of its
 * own, and can never loosen a rule written for everybody.
 */
import { z } from 'zod';
import type { ToolEffectClass } from './harness.js';
import {
  resolveRules,
  type RuleAuthority,
  type RuleDecision,
  type RuleStance,
  type ScopedRule,
} from './rule-authority.js';
import { SUPERVISION_ACTOR, type SupervisionActor, type SupervisionRecord } from './supervision.js';

export const STREAM_RULES_CONTRACT_VERSION = 1 as const;

/** Weakest first. The order is the strictness order a firing is judged by. */
export const STREAM_INTERVENTIONS = ['annotate', 'steer', 'hold', 'stop'] as const;
export type StreamIntervention = (typeof STREAM_INTERVENTIONS)[number];
export const interventionRank = (intervention: StreamIntervention) =>
  STREAM_INTERVENTIONS.indexOf(intervention);

export const INTERVENTION_LABELS: Readonly<Record<StreamIntervention, string>> = Object.freeze({
  annotate: 'Annotate',
  steer: 'Steer',
  hold: 'Hold for you',
  stop: 'Stop',
});

/** The two places a trigger rule can be written, and the H11 authority each carries. */
export type StreamRuleAuthority = Extract<RuleAuthority, 'organization' | 'project'>;
export const STREAM_RULE_AUTHORITIES: readonly StreamRuleAuthority[] = Object.freeze([
  'organization',
  'project',
]);

/** Bounds that keep evaluation cheap per chunk and the carried text small. */
export const STREAM_RULE_LIMITS = Object.freeze({
  /** Rules per authority. */
  rules: 64,
  /** A phrase or pattern's own length. */
  patternChars: 200,
  /** The longest match a pattern may look for, and so the most text carried between chunks. */
  window: 512,
  /** A chunk is evaluated in slices of at most this many characters. */
  slice: 1024,
  /** Characters of the matched text kept on a firing. */
  excerpt: 120,
  /** Firings a project keeps. At the limit nothing new is recorded rather than anything forgotten. */
  firings: 4096,
  message: 400,
  text: 400,
});

const TOOL_EFFECT_CLASSES = [
  'pure',
  'read',
  'idempotent-write',
  'non-idempotent-effect',
  'external-send',
] as const satisfies readonly ToolEffectClass[];

/**
 * Why a pattern is refused, or null when it is in the bounded grammar.
 *
 * The grammar is plain `RegExp` without the parts that make incremental
 * matching unsound or its cost unbounded: anchors and word boundaries (a
 * chunk's edge is not the text's edge), lookaround, backreferences, and a
 * quantified group that itself contains a quantifier (catastrophic
 * backtracking).
 */
export function patternProblem(pattern: string): string | null {
  if (!pattern || pattern.length > STREAM_RULE_LIMITS.patternChars)
    return `A pattern is 1 to ${STREAM_RULE_LIMITS.patternChars} characters.`;
  if (/(^|[^\\])[\^$]/.test(pattern.replace(/\[[^\]]*\]/g, '[]')))
    return 'A pattern cannot use ^ or $: a chunk boundary is not the start or end of the text.';
  if (/\\[bB]/.test(pattern)) return 'A pattern cannot use \\b or \\B.';
  if (/\(\?(?:[=!]|<[=!])/.test(pattern)) return 'A pattern cannot use lookahead or lookbehind.';
  if (/\\[1-9]|\\k</.test(pattern)) return 'A pattern cannot use backreferences.';
  // A repeated group holding a repeat or a choice: (a+)+, (a*)*, (a{2,})+, (a|aa)*.
  const stack: boolean[] = [];
  let risky = false;
  let repeats = 0;
  for (let index = 0; index < pattern.length; index++) {
    const char = pattern[index];
    if (char === '\\') {
      index++;
      continue;
    }
    if (char === '[') {
      const close = pattern.indexOf(']', index + 1);
      index = close === -1 ? pattern.length : close;
      continue;
    }
    if (char === '(') {
      stack.push(risky);
      risky = false;
      continue;
    }
    if (char === ')') {
      const inner = risky;
      risky = stack.pop() ?? false;
      const next = pattern[index + 1];
      if (inner && (next === '*' || next === '+' || next === '{' || next === '?'))
        return 'A pattern cannot repeat a group that already repeats or chooses.';
      if (inner) risky = true;
      continue;
    }
    if (char === '|' && stack.length > 0) risky = true;
    // A fixed count ({3}) never backtracks; every other quantifier can.
    const fixed = char === '{' && /^\{\d+\}/.test(pattern.slice(index));
    const lazy = char === '?' && '*+?}'.includes(pattern[index - 1] ?? '');
    const optional = char === '?' && pattern[index - 1] !== '(' && !lazy;
    if (char === '*' || char === '+' || (char === '{' && !fixed) || optional) {
      risky = true;
      repeats += 1;
    }
  }
  // Two variable repeats can backtrack against each other, which makes the cost per chunk cubic.
  if (repeats > 1) return 'A pattern varies in one place at most (one *, +, ? or {m,n}); write two rules instead.';
  try {
    new RegExp(pattern, 'g');
  } catch {
    return 'This pattern is not a valid regular expression.';
  }
  return null;
}

const matchSchema = z.discriminatedUnion('kind', [
  /** A literal phrase in the streamed text. */
  z.strictObject({
    kind: z.literal('text'),
    phrase: z.string().min(1).max(STREAM_RULE_LIMITS.patternChars),
    caseSensitive: z.boolean().optional(),
  }),
  /** A bounded pattern in the streamed text; a match longer than `window` characters may be missed. */
  z.strictObject({
    kind: z.literal('pattern'),
    pattern: z.string().min(1).max(STREAM_RULE_LIMITS.patternChars),
    caseSensitive: z.boolean().optional(),
    window: z.number().int().min(1).max(STREAM_RULE_LIMITS.window),
  }),
  /** A proposed tool intent, judged before it is admitted. Every named field must match. */
  z.strictObject({
    kind: z.literal('tool'),
    tool: z
      .string()
      .regex(/^[a-z][a-z0-9_-]{0,63}$/)
      .optional(),
    effectClass: z.array(z.enum(TOOL_EFFECT_CLASSES)).min(1).max(5).optional(),
    /** A project-relative file, or a folder ending in `/`; a target inside it matches. */
    target: z.string().min(1).max(400).optional(),
  }),
]);
export type StreamRuleMatch = z.infer<typeof matchSchema>;

export const streamRuleSchema = z
  .strictObject({
    id: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/),
    version: z.number().int().positive(),
    enabled: z.boolean(),
    /**
     * The requirement this rule governs. Two rules meet only on the same key,
     * and exactly one governs it (H11). Defaults to `trigger:<id>`.
     */
    constrains: z
      .string()
      .regex(/^[a-z][a-z0-9:._-]{0,99}$/)
      .optional(),
    /** A task this rule is limited to. Absent means every task in its reach. */
    taskId: z.string().min(1).max(100).optional(),
    match: matchSchema,
    intervention: z.enum(STREAM_INTERVENTIONS),
    /** Steer only: the correction sent, exactly. */
    message: z.string().trim().min(1).max(STREAM_RULE_LIMITS.message).optional(),
    /** What the rule is for, in the words of whoever wrote it. */
    text: z.string().trim().min(1).max(STREAM_RULE_LIMITS.text),
  })
  .superRefine((rule, ctx) => {
    if (rule.intervention === 'hold' && rule.match.kind !== 'tool')
      ctx.addIssue({
        code: 'custom',
        message: 'Only a tool intent can be held for you; text that was streamed has already been said.',
      });
    if (rule.intervention === 'steer' && !rule.message)
      ctx.addIssue({ code: 'custom', message: 'A steer rule says the correction it sends.' });
    if (rule.intervention !== 'steer' && rule.message)
      ctx.addIssue({ code: 'custom', message: 'Only a steer rule sends a message.' });
    if (rule.match.kind === 'pattern') {
      const problem = patternProblem(rule.match.pattern);
      if (problem) ctx.addIssue({ code: 'custom', message: problem });
    }
    if (
      rule.match.kind === 'tool' &&
      rule.match.tool === undefined &&
      rule.match.effectClass === undefined &&
      rule.match.target === undefined
    )
      ctx.addIssue({ code: 'custom', message: 'A tool rule names a tool, an effect class or a target.' });
    if (
      rule.match.kind === 'tool' &&
      rule.match.target !== undefined &&
      (rule.match.target.startsWith('/') ||
        rule.match.target.includes('\\') ||
        /^[A-Za-z]:/.test(rule.match.target) ||
        rule.match.target.split('/').includes('..'))
    )
      ctx.addIssue({ code: 'custom', message: 'A target is a project-relative path.' });
  });
export type StreamRule = z.infer<typeof streamRuleSchema>;

export const streamRuleSetSchema = z
  .strictObject({
    protocolVersion: z.literal(1),
    rules: z.array(streamRuleSchema).max(STREAM_RULE_LIMITS.rules),
  })
  .superRefine((set, ctx) => {
    const ids = set.rules.map((rule) => rule.id);
    if (new Set(ids).size !== ids.length)
      ctx.addIssue({ code: 'custom', message: 'Each rule id appears once.' });
  });

/** A rule together with the authority it was written under. */
export interface AuthoredStreamRule {
  readonly rule: StreamRule;
  readonly authority: StreamRuleAuthority;
}

/** H11's stance for an intervention: holding and stopping restrict; steering requires; annotating prefers. */
export function stanceOf(intervention: StreamIntervention): RuleStance {
  return intervention === 'hold' || intervention === 'stop'
    ? 'forbid'
    : intervention === 'steer'
      ? 'require'
      : 'prefer';
}

export const constrainsOf = (rule: StreamRule) => rule.constrains ?? `trigger:${rule.id}`;
const keyOf = (item: AuthoredStreamRule) => `${item.authority}:${item.rule.id}`;

/** A rule as H11's precedence sees it. The id carries the authority, so two layers never collide. */
export function toScoped(item: AuthoredStreamRule): ScopedRule {
  return {
    id: keyOf(item),
    version: item.rule.version,
    authority: item.authority,
    category: 'enforced',
    constrains: constrainsOf(item.rule),
    stance: stanceOf(item.rule.intervention),
    text: item.rule.text,
    scope: item.rule.taskId ? { taskId: item.rule.taskId } : {},
    recordedAt: `${item.rule.id}:${item.rule.version}`,
  };
}

export interface StreamRuleDecision {
  readonly authority: StreamRuleAuthority;
  readonly ruleId: string;
  readonly version: number;
  readonly outcome: RuleDecision['outcome'] | 'disabled' | 'other-task';
  readonly reason: string;
}

export interface StreamRuleResolution {
  /** The rules evaluated, strongest authority first. */
  readonly active: readonly AuthoredStreamRule[];
  readonly decisions: readonly StreamRuleDecision[];
  /** Conflicts H11 blocks. Their rules are still evaluated, strictest intervention first. */
  readonly conflicts: readonly { readonly constrains: string; readonly between: readonly string[]; readonly message: string }[];
}

/**
 * Which rules watch a run of this task.
 *
 * `resolveRules` decides: one rule governs each key, stronger authority first,
 * then the more specific (a rule limited to this task), and a weaker rule that
 * would relax a restriction is blocked. Rules H11 blocks for a tie are still
 * evaluated — dropping both would loosen what either asked — and the strictest
 * intervention among them wins, so no conflict ever makes a run less watched.
 */
export function resolveStreamRules(
  rules: readonly AuthoredStreamRule[],
  taskId: string | null,
): StreamRuleResolution {
  const decisions: StreamRuleDecision[] = [];
  const candidates: AuthoredStreamRule[] = [];
  for (const item of rules) {
    if (!item.rule.enabled)
      decisions.push({
        authority: item.authority,
        ruleId: item.rule.id,
        version: item.rule.version,
        outcome: 'disabled',
        reason: 'Turned off.',
      });
    else if (item.rule.taskId && item.rule.taskId !== taskId)
      decisions.push({
        authority: item.authority,
        ruleId: item.rule.id,
        version: item.rule.version,
        outcome: 'other-task',
        reason: 'Limited to another task.',
      });
    else candidates.push(item);
  }
  const byKey = new Map(candidates.map((item) => [keyOf(item), item]));
  const resolution = resolveRules(candidates.map(toScoped));
  const tied = new Set(resolution.blocking.flatMap((conflict) => conflict.between));
  const active: AuthoredStreamRule[] = [];
  for (const decision of resolution.decisions) {
    const item = byKey.get(decision.rule.id)!;
    const evaluated = decision.outcome === 'applied' || tied.has(decision.rule.id);
    if (evaluated) active.push(item);
    decisions.push({
      authority: item.authority,
      ruleId: item.rule.id,
      version: item.rule.version,
      outcome: evaluated ? 'applied' : decision.outcome,
      reason: tied.has(decision.rule.id)
        ? `${decision.reason} Evaluated anyway, so the conflict never loosens anything.`
        : decision.reason.replace(/(organization|project):([a-z0-9-]+)/g, '$2 ($1)'),
    });
  }
  return {
    active: Object.freeze(active),
    decisions: Object.freeze(decisions),
    conflicts: Object.freeze(
      resolution.blocking.map((conflict) => ({
        constrains: conflict.constrains,
        between: conflict.between,
        message: conflict.message,
      })),
    ),
  };
}

// --- firings -------------------------------------------------------------------

/** What a firing matched: a span of streamed text, or a proposed tool intent. */
export type StreamTriggerMatch =
  | {
      readonly kind: 'text' | 'pattern';
      /** `stream` while it was streamed; `final-text` when the route sent the answer whole. */
      readonly source: 'stream' | 'final-text';
      /** Character offsets in the step's streamed text, end exclusive. */
      readonly start: number;
      readonly end: number;
      /** The matched text itself, cut to `STREAM_RULE_LIMITS.excerpt`, secrets scrubbed. */
      readonly excerpt: string;
    }
  | {
      readonly kind: 'tool';
      readonly tool: string;
      readonly effectClass: ToolEffectClass | null;
      readonly targets: readonly string[];
      /** The exact intent that was judged; a person's OK binds to the same hash. */
      readonly intentHash: string;
    };

/**
 * How the firing was handled when it was recorded. The outcome that follows
 * lives on the record that owns it: the Need a hold waits on, or the H15
 * supervision record (and its H08 receipt) a steer or stop was handed to.
 */
export type StreamTriggerHandling = 'recorded' | 'held-for-you' | 'handed-to-supervision';

/** One firing, appended and never rewritten (decision 10). */
export interface StreamTriggerFiring {
  readonly protocolVersion: 1;
  readonly id: string;
  readonly at: string;
  readonly rule: {
    readonly id: string;
    readonly version: number;
    /** sha-256 over the rule's canonical declaration: which exact rule fired. */
    readonly digest: string;
    readonly authority: StreamRuleAuthority;
    readonly constrains: string;
    readonly text: string;
    readonly message?: string;
  };
  readonly intervention: StreamIntervention;
  readonly sessionId: string;
  readonly taskId: string;
  /** The harness run and the step whose stream or intent matched. */
  readonly runId: string;
  readonly stepId: string;
  readonly attempt: number;
  readonly match: StreamTriggerMatch;
  readonly handling: StreamTriggerHandling;
  /** Diomedes supervision: deterministic matching, an application action (decision 8). */
  readonly actor: SupervisionActor;
}

export const TRIGGER_ACTOR = SUPERVISION_ACTOR;

/** A firing as the Console reads it: the record and what became of it. */
export interface StreamTriggerView {
  readonly firing: StreamTriggerFiring;
  /** One sentence, from the record that owns the outcome. */
  readonly outcome: string;
  readonly state: 'recorded' | 'waiting' | 'released' | 'declined' | 'expired' | 'acted' | 'refused' | 'pending';
}

type NeedLike = {
  readonly state: string;
  readonly sessionId: string;
  readonly harness?: { readonly runId: string; readonly intent: { readonly stepId: string } };
};

/**
 * What became of each firing, read from the records that own the outcome: a
 * hold from the Need its step waits on, a steer or stop from the supervision
 * record that cites it. Pure; nothing is stored for the view.
 */
export function triggerViews(
  firings: readonly StreamTriggerFiring[],
  supervision: readonly Pick<SupervisionRecord, 'action' | 'evidence' | 'control' | 'settled' | 'reason'>[],
  needs: readonly NeedLike[],
): StreamTriggerView[] {
  return firings.map((firing): StreamTriggerView => {
    if (firing.handling === 'recorded')
      return { firing, state: 'recorded', outcome: 'Recorded. Nothing else was done.' };
    if (firing.handling === 'held-for-you') {
      const need = needs.find(
        (item) =>
          item.sessionId === firing.sessionId &&
          item.harness?.runId === firing.runId &&
          item.harness.intent.stepId === firing.stepId,
      );
      if (!need) return { firing, state: 'pending', outcome: 'Held before it ran; asking you.' };
      return need.state === 'open'
        ? { firing, state: 'waiting', outcome: 'Held before it ran. It waits for your answer.' }
        : need.state === 'go-ahead'
          ? { firing, state: 'released', outcome: 'Held before it ran, then you said go ahead.' }
          : need.state === 'declined'
            ? { firing, state: 'declined', outcome: 'Held before it ran; you declined, so it never ran.' }
            : { firing, state: 'expired', outcome: 'Held before it ran; the run ended before you answered, so it never ran.' };
    }
    const handled = supervision.find(
      (record) =>
        record.action !== 'answer' && record.evidence.some((item) => item.kind === 'rule' && item.ref === firing.id),
    );
    if (!handled) return { firing, state: 'pending', outcome: 'Handed to supervision.' };
    if (handled.control) {
      const { control, outcome, detail } = handled.control;
      // The words follow what the route did, never only what was asked for.
      const word =
        outcome === 'refused'
          ? control === 'stop'
            ? 'Could not stop'
            : 'Correction not sent'
          : outcome === 'uncertain'
            ? 'Not confirmed'
            : control === 'steer'
              ? 'Steered'
              : control === 'queue'
                ? 'Correction queued'
                : control === 'stop'
                  ? firing.intervention === 'hold'
                    ? 'Paused for you before it ran'
                    : 'Stopped'
                  : 'Resumed';
      return { firing, state: outcome === 'refused' ? 'refused' : 'acted', outcome: `${word}: ${detail}` };
    }
    return { firing, state: 'acted', outcome: handled.settled ?? handled.reason };
  });
}

/** Firings for one run, oldest first. */
export function firingsFor(
  firings: readonly StreamTriggerFiring[] | undefined,
  sessionId: string,
): StreamTriggerFiring[] {
  return (firings ?? []).filter((firing) => firing.sessionId === sessionId);
}

/** The rule's own words, completing "Diomedes supervision … because a rule matched: …". */
export function firingSummary(firing: StreamTriggerFiring): string {
  const what =
    firing.match.kind === 'tool'
      ? `the proposed ${firing.match.tool} call`
      : `the streamed text “${firing.match.excerpt}”`;
  const verb = firing.intervention === 'hold' ? 'held' : 'matched';
  const article = firing.rule.authority === 'organization' ? 'an' : 'a';
  return `${article} ${firing.rule.authority} rule (${firing.rule.id}) ${verb} ${what}: ${firing.rule.text.replace(/[.!]+$/, '')}`;
}
