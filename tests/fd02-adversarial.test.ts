import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type {
  CreateProspectDiscoveryInput,
  FactProvenance,
  ProspectDiscoveryRecord,
} from '../shared/discovery.js';
import { DiscoveryService } from '../server/discovery/service.js';
import { Store } from '../server/store.js';

const operator = 'adversarial-operator';
const at = '2026-09-19T12:00:00.000Z';
const conversation: CreateProspectDiscoveryInput = {
  prospectName: 'Fixture Workshop',
  goals: ['Reduce missed handoffs'],
  currentProcess: [
    {
      action: 'Read orders',
      actor: 'Coordinator',
      inputs: ['Order list'],
      outputs: ['Schedule'],
      handoffs: ['Team receives schedule'],
      painPoints: ['Late handoffs'],
    },
  ],
  hypothesis: { statement: 'A shared schedule may help', workflowFamily: 'scheduling' },
};
const forgedEvidence = {
  kind: 'approved-file' as const,
  projectId: 'foreign-project',
  path: 'unapproved.csv',
  sha: 'a'.repeat(64),
  historyEntryId: 'nonexistent-history',
};
const publicBrief = JSON.stringify({
  business: { name: 'Fixture Workshop', category: 'Workshop', city: 'Example' },
  locations: [],
  services: [],
  namedSoftware: [],
  observations: [],
  sources: [{ url: 'https://example.com', retrievedAt: '2026-09-18' }],
  hypothesis: { workflowFamily: 'scheduling' },
});
type StoredJson = Record<string, unknown>;
const storedFacts = (record: StoredJson) => record.facts as StoredJson[];

describe('FD02 independent adversarial persistence and service boundaries', () => {
  let root: string;
  let store: Store;
  let service: DiscoveryService;
  let sequence: number;
  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'diomedes-fd02-adversarial-'));
    store = new Store(path.join(root, 'data'), path.join(root, 'projects'));
    await store.init();
    sequence = 0;
    service = new DiscoveryService(store, {
      now: () => at,
      id: (prefix) => `${prefix}${++sequence}`,
    });
  });
  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });
  const locked = <T>(action: () => Promise<T>) => service.locked(action);
  const recordPath = (record: ProspectDiscoveryRecord) =>
    path.join(root, 'data', 'prospects', 'discovery', `${record.prospectId}.json`);
  const selectionPath = () =>
    path.join(
      root,
      'data',
      'prospects',
      'operators',
      `${createHash('sha256').update(operator).digest('hex')}.json`,
    );
  const create = () => locked(() => service.createAndSelect(operator, conversation));
  const overwrite = async (
    record: ProspectDiscoveryRecord,
    mutate: (value: StoredJson) => void,
  ) => {
    const value: StoredJson = JSON.parse(await fs.readFile(recordPath(record), 'utf8'));
    mutate(value);
    await fs.writeFile(recordPath(record), JSON.stringify(value));
  };

  test.each([
    [
      'facts collection replaced with a string',
      (record: StoredJson) => {
        record.facts = 'trusted';
      },
    ],
    [
      'unknown provenance class',
      (record: StoredJson) => {
        storedFacts(record)[0]!.provenance = { class: 'approved-by-model' };
      },
    ],
    [
      'dangling current-process reference',
      (record: StoredJson) => {
        (record.currentProcess as StoredJson[])[0]!.actionFactId = 'missing-fact';
      },
    ],
    [
      'duplicate fact identity',
      (record: StoredJson) => {
        storedFacts(record).push({ ...storedFacts(record)[0], value: 'Conflicting copy' });
      },
    ],
    [
      'correction cycle',
      (record: StoredJson) => {
        storedFacts(record)[0]!.replacesFactId = storedFacts(record)[1]!.id;
        storedFacts(record)[1]!.replacesFactId = storedFacts(record)[0]!.id;
      },
    ],
    [
      'impossible recorded timestamp',
      (record: StoredJson) => {
        storedFacts(record)[0]!.recordedAt = 'not-a-date';
      },
    ],
  ])('rejects stored %s before exposing an active record', async (_label, mutate) => {
    const record = await create();
    await overwrite(record, mutate);
    await expect(service.active(operator)).rejects.toBeDefined();
  });

  test('a forged observed fact on disk cannot bypass the evidence verifier on reload', async () => {
    const record = await create();
    await overwrite(record, (value) => {
      storedFacts(value)[0]!.provenance = { class: 'observed', evidence: forgedEvidence };
    });
    const verify = vi.fn(async () => false);
    const restarted = new DiscoveryService(store, { verifyObservedEvidence: verify });
    await expect(restarted.active(operator)).rejects.toBeDefined();
    // Refusing the corrupted provenance before consulting evidence is also safe.
    if (verify.mock.calls.length)
      expect(verify).toHaveBeenCalledWith({
        operatorId: operator,
        prospectId: record.prospectId,
        evidence: forgedEvidence,
      });
  });

  test('a forged foreign-operator selection cannot reveal another operator record', async () => {
    const own = await create();
    const foreign = await locked(() => service.createAndSelect('foreign-operator', conversation));
    await fs.writeFile(
      selectionPath(),
      JSON.stringify({
        v: 1,
        operatorId: operator,
        activeProspectId: foreign.prospectId,
        selectedAt: at,
      }),
    );
    await expect(service.active(operator)).rejects.toBeDefined();
    await expect(locked(() => service.select(operator, foreign.prospectId))).rejects.toBeDefined();
    expect(JSON.parse(await fs.readFile(recordPath(own), 'utf8')).operatorId).toBe(operator);
  });

  test('stale selection and stale fact corrections cannot target a newly selected prospect', async () => {
    const old = await create();
    const current = await locked(() =>
      service.createAndSelect(operator, { ...conversation, prospectName: 'Other prospect' }),
    );
    await expect(service.assertActive(operator, old.prospectId)).rejects.toBeDefined();
    await expect(
      locked(() =>
        service.correctFact(operator, {
          factId: old.goalFactIds[0]!,
          value: 'A stale editor changes the wrong prospect',
          provenance: { class: 'reported', reportedBy: 'owner' },
        }),
      ),
    ).rejects.toBeDefined();
    expect(await service.active(operator)).toEqual(current);
  });

  test('forged observed add and correction both invoke the scope-bound verifier and preserve the record when refused', async () => {
    const record = await create();
    const verify = vi.fn(async () => false);
    const guarded = new DiscoveryService(store, { verifyObservedEvidence: verify });
    const provenance: FactProvenance = { class: 'observed', evidence: forgedEvidence };
    await expect(
      locked(() =>
        guarded.addFact(operator, {
          field: 'evidence',
          label: 'Observation',
          value: 'Forged',
          provenance,
        }),
      ),
    ).rejects.toBeDefined();
    await expect(
      locked(() =>
        guarded.correctFact(operator, {
          factId: record.goalFactIds[0]!,
          value: 'Forged',
          provenance,
        }),
      ),
    ).rejects.toBeDefined();
    expect(verify).toHaveBeenCalledTimes(2);
    expect(verify).toHaveBeenNthCalledWith(1, {
      operatorId: operator,
      prospectId: record.prospectId,
      evidence: forgedEvidence,
    });
    expect(verify).toHaveBeenNthCalledWith(2, {
      operatorId: operator,
      prospectId: record.prospectId,
      evidence: forgedEvidence,
    });
    expect(await service.active(operator)).toEqual(record);
  });

  test('evidence verifier failure is not converted into an approved observation', async () => {
    const record = await create();
    const guarded = new DiscoveryService(store, {
      verifyObservedEvidence: async () => {
        throw new Error('receipt store unavailable');
      },
    });
    await expect(
      locked(() =>
        guarded.addFact(operator, {
          field: 'evidence',
          label: 'Observation',
          value: 'Forged',
          provenance: { class: 'observed', evidence: forgedEvidence },
        }),
      ),
    ).rejects.toThrow('receipt store unavailable');
    expect(await service.active(operator)).toEqual(record);
  });

  test('a foreign operator is refused before evidence verification can run under the record owner identity', async () => {
    const record = await create();
    const verify = vi.fn(async () => true);
    const guarded = new DiscoveryService(store, { verifyObservedEvidence: verify });
    await locked(() =>
      guarded.addFact(operator, {
        field: 'approved-observation',
        label: 'Observation',
        value: 'Valid fixture evidence',
        provenance: { class: 'observed', evidence: forgedEvidence },
      }),
    );
    verify.mockClear();
    await expect(
      locked(() => guarded.select('foreign-operator', record.prospectId)),
    ).rejects.toBeDefined();
    expect(verify).not.toHaveBeenCalled();
  });

  test('a correction cannot invent a source fact from another prospect', async () => {
    const first = await create();
    const second = await create();
    await expect(
      locked(() =>
        service.correctFact(operator, {
          factId: second.goalFactIds[0]!,
          value: 'Unsupported inference',
          provenance: { class: 'hypothesized', sourceFactIds: [first.goalFactIds[0]!] },
        }),
      ),
    ).rejects.toBeDefined();
    expect(await service.active(operator)).toEqual(second);
  });

  test('stale corrections and public transition replay cannot fork correction history', async () => {
    await create();
    const imported = await locked(() => service.importBrief(operator, 'brief.json', publicBrief));
    const fact = imported.facts.find((value) => value.provenance.class === 'public')!;
    const corrected = await locked(() =>
      service.transitionPublicFact(operator, {
        factId: fact.id,
        to: 'unknown',
        reason: 'Owner disputes this',
      }),
    );
    await expect(
      locked(() =>
        service.transitionPublicFact(operator, {
          factId: fact.id,
          to: 'reported',
          reportedBy: 'owner',
        }),
      ),
    ).rejects.toBeDefined();
    await expect(
      locked(() =>
        service.correctFact(operator, {
          factId: fact.id,
          value: 'Stale correction',
          provenance: { class: 'reported', reportedBy: 'owner' },
        }),
      ),
    ).rejects.toBeDefined();
    expect(await service.active(operator)).toEqual(corrected);
  });

  test('public confirmation cannot be used to launder a later observed claim into the same fact lineage', async () => {
    await create();
    const imported = await locked(() => service.importBrief(operator, 'brief.json', publicBrief));
    const fact = imported.facts.find((value) => value.provenance.class === 'public')!;
    const confirmed = await locked(() =>
      service.transitionPublicFact(operator, {
        factId: fact.id,
        to: 'reported',
        reportedBy: 'owner',
      }),
    );
    const guarded = new DiscoveryService(store, { verifyObservedEvidence: async () => true });
    await expect(
      locked(() =>
        guarded.correctFact(operator, {
          factId: confirmed.facts.at(-1)!.id,
          value: 'Different observed evidence',
          provenance: { class: 'observed', evidence: forgedEvidence },
        }),
      ),
    ).rejects.toBeDefined();
    expect(await service.active(operator)).toEqual(confirmed);
  });

  test('service-level provenance resource limits hold even without the HTTP parser', async () => {
    const record = await create();
    await expect(
      locked(() =>
        service.addFact(operator, {
          field: 'uncertainty',
          label: 'Uncertainty',
          value: null,
          provenance: { class: 'unknown', reason: 'x'.repeat(501) },
        }),
      ),
    ).rejects.toBeDefined();
    expect(await service.active(operator)).toEqual(record);
  });
});
