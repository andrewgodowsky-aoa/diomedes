/**
 * The three gates a release record carries that are proofs rather than test
 * reports: the packaged desktop smoke, the installer's install/repair/uninstall
 * proof, and the installed runtime.
 *
 * Through 0.1.5 the README printed all three as literals, so it claimed them
 * whatever had run. f143e9e made it read them from the record instead and print
 * a missing one as "NOT VERIFIED in this record". The reader is right, but
 * scripts/write-candidate-record.ts wrote nothing under `verification` for any
 * of them, and its top-level `installer` field describes the artifact, not a
 * test outcome. So from 0.1.6 on no README could claim them however much ran;
 * 0.1.6's printed all three as not verified.
 *
 * So the tests below come in two halves. The first holds each reader to
 * refusing a proof it cannot tie to this build — an unrun gate must never
 * become a pass. The second is the seam that actually failed: the writer's own
 * output is handed to the README generator, because each half was correct on
 * its own while nothing the writer produced could reach the reader.
 *
 * Nothing here writes a file or runs a proof. The readers are pure: each takes
 * a parsed report and the facts it must agree with, and hashes nothing itself.
 */
import { describe, expect, it } from 'vitest';
import {
  desktopSmokeOutcome,
  installedRuntimeOutcome,
  installerProofOutcome,
} from '../scripts/write-candidate-record.js';

const generator = (await import(
  new URL('../scripts/write-release-assets.mjs', import.meta.url).href
)) as { releaseReadme: (input: Record<string, unknown>) => string };

const VERSION = '9.9.9';
const RELEASE = `diomedes-${VERSION}-windows-experimental-20260920-0123456789ab`;
const COMMIT = '0123456789ab0123456789ab0123456789ab0123';
const EXE_SHA = 'a'.repeat(64);
const INSTALLER_SHA = 'b'.repeat(64);
const OTHER_SHA = 'c'.repeat(64);
const INSTALL_TARGET = String.raw`F:\wt\release\test-results\installer-proof\installation`;

const cite = { report: 'evidence/release-candidates/proof.json', reportSha256: 'd'.repeat(64) };

/** scripts/desktop-smoke.mjs writes this on its passing path, and only there. */
const desktopProof = (overrides: Record<string, unknown> = {}) => ({
  checkedAt: '2026-09-20T04:36:45.944Z',
  executablePath: String.raw`F:\wt\release\release\Diomedes-win32-x64\nectovia.exe`,
  executableSha256: EXE_SHA,
  passed: true,
  startup: { version: VERSION, pid: 32092, url: 'http://127.0.0.1:62481', packaged: true },
  taskCount: 4,
  rendererNodeDisabled: true,
  serviceStopsOnClose: true,
  dataLockReleased: true,
  persistedOnRestart: true,
  workAdmission: { lostResponsesRecovered: true, receiptsRetainedOnRestart: true },
  pageErrors: [],
  ...overrides,
});

/** scripts/verify-windows-installer.ps1 writes this; its `passed` can be false. */
const installerProof = (overrides: Record<string, unknown> = {}) => ({
  startedAt: '2026-09-20T06:36:23.014Z',
  installer: String.raw`F:\deliverables\Diomedes-Experimental-9.9.9-unsigned-setup.exe`,
  installerSha256: INSTALLER_SHA,
  installTarget: INSTALL_TARGET,
  registryKeys: [String.raw`HKCU:\Software\Diomedes\Experimental\Diomedes.Experimental.8c27d61a`],
  checks: [
    'Installed all payload files with identical SHA-256; both current-user keys and the Start Menu shortcut name this installation',
    'Installed executable passed full Connections desktop/crash/restart smoke with isolated profile',
    'Same-version repair install retained unknown data and isolated profile',
    'Uninstall removed only owned payload/registration/shortcut',
    'The registration found before the proof was handed back and reads back identical',
  ],
  passed: true,
  runtime: `${INSTALL_TARGET.replace('installation', 'runtime-proof')}\\proof.json`,
  registrationRestore: { result: 'restored', afterFailure: false },
  finishedAt: '2026-09-20T06:37:39.511Z',
});

/** scripts/connections-desktop-smoke.mjs against the installed copy. */
const runtimeProof = (overrides: Record<string, unknown> = {}) => ({
  startedAt: '2026-09-20T06:36:48.589Z',
  executablePath: `${INSTALL_TARGET}\\app\\nectovia.exe`,
  root: INSTALL_TARGET.replace('installation', 'runtime-proof'),
  checks: [
    'Incomplete natural-language intent remains inactive and asks for threshold/service window',
    'Registered prohibited write refused before handler, zero dispatches',
    'Revocation blocks reads and signed events using current host authority',
  ],
  errors: [],
  passed: true,
  launches: [{ pid: 44968, readyMs: 29326 }],
  version: VERSION,
  ...overrides,
});

const readDesktop = (proof: unknown) =>
  desktopSmokeOutcome(proof, { ...cite, appVersion: VERSION, executableSha256: EXE_SHA });
const readInstaller = (proof: unknown) =>
  installerProofOutcome(proof, { ...cite, installerSha256: INSTALLER_SHA });
const readRuntime = (proof: unknown, beside: unknown = installerProof()) =>
  installedRuntimeOutcome(proof, { ...cite, appVersion: VERSION, installerProof: beside });

describe('the packaged desktop smoke, read into a record', () => {
  it('records a real outcome from a real proof', () => {
    expect(readDesktop(desktopProof())).toMatchObject({
      result: 'passed',
      report: cite.report,
      reportSha256: cite.reportSha256,
      ranAt: '2026-09-20T04:36:45.944Z',
    });
  });

  it('refuses a proof that drove different bytes', () => {
    // The whole claim is "on these exact bytes". A smoke of the previous build
    // sitting at the same path is the failure this check exists for.
    expect(() => readDesktop(desktopProof({ executableSha256: OTHER_SHA }))).toThrow(/not this build's/);
  });

  it('refuses a proof that names no hash, rather than hashing the path it names', () => {
    // The path is the same string after a rebuild. Hashing it now would find
    // the new build, match the record, and pass a smoke that only ever ran on
    // the old one — so a proof from before the smoke recorded its hash is
    // refused, and the operator re-runs the smoke on the bytes being named.
    const { executableSha256: _dropped, ...older } = desktopProof();
    expect(() => readDesktop(older)).toThrow(/Re-run npm run test:desktop/);
    expect(() => readDesktop(desktopProof({ executableSha256: '' }))).toThrow(/names no executableSha256/);
  });

  it('refuses a proof that recorded a page error or a false assertion', () => {
    expect(() => readDesktop(desktopProof({ pageErrors: ['TypeError: x'] }))).toThrow(/records 1/);
    expect(() => readDesktop(desktopProof({ dataLockReleased: false }))).toThrow(/dataLockReleased/);
  });

  it('refuses a proof of another version, and anything that is not a proof', () => {
    expect(() => readDesktop(desktopProof({ startup: { version: '9.9.8' } }))).toThrow(/9\.9\.8/);
    expect(() => readDesktop('passed')).toThrow(/not a JSON object/);
    const { pageErrors: _dropped, ...silent } = desktopProof();
    expect(() => readDesktop(silent)).toThrow(/pageErrors/);
  });
});

describe("the installer's install, repair and uninstall proof", () => {
  it('records a real outcome, and how many checks it ran', () => {
    expect(readInstaller(installerProof())).toMatchObject({ result: 'passed', checks: 5 });
  });

  it('refuses the proof it writes when the run failed', () => {
    // verify-windows-installer.ps1 sets passed=false when the body, a check or
    // the registration hand-back failed, and still writes the file.
    expect(() => readInstaller({ ...installerProof(), passed: false })).toThrow(/passed is false/);
  });

  it('refuses a proof of an installer this record did not hash', () => {
    expect(() => readInstaller({ ...installerProof(), installerSha256: OTHER_SHA })).toThrow(
      /not the one this record hashed/,
    );
  });

  it('refuses a proof that never ran a check', () => {
    expect(() => readInstaller({ ...installerProof(), checks: [] })).toThrow(/not a completed run/);
  });
});

describe('the installed runtime proof', () => {
  it('records a real outcome beside the installer proof that produced it', () => {
    expect(readRuntime(runtimeProof())).toMatchObject({ result: 'passed', checks: 3 });
  });

  it('refuses a runtime that was not the installed one', () => {
    // Without this, a run against the build directory — or any other Diomedes
    // on the machine — would be recorded as the installed runtime.
    expect(() =>
      readRuntime(runtimeProof({ executablePath: String.raw`F:\wt\release\release\Diomedes-win32-x64\nectovia.exe` })),
    ).toThrow(/not inside the installer proof's install target/);
  });

  it('refuses a failed or wrong-version run', () => {
    expect(() => readRuntime(runtimeProof({ passed: false }))).toThrow(/passed is false/);
    expect(() => readRuntime(runtimeProof({ errors: ['crash'] }))).toThrow(/records 1/);
    expect(() => readRuntime(runtimeProof({ version: '9.9.8' }))).toThrow(/9\.9\.8/);
  });

  it('refuses one with no installer proof beside it', () => {
    expect(() => readRuntime(runtimeProof(), null)).toThrow(/installer proof/);
  });
});

/**
 * The seam. Each half was correct on its own while no gate the writer could
 * record would ever reach the reader, so the check that matters is that what
 * the writer emits is what the reader prints.
 */
describe('what the README says about a record written this way', () => {
  const capability = {
    appVersion: VERSION,
    generatedFrom: { commit: COMMIT },
    release: { releaseId: RELEASE, appVersionMatchesSource: true },
    routes: [{ engine: 'claude-code', displayName: 'Claude Code', states: { packaged: { release: RELEASE } } }],
    notProven: ['No clean Windows standard-user install of the exact published artifact has been run for any route.'],
  };
  const readme = (verification: Record<string, unknown>) =>
    generator.releaseReadme({
      record: {
        releaseId: RELEASE,
        named: true,
        appVersion: VERSION,
        channel: 'experimental',
        build: { baseCommit: COMMIT, builtAt: '2026-09-20T00:00:00.000Z' },
        verification: {
          typecheck: 'passed',
          unit: { passed: 4001, failed: 0, files: 206 },
          browser: { expected: 126, unexpected: 0 },
          ...verification,
        },
      },
      capability,
      tag: `v${VERSION}-experimental.1`,
      installerName: `Diomedes-Experimental-${VERSION}-unsigned-setup.exe`,
      zipName: `Diomedes-Experimental-${VERSION}-win32-x64.zip`,
      launcherName: 'Start-Experimental.ps1',
      notes: 'UPDATES\n  Nothing in this build changes the update channel.',
    });
  const verified = (text: string) => text.slice(text.indexOf('WHAT WAS VERIFIED'));

  const LABELS = [
    'packaged desktop smoke',
    "installer's install, same-version repair and uninstall",
    'installed runtime',
  ];

  it('prints every gate as not verified when no flag recorded one', () => {
    // This is what 0.1.6's README printed, and it must stay true for a record
    // that carries no proof: the conservative default is the point.
    const block = verified(readme({}));
    for (const label of LABELS)
      expect(block, label).toMatch(new RegExp(`${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[^\\n]*NOT VERIFIED`, 'i'));
  });

  it('prints the outcome of every gate the readers recorded', () => {
    const block = verified(
      readme({
        desktopSmoke: readDesktop(desktopProof()),
        installer: readInstaller(installerProof()),
        installedRuntime: readRuntime(runtimeProof()),
      }),
    );
    expect(block).not.toMatch(/NOT VERIFIED/);
    for (const label of LABELS)
      expect(block, label).toMatch(new RegExp(`${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}: passed`, 'i'));
  });

  it('withdraws only the gate that was not run', () => {
    // A release that ran the desktop smoke but not the installer proof says so
    // about the installer alone, and still claims the smoke.
    const block = verified(readme({ desktopSmoke: readDesktop(desktopProof()) }));
    expect(block).toMatch(/packaged desktop smoke: passed/i);
    expect(block).toMatch(/installed runtime[^\n]*NOT VERIFIED/i);
  });

  it('leaves no local path in the README through a gate it recorded', () => {
    // The record is cited by repository path or bare filename; a gate must not
    // be the way one machine's drive letters reach a published document.
    const block = verified(
      readme({
        desktopSmoke: readDesktop(desktopProof()),
        installer: readInstaller(installerProof()),
        installedRuntime: readRuntime(runtimeProof()),
      }),
    );
    expect(block).not.toMatch(/[A-Za-z]:\\/);
  });
});
