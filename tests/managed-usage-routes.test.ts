/**
 * The allowance HTTP surface, through the real host.
 *
 * Two claims, and the second is the one worth the file.
 *
 * The view is honest: with no entitlement service installed there are no
 * numbers, and the response says so rather than returning zeroes. A drawn
 * balance of zero reads as "you have spent your allowance", which is a
 * different statement and an untrue one.
 *
 * And the organization comes from the URL and is re-checked against membership
 * every time, including on a replay carrying an identifier that really does
 * exist. A cross-tenant replay leak of exactly this shape was found and fixed
 * once already in `server/configuration.ts`; this holds the same line here.
 *
 * Every company here is invented. No key was used and nothing was charged.
 */
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../server/app.js';
import { ALLOWANCE_MEANING, RATE_CARD_V1, periodIdFor } from '../shared/managed-usage.js';
import type { AllowanceView } from '../shared/managed-usage.js';
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

async function restartAs(name: string) {
  await stop();
  const file = path.join(root, 'data', 'workspaces', 'identity.json');
  const current = JSON.parse(await fs.readFile(file, 'utf8')) as Person;
  await fs.writeFile(
    file,
    JSON.stringify({ ...current, id: `person_${name}`, name }, null, 2),
    'utf8',
  );
  await launch();
}

async function makeOrganization(name: string): Promise<string> {
  const view = await request<WorkspaceView>('/workspace/organizations', 'POST', {
    name,
    industry: null,
  });
  expect(view.status).toBe(200);
  return view.data.organizations.at(-1)!.organization.id;
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'diomedes-allowance-'));
  await launch();
});

afterEach(async () => {
  await stop();
  await fs.rm(root, { recursive: true, force: true });
});

describe('the allowance view', () => {
  test('says there is no allowance rather than showing an empty one', async () => {
    const organizationId = await makeOrganization('Fernbrook Joinery');
    const view = await request<AllowanceView>(
      `/workspace/organizations/${organizationId}/allowance`,
    );
    expect(view.status).toBe(200);
    expect(view.data.available).toBe(false);
    // Absent, not zero. This is the assertion the whole file exists for.
    expect(view.data.summary).toBeNull();
    expect(view.data.unavailableReason).toBeTruthy();
    expect(view.data.meaning).toBe(ALLOWANCE_MEANING);
    expect(view.data.rateCardVersion).toBe(RATE_CARD_V1.version);
  });

  test('a period id is the billing month, so a reinstall cannot mint a new one', () => {
    expect(periodIdFor('2026-09-10T09:00:00.000Z')).toBe('2026-09');
    expect(periodIdFor('2026-09-30T23:59:59.000Z')).toBe('2026-09');
    expect(periodIdFor('2026-10-01T00:00:00.000Z')).toBe('2026-10');
  });
});

describe('one company cannot read or move another company’s money', () => {
  test('a non-member reads an allowance as absent, not as forbidden', async () => {
    const organizationId = await makeOrganization('Fernbrook Joinery');
    await restartAs('outsider');
    const view = await request<{ code?: string }>(
      `/workspace/organizations/${organizationId}/allowance`,
    );
    expect(view.status).toBe(404);
    expect(view.data.code).toBe('organization_not_found');
  });

  test('a non-member cannot apply a billing event to it', async () => {
    const organizationId = await makeOrganization('Fernbrook Joinery');
    await restartAs('outsider');
    const applied = await request<{ code?: string }>(
      `/workspace/organizations/${organizationId}/billing-events`,
      'POST',
      {
        type: 'period.allocated',
        eventId: 'evt_forged',
        periodId: '2026-09',
        planVersion: 'plan-x',
        grantedMicroUsd: 100_000_000,
        startsAt: '2026-09-01T00:00:00.000Z',
        endsAt: '2026-10-01T00:00:00.000Z',
        sequence: 1,
      },
    );
    expect(applied.status).toBe(404);
    expect(applied.data.code).toBe('organization_not_found');
  });

  test('an admission for a company you are not in is refused', async () => {
    const organizationId = await makeOrganization('Fernbrook Joinery');
    await restartAs('outsider');
    const admitted = await request<{ code?: string }>(
      `/workspace/organizations/${organizationId}/allowance/admit`,
      'POST',
      {
        route: 'codex',
        kind: 'generation',
        maxMicroUsd: 1_000_000,
        requestDigest: 'digest',
        reservationId: 'res_forged',
      },
    );
    expect(admitted.status).toBe(404);
    expect(admitted.data.code).toBe('organization_not_found');
  });
});

describe('admission through the route', () => {
  test('a business with no setup running has not permitted work to leave', async () => {
    const organizationId = await makeOrganization('Fernbrook Joinery');
    const admitted = await request<{ admitted: boolean; code: string }>(
      `/workspace/organizations/${organizationId}/allowance/admit`,
      'POST',
      {
        route: 'codex',
        kind: 'generation',
        maxMicroUsd: 1_000_000,
        requestDigest: 'digest',
        reservationId: 'res_1',
        // A forged client claim, ignored: the host resolves entitlement itself.
        paid: true,
      },
    );
    expect(admitted.status).toBe(200);
    expect(admitted.data.admitted).toBe(false);
    // Not `no_entitlement`, though that is also true. Nothing has been
    // activated, so nothing said this company's work may leave its computers,
    // and the strict reading is the correct one to refuse on first. The
    // entitlement refusal itself is held directly in tests/managed-gateway.
    expect(admitted.data.code).toBe('data_route_refused');
  });

  test('a local route is admitted without a plan, and holds nothing', async () => {
    const organizationId = await makeOrganization('Fernbrook Joinery');
    const admitted = await request<{ admitted: boolean; payer: string; reservation: unknown }>(
      `/workspace/organizations/${organizationId}/allowance/admit`,
      'POST',
      {
        route: 'ollama',
        kind: 'generation',
        maxMicroUsd: 1_000_000,
        requestDigest: 'digest',
        reservationId: 'res_local',
      },
    );
    expect(admitted.status).toBe(200);
    // Work that never leaves the computer needs no entitlement and no money.
    expect(admitted.data.admitted).toBe(true);
    expect(admitted.data.payer).toBe('local');
    expect(admitted.data.reservation).toBeNull();
  });

  test('a malformed amount is refused before it reaches the ledger', async () => {
    const organizationId = await makeOrganization('Fernbrook Joinery');
    const admitted = await request<{ code?: string }>(
      `/workspace/organizations/${organizationId}/allowance/admit`,
      'POST',
      {
        route: 'codex',
        kind: 'generation',
        maxMicroUsd: 1.5,
        requestDigest: 'digest',
        reservationId: 'res_2',
      },
    );
    expect(admitted.status).toBe(400);
  });

  test('an unknown charge kind is refused rather than treated as a generation', async () => {
    const organizationId = await makeOrganization('Fernbrook Joinery');
    const admitted = await request(
      `/workspace/organizations/${organizationId}/allowance/admit`,
      'POST',
      {
        route: 'codex',
        kind: 'something-new',
        maxMicroUsd: 1_000_000,
        requestDigest: 'digest',
        reservationId: 'res_3',
      },
    );
    expect(admitted.status).toBe(400);
  });
});
