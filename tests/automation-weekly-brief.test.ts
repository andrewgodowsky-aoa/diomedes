/**
 * Automations Milestone A, slice A3: the weekly brief as a harness capability.
 *
 * These drive the real harness host, RunService and Store over a temporary
 * folder, with the host's two narrow questions — which configuration revision
 * was pinned, and where this business writes now — answered by a fixture.
 * Every company, file and number here is invented.
 */
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { ConfigurationManifest } from '../shared/configuration.js';
import type { BriefTarget } from '../shared/workspaces.js';
import type { HarnessRun, Json } from '../shared/harness.js';
import { Store } from '../server/store.js';
import { createHarnessHost, type HarnessHost } from '../server/harness/host.js';
import { localHarnessPrincipal } from '../server/harness/bridge.js';
import {
  SAVE_STEP,
  WEEKLY_BRIEF,
  WEEKLY_BRIEF_ENGINE,
  type WeeklyBriefInput,
} from '../server/harness/capabilities/weekly-brief.js';

let root: string;
let store: Store;
let host: HarnessHost;
let projectId: string;
let folder: string;
let manifests: ConfigurationManifest[];
let target: BriefTarget | 'not-a-member';

const DESTINATION = 'Briefs/weekly-brief.md';

function manifest(revision: number, selection: string[], label: string): ConfigurationManifest {
  return {
    v: 1,
    owner: { kind: 'organization', organizationId: 'org_fern', tenantId: 'tenant_fern' },
    organizationId: 'org_fern',
    tenantId: 'tenant_fern',
    revision,
    digest: `sha256:${String(revision).repeat(64).slice(0, 64)}`,
    state: 'active',
    readiness: { ready: true, blocking: [], degraded: [], degradedPlan: null, checkedAt: '' },
    stagedAt: '',
    stagedBy: 'person_owner',
    activatedAt: '',
    activatedBy: 'person_owner',
    activationId: null,
    supersededAt: null,
    failureReason: null,
    proposal: {
      template: { id: 'diomedes.weekly-brief', version: '1.0.0', variantId: 'fixture' },
      contextScopes: [
        {
          id: 'approved-files',
          label: 'Approved exports',
          kind: 'approved-files',
          selection,
          provenance: { source: 'default', why: '' },
        },
      ],
      expectedOutputs: [
        {
          id: 'weekly-brief',
          label: `${label} — fixture`,
          artifact: 'document',
          destination: DESTINATION,
          reviewedBy: 'person',
          provenance: { source: 'default', why: '' },
        },
      ],
      unresolved: [],
    },
  } as unknown as ConfigurationManifest;
}

async function open() {
  store = new Store(path.join(root, 'data'), path.join(root, 'projects'));
  await store.init();
  host = createHarnessHost({
    store,
    dataDir: store.dataDir,
    weeklyBrief: {
      manifest: (organizationId, revision, digest) =>
        manifests.find(
          (item) =>
            item.organizationId === organizationId &&
            item.revision === revision &&
            item.digest === digest,
        ) ?? null,
      target: async () => {
        if (target === 'not-a-member') throw new Error('That business workspace does not exist here.');
        return target;
      },
    },
  });
  await host.init();
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'diomedes-brief-capability-'));
  folder = path.join(root, 'folders', 'books');
  await fs.mkdir(folder, { recursive: true });
  await open();
  projectId = (await store.createProject('Company books', folder)).id;
  manifests = [manifest(1, ['exports/north.csv'], 'North brief')];
  target = {
    ready: true,
    organizationId: 'org_fern',
    tenantId: 'tenant_fern',
    projectId,
    projectName: 'Company books',
  };
  await fs.mkdir(path.join(folder, 'exports'), { recursive: true });
  await fs.writeFile(path.join(folder, 'exports', 'north.csv'), 'site,jobs\nNorth,4\n');
  await fs.writeFile(path.join(folder, 'exports', 'south.csv'), 'site,jobs\nSouth,9\n');
});

afterEach(async () => {
  await host.close();
  await fs.rm(root, { recursive: true, force: true });
});

const input = (revision = 1, overrides: Partial<WeeklyBriefInput> = {}): WeeklyBriefInput => {
  const pinned = manifests.find((item) => item.revision === revision)!;
  return {
    v: 1,
    occurrenceId: `O-${revision}`,
    organizationId: 'org_fern',
    tenantId: 'tenant_fern',
    projectId,
    configuration: { revision, digest: pinned.digest },
    destination: DESTINATION,
    selection: [...pinned.proposal.contextScopes[0]!.selection],
    chosen: null,
    at: '2026-09-24T09:00:00.000Z',
    ...overrides,
  };
};

async function start(runId: string, pinned: WeeklyBriefInput, during?: () => void) {
  return store.locked(async () => {
    const session = await host.bridge.start(
      projectId,
      null,
      WEEKLY_BRIEF.id,
      'Prepare the brief. Nothing is sent.',
      localHarnessPrincipal(projectId),
      undefined,
      { runId, input: pinned as unknown as Json },
    );
    // Whatever happens here happens after admission and before the run drives.
    during?.();
    return session;
  });
}

async function settled(runId: string): Promise<HarnessRun> {
  for (let i = 0; i < 400; i++) {
    const run = await host.runs.get(runId);
    if (['completed', 'failed', 'cancelled', 'reconcile_required'].includes(run.state)) {
      await host.bridge.flush();
      return run;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`run ${runId} did not settle`);
}

const draft = () => fs.readFile(path.join(folder, DESTINATION), 'utf8');
const briefEntries = () => store.state(projectId).history.filter((entry) => entry.kind === 'weekly-brief');

describe('the weekly brief capability', () => {
  test('saves a source-linked draft for review through RunService, with no model call', async () => {
    const session = await start('R-brief-ok', input());
    const run = await settled('R-brief-ok');
    expect(run.state).toBe('completed');
    expect(run.used.modelCalls).toBe(0);
    expect(run.budget.modelCalls).toBe(0);
    expect(run.steps.map((step) => step.intent.kind)).toEqual(['tool', 'tool', 'tool']);
    // Truthful attribution: a Diomedes procedure, never a model (decision 8).
    for (const step of run.steps) expect(step.origin?.mode).toBe('application');
    const state = store.state(projectId);
    const saved = state.sessions.find((item) => item.id === session.id)!;
    expect(saved.engine).toMatchObject({ name: WEEKLY_BRIEF_ENGINE, model: null });
    expect(saved.origin?.mode).toBe('application');
    expect(saved.state).toBe('done');
    expect(state.tasks.find((task) => task.id === session.taskId)?.name).toBe(WEEKLY_BRIEF.label);
    expect(await draft()).toContain('North,4');
    const [entry] = briefEntries();
    expect(entry).toMatchObject({ taskId: session.taskId, sessionId: session.id });
    // Saved for review: a waiting Change the person keeps or undoes (D2).
    expect(state.changes.find((change) => change.entryId === entry!.id)?.state).toBe('waiting');
    // D2: the save asks for no approval and creates no Need.
    expect(state.needs).toEqual([]);
  });

  test('a missing source stops the run before anything is written', async () => {
    manifests = [manifest(1, ['exports/north.csv', 'exports/missing.csv'], 'North brief')];
    await start('R-brief-missing', input());
    const run = await settled('R-brief-missing');
    expect(run.state).toBe('failed');
    expect(run.failure?.name).toBe('waiting_for_data');
    expect(run.failure?.message).toContain('exports/missing.csv');
    // The read step keeps the missing name as durable evidence.
    expect(run.steps[0]!.output).toMatchObject({ missing: ['exports/missing.csv'] });
    expect(run.steps.some((step) => step.intent.stepId === SAVE_STEP)).toBe(false);
    await expect(draft()).rejects.toThrow();
    expect(briefEntries()).toEqual([]);
  });

  test('the pinned revision is kept after a later activation', async () => {
    await start('R-brief-pinned', input(1), () => {
      // Activated while the admitted run has not driven yet.
      manifests.push(manifest(2, ['exports/south.csv'], 'South brief'));
    });
    const run = await settled('R-brief-pinned');
    expect(run.state).toBe('completed');
    const text = await draft();
    expect(text).toContain('# North brief');
    expect(text).toContain('North,4');
    expect(text).not.toContain('South');
  });

  test('an output project that is no longer bound gets no write', async () => {
    await start('R-brief-unbound', input(), () => {
      target = {
        ready: false,
        code: 'no-output-project',
        message: 'Choose the project Fernbrook Joinery writes into.',
      };
    });
    const run = await settled('R-brief-unbound');
    expect(run.state).toBe('failed');
    await expect(draft()).rejects.toThrow();
    expect(briefEntries()).toEqual([]);
  });

  test('membership is rechecked at the write', async () => {
    await start('R-brief-revoked', input(), () => {
      target = 'not-a-member';
    });
    const run = await settled('R-brief-revoked');
    expect(run.state).toBe('failed');
    await expect(draft()).rejects.toThrow();
  });

  test('a different project is never substituted', async () => {
    await start('R-brief-moved', input(), () => {
      target = { ...(target as Extract<BriefTarget, { ready: true }>), projectId: 'elsewhere' };
    });
    expect((await settled('R-brief-moved')).state).toBe('failed');
    await expect(draft()).rejects.toThrow();
  });

  test('a write replayed after a crash returns the same History entry', async () => {
    await start('R-brief-crash', input());
    const done = await settled('R-brief-crash');
    const entryId = (done.result as { entryId: string }).entryId;
    await host.close();

    // Rewind the durable run to the moment after the write and before its
    // step committed: the save step is running and the run has no result.
    const file = path.join(store.dataDir, 'projects', projectId, 'harness', 'runs', 'R-brief-crash.json');
    const saved = JSON.parse(await fs.readFile(file, 'utf8')) as HarnessRun;
    const cut = saved.events.findIndex(
      (event) => event.type === 'step.succeeded' && event.stepId === SAVE_STEP,
    );
    saved.events = saved.events.slice(0, cut);
    saved.lastSeq = saved.events.length;
    const save = saved.steps.find((step) => step.intent.stepId === SAVE_STEP)!;
    Object.assign(save, { state: 'running', output: null, outputHash: null, endedAt: null });
    Object.assign(saved, { state: 'running', result: null });
    await fs.writeFile(file, JSON.stringify(saved, null, 2));

    await open();
    const recovered = await settled('R-brief-crash');
    expect(recovered.state).toBe('completed');
    expect((recovered.result as { entryId: string }).entryId).toBe(entryId);
    expect(briefEntries()).toHaveLength(1);
  });
});
