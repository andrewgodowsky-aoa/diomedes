# Independent review — W05

Review the candidate for **Implement exhaustive corpus traversal and source-coverage accounting** independently. Read NC-MEM-LC-2026-10-06.1, current AGENTS.md and the actual diff, not just the implementer's report. Confirm prerequisites W03, W04 and inspect server/harness/tools.ts, server/harness/native-loop.ts, server/task-workflow.ts, server/outcome-evidence/.

Required behavior:
- Implement point/contextual/document/exhaustive retrieval modes with host-validated coverage requirements. Explicit all/every/reconcile cannot silently degrade to top-k.
- Create source snapshot manifests, stable partition IDs, expected counts when known, cursors, visited frontiers and result digests. Unknown source cardinality stays partial until enumerated.
- Preserve row/header/units and clause/exception relationships across chunk boundaries. Keep exact row identity separate from overlapping passage context.
- Implement bounded deterministic reducers and duplicate-safe partition results. Reconcile mid-scan source changes and restart from the saved frontier without duplicate effects.
- Connect coverage checks to existing outcome verification and capsule references; final prose cannot override an incomplete manifest.

Read and challenge the tests: context-coverage.test.ts, context-aggregation.test.ts, context-source-snapshot.test.ts. Verify matrix coverage L19, L20, L21, L22, L23, L24, L25, L26. Check the specific counterexample: A 512-row fixture has crucial records outside the top results and duplicate overlap. The expected exact total must fail a top-k or naive overlapping reducer; resume and source-change variants must also fail unsafely implemented versions.

Inspect identity/scope binding, evidence quality, temporal conflict behavior, cancellation/replay/idempotency, dirty-base protection, forgotten-source resurrection, route/payer restrictions, all-in usage, protocol integrity and partial/unknown user states wherever affected. Mutation-test the important guards in an isolated copy when authorized. A broad test count is not coverage proof.

Do not infer production verification from fixtures or a document status. Do not weaken tests to approve the change. Do not commit/push/deploy. Return ACCEPT, ACCEPT WITH FIXES or REJECT with severity, exact file/line, reproducible counterexample, minimal correction and missing proof. Note whether you actually ran tests. No fabricated independent review if you are the same worker that implemented the change.

## Live delivery record

[DIO-232](https://linear.app/diomedesdevs/issue/DIO-232/nc-mem-lc-w05-exhaustive-corpus-coverage-and-duplicate-safe) · [Epic](https://linear.app/diomedesdevs/issue/DIO-226/nc-mem-lc-governed-memory-and-reliable-long-context-execution) · [Notion context](https://app.notion.com/p/3f192213bac981e0b69cffeab65df50c?pvs=204).
Read current status and ownership before acting. These were created Backlog, not accepted, on October 6, 2026.
