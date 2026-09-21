# Mobile stock receipt and history work order

- Feature: inventory-mobile-receipt-history
- Prompt: owner-requested next inventory slice (MI03/MI04/MI07 bounded consumer)
- Branch: feature/inventory-mobile-receipt-history
- Worktree: F:/Diomedes/diomedes-wt/inventory-mobile-receipt-history
- Base: origin/main b4eb2c2f46bc43840de31622509a82addd4bc746; package 0.1.6
- Owner: Codex main task, direct implementation; no delegated workers
- Canonical mirrors: Pillars 2026-09-19.1; Roadmap and Project Memory 2026-09-19.2

Implement a reusable Console receive-only form and receipt/history projection over
the merged InventoryStockService. Preserve its authorizer, current permissions,
idempotency, versions, atomic replacement and confirm-only recovery. A fixed host
binding chooses the project and path. HTTP callers supply stock intent only.

The explicit loopback demonstration uses synthetic stock and a test authorizer
that simulates the genuine-authority result required by the service. It is not
verified identity, a production gateway, remote access or purchasing. No normal
desktop API, listener, Trust grant table or installed profile is changed.

## Implemented boundary

- `InventoryStockService.view` reads the existing ledger and linked Store History
  under current read authority, retaining before/after quantities and exact
  receipt/History identity. It paginates by immutable receipt cursor and refuses
  absent or inconsistent evidence. It does not expose project paths or restore.
- The host-bound router accepts receive intent only and offers stock/history and
  operation-status reads. There are no caller-selected projects or paths, identity
  fields, correction, use, transfer, orders or administrative endpoints.
- The Console component reviews an explicit amount and expected version. It
  stores the exact command before sending, serializes clicks, keeps uncertain
  outcomes for status reconciliation, and requires a new review after conflict.
  A changed project binding clears the old review. Amounts use integer minor
  units; unknown stock and physical-count provenance stay distinct.
- The isolated demonstration serves Vite's built entry with a visible source
  identity and synthetic-data/authorization boundary. Fresh profiles have a fixed
  baseline; restarts preserve the same real ledger and History. The normal app
  does not mount this transport or substitute the fixture authorizer for Trust.
- [The demonstration runbook](../demos/inventory-receipts-0.1.6.md) names the
  baseline, exact expected changes, recovery/conflict scenarios, viewport matrix,
  capture locations and remaining physical-device acceptance.

PILLAR IMPACT: deterministic work, current authority and durable evidence advance
within the existing Store/Trust/Console contracts. No product definition changed.
ROADMAP IMPACT: a bounded receipt/history consumer and rehearsal are implemented;
MI01 deployment/identity, full MI03/MI04 and MI-DEMO acceptance remain OPEN. No
numbered prompt, package completion count or canonical cloud document was changed.

BUILD/PUBLICATION: package version remains 0.1.6. This is source-candidate behavior,
not proof that the published 0.1.6 installer has this newly added screen. No
packaging, installed-profile modification, provider call or deployment is part
of this slice. Real iPhone/iPad Safari and a person's independent observed
demonstration remain separate acceptance.

## Verification

### Original base b4eb2c2

Performed in the feature worktree on 2026-09-20 (local time):

- `npm run check`: passed. Existing root and control-plane dependencies were
  reused through local junctions; no dependency manifest or lockfile changed.
- `npx vite build`: passed. The demonstration refuses stale client output.
- Focused Vitest: **49 passed**, comprising the receipt workflow/client tests,
  the 15 merged durable-service cases and the four spec-registration checks.
  Log: `test-results/inventory-focused-final.log`.
- Inventory Playwright: **27 passed**, nine scenarios on each of the three
  viewports. Log: `test-results/inventory-browser-final.log`; machine-readable
  report and screenshots: `test-results/inventory-receipts/`. Captures were
  inspected for readable controls, evidence and horizontal overflow.
- Broad Vitest: **4,030 passed, 1 skipped, 1 failed** across 208 files. The sole
  failure is `tests/hostile-truth-capability-record.test.ts:118`, which expects
  the published version to differ from source although the current checked-in
  release record says they match. It was reproduced (13 passed, 1 failed) in
  an untouched detached checkout of origin/main `b4eb2c2`, at
  `F:/Diomedes/diomedes-wt/inventory-receipt-baseline`. The implicated source,
  test and release record have no diff in this slice. Broad-run log:
  `test-results/inventory-full-vitest-final.log`.
- Required core Playwright (`ui`, `native-ui`, `field`): **26 passed, 1 failed,
  9 did not run**. `tests/ui.spec.ts:523` expected `data-detail="standard"`
  but saw `guided`. The clean-main targeted comparison timed out in browser
  setup before this assertion, so its cause is not established by this slice.
  Logs: `test-results/inventory-core-browser.log` and the baseline checkout's
  `test-results/baseline-detail-menu.log`. No UI or capability-record test outside
  the named spec-coverage registration was changed to conceal a failing gate.

At this original-base checkpoint the complete repository gates were not green,
so publication was withheld. The detached baseline worktree and its evidence are
retained. The combined-candidate verification below supersedes that checkpoint.

### Rebase onto merged recovery composition

PR24 merged at 2026-09-21T02:41:53Z as
`41147e232a3d19dcd849a80db3c69e612683ddc0`, after PR20. A fresh fetch, GitHub PR
record and ancestry check confirm this main commit contains recovery candidate
`a27e0188459f370b808a565956eca565ac126dcb` and the release-fact repair in
`27c157ddb2991661f2ace42d0734083d543b3a80`. The clean local consumer branch was
rebased without conflicts; its initial work-order base above is historical.
The previously pending receipt-recovery prerequisite is now included by ancestry.
Earlier test counts do not certify this combined candidate; its verification is
recorded separately when complete. No installed application or deployment changes
as a result of rebasing.

The branch subsequently rebased without conflicts onto current main
`d8e39212fdea80cc2d6b70f500117fe65809751a`, which also contains PR21/22/23.
Final review made older-history pagination use the same binding and saved-intent
checks as Refresh; a real 21-receipt browser case verifies both pagination and
refusal after a changed binding.

### Final combined candidate on d8e3921

Performed on 2026-09-20 local time, with the exclusive repository heavy slot:

- TypeScript: passed (`test-results/inventory-rebased-typecheck.log`).
- Full Vitest: **4,069 passed, 1 skipped**, all **211 files passed**
  (`test-results/inventory-rebased-vitest.log`). This includes the 30 new
  receipt service/client unit cases and the merged recovery authority tests.
- Vite build: passed (`test-results/inventory-rebased-vite.log`).
- Inventory browser suite: **30 passed**, ten scenarios per viewport
  (`test-results/inventory-rebased-browser.log` and
  `test-results/inventory-receipts/results.json`). No stock-response mocks;
  the actual service writes the isolated Store. Phone, tablet and desktop
  captures remain labeled as emulation/development evidence.
- Required core browser confirmation: **36 passed**
  (`test-results/inventory-rebased-core-browser-confirmation.log`).

The first combined core run had **32 passed, 1 failed, 3 not run**: the Engines
test at `tests/ui.spec.ts:1097` could not find `Default choice`. Clean main
`d8e3921` then passed all 36 in the retained detached comparison checkout
`F:/Diomedes/diomedes-wt/inventory-receipt-main-comparison`, and the unchanged
feature code passed all 36 on a fresh profile. The original failure's cause is
not established; this is not a claimed repair. Its log and trace are retained in
`test-results/inventory-rebased-core-browser.log` and
`test-results/rebased-core-first-failure/`. Test-generated tracked screenshots
were archived under ignored test-results and only those files restored.

All final source changes are limited to the manifest below. Fresh fetch still
identified main as `d8e3921` before publication. The scoped source slice is ready
for review; installer publication, physical-device and independent demonstration
acceptance, and the broader recovery findings below remain separate.

## Integration prerequisite

The separate `inventory-receipt-validation` task reported two reproduced defects
in the merged stock repository: an unrecognized stock replacement discards the
pending journal, and malformed stock JSON escapes operation status as a
`SyntaxError`. That task owns `server/inventory/stock-repository.ts`; this slice
does not change it. The repair has now been merged and included as recorded in
the rebase section. Independent scoped acceptance of that repair does not prove
the combined consumer or resolve the additional findings below.

Follow-up recovery audit: the other task's SWE report at
`F:/Diomedes/deliverables/personalized-demo-readiness-20260920/continuation-native-workflows/stock-recovery-swe-review.md`
also identifies generic Store reads recording a pending inventory replacement as
`outside`/`observed` before inventory recovery, and malformed pending journals
being parsed before project/path filtering. These remain reported integration
blockers, not fixes accepted by this consumer. Recovery candidate
`a27e0188459f370b808a565956eca565ac126dcb` is reported to address lost receipt
evidence and malformed stock JSON only. Its initial pending status is superseded
by the merged ancestry above. Do not infer journal scoping or general Store
integration from that candidate.

The current isolated fixture awaits `InventoryStockService.init(project.id)`
before returning the service and before the demonstration mounts/listens. Its
startup validation reads the stock file directly without recording History, and
it exposes no generic `readDocument`, `writeRecorded` or restore route. This
ordering was checked in source; it does not qualify the general desktop host.
Future host composition must finish inventory recovery before admitting generic
readers/writers of the stock path, and must remain closed when recovery cannot
settle. Add explicit crash-window and malformed/foreign-journal coverage with
the owning recovery task before integration. Full MI03 remains OPEN.

## Changed files

```text
client/console/InventoryReceipts.tsx
client/console/inventory-receipts.css
client/inventory/main.tsx
client/inventory/receipt-client.ts
docs/demos/inventory-receipts-0.1.6.md
docs/implementation/2026-09-20-inventory-mobile-receipt-history.md
inventory.html
playwright.inventory.config.ts
scripts/inventory-receipts-demo.ts
server/inventory/receipt-routes.ts
server/inventory/stock-service.ts
shared/inventory-workflow.ts
tests/fixtures/inventory-receipts.ts
tests/inventory-receipt-client.test.ts
tests/inventory-receipt-ui.spec.ts
tests/inventory-receipt-workflow.test.ts
tests/spec-coverage.test.ts
vite.config.ts
```

The initial broad run also caught the new browser config missing from the
repository's spec-coverage registry. That registration was corrected, and the
subsequent broad and focused runs pass the guard. The first browser run exposed
an unbound native `fetch` call; the final client and all device scenarios use
the corrected transport. Neither earlier failure is hidden as a passing run.
