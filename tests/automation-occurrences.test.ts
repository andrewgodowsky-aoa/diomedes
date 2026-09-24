/**
 * Automations Milestone A, slice A2: the occurrence store.
 *
 * One versioned file per organization, replay by command identity with a 409
 * for a changed request, restart recovery of an admission left half-done, and
 * no pruning: history is evidence (decision 10). Every id here is invented.
 */
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { HarnessRun } from '../shared/harness.js';
import type { TriggerOccurrence } from '../shared/automations.js';
import { AutomationOccurrences, occurrenceIdFor, runIdFor } from '../server/automations.js';

let root: string;
let store: AutomationOccurrences;
const file = (organizationId: string) =>
  path.join(root, 'workspaces', 'automations', `${organizationId}.json`);

const occurrence = (
  commandId: string,
  admission: TriggerOccurrence['admission'] = { state: 'admitting', runId: runIdFor(occurrenceIdFor('org_a', commandId)) },
  organizationId = 'org_a',
): TriggerOccurrence => ({
  v: 1,
  id: occurrenceIdFor(organizationId, commandId),
  automationId: `brief:${organizationId}`,
  organizationId,
  tenantId: `tenant_${organizationId}`,
  trigger: { kind: 'manual', commandId, payloadDigest: `sha256:${'0'.repeat(64)}`, requestedBy: 'person_a' },
  configuration: { revision: 1, digest: 'sha256:x' },
  target: { projectId: 'P1', projectName: 'Books' },
  sources: null,
  observedAt: '2026-09-24T09:00:00.000Z',
  admission,
});

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'diomedes-occurrences-'));
  store = new AutomationOccurrences(root);
  await store.init();
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe('identity', () => {
  test('the same command in the same organization always names the same occurrence and run', () => {
    expect(occurrenceIdFor('org_a', 'c1')).toBe(occurrenceIdFor('org_a', 'c1'));
    expect(occurrenceIdFor('org_a', 'c1')).not.toBe(occurrenceIdFor('org_b', 'c1'));
    expect(occurrenceIdFor('org_a', 'c1')).toMatch(/^O-[a-f0-9]{32}$/);
    expect(runIdFor(occurrenceIdFor('org_a', 'c1'))).toMatch(/^R-brief-[a-f0-9]{24}$/);
  });
});

describe('the versioned file', () => {
  test('is written in its envelope and read back after a restart', async () => {
    await store.put(occurrence('c1'));
    await store.put(occurrence('c2'));
    const stored = JSON.parse(await fs.readFile(file('org_a'), 'utf8'));
    expect(stored).toMatchObject({ v: 1, organizationId: 'org_a' });
    expect(stored.occurrences).toHaveLength(2);
    const reopened = new AutomationOccurrences(root);
    await reopened.init();
    expect(reopened.list('org_a').map((item) => item.trigger.commandId)).toEqual(['c1', 'c2']);
    expect(reopened.list('org_b')).toEqual([]);
  });

  test('replacing an occurrence by id keeps every other one; nothing is ever pruned', async () => {
    for (let i = 0; i < 60; i++) await store.put(occurrence(`c${i}`));
    await store.put(
      occurrence('c7', { state: 'refused', code: 'project_busy', reason: 'Busy.', at: '2026-09-24T09:01:00.000Z' }),
    );
    const listed = store.list('org_a');
    expect(listed).toHaveLength(60);
    expect(listed[7]!.admission.state).toBe('refused');
  });

  test('a file from another version is refused and left alone', async () => {
    await fs.mkdir(path.dirname(file('org_new')), { recursive: true });
    const foreign = JSON.stringify({ v: 2, organizationId: 'org_new', occurrences: [], extra: true });
    await fs.writeFile(file('org_new'), foreign);
    await store.put(occurrence('c1'));
    const reopened = new AutomationOccurrences(root);
    await reopened.init();
    expect(() => reopened.list('org_new')).toThrow(/another version/);
    await expect(reopened.put(occurrence('c9', undefined, 'org_new'))).rejects.toThrow(/another version/);
    expect(await fs.readFile(file('org_new'), 'utf8')).toBe(foreign);
    // Every other organization keeps working.
    expect(reopened.list('org_a')).toHaveLength(1);
  });

  test('an organization id that is not a plain name never reaches a path', async () => {
    await expect(store.put(occurrence('c1', undefined, '../escape'))).rejects.toThrow(/does not exist/);
  });
});

describe('replay by command identity', () => {
  test('the same command and request returns the recorded occurrence', async () => {
    const saved = await store.put(occurrence('c1'));
    expect(store.replay('org_a', 'c1', saved.trigger.payloadDigest)).toEqual(saved);
    expect(store.replay('org_a', 'c2', saved.trigger.payloadDigest)).toBeUndefined();
  });

  test('the same command with a different request is a 409', async () => {
    await store.put(occurrence('c1'));
    expect(() => store.replay('org_a', 'c1', `sha256:${'1'.repeat(64)}`)).toThrow(
      expect.objectContaining({ status: 409, details: expect.objectContaining({ code: 'automation_command_conflict' }) }),
    );
  });
});

describe('restart recovery', () => {
  const run = (id: string): HarnessRun =>
    ({ id, projectId: 'P1', taskId: 'T1', sessionId: 'S1' }) as HarnessRun;

  test('admitting becomes admitted when its run exists, refused when it does not', async () => {
    const found = occurrence('with-run');
    const lost = occurrence('without-run');
    await store.put(found);
    await store.put(lost);
    const settled = await store.recover(async (item) =>
      item.id === found.id ? run((item.admission as { runId: string }).runId) : null,
    );
    expect(settled).toBe(2);
    const [admitted, refused] = store.list('org_a');
    expect(admitted!.admission).toMatchObject({ state: 'admitted', taskId: 'T1', sessionId: 'S1' });
    expect(refused!.admission).toMatchObject({ state: 'refused', code: 'interrupted_before_start' });
  });

  test('settled occurrences are never revisited: a refusal is not revived', async () => {
    await store.put(
      occurrence('done', { state: 'refused', code: 'project_busy', reason: 'Busy.', at: '2026-09-24T09:01:00.000Z' }),
    );
    let asked = 0;
    expect(
      await store.recover(async () => {
        asked += 1;
        return run('R-x');
      }),
    ).toBe(0);
    expect(asked).toBe(0);
    expect(store.list('org_a')[0]!.admission.state).toBe('refused');
  });
});
