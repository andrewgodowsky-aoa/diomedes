/**
 * H16 feeds H15's ladder rather than duplicating it: a steer or stop firing is
 * a `rule-trigger` finding with the firing as its evidence, and the ladder
 * decides — a steer is corrected (twice at most) and then escalated; a stop,
 * or a hold the approval gate could not carry, pauses the run for you. An
 * annotation, and a hold waiting at the gate, are never findings.
 */
import { describe, expect, test } from 'vitest';
import { detectRuleTriggers } from '../server/supervision/detectors';
import { nextStep } from '../server/supervision/ladder';
import type { DriftInput, SupervisionRecord } from '../shared/supervision';
import type { StreamTriggerFiring } from '../shared/stream-rules';

const input = (triggers: StreamTriggerFiring[]): DriftInput => ({
  run: { id: 'S1', taskId: 'T1', live: true, startedAt: '2026-09-24T10:00:00.000Z' },
  scope: { declared: [], selected: [], admitted: [] },
  touches: [],
  actions: [],
  budget: [],
  plan: null,
  rules: [],
  verification: null,
  triggers,
});

let n = 0;
function firing(
  intervention: StreamTriggerFiring['intervention'],
  handling: StreamTriggerFiring['handling'],
  ruleId = 'r1',
): StreamTriggerFiring {
  n += 1;
  return {
    protocolVersion: 1,
    id: `TF${n}`,
    at: `2026-09-24T10:00:0${n % 10}.000Z`,
    rule: { id: ruleId, version: 1, digest: 'a'.repeat(64), authority: 'project', constrains: `trigger:${ruleId}`, text: 'Be careful.', ...(intervention === 'steer' ? { message: 'Slow down.' } : {}) },
    intervention,
    sessionId: 'S1',
    taskId: 'T1',
    runId: 'R1',
    stepId: 'model:0',
    attempt: 1,
    match: { kind: 'text', source: 'stream', start: 4, end: 9, excerpt: 'careful' },
    handling,
    actor: { kind: 'diomedes', role: 'supervision', mode: 'application' },
  };
}

describe('H16 rule-trigger findings', () => {
  test('only firings handed to supervision are findings; annotations and gated holds are not', () => {
    expect(
      detectRuleTriggers(input([firing('annotate', 'recorded'), firing('hold', 'held-for-you')])),
    ).toEqual([]);
  });

  test('a steer is a warning whose ask is the rule’s message; a stop, or an ungated hold, is critical', () => {
    const [steer] = detectRuleTriggers(input([firing('steer', 'handed-to-supervision')]));
    expect(steer).toMatchObject({ code: 'rule-trigger', issueKey: 'trigger:project:r1', severity: 'warning', ask: 'Slow down.' });
    expect(steer.evidence[0]).toMatchObject({ kind: 'rule', detail: expect.stringContaining('r1 v1 (project, aaaaaaaaaaaa) matched “careful” at 4–9 of model:0.') });
    expect(detectRuleTriggers(input([firing('stop', 'handed-to-supervision')]))[0].severity).toBe('critical');
    const [held] = detectRuleTriggers(input([firing('hold', 'handed-to-supervision')]));
    expect(held.severity).toBe('critical');
    expect(held.summary).toMatch(/^a project rule \(r1\) held the streamed text/);
  });

  test('firings of one rule are one issue: the ladder corrects a repeating steer twice, then pauses for you', () => {
    const records: SupervisionRecord[] = [];
    const firings: StreamTriggerFiring[] = [];
    const rungs: (string | null)[] = [];
    for (let index = 0; index < 3; index++) {
      firings.push(firing('steer', 'handed-to-supervision'));
      const [finding] = detectRuleTriggers(input(firings));
      const step = nextStep(finding, { sessionId: 'S1', taskId: 'T1', live: true, records, needs: [] });
      rungs.push(step.rung);
      if (step.rung)
        records.push({
          protocolVersion: 1,
          id: `SV${index}`,
          action: step.rung,
          sessionId: 'S1',
          taskId: 'T1',
          code: finding.code,
          issueKey: finding.issueKey,
          severity: finding.severity,
          summary: finding.summary,
          evidence: finding.evidence,
          evidenceDigest: finding.evidenceDigest,
          at: '2026-09-24T10:00:00.000Z',
          actor: { kind: 'diomedes', role: 'supervision', mode: 'application' },
          reason: step.reason,
        });
    }
    expect(rungs).toEqual(['correct', 'correct', 'escalate']);
  });

  test('two rules are two issues', () => {
    const found = detectRuleTriggers(
      input([firing('steer', 'handed-to-supervision', 'a'), firing('stop', 'handed-to-supervision', 'b')]),
    );
    expect(found.map((item) => [item.issueKey, item.severity])).toEqual([
      ['trigger:project:a', 'warning'],
      ['trigger:project:b', 'critical'],
    ]);
  });
});
