# AUDIT-02: guard the actual SDK loader environment

Feature: `agentfs-loader-guard`.
Prompt: `AUDIT-02` of the 2026-10-09 performance audit.
Branch: `feature/agentfs-loader-guard`.
Worktree: `F:/Diomedes/diomedes-wt/agentfs-loader-guard`.
Owner: assigned GPT-6.1 Sol worker, maximum reasoning.
Base: `c6a26ea6ba9c308c9802e851468215c30ae002dc`, including AUDIT-01.
Canonical repository mirrors: pillars, roadmap and project memory `2026-10-06.1`.

## Why

`loadAgentFsSdk` merged `options.env` over `process.env` before checking native
loader overrides. A caller passing an explicit `undefined` for
`NAPI_RS_NATIVE_LIBRARY_PATH` or `NAPI_RS_FORCE_WASI` could therefore hide a
present process override from the guard. The engine's native loader still reads
the actual process environment, so the pin checks did not cover what it would
load.

The guard now rejects a defined override from either environment independently.
An undefined caller value cannot clear a real process override. Empty strings
remain defined overrides, and caller-only overrides are still refused. Error
codes, variable-name-only diagnostics, package pins and platform checks retain
their existing semantics. Production code does not modify `process.env`.

The regressions cover both variable names, omitted and empty caller environments,
explicit undefined caller values, nonempty and empty-string process overrides,
caller-only overrides, and a clean undefined-options control that reaches the
SDK pin checks. Each loader test stubs both guarded process variables and
restores them with `vi.unstubAllEnvs` afterward. All guard-order assertions use a
nonexistent SDK directory, so they require no native import.

## Local verification

All commands ran directly from this worktree, serially under the parent's
coordinated test slot. `NCTS_TURSO_NODE_MODULES` was unset. Each command completed
on its first process-start attempt; there were no out-of-memory retries.

RED, against the base implementation with the new regression tests:

```text
node node_modules/vitest/vitest.mjs run tests/agentfs-files-conformance.test.ts --maxWorkers=1 --minWorkers=1 -t "loading the SDK"
```

Exit 1: 6 passed, 4 failed, 130 skipped, 140 total. All four failures were the
explicit-undefined masking assertions: each guarded variable with either a
nonempty process value or an empty string returned `agentfs_not_pinned` instead
of `agentfs_loader_override`. The preceding omitted and empty caller-environment
assertions passed, as did caller-only override and clean pin-check controls.

GREEN, after the independent-environment guard fix, using the same command:

Exit 0: 10 passed, 0 failed, 130 skipped, 140 total. The 130 skips comprise 62
nonselected stand-in conformance tests and 68 optional installed-SDK/native
tests.

Full AgentFS conformance file:

```text
node node_modules/vitest/vitest.mjs run tests/agentfs-files-conformance.test.ts --maxWorkers=1 --minWorkers=1
```

Exit 0: 72 passed, 0 failed, 68 skipped, 140 total. The 68 optional skips are 62
installed-SDK conformance tests, one pinned-install load test and five native
engine probes. The inherited AUDIT-01 source-generation tests passed.
`git diff --check` passed. Counts and failure details come from these worker
Vitest command outputs; no skipped test is counted as passing.

## Boundary

This patch changes only SDK loader guarding and its regressions. Aggregate
workspace capacity is a separate finding. No SDK dependency or probe install was
added and no native binary was loaded. Full repository tests, typecheck, build,
browser checks and installed-app qualification were not run by this worker;
final integration verification belongs to the parent. GitHub Actions remains
stopped under `F:/Diomedes/CI-STOP.md`.

No roadmap or product-definition status changes are required. This preserves the
existing pin and Trust boundary of the optional candidate adapter. It is local
repair evidence, with main integration, publication, deployment and customer
acceptance still separate. The worker commits the bounded patch; the parent owns
main integration. No push, merge, deployment or live-profile action occurred in
this lane.
