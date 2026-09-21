# CD-05.R-5: R-12 guard verified, acceptance withheld on closure execution

Candidate: `1f6f93c957393edac954652b18f94a0a39b9f3e7`, reviewed independently of its authors in `F:/Diomedes/diomedes-wt/core-agent-client-review`. The branch was fast-forwarded from `c17cf26` to the repair and was clean. The complete four-file diff `c17cf26..HEAD` was inspected before any implementation change. No permanent production or test change was made in this review.

**Verdict: CD05-R-12 closes at the callback guard boundary. CD-05b acceptance is withheld pending CD05-R-13 below.** This is not a finding that Discard still reloads the wrong project. The required delivery closure repeatedly hangs after its own successful send, and its cause is not established. A passing full-page run does not erase those independent failures. PR #29 remains draft.

## R-12 evidence and ruling

The R-4 reproducer payload in the Git blob is exactly 3,034 bytes, SHA-256 `d08f4a0b70aa34af0c70a6046c51c86b3aaa8a7fe23e65224d9f340776a00abe`. It occurs unchanged once in both `0e7602f:tests/diomedes-home.spec.ts` and `1f6f93c:tests/diomedes-home.spec.ts`. Commit `0e7602f` contains the test paste alone, before production repair `0d197c8`; `5cbd15f` adds three closures, and `1f6f93c` changes documents only.

An isolated checkout at exact `0e7602feb43bd0418b5859cee0ae74d02ccd2547` was built and the frozen case executed. Its valid red result is the expected obsolete GET of A at spec line 1094 after switching to B. Two earlier attempts are retained separately: one worker exited before the test body with code 3221226505, and one failed during warm-up with browser `net::ERR_INSUFFICIENT_RESOURCES`. Neither is counted as the required red result or attributed to R-12.

In the repair, Discard captures `turn.current` before awaiting the lock. Both callbacks check that captured visit before publishing. The underlying command-specific discard still runs after leaving. A scope change or newer delivery changes the visit, including A to B to A. The unchanged reproducer and all three closures passed in the full 33-case run.

Both newly introduced guards were independently removed one at a time:

| Removal | Independent result | Restoration |
| --- | --- | --- |
| B17: remove `owns()` before `load(scope)` | Frozen R-12 case failed at line 1094 with the obsolete A GET | Original source bytes restored, clean Git diff, all four R-12 cases passed |
| B18: remove `owns()` before `setNotice` | Rejected-Discard closure failed at line 1295: one stale notice instead of zero | Original source bytes restored, clean Git diff, all four R-12 cases passed |

Restored working-file SHA-256 after each mutation: `291ad4c48df14b76c8b2d12dbb583f829dd654204fb8d0afdad94750b6bb8435`. The first reverse patch restored content with LF endings; that was not accepted as byte restoration. Restoring the single named file from HEAD reinstated its original CRLF bytes and the hash above. The clean bundle was rebuilt before green browser checks. No mutant survived among these two removals. Older U1-U5 and B14-B16 counts remain producer evidence and are not claimed as independent mutations in this review.

## CD05-R-13: required delivery closure has a reproducible unresolved GET stall

Priority: P2 acceptance-evidence blocker. Location: `tests/diomedes-home.spec.ts:1167`, failing at line 1197. This is not yet classified as a production defect or an assertion defect.

Reproducer: the existing, unedited case named `CD05-R-12 closure: an old Discard settling does not stop a delivery somewhere else`, committed in `5cbd15f`, on exact `1f6f93c`:

```text
playwright test tests/diomedes-home.spec.ts --workers=1 --retries=0 --repeat-each=16 -g "CD05-R-12 closure: an old Discard settling"
```

Independent result: 13 passed, 3 failed, zero retries. All three failures reached and passed the assertion that B still has one pending delivery after A's Discard completes. They then timed out waiting for `You said: Running R12c B`; B still showed `You said: Warm R12c B` and Working/Stop. Each trace records B's message POST completing with 200, followed by a GET of B's state that starts and never completes before the timeout. No obsolete read of A was observed. Intentional failed POSTs in A belong to the lost-response setup.

A second unchanged diagnostic run with `DEBUG=pw:protocol`, five repetitions, produced 4 passed and 1 failed with the same assertion. The protocol log records an unfinished state request around the one-shot interception's `Fetch.fulfillRequest` and `Fetch.disable`. That adjacency is evidence to investigate, not proof of causation. Node's receipt and completion of this GET were not instrumented. The server's state route does not acquire the Store lock, but that alone does not rule out transport or server faults.

These failures now have retained traces, unlike the producer's historical one-in-sixteen failure. Their assertion is known; the historical failure cannot be assigned the same cause without its missing log. CPU contention, physical memory and driver behavior are not established causes. The separate warm-up resource error is not merged into this failure signature.

Closure required: a different author diagnoses the pending GET with a diagnostic-only fixture or equivalent observation, preserving the original scenario and assertions. Establish whether the request reaches Node and whether its response finishes. If a test interception problem is proved, repair only that setup and retain the original failing evidence. If production is responsible, supply an unchanged reproducer, run red before repair and obtain independent review. Re-run the required closure and full page spec on the resulting exact candidate. Do not close this item by retrying until one run passes or by weakening the final-answer assertion.

## Other requested rulings

- **Resend continuation:** no reachable stale-scope `load` was established at this commit. The false return follows the ownership check without an intervening await; scope changes synchronously advance the visit. The other reachable promise-based load is itself visit-fenced and cannot introduce a different scope in that interval. This relies on the current entry points, not a general claim that all React effects run as tasks or that microtasks cannot interleave. A future asynchronous step or new scope writer requires review again.
- **A to B to A stale strip:** accepted within the disclosed client recovery limit. The old Discard must not reload the new visit. Its still-visible strip is healed by an explicit control without a new message dispatch. The closure directly tests Discard; the no-post resend behavior is source-traced through command-bound outcome recovery, not a new independently executed Send-again closure here.
- **Scope-only fence:** not separately mutated because no current-scope reference exists in this implementation. The same-project/new-visit case remains a distinct behavioral check. This limitation is disclosed rather than described as a mutation pass.
- **Failure injection:** replacing one lock request exercises the rejection callback, while subsequent requests use the real browser lock manager. B18 is killed by that exact closure, independently of the intermittently hanging success closure.
- **Earlier limits:** damaged/unreadable pending storage, no streaming preview, empty results ledger, no real provider call and no installed-build conversation proof remain unchanged. R-5 does not accept admission, AWS composition or release readiness.

## Independent execution record

All heavy commands used the pinned coordination tool, role `astra`, PID 43452, process start `2026-09-21T04:32:24.4162630Z`. Grants were checked for `ok: true`; both slots were released. No other test or type-check was run concurrently with a browser run.

| Check | Result |
| --- | --- |
| `tsc --noEmit` | Exit 0 |
| Four focused Vitest files, `--maxWorkers=1` | 4 files, 90 passed, 0 failed |
| `vite build` | Exit 0 before browser runs, including after restoration |
| Full page spec, one serial run, no retries | 33 passed, 0 failed |
| Original frozen R-12 at `0e7602f` | Intended obsolete-read assertion failed; two earlier invalid baseline attempts retained separately |
| B17 removal, then byte restoration | Intended assertion failed, then 4 R-12 cases passed |
| B18 removal, then byte restoration | Intended assertion failed, then 4 R-12 cases passed |
| Unchanged success closure, 16 repetitions | 13 passed, 3 failed |
| Unchanged success closure with protocol diagnostics, 5 repetitions | 4 passed, 1 failed |

Evidence root: `F:/Diomedes/deliverables/core-agent-continuation-20260921/`. Logs: `r5-tsc.log`, `r5-focused.log`, `r5-green-whole-browser.log`, `r12-original-red-third-browser.log`, `r5-B17-browser.log`, `r5-B17-restored-browser.log`, `r5-B18-browser.log`, `r5-B18-restored-browser.log`, `r5-closure-16-browser.log`, and `r5-closure-protocol-browser.log`. The three repeat failures are preserved as `r5-closure-repeat1-trace.zip`, `r5-closure-repeat10-trace.zip`, and `r5-closure-repeat14-trace.zip`. Earlier invalid baseline logs and the resource-error trace are retained too. Source and test bytes are unchanged after verification.

Supplemental delegated analysis used the explicitly selected Devin `swe-2-max` route. It authored no source or tests and did not execute these checks. Its first response made two overbroad scheduling claims; the follow-up retracts them. Only the narrower source reasoning above is relied on. Full outputs and session exports are retained at the evidence root. The first permission-limited attempt produced no review and is not counted as one.

## Program boundary

Repository mirrors read: Core Pillars `2026-09-19.1`, Live Roadmap `2026-09-19.2`, Project Memory `2026-09-19.2`. R-12 advances truthful scoped publication and recovery under P06/P09 without changing pillar meanings. CD-05b is not DONE or accepted for merge while R-13 is open. No application release, package, deployed site or live-provider proof follows from these checks.

Andrew explicitly answered `Include in PR #29` for Home Luna default and Stop during this continuation. That work now belongs to PR #29, after the ordered reviews and with its own contract amendment, implementation and independent review. The live Luna call, spend cap and credentials remain with Andrew and the AWS owner. This review implements none of that new scope.
