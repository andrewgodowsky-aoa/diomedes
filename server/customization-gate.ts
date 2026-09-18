/**
 * Who may change how Diomedes looks, decided in one place.
 *
 * `shared/customization-entitlement.ts` holds the rules as pure predicates.
 * This file resolves the records those predicates read — the live workspace,
 * the person, their membership, the entitlement snapshot and the launch-time
 * authoring authorization — and turns a refusal into the `ApiError` the routes
 * throw. The routes stay a router: one `assert` call each.
 *
 * Three facts about where the answer comes from:
 *
 * - **The snapshot is never client input.** A business scope reads
 *   `workspaces.entitlementOf`, which today can only answer "none", adapted
 *   through the control-plane contract's own `snapshotFromView`. A personal
 *   scope has no entitlement service at all. No header, body field, settings
 *   value or package flag participates.
 * - **Authoring is a launch-time authorization.** `DIOMEDES_DESIGN_AUTHORING=1`
 *   is read once, from the environment the service was started in. It cannot be
 *   turned on from inside the running app, it grants authoring on the local
 *   scope only, and it grants no organization activation and no agent
 *   authority whatsoever.
 * - **Fixtures are a test seam, not a bypass.** `DIOMEDES_ENTITLEMENT_FIXTURE`
 *   selects a named profile from `fixtures/entitlement-states.json`, and only
 *   when `DIOMEDES_TEST_MODE=1` as well. A build with neither set can never
 *   reach the fixture table. The per-request header below is subject to the
 *   same two conditions: it can only pick a *different* fixture in a profile
 *   that already opted into fixtures, because one shared dev server has to
 *   answer for six named states in the browser suite.
 */
import type { Request } from 'express';
import {
  NO_ENTITLEMENT_SNAPSHOT,
  snapshotAt,
  snapshotFromView,
  type EntitlementSnapshot,
} from '../services/control-plane/contract/index.js';
import {
  CUSTOMIZATION_REFUSAL,
  FREE_APPEARANCE_FEATURES,
  PAID_CUSTOMIZATION_FEATURES,
  canActivateOrganizationRevision,
  canEditThemeScope,
  hasCustomizationEntitlement,
  type CustomizationActor,
  type CustomizationDecision,
  type CustomizationStatus,
} from '../shared/customization-entitlement.js';
import {
  isBusiness,
  type EntitlementView,
  type Membership,
  type WorkspaceRef,
} from '../shared/workspaces.js';
import { ApiError } from './paths.js';
import fixtureFile from '../fixtures/entitlement-states.json' with { type: 'json' };

/** The header the browser suite uses to pick a fixture per test. Test mode only. */
export const ENTITLEMENT_FIXTURE_HEADER = 'x-diomedes-entitlement-fixture';

interface FixtureProfile {
  readonly authoring: boolean;
  readonly snapshot: EntitlementSnapshot;
}

const PROFILES = fixtureFile.profiles as unknown as Readonly<Record<string, FixtureProfile>>;

/** What the gate needs from the workspace service. Injectable for tests. */
export interface CustomizationGateSource {
  workspace(): WorkspaceRef;
  personId(): string;
  membershipOf(organizationId: string, personId: string): Membership | undefined;
  entitlementOf(organizationId: string): EntitlementView;
}

export class CustomizationGate {
  /** Read once, at construction, from the environment the service started in. */
  private readonly launchAuthoring: boolean;
  /** The fixture profile named at launch, or null when fixtures are off. */
  private readonly launchFixture: string | null;

  constructor(
    private readonly source: CustomizationGateSource,
    env: NodeJS.ProcessEnv = process.env,
  ) {
    this.launchAuthoring = env.DIOMEDES_DESIGN_AUTHORING === '1';
    const named = env.DIOMEDES_ENTITLEMENT_FIXTURE ?? '';
    this.launchFixture =
      env.DIOMEDES_TEST_MODE === '1' && named !== '' && named in PROFILES ? named : null;
  }

  /** Whether the fixture table may be consulted at all in this process. */
  private get fixturesEnabled(): boolean {
    return this.launchFixture !== null;
  }

  /** The launch-time authorization, for Settings > Developer to state read-only. */
  get designAuthoring(): boolean {
    return this.launchAuthoring || (this.profileFor(null)?.authoring ?? false);
  }

  private profileFor(name: string | null): FixtureProfile | null {
    if (!this.fixturesEnabled) return null;
    const chosen = name ?? this.launchFixture;
    return (chosen !== null && PROFILES[chosen]) || null;
  }

  /**
   * The fixture this request asked for, when the process already runs on
   * fixtures. Anything unrecognised falls back to the launch profile rather
   * than inventing a state.
   */
  private requestedProfile(req: Request | null): FixtureProfile | null {
    if (!this.fixturesEnabled) return null;
    const header = req?.headers[ENTITLEMENT_FIXTURE_HEADER];
    const name = typeof header === 'string' && header.trim() !== '' ? header.trim() : null;
    return this.profileFor(name);
  }

  /**
   * The entitlement this installation may truthfully claim for a scope.
   *
   * Outside a fixture profile there is no entitlement service, so the honest
   * answer is the contract's own refusal. A business scope routes through
   * `snapshotFromView` so that when an entitlement service does exist, this is
   * the one line that changes.
   */
  private snapshotFor(scope: WorkspaceRef, profile: FixtureProfile | null): EntitlementSnapshot {
    if (profile) return profile.snapshot;
    if (isBusiness(scope)) return snapshotFromView(this.source.entitlementOf(scope.organizationId));
    return NO_ENTITLEMENT_SNAPSHOT;
  }

  /** Everything the pure checks read, resolved from live records. */
  actor(req: Request | null = null, at = new Date().toISOString()): CustomizationActor {
    const profile = this.requestedProfile(req);
    const scope = this.source.workspace();
    const personId = this.source.personId();
    return {
      personId,
      entitlement: this.snapshotFor(scope, profile),
      authoring: this.launchAuthoring || (profile?.authoring ?? false),
      membership: isBusiness(scope)
        ? (this.source.membershipOf(scope.organizationId, personId) ?? null)
        : null,
      at,
    };
  }

  /** The scope every Design Center mutation is stored under. */
  scope(): WorkspaceRef {
    return this.source.workspace();
  }

  /** What `GET /api/design-center/entitlement` answers. */
  status(req: Request | null = null): CustomizationStatus {
    const actor = this.actor(req);
    const scope = this.source.workspace();
    const decision = canEditThemeScope(actor, scope);
    const observed = snapshotAt(actor.entitlement, actor.at);
    const activate = isBusiness(scope)
      ? canActivateOrganizationRevision(actor, scope.organizationId)
      : { allowed: false as const, code: CUSTOMIZATION_REFUSAL.notAMember, reason: '' };
    return {
      capability: 'customization',
      granted: decision.allowed,
      via: decision.allowed ? decision.via : 'none',
      authoring: actor.authoring,
      entitlementState: observed.state,
      planId: observed.planId,
      canActivateForOrganization: activate.allowed,
      code: decision.allowed ? null : decision.code,
      reason: decision.allowed ? '' : decision.reason,
      freeFeatures: FREE_APPEARANCE_FEATURES,
      paidFeatures: PAID_CUSTOMIZATION_FEATURES,
    };
  }

  /** True when the capability itself is granted, ignoring scope and role. */
  entitled(req: Request | null = null): boolean {
    const actor = this.actor(req);
    return hasCustomizationEntitlement(actor.entitlement, actor.at);
  }

  private enforce(decision: CustomizationDecision): void {
    if (decision.allowed) return;
    throw new ApiError(403, decision.reason, { code: decision.code });
  }

  /**
   * Authoring a theme in the scope it is stored under: saving, autosaving,
   * importing pictures, restoring a revision. Everything free — reading,
   * discarding a draft, the safe reset — never comes through here.
   */
  assertCanAuthor(req: Request): void {
    this.enforce(canEditThemeScope(this.actor(req), this.source.workspace()));
  }

  /**
   * Making a theme the one the app wears. In a personal scope that is the same
   * question as authoring; in a business scope it is additionally the
   * owner/admin question, and design authoring never answers it.
   */
  assertCanActivate(req: Request): void {
    const scope = this.source.workspace();
    const actor = this.actor(req);
    if (!isBusiness(scope)) {
      this.enforce(canEditThemeScope(actor, scope));
      return;
    }
    this.enforce(canEditThemeScope(actor, scope));
    this.enforce(canActivateOrganizationRevision(actor, scope.organizationId));
  }
}
