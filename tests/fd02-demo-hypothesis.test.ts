import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import type {
  CreateProspectDiscoveryInput,
  ProspectDiscoveryRecord,
} from '../shared/discovery.js';
import { DiscoveryService } from '../server/discovery/service.js';
import { Store } from '../server/store.js';

/**
 * FD02 / PD-03 acceptance rows: the distinguished demo hypothesis.
 *
 * The contract is three-fold and was previously untested by the fd02-* suites:
 *   1. exactly one `demoHypothesis` fact exists per record and is the record's
 *      hypothesisFactId; `addFact` refuses a second — by field or by label;
 *   2. `correctFact` refuses the hypothesis fact (`immutable_demo_hypothesis`);
 *      the only write path is `setHypothesisOutcome` (append-only outcomes are
 *      covered by fd02-discovery.test.ts);
 *   3. a stored record carrying a second demoHypothesis fact fails closed on
 *      load — the schema's exactly-one rule rejects it before it is exposed.
 */
const AT = '2026-09-19T12:00:00.000Z';
const LATER = '2026-09-19T13:00:00.000Z';
const operator = 'demo-hypothesis-operator';

const conversation: CreateProspectDiscoveryInput = {
  prospectName: 'Juniper Coffee',
  goals: ['Reduce the time spent assembling the weekly owner update.'],
  currentProcess: [
    {
      action: 'Copy sales and labor totals into a shared note.',
      actor: 'Shift manager',
      inputs: ['Point-of-sale export', 'Scheduling export'],
      outputs: ['Shared weekly note'],
      handoffs: ['Owner reviews the note on Monday'],
      painPoints: ['A missing export delays the review'],
    },
  ],
  hypothesis: {
    statement: 'A cited weekly brief could reduce manual collation.',
    workflowFamily: 'weekly-brief',
  },
  stage: 'discovery',
  personalizationLevel: 'account',
};

type StoredJson = Record<string, unknown>;
const storedFacts = (record: StoredJson) => record.facts as StoredJson[];

describe('the distinguished demo hypothesis (FD02 / PD-03)', () => {
  let root: string;
  let store: Store;
  let service: DiscoveryService;
  let sequence = 0;
  let clock = AT;

  beforeEach(async () => {
    clock = AT;
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'diomedes-fd02-demo-'));
    store = new Store(path.join(root, 'data'), path.join(root, 'projects'));
    await store.init();
    service = new DiscoveryService(store, {
      now: () => clock,
      id: (prefix) => `${prefix}${++sequence}`,
    });
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  const locked = <T>(action: () => Promise<T>) => service.locked(action);
  const recordPath = (record: ProspectDiscoveryRecord) =>
    path.join(root, 'data', 'prospects', 'discovery', `${record.prospectId}.json`);

  test('exactly one demo hypothesis exists; a second is refused by field or by label', async () => {
    const created = await locked(() => service.createAndSelect(operator, conversation));

    const demoFacts = created.facts.filter((fact) => fact.field === 'demoHypothesis');
    expect(demoFacts).toHaveLength(1);
    expect(created.hypothesisFactId).toBe(demoFacts[0]?.id);
    expect(demoFacts[0]?.provenance.class).toBe('hypothesized');

    await expect(
      locked(() =>
        service.addFact(operator, {
          field: 'demoHypothesis',
          label: 'Another hypothesis',
          value: 'A second guess.',
          provenance: { class: 'hypothesized', sourceFactIds: [] },
        }),
      ),
    ).rejects.toMatchObject({
      status: 409,
      details: { code: 'invalid_discovery_fact' },
      message: expect.stringMatching(/one demo hypothesis/i),
    });

    // The label alone is enough to refuse — a caller cannot rename around it.
    await expect(
      locked(() =>
        service.addFact(operator, {
          field: 'growthHypothesis',
          label: 'Demo hypothesis',
          value: 'Renamed second guess.',
          provenance: { class: 'hypothesized', sourceFactIds: [] },
        }),
      ),
    ).rejects.toMatchObject({
      status: 409,
      details: { code: 'invalid_discovery_fact' },
      message: expect.stringMatching(/one demo hypothesis/i),
    });

    // The record itself is untouched by either refused add.
    const after = await service.active(operator);
    expect(after?.facts.filter((fact) => fact.field === 'demoHypothesis')).toHaveLength(1);
  });

  test('the demo hypothesis is immutable under correction; the outcome log is the write path', async () => {
    const created = await locked(() => service.createAndSelect(operator, conversation));

    await expect(
      locked(() =>
        service.correctFact(operator, {
          factId: created.hypothesisFactId,
          value: 'A rewritten hypothesis.',
          provenance: { class: 'reported', reportedBy: 'consultant' },
        }),
      ),
    ).rejects.toMatchObject({
      status: 409,
      details: { code: 'immutable_demo_hypothesis' },
      message: expect.stringMatching(/record its outcome/i),
    });

    // The intended write path still works and leaves the fact itself unchanged.
    clock = LATER;
    const updated = await locked(() =>
      service.setHypothesisOutcome(operator, { outcome: 'confirmed', checkedAt: LATER }),
    );
    const demo = updated.facts.find((fact) => fact.id === updated.hypothesisFactId);
    expect(demo?.value).toBe('A cited weekly brief could reduce manual collation.');
    expect(demo?.replacesFactId).toBeNull();
    expect(updated.hypothesisOutcomes).toHaveLength(2);
  });

  test('a forged second demo hypothesis on disk fails closed on load', async () => {
    const created = await locked(() => service.createAndSelect(operator, conversation));
    const demoFact = created.facts.find((fact) => fact.id === created.hypothesisFactId);
    expect(demoFact).toBeTruthy();

    const stored: StoredJson = JSON.parse(await fs.readFile(recordPath(created), 'utf8'));
    storedFacts(stored).push({ ...demoFact, id: 'forged-second-hypothesis' });
    await fs.writeFile(recordPath(created), JSON.stringify(stored));

    await expect(service.active(operator)).rejects.toMatchObject({
      status: 409,
      details: { code: 'invalid_discovery_record' },
    });
  });
});
