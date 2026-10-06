# Independent review — W03

Review the candidate for **Deliver exact/text recall and immutable evidence receipts through the harness** independently. Read NC-MEM-LC-2026-10-06.1, current AGENTS.md and the actual diff, not just the implementer's report. Confirm prerequisites W02 and inspect server/harness/tools.ts, server/harness/run-service.ts, server/harness/instruction-delivery.ts, server/harness/model-session-run.ts.

Required behavior:
- Implement exact IDs and full-text retrieval first, with deterministic ordering, bounded source snippets, quoted exact clauses and explicit misses/conflicts.
- Register memory_search/memory_read and restricted mutation tools using existing H12 schemas/effect classes. Do not put dots in registered names or classify a remote write as pure to evade current effect rules.
- Make ordinary native turns host-recall eligible; models can request more through tools. Keep retrieval/network/extraction in separate recorded admitted steps before deterministic prepare.
- Add a frozen MemoryUseReceipt and versioned H18 sections for memory/capsule/coverage. Preserve source restrictions and opaque transcript identity through validatePrepared.
- Expose source lookup and citation validation. Claims citing nonexistent/not-delivered IDs fail; historical replay retains exact old context bytes but rechecks present authority.

Read and challenge the tests: memory-recall.test.ts, memory-context-receipts.test.ts, memory-tool-contracts.test.ts. Verify matrix coverage M01, M10, M11, M16, M37, M39, M40, L27, L28, L29. Check the specific counterexample: A new session misses a saved scoped preference on baseline; the new path must recall it with source/revision receipt. Also fail fabricated citations and stale-epoch replay.

Inspect identity/scope binding, evidence quality, temporal conflict behavior, cancellation/replay/idempotency, dirty-base protection, forgotten-source resurrection, route/payer restrictions, all-in usage, protocol integrity and partial/unknown user states wherever affected. Mutation-test the important guards in an isolated copy when authorized. A broad test count is not coverage proof.

Do not infer production verification from fixtures or a document status. Do not weaken tests to approve the change. Do not commit/push/deploy. Return ACCEPT, ACCEPT WITH FIXES or REJECT with severity, exact file/line, reproducible counterexample, minimal correction and missing proof. Note whether you actually ran tests. No fabricated independent review if you are the same worker that implemented the change.

## Live delivery record

[DIO-230](https://linear.app/diomedesdevs/issue/DIO-230/nc-mem-lc-w03-native-recall-tools-and-immutable-memory-use-receipts) · [Epic](https://linear.app/diomedesdevs/issue/DIO-226/nc-mem-lc-governed-memory-and-reliable-long-context-execution) · [Notion context](https://app.notion.com/p/3f192213bac981e0b69cffeab65df50c?pvs=204).
Read current status and ownership before acting. These were created Backlog, not accepted, on October 6, 2026.
