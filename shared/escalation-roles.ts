/**
 * Nectovia's managed tiers as team roles under a lead that is not Nectovia (DIO-216 slice C). The
 * customer's local model leads, and hands a task up to Nectovia when the task needs it.
 *
 * A role names its tier, never a model: which model serves a tier is the account's routing,
 * published from the Operations app. Customer copy names the tier ("Nectovia Focused") from the
 * shared tier labels and says the role uses the account's credits. Whether the account lets work
 * be handed to a tier at all is its escalation control (`shared/escalation-controls.ts`).
 *
 * Pure: no clock, no disk, no request. Client and server share it.
 */
import { AGENT_NAME } from './agent-name.js';
import { escalationAllows, type EscalationView } from './escalation-controls.js';
import { ROUTING_TIERS } from './routing-policy.js';
import { WORK_STYLE_LABELS } from './work-style.js';

export type RoleTier = (typeof ROUTING_TIERS)[number];
export type EscalationRoleKind = 'worker' | 'advisor';

export const isRoleTier = (value: unknown): value is RoleTier =>
  typeof value === 'string' && (ROUTING_TIERS as readonly string[]).includes(value);

/** "Nectovia Focused": a Nectovia role by its tier, from the shared tier labels. */
export const nectoviaTierName = (tier: RoleTier): string => `${AGENT_NAME} ${WORK_STYLE_LABELS[tier]}`;

/** What a Nectovia role costs, said once wherever the role is offered or shown. */
export const NECTOVIA_ROLE_CREDITS = 'It uses your account’s credits.';

/** The control could not be read. A role is refused then, never admitted under the default. */
export const ESCALATION_UNREADABLE = 'The account’s settings for handing work to Nectovia could not be checked.';

/**
 * Why the account's escalation control refuses this tier now, in the words the gateway uses too, or
 * null when it allows it. A control that could not be read refuses.
 */
export function escalationRefusal(control: Pick<EscalationView, 'enabled' | 'tiers'> | null, tier: RoleTier): string | null {
  if (!control) return ESCALATION_UNREADABLE;
  const allowed = escalationAllows(control, tier);
  return allowed.ok ? null : allowed.reason;
}

/**
 * The roles a local lead takes by default, so it can hand work up without the person building a
 * team each time: a Focused worker, then a Thorough advisor. The order matters: an advisor joins
 * only beside a worker.
 */
export const DEFAULT_ESCALATION_ROLES: readonly { readonly role: EscalationRoleKind; readonly tier: RoleTier }[] = Object.freeze([
  { role: 'worker', tier: 'focused' },
  { role: 'advisor', tier: 'thorough' },
]);

/** Why a default advisor was left out when its worker was. A team without a worker has no advisor. */
export const ADVISOR_NEEDS_WORKER = 'An advisor joins only beside a worker.';

/** Where one Nectovia role's work goes, as a consent sentence says it. */
export function nectoviaRoleLine(kind: EscalationRoleKind, tier: RoleTier): string {
  return kind === 'worker'
    ? `This loop hands tasks to ${nectoviaTierName(tier)} with the files they need.`
    : `This loop asks ${nectoviaTierName(tier)} for advice with the files it needs.`;
}

/** What a start that names a Nectovia role confirms: where the role's work goes, and its cost. */
export function nectoviaRoleConsentText(kind: EscalationRoleKind, tier: RoleTier): string {
  return `${nectoviaRoleLine(kind, tier)} ${NECTOVIA_ROLE_CREDITS} Confirm before sending.`;
}

/**
 * What a local lead's start asks before its default Nectovia roles join. The person confirms with
 * `escalation: true` on the same start, or leaves them out with `escalation: false`.
 */
export function escalationConsentText(roles: readonly { readonly role: EscalationRoleKind; readonly tier: RoleTier }[]): string {
  const lines = roles.map(({ role, tier }) => nectoviaRoleLine(role, tier));
  const many = roles.length > 1;
  return `${lines.join(' ')} ${many ? 'They use' : 'It uses'} your account’s credits. Confirm to include ${many ? 'them' : 'it'}, or start without ${many ? 'them' : 'it'}.`;
}

/** What a run records about its default escalation roles: which joined, and why any didn't. */
export interface EscalationRecord {
  readonly attached: readonly { readonly role: EscalationRoleKind; readonly tier: RoleTier }[];
  readonly leftOut: readonly { readonly role: EscalationRoleKind; readonly tier: RoleTier; readonly reason: string }[];
}

/** One tier the start dialog may offer as a role, read now. Nothing is admitted by reading it. */
export interface EscalationOffer {
  readonly tier: RoleTier;
  readonly name: string;
  readonly admitted: boolean;
  readonly reason: string | null;
}
