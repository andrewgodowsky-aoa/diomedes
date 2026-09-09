import { z } from 'zod';
import type { Json } from '../../shared/harness.js';
import {
  observationSchema,
  timestamp,
  type ConnectorManifest,
  type ConnectionObservation,
} from '../../shared/connections.js';
import type { Rule } from '../../shared/connection-rules.js';
import { HarnessError } from '../harness/policy.js';

export const TOAST_RESOURCES = [
  { id: '10000000-0000-4000-8000-000000000001', name: 'Downtown' },
  { id: '10000000-0000-4000-8000-000000000002', name: 'North Hills' },
  { id: '10000000-0000-4000-8000-000000000003', name: 'Cary' },
];
export const TOAST_ITEMS = [
  '20000000-0000-4000-8000-000000000001',
  '20000000-0000-4000-8000-000000000002',
  '20000000-0000-4000-8000-000000000003',
];
export const toastInput = z.strictObject({
  resources: z.array(z.uuid()).min(1).max(32),
  itemIds: z.array(z.uuid()).min(1).max(100),
});
const stockItem = z.object({
  guid: z.uuid(),
  itemGuidValidity: z.enum(['VALID', 'INVALID']).optional(),
  status: z.string().max(40),
  quantity: z.number().finite().nonnegative().optional(),
  multiLocationId: z
    .string()
    .regex(/^[0-9]{1,40}$/)
    .optional(),
  versionId: z.uuid().optional(),
});
export const toastResult = z.strictObject({
  coverage: z.literal('selected-items'),
  observations: z.array(observationSchema),
});

export function normalizeStock(
  payload: unknown,
  resourceId: string,
  receivedAt: string,
  sourceAt: string | null = null,
): ConnectionObservation[] {
  const parsed = z.array(stockItem).max(100).safeParse(payload);
  if (!parsed.success)
    throw new HarnessError('malformed_vendor_result', 'Toast returned an invalid stock payload.');
  const keys = new Set<string>();
  return parsed.data.map((item) => {
    const valid = item.itemGuidValidity !== 'INVALID';
    if (valid && item.status === 'QUANTITY' && item.quantity === undefined)
      throw new HarnessError(
        'malformed_vendor_result',
        'Toast QUANTITY state requires a reported quantity.',
      );
    const quantity = valid && item.status === 'QUANTITY' ? (item.quantity ?? null) : null;
    const available =
      valid &&
      (item.status === 'IN_STOCK' ||
        (item.status === 'QUANTITY' && quantity !== null && quantity > 0));
    const unavailable =
      valid && (item.status === 'OUT_OF_STOCK' || (item.status === 'QUANTITY' && quantity === 0));
    const key = item.multiLocationId ?? item.guid;
    if (keys.has(key))
      throw new HarnessError(
        'malformed_vendor_result',
        'Toast returned conflicting item identities.',
      );
    keys.add(key);
    return observationSchema.parse({
      resourceId,
      key,
      sourceAt,
      receivedAt,
      source: 'Toast menu-item/modifier stock (fixture)',
      facts: {
        itemId: item.guid,
        availability: available ? 'available' : unavailable ? 'unavailable' : 'unknown',
        status: item.status,
        quantity,
        quantityState:
          quantity !== null
            ? 'reported'
            : valid && item.status === 'IN_STOCK'
              ? 'not-tracked'
              : 'unknown',
        quantityUnknown: quantity === null,
        sourceKind: 'menu-availability',
      },
    });
  });
}

const provenance = {
  source: 'https://doc.toasttab.com/doc/devguide/apiStock.html',
  connectorVersion: '1.0.0',
  trust: 'host-reviewed' as const,
};
export const toastRules: Rule[] = [
  {
    id: 'toast-stock-semantics',
    version: 1,
    enabled: true,
    scope: { connectorId: 'toast' },
    provenance,
    type: 'standing',
    text: 'Toast reports menu-item and modifier availability. It does not establish physical ingredient inventory. Unknown quantity is not zero or unlimited.',
    predicate: null,
    action: 'context',
  },
  {
    id: 'toast-unknown-quantity',
    version: 1,
    enabled: true,
    scope: { connectorId: 'toast' },
    provenance,
    type: 'correction',
    text: 'Quantity is not reported by this source. Do not infer a numeric count.',
    predicate: { field: 'quantityUnknown', operator: 'eq', value: true },
    action: 'correct',
  },
];
export const toastManifest: ConnectorManifest = {
  schemaVersion: 1,
  id: 'toast',
  vendor: 'Toast',
  version: '1.0.0',
  provenance: {
    source: provenance.source,
    license: 'Diomedes Apache-2.0; vendor contracts documented separately',
    review: 'host-reviewed',
    integrity: null,
  },
  authentication: ['fixture', 'oauth-client-credentials'],
  operations: [
    {
      id: 'get_item_availability',
      description: 'Compare reported menu availability across approved locations.',
      effect: 'read',
      permission: 'connections.read',
      vendorScopes: ['stock:read'],
      source: { method: 'POST', path: '/stock/v1/inventory/search' },
      inputSchema: z.json().parse(z.toJSONSchema(toastInput)),
      resultSchema: z.json().parse(z.toJSONSchema(toastResult)),
    },
  ],
  allowedOrigins: [],
  pagination: 'Selected item batch, bounded to 100 by this adapter; no pagination assumed.',
  rateLimit:
    'Production must honor 429 and Retry-After or X-Toast-RateLimit-Reset. No network in this fixture.',
  retry: 'At most two explicit read attempts; writes unavailable. No automatic network retry.',
  idempotency: 'Read request identity and stock event GUID receipts.',
  reconciliation: 'Refresh selected item GUIDs; a bulk GET omits IN_STOCK items.',
  webhook: 'Stock envelope; Base64 HMAC-SHA256(raw body + payload timestamp).',
  freshness:
    'Fixture observations; source time is null for API snapshots. Event feed is not a quantity ledger.',
  dataClassification: 'internal',
  limitations: [
    'Menu stock, not ingredient inventory.',
    'IN_STOCK does not imply a numerical quantity.',
    'Toast low_quantity events use a vendor threshold of 5, separate from a business rule.',
    'Standard API access has no sandbox. No real vendor access verified.',
  ],
  approvals: ['Any new write, location, destination or credential scope needs separate review.'],
  healthCheck: 'Last successful selected-item refresh; last accepted event.',
  fixtures: ['three approved synthetic locations; quantity=9, unknown IN_STOCK, OUT_OF_STOCK'],
  rules: toastRules,
};

/** A fixed fixture response for the documented POST search, which is a read. */
export function stockFixture(input: Json, at: string) {
  const args = toastInput.parse(input);
  const rows = [
    {
      guid: TOAST_ITEMS[0],
      status: 'QUANTITY',
      quantity: 9,
      multiLocationId: '101',
      itemGuidValidity: 'VALID',
    },
    { guid: TOAST_ITEMS[1], status: 'IN_STOCK', multiLocationId: '102', itemGuidValidity: 'VALID' },
    {
      guid: TOAST_ITEMS[2],
      status: 'OUT_OF_STOCK',
      multiLocationId: '103',
      itemGuidValidity: 'VALID',
    },
  ];
  return toastResult.parse({
    coverage: 'selected-items',
    observations: args.resources.flatMap((resource) =>
      normalizeStock(
        rows.filter((row) => args.itemIds.includes(row.guid)),
        resource,
        at,
      ),
    ),
  });
}

const toastEvent = z.object({
  timestamp,
  eventCategory: z.literal('stock'),
  eventType: z.enum(['in_stock', 'out_of_stock', 'low_quantity']),
  guid: z.uuid(),
  details: z.object({
    itemGuid: z.uuid(),
    restaurantGuid: z.uuid(),
    status: z.enum(['IN_STOCK', 'OUT_OF_STOCK', 'QUANTITY']),
    quantity: z.number().finite().nonnegative().optional(),
    multiLocationId: z.string().regex(/^[0-9]{1,40}$/),
    versionId: z.uuid().optional(),
  }),
});
export function parseToastEvent(raw: string, at: string) {
  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    throw new HarnessError('invalid_event', 'The stock event is not valid JSON.');
  }
  const parsed = toastEvent.safeParse(payload);
  if (!parsed.success)
    throw new HarnessError('invalid_event', 'The stock event does not match the vendor contract.');
  const e = parsed.data,
    d = e.details;
  const consistent =
    e.eventType === 'out_of_stock'
      ? d.status === 'OUT_OF_STOCK'
      : e.eventType === 'low_quantity'
        ? d.status === 'QUANTITY' && d.quantity !== undefined && d.quantity > 0 && d.quantity <= 5
        : d.status === 'IN_STOCK' ||
          (d.status === 'QUANTITY' && d.quantity !== undefined && d.quantity > 5);
  if (!consistent)
    throw new HarnessError('invalid_event', 'The stock event type and payload disagree.');
  const observation = normalizeStock(
    [{ ...d, guid: d.itemGuid }],
    d.restaurantGuid,
    at,
    e.timestamp,
  )[0];
  return { id: e.guid, timestamp: e.timestamp, type: e.eventType, observation };
}
