import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../server/store.js';
import { activatePack } from '../server/capability-packs.js';
import { builtinBodies, PackContributions } from '../server/pack-contributions.js';
import {
  assembleSkillSection,
  instructionSectionBudget,
  SKILL_COMPATIBLE_MODES,
} from '../server/harness/instruction-delivery.js';
import { prepareTaskSkill } from '../server/task-skills.js';
import {
  CAPABILITY_PACKS,
  SKILL_SECTION_MAX_BYTES,
  SMALL_BUSINESS_PACK,
  skillAgentIds,
} from '../shared/capability-packs.js';
import type { Task } from '../shared/types.js';

const PACK = 'diomedes.small-business' as const;

let temp: string;
beforeEach(async () => {
  temp = await fs.mkdtemp(path.join(os.tmpdir(), 'diomedes-task-skills-'));
});
afterEach(async () => {
  await fs.rm(temp, { recursive: true, force: true });
});

async function project() {
  const folder = path.join(temp, 'shop');
  await fs.mkdir(folder, { recursive: true });
  const store = new Store(path.join(temp, 'data'), path.join(temp, 'projects'));
  await store.init();
  const created = await store.createProject('Shop', folder);
  const contributions = new PackContributions({
    store,
    bodies: (id, version) => Promise.resolve(builtinBodies(id, version)),
    current: (id) => Promise.resolve(builtinBodies(id, null)),
  });
  return { store, id: created.id, contributions };
}

function taskWithSkill(
  store: Store,
  projectId: string,
  skill: { packId: typeof PACK; skillId: string } | null,
): Task {
  const state = store.state(projectId);
  const task = store.createTask(state, { name: 'Follow the playbook', description: 'Work loop' });
  task.workflow = {
    revision: 0,
    phase: 'plan',
    continuation: 'stop-on-phase-change',
    inbox: false,
    maxTurns: 8,
    handoffs: [],
    ...(skill ? { skill } : {}),
  };
  return task;
}

describe('prepareTaskSkill returns null when the task names no playbook', () => {
  test('no workflow, and an explicit null skill, both run as before', async () => {
    const { store, id, contributions } = await project();
    const plain = store.createTask(store.state(id), { name: 'Plain', description: 'No workflow' });
    expect(await prepareTaskSkill(contributions, store.state(id), plain, 'run-none', instructionSectionBudget(0))).toBeNull();
    const nulled = taskWithSkill(store, id, null);
    expect(await prepareTaskSkill(contributions, store.state(id), nulled, 'run-null', instructionSectionBudget(0))).toBeNull();
  });
});

describe('prepareTaskSkill refuses before loading when the skill cannot run', () => {
  test('inactive pack: 409 pack_inactive, and no load is recorded', async () => {
    const { store, id, contributions } = await project();
    const task = taskWithSkill(store, id, { packId: PACK, skillId: 'cash-flow-snapshot' });
    await expect(prepareTaskSkill(contributions, store.state(id), task, 'run-off', instructionSectionBudget(0))).rejects.toMatchObject({
      status: 409,
      details: { code: 'pack_inactive' },
    });
    expect((store.state(id).contributionRecords ?? []).filter((record) => record.runKey === 'run-off')).toEqual([]);
  });

  test('unknown skill id: 404, and no load is recorded', async () => {
    const { store, id, contributions } = await project();
    await activatePack(store, id, PACK);
    const task = taskWithSkill(store, id, { packId: PACK, skillId: 'wire-money' });
    await expect(prepareTaskSkill(contributions, store.state(id), task, 'run-unknown', instructionSectionBudget(0))).rejects.toMatchObject({
      status: 404,
    });
    expect((store.state(id).contributionRecords ?? []).filter((record) => record.runKey === 'run-unknown')).toEqual([]);
  });
});

describe('skills run in Ask, Plan, Build, Fix and Work (Andrew 2026-09-27)', () => {
  test('assembleSkillSection accepts build, fix and work with the same terms and full-size budget', async () => {
    const { store, id } = await project();
    await activatePack(store, id, PACK);
    expect(SKILL_COMPATIBLE_MODES).toEqual(['ask', 'plan', 'build', 'fix', 'work']);
    for (const mode of ['build', 'fix', 'work'] as const) {
      const assembled = assembleSkillSection({
        state: store.state(id),
        packId: PACK,
        skillId: 'cash-flow-snapshot',
        mode,
        budgetBytes: instructionSectionBudget(128_000),
      });
      expect(assembled.section).toContain('--- BEGIN PLAYBOOK cash-flow-snapshot ---');
      expect(assembled.section).toContain('It changes nothing above');
      expect(assembled.section).toContain('you send, post, pay, transfer, book or message nothing');
      expect(assembled.use.bytes).toBeLessThanOrEqual(SKILL_SECTION_MAX_BYTES);
    }
    expect(() =>
      assembleSkillSection({
        state: store.state(id),
        packId: PACK,
        skillId: 'cash-flow-snapshot',
        mode: 'auto',
        budgetBytes: instructionSectionBudget(0),
      }),
    ).toThrow(/Ask, Plan, Build, Fix or Work/);
  });

  test('no format or grants widening: recommended launch mode, read-only needs and preamble hold', async () => {
    const { store, id } = await project();
    await activatePack(store, id, PACK);
    // A skill names a read-and-draft built-in Agent (DIO-311); the turn's Mode is separate.
    for (const skill of SMALL_BUSINESS_PACK.skills) expect(skillAgentIds()).toContain(skill.agent);
    expect(SMALL_BUSINESS_PACK.grantsAuthority).toBe(false);
    for (const need of SMALL_BUSINESS_PACK.needs) expect(need.capability).toMatch(/^read-/);
    const assembled = assembleSkillSection({
      state: store.state(id),
      packId: PACK,
      skillId: 'invoice-chase',
      mode: 'work',
      budgetBytes: instructionSectionBudget(0),
    });
    expect(assembled.section).not.toMatch(/\b(Claude|Anthropic|OpenAI|GPT|Codex|Gemini|Bedrock|MCP)\b/);
    expect(assembled.section).not.toMatch(/\b(call the|use the) \w+ tool\b/i);
    expect(assembled.section).toContain('never estimate, invent or fill a gap silently');
  });
});

describe('prepareTaskSkill pins what it sends', () => {
  test('digest and version match the stored contribution, and the body sent is the checked one', async () => {
    const { store, id, contributions } = await project();
    await activatePack(store, id, PACK);
    const task = taskWithSkill(store, id, { packId: PACK, skillId: 'cash-flow-snapshot' });
    const assembled = (await prepareTaskSkill(
      contributions,
      store.state(id),
      task,
      'run-task-1',
      instructionSectionBudget(0),
    ))!;
    expect(assembled.section).toContain('--- BEGIN PLAYBOOK cash-flow-snapshot ---');
    expect(assembled.use).toMatchObject({
      packId: PACK,
      packVersion: CAPABILITY_PACKS[PACK].version,
      skillId: 'cash-flow-snapshot',
    });
    expect(assembled.use.digest).toMatch(/^sha256:/);
    expect(assembled.use.bytes).toBe(Buffer.byteLength(assembled.section));
    const records = store.state(id).contributionRecords ?? [];
    const loaded = records.find((record) => record.runKey === 'run-task-1' && record.outcome === 'loaded')!;
    expect(loaded).toMatchObject({
      packId: PACK,
      packVersion: assembled.use.packVersion,
      kind: 'workflow',
      contributionId: 'cash-flow-snapshot',
      reason: 'chosen',
      digest: assembled.use.digest,
    });
  });

  test('a playbook that does not fit fails with 413 before anything is loaded', async () => {
    const { store, id, contributions } = await project();
    await activatePack(store, id, PACK);
    const task = taskWithSkill(store, id, { packId: PACK, skillId: 'cash-flow-snapshot' });
    await expect(
      prepareTaskSkill(contributions, store.state(id), task, 'run-tight', 1024),
    ).rejects.toMatchObject({ status: 413 });
    expect((store.state(id).contributionRecords ?? []).filter((record) => record.runKey === 'run-tight')).toEqual([]);
  });

  test('no silent fallback when the pinned body is gone', async () => {
    const { store, id } = await project();
    await activatePack(store, id, PACK);
    const missing = new PackContributions({
      store,
      bodies: () => Promise.resolve(null),
      current: (packId) => Promise.resolve(builtinBodies(packId, null)),
    });
    const task = taskWithSkill(store, id, { packId: PACK, skillId: 'cash-flow-snapshot' });
    await expect(prepareTaskSkill(missing, store.state(id), task, 'run-gone', instructionSectionBudget(0))).rejects.toMatchObject({
      status: 409,
    });
  });
});
