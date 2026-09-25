import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createApp } from '../server/app.js';
import { EngineService, TESTED_VERSIONS } from '../server/engines/service.js';
import type { TextEngineAdapter } from '../server/engines/contract.js';
import { routeContractFor } from '../server/harness/route-contract.js';
import { Store } from '../server/store.js';
import { activatePack, deactivatePack, discoverInstructionFiles } from '../server/capability-packs.js';
import {
  assembleSkillSection,
  instructionSectionBudget,
} from '../server/harness/instruction-delivery.js';
import {
  CAPABILITY_PACK_IDS,
  CAPABILITY_PACKS,
  findSkill,
  renderSkillPlaybook,
  SKILL_SECTION_MAX_BYTES,
  SMALL_BUSINESS_PACK,
  validateManifest,
  validateSkill,
  type CapabilityPackManifest,
  type PackSkill,
} from '../shared/capability-packs.js';
import { SMALL_BUSINESS_SKILLS_LATER } from '../shared/small-business-skills.js';
import { buildEntries, filterPalette, type PaletteContext, type PaletteHandlers } from '../client/console/paletteEntries.js';
import { Composer } from '../client/console/Composer.js';
import { Palette } from '../client/console/Palette.js';
import type { Conversation, ProjectState } from '../shared/types.js';

const PACK = 'diomedes.small-business' as const;
const SKILLS = SMALL_BUSINESS_PACK.skills;
const skill = (id: string) => findSkill(PACK, id)!;

describe('the Small Business pack is data that cannot grant or act', () => {
  test('it is a known pack literal and its manifest loads clean', () => {
    expect(CAPABILITY_PACK_IDS).toContain(PACK);
    expect(CAPABILITY_PACKS[PACK]).toBe(SMALL_BUSINESS_PACK);
    expect(validateManifest(SMALL_BUSINESS_PACK)).toEqual([]);
    expect(validateManifest(CAPABILITY_PACKS['diomedes.software-engineering'])).toEqual([]);
    expect(SMALL_BUSINESS_PACK.grantsAuthority).toBe(false);
    expect(SMALL_BUSINESS_PACK.contributes).toContain('workflows');
    expect(SMALL_BUSINESS_PACK.instructionFiles).toEqual([]);
  });

  test('twelve playbooks, each with a read-and-draft mode, declared needs and no power to act', () => {
    expect(SKILLS).toHaveLength(12);
    const declared = new Set(SMALL_BUSINESS_PACK.needs.map((need) => need.capability));
    for (const item of SKILLS) {
      expect(['ask', 'plan']).toContain(item.mode);
      expect(item.acts).toBe(false);
      expect(item.inputs.length).toBeGreaterThan(0);
      expect(item.inputs.some((input) => input.required)).toBe(true);
      for (const input of item.inputs) {
        expect(declared.has(input.need)).toBe(true);
        expect(input.howToProvide.trim().length).toBeGreaterThan(10);
      }
      expect(item.steps.length).toBeGreaterThan(2);
      expect(item.output.sections.length).toBeGreaterThan(1);
      expect(item.triggers.length).toBeGreaterThan(0);
      expect(validateSkill(item, declared, SMALL_BUSINESS_PACK.version)).toEqual([]);
    }
    expect(new Set(SKILLS.map((item) => item.id)).size).toBe(SKILLS.length);
  });

  test('no declared need is an outward capability, and nothing granted is implied', () => {
    for (const need of SMALL_BUSINESS_PACK.needs) {
      expect(need.capability).toMatch(/^read-/);
      expect(need.reason.length).toBeGreaterThan(10);
    }
  });

  test('every accounting, tax, legal or employment playbook says it is not professional advice', () => {
    const cautioned = ['cash-flow-snapshot', 'month-end-prep', 'pay-the-bills', 'payroll-prep', 'tax-season-organizer', 'contract-review'];
    for (const id of cautioned) {
      expect(skill(id).caution, id).toBeDefined();
      expect(renderSkillPlaybook(skill(id), SMALL_BUSINESS_PACK.version)).toContain('Not professional advice');
    }
    expect(skill('tax-season-organizer').caution).toBe('tax');
    expect(skill('contract-review').caution).toBe('legal');
  });

  test('every playbook fits its budget whole, names no provider, and drafts rather than sends', () => {
    for (const item of SKILLS) {
      const text = renderSkillPlaybook(item, SMALL_BUSINESS_PACK.version);
      expect(new TextEncoder().encode(text).length).toBeLessThanOrEqual(SKILL_SECTION_MAX_BYTES);
      expect(text).not.toMatch(/\b(Claude|Anthropic|OpenAI|GPT|Codex|Gemini|Bedrock|MCP)\b/);
      expect(text).not.toMatch(/\b(call the|use the) \w+ tool\b/i);
      if (item.drafts.length) expect(text).toContain('Draft for you to send');
      if (item.visual) expect(text).toContain('built only from figures in what you were given');
    }
  });

  test('the later list is named and does not overlap what ships', () => {
    const ids = new Set(SKILLS.map((item) => item.id));
    expect(SMALL_BUSINESS_SKILLS_LATER.length).toBeGreaterThan(0);
    for (const later of SMALL_BUSINESS_SKILLS_LATER) expect(ids.has(later.id)).toBe(false);
  });
});

describe('a skill that could act, write or read undeclared data never loads', () => {
  const base = skill('invoice-chase');
  const withSkill = (over: Partial<Record<keyof PackSkill, unknown>>) =>
    validateManifest({
      ...SMALL_BUSINESS_PACK,
      skills: [{ ...base, ...over } as PackSkill],
    } as CapabilityPackManifest);

  test('acts, a Build mode, an undeclared need and an oversized playbook are each refused', () => {
    expect(withSkill({ acts: true })).toContain('Skill invoice-chase would act. A skill drafts; it never acts.');
    expect(withSkill({ mode: 'build' })).toContain('Skill invoice-chase runs in build. Skills run in Ask or Plan.');
    expect(
      withSkill({ inputs: [{ ...base.inputs[0], need: 'send-email' }] }),
    ).toContain('Skill invoice-chase reads send-email, which its pack does not declare.');
    expect(withSkill({ inputs: [] })).toContain('Skill invoice-chase reads nothing, so it could only invent.');
    expect(withSkill({ steps: ['x'.repeat(SKILL_SECTION_MAX_BYTES)] })).toContain(
      'Skill invoice-chase is larger than the 8 KB playbook budget.',
    );
  });

  test('a pack may not even declare an outward capability, and skills need the workflows dimension', () => {
    const bent = validateManifest({
      ...SMALL_BUSINESS_PACK,
      needs: [...SMALL_BUSINESS_PACK.needs, { capability: 'pay-bills', reason: 'x' }],
      contributes: ['ui'],
    } as CapabilityPackManifest);
    expect(bent).toContain('A pack may not declare the outward capability pay-bills.');
    expect(bent).toContain('A pack with skills contributes workflows.');
  });
});

let temp: string;
beforeEach(async () => {
  temp = await fs.mkdtemp(path.join(os.tmpdir(), 'diomedes-smb-'));
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
  return { store, id: created.id };
}

describe('turning the pack on is not an authorization event', () => {
  test('no grant, need, thread permission or instruction file comes from activating it', async () => {
    const { store, id } = await project();
    const before = {
      grants: structuredClone(store.state(id).scopeGrants ?? []),
      view: structuredClone(store.scopeGrants.view(id)),
      needs: structuredClone(store.state(id).needs),
      conversations: structuredClone(store.state(id).conversations),
    };
    await activatePack(store, id, PACK, '2026-09-23T10:00:00.000Z');
    expect(store.state(id).scopeGrants ?? []).toEqual(before.grants);
    expect(store.scopeGrants.view(id)).toEqual(before.view);
    expect(store.state(id).needs).toEqual(before.needs);
    expect(store.state(id).conversations).toEqual(before.conversations);
    expect(await discoverInstructionFiles(store, id)).toEqual([]);
    const entry = store.state(id).history.filter((item) => item.kind === 'pack').at(-1);
    expect(entry?.sentence).toBe('You turned on Small Business for this project. It adds no permission.');
    await deactivatePack(store, id, PACK, '2026-09-23T11:00:00.000Z');
    expect(store.state(id).scopeGrants ?? []).toEqual(before.grants);
  });
});

describe('a second pack never erases what the first one found', () => {
  test('Software Engineering on, then off, then Small Business on keeps the AGENTS.md record', async () => {
    const { store, id } = await project();
    await fs.writeFile(path.join(store.state(id).project.folder, 'AGENTS.md'), '# Rules\n', 'utf8');
    await activatePack(store, id, 'diomedes.software-engineering');
    const found = structuredClone(store.state(id).instructionFiles);
    expect(found).toHaveLength(1);
    await deactivatePack(store, id, 'diomedes.software-engineering');
    await activatePack(store, id, PACK);
    expect(await discoverInstructionFiles(store, id)).toEqual(found);
    expect(store.state(id).instructionFiles).toEqual(found);
    // With both on, the Software Engineering pack's finding is refreshed, not duplicated.
    await activatePack(store, id, 'diomedes.software-engineering');
    expect(store.state(id).instructionFiles).toHaveLength(1);
  });
});

describe('the selected skill rides in the host-assembled instruction section', () => {
  test('refused while the pack is off, and delivered whole within budget once it is on', async () => {
    const { store, id } = await project();
    const ask = (state: ProjectState, over: Partial<Parameters<typeof assembleSkillSection>[0]> = {}) =>
      assembleSkillSection({
        state,
        packId: PACK,
        skillId: 'cash-flow-snapshot',
        mode: 'ask',
        budgetBytes: instructionSectionBudget(0),
        ...over,
      });
    expect(() => ask(store.state(id))).toThrow(/Turn on Small Business for this project/);

    await activatePack(store, id, PACK);
    const assembled = ask(store.state(id));
    const playbook = renderSkillPlaybook(skill('cash-flow-snapshot'), SMALL_BUSINESS_PACK.version);
    expect(assembled.section).toContain(playbook);
    expect(assembled.section).toContain('--- BEGIN PLAYBOOK cash-flow-snapshot ---');
    expect(assembled.section).toContain('never estimate, invent or fill a gap silently');
    expect(assembled.section).toContain('you send, post, pay, transfer, book or message nothing');
    expect(assembled.use).toEqual({
      packId: PACK,
      packVersion: SMALL_BUSINESS_PACK.version,
      skillId: 'cash-flow-snapshot',
      name: 'Cash flow snapshot',
      bytes: Buffer.byteLength(assembled.section),
    });
    expect(assembled.use.bytes).toBeLessThanOrEqual(instructionSectionBudget(128_000));

    // Every playbook fits beside a full 128 KB selection, so a skill never refuses an
    // ordinary request that used to be admitted.
    for (const item of SKILLS)
      expect(() => ask(store.state(id), { skillId: item.id, mode: item.mode, budgetBytes: instructionSectionBudget(128_000) })).not.toThrow();

    expect(() => ask(store.state(id), { budgetBytes: 1024 })).toThrow(/never cut part way/);
    expect(() => ask(store.state(id), { mode: 'build' })).toThrow(/runs in Ask or Plan/);
    expect(() => ask(store.state(id), { mode: 'fix' })).toThrow(/runs in Ask or Plan/);
    expect(() => ask(store.state(id), { skillId: 'wire-money' })).toThrow(/does not exist/);
  });
});

describe('the ask route', () => {
  const cleanups: (() => Promise<void>)[] = [];
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0)) await cleanup();
  });

  async function fixture() {
    const engine = 'claude-code' as const;
    const version = TESTED_VERSIONS[engine];
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'diomedes-smb-api-'));
    const generate = vi.fn<TextEngineAdapter['generate']>(async (input) => ({
      projectId: input.projectId,
      threadId: input.threadId,
      requestId: input.requestId,
      model: input.model,
      text: input.prompt.includes('STRICT JSON')
        ? JSON.stringify({
            summary: 'Proposed text',
            changes: [{ path: 'Note.md', text: 'Reviewed text', summary: 'Create note' }],
          })
        : 'A drafted answer',
      version,
    }));
    const service = new EngineService(path.join(root, 'engines'), {
      discover: async () => [
        {
          id: engine,
          name: 'Claude Code',
          kind: 'online',
          found: true,
          available: false,
          enabled: false,
          status: 'Installed',
          detail: 'Found',
          capabilities: [],
          signIn: 'unknown',
          adapter: 'planned',
          installedVersion: version,
          location: 'fixture.exe',
          disclosure: [],
        },
      ],
      version: async () => version,
      adapter: () => ({
        id: engine,
        contract: routeContractFor(engine),
        inspect: async () => ({
          authentication: 'signed-in',
          accountRoute: 'claude-code:claude.ai',
          models: [{ slug: 'sonnet', name: 'Sonnet', description: '', efforts: [], defaultEffort: null }],
          detail: 'Checked',
        }),
        generate,
      }),
    });
    const app = await createApp({
      dataDir: path.join(root, 'data'),
      projectRoot: path.join(root, 'projects'),
      engineService: service,
    });
    const server: Server = await new Promise((resolve) => {
      const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
    });
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
    cleanups.push(async () => {
      await app.locals.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await fs.rm(root, { recursive: true, force: true });
    });
    const api = async (endpoint: string, method = 'GET', body?: unknown) => {
      const response = await fetch(base + endpoint, {
        method,
        headers: { 'Content-Type': 'application/json', 'X-Diomedes-Client': '1' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      return { status: response.status, data: await response.json() };
    };
    expect((await api('/ai/discover', 'POST', { consent: true })).status).toBe(200);
    expect((await api(`/ai/check/${engine}`, 'POST', {})).status).toBe(200);
    expect((await api('/ai/select', 'POST', { engine, model: 'sonnet' })).status).toBe(200);
    const created = (await api('/projects', 'POST', { name: 'Cafe' })).data;
    // Cloud sharing is default-deny: this synthetic project shares typed messages with Claude
    // Code and no document, which is all these requests send.
    expect((await api(`/projects/${created.id}/cloud-sharing`, 'PUT', {
      expectedVersion: 0, routes: ['claude-code'], documents: [],
      shareConversationHistory: false, shareReviewPackets: false,
    })).status).toBe(200);
    const thread = (await api(`/projects/${created.id}/threads`, 'POST', {})).data;
    return { api, generate, projectId: created.id as string, threadId: thread.id as string };
  }

  test('sends the playbook in the instruction channel, keeps the message as typed, and records it on the turn', async () => {
    const { api, generate, projectId, threadId } = await fixture();
    const body = {
      text: 'Show me a cash flow snapshot for the next four weeks.',
      mode: 'ask',
      route: 'claude-code',
      threadId,
      consent: true,
      skill: 'cash-flow-snapshot',
    };
    const refused = await api(`/projects/${projectId}/ask`, 'POST', body);
    expect(refused.status).toBe(409);
    expect(refused.data.code).toBe('pack_inactive');
    expect(generate).not.toHaveBeenCalled();

    expect((await api(`/projects/${projectId}/packs/${PACK}/activate`, 'POST', {})).status).toBe(200);
    const answer = await api(`/projects/${projectId}/ask`, 'POST', body);
    expect(answer.status).toBe(200);
    const sent = generate.mock.calls[0][0];
    expect(sent.prompt).toBe(body.text);
    expect(sent.prompt).not.toContain('PLAYBOOK');
    expect(sent.instructions).toContain('--- BEGIN PLAYBOOK cash-flow-snapshot ---');
    expect(sent.instructions).toContain('Answer only from the request and the documents supplied');

    const state: ProjectState = (await api(`/projects/${projectId}/state`)).data;
    const turns = state.conversations.find((c) => c.id === threadId)!.turns;
    const mine = turns.find((turn) => turn.role === 'you')!;
    expect(mine.text).toBe(body.text);
    expect(mine.skill).toMatchObject({ packId: PACK, skillId: 'cash-flow-snapshot', name: 'Cash flow snapshot' });
    expect(mine.skill!.bytes).toBeGreaterThan(0);

    // An ordinary message on the same thread carries no playbook.
    await api(`/projects/${projectId}/ask`, 'POST', { ...body, skill: undefined, text: 'Thanks' });
    expect(generate.mock.calls[1][0].instructions).not.toContain('PLAYBOOK');
  });

  test('P04: the chosen playbook loads on demand, and History names its pack version and digest', async () => {
    const { api, generate, projectId, threadId } = await fixture();
    const target = `/projects/${projectId}`;
    // Off: no index, and a panel cannot open anything from the pack.
    expect((await api(`${target}/packs/contributions`)).data.indexes).toEqual([]);
    const closed = await api(`${target}/packs/${PACK}/contributions/workflow/cash-flow-snapshot/open`, 'POST', {});
    expect(closed.status).toBe(409);
    expect(closed.data.code).toBe('pack_inactive');

    await api(`${target}/packs/${PACK}/activate`, 'POST', {});
    const listing = (await api(`${target}/packs/contributions`)).data;
    expect(listing.indexes.map((index: { packId: string }) => index.packId)).toEqual([PACK]);
    expect(listing.loaded).toEqual([]);
    const budget = listing.budgets[0];
    expect(budget.indexBytes).toBeLessThan(budget.bodyBytes / 4);

    const answer = await api(`${target}/ask`, 'POST', {
      text: 'Show me a cash flow snapshot for the next four weeks.',
      mode: 'ask',
      route: 'claude-code',
      threadId,
      consent: true,
      skill: 'cash-flow-snapshot',
    });
    expect(answer.status).toBe(200);
    const state: ProjectState = (await api(`${target}/state`)).data;
    const mine = state.conversations.find((c) => c.id === threadId)!.turns.find((turn) => turn.role === 'you')!;
    const load = state.history.find((entry) => entry.contribution?.outcome === 'loaded')!;
    expect(load.actor).toBe('diomedes');
    expect(load.contribution).toMatchObject({
      packId: PACK,
      packVersion: '0.1.0',
      kind: 'workflow',
      contributionId: 'cash-flow-snapshot',
      reason: 'chosen',
      runKey: mine.id,
      digest: mine.skill!.digest,
    });
    expect(load.sentence).toContain(`(${mine.skill!.digest!.slice(7, 19)}) because you chose it`);
    // The body sent is the body whose digest was checked.
    expect(generate.mock.calls[0][0].instructions).toContain('Playbook: Cash flow snapshot (cash-flow-snapshot, version 0.1.0)');

    // A person opening the playbook panel loads it for reading, and that is recorded too.
    const opened = await api(`${target}/packs/${PACK}/contributions/workflow/cash-flow-snapshot/open`, 'POST', {});
    expect(opened.status).toBe(200);
    expect(opened.data).toMatchObject({ packVersion: '0.1.0', digest: mine.skill!.digest });
    expect(opened.data.body).toContain('Steps:');

    await api(`${target}/packs/${PACK}/deactivate`, 'POST', {});
    const after = (await api(`${target}/packs/contributions`)).data;
    expect(after.indexes).toEqual([]);
    expect(after.loaded).toEqual([]);
    expect(after.records.at(-1)).toMatchObject({ outcome: 'unloaded', packId: PACK });
  });

  test('refuses a skill in Build, and Build proposals are parsed exactly as before with the pack on', async () => {
    const { api, generate, projectId, threadId } = await fixture();
    await api(`/projects/${projectId}/packs/${PACK}/activate`, 'POST', {});
    const target = `/projects/${projectId}`;
    const withSkill = await api(`${target}/ask`, 'POST', {
      text: 'Create a note',
      mode: 'build',
      route: 'claude-code',
      threadId,
      consent: true,
      skill: 'invoice-chase',
    });
    expect(withSkill.status).toBe(400);
    expect(generate).not.toHaveBeenCalled();

    const start = await api(`${target}/ask`, 'POST', {
      text: 'Create a note',
      mode: 'build',
      route: 'claude-code',
      threadId,
      consent: true,
    });
    expect(start.status).toBe(200);
    let state: ProjectState = (await api(`${target}/state`)).data;
    for (let n = 0; n < 200 && !state.needs.some((need) => need.state === 'open'); n++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      state = (await api(`${target}/state`)).data;
    }
    const need = state.needs.find((item) => item.state === 'open');
    expect(need?.preview?.[0].after).toBe('Reviewed text');
    const prompt = generate.mock.calls.at(-1)![0].prompt;
    expect(prompt).toContain('Return STRICT JSON only');
    expect(prompt).not.toContain('PLAYBOOK');
  });
});

describe('launching a skill from the Console', () => {
  const handlers = () =>
    ({ launchSkill: vi.fn(), turnOnSkills: vi.fn(), openDocument: vi.fn() }) as unknown as PaletteHandlers;
  const context = (skills: PaletteContext['skills'], h = handlers()): PaletteContext => ({
    tasks: [], sessions: [], needs: [], changes: [], documents: [], skills, members: [], catalogs: {},
    integrations: [], projects: [], currentProjectId: 'p', currentThread: null, policy: 'go', view: 'Thread',
    pendingTaskId: null, routingTaskId: null, onPendingTask: vi.fn(), onRoutingTask: vi.fn(),
    onPivotModels: vi.fn(), handlers: h,
  });

  test('off shows one row that offers to turn the pack on, and no playbooks', () => {
    const h = handlers();
    const rows = buildEntries(context({ active: false, name: 'Small Business', list: SKILLS }, h)).filter(
      (row) => row.group === 'Skills',
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe('Small Business skills');
    expect(rows[0].actions.map((action) => action.label)).toEqual(['Turn on']);
    rows[0].actions[0].run();
    expect(h.turnOnSkills).toHaveBeenCalledOnce();
    expect(buildEntries(context(undefined)).some((row) => row.group === 'Skills')).toBe(false);
  });

  test('on lists every playbook with one Use action, findable by what an owner would say', () => {
    const h = handlers();
    const all = buildEntries(context({ active: true, name: 'Small Business', list: SKILLS }, h));
    const rows = all.filter((row) => row.group === 'Skills');
    expect(rows).toHaveLength(12);
    expect(filterPalette(all, 'who owes').map((row) => row.id)).toEqual(['skill:invoice-chase']);
    const cash = rows.find((row) => row.id === 'skill:cash-flow-snapshot')!;
    expect(cash.actions.map((action) => action.label)).toEqual(['Use']);
    cash.actions[0].run();
    expect(h.launchSkill).toHaveBeenCalledWith(skill('cash-flow-snapshot'));
  });

  test('P04: where the Console can open a playbook, each row also offers Read; off offers none', () => {
    const h = { ...handlers(), readSkill: vi.fn() };
    const rows = buildEntries(context({ active: true, name: 'Small Business', list: SKILLS }, h)).filter(
      (row) => row.group === 'Skills',
    );
    const cash = rows.find((row) => row.id === 'skill:cash-flow-snapshot')!;
    expect(cash.actions.map((action) => action.label)).toEqual(['Use', 'Read']);
    cash.actions[1].run();
    expect(h.readSkill).toHaveBeenCalledWith(skill('cash-flow-snapshot'));
    const off = buildEntries(context({ active: false, name: 'Small Business', list: SKILLS }, h)).filter(
      (row) => row.group === 'Skills',
    );
    expect(off.flatMap((row) => row.actions.map((action) => action.label))).toEqual(['Turn on']);
  });

  test('the palette renders the Skills group, and the composer names the playbook and fills the box', () => {
    const entries = buildEntries(context({ active: true, name: 'Small Business', list: SKILLS }));
    const palette = renderToStaticMarkup(
      createElement(Palette, { open: true, entries: () => entries, onClose: () => {} }),
    );
    expect(palette).toContain('>Skills<');
    expect(palette).toContain('Weekly business pulse');

    const thread: Conversation = {
      id: 't',
      attachedTo: { kind: 'project', ref: 'p' },
      name: 'New thread',
      mode: 'ask',
      requested: null,
      turns: [],
    };
    const pick = skill('invoice-chase');
    const props = {
      thread, mode: 'ask' as const, onMode: () => {}, busy: false, online: true, route: 'codex' as const,
      confirmSend: false, prepareSources: async () => [], onSend: () => {},
    };
    const picked = renderToStaticMarkup(
      createElement(Composer, { ...props, skill: { name: pick.name, starter: pick.starter, n: 1 }, onClearSkill: () => {} }),
    );
    expect(picked).toContain('playbook');
    expect(picked).toContain(pick.name);
    expect(picked).toContain(`Remove the ${pick.name} playbook`);
    expect(picked).toContain(pick.starter.replaceAll("'", '&#x27;'));
    // The playbook's own steps never enter the box the person types in.
    expect(picked).not.toContain(pick.steps[0].slice(0, 30));
    const plain = renderToStaticMarkup(createElement(Composer, props));
    expect(plain).not.toContain('playbook');
  });
});
