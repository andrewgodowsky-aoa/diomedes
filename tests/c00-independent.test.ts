import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { promises as fs } from 'node:fs';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import {
  claimPaths, releaseClaim, requestSlot, releaseSlot, workMode, writeJournal,
  defaultRoot, type Owner,
} from '../scripts/coordination.js';
import {
  authoritativeIdsSchema, commandIdentitySchema, compatibilityForSavedRun,
  continuationModeSchema, packLockSchema, profileSnapshotSchema, receiptRevision,
  steeringAckSchema, toolRefSchema, verificationEvidenceSchema,
} from '../shared/contract-revision.js';
import { FileRunStore, validateRunId } from '../server/harness/run-store.js';
import { validateEffect } from '../server/harness/lifecycle.js';
import type { HarnessRun } from '../shared/harness.js';
import type { ExecutionResolution, LiveAuthority } from '../shared/execution.js';

const at = '2026-09-13T00:00:00.000Z';
const digest = `sha256:${'a'.repeat(64)}`;
const owner: Owner = { role: 'astra', host: 'c00-test-host', pid: 100,
  processStart: at, worktree: 'F:/owned/c00-a' };
const other: Owner = { ...owner, role: 'opus', pid: 200, worktree: 'F:/owned/c00-b' };
const integrator: Owner = { ...owner, role: 'fable', pid: 300, worktree: 'F:/owned/c00-fable' };
let root: string;
beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), 'diomedes-c00-independent-')); });
afterEach(async () => {
  const target = path.resolve(root);
  const parent = path.resolve(os.tmpdir());
  if (path.dirname(target) !== parent || !path.basename(target).startsWith('diomedes-c00-independent-'))
    throw new Error('Refusing cleanup outside this test temporary directory.');
  await fs.rm(target, { recursive: true, force: true });
});
const claim = (by: Owner, paths: string[], extra = {}) =>
  claimPaths(root, { owner: by, node: 'C00.R.fixture', baseSha: 'test-base', paths, ...extra });

describe('C00 independent coordination acceptance', () => {
  test('C01 identical concurrent claims yield one winner', async () => {
    const outcomes = await Promise.all([claim(owner, ['tests/a.ts']), claim(other, ['tests/a.ts'])]);
    expect(outcomes.map(x => x.ok).sort()).toEqual([false, true]);
  });
  test('C02 dot-segment aliases cannot acquire the same source twice', async () => {
    const outcomes = await Promise.all([claim(owner, ['tests/a.ts']), claim(other, ['tests/../tests/a.ts'])]);
    expect(outcomes.map(x => x.ok).sort()).toEqual([false, true]);
  });
  test.each(['SERVER/APP.TS', 'server/../server/app.ts'])('C03 hot-file spelling %s cannot bypass integrator ownership', async name => {
    expect((await claim(owner, [name])).ok).toBe(false);
  });
  test('C04 a directory claim conflicts with a descendant claim', async () => {
    expect((await claim(owner, ['evidence/unified-20260913/'])).ok).toBe(true);
    expect((await claim(other, ['evidence/unified-20260913/result.json'])).ok).toBe(false);
  });
  test('C05 a descendant claim conflicts with a directory claim', async () => {
    expect((await claim(owner, ['evidence/unified-20260913/result.json'])).ok).toBe(true);
    expect((await claim(other, ['evidence/unified-20260913/'])).ok).toBe(false);
  });
  test('C06 an arbitrary handoff id cannot authorize a hot-file claim', async () => {
    expect((await claim(owner, ['shared/types.ts'], { handoffFrom: 'never-issued' })).ok).toBe(false);
  });
  test('C07 another process with the same role cannot release a live claim', async () => {
    const held = await claim(owner, ['tests/a.ts']);
    if (!held.ok) throw new Error('Fixture setup failed');
    await expect(releaseClaim(root, held.claim.claimId, {
      by: { ...owner, pid: owner.pid + 1 }, note: 'different process',
    })).rejects.toThrow();
  });
  test('C08 reused PID with a different process start cannot release a live slot', async () => {
    const held = await requestSlot(root, { owner, node: 'C00.R.fixture', purpose: 'test' });
    if (!held.ok) throw new Error('Fixture setup failed');
    await expect(releaseSlot(root, held.slot.slotId, {
      by: { ...owner, processStart: '2026-09-14T00:00:00.000Z' },
    })).rejects.toThrow();
  });
  test('C09 matching PID on another host cannot release a live slot', async () => {
    const held = await requestSlot(root, { owner, node: 'C00.R.fixture', purpose: 'test' });
    if (!held.ok) throw new Error('Fixture setup failed');
    await expect(releaseSlot(root, held.slot.slotId, { by: { ...owner, host: 'other-host' } })).rejects.toThrow();
  });
  test('C10 missing partner keeps implementation read-only', async () => {
    expect((await workMode(root, { me: owner, partner: 'fable', wantsToEdit: ['tests/a.ts'] })).mode).toBe('read-only');
  });
  test('C11 another lifetime of the same PID cannot be treated as the path holder', async () => {
    await writeJournal(root, integrator, { at, event: 'present' });
    expect((await claim(owner, ['tests/a.ts'])).ok).toBe(true);
    expect((await workMode(root, { me: { ...owner, processStart: '2026-09-14T00:00:00.000Z' },
      partner: 'fable', wantsToEdit: ['tests/a.ts'] })).mode).toBe('read-only');
  });
  test('C12 common root is identical from the main and reviewer worktrees', () => {
    const mainWorktree = execFileSync('git', ['worktree', 'list', '--porcelain'], { encoding: 'utf8' })
      .split(/\r?\n/).find(line => line.startsWith('worktree '))?.slice('worktree '.length);
    if (!mainWorktree) throw new Error('Git did not report the primary worktree.');
    expect(defaultRoot()).toBe(defaultRoot(mainWorktree));
  });
  test('C13 concurrent heavy verifiers yield one winner and release admits the next owner', async () => {
    const outcomes = await Promise.all([
      requestSlot(root, { owner, node: 'C00.R.fixture', purpose: 'test' }),
      requestSlot(root, { owner: other, node: 'other', purpose: 'test' }),
    ]);
    expect(outcomes.map(result => result.ok).sort()).toEqual([false, true]);
    const held = outcomes.find(result => result.ok);
    if (!held?.ok) throw new Error('Fixture setup failed');
    await releaseSlot(root, held.slot.slotId, { by: held.slot.owner });
    const nextOwner = held.slot.owner.pid === owner.pid ? other : owner;
    expect((await requestSlot(root, { owner: nextOwner, node: 'next', purpose: 'test' })).ok).toBe(true);
  });
});

const profile = {
  agentId: 'review.fixture', agentVersion: '1', agentDigest: digest, routeId: 'codex',
  model: { requested: 'alias', reported: null as string | null, source: 'not-recorded' as 'runtime' | 'not-recorded' },
  selection: { agent: 'manual', model: 'manual' }, effort: 'high', resolvedAt: at,
};
const oldRun = (): HarnessRun => ({
  v: 1, id: 'run_legacy', tenantId: 'tenant-a', projectId: 'project-a', taskId: 'task-a',
  sessionId: 'session-a', capabilityId: 'read', capabilityVersion: '1', capabilityTools: ['read_document'],
  policyVersion: '1', principal: { id: 'owner', tenantId: 'tenant-a', projectId: 'project-a', capabilities: ['read'], identityGeneration: 1 },
  state: 'completed', budget: { units: 10, modelCalls: 2, toolCalls: 2, wallMs: null },
  used: { units: 1, modelCalls: 1, toolCalls: 0 }, owner: null, fence: 1, leaseExpiresAt: null,
  parentRunId: null, forkPoint: null, contextRevision: 1, transcripts: {}, result: null,
  failure: null, cancelReason: null, createdAt: at, updatedAt: at, steps: [], approvals: [], events: [], lastSeq: 0,
});
const resolution: ExecutionResolution = {
  v: 1, resolvedAt: at, principal: { kind: 'local-owner', id: 'owner', tenantId: 'tenant-a', assurance: 'owner-local' },
  workspace: { kind: 'business', organizationId: 'org-a' }, membership: { role: 'owner', state: 'active' },
  configuration: { organizationId: 'org-a', revision: 1, digest },
  agent: { agentId: 'review.fixture', agentVersion: '1', agentDigest: digest, agentName: 'Fixture', agentSelection: 'manual', effectivePermission: 'project' },
  team: null, route: { routeId: 'codex', requestedModel: null, modelSelection: 'runtime-default' },
  rules: { revision: '1', governing: [] }, context: { scopeIds: ['approved-files'], instructionRevision: '1' },
  payer: { kind: 'bring-your-own', id: 'org-a', coversChildren: true, reason: 'fixture' },
  budget: null, gates: [], admitted: true,
};
const live: LiveAuthority = { tenantId: 'tenant-a', membershipState: 'active', configurationRevision: 1,
  agentDigest: digest, grantRevoked: false, generationAdvanced: false, budgetRemainingUsd: 10, revocationProven: true };
const effect = { operation: 'text.modify' as const, paths: ['notes/a.md'], routeId: 'codex',
  expectedBaseDigest: digest, actualBaseDigest: digest, authorization: { kind: 'scope-grant' as const, id: 'grant-a' } };

describe('C00 independent contract acceptance', () => {
  test('S01 externally constructed command, ids, tool and evidence examples parse', () => {
    expect(commandIdentitySchema.safeParse({ protocolVersion: 1, commandId: 'review:1', family: 'work.start', payloadDigest: digest, expectedRevision: '2026-09-13.1' }).success).toBe(true);
    expect(authoritativeIdsSchema.safeParse({ runId: 'run_a', turn: null, event: { v: 1, seq: 1, runId: 'run_a' }, authority: 'host' }).success).toBe(true);
    expect(toolRefSchema.safeParse({ name: 'read_document', version: '1', effect: 'read', permission: 'read', approval: false, destination: 'local', trustedInputRequired: false, inputSchemaDigest: digest }).success).toBe(true);
    expect(verificationEvidenceSchema.safeParse({ subject: 'fixture', capability: 'partial', level: 'deterministic', enforcement: 'instructional', outcome: 'inconclusive', verifier: 'c00-independent', verifiedAt: at, reason: 'No live observation' }).success).toBe(true);
  });
  test('S02 requested alias and actual runtime identity remain distinct', () => {
    const parsed = profileSnapshotSchema.parse({ ...profile, model: { requested: 'alias', reported: 'exact-version-a', source: 'runtime' } });
    expect(parsed.model).toEqual({ requested: 'alias', reported: 'exact-version-a', source: 'runtime' });
  });
  test('S03 not-recorded source cannot assert a reported model', () => {
    expect(profileSnapshotSchema.safeParse({ ...profile, model: { requested: 'alias', reported: 'invented-exact-version', source: 'not-recorded' } }).success).toBe(false);
  });
  test('S04 runtime source must name a reported model', () => {
    expect(profileSnapshotSchema.safeParse({ ...profile, model: { requested: 'alias', reported: null, source: 'runtime' } }).success).toBe(false);
  });
  test('S05 authoritative run identifiers obey the existing RunStore identifier contract', () => {
    expect(() => validateRunId('run/other')).toThrow();
    expect(authoritativeIdsSchema.safeParse({ runId: 'run/other', turn: null, event: { v: 1, seq: 1, runId: 'run/other' }, authority: 'host' }).success).toBe(false);
  });
  test('S06 native resume requires an opaque native reference; copied messages cannot substitute', () => {
    expect(continuationModeSchema.safeParse({ mode: 'resume', kind: 'native', ofRunId: 'run_a', nativeSession: null }).success).toBe(false);
    expect(continuationModeSchema.safeParse({ mode: 'resume', kind: 'host', ofRunId: 'run_a', nativeSession: null }).success).toBe(true);
  });
  test('S07 logged-only steering cannot be upgraded to delivered without a session', () => {
    const ack = { commandId: 'steer:1', state: 'logged-only', nativeSession: null, at, detail: 'Recorded only' };
    expect(steeringAckSchema.safeParse(ack).success).toBe(true);
    expect(steeringAckSchema.safeParse({ ...ack, state: 'delivered' }).success).toBe(false);
  });
  test('S08 an activated pack carries no authorization and cannot authorize a write', () => {
    expect(packLockSchema.safeParse({ id: 'fixture.pack', version: '1', digest, dependencies: [], activatedAt: at }).success).toBe(true);
    expect(packLockSchema.safeParse({ id: 'fixture.pack', version: '1', digest, dependencies: [], activatedAt: at, authorized: true }).success).toBe(false);
    expect(validateEffect({ ...effect, authorization: null }, resolution, live).ok).toBe(false);
  });
  test('S09 old run round-trips from disk without growing tools, packs, native resume or receipts', async () => {
    const store = new FileRunStore(path.join(root, 'runs'));
    const saved = oldRun();
    await store.create(saved);
    const before = await fs.readFile(path.join(root, 'runs', `${saved.id}.json`), 'utf8');
    const restored = await store.read(saved.id);
    expect(restored).not.toBeNull();
    const compatibility = compatibilityForSavedRun(restored!);
    expect(compatibility.tools).toEqual(['read_document']);
    expect(compatibility.packs).toEqual([]);
    expect(compatibility.steering).toBe('unsupported');
    expect(compatibility.continuation.resume).toBe('host');
    expect(receiptRevision({})).toBe('pre-2026-09-13.1');
    expect(await fs.readFile(path.join(root, 'runs', `${saved.id}.json`), 'utf8')).toBe(before);
  });
  test.each([{ grantRevoked: true }, { generationAdvanced: true }, { membershipState: 'revoked' as const }])('S10 saved execution cannot regain authority when live state changes %j', change => {
    expect(validateEffect(effect, resolution, live).ok).toBe(true);
    expect(validateEffect(effect, structuredClone(resolution), { ...live, ...change }).ok).toBe(false);
  });
  test('S11 viewing a saved run with invented extra powers does not promote them', () => {
    const saved = { ...oldRun(), steering: 'delivered', packs: ['admin'], extraTools: ['shell'] };
    const result = compatibilityForSavedRun(saved);
    expect(result.tools).toEqual(['read_document']);
    expect(result.packs).toEqual([]);
    expect(result.steering).toBe('unsupported');
  });
});
