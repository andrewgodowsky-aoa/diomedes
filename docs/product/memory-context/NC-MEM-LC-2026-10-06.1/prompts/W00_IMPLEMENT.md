# W00 implementation — Reconcile source, ownership and baseline; freeze integration contracts

<mission>
Implement W00 from NC-MEM-LC-2026-10-06.1 against the current Nectovia repository. Andrew approved the native memory architecture with Agent Memory Repo interoperability. This is one part of the whole build, not permission to replace Runtime/Trust or to declare the epic done.
</mission>

<read_first>
Read AGENTS.md, the three current canonical documents and this package's START_HERE, architecture, contracts and the W00 section of the implementation plan. Read work-items.json and publication.json for current links. Prerequisites: W00 is the first item; inspect source and ownership.
Inspect these existing seams: AGENTS.md, docs/DIOMEDES_CORE_PILLARS.md, docs/DIOMEDES_LIVE_ROADMAP.md, docs/DIOMEDES_PROJECT_MEMORY.md, server/harness/context-assembly.ts, server/harness/native-agent.ts, server/harness/native-loop.ts, shared/context-accounting.ts.
</read_first>

<deliverables>
1. Map live main, local worktrees, DIO-23/H18, H11/H13/H09, H20 and active plugin/hooks work. Record conflicts and reuse implemented slices, not old task counts.
2. Import this package into docs/product/memory-context/ in an owned worktree only; validate hashes before trusting it. Preserve the archived first pass. Record exact known/current/assumed boundaries.
3. Create deterministic two-tenant baseline fixtures and run current selectHistory/compactTurns/prepare behavior. Record the first-sentence correction counterexample without calling it a model hallucination benchmark.
4. Map route byte/JSON/token limits, actual supported SQLite packaging driver, cloud schema/migration ownership, budget reservation seams and lifecycle coordination. Commit no dependency or production schema choice without the required source/security review.
5. Freeze strict portable contracts and adapters to existing canonical types; distinguish host fields from generated proposals. Reconcile the 262144 JSON length guard, underscore tool names, and current pure prepare contract.
</deliverables>

<implementation>
Work in your own authorized worktree. Refresh live issue state and hot-file ownership. Follow repository TDD and verification conventions. First failing proof: Add fixtures for late corrections, unknown window, a source epoch change and repeated opaque transcript references. Demonstrate the current limitation or the new contract test failing for the intended missing behavior, not a missing import.
Proposed files: docs/implementation/2026-10-06-memory-context-baseline.md, tests/memory-context-baseline.test.ts, tests/fixtures/memory-context/, shared/memory.ts (new contract only after reconciliation), shared/continuation.ts (new).
Use current canonical types and source paths; document necessary path adjustments rather than creating duplicate services. Implement real behavior, not just schemas, interfaces or a demo that bypasses the harness.
</implementation>

<acceptance>
Run memory-context-baseline.test.ts, memory-contracts.test.ts; implement the relevant matrix assertions L01. W11 must verify them independently. Gate: A reproducible baseline and interface map exist; every touched hot file has ownership checked. No claim that existing acceptance ledgers are closed.
Preserve unknown/partial/unverified states. Synthetic adapters do not prove model reasoning, installed engines, production identities or live provider behavior.
</acceptance>

<limits>
Read-only source exploration and owned offline tests are allowed. Do not reset another worktree, alter global credentials, launch paid calls or update unrelated canonical text.
Never hide inference in a pure zero-cost prepare transform; never infer grants from memory. Do not fabricate source IDs, exact usage, provider support or successful effects. Use no unapproved customer data, secret copies, paid calls, migration, commit, push, merge or deployment. Do not erase unrelated current work.
</limits>

<finish>
Report exact changed files, source/base identity, failing and passing test evidence, independent review status, migration/resource implications, acceptance IDs covered, unresolved blockers and the next eligible item. Update only the relevant local execution record and authorized tracker state. If context is running low, leave an evidence-linked continuation with next steps and pending effects, not a promise of background work.
</finish>

## Live delivery record

[DIO-227](https://linear.app/diomedesdevs/issue/DIO-227/nc-mem-lc-w00-reconcile-source-and-freeze-memorycontext-contracts) · [Epic](https://linear.app/diomedesdevs/issue/DIO-226/nc-mem-lc-governed-memory-and-reliable-long-context-execution) · [Notion context](https://app.notion.com/p/3f192213bac981e0b69cffeab65df50c?pvs=204).
Read current status and ownership before acting. These were created Backlog, not accepted, on October 6, 2026.
