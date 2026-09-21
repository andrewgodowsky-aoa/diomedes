import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../server/app.js';
import {
  BANNED_SUMMARY_WORDS,
  bannedWordHits,
  canonicalJson,
  EMPTY_TEXT_EVIDENCE,
  manifestContent,
  MASKED_VALUE,
  type ChangeEntry,
  type ChangeEvidenceRef,
  type ChangeReviewLedgerEvent,
  type ChangeReviewManifest,
  type ReviewFlag,
} from '../shared/change-manifest.js';
import type { Change, HistoryEntry, ProjectState } from '../shared/types.js';
import { manifestDigest } from '../server/change-review/service.js';
import { compareStructured, structuredEntry } from '../server/change-review/structured.js';
import {
  BINARY_PROBE_BYTES,
  captureFolder,
  diffSnapshots,
  inspectFile,
  observedEntries,
  baselineFrom,
} from '../server/change-review/snapshot.js';
import { recordedEntries, outsideEntries } from '../server/change-review/recorded.js';
import { runRules } from '../server/change-review/rules.js';
import { renderSummary } from '../server/change-review/render.js';
import { runChecks } from '../server/change-review/checks.js';
import {
  diffGitSnapshots,
  effectiveGitMode,
  parseNumstat,
  parsePorcelainV2,
  prepareGit,
  snapshotGit,
  type GitWorktreeFile,
} from '../server/change-review/git.js';
import {
  TEXT_EVIDENCE_MAX_LINES,
  textEvidenceFor,
} from '../server/change-review/text-evidence.js';
import { BUSINESS_EXAMPLES, businessExample } from '../server/change-review/fixtures.js';

vi.mock('../server/integrations.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../server/integrations.js')>();
  return {
    ...actual,
    askCodex: async () => ({
      text: '{"summary":"A mocked proposal.","changes":[]}',
      model: 'gpt-6-astra',
      version: '0.153.4',
      threadId: 'mock-thread',
    }),
  };
});

beforeAll(async () => {
  await fs.mkdir(path.join(process.cwd(), 'test-results'), { recursive: true });
});

// --- helpers -----------------------------------------------------------------

const entry = (over: Partial<ChangeEntry>): ChangeEntry => ({
  id: 'x',
  path: 'a.md',
  kind: 'modified',
  attribution: 'recorded',
  source: 'recorded',
  beforeSha: 'sha256:aa',
  afterSha: 'sha256:bb',
  sizeBefore: 1,
  sizeAfter: 2,
  addedLines: null,
  removedLines: null,
  binary: false,
  modeBefore: null,
  modeAfter: null,
  renamedFrom: null,
  textEvidence: EMPTY_TEXT_EVIDENCE,
  changeIds: [],
  settled: null,
  historyEntryIds: [],
  fields: [],
  evidence: [{ kind: 'history-entry', entryId: 'h1', path: 'a.md' }],
  ...over,
});

const fileRecord = (over: Partial<import('../shared/types.js').FileRecord>) => ({
  path: 'a.md',
  op: 'modified' as const,
  before: null,
  after: 'sha256:x',
  recorded: true,
  reason: null,
  ...over,
});

const historyEntry = (over: Partial<HistoryEntry>): HistoryEntry => ({
  id: `h${Math.random().toString(36).slice(2)}`,
  time: '2026-09-15T00:00:00.000Z',
  actor: 'diomedes',
  kind: 'changed',
  sentence: 'Wrote a file',
  sessionId: 's1',
  taskId: 't1',
  sample: false,
  files: [],
  label: null,
  restoreOf: null,
  replaced: null,
  versionId: 'v1',
  commit: null,
  ...over,
});

const changeRecord = (over: Partial<Change>): Change => ({
  id: 'c1',
  entryId: 'h1',
  sessionId: 's1',
  taskId: 't1',
  path: 'a.md',
  op: 'modified',
  summary: 'Edited',
  before: 'old',
  after: 'new',
  current: 'new',
  changedSince: null,
  hunks: [],
  state: 'waiting',
  ...over,
});

const ruleInput = (changes: ChangeEntry[], over: Record<string, unknown> = {}) => ({
  changes,
  textFor: () => null,
  coverage: { skipped: [], blocked: [], unavailable: [] },
  uncertainEffects: [],
  checks: [],
  currentInputDigest: null,
  baselineEvidence: [] as ChangeEvidenceRef[],
  ...over,
});

// --- canonical serialization -------------------------------------------------

describe('canonical manifest identity', () => {
  test('canonicalJson sorts keys at every level and preserves arrays', () => {
    const a = canonicalJson({ b: 1, a: { d: 2, c: [3, 1] }, u: undefined });
    const b = canonicalJson({ u: undefined, a: { c: [3, 1], d: 2 }, b: 1 });
    expect(a).toBe(b);
    expect(a).toBe('{"a":{"c":[3,1],"d":2},"b":1}');
  });
  test('manifest digest is stable across generatedAt and id', () => {
    const base = {
      schemaVersion: 1 as const,
      subject: { kind: 'task-run' as const, projectId: 'p', taskId: 't', sessionId: 's', label: 'L' },
      outcome: 'completed' as const,
      baseline: null,
      baselineReason: 'none',
      changes: [entry({})],
      facts: [],
      flags: [],
      checks: [],
      summary: { whatChanged: [], attention: [], checks: [] },
      coverage: { inspected: 0, skipped: [], blocked: [], unavailable: [], limits: [] },
      generatedAt: '2026-09-15T00:00:00Z',
      rulesVersion: 'r1',
      rendererVersion: 'r1',
    };
    const d1 = manifestDigest(base);
    const d2 = manifestDigest({ ...base, generatedAt: '2030-01-01T00:00:00Z' });
    expect(d1).toBe(d2);
    expect(d1.startsWith('sha256:')).toBe(true);
    const d3 = manifestDigest({ ...base, outcome: 'failed' as const });
    expect(d3).not.toBe(d1);
    // manifestContent excludes bookkeeping fields by construction
    expect(
      JSON.stringify(manifestContent(base as unknown as ChangeReviewManifest)),
    ).not.toContain('generatedAt');
  });
});

// --- structured / business differ ---------------------------------------------

describe('structured change source', () => {
  const fields = [
    { path: 'schedule', label: 'Schedule', kind: 'value' as const },
    { path: 'recipients', label: 'Recipients', kind: 'list' as const, flagCodes: ['recipients-changed'] },
    { path: 'permissions', label: 'Who can see it', kind: 'set' as const, flagCodes: ['permission-set-changed'] },
    { path: 'apiKey', label: 'Service key', kind: 'value' as const, sensitive: true },
  ];
  test('scalar change, collection add/remove, unchanged and sensitive masking', () => {
    const changes = compareStructured(
      'r1',
      fields,
      { schedule: 'Mon 7:00', recipients: ['A', 'B'], permissions: ['Owner'], apiKey: 'k1' },
      { schedule: 'Mon 6:00', recipients: ['A', 'B', 'C'], permissions: ['Owner'], apiKey: 'k2' },
    );
    const by = new Map(changes.map((c) => [c.path, c]));
    expect(by.get('schedule')).toMatchObject({ kind: 'changed', before: 'Mon 7:00', after: 'Mon 6:00' });
    expect(by.get('recipients')).toMatchObject({ kind: 'collection', added: ['C'], removed: [] });
    expect(by.get('permissions')!.kind).toBe('unchanged');
    const key = by.get('apiKey')!;
    expect(key.sensitive).toBe(true);
    expect(key.before).toBe(MASKED_VALUE);
    expect(key.after).toBe(MASKED_VALUE);
    expect(JSON.stringify(changes)).not.toContain('k1');
    expect(JSON.stringify(changes)).not.toContain('k2');
  });
  test('added and removed fields report honestly', () => {
    const changes = compareStructured(
      'r1',
      fields,
      { recipients: ['A'] },
      { schedule: 'Mon 7:00', recipients: ['A'], permissions: [], apiKey: 'x' },
    );
    const by = new Map(changes.map((c) => [c.path, c]));
    expect(by.get('schedule')).toMatchObject({ kind: 'added', before: null });
    expect(by.get('permissions')).toMatchObject({ kind: 'added', before: null });
  });
  test('both business fixtures run through the same pipeline end to end', () => {
    for (const example of BUSINESS_EXAMPLES) {
      const e = structuredEntry(example.record, example.before, example.after);
      const { flags, facts } = runRules(ruleInput([e]));
      const summary = renderSummary(facts, flags, [], { outcome: 'completed', baseline: null });
      expect(e.source).toBe('structured');
      expect(summary.whatChanged.length).toBeGreaterThan(0);
      for (const line of summary.whatChanged) expect(bannedWordHits(line.text)).toEqual([]);
    }
    const restaurant = structuredEntry(
      businessExample('restaurant-weekly-report')!.record,
      businessExample('restaurant-weekly-report')!.before,
      businessExample('restaurant-weekly-report')!.after,
    );
    const r = runRules(ruleInput([restaurant]));
    expect(r.flags.map((f) => f.code)).toContain('recipient-list-changed');
    expect(r.flags.map((f) => f.code)).toContain('permission-set-changed');
    const rs = renderSummary(r.facts, r.flags, [], { outcome: 'completed', baseline: null });
    expect(rs.whatChanged.map((l) => l.text).join(' ')).toContain('Monday 7:00 AM → Monday 6:00 AM');
    expect(rs.whatChanged.map((l) => l.text).join(' ')).toContain('General Manager');

    const automation = structuredEntry(
      businessExample('automation-invoice-reminder')!.record,
      businessExample('automation-invoice-reminder')!.before,
      businessExample('automation-invoice-reminder')!.after,
    );
    const a = runRules(ruleInput([automation]));
    expect(a.flags.map((f) => f.code)).toContain('automation-toggled');
    const as = renderSummary(a.facts, a.flags, [], { outcome: 'completed', baseline: null });
    const all = as.whatChanged.map((l) => l.text).join(' ');
    expect(all).toContain('On → Off');
    // The sensitive key changed but its value never appears anywhere.
    const manifest = JSON.stringify({ facts: a.facts, flags: a.flags, summary: as, entry: automation });
    expect(manifest).not.toContain('nk-live');
    expect(all).toContain('Service key changed');
  });
});

// --- folder comparison ----------------------------------------------------------

describe('folder comparison', () => {
  const f = (p: string, sha: string, size = 1) => ({ path: p, sha, size, binary: false });
  test('added, modified, deleted, renamed and unchanged are exact', () => {
    const diff = diffSnapshots(
      [f('keep.md', 'sha256:1'), f('mod.md', 'sha256:2'), f('old.md', 'sha256:3'), f('gone.md', 'sha256:4')],
      [f('keep.md', 'sha256:1'), f('mod.md', 'sha256:9'), f('new.md', 'sha256:3'), f('extra.md', 'sha256:5')],
    );
    expect(diff.unchanged).toBe(1);
    expect(diff.modified.map((m) => m.path)).toEqual(['mod.md']);
    expect(diff.renames).toEqual([{ from: 'old.md', to: 'new.md', file: f('new.md', 'sha256:3') }]);
    expect(diff.added.map((a) => a.path)).toEqual(['extra.md']);
    expect(diff.deleted.map((d) => d.path)).toEqual(['gone.md']);
  });
  test('captureFolder hashes content, skips hidden entries, and lists coverage', async () => {
    const dir = await fs.mkdtemp(path.join(process.cwd(), 'test-results', 'cr-folder-'));
    await fs.writeFile(path.join(dir, 'a.txt'), 'alpha');
    await fs.writeFile(path.join(dir, '.hidden'), 'secret');
    await fs.mkdir(path.join(dir, 'node_modules'), { recursive: true });
    await fs.writeFile(path.join(dir, 'node_modules', 'dep.js'), 'x');
    const snap = await captureFolder(dir, '2026-09-15T00:00:00Z');
    expect(snap.files.map((x) => x.path)).toEqual(['a.txt']);
    expect(snap.skipped.map((s) => s.path).sort()).toEqual(['.hidden', 'node_modules']);
    const snap2 = await captureFolder(dir, '2026-09-15T00:00:01Z');
    expect(snap2.listingDigest).toBe(snap.listingDigest);
    await fs.writeFile(path.join(dir, 'a.txt'), 'changed');
    const snap3 = await captureFolder(dir, '2026-09-15T00:00:02Z');
    expect(snap3.listingDigest).not.toBe(snap.listingDigest);
    const diff = diffSnapshots(snap.files, snap3.files);
    expect(diff.modified).toHaveLength(1);
    const observed = observedEntries(diff, new Set(), []);
    expect(observed[0]).toMatchObject({ path: 'a.txt', kind: 'modified', attribution: 'observed' });
  });
});

// --- recorded writes -------------------------------------------------------------

describe('recorded writes source', () => {
  test('scopes to entries after the baseline and carries settle state', () => {
    const before = historyEntry({
      id: 'h0',
      sessionId: 'other',
      files: [fileRecord({ path: 'old.md' })],
    });
    const own = historyEntry({
      id: 'h1',
      files: [fileRecord({ before: 'sha256:1', after: 'sha256:2' })],
    });
    const entries = recordedEntries(
      [before, own],
      [changeRecord({ state: 'kept' })],
      { sessionId: 's1', taskId: 't1', historyStart: 1 },
    );
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      path: 'a.md',
      attribution: 'recorded',
      settled: 'kept',
      beforeSha: 'sha256:1',
      afterSha: 'sha256:2',
    });
    expect(entries[0].evidence.some((e) => e.kind === 'file-record')).toBe(true);
  });
  test('outside-change history becomes observed evidence', () => {
    const outside = historyEntry({
      id: 'h2',
      kind: 'outside',
      sessionId: null,
      files: [fileRecord({ path: 'other.md', op: 'created', after: 'sha256:9' })],
    });
    const entries = outsideEntries(
      [outside],
      { sessionId: 's1', taskId: 't1', historyStart: 0 },
      new Set(),
    );
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ path: 'other.md', kind: 'added', attribution: 'observed' });
  });
});

// --- rules -------------------------------------------------------------------------

describe('deterministic rules', () => {
  test('a dependency change raises the exact reason code; ordinary edits raise none', () => {
    const dep = entry({ path: 'package.json', id: 'd1' });
    const plain = entry({ path: 'src/util.ts', id: 'p1' });
    const { flags } = runRules(
      ruleInput([dep, plain], {
        textFor: (p: string, side: 'before' | 'after') =>
          p === 'package.json'
            ? side === 'before'
              ? '{"dependencies":{"a":"1.0.0"}}'
              : '{"dependencies":{"a":"1.0.0","b":"2.0.0"}}'
            : null,
      }),
    );
    const codes = flags.map((f) => f.code);
    expect(codes).toContain('dependency-added');
    expect(codes).not.toContain('dependency-removed');
    const depFlag = flags.find((f) => f.code === 'dependency-added')!;
    expect(depFlag.paths).toEqual(['package.json']);
    expect(depFlag.evidence.length).toBeGreaterThan(0);
    expect(depFlag.ruleId).toBe('cr-dependency-added');
    // No invented risk score anywhere in the output.
    expect(JSON.stringify(flags)).not.toMatch(/"score"|risk/i);
  });
  test('a deleted file flags with evidence; rules version is stamped', async () => {
    const gone = entry({ path: 'src/old.ts', kind: 'deleted', afterSha: null });
    const { flags, facts } = runRules(ruleInput([gone]));
    const flag = flags.find((f) => f.code === 'file-deleted')!;
    expect(flag.severity).toBe('attention');
    expect(flag.paths).toEqual(['src/old.ts']);
    expect(flag.evidence.length).toBeGreaterThan(0);
    expect(facts[0].code).toBe('files-changed');
    const summary = renderSummary(facts, flags, [], { outcome: 'completed', baseline: null });
    expect(summary.whatChanged[0].text).toContain('1 file changed');
  });
  test('observed changes raise the outside-changes flag', () => {
    const observed = entry({ path: 'x.ts', attribution: 'observed', source: 'folder' });
    const { flags } = runRules(ruleInput([observed]));
    expect(flags.map((f) => f.code)).toContain('outside-changes');
  });
});

// --- renderer ------------------------------------------------------------------------

describe('deterministic renderer', () => {
  test('banned wording throws — an overclaim cannot ship', () => {
    const flags: ReviewFlag[] = [
      {
        code: 'x',
        ruleId: 'cr-x',
        severity: 'attention',
        text: 'This change is safe to ship.',
        paths: [],
        evidence: [],
      },
    ];
    expect(() =>
      renderSummary([], flags, [], { outcome: 'completed', baseline: null }),
    ).toThrow(/banned wording/);
    for (const word of BANNED_SUMMARY_WORDS) expect(bannedWordHits(`this is ${word} text`)).toContain(word);
  });
  test('same facts produce identical sentences', () => {
    const { facts, flags } = runRules(ruleInput([entry({})]));
    const a = renderSummary(facts, flags, [], { outcome: 'completed', baseline: null });
    const b = renderSummary(facts, flags, [], { outcome: 'completed', baseline: null });
    expect(a).toEqual(b);
  });
  test('settle state renders from the changes-settled fact', () => {
    const kept = entry({ settled: 'kept' });
    const { facts, flags } = runRules(ruleInput([kept]));
    const summary = renderSummary(facts, flags, [], { outcome: 'completed', baseline: null });
    expect(summary.whatChanged.map((l) => l.text).join(' ')).toContain('1 kept change');
  });
});

// --- checks ------------------------------------------------------------------------------

describe('deterministic checks', () => {
  const mkInput = (changes: ChangeEntry[], over: Record<string, unknown> = {}) => ({
    changes,
    textFor: () => null,
    currentSha: async () => null,
    structuredRecords: [],
    ranAt: '2026-09-15T00:00:00Z',
    softwarePack: false,
    ...over,
  });
  test('diff-integrity passes, fails and skips honestly', async () => {
    const modified = entry({ path: 'a.md', afterSha: 'sha256:real' });
    const passing = await runChecks(
      mkInput([modified], { currentSha: async () => 'sha256:real' }),
    );
    expect(passing.find((c) => c.id === 'diff-integrity')!.state).toBe('passed');
    const failing = await runChecks(
      mkInput([modified], { currentSha: async () => 'sha256:other' }),
    );
    const failed = failing.find((c) => c.id === 'diff-integrity')!;
    expect(failed.state).toBe('failed');
    expect(failed.detail).toContain('a.md');
    const skipping = await runChecks(mkInput([modified]));
    expect(skipping.find((c) => c.id === 'diff-integrity')!.state).toBe('skipped');
  });
  test('conflict markers and credential-like text fail their scans', async () => {
    const dirty = entry({ path: 'a.md' });
    const checks = await runChecks(
      mkInput([dirty], {
        textFor: (p: string, side: 'before' | 'after') =>
          side === 'after' ? 'line\n<<<<<<< HEAD\nconflict\napi_key = "abcdef1234567890abcdef"\n' : null,
      }),
    );
    expect(checks.find((c) => c.id === 'conflict-scan')!.state).toBe('failed');
    expect(checks.find((c) => c.id === 'credential-scan')!.state).toBe('failed');
  });
  test('project commands are declared not-run, never silently executed', async () => {
    const checks = await runChecks(mkInput([entry({})], { softwarePack: true }));
    const planned = checks.filter((c) => ['typecheck', 'unit-tests', 'production-build'].includes(c.id));
    expect(planned).toHaveLength(3);
    for (const check of planned) {
      expect(check.state).toBe('not-run');
      expect(check.reason).toContain('Trust');
    }
  });
});

// --- git source -----------------------------------------------------------------------------

const gitAvailable = (() => {
  try {
    execFileSync('git', ['--version'], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
})();

describe('git source', () => {
  test.skipIf(!gitAvailable)('baseline isolation: pre-existing dirty state is not attributed', async () => {
    const dir = await fs.mkdtemp(path.join(process.cwd(), 'test-results', 'cr-git-'));
    const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
    git('init');
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'Test');
    await fs.writeFile(path.join(dir, 'tracked.txt'), 'v1');
    await fs.writeFile(path.join(dir, 'dirty.txt'), 'pre-existing');
    git('add', 'tracked.txt');
    git('commit', '-m', 'init');
    // dirty.txt is untracked — the user's pre-existing work.
    const env = await prepareGit(dir);
    expect(env).not.toBeNull();
    const before = await snapshotGit(env!);
    expect(before.captured).toBe(true);
    if (!before.captured) return;
    expect(before.files.map((f) => f.path)).toContain('dirty.txt');
    // The "task" now edits tracked.txt and adds a new file.
    await fs.writeFile(path.join(dir, 'tracked.txt'), 'v2');
    await fs.writeFile(path.join(dir, 'new.txt'), 'task output');
    const after = await snapshotGit(env!);
    expect(after.captured).toBe(true);
    if (!after.captured) return;
    const entries = diffGitSnapshots(before.files, after.files, []);
    const paths = entries.map((e) => e.path);
    expect(paths).toContain('tracked.txt');
    expect(paths).toContain('new.txt');
    // The honest part: dirty.txt was already dirty at baseline — not attributed.
    expect(paths).not.toContain('dirty.txt');
    for (const e of entries) expect(e.attribution).toBe('observed');
    // The real index is untouched: `git status` sees the same thing the user sees.
    const real = git('status', '--porcelain').toString();
    expect(real).toContain('dirty.txt');
    await env!.cleanup();
  });
  test('diffGitSnapshots treats identical state as unchanged', () => {
    const file: GitWorktreeFile = {
      path: 'a',
      x: '.',
      y: 'M',
      headMode: '100644',
      indexMode: '100644',
      worktreeMode: '100644',
      headSha: 'h',
      stagedSha: 's',
      blobSha: 'sha',
      renamedFrom: null,
      binary: false,
    };
    expect(diffGitSnapshots([file], [file], [])).toEqual([]);
    const changed = diffGitSnapshots([file], [{ ...file, blobSha: 'other' }], []);
    expect(changed).toHaveLength(1);
    const restaged = diffGitSnapshots([file], [{ ...file, stagedSha: 's2' }], []);
    expect(restaged).toHaveLength(1);
  });
});

// --- server integration ----------------------------------------------------------------------

describe('change-review service over HTTP', () => {
  let server: Server,
    app: Awaited<ReturnType<typeof createApp>>,
    temp: string,
    url: string;
  const headers = { 'Content-Type': 'application/json', 'X-Diomedes-Client': '1' };
  async function request(route: string, method = 'GET', body?: unknown) {
    const response = await fetch(`${url}/api${route}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, data: await response.json() };
  }
  const state = async (id: string): Promise<ProjectState> =>
    (await request(`/projects/${id}/state`)).data;
  const until = async (id: string, predicate: (s: ProjectState) => boolean) => {
    for (let attempt = 0; attempt < 200; attempt++) {
      const current = await state(id);
      if (predicate(current)) return current;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error('Timed out waiting for the expected state.');
  };
  const manifestFor = async (id: string, taskId: string): Promise<ChangeReviewManifest> => {
    const result = await request(`/projects/${id}/change-review/task/${taskId}`);
    expect(result.status).toBe(200);
    return result.data.manifest as ChangeReviewManifest;
  };

  beforeEach(async () => {
    await fs.mkdir(path.join(process.cwd(), 'test-results'), { recursive: true });
    temp = await fs.mkdtemp(path.join(process.cwd(), 'test-results', 'cr-app-'));
    app = await createApp({
      dataDir: path.join(temp, 'data'),
      projectRoot: path.join(temp, 'projects'),
      stepMs: 20,
    });
    server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', resolve));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterEach(async () => {
    await app.locals.close();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  });

  async function runSampleTask(): Promise<{ id: string; taskId: string; sessionId: string }> {
    const created = await request('/projects/sample', 'POST', {});
    const id = created.data.id as string;
    const task = (await request(`/projects/${id}/tasks`, 'POST', { name: 'Update the menu' })).data;
    const started = await request(`/projects/${id}/work/start`, 'POST', { taskId: task.id });
    const need = (await state(id)).needs.find((n) => n.state === 'open')!;
    await request(`/projects/${id}/needs/${need.id}/resolve`, 'POST', {
      resolution: 'go-ahead',
      allowForTask: true,
    });
    await until(id, (s) => s.sessions[0]?.state === 'done');
    return { id, taskId: task.id, sessionId: started.data.id };
  }

  test('a sample run produces a deterministic recorded-writes manifest', async () => {
    const { id, taskId, sessionId } = await runSampleTask();
    const manifest = await manifestFor(id, taskId);
    expect(manifest.subject).toMatchObject({ kind: 'task-run', taskId, sessionId });
    expect(manifest.outcome).toBe('completed');
    expect(manifest.baseline).not.toBeNull();
    expect(manifest.baseline!.files.length).toBeGreaterThan(0);
    // Every change is recorded — the sample route writes through Store.writeRecorded.
    expect(manifest.changes.length).toBeGreaterThan(0);
    expect(manifest.changes.every((c) => c.attribution === 'recorded')).toBe(true);
    expect(manifest.changes.every((c) => c.evidence.length > 0)).toBe(true);
    // Facts cite evidence; sentences cite facts; no banned wording anywhere.
    for (const fact of manifest.facts) expect(fact.evidence.length).toBeGreaterThan(0);
    const sentences = [
      ...manifest.summary.whatChanged,
      ...manifest.summary.attention,
      ...manifest.summary.checks,
    ];
    for (const line of sentences) expect(bannedWordHits(line.text)).toEqual([]);
    expect(manifest.rulesVersion).toBeTruthy();
    // Deterministic rebuild: same evidence → same digest.
    const again = await manifestFor(id, taskId);
    expect(again.digest).toBe(manifest.digest);
    // The persisted record survives a service restart.
    await app.locals.close();
    const fresh = await createApp({
      dataDir: path.join(temp, 'data'),
      projectRoot: path.join(temp, 'projects'),
      stepMs: 20,
    });
    expect(fresh.locals.changeReview).toBeTruthy();
  });

  test('a change outside Diomedes is observed, never recorded', async () => {
    const created = await request('/projects/sample', 'POST', {});
    const id = created.data.id as string;
    const task = (await request(`/projects/${id}/tasks`, 'POST', { name: 'Update the menu' })).data;
    const started = await request(`/projects/${id}/work/start`, 'POST', { taskId: task.id });
    // The review window is baseline-at-start → session end. An outside write
    // lands inside the window while the start need is still open.
    const current = await state(id);
    await fs.writeFile(path.join(current.project.folder, 'outside-note.txt'), 'written externally');
    const need = current.needs.find((n) => n.state === 'open')!;
    await request(`/projects/${id}/needs/${need.id}/resolve`, 'POST', {
      resolution: 'go-ahead',
      allowForTask: true,
    });
    await until(id, (s) => s.sessions[0]?.state === 'done');
    const manifest = await manifestFor(id, task.id);
    const outside = manifest.changes.find((c) => c.path === 'outside-note.txt');
    expect(outside).toBeDefined();
    expect(outside!.attribution).toBe('observed');
    expect(outside!.kind).toBe('added');
    expect(manifest.flags.map((f) => f.code)).toContain('outside-changes');
    // The recorded writes are untouched by the observation.
    expect(manifest.changes.some((c) => c.attribution === 'recorded')).toBe(true);
  });

  test('settle decisions rebuild the manifest with honest review state', async () => {
    const { id, taskId, sessionId } = await runSampleTask();
    const kept = await request(`/projects/${id}/review/all`, 'POST', {
      action: 'keep',
      sessionId,
    });
    expect(kept.status).toBe(200);
    const manifest = await manifestFor(id, taskId);
    expect(manifest.changes.every((c) => c.settled === 'kept')).toBe(true);
    const settledFact = manifest.facts.find((f) => f.code === 'changes-settled');
    expect(settledFact).toBeDefined();
    expect(settledFact!.params.kept).toBe(manifest.changes.length);
  });

  test('an undo marks the change undone without erasing evidence', async () => {
    const { id, taskId, sessionId } = await runSampleTask();
    const current = await state(id);
    const target = current.changes[0];
    const undone = await request(`/projects/${id}/review/${target.id}`, 'POST', {
      action: 'undo',
      sessionId,
    });
    expect(undone.status).toBe(200);
    const manifest = await manifestFor(id, taskId);
    const row = manifest.changes.find((c) => c.changeIds.includes(target.id));
    expect(row?.settled ?? manifest.changes.find((c) => c.settled === 'undone')?.settled).toBe(
      'undone',
    );
  });

  test('the two business examples are served through the same manifest contract', async () => {
    const created = await request('/projects/sample', 'POST', {});
    const id = created.data.id as string;
    for (const example of BUSINESS_EXAMPLES) {
      const result = await request(`/projects/${id}/change-review/examples/${example.id}`);
      expect(result.status).toBe(200);
      const manifest = result.data.manifest as ChangeReviewManifest;
      expect(manifest.subject.kind).toBe('example');
      expect(manifest.changes).toHaveLength(1);
      expect(manifest.changes[0].source).toBe('structured');
      expect(manifest.summary.whatChanged.length).toBeGreaterThan(0);
      expect(manifest.digest.startsWith('sha256:')).toBe(true);
    }
    const missing = await request(`/projects/${id}/change-review/examples/nope`);
    expect(missing.status).toBe(404);
  });

  test('a declined run is an honest no-change result, not an error', async () => {
    const created = await request('/projects/sample', 'POST', {});
    const id = created.data.id as string;
    const task = (await request(`/projects/${id}/tasks`, 'POST', { name: 'Hold the menu' })).data;
    await request(`/projects/${id}/work/start`, 'POST', { taskId: task.id });
    const need = (await state(id)).needs.find((n) => n.state === 'open')!;
    await request(`/projects/${id}/needs/${need.id}/resolve`, 'POST', { resolution: 'declined' });
    await until(id, (s) => s.sessions[0]?.state === 'stopped');
    const manifest = await manifestFor(id, task.id);
    expect(manifest.outcome).toBe('declined');
    expect(manifest.changes).toHaveLength(0);
    const text = manifest.summary.whatChanged.map((l) => l.text).join(' ');
    expect(text).toContain('declined');
    // The no-change claim still resolves to evidence (Blocker 7).
    for (const line of manifest.summary.whatChanged) {
      expect(line.evidence.length).toBeGreaterThan(0);
    }
  });

  test('a file dirty before baseline then edited mid-run shows only the delta', async () => {
    const created = await request('/projects/sample', 'POST', {});
    const id = created.data.id as string;
    const folder = (await state(id)).project.folder;
    // The user's pre-existing work: version 1 is on disk before the run starts.
    // A .txt is never the run's append target — it stays a purely observed path.
    await fs.writeFile(path.join(folder, 'draft.txt'), 'version one\n');
    const task = (await request(`/projects/${id}/tasks`, 'POST', { name: 'Keep drafting' })).data;
    await request(`/projects/${id}/work/start`, 'POST', { taskId: task.id });
    // Baseline is captured at start; the run edits the file further while the
    // need is open, so only the v1 → v2 delta belongs to this task's window.
    await fs.writeFile(path.join(folder, 'draft.txt'), 'version two\n');
    const need = (await state(id)).needs.find((n) => n.state === 'open')!;
    await request(`/projects/${id}/needs/${need.id}/resolve`, 'POST', {
      resolution: 'go-ahead',
      allowForTask: true,
    });
    await until(id, (s) => s.sessions.find((x) => x.taskId === task.id)?.state === 'done');
    const manifest = await manifestFor(id, task.id);
    const row = manifest.changes.find((c) => c.path === 'draft.txt');
    expect(row).toBeDefined();
    expect(row!.attribution).toBe('observed');
    // The technical evidence is the delta from the baseline bytes — never v0.
    expect(row!.textEvidence.kind).toBe('diff');
    expect(row!.textEvidence.text).toContain('-version one');
    expect(row!.textEvidence.text).toContain('+version two');
  });

  test('a history append rebuilds only sessions whose evidence can move', async () => {
    const created = await request('/projects/sample', 'POST', {});
    const id = created.data.id as string;
    const runTask = async (name: string) => {
      const task = (await request(`/projects/${id}/tasks`, 'POST', { name })).data;
      await request(`/projects/${id}/work/start`, 'POST', { taskId: task.id });
      const need = (await state(id)).needs.find((n) => n.state === 'open')!;
      await request(`/projects/${id}/needs/${need.id}/resolve`, 'POST', {
        resolution: 'go-ahead',
        allowForTask: true,
      });
      await until(id, (s) => s.sessions.find((x) => x.taskId === task.id)?.state === 'done');
      return task.id as string;
    };
    const taskA = await runTask('First pass');
    const manifestA = await manifestFor(id, taskA);
    const recordPath = path.join(
      temp,
      'data',
      'change-review',
      id,
      `${manifestA.subject.sessionId}.json`,
    );
    // Wait for the terminal build to persist before freezing the bytes.
    await expect
      .poll(async () => (await fs.stat(recordPath).catch(() => null)) !== null, { timeout: 10_000 })
      .toBe(true);
    const bytesBefore = await fs.readFile(recordPath);
    // A whole second session's worth of History lands. The terminal record
    // for session A is immutable evidence of its own window — never rebuilt.
    await runTask('Second pass');
    const bytesAfter = await fs.readFile(recordPath);
    expect(bytesAfter.equals(bytesBefore)).toBe(true);
  });

  /** One more run of an existing task, answering its Needs until it ends. */
  async function runAgain(id: string, taskId: string): Promise<string> {
    const started = await request(`/projects/${id}/work/start`, 'POST', { taskId });
    expect(started.status).toBe(200);
    const sessionId = started.data.id as string;
    for (let attempt = 0; attempt < 400; attempt++) {
      const current = await state(id);
      if (current.sessions.find((s) => s.id === sessionId)?.state === 'done') return sessionId;
      const need = current.needs.find((n) => n.state === 'open' && n.sessionId === sessionId);
      if (need)
        await request(`/projects/${id}/needs/${need.id}/resolve`, 'POST', {
          resolution: 'go-ahead',
          allowForTask: true,
        });
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error('Timed out waiting for the run to end.');
  }
  /**
   * An ended run's record, once its own end build has landed and its queue has
   * drained. A run's state is visible before the persist that announces it, so
   * waiting on the recorded outcome is what proves the end build ran; serving
   * the review then queues behind anything still building for that session.
   */
  const settledRecord = async (id: string, sessionId: string) => {
    const file = path.join(temp, 'data', 'change-review', id, `${sessionId}.json`);
    const outcome = async () => {
      try {
        return JSON.parse(await fs.readFile(file, 'utf8')).manifest?.outcome ?? null;
      } catch {
        return null; // Not written yet, or being replaced.
      }
    };
    await expect.poll(outcome, { timeout: 10_000 }).toBe('completed');
    expect((await request(`/projects/${id}/change-review/session/${sessionId}`)).status).toBe(200);
    return fs.readFile(file);
  };

  test('a later run of the same task leaves an ended run record byte-identical', async () => {
    const id = (await request('/projects/sample', 'POST', {})).data.id as string;
    const task = (await request(`/projects/${id}/tasks`, 'POST', { name: 'Update the menu' })).data;
    const first = await runAgain(id, task.id);
    const bytesBefore = await settledRecord(id, first);
    // The second run writes under the same task after the first one ended:
    // none of it happened in the first run's window.
    await runAgain(id, task.id);
    expect((await settledRecord(id, first)).equals(bytesBefore)).toBe(true);
  });

  test('keep and undo on an earlier run still reach the task review after every run ended', async () => {
    const id = (await request('/projects/sample', 'POST', {})).data.id as string;
    const task = (await request(`/projects/${id}/tasks`, 'POST', { name: 'Update the menu' })).data;
    const runs: string[] = [];
    for (let n = 0; n < 3; n++) runs.push(await runAgain(id, task.id));
    const firstChanges = (await state(id)).changes.filter((c) => c.sessionId === runs[0]);
    const notes = firstChanges.find((c) => c.op === 'created')!;
    const plan = firstChanges.find((c) => c.op === 'modified')!;
    const ledgerTail = async (sessionId: string) =>
      JSON.parse((await settledRecord(id, sessionId)).toString('utf8')).ledger.at(-1).event;
    const settledIn = async (changeId: string) => {
      // The task shows its newest run's review, which lists every write the task made.
      const manifest = await manifestFor(id, task.id);
      expect(manifest.subject.sessionId).toBe(runs[2]);
      return manifest.changes.find((c) => c.changeIds.includes(changeId))?.settled;
    };

    expect((await request(`/projects/${id}/review/${plan.id}`, 'POST', { action: 'keep' })).status).toBe(200);
    expect(await settledIn(plan.id)).toBe('kept');
    expect(await ledgerTail(runs[0])).toBe('rebuilt-kept');
    expect(await ledgerTail(runs[2])).toBe('rebuilt-kept');

    expect((await request(`/projects/${id}/review/${notes.id}`, 'POST', { action: 'undo' })).status).toBe(200);
    expect(await settledIn(notes.id)).toBe('undone');
    expect(await ledgerTail(runs[0])).toBe('rebuilt-undone');
    expect(await ledgerTail(runs[2])).toBe('rebuilt-undone');
  });

  test('runs under one task cost builds per run, never a rebuild of every earlier run', async () => {
    const review = app.locals.changeReview;
    const builds: string[] = [];
    const build = review.build.bind(review);
    review.build = (projectId: string, sessionId: string, event?: ChangeReviewLedgerEvent) => {
      builds.push(sessionId);
      return build(projectId, sessionId, event);
    };
    const id = (await request('/projects/sample', 'POST', {})).data.id as string;
    const task = (await request(`/projects/${id}/tasks`, 'POST', { name: 'Update the menu' })).data;
    const runs: { sessionId: string; buildsAtEnd: number }[] = [];
    for (let n = 0; n < 5; n++) {
      const sessionId = await runAgain(id, task.id);
      await settledRecord(id, sessionId);
      runs.push({ sessionId, buildsAtEnd: builds.length });
    }
    for (const { sessionId } of runs) await settledRecord(id, sessionId);
    // Once a run has ended and its review has settled, the later runs of its
    // task are outside its window: none of their writes rebuilds it.
    for (const [index, { sessionId, buildsAtEnd }] of runs.entries())
      expect(builds.slice(buildsAtEnd).filter((s) => s === sessionId), `run ${index}`).toEqual([]);
    // So a run costs the same whatever came before it. Rebuilding every earlier
    // run made each one cost five more builds than the last.
    const cost = runs.map((run, index) => run.buildsAtEnd - (runs[index - 1]?.buildsAtEnd ?? 0));
    expect(cost.at(-1)).toBeLessThanOrEqual(cost[0]);
  });
});

// --- binary detection (content, never filename) ---------------------------------

describe('binary classification', () => {
  test('a real binary file is detected by content; text stays non-binary', async () => {
    const dir = await fs.mkdtemp(path.join(process.cwd(), 'test-results', 'cr-bin-'));
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x11]);
    await fs.writeFile(path.join(dir, 'logo.png'), png);
    await fs.writeFile(path.join(dir, 'notes.txt'), 'plain text\n');
    const before = await captureFolder(dir, '2026-09-15T00:00:00Z');
    expect(before.files.find((f) => f.path === 'logo.png')!.binary).toBe(true);
    expect(before.files.find((f) => f.path === 'notes.txt')!.binary).toBe(false);
    // Modify the binary: the change is detected and classified.
    await fs.writeFile(
      path.join(dir, 'logo.png'),
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x22]),
    );
    const after = await captureFolder(dir, '2026-09-15T00:00:01Z');
    const observed = observedEntries(
      diffSnapshots(before.files, after.files),
      new Set(),
      [],
    );
    const changed = observed.find((e) => e.path === 'logo.png')!;
    expect(changed.binary).toBe(true);
    // The rule is reachable — no longer dead code.
    const { flags } = runRules(ruleInput(observed));
    expect(flags.map((f) => f.code)).toContain('binary-changed');
    // Binary bytes are never rendered as text evidence.
    const evidence = textEvidenceFor({ binary: true, deleted: false, before: 'x', after: 'y' });
    expect(evidence.kind).toBe('none');
    expect(evidence.reason).toBe('binary');
    expect(evidence.text).toBeNull();
  });

  test('a NUL byte inside the probe window classifies; plain text does not', async () => {
    const dir = await fs.mkdtemp(path.join(process.cwd(), 'test-results', 'cr-bin2-'));
    const wide = Buffer.alloc(BINARY_PROBE_BYTES + 500, 0x61);
    wide[BINARY_PROBE_BYTES - 1] = 0x00; // inside the 8 KB probe window
    await fs.writeFile(path.join(dir, 'inside.bin'), wide);
    const inspected = await inspectFile(path.join(dir, 'inside.bin'));
    expect(inspected.binary).toBe(true);
  });

  test('hashing a large file streams — correct sha without one giant buffer', async () => {
    const dir = await fs.mkdtemp(path.join(process.cwd(), 'test-results', 'cr-big-'));
    const big = Buffer.alloc(3 * 1024 * 1024, 0x61); // 3 MB
    const target = path.join(dir, 'big.txt');
    await fs.writeFile(target, big);
    const inspected = await inspectFile(target);
    expect(inspected.sha).toBe(`sha256:${createHash('sha256').update(big).digest('hex')}`);
    expect(inspected.size).toBe(big.length);
  });
});

// --- bounded text evidence --------------------------------------------------------

describe('bounded text evidence', () => {
  test('a text modification produces a real +/− diff', () => {
    const evidence = textEvidenceFor({
      binary: false,
      deleted: false,
      before: 'alpha\nbeta\ngamma\n',
      after: 'alpha\nBETA\ngamma\n',
    });
    expect(evidence.kind).toBe('diff');
    expect(evidence.text).toContain('-beta');
    expect(evidence.text).toContain('+BETA');
    expect(evidence.truncated).toBe(false);
  });

  test('additions and deletions are visible; a deleted file excerpts its before-side', () => {
    const added = textEvidenceFor({ binary: false, deleted: false, before: null, after: 'new\n' });
    expect(added.kind).toBe('excerpt');
    expect(added.text).toContain('new');
    const gone = textEvidenceFor({ binary: false, deleted: true, before: 'old\n', after: null });
    expect(gone.kind).toBe('excerpt');
    expect(gone.text).toContain('old');
    const missing = textEvidenceFor({ binary: false, deleted: false, before: null, after: null });
    expect(missing.kind).toBe('none');
  });

  test('large text is cut at the bound and says so with a count', () => {
    const before = Array.from({ length: 400 }, (_, i) => `old line ${i}`).join('\n');
    const after = Array.from({ length: 400 }, (_, i) => `new line ${i}`).join('\n');
    const evidence = textEvidenceFor({ binary: false, deleted: false, before, after });
    expect(evidence.kind).toBe('diff');
    expect(evidence.truncated).toBe(true);
    expect(evidence.truncatedLines).toBeGreaterThan(0);
    const kept = evidence.text!.split('\n').filter((l) => l.startsWith('+') || l.startsWith('-'));
    expect(kept.length).toBeLessThanOrEqual(TEXT_EVIDENCE_MAX_LINES);
  });

  test('oversized sides are refused, not diffed byte-by-byte', () => {
    const huge = 'x'.repeat(600 * 1024);
    const evidence = textEvidenceFor({ binary: false, deleted: false, before: huge, after: 'y' });
    expect(evidence.kind).toBe('none');
    expect(evidence.reason).toBe('unreadable');
  });
});

// --- git modes, binary and unusual names ------------------------------------------

describe('git source — modes, binary, names', () => {
  const makeRepo = async () => {
    const dir = await fs.mkdtemp(path.join(process.cwd(), 'test-results', 'cr-git2-'));
    const run = (...args: string[]) =>
      execFileSync('git', args, { cwd: dir, stdio: 'pipe' }).toString();
    run('init');
    run('config', 'user.email', 'test@example.com');
    run('config', 'user.name', 'Test');
    run('config', 'core.autocrlf', 'false');
    return { dir, run };
  };

  test.skipIf(!gitAvailable)(
    'executable-bit transitions come from Git modes, not filename guesses',
    async () => {
      const { dir, run } = await makeRepo();
      await fs.writeFile(path.join(dir, 'run.sh'), '#!/bin/sh\necho hi\n');
      await fs.writeFile(path.join(dir, 'plain.txt'), 'x');
      run('add', '.');
      run('commit', '-m', 'init');
      const env = (await prepareGit(dir))!;
      const base = await snapshotGit(env);
      expect(base.captured).toBe(true);
      if (!base.captured) return;
      // Clean tracked files are absent from porcelain — the baseline holds no row.
      expect(base.files.find((f) => f.path === 'run.sh')).toBeUndefined();
      // Stage a mode transition in the real index — NTFS-independent.
      run('update-index', '--chmod=+x', 'run.sh');
      const after = await snapshotGit(env);
      if (!after.captured) return;
      const entries = diffGitSnapshots(base.files, after.files, []);
      const sh = entries.find((e) => e.path === 'run.sh')!;
      expect(sh).toBeDefined();
      expect(sh.modeBefore).toBe('100644');
      expect(sh.modeAfter).toBe('100755');
      expect(
        sh.evidence.some((e) => e.kind === 'git-record' && e.record.startsWith('mode:')),
      ).toBe(true);
      const { flags, facts } = runRules(ruleInput(entries));
      const setFlag = flags.find((f) => f.code === 'executable-bit-set')!;
      expect(setFlag.severity).toBe('attention');
      expect(setFlag.text).toContain('100644 → 100755');
      expect(facts.some((f) => f.code === 'file-mode-changed')).toBe(true);
      const summary = renderSummary(facts, flags, [], { outcome: 'completed', baseline: null });
      expect(summary.whatChanged.map((l) => l.text).join(' ')).toContain(
        'run.sh became executable.',
      );
      // The mode evidence survives into the manifest-shaped summary sentence.
      const modeLine = summary.whatChanged.find((l) => l.text.includes('became executable'))!;
      expect(modeLine.evidence.length).toBeGreaterThan(0);
      // The extension never implied anything: plain.txt produces no entry.
      expect(entries.find((e) => e.path === 'plain.txt')).toBeUndefined();
      // Executable → regular: the bit clears back to the HEAD mode.
      run('update-index', '--chmod=-x', 'run.sh');
      const cleared = await snapshotGit(env);
      if (!cleared.captured) return;
      const back = diffGitSnapshots(after.files, cleared.files, []);
      const sh2 = back.find((e) => e.path === 'run.sh')!;
      expect(sh2.modeBefore).toBe('100755');
      const r2 = runRules(ruleInput(back));
      const clearedFlag = r2.flags.find((f) => f.code === 'executable-bit-cleared')!;
      expect(clearedFlag.severity).toBe('info');
      // The real index was touched only by the test's own update-index calls —
      // the private inspection index never wrote to it.
      expect(run('diff', '--cached', '--numstat').trim()).toBe('');
      await env.cleanup();
    },
  );

  test.skipIf(!gitAvailable)('git numstat marks a real binary change', async () => {
    const { dir, run } = await makeRepo();
    const bin = Buffer.from([0x00, 0x01, 0x02, 0x00, 0xff, 0x00, 0xfe]);
    await fs.writeFile(path.join(dir, 'data.bin'), bin);
    await fs.writeFile(path.join(dir, 'text.txt'), 'hello\n');
    run('add', '.');
    run('commit', '-m', 'init');
    const env = (await prepareGit(dir))!;
    const base = await snapshotGit(env);
    if (!base.captured) return;
    await fs.writeFile(path.join(dir, 'data.bin'), Buffer.concat([bin, Buffer.from([0x00, 0x03])]));
    await fs.writeFile(path.join(dir, 'text.txt'), 'hello again\n');
    const after = await snapshotGit(env);
    if (!after.captured) return;
    const entries = diffGitSnapshots(base.files, after.files, []);
    const binEntry = entries.find((e) => e.path === 'data.bin')!;
    const txtEntry = entries.find((e) => e.path === 'text.txt')!;
    expect(binEntry.binary).toBe(true);
    expect(txtEntry.binary).toBe(false);
    const { flags } = runRules(ruleInput(entries));
    expect(flags.map((f) => f.code)).toContain('binary-changed');
    await env.cleanup();
  });

  test.skipIf(!gitAvailable)(
    'a pre-dirty file edited further reports only the post-baseline delta',
    async () => {
      const { dir, run } = await makeRepo();
      await fs.writeFile(path.join(dir, 'dirty.txt'), 'v0\n');
      run('add', '.');
      run('commit', '-m', 'init');
      // Pre-existing dirty work — version 1 on disk before the baseline.
      await fs.writeFile(path.join(dir, 'dirty.txt'), 'v1\n');
      const v1sha = run('hash-object', '--no-filters', 'dirty.txt').trim();
      const headSha = run('rev-parse', 'HEAD:dirty.txt').trim();
      const env = (await prepareGit(dir))!;
      const base = await snapshotGit(env);
      if (!base.captured) return;
      // The run edits the same file further.
      await fs.writeFile(path.join(dir, 'dirty.txt'), 'v2\n');
      const v2sha = run('hash-object', '--no-filters', 'dirty.txt').trim();
      const after = await snapshotGit(env);
      if (!after.captured) return;
      const entries = diffGitSnapshots(base.files, after.files, []);
      const entry = entries.find((e) => e.path === 'dirty.txt')!;
      expect(entry).toBeDefined();
      // The delta is measured from the baseline bytes (v1), never HEAD (v0)
      // and never the final state alone.
      expect(entry.beforeSha).toBe(v1sha);
      expect(entry.afterSha).toBe(v2sha);
      expect(entry.beforeSha).not.toBe(headSha);
      await env.cleanup();
    },
  );

  test.skipIf(!gitAvailable)('same-stat edits stay visible when the real index is racy', async () => {
    const { dir, run } = await makeRepo();
    const file = path.join(dir, 'racy.txt');
    const stamp = new Date(Math.floor(Date.now() / 1000 - 5) * 1000);
    run('config', 'core.trustctime', 'false');
    run('config', 'core.checkStat', 'minimal');
    await fs.writeFile(file, 'v0\n');
    await fs.utimes(file, stamp, stamp);
    run('add', '.');
    run('commit', '-m', 'init');
    await fs.utimes(path.join(dir, '.git', 'index'), stamp, stamp);
    const env = (await prepareGit(dir))!;
    try {
      const before = await snapshotGit(env);
      expect(before.captured).toBe(true);
      if (!before.captured) throw new Error(before.reason);
      expect(before.files).toEqual([]);
      // Same size and recorded mtime, with ctime explicitly unavailable. Git
      // must use its racy-index content check, not trust the copied index date.
      await fs.writeFile(file, 'v1\n');
      await fs.utimes(file, stamp, stamp);
      const expected = run('hash-object', '--no-filters', 'racy.txt').trim();
      const after = await snapshotGit(env);
      expect(after.captured).toBe(true);
      if (!after.captured) throw new Error(after.reason);
      expect(after.files.find((row) => row.path === 'racy.txt')?.blobSha).toBe(expected);
      expect(diffGitSnapshots(before.files, after.files, [])[0]?.afterSha).toBe(expected);
    } finally {
      await env.cleanup();
    }
  });

  test.skipIf(!gitAvailable)('unusual filenames survive the real NUL parser', async () => {
    const { dir, run } = await makeRepo();
    run('commit', '--allow-empty', '-m', 'init'); // prepareGit needs a HEAD
    const names = [
      'with space.txt',
      'café ünïcode.txt',
      "it's (test) [1].md",
      'semi;colon&ampersand.md',
    ];
    for (const name of names) await fs.writeFile(path.join(dir, name), 'x\n');
    const env = (await prepareGit(dir))!;
    const snap = await snapshotGit(env);
    if (!snap.captured) return;
    for (const name of names)
      expect(
        snap.files.find((f) => f.path === name),
        `expected ${name} in ${snap.files.map((f) => f.path).join(', ')}`,
      ).toBeDefined();
    await env.cleanup();
  });

  test('the NUL-delimited parser handles spaces, unicode and renames synthetically', () => {
    const raw =
      '1 .M N... 100644 100644 100644 aaaa1111 bbbb2222 dir/with space.md\0' +
      '? café-中.md\0' +
      '2 R100 N... 100644 100644 100644 cccc3333 dddd4444 R100 new name.md\0old name.md\0';
    const rows = parsePorcelainV2(raw);
    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatchObject({
      path: 'dir/with space.md',
      headMode: '100644',
      indexMode: '100644',
      worktreeMode: '100644',
      stagedSha: 'bbbb2222',
    });
    expect(rows[1]).toMatchObject({ path: 'café-中.md', y: '?' });
    expect(rows[2]).toMatchObject({ path: 'new name.md', renamedFrom: 'old name.md' });
    const bins = parseNumstat('-\t-\timage.png\x0003\t001\tcode.ts\x00');
    expect(bins.has('image.png')).toBe(true);
    expect(bins.has('code.ts')).toBe(false);
  });
});

// --- check states -----------------------------------------------------------------

describe('check state coverage', () => {
  const mkInput = (changes: ChangeEntry[], over: Record<string, unknown> = {}) => ({
    changes,
    textFor: () => null,
    currentSha: async () => null,
    structuredRecords: [],
    ranAt: '2026-09-15T00:00:00Z',
    softwarePack: false,
    ...over,
  });
  test('a throwing comparison is error, never conflated with failed', async () => {
    const modified = entry({ path: 'a.md', afterSha: 'sha256:x' });
    const checks = await runChecks(
      mkInput([modified], {
        currentSha: async () => {
          throw new Error('disk vanished');
        },
      }),
    );
    const check = checks.find((c) => c.id === 'diff-integrity')!;
    expect(check.state).toBe('error');
    expect(check.reason).toContain('disk vanished');
    // The five states are distinct values, not synonyms.
    expect(new Set(['passed', 'failed', 'not-run', 'skipped', 'error'])).toContain(check.state);
  });
  test('recorded bare-hex hashes compare equal to computed sha256: digests', async () => {
    const modified = entry({ path: 'a.md', afterSha: 'abc123' });
    const checks = await runChecks(
      mkInput([modified], { currentSha: async () => 'sha256:abc123' }),
    );
    expect(checks.find((c) => c.id === 'diff-integrity')!.state).toBe('passed');
  });
});

// --- severity policy ---------------------------------------------------------------

describe('structured severity policy', () => {
  const manifestOf = (exampleId: string) => {
    const example = businessExample(exampleId)!;
    const e = structuredEntry(example.record, example.before, example.after);
    return { entry: e, ...runRules(ruleInput([e])) };
  };
  test('ordinary business changes land at info; consequential ones at attention', () => {
    const restaurant = manifestOf('restaurant-weekly-report');
    const byCode = new Map(restaurant.flags.map((f) => [f.code, f]));
    // The schedule change is ordinary state — info, not alarm.
    expect(byCode.get('field-changed')!.severity).toBe('info');
    // Recipients and access are consequential — attention, with the reason.
    expect(byCode.get('recipient-list-changed')!.severity).toBe('attention');
    expect(byCode.get('recipient-list-changed')!.text).toContain('General Manager was added');
    expect(byCode.get('connector-changed')!.severity).toBe('attention');
    const perm = byCode.get('permission-set-changed')!;
    expect(perm.severity).toBe('attention');
    expect(perm.text).toContain('expanded');
    expect(perm.text).toContain('Assistant Manager');
    // Every attention flag resolves to typed evidence.
    for (const flag of restaurant.flags.filter((f) => f.severity === 'attention'))
      expect(flag.evidence.length).toBeGreaterThan(0);
  });
  test('invoice: threshold is info, toggle/credential/permissions are attention', () => {
    const invoice = manifestOf('automation-invoice-reminder');
    const byCode = new Map(invoice.flags.map((f) => [f.code, f]));
    const toggled = byCode.get('automation-toggled')!;
    expect(toggled.severity).toBe('attention');
    expect(toggled.text).toContain('turned off');
    const credential = byCode.get('credential-changed')!;
    expect(credential.severity).toBe('attention');
    expect(credential.text).toContain('never shown');
    const perm = byCode.get('permission-set-changed')!;
    expect(perm.text).toContain('expanded');
    expect(perm.text).toContain('Office Manager');
    // The threshold change alone is info — it does not inherit attention.
    const fieldFlags = invoice.flags.filter((f) => f.code === 'field-changed');
    expect(fieldFlags.every((f) => f.severity === 'info')).toBe(true);
    // And no attention flag exists for the threshold field specifically.
    const thresholdAttention = invoice.flags.filter(
      (f) => f.severity === 'attention' && f.paths.includes('threshold'),
    );
    expect(thresholdAttention).toHaveLength(0);
  });
  test('permission contraction is stated apart from expansion', () => {
    const example = businessExample('restaurant-weekly-report')!;
    const shrunk = structuredEntry(example.record, example.before, {
      ...example.after,
      permissions: ['Owner'],
    });
    const { flags } = runRules(ruleInput([shrunk]));
    const perm = flags.find((f) => f.code === 'permission-set-changed')!;
    expect(perm.text).toContain('narrowed');
    expect(perm.text).not.toContain('expanded');
  });
});

// --- structured bounds ---------------------------------------------------------------

describe('structured bounds and collection removal', () => {
  const list64 = (label: string) => ({
    path: 'members',
    label,
    kind: 'list' as const,
  });
  test('collection member removal is detected and named', () => {
    const changes = compareStructured(
      'r1',
      [list64('Members')],
      { members: ['A', 'B', 'C'] },
      { members: ['A'] },
    );
    const field = changes[0];
    expect(field.kind).toBe('collection');
    expect(field.removed).toEqual(['B', 'C']);
    expect(field.removedTotal).toBe(2);
    const { facts } = runRules(
      ruleInput([structuredEntry(
        {
          id: 'rec',
          label: 'A record',
          fields: [list64('Members')],
          values: {},
        },
        { members: ['A', 'B', 'C'] },
        { members: ['A'] },
      )]),
    );
    const fact = facts.find((f) => f.params.label === 'Members')!;
    expect(fact.params.removed).toContain('B');
  });
  test('large collections are bounded with true totals preserved', () => {
    const many = Array.from({ length: 200 }, (_, i) => `member-${i}`);
    const changes = compareStructured('r1', [list64('Members')], { members: [] }, { members: many });
    const field = changes[0];
    expect(field.added.length).toBeLessThan(200);
    expect(field.addedTotal).toBe(200);
    expect(field.valueTruncated).toBe(true);
  });
  test('long scalar values are cut with a marker', () => {
    const changes = compareStructured(
      'r1',
      [{ path: 'notes', label: 'Notes', kind: 'value' as const }],
      { notes: 'short' },
      { notes: 'x'.repeat(1000) },
    );
    expect(changes[0].valueTruncated).toBe(true);
    expect(changes[0].after!.length).toBeLessThan(1000);
  });
});

// --- dependency wording ------------------------------------------------------------

describe('dependency wording', () => {
  const pkg = (deps: Record<string, string>) =>
    JSON.stringify({ dependencies: deps });
  const depEntry = entry({ path: 'package.json', id: 'dep' });
  const inputFor = (before: string | null, after: string | null) =>
    ruleInput([depEntry], {
      textFor: (_p: string, side: 'before' | 'after') => (side === 'before' ? before : after),
    });
  test('a removed dependency is dependency-removed, not dependency-changed', () => {
    const { flags } = runRules(
      inputFor(pkg({ a: '1.0.0', b: '2.0.0' }), pkg({ a: '1.0.0' })),
    );
    const flag = flags.find((f) => f.code.startsWith('dependency'))!;
    expect(flag.code).toBe('dependency-removed');
    expect(flag.text).toContain('removed');
    expect(flag.text).toContain('b');
  });
  test('added and version-changed stay distinct', () => {
    const added = runRules(inputFor(pkg({ a: '1.0.0' }), pkg({ a: '1.0.0', b: '2.0.0' })));
    expect(added.flags.find((f) => f.code.startsWith('dependency'))!.code).toBe('dependency-added');
    const changed = runRules(inputFor(pkg({ a: '1.0.0' }), pkg({ a: '2.0.0' })));
    expect(changed.flags.find((f) => f.code.startsWith('dependency'))!.code).toBe(
      'dependency-changed',
    );
    const deleted = runRules(
      ruleInput([entry({ path: 'package.json', kind: 'deleted', afterSha: null })], {
        textFor: () => null,
      }),
    );
    expect(deleted.flags.find((f) => f.code.startsWith('dependency'))!.code).toBe(
      'dependency-removed',
    );
  });
});

// --- the evidence invariant ----------------------------------------------------------

describe('every summary sentence resolves to typed evidence', () => {
  const allSentences = (m: {
    summary: { whatChanged: { evidence: unknown; factIds: string[]; flagCodes: string[] }[] };
    flags: { code: string }[];
    facts: { id: string }[];
    checks: { id: string }[];
    baseline: unknown;
  }) => m.summary.whatChanged;

  test('fact, attention, check and baseline sentences all carry resolvable refs', () => {
    const manifests: {
      facts: readonly any[];
      flags: readonly any[];
      checks: readonly any[];
      baseline: any;
      summary: any;
    }[] = [];
    // File-change manifest.
    const e = entry({ path: 'a.md' });
    const fileRules = runRules(ruleInput([e]));
    manifests.push({
      facts: fileRules.facts,
      flags: fileRules.flags,
      checks: [],
      baseline: { listingDigest: 'sha256:x' },
      summary: renderSummary(fileRules.facts, fileRules.flags, [], {
        outcome: 'completed',
        baseline: { listingDigest: 'sha256:x' } as any,
      }),
    });
    // No-baseline manifest.
    manifests.push({
      facts: fileRules.facts,
      flags: fileRules.flags,
      checks: [],
      baseline: null,
      summary: renderSummary(fileRules.facts, fileRules.flags, [], {
        outcome: 'completed',
        baseline: null,
      }),
    });
    // Both business fixtures.
    for (const example of BUSINESS_EXAMPLES) {
      const s = structuredEntry(example.record, example.before, example.after);
      const r = runRules(ruleInput([s]));
      manifests.push({
        facts: r.facts,
        flags: r.flags,
        checks: [],
        baseline: null,
        summary: renderSummary(r.facts, r.flags, [], { outcome: 'completed', baseline: null }),
      });
    }
    for (const manifest of manifests) {
      const factIds = new Set(manifest.facts.map((f) => f.id));
      const flagCodes = new Set(manifest.flags.map((f) => f.code));
      const sentences = [
        ...manifest.summary.whatChanged,
        ...manifest.summary.attention,
        ...manifest.summary.checks,
      ];
      expect(sentences.length).toBeGreaterThan(0);
      for (const line of sentences) {
        // Non-empty evidence is enforced by the renderer; here we prove it resolves.
        expect(line.evidence.length).toBeGreaterThan(0);
        for (const ref of line.evidence) {
          expect(
            [
              'history-entry',
              'file-record',
              'folder-listing',
              'object',
              'check',
              'rule',
              'manifest',
              'baseline',
              'git-record',
              'structured',
            ],
          ).toContain(ref.kind);
          if (ref.kind === 'check')
            expect(manifest.checks.some((c: any) => c.id === ref.checkId)).toBe(true);
          if (ref.kind === 'rule') expect(ref.ruleId).toMatch(/^cr-/);
          if (ref.kind === 'baseline' && manifest.baseline)
            expect(ref.listingDigest).toBe(manifest.baseline.listingDigest);
        }
        for (const id of line.factIds) expect(factIds.has(id)).toBe(true);
        for (const code of line.flagCodes) expect(flagCodes.has(code)).toBe(true);
      }
    }
  });
});

// --- no model required ---------------------------------------------------------------

describe('model independence', () => {
  test('the review pipeline imports nothing that can call a model', async () => {
    const dir = path.join(process.cwd(), 'server', 'change-review');
    const files = (await fs.readdir(dir)).filter((f) => f.endsWith('.ts'));
    const allowed = new Set([
      '../engines/process.js', // spawns git only — never a model
      '../paths.js', // the trust path funnel
      '../store.js', // History / change records
    ]);
    for (const file of files) {
      const source = await fs.readFile(path.join(dir, file), 'utf8');
      for (const match of source.matchAll(/\bimport\b[^;'"]*?from\s+['"]([^'"]+)['"]/g)) {
        const spec = match[1];
        if (spec.startsWith('node:') || spec === 'diff') continue;
        if (spec.startsWith('./') || spec.startsWith('../../shared/')) continue;
        expect(allowed.has(spec), `${file} imports ${spec}`).toBe(true);
      }
      // Belt and braces: no model adapter names anywhere in the pipeline.
      expect(source).not.toMatch(/askCodex|openai|anthropic|inference/i);
    }
    expect(files.length).toBeGreaterThan(5);
  });
});
