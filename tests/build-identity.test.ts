import fs from 'node:fs';
import { describe, expect, test } from 'vitest';
import { MAX_BUILD_RECORD_BYTES, buildIdentity } from '../server/build-identity.js';
import packageInfo from '../package.json' with { type: 'json' };

// The record a real packaged build stamps. It is committed here, and
// scripts/write-candidate-record.ts proves the byte-identical copy ships inside
// resources/app.asar, so this is the shipped shape rather than a guess at it.
const SHIPPED = fs.readFileSync(
  new URL('../evidence/windows-release/build-info.json', import.meta.url),
  'utf8',
);
/**
 * The record's own fields. The expectations below are read from it rather than
 * pinned to the build that was current when they were written: the point is
 * that the identity is composed from the record, and a literal here only means
 * the test is rewritten at every release.
 */
const RECORD = JSON.parse(SHIPPED) as {
  version: string;
  baseCommit: string;
  builtAt: string;
};
const HOME = 'C:\\Users\\BuildTest';
const EXE = `${HOME}\\AppData\\Local\\Diomedes\\Diomedes.exe`;

function identity(read: () => string | null, overrides: { version?: string; packaged?: boolean } = {}) {
  return buildIdentity({
    version: overrides.version ?? '0.1.4',
    read,
    execPath: EXE,
    home: HOME,
    packaged: overrides.packaged ?? false,
  });
}

describe('build identity', () => {
  test('the shipped build record names the version, commit and build time', () => {
    const build = identity(() => SHIPPED, { packaged: true });
    expect(build.source).toBe('build-record');
    expect(build.version).toBe(RECORD.version);
    expect(build.commit).toBe(RECORD.baseCommit);
    expect(build.buildId).toBe(`${RECORD.version}+${RECORD.baseCommit.slice(0, 12)}`);
    expect(build.builtAt).toBe(RECORD.builtAt);
    expect(build.sourceStatus).toBe('committed');
    expect(build.signing).toBe('unsigned-experimental');
    expect(build.channel).toBe('experimental');
    expect(build.packaged).toBe(true);
  });

  test('the committed record describes the version being built', () => {
    // A record left behind by an earlier release still parses, so no other test
    // here notices it is stale. The packaging step stamps this file and the
    // release commits it, so the two versions agreeing is what makes the record
    // this build's rather than the last one's.
    expect(RECORD.version).toBe(packageInfo.version);
  });

  test('the file list inside the record never travels with the identity', () => {
    const build = identity(() => SHIPPED, { packaged: true });
    const serialised = JSON.stringify(build);
    expect(serialised).not.toContain('client/ai-setup.css');
    expect(serialised).not.toContain('sourceDigest');
    expect(serialised.length).toBeLessThan(600);
  });

  test('no record means development, said plainly', () => {
    const build = identity(() => null);
    expect(build.source).toBe('development');
    expect(build.commit).toBeNull();
    expect(build.builtAt).toBeNull();
    expect(build.sourceStatus).toBeNull();
    expect(build.buildId).toBe('0.1.4+dev');
    expect(build.channel).toBe('development');
  });

  test('a packaged app with no record says packaged and development, not one or the other', () => {
    const build = identity(() => null, { packaged: true });
    expect(build.packaged).toBe(true);
    expect(build.source).toBe('development');
  });

  test.each([
    ['unparseable text', '{not json'],
    ['an array', '[]'],
    ['a null document', 'null'],
    ['a number for a version', JSON.stringify({ version: 5, baseCommit: 'a'.repeat(40) })],
    ['a commit that is not a commit', JSON.stringify({ version: '0.1.4', baseCommit: 'nope' })],
    ['a missing commit', JSON.stringify({ version: '0.1.4' })],
  ])('a record with %s is unreadable, never a build', (_label, text) => {
    const build = identity(() => text);
    expect(build.source).toBe('unreadable-record');
    expect(build.commit).toBeNull();
    expect(build.buildId).toBe('0.1.4+unknown');
    expect(build.version).toBe('0.1.4');
  });

  test('an oversized record is refused rather than parsed', () => {
    const padded = JSON.stringify({
      version: '0.1.4',
      baseCommit: 'e'.repeat(40),
      filler: 'x'.repeat(MAX_BUILD_RECORD_BYTES),
    });
    expect(padded.length).toBeGreaterThan(MAX_BUILD_RECORD_BYTES);
    expect(identity(() => padded).source).toBe('unreadable-record');
  });

  test('the record ceiling is measured in UTF-8 bytes, not UTF-16 units (DIO-88 class)', () => {
    // A valid record padded with 400,000 CJK characters: under the ceiling in
    // UTF-16 units, about 1.2 MB on disk.
    const wide = JSON.stringify({ ...RECORD, filler: '警'.repeat(400_000) });
    expect(wide.length).toBeLessThan(MAX_BUILD_RECORD_BYTES);
    expect(Buffer.byteLength(wide, 'utf8')).toBeGreaterThan(MAX_BUILD_RECORD_BYTES);
    expect(identity(() => wide).source).toBe('unreadable-record');
  });

  test('a reader that fails is unreadable, not development', () => {
    const build = identity(() => {
      throw new Error('EPERM: quarantined');
    });
    expect(build.source).toBe('unreadable-record');
  });

  test('an unknown signing string leaves the channel unknown rather than guessed', () => {
    const build = identity(() =>
      JSON.stringify({ version: '0.1.4', baseCommit: 'a'.repeat(40), signing: 'something-else' }),
    );
    expect(build.signing).toBe('something-else');
    expect(build.channel).toBe('unknown');
  });

  test('a channel written by the packaging script is preferred over the signing guess', () => {
    const build = identity(() =>
      JSON.stringify({
        version: '0.1.4',
        baseCommit: 'a'.repeat(40),
        signing: 'unsigned-experimental',
        channel: 'stable',
      }),
    );
    expect(build.channel).toBe('stable');
  });

  test('an unreadable build time is dropped, not carried as text', () => {
    const build = identity(() =>
      JSON.stringify({ version: '0.1.4', baseCommit: 'a'.repeat(40), builtAt: 'whenever' }),
    );
    expect(build.builtAt).toBeNull();
  });

  test('the launch target names the running executable with the home directory replaced', () => {
    const build = identity(() => null);
    expect(build.launchTarget).toBe('~\\AppData\\Local\\Diomedes\\Diomedes.exe');
    expect(build.launchTarget).not.toContain('BuildTest');
  });

  test('the home directory is replaced whatever case the executable path uses', () => {
    const build = buildIdentity({
      version: '0.1.4',
      read: () => null,
      execPath: 'c:\\users\\buildtest\\AppData\\Local\\Diomedes\\Diomedes.exe',
      home: HOME,
    });
    expect(build.launchTarget).toBe('~\\AppData\\Local\\Diomedes\\Diomedes.exe');
  });

  test('the record version wins, because it is the one the packaging step stamped', () => {
    const build = identity(() => SHIPPED, { version: '9.9.9' });
    expect(build.version).toBe(RECORD.version);
    expect(build.buildId).toBe(`${RECORD.version}+${RECORD.baseCommit.slice(0, 12)}`);
  });
});
