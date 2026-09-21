# CD05-R-13 repair: persistent response gate in the first R12 closure

Scope: `tests/diomedes-home.spec.ts` only, inside the case `CD05-R-12 closure: an old Discard
settling does not stop a delivery somewhere else`. No production code, no other test body, no
helper and no config was changed. Parent verification is pending; nothing here claims acceptance.

## Measured failure

- Original unedited closure on `1f6f93c` (case committed in `5cbd15f`, unchanged at `1cbee5e`):
  13 passed, 3 failed of 16; with `DEBUG=pw:protocol`, 4 passed, 1 failed of 5.
- Every failure passed the `pending=1` assertion, then timed out at the final-answer assertion
  `You said: Running R12c B`. Traces: B's POST completed 200, the follow-up GET of B's `/state`
  started and never completed; no obsolete read of A.
- Diagnostic sibling `tests/diomedes-home-r13-diagnostic.spec.ts` (faithful copy plus R13
  observation, no behavior change in the default arm):
  - default arm, original interception lifecycle: 15 passed, 1 failed of 16 (repeat7);
  - `R13_KEEP_INTERCEPTION=1` arm, a persistent pass-through route keeps interception enabled:
    16 passed, 0 failed of 16.
- In the failed default repetition: Node logged finish of the earlier B/state request (304) at
  11:43:57.897Z and the browser completed that cached response. The gated POST fetched 200, the
  queued Discard released, `pending=1` passed, `route.fulfill` completed at 11:43:58.029Z, and
  the browser issued `GET /api/projects/576356035d2e/state` at 11:43:58.030Z. No Node
  request/finish/close record exists for that GET before the assertion failed about 12s later.
  The failure snapshot shows pending=1, `Warm R12c B`, no notices, empty Web Locks held/pending
  lists and no stored pending claim. Other state calls were healthy.

## Reading

The request was issued by the browser (a browser-request record exists) and produced no Node
request/finish/close record before the assertion failed; whether it ever left the browser on a
socket is not observed. The measured correlation: `{ times: 1 }` removes the route at
fulfillment and, when it is the last route, Playwright disables interception; in the default
arm the stall recurred (1/16), while in the keep-interception arm, where a pass-through route
holds interception enabled, it did not (0/16). The follow-up GET does not match the messages
pattern, so the gated handler never processed it; in the keep arm it matched only the
pass-through. This does not establish the exact teardown mechanism, a dropped socket, an
upstream Playwright defect, or any fault inside the application, and it cannot be assigned to
the earlier unlogged producer failure.

## Exact change

First R12 closure only:

- `type Route` added to the existing Playwright import.
- The `{ times: 1 }` route on `**/api/projects/*/threads/*/messages` becomes a named persistent
  handler `gateFirstPost`. The URL pattern is unchanged, so the intercepted surface is identical.
  Inside the handler the original order is kept byte for byte: non-POST continues; the first
  POST runs `route.fetch()` -> `sent.reached()` -> `await sent.held` -> `route.fulfill({ response })`.
  Non-POST requests continue; every POST is counted, and POSTs after the first continue
  normally.
- `await page.unroute(messages, gateFirstPost)` in `finally`, after `sent.release()`, so
  interception stays enabled until the assertions finish instead of being torn down mid-flight.
- `expect(posts).toBe(1)` added ahead of the existing exactly-one-record `said` check, so a
  retry or stray POST is observed rather than silently continuing.

Preserved: all original requests and the wildcard match surface, the Web Locks ordering, the
`pending=1` assertion before releasing B's response, the final answer/scope/strip/notice and
exactly-one-record assertions, and the unchanged timeout. No retries, no sleeps, no timeout
increase, no broad pass-through route.

## Why this retains the old oracle

The one-shot handler could observe only the first POST and then removed itself; the persistent
handler counts every POST in the window and asserts exactly one arrived, which is intended to
be strictly stronger observation. The gated send is intercepted identically, and the scenario,
lock order, gate order and assertions are unchanged, so the R-12 defect coverage this closure
carries (an obsolete read of A after the queued Discard settles, or a stopped B delivery) is
intended to remain: those failures would still trip the same assertions. Whether the repaired
closure still detects the B17/B18 guard removals is measured by the executing review, not
claimed here. The GET that stalled is not routed by the handler, so this repair cannot mask a
product-side stall: the same assertions and timeout still apply.

## Evidence paths

- Review record: `docs/implementation/2026-09-21-core-agent-client-review-r5.md` (CD05-R-13).
- Original committed red evidence: closure committed in `5cbd15f`, run unchanged on `1f6f93c`
  (3/16 and 1/5 failures above); the separate frozen R-12 reproducer ran red at `0e7602f`.
- Logs and traces: `F:/Diomedes/deliverables/core-agent-continuation-20260921/` holds
  `r5-closure-16-browser.log`, `r5-closure-protocol-browser.log`, `r5-protocol-summary.txt`,
  `r5-closure-repeat1-trace.zip`, `r5-closure-repeat10-trace.zip`, `r5-closure-repeat14-trace.zip`,
  `r13-default-browser.log`, `r13-keep-browser.log`.
- Diagnostic siblings (disposable, not part of the acceptance suite):
  `tests/diomedes-home-r13-diagnostic.spec.ts`, `playwright.r13-diagnostic.config.ts`.

## Limitations and pending verification

- Repair is confined to the test harness. Whether the lost GET failed in the browser, in the
  interception teardown or on the socket is not established.
- The historical producer failure had no retained log; it cannot be assigned this cause.
- The diagnostic spec retains the original one-shot form and remains the unchanged reproducer;
  the repaired closure is the candidate under test.
- Not yet executed on this diff. Parent owns: diff inspection, repeated repaired closure runs,
  the full 33-case page spec, and the B17/B18 guard-removal / red / restoration / green pass
  before any acceptance.
