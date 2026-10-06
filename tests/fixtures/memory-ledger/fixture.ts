import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { MemoryRecord, SourceRef } from '../../../shared/memory.js';
import type {
  MemoryEntity, MemoryEpochs, MemoryLedgerCommand, MemoryLedgerScope, MemoryScopeKey,
} from '../../../shared/memory-ledger.js';
import { LocalMemoryStore } from '../../../server/memory/local-store.js';
import { MemoryService } from '../../../server/memory/service.js';
import type { LocalMemoryStoreOptions } from '../../../server/memory/store.js';

export const T0 = '2026-10-01T00:00:00.000Z';
export const T1 = '2026-10-02T00:00:00.000Z';
export const T2 = '2026-10-03T00:00:00.000Z';
export const T3 = '2026-10-04T00:00:00.000Z';
export const T4 = '2026-10-05T00:00:00.000Z';
export const epochs: MemoryEpochs = { identityGeneration: 1, accessEpoch: 2, deletionEpoch: 3 };
export const scopeA: MemoryLedgerScope = {
  tenantId: 'fictional-a', workspaceId: 'workspace-a', scopeRef: 'location-east', ...epochs,
};
export const scopeB: MemoryLedgerScope = { ...scopeA, tenantId: 'fictional-b' };
export const scopeWest: MemoryLedgerScope = { ...scopeA, scopeRef: 'location-west' };
export const scopeOtherWorkspace: MemoryLedgerScope = { ...scopeA, workspaceId: 'workspace-other' };

export function keyOf(scope: MemoryScopeKey): MemoryScopeKey {
  return { tenantId: scope.tenantId, workspaceId: scope.workspaceId, scopeRef: scope.scopeRef };
}

export function source(overrides: Partial<SourceRef> = {}): SourceRef {
  return {
    sourceId: 'original-message', revision: '1', locator: 'message:1#span:0-42',
    sourceType: 'message', contentSha256: 'a'.repeat(64), observedAt: T0,
    accessPolicyRef: 'source-policy', restrictionsRef: 'local-only', ...overrides,
  };
}

export function record(scope: MemoryLedgerScope, overrides: Partial<MemoryRecord> = {}): MemoryRecord {
  return {
    v: 1, id: 'claim', revision: 1, tenantId: scope.tenantId, workspaceId: scope.workspaceId,
    accessEpoch: scope.accessEpoch, deletionEpoch: scope.deletionEpoch, createdAt: T0,
    recordType: 'memory', kind: 'fact', body: 'Original fictional policy.',
    lifecycle: 'active', epistemic: 'asserted', scopeRef: scope.scopeRef,
    restrictionsRef: 'local-only', sources: [source()], validFrom: T0, validTo: null,
    dependencies: [], retentionClass: 'explicit-save', ...overrides,
  };
}

export function command(
  scope: MemoryLedgerScope,
  overrides: Partial<MemoryRecord> = {},
  options: { commandId?: string; expectedRevision?: number; entityId?: string | null;
    authorityRef?: string | null; dependencyRevisions?: { id: string; revision: number }[];
    changeMode?: 'replace' | 'effective-from' } = {},
): MemoryLedgerCommand {
  const value = record(scope, overrides);
  return {
    commandId: options.commandId ?? `${value.id}:${value.revision}`,
    expectedRevision: options.expectedRevision ?? value.revision - 1,
    payload: { kind: 'record', value: {
      record: value, changeMode: options.changeMode ?? 'replace',
      entityId: options.entityId ?? null, authorityRef: options.authorityRef ?? null,
      dependencyRevisions: options.dependencyRevisions ?? [],
    } },
  };
}

export function entityCommand(id: string, alias: string, revision = 1, kind: MemoryEntity['kind'] = 'person'): MemoryLedgerCommand {
  return {
    commandId: `entity:${id}:${revision}`, expectedRevision: revision - 1,
    payload: { kind: 'entity', value: {
      id, revision, kind, aliases: [alias], sources: [source()],
    } },
  };
}

export function conflictCommand(id: string, claims: { id: string; revision: number }[]): MemoryLedgerCommand {
  return {
    commandId: `conflict:${id}:1`, expectedRevision: 0,
    payload: { kind: 'conflict', value: { id, revision: 1, claims, reason: 'Incompatible original claims.' } },
  };
}

const scopeKey = (scope: MemoryScopeKey) => JSON.stringify([scope.tenantId, scope.workspaceId, scope.scopeRef]);

async function removeOwnedDirectory(root: string) {
  const resolved = path.resolve(root);
  if (path.dirname(resolved) !== path.resolve(os.tmpdir()) ||
      !path.basename(resolved).startsWith('nectovia-memory-w01-')) {
    throw new Error('Refusing cleanup outside the owned temporary profile.');
  }
  await rm(resolved, { recursive: true, force: true });
}

/** Real SQLite only. Construction is deferred until an authorized test run. */
export async function openFixture(options: Omit<LocalMemoryStoreOptions, 'path'> = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nectovia-memory-w01-'));
  const file = path.join(root, 'ledger.sqlite');
  const floors = new Map<string, MemoryEpochs>();
  let now = T1;
  let store: LocalMemoryStore;
  try { store = await LocalMemoryStore.open({ path: file, ...options }); }
  catch (error) {
    await removeOwnedDirectory(root);
    throw error;
  }
  const serviceOptions = {
    currentEpochs: (scope: MemoryScopeKey): MemoryEpochs => ({ ...(floors.get(scopeKey(scope)) ?? epochs) }),
    now: () => now,
  };
  let service = new MemoryService(store, serviceOptions);
  return {
    root, file,
    get store() { return store; },
    get service() { return service; },
    setTime(value: string) { now = value; },
    setAuthority(scope: MemoryScopeKey, value: MemoryEpochs) { floors.set(scopeKey(scope), { ...value }); },
    async reopen(next: Omit<LocalMemoryStoreOptions, 'path'> = {}) {
      store.close();
      store = await LocalMemoryStore.open({ path: file, ...next });
      service = new MemoryService(store, serviceOptions);
    },
    async dispose() {
      store.close();
      await removeOwnedDirectory(root);
    },
  };
}

export type LedgerFixture = Awaited<ReturnType<typeof openFixture>>;
