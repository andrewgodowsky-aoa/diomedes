/**
 * The one design engagement a paid plan includes.
 *
 * What is proven here is what a promise with money behind it has to survive:
 *
 * - the whole state machine runs once, end to end, and `accepted` records the
 *   delivery rather than inventing a state for it;
 * - a retried step with the same idempotency key is recorded once, whatever
 *   the network did;
 * - a failed draft goes back to `eligible`, because the benefit was promised
 *   and not delivered, so it is still owed;
 * - an accepted benefit is consumed, and nothing mints a second one;
 * - **restoring an older theme revision never mints a benefit** — a claim about
 *   absence, so it is asserted as byte-identical stored records across a
 *   restore rather than trusted from reading the code;
 * - the whole surface belongs to a business, and a personal workspace is told
 *   so rather than given an empty one.
 */
import { afterEach, beforeEach, expect, test } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../server/app.js';
import type { BenefitView } from '../server/customization-benefit.js';
import type { ThemePackV1 } from '../shared/theme-pack/types.js';
import type { WorkspaceView } from '../shared/workspaces.js';

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

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'diomedes-benefit-'));
  // The benefit is what a paid plan includes, so the tests that exercise it run
  // on the named `paid` fixture. `tests/customization-entitlement.test.ts` is
  // where the refusal without a plan is proven.
  process.env.DIOMEDES_TEST_MODE = '1';
  process.env.DIOMEDES_ENTITLEMENT_FIXTURE = 'paid';
  const app = await createApp({
    dataDir: path.join(root, 'data'),
    projectRoot: path.join(root, 'projects'),
  });
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server!.once('listening', resolve));
  url = `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
});

afterEach(async () => {
  const current = server;
  server = undefined;
  delete process.env.DIOMEDES_TEST_MODE;
  delete process.env.DIOMEDES_ENTITLEMENT_FIXTURE;
  if (current) await new Promise<void>((resolve) => current.close(() => resolve()));
  await fs.rm(root, { recursive: true, force: true }).catch(() => undefined);
});

/** Make a business and stay in it. Creating one switches the active workspace. */
async function business(): Promise<string> {
  const created = await request<WorkspaceView>('/workspace/organizations', 'POST', {
    name: 'Ridge Cabinetry',
    industry: null,
  });
  expect(created.status).toBe(200);
  return created.data.organizations[0]!.organization.id;
}

const step = (name: string, body: Record<string, unknown>) =>
  request<{ applied: boolean; code: string | null; benefit: BenefitView }>(
    `/benefits/customization/${name}`,
    'POST',
    body,
  );

const read = () => request<{ benefit: BenefitView }>('/benefits/customization');

const benefitFile = (organizationId: string) =>
  path.join(root, 'data', 'benefits', `${organizationId}.json`);

test('a personal workspace is told the benefit belongs to a business', async () => {
  const answer = await read();
  expect(answer.status).toBe(409);
  expect(answer.data).toMatchObject({ code: 'benefit_needs_business' });
});

test('the engagement runs eligible → requested → draft → review → accepted, once', async () => {
  const organizationId = await business();
  expect((await read()).data.benefit).toMatchObject({ state: 'eligible', sequence: 0 });

  const requested = await step('request', { idempotencyKey: 'k1' });
  expect(requested.data.benefit).toMatchObject({ state: 'requested', sequence: 1 });
  expect(requested.data.benefit.engagementId).toBeTruthy();
  expect(requested.data.benefit.actor).toBeTruthy();
  expect(requested.data.benefit.requestedAt).toBeTruthy();

  const drafted = await step('draft', {
    idempotencyKey: 'k2',
    themeId: 'ridge-brand',
    themeRevision: 3,
  });
  expect(drafted.data.benefit).toMatchObject({
    state: 'draft',
    sequence: 2,
    themeId: 'ridge-brand',
    themeRevision: 3,
  });

  expect((await step('review', { idempotencyKey: 'k3' })).data.benefit).toMatchObject({
    state: 'customer_review',
    sequence: 3,
  });

  const accepted = await step('accept', { idempotencyKey: 'k4' });
  expect(accepted.data.benefit).toMatchObject({ state: 'accepted', sequence: 4, consumed: true });
  // Delivery is what acceptance records; there is no delivered-but-not-accepted.
  expect(accepted.data.benefit.deliveredAt).toBe(accepted.data.benefit.acceptedAt);

  // Consumed once. A second engagement is not available at any sequence.
  const again = await step('request', { idempotencyKey: 'k5' });
  expect(again.status).toBe(409);
  expect(again.data).toMatchObject({ code: 'benefit_consumed' });

  // It is durable, and under the per-organization path the billing records use.
  const stored = JSON.parse(await fs.readFile(benefitFile(organizationId), 'utf8')) as Record<
    string,
    unknown
  >;
  expect(stored).toMatchObject({ state: 'accepted', consumed: true });
});

test('a repeated step with the same key is recorded once', async () => {
  await business();
  await step('request', { idempotencyKey: 'once' });
  const repeat = await step('request', { idempotencyKey: 'once' });
  expect(repeat.status).toBe(200);
  expect(repeat.data).toMatchObject({ applied: false, code: 'benefit_already_applied' });
  expect(repeat.data.benefit).toMatchObject({ state: 'requested', sequence: 1 });

  await step('draft', { idempotencyKey: 'd1', themeId: 'ridge-brand', themeRevision: 1 });
  await step('review', { idempotencyKey: 'r1' });
  const accept = await step('accept', { idempotencyKey: 'a1' });
  expect(accept.data.benefit.sequence).toBe(4);
  // A retried accept after a dropped connection is not a second acceptance and
  // is not an error either: it is the state the caller asked for.
  const retried = await step('accept', { idempotencyKey: 'a1' });
  expect(retried.status).toBe(200);
  expect(retried.data).toMatchObject({ applied: false, code: 'benefit_already_applied' });
  expect(retried.data.benefit.sequence).toBe(4);
});

test('a failed draft returns to eligible and the benefit is still owed', async () => {
  await business();
  await step('request', { idempotencyKey: 'q1' });
  await step('draft', { idempotencyKey: 'q2', themeId: 'ridge-brand', themeRevision: 2 });
  const failed = await step('fail', { idempotencyKey: 'q3', reason: 'The colours were wrong.' });
  expect(failed.data.benefit).toMatchObject({
    state: 'eligible',
    consumed: false,
    engagementId: null,
    themeId: null,
    themeRevision: null,
    lastFailureReason: 'The colours were wrong.',
  });
  // Still owed: it can be asked for again, and it is a fresh engagement.
  const again = await step('request', { idempotencyKey: 'q4' });
  expect(again.data.benefit).toMatchObject({ state: 'requested', consumed: false });
  expect(again.data.benefit.engagementId).toBeTruthy();
});

test('a step out of order is a conflict, not a silent move', async () => {
  await business();
  const early = await step('accept', { idempotencyKey: 'x1' });
  expect(early.status).toBe(409);
  expect(early.data).toMatchObject({ code: 'benefit_invalid_transition' });
  expect((await read()).data.benefit.state).toBe('eligible');
});

test('every step carries an idempotency key or it is refused', async () => {
  await business();
  const naked = await step('request', {});
  expect(naked.status).toBe(400);
  expect(naked.data).toMatchObject({ code: 'benefit_no_idempotency_key' });
});

test('restoring an older theme revision never mints a benefit', async () => {
  const organizationId = await business();
  await step('request', { idempotencyKey: 'b1' });
  await step('draft', { idempotencyKey: 'b2', themeId: 'ridge-brand', themeRevision: 1 });
  const before = await fs.readFile(benefitFile(organizationId), 'utf8');

  // Two revisions of a theme, then a restore of the first one.
  expect((await request('/themes/ridge-brand', 'PUT', pack('ridge-brand'))).status).toBe(200);
  // The second save carries the revision it was editing, the way A2's
  // concurrent-save guard requires.
  const second = await request<{ revision: number }>(
    '/themes/ridge-brand',
    'PUT',
    { ...pack('ridge-brand'), name: 'Second' },
    { 'If-Match': '"1"' },
  );
  expect(second.status).toBe(200);
  const restored = await request('/themes/ridge-brand/restore/1', 'POST');
  expect(restored.status).toBe(200);

  // Byte-identical. Not "still looks right" — the same file.
  expect(await fs.readFile(benefitFile(organizationId), 'utf8')).toBe(before);
  expect((await read()).data.benefit).toMatchObject({ state: 'draft', sequence: 2 });
});
