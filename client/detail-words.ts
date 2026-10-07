import type { Detail } from '../shared/types';

/** Each detail level as a person reads it, in the round 2 boards' words (C03 and D03). */
export const DETAIL_LABELS: Readonly<Record<Detail, string>> = {
  guided: 'Guided',
  standard: 'Standard',
  technical: 'Technical',
};

export const DETAIL_WORDS: Readonly<Record<Detail, string>> = {
  guided: 'Plain words, fewer numbers, and an explanation on everything that needs a decision.',
  standard: 'Plain words, plus counts, times and which kind of service did the work.',
  technical: 'Engines, models, logs, version numbers and developer tools where they apply.',
};

/**
 * One finished job as each level reports it (board D03), so the choice isn't a guess. Technical
 * names the engine the way that level does, but never a model: model names come from an engine's
 * catalogue, and a sample has no catalogue behind it. So it names the person's own default engine
 * when there is one, and the run alone when there isn't.
 */
export function detailSample(level: Detail, engine: string): string {
  if (level === 'guided')
    return 'The supplier price sheet is ready. Nothing goes to suppliers until you approve it.';
  if (level === 'standard')
    return "The supplier price sheet is ready: 3 files changed in 4 minutes, on Nectovia's own AI. It waits for your approval.";
  const run = engine ? `${engine}, run 7f3a2c.` : 'Run 7f3a2c.';
  return `The supplier price sheet is ready: 3 files changed in 4 minutes. ${run} It waits for your approval.`;
}
