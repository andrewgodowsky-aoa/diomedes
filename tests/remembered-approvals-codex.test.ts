/**
 * Remembered approvals (work order D5) for Codex direct text proposals, and the
 * ChatGPT account a version 2 Codex task scope was confirmed for.
 *
 * Proven through the real host, Store and HTTP routes over a temporary
 * directory, with a scripted native generator standing in for the Codex
 * runtime: it reports the ChatGPT account route the turn is prepared under the
 * way `askCodex` does (`onAccountRoute`), and returns a proposal.
 */
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../server/app.js';
import type { NativeGenerator } from '../server/native-work.js';
import type { Store } from '../server/store.js';
import { validateApprovalReceipts } from '../server/approval-admission.js';
import {
  scopeGrantDigest,
  validateScopeGrants,
  validateScopedAuthorization,
} from '../server/trust/scope-grants.js';
import {
  patternDigest,
  patternGrantDigest,
  patternForProposal,
  validateRememberedApprovals,
} from '../server/trust/remembered-approvals.js';
import {
  classifyProposal,
  REMEMBER_OFFER_THRESHOLD,
  rememberedAttribution,
} from '../shared/remembered-approvals.js';
import type { ApprovalCommand, Need, ProjectState } from '../shared/types.js';
import type {
  PatternGrantRecord,
  RememberedApprovalsView,
  ScopeGrantRecord,
} from '../shared/permissions.js';

const ACCOUNT_A = `openai:chatgpt:${'a'.repeat(64)}`;
const ACCOUNT_B = `openai:chatgpt:${'b'.repeat(64)}`;
const MENU = 'Fall menu.md';
const ATTRIBUTION = /^Ran under a remembered approval — you, since \d{1,2} [A-Z][a-z]+ \d{4}\.$/;
const headers = { 'Content-Type': 'application/json', 'X-Diomedes-Client': '1' };

let root: string, url: string, projectId: string, taskId: string;
let app: Awaited<ReturnType<typeof createApp>>, server: Server | undefined;
/** The account the scripted runtime reports; null reports none (never guessed at). */
let account: string | null;
let proposal: { path: string; text: string | null }[];
let counter = 0;
/** Runs inside the generator, before the host judges the proposal. */
let duringTurn: (() => void) | undefined;

const store = (): Store => app.locals.store;
const state = (): ProjectState => store().state(projectId);

async function request<T = unknown>(
  route: string,
  method = 'GET',
  body?: unknown,
  extra: Record<string, string> = {},
) {
  const response = await fetch(`${url}/api${route}`, {
    method,
    headers: { ...headers, ...extra },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, data: (await response.json()) as T };
}
const project = <T = unknown>(route: string, method = 'GET', body?: unknown) =>
  request<T>(`/projects/${projectId}${route}`, method, body);
const view = async () => (await project<RememberedApprovalsView>('/permissions/remembered')).data;

function command(
  need: Need,
  resolution: ApprovalCommand['resolution'] = 'go-ahead',
): ApprovalCommand {
  return {
    protocolVersion: 1,
    commandId: crypto.randomUUID(),
    resolution,
    proposalDigest: need.approval!.proposalDigest,
    actionDigest: need.approval!.actionDigest,
    baseDigest: need.approval!.baseDigest,
  };
}
/** Propose a new version of the selected menu (the same file every time). */
function menuProposal() {
  counter += 1;
  proposal = [{ path: MENU, text: `# Fall menu\n\nRevision ${counter}.\n` }];
}
/** Start Codex work and wait until its proposal is waiting or already decided. */
async function propose(sources: string[] = [MENU]): Promise<Need> {
  const started = await project<{ id: string }>('/work/start', 'POST', {
    taskId,
    route: 'codex',
    consent: true,
    sources,
  });
  expect(started.status).toBe(200);
  await expect
    .poll(() => state().sessions.find((item) => item.id === started.data.id)?.state, {
      timeout: 15_000,
    })
    .not.toMatch(/^(working|queued)$/);
  // A covered proposal is decided and written under the same Store lock; wait for it to end.
  await store().locked(async () => undefined);
  const need = state().needs.find((item) => item.sessionId === started.data.id);
  expect(need).toBeDefined();
  return structuredClone(need!);
}
async function decide(need: Need, resolution: ApprovalCommand['resolution'] = 'go-ahead') {
  const decided = await project(`/needs/${need.id}/resolve`, 'POST', command(need, resolution));
  expect(decided.status).toBe(200);
  return structuredClone(state().needs.find((item) => item.id === need.id)!);
}
/** One exact approval of the menu proposal, clicked. */
async function approveMenu() {
  menuProposal();
  const need = await propose();
  expect(need.state).toBe('open');
  return decide(need);
}
const remember = (needId: string) =>
  project<PatternGrantRecord>('/permissions/remembered', 'POST', { needId });
const current = (need: Need) => state().needs.find((item) => item.id === need.id)!;
const scopeBody = () => ({
  protocolVersion: 2,
  commandId: crypto.randomUUID(),
  taskId,
  roots: ['.'],
  operations: ['text.create', 'text.modify'],
  engine: 'codex',
  accountRoute: 'codex:chatgpt',
  maxWrites: 40,
  maxBytes: 5_242_880,
  ttlMinutes: 60,
  review: 'human',
});

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'diomedes-remembered-codex-'));
  account = ACCOUNT_A;
  counter = 0;
  duringTurn = undefined;
  menuProposal();
  const generate: NativeGenerator = async (input) => {
    if (account) input.onAccountRoute?.(account);
    duringTurn?.();
    return {
      text: JSON.stringify({
        summary: 'Revise the menu',
        changes: proposal.map((change) => ({ ...change, summary: 'Revision' })),
      }),
      model: 'runtime-model',
    };
  };
  app = await createApp({
    dataDir: path.join(root, 'data'),
    projectRoot: path.join(root, 'projects'),
    nativeGenerator: (input) => generate(input),
  });
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server!.once('listening', resolve));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  projectId = (await request<{ id: string }>('/projects/sample', 'POST', {})).data.id;
  taskId = (
    await project<{ id: string }>('/tasks', 'POST', { name: 'Menu work', description: 'Revise' })
  ).data.id;
  await request('/settings', 'PUT', { services: { codex: true } });
  expect(
    (
      await project('/cloud-sharing', 'PUT', {
        expectedVersion: 0,
        routes: ['codex'],
        documents: [MENU],
        shareConversationHistory: false,
        shareReviewPackets: false,
      })
    ).status,
  ).toBe(200);
});
afterEach(async () => {
  const closingApp = app,
    closingServer = server;
  server = undefined;
  try {
    await closingApp?.locals.close();
  } finally {
    if (closingServer) {
      closingServer.closeAllConnections();
      await new Promise<void>((resolve) => closingServer.close(() => resolve()));
    }
    await fs.rm(root, { recursive: true, force: true });
  }
});

describe('a Codex proposal records the account it was prepared under', () => {
  test('the runtime-reported route is kept on the proposal, outside its approval digest', async () => {
    const need = await propose();
    expect(need.connection).toEqual({ engine: 'codex', accountRoute: ACCOUNT_A });
    expect(need.state).toBe('open');
    expect(() => validateApprovalReceipts(state())).not.toThrow();
    // A route the runtime did not report is never guessed at.
    account = null;
    await decide(need, 'declined');
    menuProposal();
    const unread = await propose();
    expect(unread.connection).toBeUndefined();
  });
});

describe('route 1 on a Codex proposal: Go ahead and remember in this project', () => {
  test('the next identical proposal runs under it, another file asks, and revoking asks again', async () => {
    const first = await approveMenu();
    expect(first.execution?.state).toBe('applied');
    const remembered = await remember(first.id);
    expect(remembered.status).toBe(200);
    expect(remembered.data.grant).toMatchObject({
      protocolVersion: 3,
      route: 'approve-and-remember',
      acceptedBy: 'you',
      what: 'Write Fall menu.md (Codex text proposal)',
      basis: { needId: first.id, offerId: null, approvals: 1 },
      pattern: {
        kind: 'codex-proposal',
        projectId,
        procedure: 'codex-proposal',
        tool: 'text.apply',
        action: { kind: 'tool', permission: 'write-project-file', effect: 'idempotent' },
        destination: { kind: 'local', targets: [`file:${MENU}`] },
        connection: { engine: 'codex', accountRoute: ACCOUNT_A },
      },
      authority: {
        principalId: 'local-client',
        identityGeneration: 1,
        permission: 'write-project-file',
      },
    });
    const granted = state().history.find((entry) => entry.id === remembered.data.grant.eventId)!;
    expect(granted).toMatchObject({ kind: 'remembered-approval-granted', actor: 'you' });
    // Replaying the click returns the same grant.
    expect((await remember(first.id)).data.grant.id).toBe(remembered.data.grant.id);

    // The next identical proposal: nobody is asked, and every record says whose click it rests on.
    menuProposal();
    const covered = await propose();
    expect(covered.approvalReceipt).toBeUndefined();
    expect(covered.state).toBe('go-ahead');
    expect(covered.decidedFrom).toBe('remembered-approval');
    expect(covered.authorization).toMatchObject({
      kind: 'remembered-approval',
      grantId: remembered.data.grant.id,
      route: 'approve-and-remember',
      engine: 'codex',
      accountRoute: ACCOUNT_A,
      acceptedBy: 'you',
      acceptedAt: remembered.data.grant.createdAt,
    });
    expect(covered.execution?.state).toBe('applied');
    expect(await fs.readFile(path.join(state().project.folder, MENU), 'utf8')).toBe(
      proposal[0].text,
    );
    const text = rememberedAttribution({
      acceptedBy: 'you',
      acceptedAt: remembered.data.grant.createdAt,
    });
    expect(text).toMatch(ATTRIBUTION);
    const authorized = state().history.find(
      (entry) => entry.id === covered.authorization!.eventId,
    )!;
    expect(authorized).toMatchObject({ kind: 'remembered-authorized', actor: 'diomedes' });
    expect(authorized.sentence).toBe(`${text} Write Fall menu.md (Codex text proposal).`);
    const write = state().history.find((entry) => entry.id === covered.execution!.eventId)!;
    expect(write.sentence).toContain(text);
    expect(write.sentence).not.toContain('allowed for this task');
    expect(write.authorization).toEqual(covered.authorization);
    const session = state().sessions.find((item) => item.id === covered.sessionId)!;
    expect(session.state).toBe('done');
    expect(session.log.some((line) => line.sentence.startsWith(text))).toBe(true);
    expect(() => validateApprovalReceipts(state())).not.toThrow();
    expect(() => validateScopeGrants(state())).not.toThrow();
    // One click, one remember; the covered run added no decision.
    expect(state().history.filter((entry) => entry.kind === 'decision')).toHaveLength(1);
    expect((await view()).offers).toHaveLength(0);

    // A proposal that writes another file is outside the pattern: it asks, and says why.
    proposal = [{ path: 'Specials.md', text: 'Soup of the day.\n' }];
    const elsewhere = await propose();
    expect(elsewhere.state).toBe('open');
    expect(elsewhere.authorization).toBeUndefined();
    expect(elsewhere.authorizationBoundary).toBe(
      'Your remembered approval covers “Write Fall menu.md (Codex text proposal)”, but this writes files it does not cover, so it needs your OK.',
    );
    await decide(elsewhere, 'declined');
    // So does the menu together with another file: the whole file set is the pattern.
    proposal = [
      { path: MENU, text: '# Fall menu\n\nWider.\n' },
      { path: 'Specials.md', text: 'Soup.\n' },
    ];
    const wider = await propose();
    expect(wider.state).toBe('open');
    expect(wider.authorizationBoundary).toMatch(/writes files it does not cover/);
    await decide(wider, 'declined');

    // Revoking from the one list stops coverage at once, and is evidence.
    const revoked = await project<PatternGrantRecord>(
      `/permissions/remembered/${remembered.data.grant.id}/revoke`,
      'POST',
      {},
    );
    expect(revoked.status).toBe(200);
    expect(revoked.data.revokedAt).not.toBeNull();
    expect(state().history.find((entry) => entry.id === revoked.data.revokedEventId)).toMatchObject(
      { kind: 'remembered-approval-revoked', actor: 'you' },
    );
    menuProposal();
    const asked = await propose();
    expect(asked.state).toBe('open');
    expect(asked.authorizationBoundary).toBe(
      'You revoked the remembered approval for this, so it needs your OK.',
    );
    // The revoked grant stays listed, and its earlier coverage stays valid evidence.
    expect((await view()).grants).toMatchObject([{ active: false }]);
    const kept = current(covered);
    expect(() => validateScopedAuthorization(state(), kept)).not.toThrow();
    // A revoked grant never authorizes another write at the Store funnel.
    await expect(
      store().scopeGrants.assertCurrent(projectId, kept, [
        { path: MENU, expected: null, text: 'late' },
      ]),
    ).rejects.toMatchObject({ status: 403 });
  });

  test('another ChatGPT account asks again, and so does turning the Codex connection off', async () => {
    const first = await approveMenu();
    expect((await remember(first.id)).status).toBe(200);
    account = ACCOUNT_B;
    menuProposal();
    const switched = await propose();
    expect(switched.state).toBe('open');
    expect(switched.connection?.accountRoute).toBe(ACCOUNT_B);
    expect(switched.authorizationBoundary).toBe(
      'Your remembered approval covers “Write Fall menu.md (Codex text proposal)”, but this was prepared under a different ChatGPT account, so it needs your OK.',
    );
    await decide(switched, 'declined');
    // An account the runtime did not report is never covered.
    account = null;
    menuProposal();
    const unread = await propose();
    expect(unread.state).toBe('open');
    expect(unread.authorization).toBeUndefined();
    await decide(unread, 'declined');
    // Back on the remembered account, but the connection it rests on is turned off mid-turn.
    account = ACCOUNT_A;
    duringTurn = () => {
      store().settings.services = { ...store().settings.services, codex: false };
    };
    menuProposal();
    const offline = await propose();
    expect(offline.state).toBe('open');
    expect(offline.authorizationBoundary).toBe(
      'The authority your remembered approval rested on is not available now, so this needs your OK.',
    );
  });

  test('only the local client, and only an approval just given, can be remembered', async () => {
    menuProposal();
    const open = await propose();
    expect((await remember(open.id)).status).toBe(409);
    await decide(open);
    expect(
      (
        await request(
          `/projects/${projectId}/permissions/remembered`,
          'POST',
          { needId: open.id },
          { 'X-Slot-Id': 'slot-1' },
        )
      ).status,
    ).toBe(403);
    // A declined proposal is not an approval to remember.
    menuProposal();
    const declined = await decide(await propose(), 'declined');
    expect((await remember(declined.id)).status).toBe(409);
    expect(state().rememberedApprovals?.grants ?? []).toHaveLength(0);
  });
});

describe('route 2 on a Codex proposal: the learned offer', () => {
  test('offered once at the threshold; Stop asking covers the next, Keep asking is remembered', async () => {
    for (let i = 1; i < REMEMBER_OFFER_THRESHOLD; i++) {
      await approveMenu();
      expect((await view()).offers).toHaveLength(0);
    }
    const third = await approveMenu();
    const offers = (await view()).offers;
    expect(offers).toEqual([
      expect.objectContaining({
        state: 'open',
        approvals: REMEMBER_OFFER_THRESHOLD,
        needId: third.id,
        what: 'Write Fall menu.md (Codex text proposal)',
      }),
    ]);
    // Repeated approvals alone never create a grant.
    expect(state().rememberedApprovals!.grants).toHaveLength(0);
    menuProposal();
    expect((await propose()).state).toBe('open');
    await decide(current(state().needs.at(-1)!));
    expect(state().rememberedApprovals!.offers).toHaveLength(1);

    const accepted = await project<PatternGrantRecord>(
      `/permissions/remembered/offers/${offers[0].id}/accept`,
      'POST',
      {},
    );
    expect(accepted.status).toBe(200);
    expect(accepted.data.grant).toMatchObject({
      route: 'learned-offer',
      basis: { offerId: offers[0].id, approvals: REMEMBER_OFFER_THRESHOLD, needId: third.id },
      pattern: { kind: 'codex-proposal', connection: { accountRoute: ACCOUNT_A } },
    });
    menuProposal();
    const covered = await propose();
    expect(covered.authorization).toMatchObject({
      kind: 'remembered-approval',
      route: 'learned-offer',
      grantId: accepted.data.grant.id,
    });
    expect(covered.execution?.state).toBe('applied');
  });

  test('a declined offer does not come back, and a decline restarts the count', async () => {
    await approveMenu();
    await approveMenu();
    menuProposal();
    await decide(await propose(), 'declined');
    await approveMenu();
    await approveMenu();
    expect((await view()).offers).toHaveLength(0);
    await approveMenu();
    const offer = (await view()).offers[0];
    expect(offer).toBeDefined();
    const declined = await project(
      `/permissions/remembered/offers/${offer.id}/decline`,
      'POST',
      {},
    );
    expect(declined.status).toBe(200);
    for (let i = 0; i < REMEMBER_OFFER_THRESHOLD + 1; i++) await approveMenu();
    expect((await view()).offers).toHaveLength(0);
    expect(state().rememberedApprovals!.offers).toHaveLength(1);
    expect(state().rememberedApprovals!.grants).toHaveLength(0);
  });
});

describe('what a Codex proposal can never remember', () => {
  test('a removal, a credential file and a file that runs code always ask', async () => {
    // Removing the selected menu.
    proposal = [{ path: MENU, text: null }];
    const removal = await decide(await propose());
    expect((await remember(removal.id)).data).toMatchObject({ code: 'always_asks' });
    expect(classifyProposal(removal)).toMatchObject({
      rememberable: false,
      category: 'destroys-data',
    });
    // A credential file.
    proposal = [{ path: 'credentials.md', text: 'user: x\n' }];
    const credentials = await decide(await propose([]));
    const refused = await remember(credentials.id);
    expect(refused.status).toBe(409);
    expect(refused.data).toMatchObject({ code: 'always_asks' });
    expect(classifyProposal(credentials)).toMatchObject({ category: 'changes-access' });
    // A page a browser runs code from.
    expect(
      classifyProposal({
        connection: { engine: 'codex', accountRoute: ACCOUNT_A },
        preview: [{ path: 'menu.html', after: '<p>Menu</p>' }],
      }),
    ).toMatchObject({
      rememberable: false,
      reason: expect.stringMatching(/menu\.html always needs your exact review/),
    });
    // None of them was counted toward an offer.
    expect(state().rememberedApprovals?.tallies ?? []).toHaveLength(0);
    expect(state().rememberedApprovals?.grants ?? []).toHaveLength(0);
    // An unread account is never offered either.
    expect(classifyProposal({ preview: [{ path: MENU, after: 'x' }] })).toMatchObject({
      rememberable: false,
      category: 'unrecognised',
    });
  });

  test('a saved Codex grant widened in any way is refused at load, never rewritten', async () => {
    const first = await approveMenu();
    await remember(first.id);
    const saved = structuredClone(state());
    expect(() => validateRememberedApprovals(saved)).not.toThrow();
    const widen = (change: (pattern: Record<string, unknown>) => void) => {
      const forged = structuredClone(saved);
      const grant = forged.rememberedApprovals!.grants[0].grant as unknown as {
        pattern: Record<string, unknown>;
        patternDigest: string;
      };
      change(grant.pattern);
      grant.patternDigest = patternDigest(grant.pattern as never);
      return forged;
    };
    for (const forged of [
      widen((pattern) => (pattern.connection = { engine: 'codex', accountRoute: null })),
      widen((pattern) => (pattern.connection = { engine: 'claude-code', accountRoute: ACCOUNT_A })),
      widen((pattern) => (pattern.tool = 'shell.run')),
      widen(
        (pattern) => (pattern.destination = { kind: 'external', targets: ['url:https://x.test/'] }),
      ),
      widen((pattern) => (pattern.destination = { kind: 'local', targets: ['file:menu.svg'] })),
    ])
      expect(() => validateRememberedApprovals(forged)).toThrow(/incompatible/);
  });

  test('covered evidence moved onto a proposal from another account cannot authorize', async () => {
    const first = await approveMenu();
    await remember(first.id);
    menuProposal();
    const covered = current(await propose());
    expect(covered.authorization?.kind).toBe('remembered-approval');
    const forged = structuredClone(state());
    const need = forged.needs.find((item) => item.id === covered.id)!;
    need.connection = { engine: 'codex', accountRoute: ACCOUNT_B };
    expect(() => validateApprovalReceipts(forged)).toThrow();
    // And a harness grant can never cover a direct proposal, or the reverse.
    const found = patternForProposal({ projectId, need: covered })!;
    expect(found.pattern.kind).toBe('codex-proposal');
    expect(patternDigest(found.pattern)).toBe(
      state().rememberedApprovals!.grants[0].grant.patternDigest,
    );
  });
});

describe('the version 2 Codex task scope and remembered approvals side by side', () => {
  test('a task scope still decides first, and its records keep their bytes and digest', async () => {
    const first = await approveMenu();
    await remember(first.id);
    const issued = await project<ScopeGrantRecord>('/permissions/grants', 'POST', scopeBody());
    expect(issued.status).toBe(200);
    const before = JSON.stringify(state().scopeGrants);
    const digest = scopeGrantDigest(state().scopeGrants![0]);
    // The recorded account sits beside the grant, never inside what its digest binds.
    expect(state().scopeGrants![0].confirmedAccountRoute).toBe(ACCOUNT_A);
    expect(JSON.stringify(state().scopeGrants![0].grant)).not.toContain(ACCOUNT_A);
    menuProposal();
    const scoped = await propose();
    expect(scoped.authorization?.kind).toBe('scope-grant');
    expect(scoped.execution?.state).toBe('applied');
    // Remembered approvals changed nothing in the version 2 records.
    expect(JSON.stringify(state().scopeGrants)).toBe(before);
    expect(scopeGrantDigest(state().scopeGrants![0])).toBe(digest);
    expect(() => validateScopeGrants(state())).not.toThrow();
  });
});

describe('the ChatGPT account a Codex task scope was confirmed for', () => {
  test('a scope confirmed on a waiting proposal binds its account, and another account asks again', async () => {
    menuProposal();
    const waiting = await propose();
    expect(waiting.state).toBe('open');
    const issued = await project<ScopeGrantRecord>('/permissions/grants', 'POST', scopeBody());
    expect(issued.status).toBe(200);
    expect(issued.data.confirmedAccountRoute).toBe(ACCOUNT_A);
    // The v2 grant itself still pins only the literal route; its digest is unchanged in kind.
    expect(issued.data.grant.accountRoute).toBe('codex:chatgpt');
    expect(scopeGrantDigest(issued.data)).toBe(
      scopeGrantDigest({ ...issued.data, confirmedAccountRoute: undefined }),
    );
    // Confirming it applied the waiting proposal, prepared on that account.
    expect(current(waiting).authorization?.kind).toBe('scope-grant');
    menuProposal();
    expect((await propose()).authorization?.kind).toBe('scope-grant');

    account = ACCOUNT_B;
    menuProposal();
    const switched = await propose();
    expect(switched.state).toBe('open');
    expect(switched.authorization).toBeUndefined();
    expect(switched.authorizationBoundary).toBe(
      'This proposal was prepared under a different ChatGPT account from the one Codex was using when you confirmed this task scope, so it needs your OK.',
    );
    // Confirming the scope again, now, binds the account in use.
    const again = await project<ScopeGrantRecord>('/permissions/grants', 'POST', scopeBody());
    expect(again.data.confirmedAccountRoute).toBe(ACCOUNT_B);
    expect(current(switched).authorization?.kind).toBe('scope-grant');
    expect(() => validateScopeGrants(state())).not.toThrow();
    expect(() => validateApprovalReceipts(state())).not.toThrow();
  });

  test('a scope with no recorded account always asks again, and says why', async () => {
    const issued = await project<ScopeGrantRecord>('/permissions/grants', 'POST', scopeBody());
    expect(issued.status).toBe(200);
    // A record saved before the account was recorded: the same grant, the same digest.
    const record = state().scopeGrants![0];
    const digest = scopeGrantDigest(record);
    delete record.confirmedAccountRoute;
    expect(scopeGrantDigest(record)).toBe(digest);
    expect(() => validateScopeGrants(state())).not.toThrow();
    menuProposal();
    const asked = await propose();
    expect(asked.state).toBe('open');
    expect(asked.authorization).toBeUndefined();
    expect(asked.authorizationBoundary).toBe(
      'This task scope was confirmed before Diomedes recorded which ChatGPT account it was for, so this proposal needs your OK. Confirm the scope again to let it continue.',
    );
    // Even when the runtime reports no account at all, an old scope never covers.
    await decide(asked, 'declined');
    account = null;
    menuProposal();
    expect((await propose()).authorization).toBeUndefined();
  });

  test('a scope confirmed before any account was seen asks on the first proposal, then binds it', async () => {
    const issued = await project<ScopeGrantRecord>('/permissions/grants', 'POST', scopeBody());
    expect(issued.data.confirmedAccountRoute).toBe('codex:chatgpt');
    menuProposal();
    const asked = await propose();
    expect(asked.state).toBe('open');
    expect(asked.authorizationBoundary).toBe(
      'Diomedes had not seen which ChatGPT account Codex uses when you confirmed this task scope, so this proposal needs your OK. Confirm the scope again to let it continue under this account.',
    );
    const again = await project<ScopeGrantRecord>('/permissions/grants', 'POST', scopeBody());
    expect(again.data.confirmedAccountRoute).toBe(ACCOUNT_A);
    expect(current(asked).authorization?.kind).toBe('scope-grant');
  });

  test('an account route in an unknown shape is refused at load', async () => {
    await project('/permissions/grants', 'POST', scopeBody());
    const forged = structuredClone(state());
    forged.scopeGrants![0].confirmedAccountRoute = 'someone-else';
    expect(() => validateScopeGrants(forged)).toThrow(/incompatible/);
  });
});

describe('independent review (review-e): a declined proposal is not the account a scope is confirmed for', () => {
  test('a scope confirmed after a declined proposal on another account never covers that account', async () => {
    menuProposal();
    const declined = await propose();
    await decide(declined, 'declined');
    // Codex now runs under another ChatGPT account; the person confirms the task scope.
    account = ACCOUNT_B;
    const issued = await project<ScopeGrantRecord>('/permissions/grants', 'POST', scopeBody());
    expect(issued.status).toBe(200);
    expect(issued.data.confirmedAccountRoute).not.toBe(ACCOUNT_A);
    account = ACCOUNT_A;
    menuProposal();
    const back = await propose();
    expect(back.authorization).toBeUndefined();
    expect(back.state).toBe('open');
  });
});

describe('independent review (review-e): evidence names the grant that covers its files', () => {
  test('covered evidence re-pointed at a grant for another file cannot authorize', async () => {
    proposal = [{ path: 'Specials.md', text: 'Soup of the day.\n' }];
    const specials = await propose();
    await remember((await decide(specials)).id);
    const first = await approveMenu();
    await remember(first.id);
    menuProposal();
    const covered = current(await propose());
    expect(covered.authorization?.kind).toBe('remembered-approval');
    const forged = structuredClone(state());
    const other = forged.rememberedApprovals!.grants.find(
      (record) => record.grant.id !== (covered.authorization as { grantId: string }).grantId,
    )!;
    const need = forged.needs.find((item) => item.id === covered.id)!;
    const evidence = {
      ...(need.authorization as unknown as Record<string, unknown>),
      grantId: other.grant.id,
      grantDigest: patternGrantDigest(other),
      patternDigest: other.grant.patternDigest,
      acceptedAt: other.grant.createdAt,
    };
    need.authorization = evidence as never;
    for (const entry of forged.history)
      if (JSON.stringify(entry.authorization) === JSON.stringify(covered.authorization))
        entry.authorization = structuredClone(evidence) as never;
    expect(() => validateApprovalReceipts(forged)).toThrow();
  });
});

describe('independent review (review-e): a team member or another route never carries Codex evidence', () => {
  test('covered evidence on a team member’s session or a non-Codex session is refused on load', async () => {
    const first = await approveMenu();
    await remember(first.id);
    menuProposal();
    const covered = current(await propose());
    expect(covered.authorization?.kind).toBe('remembered-approval');
    const asMember = structuredClone(state());
    asMember.sessions.find((item) => item.id === covered.sessionId)!.slotId = 'S-member';
    expect(() => validateApprovalReceipts(asMember)).toThrow();
    const otherRoute = structuredClone(state());
    otherRoute.sessions.find((item) => item.id === covered.sessionId)!.route = 'claude-code' as never;
    expect(() => validateApprovalReceipts(otherRoute)).toThrow();
  });
});
