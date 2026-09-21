import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { AdapterState, IntegrationStatus, SignInState } from '../shared/types.js';
import type { InstallationContext } from '../shared/engines.js';

// Engine discovery: report what is installed on this computer and whether it
// answers on loopback. Discovery never starts a service, never sends a model
// turn, and never reads credential stores. Probe output is treated as data:
// it is capped, never evaluated, and never logged raw.

const SPAWN_TIMEOUT_MS = 5000;
const OUTPUT_CAP_CHARS = 4096;
const FETCH_TIMEOUT_MS = 2500;

export const HERMES_URL = 'http://127.0.0.1:8642/';
export const OLLAMA_TAGS_URL = 'http://127.0.0.1:11434/api/tags';

const VERSION_PATTERN = /\d+\.\d+(?:\.\d+)?/;

const NO_START_DISCLOSURE = 'Diomedes does not start this service or send anything to it.';

export interface RunResult {
  stdout: string;
  stderr: string;
  code: number | null;
  timedOut: boolean;
}

export interface DiscoveryDeps {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  which: (name: string) => Promise<string[]>;
  run: (path: string, args: string[]) => Promise<RunResult>;
  exists: (path: string) => Promise<boolean>;
  fetch: typeof globalThis.fetch;
}

export interface DiscoveryResult {
  engines: IntegrationStatus[];
  codexInstalledVersion?: string;
  /** Installed Codex is an observation, never a replacement for the proven bundled route. */
  codex?: IntegrationStatus;
}

/**
 * One installation this computer offers for an engine. Enumeration reports
 * every place a tool was found, not the first; `EngineService` resolves each
 * one's real path, identity and version before anything may be selected.
 */
export interface DiscoveredInstallation {
  engine: string;
  path: string;
  context: InstallationContext;
}
export interface EnumerationScope {
  engine?: string;
}

interface SpawnCapture {
  stdout: string;
  stderr: string;
  code: number | null;
  timedOut: boolean;
}

/**
 * Windows launcher scripts (.cmd, .bat) cannot be spawned directly without a shell.
 * Run them through cmd.exe with a fixed argument list; refuse paths that carry
 * shell metacharacters so nothing from PATH can smuggle a second command.
 */
export function commandFor(
  file: string,
  args: string[],
): { file: string; args: string[]; verbatim: boolean } | undefined {
  if (!/\.(cmd|bat)$/i.test(file)) return { file, args, verbatim: false };
  if (/["&|<>^%!\r\n]/.test(file) || args.some((arg) => /[\s"&|<>^%!]/.test(arg))) return undefined;
  return {
    file: process.env.ComSpec ?? 'cmd.exe',
    args: ['/d', '/s', '/c', `""${file}" ${args.join(' ')}"`],
    verbatim: true,
  };
}

function spawnCapture(file: string, args: string[]): Promise<SpawnCapture> {
  const command = commandFor(file, args);
  if (!command) return Promise.resolve({ stdout: '', stderr: '', code: null, timedOut: false });
  return new Promise((resolve) => {
    let settled = false;
    let timedOut = false;
    let stdout = '';
    let stderr = '';
    const finish = (code: number | null) => {
      if (settled) return;
      settled = true;
      resolve({ stdout, stderr, code, timedOut });
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(command.file, command.args, {
        shell: false,
        windowsHide: true,
        windowsVerbatimArguments: command.verbatim,
        detached: process.platform !== 'win32',
        stdio: ['ignore', 'pipe', 'pipe'],
        // Version and login-shell lookups have no reason to inherit provider
        // keys, Node injection options, or arbitrary application variables.
        env: Object.fromEntries(
          Object.entries(process.env).filter(([key]) =>
            /^(PATH|PATHEXT|SYSTEMROOT|WINDIR|USERPROFILE|HOME|HOMEDRIVE|HOMEPATH|APPDATA|LOCALAPPDATA|TEMP|TMP|TMPDIR|COMSPEC|PROGRAMFILES|PROGRAMFILES\(X86\)|PROGRAMDATA)$/i.test(
              key,
            ),
          ),
        ),
      });
    } catch {
      finish(null);
      return;
    }
    const timer = setTimeout(() => {
      timedOut = true;
      if (process.platform === 'win32' && child.pid) {
        const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
          windowsHide: true,
          stdio: 'ignore',
        });
        killer.on('error', () => finish(null));
        killer.on('close', () => finish(null));
        setTimeout(() => {
          killer.kill();
          finish(null);
        }, 1000).unref();
        return;
      }
      try {
        if (child.pid) process.kill(-child.pid, 'SIGKILL');
      } catch {
        // The process is already gone; the close handler settles below.
      }
      finish(null);
    }, SPAWN_TIMEOUT_MS);
    child.once('error', () => {
      clearTimeout(timer);
      finish(null);
    });
    child.stdout?.on('data', (chunk: Buffer) => {
      if (stdout.length < OUTPUT_CAP_CHARS) stdout += chunk.toString('utf8');
      if (stdout.length > OUTPUT_CAP_CHARS) stdout = stdout.slice(0, OUTPUT_CAP_CHARS);
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderr.length < OUTPUT_CAP_CHARS) stderr += chunk.toString('utf8');
      if (stderr.length > OUTPUT_CAP_CHARS) stderr = stderr.slice(0, OUTPUT_CAP_CHARS);
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      finish(code);
    });
  });
}

export function defaultDiscoveryDeps(): DiscoveryDeps {
  const deps: DiscoveryDeps = {
    platform: process.platform,
    env: process.env,
    which: async (name) => {
      const resolver = deps.platform === 'win32' ? 'where.exe' : '/usr/bin/which';
      const result = await spawnCapture(resolver, [name]);
      if (result.timedOut || result.code !== 0) return [];
      return result.stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.length > 0);
    },
    run: async (file, args) => {
      const result = await spawnCapture(file, args);
      return {
        stdout: result.stdout,
        stderr: result.stderr,
        code: result.code,
        timedOut: result.timedOut,
      };
    },
    exists: async (candidate) => {
      try {
        await fs.access(
          candidate,
          process.platform === 'win32' ? fs.constants.F_OK : fs.constants.X_OK,
        );
        return (await fs.stat(candidate)).isFile();
      } catch {
        return false;
      }
    },
    fetch: globalThis.fetch,
  };
  return deps;
}

function knownFolders(deps: DiscoveryDeps): string[] {
  if (deps.platform !== 'win32') {
    const home = deps.env.HOME;
    return [
      ...(deps.platform === 'darwin'
        ? ['/opt/homebrew/bin', '/usr/local/bin']
        : ['/usr/local/bin', '/usr/bin']),
      ...(home && path.posix.isAbsolute(home)
        ? [
            path.posix.join(home, '.local', 'bin'),
            path.posix.join(home, '.bun', 'bin'),
            path.posix.join(home, '.opencode', 'bin'),
            path.posix.join(home, '.npm-global', 'bin'),
          ]
        : []),
    ];
  }
  const folders: string[] = [];
  const localAppData = deps.env.LOCALAPPDATA;
  if (localAppData) folders.push(path.join(localAppData, 'Programs', 'OpenAI', 'Codex', 'bin'));
  if (localAppData)
    folders.push(
      path.join(localAppData, 'Microsoft', 'WinGet', 'Links'),
      path.join(localAppData, 'omp'),
      path.join(localAppData, 'cursor-agent'),
      path.join(
        localAppData,
        'Programs',
        'Devin',
        'resources',
        'app',
        'extensions',
        'windsurf',
        'devin',
        'bin',
      ),
    );
  if (deps.env.APPDATA) folders.push(path.join(deps.env.APPDATA, 'npm'));
  const home = deps.env.USERPROFILE ?? deps.env.HOME;
  if (home) {
    folders.push(path.join(home, '.local', 'bin'));
    folders.push(path.join(home, '.bun', 'bin'));
  }
  return folders;
}

/** `where` lists an extension-less shim before its .cmd twin; prefer what Node can run. */
function rankHits(lines: string[]): string[] {
  const hits = lines.map((line) => line.trim()).filter((line) => line.length > 0);
  const rank = (candidate: string) =>
    /\.exe$/i.test(candidate) ? 0 : /\.(cmd|bat)$/i.test(candidate) ? 1 : 2;
  return [...hits].sort((a, b) => rank(a) - rank(b));
}

interface BinaryResolution {
  file?: string;
  method:
    | 'path'
    | 'explicit-location'
    | 'login-shell'
    | 'loopback'
    | 'path/explicit-location/login-shell'
    | 'path/explicit-location'
    | 'unsupported';
}

function posixExecutable(candidate: string): boolean {
  // command -v may print an alias, a function, noise from shell startup, or
  // multiple lines. Only one absolute filename can cross the spawn boundary.
  return (
    path.posix.isAbsolute(candidate) &&
    !/[\x00-\x1f\x7f\\]/.test(candidate) &&
    !/\.(exe|cmd|bat)$/i.test(candidate)
  );
}

async function resolveBinary(name: string, deps: DiscoveryDeps): Promise<BinaryResolution> {
  if (!['win32', 'darwin', 'linux'].includes(deps.platform)) return { method: 'unsupported' };
  let candidates: string[] = [];
  try {
    candidates = await deps.which(name);
  } catch {
    candidates = [];
  }
  const hits = candidates.map((line) => line.trim()).filter((line) => line.length > 0);
  // `where` lists an extension-less shim before its .cmd twin; prefer what Node can run.
  const rank = (candidate: string) =>
    /\.exe$/i.test(candidate) ? 0 : /\.(cmd|bat)$/i.test(candidate) ? 1 : 2;
  const hit = [...hits].sort((a, b) => rank(a) - rank(b))[0];
  if (deps.platform === 'win32' && hit) return { file: hit, method: 'path' };
  if (deps.platform !== 'win32') {
    for (const candidate of hits) {
      try {
        if (posixExecutable(candidate) && (await deps.exists(candidate)))
          return { file: candidate, method: 'path' };
      } catch {
        // An inaccessible PATH candidate is not an observation; try the next.
      }
    }
  }
  const join = deps.platform === 'win32' ? path.join : path.posix.join;
  for (const folder of knownFolders(deps)) {
    for (const suffix of deps.platform === 'win32' ? ['.exe', '.cmd', ''] : ['']) {
      const candidate = join(folder, `${name}${suffix}`);
      try {
        if (await deps.exists(candidate)) return { file: candidate, method: 'explicit-location' };
      } catch {
        // A failed existence check is not evidence; keep looking.
      }
    }
  }
  if (deps.platform === 'darwin') {
    // Finder does not inherit a terminal's PATH. The shell and command are
    // fixed; the executable name is positional data from the static roster.
    // Never run SHELL as a command string or evaluate its captured output.
    const shell = deps.env.SHELL === '/bin/bash' ? '/bin/bash' : '/bin/zsh';
    try {
      const probe = await deps.run(shell, [
        '-lc',
        'command -v -- "$1"',
        'diomedes-discovery',
        name,
      ]);
      const candidate = probe.stdout.trim();
      if (
        !probe.timedOut &&
        probe.code === 0 &&
        posixExecutable(candidate) &&
        (await deps.exists(candidate))
      )
        return { file: candidate, method: 'login-shell' };
    } catch {
      // Failure means this probe did not observe a usable executable.
    }
    return { method: 'path/explicit-location/login-shell' };
  }
  return { method: 'path/explicit-location' };
}

function withDiscovery(
  entry: IntegrationStatus,
  deps: DiscoveryDeps,
  resolution: BinaryResolution,
): IntegrationStatus {
  const state =
    resolution.method === 'unsupported' ? 'unsupported' : entry.found ? 'observed' : 'absent';
  return {
    ...entry,
    ...(state === 'unsupported'
      ? {
          status: 'Unsupported platform',
          detail: `${entry.name} discovery is unsupported on this platform.`,
        }
      : {}),
    ...(!entry.found &&
    state === 'absent' &&
    deps.platform === 'darwin' &&
    resolution.method !== 'loopback'
      ? { detail: `${entry.name} was not observed in the checked locations on this computer.` }
      : {}),
    disclosure: [
      ...entry.disclosure,
      `Discovery: ${state} on ${deps.platform} via ${resolution.method}. Installation does not establish route readiness.`,
    ],
  };
}

/**
 * A Windows GUI process inherits the PATH its launcher had. A tool installed
 * afterwards is invisible to `where` until the app restarts, so read the
 * current user's own PATH from the registry as well. Read-only, through a
 * native argument array, and the value is treated as data: it only ever names
 * directories to look in.
 */
const userPaths = new WeakMap<DiscoveryDeps, Promise<string[]>>();
async function userPathFolders(deps: DiscoveryDeps): Promise<string[]> {
  if (deps.platform !== 'win32') return [];
  let pending = userPaths.get(deps);
  if (!pending) {
    pending = (async () => {
      const reg = path.join(
        deps.env.SystemRoot ?? 'C:\\Windows',
        'System32',
        'reg.exe',
      );
      let result: RunResult;
      try {
        result = await deps.run(reg, ['query', 'HKCU\\Environment', '/v', 'Path']);
      } catch {
        return [];
      }
      if (result.timedOut || result.code !== 0) return [];
      const line = result.stdout
        .split(/\r?\n/)
        .find((row) => /^\s*Path\s+REG_(EXPAND_)?SZ\s+/i.test(row));
      if (!line) return [];
      const value = line.replace(/^\s*Path\s+REG_(EXPAND_)?SZ\s+/i, '');
      return value
        .split(';')
        .map((entry) =>
          entry
            .trim()
            .replace(/%([^%]+)%/g, (whole, name: string) => deps.env[name] ?? whole),
        )
        .filter((entry) => entry.length > 0 && !/%/.test(entry))
        .slice(0, 64);
    })();
    userPaths.set(deps, pending);
  }
  return pending;
}

/** Where an installation lives, from its path alone. Never a guess about an account. */
export function installationContext(file: string, platform: NodeJS.Platform): InstallationContext {
  if (/^\\\\wsl(\$|\.localhost)\\/i.test(file)) return 'wsl';
  if (/[\\/](resources[\\/]app|Contents[\\/]Resources)[\\/]/i.test(file)) return 'desktop-app';
  return platform === 'win32' ? 'windows-native' : 'posix-native';
}

/**
 * A quote, a newline or a NUL in a path is refused for every kind of file: none
 * of them can appear in a path this computer would hand back, and each one ends
 * an argument wherever it is read.
 */
const UNQUOTABLE = /["\r\n\0]/;
/**
 * `& | < > ^ % !` are ordinary characters in a Windows folder name
 * (`C:\Tools\A&B\`). They matter only for a `.cmd` or `.bat`, which has to run
 * through cmd.exe: `launchCommand` refuses such a shim, so leaving it out of
 * the inventory keeps Diomedes from offering an installation it cannot start.
 * A native executable is spawned with an argument array and no shell, so it is
 * enumerated, digested and bindable like any other.
 */
const SHELL_SENSITIVE = /[&|<>^%!]/;
const isShim = (file: string) => /\.(cmd|bat)$/i.test(file);

/**
 * Every installation of one tool this computer offers: PATH hits first, then
 * the supported install locations, then the current user's registry PATH.
 * A Windows shim whose path a shell would have to interpret is left out.
 */
async function enumerateBinary(name: string, deps: DiscoveryDeps): Promise<string[]> {
  const found: string[] = [];
  const seen = new Set<string>();
  const add = (candidate: string) => {
    if (deps.platform === 'win32') {
      if (UNQUOTABLE.test(candidate)) return;
      if (isShim(candidate) && SHELL_SENSITIVE.test(candidate)) return;
    }
    if (deps.platform !== 'win32' && !posixExecutable(candidate)) return;
    const key = deps.platform === 'win32' ? candidate.toLowerCase() : candidate;
    if (seen.has(key)) return;
    seen.add(key);
    found.push(candidate);
  };
  let hits: string[] = [];
  try {
    hits = await deps.which(name);
  } catch {
    hits = [];
  }
  for (const hit of rankHits(hits)) {
    if (deps.platform === 'win32' || (await deps.exists(hit))) add(hit);
  }
  const folders = [...knownFolders(deps), ...(await userPathFolders(deps))];
  for (const folder of folders)
    for (const suffix of deps.platform === 'win32' ? ['.exe', '.cmd', ''] : ['']) {
      const join = deps.platform === 'win32' ? path.join : path.posix.join;
      const candidate = join(folder, `${name}${suffix}`);
      try {
        if (await deps.exists(candidate)) add(candidate);
      } catch {
        // A failed existence check is not evidence; keep looking.
      }
    }
  if (deps.platform === 'darwin') {
    const resolved = await resolveBinary(name, deps);
    if (resolved.file) add(resolved.file);
  }
  return found;
}

function parseVersion(stdout: string, stderr: string): string | undefined {
  const text = `${stdout}\n${stderr}`.slice(0, OUTPUT_CAP_CHARS);
  return text.match(VERSION_PATTERN)?.[0];
}

interface BinarySpec {
  id: string;
  name: string;
  binary: string;
  kind: 'online' | 'local';
  signIn: SignInState;
  adapter: AdapterState;
  /** false: report the binary as installed without running it (its launcher starts an interpreter). */
  probeVersion?: boolean;
}

const BINARY_SPECS: BinarySpec[] = [
  {
    id: 'claude-code',
    name: 'Claude Code',
    binary: 'claude',
    kind: 'online',
    signIn: 'first-use',
    adapter: 'planned',
  },
  {
    id: 'opencode',
    name: 'OpenCode',
    binary: 'opencode',
    kind: 'online',
    signIn: 'first-use',
    adapter: 'planned',
  },
  {
    id: 'oh-my-pi',
    name: 'oh-my-pi',
    binary: 'omp',
    kind: 'online',
    signIn: 'first-use',
    adapter: 'planned',
  },
  {
    id: 'cursor',
    name: 'Cursor',
    binary: 'agent',
    kind: 'online',
    signIn: 'first-use',
    adapter: 'planned',
    probeVersion: true,
  },
  {
    id: 'devin',
    name: 'Devin',
    binary: 'devin',
    kind: 'online',
    signIn: 'first-use',
    adapter: 'planned',
    probeVersion: true,
  },
];

function notFoundEntry(
  spec: Pick<BinarySpec, 'id' | 'name' | 'kind' | 'signIn' | 'adapter'>,
): IntegrationStatus {
  return {
    id: spec.id,
    name: spec.name,
    kind: spec.kind,
    found: false,
    available: false,
    enabled: false,
    status: 'Not installed',
    detail: `${spec.name} is not installed on this computer.`,
    capabilities: [],
    signIn: spec.signIn,
    adapter: spec.adapter,
    disclosure: [NO_START_DISCLOSURE],
  };
}

function unreadableEntry(
  spec: Pick<BinarySpec, 'id' | 'name' | 'kind' | 'signIn' | 'adapter'>,
  location: string,
  running?: boolean,
): IntegrationStatus {
  if (spec.id === 'ollama') {
    return {
      id: spec.id,
      name: spec.name,
      kind: spec.kind,
      found: true,
      available: false,
      enabled: false,
      status: running ? 'Running' : 'Installed',
      detail: running
        ? 'Ollama is running. Diomedes does not use it.'
        : 'Ollama is installed but not running. Diomedes does not use it.',
      capabilities: [],
      signIn: spec.signIn,
      adapter: spec.adapter,
      location,
      disclosure: [NO_START_DISCLOSURE],
    };
  }
  return {
    id: spec.id,
    name: spec.name,
    kind: spec.kind,
    found: true,
    available: false,
    enabled: false,
    status: 'Installed',
    detail:
      spec.adapter === 'planned'
        ? `${spec.name} is installed. Its version could not be read. Diomedes cannot run it yet.`
        : `${spec.name} is installed. Its version could not be read. Diomedes does not use it.`,
    capabilities: [],
    signIn: spec.signIn,
    adapter: spec.adapter,
    location,
    disclosure: [NO_START_DISCLOSURE],
  };
}

function versionedEntry(
  spec: Pick<BinarySpec, 'id' | 'name' | 'kind' | 'signIn' | 'adapter'>,
  location: string,
  version: string,
  status: string,
  detail: string,
): IntegrationStatus {
  return {
    id: spec.id,
    name: spec.name,
    kind: spec.kind,
    found: true,
    available: false,
    enabled: false,
    status,
    detail,
    capabilities: [],
    version,
    installedVersion: version,
    signIn: spec.signIn,
    adapter: spec.adapter,
    location,
    disclosure: [NO_START_DISCLOSURE],
  };
}

/** Roster entries before anyone has asked Diomedes to look: honest, and no process is started. */
export function pendingDiscovery(): DiscoveryResult {
  const pending = (
    spec: Pick<BinarySpec, 'id' | 'name' | 'kind' | 'signIn' | 'adapter'>,
  ): IntegrationStatus => ({
    ...notFoundEntry(spec),
    status: 'Not checked',
    detail: `Diomedes has not looked for ${spec.name} yet. Press Check connections.`,
  });
  return {
    engines: [
      ...BINARY_SPECS.map(pending),
      {
        ...hermesDownEntry(),
        status: 'Not checked',
        detail: 'Diomedes has not looked for Hermes yet. Press Check connections.',
      },
      pending(OLLAMA_SPEC),
    ],
    codexInstalledVersion: undefined,
  };
}

async function probeBinary(spec: BinarySpec, deps: DiscoveryDeps): Promise<IntegrationStatus> {
  const resolution = await resolveBinary(spec.binary, deps);
  const resolved = resolution.file;
  if (!resolved) return withDiscovery(notFoundEntry(spec), deps, resolution);
  if (spec.probeVersion === false)
    return withDiscovery(
      {
        ...notFoundEntry(spec),
        found: true,
        status: 'Installed',
        detail: `${spec.name} is installed. Diomedes does not use it.`,
        location: resolved,
      },
      deps,
      resolution,
    );
  let version: string | undefined;
  try {
    const result = await deps.run(resolved, ['--version']);
    if (!result.timedOut && result.code === 0) version = parseVersion(result.stdout, result.stderr);
  } catch {
    version = undefined;
  }
  if (!version) return withDiscovery(unreadableEntry(spec, resolved), deps, resolution);
  const detail =
    spec.adapter === 'planned'
      ? `${spec.name} ${version} is installed. Diomedes cannot run it yet.`
      : `${spec.name} ${version} is installed. Diomedes does not use it.`;
  return withDiscovery(
    versionedEntry(spec, resolved, version, 'Installed', detail),
    deps,
    resolution,
  );
}

/** The headers already answered; the body is never read, only released. */
async function drainCapped(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // An unreleasable body changes nothing.
  }
}

async function probeHermes(deps: DiscoveryDeps): Promise<IntegrationStatus> {
  const base: IntegrationStatus = {
    id: 'hermes',
    name: 'Hermes',
    kind: 'local',
    found: false,
    available: false,
    enabled: false,
    status: 'Not running',
    detail: 'Hermes is not running on this computer.',
    capabilities: [],
    signIn: 'not-needed',
    adapter: 'none',
    location: HERMES_URL,
    disclosure: [NO_START_DISCLOSURE],
  };
  try {
    const response = await deps.fetch(HERMES_URL, {
      method: 'GET',
      redirect: 'error',
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    await drainCapped(response);
    return withDiscovery(
      {
        ...base,
        found: true,
        status: 'Running',
        detail: 'Hermes is running on this computer. Diomedes does not use it.',
      },
      deps,
      { method: 'loopback' },
    );
  } catch {
    return withDiscovery(base, deps, { method: 'loopback' });
  }
}

async function probeOllama(deps: DiscoveryDeps): Promise<IntegrationStatus> {
  const spec = OLLAMA_SPEC;
  const resolution = await resolveBinary(spec.binary, deps);
  const resolved = resolution.file;
  let version: string | undefined;
  if (resolved) {
    try {
      const result = await deps.run(resolved, ['--version']);
      if (!result.timedOut && result.code === 0)
        version = parseVersion(result.stdout, result.stderr);
    } catch {
      version = undefined;
    }
  }
  let running = false;
  try {
    const response = await deps.fetch(OLLAMA_TAGS_URL, {
      method: 'GET',
      redirect: 'error',
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: { Accept: 'application/json' },
    });
    await drainCapped(response);
    running = response.status === 200;
  } catch {
    running = false;
  }
  const observed = (entry: IntegrationStatus) =>
    withDiscovery(entry, deps, !resolved && running ? { method: 'loopback' } : resolution);
  if (!resolved && !running) return observed(notFoundEntry(spec));
  const location = resolved ?? OLLAMA_TAGS_URL;
  if (!version) return observed(unreadableEntry(spec, location, running));
  if (running)
    return observed(
      versionedEntry(
        spec,
        location,
        version,
        'Running',
        `Ollama ${version} is running. Diomedes does not use it.`,
      ),
    );
  return observed(
    versionedEntry(
      spec,
      location,
      version,
      'Installed',
      `Ollama ${version} is installed but not running. Diomedes does not use it.`,
    ),
  );
}

const OLLAMA_SPEC: BinarySpec = {
  id: 'ollama',
  name: 'Ollama',
  binary: 'ollama',
  kind: 'local',
  signIn: 'not-needed',
  adapter: 'none',
};

function hermesDownEntry(): IntegrationStatus {
  return {
    id: 'hermes',
    name: 'Hermes',
    kind: 'local',
    found: false,
    available: false,
    enabled: false,
    status: 'Not running',
    detail: 'Hermes is not running on this computer.',
    capabilities: [],
    signIn: 'not-needed',
    adapter: 'none',
    location: HERMES_URL,
    disclosure: [NO_START_DISCLOSURE],
  };
}

/** Six not-found entries for when discovery itself cannot answer. */
export function emptyDiscovery(): DiscoveryResult {
  return {
    engines: [
      ...BINARY_SPECS.map((spec) => notFoundEntry(spec)),
      hermesDownEntry(),
      notFoundEntry(OLLAMA_SPEC),
    ],
    codexInstalledVersion: undefined,
  };
}

export function createDiscovery(overrides: Partial<DiscoveryDeps> = {}): {
  discover: () => Promise<DiscoveryResult>;
  installations: (scope?: EnumerationScope) => Promise<DiscoveredInstallation[]>;
} {
  const deps: DiscoveryDeps = { ...defaultDiscoveryDeps(), ...overrides };

  /**
   * Enumerate installations without running anything. Discovery reports what
   * exists; only `EngineService` decides which copy a route may use, after it
   * has resolved each one's real path, recorded its bytes and probed it.
   */
  async function installations(scope: EnumerationScope = {}) {
    const rows: DiscoveredInstallation[] = [];
    for (const spec of BINARY_SPECS) {
      if (scope.engine && spec.id !== scope.engine) continue;
      for (const file of await enumerateBinary(spec.binary, deps).catch(() => []))
        rows.push({
          engine: spec.id,
          path: file,
          context: installationContext(file, deps.platform),
        });
    }
    return rows;
  }

  // One probe at a time: never a burst of child processes, and one hanging
  // probe delays the rest instead of piling up beside them.
  async function discover(): Promise<DiscoveryResult> {
    try {
      const engines: IntegrationStatus[] = [];
      for (const spec of BINARY_SPECS)
        engines.push(await probeBinary(spec, deps).catch(() => notFoundEntry(spec)));
      engines.push(await probeHermes(deps).catch(() => hermesDownEntry()));
      engines.push(await probeOllama(deps).catch(() => notFoundEntry(OLLAMA_SPEC)));
      const codex = await probeBinary(
        {
          id: 'codex',
          name: 'Codex',
          binary: 'codex',
          kind: 'online',
          signIn: 'unknown',
          adapter: 'none',
        },
        deps,
      );
      return { engines, codexInstalledVersion: codex.installedVersion, codex };
    } catch {
      return emptyDiscovery();
    }
  }

  return { discover, installations };
}
