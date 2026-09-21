# Home Stop driver re-review

Date: 2026-09-21. Exact repaired candidate:
`e2411ca21f778a71e3b7adbab46611199e8ed8d5`.

Accepted for the bounded driver lane. This reviewer did not author the
production methods or the test lifecycle repair. The first review at
`45eafc6cda4cb49ba2c35c94fb6e63d5c7b70884` remains unedited.

The repair changes only fixture lifecycle ownership and its producer record.
Every fixture registers its root and driver; teardown awaits that driver
before removing the root, including after assertion failure. The behavioral
assertions, controlled schedules and two production methods are unchanged.
The producer record now uses the correct claim inventory and discloses the
two inserted-yield survivors instead of claiming they were killed.

At the clean exact candidate, own slot `slot_muba892d_011bb290` covered a
fresh TypeScript pass and five focused files: all 75 tests passed, including
all 14 driver cases. Frozen prior oracles and review bytes were unchanged.

Own slot `slot_mubaav2y_dab62b5a` then covered the original D8 and D10
mutations and unchanged behavioral tests. New evidence names D13 and D14
preserve the original red logs. Removing the model driver's await failed
only at the expected `settled` assertion; capturing its active entry before
the lookup failed only at the expected `superseded` assertion. Neither run
reported ENOTEMPTY, an unhandled rejection or a hook timeout. After each
case the original model-driver bytes were restored with SHA-256
`e3da835ccc8bb0e41ffc972f23910a7efe774ac0590789f9b93ec34eb644a1de`,
and all 14 driver cases passed. Both slots were released and the source
checkout is clean.

HDR-R1 is closed. The first review's ten killed guard/order mutants and
two disclosed inserted-yield survivors remain the precise coverage claim.
No broader mutation adequacy is implied. The actual implementation still
has no await between active lookup, command comparison and abort.

Evidence is under
`F:/Diomedes/deliverables/core-agent-continuation-20260921/`:
`home-driver-r2-results.json`, its TypeScript and Vitest logs, and
`home-driver-D13-result.json` / `home-driver-D14-result.json` with their
red and restored-green logs. This accepts only the additive driver methods
and their repaired tests. The Home HTTP/client composition, final full
gates, PR merge, live-provider journey and release remain separate.
