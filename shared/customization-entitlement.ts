/**
 * What costs money in the Design Center, and what never does.
 *
 * One central mapping, so nobody has to read a route to find out whether a
 * control is free. The rules it encodes are the owner's, not an invention here:
 *
 * - **Accessibility is never for sale.** Built-in schemes, text and zoom size,
 *   contrast, reduced motion, texture off, focus visibility and the safe reset
 *   are free, work with no plan, no network and no AI engine, and this file is
 *   the list a reviewer can check that against.
 * - **Advanced customization is included from the lowest paid tier.** It is not
 *   an upsell on top of a subscription; buying the software buys it.
 * - **A grant is an entitlement, never a local record.** The capability is
 *   granted when an `EntitlementSnapshot` reads `active` at observation time
 *   for a plan this product sells customization with. A package flag, a
 *   settings field or anything the client sent is not evidence of payment, and
 *   nothing in this file reads one.
 *
 * Everything here is a pure predicate over records the caller supplies. The
 * server resolves those records (`server/customization-gate.ts`) and the routes
 * enforce the answer; a hidden button is not enforcement and this module has no
 * opinion about buttons.
 */
import {
  snapshotAt,
  type EntitlementSnapshot,
} from '../services/control-plane/contract/index.js';
import {
  canConfigureOrganization,
  isActiveMember,
  isBusiness,
  type Membership,
  type WorkspaceRef,
} from './workspaces.js';

export const CUSTOMIZATION_CONTRACT_VERSION = 1 as const;

/**
 * The plans that include advanced customization.
 *
 * `plan_business` is the fixture id for "Diomedes Business", the lowest paid
 * software tier in `docs/business/PRICING_STRATEGY_2026-09-15.md`. The
 * price lives in that document and never in code, and there is no plan
 * catalogue in this repository yet — when a real one exists, this list is what
 * it replaces. Everything above the lowest tier includes it too, which is why
 * this is a set and not a comparison.
 */
export const CUSTOMIZATION_PLAN_IDS: readonly string[] = Object.freeze(['plan_business']);

/**
 * Free, always, in every build. No entitlement, no network, no engine.
 *
 * These are the app being usable, not a feature tier, and a change that moves
 * one of these into `PAID_CUSTOMIZATION_FEATURES` is a product decision that
 * has to be argued for in a review rather than landed in a diff.
 */
export const FREE_APPEARANCE_FEATURES: readonly string[] = Object.freeze([
  'built-in-schemes',
  'text-size',
  'interface-zoom',
  'contrast',
  'reduced-motion',
  'texture-off',
  'focus-visibility',
  'safe-reset',
]);

/** What the `customization` capability covers. */
export const PAID_CUSTOMIZATION_FEATURES: readonly string[] = Object.freeze([
  'custom-theme-authoring',
  'asset-import',
  'custom-motion-parameters',
  'theme-pack-application',
  'organization-branding',
]);

export type CustomizationFeature = (typeof PAID_CUSTOMIZATION_FEATURES)[number];

/** True when this feature never needs a plan. Used by the UI and by tests. */
export const isFreeAppearanceFeature = (feature: string): boolean =>
  FREE_APPEARANCE_FEATURES.includes(feature);

// --- refusal vocabulary ------------------------------------------------------

/**
 * The reason codes the routes return and the client matches on. A code is a
 * stable identifier; the sentence beside it is what a person reads.
 */
export const CUSTOMIZATION_REFUSAL = Object.freeze({
  noPlan: 'customization_requires_plan',
  unknown: 'customization_entitlement_unknown',
  notAMember: 'customization_not_a_member',
  localScopeOnly: 'authoring_local_scope_only',
  notOrganizationAdmin: 'customization_not_organization_admin',
} as const);

export type CustomizationRefusalCode =
  (typeof CUSTOMIZATION_REFUSAL)[keyof typeof CUSTOMIZATION_REFUSAL];

/** The sentence the owner asked for, verbatim, wherever a plan is missing. */
export const CUSTOMIZATION_REQUIRES_PLAN =
  'Customization requires an active plan. Built-in themes, text size, contrast, reduced motion and reset keep working without one.';

export type CustomizationDecision =
  | { readonly allowed: true; readonly via: 'entitlement' | 'authoring' }
  | {
      readonly allowed: false;
      readonly code: CustomizationRefusalCode;
      readonly reason: string;
    };

const refuse = (code: CustomizationRefusalCode, reason: string): CustomizationDecision => ({
  allowed: false,
  code,
  reason,
});

// --- the actor ---------------------------------------------------------------

/**
 * Everything a customization question reads. It is supplied, never fetched:
 * the checks stay pure so the same predicate answers in a test, in a route and
 * in a conformance fixture.
 *
 * `membership` is the caller's membership in the scope being asked about, and
 * is undefined for a personal scope. It is separate from `personId` because a
 * `Person` record carries no memberships — they live in the workspace registry
 * — so a check that took only a person could not answer for a business scope.
 */
export interface CustomizationActor {
  readonly personId: string;
  readonly entitlement: EntitlementSnapshot;
  /**
   * The launch-time design authoring authorization (`DIOMEDES_DESIGN_AUTHORING`
   * read by the server). It is not an entitlement and never becomes one: it
   * authorizes authoring on this computer's own scope and nothing else.
   */
  readonly authoring: boolean;
  readonly membership?: Membership | null;
  /** Observation time. Expiry and revocation are read now, never stored. */
  readonly at: string;
}

// --- check one: is the capability granted at all ------------------------------

/**
 * Whether an entitlement grants the `customization` capability right now.
 *
 * `snapshotAt` runs here rather than at the call sites, so no caller can forget
 * that a stored snapshot does not expire or revoke itself. `unknown` — the
 * service could not be asked — refuses exactly like `none`: an entitlement that
 * was never confirmed is not a quiet yes.
 */
export function hasCustomizationEntitlement(
  snapshot: EntitlementSnapshot | null | undefined,
  at: string,
): boolean {
  if (!snapshot) return false;
  const now = snapshotAt(snapshot, at);
  if (now.state !== 'active') return false;
  return now.planId !== null && CUSTOMIZATION_PLAN_IDS.includes(now.planId);
}

/** Why a snapshot does not grant the capability, in one sentence. */
export function customizationRefusal(
  snapshot: EntitlementSnapshot | null | undefined,
  at: string,
): { code: CustomizationRefusalCode; reason: string } {
  const now = snapshot ? snapshotAt(snapshot, at) : null;
  if (now?.state === 'unknown')
    return {
      code: CUSTOMIZATION_REFUSAL.unknown,
      reason: `${CUSTOMIZATION_REQUIRES_PLAN} The plan could not be checked from this computer, and an unchecked plan is not treated as an active one.`,
    };
  const detail = now?.reason ? ` ${now.reason}` : '';
  return { code: CUSTOMIZATION_REFUSAL.noPlan, reason: `${CUSTOMIZATION_REQUIRES_PLAN}${detail}` };
}

// --- check two: may this actor author in this scope ---------------------------

/**
 * Whether this actor may create or change a theme stored under this scope.
 *
 * Two ways to yes, and they are not the same yes:
 *
 * - an active entitlement for a customization plan, in either scope; or
 * - the launch-time authoring authorization, on the **local** (personal) scope
 *   only. Authoring is a developer and designer affordance on one computer, so
 *   it can never reach a company's shared theme storage.
 *
 * A business scope additionally needs an active membership, checked before the
 * plan: someone who is not in the company is not refused for want of a plan.
 */
export function canEditThemeScope(
  actor: CustomizationActor,
  scope: WorkspaceRef,
): CustomizationDecision {
  if (isBusiness(scope)) {
    const membership = actor.membership ?? null;
    if (
      !membership ||
      membership.organizationId !== scope.organizationId ||
      membership.personId !== actor.personId ||
      !isActiveMember(membership)
    )
      return refuse(
        CUSTOMIZATION_REFUSAL.notAMember,
        'No active membership binds you to this business, so its themes are not yours to change.',
      );
    if (hasCustomizationEntitlement(actor.entitlement, actor.at))
      return { allowed: true, via: 'entitlement' };
    if (actor.authoring)
      return refuse(
        CUSTOMIZATION_REFUSAL.localScopeOnly,
        'Design authoring is on for this computer, and it covers your own themes only. A business theme needs the plan.',
      );
    const why = customizationRefusal(actor.entitlement, actor.at);
    return refuse(why.code, why.reason);
  }
  if (hasCustomizationEntitlement(actor.entitlement, actor.at))
    return { allowed: true, via: 'entitlement' };
  if (actor.authoring) return { allowed: true, via: 'authoring' };
  const why = customizationRefusal(actor.entitlement, actor.at);
  return refuse(why.code, why.reason);
}

// --- check three: may this actor put a revision in front of the company -------

/**
 * Whether this actor may make a theme revision the one their organization
 * wears. Being able to edit is not being able to publish: this is the
 * owner/admin question, answered by the one predicate that already owns it
 * (`canConfigureOrganization`), and design authoring never reaches it.
 */
export function canActivateOrganizationRevision(
  actor: CustomizationActor,
  organizationId: string,
): CustomizationDecision {
  const membership = actor.membership ?? null;
  if (
    !membership ||
    membership.organizationId !== organizationId ||
    membership.personId !== actor.personId ||
    !isActiveMember(membership)
  )
    return refuse(
      CUSTOMIZATION_REFUSAL.notAMember,
      'No active membership binds you to this business.',
    );
  if (!canConfigureOrganization(membership))
    return refuse(
      CUSTOMIZATION_REFUSAL.notOrganizationAdmin,
      'Only an owner or an admin can change what this business looks like to everyone in it.',
    );
  if (!hasCustomizationEntitlement(actor.entitlement, actor.at)) {
    const why = customizationRefusal(actor.entitlement, actor.at);
    return refuse(why.code, why.reason);
  }
  return { allowed: true, via: 'entitlement' };
}

// --- what the client is told --------------------------------------------------

/**
 * The answer `GET /api/design-center/entitlement` returns. The client reflects
 * this and decides nothing: every field here is derived on the server from
 * records the client cannot write.
 */
export interface CustomizationStatus {
  readonly capability: 'customization';
  /** True when premium authoring is available at all, by plan or by authoring. */
  readonly granted: boolean;
  readonly via: 'entitlement' | 'authoring' | 'none';
  /** The launch-time authoring authorization, surfaced so the badge can show. */
  readonly authoring: boolean;
  readonly entitlementState: EntitlementSnapshot['state'];
  readonly planId: string | null;
  /** Whether this person may activate a revision for the current workspace. */
  readonly canActivateForOrganization: boolean;
  readonly code: CustomizationRefusalCode | null;
  readonly reason: string;
  readonly freeFeatures: readonly string[];
  readonly paidFeatures: readonly string[];
}
