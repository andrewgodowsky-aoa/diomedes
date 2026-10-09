/**
 * Hostile verification of the one expiry rule (audit F05, acceptance row 6).
 * The server and AI setup must agree about what "current" means, at the exact
 * boundary and on a timestamp that cannot be trusted.
 */
import { describe, expect, it } from 'vitest';
import { CONNECTION_TTL_MS, freshness } from '../shared/connection-policy.js';
import { checkedSentence } from '../client/ai-setup-state.js';
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

describe('the boundary every surface shares', () => {
  it('is the same millisecond for the policy and the AI setup line', () => {
    const now = Date.parse('2026-09-20T12:00:00.000Z');
    const justInside = new Date(now - (CONNECTION_TTL_MS - 1)).toISOString();
    const exactly = new Date(now - CONNECTION_TTL_MS).toISOString();
    expect(freshness(justInside, now)).toBe('fresh');
    expect(checkedSentence(signedIn(justInside), now, time)).toBe(`Checked ${justInside}`);
    expect(freshness(exactly, now)).toBe('stale');
    expect(checkedSentence(signedIn(exactly), now, time)).toMatch(/no longer current/);
  });

  it('treats an unreadable timestamp as needing a fresh check on both surfaces', () => {
    const now = Date.now();
    expect(freshness('not a date', now)).toBe('unknown');
    expect(checkedSentence(signedIn('not a date'), now, time)).toMatch(/Check again/);
  });
});

describe('a timestamp from the future', () => {
  it('needs a fresh check by the shared rule', () => {
    const now = Date.now();
    expect(freshness(at(60_000), now)).toBe('unknown');
    expect(checkedSentence(signedIn(at(60_000)), now, time)).toMatch(/Check again/);
  });

  it('is not presented as current when the clock moved back by a day', () => {
    // The rule is `freshness()`, not `Date.now() - at < FRESH_MS`, which was
    // true of every future timestamp.
    const now = Date.now();
    const ahead = signedIn(at(24 * 60 * 60_000));
    expect(freshness(ahead.checkedAt, now)).toBe('unknown');
    expect(checkedSentence(ahead, now, time)).toMatch(/Check again/);
  });
});
