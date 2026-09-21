# Durable inventory stock receipts

This slice turns the accepted MI03 stock proposals into one durable local stock
effect. It is reconciled with the finalized `feature/inventory-stock-preparation`
head `8ea2bf526e3561cb65ace309aa62d60a5421462b`, now contained by current `main`
at `8d7d63b70809a3b8375a1594cc357f7f8f94e0ce`, and retains inventory contract
version 1 / revision 2026-09-19.2. It adds no HTTP route, gateway registration,
mobile view or scanning behavior.

## Owned boundary

`InventoryStockService` accepts an untrusted command plus an opaque host claim.
The host-supplied authorizer must resolve a genuine current `Authority`, exact
organization/tenant/project scope, an existing Person ID and allowed stock
operations. Synthetic authority, missing `write.apply`, a mismatched principal,
an ungranted command kind and an ungranted correction all refuse before a stock
effect. The same authority is resolved again immediately before replacement;
actor, scope, principal and authority generations must still match admission.
Status reads require fresh genuine `project.read` authority and never treat a
saved receipt as a replay capability.

`InventoryStockRepository` is a narrow extension of the existing `Store` owner.
Every service operation runs inside `Store.locked()`. The repository uses the
existing guarded project path, content-addressed History objects, durable-write
primitive and Project-state persistence. It does not add another database or a
second general file writer.

One authoritative stock document contains balances, complete operation intent,
the immutable receipt and prior images. The repository allocates the real Store
History entry before final proposal preparation, so the receipt records that
entry's actual ID. The History label records the operation ID; its sentence and
the receipt retain the resolved Person attribution. A transfer replaces both
endpoints and appends its single receipt in one atomic file replacement.

## Conflicts, retries and recovery

Endpoint versions are checked against the current document before preparation.
The repository then compares the exact source bytes again in the final durable
write guard, after fresh authorization. A competing replacement is preserved
and returned as a version conflict; the command is never silently replanned or
retried against new stock.

An operation ID identifies the complete command and actor. An identical
authorized retry returns the original receipt without a second History entry or
stock change. Reusing the ID with changed intent or actor is a conflict. Status
reconciliation reads the authoritative receipt under current read authority and
does not dispatch an effect.

Before replacement, the repository persists before/after History objects and a
bounded pending receipt journal. Recovery is confirm-only: if the old bytes are
still present, it discards the unperformed journal; if the new receipt is
present, it restores the exact linked History entry; if the outcome cannot be
proved, it reports uncertainty and blocks newer inventory effects. Recovery
never performs an unfinished stock mutation after restart.

Focused tests cover denial, fresh effect authorization, exact idempotent replay,
changed-intent refusal, stale and final-guard conflicts, competing workers,
atomic transfers, operation policy, compensating corrections, attributable
History, status reconciliation and crash recovery after stock replacement.

## Release boundary

This is the durable Store/Trust host seam requested after the pure MI03 review.
It is not full MI03 or MI-DEMO acceptance. The authorizer is an injected server
boundary; verified hosted identity, membership-to-Trust wiring, HTTP transport,
device behavior, mobile UI, deployment and human proof remain separate work.

PILLAR IMPACT: stock changes become authorized, durable and attributable without
weakening the one-owner or evidence model.

ROADMAP IMPACT: the durable inventory receipt slice is implemented; HTTP/mobile
integration and the physical-device demo remain OPEN.
