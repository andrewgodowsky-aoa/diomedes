/**
 * Remembered approvals (work order D5), proven through the real host.
 *
 * Learning only offers; authority is remembered only when the person clicks.
 * These tests drive the shipped fixture procedure (`format-report`) through
 * the real harness, Store and HTTP routes over a temporary directory: both
 * routes to a remembered approval, the offer at exactly the threshold and only
 * once, the declined answer that keeps it from coming back, the truthful
 * attribution an action under a grant carries, revocation, restart, and the
 * configuration and recovery paths that must never create or revive one.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../server/app.js';
import { Store } from '../server/store.js';
import type { HarnessHost } from '../server/harness/host.js';
import { localHarnessPrincipal } from '../server/harness/bridge.js';
import { REPORT_PATH } from '../server/harness/approval.js';
import { validateApprovalReceipts } from '../server/approval-admission.js';
import {
  scopeGrantDigest,
  validateScopeGrants,
  validateScopedAuthorization,
} from '../server/trust/scope-grants.js';
import {
  carryRememberedDecisions,
  patternDigest,
  patternForStep,
  validateRememberedApprovals,
  type ApprovalCandidate,
} from '../server/trust/remembered-approvals.js';
import {
  classifyApproval,
  classifyIntent,
  intentTargets,
  REMEMBER_OFFER_THRESHOLD,
  rememberedAttribution,
} from '../shared/remembered-approvals.js';
import type { ApprovalCommand, Need, ProjectState } from '../shared/types.js';
import type {
  PatternGrantRecord,
  RememberOffer,
  RememberedApprovalsView,
  ScopeGrantRecord,
} from '../shared/permissions.js';
import type { HarnessRun, StepIntent } from '../shared/harness.js';
import { activatePack } from '../server/capability-packs.js';
import { WorkspaceService, answersDigest } from '../server/workspaces.js';
import { AgentRegistry } from '../server/agents.js';
import { ConfigurationService } from '../server/configuration.js';
import { BUSINESS_SETUP_SCHEMA_REVISION } from '../shared/business-setup.js';
import type { ConfigurationProposal } from '../shared/configuration.js';

let root: string, projectId: string, url: string;
let app: Awaited<ReturnType<typeof createApp>>, server: Server | undefined;
const headers = { 'Content-Type': 'application/json', 'X-Diomedes-Client': '1' };
const store = (): Store => app.locals.store;
const host = (): HarnessHost => app.locals.harness;
const state = () => store().state(projectId);
const ATTRIBUTION = /^Ran under a remembered approval — you, since \d{1,2} [A-Z][a-z]+ \d{4}\.$/;

async function open() {
  app = await createApp({
    dataDir: path.join(root, 'data'),
    projectRoot: path.join(root, 'projects'),
  });
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server!.once('listening', resolve));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
async function close() {
  if (!server) return;
  const closingApp = app,
    closingServer = server;
  server = undefined;
  try {
    await closingApp.locals.close();
  } finally {
    closingServer.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      closingServer.close((error) => (error ? reject(error) : resolve())),
    );
  }
}
async function request<T>(
  route: string,
  method = 'GET',
  body?: unknown,
  extra: Record<string, string> = {},
) {
  const response = await fetch(`${url}/api/projects/${projectId}${route}`, {
    method,
    headers: { ...headers, ...extra },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, data: (await response.json()) as T };
}
function command(
  need: Need,
  resolution: ApprovalCommand['resolution'] = 'go-ahead',
): ApprovalCommand {
  return {
    protocolVersion: 1,
    commandId: `decision-${need.id}`,
    resolution,
    proposalDigest: need.approval!.proposalDigest,
    actionDigest: need.approval!.actionDigest,
    baseDigest: need.approval!.baseDigest,
  };
}
const view = async () => (await request<RememberedApprovalsView>('/permissions/remembered')).data;

async function untilRun(runId: string, expected: HarnessRun['state']) {
  await vi.waitFor(async () => expect((await host().get(projectId, runId)).state).toBe(expected), {
    timeout: 15_000,
  });
  await host().bridge.flush();
  return host().get(projectId, runId);
}
/** Start the fixture procedure and return its Need once it exists (open or covered). */
async function nextNeed(): Promise<Need> {
  const session = await host().bridge.startNativeRun(
    projectId,
    null,
    'format-report',
    'Format the shipped fixture.',
    localHarnessPrincipal(projectId),
  );
  await vi.waitFor(
    () => expect(state().needs.some((need) => need.sessionId === session.id)).toBe(true),
    { timeout: 15_000 },
  );
  return structuredClone(state().needs.find((need) => need.sessionId === session.id)!);
}
/** One exact approval, clicked, through to the finished run. */
async function approveOnce(resolution: ApprovalCommand['resolution'] = 'go-ahead') {
  const need = await nextNeed();
  expect(need.state).toBe('open');
  expect(
    (await request(`/needs/${need.id}/resolve`, 'POST', command(need, resolution))).status,
  ).toBe(200);
  await untilRun(need.harness!.runId, resolution === 'go-ahead' ? 'completed' : 'cancelled');
  return need;
}
/** A run that a remembered approval should cover, through to the finished run. */
async function coveredOnce() {
  const need = await nextNeed();
  const run = await untilRun(need.harness!.runId, 'completed');
  return { need: structuredClone(state().needs.find((item) => item.id === need.id)!), run };
}
async function candidateFor(need: Need, overrides: Partial<ApprovalCandidate> = {}) {
  const found = patternForStep({
    projectId,
    procedure: 'format-report',
    intent: need.harness!.intent,
    engine: 'native-fixture',
    accountRoute: null,
    procedureLabel: 'Format a fixture report',
  })!;
  const principal = localHarnessPrincipal(projectId);
  return {
    ...found,
    authority: {
      principalId: principal.id,
      identityGeneration: principal.identityGeneration,
      capabilities: principal.capabilities,
    },
    ...overrides,
  } satisfies ApprovalCandidate;
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'diomedes-remembered-'));
  await open();
  const project = await store().locked(() => store().createProject('Remembered approvals'));
  projectId = project.id;
});
afterEach(async () => {
  vi.restoreAllMocks();
  await close();
  await fs.rm(root, { recursive: true, force: true });
});

describe('the always-asks classifier', () => {
  const base = {
    procedure: 'weekly-brief',
    tool: 'send_brief',
    permission: 'send-email',
    effect: 'non-idempotent' as const,
    destination: 'external' as const,
    targets: ['to:ops@yourco.com'],
    deletes: false,
  };
  test('sending a report to named recipients and a recorded local write are rememberable', () => {
    expect(classifyApproval(base)).toEqual({ rememberable: true });
    expect(
      classifyApproval({
        ...base,
        procedure: 'format-report',
        tool: 'propose_write',
        permission: 'write-project-file',
        effect: 'idempotent',
        destination: 'local',
        targets: ['file:Harness report.md'],
      }),
    ).toEqual({ rememberable: true });
  });
  test.each([
    ['moves-money', { tool: 'pay_invoice' }],
    ['moves-money', { permission: 'payments.charge' }],
    ['moves-money', { procedure: 'refund-customer' }],
    ['moves-money', { tool: 'transferFunds' }],
    ['destroys-data', { tool: 'delete_rows' }],
    ['destroys-data', { tool: 'purge_archive' }],
    ['destroys-data', { deletes: true }],
    ['changes-access', { tool: 'invite_member' }],
    ['changes-access', { permission: 'rotate-credentials' }],
    ['changes-access', { tool: 'set_permissions' }],
    ['changes-access', { tool: 'share_folder' }],
    ['unrecognised', { permission: 'run-command' }],
    ['unrecognised', { permission: null }],
    ['unrecognised', { tool: null }],
    ['unrecognised', { targets: [] }],
    ['unrecognised', { destination: 'local' as const }],
    [
      'unrecognised',
      {
        permission: 'write-project-file',
        destination: 'local' as const,
        effect: 'non-idempotent' as const,
      },
    ],
  ])('%s: %o always asks', (category, change) => {
    expect(classifyApproval({ ...base, ...change })).toMatchObject({
      rememberable: false,
      category,
    });
  });
  // Review batch1-a, finding D5-1: inflected, run-together and acronym names, and a local write
  // whose file is itself a credential, still always ask.
  test.each([
    ['moves-money', { tool: 'paid_invoice_notice' }],
    ['moves-money', { tool: 'charged_card_receipt' }],
    ['moves-money', { procedure: 'refunded-orders' }],
    ['moves-money', { tool: 'sendpayment' }],
    ['moves-money', { tool: 'run_payroll' }],
    ['destroys-data', { tool: 'deletefile' }],
    ['destroys-data', { tool: 'deleted_rows_report' }],
    ['destroys-data', { tool: 'removing_old_drafts' }],
    ['destroys-data', { procedure: 'wiped-cache' }],
    ['destroys-data', { tool: 'prune_history' }],
    ['changes-access', { tool: 'send_invitation' }],
    ['changes-access', { tool: 'set_passwd' }],
    ['changes-access', { tool: 'rotate_accesstoken' }],
    ['changes-access', { tool: 'SSHKeyUpload' }],
    ['changes-access', { tool: 'send_magic_link' }],
    ['changes-access', { tool: 'grant_privileges' }],
  ])('%s: tricky name %o always asks', (category, change) => {
    expect(classifyApproval({ ...base, ...change })).toMatchObject({
      rememberable: false,
      category,
    });
  });
  const write = {
    ...base,
    procedure: 'format-report',
    tool: 'propose_write',
    permission: 'write-project-file',
    effect: 'idempotent' as const,
    destination: 'local' as const,
  };
  test.each([
    'file:.env',
    'file:config/.env.production',
    'file:credentials.json',
    'file:.ssh/authorized_keys',
    'file:deploy/id_rsa',
    'file:certs/server.pem',
    'file:.npmrc',
    'file:.git/config',
    'file:Team members.md',
  ])('changes-access: a local write to %s always asks', (target) => {
    expect(classifyApproval({ ...write, targets: [target] })).toMatchObject({
      rememberable: false,
      category: 'changes-access',
    });
  });
  test('ordinary names stay rememberable, and a recipient never trips a word list', () => {
    expect(classifyApproval({ ...write, targets: ['file:Harness report.md'] })).toEqual({
      rememberable: true,
    });
    expect(classifyApproval({ ...write, targets: ['file:Weekly brief.md'] })).toEqual({
      rememberable: true,
    });
    expect(classifyApproval({ ...base, targets: ['to:accounts@yourco.com'] })).toEqual({
      rememberable: true,
    });
  });
  test('a destination field the pattern cannot bind is never guessed at', () => {
    const send = {
      name: 'send_brief',
      permission: 'send-email',
      effect: 'non-idempotent',
      destination: 'external',
      kind: 'tool',
    } as const;
    for (const input of [
      { to: ['ops@yourco.com'], forwardTo: 'someone@else.com' },
      { to: ['ops@yourco.com'], webhook: 'https://hooks.example.com/x' },
      { to: ['ops@yourco.com'], recipient: 'someone@else.com' },
      { files: ['Harness report.md'], path: 'Other.md' },
    ])
      expect(classifyIntent('weekly-brief', { ...send, input } as unknown as StepIntent)).toMatchObject({
        category: 'unrecognised',
      });
    // A URL's path is case-sensitive: two webhooks differing only in case are two destinations.
    const upper = intentTargets({ destination: 'external', input: { url: 'https://hooks.example.com/T/AbC' } });
    const lower = intentTargets({ destination: 'external', input: { url: 'https://hooks.example.com/T/abc' } });
    expect(upper!.targets).not.toEqual(lower!.targets);
    // An address's case is not: the same mailbox stays the same recipient.
    expect(intentTargets({ destination: 'external', input: { to: 'Ops@YourCo.com ' } })!.targets).toEqual([
      'to:ops@yourco.com',
    ]);
  });
  test('money outranks everything, and an unreadable destination is never guessed at', () => {
    expect(classifyApproval({ ...base, tool: 'delete_payment_key' })).toMatchObject({
      category: 'moves-money',
    });
    const intent = {
      name: 'send_brief',
      permission: 'send-email',
      effect: 'non-idempotent',
      destination: 'external',
      kind: 'tool',
      input: { to: 42 },
    } as unknown as StepIntent;
    expect(classifyIntent('weekly-brief', intent)).toMatchObject({ category: 'unrecognised' });
    expect(
      classifyIntent('weekly-brief', { ...intent, input: { to: ['ops@yourco.com'] } }),
    ).toEqual({
      rememberable: true,
    });
  });
});

describe('both routes through the real host', () => {
  test('the learned offer appears exactly at the threshold, only once, and accepting creates the grant', async () => {
    expect(REMEMBER_OFFER_THRESHOLD).toBe(3);
    for (let i = 1; i < REMEMBER_OFFER_THRESHOLD; i++) {
      await approveOnce();
      expect((await view()).offers).toHaveLength(0);
      expect(state().rememberedApprovals?.grants ?? []).toHaveLength(0);
    }
    const third = await approveOnce();
    const offers = (await view()).offers;
    expect(offers).toHaveLength(1);
    expect(offers[0]).toMatchObject({
      state: 'open',
      approvals: 3,
      needId: third.id,
      what: 'Write Harness report.md (Format a fixture report)',
    });
    // Repeated approvals never create a grant on their own.
    expect(state().rememberedApprovals!.grants).toHaveLength(0);
    // A fourth approval with the offer still open makes no second offer.
    await approveOnce();
    expect(state().rememberedApprovals!.offers).toHaveLength(1);
    expect(state().rememberedApprovals!.grants).toHaveLength(0);

    const accepted = await request<PatternGrantRecord>(
      `/permissions/remembered/offers/${offers[0].id}/accept`,
      'POST',
      {},
    );
    expect(accepted.status).toBe(200);
    expect(accepted.data.grant).toMatchObject({
      protocolVersion: 3,
      kind: 'remembered-approval',
      route: 'learned-offer',
      acceptedBy: 'you',
      basis: { offerId: offers[0].id, approvals: 3, needId: third.id },
      pattern: {
        procedure: 'format-report',
        tool: 'propose_write',
        action: { permission: 'write-project-file', effect: 'idempotent' },
        destination: { kind: 'local', targets: ['file:Harness report.md'] },
        connection: { engine: 'native-fixture', accountRoute: null },
      },
    });
    const granted = state().history.find((entry) => entry.id === accepted.data.grant.eventId)!;
    expect(granted).toMatchObject({ kind: 'remembered-approval-granted', actor: 'you' });
    expect((await view()).offers).toHaveLength(0);
    // Accepting again replays the same grant.
    const replay = await request<PatternGrantRecord>(
      `/permissions/remembered/offers/${offers[0].id}/accept`,
      'POST',
      {},
    );
    expect(replay.data.grant.id).toBe(accepted.data.grant.id);

    const { need, run } = await coveredOnce();
    expect(need.approvalReceipt).toBeUndefined();
    expect(need.state).toBe('go-ahead');
    expect(need.decidedFrom).toBe('remembered-approval');
    expect(need.authorization).toMatchObject({
      kind: 'remembered-approval',
      grantId: accepted.data.grant.id,
      acceptedBy: 'you',
      acceptedAt: accepted.data.grant.createdAt,
      route: 'learned-offer',
    });
    expect(need.execution?.state).toBe('applied');
    // Truthful attribution in the run record, History, the write and the Session.
    expect(run.approvals.at(-1)).toMatchObject({
      decision: 'approved',
      decidedBy: `remembered-approval:${accepted.data.grant.id}`,
    });
    const text = rememberedAttribution({
      acceptedBy: 'you',
      acceptedAt: accepted.data.grant.createdAt,
    });
    expect(text).toMatch(ATTRIBUTION);
    const authorized = state().history.find((entry) => entry.id === need.authorization!.eventId)!;
    expect(authorized).toMatchObject({ kind: 'remembered-authorized', actor: 'diomedes' });
    expect(authorized.sentence).toBe(`${text} Write Harness report.md (Format a fixture report).`);
    const write = state().history.find((entry) => entry.id === need.execution!.eventId)!;
    expect(write.sentence).toContain(text);
    expect(write.sentence).not.toContain('allowed for this task');
    expect(write.authorization).toEqual(need.authorization);
    const session = state().sessions.find((item) => item.id === need.sessionId)!;
    expect(
      session.log.some((line) => line.level === 'plain' && line.sentence.startsWith(text)),
    ).toBe(true);
    expect(() => validateApprovalReceipts(state())).not.toThrow();
    expect(() => validateScopeGrants(state())).not.toThrow();
    // Four clicks and one offer answer; the fifth run asked nobody.
    expect(state().history.filter((entry) => entry.kind === 'decision')).toHaveLength(4);
  });

  test('a declined offer is remembered and does not come back', async () => {
    for (let i = 0; i < REMEMBER_OFFER_THRESHOLD; i++) await approveOnce();
    const offer = (await view()).offers[0];
    const declined = await request<RememberOffer>(
      `/permissions/remembered/offers/${offer.id}/decline`,
      'POST',
      {},
    );
    expect(declined.status).toBe(200);
    expect(declined.data.state).toBe('declined');
    const entry = state().history.find((item) => item.id === declined.data.eventId)!;
    expect(entry).toMatchObject({ kind: 'remembered-approval-declined', actor: 'you' });
    expect((await view()).offers).toHaveLength(0);
    for (let i = 0; i < REMEMBER_OFFER_THRESHOLD + 1; i++) {
      await approveOnce();
      expect((await view()).offers).toHaveLength(0);
    }
    expect(state().rememberedApprovals!.offers).toHaveLength(1);
    expect(state().rememberedApprovals!.grants).toHaveLength(0);
    // The declined offer cannot be accepted afterwards.
    expect(
      (await request(`/permissions/remembered/offers/${offer.id}/accept`, 'POST', {})).status,
    ).toBe(409);
    // The person can still ask, on the next prompt, with route 1.
    const need = await approveOnce();
    const remembered = await request<PatternGrantRecord>('/permissions/remembered', 'POST', {
      needId: need.id,
    });
    expect(remembered.status).toBe(200);
    expect(remembered.data.grant.route).toBe('approve-and-remember');
  });

  test('a decline starts the count again', async () => {
    await approveOnce();
    await approveOnce();
    await approveOnce('declined');
    await approveOnce();
    await approveOnce();
    expect((await view()).offers).toHaveLength(0);
    await approveOnce();
    expect((await view()).offers).toHaveLength(1);
  });

  test('Go ahead and remember covers the next identical step, once per item per project', async () => {
    const need = await approveOnce();
    const first = await request<PatternGrantRecord>('/permissions/remembered', 'POST', {
      needId: need.id,
    });
    expect(first.status).toBe(200);
    expect(first.data.grant).toMatchObject({
      route: 'approve-and-remember',
      basis: { needId: need.id, offerId: null, approvals: 1 },
      authority: {
        principalId: 'local-client',
        identityGeneration: 1,
        permission: 'write-project-file',
      },
    });
    // Replaying the same click returns the same grant; nothing widens.
    const again = await request<PatternGrantRecord>('/permissions/remembered', 'POST', {
      needId: need.id,
    });
    expect(again.data.grant.id).toBe(first.data.grant.id);
    const { need: covered } = await coveredOnce();
    expect(covered.authorization).toMatchObject({
      kind: 'remembered-approval',
      route: 'approve-and-remember',
      grantId: first.data.grant.id,
    });
    // No offer is made for what is already remembered.
    await coveredOnce();
    await coveredOnce();
    expect((await view()).offers).toHaveLength(0);
    expect(state().rememberedApprovals!.grants).toHaveLength(1);
  });

  // Review batch1-a, finding D5-2: the Store's write-time funnel re-checks the destination a
  // remembered approval names, as it does for a task scope, not only that the grant is live.
  test('the write-time check refuses a write outside the remembered destination', async () => {
    const need = await approveOnce();
    expect(
      (await request('/permissions/remembered', 'POST', { needId: need.id })).status,
    ).toBe(200);
    const { need: covered } = await coveredOnce();
    expect(covered.authorization?.kind).toBe('remembered-approval');
    const live = state().needs.find((item) => item.id === covered.id)!;
    await expect(
      store().scopeGrants.assertCurrent(projectId, live, [
        { path: REPORT_PATH, expected: null, text: 'same file' },
      ]),
    ).resolves.toBeUndefined();
    await expect(
      store().scopeGrants.assertCurrent(projectId, live, [
        { path: 'Somewhere else.md', expected: null, text: 'another file' },
      ]),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      store().scopeGrants.assertCurrent(projectId, live, [
        { path: REPORT_PATH, expected: null, text: null },
      ]),
    ).rejects.toMatchObject({ status: 403 });
  });

  test('only the local client, and only an approval just given, can be remembered', async () => {
    const open = await nextNeed();
    expect((await request('/permissions/remembered', 'POST', { needId: open.id })).status).toBe(
      409,
    );
    await request(`/needs/${open.id}/resolve`, 'POST', command(open));
    await untilRun(open.harness!.runId, 'completed');
    expect(
      (
        await request(
          '/permissions/remembered',
          'POST',
          { needId: open.id },
          { 'X-Slot-Id': 'slot-1' },
        )
      ).status,
    ).toBe(403);
    expect(
      (await request('/permissions/remembered', 'POST', { needId: open.id, wider: true })).status,
    ).toBe(400);
    await store().locked(async () => {
      const need = state().needs.find((item) => item.id === open.id)!;
      (need.approvalReceipt as { decidedAt: string }).decidedAt = new Date(
        Date.now() - 16 * 60_000,
      ).toISOString();
    });
    expect((await request('/permissions/remembered', 'POST', { needId: open.id })).status).toBe(
      409,
    );
    expect(state().rememberedApprovals?.grants ?? []).toHaveLength(0);
  });
});

describe('revocation, restart and re-asking', () => {
  async function remembered() {
    const need = await approveOnce();
    return (
      await request<PatternGrantRecord>('/permissions/remembered', 'POST', { needId: need.id })
    ).data;
  }

  test('revoking stops coverage immediately and is recorded as evidence', async () => {
    const record = await remembered();
    await coveredOnce();
    const revoked = await request<PatternGrantRecord>(
      `/permissions/remembered/${record.grant.id}/revoke`,
      'POST',
      {},
    );
    expect(revoked.status).toBe(200);
    expect(revoked.data).toMatchObject({ generation: 1 });
    expect(revoked.data.revokedAt).not.toBeNull();
    const entry = state().history.find((item) => item.id === revoked.data.revokedEventId)!;
    expect(entry).toMatchObject({ kind: 'remembered-approval-revoked', actor: 'you' });
    const asked = await nextNeed();
    expect(asked.state).toBe('open');
    expect(asked.authorization).toBeUndefined();
    expect(asked.authorizationBoundary).toBe(
      'You revoked the remembered approval for this, so it needs your OK.',
    );
    expect((await view()).grants[0]).toMatchObject({ active: false });
    // Revoking again changes nothing and adds no second record.
    await request(`/permissions/remembered/${record.grant.id}/revoke`, 'POST', {});
    expect(
      state().history.filter((item) => item.kind === 'remembered-approval-revoked'),
    ).toHaveLength(1);
    // The grant and both History entries are kept; revocation prunes nothing.
    expect(state().rememberedApprovals!.grants).toHaveLength(1);
    expect(state().history.some((item) => item.id === record.grant.eventId)).toBe(true);
  });

  test('a covered step whose grant is revoked before it runs writes nothing', async () => {
    await remembered();
    const writes = state().history.filter((item) => item.kind === 'changed').length;
    // Revoke in the instant after the grant covered the Need and before the
    // decision reaches the run: the decision re-checks the grant and refuses.
    const grants = store().scopeGrants.remembered;
    const cover = grants.cover.bind(grants);
    vi.spyOn(grants, 'cover').mockImplementation((id, need, candidate) => {
      const record = cover(id, need, candidate);
      if (record) grants.revoke(id, record.grant.id);
      return record;
    });
    const need = await nextNeed();
    expect(need.authorization?.kind).toBe('remembered-approval');
    await untilRun(need.harness!.runId, 'cancelled');
    const saved = state().needs.find((item) => item.id === need.id)!;
    expect(saved.execution).toMatchObject({ state: 'not-applied' });
    expect(saved.execution!.reason).toMatch(/revoked before this ran/);
    expect(state().history.filter((item) => item.kind === 'changed')).toHaveLength(writes);
    expect(() => validateApprovalReceipts(state())).not.toThrow();
    expect(() => validateScopeGrants(state())).not.toThrow();
  });

  test('a remembered approval survives a restart, and a revoked one stays revoked', async () => {
    const live = await remembered();
    await close();
    await open();
    expect((await view()).grants).toMatchObject([{ active: true }]);
    const { need } = await coveredOnce();
    expect(need.authorization).toMatchObject({ grantId: live.grant.id });
    await request(`/permissions/remembered/${live.grant.id}/revoke`, 'POST', {});
    await close();
    await open();
    expect((await view()).grants).toMatchObject([{ active: false, generation: 1 }]);
    expect((await nextNeed()).state).toBe('open');
  });
});

describe('out of pattern asks again', () => {
  async function granted() {
    const need = await approveOnce();
    await request('/permissions/remembered', 'POST', { needId: need.id });
    return need;
  }
  const remembered = () => store().scopeGrants.remembered;

  test('the exact pattern is covered and each listed trigger asks again', async () => {
    const need = await granted();
    const exact = await candidateFor(need);
    expect(remembered().coverage(projectId, exact).record).toBeDefined();

    const elsewhere = await candidateFor({
      ...need,
      harness: {
        ...need.harness!,
        intent: {
          ...need.harness!.intent,
          input: { ...(need.harness!.intent.input as object), files: ['Other.md'] },
        },
      },
    });
    expect(remembered().coverage(projectId, elsewhere).reason).toMatch(
      /destination or recipient it does not cover/,
    );
    const wider = await candidateFor({
      ...need,
      harness: { ...need.harness!, intent: { ...need.harness!.intent, effect: 'non-idempotent' } },
    });
    // A non-idempotent local write is not on the allowlist at all.
    expect(remembered().coverage(projectId, wider).record).toBeUndefined();
    const reconnected = {
      ...exact,
      pattern: {
        ...exact.pattern,
        connection: { engine: 'codex-harness', accountRoute: 'codex:chatgpt' },
      },
    };
    expect(remembered().coverage(projectId, reconnected).reason).toMatch(
      /connection it acts through changed/,
    );
    const rotated = { ...exact, authority: { ...exact.authority!, identityGeneration: 2 } };
    expect(remembered().coverage(projectId, rotated).reason).toMatch(/authority .* changed/);
    const someoneElse = {
      ...exact,
      authority: { ...exact.authority!, principalId: 'team-member:slot-2' },
    };
    expect(remembered().coverage(projectId, someoneElse).reason).toMatch(/authority .* changed/);
    const lostPermission = { ...exact, authority: { ...exact.authority!, capabilities: [] } };
    expect(remembered().coverage(projectId, lostPermission).reason).toMatch(/authority .* changed/);
    const unavailable = { ...exact, authority: null };
    expect(remembered().coverage(projectId, unavailable).reason).toMatch(/not available now/);
    // A different action on the same tool is a different pattern.
    const otherAction = {
      ...exact,
      pattern: {
        ...exact.pattern,
        action: { ...exact.pattern.action, kind: 'transform' as const },
      },
    };
    expect(remembered().coverage(projectId, otherAction).reason).toMatch(
      /different or wider action/,
    );
    // Another project's identical step is never covered.
    const otherProject = { ...exact, pattern: { ...exact.pattern, projectId: 'Pelsewhere' } };
    expect(remembered().coverage(projectId, otherProject).record).toBeUndefined();
  });

  test('a changed connection at run time asks again through the real host', async () => {
    await granted();
    const bridge = host().bridge as unknown as {
      candidate: (run: HarnessRun, need: Need) => Promise<ApprovalCandidate | null>;
    };
    const original = bridge.candidate.bind(bridge);
    vi.spyOn(bridge, 'candidate').mockImplementation(async (run, need) => {
      const found = await original(run, need);
      return (
        found && {
          ...found,
          pattern: {
            ...found.pattern,
            connection: { engine: 'native-fixture', accountRoute: 'other-account' },
          },
        }
      );
    });
    const asked = await nextNeed();
    expect(asked.state).toBe('open');
    expect(asked.authorizationBoundary).toMatch(/connection it acts through changed/);
  });

  // Review batch1-a, finding D5-3: a Codex step's connection is the ChatGPT account its run
  // actually used (the run's pinned grant), not a settings key production never writes, so a
  // different account is a different pattern and asks again.
  test('a Codex step is bound to the account its run used, so another account asks again', async () => {
    const need = await approveOnce();
    const bridge = host().bridge as unknown as {
      candidate: (run: HarnessRun, need: Need) => Promise<ApprovalCandidate | null>;
      codex: { authorityForRun: (...args: unknown[]) => Promise<unknown> };
    };
    vi.spyOn(bridge.codex, 'authorityForRun').mockResolvedValue({
      principal: localHarnessPrincipal(projectId),
    });
    const run = await host().get(projectId, need.harness!.runId);
    const asCodex = (input: unknown) =>
      ({ ...run, capabilityId: 'codex-report', input }) as unknown as HarnessRun;
    const first = await bridge.candidate(asCodex({ grant: { accountRoute: 'openai:chatgpt:aaa' } }), need);
    const other = await bridge.candidate(asCodex({ grant: { accountRoute: 'openai:chatgpt:bbb' } }), need);
    expect(first!.pattern.connection.accountRoute).toBe('openai:chatgpt:aaa');
    expect(patternDigest(first!.pattern)).not.toBe(patternDigest(other!.pattern));
    // A run whose account cannot be read is never guessed at: it always asks.
    expect(await bridge.candidate(asCodex({}), need)).toBeNull();
  });

  test('always-asks steps are never offered, remembered or covered', async () => {
    const need = await approveOnce();
    const pay = await candidateFor(need);
    const paying = {
      ...pay,
      pattern: { ...pay.pattern, tool: 'pay_supplier' },
    };
    const deleting = { ...pay, deletes: true };
    const access = { ...pay, pattern: { ...pay.pattern, tool: 'grant_member_access' } };
    for (const candidate of [paying, deleting, access]) {
      for (let i = 0; i < REMEMBER_OFFER_THRESHOLD + 2; i++)
        expect(remembered().noteDecision(projectId, candidate, 'go-ahead', need)).toBeNull();
      expect(() =>
        remembered().rememberFromNeed(
          projectId,
          state().needs.find((item) => item.id === need.id)!,
          candidate,
        ),
      ).toThrow(/always ask/);
    }
    expect(state().rememberedApprovals?.offers ?? []).toHaveLength(0);
    expect(state().rememberedApprovals?.grants ?? []).toHaveLength(0);
    // A grant written to disk for a payment is not a grant: loading refuses it.
    await request('/permissions/remembered', 'POST', { needId: need.id });
    const forged = structuredClone(state());
    const record = forged.rememberedApprovals!.grants[0];
    (record.grant as { pattern: unknown }).pattern = paying.pattern;
    (record.grant as { patternDigest: string }).patternDigest = patternDigest(paying.pattern);
    expect(() => validateRememberedApprovals(forged)).toThrow(/incompatible/);
    // And a covering check never matches one, whatever is saved.
    expect(remembered().coverage(projectId, paying).record).toBeUndefined();
  });
});

describe('configuration, rollback and restart never create or revive', () => {
  test('pack activation, a settings change, the offer threshold and a restart create nothing', async () => {
    await approveOnce();
    await approveOnce();
    const before = structuredClone(state().rememberedApprovals);
    await activatePack(store(), projectId, 'diomedes.software-engineering');
    const settings = await fetch(`${url}/api/settings`, {
      method: 'PUT',
      headers,
      body: JSON.stringify({ permissions: { ...store().settings.permissions, sending: true } }),
    });
    expect(settings.status).toBe(200);
    // Lowering the host threshold below the count makes no offer and no grant by itself.
    store().scopeGrants.remembered.threshold = 1;
    await close();
    await open();
    expect(state().rememberedApprovals).toEqual(before);
    expect((await view()).offers).toHaveLength(0);
    expect(state().rememberedApprovals!.grants).toHaveLength(0);
  });

  test('a prepared state image cannot revive a revoked grant or reopen a declined offer', async () => {
    for (let i = 0; i < REMEMBER_OFFER_THRESHOLD; i++) await approveOnce();
    const offer = (await view()).offers[0];
    const need = state().needs.find((item) => item.id === offer.needId)!;
    const granted = (
      await request<PatternGrantRecord>('/permissions/remembered', 'POST', { needId: need.id })
    ).data;
    // Not recent enough? Route 1 must be used on the approval just given.
    expect(granted.grant).toBeDefined();
    const prepared: ProjectState = structuredClone(state());
    await request(`/permissions/remembered/${granted.grant.id}/revoke`, 'POST', {});
    const current = state();
    // Recovery persists the older image; the revocation is carried onto it.
    carryRememberedDecisions(prepared, current);
    const record = prepared.rememberedApprovals!.grants.find(
      (item) => item.grant.id === granted.grant.id,
    )!;
    expect(record.generation).toBe(1);
    expect(record.revokedAt).not.toBeNull();
    expect(prepared.history.some((item) => item.id === record.revokedEventId)).toBe(true);
    expect(() => validateRememberedApprovals(prepared)).not.toThrow();

    const declinedImage: ProjectState = structuredClone(current);
    declinedImage.rememberedApprovals!.offers = [
      { ...structuredClone(offer), state: 'open', decidedAt: null, eventId: null, grantId: null },
    ];
    const answered = structuredClone(current);
    answered.rememberedApprovals!.offers = [
      {
        ...structuredClone(offer),
        state: 'declined',
        decidedAt: current.history.at(-1)!.time,
        eventId: current.history.at(-1)!.id,
        grantId: null,
      },
    ];
    carryRememberedDecisions(declinedImage, answered);
    expect(declinedImage.rememberedApprovals!.offers[0].state).toBe('declined');
  });

  test('a configuration activation and rollback leave remembered approvals as they were', async () => {
    await close();
    // The real configuration service over a real Store, as its own suite drives it.
    const configRoot = path.join(root, 'config');
    const local = new Store(path.join(configRoot, 'data'), path.join(configRoot, 'projects'));
    await local.init();
    const project = await local.locked(() => local.createProject('Configured'));
    const workspaces = new WorkspaceService(local);
    await workspaces.init();
    const agents = new AgentRegistry(local.dataDir);
    const service = new ConfigurationService(local, workspaces, agents);
    await service.init();
    // A remembered approval, then its revocation, recorded the ordinary way.
    const remembered = local.scopeGrants.remembered;
    const pattern = {
      kind: 'harness-step' as const,
      projectId: project.id,
      procedure: 'format-report',
      tool: 'propose_write',
      action: {
        kind: 'tool' as const,
        permission: 'write-project-file',
        effect: 'idempotent' as const,
      },
      destination: { kind: 'local' as const, targets: ['file:Harness report.md'] },
      connection: { engine: 'native-fixture', accountRoute: null },
    };
    const candidate: ApprovalCandidate = {
      pattern,
      deletes: false,
      what: 'Write Harness report.md (Format a fixture report)',
      authority: {
        principalId: 'local-client',
        identityGeneration: 1,
        capabilities: ['write-project-file'],
      },
    };
    const fakeNeed = { id: 'Nfake', sessionId: 'Sfake', taskId: 'Tfake' } as Need;
    const offer = await local.locked(async () => {
      let made: RememberOffer | null = null;
      for (let i = 0; i < REMEMBER_OFFER_THRESHOLD; i++)
        made = remembered.noteDecision(project.id, candidate, 'go-ahead', fakeNeed) ?? made;
      await local.persist(local.state(project.id));
      return made!;
    });
    const granted = await local.locked(async () => {
      const record = remembered.acceptOffer(project.id, offer.id);
      remembered.revoke(project.id, record.grant.id);
      await local.persist(local.state(project.id));
      return record;
    });
    const before = structuredClone(local.state(project.id).rememberedApprovals);
    const org = await workspaces
      .createOrganization({ name: 'Ridge Cabinetry' })
      .then(
        () =>
          workspaces
            .view()
            .organizations.find((item) => item.organization.name === 'Ridge Cabinetry')!
            .organization,
      );
    const proposal = async () => {
      const { agents: listed } = await agents.list();
      const general = listed.find((item) => item.id === 'diomedes.general')!;
      return {
        v: 1,
        organizationId: org.id,
        tenantId: org.tenantId,
        questionnaireRevision: BUSINESS_SETUP_SCHEMA_REVISION,
        answersDigest: answersDigest({}),
        previousConfigurationDigest: null,
        template: {
          id: 'diomedes.weekly-brief',
          version: '1.0.0',
          variantId: 'restaurant-operations',
        },
        agents: [
          {
            agentId: general.id,
            agentVersion: general.version,
            agentDigest: general.digest,
            label: 'General Assistant',
            roleOverride: null,
            ceiling: 'review',
            provenance: { source: 'answer', why: 'Chosen from the intake answers.' },
          },
        ],
        team: null,
        rules: [],
        requiredConnections: [],
        contextScopes: [],
        modelPolicy: {
          routes: ['harness-runtime'],
          processing: 'may-leave',
          fallbackAllowed: false,
          provenance: { source: 'template', why: 'Runs on the local harness route.' },
        },
        budget: {
          monthlyCapUsd: null,
          sharesParentBudget: true,
          changeableBy: 'owner',
          provenance: { source: 'default', why: 'No spending limit was named.' },
        },
        approvers: {
          proposedApprovers: [],
          humanRequired: ['sending'],
          everythingStops: false,
          provenance: { source: 'answer', why: 'Sending waits for a person.' },
        },
        expectedOutputs: [],
        unresolved: [],
        createdAt: new Date().toISOString(),
        createdBy: workspaces.currentPerson().id,
      } as unknown as ConfigurationProposal;
    };
    await service.stage(org.id, await proposal());
    await service.activate(org.id, {
      revision: 1,
      expectedActiveRevision: null,
      activationId: 'act-1',
    });
    await service.stage(org.id, await proposal());
    await service.activate(org.id, {
      revision: 2,
      expectedActiveRevision: 1,
      activationId: 'act-2',
    });
    await service.rollback(org.id, {
      toRevision: 1,
      expectedActiveRevision: 2,
      activationId: 'back-1',
    });
    expect(service.active(org.id)?.revision).toBe(1);
    expect(local.state(project.id).rememberedApprovals).toEqual(before);
    const reopened = new Store(path.join(configRoot, 'data'), path.join(configRoot, 'projects'));
    await reopened.init();
    expect(reopened.state(project.id).rememberedApprovals).toEqual(before);
    const saved = reopened
      .state(project.id)
      .rememberedApprovals!.grants.find((item) => item.grant.id === granted.grant.id)!;
    expect(saved.revokedAt).not.toBeNull();
    expect(reopened.scopeGrants.remembered.coverage(project.id, candidate).record).toBeUndefined();
    await open();
  });
});

describe('versioned format and the Codex task scope', () => {
  const codexGrant = () =>
    request<ScopeGrantRecord>('/permissions/grants', 'POST', {
      protocolVersion: 2,
      commandId: crypto.randomUUID(),
      taskId: state().tasks[0].id,
      roots: ['.'],
      operations: ['text.create', 'text.modify'],
      engine: 'codex',
      accountRoute: 'codex:chatgpt',
      maxWrites: 40,
      maxBytes: 5_242_880,
      ttlMinutes: 60,
      review: 'human',
    });

  test('existing Codex grants carry forward losslessly beside remembered ones', async () => {
    const need = await approveOnce();
    const issued = await codexGrant();
    expect(issued.status).toBe(200);
    const statePath = path.join(root, 'data', 'projects', projectId, 'state.json');
    const readSaved = async () => JSON.parse(await fs.readFile(statePath, 'utf8')) as ProjectState;
    const savedBefore = await readSaved();
    // A project written before remembered approvals has no ledger at all.
    expect(savedBefore.rememberedApprovals).toBeDefined(); // counted one approval
    const legacy: ProjectState = structuredClone(savedBefore);
    delete legacy.rememberedApprovals;
    expect(() => validateScopeGrants(legacy)).not.toThrow();
    const codexBytes = JSON.stringify(savedBefore.scopeGrants);
    const codexDigest = scopeGrantDigest(savedBefore.scopeGrants![0]);

    await request('/permissions/remembered', 'POST', { needId: need.id });
    await close();
    await open();
    const savedAfter = await readSaved();
    expect(JSON.stringify(savedAfter.scopeGrants)).toBe(codexBytes);
    expect(scopeGrantDigest(savedAfter.scopeGrants![0])).toBe(codexDigest);
    expect(savedAfter.scopeGrants![0].grant.protocolVersion).toBe(2);
    expect(savedAfter.rememberedApprovals!.formatVersion).toBe(1);
    expect(savedAfter.rememberedApprovals!.grants[0].grant.protocolVersion).toBe(3);
    // Codex behaviour is unchanged: a v2 grant still loses its lease on restart.
    expect(store().scopeGrants.view(projectId)[0].active).toBe(false);
    expect((await view()).grants[0].active).toBe(true);
  });

  test('an unknown format or grant version is refused, never rewritten', async () => {
    const need = await approveOnce();
    await request('/permissions/remembered', 'POST', { needId: need.id });
    const good = structuredClone(state());
    expect(() => validateScopeGrants(good)).not.toThrow();
    const format = structuredClone(good);
    (format.rememberedApprovals as unknown as { formatVersion: number }).formatVersion = 2;
    expect(() => validateScopeGrants(format)).toThrow(/incompatible/);
    const version = structuredClone(good);
    (
      version.rememberedApprovals!.grants[0].grant as unknown as { protocolVersion: number }
    ).protocolVersion = 4;
    expect(() => validateScopeGrants(version)).toThrow(/incompatible/);
    const widened = structuredClone(good);
    (
      widened.rememberedApprovals!.grants[0].grant.pattern.destination as unknown as {
        targets: string[];
      }
    ).targets.push('file:Other.md');
    expect(() => validateScopeGrants(widened)).toThrow(/incompatible/);
    const unknownField = structuredClone(good);
    (unknownField.rememberedApprovals as unknown as Record<string, unknown>).silentGrants = [];
    expect(() => validateScopeGrants(unknownField)).toThrow(/incompatible/);
    // A store refuses to open such a project and leaves the file as written.
    await close();
    const statePath = path.join(root, 'data', 'projects', projectId, 'state.json');
    const saved = JSON.parse(await fs.readFile(statePath, 'utf8'));
    saved.rememberedApprovals.formatVersion = 99;
    const text = JSON.stringify(saved);
    await fs.writeFile(statePath, text);
    const fresh = new Store(path.join(root, 'data'), path.join(root, 'projects'));
    await expect(fresh.init()).rejects.toThrow(/incompatible/);
    expect(await fs.readFile(statePath, 'utf8')).toBe(text);
    saved.rememberedApprovals.formatVersion = 1;
    await fs.writeFile(statePath, JSON.stringify(saved));
    await open();
  });

  test('tampered remembered evidence cannot authorize', async () => {
    const need = await approveOnce();
    await request('/permissions/remembered', 'POST', { needId: need.id });
    const { need: covered } = await coveredOnce();
    const snap = structuredClone(state());
    const target = () => snap.needs.find((item) => item.id === covered.id)!;
    expect(() => validateScopedAuthorization(snap, target())).not.toThrow();
    const forged = structuredClone(snap);
    const forgedNeed = forged.needs.find((item) => item.id === covered.id)!;
    (forgedNeed.authorization as unknown as Record<string, unknown>).grantDigest =
      'sha256:0000000000000000000000000000000000000000000000000000000000000000';
    expect(() => validateScopedAuthorization(forged, forgedNeed)).toThrow();
    const reviewed = structuredClone(snap);
    const reviewedNeed = reviewed.needs.find((item) => item.id === covered.id)!;
    (reviewedNeed.authorization as unknown as Record<string, unknown>).reviewId = 'V-forged';
    expect(() => validateScopedAuthorization(reviewed, reviewedNeed)).toThrow();
    const clicked = structuredClone(snap);
    const clickedNeed = clicked.needs.find((item) => item.id === covered.id)!;
    (clickedNeed.authorization as unknown as Record<string, unknown>).acceptedBy = 'someone';
    expect(() => validateApprovalReceipts(clicked)).toThrow();
  });
});
