/**
 * H15 ladder: note → correct (bounded per detector per run) → escalate, raised
 * once per underlying issue and never re-raised once you chose to continue.
 */
import { expect, test } from 'vitest';
import { correctionBound, DRIFT_LADDERS, nextStep, type LadderContext } from '../server/supervision/ladder.js';
import { CORRECTION_LIMITS } from '../server/harness/lifecycle.js';
import {
  DRIFT_CODES,
  SUPERVISION_ACTOR,
  type DriftCode,
  type DriftFinding,
  type DriftSeverity,
  type SupervisionRecord,
} from '../shared/supervision.js';

let serial = 0;
const finding = (
  severity: DriftSeverity,
  code: DriftCode = 'no-progress',
  issueKey = 'loop:call:search:aaaa',
  evidenceDigest = `digest-${++serial}`,
): DriftFinding => ({
  code,
  issueKey,
  severity,
  summary: 'it looped',
  ask: 'Stop looping.',
  evidence: [],
  evidenceDigest,
});
const record = (
  from: DriftFinding,
  action: SupervisionRecord['action'],
  extra: Partial<SupervisionRecord> = {},
): SupervisionRecord => ({
  protocolVersion: 1,
  id: `SV${++serial}`,
  action,
  sessionId: 'S1',
  taskId: 'T1',
  code: from.code,
  issueKey: from.issueKey,
  severity: from.severity,
  summary: from.summary,
  evidence: [],
  evidenceDigest: from.evidenceDigest,
  at: '2026-09-24T10:00:00.000Z',
  actor: SUPERVISION_ACTOR,
  reason: '',
  ...extra,
});
const context = (records: SupervisionRecord[], extra: Partial<LadderContext> = {}): LadderContext => ({
  sessionId: 'S1',
  taskId: 'T1',
  live: true,
  records,
  needs: [],
  ...extra,
});

test('every detector declares a ladder whose corrections stay inside the harness limit', () => {
  for (const code of DRIFT_CODES) {
    expect(DRIFT_LADDERS[code].entry).toEqual({ info: 'note', warning: 'correct', critical: 'escalate' });
    expect(correctionBound(code)).toBeGreaterThan(0);
    expect(correctionBound(code)).toBeLessThanOrEqual(CORRECTION_LIMITS.maxAttempts);
  }
});

test('info is noted once per issue per run; the same evidence is never acted on twice', () => {
  const first = finding('info');
  expect(nextStep(first, context([]))).toMatchObject({ rung: 'note' });
  const noted = [record(first, 'note')];
  expect(nextStep(first, context(noted)).rung).toBeNull();
  expect(nextStep(finding('info'), context(noted)).rung).toBeNull();
});

test('a warning is corrected up to the bound, then escalated', () => {
  const bound = correctionBound('no-progress');
  const trail: SupervisionRecord[] = [];
  for (let n = 1; n <= bound; n++) {
    const found = finding('warning');
    const step = nextStep(found, context(trail));
    expect(step).toMatchObject({ rung: 'correct', attempt: { n, of: bound } });
    trail.push(record(found, 'correct'));
  }
  const persisted = nextStep(finding('warning'), context(trail));
  expect(persisted.rung).toBe('escalate');
  expect(persisted.reason).toContain('which is the bound');
});

test('the bound is per detector per run: another issue of the same detector shares it', () => {
  const trail = [
    record(finding('warning', 'scope-drift', 'scope:Plans'), 'correct'),
  ];
  expect(nextStep(finding('warning', 'scope-drift', 'scope:Other'), context(trail)).rung).toBe('escalate');
  // Another run starts with its own bound.
  expect(
    nextStep(finding('warning', 'scope-drift', 'scope:Other'), context(trail, { sessionId: 'S2' })).rung,
  ).toBe('correct');
  // Another detector has its own bound.
  expect(nextStep(finding('warning', 'budget-burn', 'budget:units'), context(trail)).rung).toBe('correct');
});

test('critical escalates at once', () => {
  expect(nextStep(finding('critical', 'scope-drift', 'scope:Plans'), context([]))).toMatchObject({
    rung: 'escalate',
  });
});

test('an open escalation holds the issue for the whole task, on any run', () => {
  const found = finding('critical', 'scope-drift', 'scope:Plans');
  const escalated = [record(found, 'escalate', { needId: 'N1' })];
  const open = [{ id: 'N1', state: 'open' as const }];
  expect(nextStep(finding('critical', 'scope-drift', 'scope:Plans'), context(escalated, { needs: open })).rung).toBeNull();
  expect(
    nextStep(finding('critical', 'scope-drift', 'scope:Plans'), context(escalated, { needs: open, sessionId: 'S2' })).rung,
  ).toBeNull();
  // A different issue is a different escalation.
  expect(
    nextStep(finding('critical', 'scope-drift', 'scope:Other'), context(escalated, { needs: open })).rung,
  ).toBe('escalate');
});

test('after you chose to continue, the same issue is noted once and never raised again', () => {
  const found = finding('critical', 'scope-drift', 'scope:Plans');
  const trail = [
    record(found, 'escalate', { needId: 'N1' }),
    record(found, 'answer', {
      needId: 'N1',
      answer: 'continue',
      control: { commandId: 'c1', control: 'resume', outcome: 'applied', detail: '' },
    }),
  ];
  const answered = [{ id: 'N1', state: 'go-ahead' as const }];
  const onNext = context(trail, { needs: answered, sessionId: 'S2' });
  const step = nextStep(finding('critical', 'scope-drift', 'scope:Plans'), onNext);
  expect(step).toMatchObject({ rung: 'note', settled: 'Acknowledged by your earlier answer.' });
  trail.push(record(finding('critical', 'scope-drift', 'scope:Plans'), 'note', { sessionId: 'S2' }));
  expect(nextStep(finding('critical', 'scope-drift', 'scope:Plans'), onNext).rung).toBeNull();
});

test('a continue that Resume refused is not an acknowledgment', () => {
  const found = finding('critical', 'scope-drift', 'scope:Plans');
  const trail = [
    record(found, 'escalate', { needId: 'N1' }),
    record(found, 'answer', {
      needId: 'N1',
      answer: 'continue',
      control: { commandId: 'c1', control: 'resume', outcome: 'refused', detail: 'no' },
    }),
    record(found, 'answer', { needId: 'N1', answer: 'stop' }),
  ];
  const step = nextStep(
    finding('critical', 'scope-drift', 'scope:Plans'),
    context(trail, { needs: [{ id: 'N1', state: 'declined' }], sessionId: 'S2' }),
  );
  expect(step.rung).toBe('escalate');
});

test('a run that has ended is only noted, once per severity', () => {
  const ended = context([], { live: false });
  const found = finding('critical', 'scope-drift', 'scope:Plans');
  expect(nextStep(found, ended)).toMatchObject({ rung: 'note', settled: 'The run had ended.' });
  const noted = context([record(found, 'note')], { live: false });
  expect(nextStep(finding('critical', 'scope-drift', 'scope:Plans'), noted).rung).toBeNull();
});

test('a run a supervision correction started shares its origin run’s bound', () => {
  const origin = record(finding('warning', 'scope-drift', 'scope:Plans'), 'correct', { sessionId: 'S1' });
  const next = context([origin], { sessionId: 'S2', lineage: ['S2', 'S1'] });
  expect(nextStep(finding('warning', 'scope-drift', 'scope:Plans'), next).rung).toBe('escalate');
});
