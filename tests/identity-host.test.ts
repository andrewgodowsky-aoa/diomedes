import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { Store } from '../server/store.js';
import { FileAccountRepository } from '../server/business/account-store.js';
import { AccountService } from '../server/business/account-service.js';
import { AccountHost, createAccountHandler } from '../server/business/identity-host.js';
import { mountAccountRoutes } from '../server/business/account-routes.js';
import { installTrustBackend, revoke, type Principal } from '../server/trust/index.js';
import { __resetRevocationState } from '../server/trust/revocation.js';

let root: string;
let now: number;
let accounts: AccountService;
let host: AccountHost;
let orgId: string;
let tenantId: string;
let principal: Principal;
const origin = 'https://inventory.example.test';
const issuer = 'https://api.workos.com/';

function request(token = 'alice', init: RequestInit = {}) {
  return new Request(`${origin}/account/session`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, Origin: origin, ...init.headers },
  });
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'diomedes-account-host-'));
  now = Date.parse('2026-09-20T00:00:00Z');
  const store = new Store(path.join(root, 'data'), path.join(root, 'projects'));
  await store.init();
  accounts = new AccountService(
    new FileAccountRepository(store),
    {
      issuer,
      verify: async (token) => ({
        issuer,
        subject: `user_${token}`,
        sessionId: `session_${token}`,
        displayName: token,
        emailVerified: true,
        issuedAt: new Date(now - 1000).toISOString(),
        expiresAt: new Date(now + 300_000).toISOString(),
        verifiedAt: new Date(now).toISOString(),
      }),
    },
    { now: () => now },
  );
  const org = await accounts.createOrganization('alice', 'Warehouse');
  orgId = org.id;
  tenantId = org.tenantId;
  const session = await accounts.signIn('alice');
  principal = {
    kind: 'session',
    id: session.principalId,
    tenantId,
    projectId: 'project_a',
    deviceId: null,
    sessionId: session.sessionId,
    slotId: null,
  };
  installTrustBackend({
    lookupTeamMember: async () => null,
    localOwner: async () => null,
    lookupPrincipalRef: async (ref) => (ref.id === principal.id ? { ...principal } : null),
  });
  host = new AccountHost(accounts, {
    allowedOrigins: [origin],
    now: () => now,
    resolveProject: async () => ({ organizationId: orgId, tenantId, projectId: 'project_a' }),
  });
});

afterEach(async () => {
  installTrustBackend({
    lookupTeamMember: async () => null,
    localOwner: async () => null,
    lookupPrincipalRef: async () => null,
  });
  __resetRevocationState();
  await fs.rm(root, { recursive: true, force: true });
});

test('derives actor and tenant from provider/membership and consumes existing Trust', async () => {
  const value = await host.withProjectAccess(
    request(),
    { organizationId: orgId, projectId: 'project_a' },
    'project.read',
    (context) => context,
  );
  expect(value).toMatchObject({
    scope: { organizationId: orgId, tenantId, projectId: 'project_a' },
    actorPersonId: (await accounts.signIn('alice')).person.id,
    sessionId: 'session_alice',
  });
  expect(JSON.stringify(value)).not.toContain('Bearer');
});

test('cross-tenant, wrong project and absent membership deny before reading any records', async () => {
  let effects = 0;
  for (const [token, organizationId, projectId] of [
    ['bob', orgId, 'project_a'],
    ['alice', orgId, 'project_b'],
    ['alice', 'org_other', 'project_a'],
  ])
    await expect(
      host.withProjectAccess(
        request(token),
        { organizationId, projectId },
        'project.read',
        () => ++effects,
      ),
    ).rejects.toMatchObject({ status: 403 });
  expect(effects).toBe(0);
});

test('account ownership grants no write.apply capability', async () => {
  let writes = 0;
  await expect(
    host.withProjectAccess(
      request(),
      { organizationId: orgId, projectId: 'project_a' },
      'write.apply',
      () => ++writes,
    ),
  ).rejects.toMatchObject({ status: 403 });
  expect(writes).toBe(0);
});

test.each(['tenantId', 'projectId', 'sessionId'] as const)(
  'refuses an existing Trust result bound to another %s',
  async (key) => {
    principal[key] = 'other';
    await expect(
      host.withProjectAccess(
        request(),
        { organizationId: orgId, projectId: 'project_a' },
        'project.read',
        () => true,
      ),
    ).rejects.toMatchObject({ status: 403 });
  },
);

test('membership revocation during admission denies the waiting request', async () => {
  const invite = await accounts.invite('alice', orgId, {
    subject: 'user_bob',
    role: 'owner',
    ttlMs: 60_000,
  });
  await accounts.acceptInvitation('bob', orgId, invite.token);
  const alice = await accounts.signIn('alice');
  host = new AccountHost(accounts, {
    allowedOrigins: [origin],
    now: () => now,
    resolveProject: async () => {
      await accounts.setMembership('bob', orgId, alice.person.id, {
        role: 'member',
        state: 'revoked',
      });
      return { organizationId: orgId, tenantId, projectId: 'project_a' };
    },
  });
  await expect(
    host.withProjectAccess(
      request(),
      { organizationId: orgId, projectId: 'project_a' },
      'project.read',
      () => true,
    ),
  ).rejects.toMatchObject({ status: 403 });
});

test('logout while Trust resolves and Trust revocation both deny admission', async () => {
  installTrustBackend({
    lookupTeamMember: async () => null,
    localOwner: async () => null,
    lookupPrincipalRef: async () => {
      await accounts.revokeLocalSession('alice');
      return { ...principal };
    },
  });
  await expect(
    host.withProjectAccess(
      request(),
      { organizationId: orgId, projectId: 'project_a' },
      'project.read',
      () => true,
    ),
  ).rejects.toMatchObject({ status: 401 });
  await revoke(principal, 'Revoked fixture principal.');
  await expect(
    host.withProjectAccess(
      request(),
      { organizationId: orgId, projectId: 'project_a' },
      'project.read',
      () => true,
    ),
  ).rejects.toMatchObject({ status: 401 });
});

test('no header-supplied actor, cookie-only session or hostile origin establishes identity', async () => {
  const attempts: Record<string, string>[] = [
    { 'X-Diomedes-Client': '1', 'X-User-Id': 'alice', 'X-Tenant-Id': tenantId },
    { Cookie: 'session=alice' },
    { Authorization: 'Bearer alice', Origin: 'https://attacker.example.test' },
    { Authorization: 'Bearer alice', Origin: 'null' },
  ];
  for (const headers of attempts) {
    const req = new Request(`${origin}/account/session`, { headers });
    await expect(
      host.withProjectAccess(
        req,
        { organizationId: orgId, projectId: 'project_a' },
        'project.read',
        () => true,
      ),
    ).rejects.toBeDefined();
  }
});

test('Fetch account surface validates input, denies cross-site writes and returns no tokens', async () => {
  const handle = createAccountHandler(accounts, { allowedOrigins: [origin] });
  const response = await handle(request());
  expect(response.status).toBe(200);
  expect(response.headers.get('cache-control')).toBe('no-store');
  expect(await response.text()).not.toContain('Bearer');
  const post = (body: unknown, from = origin) =>
    new Request(`${origin}/account/organizations`, {
      method: 'POST',
      headers: { Authorization: 'Bearer alice', Origin: from, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  expect((await handle(post({ name: 'B', tenantId: 'tenant_stolen', paid: true }))).status).toBe(
    422,
  );
  expect((await handle(post({ name: 'B' }, 'https://attacker.example.test'))).status).toBe(403);
  expect((await handle(post({ name: 'B' }))).status).toBe(201);
  const forged = new Request(`${origin}/account/session`, { headers: { 'X-User-Id': 'alice' } });
  expect((await handle(forged)).status).toBe(401);
});

test('Fetch logout is POST-only and a revoked bearer is refused after it', async () => {
  const handle = createAccountHandler(accounts, { allowedOrigins: [origin] });
  const url = `${origin}/account/session/revoke`;
  const headers = { Authorization: 'Bearer alice', Origin: origin };
  expect((await handle(new Request(url, { headers }))).status).toBe(404);
  expect((await handle(new Request(url, { method: 'POST', headers }))).status).toBe(204);
  expect((await handle(request())).status).toBe(401);
});

test('Trust principal revocation denies an otherwise active account and membership', async () => {
  await revoke(principal, 'Revoked by existing Trust.');
  let calls = 0;
  await expect(
    host.withProjectAccess(
      request(),
      { organizationId: orgId, projectId: 'project_a' },
      'project.read',
      () => ++calls,
    ),
  ).rejects.toMatchObject({ status: 403 });
  expect(calls).toBe(0);
});

test('changed project binding and expiry during admission deny before callback', async () => {
  for (const mode of ['binding', 'expiry']) {
    let resolutions = 0;
    host = new AccountHost(accounts, {
      allowedOrigins: [origin],
      now: () => now,
      resolveProject: async () => {
        resolutions++;
        if (resolutions === 2 && mode === 'expiry') now += 30_001;
        return {
          organizationId: orgId,
          tenantId,
          projectId: resolutions === 2 && mode === 'binding' ? 'project_other' : 'project_a',
        };
      },
    });
    let calls = 0;
    await expect(
      host.withProjectAccess(
        request(),
        { organizationId: orgId, projectId: 'project_a' },
        'project.read',
        () => ++calls,
      ),
    ).rejects.toMatchObject({ status: mode === 'binding' ? 403 : 401 });
    expect(calls).toBe(0);
  }
});

test('missing Trust lookup cannot be replaced by account membership', async () => {
  installTrustBackend({
    lookupTeamMember: async () => null,
    localOwner: async () => null,
    lookupPrincipalRef: async () => null,
  });
  await expect(
    host.withProjectAccess(
      request(),
      { organizationId: orgId, projectId: 'project_a' },
      'project.read',
      () => true,
    ),
  ).rejects.toMatchObject({ status: 401 });
});

test('Fetch boundary rejects malformed/oversized bodies and query credentials, and restricts preflight', async () => {
  const handle = createAccountHandler(accounts, { allowedOrigins: [origin] });
  const headers = {
    Authorization: 'Bearer alice',
    Origin: origin,
    'Content-Type': 'application/json',
  };
  const post = (value: string) =>
    new Request(`${origin}/account/organizations`, { method: 'POST', headers, body: value });
  expect((await handle(post('{'))).status).toBe(422);
  expect((await handle(post(JSON.stringify({ name: 'a'.repeat(17000) })))).status).toBe(413);
  expect(
    (await handle(new Request(`${origin}/account/session?token=alice`, { headers }))).status,
  ).toBe(422);
  const preflight = (requestedHeaders: string) =>
    new Request(`${origin}/account/organizations`, {
      method: 'OPTIONS',
      headers: {
        Origin: origin,
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': requestedHeaders,
      },
    });
  expect((await handle(preflight('authorization,content-type'))).status).toBe(204);
  expect((await handle(preflight('x-actor-person-id'))).status).toBe(403);
});

test('Fetch invitation and membership operations enforce exact recipient and owner rights', async () => {
  const handle = createAccountHandler(accounts, { allowedOrigins: [origin] });
  const send = (token: string, route: string, method: string, data: unknown) =>
    handle(
      new Request(`${origin}${route}`, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          Origin: origin,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(data),
      }),
    );
  const invitation = await send('alice', `/account/organizations/${orgId}/invitations`, 'POST', {
    subject: 'user_bob',
    role: 'member',
    ttlMs: 60_000,
  });
  expect(invitation.status).toBe(201);
  const value = await invitation.json();
  expect(
    (
      await send('eve', `/account/organizations/${orgId}/invitations/accept`, 'POST', {
        token: value.token,
      })
    ).status,
  ).toBe(403);
  expect(
    (
      await send('bob', `/account/organizations/${orgId}/invitations/accept`, 'POST', {
        token: value.token,
      })
    ).status,
  ).toBe(200);
  const bob = await accounts.signIn('bob');
  expect(
    (
      await send('bob', `/account/organizations/${orgId}/members/${bob.person.id}`, 'PATCH', {
        role: 'owner',
        state: 'active',
      })
    ).status,
  ).toBe(403);
  expect(
    (
      await send('alice', `/account/organizations/${orgId}/members/${bob.person.id}`, 'PATCH', {
        role: 'member',
        state: 'revoked',
      })
    ).status,
  ).toBe(200);
});

test('optional Express mount serves the same account contract on an owned loopback listener', async () => {
  const app = express();
  mountAccountRoutes(app, accounts, { allowedOrigins: [origin] });
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  try {
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/account`;
    const response = await fetch(`${url}/session`, {
      headers: { Authorization: 'Bearer alice', Origin: origin },
    });
    expect(response.status).toBe(200);
    expect((await response.json()).organizations[0].organization.id).toBe(orgId);
    const create = await fetch(`${url}/organizations`, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer alice',
        Origin: origin,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ name: 'Second business' }),
    });
    expect(create.status).toBe(201);
    expect((await fetch(`${url}/session`)).status).toBe(401);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
