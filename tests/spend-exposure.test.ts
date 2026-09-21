/**
 * The BYO spend-exposure ledger, proven against a real data folder.
 *
 * The claims under test: two concurrent holds cannot both fit where only one
 * does; a hold in flight when the process stops comes back uncertain and still
 * counted, so restarting refunds nothing; an uncertain hold is never released,
 * only reconciled or written off, and a written-off hold keeps its ceiling in
 * exposure; usage is priced in exact integer arithmetic, rounded up once, in
 * the band its input falls in; the pre-call ceiling is never below the real
 * cost of any call inside its bound; nothing is held without an approved cap,
 * and a lowered cap admits nothing new; the same attempt is never held twice;
 * a failed write leaves memory equal to disk; and a connection id cannot leave
 * its folder.
 *
 * Every connection, run and amount here is invented. The rate card has the
 * shape of a provider price list and is not a published price.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { micro, type MicroUsd } from '../shared/managed-usage.js';
import { digest } from '../server/harness/policy.js';
import {
  SpendExposure,
  SpendExposureError,
  ceilingCost,
  usageCost,
  validateRateCard,
  type ExposureAttempt,
  type ModelRateCard,
  type ProviderUsage,
} from '../server/spend-exposure.js';

const CARD: ModelRateCard = {
  version: 'aws-bedrock-luna-2026-09-21.1',
  route: 'aws-bedrock',
  modelId: 'us.openai.gpt-5.6-luna',
  source: 'Invented test figures in the shape of a provider price list.',
  shortContextMaxInputTokens: 272_000,
  short: { input: 220_000, cacheWrite: 275_000, cacheRead: 22_000, output: 1_320_000 },
  long: { input: 440_000, cacheWrite: 550_000, cacheRead: 44_000, output: 1_980_000 },
};

/**
 * Short band. noCache = 123,457 - 45,678 - 12,345 = 65,434.
 *   65,434 x   220,000 = 14,395,480,000
 *   45,678 x    22,000 =  1,004,916,000
 *   12,345 x   275,000 =  3,394,875,000
 *    7,891 x 1,320,000 = 10,416,120,000
 *   total 29,211,391,000 / 1,000,000 = 29,211.391, rounded up once: 29,212.
 * Rounding each term up separately would give 29,213.
 */
const MIXED_SHORT: ProviderUsage = {
  inputTokens: 123_457,
  cacheReadTokens: 45_678,
  cacheWriteTokens: 12_345,
  outputTokens: 7_891,
  reasoningTokens: 3_210,
};

/**
 * Short band, whole micro-USD. noCache = 10,000 - 3,000 - 2,000 = 5,000.
 *   5,000 x 220,000 + 3,000 x 22,000 + 2,000 x 275,000 + 500 x 1,320,000
 *   = 1,100,000,000 + 66,000,000 + 550,000,000 + 660,000,000 = 2,376,000,000
 *   / 1,000,000 = 2,376 exactly: nothing to round.
 */
const EXACT_SHORT: ProviderUsage = {
  inputTokens: 10_000,
  cacheReadTokens: 3_000,
  cacheWriteTokens: 2_000,
  outputTokens: 500,
  reasoningTokens: 200,
};

/**
 * Long band (300,000 > 272,000). noCache = 300,000 - 100,000 - 50,000 = 150,000.
 *   150,000 x 440,000 + 100,000 x 44,000 + 50,000 x 550,000 + 10,000 x 1,980,000
 *   = 66,000,000,000 + 4,400,000,000 + 27,500,000,000 + 19,800,000,000
 *   = 117,700,000,000 / 1,000,000 = 117,700.
 */
const MIXED_LONG: ProviderUsage = {
  inputTokens: 300_000,
  cacheReadTokens: 100_000,
  cacheWriteTokens: 50_000,
  outputTokens: 10_000,
  reasoningTokens: 4_000,
};

const plain = (inputTokens: number, outputTokens = 0): ProviderUsage => ({
  inputTokens,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  outputTokens,
  reasoningTokens: 0,
});

const CONNECTION = 'acme-bedrock';
const START = new Date('2026-09-21T09:00:00.000Z');
const SWEEP_REASON = 'The process stopped while this call may have been in flight.';
const OWNER = { approvedBy: 'owner@acme.example', note: 'First Bedrock trial.' };

let dataDir = '';
let now = START;
const clock = () => now;
const advance = (ms: number) => {
  now = new Date(now.getTime() + ms);
};

beforeEach(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'spend-exposure-'));
  now = START;
});

afterEach(async () => {
  if (dataDir) await fs.rm(dataDir, { recursive: true, force: true });
  dataDir = '';
});

async function open(): Promise<SpendExposure> {
  const ledger = new SpendExposure(dataDir, { clock });
  await ledger.init();
  return ledger;
}

const connectionFile = (connectionId = CONNECTION) =>
  path.join(dataDir, 'spend-exposure', `${connectionId}.json`);

const attempt = (stepId = 'step-1', number = 1): ExposureAttempt => ({
  runId: 'run-1',
  stepId,
  attempt: number,
  requestDigest: createHash('sha256').update(`${stepId}:${number}`).digest('hex'),
});

type ReserveInput = Parameters<SpendExposure['reserve']>[0];
const reserveInput = (over: Partial<ReserveInput> = {}): ReserveInput => ({
  connectionId: CONNECTION,
  route: CARD.route,
  modelId: CARD.modelId,
  card: CARD,
  attempt: attempt(),
  maxMicroUsd: micro(100_000),
  ...over,
});

const approve = (ledger: SpendExposure, cap = 1_000_000) =>
  ledger.setCap(CONNECTION, micro(cap), OWNER);

/** The refusal code a synchronous call throws. */
function refusalOf(call: () => unknown): string {
  try {
    call();
  } catch (error) {
    if (error instanceof SpendExposureError) return error.code;
    throw error;
  }
  throw new Error('Expected a refusal, and the call succeeded.');
}

/** A deterministic stream of 32-bit numbers (xorshift32), so every run checks the same usages. */
function numbers(seed: number) {
  let state = seed >>> 0 || 1;
  return (limit: number) => {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return limit <= 0 ? 0 : state % (limit + 1);
  };
}

describe('pricing', () => {
  it('accepts a rate card of whole micro-USD rates and refuses anything else', () => {
    expect(validateRateCard(CARD)).toEqual(CARD);
    const broken: unknown[] = [
      { ...CARD, short: { ...CARD.short, input: 220_000.5 } },
      { ...CARD, long: { ...CARD.long, output: -1 } },
      { ...CARD, long: { ...CARD.long, cacheRead: Number.NaN } },
      { ...CARD, shortContextMaxInputTokens: 0 },
      { ...CARD, shortContextMaxInputTokens: 272_000.5 },
      { ...CARD, version: '' },
      { ...CARD, short: undefined },
      null,
    ];
    for (const card of broken)
      expect(refusalOf(() => validateRateCard(card as ModelRateCard))).toBe('invalid_rate_card');
  });

  it('prices short-band usage exactly and rounds up once at the end', () => {
    expect(usageCost(CARD, MIXED_SHORT)).toEqual({ microUsd: 29_212, band: 'short' });
    expect(usageCost(CARD, EXACT_SHORT)).toEqual({ microUsd: 2_376, band: 'short' });
    // One more output token adds 1.32 micro-USD: 2,377.32, rounded up to 2,378.
    expect(usageCost(CARD, { ...EXACT_SHORT, outputTokens: 501 })).toEqual({
      microUsd: 2_378,
      band: 'short',
    });
  });

  it('prices usage past 272,000 input tokens at the long band', () => {
    // 272,000 x 220,000 / 1,000,000 = 59,840, still short: the boundary is inclusive.
    expect(usageCost(CARD, plain(272_000))).toEqual({ microUsd: 59_840, band: 'short' });
    // 272,001 x 440,000 / 1,000,000 = 119,680.44, rounded up to 119,681.
    expect(usageCost(CARD, plain(272_001))).toEqual({ microUsd: 119_681, band: 'long' });
    expect(usageCost(CARD, MIXED_LONG)).toEqual({ microUsd: 117_700, band: 'long' });
  });

  it('refuses usage whose parts do not add up', () => {
    const broken: unknown[] = [
      { ...EXACT_SHORT, cacheReadTokens: 8_000, cacheWriteTokens: 2_001 },
      { ...EXACT_SHORT, reasoningTokens: 501 },
      { ...EXACT_SHORT, inputTokens: -1 },
      { ...EXACT_SHORT, outputTokens: 500.5 },
      { ...EXACT_SHORT, reasoningTokens: undefined },
      null,
    ];
    for (const usage of broken)
      expect(refusalOf(() => usageCost(CARD, usage as ProviderUsage))).toBe('invalid_usage');
  });

  it('never holds less than a call inside its bound can cost', () => {
    // Every input token at the dearest short input rate, the cache write:
    // 200,000 x 275,000 + 8,000 x 1,320,000 = 65,560,000,000 -> 65,560.
    const short = { maxInputTokens: 200_000, maxOutputTokens: 8_000 };
    expect(ceilingCost(CARD, short)).toBe(65_560);
    // All cache writes is dearer than plain input, and exactly meets the ceiling.
    const allCacheWrite: ProviderUsage = {
      inputTokens: 200_000,
      cacheReadTokens: 0,
      cacheWriteTokens: 200_000,
      outputTokens: 8_000,
      reasoningTokens: 0,
    };
    expect(usageCost(CARD, allCacheWrite).microUsd).toBe(65_560);
    expect(usageCost(CARD, plain(200_000, 8_000)).microUsd).toBe(54_560);
    // Past the boundary: 400,000 x 550,000 + 16,000 x 1,980,000 -> 251,680.
    const long = { maxInputTokens: 400_000, maxOutputTokens: 16_000 };
    expect(ceilingCost(CARD, long)).toBe(251_680);
    // 272,000 stays short (74,800); 272,001 prices the long cache write, 149,600.55 -> 149,601.
    expect(ceilingCost(CARD, { maxInputTokens: 272_000, maxOutputTokens: 0 })).toBe(74_800);
    expect(ceilingCost(CARD, { maxInputTokens: 272_001, maxOutputTokens: 0 })).toBe(149_601);

    const next = numbers(20260921);
    for (const bound of [short, long]) {
      const ceiling = ceilingCost(CARD, bound);
      const edges: ProviderUsage[] = [
        plain(0),
        plain(bound.maxInputTokens, bound.maxOutputTokens),
        {
          ...plain(bound.maxInputTokens, bound.maxOutputTokens),
          cacheWriteTokens: bound.maxInputTokens,
        },
        {
          ...plain(bound.maxInputTokens, bound.maxOutputTokens),
          cacheReadTokens: bound.maxInputTokens,
        },
        {
          ...plain(bound.maxInputTokens, bound.maxOutputTokens),
          reasoningTokens: bound.maxOutputTokens,
        },
      ];
      const generated = Array.from({ length: 2_000 }, (): ProviderUsage => {
        const inputTokens = next(bound.maxInputTokens);
        const cacheReadTokens = next(inputTokens);
        const cacheWriteTokens = next(inputTokens - cacheReadTokens);
        const outputTokens = next(bound.maxOutputTokens);
        return {
          inputTokens,
          cacheReadTokens,
          cacheWriteTokens,
          outputTokens,
          reasoningTokens: next(outputTokens),
        };
      });
      for (const usage of [...edges, ...generated])
        expect(usageCost(CARD, usage).microUsd).toBeLessThanOrEqual(ceiling);
    }
  });

  it('keeps the ceiling above the cost even for a card whose long band is cheaper', () => {
    const inverted: ModelRateCard = {
      ...CARD,
      version: 'inverted-test-card',
      long: { input: 200_000, cacheWrite: 250_000, cacheRead: 20_000, output: 1_000_000 },
    };
    // A bound past the boundary can still produce short-band usage, priced at short rates:
    // 272,000 x 275,000 + 16,000 x 1,320,000 = 95,920,000,000 -> 95,920.
    const shortUsage: ProviderUsage = {
      inputTokens: 272_000,
      cacheReadTokens: 0,
      cacheWriteTokens: 272_000,
      outputTokens: 16_000,
      reasoningTokens: 0,
    };
    expect(usageCost(inverted, shortUsage)).toEqual({ microUsd: 95_920, band: 'short' });
    // Long rates alone would hold 91,000. The dearer rate of either band holds 103,620.
    const ceiling = ceilingCost(inverted, { maxInputTokens: 300_000, maxOutputTokens: 16_000 });
    expect(ceiling).toBe(103_620);
    expect(ceiling).toBeGreaterThanOrEqual(95_920);
  });

  it('refuses a bound that is not whole token counts', () => {
    for (const bound of [
      { maxInputTokens: -1, maxOutputTokens: 0 },
      { maxInputTokens: 10, maxOutputTokens: 0.5 },
    ])
      expect(refusalOf(() => ceilingCost(CARD, bound))).toBe('invalid_bound');
  });
});

describe('SpendExposure', () => {
  it('lets only one of two concurrent holds through when both do not fit', async () => {
    const ledger = await open();
    await approve(ledger, 1_000_000);
    const results = await Promise.allSettled([
      ledger.reserve(reserveInput({ attempt: attempt('step-a'), maxMicroUsd: micro(600_000) })),
      ledger.reserve(reserveInput({ attempt: attempt('step-b'), maxMicroUsd: micro(600_000) })),
    ]);
    const fulfilled = results.filter((result) => result.status === 'fulfilled');
    const rejected = results.filter(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    );
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toBeInstanceOf(SpendExposureError);
    expect(rejected[0].reason).toMatchObject({ code: 'insufficient_exposure', status: 402 });
    expect(rejected[0].reason.message).toContain('$0.60 hold');
    expect(rejected[0].reason.message).toContain('only $0.40');
    const summary = ledger.summary(CONNECTION);
    expect(summary.counts.pending).toBe(1);
    expect(summary).toMatchObject({ pendingMicroUsd: 600_000, availableMicroUsd: 400_000 });

    // Five at once against the $0.40 left: exactly one more fits.
    const more = await Promise.allSettled(
      ['c', 'd', 'e', 'f', 'g'].map((step) =>
        ledger.reserve(
          reserveInput({ attempt: attempt(`step-${step}`), maxMicroUsd: micro(300_000) }),
        ),
      ),
    );
    expect(more.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(ledger.summary(CONNECTION)).toMatchObject({
      pendingMicroUsd: 900_000,
      availableMicroUsd: 100_000,
    });
  });

  it('comes back from a restart with the in-flight hold uncertain and still counted', async () => {
    const first = await open();
    await approve(first);
    const held = await first.reserve(reserveInput({ maxMicroUsd: micro(250_000) }));
    expect(first.summary(CONNECTION).availableMicroUsd).toBe(750_000);

    advance(60_000);
    const second = await open();
    const swept = second.get(held.id);
    expect(swept).toMatchObject({
      state: 'uncertain',
      uncertainAt: '2026-09-21T09:01:00.000Z',
      uncertainReason: SWEEP_REASON,
      resolvedAt: null,
      settledMicroUsd: null,
    });
    expect(second.summary(CONNECTION)).toMatchObject({
      capMicroUsd: 1_000_000,
      uncertainMicroUsd: 250_000,
      exposureMicroUsd: 250_000,
      availableMicroUsd: 750_000,
      counts: { pending: 0, settled: 0, released: 0, uncertain: 1, 'written-off': 0 },
    });

    // The sweep was written down, so a third start neither re-stamps nor refunds it.
    advance(60_000);
    const third = await open();
    expect(third.get(held.id)).toEqual(swept);
    expect(third.summary(CONNECTION).availableMicroUsd).toBe(750_000);
    const onDisk = JSON.parse(await fs.readFile(connectionFile(), 'utf8'));
    expect(Object.keys(onDisk).sort()).toEqual(['allowance', 'reservations', 'v']);
    expect(onDisk.v).toBe(1);
    expect(onDisk.reservations[0]).toMatchObject({
      state: 'uncertain',
      uncertainReason: SWEEP_REASON,
    });
  });

  it('never releases an uncertain hold, and a written-off hold keeps its ceiling counted', async () => {
    const ledger = await open();
    await approve(ledger);
    const lost = await ledger.reserve(
      reserveInput({ attempt: attempt('step-a'), maxMicroUsd: micro(100_000) }),
    );
    const timedOut = await ledger.reserve(
      reserveInput({ attempt: attempt('step-b'), maxMicroUsd: micro(200_000) }),
    );
    const unsent = await ledger.reserve(
      reserveInput({ attempt: attempt('step-c'), maxMicroUsd: micro(50_000) }),
    );
    await expect(
      ledger.reconcile(lost.id, { microUsd: micro(1), note: 'Too early.' }),
    ).rejects.toMatchObject({ code: 'illegal_transition', status: 409 });

    advance(1_000);
    const parked = await ledger.markUncertain(lost.id, 'The connection dropped mid-response.');
    expect(parked).toMatchObject({
      state: 'uncertain',
      uncertainAt: '2026-09-21T09:00:01.000Z',
      uncertainReason: 'The connection dropped mid-response.',
      resolvedAt: null,
    });
    await ledger.markUncertain(timedOut.id, 'No response within the timeout.');
    await expect(ledger.release(lost.id, 'Retry it.')).rejects.toMatchObject({
      code: 'illegal_transition',
      status: 409,
    });
    expect(ledger.get(lost.id)?.state).toBe('uncertain');

    // A hold for a call refused before it left is released and counts nothing.
    const released = await ledger.release(unsent.id, 'Refused locally before sending.');
    expect(released).toMatchObject({ state: 'released', note: 'Refused locally before sending.' });

    advance(1_000);
    const reconciled = await ledger.reconcile(lost.id, {
      microUsd: micro(42_000),
      note: 'Matched to the provider bill line for this request.',
    });
    expect(reconciled).toMatchObject({
      state: 'settled',
      settledMicroUsd: 42_000,
      reconciledFrom: 'owner-entry',
      overCeiling: false,
      resolvedAt: '2026-09-21T09:00:02.000Z',
    });
    const writtenOff = await ledger.writeOff(timedOut.id, { note: 'No bill line found.' });
    expect(writtenOff).toMatchObject({
      state: 'written-off',
      reconciledFrom: 'write-off',
      settledMicroUsd: null,
      note: 'No bill line found.',
    });

    const summary = ledger.summary(CONNECTION);
    expect(summary).toMatchObject({
      settledMicroUsd: 42_000,
      writtenOffMicroUsd: 200_000,
      uncertainMicroUsd: 0,
      pendingMicroUsd: 0,
      exposureMicroUsd: 242_000,
      availableMicroUsd: 758_000,
    });
    expect(summary.counts).toEqual({
      pending: 0,
      settled: 1,
      released: 1,
      uncertain: 0,
      'written-off': 1,
    });
    await expect(ledger.writeOff(lost.id, { note: 'Again.' })).rejects.toMatchObject({
      code: 'illegal_transition',
    });
    await expect(
      ledger.reconcile(timedOut.id, { microUsd: micro(1), note: 'Late.' }),
    ).rejects.toMatchObject({ code: 'illegal_transition' });
    await expect(ledger.markUncertain(unsent.id, 'Too late.')).rejects.toMatchObject({
      code: 'illegal_transition',
    });
  });

  it('settles at the exact list-price cost and flags a cost above its hold', async () => {
    const ledger = await open();
    await approve(ledger);
    const small = await ledger.reserve(
      reserveInput({ attempt: attempt('step-a'), maxMicroUsd: micro(20_000) }),
    );
    advance(5_000);
    const settled = await ledger.settle(small.id, {
      usage: MIXED_SHORT,
      card: CARD,
      providerRequestId: 'req-0001',
    });
    expect(settled).toMatchObject({
      state: 'settled',
      settledMicroUsd: 29_212,
      band: 'short',
      overCeiling: true,
      reconciledFrom: 'response',
      providerRequestId: 'req-0001',
      usage: MIXED_SHORT,
      resolvedAt: '2026-09-21T09:00:05.000Z',
    });
    // The real cost counts, not the ceiling it exceeded.
    expect(ledger.summary(CONNECTION)).toMatchObject({
      settledMicroUsd: 29_212,
      exposureMicroUsd: 29_212,
      availableMicroUsd: 970_788,
    });

    const other = await ledger.reserve(
      reserveInput({ attempt: attempt('step-b'), maxMicroUsd: micro(200_000) }),
    );
    await expect(
      ledger.settle(other.id, {
        usage: MIXED_LONG,
        card: { ...CARD, version: 'aws-bedrock-luna-2026-10-01.1' },
        providerRequestId: null,
      }),
    ).rejects.toMatchObject({ code: 'rate_card_changed', status: 409 });
    await expect(
      ledger.settle(other.id, {
        usage: { ...MIXED_LONG, reasoningTokens: 10_001 },
        card: CARD,
        providerRequestId: null,
      }),
    ).rejects.toMatchObject({ code: 'invalid_usage' });
    expect(ledger.get(other.id)?.state).toBe('pending');
    const long = await ledger.settle(other.id, {
      usage: MIXED_LONG,
      card: CARD,
      providerRequestId: null,
    });
    expect(long).toMatchObject({ settledMicroUsd: 117_700, band: 'long', overCeiling: false });
    await expect(
      ledger.settle(other.id, { usage: MIXED_LONG, card: CARD, providerRequestId: null }),
    ).rejects.toMatchObject({ code: 'illegal_transition' });
    await expect(
      ledger.settle('exp-0000000000000000000000000000000000000000', {
        usage: MIXED_LONG,
        card: CARD,
        providerRequestId: null,
      }),
    ).rejects.toMatchObject({ code: 'unknown_reservation', status: 404 });
  });

  it('holds nothing without an approved cap, and a lowered cap admits nothing new', async () => {
    const ledger = await open();
    await expect(ledger.reserve(reserveInput())).rejects.toMatchObject({
      code: 'no_allowance',
      status: 402,
    });
    expect(ledger.allowance(CONNECTION)).toBeNull();
    expect(ledger.list(CONNECTION)).toEqual([]);
    expect(ledger.summary(CONNECTION)).toMatchObject({ capMicroUsd: 0, availableMicroUsd: 0 });

    const first = await approve(ledger, 1_000_000);
    expect(first).toEqual({
      connectionId: CONNECTION,
      capMicroUsd: 1_000_000,
      approvedAt: '2026-09-21T09:00:00.000Z',
      approvedBy: OWNER.approvedBy,
      note: OWNER.note,
      revision: 1,
    });
    await ledger.reserve(reserveInput({ maxMicroUsd: micro(600_000) }));

    advance(1_000);
    const lowered = await ledger.setCap(CONNECTION, micro(500_000), {
      approvedBy: OWNER.approvedBy,
      note: 'Pause new spend.',
    });
    expect(lowered).toMatchObject({ revision: 2, capMicroUsd: 500_000 });
    expect(ledger.summary(CONNECTION)).toMatchObject({
      capMicroUsd: 500_000,
      exposureMicroUsd: 600_000,
      availableMicroUsd: 0,
      overCapMicroUsd: 100_000,
    });
    await expect(
      ledger.reserve(reserveInput({ attempt: attempt('step-2'), maxMicroUsd: micro(1) })),
    ).rejects.toMatchObject({ code: 'insufficient_exposure', status: 402 });
    // Lowering the cap removed nothing.
    expect(ledger.list(CONNECTION)).toHaveLength(1);

    const reopened = await open();
    expect(reopened.allowance(CONNECTION)).toEqual(lowered);
    expect(reopened.summary(CONNECTION).overCapMicroUsd).toBe(100_000);
  });

  it('never holds the same attempt twice, even after it settled', async () => {
    const ledger = await open();
    await approve(ledger);
    const first = await ledger.reserve(reserveInput());
    expect(first.id).toBe(
      `exp-${digest({ connectionId: CONNECTION, attempt: attempt() }).slice(0, 40)}`,
    );
    await expect(ledger.reserve(reserveInput())).rejects.toMatchObject({
      code: 'attempt_exists',
      status: 409,
    });
    await ledger.settle(first.id, { usage: EXACT_SHORT, card: CARD, providerRequestId: null });
    // Settled, with a different ceiling: the identity is the attempt, not the amount.
    await expect(ledger.reserve(reserveInput({ maxMicroUsd: micro(5) }))).rejects.toMatchObject({
      code: 'attempt_exists',
      status: 409,
    });
    // A duplicate is refused as a duplicate even when the money would not fit either.
    await ledger.setCap(CONNECTION, micro(0), { approvedBy: OWNER.approvedBy, note: 'Stop.' });
    await expect(ledger.reserve(reserveInput())).rejects.toMatchObject({ code: 'attempt_exists' });
    await ledger.setCap(CONNECTION, micro(1_000_000), OWNER);
    // A retry is a new attempt number, with a hold of its own.
    const retry = await ledger.reserve(reserveInput({ attempt: attempt('step-1', 2) }));
    expect(retry.id).not.toBe(first.id);

    const reopened = await open();
    await expect(reopened.reserve(reserveInput())).rejects.toMatchObject({
      code: 'attempt_exists',
    });
  });

  it('refuses a hold it cannot describe exactly', async () => {
    const ledger = await open();
    await approve(ledger);
    const cases: [Partial<ReserveInput>, string][] = [
      [{ route: 'bedrock-other' }, 'invalid_rate_card'],
      [{ modelId: 'another-model' }, 'invalid_rate_card'],
      [{ card: { ...CARD, short: { ...CARD.short, output: 1.5 } } }, 'invalid_rate_card'],
      [{ attempt: { ...attempt(), attempt: 0 } }, 'invalid_attempt'],
      [{ attempt: { ...attempt(), runId: '' } }, 'invalid_attempt'],
      [{ attempt: { ...attempt(), stepId: 'x'.repeat(201) } }, 'invalid_attempt'],
      [{ attempt: { ...attempt(), requestDigest: 'A'.repeat(64) } }, 'invalid_attempt'],
      [{ attempt: { ...attempt(), requestDigest: 'abc' } }, 'invalid_attempt'],
      [{ maxMicroUsd: micro(0) }, 'invalid_ceiling'],
      [{ maxMicroUsd: 1.5 as MicroUsd }, 'invalid_ceiling'],
      [{ maxMicroUsd: Number.NaN as MicroUsd }, 'invalid_ceiling'],
      [{ maxMicroUsd: -1 as MicroUsd }, 'invalid_ceiling'],
    ];
    for (const [over, code] of cases)
      await expect(ledger.reserve(reserveInput(over)), code).rejects.toMatchObject({
        code,
        status: 400,
      });
    expect(ledger.list(CONNECTION)).toEqual([]);
  });

  it('leaves memory equal to disk when a write fails', async () => {
    const ledger = await open();
    // A directory where the file belongs makes the atomic rename fail on every platform.
    await fs.mkdir(connectionFile(), { recursive: true });
    await expect(approve(ledger)).rejects.toMatchObject({ code: 'persist_failed', status: 500 });
    expect(ledger.allowance(CONNECTION)).toBeNull();
    await fs.rm(connectionFile(), { recursive: true });

    await approve(ledger);
    const held = await ledger.reserve(reserveInput({ attempt: attempt('step-1') }));
    const before = { summary: ledger.summary(CONNECTION), list: ledger.list(CONNECTION) };

    await fs.rm(connectionFile());
    await fs.mkdir(connectionFile());
    await expect(
      ledger.reserve(reserveInput({ attempt: attempt('step-2') })),
    ).rejects.toMatchObject({ code: 'persist_failed' });
    await expect(
      ledger.settle(held.id, { usage: EXACT_SHORT, card: CARD, providerRequestId: null }),
    ).rejects.toMatchObject({ code: 'persist_failed' });
    await expect(ledger.setCap(CONNECTION, micro(5_000_000), OWNER)).rejects.toMatchObject({
      code: 'persist_failed',
    });
    expect(ledger.summary(CONNECTION)).toEqual(before.summary);
    expect(ledger.list(CONNECTION)).toEqual(before.list);
    expect(ledger.allowance(CONNECTION)?.revision).toBe(1);

    // The refused attempt was never recorded, so once the fault clears it can be held.
    await fs.rm(connectionFile(), { recursive: true });
    const retried = await ledger.reserve(reserveInput({ attempt: attempt('step-2') }));
    const reopened = await open();
    expect(reopened.list(CONNECTION).map((reservation) => reservation.id)).toEqual([
      held.id,
      retried.id,
    ]);
    expect(reopened.allowance(CONNECTION)?.revision).toBe(1);
  });

  it('refuses a connection id that could leave its folder', async () => {
    const ledger = await open();
    const bad = ['../x', '..\\x', 'a/b', 'Acme', '', '-lead', 'x'.repeat(65), 'nul', 'con'];
    for (const connectionId of bad) {
      await expect(
        ledger.setCap(connectionId, micro(1), OWNER),
        connectionId,
      ).rejects.toMatchObject({
        code: 'invalid_connection',
        status: 400,
      });
      await expect(ledger.reserve(reserveInput({ connectionId }))).rejects.toMatchObject({
        code: 'invalid_connection',
      });
      expect(refusalOf(() => ledger.summary(connectionId))).toBe('invalid_connection');
      expect(refusalOf(() => ledger.list(connectionId))).toBe('invalid_connection');
      expect(refusalOf(() => ledger.allowance(connectionId))).toBe('invalid_connection');
    }
    // Nothing was written anywhere.
    expect(await fs.readdir(dataDir)).toEqual([]);
  });

  it('refuses every call before init()', async () => {
    const ledger = new SpendExposure(dataDir, { clock });
    expect(refusalOf(() => ledger.summary(CONNECTION))).toBe('not_initialized');
    expect(refusalOf(() => ledger.get('exp-0'))).toBe('not_initialized');
    await expect(ledger.reserve(reserveInput())).rejects.toMatchObject({ code: 'not_initialized' });
    await expect(approve(ledger)).rejects.toMatchObject({ code: 'not_initialized' });
  });

  it('refuses to start on a file it cannot trust rather than guessing', async () => {
    const seeded = await open();
    await approve(seeded);
    const held = await seeded.reserve(reserveInput());
    await seeded.settle(held.id, { usage: EXACT_SHORT, card: CARD, providerRequestId: null });
    const good = await fs.readFile(connectionFile(), 'utf8');
    const edit = (change: (stored: Record<string, any>) => void) => {
      const stored = JSON.parse(good);
      change(stored);
      return JSON.stringify(stored);
    };
    const tampered: [string, string][] = [
      ['truncated', good.slice(0, good.length / 2)],
      ['another version', edit((stored) => (stored.v = 2))],
      ['no reservations', edit((stored) => delete stored.reservations)],
      ['another connection', edit((stored) => (stored.reservations[0].connectionId = 'other'))],
      ['settled with no amount', edit((stored) => (stored.reservations[0].settledMicroUsd = null))],
      ['fractional ceiling', edit((stored) => (stored.reservations[0].maxMicroUsd = 1.5))],
      ['edited attempt', edit((stored) => (stored.reservations[0].attempt.attempt = 7))],
      ['unknown state', edit((stored) => (stored.reservations[0].state = 'refunded'))],
      ['holds with no cap', edit((stored) => (stored.allowance = null))],
    ];
    for (const [label, bytes] of tampered) {
      await fs.writeFile(connectionFile(), bytes);
      const ledger = new SpendExposure(dataDir, { clock });
      await expect(ledger.init(), label).rejects.toMatchObject({ code: 'corrupt_ledger' });
      expect(refusalOf(() => ledger.summary(CONNECTION))).toBe('not_initialized');
    }

    // A file not named for a connection is refused too, not skipped.
    await fs.writeFile(connectionFile(), good);
    await fs.writeFile(path.join(dataDir, 'spend-exposure', 'Acme.json'), good);
    await expect(new SpendExposure(dataDir, { clock }).init()).rejects.toMatchObject({
      code: 'corrupt_ledger',
    });
    await fs.rm(path.join(dataDir, 'spend-exposure', 'Acme.json'));
    // A leftover temp file from an interrupted write is not a connection file.
    await fs.writeFile(`${connectionFile()}.0a1b2c.tmp`, '{');
    const restored = await open();
    expect(restored.get(held.id)?.settledMicroUsd).toBe(2_376);
  });

  it('hands out copies, so changing a returned record changes nothing', async () => {
    const ledger = await open();
    await approve(ledger);
    const held = await ledger.reserve(reserveInput());
    held.state = 'released';
    const listed = ledger.list(CONNECTION)[0];
    listed.maxMicroUsd = micro(1);
    listed.attempt.attempt = 99;
    expect(ledger.get(held.id)).toMatchObject({ state: 'pending', maxMicroUsd: 100_000 });
    expect(ledger.get(held.id)?.attempt.attempt).toBe(1);
    expect(ledger.summary(CONNECTION).pendingMicroUsd).toBe(100_000);
  });
});
