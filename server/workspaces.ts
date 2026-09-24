/**
 * Organizations, membership and the Business intake.
 *
 *   <data>/workspaces/identity.json    the person this install acts as
 *   <data>/workspaces/registry.json    organizations, memberships, invitations
 *   <data>/workspaces/setup/<org>.json one organization's intake answers
 *
 * Three boundaries this module exists to hold:
 *
 * 1. **Identity is not invented here.** `server/trust/` owns who is acting, and
 *    its production backend is not installed, so no hosted organization can be
 *    issued. What this module creates is a labelled local fixture, and it says
 *    so in every view. It does not authenticate anyone and never claims to.
 *
 * 2. **The questionnaire is gated at the host.** Every setup route runs
 *    `configuring()`, which requires an active Business workspace, an active
 *    membership, owner-or-admin authority, and a setup that is new or was
 *    explicitly resumed. A renderer that forgot a check cannot get past it, and
 *    Personal has no route into the intake at all.
 *
 * 3. **Membership is the only thing that grants membership.** Not a legacy
 *    onboarding preference, not an email domain, not an answer someone typed
 *    into the intake proposing who should approve things. Revoking a membership
 *    bumps the tenant's Trust identity generation, so references minted under it
 *    stop resolving at their next check rather than at some later cleanup.
 */
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import {
  BUSINESS_SETUP_SCHEMA_REVISION,
  REVIEW_STEP,
  AFTER_PROPOSAL,
  UNIMPLEMENTED_SETUP_REASON,
  collectFacts,
  nextStep,
  previousStep,
  progress,
  readyForProposal,
  validateAnswer,
  type AnswerValue,
  type BusinessAnswer,
  type BusinessSetup,
  type BusinessSetupView,
} from '../shared/business-setup.js';
import {
  AUTHORIZATION_RESOURCE_TYPES,
  authorizeBusinessAccess,
  BUSINESS_ACCESS_CONTRACT_VERSION,
  BUSINESS_PERMISSIONS,
  isBusinessPermission,
  isWorkerPermission,
  normalizeBusinessPermissions,
  organizationRootResourceId,
  resourcesVisibleTo,
  systemOwnerAssignmentId,
  systemOwnerProfileId,
  type AccessAssignment,
  type AccessDecision,
  type AccessProfile,
  type AuthorizationResource,
  type AuthorizationResourceType,
  type OrganizationAccessView,
  type ResourceScope,
  type WorkerProfile,
} from '../shared/business-access.js';
import {
  HOSTED_BUSINESS_UNAVAILABLE_REASON,
  MEMBER_ROLES,
  PERSONAL,
  WORKSPACE_CONTRACT_VERSION,
  activeOwners,
  canAdministerMembers,
  canBindOutputProject,
  canConfigureOrganization,
  entitlementFor,
  isActiveMember,
  legacyBusinessPreference,
  resolveBriefTarget,
  type BriefTarget,
  type Invitation,
  type MemberRole,
  type Membership,
  type Organization,
  type OrganizationView,
  type OutputBinding,
  type Person,
  type WorkspaceRef,
  type WorkspaceView,
} from '../shared/workspaces.js';
import { payloadDigest } from './command-admission.js';
import { ApiError } from './paths.js';
import { jsonWrite, readJson, type Store } from './store.js';
import { revokeTenant, trustBackendInstalled } from './trust/index.js';

interface Registry {
  v: typeof WORKSPACE_CONTRACT_VERSION;
  organizations: Organization[];
  memberships: Membership[];
  invitations: Invitation[];
  /** Where each organization's work is written, keyed by organization id. */
  outputs: Record<string, OutputBinding>;
  access: {
    resources: AuthorizationResource[];
    profiles: AccessProfile[];
    assignments: AccessAssignment[];
    workerProfiles: WorkerProfile[];
    organizationGenerations: Record<string, number>;
    principalGenerations: Record<string, number>;
  };
}

const emptyRegistry = (): Registry => ({
  v: WORKSPACE_CONTRACT_VERSION,
  organizations: [],
  memberships: [],
  invitations: [],
  outputs: {},
  access: {
    resources: [],
    profiles: [],
    assignments: [],
    workerProfiles: [],
    organizationGenerations: {},
    principalGenerations: {},
  },
});

const INVITATION_DAYS = 7;
const MAX_ORGANIZATIONS = 32;

const token = (bytes = 9) => randomBytes(bytes).toString('base64url');
const now = () => new Date().toISOString();

/** The digest a concurrent editor compares against. Order-independent. */
export function answersDigest(answers: Readonly<Record<string, BusinessAnswer>>): string {
  return payloadDigest({
    type: 'business.setup.answers',
    schemaRevision: BUSINESS_SETUP_SCHEMA_REVISION,
    answers: Object.keys(answers)
      .sort()
      .map((id) => {
        const answer = answers[id]!;
        return { id, value: answer.value, unknown: answer.unknown, origin: answer.origin };
      }),
  });
}

const refuse = (status: number, message: string, code: string) =>
  new ApiError(status, message, { code });

export class WorkspaceService {
  private registry: Registry = emptyRegistry();
  private person: Person | null = null;
  private readonly setups = new Map<string, BusinessSetup>();

  constructor(private readonly store: Store) {}

  private get root() {
    return path.join(this.store.dataDir, 'workspaces');
  }
  private get registryPath() {
    return path.join(this.root, 'registry.json');
  }
  private get identityPath() {
    return path.join(this.root, 'identity.json');
  }
  private setupPath(organizationId: string) {
    return path.join(this.root, 'setup', `${organizationId}.json`);
  }

  async init() {
    this.registry = await readJson<Registry>(this.registryPath, emptyRegistry);
    this.registry.organizations ??= [];
    this.registry.memberships ??= [];
    this.registry.invitations ??= [];
    this.registry.outputs ??= {};
    this.registry.access ??= emptyRegistry().access;
    this.registry.access.resources ??= [];
    this.registry.access.profiles ??= [];
    this.registry.access.assignments ??= [];
    this.registry.access.workerProfiles ??= [];
    this.registry.access.organizationGenerations ??= {};
    this.registry.access.principalGenerations ??= {};
    this.person = await readJson<Person | null>(this.identityPath, () => null);
    if (!this.person) {
      // No identity service authenticated anyone. This record exists so the
      // rest of the flow has a stable subject to attribute answers to; it is a
      // fixture and every view that shows it says so.
      this.person = {
        v: WORKSPACE_CONTRACT_VERSION,
        id: `person_${token(8)}`,
        name: 'You',
        assurance: 'development-fixture',
        createdAt: now(),
      };
      await jsonWrite(this.identityPath, this.person);
    }
    for (const organization of this.registry.organizations) {
      const setup = await readJson<BusinessSetup | null>(
        this.setupPath(organization.id),
        () => null,
      );
      if (setup) this.setups.set(organization.id, setup);
    }
    const accessChanged = this.ensureAccessFoundations();
    if (accessChanged) await this.saveRegistry();
  }

  /**
   * Hosted Business needs a production Trust resolver. There is none, so this
   * is false in every build that has not installed one — read from the resolver
   * itself rather than from a setting, so a preference cannot turn it on.
   */
  hostedAvailable(): boolean {
    return trustBackendInstalled();
  }

  currentPerson(): Person {
    if (!this.person) throw new Error('The workspace service was used before init().');
    return this.person;
  }

  private async saveRegistry() {
    await jsonWrite(this.registryPath, this.registry);
  }

  private async saveSetup(setup: BusinessSetup) {
    this.setups.set(setup.organizationId, setup);
    await jsonWrite(this.setupPath(setup.organizationId), setup);
  }

  private principalGenerationKey(organizationId: string, personId: string): string {
    return `${organizationId}:${personId}`;
  }

  private organizationGeneration(organizationId: string): number {
    return this.registry.access.organizationGenerations[organizationId] ?? 0;
  }

  private principalGeneration(organizationId: string, personId: string): number {
    return (
      this.registry.access.principalGenerations[
        this.principalGenerationKey(organizationId, personId)
      ] ?? 0
    );
  }

  private bumpOrganizationGeneration(organizationId: string): void {
    this.registry.access.organizationGenerations[organizationId] =
      this.organizationGeneration(organizationId) + 1;
  }

  private bumpPrincipalGeneration(organizationId: string, personId: string): void {
    const key = this.principalGenerationKey(organizationId, personId);
    this.registry.access.principalGenerations[key] =
      this.principalGeneration(organizationId, personId) + 1;
  }

  private accessProfileDigest(input: {
    organizationId: string;
    id: string;
    revision: number;
    name: string;
    description: string;
    systemKind: AccessProfile['systemKind'];
    permissions: readonly string[];
  }): string {
    return payloadDigest({ type: 'business.access.profile', ...input });
  }

  private workerProfileDigest(input: {
    organizationId: string;
    id: string;
    revision: number;
    name: string;
    purpose: string;
    executionMode: WorkerProfile['executionMode'];
    agent: WorkerProfile['agent'];
    permissionCeilings: readonly string[];
    resourceCeilings: readonly ResourceScope[];
    contextCeilings: readonly string[];
    toolCeilings: readonly string[];
    ruleScopes: readonly string[];
    routeCeilings: readonly string[];
  }): string {
    return payloadDigest({ type: 'business.worker.profile', ...input });
  }

  /**
   * Add protected organization roots and Owner assignments to old registries.
   * This is an additive migration inside the existing workspace registry, not
   * another organization or authority store.
   */
  private ensureAccessFoundations(): boolean {
    let changed = false;
    const access = this.registry.access;
    for (const organization of this.registry.organizations) {
      const rootId = organizationRootResourceId(organization.id);
      if (!access.resources.some((resource) => resource.id === rootId)) {
        access.resources.push({
          v: BUSINESS_ACCESS_CONTRACT_VERSION,
          organizationId: organization.id,
          id: rootId,
          type: 'organization',
          parentId: null,
          externalId: organization.id,
          label: organization.name,
          state: 'active',
          revision: 1,
        });
        changed = true;
      }

      const ownerProfileId = systemOwnerProfileId(organization.id);
      if (
        !access.profiles.some(
          (profile) =>
            profile.organizationId === organization.id &&
            profile.id === ownerProfileId &&
            profile.revision === 1,
        )
      ) {
        const name = 'Owner';
        const description =
          'Protected organization-wide access. Exact effect approvals and data-route choices remain separate.';
        access.profiles.push({
          v: BUSINESS_ACCESS_CONTRACT_VERSION,
          organizationId: organization.id,
          id: ownerProfileId,
          revision: 1,
          name,
          description,
          systemKind: 'owner',
          state: 'active',
          permissions: [...BUSINESS_PERMISSIONS],
          digest: this.accessProfileDigest({
            organizationId: organization.id,
            id: ownerProfileId,
            revision: 1,
            name,
            description,
            systemKind: 'owner',
            permissions: BUSINESS_PERMISSIONS,
          }),
          createdAt: organization.createdAt,
          createdBy: 'system',
        });
        changed = true;
      }

      for (const membership of this.registry.memberships.filter(
        (candidate) =>
          candidate.organizationId === organization.id &&
          candidate.state === 'active' &&
          candidate.role === 'owner',
      )) {
        const activeAssignment = access.assignments.some(
          (assignment) =>
            assignment.organizationId === organization.id &&
            assignment.personId === membership.personId &&
            assignment.profileId === ownerProfileId &&
            assignment.profileRevision === 1 &&
            assignment.revokedAt === null,
        );
        if (activeAssignment) continue;
        const baseId = systemOwnerAssignmentId(organization.id, membership.personId);
        const id = access.assignments.some((assignment) => assignment.id === baseId)
          ? `${baseId}:${token(4)}`
          : baseId;
        access.assignments.push({
          v: BUSINESS_ACCESS_CONTRACT_VERSION,
          organizationId: organization.id,
          id,
          personId: membership.personId,
          profileId: ownerProfileId,
          profileRevision: 1,
          scopes: [{ resourceId: rootId, includeDescendants: true }],
          revision: 1,
          createdAt: membership.joinedAt ?? membership.invitedAt,
          createdBy: 'system',
          revokedAt: null,
          revokedBy: null,
        });
        changed = true;
      }

      if (access.organizationGenerations[organization.id] === undefined) {
        access.organizationGenerations[organization.id] = 1;
        changed = true;
      }
      for (const membership of this.registry.memberships.filter(
        (candidate) => candidate.organizationId === organization.id,
      )) {
        const key = this.principalGenerationKey(organization.id, membership.personId);
        if (access.principalGenerations[key] === undefined) {
          access.principalGenerations[key] = 1;
          changed = true;
        }
      }
    }

    const outputOwners = new Map<string, string | null>();
    for (const [organizationId, binding] of Object.entries(this.registry.outputs)) {
      const previous = outputOwners.get(binding.projectId);
      outputOwners.set(
        binding.projectId,
        previous === undefined ? organizationId : previous === organizationId ? previous : null,
      );
    }
    for (const [projectId, organizationId] of outputOwners) {
      if (!organizationId) continue;
      if (
        access.resources.some(
          (resource) =>
            resource.type === 'project' &&
            resource.externalId === projectId &&
            resource.state === 'active',
        )
      )
        continue;
      const organization = this.organization(organizationId);
      const binding = this.registry.outputs[organizationId];
      if (!organization || !binding) continue;
      access.resources.push({
        v: BUSINESS_ACCESS_CONTRACT_VERSION,
        organizationId,
        id: `project:${projectId}`,
        type: 'project',
        parentId: organizationRootResourceId(organizationId),
        externalId: projectId,
        label: binding.projectName,
        state: 'active',
        revision: 1,
      });
      changed = true;
    }
    return changed;
  }

  organization(id: string): Organization | undefined {
    return this.registry.organizations.find((item) => item.id === id);
  }

  membershipOf(organizationId: string, personId = this.currentPerson().id): Membership | undefined {
    return this.registry.memberships.find(
      (item) => item.organizationId === organizationId && item.personId === personId,
    );
  }

  // --- active workspace -------------------------------------------------------

  /**
   * The workspace this person is acting in.
   *
   * A stored Business reference is only honoured while the membership behind it
   * is still active: a revoked member, or an organization that is gone, reads
   * as Personal. That is checked on every read rather than at revocation time,
   * so a stale settings file cannot keep someone inside a business they left.
   */
  active(): WorkspaceRef {
    const stored = this.store.settings.activeWorkspace;
    if (!stored || stored.kind !== 'business') return PERSONAL;
    if (!this.organization(stored.organizationId)) return PERSONAL;
    return isActiveMember(this.membershipOf(stored.organizationId)) ? stored : PERSONAL;
  }

  /** True when a stored Business reference no longer names a live membership. */
  private needsReconcile(): boolean {
    const stored = this.store.settings.activeWorkspace;
    return stored?.kind === 'business' && this.active().kind === 'personal';
  }

  /** Persist the fallback when a stored reference has stopped being valid. */
  private async reconcileActive() {
    if (this.needsReconcile())
      await this.store.saveSettings({ ...this.store.settings, activeWorkspace: PERSONAL });
  }

  async switchTo(ref: WorkspaceRef): Promise<WorkspaceView> {
    if (ref.kind === 'business') {
      const organization = this.organization(ref.organizationId);
      if (!organization)
        throw refuse(404, 'That business workspace does not exist here.', 'unknown_organization');
      const membership = this.membershipOf(ref.organizationId);
      if (!membership || membership.state === 'revoked')
        throw refuse(
          403,
          'Your access to this business workspace has been removed.',
          'membership_revoked',
        );
      if (!isActiveMember(membership))
        throw refuse(
          403,
          'Accept the invitation before opening this workspace.',
          'membership_inactive',
        );
    }
    await this.store.saveSettings({
      ...this.store.settings,
      activeWorkspace: ref.kind === 'business' ? { ...ref } : PERSONAL,
    });
    return this.view();
  }

  // --- organizations ----------------------------------------------------------

  async createOrganization(input: {
    name: string;
    industry?: string | null;
  }): Promise<WorkspaceView> {
    const name = String(input.name ?? '').trim();
    if (name.length < 2 || name.length > 120)
      throw refuse(400, 'Give the business a name between 2 and 120 characters.', 'invalid_name');
    const industry =
      input.industry == null ? null : String(input.industry).trim().slice(0, 60) || null;
    if (this.registry.organizations.length >= MAX_ORGANIZATIONS)
      throw refuse(
        409,
        'This installation already holds the maximum number of business workspaces.',
        'too_many_organizations',
      );
    const person = this.currentPerson();
    const id = `org_${token(8)}`;
    const at = now();
    const organization: Organization = {
      v: WORKSPACE_CONTRACT_VERSION,
      id,
      name,
      industry,
      tenantId: `org:${id}`,
      // Not a hosted organization, and not presented as one. Creating it proves
      // the flow; it does not prove identity, entitlement or paid readiness.
      identitySource: 'development-fixture',
      createdAt: at,
      createdBy: person.id,
    };
    this.registry.organizations.push(organization);
    this.registry.memberships.push({
      v: WORKSPACE_CONTRACT_VERSION,
      organizationId: id,
      personId: person.id,
      role: 'owner',
      state: 'active',
      invitedAt: at,
      joinedAt: at,
      revokedAt: null,
      revokedReason: null,
    });
    this.ensureAccessFoundations();
    await this.saveRegistry();
    await this.store.saveSettings({
      ...this.store.settings,
      activeWorkspace: { kind: 'business', organizationId: id },
    });
    return this.view();
  }

  /** Mint a single-use invitation. Owners only; the role is the inviter's choice. */
  async invite(organizationId: string, role: MemberRole): Promise<Invitation> {
    const organization = this.organization(organizationId);
    if (!organization)
      throw refuse(404, 'That business workspace does not exist here.', 'unknown_organization');
    if (!canAdministerMembers(this.membershipOf(organizationId)))
      throw refuse(403, 'Only an owner can invite people to this workspace.', 'not_owner');
    if (!MEMBER_ROLES.includes(role))
      throw refuse(400, 'Choose a role for the invitation.', 'invalid_role');
    const at = now();
    const invitation: Invitation = {
      v: WORKSPACE_CONTRACT_VERSION,
      code: token(12),
      organizationId,
      role,
      createdAt: at,
      createdBy: this.currentPerson().id,
      expiresAt: new Date(Date.now() + INVITATION_DAYS * 86_400_000).toISOString(),
      redeemedAt: null,
      redeemedBy: null,
      revokedAt: null,
    };
    this.registry.invitations.push(invitation);
    await this.saveRegistry();
    return invitation;
  }

  /**
   * Join an existing organization by redeeming an invitation.
   *
   * There is no other way in. An email address, a matching domain or a name
   * that looks like the company's does not join anyone to anything.
   */
  async join(code: string): Promise<WorkspaceView> {
    const value = String(code ?? '').trim();
    const invitation = this.registry.invitations.find((item) => item.code === value);
    if (!invitation)
      throw refuse(404, 'That invitation code was not recognised.', 'unknown_invitation');
    if (invitation.revokedAt)
      throw refuse(403, 'That invitation was withdrawn.', 'invitation_revoked');
    if (invitation.redeemedAt)
      throw refuse(409, 'That invitation has already been used.', 'invitation_used');
    if (Date.parse(invitation.expiresAt) <= Date.now())
      throw refuse(
        403,
        'That invitation has expired. Ask an owner for a new one.',
        'invitation_expired',
      );
    const organization = this.organization(invitation.organizationId);
    if (!organization)
      throw refuse(404, 'That business workspace no longer exists.', 'unknown_organization');
    const person = this.currentPerson();
    const existing = this.membershipOf(invitation.organizationId, person.id);
    if (existing && existing.state === 'active')
      throw refuse(409, 'You are already a member of this business workspace.', 'already_member');
    const at = now();
    if (existing) {
      existing.role = invitation.role;
      existing.state = 'active';
      existing.joinedAt = at;
      existing.revokedAt = null;
      existing.revokedReason = null;
    } else {
      this.registry.memberships.push({
        v: WORKSPACE_CONTRACT_VERSION,
        organizationId: invitation.organizationId,
        personId: person.id,
        role: invitation.role,
        state: 'active',
        invitedAt: invitation.createdAt,
        joinedAt: at,
        revokedAt: null,
        revokedReason: null,
      });
    }
    invitation.redeemedAt = at;
    invitation.redeemedBy = person.id;
    this.ensureAccessFoundations();
    this.bumpOrganizationGeneration(invitation.organizationId);
    this.bumpPrincipalGeneration(invitation.organizationId, person.id);
    await this.saveRegistry();
    await this.store.saveSettings({
      ...this.store.settings,
      activeWorkspace: { kind: 'business', organizationId: invitation.organizationId },
    });
    return this.view();
  }

  /**
   * Remove someone's access. The last active owner cannot be removed, so an
   * organization can never be left with nobody able to administer it.
   */
  async revokeMember(
    organizationId: string,
    personId: string,
    reason: string,
  ): Promise<WorkspaceView> {
    const organization = this.organization(organizationId);
    if (!organization)
      throw refuse(404, 'That business workspace does not exist here.', 'unknown_organization');
    if (!canAdministerMembers(this.membershipOf(organizationId)))
      throw refuse(403, 'Only an owner can remove access to this workspace.', 'not_owner');
    const membership = this.membershipOf(organizationId, personId);
    if (!membership || membership.state === 'revoked')
      throw refuse(404, 'That person is not a member of this workspace.', 'unknown_membership');
    if (
      membership.role === 'owner' &&
      activeOwners(this.registry.memberships, organizationId).length <= 1
    )
      throw refuse(409, 'This is the last owner. Make someone else an owner first.', 'last_owner');
    membership.state = 'revoked';
    membership.revokedAt = now();
    membership.revokedReason =
      String(reason ?? '')
        .trim()
        .slice(0, 200) || null;
    for (let index = 0; index < this.registry.access.assignments.length; index += 1) {
      const assignment = this.registry.access.assignments[index]!;
      if (
        assignment.organizationId !== organizationId ||
        assignment.personId !== personId ||
        assignment.revokedAt !== null
      )
        continue;
      this.registry.access.assignments[index] = {
        ...assignment,
        revision: assignment.revision + 1,
        revokedAt: membership.revokedAt,
        revokedBy: this.currentPerson().id,
      };
    }
    this.bumpOrganizationGeneration(organizationId);
    this.bumpPrincipalGeneration(organizationId, personId);
    await this.saveRegistry();
    // Every Trust reference minted under this tenant stops resolving at its next
    // check. Work already dispatched parks and reconciles rather than writing.
    await revokeTenant(organization.tenantId, 'A membership in this organization was revoked.');
    await this.reconcileActive();
    return this.view();
  }

  // --- the Business intake ----------------------------------------------------

  /**
   * The one gate. Every setup route calls it, and it answers four questions
   * before any of them run: is this an active Business workspace, is this
   * person an active member, may they configure the organization, and is the
   * stored setup one this build understands.
   */
  private configuring(organizationId: string): {
    organization: Organization;
    setup: BusinessSetup | null;
  } {
    const organization = this.organization(organizationId);
    if (!organization)
      throw refuse(404, 'That business workspace does not exist here.', 'unknown_organization');
    const active = this.active();
    if (active.kind !== 'business' || active.organizationId !== organizationId)
      throw refuse(
        409,
        'Business setup runs in the business workspace it belongs to. Switch to it first.',
        'workspace_not_active',
      );
    const membership = this.membershipOf(organizationId);
    if (!membership || membership.state === 'revoked')
      throw refuse(
        403,
        'Your access to this business workspace has been removed.',
        'membership_revoked',
      );
    if (!isActiveMember(membership))
      throw refuse(
        403,
        'Accept the invitation before configuring this workspace.',
        'membership_inactive',
      );
    if (!canConfigureOrganization(membership))
      throw refuse(
        403,
        'An owner or administrator sets this workspace up. You join the configuration they have already made.',
        'not_configurator',
      );
    const setup = this.setups.get(organizationId) ?? null;
    if (setup && setup.tenantId !== organization.tenantId)
      throw refuse(409, 'This saved setup belongs to a different tenant.', 'tenant_mismatch');
    return { organization, setup };
  }

  /** A stored setup from an older schema is refused until it is explicitly resumed. */
  private requireCurrentSchema(setup: BusinessSetup) {
    if (setup.schemaRevision !== BUSINESS_SETUP_SCHEMA_REVISION)
      throw refuse(
        409,
        'This setup was saved by an earlier version of the questions. Resume it to continue with the current ones.',
        'stale_setup',
      );
  }

  /** Drafting is the only state that accepts answers; the rest must be resumed. */
  private requireDrafting(setup: BusinessSetup) {
    this.requireCurrentSchema(setup);
    if (setup.state === 'drafting') return;
    if (setup.state === 'proposal-ready' || setup.state === 'paused')
      throw refuse(
        409,
        'This setup is finished being drafted. Resume it to make a new proposal.',
        'resume_required',
      );
    throw refuse(409, UNIMPLEMENTED_SETUP_REASON, 'setup_state_unsupported');
  }

  setupView(organizationId: string) {
    const { organization, setup } = this.configuring(organizationId);
    return this.presentSetup(organization, setup);
  }

  private presentSetup(organization: Organization, setup: BusinessSetup | null): BusinessSetupView {
    const answers = setup?.answers ?? {};
    const counts = progress(answers);
    const stale = setup !== null && setup.schemaRevision !== BUSINESS_SETUP_SCHEMA_REVISION;
    return {
      organization: {
        id: organization.id,
        name: organization.name,
        identitySource: organization.identitySource,
      },
      state: setup?.state ?? 'not-started',
      schemaRevision: setup?.schemaRevision ?? BUSINESS_SETUP_SCHEMA_REVISION,
      currentSchemaRevision: BUSINESS_SETUP_SCHEMA_REVISION,
      stale,
      step: stale ? REVIEW_STEP : (setup?.cursor ?? nextStep(answers)),
      previous: setup ? previousStep(answers, setup.cursor) : null,
      answers,
      facts: collectFacts(answers),
      progress: counts,
      ready: readyForProposal(answers),
      digest: answersDigest(answers),
      proposalDigest: setup?.proposalDigest ?? null,
      /** What this build does after a proposal, said plainly rather than implied. */
      afterProposal: AFTER_PROPOSAL,
    };
  }

  /** Start a new intake, or resume one that had stopped. Both are explicit. */
  async startSetup(organizationId: string, mode: 'start' | 'resume') {
    const { organization, setup } = this.configuring(organizationId);
    const person = this.currentPerson();
    const at = now();
    if (!setup) {
      if (mode !== 'start')
        throw refuse(
          409,
          'There is no saved setup to resume for this workspace.',
          'nothing_to_resume',
        );
      const fresh: BusinessSetup = {
        v: 1,
        organizationId,
        tenantId: organization.tenantId,
        schemaRevision: BUSINESS_SETUP_SCHEMA_REVISION,
        state: 'drafting',
        answers: {},
        cursor: nextStep({}),
        startedAt: at,
        startedBy: person.id,
        updatedAt: at,
        proposalDigest: null,
      };
      await this.saveSetup(fresh);
      return this.presentSetup(organization, fresh);
    }
    if (mode === 'start' && setup.state !== 'not-started')
      throw refuse(
        409,
        'This workspace already has a saved setup. Resume it rather than starting a second one.',
        'setup_exists',
      );
    // Resuming a finished draft starts a new proposal from the same answers; it
    // does not reopen the old one, and it never edits anything already active.
    const answers = setup.schemaRevision === BUSINESS_SETUP_SCHEMA_REVISION ? setup.answers : {};
    const resumed: BusinessSetup = {
      ...setup,
      schemaRevision: BUSINESS_SETUP_SCHEMA_REVISION,
      answers,
      state: 'drafting',
      cursor: nextStep(answers),
      proposalDigest: null,
      updatedAt: at,
    };
    await this.saveSetup(resumed);
    return this.presentSetup(organization, resumed);
  }

  async answer(
    organizationId: string,
    input: { questionId: string; value: AnswerValue; unknown?: boolean; expectedDigest?: string },
  ) {
    const { organization, setup } = this.configuring(organizationId);
    if (!setup) throw refuse(409, 'Start the setup for this workspace first.', 'setup_not_started');
    this.requireDrafting(setup);
    // Two administrators editing at once conflict rather than overwriting each
    // other: the second one is told, and decides what to do about it.
    if (input.expectedDigest && input.expectedDigest !== answersDigest(setup.answers))
      throw refuse(
        409,
        'Someone else changed this setup while you were answering. Reload it and try again.',
        'setup_conflict',
      );
    const checked = validateAnswer(
      String(input.questionId),
      { value: input.value ?? null, unknown: input.unknown === true },
      setup.answers,
    );
    if (!checked.ok)
      throw refuse(
        400,
        checked.problem.message,
        `answer_${checked.problem.code.replaceAll('-', '_')}`,
      );
    const answers: Record<string, BusinessAnswer> = {
      ...setup.answers,
      [input.questionId]: {
        questionId: String(input.questionId),
        value: checked.value,
        unknown: checked.unknown,
        origin: 'person',
        at: now(),
        by: this.currentPerson().id,
      },
    };
    const step = nextStep(answers);
    const next: BusinessSetup = {
      ...setup,
      answers,
      cursor: step,
      // A complete draft is a proposal to review. It is not validated, staged
      // or activated: this build has no step that does those.
      state: step === REVIEW_STEP ? 'proposal-ready' : 'drafting',
      proposalDigest: step === REVIEW_STEP ? answersDigest(answers) : null,
      updatedAt: now(),
    };
    await this.saveSetup(next);
    return this.presentSetup(organization, next);
  }

  /** Move the cursor back one question without discarding anything. */
  async back(organizationId: string) {
    const { organization, setup } = this.configuring(organizationId);
    if (!setup) throw refuse(409, 'Start the setup for this workspace first.', 'setup_not_started');
    this.requireCurrentSchema(setup);
    const target = previousStep(setup.answers, setup.cursor);
    if (!target) return this.presentSetup(organization, setup);
    const next: BusinessSetup = {
      ...setup,
      cursor: target,
      state: setup.state === 'proposal-ready' ? 'drafting' : setup.state,
      proposalDigest: null,
      updatedAt: now(),
    };
    await this.saveSetup(next);
    return this.presentSetup(organization, next);
  }

  // --- the view ----------------------------------------------------------------

  // --- where a business writes ------------------------------------------------

  /**
   * The one authority check every output and brief route shares.
   *
   * An organization this person is not an active member of reads as absent, not
   * as forbidden. A 403 would confirm that the id names a real company, which
   * is a fact an outsider has no business learning from a refusal.
   */
  private mine(organizationId: string): { organization: Organization; membership: Membership } {
    const organization = this.organization(organizationId);
    const membership = this.membershipOf(organizationId);
    if (!organization || !isActiveMember(membership))
      throw refuse(404, 'That business workspace does not exist here.', 'organization_not_found');
    return { organization, membership: membership! };
  }

  /**
   * Refuse anything for an organization this person is not an active member of,
   * in the same words a missing organization gets. Public because the allowance
   * routes need exactly this check and must not write a second copy of it.
   */
  assertMine(organizationId: string): void {
    this.mine(organizationId);
  }

  /**
   * The organization that owns a project, read from its active project access
   * resource (recorded when the project is bound as that organization's work
   * target). Null when no organization, or more than one, claims it: an
   * ambiguous owner is never resolved by picking one.
   */
  projectOwner(projectId: string): { organizationId: string; resourceId: string } | null {
    const owners = this.registry.access.resources.filter(
      (resource) =>
        resource.type === 'project' &&
        resource.externalId === projectId &&
        resource.state === 'active',
    );
    if (owners.length !== 1) return null;
    return { organizationId: owners[0].organizationId, resourceId: owners[0].id };
  }

  /**
   * One access-profile decision for the current person, from current registry
   * state and generations. A non-member is refused exactly as mine() refuses a
   * missing organization, so a decision never confirms another company exists.
   */
  accessDecision(organizationId: string, permission: string, resourceId: string): AccessDecision {
    const { organization, membership } = this.mine(organizationId);
    const personId = this.currentPerson().id;
    const access = this.registry.access;
    return authorizeBusinessAccess({
      organizationId,
      tenantId: organization.tenantId,
      personId,
      membershipActive: isActiveMember(membership),
      permission,
      resourceId,
      resources: access.resources,
      profiles: access.profiles,
      assignments: access.assignments,
      organizationGeneration: this.organizationGeneration(organizationId),
      principalGeneration: this.principalGeneration(organizationId, personId),
    });
  }

  /** What this installation may truthfully say about this company's plan. */
  entitlementOf(organizationId: string) {
    this.mine(organizationId);
    return entitlementFor(organizationId);
  }

  // --- organization access profiles -----------------------------------------

  private accessOwner(organizationId: string): {
    organization: Organization;
    membership: Membership;
  } {
    const mine = this.mine(organizationId);
    if (!canAdministerMembers(mine.membership))
      throw refuse(403, 'Only an owner can manage access profiles and assignments.', 'not_owner');
    return mine;
  }

  private accessText(value: unknown, label: string, min: number, max: number): string {
    const text = String(value ?? '').trim();
    if (text.length < min || text.length > max)
      throw refuse(
        400,
        `${label} must be between ${min} and ${max} characters.`,
        'invalid_access_profile',
      );
    return text;
  }

  private accessPermissions(value: unknown, worker = false) {
    if (!Array.isArray(value) || value.length === 0 || value.length > BUSINESS_PERMISSIONS.length)
      throw refuse(400, 'Choose at least one known permission.', 'invalid_permissions');
    const raw = value.map((permission) => String(permission ?? '').trim());
    for (const permission of raw) {
      if (!isBusinessPermission(permission))
        throw refuse(400, `Unknown business permission: ${permission}`, 'unknown_permission');
      if (worker && !isWorkerPermission(permission))
        throw refuse(
          400,
          `${permission} cannot be placed in a worker profile.`,
          'worker_permission_forbidden',
        );
    }
    return normalizeBusinessPermissions(raw);
  }

  private accessResource(organizationId: string, resourceId: string): AuthorizationResource {
    const resource = this.registry.access.resources.find(
      (candidate) =>
        candidate.id === resourceId &&
        candidate.organizationId === organizationId &&
        candidate.state === 'active',
    );
    if (!resource)
      throw refuse(404, 'That access resource does not exist here.', 'resource_not_found');
    return resource;
  }

  private accessScopes(organizationId: string, value: unknown): ResourceScope[] {
    if (!Array.isArray(value) || value.length === 0 || value.length > 32)
      throw refuse(400, 'Choose between 1 and 32 resource scopes.', 'invalid_resource_scopes');
    const scopes = new Map<string, ResourceScope>();
    for (const raw of value) {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw))
        throw refuse(400, 'Each resource scope must name one resource.', 'invalid_resource_scopes');
      const item = raw as Record<string, unknown>;
      const resourceId = String(item.resourceId ?? '').trim();
      this.accessResource(organizationId, resourceId);
      const includeDescendants = item.includeDescendants === true;
      scopes.set(`${resourceId}:${includeDescendants}`, { resourceId, includeDescendants });
    }
    return [...scopes.values()].sort((a, b) => a.resourceId.localeCompare(b.resourceId));
  }

  private accessStringList(
    value: unknown,
    label: string,
    options: { allowEmpty?: boolean; maxItems?: number } = {},
  ): string[] {
    if (!Array.isArray(value))
      throw refuse(400, `${label} must be a list.`, 'invalid_worker_profile');
    const maxItems = options.maxItems ?? 64;
    if ((!options.allowEmpty && value.length === 0) || value.length > maxItems)
      throw refuse(400, `${label} has an invalid number of entries.`, 'invalid_worker_profile');
    const values = new Set<string>();
    for (const raw of value) {
      const item = String(raw ?? '').trim();
      if (!item || item.length > 120)
        throw refuse(400, `${label} contains an invalid entry.`, 'invalid_worker_profile');
      values.add(item);
    }
    return [...values].sort();
  }

  accessView(organizationId: string): OrganizationAccessView {
    const { organization } = this.accessOwner(organizationId);
    const access = this.registry.access;
    const personId = this.currentPerson().id;
    return {
      v: BUSINESS_ACCESS_CONTRACT_VERSION,
      organizationId,
      tenantId: organization.tenantId,
      organizationGeneration: this.organizationGeneration(organizationId),
      principalGeneration: this.principalGeneration(organizationId, personId),
      resources: access.resources.filter((resource) => resource.organizationId === organizationId),
      profiles: access.profiles.filter((profile) => profile.organizationId === organizationId),
      assignments: access.assignments.filter(
        (assignment) => assignment.organizationId === organizationId,
      ),
      workerProfiles: access.workerProfiles.filter(
        (profile) => profile.organizationId === organizationId,
      ),
    };
  }

  discoverAccessResources(organizationId: string, permission: string): AuthorizationResource[] {
    const { organization } = this.mine(organizationId);
    if (!isBusinessPermission(permission))
      throw refuse(400, `Unknown business permission: ${permission}`, 'unknown_permission');
    const personId = this.currentPerson().id;
    return resourcesVisibleTo({
      organizationId,
      personId,
      membershipActive: true,
      permission,
      resources: this.registry.access.resources,
      profiles: this.registry.access.profiles,
      assignments: this.registry.access.assignments,
    }).filter((resource) => resource.organizationId === organization.id);
  }

  async createAccessResource(
    organizationId: string,
    input: { type: unknown; parentId: unknown; label: unknown; externalId?: unknown },
  ): Promise<AuthorizationResource> {
    this.accessOwner(organizationId);
    const requestedType = String(input.type ?? '');
    if (
      !(AUTHORIZATION_RESOURCE_TYPES as readonly string[]).includes(requestedType) ||
      requestedType === 'organization' ||
      requestedType === 'project' ||
      requestedType === 'worker-profile'
    )
      throw refuse(
        400,
        'Choose a location, business area, data scope or connector.',
        'invalid_resource_type',
      );
    const type = requestedType as AuthorizationResourceType;
    const parent = this.accessResource(organizationId, String(input.parentId ?? ''));
    let cursor: AuthorizationResource | undefined = parent;
    let depth = 0;
    while (cursor) {
      depth += 1;
      if (depth > 8)
        throw refuse(409, 'This resource hierarchy is too deep.', 'resource_hierarchy_too_deep');
      cursor = cursor.parentId
        ? this.registry.access.resources.find((candidate) => candidate.id === cursor!.parentId)
        : undefined;
    }
    const label = this.accessText(input.label, 'Resource label', 2, 120);
    const externalId =
      input.externalId == null ? null : String(input.externalId).trim().slice(0, 200) || null;
    if (
      externalId &&
      this.registry.access.resources.some(
        (resource) =>
          resource.type === type &&
          resource.externalId === externalId &&
          resource.state === 'active',
      )
    )
      throw refuse(
        409,
        'That external resource is already owned by an organization.',
        'external_resource_already_owned',
      );
    const resource: AuthorizationResource = {
      v: BUSINESS_ACCESS_CONTRACT_VERSION,
      organizationId,
      id: `resource_${token(9)}`,
      type,
      parentId: parent.id,
      externalId,
      label,
      state: 'active',
      revision: 1,
    };
    this.registry.access.resources.push(resource);
    this.bumpOrganizationGeneration(organizationId);
    await this.saveRegistry();
    return resource;
  }

  async createAccessProfile(
    organizationId: string,
    input: { name: unknown; description: unknown; permissions: unknown },
  ): Promise<AccessProfile> {
    this.accessOwner(organizationId);
    const id = `access_profile_${token(9)}`;
    const revision = 1;
    const name = this.accessText(input.name, 'Profile name', 2, 80);
    const description = this.accessText(input.description, 'Profile description', 2, 500);
    const permissions = this.accessPermissions(input.permissions);
    const profile: AccessProfile = {
      v: BUSINESS_ACCESS_CONTRACT_VERSION,
      organizationId,
      id,
      revision,
      name,
      description,
      systemKind: 'custom',
      state: 'active',
      permissions,
      digest: this.accessProfileDigest({
        organizationId,
        id,
        revision,
        name,
        description,
        systemKind: 'custom',
        permissions,
      }),
      createdAt: now(),
      createdBy: this.currentPerson().id,
    };
    this.registry.access.profiles.push(profile);
    this.bumpOrganizationGeneration(organizationId);
    await this.saveRegistry();
    return profile;
  }

  async reviseAccessProfile(
    organizationId: string,
    profileId: string,
    input: {
      expectedRevision: unknown;
      name: unknown;
      description: unknown;
      permissions: unknown;
    },
  ): Promise<AccessProfile> {
    this.accessOwner(organizationId);
    const revisions = this.registry.access.profiles
      .filter(
        (profile) =>
          profile.organizationId === organizationId &&
          profile.id === profileId &&
          profile.systemKind === 'custom',
      )
      .sort((a, b) => b.revision - a.revision);
    const current = revisions[0];
    if (!current)
      throw refuse(404, 'That custom access profile does not exist.', 'profile_not_found');
    const expectedRevision = Number(input.expectedRevision);
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision !== current.revision)
      throw refuse(
        409,
        'This access profile changed. Reload it before creating another revision.',
        'revision_conflict',
      );
    const revision = current.revision + 1;
    const name = this.accessText(input.name, 'Profile name', 2, 80);
    const description = this.accessText(input.description, 'Profile description', 2, 500);
    const permissions = this.accessPermissions(input.permissions);
    const profile: AccessProfile = {
      ...current,
      revision,
      name,
      description,
      permissions,
      digest: this.accessProfileDigest({
        organizationId,
        id: profileId,
        revision,
        name,
        description,
        systemKind: 'custom',
        permissions,
      }),
      createdAt: now(),
      createdBy: this.currentPerson().id,
    };
    this.registry.access.profiles.push(profile);
    this.bumpOrganizationGeneration(organizationId);
    await this.saveRegistry();
    return profile;
  }

  async assignAccessProfile(
    organizationId: string,
    input: {
      personId: unknown;
      profileId: unknown;
      profileRevision: unknown;
      scopes: unknown;
    },
  ): Promise<AccessAssignment> {
    this.accessOwner(organizationId);
    const personId = String(input.personId ?? '').trim();
    const membership = this.membershipOf(organizationId, personId);
    if (!isActiveMember(membership))
      throw refuse(404, 'That person is not an active member.', 'membership_not_found');
    const profileId = String(input.profileId ?? '').trim();
    const profileRevision = Number(input.profileRevision);
    const profile = this.registry.access.profiles.find(
      (candidate) =>
        candidate.organizationId === organizationId &&
        candidate.id === profileId &&
        candidate.revision === profileRevision &&
        candidate.state === 'active',
    );
    if (!profile)
      throw refuse(404, 'That access profile revision does not exist.', 'profile_not_found');
    if (profile.systemKind !== 'custom')
      throw refuse(
        409,
        'Protected Owner access follows active ownership and is not assigned here.',
        'protected_owner_profile',
      );
    const scopes = this.accessScopes(organizationId, input.scopes);
    const duplicate = this.registry.access.assignments.some(
      (assignment) =>
        assignment.organizationId === organizationId &&
        assignment.personId === personId &&
        assignment.profileId === profileId &&
        assignment.profileRevision === profileRevision &&
        assignment.revokedAt === null &&
        JSON.stringify(assignment.scopes) === JSON.stringify(scopes),
    );
    if (duplicate)
      throw refuse(409, 'That exact access assignment is already active.', 'assignment_exists');
    const assignment: AccessAssignment = {
      v: BUSINESS_ACCESS_CONTRACT_VERSION,
      organizationId,
      id: `access_assignment_${token(9)}`,
      personId,
      profileId,
      profileRevision,
      scopes,
      revision: 1,
      createdAt: now(),
      createdBy: this.currentPerson().id,
      revokedAt: null,
      revokedBy: null,
    };
    this.registry.access.assignments.push(assignment);
    this.bumpOrganizationGeneration(organizationId);
    this.bumpPrincipalGeneration(organizationId, personId);
    await this.saveRegistry();
    return assignment;
  }

  async revokeAccessAssignment(
    organizationId: string,
    assignmentId: string,
    expectedRevisionValue: unknown,
  ): Promise<AccessAssignment> {
    this.accessOwner(organizationId);
    const index = this.registry.access.assignments.findIndex(
      (assignment) =>
        assignment.organizationId === organizationId && assignment.id === assignmentId,
    );
    const current = this.registry.access.assignments[index];
    if (!current)
      throw refuse(404, 'That access assignment does not exist.', 'assignment_not_found');
    if (current.profileId === systemOwnerProfileId(organizationId))
      throw refuse(
        409,
        'Protected Owner access changes only through membership ownership.',
        'protected_owner_assignment',
      );
    const expectedRevision = Number(expectedRevisionValue);
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision !== current.revision)
      throw refuse(
        409,
        'This access assignment changed. Reload it before revoking it.',
        'revision_conflict',
      );
    if (current.revokedAt)
      throw refuse(409, 'That access assignment is already revoked.', 'assignment_revoked');
    const assignment: AccessAssignment = {
      ...current,
      revision: current.revision + 1,
      revokedAt: now(),
      revokedBy: this.currentPerson().id,
    };
    this.registry.access.assignments[index] = assignment;
    this.bumpOrganizationGeneration(organizationId);
    this.bumpPrincipalGeneration(organizationId, assignment.personId);
    await this.saveRegistry();
    return assignment;
  }

  async createWorkerProfile(
    organizationId: string,
    input: {
      name: unknown;
      purpose: unknown;
      executionMode: unknown;
      agent: unknown;
      permissionCeilings: unknown;
      resourceCeilings: unknown;
      contextCeilings: unknown;
      toolCeilings: unknown;
      ruleScopes: unknown;
      routeCeilings: unknown;
    },
  ): Promise<WorkerProfile> {
    this.accessOwner(organizationId);
    const name = this.accessText(input.name, 'Worker profile name', 2, 80);
    const purpose = this.accessText(input.purpose, 'Worker purpose', 2, 500);
    if (input.executionMode !== 'interactive' && input.executionMode !== 'organization-worker')
      throw refuse(400, 'Choose a worker execution mode.', 'invalid_worker_profile');
    if (!input.agent || typeof input.agent !== 'object' || Array.isArray(input.agent))
      throw refuse(400, 'Choose an immutable Agent reference.', 'invalid_worker_profile');
    const rawAgent = input.agent as Record<string, unknown>;
    const agent = {
      id: this.accessText(rawAgent.id, 'Agent id', 1, 80),
      version: this.accessText(rawAgent.version, 'Agent version', 1, 20),
      digest: String(rawAgent.digest ?? '').trim(),
    };
    if (!/^sha256:[a-f0-9]{64}$/.test(agent.digest))
      throw refuse(400, 'The Agent reference needs its exact digest.', 'invalid_worker_profile');
    const permissionCeilings = this.accessPermissions(input.permissionCeilings, true);
    const resourceCeilings = this.accessScopes(organizationId, input.resourceCeilings);
    const contextCeilings = this.accessStringList(input.contextCeilings, 'Context ceilings', {
      allowEmpty: true,
    });
    const toolCeilings = this.accessStringList(input.toolCeilings, 'Tool ceilings', {
      allowEmpty: true,
    });
    const ruleScopes = this.accessStringList(input.ruleScopes, 'Rule scopes', { allowEmpty: true });
    const routeCeilings = this.accessStringList(input.routeCeilings, 'Route ceilings');
    const id = `worker_profile_${token(9)}`;
    const revision = 1;
    const digest = this.workerProfileDigest({
      organizationId,
      id,
      revision,
      name,
      purpose,
      executionMode: input.executionMode,
      agent,
      permissionCeilings,
      resourceCeilings,
      contextCeilings,
      toolCeilings,
      ruleScopes,
      routeCeilings,
    });
    const profile: WorkerProfile = {
      v: BUSINESS_ACCESS_CONTRACT_VERSION,
      organizationId,
      id,
      revision,
      name,
      purpose,
      state: 'active',
      executionMode: input.executionMode,
      agent,
      permissionCeilings,
      resourceCeilings,
      contextCeilings,
      toolCeilings,
      ruleScopes,
      routeCeilings,
      grantsAuthority: false,
      digest,
      createdAt: now(),
      createdBy: this.currentPerson().id,
    };
    this.registry.access.workerProfiles.push(profile);
    this.registry.access.resources.push({
      v: BUSINESS_ACCESS_CONTRACT_VERSION,
      organizationId,
      id: `worker-profile:${id}`,
      type: 'worker-profile',
      parentId: organizationRootResourceId(organizationId),
      externalId: id,
      label: name,
      state: 'active',
      revision: 1,
    });
    this.bumpOrganizationGeneration(organizationId);
    await this.saveRegistry();
    return profile;
  }

  outputBinding(organizationId: string): OutputBinding | null {
    return this.registry.outputs[organizationId] ?? null;
  }

  /**
   * Bind the project this organization's work is written into.
   *
   * The project must already exist. Creating one here would put a company's
   * work somewhere nobody chose, and this decision is worth making explicitly
   * exactly once.
   */
  async bindOutputProject(organizationId: string, projectId: string): Promise<WorkspaceView> {
    const { membership } = this.mine(organizationId);
    if (!canBindOutputProject(membership))
      throw refuse(
        403,
        'Only an owner or an admin chooses where this business writes.',
        'not_a_configurator',
      );
    const projects = await this.store.projects();
    const project = projects.find((candidate) => candidate.id === projectId);
    if (!project) throw refuse(404, 'That project is not here.', 'project_not_found');
    const existingOwner = this.registry.access.resources.find(
      (resource) =>
        resource.type === 'project' &&
        resource.externalId === project.id &&
        resource.state === 'active',
    );
    if (existingOwner && existingOwner.organizationId !== organizationId)
      throw refuse(
        409,
        'That project already belongs to another organization.',
        'project_owned_by_another_organization',
      );
    if (!existingOwner) {
      this.registry.access.resources.push({
        v: BUSINESS_ACCESS_CONTRACT_VERSION,
        organizationId,
        id: `project:${project.id}`,
        type: 'project',
        parentId: organizationRootResourceId(organizationId),
        externalId: project.id,
        label: project.name,
        state: 'active',
        revision: 1,
      });
      this.bumpOrganizationGeneration(organizationId);
    }
    this.registry.outputs[organizationId] = {
      projectId: project.id,
      projectName: project.name,
      boundAt: now(),
      boundBy: this.currentPerson().id,
    };
    await this.saveRegistry();
    return this.view();
  }

  /**
   * Resolve where a job for this organization writes, once, at the moment it
   * starts. The caller holds the resolved target for the run's lifetime:
   * switching workspace afterwards changes what a person is looking at and
   * nothing about where the run writes.
   */
  async briefTarget(organizationId: string): Promise<BriefTarget> {
    const { organization, membership } = this.mine(organizationId);
    const projects = await this.store.projects();
    return resolveBriefTarget({
      organization,
      membership,
      binding: this.outputBinding(organizationId),
      projects: projects.map((project) => ({
        id: project.id,
        name: project.name,
        organizationId:
          this.registry.access.resources.find(
            (resource) =>
              resource.type === 'project' &&
              resource.externalId === project.id &&
              resource.state === 'active',
          )?.organizationId ?? null,
      })),
    });
  }

  view(): WorkspaceView {
    const person = this.currentPerson();
    const active = this.active();
    const mine = this.registry.memberships.filter((item) => item.personId === person.id);
    const organizations: OrganizationView[] = [];
    const revoked: WorkspaceView['revoked'] = [];
    for (const membership of mine) {
      const organization = this.organization(membership.organizationId);
      if (!organization) continue;
      if (membership.state === 'revoked') {
        revoked.push({
          organizationId: organization.id,
          name: organization.name,
          revokedAt: membership.revokedAt ?? '',
          reason: membership.revokedReason,
        });
        continue;
      }
      const setup = this.setups.get(organization.id) ?? null;
      const counts = progress(setup?.answers ?? {});
      const mayConfigure = canConfigureOrganization(membership);
      organizations.push({
        organization,
        membership,
        ...(canAdministerMembers(membership)
          ? {
              members: this.registry.memberships
                .filter((item) => item.organizationId === organization.id)
                .map((item) => ({ personId: item.personId, role: item.role, state: item.state })),
            }
          : {}),
        entitlement: entitlementFor(organization.id),
        output: this.registry.outputs[organization.id] ?? null,
        setup: {
          state: setup?.state ?? 'not-started',
          schemaRevision: setup?.schemaRevision ?? BUSINESS_SETUP_SCHEMA_REVISION,
          answered: counts.answered,
          required: counts.required,
          // Only a configurator sees a resumable draft; a member has nothing to resume.
          resumable: mayConfigure && setup !== null && setup.state !== 'not-started',
          mayConfigure,
        },
      });
    }
    return {
      v: WORKSPACE_CONTRACT_VERSION,
      person,
      active,
      organizations,
      revoked,
      hosted: { available: this.hostedAvailable(), reason: HOSTED_BUSINESS_UNAVAILABLE_REASON },
      // A first-run answer of "business" is repeated back as the preference it
      // is, so nobody has to wonder whether it did something.
      legacyPreference: legacyBusinessPreference(this.store.settings.onboarding?.work),
    };
  }

  /**
   * Read the view, settling a stored reference that stopped being valid.
   *
   * Reading writes nothing in the ordinary case, so it does not take the store
   * lock: the Console asks for this on every mount, and a read that queues
   * behind every mutation is how a fast surface becomes a slow one. The lock is
   * taken only on the rare pass that actually has a fallback to persist.
   */
  async currentView(): Promise<WorkspaceView> {
    if (this.needsReconcile()) await this.store.locked(() => this.reconcileActive());
    return this.view();
  }
}
