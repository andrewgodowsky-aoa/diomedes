import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { ExternalEngine } from '../../shared/types.js';
import type { InstallOffer } from '../../shared/engines.js';
import { capture, engineEnvironment, EngineError, stopped } from './process.js';

// Exact official Windows assets reviewed 2026-09-10. Never resolve 'latest'.
// Claude: downloads.claude.ai/claude-code-releases/2.1.252/manifest.json.
// GitHub: release asset SHA-256 digests for the corresponding tagged releases.
const RELEASES = {
  'claude-code': {
    version: '2.1.252',
    publisher: 'Anthropic',
    binary: 'claude.exe',
    source: 'https://downloads.claude.ai/claude-code-releases/2.1.252/win32-x64/claude.exe',
    sha256: 'fe688ecde90d65fff0b2dd097597439774116077d80a3c1e131a7e47db307b1a',
    archive: false,
    account: 'Sign in with a Claude subscription through Claude Code. No API billing fallback.',
  },
  opencode: {
    version: '1.18.4',
    publisher: 'Anomaly / OpenCode',
    binary: 'opencode.exe',
    source:
      'https://github.com/anomalyco/opencode/releases/download/v1.18.4/opencode-windows-x64-baseline.zip',
    sha256: '3bfb70c41d0278221d1fbc58efe77f79615491252498ff3f5a82db64266234e0',
    archive: true,
    account:
      'The initial adapter uses an OpenCode Go account. Zen and other billing routes are separate.',
  },
  'oh-my-pi': {
    version: '18.0.6',
    publisher: 'can1357 / oh-my-pi',
    binary: 'omp.exe',
    source: 'https://github.com/can1357/oh-my-pi/releases/download/v18.0.6/omp-windows-x64.exe',
    sha256: '9f458a9bc68170a1e27768f7af6bb183f773d14d596fe6fa9283d43ba34d71e2',
    archive: false,
    account:
      'Uses a separate native oh-my-pi profile with an OpenAI API key configured in models.yml. API billing is separate from ChatGPT; credentials stay with oh-my-pi.',
  },
} satisfies Record<
  ExternalEngine,
  {
    version: string;
    publisher: string;
    binary: string;
    source: string;
    sha256: string;
    archive: boolean;
    account: string;
  }
>;

export function managedBinary(root: string, engine: ExternalEngine) {
  const release = RELEASES[engine];
  return path.join(root, 'installed', engine, release.version, release.binary);
}
export async function verifyManagedBinary(root: string, engine: ExternalEngine) {
  // OpenCode's ZIP digest and its extracted executable digest are different.
  // This executable digest was obtained only after verifying the pinned ZIP.
  const expected =
    engine === 'opencode'
      ? '104eb783e554bfd29d1bdd241952e948ecb6462fe1ebc4dfb04742a8b9154014'
      : RELEASES[engine].sha256;
  const digest = createHash('sha256');
  let bytes = 0;
  for await (const chunk of createReadStream(managedBinary(root, engine))) {
    bytes += chunk.length;
    if (bytes > 350_000_000)
      throw new EngineError(
        'INSTALL_CHECKSUM',
        'The managed executable changed. It was not launched. Restore the reviewed installation before rechecking.',
      );
    digest.update(chunk);
  }
  if (digest.digest('hex') !== expected)
    throw new EngineError(
      'INSTALL_CHECKSUM',
      'The managed executable changed. It was not launched. Restore the reviewed installation before rechecking.',
    );
}
const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;
export async function extractOpenCode(
  archive: string,
  output: string,
  cwd: string,
  signal?: AbortSignal,
) {
  // Extract exactly one known basename. Archive paths never choose a destination.
  const script =
    `$ErrorActionPreference='Stop'\nAdd-Type -AssemblyName System.IO.Compression.FileSystem\n` +
    `$zip=[IO.Compression.ZipFile]::OpenRead(${quote(archive)})\ntry {\n` +
    `$entries=@($zip.Entries | Where-Object { $_.FullName -eq 'opencode.exe' })\n` +
    `if ($entries.Count -ne 1 -or $entries[0].Length -gt 350000000) { throw 'Unsupported release archive' }\n` +
    `[IO.Compression.ZipFileExtensions]::ExtractToFile($entries[0],${quote(output)},$false)\n} finally { $zip.Dispose() }`;
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

export class EngineInstaller {
  private active = new Set<ExternalEngine>();
  constructor(
    readonly root: string,
    private deps: {
      fetch?: typeof fetch;
      extract?: typeof extractOpenCode;
      platform?: NodeJS.Platform;
      arch?: string;
    } = {},
  ) {}
  offer(engine: ExternalEngine): InstallOffer {
    const release = RELEASES[engine];
    const available =
      (this.deps.platform ?? process.platform) === 'win32' &&
      (this.deps.arch ?? process.arch) === 'x64';
    return {
      engine,
      publisher: release.publisher,
      source: release.source,
      version: release.version,
      destination: managedBinary(this.root, engine),
      dependencies: [
        'Windows x64',
        ...(release.archive ? ['Windows PowerShell (included with Windows)'] : []),
        'Native release includes its JavaScript runtime. No Node.js or Bun installation is added.',
      ],
      privileges: 'Current user only. No elevation, PATH change or security setting change.',
      account: release.account,
      available,
      detail: available
        ? 'Downloads only this pinned official release and verifies its SHA-256 before activation. Sign-in is a separate action.'
        : 'Guided installation supports Windows x64. Install the native tool for your platform and recheck.',
    };
  }
  async install(engine: ExternalEngine, consent: boolean, signal?: AbortSignal) {
    if (!consent)
      throw new EngineError(
        'CONSENT_REQUIRED',
        'Review and confirm the selected installation first.',
      );
    if (!this.offer(engine).available)
      throw new EngineError('INSTALL_UNSUPPORTED', this.offer(engine).detail);
    if (this.active.has(engine))
      throw new EngineError('INSTALL_ACTIVE', 'This tool already has an installation in progress.');
    if (signal?.aborted) throw stopped();
    const release = RELEASES[engine],
      destination = managedBinary(this.root, engine);
    this.active.add(engine);
    let staging: string | undefined;
    try {
      // A completed version is reused. Never overwrite an existing executable.
      try {
        await fs.access(destination);
        await verifyManagedBinary(this.root, engine);
        return { detail: 'This managed version is already installed. Recheck its connection.' };
      } catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
      }
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
      await fs.link(binary, destination);
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
