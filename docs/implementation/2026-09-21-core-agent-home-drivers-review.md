# Home Stop driver review

Date: 2026-09-21. Exact candidate: `fa8466c93385a95922dfce7dd931d7e53125f03b`.
This reviewer did not author either additive method or its test fixture.

The two production methods match the accepted contract. Acceptance of the
complete lane is withheld for the test cleanup defect below. No change to
production interruption behavior is requested.

## Independent execution

The clean, locked `core-agent-home-driver-review` checkout was fast-forwarded
to the candidate. Frozen AWS, admission and seam oracle hashes, the 3,034-byte
R4 payload and the four earlier independent reports were unchanged.

Under own slot `slot_mub9ppnd_6b26b385`, TypeScript exited zero. Five focused
files passed all 75 tests: new driver cases 14, native runtime 19, native
transport 24, AWS seam 7 and the frozen AWS review 11. This is fake-provider
evidence only. It covers neither the new HTTP/client wiring nor a live call.

Under own slot `slot_mub9tmpr_fc84944c`, this reviewer then applied each
mutation separately, ran the named test, restored the original source bytes,
and ran all 14 driver cases green. Both slots were released.

| Mutants | Change, separately on each driver | Observed result |
| --- | --- | --- |
| D1, D2 | Remove project/run validation | Red: foreign Stop resolves `requested` instead of refusing |
| D3, D4 | Remove absent-active guard | Red: idle case throws instead of resolving |
| D5, D6 | Remove command comparison | Red: Stop for A returns `requested` while B owns the turn |
| D7, D8 | Remove await of the signalled turn | Red: acknowledgement arrives while `settled` remains false |
| D9, D10 | Capture active before the awaited lookup | Red: delayed lookup answers `requested` instead of `superseded` |
| D11, D12 | Insert `await Promise.resolve()` between comparison and abort | Survived: all seven cases for the affected driver pass |

D11/D12 are disclosed survivors, not proof that the accepted source contains
an awaited gap. It does not: source inspection confirms one synchronous
read/compare/abort block. The producer's prediction that the delayed-lookup
case kills any inserted await is too broad and must be corrected. A survivor
is not silently converted into passing authority evidence.

The model fixture records an interrupted result and replay dispatches no new
call. The native fixture records no successful turn result after an abrupt
signal abort and replay refuses reconciliation-required state. Neither an
interrupt acknowledgement nor a terminal run is treated as proof of a saved
interrupted answer.

## HDR-R1: drain test-owned drivers before removing their stores

`tests/conversation-interrupt-drivers.test.ts` closes each fixture only at the
end of a successful test body. Its `afterEach` immediately removes temporary
roots. A failing assertion skips that close, leaving driver work racing the
removal. D8 and D10 each reproduced a second `ENOTEMPTY` failure from this
hook in addition to the intended assertion failure. D8's intended failure is
the `settled` assertion at line 407; D10's is the acknowledgement assertion at
line 508. The guard kills above rely on those assertions, not on cleanup.

Frozen reproducer, already executed red on the candidate before repair:

```diff
--- a/server/harness/model-session-run.ts
+++ b/server/harness/model-session-run.ts
@@
     active.controller.abort();
-    await active.promise.catch(() => undefined);
     return { state: 'requested' };
```

With that one temporary mutation, run the candidate test unchanged:

```powershell
node node_modules/vitest/vitest.mjs run tests/conversation-interrupt-drivers.test.ts --maxWorkers=1 -t 'ModelSessionRuns.interruptCommand.*a Stop for the running command'
```

The original source was restored byte for byte and all 14 tests passed again.
Repair only test lifecycle ownership: always close and await every created
driver before deleting its temporary store, including when assertions fail.
Keep the test bodies' behavioral assertions and both production methods.
The independent re-review will rerun the same mutation and require its
intended assertion failure without the cleanup error, then restore and run
green. Do not conceal the error with removal retries or swallowed failures.

Also correct the producer record's claim inventory: `claim_mub87boe_17e907b3`
covered this driver lane's other three paths, not the server/shared lane.
That lane's distinct claim was `claim_mub87b3u_bbb2be33`.

## Evidence and limits

Evidence root: `F:/Diomedes/deliverables/core-agent-continuation-20260921/`.
`home-driver-r1-results.json`, `home-driver-r1-tsc.log` and
`home-driver-r1-vitest.log` bind the focused result to the exact commit.
`home-driver-D1-result.json` through `home-driver-D12-result.json` retain
mutation status, source hashes, restoration hashes and timestamps; matching
`-red.log` and `-green.log` files retain complete output. No mutation remains
in the checkout. No expanded Home or release acceptance is claimed.
