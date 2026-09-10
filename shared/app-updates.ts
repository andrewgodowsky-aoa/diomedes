/**
 * Bounded application-update channel: pure definitions shared by the Console
 * client and the local service. No network, filesystem or process access here.
 *
 * The only release channel is the fixed official repository below. A newer
 * stable Windows installer is offered as an explicit download, integrity
 * check, then explicit close-and-install using the existing per-user
 * installer. Downgrades, arbitrary hosts, and client-asserted update
 * metadata are never accepted; the verified record lives in host state.
 */
export const UPDATE_OWNER = 'andrewgodowsky-aoa';
export const UPDATE_REPO = 'diomedes';
/** The single supported update artifact: the per-user Windows installer. */
export const UPDATE_CHANNEL = 'stable Windows per-user installer';
export const UPDATE_RELEASES_URL = `https://github.com/${UPDATE_OWNER}/${UPDATE_REPO}/releases`;
export const UPDATE_API_URL = `https://api.github.com/repos/${UPDATE_OWNER}/${UPDATE_REPO}/releases/latest`;
/**
 * Exact installer file name. Mirrors scripts/build-windows-installer.mjs:
 * `Diomedes-Experimental-<semver>-unsigned-setup.exe`.
 */
export const UPDATE_ASSET_PATTERN = /^Diomedes-Experimental-(\d+\.\d+\.\d+)-unsigned-setup\.exe$/;
/** Hosts a verified download is allowed to resolve to after redirects. */
export const UPDATE_DOWNLOAD_HOSTS = [
  'github.com',
  'objects.githubusercontent.com',
  'release-assets.githubusercontent.com',
];
/** Sanity bounds for the staged installer, in bytes. */
export const UPDATE_MIN_ASSET_BYTES = 1024 * 1024;
export const UPDATE_MAX_ASSET_BYTES = 500 * 1024 * 1024;
/** Upper bound for one stable version component; keeps parsing exact. */
export const UPDATE_MAX_VERSION_PART = 99999;
const VERSION_PATTERN = /^v?(\d+)\.(\d+)\.(\d+)$/;
const DIGEST_PATTERN = /^sha256:([0-9a-fA-F]{64})$/;

export type UpdateCheckOutcome =
  | 'available'
  | 'current'
  | 'no-release'
  | 'prerelease-only'
  | 'error';

export interface UpdateReleaseAsset {
  name: string;
  url: string;
  size: number;
  /** Lowercase hex digest taken from the asset's exact `digest` manifest field. */
  digest: string;
}

/** Staged installer handed to the desktop-owned launcher after admission. */
export interface UpdateInstallArtifact {
  path: string;
  sha256: string;
  size: number;
  version: string;
}

export interface ParsedRelease {
  tag: string;
  version: string;
  notesUrl: string;
  prerelease: boolean;
  draft: boolean;
  publishedDigest: string | null;
  asset: UpdateReleaseAsset | null;
}

function safeDecode(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

/** Parse a strict stable `X.Y.Z` version; prereleases and build metadata never qualify. */
export function parseStableVersion(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 32) return null;
  const match = trimmed.match(VERSION_PATTERN);
  if (!match) return null;
  const parts: number[] = [];
  for (let index = 1; index <= 3; index += 1) {
    const raw = match[index];
    if (raw.length > 5) return null;
    // Reject non-canonical padding such as `01.02.03`.
    if (raw.length > 1 && raw.startsWith('0')) return null;
    const numeric = Number(raw);
    if (!Number.isSafeInteger(numeric) || numeric < 0 || numeric > UPDATE_MAX_VERSION_PART)
      return null;
    parts.push(numeric);
  }
  return `${parts[0]}.${parts[1]}.${parts[2]}`;
}

/** Compare stable versions. Negative when `a` is older, positive when newer, zero when equal. */
export function compareVersions(a: string, b: string): number {
  const left = parseStableVersion(a);
  const right = parseStableVersion(b);
  if (!left || !right) throw new Error('Update versions must be stable X.Y.Z.');
  const l = left.split('.').map(Number);
  const r = right.split('.').map(Number);
  for (let index = 0; index < 3; index += 1) {
    if (l[index] !== r[index]) return l[index] < r[index] ? -1 : 1;
  }
  return 0;
}

/**
 * Accept only the exact official download path for this channel:
 * `https://github.com/<owner>/<repo>/releases/download/<tag>/<asset>`,
 * where the tag version matches the asset file name.
 */
export function parseOfficialAssetUrl(value: unknown): {
  tag: string;
  version: string;
  name: string;
} | null {
  if (typeof value !== 'string') return null;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:' || parsed.host !== 'github.com') return null;
  if (parsed.username || parsed.password) return null;
  const match = parsed.pathname.match(
    new RegExp(`^/${UPDATE_OWNER}/${UPDATE_REPO}/releases/download/([^/]+)/([^/]+)$`),
  );
  if (!match) return null;
  const tag = safeDecode(match[1]);
  const name = safeDecode(match[2]);
  if (!tag || !name) return null;
  const version = parseStableVersion(tag);
  const nameMatch = name.match(UPDATE_ASSET_PATTERN);
  if (!version || !nameMatch) return null;
  if (nameMatch[1] !== version) return null;
  return { tag: tag.trim(), version, name };
}

/** Exact `sha256:<64 hex>` asset manifest digest; prose digests are never read. */
export function parseAssetDigest(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const match = value.trim().match(DIGEST_PATTERN);
  return match ? match[1].toLowerCase() : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Check/download POSTs carry no fields. Any key — including worker,
 * principal, authorization, grant or task-scope claims — is rejected.
 */
export function isEmptyUpdateBody(value: unknown): boolean {
  if (value === undefined) return true;
  return isRecord(value) && Object.keys(value).length === 0;
}

function exactNotesUrl(tag: string, htmlUrl: unknown): string {
  if (typeof htmlUrl === 'string') {
    let parsed: URL | null = null;
    try {
      parsed = new URL(htmlUrl);
    } catch {
      parsed = null;
    }
    if (parsed && parsed.protocol === 'https:' && !parsed.username && !parsed.password) {
      const expected = `${UPDATE_RELEASES_URL}/tag/${tag}`;
      if (htmlUrl === expected) return htmlUrl;
    }
  }
  return UPDATE_RELEASES_URL;
}

/**
 * Read one fixed-channel GitHub latest-release payload. Returns the stable
 * Windows asset when present, or null when no stable release qualifies.
 * Throws on malformed metadata so the caller reports an explicit error
 * instead of treating a broken feed as current. The expected digest must
 * come from the selected asset's exact `digest` manifest field; release
 * prose is never consulted. Duplicate installer entries or mismatched
 * tag/name/digest/size fail closed.
 */
export function selectWindowsAsset(payload: unknown): ParsedRelease {
  if (!isRecord(payload)) throw new Error('The release channel returned an unexpected body.');
  const tag = payload.tag_name;
  if (typeof tag !== 'string' || !tag.trim())
    throw new Error('The release channel returned a release without a version.');
  const version = parseStableVersion(tag);
  if (!version) throw new Error('The release channel returned an unparsable version.');
  const trimmedTag = tag.trim();
  const release: ParsedRelease = {
    tag: trimmedTag,
    version,
    notesUrl: exactNotesUrl(trimmedTag, payload.html_url),
    prerelease: payload.prerelease === true,
    draft: payload.draft === true,
    publishedDigest: null,
    asset: null,
  };
  const assets = Array.isArray(payload.assets) ? payload.assets : null;
  if (!assets) throw new Error('The release channel returned a release without an asset list.');
  let candidate: UpdateReleaseAsset | null = null;
  for (const entry of assets) {
    if (!isRecord(entry)) continue;
    if (typeof entry.name !== 'string') continue;
    if (!UPDATE_ASSET_PATTERN.test(entry.name)) continue;
    // An installer-named entry must be fully verifiable; anything less
    // fails closed instead of falling back to another row.
    if (typeof entry.browser_download_url !== 'string')
      throw new Error('The release channel returned an installer without a download URL.');
    if (typeof entry.size !== 'number' || !Number.isSafeInteger(entry.size))
      throw new Error('The release channel returned an installer without a valid size.');
    const digest = parseAssetDigest(entry.digest);
    if (!digest)
      throw new Error('The release channel returned an installer without an exact asset digest.');
    const official = parseOfficialAssetUrl(entry.browser_download_url);
    if (!official || official.name !== entry.name || official.version !== version)
      throw new Error('The installer entry does not match the official release channel.');
    if (official.tag !== trimmedTag)
      throw new Error('The installer entry does not match the release tag.');
    if (entry.size < UPDATE_MIN_ASSET_BYTES || entry.size > UPDATE_MAX_ASSET_BYTES)
      throw new Error('The installer size is outside the supported bounds.');
    if (candidate) throw new Error('The release channel returned duplicate installer entries.');
    candidate = { name: entry.name, url: entry.browser_download_url, size: entry.size, digest };
  }
  if (candidate) {
    release.asset = candidate;
    release.publishedDigest = candidate.digest;
  }
  return release;
}

export interface UpdateStatusSnapshot {
  installedVersion: string;
  channel: typeof UPDATE_CHANNEL;
  owner: string;
  repo: string;
  releasesUrl: string;
  platform: string;
  packaged: boolean;
  installed: boolean;
  supported: boolean;
  supportReason: string;
  workActive: boolean;
  check: {
    phase: 'idle' | 'checking' | 'done';
    at: string | null;
    outcome: UpdateCheckOutcome | null;
    latestVersion: string | null;
    notesUrl: string | null;
    detail: string | null;
  };
  download: {
    ready: boolean;
    version: string | null;
    assetName: string | null;
    bytes: number | null;
    /** Echoed back on install as an identifier; the host re-verifies it, never trusts it. */
    sha256: string | null;
    verified: 'size-origin-digest' | null;
  };
  install: {
    phase: 'idle' | 'installing' | 'launched';
    version: string | null;
  };
}
