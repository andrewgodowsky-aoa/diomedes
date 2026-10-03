/**
 * This computer's Nectovia guard for Personal work, across an Individual renewal (DIO-128).
 *
 * Individual credits follow subscription-anniversary terms (`shared/individual-period.ts`): every paid
 * term starts at 0% with 1,000 credits, and the account service funds it so. The engine keys its local
 * guard by billing account and UTC calendar month (`nectoviaConnectionId`, used by `modelApiRoute` and
 * `admitNectovia` in `server/engines/service.ts`), so a term that renews mid-month inherits what the
 * previous term used earlier that calendar month, and Personal work stops on this computer with credits
 * the gateway would fund. Nothing is overspent: the guard only refuses too early.
 *
 * Recorded as a known failure for the Agent route's owner, who owns the engine files the repair needs:
 * the term is not known to this computer at admission today, so the guard cannot follow it yet. When the
 * guard follows the term, this fails and `.fails` comes off.
 */
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
// A subscription that started on September 15: its first term ends October 15, when the next begins.
const FIRST = individualCycle('2026-09-15T00:00:00.000Z', 0);
const SECOND = individualCycle('2026-09-15T00:00:00.000Z', 1);
const IN_FIRST = new Date('2026-10-10T12:00:00.000Z');
const IN_SECOND = new Date('2026-10-16T12:00:00.000Z');

let dir: string;
let exposure: SpendExposure;
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'diomedes-individual-guard-'));
  exposure = new SpendExposure(dir);
  await exposure.init();
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

/** 900 credits held on this computer's guard late in the first term, as an Individual's Nectovia call would. */
async function useFirstTerm() {
  const connectionId = nectoviaConnectionId(ACCOUNT, IN_FIRST);
  await ensureNectoviaGuard(exposure, connectionId, 'individual');
  await exposure.reserve({
    connectionId, route: NECTOVIA_ROUTE, modelId: MANAGED_LUNA.model, card: nectoviaRateCard(MANAGED_LUNA.model),
    attempt: exposureAttempt('run-first-term', 'model@1', 'late in the first term'), maxMicroUsd: creditAmount(900),
  });
  return connectionId;
}

describe('this computer’s guard for an Individual billing account', () => {
  test('holds work in the first term against the plan’s 1,000 credits', async () => {
    expect(IN_FIRST >= new Date(FIRST.startsAt) && IN_FIRST < new Date(FIRST.endsAt)).toBe(true);
    expect(IN_SECOND >= new Date(SECOND.startsAt) && IN_SECOND < new Date(SECOND.endsAt)).toBe(true);
    const connectionId = await useFirstTerm();
    expect(exposure.summary(connectionId).availableMicroUsd).toBe(creditAmount(100));
  });

  test.fails('starts a renewed term with its whole 1,000 credits, as the account service funds it', async () => {
    await useFirstTerm();
    const renewed = await ensureNectoviaGuard(exposure, nectoviaConnectionId(ACCOUNT, IN_SECOND), 'individual');
    expect(renewed.availableMicroUsd).toBe(creditAmount(1000));
  });
});
