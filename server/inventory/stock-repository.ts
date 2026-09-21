import fs from 'node:fs/promises';
import path from 'node:path';
import { inventoryReceiptSchema, type InventoryReceipt } from '../../shared/inventory.js';
import type { HistoryEntry } from '../../shared/types.js';
import { ApiError, projectFile, readTextOrNull, relativeName } from '../paths.js';
import { durableWrite, hash, identifier, jsonWrite, type Store } from '../store.js';
import { inventoryDigest, parseInventoryStockDocument } from './ledger.js';

interface PendingStockJournal {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly projectId: string;
  readonly stockPath: string;
  readonly operationId: string;
  readonly beforeSha: string;
  readonly afterSha: string;
  readonly afterText: string;
  readonly receipt: InventoryReceipt;
  readonly historyEntry: HistoryEntry;
}

export interface PreparedStockReceipt {
  readonly afterText: string;
  readonly receipt: InventoryReceipt;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function historyEvidence(entry: HistoryEntry): Omit<HistoryEntry, 'versionId'> {
  const { versionId: _versionId, ...evidence } = entry;
  return evidence;
}

/**
 * The inventory extension of the existing Store owner.
 *
 * Callers enter through Store.locked(). The repository keeps balances, the
 * immutable receipt and its Store History entry behind one atomic stock-file
 * replacement. Recovery confirms a replacement that already happened; it
 * never dispatches an unfinished stock effect after restart.
 */
export class InventoryStockRepository {
  readonly stockPath: string;

  constructor(
    private readonly store: Store,
    stockPath: string,
  ) {
    this.stockPath = relativeName(stockPath);
  }

  async init(projectId: string): Promise<void> {
    await this.store.locked(() => this.recover(projectId));
  }

  async read(projectId: string): Promise<string | null> {
    return this.store.current(projectId, this.stockPath);
  }

  /** Must run inside Store.locked(); exposed so service reads cannot overtake recovery. */
  async recover(projectId: string): Promise<void> {
    await fs.mkdir(this.pendingDir(), { recursive: true });
    const names = (await fs.readdir(this.pendingDir()))
      .filter((name) => name.endsWith('.json'))
      .sort();
    for (const name of names) {
      const journalPath = path.join(this.pendingDir(), name);
      const journal = this.parseJournal(JSON.parse(await fs.readFile(journalPath, 'utf8')));
      if (journal.projectId !== projectId || journal.stockPath !== this.stockPath) continue;
      const state = this.store.state(projectId);
      const resolved = await projectFile(state.project.folder, journal.stockPath);
      const actualText = await readTextOrNull(resolved.absolute);
      const actualSha = hash(actualText);
      if (actualSha === journal.beforeSha) {
        await fs.unlink(journalPath);
        continue;
      }
      if (actualText === null)
        throw new ApiError(409, 'A pending inventory effect cannot be reconciled safely.');
      let actual;
      try {
        actual = parseInventoryStockDocument(JSON.parse(actualText), journal.receipt.scope);
      } catch (error) {
        if (error instanceof ApiError || error instanceof SyntaxError)
          throw new ApiError(409, 'A pending inventory effect cannot be reconciled safely.');
        throw error;
      }
      const recorded = actual.operations.find(
        (record) => record.command.operationId === journal.operationId,
      );
      if (!recorded)
        throw new ApiError(409, 'A pending inventory effect cannot be reconciled safely.');
      if (inventoryDigest(recorded.receipt) !== inventoryDigest(journal.receipt))
        throw new ApiError(409, 'A pending inventory operation resolved to a different receipt.');
      await this.recordRecoveredHistory(journal);
      await fs.unlink(journalPath);
    }
  }

  async commit(
    projectId: string,
    beforeText: string,
    history: { readonly sentence: string; readonly label: string },
    prepare: (entry: HistoryEntry) => PreparedStockReceipt,
    beforeReplace: () => Promise<void>,
  ): Promise<InventoryReceipt> {
    const state = structuredClone(this.store.state(projectId));
    const resolved = await projectFile(state.project.folder, this.stockPath);
    const beforeSha = hash(beforeText);
    if (beforeSha === null)
      throw new ApiError(409, 'The authoritative stock document is unavailable.');
    const entry = this.store.addEntry(state, {
      actor: 'you',
      kind: 'inventory-stock',
      sentence: history.sentence,
      label: history.label,
      merge: false,
    });
    const prepared = prepare(entry);
    const receipt = inventoryReceiptSchema.parse(prepared.receipt);
    if (receipt.historyEntryId !== entry.id || receipt.operationId !== history.label)
      throw new Error('The stock receipt does not identify its allocated History entry.');
    const afterSha = hash(prepared.afterText);
    if (afterSha === null) throw new Error('A stock receipt cannot delete its authoritative data.');
    entry.files.push({
      path: this.stockPath,
      op: 'modified',
      before: beforeSha,
      after: afterSha,
      recorded: true,
      reason: null,
    });
    await durableWrite(this.store.objectPath(projectId, beforeSha), beforeText);
    await durableWrite(this.store.objectPath(projectId, afterSha), prepared.afterText);
    const journal: PendingStockJournal = {
      schemaVersion: 1,
      id: identifier('I'),
      projectId,
      stockPath: this.stockPath,
      operationId: receipt.operationId,
      beforeSha,
      afterSha,
      afterText: prepared.afterText,
      receipt,
      historyEntry: entry,
    };
    await fs.mkdir(this.pendingDir(), { recursive: true });
    const journalPath = path.join(this.pendingDir(), `${journal.id}.json`);
    await jsonWrite(journalPath, journal);
    try {
      await durableWrite(resolved.absolute, prepared.afterText, async () => {
        await beforeReplace();
        const latest = hash(await readTextOrNull(resolved.absolute));
        if (latest !== beforeSha)
          throw new ApiError(409, 'The stock version changed before the receipt was saved.', {
            code: 'inventory-version-conflict',
          });
      });
    } catch (error) {
      const actualText = await readTextOrNull(resolved.absolute);
      const actual = hash(actualText);
      if (
        actual === beforeSha ||
        (error instanceof ApiError && error.details.code === 'inventory-version-conflict')
      )
        await fs.unlink(journalPath);
      else if (actual === afterSha) {
        await this.store.persist(state);
        await fs.unlink(journalPath);
        return receipt;
      } else if (actualText !== null) {
        let snapshot: ReturnType<typeof parseInventoryStockDocument>;
        try {
          snapshot = parseInventoryStockDocument(JSON.parse(actualText), receipt.scope);
        } catch {
          throw error;
        }
        const recorded = snapshot.operations.find(
          (record) => record.command.operationId === receipt.operationId,
        );
        if (!recorded)
          throw new ApiError(409, 'A pending inventory effect cannot be reconciled safely.');
        if (inventoryDigest(recorded.receipt) === inventoryDigest(receipt)) {
          await this.store.persist(state);
          await fs.unlink(journalPath);
          return receipt;
        } else {
          throw new ApiError(409, 'The inventory operation resolved to a different receipt.');
        }
      }
      throw error;
    }
    await this.store.persist(state);
    await fs.unlink(journalPath);
    return receipt;
  }

  private pendingDir(): string {
    return path.join(this.store.dataDir, 'inventory-pending');
  }

  private parseJournal(input: unknown): PendingStockJournal {
    if (
      !isRecord(input) ||
      input.schemaVersion !== 1 ||
      typeof input.id !== 'string' ||
      typeof input.projectId !== 'string' ||
      typeof input.stockPath !== 'string' ||
      typeof input.operationId !== 'string' ||
      typeof input.beforeSha !== 'string' ||
      typeof input.afterSha !== 'string' ||
      typeof input.afterText !== 'string' ||
      !isRecord(input.historyEntry)
    )
      throw new Error('A pending inventory receipt journal is malformed.');
    const receipt = inventoryReceiptSchema.parse(input.receipt);
    const historyEntry = input.historyEntry as unknown as HistoryEntry;
    const file = Array.isArray(historyEntry.files) ? historyEntry.files[0] : undefined;
    if (
      !/^[a-f0-9]{64}$/.test(input.beforeSha) ||
      !/^[a-f0-9]{64}$/.test(input.afterSha) ||
      hash(input.afterText) !== input.afterSha ||
      receipt.operationId !== input.operationId ||
      historyEntry.id !== receipt.historyEntryId ||
      historyEntry.kind !== 'inventory-stock' ||
      historyEntry.label !== input.operationId ||
      historyEntry.files.length !== 1 ||
      file?.path !== input.stockPath ||
      file.before !== input.beforeSha ||
      file.after !== input.afterSha ||
      file.recorded !== true
    )
      throw new Error('A pending inventory receipt journal is inconsistent.');
    return {
      schemaVersion: 1,
      id: input.id,
      projectId: input.projectId,
      stockPath: input.stockPath,
      operationId: input.operationId,
      beforeSha: input.beforeSha,
      afterSha: input.afterSha,
      afterText: input.afterText,
      receipt,
      historyEntry,
    };
  }

  private async recordRecoveredHistory(journal: PendingStockJournal): Promise<void> {
    const state = structuredClone(this.store.state(journal.projectId));
    const existing = state.history.find((entry) => entry.id === journal.historyEntry.id);
    if (existing) {
      if (
        inventoryDigest(historyEvidence(existing)) !==
        inventoryDigest(historyEvidence(journal.historyEntry))
      )
        throw new Error('Recovered inventory History conflicts with its durable receipt.');
      return;
    }
    if (
      state.history.some(
        (entry) => entry.kind === 'inventory-stock' && entry.label === journal.operationId,
      )
    )
      throw new Error('Recovered inventory operation identity conflicts with History.');
    const entry = structuredClone(journal.historyEntry);
    entry.versionId = `v${String(state.history.length + 1).padStart(4, '0')}`;
    state.history.push(entry);
    await this.store.persist(state);
  }
}
