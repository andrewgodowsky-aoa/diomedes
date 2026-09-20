# Outcome evidence preparation

DEMO-07.PREP, base main 80263205133c410d590549efd1c8f40cedf33b1c.

A pure read-only projection separates human capacity, associated revenue, incremental contribution, expense reduction, credits, operating costs and deferred purchasing. It requires explicit source references, period, revision, evidence class and realization state. It rejects foreign scope, conflicting revisions, causal duplicates, reused realization records, mixed currencies and unsafe arithmetic. Identical replay is ignored once. Missing and negative outcomes remain visible. Synthetic arithmetic can be shown in a row but cannot enter measured/realized totals.

This is a preparatory library, not a new ledger or an operational capability. References must be resolved and authorized by an accepted Core caller before use; a record's asserted evidence class is not independent verification. No HTTP route, UI, persistence, authorization, live provider, customer effect or FD04 export has been wired. Full DEMO-07 and parent prompts remain OPEN.

The input is intentionally single-currency, including excluded examples. Replay means the same ordered source and exclusion lists; reorderings require caller normalization. Duplicate realization references within a record are refused. Unknown placeholders occupy their causal group and must be reconciled before a replacement record is projected alongside them. Expense reductions require a comparison baseline; supplier credits and operating costs instead use their reviewed realization receipt. These conservative input rules prevent ambiguous aggregation.

Initial focused verification: 21 tests and strict isolated types passed. SWE 2.0 independent review found a missing baseline requirement for expense reduction; a new regression failed before its repair. Expanded checks and full gates are recorded in the delivery report. Full coordinated gates and merge remain required before publication. Existing H07 and recorded-effect review limitations are not bypassed by this leaf.

The repaired candidate passed all four coordinated gates on 20 September 2026:
TypeScript, 2,262 unit tests (one skipped), the Vite production build and 35 browser
tests. The focused suite now has 23 cases. Evidence is retained in
personalized-demo-readiness-20260920/gates-outcome-evidence-1. Exact merge and
integration acceptance remain separate from this preparatory library verification.
