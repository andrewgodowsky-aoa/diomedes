# W01 independent source review

Date: 2026-10-06. Candidate base:
`063035ed9feee446352dbf445208577d021c71d4`.

Reviewer: native Codex `gpt-6-astra`, high effort, bounded read-only lane
`regression_reconciliation`. Authoring, review and parent reconciliation were
separate roles. No imports, tests, database opens, typecheck, build or runtime
checks were performed. Findings below are source counterexamples, not executed
RED evidence. W01 acceptance remains pending.

## Finding history

| Review | Finding | Source disposition |
| --- | --- | --- |
| Initial, rejected | Stale generation bodies returned with a freshness flag. | Filter bodies before exposure; retain omission counts. |
| Initial, rejected | A shortened replacement interval could revive an older revision. | Explicit replacement versus future-effective succession; no fallback after expiry. |
| Initial, rejected | Pinned future/retracted conflict claims could win by policy rank. | Require a temporal query and exact currently operative, eligible revision. |
| Initial, rejected | Fresh entries could reference old-generation entities or claims. | Current-epoch checks for scoped references. |
| Follow-up, rejected | Historical views did not expose recorded end time. | Derive end from the complete watermark-bounded history while excluding future bodies. |
| Follow-up, rejected | Latest stored future policy blocked an earlier operative dependency. | Select dependency at the child's valid start from revision history. |
| Follow-up, rejected | Schema acceptance trusted its stored digest despite altered triggers. | Compare actual SQLite definitions with a newly constructed reference schema. |
| Follow-up, rejected | Atomic restore bypassed the transaction byte ceiling. | Charge backup plus authority floors against both transaction and backup limits. |
| Follow-up, rejected | A dependency's known successor did not bound a derivative interval. | Bound by the earliest applicable known successor; allow an equal half-open end. |

The final bounded re-review reported no remaining concrete finding in the three
latest fixes and confirmed the earlier recorded-time repairs. It is a source
review disposition, not runtime or full W01 acceptance.

## Exact implementation files at final re-review

| File | SHA-256 |
| --- | --- |
| `server/memory/local-store.ts` | `b59e9b17b29da56f096d7a7ead5c280f44bd4968175260dde95647da2cc50ada` |
| `server/memory/schema.ts` | `b35dbce7decab39acd786033845c9d9ebf0a97ad46fc60726168826bc19f3827` |
| `server/memory/service.ts` | `24c21b696a9145a901411aacf17429428e74f205e4d856d3cfc82dee0b809316` |
| `shared/memory-ledger.ts` | `12354312c52c379c1fd8246c4cddb54ea84a1e1b7fcec7a64492c2dafb96ae08` |
| `server/memory/store.ts` | `99fa0ff194a2ccc7a1776a73840ab1f2248dad49d7b4f3862ba315559b3d0129` |

The parent independently read the changes, checked these hashes and inspected
the migration-family diff. Tracked-diff whitespace inspection reported no
errors. None of these checks ran the W01 implementation.

## Deferred evidence

A separate bounded review of the authored tests by `memory_sqlite` found one
cleanup issue: an unexpectedly successful schema open in a negative test could
leave a handle open and obscure the assertion on Windows. The parent changed
the promise to close successful opens before the rejection assertion. The
updated recovery-test hash is
`05715f4da09af79b223751c42014c121cd56cbd9fc59a4fe4d6a68c3d83cfa60`.
The reviewer re-read the repaired assertion and confirmed that finding resolved
by source inspection only.
The other reviewed crash-process and temporary-profile isolation paths had no
concrete source finding. Test and fixture hashes are in `candidate.json`.

All 85 authored test cases are DID_NOT_RUN. Driver compatibility, transaction
rollback, abrupt-process recovery, WAL/resource behavior, source-schema checks,
restoration and temporal assertions still require execution. No successful
qualification, release, deployment or customer acceptance is inferred.

Main advanced to `6a0ec1cedc66d1163f4dc5e21974971c3ae19c2b` through PR243 during
authoring. Its inspected paths do not overlap the W01 candidate. This drift is
not integrated or tested here and must be reconciled before executable evidence.
