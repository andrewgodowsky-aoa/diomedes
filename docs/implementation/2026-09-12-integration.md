# September 12 integration: a named candidate, two journeys, and the branches folded in

September 12, 2026. The integrator's record for the day that followed the September 11
slices: brief 01's REL-02 and its two demonstration journeys, the fixes those journeys
forced, a readability change that had been waiting in a Codex worktree, a code audit, and
the consolidation of thirty-odd worktrees and branches into one `main`. Each piece has its
own record; this one says how they were combined, what proved the combination, and what is
still open.

## 1. What landed, in the order it merged

| Commit | What | Worker | Record |
|---|---|---|---|
| `f7c025e` | Demonstration journey A traversed on the packaged candidate | Opus 5 | `2026-09-12-demo-journey-a.md` |
| `176759c` | The weekly brief can run more than once and compares against the brief it wrote | GLM 5.3 Flash | this record, §3 |
| `f072dfa` | Candidate `diomedes-0.1.1-windows-experimental-20260912-da84689e08d7` named and proven on its exact bytes | integrator, Muse Spark 1.3 (record script) | `2026-09-12-release-candidate.md` |
| `c5f09c6` | 71 evidence files and two documents that main's records cited but never held, imported from the snapshot branches | integrator | this record, §5 |
| `b51958c`, `7e70dcc` | Desktop typography and interface-scale roles (Andrew's Codex commit of 2026-09-12 00:21), rebased and applied to the September 11 surfaces | Opus 5 | `2026-09-11-desktop-readability.md` |
| `cb20cb6` | Demonstration journey B traversed on the packaged candidate | Opus 5 | `2026-09-12-demo-journey-b.md` |
| `5ba3618` | A fenced or prefixed file proposal is read; a refused turn keeps its model; OpenCode's two time budgets read differently | GLM 5.3 Flash | this record, §3 |
| `130d8d4` | The candidate record names the published prerelease as the last known good | integrator | `2026-09-12-release-candidate.md` §4 |
| `2fde3d5`…`a3d13ee` (12) | Code audit: measured findings, nine behaviour-preserving cleanups | Fable (one-time, owner-authorised) | `2026-09-12-code-audit.md` |

The candidate was built from `da84689`, which was `main` when the day began; everything
above landed after it, so the packaged bytes a person would install today do not contain
§3's fixes or the readability change. The next candidate will.

## 2. The two journeys, measured

Both ran as scripts driving the packaged `Diomedes.exe` through its own controls in an
isolated profile, with fixtures prepared over the local API only where no control exists,
and every such preparation listed in the evidence. Numbers are from the evidence runs.

**Journey A (ordinary user).** 15 of 18 steps traversed, one needed intervention, two are not
reachable in this build. Not reachable: attaching exports (FIL-02 is unimplemented; the Files
pane is read-only) and creating or moving a task from the Console (the Console only projects
and starts tasks). The intervention: the weekly brief reads one fixed export path chosen by the
pack variant, which no screen can change. The known failure was a signed-out engine whose card
named the recovery. Close and reopen kept the project, task, documents and History and left no
process behind. Two live turns on Claude Code in the evidence run, six across all real runs.
The build route returned no readable file proposal on any of its three runs.

**Journey B (technical user).** 12 of 22 steps traversed, two interventions, three not
reachable, five failed on one cause. Traversed: the path-guard refusal, opening a disposable
repository, activating the Software Engineering pack, reading the loaded `AGENTS.md`, the
engine-off refusal and its recovery, Stop with its receipt, a delivered follow-up, and the
reopen check. Failed: two paid OpenCode turns on two advertised models produced no proposal,
one refused by the parser and one timed out at 18.8 s, so nothing was proposed, approved,
written or reviewed on a real route. Not reachable: creating a task from the Console, choosing
the model on the thread for OpenCode (the picker lists nothing for a signed-in OpenCode
account), and assigning a change to an existing file. Four live turns on
`opencode:opencode-go`, two in the evidence run.

**What the journeys say together.** The shell holds: setup, projects, packs, instructions,
Board start, Stop, follow-ups, Files, History and restart all behave on the exact bytes. The
middle does not: on the packaged candidate, neither text route turned a paid turn into a
proposal a person could approve. §3 fixes the most likely cause in source; it is unproven
on a route until the next candidate is built and one turn is spent.

## 3. Fixes the journeys forced

- **Weekly brief** (`176759c`). `WeeklyBriefService.run` passed the previous draft's text as
  the recorded write's `expected`, where the store compares a sha256, so a second "Prepare the
  weekly brief" was refused with 409; and the route read the previous brief from a path
  nothing writes, so change detection never ran. The service now resolves the previous brief
  from the destination it writes and passes its hash. Two tests.
- **Proposal parsing** (`5ba3618`). `parseProposal` did `JSON.parse` on the whole reply. It
  now tolerates exactly two wrappings, a single fenced block or one brace-delimited object with
  at most a short prose prefix, and refuses everything else; every schema check after the
  parse is unchanged. The runtime-reported model is recorded before the proposal is judged, so
  a refused turn is attributed. OpenCode's startup budget now says how many seconds it waited.
  Tests for each. Whether this is the whole cause is unknown, because no raw reply was
  recorded; the next journey run will say.
- **Fault reply persistence** (this worktree). When the parser refuses a reply, the scrubbed
  reply is now kept: `rawReply` (capped at 4,000 characters with a `… [truncated, N chars]`
  note), `rawReplyLength` (uncut) and `parseError` land on the session and on the `fault`
  History entry in `fail()` before the failure persists, so the Console's History carries the
  evidence; the user-facing sentence is unchanged. The reply is redacted for `sk-…` keys,
  `Bearer …` tokens and `C:\Users\<name>` paths (plus the team-token scrubber where one is
  leased) before it is stored, and the same fields are kept when a reply parses but changes
  nothing. Three tests in `tests/native-work.test.ts`.

## 4. The readability change

Andrew's Codex session committed `fix(ui): unify desktop typography and interface scaling` at
00:21 on a branch thirteen commits behind `main`. Rebased with zero textual conflicts; the
September 11 surfaces (Files pane, follow-up queue, Stop menu, pack settings, instruction
line) were then given the same rem roles so the Console does not carry two scales. The rebase
found that `.pack-contributes` in `console.css` was missing its closing brace, which under CSS
nesting had made every follow-up and Stop rule from `de32ec6` dead on `main`; the block now
applies for the first time. Checked by eye on the dev server after merge: the follow-up queue
sits under the composer at the composer's scale, no console errors. The desktop readability
smoke was not re-run on a package; that evidence stands for the pre-rebase build only.

## 4b. The code audit

Andrew authorised one Fable pass over `server/`, `shared/`, `client/` and `desktop/` to find
sloppy code and slowdowns and to clean up what could be cleaned without changing behaviour.
The record is `2026-09-12-code-audit.md`: findings ranked with measurements, nine cleanups
applied as separate commits (a `now()` hoisted out of a per-entry History filter, one
service-window formatter per time zone, an unread engine stderr buffer dropped with the drain
listener kept, a shared text guard, one PowerShell quoting helper, duplicate validation and
dead lines removed, four landing-page sorts made one memo, the admission module's
`contentHash` made the store's own hash), and the recommendations it deliberately did not
apply because they change a payload, a contract or copy. The high findings it measured and
left for a decision: `projectState` at 13/39/110 ms with 0/10/50 waiting changes over five
thousand History entries; the SSE fan-out serialising about 3.8 MB per client per change at
that size, which no client reads; and the Files pane re-walking the project under the store
lock on every state event. Its gates passed on its own base; the combined tree's are in §8.

## 5. Gits combined

Thirty-seven worktrees and forty-nine branches existed at the start. Every branch was
measured against `main`:

- **Fully contained in main** (the Astra Codex-team worktree among them): worktrees removed,
  branches deleted locally; the two that also existed on origin
  (`integration/autonomy-workbench-20260910`, `codex/harness-runtime-20260908`) are deleted
  there with this push.
- **Snapshot branches** (`codex/*` "Snapshot the uncommitted work", eight of them): each is one
  commit that captured a Codex worktree before its work was re-landed on `main` by other
  commits. Their source is superseded; their evidence was not. The 71 files that `main`'s own
  records cite were imported (`c5f09c6`); the branches and their remotes are kept as the
  historical record of everything else they hold.
- **Real unmerged work**: only the readability commit; landed as §4.
- **Directories**: `git worktree remove` deregistered every finished worktree, but the
  auto-mode classifier refuses recursive deletion, so their folders (ignored build output and
  one real `node_modules`) remain under `F:\Diomedes\diomedes-wt\` for Andrew to delete; the
  exact command is in the session report. Three worktrees remain registered: the candidate's
  (holding the packaged bytes), the audit's, and none else.

## 6. Decisions for Andrew

1. **Version.** The candidate is 0.1.1 like the published prerelease; QUESTIONS.md O7.
2. **Browsing writes History.** Opening a file in the Files pane appends an `observed` entry
   (decision 10 question from September 11, still open).
3. **Pack toggle placement** inside the permission dialog (September 11, still open).
4. **Journey A's shape.** Attach (FIL-02) and Console task creation are missing; either the
   demo says a person prepares those outside the app, or they are built first.
5. **Approved-export selection.** The weekly brief is complete and unreachable at once: the
   export path is fixed by the pack variant.
6. **The thread picker never lists a signed-in OpenCode account** (`Picker.tsx` versus the
   `available: true` writers in `integrations.ts`); the permission panel prints "Unavailable".
7. **A faulted Board row offers no Start** while the fault text says "Start again"
   (`BoardView.tsx` gates on Ready).
8. **Ask mode carries no document**, so a revision is answered by a model shown nothing.
9. **The AI setup On switch and "Use as default" race**: clicking at ordinary speed can leave
   `defaultEngine` set to an engine that is off, and every later request is refused with a
   message that never mentions the switch.
10. **"Hand to You?"** names the task owner, not the route the work is about to leave on.
11. **Live turns spent today**: six on Claude Code (journey A), four on OpenCode Go
    (journey B); no Cursor turn.
12. Whether a further real run is authorised to prove §3 on a route.

## 7. What the briefs still hold open

Unchanged from `2026-09-11-integration.md` §3 except: REL-02 done for this candidate; the
two demonstration journeys traversed and measured (not passed); REL-07 has partial evidence
from the desktop smoke's shutdown, lock release and receipt persistence. Not started: 06
beyond its foundations, 07, 08.

## 8. Verification of the combined tree

Run serially on `a3d13ee` (the audit's last commit rebased onto everything above) in the main
checkout, with the shared Playwright lock held and nothing else competing:

| Gate | Result |
|---|---|
| `npx tsc --noEmit` | clean |
| `npx vitest run` | 1512 passed, 1 skipped, 0 failed; 89 files |
| `npx vite build` | clean |
| `npx playwright test` (full configured set, includes ui, native-ui and field) | 52 passed, 0 failed |
| `npx playwright test -c playwright.responsive.config.ts` (includes `readability.spec.ts`) | 20 passed, 0 failed |

The one unit skip is the 8.3-alias case this volume cannot produce; CI on `windows-latest`
covers it. Each worker's own gates on its own base are in its record; these are the numbers
for the tree that was pushed.

## 9. Cloud canonical documents

The Drive integration available to this session creates documents but cannot edit an existing
document's body, so the canonical roadmap document (still at 2026-09-10.4) was not changed.
A new document holding this mirror at 2026-09-12.1 was created beside it, and the same for the
project memory at 2026-09-10.7; their ids are in `docs/reference/CLOUD_SYNC_2026-09-12.md`.
Whether the canonical documents are replaced by these or updated from them is Andrew's
decision; until then the repository mirrors remain the newest text.

**PILLAR IMPACT.** Advances 01 (a build a person can install, named and proven on its bytes),
06 (Stop and follow-ups measured on the package), 09 (truthful attribution of a refused
turn; exact approval untouched by the parser change; History as evidence restored for cited
proofs), 11 (a candidate record that needs no founder at the keyboard), 12 (one Console at
one scale). Risk: 07 and 09 if the journeys' failures were presented as passes; they are
not. No pillar was amended.

**ROADMAP IMPACT.** REL-02 UNPROVEN → done for `…-da84689e08d7`; journeys A and B → measured,
with the failures named; REL-06 complete; REL-07 partial evidence; text-route proposal
delivery → fixed in source, unproven on a route.

**BUILD / PUBLICATION / DEPLOYMENT STATUS.** Source, one local package, one local installer,
evidence and CI. Version stays 0.1.1. Nothing published or signed; the published last known
good remains `v0.1.1-experimental.2`.
