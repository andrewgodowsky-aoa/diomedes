# Home browser independent review R1

Verdict: changes required. HLR-01 and HLR-02 are demonstrated client defects.
HCR-2 is a separate browser fixture timing defect.

Exact candidate `edbe2b041ddc3b005c2f6e840f94d915cf2ae2b4` was clean in
`F:/Diomedes/diomedes-wt/core-agent-home-driver-review`. Its product source is unchanged from
`b387059367cca89dfa32268793ac2132b748aeb3`. Build passed. Independent execution used role
`astra`, PID 43452, start `2026-09-21T04:32:24.4162630Z`, and exclusive slot
`slot_mubbpy6x_d79936c3`; the slot was released and the checkout remained clean.

The two counterexamples in `tests/home-route-ownership.review-20260921.spec.ts` were reviewed
by a different reviewer before execution. Their final source SHA-256 is
`6dfd74431928adfd181bbbb2a12130986a9a6f41f856ae2e08a161ca76061847` (LF bytes).
The original fixture review and revision are retained outside Git; the returned revision is
committed unedited in `2026-09-21-core-agent-home-route-oracle-review.md`. Its static-review
limits remain, including the two-frame flush. Neither failure below occurred at a fixture gate.

## HLR-01: an older route response repaints the newer saved choice

Command, after the build:

```text
node node_modules/@playwright/test/cli.js test tests/home-route-ownership.review-20260921.spec.ts --grep HLR-01 --workers=1 --retries=0
```

The unchanged reproducer held the response to a server-committed Claude Code choice, saved a
newer AWS choice, then released the older response. The saved thread remained `aws-bedrock`.
At line 164, the Route control remained `claude-code` throughout the 12-second assertion.
Exit 1, one failed. `pickRoute` fences only on the conversation visit, so both choices own the
same visit and the older response may repaint.

Required repair: ensure a superseded route-choice response or refusal cannot repaint a newer
choice in the same visit, while retaining the existing visit fence and truthful handling of
the saved route. Do not change the reproducer or use a timer to hide the race.

## HLR-02: a migrated pending message shows its previous route

```text
node node_modules/@playwright/test/cli.js test tests/home-route-ownership.review-20260921.spec.ts --grep HLR-02 --workers=1 --retries=0
```

The unchanged reproducer seeded an unmarked historical Claude pin, then sent a held message.
The server thread was `aws-bedrock`, a fake AWS provider call was observed, and the pending
indicator was visible. At line 190, the caption still contained `Claude Code` throughout the
12-second assertion. Exit 1, one failed. The current client reads the route after completion,
so the provisioner's migration is missing from the pending display.

Required repair: refresh the displayed route from the concrete provisioned conversation before
dispatch, retaining explicit choices, visit ownership and early-Stop cancellation. Do not
guess AWS merely because it is the default; the persisted thread remains the authority. Do not
edit the reproducer, cached-binding migration contract or server policy.

## HCR-2: Stop replay fixture inspects cleanup before its response arrives

The unchanged 12-case `tests/home-luna.spec.ts` ran six passed, one failed, five not run.
The Stop arc passed its exact interrupt-path, empty-body, command identity and durable
`interrupted: true` assertions. It then clicked Send again and immediately asserted that the
claim was gone after the unconfirmed strip hid. That strip hides when delivery starts.

The retained trace places the claim read at 8535.955-8538.703 ms. The replay POST started at
8534.218 ms and finished with HTTP 200 after 7.972 ms, at 8542.190 ms. The read therefore
preceded the confirming response. The failure at line 406 is not evidence of a product cleanup
failure. The script did not execute the later five serial cases; they remain owed.

Required fixture correction: register and await the exact command's replay response, verify its
recorded outcome and unchanged provider-call count, and wait for that delivery to finish before
keeping the original claim-cleared assertion. Keep the original Stop and identity assertions.
Do not replace the claim assertion with a timeout or remove it.

## Retained evidence and limits

`F:/Diomedes/deliverables/core-agent-continuation-20260921/` contains the runner
`run-home-initial-browser-review.ps1`, `home-browser-initial-results.json`, build log and
`home-browser-initial-hlr01.log`, `home-browser-initial-hlr02.log`, and
`home-browser-initial-home-page.log`. The Stop trace and screenshot were copied unchanged to
`home-browser-initial-stop-artifacts/`; trace SHA-256 is
`facd5306b51bbb25fbcd866d97cded4ac9b6160f9f5c4e91db36faf8ebe5ae9e`.
The first two runs' screenshots were overwritten by the next Playwright output-directory
initialization; their original textual logs are retained. No claim relies on missing images.

The JSON/typecheck fixture corrections from the initial review are independent of these
findings. This review accepts no product repair. All three red results above preceded the
repair request. Full expanded unit, page and browser gates, guard removals and composed
acceptance remain required. No real provider or credentials were used.
