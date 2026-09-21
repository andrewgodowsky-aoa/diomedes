/**
 * Durable organization access profiles through the real HTTP host.
 *
 * The fixture proves that custom permission text cannot become authority, a
 * manager cannot edit their way into a stronger profile, profile revisions do
 * not silently widen assignments, and worker profiles remain ceilings.
 * Every person, business and resource is synthetic.
 */
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../server/app.js';
import type {
  AccessAssignment,
  AccessProfile,
  AuthorizationResource,
  OrganizationAccessView,
  WorkerProfile,
} from '../shared/business-access.js';
import type { Person, WorkspaceView } from '../shared/workspaces.js';

let server: Server | undefined;
let root = '';
let url = '';
const headers = { 'Content-Type': 'application/json', 'X-Diomedes-Client': '1' };

async function request<T = any>(route: string, method = 'GET', body?: unknown) {
  const response = await fetch(`${url}/api${route}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, data: (await response.json()) as T };
}

async function launch() {
  const app = await createApp({
    dataDir: path.join(root, 'data'),
    projectRoot: path.join(root, 'projects'),
  });
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server!.once('listening', resolve));
  url = `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
}

async function stop() {
  if (!server) return;
  const current = server;
  server = undefined;
  await new Promise<void>((resolve) => current.close(() => resolve()));
}

const identityPath = () => path.join(root, 'data', 'workspaces', 'identity.json');

async function restartAs(name: string) {
  await stop();
  const current = JSON.parse(await fs.readFile(identityPath(), 'utf8')) as Person;
  await fs.writeFile(
    identityPath(),
    JSON.stringify({ ...current, id: `person_${name}`, name }, null, 2),
    'utf8',
  );
  await launch();
}

async function createOrganization(name = 'Sample Restaurant') {
  const response = await request<WorkspaceView>('/workspace/organizations', 'POST', {
    name,
    industry: 'restaurant',
  });
  expect(response.status).toBe(200);
  const created = response.data.organizations.at(-1);
  if (!created) throw new Error('organization was not created');
  return created.organization.id;
}

async function inviteAndJoin(organizationId: string, name: string) {
  const invitation = await request<{ code: string }>(
    `/workspace/organizations/${organizationId}/invitations`,
    'POST',
    { role: 'member' },
  );
  expect(invitation.status).toBe(200);
  await restartAs(name);
  expect(
    (await request('/workspace/organizations/join', 'POST', { code: invitation.data.code })).status,
  ).toBe(200);
  await restartAs('owner');
}

async function createResource(
  organizationId: string,
  input: { type: string; parentId: string; label: string; externalId?: string | null },
) {
  const response = await request<AuthorizationResource>(
    `/workspace/organizations/${organizationId}/access/resources`,
    'POST',
    input,
  );
  expect(response.status).toBe(200);
  return response.data;
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'diomedes-business-access-'));
  await launch();
  await restartAs('owner');
});

afterEach(async () => {
  await stop();
  await fs.rm(root, { recursive: true, force: true });
});

describe('protected Owner foundation', () => {
  test('creating an organization creates one tenant root and a pinned Owner assignment', async () => {
    const organizationId = await createOrganization();
    const response = await request<OrganizationAccessView>(
      `/workspace/organizations/${organizationId}/access`,
    );
    expect(response.status).toBe(200);
    expect(response.data.organizationId).toBe(organizationId);
    expect(response.data.resources).toEqual([
      expect.objectContaining({
        type: 'organization',
        parentId: null,
        externalId: organizationId,
        label: 'Sample Restaurant',
      }),
    ]);
    expect(response.data.profiles).toEqual([
      expect.objectContaining({
        name: 'Owner',
        revision: 1,
        systemKind: 'owner',
        state: 'active',
      }),
    ]);
    expect(response.data.assignments).toEqual([
      expect.objectContaining({
        personId: 'person_owner',
        profileRevision: 1,
        revokedAt: null,
        scopes: [
          expect.objectContaining({
            resourceId: response.data.resources[0]!.id,
            includeDescendants: true,
          }),
        ],
      }),
    ]);
  });

  test('membership changes advance authorization generation without granting a member access', async () => {
    const organizationId = await createOrganization();
    const before = await request<OrganizationAccessView>(
      `/workspace/organizations/${organizationId}/access`,
    );
    await inviteAndJoin(organizationId, 'member');
    const after = await request<OrganizationAccessView>(
      `/workspace/organizations/${organizationId}/access`,
    );
    expect(after.data.organizationGeneration).toBe(before.data.organizationGeneration + 1);
    expect(
      after.data.assignments.filter((assignment) => assignment.personId === 'person_member'),
    ).toEqual([]);
  });
});

describe('custom human profiles and exact scopes', () => {
  test('a Head Chef discovers assigned kitchen data but not finance or another business area', async () => {
    const organizationId = await createOrganization();
    await inviteAndJoin(organizationId, 'chef');
    const access = await request<OrganizationAccessView>(
      `/workspace/organizations/${organizationId}/access`,
    );
    const rootResource = access.data.resources[0]!;
    const downtown = await createResource(organizationId, {
      type: 'location',
      parentId: rootResource.id,
      label: 'Downtown',
    });
    const kitchen = await createResource(organizationId, {
      type: 'business-area',
      parentId: downtown.id,
      label: 'Kitchen',
    });
    await createResource(organizationId, {
      type: 'data-scope',
      parentId: kitchen.id,
      label: 'Recipes',
    });
    const ownerOffice = await createResource(organizationId, {
      type: 'business-area',
      parentId: rootResource.id,
      label: 'Owner office',
    });
    await createResource(organizationId, {
      type: 'data-scope',
      parentId: ownerOffice.id,
      label: 'Finance',
    });

    const profile = await request<AccessProfile>(
      `/workspace/organizations/${organizationId}/access/profiles`,
      'POST',
      {
        name: 'Kitchen lead',
        description: 'Recipe and count work in an assigned kitchen.',
        permissions: ['recipe:view', 'inventory:view', 'inventory:count'],
      },
    );
    expect(profile.status).toBe(200);
    const assignment = await request<AccessAssignment>(
      `/workspace/organizations/${organizationId}/access/assignments`,
      'POST',
      {
        personId: 'person_chef',
        profileId: profile.data.id,
        profileRevision: 1,
        scopes: [{ resourceId: kitchen.id, includeDescendants: true }],
      },
    );
    expect(assignment.status).toBe(200);

    await restartAs('chef');
    const recipes = await request<AuthorizationResource[]>(
      `/workspace/organizations/${organizationId}/access/resources?permission=recipe%3Aview`,
    );
    expect(recipes.status).toBe(200);
    expect(recipes.data.map((resource) => resource.label)).toEqual(['Kitchen', 'Recipes']);

    const finance = await request<AuthorizationResource[]>(
      `/workspace/organizations/${organizationId}/access/resources?permission=finance%3Aview`,
    );
    expect(finance.status).toBe(200);
    expect(finance.data).toEqual([]);

    const adminView = await request(`/workspace/organizations/${organizationId}/access`);
    expect(adminView.status).toBe(403);
  });

  test('unknown permissions fail closed and an ordinary member cannot self-escalate', async () => {
    const organizationId = await createOrganization();
    await inviteAndJoin(organizationId, 'gm');

    const unknown = await request<{ code?: string }>(
      `/workspace/organizations/${organizationId}/access/profiles`,
      'POST',
      {
        name: 'Do anything',
        description: 'Invalid fixture.',
        permissions: ['kitchen:do_anything'],
      },
    );
    expect(unknown.status).toBe(400);
    expect(unknown.data.code).toBe('unknown_permission');

    await restartAs('gm');
    const profile = await request<{ code?: string }>(
      `/workspace/organizations/${organizationId}/access/profiles`,
      'POST',
      {
        name: 'Owner by another name',
        description: 'Must not be accepted.',
        permissions: ['authorization:assign', 'finance:manage'],
      },
    );
    expect(profile.status).toBe(403);
    expect(profile.data.code).toBe('not_owner');
  });

  test('a new profile revision is inert until the assignment is explicitly replaced', async () => {
    const organizationId = await createOrganization();
    await inviteAndJoin(organizationId, 'chef');
    const access = await request<OrganizationAccessView>(
      `/workspace/organizations/${organizationId}/access`,
    );
    const kitchen = await createResource(organizationId, {
      type: 'business-area',
      parentId: access.data.resources[0]!.id,
      label: 'Kitchen',
    });
    const profile = await request<AccessProfile>(
      `/workspace/organizations/${organizationId}/access/profiles`,
      'POST',
      {
        name: 'Kitchen lead',
        description: 'Counts only.',
        permissions: ['inventory:count'],
      },
    );
    const assigned = await request<AccessAssignment>(
      `/workspace/organizations/${organizationId}/access/assignments`,
      'POST',
      {
        personId: 'person_chef',
        profileId: profile.data.id,
        profileRevision: 1,
        scopes: [{ resourceId: kitchen.id, includeDescendants: true }],
      },
    );
    expect(assigned.status).toBe(200);

    const revised = await request<AccessProfile>(
      `/workspace/organizations/${organizationId}/access/profiles/${profile.data.id}/revisions`,
      'POST',
      {
        expectedRevision: 1,
        name: 'Kitchen lead',
        description: 'Counts and cost visibility.',
        permissions: ['inventory:count', 'inventory:view_cost'],
      },
    );
    expect(revised.status).toBe(200);
    expect(revised.data.revision).toBe(2);

    await restartAs('chef');
    const before = await request<AuthorizationResource[]>(
      `/workspace/organizations/${organizationId}/access/resources?permission=inventory%3Aview_cost`,
    );
    expect(before.status).toBe(200);
    expect(before.data).toEqual([]);

    await restartAs('owner');
    const revoked = await request<AccessAssignment>(
      `/workspace/organizations/${organizationId}/access/assignments/${assigned.data.id}/revoke`,
      'POST',
      { expectedRevision: 1 },
    );
    expect(revoked.status).toBe(200);
    expect(revoked.data.revokedAt).not.toBeNull();
    const replacement = await request<AccessAssignment>(
      `/workspace/organizations/${organizationId}/access/assignments`,
      'POST',
      {
        personId: 'person_chef',
        profileId: profile.data.id,
        profileRevision: 2,
        scopes: [{ resourceId: kitchen.id, includeDescendants: true }],
      },
    );
    expect(replacement.status).toBe(200);

    await restartAs('chef');
    const after = await request<AuthorizationResource[]>(
      `/workspace/organizations/${organizationId}/access/resources?permission=inventory%3Aview_cost`,
    );
    expect(after.status).toBe(200);
    expect(after.data.map((resource) => resource.label)).toEqual(['Kitchen']);
  });
});

describe('worker profiles stay separate from human access', () => {
  test('an Owner creates a versioned worker ceiling that grants no authority', async () => {
    const organizationId = await createOrganization();
    const access = await request<OrganizationAccessView>(
      `/workspace/organizations/${organizationId}/access`,
    );
    const kitchen = await createResource(organizationId, {
      type: 'business-area',
      parentId: access.data.resources[0]!.id,
      label: 'Kitchen',
    });
    const worker = await request<WorkerProfile>(
      `/workspace/organizations/${organizationId}/access/worker-profiles`,
      'POST',
      {
        name: 'Kitchen operations worker',
        purpose: 'Prepare recipes and reconcile counts.',
        executionMode: 'interactive',
        agent: {
          id: 'diomedes.general',
          version: '1',
          digest: `sha256:${'d'.repeat(64)}`,
        },
        permissionCeilings: ['recipe:view', 'inventory:count'],
        resourceCeilings: [{ resourceId: kitchen.id, includeDescendants: true }],
        contextCeilings: ['recipes', 'inventory-counts'],
        toolCeilings: ['inventory.read', 'inventory.count'],
        ruleScopes: ['kitchen-safety'],
        routeCeilings: ['local'],
      },
    );
    expect(worker.status).toBe(200);
    expect(worker.data).toMatchObject({
      revision: 1,
      state: 'active',
      grantsAuthority: false,
      permissionCeilings: ['inventory:count', 'recipe:view'],
    });

    const administrativeWorker = await request<{ code?: string }>(
      `/workspace/organizations/${organizationId}/access/worker-profiles`,
      'POST',
      {
        name: 'Escalating worker',
        purpose: 'Must be refused.',
        executionMode: 'interactive',
        agent: {
          id: 'diomedes.general',
          version: '1',
          digest: `sha256:${'e'.repeat(64)}`,
        },
        permissionCeilings: ['authorization:assign'],
        resourceCeilings: [{ resourceId: kitchen.id, includeDescendants: true }],
        contextCeilings: [],
        toolCeilings: [],
        ruleScopes: [],
        routeCeilings: ['local'],
      },
    );
    expect(administrativeWorker.status).toBe(400);
    expect(administrativeWorker.data.code).toBe('worker_permission_forbidden');
  });
});
