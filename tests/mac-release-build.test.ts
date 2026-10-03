/**
 * scripts/release-support/build-mac-release.mjs builds the Apple silicon image on a person's
 * Mac. Its shell steps need macOS; these tests hold the parts that decide what gets published:
 * the host it accepts, how it names the Mac, and the proof write-release-assets.mjs reads.
 */
import { describe, expect, it } from 'vitest';

const build = (await import(new URL('../scripts/release-support/build-mac-release.mjs', import.meta.url).href)) as {
  BUNDLE_SIGNATURE: string;
  checkHost: (host: { platform: string; arch: string; machine: string; nodeVersion: string }) => void;
  parseHardware: (text: string) => { modelName: string | null; chip: string | null };
  machineDescription: (input: { modelName: string | null; chip: string | null; productVersion: string }) => string;
  signatureFacts: (input: { verifyStatus: number | null; assessStatus: number | null; display: string; verify: string; spctl: string }) => Record<string, unknown> & {
    bundleSignatureVerifies: boolean;
    codesignDisplay: string;
    codesignVerify: string;
  };
  macReleaseProof: (input: Record<string, unknown>) => Record<string, unknown> & {
    hostedRunner: boolean;
    build: Record<string, unknown>;
  };
};
const assets = (await import(new URL('../scripts/write-release-assets.mjs', import.meta.url).href)) as {
  macLaunchOutcome: (proof: unknown, version: string) => { result: string };
};

const VERSION = '0.2.2';
const COMMIT = '0123456789abcdef0123456789abcdef01234567';
const APP = '/Users/someone/dev/diomedes-mac/release/Diomedes-darwin-arm64/Diomedes.app';
const launch = {
  startedAt: '2026-10-03T12:00:00.000Z',
  passed: true,
  platform: 'darwin',
  arch: 'arm64',
  appVersion: VERSION,
  health: { version: VERSION },
  pageErrors: [],
  checks: ['window loaded', 'signed in', 'health inside', '401 outside', 'clean quit'],
};
const buildInfo = {
  baseCommit: COMMIT,
  sourceStatus: 'committed',
  sourceDigest: 'f'.repeat(64),
  electronVersion: '44.2.0',
  macFrameworkSignature: 'ad-hoc, restored by @electron/packager',
};
const facts = (verifyStatus: number) =>
  build.signatureFacts({
    verifyStatus,
    assessStatus: 3,
    display: `Executable=${APP}/Contents/MacOS/Diomedes\nIdentifier=com.electron.diomedes\nSignature=adhoc\n`,
    verify: verifyStatus === 0 ? `${APP}: valid on disk\n${APP}: satisfies its Designated Requirement\n` : `${APP}: code has no resources but signature indicates they must be present\n`,
    spctl: `${APP}: rejected\nsource=no usable signature\n`,
  });
const proof = (verifyStatus = 0) =>
  build.macReleaseProof({
    launch,
    buildInfo,
    signature: facts(verifyStatus),
    dmgName: `Diomedes-Experimental-${VERSION}-mac-arm64.dmg`,
    dmgBytes: 145_000_000,
    dmgSha256: 'a'.repeat(64),
    testedOn: 'a MacBook Air (Apple M2) with macOS 26.2',
  });

describe('the Mac release build', () => {
  it('runs only on Apple silicon with a native arm64 Node 22', () => {
    const mac = { platform: 'darwin', arch: 'arm64', machine: 'arm64', nodeVersion: 'v22.23.2' };
    expect(() => build.checkHost(mac)).not.toThrow();
    expect(() => build.checkHost({ ...mac, platform: 'win32' })).toThrow('Apple silicon');
    expect(() => build.checkHost({ ...mac, arch: 'x64' })).toThrow('native arm64');
    expect(() => build.checkHost({ ...mac, machine: 'x86_64' })).toThrow('Apple silicon');
    expect(() => build.checkHost({ ...mac, nodeVersion: 'v24.1.0' })).toThrow('Node 22');
  });

  it("names the Mac from system_profiler's hardware overview", () => {
    const overview = [
      'Hardware:',
      '',
      '    Hardware Overview:',
      '',
      '      Model Name: MacBook Air',
      '      Model Identifier: Mac14,2',
      '      Chip: Apple M2',
      '      Total Number of Cores: 8 (4 performance and 4 efficiency)',
      '      Memory: 8 GB',
    ].join('\n');
    const hardware = build.parseHardware(overview);
    expect(hardware).toEqual({ modelName: 'MacBook Air', chip: 'Apple M2' });
    expect(build.machineDescription({ ...hardware, productVersion: '26.2' })).toBe('a MacBook Air (Apple M2) with macOS 26.2');
    expect(build.machineDescription({ modelName: null, chip: null, productVersion: '26.2' })).toBe('a Mac with macOS 26.2');
  });

  it('keeps no local path in the signature facts', () => {
    const signature = facts(0);
    expect(signature.bundleSignatureVerifies).toBe(true);
    expect(signature.codesignDisplay).not.toContain('Executable=');
    expect(signature.codesignVerify.startsWith('Diomedes.app: valid on disk')).toBe(true);
    expect(JSON.stringify(signature)).not.toContain('/Users/');
  });

  it('writes a proof write-release-assets accepts, marked as run on a Mac', () => {
    const written = proof();
    expect(assets.macLaunchOutcome(written, VERSION).result).toBe('passed');
    expect(written.hostedRunner).toBe(false);
    expect(written.build).toEqual(buildInfo);
    expect(written.bundleSignature).toBe(build.BUNDLE_SIGNATURE);
    expect(written).toMatchObject({ dmg: `Diomedes-Experimental-${VERSION}-mac-arm64.dmg`, dmgBytes: 145_000_000, dmgSha256: 'a'.repeat(64) });
  });

  it('writes a proof write-release-assets refuses when the bundle signature does not verify', () => {
    expect(() => assets.macLaunchOutcome(proof(1), VERSION)).toThrow('code has no resources');
  });
});
