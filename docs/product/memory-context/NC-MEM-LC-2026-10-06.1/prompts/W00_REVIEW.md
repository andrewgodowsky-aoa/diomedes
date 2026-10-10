# Independent review — W00

Review the candidate for **Reconcile source, ownership and baseline; freeze integration contracts** independently. Read NC-MEM-LC-2026-10-06.1, current AGENTS.md and the actual diff, not just the implementer's report. Confirm prerequisites source reconciliation and inspect AGENTS.md, docs/DIOMEDES_CORE_PILLARS.md, docs/DIOMEDES_LIVE_ROADMAP.md, docs/DIOMEDES_PROJECT_MEMORY.md, server/harness/context-assembly.ts, server/harness/native-agent.ts, server/harness/native-loop.ts, shared/context-accounting.ts.

Required behavior:
- Map live main, local worktrees, DIO-23/H18, H11/H13/H09, H20 and active plugin/hooks work. Record conflicts and reuse implemented slices, not old task counts.
- Import this package into docs/product/memory-context/ in an owned worktree only; validate hashes before trusting it. Preserve the archived first pass. Record exact known/current/assumed boundaries.
- Create deterministic two-tenant baseline fixtures and run current selectHistory/compactTurns/prepare behavior. Record the first-sentence correction counterexample without calling it a model hallucination benchmark.
- Map route byte/JSON/token limits, actual supported SQLite packaging driver, cloud schema/migration ownership, budget reservation seams and lifecycle coordination. Commit no dependency or production schema choice without the required source/security review.
- Freeze strict portable contracts and adapters to existing canonical types; distinguish host fields from generated proposals. Reconcile the 262144 JSON length guard, underscore tool names, and current pure prepare contract.

Read and challenge the tests: memory-context-baseline.test.ts, memory-contracts.test.ts. Verify matrix coverage L01. Check the specific counterexample: Add fixtures for late corrections, unknown window, a source epoch change and repeated opaque transcript references. Demonstrate the current limitation or the new contract test failing for the intended missing behavior, not a missing import.

Inspect identity/scope binding, evidence quality, temporal conflict behavior, cancellation/replay/idempotency, dirty-base protection, forgotten-source resurrection, route/payer restrictions, all-in usage, protocol integrity and partial/unknown user states wherever affected. Mutation-test the important guards in an isolated copy when authorized. A broad test count is not coverage proof.

Do not infer production verification from fixtures or a document status. Do not weaken tests to approve the change. Do not commit/push/deploy. Return ACCEPT, ACCEPT WITH FIXES or REJECT with severity, exact file/line, reproducible counterexample, minimal correction and missing proof. Note whether you actually ran tests. No fabricated independent review if you are the same worker that implemented the change.

## Live delivery record

[DIO-227](https://linear.app/diomedesdevs/issue/DIO-227/nc-mem-lc-w00-reconcile-source-and-freeze-memorycontext-contracts) · [Epic](https://linear.app/diomedesdevs/issue/DIO-226/nc-mem-lc-governed-memory-and-reliable-long-context-execution) · [Notion context](https://app.notion.com/p/3f192213bac981e0b69cffeab65df50c?pvs=204).
Read current status and ownership before acting. These were created Backlog, not accepted, on October 6, 2026.
