import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  discoveryProspectName,
  parseProspectResearchBriefDocument,
  type CreateProspectDiscoveryInput,
} from '../shared/discovery.js';
import { DiscoveryService } from '../server/discovery/service.js';
import { Store } from '../server/store.js';

const AT = '2026-09-19T12:00:00.000Z';
const LATER = '2026-09-19T13:00:00.000Z';

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
      timing: '45 minutes each Monday',
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

const brief = {
  business: {
    name: 'Juniper Coffee',
    category: 'Cafe',
    city: 'Durham',
    publicBusinessContact: {
      phone: '+1 919 555 0100',
      email: 'hello@juniper.example',
      website: 'https://juniper.example',
    },
  },
  locations: [{ name: 'Ninth Street', city: 'Durham', url: 'https://juniper.example/locations' }],
  services: [{ label: 'Catering', url: 'https://juniper.example/catering' }],
  namedSoftware: [{ label: 'Toast', url: 'https://juniper.example/ordering' }],
  sources: [
    { url: 'https://juniper.example', retrievedAt: '2026-09-18' },
    { url: 'https://juniper.example/locations', retrievedAt: '2026-09-18' },
    { url: 'https://juniper.example/catering', retrievedAt: '2026-09-18' },
    { url: 'https://juniper.example/ordering', retrievedAt: '2026-09-18' },
  ],
  observations: [{ text: 'The business publishes a catering menu.', source: 2 }],
  hypothesis: { workflowFamily: 'weekly-brief', variantId: 'restaurant-operations' },
};

describe('Prospect Research Brief parsing', () => {
  test('accepts strict JSON and Markdown front matter without making a network request', () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network forbidden'));
    const json = parseProspectResearchBriefDocument('brief.json', JSON.stringify(brief));
    const markdown = parseProspectResearchBriefDocument(
      'brief.md',
      `---\n${JSON.stringify(brief, null, 2)}\n---\n# Research notes`,
    );

    expect(json).toEqual(brief);
    expect(markdown).toEqual(brief);
    expect(fetch).not.toHaveBeenCalled();
    fetch.mockRestore();
  });

  test('accepts data-only YAML front matter', () => {
    const parsed = parseProspectResearchBriefDocument(
      'brief.md',
      `---
business:
  name: Juniper Coffee
  category: Cafe
  city: Durham
locations:
  - name: Ninth Street
    city: Durham
    url: https://juniper.example/locations
services:
  - label: Catering
    url: https://juniper.example/catering
namedSoftware:
  - label: Toast
    url: https://juniper.example/ordering
sources:
  - url: https://juniper.example
    retrievedAt: 2026-09-18
  - url: https://juniper.example/locations
    retrievedAt: 2026-09-18
  - url: https://juniper.example/catering
    retrievedAt: 2026-09-18
  - url: https://juniper.example/ordering
    retrievedAt: 2026-09-18
observations:
  - text: The business publishes a catering menu.
    source: 2
hypothesis:
  workflowFamily: weekly-brief
  variantId: restaurant-operations
---
# Notes`,
    );

    expect(parsed.business.name).toBe('Juniper Coffee');
    expect(parsed.observations[0]).toEqual({
      text: 'The business publishes a catering menu.',
      source: 2,
    });
  });

  test.each([
    [
      'non-http source',
      { ...brief, sources: [{ url: 'file:///secrets', retrievedAt: '2026-09-18' }] },
    ],
    [
      'credential-bearing source',
      { ...brief, sources: [{ url: 'https://user:pass@example.com', retrievedAt: '2026-09-18' }] },
    ],
    [
      'impossible retrieval date',
      { ...brief, sources: [{ url: 'https://juniper.example', retrievedAt: '2026-02-31' }] },
    ],
  ])('refuses a %s', (_label, value) => {
    expect(() => parseProspectResearchBriefDocument('brief.json', JSON.stringify(value))).toThrow();
  });

  test.each([
    ['person-shaped key', { ...brief, ownerName: 'A Person' }, 'ownerName'],
    [
      'observation without a source',
      { ...brief, observations: [{ text: 'No citation' }] },
      'observations.0.source',
    ],
    [
      'nested unknown key',
      { ...brief, business: { ...brief.business, decisionMaker: 'A Person' } },
      'business.decisionMaker',
    ],
  ])('refuses a %s and names the rejected key', (_label, value, key) => {
    expect(() => parseProspectResearchBriefDocument('brief.json', JSON.stringify(value))).toThrow(
      key,
    );
  });
});

describe('facilitated discovery records', () => {
  let root: string;
  let store: Store;
  let service: DiscoveryService;
  let id = 0;
  let clock = AT;

  beforeEach(async () => {
    clock = AT;
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'diomedes-fd02-'));
    store = new Store(path.join(root, 'data'), path.join(root, 'projects'));
    await store.init();
    service = new DiscoveryService(store, {
      now: () => clock,
      id: (prefix) => `${prefix}${++id}`,
    });
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  const locked = <T>(action: () => Promise<T>) => store.locked(action);

  test('a conversational description creates a no-account process map with reported provenance', async () => {
    const record = await locked(() => service.createAndSelect('consultant-a', conversation));

    expect(record.prospectName).toBe('Juniper Coffee');
    expect(record.goalFactIds).toHaveLength(1);
    expect(record.currentProcess).toHaveLength(1);
    expect(record.currentProcess[0]).toMatchObject({ sequence: 1 });
    expect(
      record.facts.every(
        (fact) => fact.provenance.class === 'reported' || fact.id === record.hypothesisFactId,
      ),
    ).toBe(true);
    expect(record.facts.find((fact) => fact.id === record.hypothesisFactId)?.provenance.class).toBe(
      'hypothesized',
    );
    expect(JSON.stringify(record)).not.toMatch(/membership|credential|login|password/i);
  });

  test('active selection is server-owned, persisted, and refuses a different operator', async () => {
    const a = await locked(() => service.createAndSelect('consultant-a', conversation));
    await locked(() =>
      service.createAndSelect('consultant-b', {
        ...conversation,
        prospectName: 'Riverstone Cabinets',
      }),
    );

    expect((await service.active('consultant-a'))?.id).toBe(a.id);
    await expect(service.select('consultant-b', a.id)).rejects.toMatchObject({ status: 404 });

    const restarted = new DiscoveryService(store, {
      now: () => clock,
      id: (prefix) => `${prefix}${++id}`,
    });
    expect((await restarted.active('consultant-a'))?.prospectName).toBe('Juniper Coffee');
    expect((await restarted.active('consultant-b'))?.prospectName).toBe('Riverstone Cabinets');
  });

  test('import creates public facts only and fixed public transitions preserve prior facts', async () => {
    const created = await locked(() => service.createAndSelect('consultant-a', conversation));
    const differentlyNamedBrief = {
      ...brief,
      business: { ...brief.business, name: 'Juniper Coffee Public Listing' },
    };
    const imported = await locked(() =>
      service.importBrief('consultant-a', 'brief.json', JSON.stringify(differentlyNamedBrief)),
    );
    const importedFacts = imported.facts.filter((fact) => fact.origin === 'imported-document');

    expect(importedFacts.length).toBeGreaterThan(8);
    expect(importedFacts.every((fact) => fact.provenance.class === 'public')).toBe(true);
    const publicFact = importedFacts.find((fact) => fact.field === 'business.name')!;
    expect(publicFact.provenance).toEqual({
      class: 'public',
      url: 'https://juniper.example',
      retrievedAt: '2026-09-18',
    });
    expect(publicFact.value).toBe('Juniper Coffee Public Listing');
    expect(imported.prospectName).toBe('Juniper Coffee');
    expect(discoveryProspectName(imported)).toBe('Juniper Coffee');

    const importedAgain = await locked(() =>
      service.importBrief('consultant-a', 'brief.json', JSON.stringify(differentlyNamedBrief)),
    );
    expect(importedAgain).toEqual(imported);

    clock = LATER;
    const confirmed = await locked(() =>
      service.transitionPublicFact('consultant-a', {
        factId: publicFact.id,
        to: 'reported',
        reportedBy: 'owner',
      }),
    );
    const replacement = confirmed.facts.at(-1)!;
    expect(replacement).toMatchObject({
      replacesFactId: publicFact.id,
      value: 'Juniper Coffee Public Listing',
    });
    expect(replacement.provenance).toEqual({ class: 'reported', reportedBy: 'owner' });
    expect(confirmed.facts.some((fact) => fact.id === publicFact.id)).toBe(true);

    await expect(
      locked(() =>
        service.transitionPublicFact('consultant-a', {
          factId: importedFacts[1]!.id,
          to: 'observed' as never,
        }),
      ),
    ).rejects.toMatchObject({
      status: 409,
      message: expect.stringMatching(/public fact cannot become observed/i),
    });

    await expect(
      locked(() => service.importBrief('consultant-a', 'brief.json', '{"ownerName":"A Person"}')),
    ).rejects.toMatchObject({ status: 400, details: { code: 'invalid_research_brief' } });
  });

  test('a correction propagates into export without fabricating confirmation', async () => {
    const created = await locked(() => service.createAndSelect('consultant-a', conversation));
    const painFactId = created.currentProcess[0]!.painPointFactIds[0]!;
    clock = LATER;
    await locked(() =>
      service.correctFact('consultant-a', {
        factId: painFactId,
        value: 'The exports are reliable; manual collation is the only delay.',
        provenance: { class: 'reported', reportedBy: 'owner' },
      }),
    );

    const artifact = await service.exportActive('consultant-a');
    expect(artifact.routeLabel).toBe('no-file discovery');
    expect(artifact.origin).toBe('generated-artifact');
    expect(artifact.text).toContain(
      'The exports are reliable; manual collation is the only delay.',
    );
    const activeExport = artifact.text.split('## Fact history')[0]!;
    expect(activeExport).not.toContain('A missing export delays the review');
    expect(artifact.text).toContain('A missing export delays the review');
    expect(artifact.text).toContain('Reported by owner');
    expect(artifact.text).not.toContain('Observed');
    expect(artifact.text).toContain('Stage: discovery');
    expect(artifact.text).toContain('Personalization: account');

    await expect(
      locked(() =>
        service.correctFact('consultant-a', {
          factId: painFactId,
          value: 'A conflicting stale edit.',
          provenance: { class: 'reported', reportedBy: 'owner' },
        }),
      ),
    ).rejects.toMatchObject({ status: 409, details: { code: 'stale_discovery_fact' } });
  });

  test('observed facts require verified durable evidence and remain separate from public facts', async () => {
    await locked(() => service.createAndSelect('consultant-a', conversation));
    const evidence = {
      kind: 'approved-file' as const,
      projectId: 'project-1',
      path: 'Imports/weekly.csv',
      sha: 'a'.repeat(64),
      historyEntryId: 'history-1',
    };
    await expect(
      locked(() =>
        service.addFact('consultant-a', {
          field: 'currentProcess.evidence',
          label: 'Approved-file observation',
          value: 'The approved export has twelve rows.',
          provenance: { class: 'observed', evidence },
        }),
      ),
    ).rejects.toMatchObject({ status: 403, details: { code: 'unverified_observed_evidence' } });

    const verified = new DiscoveryService(store, {
      now: () => clock,
      id: (prefix) => `${prefix}${++id}`,
      verifyObservedEvidence: async (input) => input.evidence.historyEntryId === 'history-1',
    });
    const updated = await locked(() =>
      verified.addFact('consultant-a', {
        field: 'currentProcess.evidence',
        label: 'Approved-file observation',
        value: 'The approved export has twelve rows.',
        provenance: { class: 'observed', evidence },
      }),
    );
    expect(updated.facts.at(-1)?.provenance).toEqual({ class: 'observed', evidence });
  });

  test('stale evidence keeps a stored fact readable but never backs a new observation (DIO-84)', async () => {
    await locked(() => service.createAndSelect('consultant-a', conversation));
    const evidence = {
      kind: 'approved-file' as const,
      projectId: 'project-1',
      path: 'Imports/weekly.csv',
      sha: 'a'.repeat(64),
      historyEntryId: 'history-1',
    };
    let reading: 'verified' | 'stale' | 'invalid' = 'verified';
    const checked = new DiscoveryService(store, {
      now: () => clock,
      id: (prefix) => `${prefix}${++id}`,
      checkObservedEvidence: async () =>
        reading === 'stale'
          ? { status: 'stale', currentSha: 'b'.repeat(64) }
          : { status: reading },
    });
    const observe = () =>
      locked(() =>
        checked.addFact('consultant-a', {
          field: 'currentProcess.evidence',
          label: 'Approved-file observation',
          value: 'The approved export has twelve rows.',
          provenance: { class: 'observed', evidence },
        }),
      );
    const recorded = await observe();
    const fact = recorded.facts.at(-1)!;
    expect(await checked.staleEvidence('consultant-a', recorded)).toEqual([]);

    reading = 'stale';
    const active = (await locked(() => checked.active('consultant-a')))!;
    expect(active).toEqual(recorded);
    expect(await checked.staleEvidence('consultant-a', active)).toEqual([
      {
        factId: fact.id,
        projectId: 'project-1',
        path: 'Imports/weekly.csv',
        recordedSha: 'a'.repeat(64),
        currentSha: 'b'.repeat(64),
      },
    ]);
    await expect(observe()).rejects.toMatchObject({
      status: 403,
      details: { code: 'unverified_observed_evidence' },
    });
    const retired = await locked(() =>
      checked.correctFact('consultant-a', {
        factId: fact.id,
        value: null,
        provenance: { class: 'unknown', reason: 'Retired after the export changed.' },
      }),
    );
    expect(retired.facts.find((item) => item.id === fact.id)).toEqual(fact);
    expect(retired.facts.at(-1)).toMatchObject({ replacesFactId: fact.id, value: null });

    // Evidence that does not check out at all still refuses the record.
    reading = 'invalid';
    await expect(locked(() => checked.active('consultant-a'))).rejects.toMatchObject({
      status: 409,
      details: { code: 'invalid_observed_evidence' },
    });
  });

  test('hypothesis outcomes are append-only and a not-a-weak-point outcome remains exportable', async () => {
    const created = await locked(() => service.createAndSelect('consultant-a', conversation));
    clock = LATER;
    const updated = await locked(() =>
      service.setHypothesisOutcome('consultant-a', {
        outcome: 'not-a-weak-point',
        checkedAt: LATER,
      }),
    );

    expect(updated.hypothesisFactId).toBe(created.hypothesisFactId);
    expect(updated.facts.filter((fact) => fact.provenance.class === 'hypothesized')).toHaveLength(
      1,
    );
    expect(updated.hypothesisOutcomes).toEqual([
      { outcome: 'unknown', checkedAt: AT, recordedAt: AT },
      { outcome: 'not-a-weak-point', checkedAt: LATER, recordedAt: LATER },
    ]);
    expect((await service.exportActive('consultant-a')).text).toContain('Not a weak point');
  });

  test('stage and personalization move forward and pilot remains promotion-only', async () => {
    await locked(() => service.createAndSelect('consultant-a', conversation));
    const advanced = await locked(() =>
      service.setClassification('consultant-a', {
        stage: 'proposed-workflow',
        personalizationLevel: 'account-live-modified',
      }),
    );
    expect(advanced).toMatchObject({
      stage: 'proposed-workflow',
      personalizationLevel: 'account-live-modified',
    });
    await expect(
      locked(() => service.setClassification('consultant-a', { stage: 'opportunity' })),
    ).rejects.toMatchObject({ status: 409, message: expect.stringMatching(/moves forward/i) });
    await expect(
      locked(() => service.setClassification('consultant-a', { stage: 'pilot' })),
    ).rejects.toMatchObject({
      status: 409,
      message: expect.stringMatching(/pilot promotion path/i),
    });
  });
});
