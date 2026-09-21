# Core Diomedes Agent: work orders, lanes and worktrees

Version 2026-09-20.1. Ledger for the CD-1 program. Decision record:
`docs/product/2026-09-20-core-diomedes-agent.md`.

**Status: planning and dispatch ledger. It records assignments and evidence, never completion by
assertion.** A work order is DONE only when its work is complete, its required tests and
independent review passed, and the exact accepted patch is merged to `main`
(`F:/Diomedes/AGENTS.md`).

The package's thirteen work orders (CD-00 to CD-12) are kept with their IDs. What changes here is
their **order**, because the package was written without reading the current source, and the
source moved the critical path.

---

## 1. Routes verified on this machine, 2026-09-20

| Label in the package | Route used | Verified |
|---|---|---|
| Fable | This session (integrator seat). Never as a subagent | yes |
| Opus | Claude Code Agent tool, `model: opus`, one worktree per agent | yes |
| Sonnet | Agent tool, `model: sonnet`, read-only exploration and mechanical edits | yes |
| Astra | `ask-codex.ps1 -Model gpt-6-astra` under `pwsh` 7, never 5.1 | helper present, `codex.exe` on PATH |
| SWE 2.0 | Devin ACP | **no.** Only Devin Desktop is installed. There is no `devin.exe` CLI for `server/engines/devin.ts` to resolve, and ACP sign-in is a browser flow. Not fabricated |
| Muse (takes the SWE 2.0 lanes) | `ask-opencode.ps1 -Model opencode-go/muse-spark-1.3-contributor`, GLM-5.3-Flash as fallback | helper present |

Muse rules learned the hard way: one file per brief, pass `-Model` explicitly, and check that the
deliverable file exists rather than trusting exit 0.

---

## 2. Worktrees

All branch from `origin/main` (`dadb72d` on 2026-09-20), not from local `main`, which lags. The
main checkout `F:/Diomedes/diomedes` sits on a docs branch 226 commits behind and must never be
used as a source of truth for code.

| Feature | Work order | Branch | Path | Owner | State |
|---|---|---|---|---|---|
| core-agent-bot | CD-00, integration | `feature/core-agent-bot` | `F:/Diomedes/diomedes-wt/core-agent-bot` | Fable | open; the integration branch the lanes merge into |
| core-agent-contract | CD-01, then the seam code | `feature/core-agent-contract` | `F:/Diomedes/diomedes-wt/core-agent-contract` | Opus rounds 1 to 3; Fable seat since round 4; Astra reviews | rejected four times; round 5 is code, committed from `127c13c` on |
| core-agent-page | CD-05a | `feature/core-agent-page` | `F:/Diomedes/diomedes-wt/core-agent-page` | Sonnet 5 builds under the Fable seat's claim; Astra reviews | dispatched 2026-09-21, four new files |
| core-agent-mode | CD-02h.MODE (O1 to O3) | `feature/core-agent-mode` | `F:/Diomedes/diomedes-wt/core-agent-mode` | Sonnet 5 builds under the Fable seat's claim | dispatched 2026-09-21, branched from the contract branch at `c05f4ea` |
| core-agent-admission | CD-02 | none | not created | Muse | not needed: the one Muse file was written straight into core-agent-contract, which was a clean worktree with no overlapping edit |

The page went to Sonnet rather than Muse: a long Muse brief ends early with no files, and this
lane needs design fidelity. Muse keeps the bounded single-file lanes. The coordination tool knows
three seats only (`fable`, `astra`, `opus`), so a Sonnet or Muse worker builds under the seat that
dispatched it, and the journal names the builder.

Each worktree needs two junctions for `tsc`: `node_modules` and
`services/control-plane/node_modules`, both to the shared install. **Detach both before removing a
worktree.** `git worktree remove --force` follows a junction and empties the shared install.
Script: session scratchpad `new-lane-worktree.ps1 -Feature <name>`.

Claims go through the pinned tool only:
`F:/Diomedes/diomedes/.git/diomedes-coordination/unified-20260913/tool/coordination.ts`.
Live: `claim_muaow7wh_00888721` (fable, CD-00, the two CD-00 documents);
`claim_muap4jbp_16cc3b46` (opus, CD-01, four files); `claim_muaptqnf_bffca3eb` and
`claim_muaqncga_75ffb6cb` (astra, the two reviews and her test file);
`claim_muar92eo_56568471` (fable, CD-05a, the four page files).

---

## 3. Order of work

### Wave 0: decide and freeze (running)

| ID | Lead | Reviewer | Output | State |
|---|---|---|---|---|
| CD-00 | Fable | Opus checks feasibility through CD-01 | Decision record, this ledger, the design artifact | drafted, awaiting Andrew |
| CD-01 | Opus | Astra | `docs/implementation/2026-09-20-core-agent-contract.md`, `...-source-map.md`, `shared/interaction.ts`, `tests/interaction-contract.test.ts` | returned, **not accepted**; in review |

**CD-01 as returned, 2026-09-20.** Four untracked files in `core-agent-contract`, base `dadb72d`,
nothing committed, no tracked file touched. The integrator re-ran both permitted commands:
`tsc --noEmit` exit 0; `vitest run tests/interaction-contract.test.ts` 40 passed of 40. Opus's claim
is `claim_muap4jbp_16cc3b46`. It marks 10 of 22 cases UNCLAIMED with a named prerequisite each.

**Open finding from the integrator's read, F-1 (candidate P1).** Decision 3 gives the project-less
landing "an unbound composer that can only produce `respond`, `clarify` and `blocked`" needing
"no project, no run and no durable record". But the same contract stores the decision as a step on
the conversation run, and every conversation run is per project. With no project there is no run,
so nothing can generate or record even a greeting. Since the landing is the conversation by owner
decision, this cannot stay UNCLAIMED. One alternative is on the table: a reserved workspace home
project, an ordinary Project that holds the home thread so the native session works unchanged.

**CD-01.R, Astra, dispatched 2026-09-20** with F-1 and six other risk claims, under
`claim_muaptqnf_bffca3eb`. It may write exactly
`docs/implementation/2026-09-20-core-agent-contract-review.md` and
`tests/interaction-contract.astra.test.ts`. The hop bills the ChatGPT subscription.

**CD-01.R verdict, 2026-09-21: REJECTED.** Verdict file as above, in `core-agent-contract`. Astra
stayed inside its two files; the four candidate files were untouched.

| ID | Sev | Finding | Integrator check |
|---|---|---|---|
| R-01 | P1 | The landing cannot generate or record its answer (F-1) | confirmed by reading |
| R-02 | P1 | Decision 4 moves `admitWork` outside the Store lock that admission relies on. Its deadlock rationale cites `prepare`, which `start()` does not await | **confirmed**: `native-work.ts:540-552`, `store.ts:588`, `app.ts:895-899`, `:1957-1959` |
| R-03 | P1 | No recovery contract from a recorded decision to its admission; a run query already exists | **confirmed**: `server/harness/routes.ts:46-61` |
| R-04 | P1 | C24 claimed on a hardcoded local principal | **confirmed**: `server/harness/bridge.ts:24-31` |
| R-05 | P2 | Automatic's transitions and the trusted restriction input are not frozen | read |
| R-06 | P2 | The parser is not equivalent to the package fixture | **observed**: see below |
| R-07 | P2 | `sourceCommandId` is hashed but never stored | read |
| R-08 | P2 | Lane map omits `EngineService.claudeSession` threading and several landing pins | read |
| R-09 | P2 | Three prerequisite claims contradict source; the contract-revision status is a conflict in the records | **confirmed**: `evidence/unified-20260913/C00.R-rollout-20260917.json:14-22` records an accepted rollout with `approved_contract_revision 2026-09-13.1`, while `shared/contract-revision.ts:37-41` still says `proposed` |

Astra's own vitest could not start (`EPERM` on the junctioned `node_modules` inside its sandbox),
and it said so rather than claiming failures. The integrator ran the exact command:
`vitest run tests/interaction-contract.test.ts tests/interaction-contract.astra.test.ts` gave
**42 passed, 9 failed of 51**. All 40 of the candidate's tests pass; 9 of Astra's 11
counterexamples fail against the candidate schema. R-06 is observed, not only argued.

**The reserved home Project.** Astra holds it acceptable under six conditions: provisioned
deterministically and findable on retry; never a work destination; never a last-used-project
alias; target work admitted through the existing locked admission and linked back; single-owner
local scope only; and no other project's documents, names, counts or notifications in the home
prompt before a proved context adapter exists. It is the **proposed default, pending Andrew**.

**CD-01 round 2, Opus, dispatched 2026-09-21.** One scoped correction round on the same four
files under the same claim. Both test files must pass, Astra's unedited. A second review follows.

**CD-01 round 2 returned, 2026-09-21. Not yet accepted.** Opus reports all nine findings closed
and disputes none; it retracts its own round-1 deadlock reasoning with the source that refutes it.
Patch identity (`git hash-object`, base and HEAD still `dadb72d`, nothing committed):

| File | Blob | Lines |
|---|---|---|
| `docs/implementation/2026-09-20-core-agent-contract.md` | `72a2602b` | 858 |
| `docs/implementation/2026-09-20-core-agent-source-map.md` | `76ec4277` | 176 |
| `shared/interaction.ts` | `d40541b0` | 333 |
| `tests/interaction-contract.test.ts` | `8e874208` | 253 |

The integrator's own run on that candidate: `tsc --noEmit` exit 0; both contract test files,
56 passed of 56 (round 1 was 42 passed, 9 failed of 51). Astra's test file and round-1 review are
byte-identical to the blobs recorded before the repair (`0590ac87`, `80fa323f`), so her eleven
counterexamples pass against a file the author did not touch.

Opus chose differently from Astra's literal suggestion in two places, both to stay out of hot files:

1. **Finding the run again (R-03).** Rather than storing a run id on the `Conversation` record
   (`shared/types.ts`), the run id becomes a pure function of `(project, thread, mode)` through a
   small patch to the non-hot `server/engines/claude-session-routes.ts:88-91`. Fork keeps
   command-id derivation so it cannot collide with its source. The integrator checked this against
   source: the route body already carries `mode: 'ask' | 'plan'`, and the succeeded-turn replay at
   `claude-session-run.ts:348` runs before the `SESSION_EXISTS` guard at `:400`, so a retried first
   message replays and a wrongly posted second start is refused.
2. **The durable link (R-07).** The link from a conversation turn to the work it admitted lives in
   the admission envelope step, not an extended work receipt. The receipt route is written out and
   declined because it needs the hot `server/store.ts` writer and the strict validator in one patch.

**Carried risk.** `EngineService.claudeSession` (`server/engines/service.ts:1595-1659`) sits under
the external claim `devin-acp-adapter-20260913.json`, still marked discovered. If that handoff is
refused, the decision hook has no transport. The contract names this as a blocker to return, not
to route around.

**The carried risk, checked 2026-09-21: the claim is a fossil, and still needs a ruling.** The
external claim was recorded 2026-09-15 against worktree `diomedes-wt/devin-acp-20260913` at base
`212106e`. That directory no longer exists and no worktree is registered for it (the 2026-09-20
sweep). Its base is an ancestor of `origin/main`. The work it describes is on main: `2237787`
"Add Devin as an external engine over its ACP stdio transport", then `e20d7ca`, `37b591f`,
`5915238`, `7cf1197`. `server/engines/service.ts` has been changed by five landed commits since.
So nothing live can collide with a thread-through edit. The record itself still reads
"discovered, not integrated" and says it is held for Andrew, and age is not a release.
**Ruled by Andrew, 2026-09-21: superseded by `2237787`.** The `service.ts` thread-through stays an
integrator patch (CD-02h), which it would be anyway as an H01.I anchor.

**Integrator finding F-2, held until Astra's verdict so her review stays independent.** The
admission envelope is a `RunService` step. A step's intent is hashed and a succeeded step only
ever returns its cached output (`server/harness/run-service.ts:381-392`, `:606`), so it cannot be
amended. The envelope nevertheless lists `receipts` as filled "once they exist", and the crash
table says to "record the receipt reference" with no place or transport named: the run is
owner-exclusive, and the only hook the contract adds (`decide`) runs before admission. Smallest
closure: `receipts` is a lookup, not a stored field. Both command ids are derived from the source
message, so given the envelope's `resolvedTarget`, `taskCommandId` and `workCommandId`, the
authoritative receipts are found in the target project's existing receipts, and which crash
boundary was crossed is read from their presence. Nothing is rewritten and no second hook is
needed. Severity P2: it does not change what CD-02 admits, only what it must not try to write.

**CD-01.R-2, Astra, dispatched 2026-09-21** under `claim_muaqncga_75ffb6cb`, scoped to one new
file, `docs/implementation/2026-09-20-core-agent-contract-review-r2.md`. It must give each of the
nine findings a verdict of closed, narrowed or open, look for regressions the repair introduced,
and judge the contract under the reserved home Project default without rejecting it merely
because Andrew has not yet confirmed that default.

**CD-01.R-2 verdict, 2026-09-21: REJECTED.** Verdict file
`docs/implementation/2026-09-20-core-agent-contract-review-r2.md` (blob `de82681a`) in
`core-agent-contract`. Scope verified: Astra wrote that one file; the candidate and her two
round-1 files are byte-identical to the recorded blobs. Six findings closed and stay closed:
R-02, R-04, R-06, R-07, R-08, R-09.

| Finding | State | What remains |
|---|---|---|
| R-01 | narrowed, P1 | Returning people still launch into the last project (`client/App.tsx:197-203`). The contract preserved that; the owner's decision does not |
| R-03 | narrowed, P1 | The envelope cannot hold a `workPayload` with a task id the Store has not allocated (`server/store.ts:1504-1506`); a retry under a new transport id misses the turn cache (`server/app.ts:2358`); the `decide` hook has no placement and the cached-result early return (`claude-session-run.ts:349-358`) bypasses reconciliation |
| R-05 | narrowed, P2 | The Automatic prompt and output wrapper is unfrozen; `prepare_artifact` covers both a plan and an artifact job, and `admitWork` forwards no mode |
| R-10 | new, P2 | One permanent run id per thread and mode cannot continue past a model change, a terminal run or the 128-call budget (`claude-session-run.ts:294`, `:320-324`) |
| R-11 | new, P2 | `server/app.ts:2366-2375` still derives the progress run id from the transport command, so progress names a different run |
| R-12 | new, P2 | Source identity has three different length and trim policies across ingress, decision and work link |
| R-13 | new, P2 | The Settings binding and home provisioning have no owner and need hot-file patches the contract said were not required (`server/app.ts:214-218`) |

The integrator checked R-01, R-03(1), R-10, R-11 and R-13 against source: all hold. F-2 above is
the same defect as R-03(1) seen from the other side, reached independently, so the two are merged.

**What the two rounds teach.** Three of the four new findings come from designing around hot
files. The lineage derivation avoided a `shared/types.ts` patch and produced R-10 and R-11; the
"no patch required" line is what R-13 refutes. Hot-file patches were always allowed as returned
patches. The round-3 brief says so in those words.

**CD-01 round 3, Opus, dispatched 2026-09-21, and it is the last Opus round on this order.**
Same four files, same claim. It carries Andrew's confirmed decisions (section 1 of the decision
record, items 7 to 11), so no "pending the owner" marker survives. Convergence guard: round 1
found nine, round 2 closed six and added four. If round 3 introduces a new P1 or P2, the order is
split: the hot-file seams (the R-13 Settings shape and provisioning, the R-11 progress patch)
become the integrator's directly, and the pure design decisions stay with Opus. A third Astra
review follows either way.

**CD-01.R-3 verdict, 2026-09-21: REJECTED, and no further authoring round requested.** Verdict
file `docs/implementation/2026-09-20-core-agent-contract-review-r3.md` (blob `63ee039e`). Round 3's
candidate: contract `2e3d9c47`, source map `9bf9178b`, `shared/interaction.ts` `fabd162a`, its test
`bb071351`; the integrator's run was `tsc` 0 and 59 of 59. Closed this round: R-01, R-11, R-12, and
F-2 through five append-only phases. F-3 (adding `auto` to `Mode` breaks six exhaustive maps and
more) was ruled a bounded integration obligation, F3-O1 to F3-O3, not a reason to reject.

| Finding | State | What remains |
|---|---|---|
| R-03 | narrowed, P1 | The source identity is minted before generation and persisted after it; a retry after a lost response has no replay handle; refusals at phases 2 and 4 are unspecified |
| R-05 | narrowed, P2 | `AUTO_INSTRUCTIONS` still begins with Ask's ban on proposals and carries neither the schema nor the issued identity; the effective restriction was dropped |
| R-10 | narrowed, P2 | Replay through a retired lineage has no lookup rule; the generation fallback can reuse an id |
| R-13 | narrowed, P2 | The home thread has no identity to adopt after a crash; the binding is trusted, not validated |
| R-14 | new, P2 | `decide(context: StepContext)` cannot append a sibling step (`run-service.ts:77-96`), and its placement cycles with the fresh-lock admission order |

**The pattern across three rounds.** Nine found; then six closed and four added; then three more
closed and one added. It converges, slowly, and every finding left is an executable seam rather
than a design idea. Astra's own closure for R-14 asks for a fake-provider integration test. Prose
has done what prose can.

**CD-01.I, the integrator's round, 2026-09-21.** The convergence guard applied. The Opus claim was
released and the Fable seat took the four files under `claim_muas2eww_17035194`. One section was
added to the contract, "Round 4: integrator rulings", with nine markers at the passages it
supersedes. Only the contract changed (`fe20971e`); the other three candidate files and all four
reviewer files are byte-identical.

- **I-1.** The client retries with the same persisted `commandId`, which `client/work-start.ts`
  already does for Work starts. The source identity is computed,
  `'sm.' + digest({ projectId, threadId, commandId }).slice(0, 32)`, so it exists before
  generation and is recomputable from the turn input the run already persists. One change closes
  both R-03 reproducers and gives R-10 the lookup key it lacked.
- **I-2.** Replay is resolved first, as a read through every lineage including retired ones, never
  a `step` call on a terminal run. The generation rule counts retired entries.
- **I-3.** The driver owns the phases. `ClaudeSessionRuns` holds the private run owner, so it gains
  `record` and `phases`, and nothing calls back into the app. Phase 1 is written in one tail both
  paths reach. The route runs five steps with fresh locks and no cycle. Refusals are their own
  phases, and a missing receipt phase is checked against the receipts before it is believed.
- **I-4.** `auto` has its own instructions carrying the schema; the issued identity travels in a
  prompt trailer; the effective restriction is restored. One interpretation is put to Astra:
  "explicit" means the Mode control, because the package forbids a keyword rule.
- **I-5.** The home thread is the oldest conversation in the home Project. Provisioning adopts
  before it creates and writes the binding last; the binding is validated; the server is its only
  writer.
- **I-6, I-7.** F-3's obligations plus three runtime sites the compiler will not find; the stale
  carried risk withdrawn; the `ui.spec.ts` launch pins corrected.

**CD-01.R-4 dispatched to Astra** under `claim_muas8h5p_db864a81`, followed in the same run by
**CD-05.R-1** under `claim_muas8hry_a0a4905d`: the first independent review of `cdfc845`
(Everything on hover, Automations as a reserved pin) and `c53e116` (the Diomedes page). If R-4
rejects again, the next submission is code, not a document: the driver seam and its fake-provider
integration test.

#### CD-01.R-4: rejected a fourth time (2026-09-21, report blob `206a652b`)

| Finding | Round 4 |
|---|---|
| R-10 | **closed** |
| R-03 P1 | narrowed: the read-only replay I-2 added skips the body check I-1 relied on |
| R-14 P2 | narrowed: a terminal replay cannot do the phase writes I-3 requires |
| R-05 P2 | narrowed, and **I-4 item 4 overturned**: an explicit limit is not only the Mode control |
| R-13 P3 | narrowed to a mechanical validator, now obligation O4 |

No new findings. Astra asked for the driver and route patches and a fake-provider test, and
said so plainly: no fifth prose round. That was right. Three rounds of my and Opus's prose each
left one executable seam open that only code could show.

#### CD-05.R-1: both client candidates accepted with named fixes (report blob `395cf6c6`)

`cdfc845` and `c53e116` were each accepted with named fixes, no P1. All four fixes are in:
CD05-R-01 as `d157214` (focus entering a hover-opened panel owns it; verified in the running app
in four scenarios, with the note that a background pane fires no native focus events);
CD05-R-02, -03 and -04 as `9973109` (neutral home row, the ledger stacked under both shared
hiding rules, a home id outside the project id alphabet). 5 of 5 and 28 of 28; `tsc` 0 in both.

#### Round 5: the candidate is code (in progress, under `CD-01.C`)

Built in `core-agent-contract`, committed as it goes. Workers: the pure admission module went to
**Muse** on a refrozen single-file brief and came back matching it; the `auto` Mode migration is
with **Sonnet** in its own worktree; the seam itself is the integrator's, as Astra assigned it.

| Commit | What |
|---|---|
| `c05f4ea` | Driver: bound replay, phases as `transform` steps, a settled run read and never touched. 10 tests; the 23 existing driver and route tests unchanged |
| `0d329c7` | `server/interaction-admission.ts` (Muse) and its 12 exhaustive tests, the adversarial C06 proposal among them |
| `d748b66` | `server/interaction-turn.ts`: identities, the splitter, the preview gate, the outcome reader. 17 tests |
| `f2cfaa9` | `server/interaction-service.ts`: the message sequence behind a narrow host port |
| pending | `server/engines/interaction-routes.ts`, the host port in `server/app.ts`, lineages, and `tests/interaction-seam.test.ts` through the real app. Waits on the Mode lane to compile |

Three decisions the integrator took, each recorded in the contract's Round 5 section:

1. **Under Automatic, proposed work is shown and one selection starts it**, bound to the
   message, the proposal digest and the target. This is Astra's deterministic exit from R-05
   and it leaves the C06 guarantee whole. Andrew can widen it later by decision.
2. **`server/engines/service.ts` is not touched.** It is held by the live cloud-handoff session
   (`claim_muaredn5_544e3a55`). The identity rides on the request instead, which is also simpler.
3. **Not in this candidate:** the plan-lineage hop, a portable handoff across lineages, the
   reserved home Project (O4). Each is named as unclaimed rather than half built.

#### Rounds 5 to 7: what review found once the candidate was code (2026-09-21)

The "pending" row above landed as `6bd7906` (routes, host port, the seam test through the real
app) and `265a33c` (the Mode lane merged). Decision 3 above is superseded in one respect: the
reserved home Project was built in its own lane and merged in round 6.

| Round | Candidate | Astra's verdict | What it turned on |
|---|---|---|---|
| R-5 | `ef5e366` | rejected, five P2 defects, each with a reproducer | a retry ignored the Mode control as it stands; cancellation between a recorded input and its admission; a missing decision read as answered; a repaired projection rebuilt from the present; budget exhaustion never replaced the lineage. Accepted: body binding, the terminal-write guard, the selection mechanism (ruled to need no owner decision), I-11, I-12 |
| R-6 | `976b688` | rejected, one P2 defect (CD01-R-16); all five above closed | the older direct route `POST /projects/:id/ask` went round both home guards and started Work in the reserved home Project |
| R-7 | `4e2c93c` | **accepted with one integrator obligation (O5)** | `Store.createTask` makes no task in home, so no route has one to start Work on; the direct route refuses home for every mode, which she ruled within bounds. CD-02 and CD-05 may build against the seam as frozen. Her words: acceptance of a development seam, not a release or production certification |
| O5 | `26b33ff` | closed by the integrator, awaiting a later reviewer | CD01-R-17 (P3): the ordinary thread update could re-route the home conversation, after which every message was refused. Refused now for home before any field is touched; name, permission and Mode stay home's own |

Her sandbox cannot run Vitest, so every reproducer is a source trace. The rule that has held since
round 5: paste it in unchanged, run it, and only then change code. Six of seven failed as
traced. The other (R-10) failed for a different reason, which was the real defect: the budget
matcher had never fired, because `EngineService` rewraps the Runtime's refusal.

Lanes that closed inside these rounds:

| Lane | Worker | Worktree | Result |
|---|---|---|---|
| CD-02h.MODE, `auto` as a Mode | Sonnet | `core-agent-mode` | merged `265a33c`. Its focused runs missed `tests/modes.test.ts` (the 900-character rule), which the full suite caught; every brief since demands the full suite |
| CD-02h.HOME, the reserved home Project (O4) | Opus | `core-agent-home` | `08fbbdf`, `7a6d107`, 14 cases, merged into the contract branch. R-6 narrowed it to R-16 |
| CD-05b, launch and the conversation client | Fable | `core-agent-bot` | `client/conversation-send.ts`, `client/console/DiomedesHome.tsx`, the landing gate in `client/App.tsx`, H3 in `client/console/Home.tsx`, `tests/diomedes-home.spec.ts` through the real app with a scripted provider. Awaits CD-05.R-2 |

Guard-removal mutations now stand at 22 single removals and 3 pairs across rounds 5 to 8. Two
single removals survive, both disclosed to the reviewer, and both for the same reason: a second
guard refuses the same request one call later, and the pair is killed.

**The open conflict for the integrator.** The contract-revision marker and the accepted rollout
record disagree. Nothing in this program consumes the marker as accepted until that is reconciled.

CD-01 must settle six things before any consumer starts: how Automatic, Answer only and Plan only
sit on a mode-pinned session; the identity that binds a conversation turn to the work it admits;
where a workspace-level conversation lives; how an admitted `act` enters existing work without
deadlocking `store.locked`; what a non-Claude person gets; and recording the decision as a run
step so `shared/types.ts` stays untouched.

**Gate to Wave 1:** Astra accepts the exact CD-01 base and patch, and Andrew has reacted to the
design. No code lane starts before both. **Andrew's half cleared 2026-09-21** ("go with
recommendations"). What can start before Astra's half, because no open finding touches it: the
page and its stylesheet (CD-05a), which is props-only and never fetches or mints identity. What
cannot: anything on the server side of the contract, and the launch change in `client/App.tsx`,
which R-01 is still rewriting.

### Wave 1: the first complete experience

| ID | Lead | Reviewer | Scope | Depends on |
|---|---|---|---|---|
| CD-05a | Muse | Astra | The page as an app-level Console screen: `client/console/Diomedes.tsx` and its view-model over existing records, plus `tests/diomedes-page.test.ts`. New files only. The name follows the contract: the product's agent is Diomedes, and "Agent" already means a catalogue entry (`shared/agents.ts`) | CD-01 |
| CD-05b | Fable | Astra | Non-hot, claimed: `client/App.tsx` landing gate `:848-862`, `loadInitial` `:187-210`, the home filter on `byRecency` `:52`; `client/console/Home.tsx:142` loses the `?? byRecency[0]` fallback (condition H3). Hot, returned as patches: `client/api.ts` conversation client with a minted, persisted `commandId` (pattern: `client/work-start.ts`); `client/console/Shell.tsx` routing, Everything hover intent, Automations as the one default dead pin | CD-05a |
| CD-02 | Muse | Astra | `server/interaction-admission.ts` (deterministic admission over a parsed decision plus the trusted `restriction`; sibling of `work-admission.ts`), `server/engines/interaction-routes.ts` (shape of `mountClaudeSessionRoutes`), `tests/interaction-admission.test.ts`, `tests/interaction-cases.test.ts`. Parsing already lives in `shared/interaction.ts`; no second parser. One file per brief | CD-01 |
| CD-02p | Opus | Astra | The three digest-bearing or lease-bearing patches to existing non-hot files, each written out in the contract: `server/work-admission.ts` (`sourceCommandId`), `server/engines/claude-session-routes.ts:88-91` (lineage derivation), `server/harness/claude-session-run.ts` (`decide?` hook). Not Muse work: a wrong digest input breaks replay of every old receipt | CD-01 |
| CD-02h | Fable (hot files) | Astra | `server/app.ts`: mount beside `:2317`, resolve `restriction` in `prepare` `:2321`, supply `decide`, fresh `store.locked` around admission after `recordResult`. Blocked on a handoff for `server/engines/service.ts:1595-1659` (external claim `devin-acp-adapter-20260913.json`) | CD-02, CD-02p |

Tests that pin today's landing and must move with CD-05b, not be deleted:
`tests/ui.spec.ts` F01-F02 (the Projects heading after first run) and the Home ask-box block near
`:1026`; `tests/field.spec.ts` C01 and C02; `tests/first-task-handoff.spec.ts` (composer focus on
handover); `tests/surface.test.ts` and `tests/backend.test.ts` (`migrateSettings` at launch).

### Wave 2: deepen, only on accepted ground

| ID | Lead | Note |
|---|---|---|
| CD-03 | Muse for the adapter, Opus for any shared interface | Workspace index and source excerpts. May not claim multi-person isolation: there is no authorized projection before egress today |
| CD-06 | Muse under Opus's profile contract | Depends on H09, which is an unmerged candidate |

### Unclaimed, with the missing prerequisite named

| ID | Blocked on |
|---|---|
| CD-04 bounded workers, verified outcomes | H13, H14 and H17 have no code. Building it now would be the second runtime this program forbids |
| CD-07 capability creation | CD-04 and pack containment |
| CD-08 learning and ongoing responsibilities | Automations is planning only; there is no scheduler |
| CD-09 paid admission | B01 and B02 are partial-merged, not accepted |
| CD-10 one channel, then voice | CD-04, installation identity, egress controls |
| CD-11 website | A separate repository and not requested in this pass. Not dispatched |
| CD-12 integrated evaluation | Astra, when not the author. Runs on whatever scope is actually claimed |

---

## 4. Every brief carries these

- Exact base, exact owned paths, the accepted contract revision, what must be preserved,
  input and output examples, negative requirements, the exact tests.
- New files only for bounded workers. A needed hot-file change comes back as a proposed patch.
- No commit, push, stash, clean, checkout or rebase. No `npm install`. No `Co-Authored-By` or any
  AI attribution.
- Focused tests only. The full suite, Playwright, `vite build`, packaging and live calls need the
  single shared heavy slot, taken through the pinned tool.
- The common result contract: ID, base, patch identity, owned files, behaviours, real commands and
  results, evidence, unclaimed features, blockers, next eligible item.

Gates before anything merges, on the commit to be pushed, with ports 5174 and 47632 free:
`npx tsc --noEmit`, `npx vitest run`, `npx vite build`,
`npx playwright test tests/ui.spec.ts tests/native-ui.spec.ts tests/field.spec.ts`.
Commits, pushes and releases need Andrew's approval for the patch in front of him.

---

## 5. Registering the program in the unified package: pending

Follow the Field Readiness amendment of 2026-09-17, not a new layout:

1. Preserve the CD-1 ZIP byte for byte under `sources/core-agent-2026-09-20/` with `MANIFEST.json`
   and `ZIP_SHA256.txt`.
2. Add `coordination/external-book-core-agent-2026-09-20.json`: new item IDs CD-00 to CD-12, the
   overlap mapping onto H09, H12, H13, H14, H17 to H20, SDKR, B01, B02, proposed dependencies,
   owned paths, model assignments.
3. Add a dated section to `shared/AMENDMENTS.md`. Record the BOT-00 to BOT-07 mapping and mark
   the `docs/bots-*` branches superseded. Note that the Bots cases B01 to B36 share short IDs with
   package items B01 and B02 and are a different namespace.
4. Insert the rows into `RUN_ORDER.md` and `RUN_ORDER.json` at collision-checked numbers, status
   `open`. Do not reset any accepted item.
5. Regenerate `SHA256SUMS.txt` and run
   `python -m unittest discover -s validation -p test_validator.py -v` and
   `python validation/validate_package.py --write-report`.

Not started, and deliberately held until Astra accepts CD-01. An `open` node in `RUN_ORDER` is
schedulable by any other session, and two sessions are working in these repositories right now.
Andrew approved the order of work on 2026-09-21.

---

## 6. The merge train and the release (authorized 2026-09-21)

Andrew: merge this program's worktrees and the other finished worktrees by Claude sessions and by
Codex into main, open a pull request, fix what it finds, push, deploy the site and publish the new
build, once everything is done. That approval lowers no gate. Evidence below is from a read-only
inventory of both repositories taken 2026-09-21 (session scratchpad, `merge-train-inventory.md`).

**Most of it has already landed.** 9 of 20 app worktrees and 20 of 25 site worktrees are clean
ancestors of `origin/main`. Codex's inventory receipts work is the current tip, `dadb72d`. App
main CI is green; the latest release is v0.1.6.

| Lane | State | Decision |
|---|---|---|
| `feature/worktree-hygiene`, PR #28 | 2 commits, mergeable, both checks green. Authored by Opus; no independent review found | Merge after an Astra review. Queued behind CD-01.R-3 |
| `feature/core-agent-bot` and its lanes | this program | Merge when each lane is accepted |
| `change-review-ended-sessions` | branch fully merged; the fix and its tests exist only as 4 uncommitted files, returned by an earlier Claude session | Confirm the owning process is gone, review the diff, run its tests, commit, review, then merge |
| `test-teardown-capture` | branch fully merged; 32 uncommitted files. Its own note says hosted CI has not run | Same treatment. Hosted CI first |
| site `contact-booking`, site `first-run-repair/site-first-run-guide` | one commit each, no verdict | Needs a verdict before it moves |
| `jev-live-decision-plane` | its own ledger says "not accepted for release" | **Does not merge** |
| `durable-write-retry-20260917` | its one commit is byte-identical to `a2c40cf`, already on main | Nothing to merge. Retire |
| `devin-agent-worker-20260917` | 289 behind; 612 files diverge, including subsystems main has removed | **Does not merge.** A rewrite, not a merge |
| `cloud-development-handoff`, site `cloud-site-handoff` | appeared during the inventory; the app one has unresolved conflicts in `README.md` and `desktop/main.mjs` | **Another session is working there now. Untouched.** Whatever it lands reaches main on its own path |
| site `model-aware-harness-20260917`, site `private-ai-pricing-20260917` | "clean" only because a WIP sweep commit swallowed their edits | Unclear ownership. Not merged without Andrew |

Two things to show Andrew rather than act on: the locked `stock-receipt-review` worktree (Codex,
"do not remove") is empty on disk although its branch is intact and merged; and site PR #1 is a
draft from 2026-09-10 with no worktree and no checks.

**Order.** (1) CD-01 accepted. (2) Lanes built, reviewed and merged into `feature/core-agent-bot`.
(3) The four gates and the full browser suite on that branch, through the shared slot. (4) One
pull request to main; fix what hosted CI finds. (5) PR #28 and the two recovered lanes, each on
its own pull request so a failure names its cause. (6) Version, candidate build, the release gates
and honest notes: the release says what it ships and nothing more. (7) Publish, then the site's
release record and `wrangler deploy`. The release is last, and it does not claim the agent before
its lanes are accepted.
