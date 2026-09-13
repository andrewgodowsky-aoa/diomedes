import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { Project, ProjectState, Task } from '../shared/types';
import { BoardView } from '../client/console/BoardView';
import { directOrigin } from '../shared/attribution';
import { needFixture, sessionFixture } from './workbench-fixtures';

const project: Project = { id: 'project', name: 'Project', folder: 'C:/owned', createdAt: '', lastOpenedAt: '',
  plans: [], references: [], repository: { present: false }, leftOff: null,
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
    onStart: mutation, onPause: mutation, onReview: mutation, onRoute: mutation, onReopen: mutation,
    onOpenTeam: mutation, onOpenThread: mutation, onCreateTask: mutation }));
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
    expect(markup).not.toContain('>Route to</button>');
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
  it('offers no Route to and no hidden Retry on a faulted row with no team', () => {
    const markup = board({ tasks: [{ ...task, state: 'waiting', reason: 'went-wrong' }],
      sessions: [sessionFixture({ state: 'failed' })] });
    expect(markup).not.toContain('>Route to</button>');
    expect(markup).not.toContain('>Retry</button>');
  });
  it('does not offer Start again for a stopped run, which Ready already restarts', () => {
    const markup = board({ sessions: [sessionFixture({ state: 'stopped' })] });
    expect(markup).toContain('Stopped; Start begins new work');
    expect(markup).toContain('>Start</button>');
    expect(markup).not.toContain('>Start again</button>');
  });
});
