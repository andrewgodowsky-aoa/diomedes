# W04 implementation — Extend H18 with model-aware budgets, continuation capsules and safe compaction

<mission>
Implement W04 from NC-MEM-LC-2026-10-06.1 against the current Nectovia repository. Andrew approved the native memory architecture with Agent Memory Repo interoperability. This is one part of the whole build, not permission to replace Runtime/Trust or to declare the epic done.
</mission>

<read_first>
Read AGENTS.md, the three current canonical documents and this package's START_HERE, architecture, contracts and the W04 section of the implementation plan. Read work-items.json and publication.json for current links. Prerequisites: W03.
Inspect these existing seams: server/harness/context-assembly.ts, shared/context-accounting.ts, server/harness/native-agent.ts, server/harness/native-loop.ts, server/lineage-continuity.ts.
</read_first>

<deliverables>
1. Compute bounded input room from native/qualified/configured limits and output/protocol/tool/multimodal reserves. Retain byte/JSON guards separately; unknowns are not infinity.
2. Build deterministic capsules from goal, declared checks, exact active constraints, observable progress, unresolved questions, evidence references and runtime effect/approval checkpoints.
3. Implement high/low-watermark planning and durable compaction intents. Optional model narrative is separately metered and checked; commit only against unchanged input/authority/deletion epochs and expected capsule revision.
4. Preserve tool-call/result pairing and uncertain-effect state across rollover, stop, process restart, task fork and a deliberately reset engine session. Nothing in a capsule grants permission or completes a task.
5. Support original-evidence rehydration and periodic rebase rather than unbounded summary-of-summary drift. Failed/null summaries retain the last valid capsule; no fallback route is selected silently.
</deliverables>

<implementation>
Work in your own authorized worktree. Refresh live issue state and hot-file ownership. Follow repository TDD and verification conventions. First failing proof: Force a tiny but declared test context across twenty rollovers; lose a mid-source negation, crash after a tool intent, then revoke a supporting source. Each violated invariant must be caught before implementation.
Proposed files: shared/continuation.ts, server/harness/context-controller.ts, server/harness/context-budget.ts, server/harness/continuation.ts, server/harness/context-compaction.ts, tests/context-controller.test.ts, tests/context-rollover.test.ts.
Use current canonical types and source paths; document necessary path adjustments rather than creating duplicate services. Implement real behavior, not just schemas, interfaces or a demo that bypasses the harness.
</implementation>

<acceptance>
Run context-controller.test.ts, context-rollover.test.ts, context-protocol-integrity.test.ts; implement the relevant matrix assertions M14, M38, M45, L02, L03, L04, L05, L06, L07, L08, L09, L10, L17, L18. W11 must verify them independently. Gate: At least twenty scripted rollovers and a hundred-step fixture retain exact critical facts and do not duplicate any uncertain effect; live reasoning quality is still unmeasured.
Preserve unknown/partial/unverified states. Synthetic adapters do not prove model reasoning, installed engines, production identities or live provider behavior.
</acceptance>

<limits>
This extends DIO-23. Do not remove the serialization guard or change opaque transcript state inside prepare. Do not request/store hidden chain-of-thought.
Never hide inference in a pure zero-cost prepare transform; never infer grants from memory. Do not fabricate source IDs, exact usage, provider support or successful effects. Use no unapproved customer data, secret copies, paid calls, migration, commit, push, merge or deployment. Do not erase unrelated current work.
</limits>

<finish>
Report exact changed files, source/base identity, failing and passing test evidence, independent review status, migration/resource implications, acceptance IDs covered, unresolved blockers and the next eligible item. Update only the relevant local execution record and authorized tracker state. If context is running low, leave an evidence-linked continuation with next steps and pending effects, not a promise of background work.
</finish>

## Live delivery record

[DIO-231](https://linear.app/diomedesdevs/issue/DIO-231/nc-mem-lc-w04-h18-continuation-capsules-budgets-and-safe-context) · [Epic](https://linear.app/diomedesdevs/issue/DIO-226/nc-mem-lc-governed-memory-and-reliable-long-context-execution) · [Notion context](https://app.notion.com/p/3f192213bac981e0b69cffeab65df50c?pvs=204).
Read current status and ownership before acting. These were created Backlog, not accepted, on October 6, 2026.
