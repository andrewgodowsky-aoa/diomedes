/**
 * The 0.2.0 release shape against the updaters that will read it.
 *
 * An installed 0.1.x reads GitHub's `releases/latest` for this repository, keeps
 * the one asset named `Diomedes-Experimental-<X.Y.Z>-unsigned-setup.exe`, and
 * accepts the download only when its SHA-256 equals that asset's GitHub `digest`
 * (`sha256:<hex>`). It never reads release-manifest.json. The Windows half of
 * this file therefore runs the 0.1.11 code itself: tests/fixtures/updater-0.1.11
 * is shared/app-updates.ts exactly as release commit a492c42 shipped it, pinned
 * by hash below so an edit to it fails here instead of passing quietly.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import * as installed0111 from './fixtures/updater-0.1.11/app-updates.js';
import {
  UPDATE_ASSET_PATTERN,
  UPDATE_MAC_ASSET_PATTERN,
  selectMacAsset,
  selectReleaseAsset,
} from '../shared/app-updates.js';
import { AppUpdateService } from '../server/app-updates.js';

const assets = (await import(new URL('../scripts/write-release-assets.mjs', import.meta.url).href)) as {
  TAG: RegExp;
  releaseAssetNames: (version: string) => Record<string, string>;
  releaseManifest: (input: Record<string, unknown>) => Record<string, unknown> & {
    artifacts: { kind: string; filename: string; sha256: string }[];
    platform: { os: string };
  };
  macLaunchOutcome: (proof: unknown, version: string) => { result: string };
};
const body = (await import(new URL('../scripts/release-support/release-body.mjs', import.meta.url).href)) as {
  releaseNotes: (input: Record<string, unknown>) => { text: string; source: string };
  releaseBody: (input: { version: string; readme: string }) => string;
  parseReleaseVersion: (value: string) => { base: string; candidate: number | null };
};

const FIXTURE_SHA256 = '3141076e5bef4c82c9e447c3406432235e31b3978f2aa5e28996cfcd2f9e5aca';
const VERSION = '0.2.0';
const TAG = `v${VERSION}`;
const OWNER_REPO = 'andrewgodowsky-aoa/diomedes';
const names = assets.releaseAssetNames(VERSION);
const sha = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
// Small stand-ins above the updater's 1 MiB floor; only their digests matter here.
const installerBytes = new Uint8Array(2 * 1024 * 1024).fill(7);
const dmgBytes = new Uint8Array(3 * 1024 * 1024).fill(9);

/** A `releases/latest` body as GitHub returns it for the asset set the workflow uploads. */
function latestRelease(overrides: Record<string, unknown> = {}) {
  const asset = (name: string, bytes: Uint8Array | number) => ({
    name,
    size: typeof bytes === 'number' ? bytes : bytes.length,
    digest: `sha256:${typeof bytes === 'number' ? 'ab'.repeat(32) : sha(bytes)}`,
    browser_download_url: `https://github.com/${OWNER_REPO}/releases/download/${TAG}/${name}`,
  });
  return {
    tag_name: TAG,
    html_url: `https://github.com/${OWNER_REPO}/releases/tag/${TAG}`,
    draft: false,
    prerelease: false,
    assets: [
      asset(names.zip, 269_000_000),
      asset(names.installer, installerBytes),
      asset(names.macDmg, dmgBytes),
      asset(names.launcher, 1421),
      asset(names.readme, 9000),
      asset(names.manifest, 4000),
      asset(names.sums, 600),
    ],
    ...overrides,
  };
}

describe('the frozen 0.1.11 updater', () => {
  it('is the file release commit a492c42 shipped', async () => {
    // Hashed as Git stores it: a Windows checkout may hand the file back with CRLF.
    const text = await fs.readFile(path.join(import.meta.dirname, 'fixtures/updater-0.1.11/app-updates.ts'), 'utf8');
    expect(sha(Buffer.from(text.replace(/\r\n/g, '\n')))).toBe(FIXTURE_SHA256);
  });

  it('finds the Windows installer, and only it, in a release that also carries macOS', () => {
    const parsed = installed0111.selectWindowsAsset(latestRelease());
    expect(parsed.version).toBe(VERSION);
    expect(parsed.draft).toBe(false);
    expect(parsed.prerelease).toBe(false);
    expect(parsed.asset?.name).toBe(names.installer);
    expect(parsed.asset?.url).toBe(`https://github.com/${OWNER_REPO}/releases/download/${TAG}/${names.installer}`);
    // The digest it will hold the download to is GitHub's digest of the installer.
    expect(parsed.publishedDigest).toBe(sha(installerBytes));
  });

  it('accepts the installer bytes by that digest and would refuse any other bytes', () => {
    const parsed = installed0111.selectWindowsAsset(latestRelease());
    expect(sha(installerBytes)).toBe(parsed.publishedDigest);
    expect(sha(dmgBytes)).not.toBe(parsed.publishedDigest);
  });

  it('cannot read the macOS image, or a release candidate tag, as a Windows update', () => {
    expect(installed0111.UPDATE_ASSET_PATTERN.test(names.macDmg)).toBe(false);
    expect(installed0111.UPDATE_ASSET_PATTERN.test(names.zip)).toBe(false);
    expect(installed0111.parseStableVersion('v0.2.0-rc.1')).toBeNull();
    // A candidate is only ever a draft or a prerelease, which releases/latest never returns;
    // were one returned anyway, the check fails closed instead of offering it.
    expect(() => installed0111.selectWindowsAsset(latestRelease({ tag_name: 'v0.2.0-rc.1' }))).toThrow(
      'unparsable version',
    );
  });

  it('agrees with the pattern this build ships', () => {
    expect(String(UPDATE_ASSET_PATTERN)).toBe(String(installed0111.UPDATE_ASSET_PATTERN));
  });
});

/** A fresh data folder under test-results, which a clean checkout does not have yet. */
async function updaterDataDir() {
  const root = path.join(process.cwd(), 'test-results');
  await fs.mkdir(root, { recursive: true });
  return fs.mkdtemp(path.join(root, 'updater-compat-'));
}

describe('a macOS updater', () => {
  it('picks the disk image, with its own digest', () => {
    const parsed = selectReleaseAsset(latestRelease(), 'darwin');
    expect(parsed.asset?.name).toBe(names.macDmg);
    expect(parsed.publishedDigest).toBe(sha(dmgBytes));
    expect(selectReleaseAsset(latestRelease(), 'win32').asset?.name).toBe(names.installer);
  });

  it('reports no asset for a Windows-only release rather than offering the installer', () => {
    const windowsOnly = latestRelease();
    windowsOnly.assets = windowsOnly.assets.filter((entry) => entry.name !== names.macDmg);
    expect(selectMacAsset(windowsOnly).asset).toBeNull();
  });

  it('fails closed on an image without GitHub’s digest', () => {
    const release = latestRelease();
    const dmg = release.assets.find((entry) => entry.name === names.macDmg)!;
    dmg.digest = '';
    expect(() => selectMacAsset(release)).toThrow('a disk image without an exact asset digest');
  });

  it('checks on macOS, and sends a person to the release page instead of downloading', async () => {
    const dataDir = await updaterDataDir();
    let downloads = 0;
    const service = new AppUpdateService({
      currentVersion: '0.1.11',
      dataDir,
      platform: 'darwin',
      packaged: true,
      isBusy: () => false,
      transport: {
        fetchRelease: async () => latestRelease(),
        downloadAsset: async () => {
          downloads += 1;
          return { bytes: dmgBytes, finalUrl: '' };
        },
      },
    });
    const check = await service.check();
    expect(check.outcome).toBe('available');
    expect(check.latestVersion).toBe(VERSION);
    expect(check.detail).toContain('release page');
    expect((await service.status()).download.ready).toBe(false);
    await expect(service.download()).rejects.toThrow('On macOS');
    expect(downloads).toBe(0);
    await fs.rm(dataDir, { recursive: true, force: true });
  });

  it('leaves a Windows copy downloading and verifying the installer by its digest', async () => {
    const dataDir = await updaterDataDir();
    const release = latestRelease();
    const service = new AppUpdateService({
      currentVersion: '0.1.11',
      dataDir,
      platform: 'win32',
      packaged: true,
      installed: true,
      isBusy: () => false,
      transport: {
        fetchRelease: async () => release,
        downloadAsset: async (url) => {
          expect(url).toContain(names.installer);
          return { bytes: installerBytes, finalUrl: url };
        },
      },
    });
    expect((await service.check()).outcome).toBe('available');
    await expect(service.download()).resolves.toEqual({ downloaded: true, version: VERSION });
    const status = await service.status();
    expect(status.download.assetName).toBe(names.installer);
    expect(status.download.sha256).toBe(sha(installerBytes));
    await fs.rm(dataDir, { recursive: true, force: true });
  });
});

describe('the public manifest and asset names', () => {
  const record = {
    product: 'Diomedes',
    releaseId: 'diomedes-0.2.0-windows-experimental-20260925-0123456789ab',
    appVersion: VERSION,
    channel: 'experimental',
    build: { baseCommit: '0123456789ab'.padEnd(40, '0'), sourceStatus: 'committed', sourceDigest: 'd', builtAt: 't', identityEmbeddedIn: 'resources/app.asar:BUILD_INFO.json' },
    package: { electron: '44.2.0', executableSha256: 'e', asarSha256: 'a' },
    nativeRuntime: { version: '0.153.4' },
    protocols: {},
    installer: { appTreeSha256: 'p', productId: 'Diomedes.Experimental.8c27d61a-1919-4b12-9df7-20260909e001', compiler: { name: 'NSIS', version: '3.12' } },
    signing: { application: 'NotSigned', installer: 'NotSigned', publisher: null },
    verification: { typecheck: 'passed', unit: { passed: 1, failed: 0, files: 1 }, browser: { expected: 1, unexpected: 0 } },
    host: { tested: 'Windows Server 2022' },
  };
  const artifact = (kind: string, filename: string) => ({ kind, filename, bytes: 1, sha256: 'f'.repeat(64) });

  it('keeps every Windows field the 0.1.11 manifest had, and adds macOS as one more artifact', () => {
    const manifest = assets.releaseManifest({
      record,
      tag: TAG,
      artifacts: [
        artifact('portable-zip', names.zip),
        artifact('per-user-installer', names.installer),
        artifact('macos-disk-image', names.macDmg),
      ],
      support: artifact('optional-isolated-launcher', names.launcher),
      generatedAt: 't',
    });
    for (const key of ['schemaVersion', 'product', 'releaseId', 'tag', 'appVersion', 'channel', 'build', 'platform', 'runtime', 'protocols', 'artifacts', 'supportFiles', 'internalPackageHashes', 'installer', 'signing', 'verification', 'generatedAt', 'generatedBy'])
      expect(manifest).toHaveProperty(key);
    expect(manifest.schemaVersion).toBe(2);
    expect(manifest.platform.os).toBe('Windows');
    const installers = manifest.artifacts.filter((entry) => installed0111.UPDATE_ASSET_PATTERN.test(entry.filename));
    expect(installers.map((entry) => entry.kind)).toEqual(['per-user-installer']);
    expect(manifest.artifacts.filter((entry) => UPDATE_MAC_ASSET_PATTERN.test(entry.filename)).map((entry) => entry.kind)).toEqual(['macos-disk-image']);
    expect(manifest.platforms).toEqual(['windows', 'macos']);
  });

  it('names Windows and macOS files apart', () => {
    expect(names.zip).toContain('win32-x64');
    expect(names.macDmg).toContain('mac-arm64');
    expect(UPDATE_MAC_ASSET_PATTERN.test(names.macDmg)).toBe(true);
    expect(UPDATE_ASSET_PATTERN.test(names.installer)).toBe(true);
  });

  it('accepts stable, experimental and release-candidate tags for the same version', () => {
    for (const tag of ['v0.2.0', 'v0.2.0-experimental.1', 'v0.2.0-rc.1']) expect(assets.TAG.exec(tag)?.[1]).toBe(VERSION);
    expect(assets.TAG.test('v0.2.0-beta.1')).toBe(false);
  });

  it('publishes a macOS image only beside a passing darwin/arm64 launch proof of this version whose bundle signature verifies', () => {
    const proof = { passed: true, platform: 'darwin', arch: 'arm64', appVersion: VERSION, health: { version: VERSION }, pageErrors: [], checks: ['x'], signature: { bundleSignatureVerifies: true } };
    expect(assets.macLaunchOutcome(proof, VERSION).result).toBe('passed');
    expect(() => assets.macLaunchOutcome({ ...proof, passed: false, error: 'no window' }, VERSION)).toThrow('no window');
    expect(() => assets.macLaunchOutcome({ ...proof, arch: 'x64' }, VERSION)).toThrow('darwin/arm64');
    expect(() => assets.macLaunchOutcome({ ...proof, health: { version: '0.1.11' } }, VERSION)).toThrow('0.1.11');
    // What the 0.2.0-rc.1 proof run recorded: the app launched, but its bundle signature did not verify.
    const unsealed = { ...proof, signature: { bundleSignatureVerifies: false, codesignVerify: 'Diomedes.app: code has no resources but signature indicates they must be present' } };
    expect(() => assets.macLaunchOutcome(unsealed, VERSION)).toThrow('code has no resources');
    expect(() => assets.macLaunchOutcome({ ...proof, signature: undefined }, VERSION)).toThrow('does not verify');
  });
});

describe('the release notes and body', () => {
  const releases = {
    schemaVersion: 1,
    releases: [
      {
        version: '0.2.0',
        date: '2026-09-25',
        channel: 'draft',
        platforms: ['windows'],
        headline: 'Automations arrive.',
        sections: [
          { title: 'New', items: ['Run once.'] },
          { title: 'Known limits', items: ['Unsigned and experimental.'] },
        ],
      },
      { version: '0.1.11', date: '2026-09-24', channel: 'stable', platforms: ['windows'], headline: 'Older.', sections: [] },
    ],
  };

  it('draws a candidate from releases.json by its base version, in the README sections', () => {
    const { text, source } = body.releaseNotes({ version: '0.2.0-rc.1', releases, notes: 'WHAT IS NEW\n  x' });
    expect(source).toBe('resources/release-notes/releases.json');
    expect(text).toBe('WHAT IS NEW\n  Automations arrive.\n\n  Run once.\n\nLIMITS\n  Unsigned and experimental.');
    expect(text).not.toContain('Older.');
  });

  it('falls back to the notes file when releases.json lacks the version or is absent', () => {
    const { text, source } = body.releaseNotes({ version: '0.2.0', releases: null, notes: 'WHAT IS NEW\r\n  x\r\n' });
    expect(source).toBe('docs/releases/notes/v0.2.0.txt');
    expect(text).toBe('WHAT IS NEW\n  x');
  });

  it('refuses to publish with no notes at all, and refuses a version it cannot read', () => {
    expect(() => body.releaseNotes({ version: '0.2.0' })).toThrow('No release notes');
    expect(() => body.parseReleaseVersion('0.2')).toThrow();
  });

  it('is the README, which the update check reads from WHAT IS NEW on', async () => {
    const { notesFromReleaseBody } = await import('../shared/release-notes.js');
    const readme = 'Nectovia 0.2.0\r\nWHICH FILE\r\n  the installer\r\n\r\nWHAT IS NEW\r\n  Run once.\r\n';
    const stable = body.releaseBody({ version: '0.2.0', readme });
    expect(stable).toBe('Nectovia 0.2.0\nWHICH FILE\n  the installer\n\nWHAT IS NEW\n  Run once.\n');
    expect(notesFromReleaseBody(stable)).toBe('WHAT IS NEW\n  Run once.');
    const candidate = body.releaseBody({ version: '0.2.0-rc.1', readme });
    expect(candidate.startsWith('RELEASE CANDIDATE 1 of 0.2.0.')).toBe(true);
    expect(notesFromReleaseBody(candidate)).toBe('WHAT IS NEW\n  Run once.');
    expect(() => body.releaseBody({ version: '0.2.0', readme: 'WHICH FILE\n  x' })).toThrow('WHAT IS NEW');
  });

  it('has notes for this version, and they are releases.json drawn as the README draws them', async () => {
    const pkg = JSON.parse(await fs.readFile(path.join(process.cwd(), 'package.json'), 'utf8')) as { version: string };
    const committed = await fs.readFile(path.join(process.cwd(), `docs/releases/notes/v${pkg.version}.txt`), 'utf8');
    expect(committed).toMatch(/^WHAT IS NEW$/m);
    const bundled = JSON.parse(await fs.readFile(path.join(process.cwd(), 'resources/release-notes/releases.json'), 'utf8'));
    if (body.releaseNotes({ version: pkg.version, releases: bundled }).source.endsWith('releases.json'))
      expect(committed.replace(/\r\n/g, '\n').trimEnd()).toBe(body.releaseNotes({ version: pkg.version, releases: bundled }).text);
  });
});
