# W01 hostile verification contract

Owner request: commit after validation, using hostile-verifier. The earlier test
deferral is lifted for this validation. Parent owns execution and fixes. You are
a fresh independent verifier, never an author of this candidate.

Route override: use native OpenAI `gpt-6.1-sol`, high effort, fresh context.
Standing user policy supersedes this skill's stale Muse/GLM default. No outside
provider, further delegation or route fallback is authorized.

## Boundary

Workspace: `F:/Diomedes/diomedes-wt/memory-ledger`.
Use only read, file-list and text-search operations (PowerShell Get-Content,
Get-FileHash, rg, Git read-only diff/show/status equivalents where needed).
No edits, imports, tests, probes, database opens, installs, commits, network,
messages to other chats or changes to coordination. Your final message is the
full report; the parent will preserve it. Do not execute the implementation.

Treat every claimed behavior as false until you derive it from disk. An
unsupported refutation is as bad as an unsupported finding. Read all files you
cite and use exact one-based lines. Earlier author/reviewer conclusions are
claims to verify, not authorities.

## Inputs and steps

1. Read applicable AGENTS.md; package W01_IMPLEMENT.md and W01_REVIEW.md under
   `docs/product/memory-context/NC-MEM-LC-2026-10-06.1/prompts/`; W01 in
   `03_IMPLEMENTATION_PLAN.md`; M03-M06, M08-M09, M28-M30, M41-M42 in
   `04_ACCEPTANCE_MATRIX.md`; relevant definitions in `10_DATA_CONTRACTS.md`.
2. Read the report under review:
   `docs/implementation/2026-10-06-memory-ledger.md`, plus
   `evidence/memory-ledger-w01/{candidate.json,source-review.md,test-plan.md,storage-design.md}`.
   These are historical AUTHORED_UNRUN records at validation start. Do not infer
   missing runtime evidence from source. Parent will give fresh log paths later.
3. Inspect `shared/memory-ledger.ts`, `shared/memory.ts`, every file in
   `server/memory/`, registry delta, and existing `server/store.ts`,
   `server/harness/run-store.ts`, `server/lock.ts` for authority integration.
   Read `tests/memory-ledger.test.ts`, `tests/memory-store-recovery.test.ts`,
   `tests/memory-contracts.test.ts` and `tests/fixtures/memory-ledger/`.
4. Re-derive separately each claim below, citing implementation and assertion:
   C1 strict source-backed shapes, lifecycle/epistemic separation;
   C2 tenant/workspace/scope on every primary/reference path and alias ambiguity;
   C3 stale expected revision refusal and immutable source metadata;
   C4 valid-time replacement/succession, recorded-time history and unknown bounds;
   C5 exact command replay and changed-command refusal;
   C6 atomic entry/event/receipt, rollback and hard-process recovery coverage;
   C7 explicit conflict precedence without new inference/effect authority;
   C8 suppression generations and restore floors outside backup rollback;
   C9 resource bounds and actual schema validation/migration/readability;
   C10 deterministic snapshots/outbox acknowledgements and callback lifetime;
   C11 separate existing run/store authority and no model/network under a lock;
   C12 85 authored cases at the initial snapshot, no claimed executed acceptance.
   For every claim classify CONFIRMED, PARTIAL, REFUTED, FABRICATED or UNVERIFIABLE.
   CONFIRMED source behavior is not runtime qualification. Explain the boundary.
5. Check the original task compliance: W00 prerequisite locally reviewed but
   unmerged; W02/W04 not implemented; no paid routes/active profile/purge; no
   unrelated edits. HEAD is 063035e with an uncommitted merge of main 26714bd.
   Newer main is repository context, not a W01 author change. Inspect actual diff.
6. Bounded missed-findings spot-check: up to five concrete counterexamples,
   severity and confidence, exact lines, reproducible input sequence, expected
   vs actual derived behavior and minimal correction. Include low-confidence
   discrepancies explicitly; do not invent runtime outcomes. Do not re-audit
   unrelated application modules.
7. Known-answer checks (re-derive, do not trust): opening is explicit and lazy;
   normal imports must not open a profile; the crash child calls process.exit(86)
   rather than merely throwing; schema comparison uses actual SQLite objects,
   not only the digest row. Grade each explicitly.
8. Scorecard: all 12 claim classifications plus counts, and precision =
   CONFIRMED / (total - UNVERIFIABLE), stating a zero denominator if necessary.
   Return ACCEPT, ACCEPT WITH FIXES or REJECT for the reviewed claim boundary,
   with runtime acceptance separately pending if evidence has not been supplied.
   Name exact hashes of the five implementation files and two suites reviewed.
   State whether any tests were run (you must not run them).

The parent independently verified the explicit factory, schema comparison and
crash exit anchors before dispatch, but you must independently re-read them.
No conclusion may rely on the prior worker's source-review verdict.
