import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { HomeArt } from '../client/console/HomeArt';
import { HomeBrief } from '../client/console/HomeBrief';
import {
  BRIEF_ROWS,
  briefDate,
  countWord,
  greetingFor,
  homeBrief,
  quietLine,
} from '../client/console/home-brief';
import {
  BAND_EDGES,
  BAND_OFFSETS,
  BAND_STEPS,
  SIGNATURE_BANDS,
  SIGNATURE_END,
  SIGNATURE_KEY,
  SIGNATURE_MS,
  takeSignature,
} from '../client/console/home-signature';
import { motionAllowed, readMotionFacts, type MotionFacts } from '../client/console/nectovia-motion';
import type { Project } from '../shared/types';

// The agent home's report and signature (Home.dc.html). The report is a pure
// view model over each project's own status record; the signature is a
// once-per-session decision over the motion settings. Both are tested here
// directly, and the two components are rendered statically.

const at = '2026-09-22T08:00:00.000Z';

function project(
  id: string,
  status: Partial<Project['status']> = {},
  over: Partial<Project> = {},
): Project {
  return {
    id,
    name: `Project ${id}`,
    folder: `C:/work/${id}`,
    createdAt: at,
    lastOpenedAt: at,
    plans: [],
    references: [],
    repository: { present: false },
    counts: { running: 0, changesWaiting: 0, waitingForYou: 0, historyToday: 0 },
    status: { needsYou: 0, working: 0, tasksDone: 0, tasksTotal: 0, ...status },
    ...over,
  };
}

const morning = new Date(2026, 8, 22, 8, 27);
const DASH_OR_BANG = /[\u2012\u2013\u2014\u2015!]/;

describe('the report in plain words', () => {
  it('says small counts as words and larger ones as figures', () => {
    expect([0, 1, 2, 10].map(countWord)).toEqual(['No', 'One', 'Two', 'Ten']);
    expect(countWord(11)).toBe('11');
    expect(countWord(2.5)).toBe('2.5');
    expect(countWord(-1)).toBe('-1');
  });

  it('greets by the hour, with the day changing at five in the morning', () => {
    expect(greetingFor(4)).toBe('Good evening.');
    expect(greetingFor(5)).toBe('Good morning.');
    expect(greetingFor(11)).toBe('Good morning.');
    expect(greetingFor(12)).toBe('Good afternoon.');
    expect(greetingFor(17)).toBe('Good afternoon.');
    expect(greetingFor(18)).toBe('Good evening.');
    expect(greetingFor(0)).toBe('Good evening.');
  });

  it('dates the report in the person\u2019s locale, the way the canvas prints it', () => {
    expect(briefDate(morning, 'en-GB')).toBe('Tuesday 22 September \u00b7 08:27');
  });

  it('reports what needs the person first, then running work, then finished lists', () => {
    const model = homeBrief(
      [
        project('done', { tasksDone: 4, tasksTotal: 4 }),
        project('quiet', { tasksDone: 1, tasksTotal: 3 }),
        project('one-need', { needsYou: 1, tasksDone: 1, tasksTotal: 5 }),
        project('running', { working: 1 }),
        project('two-needs', { needsYou: 2, working: 1 }),
        project('gone', { needsYou: 3 }, { missing: true }),
      ],
      morning,
      'en-GB',
    );
    expect(model.rows.map((row) => [row.projectId, row.state, row.label])).toEqual([
      ['two-needs', 'attn', 'Needs you'],
      ['one-need', 'attn', 'Needs you'],
      ['running', 'live', 'Working'],
      ['done', 'done', 'Done'],
    ]);
    expect(model.rows.map((row) => row.sentence)).toEqual([
      'Two things are waiting on you.',
      'One thing is waiting on you.',
      'One run is working now.',
      'All four tasks are done.',
    ]);
    // A missing project is not reported, and a project with nothing to say is quiet.
    expect(model.quiet).toBe(1);
    expect(model.more).toBe(0);
    expect(model.greeting).toBe('Good morning.');
    expect(model.accent).toBe('Three things need you.');
  });

  it('draws a bar only from a counted task tally, never an invented one', () => {
    const model = homeBrief(
      [project('counted', { needsYou: 1, tasksDone: 2, tasksTotal: 5 }), project('uncounted', { working: 2 })],
      morning,
    );
    expect(model.rows[0].progress).toEqual({
      total: 5,
      done: 2,
      running: false,
      blocked: true,
      noun: 'tasks done',
    });
    expect(model.rows[1].progress).toBeNull();
  });

  it('says what most needs saying in the accent phrase', () => {
    const accent = (projects: Project[]) => homeBrief(projects, morning).accent;
    expect(accent([project('a', { needsYou: 1, working: 3 })])).toBe('One thing needs you.');
    expect(accent([project('a', { working: 2 })])).toBe('Two runs are working.');
    expect(accent([project('a', { working: 1 })])).toBe('One run is working.');
    expect(accent([project('a', { tasksDone: 2, tasksTotal: 2 })])).toBe(
      'Every task on your lists is done.',
    );
    expect(accent([project('a', { tasksDone: 1, tasksTotal: 2 })])).toBe('Nothing is waiting on you.');
    expect(accent([])).toBe('Nothing is waiting on you.');
  });

  it('keeps the report short and says how many projects it left out', () => {
    const busy = Array.from({ length: BRIEF_ROWS + 2 }, (_, i) => project(`p${i}`, { working: 1 }));
    const model = homeBrief([...busy, project('still')], morning);
    expect(model.rows).toHaveLength(BRIEF_ROWS);
    expect(model.more).toBe(2);
    expect(model.quiet).toBe(1);
    expect(quietLine(model)).toBe(
      'Two more projects have something to report. One other project is quiet.',
    );
    expect(quietLine({ more: 1, quiet: 0 })).toBe('One more project has something to report.');
    expect(quietLine({ more: 0, quiet: 3 })).toBe('Three projects are quiet.');
    expect(quietLine({ more: 0, quiet: 0 })).toBeNull();
  });

  it('writes every sentence without dashes or exclamation marks', () => {
    const lines: string[] = [];
    for (const n of [1, 2, 11]) {
      for (const status of [
        { needsYou: n },
        { working: n },
        { tasksDone: n, tasksTotal: n },
      ]) {
        const model = homeBrief([project('x', status), project('y')], new Date(2026, 8, 22, n + 6));
        lines.push(model.greeting, model.accent, ...model.rows.flatMap((r) => [r.label, r.sentence]));
        lines.push(quietLine(model) ?? '', quietLine({ more: n, quiet: n }) ?? '');
      }
    }
    expect(lines.filter((line) => DASH_OR_BANG.test(line))).toEqual([]);
  });
});

describe('the signature decision', () => {
  const still: MotionFacts = { reducedSetting: false, reducedQuery: false, presetNone: false, intensity: 0.5 };

  function memoryStore() {
    const items = new Map<string, string>();
    return {
      items,
      getItem: (key: string) => items.get(key) ?? null,
      setItem: (key: string, value: string) => void items.set(key, value),
    };
  }

  it('plays once a session, and only while motion is allowed', () => {
    const store = memoryStore();
    expect(takeSignature(store, still)).toBe(true);
    expect(store.items.get(SIGNATURE_KEY)).toBe('1');
    expect(takeSignature(store, still)).toBe(false);
  });

  it('never plays, and never spends the session, when stillness is asked for in any form', () => {
    for (const facts of [
      { ...still, reducedSetting: true },
      { ...still, reducedQuery: true },
      { ...still, presetNone: true },
      { ...still, intensity: 0 },
      { ...still, intensity: Number.NaN },
    ]) {
      const store = memoryStore();
      expect(motionAllowed(facts)).toBe(false);
      expect(takeSignature(store, facts)).toBe(false);
      expect(store.items.size).toBe(0);
    }
  });

  it('treats storage that is missing or failing as already seen', () => {
    expect(takeSignature(null, still)).toBe(false);
    const broken = {
      getItem: () => null,
      setItem: () => {
        throw new Error('quota');
      },
    };
    expect(takeSignature(broken, still)).toBe(false);
  });

  it('reads anything it cannot read as stillness', () => {
    // No document here: the facts come back as stillness.
    expect(motionAllowed(readMotionFacts())).toBe(false);
  });

  it('keeps the contract\u2019s shape: 4 to 6 bands, 8 to 24 px, 900 to 1450 ms', () => {
    expect(SIGNATURE_BANDS).toBeGreaterThanOrEqual(4);
    expect(SIGNATURE_BANDS).toBeLessThanOrEqual(6);
    expect(BAND_OFFSETS).toHaveLength(SIGNATURE_BANDS);
    for (const offset of BAND_OFFSETS) {
      expect(Math.abs(offset)).toBeGreaterThanOrEqual(8);
      expect(Math.abs(offset)).toBeLessThanOrEqual(24);
    }
    expect(BAND_EDGES).toHaveLength(SIGNATURE_BANDS + 1);
    expect(BAND_EDGES[0]).toBe(0);
    expect(BAND_EDGES.at(-1)).toBe(100);
    for (let i = 1; i < BAND_EDGES.length; i += 1) expect(BAND_EDGES[i]).toBeGreaterThan(BAND_EDGES[i - 1]);
    expect([...BAND_STEPS].sort()).toEqual(Array.from({ length: SIGNATURE_BANDS }, (_, i) => i));
    expect(SIGNATURE_MS).toBeGreaterThanOrEqual(900);
    expect(SIGNATURE_MS).toBeLessThanOrEqual(1450);
  });

  it('draws it with the clock and properties the contract allows', () => {
    const css = readFileSync('client/console/nectovia.css', 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    const ms = (name: string) => {
      const found = css.match(new RegExp(`${name}:\\s*(\\d+)ms;`));
      expect(found, name).not.toBeNull();
      return Number(found![1]);
    };
    const band = ms('--nv-sig-band');
    const step = ms('--nv-sig-step');
    const rest = ms('--nv-sig-rest');
    // A's resolve is the whole signature, and every band lands inside it.
    expect(rest).toBe(SIGNATURE_MS);
    expect(band + step * (SIGNATURE_BANDS - 1)).toBeLessThanOrEqual(rest);
    // Every frame of it moves only transforms, opacity and clip-path.
    for (const name of ['nv-band-in', 'nv-ghost', SIGNATURE_END, 'nv-horizon-in', 'nv-reg-in']) {
      const block = css.match(new RegExp(`@keyframes ${name} \\{([\\s\\S]*?)\\n\\}`));
      expect(block, name).not.toBeNull();
      const properties = [...block![1].matchAll(/([a-z-]+)\s*:/g)].map((m) => m[1]);
      expect(properties.length, name).toBeGreaterThan(0);
      expect(properties.filter((p) => !['transform', 'opacity', 'clip-path'].includes(p)), name).toEqual([]);
    }
    // Each of its animations is on the fractured-signal ease (the mark's two
    // frames are a cut, not an ease) and stops when motion intensity is 0.
    const uses = [...css.matchAll(/animation:\s*(nv-(?:band-in|ghost|rest-in|horizon-in|reg-in))\s([^;]+);/g)];
    expect(uses.map((m) => m[1]).sort()).toEqual(
      ['nv-band-in', 'nv-ghost', 'nv-horizon-in', 'nv-reg-in', 'nv-rest-in'].sort(),
    );
    for (const [, name, rest] of uses) {
      expect(rest, name).toContain('var(--nv-on)');
      if (name !== 'nv-reg-in') expect(rest, name).toContain('var(--nv-ease)');
    }
  });
});

describe('the home, rendered', () => {
  const projects = [
    project('laundry', { needsYou: 1, working: 1, tasksDone: 3, tasksTotal: 5 }, { name: 'Linen and laundry' }),
    project('ordering', { tasksDone: 4, tasksTotal: 4 }, { name: 'Weekly ordering' }),
    project('staff', {}, { name: 'Staff schedule' }),
  ];

  it('reads as a greeting and a report, with real progress bars and a way into each project', () => {
    const html = renderToStaticMarkup(
      createElement(HomeBrief, { projects, onOpen: () => undefined, now: morning }),
    );
    expect(html).toContain(
      '<h2 class="nv-greeting">Good morning. <span class="nv-accent">One thing needs you.</span></h2>',
    );
    // Named by its heading only, not a second landmark with the same name.
    expect(html).toContain('<section class="nv-report"><h3>Across your projects</h3>');
    expect(html).toContain('aria-label="Open Linen and laundry"');
    expect(html).toContain('aria-label="Open Weekly ordering"');
    expect(html).not.toContain('Open Staff schedule');
    expect(html).toMatch(
      /role="progressbar" aria-label="Linen and laundry tasks" aria-valuemin="0" aria-valuemax="5" aria-valuenow="3"/,
    );
    expect(html).toMatch(/role="progressbar" aria-label="Weekly ordering tasks"[^>]*aria-valuenow="4"/);
    // The open project's bar is captioned; the finished one's sentence already says it.
    expect(html).toContain('3 of 5 tasks done');
    expect(html).not.toContain('4 of 4 tasks done</span>');
    expect(html).toContain('<p class="nv-quiet">One project is quiet.</p>');
  });

  it('draws only the resting bust when motion is not allowed, hidden from assistive technology', () => {
    // (React's server renderer puts an image preload hint ahead of the markup.)
    const html = renderToStaticMarkup(createElement(HomeArt));
    expect(html).toContain('<div class="nv-art" aria-hidden="true"><div class="nv-bust">');
    expect(html).not.toContain('nv-band');
    expect(html).not.toContain('signature');
    expect(html.match(/<img /g)).toHaveLength(1);
    expect(html).toContain('class="nv-rest"');
    expect(html).toContain('<span class="nv-horizon"><span class="nv-reg"></span></span>');
  });
});
