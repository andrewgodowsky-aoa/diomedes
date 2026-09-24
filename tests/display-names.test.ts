import { describe, expect, it } from 'vitest';
import { clip, planTitle, shortTitle, taskNameFromText } from '../shared/display-names';
import { outputName } from '../shared/packs';

describe('names made from a person\'s words', () => {
  it('keeps a short first line whole', () => {
    expect(taskNameFromText('Count pumpkin puree before Saturday\nmore detail')).toBe(
      'Count pumpkin puree before Saturday',
    );
  });

  it('ends a long task name on a clause or sentence, never mid-thought', () => {
    // The 0.1.11 demo made "Using this plan, write catering/replies-draft.md: a short, friendly reply to".
    expect(
      taskNameFromText(
        'Using this plan, write catering/replies-draft.md: a short, friendly reply to each of the three inquiries with the prices from the plan. Sign each one.',
      ),
    ).toBe('Using this plan, write catering/replies-draft.md');
    expect(
      taskNameFromText(
        'Draft the Friday order. Then compare it with the last four weeks of sales and list every pastry that sold out before nine.',
      ),
    ).toBe('Draft the Friday order');
  });

  it('marks a word cut with an ellipsis and stays within the limit', () => {
    const long = 'word '.repeat(40).trim();
    const name = shortTitle(long, 80);
    expect(name.endsWith('word…')).toBe(true);
    expect(name.length).toBeLessThanOrEqual(80);
    expect(clip('short', 10)).toBe('short');
    expect(clip('one two three four', 12)).toBe('one two…');
  });

  it('names a plan after its thread, and never mangles a path into the file name', () => {
    expect(
      planTitle({ threadName: 'Catering quotes for the three open inquiries', answer: '1. Plan', text: 'x' }),
    ).toBe('Catering quotes for the three open inquiries');
    // The 0.1.11 demo made "Three catering inquiries are waiting on a quote in cateringinquiries.md..md".
    const fromText = planTitle({
      threadName: 'New thread',
      answer: '1. Plan each quote',
      text: 'Quote the inquiries in catering/inquiries.md.',
    });
    expect(fromText).toBe('Quote the inquiries in catering inquiries');
    expect(planTitle({ threadName: null, answer: '# Reopening plan\n\n1. Call', text: 'x' })).toBe(
      'Reopening plan',
    );
    expect(planTitle({ threadName: '  ', answer: '', text: '???' })).toBe('New plan');
  });

  it('titles a brief with its output name, not the whole setup sentence', () => {
    expect(
      outputName('Weekly operations brief — Produce a recurring report: A Monday note on last week'),
    ).toBe('Weekly operations brief');
    expect(outputName('Weekly brief')).toBe('Weekly brief');
  });
});
