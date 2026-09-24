# H17: independent verification, four-state results and evidence-bound completion

Lane `h17-verified-completion`, branch `feature/h17-verified-completion`, Linear DIO-22.
Base `de86916` (origin/main at the start of the lane).

**What this is:** a run's result is now one of four states — **Verified**, **Not verified**,
**Failed verification**, **Verification uncertain** — projected on every read from records that
already exist or are appended as evidence. A separate verifier runs a task's declared acceptance
checks against a finished run's exact output bytes, records what it found on a History entry, and
the Console shows the result with its evidence in the thread and on the Board.

**What this is not:** it does not run project code (tests, builds, linters), it does not verify a
run automatically when the run finishes, and it does not make any run's output more trustworthy by
itself. It says, truthfully, what was checked against which bytes, by whom, and what is still
unknown. Nothing here writes a project file, decides a Need, or issues or widens a grant.

## 1. Where the state comes from

No state is stored. `shared/verification.ts` `verificationOf({ session, task, history })` reads:

| Input | Authoritative record | Written by |
| --- | --- | --- |
| Declared checks | `Task.acceptance` (`AcceptanceDeclaration`: checks, sha256 `digest`, `declaredAt`, `declaredBy: 'you'`) plus a History entry `kind: 'acceptance-declared'` per change | `PUT /api/projects/:id/tasks/:taskId/acceptance` |
| Verification evidence | `HistoryEntry.verification` (`VerificationRecord`) on an entry `kind: 'verified'`, `files: []` | `POST /api/projects/:id/sessions/:sessionId/verification` |
| The run's outputs | Every History entry whose `sessionId` is the run's, last `after` digest per path (`runOutputs`) | The existing recorded writer |
| Current bytes | The newest History digest per path (`latestDigest`) | The existing recorded writer, and `Store.readDocument`'s outside-change recorder |

Both new fields are optional appends in `shared/types.ts`; every record written before this lane
reads as *Not verified*. A restart re-reads `state.json` and re-projects the same answer
(tested).

**Evidence-bound completion.** A record binds every file any check judged, with the exact sha256
History held when it was judged (`bound`), and the run's own outputs with the digests the run
recorded (`outputs`). The projection compares both against History on every read, so a later
recorded write, an undo, a restore, a deletion or an outside edit turns the result uncertain the
moment History knows the new bytes. To make outside edits reach History without anyone opening the
file, `GET /api/projects/:id/state` first calls `VerificationService.sync`, which re-reads the
files the newest verification of each run bound through `Store.readDocument` — the existing
outside-change recorder. It records nothing when nothing moved (tested).

## 2. The rule table

Ordered; the first row that matches decides. Each row has a case in
`tests/verification-projection.test.ts`.

| # | Rule id | Condition | State | Sentence (template) |
|---|---|---|---|---|
| 1 | `run-not-finished` | Session is `queued`, `working` or `waiting` | Not verified | The run has not finished, so there is nothing to verify yet. |
| 2 | `no-checks-declared` | No verification of this run on record, and no checks declared (or the record ran none) | Not verified | No acceptance checks are declared for this task, so nothing was verified. |
| 3 | `checks-not-run` | Checks declared, no verification of this run on record | Not verified | N acceptance checks declared; not run on this run yet. |
| 4 | `outputs-changed` | Any bound file's newest History digest differs from the digest judged, or a run output is missing from / differs from the record | Verification uncertain | `<paths>` changed after verification, so the result no longer describes these bytes. (+ "It had failed on the earlier bytes." when a check had failed) |
| 5 | `checks-changed` | The task's declaration digest differs from the one the record ran against | Verification uncertain | The declared checks changed after this verification ran. |
| 6 | `check-failed` | Any check `failed` | Failed verification | N checks failed: `<first failing check's evidence sentence>` |
| 7 | `check-incomplete` | Any check `incomplete` (not run, timed out, unreadable, reviewer unsure or unreadable, outputs moved before verification) | Verification uncertain | N checks could not complete: `<first reason>` |
| 8 | `review-not-independent` | A passed review whose reviewer reported the same engine and model as the worker, or where either side's model was not runtime-reported | Verification uncertain | The reviewer reported the same engine and model as the worker, so its pass is not independent. / …cannot be shown to be independent. |
| 9 | `all-passed` | Otherwise: every declared check and `outputs-intact` passed, bound to exact digests | Verified | N declared checks passed against M exact file versions. |

Only the newest verification of a run decides; a verification of another run never does.

Row 4 is deliberately ahead of row 6: a failure judged earlier bytes, and the current bytes are
unjudged, so the honest answer is *uncertain* — and the sentence still says it had failed.

## 3. The verifier

`server/verification/service.ts` `VerificationService`:

1. **Under the store lock**: refuse an unfinished run (409 `run_not_finished`) or a task with no
   declared checks (409 `no_checks_declared`). Read each needed file once through
   `Store.readDocument` (the Files pane's guarded read path, `projectFile` → `safeAbsolute`), which
   also records an outside change first, so every digest a check judges is one History holds.
   Run `outputs-intact` and the deterministic checks.
2. **Outside the lock**: the reviewer pass, bounded by `REVIEWER_TIMEOUT_MS` (tests shorten it).
3. **Under the lock again**: append the History entry carrying the record, and persist. If a file
   moved during step 2, the record still says what was judged and the projection reads it as
   uncertain.

One verification per run at a time (in-flight map).

| Check | What it does | Never |
| --- | --- | --- |
| `outputs-intact` (always) | Each run output's current digest equals the digest the run recorded; otherwise *incomplete* — the checks would not be judging the run's output | — |
| `file-exists` | The path exists | — |
| `file-digest` | The path's sha256 equals a declared digest | — |
| `text-contains` | The path contains declared text | — |
| `json-valid` | The path parses as JSON, with optional required top-level keys | — |
| `command` | Declared, recorded as *incomplete*: "running project commands is a Trust decision this build does not make" | Run anything. `server/change-review/checks.ts` already records the same boundary; there is no mediated command-execution path to route through. |
| `review` | Sends a verification packet (task, instruction, output paths, digests and bounded excerpts, deterministic outcomes) to the separate reviewer route, as a document, with review-only instructions. Typed JSON verdict `pass` / `fail` / `unsure`, or nothing | Run without a configured reviewer route, without the Codex connection on, or without the project's review-sharing consent (`requireCloudReview`); count prose as a verdict |

**Independence and attribution (decision 8).** Deterministic checks carry an application origin
(`mode: 'application'`, `executorId: 'diomedes:verifier'`) — Diomedes code compared bytes; no model
graded anything. A review check carries `directOrigin({ engine: 'codex', reportedModel, version,
executorId: 'diomedes:verification-reviewer' })` from the runtime's own report. The record copies the
worker's origin (`producer`) from the run. The projection's `independenceOf` compares only
runtime-reported identities: same engine and model → `same-model`, either side unreported →
`unknown`, and neither counts toward Verified. The route is the same separate invocation
`Approve for me` uses (`server/trust/codex-reviewer.ts` states what "separate" does and does not
mean); no weight- or vendor-level independence is claimed. The History entry for a verification is
`actor: 'you'` (the person asked), origin application.

**Trust scope.** Declaring checks is not an authorization event. File checks read only what the
Files pane can already read. The review reuses the existing reviewer gates exactly. Nothing is
widened; the reviewer's verdict can move a result between Verified, Failed verification and
Verification uncertain and has no other effect.

## 4. Console

`client/console/Verification.tsx`, styled in `verification.css` in the Settings > Engines language
(caption type, one hairline, a state dot; accent only for Verified, attention for uncertain, fail
colour for a failure; *Not verified* is plain text with a hollow dot, in the same place).

- **Thread**: every finished run's record shows the state word when folded; open, the state and its
  sentence, any changed files (`path: verified <sha12>, now <sha12>`), *Run checks* / *Verify
  again* when checks are declared, and *Evidence*: per check the outcome, label, evidence sentence,
  who checked (attribution label), independence, when, and `path @ sha12` for the exact bytes. The
  same disclosure holds a small declaration form (file exists, file contains text, reviewer pass).
- **Board**: each task row whose latest run has finished shows the state word, with the sentence in
  its title.

Paths and digests truncate with the full value in the title (decision 5).

## 5. Tests

| File | Count | Proves |
| --- | --- | --- |
| `tests/verification-projection.test.ts` | 22 | Every rule-table row; newest record decides; changed-file digests; `runOutputs`; independence table; deterministic attribution |
| `tests/verification-service.test.ts` | 15 | Not verified by default and verify refuses; unfinished run refused; bad declarations refused with nothing saved; verified against the exact digest, attributed to the application, output untouched; recorded write flips to uncertain and re-verify cannot restore it; outside edit flips on sync and an idle sync records nothing; moved-before-verification is uncertain; failing checks with evidence; command never runs; reviewer timeout is uncertain and aborts the call; independent reviewer verifies, same/unreported model does not; reviewer fail and prose; no route / no consent sends nothing; restart persistence; the routes end to end on a sample run through the state route |
| `tests/verification-ui.spec.ts` | 3 | A sample run in the Console: Not verified → declare → Verified with evidence (thread and Board); Failed verification; outside edit → Verification uncertain with the changed digest |

The implementation was written ahead of these tests in this lane, not test-first; red was shown
only incidentally (the timeout race below). Two findings came out of the tests and were fixed: an
adapter that rejects on abort outran the timeout marker, reporting "could not complete: aborted"
instead of the timeout; and re-verifying after a person edits a run's output correctly stays
uncertain (`outputs-intact`), which the first draft of the test had expected to be Verified.

## 6. Known gaps

- **No automatic verification on run completion.** A person presses *Run checks*. Hooking the run
  lifecycle (`server/native-work.ts`) was left out to keep this lane off that hot path.
- **Command checks never run.** There is no mediated, Trust-authorized command-execution path; a
  declared command is always *incomplete*, so a task that declares one can never read Verified.
- **The review route is Codex only**, like `Approve for me`, and needs the same connection and
  sharing consent.
- **Board/thread only.** Automations' "last verified result" (roadmap §3) and the Team view do not
  show it yet.
- **Declaration UI is minimal**: add and clear only; `file-digest`, `json-valid` and `command`
  checks are declared through the API.
- A run with no recorded file output can still be Verified by checks on files it did not write;
  the evidence says so ("The run recorded no file output").

## 7. Proposed canonical-doc patch

Not applied: this lane does not edit the canonical documents. Proposed for the owner.

**`docs/DIOMEDES_PROJECT_MEMORY.md`** — add to the definitions near "Human statuses derive from
authoritative task/run/Need/review/evidence records":

> **Verification result (H17).** A finished run's result is one of four projected states:
> *Verified* (every declared acceptance check passed, with evidence bound to the exact output
> digests), *Not verified* (no checks declared, or none run — the default), *Failed verification*
> (a check ran and failed, with its evidence), *Verification uncertain* (a check could not
> complete, the reviewer's independence is not shown, the declared checks changed, or any bound
> bytes changed after verification). It is never stored: it is projected from the task's
> declaration, the verification's History evidence and History's digests. Finished does not mean
> verified.

**`docs/DIOMEDES_LIVE_ROADMAP.md`** — H17 status: *first slice implemented* (four-state projection,
evidence-bound completion, deterministic file checks, optional reviewer pass, thread and Board
display; `docs/implementation/2026-09-24-h17-verified-completion.md`). Remaining: automatic
verification at run completion, an authorized command-execution path for declared project
commands, Automations' last-verified-result display, a fuller declaration surface.

**`QUESTIONS.md`** — proposed open question: *Should a declared project command (tests, build) be
runnable as a verification check, and under which Trust grant?* Conservative position taken here:
no; it is recorded and reported as not run.
