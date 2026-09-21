# Home server independent guard review R1

Verdict: product source has no demonstrated failure in this pass; test coverage and teardown
need repair before bounded server acceptance. Candidate `38e5270ef00a72f16d4dc64036f52a49d2b61705`
passed independent TypeScript and nine focused files, 141 tests. The two initial test defects
HCR-1 and HSR-1 are corrected. Their original failing review remains unchanged.

Independent mutations ran in the clean `core-agent-home-driver-review` worktree, role `astra`,
PID 43452, start `2026-09-21T04:32:24.4162630Z`, under slot `slot_mubc3bb0_d4c40200` and claim
`claim_mubc1iow_cd64f8f6`. Each source file was restored byte-for-byte and its selected test file
passed again before the next mutation. The final checkout was clean and the slot was released.

| ID | Mutation | Observed result |
| --- | --- | --- |
| S1 | Change the shared default to Claude | 8 expected default/routing failures; restored 11/11 |
| S2 | Remove model-API support from the shared predicate | 4 predicate/routing failures; restored 11/11 |
| S3 | Remove the explicit-choice guard from bound Home | Marked Claude choice becomes AWS; restored 11/11 |
| S4 | Remove the unchanged-route guard from bound Home | Redundant persist observed; restored 11/11 |
| S5 | Disable bound Home migration | Historical Claude pin stays Claude; restored 11/11 |
| S6 | Remove the explicit-choice guard from Home adoption | Survived 11/11; restored 11/11 |
| S7 | Remove the unchanged-route guard from Home adoption | Survived 11/11; restored 11/11 |
| S8 | Disable Home adoption migration | Historical adopted pin stays Claude; restored 11/11 |
| S9 | Remove the explicit-choice guard from project provisioning | Marked project choice becomes AWS; restored 11/11 |
| S10 | Remove the unchanged-route guard from project provisioning | Redundant persist observed; restored 12/12 |
| S11 | Omit the explicit-choice marker on thread PUT | Marker assertion fails; restored 11/11 |
| S12 | Disable the Home unsupported-route guard | Mixed update returns 200 instead of 409; restored 22/22 |
| S13 | Omit strict interrupt-body rejection | Forbidden object returns 404 instead of 400; restored 6/6 |
| S14 | Omit missing-command rejection | Unknown command returns 500 instead of 404; restored 6/6 |
| S15 | Ignore the command's recorded turn result | Settled commands report idle; 5 failures plus 1 teardown rejection; restored 6/6 |
| S16 | Select the default native driver instead of the command's recorded driver | AWS commands fail native lookup; 5 failures plus 3 teardown rejections; restored 6/6 |

Fourteen mutations failed at intended assertions; S6 and S7 survived and are not counted as
killed. S15/S16 have separately identified expected assertion failures, so their ancillary
errors are not used as the reason for a kill. They do expose the fixture defect below.

## HSR-2: Home adoption coverage misses marked and already-default threads

The existing adoption test seeds an unmarked Claude thread. It proves migration, but neither
preservation of a marked choice when the Home binding is absent nor avoiding a redundant state
write when adopting an already-default thread. Required test-only additions in the routing
fixture must seed these two genuine adoption states, prove the binding was absent, run the real
provisioner, and assert the preserved route/marker plus absence of an unnecessary state persist.
Settings may still be written to establish the binding; do not falsely assert zero settings writes.
Keep all existing cases. The parent will rerun the exact S6/S7 mutations below unchanged, then
restore the original source and require green.

```diff
-      } else if (thread.engineChoice !== 'person' && thread.engine !== CONVERSATION_DEFAULT_ROUTE) {
+      } else if (thread.engine !== CONVERSATION_DEFAULT_ROUTE) {
```

```diff
-      } else if (thread.engineChoice !== 'person' && thread.engine !== CONVERSATION_DEFAULT_ROUTE) {
+      } else if (thread.engineChoice !== 'person') {
```

## HSR-3: assertion failure leaves held HTTP requests unobserved

The interrupt fixture starts held message requests whose results are awaited later in each
test. An earlier assertion failure can bypass that await. Teardown closes the server and those
promises reject as unhandled `TypeError: fetch failed`, caused by `UND_ERR_SOCKET`. S15 observed
one; S16 observed three. All six original assertions and all real request schedules must stay.

Required test-only repair: own every held request through cleanup even when an assertion fails,
drain before deleting its data, and keep the original assertions able to observe request errors.
Do not alter product behavior, turn a rejected request into a success, weaken an assertion, or
hide the intended mutation failure. The exact already-executed S15 and S16 replacements are:

```diff
-    if (turn) return { commandId, runId: located.runId, state: 'settled' };
+    if (false && turn) return { commandId, runId: located.runId, state: 'settled' };
```

Within `InteractionTurns.interrupt`, immediately after the `locate`/404 check:

```diff
-    const driver = this.driver(located.runId);
+    const driver = this.driver();
```

The parent will repeat both failure schedules after repair, require their intended assertion
failures with no unhandled rejection, then restore source bytes and require all six cases green.

## Evidence and scope

All evidence is under `F:/Diomedes/deliverables/core-agent-continuation-20260921/`:
`home-fixture-repair-results.json` and logs; `home-server-original-manifest.json` and original
binary copies; `home-server-S1` through `home-server-S16` `.patch`, `-red.log`, `-green.log` and
`-result.json`; and `run-home-server-mutant.ps1`. Every JSON record binds the exact candidate,
slot, source hashes, selected file and exit codes. These mutations change only this review's
claimed source in the isolated checkout. No provider, credential or live billing work occurred.

The five previously skipped Stop browser cases also passed separately on this candidate under
slot `slot_mubbxomp_b374854b`; their raw results and unique artifacts are `home-stop-initial-*`.
This result does not accept the still-pending client route repair or replace final full gates.
