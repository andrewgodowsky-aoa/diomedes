# Home client independent review R3

Verdict: accept the bounded Home client implementation and closure fixtures at
`21879ed5fd37d93a43eb07c00d449fc97591f75a`. The reviewer did not author the application changes
or the producer fixtures. The two reviewer-authored HLR counterexamples were independently
reviewed before execution; their final test and returned review remain unchanged. Full composed
gates are still required before PR readiness. No earlier review is edited or withdrawn.

## What was accepted

Home and project provisioning use the accepted conversation default. The caption reflects the
actual bound thread, including migration on this send and an explicitly preserved choice. The
Home Route control is offered only for a real bound Home thread, preserves the current route
when unavailable, and is disabled while sending. Its successful and failed responses must own
both the visit and the latest choice. The existing project picker and legacy ask path are kept.

Stop uses the dispatch identity actually issued to this delivery, including same-window joins,
cross-window adoption and real resend. A read-only settled resend issues nothing. Stops during
provisioning or lock wait send nothing. The first Stop releases its active identity synchronously;
late acknowledgements and failures cannot repaint another visit. An old delivery cannot clear a
new delivery's identity. Transport acknowledgement never clears a pending claim or substitutes
for the command's durable outcome. Existing recovery, body equality and visit fences remain.

The first HLR repair introduced a preflight state read that consumed original R05's injected
post-response failure. Immutable R2 recorded that regression before HCR-3. The accepted repair
reads route metadata through the existing thread-list endpoint; post-response state recovery
is unchanged. No timer, fallback route, new lifecycle store or automatic retry was added.

## Independent execution

Review worktree: `F:/Diomedes/diomedes-wt/core-agent-home-driver-review`.
Identity: role `astra`, PID 43452, start `2026-09-21T04:32:24.4162630Z`.
The original checks held `slot_mubct1pj_5c932e02`; final closure held
`slot_mubdyfva_e12055fd`. Both are released. Every mutation restored its original source bytes,
reran green and left a clean tree. Application source is identical from `f37f29a` through this
candidate, verified by Git diff across client, shared and server paths.

| Candidate and gate | Result |
|---|---|
| f37f29a, TypeScript and nine focused files | Exit zero; 143/143, including frozen AWS/admission/seam |
| f37f29a, build and three page files | Build zero; 48/48, including original 33 and both frozen HLR cases |
| ec25e4d, initial coverage additions | TypeScript zero; client unit 55/55; build zero; Home page 15/15 |
| 21879ed, corrected fixture failure path | TypeScript zero; client unit 55/55; build zero; Home page 15/15 |

The original 22 client mutations produced 16 intended failures and six disclosed survivors.
Four survivors represented missing schedules, and their original author added test-only coverage
under committed independent findings. The exact original patch files were reapplied unchanged:

| Original removal | Closure | Observed red result | Restored |
|---|---|---|---|
| C2, resend lock-entry abort check | C23, then C29 | Stopped refusal becomes UnconfirmedMessage | 49/49 |
| C4, already-issued identity to late join | C24, then C28 | Joining callback receives no identity | 49/49 |
| C13, immediate active-reference release | C25 | Two interrupt POSTs for the same command instead of one | 15/15 |
| C22, old-delivery cleanup ownership | C26, then C27 | Final C27 expects one matching interrupt response, receives zero | 15/15 |

C26's original global timeout and after-close unroute error are preserved in guard review R2;
it is not counted as a clean assertion kill. The original author changed only its observation
and cleanup path. C27 failed at the intended bounded assertion with no unroute, unhandled-request
or global-test-timeout error, then restored green. The two unit fixtures now count callbacks,
drain held requests after failed assertions, and compare both pending-storage records by bytes.

C17-C20 separately catch a failed superseded choice painting a notice, a stale migrated route
caption, a control without a bound thread, and an enabled Route control during a pending send.
Each restored green. Earlier C1-C16 results remain in guard review R1 and its raw evidence.

## Explicit survivors and limits

C9 survives because the generic following branch still appends the current AWS option once in
the same order. C21 survives because the aborted transport still refuses dispatch under the
existing lock; the removed shortcut avoids an extra thread-list read but is not the only
dispatch barrier. Neither is counted killed or silently removed from the record. The driver
review's two inserted-yield survivors are separate and remain disclosed there.

The lock-entry abort fixture models the grant-to-callback boundary; it is not a real browser
Web Lock schedule. Browser response schedules use real routing/provider seams, but their two
animation-frame flushes are observation heuristics, not a proof of every scheduling order.
The final C27 removal demonstrates the old-cleanup schedule actually exercises its target.
All provider traffic is scripted or fake. No live Luna, spend, credential handling, packaged
Home journey, installed-runtime proof, streaming preview or populated results ledger is claimed.

## Retained evidence

Directory: `F:/Diomedes/deliverables/core-agent-continuation-20260921/`.
The exact candidate and own slot are in `home-scope-r3-results.json`, `home-client-r3-results.json`,
`home-client-coverage-r1-results.json`, and `home-client-coverage-r2-results.json`, with their logs.
C1-C29 each retain patch, red/green logs and result JSON; browser artifacts have unique paths.
Patch-file SHA-256 equality verifies C2=C29, C4=C28, C13=C25 and C22=C27. Each result binds both
source hashes, exits, commit and clean status. The frozen-oracle verifier confirms original R2
and R4 client payloads, the three authority oracles and earlier acceptance reports unchanged.

The earlier client R5/R6, admission-successor, composed baseline, accepted contract, driver and
server reviews keep their original scope. This acceptance adds the bounded Home client lane;
it does not replace the final exact composed suite, release gates or owner-only live call.
