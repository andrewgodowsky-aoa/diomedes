import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import fs from 'node:fs';
import { Setup } from '../client/Setup.js';
import { DETAIL_WORDS, detailSample } from '../client/detail-words.js';
import { Wake } from '../client/console/Wake.js';
import { defaults } from '../server/store.js';
import type { Settings } from '../shared/types.js';

// First run and the waking screen as the round 2 boards draw them (D01 to D04, D06, D07). AI
// setup (D05) keeps today's screen inside the new frame, so it isn't rendered here.

function at(step: Settings['onboarding']['resumeAt'], patch: Partial<Settings> = {}): string {
  const base = defaults();
  const settings: Settings = { ...base, ...patch, onboarding: { ...base.onboarding, resumeAt: step } };
  return renderToStaticMarkup(createElement(Setup, { settings, save: async () => {}, busy: false }));
}

/** What a reader sees: the markup's text, with React's escapes undone. */
const words = (markup: string) =>
  markup
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ');

/** The copy rules every reader-facing string keeps. */
function plain(text: string) {
  expect(text).not.toMatch(/[–—!]/);
  expect(text).not.toMatch(/\s-\s/);
}

describe('first run', () => {
  it('welcomes a new person and says what Nectovia is for', () => {
    const text = words(at('welcome'));
    expect(text).toContain('Welcome to Nectovia');
    expect(text).toContain('Hand it a problem, a job or a whole project, and it does the work.');
    expect(text).toContain('Continue');
    expect(text).not.toContain('history of');
    // Outside the account gate there is nobody to name and nothing to sign out of.
    expect(text).not.toContain('Signed in as');
    plain(text);
  });

  it('asks what the work is, with the five answers and a way past', () => {
    const text = words(at('q1'));
    expect(text).toContain('Question 1 of 3');
    expect(text).toContain('What are you here to work on?');
    for (const answer of ['Business', 'School and research', 'Software and technical work', 'Personal projects', 'A mix'])
      expect(text).toContain(answer);
    for (const action of ['Back', 'Skip for now', 'Continue']) expect(text).toContain(action);
    plain(text);
  });

  it('starts the detail question at Guided and shows how a finished job reads', () => {
    const markup = at('q2');
    const text = words(markup);
    expect(text).toContain('Question 2 of 3');
    expect(text).toContain('How much detail do you want?');
    expect(markup).toMatch(/<label class="setup-choice on"><input type="radio" name="detail" checked=""/);
    expect(text).toContain('Guided');
    expect(text).toContain(DETAIL_WORDS.guided);
    expect(text).toContain('How a finished job reads Sample');
    expect(text).toContain(detailSample('guided', ''));
    expect(text).toContain('Change it any time in Settings, under Interface detail.');
    plain(text);
    // A level the settings already hold is the one shown, with its own sample.
    const technical = at('q2', { detail: 'technical' });
    expect(technical).toMatch(/<label class="setup-choice on"><input type="radio" name="detail" checked=""[^>]*\/><span class="setup-check" aria-hidden="true"><svg[\s\S]*?<\/svg><\/span><span class="setup-choice-text"><strong>Technical</);
    expect(words(technical)).toContain(detailSample('technical', ''));
  });

  it('asks about file changes in two plain answers, starting at Ask me first', () => {
    const markup = at('q3');
    const text = words(markup);
    expect(text).toContain('Question 3 of 3');
    expect(text).toContain('Should Nectovia ask before it changes files?');
    expect(text).toContain('Ask me first A job waits for your OK before it changes files in a project.');
    expect(text).toContain("Don't ask A job changes files without waiting. Changes it proposes still wait for your review.");
    expect(text).toContain('Deleting files has its own switch in Settings, under Permissions.');
    expect(markup).toMatch(/<label class="setup-choice on"><input type="radio" name="file-changes" checked=""/);
    plain(text);
  });

  it('sums up the answers before opening Nectovia', () => {
    const text = words(at('ready'));
    expect(text).toContain("You're set up");
    for (const term of ['AI', 'Starts in', 'Detail', 'File changes']) expect(text).toContain(term);
    expect(text).toContain('None yet, so Nectovia shows sample work until you sign in to one.');
    expect(text).toContain('You can change any of these in Settings.');
    expect(text).toContain('Open Nectovia');
    plain(text);
  });
});

describe('the detail sample', () => {
  it('names an engine at Technical but never a model', () => {
    expect(detailSample('technical', '')).toBe(
      'The supplier price sheet is ready: 3 files changed in 4 minutes. Run 7f3a2c. It waits for your approval.',
    );
    expect(detailSample('technical', 'Claude Code')).toBe(
      'The supplier price sheet is ready: 3 files changed in 4 minutes. Claude Code, run 7f3a2c. It waits for your approval.',
    );
    for (const level of ['guided', 'standard', 'technical'] as const) plain(detailSample(level, 'Claude Code'));
  });
});

describe('the waking screen', () => {
  it("says it didn't finish opening, and how to go on", () => {
    const markup = renderToStaticMarkup(createElement(Wake, { failed: true, onDone: () => {}, onRetry: () => {} }));
    const text = words(markup);
    expect(markup).toContain('aria-label="Nectovia didn&#x27;t finish opening"');
    expect(text).toContain("Nectovia didn't finish opening.");
    expect(text).toContain('Try again');
    expect(text).toContain('If it happens again, close Nectovia and open it again.');
    plain(text);
  });

  it('shows nothing with reduced motion unless it failed', () => {
    expect(renderToStaticMarkup(createElement(Wake, { reduced: true, onDone: () => {} }))).toBe('');
  });

  it('speaks in plain words and counts no projects', () => {
    const source = fs.readFileSync(new URL('../client/console/Wake.tsx', import.meta.url), 'utf8');
    for (const line of ["'opening nectovia'", "'loading your projects'", "'ready'", "'reconnecting'", 'Press any key to skip'])
      expect(source).toContain(line);
    for (const old of ['recovering the field', 'restoring context', 'field established', 'field not reached', 'any key skips'])
      expect(source).not.toContain(old);
    const opening = words(renderToStaticMarkup(createElement(Wake, { projects: 4, onDone: () => {} })));
    expect(opening).not.toMatch(/\d/);
  });
});
