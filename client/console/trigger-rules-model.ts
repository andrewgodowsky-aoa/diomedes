import {
  INTERVENTION_LABELS,
  STREAM_RULE_LIMITS,
  type StreamRule,
  type StreamRuleAuthority,
  type StreamRuleDecision,
  type StreamRuleResolution,
  type StreamIntervention,
} from '../../shared/stream-rules';
import type { ToolEffectClass } from '../../shared/harness';
import { AGENT_NAME } from '../../shared/agent-name';

/**
 * The H16 rule editor's form, and how it reads a rule back. Nothing here
 * decides whether a rule is allowed: the server's `streamRuleSetSchema`,
 * `patternProblem` and H11 precedence do, and the editor shows their sentence.
 * This module only turns form fields into the declaration the server judges,
 * and a declaration into words.
 */

/** What `GET /api/stream-rules` and `GET /api/projects/:id/stream-rules` return. */
export interface StreamRulesView {
  readonly organization: StreamRule[];
  readonly project: StreamRule[];
  readonly resolution: StreamRuleResolution | null;
  /** The runs rules watch: work loop runs (`diomedes-loop`) and Work on an external engine (`external-work`). */
  readonly watches?: readonly string[];
  /** A stored layer that cannot run (edited by hand): which rule and why. Its runs fail closed until it is fixed. */
  readonly unreadable?: readonly { authority: StreamRuleAuthority; ruleId: string | null; message: string }[];
}

export const EFFECT_CLASSES: readonly { id: ToolEffectClass; label: string }[] = [
  { id: 'pure', label: 'pure' },
  { id: 'read', label: 'read' },
  { id: 'idempotent-write', label: 'idempotent write' },
  { id: 'non-idempotent-effect', label: 'non-idempotent effect' },
  { id: 'external-send', label: 'external send' },
];

/** Tools a Diomedes loop run can propose, offered as suggestions; any tool name may be typed. */
export const LOOP_TOOLS = ['read_project_file', 'list_project_files', 'propose_write', 'delegate', 'page_fetch'] as const;

export const DEFAULT_WINDOW = 120;

export interface RuleDraft {
  id: string;
  text: string;
  enabled: boolean;
  kind: 'text' | 'pattern' | 'tool';
  phrase: string;
  pattern: string;
  caseSensitive: boolean;
  window: string;
  tool: string;
  effectClass: ToolEffectClass[];
  target: string;
  intervention: StreamIntervention;
  message: string;
  taskId: string;
  constrains: string;
}

export function emptyDraft(taskId = ''): RuleDraft {
  return {
    id: '',
    text: '',
    enabled: true,
    kind: 'text',
    phrase: '',
    pattern: '',
    caseSensitive: false,
    window: String(DEFAULT_WINDOW),
    tool: '',
    effectClass: [],
    target: '',
    intervention: 'annotate',
    message: '',
    taskId,
    constrains: '',
  };
}

export function draftFromRule(rule: StreamRule): RuleDraft {
  const draft = emptyDraft(rule.taskId ?? '');
  draft.id = rule.id;
  draft.text = rule.text;
  draft.enabled = rule.enabled;
  draft.intervention = rule.intervention;
  draft.message = rule.message ?? '';
  draft.constrains = rule.constrains ?? '';
  draft.kind = rule.match.kind;
  if (rule.match.kind === 'text') {
    draft.phrase = rule.match.phrase;
    draft.caseSensitive = rule.match.caseSensitive === true;
  } else if (rule.match.kind === 'pattern') {
    draft.pattern = rule.match.pattern;
    draft.caseSensitive = rule.match.caseSensitive === true;
    draft.window = String(rule.match.window);
  } else {
    draft.tool = rule.match.tool ?? '';
    draft.effectClass = [...(rule.match.effectClass ?? [])];
    draft.target = rule.match.target ?? '';
  }
  return draft;
}

/** A canonical form for comparing two declarations, whatever order their keys were written in. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.keys(value)
      .sort()
      .filter((key) => (value as Record<string, unknown>)[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`)
      .join(',')}}`;
  return JSON.stringify(value);
}

const sameDeclaration = (a: StreamRule, b: StreamRule) =>
  canonical({ ...a, version: 0 }) === canonical({ ...b, version: 0 });

/**
 * The declaration a draft names, exactly as typed: empty optional fields are
 * left out, and nothing is corrected or refused here. An edited rule carries
 * the next version when anything about it changed, so a firing's version says
 * which declaration fired; an unchanged one keeps its version.
 */
export function ruleFromDraft(draft: RuleDraft, previous: StreamRule | null): StreamRule {
  const match: StreamRule['match'] =
    draft.kind === 'text'
      ? { kind: 'text', phrase: draft.phrase, ...(draft.caseSensitive ? { caseSensitive: true } : {}) }
      : draft.kind === 'pattern'
        ? {
            kind: 'pattern',
            pattern: draft.pattern,
            ...(draft.caseSensitive ? { caseSensitive: true } : {}),
            window: Number(draft.window),
          }
        : {
            kind: 'tool',
            ...(draft.tool.trim() ? { tool: draft.tool.trim() } : {}),
            ...(draft.effectClass.length ? { effectClass: [...draft.effectClass] } : {}),
            ...(draft.target.trim() ? { target: draft.target.trim() } : {}),
          };
  const rule: StreamRule = {
    id: draft.id.trim(),
    version: previous?.version ?? 1,
    enabled: draft.enabled,
    ...(draft.constrains.trim() ? { constrains: draft.constrains.trim() } : {}),
    ...(draft.taskId.trim() ? { taskId: draft.taskId.trim() } : {}),
    match,
    intervention: draft.intervention,
    ...(draft.message.trim() ? { message: draft.message } : {}),
    text: draft.text,
  };
  if (previous && !sameDeclaration(previous, rule)) return { ...rule, version: previous.version + 1 };
  return rule;
}

/** The authority's rules with one added, replaced (by its earlier id) or removed. */
export function withRule(rules: readonly StreamRule[], next: StreamRule | null, previousId: string | null): StreamRule[] {
  if (previousId === null) return next ? [...rules, next] : [...rules];
  return rules.flatMap((rule) => (rule.id === previousId ? (next ? [next] : []) : [rule]));
}

/** On or off, as the next version of the same rule. */
export function toggled(rule: StreamRule): StreamRule {
  return { ...rule, enabled: !rule.enabled, version: rule.version + 1 };
}

const quote = (text: string) => `“${text}”`;

/** What a rule watches for, in words. */
export function matchSummary(rule: StreamRule): string {
  const match = rule.match;
  if (match.kind === 'text')
    return `Streamed text containing ${quote(match.phrase)}${match.caseSensitive ? ', case-sensitive' : ''}`;
  if (match.kind === 'pattern')
    return `Streamed text matching ${quote(match.pattern)} within ${match.window} characters${match.caseSensitive ? ', case-sensitive' : ''}`;
  const parts = [
    match.tool ? `a proposed ${match.tool} call` : 'any proposed tool call',
    match.effectClass?.length ? `that ${match.effectClass.length === 1 ? 'is' : 'is one of'} ${match.effectClass.join(', ')}` : null,
    match.target ? `on ${match.target}` : null,
  ];
  const text = parts.filter(Boolean).join(' ');
  return text.charAt(0).toUpperCase() + text.slice(1);
}

export const interventionLabel = (intervention: StreamIntervention) => INTERVENTION_LABELS[intervention];

/** The server's decision for one rule, when the view carries a resolution. */
export function decisionFor(
  resolution: StreamRuleResolution | null,
  authority: StreamRuleAuthority,
  ruleId: string,
): StreamRuleDecision | null {
  return resolution?.decisions.find((item) => item.authority === authority && item.ruleId === ruleId) ?? null;
}

/** One line for a decision: the outcome word, then the server's reason as it gave it. */
export function decisionLine(decision: StreamRuleDecision): string {
  const word =
    decision.outcome === 'applied'
      ? 'Governs'
      : decision.outcome === 'blocked'
        ? 'Blocked'
        : decision.outcome === 'overridden'
          ? 'Overridden'
          : decision.outcome === 'disabled'
            ? 'Off'
            : 'Not this task';
  return `${word} · ${decision.reason}`;
}

/** The one sentence saying which runs rules watch, from the server's answer. */
export function watchesSentence(watches: readonly string[] | undefined): string {
  const loop = !watches || watches.includes('diomedes-loop');
  if (loop && watches?.includes('external-work'))
    return `Text rules watch what the model writes, on ${AGENT_NAME} work loop runs and on task work on every engine; on external engines other than Codex they read it after secrets are removed, so a rule looking for a secret may not fire there. Tool rules watch the tool calls ${AGENT_NAME} runs itself. Codex, Claude Code, OpenCode and other external engines run their own tools, and those are not watched.`;
  return loop
    ? `Trigger rules watch ${AGENT_NAME} work loop runs only. Runs on Codex, Claude Code, OpenCode and other external engines use their own tools and are not watched.`
    : 'Trigger rules watch no runs in this build.';
}

export const RULE_TEXT_LIMIT = STREAM_RULE_LIMITS.text;
export const RULE_MESSAGE_LIMIT = STREAM_RULE_LIMITS.message;
export const RULE_PATTERN_LIMIT = STREAM_RULE_LIMITS.patternChars;
export const RULE_WINDOW_LIMIT = STREAM_RULE_LIMITS.window;
