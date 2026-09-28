import { afterEach, describe, expect, test } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { Store, hash } from '../server/store.js';
import { activatePack } from '../server/capability-packs.js';
import { ChangeReviewService } from '../server/change-review/service.js';
import { diffGitSnapshots, type GitWorktreeFile } from '../server/change-review/git.js';
import type { ChangeReviewRecord } from '../shared/change-manifest.js';

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function fixture(subdir = 'apps/project', stagedBaseline = false) {
  const parent = path.join(os.tmpdir(), 'astra-change-review-subfolder');
  await fs.mkdir(parent, { recursive: true });
  const temp = await fs.realpath(await fs.mkdtemp(path.join(parent, 'review-')));
  expect(path.dirname(temp)).toBe(await fs.realpath(parent));
  cleanups.push(() => fs.rm(temp, { recursive: true, force: true }));
  const repo = path.join(temp, 'repo');
  const folder = path.join(repo, subdir);
  await fs.mkdir(folder, { recursive: true });
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd: repo, stdio: 'pipe' }).toString().trim();
  git('init', '-q');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  git('config', 'core.autocrlf', 'false');
  const repoPath = (name: string) => (subdir ? `${subdir}/${name}` : name);
  await fs.writeFile(path.join(folder, 'notes.txt'), 'before\n');
  // Hidden files are omitted by the folder walker. Their review text must
  // therefore come through Git's entry and the project-contained reader.
  await fs.writeFile(path.join(folder, '.review.txt'), 'committed before\n');
  if (subdir) {
    await fs.mkdir(path.join(repo, `${subdir}-sibling`), { recursive: true });
    await fs.writeFile(path.join(repo, `${subdir}-sibling`, 'notes.txt'), 'outside\n');
  }
  git('add', '.');
  git('commit', '-q', '-m', 'fixture');
  if (stagedBaseline) {
    await fs.writeFile(path.join(folder, '.review.txt'), 'staged before\n');
    git('add', '--', repoPath('.review.txt'));
    await fs.writeFile(path.join(folder, '.review.txt'), 'unstaged before\n');
  }
  const store = new Store(path.join(temp, 'data'), path.join(temp, 'projects'));
  await store.init();
  const project = await store.createProject('Subfolder review', folder, true);
  await activatePack(store, project.id, 'diomedes.software-engineering');
  const state = store.state(project.id);
  const task = store.createTask(state, { name: 'Edit the notes' });
  const sessionId = 'subfolder-session';
  state.sessions.push({
    id: sessionId,
    taskId: task.id,
    state: 'working',
    startedAt: '2026-09-27T00:00:00.000Z',
    endedAt: null,
    sample: false,
    log: [],
    entryIds: [],
    needId: null,
    engine: { name: 'fixture', model: null, worker: 0, branch: null, context: null, events: 0 },
  });
  await store.persist(state);
  let review = new ChangeReviewService(store);
  cleanups.push(() => review.close());
  await review.init();
  await review.runStarted(project.id, sessionId, task.id);
  const recordFile = path.join(store.dataDir, 'change-review', project.id, `${sessionId}.json`);
  const record = async (): Promise<ChangeReviewRecord> =>
    JSON.parse(await fs.readFile(recordFile, 'utf8'));
  expect((await record()).baseline?.git?.captured).toBe(true);
  return {
    repo,
    folder,
    git,
    repoPath,
    store,
    project,
    task,
    sessionId,
    record,
    manifest: () => review.manifestForSession(project.id, sessionId),
    restart: async () => {
      await review.close();
      review = new ChangeReviewService(store);
      await review.init();
    },
  };
}

describe('change review for a project below the repository root', () => {
  test('a repository-wide historical snapshot cannot surface a sibling as a project path', () => {
    const file = (name: string, renamedFrom: string | null = null): GitWorktreeFile => ({
      path: name,
      x: '.', y: 'M',
      headMode: '100644', indexMode: '100644', worktreeMode: '100644',
      headSha: 'head', stagedSha: 'staged', blobSha: 'raw',
      renamedFrom,
      binary: false,
    });
    const entries = diffGitSnapshots([], [
      file('apps/project/notes.txt', 'apps/project-sibling/old.txt'),
      file('apps/project-sibling/notes.txt'),
    ], [], 'apps/project');
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      id: 'git:apps/project/notes.txt', path: 'notes.txt', renamedFrom: null,
      beforeSha: 'head', afterSha: 'raw',
    });
  });

  test.each(['recorded', 'observed'] as const)(
    'one %s edit produces one project-relative entry with readable content',
    async (writer) => {
      const f = await fixture();
      if (writer === 'recorded') {
        await f.store.writeRecorded(
          f.project.id,
          [{ path: 'notes.txt', text: 'after\n', expected: hash('before\n') }],
          { kind: 'changed', sessionId: f.sessionId, taskId: f.task.id, review: true },
        );
      } else await fs.writeFile(path.join(f.folder, 'notes.txt'), 'after\n');
      await fs.writeFile(path.join(f.repo, 'apps/project-sibling/notes.txt'), 'outside changed\n');
      const manifest = await f.manifest();
      expect(manifest.changes).toHaveLength(1);
      expect(manifest.changes[0]).toMatchObject({ path: 'notes.txt', attribution: writer });
      expect(manifest.changes[0].textEvidence.kind).toBe('diff');
      expect(manifest.changes[0].textEvidence.text).toContain('-before');
      expect(manifest.changes[0].textEvidence.text).toContain('+after');
      expect((await f.manifest()).digest).toBe(manifest.digest);
    },
  );

  test.each(['apps/project', 'app[1]', ''])(
    'Git-only text in project %j uses the project path and preserves Git identity',
    async (subdir) => {
      const f = await fixture(subdir);
      const before = await f.record();
      await fs.writeFile(path.join(f.folder, '.review.txt'), 'after\n');
      const manifest = await f.manifest();
      expect(manifest.changes).toHaveLength(1);
      const entry = manifest.changes[0];
      expect(entry).toMatchObject({
        id: `git:${f.repoPath('.review.txt')}`,
        path: '.review.txt', source: 'git', attribution: 'observed',
        afterSha: f.git('hash-object', '--no-filters', '--', f.repoPath('.review.txt')),
      });
      expect(entry.evidence).toContainEqual({
        kind: 'git-record', record: 'status:.M', path: f.repoPath('.review.txt'),
      });
      expect(entry.textEvidence.kind).toBe('diff');
      expect(entry.textEvidence.text).toContain('-committed before');
      expect(entry.textEvidence.text).toContain('+after');
      expect((await f.record()).baseline).toEqual(before.baseline);
      const indexBefore = await fs.readFile(path.join(f.repo, '.git', 'index'));
      expect((await f.manifest()).digest).toBe(manifest.digest);
      expect(await fs.readFile(path.join(f.repo, '.git', 'index'))).toEqual(indexBefore);
    },
  );

  test('a persisted dirty Git baseline still finds its staged before-text after restart', async () => {
    const f = await fixture('apps/project', true);
    const before = await f.record();
    expect(before.baseline?.git?.files?.[0].path).toBe('apps/project/.review.txt');
    await f.restart();
    await fs.writeFile(path.join(f.folder, '.review.txt'), 'after\n');
    const manifest = await f.manifest();
    expect(manifest.changes).toHaveLength(1);
    expect(manifest.changes[0].path).toBe('.review.txt');
    expect(manifest.changes[0].textEvidence.kind).toBe('diff');
    expect(manifest.changes[0].textEvidence.text).toContain('-staged before');
    expect(manifest.changes[0].textEvidence.text).toContain('+after');
    expect((await f.record()).baseline).toEqual(before.baseline);
  });

  test('a Git-only rename displays both names relative to the project', async () => {
    const f = await fixture();
    f.git('mv', '--', f.repoPath('.review.txt'), f.repoPath('.renamed.txt'));
    const manifest = await f.manifest();
    expect(manifest.changes).toHaveLength(1);
    expect(manifest.changes[0]).toMatchObject({
      id: 'git:apps/project/.renamed.txt', path: '.renamed.txt',
      kind: 'renamed', renamedFrom: '.review.txt', source: 'git',
    });
    expect(manifest.changes[0].textEvidence.text).toContain('committed before');
  });
});
