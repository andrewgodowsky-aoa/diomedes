import { describe, expect, it } from 'vitest';
import {
  ALL_PROJECTS,
  RESTRICTIONS,
  canSend,
  instrumentLine,
  keyIntent,
  paragraphs,
  scopeFromSpineId,
  selectedSpineId,
  spineItems,
  visibleResults,
  type DiomedesResult,
} from '../client/console/diomedes-view';

// This file imports only the pure view-model, the way tests/console-activity
// .test.ts imports only client/console/activity: this repository has no
// jsdom, so nothing here can render a component, only prove what the
// component's decisions would be.

const NOW = Date.parse('2026-09-21T12:00:00Z');
const ago = (ms: number) => new Date(NOW - ms).toISOString();

/** A minimal Project fixture, built the way tests/console-activity.test.ts
 *  builds one, but without importing shared/types: every field a Project
 *  requires is filled in literally, and the object structurally satisfies
 *  it wherever the view-model asks for one. */
function projectFixture(overrides: {
  id?: string;
  name?: string;
  createdAt?: string;
  lastOpenedAt?: string;
  needsYou?: number;
  working?: number;
  tasksDone?: number;
  tasksTotal?: number;
} = {}) {
  return {
    id: overrides.id ?? 'project',
    name: overrides.name ?? 'Project',
    folder: 'C:/owned',
    createdAt: overrides.createdAt ?? ago(0),
    lastOpenedAt: overrides.lastOpenedAt ?? ago(0),
    plans: [] as string[],
    references: [] as string[],
    repository: { present: false },
    leftOff: null,
    counts: { running: 0, changesWaiting: 0, waitingForYou: 0, historyToday: 0 },
    status: {
      needsYou: overrides.needsYou ?? 0,
      working: overrides.working ?? 0,
      tasksDone: overrides.tasksDone ?? 0,
      tasksTotal: overrides.tasksTotal ?? 0,
    },
  };
}

function resultFixture(patch: Partial<DiomedesResult> = {}): DiomedesResult {
  return {
    id: 'result',
    title: 'Weekly ordering brief',
    projectName: 'Weekly ordering',
    when: 'Thu',
    state: 'done',
    ...patch,
  };
}

describe('spineItems', () => {
  it('puts All projects first, and it is what a null scope selects', () => {
    const items = spineItems([projectFixture({ id: 'a', name: 'A' })], NOW);
    expect(items[0].id).toBe(ALL_PROJECTS);
    expect(items[0].name).toBe('All projects');
    expect(selectedSpineId(null)).toBe(items[0].id);
  });

  it('lists projects most recently opened first', () => {
    const items = spineItems(
      [
        projectFixture({ id: 'old', name: 'Old', lastOpenedAt: ago(50_000) }),
        projectFixture({ id: 'new', name: 'New', lastOpenedAt: ago(1_000) }),
      ],
      NOW,
    );
    expect(items.map((i) => i.id)).toEqual([ALL_PROJECTS, 'new', 'old']);
  });

  it('reads a project\'s age from the now it is given, not the clock', () => {
    const items = spineItems([projectFixture({ id: 'p', lastOpenedAt: ago(2 * 60 * 60 * 1000) })], NOW);
    expect(items[1].time).toBe('2h');
  });

  it('does not let a project literally named "all" collide with ALL_PROJECTS', () => {
    // The collision guard is on id, never on name: a project can be called
    // anything, including the reserved word, and the reserved row still
    // belongs to nobody's project.
    const items = spineItems([projectFixture({ id: 'proj-1', name: 'all' })], NOW);
    expect(items[0].id).toBe(ALL_PROJECTS);
    expect(items[1].id).toBe('proj-1');
    expect(selectedSpineId('proj-1')).toBe('proj-1');
    expect(scopeFromSpineId('proj-1')).toBe('proj-1');
  });
});

describe('selectedSpineId and scopeFromSpineId round trip', () => {
  it('maps a null scope to the reserved id and back', () => {
    expect(selectedSpineId(null)).toBe(ALL_PROJECTS);
    expect(scopeFromSpineId(ALL_PROJECTS)).toBe(null);
  });

  it('maps a project id to itself and back', () => {
    expect(selectedSpineId('proj-1')).toBe('proj-1');
    expect(scopeFromSpineId('proj-1')).toBe('proj-1');
  });
});

describe('canSend', () => {
  it('blocks empty text', () => {
    expect(canSend('', false, null)).toBe(false);
  });
  it('blocks whitespace-only text', () => {
    expect(canSend('   \n\t', false, null)).toBe(false);
  });
  it('blocks while pending, even with real text', () => {
    expect(canSend('Ask about the schedule', true, null)).toBe(false);
  });
  it('blocks when the conversation is unavailable, even with real text', () => {
    expect(canSend('Ask about the schedule', false, 'This project has no folder anymore.')).toBe(false);
  });
  it('allows real text when idle and available', () => {
    expect(canSend('Ask about the schedule', false, null)).toBe(true);
  });
});

describe('keyIntent', () => {
  it('sends on Enter', () => {
    expect(keyIntent({ key: 'Enter', shiftKey: false })).toBe('send');
  });
  it('is a newline on Shift+Enter', () => {
    expect(keyIntent({ key: 'Enter', shiftKey: true })).toBe('newline');
  });
  it('never sends while an IME composition is open', () => {
    expect(keyIntent({ key: 'Enter', shiftKey: false, isComposing: true })).toBe(null);
  });
  it('is null for a key that means neither send nor newline', () => {
    expect(keyIntent({ key: 'a', shiftKey: false })).toBe(null);
  });
});

describe('RESTRICTIONS', () => {
  it('has exactly three entries, and none of them mentions Build', () => {
    expect(RESTRICTIONS).toHaveLength(3);
    expect(RESTRICTIONS.map((r) => r.id)).toEqual(['automatic', 'answer-only', 'plan-only']);
    expect(RESTRICTIONS.map((r) => r.label)).toEqual(['Automatic', 'Answer only', 'Plan only']);
    expect(RESTRICTIONS.some((r) => /build/i.test(r.label))).toBe(false);
  });
});

describe('visibleResults', () => {
  it('gives an empty array for an empty input', () => {
    expect(visibleResults([])).toEqual([]);
  });

  it('caps the list and keeps the order it was given', () => {
    const results = Array.from({ length: 7 }, (_, i) => resultFixture({ id: `r${i}`, title: `Result ${i}` }));
    const visible = visibleResults(results, 3);
    expect(visible.map((r) => r.id)).toEqual(['r0', 'r1', 'r2']);
  });

  it('defaults to a cap even when the caller does not name one', () => {
    const results = Array.from({ length: 9 }, (_, i) => resultFixture({ id: `r${i}` }));
    expect(visibleResults(results).length).toBeLessThan(9);
  });
});

describe('instrumentLine', () => {
  const projects = [projectFixture({ id: 'proj-1', name: 'Weekly ordering' })];

  it('names the home conversation for a null scope', () => {
    expect(instrumentLine(null, projects, 'automatic')).toContain('All projects');
  });

  it('names a known project', () => {
    const line = instrumentLine('proj-1', projects, 'plan-only');
    expect(line).toContain('Weekly ordering');
    expect(line).toContain('Plan only');
  });

  it('reads an unknown scope id as All projects rather than naming nothing', () => {
    expect(instrumentLine('missing-project', projects, 'answer-only')).toContain('All projects');
  });
});

describe('paragraphs', () => {
  // The same rule the thread view applies to the same records, so a
  // conversation reads identically on either screen.
  it('splits on a blank line and keeps a single line break inside a paragraph', () => {
    expect(paragraphs('First line\nsame paragraph\n\nSecond paragraph')).toEqual([
      'First line\nsame paragraph',
      'Second paragraph',
    ]);
  });

  it('treats a line of only spaces as a blank line, and trims each paragraph', () => {
    expect(paragraphs('  One  \n   \n  Two  ')).toEqual(['One', 'Two']);
  });

  it('gives nothing for text with nothing in it, so no empty paragraph is drawn', () => {
    expect(paragraphs('')).toEqual([]);
    expect(paragraphs(' \n\n ')).toEqual([]);
  });
});
