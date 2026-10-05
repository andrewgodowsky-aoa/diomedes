import { describe, expect, test } from 'vitest';
import {
  awsConnectBody,
  awsIsDefault,
  awsLimitBody,
  awsPickerState,
  awsStateRows,
  holdSentence,
  qualificationSentence,
  routeCheckLines,
  routeCheckRunState,
  routeChecksCaption,
  routeCheckSummary,
  usd,
  usdUp,
} from '../client/aws-bedrock-view';
import { AWS_KIMI_K3_REFUSAL, type AwsConnectionView, type RouteQualificationView } from '../shared/model-api';
import { passingReceipt } from './fixtures/route-qualification-receipts';

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

  test('an explicit US K3 selection is sent unchanged; leaving the model unset keeps Luna', () => {
    const input = { accountId: '123456789012', apiKey: KEY, expiresLocal: '', consent: true };
    expect(awsConnectBody({ ...input, model: 'us.moonshotai.kimi-k3' }, NOW)).toMatchObject({
      ok: true,
      body: { model: 'us.moonshotai.kimi-k3', region: 'us-east-1', accountId: input.accountId },
    });
    expect(awsConnectBody(input, NOW)).toMatchObject({ ok: true, body: { model: 'us.openai.gpt-5.6-luna' } });
  });

  test.each(['moonshotai.kimi-k3', 'global.moonshotai.kimi-k3', 'us.moonshotai.kimi-k2.5'])(
    'setup refuses %s instead of silently saving Luna',
    (model) => {
      const result = awsConnectBody({ accountId: '123456789012', apiKey: KEY, expiresLocal: '', consent: true, model }, NOW);
      expect(result.ok).toBe(false);
      expect(JSON.stringify(result)).not.toContain(KEY);
    },
  );

  test('a configured K3 route without a passing route check is blocked in the picker', () => {
    const blocked = view({
      connection: { ...view().connection!, model: 'us.moonshotai.kimi-k3' },
      next: AWS_KIMI_K3_REFUSAL,
    });
    expect(awsPickerState(blocked)).toEqual({ offered: false, note: `AWS Bedrock is on but not ready: ${AWS_KIMI_K3_REFUSAL}` });
    expect(byKey(awsStateRows(blocked, NOW)).route).toMatchObject({ value: 'blocked', text: expect.stringContaining('Kimi K3') });
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
        model: 'us.openai.gpt-5.6-luna',
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

describe('the route checks block', () => {
  const K3 = 'us.moonshotai.kimi-k3';
  const receipt = passingReceipt(
    {
      route: 'aws-bedrock',
      connectionId: 'aws-bedrock-1',
      connectionRevision: 1,
      model: K3,
      protocol: 'openai-chat-completions',
      rateCard: 'aws-bedrock-kimi-k3-us-fixture',
      deployment: null,
      endpoint: 'https://bedrock-runtime.us-east-1.amazonaws.com/openai/v1',
      sdk: 'ai@7.0.107+@ai-sdk/openai@4.0.71',
    },
    { createdAt: new Date(NOW) },
  );
  const checks = (patch: Partial<RouteQualificationView> = {}): RouteQualificationView => ({
    route: 'aws-bedrock',
    model: K3,
    deployment: null,
    receipt,
    qualifies: true,
    reason: null,
    required: true,
    blocked: null,
    ceilingMicroUsd: 223_456,
    running: false,
    ...patch,
  });

  test('says what K3 may do now, or exactly why not', () => {
    expect(qualificationSentence(null)).toBeNull();
    expect(qualificationSentence(checks({ model: null }))).toBeNull();
    expect(qualificationSentence(checks())).toBe('Kimi K3 can send on this connection.');
    const reason = 'The route check saw billed output above the limit it was sent with.';
    expect(qualificationSentence(checks({ qualifies: false, reason }))).toBe(reason);
    expect(qualificationSentence(checks({ model: 'us.openai.gpt-5.6-luna', required: false }))).toBe('The route checks passed on this connection.');
    expect(qualificationSentence(checks({ route: 'azure-openai', model: 'gpt-6.1-sol', deployment: 'sol-prod', required: false }))).toBe(
      'The route checks passed for this deployment.',
    );
  });

  test('one line per check in its own words; a check that did not run is not said twice', () => {
    const stopped = {
      ...receipt,
      checks: receipt.checks.map((check, index) =>
        index < 4 ? check : { ...check, outcome: 'not-run' as const, detail: 'Not run: the route checks were stopped.', calls: [] },
      ),
    };
    const lines = routeCheckLines(stopped);
    expect(lines.map((line) => line.label)).toEqual(['Short answer', 'Output limit', 'Tool round trip', 'Caching by default', 'Caching off']);
    expect(lines[0]).toEqual({ id: 'short-answer', label: 'Short answer', outcome: 'passed', text: 'Passed · Synthetic fixture: no provider was called.' });
    expect(lines[4].text).toBe('Not run: the route checks were stopped.');
    expect(routeCheckLines(null)).toEqual([]);
  });

  test('the last run, who served it and what it spent; the most a run can hold, rounded up', () => {
    expect(routeCheckSummary(null)).toBeNull();
    const when = new Date(NOW).toLocaleString();
    expect(routeCheckSummary(receipt)).toBe(`Last run ${when} · served by ${K3} · ${usd(500)} spent`);
    expect(routeCheckSummary({ ...receipt, servedModels: [], spend: { settledMicroUsd: 0, uncertainMicroUsd: 12_300 } })).toBe(
      `Last run ${when} · no model reported · $0.00 spent, ${usd(12_300)} not yet known`,
    );
    expect(usdUp(223_456)).toBe('$0.23');
    expect(usdUp(220_000)).toBe('$0.22');
    expect(routeChecksCaption(checks())).toBe(
      'Up to eight short requests through this connection, billed as usual. They hold at most $0.23 of the spend limit.',
    );
    expect(routeChecksCaption(checks({ deployment: 'sol-prod' }))).toContain('through this deployment');
    expect(routeChecksCaption(null)).toBe('Up to eight short requests through this connection, billed as usual.');
  });

  test('a run starts only when the host says nothing blocks it; a run in progress here shows Stop instead', () => {
    expect(routeCheckRunState(null, false)).toEqual({ canRun: false, reason: null });
    expect(routeCheckRunState(checks(), false)).toEqual({ canRun: true, reason: null });
    expect(routeCheckRunState(checks(), true)).toEqual({ canRun: false, reason: null });
    const blocked = 'Approve a spend limit for AWS before running route checks.';
    expect(routeCheckRunState(checks({ blocked }), false)).toEqual({ canRun: false, reason: blocked });
  });
});
