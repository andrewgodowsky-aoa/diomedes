import { describe, expect, test } from 'vitest';
import {
  freshness,
  nextSetupAction,
  selectCandidate,
  type Candidate,
  type SelectedBinding,
  type SetupObservation,
} from '../shared/connection-policy.js';

// The 2026-09-20 hostile audit's reference cases, held against the shared helpers.
const review = { engine: 'opencode' };
const candidate = (changes: Partial<Candidate> = {}): Candidate => ({
  id: 'managed',
  engine: 'opencode',
  source: 'managed',
  present: true,
  path: '/private/opencode.exe',
  version: '1.18.4',
  sha256: 'a'.repeat(64),
  integrity: 'verified',
  protocol: 'passed',
  ...changes,
});
const system = (changes: Partial<Candidate> = {}) =>
  candidate({ id: 'system', source: 'system', path: '/user/opencode.exe', ...changes });
const bind = (c: Candidate): SelectedBinding => ({
  id: c.id,
  engine: c.engine,
  path: c.path,
  version: c.version,
  sha256: c.sha256,
});
const now = Date.parse('2026-09-20T12:00:00Z');
const ready = (changes: Partial<SetupObservation> = {}): SetupObservation => ({
  installation: 'ready',
  installSupported: true,
  authentication: 'signed-in',
  accountRouteAllowed: true,
  modelCount: 1,
  enabled: true,
  checkedAt: new Date(now - 10_000).toISOString(),
  revision: 7,
  verifiedRevision: 7,
  ...changes,
});

describe('selectCandidate', () => {
  test('a newer PATH install cannot shadow a verified managed candidate', () => {
    const r = selectCandidate([system({ version: '1.18.5' }), candidate()], review);
    expect(r).toMatchObject({ kind: 'candidate', requiresSelection: true });
    expect(r.kind === 'candidate' && r.candidate.id).toBe('managed');
  });
  test('a supported system install remains a selectable candidate', () => {
    const r = selectCandidate([system()], review);
    expect(r.kind === 'candidate' && r.candidate.id).toBe('system');
  });
  test('an explicitly selected system candidate is not silently replaced by managed', () => {
    const c = system();
    const r = selectCandidate([candidate(), c], review, bind(c));
    expect(r).toMatchObject({ kind: 'candidate', requiresSelection: false });
    expect(r.kind === 'candidate' && r.candidate.id).toBe('system');
  });
  test('missing selected installation requires repair, not fallback', () => {
    expect(selectCandidate([candidate()], review, bind(system()))).toEqual({
      kind: 'repair',
      reason: 'selected-missing',
    });
  });
  test('selected installation moving to another path requires a new choice', () => {
    expect(
      selectCandidate([candidate({ path: '/moved/opencode.exe' })], review, bind(candidate())),
    ).toEqual({ kind: 'repair', reason: 'selected-changed' });
  });
  test.each([
    ['sha256', 'b'.repeat(64)],
    ['version', '1.18.5'],
  ] as const)('selected installation updating its %s in place stays selected', (field, value) => {
    const r = selectCandidate([candidate({ [field]: value })], review, bind(candidate()));
    expect(r).toMatchObject({ kind: 'candidate', requiresSelection: false });
    expect(r.kind === 'candidate' && r.candidate[field]).toBe(value);
  });
  test.each(['1.18.5', '2.0.0', '0.9.1'])('any reported version %s is usable', (version) => {
    expect(selectCandidate([candidate({ version })], review).kind).toBe('candidate');
  });
  test.each<Partial<Candidate>>([
    { integrity: 'unknown' },
    { integrity: 'failed' },
    { protocol: 'unknown' },
    { protocol: 'failed' },
    { present: false },
    { sha256: 'not-a-hash' },
    { version: '' },
    { engine: 'other' },
  ])('no reviewed candidate from %j', (delta) => {
    expect(selectCandidate([candidate(delta)], review).kind).toBe('repair');
  });
  test('selected integrity failure never becomes a recommendation for a different binary', () => {
    const c = system();
    expect(
      selectCandidate([candidate(), { ...c, integrity: 'failed' }], review, bind(c)),
    ).toEqual({ kind: 'repair', reason: 'selected-unverified' });
  });
  test('duplicate observation IDs are refused', () => {
    expect(() => selectCandidate([candidate(), candidate()], review)).toThrow(/duplicate/i);
  });
  test('candidate ordering does not mutate the caller inventory', () => {
    const a = system(),
      b = candidate();
    const input = [a, b];
    selectCandidate(input, review);
    expect(input).toEqual([a, b]);
  });
});

describe('freshness', () => {
  test.each([
    ['missing', null, 'unknown'],
    ['invalid', 'not-a-date', 'unknown'],
    ['future', new Date(now + 1).toISOString(), 'unknown'],
    ['exact expiry', new Date(now - 300_000).toISOString(), 'stale'],
    ['just fresh', new Date(now - 299_999).toISOString(), 'fresh'],
    ['expired', new Date(now - 300_001).toISOString(), 'stale'],
  ] as const)('%s', (_label, at, want) => {
    expect(freshness(at, now)).toBe(want);
  });
  test('invalid TTL is not quietly accepted', () => {
    expect(() => freshness(null, now, 0)).toThrow(RangeError);
  });
  test('invalid clock is not quietly accepted', () => {
    expect(() => freshness(null, NaN)).toThrow(RangeError);
  });
});

describe('nextSetupAction', () => {
  test.each<[string, Partial<SetupObservation>, string]>([
    ['missing binary', { installation: 'missing' }, 'install'],
    ['wrong version', { installation: 'unsupported' }, 'repair'],
    ['corrupt binary', { installation: 'corrupt' }, 'repair'],
    ['no guided installer', { installation: 'missing', installSupported: false }, 'choose-installation'],
    ['unknown auth', { authentication: 'unknown' }, 'check-connection'],
    ['signed out', { authentication: 'signed-out' }, 'sign-in'],
    ['unsupported account', { accountRouteAllowed: false }, 'explain-account-route'],
    ['no models', { modelCount: 0 }, 'resolve-model-access'],
    ['not enabled', { enabled: false }, 'enable'],
    ['stale status', { checkedAt: new Date(now - 300_000).toISOString() }, 'check-connection'],
    ['missing time', { checkedAt: null }, 'check-connection'],
    ['no first result', { verifiedRevision: null }, 'test-connection'],
    ['changed binding', { verifiedRevision: 6 }, 'test-connection'],
    ['verified current route', {}, 'ready'],
  ])('%s', (_label, delta, want) => {
    expect(nextSetupAction(ready(delta), now)).toBe(want);
  });
  test('malformed model counts are refused', () => {
    expect(() => nextSetupAction(ready({ modelCount: NaN }), now)).toThrow(RangeError);
  });
  test('malformed revisions are refused', () => {
    expect(() => nextSetupAction(ready({ revision: -1 }), now)).toThrow(RangeError);
  });
});
