import type { HarnessRun } from '../shared/harness';
import type { Change, HistoryEntry, Need, Session } from '../shared/types';

export function sessionFixture(patch: Partial<Session> = {}): Session {
  return { id: 'session', taskId: 'task', state: 'working', startedAt: '2026-09-10T10:00:00Z',
    endedAt: null, sample: false, log: [], entryIds: [], needId: null,
    engine: { name: 'Codex', model: null, worker: 1, branch: null, context: null, events: 0 }, ...patch };
}
export function needFixture(patch: Partial<Need> = {}): Need {
  return { id: 'need', sessionId: 'session', taskId: 'task', what: 'Update draft', why: '', consequence: '',
    files: [], state: 'open', createdAt: '', decidedAt: null, decidedFrom: '', allowForTask: false, ...patch };
}
export function historyFixture(patch: Partial<HistoryEntry> = {}): HistoryEntry {
  return { id: 'history', time: '', actor: 'diomedes', kind: 'saved-version', sentence: '',
    sessionId: 'session', taskId: 'task', sample: false, files: [], label: null, restoreOf: null,
    replaced: null, versionId: 'v1', commit: null, ...patch };
}
export function changeFixture(patch: Partial<Change> = {}): Change {
  return { id: 'change', entryId: 'history', sessionId: 'session', taskId: 'task', path: 'draft.md',
    op: 'modified', summary: '', before: '', after: '', current: '', changedSince: null, hunks: [],
    state: 'waiting', ...patch };
}
export function harnessFixture(patch: Partial<HarnessRun> = {}): HarnessRun {
  return { v: 1, id: 'harness', tenantId: 'local', projectId: 'project', taskId: 'task', sessionId: 'session',
    capabilityId: 'format-report', capabilityVersion: 'v1', capabilityTools: ['propose_write'],
    policyVersion: 'p1', principal: { id: 'owner', tenantId: 'local', projectId: 'project', capabilities: [], identityGeneration: 0 },
    state: 'running', budget: { units: 4, modelCalls: 1, toolCalls: 1, wallMs: null },
    used: { units: 0, modelCalls: 0, toolCalls: 0 }, owner: 'owner', fence: 1, leaseExpiresAt: null,
    parentRunId: null, forkPoint: null, contextRevision: 1, transcripts: {}, result: null,
    failure: null, cancelReason: null, createdAt: '', updatedAt: '', steps: [], approvals: [], events: [], lastSeq: 0, ...patch };
}
