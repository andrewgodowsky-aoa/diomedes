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
import { digest, HarnessError } from './harness/policy.js';
import type { ModelAdapter, ModelInspection } from './harness/native-agent.js';

/** Source time, explicit time zone, inclusive start/exclusive end. Overnight windows
 * belong to the day on which service starts. Missing source time never matches. */
export function withinServiceWindow(rule: Rule, sourceAt: Json | undefined): boolean {
  if (!rule.serviceWindow) return true;
  if (typeof sourceAt !== 'string' || !Number.isFinite(Date.parse(sourceAt))) return false;
  const window = rule.serviceWindow;
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: window.timeZone,
    weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .formatToParts(new Date(sourceAt));
  const part = (kind: string) => parts.find((item) => item.type === kind)!.value;
  const minute = `${part('hour')}:${part('minute')}`;
  let day = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(part('weekday'));
  const overnight = window.start > window.end;
  if (overnight && minute < window.end) day = (day + 6) % 7;
  return window.days.includes(day) && (overnight
    ? minute >= window.start || minute < window.end : minute >= window.start && minute < window.end);
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
            input: { ...(p ? { [p.field]: value ?? null } : {}),
              ...(rule.serviceWindow ? { sourceAt: facts.sourceAt ?? null } : {}) },
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
    if (request.messages[0]?.text !== scoped.text ||
      request.tools.some((tool) => !scoped.tools.includes(tool.name)))
      throw new HarnessError('rule_context_changed', 'Reviewed context changed. Start a new reasoning step.');
  }
  async inspect(request: ModelRequest, text: string): Promise<ModelInspection> {
    return this.inspection ? this.inspection(request, text)
      : { action: 'verified', message: 'No output inspector installed.', rules: [] };
  }
  async complete(request: ModelRequest, signal: AbortSignal): Promise<ModelResult> {
    this.assertSafe(z.json().parse(request));
    const result = await this.inner.complete(request, signal);
    this.assertSafe(z.json().parse(result));
    return result;
  }
}
