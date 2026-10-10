# Item 5: read-only memory epoch admission

Work order: `AUDIT-05`, performance audit item 5 of 9. Owner: native Codex
GPT-6.1 Sol, max reasoning. Feature: `memory-read-admission`; branch:
`feature/memory-read-admission`; worktree:
`F:/Diomedes/diomedes-wt/memory-read-admission`.

Base: `09e6db1f1d6aed40abf9a5833b312ae63bafc456`. Core Pillars, Live Roadmap
and Project Memory mirrors inspected: `2026-10-06.1`. The parent holds the
exact source/documentation claims and the shared test slot. This lane changes
only service admission, real local-store regressions and this record. Audit
item 9's temporal grouping is separate.

## Failure and repair

`MemoryService.snapshot` previously opened a store write transaction for every
read, including when the durable epoch floor already matched current host
authority. `LocalMemoryStore.write` checkpoints the WAL, acquires `BEGIN
IMMEDIATE` and reserves its worst-case WAL capacity before the admission
callback. An existing seeded store reopened with `maxWalBytes: 1024` permits a
raw read-only snapshot but rejects the equivalent service read with
`memory_capacity`. Outbox and acknowledgement reads inherit that failure
through their bounded snapshot admission.

Read admission now uses `store.snapshot(scopeKey, 0)` to inspect only the scope
and its durable epoch floor. It validates the requested epochs against current
host authority and refuses any saved component above that authority. Only a
missing or advancing floor enters the existing write transaction, where host
authority and the monotonic floor are checked again. Matching floors use
read-only store operations and do not need a WAL write reservation. A requested
sequence-zero snapshot reuses the bounded admission result.

Before snapshots, outbox pages or acknowledgement positions return, another
bounded metadata read and host check verify that authority has not changed.
This also refuses a higher floor committed by another SQLite connection during
the data read, even if the supplied host frontier has rolled back or not yet
caught up. Epoch matching remains necessary rather than sufficient authority;
Runtime and Trust retain authenticated scope and source-access ownership.

Actual acknowledgement writes keep the adapter's write transaction and WAL
capacity check. New schema initialization, initial floor persistence and real
epoch advancement still refuse without write capacity. Full snapshot and
outbox page ceilings remain enforced. No store interface, dependencies or
parallel authority are added.

## Verification

Twenty-two regression cases use real `LocalMemoryStore` instances in owned
temporary profiles. They cover reads and temporal reads with an unchanged
floor at a low WAL limit, a real-store transaction spy, actual acknowledgement
write refusal, initial and advancing floor persistence, missing-floor refusal,
all three stale/advancing/rollback epoch components, and changes in host or
durable authority after each data read. The durable race uses a second SQLite
connection rather than an invented metadata result.

The parent granted one exclusive turn in the shared test slot. Vitest 3.2.7 ran
on 2026-10-09 through the direct Node runner, with one worker:

| Run | Passed | Failed | Skipped | Evidence |
| --- | ---: | ---: | ---: | --- |
| Focused RED | 3 | 19 | 46 | Base service plus new regressions. Unchanged reads hit `memory_capacity`; repeated reads enter write transactions, and low capacity masks stale-epoch refusals. Missing-floor capacity controls pass. Exit 1. |
| Focused GREEN | 22 | 0 | 46 | Read admission and final authority checks applied. Exit 0. |
| Complete memory suites | 121 | 0 | 0 | One unfiltered run: 53 ledger cases and 68 recovery cases. Exit 0. |

The 46 skipped cases were excluded by the focused name filter; all passed in
the complete memory-suite run. No test-runner startup failure occurred.

```text
node node_modules/vitest/vitest.mjs run tests/memory-store-recovery.test.ts -t "W01 read-only epoch admission" --maxWorkers=1 --minWorkers=1
node node_modules/vitest/vitest.mjs run tests/memory-ledger.test.ts tests/memory-store-recovery.test.ts --maxWorkers=1 --minWorkers=1
```

The focused command ran once for RED and once for GREEN. `git diff --check`
passed. Full repository TypeScript, unit, build, browser and packaged-platform
gates are unrun in this lane; the parent owns combined gates and main
integration. Hosted GitHub Actions remains stopped under
`F:/Diomedes/CI-STOP.md`, and the worker commit uses `[skip ci]`.

Pillar impact: preserves scoped knowledge and revocation under Pillars 09, 13
and 14 while removing unnecessary write admission from deterministic reads.
No canonical definition, roadmap status or completed-prompt record changes.
The worker does not push, merge, install, deploy, call a provider or migrate a
live profile. These local results do not establish release or installed-app
acceptance.
