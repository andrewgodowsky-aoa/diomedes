/**
 * The evaluation ports against the SDK that is actually installed.
 *
 * `tests/evaluation-adapter.test.ts` proves the port logic against a fake SDK.
 * A fake cannot prove the fake is right, and it was not: the installed
 * `ai@7.0.107` has no `evaluate` export, only `experimental_evaluate`, so the
 * gateway port's call was `undefined` at runtime while every test passed. This
 * file loads the real `ai`, `@ai-sdk/gateway` (through `ai.createGateway`) and
 * `@openrouter/ai-sdk-provider`, and replaces only `fetch`, so what is
 * asserted is the exact request the installed packages would put on the wire.
 *
 * No network, no key, no spend: every credential here is invented and every
 * reply comes from the fake fetch below.
 */
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import * as ai from 'ai';
import {
  EvaluationTransportError,
  evaluationSdkFrom,
  gatewayEvaluationPort,
  normalizeSdkEvaluation,
  openRouterEvaluationPort,
  runEvaluation,
  serializedRequestTokens,
  providerQuestions,
  scriptedEvaluationPort,
  TYPESAFE_DOCUMENTED_LIMITS,
  UNPROVEN_ROUTE_LIMITS,
} from '../server/harness/evaluation-adapter.js';
import {
  booleanQuestion,
  choiceQuestion,
  evaluationProfile,
  scoreQuestion,
} from '../shared/evaluation.js';

const AT = '2026-09-23T09:00:00.000Z';

interface Seen {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

/** A fetch that records the request and answers from a script. */
function fakeFetch(replies: { status?: number; body: unknown }[]) {
  const seen: Seen[] = [];
  const fetch = async (url: unknown, init?: RequestInit) => {
    seen.push({
      url: String(url),
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
      body: JSON.parse(String(init?.body ?? 'null')) as Record<string, unknown>,
    });
    const reply = replies[Math.min(seen.length - 1, replies.length - 1)];
    return new Response(JSON.stringify(reply.body), {
      status: reply.status ?? 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  return { fetch, seen };
}

const profile = () =>
  evaluationProfile({
    profileId: 'conformance',
    revision: 1,
    purpose: 'thread-preparation',
    questions: [
      choiceQuestion({
        id: 'workload',
        instructions: 'What kind of work is this?',
        options: [
          { id: 'extraction', description: 'Extract from given material' },
          { id: 'planning', description: 'Plan several steps' },
        ],
      }),
      booleanQuestion({ id: 'needs-review', instructions: 'Would a second check help?' }),
    ],
  });

const gatewayReply = {
  answers: {
    workload: { type: 'choice', choice: 'planning', probabilities: { extraction: 0.2, planning: 0.8 } },
    'needs-review': { type: 'boolean', probability: 0.35 },
  },
  usage: { inputTokens: 120 },
};

let savedGateway: string | undefined;
let savedOpenRouter: string | undefined;
beforeEach(() => {
  savedGateway = process.env.AI_GATEWAY_API_KEY;
  savedOpenRouter = process.env.OPENROUTER_API_KEY;
  // Somebody else's keys sit in the environment for every test here. A port
  // that reads them would select a payer nobody admitted, and the assertions on
  // the Authorization header below would catch it.
  process.env.AI_GATEWAY_API_KEY = 'ambient-gateway-key';
  process.env.OPENROUTER_API_KEY = 'ambient-openrouter-key';
});
afterEach(() => {
  if (savedGateway === undefined) delete process.env.AI_GATEWAY_API_KEY;
  else process.env.AI_GATEWAY_API_KEY = savedGateway;
  if (savedOpenRouter === undefined) delete process.env.OPENROUTER_API_KEY;
  else process.env.OPENROUTER_API_KEY = savedOpenRouter;
});

describe('the installed ai package', () => {
  test('exports evaluation as experimental_evaluate, and not as evaluate', () => {
    const module = ai as unknown as Record<string, unknown>;
    expect(typeof module.experimental_evaluate).toBe('function');
    expect(module.evaluate).toBeUndefined();
    expect(typeof module.createGateway).toBe('function');
  });

  test('is resolved by the port loader through the export that exists', () => {
    const sdk = evaluationSdkFrom(ai as unknown as Record<string, unknown>);
    expect(sdk.evaluate).toBe((ai as unknown as Record<string, unknown>).experimental_evaluate);
  });

  test('an SDK with no evaluation export is refused as unavailable, before anything is sent', () => {
    expect(() => evaluationSdkFrom({ createGateway: () => null })).toThrow(EvaluationTransportError);
    try {
      evaluationSdkFrom({ createGateway: () => null });
    } catch (error) {
      expect((error as EvaluationTransportError).code).toBe('transport_unavailable');
    }
  });
});

describe('the gateway port on the installed SDK', () => {
  test('posts one request to the evaluation endpoint with the explicit key and our own ids', async () => {
    const { fetch, seen } = fakeFetch([{ body: gatewayReply }]);
    const port = gatewayEvaluationPort({ apiKey: 'admitted-key', modelId: 'typesafe-ai/jev', fetch });
    const observed = await runEvaluation({
      port,
      profile: profile(),
      state: { intent: 'plan the week' },
      signal: new AbortController().signal,
      observedAt: AT,
    });
    expect(seen).toHaveLength(1);
    expect(seen[0].url).toMatch(/\/evaluation-model$/);
    expect(seen[0].headers.authorization).toBe('Bearer admitted-key');
    expect(seen[0].headers['ai-model-id']).toBe('typesafe-ai/jev');
    expect(seen[0].body.state).toEqual({ intent: 'plan the week' });
    expect(seen[0].body.questions).toEqual(providerQuestions(profile()));
    expect(observed.answers.map((a) => a.questionId)).toEqual(['workload', 'needs-review']);
    expect(observed.usage).toEqual({ inputTokens: 120, outputTokens: null });
  });

  test('does not confirm a model the gateway never reported', async () => {
    // The SDK and the gateway both fill response.modelId with the requested
    // alias. The body carries no model, so the observation must not either.
    const { fetch } = fakeFetch([{ body: gatewayReply }]);
    const port = gatewayEvaluationPort({ apiKey: 'k', modelId: 'jev-1.13.0', fetch });
    const observed = await runEvaluation({
      port,
      profile: profile(),
      state: 's',
      signal: new AbortController().signal,
      observedAt: AT,
    });
    expect(observed.requestedModel).toBe('jev-1.13.0');
    expect(observed.actualModel).toBeNull();
  });

  test('makes exactly one attempt on a retryable failure, because retries are the host to count', async () => {
    const { fetch, seen } = fakeFetch([{ status: 503, body: { error: { message: 'busy' } } }]);
    const port = gatewayEvaluationPort({ apiKey: 'k', modelId: 'typesafe-ai/jev', fetch });
    await expect(
      runEvaluation({
        port,
        profile: profile(),
        state: 's',
        signal: new AbortController().signal,
        observedAt: AT,
      }),
    ).rejects.toBeTruthy();
    expect(seen).toHaveLength(1);
  });

  test('the SDK left to its default would have tried three times, which is why the port says zero', async () => {
    const { fetch, seen } = fakeFetch([{ status: 503, body: { error: { message: 'busy' } } }]);
    const gateway = ai.createGateway({ apiKey: 'k', fetch });
    await expect(
      ai.experimental_evaluate({
        model: gateway.evaluationModel('typesafe-ai/jev'),
        state: 's',
        questions: { q: { type: 'boolean', instructions: 'i' } },
      }),
    ).rejects.toBeTruthy();
    expect(seen).toHaveLength(3);
  }, 20_000);

  test('an answer the SDK itself refuses loses its usage at the SDK, so it is not answer_rejected', async () => {
    // The SDK validates before returning and throws without the usage. The
    // port cannot recover a figure the SDK discarded; the advisor therefore
    // treats any failure after dispatch as uncertain consumption.
    const { fetch, seen } = fakeFetch([
      {
        body: {
          answers: {
            workload: { type: 'choice', choice: 'invented-option' },
            'needs-review': { type: 'boolean', probability: 0.5 },
          },
          usage: { inputTokens: 99 },
        },
      },
    ]);
    const port = gatewayEvaluationPort({ apiKey: 'k', modelId: 'typesafe-ai/jev', fetch });
    const error = await runEvaluation({
      port,
      profile: profile(),
      state: 's',
      signal: new AbortController().signal,
      observedAt: AT,
    }).then(
      () => null,
      (caught: unknown) => caught,
    );
    expect(seen).toHaveLength(1);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(EvaluationTransportError);
  });

  test('stops at cancellation', async () => {
    const controller = new AbortController();
    const fetch = (_url: unknown, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal!.reason));
      });
    const port = gatewayEvaluationPort({ apiKey: 'k', modelId: 'typesafe-ai/jev', fetch });
    const pending = runEvaluation({
      port,
      profile: profile(),
      state: 's',
      signal: controller.signal,
      observedAt: AT,
    });
    controller.abort(new Error('the person moved on'));
    await expect(pending).rejects.toThrow();
  });
});

describe('the OpenRouter port on the installed provider', () => {
  const reply = {
    id: 'gen-123',
    model: 'typesafe/jev-1.13',
    answers: {
      workload: { type: 'choice', choice: 'planning', probabilities: { extraction: 0.1, planning: 0.9 }, confidence: 0.99 },
      'needs-review': { type: 'noul', noul: 0.2 },
    },
    usage: { input_tokens: 80, output_tokens: 3, cost: 0.0000034 },
  };

  test('sends a boolean as noul, with the explicit key, to the Decisions endpoint', async () => {
    const { fetch, seen } = fakeFetch([{ body: reply }]);
    const port = openRouterEvaluationPort({ apiKey: 'admitted-key', modelId: 'typesafe/jev-1.13', fetch });
    await runEvaluation({
      port,
      profile: profile(),
      state: 's',
      signal: new AbortController().signal,
      observedAt: AT,
    });
    expect(seen).toHaveLength(1);
    expect(seen[0].url).toBe('https://openrouter.ai/api/alpha/decisions');
    expect(seen[0].headers.authorization).toBe('Bearer admitted-key');
    expect(seen[0].body.model).toBe('typesafe/jev-1.13');
    const questions = seen[0].body.questions as Record<string, { type: string }>;
    expect(questions['needs-review'].type).toBe('noul');
    expect(questions.workload.type).toBe('choice');
  });

  test('keeps the reported model and request id, reads noul back as P(true), and drops confidence', async () => {
    const { fetch } = fakeFetch([{ body: reply }]);
    const port = openRouterEvaluationPort({ apiKey: 'k', modelId: 'typesafe/jev-1.13', fetch });
    const observed = await runEvaluation({
      port,
      profile: profile(),
      state: 's',
      signal: new AbortController().signal,
      observedAt: AT,
    });
    expect(observed.actualModel).toBe('typesafe/jev-1.13');
    expect(observed.providerRequestId).toBe('gen-123');
    expect(observed.usage).toEqual({ inputTokens: 80, outputTokens: 3 });
    const review = observed.answers.find((a) => a.questionId === 'needs-review');
    expect(review).toEqual({ type: 'boolean', questionId: 'needs-review', probability: 0.2 });
    // The provider's per-answer "confidence" never reaches the observation.
    expect(JSON.stringify(observed)).not.toMatch(/confidence/);
  });

  test('refuses before I/O the two shapes the installed provider would throw on', async () => {
    const { fetch, seen } = fakeFetch([{ body: reply }]);
    const port = openRouterEvaluationPort({ apiKey: 'k', modelId: 'typesafe/jev-1.13', fetch });
    const oneSided = evaluationProfile({
      profileId: 'one-sided',
      revision: 1,
      purpose: 'thread-preparation',
      questions: [booleanQuestion({ id: 'b', instructions: 'i', whenTrue: 'yes' })],
    });
    const unlabeled = evaluationProfile({
      profileId: 'unlabeled',
      revision: 1,
      purpose: 'thread-preparation',
      questions: [scoreQuestion({ id: 's', instructions: 'i', levels: ['low', null] })],
    });
    for (const shape of [oneSided, unlabeled])
      await expect(
        runEvaluation({ port, profile: shape, state: 's', signal: new AbortController().signal, observedAt: AT }),
      ).rejects.toMatchObject({ code: 'unsupported_question_type' });
    expect(seen).toHaveLength(0);
  });

  test('refuses to be built without a key rather than reading OPENROUTER_API_KEY', () => {
    expect(() => openRouterEvaluationPort({ apiKey: '', modelId: 'typesafe/jev-1.13' })).toThrow(
      EvaluationTransportError,
    );
  });
});

describe('the whole-request bound', () => {
  test('counts the questions, not only the state', () => {
    const questions = providerQuestions(profile());
    const small = serializedRequestTokens('s', questions);
    expect(small.total).toBeGreaterThan(serializedRequestTokens('s', {}).total);
    expect(small.statePlusLongestQuestion).toBeGreaterThan(1);
  });

  test('refuses a batch whose questions push a fitting state over the total, before I/O', async () => {
    const { fetch, seen } = fakeFetch([{ body: gatewayReply }]);
    const port = gatewayEvaluationPort({ apiKey: 'k', modelId: 'typesafe-ai/jev', fetch });
    // The state alone fits the 32k state bound; with 20 long questions the
    // complete request does not.
    const state = 'x'.repeat(28_000 * 3);
    const questions = Array.from({ length: 20 }, (_v, i) =>
      booleanQuestion({ id: `q${i}`, instructions: 'y'.repeat(3_900) }),
    );
    const heavy = evaluationProfile({
      profileId: 'heavy',
      revision: 1,
      purpose: 'thread-preparation',
      questions,
    });
    const error = await runEvaluation({
      port,
      profile: heavy,
      state,
      signal: new AbortController().signal,
      observedAt: AT,
    }).then(
      () => null,
      (caught: EvaluationTransportError) => caught,
    );
    expect(error?.code).toBe('request_too_large');
    expect(seen).toHaveLength(0);
  });

  test('refuses a state plus its longest question over the pair bound, before I/O', async () => {
    // A route with the documented 64k total, so only the 32k pair bound can refuse.
    const scripted = scriptedEvaluationPort({ result: gatewayReply });
    const port = { ...scripted, limits: TYPESAFE_DOCUMENTED_LIMITS };
    const seen = scripted.calls;
    const state = 'x'.repeat((UNPROVEN_ROUTE_LIMITS.maxStatePlusLongestQuestionTokens - 500) * 3);
    const long = evaluationProfile({
      profileId: 'long',
      revision: 1,
      purpose: 'thread-preparation',
      questions: [booleanQuestion({ id: 'q', instructions: 'z'.repeat(3_999) })],
    });
    const error = await runEvaluation({
      port,
      profile: long,
      state,
      signal: new AbortController().signal,
      observedAt: AT,
    }).then(
      () => null,
      (caught: EvaluationTransportError) => caught,
    );
    expect(error?.code).toBe('request_too_large');
    expect(error?.message).toMatch(/longest question/);
    expect(seen).toHaveLength(0);
  });
});

describe('normalizing an SDK result', () => {
  test('keeps what a provider reported and nothing the SDK filled in', () => {
    const normalized = normalizeSdkEvaluation({
      answers: { q: { type: 'boolean', probability: 0.4 } },
      usage: { inputTokens: undefined, outputTokens: undefined, totalTokens: undefined },
      warnings: [],
      response: { modelId: 'the-requested-alias', timestamp: new Date(), body: {} },
    }) as { response: Record<string, unknown>; usage: Record<string, unknown> };
    expect(normalized.response).toEqual({});
    expect(normalized.usage).toEqual({ inputTokens: undefined, outputTokens: undefined });
  });
});
