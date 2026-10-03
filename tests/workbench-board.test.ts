import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { Project, ProjectState, Task, TeamMember } from '../shared/types';
import { manualTaskWorkflow } from '../shared/task-workflow';
import { BoardView } from '../client/console/BoardView';
import { directOrigin } from '../shared/attribution';
import { needFixture, sessionFixture } from './workbench-fixtures';

const project: Project = { id: 'project', name: 'Project', folder: 'C:/owned', createdAt: '', lastOpenedAt: '',
  plans: [], references: [], repository: { present: false },
  counts: { running: 0, changesWaiting: 0, waitingForYou: 0, historyToday: 0 },
  status: { needsYou: 0, working: 0, tasksDone: 0, tasksTotal: 0 } };
const task: Task = { id: 'task', name: 'Draft', description: '', from: null, owner: 'you', state: 'todo',
  reason: null, needId: null, sessionIds: [], changeIds: [], createdBy: 'you', createdAt: '', moves: [] };
function board(patch: Partial<ProjectState>, options: {
  policy?: 'first' | 'go';
  onPolicyChange?(policy: 'first' | 'go'): void;
} = {}) {
  const state: ProjectState = { project, documents: [], tasks: [task], sessions: [], needs: [], changes: [], history: [], conversations: [], ...patch };
  const mutation = vi.fn(async () => {});
  const markup = renderToStaticMarkup(createElement(BoardView, { project, state, tasks: state.tasks, policy: options.policy ?? 'go',
    onPolicyChange: options.onPolicyChange, busy: false,
    documents: [], documentsLoading: false, documentsFailure: null,
    onStart: mutation, onPause: mutation, onReview: mutation, onRoute: mutation, onReopen: mutation,
    onMarkDone: mutation, onOpenTeam: mutation, onOpenThread: mutation, onCreateTask: mutation }));
  expect(mutation).not.toHaveBeenCalled();
  return markup;
}
describe('Board controls reflect execution evidence', () => {
  it('shows recorded creation evidence only when a Task actually has a receipt', () => {
    expect(board({})).not.toContain('Creation receipt');
    const made = { ...task, creationReceipt: {
      protocolVersion: 1 as const, commandId: 'create-123', payloadDigest: `sha256:${'a'.repeat(64)}`,
      projectId: project.id, taskId: task.id, eventId: 'E123', admittedAt: '2026-09-12T00:00:00.000Z',
      actor: 'local-client' as const, scope: 'local-prototype' as const,
    } };
    const markup = board({ tasks: [made] });
    expect(markup).toContain('Creation receipt');
    expect(markup).toContain('create-123');
    expect(markup).toContain('E123');
    expect(markup).toContain('dateTime="2026-09-12T00:00:00.000Z"');
    expect(markup).toContain('>Start</button>');
  });
  it('renders an admitted task in Queued with Stop, never Pause or an enabled Start', () => {
    const markup = board({ sessions: [sessionFixture({ state: 'queued' })] });
    expect(markup).toContain('aria-label="Queued"');
    expect(markup).toContain('Waiting to start');
    expect(markup).toContain('>Stop</button>');
    expect(markup).not.toContain('>Pause</button>');
    expect(markup).not.toContain('>Start</button>');
  });
  it('blocks a ready task start while a different task is waiting for approval', () => {
    const markup = board({ sessions: [sessionFixture({ taskId: 'other', state: 'waiting' })], needs: [needFixture({ taskId: 'other' })] });
    expect(markup).toMatch(/disabled=""[^>]*title="One run at a time in this version"[^>]*>Start/);
  });
  it('does not offer retry routing for an active uncertain effect', () => {
    const markup = board({ tasks: [{ ...task, state: 'waiting', reason: 'went-wrong' }], sessions: [sessionFixture({ state: 'waiting' })] });
    expect(markup).toContain('Check the run before retrying');
    expect(markup).not.toContain('>Assign</button>');
    expect(markup).toContain('>Stop</button>');
  });
  it('keeps historical runtime attribution and escapes external display names', () => {
    const markup = board({ tasks: [{ ...task, state: 'done' }], sessions: [sessionFixture({ state: 'done',
      origin: directOrigin({ engine: 'codex', requestedModel: 'new-choice', reportedModel: '<old-runtime>' }) })] });
    expect(markup).toContain('&lt;old-runtime&gt;');
    expect(markup).toContain('via Codex');
    expect(markup).not.toContain('new-choice');
    expect(markup).not.toContain('<old-runtime>');
  });
  it('states board policy read-only from the prop and offers no grant control without a callback', () => {
    const first = board({}, { policy: 'first' });
    expect(first).toContain('data-board-policy="first"');
    expect(first).toContain('Confirm each start');
    expect(first).not.toContain('role="radio"');
    expect(first).not.toContain('data-board-policy="go"');
    const go = board({}, { policy: 'go' });
    expect(go).toContain('data-board-policy="go"');
    expect(go).toContain('Start on click');
    expect(go).not.toContain('Go ahead for tasks');
    expect(go).not.toContain('role="radio"');
  });
  it('keeps the controlled callback case and tracks the policy prop, not a local override', () => {
    const onChange = vi.fn();
    const first = board({}, { policy: 'first', onPolicyChange: onChange });
    expect(first).toContain('role="radiogroup"');
    expect(first).toContain('role="radio"');
    expect(first).toContain('aria-checked="true"');
    expect(first).not.toContain('data-board-policy');
    const go = board({}, { policy: 'go', onPolicyChange: onChange });
    expect(go).toContain('aria-checked="false"');
    expect(onChange).not.toHaveBeenCalled();
  });
  it('does not repeat the Ready column caption on a plain Ready row', () => {
    const markup = board({});
    expect(markup.split('Start explicitly to run')).toHaveLength(2);
  });
  it('offers one control that fills the board, and says so where Ready is empty', () => {
    const markup = board({ tasks: [] });
    expect(markup).toContain('>New task</button>');
    expect(markup).toContain('Nothing is ready. New task adds one.');
    expect(markup).not.toContain('Make tasks from a plan.');
  });
  it('offers Start again on a faulted row, so the fault sentence can be obeyed', () => {
    const markup = board({ tasks: [{ ...task, state: 'waiting', reason: 'went-wrong' }],
      sessions: [sessionFixture({ state: 'failed' })] });
    expect(markup).toContain('aria-label="Blocked"');
    expect(markup).toContain('Run failed');
    expect(markup).toContain('>Start again</button>');
    expect(markup).not.toContain('>Start</button>');
  });
  it('offers no Assign and no hidden Retry on a faulted row with no team', () => {
    const markup = board({ tasks: [{ ...task, state: 'waiting', reason: 'went-wrong' }],
      sessions: [sessionFixture({ state: 'failed' })] });
    expect(markup).not.toContain('>Assign</button>');
    expect(markup).not.toContain('>Retry</button>');
  });
  it('does not offer Start again for a stopped run, which Ready already restarts', () => {
    const markup = board({ sessions: [sessionFixture({ state: 'stopped' })] });
    expect(markup).toContain('Stopped; Start begins new work');
    expect(markup).toContain('>Start</button>');
    expect(markup).not.toContain('>Start again</button>');
  });
});

// S1 free manual teams (DIO-176): the Board shows the member a card is assigned to, offers the
// assignment on the card, and shows a hand-off on the card it was handed to.
const astra: TeamMember = { slotId: 'S-astra', name: 'Astra', role: 'member', engine: 'codex', model: null,
  status: 'idle', threadId: null, createdAt: '', lastSeenAt: null };
const bram: TeamMember = { ...astra, slotId: 'S-bram', name: 'Bram', engine: 'claude-code' };
const team = (members: TeamMember[]) => ({ members, messages: [], runs: [] });
describe('manual teams on the Board', () => {
  it('N01: shows the assigned member as the worker and offers Assign with a way to clear it', () => {
    const markup = board({ tasks: [{ ...task, assignedTo: astra.slotId }], team: team([astra, bram]) });
    expect(markup).toContain('>Astra</span>');
    expect(markup).toContain('>Assign</button>');
    expect(markup).not.toContain('>Route to</button>');
  });
  it('keeps a manual card on its member while it runs, and offers no Assign on a running or owned card', () => {
    const manual = { ...task, assignedTo: bram.slotId, workflow: manualTaskWorkflow() };
    const running = board({ tasks: [{ ...manual, workflow: { ...manual.workflow, inbox: false } }], team: team([astra, bram]),
      sessions: [sessionFixture({ origin: directOrigin({ engine: 'claude-code', requestedModel: 'opus', reportedModel: null }) })] });
    expect(running).toContain('>Bram</span>');
    expect(running).toContain('title="Bram works through Claude Code"');
    expect(running).not.toContain('>Assign</button>');
    const owned = board({ tasks: [{ ...task, ownedAssignment: { rootTaskId: 'r', rootRunId: 'R', admissionRef: 'g' } }],
      team: team([astra]) });
    expect(owned).not.toContain('>Assign</button>');
  });
  it('N08: shows a hand-off on the next card and offers Hand off on a card with somewhere to go', () => {
    const next = { ...task, id: 'next', name: 'Proofread', assignedTo: bram.slotId };
    const markup = board({ tasks: [{ ...task, assignedTo: astra.slotId }, next], team: team([astra, bram]), manualHandoffs: [{
      id: 'H1', fromTaskId: task.id, toTaskId: next.id, fromSlot: astra.slotId, toSlot: bram.slotId,
      outcome: 'The draft is done.', changedFiles: ['Fall menu.md'], checks: ['Read it aloud'], openIssues: ['Soup price'],
      createdBy: 'you', createdAt: '2026-10-03T10:00:00.000Z' }] });
    expect(markup).toContain('Hand-off from Astra');
    expect(markup).toContain('The draft is done.');
    expect(markup).toContain('Fall menu.md');
    expect(markup).toContain('Read it aloud');
    expect(markup).toContain('Soup price');
    expect(markup.split('>Hand off</button>')).toHaveLength(3);
  });
  it('offers Retire hand-off on a live hand-off and shows a retired one no more', () => {
    const next = { ...task, id: 'next', name: 'Proofread', assignedTo: bram.slotId };
    const record = { id: 'H1', fromTaskId: task.id, toTaskId: next.id, fromSlot: astra.slotId, toSlot: bram.slotId,
      outcome: 'The draft is done.', changedFiles: ['Fall menu.md'], checks: [], openIssues: [],
      createdBy: 'you' as const, createdAt: '2026-10-03T10:00:00.000Z' };
    const tasks = [{ ...task, assignedTo: astra.slotId }, next];
    const live = board({ tasks, team: team([astra, bram]), manualHandoffs: [record] });
    expect(live.split('>Retire hand-off</button>')).toHaveLength(2);
    const retired = board({ tasks, team: team([astra, bram]),
      manualHandoffs: [{ ...record, retiredAt: '2026-10-03T11:00:00.000Z' }] });
    expect(retired).not.toContain('Hand-off from Astra');
    expect(retired).not.toContain('Retire hand-off');
  });
});
