/**
 * Organization resource access -- contract version 1.
 *
 * Job titles are presentation. Access profiles carry fixed permissions, and
 * assignments say where those permissions apply. Worker profiles are ceilings
 * over already-authorized human work; they never grant authority themselves.
 */

export const BUSINESS_ACCESS_CONTRACT_VERSION = 1 as const;

export const BUSINESS_PERMISSIONS = Object.freeze([
  'organization:view',
  'organization:configure',
  'membership:view',
  'membership:invite',
  'membership:revoke',
  'authorization:view',
  'authorization:manage_profiles',
  'authorization:assign',
  'authorization:audit',
  'ownership:transfer',
  'location:view',
  'location:configure',
  'business-area:view',
  'business-area:configure',
  'project:view',
  'project:create',
  'project:edit',
  'project:share',
  'project:delete',
  'context:view',
  'context:attach',
  'rule:view',
  'rule:manage',
  'connector:view',
  'connector:use',
  'connector:manage',
  'worker-profile:view',
  'worker-profile:launch',
  'worker-profile:manage',
  'inventory:view',
  'inventory:record',
  'inventory:count',
  'inventory:adjust',
  'inventory:approve',
  'inventory:view_cost',
  'recipe:view',
  'recipe:edit',
  'recipe:publish',
  'schedule:view',
  'schedule:edit',
  'schedule:publish',
  'labor:view_own',
  'labor:record_own',
  'labor:view_team',
  'labor:view_rates',
  'labor:approve',
  'finance:view',
  'finance:export',
  'finance:manage',
] as const);

export type BusinessPermission = (typeof BUSINESS_PERMISSIONS)[number];

const BUSINESS_PERMISSION_SET: ReadonlySet<string> = new Set(BUSINESS_PERMISSIONS);

/** Permissions that may appear in a worker ceiling. Organization recovery and
 * access administration stay human-only. Effect approval is deliberately not
 * in either catalogue: an exact approval remains an exact Trust decision. */
export const WORKER_PERMISSIONS: readonly BusinessPermission[] = Object.freeze(
  BUSINESS_PERMISSIONS.filter(
    (permission) =>
      !permission.startsWith('membership:') &&
      !permission.startsWith('authorization:') &&
      permission !== 'ownership:transfer' &&
      permission !== 'organization:configure' &&
      permission !== 'location:configure' &&
      permission !== 'business-area:configure' &&
      permission !== 'project:create' &&
      permission !== 'project:share' &&
      permission !== 'project:delete' &&
      permission !== 'rule:manage' &&
      permission !== 'connector:manage' &&
      permission !== 'worker-profile:manage' &&
      permission !== 'labor:approve' &&
      permission !== 'finance:manage',
  ),
);

const WORKER_PERMISSION_SET: ReadonlySet<string> = new Set(WORKER_PERMISSIONS);

export function isBusinessPermission(value: string): value is BusinessPermission {
  return BUSINESS_PERMISSION_SET.has(value);
}

export function isWorkerPermission(value: string): value is BusinessPermission {
  return WORKER_PERMISSION_SET.has(value);
}

export function normalizeBusinessPermissions(values: readonly string[]): BusinessPermission[] {
  const normalized = new Set<BusinessPermission>();
  for (const value of values) {
    if (!isBusinessPermission(value)) throw new Error(`Unknown business permission: ${value}`);
    normalized.add(value);
  }
  return [...normalized].sort();
}

export const AUTHORIZATION_RESOURCE_TYPES = Object.freeze([
  'organization',
  'location',
  'business-area',
  'project',
  'data-scope',
  'connector',
  'worker-profile',
] as const);

export type AuthorizationResourceType = (typeof AUTHORIZATION_RESOURCE_TYPES)[number];
export type AuthorizationResourceState = 'active' | 'retired';

export interface AuthorizationResource {
  readonly v: typeof BUSINESS_ACCESS_CONTRACT_VERSION;
  readonly organizationId: string;
  readonly id: string;
  readonly type: AuthorizationResourceType;
  readonly parentId: string | null;
  /** Existing project, connector or organization id. Null for logical scopes. */
  readonly externalId: string | null;
  readonly label: string;
  readonly state: AuthorizationResourceState;
  readonly revision: number;
}

export interface ResourceScope {
  readonly resourceId: string;
  readonly includeDescendants: boolean;
}

export type AccessProfileSystemKind = 'owner' | 'custom';

/** Immutable revision. Editing creates another record with the same id. */
export interface AccessProfile {
  readonly v: typeof BUSINESS_ACCESS_CONTRACT_VERSION;
  readonly organizationId: string;
  readonly id: string;
  readonly revision: number;
  readonly name: string;
  readonly description: string;
  readonly systemKind: AccessProfileSystemKind;
  readonly state: 'active' | 'retired';
  readonly permissions: readonly BusinessPermission[];
  readonly digest: string;
  readonly createdAt: string;
  readonly createdBy: string;
}

/** A pinned profile revision on exact resources. New profile revisions do not
 * change this assignment until an authorized person replaces it explicitly. */
export interface AccessAssignment {
  readonly v: typeof BUSINESS_ACCESS_CONTRACT_VERSION;
  readonly organizationId: string;
  readonly id: string;
  readonly personId: string;
  readonly profileId: string;
  readonly profileRevision: number;
  readonly scopes: readonly ResourceScope[];
  readonly revision: number;
  readonly createdAt: string;
  readonly createdBy: string;
  revokedAt: string | null;
  revokedBy: string | null;
}

export interface WorkerProfile {
  readonly v: typeof BUSINESS_ACCESS_CONTRACT_VERSION;
  readonly organizationId: string;
  readonly id: string;
  readonly revision: number;
  readonly name: string;
  readonly purpose: string;
  readonly state: 'active' | 'retired';
  readonly executionMode: 'interactive' | 'organization-worker';
  readonly agent: {
    readonly id: string;
    readonly version: string;
    readonly digest: string;
  };
  readonly permissionCeilings: readonly BusinessPermission[];
  readonly resourceCeilings: readonly ResourceScope[];
  readonly contextCeilings: readonly string[];
  readonly toolCeilings: readonly string[];
  readonly ruleScopes: readonly string[];
  readonly routeCeilings: readonly string[];
  /** A worker profile is configuration and can never represent a grant. */
  readonly grantsAuthority: false;
  readonly digest: string;
  readonly createdAt: string;
  readonly createdBy: string;
}

export interface ScopedAccessCeiling {
  readonly permissions: readonly BusinessPermission[];
  readonly scopes: readonly ResourceScope[];
}

/** Owner-only administration projection. Ordinary members discover only the
 * resources authorized for one permission and do not receive this ledger. */
export interface OrganizationAccessView {
  readonly v: typeof BUSINESS_ACCESS_CONTRACT_VERSION;
  readonly organizationId: string;
  readonly tenantId: string;
  readonly organizationGeneration: number;
  readonly principalGeneration: number;
  readonly resources: readonly AuthorizationResource[];
  readonly profiles: readonly AccessProfile[];
  readonly assignments: readonly AccessAssignment[];
  readonly workerProfiles: readonly WorkerProfile[];
}

export type AccessDecisionCode =
  | 'allowed'
  | 'unknown-permission'
  | 'membership-inactive'
  | 'resource-not-found'
  | 'resource-outside-organization'
  | 'resource-graph-invalid'
  | 'human-scope-missing'
  | 'worker-profile-invalid'
  | 'worker-agent-mismatch'
  | 'worker-context-ceiling'
  | 'worker-tool-ceiling'
  | 'worker-rule-ceiling'
  | 'worker-route-ceiling'
  | 'worker-permission-ceiling'
  | 'worker-resource-ceiling'
  | 'task-permission-missing'
  | 'task-resource-missing'
  | 'route-capability-missing'
  | 'agent-ceiling'
  | 'organization-policy-missing';

export interface AccessDecision {
  readonly allowed: boolean;
  readonly code: AccessDecisionCode;
  readonly organizationId: string;
  readonly tenantId: string;
  readonly personId: string;
  readonly permission: string;
  readonly resource: {
    readonly id: string;
    readonly type: AuthorizationResourceType;
    /** Requested resource first, organization root last. */
    readonly parentPath: readonly string[];
  } | null;
  readonly humanAssignmentIds: readonly string[];
  readonly workerProfile: {
    readonly id: string;
    readonly revision: number;
    readonly digest: string;
  } | null;
  readonly organizationGeneration: number;
  readonly principalGeneration: number;
  readonly checkedAt: string;
  /** Decisions are evidence, not portable grants. */
  readonly grantsAuthority: false;
}

export interface InteractiveWorkerLayers {
  readonly profile: WorkerProfile;
  /** Actual immutable Agent resolution selected for this work. */
  readonly agent: WorkerProfile['agent'];
  readonly routeId: string;
  readonly contextIds: readonly string[];
  readonly toolIds: readonly string[];
  readonly appliedRuleScopes: readonly string[];
  readonly taskGrant: ScopedAccessCeiling;
  readonly routePermissions: readonly BusinessPermission[];
  readonly organizationPolicy: ScopedAccessCeiling;
  /** Result of the existing AgentDefinition/task grant ceiling. */
  readonly agentCeilingAllows: boolean;
}

export interface AuthorizeBusinessAccessInput {
  readonly organizationId: string;
  readonly tenantId: string;
  readonly personId: string;
  readonly membershipActive: boolean;
  readonly permission: string;
  readonly resourceId: string;
  readonly resources: readonly AuthorizationResource[];
  readonly profiles: readonly AccessProfile[];
  readonly assignments: readonly AccessAssignment[];
  readonly organizationGeneration: number;
  readonly principalGeneration: number;
  readonly worker?: InteractiveWorkerLayers;
  readonly checkedAt?: string;
}

function pathFor(
  resources: readonly AuthorizationResource[],
  organizationId: string,
  resource: AuthorizationResource,
): string[] | null {
  const byId = new Map(resources.map((candidate) => [candidate.id, candidate]));
  const path: string[] = [];
  const seen = new Set<string>();
  let current: AuthorizationResource | undefined = resource;
  while (current) {
    if (
      current.organizationId !== organizationId ||
      current.state !== 'active' ||
      seen.has(current.id)
    )
      return null;
    seen.add(current.id);
    path.push(current.id);
    if (current.parentId === null) return current.type === 'organization' ? path : null;
    current = byId.get(current.parentId);
  }
  return null;
}

function scopeCovers(scopes: readonly ResourceScope[], parentPath: readonly string[]): boolean {
  return scopes.some(
    (scope) =>
      scope.resourceId === parentPath[0] ||
      (scope.includeDescendants && parentPath.includes(scope.resourceId)),
  );
}

function permissionIn(
  permissions: readonly BusinessPermission[],
  permission: BusinessPermission,
): boolean {
  return permissions.includes(permission);
}

function allIncluded(requested: readonly string[], ceiling: readonly string[]): boolean {
  return requested.every((value) => ceiling.includes(value));
}

function decision(
  input: AuthorizeBusinessAccessInput,
  code: AccessDecisionCode,
  resource: AuthorizationResource | null,
  parentPath: readonly string[],
  humanAssignmentIds: readonly string[] = [],
): AccessDecision {
  return {
    allowed: code === 'allowed',
    code,
    organizationId: input.organizationId,
    tenantId: input.tenantId,
    personId: input.personId,
    permission: input.permission,
    resource: resource
      ? { id: resource.id, type: resource.type, parentPath: [...parentPath] }
      : null,
    humanAssignmentIds: [...humanAssignmentIds],
    workerProfile: input.worker
      ? {
          id: input.worker.profile.id,
          revision: input.worker.profile.revision,
          digest: input.worker.profile.digest,
        }
      : null,
    organizationGeneration: input.organizationGeneration,
    principalGeneration: input.principalGeneration,
    checkedAt: input.checkedAt ?? new Date().toISOString(),
    grantsAuthority: false,
  };
}

export function authorizeBusinessAccess(input: AuthorizeBusinessAccessInput): AccessDecision {
  if (!isBusinessPermission(input.permission))
    return decision(input, 'unknown-permission', null, []);
  const permission = input.permission;
  if (!input.membershipActive) return decision(input, 'membership-inactive', null, []);

  const resource = input.resources.find((candidate) => candidate.id === input.resourceId) ?? null;
  if (!resource) return decision(input, 'resource-not-found', null, []);
  if (resource.organizationId !== input.organizationId)
    return decision(input, 'resource-outside-organization', resource, []);
  const parentPath = pathFor(input.resources, input.organizationId, resource);
  if (!parentPath) return decision(input, 'resource-graph-invalid', resource, []);

  const matchingAssignments = input.assignments.filter((assignment) => {
    if (
      assignment.organizationId !== input.organizationId ||
      assignment.personId !== input.personId ||
      assignment.revokedAt !== null ||
      !scopeCovers(assignment.scopes, parentPath)
    )
      return false;
    const profile = input.profiles.find(
      (candidate) =>
        candidate.organizationId === input.organizationId &&
        candidate.id === assignment.profileId &&
        candidate.revision === assignment.profileRevision &&
        candidate.state === 'active',
    );
    return profile ? permissionIn(profile.permissions, permission) : false;
  });
  const assignmentIds = matchingAssignments.map((assignment) => assignment.id).sort();
  if (assignmentIds.length === 0)
    return decision(input, 'human-scope-missing', resource, parentPath);

  const worker = input.worker;
  if (!worker) return decision(input, 'allowed', resource, parentPath, assignmentIds);
  if (
    worker.profile.organizationId !== input.organizationId ||
    worker.profile.state !== 'active' ||
    worker.profile.executionMode !== 'interactive' ||
    worker.profile.grantsAuthority !== false
  )
    return decision(input, 'worker-profile-invalid', resource, parentPath, assignmentIds);
  if (
    worker.agent.id !== worker.profile.agent.id ||
    worker.agent.version !== worker.profile.agent.version ||
    worker.agent.digest !== worker.profile.agent.digest
  )
    return decision(input, 'worker-agent-mismatch', resource, parentPath, assignmentIds);
  if (!allIncluded(worker.contextIds, worker.profile.contextCeilings))
    return decision(input, 'worker-context-ceiling', resource, parentPath, assignmentIds);
  if (!allIncluded(worker.toolIds, worker.profile.toolCeilings))
    return decision(input, 'worker-tool-ceiling', resource, parentPath, assignmentIds);
  if (!allIncluded(worker.appliedRuleScopes, worker.profile.ruleScopes))
    return decision(input, 'worker-rule-ceiling', resource, parentPath, assignmentIds);
  if (!worker.profile.routeCeilings.includes(worker.routeId))
    return decision(input, 'worker-route-ceiling', resource, parentPath, assignmentIds);
  if (!permissionIn(worker.profile.permissionCeilings, permission))
    return decision(input, 'worker-permission-ceiling', resource, parentPath, assignmentIds);
  if (!scopeCovers(worker.profile.resourceCeilings, parentPath))
    return decision(input, 'worker-resource-ceiling', resource, parentPath, assignmentIds);
  if (!permissionIn(worker.taskGrant.permissions, permission))
    return decision(input, 'task-permission-missing', resource, parentPath, assignmentIds);
  if (!scopeCovers(worker.taskGrant.scopes, parentPath))
    return decision(input, 'task-resource-missing', resource, parentPath, assignmentIds);
  if (!permissionIn(worker.routePermissions, permission))
    return decision(input, 'route-capability-missing', resource, parentPath, assignmentIds);
  if (!worker.agentCeilingAllows)
    return decision(input, 'agent-ceiling', resource, parentPath, assignmentIds);
  if (
    !permissionIn(worker.organizationPolicy.permissions, permission) ||
    !scopeCovers(worker.organizationPolicy.scopes, parentPath)
  )
    return decision(input, 'organization-policy-missing', resource, parentPath, assignmentIds);
  return decision(input, 'allowed', resource, parentPath, assignmentIds);
}

export function resourcesVisibleTo(input: {
  readonly organizationId: string;
  readonly personId: string;
  readonly membershipActive: boolean;
  readonly permission: string;
  readonly resources: readonly AuthorizationResource[];
  readonly profiles: readonly AccessProfile[];
  readonly assignments: readonly AccessAssignment[];
}): AuthorizationResource[] {
  return input.resources.filter(
    (resource) =>
      resource.organizationId === input.organizationId &&
      resource.state === 'active' &&
      authorizeBusinessAccess({
        ...input,
        tenantId: '',
        resourceId: resource.id,
        organizationGeneration: 0,
        principalGeneration: 0,
      }).allowed,
  );
}

export function organizationRootResourceId(organizationId: string): string {
  return `organization:${organizationId}`;
}

export function systemOwnerProfileId(organizationId: string): string {
  return `system-owner:${organizationId}`;
}

export function systemOwnerAssignmentId(organizationId: string, personId: string): string {
  return `system-owner:${organizationId}:${personId}`;
}
