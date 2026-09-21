# Home client guard closure review R2

Independent executing review of `ec25e4d58017c5cedc01f794c7c2cb4ca8663c05`.
Verdict: three removal schedules now have clean red/restoration/green evidence; the fourth
needs a test failure-path correction before final client acceptance. Product source is unchanged
from `f37f29a`. The reviewer did not author the returned test additions. Preserve this review.

The clean `core-agent-home-driver-review` checkout passed TypeScript, 55 tests in the two client
unit files, build and all 15 Home page cases. The frozen reviewer payload check passed. These
ran under own identity `astra`, PID 43452, start `2026-09-21T04:32:24.4162630Z`, with exclusive
slot `slot_mubct1pj_5c932e02`.

| Repeat | Original unchanged removal | Result | Restored |
|---|---|---|---|
| C23 | C2, resend lock-entry abort check | Expected Stopped refusal becomes UnconfirmedMessage | 49/49 |
| C24 | C4, already-issued identity handed to join | Second caller's identity is null | 49/49 |
| C25 | C13, synchronous delivery-reference release | Two exact-command interrupt requests instead of one | 15/15 |
| C26 | C22, old-delivery cleanup ownership | No interrupt observed; global 60-second timeout and cleanup error | 15/15 |

All source bytes were restored and the final tree was clean. C26 is not claimed as a clean
assertion kill. The retained trace shows the Stop click and no interrupt request after the
project message was dispatched and the old Home provision response was delivered. The fixture
waits on page.waitForResponse until the global test timeout, then finally calls unroute after
the runner has closed the page. The visible error is `Target page, context or browser has been
closed` at line 803. This masks the intended missing-interrupt condition with a fixture error.

HCG-5, test-only: preserve the HCG-3 schedule and its exact command/scope/one-POST/recovery
assertions, but assert the missing matching interrupt request or response directly before the
global timeout. Avoid a floating response waiter that can reject during cleanup. A response
listener plus a bounded assertion can expose the absent response while the page is still open.
Keep finally release/unroute ownership; do not swallow errors or weaken the expected behavior.
Reapply unchanged C22/C26 afterward and require the intended assertion, then 15/15 restoration.

Two small static gaps in the returned additions also remain within the original HCG-1/HCG-4
scope: the late-join test stores only each callback's latest identity, so it does not assert its
commented once-only count, and an early failed assertion skips release of its held mock fetch.
Count both callback invocations and release/drain both mock requests in finally. The lock-entry
test claims both stored records are unchanged but checks the shared claim twice; compare the
actual session reference as well as the shared claim against their saved bytes. Preserve all
older tests and every frozen pasted reviewer block.

Evidence directory: `F:/Diomedes/deliverables/core-agent-continuation-20260921/`.
Records: `home-client-coverage-r1-results.json`, its four logs, C23-C26 patch/red/green/result
files, and the unique C25/C26 artifact directories. Earlier C17-C20 removals also failed as
intended and restored green; C21, the early cancelled-delivery shortcut, survived because the
aborted transport still refuses dispatch under the existing lock. C9 remains the disclosed
equivalent route-option survivor. No production change, live call or full-suite acceptance is
authorized by this review.
