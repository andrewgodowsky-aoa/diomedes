import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import express from 'express';
import { ApiError } from './paths.js';
import {
  UPDATE_API_URL,
  UPDATE_ASSET_PATTERN,
  UPDATE_CHANNEL,
  UPDATE_DOWNLOAD_HOSTS,
  UPDATE_MAX_ASSET_BYTES,
  UPDATE_OWNER,
  UPDATE_RELEASES_URL,
  UPDATE_REPO,
  compareVersions,
  isEmptyUpdateBody,
  parseOfficialAssetUrl,
  parseStableVersion,
  selectWindowsAsset,
  type UpdateCheckOutcome,
  type UpdateInstallArtifact,
  type UpdateStatusSnapshot,
} from '../shared/app-updates.js';

const CHECK_TIMEOUT_MS = 15_000;
const DOWNLOAD_TIMEOUT_MS = 10 * 60_000;
const REDIRECT_LIMIT = 5;
const METADATA_MAX_BYTES = 256 * 1024;
const SHA_PATTERN = /^[0-9a-f]{64}$/;

/** Injected seams. Unit tests replace every seam; production uses fetch below. */
export interface UpdateTransport {
  fetchRelease: (signal: AbortSignal) => Promise<unknown>;
  downloadAsset: (
    url: string,
    expectedSize: number,
    signal: AbortSignal,
  ) => Promise<{ bytes: Uint8Array; finalUrl: string }>;
  launchInstaller: (artifact: UpdateInstallArtifact) => Promise<void>;
}

export interface AppUpdateOptions {
  currentVersion: string;
  dataDir: string;
  platform?: string;
  packaged?: boolean;
  installed?: boolean;
  onInstallAccepted?: () => void;
  isBusy: () => boolean | Promise<boolean>;
  transport?: Partial<UpdateTransport>;
}

interface VerifiedRecord {
  version: string;
  tag: string;
  notesUrl: string;
  assetName: string;
  assetUrl: string;
  assetSize: number;
  publishedDigest: string;
  verifiedAt: string;
  stagedPath: string | null;
  stagedBytes: number | null;
  stagedSha256: string | null;
}

const withTimeout = (signal: AbortSignal | undefined, ms: number): AbortSignal =>
  signal ? AbortSignal.any([signal, AbortSignal.timeout(ms)]) : AbortSignal.timeout(ms);

function normalizeBodySignal(
  body: unknown,
  signal: AbortSignal | undefined,
): { body: unknown; signal: AbortSignal | undefined } {
  if (typeof AbortSignal !== 'undefined' && body instanceof AbortSignal)
    return { body: undefined, signal: body };
  return { body, signal };
}

function assertEmptyBody(body: unknown): void {
  if (!isEmptyUpdateBody(body)) throw new ApiError(400, 'This update action takes no fields.');
}

/** One URL hop must stay on an update host over HTTPS with no credentials. */
function assertTrustedUrl(value: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new ApiError(502, 'The installer resolved to an untrusted location. Nothing was saved.');
  }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password)
    throw new ApiError(502, 'The installer resolved to an untrusted location. Nothing was saved.');
  if (!UPDATE_DOWNLOAD_HOSTS.includes(parsed.host))
    throw new ApiError(502, 'The installer resolved to an untrusted location. Nothing was saved.');
  return parsed;
}

/** The download request URL is fixed; the resolved URL must stay on update hosts over HTTPS. */
export function assertTrustedFinalUrl(requestUrl: string, finalUrl: string): void {
  if (!parseOfficialAssetUrl(requestUrl))
    throw new ApiError(502, 'The installer request left the official channel.');
  assertTrustedUrl(finalUrl || requestUrl);
}

async function readBoundedText(response: Response, maxBytes: number): Promise<string> {
  const declared = response.headers.get('content-length');
  if (declared !== null) {
    const length = Number(declared);
    if (!Number.isSafeInteger(length) || length < 0 || length > maxBytes)
      throw new ApiError(502, 'The release metadata exceeded the supported bound.');
  }
  if (!response.body) {
    const text = await response.text();
    if (text.length > maxBytes)
      throw new ApiError(502, 'The release metadata exceeded the supported bound.');
    return text;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const next = await reader.read();
    if (next.done) break;
    total += next.value.length;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new ApiError(502, 'The release metadata exceeded the supported bound.');
    }
    chunks.push(next.value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function productionFetchRelease(signal: AbortSignal | undefined): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(UPDATE_API_URL, {
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': 'Diomedes-App-Updates',
      },
      signal: withTimeout(signal, CHECK_TIMEOUT_MS),
    });
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError')
      throw new ApiError(504, 'The release channel timed out. Check again when online.');
    throw new ApiError(
      503,
      'Diomedes could not reach the release channel. Check the connection and try again.',
    );
  }
  if (response.status === 404) throw new ApiError(404, 'NO_RELEASE', { code: 'no-release' });
  if (
    response.status === 429 ||
    (response.status === 403 && response.headers.get('x-ratelimit-remaining') === '0')
  )
    throw new ApiError(
      429,
      'The release channel rate limit was reached. Wait a few minutes and check again.',
    );
  if (!response.ok)
    throw new ApiError(
      502,
      'The release channel returned an unexpected response. Try again later.',
    );
  const text = await readBoundedText(response, METADATA_MAX_BYTES);
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new ApiError(502, 'The release channel returned unreadable metadata.');
  }
}

async function productionDownloadAsset(
  url: string,
  expectedSize: number,
  signal: AbortSignal | undefined,
): Promise<{ bytes: Uint8Array; finalUrl: string }> {
  if (!parseOfficialAssetUrl(url))
    throw new ApiError(502, 'The installer request left the official channel.');
  if (
    !Number.isSafeInteger(expectedSize) ||
    expectedSize <= 0 ||
    expectedSize > UPDATE_MAX_ASSET_BYTES
  )
    throw new ApiError(502, 'The release record size is outside the supported bounds.');
  const timeout = withTimeout(signal, DOWNLOAD_TIMEOUT_MS);
  let current = url;
  let response: Response | null = null;
  for (let hop = 0; hop <= REDIRECT_LIMIT; hop += 1) {
    assertTrustedUrl(current);
    try {
      response = await fetch(current, {
        headers: { 'User-Agent': 'Diomedes-App-Updates' },
        redirect: 'manual',
        signal: timeout,
      });
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError')
        throw new ApiError(504, 'The installer download timed out. Try again when online.');
      throw new ApiError(503, 'The installer download was interrupted. Try again.');
    }
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      if (hop === REDIRECT_LIMIT)
        throw new ApiError(502, 'The installer redirected too many times. Nothing was saved.');
      const location = response.headers.get('location');
      if (!location)
        throw new ApiError(502, 'The installer redirect was invalid. Nothing was saved.');
      let next: string;
      try {
        next = new URL(location, current).toString();
      } catch {
        throw new ApiError(502, 'The installer redirect was invalid. Nothing was saved.');
      }
      // Validate before the next fetch; never follow blindly.
      assertTrustedUrl(next);
      current = next;
      response = null;
      continue;
    }
    break;
  }
  if (!response) throw new ApiError(502, 'The installer download failed. Try again later.');
  if (!response.ok) throw new ApiError(502, 'The installer download failed. Try again later.');
  assertTrustedFinalUrl(url, current);
  const declared = response.headers.get('content-length');
  if (declared !== null) {
    const length = Number(declared);
    if (!Number.isSafeInteger(length) || length !== expectedSize)
      throw new ApiError(
        502,
        'The installer size does not match the release record. Nothing was saved.',
      );
  }
  if (!response.body) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.length !== expectedSize || bytes.length > UPDATE_MAX_ASSET_BYTES)
      throw new ApiError(
        502,
        'The installer size does not match the release record. Nothing was saved.',
      );
    return { bytes, finalUrl: current };
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const next = await reader.read();
    if (next.done) break;
    total += next.value.length;
    if (total > expectedSize || total > UPDATE_MAX_ASSET_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new ApiError(
        502,
        'The installer size does not match the release record. Nothing was saved.',
      );
    }
    chunks.push(next.value);
  }
  if (total !== expectedSize)
    throw new ApiError(
      502,
      'The installer size does not match the release record. Nothing was saved.',
    );
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return { bytes, finalUrl: current };
}

/**
 * The local service never spawns an installer. Only the desktop-owned
 * transport supplies this effect after the accepted-response handoff.
 */
async function unavailableInstaller(): Promise<never> {
  throw new ApiError(
    501,
    'Close-and-install runs in the desktop app only. Use the release page link for this session.',
  );
}

export class AppUpdateService {
  private readonly currentVersion: string;
  private readonly dataDir: string;
  private readonly platform: string;
  private readonly packaged: boolean;
  private readonly installed: boolean;
  private readonly isBusy: () => boolean | Promise<boolean>;
  private readonly transport: UpdateTransport;
  private checkPhase: 'idle' | 'checking' = 'idle';
  private checkAt: string | null = null;
  private outcome: UpdateCheckOutcome | null = null;
  private detail: string | null = null;
  private record: VerifiedRecord | null = null;
  private generation = 0;
  private installPhase: 'idle' | 'installing' | 'launched' = 'idle';
  private installVersion: string | null = null;
  private pendingInstall: { assetName: string; sha256: string } | null = null;
  private checking: Promise<UpdateStatusSnapshot['check']> | null = null;
  private downloading: Promise<{ downloaded: boolean; version: string }> | null = null;
  private installing: Promise<{ launched: boolean; version: string }> | null = null;

  constructor(options: AppUpdateOptions) {
    const installed = parseStableVersion(options.currentVersion);
    if (!installed) throw new Error('The installed version is not a stable version.');
    this.currentVersion = installed;
    this.dataDir = options.dataDir;
    this.platform = options.platform ?? process.platform;
    this.packaged = options.packaged ?? false;
    // Installed ownership is distinct from packaging: portable candidates
    // are packaged but not installed. Default closed when unknown.
    this.installed = options.installed ?? false;
    this.isBusy = options.isBusy;
    this.transport = {
      fetchRelease: options.transport?.fetchRelease ?? ((signal) => productionFetchRelease(signal)),
      downloadAsset:
        options.transport?.downloadAsset ??
        ((url, size, signal) => productionDownloadAsset(url, size, signal)),
      launchInstaller: options.transport?.launchInstaller ?? (() => unavailableInstaller()),
    };
  }

  /** True once install admission is latched; new mutating work must pause. */
  isInstallAccepted(): boolean {
    return this.installPhase !== 'idle';
  }

  private supportReason(): string {
    if (this.platform !== 'win32')
      return (
        'Close-and-install is available on a packaged Windows installation only. ' +
        `This service runs on ${this.platform}, so use the release page link below.`
      );
    if (!this.packaged)
      return (
        'This is a development session, not the installed app. ' +
        'Install the update from the release page after packaging.'
      );
    if (!this.installed)
      return (
        'This packaged copy is portable, not the installed app. ' +
        'It can check and download official releases, but close-and-install ' +
        'runs the official installer for the installed copy only.'
      );
    return 'Installed Windows copy.';
  }

  async status(): Promise<UpdateStatusSnapshot> {
    const workActive = await this.isBusy();
    return {
      installedVersion: this.currentVersion,
      channel: UPDATE_CHANNEL,
      owner: UPDATE_OWNER,
      repo: UPDATE_REPO,
      releasesUrl: UPDATE_RELEASES_URL,
      platform: this.platform,
      packaged: this.packaged,
      installed: this.installed,
      supported: this.platform === 'win32' && this.packaged && this.installed,
      supportReason: this.supportReason(),
      workActive,
      check: {
        phase: this.checkPhase === 'checking' ? 'checking' : this.checkAt ? 'done' : 'idle',
        at: this.checkAt,
        outcome: this.outcome,
        latestVersion: this.record?.version ?? null,
        notesUrl: this.record?.notesUrl ?? null,
        detail: this.detail,
      },
      download: {
        ready: this.record?.stagedSha256 !== null && this.record?.stagedSha256 !== undefined,
        version: this.record?.version ?? null,
        assetName: this.record?.assetName ?? null,
        bytes: this.record?.stagedBytes ?? null,
        sha256: this.record?.stagedSha256 ?? null,
        verified: !this.record?.stagedSha256 ? null : 'size-origin-digest',
      },
      install: { phase: this.installPhase, version: this.installVersion },
    };
  }

  check(body?: unknown, signal?: AbortSignal): Promise<UpdateStatusSnapshot['check']> {
    const normalized = normalizeBodySignal(body, signal);
    try {
      assertEmptyBody(normalized.body);
    } catch (error) {
      return Promise.reject(error);
    }
    if (this.checking) return this.checking;
    this.checking = this.runCheck(normalized.signal).finally(() => {
      this.checking = null;
    });
    return this.checking;
  }

  private clearRecord(): void {
    this.record = null;
    this.generation += 1;
  }

  private async runCheck(signal?: AbortSignal): Promise<UpdateStatusSnapshot['check']> {
    if (this.isInstallAccepted())
      throw new ApiError(409, 'The app update is already accepted. Restart to finish it.');
    this.checkPhase = 'checking';
    try {
      let payload: unknown;
      try {
        payload = await this.transport.fetchRelease(withTimeout(signal, CHECK_TIMEOUT_MS));
      } catch (error) {
        if (error instanceof ApiError && error.status === 404) {
          this.clearRecord();
          return this.recordCheck('no-release', 'No public release is published yet.');
        }
        // Offline, rate-limit, timeout and malformed feeds are visible
        // errors; the old actionable record must not survive them.
        this.clearRecord();
        throw error;
      }
      let parsed;
      try {
        parsed = selectWindowsAsset(payload);
      } catch (error) {
        this.clearRecord();
        throw new ApiError(
          502,
          error instanceof Error ? error.message : 'The release metadata was malformed.',
        );
      }
      if (parsed.draft) {
        this.clearRecord();
        return this.recordCheck('no-release', 'The latest release is a draft.');
      }
      if (parsed.prerelease) {
        this.clearRecord();
        return this.recordCheck(
          'prerelease-only',
          `Version ${parsed.version} is a prerelease. Stable updates only.`,
        );
      }
      if (!parsed.asset) {
        this.clearRecord();
        return this.recordCheck(
          'no-release',
          `Version ${parsed.version} has no Windows installer asset yet.`,
        );
      }
      if (compareVersions(parsed.version, this.currentVersion) <= 0) {
        this.clearRecord();
        return this.recordCheck(
          'current',
          `Version ${this.currentVersion} is current. Latest stable is ${parsed.version}.`,
        );
      }
      this.record = {
        version: parsed.version,
        tag: parsed.tag,
        notesUrl: parsed.notesUrl,
        assetName: parsed.asset.name,
        assetUrl: parsed.asset.url,
        assetSize: parsed.asset.size,
        publishedDigest: parsed.asset.digest,
        verifiedAt: new Date().toISOString(),
        stagedPath: null,
        stagedBytes: null,
        stagedSha256: null,
      };
      this.generation += 1;
      return this.recordCheck(
        'available',
        `Version ${parsed.version} is available. Download it to verify the installer.`,
      );
    } catch (error) {
      this.clearRecord();
      this.recordCheck(
        'error',
        error instanceof Error ? error.message : 'The release check could not be completed.',
      );
      throw error;
    } finally {
      this.checkPhase = 'idle';
    }
  }

  private recordCheck(outcome: UpdateCheckOutcome, detail: string): UpdateStatusSnapshot['check'] {
    this.checkAt = new Date().toISOString();
    this.outcome = outcome;
    this.detail = detail;
    return {
      phase: 'done',
      at: this.checkAt,
      outcome,
      latestVersion: this.record?.version ?? null,
      notesUrl: this.record?.notesUrl ?? null,
      detail,
    };
  }

  download(
    body?: unknown,
    signal?: AbortSignal,
  ): Promise<{ downloaded: boolean; version: string }> {
    const normalized = normalizeBodySignal(body, signal);
    try {
      assertEmptyBody(normalized.body);
    } catch (error) {
      return Promise.reject(error);
    }
    if (this.downloading) return this.downloading;
    this.downloading = this.runDownload(normalized.signal).finally(() => {
      this.downloading = null;
    });
    return this.downloading;
  }

  private ownedStagedPath(assetName: string): { ownedDir: string; stagedPath: string } {
    if (!UPDATE_ASSET_PATTERN.test(assetName))
      throw new ApiError(400, 'That is not a staged installer name.');
    const ownedDir = path.resolve(this.dataDir, 'updates');
    const stagedPath = path.resolve(ownedDir, assetName);
    if (path.dirname(stagedPath) !== ownedDir)
      throw new ApiError(400, 'Only the verified staged installer can be used.');
    return { ownedDir, stagedPath };
  }

  private async verifyStagingDirectory(ownedDir: string): Promise<void> {
    const entry = await fs.lstat(ownedDir);
    if (entry.isSymbolicLink() || !entry.isDirectory())
      throw new ApiError(502, 'The update staging directory is not an owned directory.');
    const [directory, parent] = await Promise.all([
      fs.realpath(ownedDir),
      fs.realpath(this.dataDir),
    ]);
    if (path.dirname(directory) !== parent)
      throw new ApiError(502, 'The update staging directory left the app data folder.');
  }

  private async runDownload(
    signal?: AbortSignal,
  ): Promise<{ downloaded: boolean; version: string }> {
    const admittedGeneration = this.generation;
    const record = this.record;
    if (!record || this.outcome !== 'available')
      throw new ApiError(409, 'Check for updates first. No verified release is pending.');
    if (this.isInstallAccepted())
      throw new ApiError(409, 'The app update is already accepted. Restart to finish it.');
    if (record.stagedSha256 && record.stagedPath)
      return { downloaded: true, version: record.version };
    // Re-validate the fixed channel on every admission; the client asserts nothing.
    if (!parseOfficialAssetUrl(record.assetUrl) || !UPDATE_ASSET_PATTERN.test(record.assetName))
      throw new ApiError(502, 'The verified release record is no longer valid. Check again.');
    if (!SHA_PATTERN.test(record.publishedDigest))
      throw new ApiError(502, 'The verified release record is no longer valid. Check again.');
    const { bytes } = await this.transport.downloadAsset(
      record.assetUrl,
      record.assetSize,
      withTimeout(signal, DOWNLOAD_TIMEOUT_MS),
    );
    // A concurrent check invalidates the generation the download started under.
    if (this.generation !== admittedGeneration || this.record !== record)
      throw new ApiError(409, 'The release record changed during download. Check again.');
    if (bytes.length !== record.assetSize)
      throw new ApiError(
        502,
        'The installer size does not match the release record. Nothing was saved.',
      );
    if (bytes.length > UPDATE_MAX_ASSET_BYTES)
      throw new ApiError(502, 'The installer is larger than the supported bound.');
    const digest = createHash('sha256').update(bytes).digest('hex');
    if (digest !== record.publishedDigest)
      throw new ApiError(
        502,
        'The installer digest does not match the published digest. Nothing was saved.',
      );
    const { ownedDir, stagedPath } = this.ownedStagedPath(record.assetName);
    await fs.mkdir(ownedDir, { recursive: true });
    await this.verifyStagingDirectory(ownedDir);
    // Never overwrite a symlink, hardlink alias or arbitrary file: inspect
    // first, reuse only an identical verified file, else fail closed.
    let existing: Awaited<ReturnType<typeof fs.lstat>> | null = null;
    try {
      existing = await fs.lstat(stagedPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw error;
    }
    if (existing) {
      if (existing.isSymbolicLink())
        throw new ApiError(502, 'The staged installer location is not a regular file.');
      if (!existing.isFile())
        throw new ApiError(502, 'The staged installer location is not a regular file.');
      if (existing.nlink > 1)
        throw new ApiError(502, 'The staged installer location is not a regular file.');
      let current: Uint8Array;
      try {
        current = await fs.readFile(stagedPath);
      } catch {
        throw new ApiError(502, 'The staged installer location is not usable. Check again.');
      }
      if (current.length === bytes.length) {
        const currentDigest = createHash('sha256').update(current).digest('hex');
        if (currentDigest === digest) {
          record.stagedPath = stagedPath;
          record.stagedBytes = bytes.length;
          record.stagedSha256 = digest;
          return { downloaded: true, version: record.version };
        }
      }
      // An owned regular file that differs is removed before an exclusive
      // create; anything else fails closed above without an overwrite.
      await fs.unlink(stagedPath);
    }
    try {
      await fs.writeFile(stagedPath, bytes, { flag: 'wx' });
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === 'EEXIST')
        throw new ApiError(409, 'The staged installer changed during download. Check again.');
      throw error;
    }
    const written = await fs.lstat(stagedPath);
    if (written.isSymbolicLink() || !written.isFile() || written.nlink > 1)
      throw new ApiError(502, 'The staged installer location is not a regular file.');
    record.stagedPath = stagedPath;
    record.stagedBytes = bytes.length;
    record.stagedSha256 = digest;
    return { downloaded: true, version: record.version };
  }

  private parseInstallBody(body: unknown): { assetName: string; sha256: string } {
    // Exact shape: the client names the staged installer, the host verifies it.
    // Paths, URLs, executables, commands and task/grant/worker/principal
    // fields are never accepted.
    if (!body || typeof body !== 'object' || Array.isArray(body))
      throw new ApiError(400, 'Name the staged installer to install.');
    const keys = Object.keys(body);
    if (keys.length !== 2 || !keys.includes('assetName') || !keys.includes('sha256'))
      throw new ApiError(400, 'Only the staged installer identity is accepted.');
    const { assetName, sha256 } = body as Record<string, unknown>;
    if (typeof assetName !== 'string' || !UPDATE_ASSET_PATTERN.test(assetName))
      throw new ApiError(400, 'That is not a staged installer name.');
    if (typeof sha256 !== 'string' || !SHA_PATTERN.test(sha256))
      throw new ApiError(400, 'That is not a staged installer digest.');
    return { assetName, sha256 };
  }

  install(body: unknown): Promise<{ launched: boolean; version: string }> {
    // Validate before sharing an in-flight admission so a forged concurrent
    // body is never accepted as a replay of another request.
    let parsed: { assetName: string; sha256: string };
    try {
      parsed = this.parseInstallBody(body);
    } catch (error) {
      return Promise.reject(error);
    }
    if (this.installing) {
      if (
        this.pendingInstall &&
        this.pendingInstall.assetName === parsed.assetName &&
        this.pendingInstall.sha256 === parsed.sha256
      )
        return this.installing;
      return Promise.reject(new ApiError(409, 'The update installation is already running.'));
    }
    this.pendingInstall = parsed;
    this.installing = this.runInstall(parsed).finally(() => {
      this.installing = null;
    });
    return this.installing;
  }

  private async runInstall(admitted: { assetName: string; sha256: string }): Promise<{
    launched: boolean;
    version: string;
  }> {
    if (this.platform !== 'win32' || !this.packaged || !this.installed)
      throw new ApiError(
        501,
        'Close-and-install runs on an installed Windows copy only. ' +
          'Use the release page link for this session.',
      );
    if (await this.isBusy())
      throw new ApiError(
        409,
        'Project work is active. Finish or stop it before installing the update.',
      );
    if (this.isInstallAccepted())
      throw new ApiError(409, 'That update is already accepted. Restart to finish it.');
    const admittedGeneration = this.generation;
    const record = this.record;
    if (!record || !record.stagedPath || !record.stagedSha256)
      throw new ApiError(409, 'Download and verify the update before installing it.');
    if (record.assetName !== admitted.assetName || record.stagedSha256 !== admitted.sha256)
      throw new ApiError(
        409,
        'The staged installer no longer matches the verified record. Download it again.',
      );
    if (!SHA_PATTERN.test(record.publishedDigest) || record.stagedSha256 !== record.publishedDigest)
      throw new ApiError(
        502,
        'The staged installer has no trusted expected digest. Nothing was launched.',
      );
    if (compareVersions(record.version, this.currentVersion) <= 0)
      throw new ApiError(409, 'That version is already installed. No downgrade is offered.');
    // Continuity: re-read the staged file before handoff; never trust the earlier write.
    const { ownedDir, stagedPath } = this.ownedStagedPath(record.assetName);
    if (path.resolve(record.stagedPath) !== stagedPath)
      throw new ApiError(
        502,
        'The staged installer changed after verification. Nothing was launched.',
      );
    let linkStat: Awaited<ReturnType<typeof fs.lstat>>;
    try {
      linkStat = await fs.lstat(stagedPath);
    } catch {
      throw new ApiError(409, 'The staged installer is missing. Download it again.');
    }
    if (linkStat.isSymbolicLink() || !linkStat.isFile() || linkStat.nlink > 1)
      throw new ApiError(
        502,
        'The staged installer changed after verification. Nothing was launched.',
      );
    await this.verifyStagingDirectory(ownedDir);
    if (linkStat.size !== record.assetSize)
      throw new ApiError(
        502,
        'The staged installer changed after verification. Nothing was launched.',
      );
    let staged: Uint8Array;
    try {
      staged = await fs.readFile(stagedPath);
    } catch {
      throw new ApiError(409, 'The staged installer is missing. Download it again.');
    }
    if (staged.length !== record.assetSize)
      throw new ApiError(
        502,
        'The staged installer changed after verification. Nothing was launched.',
      );
    const digest = createHash('sha256').update(staged).digest('hex');
    if (digest !== record.stagedSha256 || digest !== record.publishedDigest)
      throw new ApiError(
        502,
        'The staged installer changed after verification. Nothing was launched.',
      );
    // Recheck idle work and generation immediately before admission: async
    // verification must not let new work or a new feed slip in.
    if (this.generation !== admittedGeneration || this.record !== record)
      throw new ApiError(409, 'The release record changed during verification. Check again.');
    if (this.isInstallAccepted())
      throw new ApiError(409, 'That update is already accepted. Restart to finish it.');
    if (this.checking || this.downloading)
      throw new ApiError(409, 'The release record is still changing. Wait for it to finish.');
    // Latch admission before the async handoff so competing admissions
    // serialize instead of launching twice.
    this.installPhase = 'installing';
    try {
      // The latch blocks new mutations while this asynchronous idle check
      // observes requests that were already admitted.
      if (await this.isBusy())
        throw new ApiError(
          409,
          'Project work became active during verification. Finish or stop it before installing.',
        );
      if (this.generation !== admittedGeneration || this.record !== record)
        throw new ApiError(409, 'The release record changed during verification. Check again.');
      const artifact: UpdateInstallArtifact = {
        path: stagedPath,
        sha256: digest,
        size: staged.length,
        version: record.version,
      };
      try {
        await this.transport.launchInstaller(artifact);
      } catch (error) {
        if (error instanceof ApiError) throw error;
        throw new ApiError(
          500,
          error instanceof Error
            ? `The installer could not start: ${error.message}`
            : 'The installer could not start.',
        );
      }
      this.installPhase = 'launched';
      this.installVersion = record.version;
      this.pendingInstall = null;
      return { launched: true, version: record.version };
    } catch (error) {
      if (this.installPhase === 'installing') this.installPhase = 'idle';
      if (error instanceof ApiError && error.status >= 500) this.pendingInstall = null;
      throw error;
    }
  }
}

export function mountAppUpdateRoutes(
  app: express.Express,
  updates: AppUpdateService,
  opts: { onInstallAccepted?: () => void } = {},
): void {
  let notified = false;
  const wrap =
    (action: (req: express.Request, res: express.Response) => Promise<unknown>) =>
    async (req: express.Request, res: express.Response, next: express.NextFunction) => {
      try {
        const result = await action(req, res);
        if (!res.headersSent) res.json(result);
      } catch (error) {
        next(error);
      }
    };
  // Update effects never run under task grants: no work/task/session/grant
  // context reaches this service, and every POST body rejects such fields.
  app.get(
    '/api/updates/status',
    wrap(async () => updates.status()),
  );
  app.post(
    '/api/updates/check',
    wrap(async (req) => updates.check(req.body)),
  );
  app.post(
    '/api/updates/download',
    wrap(async (req) => updates.download(req.body)),
  );
  app.post('/api/updates/install', async (req, res, next) => {
    try {
      const result = await updates.install(req.body);
      const accepted = opts.onInstallAccepted;
      if (accepted) {
        const notifyAccepted = () => {
          if (notified) return;
          notified = true;
          try {
            accepted();
          } catch (error) {
            console.error(error);
          }
        };
        // The user already requested close-and-install and the helper is
        // ready. A lost response must not strand that accepted handoff.
        if (res.destroyed) {
          notifyAccepted();
          return;
        }
        res.once('finish', notifyAccepted);
        res.once('close', notifyAccepted);
      }
      res.json(result);
    } catch (error) {
      next(error);
    }
  });
}
