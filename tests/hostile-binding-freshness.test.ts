/**
 * Hostile verification of the one expiry rule (audit F05, acceptance row 6).
 * The server, AI setup and the thread picker must agree about what "current"
 * means, at the exact boundary and on a timestamp that cannot be trusted.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CONNECTION_TTL_MS, freshness } from '../shared/connection-policy.js';
import { checkedSentence } from '../client/ai-setup-state.js';
import { connectionState } from '../client/console/Picker.js';
import type { EngineConnection } from '../shared/engines.js';

const signedIn = (checkedAt: string | null): EngineConnection => ({
  engine: 'opencode',
  installation: 'found',
  compatibility: 'supported',
  authentication: 'signed-in',
  accountRoute: 'opencode:opencode-go',
  models: [{ slug: 'm', name: 'M', description: '', efforts: [], defaultEffort: null }],
  checkedAt,
  detail: 'Checked',
  usage: { state: 'unknown', checkedAt: null },
});
const at = (offsetMs: number) => new Date(Date.now() + offsetMs).toISOString();
const time = (value: string) => value;
afterEach(() => vi.useRealTimers());

describe('the boundary every surface shares', () => {
  it('is the same millisecond for the policy and the thread picker', () => {
    // A frozen clock, because the two surfaces read it a few milliseconds apart.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-20T12:00:00.000Z'));
    const now = Date.now();
    const justInside = new Date(now - (CONNECTION_TTL_MS - 1)).toISOString();
    const exactly = new Date(now - CONNECTION_TTL_MS).toISOString();
    expect(freshness(justInside, now)).toBe('fresh');
    expect(connectionState(signedIn(justInside))).toBe('Signed in · Ready');
    expect(freshness(exactly, now)).toBe('stale');
    expect(connectionState(signedIn(exactly))).toMatch(/rechecked before sending/);
  });

  it('treats an unreadable timestamp as needing a fresh check on both surfaces', () => {
    const now = Date.now();
    expect(freshness('not a date', now)).toBe('unknown');
    expect(checkedSentence(signedIn('not a date'), now, time)).toMatch(/Check again/);
    expect(connectionState(signedIn('not a date'))).not.toContain('Ready');
  });
});

describe('a timestamp from the future', () => {
  it('needs a fresh check by the shared rule', () => {
    const now = Date.now();
    expect(freshness(at(60_000), now)).toBe('unknown');
    expect(checkedSentence(signedIn(at(60_000)), now, time)).toMatch(/Check again/);
  });

  it('is not presented as Ready by the thread picker, which shares that rule', () => {
    // The picker asks `freshness()` rather than `Date.now() - at < FRESH_MS`,
    // which was true of every future timestamp. A clock that moved backwards
    // no longer reads as "Ready" on the thread while AI setup asks for a check.
    const ahead = signedIn(at(60_000));
    expect(freshness(ahead.checkedAt, Date.now())).toBe('unknown');
    expect(connectionState(ahead)).toMatch(/rechecked before sending/);
  });

  it('is not presented as Ready when the clock moved back by a day', () => {
    const ahead = signedIn(at(24 * 60 * 60_000));
    expect(freshness(ahead.checkedAt, Date.now())).toBe('unknown');
    expect(connectionState(ahead)).toMatch(/rechecked before sending/);
  });
});
