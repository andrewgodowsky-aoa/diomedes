import { createHash } from 'node:crypto';
import type {
  MemoryChangeEvent, MemoryCommandReceipt, MemoryEpochs, MemoryLedgerBackup,
  MemoryLedgerCommand, MemoryLedgerEntry, MemoryLedgerScope, MemoryLedgerSnapshot, MemoryScopeKey,
} from '../../shared/memory-ledger.js';

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === 'object') return Object.fromEntries(
    Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
      .map(([name, child]) => [name, canonical(child)]),
  );
  return value;
}

/** Stable across property ordering and retry time, bound to exact host scope. */
export function memoryCommandFingerprint(scope: MemoryLedgerScope, command: MemoryLedgerCommand): string {
  return createHash('sha256').update(JSON.stringify(canonical({ scope, command }))).digest('hex');
}

export type MemoryLedgerErrorCode = 'memory_unavailable' | 'memory_not_found_or_forbidden' |
  'revision_conflict' | 'command_conflict' | 'revoked_epoch' | 'invalid_source_reference' |
  'invalid_memory' | 'memory_capacity' | 'unsupported_memory_schema' | 'restore_conflict';
export class MemoryLedgerError extends Error {
  constructor(readonly code: MemoryLedgerErrorCode) {
    super(code);
    this.name = 'MemoryLedgerError';
  }
}

export interface MemoryTransaction {
  epochs(): MemoryEpochs | null;
  /** Componentwise monotonic; lowering any existing component is refused. */
  advanceEpochs(next: MemoryEpochs): void;
  latest(kind: MemoryLedgerEntry['kind'], id: string): MemoryLedgerEntry | null;
  history(kind: MemoryLedgerEntry['kind'], id: string): MemoryLedgerEntry[];
  revision(kind: MemoryLedgerEntry['kind'], id: string, revision: number): MemoryLedgerEntry | null;
  command(commandId: string): MemoryCommandReceipt | null;
  nextSequence(): number;
  /** Immutable insert; adapter checks scope, identity and referenced rows as well. */
  insert(entry: MemoryLedgerEntry): void;
  appendEvent(event: MemoryChangeEvent): void;
  saveCommand(receipt: MemoryCommandReceipt): void;
}

export interface MemoryStore {
  /** Synchronous, short-lived callback; Promise results and escaped handles refuse. */
  transaction<T>(scope: MemoryScopeKey, operation: (tx: MemoryTransaction) => T): T;
  snapshot(scope: MemoryScopeKey, throughSequence?: number): MemoryLedgerSnapshot | null;
  outbox(scope: MemoryScopeKey, afterSequence: number, limit: number): MemoryChangeEvent[];
  acknowledge(scope: MemoryScopeKey, consumerId: string, throughSequence: number): void;
  acknowledged(scope: MemoryScopeKey, consumerId: string): number;
  backup(): MemoryLedgerBackup;
  /** Empty target only; every backup scope needs an independently supplied current floor. */
  restore(backup: MemoryLedgerBackup, authorityFloors: readonly {
    scope: MemoryScopeKey; epochs: MemoryEpochs;
  }[]): void;
  close(): void;
}

export type MemoryFaultPoint = 'after-entry' | 'after-event' | 'before-commit';
export interface LocalMemoryStoreOptions {
  path: string;
  limits?: Partial<{
    maxDatabaseBytes: number; maxWalBytes: number; maxTransactionBytes: number;
    maxSnapshotEntries: number; maxBackupBytes: number; maxOutboxPage: number;
  }>;
  /** Test-only synchronous injection. No hook may do model, network or awaited work. */
  fault?: (point: MemoryFaultPoint) => void;
}
