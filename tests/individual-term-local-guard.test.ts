import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { creditAmount } from '../shared/managed-usage.js';
import { MANAGED_LUNA, NECTOVIA_ROUTE } from '../shared/model-api.js';
import { individualCycle } from '../shared/individual-period.js';
import { exposureAttempt } from '../server/engines/aws-bedrock.js';
import { ensureNectoviaGuard, nectoviaConnectionId, nectoviaRateCard } from '../server/engines/nectovia.js';
import { SpendExposure } from '../server/spend-exposure.js';

const ACCOUNT = 'individual_billing_fixture';
const FIRST = individualCycle('2026-09-15T00:00:00.000Z', 0);
const SECOND = individualCycle(FIRST.anchorAt, 1);
let dir: string;
let exposure: SpendExposure;
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'diomedes-individual-guard-'));
  exposure = new SpendExposure(dir);
  await exposure.init();
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe('Individual admission term on the local guard', () => {
  test('starts a paid renewed term with 1,000 credits and preserves old holds', async () => {
    const first = nectoviaConnectionId(ACCOUNT, new Date('2026-10-10T12:00:00.000Z'), FIRST);
    await ensureNectoviaGuard(exposure, first, 'individual');
    const hold = await exposure.reserve({ connectionId: first, route: NECTOVIA_ROUTE,
      modelId: MANAGED_LUNA.model, card: nectoviaRateCard(MANAGED_LUNA.model),
      attempt: exposureAttempt('run-first-term', 'model@1', 'late in the first term'), maxMicroUsd: creditAmount(900) });
    expect(exposure.summary(first).availableMicroUsd).toBe(creditAmount(100));
    const next = nectoviaConnectionId(ACCOUNT, new Date('2026-10-16T12:00:00.000Z'), SECOND);
    expect(next).not.toBe(first);
    expect((await ensureNectoviaGuard(exposure, next, 'individual')).availableMicroUsd).toBe(creditAmount(1000));
    expect(exposure.summary(first).exposureMicroUsd).toBe(creditAmount(900));
    expect(hold.connectionId).toBe(first);
    const settled = await exposure.settle(hold.id, { card: nectoviaRateCard(MANAGED_LUNA.model),
      usage: { inputTokens: 100, outputTokens: 10, reasoningTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
      providerRequestId: 'late-first-term-response' });
    expect(settled).toMatchObject({ state: 'settled', connectionId: first });
    expect(exposure.summary(first).exposureMicroUsd).toBe(settled.settledMicroUsd);
    expect(exposure.summary(first).availableMicroUsd).toBe(creditAmount(1000) - settled.settledMicroUsd!);
    expect(exposure.summary(next)).toMatchObject({ exposureMicroUsd: 0, availableMicroUsd: creditAmount(1000) });
  });

  test('keeps one ledger across a calendar boundary and repeated same-term grants', () => {
    const first = nectoviaConnectionId(ACCOUNT, new Date('2026-09-30T12:00:00.000Z'), FIRST);
    expect(nectoviaConnectionId(ACCOUNT, new Date('2026-10-01T12:00:00.000Z'), { ...FIRST })).toBe(first);
    expect(nectoviaConnectionId('another_person_account', new Date('2026-10-01T12:00:00.000Z'), FIRST)).not.toBe(first);
  });

  test.each(['2027-01-31T13:14:15.000Z', '2028-01-31T13:14:15.000Z'])('clamps month-end terms from %s', anchor => {
    const first = individualCycle(anchor, 0), second = individualCycle(anchor, 1);
    expect(nectoviaConnectionId(ACCOUNT, new Date(Date.parse(first.endsAt) - 1), first))
      .not.toBe(nectoviaConnectionId(ACCOUNT, new Date(second.startsAt), second));
  });

  test.each([
    { name: 'before the term', at: '2026-09-14T23:59:59.999Z', cycle: FIRST },
    { name: 'at the exclusive end', at: FIRST.endsAt, cycle: FIRST },
    { name: 'after expiry', at: '2026-10-16T00:00:00.000Z', cycle: FIRST },
    { name: 'invalid boundary', at: FIRST.startsAt, cycle: { ...FIRST, endsAt: SECOND.endsAt } },
  ])('refuses $name without deriving a new term', ({ at, cycle }) => {
    expect(() => nectoviaConnectionId(ACCOUNT, new Date(at), cycle)).toThrow();
  });

  test('keeps the calendar path for Business, legacy Individual and no-plan bought credits', () => {
    expect(nectoviaConnectionId(ACCOUNT, new Date('2026-10-16T00:00:00.000Z'))).toMatch(/-202610$/);
  });
});
