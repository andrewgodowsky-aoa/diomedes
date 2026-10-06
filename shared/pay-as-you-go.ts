/**
 * Pay as you go (Andrew, 2026-10-05, Model B section 4; DIO-219).
 *
 * A person with no plan who holds credits they bought gets the Nectovia Agent for their own Personal work, and in projects no
 * business owns: the conversations and tasks they start, on Nectovia's company route, funded only from their own bought
 * balance. It stops when that balance runs out, at the end of the step in progress, as the out-of-credits stop always does.
 *
 * Bought credits grant no feature. What makes the Agent work on its own or for a business stays on a plan: routines and
 * automations (the `automation` surface and usage class), the team lead (the `team` surface, and a Nectovia role working under
 * another lead), the person's own model keys (a `byo` or `local` route is the Agent on someone else's compute, Pillar 12),
 * business rules and phone access (both read a business's own grants, so Personal work never has them).
 *
 * One decision, read by every gate that admits Personal work: the desktop, the account service's admission and the gateway.
 * The bought balance itself is always the account service's; a desktop only reads whether it is above zero.
 */
import { AGENT_PERSONAL_REASON, PAY_AS_YOU_GO_PLAN_ONLY_REASON } from './access.js';

/** Surfaces pay as you go never admits: the team lead's members and unattended automations. */
export const PLAN_ONLY_SURFACES: readonly string[] = Object.freeze(['team', 'automation']);

export type PayAsYouGoDecision =
  | { readonly admitted: true }
  | { readonly admitted: false; readonly code: 'credits_required' | 'plan_required'; readonly reason: string };

/**
 * Whether a person with no plan may start this piece of Agent work on their own bought credits. `bought` is whether the account
 * service says their own bought balance is above zero. The plan-only refusals come first, so a person who has credits is told the
 * work needs a plan rather than to buy more.
 */
export function decidePayAsYouGo(work: { surface: string; routeKind: string; escalated?: boolean; usageClass?: string | null }, bought: boolean): PayAsYouGoDecision {
  if (work.routeKind !== 'managed' || PLAN_ONLY_SURFACES.includes(work.surface) || work.escalated === true || work.usageClass === 'automation')
    return { admitted: false, code: 'plan_required', reason: PAY_AS_YOU_GO_PLAN_ONLY_REASON };
  if (!bought) return { admitted: false, code: 'credits_required', reason: AGENT_PERSONAL_REASON };
  return { admitted: true };
}
