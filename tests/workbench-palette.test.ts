import { describe, expect, it, vi } from 'vitest';
import type { PaletteContext, PaletteHandlers } from '../client/console/paletteEntries';
import { buildEntries, filterPalette } from '../client/console/paletteEntries';
import type { DocumentInfo, Task } from '../shared/types';
import { sessionFixture } from './workbench-fixtures';

const task: Task = { id: 'task', name: 'Draft', description: '', from: null, owner: 'you', state: 'working',
  reason: null, needId: null, sessionIds: ['session'], changeIds: [], createdBy: 'you', createdAt: '', moves: [] };
const documents: DocumentInfo[] = [
  { path: 'suppliers/produce/spring order.md', kind: 'markdown', size: 2048, changedAt: '2026-09-11T09:00:00Z',
    hasChangesWaiting: true, recorded: true },
  { path: 'scan.png', kind: 'unsupported', size: 90_000, changedAt: '2026-09-11T09:00:00Z',
    hasChangesWaiting: false, recorded: false },
];

function context(): PaletteContext {
  const handlers = {
    startTask: vi.fn(), pauseTask: vi.fn(), reviewTask: vi.fn(), routeTask: vi.fn(),
    reopenTask: vi.fn(), openBoard: vi.fn(), openTeam: vi.fn(), setRequested: vi.fn(),
    messageMember: vi.fn(), stopMember: vi.fn(), wakeMember: vi.fn(), selectThread: vi.fn(),
    setView: vi.fn(), openProject: vi.fn(), openDocument: vi.fn(),
  } as unknown as PaletteHandlers;
  return { tasks: [task], sessions: [sessionFixture({ state: 'working' })], needs: [], changes: [],
    documents, members: [], catalogs: {}, integrations: [], projects: [], currentProjectId: 'project',
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

describe('Palette Files group', () => {
  it('offers one Open action per document, named by the file and placed by its folder', () => {
    const entry = buildEntries(context()).find((row) => row.id === 'file:suppliers/produce/spring order.md');
    expect(entry?.group).toBe('Files');
    expect(entry?.name).toBe('spring order.md');
    expect(entry?.sub).toBe('markdown, suppliers/produce, changes waiting, recorded');
    expect(entry?.actions.map((action) => action.label)).toEqual(['Open']);
  });

  it('opens the document in the pane rather than acting on the file', () => {
    const ctx = context();
    const entry = buildEntries(ctx).find((row) => row.id === 'file:scan.png');
    // A file Diomedes cannot read as text is still listed, and still opens.
    expect(entry?.sub).toBe('not text, project folder');
    expect(entry?.point).toBe('');
    entry?.actions[0].run();
    expect(ctx.handlers.openDocument).toHaveBeenCalledWith('scan.png');
  });

  it('finds a file by a folder the row does not print', () => {
    const rows = filterPalette(buildEntries(context()), 'produce');
    expect(rows.map((row) => row.id)).toEqual(['file:suppliers/produce/spring order.md']);
  });

  it('keeps the file rows out of the task verbs', () => {
    const rows = filterPalette(buildEntries(context()), 'stop');
    expect(rows.every((row) => row.group !== 'Files')).toBe(true);
  });
});
