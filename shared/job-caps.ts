/**
 * Parent-job caps by tier, the pre-send estimate, and the words both are said
 * in. Pure: no ledger, no network, no clock. The host computes the inputs from
 * its own records and the client only ever renders what the host returned.
 *
 * Owner decision of 2026-09-23 (Andrew): each parent job gets a finite credit
 * cap set by its tier (`APPROVED_JOB_CAP_CREDITS`). Before any spend, a job that
 * will likely use more than its cap shows a warning ahead of time, recommending
 * the next tier up where one exists or letting the person agree to go over for
 * this one job. Agreeing is an explicit one-job cap raise, never a standing
 * change. A job that runs past its cap mid-way stops at the next step boundary
 * and offers the same two choices; it never silently keeps spending.
 *
 * Three things the estimate refuses to do:
 *
 * 1. **Guess a price.** A metered route with no declared rates is `unknown`,
 *    and `unknown` warns. It is never drawn as zero.
 * 2. **Hide its assumptions.** `worst` is every step at the route's own call
 *    ceiling (the same bound a reservation holds), `likely` and `low` are named
 *    heuristics below, and the basis sentence says which.
 * 3. **Round money.** Amounts are integer micro-USD throughout; only the words
 *    round, and they say "about".
 */
import {
  APPROVED_JOB_CAP_CREDITS,
  CREDIT_MICRO_USD,
  JOB_TIERS,
  MAX_MONEY_MICRO_USD,
  approvedJobCap,
  micro,
  type JobTier,
  type MicroUsd,
} from './managed-usage.js';
import { WORK_STYLE_LABELS, type WorkStyle } from './work-style.js';

// The job tiers and the WorkStyles are the same three words. If either list
// changes without the other, this stops compiling.
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const tiersMatchStyles: Same<JobTier, WorkStyle> = true;
void tiersMatchStyles;

export { APPROVED_JOB_CAP_CREDITS, JOB_TIERS, approvedJobCap, type JobTier };

/**
 * The tier a job with no WorkStyle is held to. The smallest approved cap, so a
 * job nobody chose a tier for never spends more than any tier allows. Which tier
 * an unstyled job should run under is an open owner question; this is the
 * conservative placeholder, not a product default.
 */
export const DEFAULT_JOB_TIER: JobTier = 'efficient';

export function jobTierOf(style: WorkStyle | null | undefined): JobTier {
  return style ?? DEFAULT_JOB_TIER;
}

/** The next tier up, or null for the top one. */
export function nextTierUp(tier: JobTier): JobTier | null {
  const index = JOB_TIERS.indexOf(tier);
  return index >= 0 && index < JOB_TIERS.length - 1 ? JOB_TIERS[index + 1] : null;
}

export const jobTierLabel = (tier: JobTier): string => WORK_STYLE_LABELS[tier];

// --- the input-token bound ----------------------------------------------------

/**
 * The input-token ceiling a request can reach, from its bytes: a token never
 * covers less than one byte, so a byte count is an upper bound on tokens. The
 * constant and the per-message allowance cover framing the provider adds.
 * `server/engines/model-api-core.ts` holds every call to this same bound.
 */
export function inputTokenBound(bytes: number, messages: number): number {
  return bytes + 1_024 + messages * 16;
}

// --- the estimate -------------------------------------------------------------

/** List prices in whole micro-USD per million tokens. */
export interface JobRates {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/**
 * The conservative shape of one job, from the host's own records and limits.
 * Every field is a bound the runtime already enforces, never a hope.
 */
export interface JobShape {
  /** Bytes of the first request: instructions, the message, history and sources. */
  inputBytes: number;
  /** Messages in the first request. */
  messages: number;
  /** The output ceiling every model call is sent with. */
  maxOutputTokensPerStep: number;
  /** The most model calls this job can make (the tool-loop step cap). */
  maxSteps: number;
  /** The largest request the route will send; a bigger one is refused, not sent. */
  maxRequestBytes: number;
  /** The most a tool result can add to the next request, in bytes. 0 when no tools are offered. */
  toolResultBytesPerStep: number;
}

/**
 * The named heuristics behind `likely` and `low`. Typical English text runs
 * about four bytes to a token; a typical answer uses a quarter of its output
 * ceiling; a tool-using job typically takes a quarter of its step cap. They are
 * estimates and are labelled as such wherever they are shown. `worst` uses none
 * of them.
 */
export const ESTIMATE_HEURISTICS = Object.freeze({
  typicalBytesPerToken: 4,
  likelyOutputShare: 1 / 4,
  lowOutputShare: 1 / 16,
  likelyStepShare: 1 / 4,
  /** A typical tool result, in bytes. `worst` uses the shape's bound instead. */
  typicalToolResultBytes: 8_192,
});

export type JobEstimate =
  | {
      readonly kind: 'estimate';
      readonly tier: JobTier;
      readonly capMicroUsd: MicroUsd;
      readonly lowMicroUsd: MicroUsd;
      readonly likelyMicroUsd: MicroUsd;
      readonly worstMicroUsd: MicroUsd;
      /** Warns and asks before sending. */
      readonly likelyExceeds: boolean;
      /** Said, but does not block: the job stops at its cap and asks. */
      readonly worstExceeds: boolean;
      readonly warn: boolean;
      readonly basis: string;
    }
  | {
      readonly kind: 'unknown';
      readonly tier: JobTier;
      readonly capMicroUsd: MicroUsd;
      readonly reason: string;
      /** An estimate nobody can make still warns. */
      readonly warn: true;
    }
  | {
      readonly kind: 'not-metered';
      readonly tier: JobTier;
      readonly capMicroUsd: MicroUsd;
      readonly reason: string;
      readonly warn: false;
    };

export interface JobEstimateInput {
  tier: JobTier;
  /** The job's current cap. Defaults to its tier's approved cap. */
  capMicroUsd?: MicroUsd;
  /**
   * `metered`: every call is priced per token and held against a cap.
   * `not-metered`: the route runs on this computer, or on a subscription that
   * is not priced per call, so no credits are spent.
   */
  metering: 'metered' | 'not-metered';
  /** Null on a metered route means the price is unknown. */
  rates: JobRates | null;
  shape: JobShape;
  /** Why a price is unknown or why nothing is metered, in plain words. */
  reason?: string;
}

const MILLION = 1_000_000n;
const big = (value: number) => BigInt(Math.max(0, Math.ceil(value)));
const ceilDiv = (numerator: bigint, denominator: bigint) =>
  (numerator + denominator - 1n) / denominator;

function money(scaled: bigint): MicroUsd {
  const amount = ceilDiv(scaled, MILLION);
  return micro(amount > BigInt(MAX_MONEY_MICRO_USD) ? MAX_MONEY_MICRO_USD : Number(amount));
}

function validRates(rates: JobRates): boolean {
  return (['input', 'output', 'cacheRead', 'cacheWrite'] as const).every(
    (key) => Number.isSafeInteger(rates[key]) && rates[key] >= 0,
  ) && rates.input > 0 && rates.output > 0;
}

function validShape(shape: JobShape): boolean {
  return (
    [shape.inputBytes, shape.messages, shape.maxOutputTokensPerStep, shape.maxRequestBytes, shape.toolResultBytesPerStep].every(
      (value) => Number.isSafeInteger(value) && value >= 0,
    ) &&
    Number.isSafeInteger(shape.maxSteps) &&
    shape.maxSteps >= 1
  );
}

/**
 * The most this job can cost: every step's input at the dearest input rate (a
 * cold cache writes everything, so no cached discount is assumed) and every
 * step's full output ceiling. Each step's input grows by what the step before it
 * could add, and never past what the route will send. This is the sum of the
 * reservations the job would hold if every step ran to its bound.
 */
function worstCost(rates: JobRates, shape: JobShape): bigint {
  const inputRate = BigInt(Math.max(rates.input, rates.cacheWrite, rates.cacheRead));
  const outputRate = BigInt(rates.output);
  const ceiling = inputTokenBound(shape.maxRequestBytes, shape.messages + 2 * shape.maxSteps);
  let total = 0n;
  for (let step = 0; step < shape.maxSteps; step++) {
    const grown = inputTokenBound(
      shape.inputBytes + step * (shape.maxOutputTokensPerStep + shape.toolResultBytesPerStep),
      shape.messages + 2 * step,
    );
    total += big(Math.min(grown, ceiling)) * inputRate + big(shape.maxOutputTokensPerStep) * outputRate;
  }
  return total;
}

function typicalCost(
  rates: JobRates,
  shape: JobShape,
  steps: number,
  outputShare: number,
): bigint {
  const h = ESTIMATE_HEURISTICS;
  const output = shape.maxOutputTokensPerStep * outputShare;
  const toolTokens = Math.min(shape.toolResultBytesPerStep, h.typicalToolResultBytes) / h.typicalBytesPerToken;
  let total = 0n;
  for (let step = 0; step < steps; step++) {
    const input = shape.inputBytes / h.typicalBytesPerToken + step * (output + toolTokens);
    total += big(input) * BigInt(rates.input) + big(output) * BigInt(rates.output);
  }
  return total;
}

/**
 * Low, likely and worst for one job, against its cap. Unknown rates on a
 * metered route give `unknown`, which warns; a route that spends no credits
 * gives `not-metered`, which does not.
 */
export function estimateJob(input: JobEstimateInput): JobEstimate {
  const tier = input.tier;
  const capMicroUsd = input.capMicroUsd ?? approvedJobCap(tier);
  if (input.metering === 'not-metered')
    return {
      kind: 'not-metered',
      tier,
      capMicroUsd,
      reason:
        input.reason ??
        'This runs on this computer or on a subscription that is not priced per call, so it uses no credits.',
      warn: false,
    };
  if (!input.rates || !validRates(input.rates))
    return {
      kind: 'unknown',
      tier,
      capMicroUsd,
      reason: input.reason ?? 'This route has no declared prices for its model.',
      warn: true,
    };
  if (!validShape(input.shape))
    return {
      kind: 'unknown',
      tier,
      capMicroUsd,
      reason: 'The size of this job could not be measured.',
      warn: true,
    };
  const h = ESTIMATE_HEURISTICS;
  const likelySteps = Math.max(1, Math.ceil(input.shape.maxSteps * h.likelyStepShare));
  const worstMicroUsd = money(worstCost(input.rates, input.shape));
  // Heuristics can only ever sit at or under the bound.
  const likelyMicroUsd = micro(
    Math.min(worstMicroUsd, money(typicalCost(input.rates, input.shape, likelySteps, h.likelyOutputShare))),
  );
  const lowMicroUsd = micro(
    Math.min(likelyMicroUsd, money(typicalCost(input.rates, input.shape, 1, h.lowOutputShare))),
  );
  const likelyExceeds = likelyMicroUsd > capMicroUsd;
  const worstExceeds = worstMicroUsd > capMicroUsd;
  return {
    kind: 'estimate',
    tier,
    capMicroUsd,
    lowMicroUsd,
    likelyMicroUsd,
    worstMicroUsd,
    likelyExceeds,
    worstExceeds,
    warn: likelyExceeds,
    basis: `Worst case is all ${input.shape.maxSteps} step${input.shape.maxSteps === 1 ? '' : 's'} at full size with nothing cached; likely assumes about ${likelySteps} step${likelySteps === 1 ? '' : 's'} of typical length.`,
  };
}

// --- enforcement decisions ----------------------------------------------------

export type JobStepDecision =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly code: 'job_cap_reached';
      readonly usedMicroUsd: MicroUsd;
      readonly capMicroUsd: MicroUsd;
      /** What the refused step would have needed on top of what is used. */
      readonly neededMicroUsd: MicroUsd;
    };

/**
 * Whether the next step fits inside the job's cap. `usedMicroUsd` already counts
 * every child and retry under the job (settled at cost, in flight or unknown at
 * their ceiling), which is why neither can escape it.
 */
export function decideJobStep(input: {
  capMicroUsd: MicroUsd;
  usedMicroUsd: MicroUsd;
  nextMicroUsd: MicroUsd;
}): JobStepDecision {
  if (input.usedMicroUsd + input.nextMicroUsd <= input.capMicroUsd) return { ok: true };
  return {
    ok: false,
    code: 'job_cap_reached',
    usedMicroUsd: input.usedMicroUsd,
    capMicroUsd: input.capMicroUsd,
    neededMicroUsd: micro(input.usedMicroUsd + input.nextMicroUsd),
  };
}

const roundUpToCredit = (amount: MicroUsd): MicroUsd =>
  micro(Math.min(MAX_MONEY_MICRO_USD, Math.ceil(amount / CREDIT_MICRO_USD) * CREDIT_MICRO_USD));

/**
 * The finite cap one "Go over this once" raises a job to: at least another
 * tier's worth of room, and at least whole credits past what the job is known
 * to need. It is recorded against one job and applies to nothing else.
 */
export function oneJobRaise(input: {
  tier: JobTier;
  capMicroUsd: MicroUsd;
  neededMicroUsd: MicroUsd | null;
}): MicroUsd {
  const floor = micro(Math.min(MAX_MONEY_MICRO_USD, input.capMicroUsd + approvedJobCap(input.tier)));
  if (input.neededMicroUsd === null) return floor;
  return micro(Math.max(floor, roundUpToCredit(input.neededMicroUsd)));
}

// --- words ----------------------------------------------------------------------

/** "about 60 credits", "less than 1 credit", "1 credit". Whole credits only; it says about. */
export function aboutCredits(amount: MicroUsd): string {
  if (amount === 0) return 'no credits';
  const whole = Math.round(amount / CREDIT_MICRO_USD);
  if (whole < 1) return 'less than 1 credit';
  return `${whole.toLocaleString('en-US')} ${whole === 1 ? 'credit' : 'credits'}`;
}

/** A cap as it is said: always a whole number of credits. */
export const capCredits = (amount: MicroUsd): string =>
  `${Math.floor(amount / CREDIT_MICRO_USD).toLocaleString('en-US')}`;

export interface CapWarningCopy {
  title: string;
  body: string;
  /** Present only where a higher tier exists. */
  upgrade: { tier: JobTier; label: string } | null;
  /** What "Go over this once" raises this job's cap to. */
  raise: string;
}

function upgradeFor(tier: JobTier): CapWarningCopy['upgrade'] {
  const next = nextTierUp(tier);
  return next ? { tier: next, label: `Use ${jobTierLabel(next)}` } : null;
}

/** The pre-send warning, from an estimate that warns. */
export function capWarningCopy(estimate: JobEstimate, raisedToMicroUsd: MicroUsd): CapWarningCopy {
  const label = jobTierLabel(estimate.tier);
  const cap = capCredits(estimate.capMicroUsd);
  const body =
    estimate.kind === 'estimate'
      ? `This will likely use about ${aboutCredits(estimate.likelyMicroUsd)}. ${label} jobs are capped at ${cap}.`
      : `Nectovia can't estimate this job. ${estimate.reason} ${label} jobs are capped at ${cap} credits.`;
  return {
    title: 'This job may go over its cap',
    body,
    upgrade: upgradeFor(estimate.tier),
    raise: `Going over raises this job's cap to ${capCredits(raisedToMicroUsd)} credits, for this job only.`,
  };
}

/** The line a send shows when only the worst case passes the cap. It does not block. */
export function worstCaseNote(estimate: JobEstimate): string | null {
  if (estimate.kind !== 'estimate' || estimate.likelyExceeds || !estimate.worstExceeds) return null;
  return `It could use up to ${aboutCredits(estimate.worstMicroUsd)} at most. It stops at the ${capCredits(estimate.capMicroUsd)}-credit cap and asks before going further.`;
}

/** The mid-run stop, when a job reached its cap at a step boundary. */
export function overrunCopy(input: {
  tier: JobTier;
  capMicroUsd: MicroUsd;
  usedMicroUsd: MicroUsd;
  raisedToMicroUsd: MicroUsd;
}): CapWarningCopy {
  const label = jobTierLabel(input.tier);
  return {
    title: 'This job reached its cap',
    body: `This job stopped before its next step, having used about ${aboutCredits(input.usedMicroUsd)} of the ${capCredits(input.capMicroUsd)} a ${label} job is capped at. Nothing more was spent. Choosing either option sends the message again as a new job.`,
    upgrade: upgradeFor(input.tier),
    raise: `Going over raises the new job's cap to ${capCredits(input.raisedToMicroUsd)} credits, for that job only.`,
  };
}
