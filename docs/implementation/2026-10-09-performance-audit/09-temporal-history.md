# AUDIT-09: Group temporal successor history once

Feature: memory-temporal-index. Prompt: AUDIT-09. Owner: Codex worker 09,
under Andrew's authorized nine-worker performance repair work order.
Branch: `feature/memory-temporal-index`.
Worktree: `F:/Diomedes/diomedes-wt/memory-temporal-index`.
Base: `22a27ef2946af227e571ada58c128e0a5243c91c`.
Canonical mirrors: Core Pillars, Live Roadmap and Project Memory
`2026-10-06.1`; the parent reconciled their canonical versions.

## Why

`MemoryService.read` grouped known revisions, then filtered every complete
snapshot entry again for each selected record's successor. With N entries and
R returned records, that successor lookup performed N * R entry visits. A
10,000-entry snapshot containing distinct records required 100,000,000 visits,
even though each record had no successor. The existing snapshot capacity bound
did not make that repeated scan inexpensive.

The deterministic regression commits 64 distinct records and a later correction
to each in a real temporary SQLite ledger. It wraps entries only after the store
returns a snapshot, counts `id` property reads during the service call, and
requires at most four identity reads per complete entry. It checks both a
current read and a recorded-time cutoff that hides corrections while retaining
their closing timestamps. There are no timing assertions.

The unchanged source exceeded the 512-read budget: 16,640 identity reads for
the current read and 16,512 for the historical read. The temporal boundary
control passed on the unchanged source.

## Repair and preserved behavior

The read method groups the complete, sequence-bounded record history once.
Each record's revisions are sorted once; selection walks them backward while
respecting the recorded-time cutoff, and successor lookup walks that same
record's list forward. Non-record payloads do not enter record histories, and
successors retain the record-kind check. An entity sharing the record ID cannot
close it.

Grouping the complete history matters: a replacement learned after the query's
recorded time still supplies the earlier view's `recordedTo`. Its body remains
excluded from the returned snapshot. Future-effective revisions close earlier
views only when applicable at `validAt`. Replacement corrections, retractions,
unknown validity, record ordering and the `throughSequence` boundary retain
their previous semantics. Existing read admission and outbox repairs remain
unchanged.

Grouping, selection and successor searches now visit O(N) entries in total.
Sorting remains O(sum(k_i * log(k_i)) + R * log(R)), where k_i is one record's
revision count; the final term is the existing returned-record sequence sort.
The transient index stores O(N) entry references and no payload clones. Selection
no longer copies and reverses each revision list. Without a recorded-time
cutoff, the returned snapshot reuses the already isolated complete entry array
instead of creating another full array. An explicit cutoff still filters it.
The full snapshot and its capacity ceiling remain necessary; this change does
not add paging, retention, a persistent index or an authorization cache.

## Verification

The parent granted one exclusive turn under its shared heavy-test slot.
Vitest 3.2.7 ran on 2026-10-09 America/New_York with one worker. Each command
completed on its first attempt; no native runner startup failures occurred.

| Run | Passed | Failed | Skipped | Result |
| --- | ---: | ---: | ---: | --- |
| Focused RED, 21:32:48 | 1 | 2 | 53 | New regressions against base read method; only operation budgets fail. Exit 1. |
| Focused GREEN, 21:33:24 | 3 | 0 | 53 | All AUDIT-09 cases pass, including both 512-read budgets. Exit 0. |
| Complete memory suites, 21:33:39 | 124 | 0 | 0 | 56 ledger cases and 68 recovery cases in one unfiltered run. Exit 0. |

The focused skips come only from the name filter. Every excluded case passed
in the complete run.

```text
node node_modules/vitest/vitest.mjs run tests/memory-ledger.test.ts -t "AUDIT-09" --maxWorkers=1 --minWorkers=1
node node_modules/vitest/vitest.mjs run tests/memory-ledger.test.ts tests/memory-store-recovery.test.ts --maxWorkers=1 --minWorkers=1
```

The focused command ran once for RED and once for GREEN. `git diff --check`
passed. Full repository TypeScript, unit, build and browser gates are unrun in
this lane; the parent owns the combined candidate's gates and main integration.
No timing benchmark, installed-app test, provider call or live-profile operation
ran. Local tests do not establish release, deployment, migration or customer
acceptance. GitHub Actions remains stopped under `F:/Diomedes/CI-STOP.md`; this
lane creates its authorized `[skip ci]` repair commit without pushing.

Pillar impact: preserves scoped knowledge, source history and revocation under
Pillars 09, 13 and 14 while removing a repeated scan from deterministic reads.
No canonical definition, roadmap status or completed-prompt record changes.
The worker does not merge, publish, install, deploy or change a live profile.
