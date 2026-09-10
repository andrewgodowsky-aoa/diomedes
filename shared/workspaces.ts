/**
 * Workspaces, organizations and membership — contract version 1.
 *
 * The vocabulary the Personal/Business product contract requires be kept apart:
 * a Person, their Personal workspace, an Organization, a Membership, the
 * organization-owned Business setup, and an Entitlement. They are separate
 * records on purpose. A person keeps Personal and may belong to several
 * organizations; a sole proprietor is a valid Business customer; and none of
 * these ever becomes another by inference.
 *
 * Nothing here grants anything. Authority is resolved by `server/trust/`, not
 * by a role string in this file: a role decides who may *configure* an
 * organization, which is a different question from what a run may do. In
 * particular `Settings.onboarding.work === 'business'` is a preference someone
 * typed during first-run setup and carries no membership, credit or authority —
 * see `legacyBusinessPreference` below, which returns a note and nothing else.
 */

export const WORKSPACE_CONTRACT_VERSION = 1 as const;

/** Which workspace a person is acting in. Personal has no id: there is one. */
export type WorkspaceRef = { kind: 'personal' } | { kind: 'business'; organizationId: string };

export const PERSONAL: WorkspaceRef = Object.freeze({ kind: 'personal' });

export type MemberRole = 'owner' | 'admin' | 'member';
export const MEMBER_ROLES: readonly MemberRole[] = Object.freeze(['owner', 'admin', 'member']);

/**
 * `invited` is a record of an outstanding invitation, not a member. Only
 * `active` counts anywhere authority or configuration is decided.
 */
export type MembershipState = 'invited' | 'active' | 'revoked';

/**
 * Where an organization's identity comes from.
 *
 * `development-fixture` means this install created the organization locally
 * with no identity service behind it. It is a labelled fixture and must be
 * presented as one. `hosted` is reserved for an organization issued by a
 * production identity service; nothing in this build can produce one.
 */
export type IdentitySource = 'development-fixture' | 'hosted';

export interface Organization {
  v: typeof WORKSPACE_CONTRACT_VERSION;
  id: string;
  /** Display name. Selects examples and labels; never authority. */
  name: string;
  /** Optional industry hint. Same: examples, not permission. */
  industry: string | null;
  /** The tenant this organization's work is labelled and revoked under. */
  tenantId: string;
  identitySource: IdentitySource;
  createdAt: string;
  createdBy: string;
}

export interface Membership {
  v: typeof WORKSPACE_CONTRACT_VERSION;
  organizationId: string;
  personId: string;
  role: MemberRole;
  state: MembershipState;
  invitedAt: string;
  joinedAt: string | null;
  revokedAt: string | null;
  revokedReason: string | null;
}

/**
 * A local invitation record. It is how a second person joins an organization on
 * this install without an identity service: an owner or admin mints one, and
 * whoever redeems the code becomes a member in the role the inviter chose.
 * Redeeming is explicit and single-use. An email domain never appears here —
 * matching one must not create membership.
 */
export interface Invitation {
  v: typeof WORKSPACE_CONTRACT_VERSION;
  code: string;
  organizationId: string;
  role: MemberRole;
  createdAt: string;
  createdBy: string;
  expiresAt: string;
  redeemedAt: string | null;
  redeemedBy: string | null;
  revokedAt: string | null;
}

/**
 * The person this install acts as.
 *
 * `assurance` restates what `server/trust/` would say about a claim from this
 * person, so a caller does not have to guess. `development-fixture` means no
 * identity service authenticated anyone; the person is a local record.
 */
export interface Person {
  v: typeof WORKSPACE_CONTRACT_VERSION;
  id: string;
  name: string;
  assurance: IdentitySource;
  createdAt: string;
}

/**
 * What this installation may truthfully say about paid readiness: nothing.
 *
 * Entitlement is separate from identity and from runtime permission, and this
 * build has no entitlement service, so the only honest answer is `none` with
 * the reason. It is computed, never stored, so no record can drift into
 * claiming a plan that was never bought.
 */
export interface EntitlementView {
  plan: 'none';
  managedInference: false;
  reason: string;
}

export const NO_ENTITLEMENT_REASON =
  'This installation has no entitlement service. Managed Diomedes Agent access, included usage and billing are not available here, and no local record can grant them.';

export function entitlementFor(_organizationId: string): EntitlementView {
  return { plan: 'none', managedInference: false, reason: NO_ENTITLEMENT_REASON };
}

export const HOSTED_BUSINESS_UNAVAILABLE_REASON =
  'No production identity service is installed, so a hosted Business organization cannot be issued. Organizations created here are local development fixtures, labelled as such, and prove the flow rather than paid readiness.';

// --- predicates ---------------------------------------------------------------

export function isBusiness(ref: WorkspaceRef): ref is { kind: 'business'; organizationId: string } {
  return ref.kind === 'business';
}

export function sameWorkspace(a: WorkspaceRef, b: WorkspaceRef): boolean {
  if (a.kind !== b.kind) return false;
  return (
    a.kind !== 'business' || a.organizationId === (b as { organizationId: string }).organizationId
  );
}

/** An active membership is the only kind that counts. */
export function isActiveMember(membership: Membership | undefined | null): boolean {
  return membership?.state === 'active';
}

/**
 * Who may run or resume company setup: an active owner or admin, and nobody
 * else. An ordinary invitee joins the configuration that already exists.
 */
export function canConfigureOrganization(membership: Membership | undefined | null): boolean {
  return isActiveMember(membership) && membership!.role !== 'member';
}

/** Only an owner administers membership: roles, invitations and revocation. */
export function canAdministerMembers(membership: Membership | undefined | null): boolean {
  return isActiveMember(membership) && membership!.role === 'owner';
}

export function activeOwners(
  memberships: readonly Membership[],
  organizationId: string,
): Membership[] {
  return memberships.filter(
    (m) => m.organizationId === organizationId && m.state === 'active' && m.role === 'owner',
  );
}

/**
 * A legacy first-run answer of "Business" is a preference about the kind of
 * work, recorded before organizations existed. It is worth a sentence in the
 * interface and nothing more, so this returns a note rather than anything a
 * caller could mistake for a capability.
 */
export function legacyBusinessPreference(work: string | null | undefined): {
  present: boolean;
  note: string;
} {
  return work === 'business'
    ? {
        present: true,
        note: 'Setup recorded that you work on business projects. That is a preference about your own work; it does not create a business workspace, membership, credit or permission.',
      }
    : { present: false, note: '' };
}

/** How the active workspace reads in the interface. */
export function workspaceLabel(ref: WorkspaceRef, organizations: readonly Organization[]): string {
  if (ref.kind === 'personal') return 'Personal';
  const organization = organizations.find((item) => item.id === ref.organizationId);
  return organization ? `Business: ${organization.name}` : 'Business: unavailable';
}

/** The tenant a workspace labels its work under. Personal is local-only. */
export function tenantForWorkspace(
  ref: WorkspaceRef,
  organizations: readonly Organization[],
): string | null {
  if (ref.kind === 'personal') return null;
  return organizations.find((item) => item.id === ref.organizationId)?.tenantId ?? null;
}

// --- the view the client renders ---------------------------------------------

export interface OrganizationView {
  organization: Organization;
  membership: Membership;
  /** Present only for a member who may administer them. */
  members?: { personId: string; role: MemberRole; state: MembershipState }[];
  entitlement: EntitlementView;
  /** Where this organization's work is written, or null while nobody has said. */
  output: OutputBinding | null;
  setup: {
    state: string;
    schemaRevision: number;
    answered: number;
    required: number;
    resumable: boolean;
    /** True only when this person may start or resume company setup. */
    mayConfigure: boolean;
  } | null;
}

export interface WorkspaceView {
  v: typeof WORKSPACE_CONTRACT_VERSION;
  person: Person;
  active: WorkspaceRef;
  organizations: OrganizationView[];
  /** Organizations this person's membership was revoked from, so it can be said plainly. */
  revoked: { organizationId: string; name: string; revokedAt: string; reason: string | null }[];
  hosted: { available: boolean; reason: string };
  legacyPreference: { present: boolean; note: string };
}

// --- where a business job writes ----------------------------------------------

/**
 * The project one organization's work lands in.
 *
 * This exists because a business job has to write somewhere, and every implicit
 * answer to "where" is wrong in a way that is hard to see afterwards. The
 * project that happens to be open would let switching workspace mid-run
 * redirect a company's output. A project created on demand puts a company's
 * work somewhere nobody chose. So the answer is explicit, made once by somebody
 * with the authority to make it, and recorded per organization.
 *
 * `projectName` is stored alongside the id on purpose. When the project is gone
 * the binding must still be able to say which one it was, and a dangling id
 * cannot.
 */
export interface OutputBinding {
  readonly projectId: string;
  readonly projectName: string;
  readonly boundAt: string;
  readonly boundBy: string;
}

/** Choosing where a company writes is a configuration decision, not a member's. */
export function canBindOutputProject(membership: Membership | undefined | null): boolean {
  return canConfigureOrganization(membership);
}

export type BriefTargetRefusal = 'not-a-member' | 'no-output-project' | 'output-project-missing';

/**
 * Where this organization's brief goes, or why it goes nowhere.
 *
 * The resolved form carries `tenantId` as well as `projectId` so a caller holds
 * a whole target rather than a project id it would have to re-associate later.
 * A run that has resolved its target is bound to that tenant for its lifetime;
 * switching workspace afterwards changes what a person is looking at and
 * nothing about where the run writes.
 */
export type BriefTarget =
  | {
      readonly ready: true;
      readonly organizationId: string;
      readonly tenantId: string;
      readonly projectId: string;
      readonly projectName: string;
    }
  | { readonly ready: false; readonly code: BriefTargetRefusal; readonly message: string };

export function resolveBriefTarget(input: {
  organization: Organization;
  membership: Membership | undefined | null;
  binding: OutputBinding | null;
  projects: readonly { id: string; name: string }[];
}): BriefTarget {
  const { organization, membership, binding, projects } = input;
  if (!isActiveMember(membership))
    return {
      ready: false,
      code: 'not-a-member',
      message: `You are not an active member of ${organization.name}, so nothing runs for it here.`,
    };
  if (!binding)
    return {
      ready: false,
      code: 'no-output-project',
      message: `Choose the project ${organization.name} writes into. Its work is saved there for review, and nothing is written anywhere else.`,
    };
  const project = projects.find((candidate) => candidate.id === binding.projectId);
  // Deliberately not a fallback. A brief written into a project nobody chose is
  // worse than a brief that did not run, so this refuses and names what is
  // missing instead of finding somewhere plausible.
  if (!project)
    return {
      ready: false,
      code: 'output-project-missing',
      message: `${organization.name} writes into “${binding.projectName}”, and that project is not here any more. Choose where it writes now.`,
    };
  return {
    ready: true,
    organizationId: organization.id,
    tenantId: organization.tenantId,
    projectId: project.id,
    projectName: project.name,
  };
}
