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

/**
 * The roles a local lead takes by default, so it can hand work up without the person building a
 * team each time: a Focused worker, then a Thorough advisor. The order matters: an advisor joins
 * only beside a worker.
 */
export const DEFAULT_ESCALATION_ROLES: readonly { readonly role: EscalationRoleKind; readonly tier: RoleTier }[] = Object.freeze([
  { role: 'worker', tier: 'focused' },
  { role: 'advisor', tier: 'thorough' },
]);

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
