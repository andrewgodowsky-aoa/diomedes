import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { capture, EngineError } from './process.js';

export interface CodexRuntime {
  executable: string;
  identity: string;
  source: 'explicit' | 'installed' | 'bundled';
}
interface RuntimeOptions {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  home?: string;
  dataRoot: string;
}

const fileDigests = new Map<string, { stamp: string; digest: string }>();
const stampOf = (stat: fs.BigIntStats) => `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
function executableDigest(file: string, stat: fs.BigIntStats): string {
  const stamp = stampOf(stat);
  const cached = fileDigests.get(file);
  if (cached?.stamp === stamp) return cached.digest;
  if (stat.size > 400_000_000n) throw new EngineError('RUNTIME_UNSUPPORTED', 'The selected Codex executable exceeds its verification limit.');
  const hash = createHash('sha256');
  const buffer = Buffer.allocUnsafe(256 * 1024);
  const descriptor = fs.openSync(file, 'r');
  try {
    let count: number;
    while ((count = fs.readSync(descriptor, buffer, 0, buffer.length, null)) > 0) hash.update(buffer.subarray(0, count));
    if (stampOf(fs.fstatSync(descriptor, { bigint: true })) !== stamp)
      throw new EngineError('RUNTIME_CHANGED', 'Codex changed while its executable was being checked. Check it again.');
  } finally { fs.closeSync(descriptor); }
  const digest = hash.digest('hex');
  if (fileDigests.size >= 32) fileDigests.clear();
  fileDigests.set(file, { stamp, digest });
  return digest;
}

/** Files, not a vendor version allowlist, identify a selected installation. */
function snapshot(executable: string, source: CodexRuntime['source']): CodexRuntime {
  const directory = path.dirname(executable);
  const files = [executable, ...(/\.exe$/i.test(executable)
    ? ['codex-command-runner.exe', 'codex-windows-sandbox-setup.exe',
        'codex-app-server.exe', 'codex-code-mode-host.exe'].map(name => path.join(directory, name))
    : [])];
  const identity = files.map(file => {
    try {
      const resolved = fs.realpathSync(file);
      const stat = fs.statSync(resolved, { bigint: true });
      // Windows sandbox setup may update an executable's ACL and ctime. Rehash
      // changed metadata, but invalidate a proved runtime only when bytes or its
      // file identity changed. A metadata-only update is not a new engine.
      return `${resolved}:${stat.dev}:${stat.ino}:${executableDigest(resolved, stat)}`;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return `${file}:missing`;
      throw error;
    }
  }).join('|');
  return { executable, identity, source };
}

/** Re-evaluated at connection/dispatch time; the desktop updater owns its install. */
export function resolveCodexRuntime(options: RuntimeOptions): CodexRuntime {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const home = options.home ?? os.homedir();
  const binary = platform === 'win32' ? 'codex.exe' : 'codex';
  if (env.DIOMEDES_RUNTIME_DIR?.trim())
    return snapshot(path.join(env.DIOMEDES_RUNTIME_DIR, binary), 'explicit');
  const candidates: string[] = [];
  if (platform === 'win32') {
    const local = env.LOCALAPPDATA ?? path.join(home, 'AppData', 'Local');
    const desktop = path.join(local, 'OpenAI', 'Codex', 'bin');
    try {
      // Hashed desktop build folders are not sortable versions. The updater's
      // newest executable is selected; every build still proves its capabilities.
      const builds = fs.readdirSync(desktop, { withFileTypes: true })
        .filter(entry => entry.isDirectory()).flatMap(entry => {
          const file = path.join(desktop, entry.name, binary);
          try { const stat = fs.statSync(file); return stat.isFile() ? [{ file, modified: stat.mtimeMs }] : []; }
          catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
            throw error;
          }
        });
      candidates.push(...builds.sort((a, b) => b.modified - a.modified).map(build => build.file));
    } catch (error) {
      if (!['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
    }
    candidates.push(path.join(local, 'Programs', 'OpenAI', 'Codex', 'bin', binary));
  }
  for (const directory of (env.PATH ?? '').split(platform === 'win32' ? ';' : ':')) {
    if (!directory || !path.isAbsolute(directory)) continue;
    candidates.push(path.join(directory, binary));
    if (platform === 'win32') {
      // The npm launcher wraps this native executable; do not spawn a shell wrapper.
      for (const triple of ['x86_64-pc-windows-msvc', 'aarch64-pc-windows-msvc'])
        candidates.push(path.join(directory, 'node_modules', '@openai', 'codex', 'vendor', triple, 'codex', binary));
    }
  }
  const installed = candidates.find(file => {
    try { return fs.statSync(file).isFile(); } catch { return false; }
  });
  if (installed) return snapshot(installed, 'installed');
  return snapshot(path.join(env.DIOMEDES_BUNDLED_RUNTIME_DIR ?? path.join(options.dataRoot, 'native-runtime'), binary), 'bundled');
}

const requiredFields: Record<string, readonly string[]> = {
  ThreadStartParams: ['cwd', 'sandbox', 'approvalPolicy', 'approvalsReviewer', 'modelProvider', 'config',
    'environments', 'runtimeWorkspaceRoots', 'selectedCapabilityRoots', 'dynamicTools', 'allowProviderModelFallback'],
  ThreadResumeParams: ['threadId', 'cwd', 'sandbox', 'approvalPolicy', 'approvalsReviewer', 'modelProvider', 'config', 'runtimeWorkspaceRoots'],
  ThreadForkParams: ['threadId', 'cwd', 'sandbox', 'approvalPolicy', 'modelProvider', 'config', 'runtimeWorkspaceRoots'],
  TurnStartParams: ['threadId', 'input', 'cwd', 'approvalPolicy', 'sandboxPolicy', 'environments', 'runtimeWorkspaceRoots', 'effort', 'summary'],
};

/** A new build is admitted by its protocol, never by matching a vendor version. */
export function requireCodexProtocol(schemas: Record<string, unknown>): void {
  for (const [name, fields] of Object.entries(requiredFields)) {
    const schema = schemas[name] as { properties?: Record<string, unknown> } | undefined;
    const missing = fields.filter(field => !schema?.properties || !Object.hasOwn(schema.properties, field));
    if (missing.length) throw new EngineError('PROTOCOL_UNSUPPORTED',
      `The installed Codex cannot enforce the required conversation boundary (${name}: ${missing.join(', ')}). Nothing was sent.`);
  }
}

let protocolProof: { identity: string; promise: Promise<void> } | undefined;
export async function verifyCodexProtocol(runtime: CodexRuntime, env: NodeJS.ProcessEnv): Promise<void> {
  if (protocolProof?.identity === runtime.identity) return protocolProof.promise;
  const promise = (async () => {
    const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'diomedes-codex-protocol-'));
    try {
      const result = await capture({ file: runtime.executable,
        args: ['app-server', 'generate-json-schema', '--experimental', '--out', directory],
        cwd: directory, env, timeoutMs: 20_000, maxBytes: 8192 });
      if (result.code !== 0) throw new EngineError('PROTOCOL_UNSUPPORTED',
        'The installed Codex did not report its conversation protocol. Nothing was sent.');
      const schemas: Record<string, unknown> = {};
      for (const name of Object.keys(requiredFields)) {
        const file = path.join(directory, 'v2', name + '.json');
        if ((await fs.promises.stat(file)).size > 4_000_000)
          throw new EngineError('PROTOCOL_UNSUPPORTED', 'The Codex protocol description exceeded its limit.');
        schemas[name] = JSON.parse(await fs.promises.readFile(file, 'utf8'));
      }
      requireCodexProtocol(schemas);
    } finally {
      await fs.promises.rm(directory, { recursive: true, force: true });
    }
  })();
  protocolProof = { identity: runtime.identity, promise };
  try { await promise; } catch (error) {
    if (protocolProof?.promise === promise) protocolProof = undefined;
    throw error;
  }
}
