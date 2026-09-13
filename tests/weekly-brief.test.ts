/**
 * The weekly brief, proven against a real Store over a temporary directory.
 *
 * A draft is only as honest as its references, so these tests hold the whole
 * structure to account rather than one example claim: every claim carries a
 * source id that resolves, every rendered claim line ends with a reference
 * the Sources list explains, and composition is byte-identical on repeat.
 * Unchanged and unreadable sources are named rather than dropped, the two
 * variants share one structure under different labels, and `run()` performs
 * exactly one recorded write — refused outright when the setup is not active,
 * not ready, escaping the project, or raced by a concurrent edit.
 *
 * Every fixture is invented. No workplace is real, no figure is financial,
 * nothing touches payroll or orders, and nothing signs off licensed work.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { hash, Store } from '../server/store.js';
import { ApiError } from '../server/paths.js';
import { BUSINESS_SETUP_SCHEMA_REVISION } from '../shared/business-setup.js';
import type { ConfigurationManifest, ValidationProblem } from '../shared/configuration.js';
import { composeBrief, renderBrief, WeeklyBriefService } from '../server/weekly-brief.js';

const AT = '2026-09-10T09:00:00.000Z';
const ORG = 'org-weekly-brief';
const TENANT = 'tenant-weekly-brief';

let root = '';
let store: Store;
let service: WeeklyBriefService;
let projectId = '';

beforeEach(async () => {
  await fs.mkdir(path.join(process.cwd(), 'test-results'), { recursive: true });
  root = await fs.mkdtemp(path.join(process.cwd(), 'test-results', 'weekly-brief-'));
  store = new Store(path.join(root, 'data'), path.join(root, 'projects'));
  await store.init();
  service = new WeeklyBriefService(store);
  projectId = (await store.createProject('Invented brief project')).id;
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(root, { recursive: true, force: true });
});

const writeFixture = (name: string, text: string): Promise<void> =>
  fs.writeFile(path.join(store.state(projectId).project.folder, name), text, 'utf8');

// --- invented fixtures: a neighbourhood bistro, nothing real -----------------

// None of these lines touch payroll or orders: prep, deliveries, the room.
const KITCHEN_LOG = [
  'Sharpen the prep knives on Monday.',
  'Confirm the Thursday produce delivery window.',
  'Wipe down the prep counters each evening.',
  'Reprint the cleaning rota for the noticeboard.',
].join('\n');

const DINING_NOTES = [
  'Move the corner table nearer the window.',
  'Reprint the opening-hours sign for the door.',
  'Restock the welcome leaflets by Friday.',
].join('\n');

// Shared shape for the variant comparison: benign lines any business could own.
const FRONT_DESK_NOTES = [
  'Restock the welcome leaflets by Friday.',
  'Confirm the Thursday delivery window with the supplier.',
  'Wipe down the front counter each evening.',
].join('\n');

const MAINTENANCE_NOTES = [
  'Replace the storeroom lightbulb.',
  'Book the window cleaner for next month.',
  'Log the cold-room temperature each morning.',
].join('\n');

interface ManifestOptions {
  variantId?: string;
  scopeLabel?: string;
  outputLabel?: string;
  destination?: string;
  selection?: readonly string[];
  state?: ConfigurationManifest['state'];
  ready?: boolean;
}

function manifestFor(options: ManifestOptions = {}): ConfigurationManifest {
  const {
    variantId = 'restaurant-operations',
    scopeLabel = 'Weekly operations exports',
    outputLabel = 'Weekly operations brief',
    destination = 'weekly-operations-brief.md',
    selection = ['kitchen-log.md', 'dining-room-notes.md'],
    state = 'active',
    ready = true,
  } = options;
  const blocking: readonly ValidationProblem[] = ready
    ? []
    : [
        {
          code: 'unknown-route',
          severity: 'blocking',
          field: 'modelPolicy.routes',
          message: 'No way of running this work was chosen.',
        },
      ];
  return {
    v: 1,
    organizationId: ORG,
    tenantId: TENANT,
    revision: 1,
    digest: 'sha256:brief-fixture',
    state,
    proposal: {
      v: 1,
      organizationId: ORG,
      tenantId: TENANT,
      questionnaireRevision: BUSINESS_SETUP_SCHEMA_REVISION,
      answersDigest: 'sha256:answers-fixture',
      previousConfigurationDigest: null,
      template: { id: 'diomedes.weekly-brief', version: '1.0.0', variantId },
      agents: [],
      team: null,
      rules: [],
      requiredConnections: [],
      contextScopes: [
        {
          id: 'weekly-sources',
          label: scopeLabel,
          kind: 'approved-files',
          selection: [...selection],
          provenance: { source: 'template', why: 'The brief reads the approved exports.' },
        },
      ],
      modelPolicy: {
        routes: ['harness-runtime'],
        processing: 'local-only',
        fallbackAllowed: false,
        provenance: { source: 'template', why: 'The work stays on this computer.' },
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
      expectedOutputs: [
        {
          id: 'weekly-brief',
          label: outputLabel,
          artifact: 'report.markdown',
          destination,
          reviewedBy: 'person-after-reviewer',
          provenance: { source: 'template', why: 'The pack produces a weekly brief.' },
        },
      ],
      unresolved: [],
      createdAt: AT,
      createdBy: 'person_owner',
      candidateOrigin: 'deterministic',
    },
    readiness: { ready, blocking, degraded: [], degradedPlan: null, checkedAt: AT },
    stagedAt: AT,
    stagedBy: 'person_owner',
    activatedAt: state === 'active' ? AT : null,
    activatedBy: state === 'active' ? 'person_owner' : null,
    activationId: null,
    supersededAt: null,
    failureReason: null,
  };
}

/** A realistic draft over both bistro sources, with no previous brief. */
async function realisticDraft() {
  await writeFixture('kitchen-log.md', KITCHEN_LOG);
  await writeFixture('dining-room-notes.md', DINING_NOTES);
  const manifest = manifestFor();
  const sources = await service.gather(projectId, manifest);
  return { manifest, draft: composeBrief({ manifest, sources, previous: null, at: AT }) };
}

async function fails(call: Promise<unknown>): Promise<ApiError> {
  try {
    await call;
  } catch (error) {
    return error as ApiError;
  }
  throw new Error('Expected the call to fail, but it succeeded.');
}

/** Claim lines grouped under their per-source headings, ahead of `## Sources`. */
function claimLinesOf(markdown: string): string[] {
  const lines = markdown.split('\n');
  const end = lines.findIndex((line) => line.trim() === '## Sources');
  const body = end === -1 ? lines : lines.slice(0, end);
  return body.filter((line) => line.startsWith('- '));
}

describe('sourced claims', () => {
  test('every claim names a source id that appears in the draft sources', async () => {
    const { draft } = await realisticDraft();
    expect(draft.sections.length).toBeGreaterThan(0);
    const known = new Map(draft.sources.map((source) => [source.id, source]));
    // Source ids are unique, so a reference cannot resolve ambiguously.
    expect(known.size).toBe(draft.sources.length);
    let count = 0;
    for (const section of draft.sections)
      for (const claim of section.claims) {
        count += 1;
        expect(claim.sources.length).toBeGreaterThan(0);
        for (const id of claim.sources) expect(known.has(id)).toBe(true);
      }
    expect(count).toBeGreaterThan(0);
  });

  test('every rendered claim line ends with a reference the Sources list explains', async () => {
    const { draft } = await realisticDraft();
    const lines = claimLinesOf(draft.markdown);
    expect(lines.length).toBeGreaterThan(0);
    const known = new Set(draft.sources.map((source) => source.id));
    for (const line of lines) {
      const match = /\[([^\]]+)\]$/.exec(line);
      expect(match, `claim line without a reference: ${line}`).not.toBeNull();
      for (const id of (match?.[1] ?? '').split(',').map((item) => item.trim())) {
        expect(id).not.toBe('');
        expect(known.has(id)).toBe(true);
      }
    }
    // And every claim the structure holds is rendered, not just referenced.
    for (const section of draft.sections)
      for (const claim of section.claims)
        expect(draft.markdown).toContain(`- ${claim.text} [${claim.sources.join(', ')}]`);
  });
});

describe('determinism', () => {
  test('composing twice with identical input yields identical markdown', async () => {
    const { manifest } = await realisticDraft();
    const sources = await service.gather(projectId, manifest);
    const first = composeBrief({ manifest, sources, previous: null, at: AT });
    const second = composeBrief({ manifest, sources, previous: null, at: AT });
    expect(second.markdown).toBe(first.markdown);
    expect(second).toEqual(first);
  });

  test('rendering the structure again yields the same markdown', async () => {
    const { draft } = await realisticDraft();
    const { markdown: _omitted, ...structure } = draft;
    expect(renderBrief(structure)).toBe(draft.markdown);
  });
});

describe('change detection', () => {
  test('an unchanged source is named in unused and contributes no claim', async () => {
    await writeFixture('kitchen-log.md', KITCHEN_LOG);
    await writeFixture('dining-room-notes.md', DINING_NOTES);
    const manifest = manifestFor();
    const first = composeBrief({
      manifest,
      sources: await service.gather(projectId, manifest),
      previous: null,
      at: AT,
    });
    // Only the dining notes move on; the kitchen log already reported stands still.
    const revisedDining = `${DINING_NOTES}\nHang the new noticeboard by the door.`;
    await writeFixture('dining-room-notes.md', revisedDining);
    const second = composeBrief({
      manifest,
      sources: await service.gather(projectId, manifest),
      previous: first.markdown,
      at: AT,
    });
    const kitchenId = second.sources.find((source) => source.path === 'kitchen-log.md')?.id;
    expect(kitchenId).toBeDefined();
    expect(second.unused).toContain(kitchenId);
    for (const section of second.sections)
      for (const claim of section.claims) expect(claim.sources).not.toContain(kitchenId);
    expect(second.markdown).toContain('Unchanged since the previous brief');
    expect(second.markdown).toContain('kitchen-log.md');
  });

  test('an unreadable path is named in missing and the brief is still produced', async () => {
    await writeFixture('kitchen-log.md', KITCHEN_LOG);
    const manifest = manifestFor({ selection: ['kitchen-log.md', 'cellar-notes.md'] });
    const sources = await service.gather(projectId, manifest);
    expect(sources.map((source) => source.path)).toEqual(['kitchen-log.md']);
    const draft = composeBrief({ manifest, sources, previous: null, at: AT });
    expect(draft.missing).toEqual(['cellar-notes.md']);
    expect(draft.sections.length).toBeGreaterThan(0);
    expect(draft.markdown).toContain('cellar-notes.md could not be read');
  });
});

describe('change detection across runs', () => {
  test('a second run succeeds, names what the first already reported, and reports only what is new', async () => {
    await writeFixture('kitchen-log.md', KITCHEN_LOG);
    await writeFixture('dining-room-notes.md', DINING_NOTES);
    const manifest = manifestFor();
    const first = await service.run({ projectId, manifest, at: AT });
    // A line the first brief never reported arrives between the two runs.
    await writeFixture(
      'dining-room-notes.md',
      `${DINING_NOTES}\nHang the new noticeboard by the door.`,
    );
    // The run resolves the previous brief from its own destination, so the
    // recorded write matches the store's expectation instead of conflicting.
    const second = await service.run({ projectId, manifest, at: AT });
    expect(second.destination).toBe(first.destination);
    const kitchenId = second.draft.sources.find((source) => source.path === 'kitchen-log.md')?.id;
    expect(kitchenId).toBeDefined();
    expect(second.draft.unused).toContain(kitchenId);
    for (const section of second.draft.sections)
      for (const claim of section.claims) expect(claim.sources).not.toContain(kitchenId);
    expect(second.draft.markdown).toContain('Unchanged since the previous brief');
    expect(second.draft.markdown).toContain('kitchen-log.md');
    const reported = second.draft.sections.flatMap((section) =>
      section.claims.map((claim) => claim.text),
    );
    expect(reported).toContain('Hang the new noticeboard by the door.');
    for (const line of DINING_NOTES.split('\n')) expect(reported).not.toContain(line);
  });
});

describe('variants', () => {
  test('both variants share one structure under different labels', async () => {
    await writeFixture('front-desk-notes.md', FRONT_DESK_NOTES);
    await writeFixture('maintenance-notes.md', MAINTENANCE_NOTES);
    const selection = ['front-desk-notes.md', 'maintenance-notes.md'];
    const restaurant = manifestFor({
      variantId: 'restaurant-operations',
      scopeLabel: 'Weekly operations exports',
      outputLabel: 'Weekly operations brief',
      destination: 'weekly-operations-brief.md',
      selection,
    });
    const professional = manifestFor({
      variantId: 'professional-services',
      scopeLabel: 'Weekly brief sources',
      outputLabel: 'Weekly brief',
      destination: 'weekly-brief.md',
      selection,
    });
    const writer = vi.spyOn(store, 'writeRecorded');
    const restaurantRun = await service.run({
      projectId,
      manifest: restaurant,
      at: AT,
    });
    const professionalRun = await service.run({
      projectId,
      manifest: professional,
      at: AT,
    });

    // The section structure matches claim for claim; only the labels differ.
    expect(restaurantRun.draft.sections.map((section) => section.claims.length)).toEqual(
      professionalRun.draft.sections.map((section) => section.claims.length),
    );
    expect(restaurantRun.draft.sections.map((section) => section.heading)).not.toEqual(
      professionalRun.draft.sections.map((section) => section.heading),
    );
    expect(restaurantRun.draft.title).not.toBe(professionalRun.draft.title);
    expect(restaurantRun.draft.variantId).not.toBe(professionalRun.draft.variantId);

    // The writer options match, down to review; destinations and labels differ.
    expect(writer).toHaveBeenCalledTimes(2);
    const firstOptions = writer.mock.calls[0]?.[2];
    const secondOptions = writer.mock.calls[1]?.[2];
    expect(firstOptions).toMatchObject({ kind: 'weekly-brief', review: true });
    expect(secondOptions).toMatchObject({ kind: 'weekly-brief', review: true });
    expect(writer.mock.calls[0]?.[0]).toBe(projectId);
    expect(writer.mock.calls[1]?.[0]).toBe(projectId);
    expect(restaurantRun.destination).not.toBe(professionalRun.destination);
    expect(firstOptions?.label).not.toBe(secondOptions?.label);
  });
});

describe('the recorded write', () => {
  test('run performs exactly one recorded write with review, and nothing else', async () => {
    await writeFixture('kitchen-log.md', KITCHEN_LOG);
    await writeFixture('dining-room-notes.md', DINING_NOTES);
    const manifest = manifestFor();
    const historyBefore = store.state(projectId).history.length;
    const writer = vi.spyOn(store, 'writeRecorded');
    const result = await service.run({ projectId, manifest, at: AT });

    expect(writer).toHaveBeenCalledTimes(1);
    const call = writer.mock.calls[0];
    expect(call?.[0]).toBe(projectId);
    expect(call?.[1]).toHaveLength(1);
    expect(call?.[1][0]?.path).toBe('weekly-operations-brief.md');
    expect(call?.[1][0]?.text).toBe(result.draft.markdown);
    expect(call?.[1][0]?.expected).toBeNull();
    expect(call?.[2]).toMatchObject({
      kind: 'weekly-brief',
      review: true,
      label: 'Weekly operations brief',
    });
    expect(typeof call?.[2]?.sentence).toBe('string');

    // No other effect was recorded: one history entry, and the file holds it.
    expect(store.state(projectId).history).toHaveLength(historyBefore + 1);
    expect(typeof result.entryId).toBe('string');
    expect(await store.current(projectId, 'weekly-operations-brief.md')).toBe(
      result.draft.markdown,
    );
  });

  test('the expected digest is the hash of the previous draft, null on the first run', async () => {
    await writeFixture('kitchen-log.md', KITCHEN_LOG);
    await writeFixture('dining-room-notes.md', DINING_NOTES);
    const manifest = manifestFor();
    const writer = vi.spyOn(store, 'writeRecorded');
    await service.run({ projectId, manifest, at: AT });
    expect(writer.mock.calls[0]?.[1][0]?.expected).toBeNull();
    const previousText = await store.current(projectId, 'weekly-operations-brief.md');
    expect(previousText).not.toBeNull();
    await service.run({ projectId, manifest, at: AT });
    expect(writer).toHaveBeenCalledTimes(2);
    expect(writer.mock.calls[1]?.[1][0]?.expected).toBe(hash(previousText));
  });
});

describe('refusals', () => {
  test('explicit selected revisions replace configured fixture paths without changing the active manifest', async () => {
    await writeFixture('chosen.csv', 'item,count\nTables,7');
    await writeFixture('excluded.csv', 'Never include this line.');
    const manifest = manifestFor();
    const saved = structuredClone(manifest);
    const result = await service.run({
      projectId,
      manifest,
      at: AT,
      sources: [{ path: 'chosen.csv', sha: hash('item,count\nTables,7') }],
    });
    expect(result.draft.markdown).toContain('Tables,7');
    expect(result.draft.markdown).not.toContain('Never include');
    expect(result.draft.markdown).toContain(`SHA-256: ${hash('item,count\nTables,7')}`);
    expect(result.draft.missing).toEqual([]);
    expect(result.draft.sources.map((source) => source.path)).toEqual(['chosen.csv']);
    expect(manifest).toEqual(saved);
  });

  test('stale, absent, duplicate and escaping selected sources refuse before a recorded write', async () => {
    await writeFixture('chosen.csv', 'Current');
    const manifest = manifestFor();
    const writer = vi.spyOn(store, 'writeRecorded');
    const good = { path: 'chosen.csv', sha: hash('Current') };
    for (const sources of [
      [],
      [good, good],
      [{ ...good, sha: hash('old') }],
      [{ ...good, path: 'missing.csv' }],
      [{ ...good, path: '../escape.csv' }],
      [{ ...good, path: 'credentials.json' }],
      [{ ...good, path: 'weekly-operations-brief.md' }],
    ]) {
      await expect(service.run({ projectId, manifest, at: AT, sources })).rejects.toThrow();
    }
    expect(writer).not.toHaveBeenCalled();
  });

  test('source edits during composition are refused before the writer runs', async () => {
    await writeFixture('chosen.csv', 'Selected');
    const current = store.current.bind(store);
    let reads = 0;
    vi.spyOn(store, 'current').mockImplementation(async (id, name) => {
      if (name === 'chosen.csv' && ++reads === 2) await writeFixture(name, 'Changed');
      return current(id, name);
    });
    const writer = vi.spyOn(store, 'writeRecorded');
    await expect(
      service.run({
        projectId,
        manifest: manifestFor(),
        at: AT,
        sources: [{ path: 'chosen.csv', sha: hash('Selected') }],
      }),
    ).rejects.toMatchObject({ status: 409 });
    expect(writer).not.toHaveBeenCalled();
  });

  test('a staged manifest is refused before any write', async () => {
    await writeFixture('kitchen-log.md', KITCHEN_LOG);
    await writeFixture('dining-room-notes.md', DINING_NOTES);
    const manifest = manifestFor({ state: 'staged' });
    const historyBefore = store.state(projectId).history.length;
    const error = await fails(service.run({ projectId, manifest, at: AT }));
    expect(error.status).toBe(409);
    expect(store.state(projectId).history).toHaveLength(historyBefore);
    expect(await store.current(projectId, 'weekly-operations-brief.md')).toBeNull();
  });

  test('a manifest that is not ready is refused before any write', async () => {
    await writeFixture('kitchen-log.md', KITCHEN_LOG);
    await writeFixture('dining-room-notes.md', DINING_NOTES);
    const manifest = manifestFor({ ready: false });
    const historyBefore = store.state(projectId).history.length;
    const error = await fails(service.run({ projectId, manifest, at: AT }));
    expect(error.status).toBe(409);
    expect(store.state(projectId).history).toHaveLength(historyBefore);
    expect(await store.current(projectId, 'weekly-operations-brief.md')).toBeNull();
  });

  test('a destination that escapes the project is refused before any write', async () => {
    await writeFixture('kitchen-log.md', KITCHEN_LOG);
    await writeFixture('dining-room-notes.md', DINING_NOTES);
    const manifest = manifestFor({ destination: '../outside.md' });
    const historyBefore = store.state(projectId).history.length;
    const error = await fails(service.run({ projectId, manifest, at: AT }));
    expect(error).toBeInstanceOf(ApiError);
    expect(store.state(projectId).history).toHaveLength(historyBefore);
  });

  test('a concurrent edit to the destination conflicts instead of clobbering', async () => {
    await writeFixture('kitchen-log.md', KITCHEN_LOG);
    await writeFixture('dining-room-notes.md', DINING_NOTES);
    const manifest = manifestFor();
    const destination = 'weekly-operations-brief.md';
    const folder = store.state(projectId).project.folder;
    const original = store.writeRecorded.bind(store);
    let edited = false;
    vi.spyOn(store, 'writeRecorded').mockImplementation(async (id, inputs, options) => {
      // A person saves while the brief is being prepared: the write in flight
      // must conflict rather than overwrite their newer content.
      if (!edited) {
        edited = true;
        await fs.writeFile(
          path.join(folder, destination),
          'A person edited this file while the brief was being prepared.',
          'utf8',
        );
      }
      return original(id, inputs, options);
    });
    await expect(service.run({ projectId, manifest, at: AT })).rejects.toThrow(/changed since/);
    expect(await store.current(projectId, destination)).toBe(
      'A person edited this file while the brief was being prepared.',
    );
  });
});
