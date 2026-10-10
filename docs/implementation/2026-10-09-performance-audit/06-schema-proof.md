# Item 6: require a complete schema reference before qualification

Feature: `turso-schema-proof`. Prompt: performance audit, item 6 of 9.
Branch: `feature/turso-schema-proof`.
Worktree: `F:/Diomedes/diomedes-wt/turso-schema-proof`.
Worker: `/root/fix_06_schema`; integration owner: parent `/root`.
Base: `7c40ce5ff7b52d8c93e245d13c7d08a44e44a56e`.
The three repository canonical documents are version `2026-10-06.1`.

## Finding and change

`same-engine-schema-reference` executed `PROBE_SCHEMA` on an in-memory reference
and a file, then qualified their serialized catalogs solely by equality. A driver
returning `[]` for both `SCHEMA_OBJECTS` queries was marked `proven` with
`0 schema objects match`. Identical nonempty but incomplete catalogs also passed.

The reference must now contain exactly the twelve named objects the probe schema
creates: four tables, five implicit indexes and three triggers. Each object must
have its expected type and table owner. Tables and triggers must carry nonempty
SQL text; implicit indexes must carry null SQL. Duplicate, missing or malformed
objects cannot satisfy the positive control. An incomplete reference returns
`unverified`, which preserves `retain-sqlite`.

The existing exact comparison of the file catalog with that validated reference
remains in place. It still reports `violated` for file-only catalog or SQL drift.
The healthy reference still proves twelve matching objects. The two existing
trigger-removal mutation cases now name the additional unverified schema reference
alongside their own violated protection.

## Local verification

All Vitest commands used `node node_modules/vitest/vitest.mjs run` and
`--maxWorkers=1 --minWorkers=1`, in this worktree under parent-held shared slot
`slot_mv1p7jaz_2e92f9bf`. Runs occurred on 2026-10-09 EDT / 2026-10-10 UTC with
Node `v22.23.2` and Vitest `3.2.7`.

| Run | Selection | Passed | Failed | Skipped |
|---|---|---:|---:|---:|
| Regression-only RED | `tests/turso-contract-baseline.test.ts -t 'schema catalog'` | 2 | 8 | 81 |
| Focused GREEN | Same schema catalog selection | 10 | 0 | 81 |
| First single-file run | `tests/turso-contract-baseline.test.ts` | 79 | 2 | 10 |
| Trigger-mutation GREEN | `tests/turso-contract-baseline.test.ts -t 'notices (immutable-rows\|monotonic-epoch) when'` | 2 | 0 | 89 |
| Final single-file GREEN | `tests/turso-contract-baseline.test.ts` | 81 | 0 | 10 |

RED observed the false `proven` result on all eight mirrored catalog mutations:
empty, one object, missing table, missing trigger, missing implicit index, wrong
table owner, absent SQL definition, and a duplicate at the expected object count.
The valid twelve-object case and empty-file-after-valid-reference control passed.

The first single-file failures were the `immutable-rows` and `monotonic-epoch`
mutation expectations. The positive control correctly detected their removed
triggers; naming this additional collateral resolved both failures. The final
single-file run started at `2026-10-10T01:16:31Z` and completed in `55.95s`.

One trigger-mutation runner stalled before Vitest startup, with no output or child
worker. Only its verified owned Node process, PID 56012, was stopped. No tests ran
in that interrupted attempt; a single retry produced the trigger-mutation GREEN
above. The host startup stall is not root-caused and is separate from assertion
failures.

A subsequent commit command exited without output with Windows status
`-1073741502` (`0xC0000142`). A fresh Git read confirmed HEAD stayed at the base
and the scoped index remained intact. This process initialization failure is also
not root-caused.

The focused skips are name-filtered tests. The final ten skips require external
engine, overlay or archive paths; none of `NCTS_TURSO_NODE_MODULES`,
`NCTS_PACKAGE_DIR` or `NCTS_NCUM_ARCHIVE` was configured. Existing recorded Turso
verdict assertions passed; the pinned real Turso/AgentFS checks were not rerun.
`git diff --check` passed.

## Boundaries

Only test qualification, its regressions and this note changed. Production
database selection and W01 fallback authority remain unchanged. No support-matrix
derived counts required repair. No roadmap or completed-prompt status changed.
Whole-repository tests, TypeScript, build, browser, packaging and deployment gates
were not run in this item lane. GitHub Actions remains stopped by `CI-STOP.md`.
The local commit is for parent integration; this lane does not push or merge.
