import { describe, expect, test, vi } from 'vitest';
import {
  InventoryAccessError,
  InventoryReceiptClient,
  readPending,
  receiptPendingKey,
  receiptQuantity,
  savePending,
  stockQuantity,
} from '../client/inventory/receipt-client.js';
import type { InventoryCommand } from '../shared/inventory.js';

const command: InventoryCommand = {
  kind: 'receive',
  operationId: 'receive-1',
  itemId: 'cable',
  siteId: 'workshop',
  binId: 'shelf-a',
  expectedVersion: 'v1',
  quantity: { minor: 125, scale: 2, unit: 'm' },
};
describe('receipt intent and transport', () => {
  test('a status response for another operation cannot settle the pending receipt', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response(JSON.stringify({ status: 'not-found', operationId: 'different-operation' })),
      );
    await expect(new InventoryReceiptClient(fetcher).status(command.operationId)).rejects.toThrow(
      'does not match',
    );
  });
  test('quantities preserve exact minor units including the maximum safe integer', () => {
    expect(receiptQuantity('1.25', 2, 'm')).toEqual({ minor: 125, scale: 2, unit: 'm' });
    expect(receiptQuantity('9007199254.740991', 6, 'm').minor).toBe(Number.MAX_SAFE_INTEGER);
    expect(stockQuantity(Number.MAX_SAFE_INTEGER, 6, 'm')).toBe('9007199254.740991 m');
    expect(stockQuantity(null, 0, 'each')).toBe('Unknown');
  });
  test.each(['0', '-1', '1e2', '1,25', '1.251', 'Infinity', '9007199254740992'])(
    'rejects unsafe or ambiguous quantity %s',
    (input) => {
      expect(() => receiptQuantity(input, 2, 'm')).toThrow();
    },
  );
  test('saved intent is bound to organization, tenant and project, and reload retains the original operation', () => {
    const data = new Map<string, string>();
    const storage = {
      getItem: (key: string) => data.get(key) ?? null,
      setItem: (key: string, value: string) => {
        data.set(key, value);
      },
    };
    const scope = { organizationId: 'one', tenantId: 'tenant', projectId: 'project' };
    const key = receiptPendingKey(scope);
    savePending(storage, key, command);
    expect(readPending(storage, key)).toEqual(command);
    expect(readPending(storage, receiptPendingKey({ ...scope, organizationId: 'two' }))).toBeNull();
    expect(() =>
      savePending(
        {
          setItem: () => {
            throw new Error('Quota');
          },
        },
        key,
        command,
      ),
    ).toThrow('Quota');
    data.set(key, '{broken');
    expect(() => readPending(storage, key)).toThrow();
  });
  test('lost and malformed replies remain uncertain without automatic dispatch', async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValue(new Error('response lost'));
    const client = new InventoryReceiptClient(fetcher);
    expect(await client.receive(command)).toMatchObject({
      status: 'uncertain',
      operationId: command.operationId,
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
    fetcher.mockResolvedValue(new Response('{}'));
    expect(await client.receive(command)).toMatchObject({ status: 'uncertain' });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  test('status reads never dispatch the pending receipt and report not-found without interpreting it as an effect', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response(JSON.stringify({ status: 'not-found', operationId: command.operationId })),
      );
    const result = await new InventoryReceiptClient(fetcher).status(command.operationId);
    expect(result.status).toBe('not-found');
    expect(fetcher).toHaveBeenCalledWith(
      '/api/inventory/operations/receive-1',
      expect.objectContaining({ method: 'GET', cache: 'no-store' }),
    );
    expect(fetcher.mock.calls[0][1]).not.toHaveProperty('body');
  });
  test('typed version conflicts and denied replies are not reported as success', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response(JSON.stringify({ status: 'conflict', currentVersion: 'v2' }), { status: 409 }),
      );
    expect(await new InventoryReceiptClient(fetcher).receive(command)).toEqual({
      status: 'conflict',
      currentVersion: 'v2',
    });
    fetcher.mockResolvedValue(
      new Response(JSON.stringify({ status: 'denied', reason: 'Revoked' }), { status: 403 }),
    );
    expect(await new InventoryReceiptClient(fetcher).receive(command)).toEqual({
      status: 'denied',
      reason: 'Revoked',
    });
  });
  test('unreadable saved intent says to preserve and reconcile, whatever made it unreadable', () => {
    const key = receiptPendingKey({ organizationId: 'one', tenantId: 'tenant', projectId: 'project' });
    for (const raw of ['{broken', JSON.stringify({ kind: 'receive' })])
      expect(() => readPending({ getItem: () => raw }, key)).toThrow(
        'Saved receipt intent is unreadable. Preserve it and reconcile before receiving more stock.',
      );
  });
  test('a reply that is not JSON reports its HTTP failure, not a parser error', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response('<html>Bad gateway</html>', { status: 502 }));
    const failure = await new InventoryReceiptClient(fetcher).view().catch((error) => error);
    expect(failure).toBeInstanceOf(InventoryAccessError);
    expect(failure).toMatchObject({ status: 502, message: 'Inventory request failed.' });
    // A receipt whose reply is unreadable stays uncertain, exactly as before.
    expect(await new InventoryReceiptClient(fetcher).receive(command)).toMatchObject({
      status: 'uncertain',
      operationId: command.operationId,
    });
  });
});
