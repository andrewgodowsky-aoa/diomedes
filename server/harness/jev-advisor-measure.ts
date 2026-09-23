/**
 * Measuring the preflight's false passes and false escalations, offline.
 *
 * Phase F asks for measured advisory behaviour, not an assumed one. What can be
 * measured without a paid call is the *policy*: given a model's answers, how
 * often do the thresholds and the deterministic rules together miss a request
 * that needed more care (a false pass), and how often do they ask for more
 * care than was needed (a false escalation)?
 *
 * Every example below is synthetic and every "model answer" is authored, some
 * of them deliberately wrong, to stand in for a model that is right most of
 * the time and confidently wrong some of it. These figures therefore say how
 * the policy behaves on answers of that shape. They say nothing about Jev's
 * real accuracy: that needs approved live calls on permitted, representative
 * examples, and is an owner decision.
 *
 * The transport is a fixture that declares itself scripted, so nothing here is
 * attributed to a model or charged to anyone.
 */
import type { EvaluationPort } from './evaluation-adapter.js';
import {
  createJevAdvisor,
  DEFAULT_PREFLIGHT_THRESHOLDS,
  type PreflightAdvice,
  type PreflightThresholds,
  type Workload,
} from './jev-advisor.js';
import { classifyTask, type TaskKind } from '../../shared/work-style.js';
import { advisedTaskKind } from './jev-advisor.js';

/** What a careful person would say each request needs. */
export interface PreflightLabels {
  readonly demanding: boolean;
  readonly missingEvidence: boolean;
  readonly needsClarification: boolean;
  readonly needsReview: boolean;
}

/** The authored stand-in for a model's answer, or an outage. */
export type SimulatedAnswer =
  | 'unavailable'
  | {
      readonly workload: Readonly<Record<Workload, number>>;
      readonly missing: number;
      readonly clarify: number;
      readonly review: number;
    };

export interface PreflightCase {
  readonly id: string;
  readonly intent: string;
  readonly sources: readonly string[];
  readonly labels: PreflightLabels;
  readonly simulated: SimulatedAnswer;
  /** Why an authored answer is wrong, where it is. */
  readonly note?: string;
}

const w = (lookup: number, extraction: number, planning: number, reasoning: number) => ({
  lookup,
  extraction,
  planning,
  reasoning,
});

/**
 * Local-business requests of the kind the product is sold for. Labels are the
 * author's judgment; `note` marks the answers authored to be wrong.
 */
export const SYNTHETIC_PREFLIGHT_CASES: readonly PreflightCase[] = [
  {
    id: 'hours-question',
    intent: 'What time do we open on Sunday?',
    sources: ['hours.md'],
    labels: { demanding: false, missingEvidence: false, needsClarification: false, needsReview: false },
    simulated: { workload: w(0.9, 0.05, 0.03, 0.02), missing: 0.05, clarify: 0.05, review: 0.05 },
  },
  {
    id: 'summarize-invoice',
    intent: 'Summarize the attached supplier invoice in three lines.',
    sources: ['invoice-march.pdf'],
    labels: { demanding: false, missingEvidence: false, needsClarification: false, needsReview: false },
    simulated: { workload: w(0.1, 0.85, 0.03, 0.02), missing: 0.1, clarify: 0.05, review: 0.15 },
  },
  {
    id: 'holiday-staffing',
    intent: 'Work out a staffing plan for the holiday weekend given the new opening hours.',
    sources: ['hours.md', 'rota.xlsx'],
    labels: { demanding: true, missingEvidence: false, needsClarification: false, needsReview: true },
    simulated: { workload: w(0.02, 0.08, 0.8, 0.1), missing: 0.15, clarify: 0.1, review: 0.85 },
  },
  {
    id: 'menu-costing',
    intent: 'Which of our dishes lose money once the new dairy prices are included?',
    sources: ['menu.xlsx'],
    labels: { demanding: true, missingEvidence: true, needsClarification: false, needsReview: true },
    simulated: { workload: w(0.02, 0.1, 0.13, 0.75), missing: 0.9, clarify: 0.1, review: 0.82 },
  },
  {
    id: 'reply-review',
    intent: 'Draft a polite reply to the two-star review about slow service.',
    sources: ['review.txt'],
    labels: { demanding: false, missingEvidence: false, needsClarification: false, needsReview: false },
    simulated: { workload: w(0.05, 0.88, 0.04, 0.03), missing: 0.08, clarify: 0.1, review: 0.3 },
  },
  {
    id: 'remodel-sequence',
    intent: 'Put the kitchen remodel tasks in an order that keeps the dining room open.',
    sources: ['remodel-scope.md'],
    labels: { demanding: true, missingEvidence: false, needsClarification: false, needsReview: true },
    simulated: { workload: w(0.02, 0.05, 0.85, 0.08), missing: 0.2, clarify: 0.15, review: 0.8 },
  },
  {
    id: 'vague-fix-it',
    intent: 'Can you sort out the thing with the schedule?',
    sources: [],
    labels: { demanding: false, missingEvidence: true, needsClarification: true, needsReview: false },
    simulated: { workload: w(0.5, 0.2, 0.2, 0.1), missing: 0.85, clarify: 0.9, review: 0.2 },
  },
  {
    id: 'tax-estimate',
    intent: 'Estimate our quarterly sales tax from last quarter’s takings.',
    sources: [],
    labels: { demanding: true, missingEvidence: true, needsClarification: false, needsReview: true },
    simulated: { workload: w(0.05, 0.15, 0.1, 0.7), missing: 0.92, clarify: 0.2, review: 0.15 },
    note: 'Authored wrong: a tax figure needs a second check, and the model says it does not.',
  },
  {
    id: 'allergen-check',
    intent: 'Check whether the new dessert menu lists every allergen correctly.',
    sources: ['desserts.md'],
    labels: { demanding: true, missingEvidence: false, needsClarification: false, needsReview: true },
    simulated: { workload: w(0.05, 0.3, 0.05, 0.6), missing: 0.3, clarify: 0.05, review: 0.95 },
    note: 'The reasoning share (0.6) sits exactly on the choice threshold.',
  },
  {
    id: 'thank-supplier',
    intent: 'Write a short thank-you note to our produce supplier.',
    sources: [],
    labels: { demanding: false, missingEvidence: false, needsClarification: false, needsReview: false },
    simulated: { workload: w(0.2, 0.75, 0.03, 0.02), missing: 0.1, clarify: 0.05, review: 0.05 },
  },
  {
    id: 'inventory-reorder',
    intent: 'List what we should reorder this week based on the stock count.',
    sources: ['stock-count.csv'],
    labels: { demanding: false, missingEvidence: false, needsClarification: false, needsReview: false },
    simulated: { workload: w(0.05, 0.7, 0.2, 0.05), missing: 0.85, clarify: 0.1, review: 0.35 },
    note: 'Authored wrong: the stock count is attached, yet the model says material is missing.',
  },
  {
    id: 'lease-renewal',
    intent: 'Should we renew the lease on the second location at the new rent?',
    sources: ['lease.pdf'],
    labels: { demanding: true, missingEvidence: true, needsClarification: false, needsReview: true },
    simulated: { workload: w(0.05, 0.1, 0.15, 0.7), missing: 0.75, clarify: 0.3, review: 0.9 },
    note: 'Missing evidence is authored at 0.75, inside the abstention band.',
  },
  {
    id: 'hiring-screen',
    intent: 'Rank these three line-cook applicants for an interview.',
    sources: ['applicants.md'],
    labels: { demanding: true, missingEvidence: false, needsClarification: false, needsReview: true },
    simulated: { workload: w(0.1, 0.65, 0.05, 0.2), missing: 0.1, clarify: 0.1, review: 0.9 },
    note: 'Authored wrong: the model calls a judgment task extraction.',
  },
  {
    id: 'daily-special',
    intent: 'Suggest a daily special using the leftover squash.',
    sources: [],
    labels: { demanding: false, missingEvidence: false, needsClarification: false, needsReview: false },
    simulated: { workload: w(0.1, 0.1, 0.1, 0.7), missing: 0.1, clarify: 0.1, review: 0.1 },
    note: 'Authored wrong: the model calls a light creative task reasoning.',
  },
  {
    id: 'payroll-change',
    intent: 'Move everyone’s pay date to Friday starting next month.',
    sources: [],
    labels: { demanding: false, missingEvidence: false, needsClarification: false, needsReview: true },
    simulated: { workload: w(0.3, 0.4, 0.25, 0.05), missing: 0.4, clarify: 0.3, review: 0.95 },
  },
  {
    id: 'catering-quote',
    intent: 'Prepare a catering quote for 80 guests with the usual margin.',
    sources: ['price-list.xlsx'],
    labels: { demanding: true, missingEvidence: false, needsClarification: false, needsReview: true },
    simulated: 'unavailable',
    note: 'An outage: the flow must continue on the deterministic path.',
  },
  {
    id: 'opening-hours-post',
    intent: 'Post our new winter hours as a short announcement.',
    sources: ['hours.md'],
    labels: { demanding: false, missingEvidence: false, needsClarification: false, needsReview: false },
    simulated: 'unavailable',
  },
  {
    id: 'forecast-long',
    intent: `Build a twelve-week sales forecast.\n${'Consider weather, events, school holidays and last year.\n'.repeat(14)}`,
    sources: ['sales-2025.csv'],
    labels: { demanding: true, missingEvidence: false, needsClarification: false, needsReview: true },
    simulated: { workload: w(0.05, 0.05, 0.3, 0.6), missing: 0.2, clarify: 0.1, review: 0.85 },
    note: 'Long and many-part: the rule already reads it as demanding.',
  },
];

export interface ConfusionCounts {
  truePositive: number;
  falsePositive: number;
  trueNegative: number;
  falseNegative: number;
  abstained: number;
}

export interface PreflightMeasurement {
  readonly thresholds: PreflightThresholds;
  readonly cases: number;
  readonly unavailable: number;
  /** Demanding: the WorkStyle reading after advice, against the label. */
  readonly escalation: {
    readonly baseline: ConfusionCounts;
    readonly advised: ConfusionCounts;
    readonly falsePassRate: { readonly baseline: number; readonly advised: number };
    readonly falseEscalationRate: { readonly baseline: number; readonly advised: number };
  };
  readonly missingEvidence: ConfusionCounts;
  readonly needsClarification: ConfusionCounts;
  readonly needsReview: ConfusionCounts;
  readonly perCase: readonly {
    readonly id: string;
    readonly status: PreflightAdvice['status'];
    readonly baseline: TaskKind;
    readonly advised: TaskKind;
    readonly labels: PreflightLabels;
  }[];
}

const empty = (): ConfusionCounts => ({
  truePositive: 0,
  falsePositive: 0,
  trueNegative: 0,
  falseNegative: 0,
  abstained: 0,
});

/** Tally one prediction. A null prediction is an abstention, counted apart. */
export function tally(counts: ConfusionCounts, predicted: boolean | null, actual: boolean): void {
  if (predicted === null) counts.abstained += 1;
  else if (predicted && actual) counts.truePositive += 1;
  else if (predicted && !actual) counts.falsePositive += 1;
  else if (!predicted && actual) counts.falseNegative += 1;
  else counts.trueNegative += 1;
}

const rate = (numerator: number, denominator: number) =>
  denominator === 0 ? 0 : numerator / denominator;

/** The fixture transport: answers each case's intent with its authored answer. */
export function simulatedPort(cases: readonly PreflightCase[]): EvaluationPort {
  const byIntent = new Map(cases.map((c) => [c.intent.trim(), c]));
  return {
    id: 'preflight-measurement-fixture',
    version: '1',
    requestedModel: 'fixture',
    scripted: true,
    supports: ['choice', 'score', 'boolean'],
    async evaluate(call) {
      call.signal.throwIfAborted();
      const state = call.state as { intent: string };
      const found = byIntent.get(state.intent.trim());
      if (!found || found.simulated === 'unavailable') throw new Error('The fixture provider is offline.');
      const answers: Record<string, unknown> = {
        'needs-unattached-material': { type: 'boolean', probability: found.simulated.missing },
        'needs-clarification': { type: 'boolean', probability: found.simulated.clarify },
        'needs-extra-review': { type: 'boolean', probability: found.simulated.review },
      };
      if ('workload' in call.questions) {
        const probabilities = found.simulated.workload;
        const choice = (Object.keys(probabilities) as Workload[]).reduce((best, key) =>
          probabilities[key] > probabilities[best] ? key : best,
        );
        answers.workload = { type: 'choice', choice, probabilities };
      }
      return { answers, usage: { inputTokens: null, outputTokens: null }, response: {} };
    },
  };
}

/** Run every case through the advisor and tally the policy's decisions against the labels. */
export async function measurePreflight(
  cases: readonly PreflightCase[] = SYNTHETIC_PREFLIGHT_CASES,
  thresholds: PreflightThresholds = DEFAULT_PREFLIGHT_THRESHOLDS,
): Promise<PreflightMeasurement> {
  const advisor = createJevAdvisor({ port: simulatedPort(cases), thresholds, cacheSize: 0 });
  const baseline = empty();
  const advised = empty();
  const missingEvidence = empty();
  const needsClarification = empty();
  const needsReview = empty();
  const perCase: PreflightMeasurement['perCase'][number][] = [];
  let unavailable = 0;

  for (const [index, item] of cases.entries()) {
    const advice = await advisor.preflight({
      scope: { tenant: 'measurement', project: 'synthetic', thread: `case-${index}` },
      intent: item.intent,
      mode: 'ask',
      style: 'efficient',
      sources: item.sources.map((path) => ({ path, sha: 'synthetic' })),
      shortlist: [],
    });
    if (advice.status === 'unavailable' || advice.status === 'refused') unavailable += 1;
    const before = classifyTask(item.intent);
    const after = advisedTaskKind(before, advice);
    tally(baseline, before === 'demanding', item.labels.demanding);
    tally(advised, after === 'demanding', item.labels.demanding);
    tally(missingEvidence, advice.hints.missingEvidence, item.labels.missingEvidence);
    tally(needsClarification, advice.hints.needsClarification, item.labels.needsClarification);
    tally(needsReview, advice.hints.needsReview, item.labels.needsReview);
    perCase.push({ id: item.id, status: advice.status, baseline: before, advised: after, labels: item.labels });
  }

  const positives = cases.filter((c) => c.labels.demanding).length;
  const negatives = cases.length - positives;
  return {
    thresholds,
    cases: cases.length,
    unavailable,
    escalation: {
      baseline,
      advised,
      falsePassRate: {
        baseline: rate(baseline.falseNegative, positives),
        advised: rate(advised.falseNegative, positives),
      },
      falseEscalationRate: {
        baseline: rate(baseline.falsePositive, negatives),
        advised: rate(advised.falsePositive, negatives),
      },
    },
    missingEvidence,
    needsClarification,
    needsReview,
    perCase,
  };
}
