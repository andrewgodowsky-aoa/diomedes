/**
 * Everything the preview shows is invented here.
 *
 * Not one value in this file comes from a project, a thread, a task, a document
 * or an engine. The preview renders the real components — that is the point of
 * the whole harness — but it renders them over a story that never happened, so
 * looking at a theme cannot leak what someone is working on and replaying a
 * preview cannot start, approve or send anything.
 *
 * Fixed timestamps rather than `Date.now()`: the preview must look the same in
 * a screenshot taken a week apart, and a relative time would make every
 * evidence image differ from the last.
 */
import type {
  Change,
  IntegrationStatus,
  Need,
  UsageSnapshot,
  UsageWindow,
} from '../../../shared/types';

const AT = '2026-01-14T09:20:00.000Z';

export const fixtureEngine: IntegrationStatus = {
  id: 'preview-engine',
  name: 'Example engine',
  kind: 'local',
  found: true,
  available: true,
  enabled: true,
  status: 'Ready',
  detail: 'A made-up engine, shown so this card has something to say. It is not installed.',
  capabilities: ['reads files', 'proposes changes'],
  installedVersion: 'version 1.0.0 (example)',
  provenVersion: '1.0.0',
  location: 'C:\\Example\\engine.exe',
  signIn: 'signed-in',
  adapter: 'ready',
  disclosure: ['The text of your request', 'The files you name'],
};

export const fixtureWindow: UsageWindow = {
  id: 'preview-window',
  label: 'This week',
  usedPercent: 38,
  resetsAt: '2026-01-19T00:00:00.000Z',
  durationMins: 10080,
};

export const fixtureLowWindow: UsageWindow = {
  id: 'preview-window-low',
  label: 'Today',
  usedPercent: 94,
  resetsAt: '2026-01-15T00:00:00.000Z',
  durationMins: 1440,
};

export const fixtureUsage: UsageSnapshot = {
  engine: 'preview-engine',
  at: AT,
  windows: [fixtureWindow, fixtureLowWindow],
  plan: 'Example plan',
  thread: null,
  source: 'none',
  detail: 'Example numbers. Nothing here was measured.',
};

export const fixtureChange: Change = {
  id: 'preview-change',
  entryId: 'preview-entry',
  sessionId: null,
  taskId: 'preview-task',
  path: 'notes\\welcome.md',
  op: 'modified',
  summary: 'Two lines added to the opening paragraph',
  before: 'Welcome.\nThis is an example document.\n',
  after: 'Welcome.\nThis is an example document.\nIt is here so the card has something to show.\n',
  current: null,
  changedSince: null,
  hunks: [
    { value: 'Welcome.\nThis is an example document.\n', count: 2 },
    { value: 'It is here so the card has something to show.\n', added: true, count: 1 },
  ],
  state: 'waiting',
};

export const fixtureNeed: Need = {
  id: 'preview-need',
  sessionId: 'preview-session',
  taskId: 'preview-task',
  what: 'change one line in an example document',
  why: 'So this card has a real sentence in it.',
  consequence: 'Nothing happens: this is a picture of the interface, not a proposal.',
  files: ['notes\\welcome.md'],
  state: 'open',
  createdAt: AT,
  decidedAt: null,
  decidedFrom: '',
  allowForTask: false,
  preview: [fixtureChange],
};

export const fixtureThreads = [
  { id: 'preview-thread-1', name: 'Opening the season', time: '09:20', sub: 'Two open questions' },
  { id: 'preview-thread-2', name: 'Supplier list', time: 'Mon', sub: 'Waiting on you' },
  { id: 'preview-thread-3', name: 'Front window copy', time: 'Jan 9', sub: 'Done' },
];

export const fixtureTurns = [
  {
    id: 'preview-turn-1',
    role: 'you' as const,
    at: AT,
    text: 'Can you draft a short note for the front window?',
  },
  {
    id: 'preview-turn-2',
    role: 'assistant' as const,
    at: AT,
    text: 'Here is a first attempt. It is three lines and it names the opening date. Tell me what to change.',
  },
];

export const fixtureDocument = {
  path: 'notes\\welcome.md',
  excerpt: '# Welcome\n\nThis is an example document. It exists so the preview has\nsomething to set in the reading face.\n',
};

export const fixtureTasks = [
  { id: 'preview-task-1', name: 'Draft the window note', state: 'working' as const },
  { id: 'preview-task-2', name: 'Check the supplier list', state: 'waiting' as const },
  { id: 'preview-task-3', name: 'Send the opening email', state: 'todo' as const },
  { id: 'preview-task-4', name: 'Tidy the notes folder', state: 'done' as const },
];

export const fixtureModels = [
  { slug: 'example-large', name: 'Example Large', efforts: ['Low', 'Medium', 'High'] },
  { slug: 'example-small', name: 'Example Small', efforts: ['Low', 'Medium'] },
];
