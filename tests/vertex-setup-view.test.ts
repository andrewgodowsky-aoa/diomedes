import { describe, expect, test } from 'vitest';
import type { VertexConnectionView } from '../shared/model-api';
import { vertexConnectBody, vertexMoneyLines, vertexStateRows } from '../client/vertex-setup-view';

const detectedOnly: VertexConnectionView = {
  route: 'google-vertex',
  configured: false,
  enabled: false,
  detected: { adc: true, source: 'gcloud-default', namedBy: 'the gcloud default location', quotaProject: null },
  connection: null,
  spend: null,
  accounting: null,
  next: 'Connect Google Vertex AI: name the Google Cloud project that is billed.',
};

const connected: VertexConnectionView = {
  ...detectedOnly,
  configured: true,
  enabled: true,
  detected: { ...detectedOnly.detected, quotaProject: 'nectovia-owner-test' },
  connection: {
    id: 'google-vertex-1',
    projectId: 'nectovia-owner-test',
    location: 'global',
    endpoint: 'https://aiplatform.googleapis.com/v1/projects/nectovia-owner-test/locations/global/publishers/google',
    model: 'gemini-3.8-flash',
    processing: 'google-global',
    payer: { kind: 'google-cloud-project', projectId: 'nectovia-owner-test' },
    credential: {
      kind: 'google-adc',
      source: 'gcloud-default',
      namedBy: 'the gcloud default location',
      fingerprint: 'abcd1234abcd1234',
      principal: 'owner@example.test',
      quotaProject: 'nectovia-owner-test',
      savedAt: '2026-09-23T08:00:00.000Z',
      matches: true,
    },
    rateCard: { version: 'google-vertex:gemini-3.8-flash:global:standard:gross-2026.1', source: 's', stale: false, message: null },
    revision: 1,
    accountRoute: 'google-vertex:google-vertex-1:nectovia-owner-test@r1',
    lastVerified: null,
  },
  spend: {
    rateCard: 'google-vertex:gemini-3.8-flash:global:standard:gross-2026.1',
    capMicroUsd: 1_000_000,
    settledMicroUsd: 1_920,
    pendingMicroUsd: 0,
    uncertainMicroUsd: 500,
    writtenOffMicroUsd: 0,
    availableMicroUsd: 997_580,
    note: 'n',
    recent: [],
  },
  accounting: {
    payer: { kind: 'owner-google-cloud-project', projectId: 'nectovia-owner-test' },
    grossEstimateMicroUsd: 1_920,
    unresolvedEstimateMicroUsd: 500,
    expectedPromotion: { status: 'expected-unconfirmed', percent: 50, appliesThrough: '2026-12-31', stacksWithFreeTrial: 'unknown', expectedMicroUsd: 960, source: 's' },
    confirmedCredits: { known: false, where: 'Google Cloud console, Billing, Reports' },
    customerDebitMicroUsd: 0,
    invoice: { known: false, where: 'Google Cloud console, Billing, Documents' },
  },
  next: null,
};

describe('Google Vertex AI setup card', () => {
  test('before connecting: sign-in found, no quota project called out, nothing else ready', () => {
    const rows = vertexStateRows(detectedOnly);
    expect(rows.map((row) => row.key)).toEqual(['credential', 'project', 'price', 'limit', 'route']);
    expect(rows[0]).toMatchObject({ value: 'waiting', text: expect.stringContaining('no quota project set') });
    expect(rows.slice(1).every((row) => row.value === 'waiting')).toBe(true);
    expect(vertexMoneyLines(detectedOnly)).toEqual([]);
  });

  test('no sign-in says exactly what to run', () => {
    const rows = vertexStateRows({ ...detectedOnly, detected: { adc: false, source: null, namedBy: null, quotaProject: null } });
    expect(rows[0].text).toMatch(/API key .*gcloud auth application-default login/);
  });

  test('a changed credential blocks, and a stale price blocks', () => {
    const changed = { ...connected, connection: { ...connected.connection!, credential: { ...connected.connection!.credential, matches: false } } };
    expect(vertexStateRows(changed)[0].value).toBe('blocked');
    const stale = { ...connected, connection: { ...connected.connection!, rateCard: { ...connected.connection!.rateCard, stale: true, message: 'needs re-checking' } } };
    expect(vertexStateRows(stale)[2]).toMatchObject({ value: 'blocked', text: 'needs re-checking' });
  });

  test('connected: every row ready, payer shown, no credential contents', () => {
    const rows = vertexStateRows(connected);
    expect(rows.every((row) => row.value === 'ok')).toBe(true);
    expect(rows[1].text).toBe('nectovia-owner-test · gemini-3.8-flash · global');
    expect(JSON.stringify(rows)).not.toMatch(/abcd1234|token|refresh|private/i);
  });

  test('the five cost figures stay apart and the owner pays, not Nectovia credits', () => {
    const lines = Object.fromEntries(vertexMoneyLines(connected).map((line) => [line.key, line.text]));
    expect(lines.payer).toMatch(/nectovia-owner-test, not Nectovia credits/);
    expect(lines.gross).toBe('$0.0019 at Google’s standard rate');
    expect(lines.unresolved).toBe('up to $0.0005 held');
    expect(lines.promotion).toMatch(/^\$0\.0010 may come back as credit .* Unconfirmed/);
    expect(lines.credits).toMatch(/^Not known here/);
    expect(lines.debit).toBe('$0.00');
    expect(lines.invoice).toMatch(/^Google’s, not Nectovia’s/);
  });

  test('the connect body is exactly what the host accepts, and consent is required', () => {
    const input = (over: Partial<{ projectId: string; apiKey: string; consent: boolean }> = {}) => ({ projectId: 'diomedes-dev', apiKey: '', consent: true, ...over });
    expect(vertexConnectBody(input({ projectId: '' }), true)).toMatchObject({ ok: false });
    expect(vertexConnectBody(input({ projectId: 'Bad_Project' }), true)).toMatchObject({ ok: false });
    expect(vertexConnectBody(input({ consent: false }), true)).toMatchObject({ ok: false, message: expect.stringMatching(/no other/) });
    expect(vertexConnectBody(input({ projectId: ' diomedes-dev ' }), true)).toEqual({
      ok: true,
      body: { projectId: 'diomedes-dev', location: 'global', model: 'gemini-3.8-flash', consent: true },
    });
  });

  test('an API key is sent only when entered, and is required when there is no sign-in', () => {
    const key = 'AQ.synthetic-test-key-0123456789';
    expect(vertexConnectBody({ projectId: 'diomedes-dev', apiKey: '', consent: true }, false)).toMatchObject({ ok: false, message: expect.stringMatching(/API key/) });
    expect(vertexConnectBody({ projectId: 'diomedes-dev', apiKey: 'short', consent: true }, false)).toMatchObject({ ok: false });
    expect(vertexConnectBody({ projectId: 'diomedes-dev', apiKey: ` ${key} `, consent: true }, false)).toEqual({
      ok: true,
      body: { projectId: 'diomedes-dev', location: 'global', model: 'gemini-3.8-flash', consent: true, apiKey: key },
    });
  });

  test('a key connection says the key is saved and never shows it', () => {
    const keyed = { ...connected, connection: { ...connected.connection!, credential: { kind: 'google-api-key' as const, savedAt: '2026-09-23T08:00:00.000Z', matches: true } } };
    const row = vertexStateRows(keyed)[0];
    expect(row).toMatchObject({ value: 'ok', text: expect.stringMatching(/^API key saved in protected storage/) });
    const blocked = { ...keyed, connection: { ...keyed.connection, credential: { ...keyed.connection.credential, matches: false } } };
    expect(vertexStateRows(blocked)[0].value).toBe('blocked');
  });

});
