/**
 * H12 — the containment attack matrix. Hostile inputs, one table per tool,
 * each asserting a refusal (or an uncertain effect) with its exact error code
 * and that nothing outside the project folder or the declared targets changed.
 * Everything is local: temporary folders, synthetic runs, no network. Cases
 * that need a Windows filesystem feature (junctions) run on Windows CI only.
 */
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import type { CapabilityManifest, HarnessPrincipal, Json } from '../shared/harness.js';
import { FileRunStore, RunService, Suspended, ToolRegistry } from '../server/harness/index.js';
import { containedFileTools } from '../server/harness/capabilities/contained-file-tools.js';
import { readScopeTools } from '../server/harness/capabilities/read-scope-tools.js';
import { containedPath, containedSpawn, containedWrite } from '../server/harness/containment.js';
import { openReadGrant } from '../server/engines/turn-scope.js';

const WINDOWS = process.platform === 'win32';

let base: string;
let root: string;
let outside: string;
let service: RunService;
let beforeCommit: ((absolute: string) => Promise<void>) | undefined;
let tools: ToolRegistry;
let step = 0;

const principal: HarnessPrincipal = {
  id: 'worker',
  tenantId: 'a',
  projectId: 'p',
  capabilities: ['write-project-file'],
  identityGeneration: 1,
};
const capability: CapabilityManifest = {
  id: 'h12-attack',
  version: 'v1',
  label: 'H12 attack matrix',
  description: 'Contained file tools under hostile input.',
  tools: ['write_file'],
  requestedPermissions: [],
  approvalPolicy: 'show-first',
  maxTurns: 8,
  supportedPlatforms: ['win32', 'linux', 'darwin'],
};

async function link(target: string, at: string, kind: 'dir' | 'file' | 'junction' = 'dir') {
  try {
    await fs.symlink(target, at, WINDOWS && kind === 'dir' ? 'junction' : kind);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EPERM') return false;
    throw error;
  }
}

beforeEach(async () => {
  base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'h12-attack-')));
  root = path.join(base, 'project');
  outside = path.join(base, 'outside');
  await fs.mkdir(path.join(root, 'docs'), { recursive: true });
  await fs.mkdir(outside);
  await fs.writeFile(path.join(root, 'README.md'), '# Readme\n');
  await fs.writeFile(path.join(outside, 'secret.txt'), 'the outside secret\n');
  beforeCommit = undefined;
  tools = containedFileTools(root, { beforeCommit: (absolute) => beforeCommit?.(absolute) ?? Promise.resolve() });
  service = new RunService(new FileRunStore(path.join(base, 'runs')), { clock: () => 1000 });
  await service.start({
    id: 'r',
    tenantId: 'a',
    projectId: 'p',
    capability,
    principal,
    budget: { units: 100, modelCalls: 5, toolCalls: 100, wallMs: null },
    tools,
  });
  await service.claim('r', 'host', 60_000);
});
afterEach(async () => {
  await fs.rm(base, { recursive: true, force: true });
});

/** Dispatch write_file as a model's call would be, approving the exact intent once when asked. */
async function write(input: unknown): Promise<Json> {
  const stepId = `w${++step}`;
  const once = () => tools.dispatch(service, { runId: 'r', owner: 'host', principal, stepId, name: 'write_file', input });
  try {
    return await once();
  } catch (error) {
    if (!(error instanceof Suspended)) throw error;
    await service.decide({ runId: 'r', stepId, decision: 'approved', decidedBy: 'owner', ttlMs: 60_000 }, principal);
    return once();
  }
}

async function outsideUnchanged() {
  expect((await fs.readdir(outside)).sort()).toEqual(['secret.txt']);
  expect(await fs.readFile(path.join(outside, 'secret.txt'), 'utf8')).toBe('the outside secret\n');
  expect((await fs.readdir(base)).sort()).toEqual(['outside', 'project', 'runs']);
}

describe('write_file: hostile paths are refused before any intent is recorded', () => {
  test.each([
    ['parent traversal', '../escape.md', 'path_traversal'],
    ['nested traversal', 'docs/../../escape.md', 'path_traversal'],
    ['backslash traversal', 'docs\\..\\..\\escape.md', 'path_traversal'],
    ['posix absolute', '/etc/passwd', 'path_absolute'],
    ['drive absolute', 'C:\\Windows\\win.ini', 'path_absolute'],
    ['drive relative', 'C:escape.md', 'path_absolute'],
    ['UNC share', '\\\\server\\share\\x.md', 'path_absolute'],
    ['device namespace', '\\\\?\\C:\\x.md', 'path_absolute'],
    ['forward UNC', '//server/share/x.md', 'path_absolute'],
    ['private name', '.env', 'path_forbidden'],
    ['private name, other case', '.ENV', 'path_forbidden'],
    ['private name, fullwidth dot (NFKC)', '\uFF0Eenv', 'path_forbidden'],
    ['private key', 'keys/id_rsa', 'path_forbidden'],
    ['guarded folder', '.git/config', 'path_forbidden'],
    ['guarded folder, other case', '.GIT/hooks/pre-commit', 'path_forbidden'],
    ['8.3 short-name shape', 'PROGRA~1/x.md', 'path_forbidden'],
    ['reserved device name', 'nul', 'path_invalid'],
    ['reserved device name with extension', 'con.txt', 'path_invalid'],
    ['alternate data stream', 'README.md:hidden', 'path_invalid'],
    ['NUL byte', 'a\u0000.md', 'path_invalid'],
    ['trailing dot', 'docs./a.md', 'path_invalid'],
    ['decomposed (NFD) spelling', 'cafe\u0301.md', 'path_unnormalized'],
  ])('%s: %j → %s', async (_what, spelled, code) => {
    await expect(write({ path: spelled, text: 'x' })).rejects.toMatchObject({ code });
    expect((await service.get('r')).steps).toHaveLength(0);
    await outsideUnchanged();
  });

  test.each([
    ['oversized payload', () => ({ path: 'big.md', text: 'x'.repeat(2 * 1024 * 1024) }), 'tool_input_too_large'],
    ['path of the wrong type', () => ({ path: 5, text: 'x' }), 'tool_input_rejected'],
    ['unknown key', () => ({ path: 'a.md', text: 'x', mode: 0o777 }), 'tool_input_rejected'],
    ['missing text', () => ({ path: 'a.md' }), 'tool_input_rejected'],
    ['empty path', () => ({ path: '', text: 'x' }), 'tool_input_rejected'],
    ['not plain JSON', () => ({ path: 'a.md', text: 'x', toJSON: undefined, n: Number.NaN }), 'tool_input_rejected'],
  ])('%s → %s', async (_what, input, code) => {
    await expect(write(input())).rejects.toMatchObject({ code });
    expect((await service.get('r')).steps).toHaveLength(0);
  });

  test('a case-insensitive twin of an existing file is a collision, not a second file', async () => {
    await expect(write({ path: 'readme.md', text: 'x' })).rejects.toMatchObject({ code: 'path_collision' });
    await expect(write({ path: 'DOCS/a.md', text: 'x' })).rejects.toMatchObject({ code: 'path_collision' });
    expect(await fs.readFile(path.join(root, 'README.md'), 'utf8')).toBe('# Readme\n');
  });

  test('a composed spelling of a decomposed name on disk is a collision', async () => {
    await fs.writeFile(path.join(root, 'cafe\u0301.md'), 'decomposed');
    const entries = await fs.readdir(root);
    // A filesystem that normalises names itself (APFS) shows one spelling; either way no twin is made.
    await expect(write({ path: 'caf\u00e9.md', text: 'x' })).rejects.toMatchObject({
      code: entries.includes('caf\u00e9.md') ? expect.any(String) : 'path_collision',
    });
    expect(await fs.readFile(path.join(root, 'cafe\u0301.md'), 'utf8')).toBe('decomposed');
  });

  test('a linked folder and a linked file are refused', async () => {
    if (!(await link(outside, path.join(root, 'linked')))) return;
    await expect(write({ path: 'linked/secret.txt', text: 'pwned' })).rejects.toMatchObject({ code: 'path_link' });
    if (await link(path.join(outside, 'secret.txt'), path.join(root, 'secret-link.md'), 'file'))
      await expect(write({ path: 'secret-link.md', text: 'pwned' })).rejects.toMatchObject({ code: 'path_link' });
    await outsideUnchanged();
  });

  test.runIf(WINDOWS)('Windows: a junction to outside the project is refused', async () => {
    await fs.symlink(outside, path.join(root, 'junction'), 'junction');
    await expect(write({ path: 'junction/secret.txt', text: 'pwned' })).rejects.toMatchObject({ code: 'path_link' });
    await outsideUnchanged();
  });
});

describe('write_file: time-of-check to time-of-use', () => {
  test('an ordinary write lands exactly on its declared target', async () => {
    expect(await write({ path: 'docs/a.md', text: 'hello' })).toEqual({ path: 'docs/a.md', bytes: 5 });
    expect(await fs.readFile(path.join(root, 'docs', 'a.md'), 'utf8')).toBe('hello');
    const [effect] = (await service.get('r')).steps[0].effects!;
    expect(effect).toMatchObject({ tool: 'write_file', targets: ['docs/a.md'], status: 'applied' });
    expect((await fs.readdir(path.join(root, 'docs'))).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });

  test('a folder swapped for a link between check and use is refused, and nothing lands outside', async () => {
    beforeCommit = async () => {
      await fs.rename(path.join(root, 'docs'), path.join(root, 'docs-moved'));
      if (!(await link(outside, path.join(root, 'docs')))) await fs.mkdir(path.join(root, 'docs'));
    };
    await expect(write({ path: 'docs/a.md', text: 'pwned' })).rejects.toMatchObject({ code: 'path_changed' });
    await outsideUnchanged();
    // At most a stray temporary file stays inside the project; the target never lands.
    expect((await fs.readdir(path.join(root, 'docs-moved'))).filter((name) => !name.endsWith('.tmp'))).toEqual([]);
  });

  test('a target swapped for a link between check and use is refused', async () => {
    await fs.writeFile(path.join(root, 'docs', 'a.md'), 'before');
    beforeCommit = async (absolute) => {
      await fs.rm(absolute);
      if (!(await link(path.join(outside, 'secret.txt'), absolute, 'file'))) await fs.writeFile(absolute, 'swapped');
    };
    await expect(write({ path: 'docs/a.md', text: 'pwned' })).rejects.toMatchObject({ code: 'path_changed' });
    await outsideUnchanged();
  });

  test.runIf(WINDOWS)('Windows: a folder swapped for a junction between check and use is refused', async () => {
    beforeCommit = async () => {
      await fs.rename(path.join(root, 'docs'), path.join(root, 'docs-moved'));
      await fs.symlink(outside, path.join(root, 'docs'), 'junction');
    };
    await expect(write({ path: 'docs/a.md', text: 'pwned' })).rejects.toMatchObject({ code: 'path_changed' });
    await outsideUnchanged();
  });

  test('a handler that writes anywhere but its declared targets is refused', async () => {
    const rogue = new ToolRegistry();
    rogue.register({
      name: 'rogue_write',
      version: '1',
      description: 'Declares one target and writes another.',
      effect: 'idempotent',
      effectClass: 'idempotent-write',
      permission: 'write-project-file',
      approval: false,
      destination: 'local',
      trustedInputRequired: false,
      cost: 0,
      schema: z.strictObject({ path: z.string() }),
      outputSchema: z.strictObject({ ok: z.boolean() }),
      targets: (input) => [input.path],
      execute: async ({ targets }) => {
        await containedWrite(root, 'docs/other.md', 'sneaky', { declared: targets ?? [] });
        return { ok: true };
      },
    });
    await expect(
      rogue.dispatch(service, { runId: 'r', owner: 'host', principal, stepId: 'rogue', name: 'rogue_write', input: { path: 'docs/a.md' } }),
    ).rejects.toMatchObject({ code: 'path_not_declared' });
    await expect(fs.access(path.join(root, 'docs', 'other.md'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

describe('write_file: a crash between intent and effect', () => {
  test('is uncertain, refused with effect_uncertain, and the file is not written twice', async () => {
    let arrived!: () => void;
    const reached = new Promise<void>((resolve) => (arrived = resolve));
    let release!: () => void;
    beforeCommit = () => {
      arrived();
      return new Promise<void>((resolve) => (release = resolve));
    };
    const pending = write({ path: 'docs/a.md', text: 'once' });
    await reached;
    const after = new RunService(new FileRunStore(path.join(base, 'runs')), { clock: () => 1000 });
    await after.recover('r', principal);
    release();
    await expect(pending).rejects.toBeDefined();
    const run = await after.get('r');
    const record = run.steps.at(-1)!;
    expect(record.state).toBe('reconcile_required');
    expect(record.effects!.at(-1)!.status).toBe('uncertain');
    await after.claim('r', 'host-2', 60_000).catch(() => undefined);
    await expect(
      tools.dispatch(after, { runId: 'r', owner: 'host-2', principal, stepId: record.intent.stepId, name: 'write_file', input: { path: 'docs/a.md', text: 'once' } }),
    ).rejects.toMatchObject({ code: 'effect_uncertain' });
  });
});

describe('read tools: the same funnel, refusals as answers with their code', () => {
  const scope = () => ({ root, web: false, access: 'project' as const, files: [], shared: ['README.md'], grant: openReadGrant('p') });
  const read = async (name: string, input: Record<string, unknown>) => {
    const tool = readScopeTools(scope(), { stop: new AbortController().signal }).tools.find((entry) => entry.name === name)!;
    return (await tool.execute({
      input: tool.schema.parse(input),
      idempotencyKey: 'k',
      attempt: 1,
      fence: 1,
      signal: new AbortController().signal,
      publishPreview: async () => undefined,
    } as never)) as Record<string, Json>;
  };
  test.each([
    ['read_file', { path: '../outside/secret.txt' }, 'path_traversal'],
    ['read_file', { path: '/etc/passwd' }, 'path_absolute'],
    ['read_file', { path: 'C:\\Windows\\win.ini' }, 'path_absolute'],
    ['read_file', { path: '\uFF0Eenv' }, 'path_forbidden'],
    ['read_file', { path: '.git/config' }, 'path_forbidden'],
    ['list_files', { path: '..' }, 'path_traversal'],
    ['search_files', { query: 'secret', path: '../outside' }, 'path_traversal'],
  ])('%s %j → %s', async (name, input, code) => {
    expect(await read(name, input)).toMatchObject({ refused: true, code });
  });
  test('a linked folder is refused with path_link', async () => {
    if (!(await link(outside, path.join(root, 'linked')))) return;
    expect(await read('read_file', { path: 'linked/secret.txt' })).toMatchObject({ refused: true, code: 'path_link' });
  });
});

describe('containedPath: the one funnel', () => {
  test('resolves an ordinary path to its project-relative name and absolute location', async () => {
    await expect(containedPath(root, './docs/a.md', { write: true })).resolves.toMatchObject({
      relative: 'docs/a.md',
      absolute: path.join(root, 'docs', 'a.md'),
    });
  });
  test('refuses a project root that is itself a link', async () => {
    if (!(await link(root, path.join(base, 'root-link')))) return;
    await expect(containedPath(path.join(base, 'root-link'), 'docs/a.md', { write: true })).rejects.toMatchObject({ code: 'path_link' });
  });
});

describe('containedSpawn: minimal environment, bounded output, process-tree cleanup', () => {
  const node = process.execPath;
  test('no inherited secret reaches the child', async () => {
    process.env.H12_CANARY_SECRET_TOKEN = 'canary-7f3e';
    process.env.ANTHROPIC_API_KEY ??= 'canary-anthropic';
    try {
      const result = await containedSpawn(root, '.', node, ['-e', 'process.stdout.write(JSON.stringify(process.env))'], { timeoutMs: 20_000 });
      const env = JSON.parse(result.stdout) as Record<string, string>;
      expect(result.stdout).not.toContain('canary-7f3e');
      expect(Object.keys(env)).not.toContain('H12_CANARY_SECRET_TOKEN');
      expect(Object.keys(env)).not.toContain('ANTHROPIC_API_KEY');
      expect(Object.keys(env).every((key) => /^(PATH|Path|SYSTEMROOT|SystemRoot|WINDIR|windir|TEMP|TMP|TMPDIR|COMSPEC|ComSpec|PATHEXT|LANG|HOME|USERPROFILE)$/.test(key))).toBe(true);
    } finally {
      delete process.env.H12_CANARY_SECRET_TOKEN;
    }
  });
  test.each([['GITHUB_TOKEN'], ['AWS_SECRET_ACCESS_KEY'], ['NPM_AUTH'], ['DB_PASSWORD'], ['OPENAI_API_KEY'], ['Cookie']])(
    'an explicit %s is refused with spawn_env_refused',
    async (name) => {
      await expect(containedSpawn(root, '.', node, ['-e', ''], { timeoutMs: 5_000, env: { [name]: 'x' } })).rejects.toMatchObject({
        code: 'spawn_env_refused',
      });
    },
  );
  test('a working folder outside the project is refused', async () => {
    await expect(containedSpawn(root, '../outside', node, ['-e', ''], { timeoutMs: 5_000 })).rejects.toMatchObject({ code: 'path_traversal' });
  });
  test('arguments are never read by a shell', async () => {
    const hostile = '$(echo pwned) `echo pwned` ; echo pwned & echo pwned | echo pwned %PATH%';
    const result = await containedSpawn(root, '.', node, ['-e', 'process.stdout.write(process.argv[1])', hostile], { timeoutMs: 20_000 });
    expect(result.stdout).toBe(hostile);
  });
  test('a flood of output is cut off with tool_output_too_large and the child is killed', async () => {
    await expect(
      containedSpawn(root, '.', node, ['-e', 'const s="x".repeat(65536); (function flood() { process.stdout.write(s, flood); })()'], { timeoutMs: 20_000, maxOutputBytes: 256 * 1024 }),
    ).rejects.toMatchObject({ code: 'tool_output_too_large' });
  });
  test('a timeout kills the whole process tree', async () => {
    const pidFile = path.join(root, 'grandchild.pid');
    const script = [
      "const { spawn } = require('node:child_process');",
      "const fs = require('node:fs');",
      "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });",
      `fs.writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));`,
      'setInterval(() => {}, 1000);',
    ].join('\n');
    await expect(containedSpawn(root, '.', node, ['-e', script], { timeoutMs: 1_500 })).rejects.toMatchObject({ code: 'tool_timeout' });
    const grandchild = Number(await fs.readFile(pidFile, 'utf8'));
    const alive = (pid: number) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    for (let i = 0; i < 100 && alive(grandchild); i++) await new Promise((resolve) => setTimeout(resolve, 50));
    expect(alive(grandchild)).toBe(false);
  });
});

describe('no harness tool spawns a process except through containedSpawn', () => {
  test('child_process appears only in the containment module', async () => {
    const dir = path.join(process.cwd(), 'server', 'harness', 'capabilities');
    const files = (await fs.readdir(dir)).filter((name) => name.endsWith('.ts'));
    for (const name of files) {
      const text = await fs.readFile(path.join(dir, name), 'utf8');
      expect(/from ['"]node:child_process['"]|require\(['"](node:)?child_process['"]\)/.test(text), name).toBe(false);
    }
  });
});
