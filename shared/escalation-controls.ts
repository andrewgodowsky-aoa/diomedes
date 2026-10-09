/**
 * Escalation controls: whether work led by a model that is not Nectovia (the customer's local
 * model, or one of the owner's own routes) may hand work to Nectovia's managed tiers, and to which
 * tiers. Staff set it from the Operations app on an account scope's routing record, or on the
 * global record as the default for every account.
 *
 * The routing snapshot does not carry this control. Installed desktops parse that snapshot with a
 * strict schema, so a new field there would refuse routing on every older install. The control
 * has its own read instead: `GET /account/routing/{organization|individual}/{id}/escalation`.
 *
 * A managed call made by a Nectovia role under another lead carries `ESCALATION_HEADER`. The
 * gateway refuses such a call, before any hold or send, when the account's control does not allow
 * the call's tier. The desktop checks the same control before it admits the role, so a refusal
 * normally happens there first, in the same words.
 */
import { z } from 'zod';
import { ROUTING_TIERS } from './routing-policy.js';

type RoutingTier = (typeof ROUTING_TIERS)[number];

export const escalationControlSchema = z
  .strictObject({
    /** False: no Nectovia tier may take escalated work in this scope. */
    enabled: z.boolean(),
    /** The tiers escalated work may use. Ignored when `enabled` is false. */
    tiers: z.array(z.enum(ROUTING_TIERS)).max(ROUTING_TIERS.length),
  })
  .superRefine((value, ctx) => {
    if (new Set(value.tiers).size !== value.tiers.length)
      ctx.addIssue({ code: 'custom', path: ['tiers'], message: 'Each tier appears once.' });
    if (value.enabled && value.tiers.length === 0)
      ctx.addIssue({ code: 'custom', path: ['tiers'], message: 'Choose at least one tier, or turn escalation off.' });
  });
export type EscalationControl = z.infer<typeof escalationControlSchema>;

/** What applies when neither the account scope nor the global record sets a control. */
export const DEFAULT_ESCALATION: EscalationControl = Object.freeze({
  enabled: true,
  // A new premium tier is never silently added to an account's escalation permission.
  tiers: ['efficient', 'focused', 'thorough'],
}) as EscalationControl;

/** The answer of `GET /account/routing/{kind}/{id}/escalation`, readable by any member of the scope. */
export const escalationViewSchema = z.strictObject({
  enabled: z.boolean(),
  tiers: z.array(z.enum(ROUTING_TIERS)),
  /** Where the control came from: the scope's own record, the global record, or the default. */
  source: z.enum(['scope', 'global', 'default']),
  scopeRevision: z.number().int().min(0),
  globalRevision: z.number().int().min(0),
});
export type EscalationView = z.infer<typeof escalationViewSchema>;

/** The scope's own control when it sets one, otherwise the global record's, otherwise the default. */
export function effectiveEscalation(
  scope: EscalationControl | null | undefined,
  global: EscalationControl | null | undefined,
  revisions: { scopeRevision: number; globalRevision: number },
): EscalationView {
  const chosen = scope ?? global ?? DEFAULT_ESCALATION;
  return {
    enabled: chosen.enabled,
    tiers: chosen.enabled ? [...chosen.tiers] : [],
    source: scope ? 'scope' : global ? 'global' : 'default',
    scopeRevision: revisions.scopeRevision,
    globalRevision: revisions.globalRevision,
  };
}

/** The header a managed call carries when a Nectovia role under another lead makes it. */
export const ESCALATION_HEADER = 'X-Nectovia-Escalation';
/** Its values: the role that made the call. Any other value is refused as a bad request. */
export const ESCALATION_ROLES = ['worker', 'advisor'] as const;
export type EscalationRole = (typeof ESCALATION_ROLES)[number];

const TIER_NAMES: Record<RoutingTier, string> = { efficient: 'Efficient', focused: 'Focused', thorough: 'Thorough', expert: 'Expert' };

/**
 * Whether escalated work may use this tier now. The reason is the sentence both the desktop and the
 * gateway show, so a person reads the same words wherever the refusal happens.
 */
export function escalationAllows(
  control: Pick<EscalationView, 'enabled' | 'tiers'>,
  tier: RoutingTier,
): { ok: true } | { ok: false; code: 'escalation_off' | 'escalation_tier_off'; reason: string } {
  if (!control.enabled)
    return { ok: false, code: 'escalation_off', reason: 'Handing work to Nectovia is turned off for this account.' };
  if (!control.tiers.includes(tier))
    return {
      ok: false,
      code: 'escalation_tier_off',
      reason: `Handing work to Nectovia ${TIER_NAMES[tier]} is turned off for this account.`,
    };
  return { ok: true };
}
