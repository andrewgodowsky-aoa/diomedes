/**
 * The release README still states two verification claims as literals.
 *
 * `scripts/write-release-assets.mjs:30-35` says of itself: "The README's every
 * claim comes from two records: the candidate record for this build, and
 * docs/reference/capability-record.json for the routes and for what is still
 * unproven. A fact neither record carries is printed as not verified." That
 * rule is kept for the engine list and for the WHAT WAS VERIFIED block, and
 * broken twice above them:
 *
 *   :142  "Tested on Windows 11 build 26200 only. Other Windows versions are
 *          unverified." — no record is consulted. A candidate recorded on any
 *          other host prints this sentence unchanged.
 *   :158  "It does not prove who built it: this build is NOT code signed." —
 *          the record carries `signing`, and `main()` copies that same field
 *          into the public manifest at :321. The README ignores it.
 *
 * Both are the same defect the file's own header says it exists to end: a
 * verification claim that a reader trusts, written by hand, that outlives the
 * build it was written for. Red here means the literals are still in the text.
 */
import { describe, expect, it } from 'vitest';

const generator = (await import(
  new URL('../scripts/write-release-assets.mjs', import.meta.url).href
)) as { releaseReadme: (input: Record<string, unknown>) => string };

const RELEASE = 'diomedes-9.9.9-windows-experimental-20260920-0123456789ab';
const COMMIT = '0123456789ab0123456789ab0123456789ab0123';

const candidate = (overrides: Record<string, unknown> = {}) => ({
  releaseId: RELEASE,
  named: true,
  appVersion: '9.9.9',
  channel: 'experimental',
  product: 'Diomedes',
  build: { baseCommit: COMMIT, builtAt: '2026-09-20T00:00:00.000Z' },
  signing: 'unsigned-experimental',
  verification: {
    typecheck: 'passed',
    unit: { passed: 10, failed: 0, files: 2 },
    browser: { expected: 4, unexpected: 0 },
  },
  ...overrides,
});

const capability = (overrides: Record<string, unknown> = {}) => ({
  appVersion: '9.9.9',
  generatedFrom: { commit: COMMIT },
  release: { releaseId: RELEASE, appVersionMatchesSource: true },
  routes: [
    {
      engine: 'opencode',
      displayName: 'OpenCode',
      states: { packaged: { release: RELEASE } },
    },
  ],
  notProven: ['Nothing about a clean machine is recorded here.'],
  ...overrides,
});

const readme = (record: Record<string, unknown>, cap = capability()) =>
  generator.releaseReadme({
    record,
    capability: cap,
    tag: 'v9.9.9-experimental.1',
    installerName: 'Diomedes-Experimental-9.9.9-unsigned-setup.exe',
    zipName: 'Diomedes-Experimental-9.9.9-win32-x64.zip',
    launcherName: 'Start-Experimental.ps1',
    notes: 'UPDATES\n  Fixture notes.\n',
  });

describe('the generated README and the records it says it reads', () => {
  it('does not name a tested Windows build no record carries', () => {
    const text = readme(candidate());
    expect(
      text,
      'the candidate record carries no host or tested-Windows fact, yet the README names one',
    ).not.toContain('Windows 11 build 26200');
  });

  it('does not decide the signing question without reading the record that answers it', () => {
    // The same field `main()` copies into the public manifest at :321.
    const signed = candidate({ signing: 'authenticode-ev' });
    const text = readme(signed);
    expect(
      text,
      'a record that says the build is signed still produces "NOT code signed"',
    ).not.toContain('NOT code signed');
  });
});
