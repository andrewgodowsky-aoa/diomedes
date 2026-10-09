/**
 * The Console's job-cap decisions: the gate a send stops at before anything is
 * sent, the check-in after a job stopped at its amount (Keep going or Stop here),
 * and the dialog's markup. Fakes only; the host's numbers are fixtures.
 */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, test, vi } from 'vitest';
import { afterStop, beforeSend, beforeWake, isJobCapStop, type CapChoice, type CapPrompt } from '../client/job-cap-gate';
import { ApiError } from '../client/api';
import { JobCapWarning } from '../client/console/JobCapWarning';
import {
  capWarningCopy,
  checkInCopy,
  oneJobRaise,
  type JobEstimate,
  type JobEstimateView,
  type JobStatusView,
  type JobTier,
} from '../shared/job-caps';
import { creditAmount } from '../shared/managed-usage';

const credits = (n: number) => creditAmount(n);

function view(tier: JobTier, likely: number | null): JobEstimateView {
  const cap = credits({ efficient: 100, focused: 250, thorough: 500, expert: 750 }[tier]);
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
  const raised = oneJobRaise({ capMicroUsd: cap, checkInMicroUsd: cap });
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
    const result = await beforeSend({ estimate: async () => view('focused', 100), ask: who.ask, upgrade: vi.fn(), goOver, mint: () => 'cmd-x' });
    expect(result).toEqual({ send: true });
    expect(who.shown).toHaveLength(0);
    expect(goOver).not.toHaveBeenCalled();
  });

  test('Cancel sends nothing and records nothing', async () => {
    const who = person('cancel');
    const goOver = vi.fn();
    const upgrade = vi.fn();
    expect(await beforeSend({ estimate: async () => view('focused', 300), ask: who.ask, upgrade, goOver, mint: () => 'cmd-x' })).toEqual({ send: false });
    expect(who.shown[0].copy.body).toBe('This will likely use about 300 credits. Focused jobs check in at 250 credits.');
    expect(who.shown[0].copy.raise).toBe('Going over lets this job use 500 credits before it checks in, for this job only.');
    expect(goOver).not.toHaveBeenCalled();
    expect(upgrade).not.toHaveBeenCalled();
  });

  test('"Go over this once" records the raise for the one command id the message is then sent under', async () => {
    const who = person('over');
    const goOver = vi.fn(async () => undefined);
    const result = await beforeSend({ estimate: async () => view('focused', 300), ask: who.ask, upgrade: vi.fn(), goOver, mint: () => 'cmd-raised' });
    expect(goOver).toHaveBeenCalledWith('cmd-raised');
    expect(result).toEqual({ send: true, commandId: 'cmd-raised' });
  });

  test('"Use Thorough" moves the thread up a tier and estimates again under it', async () => {
    let tier: JobTier = 'focused';
    const who = person('upgrade');
    const upgrade = vi.fn(async (next: JobTier) => {
      tier = next;
    });
    const result = await beforeSend({ estimate: async () => view(tier, 300), ask: who.ask, upgrade, goOver: vi.fn(), mint: () => 'cmd-x' });
    expect(upgrade).toHaveBeenCalledWith('thorough');
    expect(who.shown[0].copy.upgrade?.label).toBe('Use Thorough');
    // Three hundred credits fits Thorough's five hundred: sent as an ordinary job, no raise.
    expect(result).toEqual({ send: true });
  });

  test('when the higher tier still warns it asks again, with no tier above Thorough to offer', async () => {
    let tier: JobTier = 'focused';
    const who = person('upgrade', 'cancel');
    const result = await beforeSend({
      estimate: async () => view(tier, 750),
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
    expect(await beforeWake({ estimate: async () => view('focused', 300), ask: person('over').ask, upgrade: vi.fn() })).toBe('over');
    expect(await beforeWake({ estimate: async () => view('focused', 300), ask: person('cancel').ask, upgrade: vi.fn() })).toBe('cancel');
  });
});

describe('at a job\'s check-in', () => {
  const stopped = (tier: JobTier): JobStatusView => ({
    jobId: 'cmd-1',
    tier,
    capMicroUsd: credits(250),
    checkInMicroUsd: credits(250),
    raised: false,
    stop: { usedMicroUsd: credits(225), capMicroUsd: credits(250), neededMicroUsd: credits(285), consumed: false },
    overrun: checkInCopy({ capMicroUsd: credits(250), checkInMicroUsd: credits(250) }),
  });

  test('Keep going raises one new job from the recorded stop and resends under it', async () => {
    const goOverAfter = vi.fn(async () => undefined);
    const who = person('over');
    const result = await afterStop({ status: async () => stopped('focused'), ask: who.ask, upgrade: vi.fn(), goOverAfter, mint: () => 'cmd-2' });
    expect(who.shown[0]).toMatchObject({
      kind: 'overrun',
      copy: {
        title: 'This job has used 250 credits. Keep going?',
        raise: 'It can use 250 more before it checks in again.',
        actions: { goOver: 'Keep going', cancel: 'Stop here' },
      },
    });
    expect(goOverAfter).toHaveBeenCalledWith('cmd-2');
    expect(result).toEqual({ send: true, commandId: 'cmd-2' });
  });

  test('a check-in offers no higher tier, so there is nothing to move up to', async () => {
    const upgrade = vi.fn(async () => undefined);
    const who = person('upgrade');
    // Even a client that answered "upgrade" cannot move the job: the copy carries no tier to move to.
    const result = await afterStop({ status: async () => stopped('focused'), ask: who.ask, upgrade, goOverAfter: vi.fn(), mint: () => 'x' });
    expect(who.shown[0].copy.upgrade).toBeNull();
    expect(upgrade).not.toHaveBeenCalled();
    expect(result).toEqual({ send: false });
  });

  test('Stop here, or a job with no open stop, sends nothing and spends nothing more', async () => {
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
  const copy = capWarningCopy(view('focused', 300).estimate, credits(500));
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
    expect(html).toContain('This will likely use about 300 credits. Focused jobs check in at 250 credits.');
    const buttons = [...html.matchAll(/<button[^>]*>([^<]*)<\/button>/g)].map((match) => match[1]).filter(Boolean);
    expect(buttons).toEqual(['Cancel', 'Go over this once', 'Use Thorough']);
    // Cancel, the choice that spends nothing, takes focus first.
    expect(html).toMatch(/<button[^>]*autofocus[^>]*>Cancel<\/button>/i);
  });

  test('offers no higher tier where none exists', () => {
    const html = render(capWarningCopy(view('thorough', 750).estimate, credits(1000)));
    expect(html).not.toContain('Use ');
    expect(html).toContain('Go over this once');
  });

  test('a check-in reads Stop here and Keep going, with its sentence as the question and no body or tier', () => {
    const html = render(checkInCopy({ capMicroUsd: credits(250), checkInMicroUsd: credits(250) }));
    expect(html).toContain('This job has used 250 credits. Keep going?');
    expect(html).toContain('It can use 250 more before it checks in again.');
    const buttons = [...html.matchAll(/<button[^>]*>([^<]*)<\/button>/g)].map((match) => match[1]).filter(Boolean);
    expect(buttons).toEqual(['Stop here', 'Keep going']);
    // The choice that spends nothing takes focus first, and the dialog is described by the line under the question.
    expect(html).toMatch(/<button[^>]*autofocus[^>]*>Stop here<\/button>/i);
    expect(html).not.toContain('Use ');
    expect(html).not.toContain('class="prose"');
    const described = /aria-describedby="([^"]+)"/.exec(html)?.[1];
    expect(html).toContain(`id="${described}"`);
  });
});
