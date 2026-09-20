/**
 * Hostile verification of build identity.
 *
 * The point of `server/build-identity.ts` is that a support conversation reads
 * which build is running instead of arguing about a remembered version. These
 * tests hand it a missing, unreadable, malformed, oversized, hostile and
 * disagreeing record and ask one question each time: does it say only what it
 * knows, and does it ever invent a commit, a version or a channel?
 *
 * Read-only: no product file is written and no process is started.
 */
import { describe, expect, it } from 'vitest';
import {
  MAX_BUILD_RECORD_BYTES,
  buildIdentity,
  currentBuildIdentity,
} from '../server/build-identity.js';
import { buildSupportBundle, renderSupportBundle } from '../server/support-bundle.js';

const HOME = 'C:\\Users\\hostile';
const EXEC = `${HOME}\\AppData\\Local\\Diomedes\\Diomedes.exe`;
const COMMIT = 'efa83acd021c5c14fc32a4760e7f7af1d0f53cd6';

const identity = (read: () => string | null, packaged = true, version = '0.1.5') =>
  buildIdentity({ version, read, execPath: EXEC, home: HOME, packaged });

const record = (overrides: Record<string, unknown> = {}) =>
  JSON.stringify({
    schemaVersion: 1,
    version: '0.1.5',
    baseCommit: COMMIT,
    sourceStatus: 'committed',
    signing: 'unsigned-experimental',
    builtAt: '2026-09-20T06:07:40.484Z',
    ...overrides,
  });

describe('a record that is not there, not readable, or not a record', () => {
  it('calls a checkout a development build and invents no commit', () => {
    const value = identity(() => null, false);
    expect(value).toMatchObject({
      commit: null,
      builtAt: null,
      channel: 'development',
      signing: null,
      sourceStatus: null,
      source: 'development',
      buildId: '0.1.5+dev',
    });
  });

  it('separates an unreadable record from a checkout that has none', () => {
    const value = identity(() => {
      throw new Error('EACCES');
    });
    expect(value.source).toBe('unreadable-record');
    expect(value.commit).toBeNull();
    expect(value.channel).toBe('unknown');
    expect(value.buildId).toBe('0.1.5+unknown');
  });

  it('refuses a record past the readable bound instead of parsing it', () => {
    const value = identity(() => `${' '.repeat(MAX_BUILD_RECORD_BYTES)}${record()}`);
    expect(value.source).toBe('unreadable-record');
    expect(value.commit).toBeNull();
  });

  it('refuses malformed JSON, an array and a bare value', () => {
    for (const text of ['{', '[1,2,3]', '"a string"', 'null', '12']) {
      const value = identity(() => text);
      expect(value.source, text).toBe('unreadable-record');
      expect(value.commit, text).toBeNull();
    }
  });

  it('refuses a record whose commit is not a commit', () => {
    for (const commit of ['', 'HEAD', COMMIT.slice(0, 39), `${COMMIT}0`, 'Z'.repeat(40), 42]) {
      const value = identity(() => record({ baseCommit: commit }));
      expect(value.source, String(commit)).toBe('unreadable-record');
      expect(value.commit, String(commit)).toBeNull();
    }
  });

  it('refuses a record whose version is not a version', () => {
    for (const version of ['', 'a'.repeat(41), '0.1.5 (patched)', { toString: () => '0.1.5' }]) {
      const value = identity(() => record({ version }));
      expect(value.source, String(version)).toBe('unreadable-record');
    }
  });

  it('is not moved by a prototype-polluting record', () => {
    const value = identity(() => '{"__proto__":{"channel":"stable"},"version":"0.1.5","baseCommit":"' + COMMIT + '"}');
    expect(({} as Record<string, unknown>).channel).toBeUndefined();
    expect(value.channel).toBe('unknown');
    expect(value.source).toBe('build-record');
  });
});

describe('what a packaged build says about itself', () => {
  it('never lets a missing record make a packaged build call itself development', () => {
    const value = identity(() => null, true);
    expect(value.packaged).toBe(true);
    // Nothing was read, so nothing is known — but `development` is a claim
    // about where this build came from, and a packaged build is not a checkout.
    expect(value.channel).not.toBe('development');
  });

  it('carries the signing string beside whatever channel it reports', () => {
    const stamped = identity(() => record({ channel: 'stable' }));
    expect(stamped.channel).toBe('stable');
    expect(stamped.signing).toBe('unsigned-experimental');
    const mapped = identity(() => record());
    expect(mapped.channel).toBe('experimental');
  });

  it('reports an unrecognised signing as an unknown channel rather than guessing', () => {
    const value = identity(() => record({ signing: 'Diomedes Systems LLC' }));
    expect(value.channel).toBe('unknown');
    expect(value.signing).toBe('Diomedes Systems LLC');
  });

  it('replaces the account in the launch target whatever case it is spelled in', () => {
    const value = buildIdentity({
      version: '0.1.5',
      read: () => null,
      execPath: 'C:\\USERS\\HOSTILE\\AppData\\Local\\Diomedes\\Diomedes.exe',
      home: HOME,
      packaged: true,
    });
    expect(value.launchTarget).not.toMatch(/hostile/i);
  });
});

describe('a record that disagrees with the running package', () => {
  const disagreeing = identity(() => record({ version: '0.1.4' }), true, '0.1.5');

  it('reports the record version and never rewrites it to the package version', () => {
    expect(disagreeing.version).toBe('0.1.4');
    expect(disagreeing.buildId).toBe(`0.1.4+${COMMIT.slice(0, 12)}`);
  });

  it('puts both numbers in front of the reader of a support bundle', () => {
    const text = renderSupportBundle(
      buildSupportBundle({
        version: '0.1.5',
        dataDir: 'D:\\data',
        projectRoot: 'D:\\projects',
        port: 47631,
        engines: [],
        state: null,
        recentErrors: [],
        secrets: [],
        connections: [],
        build: disagreeing,
        now: () => '2026-09-20T00:00:00.000Z',
      }),
    );
    expect(text).toContain('app: Diomedes 0.1.5');
    expect(text).toContain('build: 0.1.4+efa83acd021c');
  });
});

describe('the one remembered answer', () => {
  it('remembers the answer for a version, not the first answer it ever gave', () => {
    // The record cannot change under a live process, so asking twice about one
    // version reads it once. A second caller asking about a different version
    // is asking a different question, and used to be handed the first caller's
    // answer (server/build-identity.ts:177-189).
    const first = currentBuildIdentity('7.7.7');
    expect(currentBuildIdentity('7.7.7')).toBe(first);
    const second = currentBuildIdentity('8.8.8');
    expect(second).not.toBe(first);
    // This checkout ships no build record, so the version it was asked about is
    // the only version it can report.
    expect(second.version).toBe('8.8.8');
  });
});
