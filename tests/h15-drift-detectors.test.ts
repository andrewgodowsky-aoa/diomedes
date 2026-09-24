/**
 * H15 detectors: table tests, one table per detector, each with true
 * positives and the near misses that must not fire. The detectors are pure
 * functions of `DriftInput`, so every case is a record set and an expectation.
 */
import { describe, expect, test } from 'vitest';
import {
  detectBudgetBurn,
  detectDrift,
  detectInstructionDrift,
  detectNoProgress,
  detectScopeDrift,
  detectVerificationRegression,
  folderOf,
  insideProject,
  machineRules,
  within,
} from '../server/supervision/detectors.js';
import type {
  DriftAction,
  DriftInput,
  DriftSeverity,
  DriftTouch,
} from '../shared/supervision.js';
import type { HistoryEntry, Session, Task } from '../shared/types.js';
import type { VerificationRecord } from '../shared/verification.js';

const AT = '2026-09-24T10:00:00.000Z';

function input(partial: Partial<DriftInput> = {}): DriftInput {
  return {
    run: { id: 'S-run', taskId: 'T1', live: true, startedAt: AT },
    scope: { declared: [], selected: [], admitted: [] },
    touches: [],
    actions: [],
    budget: [],
    plan: null,
    rules: [],
    verification: null,
    ...partial,
  };
}
let serial = 0;
function touch(target: string, extra: Partial<DriftTouch> = {}): DriftTouch {
  return {
    ref: `E${++serial}`,
    at: AT,
    kind: 'file',
    target,
    access: 'write',
    status: 'recorded',
    approved: false,
    ...extra,
  };
}
const menu = { declared: ['Menu/Fall menu.md'], selected: [], admitted: [] };

describe('paths', () => {
  test.each([
    ['Menu/a.md', true],
    ['a.md', true],
    ['../a.md', false],
    ['Menu/../../a.md', false],
    ['/etc/passwd', false],
    ['C:/Users/x', false],
    ['Menu\\a.md', false],
    ['', false],
  ])('insideProject(%j) is %s', (name, expected) => expect(insideProject(name)).toBe(expected));
  test('folders are compared by whole segments', () => {
    expect(folderOf('Menu/Fall menu.md')).toBe('Menu');
    expect(folderOf('plan.md')).toBe('');
    expect(within('Menu/sub/a.md', 'Menu')).toBe(true);
    expect(within('Menu2/a.md', 'Menu')).toBe(false);
    expect(within('anything.md', '')).toBe(true);
  });
});

describe('(a) scope drift', () => {
  const cases: {
    name: string;
    scope?: DriftInput['scope'];
    touches: DriftTouch[];
    expect: { issueKey: string; severity: DriftSeverity; summary: string }[];
  }[] = [
    {
      name: 'an unapproved recorded write outside the selected folder pauses',
      touches: [touch('Plans/launch.md')],
      expect: [
        {
          issueKey: 'scope:Plans',
          severity: 'critical',
          summary: 'it started writing outside the selected folder',
        },
      ],
    },
    {
      name: 'a sibling folder whose name starts the same is still outside',
      touches: [touch('Menu2/a.md')],
      expect: [
        {
          issueKey: 'scope:Menu2',
          severity: 'critical',
          summary: 'it started writing outside the selected folder',
        },
      ],
    },
    {
      name: 'a read outside is noted',
      touches: [touch('Plans/launch.md', { access: 'read' })],
      expect: [
        { issueKey: 'scope:Plans', severity: 'info', summary: 'it read files outside the selected folder' },
      ],
    },
    {
      name: 'a proposal outside is noted: the person is already being asked',
      touches: [touch('notes.md', { status: 'proposed' })],
      expect: [
        { issueKey: 'scope:/', severity: 'info', summary: 'it proposed writing outside the selected folder' },
      ],
    },
    {
      name: 'reads and a write in one folder are one issue at the worst severity',
      touches: [touch('Plans/a.md', { access: 'read' }), touch('Plans/b.md')],
      expect: [
        {
          issueKey: 'scope:Plans',
          severity: 'critical',
          summary: 'it started writing outside the selected folder',
        },
      ],
    },
    {
      name: 'a path outside the project is critical even with no declared scope',
      scope: { declared: [], selected: [], admitted: [] },
      touches: [touch('../other/secret.md', { access: 'read' })],
      expect: [
        {
          issueKey: 'scope:outside-project',
          severity: 'critical',
          summary: 'it touched a path outside the project folder',
        },
      ],
    },
    {
      name: 'a destination the run was not admitted to',
      scope: { ...menu, destinations: ['project.read'] },
      touches: [touch('web.post', { kind: 'destination' })],
      expect: [
        {
          issueKey: 'scope:destination:web.post',
          severity: 'critical',
          summary: 'it reached a destination it was not admitted to',
        },
      ],
    },
    // Near misses.
    { name: 'a write inside the selected folder, nested', touches: [touch('Menu/drafts/a.md')], expect: [] },
    { name: 'a write a person approved exactly', touches: [touch('Plans/a.md', { approved: true })], expect: [] },
    {
      name: 'a folder a task grant admits',
      scope: { ...menu, admitted: ['Plans/'] },
      touches: [touch('Plans/a.md')],
      expect: [],
    },
    {
      name: 'an admitted exact file',
      scope: { ...menu, admitted: ['Plans/a.md'] },
      touches: [touch('Plans/a.md')],
      expect: [],
    },
    {
      name: 'a selected source at the project root puts the whole project in scope',
      scope: { declared: [], selected: ['Reopening plan.md'], admitted: [] },
      touches: [touch('Plans/a.md')],
      expect: [],
    },
    {
      name: 'no declared or selected source: there is no scope to judge',
      scope: { declared: [], selected: [], admitted: [] },
      touches: [touch('Plans/a.md')],
      expect: [],
    },
    {
      name: 'destinations are not judged where none were declared',
      touches: [touch('web.post', { kind: 'destination' })],
      expect: [],
    },
    {
      name: 'an admitted destination',
      scope: { ...menu, destinations: ['web.post'] },
      touches: [touch('web.post', { kind: 'destination' })],
      expect: [],
    },
  ];
  test.each(cases)('$name', ({ scope = menu, touches, expect: expected }) => {
    const found = detectScopeDrift(input({ scope, touches }));
    expect(found.map(({ issueKey, severity, summary }) => ({ issueKey, severity, summary }))).toEqual(
      expected,
    );
    for (const item of found) {
      expect(item.code).toBe('scope-drift');
      expect(item.evidence.length).toBe(touches.length);
      expect(item.evidenceDigest).toMatch(/^[a-f0-9]{64}$/);
    }
  });
  test('evidence names the path and the scope; new evidence changes the digest', () => {
    const one = detectScopeDrift(input({ scope: menu, touches: [touch('Plans/a.md')] }))[0];
    expect(one.evidence[0].detail).toBe('Wrote Plans/a.md, outside Menu/.');
    const two = detectScopeDrift(
      input({ scope: menu, touches: [touch('Plans/a.md'), touch('Plans/b.md')] }),
    )[0];
    expect(two.issueKey).toBe(one.issueKey);
    expect(two.evidenceDigest).not.toBe(one.evidenceDigest);
  });
});

describe('(b) no-progress loop', () => {
  const call = (tool: string, input: string, output: string | null = `out-${input}`): DriftAction => ({
    ref: `step-${++serial}`,
    at: AT,
    tool,
    inputDigest: `${input}`.padEnd(64, '0'),
    outputDigest: output === null ? null : `${output}`.padEnd(64, '0'),
  });
  const same = (count: number) => Array.from({ length: count }, () => call('search', 'a'));
  const cases: { name: string; actions: DriftAction[]; expect: [string, DriftSeverity][] }[] = [
    { name: 'three identical calls in a row are noted', actions: same(3), expect: [['call', 'info']] },
    { name: 'four ask for a correction', actions: same(4), expect: [['call', 'warning']] },
    { name: 'six pause the run', actions: same(6), expect: [['call', 'critical']] },
    {
      name: 'a loop the run already left is only noted',
      actions: [...same(6), call('read', 'b')],
      expect: [['call', 'info']],
    },
    {
      name: 'different inputs, the same answer back, over and over',
      actions: ['a', 'b', 'c', 'd', 'e'].map((i) => call('search', i, 'nothing')),
      expect: [['observation', 'warning']],
    },
    // Near misses.
    { name: 'two identical calls', actions: same(2), expect: [] },
    {
      name: 'the same tool with different inputs and different answers',
      actions: ['a', 'b', 'c', 'd', 'e', 'f'].map((i) => call('search', i)),
      expect: [],
    },
    {
      name: 'identical inputs to different tools',
      actions: [call('a', 'x'), call('b', 'x'), call('a', 'x'), call('b', 'x')],
      expect: [],
    },
    {
      name: 'calls with no recorded output are not an observation loop',
      actions: ['a', 'b', 'c', 'd', 'e'].map((i) => call('search', i, null)),
      expect: [],
    },
    {
      name: 'three identical calls interrupted by one other call',
      actions: [call('s', 'a'), call('s', 'a'), call('t', 'b'), call('s', 'a')],
      expect: [],
    },
  ];
  test.each(cases)('$name', ({ actions, expect: expected }) => {
    const found = detectNoProgress(input({ actions }));
    expect(found.map((item) => [item.issueKey.split(':')[1], item.severity])).toEqual(expected);
    for (const item of found) expect(item.code).toBe('no-progress');
  });
});

describe('(c) budget burn', () => {
  const line = (used: number, limit = 100) => ({
    dimension: 'tool-calls' as const,
    used,
    limit,
    source: 'harness run R1',
  });
  const cases: {
    name: string;
    budget: DriftInput['budget'];
    plan?: DriftInput['plan'];
    live?: boolean;
    expect: DriftSeverity[];
  }[] = [
    { name: 'eighty per cent used while running is noted', budget: [line(80)], expect: ['info'] },
    {
      name: 'on pace to run out before the plan completes asks for a correction',
      budget: [line(30)],
      plan: { done: 2, total: 10 },
      expect: ['warning'],
    },
    {
      name: 'on pace to run out with nine tenths gone pauses',
      budget: [line(95)],
      plan: { done: 9, total: 10 },
      expect: ['critical'],
    },
    // Near misses.
    { name: 'seventy-nine per cent', budget: [line(79)], expect: [] },
    { name: 'a run that has ended', budget: [line(99)], live: false, expect: [] },
    { name: 'a plan that is complete', budget: [line(99)], plan: { done: 10, total: 10 }, expect: [] },
    {
      name: 'a pace that fits the budget',
      budget: [line(40)],
      plan: { done: 5, total: 10 },
      expect: [],
    },
    { name: 'no limit declared', budget: [line(50, 0)], expect: [] },
    {
      name: 'no step done yet, so no pace',
      budget: [line(10)],
      plan: { done: 0, total: 10 },
      expect: [],
    },
  ];
  test.each(cases)('$name', ({ budget, plan = null, live = true, expect: expected }) => {
    const found = detectBudgetBurn(
      input({ budget, plan, run: { id: 'S-run', taskId: 'T1', live, startedAt: AT } }),
    );
    expect(found.map((item) => item.severity)).toEqual(expected);
    for (const item of found) {
      expect(item.code).toBe('budget-burn');
      expect(item.issueKey).toBe('budget:tool-calls');
    }
  });
  test('the pace evidence says how the projection was made', () => {
    const [found] = detectBudgetBurn(input({ budget: [line(30)], plan: { done: 2, total: 10 } }));
    expect(found.summary).toBe(
      'it is on pace to use about 150 of its 100 tool calls before the plan completes',
    );
    expect(found.evidence.map((item) => item.detail)).toEqual([
      'Used 30 of 100 tool calls (30%), limit from harness run R1.',
      '2 of 10 plan steps done; at this pace the plan needs about 150 tool calls.',
    ]);
  });
});

describe('(d) instruction drift', () => {
  const file = { path: 'AGENTS.md', sha: 'a'.repeat(64) };
  test('only backticked paths after a prohibition are machine-checkable', () => {
    const text = [
      '# Rules',
      '- Do not edit `generated/`',
      'Never write to `config/prod.json` or `secrets/`.',
      "Don't modify `../outside.md`",
      'Do not touch `src/*.ts`',
      'Be careful with `generated/` in general.',
      'You may edit `docs/`.',
    ].join('\n');
    const rules = machineRules(text, file, '');
    expect(rules.map((rule) => [rule.forbids, rule.line])).toEqual([
      ['generated/', 2],
      ['config/prod.json', 3],
      ['secrets/', 3],
    ]);
    expect(machineRules('- Never edit `dist/`', { path: 'pkg/AGENTS.md', sha: file.sha }, 'pkg')[0].forbids).toBe(
      'pkg/dist/',
    );
  });
  const rules = machineRules('- Do not edit `generated/`\n- Never change `config/prod.json`', file, '');
  const nested = machineRules('- Do not edit `dist/`', { path: 'pkg/AGENTS.md', sha: file.sha }, 'pkg');
  const cases: {
    name: string;
    touches: DriftTouch[];
    rules?: DriftInput['rules'];
    expect: [string, DriftSeverity][];
  }[] = [
    {
      name: 'a recorded write into a forbidden folder pauses',
      touches: [touch('generated/client.ts')],
      expect: [['generated/', 'critical']],
    },
    {
      name: 'a recorded write to a forbidden file pauses',
      touches: [touch('config/prod.json')],
      expect: [['config/prod.json', 'critical']],
    },
    {
      name: 'a proposal is noted',
      touches: [touch('generated/client.ts', { status: 'proposed' })],
      expect: [['generated/', 'info']],
    },
    {
      name: 'a write the person approved exactly is noted, not raised',
      touches: [touch('generated/client.ts', { approved: true })],
      expect: [['generated/', 'info']],
    },
    {
      name: 'a nested file governs its own folder',
      rules: nested,
      touches: [touch('pkg/dist/x.js')],
      expect: [['pkg/dist/', 'critical']],
    },
    // Near misses.
    { name: 'a read of a forbidden path', touches: [touch('generated/a.ts', { access: 'read' })], expect: [] },
    { name: 'a sibling folder', touches: [touch('generated2/a.ts')], expect: [] },
    { name: 'a file whose name starts the same', touches: [touch('config/prod.json.bak')], expect: [] },
    {
      name: "a nested rule does not reach outside its folder",
      rules: nested,
      touches: [touch('dist/x.js')],
      expect: [],
    },
  ];
  test.each(cases)('$name', ({ touches, rules: own = rules, expect: expected }) => {
    const found = detectInstructionDrift(input({ rules: own, touches }));
    expect(found.map((item) => [own.find((rule) => `instruction:${rule.id}` === item.issueKey)!.forbids, item.severity])).toEqual(expected);
    for (const item of found) {
      expect(item.code).toBe('instruction-drift');
      expect(item.evidence[0]).toMatchObject({ kind: 'rule' });
    }
  });
});

describe('(e) verification regression', () => {
  const A = 'a'.repeat(64);
  const B = 'b'.repeat(64);
  const C = 'c'.repeat(64);
  const task: Pick<Task, 'id' | 'acceptance'> = {
    id: 'T1',
    acceptance: {
      protocolVersion: 1,
      checks: [{ id: 'c1', kind: 'file-exists', path: 'out.md' }],
      digest: 'd'.repeat(64),
      declaredAt: AT,
      declaredBy: 'you',
    },
  };
  const origin = {
    protocolVersion: 1 as const,
    mode: 'application' as const,
    engine: null,
    model: { requested: null, reported: null, source: 'not-recorded' as const },
    executorId: 'diomedes:verifier',
  };
  const record = (outcome: 'passed' | 'failed' = 'passed'): VerificationRecord => ({
    protocolVersion: 1,
    id: 'V1',
    sessionId: 'S-old',
    taskId: 'T1',
    declarationDigest: 'd'.repeat(64),
    declaredChecks: 1,
    requestedBy: 'you',
    startedAt: AT,
    endedAt: AT,
    producer: null,
    outputs: [{ path: 'out.md', sha: A }],
    bound: [{ path: 'out.md', sha: A }],
    checks: [
      {
        id: 'c1',
        kind: 'file-exists',
        label: 'out.md exists',
        outcome,
        sentence: outcome === 'passed' ? 'out.md exists.' : 'out.md is missing.',
        evidence: [{ path: 'out.md', sha: A }],
        ranAt: AT,
        durationMs: 1,
        origin,
      },
    ],
  });
  const entry = (
    id: string,
    sessionId: string | null,
    files: [string, string | null, string][],
    verification?: VerificationRecord,
  ): HistoryEntry => ({
    id,
    time: AT,
    actor: 'diomedes',
    kind: verification ? 'verified' : 'changed',
    sentence: '',
    sessionId,
    taskId: 'T1',
    sample: false,
    files: files.map(([path, before, after]) => ({
      path,
      op: 'modified',
      before,
      after,
      recorded: true,
      reason: null,
    })),
    label: null,
    restoreOf: null,
    replaced: null,
    versionId: id,
    commit: null,
    ...(verification ? { verification } : {}),
  });
  const sessions: Pick<Session, 'id' | 'state' | 'taskId'>[] = [
    { id: 'S-old', state: 'done', taskId: 'T1' },
    { id: 'S-run', state: 'working', taskId: 'T1' },
  ];
  const base = [entry('H1', 'S-old', [['out.md', null, A]]), entry('H2', null, [], record())];
  const cases: { name: string; history: HistoryEntry[]; expect: DriftSeverity[] }[] = [
    {
      name: 'this run changed a Verified output: uncertain now',
      history: [...base, entry('H3', 'S-run', [['out.md', A, B]])],
      expect: ['warning'],
    },
    // Near misses.
    {
      name: 'an outside edit flipped it, not this run',
      history: [...base, entry('H3', null, [['out.md', A, C]])],
      expect: [],
    },
    {
      name: 'this run wrote a file the verification never bound',
      history: [...base, entry('H3', 'S-run', [['other.md', null, B]])],
      expect: [],
    },
    {
      name: 'it was Failed verification before this run, not Verified',
      history: [
        entry('H1', 'S-old', [['out.md', null, A]]),
        entry('H2', null, [], record('failed')),
        entry('H3', 'S-run', [['out.md', A, B]]),
      ],
      expect: [],
    },
    {
      name: 'this run wrote the same bytes back',
      history: [...base, entry('H3', 'S-run', [['out.md', A, A]])],
      expect: [],
    },
  ];
  test.each(cases)('$name', ({ history, expect: expected }) => {
    const found = detectVerificationRegression(
      input({ verification: { history, sessions, tasks: [task] } }),
    );
    expect(found.map((item) => item.severity)).toEqual(expected);
    for (const item of found) {
      expect(item).toMatchObject({ code: 'verification-regression', issueKey: 'verification:S-old' });
      expect(item.evidence.map((e) => e.detail)).toEqual([
        'Run S-old was Verified; it now reads Verification uncertain: out.md changed after verification, so the result no longer describes these bytes.',
        `out.md: verified ${A.slice(0, 12)}, now ${B.slice(0, 12)}.`,
      ]);
    }
  });
});

test('detectDrift runs every detector and nothing on a clean run', () => {
  expect(detectDrift(input({ scope: menu, touches: [touch('Menu/a.md')] }))).toEqual([]);
  const codes = detectDrift(
    input({
      scope: menu,
      touches: [touch('Plans/a.md')],
      budget: [{ dimension: 'units', used: 90, limit: 100, source: 'test' }],
    }),
  ).map((item) => item.code);
  expect(codes).toEqual(['scope-drift', 'budget-burn']);
});
