/** One scoped rule vocabulary; policy is deny-only and never issues capabilities. */
import { z } from 'zod';
import type { Json, ModelRequest, ModelResult } from '../shared/harness.js';
import {
  ruleSchema,
  type Rule,
  type RuleScope,
  type RuleEvidence,
  type RuleProposal,
} from '../shared/connection-rules.js';
import {
  categoryOf,
  governingRecord,
  resolveRules,
  type GoverningRecord,
  type LifecycleSurface,
  type RuleAuthority,
  type RuleResolution,
  type ScopedRule,
} from '../shared/rule-authority.js';
import {
  buildInstructionView,
  type FactInput,
  type InstructionView,
} from '../shared/instruction-view.js';
import { digest, HarnessError } from './harness/policy.js';
import type { ModelAdapter, ModelInspection } from './harness/native-agent.js';

/** Source time, explicit time zone, inclusive start/exclusive end. Overnight windows
 * belong to the day on which service starts. Missing source time never matches. */
export function withinServiceWindow(rule: Rule, sourceAt: Json | undefined): boolean {
  if (!rule.serviceWindow) return true;
  if (typeof sourceAt !== 'string' || !Number.isFinite(Date.parse(sourceAt))) return false;
  const window = rule.serviceWindow;
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: window.timeZone,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(sourceAt));
  const part = (kind: string) => parts.find((item) => item.type === kind)!.value;
  const minute = `${part('hour')}:${part('minute')}`;
  let day = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(part('weekday'));
  const overnight = window.start > window.end;
  if (overnight && minute < window.end) day = (day + 6) % 7;
  return (
    window.days.includes(day) &&
    (overnight
      ? minute >= window.start || minute < window.end
      : minute >= window.start && minute < window.end)
  );
}

export function selectRules(rules: Rule[], scope: RuleScope): Rule[] {
  return rules
    .filter(
      (rule) =>
        rule.enabled &&
        rule.provenance.trust === 'host-reviewed' &&
        Object.entries(rule.scope).every(([key, value]) => scope[key as keyof RuleScope] === value),
    )
    .sort(
      (a, b) =>
        Object.keys(a.scope).length - Object.keys(b.scope).length || a.id.localeCompare(b.id),
    );
}

export function evaluateRules(
  rules: Rule[],
  scope: RuleScope,
  facts: Record<string, Json>,
): RuleEvidence[] {
  return selectRules(rules, scope).flatMap((rule) => {
    const p = rule.predicate;
    const value = p ? facts[p.field] : null;
    const matches =
      !p ||
      (p.operator === 'eq'
        ? value === p.value
        : p.operator === 'lte'
          ? typeof value === 'number' && typeof p.value === 'number' && value <= p.value
          : typeof value === 'string' && typeof p.value === 'string' && value.includes(p.value));
    return matches && withinServiceWindow(rule, facts.sourceAt)
      ? [
          {
            id: rule.id,
            version: rule.version,
            provenance: rule.provenance,
            scope: rule.scope,
            predicate: rule.predicate,
            action: rule.action,
            text: rule.text,
            input: {
              ...(p ? { [p.field]: value ?? null } : {}),
              ...(rule.serviceWindow ? { sourceAt: facts.sourceAt ?? null } : {}),
            },
            ...(rule.serviceWindow ? { serviceWindow: rule.serviceWindow } : {}),
          },
        ]
      : [];
  });
}

export function enforceRules(rules: Rule[], scope: RuleScope, facts: Record<string, Json>) {
  const denial = evaluateRules(rules, scope, facts).find((rule) => rule.action === 'deny');
  if (denial)
    throw new HarnessError(
      'rule_denied',
      `Policy ${denial.id} v${denial.version} denied this operation.`,
    );
}

/** Strict, bounded grammar. An unsupported phrase becomes a question, never guessed authority. */
export function proposeRule(text: string, scope: RuleScope): RuleProposal {
  const sourceText = z.string().trim().min(1).max(2000).parse(text);
  const quantity = /^Alert a manager when reported quantity is at most (\d+(?:\.\d+)?)[.!]?$/i.exec(
    sourceText,
  );
  const noOrders = /^Never order anything automatically[.!]?$/i.test(sourceText);
  const rule: Rule | null = quantity
    ? ruleSchema.parse({
        id: 'low-stock',
        version: 1,
        enabled: false,
        scope,
        type: 'workflow',
        provenance: { source: 'user proposal', connectorVersion: null, trust: 'candidate' },
        text: 'Flag reported low stock for a manager.',
        predicate: { field: 'quantity', operator: 'lte', value: Number(quantity[1]) },
        action: 'create-issue',
      })
    : noOrders
      ? ruleSchema.parse({
          id: 'no-orders',
          version: 1,
          enabled: false,
          scope,
          type: 'policy',
          provenance: { source: 'user proposal', connectorVersion: null, trust: 'candidate' },
          text: 'External writes, including ordering, require separate authority and exact approval. They are unavailable in this proof.',
          predicate: { field: 'externalWrite', operator: 'eq', value: true },
          action: 'deny',
        })
      : null;
  return {
    id: digest({ sourceText, scope }).slice(0, 24),
    state: 'proposed',
    sourceText,
    rule,
    questions: rule
      ? []
      : [
          'Specify a numeric stock threshold. Service hours, categories and ambiguous requests need review.',
        ],
    preview: {
      when: quantity
        ? `Reported quantity <= ${quantity[1]}`
        : noOrders
          ? 'An external write, including ordering, is proposed'
          : 'Needs clarification',
      do: quantity
        ? 'Create or update one manager issue'
        : noOrders
          ? 'Deny external writes'
          : 'No action',
      appliesTo: Object.values(scope).join(' / ') || 'Global',
      authority: 'Read only; no source-system changes',
      enforcement: quantity
        ? 'Deterministic workflow'
        : noOrders
          ? 'Pre-effect prohibition'
          : 'Inactive proposal',
    },
  };
}

/** Evaluation produces evidence only. It cannot mutate active rules, tasks or authority. */
export const replayRules = (
  rules: Rule[],
  events: { scope: RuleScope; facts: Record<string, Json> }[],
) =>
  events.map((event, index) => ({
    index,
    matches: evaluateRules(rules, event.scope, event.facts),
  }));

export const interceptionGuarantees = (mode: 'diomedes-led' | 'direct-agent') => ({
  intentSelection: 'instructional',
  preModel: mode === 'diomedes-led' ? 'instructional' : 'unsupported',
  modelStreaming: 'unsupported',
  proposedTool: mode === 'diomedes-led' ? 'observed' : 'unsupported',
  preEffect: mode === 'diomedes-led' ? 'enforced' : 'unsupported',
  responseNormalization: 'corrective',
  eventIngress: 'enforced',
  workflowTransition: 'enforced',
  postcondition: 'verification-only',
  completion: 'observed',
  errorRetry: 'observed',
  replay: 'verification-only',
});

/** Existing ModelAdapter boundary, not another agent loop. Context is reselected each call. */
export class RuleModelAdapter implements ModelAdapter {
  readonly id: string;
  readonly version: string;
  constructor(
    private readonly inner: ModelAdapter,
    private readonly context: (request: ModelRequest) => Promise<{ text: string; tools: string[] }>,
    private readonly assertSafe: (value: Json) => void,
    private readonly inspection?: (request: ModelRequest, text: string) => Promise<ModelInspection>,
  ) {
    this.id = inner.id;
    this.version = `${inner.version}-scoped-rules-v1`;
  }
  capabilities() {
    return this.inner.capabilities();
  }
  async prepare(request: ModelRequest, signal: AbortSignal): Promise<ModelRequest> {
    const scoped = await this.context(request);
    signal.throwIfAborted();
    const safeRequest = {
      ...request,
      tools: request.tools.filter((tool) => scoped.tools.includes(tool.name)),
      messages: [{ role: 'user' as const, text: scoped.text }, ...request.messages],
    };
    // Rejection before sending; this check never issues authority.
    this.assertSafe(z.json().parse(safeRequest));
    return safeRequest;
  }
  async validatePrepared(request: ModelRequest) {
    const scoped = await this.context(request);
    if (
      request.messages[0]?.text !== scoped.text ||
      request.tools.some((tool) => !scoped.tools.includes(tool.name))
    )
      throw new HarnessError(
        'rule_context_changed',
        'Reviewed context changed. Start a new reasoning step.',
      );
  }
  async inspect(request: ModelRequest, text: string): Promise<ModelInspection> {
    return this.inspection
      ? this.inspection(request, text)
      : { action: 'verified', message: 'No output inspector installed.', rules: [] };
  }
  async complete(request: ModelRequest, signal: AbortSignal): Promise<ModelResult> {
    this.assertSafe(z.json().parse(request));
    const result = await this.inner.complete(request, signal);
    this.assertSafe(z.json().parse(result));
    return result;
  }
}

/**
 * Authority-aware assembly, on top of the selection above.
 *
 * `selectRules` already answers "which rules reach this scope". It cannot
 * answer "and which of them governs when two disagree", because a stored Rule
 * does not record whose decision it was — a company restriction and a sentence
 * typed into a task are the same shape. So authority is supplied by the caller,
 * which is the only place that knows: rules from an activated configuration are
 * the organization's, rules from a project file are the project's, and a note
 * on one task is that task's.
 *
 * The mapping below is deliberately mechanical. `deny` forbids the field it
 * tests; `create-issue` and `correct` require it; standing guidance gets its own
 * requirement key so two pieces of advice never contradict each other and block
 * a person's work over a matter of tone.
 */
export function toScopedRule(rule: Rule, authority: RuleAuthority): ScopedRule {
  const category = categoryOf(rule.type);
  return {
    id: rule.id,
    version: rule.version,
    authority,
    category,
    // Guidance has no predicate, so each piece owns its own key. A denial or a
    // requirement owns the field it actually tests.
    constrains: rule.predicate ? rule.predicate.field : `guidance:${rule.id}`,
    stance: rule.action === 'deny' ? 'forbid' : rule.action === 'context' ? 'prefer' : 'require',
    text: rule.text,
    scope: rule.scope as Record<string, string>,
    recordedAt: `${rule.id}:${rule.version}`,
  };
}

export interface AssembledContext {
  readonly resolution: RuleResolution;
  readonly view: InstructionView;
  readonly governing: readonly GoverningRecord[];
}

/**
 * The context-assembly hook: select, resolve, bound, record.
 *
 * Selection stays with `selectRules` — a second selector here would eventually
 * disagree with the one that enforces, and the weaker of the two is the one
 * that matters. What this adds is precedence, a bounded view with a stable
 * revision, and the evidence of which rules governed.
 */
export function assembleContext(input: {
  rules: readonly { rule: Rule; authority: RuleAuthority }[];
  scope: RuleScope;
  routeId: string;
  agentRole: string;
  facts: readonly FactInput[];
  surface: LifecycleSurface;
}): AssembledContext {
  const authorities = new Map(input.rules.map((item) => [item.rule.id, item.authority]));
  const selected = selectRules(
    input.rules.map((item) => item.rule),
    input.scope,
  );
  const resolution = resolveRules(
    selected.map((rule) => toScopedRule(rule, authorities.get(rule.id) ?? 'task')),
  );
  return {
    resolution,
    view: buildInstructionView({
      resolution,
      routeId: input.routeId,
      agentRole: input.agentRole,
      facts: input.facts,
    }),
    governing: governingEvidence(resolution.applied, {
      routeId: input.routeId,
      surface: input.surface,
    }),
  };
}

/** One record per applied rule: identity, authority and where it bit. Never the text. */
export function governingEvidence(
  rules: readonly ScopedRule[],
  where: { routeId: string; surface: LifecycleSurface },
): readonly GoverningRecord[] {
  return rules.map((rule) => governingRecord(rule, where));
}

/**
 * Refuse work whose requirements cannot both be met.
 *
 * This is not a denial by any one rule, which is why it does not go through
 * `enforceRules`: nothing has decided the work is impermissible. Two equally
 * authorized company requirements simply contradict each other, and choosing
 * between them is a decision for a person.
 */
export function enforceResolved(resolution: RuleResolution): void {
  const conflict = resolution.blocking[0];
  if (conflict) throw new HarnessError('rule_conflict', `${conflict.message} ${conflict.next}`);
}
