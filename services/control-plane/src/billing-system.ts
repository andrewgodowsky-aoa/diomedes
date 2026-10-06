/**
 * The reserved billing system actor (billing foundation, slice 1).
 *
 * Stripe decides whether a period is paid; the account service decides access. When a verified payment later writes a
 * plan grant, the grant's `issuedBy` and the staff audit row name this actor, so a payment is never attributed to a person
 * who did not make it (AGENTS.md, actor attribution). Migration 016 gives it one persons row, which is what the audit
 * table and the grant records point at.
 *
 * It is an actor and never a login: it has no external subject, so no session can be opened as it, no membership, and no
 * operators row. The staff directory refuses to add it as an operator (addStaffInput). Its audit role is `billing`, which is
 * the role whose work it does; the actor id, not the role, is what tells it from a person on the billing team.
 *
 * Slice 1 defines and reserves it. Nothing writes a grant as this actor yet: that is the subscription slice.
 */
import type { StaffRole } from '../../../shared/access.js';

/** The persons row id, `issuedBy` on a grant it writes and `actorPersonId` on the audit rows it leaves. */
export const BILLING_SYSTEM_ACTOR = 'billing-system';
/** The audit role it acts in. */
export const BILLING_SYSTEM_ROLE: StaffRole = 'billing';
/** The name its persons row carries. */
export const BILLING_SYSTEM_NAME = 'Billing system';

/** Whether an id is the reserved actor's. */
export const isBillingSystemActor = (personId: string): boolean => personId === BILLING_SYSTEM_ACTOR;
