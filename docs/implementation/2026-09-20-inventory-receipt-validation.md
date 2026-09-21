# Inventory receipt recovery validation

Base: `b4eb2c2f46bc43840de31622509a82addd4bc746` (includes PR14).
Canonical mirrors: Pillars 2026-09-19.1; roadmap and project memory 2026-09-19.2.

An interrupted stock replacement can leave its receipt journal pending until
Store History is persisted. If an external edit subsequently replaces the stock
document, absence of that operation in the new document does not prove the
original effect never happened. Recovery now preserves the journal and reports
uncertainty. Invalid JSON in the current stock document reports the same bounded
uncertainty instead of leaking a SyntaxError. New effects remain blocked until
the pending outcome can be reconciled.

The write-error reconciliation path also retains journals when the observed
document lacks the pending receipt or has a different receipt. Exact prior
bytes and known pre-replacement version refusals still clear an unused journal;
an exact recorded receipt still recovers History without dispatching an effect.

## Verification

The independent authority/recovery test reproduced two failures before the fix:
an unrecognized replacement returned not-found and erased its pending journal;
malformed stock JSON rejected status with SyntaxError. After the fix, all 13
review cases and all 15 existing durable-stock cases pass in one focused run.
The added write-error cases cover missing and mismatched receipts after a
simulated ambiguous replacement outcome. Tests assert unchanged observed stock,
preserved journal evidence and absence of invented History.

Authority checks cover synthetic/wrong-tenant/missing-capability refusal,
Person and generation changes, cross-Person operation reuse, correction
permission, transfer destination drift, and reauthorization on Windows sharing
retry. The Windows-only case ran on this Windows host.

Full gate and independent review results are recorded separately for the exact
candidate commit. This note does not claim those gates passed before they run.

## Scope

This repair preserves History and the existing Store/Trust ownership. It adds no
new authority, purchase behavior, inventory HTTP/UI/device integration or
automatic reconciliation action. It does not complete MI03 or DEMO-05. The
broader mobile receipt workflow has a separate owner and acceptance record.
