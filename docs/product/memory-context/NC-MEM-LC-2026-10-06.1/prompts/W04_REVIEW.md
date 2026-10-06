# Independent review — W04

Review the candidate for **Extend H18 with model-aware budgets, continuation capsules and safe compaction** independently. Read NC-MEM-LC-2026-10-06.1, current AGENTS.md and the actual diff, not just the implementer's report. Confirm prerequisites W03 and inspect server/harness/context-assembly.ts, shared/context-accounting.ts, server/harness/native-agent.ts, server/harness/native-loop.ts, server/lineage-continuity.ts.

Required behavior:
- Compute bounded input room from native/qualified/configured limits and output/protocol/tool/multimodal reserves. Retain byte/JSON guards separately; unknowns are not infinity.
- Build deterministic capsules from goal, declared checks, exact active constraints, observable progress, unresolved questions, evidence references and runtime effect/approval checkpoints.
- Implement high/low-watermark planning and durable compaction intents. Optional model narrative is separately metered and checked; commit only against unchanged input/authority/deletion epochs and expected capsule revision.
- Preserve tool-call/result pairing and uncertain-effect state across rollover, stop, process restart, task fork and a deliberately reset engine session. Nothing in a capsule grants permission or completes a task.
- Support original-evidence rehydration and periodic rebase rather than unbounded summary-of-summary drift. Failed/null summaries retain the last valid capsule; no fallback route is selected silently.

Read and challenge the tests: context-controller.test.ts, context-rollover.test.ts, context-protocol-integrity.test.ts. Verify matrix coverage M14, M38, M45, L02, L03, L04, L05, L06, L07, L08, L09, L10, L17, L18. Check the specific counterexample: Force a tiny but declared test context across twenty rollovers; lose a mid-source negation, crash after a tool intent, then revoke a supporting source. Each violated invariant must be caught before implementation.

Inspect identity/scope binding, evidence quality, temporal conflict behavior, cancellation/replay/idempotency, dirty-base protection, forgotten-source resurrection, route/payer restrictions, all-in usage, protocol integrity and partial/unknown user states wherever affected. Mutation-test the important guards in an isolated copy when authorized. A broad test count is not coverage proof.

Do not infer production verification from fixtures or a document status. Do not weaken tests to approve the change. Do not commit/push/deploy. Return ACCEPT, ACCEPT WITH FIXES or REJECT with severity, exact file/line, reproducible counterexample, minimal correction and missing proof. Note whether you actually ran tests. No fabricated independent review if you are the same worker that implemented the change.

## Live delivery record

[DIO-231](https://linear.app/diomedesdevs/issue/DIO-231/nc-mem-lc-w04-h18-continuation-capsules-budgets-and-safe-context) · [Epic](https://linear.app/diomedesdevs/issue/DIO-226/nc-mem-lc-governed-memory-and-reliable-long-context-execution) · [Notion context](https://app.notion.com/p/3f192213bac981e0b69cffeab65df50c?pvs=204).
Read current status and ownership before acting. These were created Backlog, not accepted, on October 6, 2026.
