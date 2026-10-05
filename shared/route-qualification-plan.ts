/**
 * The route checks' fixed plan: the same questions, limits, tool and cache prefix the desktop's
 * own-key checks send (server/engines/route-qualification.ts), for the managed gateway's route
 * checks (services/control-plane/src/route-checks.ts, DIO-217).
 *
 * The Worker cannot import server/, so this is a copy until both lanes land and the desktop runner
 * reads it from here. tests/route-qualification-plan.test.ts holds every value equal to the
 * desktop's, byte for byte, so the two cannot drift apart in the meantime.
 *
 * Dependency-free on purpose: the Worker bundle loads it. The prompts are fixed and carry no
 * person's content.
 */

/** Every check call's instructions, except the cache checks', which send the cache prefix instead. */
export const INSTRUCTIONS = 'This is an automated route check. Follow the request exactly and keep the answer short.';
/** The short-answer question. The cache checks ask it too, after the cache prefix. */
export const SHORT_ANSWER = 'Reply with the single word OK.';
/** A question built to provoke long reasoning, sent under the output bound's own small limit. */
export const OUTPUT_BOUND_ASK =
  'Think step by step. Factor 9699690 into primes, then list every factor pair of 9699690, showing all of your work for each pair.';
/** The tool round trip's first question. */
export const TOOL_ASK = 'Use the lookup_fact tool to look up the key alpha. Then reply with the value it returns and nothing else.';
/** The one argument the tool round trip accepts. */
export const TOOL_KEY = 'alpha';
/** What the tool returns, and what the answer must then contain. */
export const TOOL_VALUE = 'blue-42';
/** Every check call's output limit, except the output bound's own. */
export const CHECK_OUTPUT_TOKENS = 512;
/** The output limit the output-bound check is sent with. */
export const OUTPUT_BOUND_TOKENS = 64;

/** The one tool the round trip offers: a read with one string argument, run by nobody but the check. */
export const LOOKUP_FACT_TOOL = Object.freeze({
  name: 'lookup_fact',
  description: 'Look up the value stored under one key.',
  parameters: Object.freeze({
    type: 'object',
    properties: Object.freeze({ key: Object.freeze({ type: 'string' }) }),
    required: Object.freeze(['key']),
    additionalProperties: false,
  }),
});

/**
 * The cache checks' stable prefix: neutral numbered bookkeeping rules, the same bytes every time.
 * About 6,100 bytes, which is about 1,530 tokens at four bytes a token, well above the 1,024-token
 * minimum before providers cache a prefix, so a check that sees no cache cannot be explained by a
 * short prefix.
 */
export const CACHE_PREFIX = [
  'Reference rules for an automated route check. Read them, then answer the request that follows.',
  ...Array.from(
    { length: 56 },
    (_, index) =>
      `Rule ${index + 1}: record entry ${index + 1} in the ledger with its date, its amount and the name of the person who entered it.`,
  ),
].join('\n');
