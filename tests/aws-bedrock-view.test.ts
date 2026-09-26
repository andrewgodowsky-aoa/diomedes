import { describe, expect, test } from 'vitest';
import {
  awsConnectBody,
  awsIsDefault,
  awsLimitBody,
  awsPickerState,
  awsStateRows,
  holdSentence,
  usd,
} from '../client/aws-bedrock-view';
import type { AwsConnectionView } from '../shared/model-api';

const NOW = Date.parse('2026-09-21T12:00:00Z');
const KEY = 'ABSKQmVkcm9ja0FQSUtleS1leGFtcGxlLWtleQ==';

function view(patch: Partial<AwsConnectionView> = {}): AwsConnectionView {
  return {
    route: 'aws-bedrock',
    configured: true,
    protectedStorage: true,
    enabled: true,
    connection: {
      id: 'aws-bedrock-1',
      account: '123456789012',
      accountEvidence: 'Entered by the owner; AWS has not confirmed it.',
      region: 'us-east-1',
      endpoint: 'https://bedrock-runtime.us-east-1.amazonaws.com/openai/v1',
      model: 'us.openai.gpt-5.6-luna',
      processing: 'us',
      credential: { kind: 'bedrock-api-key', fingerprint: '••••9012', savedAt: '2026-09-21T11:00:00Z', expiresAt: null, expired: false },
      revision: 1,
      accountRoute: 'aws-bedrock:aws-bedrock-1@r1',
    },
    spend: {
      rateCard: 'luna-2026-09',
      capMicroUsd: 1_000_000,
      settledMicroUsd: 12_000,
      pendingMicroUsd: 0,
      uncertainMicroUsd: 0,
      writtenOffMicroUsd: 0,
      availableMicroUsd: 988_000,
      note: 'Estimated from AWS list prices.',
      recent: [],
    },
    next: null,
    ...patch,
  };
}

const byKey = (rows: ReturnType<typeof awsStateRows>) => Object.fromEntries(rows.map((row) => [row.key, row]));

describe('AWS Bedrock setup view', () => {
  test('money reads in cents, or tenths of a cent below one cent', () => {
    expect(usd(0)).toBe('$0.00');
    expect(usd(1_000_000)).toBe('$1.00');
    expect(usd(12_000)).toBe('$0.01');
    expect(usd(1_234)).toBe('$0.0012');
    expect(usd(100_000_000)).toBe('$100.00');
  });

  test('a fresh install waits on every fact, in setup order', () => {
    const rows = awsStateRows(view({ configured: false, enabled: false, connection: null, spend: null }), NOW);
    expect(rows.map((row) => row.key)).toEqual(['connection', 'key', 'limit', 'route']);
    expect(rows.map((row) => row.value)).toEqual(['waiting', 'waiting', 'waiting', 'waiting']);
    expect(byKey(rows).key.text).toBe('None saved');
  });

  test('a server without protected storage says so and blocks the key', () => {
    const rows = byKey(awsStateRows(view({ protectedStorage: false, connection: null, spend: null }), NOW));
    expect(rows.key).toMatchObject({ value: 'blocked', text: 'Protected storage is not available here' });
  });

  test('a connected account with no approved limit says nothing can be sent', () => {
    const base = view();
    const rows = byKey(awsStateRows(view({ spend: { ...base.spend!, capMicroUsd: 0, availableMicroUsd: 0 } }), NOW));
    expect(rows.connection).toMatchObject({ value: 'ok', text: '123456789012 · us-east-1 · us.openai.gpt-5.6-luna' });
    expect(rows.limit).toMatchObject({ value: 'waiting', text: 'Not approved: nothing can be sent' });
  });

  test('an exhausted limit blocks, and an expired or expiring key is named', () => {
    const base = view();
    const spent = byKey(awsStateRows(view({ spend: { ...base.spend!, availableMicroUsd: 0 } }), NOW));
    expect(spent.limit).toMatchObject({ value: 'blocked', text: '$1.00 approved, $0.00 left' });

    const expired = view();
    expired.connection!.credential = { ...expired.connection!.credential, expired: true };
    expect(byKey(awsStateRows(expired, NOW)).key).toMatchObject({ value: 'blocked', text: 'Expired: enter a new key' });

    const soon = view();
    soon.connection!.credential = { ...soon.connection!.credential, expiresAt: '2026-09-21T18:00:00Z' };
    expect(byKey(awsStateRows(soon, NOW)).key.text).toMatch(/^Saved, expires .+ \(soon\)$/);

    const later = view();
    later.connection!.credential = { ...later.connection!.credential, expiresAt: '2026-10-21T18:00:00Z' };
    expect(byKey(awsStateRows(later, NOW)).key.text).not.toContain('(soon)');
  });

  test('connect builds the exact route body and never echoes the key in a refusal', () => {
    const input = { accountId: ' 1234-5678-9012 ', apiKey: ` ${KEY} `, expiresLocal: '', consent: true };
    expect(awsConnectBody(input, NOW)).toEqual({
      ok: true,
      body: {
        accountId: '123456789012',
        region: 'us-east-1',
        model: 'us.openai.gpt-6-luna',
        apiKey: KEY,
        expiresAt: null,
        consent: true,
      },
    });
    const refusals = [
      awsConnectBody({ ...input, accountId: '12345' }, NOW),
      awsConnectBody({ ...input, apiKey: 'short' }, NOW),
      awsConnectBody({ ...input, expiresLocal: 'not a date' }, NOW),
      awsConnectBody({ ...input, expiresLocal: '2026-09-20T12:00' }, NOW),
      awsConnectBody({ ...input, consent: false }, NOW),
    ];
    for (const refusal of refusals) {
      expect(refusal.ok).toBe(false);
      expect(JSON.stringify(refusal)).not.toContain(KEY);
    }
    const dated = awsConnectBody({ ...input, expiresLocal: '2026-09-22T12:00' }, NOW);
    expect(dated.ok && typeof dated.body.expiresAt === 'string').toBe(true);
  });

  test('the spend limit is whole cents from $0 to $100 and needs consent', () => {
    expect(awsLimitBody('1', true)).toEqual({ ok: true, body: { capUsd: 1, consent: true } });
    expect(awsLimitBody('0.25', true)).toEqual({ ok: true, body: { capUsd: 0.25, consent: true } });
    expect(awsLimitBody('0', true)).toEqual({ ok: true, body: { capUsd: 0, consent: true } });
    expect(awsLimitBody('100', true).ok).toBe(true);
    for (const bad of ['', ' ', '-1', '100.01', 'abc', 'Infinity']) expect(awsLimitBody(bad, true).ok).toBe(false);
    expect(awsLimitBody('0.125', true)).toEqual({ ok: false, message: 'Use whole cents.' });
    expect(awsLimitBody('1', false)).toEqual({ ok: false, message: 'Confirm the limit before saving it.' });
  });

  test('each paid call reads as its cost, or as why the cost is not known', () => {
    const hold = {
      id: 'h1',
      state: 'settled',
      runId: 'model-1.t1',
      stepId: 'model:0',
      maxMicroUsd: 40_000,
      settledMicroUsd: 1_234,
      usage: { inputTokens: 1200, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 80, reasoningTokens: 10 },
      providerRequestId: 'req_1',
      createdAt: '2026-09-21T11:30:00Z',
      uncertainReason: null,
    };
    expect(holdSentence(hold)).toBe(`$0.0012 · ${(1200).toLocaleString()} in, 80 out`);
    expect(holdSentence({ ...hold, state: 'pending', settledMicroUsd: null, usage: null })).toBe('In progress · up to $0.04 held');
    expect(
      holdSentence({ ...hold, state: 'uncertain', settledMicroUsd: null, usage: null, uncertainReason: 'Stopped after sending.' }),
    ).toBe('Cost unknown · $0.04 held until you record it · Stopped after sending.');
    expect(holdSentence({ ...hold, state: 'released', settledMicroUsd: null, usage: null })).toBe('Not sent · nothing held');
    expect(holdSentence({ ...hold, state: 'written-off', settledMicroUsd: null, usage: null })).toBe('Accepted at $0.04');
  });

  test('a thread offers AWS only when the host reports nothing blocking a send', () => {
    expect(awsPickerState(null)).toEqual({ offered: false, note: null });
    expect(awsPickerState(view({ connection: null }))).toEqual({ offered: false, note: null });
    expect(awsPickerState(view({ enabled: false, next: 'Turn AWS Bedrock on.' }))).toEqual({ offered: false, note: null });
    expect(awsPickerState(view({ next: 'Approve a spend limit for AWS before sending.' }))).toEqual({
      offered: false,
      note: 'AWS Bedrock is on but not ready: Approve a spend limit for AWS before sending.',
    });
    expect(awsPickerState(view())).toEqual({ offered: true, note: null });
  });

  test('connecting alone never makes AWS the default route', () => {
    expect(awsIsDefault(undefined)).toBe(false);
    expect(awsIsDefault({ defaultEngine: 'claude' })).toBe(false);
    expect(awsIsDefault({ defaultEngine: 'aws-bedrock' })).toBe(true);
  });
});
