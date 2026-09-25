/**
 * H11: nested project instruction files, their precedence, and the delivery
 * record that says exactly which of them one run used and why the others were
 * left out.
 *
 * Everything here goes through the same rule path and the same path guard the
 * root-only slice uses (`server/capability-packs.ts`,
 * `server/harness/instruction-delivery.ts`, `server/paths.ts`). No engine is
 * started: `assembleInstructions` is the one place a run's section and record
 * are made, and the end-to-end run is covered in `tests/native-work.test.ts`.
 */
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../server/store.js';
import {
  activatePack,
  discoverInstructionFiles,
  instructionRules,
} from '../server/capability-packs.js';
import { assembleInstructions, instructionSectionBudget } from '../server/harness/instruction-delivery.js';
import { toScopedRule } from '../server/rules.js';
import { resolveRules, type ScopedRule } from '../shared/rule-authority.js';
import {
  compareInstructionPrecedence,
  instructionAppliesTo,
  instructionRuleId,
  instructionScope,
  INSTRUCTION_FILE_VIEW_BUDGET_BYTES,
  INSTRUCTION_PRECEDENCE,
  NESTED_INSTRUCTION_MAX_DEPTH,
} from '../shared/capability-packs.js';

const PACK = 'diomedes.software-engineering' as const;

let temp: string;
beforeEach(async () => {
  temp = await fs.mkdtemp(path.join(os.tmpdir(), 'diomedes-nested-'));
});
afterEach(async () => {
  await fs.rm(temp, { recursive: true, force: true });
});

const canLink = await (async () => {
  const probe = await fs.mkdtemp(path.join(os.tmpdir(), 'diomedes-link-probe-'));
  try {
    await fs.mkdir(path.join(probe, 'target'));
    await fs.symlink(path.join(probe, 'target'), path.join(probe, 'link'), 'junction');
    return (await fs.lstat(path.join(probe, 'link'))).isSymbolicLink();
  } catch {
    return false;
  } finally {
    await fs.rm(probe, { recursive: true, force: true });
  }
})();

async function project(files: Record<string, string>) {
  const folder = path.join(temp, 'repo');
  await fs.mkdir(folder, { recursive: true });
  for (const [name, text] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(folder, name)), { recursive: true });
    await fs.writeFile(path.join(folder, name), text, 'utf8');
  }
  const dataDir = path.join(temp, 'data');
  const projectRoot = path.join(temp, 'projects');
  const store = new Store(dataDir, projectRoot);
  await store.init();
  const created = await store.createProject('Repo', folder);
  return { store, id: created.id, folder, dataDir, projectRoot };
}

const assemble = (store: Store, id: string, workPaths: string[], budgetBytes = 32 * 1024) =>
  assembleInstructions({
    state: store.state(id),
    routeId: 'codex',
    agentRole: 'Diomedes build file proposal writer',
    budgetBytes,
    workPaths,
    at: '2026-09-24T01:00:00.000Z',
  });

const MONOREPO = {
  'AGENTS.md': '# Root\nROOT-AGENTS-BODY\n',
  'CLAUDE.md': '# Root claude\nROOT-CLAUDE-BODY\n',
  'pkg/AGENTS.md': '# Pkg\nPKG-AGENTS-BODY\n',
  'pkg/api/AGENTS.md': '# Api\nAPI-AGENTS-BODY\n',
  'pkg/api/CLAUDE.md': '# Api claude\nAPI-CLAUDE-BODY\n',
  'pkg/web/AGENTS.md': '# Web\nWEB-AGENTS-BODY\n',
  'pkg/api/src/index.ts': 'export {};\n',
};

describe('the precedence order is a table, and the implementation reads it', () => {
  // Each row: the two paths, and which one governs.
  const table: [string, string, string][] = [
    ['pkg/api/AGENTS.md', 'pkg/AGENTS.md', 'pkg/api/AGENTS.md'],
    ['pkg/AGENTS.md', 'AGENTS.md', 'pkg/AGENTS.md'],
    ['AGENTS.md', 'CLAUDE.md', 'AGENTS.md'],
    ['pkg/api/CLAUDE.md', 'pkg/api/AGENTS.md', 'pkg/api/AGENTS.md'],
    // Nearness beats file kind: a nested CLAUDE.md governs a root AGENTS.md.
    ['pkg/api/CLAUDE.md', 'pkg/AGENTS.md', 'pkg/api/CLAUDE.md'],
    ['CLAUDE.md', 'pkg/CLAUDE.md', 'pkg/CLAUDE.md'],
    // Siblings at the same depth never govern each other's work; the order
    // between them is only there to make the sort total.
    ['pkg/web/AGENTS.md', 'pkg/api/AGENTS.md', 'pkg/api/AGENTS.md'],
  ];
  test.each(table)('%s against %s: %s governs', (a, b, winner) => {
    const sorted = [a, b].sort((x, y) => compareInstructionPrecedence(x, y));
    expect(sorted[0]).toBe(winner);
    expect([b, a].sort((x, y) => compareInstructionPrecedence(x, y))[0]).toBe(winner);
  });

  test('the whole order is total and independent of input order', () => {
    const paths = Object.keys(MONOREPO).filter((name) => name.endsWith('.md'));
    const once = [...paths].sort((a, b) => compareInstructionPrecedence(a, b));
    const reversed = [...paths].reverse().sort((a, b) => compareInstructionPrecedence(a, b));
    expect(once).toEqual(reversed);
    expect(once).toEqual([
      'pkg/api/AGENTS.md',
      'pkg/api/CLAUDE.md',
      'pkg/web/AGENTS.md',
      'pkg/AGENTS.md',
      'AGENTS.md',
      'CLAUDE.md',
    ]);
    expect(INSTRUCTION_PRECEDENCE).toHaveLength(3);
  });

  test('authority comes first: every file is a project rule, below the organization and above a task', async () => {
    const { store, id } = await project(MONOREPO);
    await activatePack(store, id, PACK);
    const files = instructionRules(store.state(id));
    expect(files.length).toBeGreaterThan(1);
    expect(new Set(files.map((item) => item.authority))).toEqual(new Set(['project']));
    const organization: ScopedRule = {
      id: 'company-tone',
      version: 1,
      authority: 'organization',
      category: 'guidance',
      constrains: 'guidance:company-tone',
      stance: 'prefer',
      text: 'Company guidance.',
      scope: { projectId: id },
      recordedAt: 'company-tone:1',
    };
    const task: ScopedRule = { ...organization, id: 'task-note', authority: 'task', constrains: 'guidance:task-note', recordedAt: 'task-note:1' };
    const resolution = resolveRules([
      task,
      ...files.map(({ rule, authority }) => toScopedRule(rule, authority)),
      organization,
    ]);
    const order = resolution.applied.map((rule) => rule.authority);
    expect(order[0]).toBe('organization');
    expect(order.at(-1)).toBe('task');
    expect(order.slice(1, -1).every((authority) => authority === 'project')).toBe(true);
  });

  test('scope is compared a whole folder at a time', () => {
    expect(instructionScope('AGENTS.md')).toBe('');
    expect(instructionScope('pkg/api/AGENTS.md')).toBe('pkg/api');
    expect(instructionAppliesTo('AGENTS.md', [])).toBe(true);
    expect(instructionAppliesTo('pkg/api/AGENTS.md', ['pkg/api/src/index.ts'])).toBe(true);
    expect(instructionAppliesTo('pkg/api/AGENTS.md', ['pkg/apiary/x.ts'])).toBe(false);
    expect(instructionAppliesTo('pkg/api/AGENTS.md', ['pkg/api'])).toBe(false);
    expect(instructionAppliesTo('pkg/api/AGENTS.md', [])).toBe(false);
  });

  test('two nested paths that slug alike never share a rule', () => {
    expect(instructionRuleId('AGENTS.md')).toBe('instructions-agents-md');
    expect(instructionRuleId('pkg/api/AGENTS.md')).not.toBe(instructionRuleId('pkg-api/AGENTS.md'));
    const long = `${'very-long-folder/'.repeat(5)}AGENTS.md`;
    expect(instructionRuleId(long)).toMatch(/^[a-z][a-z0-9-]{0,63}$/);
    expect(instructionRuleId(long)).not.toBe(instructionRuleId(`${long.slice(0, -9)}CLAUDE.md`));
  });
});

describe('nested discovery is bounded and stays inside the project', () => {
  test('files in nested folders are found, and ignored folders are not walked', async () => {
    const deep = `${Array.from({ length: NESTED_INSTRUCTION_MAX_DEPTH + 1 }, (_, i) => `d${i}`).join('/')}/AGENTS.md`;
    const { store, id } = await project({
      ...MONOREPO,
      'node_modules/lib/AGENTS.md': 'VENDORED',
      '.hidden/AGENTS.md': 'HIDDEN',
      'dist/AGENTS.md': 'BUILT',
      [deep]: 'TOO-DEEP',
      'pkg/api/agents.txt': 'not an instruction file',
    });
    await activatePack(store, id, PACK);
    const paths = (store.state(id).instructionFiles ?? []).map((record) => record.path);
    expect(paths).toEqual([
      'AGENTS.md',
      'CLAUDE.md',
      'pkg/AGENTS.md',
      'pkg/api/AGENTS.md',
      'pkg/api/CLAUDE.md',
      'pkg/web/AGENTS.md',
    ]);
    const nested = store.state(id).instructionFiles!.find((record) => record.path === 'pkg/api/AGENTS.md')!;
    expect(nested.state).toBe('loaded');
    expect(nested.ruleId).toBe(instructionRuleId('pkg/api/AGENTS.md'));
    const rule = instructionRules(store.state(id)).find((item) => item.rule.id === nested.ruleId)!;
    expect(rule.rule.text).toBe('Project instructions from pkg/api/AGENTS.md apply to work in pkg/api.');
    expect(rule.authority).toBe('project');
  });

  test('a second discovery that finds the same files writes nothing', async () => {
    const { store, id } = await project(MONOREPO);
    await activatePack(store, id, PACK);
    const first = structuredClone(store.state(id).instructionFiles);
    expect(await discoverInstructionFiles(store, id, '2026-09-24T02:00:00.000Z')).toEqual(first);
  });

  test.skipIf(!canLink)('a linked folder is never walked, so a file outside the project is never read', async () => {
    const { store, id, folder } = await project({ 'AGENTS.md': 'ROOT' });
    const outside = path.join(temp, 'outside');
    await fs.mkdir(outside);
    await fs.writeFile(path.join(outside, 'AGENTS.md'), 'OUTSIDE-SENTINEL', 'utf8');
    await fs.symlink(outside, path.join(folder, 'linked'), 'junction');
    await activatePack(store, id, PACK);
    const records = store.state(id).instructionFiles ?? [];
    expect(records.map((record) => record.path)).toEqual(['AGENTS.md']);
    expect(JSON.stringify(records)).not.toContain('OUTSIDE-SENTINEL');
  });

  test.skipIf(!canLink)('a nested instruction file that is itself a link is refused by the guard and recorded', async () => {
    const { store, id, folder } = await project({ 'AGENTS.md': 'ROOT', 'pkg/readme.md': 'x' });
    const outside = path.join(temp, 'outside.md');
    await fs.writeFile(outside, 'LINKED-FILE-SENTINEL', 'utf8');
    try {
      await fs.symlink(outside, path.join(folder, 'pkg', 'AGENTS.md'), 'file');
    } catch {
      return; // File links need elevation on some Windows machines; the folder case above still runs.
    }
    await activatePack(store, id, PACK);
    const record = store.state(id).instructionFiles!.find((item) => item.path === 'pkg/AGENTS.md')!;
    expect(record.state).toBe('unreadable');
    expect(record.sha).toBeNull();
    expect(record.ruleId).toBeUndefined();
    expect(JSON.stringify(store.state(id).instructionFiles)).not.toContain('LINKED-FILE-SENTINEL');
  });
});

describe('a run is scoped: the nearest folder governs, and every file not sent says why', () => {
  test('work inside pkg/api gets its folder, its parent and the root, strongest first', async () => {
    const { store, id } = await project(MONOREPO);
    await activatePack(store, id, PACK);
    const { section, delivery } = await assemble(store, id, ['pkg/api/src/index.ts']);
    expect(delivery).not.toBeNull();
    expect(delivery!.files.map((file) => [file.path, file.precedence, file.scope, file.state])).toEqual([
      ['pkg/api/AGENTS.md', 1, 'pkg/api', 'sent'],
      ['pkg/api/CLAUDE.md', 2, 'pkg/api', 'sent'],
      ['pkg/AGENTS.md', 3, 'pkg', 'sent'],
      ['AGENTS.md', 4, '', 'sent'],
      ['CLAUDE.md', 5, '', 'sent'],
    ]);
    expect(delivery!.workPaths).toEqual(['pkg/api/src/index.ts']);
    expect(delivery!.excluded).toEqual([
      expect.objectContaining({ path: 'pkg/web/AGENTS.md', scope: 'pkg/web', exclusion: 'out-of-scope' }),
    ]);
    expect(delivery!.excluded![0].detail).toContain('pkg/web');
    // The section says the order and renders the bodies in it.
    expect(section).toContain('highest precedence first');
    const at = (text: string) => section!.indexOf(text);
    expect(at('API-AGENTS-BODY')).toBeLessThan(at('API-CLAUDE-BODY'));
    expect(at('API-CLAUDE-BODY')).toBeLessThan(at('PKG-AGENTS-BODY'));
    expect(at('PKG-AGENTS-BODY')).toBeLessThan(at('ROOT-AGENTS-BODY'));
    expect(at('ROOT-AGENTS-BODY')).toBeLessThan(at('ROOT-CLAUDE-BODY'));
    expect(section).not.toContain('WEB-AGENTS-BODY');
  });

  test('work at the root gets only the root files, and each nested file is excluded by name', async () => {
    const { store, id } = await project(MONOREPO);
    await activatePack(store, id, PACK);
    const { section, delivery } = await assemble(store, id, ['README.md']);
    expect(delivery!.files.map((file) => file.path)).toEqual(['AGENTS.md', 'CLAUDE.md']);
    expect(delivery!.excluded!.map((file) => [file.path, file.exclusion])).toEqual([
      ['pkg/api/AGENTS.md', 'out-of-scope'],
      ['pkg/api/CLAUDE.md', 'out-of-scope'],
      ['pkg/web/AGENTS.md', 'out-of-scope'],
      ['pkg/AGENTS.md', 'out-of-scope'],
    ]);
    expect(section).not.toContain('PKG-AGENTS-BODY');
    // Out of scope is not a budget loss: nothing was cut, and the model is not told about them.
    expect(delivery!.truncated).toBe(false);
    expect(section).not.toContain('pkg/AGENTS.md');
  });

  test('work in two sibling folders is not told that one sibling governs the other', async () => {
    // Review (2026-09-24): the order is total, so pkg/api's file is listed
    // before pkg/web's when work spans both. The sentence above the bodies
    // said only "where two disagree, the earlier one governs", which tells
    // the model pkg/api's rules override pkg/web's on pkg/web's own files.
    // Sibling folders never govern each other's work; precedence is between
    // files that cover the same file.
    const { store, id } = await project(MONOREPO);
    await activatePack(store, id, PACK);
    const { section } = await assemble(store, id, ['pkg/api/src/index.ts', 'pkg/web/page.md']);
    expect(section).toContain('WEB-AGENTS-BODY');
    expect(section).toContain('governs pkg/web');
    expect(section).not.toMatch(/Where two disagree, the earlier one governs\./);
    expect(section).toContain('only for files inside the folder it governs');
  });

  test('two files whose rule ids collide are both accounted for, never one silently dropped', async () => {
    // Review (2026-09-24): a nested rule id is a 41-character slug plus a
    // 32-bit FNV digest of the path, so a repository can hold two paths that
    // share one id (these two were found in under a second). The run kept
    // whichever came second and the other vanished from the delivery record:
    // neither sent nor excluded.
    const prefix = 'a'.repeat(41);
    const first = `${prefix}/10kb0/AGENTS.md`;
    const second = `${prefix}/k6yj/AGENTS.md`;
    expect(instructionRuleId(first)).toBe(instructionRuleId(second));
    const { store, id } = await project({ [first]: 'FIRST-BODY', [second]: 'SECOND-BODY' });
    await activatePack(store, id, PACK);
    const { delivery } = await assemble(store, id, [`${prefix}/10kb0/x.md`, `${prefix}/k6yj/x.md`]);
    const accounted = [
      ...delivery!.files.map((file) => file.path),
      ...(delivery!.excluded ?? []).map((file) => file.path),
    ];
    expect(accounted).toEqual(expect.arrayContaining([first, second]));
    expect(delivery!.files.filter((file) => file.state === 'sent')).toHaveLength(1);
  });

  test('a folder whose name only starts like a scoped folder does not inherit its rules', async () => {
    const { store, id } = await project(MONOREPO);
    await activatePack(store, id, PACK);
    const { delivery } = await assemble(store, id, ['pkg/apiary/x.md']);
    expect(delivery!.files.map((file) => file.path)).toEqual(['pkg/AGENTS.md', 'AGENTS.md', 'CLAUDE.md']);
  });

  test('a file discovery would not load is listed as excluded with its own reason', async () => {
    const big = `# Big\n${'x'.repeat(INSTRUCTION_FILE_VIEW_BUDGET_BYTES + 10)}\n`;
    const { store, id } = await project({ 'AGENTS.md': 'ROOT', 'pkg/AGENTS.md': big });
    await activatePack(store, id, PACK);
    const { delivery } = await assemble(store, id, ['pkg/a.md']);
    expect(delivery!.files.map((file) => file.path)).toEqual(['AGENTS.md']);
    expect(delivery!.excluded).toEqual([
      expect.objectContaining({ path: 'pkg/AGENTS.md', exclusion: 'not-loaded', bytes: Buffer.byteLength(big) }),
    ]);
  });

  test('cloud sharing still decides; a nested file that is not shared is excluded, not sent', async () => {
    const { store, id } = await project(MONOREPO);
    await activatePack(store, id, PACK);
    const result = await assembleInstructions({
      state: store.state(id),
      routeId: 'codex',
      agentRole: 'Diomedes build file proposal writer',
      budgetBytes: 32 * 1024,
      workPaths: ['pkg/api/src/index.ts'],
      allowedDocuments: ['AGENTS.md', 'pkg/api/AGENTS.md'],
      });
    expect(result.delivery!.files.map((file) => file.path)).toEqual(['pkg/api/AGENTS.md', 'AGENTS.md']);
    expect(result.section).not.toContain('API-CLAUDE-BODY');
    expect(result.delivery!.excluded!.filter((file) => file.exclusion === 'not-shared').map((file) => file.path)).toEqual([
      'pkg/api/CLAUDE.md',
      'pkg/web/AGENTS.md',
      'pkg/AGENTS.md',
      'CLAUDE.md',
    ]);
  });
});

describe('the byte budget spends on the strongest file first and never cuts one', () => {
  test('when only one fits, the nearest one goes and the root one is left out whole', async () => {
    const nested = `# Api\n${'n'.repeat(3000)}\n`;
    const root = `# Root\n${'r'.repeat(3000)}\n`;
    const { store, id } = await project({ 'AGENTS.md': root, 'pkg/api/AGENTS.md': nested });
    await activatePack(store, id, PACK);
    // The writing standard and shipped product knowledge are placed first and
    // take their share of the budget (each joined by one newline); the room
    // left for project files is what this test sizes. That
    // room also carries the section's frame (the preamble, the rule lines,
    // each file's delimiters or left-out line), so it is sized for one
    // 3 KB body and its frame, and not two.
    const first = await assemble(store, id, ['pkg/api/x.ts']);
    const product = first.productKnowledge.bytes + first.writing.bytes + 1;
    const { section, delivery } = await assemble(store, id, ['pkg/api/x.ts'], product + 5000);
    expect(delivery!.files.map((file) => [file.path, file.state, file.exclusion])).toEqual([
      ['pkg/api/AGENTS.md', 'sent', undefined],
      ['AGENTS.md', 'omitted', 'no-room'],
    ]);
    expect(delivery!.truncated).toBe(true);
    expect(delivery!.bytes).toBe(Buffer.byteLength(nested));
    expect(delivery!.files[1].bytes).toBe(Buffer.byteLength(root));
    expect(delivery!.files[1].sha).not.toBeNull();
    expect(section).toContain('n'.repeat(3000));
    expect(section).not.toContain('r'.repeat(100));
    expect(section).toContain('- AGENTS.md: Not sent.');
  });

  test('the whole section, not only the bodies, stays inside its budget when many nested files apply', async () => {
    // Review (2026-09-24): the budget was spent on bodies alone, while each
    // applied file also brings a rule line, two delimiter lines or a
    // left-out line. With 32 nested files in scope and the selection at the
    // 128 KB source ceiling that frame alone overran the section's share of
    // the 160 KB request by several KB, so a selection that used to be
    // admitted could be refused once instructions were added behind it.
    const files: Record<string, string> = { 'AGENTS.md': `# Root\n${'r'.repeat(400)}\n` };
    for (let index = 0; index < 32; index++)
      files[`packages/service-number-${String(index).padStart(2, '0')}/src/AGENTS.md`] =
        `# Service ${index}\n${'s'.repeat(300)}\n`;
    const { store, id } = await project(files);
    await activatePack(store, id, PACK);
    const work = Object.keys(files)
      .filter((name) => name.includes('/'))
      .map((name) => name.replace('AGENTS.md', 'index.ts'));
    // 6000 was the smallest room this frame was proven inside before the writing standard
    // (plain writing, 2026-09-25) took its share ahead of it, so that share is added back.
    const standard = (await assemble(store, id, work)).writing.bytes + 1;
    for (const budget of [instructionSectionBudget(128_000), instructionSectionBudget(0), 6000 + standard]) {
      const { section, delivery } = await assemble(store, id, work, budget);
      expect(Buffer.byteLength(section!)).toBeLessThanOrEqual(budget);
      // Still strongest first: the files are near enough one size that what
      // went is a prefix of the precedence order.
      const states = delivery!.files.map((file) => file.state);
      expect(states).toEqual([...states].sort((a, b) => (a === b ? 0 : a === 'sent' ? -1 : 1)));
      if (budget >= instructionSectionBudget(128_000))
        expect(delivery!.files.filter((file) => file.state === 'sent').length).toBeGreaterThan(0);
    }
  });

  test('a file that grew past the per-file limit after discovery is left out whole and says so', async () => {
    const { store, id, folder } = await project({ 'AGENTS.md': 'ROOT', 'pkg/AGENTS.md': 'small' });
    await activatePack(store, id, PACK);
    await fs.writeFile(path.join(folder, 'pkg', 'AGENTS.md'), 'y'.repeat(INSTRUCTION_FILE_VIEW_BUDGET_BYTES + 1));
    const { delivery } = await assemble(store, id, ['pkg/x.md']);
    expect(delivery!.files[0]).toMatchObject({ path: 'pkg/AGENTS.md', state: 'omitted', exclusion: 'over-file-limit' });
    expect(delivery!.files[1]).toMatchObject({ path: 'AGENTS.md', state: 'sent' });
    expect(delivery!.truncated).toBe(true);
  });

  test('a file deleted after discovery is recorded missing', async () => {
    const { store, id, folder } = await project({ 'AGENTS.md': 'ROOT', 'pkg/AGENTS.md': 'gone soon' });
    await activatePack(store, id, PACK);
    await fs.rm(path.join(folder, 'pkg', 'AGENTS.md'));
    const { delivery } = await assemble(store, id, ['pkg/x.md']);
    expect(delivery!.files[0]).toMatchObject({ path: 'pkg/AGENTS.md', state: 'omitted', exclusion: 'missing' });
  });

  test.skipIf(!canLink)('a folder replaced by a link after discovery is refused by the guard at run time', async () => {
    const { store, id, folder } = await project({ 'AGENTS.md': 'ROOT', 'pkg/AGENTS.md': 'NESTED' });
    await activatePack(store, id, PACK);
    const outside = path.join(temp, 'elsewhere');
    await fs.mkdir(outside);
    await fs.writeFile(path.join(outside, 'AGENTS.md'), 'SWAPPED-IN-SENTINEL', 'utf8');
    await fs.rm(path.join(folder, 'pkg'), { recursive: true });
    await fs.symlink(outside, path.join(folder, 'pkg'), 'junction');
    const { section, delivery } = await assemble(store, id, ['pkg/x.md']);
    expect(delivery!.files[0]).toMatchObject({ path: 'pkg/AGENTS.md', state: 'omitted', exclusion: 'refused', sha: null });
    expect(section).not.toContain('SWAPPED-IN-SENTINEL');
  });
});

describe('the delivery record is durable', () => {
  test('a session carrying a nested delivery reads back identically after a restart', async () => {
    const { store, id, dataDir, projectRoot } = await project(MONOREPO);
    await activatePack(store, id, PACK);
    const { delivery } = await assemble(store, id, ['pkg/api/src/index.ts'], 40);
    expect(delivery!.truncated).toBe(true);
    const state = store.state(id);
    state.sessions.push({
      id: 'S-h11',
      taskId: 'T-h11',
      state: 'done',
      startedAt: '2026-09-24T01:00:00.000Z',
      endedAt: '2026-09-24T01:01:00.000Z',
      sample: false,
      instructions: delivery!,
      log: [],
      entryIds: [],
      needId: null,
      engine: {
        name: 'Codex, guarded file proposals',
        model: null,
        worker: 1,
        branch: null,
        context: 0,
        events: 0,
        version: null,
        verified: false,
      },
    } as unknown as (typeof state.sessions)[number]);
    await store.persist(state);

    const reopened = new Store(dataDir, projectRoot);
    await reopened.init();
    const session = reopened.state(id).sessions.find((item) => item.id === 'S-h11')!;
    expect(session.instructions).toEqual(delivery);
    expect(session.instructions!.files.map((file) => file.exclusion)).toContain('no-room');
    expect(session.instructions!.excluded!.map((file) => file.path)).toEqual(['pkg/web/AGENTS.md']);
  });
});
