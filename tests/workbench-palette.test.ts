import { describe, expect, it, vi } from 'vitest';
import type { PaletteContext, PaletteHandlers } from '../client/console/paletteEntries';
import { buildEntries } from '../client/console/paletteEntries';
import type { Task } from '../shared/types';
import { sessionFixture } from './workbench-fixtures';

const task: Task = { id: 'task', name: 'Draft', description: '', from: null, owner: 'you', state: 'working',
  reason: null, needId: null, sessionIds: ['session'], changeIds: [], createdBy: 'you', createdAt: '', moves: [] };

function context(): PaletteContext {
  const handlers = {
    startTask: vi.fn(), pauseTask: vi.fn(), reviewTask: vi.fn(), routeTask: vi.fn(),
    reopenTask: vi.fn(), openBoard: vi.fn(), openTeam: vi.fn(), setRequested: vi.fn(),
    messageMember: vi.fn(), stopMember: vi.fn(), wakeMember: vi.fn(), selectThread: vi.fn(),
    setView: vi.fn(), openProject: vi.fn(),
  } as unknown as PaletteHandlers;
  return { tasks: [task], sessions: [sessionFixture({ state: 'working' })], needs: [], changes: [],
    members: [], catalogs: {}, integrations: [], projects: [], currentProjectId: 'project',
    currentThread: null, policy: 'go', view: 'Board', pendingTaskId: null, routingTaskId: null,
    onPendingTask: vi.fn(), onRoutingTask: vi.fn(), onPivotModels: vi.fn(), handlers };
}

describe('Palette task verbs', () => {
  it('names the stop action Stop, matching the board, and never Pause', () => {
    const entry = buildEntries(context()).find((row) => row.id === 'task:task');
    const labels = entry?.actions.map((action) => action.label) ?? [];
    expect(labels).toContain('Stop');
    expect(labels).not.toContain('Pause');
  });
});
