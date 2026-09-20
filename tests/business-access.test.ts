/**
 * Business access is a resource decision, not a job-title shortcut.
 *
 * These tests use restaurant-shaped fixtures because they make accidental
 * privilege inheritance easy to see, while the contract itself stays
 * industry-neutral. Every name and resource is synthetic.
 */
import { describe, expect, test } from 'vitest';
import {
  authorizeBusinessAccess,
  isBusinessPermission,
  isWorkerPermission,
  normalizeBusinessPermissions,
  resourcesVisibleTo,
  type AccessAssignment,
  type AccessProfile,
  type AuthorizationResource,
  type ScopedAccessCeiling,
  type WorkerProfile,
} from '../shared/business-access.js';

const AT = '2026-09-20T09:00:00.000Z';
const DIGEST = `sha256:${'a'.repeat(64)}`;

const resources: AuthorizationResource[] = [
  {
    v: 1,
    organizationId: 'org_restaurant',
    id: 'resource_org',
    type: 'organization',
    parentId: null,
    externalId: 'org_restaurant',
    label: 'Sample Restaurant',
    state: 'active',
    revision: 1,
  },
  {
    v: 1,
    organizationId: 'org_restaurant',
    id: 'resource_downtown',
    type: 'location',
    parentId: 'resource_org',
    externalId: null,
    label: 'Downtown',
    state: 'active',
    revision: 1,
  },
  {
    v: 1,
    organizationId: 'org_restaurant',
    id: 'resource_kitchen',
    type: 'business-area',
    parentId: 'resource_downtown',
    externalId: null,
    label: 'Kitchen',
    state: 'active',
    revision: 1,
  },
  {
    v: 1,
    organizationId: 'org_restaurant',
    id: 'resource_recipes',
    type: 'data-scope',
    parentId: 'resource_kitchen',
    externalId: null,
    label: 'Recipes',
    state: 'active',
    revision: 1,
  },
  {
    v: 1,
    organizationId: 'org_restaurant',
    id: 'resource_front',
    type: 'business-area',
    parentId: 'resource_downtown',
    externalId: null,
    label: 'Front of house',
    state: 'active',
    revision: 1,
  },
  {
    v: 1,
    organizationId: 'org_restaurant',
    id: 'resource_finance',
    type: 'data-scope',
    parentId: 'resource_org',
    externalId: null,
    label: 'Finance',
    state: 'active',
    revision: 1,
  },
  {
    v: 1,
    organizationId: 'org_other',
    id: 'resource_other_org',
    type: 'organization',
    parentId: null,
    externalId: 'org_other',
    label: 'Other Business',
    state: 'active',
    revision: 1,
  },
];

const profiles: AccessProfile[] = [
  {
    v: 1,
    organizationId: 'org_restaurant',
    id: 'profile_owner',
    revision: 1,
    name: 'Owner',
    description: 'Protected owner access.',
    systemKind: 'owner',
    state: 'active',
    permissions: [
      'organization:view',
      'project:view',
      'recipe:view',
      'inventory:view',
      'inventory:count',
      'finance:view',
      'authorization:audit',
    ],
    digest: DIGEST,
    createdAt: AT,
    createdBy: 'system',
  },
  {
    v: 1,
    organizationId: 'org_restaurant',
    id: 'profile_chef',
    revision: 1,
    name: 'Kitchen lead',
    description: 'Recipes and counts in an assigned kitchen.',
    systemKind: 'custom',
    state: 'active',
    permissions: ['project:view', 'recipe:view', 'inventory:view', 'inventory:count'],
    digest: DIGEST,
    createdAt: AT,
    createdBy: 'person_owner',
  },
  {
    v: 1,
    organizationId: 'org_restaurant',
    id: 'profile_chef',
    revision: 2,
    name: 'Kitchen lead',
    description: 'A proposed broader revision that is not assigned yet.',
    systemKind: 'custom',
    state: 'active',
    permissions: [
      'project:view',
      'recipe:view',
      'inventory:view',
      'inventory:count',
      'finance:view',
    ],
    digest: `sha256:${'b'.repeat(64)}`,
    createdAt: AT,
    createdBy: 'person_owner',
  },
  {
    v: 1,
    organizationId: 'org_restaurant',
    id: 'profile_gm',
    revision: 1,
    name: 'General manager',
    description: 'Front-of-house operations only in this fixture.',
    systemKind: 'custom',
    state: 'active',
    permissions: ['project:view', 'schedule:view', 'schedule:edit'],
    digest: DIGEST,
    createdAt: AT,
    createdBy: 'person_owner',
  },
];

const assignments: AccessAssignment[] = [
  {
    v: 1,
    organizationId: 'org_restaurant',
    id: 'assignment_owner',
    personId: 'person_owner',
    profileId: 'profile_owner',
    profileRevision: 1,
    scopes: [{ resourceId: 'resource_org', includeDescendants: true }],
    revision: 1,
    createdAt: AT,
    createdBy: 'system',
    revokedAt: null,
    revokedBy: null,
  },
  {
    v: 1,
    organizationId: 'org_restaurant',
    id: 'assignment_chef',
    personId: 'person_chef',
    profileId: 'profile_chef',
    profileRevision: 1,
    scopes: [{ resourceId: 'resource_kitchen', includeDescendants: true }],
    revision: 1,
    createdAt: AT,
    createdBy: 'person_owner',
    revokedAt: null,
    revokedBy: null,
  },
  {
    v: 1,
    organizationId: 'org_restaurant',
    id: 'assignment_gm',
    personId: 'person_gm',
    profileId: 'profile_gm',
    profileRevision: 1,
    scopes: [{ resourceId: 'resource_front', includeDescendants: true }],
    revision: 1,
    createdAt: AT,
    createdBy: 'person_owner',
    revokedAt: null,
    revokedBy: null,
  },
];

const ceiling = (
  permissions: ScopedAccessCeiling['permissions'],
  resourceId = 'resource_kitchen',
): ScopedAccessCeiling => ({
  permissions,
  scopes: [{ resourceId, includeDescendants: true }],
});

const kitchenWorker: WorkerProfile = {
  v: 1,
  organizationId: 'org_restaurant',
  id: 'worker_kitchen',
  revision: 1,
  name: 'Kitchen operations worker',
  purpose: 'Prepare recipe and count work inside the assigned kitchen.',
  state: 'active',
  executionMode: 'interactive',
  agent: {
    id: 'diomedes.general',
    version: '1',
    digest: `sha256:${'c'.repeat(64)}`,
  },
  permissionCeilings: ['recipe:view', 'inventory:view', 'inventory:count'],
  resourceCeilings: [{ resourceId: 'resource_kitchen', includeDescendants: true }],
  contextCeilings: ['recipes', 'inventory-counts'],
  toolCeilings: ['inventory.read', 'inventory.count'],
  ruleScopes: ['kitchen-safety'],
  routeCeilings: ['local'],
  grantsAuthority: false,
  digest: DIGEST,
  createdAt: AT,
  createdBy: 'person_owner',
};

const decide = (input: {
  personId: string;
  permission: string;
  resourceId: string;
  membershipActive?: boolean;
  worker?: Parameters<typeof authorizeBusinessAccess>[0]['worker'];
}) =>
  authorizeBusinessAccess({
    organizationId: 'org_restaurant',
    tenantId: 'tenant_restaurant',
    personId: input.personId,
    membershipActive: input.membershipActive ?? true,
    permission: input.permission,
    resourceId: input.resourceId,
    resources,
    profiles,
    assignments,
    organizationGeneration: 7,
    principalGeneration: 3,
    worker: input.worker,
    checkedAt: AT,
  });

describe('fixed permission catalog', () => {
  test('unknown permission text fails closed instead of becoming a custom capability', () => {
    expect(isBusinessPermission('kitchen:do_anything')).toBe(false);
    expect(() => normalizeBusinessPermissions(['recipe:view', 'kitchen:do_anything'])).toThrow(
      /unknown business permission/i,
    );
  });

  test('known permissions are de-duplicated into a stable bundle', () => {
    expect(normalizeBusinessPermissions(['recipe:view', 'inventory:count', 'recipe:view'])).toEqual(
      ['inventory:count', 'recipe:view'],
    );
  });

  test('worker ceilings exclude membership, authorization and ownership administration', () => {
    expect(isWorkerPermission('recipe:view')).toBe(true);
    expect(isWorkerPermission('authorization:assign')).toBe(false);
    expect(isWorkerPermission('ownership:transfer')).toBe(false);
  });
});

describe('human resource access', () => {
  test('a Head Chef profile reaches assigned kitchen descendants and no farther', () => {
    expect(
      decide({
        personId: 'person_chef',
        permission: 'recipe:view',
        resourceId: 'resource_recipes',
      }),
    ).toMatchObject({
      allowed: true,
      code: 'allowed',
      permission: 'recipe:view',
      humanAssignmentIds: ['assignment_chef'],
      organizationGeneration: 7,
      principalGeneration: 3,
      grantsAuthority: false,
    });

    expect(
      decide({
        personId: 'person_chef',
        permission: 'finance:view',
        resourceId: 'resource_finance',
      }),
    ).toMatchObject({ allowed: false, code: 'human-scope-missing' });
  });

  test('a GM title cannot cross into Kitchen without an assigned scope', () => {
    expect(
      decide({
        personId: 'person_gm',
        permission: 'project:view',
        resourceId: 'resource_kitchen',
      }),
    ).toMatchObject({ allowed: false, code: 'human-scope-missing' });
  });

  test('a newer profile revision does not silently widen a pinned assignment', () => {
    expect(
      decide({
        personId: 'person_chef',
        permission: 'finance:view',
        resourceId: 'resource_kitchen',
      }),
    ).toMatchObject({ allowed: false, code: 'human-scope-missing' });
  });

  test('the protected Owner assignment spans the organization but does not become an approval', () => {
    const decision = decide({
      personId: 'person_owner',
      permission: 'finance:view',
      resourceId: 'resource_finance',
    });
    expect(decision).toMatchObject({
      allowed: true,
      humanAssignmentIds: ['assignment_owner'],
      grantsAuthority: false,
    });
    expect(isBusinessPermission('approval:decide')).toBe(false);
  });

  test('inactive membership and another tenant both deny before profile evaluation', () => {
    expect(
      decide({
        personId: 'person_owner',
        permission: 'organization:view',
        resourceId: 'resource_org',
        membershipActive: false,
      }),
    ).toMatchObject({ allowed: false, code: 'membership-inactive' });

    expect(
      decide({
        personId: 'person_owner',
        permission: 'organization:view',
        resourceId: 'resource_other_org',
      }),
    ).toMatchObject({ allowed: false, code: 'resource-outside-organization' });
  });

  test('resource discovery returns only resources covered by the requested permission', () => {
    expect(
      resourcesVisibleTo({
        organizationId: 'org_restaurant',
        personId: 'person_chef',
        membershipActive: true,
        permission: 'recipe:view',
        resources,
        profiles,
        assignments,
      }).map((resource) => resource.id),
    ).toEqual(['resource_kitchen', 'resource_recipes']);
  });
});

describe('interactive worker intersection', () => {
  const workerLayers = (): NonNullable<
    Parameters<typeof authorizeBusinessAccess>[0]['worker']
  > => ({
    profile: kitchenWorker,
    agent: { ...kitchenWorker.agent },
    routeId: 'local',
    contextIds: ['recipes'],
    toolIds: ['inventory.read'],
    appliedRuleScopes: ['kitchen-safety'],
    taskGrant: ceiling(['recipe:view']),
    routePermissions: ['recipe:view'],
    organizationPolicy: ceiling(['recipe:view'], 'resource_org'),
    agentCeilingAllows: true,
  });

  test('allows only when human, worker, task, route, Agent and policy all allow', () => {
    expect(
      decide({
        personId: 'person_chef',
        permission: 'recipe:view',
        resourceId: 'resource_recipes',
        worker: workerLayers(),
      }),
    ).toMatchObject({
      allowed: true,
      code: 'allowed',
      workerProfile: { id: 'worker_kitchen', revision: 1, digest: DIGEST },
      grantsAuthority: false,
    });
  });

  test("a kitchen worker cannot borrow an Owner human's finance access", () => {
    expect(
      decide({
        personId: 'person_owner',
        permission: 'finance:view',
        resourceId: 'resource_finance',
        worker: {
          ...workerLayers(),
          taskGrant: ceiling(['finance:view'], 'resource_org'),
          routePermissions: ['finance:view'],
          organizationPolicy: ceiling(['finance:view'], 'resource_org'),
        },
      }),
    ).toMatchObject({ allowed: false, code: 'worker-permission-ceiling' });
  });

  test('Agent, context, tool, rule and route selections must stay inside the worker profile', () => {
    const base = workerLayers();
    expect(
      decide({
        personId: 'person_chef',
        permission: 'recipe:view',
        resourceId: 'resource_recipes',
        worker: {
          ...base,
          agent: { ...base.agent, digest: `sha256:${'f'.repeat(64)}` },
        },
      }),
    ).toMatchObject({ allowed: false, code: 'worker-agent-mismatch' });

    expect(
      decide({
        personId: 'person_chef',
        permission: 'recipe:view',
        resourceId: 'resource_recipes',
        worker: { ...base, contextIds: ['owner-office'] },
      }),
    ).toMatchObject({ allowed: false, code: 'worker-context-ceiling' });

    expect(
      decide({
        personId: 'person_chef',
        permission: 'recipe:view',
        resourceId: 'resource_recipes',
        worker: { ...base, toolIds: ['finance.export'] },
      }),
    ).toMatchObject({ allowed: false, code: 'worker-tool-ceiling' });

    expect(
      decide({
        personId: 'person_chef',
        permission: 'recipe:view',
        resourceId: 'resource_recipes',
        worker: { ...base, appliedRuleScopes: ['owner-policy'] },
      }),
    ).toMatchObject({ allowed: false, code: 'worker-rule-ceiling' });

    expect(
      decide({
        personId: 'person_chef',
        permission: 'recipe:view',
        resourceId: 'resource_recipes',
        worker: { ...base, routeId: 'cloud-unapproved' },
      }),
    ).toMatchObject({ allowed: false, code: 'worker-route-ceiling' });
  });

  test('missing task, route, Agent or policy authority remains a denial', () => {
    const task = workerLayers();
    expect(
      decide({
        personId: 'person_chef',
        permission: 'recipe:view',
        resourceId: 'resource_recipes',
        worker: { ...task, taskGrant: ceiling([]) },
      }),
    ).toMatchObject({ allowed: false, code: 'task-permission-missing' });

    expect(
      decide({
        personId: 'person_chef',
        permission: 'recipe:view',
        resourceId: 'resource_recipes',
        worker: { ...task, routePermissions: [] },
      }),
    ).toMatchObject({ allowed: false, code: 'route-capability-missing' });

    expect(
      decide({
        personId: 'person_chef',
        permission: 'recipe:view',
        resourceId: 'resource_recipes',
        worker: { ...task, agentCeilingAllows: false },
      }),
    ).toMatchObject({ allowed: false, code: 'agent-ceiling' });

    expect(
      decide({
        personId: 'person_chef',
        permission: 'recipe:view',
        resourceId: 'resource_recipes',
        worker: { ...task, organizationPolicy: ceiling([]) },
      }),
    ).toMatchObject({ allowed: false, code: 'organization-policy-missing' });
  });
});
