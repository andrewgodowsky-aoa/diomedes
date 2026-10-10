# AUDIT-01: bind pinned bytes to the validated source generation

Feature: `agentfs-source-generation`.
Prompt: `AUDIT-01` of the 2026-10-09 performance audit.
Branch: `feature/agentfs-source-generation`.
Worktree: `F:/Diomedes/diomedes-wt/agentfs-source-generation`.
Owner: assigned GPT-6.1 Sol worker, maximum reasoning.
Base: `2f1601dfd52cde4425a595e06cae6f18d90ec553`.
Canonical repository mirrors: pillars, roadmap and project memory `2026-10-06.1`.

## Why

`pinBase` read the complete scope's source generation before pinning bytes and
validated that generation afterward. It then read and recorded another generation
without validating it. On the same path set, `g1`, `g1`, `g2` therefore bound bytes
read under `g1` to `g2`. Promotion accepted those bytes under the newer authority.

The lease now retains the validated first generation when all listed paths were
pinned. When a guard refuses a path or a listed file disappears, the retained
subset has a different digest scope. Its digest is captured before the final
check of the original full scope. This preserves valid subset digests while
refusing authority drift during their capture. Digests for unlike path sets are
never compared. The existing `WorkspaceSources` contract remains authoritative:
its digest covers all grants for the paths requested.

The recorded writer, expected file hashes, assignment fence and promotion checks
are unchanged. This patch addresses source-generation capture only.

## Local verification

All Vitest runs were serial under the parent's coordinated test slot. No process
startup or out-of-memory retry was needed. Every command ran directly from this
worktree with `NCTS_TURSO_NODE_MODULES` unset.

RED, against the base implementation with the new regression tests:

```text
node node_modules/vitest/vitest.mjs run tests/agentfs-files-conformance.test.ts --maxWorkers=1 --minWorkers=1 -t "source-generation binding"
```

Exit 1: 1 passed, 2 failed, 131 skipped, 134 total. The original implementation
unexpectedly promoted the same-scope drift case and unexpectedly opened the
guarded-path subset drift case. The stable subset promotion control passed.

GREEN, after the capture fix, using the same command:

Exit 0: 3 passed, 0 failed, 131 skipped, 134 total. The 131 skips comprise 63
nonselected local tests and 68 optional installed-SDK/native tests.

Full AgentFS conformance file:

```text
node node_modules/vitest/vitest.mjs run tests/agentfs-files-conformance.test.ts --maxWorkers=1 --minWorkers=1
```

Exit 0: 66 passed, 0 failed, 68 skipped, 134 total. All 68 skips are optional
installed-SDK/native tests. The three new scenarios use the real temporary Store
and the existing AgentFS SDK double. The subset control reads pinned content and
promotes through `Store.writeRecorded`, producing one recorded file change.

`git diff --check` passed. Separate command logs are preserved as
`C:/Users/andre/AppData/Local/Temp/diomedes-audit-01-red-01.log`,
`C:/Users/andre/AppData/Local/Temp/diomedes-audit-01-green-01.log` and
`C:/Users/andre/AppData/Local/Temp/diomedes-audit-01-full-01.log`.

## Boundary

No SDK dependency or probe install was added and no native SDK was loaded. Full
repository tests, typecheck, build, browser checks and installed-app qualification
were not run by this worker; final integration verification belongs to the parent.
GitHub Actions remains stopped under `F:/Diomedes/CI-STOP.md`.

No roadmap or product-definition status changes are required. This is a local
candidate correction to the optional adapter, not deployment or customer
acceptance evidence. The worker commits this bounded patch; main integration and
any authorized publication remain with the parent.
