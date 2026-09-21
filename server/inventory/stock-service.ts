import {
  inventoryCommandSchema,
  inventoryReceiptSchema,
  type InventoryCommand,
  type InventoryCommandResult,
  type InventoryReceipt,
  type InventoryScope,
} from '../../shared/inventory.js';
import { ApiError } from '../paths.js';
import { identifier, type Store } from '../store.js';
import type { Authority, Denial } from '../trust/index.js';
import { prepareInventoryCommand } from './commands.js';
import { inventoryLocationKey, parseInventoryStockDocument } from './ledger.js';
import { InventoryStockRepository } from './stock-repository.js';
import { inventoryViewSchema, type InventoryView } from '../../shared/inventory-workflow.js';

export type InventoryStockPermission = InventoryCommand['kind'] | 'correct';
export type InventoryOperationStatus =
  | { readonly status: 'applied'; readonly receipt: InventoryReceipt }
  | { readonly status: 'not-found'; readonly operationId: string }
  | { readonly status: 'denied' | 'invalid'; readonly reason: string }
  | { readonly status: 'uncertain'; readonly operationId: string; readonly reason: string };

export interface InventoryStockAuthorization {
  readonly authority: Authority;
  readonly scope: InventoryScope;
  readonly actorPersonId: string;
  readonly permissions: readonly InventoryStockPermission[];
}

export interface InventoryStockAuthorizationRequest {
  readonly phase: 'admission' | 'effect' | 'status';
  readonly projectId: string;
  readonly operationId: string;
  readonly command: InventoryCommand | null;
}

export type InventoryStockAuthorizer<Claim = unknown> = (
  claim: Claim,
  request: InventoryStockAuthorizationRequest,
) => Promise<InventoryStockAuthorization | Denial>;

class StockAuthorizationError extends Error {}

function isStockDenial(value: InventoryStockAuthorization | Denial): value is Denial {
  return 'denied' in value && value.denied === true;
}

function sameScope(left: InventoryScope, right: InventoryScope): boolean {
  return (
    left.organizationId === right.organizationId &&
    left.tenantId === right.tenantId &&
    left.projectId === right.projectId
  );
}

function samePrincipal(left: Authority['principal'], right: Authority['principal']): boolean {
  return (
    left.kind === right.kind &&
    left.id === right.id &&
    left.tenantId === right.tenantId &&
    left.projectId === right.projectId &&
    left.deviceId === right.deviceId &&
    left.sessionId === right.sessionId &&
    left.slotId === right.slotId
  );
}

export class InventoryStockService<Claim = unknown> {
  private readonly repository: InventoryStockRepository;

  constructor(
    private readonly options: {
      readonly store: Store;
      readonly stockPath: string;
      readonly authorize: InventoryStockAuthorizer<Claim>;
    },
  ) {
    this.repository = new InventoryStockRepository(options.store, options.stockPath);
  }

  async init(projectId: string): Promise<void> {
    await this.repository.init(projectId);
  }

  /** A read projection of the same ledger and Store History, under fresh authority. */
  async view(projectId: string, claim: Claim, olderThan?: string): Promise<InventoryView> {
    return this.options.store.locked(async () => {
      const authorization = await this.options.authorize(claim, {
        phase: 'status',
        projectId,
        operationId: 'inventory-history',
        command: null,
      });
      if (isStockDenial(authorization))
        throw new ApiError(authorization.status, authorization.reason);
      const refusal = this.readRefusal(authorization, projectId);
      if (refusal) throw new ApiError(403, refusal);
      await this.repository.recover(projectId);
      const text = await this.repository.read(projectId);
      if (text === null) throw new ApiError(404, 'Inventory is unavailable.');
      let input: unknown;
      try {
        input = JSON.parse(text);
      } catch {
        throw new ApiError(422, 'The stock document is not valid JSON.');
      }
      const snapshot = parseInventoryStockDocument(input, authorization.scope);
      const records = [...snapshot.operations].reverse();
      const cursor =
        olderThan === undefined ? -1 : records.findIndex((row) => row.receipt.id === olderThan);
      if (olderThan !== undefined && cursor === -1)
        throw new ApiError(404, 'Inventory history is unavailable. Refresh the list.');
      const page = records.slice(cursor + 1, cursor + 21);
      const entries = new Map(
        this.options.store.state(projectId).history.map((entry) => [entry.id, entry]),
      );
      const history = page.map((row) => {
        const entry = entries.get(row.receipt.historyEntryId);
        if (
          !entry ||
          entry.kind !== 'inventory-stock' ||
          entry.label !== row.command.operationId ||
          entry.time !== row.receipt.recordedAt ||
          !entry.files.some((file) => file.path === this.repository.stockPath)
        )
          throw new ApiError(
            409,
            'A stock receipt is missing its linked History evidence. Reconcile before continuing.',
          );
        return {
          receipt: row.receipt,
          quantity: row.command.quantity,
          beforeOnHandMinor: row.before.map((balance) => balance.onHandMinor),
          history: { id: entry.id, time: entry.time, sentence: entry.sentence, label: entry.label },
        };
      });
      return inventoryViewSchema.parse({
        catalog: snapshot.catalog,
        canReceive:
          authorization.authority.capabilities.has('write.apply') &&
          authorization.permissions.includes('receive'),
        history,
        olderThan: records.length > cursor + 21 ? page.at(-1)!.receipt.id : null,
      });
    });
  }

  async status(
    projectId: string,
    operationId: string,
    claim: Claim,
  ): Promise<InventoryOperationStatus> {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(operationId))
      return { status: 'invalid', reason: 'A valid inventory operation ID is required.' };
    return this.options.store.locked(async () => {
      const authorization = await this.options.authorize(claim, {
        phase: 'status',
        projectId,
        operationId,
        command: null,
      });
      if (isStockDenial(authorization))
        return { status: 'denied' as const, reason: authorization.reason };
      const refusal = this.readRefusal(authorization, projectId);
      if (refusal) return { status: 'denied' as const, reason: refusal };
      try {
        await this.repository.recover(projectId);
      } catch (error) {
        if (error instanceof ApiError && error.status === 409)
          return { status: 'uncertain' as const, operationId, reason: error.message };
        throw error;
      }
      const text = await this.repository.read(projectId);
      if (text === null)
        return {
          status: 'invalid' as const,
          reason: 'The authoritative stock document is unavailable.',
        };
      let document: unknown;
      try {
        document = JSON.parse(text);
      } catch {
        return {
          status: 'invalid' as const,
          reason: 'The authoritative stock document is not valid JSON.',
        };
      }
      try {
        const snapshot = parseInventoryStockDocument(document, authorization.scope);
        const record = snapshot.operations.find(
          (candidate) => candidate.command.operationId === operationId,
        );
        return record
          ? {
              status: 'applied' as const,
              receipt: inventoryReceiptSchema.parse(record.receipt),
            }
          : { status: 'not-found' as const, operationId };
      } catch (error) {
        if (error instanceof ApiError) return { status: 'invalid' as const, reason: error.message };
        throw error;
      }
    });
  }

  async execute(
    projectId: string,
    commandInput: unknown,
    claim: Claim,
  ): Promise<InventoryCommandResult> {
    const parsed = inventoryCommandSchema.safeParse(commandInput);
    if (!parsed.success)
      return { status: 'invalid', reason: 'A valid inventory command is required.' };
    const command = parsed.data;
    return this.options.store.locked(async () => {
      const authorization = await this.authorize(claim, projectId, command, 'admission');
      if (isStockDenial(authorization))
        return { status: 'denied' as const, reason: authorization.reason };
      const refusal = this.refusal(authorization, projectId, command);
      if (refusal) return { status: 'denied' as const, reason: refusal };
      await this.repository.recover(projectId);
      try {
        return await this.apply(projectId, command, claim, authorization);
      } catch (error) {
        if (error instanceof StockAuthorizationError)
          return { status: 'denied' as const, reason: error.message };
        if (error instanceof ApiError && (error.status === 404 || error.status === 422))
          return { status: 'invalid' as const, reason: error.message };
        throw error;
      }
    });
  }

  private authorize(
    claim: Claim,
    projectId: string,
    command: InventoryCommand,
    phase: InventoryStockAuthorizationRequest['phase'],
  ) {
    return this.options.authorize(claim, {
      phase,
      projectId,
      operationId: command.operationId,
      command,
    });
  }

  private refusal(
    authorization: InventoryStockAuthorization,
    projectId: string,
    command: InventoryCommand,
  ): string | null {
    if (authorization.authority.synthetic)
      return 'Synthetic authority cannot apply inventory stock effects.';
    if (!authorization.authority.capabilities.has('write.apply'))
      return 'Current authority does not permit recorded writes.';
    if (
      authorization.scope.projectId !== projectId ||
      authorization.authority.principal.projectId !== projectId ||
      authorization.authority.principal.tenantId !== authorization.scope.tenantId
    )
      return 'Current authority does not match this inventory tenant and project.';
    if (!authorization.permissions.includes(command.kind))
      return `Current authority does not permit inventory ${command.kind}.`;
    if (command.correctsReceiptId && !authorization.permissions.includes('correct'))
      return 'Current authority does not permit inventory corrections.';
    return null;
  }

  private readRefusal(
    authorization: InventoryStockAuthorization,
    projectId: string,
  ): string | null {
    if (authorization.authority.synthetic)
      return 'Synthetic authority cannot inspect inventory operation status.';
    if (!authorization.authority.capabilities.has('project.read'))
      return 'Current authority does not permit inventory reads.';
    if (
      authorization.scope.projectId !== projectId ||
      authorization.authority.principal.projectId !== projectId ||
      authorization.authority.principal.tenantId !== authorization.scope.tenantId
    )
      return 'Current authority does not match this inventory tenant and project.';
    return null;
  }

  private async assertFreshAuthorization(
    claim: Claim,
    projectId: string,
    command: InventoryCommand,
    admitted: InventoryStockAuthorization,
  ): Promise<void> {
    const current = await this.authorize(claim, projectId, command, 'effect');
    if (isStockDenial(current)) throw new StockAuthorizationError(current.reason);
    const refusal = this.refusal(current, projectId, command);
    if (refusal) throw new StockAuthorizationError(refusal);
    if (
      current.actorPersonId !== admitted.actorPersonId ||
      !sameScope(current.scope, admitted.scope) ||
      !samePrincipal(current.authority.principal, admitted.authority.principal) ||
      current.authority.generation.identity !== admitted.authority.generation.identity ||
      current.authority.generation.principal !== admitted.authority.generation.principal
    )
      throw new StockAuthorizationError(
        'Inventory authority changed before the stock effect; retry after refreshing access.',
      );
  }

  private balanceVersion(
    snapshot: ReturnType<typeof parseInventoryStockDocument>,
    endpoint: { readonly itemId: string; readonly siteId: string; readonly binId: string },
  ): string | null {
    return (
      snapshot.catalog.balances.find(
        (candidate) => inventoryLocationKey(candidate) === inventoryLocationKey(endpoint),
      )?.version ?? null
    );
  }

  private async apply(
    projectId: string,
    command: InventoryCommand,
    claim: Claim,
    authorization: InventoryStockAuthorization,
  ): Promise<InventoryCommandResult> {
    const beforeText = await this.repository.read(projectId);
    if (beforeText === null)
      return { status: 'invalid', reason: 'The authoritative stock document is unavailable.' };
    let document: unknown;
    try {
      document = JSON.parse(beforeText);
    } catch {
      return {
        status: 'invalid',
        reason: 'The authoritative stock document is not valid JSON.',
      };
    }
    const snapshot = parseInventoryStockDocument(document, authorization.scope);
    if (snapshot.operations.some((record) => record.command.operationId === command.operationId)) {
      const replay = prepareInventoryCommand(snapshot, command, {
        scope: authorization.scope,
        actorPersonId: authorization.actorPersonId,
        now: new Date().toISOString(),
        nextDocumentVersion: identifier('D'),
        receiptId: identifier('R'),
        historyEntryId: identifier('E'),
        balanceVersions: {
          source: identifier('B'),
          ...(command.kind === 'transfer' ? { destination: identifier('B') } : {}),
        },
      });
      if (replay.status !== 'recorded-match')
        throw new Error('A recorded inventory operation did not reconcile to its receipt.');
      await this.assertFreshAuthorization(claim, projectId, command, authorization);
      return {
        status: 'already-applied',
        receipt: inventoryReceiptSchema.parse(replay.recordedReceipt),
      };
    }
    const currentVersion = this.balanceVersion(snapshot, command);
    if (currentVersion === null)
      return { status: 'invalid', reason: 'The inventory item or location is unavailable.' };
    if (currentVersion !== command.expectedVersion) return { status: 'conflict', currentVersion };
    if (command.kind === 'transfer') {
      const destinationVersion = this.balanceVersion(snapshot, {
        itemId: command.itemId,
        siteId: command.destination.siteId,
        binId: command.destination.binId,
      });
      if (destinationVersion === null)
        return { status: 'invalid', reason: 'The inventory item or location is unavailable.' };
      if (destinationVersion !== command.destination.expectedVersion)
        return { status: 'conflict', currentVersion: destinationVersion };
    }
    try {
      const receipt = await this.repository.commit(
        projectId,
        beforeText,
        {
          sentence: `Inventory ${command.kind} recorded for ${authorization.actorPersonId}.`,
          label: command.operationId,
        },
        (entry) => {
          const prepared = prepareInventoryCommand(snapshot, command, {
            scope: authorization.scope,
            actorPersonId: authorization.actorPersonId,
            now: entry.time,
            nextDocumentVersion: identifier('D'),
            receiptId: identifier('R'),
            historyEntryId: entry.id,
            balanceVersions: {
              source: identifier('B'),
              ...(command.kind === 'transfer' ? { destination: identifier('B') } : {}),
            },
          });
          if (prepared.status !== 'prepared')
            throw new Error('A new inventory operation unexpectedly matched a receipt.');
          return {
            afterText: JSON.stringify(prepared.proposedDocument, null, 2),
            receipt: inventoryReceiptSchema.parse(prepared.proposedReceipt),
          };
        },
        () => this.assertFreshAuthorization(claim, projectId, command, authorization),
      );
      return { status: 'applied', receipt };
    } catch (error) {
      if (
        error instanceof ApiError &&
        error.status === 409 &&
        error.details.code === 'inventory-version-conflict'
      ) {
        const latestText = await this.repository.read(projectId);
        if (latestText === null)
          return {
            status: 'invalid',
            reason: 'The authoritative stock document is unavailable.',
          };
        const latest = parseInventoryStockDocument(JSON.parse(latestText), authorization.scope);
        const latestVersion = this.balanceVersion(latest, command);
        if (latestVersion !== null) return { status: 'conflict', currentVersion: latestVersion };
      }
      throw error;
    }
  }
}
