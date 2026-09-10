/**
 * Where a business job writes.
 *
 * The weekly brief has been composable for a while and unreachable for exactly
 * one reason: `WeeklyBriefService.run()` takes a `projectId` and nothing in the
 * product decided one. These tests hold the decision that closes that gap — an
 * explicit, per-organization output project — and, more importantly, they hold
 * the three ways the obvious shortcuts would have been wrong.
 *
 * Writing into "whatever project is open" would let switching workspace
 * mid-run redirect a company's output. Creating a project on demand would put a
 * company's work somewhere nobody chose. Falling back to another project when
 * the bound one is gone would silently write a company's brief into the wrong
 * place, which is worse than not writing it.
 *
 * Every fixture is invented. No company here is real.
 */
import { describe, expect, test } from 'vitest';
import {
  canBindOutputProject,
  resolveBriefTarget,
  type OutputBinding,
} from '../shared/workspaces.js';
import type { Membership, Organization } from '../shared/workspaces.js';

const AT = '2026-09-10T09:00:00.000Z';

const organization = (id: string, name: string): Organization => ({
  v: 1,
  id,
  name,
  industry: null,
  tenantId: `tenant-${id}`,
  identitySource: 'development-fixture',
  createdAt: AT,
  createdBy: 'person_owner',
});

const membership = (organizationId: string, role: Membership['role']): Membership => ({
  v: 1,
  organizationId,
  personId: 'person_owner',
  role,
  state: 'active',
  invitedAt: AT,
  joinedAt: AT,
  revokedAt: null,
  revokedReason: null,
});

const binding = (projectId: string, projectName: string): OutputBinding => ({
  projectId,
  projectName,
  boundAt: AT,
  boundBy: 'person_owner',
});

const ACME = organization('org-acme', 'Fernbrook Joinery');
const PROJECTS = [
  { id: 'proj-books', name: 'Company books' },
  { id: 'proj-other', name: 'Something else' },
];

describe('who may choose where a business writes', () => {
  test('an owner may bind the output project', () => {
    expect(canBindOutputProject(membership('org-acme', 'owner'))).toBe(true);
  });

  test('an admin may bind it', () => {
    expect(canBindOutputProject(membership('org-acme', 'admin'))).toBe(true);
  });

  test('an ordinary member may not', () => {
    expect(canBindOutputProject(membership('org-acme', 'member'))).toBe(false);
  });

  test('a revoked owner may not', () => {
    expect(canBindOutputProject({ ...membership('org-acme', 'owner'), state: 'revoked' })).toBe(
      false,
    );
  });
});

describe('resolving where this brief goes', () => {
  test('a bound project that exists is the target, carrying its tenant', () => {
    const target = resolveBriefTarget({
      organization: ACME,
      membership: membership('org-acme', 'owner'),
      binding: binding('proj-books', 'Company books'),
      projects: PROJECTS,
    });
    expect(target).toEqual({
      ready: true,
      organizationId: 'org-acme',
      tenantId: 'tenant-org-acme',
      projectId: 'proj-books',
      projectName: 'Company books',
    });
  });

  test('nothing bound asks for the choice rather than picking one', () => {
    const target = resolveBriefTarget({
      organization: ACME,
      membership: membership('org-acme', 'owner'),
      binding: null,
      projects: PROJECTS,
    });
    expect(target.ready).toBe(false);
    if (target.ready) throw new Error('unreachable');
    expect(target.code).toBe('no-output-project');
    // The sentence names the company, so a person with two of them knows which.
    expect(target.message).toContain('Fernbrook Joinery');
  });

  test('a project that has gone is named, not replaced', () => {
    const target = resolveBriefTarget({
      organization: ACME,
      membership: membership('org-acme', 'owner'),
      binding: binding('proj-deleted', 'Company books'),
      projects: PROJECTS,
    });
    expect(target.ready).toBe(false);
    if (target.ready) throw new Error('unreachable');
    expect(target.code).toBe('output-project-missing');
    expect(target.message).toContain('Company books');
    // The failure that matters: it must not quietly resolve to a project that
    // does exist. A brief in the wrong place is worse than no brief.
    expect(target.message).not.toContain('Something else');
  });

  test('a revoked member resolves nothing, whatever is still bound', () => {
    const target = resolveBriefTarget({
      organization: ACME,
      membership: { ...membership('org-acme', 'owner'), state: 'revoked' },
      binding: binding('proj-books', 'Company books'),
      projects: PROJECTS,
    });
    expect(target.ready).toBe(false);
    if (target.ready) throw new Error('unreachable');
    expect(target.code).toBe('not-a-member');
  });

  test('no membership at all resolves nothing', () => {
    const target = resolveBriefTarget({
      organization: ACME,
      membership: undefined,
      binding: binding('proj-books', 'Company books'),
      projects: PROJECTS,
    });
    expect(target.ready).toBe(false);
    if (target.ready) throw new Error('unreachable');
    expect(target.code).toBe('not-a-member');
  });

  test('two organizations resolve to their own projects, not to each others', () => {
    const other = organization('org-other', 'Halcyon Bakery');
    const first = resolveBriefTarget({
      organization: ACME,
      membership: membership('org-acme', 'owner'),
      binding: binding('proj-books', 'Company books'),
      projects: PROJECTS,
    });
    const second = resolveBriefTarget({
      organization: other,
      membership: membership('org-other', 'owner'),
      binding: binding('proj-other', 'Something else'),
      projects: PROJECTS,
    });
    expect(first.ready && first.projectId).toBe('proj-books');
    expect(second.ready && second.projectId).toBe('proj-other');
    expect(first.ready && first.tenantId).not.toBe(second.ready && second.tenantId);
  });
});
