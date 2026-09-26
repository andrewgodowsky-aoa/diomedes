/**
 * The evaluation request on the wire (shared/evaluation-wire.ts): the desktop and
 * the managed gateway count one request with the same code, so what the desktop
 * would send is exactly what the gateway accepts, and what one side refuses as too
 * large the other refuses too. No provider, no network.
 */
import { describe, expect, test } from 'vitest';
import {
  checkEvaluationRequest,
  UNPROVEN_ROUTE_LIMITS as WIRE_LIMITS,
  serializedRequestTokens as wireTokens,
} from '../shared/evaluation-wire.js';
import {
  providerQuestions,
  runEvaluation,
  scriptedEvaluationPort,
  serializedRequestTokens,
  UNPROVEN_ROUTE_LIMITS,
} from '../server/harness/evaluation-adapter.js';
import { planPreflight, type PreflightInput } from '../server/harness/jev-advisor.js';
import { booleanQuestion, evaluationProfile, scoreQuestion } from '../shared/evaluation.js';

const input = (overrides: Partial<PreflightInput> = {}): PreflightInput => ({
  scope: { tenant: 'local', project: 'P1', thread: 'C1' },
  intent: 'Work out a staffing plan for the holiday weekend given the new opening hours.',
  mode: 'ask',
  style: 'efficient',
  sources: [{ path: 'hours.md', sha: 'aaa' }],
  shortlist: [
    { id: 'pos.read', description: 'Read the POS' },
    { id: 'schedule.read', description: 'Read the schedule' },
  ],
  ...overrides,
});

function asked(overrides: Partial<PreflightInput> = {}) {
  const plan = planPreflight(input(overrides));
  if (plan.kind !== 'ask') throw new Error('expected a plan with questions');
  return { state: plan.state, questions: providerQuestions(plan.profile), profile: plan.profile };
}

describe('the evaluation wire', () => {
  test('the adapter re-exports the shared bounds, so both sides use one definition', () => {
    expect(UNPROVEN_ROUTE_LIMITS).toBe(WIRE_LIMITS);
    expect(serializedRequestTokens).toBe(wireTokens);
  });

  test('accepts exactly what the preflight sends, and rebuilds the questions it checked', () => {
    const { state, questions } = asked();
    const checked = checkEvaluationRequest(JSON.parse(JSON.stringify({ state, questions })));
    expect(checked).toEqual({ ok: true, request: { state, questions } });
  });

  test('refuses a field outside the allowlist, naming it', () => {
    const { state, questions } = asked();
    for (const extra of ['model', 'provider', 'stream']) {
      const refused = checkEvaluationRequest({ state, questions, [extra]: 'x' });
      expect(refused).toMatchObject({ ok: false, code: 'unsupported_field', field: extra });
    }
    expect(checkEvaluationRequest({ state, questions: { q: { type: 'choice', instructions: 'Pick.', criteria: { a: null }, zdr: true } } }))
      .toMatchObject({ ok: false, code: 'unsupported_field', field: 'questions.q.zdr' });
    expect(checkEvaluationRequest({ state, questions: { q: { type: 'ranking', instructions: 'Rank.' } } }))
      .toMatchObject({ ok: false, code: 'unsupported_field', field: 'questions.q.type' });
  });

  test('refuses what is not an evaluation', () => {
    const { questions } = asked();
    expect(checkEvaluationRequest([])).toMatchObject({ ok: false, code: 'invalid_body' });
    expect(checkEvaluationRequest({ questions })).toMatchObject({ ok: false, code: 'invalid_body', field: 'state' });
    expect(checkEvaluationRequest({ state: 7, questions })).toMatchObject({ ok: false, code: 'invalid_body', field: 'state' });
    expect(checkEvaluationRequest({ state: 'x', questions: {} })).toMatchObject({ ok: false, code: 'invalid_body', field: 'questions' });
    expect(checkEvaluationRequest({ state: 'x', questions: { q: { type: 'score', instructions: 'Rate.', criteria: ['only one'] } } }))
      .toMatchObject({ ok: false, code: 'invalid_body' });
    let deep: unknown = 'bottom';
    for (let level = 0; level < 70; level++) deep = [deep];
    expect(checkEvaluationRequest({ state: deep, questions })).toMatchObject({ ok: false, code: 'invalid_body', field: 'state' });
  });

  test('refuses the two shapes a route cannot send: an undescribed score level and a one-sided boolean', () => {
    const profile = evaluationProfile({
      profileId: 'wire.shapes',
      revision: 1,
      purpose: 'thread-preparation',
      questions: [
        scoreQuestion({ id: 'effort', instructions: 'How much effort?', levels: ['little', null, 'a lot'] }),
        booleanQuestion({ id: 'urgent', instructions: 'Is it urgent?', whenTrue: 'Due today.' }),
      ],
    });
    const questions = providerQuestions(profile);
    expect(checkEvaluationRequest({ state: 'x', questions: { effort: questions.effort } }))
      .toMatchObject({ ok: false, code: 'unsupported_field', field: 'questions.effort.criteria[1]' });
    expect(checkEvaluationRequest({ state: 'x', questions: { urgent: questions.urgent } }))
      .toMatchObject({ ok: false, code: 'unsupported_field', field: 'questions.urgent.criteria' });
  });

  test('refuses as too large exactly what the adapter refuses as too large, before either sends', async () => {
    // About 31.5k tokens of state, under the 32k state bound; the questions and the
    // envelope take the complete request over the 32k total.
    const { state, questions, profile } = asked({ intent: 'Plan this. '.repeat(8_700) });
    expect(checkEvaluationRequest({ state, questions })).toMatchObject({ ok: false, code: 'request_too_large' });
    const port = scriptedEvaluationPort({ result: {} });
    await expect(
      runEvaluation({ port, profile, state, signal: new AbortController().signal, observedAt: new Date().toISOString() }),
    ).rejects.toMatchObject({ code: 'request_too_large' });
    expect(port.calls).toHaveLength(0);

    const many = Object.fromEntries(Array.from({ length: 33 }, (_, index) => [`q${index}`, { type: 'boolean', instructions: 'Yes?' }]));
    expect(checkEvaluationRequest({ state: 'x', questions: many })).toMatchObject({ ok: false, code: 'request_too_large' });
  });

  test('keeps a question named like a prototype key as an ordinary question', () => {
    const body = JSON.parse('{"state":"x","questions":{"__proto__":{"type":"boolean","instructions":"Yes?"}}}');
    const checked = checkEvaluationRequest(body);
    expect(checked.ok).toBe(true);
    if (!checked.ok) return;
    expect(Object.keys(checked.request.questions)).toEqual(['__proto__']);
    expect(JSON.stringify(checked.request.questions)).toBe('{"__proto__":{"type":"boolean","instructions":"Yes?"}}');
  });
});
