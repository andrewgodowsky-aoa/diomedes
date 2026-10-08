import { describe, expect, it } from 'vitest';
import {
  ALL_PROJECTS,
  canSaveAgent,
  canSend,
  conversationAgentOf,
  conversationAgents,
  conversationKindOf,
  instrumentLine,
  keyIntent,
  paragraphs,
  scopeFromSpineId,
  selectedSpineId,
  spineItems,
  visibleResults,
  diomedesThread,
  outcomeCard,
  type DiomedesResult,
} from '../client/console/diomedes-view';
import { AUTO_SUMMARY } from '../shared/agents';
import type { InteractionOutcome } from '../shared/conversation';
import type { Conversation } from '../shared/types';

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

  it('counts a project\'s tasks in words, one task in the singular', () => {
    const items = spineItems(
      [
        projectFixture({ id: 'one', name: 'One', tasksTotal: 1, tasksDone: 0, lastOpenedAt: ago(1_000) }),
        projectFixture({ id: 'four', name: 'Four', tasksTotal: 4, tasksDone: 2, lastOpenedAt: ago(2_000) }),
      ],
      NOW,
    );
    expect(items.find((i) => i.id === 'one')?.sub).toBe('0 of 1 task done');
    expect(items.find((i) => i.id === 'four')?.sub).toBe('2 of 4 tasks done');
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

  it('keeps a saved project whose id is the word "all" apart from home', () => {
    // The saved-registry check in server/store.ts accepts `all` as an id, so
    // one can reach these props even though nothing here creates it. It must
    // still be its own row, its own option, and its own scope.
    const items = spineItems([projectFixture({ id: 'all', name: 'Catering' })], NOW);
    expect(new Set(items.map((i) => i.id)).size).toBe(items.length);
    expect(selectedSpineId('all')).toBe('all');
    expect(scopeFromSpineId('all')).toBe('all');
    expect(scopeFromSpineId(selectedSpineId(null))).toBe(null);
  });

  it('uses a home id no saved project id can take', () => {
    // The pattern is server/store.ts's PROJECT_ID, repeated here because a
    // client test cannot import the server's private constant.
    expect(ALL_PROJECTS).not.toMatch(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/);
  });

  it('says nothing about reach on the home row, with no project or several', () => {
    // The page can be showing "this conversation cannot run here" while this
    // row is on screen, and this function is never told. So the row never
    // claims the workspace, whatever it is given.
    const several = [projectFixture({ id: 'a', name: 'A' }), projectFixture({ id: 'b', name: 'B' })];
    for (const projects of [[], several]) {
      const home = spineItems(projects, NOW)[0];
      expect(home.id).toBe(ALL_PROJECTS);
      expect(home.sub).toBe('Your main conversation');
      expect(`${home.name} ${home.sub}`).not.toMatch(/workspace|everything|every project/i);
    }
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

describe('conversationAgents', () => {
  it('offers Auto first, then only the Agents that answer here, so none of them changes files', () => {
    const agents = conversationAgents();
    expect(agents[0]).toEqual({ id: 'auto', name: 'Auto', line: AUTO_SUMMARY, kind: 'auto' });
    expect(agents.map((a) => a.name)).toEqual(['Auto', 'Researcher', 'Planner', 'Reviewer', 'Explorer', 'Analyst']);
    expect(agents.map((a) => a.kind)).toEqual(['auto', 'ask', 'plan', 'ask', 'ask', 'ask']);
    expect(agents.every((a) => a.line.trim() !== '')).toBe(true);
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
    expect(instrumentLine(null, projects, 'Auto')).toBe('All projects · Auto');
  });

  it('names a known project and the Agent', () => {
    const line = instrumentLine('proj-1', projects, 'Planner');
    expect(line).toContain('Weekly ordering');
    expect(line).toContain('Planner');
  });

  it('reads an unknown scope id as All projects rather than naming nothing', () => {
    expect(instrumentLine('missing-project', projects, 'Researcher')).toContain('All projects');
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

describe('which thread a project talks to Diomedes on', () => {
  const thread = (patch: Partial<Conversation>): Conversation => ({
    id: 'C1',
    attachedTo: { kind: 'project', ref: 'p1' },
    turns: [],
    mode: 'ask',
    createdAt: '2026-09-01T00:00:00.000Z',
    ...patch,
  });
  const lineage = [{ mode: 'auto' as const, generation: 1, runId: 'r1' }];

  it('is none until one exists, so the page creates it on the first send and never before', () => {
    expect(diomedesThread([])).toBeNull();
    // An ordinary Console thread is not the Diomedes conversation, however old it is.
    expect(diomedesThread([thread({ id: 'C0', mode: 'ask' })])).toBeNull();
    expect(diomedesThread([thread({ id: 'C0', mode: 'build' })])).toBeNull();
    expect(diomedesThread([thread({ id: 'C0', mode: 'auto' })])).toBeNull();
    expect(diomedesThread([thread({ id: 'C0', lineages: lineage })])).toBeNull();
  });

  it('reads the marker before a first message, regardless of Agent or mode', () => {
    expect(diomedesThread([thread({ id: 'C2', mode: 'plan', conversation: 'project' })])?.id).toBe('C2');
  });

  it('keeps the marked thread after it speaks or starts work', () => {
    const marked = thread({
      id: 'C3', mode: 'ask', lineages: lineage, conversation: 'project', taskId: 't1',
    });
    expect(diomedesThread([marked])?.id).toBe('C3');
  });

  it('resolves duplicate markers deterministically without relying on array order', () => {
    const a = thread({ id: 'Cb', conversation: 'project', createdAt: '2026-09-02T00:00:00.000Z' });
    const b = thread({ id: 'Ca', conversation: 'project', createdAt: '2026-09-02T00:00:00.000Z' });
    const c = thread({ id: 'Cz', conversation: 'project', createdAt: '2026-09-01T00:00:00.000Z' });
    expect(diomedesThread([a, b])?.id).toBe('Ca');
    expect(diomedesThread([b, a, c])?.id).toBe('Cz');
    expect(diomedesThread([c, a, b])?.id).toBe('Cz');
  });

  it('never adopts a thread that belongs to a task, a document or a review', () => {
    expect(
      diomedesThread([
        thread({ id: 'Ct', mode: 'auto', taskId: 't1' }),
        thread({ id: 'Cd', conversation: 'project', attachedTo: { kind: 'document', ref: 'a.md' } }),
        thread({ id: 'Cr', conversation: 'project', attachedTo: { kind: 'review', ref: 'x' } }),
      ]),
    ).toBeNull();
  });
});

describe('the Agent control and the thread', () => {
  const thread = (patch: Partial<Conversation> = {}): Conversation => ({
    id: 'C1',
    attachedTo: { kind: 'project', ref: 'p1' },
    turns: [],
    mode: 'auto',
    createdAt: '2026-09-01T00:00:00.000Z',
    ...patch,
  });
  const box = (agent: string) => ({ model: null, effort: null, agent });
  const spoken = [{ mode: 'auto' as const, generation: 1, runId: 'r1' }];

  it("reads the thread's Agent box, and a Mode saved before agents as its kind's Agent", () => {
    expect(conversationAgentOf(thread())).toBe('auto');
    expect(conversationAgentOf(thread({ mode: 'ask' }))).toBe('diomedes.researcher');
    expect(conversationAgentOf(thread({ mode: 'plan' }))).toBe('diomedes.architect');
    expect(conversationAgentOf(thread({ mode: 'ask', requested: box('diomedes.reviewer') }))).toBe('diomedes.reviewer');
  });
  it('reads an Agent that changes files as Auto, so this page never shows one', () => {
    expect(conversationAgentOf(thread({ mode: 'build' }))).toBe('auto');
    expect(conversationAgentOf(thread({ mode: 'build', requested: box('diomedes.writer') }))).toBe('auto');
  });
  it("gives each Agent's kind of message, and Auto's for one it doesn't offer", () => {
    expect(conversationKindOf('auto')).toBe('auto');
    expect(conversationKindOf('diomedes.researcher')).toBe('ask');
    expect(conversationKindOf('diomedes.architect')).toBe('plan');
    expect(conversationKindOf('diomedes.builder')).toBe('auto');
    expect(conversationKindOf('acme.unknown')).toBe('auto');
  });
  it('holds another Agent back from a project conversation that has not spoken', () => {
    // The wait dates from when a conversation that hadn't spoken was found by its Automatic kind.
    // Its marker finds it now (DIO-299), whatever its kind, so the wait can be relaxed later.
    expect(diomedesThread([thread({ mode: 'ask', conversation: 'project' })])?.id).toBe('C1');
    expect(canSaveAgent('p1', thread(), 'diomedes.researcher')).toBe(false);
    expect(canSaveAgent('p1', null, 'diomedes.architect')).toBe(false);
    // Auto keeps the kind, a thread that has spoken takes any Agent, and home is found by its binding.
    expect(canSaveAgent('p1', thread(), 'auto')).toBe(true);
    expect(canSaveAgent('p1', thread({ lineages: spoken }), 'diomedes.researcher')).toBe(true);
    expect(diomedesThread([thread({ mode: 'ask', lineages: spoken })])).toBeNull();
    expect(canSaveAgent(null, thread(), 'diomedes.researcher')).toBe(true);
  });
});

describe('what one outcome reads as', () => {
  const projects = [projectFixture({ id: 'p1', name: 'Harbor Street Bakery' })];
  const proposed: InteractionOutcome = {
    status: 'proposed',
    projectId: 'p1',
    operationClass: 'write_internal',
    proposalDigest: 'd'.repeat(64),
    summary: 'Order the usual from the supplier.',
  };

  it('shows nothing when the answer is all there is', () => {
    expect(outcomeCard(null, projects)).toBeNull();
    expect(outcomeCard({ status: 'answered' }, projects)).toBeNull();
    expect(outcomeCard({ status: 'read', projectId: 'p1' }, projects)).toBeNull();
  });

  it('offers Start only for a proposal, names the project, and promises nothing is written yet', () => {
    const card = outcomeCard(proposed, projects)!;
    expect(card.action).toEqual({ kind: 'start', label: 'Start' });
    expect(card.title).toBe('Nectovia can start this in Harbor Street Bakery');
    expect(card.body).toContain('Order the usual from the supplier.');
    expect(card.body).toContain('Nothing is written until you say go ahead.');
  });

  it('says started only when work started, and offers the way to it', () => {
    const card = outcomeCard(
      { status: 'started', projectId: 'p1', taskId: 't', sessionId: 's' },
      projects,
    )!;
    expect(card.title).toBe('Started in Harbor Street Bakery');
    expect(card.action).toEqual({ kind: 'open', label: 'Open the work' });
  });

  it('never offers an action for what did not start, and says why in the server sentence', () => {
    const blocked = outcomeCard(
      { status: 'not-started', reason: 'needs-target', message: 'Say which project.', taskId: null },
      projects,
    )!;
    const refused = outcomeCard(
      { status: 'not-started', reason: 'refused', message: 'Busy.', taskId: 't' },
      projects,
    )!;
    const unresolved = outcomeCard({ status: 'unresolved', message: 'Send it again.' }, projects)!;
    expect([blocked.action, refused.action, unresolved.action]).toEqual([null, null, null]);
    expect([blocked.body, refused.body, unresolved.body]).toEqual([
      'Say which project.',
      'Busy.',
      'Send it again.',
    ]);
    expect([blocked.tone, refused.tone, unresolved.tone]).toEqual(['attn', 'fail', 'attn']);
  });

  it('names no project it cannot find rather than showing an id', () => {
    expect(outcomeCard({ ...proposed, projectId: 'gone' }, projects)!.title).toBe(
      'Nectovia can start this in a project',
    );
  });
});
