/**
 * Vertex usage is normalized once and priced once. Gemini's promptTokenCount
 * already includes cachedContentTokenCount, and thoughtsTokenCount sits beside
 * candidatesTokenCount, so the one normalization is:
 *
 *   input = prompt + toolUsePrompt   cacheRead = cached   cacheWrite = 0
 *   output = candidates + thoughts   reasoning = thoughts
 *
 * and the ledger's usageCost prices cached input at the cache rate and the rest
 * of input at the input rate. These tests prove neither cached input nor
 * reasoning is counted twice, and that the provider's own record is kept beside
 * the normalized one.
 */
import { describe, expect, test } from 'vitest';
import { classifyVertex, VERTEX_RATE_CARDS, vertexUsage } from '../server/engines/google-vertex.js';
import { usageCost, type ModelRateCard } from '../server/spend-exposure.js';

const GROSS = VERTEX_RATE_CARDS[0].card;
/** Google's page figures, used only to check arithmetic against the example the usage contract pins. */
const PAGE_INTRO: ModelRateCard = {
  ...GROSS,
  version: 'test:page-intro-figures',
  short: { input: 750_000, cacheRead: 75_000, cacheWrite: 750_000, output: 3_750_000 },
  long: { input: 750_000, cacheRead: 75_000, cacheWrite: 750_000, output: 3_750_000 },
};

describe('Gemini usage normalization', () => {
  test('the contract example: 1,000 prompt / 800 cached / 150 candidates / 50 thoughts', () => {
    const raw = { promptTokenCount: 1000, cachedContentTokenCount: 800, candidatesTokenCount: 150, thoughtsTokenCount: 50, totalTokenCount: 1200 };
    const usage = vertexUsage(raw)!;
    expect(usage).toEqual({ inputTokens: 1000, cacheReadTokens: 800, cacheWriteTokens: 0, outputTokens: 200, reasoningTokens: 50 });
    // 200 fresh x 0.75 + 800 cached x 0.075 + 200 output x 3.75 = 150 + 60 + 750.
    expect(usageCost(PAGE_INTRO, usage).microUsd).toBe(960);
    // The gross card the route actually settles at is exactly double.
    expect(usageCost(GROSS, usage).microUsd).toBe(1920);
  });

  test('fully cached input is priced at the cache rate only, never also as fresh input', () => {
    const usage = vertexUsage({ promptTokenCount: 1000, cachedContentTokenCount: 1000, candidatesTokenCount: 100, totalTokenCount: 1100 })!;
    expect(usage.cacheReadTokens).toBe(usage.inputTokens);
    expect(usageCost(GROSS, usage).microUsd).toBe(Math.ceil((1000 * 150_000 + 100 * 7_500_000) / 1_000_000));
  });

  test('uncached input carries no cache tokens', () => {
    const usage = vertexUsage({ promptTokenCount: 1000, candidatesTokenCount: 100, totalTokenCount: 1100 })!;
    expect(usage).toMatchObject({ inputTokens: 1000, cacheReadTokens: 0, outputTokens: 100, reasoningTokens: 0 });
    expect(usageCost(GROSS, usage).microUsd).toBe(Math.ceil((1000 * 1_500_000 + 100 * 7_500_000) / 1_000_000));
  });

  test('reasoning is part of output once: pricing reasoning-heavy output equals pricing the same total as plain output', () => {
    const thinking = vertexUsage({ promptTokenCount: 10, candidatesTokenCount: 5, thoughtsTokenCount: 95, totalTokenCount: 110 })!;
    const plain = vertexUsage({ promptTokenCount: 10, candidatesTokenCount: 100, totalTokenCount: 110 })!;
    expect(thinking.outputTokens).toBe(100);
    expect(thinking.reasoningTokens).toBe(95);
    expect(usageCost(GROSS, thinking).microUsd).toBe(usageCost(GROSS, plain).microUsd);
  });

  test('tool-use prompt tokens are input', () => {
    const usage = vertexUsage({ promptTokenCount: 100, toolUsePromptTokenCount: 20, candidatesTokenCount: 10, totalTokenCount: 130 })!;
    expect(usage.inputTokens).toBe(120);
  });

  test('missing or malformed usage is unknown, never zero', () => {
    expect(vertexUsage(undefined)).toBeNull();
    expect(vertexUsage({})).toBeNull();
    expect(vertexUsage({ promptTokenCount: -1, candidatesTokenCount: 1 })).toBeNull();
    expect(vertexUsage({ promptTokenCount: '10', candidatesTokenCount: 1 })).toBeNull();
    // A total that does not add up is a disagreement about money: refused, not repaired.
    expect(vertexUsage({ promptTokenCount: 10, candidatesTokenCount: 5, thoughtsTokenCount: 5, totalTokenCount: 15 })).toBeNull();
    // More cached than prompt cannot be normalized honestly.
    expect(vertexUsage({ promptTokenCount: 10, cachedContentTokenCount: 11, candidatesTokenCount: 1, totalTokenCount: 11 })).toBeNull();
  });

  test('the classified envelope keeps the provider record exactly as reported, beside the one normalization', () => {
    const raw = {
      promptTokenCount: 1000,
      cachedContentTokenCount: 800,
      candidatesTokenCount: 150,
      thoughtsTokenCount: 50,
      totalTokenCount: 1200,
      trafficType: 'ON_DEMAND',
      promptTokensDetails: [{ modality: 'TEXT', tokenCount: 1000 }],
    };
    const envelope = {
      status: 200,
      bytes: 1,
      body: null,
      events: [
        {
          candidates: [{ content: { role: 'model', parts: [{ text: 'DIOMEDES_VERTEX_OK' }] }, finishReason: 'STOP' }],
          usageMetadata: raw,
          modelVersion: 'gemini-3.8-flash',
          responseId: 'r-1',
        },
      ],
      readable: true,
      providerRequestId: null,
    };
    const { classified } = classifyVertex(envelope, 'vtx-norm');
    expect(classified!.usage).toEqual({ inputTokens: 1000, cacheReadTokens: 800, cacheWriteTokens: 0, outputTokens: 200, reasoningTokens: 50 });
    expect(classified!.rawUsage).toEqual(raw);
    expect(classified!.rawUsage).not.toBe(raw);
  });
});
