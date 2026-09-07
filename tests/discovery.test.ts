import { describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  createDiscovery,
  defaultDiscoveryDeps,
  type DiscoveryDeps,
  type RunResult,
} from '../server/discovery.js';
import { commandFor } from '../server/discovery.js';
import { CODEX_PROTOCOL_VERSION, createIntegrations } from '../server/integrations.js';
import { createApp } from '../server/app.js';

// Same banned list as the task brief: no status or detail sentence written by
// discovery may use any of these words.
const BANNED =
  /\b(?:kanban|git|github|repo|repository|branch|commit|agent|agentic|worker|model|llm|context window|tokens|mcp|patch|diff|prompt|pipeline|orchestration|autonomous|copilot)\b/gi;

const ROSTER = [
  'sample',
  'codex',
  'claude-code',
  'opencode',
  'oh-my-pi',
  'cursor',
  'hermes',
  'localai',
  'ollama',
  'aioncore',
];

const TEST_ENV = {
  LOCALAPPDATA: 'C:\\Users\\test\\AppData\\Local',
  USERPROFILE: 'C:\\Users\\test',
};

const okRun = (stdout: string, stderr = ''): RunResult => ({
  stdout,
  stderr,
  code: 0,
  timedOut: false,
});

const refusedFetch = (async () => {
  throw new Error('connection refused');
}) as typeof globalThis.fetch;

function fakeDeps(overrides: Partial<DiscoveryDeps> = {}): DiscoveryDeps {
  return {
    platform: 'win32',
    env: { ...TEST_ENV },
    which: async () => [],
    run: async () => okRun(''),
    exists: async () => false,
    fetch: refusedFetch,
    ...overrides,
  };
}

/** Hermes answers with any HTTP status; ollama tags answers 200. Everything else refuses. */
function loopbackUpFetch(): typeof globalThis.fetch {
  return (async (url: unknown) => {
    const target = String(url);
    if (target === 'http://127.0.0.1:8642/') return new Response('hermes home', { status: 200 });
    if (target === 'http://127.0.0.1:11434/api/tags')
      return new Response(JSON.stringify({ models: [] }), { status: 200 });
    throw new Error('connection refused');
  }) as typeof globalThis.fetch;
}

function localAiOkFetch(): typeof globalThis.fetch {
  return (async () =>
    new Response(JSON.stringify({ state: 'idle_unloaded', resident: null }), {
      status: 200,
    })) as typeof globalThis.fetch;
}

function noRuntimeIntegrations(discovery: () => Promise<{ engines: never[] } & Record<string, unknown>>) {
  return createIntegrations({
    createClient: (async () => {
      throw new Error('The synthetic runtime is unavailable.');
    }) as never,
    verifySandbox: async () => {},
    fetch: localAiOkFetch(),
    discovery: discovery as never,
  });
}

describe('binary engine discovery', () => {
  it('reports an engine found on PATH with a parsed version', async () => {
    const discovery = createDiscovery(
      fakeDeps({
        which: async (name) => (name === 'claude' ? ['C:\\tools\\claude.exe'] : []),
        run: async () => okRun('claude 2.1.0 (Windows)\n'),
      }),
    );
    const { engines } = await discovery.discover();
    const claude = engines.find((entry) => entry.id === 'claude-code')!;
    expect(claude).toMatchObject({
      name: 'Claude Code',
      kind: 'online',
      found: true,
      available: false,
      status: 'Installed',
      detail: 'Claude Code 2.1.0 is installed. Diomedes cannot run it yet.',
      installedVersion: '2.1.0',
      location: 'C:\\tools\\claude.exe',
      signIn: 'first-use',
      adapter: 'planned',
      capabilities: [],
    });
  });

  it('uses the first PATH hit when several are reported', async () => {
    const discovery = createDiscovery(
      fakeDeps({
        which: async () => ['C:\\first\\opencode.exe', 'D:\\second\\opencode.exe'],
        run: async () => okRun('opencode 0.9.1'),
      }),
    );
    const { engines } = await discovery.discover();
    expect(engines.find((entry) => entry.id === 'opencode')?.location).toBe(
      'C:\\first\\opencode.exe',
    );
  });

  it('falls back to the known folders when PATH has nothing', async () => {
    const expected = path.join(TEST_ENV.USERPROFILE, '.local', 'bin', 'opencode.exe');
    const seen: string[] = [];
    const discovery = createDiscovery(
      fakeDeps({
        which: async () => [],
        exists: async (candidate) => {
          seen.push(candidate);
          return candidate === expected;
        },
        run: async (resolved) => {
          expect(resolved).toBe(expected);
          return okRun('opencode 0.9.1');
        },
      }),
    );
    const { engines } = await discovery.discover();
    const opencode = engines.find((entry) => entry.id === 'opencode')!;
    expect(opencode.found).toBe(true);
    expect(opencode.location).toBe(expected);
    expect(opencode.installedVersion).toBe('0.9.1');
    expect(seen.length).toBeGreaterThan(0);
  });

  it('reports not installed with no location when nothing is found', async () => {
    const discovery = createDiscovery(fakeDeps());
    const { engines } = await discovery.discover();
    const omp = engines.find((entry) => entry.id === 'oh-my-pi')!;
    expect(omp).toMatchObject({
      found: false,
      available: false,
      status: 'Not installed',
      detail: 'oh-my-pi is not installed on this computer.',
    });
    expect(omp.location).toBeUndefined();
    expect(omp.installedVersion).toBeUndefined();
  });

  it('a timing-out --version still yields found with no version', async () => {
    const discovery = createDiscovery(
      fakeDeps({
        which: async (name) => (name === 'opencode' ? ['C:\\tools\\opencode.exe'] : []),
        run: async () => ({ stdout: '', stderr: '', code: null, timedOut: true }),
      }),
    );
    const { engines } = await discovery.discover();
    const opencode = engines.find((entry) => entry.id === 'opencode')!;
    expect(opencode).toMatchObject({
      found: true,
      available: false,
      status: 'Installed',
      detail: 'OpenCode is installed. Its version could not be read. Diomedes cannot run it yet.',
      location: 'C:\\tools\\opencode.exe',
    });
    expect(opencode.installedVersion).toBeUndefined();
  });

  it('reports Cursor as installed without running its launcher', async () => {
    const ran: string[] = [];
    const discovery = createDiscovery(
      fakeDeps({
        which: async (name) => (name === 'agent' ? ['C:\\tools\\agent.cmd'] : []),
        run: async (file) => {
          ran.push(file);
          return okRun('2026.1.1');
        },
      }),
    );
    const { engines } = await discovery.discover();
    const cursor = engines.find((entry) => entry.id === 'cursor')!;
    expect(cursor).toMatchObject({
      found: true,
      status: 'Installed',
      detail: 'Cursor is installed. Diomedes does not use it.',
      location: 'C:\\tools\\agent.cmd',
    });
    expect(cursor.installedVersion).toBeUndefined();
    expect(ran).toEqual([]);
  });

  it('runs one probe at a time', async () => {
    let active = 0;
    let peak = 0;
    const slow = async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active--;
    };
    const discovery = createDiscovery(
      fakeDeps({
        which: async (name) => {
          await slow();
          return [`C:\\tools\\${name}.exe`];
        },
        run: async () => {
          await slow();
          return okRun('1.0.0');
        },
        fetch: (async () => {
          await slow();
          throw new Error('connection refused');
        }) as typeof globalThis.fetch,
      }),
    );
    await discovery.discover();
    expect(peak).toBe(1);
  });

  it('a failing --version still yields found with no version', async () => {
    const discovery = createDiscovery(
      fakeDeps({
        which: async (name) => (name === 'claude' ? ['C:\\tools\\claude.exe'] : []),
        run: async () => {
          throw new Error('spawn failed');
        },
      }),
    );
    const { engines } = await discovery.discover();
    const claude = engines.find((entry) => entry.id === 'claude-code')!;
    expect(claude.found).toBe(true);
    expect(claude.installedVersion).toBeUndefined();
    expect(claude.detail).toBe(
      'Claude Code is installed. Its version could not be read. Diomedes cannot run it yet.',
    );
  });

  it('garbage --version output is not thrown on', async () => {
    const discovery = createDiscovery(
      fakeDeps({
        which: async (name) => (name === 'omp' ? ['C:\\tools\\omp.exe'] : []),
        run: async () => okRun('\n\n??? nothing shaped like a release here !!!\n'),
      }),
    );
    const { engines } = await discovery.discover();
    const omp = engines.find((entry) => entry.id === 'oh-my-pi')!;
    expect(omp.found).toBe(true);
    expect(omp.installedVersion).toBeUndefined();
    expect(omp.status).toBe('Installed');
  });

  it('reads the version from stderr when stdout is empty', async () => {
    const discovery = createDiscovery(
      fakeDeps({
        which: async (name) => (name === 'ollama' ? ['C:\\tools\\ollama.exe'] : []),
        run: async () => okRun('', 'ollama version is 0.9.0'),
      }),
    );
    const { engines } = await discovery.discover();
    expect(engines.find((entry) => entry.id === 'ollama')?.installedVersion).toBe('0.9.0');
  });

  it('keeps raw output out of the entry when output is huge', async () => {
    const discovery = createDiscovery(
      fakeDeps({
        which: async (name) => (name === 'claude' ? ['C:\\tools\\claude.exe'] : []),
        run: async () => okRun(`3.4.5 ${'x'.repeat(100_000)}`),
      }),
    );
    const { engines } = await discovery.discover();
    const claude = engines.find((entry) => entry.id === 'claude-code')!;
    expect(claude.installedVersion).toBe('3.4.5');
    expect(JSON.stringify(claude).length).toBeLessThan(8192);
  });

  it('the production runner caps stdout over 4 KB', async () => {
    const prod = defaultDiscoveryDeps();
    const result = await prod.run(process.execPath, [
      '-e',
      'process.stdout.write("v".repeat(100000))',
    ]);
    expect(result.stdout.length).toBeLessThanOrEqual(4096);
  });
});

describe('loopback service discovery', () => {
  it('reports Hermes running for any HTTP status, down when refused', async () => {
    const up = await createDiscovery(fakeDeps({ fetch: loopbackUpFetch() })).discover();
    expect(up.engines.find((entry) => entry.id === 'hermes')).toMatchObject({
      found: true,
      available: false,
      status: 'Running',
      detail: 'Hermes is running on this computer. Diomedes does not use it.',
      location: 'http://127.0.0.1:8642/',
      signIn: 'not-needed',
      adapter: 'none',
    });

    const flaky = await createDiscovery(
      fakeDeps({
        fetch: (async () => new Response('busy', { status: 500 })) as typeof globalThis.fetch,
      }),
    ).discover();
    expect(flaky.engines.find((entry) => entry.id === 'hermes')?.status).toBe('Running');

    const down = await createDiscovery(fakeDeps()).discover();
    expect(down.engines.find((entry) => entry.id === 'hermes')).toMatchObject({
      found: false,
      available: false,
      status: 'Not running',
      detail: 'Hermes is not running on this computer.',
    });
  });

  it('reports Ollama installed-not-running and running', async () => {
    const idle = await createDiscovery(
      fakeDeps({
        which: async (name) => (name === 'ollama' ? ['C:\\tools\\ollama.exe'] : []),
        run: async () => okRun('ollama version is 0.9.0'),
        fetch: refusedFetch,
      }),
    ).discover();
    expect(idle.engines.find((entry) => entry.id === 'ollama')).toMatchObject({
      found: true,
      available: false,
      status: 'Installed',
      detail: 'Ollama 0.9.0 is installed but not running. Diomedes does not use it.',
      location: 'C:\\tools\\ollama.exe',
      signIn: 'not-needed',
      adapter: 'none',
    });

    const running = await createDiscovery(
      fakeDeps({
        which: async (name) => (name === 'ollama' ? ['C:\\tools\\ollama.exe'] : []),
        run: async () => okRun('ollama version is 0.9.0'),
        fetch: loopbackUpFetch(),
      }),
    ).discover();
    expect(running.engines.find((entry) => entry.id === 'ollama')).toMatchObject({
      found: true,
      status: 'Running',
      detail: 'Ollama 0.9.0 is running. Diomedes does not use it.',
    });
  });

  it('uses GET with no redirects and a short timeout for loopback checks', async () => {
    const seen: { url: unknown; init: RequestInit }[] = [];
    const watching = (async (url: unknown, init: RequestInit) => {
      seen.push({ url, init });
      throw new Error('refused');
    }) as typeof globalThis.fetch;
    await createDiscovery(fakeDeps({ fetch: watching })).discover();
    expect(seen.length).toBeGreaterThan(0);
    for (const { init } of seen) {
      expect(init.method).toBe('GET');
      expect(init.redirect).toBe('error');
      expect(init.signal).toBeInstanceOf(AbortSignal);
    }
  });
});

describe('codex drift notice', () => {
  const driftDetail = (version: string | undefined) =>
    noRuntimeIntegrations((async () => ({ engines: [], codexInstalledVersion: version })) as never)
      .getIntegrationStatuses({ refresh: true })
      .then((statuses) => statuses.find((entry) => entry.id === 'codex')!.detail);

  it('appends the drift sentence when the installed copy differs', async () => {
    const detail = await driftDetail('9.9.9');
    expect(detail).toContain(
      `Codex 9.9.9 is also installed on this computer; Diomedes uses its own proven ${CODEX_PROTOCOL_VERSION} copy.`,
    );
  });

  it('does not append the sentence when versions match or nothing is installed', async () => {
    expect(await driftDetail(CODEX_PROTOCOL_VERSION)).not.toContain('also installed');
    expect(await driftDetail(undefined)).not.toContain('also installed');
  });
});

describe('roster composition', () => {
  async function allFoundStatuses() {
    const full = await createDiscovery(
      fakeDeps({
        which: async (name) => [`C:\\tools\\${name}.exe`],
        run: async () => okRun('engine 1.2.3'),
        fetch: loopbackUpFetch(),
      }),
    ).discover();
    const integrations = createIntegrations({
      createClient: (async () => {
        throw new Error('The synthetic runtime is unavailable.');
      }) as never,
      verifySandbox: async () => {},
      fetch: localAiOkFetch(),
      discovery: (async () => full) as never,
    });
    return integrations.getIntegrationStatuses({ refresh: true });
  }

  it('returns the roster in order', async () => {
    const statuses = await allFoundStatuses();
    expect(statuses.map((entry) => entry.id)).toEqual(ROSTER);
  });

  it('gives every entry all contract fields', async () => {
    const statuses = await allFoundStatuses();
    expect(statuses).toHaveLength(ROSTER.length);
    for (const entry of statuses) {
      expect(typeof entry.id).toBe('string');
      expect(typeof entry.name).toBe('string');
      expect(['online', 'local', 'sample']).toContain(entry.kind);
      expect(typeof entry.found).toBe('boolean');
      expect(typeof entry.available).toBe('boolean');
      expect(typeof entry.enabled).toBe('boolean');
      expect(typeof entry.status).toBe('string');
      expect(entry.status.length).toBeGreaterThan(0);
      expect(typeof entry.detail).toBe('string');
      expect(entry.detail.length).toBeGreaterThan(0);
      expect(Array.isArray(entry.capabilities)).toBe(true);
      expect(['signed-in', 'not-signed-in', 'unknown', 'first-use', 'not-needed']).toContain(
        entry.signIn,
      );
      expect(['ready', 'planned', 'none']).toContain(entry.adapter);
      expect(Array.isArray(entry.disclosure)).toBe(true);
    }
  });

  it('keeps available false for planned and observe-only engines', async () => {
    const statuses = await allFoundStatuses();
    for (const id of ['claude-code', 'opencode', 'oh-my-pi', 'cursor', 'hermes', 'ollama']) {
      const entry = statuses.find((item) => item.id === id)!;
      expect(entry.found).toBe(true);
      expect(entry.adapter === 'planned' || entry.adapter === 'none').toBe(true);
      expect(entry.available).toBe(false);
    }
  });

  it('uses no banned word in any discovered status or detail', async () => {
    const statuses = await allFoundStatuses();
    for (const id of ['claude-code', 'opencode', 'oh-my-pi', 'cursor', 'hermes', 'ollama']) {
      const entry = statuses.find((item) => item.id === id)!;
      expect(entry.status.match(BANNED) ?? [], `banned word in ${id} status`).toEqual([]);
      expect(entry.detail.match(BANNED) ?? [], `banned word in ${id} detail`).toEqual([]);
    }
    const codex = statuses.find((entry) => entry.id === 'codex')!;
    expect(codex.detail.match(BANNED) ?? [], 'banned word in codex drift').toEqual([]);
  });

  it('re-runs discovery only on refresh', async () => {
    let calls = 0;
    const integrations = createIntegrations({
      createClient: (async () => {
        throw new Error('The synthetic runtime is unavailable.');
      }) as never,
      verifySandbox: async () => {},
      fetch: localAiOkFetch(),
      discovery: (async () => {
        calls++;
        return { engines: [], codexInstalledVersion: undefined };
      }) as never,
    });
    const before = await integrations.getIntegrationStatuses();
    await integrations.getIntegrationStatuses();
    expect(calls).toBe(0);
    expect(before.map((entry) => entry.id)).toEqual(ROSTER);
    const pending = before.filter((entry) => entry.status === 'Not checked');
    expect(pending.map((entry) => entry.id)).toEqual([
      'claude-code',
      'opencode',
      'oh-my-pi',
      'cursor',
      'hermes',
      'ollama',
    ]);
    expect(pending.every((entry) => !entry.found && !entry.available)).toBe(true);
    expect(pending.every((entry) => !BANNED.test(entry.detail))).toBe(true);
    await integrations.getIntegrationStatuses({ refresh: true });
    expect(calls).toBe(1);
    await integrations.getIntegrationStatuses();
    expect(calls).toBe(1);
    await integrations.getIntegrationStatuses({ refresh: true });
    expect(calls).toBe(2);
  });

  it('GET /api/integrations keeps its shape and honours ?refresh=1', async () => {
    const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'diomedes-discovery-'));
    const app = await createApp({
      dataDir: path.join(temp, 'data'),
      projectRoot: path.join(temp, 'projects'),
      stepMs: 20,
    });
    const server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', resolve));
    try {
      const port = (server.address() as { port: number }).port;
      for (const query of ['', '?refresh=1']) {
        const response = await fetch(`http://127.0.0.1:${port}/api/integrations${query}`, {
          headers: { 'X-Diomedes-Client': '1' },
        });
        expect(response.status).toBe(200);
        const body = (await response.json()) as { integrations: { id: string }[] };
        expect(body.integrations.map((entry) => entry.id)).toEqual(ROSTER);
      }
    } finally {
      await app.locals.close();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      await fs.rm(temp, { recursive: true, force: true });
    }
  }, 30_000);
});

describe('Windows launcher shims', () => {
  it('prefers an .exe, then a .cmd, over an extension-less shim from where', async () => {
    const deps = fakeDeps({
      which: async (name) =>
        name === 'opencode'
          ? ['C:\\node\\opencode', 'C:\\node\\opencode.cmd']
          : name === 'claude'
            ? ['C:\\bin\\claude', 'C:\\bin\\claude.cmd', 'C:\\bin\\claude.exe']
            : [],
      run: async (file) => ({
        stdout: /\.(exe|cmd)$/i.test(file) ? '9.9.9' : '',
        stderr: '',
        code: 0,
        timedOut: false,
      }),
    });
    const result = await createDiscovery(deps).discover();
    const opencode = result.engines.find((e) => e.id === 'opencode')!;
    const claude = result.engines.find((e) => e.id === 'claude-code')!;
    expect(opencode.location).toBe('C:\\node\\opencode.cmd');
    expect(opencode.installedVersion).toBe('9.9.9');
    expect(claude.location).toBe('C:\\bin\\claude.exe');
  });

  it('runs .cmd launchers through cmd.exe with a fixed argument list and refuses metacharacters', () => {
    const plain = commandFor('C:\\bin\\claude.exe', ['--version'])!;
    expect(plain.file).toBe('C:\\bin\\claude.exe');
    expect(plain.verbatim).toBe(false);
    const wrapped = commandFor('C:\\a b\\agent.cmd', ['--version'])!;
    expect(wrapped.file.toLowerCase()).toMatch(/cmd\.exe$/);
    expect(wrapped.args).toEqual(['/d', '/s', '/c', '"C:\\a b\\agent.cmd" --version']);
    expect(wrapped.verbatim).toBe(true);
    expect(commandFor('C:\\x\\a"b & calc\\agent.cmd', ['--version'])).toBeUndefined();
    expect(commandFor('C:\\x\\agent.cmd', ['--version', '& calc'])).toBeUndefined();
  });
});
