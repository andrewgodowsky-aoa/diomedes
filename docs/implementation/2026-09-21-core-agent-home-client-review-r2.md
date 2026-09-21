# Home client independent re-review R2

Candidate: `457419f236ccc7efd1f026e27b874f443c719a1b`.
Verdict: HLR-01, HLR-02 and HCR-2 now pass their existing browser assertions, but the expanded
client gate remains open because the new route read interferes with frozen CD05-R-05.

The clean `core-agent-home-driver-review` checkout ran independent TypeScript (exit 0), build
(exit 0) and all three page files under exclusive slot `slot_mubcf8vu_15b17cae`, identity
`astra` PID 43452/start `2026-09-21T04:32:24.4162630Z`. The slot was released; no source changed
during execution. Browser result: 23 passed, one failed, 24 not run because the older page file
is serial. All 13 new Home cases and both unchanged route counterexamples passed.

## HCR-3: the route refresh consumes the frozen transcript failure before confirmation

The new `deliver` route refresh calls `thread(found)`, which reads the entire project state,
before dispatch. Frozen CD05-R-05 injects a single failed state GET after its warm-up. The trace
on this exact candidate records:

| Event | Start, ms | Duration, ms | HTTP status |
| --- | --- | --- | --- |
| Provision Home | 10709.907 | 4.667 | 200 |
| New route-refresh state GET | 10715.149 | 2.743 | 503 |
| Message POST | 10719.199 | 106.131 | 200 |
| Post-confirmation state GET | 10826.081 | 3.287 | 200 |

The new pre-dispatch read consumes and suppresses the injected failure; the actual transcript
read then succeeds. The test fails at `tests/diomedes-home.spec.ts:337` because its required
`Transcript read failed` notice never appears. This run does not demonstrate duplicate message
admission, but it no longer exercises the frozen confirmed-POST/failed-state-GET split.

The R2 report and all seven of its TypeScript payloads remain unchanged, as do R4 and the other
frozen oracle files. Their payload lengths are 768, 1014, 857, 1373, 981, 1133 and 1528 bytes.
Do not edit or re-stage the original reproducer to accommodate this new request.

Required repair: obtain the new route metadata through the existing thread-list read
`GET /api/projects/:id/threads`, whose current response is `{ threads }`, and select the concrete
bound thread from that record. Keep the post-confirmation state/transcript path unchanged.
This uses the already-existing narrower API for the new route lookup and leaves the original
read-failure schedule meaningful. Preserve marked choices, early Stop and visit ownership;
keep both independent HLR counterexamples unchanged. No new server endpoint or response field
is required. Do not manufacture a delayed error notice just to satisfy the old assertion.

Evidence: `F:/Diomedes/deliverables/core-agent-continuation-20260921/home-client-r2-results.json`,
`home-client-r2-tsc.log`, `home-client-r2-build.log`, `home-client-r2-page.log`, and
`home-client-r2-page-artifacts/diomedes-home-CD05-R-05-a--ff809-not-return-a-confirmed-send/trace.zip`.
The unchanged failing case ran before this repair request. The 24 skipped cases, new client
guard checks, server fixture repairs and full composed gates remain owed. No live provider call
or credential work is part of this verdict.
