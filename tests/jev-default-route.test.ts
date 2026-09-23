/**
 * Jev runs through OpenRouter unless another route is named (owner decision
 * 2026-09-23). The real installed OpenRouter provider builds the request; only
 * the network is a fake, and no real key exists. The advisor stays off: nothing
 * here gives the host one.
 */
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import {
  DEFAULT_EVALUATION_ROUTE,
  DEFAULT_OPENROUTER_JEV_MODEL,
  jevEvaluationPort,
  runEvaluation,
} from '../server/harness/evaluation-adapter.js';
import { EVALUATION_PRICE_JEV_113_OPENROUTER, priceFor } from '../server/harness/evaluation-price.js';
import { booleanQuestion, choiceQuestion, evaluationProfile } from '../shared/evaluation.js';

const AT = '2026-09-23T09:00:00.000Z';

function fakeFetch(body: unknown) {
  const seen: { url: string; authorization: string | null; model: unknown }[] = [];
  const fetch = async (url: unknown, init?: RequestInit) => {
    const parsed = JSON.parse(String(init?.body ?? 'null')) as Record<string, unknown>;
    seen.push({ url: String(url), authorization: new Headers(init?.headers).get('authorization'), model: parsed.model });
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  return { fetch, seen };
}

const profile = () =>
  evaluationProfile({
    profileId: 'jev-default-route',
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

let saved: string | undefined;
beforeEach(() => {
  saved = process.env.OPENROUTER_API_KEY;
  process.env.OPENROUTER_API_KEY = 'ambient-openrouter-key';
});
afterEach(() => {
  if (saved === undefined) delete process.env.OPENROUTER_API_KEY;
  else process.env.OPENROUTER_API_KEY = saved;
});

describe('Jev’s default route', () => {
  test('is OpenRouter, asking Jev 1.13 as OpenRouter lists it, priced from what answered', async () => {
    expect(DEFAULT_EVALUATION_ROUTE).toBe('openrouter');
    expect(DEFAULT_OPENROUTER_JEV_MODEL).toBe(EVALUATION_PRICE_JEV_113_OPENROUTER.modelId);
    const { fetch, seen } = fakeFetch({
      id: 'gen-1',
      model: DEFAULT_OPENROUTER_JEV_MODEL,
      answers: {
        workload: { type: 'choice', choice: 'planning', probabilities: { extraction: 0.1, planning: 0.9 } },
        'needs-review': { type: 'noul', noul: 0.3 },
      },
      usage: { input_tokens: 50, output_tokens: 2 },
    });
    const port = jevEvaluationPort({ apiKey: 'admitted-key', fetch });
    expect(port.id).toBe('openrouter-evaluation');
    expect(port.requestedModel).toBe(DEFAULT_OPENROUTER_JEV_MODEL);
    const observed = await runEvaluation({
      port,
      profile: profile(),
      state: 's',
      signal: new AbortController().signal,
      observedAt: AT,
    });
    expect(seen).toEqual([
      { url: 'https://openrouter.ai/api/alpha/decisions', authorization: 'Bearer admitted-key', model: DEFAULT_OPENROUTER_JEV_MODEL },
    ]);
    expect(observed.actualModel).toBe(DEFAULT_OPENROUTER_JEV_MODEL);
    expect(priceFor(observed.actualModel)).toBe(EVALUATION_PRICE_JEV_113_OPENROUTER);
  });

  test('the Vercel AI Gateway is used only when named, and every route needs an explicit key', () => {
    expect(jevEvaluationPort({ route: 'vercel-gateway', apiKey: 'k', modelId: 'typesafe-ai/jev' }).id).toBe(
      'vercel-gateway-evaluation',
    );
    expect(() => jevEvaluationPort({ route: 'vercel-gateway', apiKey: 'k' })).toThrow(/Name the Jev model/);
    expect(() => jevEvaluationPort({ apiKey: '' })).toThrow(/explicit credential/);
  });
});
