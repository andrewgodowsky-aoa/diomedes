import { describe, expect, test } from 'vitest';
import fs from 'node:fs';
import { ROUTE_CONTRACTS } from '../server/harness/route-contract.js';
import { MODEL_API_REASONING } from '../server/harness/model-api-adapter.js';

/**
 * Every route that declares thinking has a producer test that drives it from recorded frames.
 * A route that flips to `reasoning-delta` without one fails here; one that produces thinking while
 * declaring `none` never receives the sink (EngineService, tests/live-reasoning-server.test.ts).
 */
const PRODUCERS: Record<string, string> = {
  'claude-code': 'tests/claude-adapter.test.ts',
  'claude-code-session': 'tests/claude-session.test.ts',
  cursor: 'tests/acp-thought-chunks.test.ts',
  devin: 'tests/acp-thought-chunks.test.ts',
  'cursor-session': 'tests/acp-session.test.ts',
  'devin-session': 'tests/acp-session.test.ts',
  opencode: 'tests/opencode-session.test.ts',
  'opencode-session': 'tests/opencode-session.test.ts',
};

describe('thinking conformance', () => {
  test('the routes that declare thinking are exactly the ones with a producer test', () => {
    const declaring = Object.values(ROUTE_CONTRACTS)
      .filter((contract) => contract.streaming.reasoning === 'reasoning-delta')
      .map((contract) => contract.routeId)
      .sort();
    expect(declaring).toEqual(Object.keys(PRODUCERS).sort());
    for (const file of new Set(Object.values(PRODUCERS)))
      expect(fs.readFileSync(file, 'utf8')).toMatch(/onReasoningDelta/);
  });

  test('each model-API route that declares thinking has its provider test', () => {
    const TESTS: Record<string, string> = {
      'aws-bedrock': 'tests/aws-bedrock-transport.test.ts',
      'azure-openai': 'tests/azure-openai-model-api.test.ts',
      'google-vertex': 'tests/google-vertex-model-api.test.ts',
      openrouter: 'tests/openrouter-model-api.test.ts',
      nectovia: 'tests/nectovia-route.test.ts',
    };
    for (const [route, declared] of Object.entries(MODEL_API_REASONING))
      if (declared === 'reasoning-delta')
        expect(fs.readFileSync(TESTS[route], 'utf8'), route).toMatch(/onReasoningDelta/);
  });
});
