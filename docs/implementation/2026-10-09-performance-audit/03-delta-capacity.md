# AUDIT-03: enforce the receiving host's logical delta capacity

Feature: `agentfs-delta-capacity`.
Prompt: `AUDIT-03` of the 2026-10-09 performance audit.
Branch: `feature/agentfs-delta-capacity`.
Worktree: `F:/Diomedes/diomedes-wt/agentfs-delta-capacity`.
Owner: assigned GPT-6.1 Sol worker, maximum reasoning.
Base: `74989a2b76c4c834a0bce66791566527b643de40`, including the other eight audit
repairs and the startup improvement.
Canonical repository mirrors: pillars, roadmap and project memory `2026-10-06.1`.

## Why

Checkpoint import applied the host's base, file-count and physical database
limits, but its database validation only hashed files. A logical delta larger
than the host's 8 MiB allowance could therefore import inside the separate
32 MiB database/journal limit. Output collection also lacked an aggregate check,
so direct database edits bypassed the tools' write budget.

Import now sums each buffer's actual byte length while verifying the database's
file hashes. It applies the receiving host's limit before publishing an owner or
lease. An oversized import closes its database and removes its staged workspace
through the existing refusal cleanup. Source lease limits and SDK size metadata
cannot raise or understate this actual-byte check. The existing physical copy
bounds and exact file/hash checks remain in force.

Collection uses the same actual-byte sum before filtering outputs. Every walked
plain file counts, including an unchanged pinned copy and a file outside the
output scope. A change to a pinned file counts its complete copied bytes, not
the text diff. The existing walk still excludes links and folders past its depth
limit, and retains its entry and file-count caps. Returned files are also checked
against the per-file cap using their actual bytes as well as their reported size.
Text, path, scope and recorded-writer rules retain their existing behavior.

Both sums reuse the content reads already needed for verification. Collection
now also reads plain files that it previously dropped before reading content,
so their actual bytes cannot evade the budget. It stops at the first overrun and
does not add a second complete content pass. Proposal and promotion both refuse
with `workspace_budget` before any Store write or spent-workspace transition.

The contradictory import comment and existing base-limit test name now describe
when validation occurs: physical metadata is bounded before copying; logical
file bytes are verified after that bounded copy, before authority is published.

## Local verification

All Vitest commands ran directly from this clean worktree, serially under the
parent's coordinated test slot, with `NCTS_TURSO_NODE_MODULES` unset. Each started
successfully on its first attempt. No Windows process-start or out-of-memory
failure occurred, and no foreign process was stopped.

RED, against the base implementation with the new regressions:

```text
node node_modules/vitest/vitest.mjs run tests/agentfs-files-conformance.test.ts -t AUDIT-03 --maxWorkers=1 --minWorkers=1
```

Exit 1: 1 passed, 6 failed, 147 skipped, 154 total. The exact 64-byte control
passed. Oversized proposals unexpectedly resolved for changed pinned bytes,
unchanged pinned bytes, out-of-scope bytes and understated SDK size metadata.
A 65-byte file was returned despite a 64-byte file cap under understated metadata.
Import also unexpectedly accepted 8,388,609 bytes on the 8,388,608-byte host.
No promotion of that large checkpoint was attempted.

Focused GREEN after the repair:

```text
node node_modules/vitest/vitest.mjs run tests/agentfs-files-conformance.test.ts -t AUDIT-03 --maxWorkers=1 --minWorkers=1 --reporter=dot
```

Exit 0: 7 passed, 0 failed, 147 skipped, 154 total, 2.91 seconds. The 147 skips
are 72 nonselected local tests and 75 optional installed-SDK/native tests.
Small lease limits exercise proposal and promotion refusals without project
writes, including a one-byte text edit whose complete pinned copy exceeds the
budget. The checkpoint control accepts exactly 8 MiB, then refuses one extra
out-of-scope byte despite permissive source limits and zero SDK size metadata.
The refused receiver has no owner, lease or staged directory; a receiver with an
existing workspace retains its lease and proposal digest.

Full conformance file:

```text
node node_modules/vitest/vitest.mjs run tests/agentfs-files-conformance.test.ts --maxWorkers=1 --minWorkers=1
```

Exit 0: 79 passed, 0 failed, 75 skipped, 154 total, 11.11 seconds. The 75
optional skips are 69 installed-SDK conformance tests, one pinned-install load
test and five native engine probes. The inherited source-generation capture,
loader guard, import cleanup, scope, text, writer and promotion controls passed.
Counts and failure details come from this worker's Vitest command outputs.
`git diff --check` passed.
The parent reviewed both counters, the actual per-file check and all seven
regressions, and approved this worker's bounded commit after those checks.

## Boundary

No dependency, fixture package, SDK install or native load was added. No profile,
provider, installation, account or routing state changed. Full repository tests,
typecheck, Vite build, browser gates and installed-app/native qualification were
not run by this worker; final integration gates belong to the parent. GitHub
Actions remains stopped under `F:/Diomedes/CI-STOP.md`.

This is a local correction to the optional candidate adapter, which remains
unwired. No roadmap or product-definition status changes are required. This
worker commits the bounded repair and rationale; main integration, publication,
deployment and customer acceptance remain separate and belong to the parent.
No push, main merge, Actions workflow or deployment occurred in this lane.
