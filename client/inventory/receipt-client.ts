import {
  inventoryResultSchema,
  type InventoryCommand,
  type InventoryQuantity,
  type InventoryScope,
} from '../../shared/inventory.js';
import {
  inventoryOperationStatusSchema,
  inventoryReceiveSchema,
  inventoryViewSchema,
} from '../../shared/inventory-workflow.js';

/** Convert text to minor units without floating point rounding or implicit units. */
export function receiptQuantity(text: string, scale: number, unit: string): InventoryQuantity {
  if (!Number.isInteger(scale) || scale < 0 || scale > 6 || !/^\d+(\.\d+)?$/.test(text))
    throw new Error('Enter a positive quantity using digits and a decimal point.');
  const [whole, fraction = ''] = text.split('.');
  if (fraction.length > scale) throw new Error(`Use at most ${scale} decimal places.`);
  const minor = BigInt(whole) * 10n ** BigInt(scale) + BigInt(fraction.padEnd(scale, '0') || '0');
  if (minor <= 0n || minor > BigInt(Number.MAX_SAFE_INTEGER))
    throw new Error('Enter a positive quantity within the supported range.');
  return { minor: Number(minor), scale, unit };
}

export function stockQuantity(minor: number | null, scale: number, unit: string): string {
  if (minor === null) return 'Unknown';
  const digits = String(minor).padStart(scale + 1, '0');
  return `${scale ? `${digits.slice(0, -scale)}.${digits.slice(-scale)}` : digits} ${unit}`;
}

export function receiptPendingKey(scope: InventoryScope): string {
  return `diomedes.inventory.receipt.v1:${JSON.stringify([scope.organizationId, scope.tenantId, scope.projectId])}`;
}

/** Store intent before dispatch. A blocked browser store must prevent the effect. */
export function savePending(
  storage: Pick<Storage, 'setItem'>,
  key: string,
  command: InventoryCommand,
): void {
  storage.setItem(key, JSON.stringify(inventoryReceiveSchema.parse(command)));
}
export function readPending(
  storage: Pick<Storage, 'getItem'>,
  key: string,
): InventoryCommand | null {
  const raw = storage.getItem(key);
  if (raw === null) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    value = undefined;
  }
  const parsed = inventoryReceiveSchema.safeParse(value);
  if (!parsed.success)
    throw new Error(
      'Saved receipt intent is unreadable. Preserve it and reconcile before receiving more stock.',
    );
  return parsed.data;
}

export class InventoryAccessError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export class InventoryReceiptClient {
  constructor(
    private readonly fetcher: typeof fetch = (input, init) => fetch(input, init),
    private readonly base = '/api/inventory',
  ) {}

  private async request(route: string, command?: InventoryCommand): Promise<unknown> {
    const response = await this.fetcher(`${this.base}${route}`, {
      method: command ? 'POST' : 'GET',
      cache: 'no-store',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', 'X-Diomedes-Inventory': '1' },
      ...(command ? { body: JSON.stringify(command) } : {}),
      signal: AbortSignal.timeout(15_000),
    });
    // A proxy or crashed host can answer with HTML; that is a failed request, not a parser error.
    const value: unknown = await response.json().catch(() => undefined);
    if (!response.ok && (!value || typeof value !== 'object' || !('status' in value))) {
      const message =
        value && typeof value === 'object' && 'error' in value && typeof value.error === 'string'
          ? value.error
          : 'Inventory request failed.';
      throw new InventoryAccessError(response.status, message);
    }
    return value;
  }

  async view(olderThan?: string) {
    return inventoryViewSchema.parse(
      await this.request(`/view${olderThan ? `?olderThan=${encodeURIComponent(olderThan)}` : ''}`),
    );
  }

  async receive(command: InventoryCommand) {
    try {
      const result = inventoryResultSchema.parse(
        await this.request('/receipts', inventoryReceiveSchema.parse(command)),
      );
      if (
        (result.status === 'applied' || result.status === 'already-applied') &&
        result.receipt.operationId !== command.operationId
      )
        throw new Error('Receipt identity does not match the pending operation.');
      if (result.status === 'uncertain' && result.operationId !== command.operationId)
        throw new Error('Uncertain receipt identity does not match the pending operation.');
      return result;
    } catch {
      // A timeout, invalid reply, or server failure can follow the durable replacement.
      return {
        status: 'uncertain' as const,
        operationId: command.operationId,
        reason: 'The receipt outcome is unknown. Check its status before trying again.',
      };
    }
  }

  async status(operationId: string) {
    const result = inventoryOperationStatusSchema.parse(
      await this.request(`/operations/${encodeURIComponent(operationId)}`),
    );
    if (
      (result.status === 'applied' && result.receipt.operationId !== operationId) ||
      ('operationId' in result && result.operationId !== operationId)
    )
      throw new Error('Status response does not match the pending operation.');
    return result;
  }
}
