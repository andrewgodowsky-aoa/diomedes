import { describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { createApp } from '../server/app.js';
import { EngineService, TESTED_VERSIONS } from '../server/engines/service.js';
import { routeContractFor } from '../server/harness/route-contract.js';
import { Store } from '../server/store.js';
import { AllowanceLedger } from '../server/managed-usage.js';
import { RATE_CARD_V1, dollars, type MicroUsd } from '../shared/managed-usage.js';
import {
  ADMISSION_FIXTURES, ENTITLEMENT_FIXTURES, assertMembership, assertionStale,
  decideAdmission, leaseUsable, snapshotAt, type CredentialLease,
} from '../services/control-plane/contract/index.js';
import type { Membership, Organization } from '../shared/workspaces.js';

const at = '2026-09-17T03:00:00.000Z';
const generation = { identity: 1, principal: 1 };
const organization: Organization = {
  v: 1, id: 'org-review', name: 'Review fixture', industry: null,
  tenantId: 'tenant-review', identitySource: 'development-fixture',
  createdAt: at, createdBy: 'person-review',
};
const membership: Membership = {
  v: 1, organizationId: organization.id, personId: 'person-review', role: 'owner',
  state: 'active', invitedAt: at, joinedAt: at, revokedAt: null, revokedReason: null,
};
const lease: CredentialLease = {
  handle: 'fixture-handle', principalId: membership.personId, tenantId: organization.tenantId,
  resources: ['repo-review'], scopes: ['read'], generation, expiresAt: '2026-10-01T00:00:00Z',
};

describe('B00 independent acceptance: authority evidence is complete', () => {
  it.each([null, '', 'invalid', '2026-09-18T00:00:00Z'])(
    'does not admit an entitlement with unproven or future issuance %j', (issuedAt) => {
      const view = structuredClone(ADMISSION_FIXTURES.active.view);
      expect(decideAdmission({ ...view, at, entitlement: { ...view.entitlement, issuedAt } }).decided)
        .toBe('refused');
    },
  );
  it('an empty revocation marker is not absence of a revocation record', () => {
    expect(snapshotAt({ ...ENTITLEMENT_FIXTURES.active, revokedAt: '' }, at).state).toBe('unknown');
  });
  it.each([-1, 0.5, Number.POSITIVE_INFINITY])('refuses an invalid entitlement revision %s', (revision) => {
    expect(snapshotAt({ ...ENTITLEMENT_FIXTURES.active, revision }, at).state).toBe('unknown');
  });
  it.each([-1, 0.5, Number.POSITIVE_INFINITY])('refuses matching invalid generation %s', (value) => {
    const bad = { identity: value, principal: value };
    expect(leaseUsable({ ...lease, generation: bad }, bad, at).usable).toBe(false);
    expect(assertMembership({ organization, membership, generation: bad, at }).asserted).toBe(false);
  });
  it('marks an assertion stale when both stored and live generations are invalid', () => {
    expect(assertionStale({
      organizationId: organization.id, tenantId: organization.tenantId!, personId: membership.personId,
      role: membership.role, assertedAt: at, generation: { identity: -1, principal: -1 },
    }, { identity: -1, principal: -1 })).toBe(true);
  });
  it('retains valid admission, revocation precedence and immutable historical snapshots', () => {
    const active = structuredClone(ENTITLEMENT_FIXTURES.active);
    expect(snapshotAt(active, at).state).toBe('active');
    expect(snapshotAt({ ...active, revokedAt: '2026-09-01T00:00:00Z', issuedAt: null }, at).state)
      .toBe('revoked');
    expect(active).toEqual(ENTITLEMENT_FIXTURES.active);
    expect(leaseUsable(lease, generation, at).usable).toBe(true);
    expect(assertMembership({ organization, membership, generation, at }).asserted).toBe(true);
  });
});

describe('B00 independent acceptance: existing host remains authoritative', () => {
  it.each([Number.NaN, Number.POSITIVE_INFINITY, -1, 0.5])(
    'refuses an unbounded managed reservation without creating a hold: %s', async (max) => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), 'b00-money-review-'));
      try {
        const store = new Store(path.join(root, 'data'), path.join(root, 'projects'));
        await store.init();
        const ledger = new AllowanceLedger(store);
        await ledger.init();
        await ledger.allocatePeriod({
          organizationId: 'org-review', periodId: '2026-09', planVersion: 'test-plan',
          rateCardVersion: RATE_CARD_V1.version, grantedMicroUsd: dollars(10),
          startsAt: '2026-09-01T00:00:00Z', endsAt: '2026-10-01T00:00:00Z',
          sourceEventId: 'test-billing-event', at,
        });
        await expect(ledger.reserve({
          reservationId: 'review-hold', organizationId: 'org-review', periodId: '2026-09',
          parentTaskId: null, kind: 'generation', route: 'codex', payer: 'managed',
          maxMicroUsd: max as MicroUsd, rateCardVersion: RATE_CARD_V1.version,
          parentEnvelopeMicroUsd: null, at,
        })).rejects.toMatchObject({ status: 400, details: { code: 'invalid_ceiling' } });
        expect(ledger.summary('org-review', '2026-09').pendingMicroUsd).toBe(0);
      } finally { await fs.rm(root, { recursive: true, force: true }); }
    },
  );

  it('starts Personal and dispatches BYO through HTTP with no hosted identity or entitlement', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'b00-personal-review-'));
    const engine = 'claude-code';
    let dispatches = 0;
    const engines = new EngineService(path.join(root, 'engines'), {
      discover: async () => [{
        id: engine, name: 'Fixture', kind: 'online', found: true, available: false, enabled: false,
        status: 'Installed', detail: 'Offline transport', capabilities: [], signIn: 'unknown',
        adapter: 'planned', installedVersion: TESTED_VERSIONS[engine], location: 'fixture.exe', disclosure: [],
      }],
      version: async () => TESTED_VERSIONS[engine],
      adapter: () => ({
        id: engine,
        contract: routeContractFor(engine),
        inspect: async () => ({ authentication: 'signed-in', accountRoute: 'byo:fixture',
          models: [{ slug: 'fixture-model', name: 'Fixture', description: '', efforts: [], defaultEffort: null }], detail: 'Offline fixture' }),
        generate: async (input) => {
          dispatches++;
          return { projectId: input.projectId, threadId: input.threadId, requestId: input.requestId,
            model: input.model, text: 'Personal BYO result', version: TESTED_VERSIONS[engine] };
        },
      }),
    });
    const app = await createApp({ dataDir: path.join(root, 'data'), projectRoot: path.join(root, 'projects'), engineService: engines });
    const server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
    const api = async (endpoint: string, method = 'GET', body?: unknown) => {
      const response = await fetch(base + endpoint, {
        method, headers: { 'Content-Type': 'application/json', 'X-Diomedes-Client': '1' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      expect(response.ok, `${method} ${endpoint}`).toBe(true);
      return response.json();
    };
    try {
      const workspace = await api('/workspace');
      expect(workspace.active).toEqual({ kind: 'personal' });
      expect(workspace.organizations).toEqual([]);
      expect(workspace.hosted.available).toBe(false);
      const forged = await fetch(base + '/settings', {
        method: 'PUT', headers: { 'Content-Type': 'application/json', 'X-Diomedes-Client': '1' },
        body: JSON.stringify({ identitySource: 'hosted', entitlement: { managedInference: true }, paid: true }),
      });
      expect(forged.status).toBe(400);
      const after = await api('/workspace');
      expect(after.person.assurance).toBe('development-fixture');
      expect(after.hosted.available).toBe(false);
      await api('/ai/discover', 'POST', { consent: true });
      await api(`/ai/check/${engine}`, 'POST', {});
      await api('/ai/select', 'POST', { engine, model: 'fixture-model' });
      const project = await api('/projects', 'POST', { name: 'Offline Personal review' });
      const thread = await api(`/projects/${project.id}/threads`, 'POST', {});
      // Default-deny cloud sharing: this synthetic project explicitly grants the
      // claude-code route with no source documents and no prior history (single ask, sources []).
      await api(`/projects/${project.id}/cloud-sharing`, 'PUT', {
        expectedVersion: 0,
        routes: ['claude-code'],
        documents: [],
        shareConversationHistory: false,
        shareReviewPackets: false,
      });
      const answer = await api(`/projects/${project.id}/ask`, 'POST', {
        text: 'Fixture question', mode: 'ask', route: engine, threadId: thread.id, consent: true,
      });
      expect(answer.turn.text).toBe('Personal BYO result');
      expect(dispatches).toBe(1);
    } finally {
      await app.locals.close();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
