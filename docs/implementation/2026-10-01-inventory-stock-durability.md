# MI03 bounded slice — inventory stock durability/concurrency evidence

Node: MI03.I (bounded slice — not a DONE claim). Branch `feature/inventory-stock-durability`,
worktree `F:\Diomedes\diomedes-wt\inventory-stock-durability`, base `origin/main` `a0d752e`
(PR #192 merge). Worker: Devin (external claim
`external-claims/devin-inventory-stock-durability-20261001.json`).

## What this slice is

The merged inventory stock implementation already journals each operation
(`inventory-pending/*.json`), replaces the stock document atomically, and links every
receipt to a Store History entry. The pre-existing test suite
(`tests/inventory-durable-stock.test.ts`, `tests/inventory-concurrency.test.ts`) covers
that protocol **in-process**: injected `store.persist` failures, `Promise.all` on one
Store, hand-copied journals. This slice adds the layer those tests cannot express:
real owned child processes over real files with deterministic marker
synchronization — competing last-unit operations, an independent second process on
the same data folder, actual SIGKILL termination and restart, transfer atomicity,
lost-acknowledgement reconciliation, and malformed recovery records.

## Files (claimed: `server/inventory/stock-repository.ts`, `server/inventory/stock-lock.ts`, `tests/inventory-durability.test.ts`, `tests/fixtures/inventory-stock-child.ts`)

- `tests/inventory-durability.test.ts` — new suite; child fixture drives the real
  `Store`/`InventoryStockService`/`InventoryStockRepository` under `node --import tsx`.
- `tests/fixtures/inventory-stock-child.ts` — child driver (execute / guarded-commit /
  status / view / recover modes; file-marker barriers).
- `server/inventory/stock-lock.ts` — **new**: cross-process advisory lock for the
  stock-ledger critical section (mkdir-atomic under `<dataDir>/inventory-locks/`,
  pid-liveness + age-based stale breaking, `inventory-lock-held` 409 on timeout).
- `server/inventory/stock-repository.ts` — `recover()` and `commit()` now hold the
  per-ledger file lock (`<projectId>-<stockPath>`); the commit's `persist()` merges
  onto a **disk-fresh** project state (`writableState`) instead of the in-memory
  snapshot, and the History entry is grafted with a fresh `versionId` at persist time.

## Why the repair was needed (two defects the new tests expose)

1. **Journal theft across processes.** `recover()` scanned and unlinked pending
   journals with no mutual exclusion. A second process running `init`/`execute` could
   unlink a live first-process commit's journal between its stock-file replace and
   its cleanup, surfacing `ENOENT` to the committing caller or — worse — letting two
   commits' check-then-rename interleave, silently dropping one applied operation.

2. **Stale-state History clobber.** `commit()` cloned `store.state(projectId)`
   (loaded at process init) and `persist()` wrote that whole snapshot. A process that
   had loaded before a sibling committed would erase the sibling's History entry —
   leaving a stock receipt whose `historyEntryId` dangles (the service's own `view()`
   then correctly refuses with 409 — fail-closed, but torn evidence on disk).

## Owner-reserved: proposed patch for `server/store.ts` (NOT applied)

The inventory repair makes inventory commits merge-safe, but the Store itself still
lacks a data-folder ownership boundary — any process can `init` and `persist` the
same `dataDir`, and non-inventory writers can still interleave their snapshots in
the same window. Proposed minimal contract for the Store owner (Fable):

```ts
// server/store.ts — sketch only; owner to design within Store conventions.
// 1. At init(): create <dataDir>/owner.json { pid, bootId, startedAt } if absent;
//    refuse init() when a live pid owns it, unless opts.secondary==='readonly'.
// 2. In persist(): wrap the state write in the same per-project lockfile pattern
//    used by server/inventory/stock-lock.ts (or a store-level equivalent), and
//    merge `history` from disk before overwriting so concurrent writers' entries
//    are union-preserved rather than last-writer-wins.
// 3. Electron's requestSingleInstanceLock() does not cover plain Node child
//    processes — the boundary must live in Store, not the shell.
```

The inventory-side lock deliberately does **not** claim data-folder ownership —
that is a Store decision. If the owner prefers a `Store`-level lock primitive,
`stock-lock.ts` can be replaced by it without changing call sites.

## Evidence

### Red → green

Red run (`stock-repository.ts` restored to `origin/main`, new suite kept):
`npx vitest run tests/inventory-durability.test.ts` — **3 failed / 10 passed**:

- `a stale second process cannot erase a committed History entry` →
  `expected [ 'use-b' ] to deeply equal [ 'use-a', 'use-b' ]` — B's stale persist
  erased A's History entry. **Defect 2 reproduced.**
- `a racing second process cannot steal a live commit journal` →
  `aResult.status 'thrown' (expected 'applied')` — B swept A's live journal. **Defect 1 reproduced.**
- `a killed transfer never debits without crediting` → timed out waiting for the
  journal in that full-suite run; reran in isolation → **passed on base in 1.3 s**
  (this test is an atomicity invariant that holds either way; the earlier miss was
  a child-start flake, now instrumented to dump the child's result+stderr on timeout).

Green run (repair restored): `npx vitest run tests/inventory-durability.test.ts` —
**13/13 passed** in 40.9 s (07:48Z).

Post-hardening re-run (after the lock gained rename-based stale-break +
token-checked release): the transfer kill test flaked once — its 10 ms poll for
the journal raced a sub-10 ms commit window on the 400-item doc (child result
captured: `status:"applied"` before a poll landed). Replaced the poll with the
fixture's `guarded-commit` barrier (`transfer.parked` written inside the replace
guard, journal guaranteed live; kill during the park also leaves a dead-pid lock
dir, so the recovery leg exercises stale-break). `npx vitest run
tests/inventory-durability.test.ts` — **13/13 passed** in 43.5 s (08:55Z).

Focused inventory suite (14 files, includes all pre-existing stock suites):
`npx vitest run tests/hostile-binding-inventory.test.ts tests/inventory-concurrency.test.ts tests/inventory-durable-stock.test.ts tests/inventory-commands.test.ts tests/inventory-command-authorization.test.ts tests/inventory-stock-authority-review.test.ts tests/inventory-catalog.test.ts tests/inventory-stock-independent.test.ts tests/inventory-records-independent.test.ts tests/inventory-contract.test.ts tests/inventory-contract-independent.test.ts tests/inventory-import.test.ts tests/inventory-receipt-client.test.ts tests/inventory-receipt-workflow.test.ts`
— **574/574 passed** in 8.8 s (07:51Z).

### Environment note (material to reproducing this worktree's runs)

The worktree's `node_modules` was junctioned to the main checkout, which is parked
on `docs/fractional-ai-ops-agreement-20260919` + a wip commit — its install predates
the `ai@7.0.107` dep, so `hostile-binding-inventory.test.ts` (which loads
`server/engines/model-api-core.ts`) failed to collect. The junction was re-pointed
to `diomedes-wt/credit-allotments/node_modules`, whose `package-lock.json` is
byte-identical to this branch's (verified `cmp`). Link-only change; the shared
install was verified intact before and after (`cmd /c rmdir` detaches the junction,
never the target).

### Frozen hashes

- Base SHA: `a0d752e94a6a83ba9cd3b7277361dd2986d56014` (origin/main, PR #192)
- Patch: `git diff origin/main` = `server/inventory/stock-repository.ts` +85/−8;
  four new files (test, fixture, lock, this record).
- SHA256 at freeze time (re-frozen after post-hardening test edit):
  - `stock-repository.ts` `5dfddf5c2a3f19cd3c6b512d26549839306d4b7b4ea7866f1239e55ad0ccb999`
  - `stock-lock.ts` `7f16f95faecfbd6d3b9d6a3ad6283be45eea46b3269ab27a73e34064f7c73490`
  - `inventory-durability.test.ts` `10106976692c9cc92e8ee79f846536c0c6951cf314e99e214cf3660981769b17`
  - `inventory-stock-child.ts` `49de9b1ac6cbdba01fdba8045b5bc9fb408f527a121e117f11f30dac819a80cf`

### Gates

| Gate | Command | Result |
|---|---|---|
| typecheck | `npx tsc --noEmit` | _pending slot_ |
| unit | `npx vitest run` | _pending slot_ |
| build | `npx vite build` | _pending slot_ |
| browser | `npx playwright test tests/ui.spec.ts tests/native-ui.spec.ts tests/field.spec.ts` | _pending slot_ |

Scoped `tsc --noEmit` over the three new/changed files was clean before the suite
run (07:3xZ); the repository-wide gate remains to run under the slot.

## Remaining gaps / boundaries

- No Store-level co-ownership guard (owner-reserved — patch proposed above).
- R27-3 (`view()` authorizes a History read as a `status` check) remains open in the
  DIO-95 lane; out of this slice's repair scope.
- `inventory-lock-held` surfaces as a 409; callers that should retry are a later
  polish item (service maps it through as `uncertain` only on the status path).
- LOCK_WAIT_MS/LOCK_STALE_MS are conservative constants; a heartbeat refinement is
  possible if reviewers want tighter stale breaking.

## Final gate evidence (2026-10-01, commit 94f9890, slot_devingate_a1b2c3d4)

- npx tsc --noEmit: clean (services/control-plane junction re-pointed to a current dep set first; junction is environment, not patch).
- npx vitest run: 531 files, 8755 passed, 5 skipped, 0 failed (301s) — includes the 13 durability tests.
- npx vite build: built in 9.47s.
- npx playwright test tests/ui.spec.ts tests/native-ui.spec.ts tests/field.spec.ts: 36 passed (1.4m).

Status: READY FOR INDEPENDENT REVIEW. No push/merge performed.
