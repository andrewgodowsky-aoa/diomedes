import { describe, expect, test } from 'vitest';
import {
  assembleContext,
  enforceResolved,
  governingEvidence,
  interceptionGuarantees,
  toScopedRule,
} from '../server/rules.js';
import { ruleSchema, type Rule, type RuleScope } from '../shared/connection-rules.js';
import { enforcementFor } from '../shared/rule-authority.js';
import { HarnessError } from '../server/harness/policy.js';

const scope: RuleScope = { tenantId: 'tenant-a', projectId: 'p1' };

const stored = (over: Partial<Rule>): Rule =>
  ruleSchema.parse({
    id: 'house-tone',
    version: 1,
    enabled: true,
    scope,
    provenance: { source: 'business setup', connectorVersion: null, trust: 'host-reviewed' },
    type: 'standing',
    text: 'Lead with what changed and what is now due.',
    predicate: null,
    action: 'context',
    ...over,
  });

const policy = (over: Partial<Rule> = {}): Rule =>
  ruleSchema.parse({
    id: 'no-external',
    version: 2,
    enabled: true,
    scope,
    provenance: { source: 'business setup', connectorVersion: null, trust: 'host-reviewed' },
    type: 'policy',
    text: 'External writes need separate authority.',
    predicate: { field: 'externalWrite', operator: 'eq', value: true },
    action: 'deny',
    ...over,
  });

describe('mapping a stored rule onto precedence', () => {
  test('standing guidance becomes its own preference key, so guidance never fights guidance', () => {
    const a = toScopedRule(stored({ id: 'tone-a' }), 'organization');
    const b = toScopedRule(stored({ id: 'tone-b' }), 'organization');
    expect(a.category).toBe('guidance');
    expect(a.stance).toBe('prefer');
    expect(a.constrains).not.toBe(b.constrains);
  });

  test('a deny policy forbids the field it names', () => {
    const mapped = toScopedRule(policy(), 'organization');
    expect(mapped.category).toBe('enforced');
    expect(mapped.stance).toBe('forbid');
    expect(mapped.constrains).toBe('externalWrite');
  });

  test('the authority comes from the caller, never from the rule text', () => {
    expect(toScopedRule(policy(), 'task').authority).toBe('task');
    expect(toScopedRule(policy(), 'organization').authority).toBe('organization');
  });
});

describe('context assembly', () => {
  const assemble = (
    rules: { rule: Rule; authority: Parameters<typeof toScopedRule>[1] }[],
    over: Partial<Parameters<typeof assembleContext>[0]> = {},
  ) =>
    assembleContext({
      rules,
      scope,
      routeId: 'codex',
      agentRole: 'Summarise what happened and what needs attention.',
      facts: [],
      surface: 'before-effect',
      ...over,
    });

  test('only rules whose scope applies are considered', () => {
    const elsewhere = stored({
      id: 'other-project',
      scope: { tenantId: 'tenant-a', projectId: 'p2' },
    });
    const built = assemble([
      { rule: stored({ id: 'here' }), authority: 'organization' },
      { rule: elsewhere, authority: 'organization' },
    ]);
    expect(built.view.lines.map((line) => line.ruleId)).toEqual(['here']);
    expect(built.resolution.decisions.map((item) => item.rule.id)).toEqual(['here']);
  });

  test('a candidate rule nobody reviewed is not applied', () => {
    const built = assemble([
      {
        rule: stored({
          id: 'candidate',
          provenance: { source: 'model proposal', connectorVersion: null, trust: 'candidate' },
        }),
        authority: 'organization',
      },
    ]);
    expect(built.view.lines).toEqual([]);
  });

  test('a task rule cannot loosen an organization policy', () => {
    const built = assemble([
      { rule: policy(), authority: 'organization' },
      {
        rule: policy({
          id: 'task-allows',
          type: 'workflow',
          action: 'create-issue',
          text: 'Send it anyway.',
        }),
        authority: 'task',
      },
    ]);
    const decision = built.resolution.decisions.find((item) => item.rule.id === 'task-allows')!;
    expect(decision.outcome).toBe('blocked');
  });

  test('the governing evidence names the rule and the surface, not the text', () => {
    const built = assemble([{ rule: policy(), authority: 'organization' }]);
    expect(built.governing).toHaveLength(1);
    expect(built.governing[0].ruleId).toBe('no-external');
    expect(built.governing[0].ruleVersion).toBe(2);
    expect(built.governing[0].surface).toBe('before-effect');
    expect(JSON.stringify(built.governing)).not.toContain('External writes');
  });

  test('the assembled view has a stable revision', () => {
    const rules = [{ rule: stored({}), authority: 'organization' as const }];
    expect(assemble(rules).view.revision).toBe(assemble(rules).view.revision);
  });
});

describe('what blocks work', () => {
  test('two equal company requirements that contradict each other stop the work', () => {
    const built = assembleContext({
      rules: [
        { rule: policy({ id: 'never-send' }), authority: 'organization' },
        {
          rule: policy({
            id: 'always-send',
            type: 'workflow',
            action: 'create-issue',
            text: 'Always send.',
          }),
          authority: 'organization',
        },
      ],
      scope,
      routeId: 'codex',
      agentRole: 'role',
      facts: [],
      surface: 'before-effect',
    });
    expect(built.resolution.blocking).toHaveLength(1);
    expect(() => enforceResolved(built.resolution)).toThrow(HarnessError);
  });

  test('a resolution with nothing unresolved does not throw', () => {
    const built = assembleContext({
      rules: [{ rule: policy(), authority: 'organization' }],
      scope,
      routeId: 'codex',
      agentRole: 'role',
      facts: [],
      surface: 'before-effect',
    });
    expect(() => enforceResolved(built.resolution)).not.toThrow();
  });
});

describe('agreement with the existing interception model', () => {
  test('what a diomedes-led run claims before an effect matches the per-route answer', () => {
    expect(interceptionGuarantees('diomedes-led').preEffect).toBe('enforced');
    expect(enforcementFor('enforced', 'codex', 'before-effect').enforcement).toBe('enforced');
  });

  test('governingEvidence records each applied rule once', () => {
    const rules = [
      toScopedRule(policy(), 'organization'),
      toScopedRule(stored({}), 'organization'),
    ];
    const evidence = governingEvidence(rules, { routeId: 'codex', surface: 'before-effect' });
    expect(evidence.map((item) => item.ruleId).sort()).toEqual(['house-tone', 'no-external']);
  });
});
