import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MemoryLedgerCommand, MemoryLedgerScope } from '../shared/memory-ledger.js';
import {
  command, conflictCommand, entityCommand, epochs, keyOf, openFixture, scopeA, scopeB,
  scopeOtherWorkspace, scopeWest, source, T0, T1, T2, T3, T4, type LedgerFixture,
} from './fixtures/memory-ledger/fixture.js';

// Authored assertions alone do not establish runtime qualification.
let fixture: LedgerFixture;
beforeEach(async () => { fixture = await openFixture(); });
afterEach(async () => { if (fixture) await fixture.dispose(); });

describe('W01 scoped immutable ledger', () => {
  it.each([scopeB, scopeWest, scopeOtherWorkspace])
  ('isolates colliding record, command and event IDs in $tenantId/$workspaceId/$scopeRef', other => {
    const first = fixture.service.commit(scopeA, command(scopeA));
    const second = fixture.service.commit(other, command(other, { body: 'Different private claim.' }));
    expect(first.entry.revision).toBe(1);
    expect(second.entry.revision).toBe(1);
    expect(fixture.service.snapshot(scopeA).entries).toEqual([first.entry]);
    expect(fixture.service.snapshot(other).entries).toEqual([second.entry]);
    expect(fixture.service.outbox(scopeA, 0, 10)).toEqual([first.event]);
    expect(fixture.service.outbox(other, 0, 10)).toEqual([second.event]);
    fixture.service.acknowledge(scopeA, 'projector', first.event.sequence);
    expect(fixture.service.acknowledged(other, 'projector')).toBe(0);
  });

  it.each(['tenantId', 'workspaceId', 'scopeRef'] as const)
  ('rejects a payload whose %s differs from the host scope without partial writes', key => {
    expect(() => fixture.service.commit(scopeA, command(scopeA, { [key]: 'foreign' })))
      .toThrow('memory_not_found_or_forbidden');
    expect(fixture.service.snapshot(scopeA).entries).toEqual([]);
    expect(fixture.service.outbox(scopeA, 0, 10)).toEqual([]);
  });

  it.each([scopeB, scopeWest, scopeOtherWorkspace])
  ('cannot borrow a foreign entity or dependency through an equal ID in $tenantId/$workspaceId/$scopeRef', other => {
    fixture.service.commit(other, entityCommand('employee', 'Alex'));
    fixture.service.commit(other, command(other, { id: 'private-source' }));
    expect(() => fixture.service.commit(scopeA, command(scopeA, {}, { entityId: 'employee' })))
      .toThrow('memory_not_found_or_forbidden');
    expect(() => fixture.service.commit(scopeA, command(scopeA, { dependencies: ['private-source'] }, {
      dependencyRevisions: [{ id: 'private-source', revision: 1 }],
    }))).toThrow('invalid_source_reference');
    expect(fixture.service.snapshot(scopeA).entries).toEqual([]);
  });

  it('requires exact dependency revisions and preserves the original link after a source correction', () => {
    const original = fixture.service.commit(scopeA, command(scopeA, { id: 'source' }));
    expect(() => fixture.service.commit(scopeA, command(scopeA, { dependencies: ['source'] }, {
      dependencyRevisions: [{ id: 'source', revision: 2 }],
    }))).toThrow('invalid_source_reference');
    const derived = fixture.service.commit(scopeA, command(scopeA, { dependencies: ['source'] }, {
      dependencyRevisions: [{ id: 'source', revision: 1 }],
    }));
    fixture.service.commit(scopeA, command(scopeA, { id: 'source', revision: 2, body: 'Corrected source.' }));
    const snapshot = fixture.service.snapshot(scopeA);
    expect(snapshot.entries).toContainEqual(original.entry);
    expect(snapshot.entries).toContainEqual(derived.entry);
    expect(derived.entry.payload).toMatchObject({ value: { dependencyRevisions: [{ id: 'source', revision: 1 }] } });
  });

  it('does not allow a conflict to reference another scope or a missing revision', () => {
    fixture.service.commit(scopeA, command(scopeA, { id: 'local' }));
    fixture.service.commit(scopeB, command(scopeB, { id: 'foreign' }));
    expect(() => fixture.service.commit(scopeA, conflictCommand('conflict', [
      { id: 'local', revision: 1 }, { id: 'foreign', revision: 1 },
    ]))).toThrow('invalid_source_reference');
    expect(fixture.service.snapshot(scopeA).entries).toHaveLength(1);
  });

  it('M28 refuses a stale expected revision instead of silently overwriting the winner', () => {
    fixture.service.commit(scopeA, command(scopeA));
    const winner = fixture.service.commit(scopeA, command(scopeA, { revision: 2, body: 'Writer one.' }));
    const loser = command(scopeA, { revision: 2, body: 'Writer two.' }, { commandId: 'writer-two', expectedRevision: 1 });
    expect(() => fixture.service.commit(scopeA, loser)).toThrow('revision_conflict');
    expect(fixture.service.snapshot(scopeA).entries.at(-1)).toEqual(winner.entry);
    expect(fixture.service.outbox(scopeA, 0, 10)).toHaveLength(2);
  });

  it('M29 replays the exact command receipt without another revision or event', () => {
    const input = command(scopeA);
    const first = fixture.service.commit(scopeA, input);
    fixture.setTime(T3);
    expect(fixture.service.commit(scopeA, structuredClone(input))).toEqual(first);
    expect(fixture.service.snapshot(scopeA).entries).toEqual([first.entry]);
    expect(fixture.service.outbox(scopeA, 0, 10)).toEqual([first.event]);
  });

  it.each(['body', 'expectedRevision', 'source', 'operation'] as const)
  ('M29 refuses command reuse with different %s', change => {
    const original = command(scopeA);
    fixture.service.commit(scopeA, original);
    const altered: MemoryLedgerCommand = structuredClone(original);
    if (change === 'expectedRevision') altered.expectedRevision = 1;
    else if (change === 'operation') altered.payload = entityCommand('claim', 'Alex').payload;
    else if (altered.payload.kind === 'record') {
      if (change === 'body') altered.payload.value.record.body = 'Different content.';
      else altered.payload.value.record.sources[0].locator = 'message:1#different-span';
    }
    expect(() => fixture.service.commit(scopeA, altered)).toThrow('command_conflict');
    expect(fixture.service.snapshot(scopeA).entries).toHaveLength(1);
    expect(fixture.service.outbox(scopeA, 0, 10)).toHaveLength(1);
  });

  it('keeps source links and previous revisions immutable even when callers mutate returned values', () => {
    const input = command(scopeA);
    const first = fixture.service.commit(scopeA, input);
    const saved = structuredClone(first.entry);
    if (input.payload.kind === 'record') input.payload.value.record.sources[0].locator = 'caller-mutated';
    if (first.entry.payload.kind === 'record') first.entry.payload.value.record.body = 'caller-mutated';
    const changed = fixture.service.snapshot(scopeA);
    changed.entries.length = 0;
    fixture.service.commit(scopeA, command(scopeA, {
      revision: 2, body: 'A correction with new source bytes.',
      sources: [source({ revision: '2', contentSha256: 'b'.repeat(64), observedAt: T2 })],
    }));
    expect(fixture.service.snapshot(scopeA).entries[0]).toEqual(saved);
  });

  it('refuses rewriting bytes behind the same source revision and locator', () => {
    fixture.service.commit(scopeA, command(scopeA));
    expect(() => fixture.service.commit(scopeA, command(scopeA, {
      revision: 2, sources: [source({ contentSha256: 'b'.repeat(64) })],
    }))).toThrow('invalid_source_reference');
    expect(fixture.service.snapshot(scopeA).entries).toHaveLength(1);
  });

  it('preserves independent lifecycle and epistemic status without promotion', () => {
    fixture.service.commit(scopeA, command(scopeA, { lifecycle: 'active', epistemic: 'inferred' }));
    const saved = fixture.service.snapshot(scopeA).entries[0];
    expect(saved.payload).toMatchObject({ kind: 'record', value: { record: {
      lifecycle: 'active', epistemic: 'inferred',
    } } });
  });

  it('freezes deterministic snapshots across subsequent commits', () => {
    const first = fixture.service.commit(scopeA, command(scopeA));
    const frozen = fixture.service.snapshot(scopeA);
    fixture.service.commit(scopeA, command(scopeA, { revision: 2, body: 'Later update.' }));
    expect(frozen.entries).toEqual([first.entry]);
    expect(fixture.service.snapshot(scopeA, frozen.sequence)).toEqual(frozen);
    expect(fixture.service.snapshot(scopeA).entries).toHaveLength(2);
  });

  it('refuses borrowing a stale entity or dependency into a fresh-epoch record', () => {
    fixture.service.commit(scopeA, entityCommand('person', 'Alex'));
    fixture.service.commit(scopeA, command(scopeA, { id: 'source' }));
    const current = { ...epochs, deletionEpoch: epochs.deletionEpoch + 1 };
    fixture.setAuthority(scopeA, current);
    fixture.service.advanceEpochs(keyOf(scopeA), current);
    const scope = { ...scopeA, ...current };
    expect(() => fixture.service.commit(scope, command(scope, {}, { entityId: 'person' }))).toThrow('revoked_epoch');
    expect(() => fixture.service.commit(scope, command(scope, { dependencies: ['source'] }, {
      dependencyRevisions: [{ id: 'source', revision: 1 }],
    }))).toThrow('revoked_epoch');
    expect(fixture.service.aliases(scope, 'Alex')).toEqual({ status: 'none', entities: [] });
    expect(fixture.service.snapshot(scope)).toMatchObject({ entries: [], suppression: { omittedEntries: 2 } });
  });

  it('requires the operative active dependency revision for a new derived claim', () => {
    fixture.service.commit(scopeA, command(scopeA, { id: 'source' }));
    fixture.service.commit(scopeA, command(scopeA, { id: 'source', revision: 2, lifecycle: 'retracted' }));
    for (const revision of [1, 2]) {
      expect(() => fixture.service.commit(scopeA, command(scopeA, { dependencies: ['source'] }, {
        dependencyRevisions: [{ id: 'source', revision }],
      }))).toThrow('invalid_source_reference');
    }
    expect(fixture.service.snapshot(scopeA).entries).toHaveLength(2);
  });

  it('can reference the currently operative dependency after learning its future replacement', () => {
    fixture.service.commit(scopeA, command(scopeA, { id: 'source', validFrom: T0, validTo: null }));
    fixture.setTime(T2);
    fixture.service.commit(scopeA, command(scopeA, {
      id: 'source', revision: 2, validFrom: T3, validTo: T4,
    }, { changeMode: 'effective-from' }));
    const dependent = fixture.service.commit(scopeA, command(scopeA, {
      validFrom: T2, validTo: T3, dependencies: ['source'],
    }, { dependencyRevisions: [{ id: 'source', revision: 1 }] }));
    expect(dependent.entry.payload).toMatchObject({ value: { dependencyRevisions: [{ id: 'source', revision: 1 }] } });
    expect(fixture.service.read(scopeA, { validAt: T2 }).records.map(item => item.record.id).sort())
      .toEqual(['claim', 'source']);
  });

  it('refuses a derived claim that continues past its pinned dependency successor', () => {
    fixture.service.commit(scopeA, command(scopeA, { id: 'source', validFrom: T0, validTo: null }));
    fixture.setTime(T2);
    fixture.service.commit(scopeA, command(scopeA, {
      id: 'source', revision: 2, validFrom: T3, validTo: T4,
    }, { changeMode: 'effective-from' }));
    expect(() => fixture.service.commit(scopeA, command(scopeA, {
      validFrom: T2, validTo: T4, dependencies: ['source'],
    }, { dependencyRevisions: [{ id: 'source', revision: 1 }] }))).toThrow('invalid_source_reference');
    expect(fixture.service.snapshot(scopeA).entries).toHaveLength(2);
    expect(fixture.service.outbox(scopeA, 0, 10)).toHaveLength(2);
  });

  it.each([
    { validFrom: null, validTo: T3 },
    { validFrom: T0, validTo: T3 },
    { validFrom: T1, validTo: null },
    { validFrom: T1, validTo: T4 },
  ])('M41 refuses a derivative that widens its finite source interval: $validFrom / $validTo', interval => {
    fixture.service.commit(scopeA, command(scopeA, { id: 'exception', validFrom: T1, validTo: T3 }));
    expect(() => fixture.service.commit(scopeA, command(scopeA, {
      ...interval, dependencies: ['exception'],
    }, { dependencyRevisions: [{ id: 'exception', revision: 1 }] }))).toThrow('invalid_source_reference');
    expect(fixture.service.snapshot(scopeA).entries).toHaveLength(1);
  });

  it.each(['identityGeneration', 'accessEpoch', 'deletionEpoch'] as const)
  ('refuses stale %s on reads and successful command replay', component => {
    const input = command(scopeA);
    fixture.service.commit(scopeA, input);
    const current = { ...epochs, [component]: epochs[component] + 1 };
    fixture.setAuthority(scopeA, current);
    fixture.service.advanceEpochs(keyOf(scopeA), current);
    expect(() => fixture.service.snapshot(scopeA)).toThrow('revoked_epoch');
    expect(() => fixture.service.commit(scopeA, input)).toThrow('revoked_epoch');
    expect(() => fixture.service.outbox(scopeA, 0, 10)).toThrow('revoked_epoch');
    const freshScope: MemoryLedgerScope = { ...scopeA, ...current };
    const read = fixture.service.read(freshScope, { validAt: T2 });
    expect(read.records).toEqual([]);
    expect(read.snapshot.entries).toEqual([]);
    expect(read.snapshot.suppression).toEqual({ omittedEntries: 1 });
  });
});

describe('W01 temporal selection and source lineage', () => {
  it.each([undefined, T1])('AUDIT-09 bounds record identity reads with recordedAt %s', recordedAt => {
    const count = 64;
    for (let index = 0; index < count; index++) {
      fixture.service.commit(scopeA, command(scopeA, { id: `claim-${index}` }));
    }
    fixture.setTime(T3);
    for (let index = 0; index < count; index++) {
      fixture.service.commit(scopeA, command(scopeA, {
        id: `claim-${index}`, revision: 2, body: 'Later correction.',
      }));
    }
    const snapshot = fixture.store.snapshot.bind(fixture.store);
    let identityReads = 0;
    vi.spyOn(fixture.store, 'snapshot').mockImplementation((...args) => {
      const result = snapshot(...args);
      if (!result) return result;
      return { ...result, entries: result.entries.map(entry => new Proxy(entry, {
        get(target, property, receiver) {
          if (property === 'id') identityReads++;
          return Reflect.get(target, property, receiver);
        },
      })) };
    });

    const result = fixture.service.read(scopeA, { validAt: T2, recordedAt });
    const reads = identityReads;
    expect(result.records).toHaveLength(count);
    expect(result.records.map(view => view.record.revision)).toEqual(Array(count).fill(recordedAt === undefined ? 2 : 1));
    expect(result.records.map(view => view.recordedTo)).toEqual(Array(count).fill(recordedAt === undefined ? null : T3));
    expect(result.snapshot.entries).toHaveLength(recordedAt === undefined ? count * 2 : count);
    expect(result.snapshot.afterRecordedAtEntries).toBe(recordedAt === undefined ? 0 : count);
    // Count property reads after the real adapter returns, independent of clock or SQLite speed.
    expect(reads).toBeLessThanOrEqual(count * 2 * 4);
  });

  it('AUDIT-09 bounds complete successor history by sequence while retaining later-recorded closure', () => {
    const first = fixture.service.commit(scopeA, command(scopeA, { validFrom: null, validTo: null }));
    fixture.service.commit(scopeA, entityCommand('claim', 'Same ID, different kind.'));
    fixture.setTime(T2);
    const future = fixture.service.commit(scopeA, command(scopeA, {
      revision: 2, body: 'Future policy.', validFrom: T3, validTo: T4,
    }, { changeMode: 'effective-from' }));
    fixture.setTime(T3);
    fixture.service.commit(scopeA, command(scopeA, {
      revision: 3, lifecycle: 'retracted', validFrom: T0, validTo: T4,
    }));

    const early = fixture.service.read(scopeA, { validAt: T2, recordedAt: T1 });
    expect(early.records).toHaveLength(1);
    expect(early.records[0]).toMatchObject({ entry: first.entry, temporal: 'unknown', recordedTo: T3 });
    expect(early.snapshot.entries.map(entry => entry.kind)).toEqual(['record', 'entity']);
    expect(early.snapshot.afterRecordedAtEntries).toBe(2);
    expect(JSON.stringify(early)).not.toContain('Future policy.');
    expect(fixture.service.read(scopeA, { validAt: T3, recordedAt: T1 }).records[0].recordedTo).toBe(T2);
    expect(fixture.service.read(scopeA, { validAt: T3, recordedAt: T2 }).records[0])
      .toMatchObject({ entry: future.entry, temporal: 'applicable', recordedTo: T3 });
    expect(fixture.service.read(scopeA, { validAt: T3 }).records).toEqual([]);

    expect(fixture.service.read(scopeA, { validAt: T3, recordedAt: T1, throughSequence: first.entry.sequence }).records[0])
      .toMatchObject({ entry: first.entry, recordedTo: null });
    expect(fixture.service.read(scopeA, { validAt: T2, recordedAt: T1, throughSequence: future.entry.sequence }).records[0].recordedTo)
      .toBeNull();
    expect(fixture.service.read(scopeA, { validAt: T3, recordedAt: T1, throughSequence: future.entry.sequence }).records[0].recordedTo)
      .toBe(T2);
  });

  it('M03 preserves the operative revision after learning a future-effective replacement', () => {
    fixture.service.commit(scopeA, command(scopeA, { body: 'Current SOP.', validFrom: T0, validTo: T3 }));
    fixture.setTime(T2);
    fixture.service.commit(scopeA, command(scopeA, {
      revision: 2, body: 'Future SOP.', validFrom: T3, validTo: T4,
    }, { changeMode: 'effective-from' }));
    const current = fixture.service.read(scopeA, { validAt: T2 }).records;
    expect(current.map(item => item.record.body)).toEqual(['Current SOP.']);
    expect(current[0].recordedTo).toBeNull();
    expect(fixture.service.read(scopeA, { validAt: T3 }).records.map(item => item.record.body)).toEqual(['Future SOP.']);
  });

  it('M04 separates when a correction was recorded from when the claim was valid', () => {
    fixture.service.commit(scopeA, command(scopeA, { body: 'Initially reported five.', validFrom: T0, validTo: T4 }));
    fixture.setTime(T3);
    fixture.service.commit(scopeA, command(scopeA, { revision: 2, body: 'Corrected historical count: three.', validFrom: T0, validTo: T4 }));
    const historical = fixture.service.read(scopeA, { validAt: T1, recordedAt: T2 });
    const then = historical.records;
    const now = fixture.service.read(scopeA, { validAt: T1, recordedAt: T3 }).records;
    expect(then.map(item => item.record.body)).toEqual(['Initially reported five.']);
    expect(now.map(item => item.record.body)).toEqual(['Corrected historical count: three.']);
    expect(then[0].entry.recordedAt).toBe(T1);
    expect(then[0].recordedTo).toBe(T3);
    expect(now[0].entry.recordedAt).toBe(T3);
    expect(historical.snapshot.entries.map(item => item.revision)).toEqual([1]);
    expect(historical.snapshot.afterRecordedAtEntries).toBe(1);
    expect(JSON.stringify(historical)).not.toContain('Corrected historical count: three.');
  });

  it('M42 replaces the correct formerly negative claim only at its effective boundary', () => {
    fixture.service.commit(scopeA, command(scopeA, { body: 'Permit not approved.', validFrom: T0, validTo: T2 }));
    fixture.setTime(T2);
    fixture.service.commit(scopeA, command(scopeA, {
      revision: 2, body: 'Permit approved.', validFrom: T2, validTo: T4,
    }, { changeMode: 'effective-from' }));
    expect(fixture.service.read(scopeA, { validAt: T1 }).records.map(item => item.record.body)).toEqual(['Permit not approved.']);
    expect(fixture.service.read(scopeA, { validAt: T2 }).records.map(item => item.record.body)).toEqual(['Permit approved.']);
    expect(fixture.service.read(scopeA, { validAt: T4 }).records).toEqual([]);
  });

  it('retains unknown validity explicitly instead of inventing an effective instant', () => {
    fixture.service.commit(scopeA, command(scopeA, { validFrom: null, validTo: null }));
    const values = fixture.service.read(scopeA, { validAt: T2 }).records;
    expect(values).toHaveLength(1);
    expect(values[0]).toMatchObject({ temporal: 'unknown', record: { validFrom: null, validTo: null } });
  });

  it('a retracted applicable revision suppresses the claim without falling back to the older active revision', () => {
    fixture.service.commit(scopeA, command(scopeA, { validFrom: T0, validTo: T4 }));
    fixture.setTime(T2);
    fixture.service.commit(scopeA, command(scopeA, { revision: 2, lifecycle: 'retracted', validFrom: T0, validTo: T4 }));
    expect(fixture.service.read(scopeA, { validAt: T1 }).records).toEqual([]);
    expect(fixture.service.read(scopeA, { validAt: T1, recordedAt: T1 }).records).toHaveLength(1);
    expect(fixture.service.snapshot(scopeA).entries).toHaveLength(2);
  });

  it('a correction that shortens validity never resurrects the older open-ended claim', () => {
    fixture.service.commit(scopeA, command(scopeA, { validFrom: T0, validTo: null }));
    fixture.setTime(T2);
    fixture.service.commit(scopeA, command(scopeA, { revision: 2, validFrom: T1, validTo: T3 }));
    expect(fixture.service.read(scopeA, { validAt: T0 }).records).toEqual([]);
    expect(fixture.service.read(scopeA, { validAt: T2 }).records.map(item => item.record.revision)).toEqual([2]);
    expect(fixture.service.read(scopeA, { validAt: T3 }).records).toEqual([]);
    expect(fixture.service.read(scopeA, { validAt: T3, recordedAt: T1 }).records.map(item => item.record.revision)).toEqual([1]);
  });

  it('effective succession preserves earlier truth but never falls back after its own end', () => {
    fixture.service.commit(scopeA, command(scopeA, { validFrom: T0, validTo: null }));
    fixture.setTime(T2);
    fixture.service.commit(scopeA, command(scopeA, { revision: 2, validFrom: T2, validTo: T3 }, { changeMode: 'effective-from' }));
    expect(fixture.service.read(scopeA, { validAt: T1 }).records.map(item => item.record.revision)).toEqual([1]);
    expect(fixture.service.read(scopeA, { validAt: T2 }).records.map(item => item.record.revision)).toEqual([2]);
    expect(fixture.service.read(scopeA, { validAt: T3 }).records).toEqual([]);
  });

  it('requires both a prior claim and a known start for effective succession', () => {
    expect(() => fixture.service.commit(scopeA, command(scopeA, {}, { changeMode: 'effective-from' }))).toThrow('invalid_memory');
    fixture.service.commit(scopeA, command(scopeA));
    expect(() => fixture.service.commit(scopeA, command(scopeA, {
      revision: 2, validFrom: null,
    }, { changeMode: 'effective-from' }))).toThrow('invalid_memory');
    expect(fixture.service.snapshot(scopeA).entries).toHaveLength(1);
  });

  it.each([
    { validFrom: 'tomorrow', validTo: T4 },
    { validFrom: '2026-02-30T00:00:00.000Z', validTo: T4 },
    { validFrom: T3, validTo: T2 },
    { validFrom: T2, validTo: T2 },
  ])('refuses malformed or empty temporal intervals: $validFrom / $validTo', interval => {
    expect(() => fixture.service.commit(scopeA, command(scopeA, interval))).toThrow('invalid_memory');
    expect(fixture.service.snapshot(scopeA).entries).toEqual([]);
  });

  it('M41 repeated retellings do not extend an emergency exception or create independent source lineage', () => {
    fixture.service.commit(scopeA, command(scopeA, {
      body: 'Emergency exception applies only on October 2.', validFrom: T1, validTo: T2,
    }));
    fixture.setTime(T3);
    fixture.service.commit(scopeA, command(scopeA, {
      revision: 2, body: 'Retelling of the October 2 emergency exception.', validFrom: T1, validTo: T2,
      sources: [source(), source({ locator: 'message:1#span:43-99' })],
    }));
    const historical = fixture.service.read(scopeA, { validAt: T1 }).records;
    expect(historical).toHaveLength(1);
    expect(historical[0].lineageCount).toBe(1);
    expect(historical[0].record.kind).toBe('fact');
    expect(fixture.service.read(scopeA, { validAt: T3 }).records).toEqual([]);
  });
});

describe('W01 scoped aliases and explicit conflicts', () => {
  it('M05 keeps same-name suppliers in different locations distinct', () => {
    fixture.service.commit(scopeA, entityCommand('supplier-east', 'Common Supplier', 1, 'organization'));
    fixture.service.commit(scopeWest, entityCommand('supplier-west', 'Common Supplier', 1, 'organization'));
    expect(fixture.service.aliases(scopeA, 'Common Supplier')).toMatchObject({
      status: 'unique', entities: [{ id: 'supplier-east' }],
    });
    expect(fixture.service.aliases(scopeWest, 'Common Supplier')).toMatchObject({
      status: 'unique', entities: [{ id: 'supplier-west' }],
    });
    expect(fixture.service.aliases(scopeB, 'Common Supplier')).toEqual({ status: 'none', entities: [] });
  });

  it('M06 preserves two same-name people as ambiguous without borrowing either identity', () => {
    fixture.service.commit(scopeA, entityCommand('employee-1', 'Alex Lee'));
    const before = fixture.service.snapshot(scopeA);
    fixture.service.commit(scopeA, entityCommand('employee-2', 'Alex Lee'));
    const aliases = fixture.service.aliases(scopeA, 'Alex Lee');
    expect(aliases.status).toBe('ambiguous');
    expect(aliases.entities.map(entity => entity.id).sort()).toEqual(['employee-1', 'employee-2']);
    expect(fixture.service.aliases(scopeA, 'Alex Lee', { throughSequence: before.sequence }).status).toBe('unique');
    expect(fixture.service.aliases(scopeA, 'Alex')).toEqual({ status: 'none', entities: [] });
  });

  it('M08 applies only host-declared authority precedence and retains both conflicting claims', () => {
    const organization = fixture.service.commit(scopeA, command(scopeA, {
      id: 'organization-policy', epistemic: 'source-supported', validTo: T4,
    }, { authorityRef: 'approved-organization' }));
    const department = fixture.service.commit(scopeA, command(scopeA, {
      id: 'department-policy', epistemic: 'source-supported', validTo: T4,
    }, { authorityRef: 'department' }));
    fixture.service.commit(scopeA, conflictCommand('policy-conflict', [
      { id: organization.entry.id, revision: 1 }, { id: department.entry.id, revision: 1 },
    ]));
    const unresolved = fixture.service.conflict(scopeA, 'policy-conflict', null);
    expect(unresolved.preferred).toBeNull();
    expect(unresolved.claims).toHaveLength(2);
    const resolved = fixture.service.conflict(scopeA, 'policy-conflict', {
      policyRef: 'host-precedence-v1', authorityOrder: ['approved-organization', 'department'],
    }, { validAt: T2 });
    expect(resolved.preferred).toEqual({ id: 'organization-policy', revision: 1 });
    expect(resolved.policyRef).toBe('host-precedence-v1');
    expect(resolved.claims).toEqual(unresolved.claims);
    expect(fixture.service.snapshot(scopeA).entries).toHaveLength(3);
  });

  it('M09 newer inference cannot defeat an older explicit source by recency or equal authority label', () => {
    fixture.service.commit(scopeA, command(scopeA, { id: 'explicit', epistemic: 'source-supported', validTo: T4 }, { authorityRef: 'approved' }));
    fixture.setTime(T3);
    expect(() => fixture.service.commit(scopeA, command(scopeA, {
      id: 'inference', epistemic: 'inferred',
    }, { authorityRef: 'approved' }))).toThrow('invalid_source_reference');
    fixture.service.commit(scopeA, command(scopeA, { id: 'inference', epistemic: 'inferred' }));
    fixture.service.commit(scopeA, conflictCommand('inference-conflict', [
      { id: 'explicit', revision: 1 }, { id: 'inference', revision: 1 },
    ]));
    const result = fixture.service.conflict(scopeA, 'inference-conflict', {
      policyRef: 'host-policy', authorityOrder: ['approved'],
    }, { validAt: T2 });
    expect(result.preferred).toEqual({ id: 'explicit', revision: 1 });
    expect(result.claims).toHaveLength(2);
  });

  it('leaves equal-priority explicit claims unresolved', () => {
    fixture.service.commit(scopeA, command(scopeA, { id: 'one', epistemic: 'source-supported', validTo: T4 }, { authorityRef: 'approved' }));
    fixture.service.commit(scopeA, command(scopeA, { id: 'two', epistemic: 'source-supported', validTo: T4 }, { authorityRef: 'approved' }));
    fixture.service.commit(scopeA, conflictCommand('tie', [{ id: 'one', revision: 1 }, { id: 'two', revision: 1 }]));
    expect(fixture.service.conflict(scopeA, 'tie', {
      policyRef: 'host-policy', authorityOrder: ['approved'],
    }, { validAt: T2 }).preferred).toBeNull();
  });

  it('requires an explicit temporal query before selecting conflict precedence', () => {
    fixture.service.commit(scopeA, command(scopeA, { id: 'one', epistemic: 'source-supported', validTo: T4 }, { authorityRef: 'approved' }));
    fixture.service.commit(scopeA, command(scopeA, { id: 'two', validTo: T4 }));
    fixture.service.commit(scopeA, conflictCommand('query-required', [{ id: 'one', revision: 1 }, { id: 'two', revision: 1 }]));
    expect(() => fixture.service.conflict(scopeA, 'query-required', {
      policyRef: 'host-policy', authorityOrder: ['approved'],
    })).toThrow('invalid_memory');
  });

  it('a future higher-priority claim cannot defeat the currently operative policy', () => {
    fixture.service.commit(scopeA, command(scopeA, {
      id: 'current', epistemic: 'source-supported', validFrom: T0, validTo: T4,
    }, { authorityRef: 'department' }));
    fixture.service.commit(scopeA, command(scopeA, {
      id: 'future', epistemic: 'source-supported', validFrom: T3, validTo: T4,
    }, { authorityRef: 'organization' }));
    fixture.service.commit(scopeA, conflictCommand('future-conflict', [{ id: 'current', revision: 1 }, { id: 'future', revision: 1 }]));
    const policy = { policyRef: 'host-policy', authorityOrder: ['organization', 'department'] };
    expect(fixture.service.conflict(scopeA, 'future-conflict', policy, { validAt: T2 }).preferred)
      .toEqual({ id: 'current', revision: 1 });
    expect(fixture.service.conflict(scopeA, 'future-conflict', policy, { validAt: T3 }).preferred)
      .toEqual({ id: 'future', revision: 1 });
  });

  it('a pinned conflict cannot re-promote an older revision after a later retraction', () => {
    fixture.service.commit(scopeA, command(scopeA, { id: 'approved', epistemic: 'source-supported', validTo: T4 }, { authorityRef: 'organization' }));
    fixture.service.commit(scopeA, command(scopeA, { id: 'other', validTo: T4 }));
    fixture.service.commit(scopeA, conflictCommand('pinned', [{ id: 'approved', revision: 1 }, { id: 'other', revision: 1 }]));
    fixture.setTime(T2);
    fixture.service.commit(scopeA, command(scopeA, { id: 'approved', revision: 2, lifecycle: 'retracted', validTo: T4 }));
    const policy = { policyRef: 'host-policy', authorityOrder: ['organization'] };
    expect(fixture.service.conflict(scopeA, 'pinned', policy, { validAt: T2 }).preferred).toBeNull();
    expect(fixture.service.conflict(scopeA, 'pinned', policy, { validAt: T2, recordedAt: T1 }).preferred)
      .toEqual({ id: 'approved', revision: 1 });
  });
});
