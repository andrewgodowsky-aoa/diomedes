# Independent review — W06

Review the candidate for **Qualify model/engine continuity adapters, caching and complete compaction metering** independently. Read NC-MEM-LC-2026-10-06.1, current AGENTS.md and the actual diff, not just the implementer's report. Confirm prerequisites W04 and inspect server/harness/model-transcripts.ts, server/harness/model-api-adapter.ts, server/harness/aws-model-adapter.ts, server/harness/claude-session-run.ts, server/harness/codex-session-run.ts, server/managed-usage.ts.

Required behavior:
- Define capability support for portable memory delivery, native opaque compaction, token counting, reset, cancellation and actual usage. Unsupported and unverified are distinct.
- Implement provider-specific optional compaction only where the exact route supports it. Preserve full standalone output where required; never send opaque state to another provider.
- Account all compaction/extraction/rerank/embedding iterations without double-counting top-level totals, preserve uncertain charges, and use the existing reserve/settle authority.
- Scope context caches by tenant/visibility/epochs/snapshot/serializer/provider model. Keep stable instructions separate from dynamic evidence. Test cache on/off behavior rather than assuming prompt reuse.
- Deliver permitted portable evidence to supported external engines through actual interfaces; test session retirement and rebuild on access reduction, model switch or incompatible update.

Read and challenge the tests: context-adapter-conformance.test.ts, context-compaction-usage.test.ts, context-cache-invalidation.test.ts. Verify matrix coverage M20, L12, L13, L14, L15, L16. Check the specific counterexample: Use synthetic provider envelopes with top-level usage excluding compaction iterations, null compaction content, opaque items and stale sessions. Reject missing accounting and invalid continuation.

Inspect identity/scope binding, evidence quality, temporal conflict behavior, cancellation/replay/idempotency, dirty-base protection, forgotten-source resurrection, route/payer restrictions, all-in usage, protocol integrity and partial/unknown user states wherever affected. Mutation-test the important guards in an isolated copy when authorized. A broad test count is not coverage proof.

Do not infer production verification from fixtures or a document status. Do not weaken tests to approve the change. Do not commit/push/deploy. Return ACCEPT, ACCEPT WITH FIXES or REJECT with severity, exact file/line, reproducible counterexample, minimal correction and missing proof. Note whether you actually ran tests. No fabricated independent review if you are the same worker that implemented the change.

## Live delivery record

[DIO-233](https://linear.app/diomedesdevs/issue/DIO-233/nc-mem-lc-w06-engine-adapters-context-caching-and-complete-compaction) · [Epic](https://linear.app/diomedesdevs/issue/DIO-226/nc-mem-lc-governed-memory-and-reliable-long-context-execution) · [Notion context](https://app.notion.com/p/3f192213bac981e0b69cffeab65df50c?pvs=204).
Read current status and ownership before acting. These were created Backlog, not accepted, on October 6, 2026.
