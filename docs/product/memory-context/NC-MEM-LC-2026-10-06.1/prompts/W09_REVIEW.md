# Independent review — W09

Review the candidate for **Add temporal relationships and optional hybrid retrieval behind evaluation gates** independently. Read NC-MEM-LC-2026-10-06.1, current AGENTS.md and the actual diff, not just the implementer's report. Confirm prerequisites W03, W05 and inspect server/harness: ModelAdapter/route interfaces, server/evaluation/, server/harness/evaluation-adapter.ts.

Required behavior:
- Implement tenant-scoped entity/edge relations with explicit support/contradiction/supersession/dependency semantics. Access checks apply before traversal and visible graph statistics.
- Add replaceable embedding and reranking providers through existing allowed routes. Store embedding model/version/dimension/index generation and source epochs.
- Implement bounded keyword/vector union, reranking and limited relationship expansion with deterministic tie-breaking, quotas and original-source recovery.
- Provide rebuild/cutover and rollback of indexes without changing canonical records or final-answer model requirements. Exact/text retrieval remains a working fallback.
- Run approved paired ablations; enable hybrid only for qualified task profiles with measured benefit. A negative result disables the accelerator, not basic memory.

Read and challenge the tests: memory-hybrid.test.ts, memory-index-migration.test.ts, memory-graph-isolation.test.ts. Verify matrix coverage M35, L35, L36, L37. Check the specific counterexample: Inject wrong-dimension vectors, revoked graph neighbors, repeated self-support and unavailable embedding service; prove safe behavior without cross-tenant or silent cloud fallback.

Inspect identity/scope binding, evidence quality, temporal conflict behavior, cancellation/replay/idempotency, dirty-base protection, forgotten-source resurrection, route/payer restrictions, all-in usage, protocol integrity and partial/unknown user states wherever affected. Mutation-test the important guards in an isolated copy when authorized. A broad test count is not coverage proof.

Do not infer production verification from fixtures or a document status. Do not weaken tests to approve the change. Do not commit/push/deploy. Return ACCEPT, ACCEPT WITH FIXES or REJECT with severity, exact file/line, reproducible counterexample, minimal correction and missing proof. Note whether you actually ran tests. No fabricated independent review if you are the same worker that implemented the change.

## Live delivery record

[DIO-236](https://linear.app/diomedesdevs/issue/DIO-236/nc-mem-lc-w09-temporal-relationships-and-measured-hybrid-retrieval) · [Epic](https://linear.app/diomedesdevs/issue/DIO-226/nc-mem-lc-governed-memory-and-reliable-long-context-execution) · [Notion context](https://app.notion.com/p/3f192213bac981e0b69cffeab65df50c?pvs=204).
Read current status and ownership before acting. These were created Backlog, not accepted, on October 6, 2026.
