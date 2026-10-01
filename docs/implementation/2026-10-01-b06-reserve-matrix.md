# B06 reserve-matrix gap rows

Devin (SWE-2 Max), 2026-10-01. Evidence-only slice: one new test file in the
control-plane suite; no production code touched.

## Row mapping against existing coverage

The 2026-10-01 audit (`e71a0bf`) lists a B06 property matrix. Most named rows
are already evidenced by `services/control-plane/tests/funding*.test.ts`:

- last-credits race, parallel-children cap, duplicate attempt, replayed
  settlement, cancel before/after send, lost response + provider reconciliation
  + write-off evidence, lost commits (reserve/dispatch/settle), restart
  recovery, monthly reset, top-up ordering/dedup, partial usage, incomplete
  report hold, over-bound charge (held, never clamped), grant/withdraw
  corrections, parent-child caps, tier caps, unapproved-plan denial
  (`solo`/`business-plus` → `grant_not_approved`), postgres lock-order protocol.

Uncovered rows this slice adds (`tests/funding-boundary-matrix.test.ts`, all
against `FundingService` over `FundingMemoryRepository`):

1. **Withdraw-under-live-hold** — a `withdraw` correction is bounded by
   `monthlyAvailable`, which counts pending + uncertain holds; 991 of 1000
   refuses `insufficient_allowance`, 990 succeeds, and the live 10-credit hold
   still settles after the withdrawal. (The withdraw-below-zero bound was
   tested; the withdraw-vs-hold bound was not.)
2. **One-period-one-grant (positive half)** — re-allocating a month under its
   recorded grant is idempotent (same row returned); a different grant or a
   different plan for that month is `period_conflict`. (Only the
   different-grant negative was tested, on the Individual path.)
3. **Mid-run rate change** — two attempts reserved under different rate
   snapshots settle identical usage at their own snapshot's price (1 vs 2
   credits). An in-flight hold is never repriced by a later snapshot.
4. **200 racing reservations** — `Promise.all` of 200 ten-credit reserves over
   20 thorough jobs against a 1000-credit grant admits exactly 100, refuses 100
   with `insufficient_allowance`, hands out unique attempt ids, and replays an
   admitted id without a second debit.
5. **Projection envelope** — after reserve→settle / pending / uncertain-held /
   grant-correction / withdraw-correction: `settled+pending+uncertain+available
   = granted + grant-corrections − withdrawals` (7+10+5+980 = 1004−2).

## Results

- `npx vitest run tests/funding-boundary-matrix.test.ts` — **5/5** (143 ms, 09:04Z).
- Funding/managed family (15 files): `funding-boundary-matrix`, `funding`,
  `funding-dispatch-release`, `funding-postgres`, `funding-permissions`,
  `individual-funding`, `usage-contract-funding`, `managed-inference`,
  `managed-bindings`, `managed-body`, `managed-evaluations`,
  `managed-providers`, `managed-worker`, `faux-server-managed`,
  `gateway-funding-login` — **286/286** (26.2 s, 09:05Z).

## Honest boundary notes

- "Revoke-during-reserve" has no funding-surface API to test: grant revocation
  is upstream (account layer); on this surface the protection is the
  withdraw-vs-hold bound (row 1). The Individual-path "revoked/lapsed source
  refuses a new month" case is already covered in
  `individual-funding-postgres.integration.test.ts`.
- The memory repository serializes transactions; row 4 proves the service's
  admit/refuse logic at scale, not PostgreSQL isolation. Real row-locking stays
  with `funding-postgres.test.ts` + the opt-in integration suite (not run here;
  needs a database).
- B06's remaining rows beyond this slice: real Postgres concurrency, provider
  reconciliation against the live gateway, 34b review.

## Frozen identity

- Base: `a0d752e94a6a83ba9cd3b7277361dd2986d56014` (origin/main, PR #192)
- Production files changed: **none**
- New files: `services/control-plane/tests/funding-boundary-matrix.test.ts`
  `ba7e641fccfa0170ed4e5790954b988864e2fddfb1bc6b5c9f8be44f48b89863`,
  this record.
- `npx tsc --noEmit -p services/control-plane/tsconfig.json` — clean (09:06Z).
- Gates beyond the focused family: the control-plane vitest run above;
  repository-wide `tsc`/`vitest`/`vite build`/Playwright queued behind the
  shared heavy slot. The final record hash is reported in the evidence packet.

## Final gate evidence (2026-10-01, slot_devingate_a1b2c3d4)

- npx tsc --noEmit: clean.
- npx vitest run: 530 files, 8742 passed, 5 skipped, 0 failed (277s) — exact base count; the 5 matrix tests run under the control-plane harness (286/286 funding/managed family, control-plane tsc clean).
- npx vite build: built in 9.31s.
- npx playwright test tests/ui.spec.ts tests/native-ui.spec.ts tests/field.spec.ts: 36 passed (1.3m).

Status: READY FOR INDEPENDENT REVIEW. No push/merge performed.
