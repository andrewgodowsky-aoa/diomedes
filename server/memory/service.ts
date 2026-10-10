import { ZodError, z } from 'zod';
import { memoryContractText, type MemoryRecord } from '../../shared/memory.js';
import {
  memoryEpochsSchema, memoryInstantSchema, memoryLedgerCommandSchema,
  memoryLedgerScopeSchema, memoryScopeKeySchema,
  type MemoryCommitReceipt, type MemoryConflict, type MemoryEntity, type MemoryEpochs,
  type MemoryLedgerCommand, type MemoryLedgerEntry, type MemoryLedgerScope,
  type MemoryLedgerSnapshot, type MemoryRevisionRef, type MemoryScopeKey,
} from '../../shared/memory-ledger.js';
import { memoryCommandFingerprint, MemoryLedgerError, type MemoryStore, type MemoryTransaction } from './store.js';
export { memoryCommandFingerprint } from './store.js';

const sameEpochs = (a: MemoryEpochs, b: MemoryEpochs) =>
  a.identityGeneration === b.identityGeneration && a.accessEpoch === b.accessEpoch &&
  a.deletionEpoch === b.deletionEpoch;
const identity = (entry: MemoryLedgerCommand['payload']) =>
  entry.kind === 'record' ? entry.value.record : entry.value;
const key = (scope: MemoryScopeKey) => memoryScopeKeySchema.parse({
  tenantId: scope.tenantId, workspaceId: scope.workspaceId, scopeRef: scope.scopeRef,
});
const epochs = (scope: MemoryEpochs) => memoryEpochsSchema.parse({
  identityGeneration: scope.identityGeneration, accessEpoch: scope.accessEpoch, deletionEpoch: scope.deletionEpoch,
});

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  try { return schema.parse(value); }
  catch (error) {
    if (error instanceof ZodError) throw new MemoryLedgerError('invalid_memory');
    throw error;
  }
}

export interface MemoryRecordView {
  entry: MemoryLedgerEntry;
  record: MemoryRecord;
  recordedTo: string | null;
  temporal: 'applicable' | 'unknown';
  fresh: boolean;
  /** Distinct original source versions, not mentions or generated retellings. */
  lineageCount: number;
}
export interface MemoryPolicyPrecedence { policyRef: string; authorityOrder: string[] }
export interface MemoryTemporalQuery { validAt: string; recordedAt?: string; throughSequence?: number }
export interface MemoryServiceSnapshot extends MemoryLedgerSnapshot {
  /** Suppressed bodies never leave this port; the omission remains explicit. */
  suppression: { omittedEntries: number };
  afterRecordedAtEntries: number;
}

/**
 * Host-side ledger port. The caller must resolve authenticated scope and source
 * access through Runtime/Trust. A matching epoch is necessary, not sufficient,
 * authorization. This service never dispatches inference, tools or effects.
 */
export class MemoryService {
  constructor(private readonly store: MemoryStore, private readonly options: {
    /** Required current frontier outside the ledger's backup/rollback boundary. */
    currentEpochs: (scope: MemoryScopeKey) => MemoryEpochs;
    now?: () => string;
  }) {}

  private current(scope: MemoryScopeKey): MemoryEpochs {
    return parse(memoryEpochsSchema, this.options.currentEpochs(key(scope)));
  }

  private admittedEpochs(scope: MemoryLedgerScope, saved: MemoryEpochs | null): MemoryEpochs {
    const current = this.current(scope);
    if (!sameEpochs(scope, current)) throw new MemoryLedgerError('revoked_epoch');
    if (saved && (saved.identityGeneration > current.identityGeneration ||
      saved.accessEpoch > current.accessEpoch || saved.deletionEpoch > current.deletionEpoch)) {
      throw new MemoryLedgerError('revoked_epoch');
    }
    return current;
  }

  private admit(scope: MemoryLedgerScope, tx: MemoryTransaction): void {
    const saved = tx.epochs();
    const current = this.admittedEpochs(scope, saved);
    if (!saved || !sameEpochs(saved, current)) tx.advanceEpochs(current);
  }

  private admitRead(scope: MemoryLedgerScope): MemoryLedgerSnapshot | null {
    const saved = this.store.snapshot(key(scope), 0);
    const current = this.admittedEpochs(scope, saved?.epochs ?? null);
    if (!saved || !sameEpochs(saved.epochs, current)) {
      this.store.transaction(key(scope), tx => this.admit(scope, tx));
      return null;
    }
    return saved;
  }

  private assertReadEpochs(scope: MemoryLedgerScope): void {
    const saved = this.store.snapshot(key(scope), 0);
    if (!saved || !sameEpochs(scope, saved.epochs) || !sameEpochs(scope, this.current(scope))) {
      throw new MemoryLedgerError('revoked_epoch');
    }
  }

  /** Persist a host suppression frontier. This method never establishes grants. */
  advanceEpochs(scopeValue: MemoryScopeKey, nextValue: MemoryEpochs): void {
    const scope = parse(memoryScopeKeySchema, scopeValue);
    const next = parse(memoryEpochsSchema, nextValue);
    if (!sameEpochs(next, this.current(scope))) throw new MemoryLedgerError('revoked_epoch');
    this.store.transaction(scope, tx => tx.advanceEpochs(next));
  }

  commit(scopeValue: MemoryLedgerScope, commandValue: MemoryLedgerCommand): MemoryCommitReceipt {
    const scope = parse(memoryLedgerScopeSchema, scopeValue);
    const command = parse(memoryLedgerCommandSchema, commandValue);
    const fingerprint = memoryCommandFingerprint(scope, command);
    return this.store.transaction(key(scope), tx => {
      this.admit(scope, tx);
      const prior = tx.command(command.commandId);
      if (prior) {
        if (prior.fingerprint !== fingerprint) throw new MemoryLedgerError('command_conflict');
        return structuredClone(prior.result);
      }
      const subject = identity(command.payload);
      const previous = tx.latest(command.payload.kind, subject.id);
      if ((previous?.revision ?? 0) !== command.expectedRevision ||
        subject.revision !== command.expectedRevision + 1) throw new MemoryLedgerError('revision_conflict');
      if (command.payload.kind === 'record') {
        const { record, changeMode, entityId, authorityRef, dependencyRevisions } = command.payload.value;
        if (record.tenantId !== scope.tenantId || record.workspaceId !== scope.workspaceId ||
          record.scopeRef !== scope.scopeRef) throw new MemoryLedgerError('memory_not_found_or_forbidden');
        if (record.accessEpoch !== scope.accessEpoch || record.deletionEpoch !== scope.deletionEpoch) {
          throw new MemoryLedgerError('revoked_epoch');
        }
        parse(memoryInstantSchema, record.createdAt);
        if (record.validFrom !== null) parse(memoryInstantSchema, record.validFrom);
        if (record.validTo !== null) parse(memoryInstantSchema, record.validTo);
        if (changeMode === 'effective-from' && (!previous || record.validFrom === null)) {
          throw new MemoryLedgerError('invalid_memory');
        }
        if (record.validFrom !== null && record.validTo !== null && record.validFrom >= record.validTo) {
          throw new MemoryLedgerError('invalid_memory');
        }
        if (!record.sources.length || (record.epistemic === 'inferred' && authorityRef !== null)) {
          throw new MemoryLedgerError('invalid_source_reference');
        }
        const sourceKeys = record.sources.map(source => JSON.stringify([source.sourceId, source.revision, source.locator]));
        if (new Set(sourceKeys).size !== sourceKeys.length) throw new MemoryLedgerError('invalid_source_reference');
        if (previous?.payload.kind === 'record' && previous.payload.value.record.createdAt !== record.createdAt) {
          throw new MemoryLedgerError('invalid_memory');
        }
        if (entityId !== null) {
          const entity = tx.latest('entity', entityId);
          if (!entity) throw new MemoryLedgerError('memory_not_found_or_forbidden');
          if (!sameEpochs(entity.epochs, scope)) throw new MemoryLedgerError('revoked_epoch');
        }
        const dependencyIds = dependencyRevisions.map(ref => ref.id);
        if (new Set(record.dependencies).size !== record.dependencies.length ||
          new Set(dependencyIds).size !== dependencyIds.length ||
          JSON.stringify([...record.dependencies].sort()) !== JSON.stringify([...dependencyIds].sort())) {
          throw new MemoryLedgerError('invalid_source_reference');
        }
        for (const ref of dependencyRevisions) {
          const dependency = tx.revision('record', ref.id, ref.revision);
          if (ref.id === record.id || !dependency || dependency.payload.kind !== 'record') {
            throw new MemoryLedgerError('invalid_source_reference');
          }
          if (!sameEpochs(dependency.epochs, scope)) throw new MemoryLedgerError('revoked_epoch');
          const at = record.validFrom ?? parse(memoryInstantSchema, this.options.now?.() ?? new Date().toISOString());
          const history = tx.history('record', ref.id).sort((a, b) => b.revision - a.revision);
          const operative = history.find(item =>
            item.payload.kind === 'record' && (item.payload.value.changeMode === 'replace' ||
              (item.payload.value.record.validFrom !== null && item.payload.value.record.validFrom <= at)));
          const basis = dependency.payload.value.record;
          const successorStarts = history.flatMap(item => item.revision > ref.revision && item.payload.kind === 'record' &&
            item.payload.value.changeMode === 'effective-from' && item.payload.value.record.validFrom !== null &&
            item.payload.value.record.validFrom > at ? [item.payload.value.record.validFrom] : []).sort();
          const successor = successorStarts[0];
          if (operative?.revision !== ref.revision || basis.lifecycle !== 'active' ||
            (basis.validFrom !== null && at < basis.validFrom) || (basis.validTo !== null && at >= basis.validTo) ||
            (basis.validFrom !== null && (record.validFrom === null || record.validFrom < basis.validFrom)) ||
            (basis.validTo !== null && (record.validTo === null || record.validTo > basis.validTo)) ||
            (successor !== undefined && (record.validTo === null || record.validTo > successor))) {
            throw new MemoryLedgerError('invalid_source_reference');
          }
        }
      } else if (command.payload.kind === 'entity') {
        const entity = command.payload.value;
        if (new Set(entity.aliases).size !== entity.aliases.length) throw new MemoryLedgerError('invalid_memory');
        if (previous?.payload.kind === 'entity' && previous.payload.value.kind !== entity.kind) {
          throw new MemoryLedgerError('invalid_memory');
        }
      } else {
        const claims = command.payload.value.claims;
        if (new Set(claims.map(ref => ref.id)).size !== claims.length) throw new MemoryLedgerError('invalid_memory');
        for (const ref of claims) {
          const claim = tx.revision('record', ref.id, ref.revision);
          if (!claim) throw new MemoryLedgerError('invalid_source_reference');
          if (!sameEpochs(claim.epochs, scope)) throw new MemoryLedgerError('revoked_epoch');
        }
      }
      const recordedAt = parse(memoryInstantSchema, this.options.now?.() ?? new Date().toISOString());
      if (previous && recordedAt < previous.recordedAt) throw new MemoryLedgerError('invalid_memory');
      const sequence = tx.nextSequence();
      const entry: MemoryLedgerEntry = {
        kind: command.payload.kind, id: subject.id, revision: subject.revision,
        sequence, recordedAt, epochs: epochs(scope), payload: command.payload,
      };
      tx.insert(entry);
      const event = {
        sequence, commandId: command.commandId, kind: entry.kind, id: entry.id,
        revision: entry.revision, recordedAt, epochs: epochs(scope),
      };
      tx.appendEvent(event);
      const result = { commandId: command.commandId, entry, event };
      tx.saveCommand({ commandId: command.commandId, fingerprint, result });
      // Even an injected host callback cannot change authority mid-operation.
      if (!sameEpochs(scope, this.current(scope))) throw new MemoryLedgerError('revoked_epoch');
      return structuredClone(result);
    });
  }

  snapshot(scopeValue: MemoryLedgerScope, throughSequence?: number): MemoryServiceSnapshot {
    const scope = parse(memoryLedgerScopeSchema, scopeValue);
    if (throughSequence !== undefined && (!Number.isSafeInteger(throughSequence) || throughSequence < 0)) {
      throw new MemoryLedgerError('invalid_memory');
    }
    const admission = this.admitRead(scope);
    const snapshot = throughSequence === 0 && admission ? admission : this.store.snapshot(key(scope), throughSequence);
    if (!snapshot || !sameEpochs(scope, snapshot.epochs)) {
      throw new MemoryLedgerError('revoked_epoch');
    }
    this.assertReadEpochs(scope);
    const entries = snapshot.entries.filter(entry => sameEpochs(entry.epochs, snapshot.epochs));
    return { ...snapshot, entries, suppression: { omittedEntries: snapshot.entries.length - entries.length }, afterRecordedAtEntries: 0 };
  }

  read(scope: MemoryLedgerScope, query: MemoryTemporalQuery): {
    snapshot: MemoryServiceSnapshot; records: MemoryRecordView[];
  } {
    const validAt = parse(memoryInstantSchema, query.validAt);
    const knownAt = query.recordedAt === undefined ? undefined : parse(memoryInstantSchema, query.recordedAt);
    const complete = this.snapshot(scope, query.throughSequence);
    const knownEntries = knownAt === undefined ? complete.entries : complete.entries.filter(entry => entry.recordedAt <= knownAt);
    const snapshot = { ...complete, entries: knownEntries, afterRecordedAtEntries: complete.entries.length - knownEntries.length };
    const grouped = new Map<string, MemoryLedgerEntry[]>();
    // Later-recorded revisions may close an earlier view, even when its snapshot omits them.
    for (const entry of complete.entries) {
      if (entry.payload.kind !== 'record') continue;
      const revisions = grouped.get(entry.id) ?? [];
      revisions.push(entry);
      grouped.set(entry.id, revisions);
    }
    const records: MemoryRecordView[] = [];
    for (const revisions of grouped.values()) {
      revisions.sort((a, b) => a.revision - b.revision);
      let selected: MemoryLedgerEntry | undefined;
      for (let index = revisions.length - 1; index >= 0; index--) {
        const entry = revisions[index];
        if (entry.payload.kind !== 'record' || (knownAt !== undefined && entry.recordedAt > knownAt)) continue;
        const { record, changeMode } = entry.payload.value;
        if (changeMode === 'replace' || (record.validFrom !== null && record.validFrom <= validAt)) {
          selected = entry;
          break;
        }
      }
      if (!selected || selected.payload.kind !== 'record') continue;
      const record = selected.payload.value.record;
      if (record.lifecycle === 'retracted' || (record.validFrom !== null && validAt < record.validFrom) ||
        (record.validTo !== null && validAt >= record.validTo)) continue;
      const selectedRevision = selected.revision;
      const next = revisions.find(entry => entry.kind === 'record' && entry.revision > selectedRevision && entry.payload.kind === 'record' &&
        (entry.payload.value.changeMode === 'replace' ||
          (entry.payload.value.record.validFrom !== null && entry.payload.value.record.validFrom <= validAt)));
      records.push({
        entry: selected, record, recordedTo: next?.recordedAt ?? null,
        temporal: record.validFrom === null || record.validTo === null ? 'unknown' : 'applicable',
        fresh: sameEpochs(selected.epochs, snapshot.epochs),
        lineageCount: new Set(record.sources.map(source => JSON.stringify([source.sourceId, source.revision]))).size,
      });
    }
    records.sort((a, b) => a.entry.sequence - b.entry.sequence);
    return { snapshot, records };
  }

  aliases(scope: MemoryLedgerScope, aliasValue: string, query: { throughSequence?: number } = {}): {
    status: 'none' | 'unique' | 'ambiguous'; entities: MemoryEntity[];
  } {
    const alias = parse(memoryContractText(512), aliasValue);
    const snapshot = this.snapshot(scope, query.throughSequence);
    const latest = new Map<string, MemoryLedgerEntry>();
    for (const entry of snapshot.entries) {
      if (entry.kind === 'entity' && (latest.get(entry.id)?.revision ?? 0) < entry.revision) latest.set(entry.id, entry);
    }
    const entities = [...latest.values()].flatMap(entry => entry.payload.kind === 'entity' &&
      sameEpochs(entry.epochs, snapshot.epochs) && entry.payload.value.aliases.includes(alias) ? [entry.payload.value] : []);
    return { status: entities.length === 0 ? 'none' : entities.length === 1 ? 'unique' : 'ambiguous', entities };
  }

  conflict(scope: MemoryLedgerScope, id: string, policy: MemoryPolicyPrecedence | null = null, query?: MemoryTemporalQuery): {
    conflict: MemoryConflict; claims: MemoryLedgerEntry[]; preferred: MemoryRevisionRef | null; policyRef: string | null;
  } {
    if (policy !== null && query === undefined) throw new MemoryLedgerError('invalid_memory');
    const temporal = query === undefined ? undefined : this.read(scope, query);
    const snapshot = temporal?.snapshot ?? this.snapshot(scope);
    const entry = snapshot.entries.filter(item => item.kind === 'conflict' && item.id === id)
      .filter(item => query?.recordedAt === undefined || item.recordedAt <= query.recordedAt)
      .sort((a, b) => b.revision - a.revision)[0];
    if (!entry || entry.payload.kind !== 'conflict') throw new MemoryLedgerError('memory_not_found_or_forbidden');
    const claims = entry.payload.value.claims.map(ref => {
      const claim = snapshot.entries.find(item => item.kind === 'record' && item.id === ref.id && item.revision === ref.revision);
      if (!claim) throw new MemoryLedgerError('invalid_source_reference');
      if (!sameEpochs(claim.epochs, snapshot.epochs)) throw new MemoryLedgerError('revoked_epoch');
      return claim;
    });
    let preferred: MemoryRevisionRef | null = null;
    let policyRef: string | null = null;
    if (policy !== null) {
      const declared = parse(z.strictObject({
        policyRef: memoryContractText(512), authorityOrder: z.array(memoryContractText(512)).min(1).max(64),
      }), policy);
      if (new Set(declared.authorityOrder).size !== declared.authorityOrder.length) throw new MemoryLedgerError('invalid_memory');
      policyRef = declared.policyRef;
      const ranked = claims.flatMap(claim => {
        if (claim.payload.kind !== 'record') return [];
        const { record, authorityRef } = claim.payload.value;
        const operative = temporal?.records.find(view => view.entry.id === claim.id && view.entry.revision === claim.revision);
        if (authorityRef === null || record.lifecycle !== 'active' ||
          !['source-supported', 'live-verified'].includes(record.epistemic) ||
          !operative || !operative.fresh || operative.temporal !== 'applicable') return [];
        const rank = declared.authorityOrder.indexOf(authorityRef);
        return rank < 0 ? [] : [{ claim, rank }];
      }).sort((a, b) => a.rank - b.rank);
      if (ranked.length && (ranked.length === 1 || ranked[0].rank < ranked[1].rank)) {
        preferred = { id: ranked[0].claim.id, revision: ranked[0].claim.revision };
      }
    }
    return { conflict: entry.payload.value, claims, preferred, policyRef };
  }

  outbox(scope: MemoryLedgerScope, afterSequence: number, limit: number) {
    this.snapshot(scope, 0);
    const events = this.store.outbox(key(scope), afterSequence, limit);
    if (events.some(event => !sameEpochs(event.epochs, scope))) throw new MemoryLedgerError('revoked_epoch');
    this.assertReadEpochs(scope);
    return events;
  }
  acknowledge(scope: MemoryLedgerScope, consumerId: string, throughSequence: number): void {
    this.snapshot(scope, 0);
    this.store.acknowledge(key(scope), consumerId, throughSequence);
  }
  acknowledged(scope: MemoryLedgerScope, consumerId: string): number {
    this.snapshot(scope, 0);
    const sequence = this.store.acknowledged(key(scope), consumerId);
    this.assertReadEpochs(scope);
    return sequence;
  }
}
