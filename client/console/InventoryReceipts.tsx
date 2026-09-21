import { useEffect, useRef, useState } from 'react';
import type { InventoryCommand, InventoryCommandResult } from '../../shared/inventory.js';
import type { InventoryView } from '../../shared/inventory-workflow.js';
import {
  InventoryAccessError,
  InventoryReceiptClient,
  readPending,
  receiptPendingKey,
  receiptQuantity,
  savePending,
  stockQuantity,
} from '../inventory/receipt-client.js';
import './inventory-receipts.css';

type Outcome = InventoryCommandResult | { status: 'not-found'; operationId: string };
const defaultClient = new InventoryReceiptClient();
const label = (error: unknown) =>
  error instanceof Error ? error.message : 'Inventory is unavailable.';

/** A Console consumer: the host owns authority, balances, receipts and History. */
export function InventoryReceipts({ client = defaultClient }: { client?: InventoryReceiptClient }) {
  const [view, setView] = useState<InventoryView | null>(null);
  const [pending, setPending] = useState<InventoryCommand | null>(null);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [review, setReview] = useState<InventoryCommand | null>(null);
  const [location, setLocation] = useState('');
  const [quantity, setQuantity] = useState('');
  const [reason, setReason] = useState('');
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const active = useRef(false);
  const storageKey = useRef<string | null>(null);

  async function exclusive(action: () => Promise<void>) {
    if (active.current) return;
    active.current = true;
    setBusy(true);
    setFailure(null);
    try {
      await action();
    } catch (error) {
      setFailure(label(error));
      if (error instanceof InventoryAccessError && (error.status === 401 || error.status === 403)) {
        setView(null);
        setReview(null);
      }
    } finally {
      active.current = false;
      setBusy(false);
    }
  }
  async function refresh() {
    try {
      const next = await client.view();
      const key = receiptPendingKey(next.catalog.scope);
      if (storageKey.current !== null && storageKey.current !== key)
        throw new Error('The inventory binding changed. Reload to inspect the selected project.');
      storageKey.current = key;
      const saved = readPending(sessionStorage, key);
      setPending(saved);
      setView(next);
      return next;
    } catch (error) {
      // A failed refresh must not leave an old review able to overwrite unreadable intent.
      setView(null);
      setReview(null);
      throw error;
    }
  }
  useEffect(() => {
    void exclusive(async () => {
      await refresh();
    });
  }, [client]);

  const balances = view?.catalog.balances ?? [];
  const balance = balances.find(
    (row) => JSON.stringify([row.itemId, row.siteId, row.binId]) === location,
  );
  const item = view?.catalog.items.find((row) => row.id === balance?.itemId);
  function locationName(row: { itemId: string; siteId: string; binId: string }) {
    const catalog = view!.catalog;
    const selected = catalog.items.find((entry) => entry.id === row.itemId);
    return `${selected?.name ?? row.itemId}${selected?.variant ? ` (${selected.variant})` : ''} / ${catalog.sites.find((entry) => entry.id === row.siteId)?.name ?? row.siteId} / ${catalog.bins.find((entry) => entry.id === row.binId)?.name ?? row.binId}`;
  }
  function prepare() {
    setFailure(null);
    try {
      if (!balance || !item) throw new Error('Choose an item and bin.');
      setReview({
        kind: 'receive',
        operationId: `receive-${crypto.randomUUID()}`,
        itemId: item.id,
        siteId: balance.siteId,
        binId: balance.binId,
        expectedVersion: balance.version,
        quantity: receiptQuantity(quantity, item.scale, item.unit),
        ...(reason.trim() ? { reason: reason.trim() } : {}),
      });
    } catch (error) {
      setFailure(label(error));
    }
  }
  async function send(command: InventoryCommand) {
    // Persist once before the first network call; retries keep exactly these bytes.
    savePending(sessionStorage, storageKey.current!, command);
    setPending(command);
    setReview(null);
    const result = await client.receive(command);
    setOutcome(result);
    if (result.status === 'applied' || result.status === 'already-applied') await refresh();
  }
  async function startAnother() {
    // Refresh first. A stale-version conflict must never be silently rebased.
    await refresh();
    sessionStorage.removeItem(storageKey.current!);
    setPending(null);
    setOutcome(null);
    setReview(null);
    setQuantity('');
    setReason('');
  }
  const settled = outcome?.status === 'applied' || outcome?.status === 'already-applied';
  return (
    <main className="inventory-receipts">
      <header>
        <p className="inventory-eyebrow">Diomedes / Inventory</p>
        <h1>Stock receipts</h1>
        <p>
          Record stock already received and inspect its History. No orders, supplier messages or
          payments are sent.
        </p>
      </header>
      <div className="inventory-toolbar">
        <button
          disabled={busy}
          onClick={() =>
            void exclusive(async () => {
              await refresh();
            })
          }
        >
          Refresh stock and history
        </button>
        {view && <span>{view.canReceive ? 'Receipt entry available' : 'Read-only access'}</span>}
      </div>
      {failure && (
        <p role="alert" className="inventory-notice">
          {failure}
        </p>
      )}
      {!view && !failure && <p role="status">Loading inventory...</p>}
      {view && (
        <div className="inventory-columns">
          <section aria-labelledby="receive-title">
            <h2 id="receive-title">Receive stock</h2>
            {pending ? (
              <div className="inventory-attempt" aria-live="polite">
                <p>{locationName(pending)}</p>
                <p>
                  {stockQuantity(
                    pending.quantity.minor,
                    pending.quantity.scale,
                    pending.quantity.unit,
                  )}
                </p>
                <p className="inventory-id">Operation: {pending.operationId}</p>
                <p role="status">
                  {settled
                    ? outcome.status === 'already-applied'
                      ? 'Original receipt confirmed. Stock was not added again.'
                      : 'Stock receipt recorded.'
                    : outcome?.status === 'conflict'
                      ? 'Stock changed. Refresh and review a new receipt before submitting again.'
                      : outcome?.status === 'not-found'
                        ? 'No receipt is recorded for this operation. You can retry the same receipt.'
                        : outcome && 'reason' in outcome
                          ? outcome.reason
                          : 'This receipt needs a status check before you continue.'}
                </p>
                {settled && (
                  <p className="inventory-id">
                    Receipt: {outcome.receipt.id}
                    <br />
                    History: {outcome.receipt.historyEntryId}
                  </p>
                )}
                <button
                  disabled={busy}
                  onClick={() =>
                    void exclusive(async () => {
                      const result = await client.status(pending.operationId);
                      setOutcome(result);
                      if (result.status === 'applied') await refresh();
                    })
                  }
                >
                  Check receipt status
                </button>
                {outcome?.status === 'not-found' && (
                  <button disabled={busy} onClick={() => void exclusive(() => send(pending))}>
                    Retry same receipt
                  </button>
                )}
                {(settled || outcome?.status === 'conflict' || outcome?.status === 'invalid') && (
                  <button disabled={busy} onClick={() => void exclusive(startAnother)}>
                    {settled ? 'Start another receipt' : 'Refresh and start a new review'}
                  </button>
                )}
              </div>
            ) : review ? (
              <div className="inventory-review" aria-label="Receipt review">
                <h3>Review received stock</h3>
                <p>{locationName(review)}</p>
                <p>
                  Add{' '}
                  {stockQuantity(
                    review.quantity.minor,
                    review.quantity.scale,
                    review.quantity.unit,
                  )}{' '}
                  to recorded on-hand.
                </p>
                {review.reason && <p>{review.reason}</p>}
                <p className="inventory-id">Expected stock version: {review.expectedVersion}</p>
                <button
                  disabled={busy || !view.canReceive}
                  onClick={() => void exclusive(() => send(review))}
                >
                  Confirm receipt
                </button>
                <button disabled={busy} onClick={() => setReview(null)}>
                  Edit receipt
                </button>
              </div>
            ) : (
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  prepare();
                }}
              >
                <fieldset disabled={busy || !view.canReceive}>
                  <label>
                    Item and bin
                    <select
                      required
                      value={location}
                      onChange={(event) => setLocation(event.target.value)}
                    >
                      <option value="">Choose an item and bin</option>
                      {balances.map((row) => {
                        const key = JSON.stringify([row.itemId, row.siteId, row.binId]);
                        return (
                          <option key={key} value={key}>
                            {locationName(row)}
                          </option>
                        );
                      })}
                    </select>
                  </label>
                  {balance && (
                    <dl className="inventory-balances">
                      <dt>Recorded on-hand</dt>
                      <dd>{stockQuantity(balance.onHandMinor, balance.scale, balance.unit)}</dd>
                      <dt>Reserved</dt>
                      <dd>{stockQuantity(balance.reservedMinor, balance.scale, balance.unit)}</dd>
                      <dt>Available</dt>
                      <dd>{stockQuantity(balance.availableMinor, balance.scale, balance.unit)}</dd>
                      <dt>Last physical count</dt>
                      <dd>{balance.lastPhysicalCountAt ?? 'Not recorded'}</dd>
                      <dt>Source</dt>
                      <dd>
                        {balance.source.kind}: {balance.source.reference}
                      </dd>
                    </dl>
                  )}
                  <label>
                    Quantity received{item && ` (${item.unit})`}
                    <input
                      required
                      inputMode="decimal"
                      value={quantity}
                      maxLength={24}
                      onChange={(event) => setQuantity(event.target.value)}
                    />
                  </label>
                  <label>
                    Receipt note (optional)
                    <textarea
                      value={reason}
                      maxLength={500}
                      onChange={(event) => setReason(event.target.value)}
                    />
                  </label>
                  <button type="submit">Review receipt</button>
                </fieldset>
              </form>
            )}
          </section>
          <section aria-labelledby="receipt-history-title">
            <h2 id="receipt-history-title">Receipt history</h2>
            {!view.history.length && <p>No stock receipts recorded.</p>}
            <ol className="inventory-history">
              {view.history.map((row) => (
                <li key={row.receipt.id}>
                  <h3>
                    {row.receipt.kind === 'receive' ? 'Received' : row.receipt.kind}{' '}
                    {stockQuantity(row.quantity.minor, row.quantity.scale, row.quantity.unit)}
                  </h3>
                  <p>{locationName(row.receipt.changes[0])}</p>
                  <p>
                    Recorded {row.receipt.recordedAt} by {row.receipt.actorPersonId}
                  </p>
                  {row.receipt.reason && <p>{row.receipt.reason}</p>}
                  <details>
                    <summary>Receipt and History evidence</summary>
                    <dl>
                      <dt>Receipt</dt>
                      <dd>{row.receipt.id}</dd>
                      <dt>Operation</dt>
                      <dd>{row.receipt.operationId}</dd>
                      <dt>History entry</dt>
                      <dd>{row.history.id}</dd>
                      <dt>History record</dt>
                      <dd>{row.history.sentence}</dd>
                      {row.receipt.changes.map((change, index) => (
                        <div key={change.binId}>
                          <dt>{locationName(change)}</dt>
                          <dd>
                            {stockQuantity(row.beforeOnHandMinor[index], change.scale, change.unit)}{' '}
                            to {stockQuantity(change.onHandMinor, change.scale, change.unit)}
                          </dd>
                          <dt>Stock versions</dt>
                          <dd>
                            {change.previousVersion} to {change.version}
                          </dd>
                        </div>
                      ))}
                    </dl>
                  </details>
                </li>
              ))}
            </ol>
            {view.olderThan && (
              <button
                disabled={busy}
                onClick={() =>
                  void exclusive(async () => {
                    const older = await client.view(view.olderThan!);
                    setView(older);
                  })
                }
              >
                Show older receipts
              </button>
            )}
          </section>
        </div>
      )}
    </main>
  );
}
