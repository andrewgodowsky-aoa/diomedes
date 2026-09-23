/**
 * NC-2026-09-22.1 Phase G: the authenticated usage projection route, and the
 * absence of any funding write route. Offline memory adapters only.
 */
import { describe, expect, it } from 'vitest';
import { creditAmount } from '../../../shared/managed-usage.js';
import { createHandler } from '../src/worker.js';
import { FundingService, UsageService } from '../src/funding.js';
import { FundingMemoryRepository } from './support/funding-memory.js';
import { now, setup, validEnv } from './support/fixtures.js';

function request(path: string, init: RequestInit & { token?: string | null } = {}) {
  const { token = 'alice', ...rest } = init;
  const headers: Record<string, string> = { origin: 'http://127.0.0.1:8791', ...(rest.headers as Record<string, string> | undefined) };
  if (token !== null) headers.authorization = `Bearer ${token}`;
  return new Request(`http://127.0.0.1:8791${path}`, { ...rest, headers });
}

async function fixture(options: { grant?: boolean } = {}) {
  const { accounts } = setup();
  const organization = await accounts.createOrganization('alice', 'Fernbrook Joinery');
  const repository = new FundingMemoryRepository();
  const funding = new FundingService(repository, { now: () => now, approvedDefaultJobCapMicroUsd: creditAmount(20) });
  if (options.grant !== false)
    await funding.allocatePeriod({ tenantId: organization.tenantId, organizationId: organization.id, periodId: '2026-09', planId: 'business', sourceGrantId: 'grant_fixture' });
  const handler = createHandler(() => accounts, (_config, account) => new UsageService(account, funding));
  return { accounts, organization, repository, funding, handler };
}

describe('GET /account/organizations/:id/usage', () => {
  it('requires a verified bearer session', async () => {
    const { handler, organization } = await fixture();
    expect((await handler(request(`/account/organizations/${organization.id}/usage`, { token: null }), validEnv)).status).toBe(401);
  });

  it('refuses a person who is not an active member, without revealing whether the organization exists', async () => {
    const { handler, organization } = await fixture();
    const outsider = await handler(request(`/account/organizations/${organization.id}/usage`, { token: 'mallory' }), validEnv);
    expect(outsider.status).toBe(403);
    const missing = await handler(request('/account/organizations/org_missing/usage'), validEnv);
    expect(missing.status).toBe(403);
    expect(await outsider.text()).not.toMatch(/MicroUsd|granted/);
  });

  it('returns the member organization’s projection, labelled with its organization id', async () => {
    const { handler, organization } = await fixture();
    const response = await handler(request(`/account/organizations/${organization.id}/usage`), validEnv);
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const body = await response.json();
    expect(body.state).toBe('ready');
    expect(body.organizationId).toBe(organization.id);
    expect(body.projection.organizationId).toBe(organization.id);
    expect(body.projection.grantedMicroUsd).toBe(creditAmount(1000));
    expect(body.projection.usedPercent).toBe(0);
    expect(body.projection.resetsAt).toBe('2026-10-01T00:00:00.000Z');
    expect(body.projection.includedChat).toBeNull();
  });

  it('says unavailable, not zero, when no grant is recorded', async () => {
    const { handler, organization } = await fixture({ grant: false });
    const body = await (await handler(request(`/account/organizations/${organization.id}/usage`), validEnv)).json();
    expect(body).toEqual({ state: 'unavailable', organizationId: organization.id, reason: expect.stringMatching(/No credit grant/) });
  });

  it('rejects query parameters on the usage path', async () => {
    const { handler, organization } = await fixture();
    expect((await handler(request(`/account/organizations/${organization.id}/usage?tenant=other`), validEnv)).status).toBe(422);
  });
});

describe('funding state cannot be set through the Worker', () => {
  it('every write method on usage or funding paths is not found, and no row changes', async () => {
    const { handler, organization, repository } = await fixture();
    const before = repository.snapshot();
    const body = JSON.stringify({ grantedMicroUsd: creditAmount(1_000_000), state: 'settled', capMicroUsd: creditAmount(1_000_000) });
    for (const path of ['usage', 'funding', 'credits', 'jobs/job_1/cap', 'topups', 'reservations/r1'])
      for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
        const response = await handler(request(`/account/organizations/${organization.id}/${path}`, { method, headers: { 'content-type': 'application/json' }, body: method === 'DELETE' ? undefined : body }), validEnv);
        expect(response.status).toBe(404);
      }
    expect(repository.snapshot()).toEqual(before);
  });
});
