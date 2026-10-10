/** Explicitly opened local ledger; importing this module opens no profile. */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, statSync } from 'node:fs';
import path from 'node:path';
import type { DatabaseSync, SQLOutputValue } from 'node:sqlite';
import { ZodError } from 'zod';
import {
  memoryChangeEventSchema, memoryCommandReceiptSchema, memoryEpochsSchema, memoryInstantSchema,
  memoryLedgerBackupSchema, memoryLedgerEntrySchema, memoryScopeKeySchema,
  type MemoryChangeEvent, type MemoryCommandReceipt, type MemoryEpochs,
  type MemoryLedgerBackup, type MemoryLedgerEntry, type MemoryLedgerSnapshot,
  type MemoryScopeKey,
} from '../../shared/memory-ledger.js';
import { memoryContractText, type SourceRef } from '../../shared/memory.js';
import {
  MemoryLedgerError, memoryCommandFingerprint, type LocalMemoryStoreOptions, type MemoryFaultPoint,
  type MemoryStore, type MemoryTransaction,
} from './store.js';
import {
  MEMORY_SQLITE_APPLICATION_ID, MEMORY_SQLITE_INITIAL_SCHEMA, MEMORY_SQLITE_SCHEMA_VERSION,
} from './schema.js';

const WHERE_SCOPE = 'tenant_id = ? AND workspace_id = ? AND scope_ref = ?';
// Every object is compared, reserved sqlite_ names included: LIKE reads `_` as any character, and a
// crafted file can hold any name, so no name is trusted to mean internal. The reference database is
// built by this same runtime, so its automatic indexes match a genuine file's.
const SCHEMA_OBJECTS = 'SELECT type, name, tbl_name, sql FROM sqlite_schema ORDER BY type, name, tbl_name, sql';
const SCHEMA_DIGEST = createHash('sha256').update(MEMORY_SQLITE_INITIAL_SCHEMA).digest('hex');
const DEFAULT_LIMITS = {
  maxDatabaseBytes: 64 * 1024 * 1024, maxWalBytes: 80 * 1024 * 1024,
  maxTransactionBytes: 4 * 1024 * 1024, maxSnapshotEntries: 10_000,
  maxBackupBytes: 32 * 1024 * 1024, maxOutboxPage: 1000,
};
type Row = Record<string, SQLOutputValue>;
const key = (scope: MemoryScopeKey) => [scope.tenantId, scope.workspaceId, scope.scopeRef];
const equal = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);
const sameEpochs = (a: MemoryEpochs, b: MemoryEpochs) => a.identityGeneration === b.identityGeneration &&
  a.accessEpoch === b.accessEpoch && a.deletionEpoch === b.deletionEpoch;
const atLeast = (a: MemoryEpochs, b: MemoryEpochs) => a.identityGeneration >= b.identityGeneration &&
  a.accessEpoch >= b.accessEpoch && a.deletionEpoch >= b.deletionEpoch;
// An explicit type, so a bare `fail(...)` statement narrows the way `return fail(...)` does.
const fail: (code: ConstructorParameters<typeof MemoryLedgerError>[0]) => never = code => {
  throw new MemoryLedgerError(code);
};
const safeInteger = (n: number, min = 0) => {
  if (!Number.isSafeInteger(n) || n < min) fail('invalid_memory');
  return n;
};
function parse<T>(schema: { parse(value: unknown): T }, value: unknown): T {
  try { return schema.parse(value); }
  catch (error) {
    if (error instanceof ZodError) return fail('invalid_memory');
    throw error;
  }
}
function scopeKey(input: MemoryScopeKey): MemoryScopeKey {
  return parse(memoryScopeKeySchema, {
    tenantId: input?.tenantId, workspaceId: input?.workspaceId, scopeRef: input?.scopeRef,
  });
}
function number(row: Row | undefined, field: string): number {
  const value = row?.[field];
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) return fail('memory_unavailable');
  return value;
}
function json<T>(row: Row, field: string, schema: { parse(value: unknown): T }): T {
  if (typeof row[field] !== 'string') return fail('memory_unavailable');
  try { return schema.parse(JSON.parse(row[field])); }
  catch { return fail('memory_unavailable'); }
}
function epochs(row: Row): MemoryEpochs {
  return { identityGeneration: number(row, 'identity_generation'), accessEpoch: number(row, 'access_epoch'),
    deletionEpoch: number(row, 'deletion_epoch') };
}
function entry(row: Row): MemoryLedgerEntry {
  let payload: unknown;
  if (typeof row.payload !== 'string') return fail('memory_unavailable');
  try { payload = JSON.parse(row.payload); } catch { return fail('memory_unavailable'); }
  return parse(memoryLedgerEntrySchema, {
    kind: row.kind, id: row.id, revision: row.revision, sequence: row.sequence,
    recordedAt: row.recorded_at, epochs: epochs(row), payload,
  });
}
function translated(error: unknown): never {
  if (error instanceof MemoryLedgerError) throw error;
  if (error instanceof Error && 'errcode' in error && Number(error.errcode) % 256 === 13)
    throw new MemoryLedgerError('memory_capacity');
  throw error;
}

export class LocalMemoryStore implements MemoryStore {
  private closed = false;
  private active = false;
  private readonly limits: typeof DEFAULT_LIMITS;
  private constructor(private readonly db: DatabaseSync, private readonly options: LocalMemoryStoreOptions) {
    this.limits = { ...DEFAULT_LIMITS, ...options.limits };
  }

  static async open(options: LocalMemoryStoreOptions): Promise<LocalMemoryStore> {
    if (typeof options.path !== 'string' || (!path.isAbsolute(options.path) && options.path !== ':memory:'))
      return fail('invalid_memory');
    const limits = { ...DEFAULT_LIMITS, ...options.limits };
    for (const limit of Object.values(limits)) safeInteger(limit, 1);
    // Keep even caller-selected ceilings finite; this adapter is not bulk object storage.
    if (limits.maxDatabaseBytes > 1024 ** 3 || limits.maxTransactionBytes > 64 * 1024 ** 2 ||
        limits.maxBackupBytes > 128 * 1024 ** 2 || limits.maxSnapshotEntries > 100_000 ||
        limits.maxOutboxPage > 10_000 || limits.maxWalBytes > 2 * 1024 ** 3)
      return fail('memory_capacity');
    let sqlite: typeof import('node:sqlite');
    try { sqlite = await import('node:sqlite'); }
    catch { return fail('memory_unavailable'); }
    // SQLite normalizes CREATE text. Derive the comparison through this exact
    // runtime instead of trusting a checksum row inside the file being opened.
    const reference = new sqlite.DatabaseSync(':memory:', { allowExtension: false });
    let expectedSchema: Row[];
    try {
      reference.exec(MEMORY_SQLITE_INITIAL_SCHEMA);
      expectedSchema = reference.prepare(SCHEMA_OBJECTS).all();
    } finally { reference.close(); }
    // Check unfamiliar files through a read-only connection before changing any pragma.
    if (options.path !== ':memory:' && existsSync(options.path)) {
      const read = new sqlite.DatabaseSync(options.path, { readOnly: true, allowExtension: false });
      try { LocalMemoryStore.inspectSchema(read, expectedSchema); } finally { read.close(); }
    }
    if (options.path !== ':memory:') mkdirSync(path.dirname(options.path), { recursive: true, mode: 0o700 });
    const db = new sqlite.DatabaseSync(options.path, {
      enableForeignKeyConstraints: true, enableDoubleQuotedStringLiterals: false, allowExtension: false,
    });
    try {
      LocalMemoryStore.inspectSchema(db, expectedSchema);
      const version = String(db.prepare('SELECT sqlite_version() AS version').get()?.version ?? '');
      const parts = version.split('.').map(Number);
      if (parts.length !== 3 || parts.some(n => !Number.isSafeInteger(n)) || parts[0] !== 3 ||
          parts[1] < 51 || (parts[1] === 51 && parts[2] < 3)) fail('memory_unavailable');
      db.exec('PRAGMA foreign_keys = ON; PRAGMA trusted_schema = OFF; PRAGMA busy_timeout = 100;');
      db.exec('PRAGMA synchronous = FULL; PRAGMA cache_size = -4096; PRAGMA cache_spill = OFF;');
      const pageSize = number(db.prepare('PRAGMA page_size').get(), 'page_size');
      const maxPages = Math.floor(limits.maxDatabaseBytes / pageSize);
      if (maxPages < 32 || number(db.prepare('PRAGMA page_count').get(), 'page_count') > maxPages)
        fail('memory_capacity');
      db.exec(`PRAGMA max_page_count = ${maxPages}; PRAGMA journal_size_limit = 0;`);
      const mode = db.prepare('PRAGMA journal_mode = WAL').get()?.journal_mode;
      if (mode !== 'wal' && !(options.path === ':memory:' && mode === 'memory')) fail('memory_unavailable');
      db.exec('PRAGMA wal_autocheckpoint = 100;');
      if (number(db.prepare('PRAGMA user_version').get(), 'user_version') === 0) {
        // Creating the schema is a write like any other, so it takes the same WAL reservation.
        LocalMemoryStore.checkpoint(db);
        db.exec('BEGIN IMMEDIATE');
        try {
          LocalMemoryStore.reserveWal(db, options.path, limits);
          // A competing initializer may have committed after the first inspection.
          LocalMemoryStore.inspectSchema(db, expectedSchema);
          if (number(db.prepare('PRAGMA user_version').get(), 'user_version') === 0) {
            db.exec(MEMORY_SQLITE_INITIAL_SCHEMA);
            db.prepare('INSERT INTO memory_schema VALUES (?, ?, ?)').run(1, 'initial-memory-ledger', SCHEMA_DIGEST);
            db.exec(`PRAGMA application_id = ${MEMORY_SQLITE_APPLICATION_ID}; PRAGMA user_version = 1;`);
          }
          db.exec('COMMIT');
        } catch (error) {
          if (db.isTransaction) db.exec('ROLLBACK');
          throw error;
        }
      }
      LocalMemoryStore.inspectSchema(db, expectedSchema);
      if (db.prepare('PRAGMA quick_check').get()?.quick_check !== 'ok' ||
          db.prepare('PRAGMA foreign_key_check').get()) fail('memory_unavailable');
      return new LocalMemoryStore(db, { ...options, limits });
    } catch (error) {
      db.close();
      return translated(error);
    }
  }

  private static inspectSchema(db: DatabaseSync, expectedSchema: Row[]): void {
    const version = number(db.prepare('PRAGMA user_version').get(), 'user_version');
    const application = number(db.prepare('PRAGMA application_id').get(), 'application_id');
    if (version === 0) {
      if (application !== 0 || db.prepare('SELECT 1 FROM sqlite_schema LIMIT 1').get())
        fail('unsupported_memory_schema');
      return;
    }
    if (version !== MEMORY_SQLITE_SCHEMA_VERSION || application !== MEMORY_SQLITE_APPLICATION_ID)
      fail('unsupported_memory_schema');
    const actualSchema = db.prepare(`${SCHEMA_OBJECTS} LIMIT ?`).all(expectedSchema.length + 1);
    if (!equal(actualSchema, expectedSchema)) fail('unsupported_memory_schema');
    const migration = db.prepare('SELECT version, name, digest FROM memory_schema').all();
    if (migration.length !== 1 || migration[0].version !== 1 || migration[0].name !== 'initial-memory-ledger' ||
        migration[0].digest !== SCHEMA_DIGEST) fail('unsupported_memory_schema');
  }
  private static checkpoint(db: DatabaseSync): void {
    // No read handle escapes this adapter. A foreign long reader must release its
    // snapshot before another write may grow the WAL.
    const checkpoint = db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get();
    if (checkpoint && Number(checkpoint.busy) !== 0) fail('memory_unavailable');
  }
  /** Inside a write transaction, before it writes: every write, initialization included, fits the WAL ceiling. */
  private static reserveWal(db: DatabaseSync, file: string, limits: typeof DEFAULT_LIMITS): void {
    const wal = file === ':memory:' ? null : `${file}-wal`;
    const walBytes = wal && existsSync(wal) ? statSync(wal).size : 0;
    const pageSize = number(db.prepare('PRAGMA page_size').get(), 'page_size');
    // With spilling disabled one transaction writes at most one WAL frame per
    // database page. Reserve that worst case before invoking the callback.
    const maximumFrames = Math.floor(limits.maxDatabaseBytes / pageSize);
    if (walBytes + 32 + maximumFrames * (pageSize + 24) > limits.maxWalBytes)
      fail('memory_capacity');
  }

  private available(): void {
    if (this.closed || this.active) fail('memory_unavailable');
  }
  private scopeRow(scope: MemoryScopeKey): Row | undefined {
    return this.db.prepare(`SELECT * FROM memory_scopes WHERE ${WHERE_SCOPE}`).get(...key(scope));
  }
  private readEntry(scope: MemoryScopeKey, kind: MemoryLedgerEntry['kind'], id: string, revision?: number) {
    const row = revision === undefined
      ? this.db.prepare(`SELECT * FROM memory_entries WHERE ${WHERE_SCOPE} AND kind = ? AND id = ?
          ORDER BY revision DESC LIMIT 1`).get(...key(scope), kind, id)
      : this.db.prepare(`SELECT * FROM memory_entries WHERE ${WHERE_SCOPE} AND kind = ? AND id = ? AND revision = ?`)
        .get(...key(scope), kind, id, revision);
    return row ? entry(row) : null;
  }
  private charge(value: unknown, used: { bytes: number }, maximum = this.limits.maxTransactionBytes): void {
    used.bytes += Buffer.byteLength(JSON.stringify(value), 'utf8');
    if (used.bytes > maximum) fail('memory_capacity');
  }
  private fault(point: MemoryFaultPoint): void {
    const result: unknown = this.options.fault?.(point);
    if (result && typeof result === 'object' && 'then' in result) fail('invalid_memory');
  }
  private write<T>(operation: () => T): T {
    this.available();
    LocalMemoryStore.checkpoint(this.db);
    this.db.exec('BEGIN IMMEDIATE');
    this.active = true;
    try {
      LocalMemoryStore.reserveWal(this.db, this.options.path, this.limits);
      const result = operation();
      if (result && (typeof result === 'object' || typeof result === 'function') && 'then' in result)
        fail('invalid_memory');
      this.fault('before-commit');
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      try { if (this.db.isTransaction) this.db.exec('ROLLBACK'); }
      catch (rollbackError) {
        this.db.close(); this.closed = true;
        throw new AggregateError([error, rollbackError], 'memory_transaction_failed');
      }
      return translated(error);
    } finally { this.active = false; }
  }

  transaction<T>(scopeInput: MemoryScopeKey, operation: (tx: MemoryTransaction) => T): T {
    const scope = scopeKey(scopeInput);
    return this.write(() => {
      let alive = true;
      const used = { bytes: 0 };
      const allocated = new Set<number>();
      const inserted = new Set<number>();
      const guard = () => { if (!alive || !this.active) fail('invalid_memory'); };
      const readCommand = (commandId: string) => {
        const row = this.db.prepare(`SELECT receipt_json FROM memory_commands WHERE ${WHERE_SCOPE} AND command_id = ?`)
          .get(...key(scope), commandId);
        return row ? json(row, 'receipt_json', memoryCommandReceiptSchema) : null;
      };
      const tx: MemoryTransaction = {
        epochs: () => { guard(); const row = this.scopeRow(scope); return row ? epochs(row) : null; },
        advanceEpochs: input => {
          guard(); const next = parse(memoryEpochsSchema, input);
          this.charge({ scope, epochs: next }, used);
          const previous = this.scopeRow(scope);
          if (previous && !atLeast(next, epochs(previous))) fail('revoked_epoch');
          this.db.prepare(`INSERT INTO memory_scopes VALUES (?, ?, ?, ?, ?, ?, 0)
            ON CONFLICT (tenant_id, workspace_id, scope_ref) DO UPDATE SET
            identity_generation = excluded.identity_generation, access_epoch = excluded.access_epoch,
            deletion_epoch = excluded.deletion_epoch`).run(...key(scope), next.identityGeneration, next.accessEpoch, next.deletionEpoch);
        },
        latest: (kind, id) => { guard(); return this.readEntry(scope, kind, id); },
        history: (kind, id) => {
          guard();
          const rows = this.db.prepare(`SELECT * FROM memory_entries WHERE ${WHERE_SCOPE} AND kind = ? AND id = ?
            ORDER BY revision LIMIT ?`).all(...key(scope), kind, id, this.limits.maxSnapshotEntries + 1);
          if (rows.length > this.limits.maxSnapshotEntries) fail('memory_capacity');
          return rows.map(entry);
        },
        revision: (kind, id, revision) => { guard(); safeInteger(revision, 1); return this.readEntry(scope, kind, id, revision); },
        command: commandId => { guard(); return readCommand(commandId); },
        nextSequence: () => {
          guard(); const row = this.scopeRow(scope);
          if (!row) return fail('revoked_epoch');
          const sequence = safeInteger(number(row, 'sequence') + 1, 1);
          this.db.prepare(`UPDATE memory_scopes SET sequence = ? WHERE ${WHERE_SCOPE}`).run(sequence, ...key(scope));
          allocated.add(sequence); return sequence;
        },
        insert: input => {
          guard(); const next = parse(memoryLedgerEntrySchema, input);
          this.charge(next, used);
          if (next.payload.kind === 'record') {
            const record = next.payload.value.record;
            if (record.tenantId !== scope.tenantId || record.workspaceId !== scope.workspaceId || record.scopeRef !== scope.scopeRef)
              fail('memory_not_found_or_forbidden');
          }
          const state = this.scopeRow(scope);
          if (!state || !sameEpochs(next.epochs, epochs(state))) fail('revoked_epoch');
          if (!allocated.has(next.sequence) || inserted.has(next.sequence)) fail('revision_conflict');
          this.insertEntry(scope, next);
          inserted.add(next.sequence); this.fault('after-entry');
        },
        appendEvent: input => {
          guard(); const next = parse(memoryChangeEventSchema, input);
          this.charge(next, used);
          if (!inserted.has(next.sequence)) fail('invalid_memory');
          this.insertEvent(scope, next); this.fault('after-event');
        },
        saveCommand: input => {
          guard(); const next = parse(memoryCommandReceiptSchema, input);
          this.charge(next, used);
          if (!inserted.has(next.result.entry.sequence)) fail('invalid_memory');
          this.insertCommand(scope, next);
        },
      };
      try {
        const result = operation(tx);
        if (allocated.size !== inserted.size) fail('invalid_memory');
        for (const sequence of inserted) {
          const committed = this.db.prepare(`SELECT e.identity_generation, e.access_epoch, e.deletion_epoch
            FROM memory_entries e WHERE ${WHERE_SCOPE} AND sequence = ?`).get(...key(scope), sequence);
          const state = this.scopeRow(scope);
          if (!committed || !state || !sameEpochs(epochs(committed), epochs(state))) fail('revoked_epoch');
          const linked = this.db.prepare(`SELECT 1 FROM memory_entries e
            JOIN memory_events v USING (tenant_id, workspace_id, scope_ref, sequence)
            JOIN memory_commands c USING (tenant_id, workspace_id, scope_ref, sequence)
            WHERE e.tenant_id = ? AND e.workspace_id = ? AND e.scope_ref = ? AND e.sequence = ?
            AND v.command_id = c.command_id`).get(...key(scope), sequence);
          if (!linked) fail('invalid_memory');
        }
        return result;
      } finally { alive = false; }
    });
  }

  private insertEntry(scope: MemoryScopeKey, next: MemoryLedgerEntry): void {
    const payload = next.payload;
    const value = payload.kind === 'record' ? payload.value.record : payload.value;
    if (next.kind !== payload.kind || next.id !== value.id || next.revision !== value.revision)
      fail('invalid_memory');
    const prior = this.readEntry(scope, next.kind, next.id);
    if (next.revision !== (prior?.revision ?? 0) + 1) fail('revision_conflict');
    const last = this.db.prepare(`SELECT sequence, recorded_at FROM memory_entries WHERE ${WHERE_SCOPE}
      ORDER BY sequence DESC LIMIT 1`).get(...key(scope));
    if (next.sequence !== (last ? number(last, 'sequence') : 0) + 1 ||
        (last && (typeof last.recorded_at !== 'string' || next.recordedAt < last.recorded_at)))
      fail('revision_conflict');
    if (payload.kind === 'record') {
      const record = payload.value.record;
      if (record.tenantId !== scope.tenantId || record.workspaceId !== scope.workspaceId || record.scopeRef !== scope.scopeRef)
        fail('memory_not_found_or_forbidden');
      if (record.accessEpoch !== next.epochs.accessEpoch || record.deletionEpoch !== next.epochs.deletionEpoch)
        fail('revoked_epoch');
      parse(memoryInstantSchema, record.createdAt);
      if (record.validFrom !== null) parse(memoryInstantSchema, record.validFrom);
      if (record.validTo !== null) parse(memoryInstantSchema, record.validTo);
      if (record.validFrom !== null && record.validTo !== null && record.validFrom >= record.validTo)
        fail('invalid_memory');
      if (prior?.payload.kind === 'record' && record.createdAt !== prior.payload.value.record.createdAt)
        fail('invalid_memory');
      if (payload.value.changeMode === 'effective-from' && (!prior || record.validFrom === null))
        fail('invalid_memory');
      if (!record.sources.length || (record.epistemic === 'inferred' && payload.value.authorityRef !== null))
        fail('invalid_source_reference');
      if (!equal([...record.dependencies].sort(), payload.value.dependencyRevisions.map(ref => ref.id).sort()) ||
          new Set(record.dependencies).size !== record.dependencies.length) fail('invalid_source_reference');
      for (const ref of payload.value.dependencyRevisions) {
        const dependency = this.readEntry(scope, 'record', ref.id, ref.revision);
        if (!dependency || ref.id === next.id) fail('invalid_source_reference');
        if (!sameEpochs(dependency.epochs, next.epochs)) fail('revoked_epoch');
      }
      if (payload.value.entityId !== null && !this.readEntry(scope, 'entity', payload.value.entityId))
        fail('invalid_source_reference');
    }
    if (payload.kind === 'conflict') {
      const refs = payload.value.claims;
      if (new Set(refs.map(ref => ref.id)).size !== refs.length) fail('invalid_source_reference');
      for (const ref of refs) if (!this.readEntry(scope, 'record', ref.id, ref.revision)) fail('invalid_source_reference');
    }
    if (payload.kind === 'entity' && (new Set(payload.value.aliases).size !== payload.value.aliases.length ||
        (prior?.payload.kind === 'entity' && prior.payload.value.kind !== payload.value.kind))) fail('invalid_memory');
    const sources = payload.kind === 'record' ? payload.value.record.sources : payload.kind === 'entity' ? payload.value.sources : [];
    this.validateSources(scope, sources);
    this.db.prepare('INSERT INTO memory_entries VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(...key(scope), next.kind, next.id, next.revision, next.sequence, next.recordedAt,
        next.epochs.identityGeneration, next.epochs.accessEpoch, next.epochs.deletionEpoch, JSON.stringify(payload));
    this.db.prepare(`INSERT INTO memory_heads VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT (tenant_id, workspace_id, scope_ref, kind, id) DO UPDATE SET revision = excluded.revision`)
      .run(...key(scope), next.kind, next.id, next.revision);
    sources.forEach((source, ordinal) => this.db.prepare('INSERT INTO memory_sources VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(...key(scope), next.kind, next.id, next.revision, ordinal, source.sourceId, source.revision, source.locator, JSON.stringify(source)));
    if (payload.kind === 'record') {
      for (const ref of payload.value.dependencyRevisions)
        this.db.prepare('INSERT INTO memory_dependencies VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
          .run(...key(scope), 'record', next.id, next.revision, 'record', ref.id, ref.revision);
      if (payload.value.entityId !== null)
        this.db.prepare('INSERT INTO memory_entity_links VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
          .run(...key(scope), 'record', next.id, next.revision, 'entity', payload.value.entityId);
    } else if (payload.kind === 'entity') {
      payload.value.aliases.forEach((alias, ordinal) => this.db.prepare('INSERT INTO memory_aliases VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(...key(scope), 'entity', next.id, next.revision, ordinal, alias));
    } else {
      for (const ref of payload.value.claims)
        this.db.prepare('INSERT INTO memory_conflict_claims VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
          .run(...key(scope), 'conflict', next.id, next.revision, 'record', ref.id, ref.revision);
    }
  }

  private validateSources(scope: MemoryScopeKey, sources: SourceRef[]): void {
    const observed = new Map<string, SourceRef>();
    for (const source of sources) {
      const identity = JSON.stringify([source.sourceId, source.revision, source.locator]);
      const duplicate = observed.get(identity);
      if (duplicate) fail('invalid_source_reference');
      observed.set(identity, source);
      const previous = this.db.prepare(`SELECT source_json FROM memory_sources WHERE ${WHERE_SCOPE}
        AND source_id = ? AND source_revision IS ? AND locator = ? LIMIT 1`)
        .get(...key(scope), source.sourceId, source.revision, source.locator);
      if (previous && previous.source_json !== JSON.stringify(source)) fail('invalid_source_reference');
    }
  }

  private insertEvent(scope: MemoryScopeKey, next: MemoryChangeEvent): void {
    const stored = this.readEntry(scope, next.kind, next.id, next.revision);
    if (!stored || stored.sequence !== next.sequence || stored.recordedAt !== next.recordedAt ||
        !sameEpochs(stored.epochs, next.epochs)) fail('invalid_memory');
    this.db.prepare('INSERT INTO memory_events VALUES (?, ?, ?, ?, ?, ?)')
      .run(...key(scope), next.sequence, next.commandId, JSON.stringify(next));
  }

  private insertCommand(scope: MemoryScopeKey, next: MemoryCommandReceipt): void {
    const receipt = next.result;
    const fingerprint = memoryCommandFingerprint({ ...scope, ...receipt.entry.epochs }, {
      commandId: next.commandId, expectedRevision: receipt.entry.revision - 1, payload: receipt.entry.payload,
    });
    if (fingerprint !== next.fingerprint) fail('command_conflict');
    const stored = this.readEntry(scope, receipt.entry.kind, receipt.entry.id, receipt.entry.revision);
    const eventRow = this.db.prepare(`SELECT event_json FROM memory_events WHERE ${WHERE_SCOPE} AND sequence = ?`)
      .get(...key(scope), receipt.entry.sequence);
    if (next.commandId !== receipt.commandId || receipt.commandId !== receipt.event.commandId ||
        !stored || !equal(stored, receipt.entry) || !eventRow ||
        !equal(json(eventRow, 'event_json', memoryChangeEventSchema), receipt.event)) fail('invalid_memory');
    const existing = this.db.prepare(`SELECT 1 FROM memory_commands WHERE ${WHERE_SCOPE} AND command_id = ?`)
      .get(...key(scope), next.commandId);
    if (existing) fail('command_conflict');
    this.db.prepare('INSERT INTO memory_commands VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(...key(scope), next.commandId, next.fingerprint, receipt.entry.sequence, JSON.stringify(next));
  }

  private read<T>(operation: () => T): T {
    this.available(); this.db.exec('BEGIN'); this.active = true;
    try { const result = operation(); this.db.exec('COMMIT'); return result; }
    catch (error) { if (this.db.isTransaction) this.db.exec('ROLLBACK'); throw error; }
    finally { this.active = false; }
  }
  private snapshotWithin(scope: MemoryScopeKey, throughSequence?: number): MemoryLedgerSnapshot | null {
    const row = this.scopeRow(scope);
    if (!row) return null;
    const latest = number(row, 'sequence');
    const sequence = throughSequence === undefined ? latest : safeInteger(throughSequence);
    if (sequence > latest) fail('revision_conflict');
    const rows = this.db.prepare(`SELECT * FROM memory_entries WHERE ${WHERE_SCOPE} AND sequence <= ?
      ORDER BY sequence LIMIT ?`).all(...key(scope), sequence, this.limits.maxSnapshotEntries + 1);
    if (rows.length > this.limits.maxSnapshotEntries) fail('memory_capacity');
    return { scope, epochs: epochs(row), sequence, entries: rows.map(entry) };
  }
  snapshot(scope: MemoryScopeKey, throughSequence?: number): MemoryLedgerSnapshot | null {
    const parsed = scopeKey(scope);
    return this.read(() => this.snapshotWithin(parsed, throughSequence));
  }
  outbox(scope: MemoryScopeKey, afterSequence: number, limit: number): MemoryChangeEvent[] {
    const parsed = scopeKey(scope);
    safeInteger(afterSequence); safeInteger(limit, 1);
    if (limit > this.limits.maxOutboxPage) fail('memory_capacity');
    return this.read(() => this.db.prepare(`SELECT event_json FROM memory_events WHERE ${WHERE_SCOPE}
      AND sequence > ? ORDER BY sequence LIMIT ?`).all(...key(parsed), afterSequence, limit)
      .map(row => json(row, 'event_json', memoryChangeEventSchema)));
  }
  acknowledge(scope: MemoryScopeKey, consumerId: string, throughSequence: number): void {
    const parsed = scopeKey(scope);
    parse(memoryContractText(512), consumerId); safeInteger(throughSequence);
    this.write(() => {
      this.charge({ scope: parsed, consumerId, throughSequence }, { bytes: 0 });
      const row = this.scopeRow(parsed);
      if (!row || throughSequence > number(row, 'sequence')) fail('revision_conflict');
      const old = this.db.prepare(`SELECT sequence FROM memory_acknowledgements WHERE ${WHERE_SCOPE} AND consumer_id = ?`)
        .get(...key(parsed), consumerId);
      if (old && throughSequence < number(old, 'sequence')) fail('revision_conflict');
      this.db.prepare(`INSERT INTO memory_acknowledgements VALUES (?, ?, ?, ?, ?)
        ON CONFLICT (tenant_id, workspace_id, scope_ref, consumer_id) DO UPDATE SET sequence = excluded.sequence`)
        .run(...key(parsed), consumerId, throughSequence);
    });
  }
  acknowledged(scope: MemoryScopeKey, consumerId: string): number {
    const parsed = scopeKey(scope); parse(memoryContractText(512), consumerId);
    return this.read(() => {
      const row = this.db.prepare(`SELECT sequence FROM memory_acknowledgements WHERE ${WHERE_SCOPE} AND consumer_id = ?`)
        .get(...key(parsed), consumerId);
      return row ? number(row, 'sequence') : 0;
    });
  }

  backup(): MemoryLedgerBackup {
    return this.read(() => {
      const result: MemoryLedgerBackup = { v: 1, createdAt: new Date().toISOString(), scopes: [] };
      const used = { bytes: 0 };
      for (const row of this.db.prepare('SELECT * FROM memory_scopes ORDER BY tenant_id, workspace_id, scope_ref').iterate()) {
        const scope = parse(memoryScopeKeySchema, { tenantId: row.tenant_id, workspaceId: row.workspace_id, scopeRef: row.scope_ref });
        const snapshot = this.snapshotWithin(scope)!;
        const commands = this.db.prepare(`SELECT receipt_json FROM memory_commands WHERE ${WHERE_SCOPE} ORDER BY sequence`)
          .all(...key(scope)).map(row => json(row, 'receipt_json', memoryCommandReceiptSchema));
        const events = this.db.prepare(`SELECT event_json FROM memory_events WHERE ${WHERE_SCOPE} ORDER BY sequence`)
          .all(...key(scope)).map(row => json(row, 'event_json', memoryChangeEventSchema));
        const acknowledgements = this.db.prepare(`SELECT consumer_id, sequence FROM memory_acknowledgements WHERE ${WHERE_SCOPE} ORDER BY consumer_id`)
          .all(...key(scope)).map(row => ({ consumerId: String(row.consumer_id), sequence: number(row, 'sequence') }));
        const saved = { ...snapshot, commands, events, acknowledgements };
        this.charge(saved, used, this.limits.maxBackupBytes); result.scopes.push(saved);
      }
      if (Buffer.byteLength(JSON.stringify(result), 'utf8') > this.limits.maxBackupBytes) fail('memory_capacity');
      return result;
    });
  }

  restore(input: MemoryLedgerBackup, authorityFloors: readonly { scope: MemoryScopeKey; epochs: MemoryEpochs }[]): void {
    const restoreSize = { bytes: 0 };
    const maximum = Math.min(this.limits.maxBackupBytes, this.limits.maxTransactionBytes);
    this.charge(input, restoreSize, maximum);
    this.charge(authorityFloors, restoreSize, maximum);
    if (authorityFloors.length > this.limits.maxSnapshotEntries) fail('memory_capacity');
    const backup = parse(memoryLedgerBackupSchema, input);
    const floors = new Map<string, { scope: MemoryScopeKey; epochs: MemoryEpochs }>();
    for (const floor of authorityFloors) {
      const scope = scopeKey(floor.scope);
      const scopeId = JSON.stringify(key(scope));
      if (floors.has(scopeId)) fail('restore_conflict');
      floors.set(scopeId, { scope, epochs: parse(memoryEpochsSchema, floor.epochs) });
    }
    this.write(() => {
      if (this.db.prepare('SELECT 1 FROM memory_scopes LIMIT 1').get()) fail('restore_conflict');
      const seen = new Set<string>();
      for (const saved of backup.scopes) {
        const scope = saved.scope;
        const scopeId = JSON.stringify(key(scope));
        const floor = floors.get(scopeId);
        if (!floor || seen.has(scopeId)) fail('restore_conflict');
        seen.add(scopeId);
        if (saved.entries.length > this.limits.maxSnapshotEntries || saved.entries.length !== saved.sequence ||
            saved.events.length !== saved.entries.length || saved.commands.length !== saved.entries.length)
          fail('restore_conflict');
        const retained = {
          identityGeneration: Math.max(floor.epochs.identityGeneration, saved.epochs.identityGeneration),
          accessEpoch: Math.max(floor.epochs.accessEpoch, saved.epochs.accessEpoch),
          deletionEpoch: Math.max(floor.epochs.deletionEpoch, saved.epochs.deletionEpoch),
        };
        this.db.prepare('INSERT INTO memory_scopes VALUES (?, ?, ?, ?, ?, ?, ?)')
          .run(...key(scope), retained.identityGeneration, retained.accessEpoch, retained.deletionEpoch, saved.sequence);
        for (let index = 0; index < saved.entries.length; index++) {
          const next = saved.entries[index];
          if (next.sequence !== index + 1 || !atLeast(saved.epochs, next.epochs) ||
              (index > 0 && !atLeast(next.epochs, saved.entries[index - 1].epochs))) fail('restore_conflict');
          this.insertEntry(scope, next);
          this.fault('after-entry');
        }
        for (const event of saved.events) { this.insertEvent(scope, event); this.fault('after-event'); }
        for (const command of saved.commands) this.insertCommand(scope, command);
        const consumers = new Set<string>();
        for (const acknowledgement of saved.acknowledgements) {
          if (acknowledgement.sequence > saved.sequence || consumers.has(acknowledgement.consumerId)) fail('restore_conflict');
          consumers.add(acknowledgement.consumerId);
          this.db.prepare('INSERT INTO memory_acknowledgements VALUES (?, ?, ?, ?, ?)')
            .run(...key(scope), acknowledgement.consumerId, acknowledgement.sequence);
        }
      }
      // A scope absent from an older backup can still have current revocations.
      for (const [scopeId, floor] of floors) {
        if (!seen.has(scopeId)) this.db.prepare('INSERT INTO memory_scopes VALUES (?, ?, ?, ?, ?, ?, 0)')
          .run(...key(floor.scope), floor.epochs.identityGeneration, floor.epochs.accessEpoch, floor.epochs.deletionEpoch);
      }
    });
  }

  close(): void {
    if (this.closed) return;
    this.available(); this.db.close(); this.closed = true;
  }
}
