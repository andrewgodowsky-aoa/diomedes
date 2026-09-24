/**
 * H09 — exact-model Agent profiles: the resolution table, revisioning and
 * pinning, proven without a server first. The HTTP and restart proofs live in
 * `agent-profiles-routing.test.ts`.
 */
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  PROFILE_MAX_RULES,
  fallbackSentence,
  resolveProfileRoute,
  type AgentProfileRevision,
  type ProfileCandidate,
} from '../shared/agent-profiles.js';
import { AgentProfileStore, profileDigest } from '../server/agent-profiles.js';
import { resolutionSchema } from '../server/agents.js';

const revision = (patch: Partial<AgentProfileRevision> = {}): AgentProfileRevision => ({
  protocolVersion: 1,
  profileId: 'pr-writer',
  revision: 1,
  name: 'Writer on Codex',
  engine: 'codex',
  model: 'gpt-6-astra',
  effort: 'medium',
  agentId: 'diomedes.builder',
  rules: [],
  createdAt: '2026-09-24T00:00:00.000Z',
  ...patch,
});
const candidate = (
  patch: Partial<AgentProfileRevision> = {},
  unavailable: string | null = null,
): ProfileCandidate => {
  const rev = revision(patch);
  return { revision: rev, digest: `sha256:${'a'.repeat(64)}`, unavailable };
};
const table = (...rows: ProfileCandidate[]) =>
  new Map(rows.map((row) => [row.revision.profileId, row] as const));

describe('the resolution table', () => {
  const a = candidate({ profileId: 'pr-a', name: 'A' });
  const b = candidate({ profileId: 'pr-b', name: 'B', engine: 'opencode', model: 'glm-9' });
  const aDown = candidate({ profileId: 'pr-a', name: 'A' }, 'ChatGPT is off in Settings > Engines.');
  const bDown = candidate(
    { profileId: 'pr-b', name: 'B', engine: 'opencode', model: 'glm-9' },
    'OpenCode is off in Settings > Engines.',
  );

  test('no preference and no pick resolves nothing, so the legacy route choice stands', () => {
    expect(resolveProfileRoute({ source: 'project', order: [], fallback: false, candidates: table() }))
      .toEqual({ outcome: 'none' });
  });

  test.each([
    // [label, order, fallback, rows, expected outcome, expected profile, fell back from]
    ['first available, fallback off', ['pr-a', 'pr-b'], false, [a, b], 'resolved', 'pr-a', null],
    ['first available, fallback on', ['pr-a', 'pr-b'], true, [a, b], 'resolved', 'pr-a', null],
    ['first unavailable, fallback off', ['pr-a', 'pr-b'], false, [aDown, b], 'refused', null, null],
    ['first unavailable, fallback on', ['pr-a', 'pr-b'], true, [aDown, b], 'resolved', 'pr-b', 'pr-a'],
    ['all unavailable, fallback on', ['pr-a', 'pr-b'], true, [aDown, bDown], 'refused', null, null],
    ['deleted first, fallback off', ['pr-gone', 'pr-b'], false, [b], 'refused', null, null],
    ['deleted first, fallback on', ['pr-gone', 'pr-b'], true, [b], 'resolved', 'pr-b', 'pr-gone'],
  ] as const)('%s', (_label, order, fallback, rows, outcome, profile, from) => {
    const result = resolveProfileRoute({
      source: 'project',
      order,
      fallback,
      candidates: table(...rows),
    });
    expect(result.outcome).toBe(outcome);
    if (result.outcome === 'resolved') {
      expect(result.pick.profileId).toBe(profile);
      expect(result.pick.fallback?.fromProfileId ?? null).toBe(from);
      expect(result.pick.fallbackPolicy).toBe(fallback ? 'on' : 'off');
    }
    if (result.outcome === 'refused') {
      // A refusal names every profile it tried and why, never a vague "unavailable".
      expect(result.tried.length).toBeGreaterThan(0);
      for (const tried of result.tried) expect(tried.reason.length).toBeGreaterThan(5);
      if (!fallback) expect(result.reason).toMatch(/fallback is off/i);
    }
  });

  test('a fallback is recorded with who was skipped and why, and reads as one sentence', () => {
    const result = resolveProfileRoute({
      source: 'task',
      order: ['pr-a', 'pr-b'],
      fallback: true,
      candidates: table(aDown, b),
    });
    if (result.outcome !== 'resolved') throw new Error('expected a fallback');
    expect(result.pick.source).toBe('task');
    expect(result.pick.fallback).toEqual({
      fromProfileId: 'pr-a',
      fromName: 'A',
      reason: 'ChatGPT is off in Settings > Engines.',
    });
    expect(result.pick.skipped).toHaveLength(1);
    expect(fallbackSentence(result.pick)).toBe(
      'Ran on B (OpenCode · glm-9) because A was unavailable: ChatGPT is off in Settings > Engines.',
    );
  });

  test('the pick carries the exact engine, model and effort of the revision it resolved', () => {
    const result = resolveProfileRoute({
      source: 'thread',
      order: ['pr-a'],
      fallback: false,
      candidates: table(candidate({ profileId: 'pr-a', revision: 4, effort: 'xhigh' })),
    });
    if (result.outcome !== 'resolved') throw new Error('expected a pick');
    expect(result.pick).toMatchObject({
      profileId: 'pr-a',
      revision: 4,
      engine: 'codex',
      model: 'gpt-6-astra',
      effort: 'xhigh',
      agentId: 'diomedes.builder',
      source: 'thread',
      fallback: null,
    });
  });
});

describe('profile revisions', () => {
  let temp = '';
  beforeEach(async () => {
    await fs.mkdir(path.join(process.cwd(), 'test-results'), { recursive: true });
    temp = await fs.mkdtemp(path.join(process.cwd(), 'test-results', 'profiles-'));
  });
  afterEach(async () => {
    await fs.rm(temp, { recursive: true, force: true });
  });

  const draft = {
    name: 'Careful writer',
    engine: 'codex',
    model: 'gpt-6-astra',
    effort: 'medium',
    agentId: 'diomedes.builder',
    rules: ['Keep British spelling.'],
  };

  test('editing makes a new revision and keeps every earlier one unchanged', async () => {
    const store = new AgentProfileStore(temp);
    await store.load();
    const created = await store.create(draft);
    expect(created.revision).toBe(1);
    const first = structuredClone(created);
    const edited = await store.update(created.profileId, 1, { ...draft, model: 'gpt-5.5' });
    expect(edited.revision).toBe(2);
    expect(edited.model).toBe('gpt-5.5');
    const record = store.get(created.profileId)!;
    expect(record.revisions).toHaveLength(2);
    expect(record.revisions[0]).toEqual(first);
    expect(profileDigest(record.revisions[0])).not.toBe(profileDigest(record.revisions[1]));
    // A stale editor never overwrites a newer revision.
    await expect(store.update(created.profileId, 1, draft)).rejects.toMatchObject({ status: 409 });
    // Revisions survive a reload from disk.
    const reloaded = new AgentProfileStore(temp);
    await reloaded.load();
    expect(reloaded.get(created.profileId)!.revisions).toEqual(record.revisions);
  });

  test('a profile names an exact model and bounded rules, or it is refused', async () => {
    const store = new AgentProfileStore(temp);
    await store.load();
    await expect(store.create({ ...draft, model: '' })).rejects.toMatchObject({ status: 400 });
    await expect(store.create({ ...draft, model: 'has spaces' })).rejects.toMatchObject({ status: 400 });
    await expect(store.create({ ...draft, engine: 'sample' })).rejects.toMatchObject({ status: 400 });
    await expect(store.create({ ...draft, engine: 'nope' })).rejects.toMatchObject({ status: 400 });
    await expect(
      store.create({ ...draft, rules: Array.from({ length: PROFILE_MAX_RULES + 1 }, () => 'x rule') }),
    ).rejects.toMatchObject({ status: 400 });
  });

  test('deleting archives the profile; its revisions stay for the runs that used them', async () => {
    const store = new AgentProfileStore(temp);
    await store.load();
    const created = await store.create(draft);
    await store.archive(created.profileId);
    expect(store.list().map((item) => item.profileId)).not.toContain(created.profileId);
    expect(store.get(created.profileId)?.revisions[0]).toEqual(created);
  });

  test('routing preferences are per project with a per-task override, and fallback defaults off', async () => {
    const store = new AgentProfileStore(temp);
    await store.load();
    const a = await store.create(draft);
    const b = await store.create({ ...draft, name: 'Other', model: 'gpt-5.5' });
    expect(store.routing('P1', null)).toEqual({ order: [], fallback: false, source: 'project' });
    await store.setRouting('P1', { order: [a.profileId, b.profileId] });
    expect(store.routing('P1', 'T1')).toEqual({
      order: [a.profileId, b.profileId],
      fallback: false,
      source: 'project',
    });
    await store.setRouting('P1', { order: [a.profileId, b.profileId], fallback: true });
    await store.setTaskRouting('P1', 'T1', { order: [b.profileId], fallback: false });
    expect(store.routing('P1', 'T1')).toEqual({ order: [b.profileId], fallback: false, source: 'task' });
    expect(store.routing('P1', 'T2').source).toBe('project');
    await store.setTaskRouting('P1', 'T1', null);
    expect(store.routing('P1', 'T1').source).toBe('project');
    await expect(store.setRouting('P1', { order: ['pr-missing'] })).rejects.toMatchObject({
      status: 400,
    });
  });
});

describe('the pinned resolution in the run record', () => {
  const base = {
    protocolVersion: 1,
    agentId: 'diomedes.builder',
    agentVersion: '1.0.0',
    agentName: 'Change Builder',
    agentOrigin: 'built-in',
    agentDigest: `sha256:${'b'.repeat(64)}`,
    agentSelection: 'manual',
    requestedAgentId: 'diomedes.builder',
    mode: 'build',
    routeId: 'codex',
    requestedModel: 'gpt-6-astra',
    modelSelection: 'manual',
    compatible: true,
    unmet: [],
    policy: {
      agentCeiling: 'auto-review',
      granted: 'review',
      effective: 'review',
      grantId: null,
      grantsAuthority: false,
    },
    resolvedAt: '2026-09-24T00:00:00.000Z',
  };
  const pinned = {
    protocolVersion: 1,
    profileId: 'pr-a',
    revision: 2,
    digest: `sha256:${'c'.repeat(64)}`,
    name: 'A',
    engine: 'codex',
    model: 'gpt-6-astra',
    effort: 'medium',
    agentId: 'diomedes.builder',
    rules: [],
    source: 'project',
    fallbackPolicy: 'off',
    fallback: null,
    skipped: [],
  };
  test('a resolution without a profile still validates, as it did before profiles existed', () => {
    expect(resolutionSchema.safeParse(base).success).toBe(true);
  });
  test('a resolution may carry the pinned profile revision', () => {
    expect(resolutionSchema.safeParse({ ...base, profile: pinned }).success).toBe(true);
  });
  test('a pinned profile with an unknown field fails closed', () => {
    expect(
      resolutionSchema.safeParse({ ...base, profile: { ...pinned, grantsAuthority: true } }).success,
    ).toBe(false);
  });
});
