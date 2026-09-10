import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AppUpdateService,
  assertTrustedFinalUrl,
  type UpdateTransport,
} from '../server/app-updates.js';
import { createApp } from '../server/app.js';
import {
  UPDATE_RELEASES_URL,
  compareVersions,
  isEmptyUpdateBody,
  parseAssetDigest,
  parseOfficialAssetUrl,
  parseStableVersion,
  selectWindowsAsset,
} from '../shared/app-updates.js';

// Bounded update flow. No test hits the network or launches an installer:
// every transport seam is injected, and production fetch mapping is
// exercised through a stubbed global fetch.
const INSTALLED = '0.1.1';
const NEXT = '0.1.2';
const ASSET = `Diomedes-Experimental-${NEXT}-unsigned-setup.exe`;
const ASSET_URL = `https://github.com/andrewgodowsky-aoa/diomedes/releases/download/v${NEXT}/${ASSET}`;
const SIZE = 1_100_000;

function fixtureBytes(size = SIZE, fill = 7): Uint8Array {
  return new Uint8Array(size).fill(fill);
}

function digestOf(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function releasePayload(version: string, bytes: Uint8Array, sha: string, extra = {}) {
  const name = `Diomedes-Experimental-${version}-unsigned-setup.exe`;
  return {
    tag_name: `v${version}`,
    html_url: `https://github.com/andrewgodowsky-aoa/diomedes/releases/tag/v${version}`,
    // Release prose is never trusted; the exact asset digest below is.
    body: `Notes for ${version}.`,
    prerelease: false,
    draft: false,
    assets: [
      {
        name,
        browser_download_url: `https://github.com/andrewgodowsky-aoa/diomedes/releases/download/v${version}/${name}`,
        size: bytes.length,
        digest: `sha256:${sha}`,
      },
    ],
    ...extra,
  };
}

async function tempDir(): Promise<string> {
  await fs.mkdir(path.join(process.cwd(), 'test-results'), { recursive: true });
  return fs.mkdtemp(path.join(process.cwd(), 'test-results', 'app-updates-'));
}

function serviceFor(
  dataDir: string,
  transport: Partial<UpdateTransport>,
  overrides: { platform?: string; packaged?: boolean; installed?: boolean; busy?: boolean } = {},
) {
  const launched: { path: string; sha256: string; size: number; version: string }[] = [];
  const calls = { fetch: 0, download: 0 };
  const packaged = overrides.packaged ?? true;
  const service = new AppUpdateService({
    currentVersion: INSTALLED,
    dataDir,
    platform: overrides.platform ?? 'win32',
    packaged,
    installed: overrides.installed ?? packaged,
    isBusy: () => overrides.busy ?? false,
    transport: {
      fetchRelease: async () => {
        calls.fetch += 1;
        return transport.fetchRelease?.(new AbortController().signal);
      },
      downloadAsset: async (url, size, signal) => {
        calls.download += 1;
        return transport.downloadAsset!(url, size, signal);
      },
      launchInstaller: async (artifact) => {
        launched.push({ ...artifact });
        await transport.launchInstaller?.(artifact);
      },
    },
  });
  return { service, launched, calls };
}

async function availableService(
  dataDir: string,
  overrides: { platform?: string; packaged?: boolean; installed?: boolean; busy?: boolean } = {},
) {
  const bytes = fixtureBytes();
  const sha = digestOf(bytes);
  const { service, launched, calls } = serviceFor(
    dataDir,
    {
      fetchRelease: async () => releasePayload(NEXT, bytes, sha),
      downloadAsset: async () => ({ bytes, finalUrl: ASSET_URL }),
    },
    overrides,
  );
  await service.check({});
  return { service, launched, calls, bytes, sha };
}

const dirs: string[] = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  for (const dir of dirs.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});

describe('update version and channel policy', () => {
  it('accepts strict stable versions and orders them', () => {
    expect(parseStableVersion('v0.1.2')).toBe('0.1.2');
    expect(parseStableVersion('0.1.2')).toBe('0.1.2');
    for (const bad of [
      '',
      'v1.2',
      '1.2.3-beta',
      '1.2.3+build',
      'v1.2.3.4',
      'latest',
      'v01.2.3',
      'v999999.0.0',
      'v1.2.3\ninjected',
      null,
      42,
    ])
      expect(parseStableVersion(bad)).toBeNull();
    expect(compareVersions('0.1.2', '0.1.1')).toBeGreaterThan(0);
    expect(compareVersions('0.1.1', '0.1.2')).toBeLessThan(0);
    expect(compareVersions('0.1.1', '0.1.1')).toBe(0);
    expect(() => compareVersions('1.2.3-beta', '0.1.1')).toThrow();
  });

  it('parses only exact asset digests, never prose', () => {
    const sha = 'a'.repeat(64);
    expect(parseAssetDigest(`sha256:${sha}`)).toBe(sha);
    expect(parseAssetDigest(`SHA256:${sha.toUpperCase()}`)).toBeNull();
    expect(parseAssetDigest(` sha256:${sha} `)).toBe(sha);
    for (const bad of [`SHA-256: ${sha}`, sha, 'sha256:xyz', '', null, 42])
      expect(parseAssetDigest(bad)).toBeNull();
  });

  it('accepts only the exact official download path with matching versions', () => {
    expect(parseOfficialAssetUrl(ASSET_URL)).toMatchObject({ version: NEXT, name: ASSET });
    const otherTag = ASSET_URL.replace('/v0.1.2/', '/v0.1.3/');
    expect(parseOfficialAssetUrl(otherTag)).toBeNull();
    expect(
      parseOfficialAssetUrl(
        'https://github.com/andrewgodowsky-aoa/diomedes/releases/download/v0.1.2/%ZZ',
      ),
    ).toBeNull();
    expect(
      parseOfficialAssetUrl(
        'https://user:pass@github.com/andrewgodowsky-aoa/diomedes/releases/download/v0.1.2/' +
          ASSET,
      ),
    ).toBeNull();
    for (const bad of [
      ASSET_URL.replace('https:', 'http:'),
      ASSET_URL.replace('andrewgodowsky-aoa/diomedes', 'someone-else/diomedes'),
      ASSET_URL.replace('/releases/download/', '/releases/'),
      'https://github.com/andrewgodowsky-aoa/diomedes/releases/download/v0.1.2/Setup.exe',
      'https://evil.example/diomedes.exe',
      '../escape.exe',
      null,
    ])
      expect(parseOfficialAssetUrl(bad)).toBeNull();
  });

  it('selects the stable Windows asset from its exact digest and rejects malformed metadata', () => {
    const bytes = fixtureBytes();
    const sha = digestOf(bytes);
    const parsed = selectWindowsAsset(releasePayload(NEXT, bytes, sha));
    expect(parsed).toMatchObject({ version: NEXT, asset: { name: ASSET, size: SIZE } });
    expect(parsed.publishedDigest).toBe(sha);
    expect(parsed.asset?.digest).toBe(sha);
    for (const bad of [{}, { tag_name: 'v1.2.3-beta' }, { tag_name: 'v0.1.2' }, null, []])
      expect(() => selectWindowsAsset(bad)).toThrow();
    const noAsset = releasePayload(NEXT, bytes, sha) as unknown as { assets: unknown[] };
    noAsset.assets = [
      { name: 'notes.txt', browser_download_url: 'https://example.com/n', size: 3 },
    ];
    expect(selectWindowsAsset(noAsset).asset).toBeNull();
  });

  it('requires the exact asset digest and ignores prose digests', () => {
    const bytes = fixtureBytes();
    const sha = digestOf(bytes);
    const proseOnly = releasePayload(NEXT, bytes, sha) as unknown as {
      assets: unknown[];
      body: string;
    };
    proseOnly.assets = [
      {
        name: ASSET,
        browser_download_url: ASSET_URL,
        size: bytes.length,
      },
    ];
    proseOnly.body = `SHA-256: ${sha}`;
    expect(() => selectWindowsAsset(proseOnly)).toThrow();
    const wrongProse = releasePayload(NEXT, bytes, sha);
    wrongProse.body = `SHA-256: ${'f'.repeat(64)}`;
    // The manifest digest wins; prose is ignored entirely.
    expect(selectWindowsAsset(wrongProse).publishedDigest).toBe(sha);
    const malformedDigest = releasePayload(NEXT, bytes, sha);
    malformedDigest.assets[0].digest = 'sha256:xyz';
    expect(() => selectWindowsAsset(malformedDigest)).toThrow();
  });

  it('rejects duplicate installer entries and tag/name mismatches', () => {
    const bytes = fixtureBytes();
    const sha = digestOf(bytes);
    const base = releasePayload(NEXT, bytes, sha);
    const duplicate = structuredClone(base);
    duplicate.assets.push(structuredClone(duplicate.assets[0]));
    expect(() => selectWindowsAsset(duplicate)).toThrow();
    const tagMismatch = structuredClone(base);
    tagMismatch.tag_name = 'v0.1.3';
    expect(() => selectWindowsAsset(tagMismatch)).toThrow();
    const urlMismatch = structuredClone(base);
    urlMismatch.assets[0].browser_download_url = ASSET_URL.replace('/v0.1.2/', '/v0.1.3/');
    expect(() => selectWindowsAsset(urlMismatch)).toThrow();
    const sizeMismatch = structuredClone(base);
    sizeMismatch.assets[0].size = 123;
    // Out-of-bound manifest sizes fail closed instead of staging.
    expect(() => selectWindowsAsset(sizeMismatch)).toThrow();
  });

  it('returns only the exact tag notes URL, never an attacker prefix', () => {
    const bytes = fixtureBytes();
    const sha = digestOf(bytes);
    const evil = releasePayload(NEXT, bytes, sha, {
      html_url: 'https://github.com/andrewgodowsky-aoa/diomedes/releases-evil',
    });
    expect(selectWindowsAsset(evil).notesUrl).toBe(UPDATE_RELEASES_URL);
    const otherTag = releasePayload(NEXT, bytes, sha, {
      html_url: 'https://github.com/andrewgodowsky-aoa/diomedes/releases/tag/v9.9.9',
    });
    expect(selectWindowsAsset(otherTag).notesUrl).toBe(UPDATE_RELEASES_URL);
  });

  it('treats check/download bodies as empty-only', () => {
    expect(isEmptyUpdateBody(undefined)).toBe(true);
    expect(isEmptyUpdateBody({})).toBe(true);
    for (const bad of [
      { grant: 'task' },
      { worker: 'x' },
      { principal: 'x' },
      { authorization: 'x' },
      { taskId: 'T1' },
      [],
      null,
      'x',
    ])
      expect(isEmptyUpdateBody(bad)).toBe(false);
  });
});

describe('explicit check outcomes', () => {
  it('offers a newer stable release and never a downgrade', async () => {
    const dir = await tempDir();
    dirs.push(dir);
    const bytes = fixtureBytes();
    const { service } = serviceFor(dir, {
      fetchRelease: async () => releasePayload(NEXT, bytes, digestOf(bytes)),
    });
    const check = await service.check({});
    expect(check.outcome).toBe('available');
    expect(check.latestVersion).toBe(NEXT);
  });

  it('reports current when the feed is older or equal, never an install', async () => {
    const dir = await tempDir();
    dirs.push(dir);
    for (const version of ['0.1.1', '0.1.0']) {
      const bytes = fixtureBytes();
      const { service } = serviceFor(dir, {
        fetchRelease: async () => releasePayload(version, bytes, digestOf(bytes)),
      });
      expect((await service.check({})).outcome).toBe('current');
      await expect(service.download({})).rejects.toMatchObject({ status: 409 });
    }
  });

  it('names prerelease, draft and missing releases explicitly', async () => {
    const dir = await tempDir();
    dirs.push(dir);
    const bytes = fixtureBytes();
    const pre = serviceFor(dir, {
      fetchRelease: async () =>
        releasePayload('0.2.0', bytes, digestOf(bytes), { prerelease: true }),
    });
    expect((await pre.service.check({})).outcome).toBe('prerelease-only');
    const missingAsset = serviceFor(dir, {
      fetchRelease: async () => ({ ...releasePayload(NEXT, bytes, digestOf(bytes)), assets: [] }),
    });
    expect((await missingAsset.service.check({})).outcome).toBe('no-release');
    const unpublished = serviceFor(dir, {
      fetchRelease: async () => {
        const { ApiError } = await import('../server/paths.js');
        throw new ApiError(404, 'NO_RELEASE', { code: 'no-release' });
      },
    });
    expect((await unpublished.service.check({})).outcome).toBe('no-release');
    const broken = serviceFor(dir, { fetchRelease: async () => ({ tag_name: 'v1' }) });
    await expect(broken.service.check({})).rejects.toMatchObject({ status: 502 });
  });

  it('rejects non-empty check/download bodies including grant claims', async () => {
    const dir = await tempDir();
    dirs.push(dir);
    const { service } = await availableService(dir);
    for (const bad of [{ grant: 'x' }, { taskId: 'T1' }, { worker: 'w' }, { scope: 's' }]) {
      await expect(service.check(bad)).rejects.toMatchObject({ status: 400 });
      await expect(service.download(bad)).rejects.toMatchObject({ status: 400 });
    }
  });

  it('clears the actionable record on stale or failed rechecks', async () => {
    const dir = await tempDir();
    dirs.push(dir);
    const bytes = fixtureBytes();
    const sha = digestOf(bytes);
    let mode: 'available' | 'gone' | 'broken' = 'available';
    const { service } = serviceFor(dir, {
      fetchRelease: async () => {
        if (mode === 'gone') {
          const { ApiError } = await import('../server/paths.js');
          throw new ApiError(404, 'NO_RELEASE', { code: 'no-release' });
        }
        if (mode === 'broken') return { tag_name: 'v1' };
        return releasePayload(NEXT, bytes, sha);
      },
      downloadAsset: async () => ({ bytes, finalUrl: ASSET_URL }),
    });
    expect((await service.check({})).outcome).toBe('available');
    await service.download({});
    mode = 'gone';
    expect((await service.check({})).outcome).toBe('no-release');
    expect((await service.status()).download.ready).toBe(false);
    expect((await service.status()).check.latestVersion).toBeNull();
    await expect(service.download({})).rejects.toMatchObject({ status: 409 });
    await expect(service.install({ assetName: ASSET, sha256: sha })).rejects.toMatchObject({
      status: 409,
    });
    mode = 'available';
    expect((await service.check({})).outcome).toBe('available');
    mode = 'broken';
    await expect(service.check({})).rejects.toMatchObject({ status: 502 });
    expect((await service.status()).download.ready).toBe(false);
  });

  it('coalesces duplicate checks into one feed read', async () => {
    const dir = await tempDir();
    dirs.push(dir);
    const bytes = fixtureBytes();
    const { service, calls } = serviceFor(dir, {
      fetchRelease: async () => releasePayload(NEXT, bytes, digestOf(bytes)),
    });
    const [first, second] = await Promise.all([service.check({}), service.check({})]);
    expect(first.outcome).toBe('available');
    expect(second.outcome).toBe('available');
    expect(calls.fetch).toBe(1);
  });
});

describe('production feed mapping without network', () => {
  async function productionService(
    dir: string,
    fetchImpl: typeof fetch,
    overrides: { platform?: string; packaged?: boolean; installed?: boolean } = {},
  ) {
    vi.stubGlobal('fetch', fetchImpl);
    const packaged = overrides.packaged ?? true;
    return new AppUpdateService({
      currentVersion: INSTALLED,
      dataDir: dir,
      platform: overrides.platform ?? 'win32',
      packaged,
      installed: overrides.installed ?? packaged,
      isBusy: () => false,
    });
  }

  it('maps offline, timeout, rate-limit and missing releases', async () => {
    const dir = await tempDir();
    dirs.push(dir);
    const offline = await productionService(dir, async () => {
      throw new TypeError('fetch failed');
    });
    await expect(offline.check({})).rejects.toMatchObject({ status: 503 });
    const timedOut = await productionService(dir, async () => {
      throw new DOMException('The operation was aborted.', 'AbortError');
    });
    await expect(timedOut.check({})).rejects.toMatchObject({ status: 504 });
    const limited = await productionService(
      dir,
      async () => new Response('limited', { status: 429 }),
    );
    await expect(limited.check({})).rejects.toMatchObject({ status: 429 });
    const absent = await productionService(
      dir,
      async () => new Response('Not Found', { status: 404 }),
    );
    expect((await absent.check({})).outcome).toBe('no-release');
    const malformed = await productionService(
      dir,
      async () => new Response('not json', { status: 200 }),
    );
    await expect(malformed.check({})).rejects.toMatchObject({ status: 502 });
  });

  it('refuses untrusted redirect targets and off-channel requests', () => {
    for (const [requestUrl, finalUrl] of [
      [ASSET_URL, 'https://evil.example/diomedes.exe'],
      [ASSET_URL, 'http://github.com/x'],
      [ASSET_URL, 'https://user:pass@objects.githubusercontent.com/x'],
      ['https://evil.example/x.exe', 'https://evil.example/x.exe'],
    ] as const)
      expect(() => assertTrustedFinalUrl(requestUrl, finalUrl)).toThrowError(
        expect.objectContaining({ status: 502 }),
      );
    for (const trusted of [
      'https://objects.githubusercontent.com/diomedes/payload.exe',
      'https://release-assets.githubusercontent.com/diomedes/payload.exe',
      'https://github.com/andrewgodowsky-aoa/diomedes/releases/download/v0.1.2/' + ASSET,
    ])
      expect(() => assertTrustedFinalUrl(ASSET_URL, trusted)).not.toThrow();
  });

  it('exercises the production redirect and size checks without network', async () => {
    const dir = await tempDir();
    dirs.push(dir);
    const bytes = fixtureBytes();
    const sha = digestOf(bytes);
    const payload = releasePayload(NEXT, bytes, sha);
    vi.stubGlobal('fetch', (async (url: string | URL | Request) => {
      if (String(url).includes('api.github.com')) return new Response(JSON.stringify(payload));
      return new Response(Buffer.from(bytes), { status: 200 });
    }) as typeof fetch);
    const redirected = new AppUpdateService({
      currentVersion: INSTALLED,
      dataDir: dir,
      platform: 'win32',
      packaged: true,
      installed: true,
      isBusy: () => false,
    });
    expect((await redirected.check({})).outcome).toBe('available');
    await redirected.download({});
    const staged = path.join(dir, 'updates', ASSET);
    expect((await fs.stat(staged)).size).toBe(SIZE);
  });

  it('bounds production downloads before over-allocation', async () => {
    const dir = await tempDir();
    dirs.push(dir);
    const bytes = fixtureBytes();
    const sha = digestOf(bytes);
    const payload = releasePayload(NEXT, bytes, sha);
    vi.stubGlobal('fetch', (async (url: string | URL | Request) => {
      if (String(url).includes('api.github.com')) return new Response(JSON.stringify(payload));
      return new Response(Buffer.from(fixtureBytes(SIZE, 9)), {
        status: 200,
        headers: { 'content-length': String(SIZE * 2) },
      });
    }) as typeof fetch);
    const service = new AppUpdateService({
      currentVersion: INSTALLED,
      dataDir: dir,
      platform: 'win32',
      packaged: true,
      installed: true,
      isBusy: () => false,
    });
    expect((await service.check({})).outcome).toBe('available');
    await expect(service.download({})).rejects.toMatchObject({ status: 502 });
  });

  it('validates every redirect hop before fetching it', async () => {
    const dir = await tempDir();
    dirs.push(dir);
    const bytes = fixtureBytes();
    const sha = digestOf(bytes);
    const payload = releasePayload(NEXT, bytes, sha);
    vi.stubGlobal('fetch', (async (url: string | URL | Request) => {
      if (String(url).includes('api.github.com')) return new Response(JSON.stringify(payload));
      return new Response(null, {
        status: 302,
        headers: { location: 'https://evil.example/diomedes.exe' },
      });
    }) as typeof fetch);
    const service = new AppUpdateService({
      currentVersion: INSTALLED,
      dataDir: dir,
      platform: 'win32',
      packaged: true,
      installed: true,
      isBusy: () => false,
    });
    expect((await service.check({})).outcome).toBe('available');
    await expect(service.download({})).rejects.toMatchObject({ status: 502 });
  });
});

describe('verified download and guarded install', () => {
  it('clears an available version and records a subsequent feed failure as an error', async () => {
    const dir = await tempDir();
    dirs.push(dir);
    const bytes = fixtureBytes();
    let offline = false;
    const { service } = serviceFor(dir, {
      fetchRelease: async () => {
        if (offline) throw new Error('Offline fixture');
        return releasePayload(NEXT, bytes, digestOf(bytes));
      },
      downloadAsset: async () => ({ bytes, finalUrl: ASSET_URL }),
    });
    await service.check({});
    await service.download({});
    offline = true;
    await expect(service.check({})).rejects.toThrow('Offline fixture');
    expect(await service.status()).toMatchObject({
      check: { outcome: 'error', latestVersion: null, detail: 'Offline fixture' },
      download: { ready: false, sha256: null },
    });
  });

  it('refuses a staging directory junction without writing outside the app data', async () => {
    const dir = await tempDir();
    const outside = await tempDir();
    dirs.push(dir, outside);
    await fs.symlink(
      outside,
      path.join(dir, 'updates'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    const { service } = await availableService(dir);
    await expect(service.download({})).rejects.toMatchObject({ status: 502 });
    expect(await fs.readdir(outside)).toEqual([]);
  });

  it('downloads, verifies and stages the installer under owned data', async () => {
    const dir = await tempDir();
    dirs.push(dir);
    const { service, calls, sha } = await availableService(dir);
    const result = await service.download({});
    expect(result).toEqual({ downloaded: true, version: NEXT });
    expect(calls.download).toBe(1);
    const staged = path.join(dir, 'updates', ASSET);
    expect(digestOf(await fs.readFile(staged))).toBe(sha);
    const status = await service.status();
    expect(status.download).toMatchObject({
      ready: true,
      version: NEXT,
      assetName: ASSET,
      bytes: SIZE,
      sha256: sha,
      verified: 'size-origin-digest',
    });
    // Duplicate admission reuses the staged file without another download.
    await service.download({});
    expect(calls.download).toBe(1);
  });

  it('rejects tampered bytes and a mismatched published digest', async () => {
    const dir = await tempDir();
    dirs.push(dir);
    const bytes = fixtureBytes();
    const tampered = serviceFor(dir, {
      fetchRelease: async () => releasePayload(NEXT, bytes, digestOf(bytes)),
      downloadAsset: async () => ({ bytes: fixtureBytes(SIZE, 9), finalUrl: ASSET_URL }),
    });
    await tampered.service.check({});
    await expect(tampered.service.download({})).rejects.toMatchObject({ status: 502 });
    expect(await fs.readdir(path.join(dir, 'updates')).catch(() => [])).toEqual([]);
    const wrongDigest = serviceFor(dir, {
      fetchRelease: async () => releasePayload(NEXT, bytes, '0'.repeat(64)),
      downloadAsset: async () => ({ bytes, finalUrl: ASSET_URL }),
    });
    await wrongDigest.service.check({});
    await expect(wrongDigest.service.download({})).rejects.toMatchObject({ status: 502 });
  });

  it('refuses to stage over a non-regular file', async () => {
    const dir = await tempDir();
    dirs.push(dir);
    const { service } = await availableService(dir);
    const stagedPath = path.join(dir, 'updates', ASSET);
    await fs.mkdir(path.dirname(stagedPath), { recursive: true });
    await fs.mkdir(stagedPath, { recursive: true });
    await expect(service.download({})).rejects.toMatchObject({ status: 502 });
  });

  it('fails a download whose generation changed underneath it', async () => {
    const dir = await tempDir();
    dirs.push(dir);
    const bytes = fixtureBytes();
    const sha = digestOf(bytes);
    let releaseDownload!: (value: { bytes: Uint8Array; finalUrl: string }) => void;
    const gate = new Promise<{ bytes: Uint8Array; finalUrl: string }>((resolve) => {
      releaseDownload = resolve;
    });
    const { service } = serviceFor(dir, {
      fetchRelease: async () => releasePayload(NEXT, bytes, sha),
      downloadAsset: async () => gate,
    });
    await service.check({});
    const pending = service.download({});
    // A concurrent successful check bumps the generation; the in-flight
    // download must fail closed rather than stage a stale record.
    await service.check({});
    releaseDownload({ bytes, finalUrl: ASSET_URL });
    await expect(pending).rejects.toMatchObject({ status: 409 });
  });

  it('launches once with the staged artifact and refuses repeats', async () => {
    const dir = await tempDir();
    dirs.push(dir);
    const { service, launched, sha } = await availableService(dir);
    await service.download({});
    const first = await service.install({ assetName: ASSET, sha256: sha });
    expect(first).toEqual({ launched: true, version: NEXT });
    expect(launched).toHaveLength(1);
    expect(launched[0]).toMatchObject({
      path: path.join(dir, 'updates', ASSET),
      sha256: sha,
      size: SIZE,
      version: NEXT,
    });
    await expect(service.install({ assetName: ASSET, sha256: sha })).rejects.toMatchObject({
      status: 409,
    });
    expect(launched).toHaveLength(1);
  });

  it('validates a forged concurrent install body instead of replaying it', async () => {
    const dir = await tempDir();
    dirs.push(dir);
    const bytes = fixtureBytes();
    const sha = digestOf(bytes);
    let releaseLaunch!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseLaunch = resolve;
    });
    const { service, launched } = serviceFor(dir, {
      fetchRelease: async () => releasePayload(NEXT, bytes, sha),
      downloadAsset: async () => ({ bytes, finalUrl: ASSET_URL }),
      launchInstaller: async () => {
        await gate;
      },
    });
    await service.check({});
    await service.download({});
    const pending = service.install({ assetName: ASSET, sha256: sha });
    await expect(
      service.install({ assetName: ASSET, sha256: 'f'.repeat(64) }),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      service.install({ assetName: ASSET, sha256: sha, taskId: 'T1' }),
    ).rejects.toMatchObject({ status: expect.any(Number) });
    releaseLaunch();
    await expect(pending).resolves.toEqual({ launched: true, version: NEXT });
    expect(launched).toHaveLength(1);
  });

  it('rejects forged client update metadata and arbitrary launch fields', async () => {
    const dir = await tempDir();
    dirs.push(dir);
    const { service, launched, sha } = await availableService(dir);
    await service.download({});
    for (const body of [
      { assetName: ASSET, sha256: sha, path: 'C:\\evil.exe' },
      { assetName: ASSET, sha256: sha, url: 'https://evil.example/x.exe' },
      { assetName: ASSET, sha256: sha, executable: 'calc.exe' },
      { assetName: ASSET, sha256: sha, taskId: 'T1' },
      { assetName: ASSET, sha256: sha, scopeGrant: 'x' },
      { assetName: ASSET, sha256: sha, worker: 'w' },
      { assetName: ASSET, sha256: sha, principal: 'p' },
      { assetName: ASSET },
      { sha256: sha },
      { assetName: ASSET, sha256: 'f'.repeat(64) },
      { assetName: 'Setup.exe', sha256: sha },
      null,
      [],
    ])
      await expect(service.install(body)).rejects.toMatchObject({ status: expect.any(Number) });
    expect(launched).toHaveLength(0);
  });

  it('rechecks busy work after file verification, before admission', async () => {
    const dir = await tempDir();
    dirs.push(dir);
    const bytes = fixtureBytes();
    const sha = digestOf(bytes);
    let calls = 0;
    const service = new AppUpdateService({
      currentVersion: INSTALLED,
      dataDir: dir,
      platform: 'win32',
      packaged: true,
      installed: true,
      isBusy: () => {
        calls += 1;
        // Idle at admission, active after the async file verification.
        return calls >= 2;
      },
      transport: {
        fetchRelease: async () => releasePayload(NEXT, bytes, sha),
        downloadAsset: async () => ({ bytes, finalUrl: ASSET_URL }),
        launchInstaller: async () => {
          throw new Error('must not launch');
        },
      },
    });
    await service.check({});
    await service.download({});
    await expect(service.install({ assetName: ASSET, sha256: sha })).rejects.toMatchObject({
      status: 409,
    });
  });

  it('denies install while project work is active but still checks', async () => {
    const dir = await tempDir();
    dirs.push(dir);
    const { service, launched, sha } = await availableService(dir, { busy: true });
    expect((await service.status()).workActive).toBe(true);
    expect((await service.check({})).outcome).toBe('available');
    await service.download({});
    await expect(service.install({ assetName: ASSET, sha256: sha })).rejects.toMatchObject({
      status: 409,
    });
    expect(launched).toHaveLength(0);
  });

  it('limits install to installed Windows copies with an explicit reason', async () => {
    const dir = await tempDir();
    dirs.push(dir);
    for (const overrides of [
      { platform: 'linux', packaged: true, installed: true },
      { platform: 'win32', packaged: false, installed: false },
      { platform: 'win32', packaged: true, installed: false },
    ]) {
      const { service, launched, sha } = await availableService(dir, overrides);
      const status = await service.status();
      expect(status.supported).toBe(false);
      expect(status.supportReason).toBeTruthy();
      await service.download({});
      await expect(service.install({ assetName: ASSET, sha256: sha })).rejects.toMatchObject({
        status: 501,
      });
      expect(launched).toHaveLength(0);
    }
    const portable = await availableService(dir, {
      platform: 'win32',
      packaged: true,
      installed: false,
    });
    expect((await portable.service.status()).supportReason).toMatch(/portable/i);
  });

  it('leaves install unavailable when no desktop transport is provided', async () => {
    const dir = await tempDir();
    dirs.push(dir);
    const bytes = fixtureBytes();
    const sha = digestOf(bytes);
    const service = new AppUpdateService({
      currentVersion: INSTALLED,
      dataDir: dir,
      platform: 'win32',
      packaged: true,
      installed: true,
      isBusy: () => false,
      transport: {
        fetchRelease: async () => releasePayload(NEXT, bytes, sha),
        downloadAsset: async () => ({ bytes, finalUrl: ASSET_URL }),
      },
    });
    await service.check({});
    await service.download({});
    await expect(service.install({ assetName: ASSET, sha256: sha })).rejects.toMatchObject({
      status: 501,
    });
  });

  it('detects a staged file changed after verification', async () => {
    const dir = await tempDir();
    dirs.push(dir);
    const { service, launched, sha } = await availableService(dir);
    await service.download({});
    await fs.writeFile(path.join(dir, 'updates', ASSET), fixtureBytes(SIZE, 11));
    await expect(service.install({ assetName: ASSET, sha256: sha })).rejects.toMatchObject({
      status: 502,
    });
    expect(launched).toHaveLength(0);
  });
});

describe('update routes through the local service', () => {
  let server: Server | undefined;
  let application: Awaited<ReturnType<typeof createApp>> | undefined;
  let url = '';
  const headers = { 'Content-Type': 'application/json', 'X-Diomedes-Client': '1' };
  const launched: { path: string; sha256: string; size: number; version: string }[] = [];
  let installAccepted = 0;

  async function api<T>(
    route: string,
    method = 'GET',
    body?: unknown,
  ): Promise<{ status: number; data: T }> {
    const response = await fetch(`${url}/api${route}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, data: (await response.json()) as T };
  }

  beforeEach(async () => {
    launched.length = 0;
    installAccepted = 0;
  });

  async function startApp(stepMs = 20, beforeHandoff?: () => Promise<void>) {
    const root = await tempDir();
    dirs.push(root);
    const bytes = fixtureBytes();
    const sha = digestOf(bytes);
    application = await createApp({
      dataDir: path.join(root, 'data'),
      projectRoot: path.join(root, 'projects'),
      stepMs,
      updateOverrides: {
        platform: 'win32',
        packaged: true,
        installed: true,
        onInstallAccepted: () => {
          installAccepted += 1;
        },
        transport: {
          fetchRelease: async () => releasePayload(NEXT, bytes, sha),
          downloadAsset: async () => ({ bytes, finalUrl: ASSET_URL }),
          launchInstaller: async (artifact) => {
            launched.push({ ...artifact });
            await beforeHandoff?.();
          },
        },
      },
    });
    server = application.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server!.once('listening', resolve));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }

  afterEach(async () => {
    if (application) await application.locals.close();
    if (server) {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server!.close((error) => (error ? reject(error) : resolve())),
      );
    }
    application = undefined;
    server = undefined;
  });

  it('runs the explicit check, download and install flow', async () => {
    await startApp();
    const initial = await api<{ installedVersion: string; supported: boolean; installed: boolean }>(
      '/updates/status',
    );
    expect(initial.status).toBe(200);
    expect(initial.data.installedVersion).toBe(INSTALLED);
    expect(initial.data.supported).toBe(true);
    expect(initial.data.installed).toBe(true);
    expect((await api('/updates/download', 'POST', {})).status).toBe(409);
    const check = await api<{ outcome: string; latestVersion: string }>(
      '/updates/check',
      'POST',
      {},
    );
    expect(check.status).toBe(200);
    expect(check.data.outcome).toBe('available');
    expect(check.data.latestVersion).toBe(NEXT);
    expect((await api('/updates/download', 'POST', {})).status).toBe(200);
    const status = await api<{ download: { sha256: string } }>('/updates/status');
    const forged = await api('/updates/install', 'POST', {
      assetName: ASSET,
      sha256: 'f'.repeat(64),
    });
    expect(forged.status).toBe(409);
    expect(launched).toHaveLength(0);
    const install = await api('/updates/install', 'POST', {
      assetName: ASSET,
      sha256: status.data.download.sha256,
    });
    expect(install.status).toBe(200);
    expect(launched).toHaveLength(1);
    expect(launched[0]).toMatchObject({ size: SIZE, version: NEXT });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(installAccepted).toBe(1);
    const repeat = await api('/updates/install', 'POST', {
      assetName: ASSET,
      sha256: status.data.download.sha256,
    });
    expect(repeat.status).toBe(409);
    expect(launched).toHaveLength(1);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(installAccepted).toBe(1);
  });

  it('rejects grant-claim bodies on update POSTs', async () => {
    await startApp();
    expect((await api('/updates/check', 'POST', { taskId: 'T1' })).status).toBe(400);
    expect((await api('/updates/download', 'POST', { worker: 'w' })).status).toBe(400);
    await api('/updates/check', 'POST', {});
    await api('/updates/download', 'POST', {});
    const status = await api<{ download: { sha256: string } }>('/updates/status');
    expect(
      (
        await api('/updates/install', 'POST', {
          assetName: ASSET,
          sha256: status.data.download.sha256,
          principal: 'p',
        })
      ).status,
    ).toBe(400);
  });

  it('completes one accepted handoff when the requesting client disconnects', async () => {
    let enter!: () => void;
    let release!: () => void;
    const entered = new Promise<void>((resolve) => {
      enter = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    await startApp(20, async () => {
      enter();
      await gate;
    });
    await api('/updates/check', 'POST', {});
    await api('/updates/download', 'POST', {});
    const status = await api<{ download: { sha256: string } }>('/updates/status');
    const controller = new AbortController();
    const pending = fetch(`${url}/api/updates/install`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Diomedes-Client': '1' },
      body: JSON.stringify({ assetName: ASSET, sha256: status.data.download.sha256 }),
      signal: controller.signal,
    }).then(
      () => 'response',
      () => 'disconnected',
    );
    await entered;
    controller.abort();
    expect(await pending).toBe('disconnected');
    release();
    await vi.waitFor(() => expect(installAccepted).toBe(1));
    expect(launched).toHaveLength(1);
    expect((await api('/updates/status')).status).toBe(200);
    expect(installAccepted).toBe(1);
  });

  it('blocks install while project work is active', async () => {
    // A huge step keeps the sample session working for the assertion below.
    await startApp(3_600_000);
    const project = await api<{ id: string }>('/projects', 'POST', { name: 'Update guard' });
    expect(project.status).toBe(200);
    const task = await api<{ id: string }>(`/projects/${project.data.id}/tasks`, 'POST', {
      name: 'Keep this session working',
    });
    const start = await api(`/projects/${project.data.id}/work/start`, 'POST', {
      taskId: task.data.id,
    });
    expect(start.status).toBe(200);
    expect((await api<{ workActive: boolean }>('/updates/status')).data.workActive).toBe(true);
    await api('/updates/check', 'POST', {});
    await api('/updates/download', 'POST', {});
    const status = await api<{ download: { sha256: string } }>('/updates/status');
    const install = await api('/updates/install', 'POST', {
      assetName: ASSET,
      sha256: status.data.download.sha256,
    });
    expect(install.status).toBe(409);
    expect(launched).toHaveLength(0);
  }, 15000);

  it('blocks new work after an accepted install', async () => {
    await startApp();
    const project = await api<{ id: string }>('/projects', 'POST', { name: 'Update close' });
    const task = await api<{ id: string }>(`/projects/${project.data.id}/tasks`, 'POST', {
      name: 'Work after close',
    });
    await api('/updates/check', 'POST', {});
    await api('/updates/download', 'POST', {});
    const status = await api<{ download: { sha256: string } }>('/updates/status');
    const install = await api('/updates/install', 'POST', {
      assetName: ASSET,
      sha256: status.data.download.sha256,
    });
    expect(install.status).toBe(200);
    const blocked = await api(`/projects/${project.data.id}/work/start`, 'POST', {
      taskId: task.data.id,
    });
    expect(blocked.status).toBe(409);
    expect((await api('/projects', 'POST', { name: 'Late project' })).status).toBe(409);
    expect((await api('/settings', 'PUT', { detail: 'simple' })).status).toBe(409);
    expect((await api('/updates/check', 'POST', {})).status).toBe(409);
    expect(launched).toHaveLength(1);
  }, 15000);
});
