/**
 * The README that travels beside an installer is the only document most people
 * who download a build will read, and it is generated. These tests hold its
 * generator to one rule: every claim in it comes from a record, and a fact no
 * record carries is printed as not verified rather than quietly left out.
 *
 * Audit finding F09: the installer proof is not first-customer proof. The
 * previous text stated the desktop smoke, the installer's install, repair and
 * uninstall and the installed runtime as literals, printed whatever ran.
 *
 * Nothing here writes a file. The generator's pure text builder is called with
 * fixture records; the script's own IO is not exercised.
 */
import { describe, expect, it } from 'vitest';

const generator = (await import(
  new URL('../scripts/write-release-assets.mjs', import.meta.url).href
)) as { releaseReadme: (input: Record<string, unknown>) => string };

const RELEASE = 'diomedes-9.9.9-windows-experimental-20260920-0123456789ab';
const COMMIT = '0123456789ab0123456789ab0123456789ab0123';

const candidate = (verification: Record<string, unknown> = {}) => ({
  releaseId: RELEASE,
  named: true,
  appVersion: '9.9.9',
  channel: 'experimental',
  build: { baseCommit: COMMIT, builtAt: '2026-09-20T00:00:00.000Z' },
  verification: {
    typecheck: 'passed',
    unit: { passed: 2239, failed: 0, files: 122 },
    browser: { expected: 104, unexpected: 0 },
    ...verification,
  },
});

const capability = (overrides: Record<string, unknown> = {}) => ({
  appVersion: '9.9.9',
  generatedFrom: { commit: COMMIT },
  release: { releaseId: RELEASE, appVersionMatchesSource: true },
  routes: [
    { engine: 'claude-code', displayName: 'Claude Code' },
    { engine: 'opencode', displayName: 'OpenCode' },
    { engine: 'cursor', displayName: 'Cursor' },
  ],
  notProven: [
    'No clean Windows standard-user install of the exact published artifact has been run for any route.',
    'No real consented provider result through one of these routes is recorded here.',
  ],
  ...overrides,
});

const readme = (input: Record<string, unknown> = {}) =>
  generator.releaseReadme({
    record: candidate(),
    capability: capability(),
    tag: 'v9.9.9-experimental.1',
    installerName: 'Diomedes-Experimental-9.9.9-unsigned-setup.exe',
    zipName: 'Diomedes-Experimental-9.9.9-win32-x64.zip',
    launcherName: 'Start-Experimental.ps1',
    notes: 'UPDATES\n  Nothing in this build changes the update channel.',
    ...input,
  });

describe('the engines a release README may name', () => {
  it('names the routes the capability record carries', () => {
    const text = readme();
    for (const route of capability().routes) expect(text, route.engine).toContain(route.displayName);
  });

  it('names no engine the record does not carry', () => {
    // AGENTS.md: Diomedes ships adapters, not engines, and nothing in the tree
    // claims a capability that is not there. The record has five routes and no
    // Codex row; the generated text used to list Codex first.
    expect(readme()).not.toMatch(/codex/i);
  });

  it('follows the record when a route is removed from it', () => {
    const text = readme({
      capability: capability({ routes: [{ engine: 'devin', displayName: 'Devin' }] }),
    });
    expect(text).toContain('Devin');
    expect(text).not.toContain('OpenCode');
  });
});

describe('what the README may say was verified', () => {
  it('prints a verification the record does not carry as not verified', () => {
    const text = readme();
    for (const claim of [
      'packaged desktop smoke',
      "installer's install, same-version repair and uninstall",
      'installed runtime',
    ])
      expect(text.slice(text.indexOf('WHAT WAS VERIFIED')), claim).toMatch(
        new RegExp(`${claim.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[^\\n]*NOT VERIFIED`, 'i'),
      );
  });

  it('prints one the record does carry, as the record states it', () => {
    const text = readme({
      record: candidate({
        desktopSmoke: { passed: true },
        installer: 'install, repair and uninstall passed',
        installedRuntime: { result: 'passed' },
      }),
    });
    const block = text.slice(text.indexOf('WHAT WAS VERIFIED'));
    expect(block).not.toMatch(/NOT VERIFIED/);
    expect(block).toContain('install, repair and uninstall passed');
  });

  it('states the counts the record recorded, and no count it did not', () => {
    const text = readme();
    expect(text).toContain('2239');
    expect(text).toContain('104');
    const bare = readme({ record: { ...candidate(), verification: {} } });
    expect(bare.slice(bare.indexOf('WHAT WAS VERIFIED'))).not.toContain('2239');
    expect(bare).toMatch(/unit tests[^\n]*NOT VERIFIED/i);
  });
});

describe('what the README must not leave behind in the repository', () => {
  it('carries every sentence the capability record says is not proven', () => {
    const text = readme();
    for (const sentence of capability().notProven) expect(text).toContain(sentence);
  });

  it('says when the newest recorded build is not the source tree it was checked against', () => {
    const text = readme({
      capability: capability({
        appVersion: '9.9.10',
        release: { releaseId: RELEASE, appVersionMatchesSource: false },
      }),
    });
    expect(text).toMatch(/source[^\n]*different version|different version[^\n]*source/i);
  });

  it('refuses to describe a build the capability record does not name', () => {
    // The record's release facts are about the newest named candidate. Printing
    // them beside a different build would carry one build's proof onto another.
    expect(() =>
      readme({ capability: capability({ release: { releaseId: 'another-release' } }) }),
    ).toThrow(/capability-record/);
  });
});
