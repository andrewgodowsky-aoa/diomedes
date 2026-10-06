import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { LocalMemoryStore } from '../server/memory/local-store.js';
import { MemoryService } from '../server/memory/service.js';
import { MEMORY_SQLITE_APPLICATION_ID, MEMORY_SQLITE_SCHEMA_VERSION } from '../server/memory/schema.js';
import type { MemoryFaultPoint, MemoryTransaction } from '../server/memory/store.js';
import {
  command, entityCommand, epochs, keyOf, openFixture, scopeA, scopeB, T1, T2, type LedgerFixture,
} from './fixtures/memory-ledger/fixture.js';

// No runtime qualification or test result is implied by these authored tests.
const fixtures: LedgerFixture[] = [];
async function owned(...args: Parameters<typeof openFixture>) {
  const fixture = await openFixture(...args);
  fixtures.push(fixture);
  return fixture;
}
afterEach(async () => {
  for (const fixture of fixtures.splice(0).reverse()) await fixture.dispose();
});

describe('W01 atomic SQLite recovery and durable outbox', () => {
  it('persists exact revisions, source metadata and command receipts through close/reopen', async () => {
    const fixture = await owned();
    const input = command(scopeA, { sources: [{
      sourceId: 'reference-only', revision: null, locator: 'file:policy#lines:1-3',
      sourceType: 'file', contentSha256: null, observedAt: T1,
      accessPolicyRef: 'policy-ref', restrictionsRef: 'local-only',
    }] });
    const receipt = fixture.service.commit(scopeA, input);
    const snapshot = fixture.service.snapshot(scopeA);
    await fixture.reopen();
    expect(fixture.service.snapshot(scopeA)).toEqual(snapshot);
    expect(fixture.service.commit(scopeA, input)).toEqual(receipt);
    expect(fixture.service.outbox(scopeA, 0, 10)).toEqual([receipt.event]);
  });

  it.each(['after-entry', 'after-event', 'before-commit'] satisfies MemoryFaultPoint[])
  ('M30 injected %s failure exposes no partial revision, event or command receipt after reopen', async point => {
    let armed = false;
    const fixture = await owned({ fault: reached => {
      if (armed && reached === point) throw new Error(`injected:${point}`);
    } });
    fixture.service.commit(scopeA, command(scopeA));
    const before = fixture.store.backup();
    const update = command(scopeA, { revision: 2, body: 'Atomic update.' });
    armed = true;
    expect(() => fixture.service.commit(scopeA, update)).toThrow(`injected:${point}`);
    armed = false;
    expect(fixture.store.backup().scopes).toEqual(before.scopes);
    await fixture.reopen();
    expect(fixture.store.backup().scopes).toEqual(before.scopes);
    const retried = fixture.service.commit(scopeA, update);
    expect(retried.entry.revision).toBe(2);
    expect(fixture.service.snapshot(scopeA).entries).toHaveLength(2);
    expect(fixture.service.outbox(scopeA, 0, 10)).toHaveLength(2);
  });

  it('M30 independent readers cannot observe the inserted revision before commit', async () => {
    let observe = false;
    let readDuringInsert: ReturnType<LocalMemoryStore['snapshot']> | undefined;
    let reader: LocalMemoryStore | undefined;
    const fixture = await owned({ fault: point => {
      if (observe && point === 'after-entry') readDuringInsert = reader!.snapshot(keyOf(scopeA));
    } });
    fixture.service.commit(scopeA, command(scopeA));
    reader = await LocalMemoryStore.open({ path: fixture.file });
    try {
      const before = reader.snapshot(keyOf(scopeA));
      observe = true;
      fixture.service.commit(scopeA, command(scopeA, { revision: 2 }));
      expect(readDuringInsert).toEqual(before);
      expect(reader.snapshot(keyOf(scopeA))?.entries).toHaveLength(2);
    } finally {
      reader.close();
    }
  });

  it.each(['after-entry', 'after-event', 'before-commit'] satisfies MemoryFaultPoint[])
  ('M30 abrupt child exit at %s recovers atomically without adapter rollback or close', async point => {
    const fixture = await owned();
    fixture.service.commit(scopeA, command(scopeA));
    const before = fixture.store.backup().scopes;
    fixture.store.close();
    const childFile = fileURLToPath(new URL('./fixtures/memory-ledger/crash-child.ts', import.meta.url));
    const child = spawnSync(process.execPath, ['--import', 'tsx', childFile, fixture.file, point], {
      cwd: process.cwd(), windowsHide: true, timeout: 20_000, killSignal: 'SIGKILL',
      maxBuffer: 8 * 1024, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    });
    expect(child.error, child.stderr).toBeUndefined();
    expect(child.status, child.stderr).toBe(86);
    expect(await readFile(path.join(fixture.root, 'crash-boundary.txt'), 'utf8')).toBe(point);
    await fixture.reopen();
    expect(fixture.store.backup().scopes).toEqual(before);
    const input = command(scopeA, { revision: 2, body: 'Atomic crash update.' });
    const committed = fixture.service.commit(scopeA, input);
    expect(fixture.service.commit(scopeA, input)).toEqual(committed);
    expect(fixture.service.snapshot(scopeA).entries).toHaveLength(2);
    expect(fixture.service.outbox(scopeA, 0, 10)).toHaveLength(2);
  });

  it('M28 separate SQLite connections cannot both commit from the same captured revision', async () => {
    const fixture = await owned();
    fixture.service.commit(scopeA, command(scopeA));
    const other = await LocalMemoryStore.open({ path: fixture.file });
    const second = new MemoryService(other, { currentEpochs: () => ({ ...epochs }), now: () => T2 });
    try {
      const firstBase = fixture.service.snapshot(scopeA).entries[0].revision;
      const secondBase = second.snapshot(scopeA).entries[0].revision;
      expect(secondBase).toBe(firstBase);
      fixture.service.commit(scopeA, command(scopeA, { revision: 2, body: 'First writer.' }, { expectedRevision: firstBase }));
      expect(() => second.commit(scopeA, command(scopeA, { revision: 2, body: 'Second writer.' }, {
        commandId: 'second-writer', expectedRevision: secondBase,
      }))).toThrow('revision_conflict');
      expect(second.snapshot(scopeA).entries).toHaveLength(2);
      expect(second.outbox(scopeA, 0, 10)).toHaveLength(2);
    } finally { other.close(); }
  });

  it('refuses awaited transactions and escaped transaction handles', async () => {
    const fixture = await owned();
    expect(() => fixture.store.transaction(keyOf(scopeA), tx => {
      tx.advanceEpochs(epochs);
      return Promise.resolve('cannot hold the transaction open');
    })).toThrow('invalid_memory');
    expect(fixture.store.snapshot(keyOf(scopeA))).toBeNull();
    let escaped: MemoryTransaction | undefined;
    fixture.store.transaction(keyOf(scopeA), tx => { escaped = tx; });
    expect(() => escaped!.nextSequence()).toThrow('invalid_memory');
  });

  it('M29 resumes undelivered events after reopen and acknowledges independently per consumer', async () => {
    const fixture = await owned();
    const one = fixture.service.commit(scopeA, command(scopeA));
    const two = fixture.service.commit(scopeA, command(scopeA, { revision: 2 }));
    fixture.service.acknowledge(scopeA, 'indexer', one.event.sequence);
    await fixture.reopen();
    expect(fixture.service.acknowledged(scopeA, 'indexer')).toBe(one.event.sequence);
    expect(fixture.service.acknowledged(scopeA, 'exporter')).toBe(0);
    expect(fixture.service.outbox(scopeA, fixture.service.acknowledged(scopeA, 'indexer'), 1)).toEqual([two.event]);
    expect(fixture.service.outbox(scopeA, 0, 10)).toEqual([one.event, two.event]);
    fixture.service.acknowledge(scopeA, 'indexer', two.event.sequence);
    fixture.service.acknowledge(scopeA, 'indexer', two.event.sequence);
    expect(fixture.service.acknowledged(scopeA, 'indexer')).toBe(two.event.sequence);
    expect(() => fixture.service.acknowledge(scopeA, 'indexer', two.event.sequence + 1)).toThrow();
    expect(() => fixture.service.acknowledge(scopeA, 'indexer', one.event.sequence)).toThrow();
  });

  it('enforces scope references in the adapter even when the service is bypassed', async () => {
    const fixture = await owned();
    const original = fixture.service.commit(scopeB, command(scopeB));
    expect(() => fixture.store.transaction(keyOf(scopeA), tx => {
      tx.advanceEpochs(epochs);
      tx.nextSequence();
      tx.insert(original.entry);
    })).toThrow('memory_not_found_or_forbidden');
    expect(fixture.store.snapshot(keyOf(scopeA))).toBeNull();
    expect(fixture.service.snapshot(scopeB).entries).toEqual([original.entry]);
  });
});

describe('W01 bounded storage and migration readability', () => {
  it('refuses oversized transaction growth atomically instead of dropping durable history', async () => {
    const fixture = await owned({ limits: { maxTransactionBytes: 8192 } });
    const first = fixture.service.commit(scopeA, command(scopeA));
    expect(() => fixture.service.commit(scopeA, command(scopeA, { revision: 2, body: 'x'.repeat(16000) })))
      .toThrow('memory_capacity');
    expect(fixture.service.snapshot(scopeA).entries).toEqual([first.entry]);
    expect(fixture.service.outbox(scopeA, 0, 10)).toEqual([first.event]);
  });

  it('refuses an over-limit snapshot rather than silently truncating it', async () => {
    const fixture = await owned();
    fixture.service.commit(scopeA, command(scopeA));
    fixture.service.commit(scopeA, command(scopeA, { revision: 2 }));
    await fixture.reopen({ limits: { maxSnapshotEntries: 1 } });
    expect(() => fixture.service.snapshot(scopeA)).toThrow('memory_capacity');
    expect(fixture.service.snapshot(scopeA, 1).entries).toHaveLength(1);
  });

  it('bounds outbox requests and backup size without pruning history', async () => {
    const fixture = await owned();
    fixture.service.commit(scopeA, command(scopeA));
    await fixture.reopen({ limits: { maxBackupBytes: 100, maxOutboxPage: 1 } });
    expect(() => fixture.store.backup()).toThrow('memory_capacity');
    expect(() => fixture.service.outbox(scopeA, 0, 2)).toThrow('memory_capacity');
    expect(fixture.service.outbox(scopeA, 0, 1)).toHaveLength(1);
    expect(fixture.service.snapshot(scopeA).entries).toHaveLength(1);
  });

  it('refuses a write when the configured WAL ceiling cannot hold its reservation', async () => {
    const fixture = await owned();
    fixture.service.commit(scopeA, command(scopeA));
    const before = fixture.store.snapshot(keyOf(scopeA));
    await fixture.reopen({ limits: { maxWalBytes: 1024 } });
    expect(() => fixture.service.commit(scopeA, command(scopeA, { revision: 2 }))).toThrow('memory_capacity');
    expect(fixture.store.snapshot(keyOf(scopeA))).toEqual(before);
  });

  it('refuses to create a ledger when the configured WAL ceiling cannot hold the schema write', async () => {
    const fixture = await owned();
    const file = path.join(fixture.root, 'new-ledger.sqlite');
    // 256 pages of 4,096 bytes reserve 1,054,752 WAL bytes, more than this ceiling allows.
    await expect(LocalMemoryStore.open({ path: file, limits: { maxDatabaseBytes: 1024 * 1024, maxWalBytes: 1_000_000 } })
      .then(opened => opened.close())).rejects.toMatchObject({ code: 'memory_capacity' });
    const raw = new DatabaseSync(file, { readOnly: true });
    try {
      expect(raw.prepare('PRAGMA user_version').get()?.user_version).toBe(0);
      expect(raw.prepare('SELECT 1 FROM sqlite_schema LIMIT 1').get()).toBeUndefined();
    } finally { raw.close(); }
  });

  it('upgrades only an empty version-zero SQLite file and leaves existing run records outside the migration', async () => {
    const fixture = await owned();
    const file = path.join(fixture.root, 'empty-v0.sqlite');
    const runDirectory = path.join(fixture.root, 'projects', 'fictional', 'harness', 'runs');
    await mkdir(runDirectory, { recursive: true });
    const runFile = path.join(runDirectory, 'preserved.json');
    const runBytes = '{"v":1,"id":"fictional-preservation-marker"}\n';
    await writeFile(runFile, runBytes);
    const raw = new DatabaseSync(file);
    raw.close();
    const upgraded = await LocalMemoryStore.open({ path: file });
    try {
      expect(upgraded.backup().scopes).toEqual([]);
      expect(await readFile(runFile, 'utf8')).toBe(runBytes);
      const readOnly = new DatabaseSync(file, { readOnly: true });
      try {
        expect(readOnly.prepare('PRAGMA user_version').get()?.user_version).toBe(MEMORY_SQLITE_SCHEMA_VERSION);
        expect(readOnly.prepare('PRAGMA application_id').get()?.application_id).toBe(MEMORY_SQLITE_APPLICATION_ID);
      } finally { readOnly.close(); }
    } finally { upgraded.close(); }
  });

  it.each(['newer', 'nonempty-unversioned', 'foreign-application'] as const)
  ('refuses %s databases without rewriting their bytes', async kind => {
    const fixture = await owned();
    const file = path.join(fixture.root, `${kind}.sqlite`);
    const raw = new DatabaseSync(file);
    if (kind === 'newer') {
      raw.exec(`PRAGMA application_id=${MEMORY_SQLITE_APPLICATION_ID}; PRAGMA user_version=${MEMORY_SQLITE_SCHEMA_VERSION + 1}`);
    } else if (kind === 'foreign-application') {
      raw.exec('PRAGMA application_id=12345; PRAGMA user_version=1');
    } else raw.exec('CREATE TABLE unrelated (id TEXT PRIMARY KEY); INSERT INTO unrelated VALUES (\'preserve-me\')');
    raw.close();
    const before = await readFile(file);
    await expect(LocalMemoryStore.open({ path: file }).then(opened => opened.close()))
      .rejects.toMatchObject({ code: 'unsupported_memory_schema' });
    expect(await readFile(file)).toEqual(before);
  });

  it.each(['unversioned', 'initialized'] as const)
  ('refuses an %s file holding an object named like the reserved sqlite_ prefix', async kind => {
    const fixture = await owned();
    let file = path.join(fixture.root, 'lookalike.sqlite');
    if (kind === 'initialized') {
      fixture.service.commit(scopeA, command(scopeA));
      fixture.store.close();
      file = fixture.file;
    }
    const raw = new DatabaseSync(file);
    try {
      // LIKE reads `_` as any one character, so 'sqlite_%' also matched this foreign name.
      raw.exec(kind === 'initialized'
        ? 'CREATE TRIGGER sqliteXforeign AFTER INSERT ON memory_entries BEGIN SELECT 1; END;'
        : 'CREATE TABLE sqliteXforeign (id TEXT PRIMARY KEY)');
    } finally { raw.close(); }
    const before = await readFile(file);
    await expect(LocalMemoryStore.open({ path: file }).then(opened => opened.close()))
      .rejects.toMatchObject({ code: 'unsupported_memory_schema' });
    expect(await readFile(file)).toEqual(before);
  });

  it('refuses a dropped epoch trigger even when the stored schema digest is unchanged', async () => {
    const fixture = await owned();
    fixture.service.commit(scopeA, command(scopeA));
    fixture.store.close();
    const raw = new DatabaseSync(fixture.file);
    try {
      const metadata = raw.prepare('SELECT version, name, digest FROM memory_schema').all();
      raw.exec('DROP TRIGGER memory_epochs_monotonic');
      expect(raw.prepare('SELECT version, name, digest FROM memory_schema').all()).toEqual(metadata);
      expect(raw.prepare("SELECT name FROM sqlite_schema WHERE type = 'trigger' AND name = 'memory_epochs_monotonic'").get())
        .toBeUndefined();
    } finally { raw.close(); }
    const before = await readFile(fixture.file);
    await expect(LocalMemoryStore.open({ path: fixture.file }).then(opened => opened.close()))
      .rejects.toMatchObject({ code: 'unsupported_memory_schema' });
    expect(await readFile(fixture.file)).toEqual(before);
  });
});

describe('W01 backup round trips and independent epoch floors', () => {
  it('round trips revisions, aliases, replay identities and outbox acknowledgements', async () => {
    const origin = await owned();
    const input = command(scopeA);
    const first = origin.service.commit(scopeA, input);
    origin.service.commit(scopeA, entityCommand('person', 'Alex'));
    origin.service.commit(scopeB, command(scopeB));
    origin.service.acknowledge(scopeA, 'indexer', first.event.sequence);
    const backup = origin.store.backup();
    const target = await owned();
    target.store.restore(backup, [{ scope: keyOf(scopeA), epochs }, { scope: keyOf(scopeB), epochs }]);
    await target.reopen();
    expect(target.store.backup().scopes).toEqual(backup.scopes);
    expect(target.service.commit(scopeA, input)).toEqual(first);
    expect(target.service.aliases(scopeA, 'Alex')).toMatchObject({ status: 'unique', entities: [{ id: 'person' }] });
    expect(target.service.acknowledged(scopeA, 'indexer')).toBe(first.event.sequence);
  });

  it('requires an independent floor for every restored scope before inserting any scope', async () => {
    const origin = await owned();
    origin.service.commit(scopeA, command(scopeA));
    origin.service.commit(scopeB, command(scopeB));
    const target = await owned();
    expect(() => target.store.restore(origin.store.backup(), [{ scope: keyOf(scopeA), epochs }])).toThrow('restore_conflict');
    expect(target.store.backup().scopes).toEqual([]);
    expect(() => target.store.restore(origin.store.backup(), [])).toThrow('restore_conflict');
  });

  it('refuses restore above the configured transaction byte limit without partial scopes', async () => {
    const origin = await owned();
    origin.service.commit(scopeA, command(scopeA));
    origin.service.commit(scopeB, command(scopeB));
    const backup = origin.store.backup();
    expect(Buffer.byteLength(JSON.stringify(backup), 'utf8')).toBeGreaterThan(512);
    const target = await owned({ limits: { maxTransactionBytes: 512 } });
    expect(() => target.store.restore(backup, [
      { scope: keyOf(scopeA), epochs }, { scope: keyOf(scopeB), epochs },
    ])).toThrow('memory_capacity');
    expect(target.store.backup().scopes).toEqual([]);
    expect(target.store.snapshot(keyOf(scopeA))).toBeNull();
    expect(target.store.snapshot(keyOf(scopeB))).toBeNull();
  });

  it.each(['identityGeneration', 'accessEpoch', 'deletionEpoch'] as const)
  ('does not resurrect an old %s through backup restore or command replay', async component => {
    const origin = await owned();
    const input = command(scopeA);
    origin.service.commit(scopeA, input);
    const backup = origin.store.backup();
    const current = { ...epochs, [component]: epochs[component] + 1 };
    const target = await owned();
    target.setAuthority(scopeA, current);
    target.store.restore(backup, [{ scope: keyOf(scopeA), epochs: current }]);
    await target.reopen();
    expect(target.store.snapshot(keyOf(scopeA))?.epochs).toEqual(current);
    expect(() => target.service.snapshot(scopeA)).toThrow('revoked_epoch');
    expect(() => target.service.commit(scopeA, input)).toThrow('revoked_epoch');
    const inspection = target.service.read({ ...scopeA, ...current }, { validAt: T2 });
    expect(inspection.records).toEqual([]);
    expect(inspection.snapshot.entries).toEqual([]);
    expect(inspection.snapshot.suppression).toEqual({ omittedEntries: 1 });
    // Suppression at this service boundary is not full W02 forgetting or purge proof.
    expect(target.store.snapshot(keyOf(scopeA))?.entries[0].epochs).toEqual(epochs);
  });

  it('takes componentwise epoch maxima and refuses later attempts to lower any component', async () => {
    const origin = await owned();
    origin.service.commit(scopeA, command(scopeA));
    const target = await owned();
    const lowerAndHigher = { identityGeneration: 0, accessEpoch: 4, deletionEpoch: 1 };
    target.store.restore(origin.store.backup(), [{ scope: keyOf(scopeA), epochs: lowerAndHigher }]);
    const maximum = { identityGeneration: 1, accessEpoch: 4, deletionEpoch: 3 };
    expect(target.store.snapshot(keyOf(scopeA))?.epochs).toEqual(maximum);
    expect(() => target.store.transaction(keyOf(scopeA), tx => tx.advanceEpochs({ ...maximum, deletionEpoch: 2 })))
      .toThrow('revoked_epoch');
    expect(target.store.snapshot(keyOf(scopeA))?.epochs).toEqual(maximum);
  });

  it('refuses restoring over a populated target and preserves its higher suppression frontier', async () => {
    const origin = await owned();
    origin.service.commit(scopeA, command(scopeA));
    const target = await owned();
    const newer = { ...epochs, deletionEpoch: 10 };
    target.setAuthority(scopeA, newer);
    target.service.advanceEpochs(keyOf(scopeA), newer);
    const before = target.store.backup().scopes;
    expect(() => target.store.restore(origin.store.backup(), [{ scope: keyOf(scopeA), epochs: newer }])).toThrow('restore_conflict');
    expect(target.store.backup().scopes).toEqual(before);
  });

  it('rejects backup corruption atomically when event and command identities disagree', async () => {
    const origin = await owned();
    origin.service.commit(scopeA, command(scopeA));
    const corrupt = origin.store.backup();
    corrupt.scopes[0].events[0].commandId = 'invented-command';
    const target = await owned();
    expect(() => target.store.restore(corrupt, [{ scope: keyOf(scopeA), epochs }])).toThrow();
    expect(target.store.backup().scopes).toEqual([]);
  });

  it('refuses a forged command fingerprint during restore before exposing any restored scope', async () => {
    const origin = await owned();
    origin.service.commit(scopeA, command(scopeA));
    const corrupt = origin.store.backup();
    corrupt.scopes[0].commands[0].fingerprint = '0'.repeat(64);
    const target = await owned();
    expect(() => target.store.restore(corrupt, [{ scope: keyOf(scopeA), epochs }])).toThrow('command_conflict');
    expect(target.store.backup().scopes).toEqual([]);
  });

  it('retains current suppression floors for scopes absent from an older backup', async () => {
    const origin = await owned();
    origin.service.commit(scopeA, command(scopeA));
    const target = await owned();
    const later = { ...epochs, deletionEpoch: 100 };
    target.store.restore(origin.store.backup(), [
      { scope: keyOf(scopeA), epochs }, { scope: keyOf(scopeB), epochs: later },
    ]);
    expect(target.store.snapshot(keyOf(scopeB))).toMatchObject({ epochs: later, entries: [], sequence: 0 });
  });
});
