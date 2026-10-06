import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Diomedes, type DiomedesPageProps } from '../client/console/Diomedes';
import { Suggestions } from '../client/console/Suggestions';
import { newestExchange } from '../client/console/diomedes-view';
import type { Project, Turn } from '../shared/types';

// Slice 2 of the round 2 reskin on the Nectovia home (N1): the rail lists jobs in groups with a
// one line scope control for a business with more than one project, the ask box sits over the
// standing conversation's newest exchange with Earlier for the rest, and "Nectovia suggests"
// shows only real proposals.
const noAction = () => {};

function project(id: string, name: string): Project {
  return {
    id,
    name,
    folder: `C:/${id}`,
    createdAt: '',
    lastOpenedAt: '',
    plans: [],
    references: [],
    repository: { present: false },
    counts: { running: 0, changesWaiting: 0, waitingForYou: 0, historyToday: 0 },
    status: { needsYou: 0, working: 0, tasksDone: 0, tasksTotal: 0 },
  };
}

const turn = (id: string, role: Turn['role'], text: string): Turn => ({
  id,
  role,
  mode: 'ask',
  text,
  at: '2026-09-29T18:40:00.000Z',
  sources: [],
});

function page(patch: Partial<DiomedesPageProps> = {}): string {
  return renderToStaticMarkup(
    createElement(Diomedes, {
      projects: [],
      scopeId: null,
      onScope: noAction,
      turns: [],
      pending: false,
      restriction: 'automatic',
      onRestriction: noAction,
      onSend: async () => true,
      onStop: noAction,
      route: 'nectovia',
      unavailable: null,
      card: null,
      cardBusy: false,
      onCardAction: noAction,
      unconfirmed: null,
      onResend: noAction,
      onDiscard: noAction,
      notice: null,
      onReadAgain: null,
      results: [],
      onOpenResult: noAction,
      destinations: [],
      pinned: [],
      onDestination: noAction,
      onTogglePin: noAction,
      onNewProject: noAction,
      ...patch,
    }),
  );
}

describe('the scope control', () => {
  it('is absent for a business with one project, and the composer has no In box', () => {
    const html = page({ projects: [project('a', 'Kestrel service')] });
    expect(html).not.toContain('aria-label="Project"');
    expect(html).not.toContain('aria-label="In"');
  });

  it('is one line at the top of the rail for a business with more than one project', () => {
    const html = page({ projects: [project('a', 'Kestrel service'), project('b', 'Website')], scopeId: 'b' });
    const rail = html.match(/<nav class="rail"[\s\S]*?<\/nav>/)?.[0] ?? '';
    const control = rail.match(/<select aria-label="Project"[\s\S]*?<\/select>/)?.[0] ?? '';
    expect(control).not.toBe('');
    expect([...control.matchAll(/<option[^>]*>([^<]*)</g)].map((m) => m[1])).toEqual([
      'All projects',
      'Kestrel service',
      'Website',
    ]);
    // The scoped project is the one selected.
    expect(control).toMatch(/<option value="b" title="Website" selected="">/);
  });
});

describe('the rail lists jobs in groups', () => {
  it('draws each group with its count, and Finished folded', () => {
    const html = page({
      sections: [
        { id: 'needs', heading: 'Needs your input', count: 4, rows: [{ id: 'n1', name: 'Ribeye for tonight', sub: '$1,011.00 order', tone: 'attn' }] },
        { id: 'working', heading: 'Working', count: 1, rows: [{ id: 'w1', name: "Saturday's schedule", sub: 'Finding cover for Lena', tone: 'live' }] },
        { id: 'finished', heading: 'Finished', count: 6, rows: [{ id: 'f1', name: 'Weekly brief', sub: 'Sent at 7:00 AM' }] },
      ],
    });
    expect(html).toContain('aria-label="Needs your input"');
    expect(html).toMatch(/Needs your input<\/span><span class="ct mono">4<\/span>/);
    expect(html).toContain('Ribeye for tonight');
    expect(html).toContain("Saturday&#x27;s schedule");
    // Finished starts folded: its heading and count show, its rows wait.
    expect(html).toMatch(/aria-expanded="false"[^>]*>[\s\S]*?Finished<\/span><span class="ct mono">6</);
    expect(html).not.toContain('Weekly brief');
    // No project spine any more: the rows are jobs.
    expect(html).not.toContain('Your main conversation');
  });

  it('draws no group at all for a quiet scope', () => {
    expect(page({ sections: [] })).not.toContain('class="rail-group"');
  });
});

describe('the ask box over the newest exchange', () => {
  const turns = [
    turn('1', 'you', 'What were Monday covers?'),
    turn('2', 'diomedes', 'You had 193 covers.'),
    turn('3', 'you', 'Find cover for Lena on Saturday.'),
    turn('4', 'diomedes', 'Devon can cover.'),
  ];

  it('finds where the newest exchange starts', () => {
    expect(newestExchange([])).toBe(0);
    expect(newestExchange(turns.slice(0, 2))).toBe(0);
    expect(newestExchange(turns)).toBe(2);
    expect(newestExchange([turn('a', 'diomedes', 'Hello.')])).toBe(0);
  });

  it('shows the newest exchange under the ask box, with Earlier for the rest', () => {
    const html = page({ turns });
    expect(html).toContain('>Earlier</button>');
    expect(html).not.toContain('What were Monday covers?');
    expect(html).toContain('Find cover for Lena on Saturday.');
    expect(html).toContain('Devon can cover.');
    expect(html.indexOf('aria-label="Message Nectovia"')).toBeLessThan(html.indexOf('Find cover for Lena'));
  });

  it('draws no Earlier when there is only one exchange', () => {
    expect(page({ turns: turns.slice(0, 2) })).not.toContain('>Earlier</button>');
  });

  it('puts the pinned chart above the ask box', () => {
    const html = page({ turns, chart: createElement('section', { 'aria-label': 'Pinned chart' }) });
    expect(html.indexOf('aria-label="Pinned chart"')).toBeLessThan(html.indexOf('aria-label="Message Nectovia"'));
  });
});

describe('Nectovia suggests', () => {
  const item = {
    taskId: 't1',
    projectId: 'a',
    name: 'Set up a check on both walk-ins',
    line: 'Walk-in 2 ran warm twice this month.',
    revision: 2,
  };
  const draw = (items: (typeof item)[], busyId: string | null = null, error: string | null = null) =>
    renderToStaticMarkup(createElement(Suggestions, { items, busyId, error, onAccept: noAction, onNotNow: noAction }));

  it('is absent when nothing was proposed', () => {
    expect(draw([])).toBe('');
  });

  it('offers Accept and Not now on each real proposal, and never Start it', () => {
    const html = draw([item]);
    expect(html).toContain('Nectovia suggests');
    expect(html).toContain('Set up a check on both walk-ins');
    expect(html).toContain('Walk-in 2 ran warm twice this month.');
    expect(html).toContain('>Accept</button>');
    expect(html).toContain('>Not now</button>');
    expect(html).not.toContain('Start it');
  });

  it('says Accepting while it waits, and says plainly when it failed', () => {
    expect(draw([item], 't1')).toContain('>Accepting</button>');
    expect(draw([item], null, 'This task is not waiting in the Inbox.')).toContain('role="alert"');
  });
});
