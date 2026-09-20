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
    { engine: 'claude-code', displayName: 'Claude Code', states: { packaged: { release: RELEASE } } },
    { engine: 'opencode', displayName: 'OpenCode', states: { packaged: { release: RELEASE } } },
    { engine: 'cursor', displayName: 'Cursor', states: { packaged: { release: RELEASE } } },
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
      capability: capability({
        routes: [
          { engine: 'devin', displayName: 'Devin', states: { packaged: { release: RELEASE } } },
        ],
      }),
    });
    expect(text).toContain('Devin');
    expect(text).not.toContain('OpenCode');
  });

  it('does not say this build carries a route the record does not place in it', () => {
    // The record keeps source and packaged apart for exactly this sentence. A
    // route whose adapter is in the tree but not in these bytes is named as
    // that, never as something the downloader can use.
    const text = readme({
      capability: capability({
        routes: [
          { engine: 'devin', displayName: 'Devin', states: { packaged: { release: RELEASE } } },
          { engine: 'cursor', displayName: 'Cursor', states: { packaged: null } },
        ],
      }),
    });
    expect(text).toMatch(/routes this build carries are Devin\b/);
    expect(text).toMatch(/Cursor[^\n]*not (recorded )?in this build|not in this build[^\n]*Cursor/i);
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

describe('the two facts the README used to state as literals', () => {
  it('names the Windows version the record carries, and none when it carries none', () => {
    const bare = readme();
    expect(bare).not.toContain('Windows 11 build 26200');
    expect(bare).toMatch(/Windows version[^\n]*NOT VERIFIED/i);
    const recorded = readme({
      record: { ...candidate(), host: { tested: 'Windows 11 build 26200' } },
    });
    expect(recorded).toContain('Tested on Windows 11 build 26200 only.');
  });

  it('reads the signing question from the record that answers it', () => {
    // The same field main() copies into the public manifest.
    const unsigned = readme({
      record: { ...candidate(), signing: { application: 'NotSigned', installer: 'NotSigned', publisher: null } },
    });
    expect(unsigned).toContain('NOT code signed');
    const signed = readme({
      record: {
        ...candidate(),
        signing: { application: 'Authenticode', installer: 'Authenticode', publisher: 'Diomedes Ltd' },
      },
    });
    expect(signed).not.toContain('NOT code signed');
    expect(signed).toContain('Diomedes Ltd');
    // A build whose record says nothing about signing decides nothing for it.
    const silent = readme();
    expect(silent).not.toContain('NOT code signed');
    expect(silent).toMatch(/signing[^\n]*NOT VERIFIED/i);
  });

  it('does not tell a reader of a signed build that unsigned programs are flagged', () => {
    const signed = readme({
      record: { ...candidate(), signing: { application: 'Authenticode', installer: 'Authenticode', publisher: 'Diomedes Ltd' } },
    });
    expect(signed).not.toContain('new unsigned programs');
    expect(signed).not.toContain('A signed build is being prepared');
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
