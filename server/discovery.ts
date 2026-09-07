import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { AdapterState, IntegrationStatus, SignInState } from '../shared/types.js';

// Engine discovery: report what is installed on this computer and whether it
// answers on loopback. Discovery never starts a service, never sends a model
// turn, and never reads credential stores. Probe output is treated as data:
// it is capped, never evaluated, and never logged raw.

const SPAWN_TIMEOUT_MS = 5000;
const OUTPUT_CAP_CHARS = 4096;
const FETCH_TIMEOUT_MS = 2500;
const BODY_CAP_CHARS = 100_000;

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
}

interface SpawnCapture {
  stdout: string;
  stderr: string;
  code: number | null;
  timedOut: boolean;
}

function spawnCapture(file: string, args: string[]): Promise<SpawnCapture> {
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
      child = spawn(file, args, { shell: false, windowsHide: true });
    } catch {
      finish(null);
      return;
    }
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill('SIGKILL');
      } catch {
        // The process is already gone; the close handler settles below.
      }
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
      const resolver = deps.platform === 'win32' ? 'where.exe' : 'which';
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
        await fs.access(candidate);
        return true;
      } catch {
        return false;
      }
    },
    fetch: globalThis.fetch,
  };
  return deps;
}

function knownFolders(deps: DiscoveryDeps): string[] {
  const folders: string[] = [];
  const localAppData = deps.env.LOCALAPPDATA;
  if (localAppData) folders.push(path.join(localAppData, 'Programs', 'OpenAI', 'Codex', 'bin'));
  const home = deps.env.USERPROFILE ?? deps.env.HOME;
  if (home) {
    folders.push(path.join(home, '.local', 'bin'));
    folders.push(path.join(home, '.bun', 'bin'));
  }
  return folders;
}

async function resolveBinary(name: string, deps: DiscoveryDeps): Promise<string | undefined> {
  let candidates: string[] = [];
  try {
    candidates = await deps.which(name);
  } catch {
    candidates = [];
  }
  const hit = candidates.map((line) => line.trim()).find((line) => line.length > 0);
  if (hit) return hit;
  for (const folder of knownFolders(deps)) {
    for (const suffix of ['.exe', '.cmd', '']) {
      const candidate = path.join(folder, `${name}${suffix}`);
      try {
        if (await deps.exists(candidate)) return candidate;
      } catch {
        // A failed existence check is not evidence; keep looking.
      }
    }
  }
  return undefined;
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
}

const BINARY_SPECS: BinarySpec[] = [
  { id: 'claude-code', name: 'Claude Code', binary: 'claude', kind: 'online', signIn: 'first-use', adapter: 'planned' },
  { id: 'opencode', name: 'OpenCode', binary: 'opencode', kind: 'online', signIn: 'first-use', adapter: 'planned' },
  { id: 'oh-my-pi', name: 'oh-my-pi', binary: 'omp', kind: 'online', signIn: 'first-use', adapter: 'planned' },
  { id: 'cursor', name: 'Cursor', binary: 'agent', kind: 'online', signIn: 'first-use', adapter: 'none' },
];

function notFoundEntry(spec: Pick<BinarySpec, 'id' | 'name' | 'kind' | 'signIn' | 'adapter'>): IntegrationStatus {
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

async function probeBinary(spec: BinarySpec, deps: DiscoveryDeps): Promise<IntegrationStatus> {
  const resolved = await resolveBinary(spec.binary, deps);
  if (!resolved) return notFoundEntry(spec);
  let version: string | undefined;
  try {
    const result = await deps.run(resolved, ['--version']);
    if (!result.timedOut) version = parseVersion(result.stdout, result.stderr);
  } catch {
    version = undefined;
  }
  if (!version) return unreadableEntry(spec, resolved);
  const detail =
    spec.adapter === 'planned'
      ? `${spec.name} ${version} is installed. Diomedes cannot run it yet.`
      : `${spec.name} ${version} is installed. Diomedes does not use it.`;
  return versionedEntry(spec, resolved, version, 'Installed', detail);
}

async function drainCapped(
  response: Response,
): Promise<void> {
  try {
    const text = await response.text();
    void (text.length > BODY_CAP_CHARS);
  } catch {
    // The headers already answered; an unreadable body changes nothing.
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
    return {
      ...base,
      found: true,
      status: 'Running',
      detail: 'Hermes is running on this computer. Diomedes does not use it.',
    };
  } catch {
    return base;
  }
}

async function probeOllama(deps: DiscoveryDeps): Promise<IntegrationStatus> {
  const spec = OLLAMA_SPEC;
  const resolved = await resolveBinary(spec.binary, deps);
  let version: string | undefined;
  if (resolved) {
    try {
      const result = await deps.run(resolved, ['--version']);
      if (!result.timedOut) version = parseVersion(result.stdout, result.stderr);
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
  if (!resolved && !running) return notFoundEntry(spec);
  const location = resolved ?? OLLAMA_TAGS_URL;
  if (!version) return unreadableEntry(spec, location, running);
  if (running)
    return versionedEntry(
      spec,
      location,
      version,
      'Running',
      `Ollama ${version} is running. Diomedes does not use it.`,
    );
  return versionedEntry(
    spec,
    location,
    version,
    'Installed',
    `Ollama ${version} is installed but not running. Diomedes does not use it.`,
  );
}

async function probeCodexVersion(deps: DiscoveryDeps): Promise<string | undefined> {
  const resolved = await resolveBinary('codex', deps);
  if (!resolved) return undefined;
  try {
    const result = await deps.run(resolved, ['--version']);
    if (result.timedOut) return undefined;
    return parseVersion(result.stdout, result.stderr);
  } catch {
    return undefined;
  }
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
} {
  const deps: DiscoveryDeps = { ...defaultDiscoveryDeps(), ...overrides };

  async function discover(): Promise<DiscoveryResult> {
    try {
      const [binaries, hermes, ollama, codexInstalledVersion] = await Promise.all([
        Promise.allSettled(BINARY_SPECS.map((spec) => probeBinary(spec, deps))),
        probeHermes(deps).catch(() => hermesDownEntry()),
        probeOllama(deps).catch(() => notFoundEntry(OLLAMA_SPEC)),
        probeCodexVersion(deps).catch(() => undefined),
      ]);
      const engines: IntegrationStatus[] = binaries.map((result, index) =>
        result.status === 'fulfilled' ? result.value : notFoundEntry(BINARY_SPECS[index]),
      );
      engines.push(hermes, ollama);
      return { engines, codexInstalledVersion };
    } catch {
      return emptyDiscovery();
    }
  }

  return { discover };
}
