import { describe, expect, test } from 'vitest';
import fs from 'node:fs';
import { ROUTE_CONTRACTS } from '../server/harness/route-contract.js';

/**
 * Every route that declares thinking has a producer test that drives it from recorded frames.
 * A route that flips to `reasoning-delta` without one fails here; one that produces thinking while
 * declaring `none` never receives the sink (EngineService, tests/live-reasoning-server.test.ts).
 *
 * The model-API routes are held to `MODEL_API_REASONING` by running them, not by a file search:
 * tests/model-api-thinking.test.ts drives every model-API route's own adapter with a thinking sink
 * exactly where `modelSession` hands one, and tests/model-session-activity.test.ts runs whole
 * conversations on OpenRouter and AWS Bedrock.
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

});
