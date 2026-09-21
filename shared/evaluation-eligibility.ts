/**
 * Whether a thread may run a preparation evaluation at all.
 *
 * Core Pillar 01: "Do not add model latency/cost to trivial operations merely
 * to make a feature appear intelligent." Core Pillar 08: "Do not force human
 * review or model reasoning where a deterministic, already-authorized operation
 * is sufficient." A preparation step that fires on every thread is precisely
 * the pattern both pillars forbid, so the exemption is this predicate rather
 * than a paragraph promising restraint.
 *
 * It is pure. It makes no call, reads no clock and costs nothing, which is what
 * lets it run before anything is admitted and lets a recorded skip be replayed
 * from the record rather than re-decided.
 *
 * The load-bearing case is `single-candidate`. An evaluation exists to choose
 * between candidates the product already authorized; where there are none or
 * one, there is nothing to choose and no model is asked. A one-document thread,
 * an exact status lookup and an empty project all skip here, for free, with a
 * reason. That is the honest form of "AI steps in when the job actually needs
 * reasoning" — a rule the code applies, not a claim the documentation makes.
 *
 * Reasons are checked cheapest-and-most-certain first, so the recorded reason
 * is the one that stopped it soonest, and a refusal of policy is always
 * reported ahead of a shortage of money: those are different facts about a
 * request and only one of them is fixable by buying more.
 */

export type PreflightSkipReason =
  | 'not-first-substantive'
  | 'team-wake'
  | 'replayed-command'
  | 'deterministic-route'
  | 'local-only-policy'
  | 'route-not-enabled'
  | 'no-consent'
  | 'single-candidate'
  | 'no-price'
  | 'helper-budget-exhausted';

export interface PreflightInput {
  /** Turns already in this thread. Preparation belongs to the first one. */
  readonly turnsAlready: number;
  /** A team wake submits no request of its own. */
  readonly wake: boolean;
  /** A replayed command already has its answer; it never re-dispatches. */
  readonly replayedCommand: boolean;
  /** The selected route. Some routes have no choices to make. */
  readonly route: string;
  readonly processing: 'local-only' | 'cloud-permitted';
  readonly featureEnabled: boolean;
  /** The person agreed that this work may reach a second destination. */
  readonly disclosureConsented: boolean;
  /** How many candidates the product has already authorized for this request. */
  readonly candidateCount: number;
  /** Whether this route has a configured per-token price. */
  readonly pricedRoute: boolean;
  readonly helperBudgetRemainingMicroUsd: number;
  /** The conservative ceiling this evaluation would reserve. */
  readonly reservationCeilingMicroUsd: number;
}

export type PreflightDecision =
  | { readonly fire: true }
  | { readonly fire: false; readonly reason: PreflightSkipReason };

/**
 * Routes that reach no model, so there is nothing for a recommendation to
 * improve. `sample` is deterministic work with no choices in it.
 */
const DETERMINISTIC_ROUTES: readonly string[] = Object.freeze(['sample']);

/**
 * How each skip reads to a person. No internal code appears in a sentence, and
 * none of them says the check happened: "preparation was skipped" and
 * "preparation found nothing" are different statements, and presenting the
 * first as the second is the dishonesty this whole feature has to avoid.
 */
export const SKIP_REASON_TEXT: Readonly<Record<PreflightSkipReason, string>> = Object.freeze({
  'not-first-substantive': 'This task was already prepared when it started.',
  'team-wake': 'Nobody asked for anything new, so there was nothing to prepare.',
  'replayed-command': 'This request had already been answered, so it was not run again.',
  'deterministic-route': 'This work follows fixed steps, so no model was needed to plan it.',
  'local-only-policy': 'This work stays on your computer, so nothing was sent out to prepare it.',
  'route-not-enabled': 'Task preparation is switched off for this workspace.',
  'no-consent': 'Task preparation needs your agreement to send a short summary out first.',
  'single-candidate': 'There was only one thing this could use, so there was nothing to choose.',
  'no-price':
    'This route has no agreed price, so nothing could be set aside for it before the call.',
  'helper-budget-exhausted':
    'The amount set aside for preparation is used up, so the task ran without it.',
});

/**
 * Decide, deterministically, whether this request prepares.
 *
 * Returning `{fire: false, reason}` is a normal, successful outcome. The caller
 * records it and proceeds on the ordinary path; a skip is evidence that the
 * question was asked and answered, which is why it is never silent.
 */
export function preflightDecision(input: PreflightInput): PreflightDecision {
  // Free facts about the request first: no arithmetic, no lookup, no doubt.
  if (input.turnsAlready > 0) return { fire: false, reason: 'not-first-substantive' };
  if (input.wake) return { fire: false, reason: 'team-wake' };
  if (input.replayedCommand) return { fire: false, reason: 'replayed-command' };
  if (DETERMINISTIC_ROUTES.includes(input.route))
    return { fire: false, reason: 'deterministic-route' };

  // Then policy. A refusal here is not about money and must not be reported as
  // though it were: a person told "your budget ran out" would try to buy more.
  if (input.processing === 'local-only') return { fire: false, reason: 'local-only-policy' };
  if (!input.featureEnabled) return { fire: false, reason: 'route-not-enabled' };
  if (!input.disclosureConsented) return { fire: false, reason: 'no-consent' };

  // Then the pillar test: is there a genuine choice to make?
  if (input.candidateCount <= 1) return { fire: false, reason: 'single-candidate' };

  // Only now, money. An unpriced route cannot be held against a cap at all,
  // which is the same rule the rate card applies to provider-run tools.
  if (!input.pricedRoute) return { fire: false, reason: 'no-price' };
  if (input.helperBudgetRemainingMicroUsd < input.reservationCeilingMicroUsd)
    return { fire: false, reason: 'helper-budget-exhausted' };

  return { fire: true };
}
