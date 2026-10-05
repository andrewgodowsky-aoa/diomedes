/** Host bounds at the exported SDK ports, without a network, credentials or spend. */
import { describe, expect, test } from 'vitest';
import {
  gatewayEvaluationPort,
  openRouterEvaluationPort,
  type EvaluationPortCall,
} from '../server/harness/evaluation-adapter.js';
import type { EvaluationRequestLimits, ProviderQuestion } from '../shared/evaluation-wire.js';

const questions = (count = 1, instructions = 'Is this relevant?'): Record<string, ProviderQuestion> =>
  Object.fromEntries(Array.from({ length: count }, (_, index) => [
    `q${index}`, { type: 'boolean' as const, instructions },
  ]));

function sdkPort(route: 'gateway' | 'openrouter', limits?: EvaluationRequestLimits, beforeLoad?: () => Promise<void>) {
  const effects: string[] = [];
  const sent: { state: unknown; questions: Record<string, ProviderQuestion> }[] = [];
  const createProvider = (_settings: { apiKey: string }) => {
    effects.push('create-provider');
    return { evaluationModel: (modelId: string) => modelId };
  };
  const settings = {
    apiKey: 'invented-test-key',
    modelId: 'typesafe/jev-1.13',
    ...(limits !== undefined ? { limits } : {}),
    loadSdk: async () => {
      effects.push('load-sdk');
      await beforeLoad?.();
      return {
        createGateway: createProvider,
        createOpenRouter: createProvider,
        evaluate: async (call: { state: unknown; questions: Record<string, ProviderQuestion> }) => {
          effects.push('evaluate');
          sent.push(JSON.parse(JSON.stringify({ state: call.state, questions: call.questions })));
          return { answers: {} };
        },
      };
    },
  };
  const port = route === 'gateway' ? gatewayEvaluationPort(settings) : openRouterEvaluationPort(settings);
  return { port, effects, sent };
}

const call = (state: unknown, given = questions()): EvaluationPortCall => ({
  state,
  questions: given,
  signal: new AbortController().signal,
});

for (const route of ['gateway', 'openrouter'] as const) {
  describe(`${route} Jev host bounds at evaluate()`, () => {
    test('refuses 33 questions before loading the SDK even when runEvaluation is bypassed', async () => {
      const { port, effects } = sdkPort(route);
      await expect(port.evaluate(call('s', questions(33)))).rejects.toMatchObject({
        code: 'request_too_large', usage: null,
      });
      expect(effects).toEqual([]);
    });

    test.each([
      ['dense ASCII', 'a1-/'.repeat(8_100)],
      ['Unicode', '界'.repeat(11_000)],
      ['JSON escapes', '\u0000'.repeat(6_000)],
    ] as const)('refuses a state over the serialized byte bound for %s before loading the SDK', async (_name, state) => {
      const { port, effects } = sdkPort(route);
      await expect(port.evaluate(call(state))).rejects.toMatchObject({ code: 'state_too_large', usage: null });
      expect(effects).toEqual([]);
    });

    test('counts every question in the whole request while the state itself fits', async () => {
      const { port, effects } = sdkPort(route);
      await expect(port.evaluate(call('x'.repeat(28_000), questions(4, 'y'.repeat(1_100))))).rejects
        .toMatchObject({ code: 'request_too_large', usage: null });
      expect(effects).toEqual([]);
    });

    test('supports a tighter whole-request bound before loading the SDK', async () => {
      const { port, effects } = sdkPort(route, { maxTotalTokens: 200, maxStatePlusLongestQuestionTokens: 200 });
      await expect(port.evaluate(call('x'.repeat(150)))).rejects.toMatchObject({ code: 'request_too_large' });
      expect(effects).toEqual([]);
    });

    test('checks a tightened state-plus-longest-question bound independently of the total', async () => {
      const { port, effects } = sdkPort(route, { maxTotalTokens: 32_000, maxStatePlusLongestQuestionTokens: 150 });
      await expect(port.evaluate(call('x'.repeat(100), questions(1, 'y'.repeat(100))))).rejects
        .toMatchObject({ code: 'request_too_large', message: expect.stringMatching(/longest question/) });
      expect(effects).toEqual([]);
    });

    test.each([
      ['zero', 0], ['negative', -1], ['fraction', 1.5], ['NaN', Number.NaN],
      ['infinity', Number.POSITIVE_INFINITY], ['unsafe integer', Number.MAX_SAFE_INTEGER + 1],
      ['widening', 32_001],
    ] as const)('rejects a %s limit at construction instead of making the route unbounded', (_name, bound) => {
      for (const limits of [
        { maxTotalTokens: bound, maxStatePlusLongestQuestionTokens: 32_000 },
        { maxTotalTokens: 32_000, maxStatePlusLongestQuestionTokens: bound },
      ]) {
        expect(() => sdkPort(route, limits)).toThrow(expect.objectContaining({ code: 'invalid_transport' }));
      }
    });

    test('rejects incomplete and null limits at construction', () => {
      for (const limits of [{ maxTotalTokens: 100 }, null])
        expect(() => sdkPort(route, limits as EvaluationRequestLimits)).toThrow(
          expect.objectContaining({ code: 'invalid_transport' }),
        );
    });

    test('copies and freezes tightened limits so later settings mutation cannot widen them', async () => {
      const limits = { maxTotalTokens: 200, maxStatePlusLongestQuestionTokens: 200 };
      const { port, effects } = sdkPort(route, limits);
      limits.maxTotalTokens = 32_000;
      limits.maxStatePlusLongestQuestionTokens = 32_000;
      expect(port.limits).toEqual({ maxTotalTokens: 200, maxStatePlusLongestQuestionTokens: 200 });
      expect(Object.isFrozen(port.limits)).toBe(true);
      await expect(port.evaluate(call('x'.repeat(300)))).rejects.toMatchObject({ code: 'request_too_large' });
      expect(effects).toEqual([]);
    });

    test('captures each getter-backed constructor limit once before validating and freezing it', async () => {
      const reads = { total: 0, pair: 0 };
      const limits = {
        get maxTotalTokens() { return ++reads.total <= 3 ? 200 : 32_001; },
        get maxStatePlusLongestQuestionTokens() { return ++reads.pair <= 3 ? 200 : 32_001; },
      };
      const { port, effects } = sdkPort(route, limits);
      expect(port.limits).toEqual({ maxTotalTokens: 200, maxStatePlusLongestQuestionTokens: 200 });
      expect(reads).toEqual({ total: 1, pair: 1 });
      expect(Object.isFrozen(port.limits)).toBe(true);
      await expect(port.evaluate(call('x'.repeat(150)))).rejects.toMatchObject({ code: 'request_too_large' });
      expect(effects).toEqual([]);
    });

    test('refuses an inflated detached state snapshot from a changing getter before loading the SDK', async () => {
      let reads = 0;
      const state = {
        // Initially ordinary JSON-sized text; the later snapshot read expands it.
        get material() { return ++reads <= 4 ? 'small' : 'x'.repeat(40_000); },
      };
      const { port, effects } = sdkPort(route);
      await expect(port.evaluate(call(state))).rejects.toMatchObject({ code: 'state_too_large', usage: null });
      expect(effects).toEqual([]);
    });

    test('refuses a whole detached request inflated by changing criteria getters before loading the SDK', async () => {
      const reads = { a: 0, b: 0 };
      const criteria = {
        get a() { return ++reads.a <= 3 ? 'Small.' : 'x'.repeat(3_900); },
        get b() { return ++reads.b <= 3 ? 'Large.' : 'y'.repeat(3_900); },
      };
      const { port, effects } = sdkPort(route);
      await expect(port.evaluate(call('s'.repeat(28_000), {
        q: { type: 'choice', instructions: 'Pick one.', criteria },
      }))).rejects.toMatchObject({
        code: 'request_too_large', message: expect.stringMatching(/whole request/), usage: null,
      });
      expect(effects).toEqual([]);
    });

    test('admits 32 small questions through the same port boundary', async () => {
      const { port, effects } = sdkPort(route);
      await port.evaluate(call('s', questions(32)));
      expect(effects).toEqual(['load-sdk', 'create-provider', 'evaluate']);
    });

    test('snapshots bounded state and criteria before awaiting the SDK', async () => {
      let release!: () => void;
      const loading = new Promise<void>((resolve) => { release = resolve; });
      const { port, sent } = sdkPort(route, undefined, () => loading);
      const state = { details: ['small'] };
      const given = {
        q: { type: 'choice' as const, instructions: 'Pick one.', criteria: { a: 'Small.', b: 'Large.' } },
      };
      const pending = port.evaluate(call(state, given));
      state.details[0] = 'x'.repeat(40_000);
      given.q.criteria.a = 'y'.repeat(40_000);
      release();
      await pending;
      expect(JSON.stringify(sent).length).toBeLessThan(500);
      expect(sent).toEqual([{
        state: { details: ['small'] },
        questions: {
          q: { type: 'choice', instructions: 'Pick one.', criteria: { a: 'Small.', b: 'Large.' } },
        },
      }]);
    });
  });
}

test('gateway keeps its supported nullable score levels and one-sided boolean criteria', async () => {
  const { port, effects } = sdkPort('gateway');
  await port.evaluate(call('s', {
    effort: { type: 'score', instructions: 'Rate the effort.', criteria: ['low', null, 'high'] },
    urgent: { type: 'boolean', instructions: 'Is it urgent?', criteria: { true: 'Due today.' } },
  }));
  expect(effects).toEqual(['load-sdk', 'create-provider', 'evaluate']);
});
