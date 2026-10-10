/**
 * WF-1: the workflow graph's pure checks and progress projection
 * (`shared/workflow.ts`). No run service, store or clock.
 */
import { describe, expect, test } from 'vitest';
import type { HarnessBudget, StepRecord } from '../shared/harness';
import {
  checkWorkflow,
  decideStepId,
  joinStepId,
  nodeStepId,
  untilStepId,
  workflowProgress,
  type WorkflowContext,
  type WorkflowDefinition,
  type WorkflowNode,
} from '../shared/workflow';

const context: WorkflowContext = {
  tools: new Map([
    ['read_fixture', { cost: 1 }],
    ['format_lines', { cost: 1 }],
    ['propose_write', { cost: 2 }],
  ]),
  maxAttempts: 3,
};

const graph = (nodes: WorkflowNode[], maxSteps = 32): WorkflowDefinition => ({
  id: 'format-report-graph',
  version: 'v1',
  capabilityId: 'format-report',
  nodes,
  limits: { maxSteps },
});

const read: WorkflowNode = { id: 'read', kind: 'tool', tool: 'read_fixture', input: { value: { name: 'a' } }, after: [] };
const format: WorkflowNode = {
  id: 'format',
  kind: 'tool',
  tool: 'format_lines',
  input: { object: { lines: { from: 'read', pointer: '/lines' }, width: { value: 80 } } },
  after: ['read'],
};

const codes = (definition: unknown, ctx: WorkflowContext = context) => {
  const result = checkWorkflow(definition, ctx);
  return result.ok ? [] : result.problems.map((problem) => problem.code);
};

const step = (stepId: string, state: StepRecord['state'], output: unknown = null) =>
  ({ intent: { stepId }, state, output }) as unknown as Pick<StepRecord, 'intent' | 'state' | 'output'>;

describe('workflow step ids', () => {
  test('fit the run service step id pattern at the longest node id', () => {
    const STEP_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
    const id = 'a'.repeat(48);
    for (const stepId of [nodeStepId(id), nodeStepId(id, 15), decideStepId(id), untilStepId(id, 15), joinStepId(id)])
      expect(stepId).toMatch(STEP_ID);
  });
});

describe('checkWorkflow', () => {
  test('a straight graph passes with a dependency-first order and its worst case', () => {
    const result = checkWorkflow(graph([format, read]), context);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.order).toEqual(['read', 'format']);
    expect(result.worstCase).toEqual({ steps: 2, units: 6, modelCalls: 0, toolCalls: 6 });
  });

  test('the order is the same however the nodes are listed', () => {
    const a: WorkflowNode = { ...read, id: 'a' };
    const b: WorkflowNode = { ...read, id: 'b' };
    const join: WorkflowNode = { id: 'all', kind: 'join', from: ['b', 'a'], reducer: 'collect', after: ['b', 'a'] };
    const one = checkWorkflow(graph([join, b, a]), context);
    const two = checkWorkflow(graph([a, join, b]), context);
    expect(one.ok && two.ok && one.order).toEqual(['a', 'b', 'all']);
    expect(two.ok && two.order).toEqual(['a', 'b', 'all']);
  });

  test('rejects a cycle', () => {
    const x: WorkflowNode = { ...read, id: 'x', after: ['y'] };
    const y: WorkflowNode = { ...read, id: 'y', after: ['x'] };
    expect(codes(graph([read, x, y]))).toEqual(['cycle']);
  });

  test('rejects a graph with no root', () => {
    expect(codes(graph([{ ...read, id: 'x', after: ['x'] }]))).toContain('self_dependency');
    const x: WorkflowNode = { ...read, id: 'x', after: ['y'] };
    const y: WorkflowNode = { ...read, id: 'y', after: ['x'] };
    expect(codes(graph([x, y]))).toEqual(['no_root', 'cycle']);
  });

  test('rejects a missing dependency and a duplicate id', () => {
    expect(codes(graph([read, { ...format, after: ['nowhere'] }]))).toEqual(['unknown_dependency']);
    expect(codes(graph([read, read]))).toEqual(['duplicate_node']);
  });

  test('rejects a reference to a node it does not wait for', () => {
    const sibling: WorkflowNode = { ...format, id: 'sibling', after: [] };
    expect(codes(graph([read, sibling]))).toEqual(['reference_not_upstream']);
    const unknown: WorkflowNode = { ...format, input: { from: 'ghost' } };
    expect(codes(graph([read, unknown]))).toEqual(['unknown_reference']);
  });

  test('accepts a reference to a node further upstream', () => {
    const third: WorkflowNode = { ...format, id: 'third', input: { from: 'read' }, after: ['format'] };
    expect(codes(graph([read, format, third]))).toEqual([]);
  });

  test('rejects a tool the capability does not offer, and a wait node', () => {
    expect(codes(graph([{ ...read, tool: 'send_email' }]))).toEqual(['unknown_tool']);
    expect(codes(graph([read, { id: 'hold', kind: 'wait', event: 'invoice.paid', after: ['read'] }]))).toEqual([
      'wait_unsupported',
    ]);
  });

  test('rejects malformed shapes without throwing', () => {
    expect(codes({ ...graph([read]), nodes: [{ ...read, id: 'Bad Id' }] })).toEqual(['invalid_shape']);
    expect(codes({ ...graph([read]), extra: true })).toEqual(['invalid_shape']);
    expect(codes(null)).toEqual(['invalid_shape']);
    expect(codes(graph([{ ...format, input: { from: 'read', pointer: 'no-slash' } }, read]))).toEqual(['invalid_shape']);
  });

  test('a branch target must wait for the branch, exist, and belong to one branch', () => {
    const decide: WorkflowNode = {
      id: 'route',
      kind: 'branch',
      on: { from: 'read', pointer: '/kind' },
      cases: { short: 'format' },
      otherwise: 'archive',
      after: ['read'],
    };
    const archive: WorkflowNode = { ...read, id: 'archive', after: ['route'] };
    const formatAfter: WorkflowNode = { ...format, after: ['read', 'route'] };
    expect(codes(graph([read, decide, formatAfter, archive]))).toEqual([]);
    expect(codes(graph([read, decide, format, archive]))).toEqual(['branch_target']);
    expect(codes(graph([read, { ...decide, otherwise: 'ghost' }, formatAfter]))).toEqual(['branch_target']);
    const other: WorkflowNode = { ...decide, id: 'other', cases: { x: 'archive' }, otherwise: 'archive' };
    const shared: WorkflowNode = { ...archive, after: ['route', 'other'] };
    expect(codes(graph([read, decide, other, formatAfter, shared]))).toEqual(['branch_target']);
  });

  test('a join must wait for every node it reads', () => {
    const a: WorkflowNode = { ...read, id: 'a' };
    const b: WorkflowNode = { ...read, id: 'b' };
    const join: WorkflowNode = { id: 'all', kind: 'join', from: ['a', 'b'], reducer: 'collect', after: ['a'] };
    expect(codes(graph([a, b, join]))).toEqual(['join_source']);
    expect(codes(graph([a, b, { ...join, after: ['a', 'b'] }]))).toEqual([]);
  });

  test('a loop repeats one tool or model node that waits only for it', () => {
    const loop: WorkflowNode = {
      id: 'retry',
      kind: 'loop',
      body: 'attempt',
      until: { from: 'attempt', pointer: '/ok' },
      maxIterations: 4,
      after: ['read'],
    };
    const attempt: WorkflowNode = { ...format, id: 'attempt', after: ['retry'], input: { from: 'read' } };
    const result = checkWorkflow(graph([read, loop, attempt]), context);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.worstCase).toEqual({ steps: 9, units: 15, modelCalls: 0, toolCalls: 15 });
    expect(codes(graph([read, loop, { ...attempt, after: ['retry', 'read'] }]))).toEqual(['loop_body']);
    expect(codes(graph([read, { ...loop, body: 'ghost' }]))).toEqual(['loop_body', 'unknown_reference']);
    const approve: WorkflowNode = { id: 'attempt', kind: 'approval', what: 'Approve the attempt', after: ['retry'] };
    expect(codes(graph([read, loop, approve]))).toEqual(['loop_body']);
  });

  test('nothing but its loop may read or wait for a loop body', () => {
    const loop: WorkflowNode = { id: 'retry', kind: 'loop', body: 'attempt', until: { from: 'attempt' }, maxIterations: 2, after: [] };
    const attempt: WorkflowNode = { ...read, id: 'attempt', after: ['retry'] };
    const reader: WorkflowNode = { ...format, id: 'reader', input: { from: 'attempt' }, after: ['retry'] };
    expect(codes(graph([loop, attempt, reader]))).toEqual(['reference_not_upstream']);
    const waiter: WorkflowNode = { ...read, id: 'waiter', after: ['attempt'] };
    expect(codes(graph([loop, attempt, waiter]))).toEqual(['loop_body']);
    expect(codes(graph([loop, attempt, { ...format, id: 'ok', input: { from: 'retry' }, after: ['retry'] }]))).toEqual([]);
  });

  test('a worst case above the node limit or the start budget is refused', () => {
    const loop: WorkflowNode = { id: 'retry', kind: 'loop', body: 'attempt', until: { from: 'attempt' }, maxIterations: 16, after: [] };
    const attempt: WorkflowNode = { id: 'attempt', kind: 'model', prompt: { value: 'again' }, after: ['retry'] };
    expect(codes(graph([loop, attempt], 8))).toEqual(['step_limit']);
    const budget: HarnessBudget = { units: 10, modelCalls: 100, toolCalls: 100, wallMs: null };
    expect(codes(graph([loop, attempt], 64), { ...context, budget })).toEqual(['budget']);
    expect(codes(graph([loop, attempt], 64), { ...context, budget: { ...budget, units: 48 } })).toEqual([]);
  });

  test('reports every problem in one pass', () => {
    const result = checkWorkflow(
      graph([read, { ...read, id: 'mail', tool: 'send_email' }, { id: 'hold', kind: 'wait', event: 'e', after: [] }]),
      context,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.problems.map((p) => [p.code, p.node])).toEqual([
      ['unknown_tool', 'mail'],
      ['wait_unsupported', 'hold'],
    ]);
  });
});

describe('checkWorkflow after the WF-1 audit', () => {
  const loop: WorkflowNode = { id: 'retry', kind: 'loop', body: 'attempt', until: { from: 'attempt' }, maxIterations: 2, after: ['read'] };

  test('a loop body cannot read its own unfinished loop, but may read what came before it', () => {
    const own: WorkflowNode = { ...format, id: 'attempt', input: { from: 'retry' }, after: ['retry'] };
    expect(codes(graph([read, loop, own]))).toEqual(['reference_not_upstream']);
    const before: WorkflowNode = { ...format, id: 'attempt', input: { from: 'read' }, after: ['retry'] };
    expect(codes(graph([read, loop, before]))).toEqual([]);
  });

  test('loop stop decisions and model context steps count toward the step limit', () => {
    const long: WorkflowNode = { ...loop, maxIterations: 16, after: [] };
    const body: WorkflowNode = { ...read, id: 'attempt', after: ['retry'] };
    const result = checkWorkflow(graph([long, body], 128), context);
    expect(result.ok && result.worstCase.steps).toBe(32);
    expect(codes(graph([long, body], 31))).toEqual(['step_limit']);
    const model: WorkflowNode = { id: 'ask', kind: 'model', prompt: { value: 'hi' }, after: [] };
    const asked = checkWorkflow(graph([model]), context);
    expect(asked.ok && asked.worstCase.steps).toBe(2);
    const three = [0, 1, 2].flatMap((n): WorkflowNode[] => [
      { ...long, id: `retry${n}`, body: `attempt${n}`, until: { from: `attempt${n}` } },
      { ...body, id: `attempt${n}`, after: [`retry${n}`] },
    ]);
    expect(codes(graph(three, 64))).toEqual(['step_limit']);
  });

  test('a join reads each source once, and a dependency is listed once', () => {
    const child: WorkflowNode = { ...read, id: 'child' };
    const twice: WorkflowNode = { id: 'all', kind: 'join', from: ['child', 'child'], reducer: 'collect', after: ['child'] };
    expect(codes(graph([child, twice]))).toEqual(['join_source']);
    expect(codes(graph([read, { ...format, after: ['read', 'read'] }]))).toEqual(['duplicate_dependency']);
  });

  test('a deeply nested definition is refused as a shape, not thrown', () => {
    let deep: unknown = { value: 1 };
    for (let i = 0; i < 2000; i++) deep = { object: { child: deep } };
    const result = checkWorkflow(graph([{ ...read, input: deep as never }]), context);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.problems.map((p) => p.code)).toEqual(['invalid_shape']);
    let literal: unknown = 1;
    for (let i = 0; i < 2000; i++) literal = [literal];
    expect(codes(graph([{ ...read, input: { value: literal as never } }]))).toEqual(['invalid_shape']);
  });

  test('attempts, costs and budgets must be whole numbers before any bound is computed', () => {
    const zeroBudget: HarnessBudget = { units: 0, modelCalls: 0, toolCalls: 0, wallMs: null };
    for (const maxAttempts of [0, Number.NaN, 1.5, -1, Infinity])
      expect(codes(graph([read]), { ...context, maxAttempts, budget: zeroBudget })).toEqual(['invalid_context']);
    const badCost = new Map([['read_fixture', { cost: -1 }]]);
    expect(codes(graph([read]), { ...context, tools: badCost })).toEqual(['invalid_context']);
    expect(codes(graph([read]), { ...context, budget: { ...zeroBudget, units: Number.NaN } })).toEqual(['invalid_context']);
    expect(codes(graph([read]), { ...context, budget: zeroBudget })).toEqual(['budget', 'budget']);
  });
});

describe('workflowProgress', () => {
  const decide: WorkflowNode = {
    id: 'route',
    kind: 'branch',
    on: { from: 'read', pointer: '/kind' },
    cases: { short: 'format' },
    otherwise: 'archive',
    after: ['read'],
  };
  const formatAfter: WorkflowNode = { ...format, after: ['read', 'route'] };
  const archive: WorkflowNode = { ...read, id: 'archive', after: ['route'] };
  const tail: WorkflowNode = { ...read, id: 'tail', after: ['archive'] };
  const definition = graph([read, decide, formatAfter, archive, tail]);

  test('reads each node from its steps and skips what a branch did not choose', () => {
    expect(
      workflowProgress(definition, [
        step(nodeStepId('read'), 'succeeded', { kind: 'short' }),
        step(decideStepId('route'), 'succeeded', { v: 1, matched: 'short', next: 'format' }),
        step(nodeStepId('format'), 'waiting_approval'),
      ]),
    ).toEqual({ read: 'done', route: 'done', format: 'waiting', archive: 'skipped', tail: 'skipped' });
  });

  test('nothing is skipped before the branch decides', () => {
    expect(workflowProgress(definition, [step(nodeStepId('read'), 'running')])).toEqual({
      read: 'running',
      route: 'not-started',
      format: 'not-started',
      archive: 'not-started',
      tail: 'not-started',
    });
  });

  test('a loop runs until its stop condition or its limit, and its body reads as the loop', () => {
    const loop: WorkflowNode = { id: 'retry', kind: 'loop', body: 'attempt', until: { from: 'attempt' }, maxIterations: 3, after: [] };
    const attempt: WorkflowNode = { ...read, id: 'attempt', after: ['retry'] };
    const looping = graph([loop, attempt]);
    const first = [step(nodeStepId('attempt', 0), 'succeeded'), step(untilStepId('retry', 0), 'succeeded', { stop: false })];
    expect(workflowProgress(looping, first)).toEqual({ retry: 'running', attempt: 'running' });
    expect(
      workflowProgress(looping, [...first, step(nodeStepId('attempt', 1), 'succeeded'), step(untilStepId('retry', 1), 'succeeded', { stop: true })]),
    ).toEqual({ retry: 'done', attempt: 'done' });
    expect(workflowProgress(looping, [...first, step(nodeStepId('attempt', 1), 'failed')])).toEqual({
      retry: 'failed',
      attempt: 'failed',
    });
  });

  test('a join after a branch reconverges when one arm is skipped', () => {
    const route: WorkflowNode = { id: 'route', kind: 'branch', on: { from: 'read' }, cases: { x: 'a' }, otherwise: 'b', after: ['read'] };
    const a: WorkflowNode = { ...read, id: 'a', after: ['route'] };
    const b: WorkflowNode = { ...read, id: 'b', after: ['route'] };
    const all: WorkflowNode = { id: 'all', kind: 'join', from: ['a', 'b'], reducer: 'collect', after: ['a', 'b'] };
    const diamond = graph([read, route, a, b, all]);
    const decided = [
      step(nodeStepId('read'), 'succeeded', 'x'),
      step(decideStepId('route'), 'succeeded', { v: 1, matched: 'x', next: 'a' }),
    ];
    expect(workflowProgress(diamond, [...decided, step(nodeStepId('a'), 'succeeded')])).toMatchObject({
      a: 'done',
      b: 'skipped',
      all: 'not-started',
    });
    expect(
      workflowProgress(diamond, [...decided, step(nodeStepId('a'), 'succeeded'), step(joinStepId('all'), 'succeeded')]),
    ).toMatchObject({ b: 'skipped', all: 'done' });
    const after: WorkflowNode = { ...read, id: 'tail', after: ['all'] };
    expect(workflowProgress(graph([read, route, a, b, all, after]), decided).tail).toBe('not-started');
  });

  test('a recorded step reports its own status before anything it waits for', () => {
    const route: WorkflowNode = { id: 'route', kind: 'branch', on: { from: 'read' }, cases: { x: 'a' }, otherwise: 'b', after: ['read'] };
    const a: WorkflowNode = { ...read, id: 'a', after: ['route'] };
    const b: WorkflowNode = { ...read, id: 'b', after: ['route'] };
    const progress = workflowProgress(graph([read, route, a, b]), [
      step(decideStepId('route'), 'succeeded', { v: 1, matched: 'x', next: 'a' }),
      step(nodeStepId('b'), 'succeeded'),
    ]);
    expect(progress.b).toBe('done');
  });

  test('a node named constructor is reported as an own entry, as a root and as a dependency', () => {
    const root: WorkflowNode = { ...read, id: 'constructor' };
    const child: WorkflowNode = { ...read, id: 'tostring', after: ['constructor'] };
    const progress = workflowProgress(graph([root, child]), [step(nodeStepId('constructor'), 'succeeded')]);
    expect(Object.hasOwn(progress, 'constructor')).toBe(true);
    expect(progress).toEqual({ constructor: 'done', tostring: 'not-started' });
    expect(JSON.parse(JSON.stringify(progress))).toEqual({ constructor: 'done', tostring: 'not-started' });
    const asChild = workflowProgress(graph([read, { ...read, id: 'constructor', after: ['read'] }]), [
      step(nodeStepId('read'), 'succeeded'),
      step(nodeStepId('constructor'), 'running'),
    ]);
    expect(asChild).toEqual({ read: 'done', constructor: 'running' });
  });
});
