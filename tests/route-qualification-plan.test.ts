/**
 * The managed gateway's route checks (DIO-217) send the desktop's own check plan from a copy in
 * shared/route-qualification-plan.ts, because the Worker cannot import server/. Until the desktop
 * runner reads that copy too, every value in it must equal the desktop's, byte for byte.
 */
import { describe, expect, test } from 'vitest';
import * as shared from '../shared/route-qualification-plan.js';
import * as desktop from '../server/engines/route-qualification.js';

describe('the shared route check plan', () => {
  test('every question, limit and the cache prefix equal the desktop runner exactly', () => {
    const pairs: [string, unknown, unknown][] = [
      ['INSTRUCTIONS', shared.INSTRUCTIONS, desktop.INSTRUCTIONS],
      ['SHORT_ANSWER', shared.SHORT_ANSWER, desktop.SHORT_ANSWER],
      ['OUTPUT_BOUND_ASK', shared.OUTPUT_BOUND_ASK, desktop.OUTPUT_BOUND_ASK],
      ['TOOL_ASK', shared.TOOL_ASK, desktop.TOOL_ASK],
      ['TOOL_KEY', shared.TOOL_KEY, desktop.TOOL_KEY],
      ['TOOL_VALUE', shared.TOOL_VALUE, desktop.TOOL_VALUE],
      ['CHECK_OUTPUT_TOKENS', shared.CHECK_OUTPUT_TOKENS, desktop.CHECK_OUTPUT_TOKENS],
      ['OUTPUT_BOUND_TOKENS', shared.OUTPUT_BOUND_TOKENS, desktop.OUTPUT_BOUND_TOKENS],
      ['CACHE_PREFIX', shared.CACHE_PREFIX, desktop.CACHE_PREFIX],
    ];
    for (const [name, mine, theirs] of pairs) {
      expect(typeof mine, name).toBe(typeof theirs);
      expect(mine, name).toBe(theirs);
      expect(JSON.stringify(mine), name).toBe(JSON.stringify(theirs));
    }
    expect(shared.CHECK_OUTPUT_TOKENS).toBe(512);
    expect(shared.OUTPUT_BOUND_TOKENS).toBe(64);
  });

  test('the lookup_fact tool has the desktop tool name, description and parameters', () => {
    expect(Object.keys(shared.LOOKUP_FACT_TOOL).sort()).toEqual(['description', 'name', 'parameters']);
    expect(shared.LOOKUP_FACT_TOOL.name).toBe(desktop.LOOKUP_FACT.name);
    expect(shared.LOOKUP_FACT_TOOL.description).toBe(desktop.LOOKUP_FACT.description);
    expect(shared.LOOKUP_FACT_TOOL.parameters).toEqual(desktop.LOOKUP_FACT.inputSchema);
    // Byte for byte, key order included: the same schema bytes reach the provider either way.
    expect(JSON.stringify(shared.LOOKUP_FACT_TOOL.parameters)).toBe(JSON.stringify(desktop.LOOKUP_FACT.inputSchema));
  });

  test('the shared plan is frozen, so nothing in the Worker can change it at run time', () => {
    expect(Object.isFrozen(shared.LOOKUP_FACT_TOOL)).toBe(true);
    expect(Object.isFrozen(shared.LOOKUP_FACT_TOOL.parameters)).toBe(true);
    expect(Object.isFrozen(shared.LOOKUP_FACT_TOOL.parameters.properties)).toBe(true);
    expect(Object.isFrozen(shared.LOOKUP_FACT_TOOL.parameters.required)).toBe(true);
  });
});
