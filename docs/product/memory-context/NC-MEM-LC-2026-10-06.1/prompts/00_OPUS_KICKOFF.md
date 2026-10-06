# Opus kickoff — implement governed memory and reliable long-context execution

Package: **NC-MEM-LC-2026-10-06.1**. Owner: Andrew. Repository: `andrewgodowsky-aoa/diomedes`.

<mission>
Build the approved Nectovia-owned memory architecture with Agent Memory Repo-compatible import/export and the long-context extension in this package. Begin actual implementation, not another general research essay. Andrew selected approach 3 and approved the preceding architecture; preserve that direction. This work extends Nectovia's own harness rather than installing a parallel agent or memory authority.

Start W00 / DIO-227, qualify its baseline and contract tests, then implement W01 once its gate passes. Continue through eligible dependency-ordered slices toward W11 as the execution environment permits. Do not call a first demonstration the complete system. At a genuine blocker, continue independent authorized work and record the precise blocked gate. Do not invent approvals or redo decisions already settled.
</mission>

<entry_points>
Drive package: https://drive.google.com/drive/folders/1EiGGIuCgG6RSv397z8Rq1MQDUDFdLYMv
Notion feature and durable rationale: https://app.notion.com/p/3f192213bac981e0b69cffeab65df50c?pvs=204
Live delivery epic: https://linear.app/diomedesdevs/issue/DIO-226/nc-mem-lc-governed-memory-and-reliable-long-context-execution
Initial work item: https://linear.app/diomedesdevs/issue/DIO-227/nc-mem-lc-w00-reconcile-source-and-freeze-memorycontext-contracts
Source-grounded compaction investigation: https://linear.app/diomedesdevs/issue/DIO-239/investigate-h18-first-sentence-compaction-dropping-later-corrections

Use the ZIP in the Drive folder or the package Andrew supplied. Locate it rather than assuming a specific filesystem path. Verify `SHA256SUMS.txt` and run `python tools/validate_package.py --root . --schemas` in the extracted package. The optional schema check needs jsonschema already available; missing validation dependencies must be reported, never silently installed globally. The generator and validator are package tools, not proof that the product works.
</entry_points>

<read_first>
Read the repository's current AGENTS.md and the three canonical product documents, including their actual versions and any newer explicit owner decisions. Then read package `00_START_HERE.md`, `02_ARCHITECTURE_SPEC.md`, `07_SOURCE_RECONCILIATION.md`, `10_DATA_CONTRACTS.md` and `03_IMPLEMENTATION_PLAN.md`. Consult `01_RESEARCH_FINDINGS.md` for rationale and current vendor caveats. Read `04_ACCEPTANCE_MATRIX.md` and `05_EVALUATION_PROTOCOL.md` before designing tests.

Load only the current work item's IMPLEMENT and REVIEW prompt plus its dependencies, not all 25 prompts into every task. Preserve the first-pass archive. Check live DIO-23/H18, H11/H13/H09, H20, hooks/plugins, active worktrees and ownership claims. The inspected main was cb2e756257de92a6091659200213cdcb79829700; refresh it. DIO-222 tracks existing cloud/repository document divergence; do not overwrite a canonical from a stale mirror.
</read_first>

<architecture_contract>
Keep RunService/Runtime, Trust, Store, Tasks/Runs, ModelAdapter, account/entitlement/funding and capability packs authoritative. Durable memory stores sourced knowledge. A continuation capsule stores task constraints, evidence-backed progress, unresolved questions and runtime references. A coverage plan tracks exhaustive corpus work. These cooperate without becoming a second execution state machine.

Memory is not policy or permission. Tenant, source access, provenance class and verification are host-bound, not model-provided. Original sources remain recoverable. Corrections, forgetting and revocation invalidate derivatives, queued jobs, caches and retained engine contexts. Full-computer permission is not automatic indexing or upload consent. No cross-customer learning or training by default.

The existing prepare step is a pure zero-cost transform. Perform retrieval, extraction, embeddings, reranking, provider compaction and other effects in separately admitted/recorded steps, then compile frozen evidence. Preserve validatePrepared scope, tools, transcript and source restrictions. Its 262144 serialization guard is separate from model-token budgets; do not delete it to fit more text. Registry-compatible tool names use underscores, such as memory_search, not dotted names.

Count instructions, tools, current input, evidence, continuation, protocol and modality overhead, with room for output and the next tool result. Native context size, qualified context size, corpus size and task horizon are different. Preserve complete tool-call/result units and opaque provider state. Model switches rebuild from authorized portable evidence; no silent payer/provider/data-policy changes.

All/every/reconcile tasks require complete eligible manifests, stable partitions and deterministic reducers, or an honest partial result. Top-k search is not exhaustive coverage. Dreaming processes dirty scopes through existing Automations admission, with bounded budgets and reviewed procedural promotion; it cannot authorize actions or declare effects complete.
</architecture_contract>

<execution>
1. Use an owned isolated worktree and synthetic data. Follow current coordination and test-slot rules. Inspect package scripts before running them; do not run unrelated downloaded code.
2. Reconcile every proposed module against current source. Reuse working equivalents. Keep changes focused; do not perform unrelated runtime, database or UI rewrites.
3. For W00, reproduce current selectHistory/compactTurns behavior, preparation invariants and the later-sentence correction case using actual exported product functions. Report source limitations separately from actual model failures. Freeze strict host/model contracts and local/managed integration seams.
4. For each next slice, write the failing behavioral test, observe it fail for the intended reason, implement the minimum complete change, run focused regressions, then run the applicable composed gates. Preserve exact run evidence, including failures and skips. Never replace production paths with a demonstration-only bypass.
5. Obtain actual independent review before declaring each implementation slice accepted. Use a separate reviewer when available. When unavailable, report self-review as self-review and leave independent acceptance open.
6. Update the current Linear item with facts, not optimistic percentages. Keep work-item dependencies and source ownership current. Continue only where dependencies are accepted or Andrew's actual recorded override applies.
</execution>

<acceptance>
There are 96 specified product cases, not 96 passing tests. Bind each case to actual test and evidence. Exercise cross-session recall, scoped corrections/forgetting, 20 forced rollovers over 100 steps, exact exhaustive totals, late source changes, crash/replay, uncertain effects, plugin attacks and revoked access. Preserve no-leakage/no-authority-expansion/no-duplicate-effect gates.

Keep evaluator answers and future-event labels outside ingestion and evaluated agent contexts. Use the generated smoke fixture to build a real test adapter, not to hardcode its answers. Compare seven ablation arms on matched models and budgets. Charge all extraction/retrieval/compaction iterations through existing metering; null compaction or unknown spend must not disappear. Mocked protocol proof, live model quality and installed Windows/macOS qualification are separate results. Do not claim infinite context or superiority before evidence supports the exact claim.
</acceptance>

<boundaries>
This prompt starts local implementation of the package. It is not authority to commit, push, merge, release, deploy, perform live migrations, spend provider credits, index customer data, change real user grants, or alter global GPU/model settings. Apply actual current repository authorization where any such action is needed. No auto-installation of heavyweight graph infrastructure or always-on paid GPU. Keep privacy and resources within the selected account's constraints.

When a safe local implementation detail is unspecified, choose a reversible narrow default and record it. Escalate material authority, pricing, retention/legal or pillar changes; do not hold all unrelated work hostage to a missing live credential.
</boundaries>

<return_report>
Report source baseline and canonical versions, worktree/ownership, slices actually implemented, exact files and contracts, test commands/results/skips, independent review status, real Linear updates and remaining gates. Distinguish authored, implemented, tested, reviewed, integrated, deployed and released. On interruption, leave an evidence-backed continuation handoff referencing current artifacts and unresolved work, not a promise of background completion.
</return_report>
