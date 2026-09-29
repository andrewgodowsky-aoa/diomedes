import fs from 'node:fs/promises';
import { createReadStream, existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { ExternalEngine } from '../../shared/types.js';
import type { InstallOffer } from '../../shared/engines.js';
import { capture, engineEnvironment, EngineError, psQuote, stopped } from './process.js';

type ManagedEngine = Exclude<ExternalEngine, 'cursor' | 'devin'>;
interface Release {
  version: string;
  publisher: string;
  binary: string;
  source: string;
  sha256: string;
  archive: boolean;
  account: string;
}
// Publisher locations are stable; vendor versions are resolved at offer time.
const RELEASES = {
  'claude-code': { publisher: 'Anthropic', binary: 'claude.exe', archive: false,
    source: 'https://downloads.claude.ai/claude-code-releases/latest',
    account: 'Sign in with a Claude subscription through Claude Code. No API billing fallback.' },
  opencode: { publisher: 'Anomaly / OpenCode', binary: 'opencode.exe', archive: true,
    source: 'https://api.github.com/repos/anomalyco/opencode/releases/latest',
    account: 'Uses the selected native OpenCode account. Other billing routes remain separate.' },
  'oh-my-pi': { publisher: 'can1357 / oh-my-pi', binary: 'omp.exe', archive: false,
    source: 'https://api.github.com/repos/can1357/oh-my-pi/releases/latest',
    account: 'Uses the selected native oh-my-pi account; credentials stay with oh-my-pi.' },
} satisfies Record<ManagedEngine, Omit<Release, 'version' | 'sha256'>>;

// Release metadata is discovery, not an independent trust anchor. Keep guided
// downloads on reviewed artifact pins until the vendor has a verified signing
// identity. This does not restrict a person's own native installation.
const REVIEWED_RELEASES = {
  'claude-code': { version: '2.1.252',
    source: 'https://downloads.claude.ai/claude-code-releases/2.1.252/win32-x64/claude.exe',
    sha256: 'fe688ecde90d65fff0b2dd097597439774116077d80a3c1e131a7e47db307b1a' },
  opencode: { version: '1.18.4',
    source: 'https://github.com/anomalyco/opencode/releases/download/v1.18.4/opencode-windows-x64-baseline.zip',
    sha256: '3bfb70c41d0278221d1fbc58efe77f79615491252498ff3f5a82db64266234e0' },
  'oh-my-pi': { version: '18.0.6',
    source: 'https://github.com/can1357/oh-my-pi/releases/download/v18.0.6/omp-windows-x64.exe',
    sha256: '9f458a9bc68170a1e27768f7af6bb183f773d14d596fe6fa9283d43ba34d71e2' },
} satisfies Record<ManagedEngine, Pick<Release, 'version' | 'source' | 'sha256'>>;
const reviewedRelease = (engine: ManagedEngine): Release => ({ ...RELEASES[engine], ...REVIEWED_RELEASES[engine] });

export async function currentEngineRelease(engine: ManagedEngine, fetcher: typeof fetch = fetch, signal?: AbortSignal): Promise<Release> {
  const definition = RELEASES[engine];
  const get = async (url: string) => {
    const response = await fetcher(url, { redirect: 'error', signal: AbortSignal.any([AbortSignal.timeout(15_000), ...(signal ? [signal] : [])]),
      headers: { Accept: 'application/json', 'User-Agent': 'Diomedes' } });
    if (!response.ok) throw new EngineError('INSTALL_METADATA', 'The current official release could not be checked.');
    const text = await response.text();
    if (text.length > 2_000_000) throw new EngineError('INSTALL_METADATA', 'The official release metadata exceeded its limit.');
    return text;
  };
  let version: string, source: string, sha256: string;
  if (engine === 'claude-code') {
    version = (await get(definition.source)).trim();
    if (!/^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/.test(version))
      throw new EngineError('INSTALL_METADATA', 'The official release did not report a usable version.');
    const base = 'https://downloads.claude.ai/claude-code-releases/' + version;
    const manifest = JSON.parse(await get(base + '/manifest.json'));
    const asset = manifest.platforms?.['win32-x64'];
    if (manifest.version !== version || asset?.binary !== 'claude.exe')
      throw new EngineError('INSTALL_METADATA', 'The official release identity was inconsistent.');
    source = base + '/win32-x64/claude.exe';
    sha256 = asset.checksum;
  } else {
    const release = JSON.parse(await get(definition.source));
    if (!/^v[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/.test(release.tag_name) || !Array.isArray(release.assets))
      throw new EngineError('INSTALL_METADATA', 'The official release did not report a usable version.');
    version = release.tag_name.slice(1);
    const name = engine === 'opencode' ? 'opencode-windows-x64-baseline.zip' : 'omp-windows-x64.exe';
    const repo = engine === 'opencode' ? 'anomalyco/opencode' : 'can1357/oh-my-pi';
    source = 'https://github.com/' + repo + '/releases/download/' + release.tag_name + '/' + name;
    const asset = release.assets.find((entry: { name: string }) => entry.name === name);
    if (asset?.browser_download_url !== source || !/^sha256:[a-f0-9]{64}$/.test(asset?.digest ?? ''))
      throw new EngineError('INSTALL_METADATA', 'The official release did not publish a verified Windows download.');
    sha256 = asset.digest.slice(7);
  }
  if (!/^[a-f0-9]{64}$/.test(sha256))
    throw new EngineError('INSTALL_METADATA', 'The official release did not publish its checksum.');
  return { ...definition, version, source, sha256 };
}
const receiptPath = (root: string, engine: string) => path.join(root, 'installed', engine, 'current.json');
// Independently reviewed executable digests also authenticate existing private
// copies. A writable local receipt cannot authorize new executable bytes.
const legacyReceipts: Record<string, { version: string; sha256: string }> = {
  'claude-code': { version: '2.1.252', sha256: 'fe688ecde90d65fff0b2dd097597439774116077d80a3c1e131a7e47db307b1a' },
  opencode: { version: '1.18.4', sha256: '104eb783e554bfd29d1bdd241952e948ecb6462fe1ebc4dfb04742a8b9154014' },
  'oh-my-pi': { version: '18.0.6', sha256: '9f458a9bc68170a1e27768f7af6bb183f773d14d596fe6fa9283d43ba34d71e2' },
};
function installedReceipt(root: string, engine: string): { version: string; sha256: string } | null {
  try {
    const receipt = JSON.parse(readFileSync(receiptPath(root, engine), 'utf8'));
    if (!/^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/.test(receipt.version) || !/^[a-f0-9]{64}$/.test(receipt.sha256))
      throw new EngineError('INSTALL_CHECKSUM', 'The installed artifact receipt could not be verified.');
    return receipt;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      const legacy = legacyReceipts[engine];
      return legacy && existsSync(path.join(root, 'installed', engine, legacy.version, RELEASES[engine as ManagedEngine].binary))
        ? legacy : null;
    }
    throw error;
  }
}
export function managedBinary(root: string, engine: ExternalEngine) {
  if (engine === 'cursor' || engine === 'devin')
    throw new EngineError('INSTALL_UNSUPPORTED', 'Install this engine through its official installer, then recheck.');
  const receipt = installedReceipt(root, engine);
  return path.join(root, 'installed', engine, receipt?.version ?? REVIEWED_RELEASES[engine].version, RELEASES[engine].binary);
}
export async function verifyManagedBinary(root: string, engine: ExternalEngine) {
  if (engine === 'cursor' || engine === 'devin')
    throw new EngineError('INSTALL_UNSUPPORTED', 'This engine is managed by its own installer.');
  const file = managedBinary(root, engine);
  // Check against reviewed bytes as well as the writable local receipt.
  const receipt = installedReceipt(root, engine);
  const digest = createHash('sha256');
  let bytes = 0;
  for await (const chunk of createReadStream(file)) {
    bytes += chunk.length;
    if (bytes > 350_000_000)
      throw new EngineError('INSTALL_CHECKSUM', 'The managed executable exceeded its verified size limit.');
    digest.update(chunk);
  }
  const trusted = legacyReceipts[engine];
  if (!receipt || receipt.version !== trusted.version || receipt.sha256 !== trusted.sha256 || digest.digest('hex') !== trusted.sha256)
    throw new EngineError('INSTALL_CHECKSUM', 'The managed executable differs from its installation receipt. Repair the private copy before rechecking.');
}
export async function extractOpenCode(
  archive: string,
  output: string,
  cwd: string,
  signal?: AbortSignal,
) {
  // Extract exactly one known basename. Archive paths never choose a destination.
  const script =
    `$ErrorActionPreference='Stop'\nAdd-Type -AssemblyName System.IO.Compression.FileSystem\n` +
    `$zip=[IO.Compression.ZipFile]::OpenRead(${psQuote(archive)})\ntry {\n` +
    `$entries=@($zip.Entries | Where-Object { $_.FullName -eq 'opencode.exe' })\n` +
    `if ($entries.Count -ne 1 -or $entries[0].Length -gt 350000000) { throw 'Unsupported release archive' }\n` +
    `[IO.Compression.ZipFileExtensions]::ExtractToFile($entries[0],${psQuote(output)},$false)\n} finally { $zip.Dispose() }`;
  const result = await capture({
    file: path.join(
      process.env.SystemRoot ?? 'C:\\Windows',
      'System32',
      'WindowsPowerShell',
      'v1.0',
      'powershell.exe',
    ),
    args: [
      '-NoProfile',
      '-NonInteractive',
      '-EncodedCommand',
      Buffer.from(script, 'utf16le').toString('base64'),
    ],
    cwd,
    env: engineEnvironment(),
    signal,
    timeoutMs: 30_000,
    maxBytes: 8192,
  });
  if (result.code !== 0)
    throw new EngineError(
      'INSTALL_FAILED',
      'The official release archive could not be unpacked. Check disk space and Windows PowerShell.',
    );
}

/**
 * Set a private copy aside under a name nothing else can hold. The link is made
 * first and the destination removed after, so the copy is never lost between
 * the two, and an existing quarantined file is never written over: a repair is
 * evidence of what was there, and two repairs in one millisecond are two
 * pieces of evidence.
 */
async function quarantine(destination: string): Promise<string> {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  for (let attempt = 0; ; attempt++) {
    const aside = `${destination}.quarantined-${stamp}${attempt ? `-${attempt}` : ''}`;
    try {
      await fs.link(destination, aside);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST' && attempt < 999) continue;
      throw error;
    }
    await fs.unlink(destination);
    return aside;
  }
}

export class EngineInstaller {
  private active = new Set<ExternalEngine>();
  private offers = new Map<ManagedEngine, Release>();
  constructor(
    readonly root: string,
    private deps: {
      fetch?: typeof fetch;
      extract?: typeof extractOpenCode;
      platform?: NodeJS.Platform;
      arch?: string;
      /** The reviewed-release digest check. Injected so a read failure can be told apart. */
      verify?: (root: string, engine: ExternalEngine) => Promise<void>;
    } = {},
  ) {}
  offer(engine: ExternalEngine): InstallOffer {
    if (engine === 'cursor')
      return {
        engine,
        publisher: 'Cursor',
        source: 'https://cursor.com',
        version: 'current',
        destination: 'Chosen by the Cursor installer',
        dependencies: [],
        privileges: 'Managed by the Cursor installer.',
        account: 'Sign in through the native Cursor CLI with agent login.',
        available: false,
        detail:
          'Install Cursor from cursor.com, then check this computer again. Diomedes does not install Cursor.',
      };
    if (engine === 'devin')
      return {
        engine,
        publisher: 'Cognition',
        source: 'https://devin.ai',
        version: 'current',
        destination: 'Chosen by the Devin installer',
        dependencies: [],
        privileges: 'Managed by the Devin installer.',
        account:
          'Sign in through the Devin browser flow. Devin ACP authenticates each session and does not reuse the Devin CLI sign-in.',
        available: false,
        detail:
          'Install Devin Desktop or the Devin CLI, then check this computer again. Diomedes does not install Devin.',
      };
    const release = this.offers.get(engine) ?? reviewedRelease(engine);
    const available =
      (this.deps.platform ?? process.platform) === 'win32' &&
      (this.deps.arch ?? process.arch) === 'x64';
    return {
      engine,
      publisher: release.publisher,
      source: release.source,
      version: release.version,
      destination: path.join(this.root, 'installed', engine, release.version, release.binary),
      dependencies: [
        'Windows x64',
        ...(release.archive ? ['Windows PowerShell (included with Windows)'] : []),
        'Native release includes its JavaScript runtime. No Node.js or Bun installation is added.',
      ],
      privileges: 'Current user only. No elevation, PATH change or security setting change.',
      account: release.account,
      available,
      detail: available
        ? 'Installs the displayed reviewed version after verifying its download. Sign-in is a separate action.'
        : 'Guided installation supports Windows x64. Install the native tool for your platform and recheck.',
    };
  }
  async refreshOffer(engine: ExternalEngine): Promise<InstallOffer> {
    if (engine !== 'cursor' && engine !== 'devin' && this.offer(engine).available) {
      const discovered = await currentEngineRelease(engine, this.deps.fetch);
      const reviewed = reviewedRelease(engine);
      this.offers.set(engine, discovered.version === reviewed.version && discovered.sha256 === reviewed.sha256
        ? discovered : reviewed);
    }
    return this.offer(engine);
  }
  /**
   * `repair` replaces a private copy that failed its digest. It only ever acts
   * inside Diomedes's own `installed/` directory; a person's own installation is
   * never overwritten, downgraded or removed.
   */
  async install(
    engine: ExternalEngine,
    consent: boolean,
    signal?: AbortSignal,
    options: { repair?: boolean } = {},
  ) {
    if (!consent)
      throw new EngineError(
        'CONSENT_REQUIRED',
        'Review and confirm the selected installation first.',
      );
    if (engine === 'cursor' || engine === 'devin' || !this.offer(engine).available)
      throw new EngineError('INSTALL_UNSUPPORTED', this.offer(engine).detail);
    if (this.active.has(engine))
      throw new EngineError('INSTALL_ACTIVE', 'This tool already has an installation in progress.');
    if (signal?.aborted) throw stopped();
    this.active.add(engine);
    let staging: string | undefined;
    try {
      const previous = managedBinary(this.root, engine);
      let verifiedPrevious = false;
      // A completed version is reused. Never overwrite an existing executable.
      try {
        await fs.access(previous);
        await (this.deps.verify ?? verifyManagedBinary)(this.root, engine);
        verifiedPrevious = true;
      } catch (error) {
        const missing = error instanceof Error && 'code' in error && error.code === 'ENOENT';
        if (!missing) {
          // A private copy that no longer matches its reviewed release has no
          // way back without this. Without consent to repair it, the refusal
          // stands rather than silently replacing a file someone may be using.
          if (!options.repair) throw error;
          // Only a proven mismatch is corruption. A copy that could not be read
          // — held open by a scanner, denied for a moment — has said nothing
          // about its content, and setting it aside for that would quarantine a
          // healthy installation. That is something to try again, not to repair.
          if (!(error instanceof EngineError && error.code === 'INSTALL_CHECKSUM'))
            throw new EngineError(
              'INSTALL_UNREADABLE',
              'The private copy could not be read just now, so nothing was changed. Close anything using it and try again.',
              false,
              'runtime-verification',
            );
          // Set it aside inside Diomedes's own installed/ tree, still never
          // launched, so the destination is either empty or verified — never
          // half-written — if the replacement is interrupted.
          await quarantine(previous);
        }
      }
      const release = this.offers.get(engine) ?? reviewedRelease(engine);
      const destination = path.join(this.root, 'installed', engine, release.version, release.binary);
      if (verifiedPrevious && previous === destination)
        return { detail: 'This managed version is already installed. Recheck its connection.' };
      const installRoot = path.join(this.root, 'installed');
      await fs.mkdir(installRoot, { recursive: true });
      staging = await fs.mkdtemp(path.join(installRoot, '.download-'));
      const deadline = AbortSignal.any([AbortSignal.timeout(180_000), ...(signal ? [signal] : [])]);
      const response = await (this.deps.fetch ?? fetch)(release.source, {
        signal: deadline,
        redirect: 'follow',
        headers: { Accept: 'application/octet-stream' },
      });
      if (!response.ok || !response.body)
        throw new EngineError(
          'INSTALL_DOWNLOAD',
          'The official download is unavailable. Check your network and try the selected installation again.',
        );
      const download = path.join(staging, 'download');
      const file = await fs.open(download, 'wx');
      const reader = response.body.getReader(),
        digest = createHash('sha256');
      let bytes = 0;
      try {
        for (;;) {
          const item = await reader.read();
          if (item.done) break;
          bytes += item.value.byteLength;
          if (bytes > 350_000_000)
            throw new EngineError(
              'INSTALL_SIZE',
              'The release exceeded its download limit. Nothing was activated.',
            );
          digest.update(item.value);
          await file.writeFile(item.value);
        }
      } finally {
        await reader.cancel();
        await file.close();
      }
      if (digest.digest('hex') !== release.sha256)
        throw new EngineError(
          'INSTALL_CHECKSUM',
          'The official release checksum did not match. Nothing was activated.',
        );
      const binary = path.join(staging, release.binary);
      if (release.archive)
        await (this.deps.extract ?? extractOpenCode)(download, binary, staging, deadline);
      else await fs.rename(download, binary);
      if (deadline.aborted)
        throw signal?.aborted
          ? stopped()
          : new EngineError('INSTALL_TIMEOUT', 'Installation timed out before activation.');
      await fs.mkdir(path.dirname(destination), { recursive: true });
      const binaryDigest = createHash('sha256');
      for await (const bytes of createReadStream(binary)) binaryDigest.update(bytes);
      const receipt = { version: release.version, sha256: binaryDigest.digest('hex'), source: release.source, artifactSha256: release.sha256 };
      if (receipt.sha256 !== legacyReceipts[engine].sha256)
        throw new EngineError('INSTALL_CHECKSUM', 'The executable does not match the reviewed release. Nothing was activated.');
      try { await fs.link(binary, destination); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        // Recover an interrupted activation only when the existing bytes match
        // this newly verified official artifact. Never overwrite another copy.
        const existing = createHash('sha256');
        for await (const bytes of createReadStream(destination)) existing.update(bytes);
        if (existing.digest('hex') !== receipt.sha256)
          throw new EngineError('INSTALL_CHECKSUM', 'The destination differs from the current official release. Nothing was activated.');
      }
      const pendingReceipt = path.join(staging, 'receipt.json');
      await fs.writeFile(pendingReceipt, JSON.stringify(receipt, null, 2) + '\n');
      await fs.rename(pendingReceipt, receiptPath(this.root, engine));
      return { detail: 'The selected version is installed. Check sign-in and models next.' };
    } catch (error) {
      if (signal?.aborted) throw stopped();
      if (error instanceof EngineError) throw error;
      throw new EngineError(
        'INSTALL_FAILED',
        'Installation did not finish. Check network access, disk space and folder permissions before trying the selected tool again.',
      );
    } finally {
      this.active.delete(engine);
      if (staging)
        await fs.rm(staging, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  }
}
