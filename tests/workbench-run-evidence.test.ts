import { afterEach, describe, expect, it, vi } from 'vitest';
import type { HistoryEntry } from '../shared/types';
import { loadHarnessEvidence, sessionEvidence } from '../client/workbench/run-evidence';
import { harnessFixture, historyFixture, needFixture, sessionFixture } from './workbench-fixtures';

/** Exactly what server/store.ts addEntry writes for store.snapshot(projectId, null, session.id):
 * sessionId is set, taskId falls back to null, kind is 'saved-version'. */
function storeSnapshot(patch: Partial<HistoryEntry>): HistoryEntry {
  return { id: 'history', time: '2026-09-10T10:00:00Z', actor: 'diomedes',
    kind: 'saved-version', sentence: 'Diomedes saved a version (whole folder)',
    sessionId: 'session', taskId: null, sample: false, files: [],
    label: null, restoreOf: null, replaced: null, versionId: 'v0001', commit: null, ...patch };
}

afterEach(() => vi.unstubAllGlobals());

describe('saved run evidence', () => {
  it('keeps exact source revisions and ignores unrelated task/session records', () => {
    const approval = { protocolVersion: 1 as const, proposalDigest: 'p', actionDigest: 'a', baseDigest: 'b',
      expiresAt: '', sources: [{ path: 'draft.md', sha: 'v1' }] };
    const file = { path: 'draft.md', op: 'modified' as const, before: 'v1', after: 'v1', recorded: true, reason: null };
    const shown = sessionEvidence(sessionFixture(), [needFixture({ approval }),
      needFixture({ id: 'other', taskId: 'other', approval: { ...approval, sources: [{ path: 'secret.md', sha: 'hidden' }] } })],
    [historyFixture({ files: [file, { ...file, before: 'v2', after: 'v2' }] }),
      historyFixture({ id: 'other', sessionId: 'other', files: [{ ...file, path: 'private.md' }] }),
      historyFixture({ id: 'write', kind: 'work', files: [{ ...file, before: 'v3', after: 'v3' }] })]);
    expect(shown.sources).toEqual([
      { path: 'draft.md', sha: 'v1', basis: 'Proposal source' },
      { path: 'draft.md', sha: 'v2', basis: 'Saved source' },
    ]);
    expect(shown.needs).toHaveLength(1);
  });
  it('binds session-scoped saved sources by sessionId when the entry taskId is null', () => {
    const file = { path: 'draft.md', op: 'modified' as const, before: 'v1', after: 'v1', recorded: true, reason: null };
    const here = storeSnapshot({ files: [file] });
    const otherTask = storeSnapshot({ id: 'other-task', taskId: 'other', files: [file] });
    const otherSession = storeSnapshot({ id: 'other-session', sessionId: 'other', files: [{ ...file, path: 'private.md' }] });
    const shown = sessionEvidence(sessionFixture(), [], [here, otherTask, otherSession]);
    expect(shown.history.map((entry) => entry.id)).toEqual(['history']);
    expect(shown.sources).toEqual([{ path: 'draft.md', sha: 'v1', basis: 'Saved source' }]);
  });
  it('does not turn unavailable snapshots into an empty-context guarantee', () => {
    expect(sessionEvidence(sessionFixture(), [], []).sources).toEqual([]);
  });
  it('loads only the matching session through project-scoped, encoded GET routes', async () => {
    const run = harnessFixture({ projectId: 'project / one', id: 'run / one' });
    const fetcher = vi.fn().mockResolvedValueOnce(Response.json({ runs: [
      { id: 'other', sessionId: 'other', taskId: 'task' }, run,
    ] })).mockResolvedValueOnce(Response.json(run));
    vi.stubGlobal('fetch', fetcher);
    const controller = new AbortController();
    expect(await loadHarnessEvidence(run.projectId, sessionFixture(), controller.signal)).toEqual(run);
    expect(fetcher.mock.calls.map(([path]) => path)).toEqual([
      '/api/projects/project%20%2F%20one/harness/runs',
      '/api/projects/project%20%2F%20one/harness/runs/run%20%2F%20one',
    ]);
    expect(fetcher.mock.calls.every(([, init]) => init.method === 'GET' && init.signal === controller.signal)).toBe(true);
  });
  it('returns unavailable when there is no run rather than fetching another task', async () => {
    const fetcher = vi.fn().mockResolvedValue(Response.json({ runs: [{ id: 'other', taskId: 'other', sessionId: 'other' }] }));
    vi.stubGlobal('fetch', fetcher);
    expect(await loadHarnessEvidence('project', sessionFixture(), new AbortController().signal)).toBeNull();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it.each(['projectId', 'taskId', 'sessionId', 'id'] as const)('rejects a changed %s binding in a late detail response', async (field) => {
    const fetcher = vi.fn().mockResolvedValueOnce(Response.json({ runs: [harnessFixture()] }))
      .mockResolvedValueOnce(Response.json(harnessFixture({ [field]: 'other' })));
    vi.stubGlobal('fetch', fetcher);
    await expect(loadHarnessEvidence('project', sessionFixture(), new AbortController().signal)).rejects.toThrow('no longer matches');
  });
  it('rejects ambiguous ownership instead of choosing an arbitrary run', async () => {
    const fetcher = vi.fn().mockResolvedValue(Response.json({ runs: [harnessFixture(), harnessFixture({ id: 'duplicate' })] }));
    vi.stubGlobal('fetch', fetcher);
    await expect(loadHarnessEvidence('project', sessionFixture(), new AbortController().signal)).rejects.toThrow('More than one run');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('propagates authorization and cancellation failures without claiming an empty result', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ error: { message: 'Scope denied' } }, { status: 403 })));
    await expect(loadHarnessEvidence('project', sessionFixture(), new AbortController().signal)).rejects.toThrow('Scope denied');
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new DOMException('Aborted', 'AbortError')));
    await expect(loadHarnessEvidence('project', sessionFixture(), new AbortController().signal)).rejects.toThrow('Aborted');
  });
});
