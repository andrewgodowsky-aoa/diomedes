# Item 4: bounded memory outbox admission

Work order: performance audit item 4 of 9, bounded outbox and acknowledgement
operations. Owner: native Codex GPT-6.1 Sol, max reasoning. Feature:
`memory-outbox-admission`; branch: `feature/memory-outbox-admission`; worktree:
`F:/Diomedes/diomedes-wt/memory-outbox-admission`.

Base: `b7d00c1e69e4258c8f6569b6e17abfb23cdbeefe`. Pillars, Roadmap and Project
Memory versions inspected: `2026-10-06.1`. The parent holds the exact source and
documentation claims and the shared test slot. This lane changes only the
bounded service admission, its regressions and this record.

## Failure and repair

`MemoryService.outbox`, `acknowledge` and `acknowledged` previously called an
unbounded service snapshot before their bounded store operation. With two
stored entries and `maxSnapshotEntries: 1`, those calls fail `memory_capacity`
even though a one-event page and the acknowledgement operations fit their own
limits. The default ceiling produces the same failure once history exceeds
10,000 entries.

The fix uses the existing `snapshot(scope, 0)` admission path. Sequence zero loads no
history entries while preserving strict scope parsing, current host authority,
the componentwise monotonic durable epoch floor and the snapshot's final epoch
checks. The store still validates page bounds, consumer IDs, sequence values
and monotonic acknowledgement positions. Outbox still rejects a returned event
from a stale epoch and rechecks host authority before returning the page.

Acknowledgements retain their existing synchronous pre-operation admission
semantics. This lane adds no store API or new acknowledgement transaction
behavior. Snapshot admission still opens a write transaction; audit item 5 owns
removing that cost for unchanged epochs. Full snapshots keep their ceiling and
continue to refuse oversized history instead of truncating or pruning it.

## Verification

Eleven regression cases use real `LocalMemoryStore` instances in owned temporary
profiles, with no network or production data. They cover bounded pages,
durable monotonic acknowledgements and per-consumer reads above the snapshot
ceiling; tenant/workspace/scope isolation; stale host authority and durable
rollback floors for each epoch component; malformed requests; and the final
outbox host-authority check.

The parent granted an exclusive turn in the shared test slot. Vitest 3.2.7 ran
each command with `--maxWorkers 1 --minWorkers 1` on 2026-10-09:

| Run | Passed | Failed | Skipped | Evidence |
| --- | ---: | ---: | ---: | --- |
| Focused RED | 0 | 11 | 35 | Unchanged service on the base plus the new regressions; every selected case failed because admission loaded history and hit `memory_capacity`. |
| Focused GREEN | 11 | 0 | 35 | The three service calls changed to `snapshot(scope, 0)`. |
| Final memory suites | 99 | 0 | 0 | One run of both suites: 53 ledger cases and 46 recovery cases. Exit code 0. |

The 35 skipped cases were excluded by the focused test-name filter; they passed
in the final unfiltered memory-suite run. No test-runner startup failure occurred
in these runs.

Commands, each invoked through `node_modules/.bin/vitest.cmd`:

```text
run tests/memory-store-recovery.test.ts -t "W01 bounded outbox admission" --maxWorkers 1 --minWorkers 1
run tests/memory-ledger.test.ts tests/memory-store-recovery.test.ts --maxWorkers 1 --minWorkers 1
```

The first command ran once for RED and once for GREEN. `git diff --check` passed.

Full TypeScript, unit, build, browser and packaged-platform gates are unrun in
this lane. The parent owns combined local validation and final main
integration. Hosted CI remains stopped. No push, merge, installation, live
profile migration or deployment is performed by this worker. No roadmap or
completion status is advanced here.
