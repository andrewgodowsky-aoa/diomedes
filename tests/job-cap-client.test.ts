/**
 * The Console's job-cap decisions: the gate a send stops at before anything is
 * sent, the gate after a job stopped at its cap, and the dialog's markup.
 * Fakes only; the host's numbers are fixtures.
 */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, test, vi } from 'vitest';
import { afterStop, beforeSend, beforeWake, isJobCapStop, type CapChoice, type CapPrompt } from '../client/job-cap-gate';
import { ApiError } from '../client/api';
import { JobCapWarning } from '../client/console/JobCapWarning';
import {
  capWarningCopy,
  oneJobRaise,
  overrunCopy,
  type JobEstimate,
  type JobEstimateView,
  type JobStatusView,
  type JobTier,
} from '../shared/job-caps';
import { creditAmount } from '../shared/managed-usage';

const credits = (n: number) => creditAmount(n);

function view(tier: JobTier, likely: number | null): JobEstimateView {
  const cap = credits({ efficient: 20, focused: 50, thorough: 100 }[tier]);
  const estimate: JobEstimate =
    likely === null
      ? { kind: 'unknown', tier, capMicroUsd: cap, reason: 'No declared price.', warn: true }
      : {
          kind: 'estimate',
          tier,
          capMicroUsd: cap,
          lowMicroUsd: credits(1),
          likelyMicroUsd: credits(likely),
          worstMicroUsd: credits(likely * 3),
          likelyExceeds: credits(likely) > cap,
          worstExceeds: credits(likely * 3) > cap,
          warn: credits(likely) > cap,
          basis: '',
        };
  const raised = oneJobRaise({ tier, capMicroUsd: cap, neededMicroUsd: likely === null ? null : credits(likely) });
  return { estimate, warning: estimate.warn ? capWarningCopy(estimate, raised) : null, note: null, raisedToMicroUsd: raised };
}

/** A person who answers each question in turn, and a record of what they were shown. */
function person(...answers: CapChoice[]) {
  const shown: CapPrompt[] = [];
  return {
    shown,
    ask: async (prompt: CapPrompt) => {
      shown.push(prompt);
      const next = answers.shift();
      if (!next) throw new Error('Asked more than expected.');
      return next;
    },
  };
}

describe('before a send', () => {
  test('an estimate that does not warn sends at once, and asks nothing', async () => {
    const who = person();
    const goOver = vi.fn();
    const result = await beforeSend({ estimate: async () => view('focused', 30), ask: who.ask, upgrade: vi.fn(), goOver, mint: () => 'cmd-x' });
    expect(result).toEqual({ send: true });
    expect(who.shown).toHaveLength(0);
    expect(goOver).not.toHaveBeenCalled();
  });

  test('Cancel sends nothing and records nothing', async () => {
    const who = person('cancel');
    const goOver = vi.fn();
    const upgrade = vi.fn();
    expect(await beforeSend({ estimate: async () => view('focused', 60), ask: who.ask, upgrade, goOver, mint: () => 'cmd-x' })).toEqual({ send: false });
    expect(who.shown[0].copy.body).toBe('This will likely use about 60 credits. Focused jobs are capped at 50.');
    expect(goOver).not.toHaveBeenCalled();
    expect(upgrade).not.toHaveBeenCalled();
  });

  test('"Go over this once" records the raise for the one command id the message is then sent under', async () => {
    const who = person('over');
    const goOver = vi.fn(async () => undefined);
    const result = await beforeSend({ estimate: async () => view('focused', 60), ask: who.ask, upgrade: vi.fn(), goOver, mint: () => 'cmd-raised' });
    expect(goOver).toHaveBeenCalledWith('cmd-raised');
    expect(result).toEqual({ send: true, commandId: 'cmd-raised' });
  });

  test('"Use Thorough" moves the thread up a tier and estimates again under it', async () => {
    let tier: JobTier = 'focused';
    const who = person('upgrade');
    const upgrade = vi.fn(async (next: JobTier) => {
      tier = next;
    });
    const result = await beforeSend({ estimate: async () => view(tier, 60), ask: who.ask, upgrade, goOver: vi.fn(), mint: () => 'cmd-x' });
    expect(upgrade).toHaveBeenCalledWith('thorough');
    expect(who.shown[0].copy.upgrade?.label).toBe('Use Thorough');
    // Sixty credits fits Thorough's hundred: sent as an ordinary job, no raise.
    expect(result).toEqual({ send: true });
  });

  test('when the higher tier still warns it asks again, with no tier above Thorough to offer', async () => {
    let tier: JobTier = 'focused';
    const who = person('upgrade', 'cancel');
    const result = await beforeSend({
      estimate: async () => view(tier, 150),
      ask: who.ask,
      upgrade: async (next) => {
        tier = next;
      },
      goOver: vi.fn(),
      mint: () => 'cmd-x',
    });
    expect(result).toEqual({ send: false });
    expect(who.shown.map((prompt) => prompt.copy.upgrade?.label ?? null)).toEqual(['Use Thorough', null]);
  });

  test('an estimate nobody can make still asks', async () => {
    const who = person('cancel');
    await beforeSend({ estimate: async () => view('efficient', null), ask: who.ask, upgrade: vi.fn(), goOver: vi.fn(), mint: () => 'x' });
    expect(who.shown[0].copy.body).toMatch(/can't estimate this job/);
  });

  test('a team wake maps the same choices onto waking, waking over the cap, or not waking', async () => {
    expect(await beforeWake({ estimate: async () => view('focused', 10), ask: person().ask, upgrade: vi.fn() })).toBe('wake');
    expect(await beforeWake({ estimate: async () => view('focused', 60), ask: person('over').ask, upgrade: vi.fn() })).toBe('over');
    expect(await beforeWake({ estimate: async () => view('focused', 60), ask: person('cancel').ask, upgrade: vi.fn() })).toBe('cancel');
  });
});

describe('after a job stopped at its cap', () => {
  const stopped = (tier: JobTier): JobStatusView => ({
    jobId: 'cmd-1',
    tier,
    capMicroUsd: credits(50),
    raised: false,
    stop: { usedMicroUsd: credits(45), capMicroUsd: credits(50), neededMicroUsd: credits(57), consumed: false },
    overrun: overrunCopy({ tier, capMicroUsd: credits(50), usedMicroUsd: credits(45), raisedToMicroUsd: credits(100) }),
  });

  test('"Go over this once" raises one new job from the recorded stop and resends under it', async () => {
    const goOverAfter = vi.fn(async () => undefined);
    const who = person('over');
    const result = await afterStop({ status: async () => stopped('focused'), ask: who.ask, upgrade: vi.fn(), goOverAfter, mint: () => 'cmd-2' });
    expect(who.shown[0]).toMatchObject({ kind: 'overrun', copy: { title: 'This job reached its cap' } });
    expect(goOverAfter).toHaveBeenCalledWith('cmd-2');
    expect(result).toEqual({ send: true, commandId: 'cmd-2' });
  });

  test('"Use Thorough" moves the tier and resends as a new job through the whole send', async () => {
    const upgrade = vi.fn(async () => undefined);
    const result = await afterStop({ status: async () => stopped('focused'), ask: person('upgrade').ask, upgrade, goOverAfter: vi.fn(), mint: () => 'x' });
    expect(upgrade).toHaveBeenCalledWith('thorough');
    expect(result).toEqual({ send: true });
  });

  test('Cancel, or a job with no open stop, sends nothing', async () => {
    expect(await afterStop({ status: async () => stopped('focused'), ask: person('cancel').ask, upgrade: vi.fn(), goOverAfter: vi.fn(), mint: () => 'x' })).toEqual({ send: false });
    const noStop = { ...stopped('focused'), stop: null, overrun: null };
    expect(await afterStop({ status: async () => noStop, ask: person().ask, upgrade: vi.fn(), goOverAfter: vi.fn(), mint: () => 'x' })).toEqual({ send: false });
  });

  test('only the host\'s job-cap refusal counts as a stop', () => {
    expect(isJobCapStop(new ApiError('stop', 402, { code: 'job_cap_reached' }))).toBe(true);
    expect(isJobCapStop(new ApiError('limit', 503, { code: 'SPEND_LIMIT' }))).toBe(false);
    expect(isJobCapStop(new Error('job_cap_reached'))).toBe(false);
  });
});

describe('the dialog', () => {
  const copy = capWarningCopy(view('focused', 60).estimate, credits(100));
  const render = (shown = copy) =>
    renderToStaticMarkup(
      createElement(JobCapWarning, { copy: shown, inline: true, onUpgrade: () => {}, onGoOver: () => {}, onCancel: () => {} }),
    );

  test('is an alert dialog described by its plain sentence, with the three choices', () => {
    const html = render();
    expect(html).toContain('role="alertdialog"');
    const described = /aria-describedby="([^"]+)"/.exec(html)?.[1];
    expect(described).toBeTruthy();
    expect(html).toContain(`id="${described}"`);
    expect(html).toContain('This will likely use about 60 credits. Focused jobs are capped at 50.');
    const buttons = [...html.matchAll(/<button[^>]*>([^<]*)<\/button>/g)].map((match) => match[1]).filter(Boolean);
    expect(buttons).toEqual(['Cancel', 'Go over this once', 'Use Thorough']);
    // Cancel, the choice that spends nothing, takes focus first.
    expect(html).toMatch(/<button[^>]*autofocus[^>]*>Cancel<\/button>/i);
  });

  test('offers no higher tier where none exists', () => {
    const html = render(capWarningCopy(view('thorough', 150).estimate, credits(200)));
    expect(html).not.toContain('Use ');
    expect(html).toContain('Go over this once');
  });
});
