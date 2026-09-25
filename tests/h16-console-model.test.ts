/**
 * The H16 rule editor's form model: it turns fields into exactly the declaration the server
 * judges (no rules of its own), bumps a rule's version only when its declaration changed, and
 * reads a rule and the server's resolution back as words. The loop start helpers build H13's
 * versioned start command with its defaults.
 */
import { describe, expect, test } from 'vitest';
import { streamRuleSchema, resolveStreamRules, type StreamRule } from '../shared/stream-rules';
import {
  decisionFor,
  decisionLine,
  draftFromRule,
  emptyDraft,
  matchSummary,
  ruleFromDraft,
  toggled,
  watchesSentence,
  withRule,
} from '../client/console/trigger-rules-model';
import { AGENT_NAME } from '../shared/agent-name';
import { defaultLoopGoal, loopStartCommand } from '../client/console/loop-start-model';

const hold: StreamRule = {
  id: 'hold-reports',
  version: 1,
  enabled: true,
  taskId: 'T1',
  match: { kind: 'tool', tool: 'propose_write', target: 'Harness report.md' },
  intervention: 'hold',
  text: 'Reports are read first.',
};

describe('the rule form', () => {
  test('every schema field round-trips through the form unchanged, version kept', () => {
    const rules: StreamRule[] = [
      hold,
      { id: 'a', version: 3, enabled: false, match: { kind: 'text', phrase: 'API key', caseSensitive: true }, intervention: 'stop', text: 'No keys.' },
      {
        id: 'b',
        version: 2,
        enabled: true,
        constrains: 'trigger:shared',
        match: { kind: 'pattern', pattern: 'rm -rf .*', window: 80 },
        intervention: 'steer',
        message: 'Do not delete.',
        text: 'No deletes.',
      },
      { id: 'c', version: 1, enabled: true, match: { kind: 'tool', effectClass: ['read', 'external-send'] }, intervention: 'annotate', text: 'Note reads.' },
    ];
    for (const rule of rules) {
      expect(ruleFromDraft(draftFromRule(rule), rule)).toEqual(rule);
      expect(streamRuleSchema.safeParse(ruleFromDraft(draftFromRule(rule), rule)).success).toBe(true);
    }
  });

  test('a new rule starts at version 1 and leaves empty optional fields out', () => {
    const draft = { ...emptyDraft(), id: 'note', text: 'Note helpers.', phrase: 'helper' };
    expect(ruleFromDraft(draft, null)).toEqual({
      id: 'note',
      version: 1,
      enabled: true,
      match: { kind: 'text', phrase: 'helper' },
      intervention: 'annotate',
      text: 'Note helpers.',
    });
    // A task limit comes from the form's default when the editor is opened on a task.
    expect(ruleFromDraft({ ...draft, taskId: 'T9' }, null).taskId).toBe('T9');
  });

  test('an edited rule carries the next version only when its declaration changed', () => {
    expect(ruleFromDraft({ ...draftFromRule(hold), text: 'Changed.' }, hold).version).toBe(2);
    expect(ruleFromDraft({ ...draftFromRule(hold), target: '' }, hold)).toMatchObject({
      version: 2,
      match: { kind: 'tool', tool: 'propose_write' },
    });
    expect(toggled(hold)).toEqual({ ...hold, enabled: false, version: 2 });
  });

  test('the form refuses nothing: a hold on streamed text is sent as typed, for the server to judge', () => {
    const draft = { ...emptyDraft(), id: 'bad', text: 'x', phrase: 'x', intervention: 'hold' as const };
    const rule = ruleFromDraft(draft, null);
    expect(rule.intervention).toBe('hold');
    expect(streamRuleSchema.safeParse(rule).success).toBe(false);
  });

  test('add, replace by the earlier id, and remove', () => {
    const next = { ...hold, id: 'renamed', version: 2 };
    expect(withRule([hold], next, null)).toEqual([hold, next]);
    expect(withRule([hold], next, 'hold-reports')).toEqual([next]);
    expect(withRule([hold], null, 'hold-reports')).toEqual([]);
  });
});

describe('a rule and its resolution, in words', () => {
  test('what each kind of rule watches for', () => {
    expect(matchSummary(hold)).toBe('A proposed propose_write call on Harness report.md');
    expect(matchSummary({ ...hold, match: { kind: 'text', phrase: 'helper' } })).toBe('Streamed text containing “helper”');
    expect(matchSummary({ ...hold, match: { kind: 'pattern', pattern: 'x.*y', window: 40, caseSensitive: true } })).toBe(
      'Streamed text matching “x.*y” within 40 characters, case-sensitive',
    );
    expect(matchSummary({ ...hold, match: { kind: 'tool', effectClass: ['read'] } })).toBe('Any proposed tool call that is read');
  });

  test("the server's decision for each rule, with its reason as given", () => {
    const org: StreamRule = { ...hold, id: 'reports-held', taskId: undefined };
    const loose: StreamRule = { ...hold, id: 'noted', constrains: 'trigger:reports-held', intervention: 'annotate' };
    const resolution = resolveStreamRules(
      [
        { rule: org, authority: 'organization' },
        { rule: loose, authority: 'project' },
        { rule: { ...hold, id: 'off', enabled: false }, authority: 'project' },
      ],
      'T1',
    );
    expect(decisionLine(decisionFor(resolution, 'organization', 'reports-held')!)).toBe('Governs · Governs trigger:reports-held on the tool calls Nectovia runs itself.');
    expect(decisionLine(decisionFor(resolution, 'project', 'noted')!)).toBe(
      'Blocked · reports-held (organization) restricts trigger:reports-held with organization authority, and this cannot loosen it.',
    );
    expect(decisionLine(decisionFor(resolution, 'project', 'off')!)).toBe('Off · Turned off.');
    expect(decisionFor(null, 'project', 'noted')).toBeNull();
  });

  test('which runs rules watch is said from the server answer', () => {
    expect(watchesSentence(['diomedes-loop'])).toBe(
      `Trigger rules watch ${AGENT_NAME} work loop runs only. Runs on Codex, Claude Code, OpenCode and other external engines use their own tools and are not watched.`,
    );
    expect(watchesSentence(['diomedes-loop', 'external-work'])).toBe(
      `Text rules watch what the model writes, on ${AGENT_NAME} work loop runs and on task work on every engine; on external engines other than Codex they read it after secrets are removed, so a rule looking for a secret may not fire there. Tool rules watch the tool calls ${AGENT_NAME} runs itself. Codex, Claude Code, OpenCode and other external engines run their own tools, and those are not watched.`,
    );
  });
});

describe('the loop start command', () => {
  test("the goal defaults to the task's statement, then its name", () => {
    expect(defaultLoopGoal({ name: 'Check linen', description: '  Compare the order with the delivery.  ' })).toBe(
      'Compare the order with the delivery.',
    );
    expect(defaultLoopGoal({ name: 'Check linen', description: '' })).toBe('Check linen');
  });

  test("H13's versioned command, with its default turns unless the person changed them", () => {
    expect(
      loopStartCommand({ commandId: 'c1', taskId: 'T1', goal: ' Go. ', route: 'native-fixture', sources: ['a.md'], consent: false, maxTurns: null }),
    ).toEqual({ protocolVersion: 1, commandId: 'c1', taskId: 'T1', goal: 'Go.', route: 'native-fixture', sources: ['a.md'] });
    expect(
      loopStartCommand({ commandId: 'c2', taskId: 'T1', goal: 'Go.', route: 'openrouter', sources: [], consent: true, maxTurns: 4 }),
    ).toEqual({ protocolVersion: 1, commandId: 'c2', taskId: 'T1', goal: 'Go.', route: 'openrouter', sources: [], consent: true, maxTurns: 4 });
  });
});
