import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  fileAtHead,
  fingerprint,
  newFileDiff,
  parseLog,
  parseStatusV2,
  readRepository,
} from '../server/software-pack/git.js';
import { WORKTREE_FOLDER, parseCommandLine } from '../shared/software-pack.js';

/**
 * P07: the Software Engineering pack reads a repository with the `git`
 * program, through H12's contained spawn. These run real git on temporary
 * repositories.
 */

let temp: string;
beforeEach(async () => {
  // Resolved natively: macOS temp folders sit behind a link, which the path guard refuses, and
  // a Windows runner's temp folder is spelled with an 8.3 alias.
  temp = realpathSync.native(await fs.mkdtemp(path.join(os.tmpdir(), 'diomedes-p07-git-')));
});
afterEach(async () => {
  await fs.rm(temp, { recursive: true, force: true });
});

const run = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1' } });

async function repository(name = 'repo') {
  const root = path.join(temp, name);
  await fs.mkdir(root, { recursive: true });
  run(root, 'init', '-q', '-b', 'main');
  run(root, 'config', 'user.name', 'Ada Lovelace');
  run(root, 'config', 'user.email', 'ada@example.com');
  run(root, 'config', 'commit.gpgsign', 'false');
  await fs.writeFile(path.join(root, 'README.md'), '# Engine\n');
  await fs.writeFile(path.join(root, 'notes.txt'), 'one\n');
  run(root, 'add', '.');
  run(root, 'commit', '-q', '-m', 'First notes');
  await fs.writeFile(path.join(root, 'notes.txt'), 'one\ntwo\n');
  run(root, 'commit', '-q', '-am', 'Second line of notes');
  return root;
}

describe('parsing git status and log', () => {
  test('porcelain v2 with branch headers, renames, untracked, conflicts and spaced names', () => {
    const output = [
      '# branch.oid 1111111111111111111111111111111111111111',
      '# branch.head feature/login',
      '# branch.upstream origin/feature/login',
      '# branch.ab +2 -1',
      '1 .M N... 100644 100644 100644 aaaa bbbb src/app.ts',
      '1 A. N... 000000 100644 100644 0000 cccc docs/a file with spaces.md',
      '2 R. N... 100644 100644 100644 dddd dddd R100 lib/new name.ts',
      'lib/old name.ts',
      'u UU N... 100644 100644 100644 100644 eeee ffff 9999 merge.txt',
      '? café/notes.md',
      '! ignored.log',
      '',
    ].join('\0');
    const { header, changes } = parseStatusV2(output);
    expect(header).toEqual({
      head: '1111111111111111111111111111111111111111',
      branch: 'feature/login',
      detached: false,
      upstream: 'origin/feature/login',
      ahead: 2,
      behind: 1,
    });
    expect(changes).toEqual([
      { path: 'src/app.ts', from: null, kind: 'modified', staged: false, unstaged: true },
      { path: 'docs/a file with spaces.md', from: null, kind: 'added', staged: true, unstaged: false },
      { path: 'lib/new name.ts', from: 'lib/old name.ts', kind: 'renamed', staged: true, unstaged: false },
      { path: 'merge.txt', from: null, kind: 'conflicted', staged: true, unstaged: true },
      { path: 'café/notes.md', from: null, kind: 'untracked', staged: false, unstaged: true },
    ]);
  });

  test('a detached HEAD and a repository with no commit yet', () => {
    expect(parseStatusV2('# branch.oid abc\0# branch.head (detached)\0').header).toMatchObject({
      head: 'abc',
      branch: null,
      detached: true,
    });
    expect(parseStatusV2('# branch.oid (initial)\0# branch.head main\0').header).toMatchObject({
      head: null,
      branch: 'main',
    });
  });

  test('log records with unit separators, ignoring anything that is not a commit', () => {
    const sha = 'a'.repeat(40);
    const text = `${sha}\x1fAda Lovelace\x1f2026-09-24T10:00:00+00:00\x1fFix: tabs | pipes; and "quotes"\x1e\nnot-a-sha\x1fx\x1fy\x1fz\x1e`;
    expect(parseLog(text)).toEqual([
      { sha, author: 'Ada Lovelace', date: '2026-09-24T10:00:00+00:00', subject: 'Fix: tabs | pipes; and "quotes"' },
    ]);
  });

  test('a new file as a unified diff, with and without a final newline', () => {
    expect(newFileDiff('a.txt', 'x\ny\n')).toBe('diff --git a/a.txt b/a.txt\nnew file\n--- /dev/null\n+++ b/a.txt\n@@ -0,0 +1,2 @@\n+x\n+y\n');
    expect(newFileDiff('b.txt', 'z')).toContain('+z\n\\ No newline at end of file\n');
  });
});

describe('reading a real repository', () => {
  test('branch, changed files, and recent commits with authors and messages', async () => {
    const root = await repository();
    await fs.writeFile(path.join(root, 'README.md'), '# Engine\n\nNow with a line.\n');
    await fs.mkdir(path.join(root, 'src'));
    await fs.writeFile(path.join(root, 'src', 'new file.ts'), 'export {};\n');
    const view = await readRepository(root, '2026-09-24T00:00:00.000Z');
    expect(view.state).toBe('repository');
    expect(view.branch).toBe('main');
    expect(view.detached).toBe(false);
    expect(view.head).toMatch(/^[0-9a-f]{40}$/);
    expect(view.changes).toEqual([
      { path: 'README.md', from: null, kind: 'modified', staged: false, unstaged: true },
      { path: 'src/new file.ts', from: null, kind: 'untracked', staged: false, unstaged: true },
    ]);
    expect(view.commits.map((commit) => [commit.author, commit.subject])).toEqual([
      ['Ada Lovelace', 'Second line of notes'],
      ['Ada Lovelace', 'First notes'],
    ]);
    expect(view.commits[0]!.sha).toBe(view.head);
  });

  test('a private name the path guard refuses is counted, never listed', async () => {
    const root = await repository();
    await fs.writeFile(path.join(root, '.env'), 'TOKEN=secret\n');
    await fs.writeFile(path.join(root, 'server.pem'), 'key\n');
    await fs.writeFile(path.join(root, 'visible.md'), 'hi\n');
    const view = await readRepository(root, 'now');
    expect(view.changes.map((change) => change.path)).toEqual(['visible.md']);
    expect(view.privateChanges).toBe(2);
    expect(JSON.stringify(view)).not.toContain('.env');
  });

  test("the pack's own worktree folder is not a change in your checkout's view", async () => {
    const root = await repository();
    await fs.mkdir(path.join(root, WORKTREE_FOLDER, 'x'), { recursive: true });
    await fs.writeFile(path.join(root, WORKTREE_FOLDER, 'x', 'file.txt'), 'x\n');
    const view = await readRepository(root, 'now');
    expect(view.changes).toEqual([]);
  });

  test('a folder that is not a repository says so honestly', async () => {
    const plain = path.join(temp, 'plain');
    await fs.mkdir(plain);
    const view = await readRepository(plain, 'now');
    expect(view.state).toBe('not-a-repository');
    expect(view.detail).toBe('This project folder is not a Git repository.');
    expect(view.changes).toEqual([]);
    expect(view.commits).toEqual([]);
  });

  test('a project that is a subfolder of a repository is not read as that repository', async () => {
    const root = await repository();
    const inner = path.join(root, 'docs');
    await fs.mkdir(inner);
    await fs.writeFile(path.join(root, 'outside-the-project.txt'), 'private to the parent\n');
    const view = await readRepository(inner, 'now');
    expect(view.state).toBe('not-a-repository');
    expect(JSON.stringify(view)).not.toContain('outside-the-project');
  });

  test('a repository with no commit yet lists its files and no history', async () => {
    const root = path.join(temp, 'fresh');
    await fs.mkdir(root);
    run(root, 'init', '-q', '-b', 'trunk');
    await fs.writeFile(path.join(root, 'a.txt'), 'a\n');
    const view = await readRepository(root, 'now');
    expect(view).toMatchObject({ state: 'repository', branch: 'trunk', head: null, commits: [] });
    expect(view.changes.map((change) => change.path)).toEqual(['a.txt']);
  });

  test("reading never runs a program the repository's configuration names", async () => {
    const root = await repository();
    const canary = path.join(temp, 'canary.txt');
    const monitor = path.join(temp, 'monitor.js');
    await fs.writeFile(monitor, `require('fs').writeFileSync(${JSON.stringify(canary)}, 'ran');\n`);
    run(root, 'config', 'core.fsmonitor', `node ${monitor}`);
    run(root, 'config', 'diff.external', `node ${monitor}`);
    await fs.writeFile(path.join(root, 'notes.txt'), 'changed\n');
    const view = await readRepository(root, 'now');
    expect(view.changes.map((change) => change.path)).toEqual(['notes.txt']);
    await fingerprint(root);
    await expect(fs.access(canary)).rejects.toThrow();
  });

  test('a file at HEAD, a file HEAD does not have, and a path outside the project refused', async () => {
    const root = await repository();
    expect((await fileAtHead(root, 'notes.txt')).text).toBe('one\ntwo\n');
    expect((await fileAtHead(root, 'missing.txt')).text).toBeNull();
    await expect(fileAtHead(root, '../outside.txt')).rejects.toThrow();
    await expect(fileAtHead(root, '.env')).rejects.toThrow(/private/);
  });

  test('the fingerprint changes with any change a command could see, untracked content included', async () => {
    const root = await repository();
    const first = await fingerprint(root);
    expect(first?.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(await fingerprint(root)).toEqual(first);
    await fs.writeFile(path.join(root, 'new.txt'), 'a\n');
    const second = await fingerprint(root);
    expect(second?.digest).not.toBe(first?.digest);
    await fs.writeFile(path.join(root, 'new.txt'), 'b\n');
    const third = await fingerprint(root);
    expect(third?.digest).not.toBe(second?.digest);
    expect(await fingerprint(path.join(temp, 'nowhere'))).toBeNull();
  });

  test.runIf(process.platform === 'win32')('Windows: a project folder spelled with forward slashes or a trailing separator reads the same repository', async () => {
    const root = await repository();
    const forward = root.replaceAll('\\', '/');
    const [a, b, c] = await Promise.all([
      readRepository(root, 'now'),
      readRepository(forward, 'now'),
      readRepository(`${root}\\`, 'now'),
    ]);
    expect(b.state).toBe('repository');
    expect(b.head).toBe(a.head);
    expect(c.head).toBe(a.head);
  });

  test('a project folder whose path has spaces and non-ASCII letters', async () => {
    const root = await repository('Projekt mit Umlauten äöü');
    const view = await readRepository(root, 'now');
    expect(view.state).toBe('repository');
    expect(view.commits).toHaveLength(2);
  });
});

describe('a declared command is plain words, never a shell line', () => {
  test.each([
    ['npm test', ['npm', 'test']],
    ['npx   vitest run --reporter=dot', ['npx', 'vitest', 'run', '--reporter=dot']],
    ['./gradlew build', ['./gradlew', 'build']],
    ['node scripts/check.js --max=3,4 @scope/pkg', ['node', 'scripts/check.js', '--max=3,4', '@scope/pkg']],
  ])('%s', (line, argv) => {
    expect(parseCommandLine(line)).toEqual({ ok: true, argv });
  });

  test.each([
    'npm test && rm -rf /',
    'npm test; echo pwned',
    'npm test | tee out',
    'npm test > out.txt',
    'echo $(whoami)',
    'echo `whoami`',
    'echo $HOME',
    'rm *',
    'node -e "process.exit(0)"',
    "node -e 'x'",
    'type %PATH%',
    'npm test\nrm -rf /',
    'cat ~/.ssh/id_rsa',
    'npm run build & start',
    'dir ^&',
  ])('refuses %j with command_shell_refused', (line) => {
    const parsed = parseCommandLine(line);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.code).toBe('command_shell_refused');
  });

  test.each(['bash -c ls', 'sh script.sh', 'cmd /c dir', 'powershell -Command ls', '/usr/bin/env node x.js', 'sudo npm test'])(
    'refuses a shell as the program: %s',
    (line) => {
      const parsed = parseCommandLine(line);
      expect(parsed.ok).toBe(false);
      if (!parsed.ok) expect(parsed.code).toBe('command_shell_program');
    },
  );

  test('refuses nothing, and a command past the limits', () => {
    expect(parseCommandLine('   ')).toMatchObject({ ok: false, code: 'command_empty' });
    expect(parseCommandLine(42)).toMatchObject({ ok: false, code: 'command_empty' });
    expect(parseCommandLine('a '.repeat(40))).toMatchObject({ ok: false, code: 'command_too_long' });
    expect(parseCommandLine('x'.repeat(501))).toMatchObject({ ok: false, code: 'command_too_long' });
  });
});
