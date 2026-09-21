# Home server independent review R2

Verdict: accept the bounded Home server implementation and its HSR-2/HSR-3 fixture repair at
`f37f29a4068f6b9b6e3b6cce80eb46f685a938ae`. The reviewer did not author this implementation or
its producer fixtures. Expanded client acceptance and final composed gates remain separate.
This report supersedes the open server findings, without editing any earlier review.

## Exact execution

The clean review checkout was `F:/Diomedes/diomedes-wt/core-agent-home-driver-review`, at the
exact candidate. Own identity: role `astra`, PID 43452, start
`2026-09-21T04:32:24.4162630Z`. The focused run held `slot_mubcq27x_214832ee`; the four repeated
mutations held `slot_mubct1pj_5c932e02`. The latter slot continued into separate client review.
The server source set was restored byte-for-byte and the checkout was clean after S20.

Independent TypeScript exited zero. Nine focused files passed 143/143, including the unchanged
AWS review oracle, admission matrix and independent seam oracle. Server-specific additions
passed 13 routing cases and six interrupt cases. The 12 project-conversation cases and existing
Home tests also passed. Source and fixture inspection confirmed the changes described below.

Evidence is in `F:/Diomedes/deliverables/core-agent-continuation-20260921/`:
`home-scope-r3-results.json`, `home-scope-r3-tsc.log`, `home-scope-r3-vitest.log`,
`home-server-original-manifest.json`, and S17 through S20 patch, red/green log and result files.
Each result records the exact commit, own slot, source path, original/restored SHA-256, selected
test file and exit codes. No producer-reported success substitutes for these executions.

| Repeat | Original unchanged removal | Independent result | Restored result |
|---|---|---|---|
| S17 | S6, adoption explicit-choice guard | One intended state-persist assertion failed | 13/13 |
| S18 | S7, adoption unchanged-default guard | One intended redundant-persist assertion failed | 13/13 |
| S19 | S15, command turn-result check | Five intended settled-versus-idle failures, no unhandled rejection | 6/6 |
| S20 | S16, command-recorded driver selection | Five intended wrong-driver failures, no unhandled rejection | 6/6 |

All four replacements match the original R1 review and retained patches. S6/S7 remain
historical survivors in R1; these new executions close their concrete coverage gaps. S15/S16's
original teardown errors remain disclosed; the repeated schedules now fail only at the intended
assertions. No ENOTEMPTY, unhandled rejection or hook timeout occurred in S19/S20.

## Why the repair satisfies the findings

The new adoption cases create an actual Home-folder project and designated thread with no
settings binding. One stamps an explicit Claude choice; the other already carries AWS. Each
calls the real provisioner, verifies the same identity is bound, and separately checks that
project state was not persisted unnecessarily. The settings binding is still saved, so these
tests do not confuse absence of redundant project writes with absence of all writes.

The interrupt fixture now immediately observes each original fetch promise and keeps it in
an in-flight set until settlement. Request callers still receive the original promise and its
rejection. Teardown closes the app and sockets, then drains outstanding requests before removing
fixture data. It does not convert failed requests into successful responses or weaken assertions.

The production implementation remains the independently inspected source from `b387059`:
typed AWS default and conversation-route predicate; lock-scoped migration of unmarked Home and
project pins; preservation of explicit choices and unchanged state; pure reads; explicit PUT
choice stamping; whole-request Home route refusal; strict command-bound interrupt body; missing
command rejection; command-recorded driver selection; and settled only from that command's own
turn result. The request-close abort path is covered during held preparation with no dispatch.
Work routing and existing authorization remain under their existing authority.

R1 retains S1-S16 results, including all initial failures. The separately accepted driver review
retains its own guard and ordering checks, including disclosed inserted-yield survivors. This
server acceptance does not upgrade those survivors to kills, replace client review, or certify
crash-atomic persistence. All provider traffic was scripted or fake. No live Luna call, credential
handling, spend, installed application journey, packaging or deployment is proved here.
