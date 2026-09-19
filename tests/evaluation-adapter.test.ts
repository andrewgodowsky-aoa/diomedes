/**
 * The evaluation transport, proven without a network and without the SDK.
 *
 * The provider is injected here for the same reason it is injected in the
 * native loop: a transport that can only be exercised by paying for it cannot
 * be tested, and a contract nobody can test is a contract nobody keeps. These
 * tests pin the four things that would otherwise cost real money to discover —
 * that retries are ours and not the SDK's, that the key is passed and never
 * inherited, that an oversized or unsupported question is refused before any
 * I/O, and that a scripted answer is never attributed to a model.
 *
 * Every fixture is invented. No provider is contacted by this file.
 */
import { describe, expect, test, vi } from 'vitest';
import {
  EVALUATION_ROUTE_LIMITS,
  EvaluationTransportError,
  gatewayEvaluationPort,
  providerQuestions,
  runEvaluation,
  scriptedEvaluationPort,
  serializedStateTokens,
} from '../server/harness/evaluation-adapter.js';
import {
  booleanQuestion,
  choiceQuestion,
  evaluationProfile,
  scoreQuestion,
} from '../shared/evaluation.js';

const AT = '2026-09-19T09:00:00.000Z';

const profile = () =>
  evaluationProfile({
    profileId: 'thread-preparation.source-relevance',
    revision: 1,
    purpose: 'thread-preparation',
    questions: [
      choiceQuestion({
        id: 'most-relevant',
        instructions: 'Which source answers the question?',
        options: [
          { id: 'src-a', description: 'Current invoice' },
          { id: 'src-b', description: null },
        ],
      }),
      scoreQuestion({
        id: 'ambiguity',
        instructions: 'How ambiguous?',
        levels: ['clear', 'somewhat', 'very'],
      }),
      booleanQuestion({ id: 'needs-history', instructions: 'Needs a prior period?' }),
    ],
  });

const answer = {
  answers: {
    'most-relevant': { type: 'choice', choice: 'src-a' },
    ambiguity: { type: 'score', score: 1 },
    'needs-history': { type: 'boolean', probability: 0.8 },
  },
  usage: { inputTokens: 900 },
  warnings: [],
  response: { modelId: 'jev-1.13.0' },
};

// --- turning our questions into the provider's --------------------------------

describe('the question conversion', () => {
  test('sends a choice as a criteria map keyed by our own candidate ids', () => {
    const questions = providerQuestions(profile());
    expect(questions['most-relevant']).toEqual({
      type: 'choice',
      instructions: 'Which source answers the question?',
      criteria: { 'src-a': 'Current invoice', 'src-b': null },
    });
  });

  test('sends a score as an ordered array of levels, indexed from zero', () => {
    expect(providerQuestions(profile()).ambiguity).toEqual({
      type: 'score',
      instructions: 'How ambiguous?',
      criteria: ['clear', 'somewhat', 'very'],
    });
  });

  test('sends a boolean without inventing criteria it was not given', () => {
    expect(providerQuestions(profile())['needs-history']).toEqual({
      type: 'boolean',
      instructions: 'Needs a prior period?',
    });
  });

  test('keys every question by the id the answer will be validated against', () => {
    expect(Object.keys(providerQuestions(profile())).sort()).toEqual([
      'ambiguity',
      'most-relevant',
      'needs-history',
    ]);
  });
});

// --- refusing before any I/O --------------------------------------------------

describe('a call that must not be made', () => {
  test('is refused when the route does not support a question type it was given', async () => {
    const port = scriptedEvaluationPort({ result: answer, supports: ['boolean'] });
    await expect(
      runEvaluation({ port, profile: profile(), state: 'x', signal: new AbortController().signal, observedAt: AT }),
    ).rejects.toMatchObject({ code: 'unsupported_question_type' });
    expect(port.calls).toHaveLength(0);
  });

  test('is refused when the serialized state exceeds the route limit', async () => {
    const port = scriptedEvaluationPort({ result: answer });
    const huge = 'x'.repeat(EVALUATION_ROUTE_LIMITS.maxStateTokens * 8);
    await expect(
      runEvaluation({ port, profile: profile(), state: huge, signal: new AbortController().signal, observedAt: AT }),
    ).rejects.toMatchObject({ code: 'state_too_large' });
    expect(port.calls).toHaveLength(0);
  });

  test('uses the route-specific limit, not the largest number in the provider docs', () => {
    // The native model documents a 64k aggregate; a route is only proven to the
    // limit it was actually tested at, which is the smaller shared-state bound.
    expect(EVALUATION_ROUTE_LIMITS.maxStateTokens).toBeLessThanOrEqual(32_000);
  });

  test('estimates state size conservatively, never optimistically', () => {
    // Four characters per token would under-count a dense payload; three is the
    // bound this route reserves against.
    expect(serializedStateTokens('x'.repeat(300))).toBeGreaterThanOrEqual(100);
  });
});

// --- what a completed call produces -------------------------------------------

describe('a completed evaluation', () => {
  test('returns a validated observation bound to the profile it answered', async () => {
    const port = scriptedEvaluationPort({ result: answer });
    const observed = await runEvaluation({
      port,
      profile: profile(),
      state: 'the synthetic project',
      signal: new AbortController().signal,
      observedAt: AT,
    });
    expect(observed.profileId).toBe('thread-preparation.source-relevance');
    expect(observed.actualModel).toBe('jev-1.13.0');
    expect(observed.answers).toHaveLength(3);
  });

  test('passes one shared state and the questions, and nothing else', async () => {
    const port = scriptedEvaluationPort({ result: answer });
    await runEvaluation({
      port,
      profile: profile(),
      state: 'the synthetic project',
      signal: new AbortController().signal,
      observedAt: AT,
    });
    expect(port.calls[0].state).toBe('the synthetic project');
    expect(Object.keys(port.calls[0].questions)).toHaveLength(3);
  });

  test('refuses a malformed provider answer instead of consuming part of it', async () => {
    const port = scriptedEvaluationPort({
      result: { ...answer, answers: { 'most-relevant': { type: 'choice', choice: 'src-a' } } },
    });
    await expect(
      runEvaluation({ port, profile: profile(), state: 'x', signal: new AbortController().signal, observedAt: AT }),
    ).rejects.toMatchObject({ name: 'EvaluationContractError' });
  });

  test('propagates cancellation rather than finishing a call nobody is waiting for', async () => {
    const controller = new AbortController();
    controller.abort();
    const port = scriptedEvaluationPort({ result: answer });
    await expect(
      runEvaluation({ port, profile: profile(), state: 'x', signal: controller.signal, observedAt: AT }),
    ).rejects.toThrow();
    expect(port.calls).toHaveLength(0);
  });
});

// --- the gateway port ---------------------------------------------------------

describe('the Vercel gateway port', () => {
  const sdk = () => {
    const evaluate = vi.fn(async (_options: Record<string, unknown>) => answer);
    const createGateway = vi.fn((_settings: Record<string, unknown>) => ({
      evaluationModel: (id: string) => ({ specificationVersion: 'v4', modelId: id }),
    }));
    return { module: { evaluate, createGateway }, evaluate, createGateway };
  };

  test('disables the SDK retry budget, because attempts are the run service to count', async () => {
    const { module, evaluate } = sdk();
    const port = gatewayEvaluationPort({
      apiKey: 'test-key',
      modelId: 'typesafe-ai/jev',
      loadSdk: async () => module,
    });
    await port.evaluate({ state: 'x', questions: {}, signal: new AbortController().signal });
    expect(evaluate.mock.calls[0][0]).toMatchObject({ maxRetries: 0 });
  });

  test('passes the key explicitly, so an ambient environment variable cannot select a payer', async () => {
    const { module, createGateway } = sdk();
    const previous = process.env.AI_GATEWAY_API_KEY;
    process.env.AI_GATEWAY_API_KEY = 'somebody-elses-key';
    try {
      const port = gatewayEvaluationPort({
        apiKey: 'the-payer-we-admitted',
        modelId: 'typesafe-ai/jev',
        loadSdk: async () => module,
      });
      await port.evaluate({ state: 'x', questions: {}, signal: new AbortController().signal });
      expect(createGateway.mock.calls[0][0]).toMatchObject({ apiKey: 'the-payer-we-admitted' });
    } finally {
      if (previous === undefined) delete process.env.AI_GATEWAY_API_KEY;
      else process.env.AI_GATEWAY_API_KEY = previous;
    }
  });

  test('refuses to be built without a key rather than falling back to the environment', () => {
    expect(() =>
      gatewayEvaluationPort({ apiKey: '', modelId: 'typesafe-ai/jev', loadSdk: async () => sdk().module }),
    ).toThrow(EvaluationTransportError);
  });

  test('reports honestly when the SDK is not installed, rather than pretending to be offline', async () => {
    const port = gatewayEvaluationPort({
      apiKey: 'k',
      modelId: 'typesafe-ai/jev',
      loadSdk: async () => {
        throw new Error("Cannot find module 'ai'");
      },
    });
    await expect(
      port.evaluate({ state: 'x', questions: {}, signal: new AbortController().signal }),
    ).rejects.toMatchObject({ code: 'transport_unavailable' });
  });

  test('is not a scripted adapter, so its work is attributed to the model', () => {
    const port = gatewayEvaluationPort({
      apiKey: 'k',
      modelId: 'typesafe-ai/jev',
      loadSdk: async () => sdk().module,
    });
    expect(port.scripted).toBe(false);
  });
});

describe('the scripted port', () => {
  test('declares itself scripted, so a fixture is never attributed to a model', () => {
    expect(scriptedEvaluationPort({ result: answer }).scripted).toBe(true);
  });

  test('can fail on demand, so failure paths are testable without a provider', async () => {
    const port = scriptedEvaluationPort({ failWith: new Error('429 Too Many Requests') });
    await expect(
      port.evaluate({ state: 'x', questions: {}, signal: new AbortController().signal }),
    ).rejects.toThrow(/429/);
  });
});
