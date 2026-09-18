/**
 * Who may change how Diomedes looks.
 *
 * Two halves, deliberately separate:
 *
 * - the three pure checks in `shared/customization-entitlement.ts`, exercised
 *   against every named state in `fixtures/entitlement-states.json` plus the
 *   membership cases a fixture cannot express; and
 * - the routes, because hiding a button is not enforcement. Every privileged
 *   mutation is sent by a client that ignores the UI entirely — a raw `fetch`
 *   with the right headers — and must come back refused with a reason code.
 *
 * The free half is asserted in the same run and from the same profile: reading,
 * discarding a draft and the safe reset keep working with no plan at all. A
 * regression that gated one of those would be a person who cannot put their own
 * app back the way it was, which is the failure this file exists to catch.
 */
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../server/app.js';
import {
  CUSTOMIZATION_PLAN_IDS,
  CUSTOMIZATION_REFUSAL,
  FREE_APPEARANCE_FEATURES,
  canActivateOrganizationRevision,
  canEditThemeScope,
  hasCustomizationEntitlement,
  type CustomizationActor,
  type CustomizationStatus,
} from '../shared/customization-entitlement.js';
import type { EntitlementSnapshot } from '../services/control-plane/contract/index.js';
import type { Membership, WorkspaceRef } from '../shared/workspaces.js';
import type { ThemePackV1 } from '../shared/theme-pack/types.js';
import fixtures from '../fixtures/entitlement-states.json' with { type: 'json' };

const NOW = '2026-09-17T12:00:00.000Z';
const PERSONAL: WorkspaceRef = { kind: 'personal' };
const BUSINESS: WorkspaceRef = { kind: 'business', organizationId: 'org_fixture' };

const profiles = fixtures.profiles as unknown as Readonly<
  Record<string, { authoring: boolean; snapshot: EntitlementSnapshot }>
>;

const actor = (
  profile: keyof typeof profiles | string,
  overrides: Partial<CustomizationActor> = {},
): CustomizationActor => ({
  personId: 'person_1',
  entitlement: profiles[profile]!.snapshot,
  authoring: profiles[profile]!.authoring,
  membership: null,
  at: NOW,
  ...overrides,
});

const membership = (role: Membership['role'], state: Membership['state'] = 'active'): Membership =>
  ({
    v: 1,
    organizationId: BUSINESS.organizationId,
    personId: 'person_1',
    role,
    state,
    joinedAt: '2026-01-01T00:00:00.000Z',
  }) as unknown as Membership;

// ---------------------------------------------------------------------------
// The three checks, as pure predicates
// ---------------------------------------------------------------------------

describe('hasCustomizationEntitlement', () => {
  test('the six named states answer exactly once each', () => {
    expect(hasCustomizationEntitlement(profiles.free!.snapshot, NOW)).toBe(false);
    expect(hasCustomizationEntitlement(profiles.paid!.snapshot, NOW)).toBe(true);
    // Design authoring is not an entitlement, and it never becomes one.
    expect(hasCustomizationEntitlement(profiles.designer!.snapshot, NOW)).toBe(false);
    expect(hasCustomizationEntitlement(profiles.unauthorized!.snapshot, NOW)).toBe(false);
    expect(hasCustomizationEntitlement(profiles.offline!.snapshot, NOW)).toBe(false);
    expect(hasCustomizationEntitlement(profiles.downgraded!.snapshot, NOW)).toBe(false);
  });

  test('an active plan that is not a customization plan grants nothing', () => {
    expect(CUSTOMIZATION_PLAN_IDS).toContain('plan_business');
    expect(CUSTOMIZATION_PLAN_IDS).not.toContain(profiles.unauthorized!.snapshot.planId);
  });

  test('a plan that expires stops granting the moment it does', () => {
    const snapshot = { ...profiles.paid!.snapshot, expiresAt: '2026-09-17T11:00:00.000Z' };
    expect(hasCustomizationEntitlement(snapshot, '2026-09-17T10:00:00.000Z')).toBe(true);
    expect(hasCustomizationEntitlement(snapshot, NOW)).toBe(false);
  });

  test('no snapshot at all is a refusal, never a default', () => {
    expect(hasCustomizationEntitlement(null, NOW)).toBe(false);
    expect(hasCustomizationEntitlement(undefined, NOW)).toBe(false);
  });
});

describe('canEditThemeScope', () => {
  test('a paid plan authors in the personal scope', () => {
    expect(canEditThemeScope(actor('paid'), PERSONAL)).toEqual({ allowed: true, via: 'entitlement' });
  });

  test('design authoring authors in the personal scope and nowhere else', () => {
    expect(canEditThemeScope(actor('designer'), PERSONAL)).toEqual({
      allowed: true,
      via: 'authoring',
    });
    const business = canEditThemeScope(
      actor('designer', { membership: membership('owner') }),
      BUSINESS,
    );
    expect(business.allowed).toBe(false);
    expect(business).toMatchObject({ code: CUSTOMIZATION_REFUSAL.localScopeOnly });
  });

  test('free, unauthorized, offline and downgraded are all refused, each in its own words', () => {
    for (const profile of ['free', 'unauthorized', 'downgraded'] as const) {
      const decision = canEditThemeScope(actor(profile), PERSONAL);
      expect(decision.allowed).toBe(false);
      expect(decision).toMatchObject({ code: CUSTOMIZATION_REFUSAL.noPlan });
      expect('reason' in decision && decision.reason).toMatch(/requires an active plan/i);
    }
    // Offline is its own code: could-not-ask is not the same as has-not-paid.
    const offline = canEditThemeScope(actor('offline'), PERSONAL);
    expect(offline).toMatchObject({ allowed: false, code: CUSTOMIZATION_REFUSAL.unknown });
  });

  test('a business scope checks membership before it checks the plan', () => {
    const stranger = canEditThemeScope(actor('paid', { membership: null }), BUSINESS);
    expect(stranger).toMatchObject({ allowed: false, code: CUSTOMIZATION_REFUSAL.notAMember });
    const revoked = canEditThemeScope(
      actor('paid', { membership: membership('owner', 'revoked') }),
      BUSINESS,
    );
    expect(revoked).toMatchObject({ allowed: false, code: CUSTOMIZATION_REFUSAL.notAMember });
    // A plain member with the plan may still author the company's themes.
    expect(
      canEditThemeScope(actor('paid', { membership: membership('member') }), BUSINESS),
    ).toEqual({ allowed: true, via: 'entitlement' });
  });

  test("another person's membership record does not become yours", () => {
    const theirs = { ...membership('owner'), personId: 'person_2' } as Membership;
    expect(canEditThemeScope(actor('paid', { membership: theirs }), BUSINESS)).toMatchObject({
      allowed: false,
      code: CUSTOMIZATION_REFUSAL.notAMember,
    });
  });
});

describe('canActivateOrganizationRevision', () => {
  test('an owner or an admin with the plan may; a member may not', () => {
    for (const role of ['owner', 'admin'] as const)
      expect(
        canActivateOrganizationRevision(
          actor('paid', { membership: membership(role) }),
          BUSINESS.organizationId,
        ),
      ).toEqual({ allowed: true, via: 'entitlement' });
    expect(
      canActivateOrganizationRevision(
        actor('paid', { membership: membership('member') }),
        BUSINESS.organizationId,
      ),
    ).toMatchObject({ allowed: false, code: CUSTOMIZATION_REFUSAL.notOrganizationAdmin });
  });

  test('design authoring never reaches organization activation', () => {
    expect(
      canActivateOrganizationRevision(
        actor('designer', { membership: membership('owner') }),
        BUSINESS.organizationId,
      ),
    ).toMatchObject({ allowed: false, code: CUSTOMIZATION_REFUSAL.noPlan });
  });
});

// ---------------------------------------------------------------------------
// The routes
// ---------------------------------------------------------------------------

let server: Server | undefined;
let root = '';
let url = '';
const HEADERS = { 'Content-Type': 'application/json', 'X-Diomedes-Client': '1' };

async function request<T = any>(
  route: string,
  method = 'GET',
  body?: unknown,
  extra: Record<string, string> = {},
) {
  const response = await fetch(`${url}/api${route}`, {
    method,
    headers: { ...HEADERS, ...extra },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, data: (await response.json()) as T };
}

/** A pack the contract accepts, so a refusal can only be about entitlement. */
function pack(id: string): ThemePackV1 {
  const color = (value: string) => ({ $type: 'color' as const, $value: value });
  return {
    schemaVersion: 1,
    id,
    name: `Theme ${id}`,
    revision: 1,
    baseTheme: 'graphite',
    surfaces: ['app-console'],
    provenance: { author: 'A5 test', createdAt: '2026-09-17T00:00:00.000Z', tool: 'vitest' },
    tokens: {
      color: {
        chrome: color('#101014'),
        surface: color('#15151a'),
        raised: color('#1b1b22'),
        hair: color('#ffffff12'),
        hair2: color('#ffffff1f'),
        t1: color('#f2f2f5'),
        t2: color('#b6b6c0'),
        t3: color('#8b8b96'),
        light: color('#7cf7ff'),
        attn: color('#ffce6a'),
        fail: color('#ff8080'),
      },
      lightScheme: { $type: 'boolean', $value: false },
    },
    typography: {
      interfaceScale: 1,
      readingScale: 1,
      codeScale: 1,
      lineHeight: 1.55,
      interfaceFont: 'schibsted-grotesk',
      readingFont: 'schibsted-grotesk',
      codeFont: 'ibm-plex-mono',
    },
    geometry: { controlRadius: 6, separatorStrength: 1, density: 'standard' },
    artwork: {},
    motion: { presetId: 'settle', duration: 160, intensity: 0.5, reducedMotionBehaviour: 'static' },
    assets: {},
  } as ThemePackV1;
}

async function launch(env: Record<string, string | undefined>) {
  for (const [key, value] of Object.entries(env))
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  const app = await createApp({
    dataDir: path.join(root, 'data'),
    projectRoot: path.join(root, 'projects'),
  });
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server!.once('listening', resolve));
  url = `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'diomedes-customization-'));
});

afterEach(async () => {
  const current = server;
  server = undefined;
  for (const key of [
    'DIOMEDES_TEST_MODE',
    'DIOMEDES_ENTITLEMENT_FIXTURE',
    'DIOMEDES_DESIGN_AUTHORING',
  ])
    delete process.env[key];
  if (current) await new Promise<void>((resolve) => current.close(() => resolve()));
  await fs.rm(root, { recursive: true, force: true }).catch(() => undefined);
});

describe('the routes enforce it, not the buttons', () => {
  test('with no plan every privileged mutation is refused with a reason code', async () => {
    await launch({ DIOMEDES_TEST_MODE: '1', DIOMEDES_ENTITLEMENT_FIXTURE: 'free' });

    const saved = await request('/themes/free-try', 'PUT', pack('free-try'));
    expect(saved.status).toBe(403);
    expect(saved.data.code).toBe(CUSTOMIZATION_REFUSAL.noPlan);
    expect(saved.data.error).toMatch(/requires an active plan/i);

    // An autosave is a premium mutation with a small name.
    const draft = await request('/themes/free-try', 'PUT', { ...pack('free-try'), draft: true });
    expect(draft.status).toBe(403);

    const activated = await request('/themes/free-try/activate', 'POST');
    expect(activated.status).toBe(403);

    const restored = await request('/themes/free-try/restore/1', 'POST');
    expect(restored.status).toBe(403);

    const upload = await fetch(`${url}/api/themes/free-try/assets`, {
      method: 'POST',
      headers: { 'Content-Type': 'image/png', 'X-Diomedes-Client': '1' },
      body: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
    });
    expect(upload.status).toBe(403);

    // And nothing reached storage.
    const list = await request<{ themes: unknown[] }>('/themes');
    expect(list.data.themes).toEqual([]);
  });

  test('the free half keeps working with no plan and no network', async () => {
    await launch({ DIOMEDES_TEST_MODE: '1', DIOMEDES_ENTITLEMENT_FIXTURE: 'free' });
    expect((await request('/themes')).status).toBe(200);
    expect((await request('/themes/active')).status).toBe(200);
    // A theme nobody made is missing, not forbidden: reading is never gated.
    expect((await request('/themes/anything')).status).toBe(404);
    // Discarding an autosave and the safe reset are the two ways back.
    expect((await request('/themes/anything/draft', 'DELETE')).status).toBe(200);
    expect((await request('/themes/reset', 'POST')).status).toBe(200);
    // Text size is an ordinary settings patch and is untouched by any of this.
    const zoom = await request('/settings', 'PUT', { appearance: { interfaceScale: 1.25 } });
    expect(zoom.status).toBe(200);
    // The list of free features is stated by the service, not inferred here.
    const rights = await request<CustomizationStatus>('/design-center/entitlement');
    expect(rights.data.granted).toBe(false);
    expect(rights.data.freeFeatures).toEqual([...FREE_APPEARANCE_FEATURES]);
  });

  test('a paid plan saves, applies and imports a picture', async () => {
    await launch({ DIOMEDES_TEST_MODE: '1', DIOMEDES_ENTITLEMENT_FIXTURE: 'paid' });
    const saved = await request('/themes/paid-try', 'PUT', pack('paid-try'));
    expect(saved.status).toBe(200);
    expect((await request('/themes/paid-try/activate', 'POST')).status).toBe(200);
    const rights = await request<CustomizationStatus>('/design-center/entitlement');
    expect(rights.data).toMatchObject({
      granted: true,
      via: 'entitlement',
      authoring: false,
      entitlementState: 'active',
      planId: 'plan_business',
    });
  });

  test('design authoring is a launch-time authorization and it saves', async () => {
    await launch({
      DIOMEDES_TEST_MODE: '1',
      DIOMEDES_ENTITLEMENT_FIXTURE: 'free',
      DIOMEDES_DESIGN_AUTHORING: '1',
    });
    const rights = await request<CustomizationStatus>('/design-center/entitlement');
    expect(rights.data).toMatchObject({ granted: true, via: 'authoring', authoring: true });
    // The local scope is granted; the entitlement itself still says no.
    expect(rights.data.entitlementState).toBe('none');
    expect((await request('/themes/designer-try', 'PUT', pack('designer-try'))).status).toBe(200);
  });

  test('offline refuses with its own code and downgraded with the plan one', async () => {
    await launch({ DIOMEDES_TEST_MODE: '1', DIOMEDES_ENTITLEMENT_FIXTURE: 'offline' });
    const offline = await request('/themes/offline-try', 'PUT', pack('offline-try'));
    expect(offline.status).toBe(403);
    expect(offline.data.code).toBe(CUSTOMIZATION_REFUSAL.unknown);
    // The per-request fixture header only works because this process already
    // opted into fixtures at launch. It is how one dev server answers for six
    // named states in the browser suite.
    const downgraded = await request(
      '/themes/offline-try',
      'PUT',
      pack('offline-try'),
      { 'X-Diomedes-Entitlement-Fixture': 'downgraded' },
    );
    expect(downgraded.status).toBe(403);
    expect(downgraded.data.code).toBe(CUSTOMIZATION_REFUSAL.noPlan);
    // A theme already applied keeps being applied through all of it.
    expect((await request('/themes/active')).status).toBe(200);
  });

  test('an unauthorized plan is an active plan that bought something else', async () => {
    await launch({ DIOMEDES_TEST_MODE: '1', DIOMEDES_ENTITLEMENT_FIXTURE: 'unauthorized' });
    const rights = await request<CustomizationStatus>('/design-center/entitlement');
    expect(rights.data).toMatchObject({ granted: false, entitlementState: 'active' });
    expect((await request('/themes/nope', 'PUT', pack('nope'))).status).toBe(403);
  });

  test('without test mode the fixture name is inert, and the honest answer is refusal', async () => {
    // The env var alone cannot reach the fixture table. This is the shape a
    // production build has: no plan catalogue, no entitlement service, refusal.
    await launch({ DIOMEDES_TEST_MODE: undefined, DIOMEDES_ENTITLEMENT_FIXTURE: 'paid' });
    const rights = await request<CustomizationStatus>('/design-center/entitlement');
    expect(rights.data).toMatchObject({ granted: false, authoring: false });
    expect((await request('/themes/nope', 'PUT', pack('nope'))).status).toBe(403);
  });

  test('a header cannot buy a plan in a build that is not running on fixtures', async () => {
    await launch({});
    const bought = await request('/themes/nope', 'PUT', pack('nope'), {
      'X-Diomedes-Entitlement-Fixture': 'paid',
    });
    expect(bought.status).toBe(403);
  });
});
