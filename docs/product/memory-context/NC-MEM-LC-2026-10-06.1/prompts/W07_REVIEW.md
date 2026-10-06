# Independent review — W07

Review the candidate for **Implement Agent Memory Repo round trips and scoped plugin access** independently. Read NC-MEM-LC-2026-10-06.1, current AGENTS.md and the actual diff, not just the implementer's report. Confirm prerequisites W03 and inspect server/pack-contributions.ts, server/pack-lifecycle.ts, server/paths.ts, server/harness/tools.ts.

Required behavior:
- Pin and verify upstream spec/skill/license. Implement required entry point, topic notes, wikilinks and optional metadata without copying its runtime assumptions.
- Export authorized current-state projections with stable Nectovia sidecar IDs/revisions/digests. No organization-wide dump or hidden historical Git export by default.
- Treat imports and outside edits as source-attributed candidates with expected-base conflicts. Do not trust imported policy/tenant/verification fields.
- Limit import count/bytes/depth, resolve platform paths safely, and refuse symlink traversal, hook/submodule execution, active URLs and query/script execution.
- Expose least-privilege memory capabilities to the existing plugin system. Installing a pack neither enables source retention nor grants account-wide memory access.

Read and challenge the tests: memory-interop.test.ts, memory-hostile-import.test.ts, memory-plugin-scope.test.ts. Verify matrix coverage M25, M26, M27, L30, L31. Check the specific counterexample: Round-trip a two-scope fixture and edit an export after a concurrent correction. Reject stale mutation and malicious wikilinks/Windows alias escapes.

Inspect identity/scope binding, evidence quality, temporal conflict behavior, cancellation/replay/idempotency, dirty-base protection, forgotten-source resurrection, route/payer restrictions, all-in usage, protocol integrity and partial/unknown user states wherever affected. Mutation-test the important guards in an isolated copy when authorized. A broad test count is not coverage proof.

Do not infer production verification from fixtures or a document status. Do not weaken tests to approve the change. Do not commit/push/deploy. Return ACCEPT, ACCEPT WITH FIXES or REJECT with severity, exact file/line, reproducible counterexample, minimal correction and missing proof. Note whether you actually ran tests. No fabricated independent review if you are the same worker that implemented the change.

## Live delivery record

[DIO-234](https://linear.app/diomedesdevs/issue/DIO-234/nc-mem-lc-w07-agent-memory-repo-interoperability-and-scoped-plugin) · [Epic](https://linear.app/diomedesdevs/issue/DIO-226/nc-mem-lc-governed-memory-and-reliable-long-context-execution) · [Notion context](https://app.notion.com/p/3f192213bac981e0b69cffeab65df50c?pvs=204).
Read current status and ownership before acting. These were created Backlog, not accepted, on October 6, 2026.
